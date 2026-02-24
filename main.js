const { app, BrowserWindow, BrowserView, ipcMain, session, desktopCapturer, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let currentView = null;
let serverViews = new Map();

// Holds the source chosen in the picker, keyed by session.
const sessionPendingScreenshare = new Map();

// Create icons directory if it doesn't exist
const iconsDir = path.join(app.getPath('userData'), 'server-icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

const DEFAULT_PERMISSIONS = { notifications: false, screenCapture: false, audio: false, video: false };
function getPermissions() { return store.get('permissions', DEFAULT_PERMISSIONS); }

// ── Sidecar management ────────────────────────────────────────────────────────

let sidecarProcess      = null;
let sidecarReady        = false;
let sidecarLineBuffer   = '';
let sidecarRequests     = new Map();   // id -> { resolve, reject }
let sidecarReqCounter   = 0;
let sidecarBinaryPort   = null;
let sidecarBinarySocket = null;
let sidecarBinaryBuf    = Buffer.alloc(0);

// sessionId -> webContents that started the capture
const captureSessionOwners = new Map();

function getSidecarPath() {
  const bin = process.platform === 'win32' ? 'sweetshark-capture.exe' : 'sweetshark-capture';
  if (app.isPackaged) return path.join(process.resourcesPath, 'sidecar', bin);
  return path.join(__dirname, 'sidecar', 'target', 'release', bin);
}

function sidecarWrite(obj) {
  if (!sidecarProcess?.stdin?.writable) return;
  try { sidecarProcess.stdin.write(JSON.stringify(obj) + '\n'); } catch {}
}

function sidecarRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `r${++sidecarReqCounter}`;
    sidecarRequests.set(id, { resolve, reject });
    sidecarWrite({ id, method, params });
    setTimeout(() => {
      if (sidecarRequests.has(id)) {
        sidecarRequests.delete(id);
        reject(new Error(`Sidecar '${method}' timed out`));
      }
    }, 8000);
  });
}

function onSidecarLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id) {
    const p = sidecarRequests.get(msg.id);
    if (!p) return;
    sidecarRequests.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message || 'sidecar error'));
    return;
  }

  if (msg.event === 'audio_capture.frame') {
    // JSON base64 fallback path (binary path handled by TCP socket below)
    const wc = captureSessionOwners.get(msg.params.sessionId);
    if (wc && !wc.isDestroyed()) wc.send('app-audio-frame', msg.params);
    return;
  }

  if (msg.event === 'audio_capture.ended') {
    const wc = captureSessionOwners.get(msg.params.sessionId);
    if (wc && !wc.isDestroyed()) wc.send('app-audio-ended', msg.params);
    captureSessionOwners.delete(msg.params.sessionId);
  }
}

// ── Binary egress: length-prefixed f32le frames over TCP ─────────────────────
// Frame layout (matches sidecar try_write_app_audio_binary_frame):
//   [4]  payload_len     u32 LE   (total bytes after this field)
//   [2]  session_id_len  u16 LE
//   [N]  session_id      UTF-8
//   [2]  target_id_len   u16 LE
//   [M]  target_id       UTF-8
//   [8]  sequence        u64 LE
//   [4]  sample_rate     u32 LE
//   [2]  channels        u16 LE
//   [4]  frame_count     u32 LE
//   [4]  protocol_ver    u32 LE
//   [4]  dropped_frames  u32 LE
//   [4]  pcm_byte_len    u32 LE
//   [P]  pcm data        f32le

function parseBinaryFrames() {
  while (sidecarBinaryBuf.length >= 4) {
    const payloadLen = sidecarBinaryBuf.readUInt32LE(0);
    if (sidecarBinaryBuf.length < 4 + payloadLen) break;

    const payload = sidecarBinaryBuf.slice(4, 4 + payloadLen);
    sidecarBinaryBuf = sidecarBinaryBuf.slice(4 + payloadLen);

    try {
      let o = 0;
      const sidLen = payload.readUInt16LE(o); o += 2;
      const sessionId = payload.slice(o, o + sidLen).toString('utf8'); o += sidLen;
      const tidLen = payload.readUInt16LE(o); o += 2;
      const targetId = payload.slice(o, o + tidLen).toString('utf8'); o += tidLen;
      const sequence = Number(payload.readBigUInt64LE(o)); o += 8;
      const sampleRate = payload.readUInt32LE(o); o += 4;
      const channels = payload.readUInt16LE(o); o += 2;
      const frameCount = payload.readUInt32LE(o); o += 4;
      const protocolVersion = payload.readUInt32LE(o); o += 4;
      const droppedFrameCount = payload.readUInt32LE(o); o += 4;
      const pcmByteLen = payload.readUInt32LE(o); o += 4;
      const pcmBuffer = payload.slice(o, o + pcmByteLen);

      const wc = captureSessionOwners.get(sessionId);
      if (wc && !wc.isDestroyed()) {
        wc.send('app-audio-frame-binary', {
          sessionId, targetId, sequence, sampleRate,
          channels, frameCount, protocolVersion, droppedFrameCount,
          pcmBuffer
        });
      }
    } catch (e) {
      console.error('[sidecar] binary frame parse error:', e.message);
    }
  }
}

function connectBinaryEgress(port) {
  if (sidecarBinarySocket) { try { sidecarBinarySocket.destroy(); } catch {} }

  const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
    sidecarBinarySocket = sock;
    sidecarBinaryBuf = Buffer.alloc(0);
    console.log('[sidecar] binary egress connected on port', port);
  });

  sock.on('data', chunk => {
    sidecarBinaryBuf = Buffer.concat([sidecarBinaryBuf, chunk]);
    parseBinaryFrames();
  });

  sock.on('close', () => {
    if (sidecarBinarySocket === sock) sidecarBinarySocket = null;
    if (sidecarBinaryPort && sidecarProcess) {
      setTimeout(() => connectBinaryEgress(sidecarBinaryPort), 1000);
    }
  });

  sock.on('error', e => console.error('[sidecar] binary socket error:', e.message));
}

// ── Sidecar lifecycle ─────────────────────────────────────────────────────────

async function startSidecar() {
  const sidecarPath = getSidecarPath();
  if (!fs.existsSync(sidecarPath)) {
    console.warn('[sidecar] binary not found at', sidecarPath, '— per-window audio disabled');
    return;
  }

  console.log('[sidecar] spawning:', sidecarPath);
  sidecarProcess = spawn(sidecarPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });

  sidecarProcess.stdout.on('data', data => {
    sidecarLineBuffer += data.toString('utf8');
    const lines = sidecarLineBuffer.split('\n');
    sidecarLineBuffer = lines.pop();
    lines.forEach(l => l.trim() && onSidecarLine(l));
  });

  sidecarProcess.stderr.on('data', data => process.stderr.write('[sidecar] ' + data));

  sidecarProcess.on('exit', code => {
    console.log('[sidecar] exited with code', code);
    sidecarReady = false;
    sidecarProcess = null;
    sidecarBinaryPort = null;
    for (const { reject } of sidecarRequests.values()) reject(new Error('Sidecar exited'));
    sidecarRequests.clear();
  });

  try {
    await sidecarRequest('health.ping');
    sidecarReady = true;
    console.log('[sidecar] ready');

    // Connect binary egress for zero-copy PCM streaming
    try {
      const info = await sidecarRequest('audio_capture.binary_egress_info');
      sidecarBinaryPort = info.port;
      connectBinaryEgress(info.port);
    } catch (e) {
      console.warn('[sidecar] binary egress unavailable, JSON fallback active:', e.message);
    }
  } catch (e) {
    console.error('[sidecar] health ping failed:', e.message);
  }
}

function stopSidecar() {
  if (sidecarBinarySocket) { try { sidecarBinarySocket.destroy(); } catch {} sidecarBinarySocket = null; }
  if (sidecarProcess)       { try { sidecarProcess.stdin.end(); }     catch {} sidecarProcess = null; }
  sidecarReady = false;
}

// ── IPC: sidecar bridge exposed to BrowserViews ───────────────────────────────

ipcMain.handle('get-app-pid', () => process.pid);

ipcMain.handle('sidecar-capabilities', async () => {
  if (!sidecarReady) return { perAppAudio: 'unsupported', available: false };
  try {
    const r = await sidecarRequest('capabilities.get');
    return { ...r, available: true };
  } catch { return { perAppAudio: 'unsupported', available: false }; }
});

ipcMain.handle('sidecar-resolve-source', async (event, sourceId) => {
  if (!sidecarReady) return { pid: null };
  try { return await sidecarRequest('windows.resolve_source', { sourceId }); }
  catch { return { pid: null }; }
});

ipcMain.handle('sidecar-audio-start', async (event, { sourceId, appAudioTargetId, excludePid }) => {
  if (!sidecarReady) throw new Error('Sidecar not available');
  const result = await sidecarRequest('audio_capture.start', { sourceId, appAudioTargetId, excludePid });
  captureSessionOwners.set(result.sessionId, event.sender);
  return result;
});

ipcMain.handle('sidecar-audio-stop', async (event, sessionId) => {
  captureSessionOwners.delete(sessionId);
  if (!sidecarReady) return;
  try { await sidecarRequest('audio_capture.stop', { sessionId }); } catch {}
});

// ── Window & permission setup ─────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    frame: true,
    backgroundColor: '#1e1e1e'
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile('renderer/index.html');

  const servers = store.get('servers', []);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('servers-loaded', servers);
    if (!store.get('permissionsConfigured', false)) {
      mainWindow.webContents.send('show-permissions-setup');
    }
  });
}

function buildPermissionHandlers(ses) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const perms = getPermissions();
    if (permission === 'geolocation') return callback(false);
    if (permission === 'notifications') return callback(perms.notifications);
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      if (types.length === 0) return callback(perms.screenCapture || perms.audio || perms.video);
      return callback(types.every(t =>
        t === 'audio' ? perms.audio : (t === 'video' ? perms.video || perms.screenCapture : false)
      ));
    }
    callback(false);
  });

  ses.setPermissionCheckHandler((webContents, permission) => {
    const perms = getPermissions();
    if (permission === 'geolocation') return false;
    if (permission === 'notifications') return perms.notifications;
    if (permission === 'media') return perms.audio || perms.video || perms.screenCapture;
    return false;
  });

  if (typeof ses.setDisplayCapturePermissionHandler === 'function') {
    ses.setDisplayCapturePermissionHandler(() => getPermissions().screenCapture);
  }

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const pending = sessionPendingScreenshare.get(ses);
    if (!pending) { callback(undefined); return; }
    sessionPendingScreenshare.delete(ses);
    const { sourceId, shareAudio, isScreen } = pending;

    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(s => s.id === sourceId);
      if (!source) { callback(undefined); return; }

      if (shareAudio && isScreen) {
        // Screen shares: sidecar handles audio in exclude mode (view-preload.js).
        // We return video-only here; the preload splices in the sidecar audio track.
        callback({ video: source });
      } else {
        // Window shares: audio handled by the sidecar in view-preload.js
        callback({ video: source });
      }
    } catch (err) {
      console.error('setDisplayMediaRequestHandler error:', err);
      callback(undefined);
    }
  });
}

function createServerView(server) {
  const viewId = server.id;
  if (serverViews.has(viewId)) return serverViews.get(viewId);

  const partition = `persist:server-${viewId}`;
  const ses = session.fromPartition(partition);
  buildPermissionHandlers(ses);

  const view = new BrowserView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      webgl: true,
      webviewTag: false,
      preload: path.join(__dirname, 'view-preload.js')
    }
  });

  const urlToLoad = server.initialUrl || server.url;
  view.webContents.loadURL(urlToLoad);

  if (server.initialUrl) {
    view.webContents.once('did-finish-load', () => {
      const servers = store.get('servers', []);
      const idx = servers.findIndex(s => s.id === server.id);
      if (idx !== -1 && servers[idx].initialUrl) {
        delete servers[idx].initialUrl;
        store.set('servers', servers);
      }
    });
  }

  view.webContents.on('context-menu', (event, params) => {
    const menuTemplate = [];
    if (params.editFlags.canUndo || params.editFlags.canRedo) {
      if (params.editFlags.canUndo) menuTemplate.push({ label: 'Undo', role: 'undo' });
      if (params.editFlags.canRedo) menuTemplate.push({ label: 'Redo', role: 'redo' });
      menuTemplate.push({ type: 'separator' });
    }
    if (params.isEditable) {
      menuTemplate.push(
        { label: 'Cut',   role: 'cut',   enabled: params.editFlags.canCut },
        { label: 'Copy',  role: 'copy',  enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }
      );
      if (params.editFlags.canDelete) menuTemplate.push({ label: 'Delete', role: 'delete' });
      menuTemplate.push({ type: 'separator' }, { label: 'Select All', role: 'selectAll' });
    } else if (params.selectionText) {
      menuTemplate.push({ label: 'Copy', role: 'copy' }, { type: 'separator' }, { label: 'Select All', role: 'selectAll' });
    }
    if (params.linkURL) {
      if (menuTemplate.length > 0) menuTemplate.push({ type: 'separator' });
      menuTemplate.push({ label: 'Copy Link Address', click: () => require('electron').clipboard.writeText(params.linkURL) });
    }
    if (params.mediaType === 'image') {
      if (menuTemplate.length > 0) menuTemplate.push({ type: 'separator' });
      menuTemplate.push(
        { label: 'Copy Image',     click: () => view.webContents.copyImageAt(params.x, params.y) },
        { label: 'Save Image As…', click: () => view.webContents.downloadURL(params.srcURL) }
      );
    }
    if (params.mediaType === 'video' || params.mediaType === 'audio') {
      if (menuTemplate.length > 0) menuTemplate.push({ type: 'separator' });
      menuTemplate.push({ label: 'Save As…', click: () => view.webContents.downloadURL(params.srcURL) });
    }
    if (menuTemplate.length > 0) Menu.buildFromTemplate(menuTemplate).popup({ window: mainWindow });
  });

  serverViews.set(viewId, view);
  return view;
}

function switchToServer(serverId) {
  const servers = store.get('servers', []);
  const server = servers.find(s => s.id === serverId);
  if (!server) return;

  mainWindow.webContents.send('show-loading');

  if (currentView) {
    const currentServerId = Array.from(serverViews.entries()).find(([, v]) => v === currentView)?.[0];
    if (currentServerId) {
      const currentServer = servers.find(s => s.id === currentServerId);
      if (currentServer?.keepLoaded === false) {
        try { currentView.webContents.destroy(); } catch {}
        serverViews.delete(currentServerId);
      }
    }
    mainWindow.removeBrowserView(currentView);
  }

  const view = serverViews.has(serverId) ? serverViews.get(serverId) : createServerView(server);
  const sidebarWidth = 72;
  const b = mainWindow.getContentBounds();
  view.setBounds({ x: sidebarWidth, y: 0, width: b.width - sidebarWidth, height: b.height });
  mainWindow.addBrowserView(view);
  currentView = view;
  view.webContents.focus();

  view.webContents.once('did-finish-load', () => mainWindow.webContents.send('hide-loading'));
  view.webContents.once('did-fail-load',   () => mainWindow.webContents.send('hide-loading'));

  mainWindow.removeAllListeners('resize');
  mainWindow.on('resize', () => {
    if (currentView === view) {
      const b2 = mainWindow.getContentBounds();
      view.setBounds({ x: sidebarWidth, y: 0, width: b2.width - sidebarWidth, height: b2.height });
    }
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.on('add-server', (event, serverData) => {
  const servers = store.get('servers', []);
  const newServer = {
    id: Date.now().toString(),
    name: serverData.name,
    url: serverData.url,
    icon: serverData.icon || null,
    keepLoaded: true,
    initialUrl: serverData.initialUrl || serverData.url
  };
  if (serverData.iconData) {
    const iconPath = path.join(iconsDir, `${newServer.id}.png`);
    fs.writeFileSync(iconPath, Buffer.from(serverData.iconData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    newServer.icon = iconPath;
  }
  servers.push(newServer);
  store.set('servers', servers);
  event.reply('server-added', newServer);
  event.reply('servers-loaded', servers);
});

ipcMain.on('update-server', (event, serverId, updates) => {
  const servers = store.get('servers', []);
  const idx = servers.findIndex(s => s.id === serverId);
  if (idx !== -1) {
    if (updates.removeIcon) {
      if (servers[idx].icon && fs.existsSync(servers[idx].icon)) fs.unlinkSync(servers[idx].icon);
      servers[idx].icon = null;
      delete updates.removeIcon;
    }
    if (updates.iconData) {
      if (servers[idx].icon && fs.existsSync(servers[idx].icon)) fs.unlinkSync(servers[idx].icon);
      const iconPath = path.join(iconsDir, `${serverId}.png`);
      fs.writeFileSync(iconPath, Buffer.from(updates.iconData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      updates.icon = iconPath;
      delete updates.iconData;
    }
    servers[idx] = { ...servers[idx], ...updates };
    store.set('servers', servers);
    event.reply('servers-loaded', servers);
  }
});

ipcMain.on('reorder-servers', (event, newOrder) => { store.set('servers', newOrder); event.reply('servers-loaded', newOrder); });

ipcMain.on('remove-server', (event, serverId) => {
  const servers = store.get('servers', []);
  const server = servers.find(s => s.id === serverId);
  if (server?.icon && fs.existsSync(server.icon)) { try { fs.unlinkSync(server.icon); } catch {} }
  const dataDir = path.join(app.getPath('userData'), 'server-data', serverId);
  if (fs.existsSync(dataDir)) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} }
  const filtered = servers.filter(s => s.id !== serverId);
  store.set('servers', filtered);
  if (serverViews.has(serverId)) {
    const view = serverViews.get(serverId);
    if (currentView === view) { mainWindow.removeBrowserView(view); currentView = null; }
    try { view.webContents.destroy(); } catch {}
    serverViews.delete(serverId);
  }
  event.reply('server-removed', serverId);
  event.reply('servers-loaded', filtered);
});

ipcMain.on('refresh-server',  (event, id) => { if (serverViews.has(id)) serverViews.get(id).webContents.reload(); });
ipcMain.on('switch-server',   (event, id) => switchToServer(id));
ipcMain.on('get-servers',     event => event.reply('servers-loaded', store.get('servers', [])));

ipcMain.on('show-server-context-menu', (event, { serverId }) => {
  const servers = store.get('servers', []);
  const server = servers.find(s => s.id === serverId);
  Menu.buildFromTemplate([
    { label: 'Rename Server', click: () => mainWindow.webContents.send('ctx-rename-server', serverId) },
    { label: 'Change Icon',   click: () => mainWindow.webContents.send('ctx-change-icon-server', serverId) },
    { label: 'Refresh',       click: () => mainWindow.webContents.send('ctx-refresh-server', serverId) },
    { type: 'separator' },
    { label: 'Keep Server Loaded', type: 'checkbox', checked: server?.keepLoaded !== false, click: () => mainWindow.webContents.send('ctx-toggle-keep-loaded', serverId) },
    { type: 'separator' },
    { label: 'Remove Server', click: () => mainWindow.webContents.send('ctx-remove-server', serverId) }
  ]).popup({ window: mainWindow });
});

ipcMain.on('toggle-keep-loaded', (event, serverId) => {
  const servers = store.get('servers', []);
  const idx = servers.findIndex(s => s.id === serverId);
  if (idx !== -1) {
    servers[idx].keepLoaded = !(servers[idx].keepLoaded !== false);
    store.set('servers', servers);
    event.reply('servers-loaded', servers);
  }
});

ipcMain.on('hide-view', () => { if (currentView && mainWindow) { try { mainWindow.removeBrowserView(currentView); } catch {} } });
ipcMain.on('show-view', () => {
  if (currentView && mainWindow) {
    try {
      mainWindow.addBrowserView(currentView);
      const b = mainWindow.getContentBounds();
      currentView.setBounds({ x: 72, y: 0, width: b.width - 72, height: b.height });
      currentView.webContents.focus();
    } catch {}
  }
});

ipcMain.handle('load-icon', async (event, iconPath) => {
  if (iconPath && fs.existsSync(iconPath)) return `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;
  return null;
});

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 300, height: 200 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event, opts) => {
  const sources = await desktopCapturer.getSources({ ...opts, thumbnailSize: { width: 300, height: 200 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.handle('SCREENSHARE_SET_PENDING', (event, config) => {
  sessionPendingScreenshare.set(event.sender.session, config);
  return true;
});

ipcMain.handle('get-permissions', () => ({ configured: store.get('permissionsConfigured', false), permissions: getPermissions() }));
ipcMain.on('set-permissions', (event, permissions) => { store.set('permissions', { ...DEFAULT_PERMISSIONS, ...permissions }); store.set('permissionsConfigured', true); });

const GITHUB_RELEASES_API = 'https://api.github.com/repos/Sweets-omg/Sweetshark-client/releases/latest';
function compareSemver(a, b) {
  const parse = v => v.replace(/^v\.?/, '').split('.').map(Number);
  const [aM, am, ap] = parse(a); const [bM, bm, bp] = parse(b);
  if (bM !== aM) return bM > aM; if (bm !== am) return bm > am; return bp > ap;
}
function checkForUpdates() {
  if (!store.get('checkUpdates', true)) return;
  const https = require('https');
  const req = https.get(GITHUB_RELEASES_API, { headers: { 'User-Agent': 'Sweetshark-Client-Updater' } }, res => {
    let data = ''; res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const { tag_name: tag, html_url: url } = JSON.parse(data);
        if (tag && url && compareSemver(app.getVersion(), tag) && mainWindow?.webContents) {
          const send = () => mainWindow.webContents.send('update-available', { version: tag, url });
          mainWindow.webContents.once('did-finish-load', send);
          if (!mainWindow.webContents.isLoading()) send();
        }
      } catch {}
    });
  });
  req.on('error', () => {}); req.end();
}

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.on('open-release-url', (_, url) => require('electron').shell.openExternal(url));
ipcMain.on('disable-update-check', () => store.set('checkUpdates', false));

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();
  checkForUpdates();
  startSidecar().catch(e => console.error('[sidecar] startup error:', e));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { stopSidecar(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopSidecar);

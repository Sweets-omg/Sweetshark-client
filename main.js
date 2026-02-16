const { app, BrowserWindow, BrowserView, ipcMain, session, desktopCapturer, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let currentView = null;
let serverViews = new Map();

// Holds the source chosen in the picker, keyed by session.
// Populated by SCREENSHARE_SET_PENDING IPC from view-preload.js and consumed
// by setDisplayMediaRequestHandler to supply the correct source + audio mode.
const sessionPendingScreenshare = new Map(); // session -> { sourceId, shareAudio, isScreen }

// Create icons directory if it doesn't exist
const iconsDir = path.join(app.getPath('userData'), 'server-icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Default permissions — geolocation is always off and not user-configurable
const DEFAULT_PERMISSIONS = {
  notifications: false,
  screenCapture: false,
  audio: false,
  video: false
};

function getPermissions() {
  return store.get('permissions', DEFAULT_PERMISSIONS);
}

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

    // On first launch, show the permissions setup screen
    if (!store.get('permissionsConfigured', false)) {
      mainWindow.webContents.send('show-permissions-setup');
    }
  });
}

function buildPermissionHandlers(ses) {
  // Called at request time so changes to stored permissions take effect immediately
  // without needing to recreate sessions.

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const perms = getPermissions();

    if (permission === 'geolocation') return callback(false);

    if (permission === 'notifications') return callback(perms.notifications);

    if (permission === 'media') {
      const types = details.mediaTypes || [];
      // When getUserMedia is called with chromeMediaSource:'desktop', Electron
      // does not populate mediaTypes — the array is empty.  Allow it if
      // screenCapture is enabled rather than blindly denying.
      if (types.length === 0) return callback(perms.screenCapture || perms.audio || perms.video);
      const allowed = types.every(t => {
        if (t === 'audio') return perms.audio;
        if (t === 'video') return perms.video || perms.screenCapture;
        return false;
      });
      return callback(allowed);
    }

    // Deny everything else (midi, midiSysex, openExternal, fullscreen, etc.)
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
    ses.setDisplayCapturePermissionHandler(() => {
      return getPermissions().screenCapture;
    });
  }

  // Handle getDisplayMedia requests from the BrowserView.
  // view-preload.js shows the custom picker, stores the chosen source via
  // SCREENSHARE_SET_PENDING IPC, then calls the real getDisplayMedia which
  // triggers this handler. We look up the pending config and respond with the
  // correct source + loopback audio (Windows only).
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const pending = sessionPendingScreenshare.get(ses);

    if (!pending) {
      // No pending source means the user cancelled or the picker wasn't used — deny.
      callback(undefined);
      return;
    }

    sessionPendingScreenshare.delete(ses);
    const { sourceId, shareAudio, isScreen } = pending;

    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 0, height: 0 } // no thumbnails needed here
      });
      const source = sources.find(s => s.id === sourceId);

      if (!source) {
        callback(undefined);
        return;
      }

      if (shareAudio) {
        // 'loopback' captures all system audio via WASAPI loopback on Windows.
        // For screen sources this is all system audio (minus Sharkord's outgoing
        // mic, which isn't routed through the speaker pipeline). For window sources
        // Electron has no per-window audio API, so loopback is the best available.
        // On macOS/Linux loopback is silently ignored and only video is captured.
        callback({ video: source, audio: 'loopback' });
      } else {
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

  if (serverViews.has(viewId)) {
    return serverViews.get(viewId);
  }

  const partition = `persist:server-${viewId}`;
  const ses = session.fromPartition(partition);

  buildPermissionHandlers(ses);

  const view = new BrowserView({
    webPreferences: {
      partition: partition,
      nodeIntegration: false,
      contextIsolation: false,  // Must be false so view-preload.js runs in page context for screen sharing
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      webgl: true,
      webviewTag: false,
      preload: path.join(__dirname, 'view-preload.js')
    }
  });

  // Use initialUrl (with invite) for first load, then use clean url for future loads
  const urlToLoad = server.initialUrl || server.url;
  view.webContents.loadURL(urlToLoad);

  // Clear initialUrl after first successful load so future loads use clean URL
  if (server.initialUrl) {
    view.webContents.once('did-finish-load', () => {
      const servers = store.get('servers', []);
      const serverIndex = servers.findIndex(s => s.id === server.id);
      if (serverIndex !== -1 && servers[serverIndex].initialUrl) {
        delete servers[serverIndex].initialUrl;
        store.set('servers', servers);
      }
    });
  }

  // Right-click context menu
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
      menuTemplate.push(
        { label: 'Copy', role: 'copy' },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll' }
      );
    }

    if (params.linkURL) {
      if (menuTemplate.length > 0) menuTemplate.push({ type: 'separator' });
      menuTemplate.push({
        label: 'Copy Link Address',
        click: () => require('electron').clipboard.writeText(params.linkURL)
      });
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

    if (menuTemplate.length > 0) {
      Menu.buildFromTemplate(menuTemplate).popup({ window: mainWindow });
    }
  });

  serverViews.set(viewId, view);
  return view;
}

function switchToServer(serverId) {
  const servers = store.get('servers', []);
  const server = servers.find(s => s.id === serverId);
  if (!server) return;

  // Show loading screen
  mainWindow.webContents.send('show-loading');

  // Before switching, check if the CURRENT server should be kept loaded
  if (currentView) {
    const currentServerId = Array.from(serverViews.entries()).find(([id, view]) => view === currentView)?.[0];
    if (currentServerId) {
      const currentServer = servers.find(s => s.id === currentServerId);
      // If current server has keepLoaded=false, destroy it
      if (currentServer && currentServer.keepLoaded === false) {
        try {
          currentView.webContents.destroy();
        } catch (e) {
          console.error('Error destroying view:', e);
        }
        serverViews.delete(currentServerId);
      }
    }
    // Remove from display regardless
    mainWindow.removeBrowserView(currentView);
  }

  // Check if view exists for the target server
  let view;
  if (serverViews.has(serverId)) {
    view = serverViews.get(serverId);
  } else {
    view = createServerView(server);
  }

  const sidebarWidth = 72;
  const contentBounds = mainWindow.getContentBounds();
  view.setBounds({
    x: sidebarWidth,
    y: 0,
    width:  contentBounds.width  - sidebarWidth,
    height: contentBounds.height
  });

  mainWindow.addBrowserView(view);
  currentView = view;
  view.webContents.focus();

  // Hide loading screen when page loads
  view.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('hide-loading');
  });

  // Also hide on fail
  view.webContents.once('did-fail-load', () => {
    mainWindow.webContents.send('hide-loading');
  });

  mainWindow.removeAllListeners('resize');
  mainWindow.on('resize', () => {
    if (currentView === view) {
      const b = mainWindow.getContentBounds();
      view.setBounds({ x: sidebarWidth, y: 0, width: b.width - sidebarWidth, height: b.height });
    }
  });
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.on('add-server', (event, serverData) => {
  const servers = store.get('servers', []);
  const newServer = {
    id: Date.now().toString(),
    name: serverData.name,
    url: serverData.url, // This is the clean URL without invite
    icon: serverData.icon || null,
    keepLoaded: true, // default to keeping servers loaded
    initialUrl: serverData.initialUrl || serverData.url // For first load with invite
  };

  if (serverData.iconData) {
    const iconPath = path.join(iconsDir, `${newServer.id}.png`);
    const base64Data = serverData.iconData.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(iconPath, Buffer.from(base64Data, 'base64'));
    newServer.icon = iconPath;
  }

  servers.push(newServer);
  store.set('servers', servers);
  event.reply('server-added', newServer);
  event.reply('servers-loaded', servers);
});

ipcMain.on('update-server', (event, serverId, updates) => {
  const servers = store.get('servers', []);
  const serverIndex = servers.findIndex(s => s.id === serverId);

  if (serverIndex !== -1) {
    if (updates.removeIcon) {
      if (servers[serverIndex].icon && fs.existsSync(servers[serverIndex].icon)) {
        fs.unlinkSync(servers[serverIndex].icon);
      }
      servers[serverIndex].icon = null;
      delete updates.removeIcon;
    }

    if (updates.iconData) {
      if (servers[serverIndex].icon && fs.existsSync(servers[serverIndex].icon)) {
        fs.unlinkSync(servers[serverIndex].icon);
      }
      const iconPath = path.join(iconsDir, `${serverId}.png`);
      const base64Data = updates.iconData.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(iconPath, Buffer.from(base64Data, 'base64'));
      updates.icon = iconPath;
      delete updates.iconData;
    }

    servers[serverIndex] = { ...servers[serverIndex], ...updates };
    store.set('servers', servers);
    event.reply('servers-loaded', servers);
  }
});

ipcMain.on('reorder-servers', (event, newOrder) => {
  store.set('servers', newOrder);
  event.reply('servers-loaded', newOrder);
});

ipcMain.on('remove-server', (event, serverId) => {
  const servers = store.get('servers', []);
  const server = servers.find(s => s.id === serverId);

  // Delete server icon if it exists
  if (server && server.icon && fs.existsSync(server.icon)) {
    try {
      fs.unlinkSync(server.icon);
    } catch (e) {
      console.error('Error deleting icon:', e);
    }
  }

  // Clean up any other server-specific files
  // (In case there are cached files or session data)
  const serverDataDir = path.join(app.getPath('userData'), 'server-data', serverId);
  if (fs.existsSync(serverDataDir)) {
    try {
      fs.rmSync(serverDataDir, { recursive: true, force: true });
    } catch (e) {
      console.error('Error deleting server data:', e);
    }
  }

  const filteredServers = servers.filter(s => s.id !== serverId);
  store.set('servers', filteredServers);

  // Destroy and remove the browser view
  if (serverViews.has(serverId)) {
    const view = serverViews.get(serverId);
    if (currentView === view) {
      mainWindow.removeBrowserView(view);
      currentView = null;
    }
    try {
      view.webContents.destroy();
    } catch (e) {
      console.error('Error destroying view:', e);
    }
    serverViews.delete(serverId);
  }

  event.reply('server-removed', serverId);
  event.reply('servers-loaded', filteredServers);
});

ipcMain.on('refresh-server', (event, serverId) => {
  if (serverViews.has(serverId)) serverViews.get(serverId).webContents.reload();
});

ipcMain.on('switch-server', (event, serverId) => switchToServer(serverId));

ipcMain.on('get-servers', (event) => {
  event.reply('servers-loaded', store.get('servers', []));
});

ipcMain.on('show-server-context-menu', (event, { serverId }) => {
  const servers = store.get('servers', []);
  const server = servers.find(s => s.id === serverId);
  const keepLoaded = server?.keepLoaded !== false; // default true

  Menu.buildFromTemplate([
    { label: 'Rename Server', click: () => mainWindow.webContents.send('ctx-rename-server', serverId) },
    { label: 'Change Icon',   click: () => mainWindow.webContents.send('ctx-change-icon-server', serverId) },
    { label: 'Refresh',       click: () => mainWindow.webContents.send('ctx-refresh-server', serverId) },
    { type: 'separator' },
    { 
      label: 'Keep Server Loaded', 
      type: 'checkbox',
      checked: keepLoaded,
      click: () => mainWindow.webContents.send('ctx-toggle-keep-loaded', serverId)
    },
    { type: 'separator' },
    { label: 'Remove Server', click: () => mainWindow.webContents.send('ctx-remove-server', serverId) }
  ]).popup({ window: mainWindow });
});

ipcMain.on('toggle-keep-loaded', (event, serverId) => {
  const servers = store.get('servers', []);
  const serverIndex = servers.findIndex(s => s.id === serverId);
  
  if (serverIndex !== -1) {
    const currentValue = servers[serverIndex].keepLoaded !== false; // default true
    servers[serverIndex].keepLoaded = !currentValue;
    store.set('servers', servers);
    event.reply('servers-loaded', servers);
  }
});

ipcMain.on('hide-view', () => {
  if (currentView && mainWindow) {
    try { mainWindow.removeBrowserView(currentView); } catch (e) { console.error(e); }
  }
});

ipcMain.on('show-view', () => {
  if (currentView && mainWindow) {
    try {
      mainWindow.addBrowserView(currentView);
      const sidebarWidth = 72;
      const b = mainWindow.getContentBounds();
      currentView.setBounds({ x: sidebarWidth, y: 0, width: b.width - sidebarWidth, height: b.height });
      currentView.webContents.focus();
    } catch (e) { console.error(e); }
  }
});

ipcMain.handle('load-icon', async (event, iconPath) => {
  if (iconPath && fs.existsSync(iconPath)) {
    const data = fs.readFileSync(iconPath);
    return `data:image/png;base64,${data.toString('base64')}`;
  }
  return null;
});

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 300, height: 200 }
  });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event, opts) => {
  const sources = await desktopCapturer.getSources({
    ...opts,
    thumbnailSize: { width: 300, height: 200 }
  });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

// Called by view-preload.js when the user picks a source in the custom picker.
// Stores the choice so setDisplayMediaRequestHandler (above) can use it when
// the subsequent real getDisplayMedia call arrives from the renderer.
ipcMain.handle('SCREENSHARE_SET_PENDING', (event, config) => {
  sessionPendingScreenshare.set(event.sender.session, config);
  return true;
});

// ── Permission IPC ────────────────────────────────────────────────────────────

ipcMain.handle('get-permissions', () => ({
  configured: store.get('permissionsConfigured', false),
  permissions: getPermissions()
}));

ipcMain.on('set-permissions', (event, permissions) => {
  store.set('permissions', { ...DEFAULT_PERMISSIONS, ...permissions });
  store.set('permissionsConfigured', true);
});

// ── Update check ──────────────────────────────────────────────────────────────

const GITHUB_RELEASES_API = 'https://api.github.com/repos/Sweets-omg/Sweetshark-client/releases/latest';

function compareSemver(a, b) {
  // Returns true if b is newer than a
  const parse = v => v.replace(/^v\.?/, '').split('.').map(Number);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (bMaj !== aMaj) return bMaj > aMaj;
  if (bMin !== aMin) return bMin > aMin;
  return bPatch > aPatch;
}

function checkForUpdates() {
  if (store.get('checkUpdates', true) === false) return;

  const https = require('https');
  const req = https.get(
    GITHUB_RELEASES_API,
    { headers: { 'User-Agent': 'Sweetshark-Client-Updater' } },
    (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestTag = release.tag_name;
          const releaseUrl = release.html_url;
          if (!latestTag || !releaseUrl) return;

          const current = app.getVersion();
          if (compareSemver(current, latestTag)) {
            // Wait for the window to finish loading before sending the event
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.once('did-finish-load', () => {
                mainWindow.webContents.send('update-available', { version: latestTag, url: releaseUrl });
              });
              // If already loaded, send immediately
              if (!mainWindow.webContents.isLoading()) {
                mainWindow.webContents.send('update-available', { version: latestTag, url: releaseUrl });
              }
            }
          }
        } catch (_) { /* ignore parse errors */ }
      });
    }
  );
  req.on('error', () => { /* ignore network errors */ });
  req.end();
}

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.on('open-release-url', (_, url) => {
  require('electron').shell.openExternal(url);
});

ipcMain.on('disable-update-check', () => {
  store.set('checkUpdates', false);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

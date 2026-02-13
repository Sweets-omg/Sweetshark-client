const { app, BrowserWindow, BrowserView, ipcMain, session, desktopCapturer, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let currentView = null;
let serverViews = new Map();

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

// Injected into every BrowserView page (main world) to hook getDisplayMedia.
// Uses window.__sharkordBridge.getSources() which is exposed via contextBridge
// in view-preload.js, so ipcRenderer never touches the page context directly.
const SCREEN_SHARE_INJECTION = `
(function () {
  if (!navigator.mediaDevices || !window.__sharkordBridge) return;

  const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia
    ? navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
    : null;

  navigator.mediaDevices.getDisplayMedia = async function (constraints) {
    let sources;
    try {
      sources = await window.__sharkordBridge.getSources();
    } catch (err) {
      if (origGetDisplayMedia) return origGetDisplayMedia(constraints);
      throw err;
    }

    if (!sources || sources.length === 0) {
      if (origGetDisplayMedia) return origGetDisplayMedia(constraints);
      throw new Error('No screen sources available');
    }

    return new Promise((resolve, reject) => {
      const OVERLAY_ID = '__sharkord_screenshare_picker';
      const existing = document.getElementById(OVERLAY_ID);
      if (existing) existing.remove();

      // ── Overlay shell ────────────────────────────────────────────────────
      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      Object.assign(overlay.style, {
        position: 'fixed', zIndex: '99999999', inset: '0',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)', color: '#fff',
        fontFamily: 'sans-serif'
      });

      const card = document.createElement('div');
      Object.assign(card.style, {
        width: '900px', maxWidth: '95%', maxHeight: '85%', overflowY: 'auto',
        background: '#111', borderRadius: '8px', padding: '16px',
        boxSizing: 'border-box', border: '1px solid rgba(255,255,255,0.08)'
      });

      const title = document.createElement('div');
      title.textContent = 'Choose a screen or window to share';
      Object.assign(title.style, { fontSize: '18px', marginBottom: '12px' });

      const grid = document.createElement('div');
      Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: '12px'
      });

      // ── Cleanup helpers ──────────────────────────────────────────────────
      let updateInterval = null;
      let closed = false;

      function cleanup() {
        closed = true;
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = null;
        overlay.remove();
      }

      // ── Thumbnail refresh ────────────────────────────────────────────────
      async function refreshThumbnails() {
        if (closed) return;
        try {
          const updated = await window.__sharkordBridge.getSources();
          updated.forEach((src, i) => {
            const item = grid.children[i];
            if (!item) return;
            const thumb = item.querySelector('.ss-thumb');
            if (thumb && src.thumbnail) {
              thumb.style.backgroundImage = '';
              thumb.style.backgroundImage = 'url(' + src.thumbnail + ')';
            }
          });
        } catch (_) {}
      }

      // ── Source buttons ───────────────────────────────────────────────────
      for (const src of sources) {
        const item = document.createElement('button');
        item.type = 'button';
        Object.assign(item.style, {
          display: 'flex', flexDirection: 'column', alignItems: 'stretch',
          background: '#222', border: '1px solid rgba(255,255,255,0.06)',
          padding: '8px', borderRadius: '6px', cursor: 'pointer',
          color: '#fff', textAlign: 'left'
        });

        const thumb = document.createElement('div');
        thumb.className = 'ss-thumb';
        Object.assign(thumb.style, {
          height: '120px', marginBottom: '8px', background: '#333',
          borderRadius: '4px', backgroundSize: 'cover', backgroundPosition: 'center'
        });
        if (src.thumbnail) thumb.style.backgroundImage = 'url(' + src.thumbnail + ')';

        const label = document.createElement('div');
        label.textContent = src.name || ('Source ' + src.id);
        Object.assign(label.style, {
          fontSize: '13px', whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis'
        });

        item.appendChild(thumb);
        item.appendChild(label);

        item.onclick = async () => {
          cleanup();
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: {
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: src.id,
                  maxWidth: window.screen.width,
                  maxHeight: window.screen.height
                }
              }
            });
            resolve(stream);
          } catch (err) {
            if (origGetDisplayMedia) {
              try { resolve(await origGetDisplayMedia(constraints)); } catch (e) { reject(e); }
            } else {
              reject(err);
            }
          }
        };

        grid.appendChild(item);
      }

      // ── Cancel button ────────────────────────────────────────────────────
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      Object.assign(cancelBtn.style, {
        marginTop: '12px', padding: '8px 14px', background: '#333',
        border: '1px solid rgba(255,255,255,0.06)', color: '#fff',
        borderRadius: '6px', cursor: 'pointer'
      });
      cancelBtn.onclick = () => {
        cleanup();
        reject(new DOMException('User cancelled', 'AbortError'));
      };

      card.appendChild(title);
      card.appendChild(grid);
      card.appendChild(cancelBtn);
      overlay.appendChild(card);
      document.documentElement.appendChild(overlay);

      updateInterval = setInterval(refreshThumbnails, 5000);
    });
  };
})();
`;

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
      if (types.length === 0) return callback(false);
      const allowed = types.every(t => {
        if (t === 'audio') return perms.audio;
        if (t === 'video') return perms.video;
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
    if (permission === 'media') return perms.audio || perms.video;
    return false;
  });

  if (typeof ses.setDisplayCapturePermissionHandler === 'function') {
    ses.setDisplayCapturePermissionHandler(() => {
      return getPermissions().screenCapture;
    });
  }
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
      contextIsolation: true,   // Always on — screen sharing works via executeJavaScript injection
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      webgl: true,
      webviewTag: false,
      preload: path.join(__dirname, 'view-preload.js')
    }
  });

  view.webContents.loadURL(server.url);

  // Inject the getDisplayMedia override into the page's main world on every load.
  // This is safe: the injected code only calls window.__sharkordBridge.getSources()
  // which is the contextBridge endpoint from view-preload.js — ipcRenderer is never
  // reachable from the page context.
  view.webContents.on('did-finish-load', () => {
    view.webContents.executeJavaScript(SCREEN_SHARE_INJECTION).catch(() => {});
  });

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

  if (currentView) mainWindow.removeBrowserView(currentView);

  const view = createServerView(server);

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
    url: serverData.url,
    icon: serverData.icon || null
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

  if (server && server.icon && fs.existsSync(server.icon)) {
    fs.unlinkSync(server.icon);
  }

  const filteredServers = servers.filter(s => s.id !== serverId);
  store.set('servers', filteredServers);

  if (serverViews.has(serverId)) {
    const view = serverViews.get(serverId);
    if (currentView === view) {
      mainWindow.removeBrowserView(view);
      currentView = null;
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
  Menu.buildFromTemplate([
    { label: 'Rename Server', click: () => mainWindow.webContents.send('ctx-rename-server', serverId) },
    { label: 'Change Icon',   click: () => mainWindow.webContents.send('ctx-change-icon-server', serverId) },
    { label: 'Refresh',       click: () => mainWindow.webContents.send('ctx-refresh-server', serverId) },
    { type: 'separator' },
    { label: 'Remove Server', click: () => mainWindow.webContents.send('ctx-remove-server', serverId) }
  ]).popup({ window: mainWindow });
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

// ── Permission IPC ────────────────────────────────────────────────────────────

ipcMain.handle('get-permissions', () => ({
  configured: store.get('permissionsConfigured', false),
  permissions: getPermissions()
}));

ipcMain.on('set-permissions', (event, permissions) => {
  store.set('permissions', { ...DEFAULT_PERMISSIONS, ...permissions });
  store.set('permissionsConfigured', true);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

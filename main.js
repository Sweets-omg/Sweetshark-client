const { app, BrowserWindow, BrowserView, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let currentView = null;
let serverViews = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    frame: true,
    backgroundColor: '#1e1e1e'
  });

  mainWindow.loadFile('renderer/index.html');

  // Get saved servers
  const servers = store.get('servers', []);
  
  // Send servers to renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('servers-loaded', servers);
  });
}

function createServerView(server) {
  const viewId = server.id;
  
  // Check if view already exists
  if (serverViews.has(viewId)) {
    return serverViews.get(viewId);
  }

  // Create a new session partition for this server
  const partition = `persist:server-${viewId}`;
  const ses = session.fromPartition(partition);

  // Set permissions handler for media access
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = [
      'media',
      'mediaKeySystem',
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'openExternal',
      'fullscreen'
    ];
    
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Handle display capture permission (for screen sharing) - Electron 30+
  if (typeof ses.setDisplayCapturePermissionHandler === 'function') {
    ses.setDisplayCapturePermissionHandler(() => {
      return true;
    });
  }

  // Fallback permission check handler
  ses.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') {
      return true;
    }
    return true;
  });

  const view = new BrowserView({
    webPreferences: {
      partition: partition,
      nodeIntegration: false,
      contextIsolation: false, // Need to disable for screen sharing injection
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      webgl: true,
      webviewTag: false,
      preload: path.join(__dirname, 'view-preload.js')
    }
  });

  view.webContents.loadURL(server.url);

  serverViews.set(viewId, view);
  return view;
}

function switchToServer(serverId) {
  const servers = store.get('servers', []);
  const server = servers.find(s => s.id === serverId);
  
  if (!server) return;

  // Hide current view
  if (currentView) {
    mainWindow.removeBrowserView(currentView);
  }

  // Get or create view for this server
  const view = createServerView(server);
  
  // Set bounds for the view (leaving space for sidebar)
  const sidebarWidth = 72;
  const contentBounds = mainWindow.getContentBounds();
  view.setBounds({
    x: sidebarWidth,
    y: 0,
    width: contentBounds.width - sidebarWidth,
    height: contentBounds.height
  });

  mainWindow.addBrowserView(view);
  currentView = view;
  
  // Focus the view so input works
  view.webContents.focus();

  // Adjust view on window resize
  const resizeHandler = () => {
    if (currentView === view) {
      const contentBounds = mainWindow.getContentBounds();
      view.setBounds({
        x: sidebarWidth,
        y: 0,
        width: contentBounds.width - sidebarWidth,
        height: contentBounds.height
      });
    }
  };
  
  mainWindow.removeAllListeners('resize');
  mainWindow.on('resize', resizeHandler);
}

// IPC Handlers
ipcMain.on('add-server', (event, serverData) => {
  const servers = store.get('servers', []);
  const newServer = {
    id: Date.now().toString(),
    name: serverData.name,
    url: serverData.url,
    icon: serverData.icon || null
  };
  
  servers.push(newServer);
  store.set('servers', servers);
  
  event.reply('server-added', newServer);
  event.reply('servers-loaded', servers);
});

ipcMain.on('remove-server', (event, serverId) => {
  const servers = store.get('servers', []);
  const filteredServers = servers.filter(s => s.id !== serverId);
  store.set('servers', filteredServers);
  
  // Remove the view if it exists
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

ipcMain.on('switch-server', (event, serverId) => {
  switchToServer(serverId);
});

ipcMain.on('get-servers', (event) => {
  const servers = store.get('servers', []);
  event.reply('servers-loaded', servers);
});

// Handle screen sharing sources request
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen']
  });
  return sources;
});

// Handle desktop capturer for BrowserViews
ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event, opts) => {
  const sources = await desktopCapturer.getSources(opts);
  return sources;
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

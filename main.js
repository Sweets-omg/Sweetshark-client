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

  // Remove the application menu
  mainWindow.setMenu(null);

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
  
  // Enable right-click context menu in webview
  view.webContents.on('context-menu', (event, params) => {
    const menuTemplate = [];
    
    // Add "Back" and "Forward" navigation items if applicable
    if (params.editFlags.canUndo || params.editFlags.canRedo) {
      if (params.editFlags.canUndo) {
        menuTemplate.push({ label: 'Undo', role: 'undo' });
      }
      if (params.editFlags.canRedo) {
        menuTemplate.push({ label: 'Redo', role: 'redo' });
      }
      menuTemplate.push({ type: 'separator' });
    }
    
    // Add cut/copy/paste for editable content and text selection
    if (params.isEditable) {
      menuTemplate.push(
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }
      );
      if (params.editFlags.canDelete) {
        menuTemplate.push({ label: 'Delete', role: 'delete' });
      }
      menuTemplate.push(
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll' }
      );
    } else if (params.selectionText) {
      // For non-editable selected text
      menuTemplate.push(
        { label: 'Copy', role: 'copy' },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll' }
      );
    }
    
    // Add link-specific items
    if (params.linkURL) {
      if (menuTemplate.length > 0) menuTemplate.push({ type: 'separator' });
      menuTemplate.push(
        { 
          label: 'Copy Link Address', 
          click: () => {
            require('electron').clipboard.writeText(params.linkURL);
          }
        }
      );
    }
    
    // Add image-specific items
    if (params.mediaType === 'image') {
      if (menuTemplate.length > 0) menuTemplate.push({ type: 'separator' });
      menuTemplate.push(
        { 
          label: 'Copy Image', 
          click: () => {
            view.webContents.copyImageAt(params.x, params.y);
          }
        },
        { 
          label: 'Save Image As...', 
          click: () => {
            view.webContents.downloadURL(params.srcURL);
          }
        }
      );
    }
    
    // Add video/audio specific items
    if (params.mediaType === 'video' || params.mediaType === 'audio') {
      if (menuTemplate.length > 0) menuTemplate.push({ type: 'separator' });
      menuTemplate.push(
        { 
          label: 'Save As...', 
          click: () => {
            view.webContents.downloadURL(params.srcURL);
          }
        }
      );
    }
    
    // Show the menu if there are items
    if (menuTemplate.length > 0) {
      const menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup({ window: mainWindow });
    }
  });

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
  
  // Save custom icon if provided
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
    // If updating icon, delete old icon file and save new one
    if (updates.iconData) {
      // Delete old icon if it exists
      if (servers[serverIndex].icon && fs.existsSync(servers[serverIndex].icon)) {
        fs.unlinkSync(servers[serverIndex].icon);
      }
      
      // Save new icon
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
  
  // Delete icon file if it exists
  if (server && server.icon && fs.existsSync(server.icon)) {
    fs.unlinkSync(server.icon);
  }
  
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

ipcMain.on('refresh-server', (event, serverId) => {
  if (serverViews.has(serverId)) {
    const view = serverViews.get(serverId);
    view.webContents.reload();
  }
});

ipcMain.on('switch-server', (event, serverId) => {
  switchToServer(serverId);
});

ipcMain.on('get-servers', (event) => {
  const servers = store.get('servers', []);
  event.reply('servers-loaded', servers);
});

// Handlers to temporarily hide/show the BrowserView so modals in the main window can appear above it.
ipcMain.on('hide-view', () => {
  if (currentView && mainWindow) {
    try {
      mainWindow.removeBrowserView(currentView);
    } catch (e) {
      console.error('Error removing BrowserView:', e);
    }
  }
});

ipcMain.on('show-view', () => {
  if (currentView && mainWindow) {
    try {
      mainWindow.addBrowserView(currentView);
      // restore bounds - keep the view filling the right side (beside sidebar)
      const sidebarWidth = 72;
      const contentBounds = mainWindow.getContentBounds();
      currentView.setBounds({ 
        x: sidebarWidth, 
        y: 0, 
        width: contentBounds.width - sidebarWidth, 
        height: contentBounds.height 
      });
    } catch (e) {
      console.error('Error adding BrowserView back:', e);
    }
  }
});

// Load icon file data for renderer
ipcMain.handle('load-icon', async (event, iconPath) => {
  if (iconPath && fs.existsSync(iconPath)) {
    const data = fs.readFileSync(iconPath);
    return `data:image/png;base64,${data.toString('base64')}`;
  }
  return null;
});

// Handle screen sharing sources request
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 300, height: 200 }
  });
  
  // Convert thumbnails to data URLs
  return sources.map(source => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL()
  }));
});

// Handle desktop capturer for BrowserViews
ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event, opts) => {
  const sources = await desktopCapturer.getSources({
    ...opts,
    thumbnailSize: { width: 300, height: 200 }
  });
  
  // Convert thumbnails to data URLs for the picker
  return sources.map(source => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL()
  }));
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

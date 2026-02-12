const { app, BrowserWindow, BrowserView, ipcMain, session, desktopCapturer, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const crypto = require('crypto');

const store = new Store();
let mainWindow;
let currentView = null;
let serverViews = new Map();

// Security constants
const MAX_ICON_SIZE = 5 * 1024 * 1024; // 5MB max icon size
const MAX_SERVER_NAME_LENGTH = 100;
const MAX_SERVERS = 50;
const ALLOWED_URL_PROTOCOLS = ['http:', 'https:'];

// Create icons directory if it doesn't exist
const iconsDir = path.join(app.getPath('userData'), 'server-icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Security: Validate URL
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return ALLOWED_URL_PROTOCOLS.includes(url.protocol);
  } catch (e) {
    return false;
  }
}

// Security: Validate server name
function isValidServerName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_SERVER_NAME_LENGTH) return false;
  // Prevent path traversal in name
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return true;
}

// Security: Validate and sanitize file path
function isValidIconPath(iconPath) {
  if (typeof iconPath !== 'string') return false;
  const resolvedPath = path.resolve(iconPath);
  const resolvedIconsDir = path.resolve(iconsDir);
  // Ensure path is within icons directory
  return resolvedPath.startsWith(resolvedIconsDir);
}

// Security: Validate base64 image data
function isValidBase64Image(data) {
  if (typeof data !== 'string') return false;
  // Check if it's a valid data URL for images
  const match = data.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
  if (!match) return false;
  
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');
  
  // Check size limit
  if (buffer.length > MAX_ICON_SIZE) return false;
  
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: true
    },
    frame: true,
    backgroundColor: '#1e1e1e'
  });

  // Remove the application menu
  mainWindow.setMenu(null);

  // Security: Set CSP headers
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; " +
          "font-src 'self'; " +
          "connect-src 'self'"
        ]
      }
    });
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

  // Security: Set strict CSP for server views
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
          "script-src * 'unsafe-inline' 'unsafe-eval'; " +
          "connect-src * ws: wss:; " +
          "img-src * data: blob:; " +
          "media-src * blob:; " +
          "frame-src *"
        ]
      }
    });
  });

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

  // Handle display capture permission (for screen sharing)
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

  // Security: FIXED - Enable context isolation
  const view = new BrowserView({
    webPreferences: {
      partition: partition,
      nodeIntegration: false,
      contextIsolation: true, // FIXED: Enable context isolation for security
      webSecurity: true,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
      sandbox: true,
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

// IPC Handlers with security validation
ipcMain.on('add-server', (event, serverData) => {
  try {
    // Security: Validate inputs
    if (!serverData || typeof serverData !== 'object') {
      console.error('Invalid server data');
      return;
    }

    const { name, url, iconData } = serverData;

    // Validate server name
    if (!isValidServerName(name)) {
      console.error('Invalid server name');
      event.reply('server-error', 'Invalid server name');
      return;
    }

    // Validate URL
    if (!isValidUrl(url)) {
      console.error('Invalid server URL');
      event.reply('server-error', 'Invalid server URL. Only HTTP and HTTPS are allowed.');
      return;
    }

    // Check server limit
    const servers = store.get('servers', []);
    if (servers.length >= MAX_SERVERS) {
      console.error('Server limit reached');
      event.reply('server-error', 'Maximum number of servers reached');
      return;
    }

    // Generate secure ID
    const newServer = {
      id: crypto.randomBytes(16).toString('hex'),
      name: name.trim(),
      url: url.trim(),
      icon: null
    };
    
    // Save custom icon if provided
    if (iconData) {
      // Validate base64 image data
      if (!isValidBase64Image(iconData)) {
        console.error('Invalid icon data');
        event.reply('server-error', 'Invalid icon data or size too large');
        return;
      }

      const iconPath = path.join(iconsDir, `${newServer.id}.png`);
      const base64Data = iconData.replace(/^data:image\/\w+;base64,/, '');
      
      try {
        fs.writeFileSync(iconPath, Buffer.from(base64Data, 'base64'), { mode: 0o600 });
        newServer.icon = iconPath;
      } catch (err) {
        console.error('Failed to save icon:', err);
        event.reply('server-error', 'Failed to save icon');
        return;
      }
    }
    
    servers.push(newServer);
    store.set('servers', servers);
    
    event.reply('server-added', newServer);
    event.reply('servers-loaded', servers);
  } catch (error) {
    console.error('Error adding server:', error);
    event.reply('server-error', 'Failed to add server');
  }
});

ipcMain.on('update-server', (event, serverId, updates) => {
  try {
    // Security: Validate inputs
    if (typeof serverId !== 'string' || !updates || typeof updates !== 'object') {
      console.error('Invalid update parameters');
      return;
    }

    const servers = store.get('servers', []);
    const serverIndex = servers.findIndex(s => s.id === serverId);
    
    if (serverIndex === -1) {
      console.error('Server not found');
      return;
    }

    // Validate updates
    if (updates.name !== undefined) {
      if (!isValidServerName(updates.name)) {
        console.error('Invalid server name in update');
        event.reply('server-error', 'Invalid server name');
        return;
      }
      updates.name = updates.name.trim();
    }

    if (updates.url !== undefined) {
      if (!isValidUrl(updates.url)) {
        console.error('Invalid URL in update');
        event.reply('server-error', 'Invalid server URL');
        return;
      }
      updates.url = updates.url.trim();
    }

    // Handle icon removal
    if (updates.removeIcon) {
      const currentIcon = servers[serverIndex].icon;
      if (currentIcon && isValidIconPath(currentIcon) && fs.existsSync(currentIcon)) {
        try {
          fs.unlinkSync(currentIcon);
        } catch (err) {
          console.error('Failed to delete icon:', err);
        }
      }
      servers[serverIndex].icon = null;
      delete updates.removeIcon;
    }
    
    // Handle icon update
    if (updates.iconData) {
      // Validate base64 image data
      if (!isValidBase64Image(updates.iconData)) {
        console.error('Invalid icon data in update');
        event.reply('server-error', 'Invalid icon data or size too large');
        return;
      }

      // Delete old icon if it exists
      const currentIcon = servers[serverIndex].icon;
      if (currentIcon && isValidIconPath(currentIcon) && fs.existsSync(currentIcon)) {
        try {
          fs.unlinkSync(currentIcon);
        } catch (err) {
          console.error('Failed to delete old icon:', err);
        }
      }
      
      // Save new icon
      const iconPath = path.join(iconsDir, `${serverId}.png`);
      const base64Data = updates.iconData.replace(/^data:image\/\w+;base64,/, '');
      
      try {
        fs.writeFileSync(iconPath, Buffer.from(base64Data, 'base64'), { mode: 0o600 });
        updates.icon = iconPath;
      } catch (err) {
        console.error('Failed to save new icon:', err);
        event.reply('server-error', 'Failed to save icon');
        return;
      }
      
      delete updates.iconData;
    }
    
    // Apply updates
    servers[serverIndex] = { ...servers[serverIndex], ...updates };
    store.set('servers', servers);
    event.reply('servers-loaded', servers);
  } catch (error) {
    console.error('Error updating server:', error);
    event.reply('server-error', 'Failed to update server');
  }
});

ipcMain.on('reorder-servers', (event, newOrder) => {
  try {
    // Security: Validate that newOrder is an array of server objects
    if (!Array.isArray(newOrder)) {
      console.error('Invalid server order');
      return;
    }

    const currentServers = store.get('servers', []);
    
    // Verify all servers are valid
    if (newOrder.length !== currentServers.length) {
      console.error('Server count mismatch');
      return;
    }

    // Verify each server exists and has valid structure
    for (const server of newOrder) {
      if (!server.id || !server.name || !server.url) {
        console.error('Invalid server in reorder');
        return;
      }
      if (!currentServers.find(s => s.id === server.id)) {
        console.error('Unknown server in reorder');
        return;
      }
    }

    store.set('servers', newOrder);
    event.reply('servers-loaded', newOrder);
  } catch (error) {
    console.error('Error reordering servers:', error);
  }
});

ipcMain.on('remove-server', (event, serverId) => {
  try {
    // Security: Validate server ID
    if (typeof serverId !== 'string') {
      console.error('Invalid server ID');
      return;
    }

    const servers = store.get('servers', []);
    const server = servers.find(s => s.id === serverId);
    
    // Delete icon file if it exists
    if (server && server.icon && isValidIconPath(server.icon) && fs.existsSync(server.icon)) {
      try {
        fs.unlinkSync(server.icon);
      } catch (err) {
        console.error('Failed to delete icon:', err);
      }
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
  } catch (error) {
    console.error('Error removing server:', error);
  }
});

ipcMain.on('refresh-server', (event, serverId) => {
  try {
    // Security: Validate server ID
    if (typeof serverId !== 'string') {
      console.error('Invalid server ID');
      return;
    }

    if (serverViews.has(serverId)) {
      const view = serverViews.get(serverId);
      view.webContents.reload();
    }
  } catch (error) {
    console.error('Error refreshing server:', error);
  }
});

ipcMain.on('switch-server', (event, serverId) => {
  try {
    // Security: Validate server ID
    if (typeof serverId !== 'string') {
      console.error('Invalid server ID');
      return;
    }

    switchToServer(serverId);
  } catch (error) {
    console.error('Error switching server:', error);
  }
});

ipcMain.on('get-servers', (event) => {
  try {
    const servers = store.get('servers', []);
    event.reply('servers-loaded', servers);
  } catch (error) {
    console.error('Error getting servers:', error);
  }
});

ipcMain.on('show-server-context-menu', (event, { serverId }) => {
  try {
    // Security: Validate server ID
    if (typeof serverId !== 'string') {
      console.error('Invalid server ID');
      return;
    }

    const menu = Menu.buildFromTemplate([
      {
        label: 'Rename Server',
        click: () => mainWindow.webContents.send('ctx-rename-server', serverId)
      },
      {
        label: 'Change Icon',
        click: () => mainWindow.webContents.send('ctx-change-icon-server', serverId)
      },
      {
        label: 'Refresh',
        click: () => mainWindow.webContents.send('ctx-refresh-server', serverId)
      },
      { type: 'separator' },
      {
        label: 'Remove Server',
        click: () => mainWindow.webContents.send('ctx-remove-server', serverId)
      }
    ]);
    menu.popup({ window: mainWindow });
  } catch (error) {
    console.error('Error showing context menu:', error);
  }
});

// Handlers to temporarily hide/show the BrowserView
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
  try {
    // Security: Validate icon path
    if (!isValidIconPath(iconPath)) {
      console.error('Invalid icon path');
      return null;
    }

    if (iconPath && fs.existsSync(iconPath)) {
      const stats = fs.statSync(iconPath);
      
      // Security: Check file size
      if (stats.size > MAX_ICON_SIZE) {
        console.error('Icon file too large');
        return null;
      }

      const data = fs.readFileSync(iconPath);
      return `data:image/png;base64,${data.toString('base64')}`;
    }
    return null;
  } catch (error) {
    console.error('Error loading icon:', error);
    return null;
  }
});

// Handle screen sharing sources request
ipcMain.handle('get-sources', async () => {
  try {
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
  } catch (error) {
    console.error('Error getting sources:', error);
    return [];
  }
});

// Handle desktop capturer for BrowserViews
ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event, opts) => {
  try {
    // Security: Validate options
    if (opts && typeof opts !== 'object') {
      console.error('Invalid options for desktop capturer');
      return [];
    }

    const sources = await desktopCapturer.getSources({
      types: (opts && opts.types) || ['window', 'screen'],
      thumbnailSize: { width: 300, height: 200 }
    });
    
    // Convert thumbnails to data URLs
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL()
    }));
  } catch (error) {
    console.error('Error getting desktop sources:', error);
    return [];
  }
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

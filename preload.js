const { contextBridge, ipcRenderer } = require('electron');

// Security: Whitelist of allowed IPC channels
const ALLOWED_SEND_CHANNELS = [
  'add-server',
  'update-server',
  'remove-server',
  'refresh-server',
  'reorder-servers',
  'switch-server',
  'get-servers',
  'show-server-context-menu',
  'hide-view',
  'show-view'
];

const ALLOWED_RECEIVE_CHANNELS = [
  'servers-loaded',
  'server-added',
  'server-removed',
  'server-error',
  'ctx-rename-server',
  'ctx-change-icon-server',
  'ctx-refresh-server',
  'ctx-remove-server'
];

const ALLOWED_INVOKE_CHANNELS = [
  'load-icon',
  'DESKTOP_CAPTURER_GET_SOURCES'
];

// Security: Validate channel names
function isValidSendChannel(channel) {
  return ALLOWED_SEND_CHANNELS.includes(channel);
}

function isValidReceiveChannel(channel) {
  return ALLOWED_RECEIVE_CHANNELS.includes(channel);
}

function isValidInvokeChannel(channel) {
  return ALLOWED_INVOKE_CHANNELS.includes(channel);
}

// Expose secure API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Server management
  addServer: (serverData) => {
    if (isValidSendChannel('add-server')) {
      ipcRenderer.send('add-server', serverData);
    }
  },
  
  updateServer: (serverId, updates) => {
    if (isValidSendChannel('update-server')) {
      ipcRenderer.send('update-server', serverId, updates);
    }
  },
  
  removeServer: (serverId) => {
    if (isValidSendChannel('remove-server')) {
      ipcRenderer.send('remove-server', serverId);
    }
  },
  
  refreshServer: (serverId) => {
    if (isValidSendChannel('refresh-server')) {
      ipcRenderer.send('refresh-server', serverId);
    }
  },
  
  reorderServers: (newOrder) => {
    if (isValidSendChannel('reorder-servers')) {
      ipcRenderer.send('reorder-servers', newOrder);
    }
  },
  
  switchServer: (serverId) => {
    if (isValidSendChannel('switch-server')) {
      ipcRenderer.send('switch-server', serverId);
    }
  },
  
  getServers: () => {
    if (isValidSendChannel('get-servers')) {
      ipcRenderer.send('get-servers');
    }
  },
  
  // Icon loading
  loadIcon: (iconPath) => {
    if (isValidInvokeChannel('load-icon')) {
      return ipcRenderer.invoke('load-icon', iconPath);
    }
    return Promise.resolve(null);
  },
  
  // Event listeners
  onServersLoaded: (callback) => {
    if (isValidReceiveChannel('servers-loaded')) {
      const subscription = (event, servers) => callback(servers);
      ipcRenderer.on('servers-loaded', subscription);
      
      // Return unsubscribe function
      return () => {
        ipcRenderer.removeListener('servers-loaded', subscription);
      };
    }
  },
  
  onServerAdded: (callback) => {
    if (isValidReceiveChannel('server-added')) {
      const subscription = (event, server) => callback(server);
      ipcRenderer.on('server-added', subscription);
      
      return () => {
        ipcRenderer.removeListener('server-added', subscription);
      };
    }
  },
  
  onServerRemoved: (callback) => {
    if (isValidReceiveChannel('server-removed')) {
      const subscription = (event, serverId) => callback(serverId);
      ipcRenderer.on('server-removed', subscription);
      
      return () => {
        ipcRenderer.removeListener('server-removed', subscription);
      };
    }
  },
  
  onServerError: (callback) => {
    if (isValidReceiveChannel('server-error')) {
      const subscription = (event, error) => callback(error);
      ipcRenderer.on('server-error', subscription);
      
      return () => {
        ipcRenderer.removeListener('server-error', subscription);
      };
    }
  },
  
  // Context menu
  showContextMenu: (serverId) => {
    if (isValidSendChannel('show-server-context-menu')) {
      ipcRenderer.send('show-server-context-menu', { serverId });
    }
  },
  
  onCtxRenameServer: (callback) => {
    if (isValidReceiveChannel('ctx-rename-server')) {
      const subscription = (_, id) => callback(id);
      ipcRenderer.on('ctx-rename-server', subscription);
      
      return () => {
        ipcRenderer.removeListener('ctx-rename-server', subscription);
      };
    }
  },
  
  onCtxChangeIconServer: (callback) => {
    if (isValidReceiveChannel('ctx-change-icon-server')) {
      const subscription = (_, id) => callback(id);
      ipcRenderer.on('ctx-change-icon-server', subscription);
      
      return () => {
        ipcRenderer.removeListener('ctx-change-icon-server', subscription);
      };
    }
  },
  
  onCtxRefreshServer: (callback) => {
    if (isValidReceiveChannel('ctx-refresh-server')) {
      const subscription = (_, id) => callback(id);
      ipcRenderer.on('ctx-refresh-server', subscription);
      
      return () => {
        ipcRenderer.removeListener('ctx-refresh-server', subscription);
      };
    }
  },
  
  onCtxRemoveServer: (callback) => {
    if (isValidReceiveChannel('ctx-remove-server')) {
      const subscription = (_, id) => callback(id);
      ipcRenderer.on('ctx-remove-server', subscription);
      
      return () => {
        ipcRenderer.removeListener('ctx-remove-server', subscription);
      };
    }
  },
  
  // View management
  hideView: () => {
    if (isValidSendChannel('hide-view')) {
      ipcRenderer.send('hide-view');
    }
  },
  
  showView: () => {
    if (isValidSendChannel('show-view')) {
      ipcRenderer.send('show-view');
    }
  },
  
  // Screen capture
  getSources: (opts) => {
    if (isValidInvokeChannel('DESKTOP_CAPTURER_GET_SOURCES')) {
      return ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', opts || { types: ['window', 'screen'] });
    }
    return Promise.resolve([]);
  }
});

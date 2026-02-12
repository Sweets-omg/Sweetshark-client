const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  addServer: (serverData) => ipcRenderer.send('add-server', serverData),
  updateServer: (serverId, updates) => ipcRenderer.send('update-server', serverId, updates),
  removeServer: (serverId) => ipcRenderer.send('remove-server', serverId),
  refreshServer: (serverId) => ipcRenderer.send('refresh-server', serverId),
  reorderServers: (newOrder) => ipcRenderer.send('reorder-servers', newOrder),
  switchServer: (serverId) => ipcRenderer.send('switch-server', serverId),
  getServers: () => ipcRenderer.send('get-servers'),
  loadIcon: (iconPath) => ipcRenderer.invoke('load-icon', iconPath),
  onServersLoaded: (callback) => ipcRenderer.on('servers-loaded', (event, servers) => callback(servers)),
  onServerAdded: (callback) => ipcRenderer.on('server-added', (event, server) => callback(server)),
  onServerRemoved: (callback) => ipcRenderer.on('server-removed', (event, serverId) => callback(serverId)),
  // Native context menu for server icons (no hide/show needed — native menu floats above BrowserView)
  showContextMenu: (serverId) => ipcRenderer.send('show-server-context-menu', { serverId }),
  onCtxRenameServer: (cb) => ipcRenderer.on('ctx-rename-server', (_, id) => cb(id)),
  onCtxChangeIconServer: (cb) => ipcRenderer.on('ctx-change-icon-server', (_, id) => cb(id)),
  onCtxRefreshServer: (cb) => ipcRenderer.on('ctx-refresh-server', (_, id) => cb(id)),
  onCtxRemoveServer: (cb) => ipcRenderer.on('ctx-remove-server', (_, id) => cb(id)),
  // Helpers for UI that needs to temporarily hide the BrowserView (so modals appear above)
  hideView: () => ipcRenderer.send('hide-view'),
  showView: () => ipcRenderer.send('show-view'),
  // Expose source picker helper
  getSources: (opts) => ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', opts || { types: ['window', 'screen'] })
});

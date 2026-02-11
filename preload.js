const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  addServer: (serverData) => ipcRenderer.send('add-server', serverData),
  removeServer: (serverId) => ipcRenderer.send('remove-server', serverId),
  switchServer: (serverId) => ipcRenderer.send('switch-server', serverId),
  getServers: () => ipcRenderer.send('get-servers'),
  onServersLoaded: (callback) => ipcRenderer.on('servers-loaded', (event, servers) => callback(servers)),
  onServerAdded: (callback) => ipcRenderer.on('server-added', (event, server) => callback(server)),
  onServerRemoved: (callback) => ipcRenderer.on('server-removed', (event, serverId) => callback(serverId)),
  // New helpers for UI that needs to temporarily hide the BrowserView (so modals appear above)
  hideView: () => ipcRenderer.send('hide-view'),
  showView: () => ipcRenderer.send('show-view'),
  // Expose source picker helper
  getSources: (opts) => ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', opts || { types: ['window', 'screen'] })
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  addServer: (serverData) => ipcRenderer.send('add-server', serverData),
  removeServer: (serverId) => ipcRenderer.send('remove-server', serverId),
  switchServer: (serverId) => ipcRenderer.send('switch-server', serverId),
  getServers: () => ipcRenderer.send('get-servers'),
  onServersLoaded: (callback) => ipcRenderer.on('servers-loaded', (event, servers) => callback(servers)),
  onServerAdded: (callback) => ipcRenderer.on('server-added', (event, server) => callback(server)),
  onServerRemoved: (callback) => ipcRenderer.on('server-removed', (event, serverId) => callback(serverId))
});

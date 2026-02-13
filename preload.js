const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  addServer:      (serverData)          => ipcRenderer.send('add-server', serverData),
  updateServer:   (serverId, updates)   => ipcRenderer.send('update-server', serverId, updates),
  removeServer:   (serverId)            => ipcRenderer.send('remove-server', serverId),
  refreshServer:  (serverId)            => ipcRenderer.send('refresh-server', serverId),
  reorderServers: (newOrder)            => ipcRenderer.send('reorder-servers', newOrder),
  switchServer:   (serverId)            => ipcRenderer.send('switch-server', serverId),
  getServers:     ()                    => ipcRenderer.send('get-servers'),
  loadIcon:       (iconPath)            => ipcRenderer.invoke('load-icon', iconPath),

  onServersLoaded:  (cb) => ipcRenderer.on('servers-loaded',  (_, s)  => cb(s)),
  onServerAdded:    (cb) => ipcRenderer.on('server-added',    (_, s)  => cb(s)),
  onServerRemoved:  (cb) => ipcRenderer.on('server-removed',  (_, id) => cb(id)),

  showContextMenu:      (serverId) => ipcRenderer.send('show-server-context-menu', { serverId }),
  onCtxRenameServer:    (cb) => ipcRenderer.on('ctx-rename-server',    (_, id) => cb(id)),
  onCtxChangeIconServer:(cb) => ipcRenderer.on('ctx-change-icon-server',(_, id) => cb(id)),
  onCtxRefreshServer:   (cb) => ipcRenderer.on('ctx-refresh-server',   (_, id) => cb(id)),
  onCtxRemoveServer:    (cb) => ipcRenderer.on('ctx-remove-server',    (_, id) => cb(id)),

  hideView: () => ipcRenderer.send('hide-view'),
  showView: () => ipcRenderer.send('show-view'),

  getSources: (opts) =>
    ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', opts || { types: ['window', 'screen'] }),

  // Permissions
  getPermissions:  ()           => ipcRenderer.invoke('get-permissions'),
  setPermissions:  (perms)      => ipcRenderer.send('set-permissions', perms),
  onShowPermissionsSetup: (cb)  => ipcRenderer.on('show-permissions-setup', () => cb()),
});

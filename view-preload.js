const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, named bridge so the screen-share injection (executed via
// executeJavaScript in main.js) can request sources without ever having direct
// access to ipcRenderer.  Nothing else is exposed to the page.
contextBridge.exposeInMainWorld('__sharkordBridge', {
  getSources: () =>
    ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', {
      types: ['window', 'screen']
    })
});

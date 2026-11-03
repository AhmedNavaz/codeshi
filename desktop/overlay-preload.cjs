const { contextBridge, ipcRenderer } = require('electron');
// The alert panel near the top of the screen (#13) can only show an alert, open it in Codeshi or dismiss it.
contextBridge.exposeInMainWorld('relayOverlay', Object.freeze({
  onAlert: callback => { ipcRenderer.on('overlay:alert', (_event, alert) => callback(alert)); },
  open: () => ipcRenderer.send('overlay:open'),
  dismiss: () => ipcRenderer.send('overlay:dismiss'),
}));

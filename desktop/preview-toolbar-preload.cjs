const { contextBridge, ipcRenderer } = require('electron');
// The preview's toolbar (#19) can move the page, start picking, open the page in the browser and go back to
// Codeshi. It hears the page's state, picks, load errors and the latest edit's file and line counts. It has no other access.
const listen = channel => callback => { ipcRenderer.on(channel, (_event, value) => callback(value)); };
contextBridge.exposeInMainWorld('relayPreview', Object.freeze({
  act: (action, value) => ipcRenderer.send('preview:toolbar', action, value),
  onState: listen('preview:state'),
  onPicked: listen('preview:picked'),
  onError: listen('preview:error'),
  onEdit: listen('preview:edit'),
  onStack: listen('preview:stack'),
  onApiCall: listen('preview:api-call'),
}));

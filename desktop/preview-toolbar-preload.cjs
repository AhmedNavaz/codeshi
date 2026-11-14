const { contextBridge, ipcRenderer } = require('electron');
// The preview's toolbar (#19) can move the page, start picking or marking design sections (#125), open the page in the browser, open another of the
// review's interfaces in a window of its own (#142) and go back to Codeshi. It hears the page's state, picks, load
// errors, the latest edit's file and line counts, the review's stack, the page's API calls and the inspector's
// shortcut. It has no other access.
const listen = channel => callback => { ipcRenderer.on(channel, (_event, value) => callback(value)); };
contextBridge.exposeInMainWorld('relayPreview', Object.freeze({
  act: (action, value) => ipcRenderer.send('preview:toolbar', action, value),
  onState: listen('preview:state'),
  onPicked: listen('preview:picked'),
  onError: listen('preview:error'),
  onEdit: listen('preview:edit'),
  onStack: listen('preview:stack'),
  onApiCall: listen('preview:api-call'),
  onToggleInspector: listen('preview:toggle-inspector'),
  // Design notes (#125): the sections marked on the page, and word that they went into the message.
  onDesign: listen('preview:design'),
  onDesignAdded: listen('preview:design-added'),
  // Unsent notes from this interface's last window, the element the keyboard has outlined, and word to write notes.
  onDesignRestore: listen('preview:design-restore'),
  onDesignCursor: listen('preview:design-cursor'),
  onDesignWrite: listen('preview:design-write'),
}));

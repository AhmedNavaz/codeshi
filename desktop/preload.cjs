const { contextBridge, ipcRenderer } = require('electron');
const token = process.argv.find(value => value.startsWith('--relay-token='))?.slice(14);
// "development" when the app runs from source rather than an installed release.
const channel = process.argv.includes('--relay-channel=development') ? 'development' : 'release';
contextBridge.exposeInMainWorld('relayDesktop', Object.freeze({
  token,
  channel,
  pickFolder: () => ipcRenderer.invoke('relay:pick-folder'),
  openExternal: url => ipcRenderer.invoke('relay:open-external',url),
  platform: process.platform,
  getLaunchState: () => ipcRenderer.invoke('relay:launch'),
  acknowledgeUpdate: () => ipcRenderer.invoke('relay:acknowledge-update'),
  getUpdateState: () => ipcRenderer.invoke('relay:update:get'),
  checkForUpdates: () => ipcRenderer.invoke('relay:update:check'),
  installUpdate: () => ipcRenderer.invoke('relay:update:install'),
  restartToUpdate: () => ipcRenderer.invoke('relay:update:restart'),
  cancelUpdate: () => ipcRenderer.invoke('relay:update:cancel'),
  skipUpdate: version => ipcRenderer.invoke('relay:update:skip', version),
  setAutomaticUpdates: enabled => ipcRenderer.invoke('relay:update:automatic', enabled),
  onQuitting: callback => ipcRenderer.once('relay:quitting', () => callback()),
  onUpdateState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('relay:update-state', listener);
    return () => ipcRenderer.removeListener('relay:update-state', listener);
  },
  getKeepAwake: () => ipcRenderer.invoke('relay:keep-awake:get'),
  setKeepAwake: enabled => ipcRenderer.invoke('relay:keep-awake:set', enabled),
  onKeepAwakeChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('relay:keep-awake-changed', listener);
    return () => ipcRenderer.removeListener('relay:keep-awake-changed', listener);
  },
  onMenuCommand: callback => {
    const listener = (_event, name, value) => callback(name, value);
    ipcRenderer.on('relay:menu-command', listener);
    return () => ipcRenderer.removeListener('relay:menu-command', listener);
  },
  setMenuState: state => ipcRenderer.send('relay:menu-state', state),
  // Point and tell (#19): opens a local address in its own preview window, or brings that window forward (#142); what
  // is picked there comes back here. closePreviews closes a workspace's windows showing the given addresses.
  openPreview: input => ipcRenderer.invoke('relay:preview:open', input),
  closePreviews: input => ipcRenderer.invoke('relay:preview:close', input),
  onPreviewPick: callback => {
    const listener = (_event, pick) => callback(pick);
    ipcRenderer.on('relay:preview-pick', listener);
    return () => ipcRenderer.removeListener('relay:preview-pick', listener);
  },
}));

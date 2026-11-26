const { contextBridge, ipcRenderer, webUtils } = require('electron');
const token = process.argv.find(value => value.startsWith('--relay-token='))?.slice(14);
// "development" when the app runs from source rather than an installed release.
const channel = process.argv.includes('--relay-channel=development') ? 'development' : 'release';
contextBridge.exposeInMainWorld('relayDesktop', Object.freeze({
  token,
  channel,
  pickFolder: () => ipcRenderer.invoke('relay:pick-folder'),
  // Where to save a Codeshi backup ({ mode: 'save', name }) or which one to import ({ mode: 'open' }), or null.
  pickBackup: input => ipcRenderer.invoke('relay:pick-backup', input),
  // The path of a file or folder dropped on the page, for setup's drop zone. Empty when it has no path on disk.
  pathForFile: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
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
  // Open at login (#132): { supported, enabled, approval } where approval means macOS is waiting for the person to allow it.
  getOpenAtLogin: () => ipcRenderer.invoke('relay:login:get'),
  setOpenAtLogin: enabled => ipcRenderer.invoke('relay:login:set', enabled),
  // Work time: { idleMs, locked } since the last input anywhere on the computer, and a quiet banner for a break reminder
  // while Codeshi is behind other windows.
  getIdle: () => ipcRenderer.invoke('relay:idle'),
  breakBanner: input => ipcRenderer.invoke('relay:break-banner', input),
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
  // Try it in Settings › Alerts: the real banner, Dock badge and bounce for one moment ('attention', 'finished' or
  // 'stopped'), and the pill under the menu bar with an example line.
  tryAlert: moment => ipcRenderer.invoke('relay:alert:try', { moment }),
  tryPill: () => ipcRenderer.invoke('relay:pill:try'),
  setMenuState: state => ipcRenderer.send('relay:menu-state', state),
  // Point and tell (#19): opens a local address in its own preview window, or brings that window forward (#142); what
  // is picked there comes back here. closePreviews closes a workspace's windows showing the given addresses.
  openPreview: input => ipcRenderer.invoke('relay:preview:open', input),
  closePreviews: input => ipcRenderer.invoke('relay:preview:close', input),
  // Workspaces in windows of their own (#203). claimWorkspace({ projectId, initial }) asks before this window shows a
  // workspace and answers { elsewhere: true } when another window shows it, which then comes forward instead.
  claimWorkspace: input => ipcRenderer.invoke('relay:window:claim', input),
  workspacesElsewhere: () => ipcRenderer.invoke('relay:window:elsewhere'),
  openWorkspaceWindow: projectId => ipcRenderer.invoke('relay:window:open', { projectId }),
  // The system menu for a workspace in the sidebar; answers 'window', 'settings', 'pin', 'unpin' or null. pin says whether
  // it is pinned beside this window's workspace as a companion lane ('pinned'), can be ('can'), or neither (null).
  workspaceMenu: (projectId, { pin = null } = {}) => ipcRenderer.invoke('relay:window:menu', { projectId, pin }),
  // The workspaces pinned in this window's companion lanes, so a notification for one opens there (#203).
  setLanes: projectIds => ipcRenderer.send('relay:window:lanes', { projectIds }),
  onWindowsChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('relay:windows-changed', listener);
    return () => ipcRenderer.removeListener('relay:windows-changed', listener);
  },
  onPreviewPick: callback => {
    const listener = (_event, pick) => callback(pick);
    ipcRenderer.on('relay:preview-pick', listener);
    return () => ipcRenderer.removeListener('relay:preview-pick', listener);
  },
}));

import path from 'node:path';
import { overlayBounds } from './status.mjs';

// Alerts near the top of the screen (#13), when turned on. A small panel under the menu bar of the display the
// pointer is on, which never takes keyboard focus, is not shown over full-screen apps and follows the app's
// appearance. Clicking it opens the workspace, or an approval's own request card; it never answers anything. An
// approval stays until it is answered or dismissed, anything else goes after a few seconds.
export const OVERLAY_SECONDS = 8;
export function createOverlay({ BrowserWindow, screen, ipcMain, root, open, mac = process.platform === 'darwin' }) {
  let win = null, current = null, timer = null, disposed = false;
  const size = { width: 420, height: 88 };
  function window() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({ ...size, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, acceptFirstMouse: true, ...(mac ? { type: 'panel' } : {}),
      webPreferences: { preload: path.join(root, 'desktop', 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.setAlwaysOnTop(true, 'status');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.loadFile(path.join(root, 'desktop', 'overlay.html'));
    return win;
  }
  const own = event => win && !win.isDestroyed() && event.sender === win.webContents;
  const onOpen = event => { if (!own(event) || !current) return; const target = current; hide(); open(target); };
  const onDismiss = event => { if (own(event)) hide(); };
  ipcMain.on('overlay:open', onOpen); ipcMain.on('overlay:dismiss', onDismiss);

  function show(alert) {
    if (disposed) return;
    current = { kind: alert.kind, title: String(alert.title || ''), body: String(alert.body || '').slice(0, 240), projectName: alert.projectName ? String(alert.projectName) : '', projectId: alert.projectId || null, approvalId: alert.approvalId || null };
    const panel = window(), display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    panel.setBounds(overlayBounds(display, size));
    // An alert taken away, or replaced, while the panel's page loads is not shown when it finishes.
    const shown = current, send = () => { if (!panel.isDestroyed() && current === shown) { panel.webContents.send('overlay:alert', shown); panel.showInactive(); } };
    if (panel.webContents.isLoading()) panel.webContents.once('did-finish-load', send); else send();
    clearTimeout(timer);
    if (current.kind !== 'approval') timer = setTimeout(hide, OVERLAY_SECONDS * 1000);
  }
  function hide() { clearTimeout(timer); timer = null; current = null; if (win && !win.isDestroyed()) win.hide(); }
  // An approval answered in the window, or a run that ended, takes its alert away.
  function reconcile(snapshot) {
    if (current?.kind === 'approval' && !snapshot?.rows.some(row => row.approvalId === current.approvalId)) hide();
  }
  function dispose() { disposed = true; hide(); ipcMain.off('overlay:open', onOpen); ipcMain.off('overlay:dismiss', onDismiss); if (win && !win.isDestroyed()) win.destroy(); win = null; }
  return { show, hide, reconcile, dispose, get current() { return current; } };
}

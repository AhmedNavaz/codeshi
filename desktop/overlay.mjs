import path from 'node:path';
import { overlayBounds, progressLine, progressTrack } from './status.mjs';
import { english } from '../src/i18n.mjs';

// Alerts near the top of the screen (#13), when turned on. A small panel under the menu bar of the display the
// pointer is on, which never takes keyboard focus, is not shown over full-screen apps and follows the app's
// appearance. Clicking it opens the workspace, or an approval's own request card; it never answers anything. An
// approval stays until it is answered or dismissed, anything else goes after a few seconds.
//
// With the progress pill turned on (#75), whichever way banners show, a smaller pill stays there while agents work and Codeshi isn't in front,
// with the menu bar status's words. It is quiet: it changes only when the words do, never moves while it shows, has
// no animation or sound and makes no screen-reader announcement. An alert takes its place, and it comes back when
// the alert goes if work is still running. Its × hides it until another run starts.
export const OVERLAY_SECONDS = 8;
const ALERT_SIZE = { width: 420, height: 88 }, PILL_SIZE = { width: 400, height: 46 };
export function createOverlay({ BrowserWindow, screen, ipcMain, root, open, mac = process.platform === 'darwin', isFocused = () => false }) {
  let win = null, current = null, timer = null, disposed = false;
  // What the window holds: the alert, the pill's line, or nothing. `delivery` stands for the latest content sent, so
  // content replaced while the page loads is never shown.
  let pill = null, delivery = null, visible = false;
  let progress = { enabled: false, snapshot: null, text: english }, track = progressTrack(), dismissed = new Set();
  function window() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({ ...ALERT_SIZE, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, acceptFirstMouse: true, ...(mac ? { type: 'panel' } : {}),
      webPreferences: { preload: path.join(root, 'desktop', 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.setAlwaysOnTop(true, 'status');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.loadFile(path.join(root, 'desktop', 'overlay.html'));
    return win;
  }
  // Sends content to the panel. `size` places it under the menu bar of the display the pointer is on; without it,
  // the panel stays where it is, so the pill doesn't jump between screens as its words change.
  function deliver(content, size) {
    const panel = window(), sent = delivery = { content };
    if (size) panel.setBounds(overlayBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), size));
    const send = () => { if (panel.isDestroyed() || delivery !== sent) return; panel.webContents.send('overlay:alert', content); if (!visible) { visible = true; panel.showInactive(); } };
    if (panel.webContents.isLoading()) panel.webContents.once('did-finish-load', send); else send();
  }
  function conceal() { delivery = null; visible = false; if (win && !win.isDestroyed()) win.hide(); }

  const own = event => win && !win.isDestroyed() && event.sender === win.webContents;
  const onOpen = event => {
    if (!own(event)) return;
    if (current) { const target = current; hide(); open(target); }
    else if (pill) { const target = { projectId: pill.projectId }; conceal(); pill = null; open(target); }
  };
  const onDismiss = event => {
    if (!own(event)) return;
    if (current) hide();
    else if (pill) { dismissed = new Set(runningKeys(progress.snapshot)); pill = null; conceal(); }
  };
  ipcMain.on('overlay:open', onOpen); ipcMain.on('overlay:dismiss', onDismiss);

  function show(alert) {
    if (disposed) return;
    current = { kind: alert.kind, title: String(alert.title || ''), body: String(alert.body || '').slice(0, 240), projectName: alert.projectName ? String(alert.projectName) : '', projectId: alert.projectId || null, approvalId: alert.approvalId || null };
    pill = null; visible = false;
    deliver(current, ALERT_SIZE);
    clearTimeout(timer);
    if (current.kind !== 'approval') timer = setTimeout(hide, OVERLAY_SECONDS * 1000);
  }
  // Takes the alert away. The pill comes back in its place when it has something to say.
  // The panel goes straight from the alert to the pill, without hiding in between.
  function hide() { clearTimeout(timer); timer = null; current = null; pill = null; if (!refresh()) conceal(); }
  // An approval answered in the window, or a run that ended, takes its alert away.
  function reconcile(snapshot) {
    if (current?.kind === 'approval' && !snapshot?.rows.some(row => row.approvalId === current.approvalId)) hide();
  }

  // Every change in what is running, from the status the menu bar shows. `enabled` is the Alerts setting.
  function update(snapshot, { enabled = false, text = english } = {}) {
    progress = { enabled: Boolean(enabled), snapshot, text };
    track = progressTrack(track, snapshot);
    const running = new Set(runningKeys(snapshot));
    dismissed = new Set([...dismissed].filter(key => running.has(key)));
    refresh();
  }
  // Shows, changes or takes away the pill, and says whether it shows. Nothing is sent when its words are the same.
  function refresh() {
    if (disposed || current) return false;
    const line = progress.enabled && !isFocused() ? progressLine(progress.snapshot, track.latest, progress.text, dismissed) : null;
    if (!line) { if (pill) { pill = null; conceal(); } return false; }
    if (pill && pill.title === line.title && pill.detail === line.detail) { pill = line; return true; }
    const showing = Boolean(pill);
    pill = line;
    deliver({ kind: 'progress', title: line.title, body: line.detail }, showing ? null : PILL_SIZE);
    return true;
  }
  function dispose() { disposed = true; clearTimeout(timer); current = null; pill = null; conceal(); ipcMain.off('overlay:open', onOpen); ipcMain.off('overlay:dismiss', onDismiss); if (win && !win.isDestroyed()) win.destroy(); win = null; }
  return { show, hide, reconcile, progress: update, refresh, dispose, get current() { return current; }, get pill() { return pill; } };
}
const runningKeys = snapshot => (snapshot?.rows || []).filter(row => row.kind === 'running' && row.key).map(row => row.key);

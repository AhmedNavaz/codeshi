// Which Codeshi window shows which workspace (#203). Each workspace shows in at most one window: choosing one that is
// open elsewhere brings that window forward instead, and a notification, the menu bar status or a preview pick goes to
// the window already showing its workspace rather than pulling another window away from its own.
// Kept apart from Electron so it can be tested: a window here is anything with isDestroyed() and isVisible().
export function createWorkspaceWindows() {
  const entries = new Map();
  let clock = 0;
  const live = window => Boolean(window && !window.isDestroyed());
  const listed = () => [...entries].filter(([window]) => live(window));
  // The newest first: the window last in front comes first.
  const byRecent = items => items.sort((a, b) => b[1].used - a[1].used);
  // A window still loading counts as showing its workspace, so a second click doesn't open it twice.
  const shown = (window, entry) => window.isVisible() || entry.opening;
  return {
    track(window, { primary = false, projectId = null, opening = false } = {}) {
      entries.set(window, { primary, projectId: projectId || null, opening, used: ++clock, lanes: [] });
      return window;
    },
    forget(window) { entries.delete(window); },
    has(window) { return live(window) && entries.has(window); },
    windows() { return listed().map(([window]) => window); },
    // A window came forward.
    touch(window) { const entry = entries.get(window); if (entry) entry.used = ++clock; },
    // A new window showed for the first time, or never will.
    opened(window) { const entry = entries.get(window); if (entry) entry.opening = false; },
    projectOf(window) { return entries.get(window)?.projectId ?? null; },
    // The window showing a workspace, the one last in front if the person opened it twice. A hidden window doesn't count.
    showing(projectId, { except = null } = {}) {
      if (!projectId) return null;
      return byRecent(listed().filter(([window, entry]) => window !== except && entry.projectId === projectId && shown(window, entry))).at(0)?.[0] ?? null;
    },
    // The workspaces a window has pinned beside its own as companion lanes (#203).
    lanes(window, projectIds) { const entry = entries.get(window); if (entry) entry.lanes = [...new Set(projectIds)]; },
    // A visible window with a workspace pinned in a lane, the one last in front: a notification for that workspace opens
    // there, in the lane, when no window shows it.
    pinned(projectId) {
      if (!projectId) return null;
      return byRecent(listed().filter(([window, entry]) => entry.lanes?.includes(projectId) && entry.projectId !== projectId && window.isVisible())).at(0)?.[0] ?? null;
    },
    // The window last in front, for commands that belong to no workspace.
    front() { return byRecent(listed().filter(([window]) => window.isVisible())).at(0)?.[0] ?? null; },
    // Workspaces shown in the other visible windows, so a window's sidebar can mark them.
    elsewhere(window) { return [...new Set(listed().filter(([other, entry]) => other !== window && entry.projectId && shown(other, entry)).map(([, entry]) => entry.projectId))]; },
    // A window asks to show a workspace. When another window shows it, that window is returned and nothing changes,
    // except on a window's first load, which takes it anyway: a window must show something, even if every workspace
    // is open elsewhere.
    claim(window, projectId, { initial = false } = {}) {
      const entry = entries.get(window);
      if (!entry) return { refused: true };
      const other = projectId ? this.showing(projectId, { except: window }) : null;
      if (other && !initial) return { elsewhere: other };
      entry.projectId = projectId || null;
      return { here: true };
    },
    // Another window open besides this one, the main window hidden or not.
    othersVisible(window) { return listed().some(([other, entry]) => other !== window && shown(other, entry)); },
  };
}

// A new window opens a little below and right of the one in front, as macOS and Windows place new document windows,
// and moves back into the screen's work area if that would put it partly off screen.
export function cascade(from, area, { width = 1280, height = 900, step = 28 } = {}) {
  const size = { width: Math.min(from?.width || width, area.width), height: Math.min(from?.height || height, area.height) };
  if (!from) return { ...size, x: Math.round(area.x + (area.width - size.width) / 2), y: Math.round(area.y + (area.height - size.height) / 2) };
  let x = from.x + step, y = from.y + step;
  if (x + size.width > area.x + area.width) x = area.x;
  if (y + size.height > area.y + area.height) y = area.y;
  return { ...size, x, y };
}

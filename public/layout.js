(() => {
  'use strict';
  // Resizable sections: the sidebar, the right-hand panel (Git, Agents, reviews), the split between workspaces and
  // files, and the bottom panel (Terminal and Run). Drag a handle, use the arrow keys on it, or double-click to reset. Sizes are kept per
  // viewer in this browser only; without storage the defaults apply.
  const KEY = 'throughline:layout', root = document.documentElement, $ = id => document.getElementById(id);
  let sizes = {};
  try { sizes = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { sizes = {}; }
  // The terminal and Run were separate panels, each with its own height; the shared panel keeps the terminal's.
  if ('terminal' in sizes || 'commands' in sizes) {
    if (!sizes.panel && (sizes.terminal || sizes.commands)) sizes.panel = sizes.terminal || sizes.commands;
    delete sizes.terminal; delete sizes.commands;
    try { localStorage.setItem(KEY, JSON.stringify(sizes)); } catch { /* Sizes are a convenience. */ }
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(sizes)); } catch { /* Sizes are a convenience. */ } };
  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
  // Covers the window during a drag, so the cursor stays the same over everything.
  const shield = document.createElement('div');
  const sidePanels = () => ['git-panel', 'agents-panel', 'brief-panel', 'tasks-panel', 'review-panel'].map($).filter(Boolean);

  // name: [how to measure the current size, how to apply a size, min, max, axis, sign, label]
  const sections = {
    sidebar: { measure: () => document.querySelector('.sidebar')?.getBoundingClientRect().width, apply: value => value ? root.style.setProperty('--sidebar-width', value + 'px') : root.style.removeProperty('--sidebar-width'), min: 260, max: 520, axis: 'x', sign: 1, label: 'Resize the sidebar' },
    inspector: { measure: () => sidePanels().find(panel => !panel.hidden)?.getBoundingClientRect().width, apply: value => value ? root.style.setProperty('--inspector-width', value + 'px') : root.style.removeProperty('--inspector-width'), min: 360, max: 720, axis: 'x', sign: -1, label: 'Resize the side panel' },
    workspaces: { measure: () => $('workspace-list')?.getBoundingClientRect().height, apply: value => { const list = $('workspace-list'); if (list) list.style.flexBasis = value ? value + 'px' : ''; document.querySelector('.sidebar')?.classList.toggle('sized', Boolean(value)); }, min: 60, max: 640, axis: 'y', sign: 1, label: 'Resize workspaces and files' },
    panel: { measure: () => $('bottom-panel')?.getBoundingClientRect().height, apply: value => { const panel = $('bottom-panel'); if (panel) panel.style.height = value ? value + 'px' : ''; }, min: 140, max: 720, axis: 'y', sign: -1, label: 'Resize the terminal and Run panel' },
  };
  function set(name, value) {
    const section = sections[name];
    if (value === null) delete sizes[name]; else sizes[name] = clamp(value, section.min, section.max);
    section.apply(sizes[name] || null);
  }
  const bars = [];
  function handle(host, name, placement) {
    if (!host) return;
    const section = sections[name], bar = document.createElement('div');
    bars.push(bar);
    bar.className = `resize-handle ${section.axis === 'x' ? 'columns' : 'rows'} ${placement}`;
    bar.setAttribute('role', 'separator'); bar.setAttribute('aria-orientation', section.axis === 'x' ? 'vertical' : 'horizontal');
    bar.setAttribute('aria-label', section.label); bar.tabIndex = 0; bar.title = `${section.label}. Double-click to reset.`;
    let start = null;
    bar.addEventListener('pointerdown', event => {
      start = { at: section.axis === 'x' ? event.clientX : event.clientY, size: section.measure() || 0 };
      bar.setPointerCapture?.(event.pointerId); bar.classList.add('dragging');
      shield.className = `resize-shield ${section.axis === 'x' ? 'columns' : 'rows'}`; document.body.append(shield);
      event.preventDefault();
    });
    bar.addEventListener('pointermove', event => { if (start) set(name, start.size + section.sign * ((section.axis === 'x' ? event.clientX : event.clientY) - start.at)); });
    const end = () => { if (!start) return; start = null; bar.classList.remove('dragging'); shield.remove(); save(); };
    bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
    bar.addEventListener('dblclick', () => { set(name, null); save(); });
    bar.addEventListener('keydown', event => {
      const step = event.shiftKey ? 48 : 16, forward = section.axis === 'x' ? 'ArrowRight' : 'ArrowDown', back = section.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      if (event.key !== forward && event.key !== back) return;
      event.preventDefault();
      set(name, (sizes[name] || section.measure() || 0) + section.sign * (event.key === forward ? step : -step)); save();
    });
    if (placement === 'before') host.parentNode.insertBefore(bar, host); else host.append(bar);
  }
  for (const name of Object.keys(sizes)) if (sections[name]) set(name, sizes[name]);
  handle(document.querySelector('.sidebar'), 'sidebar', 'edge-end');
  for (const panel of sidePanels()) handle(panel, 'inspector', 'edge-start');
  handle($('explorer'), 'workspaces', 'before');
  handle($('bottom-panel'), 'panel', 'edge-top');
  // While the pointer moves, each divider shows a small grip, so it's clear which ones can be dragged. Only the dividers
  // change, not the page, so moving the mouse stays cheap in a long conversation.
  let hinting = false, hintTimer = null;
  document.addEventListener('pointermove', () => {
    if (!hinting) { hinting = true; for (const bar of bars) bar.classList.add('hinting'); }
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hinting = false; for (const bar of bars) bar.classList.remove('hinting'); }, 1200);
  }, { passive: true });
  // Layout buttons at the top right, as in an editor: the sidebar and the side panel on the right. Each is filled
  // while its area shows. The side panel reopens on the tab last used (Agents at first).
  const SIDEBAR_KEY = 'throughline:sidebar', LAST_PANEL_KEY = 'throughline:side-panel-last', shell = $('app-shell');
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* A convenience only. */ } };
  function sync() {
    $('toggle-sidebar')?.setAttribute('aria-pressed', String(!shell?.classList.contains('sidebar-collapsed')));
    $('toggle-side-panel')?.setAttribute('aria-pressed', String(sidePanels().some(panel => !panel.hidden)));
    for (const [id, name] of [['agents-panel', 'agents'], ['git-panel', 'git'], ['brief-panel', 'brief'], ['tasks-panel', 'tasks']]) if ($(id) && !$(id).hidden) write(LAST_PANEL_KEY, name);
  }
  function setSidebar(collapsed) {
    shell?.classList.toggle('sidebar-collapsed', collapsed);
    write(SIDEBAR_KEY, collapsed ? 'hidden' : 'shown');
    sync();
  }
  if (read(SIDEBAR_KEY) === 'hidden') shell?.classList.add('sidebar-collapsed');
  $('toggle-sidebar')?.addEventListener('click', () => setSidebar(!shell?.classList.contains('sidebar-collapsed')));
  $('toggle-side-panel')?.addEventListener('click', () => {
    if (!$('agents-panel')?.hidden) { write(LAST_PANEL_KEY, 'agents'); $('open-agents')?.click(); }
    else if (!$('git-panel')?.hidden) { write(LAST_PANEL_KEY, 'git'); $('open-git')?.click(); }
    else if (!$('brief-panel')?.hidden) { write(LAST_PANEL_KEY, 'brief'); window.relayBrief?.close(); }
    else if (!$('tasks-panel')?.hidden) { write(LAST_PANEL_KEY, 'tasks'); window.relayTasks?.close(); }
    else if (!$('review-panel')?.hidden) window.relayReviews?.closePanel?.();
    else { const last = read(LAST_PANEL_KEY); if (last === 'brief') window.relayBrief?.open(); else if (last === 'tasks') window.relayTasks?.open(); else $(last === 'git' ? 'open-git' : 'open-agents')?.click(); }
    sync();
  });
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(sync);
    for (const target of [...sidePanels(), shell].filter(Boolean)) observer.observe(target, { attributes: true, attributeFilter: ['hidden', 'disabled', 'class'] });
  }
  window.addEventListener('relay-state', sync);
  window.addEventListener('relay-side-panel', sync);
  sync();
  window.relayLayout = { reset: () => { for (const name of Object.keys(sections)) set(name, null); save(); }, toggleSidebar: () => { setSidebar(!shell?.classList.contains('sidebar-collapsed')); return true; }, sync };
})();

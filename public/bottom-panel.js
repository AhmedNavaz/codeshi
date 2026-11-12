(() => {
  'use strict';
  // The bottom panel holds the workspace's tools as tabs: Terminal, and Run for its dev servers, tests and scripts.
  // Both stay in the status bar, so they can be opened from there at any time; clicking the open one hides the
  // panel, and hiding never stops anything that runs in it. ⌘J (Ctrl+J elsewhere) shows or hides the panel, ⌃`
  // the terminal. The panel reopens as it was left, once a workspace is open.
  const $ = id => document.getElementById(id), panel = $('bottom-panel');
  if (!panel) return;
  const KEY = 'throughline:panel', LEGACY_KEY = 'throughline:terminal', TOOLS = ['terminal', 'run'];
  const content = { terminal: $('terminal-panel'), run: $('project-commands') };
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  let saved = null;
  try { saved = JSON.parse(read(KEY) || 'null'); } catch { saved = null; }
  // The terminal used to remember whether it was open on its own.
  if (!saved && read(LEGACY_KEY) === 'open') saved = { open: true, tool: 'terminal' };
  let active = TOOLS.includes(saved?.tool) ? saved.tool : 'terminal', reopen = saved?.open === true;

  function save() { try { localStorage.setItem(KEY, JSON.stringify({ open: !panel.hidden, tool: active })); } catch { /* A convenience only. */ } }
  function sync() {
    const open = !panel.hidden;
    for (const tool of TOOLS) {
      if (content[tool]) content[tool].hidden = !open || tool !== active;
      $(`bottom-tab-${tool}`)?.setAttribute('aria-selected', String(tool === active));
      // One stop in the Tab order for the strip: the tab showing. The arrow keys reach the others (#26).
      if ($(`bottom-tab-${tool}`)) $(`bottom-tab-${tool}`).tabIndex = tool === active ? 0 : -1;
      const tools = $(`${tool}-tools`); if (tools) tools.hidden = tool !== active;
      $(`status-${tool}`)?.setAttribute('aria-pressed', String(open && tool === active));
    }
  }
  function announce() { window.dispatchEvent(new CustomEvent('relay-panel', { detail: { open: !panel.hidden, tool: active } })); }
  function show(tool = active) {
    if (['flow', 'plan'].includes(window.relayFlow?.view?.())) return;
    if (!TOOLS.includes(tool)) return;
    const changed = panel.hidden || tool !== active;
    active = tool; panel.hidden = false; sync(); save();
    if (changed) announce();
  }
  function hide() {
    if (panel.hidden) return;
    panel.hidden = true; sync(); save(); announce();
    // Focus leaves the hidden panel for the message box.
    if (document.activeElement && panel.contains?.(document.activeElement)) $('message-input')?.focus();
  }
  // Without a tool, the panel shows or hides as it was; with one, that tool opens, or the panel hides if it is in front.
  function toggle(tool) { if (!panel.hidden && (!tool || tool === active)) hide(); else show(tool || active); }

  for (const tool of TOOLS) {
    $(`bottom-tab-${tool}`)?.addEventListener('click', () => show(tool));
    $(`status-${tool}`)?.addEventListener('click', () => toggle(tool));
  }
  $('bottom-hide')?.addEventListener('click', hide);
  // The tab strip moves with the arrow keys, as tabs do.
  panel.querySelector('.bottom-tabs')?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const next = event.key === 'Home' ? TOOLS[0] : event.key === 'End' ? TOOLS.at(-1) : TOOLS[(TOOLS.indexOf(active) + (event.key === 'ArrowRight' ? 1 : TOOLS.length - 1)) % TOOLS.length];
    event.preventDefault(); show(next); $(`bottom-tab-${next}`)?.focus();
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  document.addEventListener('keydown', event => {
    if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'j') return;
    // Ctrl keys typed in the terminal belong to the shell.
    if (!mac && event.target?.closest?.('#terminal-panel')) return;
    if (!window.relayUI?.getState().projectId) return;
    event.preventDefault(); toggle();
  });
  window.addEventListener('relay-state', () => {
    const projectId = window.relayUI?.getState().projectId;
    for (const tool of TOOLS) { const button = $(`status-${tool}`); if (button) button.disabled = !projectId; }
    if (!projectId) { if (!panel.hidden) { panel.hidden = true; sync(); announce(); } return; }
    if (reopen) { reopen = false; show(active); }
  });
  sync();
  window.relayPanel = { show, hide, toggle, isOpen: tool => !panel.hidden && (!tool || tool === active), active: () => active };
})();

(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI, shell = $('app-shell');
  if (!$('sidebar-switch') || !api) return;
  const views = ['workspaces', 'run', 'git'], panels = { workspaces: $('sidebar-workspaces'), run: $('sidebar-run'), git: $('git-panel') };
  let active = 'workspaces';
  try { const value = localStorage.getItem('throughline:sidebar-tool'); if (views.includes(value)) active = value; } catch { /* Optional layout. */ }
  const normal = () => !['flow', 'plan'].includes(window.relayFlow?.view?.());
  function sync() {
    const projectId = api.getState().projectId, on = normal();
    for (const view of views) {
      if (!panels[view].closest?.('#flow-detail-body')) panels[view].hidden = !on || active !== view;
      const button = $(`sidebar-tab-${view}`);
      button.setAttribute('aria-selected', String(active === view)); button.tabIndex = active === view ? 0 : -1;
      button.disabled = view !== 'workspaces' && !projectId;
    }
    $('project-commands').hidden = !on || active !== 'run';
    $('status-run')?.setAttribute('aria-pressed', String(active === 'run' && on));
    $('status-terminal')?.setAttribute('aria-pressed', String(on && Boolean(window.relayTerminal?.isOpen?.())));
    if (!panels.git.closest?.('#flow-detail-body')) $('open-git')?.setAttribute('aria-expanded', String(active === 'git' && on));
    for (const id of ['status-terminal', 'status-run']) if ($(id)) $(id).disabled = !projectId;
  }
  function show(view = 'workspaces') {
    if (!views.includes(view) || !normal() || view !== 'workspaces' && !api.getState().projectId) return;
    active = view;
    if (shell?.classList.contains('sidebar-collapsed')) window.relayLayout?.toggleSidebar();
    try { localStorage.setItem('throughline:sidebar-tool', active); } catch { /* Optional layout. */ }
    sync();
    window.dispatchEvent(new CustomEvent('relay-sidebar', { detail: { view: active, tool: active } }));
    if (active === 'run') window.dispatchEvent(new CustomEvent('relay-panel', { detail: { open: true, tool: 'run' } }));
  }
  for (const view of views) $(`sidebar-tab-${view}`).addEventListener('click', () => show(view));
  $('sidebar-switch').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const enabled = views.filter(view => !$(`sidebar-tab-${view}`).disabled), index = enabled.indexOf(active);
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(index + (event.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
    event.preventDefault(); show(next); $(`sidebar-tab-${next}`)?.focus();
  });
  $('status-run')?.addEventListener('click', () => show(active === 'run' ? 'workspaces' : 'run'));
  $('status-terminal')?.addEventListener('click', () => window.relayTerminal?.toggle ? window.relayTerminal.toggle() : window.relayTerminal?.open());
  // Compatibility for command-palette and Flow callers. There is no bottom panel.
  const showTool = tool => tool === 'terminal' ? window.relayTerminal?.open() : show('run');
  window.relayPanel = {
    show: showTool,
    hide: () => { if (active === 'run') show('workspaces'); window.relayTabs?.showChat(); },
    toggle: tool => tool === 'run' ? show(active === 'run' ? 'workspaces' : 'run') : window.relayTerminal?.toggle ? window.relayTerminal.toggle() : showTool('terminal'),
    isOpen: tool => normal() && (tool === 'run' ? active === 'run' : tool === 'terminal' ? Boolean(window.relayTerminal?.isOpen()) : active === 'run' || Boolean(window.relayTerminal?.isOpen())),
    active: () => window.relayTerminal?.isOpen() ? 'terminal' : active === 'run' ? 'run' : null,
  };
  window.relaySidebar = { show, hide: () => show('workspaces'), active: () => active, sync };
  window.addEventListener('relay-state', () => { if (!api.getState().projectId) active = 'workspaces'; sync(); });
  window.addEventListener('relay-flow', sync);
  window.addEventListener('relay-tabs', sync);
  sync();
})();

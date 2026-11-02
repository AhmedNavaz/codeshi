(() => {
  'use strict';
  // The desktop menu bar runs the page's commands and shows what the page offers: the items that can be used now,
  // the selected agent, the Files and Git activity ticks and the workspaces ⌘1–9 select.
  const $ = id => document.getElementById(id), bridge = window.relayDesktop, api = window.relayUI;
  // The copy run from source is labelled, so it is never mistaken for the installed app.
  if ($('build-channel')) $('build-channel').hidden = bridge?.channel !== 'development';
  if (!bridge?.onMenuCommand || !bridge?.setMenuState) return;
  const usable = id => { const control = $(id); return Boolean(control && !control.hidden && !control.disabled); };
  let sent = '', scheduled = false;
  function report() {
    scheduled = false;
    const state = api.getState(), offered = !$('continuation').hidden && !$('continue-button').disabled;
    const menu = {
      workspace: Boolean(state.projectId), running: api.isRunning(), agent: state.provider, codex: usable('select-codex'), claude: usable('select-claude'), gemini: usable('select-gemini'),
      continue: offered ? state.continuationProvider || state.provider : null, files: !$('file-tree').hidden, git: !$('git-panel').hidden, terminal: Boolean($('terminal-panel') && !$('terminal-panel').hidden),
      imports: usable('open-import'), export: usable('open-export'),
      // The menu takes names of up to 120 characters, the longest a workspace can be renamed to.
      workspaces: api.filteredProjects().slice(0, 9).map(project => ({ name: project.name.slice(0, 120) || 'Workspace', current: project.id === state.projectId })),
    };
    const signature = JSON.stringify(menu);
    if (signature !== sent) { sent = signature; bridge.setMenuState(menu); }
  }
  // A report waits for the other handlers of the same event, so it sees what they changed.
  const schedule = () => { if (!scheduled) { scheduled = true; Promise.resolve().then(report); } };
  window.addEventListener('relay-state', schedule);
  // These change what the menu shows without a relay-state event.
  for (const [id, type] of [['toggle-explorer', 'click'], ['open-git', 'click'], ['toggle-side-panel', 'click'], ['workspace-search', 'input'], ['workspace-search', 'keydown']]) $(id)?.addEventListener(type, schedule);
  // The bottom panel says when it shows or hides, or changes tab, however that happened.
  window.addEventListener('relay-panel', schedule);
  const unsubscribe = bridge.onMenuCommand((name, value) => { if (Object.hasOwn(api.commands, name)) api.commands[name](value); });
  window.addEventListener('beforeunload', () => unsubscribe?.());
  report();
})();

(() => {
  'use strict';
  const button = document.getElementById('keep-awake'), label = document.getElementById('keep-awake-label'), bridge = window.relayDesktop;
  if (!bridge?.getKeepAwake || !bridge?.setKeepAwake) return;
  let state = {enabled:false,active:false,runningCount:0}, pending = false;
  function render(next) {
    if (next) state = next;
    button.hidden = false; button.disabled = pending;
    button.dataset.state = state.error ? 'error' : state.active ? 'active' : state.enabled ? 'armed' : 'off';
    label.textContent = state.error ? 'Keep awake · Error' : state.active ? 'Keep awake · On' : state.enabled ? 'Keep awake · Auto' : 'Keep awake · Off';
    button.setAttribute('aria-pressed',String(state.enabled));
    button.setAttribute('aria-busy',String(pending));
    button.title = state.error ? state.error : state.active ? `Keeping the display awake for ${state.runningCount} active ${state.runningCount === 1 ? 'agent' : 'agents'}. Click to turn off.` : state.enabled ? 'Enabled. The display will stay awake while any workspace has a running agent. Currently idle; normal display sleep is allowed.' : 'Keep the display awake while agents are working in any workspace. Currently off.';
    button.setAttribute('aria-label',label.textContent + '. ' + button.title);
  }
  const unsubscribe = bridge.onKeepAwakeChanged?.(next => render(next));
  bridge.getKeepAwake().then(render).catch(error => render({...state,error:error.message || 'Could not read display sleep settings.'}));
  button.addEventListener('click',async()=>{
    if(pending)return;
    pending = true; render();
    try { render(await bridge.setKeepAwake(!state.enabled)); }
    catch(error) { window.relayUI?.showNotice('Could not update keep awake. ' + (error.message || 'Try again.')); }
    finally { pending = false; render(); }
  });
  window.addEventListener('beforeunload',()=>unsubscribe?.());
})();

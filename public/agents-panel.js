(() => {
  'use strict';
  // The Agents panel holds two settings: Routing (Auto, #12, #128), which chooses the agent, model and effort for each
  // message and belongs to Flow (#107), so its section shows there and the normal view says so instead; and Handoff
  // (#17), which moves a running task to another agent before a usage limit. While routing is on, the model button in
  // the message box shows the mode and opens Routing here. One side panel shows at a time; the last one chosen is
  // remembered, and Agents opens on first launch.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('agents-panel'), button = $('open-agents');
  if (!panel || !api) return;
  const PANEL_KEY = 'throughline:side-panel';
  // Three modes: Flow always routes, so there is no manual one; leaving Flow is how you choose by hand again.
  const options = [
    { mode: 'saver', name: 'Saver', hint: 'Local rules only; uses light and standard models at low effort and spends allowance where it resets soonest.' },
    { mode: 'smart', name: 'Smart', hint: 'Matches the model and effort to each message, and spends allowance where it resets soonest.' },
    { mode: 'ultra', name: 'Ultra', hint: 'Strongest models and deepest effort first; steps down one tier only when needed.' },
  ];
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const routing = () => api.getState().conversation?.routing || null;
  let busy = false, preferences = null, testCommand, testScope = null;

  function error(message) { $('agents-error').textContent = message || ''; $('agents-error').hidden = !message; }
  async function choose(choice) {
    if (busy) return;
    busy = true; render();
    try { await api.setRouting(choice); error(''); }
    catch (failure) { error(failure.message); api.showNotice?.(failure.message); }
    finally { busy = false; render(); }
  }

  // The answers to "who answers each message", as radio rows with a line on what each does.
  function renderOptions(host) {
    const current = routing(), currentMode = window.relayRouting?.normalizeMode?.(current?.mode) || current?.mode || null, locked = busy || !api.getState().projectId || api.isRunning();
    host.replaceChildren(...options.map(option => {
      const selected = currentMode === option.mode, row = node('button', 'routing-option');
      row.type = 'button'; row.disabled = locked;
      row.setAttribute('role', 'radio'); row.setAttribute('aria-checked', String(selected));
      row.dataset.mode = option.mode;
      const text = node('span', 'routing-option-text');
      text.append(node('strong', '', option.name), node('small', '', option.hint));
      row.append(node('span', 'routing-option-mark'), text);
      row.addEventListener('click', () => { if (!selected) choose({ mode: option.mode, allowApi: current?.allowApi === true, check: current?.check === true }); });
      return row;
    }));
  }

  // Check with tests (#12) uses the command marked for it in Run, so the panel says which one, or that none is marked.
  async function loadTestCommand() {
    const projectId = api.getState().projectId;
    if (!projectId) { testCommand = undefined; testScope = null; return; }
    testScope = projectId;
    try { const value = await api.api('/api/commands', {}, projectId); if (testScope === projectId) testCommand = value.commands?.find?.(command => command.test)?.command || null; }
    catch { if (testScope === projectId) testCommand = undefined; }
    render();
  }
  // How checked runs went: passed first time, passed after a retry, or still failing, from the conversation's history.
  function checkStats() {
    const runs = api.getState().conversation?.runs || [], checked = runs.filter(run => run.check && !run.retryOf && ['passed', 'failed'].includes(run.check.status));
    if (!checked.length) return '';
    const retries = new Map(runs.filter(run => run.retryOf).map(run => [run.retryOf, run]));
    let first = 0, after = 0, failing = 0;
    for (const run of checked) { if (run.check.status === 'passed') first++; else if (retries.get(run.id)?.check?.status === 'passed') after++; else failing++; }
    return [`Last ${checked.length} checked run${checked.length === 1 ? '' : 's'}: ${first} passed first time`, after ? `${after} after a retry` : '', failing ? `${failing} still failing` : ''].filter(Boolean).join(', ') + '.';
  }

  async function loadPreferences() {
    try { preferences = await api.api('/api/handoff-preferences'); } catch { preferences = null; }
    render();
  }
  async function savePreferences(patch) {
    try { preferences = await api.post('/api/handoff-preferences', patch); error(''); }
    catch (failure) { error(failure.message); }
    render();
  }

  function render() {
    const state = api.getState(), current = routing(), flow = window.relayFlow?.isOn?.() === true;
    // In Flow, handoff follows the routing mode, so its settings step aside with the normal view.
    $('agents-routing').hidden = !flow; $('agents-routing-note').hidden = flow; $('agents-handoff').hidden = flow;
    if (panel.hidden) return;
    renderOptions($('routing-options'));
    $('routing-api-row').hidden = !current;
    $('routing-allow-api').checked = current?.allowApi === true;
    $('routing-allow-api').disabled = busy || api.isRunning();
    $('routing-check-row').hidden = !current;
    $('routing-check').checked = current?.check === true;
    $('routing-check').disabled = busy || api.isRunning() || !testCommand && current?.check !== true;
    $('routing-check-hint').textContent = testCommand === undefined ? 'After a run that changes files, runs this workspace’s test command. If the tests fail, routing retries once, one step up.'
      : testCommand ? `After a run that changes files, runs ${testCommand}. If the tests fail, routing retries once, one step up.` : 'Needs a test command. Choose one in Run.';
    $('routing-check-set').hidden = testCommand !== null;
    const stats = current?.check ? checkStats() : '';
    $('routing-check-stats').hidden = !stats; $('routing-check-stats').textContent = stats;
    $('handoff-threshold').value = String(preferences?.threshold ?? 90);
    $('handoff-threshold').disabled = !preferences;
    $('handoff-automatic').checked = preferences?.automatic === true;
    $('handoff-automatic').disabled = !preferences || preferences.threshold === 0;
  }

  const remember = value => { try { localStorage.setItem(PANEL_KEY, value); } catch { /* The panel choice is a convenience. */ } };
  const preferred = () => { try { return localStorage.getItem(PANEL_KEY) || 'agents'; } catch { return 'agents'; } };
  // Plan usage lists Ollama when it has models downloaded (#99). This only reads what's installed: nothing is downloaded and
  // no model runs. With no Ollama there's simply no row.
  let localRequest = 0;
  async function loadLocalRow() {
    const row = $('ollama-status'), projectId = api.getState().projectId, request = ++localRequest;
    if (!row) return;
    if (!projectId) { row.hidden = true; return; }
    try { const result = await api.api('/api/local-models', {}, projectId); if (request === localRequest) row.hidden = !(result.models?.length || result.excluded); }
    catch { if (request === localRequest) row.hidden = true; }
  }
  // Opening the panel; it shares the right-hand side with Git activity and reviews.
  function setOpen(open, section = null, keep = true) {
    panel.hidden = !open; button.setAttribute('aria-expanded', String(open));
    if (keep) remember(open ? 'agents' : 'none');
    window.dispatchEvent(new CustomEvent('relay-side-panel'));
    if (open) {
      window.relayGit?.close();
      window.relayReviews?.closePanel?.(); window.relayTimeline?.close();
      window.relayBrief?.close(); window.relayTasks?.close();
      loadPreferences();
      loadLocalRow();
      loadTestCommand();
      render();
      if (section) { const target = $(`agents-${section}`); target?.scrollIntoView?.({ block: 'start' }); target?.classList.add('flash'); setTimeout(() => target?.classList.remove('flash'), 1200); }
    }
  }
  button.addEventListener('click', () => setOpen(panel.hidden));
  $('routing-allow-api').addEventListener('change', () => { const current = routing(); if (current) choose({ mode: current.mode, allowApi: $('routing-allow-api').checked, check: current.check === true }); });
  $('routing-check').addEventListener('change', () => { const current = routing(); if (current) choose({ mode: current.mode, allowApi: current.allowApi === true, check: $('routing-check').checked }); });
  $('routing-check-set').addEventListener('click', () => window.relayCommands?.open({ test: true }));
  // A test command chosen in Run shows here at once.
  window.addEventListener('relay-commands', event => { if (event.detail?.projectId === api.getState().projectId) { testCommand = event.detail.commands?.find?.(command => command.test)?.command || null; render(); } });
  $('handoff-threshold').addEventListener('change', () => savePreferences({ threshold: Number($('handoff-threshold').value) }));
  $('handoff-automatic').addEventListener('change', () => savePreferences({ automatic: $('handoff-automatic').checked }));
  // Turned on from the offer at a usage limit.
  window.addEventListener('relay-handoff-preferences', () => { if (!panel.hidden) loadPreferences(); });
  // Routing shows in Flow and steps aside in the normal view.
  window.addEventListener('relay-flow', render);
  // The overview in a new conversation links to the matching part of the panel.
  document.querySelectorAll('[data-agents]').forEach(link => link.addEventListener('click', () => setOpen(true, link.dataset.agents)));
  // On a docked layout, a workspace opens with the side panel last chosen, Agents at first.
  let lastProject = null;
  window.addEventListener('relay-state', () => {
    const projectId = api.getState().projectId;
    if (projectId !== lastProject) {
      lastProject = projectId;
      if (!panel.hidden) loadTestCommand();
      if (!projectId) setOpen(false, null, false);
      else if (panel.hidden && preferred() === 'agents' && window.matchMedia?.('(min-width: 1101px)').matches) setOpen(true, null, false);
    }
    render();
  });
  // Memory, skills and the brief live in the Brief panel, and tasks and limits in the Tasks panel; older links still work.
  const elsewhere = { memory: () => window.relayBrief?.open('memory'), skills: () => window.relayBrief?.open('skills'), brief: () => window.relayBrief?.open(), tasks: () => window.relayTasks?.open(), limits: () => window.relayTasks?.open('limits') };
  window.relayAgents = { open: section => elsewhere[section] ? elsewhere[section]() : setOpen(true, section), close: () => { if (!panel.hidden) setOpen(false, null, false); }, isOpen: () => !panel.hidden };
  render();
})();

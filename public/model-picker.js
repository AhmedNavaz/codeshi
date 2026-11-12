(() => {
  'use strict';
  const { t } = window.codeshiText;
  // One searchable menu for every agent: a section per agent, compact rows and "More models" for the long tail.
  // Reasoning effort has its own control beside it, because the levels depend on the model chosen here.
  const $ = id => document.getElementById(id), api = window.relayUI, popup = $('model-picker-popover'), trigger = $('model-picker-button');
  const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', local: t('Local · Ollama') }, cache = new Map(), loadingAgents = new Set(), failures = new Map();
  const shortList = 4;
  let scope = null, saving = false, failure = '', query = '', active = -1;
  // Another control can open the same menu for its own purpose, such as choosing who continues a stopped task.
  let purpose = null;
  let preloadedProject = null;
  const expanded = new Set();

  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const open = () => popup?.matches?.(':popover-open');
  const choices = select => [...(select?.options || select?.children || [])];
  const modelId = row => row.id || row.model || row.value || '';
  const modelName = row => row.displayName || row.name || modelId(row) || 'Auto';
  const effortName = text => String(text || '').replace(/ \(saved\)$/, '');
  // Effort levels by their value, in the interface language (#27); the select's own English labels stay as they are.
  const LEVELS = { none: t('None'), minimal: t('Minimal'), low: t('Low'), medium: t('Medium'), high: t('High'), xhigh: t('X-High'), max: t('Max'), ultra: t('Ultra') };
  const levelName = option => LEVELS[option?.value] || effortName(option?.textContent);

  function position() {
    if (!open()) return;
    const anchor = (purpose?.anchor || trigger).getBoundingClientRect(), width = Math.min(320, window.innerWidth - 24);
    popup.style.width = width + 'px';
    popup.style.left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) + 'px';
    popup.style.bottom = Math.max(12, window.innerHeight - anchor.top + 8) + 'px';
    // The list scrolls inside the menu, so the effort submenu can open beside it.
    popup.style.setProperty?.('--picker-list-max', Math.max(160, Math.min(360, anchor.top - 150)) + 'px');
  }

  function close() { if (open()) popup.hidePopover(); (purpose?.anchor || trigger).setAttribute('aria-expanded', 'false'); purpose = null; }

  function selectedRow(provider) {
    const state = api.getState(), rows = cache.get(state.projectId + ':' + provider)?.models || [];
    return rows.find(row => modelId(row) === state.model);
  }
  const routing = () => { const state = api.getState(); return state.localSelections?.[state.projectId] ? null : state.conversation?.routing || null; };
  function label() {
    const state = api.getState(), local = state.localSelections?.[state.projectId], actual = local ? 'local' : state.provider, auto = routing();
    // While routing is on, the button shows the mode instead of a model and opens Routing in the Agents panel.
    $('picked-agent').textContent = auto ? 'Routing' : names[actual];
    $('picked-model').textContent = auto ? window.relayRouting?.modeNames[auto.mode] || t('Auto') : local?.model || (state.model ? modelName(selectedRow(state.provider) || { id: state.model }) : t('Default'));
    $('picked-agent-icon').className = 'agent-icon ' + (auto ? 'auto' : actual === 'local' ? 'codex' : actual);
    trigger.classList.toggle('routing', Boolean(auto));
    trigger.disabled = !state.ready || !state.projectId || Boolean(state.pending || state.settingsPending);
    trigger.setAttribute('aria-label', auto ? t('Routing: {model}. Change it in the Agents panel.', { model: $('picked-model').textContent }) : t('Choose agent and model. Current: {agent}, {model}', { agent: names[actual], model: $('picked-model').textContent }));
    trigger.title = auto ? t('Routing picks the agent, model and effort for each message. Click to change it.') : '';
    if (local) {
      $('model-description').textContent = t('Local · {model} · Downloaded model · No cloud model charges', { model: local.model });
      $('effort-select').disabled = true;
    }
    if (open() && scope !== state.projectId) close();
    effortControl();
    if (state.projectId && state.projectId !== preloadedProject) {
      preloadedProject = state.projectId;
      preloadAll(state.projectId);
    }
  }

  // Agents in menu order: the one in use first, then the others, then local models.
  function agentOrder() {
    const state = api.getState(), current = purpose?.first || (state.localSelections?.[scope] ? 'local' : state.provider);
    return [current, ...['codex', 'claude', 'gemini', 'local'].filter(value => value !== current)].filter(value => !(purpose?.excludeLocal && value === 'local'));
  }
  function installed(provider) {
    const state = api.getState();
    if (provider === 'local') return cache.get(scope + ':local')?.installed;
    return state.status?.providers?.[provider]?.available || state.accounts?.[provider]?.available || state.accounts?.[provider]?.installed;
  }
  function rowsFor(provider) {
    const data = cache.get(scope + ':' + provider);
    if (provider === 'local') return (data?.models || []).map(row => ({ ...row, tag: row.parameterSize || '' }));
    const reported = (data?.models || []).filter(row => row.value !== 'default').map(row => ({ ...row, tag: row.isDefault ? 'Default' : '' }));
    // The agent's own default, named so it isn't confused with Codeshi's Auto above.
    return [{ id: '', displayName: t('Let {agent} choose', { agent: names[provider] }), description: t('{agent} uses its default model', { agent: names[provider] }), tag: '' }, ...reported];
  }
  function isSelected(provider, row) {
    const state = api.getState(), local = state.localSelections?.[scope];
    return provider === 'local' ? local?.model === modelId(row) && local.digest === row.digest : !local && state.provider === provider && (state.model || '') === modelId(row);
  }
  const matches = (provider, row) => !query || [modelName(row), modelId(row), row.description, names[provider]].some(text => String(text || '').toLowerCase().includes(query));

  function optionRow(provider, row) {
    const state = api.getState(), selected = isSelected(provider, row), choice = node('button', undefined, 'picker-row model-choice');
    choice.type = 'button';
    choice.setAttribute('role', 'option');
    choice.setAttribute('aria-selected', String(selected));
    choice.setAttribute('aria-pressed', String(selected));
    choice.dataset.nav = 'true';
    choice.title = row.description && row.description !== modelId(row) ? row.description : modelId(row) || row.description || '';
    const busyAgent = api.isRunning() && provider !== (state.localSelections?.[scope] ? 'local' : state.provider); choice.disabled = Boolean(saving || busyAgent); if (busyAgent) choice.title = t('Stop the current run before switching assistants.');
    const check = node('span', undefined, 'picker-row-check'); check.setAttribute('aria-hidden', 'true');
    choice.append(node('span', modelName(row), 'picker-row-name'), node('span', row.tag || '', 'picker-row-tag'), check);
    choice.addEventListener('click', () => choose(provider, row));
    return choice;
  }

  function render() {
    const state = api.getState(), host = $('picker-models');
    if (!host) return;
    host.replaceChildren();
    if ($('picker-status')) $('picker-status').textContent = failure;
    let shown = 0;
    for (const provider of agentOrder()) {
      const header = node('div', undefined, 'picker-section'), icon = node('i', undefined, 'agent-icon ' + (provider === 'local' ? 'codex' : provider));
      icon.setAttribute('aria-hidden', 'true');
      header.setAttribute('role', 'presentation');
      header.append(icon, node('span', names[provider], 'picker-section-name'));
      const note = node('span', '', 'picker-section-note'); header.append(note);
      const section = [];
      if (loadingAgents.has(provider) && !cache.has(scope + ':' + provider)) note.textContent = t('Loading…');
      else if (!installed(provider)) {
        note.textContent = provider === 'local' ? t('Not set up') : t('Not connected');
        if (!query) {
          const setup = node('button', undefined, 'picker-row picker-setup');
          // Every row in the list is an option, so a screen reader counts and reads them as the list it is (#26).
          setup.type = 'button'; setup.dataset.nav = 'true'; setup.setAttribute('role', 'option'); setup.setAttribute('aria-selected', 'false');
          setup.append(node('span', provider === 'local' ? t('Set up local models…') : t('Connect {agent}…', { agent: names[provider] }), 'picker-row-name'));
          setup.addEventListener('click', () => { close(); if (provider === 'local') window.relayLocal?.open(); else if (window.relaySettings) window.relaySettings.open('accounts'); else $('relay-settings')?.click(); });
          section.push(setup);
        }
      } else {
        if (failures.has(provider)) note.textContent = t('Could not load models');
        const rows = rowsFor(provider).filter(row => matches(provider, row));
        // Without a search the list shows a few models per agent, always including the chosen one.
        const visible = query || expanded.has(provider) ? rows : rows.filter((row, index) => index < shortList || isSelected(provider, row));
        section.push(...visible.map(row => optionRow(provider, row)));
        if (visible.length < rows.length) {
          const more = node('button', undefined, 'picker-row picker-more');
          more.type = 'button'; more.dataset.nav = 'true'; more.setAttribute('role', 'option'); more.setAttribute('aria-selected', 'false');
          more.append(node('span', provider === 'local' ? t('More Local models') : t('More {agent} models', { agent: names[provider] }), 'picker-row-name'), node('span', String(rows.length - visible.length), 'picker-row-tag'));
          more.addEventListener('click', () => { expanded.add(provider); render(); highlight(more.dataset.index ? +more.dataset.index : active); });
          section.push(more);
        }
        if (!rows.length && !query) note.textContent = provider === 'local' ? t('No downloaded models') : t('No models reported');
      }
      if (query && !section.length) continue;
      host.append(header, ...section);
      shown += section.length;
    }
    if (!shown) host.append(node('p', query ? t('No models match your search.') : t('No agents are connected yet.'), 'picker-empty'));
    navRows().forEach((row, index) => { row.dataset.index = String(index); row.id = 'picker-row-' + index; row.addEventListener('mouseenter', () => highlight(index, false)); });
    highlight(Math.min(Math.max(active, 0), navRows().length - 1), false);
  }

  // Arrow keys move a highlight through the rows while focus stays in the search field.
  const navRows = () => [...($('picker-models')?.querySelectorAll('.picker-row') || [])].filter(row => row.dataset.nav === 'true' && !row.disabled);
  function highlight(index, scroll = true) {
    const rows = navRows();
    active = rows.length ? (index + rows.length) % rows.length : -1;
    rows.forEach((row, position) => row.classList.toggle('active', position === active));
    const current = rows[active];
    if (current) { $('picker-search')?.setAttribute('aria-activedescendant', current.id); if (scroll) current.scrollIntoView?.({ block: 'nearest' }); }
  }

  // Reasoning effort: its own control beside the model, because the levels depend on the model. The button shows the
  // level as signal bars; the panel is a slider over the levels the model supports, with Auto for the agent's default.
  // The hidden effort select remains the source of truth and saves the choice.
  const effortButton = $('effort-button'), effortPopup = $('effort-popover'), range = $('effort-range');
  const effortOpen = () => effortPopup?.matches?.(':popover-open');
  const hints = { none: t('No extra reasoning'), minimal: t('Quickest replies, almost no reasoning'), low: t('Fast replies with light reasoning'), medium: t('Balanced speed and depth'), high: t('Deeper reasoning for harder tasks'), xhigh: t('Extended reasoning for complex work'), max: t('Most thorough; slowest and uses the most allowance') };
  const autoNotes = {
    claude: t('Claude uses the model’s default level and decides on each step how much to think.'),
    gemini: t('Gemini adjusts its thinking to each prompt.'),
    codex: t('Codex uses its default level for every prompt.'),
  };
  const effortLevels = () => choices($('effort-select')).filter(option => option.value);
  const agentDefault = () => choices($('effort-select')).find(option => !option.value)?.textContent.match(/\((\w+)\)/)?.[1] || '';
  function bars(host, filled, total) {
    host.replaceChildren(...Array.from({ length: Math.max(total, 3) }, (_, index) => node('i', undefined, index < filled ? 'on' : '')));
  }
  function effortControl() {
    const state = api.getState(), select = $('effort-select');
    if (!effortButton || !select) return;
    const levels = effortLevels(), index = levels.findIndex(option => option.value === select.value);
    // Under Auto the effort is chosen with the model for each message.
    effortButton.hidden = Boolean(state.localSelections?.[state.projectId]) || Boolean(routing()) || select.dataset.supported !== 'true' || !levels.length;
    effortButton.disabled = select.disabled;
    bars($('effort-bars'), index >= 0 ? index + 1 : 0, levels.length);
    effortButton.dataset.level = index >= 0 ? levels[index].value : 'auto';
    $('effort-button-label').textContent = index >= 0 ? levelName(levels[index]) : t('Default');
    effortButton.title = index >= 0 ? t('Reasoning effort: {level}', { level: levelName(levels[index]) }) : t('Reasoning effort: the agent’s default');
    effortButton.setAttribute('aria-label', effortButton.title);
    if (effortButton.hidden && effortOpen()) effortPopup.hidePopover();
    if (effortOpen()) renderEffortPanel();
  }
  // Shows a level in the panel without saving it, so dragging previews before the choice is committed.
  function showLevel(index) {
    const levels = effortLevels(), auto = $('effort-auto').checked, level = levels[index];
    effortPopup.dataset.level = auto ? 'auto' : level?.value || 'auto';
    range.value = String(index);
    range.style.setProperty?.('--fill', levels.length > 1 ? (index / (levels.length - 1)) * 100 + '%' : '0%');
    range.setAttribute('aria-valuetext', level ? levelName(level) : t('Agent default'));
    $('effort-stops').querySelectorAll('button').forEach((stop, position) => stop.setAttribute('aria-pressed', String(!auto && position === index)));
    const unknown = effortPopup.classList.contains('unknown');
    $('effort-ticks').querySelectorAll('i').forEach((tick, position) => { tick.hidden = !unknown && position === index; tick.classList.toggle('passed', !unknown && position < index); });
    const provider = api.getState().provider, fallback = agentDefault();
    $('effort-hint').textContent = auto ? (provider === 'codex' && fallback ? t('Codex uses its default, {level}, for every prompt.', { level: LEVELS[fallback] || effortName(fallback[0].toUpperCase() + fallback.slice(1)) }) : autoNotes[provider] || t('The agent uses its default level.')) : hints[level?.value] || t('Reasoning level reported by the model');
    $('effort-stops').querySelectorAll('button').forEach((stop, position) => stop.classList.toggle('agent-default', auto && levels[position]?.value === fallback));
  }
  function renderEffortPanel() {
    const select = $('effort-select'), levels = effortLevels(), selected = levels.findIndex(option => option.value === select.value);
    const auto = selected < 0;
    // Auto leaves the level to the agent, so the slider shows no position; moving it chooses a level.
    effortPopup.classList.toggle('unknown', auto);
    $('effort-auto').checked = auto;
    $('effort-auto').disabled = select.disabled;
    range.max = String(Math.max(0, levels.length - 1));
    range.disabled = select.disabled;
    effortPopup.classList.toggle('auto', auto);
    $('effort-ticks').replaceChildren(...levels.map((_, index) => { const tick = node('i'); tick.style.left = levels.length > 1 ? `calc(8px + (100% - 16px) * ${index / (levels.length - 1)})` : '8px'; return tick; }));
    $('effort-stops').replaceChildren(...levels.map((option, index) => {
      const stop = node('button', levelName(option));
      stop.type = 'button';
      stop.tabIndex = -1;
      stop.style.left = levels.length > 1 ? `calc(8px + (100% - 16px) * ${index / (levels.length - 1)})` : '8px';
      stop.addEventListener('click', () => commit(index));
      return stop;
    }));
    showLevel(auto ? Math.max(0, Math.floor((levels.length - 1) / 2)) : selected);
  }
  function commit(index) {
    const select = $('effort-select'), level = index === null ? '' : effortLevels()[index]?.value;
    if (level === undefined || select.disabled) return;
    if (select.value !== level) { select.value = level; select.dispatchEvent(new Event('change', { bubbles: true })); }
    renderEffortPanel();
  }
  range?.addEventListener('input', () => { $('effort-auto').checked = false; effortPopup.classList.remove('auto', 'unknown'); showLevel(+range.value); });
  range?.addEventListener('change', () => commit(+range.value));
  $('effort-auto')?.addEventListener('change', () => commit($('effort-auto').checked ? null : +range.value));
  effortButton?.addEventListener('click', () => {
    if (effortOpen()) { effortPopup.hidePopover(); return; }
    effortPopup.showPopover();
    renderEffortPanel();
    const anchor = effortButton.getBoundingClientRect();
    effortPopup.style.left = Math.max(12, Math.min(anchor.left, window.innerWidth - 292)) + 'px';
    effortPopup.style.bottom = Math.max(12, window.innerHeight - anchor.top + 8) + 'px';
    range.focus?.();
  });
  effortPopup?.addEventListener('toggle', () => effortButton.setAttribute('aria-expanded', String(effortOpen())));
  effortPopup?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); effortPopup.hidePopover(); effortButton.focus(); } });
  // The levels are rebuilt whenever the model changes, sometimes after its list loads; the control follows them.
  if (typeof MutationObserver === 'function' && $('effort-select')) new MutationObserver(effortControl).observe($('effort-select'), { childList: true, attributes: true, attributeFilter: ['disabled', 'data-supported'] });
  $('effort-select')?.addEventListener('change', effortControl);

  async function fetchModels(projectId, provider) {
    loadingAgents.add(provider);
    try {
      const data = await api.api(provider === 'local' ? '/api/local-models' : `/api/providers/${provider}/models`, {}, projectId);
      cache.set(projectId + ':' + provider, data); cache.set(projectId + ':' + provider + ':time', Date.now()); failures.delete(provider);
    } catch (error) { failures.set(provider, error.message); }
    finally { loadingAgents.delete(provider); if (open() && scope === projectId) render(); label(); }
  }
  async function preloadAll(projectId) {
    if (!projectId) return;
    const missing = ['codex', 'claude', 'gemini', 'local'].filter(provider => !cache.has(projectId + ':' + provider));
    await Promise.all(missing.map(provider => fetchModels(projectId, provider)));
  }
  // Opening the menu shows what is known at once and refreshes model lists older than a minute in the background.
  function refreshStale() {
    for (const provider of ['codex', 'claude', 'gemini', 'local']) {
      const key = scope + ':' + provider;
      if (!loadingAgents.has(provider) && (!cache.has(key) || Date.now() - (cache.get(key + ':time') || 0) > 60000)) fetchModels(scope, provider);
    }
  }

  async function choose(provider, row) {
    if (saving || scope !== api.getState().projectId) return;
    const projectId = scope;
    saving = true; failure = ''; render();
    try {
      if (provider === 'local') api.selectLocalModel({ model: modelId(row), digest: row.digest });
      else await api.selectAgentModel(provider, modelId(row) || null);
      if (projectId === api.getState().projectId) {
        const chosen = purpose?.onChoose;
        close();
        if (chosen) await chosen(provider); else $('message-input')?.focus();
      }
    } catch (error) {
      failure = error.message;
    } finally {
      saving = false; label(); if (open()) render();
    }
  }

  function show(anchor = trigger, options = {}) {
    if (open()) { const same = (purpose?.anchor || trigger) === anchor; close(); if (same) return; }
    const state = api.getState();
    purpose = anchor === trigger ? null : { ...options, anchor };
    scope = state.projectId; query = ''; active = -1; failure = ''; expanded.clear();
    if ($('picker-search')) $('picker-search').value = '';
    if ($('picker-custom')) $('picker-custom').hidden = true;
    if ($('picker-title')) { $('picker-title').textContent = purpose?.title || ''; $('picker-title').hidden = !purpose?.title; }
    popup.showPopover();
    anchor.setAttribute('aria-expanded', 'true');
    position(); render();
    const selected = navRows().findIndex(row => row.getAttribute('aria-selected') === 'true');
    highlight(selected >= 0 ? selected : 0);
    $('picker-search')?.focus();
    refreshStale();
  }
  trigger.addEventListener('click', () => { if (routing()) { close(); window.relayAgents?.open('routing'); } else show(trigger); });

  $('picker-search')?.addEventListener('input', () => { query = $('picker-search').value.trim().toLowerCase(); active = 0; render(); });
  $('picker-search')?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(active + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter') { event.preventDefault(); navRows()[active]?.click(); }
  });

  $('picker-custom-button')?.addEventListener('click', () => {
    const custom = $('picker-custom'); if (!custom) return;
    custom.hidden = !custom.hidden;
    if (!custom.hidden) $('picker-custom-id')?.focus();
  });
  const saveCustom = () => {
    const id = $('picker-custom-id')?.value.trim(), state = api.getState();
    if (id && id.length <= 200) choose(state.provider, { id });
  };
  $('picker-custom-save')?.addEventListener('click', saveCustom);
  $('picker-custom-id')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveCustom(); } });

  popup.addEventListener('toggle', () => { (purpose?.anchor || trigger).setAttribute('aria-expanded', String(open())); if (!open()) purpose = null; });
  window.addEventListener('resize', position);
  window.addEventListener('relay-state', label);
  label();
  document.documentElement.classList.add('rich-model-picker');
  window.relayModelPicker = {
    open: () => show(trigger), close,
    // Opens the menu from another control; choosing selects the agent and model, then calls onChoose.
    openFor: (anchor, options) => show(anchor, options),
    // The models an agent has reported for this workspace, for Auto.
    models: provider => cache.get(api.getState().projectId + ':' + provider)?.models || [],
    // The model's display name when the agent has reported it.
    modelName: (provider, id) => id ? modelName((cache.get(api.getState().projectId + ':' + provider)?.models || []).find(row => modelId(row) === id) || { id }) : '',
    preload: (projectId = api.getState().projectId) => preloadAll(projectId),
  };
})();

(() => {
  'use strict';
  // The Tasks panel: what the current task has used and how it ended (#84), its limits (#87), and the tasks before it.
  // A task follows its handoffs, retries and reviews. Everything is worked out from the saved conversation on this
  // computer, and a value an agent didn't report shows as not reported, never as zero.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('tasks-panel');
  if (!api || !panel) return;
  const PANEL_KEY = 'throughline:side-panel', names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', local: 'Local' };
  const AGENTS = [['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['local', 'Local models']];
  const FIELDS = [['maxConcurrent', 'Tasks at once'], ['maxWorkingMinutes', 'Working minutes', 'No limit'], ['maxTokens', 'New tokens', 'No limit'], ['maxSpendUSD', 'API spend, USD', 'No limit'], ['maxHandoffs', 'Handoffs'], ['maxRetries', 'Retries'], ['maxReviews', 'Reviews'], ['maxRepeatedFailures', 'Same failure']];
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'text-link') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  // Whole seconds first, so a time never reads as 36m 60s.
  const duration = ms => { const seconds = Math.max(1, Math.round(ms / 1000)); if (seconds < 3600) return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; const minutes = Math.round(seconds / 60); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; };
  const compact = value => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 || (value >= 1e3 && value % 1000 === 0) ? `${Math.round(value / 1e3)}k` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value);
  const read = () => { try { return localStorage.getItem(PANEL_KEY) || 'agents'; } catch { return 'agents'; } };
  const remember = value => { try { localStorage.setItem(PANEL_KEY, value); } catch { /* A convenience only. */ } };
  const conversation = () => api.getState().conversation;
  let ledger = null, budget = null, shown = null, loading = 0;

  const STATUS = { running: ['working', 'Working'], complete: ['done', 'Finished'], interrupted: ['stopped', 'Stopped'], incomplete: ['failed', 'Did not finish'] };
  const TESTS = { passed: ['done', 'Tests passed'], failed: ['failed', 'Tests failed'], unverified: [null, 'No tests run'] };
  function agents(task) {
    const host = node('span', 'task-agents');
    Object.keys(task.agents || {}).forEach((provider, index) => {
      if (index) host.append(node('span', 'task-arrow', '→'));
      const avatar = node('span', `message-avatar ${provider}`); avatar.setAttribute('aria-hidden', 'true');
      host.append(avatar, node('span', '', names[provider] || provider));
    });
    return host;
  }
  // Unknown stays unknown: a run that reported nothing never shows as zero.
  function usageText(usage) {
    if (!usage?.runsWithTokens) return 'Usage not reported';
    const parts = [];
    if (usage.input !== null) parts.push(`${usage.input.toLocaleString()} input`);
    if (usage.cacheRead !== null) parts.push(`${usage.cacheRead.toLocaleString()} cached`);
    if (usage.output !== null) parts.push(`${usage.output.toLocaleString()} output`);
    return (usage.partialRuns ? 'At least ' : '') + parts.join(' · ') + (usage.runsWithTokens < usage.runs ? ` · ${usage.runsWithTokens} of ${usage.runs} runs reported` : '');
  }
  function limitRow(label, used, allowed, text) {
    const row = node('div', `limit-row${used >= allowed ? ' over' : used >= allowed * 0.8 ? ' near' : ''}`), bar = node('span', 'limit-bar');
    bar.style?.setProperty?.('--used', `${Math.min(100, Math.round(used / allowed * 100))}%`);
    row.append(node('span', 'limit-label', label), bar, node('span', 'limit-value', text));
    return row;
  }
  function renderCurrent() {
    const task = (ledger?.tasks || []).at(-1), card = $('task-card'), state = budget?.task;
    $('tasks-empty').hidden = Boolean(task);
    card.hidden = !task;
    if (!task) return;
    const [statusClass, statusText] = STATUS[task.status] || ['', task.status], [testClass, testText] = TESTS[task.verification] || TESTS.unverified;
    const head = node('div', 'task-card-head'), title = node('span', 'task-prompt', task.prompt || 'Task'); title.title = task.prompt || '';
    head.append(title, node('span', `status-pill ${statusClass}`, statusText));
    const line = node('div', 'task-card-line'); line.append(agents(task), node('span', `status-pill ${testClass || 'quiet'}`, testText));
    const tokens = task.usage?.runsWithTokens ? (task.usage.input || 0) + (task.usage.output || 0) + (task.usage.cacheWrite || 0) : null;
    const tiles = node('div', 'stat-tiles');
    for (const [value, label, title] of [[duration(task.workingMs), 'working', 'Time agents worked, not time waiting for a reset'], [tokens === null ? '—' : compact(tokens), 'new tokens', tokens === null ? 'Not reported by its agents' : usageText(task.usage)], [String(task.runs), plural(task.runs, 'run').replace(/^\d+ /, ''), [task.handoffs ? plural(task.handoffs, 'handoff') : '', task.retries ? plural(task.retries, 'retry').replace('retrys', 'retries') : '', task.reviews ? plural(task.reviews, 'review') : ''].filter(Boolean).join(', ') || 'One run']]) {
      const tile = node('div', 'stat'); tile.append(node('strong', '', value), node('span', '', label)); tile.title = title; tiles.append(tile);
    }
    card.replaceChildren(head, line, tiles);
    const roleNames = { builder: 'Builder', assessment: 'Routing assessment', review: 'Reviewer', 'read-only': 'Read-only work', planning: 'Planning' };
    for (const [role, measured] of Object.entries(task.roles || {})) {
      card.append(node('p', 'panel-muted', `${roleNames[role] || role}: ${plural(measured.runs, 'run')} · ${duration(measured.workingMs)} · ${usageText(measured.usage)}`));
    }
    if (task.roles?.assessment || task.roles?.review) card.append(node('p', 'panel-muted', 'These calls are included in the total. Provider-internal planning, summaries and delegated work cannot be separated by role.'));
    // A plan's planning run and each step are tasks of their own; this adds the whole plan up (#84).
    const plan = task.plan && (ledger?.plans || []).find(item => item.id === task.plan.id);
    if (plan) {
      const tokens = plan.usage?.runsWithTokens ? (plan.usage.input || 0) + (plan.usage.output || 0) + (plan.usage.cacheWrite || 0) : null;
      const part = task.plan.part === 'planning' ? 'This is a plan’s planning run.' : `This is step ${task.plan.number} of a plan.`;
      card.append(node('p', 'panel-muted', `${part} The whole plan: ${[plan.planned ? 'planning' : '', plan.steps ? plural(plan.steps, 'step') : ''].filter(Boolean).join(' and ')} · ${plural(plan.runs, 'run')} · ${duration(plan.workingMs)} · ${tokens === null ? 'tokens not reported' : `${plan.usage.runsWithTokens < plan.usage.runs || plan.usage.partialRuns ? 'at least ' : ''}${compact(tokens)} new tokens`}.`));
    }
    // Limits only appear once one is set, as bars against what this task has used.
    if (state && state.taskId === task.id) {
      const limits = state.limits, bars = node('div', 'task-limits');
      if (limits.maxWorkingMinutes !== null) bars.append(limitRow('Time', state.workingMs / 60000, limits.maxWorkingMinutes, `${Math.round(state.workingMs / 60000)} of ${limits.maxWorkingMinutes} min`));
      if (limits.maxTokens !== null) bars.append(limitRow('Tokens', state.tokens, limits.maxTokens, `${compact(state.tokens)} of ${compact(limits.maxTokens)}`));
      if (limits.maxSpendUSD !== null) bars.append(limitRow('Spend', state.spendUSD, limits.maxSpendUSD, `$${state.spendUSD.toFixed(2)} of $${limits.maxSpendUSD}`));
      bars.append(limitRow('Handoffs', state.handoffs, limits.maxHandoffs, `${state.handoffs} of ${limits.maxHandoffs}`), limitRow('Retries', state.retries, limits.maxRetries, `${state.retries} of ${limits.maxRetries}`));
      card.append(bars);
      if (state.active && [limits.maxWorkingMinutes, limits.maxTokens, limits.maxSpendUSD].some(value => value !== null)) card.append(node('p', 'panel-muted', 'The remaining measured allowance is reserved for this task’s running agent. Continue or review this task after it finishes.'));
      if (state.runsWithoutUsage && limits.maxTokens !== null) card.append(node('p', 'panel-muted', `${plural(state.runsWithoutUsage, 'run')} reported no tokens, so the total is lower than the real one.`));
      if (state.runsWithPartialUsage && limits.maxTokens !== null) card.append(node('p', 'panel-muted', `${plural(state.runsWithPartialUsage, 'run')} reported only partial tokens. The remaining token allowance is unknown.`));
      if (state.runsWithoutCost && limits.maxSpendUSD !== null) card.append(node('p', 'panel-muted', `${plural(state.runsWithoutCost, 'run')} reported no API cost or confirmed billing. Reported spend is a lower bound; the remaining allowance is unknown.`));
      if (limits.maxTokens !== null) card.append(node('p', 'panel-muted', 'Token limits are checked as usage is reported; in-flight work can overshoot.'));
      if (limits.maxSpendUSD !== null) {
        const caps = state.enforcement?.spendCaps, active = state.enforcement?.activeSpendCaps || [];
        const native = (caps?.native || 0) + active.filter(cap => cap.spend === 'native').length;
        const reported = (caps?.reported || 0) + active.filter(cap => cap.spend !== 'native').length;
        card.append(node('p', 'panel-muted', `API spend checks: ${plural(native, 'run')} with a native adapter cap, ${reported} checked through reported usage. In-flight work can overshoot.`));
      }
      const over = state.overages;
      if (over && (over.tokens || over.spendUSD || over.workingMs)) card.append(node('p', 'task-note', `Reported over limit: ${[over.tokens ? `${over.tokens.toLocaleString()} tokens` : '', over.spendUSD ? `$${over.spendUSD.toFixed(4)} API spend` : '', over.workingMs ? `${duration(over.workingMs)} working time` : ''].filter(Boolean).join(' · ')}.`));
      const top = state.failures?.[0];
      if (top && top.count > 1) card.append(node('p', 'task-note', `Went wrong ${top.count} of ${limits.maxRepeatedFailures} times: ${top.what}`));
      if (state.exceeded) {
        const reached = node('div', 'limits-reached');
        reached.append(node('span', '', state.exceeded.message));
        if (state.exceeded.limit === 'maxRepeatedFailures') {
          reached.append(
            button('Dismiss and retry', async () => {
              try {
                await api.post(`/api/conversations/${conversation().id}/budget`, { action: 'reset', taskId: state.taskId });
                await api.refresh();
              } catch (error) { api.showNotice(error.message); }
            }),
            button('Extend budget', () => extend(state.taskId, state.exceeded.limit).catch(error => api.showNotice(error.message)))
          );
        } else if (['tokenUsageUnknown', 'spendUsageUnknown'].includes(state.exceeded.limit)) {
          reached.append(button('Review limits', openLimits));
        } else {
          reached.append(button('Allow more', () => extend(state.taskId, state.exceeded.limit).catch(error => api.showNotice(error.message))));
        }
        card.append(reached);
      }
    }
  }
  function renderEarlier() {
    const tasks = (ledger?.tasks || []).slice(0, -1).slice(-8).reverse(), section = $('tasks-recent'), list = $('tasks-list');
    section.hidden = !tasks.length;
    list.replaceChildren(...tasks.map(task => {
      // Not `task-row`: that's the sidebar's one-line task row, and these rows wrap over three lines.
      const row = node('li', 'panel-row ledger-row'), title = node('div', 'panel-row-title');
      const part = task.plan ? (task.plan.part === 'planning' ? 'Planning: ' : `Plan step ${task.plan.number}: `) : '';
      const prompt = node('span', 'task-row-prompt', `${task.folder ? `${task.folder}: ` : ''}${part}${task.prompt || 'Task'}`);
      prompt.title = prompt.textContent;
      title.append(prompt, node('span', 'panel-row-time', duration(task.workingMs)));
      const meta = node('div', 'panel-row-meta'), tests = TESTS[task.verification] || TESTS.unverified;
      meta.append(agents(task), node('span', '', plural(task.runs, 'run')), node('span', tests[0] === 'done' ? 'ok' : tests[0] === 'failed' ? 'bad' : '', tests[1]));
      row.append(title, meta, node('div', 'panel-row-meta', usageText(task.usage)));
      return row;
    }));
    $('tasks-export').hidden = !(ledger?.tasks || []).length;
  }
  const render = () => { renderCurrent(); renderEarlier(); };
  const scope = () => { const state = api.getState(), c = state.conversation; return c ? `${state.projectId}:${c.id}:${c.lastRun?.id || ''}:${c.status}:${c.activeRun?.toolCount || 0}:${c.taskBudgetRevision || 0}` : null; };
  async function load(force = false) {
    const key = scope();
    if (panel.hidden || !key || (!force && key === shown)) return;
    shown = key;
    const request = ++loading;
    try {
      const [nextLedger, nextBudget] = await Promise.all([api.api('/api/ledger?prompts=1'), api.api('/api/budget')]);
      if (request === loading) { ledger = nextLedger; budget = nextBudget; render(); }
    } catch { if (request === loading) shown = null; }
  }

  // Limits: one set for a whole task, in a dialog, since they are set rarely.
  function buildLimitsForm() {
    const fields = $('limits-fields');
    for (const [key, name, empty] of FIELDS) {
      const label = node('label', 'limit-field'), input = node('input');
      input.id = `limit-${key}`; input.type = 'number'; input.min = key === 'maxRepeatedFailures' ? '1' : '0'; input.step = key === 'maxSpendUSD' ? '0.5' : '1'; if (empty) input.placeholder = empty;
      label.append(node('span', '', name), input); fields.append(label);
    }
    const agentsHost = $('limits-agents');
    for (const [key, name] of AGENTS) {
      const label = node('label', 'limit-agent'), box = node('input');
      box.id = `limit-agent-${key}`; box.type = 'checkbox';
      label.append(box, node('span', '', name)); agentsHost.append(label);
    }
    const modelsHost = $('limits-models');
    for (const [key, name] of AGENTS) {
      const label = node('label', 'limit-field'), input = node('input');
      input.id = `limit-models-${key}`; input.type = 'text'; input.placeholder = 'All models';
      label.append(node('span', '', `${name} models`), input); modelsHost.append(label);
    }
  }
  function fillLimitsForm() {
    const policy = budget?.policy || {};
    for (const [key] of FIELDS) $(`limit-${key}`).value = policy[key] ?? '';
    for (const [key] of AGENTS) $(`limit-agent-${key}`).checked = !policy.allowedProviders || policy.allowedProviders.includes(key);
    for (const [key] of AGENTS) $(`limit-models-${key}`).value = (policy.allowedModels?.[key] || []).join(', ');
    $('limits-error').hidden = true;
  }
  async function openLimits() {
    if (!budget) { try { budget = await api.api('/api/budget'); } catch (error) { api.showNotice(error.message); return; } }
    fillLimitsForm();
    $('limits-dialog').showModal();
  }
  $('limits-form').addEventListener('submit', async event => {
    event.preventDefault();
    const c = conversation(); if (!c) return;
    const policy = {};
    for (const [key, , empty] of FIELDS) { const raw = String($(`limit-${key}`).value).trim(); if (raw === '' && !empty) continue; policy[key] = raw === '' ? null : Number(raw); }
    const allowed = AGENTS.map(([key]) => key).filter(key => $(`limit-agent-${key}`).checked);
    policy.allowedProviders = allowed.length === AGENTS.length ? null : allowed;
    const models = {};
    for (const [key] of AGENTS) {
      const values = [...new Set(String($(`limit-models-${key}`).value || '').split(/[,\s]+/).filter(Boolean))];
      if (values.length) models[key] = values;
    }
    policy.allowedModels = Object.keys(models).length ? models : null;
    try { budget = await api.post(`/api/conversations/${c.id}/budget`, { action: 'policy', policy }); $('limits-dialog').close(); render(); await api.refresh(); }
    catch (error) { $('limits-error').textContent = error.message; $('limits-error').hidden = false; }
  });
  $('limits-cancel').addEventListener('click', () => $('limits-dialog').close());
  $('limits-open').addEventListener('click', openLimits);
  async function extend(taskId, limit) {
    const c = conversation(); if (!c) return false;
    budget = await api.post(`/api/conversations/${c.id}/budget`, { action: 'extend', taskId, limit });
    render();
    return true;
  }
  $('tasks-export').addEventListener('click', async () => {
    try {
      // Without prompts or commands, so it can be shared as it is.
      const data = await api.api('/api/ledger'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), link = document.createElement('a');
      link.href = url; link.download = 'codeshi-task-usage.json'; document.body?.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { api.showNotice(error.message); }
  });

  function setOpen(open, section = null, keep = true) {
    panel.hidden = !open;
    if (keep) remember(open ? 'tasks' : 'none');
    if (open) {
      window.relayAgents?.close(); window.relayGit?.close(); window.relayReviews?.closePanel?.(); window.relayTimeline?.close(); window.relayBrief?.close();
      load();
      window.relaySmartResults?.renderSection(); window.relaySmartResults?.load();
      if (section === 'limits') openLimits();
    }
    window.dispatchEvent(new CustomEvent('relay-side-panel'));
  }
  let lastProject = null;
  window.addEventListener('relay-state', () => {
    const projectId = api.getState().projectId;
    if (projectId !== lastProject) {
      lastProject = projectId;
      if (!projectId) setOpen(false, null, false);
      else if (panel.hidden && read() === 'tasks' && window.matchMedia?.('(min-width: 1101px)').matches) setOpen(true, null, false);
    }
    load();
  });
  buildLimitsForm();
  window.relayTasks = { open: section => setOpen(true, section), close: () => { if (!panel.hidden) setOpen(false, null, false); }, toggle: () => setOpen(panel.hidden), isOpen: () => !panel.hidden };
  // A refused run offers to raise the limit from the notice at the top of the conversation.
  async function reset(taskId) { const c = conversation(); if (!c) return false; budget = await api.post(`/api/conversations/${c.id}/budget`, { action: 'reset', taskId }); render(); return true; }
  window.relayLimits = { extend, reset };
})();

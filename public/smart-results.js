(() => {
  'use strict';
  // Smart results (#139): the Tasks panel section and the Flow card. Both read /api/results, which works the summary out
  // from this workspace's saved tasks with no model call. It is fetched when a task ends or a setting here changes, never
  // on a timer. Extra usage, savings and "not enough data" are said in the same plain way.
  const $ = id => document.getElementById(id), api = window.relayUI;
  if (!api) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'text-link') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  const duration = ms => { const seconds = Math.max(0, Math.round(ms / 1000)); if (seconds < 3600) return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; const minutes = Math.round(seconds / 60); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; };
  const compact = value => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 ? `${Math.round(value / 1e3)}k` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(Math.round(value));
  const percent = value => `${Math.round(Math.abs(value) * 100)}%`;
  const share = (part, whole) => whole ? `${Math.round(part / whole * 100)}%` : '—';
  const NAMES = { smart: 'Smart', saver: 'Saver', ultra: 'Ultra', manual: 'Manual' }, AGENTS = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', local: 'Local' };
  const SIZES = { 'change:light': 'small changes', 'change:standard': 'focused changes', 'change:deep': 'large changes', 'question:light': 'quick questions', 'question:standard': 'questions', 'question:deep': 'deep questions' };
  const EXCLUDED = { 'left-out-by-you': 'left out by you', 'part-of-a-plan': 'part of an Orchestrate plan', 'still-running': 'still running', 'other-context-setting': 'used an earlier context setting', 'context-setting-not-recorded': 'from before the context setting was recorded', 'no-size': 'had no request to size, such as a review', 'other-manual-agent': 'manual tasks on another agent than your baseline', 'earlier-routing-rules': 'routed by earlier routing rules' };
  const NEEDS = { 'routed-tasks': mode => `${NAMES[mode]} tasks of a size you also ran by hand`, 'manual-tasks': () => 'Your manual tasks of the same sizes', 'manual-verified': () => 'Manual tasks whose tests passed' };
  const DAYS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']];
  const projectKey = name => `throughline:results-${name}:${api.getState().projectId || ''}`;
  const read = (name, fallback) => { try { return JSON.parse(localStorage.getItem(projectKey(name)) || 'null') ?? fallback; } catch { return fallback; } };
  const write = (name, value) => { try { localStorage.setItem(projectKey(name), JSON.stringify(value)); } catch { /* A convenience only. */ } };
  let data = null, received = 0, shown = null, loading = 0, mode = null, showTasks = false;
  const listeners = new Set();

  const query = (extra = {}) => {
    const baseline = read('baseline', null), exclude = read('exclude', []);
    const params = { days: read('days', '30'), ...(baseline ? { baseline: JSON.stringify(baseline) } : {}), ...(exclude.length ? { exclude: exclude.join(',') } : {}), ...extra };
    return `/api/results?${Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
  };
  // A task ending, a routing change or a setting here are the only things that change the answer.
  const scope = () => { const state = api.getState(), c = state.conversation; return state.projectId ? `${state.projectId}:${c?.lastRun?.id || ''}:${c?.lastRun?.status || ''}:${(c?.parallelTasks || []).map(task => task.status).join(',')}:${query()}` : null; };
  async function load(force = false) {
    const key = scope();
    if (!key || (!force && key === shown)) return data;
    shown = key;
    const request = ++loading;
    try { const next = await api.api(query()); if (request === loading) { data = next; received++; for (const listener of listeners) listener(); } }
    catch { if (request === loading) shown = null; }
    return data;
  }
  const refresh = () => load(true);

  // ---- What a comparison says, in one sentence, for the card and the panel alike.
  function verdict(result, name) {
    if (!result) return { tone: 'quiet', text: 'Loading…' };
    if (result.status === 'not-enough-data') return { tone: 'quiet', text: 'Not enough comparable data yet to compare with your manual tasks.' };
    const quality = result.quality;
    if (result.status === 'quality-regression') return { tone: 'warn', text: `${name} verified ${share(quality.verifiedShare.routed, 1)} of its tasks and your manual tasks ${share(quality.verifiedShare.baseline, 1)}. Using less on fewer verified tasks isn’t a saving.` };
    if (result.status === 'quality-not-established') return { tone: 'quiet', text: `Tests ran after ${share(quality.checkedShare.routed, 1)} of ${name} tasks and ${share(quality.checkedShare.baseline, 1)} of manual ones. Comparisons need tests after at least ${share(data?.method?.minCheckedShare ?? 0.5, 1)} on each side.` };
    const time = result.workingTime;
    if (!time?.direction) return { tone: 'quiet', text: 'Not enough comparable data yet.' };
    const [low, high] = time.interval.relative || [null, null];
    const range = low === null ? '' : ` (${time.interval.level * 100}% range: ${rangeText(low, high)})`;
    if (time.direction === 'inconclusive') return { tone: 'quiet', text: `No clear difference in working time per verified task from your manual tasks${range}.` };
    if (time.relative === null) return { tone: time.direction === 'less' ? 'good' : 'warn', text: `Working time per verified task differs from your manual tasks by ${duration(Math.abs(time.difference))} in total.` };
    return { tone: time.direction === 'less' ? 'good' : 'warn', text: `About ${percent(time.relative)} ${time.direction === 'less' ? 'less' : 'more'} working time per verified task than your manual tasks${range}.` };
  }
  // Positive is less than the baseline. The words carry the sign, so a range never reads as "-12% to 30%".
  const rangeText = (low, high) => {
    const ends = low > 0 ? [percent(low), percent(high), 'less'] : high < 0 ? [percent(high), percent(low), 'more'] : null;
    if (!ends) return `${percent(low)} more to ${percent(high)} less`;
    return ends[0] === ends[1] ? `${ends[0]} ${ends[2]}` : `${ends[0]} to ${ends[1]} ${ends[2]}`;
  };

  // ---- The Flow card (#107): quiet, one comparison, a way into the evidence.
  function renderCard(card) {
    const state = api.getState(), current = window.relayRouting?.normalizeMode?.(state.conversation?.routing?.mode) || 'smart';
    load();
    const signature = JSON.stringify([current, received]);
    if (signature === card.signature) return;
    card.signature = signature;
    const title = card.element.querySelector('h2'); if (title) title.textContent = `${NAMES[current]} results`;
    card.body.replaceChildren(); card.foot.replaceChildren();
    card.foot.append(button('Details', () => openDetails(current), 'flow-button'));
    if (!data) { card.body.append(node('p', 'flow-empty', 'Reading your saved tasks…')); return; }
    const seen = data.observed[current], range = DAYS.find(([value]) => value === String(data.range.days ?? 'all'))?.[1] || 'All time';
    if (!seen.tasks) { card.body.append(node('p', 'flow-empty', `${range}: no finished ${NAMES[current]} tasks yet. Results build up from your own tasks; nothing is estimated for you in advance.`)); return; }
    const facts = node('ul', 'results-facts');
    facts.append(node('li', '', `${range} · ${plural(seen.tasks, 'task')} · ${seen.verified} verified by tests`));
    facts.append(node('li', '', `${duration(seen.workingMs)} working${seen.newTokens.total === null ? '' : ` · ${compact(seen.newTokens.total)} new tokens${seen.newTokens.tasks < seen.newTokens.of ? ` (${seen.newTokens.tasks} of ${seen.newTokens.of} tasks reported)` : ''}`}`));
    const said = verdict(data.comparisons[current], NAMES[current]), line = node('p', `results-verdict ${said.tone}`, said.text);
    card.body.append(facts, line);
  }

  // ---- The Tasks panel section: every group, the comparison with its arithmetic, and the tasks behind it.
  function renderSection() {
    const host = $('tasks-results-body'); if (!host) return;
    const section = $('tasks-results');
    if (!data) { host.replaceChildren(node('p', 'panel-muted', 'Reading your saved tasks…')); return; }
    const current = mode || window.relayRouting?.normalizeMode?.(api.getState().conversation?.routing?.mode) || 'smart';
    const controls = node('div', 'results-controls'), days = node('select', 'results-select'), baseline = node('select', 'results-select'), compareWith = node('select', 'results-select');
    days.setAttribute('aria-label', 'Time range');
    for (const [value, label] of DAYS) { const option = node('option', '', label); option.value = value; option.selected = String(data.range.days ?? 'all') === value; days.append(option); }
    days.addEventListener('change', () => { write('days', days.value); load(); });
    compareWith.setAttribute('aria-label', 'Routing mode to compare');
    for (const value of ['smart', 'saver', 'ultra']) { const option = node('option', '', NAMES[value]); option.value = value; option.selected = value === current; compareWith.append(option); }
    compareWith.addEventListener('change', () => { mode = compareWith.value; renderSection(); });
    baseline.setAttribute('aria-label', 'Manual baseline');
    const all = node('option', '', 'All my manual tasks'); all.value = ''; baseline.append(all);
    const chosen = data.baseline.choice, options = [...data.baseline.options];
    if (chosen && !options.some(option => option.provider === chosen.provider && option.model === chosen.model && option.effort === chosen.effort)) options.unshift({ ...chosen, tasks: 0 });
    for (const option of options) {
      const item = node('option', '', `${AGENTS[option.provider] || option.provider}${option.model ? ` · ${option.model}` : ''}${option.effort ? ` · ${option.effort}` : ''} (${option.tasks})`);
      item.value = JSON.stringify({ provider: option.provider, model: option.model, effort: option.effort });
      item.selected = Boolean(chosen) && chosen.provider === option.provider && chosen.model === option.model && chosen.effort === option.effort;
      baseline.append(item);
    }
    baseline.addEventListener('change', () => { write('baseline', baseline.value ? JSON.parse(baseline.value) : null); load(); });
    const label = (text, control) => { const value = node('label', 'results-control'); value.append(node('span', '', text), control); return value; };
    controls.append(label('Range', days), label('Compare', compareWith), label('Your usual manual choice', baseline));

    // Observed results: each group on its own row, never subtracted from each other here.
    const table = node('table', 'results-table'), head = node('tr');
    for (const text of ['', 'Tasks', 'Verified', 'Working', 'New tokens', 'Retries', 'Asked you']) head.append(node('th', '', text));
    table.append(head);
    for (const name of ['smart', 'saver', 'ultra', 'manual']) {
      const seen = data.observed[name]; if (!seen.tasks) continue;
      const row = node('tr');
      row.append(node('th', '', NAMES[name]), node('td', '', String(seen.tasks)), node('td', '', `${seen.verified} (${share(seen.verified, seen.tasks)})`), node('td', '', duration(seen.workingMs)),
        node('td', '', seen.newTokens.total === null ? 'Not reported' : `${compact(seen.newTokens.total)}${seen.newTokens.tasks < seen.newTokens.of ? ` · ${seen.newTokens.tasks}/${seen.newTokens.of}` : ''}`), node('td', '', String(seen.retries)), node('td', '', String(seen.interventions)));
      table.append(row);
    }
    const observedNotes = [];
    const routed = data.observed[current];
    if (routed.assessments.runs) observedNotes.push(`${NAMES[current]} totals include ${plural(routed.assessments.runs, 'routing assessment')} (${duration(routed.assessments.workingMs)}${routed.assessments.newTokens === null ? '' : `, ${compact(routed.assessments.newTokens)} tokens`}).`);
    const untested = ['smart', 'saver', 'ultra', 'manual'].reduce((sum, name) => sum + data.observed[name].untested, 0);
    if (untested) observedNotes.push(`${plural(untested, 'task')} finished without tests running, so they count as unverified, not as successes.`);
    const priced = ['smart', 'saver', 'ultra', 'manual'].filter(name => data.observed[name].apiEstimateUSD.total !== null);
    if (priced.length) observedNotes.push(`API spend the agents estimated: ${priced.map(name => `${NAMES[name]} $${data.observed[name].apiEstimateUSD.total.toFixed(2)}`).join(' · ')}. Estimates, not charges, and not compared: Codeshi keeps no dated price list.`);
    observedNotes.push('Plan allowance is account-wide and other tools use it too, so it is never counted here.');

    const result = data.comparisons[current], said = verdict(result, NAMES[current]), comparison = node('div', 'results-comparison');
    comparison.append(node('p', `results-verdict ${said.tone}`, said.text));
    if (result.status === 'not-enough-data') {
      const list = node('ul', 'results-needs');
      for (const need of result.missing) list.append(node('li', '', `${NEEDS[need.need](current)}: ${need.have} of ${need.want}`));
      comparison.append(list, node('p', 'panel-muted', `A task counts as verified only when the project’s tests pass after it. For routed tasks, turn on Check with tests in Agents → Routing. Sizes need ${data.method.minPerSize} finished tasks on each side to be compared.`));
    } else comparison.append(...metricLines(result, current));
    if (data.comparisons[current].policy !== null && data.comparisons[current].policy !== undefined) comparison.append(node('p', 'panel-muted', `Routing rules version ${data.comparisons[current].policy}.`));

    const excluded = Object.entries(data.excluded);
    const notes = node('div', 'results-notes');
    for (const text of observedNotes) notes.append(node('p', 'panel-muted', text));
    if (excluded.length) notes.append(node('p', 'panel-muted', `Not compared: ${excluded.map(([reason, count]) => `${count} ${EXCLUDED[reason] || reason}`).join(' · ')}.`));

    const tasksToggle = button(showTasks ? 'Hide the tasks' : `Show the ${plural(data.tasks.length, 'task')}`, () => { showTasks = !showTasks; renderSection(); });
    const exportPlain = button('Export report', () => exportReport(false)), exportPrompts = button('Export with prompts', () => exportReport(true));
    exportPrompts.title = 'Includes the first 200 characters of each request and routing reasons. Check it before sharing.';
    const foot = node('div', 'results-foot'); foot.append(tasksToggle, exportPlain, exportPrompts);
    host.replaceChildren(controls, table, comparison, notes, foot);
    if (showTasks) host.append(taskList());
    if (section) section.hidden = false;
  }
  function metricLines(result, current) {
    const lines = [], name = NAMES[current];
    const q = result.quality;
    lines.push(node('p', 'panel-muted', `Verified: ${name} ${share(q.verifiedShare.routed, 1)} of ${result.matched.routed} tasks, manual ${share(q.verifiedShare.baseline, 1)} of ${result.matched.baseline} (weighted to ${name}’s mix of sizes). First try: ${share(q.firstAttemptSuccess.routed ?? 0, 1)} and ${share(q.firstAttemptSuccess.baseline ?? 0, 1)}. Retries per task: ${q.retriesPerTask.routed.toFixed(2)} and ${q.retriesPerTask.baseline.toFixed(2)}.`));
    for (const [key, title, format] of [['workingTime', 'Working time', duration], ['newTokens', 'New tokens', compact]]) {
      const metric = result[key];
      if (!metric?.direction) { lines.push(node('p', 'panel-muted', `${title}: not enough tasks that reported it (${metric?.coverage?.tasks ?? 0} of ${metric?.coverage?.of ?? 0}).`)); continue; }
      const block = node('details', 'results-metric'), summary = node('summary');
      const per = metric.perVerified ? `${format(metric.perVerified.routed)} per verified task, against ${format(metric.perVerified.baseline)} by hand` : 'no verified tasks';
      const [low, high] = metric.interval.relative || [null, null];
      summary.textContent = `${title}: ${per}${metric.relative === null ? '' : ` · ${metric.direction === 'inconclusive' ? 'no clear difference' : `${percent(metric.relative)} ${metric.relative >= 0 ? 'less' : 'more'}`}`}${low === null ? '' : ` (range ${rangeText(low, high)})`}`;
      block.append(summary);
      if (metric.coverage.tasks < metric.coverage.of) block.append(node('p', 'panel-muted', `Only ${metric.coverage.tasks} of ${metric.coverage.of} matched tasks reported every run’s tokens, so this is not a complete result.`));
      if (metric.caveat === 'different-agents') block.append(node('p', 'panel-muted', 'The two sides used different agents, which count tokens differently, so this is shown but not stated as a result.'));
      // The arithmetic, size by size, so it can be checked by hand.
      const table = node('table', 'results-table'), head = node('tr');
      for (const text of ['Size', 'Manual total ÷ verified', '× ' + name + ' verified', `= by hand`, `${name} total`]) head.append(node('th', '', text));
      table.append(head);
      for (const size of metric.sizes) {
        const row = node('tr');
        row.append(node('th', '', SIZES[size.size] || size.size), node('td', '', `${format(size.baseline.total)} ÷ ${size.baseline.verified}`), node('td', '', String(size.routed.verified)), node('td', '', format(size.baselineForRoutedWork)), node('td', '', format(size.routed.total)));
        table.append(row);
      }
      block.append(table, node('p', 'panel-muted', `By hand ${format(metric.baselineTotal)} − ${name} ${format(metric.routedTotal)} = ${metric.difference < 0 ? '−' : ''}${format(Math.abs(metric.difference))}${metric.relative === null ? '. The manual total is zero, so there is no percentage.' : `, ${(metric.relative * 100).toFixed(1)}% of the manual total`}. Failed and stopped tasks count in both totals. The range comes from ${metric.interval.resamples} seeded resamples of the tasks; one that includes zero is no clear difference.`));
      if (!metric.headline) block.append(node('p', 'panel-muted', 'Not a headline result: ' + (result.quality.status !== 'ok' ? 'quality isn’t established.' : metric.direction === 'inconclusive' ? 'the range includes no difference.' : metric.coverage.tasks < metric.coverage.of ? 'some tasks didn’t report it.' : 'the agents differ.')));
      lines.push(block);
    }
    if (result.unmatched.length) lines.push(node('p', 'panel-muted', `Sizes not compared: ${result.unmatched.map(item => `${SIZES[item.size] || 'unsized'} (${name} ${item.routed}, manual ${item.baseline})`).join(' · ')}.`));
    return lines;
  }
  function taskList() {
    const list = node('ul', 'panel-list results-tasks'), exclude = new Set(read('exclude', []));
    for (const task of data.tasks.slice(0, 200)) {
      const row = node('li', 'panel-row ledger-row'), title = node('div', 'panel-row-title'), meta = node('div', 'panel-row-meta');
      title.append(node('span', 'task-row-prompt', `${NAMES[task.group]} · ${SIZES[`${task.kind}:${task.size}`] || 'unsized'}`), node('span', 'panel-row-time', duration(task.workingMs)));
      meta.append(node('span', task.verified ? 'ok' : task.verification === 'failed' ? 'bad' : '', task.verified ? 'Verified' : task.verification === 'failed' ? 'Tests failed' : task.status === 'complete' ? 'No tests run' : 'Did not finish'),
        node('span', '', task.newTokens === null ? 'Tokens not fully reported' : `${compact(task.newTokens)} new tokens`), node('span', '', plural(task.runs, 'run')));
      if (task.assessments) meta.append(node('span', '', plural(task.assessments.runs, 'assessment')));
      if (task.agent) meta.append(node('span', '', `${AGENTS[task.agent.provider] || task.agent.provider}${task.agent.model ? ` · ${task.agent.model}` : ''}`));
      if (task.excludedBecause && task.excludedBecause !== 'left-out-by-you') meta.append(node('span', '', `Not compared: ${EXCLUDED[task.excludedBecause] || task.excludedBecause}`));
      const left = exclude.has(task.id);
      meta.append(button(left ? 'Include again' : 'Leave out', () => { if (left) exclude.delete(task.id); else exclude.add(task.id); write('exclude', [...exclude]); load(); }));
      row.append(title, meta);
      list.append(row);
    }
    return list;
  }
  async function exportReport(prompts) {
    try {
      const report = await api.api(query(prompts ? { prompts: '1' } : {})), url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })), link = document.createElement('a');
      link.href = url; link.download = `codeshi-smart-results${prompts ? '-with-prompts' : ''}.json`; document.body?.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { api.showNotice(error.message); }
  }
  function openDetails(current) {
    mode = current;
    // In Flow the Tasks panel opens as Flow's own sheet.
    window.relayTasks?.open?.();
    renderSection();
    setTimeout(() => $('tasks-results')?.scrollIntoView?.({ block: 'start' }), 0);
  }

  listeners.add(() => { renderSection(); window.dispatchEvent(new CustomEvent('relay-results')); });
  window.addEventListener('relay-state', () => { if (!$('tasks-panel')?.hidden || window.relayFlow?.isOn?.()) load(); });
  window.relaySmartResults = { load, refresh, renderCard, renderSection, data: () => data, verdict };
})();

// A split message Flow is finishing by itself (src/split-finish.mjs). Its parts aren't on the Plan while Flow finishes them.
// They show in three places, all described here so they say the same thing:
// - Tasks (flow.js): one group row with every part under it, which opens a part's conversation to watch it.
// - Activity (flow.js): how far the split is, as the card's lead.
// - The chat, above the message box: one line with a bar of the parts and Stop, which stops every part (they then go to
//   the Plan for you to finish). Only when the side panel is hidden, in a narrow window, can it list the parts too.
// A part's step comes from the parts it waits for: parts in one step run side by side, and steps run one after another.
// Each part also has its size, which is why it got a small or a strong model.
(() => {
  const $ = id => document.getElementById(id), api = window.relayUI, section = $('split-progress');
  if (!api) return;
  const NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  // A part's size, as the rater gave it: a small part goes to a small model, and only a complex one to a strong one.
  const SIZE = { light: 'Small', standard: 'Medium', deep: 'Complex' };
  const SIZE_WHY = { light: 'Rated a small part, so it went to a small model', standard: 'Rated a medium part', deep: 'Rated a complex part, so it went to a strong model' };
  const ENDED = { stopped: 'Stopped', failed: 'Didn’t finish', cancelled: 'Cancelled', discarded: 'Discarded', blocked: 'Blocked', lost: 'Its copy is gone', detached: 'Its folder was removed' };
  let open = false, shownRun = null, stopping = false;

  const working = c => (c?.splitRuns || []).findLast(run => run.status === 'working') || null;
  const who = task => {
    const provider = task?.runningProvider || task?.provider;
    if (!provider) return '';
    const modelId = task.runningModel || task.model, model = modelId ? window.relayModelPicker?.modelName?.(provider, modelId) || modelId : '';
    return [NAMES[provider] || provider, model].filter(Boolean).join(' · ');
  };
  // Where one part stands, as [kind, words]. kind is done, running, waiting or attention.
  function stateOf(task, { review = false } = {}) {
    if (!task) return ['waiting', review ? 'Waits for the parts' : 'Waiting to start'];
    if (task.approvals) return ['attention', task.approvals === 1 ? 'Needs your approval' : `Needs ${task.approvals} approvals`];
    if (review && task.review?.status === 'repairing') return ['running', `Repairing ${plural((task.review.repairs || []).filter(item => item.status !== 'skipped').length, 'part')}`];
    if (review && task.review?.status === 'reviewing') return ['running', 'Checking the repairs'];
    if (task.status === 'running') return ['running', review ? 'Reviewing' : task.repairOf ? 'Repairing' : 'Working'];
    if (task.status === 'waiting') return ['waiting', review ? 'Waits for the parts' : task.reason && task.reason !== 'Starting' ? task.reason : 'Waiting to start'];
    if (task.testing || task.stepCheck?.status === 'running') return ['running', 'Testing'];
    if (task.status === 'integrated') return ['done', 'Merged'];
    if (task.status === 'complete') return review ? ['done', 'Reviewed'] : task.mode === 'worktree' ? ['running', 'Merging'] : ['done', 'Done'];
    return ['attention', ENDED[task.status] || task.status];
  }

  // The working split of a conversation, described once: its rows (parts, repairs, then the review), counts and summary.
  function describe(c) {
    const run = working(c);
    if (!run) return null;
    const tasks = (c.parallelTasks || []).filter(task => task.splitId === run.id), forCard = id => tasks.filter(task => task.board?.cardId === id).at(-1) || null;
    const parts = run.cards.map(id => forCard(id)), review = run.reviewCardId ? forCard(run.reviewCardId) : null;
    const make = (label, task, kind, options = {}) => { const [state, words] = stateOf(task, options); return { key: task?.id || `${run.id}:${label}`, label, task, kind, state, words, agent: who(task), provider: task?.runningProvider || task?.provider || '' }; };
    // Which step each part is in: one after the latest step of the parts it waits for (src/flow-split.mjs splitShape).
    // A split saved before its shape was kept has no steps, and its parts are listed as they are.
    const shape = Array.isArray(run.shape) && run.shape.length === run.cards.length ? run.shape : null, stepOf = [];
    if (shape) for (const part of shape) stepOf.push(Math.max(0, ...(part.dependsOn || []).map(number => (stepOf[number - 1] ?? -1) + 1)));
    const stepCount = shape ? Math.max(...stepOf) + 1 : 1;
    const layout = !shape ? 'unknown' : stepCount === 1 ? 'parallel' : stepCount === run.cards.length ? 'chain' : 'mixed';
    // Card titles come from the tasks, which carry them.
    const rows = parts.map((task, index) => {
      const row = make(task?.title || `Part ${index + 1}`, task, 'part');
      if (!shape) return row;
      const step = stepOf[index], tier = shape[index].tier, after = (shape[index].dependsOn || []).map(number => stepOf[number - 1]);
      Object.assign(row, { step, size: SIZE[tier] || '', sizeWhy: SIZE_WHY[tier] || '' });
      // Waiting for the step before reads plainer than the card's own reason, which quotes the part's whole title.
      const blocked = (shape[index].dependsOn || []).some(number => stateOf(parts[number - 1])[0] !== 'done');
      if (row.state === 'waiting' && blocked && (!task || task.status === 'waiting')) row.words = `After step ${Math.max(...after) + 1}`;
      return row;
    });
    for (const task of tasks.filter(item => item.splitRepair)) rows.push(make(task.title, task, 'repair'));
    if (run.reviewCardId) rows.push(make('Review of the combined result', review, 'review', { review: true }));
    const partRows = rows.filter(row => row.kind === 'part'), count = kind => partRows.filter(row => row.state === kind).length;
    const done = count('done'), running = count('running'), waiting = partRows.length - done - running - count('attention');
    const asking = tasks.reduce((sum, task) => sum + (task.approvals || 0), 0);
    const reviewRow = rows.find(row => row.kind === 'review');
    const summary = asking ? `${asking === 1 ? 'One part needs' : `${asking} parts need`} your approval`
      : done === partRows.length ? (reviewRow?.task && (reviewRow.task.status === 'running' || reviewRow.task.review?.status) ? reviewRow.words : 'Reviewing the combined result')
        : [done ? `${done} done` : '', running ? `${running} working` : '', waiting > 0 ? `${waiting} waiting` : ''].filter(Boolean).join(' · ');
    // The step being worked on: the first with a part not done yet.
    const current = shape ? Math.min(stepCount - 1, ...partRows.filter(row => row.state !== 'done').map(row => row.step)) : 0;
    const shapeWords = { parallel: `${plural(partRows.length, 'part')} side by side`, chain: `${partRows.length} steps, one after another`, mixed: `${plural(partRows.length, 'part')} in ${stepCount} steps`, unknown: plural(partRows.length, 'part') }[layout];
    const where = layout === 'chain' || layout === 'mixed' ? (done === partRows.length ? '' : `Step ${current + 1} of ${stepCount}`) : '';
    // The steps in order, each with its parts, for drawing them grouped. A step with several parts runs them side by side.
    const steps = shape ? Array.from({ length: stepCount }, (_, step) => ({ step, rows: partRows.filter(row => row.step === step) })) : [];
    return { run, rows, steps, layout, stepCount, current, parts: partRows.length, done, running, waiting, asking, summary, where, shape: shapeWords, title: `Working in ${layout === 'chain' ? `${partRows.length} steps` : plural(partRows.length, 'part')}`, allDone: done === partRows.length };
  }

  // A bar with one segment per row, coloured by where it stands. Fills `into` when given, or a new element.
  function bar(model, className = '', into = null) {
    const el = into || node('span', `split-bar ${className}`.trim());
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${model.done} of ${plural(model.parts, 'part')} done`);
    el.replaceChildren(...model.rows.map(row => { const seg = node('span', `split-bar-seg ${row.state}`); seg.title = `${row.label}: ${row.words}`; return seg; }));
    return el;
  }

  const watch = task => api.setTask(task.id).catch(error => api.showNotice?.(error.message));

  function row(item) {
    const { label, task, state, words, agent, provider } = item, li = node('li', `split-progress-row ${state}`);
    const mark = node('span', 'split-progress-mark'); mark.setAttribute('aria-hidden', 'true');
    li.append(mark, node('span', 'split-progress-name', item.step !== undefined ? `${item.step + 1}. ${label}` : label));
    if (agent) { const icon = node('i', `agent-icon ${provider}`); icon.setAttribute('aria-hidden', 'true'); const by = node('span', 'split-progress-agent'); by.append(icon, node('span', '', agent)); li.append(by); }
    li.append(node('span', 'split-progress-state', words));
    if (task?.conversationId) {
      const button = node('button', 'text-link split-progress-open', task.approvals ? 'Answer' : 'Open'); button.type = 'button';
      button.title = `Open “${label}” to watch it work`;
      button.addEventListener('click', () => watch(task));
      li.append(button);
    }
    return li;
  }

  function draw() {
    if (!section) return;
    const state = api.getState(), on = !window.relayFlow || window.relayFlow.isOn();
    const model = on && !state.taskId && !state.taskDraft && state.conversation ? describe(state.conversation) : null;
    section.hidden = !model;
    if (!model) { shownRun = null; return; }
    if (shownRun !== model.run.id) { shownRun = model.run.id; open = false; }
    if (model.asking) open = true;
    $('split-progress-title').textContent = model.title.replace(/^Working/, 'Flow is working on this');
    $('split-progress-summary').textContent = [model.where, model.summary].filter(Boolean).join(' · ');
    section.dataset.attention = String(Boolean(model.asking));
    bar(model, '', $('split-progress-bar'));
    const toggle = $('split-progress-toggle');
    toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Hide parts' : 'Show parts';
    const list = $('split-progress-list');
    list.hidden = !open;
    if (open) list.replaceChildren(...model.rows.map(row));
    $('split-progress-stop').disabled = stopping;
  }

  async function stop() {
    const model = describe(api.getState().conversation);
    if (!model || stopping || !window.confirm('Stop every part? What Flow already merged stays in your folder, and the parts go to the Plan for you to finish.')) return;
    stopping = true; draw();
    try { await api.post('/api/board/stop', { ids: [...model.run.cards, ...(model.run.reviewCardId ? [model.run.reviewCardId] : [])] }); api.announce?.('Stopped the parts.'); }
    catch (error) { api.showNotice?.(error.message); }
    finally { stopping = false; await api.refresh?.(); draw(); }
  }

  window.relaySplitProgress = { describe, bar, watch, stop, stopping: () => stopping };
  if (!section) return;
  $('split-progress-toggle').addEventListener('click', () => { open = !open; draw(); });
  $('split-progress-stop').addEventListener('click', stop);
  window.addEventListener('relay-state', draw);
  window.addEventListener('relay-flow', draw);
  draw();
})();

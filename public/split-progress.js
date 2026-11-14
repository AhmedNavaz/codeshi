// A split message Flow is finishing by itself (src/split-finish.mjs). Its parts aren't on the Plan or in Tasks, so this one
// line above the message box says how far it is. Details lists each part, the review and any repair, with its agent and
// state, and opens a part's conversation to watch it. A part that needs your approval opens the details by itself. Stop
// stops every part, and the parts then go to the Plan for you to finish.
(() => {
  const $ = id => document.getElementById(id), api = window.relayUI, section = $('split-progress');
  if (!section || !api) return;
  const NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const ENDED = { stopped: 'Stopped', failed: 'Didn’t finish', cancelled: 'Cancelled', discarded: 'Discarded', blocked: 'Blocked', lost: 'Its copy is gone', detached: 'Its folder was removed' };
  let open = false, shownRun = null, stopping = false;

  const current = () => {
    const state = api.getState(), c = state.conversation;
    if (state.taskId || state.taskDraft || !c) return null;
    return (c.splitRuns || []).findLast(run => run.status === 'working') || null;
  };
  const tasksOf = run => (api.getState().conversation?.parallelTasks || []).filter(task => task.splitId === run.id);
  const who = task => {
    const provider = task?.runningProvider || task?.provider;
    if (!provider) return '';
    const modelId = task.runningModel || task.model, model = modelId ? window.relayModelPicker?.modelName?.(provider, modelId) || modelId : '';
    return [NAMES[provider] || provider, model].filter(Boolean).join(' · ');
  };
  // Where one part stands, as [kind, words]. kind is done, running, waiting or attention.
  function stateOf(task, { review = false } = {}) {
    if (!task) return ['waiting', 'Waiting to start'];
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

  function row(label, task, options) {
    const [kind, words] = stateOf(task, options), item = node('li', `split-progress-row ${kind}`);
    const mark = node('span', 'split-progress-mark'); mark.setAttribute('aria-hidden', 'true');
    const main = node('span', 'split-progress-name', label), detail = node('span', 'split-progress-state', words), agent = who(task);
    item.append(mark, main);
    if (agent) { const icon = node('i', `agent-icon ${task.runningProvider || task.provider}`); icon.setAttribute('aria-hidden', 'true'); const by = node('span', 'split-progress-agent'); by.append(icon, node('span', '', agent)); item.append(by); }
    item.append(detail);
    if (task?.conversationId) {
      const watch = node('button', 'text-link split-progress-open', task.approvals ? 'Answer' : 'Open'); watch.type = 'button';
      watch.title = `Open “${label}” to watch it work`;
      watch.addEventListener('click', () => api.setTask(task.id).catch(error => api.showNotice?.(error.message)));
      item.append(watch);
    }
    return item;
  }

  function draw() {
    const run = current();
    section.hidden = !run;
    if (!run) { shownRun = null; return; }
    if (shownRun !== run.id) { shownRun = run.id; open = false; }
    const tasks = tasksOf(run), forCard = id => tasks.filter(task => task.board?.cardId === id).at(-1) || null;
    const parts = run.cards.map(id => forCard(id)), review = run.reviewCardId ? forCard(run.reviewCardId) : null, repairs = tasks.filter(task => task.splitRepair);
    const states = parts.map(task => stateOf(task)[0]), done = states.filter(kind => kind === 'done').length, working = states.filter(kind => kind === 'running').length;
    const asking = tasks.reduce((sum, task) => sum + (task.approvals || 0), 0);
    if (asking) open = true;
    const summary = done === parts.length
      ? (review?.status === 'running' || review?.review?.status ? stateOf(review, { review: true })[1] : 'Reviewing the combined result')
      : [done ? `${done} done` : '', working ? `${working} working` : '', parts.length - done - working ? `${parts.length - done - working} waiting` : ''].filter(Boolean).join(' · ');
    $('split-progress-title').textContent = `Flow is working on this in ${plural(parts.length, 'part')}`;
    $('split-progress-summary').textContent = asking ? `${asking === 1 ? 'One part needs' : `${asking} parts need`} your approval` : summary;
    section.dataset.attention = String(Boolean(asking));
    const toggle = $('split-progress-toggle');
    toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Hide parts' : 'Show parts';
    const list = $('split-progress-list');
    list.hidden = !open;
    if (open) {
      // Card titles come from the tasks, which carry them.
      const rows = parts.map((task, index) => row(task?.title || `Part ${index + 1}`, task));
      for (const task of repairs) rows.push(row(task.title, task));
      if (run.reviewCardId) rows.push(row('Review of the combined result', review, { review: true }));
      list.replaceChildren(...rows);
    }
    $('split-progress-stop').disabled = stopping;
  }

  $('split-progress-toggle').addEventListener('click', () => { open = !open; draw(); });
  $('split-progress-stop').addEventListener('click', async () => {
    const run = current();
    if (!run || stopping || !window.confirm('Stop every part? What Flow already merged stays in your folder, and the parts go to the Plan for you to finish.')) return;
    stopping = true; draw();
    try { await api.post('/api/board/stop', { ids: [...run.cards, ...(run.reviewCardId ? [run.reviewCardId] : [])] }); api.announce?.('Stopped the parts.'); }
    catch (error) { api.showNotice?.(error.message); }
    finally { stopping = false; await api.refresh?.(); draw(); }
  });
  window.addEventListener('relay-state', draw);
  draw();
})();

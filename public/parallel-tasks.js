(() => {
  'use strict';
  // Independent tasks in one workspace (#88, #192). The sidebar lists them under the workspace: all of them and the main
  // conversation when the workspace is selected, and only its own when a folder is. Tasks sort by what they need — Needs you
  // first, then Working, then Finished (folded after the latest few) — with a second line for state, agent and time while
  // active or waiting on you, and one line once finished.
  const $ = id => document.getElementById(id), api = window.relayUI, section = $('task-section'), list = $('task-list'), banner = $('task-banner');
  if (!api || !section || !list || !banner) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'text-link') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  // A split's parts that Flow is finishing by itself show above the message box instead (split-progress.js).
  // The Plan chat (#162) belongs to the Plan view, which lists it with the cards' tasks, so it isn't listed here.
  const tasks = () => (api.getState().conversation?.parallelTasks || []).filter(task => task.purpose !== 'plan-chat' && ((task.purpose !== 'project-review' && !task.managed) || task.id === api.getState().taskId || (task.purpose === 'project-review' && task.approvals)));
  const LABEL = { waiting: 'Waiting', running: 'Working', complete: 'Finished', stopped: 'Stopped', failed: 'Did not finish', integrated: 'Merged', kept: 'Kept as a branch', discarded: 'Discarded', cancelled: 'Cancelled', blocked: 'Blocked', lost: 'Copy gone', detached: 'Folder removed' };
  const AGENT = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  const DONE = new Set(['complete', 'integrated', 'kept']), LIVE = new Set(['waiting', 'running']), UNFINISHED = new Set(['failed', 'blocked', 'lost', 'detached']), FAILED = new Set(['failed', 'blocked', 'lost']);
  const FINISHED_VISIBLE = 3;
  // What the copy has that a fresh checkout wouldn't, and the secrets it doesn't have.
  const copyNote = setup => {
    if (!setup) return '';
    const parts = [], deps = setup.dependencies || [], linked = deps.filter(item => item.how === 'link');
    if (deps.length && !linked.length) parts.push(`It has its own copy of the installed ${deps.length === 1 ? 'node_modules' : `node_modules folders (${deps.length})`}.`);
    else if (linked.length) parts.push(`${linked.length === 1 ? 'Its node_modules is' : 'Its node_modules folders are'} shared with ${linked.length === deps.length ? 'the folder' : 'the folder where they couldn’t be copied'}, so installing packages in the task changes the folder’s too.`);
    const missing = setup.missing || [];
    if (missing.length) parts.push(`It has no ${missing.length > 3 ? `${missing.slice(0, 3).join(', ')} and ${missing.length - 3} more` : missing.join(', ')}, as secrets aren’t copied.`);
    return parts.length ? ` ${parts.join(' ')}` : '';
  };
  // What a copy was made from: the last commit, with the files the work before it merged into the folder since (which
  // aren't in that commit), and without the folder's other uncommitted changes.
  const copyFrom = task => {
    const carried = task.carried?.files || 0, left = task.uncommitted || 0;
    const has = carried ? `, with the ${carried === 1 ? 'file' : `${carried} files`} merged by the work before it` : '';
    const lacks = left ? `${carried ? ' and' : ','} without ${left} ${carried ? 'other ' : ''}uncommitted change${left === 1 ? '' : 's'} in the folder` : '';
    return `Works in its own copy from the last commit${has}${lacks}.`;
  };
  const canMerge = task => Boolean(task.hasWorktree && ['complete', 'stopped', 'failed'].includes(task.status));
  const taskNeedsYou = task => Boolean(task.approvals > 0 || canMerge(task) || (task.status === 'waiting' && task.held));
  const act = async (task, action, input = {}) => { const result = await api.post(`/api/tasks/${task.id}/${action}`, input); await api.refresh(); return result; };
  const attempt = work => work().catch(error => api.showNotice(error.message));
  // Closing a task only takes it off the list, but nothing in Codeshi lists it again, so the button says that and asks first.
  const REMOVE = 'Remove from list';
  const stays = task => {
    const folder = task.folderName || 'the folder';
    if (task.status === 'integrated') return `Its merged changes stay in ${folder}.`;
    if (task.status === 'kept') return task.integration?.branch ? `The branch ${task.integration.branch} stays.` : 'Its branch stays.';
    if (task.mode !== 'worktree' && !['discarded', 'cancelled', 'detached'].includes(task.status)) return `What it changed in ${folder} stays.`;
    return 'Nothing in your folders changes.';
  };
  const confirmRemove = task => window.confirm(`Remove “${task.title || 'this task'}” from the task list?\n\n${stays(task)} You won’t be able to open its chat again.`);
  const removeTask = (task, after) => { if (confirmRemove(task)) return attempt(async () => { await act(task, 'close'); api.announce('Task removed from the list.'); await after?.(); }); };
  let focused = null, signature = null, planRequest = 0, review = null, reviewing = null, showAllFinished = false, finishedProject = null, liveTicker = null;

  const folders = () => { const state = api.getState(); return state.projects?.find(project => project.id === state.projectId)?.folders || []; };
  const isMultiFolder = level => level === 'workspace' && folders().length > 1;
  const elapsedWord = ms => {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60), rem = mins % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  };
  const agoWord = value => {
    const stamp = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(stamp)) return '';
    const diff = Math.max(0, Date.now() - stamp), mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  function taskBucket(task) {
    if (task.approvals > 0) return { bucket: 0, subRank: 0 };
    if (canMerge(task)) return { bucket: 0, subRank: 1 };
    if (task.status === 'waiting' && task.held) return { bucket: 0, subRank: 2 };
    if (task.status === 'running' || task.testing) return { bucket: 1, subRank: 0 };
    if (task.status === 'waiting') return { bucket: 1, subRank: 1 };
    return { bucket: 2, subRank: 0 };
  }
  function taskVisualState(task) {
    if (task.approvals > 0) return task.questions > 0 && task.questions === task.approvals ? 'question' : 'approval';
    if (canMerge(task)) return 'review';
    if (task.status === 'waiting' && task.held) return 'paused';
    if (task.status === 'running' || task.testing) return 'working';
    if (task.status === 'waiting') return 'waiting';
    if (DONE.has(task.status)) return 'finished';
    if (FAILED.has(task.status)) return 'failed';
    return 'stopped';
  }
  function taskStateWord(task) {
    if (task.approvals > 0) {
      if (task.questions > 0 && task.questions === task.approvals) return task.questions === 1 ? 'Needs your answer' : `${task.questions} questions`;
      if (task.questions > 0) return `${task.approvals} waiting for you`;
      return task.approvals === 1 ? 'Needs approval' : `${task.approvals} approvals`;
    }
    if (canMerge(task)) {
      if (task.testing) return 'Checking combined result';
      if (task.status === 'failed') return 'Did not finish · review copy';
      if (task.status === 'stopped') return 'Stopped · review copy';
      return 'Ready to review';
    }
    if (task.status === 'waiting' && task.held) return 'Paused · ready to start';
    if (task.testing) return 'Running tests';
    if (task.status === 'running') return task.resolving?.open ? 'Resolving conflicts' : 'Working';
    if (task.status === 'waiting') return 'Waiting to start';
    return LABEL[task.status] || task.status;
  }
  function taskTimeWord(task) {
    if (task.status === 'running' || task.testing) {
      if (task.usage && (task.usage.workedMs > 0 || task.usage.activeSince)) {
        const activeMs = task.usage.activeSince ? Math.max(0, Date.now() - Date.parse(task.usage.activeSince)) : 0;
        return elapsedWord((task.usage.workedMs || 0) + activeMs);
      }
      const stamp = Date.parse(task.runningStartedAt || task.createdAt || '');
      return Number.isFinite(stamp) ? elapsedWord(Math.max(0, Date.now() - stamp)) : '';
    }
    if (canMerge(task)) {
      if (task.endedAt) return agoWord(task.endedAt);
      if (task.usage?.workedMs > 0) return elapsedWord(task.usage.workedMs);
      return agoWord(task.createdAt);
    }
    if (task.status === 'waiting' || task.approvals > 0) return agoWord(task.endedAt || task.createdAt);
    return '';
  }

  async function selectThread(task) {
    focused = task?.id || null;
    // A task that hasn't started has no conversation yet, so its details show without leaving this one.
    if (!task || task.conversationId) await api.setTask(task?.id || null);
    else if (api.getState().taskDraft) await api.setTask(null);
    render(true);
  }
  // A task's own view carries the steps but not their plan, so the plan's name and the workspace chat's details are kept
  // from the last time the workspace chat was shown.
  const plans = new Map(); let mainId = null, mainProject = null, mainProvider = null, mainStartedAt = null, totals = new Map(), totalsKey = null, totalsRequest = 0;
  function remember(state) {
    if (mainProject !== state.projectId) { plans.clear(); totals = new Map(); totalsKey = null; mainId = null; mainProvider = null; mainStartedAt = null; mainProject = state.projectId; }
    if (state.taskId || state.taskDraft || !state.conversation?.id) return;
    mainId = state.conversation.id;
    mainProvider = state.conversation.activeRun?.provider || state.conversation.provider || null;
    mainStartedAt = state.conversation.activeRun?.startedAt || null;
    for (const plan of state.conversation.orchestrations || []) plans.set(plan.id, plan);
  }
  // The conversation that belongs to the whole workspace, set apart from the tasks under it: one quiet line when idle, and
  // a second line with state, agent and time when working or waiting on you.
  function mainRow(state) {
    const selected = !state.taskDraft && !state.taskId && !focused, row = node('li', 'task-row-holder'), item = node('button', `task-row task-row-main${selected ? ' active' : ''}`); item.type = 'button';
    if (selected) item.setAttribute('aria-current', 'true');
    item.title = 'Workspace chat, across every folder in this workspace';
    const elsewhere = Boolean(state.taskId || state.taskDraft), running = elsewhere ? Boolean(state.status?.runningConversationId) : api.isRunning();
    const pending = elsewhere ? (state.status?.pendingApprovals || []) : (state.conversation?.pendingApprovals || []);
    const waiting = pending.length, allQuestions = waiting > 0 && pending.every(entry => entry.kind === 'question');
    const visual = waiting ? (allQuestions ? 'question' : 'approval') : running ? 'working' : 'idle';
    const mark = node('span', 'task-row-main-icon'); mark.setAttribute('aria-hidden', 'true');
    item.dataset.status = running ? 'running' : 'idle';
    item.dataset.state = visual;
    if (waiting || running) {
      item.classList.add('task-row-detailed');
      const head = node('span', 'task-row-head');
      head.append(node('span', 'task-row-title', 'Workspace chat'));
      if (waiting) head.append(node('span', 'task-row-badge', String(waiting)));
      const stateWord = waiting ? (allQuestions ? (waiting === 1 ? 'Needs your answer' : `${waiting} questions`) : pending.some(entry => entry.kind === 'question') ? `${waiting} waiting for you` : (waiting === 1 ? 'Needs approval' : `${waiting} approvals`)) : 'Working';
      const provider = elsewhere ? (state.status?.runningProvider || mainProvider) : (state.conversation?.activeRun?.provider || state.conversation?.provider);
      const startedAt = elsewhere ? (state.status?.runningStartedAt || mainStartedAt) : state.conversation?.activeRun?.startedAt;
      const stamp = startedAt ? Date.parse(startedAt) : NaN, timeWord = Number.isFinite(stamp) ? elapsedWord(Math.max(0, Date.now() - stamp)) : '';
      const meta = node('span', 'task-row-meta');
      meta.append(node('span', 'task-row-state', stateWord));
      const rest = [AGENT[provider] || '', timeWord].filter(Boolean).join(' · ');
      if (rest) meta.append(node('span', 'task-row-sub', ` · ${rest}`));
      const body = node('span', 'task-row-body'); body.append(head, meta);
      item.append(mark, body);
    } else {
      item.append(mark, node('span', 'task-row-title', 'Workspace chat'));
    }
    item.addEventListener('click', () => attempt(() => selectThread(null)));
    row.append(item);
    return row;
  }
  function taskRow(task, state, level) {
    const selected = !state.taskDraft && (focused || state.taskId) === task.id, { bucket } = taskBucket(task), visual = taskVisualState(task), detailed = bucket < 2;
    const showFolder = isMultiFolder(level) && Boolean(task.folderName);
    const row = node('li', 'task-row-holder'), item = node('button', `task-row${detailed ? ' task-row-detailed' : ''}${selected ? ' active' : ''}`); item.type = 'button';
    item.dataset.status = task.status;
    item.dataset.state = visual;
    item.dataset.priority = bucket === 0 ? 'needs-you' : bucket === 1 ? 'working' : 'finished';
    if (selected) item.setAttribute('aria-current', 'true');
    const stateWord = taskStateWord(task);
    item.title = [task.title, showFolder ? task.folderName : '', stateWord].filter(Boolean).join(' · ');
    const icon = node('span', 'task-row-icon'); icon.setAttribute('aria-hidden', 'true');
    if (detailed) {
      const head = node('span', 'task-row-head');
      head.append(node('span', 'task-row-title', task.title));
      if (showFolder) head.append(node('span', 'task-row-folder', task.folderName));
      if (task.approvals) head.append(node('span', 'task-row-badge', String(task.approvals)));
      else if (canMerge(task)) head.append(node('span', 'task-row-review', 'Review'));
      const meta = node('span', 'task-row-meta');
      meta.append(node('span', 'task-row-state', stateWord));
      const provider = (task.status === 'running' && task.runningProvider) || task.provider;
      const rest = [AGENT[provider] || '', taskTimeWord(task)].filter(Boolean).join(' · ');
      if (rest) meta.append(node('span', 'task-row-sub', ` · ${rest}`));
      const body = node('span', 'task-row-body'); body.append(head, meta);
      item.append(icon, body);
    } else {
      item.append(icon, node('span', 'task-row-title', task.title));
      if (showFolder) item.append(node('span', 'task-row-folder', task.folderName));
    }
    item.addEventListener('click', () => attempt(() => selectThread(task)));
    row.append(item);
    return row;
  }

  // A plan's group (#108): where the plan stands, what it used once it has ended, and one action to close it. An ended
  // group that needs nothing from you folds into its one row, and opens again on a click.
  const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  const duration = ms => { const seconds = Math.max(1, Math.round(ms / 1000)); if (seconds < 3600) return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; const minutes = Math.round(seconds / 60); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; };
  const compact = value => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e4 || (value >= 1e3 && value % 1000 === 0) ? `${Math.round(value / 1e3)}k` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value);
  const FOLDS = 'codeshi:plan-groups';
  // What you chose for each plan's group, open or folded. Without a choice, an ended group that needs nothing folds.
  let folds = {}; try { folds = JSON.parse(localStorage.getItem(FOLDS) || '{}') || {}; } catch { /* A convenience only. */ }
  const needsYou = steps => steps.reduce((count, task) => count + (taskNeedsYou(task) ? 1 : 0), 0);
  function groupResult(steps) {
    const done = steps.filter(task => DONE.has(task.status)).length, live = steps.some(task => LIVE.has(task.status)), unfinished = steps.filter(task => UNFINISHED.has(task.status)).length;
    if (live) return { state: 'running', ended: false, text: `${done} of ${steps.length} done` };
    if (unfinished) return { state: 'failed', ended: true, text: `${unfinished} didn’t finish` };
    if (done === steps.length) return { state: 'done', ended: true, text: 'Finished' };
    return { state: 'stopped', ended: true, text: `Stopped, ${done} of ${steps.length} done` };
  }
  function folded(id, steps, result, state) {
    if (steps.some(task => task.id === (focused || state.taskId))) return false;
    return folds[id] ?? (result.ended && !needsYou(steps));
  }
  function toggle(id, closed) {
    folds[id] = closed;
    const keys = Object.keys(folds); for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete folds[key];
    try { localStorage.setItem(FOLDS, JSON.stringify(folds)); } catch { /* A convenience only. */ }
    render(true);
  }
  // The whole plan's usage, from the same ledger as the Tasks panel: its planning run and every step, with their retries,
  // handoffs and reviews. Asked for only when a group has ended, and again only when a step's state changes.
  function totalText(total) {
    if (!total) return '';
    const usage = total.usage, tokens = usage?.runsWithTokens ? (usage.input || 0) + (usage.output || 0) + (usage.cacheWrite || 0) : null;
    const partial = usage && (usage.runsWithTokens < usage.runs || usage.partialRuns);
    return [plural(total.steps, 'step'), duration(total.workingMs || 0), tokens === null ? 'tokens not reported' : `${partial ? 'at least ' : ''}${compact(tokens)} new tokens`].join(' · ');
  }
  async function loadTotals() {
    const state = api.getState(), ended = [];
    const groups = new Map(); for (const task of tasks()) if (task.plan) groups.set(task.plan.id, [...(groups.get(task.plan.id) || []), task]);
    for (const [id, steps] of groups) if (groupResult(steps).ended) ended.push([id, steps.map(task => task.status)]);
    const key = ended.length ? JSON.stringify([state.projectId, ended]) : null;
    if (key === totalsKey) return;
    totalsKey = key;
    if (!key) return;
    const request = ++totalsRequest;
    try {
      const ledger = await api.api('/api/ledger');
      if (request !== totalsRequest) return;
      totals = new Map((ledger?.plans || []).map(plan => [plan.id, plan]));
      render(true);
    } catch { if (request === totalsRequest) totalsKey = null; }
  }
  async function closePlan(id, steps, name) {
    const merged = steps.some(task => task.status === 'integrated' || (task.mode !== 'worktree' && !['discarded', 'cancelled', 'detached'].includes(task.status)));
    if (!window.confirm(`Remove the plan “${name}” and its ${plural(steps.length, 'step')} from the task list?\n\n${merged ? 'What its steps changed in your folders stays.' : 'Nothing in your folders changes.'} You won’t be able to open their chats again.`)) return;
    const state = api.getState(), inside = steps.some(task => task.id === (focused || state.taskId));
    await api.post(`/api/conversations/${encodeURIComponent(mainId)}/orchestration`, { action: 'close', id });
    if (inside) await selectThread(null);
    await api.refresh(); api.announce('Plan removed from the list.');
  }
  function groupRow(id, steps, result, state) {
    const plan = plans.get(id), name = plan?.summary || plan?.goal || 'Steps', closed = folded(id, steps, result, state), waiting = needsYou(steps);
    const row = node('li', 'task-group-holder'), head = node('button', 'task-group'); head.type = 'button';
    row.dataset.status = result.state;
    head.setAttribute('aria-expanded', String(!closed));
    const chevron = node('span', 'task-group-chevron'); chevron.setAttribute('aria-hidden', 'true');
    const mark = node('span', 'task-group-icon'); mark.setAttribute('aria-hidden', 'true');
    head.append(chevron, mark, node('span', 'task-group-title', `Plan · ${name}`));
    if (closed && waiting) head.append(node('span', 'task-row-badge', String(waiting)));
    else head.append(node('span', 'task-group-side', result.text));
    const total = result.ended ? totalText(totals.get(id)) : '';
    head.title = [`Plan · ${name}`, result.text, total, closed && waiting ? `${plural(waiting, 'step')} need${waiting === 1 ? 's' : ''} you` : ''].filter(Boolean).join(' · ');
    head.addEventListener('click', () => toggle(id, !closed));
    row.append(head);
    // Takes the whole plan off the list, which the plan allows once nothing works, waits or is left to merge. It asks first.
    if (result.ended && mainId && !steps.some(task => task.hasWorktree) && plan?.status !== 'closed') {
      const close = node('button', 'icon-button task-group-close'); close.type = 'button'; close.title = 'Remove plan from list'; close.setAttribute('aria-label', `Remove plan ${name} from the list`);
      close.addEventListener('click', () => attempt(() => closePlan(id, steps, name)));
      row.append(close);
    }
    if (total) row.append(node('span', 'task-group-total', total));
    return row;
  }
  const stampOf = task => { const value = Date.parse(task.endedAt || task.createdAt || ''); return Number.isFinite(value) ? value : null; };
  function syncTicker(hasLive) {
    if (hasLive && !liveTicker && typeof setInterval === 'function') {
      liveTicker = setInterval(() => { if (!document.hidden) render(true); }, 30000);
    } else if (!hasLive && liveTicker) {
      clearInterval(liveTicker);
      liveTicker = null;
    }
  }
  function renderList() {
    const state = api.getState(), level = api.sidebarLevel?.() || 'single', chosen = api.selectedFolderId?.();
    if (finishedProject !== state.projectId) { finishedProject = state.projectId; showAllFinished = false; }
    section.hidden = !state.projectId || window.relayExperimental?.enabled('tasks') === false;
    // A folder shows its own tasks. The main conversation spans every folder, so it shows with the workspace.
    const shown = level === 'folder' ? tasks().filter(task => task.folderId === chosen) : tasks();
    const blank = state.taskDraft ? (() => { const row = node('li', 'task-row-holder'), item = node('div', 'task-row task-row-draft active'), mark = node('span', 'task-row-draft-icon'); mark.setAttribute('aria-hidden', 'true'); item.setAttribute('aria-current', 'true'); item.append(mark, node('span', 'task-row-title task-row-draft-title', draftTitle())); row.append(item); return [row]; })() : [];
    // Build sortable entries: standalone tasks and plan groups (#108, #192).
    const entries = [], seen = new Set();
    shown.forEach((task, index) => {
      if (!task.plan) {
        const { bucket, subRank } = taskBucket(task);
        entries.push({ kind: 'task', task, bucket, subRank, stamp: stampOf(task), index });
        return;
      }
      if (seen.has(task.plan.id)) return;
      seen.add(task.plan.id);
      const steps = shown.filter(item => item.plan?.id === task.plan.id).sort((a, b) => a.plan.number - b.plan.number), result = groupResult(steps);
      const stepBuckets = steps.map(taskBucket), bucket = Math.min(...stepBuckets.map(item => item.bucket));
      const subRank = Math.min(...stepBuckets.filter(item => item.bucket === bucket).map(item => item.subRank));
      const stamps = steps.map(stampOf).filter(value => value !== null);
      entries.push({ kind: 'group', id: task.plan.id, steps, result, bucket, subRank, stamp: stamps.length ? Math.max(...stamps) : null, index });
    });
    entries.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.bucket < 2) return a.subRank - b.subRank || a.index - b.index;
      if (a.stamp !== null && b.stamp !== null && a.stamp !== b.stamp) return b.stamp - a.stamp;
      return b.index - a.index;
    });
    const activeEntries = entries.filter(entry => entry.bucket < 2), finishedEntries = entries.filter(entry => entry.bucket === 2);
    const currentId = !state.taskDraft ? (focused || state.taskId) : null;
    const isCurrent = entry => entry.kind === 'task' ? entry.task.id === currentId : entry.steps.some(step => step.id === currentId);
    const hiddenFinished = finishedEntries.slice(FINISHED_VISIBLE).filter(entry => !isCurrent(entry));
    const visibleFinished = showAllFinished || !hiddenFinished.length ? finishedEntries : [...finishedEntries.slice(0, FINISHED_VISIBLE), ...finishedEntries.slice(FINISHED_VISIBLE).filter(isCurrent)];
    const renderEntry = entry => {
      if (entry.kind === 'task') return [taskRow(entry.task, state, level)];
      const rows = [groupRow(entry.id, entry.steps, entry.result, state)];
      if (!folded(entry.id, entry.steps, entry.result, state)) rows.push(...entry.steps.map(item => { const row = taskRow(item, state, level); row.classList.add('task-row-step'); return row; }));
      return rows;
    };
    const sortedRows = [...activeEntries.flatMap(renderEntry), ...visibleFinished.flatMap(renderEntry)];
    if (hiddenFinished.length) {
      const holder = node('li', 'task-earlier-holder'), toggleBtn = node('button', 'task-earlier'); toggleBtn.type = 'button';
      toggleBtn.setAttribute('aria-expanded', String(showAllFinished));
      const chevron = node('span', 'task-earlier-chevron'); chevron.setAttribute('aria-hidden', 'true');
      toggleBtn.append(chevron, node('span', 'task-earlier-label', showAllFinished ? 'Show fewer' : `${hiddenFinished.length} earlier`));
      toggleBtn.addEventListener('click', () => { showAllFinished = !showAllFinished; render(true); });
      holder.append(toggleBtn);
      sortedRows.push(holder);
    }
    const rows = [...(level === 'folder' ? [] : [mainRow(state)]), ...blank, ...sortedRows];
    // The + is for a folder: at the workspace level, nothing says where a task would go.
    $('new-task').hidden = level === 'workspace';
    if (!rows.length) { const folder = folders().find(item => item.id === chosen); rows.push(node('li', 'task-list-empty', `No tasks in ${folder?.displayName || folder?.name || 'this folder'} yet.`)); }
    list.replaceChildren(...rows);
    const allTasks = tasks(), running = allTasks.filter(task => task.status === 'running').length, needing = allTasks.filter(taskNeedsYou).length;
    $('task-count').hidden = !shown.length;
    $('task-count').textContent = String(shown.length);
    $('task-count').title = [needing ? `${needing} needing you` : '', running ? `${running} working` : ''].filter(Boolean).join(' · ');
    const mainLive = level !== 'folder' && Boolean(state.taskId || state.taskDraft ? (state.status?.runningConversationId || state.status?.pendingApprovals?.length) : (api.isRunning() || state.conversation?.pendingApprovals?.length));
    syncTicker(!section.hidden && (activeEntries.length > 0 || mainLive));
  }
  function renderBanner() {
    const state = api.getState(), task = tasks().find(item => item.id === (focused || state.taskId));
    // In the Plan view (#162) the Plan chat needs no banner: the Plan's thread bar names it. A card's task says it's a card's,
    // and goes back to the Plan chat rather than the Workspace chat, which the Plan view doesn't show.
    const plan = window.relayBoard?.isOpen?.() === true;
    banner.hidden = !task || Boolean(state.taskDraft) || task.purpose === 'plan-chat';
    if (!task || task.purpose === 'plan-chat') return;
    const text = node('div', 'task-banner-text');
    // Says which conversation this is by name, so a task's chat can't be mistaken for the workspace chat.
    // In the Plan view the card's tab in the thread bar already shows its state, so the banner leaves it to the tooltip.
    const status = LABEL[task.status] || task.status;
    const title = node('strong', 'task-banner-title'), name = node('span', 'task-banner-name', task.title || 'Task'); name.title = plan ? `${task.title || 'Task'} · ${status}` : task.title || '';
    title.append(node('span', 'task-banner-kind', task.board ? 'Card' : 'Task'), name);
    if (!plan) title.append(node('span', 'task-banner-state', `${task.folderName} · ${status}`));
    text.append(title);
    const how = task.reason || (task.resolving?.open ? (task.status === 'running' ? 'Resolving its merge conflicts in its own copy. You review the combined result before it’s merged.' : 'Resolving its merge conflicts isn’t finished. Answer the agent here, or review and merge it to resolve again.') : task.mode === 'worktree' ? `${copyFrom(task)} You review its changes before they’re merged.${copyNote(task.setup)}` : task.mode === 'direct' ? 'Works directly in this folder.' : '');
    if (task.status === 'integrated') {
      const detail = node('span', 'task-banner-detail', `${task.integration?.files || 0} file${task.integration?.files === 1 ? '' : 's'} merged into ${task.folderName}.`);
      const changed = (task.integration?.changes || []).map(item => item.path).filter(Boolean);
      if (changed.length) detail.title = changed.join('\n');
      text.append(detail);
    }
    else if (task.status === 'kept') text.append(node('span', 'task-banner-detail', `Saved as the branch ${task.integration?.branch}. Nothing was merged.`));
    // One line: the first sentence says how it runs, and the rest is in the tooltip and read out in full.
    else if (how && !(plan && task.mode === 'direct' && !task.reason)) { const detail = node('span', 'task-banner-detail', how); detail.title = how; text.append(detail); }
    const actions = node('div', 'task-banner-actions');
    if (canMerge(task)) actions.append(button('Review and merge', () => attempt(() => openReview(task)), 'primary-button'), button('Discard', () => attempt(() => act(task, 'discard').then(() => api.announce('The task’s copy was discarded.')))));
    if (task.status === 'waiting') {
      if (task.held) actions.append(button('Start', () => attempt(() => act(task, 'start')), 'secondary-button'));
      actions.append(button('Cancel', () => attempt(() => act(task, 'discard'))));
    }
    if (!['running', 'waiting'].includes(task.status) && !canMerge(task)) { const remove = button(REMOVE, () => removeTask(task, () => plan ? window.relayBoard.openChat() : selectThread(null))); remove.title = `Take this task off the list. ${stays(task)}`; actions.append(remove); }
    if (!plan && !focused) actions.append(button('Workspace chat', () => attempt(() => selectThread(null)), 'secondary-button task-banner-back'));
    banner.dataset.status = task.status;
    banner.replaceChildren(text, actions);
  }
  function render(force = false) {
    const state = api.getState();
    // A blank task belongs to its folder, so going to the workspace or another folder puts it away. What was typed is kept.
    if (state.taskDraft && (api.sidebarLevel?.() === 'workspace' || (api.sidebarLevel?.() === 'folder' && api.selectedFolderId?.() !== state.taskDraft.folderId))) { attempt(() => selectThread(null)); return; }
    remember(state);
    const key = JSON.stringify([state.projectId, state.taskId, state.taskDraft, state.provider, state.mode, state.approvalPolicy, focused, showAllFinished, folders().length, window.relayExperimental?.enabled('tasks') !== false, api.sidebarLevel?.(), api.selectedFolderId?.(), state.conversation?.status, state.conversation?.activeRun?.provider, state.conversation?.activeRun?.startedAt, state.conversation?.pendingApprovals?.map(entry => entry.kind || 'approval'), state.status?.runningConversationId, state.status?.runningProvider, state.status?.runningStartedAt, state.status?.pendingApprovals?.map(entry => entry.kind || 'approval'), tasks().map(task => [task.id, task.status, task.approvals, task.questions, task.testing, task.provider, task.runningProvider, task.runningStartedAt, task.createdAt, task.endedAt, task.usage?.workedMs, task.usage?.activeSince, task.reason, task.hasWorktree, task.held, task.title, task.folderId, task.folderName, task.resolving?.open, task.carried?.files, task.uncommitted]), [...plans.values()].map(plan => [plan.id, plan.status, plan.summary || plan.goal])]);
    if (focused && !tasks().some(task => task.id === focused)) focused = null;
    if (!force && key === signature) return;
    signature = key; renderList(); renderBanner(); renderDraft(); loadTotals();
  }

  // Starting a task. The folder is the one selected, so there's nothing to ask: + opens a blank task in the middle, with the
  // real composer. The page says how it would run, what else is running and what it will know, while there's still time to change it.
  const draftFolder = () => folders().find(folder => folder.id === api.getState().taskDraft?.folderId);
  const folderName = folder => folder?.displayName || folder?.name || 'this folder';
  let planKey = null, knownKey = null;
  async function openDraft(folderId) {
    if (window.relayExperimental?.enabled('tasks') === false) { api.showNotice?.('Tasks side by side is turned off. Turn it on in Settings › Experimental.'); return; }
    const state = api.getState();
    if (!state.projectId) return;
    if (api.sidebarLevel?.() === 'workspace') api.showFolderLevel?.();
    const chosen = folders().some(folder => folder.id === folderId) ? folderId : api.selectedFolderId?.() || folders()[0]?.id;
    if (!chosen) return;
    if (folderId && api.selectedFolderId?.() !== chosen) api.selectFolder?.(chosen);
    if (state.taskDraft?.folderId === chosen) { $('message-input').focus?.(); return; }
    focused = null; planKey = knownKey = null;
    $('task-draft-history').checked = false; $('task-draft-after').value = '';
    await api.openTaskDraft(chosen);
  }
  $('new-task').addEventListener('click', () => attempt(openDraft));
  $('task-draft-cancel').addEventListener('click', () => attempt(() => selectThread(null)));
  // How it would run depends on the agent and access chosen and on what's running, so it's worked out again when those change.
  async function refreshPlan() {
    const state = api.getState(), folderId = state.taskDraft?.folderId;
    if (!folderId) return;
    const running = tasks().filter(task => task.status === 'running').map(task => task.id), key = JSON.stringify([folderId, state.provider, state.mode, state.approvalPolicy, running, state.status?.runningConversationId]);
    if (key === planKey) return;
    planKey = key;
    const host = $('task-draft-plan'), request = ++planRequest;
    try {
      const result = await api.post('/api/tasks/plan', { folderId, provider: state.provider, accessMode: state.mode, approvalPolicy: state.approvalPolicy || 'ask' });
      if (request !== planRequest) return;
      host.dataset.mode = result.full ? 'wait' : result.mode;
      const parts = [result.reason];
      if (result.uncommitted) parts.push(`${result.uncommitted} uncommitted change${result.uncommitted === 1 ? ' isn’t' : 's aren’t'} included.`);
      if (result.full) parts.push(`All ${result.limit} task slots are in use, so it starts when one frees up. **Tasks at once** in the task limits changes that.`.replace(/\*\*/g, ''));
      host.textContent = parts.join(' ');
    } catch (error) { if (request === planRequest) { host.textContent = error.message; host.dataset.mode = 'error'; } }
  }
  function renderDraft() {
    const state = api.getState(), draft = state.taskDraft, card = $('task-draft');
    card.hidden = !draft;
    if (!draft) return;
    const name = folderName(draftFolder());
    $('task-draft-title').textContent = `New task in ${name}`;
    const list = tasks(), beside = list.filter(task => task.status === 'running').map(task => `${task.folderName}: ${task.title}`);
    if (state.status?.runningConversationId) beside.unshift('Workspace chat');
    $('task-draft-beside').textContent = beside.length ? beside.join(' · ') : 'Nothing else is running.';
    const waitable = list.filter(task => !['discarded', 'cancelled', 'lost', 'detached'].includes(task.status)), chosen = $('task-draft-after').value;
    $('task-draft-after-row').hidden = !waitable.length;
    $('task-draft-after').replaceChildren(node('option', '', 'Nothing, start when it can'), ...waitable.map(task => { const option = node('option', '', `${task.folderName}: ${task.title}`); option.value = task.id; return option; }));
    $('task-draft-after').firstChild.value = ''; $('task-draft-after').value = waitable.some(task => task.id === chosen) ? chosen : '';
    refreshPlan();
    refreshKnown(draft.folderId);
  }
  // What goes with it: only what the person chose to keep, and what applies to this folder.
  async function refreshKnown(folderId) {
    if (knownKey === folderId) return;
    knownKey = folderId;
    const [memory, skills] = await Promise.all([api.api('/api/memory').catch(() => null), api.api('/api/skills').catch(() => null)]);
    if (api.getState().taskDraft?.folderId !== folderId) return;
    const remembered = (memory?.entries || []).filter(entry => entry.status === 'active' && (!entry.folderId || entry.folderId === folderId)).length, enabled = (skills?.enabled || []).filter(skill => skill.enabled).length;
    const plural = (count, word, many = word + 's') => `${count} ${count === 1 ? word : many}`;
    $('task-draft-knows').textContent = ['Your project brief', ...(remembered ? [plural(remembered, 'memory', 'memories')] : []), ...(enabled ? [plural(enabled, 'skill')] : [])].join(', ') + '.';
  }
  async function startTask(input) {
    const state = api.getState();
    return api.post('/api/tasks', { ...input, folderId: state.taskDraft.folderId, includeHistory: $('task-draft-history').checked, dependsOn: $('task-draft-after').value || null });
  }
  // Moves to what just started. One that has to wait has no conversation yet, so its details show instead.
  async function started(task) {
    if (task.conversationId) { focused = task.id; await api.setTask(task.id); }
    else { await api.setTask(null); focused = task.id; }
    await api.refresh(); render(true);
  }
  // The row for a blank task titles itself as you type.
  const draftTitle = () => { const text = $('message-input').value.trim().split('\n')[0]; return text.length > 60 ? `${text.slice(0, 59)}…` : text || 'New task'; };
  $('message-input').addEventListener('input', () => { const row = list.querySelector?.('.task-row-draft-title'); if (row && api.getState().taskDraft) row.textContent = draftTitle(); });
  document.addEventListener?.('keydown', event => { if (event.key === 'Escape' && api.getState().taskDraft && !document.querySelector('dialog[open]') && !$('message-input').value.trim()) attempt(() => selectThread(null)); });
  const COLLAPSED = 'ai-relay:tasks-collapsed', collapse = closed => { list.hidden = closed; section.classList.toggle('collapsed', closed); $('toggle-tasks').setAttribute('aria-expanded', String(!closed)); };
  let collapsed = false; try { collapsed = localStorage.getItem(COLLAPSED) === '1'; } catch { /* A convenience only. */ }
  collapse(collapsed);
  $('toggle-tasks').addEventListener('click', () => { collapsed = !collapsed; collapse(collapsed); try { localStorage.setItem(COLLAPSED, collapsed ? '1' : '0'); } catch { /* A convenience only. */ } });

  // Reviewing a task's changes against the folder as it is now.
  const WORDS = { clean: 'Ready', merged: 'Merges with changes here', same: 'Already here', conflict: 'Conflict' }, CHANGE = { add: 'New', delete: 'Deleted', update: 'Changed' };
  // The task whose conflicts an agent is resolving in its copy, so the review opens again once that's finished.
  let watching = null, refreshing = false;
  async function openReview(task) {
    reviewing = task; review = await api.post(`/api/tasks/${task.id}/review`);
    renderReview();
    if (!$('task-merge-dialog').open) $('task-merge-dialog').showModal();
  }
  function renderReview() {
    const { files, conflicts, check, canCheck, testCommand, folder, resolve = null, testing = false } = review, total = files.length;
    const can = Boolean(conflicts && resolve?.can), unresolved = resolve?.unresolved || 0, combined = resolve?.combined || 0, agent = AGENT[resolve?.provider] || 'The agent', kind = reviewing.board ? 'card' : 'task';
    $('task-merge-title').textContent = `Merge “${reviewing.title}” into ${folder}`;
    $('task-merge-summary').textContent = !total ? 'This task changed nothing.'
      : conflicts && unresolved === conflicts ? `${unresolved} file${unresolved === 1 ? ' still has' : 's still have'} conflict markers, so nothing can be merged yet. Both versions are safe.`
      : conflicts ? `${conflicts} of ${total} file${total === 1 ? '' : 's'} conflict${conflicts === 1 ? 's' : ''}. Nothing can be merged until that’s settled, and both versions are safe.${can ? '' : ' Keep it as a branch to merge by hand.'}`
      : `${total} file${total === 1 ? '' : 's'} would change, shown against ${folder} as it is now. ${combined ? `${agent} combined ${combined === 1 ? 'one of them' : `${combined} of them`} with the changes there.` : 'Your other work there stays as it is.'}`;
    $('task-merge-files').replaceChildren(...files.map(file => {
      // A file the agent combined shows the change it makes to the folder's own version.
      const done = file.resolved && file.status !== 'conflict', item = node('li', 'task-merge-file'); item.dataset.status = done ? 'combined' : file.status;
      const head = node(file.diff ? 'summary' : 'div', 'task-merge-head');
      head.append(node('span', 'task-merge-path', file.path), node('span', 'task-merge-change', CHANGE[file.change]), ...(file.added ? [node('span', 'line-count added', `+${file.added}`)] : []), ...(file.removed ? [node('span', 'line-count removed', `−${file.removed}`)] : []), node('span', 'task-merge-status', done ? 'Combined' : WORDS[file.status]));
      if (file.diff) { const details = node('details'); details.append(head, node('pre', 'task-merge-diff', file.diff)); item.append(details); } else item.append(head);
      if (file.reason) item.append(node('p', 'task-merge-reason', file.reason));
      return item;
    }));
    const failed = Boolean(check && check.status !== 'passed');
    $('task-merge-check').textContent = conflicts ? (can ? (unresolved ? `If ${agent} asked you something, answer it in this ${kind}’s chat. Or resolve again from where it began.` : `${agent} can combine both versions in this ${kind}’s copy, and asks you where they really disagree. ${folder} isn’t touched, and you still merge.`) : resolve?.why || '')
      : testing ? 'Running the tests on the combined result…'
      : !canCheck ? 'No test command is marked in the Run panel, so the combined result can’t be checked.' : check ? (check.status === 'passed' ? `Tests passed on the combined result: ${check.command}` : `Tests ${check.status === 'timed-out' ? 'didn’t finish' : 'failed'} on the combined result: ${check.command}`) : `Run ${testCommand} on the combined result, in a temporary copy.`;
    $('task-merge-check').dataset.status = conflicts || testing ? '' : check?.status || '';
    $('task-merge-output').hidden = !failed || !check.output; $('task-merge-output').textContent = failed ? check.output : '';
    $('task-merge-test').hidden = !canCheck || Boolean(conflicts) || testing; $('task-merge-test').textContent = check ? 'Run the tests again' : 'Run the tests';
    $('task-merge-resolve').hidden = !can; $('task-merge-resolve').textContent = unresolved ? 'Resolve again' : 'Resolve with an agent';
    $('task-merge-accept-row').hidden = !failed || Boolean(conflicts); if (!failed) $('task-merge-accept').checked = false;
    $('task-merge-apply').disabled = Boolean(conflicts) || !total || (failed && !$('task-merge-accept').checked);
    $('task-merge-error').hidden = true;
  }
  // The agent works in the task's own conversation, so that's where you watch it and answer what it asks.
  $('task-merge-resolve').addEventListener('click', async () => {
    const control = $('task-merge-resolve'), task = reviewing, agent = AGENT[review.resolve?.provider] || 'The agent'; control.disabled = true;
    try {
      const result = await act(task, 'resolve', { digest: review.digest });
      // Git combined everything by itself, so there is nothing to ask.
      if (!result.started) { review = await api.post(`/api/tasks/${task.id}/review`); renderReview(); return; }
      watching = task.id; $('task-merge-dialog').close();
      if ((focused || api.getState().taskId) !== task.id) await selectThread(tasks().find(item => item.id === task.id) || task);
      api.announce(`${agent} is resolving ${result.files === 1 ? 'one file' : `${result.files} files`} in the ${task.board ? 'card' : 'task'}’s copy.`);
    } catch (error) { mergeError(error); if (/moved since/.test(error.message)) { try { review = await api.post(`/api/tasks/${task.id}/review`); renderReview(); mergeError(error); } catch { /* The error shown already says what to do. */ } } }
    finally { control.disabled = false; }
  });
  // Once nothing it was given is marked any more, the review opens again with the combined result, if you're still on
  // its task, and otherwise a notice offers it. A run that ends with markers left asked you something, or stopped.
  function followResolve() {
    if (!watching) return;
    const task = tasks().find(item => item.id === watching);
    if (!task?.hasWorktree) { watching = null; return; }
    if (['running', 'waiting'].includes(task.status) || task.resolving?.open !== false) return;
    watching = null;
    const here = !api.getState().taskDraft && (focused || api.getState().taskId) === task.id;
    if (here && !$('task-merge-dialog').open) attempt(() => openReview(task));
    else if (!here) api.showNotice(`“${task.title}” is resolved. Review the combined result to merge it.`, null, 'Retry', [{ label: 'Review and merge', run: () => attempt(() => openReview(task)) }]);
  }
  // Tests already running on the combined result, such as a card's own: the review shows their result when they end.
  function followTests() {
    if (refreshing || !review?.testing || !reviewing || !$('task-merge-dialog').open) return;
    const task = tasks().find(item => item.id === reviewing.id);
    if (!task || task.testing) return;
    refreshing = true;
    api.post(`/api/tasks/${task.id}/review`).then(next => { if (reviewing?.id === task.id) { review = next; renderReview(); } }).catch(() => { /* Reviewing again shows it. */ }).finally(() => { refreshing = false; });
  }
  const mergeError = error => { $('task-merge-error').textContent = error.message; $('task-merge-error').hidden = false; };
  $('task-merge-accept').addEventListener('change', () => { $('task-merge-apply').disabled = Boolean(review?.conflicts) || !$('task-merge-accept').checked; });
  $('task-merge-test').addEventListener('click', async () => {
    const control = $('task-merge-test'); control.disabled = true; $('task-merge-check').textContent = 'Running the tests…';
    try { review.check = await act(reviewing, 'check', { digest: review.digest }); renderReview(); }
    catch (error) { mergeError(error); }
    finally { control.disabled = false; }
  });
  $('task-merge-apply').addEventListener('click', async () => {
    try { const result = await act(reviewing, 'merge', { digest: review.digest, acceptFailedCheck: $('task-merge-accept').checked }); $('task-merge-dialog').close(); api.announce(`Merged ${result.merged} file${result.merged === 1 ? '' : 's'}.`); }
    catch (error) { mergeError(error); if (/moved since/.test(error.message)) { try { review = await api.post(`/api/tasks/${reviewing.id}/review`); renderReview(); mergeError(error); } catch { /* The error shown already says what to do. */ } } }
  });
  $('task-merge-keep').addEventListener('click', async () => {
    try { const result = await act(reviewing, 'keep'); $('task-merge-dialog').close(); api.announce(`Kept as the branch ${result.branch}.`); }
    catch (error) { mergeError(error); }
  });
  $('task-merge-close').addEventListener('click', () => $('task-merge-dialog').close());
  window.addEventListener('relay-state', () => { render(); followResolve(); followTests(); });
  window.relayExperimental?.onChange(() => { if (window.relayExperimental.enabled('tasks') === false) { const state = api.getState(), current = state.taskId ? tasks().find(item => item.id === state.taskId) : null; if (state.taskDraft || (current && !current.board && current.purpose !== 'plan-chat' && current.purpose !== 'project-review')) attempt(() => selectThread(null)); } render(true); });
  window.relayTaskThreads = { refresh: () => render(true), open: folderId => attempt(() => openDraft(folderId)), start: startTask, started, select: id => { const all = api.getState().conversation?.parallelTasks || []; const task = all.find(item => item.id === id) || null; if (task && !task.managed && (task.board || task.purpose === 'plan-chat') && window.relayBoard?.openTask) return window.relayBoard.openTask(task.id); return selectThread(tasks().find(item => item.id === id) || (task?.managed ? task : null)); }, review: id => { const all = api.getState().conversation?.parallelTasks || []; const task = all.find(item => item.id === id) || tasks().find(item => item.id === id); if (task) return attempt(() => openReview(task)); }, resume: id => { const task = tasks().find(item => item.id === id); if (task) return attempt(() => act(task, 'start')); }, discard: id => { const task = tasks().find(item => item.id === id); if (task) return attempt(() => act(task, 'discard')); }, close: id => { const task = tasks().find(item => item.id === id); if (task) return removeTask(task, () => (focused || api.getState().taskId) === task.id ? selectThread(null) : null); }, removeLabel: REMOVE, removeHint: id => { const task = tasks().find(item => item.id === id); return task ? `Take this task off the list. ${stays(task)}` : ''; } };
  render(true);
})();

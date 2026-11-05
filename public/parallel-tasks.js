(() => {
  'use strict';
  // Independent tasks in one workspace (#88). The sidebar lists them under the workspace: all of them and the main conversation
  // when the workspace is selected, and only its own when a folder is. Selecting one shows its own conversation, with its own
  // approvals, queue and Stop. Starting one says first how it will run, and a task that worked in its own copy is merged only
  // after its changes have been reviewed.
  const $ = id => document.getElementById(id), api = window.relayUI, section = $('task-section'), list = $('task-list'), banner = $('task-banner');
  if (!api || !section || !list || !banner) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'text-link') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const tasks = () => api.getState().conversation?.parallelTasks || [];
  const LABEL = { waiting: 'Waiting', running: 'Working', complete: 'Finished', stopped: 'Stopped', failed: 'Did not finish', integrated: 'Merged', kept: 'Kept as a branch', discarded: 'Discarded', cancelled: 'Cancelled', blocked: 'Blocked', lost: 'Copy gone', detached: 'Folder removed' };
  const canMerge = task => task.hasWorktree && ['complete', 'stopped', 'failed'].includes(task.status);
  const act = async (task, action, input = {}) => { const result = await api.post(`/api/tasks/${task.id}/${action}`, input); await api.refresh(); return result; };
  const attempt = work => work().catch(error => api.showNotice(error.message));
  let focused = null, signature = null, planRequest = 0, review = null, reviewing = null;

  async function selectThread(task) {
    focused = task?.id || null;
    // A task that hasn't started has no conversation yet, so its details show without leaving this one.
    if (!task || task.conversationId) await api.setTask(task?.id || null);
    else if (api.getState().taskDraft) await api.setTask(null);
    render(true);
  }
  // The conversation that belongs to the whole workspace, set apart from the tasks under it.
  function mainRow(state) {
    const selected = !state.taskDraft && !state.taskId && !focused, row = node('li', 'task-row-holder'), item = node('button', `task-row task-row-main${selected ? ' active' : ''}`); item.type = 'button';
    if (selected) item.setAttribute('aria-current', 'true');
    item.title = 'The main conversation, across every folder in this workspace';
    const elsewhere = state.taskId || state.taskDraft, running = elsewhere ? Boolean(state.status?.runningConversationId) : api.isRunning(), waiting = elsewhere ? 0 : state.conversation?.pendingApprovals?.length || 0, mark = node('span', 'task-row-main-icon'); mark.setAttribute('aria-hidden', 'true');
    item.dataset.status = running ? 'running' : 'idle';
    item.append(mark, node('span', 'task-row-title', 'Main conversation'));
    if (waiting) item.append(node('span', 'task-row-badge', String(waiting)));
    else item.append(node('span', 'task-row-side', running ? 'Working' : 'Whole workspace'));
    item.addEventListener('click', () => attempt(() => selectThread(null)));
    row.append(item);
    return row;
  }
  function taskRow(task, state, level) {
    const selected = !state.taskDraft && (focused || state.taskId) === task.id, row = node('li', 'task-row-holder'), item = node('button', `task-row${selected ? ' active' : ''}`); item.type = 'button'; item.dataset.status = task.status;
    if (selected) item.setAttribute('aria-current', 'true');
    item.title = `${task.title} · ${task.folderName} · ${LABEL[task.status] || task.status}`;
    const dot = node('span', 'task-row-dot'); dot.setAttribute('aria-hidden', 'true');
    item.append(dot, node('span', 'task-row-title', task.title));
    if (task.approvals) item.append(node('span', 'task-row-badge', String(task.approvals)));
    else if (canMerge(task)) item.append(node('span', 'task-row-review', 'Review'));
    else if (level === 'workspace') item.append(node('span', 'task-row-side', task.folderName));
    item.addEventListener('click', () => attempt(() => selectThread(task)));
    row.append(item);
    return row;
  }
  function renderList() {
    const state = api.getState(), level = api.sidebarLevel?.() || 'single', chosen = api.selectedFolderId?.();
    section.hidden = !state.projectId;
    // A folder shows its own tasks. The main conversation spans every folder, so it shows with the workspace.
    const shown = level === 'folder' ? tasks().filter(task => task.folderId === chosen) : tasks();
    const blank = state.taskDraft ? (() => { const row = node('li', 'task-row-holder'), item = node('div', 'task-row task-row-draft active'), mark = node('span', 'task-row-draft-icon'); mark.setAttribute('aria-hidden', 'true'); item.setAttribute('aria-current', 'true'); item.append(mark, node('span', 'task-row-title task-row-draft-title', draftTitle())); row.append(item); return [row]; })() : [];
    const rows = [...(level === 'folder' ? [] : [mainRow(state)]), ...blank, ...shown.map(task => taskRow(task, state, level))];
    // The + is for a folder: at the workspace level, nothing says where a task would go.
    $('new-task').hidden = level === 'workspace';
    if (!rows.length) { const folder = (state.projects?.find(project => project.id === state.projectId)?.folders || []).find(item => item.id === chosen); rows.push(node('li', 'task-list-empty', `No tasks in ${folder?.displayName || folder?.name || 'this folder'} yet.`)); }
    list.replaceChildren(...rows);
    const running = tasks().filter(task => task.status === 'running').length;
    $('task-count').hidden = !shown.length; $('task-count').textContent = String(shown.length); $('task-count').title = running ? `${running} running` : '';
  }
  function renderBanner() {
    const state = api.getState(), task = tasks().find(item => item.id === (focused || state.taskId));
    banner.hidden = !task || Boolean(state.taskDraft);
    if (!task) return;
    const text = node('div', 'task-banner-text');
    text.append(node('strong', 'task-banner-title', `${task.folderName} · ${LABEL[task.status] || task.status}`));
    const how = task.reason || (task.mode === 'worktree' ? `Works in its own copy from the last commit${task.uncommitted ? `, without ${task.uncommitted} uncommitted change${task.uncommitted === 1 ? '' : 's'} in the folder` : ''}. You review its changes before they’re merged.` : task.mode === 'direct' ? 'Works directly in this folder.' : '');
    if (task.status === 'integrated') text.append(node('span', 'task-banner-detail', `${task.integration?.files || 0} file${task.integration?.files === 1 ? '' : 's'} merged into ${task.folderName}.`));
    else if (task.status === 'kept') text.append(node('span', 'task-banner-detail', `Saved as the branch ${task.integration?.branch}. Nothing was merged.`));
    else if (how) text.append(node('span', 'task-banner-detail', how));
    const actions = node('div', 'task-banner-actions');
    if (canMerge(task)) actions.append(button('Review and merge', () => attempt(() => openReview(task)), 'primary-button'), button('Discard', () => attempt(() => act(task, 'discard').then(() => api.announce('The task’s copy was discarded.')))));
    if (task.status === 'waiting') {
      if (task.held) actions.append(button('Start', () => attempt(() => act(task, 'start')), 'secondary-button'));
      actions.append(button('Cancel', () => attempt(() => act(task, 'discard'))));
    }
    if (!['running', 'waiting'].includes(task.status) && !canMerge(task)) actions.append(button('Close', () => attempt(async () => { await act(task, 'close'); await selectThread(null); })));
    banner.dataset.status = task.status;
    banner.replaceChildren(text, actions);
  }
  function render(force = false) {
    const state = api.getState();
    // A blank task belongs to its folder, so going to the workspace or another folder puts it away. What was typed is kept.
    if (state.taskDraft && (api.sidebarLevel?.() === 'workspace' || (api.sidebarLevel?.() === 'folder' && api.selectedFolderId?.() !== state.taskDraft.folderId))) { attempt(() => selectThread(null)); return; }
    const key = JSON.stringify([state.projectId, state.taskId, state.taskDraft, state.provider, state.mode, state.approvalPolicy, focused, api.sidebarLevel?.(), api.selectedFolderId?.(), state.conversation?.status, state.conversation?.pendingApprovals?.length, state.status?.runningConversationId, tasks().map(task => [task.id, task.status, task.approvals, task.reason, task.hasWorktree, task.held, task.title, task.folderId])]);
    if (focused && !tasks().some(task => task.id === focused)) focused = null;
    if (!force && key === signature) return;
    signature = key; renderList(); renderBanner(); renderDraft();
  }

  // Starting a task. The folder is the one selected, so there's nothing to ask: + opens a blank task in the middle, with the
  // real composer. The page says how it would run, what else is running and what it will know, while there's still time to change it.
  const folders = () => { const state = api.getState(); return state.projects?.find(project => project.id === state.projectId)?.folders || []; };
  const draftFolder = () => folders().find(folder => folder.id === api.getState().taskDraft?.folderId);
  const folderName = folder => folder?.displayName || folder?.name || 'this folder';
  let planKey = null, knownKey = null;
  async function openDraft() {
    const state = api.getState();
    if (!state.projectId) return;
    if (api.sidebarLevel?.() === 'workspace') api.showFolderLevel?.();
    const chosen = api.selectedFolderId?.() || folders()[0]?.id;
    if (!chosen) return;
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
    if (state.status?.runningConversationId) beside.unshift('The main conversation');
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
  async function openReview(task) {
    reviewing = task; review = await api.post(`/api/tasks/${task.id}/review`);
    renderReview();
    if (!$('task-merge-dialog').open) $('task-merge-dialog').showModal();
  }
  function renderReview() {
    const { files, conflicts, check, canCheck, testCommand, folder } = review, total = files.length;
    $('task-merge-title').textContent = `Merge “${reviewing.title}” into ${folder}`;
    $('task-merge-summary').textContent = !total ? 'This task changed nothing.' : conflicts ? `${conflicts} of ${total} file${total === 1 ? '' : 's'} conflict${conflicts === 1 ? 's' : ''}. Nothing can be merged until that’s settled, and both versions are safe. Keep it as a branch to merge by hand.` : `${total} file${total === 1 ? '' : 's'} would change, shown against ${folder} as it is now. Your other work there stays as it is.`;
    $('task-merge-files').replaceChildren(...files.map(file => {
      const item = node('li', 'task-merge-file'); item.dataset.status = file.status;
      const head = node(file.diff ? 'summary' : 'div', 'task-merge-head');
      head.append(node('span', 'task-merge-path', file.path), node('span', 'task-merge-change', CHANGE[file.change]), ...(file.added ? [node('span', 'line-count added', `+${file.added}`)] : []), ...(file.removed ? [node('span', 'line-count removed', `−${file.removed}`)] : []), node('span', 'task-merge-status', WORDS[file.status]));
      if (file.diff) { const details = node('details'); details.append(head, node('pre', 'task-merge-diff', file.diff)); item.append(details); } else item.append(head);
      if (file.reason) item.append(node('p', 'task-merge-reason', file.reason));
      return item;
    }));
    const failed = Boolean(check && check.status !== 'passed');
    $('task-merge-check').textContent = conflicts ? '' : !canCheck ? 'No test command is marked in the Run panel, so the combined result can’t be checked.' : check ? (check.status === 'passed' ? `Tests passed on the combined result: ${check.command}` : `Tests ${check.status === 'timed-out' ? 'didn’t finish' : 'failed'} on the combined result: ${check.command}`) : `Run ${testCommand} on the combined result, in a temporary copy.`;
    $('task-merge-check').dataset.status = check?.status || '';
    $('task-merge-output').hidden = !failed || !check.output; $('task-merge-output').textContent = failed ? check.output : '';
    $('task-merge-test').hidden = !canCheck || Boolean(conflicts); $('task-merge-test').textContent = check ? 'Run the tests again' : 'Run the tests';
    $('task-merge-accept-row').hidden = !failed || Boolean(conflicts); if (!failed) $('task-merge-accept').checked = false;
    $('task-merge-apply').disabled = Boolean(conflicts) || !total || (failed && !$('task-merge-accept').checked);
    $('task-merge-error').hidden = true;
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
  window.addEventListener('relay-state', () => render());
  window.relayTaskThreads = { open: () => attempt(openDraft), start: startTask, started };
  render(true);
})();

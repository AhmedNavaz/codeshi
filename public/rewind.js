(() => {
  'use strict';
  // Rewind (#20, #196). Each message whose run changed files gets an Undo action beside Copy with two choices:
  // Undo changes (revert only that run, keeping later edits and chat) or Undo and remove from chat (restore files
  // to before that message and fold later messages away). Nothing is written until you confirm the file-by-file preview.
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('rewind-dialog');
  if (!api || !dialog) return;
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const providerLabel = (provider, local) => local ? 'Local model' : { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[provider] || 'Agent';
  const agent = preview => preview.local ? 'the local model' : { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[preview.provider] || 'the agent';
  const ACTIONS = { remove: 'Remove', restore: 'Restore', merge: 'Merge', recreate: 'Bring back' };
  const HINTS = { remove: 'The run added this file.', restore: 'Back to how it was before the run.', merge: 'The run’s edits come out; changes made since are kept.', recreate: 'The run deleted this file.' };
  const formatTime = value => { const when = new Date(value); return Number.isNaN(when.getTime()) ? 'Time unavailable' : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); };
  const cleanPrompt = text => text && !/^\s*Continue the unfinished task from this shared conversation/i.test(text) ? text : '';
  let current = null, generation = 0, busy = false;

  // Shared two-choice Undo menu (#196) anchored to a message's Undo button or a Timeline row's Undo button.
  const undoMenu = $('message-undo-menu'), undoChangesBtn = $('message-undo-changes'), undoRemoveBtn = $('message-undo-remove');
  let activeMenuAnchor = null, menuState = null, menuProjectId = null, suppressMenuClick = null;
  const undoMenuOpen = () => Boolean(undoMenu && typeof undoMenu.matches === 'function' && undoMenu.matches(':popover-open'));
  function closeMenu() {
    if (undoMenuOpen()) undoMenu.hidePopover();
  }
  function positionMenu(anchor) {
    if (!undoMenu || !anchor?.getBoundingClientRect) return;
    const rect = anchor.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height && !rect.top && !rect.left)) return;
    const width = Math.max(undoMenu.getBoundingClientRect?.().width || 0, 272);
    const height = Math.max(undoMenu.getBoundingClientRect?.().height || 0, 108);
    const edge = 8, gap = 6;
    const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    const left = Math.max(edge, Math.min(rect.right - width, vw - width - edge));
    const below = rect.bottom + gap + height <= vh - edge;
    const top = below ? rect.bottom + gap : Math.max(edge, rect.top - gap - height);
    undoMenu.style.left = `${left}px`;
    undoMenu.style.top = `${top}px`;
  }
  function openMenu(anchor, info) {
    if (!undoMenu || !info) return;
    if (api.getState().taskId) { api.showNotice('Open the main workspace conversation to undo changes.'); return; }
    if (api.isRunning()) return;
    if (undoMenuOpen() && activeMenuAnchor === anchor) { closeMenu(); return; }
    if (activeMenuAnchor && activeMenuAnchor !== anchor) activeMenuAnchor.setAttribute('aria-expanded', 'false');
    menuState = { anchor, ...info };
    menuProjectId = api.getState().projectId;
    activeMenuAnchor = anchor;
    if (undoChangesBtn) {
      undoChangesBtn.replaceChildren(
        node('span', info.undone ? 'Redo changes' : 'Undo changes', 'message-undo-option-title'),
        node('span', info.undone ? 'Put this run’s changes back; keep the conversation.' : 'Revert only this run’s edits; keep later changes and chat.', 'message-undo-option-detail')
      );
      undoChangesBtn.disabled = !info.undone && info.canUndo === false;
      undoChangesBtn.title = undoChangesBtn.disabled ? (info.undoReason || 'Unavailable for this run.') : '';
    }
    if (undoRemoveBtn) {
      undoRemoveBtn.replaceChildren(
        node('span', 'Undo and remove from chat', 'message-undo-option-title'),
        node('span', 'Restore files to before this message and fold later messages away.', 'message-undo-option-detail')
      );
      undoRemoveBtn.disabled = info.beforeAvailable === false;
      undoRemoveBtn.title = undoRemoveBtn.disabled ? (info.beforeReason || 'Checkpoint before this message is unavailable.') : '';
    }
    anchor.setAttribute('aria-expanded', 'true');
    if (!undoMenuOpen()) undoMenu.showPopover();
    positionMenu(anchor);
  }
  if (undoMenu) {
    undoMenu.addEventListener('toggle', event => {
      const state = event.newState || (undoMenuOpen() ? 'open' : 'closed');
      if (state === 'open') positionMenu(activeMenuAnchor);
      else {
        if (activeMenuAnchor) activeMenuAnchor.setAttribute('aria-expanded', 'false');
        activeMenuAnchor = null; menuState = null; menuProjectId = null;
      }
    });
    undoChangesBtn?.addEventListener('click', () => {
      const info = menuState;
      closeMenu();
      if (!info) return;
      open(info.undone ? { kind: 'rewind', id: info.undone } : { kind: 'run', id: info.runId });
    });
    undoRemoveBtn?.addEventListener('click', () => {
      const info = menuState;
      closeMenu();
      if (!info) return;
      open({ kind: 'checkpoint', id: info.beforeRunId || info.runId, phase: 'before' }, { conversation: true, mode: 'remove-from-chat' });
    });
  }
  function bindMenuButton(button, getInfo) {
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', 'message-undo-menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('pointerdown', () => { if (undoMenuOpen() && activeMenuAnchor === button) suppressMenuClick = button; });
    button.addEventListener('click', () => {
      if (suppressMenuClick === button) { suppressMenuClick = null; return; }
      suppressMenuClick = null;
      if (button.disabled) return;
      openMenu(button, typeof getInfo === 'function' ? getInfo() : getInfo);
    });
    return button;
  }

  // The Undo / Redo action placed beside Copy on a user message whose run changed files (#196).
  function button({ runId, beforeRunId = null, undone = null, files = 0, disabled = false } = {}) {
    if (!runId || !files) return null;
    const action = node('button', undone ? 'Redo' : 'Undo', `message-action message-undo${undone ? ' message-redo' : ''}`);
    action.type = 'button';
    action.dataset.runId = runId;
    action.disabled = Boolean(disabled);
    action.title = action.disabled ? 'Available when the current run finishes' : undone ? 'Redo this run’s changes, or remove this message from chat' : 'Undo this message’s changes';
    return bindMenuButton(action, { runId, beforeRunId: beforeRunId || runId, undone, canUndo: true, beforeAvailable: true });
  }

  function diffLines(text) {
    const lines = node('div', undefined, 'diff-lines');
    let before = 0, after = 0;
    const line = (kind, left, right, value) => { const item = node('div', undefined, 'diff-line ' + kind); item.append(node('span', String(left), 'diff-number'), node('span', String(right), 'diff-number'), node('span', kind === 'add' ? '+' : kind === 'del' ? '-' : '', 'diff-sign'), node('span', value, 'diff-text')); lines.append(item); };
    for (const value of text.split('\n')) {
      const hunk = value.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); line('hunk', '', '', value); }
      else if (value.startsWith('+')) line('add', '', after++, value.slice(1));
      else if (value.startsWith('-')) line('del', before++, '', value.slice(1));
      else if (value.startsWith('\\')) line('note', '', '', value.slice(2));
      else line('context', before++, after++, value.slice(1));
    }
    return lines;
  }
  function fileRow(file, multiple, restoring = false) {
    const name = (multiple ? `${file.folder}/` : '') + (file.path || '');
    if (!ACTIONS[file.action]) {
      const item = node('li', undefined, 'rewind-left');
      item.append(node('code', name || file.folder), node('span', file.reason || 'Left as it is.'));
      return item;
    }
    const item = node('details', undefined, 'rewind-file'), summary = node('summary');
    item.dataset.action = file.action;
    const badge = node('span', ACTIONS[file.action], 'rewind-action'); badge.title = restoring ? file.action === 'remove' ? 'Not present in the selected checkpoint.' : 'Back to the selected checkpoint, replacing later edits.' : HINTS[file.action];
    summary.append(badge, node('code', name, 'rewind-path'));
    if (file.diff) {
      const added = file.diff.split('\n').filter(value => value.startsWith('+')).length, removed = file.diff.split('\n').filter(value => value.startsWith('-')).length;
      summary.append(node('span', `+${added}`, 'diff-added'), node('span', `-${removed}`, 'diff-removed'));
    }
    item.append(summary);
    const body = node('div', undefined, 'rewind-diff');
    if (file.binary) body.append(node('p', 'Binary file. Its contents are not shown.', 'rewind-diff-note'));
    else if (file.diff) body.append(diffLines(file.diff));
    else body.append(node('p', file.action === 'restore' ? 'Only the file’s permissions change.' : 'Not shown: the preview already lists many changed lines.', 'rewind-diff-note'));
    if (file.truncated) body.append(node('p', `${file.truncated} more lines not shown.`, 'rewind-diff-note'));
    item.append(body);
    return item;
  }

  function render(preview) {
    const redo = current.target.kind === 'rewind', restoring = current.target.kind === 'checkpoint', work = preview.files.filter(file => ACTIONS[file.action]), left = preview.files.filter(file => !ACTIONS[file.action]);
    const multiple = new Set(preview.files.map(file => file.folderId)).size > 1 || (api.getState().projects?.find(project => project.id === current.projectId)?.folders?.length || 1) > 1;
    const talk = restoring ? preview.conversation : null, rewinding = Boolean(talk?.available && current.conversation);
    const removeFromChat = restoring && current.mode === 'remove-from-chat' && rewinding;
    $('rewind-title').textContent = removeFromChat ? 'Undo and remove from chat?' : restoring ? 'Restore this checkpoint?' : `${redo ? 'Redo' : 'Undo'} ${agent(preview)}’s changes?`;
    const when = preview.checkpointAt || preview.startedAt ? new Date(preview.checkpointAt || preview.startedAt) : null;
    const promptText = cleanPrompt(preview.prompt);
    $('rewind-meta').textContent = [restoring ? `${current.target.phase === 'before' ? 'Before' : 'After'} ${preview.checkpointKind === 'restore' ? 'workspace restore' : preview.checkpointKind === 'undo' ? 'undo / redo' : 'the run'}` : '', promptText ? `“${promptText.length > 120 ? promptText.slice(0, 119) + '…' : promptText}”` : '', when && !Number.isNaN(when.getTime()) ? when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : ''].filter(Boolean).join(' · ');
    const count = action => work.filter(file => file.action === action).length;
    const parts = redo ? (work.length ? [`puts back ${plural(work.length, 'file')} as the run left them`] : []) : [count('restore') && `restores ${plural(count('restore'), 'file')}`, count('merge') && `takes the run’s edits out of ${plural(count('merge'), 'file')}, keeping later changes`, count('remove') && `removes ${plural(count('remove'), 'file')} it added`, count('recreate') && `brings back ${plural(count('recreate'), 'file')} it deleted`].filter(Boolean);
    const runSummary = parts.length
      ? `This ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.${redo ? '' : ' Only this run’s changes are undone; later edits and the conversation stay.'}`
      : redo ? 'There is nothing to put back: these files changed since the undo.' : 'There is nothing to undo: these files are already as they were before the run, or changed since.';
    $('rewind-conversation').hidden = !talk;
    if (talk) {
      const box = $('rewind-conversation-check'); box.disabled = !talk.available; box.checked = rewinding;
      $('rewind-conversation-detail').textContent = !talk.available ? talk.reason || 'Not available for this checkpoint.'
        : `${plural(talk.count, 'later message')} ${talk.count === 1 ? 'is' : 'are'} folded away: still in the chat behind a fold, but no agent reads ${talk.count === 1 ? 'it' : 'them'} again. Every agent starts a fresh session.${talk.returnsPrompt ? ' The run’s prompt goes back in the message box.' : ''}`;
    }
    const restoreSummary = removeFromChat
      ? (work.length
        ? `This returns ${plural(work.length, 'file')} to how they were before this message, replacing later edits and removing files added since. This message and any later messages are folded away${talk.returnsPrompt ? ', and your prompt goes back in the message box' : ''}. Review the changes below.`
        : `The saved files already match how they were before this message. Only the conversation goes back: this message and any later messages are folded away${talk.returnsPrompt ? ', and your prompt goes back in the message box' : ''}.`)
      : (work.length
        ? `This returns ${plural(work.length, 'file')} to the selected checkpoint, replacing later edits and removing files added since. ${rewinding ? 'The conversation goes back too.' : 'The conversation stays.'} Review the changes below.`
        : rewinding ? 'The saved files already match this checkpoint. Only the conversation goes back.' : 'The saved files already match this checkpoint.');
    $('rewind-summary').textContent = (restoring ? restoreSummary : runSummary) + (left.length ? ` ${plural(left.length, 'file')} ${left.length === 1 ? 'stays' : 'stay'} as ${left.length === 1 ? 'it is' : 'they are'}.` : '');
    const files = $('rewind-files'); files.replaceChildren();
    if (work.length) { const list = node('div', undefined, 'rewind-list'); work.forEach(file => list.append(fileRow(file, multiple, restoring))); if (work.length === 1) list.firstChild.open = true; files.append(list); }
    if (left.length) { const heading = node('h3', 'Left as they are', 'rewind-heading'), list = node('ul', undefined, 'rewind-left-list'); left.forEach(file => list.append(fileRow(file, multiple))); files.append(heading, list); }
    $('rewind-note').textContent = work.length ? restoring ? (rewinding ? 'A recovery checkpoint is saved before restoring. Folded messages stay in the saved history.' : 'A recovery checkpoint is saved before restoring.') : redo ? 'You can undo this run again afterwards.' : 'You can redo this afterwards.' : rewinding ? 'Folded messages stay in the saved history.' : '';
    $('confirm-rewind').textContent = removeFromChat ? (work.length ? 'Undo and remove' : 'Remove from chat') : restoring ? rewinding ? work.length ? 'Restore files and conversation' : 'Rewind conversation' : 'Restore checkpoint' : redo ? 'Redo changes' : 'Undo changes';
    $('confirm-rewind').disabled = !(work.length || rewinding) || api.isRunning() || Boolean(api.getState().taskId);
  }
  function failure(message) { $('rewind-error').textContent = message || ''; $('rewind-error').hidden = !message; }

  async function open(target, options = {}) {
    if (api.getState().taskId) { api.showNotice('Open the main workspace conversation to use Timeline.'); return; }
    closeMenu();
    const projectId = api.getState().projectId, mine = ++generation;
    const wantConversation = Boolean(options.conversation), mode = options.mode || null;
    current = { target, projectId, preview: null, conversation: wantConversation, mode }; busy = false; failure(''); $('rewind-conversation').hidden = true;
    $('rewind-title').textContent = mode === 'remove-from-chat' ? 'Undo and remove from chat?' : target.kind === 'checkpoint' ? 'Restore checkpoint?' : target.kind === 'rewind' ? 'Redo changes?' : 'Undo changes?'; $('rewind-meta').textContent = '';
    $('rewind-summary').textContent = 'Comparing the files with this run’s checkpoint…'; $('rewind-files').replaceChildren(); $('rewind-note').textContent = '';
    $('confirm-rewind').textContent = mode === 'remove-from-chat' ? 'Undo and remove' : target.kind === 'rewind' ? 'Redo changes' : target.kind === 'checkpoint' ? 'Restore checkpoint' : 'Undo changes'; $('confirm-rewind').disabled = true;
    dialog.setAttribute('aria-busy', 'true');
    if (!dialog.open) dialog.showModal();
    try {
      const preview = await api.post('/api/checkpoints/preview', { target }, projectId);
      if (mine !== generation) return;
      current.preview = preview;
      if (current.conversation && !preview.conversation?.available) current.conversation = false;
      render(preview);
    } catch (error) { if (mine === generation) { $('rewind-summary').textContent = ''; failure(error.message); } }
    finally { if (mine === generation) dialog.removeAttribute('aria-busy'); }
  }
  $('confirm-rewind').addEventListener('click', async () => {
    if (busy || !current?.preview || api.isRunning() || api.getState().taskId) return;
    const { target, projectId, preview, mode } = current, mine = generation;
    busy = true; $('confirm-rewind').disabled = true; dialog.setAttribute('aria-busy', 'true'); failure('');
    try {
      const rewinding = Boolean(current.conversation && preview.conversation?.available);
      const result = await api.post('/api/checkpoints/apply', { target, digest: preview.digest, ...(rewinding ? { conversation: { count: preview.conversation.count } } : {}) }, projectId);
      if (mine !== generation) return;
      dialog.close();
      await api.refresh?.();
      // Rewound to before a run: its prompt goes back in an empty message box, to edit and send again.
      const input = $('message-input'), prompt = result?.conversation?.prompt;
      if (prompt && input && !input.value.trim() && api.getState().projectId === projectId) { input.value = prompt; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
    } catch (error) {
      if (mine !== generation) return;
      busy = false; dialog.removeAttribute('aria-busy');
      // Files changed since the preview: show the new preview, so what is confirmed is always what you saw.
      if (error.status === 409 && /Review the changes again/.test(error.message)) { const keep = current.conversation; await open(target, { conversation: keep, mode }); failure('The files or the conversation changed since you opened this. Here is the updated preview.'); }
      else { failure(error.message); $('confirm-rewind').disabled = false; }
    }
  });
  const close = () => { generation++; busy = false; if (dialog.open) dialog.close(); };
  $('rewind-conversation-check').addEventListener('change', event => { if (!current?.preview || busy) return; current.conversation = event.target.checked; render(current.preview); });
  $('cancel-rewind').addEventListener('click', close);
  $('close-rewind').addEventListener('click', close);
  dialog.addEventListener('close', () => { generation++; busy = false; current = null; });
  // A different workspace's undo never stays open over another.
  window.addEventListener('relay-state', () => {
    if (undoMenuOpen() && (api.isRunning() || api.getState().taskId || api.getState().projectId !== menuProjectId || !activeMenuAnchor?.isConnected)) closeMenu();
    if (dialog.open && current && (api.getState().projectId !== current.projectId || api.getState().taskId)) close();
    else if (dialog.open && current?.preview && !busy) render(current.preview);
  });

  // A commit in Timeline (#20): its files and lines, read only. Nothing in Git changes, and restoring stays with checkpoints.
  const commitDialog = $('commit-dialog'), STATUS = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', type: 'Type changed' };
  let commitRequest = 0, commitUrl = null;
  const external = url => window.relayDesktop ? window.relayDesktop.openExternal(url) : window.open(url, '_blank', 'noopener,noreferrer');
  const by = commit => commit.by === 'panel' ? 'From the Git panel' : commit.by === 'run' ? `During ${commit.local ? 'the local model' : { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[commit.provider] || 'the agent'}’s run` : commit.author ? `By ${commit.author}` : '';
  function commitFile(file, multiple, folder) {
    const item = node('details', undefined, 'rewind-file'), summary = node('summary');
    item.dataset.status = file.status;
    const name = (multiple ? `${folder}/` : '') + file.path;
    summary.append(node('span', STATUS[file.status] || 'Modified', 'rewind-action'), node('code', file.originalPath ? `${file.originalPath} → ${name}` : name, 'rewind-path'));
    if (file.diff) summary.append(node('span', `+${file.diff.split('\n').filter(value => value.startsWith('+')).length}`, 'diff-added'), node('span', `-${file.diff.split('\n').filter(value => value.startsWith('-')).length}`, 'diff-removed'));
    item.append(summary);
    const body = node('div', undefined, 'rewind-diff');
    if (file.binary) body.append(node('p', 'Binary file. Its contents are not shown.', 'rewind-diff-note'));
    else if (file.diff) body.append(diffLines(file.diff));
    else body.append(node('p', file.diff === '' ? 'Only the file’s permissions changed.' : 'Not shown: this commit already shows many changed lines.', 'rewind-diff-note'));
    if (file.truncated) body.append(node('p', `${file.truncated} more lines not shown.`, 'rewind-diff-note'));
    item.append(body);
    return item;
  }
  async function openCommit(entry) {
    const projectId = api.getState().projectId, mine = ++commitRequest, multiple = (api.getState().projects?.find(project => project.id === projectId)?.folders?.length || 1) > 1;
    commitUrl = entry.url || null; $('commit-github').hidden = !commitUrl;
    $('commit-title').textContent = entry.subject || entry.shortHash;
    const when = new Date(entry.at);
    $('commit-meta').textContent = [entry.shortHash, multiple ? entry.folder : '', by(entry), Number.isNaN(when.getTime()) ? '' : when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })].filter(Boolean).join(' · ');
    $('commit-summary').textContent = 'Reading the commit…'; $('commit-body').hidden = true; $('commit-files').replaceChildren(); $('commit-error').hidden = true;
    commitDialog.setAttribute('aria-busy', 'true');
    if (!commitDialog.open) commitDialog.showModal();
    try {
      const commit = await api.api(`/api/checkpoints/commit?folderId=${encodeURIComponent(entry.folderId)}&hash=${encodeURIComponent(entry.hash)}`, {}, projectId);
      if (mine !== commitRequest) return;
      const shown = commit.files.length < commit.totalFiles ? ` The first ${commit.files.length} are listed.` : '';
      $('commit-summary').textContent = commit.totalFiles ? `This commit changed ${plural(commit.totalFiles, 'file')}${commit.merge ? ', compared with the branch it was merged into' : ''}.${shown}${commit.linesUnavailable ? ' Its lines could not be shown.' : ''}` : 'This commit changed no files in this folder.';
      $('commit-body').textContent = commit.body || ''; $('commit-body').hidden = !commit.body;
      const list = node('div', undefined, 'rewind-list');
      commit.files.forEach(file => list.append(commitFile(file, multiple, commit.folder)));
      if (commit.files.length === 1) list.firstChild.open = true;
      $('commit-files').replaceChildren(...(commit.files.length ? [list] : []));
    } catch (error) { if (mine === commitRequest) { $('commit-summary').textContent = ''; $('commit-error').textContent = error.message; $('commit-error').hidden = false; } }
    finally { if (mine === commitRequest) commitDialog.removeAttribute('aria-busy'); }
  }
  const closeCommit = () => { commitRequest++; if (commitDialog?.open) commitDialog.close(); };
  $('close-commit')?.addEventListener('click', closeCommit);
  $('done-commit')?.addEventListener('click', closeCommit);
  $('commit-github')?.addEventListener('click', () => { if (commitUrl) Promise.resolve(external(commitUrl)).catch(error => api.showNotice(error.message)); });
  window.addEventListener('relay-state', () => { if (commitDialog?.open && api.getState().taskId) closeCommit(); });

  function checkpointButton(entry, point) {
    const label = entry.kind === 'restore' && point.target.phase === 'before' ? 'Before restore · recover' : point.target.phase === 'before' ? 'Before' : 'After';
    const act = node('button', label, 'secondary-button');
    act.type = 'button';
    act.disabled = !point.available || api.isRunning() || Boolean(api.getState().taskId);
    act.title = point.reason || (api.isRunning() ? 'Available when the current run finishes.' : 'Review files, then restore this checkpoint.');
    act.addEventListener('click', () => open(point.target));
    return act;
  }

  function commitDetailRow(entry, multiple) {
    const row = node('div', undefined, 'timeline-commit-row');
    const head = node('div', undefined, 'timeline-subrow-head');
    head.append(node('span', entry.merge ? 'Merge commit' : 'Commit', 'timeline-subrow-kind'), node('time', formatTime(entry.at), 'timeline-subrow-time'));
    const subject = node('button', entry.subject || entry.shortHash, 'checkpoint-prompt commit-subject');
    subject.type = 'button'; subject.title = 'Show this commit’s changes';
    subject.addEventListener('click', () => openCommit(entry));
    const meta = node('p', undefined, 'checkpoint-meta timeline-commit-meta');
    meta.append(node('code', entry.shortHash, 'commit-hash'), document.createTextNode([multiple ? entry.folder : '', by(entry)].filter(Boolean).map(text => ` · ${text}`).join('')));
    row.append(head, subject, meta);
    return row;
  }

  function rewindDetailRow(entry) {
    const row = node('div', undefined, `timeline-subrow${entry.pending ? ' timeline-subrow-recovery' : ''}`);
    const head = node('div', undefined, 'timeline-subrow-head');
    const label = entry.kind === 'restore' ? (entry.pending ? 'Recovery checkpoint · restore started' : 'Workspace restored') : 'Undo / redo';
    head.append(node('span', label, 'timeline-subrow-kind'), node('time', formatTime(entry.at), 'timeline-subrow-time'));
    const summary = [entry.files === null ? 'File count unavailable' : `${plural(entry.files, 'file')} changed`, entry.left ? `${entry.left} left as they are` : ''].filter(Boolean).join(' · ');
    const meta = node('p', summary, 'checkpoint-meta');
    const actions = node('div', undefined, 'checkpoint-actions');
    for (const point of entry.checkpoints || []) actions.append(checkpointButton(entry, point));
    row.append(head, meta, actions);
    return row;
  }

  // Group flat /api/checkpoints entries into one Timeline row per message, with checkpoints, restores and commits
  // nested inside each message row's details (#196).
  function groupTimeline(entries) {
    const groups = [], byKey = new Map(), byRunId = new Map();
    const rewinds = [], commits = [];
    for (const entry of entries) {
      if (entry.kind === 'run') {
        const key = entry.messageId ? `msg:${entry.messageId}` : `run:${entry.id}`;
        let group = byKey.get(key);
        if (!group) {
          group = { key, runs: [], runIds: new Set(), rewinds: [], commits: [], at: entry.at || '', startAt: entry.at || '' };
          byKey.set(key, group);
          groups.push(group);
        }
        group.runs.push(entry);
        const rid = entry.runId || entry.id;
        group.runIds.add(rid);
        byRunId.set(rid, group);
        if (entry.at && (!group.at || String(entry.at) > String(group.at))) group.at = entry.at;
        if (entry.at && (!group.startAt || String(entry.at) < String(group.startAt))) group.startAt = entry.at;
      } else if (entry.kind === 'commit') commits.push(entry);
      else rewinds.push(entry);
    }
    groups.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const standaloneRewinds = [];
    for (const entry of rewinds) {
      const group = entry.runId ? byRunId.get(entry.runId) : null;
      if (group) group.rewinds.push(entry);
      else standaloneRewinds.push(entry);
    }
    const earlierCommits = [];
    for (const entry of commits) {
      let group = entry.by === 'run' && entry.runId ? byRunId.get(entry.runId) : null;
      if (!group && groups.length) group = groups.find(candidate => candidate.startAt && String(candidate.startAt) <= String(entry.at || '')) || null;
      if (group) group.commits.push(entry);
      else earlierCommits.push(entry);
    }
    return { groups, standaloneRewinds, earlierCommits };
  }

  function messageCard(group, multiple) {
    const ordered = [...group.runs].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    const first = ordered[0], latest = ordered.at(-1);
    const prompt = ordered.map(r => cleanPrompt(r.prompt)).find(Boolean) || '';
    const providers = [...new Set(ordered.map(r => providerLabel(r.provider, r.local)))];
    const checkpointsMap = api.getState().conversation?.checkpoints || {};
    const undoRun = [...ordered].reverse().find(r => r.undone || checkpointsMap[r.runId || r.id]?.undone || r.canUndo || (r.files > 0)) || latest;
    const undoRunId = undoRun.runId || undoRun.id;
    const undone = undoRun.undone || checkpointsMap[undoRunId]?.undone || null;
    const beforeRunId = undoRun.beforeRunId || checkpointsMap[undoRunId]?.beforeRunId || first.runId || first.id;
    const beforeRun = ordered.find(r => (r.runId || r.id) === beforeRunId) || first;
    const beforePoint = (beforeRun.checkpoints || []).find(point => point.target?.phase === 'before') || null;
    const afterPoint = (undoRun.checkpoints || []).find(point => point.target?.phase === 'after') || null;
    const hasFiles = ordered.some(r => typeof r.files === 'number');
    const totalFiles = hasFiles ? ordered.reduce((sum, r) => sum + (typeof r.files === 'number' ? r.files : 0), 0) : null;
    const running = latest.status === 'running';
    const undoable = Boolean(!running && (undone || undoRun.canUndo || (undoRun.files > 0 && beforePoint?.available && afterPoint?.available)));

    const item = node('article', undefined, 'checkpoint-card timeline-message');
    const head = node('div', undefined, 'checkpoint-heading timeline-row-head');
    if (prompt) {
      const promptButton = node('button', prompt, 'checkpoint-prompt timeline-prompt');
      promptButton.type = 'button'; promptButton.title = 'Jump to this message in chat';
      promptButton.addEventListener('click', () => api.jumpToRun?.(first.runId || first.id));
      head.append(promptButton);
    } else {
      head.append(node('strong', providers.join(' → '), 'timeline-fallback-title'));
    }
    head.append(node('time', formatTime(group.at)));
    item.append(head);

    const statusText = running ? 'Working'
      : undone ? 'Changes undone'
      : totalFiles === null ? 'File count unavailable'
      : totalFiles === 0 ? 'No file changes'
      : `${plural(totalFiles, 'file')} changed`;
    const metaParts = [prompt ? providers.join(' → ') : '', latest.status === 'stopped' || latest.status === 'interrupted' ? 'Stopped' : '', statusText].filter(Boolean);
    const metaRow = node('div', undefined, 'timeline-meta-row');
    metaRow.append(node('p', metaParts.join(' · '), 'checkpoint-meta'));
    if (undoable) {
      const undoBtn = node('button', undone ? 'Redo' : 'Undo', 'secondary-button timeline-undo');
      undoBtn.type = 'button';
      undoBtn.disabled = api.isRunning() || Boolean(api.getState().taskId);
      undoBtn.title = undoBtn.disabled ? 'Available when the current run finishes.' : undone ? 'Redo this run’s changes, or remove this message from chat' : 'Undo changes, or undo and remove from chat';
      bindMenuButton(undoBtn, {
        runId: undoRunId,
        beforeRunId,
        undone,
        canUndo: true,
        beforeAvailable: beforePoint ? beforePoint.available : true,
        beforeReason: beforePoint?.reason || ''
      });
      metaRow.append(undoBtn);
    }
    item.append(metaRow);

    const checkpointCount = ordered.reduce((sum, r) => sum + (r.checkpoints?.length || 0), 0);
    const hasPending = group.rewinds.some(r => r.pending);
    if (checkpointCount || group.rewinds.length || group.commits.length) {
      const details = node('details', undefined, 'timeline-details');
      if (hasPending) details.open = true;
      const summaryParts = [
        checkpointCount ? plural(checkpointCount, 'checkpoint') : '',
        group.commits.length ? plural(group.commits.length, 'commit') : '',
        group.rewinds.length ? plural(group.rewinds.length, 'restore') : '',
        hasPending ? 'Recovery available' : ''
      ].filter(Boolean);
      details.append(node('summary', summaryParts.join(' · '), 'timeline-details-summary'));
      const body = node('div', undefined, 'timeline-details-body');
      if (checkpointCount) {
        for (const run of ordered) {
          if (!run.checkpoints?.length) continue;
          const block = node('div', undefined, 'timeline-subrow');
          if (ordered.length > 1) block.append(node('span', `${providerLabel(run.provider, run.local)} · ${run.files === null ? 'Checkpoints' : `${plural(run.files, 'file')} changed`}`, 'timeline-subrow-kind'));
          const actions = node('div', undefined, 'checkpoint-actions');
          for (const point of run.checkpoints) actions.append(checkpointButton(run, point));
          block.append(actions);
          body.append(block);
        }
      }
      for (const rewind of group.rewinds) body.append(rewindDetailRow(rewind));
      for (const commit of group.commits) body.append(commitDetailRow(commit, multiple));
      details.append(body);
      item.append(details);
    }
    return item;
  }

  function standaloneRewindCard(entry) {
    const item = node('article', undefined, 'checkpoint-card timeline-standalone');
    const head = node('div', undefined, 'checkpoint-heading');
    const title = entry.kind === 'restore' ? (entry.pending ? 'Recovery checkpoint · restore started' : 'Workspace restored') : 'Undo / redo';
    head.append(node('strong', title), node('time', formatTime(entry.at)));
    item.append(head);
    item.append(node('p', [entry.files === null ? 'File count unavailable' : `${plural(entry.files, 'file')} changed`, entry.left ? `${entry.left} left as they are` : ''].filter(Boolean).join(' · '), 'checkpoint-meta'));
    const actions = node('div', undefined, 'checkpoint-actions');
    for (const point of entry.checkpoints || []) actions.append(checkpointButton(entry, point));
    item.append(actions);
    return item;
  }

  const panel = $('timeline-panel'), host = $('timeline-content');
  let shown = null, historyRequest = 0, lastProject = null;
  const scope = () => { const state = api.getState(); return JSON.stringify([state.projectId, state.taskId, state.conversation?.id, state.conversation?.checkpointRevision, state.conversation?.status]); };
  const remember = value => { try { localStorage.setItem('throughline:side-panel', value); } catch { /* A convenience. */ } };
  function renderTimeline(entries) {
    host.replaceChildren();
    const { groups, standaloneRewinds, earlierCommits } = groupTimeline(entries);
    const multiple = (api.getState().projects?.find(project => project.id === api.getState().projectId)?.folders?.length || 1) > 1;
    if (!groups.length && !standaloneRewinds.length) {
      host.append(node('p', 'No checkpoints yet. Files are saved before and after each agent run.', 'panel-empty'));
      if (earlierCommits.length) {
        const details = node('details', undefined, 'timeline-details timeline-commits-only');
        details.open = true;
        details.append(node('summary', `Recent commits (${earlierCommits.length})`, 'timeline-details-summary'));
        const body = node('div', undefined, 'timeline-details-body');
        for (const commit of earlierCommits) body.append(commitDetailRow(commit, multiple));
        details.append(body);
        host.append(details);
      }
      return;
    }
    const items = [
      ...groups.map(group => ({ kind: 'group', at: group.at, group })),
      ...standaloneRewinds.map(entry => ({ kind: 'rewind', at: entry.at, entry }))
    ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    for (const item of items) {
      host.append(item.kind === 'group' ? messageCard(item.group, multiple) : standaloneRewindCard(item.entry));
    }
    if (earlierCommits.length) {
      const details = node('details', undefined, 'timeline-details timeline-earlier-commits');
      details.append(node('summary', `Earlier commits (${earlierCommits.length})`, 'timeline-details-summary'));
      const body = node('div', undefined, 'timeline-details-body');
      for (const commit of earlierCommits) body.append(commitDetailRow(commit, multiple));
      details.append(body);
      host.append(details);
    }
  }
  async function loadTimeline(force = false) {
    if (!panel || panel.hidden) return;
    const state = api.getState(), key = scope();
    if (!force && key === shown) return;
    shown = key; const request = ++historyRequest;
    if (!state.projectId || state.taskId) { host.replaceChildren(node('p', state.taskId ? 'Open the main workspace conversation to view and restore checkpoints.' : 'Select a workspace to view its checkpoints.', 'panel-empty')); return; }
    host.replaceChildren(node('p', 'Loading checkpoints…', 'panel-empty'));
    try { const result = await api.api('/api/checkpoints', {}, state.projectId); if (request === historyRequest && key === scope()) renderTimeline(result.entries || []); }
    catch (error) { if (request === historyRequest && key === scope()) { shown = null; host.replaceChildren(node('p', error.message, 'panel-empty')); } }
  }
  function setTimeline(open, keep = true) {
    if (!panel) return;
    panel.hidden = !open;
    if (keep) remember(open ? 'timeline' : 'none');
    if (open) { window.relayAgents?.close(); window.relayGit?.close(); window.relayBrief?.close(); window.relayReviews?.closePanel?.(); loadTimeline(true); }
    window.dispatchEvent(new CustomEvent('relay-side-panel'));
  }
  $('refresh-timeline')?.addEventListener('click', () => loadTimeline(true));
  // Flow and the Plan have no side panel and show an open one as a sheet, so a workspace opened in either reopens nothing.
  window.addEventListener('relay-state', () => {
    const projectId = api.getState().projectId;
    if (projectId !== lastProject) {
      lastProject = projectId;
      let preferred; try { preferred = localStorage.getItem('throughline:side-panel'); } catch { /* Default closed. */ }
      if (!projectId) setTimeline(false, false);
      else if (panel?.hidden && preferred === 'timeline' && !['flow', 'plan'].includes(window.relayFlow?.view?.()) && window.matchMedia?.('(min-width: 1101px)').matches) setTimeline(true, false);
    }
    loadTimeline();
  });
  window.relayTimeline = { open: () => setTimeline(true), close: () => { if (panel && !panel.hidden) setTimeline(false, false); } };

  window.relayRewind = { open, openMenu, button };
})();

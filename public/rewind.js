(() => {
  'use strict';
  // Rewind (#20). A run that changed files gets one line on its timeline, "3 files changed · Undo". Undo first shows
  // exactly what would change, file by file, and nothing is written until you confirm. An undo can be redone.
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('rewind-dialog');
  if (!api || !dialog) return;
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const agent = preview => preview.local ? 'the local model' : { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[preview.provider] || 'the agent';
  const ACTIONS = { remove: 'Remove', restore: 'Restore', merge: 'Merge', recreate: 'Bring back' };
  const HINTS = { remove: 'The run added this file.', restore: 'Back to how it was before the run.', merge: 'The run’s edits come out; changes made since are kept.', recreate: 'The run deleted this file.' };
  let current = null, generation = 0, busy = false;

  // The line on a run's timeline. None for a run still working, or one that changed nothing.
  function row(runId) {
    const c = api.getState().conversation, saved = c?.checkpoints?.[runId];
    if (!saved?.files || (c.status === 'running' && c.activeRun?.id === runId)) return null;
    const entry = node('div', undefined, 'activity-entry run-checkpoint'), timeline = node('span', undefined, 'timeline-node');
    entry.dataset.runId = runId; timeline.setAttribute('aria-hidden', 'true'); timeline.append(node('span', undefined, 'activity-icon icon-checkpoint'));
    const head = node('div', undefined, 'activity-entry-header run-checkpoint-header');
    head.append(node('span', saved.undone ? 'Changes undone' : `${plural(saved.files, 'file')} changed`, 'activity-entry-title'));
    const action = node('button', saved.undone ? 'Redo' : 'Undo', 'text-link run-checkpoint-action');
    action.type = 'button'; action.disabled = c.status === 'running';
    action.title = action.disabled ? 'Available when the current run finishes' : saved.undone ? 'Put this run’s changes back' : 'Review this run’s changes, then undo them';
    action.addEventListener('click', () => open(saved.undone ? { kind: 'rewind', id: saved.undone } : { kind: 'run', id: runId }));
    head.append(action); entry.append(timeline, head);
    return entry;
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
  function fileRow(file, multiple) {
    const name = (multiple ? `${file.folder}/` : '') + (file.path || '');
    if (!ACTIONS[file.action]) {
      const item = node('li', undefined, 'rewind-left');
      item.append(node('code', name || file.folder), node('span', file.reason || 'Left as it is.'));
      return item;
    }
    const item = node('details', undefined, 'rewind-file'), summary = node('summary');
    item.dataset.action = file.action;
    const badge = node('span', ACTIONS[file.action], 'rewind-action'); badge.title = HINTS[file.action];
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
    const redo = current.target.kind === 'rewind', work = preview.files.filter(file => ACTIONS[file.action]), left = preview.files.filter(file => !ACTIONS[file.action]);
    const multiple = new Set(preview.files.map(file => file.folderId)).size > 1 || (api.getState().projects?.find(project => project.id === current.projectId)?.folders?.length || 1) > 1;
    $('rewind-title').textContent = `${redo ? 'Redo' : 'Undo'} ${agent(preview)}’s changes?`;
    const when = preview.startedAt ? new Date(preview.startedAt) : null;
    $('rewind-meta').textContent = [preview.prompt ? `“${preview.prompt.length > 120 ? preview.prompt.slice(0, 119) + '…' : preview.prompt}”` : '', when && !Number.isNaN(when.getTime()) ? when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''].filter(Boolean).join(' · ');
    const count = action => work.filter(file => file.action === action).length;
    const parts = redo ? (work.length ? [`puts back ${plural(work.length, 'file')} as the run left them`] : []) : [count('restore') && `restores ${plural(count('restore'), 'file')}`, count('merge') && `takes the run’s edits out of ${plural(count('merge'), 'file')}, keeping later changes`, count('remove') && `removes ${plural(count('remove'), 'file')} it added`, count('recreate') && `brings back ${plural(count('recreate'), 'file')} it deleted`].filter(Boolean);
    const summary = parts.length ? `This ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : redo ? 'There is nothing to put back: these files changed since the undo.' : 'There is nothing to undo: these files are already as they were before the run, or changed since.';
    $('rewind-summary').textContent = summary + (left.length ? ` ${plural(left.length, 'file')} ${left.length === 1 ? 'stays' : 'stay'} as ${left.length === 1 ? 'it is' : 'they are'}.` : '');
    const files = $('rewind-files'); files.replaceChildren();
    if (work.length) { const list = node('div', undefined, 'rewind-list'); work.forEach(file => list.append(fileRow(file, multiple))); if (work.length === 1) list.firstChild.open = true; files.append(list); }
    if (left.length) { const heading = node('h3', 'Left as they are', 'rewind-heading'), list = node('ul', undefined, 'rewind-left-list'); left.forEach(file => list.append(fileRow(file, multiple))); files.append(heading, list); }
    $('rewind-note').textContent = work.length ? redo ? 'You can undo this run again afterwards.' : 'You can redo this afterwards.' : '';
    $('confirm-rewind').textContent = redo ? 'Redo changes' : 'Undo changes';
    $('confirm-rewind').disabled = !work.length;
  }
  function failure(message) { $('rewind-error').textContent = message || ''; $('rewind-error').hidden = !message; }

  async function open(target) {
    const projectId = api.getState().projectId, mine = ++generation;
    current = { target, projectId, preview: null }; busy = false; failure('');
    $('rewind-title').textContent = target.kind === 'rewind' ? 'Redo changes?' : 'Undo changes?'; $('rewind-meta').textContent = '';
    $('rewind-summary').textContent = 'Comparing the files with this run’s checkpoint…'; $('rewind-files').replaceChildren(); $('rewind-note').textContent = '';
    $('confirm-rewind').textContent = target.kind === 'rewind' ? 'Redo changes' : 'Undo changes'; $('confirm-rewind').disabled = true;
    dialog.setAttribute('aria-busy', 'true');
    if (!dialog.open) dialog.showModal();
    try {
      const preview = await api.post('/api/checkpoints/preview', { target }, projectId);
      if (mine !== generation) return;
      current.preview = preview; render(preview);
    } catch (error) { if (mine === generation) { $('rewind-summary').textContent = ''; failure(error.message); } }
    finally { if (mine === generation) dialog.removeAttribute('aria-busy'); }
  }
  $('confirm-rewind').addEventListener('click', async () => {
    if (busy || !current?.preview) return;
    const { target, projectId, preview } = current, mine = generation;
    busy = true; $('confirm-rewind').disabled = true; dialog.setAttribute('aria-busy', 'true'); failure('');
    try {
      await api.post('/api/checkpoints/apply', { target, digest: preview.digest }, projectId);
      if (mine !== generation) return;
      dialog.close();
      await api.refresh?.();
    } catch (error) {
      if (mine !== generation) return;
      busy = false; dialog.removeAttribute('aria-busy');
      // Files changed since the preview: show the new preview, so what is confirmed is always what you saw.
      if (error.status === 409 && /Review the changes again/.test(error.message)) { await open(target); failure('Files changed since you opened this. Here is the updated preview.'); }
      else { failure(error.message); $('confirm-rewind').disabled = false; }
    }
  });
  const close = () => { generation++; busy = false; if (dialog.open) dialog.close(); };
  $('cancel-rewind').addEventListener('click', close);
  $('close-rewind').addEventListener('click', close);
  dialog.addEventListener('close', () => { generation++; busy = false; current = null; });
  // A different workspace's undo never stays open over another.
  window.addEventListener('relay-state', () => { if (dialog.open && current && api.getState().projectId !== current.projectId) close(); });

  window.relayRewind = { row, open };
})();

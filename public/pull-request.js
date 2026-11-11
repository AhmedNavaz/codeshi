(() => {
  'use strict';
  // Open pull request (#18, stage 3): the one place Codeshi pushes, and only from here. The dialog first shows where the
  // branch goes: the repository, the branch and the base, the commits, and any pull request already open for it. The
  // title and description are drafted from Codeshi's records, with no model, and the person edits them. Nothing is
  // pushed until they click.
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('pull-request-dialog');
  if (!api || !dialog) return;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const external = async url => { if (window.relayDesktop) await window.relayDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); };
  const link = (text, url) => { const button = el('button', text, 'text-link'); button.type = 'button'; button.addEventListener('click', () => external(url)); return button; };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  let preview = null, scope = null, busy = false, done = false, generation = 0;

  function error(message, output = '') {
    $('pull-request-error').textContent = message || ''; $('pull-request-error').hidden = !message;
    $('pull-request-output').textContent = output || ''; $('pull-request-output').hidden = !output;
  }
  function buttonText() {
    if (!preview) return 'Open pull request';
    if (preview.existing) return busy ? 'Pushing…' : `Push ${preview.unpushed === null ? 'commits' : plural(preview.unpushed, 'commit')}`;
    if (busy) return 'Opening…';
    return preview.onBase ? 'Create branch and open' : 'Push and open';
  }
  function controls() {
    $('pull-request-form').setAttribute('aria-busy', String(busy));
    const editing = preview && !done && !preview.blocked && !preview.upToDate;
    for (const id of ['pull-request-name', 'pull-request-body', 'pull-request-draft', 'pull-request-branch']) $(id).disabled = busy || !editing;
    const submit = $('pull-request-submit');
    submit.hidden = done || Boolean(preview?.upToDate);
    submit.textContent = buttonText();
    submit.disabled = busy || !editing || (!preview.existing && !$('pull-request-name').value.trim()) || (preview.onBase && !$('pull-request-branch').value.trim());
    $('pull-request-cancel').textContent = done || preview?.upToDate || preview?.blocked ? 'Close' : 'Cancel';
  }

  // Where the branch goes, in one line: repository, then branch → base.
  function route() {
    const box = $('pull-request-route'); box.replaceChildren();
    if (!preview) { box.append(el('span', busy ? 'Reading the branch…' : '', 'muted')); return; }
    const branch = preview.onBase ? ($('pull-request-branch').value.trim() || 'new branch') : preview.branch;
    box.append(el('span', preview.repo, 'pull-request-repo'), el('span', 'origin', 'pull-request-remote'), el('code', branch, 'pull-request-ref'), el('span', '→', 'pull-request-arrow'), el('code', preview.base, 'pull-request-ref'));
  }
  function notes() {
    const box = $('pull-request-notes'); box.replaceChildren();
    if (!preview) return;
    const note = (text, kind = '') => { const row = el('p', undefined, `pull-request-note${kind ? ` ${kind}` : ''}`); row.append(...[].concat(text)); box.append(row); return row; };
    if (preview.blocked) { note(preview.blocked, 'warning'); return; }
    if (preview.existing) {
      const row = note(preview.upToDate ? `#${preview.existing.number} is open for this branch and already has every commit. ` : `#${preview.existing.number} is already open for this branch. This pushes ${preview.unpushed === null ? 'the new commits' : plural(preview.unpushed, 'new commit')} to it. `);
      row.append(link(`Open #${preview.existing.number} ↗`, preview.existing.url));
    }
    if (preview.onBase) note(`You’re on ${preview.base}, and a pull request can’t come from the branch it merges into. Your ${preview.commitCount === null ? 'commits' : plural(preview.commitCount, 'commit')} move to the new branch below, and ${preview.base} goes back to where GitHub has it.`);
    if (!preview.compared) note(`origin/${preview.base} isn’t in this clone yet, so Codeshi can’t list which commits are new. Fetch in a terminal to see them.`, 'warning');
    if (preview.uncommitted) note(`${plural(preview.uncommitted, 'changed file')} ${preview.uncommitted === 1 ? 'isn’t' : 'aren’t'} committed and won’t be in the pull request.`, 'warning');
  }
  function commits() {
    const box = $('pull-request-commits'), list = $('pull-request-commit-list');
    list.replaceChildren();
    box.hidden = !preview?.commits?.length;
    if (box.hidden) return;
    const more = preview.commitCount > preview.commits.length ? preview.commitCount - preview.commits.length : 0;
    $('pull-request-commits-summary').textContent = `${plural(preview.commitCount ?? preview.commits.length, 'commit')} not on ${preview.base}`;
    for (const commit of preview.commits) { const row = el('li'); row.append(el('code', commit.shortHash, 'commit-hash'), el('span', commit.subject)); list.append(row); }
    if (more) list.append(el('li', `…and ${more} more`, 'muted'));
    box.open = preview.commits.length <= 5;
  }
  function render() {
    route(); notes(); commits();
    const showText = Boolean(preview && !preview.blocked && !preview.existing && !done);
    $('pull-request-text').hidden = !showText;
    $('pull-request-branch-field').hidden = !(preview?.onBase && !preview.blocked && !done);
    controls();
  }

  async function open(repo) {
    const state = api.getState();
    if (!state.projectId || !repo) return;
    const token = ++generation;
    scope = state.projectId; preview = null; busy = true; done = false; error('');
    $('pull-request-done').hidden = true; $('pull-request-done').replaceChildren();
    $('pull-request-name').value = ''; $('pull-request-body').value = ''; $('pull-request-draft').checked = false; $('pull-request-branch').value = '';
    render();
    if (!dialog.open) dialog.showModal();
    try {
      const result = await api.post('/api/git/pull-request/preview', { folderId: repo.folderId, conversationId: state.conversation?.id || null }, scope);
      if (token !== generation) return;
      preview = { ...result, folderId: repo.folderId };
      $('pull-request-name').value = result.draft.title; $('pull-request-body').value = result.draft.body;
      if (result.onBase) $('pull-request-branch').value = result.suggestedBranch || '';
    } catch (failure) {
      if (token !== generation) return;
      error(failure.message || 'The branch couldn’t be read.');
    } finally {
      if (token === generation) { busy = false; render(); (preview?.onBase ? $('pull-request-branch') : preview && !preview.existing ? $('pull-request-name') : $('pull-request-cancel')).focus(); }
    }
  }

  async function submit() {
    if (!preview || busy || done) return;
    const token = generation, projectId = scope;
    busy = true; error(''); controls();
    try {
      const result = await api.post('/api/git/pull-request', {
        folderId: preview.folderId, title: preview.existing ? preview.existing.title || preview.draft.title : $('pull-request-name').value, body: $('pull-request-body').value,
        draft: $('pull-request-draft').checked, ...preview.onBase ? { newBranch: $('pull-request-branch').value.trim() } : {},
        expected: { branch: preview.branch, head: preview.head, base: preview.base },
      }, projectId);
      if (token !== generation) return;
      done = true;
      window.relayGit?.update?.(result.git, projectId);
      const box = $('pull-request-done'); box.replaceChildren();
      const what = `#${result.pull.number}${result.pull.draft ? ' (draft)' : ''}`;
      box.append(el('strong', result.updated ? `Pushed to ${what}` : `Opened ${what}`), el('span', ` · ${result.branch} → ${preview.base}`, 'muted'));
      if (result.createdBranch) box.append(el('p', result.restoredBase ? `Your commits are on ${result.createdBranch}, and ${preview.base} is back where GitHub has it.` : `Your commits are on ${result.createdBranch}. ${preview.base} still has them too, because it had moved away from GitHub’s ${preview.base}.`, 'pull-request-note'));
      box.append(link('Open on GitHub ↗', result.pull.url));
      box.hidden = false;
      api.announce?.(`${result.updated ? 'Pushed to' : 'Opened'} pull request ${what}.`);
    } catch (failure) {
      if (token !== generation) return;
      const details = failure.details || {};
      let message = failure.message || 'The pull request couldn’t be opened.';
      if (details.createdBranch) message += ` Your commits are now on ${details.createdBranch}${details.restoredBase ? `, and ${details.base} is back where GitHub has it` : ''}.`;
      error(message, details.output || '');
      // Branch moves and pushes change what the dialog showed: read the branch again before another try.
      if (details.createdBranch || details.code === 'changed' || details.code === 'create') { window.relayGit?.refresh?.(); preview = null; done = true; }
    } finally { if (token === generation) { busy = false; render(); } }
  }

  function close() { generation++; busy = false; dialog.close(); }
  $('pull-request-form').addEventListener('submit', event => { event.preventDefault(); submit(); });
  $('pull-request-name').addEventListener('input', controls);
  $('pull-request-branch').addEventListener('input', () => { route(); controls(); });
  for (const id of ['pull-request-close', 'pull-request-cancel']) $(id).addEventListener('click', close);
  dialog.addEventListener('close', () => { if (busy) { generation++; busy = false; } });
  window.addEventListener('relay-state', () => { if (dialog.open && scope !== api.getState().projectId) close(); });
  window.relayPullRequest = { open };
})();

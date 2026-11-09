(() => {
  'use strict';
  // Add from GitHub: reads an issue or pull request through the person's gh login and puts it in the message box to
  // read and edit. Nothing is sent from here, and nothing is fetched until the person asks.
  const $ = id => document.getElementById(id), api = window.relayUI, dialog = $('github-context-dialog');
  if (!api || !dialog) return;
  let scope = null, busy = false, generation = 0;

  const project = () => { const state = api.getState(); return state.projects?.find(entry => entry.id === state.projectId); };
  const error = message => { $('github-context-error').textContent = message; $('github-context-error').hidden = !message; };
  function controls() {
    $('github-context-form').setAttribute('aria-busy', String(busy));
    for (const id of ['github-context-add', 'github-context-branch', 'github-context-folder', 'github-context-reference']) $(id).disabled = busy;
    $('github-context-add').textContent = busy ? 'Reading GitHub…' : 'Add to message';
  }
  function render() {
    const state = api.getState();
    $('github-context-open').disabled = !state.ready || !state.projectId || Boolean(state.pending);
    if (dialog.open && scope !== state.projectId) { generation++; busy = false; dialog.close(); }
  }
  function open() {
    const folders = project()?.folders || [], select = $('github-context-folder'), chosen = api.selectedFolderId?.();
    scope = api.getState().projectId;
    select.replaceChildren(...folders.map(folder => { const option = document.createElement('option'); option.value = folder.id; option.textContent = folder.displayName || folder.name; return option; }));
    if (folders.some(folder => folder.id === chosen)) select.value = chosen;
    $('github-context-folder-label').hidden = folders.length < 2;
    busy = false; error(''); controls();
    dialog.showModal();
    $('github-context-reference').focus();
    $('github-context-reference').select();
  }
  async function add(reference) {
    if (busy) return;
    const token = ++generation, projectId = scope;
    busy = true; error(''); controls();
    try {
      const result = await api.post('/api/git/github-context', { reference, folderId: $('github-context-folder').value || '' }, projectId);
      if (token !== generation || projectId !== api.getState().projectId) return;
      const input = $('message-input');
      input.value = input.value.trim() ? `${input.value.trimEnd()}\n\n${result.text}` : result.text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      busy = false; dialog.close();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const what = `${result.kind === 'pull' ? 'Pull request' : 'Issue'} #${result.number}`;
      const removed = [result.removed?.secrets ? `${result.removed.secrets} possible secret${result.removed.secrets === 1 ? '' : 's'}` : '', result.removed?.paths ? `${result.removed.paths} local path${result.removed.paths === 1 ? '' : 's'}` : ''].filter(Boolean);
      const message = `${what} is in the message box. Read it, add what you want done, then send.${removed.length ? ` Removed ${removed.join(' and ')}.` : ''}${result.truncated ? ' It was shortened to fit.' : ''}`;
      api.showNotice?.(message);
      api.announce?.(message);
    } catch (failure) {
      if (token !== generation) return;
      busy = false; error(failure.message || 'GitHub could not be read.');
    } finally { if (token === generation) controls(); }
  }

  $('github-context-open').addEventListener('click', open);
  $('github-context-form').addEventListener('submit', event => {
    event.preventDefault();
    const reference = $('github-context-reference').value.trim();
    if (!reference) { error('Enter an issue or pull request number, or paste a link to one.'); $('github-context-reference').focus(); return; }
    add(reference);
  });
  $('github-context-branch').addEventListener('click', () => add(''));
  for (const id of ['github-context-close', 'github-context-cancel']) $(id).addEventListener('click', () => { generation++; busy = false; dialog.close(); });
  dialog.addEventListener('close', () => { if (busy) { generation++; busy = false; } });
  window.addEventListener('relay-state', render);
  render();
})();

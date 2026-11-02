(() => {
  'use strict';
  const $ = id => document.getElementById(id), api = window.relayUI;
  const panel = $('project-commands'), drafts = new Map(), states = new Map();
  const active = session => ['starting', 'running', 'stopping'].includes(session?.status);
  let projectId = '', action = 'run', pending = false, generation = 0, loading = false;
  const requests = new Map();
  const key = () => projectId + ':' + action;
  const project = () => api.getState().projects.find(project => project.id === projectId);
  const config = () => ({ folderId: $('command-folder').value, directory: $('command-directory').value.trim(), command: $('command-text').value.trim() });
  const error = text => { $('command-error').textContent = text; $('command-error').hidden = !text; };
  function remember() { if (projectId && !loading) drafts.set(key(), config()); }
  function controls() {
    const session = states.get(projectId)?.sessions?.[action], running = active(session);
    const selectedFolder = project()?.folders.find(folder => folder.id === $('command-folder').value);
    $('command-location').textContent = selectedFolder ? selectedFolder.path + ($('command-directory').value.trim() ? '/' + $('command-directory').value.trim() : '') : 'Choose an attached folder.';
    for (const id of ['command-folder', 'command-directory', 'command-text', 'command-detect', 'command-save']) $(id).disabled = pending || running || !projectId;
    $('command-start').disabled = pending || running || !projectId || !$('command-text').value.trim();
    $('command-start').textContent = action === 'run' ? 'Run project' : 'Run tests';
    $('command-stop').disabled = pending || !running || session.status === 'stopping';
    for (const value of ['run', 'test']) $('command-tab-' + value).setAttribute('aria-pressed', String(value === action));
    const count = Object.values(states.get(projectId)?.sessions || {}).filter(active).length;
    $('open-commands').setAttribute('aria-expanded', String(!panel.hidden));
    $('command-badge').textContent = count ? String(count) : ''; $('command-badge').hidden = !count;
  }
  function renderSession() {
    const session = states.get(projectId)?.sessions?.[action], output = $('command-output');
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 60;
    const text = session?.output || (session ? 'No output yet.' : 'Output will appear here when you start a command.');
    if (output.textContent !== text) { output.textContent = text; if (follow) output.scrollTop = output.scrollHeight; }
    const labels = { starting: 'Starting', running: 'Running', stopping: 'Stopping…', stopped: 'Stopped', exited: 'Exited', failed: 'Failed' };
    $('command-status').textContent = session ? labels[session.status] + (session.exitCode !== null ? ` · exit ${session.exitCode}` : '') + (session.error ? ' · ' + session.error : '') : 'Ready';
    $('command-status').dataset.status = session?.status || 'idle';
    $('command-executed').textContent = session ? `${session.command}\n${session.cwd}` : '';
    $('command-truncated').hidden = !session?.truncated;
    $('command-links').replaceChildren();
    for (const url of session?.urls || []) {
      // Validate again at the UI boundary before handing a log-derived URL to the OS.
      let parsed; try { parsed = new URL(url); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-link'; button.textContent = 'Open ' + parsed.host + ' ↗'; button.title = url;
      button.addEventListener('click', async () => { try { if (window.relayDesktop) await window.relayDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); } catch (failure) { error(failure.message); } });
      $('command-links').append(button);
    }
    controls();
  }
  function fill() {
    loading = true;
    const value = drafts.get(key()) || states.get(projectId)?.commands?.[action];
    $('command-folder').replaceChildren();
    for (const folder of project()?.folders || []) {
      const option = document.createElement('option'); option.value = folder.id; option.textContent = (folder.displayName || folder.name) + (folder.available === false ? ' (unavailable)' : ''); $('command-folder').append(option);
    }
    $('command-folder').value = value?.folderId || api.selectedFolderId?.() || project()?.folders?.[0]?.id || '';
    $('command-directory').value = value?.directory || '';
    $('command-text').value = value?.command || '';
    $('command-suggestions').replaceChildren();
    $('command-detection').textContent = 'Choose a folder or package subdirectory, then find suggested commands. You can also enter any command.';
    $('command-config').open = !active(states.get(projectId)?.sessions?.[action]);
    loading = false; error(''); renderSession();
  }
  async function refresh() {
    const scope = projectId, version = generation;
    if (!scope || pending) return;
    let request = requests.get(scope);
    if (!request) {
      request = api.api('/api/commands', {}, scope).then(value => { states.set(scope, value); window.dispatchEvent(new CustomEvent('relay-commands', { detail: { projectId: scope, commands: value.commands } })); return value; }).finally(() => requests.delete(scope));
      requests.set(scope, request);
    }
    try {
      await request;
      if (scope === projectId && version === generation) renderSession();
    } catch (failure) { if (scope === projectId && version === generation && !panel.hidden) error(failure.message); }
  }
  async function perform(callback) {
    if (pending || !projectId) return;
    const scope = projectId, version = generation, selectedAction = action;
    pending = true; error(''); controls();
    try { await callback(scope, selectedAction, () => scope === projectId && version === generation); }
    catch (failure) { if (scope === projectId && version === generation) error(failure.message); else api.showNotice(failure.message); }
    finally { pending = false; controls(); await refresh(); }
  }
  $('command-detect').addEventListener('click', () => perform(async (scope, selectedAction, current) => {
    const value = await api.post('/api/commands/detect', config(), scope);
    if (!current()) return;
    $('command-detection').textContent = (value.manager ? `Package manager: ${value.manager}. ` : '') + value.message;
    $('command-suggestions').replaceChildren();
    for (const script of value.scripts) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = script;
      button.addEventListener('click', () => { if (pending || active(states.get(projectId)?.sessions?.[action])) return; $('command-text').value = value.manager + ' run ' + script; remember(); controls(); });
      $('command-suggestions').append(button);
    }
    if (!$('command-text').value.trim() && value.suggestions[selectedAction]) { $('command-text').value = value.suggestions[selectedAction]; remember(); }
  }));
  $('command-save').addEventListener('click', () => perform(async (scope, selectedAction, current) => {
    const value = await api.post('/api/commands/' + selectedAction, config(), scope);
    drafts.set(scope + ':' + selectedAction, value);
    if (current()) $('command-detection').textContent = 'Command saved. It will run only when you click ' + (selectedAction === 'run' ? 'Run project.' : 'Run tests.');
  }));
  $('command-start').addEventListener('click', () => perform(async (scope, selectedAction, current) => {
    const value = config();
    await api.post('/api/commands/' + selectedAction + '/start', value, scope);
    drafts.set(scope + ':' + selectedAction, value);
    if (current()) $('command-config').open = false;
  }));
  $('command-stop').addEventListener('click', () => perform(async (scope, selectedAction) => {
    const session = states.get(scope)?.sessions?.[selectedAction];
    if (session) await api.post('/api/commands/' + selectedAction + '/stop', { sessionId: session.id }, scope);
  }));
  for (const id of ['command-folder', 'command-directory', 'command-text']) $(id).addEventListener(id === 'command-folder' ? 'change' : 'input', () => {
    remember(); controls();
    if (id !== 'command-text') { $('command-suggestions').replaceChildren(); $('command-detection').textContent = 'Location changed. Find suggestions for this directory or edit your command.'; }
  });
  for (const value of ['run', 'test']) $('command-tab-' + value).addEventListener('click', () => { if (pending) return; remember(); generation++; action = value; fill(); refresh(); });
  function hide() { remember(); panel.hidden = true; controls(); $('open-commands').focus(); }
  $('close-commands').addEventListener('click', hide);
  $('open-commands').addEventListener('click', async () => {
    if (!panel.hidden) { hide(); return; }
    panel.hidden = false; controls();
    const scope = projectId, version = generation;
    await refresh(); if (scope !== projectId || version !== generation) return;
    fill(); $('command-text').focus();
  });
  window.addEventListener('relay-state', () => {
    const selected = api.getState().projectId;
    if (selected !== projectId) { remember(); projectId = selected; generation++; fill(); refresh().then(() => { if (selected === projectId) fill(); }); }
    $('open-commands').disabled = !selected;
  });
  // Poll only the selected workspace; owned processes continue independently of this view.
  setInterval(() => { if (!document.hidden) refresh(); }, 1500);
  window.relayCommands = { open: () => { if (panel.hidden) $('open-commands').click(); }, refresh };
})();

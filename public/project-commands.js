(() => {
  'use strict';
  // Run, a tab of the bottom panel: the workspace's own commands, such as its dev server, tests, build or any script.
  // The list on the left shows each one's state; the selected one's output fills the rest, with its colours, links to
  // local addresses and Start, Stop and Restart. Commands are added or edited in a short form that offers what the
  // folder already defines. Commands run in the person's own shell until stopped, whether or not the panel shows.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('project-commands');
  if (!api || !panel) return;
  const states = new Map(), selected = new Map(), found = new Map(), requests = new Map();
  const active = session => ['starting', 'running', 'stopping'].includes(session?.status);
  let projectId = '', pending = false, generation = 0, form = null, tick = 0;
  const project = () => api.getState().projects.find(item => item.id === projectId);
  const state = () => states.get(projectId) || { commands: [], sessions: {} };
  const current = () => state().commands.find(command => command.id === selected.get(projectId)) || state().commands[0] || null;
  const sessionOf = command => command ? state().sessions[command.id] || null : null;
  const error = text => { $('command-error').textContent = text || ''; $('command-error').hidden = !text; };
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const folderName = folderId => { const folder = project()?.folders.find(item => item.id === folderId); return folder ? folder.displayName || folder.name : ''; };
  const place = command => [folderName(command.folderId), command.directory].filter(Boolean).join('/');
  const elapsed = since => { const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000)); return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; };
  function describe(session) {
    if (!session) return 'Not started';
    if (session.status === 'starting') return 'Starting…';
    if (session.status === 'running') return `Running · ${elapsed(session.startedAt)}`;
    if (session.status === 'stopping') return 'Stopping…';
    if (session.status === 'stopped') return 'Stopped';
    if (session.status === 'exited') return `Finished${session.exitCode ? ` · exit ${session.exitCode}` : ''}`;
    return session.error ? `Failed · ${session.error}` : `Failed${session.exitCode !== null && session.exitCode !== undefined ? ` · exit ${session.exitCode}` : ''}`;
  }

  // Output keeps its colours: only colour and weight codes are read, everything else a program writes to move the
  // cursor or set a title is dropped, and a line a program rewrites in place shows as it ended. Text is never markup.
  const COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  function paint(target, text) {
    const clean = String(text || '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[A-Za-ln-z]/g, '').replace(/\u001b[()][A-Za-z0-9]/g, '')
      .split('\n').map(line => line.includes('\r') ? line.split('\r').filter(Boolean).at(-1) ?? '' : line).join('\n');
    const parts = clean.split(/\u001b\[([0-9;]*)m/), style = { fg: null, bold: false, dim: false };
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < parts.length; index++) {
      if (index % 2) {
        for (const code of (parts[index] || '0').split(';').map(Number)) {
          if (code === 0) Object.assign(style, { fg: null, bold: false, dim: false });
          else if (code === 1) style.bold = true; else if (code === 2) style.dim = true; else if (code === 22) style.bold = style.dim = false;
          else if (code >= 30 && code <= 37) style.fg = COLOURS[code - 30]; else if (code >= 90 && code <= 97) style.fg = 'bright-' + COLOURS[code - 90]; else if (code === 39) style.fg = null;
        }
        continue;
      }
      const value = parts[index].replace(/\u001b/g, '');
      if (!value) continue;
      if (!style.fg && !style.bold && !style.dim) { fragment.append(document.createTextNode(value)); continue; }
      fragment.append(node('span', [style.fg && `ansi-${style.fg}`, style.bold && 'ansi-bold', style.dim && 'ansi-dim'].filter(Boolean).join(' '), value));
    }
    target.replaceChildren(fragment);
  }

  function renderCounts() {
    const sessions = Object.values(state().sessions), running = sessions.filter(active).length, failed = sessions.some(session => session?.status === 'failed');
    $('run-tab-count').textContent = running ? String(running) : ''; $('run-tab-count').hidden = !running;
    const badge = $('status-run-state');
    if (badge) { badge.hidden = !running && !failed; badge.dataset.state = running ? 'running' : 'failed'; badge.textContent = running ? String(running) : ''; badge.title = running ? `${running} running` : 'A command failed'; }
    $('status-run')?.setAttribute('aria-label', `Run${running ? `, ${running} running` : failed ? ', a command failed' : ''}`);
  }

  function renderList() {
    const list = $('command-list'), chosen = current();
    list.hidden = !state().commands.length;
    list.replaceChildren(...state().commands.map(command => {
      const session = sessionOf(command), row = node('div', 'command-row');
      row.dataset.commandId = command.id; row.dataset.status = session?.status || 'idle';
      const pick = node('button', 'command-pick'); pick.type = 'button';
      if (command === chosen) pick.setAttribute('aria-current', 'true');
      pick.append(node('span', 'command-dot'), node('span', 'command-name', command.name));
      if (command.test) { const mark = node('span', 'command-test-mark'); mark.title = 'Used by Check with tests'; mark.setAttribute('aria-label', 'Used by Check with tests'); pick.append(mark); }
      pick.title = `${command.command}${place(command) ? ` · ${place(command)}` : ''}`;
      pick.addEventListener('click', () => { selected.set(projectId, command.id); form = null; error(''); refresh(); render(); });
      const running = active(session), quick = node('button', `icon-button command-quick ${running ? 'stop' : 'start'}`);
      quick.type = 'button'; quick.setAttribute('aria-label', `${running ? 'Stop' : 'Start'} ${command.name}`); quick.title = running ? 'Stop' : 'Start';
      quick.disabled = pending || session?.status === 'stopping';
      quick.addEventListener('click', () => { selected.set(projectId, command.id); running ? stop(command) : start(command); });
      row.append(pick, quick);
      return row;
    }));
  }

  function renderView() {
    const command = current(), session = sessionOf(command), running = active(session);
    $('command-state').textContent = describe(session); $('command-state').dataset.status = session?.status || 'idle';
    $('command-line').textContent = command.command; $('command-line').title = place(command) ? `Runs in ${place(command)}` : '';
    $('command-start').hidden = running; $('command-start').disabled = pending;
    $('command-stop').hidden = !running; $('command-stop').disabled = pending || session?.status === 'stopping';
    $('command-restart').hidden = !running; $('command-restart').disabled = pending || session?.status === 'stopping';
    $('command-clear').hidden = !session || running; $('command-clear').disabled = pending;
    $('command-edit').disabled = pending;
    $('command-fix').hidden = session?.status !== 'failed';
    $('command-truncated').hidden = !session?.truncated;
    $('command-links').replaceChildren();
    for (const url of session?.urls || []) {
      // Validate again at the UI boundary before handing a log-derived URL to the OS.
      let parsed; try { parsed = new URL(url); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) continue;
      const link = node('button', 'command-link', parsed.host); link.type = 'button'; link.title = `Open ${url}`;
      link.addEventListener('click', async () => { try { if (window.relayDesktop) await window.relayDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); } catch (failure) { error(failure.message); } });
      $('command-links').append(link);
    }
    const output = $('command-output'), text = session ? session.ansi ?? session.output ?? '' : '';
    if (output.dataset.text !== text || output.dataset.command !== command.id) {
      const follow = output.dataset.command !== command.id || output.scrollHeight - output.scrollTop - output.clientHeight < 60;
      output.dataset.text = text; output.dataset.command = command.id;
      if (text) { output.classList.remove('placeholder'); paint(output, text); }
      else { output.classList.add('placeholder'); output.textContent = session ? 'No output yet.' : 'Start it to see its output here.'; }
      if (follow) output.scrollTop = output.scrollHeight;
    }
  }

  // Commands the folder already defines, as one-click choices. Each shows its name and the command it runs.
  function chips(host, suggestions, choose) {
    host.replaceChildren(...suggestions.map(suggestion => {
      const chip = node('button', 'command-chip'); chip.type = 'button';
      chip.append(node('span', 'command-chip-name', suggestion.name), node('code', 'command-chip-line', suggestion.command));
      chip.disabled = pending;
      chip.addEventListener('click', () => choose(suggestion));
      return chip;
    }));
    host.hidden = !suggestions.length;
  }
  async function detect(folderId, directory = '') {
    const scope = projectId, cacheKey = `${scope}:${folderId}:${directory}`;
    if (found.has(cacheKey)) return found.get(cacheKey);
    const value = await api.post('/api/commands/detect', { folderId, directory }, scope);
    found.set(cacheKey, value); return value;
  }
  const unused = suggestions => suggestions.filter(suggestion => !state().commands.some(command => command.command === suggestion.command));

  function renderEmpty() {
    const folderId = api.selectedFolderId?.() || project()?.folders?.[0]?.id, scope = projectId, version = generation;
    const show = value => { if (scope !== projectId || version !== generation) return; chips($('command-quick'), unused(value.suggestions).slice(0, 8), suggestion => add(suggestion, folderId)); };
    if (!folderId) return;
    const cached = found.get(`${scope}:${folderId}:`);
    if (cached) show(cached); else detect(folderId).then(show).catch(() => {});
  }

  function render() {
    renderCounts();
    if (panel.hidden) return;
    const commands = state().commands;
    renderList();
    $('command-form').hidden = !form;
    $('command-empty').hidden = Boolean(form) || commands.length > 0;
    $('command-view').hidden = Boolean(form) || !commands.length;
    $('command-add').disabled = pending || !projectId || commands.length >= 12;
    if (form) return;
    if (!commands.length) renderEmpty(); else renderView();
  }

  async function refresh() {
    const scope = projectId, version = generation;
    if (!scope) return;
    const want = panel.hidden ? 'none' : current()?.id || 'none', requestKey = `${scope}:${want}`;
    let request = requests.get(requestKey);
    if (!request) {
      request = api.api(`/api/commands?output=${encodeURIComponent(want)}`, {}, scope).finally(() => requests.delete(requestKey));
      requests.set(requestKey, request);
    }
    try {
      const value = await request, previous = states.get(scope);
      // A poll that left out output keeps the output already shown.
      for (const [id, session] of Object.entries(value.sessions || {})) if (!('output' in session) && previous?.sessions?.[id]?.id === session.id) Object.assign(session, { output: previous.sessions[id].output, ansi: previous.sessions[id].ansi });
      states.set(scope, value);
      window.dispatchEvent(new CustomEvent('relay-commands', { detail: { projectId: scope, commands: value.commands } }));
      if (scope === projectId && version === generation) render();
    } catch (failure) { if (scope === projectId && version === generation && !panel.hidden) error(failure.message); }
  }
  async function perform(callback) {
    if (pending || !projectId) return;
    const scope = projectId, version = generation;
    pending = true; error(''); render();
    try { await callback(scope, () => scope === projectId && version === generation); }
    catch (failure) { if (scope === projectId && version === generation) error(failure.message); else api.showNotice(failure.message); }
    finally { pending = false; await refresh(); render(); }
  }
  const start = command => perform(scope => api.post('/api/commands/start', { id: command.id }, scope));
  const stop = command => perform(async scope => { const session = states.get(scope)?.sessions?.[command.id]; if (session) await api.post('/api/commands/stop', { id: command.id, sessionId: session.id }, scope); });
  // A suggestion from the folder is added in one click and selected, ready to start.
  const add = (suggestion, folderId) => perform(async (scope, still) => {
    const saved = await api.post('/api/commands/save', { name: suggestion.name, command: suggestion.command, folderId, directory: '', test: Boolean(suggestion.test) && !states.get(scope)?.commands.some(command => command.test) }, scope);
    if (still()) selected.set(scope, saved.id);
  });

  // The form adds a command or edits one. It offers what the chosen folder defines, and saves only what is entered.
  function openForm(command = null, { test = false } = {}) {
    form = { id: command?.id || null };
    const folders = project()?.folders || [];
    $('command-form-title').textContent = command ? `Edit ${command.name}` : test ? 'Choose a test command' : 'Add a command';
    $('command-folder').replaceChildren(...folders.map(folder => { const option = node('option', '', (folder.displayName || folder.name) + (folder.available === false ? ' (unavailable)' : '')); option.value = folder.id; return option; }));
    $('command-folder').value = command?.folderId || api.selectedFolderId?.() || folders[0]?.id || '';
    $('command-folder-field').hidden = folders.length < 2;
    $('command-name').value = command?.name || ''; $('command-directory').value = command?.directory || ''; $('command-text').value = command?.command || '';
    $('command-test').checked = command ? command.test === true : test;
    $('command-remove').hidden = !command;
    $('command-suggestions').replaceChildren(); $('command-detection').textContent = ''; $('command-detection').hidden = true;
    error(''); render(); suggest();
    (command ? $('command-text') : $('command-name')).focus();
  }
  function closeForm() { form = null; error(''); render(); }
  let suggestTimer = null;
  function suggest() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const folderId = $('command-folder').value, directory = $('command-directory').value.trim(), scope = projectId, opened = form;
      if (!folderId || !form) return;
      try {
        const value = await detect(folderId, directory);
        if (scope !== projectId || opened !== form) return;
        // The suggestions speak for themselves; the note only says when there are none.
        $('command-detection').textContent = value.suggestions.length ? '' : value.message; $('command-detection').hidden = Boolean(value.suggestions.length);
        chips($('command-suggestions'), unused(value.suggestions), suggestion => {
          $('command-name').value = suggestion.name; $('command-text').value = suggestion.command;
          if (suggestion.test && !state().commands.some(command => command.test && command.id !== form?.id)) $('command-test').checked = true;
          $('command-text').focus();
        });
      } catch (failure) { if (scope === projectId && opened === form) { $('command-detection').textContent = failure.message; $('command-detection').hidden = false; chips($('command-suggestions'), [], () => {}); } }
    }, 150);
  }
  $('command-folder').addEventListener('change', suggest);
  $('command-directory').addEventListener('input', suggest);
  $('command-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = { ...(form?.id ? { id: form.id } : {}), name: $('command-name').value.trim(), folderId: $('command-folder').value, directory: $('command-directory').value.trim(), command: $('command-text').value.trim(), test: $('command-test').checked };
    perform(async (scope, still) => { const saved = await api.post('/api/commands/save', input, scope); if (still()) { selected.set(scope, saved.id); form = null; } });
  });
  $('command-cancel').addEventListener('click', closeForm);
  $('command-remove').addEventListener('click', () => { const id = form?.id; if (id) perform(async (scope, still) => { await api.post('/api/commands/remove', { id }, scope); if (still()) { selected.delete(scope); form = null; } }); });
  $('command-add').addEventListener('click', () => openForm());
  $('command-custom').addEventListener('click', () => openForm());
  $('command-edit').addEventListener('click', () => { const command = current(); if (command) openForm(command); });
  $('command-start').addEventListener('click', () => { const command = current(); if (command) start(command); });
  $('command-stop').addEventListener('click', () => { const command = current(); if (command) stop(command); });
  $('command-restart').addEventListener('click', () => { const command = current(); if (command) perform(scope => api.post('/api/commands/restart', { id: command.id }, scope)); });
  $('command-clear').addEventListener('click', () => { const command = current(); if (command) perform(scope => api.post('/api/commands/clear', { id: command.id }, scope)); });
  // A failed command can go to an agent: its command and the end of its output are put in the message box, to read
  // and send. Nothing is sent from here.
  $('command-fix').addEventListener('click', () => {
    const command = current(), session = sessionOf(command), input = $('message-input');
    if (!command || !session || !input) return;
    const tail = String(session.output || '').trim().slice(-3000);
    const text = [`The ${command.name} command failed${session.exitCode !== null && session.exitCode !== undefined ? ` with exit code ${session.exitCode}` : ''}. Find the cause and fix it.`, '', `Command: ${command.command}${place(command) ? ` (in ${place(command)})` : ''}`, '', 'End of its output:', '```', tail || '(no output)', '```'].join('\n');
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n\n${text}` : text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    api.announce?.('The failure is in the message box, ready to send.');
  });

  window.addEventListener('relay-panel', () => { if (!panel.hidden) { refresh(); render(); } });
  window.addEventListener('relay-state', () => {
    const chosen = api.getState().projectId;
    if (chosen === projectId) return;
    projectId = chosen; generation++; form = null; error('');
    render(); refresh();
  });
  // Poll only the selected workspace: often while the tab shows, now and then for the status bar otherwise. Commands
  // keep running whether or not anyone looks.
  setInterval(() => { if (document.hidden || !projectId) return; tick++; if (!panel.hidden || tick % 3 === 0) refresh(); }, 1500);
  window.relayCommands = {
    // Opens Run; for Check with tests, straight into choosing a test command when none is marked.
    open: ({ test = false } = {}) => { window.relayPanel?.show('run'); if (test && !state().commands.some(command => command.test)) openForm(null, { test: true }); },
    refresh,
  };
})();

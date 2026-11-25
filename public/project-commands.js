(() => {
  'use strict';
  // Run chooses commands in the sidebar; each output has its own main tab. The process belongs to the workspace,
  // so closing its output or switching workspaces leaves it running until Stop is used.
  const $ = id => document.getElementById(id), api = window.relayUI, panel = $('project-commands');
  if (!api || !panel) return;
  const states = new Map(), selected = new Map(), found = new Map(), requests = new Map(), outputs = new Map(), restored = new Set();
  const active = session => ['starting', 'running', 'stopping'].includes(session?.status);
  let projectId = '', pending = false, generation = 0, form = null, tick = 0;
  const project = (scope = projectId) => api.getState().projects.find(item => item.id === scope);
  const state = (scope = projectId) => states.get(scope) || { commands: [], sessions: {} };
  const current = () => state().commands.find(command => command.id === selected.get(projectId)) || state().commands[0] || null;
  const sessionOf = (command, scope = projectId) => command ? state(scope).sessions[command.id] || null : null;
  const error = text => { $('command-error').textContent = text || ''; $('command-error').hidden = !text; };
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const folderName = (folderId, scope = projectId) => { const folder = project(scope)?.folders.find(item => item.id === folderId); return folder ? folder.displayName || folder.name : ''; };
  const place = (command, scope = projectId) => [folderName(command.folderId, scope), command.directory].filter(Boolean).join('/');
  const several = (scope = projectId) => (project(scope)?.folders || []).length > 1;
  // Where a command runs, in full: its folder's path and the subdirectory inside it.
  const fullPath = (command, scope = projectId) => { const folder = project(scope)?.folders.find(item => item.id === command.folderId); return folder ? [folder.path, command.directory].filter(Boolean).join('/') : ''; };
  const outputKey = (scope, id) => JSON.stringify([scope, id]);
  const tabId = id => `command:${id}`;
  const failed = session => session?.status === 'failed' || (session?.status === 'exited' && Number(session.exitCode) !== 0);
  const localAddress = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password ? url.href : null; } catch { return null; } };
  const elapsed = since => { const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000)); return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`; };
  function describe(session) {
    if (!session) return 'Not started';
    if (session.status === 'starting') return 'Starting…';
    if (session.status === 'running') return `Running · ${elapsed(session.startedAt)}`;
    if (session.status === 'stopping') return 'Stopping…';
    if (session.status === 'stopped') return 'Stopped';
    if (session.status === 'exited' && !failed(session)) return 'Finished';
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
    const sessions = Object.values(state().sessions), running = sessions.filter(active).length, hasFailure = sessions.some(failed);
    if ($('run-tab-count')) { $('run-tab-count').textContent = running ? String(running) : ''; $('run-tab-count').hidden = !running; }
    const badge = $('status-run-state');
    if (badge) { badge.hidden = !running && !hasFailure; badge.dataset.state = running ? 'running' : 'failed'; badge.textContent = running ? String(running) : ''; badge.title = running ? `${running} running` : 'A command failed'; }
    $('status-run')?.setAttribute('aria-label', `Run${running ? `, ${running} running` : hasFailure ? ', a command failed' : ''}`);
  }

  // With several folders, each folder heads the commands that run in it, with + to add one there.
  function folderHeading(folder) {
    const name = folder ? folder.displayName || folder.name : 'Folder no longer in this workspace', heading = node('div', 'run-folder');
    heading.dataset.folderId = folder?.id || '';
    heading.append(node('span', 'run-folder-name', name));
    heading.title = folder?.path || 'Add the folder to the workspace again, or edit these commands to run elsewhere.';
    if (folder) {
      const add = node('button', 'icon-button run-folder-add'); add.type = 'button';
      add.setAttribute('aria-label', `Add a command in ${name}`); add.title = `Add a command in ${name}`; add.disabled = pending || state().commands.length >= 12;
      add.addEventListener('click', () => openForm(null, { folderId: folder.id }));
      heading.append(add);
    }
    return heading;
  }
  function renderList() {
    const list = $('command-list'), chosen = current(), commands = state().commands, folders = project()?.folders || [];
    list.hidden = !commands.length;
    if (!several()) { list.replaceChildren(...commands.map(command => commandRow(command, chosen))); return; }
    const groups = [...folders.map(folder => ({ folder, commands: commands.filter(command => command.folderId === folder.id) })), { folder: null, commands: commands.filter(command => !folders.some(folder => folder.id === command.folderId)) }];
    list.replaceChildren(...groups.filter(group => group.commands.length).flatMap(group => [folderHeading(group.folder), ...group.commands.map(command => commandRow(command, chosen))]));
  }
  function commandRow(command, chosen) {
      const scope = projectId, session = sessionOf(command), row = node('div', 'command-row');
      row.dataset.commandId = command.id; row.dataset.status = failed(session) ? 'failed' : session?.status || 'idle';
      const pick = node('button', 'command-pick'); pick.type = 'button';
      if (command === chosen) pick.setAttribute('aria-current', 'true');
      pick.append(node('span', 'command-dot'), node('span', 'command-name', command.name));
      // A command in a subdirectory of its folder says which.
      if (command.directory) pick.append(node('span', 'command-where', command.directory));
      if (command.test) { const mark = node('span', 'command-test-mark'); mark.title = 'Used by Check with tests'; mark.setAttribute('aria-label', 'Used by Check with tests'); pick.append(mark); }
      pick.title = `${command.command}${place(command) ? ` · runs in ${place(command)}` : ''}`;
      pick.addEventListener('click', () => { selected.set(scope, command.id); form = null; error(''); openOutput(command, scope); refresh(scope); render(); });
      const running = active(session), quick = node('button', `icon-button command-quick ${running ? 'stop' : 'start'}`);
      quick.type = 'button'; quick.setAttribute('aria-label', `${running ? 'Stop' : 'Start'} ${command.name}`); quick.title = running ? 'Stop' : 'Start';
      quick.disabled = pending || session?.status === 'stopping';
      quick.addEventListener('click', () => { selected.set(scope, command.id); running ? stop(command, scope) : start(command, scope); });
      row.append(pick, quick);
      if (window.relayTabs) {
        const status = node('span', 'command-row-state', describe(session)); row.append(status);
        if (session) {
          const restart = node('button', 'icon-button command-icon command-row-restart'); restart.type = 'button'; restart.dataset.icon = 'restart';
          restart.setAttribute('aria-label', `Restart ${command.name}`); restart.title = 'Restart'; restart.disabled = pending || session.status === 'stopping';
          restart.addEventListener('click', () => perform(id => api.post('/api/commands/restart', { id: command.id }, id), scope)); row.append(restart);
        }
        if (failed(session)) {
          const ask = node('button', 'text-link command-row-fix', 'Ask the agent'); ask.type = 'button';
          ask.addEventListener('click', () => askAgent(command, scope)); row.append(ask);
        }
      }
      return row;
  }

  function renderView(command = current(), scope = projectId, parts = null) {
    if (!command) return;
    const $ = id => parts ? parts[id.slice('command-'.length)] : document.getElementById(id);
    const session = sessionOf(command, scope), running = active(session);
    $('command-state').textContent = describe(session); $('command-state').dataset.status = session?.status || 'idle';
    $('command-line').textContent = command.command; $('command-line').title = place(command, scope) ? `Runs in ${place(command, scope)}` : '';
    // Where it runs, before what it runs: the folder, and the subdirectory inside it.
    const where = several(scope) || command.directory ? place(command, scope) : '';
    $('command-place').textContent = where; $('command-place').hidden = !where; $('command-place').title = fullPath(command, scope) ? `Runs in ${fullPath(command, scope)}` : '';
    $('command-start').hidden = running; $('command-start').disabled = pending;
    $('command-stop').hidden = !running; $('command-stop').disabled = pending || session?.status === 'stopping';
    $('command-restart').hidden = !session; $('command-restart').disabled = pending || session?.status === 'stopping';
    $('command-clear').hidden = !session || running; $('command-clear').disabled = pending;
    $('command-edit').disabled = pending;
    $('command-fix').hidden = !failed(session);
    // A running app with a local address can open in the preview, to point at what should change (#19).
    const address = running ? (session?.urls || []).map(localAddress).find(Boolean) : null;
    $('command-preview').hidden = !address || !window.relayPreview?.available; $('command-preview').dataset.url = address || '';
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

  function createOutput(command, scope) {
    const element = node('section', 'command-view command-tab-view'), parts = {};
    element.dataset.commandId = command.id; element.dataset.projectId = scope; element.hidden = true;
    element.setAttribute('aria-label', `${command.name} output`);
    const part = (name, tag, className, text) => { const value = node(tag, className, text); value.dataset.commandPart = name; parts[name] = value; return value; };
    const bar = node('div', 'run-pane-bar'), buttons = node('span', 'command-buttons');
    bar.append(part('state', 'span', 'command-state'), part('place', 'span', 'command-place'), part('line', 'code', 'command-line'), part('links', 'span', 'command-links'), buttons);
    parts.state.setAttribute('role', 'status');
    const latest = () => state(scope).commands.find(item => item.id === command.id);
    const action = (name, label, className, handler, icon = null) => {
      const button = part(name, 'button', className, icon ? undefined : label); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
      if (icon) button.dataset.icon = icon;
      button.addEventListener('click', () => { const item = latest(); if (item) handler(item); }); buttons.append(button);
    };
    action('fix', 'Ask the agent', 'toolbar-button command-fix', item => askAgent(item, scope));
    action('preview', 'Open preview', 'pill-button command-preview', () => { const url = localAddress(parts.preview.dataset.url); if (url && scope === projectId) window.relayPreview?.open(url); });
    action('start', 'Start', 'pill-button command-start', item => start(item, scope));
    action('stop', 'Stop', 'pill-button command-stop', item => stop(item, scope));
    action('restart', 'Restart', 'icon-button command-icon', item => perform(id => api.post('/api/commands/restart', { id: item.id }, id), scope), 'restart');
    action('clear', 'Clear output', 'icon-button command-icon', item => perform(id => api.post('/api/commands/clear', { id: item.id }, id), scope), 'clear');
    action('edit', 'Edit command', 'icon-button command-icon', item => { if (scope === projectId) openForm(item); }, 'edit');
    element.append(bar, part('truncated', 'p', 'command-note', 'Older output was discarded. Showing the latest 64K characters.'), part('output', 'pre', 'command-output'));
    parts.output.tabIndex = 0; parts.output.setAttribute('aria-label', `${command.name} output`);
    const entry = { scope, commandId: command.id, element, parts };
    outputs.set(outputKey(scope, command.id), entry); return entry;
  }
  function registerOutput(entry) {
    const { scope, commandId, element } = entry, command = state(scope).commands.find(item => item.id === commandId);
    if (!command) return;
    const session = sessionOf(command, scope);
    window.relayTabs.upsert({ id: tabId(commandId), projectId: scope, title: command.name, kind: 'command', element,
      state: active(session) ? 'running' : failed(session) ? 'failed' : session?.status === 'exited' ? 'finished' : !session && entry.restored ? 'restart' : 'stopped', restore: { commandId },
      onSelect: () => { selected.set(scope, commandId); if (scope === projectId) { renderList(); refresh(scope); } },
      onClose: () => { outputs.delete(outputKey(scope, commandId)); },
    });
    if (session) entry.restored = false;
    renderView(command, scope, entry.parts);
    entry.parts.start.textContent = !session && entry.restored ? 'Start again' : 'Start';
    if (!session && entry.restored) { entry.parts.output.textContent = 'This command is no longer running. Start again when you are ready.'; delete entry.parts.output.dataset.text; }
  }
  function openOutput(command, scope = projectId, { select = true, restore = false } = {}) {
    if (!command || !window.relayTabs) return;
    const entry = outputs.get(outputKey(scope, command.id)) || createOutput(command, scope);
    entry.restored ||= restore;
    registerOutput(entry);
    if (select && scope === projectId) window.relayTabs.select(tabId(command.id));
  }
  function renderOutputs(scope = projectId) {
    if (!window.relayTabs || !states.has(scope)) return;
    if (!restored.has(scope)) {
      restored.add(scope);
      for (const saved of window.relayTabs.getSaved(scope, 'command')) {
        const command = state(scope).commands.find(item => item.id === saved.restore?.commandId || tabId(item.id) === saved.id);
        if (command) openOutput(command, scope, { select: false, restore: true });
        else window.relayTabs.remove(saved.id, { projectId: scope });
      }
    }
    for (const entry of [...outputs.values()].filter(item => item.scope === scope)) {
      if (state(scope).commands.some(item => item.id === entry.commandId)) registerOutput(entry);
      else { outputs.delete(outputKey(scope, entry.commandId)); window.relayTabs.remove(tabId(entry.commandId), { projectId: scope }); }
    }
  }
  async function askAgent(command, scope = projectId) {
    // A sidebar failure may not have fetched its output yet. Read that command before drafting the message.
    if (!('output' in (sessionOf(command, scope) || {}))) await refresh(scope, command.id);
    if (scope !== projectId) return;
    const session = sessionOf(command, scope), input = $('message-input');
    if (!session || !input) return;
    const tail = String(session.output || '').trim().slice(-3000);
    const text = [`The ${command.name} command failed${session.exitCode !== null && session.exitCode !== undefined ? ` with exit code ${session.exitCode}` : ''}. Find the cause and fix it.`, '', `Command: ${command.command}${place(command, scope) ? ` (in ${place(command, scope)})` : ''}`, '', 'End of its output:', '```', tail || '(no output)', '```'].join('\n');
    window.relayTabs?.showChat();
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n\n${text}` : text;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    api.announce?.('The failure is in the message box, ready to send.');
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
    const folders = project()?.folders || [], scope = projectId, version = generation, host = $('command-quick');
    const fresh = () => scope === projectId && version === generation;
    host.classList.toggle('grouped', folders.length > 1);
    if (folders.length < 2) {
      const folderId = folders[0]?.id;
      if (!folderId) return;
      const show = value => { if (fresh()) chips(host, unused(value.suggestions).slice(0, 8), suggestion => add(suggestion, folderId)); };
      const cached = found.get(`${scope}:${folderId}:`);
      if (cached) show(cached); else detect(folderId).then(show).catch(() => {});
      return;
    }
    // With several folders, each offers what it defines under its own name, so it's clear where each one runs.
    const groups = new Map();
    const draw = () => { if (!fresh()) return; const shown = folders.map(folder => groups.get(folder.id)).filter(group => group?.suggestions.length); host.replaceChildren(...shown.map(group => group.element)); host.hidden = !shown.length; };
    for (const folder of folders) {
      const apply = value => {
        if (!fresh()) return;
        const suggestions = unused(value.suggestions).slice(0, 6), element = node('div', 'command-quick-group'), row = node('div', 'command-chips');
        element.dataset.folderId = folder.id;
        element.append(node('p', 'command-quick-folder', folder.displayName || folder.name), row);
        chips(row, suggestions, suggestion => add(suggestion, folder.id));
        groups.set(folder.id, { element, suggestions }); draw();
      };
      const cached = found.get(`${scope}:${folder.id}:`);
      if (cached) apply(cached); else detect(folder.id).then(apply).catch(() => {});
    }
  }

  function render() {
    renderCounts();
    renderOutputs();
    if (panel.hidden) return;
    const commands = state().commands;
    renderList();
    $('command-form').hidden = !form;
    $('command-empty').hidden = Boolean(form) || commands.length > 0;
    $('command-view').hidden = Boolean(window.relayTabs) || Boolean(form) || !commands.length;
    $('command-add').disabled = pending || !projectId || commands.length >= 12;
    if (form) return;
    if (!commands.length) renderEmpty(); else if (!window.relayTabs) renderView();
  }

  async function refresh(scope = projectId, wanted = null) {
    const version = generation;
    if (!scope) return;
    const hasOutputs = [...outputs.values()].some(item => item.scope === scope);
    const hasSaved = !restored.has(scope) && window.relayTabs?.getSaved(scope, 'command').length;
    const want = wanted || (window.relayTabs ? hasOutputs || hasSaved ? 'all' : 'none' : panel.hidden ? 'none' : current()?.id || 'none'), requestKey = `${scope}:${want}`;
    let request = requests.get(requestKey);
    if (!request) {
      request = api.api(want === 'all' ? '/api/commands' : `/api/commands?output=${encodeURIComponent(want)}`, {}, scope).finally(() => requests.delete(requestKey));
      requests.set(requestKey, request);
    }
    try {
      const value = await request, previous = states.get(scope);
      // A poll that left out output keeps the output already shown.
      for (const [id, session] of Object.entries(value.sessions || {})) if (!('output' in session) && previous?.sessions?.[id]?.id === session.id) Object.assign(session, { output: previous.sessions[id].output, ansi: previous.sessions[id].ansi });
      states.set(scope, value);
      if (window.relayTabs) {
        for (const entry of outputs.values()) {
          if (entry.scope !== scope) continue;
          const next = value.sessions?.[entry.commandId], before = previous?.sessions?.[entry.commandId];
          if (next && typeof next.output === 'string' && next.output !== before?.output && next.output) window.relayTabs.notify(tabId(entry.commandId), scope);
        }
      }
      window.dispatchEvent(new CustomEvent('relay-commands', { detail: { projectId: scope, commands: value.commands } }));
      if (scope === projectId && version === generation) render(); else renderOutputs(scope);
    } catch (failure) { if (scope === projectId && version === generation && !panel.hidden) error(failure.message); }
  }
  async function perform(callback, scope = projectId) {
    if (pending || !scope) return;
    const version = generation;
    pending = true; error(''); render();
    try { await callback(scope, () => scope === projectId && version === generation); }
    catch (failure) { if (scope === projectId && version === generation) error(failure.message); else api.showNotice(failure.message); }
    finally { pending = false; await refresh(scope); render(); }
  }
  const start = (command, scope = projectId) => { openOutput(command, scope); return perform(id => api.post('/api/commands/start', { id: command.id }, id), scope); };
  const stop = (command, scope = projectId) => perform(async id => { const session = states.get(id)?.sessions?.[command.id]; if (session) await api.post('/api/commands/stop', { id: command.id, sessionId: session.id }, id); }, scope);
  // A suggestion from the folder is added in one click and selected, ready to start.
  const add = (suggestion, folderId) => perform(async (scope, still) => {
    const saved = await api.post('/api/commands/save', { name: suggestion.name, command: suggestion.command, folderId, directory: '', test: Boolean(suggestion.test) && !states.get(scope)?.commands.some(command => command.test) }, scope);
    if (still()) { selected.set(scope, saved.id); await refresh(scope); openOutput(saved, scope); }
  });

  // The form adds a command or edits one. It offers what the chosen folder defines, and saves only what is entered.
  function openForm(command = null, { test = false, folderId = null } = {}) {
    window.relaySidebar?.show('run');
    form = { id: command?.id || null };
    const folders = project()?.folders || [];
    $('command-form-title').textContent = command ? `Edit ${command.name}` : test ? 'Choose a test command' : 'Add a command';
    $('command-folder').replaceChildren(...folders.map(folder => { const option = node('option', '', (folder.displayName || folder.name) + (folder.available === false ? ' (unavailable)' : '')); option.value = folder.id; return option; }));
    $('command-folder').value = command?.folderId || folderId || api.selectedFolderId?.() || folders[0]?.id || '';
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
    perform(async (scope, still) => { const saved = await api.post('/api/commands/save', input, scope); if (still()) { selected.set(scope, saved.id); form = null; await refresh(scope); openOutput(saved, scope); } });
  });
  $('command-cancel').addEventListener('click', closeForm);
  $('command-remove').addEventListener('click', () => { const id = form?.id; if (id) perform(async (scope, still) => { await api.post('/api/commands/remove', { id }, scope); if (still()) { selected.delete(scope); form = null; } }); });
  $('command-add').addEventListener('click', () => openForm());
  $('command-custom').addEventListener('click', () => openForm());
  $('command-edit').addEventListener('click', () => { const command = current(); if (command) openForm(command); });
  $('command-preview').addEventListener('click', () => { if ($('command-preview').dataset.url) window.relayPreview?.open($('command-preview').dataset.url); });
  $('command-start').addEventListener('click', () => { const command = current(); if (command) start(command); });
  $('command-stop').addEventListener('click', () => { const command = current(); if (command) stop(command); });
  $('command-restart').addEventListener('click', () => { const command = current(); if (command) perform(scope => api.post('/api/commands/restart', { id: command.id }, scope)); });
  $('command-clear').addEventListener('click', () => { const command = current(); if (command) perform(scope => api.post('/api/commands/clear', { id: command.id }, scope)); });
  // A failed command can go to an agent: its command and the end of its output are put in the message box, to read
  // and send. Nothing is sent from here.
  $('command-fix').addEventListener('click', () => { const command = current(); if (command) askAgent(command); });

  window.addEventListener('relay-panel', () => { if (!panel.hidden) { refresh(); render(); } });
  window.addEventListener('relay-sidebar', () => { if (!panel.hidden) { refresh(); render(); } });
  window.addEventListener('relay-state', () => {
    const chosen = api.getState().projectId;
    if (chosen === projectId) return;
    projectId = chosen; generation++; form = null; error('');
    render(); refresh();
  });
  // Open outputs keep their state and unread marker current even when Chat or another workspace is in front.
  setInterval(() => {
    if (document.hidden || !projectId) return;
    tick++;
    if (!panel.hidden || [...outputs.values()].some(item => item.scope === projectId) || tick % 3 === 0) refresh();
    if (tick % 3 === 0) for (const scope of new Set([...outputs.values()].map(item => item.scope))) if (scope !== projectId) refresh(scope);
  }, 1500);
  window.relayCommands = {
    // Opens Run; for Check with tests, straight into choosing a test command when none is marked.
    open: ({ test = false } = {}) => { if (window.relaySidebar) window.relaySidebar.show('run'); else window.relayPanel?.show('run'); if (test && !state().commands.some(command => command.test)) openForm(null, { test: true }); },
    refresh,
    // The local address of a running command, for opening the app in the preview.
    localURL: () => Object.values(state().sessions).filter(active).flatMap(session => session.urls || []).map(localAddress).find(Boolean) || null,
  };
})();

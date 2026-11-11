(() => {
  'use strict';
  // Uses the shared UI API; Git, model controls and usage do not own history state.
  const $ = id => document.getElementById(id), api = window.relayUI;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const name = provider => provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude' : 'Codex';
  const date = value => !value || Number.isNaN(new Date(value).getTime()) ? 'Date unavailable' : new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const action = (text, fn, cls) => { const button = el('button', text, cls); button.type = 'button'; button.addEventListener('click', fn); return button; };

  // Previous conversations belong to an open workspace. Discovery reads metadata only; merging always requires review.
  const dialog = $('import-dialog');
  const imports = { projectId: null, filter: 'all', scope: 'workspace', sessions: [], cursors: {}, selected: new Map(), files: new Map(), loading: false, busy: false, request: 0 };
  const discoveries = new Map(), dismissingDiscovery = new Set();
  let setupReady = false;
  const sessionKey = session => `${session.provider}:${session.id}`;
  const sourceName = provider => provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude Code' : provider === 'file' ? 'Conversation file' : 'Codex';
  const isFile = entry => entry.session.provider === 'file';
  const baseName = folder => String(folder || '').split(/[\\/]/).filter(Boolean).pop() || folder;
  const homePath = folder => String(folder || '').replace(/^\/(?:Users|home)\/[^/]+/, '~');
  const agentIcon = provider => { const icon = el('i', undefined, 'agent-icon ' + provider); icon.setAttribute('aria-hidden', 'true'); return icon; };
  const importBlocked = state => !state.projectId || !state.ready || Boolean(state.pending || state.projectSaving || state.conversation?.status === 'running');
  function previousConversations() {
    const state = api.getState(), notice = $('previous-chats-notice'), project = state.projects.find(project => project.id === state.projectId);
    notice.hidden = true;
    if (!setupReady || $('setup-dialog').open || !state.ready || !project || project.previousConversationsDismissed || dismissingDiscovery.has(project.id)) return;
    const providers = ['claude', 'codex', 'gemini'].filter(provider => state.status?.providers?.[provider]?.available !== false && state.accounts?.[provider]?.installed !== false);
    const signature = JSON.stringify([project.folders.map(folder => folder.path).sort(), providers]);
    let entry = discoveries.get(project.id);
    if (entry?.signature !== signature) {
      entry = { signature, loading: true, sessions: [], cursors: {} }; discoveries.set(project.id, entry);
      const pending = entry;
      Promise.all(providers.map(async provider => {
        try {
          const result = await api.api(`/api/import-sources?provider=${provider}&scope=workspace&projectId=${encodeURIComponent(project.id)}`, {}, null);
          pending.sessions.push(...result.sessions); pending.cursors[provider] = result.nextCursor || null;
        } catch { /* Discovery is optional. The workspace action can retry a provider that is unavailable. */ }
      })).then(() => { pending.loading = false; if (discoveries.get(project.id) === pending) previousConversations(); });
    }
    if (entry.loading) return;
    const count = entry.sessions.filter(session => !session.imported).length;
    if (!count) return;
    const more = Object.values(entry.cursors).some(Boolean);
    $('previous-chats-text').textContent = `Found ${more ? 'at least ' : ''}${count} previous conversation${count === 1 ? '' : 's'} for this project.`;
    $('review-previous-chats').disabled = importBlocked(state); $('dismiss-previous-chats').disabled = importBlocked(state);
    notice.hidden = false;
  }
  async function dismissPreviousConversations() {
    const projectId = api.getState().projectId;
    if (!projectId || dismissingDiscovery.has(projectId)) return;
    dismissingDiscovery.add(projectId); previousConversations();
    try { await api.post(`/api/projects/${encodeURIComponent(projectId)}`, { previousConversationsDismissed: true }, null); await api.refreshProjects(); }
    catch (error) { api.showNotice(`Could not save this choice. ${error.message}`); }
    finally { dismissingDiscovery.delete(projectId); previousConversations(); }
  }
  function importError(message = '') { $('import-error').textContent = message; $('import-error').hidden = !message; }
  function mergedMessages(previews) {
    // Same ordering as the server: original time, keeping untimed messages after their predecessor.
    return previews.flatMap((preview, source) => { let time = 0; return preview.messages.map((message, index) => { const at = Date.parse(message.timestamp); if (Number.isFinite(at)) time = at; return { preview, message, time, source, index }; }); }).sort((a, b) => a.time - b.time || a.source - b.source || a.index - b.index);
  }
  function selectedFolders() { return [...new Set([...imports.selected.values()].map(entry => entry.preview?.cwd || entry.session.cwd).filter(Boolean))]; }
  function renderSessions() {
    const query = $('import-search').value.trim().toLowerCase(), list = $('import-list'), groups = new Map();
    const rows = imports.sessions.filter(row => (imports.filter === 'all' || row.provider === imports.filter) && (!query || `${row.title} ${row.folder} ${row.cwd || ''}`.toLowerCase().includes(query))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const row of rows) { const key = row.cwd || row.folder; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    list.replaceChildren();
    for (const sessions of groups.values()) {
      const group = el('section', undefined, 'import-group'), heading = el('div', undefined, 'import-group-heading'), folder = sessions[0].cwd;
      heading.append(el('span', sessions[0].folder, 'import-group-name')); if (folder) { const where = el('span', homePath(folder), 'import-group-path'); where.title = folder; heading.append(where); }
      group.append(heading);
      for (const session of sessions) {
        const selected = imports.selected.has(sessionKey(session)), button = action('', () => toggleSession(session), 'import-session' + (selected ? ' selected' : ''));
        button.setAttribute('role', 'checkbox'); button.setAttribute('aria-checked', String(selected)); button.disabled = imports.busy;
        const preview = imports.selected.get(sessionKey(session))?.preview;
        const text = el('span', undefined, 'import-session-text'); text.append(el('strong', session.title), el('span', `${sourceName(session.provider)} · ${date(session.updatedAt)}${preview ? ` · ${preview.messageCount} messages` : ''}${session.imported ? ' · Previously merged' : ''}`));
        button.append(el('span', undefined, 'import-check'), agentIcon(session.provider), text); group.append(button);
      }
      list.append(group);
    }
    if (!list.children.length) list.append(el('p', imports.loading ? 'Finding conversations…' : query ? 'No matching conversations.' : imports.scope === 'workspace' ? 'No earlier conversations were found for this workspace’s folders. You can start a new conversation here, browse other projects, or open a conversation file.' : 'No Claude Code, Codex or Gemini chats were found on this computer.', 'inspector-empty'));
    $('import-more').hidden = !Object.values(imports.cursors).some(Boolean);
  }
  function renderPreview() {
    const entries = [...imports.selected.values()], pane = $('import-preview');
    if (!entries.length) { const empty = el('div', undefined, 'import-placeholder'); empty.append(el('h3', 'Choose conversations'), el('p', 'Select one or more chats to review them here. Chats from Claude Code, Codex and Gemini merge in the order they happened.')); pane.replaceChildren(empty); return; }
    const ready = entries.filter(entry => entry.preview).map(entry => entry.preview), heading = el('div', undefined, 'import-preview-heading'), sources = el('ul', undefined, 'import-sources');
    heading.append(el('h3', entries.length === 1 ? entries[0].preview?.title || entries[0].session.title : `${entries.length} conversations, merged by time`), el('p', `${ready.reduce((sum, preview) => sum + preview.messageCount, 0)} text message${ready.reduce((sum, preview) => sum + preview.messageCount, 0) === 1 ? '' : 's'}${ready.length < entries.length ? ' · loading…' : ''}`));
    for (const entry of entries) { const item = el('li'); item.append(agentIcon(entry.session.provider), el('span', entry.preview?.title || entry.session.title, 'import-source-title'), el('span', entry.error || (entry.preview ? `${entry.preview.messageCount} message${entry.preview.messageCount === 1 ? '' : 's'}${entry.preview.clipped ? ', most recent only' : ''}` : 'Loading…'), entry.error ? 'import-source-error' : 'import-source-meta')); sources.append(item); }
    heading.append(sources, el('p', 'Only the visible text of each chat is imported. Tool runs and private reasoning stay out, and nothing runs until you send a message with your own Claude, Codex or Gemini account.', 'muted'));
    if (entries.some(isFile)) heading.append(el('p', 'Conversation files come from other people. Their messages become context for your assistant, so import files only from people you trust.', 'import-trust-note'));
    pane.replaceChildren(heading);
    const merged = mergedMessages(ready), shown = merged.slice(-300);
    if (merged.length > shown.length) pane.append(el('p', `Showing the latest ${shown.length} of ${merged.length} messages. All of them will be imported.`, 'import-preview-note'));
    for (const { preview, message } of shown) {
      const row = el('article', undefined, 'import-message'), who = el('div', undefined, 'import-message-heading'), text = message.text.length > 1500 ? message.text.slice(0, 1500) + '…' : message.text;
      const agent = preview.provider === 'file' ? message.provider : preview.provider;
      who.append(agentIcon(message.role === 'user' ? 'user' : agent), el('strong', message.role === 'user' ? (preview.provider === 'file' ? 'User' : 'You') : message.role === 'activity' ? 'Tool activity' : name(agent)), el('span', `${message.timestamp ? date(message.timestamp) : ''}${ready.length > 1 ? ` · ${preview.title}` : ''}`));
      row.append(who, el('p', text)); pane.append(row);
    }
  }
  function renderDestination() {
    const project = api.getState().projects.find(entry => entry.id === imports.projectId), folders = selectedFolders();
    $('import-workspace-name').textContent = project?.name || 'This workspace';
    const adding = folders.filter(folder => !(project?.folders || []).some(entry => folder === entry.path || folder.startsWith(entry.path + '/')));
    $('import-folders').textContent = adding.length ? `Also adds ${adding.map(baseName).join(', ')} to ${project?.name || 'this workspace'}.` : 'The selected messages join this workspace’s conversation in time order.';
  }
  function importControls() {
    const entries = [...imports.selected.values()], ready = entries.length > 0 && entries.every(entry => entry.preview);
    $('confirm-import').disabled = !ready || imports.busy || !$('import-confirm').checked || importBlocked(api.getState()) || api.getState().projectId !== imports.projectId;
    $('confirm-import').textContent = imports.busy ? 'Merging…' : entries.length > 1 ? `Merge ${entries.length} conversations` : entries.length ? 'Merge conversation' : 'Merge selected conversations';
    $('import-confirm').disabled = !ready || imports.busy;
    $('import-confirm-text').textContent = !entries.length ? 'Select conversations to merge.' : `I reviewed ${entries.length === 1 ? 'this conversation' : `these ${entries.length} conversations`}. Merge the selected messages without running an agent.`;
    $('refresh-imports').disabled = imports.busy; $('refresh-imports').setAttribute('aria-busy', String(imports.loading)); $('import-more').disabled = imports.busy || imports.loading;
    $('import-scope').hidden = !api.getState().projectId;
    const providerSelect = $('import-provider-select');
    if (providerSelect && providerSelect.value !== imports.filter) providerSelect.value = imports.filter;
    for (const button of document.querySelectorAll('[data-import-provider]')) button.setAttribute('aria-pressed', String(button.dataset.importProvider === imports.filter));
    for (const button of document.querySelectorAll('[data-import-scope]')) button.setAttribute('aria-pressed', String(button.dataset.importScope === imports.scope));
  }
  function selectionChanged() { $('import-confirm').checked = false; renderSessions(); renderPreview(); renderDestination(); importControls(); }
  async function toggleSession(session) {
    const key = sessionKey(session);
    if (imports.busy) return;
    if (imports.selected.has(key)) { imports.selected.delete(key); selectionChanged(); return; }
    if (imports.selected.size >= 20) { importError('Select at most 20 conversations at a time.'); return; }
    if (imports.files.has(key)) { imports.selected.set(key, imports.files.get(key)); selectionChanged(); return; }
    const entry = { session, preview: null, error: null }; imports.selected.set(key, entry); importError(''); selectionChanged();
    try { entry.preview = await api.post('/api/import-sources/preview', { provider: session.provider, sessionId: session.id }, null); }
    catch (error) { entry.error = error.message; }
    if (imports.selected.get(key) === entry) selectionChanged();
  }
  async function loadSessions(more = false) {
    const request = ++imports.request, projectId = imports.projectId, scope = imports.scope, errors = [];
    if (!more) { imports.sessions = imports.sessions.filter(row => row.provider === 'file'); imports.cursors = {}; }
    imports.loading = true; importError(''); renderSessions(); importControls();
    await Promise.all(['claude', 'codex', 'gemini'].map(async provider => {
      if (more && !imports.cursors[provider]) return;
      const query = `provider=${provider}&scope=${scope}&projectId=${encodeURIComponent(projectId)}${more ? `&cursor=${encodeURIComponent(imports.cursors[provider])}` : ''}`;
      try {
        const result = await api.api(`/api/import-sources?${query}`, {}, null); if (request !== imports.request) return;
        imports.sessions.push(...result.sessions.filter(row => !imports.sessions.some(item => sessionKey(item) === sessionKey(row)))); imports.cursors[provider] = result.nextCursor || null;
      } catch (error) { errors.push(`${sourceName(provider)}: ${error.message}`); imports.cursors[provider] = null; }
    }));
    if (request !== imports.request) return;
    imports.loading = false; importError(errors.join(' ')); renderSessions(); importControls();
  }
  function openImport({ discovered = false } = {}) {
    const state = api.getState();
    if (importBlocked(state)) return;
    imports.projectId = state.projectId;
    imports.scope = 'workspace'; imports.filter = 'all'; imports.selected.clear(); imports.files.clear(); imports.sessions = []; imports.cursors = {};
    const providerSelect = $('import-provider-select');
    if (providerSelect) providerSelect.value = 'all';
    $('import-search').value = ''; $('import-confirm').checked = false; $('import-result').textContent = '';
    if (!dialog.open) dialog.showModal();
    renderPreview(); renderDestination();
    const entry = discovered && discoveries.get(state.projectId);
    if (entry && !entry.loading) { ++imports.request; imports.loading = false; imports.sessions = [...entry.sessions]; imports.cursors = { ...entry.cursors }; importError(''); renderSessions(); importControls(); }
    else loadSessions();
  }
  $('open-import').addEventListener('click', () => openImport());
  $('review-previous-chats').addEventListener('click', () => openImport({ discovered: true }));
  $('dismiss-previous-chats').addEventListener('click', dismissPreviousConversations);
  $('close-import').addEventListener('click', () => { if (!imports.busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (imports.busy) event.preventDefault(); });
  $('import-provider-select')?.addEventListener('change', () => { imports.filter = $('import-provider-select').value; renderSessions(); importControls(); });
  for (const button of document.querySelectorAll('[data-import-provider]')) button.addEventListener('click', () => { imports.filter = button.dataset.importProvider; renderSessions(); importControls(); });
  for (const button of document.querySelectorAll('[data-import-scope]')) button.addEventListener('click', () => { if (imports.scope !== button.dataset.importScope) { imports.scope = button.dataset.importScope; loadSessions(); } });
  $('refresh-imports').addEventListener('click', () => loadSessions()); $('import-more').addEventListener('click', () => loadSessions(true)); $('import-search').addEventListener('input', renderSessions);
  $('import-confirm').addEventListener('change', importControls);
  $('import-file-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files?.[0]; $('import-file').value = ''; if (!file) return;
    importError('');
    try {
      // Saved files are indented, so the 2 MB limit applies to the conversation as the server measures it; only a file far over it is refused unread.
      const limit = 2 * 1024 * 1024;
      if (file.size > 2 * limit) throw new Error('This conversation file is larger than 2 MB.');
      let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('This file is not a Codeshi conversation file.'); }
      if (new Blob([JSON.stringify(data)]).size > limit) throw new Error('This conversation file is larger than 2 MB.');
      const preview = await api.post('/api/import-sources/file-preview', { package: data }, null);
      const session = { id: preview.sessionId, provider: 'file', title: preview.title, folder: 'Conversation files', cwd: null, updatedAt: preview.exportedAt || new Date().toISOString() }, key = sessionKey(session);
      if (!imports.selected.has(key) && imports.selected.size >= 20) throw new Error('Select at most 20 conversations at a time.');
      const entry = { session, preview, package: data, error: null }; imports.files.set(key, entry); imports.selected.set(key, entry);
      if (!imports.sessions.some(row => sessionKey(row) === key)) imports.sessions.push(session);
      selectionChanged();
    } catch (error) { importError(error.message); }
  });
  $('confirm-import').addEventListener('click', async () => {
    if ($('confirm-import').disabled) return;
    const entries = [...imports.selected.values()], target = imports.projectId;
    imports.busy = true; importError(''); renderSessions(); importControls();
    try {
      const result = await api.post('/api/import-sources/import', { projectId: target, sessions: entries.filter(entry => !isFile(entry)).map(({ preview }) => ({ provider: preview.provider, sessionId: preview.sessionId, approvedDigest: preview.digest })), files: entries.filter(isFile).map(entry => ({ package: entry.package, approvedDigest: entry.preview.digest })) }, null);
      const missing = result.missingFolders?.length ? ` ${result.missingFolders.map(baseName).join(', ')} ${result.missingFolders.length === 1 ? 'no longer exists on this computer, so it was' : 'no longer exist on this computer, so they were'} not added as a folder.` : '';
      $('import-result').textContent = (result.duplicate ? `These conversations are already in ${result.projectName}.` : `Merged ${result.imported} messages${result.updated ? ` and updated ${result.updated}` : ''} into ${result.projectName}.`) + missing;
      discoveries.delete(target);
      await api.refreshProjects();
      if (api.getState().projectId === target) await api.refresh();
      imports.selected.clear();
      if (missing) api.showNotice($('import-result').textContent); else dialog.close();
    } catch (error) { importError(error.message); }
    finally { imports.busy = false; renderSessions(); importControls(); }
  });

  // Export: a portable conversation file (and a readable Markdown copy) for another Codeshi user.
  const exportDialog = $('export-dialog');
  let exported = null, exportRequest = 0;
  const fileSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const count = (value, noun) => `${value} message${value === 1 ? '' : 's'} with ${noun}`;
  function exportControls() { const empty = !exported?.stats.messages; $('export-download').disabled = empty; $('export-markdown').disabled = empty; }
  function renderExportSummary() {
    const { stats, findings, redacted } = exported, facts = el('dl', undefined, 'export-facts');
    for (const [label, value] of [['Messages', `${stats.messages}${stats.omitted ? ` (the oldest ${stats.omitted} are left out to stay under 2 MB)` : ''}`], ['Assistants', stats.providers.map(name).join(' and ') || 'None'], ['Period', stats.from && stats.to ? `${date(stats.from)} – ${date(stats.to)}` : 'Not recorded'], ['File size', fileSize(stats.bytes)]]) facts.append(el('dt', label), el('dd', value));
    const sensitive = [findings.secrets && count(findings.secrets, 'possible secrets'), findings.localPaths && count(findings.localPaths, 'local paths')].filter(Boolean);
    $('export-summary').replaceChildren(facts, el('p', !sensitive.length ? 'No secrets or local paths found.' : redacted ? `Cleaned ${sensitive.join(' and ')}.` : `Contains ${sensitive.join(' and ')}. Review before sharing, or turn on removal.`, !sensitive.length || redacted ? 'export-safe' : 'export-warning'));
  }
  async function prepareExport() {
    // The previous summary stays (dimmed) while options change, so the dialog never resizes or jumps.
    const request = ++exportRequest; $('export-error').hidden = true; $('export-download').disabled = true; $('export-markdown').disabled = true;
    if (exported) $('export-summary').setAttribute('aria-busy', 'true'); else $('export-summary').replaceChildren(el('p', 'Preparing export…', 'muted'));
    try {
      const result = await api.api(`/api/conversation/export?range=${encodeURIComponent($('export-range').value)}&redact=${$('export-redact').checked ? 1 : 0}&activity=${$('export-activity').checked ? 1 : 0}`, {}, api.getState().projectId);
      if (request === exportRequest) { exported = result; renderExportSummary(); }
    } catch (error) { if (request === exportRequest) { exported = null; $('export-summary').replaceChildren(); $('export-error').textContent = error.message; $('export-error').hidden = false; } }
    finally { if (request === exportRequest) { $('export-summary').removeAttribute('aria-busy'); exportControls(); } }
  }
  function saveFile(fileName, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
    link.href = url; link.download = fileName; document.body?.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportName() { const state = api.getState(), title = state.projects.find(project => project.id === state.projectId)?.name || 'conversation'; return `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'conversation'}-${new Date().toISOString().slice(0, 10)}`; }
  function markdown(file) {
    const context = file.context || {}, lines = [`# ${file.workspace?.name || 'Conversation'}`, '', `Exported from Codeshi on ${date(file.exportedAt)}.`, ''];
    if (context.goal) lines.push(`**Goal:** ${context.goal}`, '');
    if (context.summary) lines.push('**Summary**', '', context.summary, '');
    for (const [title, items] of [['Decisions', context.decisions], ['Unfinished tasks', context.tasks]]) if (items?.length) lines.push(`**${title}**`, '', ...items.map(item => `- ${item}`), '');
    for (const message of file.messages) lines.push('---', '', `**${message.role === 'user' ? 'User' : message.role === 'activity' ? 'Tool activity' : name(message.provider)}**${message.createdAt ? ` · ${date(message.createdAt)}` : ''}`, '', message.role === 'activity' ? '```\n' + message.text + '\n```' : message.text, '');
    return lines.join('\n');
  }
  // Every export starts from the safe defaults: whole conversation, secrets and local paths removed, no tool output.
  $('open-export').addEventListener('click', () => { exported = null; $('export-range').value = 'all'; $('export-redact').checked = true; $('export-activity').checked = false; if (!exportDialog.open) exportDialog.showModal(); prepareExport(); });
  $('close-export').addEventListener('click', () => exportDialog.close());
  for (const id of ['export-range', 'export-redact', 'export-activity']) $(id).addEventListener('change', prepareExport);
  $('export-download').addEventListener('click', () => { saveFile(`${exportName()}.codeshi.json`, JSON.stringify(exported.package, null, 2), 'application/json'); api.announce?.('Conversation file saved.'); });
  $('export-markdown').addEventListener('click', () => saveFile(`${exportName()}.md`, markdown(exported.package), 'text/markdown'));
  $('export-ask-friend').addEventListener('click', () => { exportDialog.close(); $('ask-friend').click(); });

  let lastProject = null;
  function render() {
    const state = api.getState();
    $('open-import').disabled = importBlocked(state);
    $('open-export').disabled = !state.projectId || !state.conversation?.messages?.length;
    previousConversations();
    if (dialog.open) { if (state.projectId !== imports.projectId && !imports.busy) { ++imports.request; dialog.close(); } else importControls(); }
    if (lastProject !== state.projectId) {
      lastProject = state.projectId;
      if (exportDialog.open) { exportRequest++; exportDialog.close(); }
    }
  }
  window.addEventListener('relay-state', render);
  window.addEventListener('relay-setup-ready', () => { setupReady = true; render(); });
  $('setup-dialog').addEventListener('close', render);
  render();
})();

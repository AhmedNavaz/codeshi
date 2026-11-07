(() => {
  'use strict';
  // The phone's own page. One screen: what's happening, what needs you, and a message box. Anything else opens as a sheet
  // from the bottom. It shares nothing with the desktop page except the server: every request below is one the desktop
  // makes too, so approvals, billing checks and task ownership are decided in the same place.
  const L = window.relayPhoneLogic, $ = id => document.getElementById(id), root = document.documentElement;
  const NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' }, AGENTS = ['codex', 'claude', 'gemini'];
  const TASK_LABEL = { waiting: 'Waiting', running: 'Working', complete: 'Finished', stopped: 'Stopped', failed: 'Did not finish', integrated: 'Merged', kept: 'Kept as a branch', discarded: 'Discarded', cancelled: 'Cancelled', blocked: 'Blocked', lost: 'Copy gone', detached: 'Folder removed' };
  const STOPPED_BECAUSE = { quota: 'Usage limit reached.', authentication: 'Sign-in required.', permission: 'A permission request was declined.', protocol: 'The agent connection stopped.', interrupted: 'Run stopped.' };
  const EFFORT_NAMES = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max', ultra: 'Ultra' };
  const name = provider => NAMES[provider] || 'The agent';
  const MINUTE = 60000;
  const transport = window.relayPhoneTransport;
  const phoneFetch = (path, options) => transport ? transport.fetch(path, options) : fetch(path, options);

  const S = {
    projects: [], projectId: null, thread: null, draft: null, c: null, messages: [], earlier: 0, limit: 40, cursor: null, step: null, view: 0,
    providers: {}, accounts: {}, usage: {}, models: {}, checkedAt: {},
    settings: { provider: 'claude', model: '', effort: null, mode: 'edit', approvalPolicy: 'ask' }, saving: 0, savedChain: Promise.resolve(),
    sending: false, uploading: 0, attachments: new Map(), retry: null, online: true, loaded: false,
  };
  // The speech being listened to. It's up here because moving to a conversation, which happens while the page starts, checks it.
  let listening = null;
  const remember = (key, value) => { try { if (value === null || value === '') localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* A convenience only. */ } };
  const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };

  // ---- Small helpers for building the page. Everything shown is set as text, never as HTML.
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const icon = (id, cls = '') => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); svg.setAttribute('class', `icon ${cls}`.trim()); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', `#i-${id}`); svg.append(use); return svg; };
  const button = (text, handler, cls = '') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  const glyph = provider => { const value = node('i', `glyph ${provider || ''}`); value.setAttribute('aria-hidden', 'true'); return value; };

  // ---- Talking to the computer.
  async function api(path, { body, project = S.projectId } = {}) {
    let url = path;
    if (project) url += `${url.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(project)}`;
    let response;
    try { response = await phoneFetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) }); }
    catch { setOnline(false); throw new Error(transport?.remote ? 'Can’t reach your computer. Check that it’s awake, online and running Codeshi.' : 'Can’t reach your computer. Check that it’s awake and on the same Wi-Fi.'); }
    if (response.status === 401) { transport?.unpair(); location.replace('/'); throw new Error('Pair this phone again.'); }
    setOnline(true);
    const raw = await response.text(); let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* Reported below by the status. */ }
    if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `The request could not be completed (${response.status}).`), { status: response.status, details: data.details });
    return data;
  }
  const endpoint = action => `/api/conversations/${S.c.id}/${action}`;
  let toastTimer = null;
  function toast(message) {
    const host = $('toast');
    clearTimeout(toastTimer); host.textContent = message || ''; host.hidden = !message;
    if (message) toastTimer = setTimeout(() => { host.hidden = true; }, 7000);
  }
  const attempt = work => Promise.resolve().then(work).catch(error => toast(error.message));

  // ---- What the conversation says.
  const project = () => S.projects.find(item => item.id === S.projectId) || null;
  const tasks = () => S.c?.parallelTasks || [];
  const currentTask = () => S.thread ? S.c?.task || tasks().find(task => task.id === S.thread) || null : null;
  const isRunning = () => !S.draft && (S.c?.status === 'running' || Boolean(S.c?.activeRun));
  const pending = () => S.draft ? [] : S.c?.pendingApprovals || [];
  const otherRunning = () => { const running = project()?.runningConversationId; return Boolean(!S.thread && !S.draft && running && running !== 'parallel-task' && S.c?.id && running !== S.c.id); };
  const routing = () => S.c?.routing || null;
  const canMerge = task => task?.hasWorktree && ['complete', 'stopped', 'failed'].includes(task.status);
  const viewKey = () => `${S.projectId}:${S.draft ? `draft:${S.draft}` : S.thread || 'main'}`;
  const draftKey = () => `codeshi:phone-draft:${viewKey()}`;
  const attachments = () => S.attachments.get(viewKey()) || [];

  // ---- Agents and models.
  const modelId = row => row.id || row.model || row.value || '';
  const modelName = row => row.displayName || row.name || modelId(row) || 'Default';
  const modelRows = provider => (S.models[provider]?.rows || []).filter(row => row.value !== 'default');
  const effortsOf = row => row?.supportedEffortLevels || row?.supportedReasoningEfforts?.map(level => level.reasoningEffort) || [];
  const chosenRow = () => modelRows(S.settings.provider).find(row => modelId(row) === S.settings.model);
  const available = provider => Boolean(S.providers[provider]?.available);
  const signedOut = provider => S.accounts[provider]?.authenticated === false;
  const charged = provider => { const account = S.accounts[provider]; return Boolean(account) && account.billingSource !== 'subscription'; };
  const usedPercent = provider => {
    const result = S.usage[provider]; if (!result?.available || S.accounts[provider]?.authenticated !== true) return null;
    const rows = (result.windows || []).filter(row => Number.isFinite(row.usedPercent) && !row.disabled && !row.scope && !row.scopes);
    return rows.length ? Math.max(...rows.map(row => row.usedPercent)) : null;
  };
  async function loadModels(provider, force = false) {
    const known = S.models[provider], forProject = S.projectId;
    if (!forProject || known?.loading || (!force && known?.project === forProject && Date.now() - known.at < MINUTE)) return;
    S.models[provider] = { ...known, loading: true };
    try { const data = await api(`/api/providers/${provider}/models`); S.models[provider] = { rows: data.models || [], at: Date.now(), project: forProject }; }
    catch { S.models[provider] = { rows: known?.rows || [], at: 0, project: forProject, failed: true }; }
    render();
  }
  // Each account check runs the agent's CLI on the computer, so it's at most once a minute, as on the desktop.
  async function loadAccounts() {
    await Promise.all(AGENTS.filter(available).map(async provider => {
      if (Date.now() - (S.checkedAt[provider] || 0) < MINUTE) return;
      S.checkedAt[provider] = Date.now();
      try { S.accounts[provider] = await api(`/api/providers/${provider}/account`, { project: null }); } catch { /* Sending still checks the connection. */ }
      if (S.accounts[provider]?.authenticated === true) { try { S.usage[provider] = await api(`/api/providers/${provider}/usage`, { project: null }); } catch { /* Usage is optional. */ } }
    }));
    render();
  }
  // Under Routing, Codeshi picks the agent for each message with the same rules as the desktop.
  function routeFor(text, count = 0) {
    const auto = routing(); if (!auto || !window.relayRouting) return null;
    const folders = project()?.folders?.length || 1;
    const candidates = AGENTS.map(provider => ({ provider, eligible: available(provider) && !signedOut(provider) && !(provider === 'gemini' && (S.settings.mode === 'read' || folders > 1)) && (!S.c?.taskPolicy?.allowedProviders || S.c.taskPolicy.allowedProviders.includes(provider)), billingSource: S.accounts[provider]?.billingSource || 'unknown', usedPercent: usedPercent(provider), models: modelRows(provider) }));
    return window.relayRouting.route({ text, attachments: count, mode: auto.mode, allowApi: auto.allowApi === true, candidates, current: S.c?.lastRun?.provider || S.settings.provider });
  }

  // ---- Keeping the page in step with the computer.
  let refreshing = false, again = false, conversationTimer = null, projectsTimer = null, projectsRefreshing = false, projectsUpdatedAt = 0;
  function adoptSettings() {
    const c = S.c; if (!c?.id || S.saving || S.draft) return;
    S.settings = { provider: c.provider || S.settings.provider, model: c.model || '', effort: c.effort ?? c.efforts?.[c.provider]?.[c.model || 'default'] ?? null, mode: c.mode || 'edit', approvalPolicy: c.approvalPolicy || 'ask' };
  }
  async function refreshConversation() {
    if (!S.projectId) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    const view = S.view, query = new URLSearchParams({ tail: String(S.limit) });
    if (S.thread) query.set('task', S.thread);
    if (Number.isSafeInteger(S.cursor)) query.set('since', String(S.cursor));
    try {
      const update = await api(`/api/conversation?${query}`);
      if (view !== S.view) return;
      if (transport?.remote && S.loaded && (S.c?.status !== update.status || S.c?.pendingApprovals?.length !== update.pendingApprovals?.length)) scheduleProjects();
      S.messages = L.mergeMessages(S.messages, update);
      if (!update.delta) S.earlier = update.earlier || 0;
      S.step = update.step || (update.delta ? S.step : null);
      S.cursor = Number.isSafeInteger(update.cursor) ? update.cursor : null;
      S.c = update; S.loaded = true;
      adoptSettings();
      render();
    } catch (error) {
      // A task that's gone: back to the main conversation. Anything else keeps what's on screen, and the header says so.
      if (error.status >= 400 && error.status < 500 && S.thread) { S.thread = null; rememberView(); changedView(); refreshConversation(); }
    } finally {
      refreshing = false;
      if (again) { again = false; refreshConversation(); }
    }
  }
  async function refreshProjects() {
    if (projectsRefreshing) return;
    projectsRefreshing = true;
    try {
      S.projects = await api('/api/projects', { project: null });
      projectsUpdatedAt = Date.now();
      if (!S.projectId || !S.projects.some(item => item.id === S.projectId)) {
        const saved = recall('codeshi:phone-project'), next = S.projects.find(item => item.id === saved) || S.projects[0];
        if (next) await selectProject(next.id, recall(`codeshi:phone-thread:${next.id}`) || null); else { S.projectId = null; S.c = null; S.loaded = true; }
      }
      render();
    } catch { /* The header shows the connection. */ }
    finally { projectsRefreshing = false; }
  }
  async function loadStatus() {
    const forProject = S.projectId; if (!forProject) return;
    try { const status = await api('/api/status'); if (forProject === S.projectId) { S.providers = status.providers || {}; render(); loadAccounts(); AGENTS.filter(available).forEach(provider => loadModels(provider)); } }
    catch { /* Shown when something is sent. */ }
  }
  const soon = (timer, work, ms = 150) => timer || setTimeout(work, ms);
  const scheduleConversation = () => { if (!document.hidden) conversationTimer = soon(conversationTimer, () => { conversationTimer = null; if (!document.hidden) refreshConversation(); }); };
  const scheduleProjects = () => { if (!document.hidden) projectsTimer = soon(projectsTimer, () => { projectsTimer = null; if (!document.hidden) refreshProjects(); }, 400); };
  function rememberView() {
    remember('codeshi:phone-project', S.projectId);
    if (S.projectId) remember(`codeshi:phone-thread:${S.projectId}`, S.thread);
  }
  // Moving to another conversation starts from nothing, so an answer still on its way can't land in the wrong one.
  function changedView({ keepComposer = false } = {}) {
    stopListening();
    S.view++; S.cursor = null; S.messages = []; S.step = null; S.earlier = 0; S.limit = 40; S.retry = null; S.loaded = false;
    clearFeed(); dockSignature = null; pinned = true;
    if (!keepComposer) { $('input').value = recall(draftKey()) || ''; sizeInput(); }
    render();
  }
  async function selectProject(id, thread = null) {
    S.projectId = id; S.thread = thread; S.draft = null; S.c = null;
    rememberView(); changedView();
    await Promise.all([refreshConversation(), loadStatus()]);
  }
  async function selectThread(thread) {
    S.thread = thread; S.draft = null;
    rememberView(); changedView();
    await refreshConversation();
  }
  function openDraft(folderId) {
    S.draft = folderId; S.thread = null; plan = '';
    changedView();
    refreshConversation();
    loadPlan();
  }

  // ---- The connection. Phones suspend pages, so coming back always reconnects instead of trusting the old stream.
  let events = null, hiddenAt = 0, retryTimer = null;
  function setOnline(online) {
    if (S.online === online) return;
    S.online = online; $('offline').hidden = online;
    if (!online) { clearTimeout(retryTimer); retryTimer = setTimeout(checkConnection, 3000); }
  }
  async function checkConnection() {
    clearTimeout(retryTimer);
    if (document.hidden) return;
    try {
      const response = await phoneFetch('/phone/session');
      if (response.status === 401) { transport?.unpair(); location.replace('/'); return; }
      if (!response.ok) throw new Error();
      setOnline(true);
      if (events?.readyState !== 1) connect();
      refreshProjects(); refreshConversation();
    } catch {
      setOnline(false);
      if (!document.hidden) retryTimer = setTimeout(checkConnection, 3000);
    }
  }
  function connect() {
    events?.close();
    events = transport ? transport.events() : new EventSource('/api/events');
    events.addEventListener('ready', () => { setOnline(true); scheduleProjects(); scheduleConversation(); });
    events.addEventListener('update', event => { let update; try { update = JSON.parse(event.data); } catch { return; } if (!update.projectId || update.projectId === S.projectId) scheduleConversation(); if (!transport?.remote) scheduleProjects(); });
    events.addEventListener('projects', scheduleProjects);
    events.addEventListener('alert', event => { try { playAlert(JSON.parse(event.data)); } catch { /* A malformed alert plays nothing. */ } });
    events.addEventListener('error', () => { if (!document.hidden) checkConnection(); });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now(); clearTimeout(conversationTimer); clearTimeout(projectsTimer); clearTimeout(retryTimer);
      conversationTimer = projectsTimer = null; return;
    }
    if (Date.now() - hiddenAt > 3000) connect();
    checkConnection();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) { connect(); checkConnection(); } });
  window.addEventListener('online', checkConnection);
  setInterval(() => { if (!document.hidden) { if (!transport?.remote || Date.now() - projectsUpdatedAt >= MINUTE) scheduleProjects(); scheduleConversation(); } }, 15000);

  // ---- A sound while the page is open, for the moments chosen in Settings on the computer. Phones allow sound only after
  // a first tap on the page, and iPhones don't vibrate from a web page.
  const TONES = { attention: ['triangle', [[880, 0, .16], [880, .15, .16], [1174.66, .3, .5]]], finished: ['sine', [[659.25, 0, .45], [987.77, .12, .65]]], stopped: ['sine', [[493.88, 0, .35], [369.99, .17, .6]]] };
  let audio = null;
  document.addEventListener('pointerdown', () => { const Context = window.AudioContext || window.webkitAudioContext; if (!audio && Context) { try { audio = new Context(); } catch { /* No sound, then. */ } } if (audio?.state === 'suspended') audio.resume().catch(() => {}); }, { passive: true });
  function playAlert({ sound, volume = 70 }) {
    navigator.vibrate?.(sound === 'attention' ? [80, 60, 80] : 60);
    const tone = TONES[sound]; if (!tone || !audio || audio.state !== 'running' || !(volume > 0)) return;
    const master = audio.createGain(); master.gain.value = Math.min(1, volume / 100) * .3; master.connect(audio.destination);
    for (const [frequency, offset, length] of tone[1]) {
      const oscillator = audio.createOscillator(), gain = audio.createGain(), at = audio.currentTime + .02 + offset;
      oscillator.type = tone[0]; oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(1, at + .012); gain.gain.exponentialRampToValueAtTime(.0001, at + length);
      oscillator.connect(gain); gain.connect(master); oscillator.start(at); oscillator.stop(at + length + .05);
    }
  }

  // ---- The page follows what's visible above the keyboard, so the message box sits right on top of it and nothing is
  // pushed off the screen. Pinch zoom is left alone.
  const viewport = window.visualViewport;
  function fit() {
    if (viewport && Math.abs(viewport.scale - 1) > .01) return;
    const height = viewport ? viewport.height : window.innerHeight, top = viewport ? viewport.offsetTop : 0;
    root.style.setProperty('--app-height', `${Math.round(height)}px`);
    root.style.setProperty('--app-top', `${Math.round(top)}px`);
    root.classList.toggle('keyboard', window.innerHeight - height > 120);
    if (pinned) toBottom();
  }
  viewport?.addEventListener('resize', fit); viewport?.addEventListener('scroll', fit); window.addEventListener('resize', fit);
  document.addEventListener('focusin', event => { if (event.target.matches?.('textarea, input')) setTimeout(() => { window.scrollTo(0, 0); fit(); }, 60); });
  document.addEventListener('focusout', () => setTimeout(fit, 120));

  // ---- The feed.
  const feed = $('feed'), list = $('list'), rows = new Map();
  let pinned = true;
  const toBottom = () => { feed.scrollTop = feed.scrollHeight; };
  feed.addEventListener('scroll', () => { pinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48; $('latest').hidden = pinned; }, { passive: true });
  $('latest').addEventListener('click', () => { pinned = true; feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }); $('latest').hidden = true; });
  function clearFeed() { list.replaceChildren(); rows.clear(); }

  function addSpans(host, text) {
    for (const span of L.spans(text)) {
      if (span.type === 'text') host.append(span.text);
      else if (span.type === 'code') host.append(node('code', 'inline', span.text));
      else if (span.type === 'bold') host.append(node('strong', '', span.text));
      else if (span.type === 'italic') host.append(node('em', '', span.text));
      else { const link = node('a', '', span.text); link.href = span.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; host.append(link); }
    }
    return host;
  }
  function markdown(text) {
    const host = node('div', 'md');
    for (const block of L.blocks(text)) {
      if (block.type === 'paragraph') host.append(addSpans(node('p'), block.text));
      else if (block.type === 'heading') host.append(addSpans(node(block.level === 1 ? 'h3' : 'h4'), block.text));
      else if (block.type === 'code') { const pre = node('pre'); pre.append(node('code', '', block.text)); host.append(pre); }
      else if (block.type === 'quote') host.append(addSpans(node('blockquote'), block.text));
      else if (block.type === 'rule') host.append(node('hr'));
      else if (block.type === 'list') { const items = node(block.ordered ? 'ol' : 'ul'); for (const item of block.items) items.append(addSpans(node('li'), item)); host.append(items); }
      else if (block.type === 'table') {
        const wrap = node('div', 'table-scroll'), table = node('table'), head = node('tr'), body = node('tbody'), thead = node('thead');
        for (const cell of block.head) head.append(addSpans(node('th'), cell));
        thead.append(head); table.append(thead);
        for (const row of block.rows) { const line = node('tr'); for (const cell of row) line.append(addSpans(node('td'), cell)); body.append(line); }
        table.append(body); wrap.append(table); host.append(wrap);
      }
    }
    return host;
  }
  // Long notes and prompts fold to a few lines; a tap shows the rest. Only text that's really cut off can be tapped.
  function foldable(element) {
    element.classList.add('fold');
    element.addEventListener('click', event => { if (event.target.closest('a, button')) return; if (element.scrollHeight > element.clientHeight + 1 || element.classList.contains('open')) element.classList.toggle('open'); });
    return element;
  }
  function messageRow(message, showAgent) {
    if (message.role === 'user') {
      const row = node('div', 'm m-user'), bubble = foldable(node('div', 'bubble', message.text));
      row.append(bubble);
      if (message.steer) row.append(node('span', 'm-tag', 'Added to the run'));
      for (const file of message.attachments || []) row.append(node('span', 'm-file', file.name));
      return row;
    }
    if (message.role === 'assistant') {
      const row = node('div', 'm m-agent');
      if (showAgent) { const tag = node('div', 'm-who'); tag.append(glyph(message.provider), name(message.provider)); row.append(tag); }
      row.append(markdown(message.text));
      return row;
    }
    // Stopping is something you did, not something that went wrong.
    if (message.role === 'error' && /^Stopped\b/.test(message.text)) return node('div', 'm m-note', message.text);
    if (message.role === 'error') { const row = node('div', 'm m-error'); row.append(icon('alert'), node('span', '', message.text)); return row; }
    return foldable(node('div', 'm m-note', message.text));
  }
  function renderFeed() {
    const c = S.c, draft = Boolean(S.draft);
    const shown = draft ? [] : S.messages;
    let before = null, cursor = list.firstChild;
    const keep = new Set();
    for (const message of shown) {
      const showAgent = message.role === 'assistant' && message.provider !== before;
      if (message.role === 'assistant') before = message.provider;
      const key = `${message.role}\n${showAgent}\n${message.text}`;
      let row = rows.get(message.id);
      if (!row || row.key !== key) {
        const element = messageRow(message, showAgent);
        if (row) row.element.replaceWith(element);
        if (row && cursor === row.element) cursor = element;
        row = { element, key }; rows.set(message.id, row);
      }
      keep.add(message.id);
      if (row.element === cursor) cursor = cursor.nextSibling; else list.insertBefore(row.element, cursor);
    }
    for (const [id, row] of rows) if (!keep.has(id)) { row.element.remove(); rows.delete(id); }
    $('earlier').hidden = draft || !S.earlier;

    // What ended last, or what a task is waiting for, closes the feed.
    const outcome = $('outcome'), task = currentTask(), last = c?.lastRun;
    let text = '', kind = '';
    if (!draft && !isRunning() && c) {
      const took = last?.startedAt && last?.endedAt ? L.duration(new Date(last.endedAt) - new Date(last.startedAt)) : '';
      if (task && !c.id) { text = task.status === 'waiting' ? `Waiting to start${task.reason ? `. ${task.reason}` : '.'}` : TASK_LABEL[task.status] || ''; kind = 'wait'; }
      else if (canMerge(task)) { text = 'Finished. Review and merge it on your computer.'; kind = 'done'; }
      else if (last?.status === 'complete') { text = took ? `Finished in ${took}` : 'Finished'; kind = 'done'; }
    }
    outcome.hidden = !text; outcome.dataset.kind = kind;
    if (text) { outcome.replaceChildren(...(kind === 'done' ? [icon('check')] : []), node('span', '', text)); }

    const empty = $('empty'), blank = draft || (S.loaded && !shown.length && !S.earlier && Boolean(c?.id));
    const none = !S.projects.length && S.loaded;
    empty.hidden = !none && !blank;
    if (none) drawEmpty('No workspaces yet', 'Add one in Codeshi on your computer.');
    else if (draft) drawDraft();
    else if (blank) drawEmpty(routing() ? 'What should get done?' : `What should ${name(S.settings.provider)} do?`, project()?.name || '');
    if (pinned) toBottom(); else $('latest').hidden = false;
  }
  function drawEmpty(title, detail) {
    const empty = $('empty'), key = `${title}\n${detail}`;
    if (empty.dataset.key === key) return;
    empty.dataset.key = key; empty.replaceChildren(node('h1', '', title), node('p', '', detail));
  }
  let plan = '';
  const draftFolder = () => project()?.folders?.find(folder => folder.id === S.draft);
  const folderName = folder => folder?.displayName || folder?.name || 'this folder';
  function drawDraft() {
    const empty = $('empty'), key = `draft\n${S.draft}\n${plan}`;
    if (empty.dataset.key === key) return;
    empty.dataset.key = key;
    empty.replaceChildren(node('h1', '', 'New task'), node('p', '', `In ${folderName(draftFolder())}, beside the Workspace chat.`), ...(plan ? [node('p', 'empty-plan', plan)] : []), button('Cancel', () => attempt(() => selectThread(null)), 'link'));
  }
  async function loadPlan() {
    if (!S.draft) return;
    const folderId = S.draft, { provider, mode, approvalPolicy } = S.settings;
    try {
      const result = await api('/api/tasks/plan', { body: { folderId, provider, accessMode: mode, approvalPolicy } });
      if (S.draft !== folderId) return;
      plan = [result.reason, result.uncommitted ? `${result.uncommitted} uncommitted change${result.uncommitted === 1 ? ' isn’t' : 's aren’t'} included.` : '', result.full ? `All ${result.limit} task slots are in use, so it starts when one frees up.` : ''].filter(Boolean).join(' ');
    } catch (error) { if (S.draft === folderId) plan = error.message; }
    render();
  }
  $('earlier').addEventListener('click', () => attempt(async () => {
    const before = feed.scrollHeight - feed.scrollTop;
    S.limit += 60; S.cursor = null; pinned = false;
    await refreshConversation();
    feed.scrollTop = feed.scrollHeight - before;
  }));

  // ---- What needs you sits above the message box, one thing at a time, in reach of a thumb.
  let dockSignature = null;
  function card(cls = '') { return node('article', `card ${cls}`.trim()); }
  // A new request can appear right where a thumb is about to tap Send, so its buttons wait a moment before they work.
  function armed(buttons) { buttons.forEach(item => { item.disabled = true; }); setTimeout(() => { buttons.forEach(item => { item.disabled = false; }); }, 500); }
  function approvalCard(item, total) {
    const command = item.command || item.input?.command, target = item.input?.file_path || item.input?.path, files = item.kind?.includes?.('fileChange') || target;
    const article = card('card-need');
    const head = node('header', 'card-head');
    head.append(glyph(item.provider), node('h2', '', `${name(item.provider)} ${command ? 'wants to run a command' : files ? 'wants to change files' : 'needs your permission'}`));
    if (total > 1) head.append(node('span', 'count', `1 of ${total}`));
    article.append(head);
    if (item.title && item.title !== command) article.append(node('p', 'card-text', item.title));
    if (command) article.append(node('pre', 'card-code', command));
    else if (target) article.append(node('p', 'card-code', target));
    else if (!item.title) article.append(node('p', 'card-text', files ? 'Review the requested file changes before continuing.' : `Requested action: ${item.kind || 'tool use'}`));
    if (item.input && !command) { const more = node('details', 'card-more'); more.append(node('summary', '', 'Full request'), node('pre', 'card-code', JSON.stringify(item.input, null, 2))); article.append(more); }
    const answer = (allow, remember = null) => attempt(async () => {
      actions.forEach(choice => { choice.disabled = true; });
      try { await api(endpoint('approval'), { body: { runId: item.runId, approvalId: item.id, allow, ...(remember ? { remember } : {}) } }); }
      catch (error) { actions.forEach(choice => { choice.disabled = false; }); throw error; }
      finally { await refreshConversation(); }
    });
    const deny = button('Deny', () => answer(false), 'big'), allow = button('Approve', () => answer(true), 'big primary'), actions = [deny, allow];
    const row = node('div', 'card-actions'); row.append(deny, allow); article.append(row);
    if (item.scope) {
      const always = button('More ways to allow', () => openSheet('Allow', host => {
        for (const [remember, title, detail] of [['run', 'Allow for this run', 'Until this run ends'], ['workspace', 'Always allow in this workspace', 'You can revoke it in Workspace settings on the computer']]) {
          const option = button('', () => { closeSheet(); answer(true, remember); }, 'choice');
          option.append(node('strong', '', title), node('span', '', `${item.scope.label} · ${detail}`));
          host.append(option);
        }
      }), 'link card-link');
      article.append(always); actions.push(always);
    }
    armed(actions);
    return article;
  }
  // An agent's questions, one at a time. Choosing moves on; the last one sends. Skip lets the agent decide.
  function questionCard(item) {
    const article = card('card-need'), questions = item.questions || [], answers = questions.map(() => ({ picked: new Set(), own: '' }));
    let index = 0, sending = false;
    const head = node('header', 'card-head'), title = node('h2'), count = node('span', 'count'), body = node('div', 'question'), row = node('div', 'card-actions');
    head.append(glyph(item.provider), title, count);
    const values = at => [...answers[at].picked, ...(answers[at].own.trim() ? [answers[at].own.trim()] : [])];
    const ready = () => questions.every((_, at) => values(at).length);
    const skip = button('Skip', () => send(null), 'big'), next = button('Submit', () => { if (ready()) send(questions.map((_, at) => values(at))); else { const missing = questions.findIndex((_, at) => at !== index && !values(at).length); if (missing >= 0) { index = missing; draw(); } } }, 'big primary');
    skip.title = `${name(item.provider)} continues with its own judgement`;
    row.append(skip, next);
    function buttons() { const done = ready(); next.textContent = done ? item.blocking === false ? 'Send answer' : 'Submit' : 'Next'; next.disabled = sending || (!done && !values(index).length); skip.disabled = sending; }
    function draw() {
      const question = questions[index], answer = answers[index];
      title.textContent = question.header || `${name(item.provider)} has a question`;
      count.textContent = questions.length > 1 ? `${index + 1} of ${questions.length}` : '';
      body.replaceChildren(node('p', 'card-text strong', question.question));
      for (const option of question.options || []) {
        const choice = button('', () => {
          if (question.multiple) { if (answer.picked.has(option.label)) answer.picked.delete(option.label); else answer.picked.add(option.label); }
          else { answer.picked = new Set([option.label]); answer.own = ''; }
          // A single choice goes on to the next unanswered question.
          const missing = question.multiple ? -1 : questions.findIndex((_, at) => at !== index && !values(at).length);
          if (missing >= 0) index = missing;
          draw();
        }, 'option');
        choice.setAttribute('aria-pressed', String(answer.picked.has(option.label)));
        const label = node('strong', '', option.label.replace(/\s*\(recommended\)\s*$/i, '') || option.label);
        choice.append(label);
        if (option.recommended) choice.append(node('em', 'tag', 'Recommended'));
        if (option.description) choice.append(node('span', '', option.description));
        body.append(choice);
      }
      if (question.other) {
        const own = node('input', 'own');
        own.type = question.secret ? 'password' : 'text'; own.maxLength = 2000; own.value = answer.own; own.autocomplete = 'off';
        own.placeholder = question.options?.length ? 'Something else…' : 'Your answer'; own.setAttribute('aria-label', question.question);
        own.addEventListener('input', () => { answer.own = own.value; if (!question.multiple && own.value.trim()) { answer.picked.clear(); body.querySelectorAll('.option').forEach(choice => choice.setAttribute('aria-pressed', 'false')); } buttons(); });
        body.append(own);
      }
      if (question.multiple) body.append(node('p', 'card-hint', 'Choose all that apply.'));
      if (item.blocking === false) body.append(node('p', 'card-hint', 'Codex can keep working while you answer. After the run finishes, your answer goes into your draft for you to send.'));
      buttons();
    }
    async function send(result) {
      if (sending) return; sending = true; buttons();
      const view = S.view, key = draftKey();
      try {
        const response = await api(endpoint('answer'), { body: { runId: item.runId, questionId: item.id, ...(result ? { answers: result } : { skip: true }) } });
        if (response.draft) {
          const draft = [view === S.view ? $('input').value.trim() : recall(key), response.draft].filter(Boolean).join('\n\n');
          remember(key, draft);
          if (view === S.view) { stopListening(); $('input').value = draft; sizeInput(); }
          toast('Answer added to your draft. Send it to continue.');
        }
      }
      catch (error) { toast(error.message || 'Your answer could not be sent. Please try again.'); }
      finally { sending = false; buttons(); await refreshConversation(); }
    }
    article.append(head, body, row);
    draw();
    armed([skip]); setTimeout(buttons, 520);
    return article;
  }
  function handoffCard(offer) {
    const article = card(), charges = offer.to.billingSource !== 'subscription', queued = offer.queue;
    const head = node('header', 'card-head'); head.append(glyph(offer.from.provider), node('h2', '', `${name(offer.from.provider)} has used ${Math.round(offer.from.usedPercent)}% of its ${offer.from.window ? `${offer.from.window} ` : ''}limit`));
    article.append(head);
    const model = offer.to.model ? modelName(modelRows(offer.to.provider).find(row => modelId(row) === offer.to.model) || { id: offer.to.model }) : '';
    let detail = `Hand off to ${name(offer.to.provider)}${model ? ` · ${model}` : ''} to continue${offer.task ? ` “${offer.task.replace(/[.!?]+$/, '')}”` : ' this task'}. ${offer.to.mode === 'read' ? 'Read only' : 'Can edit files'}, ${offer.to.approvalPolicy === 'auto' ? 'full auto-approval' : 'asks before changes'}.`;
    if (offer.to.quota === 'unknown') detail += ' It doesn’t report its usage, so it may be near a limit.';
    if (offer.to.quota === 'stale') detail += ' Its usage reading is out of date.';
    if (queued?.count) detail += ` ${queued.count} queued prompt${queued.count === 1 ? ' moves' : 's move'} with it.`;
    if (queued?.stays) detail += ` ${queued.stays} queued prompt${queued.stays === 1 ? ' stays' : 's stay'} with ${name(offer.from.provider)}.`;
    article.append(node('p', 'card-text', detail));
    const tick = text => { const label = node('label', 'tick'), input = node('input'); input.type = 'checkbox'; label.append(input, node('span', '', text)); article.append(label); return input; };
    const billing = charges ? tick(offer.to.billingSource === 'api' ? `Accept charges: ${name(offer.to.provider)} bills your API account.` : `Accept possible charges: ${name(offer.to.provider)}’s billing could not be confirmed.`) : null;
    const queueBilling = queued?.billingRequired ? tick(`Also accept charges for ${queued.count} queued prompt${queued.count === 1 ? '' : 's'}. Without this, ${queued.count === 1 ? 'it stays' : 'they stay'} with ${name(offer.from.provider)}.`) : null;
    const respond = accept => attempt(async () => { try { await api(endpoint('handoff'), { body: { offerId: offer.id, accept, billingConfirmed: accept && billing?.checked === true, queueBillingConfirmed: accept && queueBilling?.checked === true, queueDigest: queued?.digest ?? null } }); } finally { await refreshConversation(); } });
    const go = button('Hand off', () => respond(true), 'big primary'), row = node('div', 'card-actions');
    if (billing) { go.disabled = true; billing.addEventListener('change', () => { go.disabled = !billing.checked; }); }
    row.append(button('Not now', () => respond(false), 'big'), go); article.append(row);
    return article;
  }
  function retryCard(offer) {
    const article = card(), model = offer.model ? modelName(modelRows(offer.provider).find(row => modelId(row) === offer.model) || { id: offer.modelName || offer.model }) : '';
    const choice = [name(offer.provider), model, offer.effort ? `${EFFORT_NAMES[offer.effort] || offer.effort} effort` : ''].filter(Boolean).join(' · ');
    article.append(node('h2', 'card-title', `The tests failed. Retry with ${choice}?`), node('p', 'card-text', `${offer.blocked ? `${offer.blocked}, so routing asked first. ` : ''}${name(offer.provider)} gets the end of the test output and tries once more. ${offer.command} runs again afterwards.`));
    const respond = accept => attempt(async () => { try { await api(endpoint('retry'), { body: { offerId: offer.id, accept } }); } finally { await refreshConversation(); } });
    const row = node('div', 'card-actions'); row.append(button('Not now', () => respond(false), 'big'), button('Retry', () => respond(true), 'big primary')); article.append(row);
    return article;
  }
  // A run that stopped before finishing can carry on, with another agent if this one ran out, or wait for a reset.
  function continueCard() {
    const c = S.c, previous = c.lastRun, provider = S.settings.provider;
    const alternative = AGENTS.find(item => item !== provider && available(item) && !signedOut(item) && !charged(item));
    const target = previous?.errorCategory === 'quota' && previous.provider === provider && alternative ? alternative : provider;
    const line = node('div', 'stopped');
    line.append(node('span', '', STOPPED_BECAUSE[previous?.errorCategory] || 'The previous run did not finish.'));
    if (previous?.errorCategory === 'quota') line.append(button('Wait for a reset', () => attempt(() => waitForReset()), 'small-button'));
    const go = button(target === provider ? 'Continue' : `Continue with ${name(target)}`, () => attempt(() => continueRun(target, go)), 'small-button');
    line.append(go);
    return line;
  }
  function canContinue() {
    const c = S.c; if (!c?.id || S.draft || isRunning() || c.resume || c.limitSwitching || c.lastRun?.purpose === 'review') return false;
    return ['incomplete', 'interrupted'].includes(c.status) || S.messages.at(-1)?.role === 'error';
  }
  async function continueRun(provider, control) {
    if (!await billingAllowed(provider)) return;
    if (control) control.disabled = true;
    const same = provider === S.settings.provider, model = same ? S.settings.model : S.c.models?.[provider] || '', effort = same ? S.settings.effort : S.c.efforts?.[provider]?.[model || 'default'] ?? null;
    try {
      await S.savedChain;
      await api(endpoint('continue'), { body: { provider, mode: S.settings.mode, approvalPolicy: S.settings.approvalPolicy, requestId: L.requestId(crypto), model: model || undefined, effort, billingConfirmed: charged(provider) } });
      pinned = true;
    } catch (error) { if (control) control.disabled = false; throw error; } finally { await refreshConversation(); }
  }
  async function waitForReset() {
    const connected = AGENTS.filter(provider => available(provider) && !signedOut(provider));
    const providers = [...new Set([S.c.lastRun?.provider, S.settings.provider, ...connected])].filter(provider => connected.includes(provider));
    try { await api(endpoint('resume'), { body: { providers, mode: S.settings.mode, approvalPolicy: S.settings.approvalPolicy, billingConfirmed: false } }); }
    finally { await refreshConversation(); }
  }
  function renderDock() {
    const c = S.c, asks = pending(), item = asks[0], offer = !item && isRunning() ? c?.handoffOffer : null, retry = !item && !isRunning() ? c?.retryOffer : null, stopped = !item && !offer && !retry && canContinue();
    const signature = JSON.stringify([S.view, item?.id, asks.length, offer?.id, offer?.queue?.digest, retry?.id, stopped && [c.lastRun?.id, c.lastRun?.errorCategory, S.settings.provider]]);
    // Redrawing would lose an answer being chosen, so the dock only changes when what it shows changes.
    if (signature !== dockSignature) {
      dockSignature = signature;
      const dock = $('dock');
      dock.replaceChildren(...[item && (item.kind === 'question' ? questionCard(item) : approvalCard(item, asks.length)), offer && handoffCard(offer), retry && retryCard(retry), stopped && continueCard()].filter(Boolean));
      if (pinned) requestAnimationFrame(toBottom);
    }
    $('composer').hidden = Boolean(item) || !S.projectId || (Boolean(S.thread) && S.c?.id === null);
  }

  // ---- The live line above the message box.
  let stopArmed = null;
  function renderNow() {
    const running = isRunning(), run = S.c?.activeRun, asks = pending(), now = $('now');
    now.hidden = !running;
    if (running) {
      const step = S.step && (!run?.id || S.step.runId === run.id) ? L.describeStep(S.step.text) : '';
      const waiting = asks.length ? (asks.every(item => item.kind === 'question') ? 'Waiting for your answer' : 'Waiting for your approval') : '';
      now.dataset.state = waiting ? 'need' : 'working';
      const text = waiting || step || `${name(run?.provider)} is working…`;
      if ($('now-text').textContent !== text) $('now-text').textContent = text;
      tick();
    } else disarmStop();
    const queue = S.draft ? [] : S.c?.queue || [], next = $('up-next');
    next.hidden = !queue.length;
    if (queue.length) { next.replaceChildren(icon('list'), node('span', '', `Up next · ${queue.length}${S.c.queuePaused ? ' · Paused' : ''}`), icon('right')); next.dataset.paused = String(Boolean(S.c.queuePaused)); }
    const resume = S.draft ? null : S.c?.resume, switching = S.draft ? null : S.c?.limitSwitching, waiting = $('waiting');
    waiting.hidden = !resume && !switching;
    if (resume) {
      const time = iso => { const date = new Date(iso); return date.toLocaleString(undefined, date.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
      const agents = (resume.providers || []).map(provider => { const status = resume.agents?.[provider]; return name(provider) + (status?.limited === false ? ' (ready)' : status?.resetsAt ? ` (resets ${time(status.resetsAt)})` : ''); }).join(', ');
      $('waiting-text').textContent = `Waiting for a usage reset: ${agents}`;
    } else if (switching) $('waiting-text').textContent = `${name(switching.provider)} reached its usage limit. Finding an agent with room…`;
    $('waiting-cancel').hidden = !resume;
  }
  function tick() {
    const started = S.c?.activeRun?.startedAt, text = started && isRunning() ? L.duration(Date.now() - new Date(started)) : '';
    if ($('now-time').textContent !== text) $('now-time').textContent = text;
  }
  setInterval(() => { if (!document.hidden) tick(); }, 1000);
  function disarmStop() { clearTimeout(stopArmed); stopArmed = null; $('stop').classList.remove('armed'); $('stop-label').textContent = 'Stop'; }
  // Stop sits just above Send, and a slip would end the run, so it asks for a second tap.
  $('stop').addEventListener('click', () => attempt(async () => {
    if (!stopArmed) { $('stop').classList.add('armed'); $('stop-label').textContent = 'Tap to stop'; stopArmed = setTimeout(disarmStop, 3000); return; }
    disarmStop(); $('stop').disabled = true; $('stop-label').textContent = 'Stopping…';
    try { await api(endpoint('stop'), { body: {} }); }
    finally { $('stop').disabled = false; disarmStop(); await refreshConversation(); }
  }));
  $('waiting-cancel').addEventListener('click', () => attempt(async () => { try { await api(endpoint('resume'), { body: { cancel: true } }); } finally { await refreshConversation(); } }));

  // ---- The header, and work elsewhere that needs you.
  function renderHeader() {
    const current = project(), task = currentTask(), asks = pending().length;
    $('where-title').textContent = current?.name || (S.loaded ? 'Codeshi' : 'Connecting…');
    $('where-sub').textContent = S.draft ? `New task · ${folderName(draftFolder())}` : task ? task.title : current ? 'Workspace chat' : '';
    $('orb').dataset.state = asks ? 'need' : isRunning() ? 'working' : ['incomplete', 'interrupted'].includes(S.c?.status) ? 'stopped' : 'idle';
    document.title = `${asks ? 'Needs you · ' : isRunning() ? 'Working · ' : ''}${current?.name || 'Codeshi'}`;
    const elsewhere = $('elsewhere'), target = needsElsewhere();
    elsewhere.hidden = !target;
    if (target) { elsewhere.replaceChildren(icon('alert'), node('span', '', target.text), icon('right')); elsewhereGo = target.go; }
  }
  let elsewhereGo = null;
  $('elsewhere').addEventListener('click', () => attempt(() => elsewhereGo?.()));
  function needsElsewhere() {
    const current = project(); if (!current) return null;
    const task = tasks().find(item => item.approvals && item.id !== S.thread);
    if (task) return { text: `“${task.title}” needs you`, go: () => selectThread(task.id) };
    if (S.thread || S.draft) {
      const inTasks = tasks().reduce((sum, item) => sum + (item.approvals || 0), 0);
      if ((current.pendingApprovals || 0) > inTasks) return { text: 'Workspace chat needs you', go: () => selectThread(null) };
    }
    const other = S.projects.find(item => item.id !== S.projectId && item.pendingApprovals);
    if (other) return { text: `${other.name} needs you`, go: () => selectProject(other.id, recall(`codeshi:phone-thread:${other.id}`) || null) };
    return null;
  }

  // ---- The message box.
  const input = $('input');
  function sizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    input.classList.toggle('scrolls', input.scrollHeight > 132);
  }
  input.addEventListener('input', () => { stopListening(); sizeInput(); remember(draftKey(), input.value); renderComposer(); });
  function hasContent() { return Boolean(input.value.trim() || attachments().length); }
  function runSummary() {
    const { provider, mode, approvalPolicy } = S.settings, auto = routing();
    const parts = [];
    if (auto) {
      parts.push(`Routing · ${window.relayRouting?.modeNames?.[auto.mode] || 'Auto'}`);
    } else parts.push(S.settings.model ? modelName(chosenRow() || { id: S.settings.model }) : name(provider));
    if (!auto && S.settings.effort) parts.push(EFFORT_NAMES[S.settings.effort] || S.settings.effort);
    parts.push(mode === 'read' ? 'Read only' : approvalPolicy === 'auto' ? 'Full auto' : 'Asks first');
    return parts.join(' · ');
  }
  function sendBlocked() {
    if (routing()) return '';
    const { provider } = S.settings;
    if (S.providers[provider] && !available(provider)) return `${name(provider)} isn’t installed on your computer. Choose another agent.`;
    if (signedOut(provider)) return `Sign in to ${name(provider)} on your computer, or choose another agent.`;
    return '';
  }
  function renderComposer() {
    const running = isRunning(), queueing = running || Boolean(S.c?.resume), blocked = sendBlocked(), other = otherRunning(), canAdd = running && S.c?.canAddToRun === true;
    input.placeholder = blocked ? 'Choose another agent to send' : other ? 'Another run is using this workspace' : S.draft ? 'What should this task do?' : queueing ? 'Queue a follow-up…' : routing() ? 'Message' : `Message ${name(S.settings.provider)}`;
    const send = $('send');
    send.disabled = !hasContent() || S.sending || S.uploading > 0 || Boolean(blocked && !queueing) || other || !S.projectId || !S.c;
    send.setAttribute('aria-label', queueing ? 'Add to the queue' : 'Send');
    $('add-to-run').hidden = !(canAdd && input.value.trim() && !attachments().length);
    $('add-to-run').disabled = S.sending;
    $('mic').disabled = S.sending;
    const summary = runSummary(), { provider, approvalPolicy } = S.settings;
    if ($('run-summary').textContent !== summary) $('run-summary').textContent = summary;
    $('run-glyph').className = `glyph ${routing() ? 'auto' : provider}`;
    $('run-settings').dataset.warn = String(Boolean(blocked) || (!routing() && charged(provider)) || approvalPolicy === 'auto');
    const shown = attachments(), host = $('attached');
    host.hidden = !shown.length;
    const key = shown.map(file => file.id).join();
    if (host.dataset.key !== key) {
      host.dataset.key = key;
      host.replaceChildren(...shown.map(file => {
        const chip = node('span', 'chip');
        if (file.preview) { const image = node('img'); image.src = file.preview; image.alt = ''; chip.append(image); }
        chip.append(node('span', 'chip-name', file.name));
        const remove = button('', () => { S.attachments.set(viewKey(), attachments().filter(item => item.id !== file.id)); renderComposer(); }, 'chip-remove');
        remove.setAttribute('aria-label', `Remove ${file.name}`); remove.append(icon('close')); chip.append(remove);
        return chip;
      }));
    }
  }
  // Charges are the person's own yes for this one message. They're asked here because a phone has no session-wide setting.
  async function billingAllowed(provider) {
    if (!charged(provider)) return true;
    const account = S.accounts[provider];
    return new Promise(resolve => {
      let settled = false;
      const finish = answer => { if (settled) return; settled = true; onSheetClosed = null; closeSheet(); resolve(answer); };
      onSheetClosed = () => { if (!settled) { settled = true; resolve(false); } };
      openSheet('Confirm charges', host => {
        host.append(node('p', 'sheet-text', account.billingSource === 'api' ? `${name(provider)} bills your API account, not a subscription. This message may cost money.` : `${name(provider)}’s billing could not be confirmed. This message may cost money.`));
        const row = node('div', 'card-actions'); row.append(button('Cancel', () => finish(false), 'big'), button('Accept and send', () => finish(true), 'big primary')); host.append(row);
      });
    });
  }
  function clearComposer(draft) {
    S.attachments.delete(viewKey()); S.retry = null;
    if (input.value === draft) { input.value = ''; remember(draftKey(), null); sizeInput(); }
    input.blur();
  }
  async function send() {
    stopListening();
    const files = attachments().map(file => file.id), text = input.value.trim() || (files.length ? 'Please review the attached files.' : '');
    if (!text || S.sending || !S.c) return;
    const running = isRunning(), queueing = running || Boolean(S.c.resume), routed = routeFor(text, files.length);
    if (routed?.error) { toast(routed.error); return; }
    const provider = routed?.provider || S.settings.provider, model = routed ? routed.model : S.settings.model, effort = routed ? routed.effort : S.settings.effort;
    const note = routed ? { mode: routed.mode, reason: routed.reason, tier: routed.tier, escalation: routed.escalation || null } : undefined;
    const { mode, approvalPolicy } = S.settings, draft = input.value;
    S.sending = true; renderComposer();
    try {
      if (!await billingAllowed(provider)) return;
      await S.savedChain;
      const billingConfirmed = charged(provider);
      const key = JSON.stringify([viewKey(), text, provider, model, effort, mode, approvalPolicy, files, queueing]);
      if (S.retry?.key !== key) S.retry = { key, id: L.requestId(crypto) };
      const requestId = S.retry.id;
      if (S.draft) {
        const task = await api('/api/tasks', { body: { text, attachments: files, provider, model: model || null, effort: effort || null, mode, approvalPolicy, routing: note, requestId, billingConfirmed, folderId: S.draft, includeHistory: false, dependsOn: null } });
        clearComposer(draft);
        await selectThread(task.id);
        return;
      }
      if (queueing) await api(endpoint('queue'), { body: { action: 'add', text, provider, model: model || null, effort: effort || null, mode, approvalPolicy, attachments: files, billingConfirmed, ...(note ? { routing: note } : {}) } });
      else await api(endpoint('messages'), { body: { text, attachments: files, provider, mode, approvalPolicy, requestId, model: model || undefined, effort: effort || null, routing: note, billingConfirmed } });
      clearComposer(draft);
      pinned = true;
      await refreshConversation();
    } catch (error) {
      toast(error.message);
      if (error.details?.budget) await refreshConversation();
    } finally { S.sending = false; renderComposer(); }
  }
  $('composer').addEventListener('submit', event => { event.preventDefault(); attempt(send); });
  // Added to the run that's working instead of waiting for it to end.
  $('add-to-run').addEventListener('click', () => attempt(async () => {
    stopListening();
    const text = input.value.trim(), draft = input.value;
    if (!text || S.sending) return;
    S.sending = true; renderComposer();
    try {
      const result = await api(endpoint('steer'), { body: { text } });
      clearComposer(draft); pinned = true;
      toast(result.added ? '' : 'The run was finishing, so this went to the queue.');
      await refreshConversation();
    } finally { S.sending = false; renderComposer(); }
  }));

  // ---- Voice on the phone. The phone's own browser recognises speech, so on an iPhone or Android phone the audio
  // goes to Apple or Google, unlike the computer, where it never leaves the Mac. The first use says so. Words land in
  // the message box as they're recognised; nothing is sent until you press Send. Browsers block the microphone on plain
  // HTTP, so on a same-Wi-Fi connection the button is dimmed and a tap says why, rather than it silently going missing.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('mic');
  const VOICE_FAILED = 'Voice didn’t work in this browser. You can still type, or use the keyboard’s dictation key.';
  const VOICE_NEEDS_HTTPS = 'Browsers only allow the microphone on a secure connection, which Same Wi-Fi isn’t. For voice, pair with Away from home, which works on Wi-Fi too. Or use the keyboard’s dictation key.';
  const voiceBlocked = !window.isSecureContext;
  if (mic) {
    mic.hidden = !voiceBlocked && !Recognition;
    if (voiceBlocked) mic.classList.add('unavailable');
  }
  function showListening(on) {
    mic.classList[on ? 'add' : 'remove']('listening');
    mic.setAttribute('aria-pressed', String(on)); mic.setAttribute('aria-label', on ? 'Stop listening' : 'Speak');
  }
  // Browsers report speech differently: Android Chrome can repeat earlier words in each new result, and Safari can
  // leave out the space between two results.
  function heardText(results) {
    let text = '';
    for (let i = 0; i < results.length; i++) {
      const part = results[i][0].transcript.trim();
      if (!part) continue;
      text = part.toLowerCase().startsWith(text.toLowerCase()) ? part : `${text} ${part}`;
    }
    return text;
  }
  // Ends listening for good, keeping what's in the box as that conversation's draft. Anything the browser would still
  // report is dropped, so sending or moving elsewhere can't bring old words back.
  function stopListening() {
    if (!listening) return;
    const { recognizer, key, closing } = listening; listening = null;
    recognizer.onresult = recognizer.onerror = recognizer.onend = null;
    try { recognizer.abort(); } catch {}
    if (!closing) showListening(false);
    remember(key, input.value); renderComposer();
  }
  // The mic was tapped off or the page was hidden. The browser may still be working out the last words, so they're
  // accepted until it says it has finished.
  function finishListening() {
    if (!listening || listening.closing) return;
    listening.closing = true; showListening(false);
    remember(listening.key, input.value); renderComposer();
    try { listening.recognizer.stop(); } catch { stopListening(); }
  }
  function startListening() {
    if (!Recognition || listening || S.sending) return;
    const recognizer = new Recognition();
    recognizer.continuous = true; recognizer.interimResults = true; recognizer.lang = navigator.language || 'en-US';
    const base = input.value, glue = base && !/\s$/.test(base) ? ' ' : '';
    listening = { recognizer, key: draftKey(), written: base, closing: false };
    recognizer.onresult = event => {
      // Something else changed the box, so it isn't overwritten with what was there before.
      if (input.value !== listening.written) { stopListening(); return; }
      const heard = heardText(event.results);
      input.value = listening.written = heard ? base + glue + heard : base;
      sizeInput(); renderComposer();
    };
    recognizer.onerror = event => {
      const { closing } = listening; stopListening();
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') toast('Allow the microphone for this site in your browser’s settings.');
      else if (!closing && event.error !== 'aborted' && event.error !== 'no-speech') toast(VOICE_FAILED);
    };
    recognizer.onend = () => stopListening();
    try { recognizer.start(); } catch { listening = null; toast(VOICE_FAILED); return; }
    showListening(true);
  }
  function voiceAllowed() {
    if (recall('codeshi:phone-voice') === 'ok') return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = answer => { if (settled) return; settled = true; onSheetClosed = null; closeSheet(); if (answer) remember('codeshi:phone-voice', 'ok'); resolve(answer); };
      onSheetClosed = () => { if (!settled) { settled = true; resolve(false); } };
      openSheet('Voice on this phone', host => {
        host.append(node('p', 'sheet-text', 'Your phone’s browser turns your speech into text, which on an iPhone or Android phone sends the audio to Apple or Google. On the computer, speech never leaves your Mac.'));
        host.append(node('p', 'sheet-text', 'Words appear in the message box as you speak. Nothing is sent until you press Send.'));
        const row = node('div', 'card-actions'); row.append(button('Not now', () => finish(false), 'big'), button('Use voice', () => finish(true), 'big primary')); host.append(row);
      });
    });
  }
  mic?.addEventListener('click', () => attempt(async () => {
    if (voiceBlocked) { toast(VOICE_NEEDS_HTTPS); return; }
    if (listening && !listening.closing) { finishListening(); return; }
    stopListening();
    if (await voiceAllowed()) startListening();
  }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishListening(); });

  // Photos are shrunk here first: a phone's camera easily passes the 5 MB limit for an attachment.
  const readImage = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(`${file.name} isn’t an image this browser can open.`)); image.src = reader.result; };
    reader.readAsDataURL(file);
  });
  async function shrink(file) {
    const image = await readImage(file), scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', .85);
    const thumb = document.createElement('canvas'), small = 72 / Math.max(canvas.width, canvas.height); thumb.width = Math.max(1, Math.round(canvas.width * small)); thumb.height = Math.max(1, Math.round(canvas.height * small));
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return { name: `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, data: url.slice(url.indexOf(',') + 1), preview: thumb.toDataURL('image/jpeg', .7) };
  }
  $('attach').addEventListener('click', () => $('attach-input').click());
  $('attach-input').addEventListener('change', event => attempt(async () => {
    const chosen = [...event.target.files], key = viewKey(); event.target.value = '';
    S.uploading++; renderComposer();
    try {
      for (const file of chosen) {
        const current = S.attachments.get(key) || [];
        if (current.length >= 6) throw new Error('You can attach up to 6 photos per message.');
        const { preview, ...upload } = await shrink(file), meta = await api('/api/attachments', { body: upload });
        if (!current.some(item => item.id === meta.id)) S.attachments.set(key, [...current, { ...meta, preview }]);
        renderComposer();
      }
    } finally { S.uploading--; renderComposer(); }
  }));

  // ---- Sheets. Opening one puts the keyboard away first, and nothing inside takes focus, so it doesn't come back.
  const sheet = $('sheet');
  let sheetView = null, onSheetClosed = null;
  function drawSheet() {
    if (!sheetView) return;
    const body = $('sheet-body'), top = body.scrollTop;
    $('sheet-title').textContent = sheetView.title;
    body.replaceChildren(); sheetView.build(body);
    body.scrollTop = top; sheetView.key = sheetView.keyOf?.();
  }
  function openSheet(title, build, keyOf) {
    document.activeElement?.blur?.();
    sheetView = { title, build, keyOf };
    drawSheet();
    if (closing) { clearTimeout(closing); closing = null; sheet.classList.remove('closing'); }
    if (!sheet.open) sheet.showModal();
    sheet.focus();
  }
  let closing = null;
  function closeSheet() {
    if (!sheet.open || closing) return;
    sheet.classList.add('closing');
    closing = setTimeout(() => { closing = null; sheet.classList.remove('closing'); sheet.style.removeProperty('transform'); sheet.close(); }, 170);
  }
  sheet.addEventListener('close', () => { sheetView = null; const done = onSheetClosed; onSheetClosed = null; done?.(); });
  sheet.addEventListener('click', event => { if (event.target === sheet) closeSheet(); });
  sheet.addEventListener('cancel', event => { event.preventDefault(); closeSheet(); });
  $('sheet-done').addEventListener('click', closeSheet);
  // Pull the sheet down by its top to dismiss it.
  let pull = null;
  $('sheet-head').addEventListener('touchstart', event => { pull = { y: event.touches[0].clientY, moved: 0 }; }, { passive: true });
  $('sheet-head').addEventListener('touchmove', event => { if (!pull) return; pull.moved = Math.max(0, event.touches[0].clientY - pull.y); sheet.style.transform = `translateY(${pull.moved}px)`; }, { passive: true });
  $('sheet-head').addEventListener('touchend', () => { if (!pull) return; const far = pull.moved > 90; pull = null; if (far) closeSheet(); else sheet.style.removeProperty('transform'); });

  // Where you are: every workspace, with the conversations of the open one under it.
  function statusText(item) { return item.pendingApprovals ? `${item.pendingApprovals} waiting` : item.runningConversationId ? 'Working' : ''; }
  function whereSheet(host, chooseFolder = false) {
    if (chooseFolder) {
      host.append(node('p', 'sheet-label', 'New task in'));
      for (const folder of project()?.folders || []) {
        const row = button('', () => { closeSheet(); openDraft(folder.id); }, 'row');
        row.disabled = folder.available === false;
        row.append(node('span', 'row-title', folderName(folder)), ...(folder.available === false ? [node('span', 'row-side', 'Not found')] : []));
        host.append(row);
      }
      return;
    }
    for (const item of S.projects) {
      const open = item.id === S.projectId;
      const row = button('', () => { closeSheet(); if (!open) attempt(() => selectProject(item.id, recall(`codeshi:phone-thread:${item.id}`) || null)); }, `row row-workspace${open ? ' selected' : ''}`);
      const dot = node('span', 'orb'); dot.dataset.state = item.pendingApprovals ? 'need' : item.runningConversationId ? 'working' : 'idle'; dot.setAttribute('aria-hidden', 'true');
      row.append(dot, node('span', 'row-title', item.name));
      const side = statusText(item); if (side) row.append(node('span', `row-side${item.pendingApprovals ? ' need' : ''}`, side));
      host.append(row);
      if (!open) continue;
      const main = button('', () => { closeSheet(); attempt(() => selectThread(null)); }, `row row-sub${!S.thread && !S.draft ? ' current' : ''}`);
      main.append(icon('chat'), node('span', 'row-title', 'Main conversation'));
      host.append(main);
      for (const task of tasks()) {
        const taskRow = button('', () => { closeSheet(); attempt(() => selectThread(task.id)); }, `row row-sub${S.thread === task.id ? ' current' : ''}`);
        const mark = node('span', 'orb small'); mark.dataset.state = task.approvals ? 'need' : task.status === 'running' ? 'working' : ['failed', 'stopped', 'blocked', 'lost'].includes(task.status) ? 'stopped' : task.status === 'complete' ? 'done' : 'idle'; mark.setAttribute('aria-hidden', 'true');
        taskRow.append(mark, node('span', 'row-title', task.title), node('span', `row-side${task.approvals ? ' need' : ''}`, task.approvals ? `${task.approvals} waiting` : TASK_LABEL[task.status] || task.status));
        host.append(taskRow);
      }
      const folders = (project()?.folders || []);
      if (folders.length) {
        const add = button('', () => { if (folders.length === 1) { closeSheet(); openDraft(folders[0].id); } else { sheetView = { title: 'New task', build: body => whereSheet(body, true) }; drawSheet(); } }, 'row row-sub row-add');
        add.append(icon('plus'), node('span', 'row-title', 'New task'));
        host.append(add);
      }
    }
    if (!S.projects.length) host.append(node('p', 'sheet-text', 'Add a workspace in Codeshi on your computer.'));
    const foot = node('div', 'sheet-foot');
    foot.append(segmented('Appearance', [['system', 'System'], ['light', 'Light'], ['graphite', 'Dark']], window.relayPhoneTheme?.choice() || 'system', value => { window.relayPhoneTheme?.choose(value); drawSheet(); }));
    foot.append(node('p', '', 'Work and sign-ins stay on your computer. Review, merging, files and the terminal are there too.'));
    const leave = button('Disconnect this phone', () => attempt(async () => {
      if (!leave.classList.contains('armed')) { leave.classList.add('armed'); leave.textContent = 'Tap again to disconnect'; setTimeout(() => { leave.classList.remove('armed'); leave.textContent = 'Disconnect this phone'; }, 3000); return; }
      try { await phoneFetch('/phone/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: '{}' }); } finally { location.replace('/'); }
    }), 'link danger');
    foot.append(leave); host.append(foot);
  }
  $('where').addEventListener('click', () => {
    openSheet('Workspaces', whereSheet, () => JSON.stringify([S.projects.map(item => [item.id, item.name, item.pendingApprovals, item.runningConversationId]), tasks().map(task => [task.id, task.title, task.status, task.approvals]), S.thread, S.draft]));
    scheduleProjects();
    loadStatus();
  });

  // How the next message runs: agent, model, effort, access.
  function changeSettings(patch) {
    const next = { ...S.settings, ...patch };
    if (patch.provider && patch.provider !== S.settings.provider) { next.model = S.c?.models?.[patch.provider] || ''; next.effort = S.c?.efforts?.[patch.provider]?.[next.model || 'default'] ?? null; }
    else if (patch.model !== undefined && patch.effort === undefined) next.effort = S.c?.efforts?.[next.provider]?.[next.model || 'default'] ?? null;
    if (next.mode === 'read') next.approvalPolicy = 'ask';
    S.settings = next; render(); drawSheet();
    if (S.draft) { loadPlan(); return; }
    if (!S.c?.id) return;
    const body = { provider: next.provider, mode: next.mode, approvalPolicy: next.approvalPolicy, model: next.model || null, effort: next.effort };
    S.saving++;
    S.savedChain = S.savedChain.catch(() => {}).then(() => api(endpoint('provider'), { body })).catch(error => toast(`Could not save this. ${error.message}`)).finally(() => { S.saving--; if (!S.saving) refreshConversation(); });
  }
  function setRouting(mode) {
    const auto = routing();
    return attempt(async () => {
      await api(endpoint('routing'), { body: mode ? { mode, allowApi: auto?.allowApi === true, check: auto?.check === true } : { mode: null } });
      await refreshConversation(); drawSheet();
    });
  }
  function segmented(label, options, value, onChange, disabled = false) {
    // Up to four share the width. More scroll sideways, so no label gets squeezed.
    const group = node('div', 'field'), labelled = node('p', 'sheet-label', label), choices = node('div', `segments${options.length > 4 ? ' scroll' : ''}`);
    choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', label);
    for (const [choice, text] of options) {
      const item = button(text, () => { if (choice !== value) onChange(choice); }, 'segment');
      item.setAttribute('aria-pressed', String(choice === value)); item.disabled = disabled; choices.append(item);
      if (choice === value && options.length > 4) requestAnimationFrame(() => { choices.scrollLeft = item.offsetLeft - choices.offsetLeft - 40; });
    }
    group.append(labelled, choices);
    return group;
  }
  let showAllModels = false;
  function runSheet(host) {
    const locked = isRunning(), auto = routing(), { provider, model, effort, mode, approvalPolicy } = S.settings;
    if (locked) host.append(node('p', 'sheet-note', 'Locked while this run is working. Stop it to change these.'));
    const access = () => {
      host.append(segmented('Access', [['read', 'Read only'], ['ask', 'Asks first'], ['auto', 'Full auto']], mode === 'read' ? 'read' : approvalPolicy, value => changeSettings(value === 'read' ? { mode: 'read', approvalPolicy: 'ask' } : { mode: 'edit', approvalPolicy: value }), locked));
      if (mode !== 'read' && approvalPolicy === 'auto') host.append(node('p', 'sheet-note warn', 'The agent acts without asking, so requests won’t come to this phone.'));
    };
    // Routing is set up on the computer. Here it shows only while it's on, and can be changed or turned off.
    if (auto) host.append(segmented('Routing picks the agent', [['saving', 'Saving'], ['balanced', 'Balanced'], ['quality', 'Quality'], ['manual', 'Off']], auto.mode, value => setRouting(value === 'manual' ? null : value), locked));
    if (!auto) {
      const agents = node('div', 'field agents');
      agents.append(node('p', 'sheet-label', 'Agent'));
      const tabs = node('div', 'segments');
      for (const item of AGENTS.filter(available)) {
        const used = usedPercent(item), tab = button('', () => { if (item !== provider) { showAllModels = false; changeSettings({ provider: item }); loadModels(item); } }, 'segment agent');
        tab.setAttribute('aria-pressed', String(item === provider)); tab.disabled = locked;
        tab.append(glyph(item), node('span', '', name(item)));
        if (signedOut(item)) tab.append(node('small', 'warn', 'Sign in'));
        else if (charged(item)) tab.append(node('small', 'warn', 'API billing'));
        else if (Number.isFinite(used)) tab.append(node('small', used >= 80 ? 'warn' : '', `${Math.round(used)}% used`));
        tabs.append(tab);
      }
      agents.append(tabs); host.append(agents);
      if (!AGENTS.some(available)) host.append(node('p', 'sheet-text', 'No agents are connected yet. Connect one in Codeshi on your computer.'));
      access();

      const models = node('div', 'field'); models.append(node('p', 'sheet-label', 'Model'));
      const all = [{ id: '', displayName: `Let ${name(provider)} choose` }, ...modelRows(provider)];
      if (model && !all.some(row => modelId(row) === model)) all.push({ id: model, displayName: model });
      const visible = showAllModels ? all : all.filter((row, index) => index < 3 || modelId(row) === model);
      for (const row of visible) {
        const selected = modelId(row) === (model || ''), choice = button('', () => { if (!selected) changeSettings({ model: modelId(row) }); }, 'row row-model');
        choice.setAttribute('aria-pressed', String(selected)); choice.disabled = locked;
        choice.append(node('span', 'row-title', modelName(row)));
        if (selected) choice.append(icon('check'));
        models.append(choice);
      }
      if (visible.length < all.length) models.append(button(`More models (${all.length - visible.length})`, () => { showAllModels = true; drawSheet(); }, 'link row-more'));
      if (S.models[provider]?.failed) models.append(node('p', 'sheet-note', 'The list of models could not be loaded.'));
      host.append(models);

      // With no model chosen, the levels are those of the agent's default model, as on the desktop.
      const reported = S.models[provider]?.rows || [], levels = effortsOf(reported.find(row => [row.id, row.model, row.value, row.resolvedModel].includes(model)) || (!model && reported.find(row => row.isDefault || row.value === 'default')));
      if (levels.length) host.append(segmented('Effort', [['', 'Default'], ...levels.map(level => [level, EFFORT_NAMES[level] || level])], effort || '', value => changeSettings({ effort: value || null }), locked));
    } else access();
    if (!auto && charged(provider)) host.append(node('p', 'sheet-note warn', `${name(provider)} ${S.accounts[provider].billingSource === 'api' ? 'bills your API account' : 'could not confirm its billing'}. You’ll be asked before each message.`));
  }
  $('run-settings').addEventListener('click', () => {
    showAllModels = false;
    openSheet('How it runs', runSheet, () => JSON.stringify([S.settings, S.models[S.settings.provider]?.rows?.length, routing(), isRunning(), Object.values(S.providers).map(item => item?.available), S.accounts, S.usage]));
    loadStatus(); loadModels(S.settings.provider);
  });

  // What's queued to run next.
  function queueSheet(host) {
    const queue = S.c?.queue || [], paused = S.c?.queuePaused;
    if (paused) {
      const note = node('div', 'sheet-note warn');
      note.append(node('span', '', paused.reason || 'The queue is paused.'), button('Resume', () => attempt(async () => { await api(endpoint('queue'), { body: { action: 'resume' } }); await refreshConversation(); drawSheet(); }), 'link'));
      host.append(note);
    }
    if (!queue.length) { host.append(node('p', 'sheet-text', 'Nothing is queued.')); return; }
    queue.forEach((item, index) => {
      const row = node('div', 'queue-row'), text = node('div', 'queue-text');
      text.append(node('p', '', item.text), node('small', '', [name(item.provider), item.mode === 'read' ? 'Read only' : item.approvalPolicy === 'auto' ? 'Full auto' : 'Asks first'].join(' · ')));
      row.append(text);
      if (index) { const top = button('', () => attempt(async () => { await api(endpoint('queue'), { body: { action: 'move', id: item.id, index: 0 } }); await refreshConversation(); drawSheet(); }), 'round ghost small'); top.setAttribute('aria-label', 'Move to the top of the queue'); top.append(icon('send')); row.append(top); }
      const remove = button('', () => attempt(async () => { await api(endpoint('queue'), { body: { action: 'remove', id: item.id } }); await refreshConversation(); if (!(S.c?.queue || []).length) closeSheet(); else drawSheet(); }), 'round ghost small');
      remove.setAttribute('aria-label', `Remove from the queue: ${item.text.slice(0, 60)}`); remove.append(icon('close')); row.append(remove);
      host.append(row);
    });
  }
  $('up-next').addEventListener('click', () => openSheet('Up next', queueSheet, () => JSON.stringify([S.c?.queue?.map(item => item.id), S.c?.queuePaused])));

  // ---- Drawing.
  function render() {
    renderHeader(); renderDock(); renderNow(); renderComposer(); renderFeed();
    if (sheetView?.keyOf && sheetView.keyOf() !== sheetView.key) drawSheet();
  }

  // ---- Starting up.
  fit();
  render();
  connect();
  refreshProjects().then(() => loadStatus());
})();

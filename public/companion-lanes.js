(() => {
  'use strict';
  // Companion lanes (#203): one or two other workspaces pinned beside the one you work in, so you can steer them without
  // leaving it. A lane shows only what steering needs: the workspace's state and agent, its branch, the latest turn and
  // what the agent is doing now, its approvals and questions, anything else waiting for you, and a message box. Files,
  // Git, the terminal, the Plan and review stay in the main view: Expand swaps the lane's workspace into it, and the one
  // you were in takes the lane's place. Pop out opens it in a window of its own.
  //
  // Lanes are pinned by hand only. They sit right of the chat in Normal and Flow. In the Plan, which needs the width, and
  // whenever the window is too narrow to keep the chat readable, a lane shrinks to a slim strip with its name and state,
  // which opens the lane over the page. Pins belong to the window, and are kept in this browser only.
  const api = window.relayUI, logic = window.relayPhoneLogic;
  const shell = document.getElementById('app-shell'), panel = document.querySelector('.main-panel');
  if (!api || !shell || !panel) return;

  const MAX = 2, STRIP = 44, MIN_CHAT = 520, TAIL = 6, POLL = 15000, GIT_EVERY = 60000;
  const AGENT = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity' };
  const desktop = window.relayDesktop;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const iconButton = (cls, label, handler) => {
    const value = node('button', `lane-tool ${cls}`); value.type = 'button';
    value.setAttribute('aria-label', label); value.title = label;
    value.append(node('span', 'lane-tool-icon')); value.addEventListener('click', handler);
    return value;
  };
  const state = () => api.getState();
  const project = id => state().projects?.find(item => item.id === id) || null;
  const nameOf = id => project(id)?.name || 'Workspace';
  const agentName = provider => AGENT[provider] || (provider ? String(provider) : 'Agent');
  const ago = value => {
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ${minutes % 60 ? `${minutes % 60}m` : ''}`.trim() : `${Math.floor(hours / 24)}d`;
  };

  // ---- Pins, per window. A workspace window keeps its own pins apart from the main window's.
  const scope = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('workspace');
  const KEY = `codeshi:lanes:${scope ? `window:${scope}` : 'main'}`;
  let pins = [];
  try { const saved = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(saved)) pins = saved.filter(id => typeof id === 'string').slice(0, MAX); } catch { pins = []; }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(pins)); } catch { /* Pins are a convenience. */ }
    try { desktop?.setLanes?.(pins); } catch { /* The desktop app routes notifications to the main view then. */ }
  }
  const elsewhere = () => state().windowsElsewhere || [];
  const canPin = id => Boolean(id && state().projectId && id !== state().projectId && project(id) && !pins.includes(id) && !elsewhere().includes(id));

  // ---- The lanes on the page.
  const host = node('aside', 'companion-lanes'); host.id = 'companion-lanes'; host.hidden = true;
  host.setAttribute('aria-label', 'Workspaces pinned beside this one');
  const full = node('div', 'lane-columns'), rail = node('div', 'lane-rail');
  rail.setAttribute('role', 'group'); rail.setAttribute('aria-label', 'Pinned workspaces');
  host.append(full, rail);
  const lanes = new Map();
  let overlay = null, needs = { at: 0, items: [], loading: null }, ticker = null;

  function create(id) {
    const lane = { id, c: null, git: null, gitAt: 0, error: null, notice: null, loading: false, again: false, timer: null, sending: false, retry: null, signatures: {}, known: new Set(), wasRunning: false };
    const root = node('section', 'lane'); root.dataset.projectId = id; root.tabIndex = -1;
    const head = node('header', 'lane-head'), dot = node('span', 'lane-dot'), title = node('button', 'lane-name');
    title.type = 'button'; title.title = 'Expand: swap into the main view';
    title.addEventListener('click', () => expand(id));
    const branch = node('span', 'lane-branch'); branch.hidden = true;
    const tools = node('div', 'lane-tools');
    tools.append(iconButton('lane-expand', 'Expand: swap into the main view', () => expand(id)));
    if (desktop?.openWorkspaceWindow) tools.append(iconButton('lane-popout', 'Pop out into its own window', () => popOut(id)));
    tools.append(iconButton('lane-close', 'Unpin', () => unpin(id)));
    dot.setAttribute('aria-hidden', 'true');
    head.append(dot, title, tools);
    const status = node('div', 'lane-status'), agent = node('span', 'lane-agent'), word = node('span', 'lane-state'), queue = node('span', 'lane-queue');
    queue.hidden = true; status.append(agent, word, queue, branch);
    const body = node('div', 'lane-body'), turn = node('div', 'lane-turn'), step = node('p', 'lane-step');
    step.hidden = true; body.append(turn, step);
    const dock = node('div', 'lane-dock'), waiting = node('ul', 'lane-needs'), requests = node('div', 'pending-approvals lane-requests');
    waiting.hidden = true; requests.hidden = true;
    const error = node('p', 'lane-error'); error.hidden = true; error.setAttribute('role', 'alert');
    const form = node('form', 'lane-composer'), input = node('textarea', 'lane-input'), actions = node('div', 'lane-composer-actions');
    input.rows = 1; input.setAttribute('aria-label', `Message ${nameOf(id)}`); input.spellcheck = true;
    const stop = iconButton('lane-stop', 'Stop the agent', () => stopRun(lane)); stop.hidden = true;
    const send = node('button', 'lane-send'); send.type = 'submit'; send.append(node('span', 'lane-tool-icon'));
    actions.append(stop, send); form.append(input, actions);
    dock.append(waiting, requests, error, form);
    root.append(head, status, body, dock);
    // The strip that stands in for the lane in the Plan or a narrow window. It opens the lane over the page.
    const strip = node('button', 'lane-strip'); strip.type = 'button';
    const stripDot = node('span', 'lane-dot'), stripName = node('span', 'lane-strip-name'), badge = node('span', 'lane-strip-badge');
    stripDot.setAttribute('aria-hidden', 'true'); badge.hidden = true;
    strip.append(stripDot, stripName, badge);
    strip.addEventListener('click', () => toggleOverlay(id));
    input.addEventListener('input', () => { size(input); saveDraft(lane); renderComposer(lane); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(lane); }
      if (event.key === 'Escape' && overlay === id) { event.preventDefault(); closeOverlay(true); }
    });
    form.addEventListener('submit', event => { event.preventDefault(); submit(lane); });
    lane.el = { root, head, dot, title, branch, status, agent, word, queue, body, turn, step, waiting, requests, error, form, input, stop, send, strip, stripDot, stripName, badge };
    lanes.set(id, lane);
    return lane;
  }
  function destroy(id) {
    const lane = lanes.get(id); if (!lane) return;
    clearTimeout(lane.timer); lane.el.root.remove(); lane.el.strip.remove(); lanes.delete(id);
    if (overlay === id) overlay = null;
  }
  const size = input => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; };

  // ---- Keeping a lane up to date: the short form of the workspace's chat, as the phone reads it.
  function schedule(lane, delay = 350) {
    if (lane.timer) return;
    lane.timer = setTimeout(() => { lane.timer = null; load(lane); }, delay);
  }
  async function load(lane) {
    if (!lanes.has(lane.id)) return;
    if (lane.loading) { lane.again = true; return; }
    lane.loading = true;
    try { lane.c = await api.api(`/api/conversation?tail=${TAIL}`, {}, lane.id); lane.error = null; }
    catch (error) { lane.error = error.message; }
    finally { lane.loading = false; }
    const running = isRunning(lane.c);
    // The branch and uncommitted changes are read now and then, and when a run ends.
    if (!lane.gitAt || Date.now() - lane.gitAt > GIT_EVERY || (lane.wasRunning && !running)) loadGit(lane);
    lane.wasRunning = running;
    loadNeeds();
    render(lane);
    if (lane.again) { lane.again = false; schedule(lane); }
  }
  async function loadGit(lane) {
    lane.gitAt = Date.now();
    try {
      const data = await api.api('/api/git', {}, lane.id), repos = (data.repositories || []).filter(repo => repo.available);
      const countFiles = repo => window.relayGit?.fileTotal ? window.relayGit.fileTotal(repo) : (repo.changes || []).reduce((sum, file) => sum + (file.files?.length || file.fileCount || 1), 0) + Math.max(0, (repo.totalChanges || 0) - (repo.changes?.length || 0));
      lane.git = repos.length ? { branch: repos[0].branch || '', changes: repos.reduce((sum, repo) => sum + countFiles(repo), 0), folders: repos.length, names: repos.map(repo => `${repo.name || repo.folderName || 'Folder'}: ${repo.branch || '—'}`) } : null;
    } catch { lane.git = null; }
    if (lanes.has(lane.id)) renderHead(lane);
  }
  // Everything waiting for you, for all lanes at once (the same list the recap and the phone show).
  function loadNeeds() {
    if (needs.loading || Date.now() - needs.at < 1500) return;
    needs.loading = api.api('/api/needs-you').then(data => { needs.items = data.items || []; }).catch(() => {}).finally(() => {
      needs.at = Date.now(); needs.loading = null;
      for (const lane of lanes.values()) renderNeeds(lane);
    });
  }
  const isRunning = c => Boolean(c && (c.status === 'running' || c.activeRun));

  // ---- What a lane says.
  // The one word for the workspace's state, which colours the dot: what holds the agent up first.
  function laneState(lane) {
    const c = lane.c, pending = c?.pendingApprovals || [], waitingItems = needsFor(lane.id);
    if (lane.error && !c) return ['unknown', 'Can’t load'];
    if (pending.some(item => item.kind === 'question')) return ['question', 'Has a question'];
    if (pending.length) return ['approval', pending.length === 1 ? 'Needs approval' : `${pending.length} approvals`];
    if (isRunning(c)) return ['working', `Working${c.activeRun?.startedAt ? ` · ${ago(c.activeRun.startedAt)}` : ''}`];
    if (c?.resume) return ['waiting', 'Waiting for a limit'];
    if (waitingItems.some(item => item.kind === 'check' || item.kind === 'retry')) return ['failed', 'Tests failed'];
    if (waitingItems.some(item => ['review', 'card'].includes(item.kind))) return ['review', 'Ready to review'];
    if (waitingItems.some(item => ['approval', 'question'].includes(item.kind))) return ['approval', 'A task needs you'];
    if (waitingItems.length) return ['attention', 'Needs you'];
    const last = c?.lastRun;
    if (last?.status === 'failed') return ['failed', 'Didn’t finish'];
    if (last?.status === 'stopped') return ['idle', 'Stopped'];
    if (last?.endedAt && Date.now() - new Date(last.endedAt).getTime() < 6 * 3600000) return ['done', `Finished ${ago(last.endedAt) === 'just now' ? 'just now' : `${ago(last.endedAt)} ago`}`];
    return ['idle', 'Idle'];
  }
  function agentLabel(c) {
    if (!c) return '';
    const run = c.activeRun;
    if (run) return [agentName(run.provider), run.model].filter(Boolean).join(' · ');
    if (c.routing) return 'Flow picks the agent';
    return [agentName(c.provider), c.model].filter(Boolean).join(' · ');
  }
  // What else waits in this workspace: tasks to review, offers, limits and schedules. The chat's own approvals and
  // questions are answered in the lane, so they aren't repeated here.
  const needsFor = id => needs.items.filter(item => item.projectId === id && !(!item.taskId && ['approval', 'question'].includes(item.kind)));

  function render(lane) {
    renderHead(lane); renderTurn(lane); renderRequests(lane); renderNeeds(lane); renderComposer(lane);
  }
  function renderHead(lane) {
    const { el } = lane, name = nameOf(lane.id), [kind, word] = laneState(lane);
    el.root.dataset.state = kind; el.strip.dataset.state = kind;
    el.root.setAttribute('aria-label', `${name}, pinned beside this workspace. ${word}.`);
    el.title.textContent = name;
    el.agent.textContent = agentLabel(lane.c); el.agent.hidden = !el.agent.textContent;
    el.word.textContent = word;
    const queued = lane.c?.queue?.length || 0;
    el.queue.hidden = !queued; el.queue.textContent = `${queued} queued`;
    if (lane.git?.branch) {
      el.branch.hidden = false;
      el.branch.replaceChildren(node('span', 'lane-branch-icon'), node('span', 'lane-branch-name', lane.git.branch));
      if (lane.git.changes) el.branch.append(node('span', 'lane-branch-changes', `+${lane.git.changes}`));
      el.branch.title = `${lane.git.folders > 1 ? lane.git.names.join('\n') : `Branch ${lane.git.branch}`}${lane.git.changes ? `\n${lane.git.changes} uncommitted change${lane.git.changes === 1 ? '' : 's'}` : ''}`;
    } else el.branch.hidden = true;
    // The strip: the name, read downwards, and how many things wait.
    const count = (lane.c?.pendingApprovals?.length || 0) + needsFor(lane.id).length;
    el.stripName.textContent = name;
    el.badge.hidden = !count; el.badge.textContent = String(count);
    el.strip.title = `${name} · ${word}`;
    el.strip.setAttribute('aria-label', `${name}, ${word}${count ? `, ${count} waiting for you` : ''}. Open the lane.`);
    el.strip.setAttribute('aria-expanded', String(overlay === lane.id));
  }

  // The latest turn: your last message and the reply to it, or what the agent is doing now.
  function renderTurn(lane) {
    const { el } = lane, c = lane.c;
    const messages = (c?.messages || []).filter(message => ['user', 'assistant', 'error'].includes(message.role));
    const lastUser = messages.findLastIndex(message => message.role === 'user' && !message.steer);
    const asked = lastUser >= 0 ? messages[lastUser] : null, replies = messages.slice(lastUser + 1).filter(message => message.role !== 'user');
    const reply = replies.at(-1) || null, running = isRunning(c);
    const stepText = running && c?.step?.text ? logic?.describeStep(c.step.text) || '' : '';
    const signature = JSON.stringify([asked?.id, asked?.text?.length, reply?.id, reply?.text?.length, running, lane.error && !c ? lane.error : null]);
    if (lane.signatures.turn !== signature) {
      lane.signatures.turn = signature;
      const atEnd = el.body.scrollHeight - el.body.scrollTop - el.body.clientHeight < 24;
      el.turn.replaceChildren();
      if (!c) el.turn.append(node('p', 'lane-empty', lane.error ? `Couldn’t load this workspace. ${lane.error}` : 'Loading…'));
      else if (!asked && !reply) el.turn.append(node('p', 'lane-empty', 'No messages yet. Send the first one below.'));
      else {
        if (asked) {
          const prompt = node('div', 'lane-prompt'); prompt.append(node('span', 'lane-prompt-text', asked.text || 'Your message'));
          prompt.title = asked.text || ''; el.turn.append(prompt);
        }
        if (reply) {
          const answer = node('article', `lane-reply${reply.role === 'error' ? ' error' : ''}`), who = node('div', 'lane-reply-head');
          who.append(node('span', 'lane-reply-agent', reply.role === 'error' ? 'Error' : agentName(reply.provider)));
          if (reply.createdAt) who.append(node('span', 'lane-reply-time', ago(reply.createdAt)));
          answer.append(who, markdown(reply.text || ''));
          el.turn.append(answer);
        } else if (running) el.turn.append(node('p', 'lane-empty', 'Working on it…'));
      }
      if (atEnd || lane.signatures.firstTurn !== asked?.id) { el.body.scrollTop = el.body.scrollHeight; lane.signatures.firstTurn = asked?.id; }
    }
    el.step.hidden = !stepText; el.step.textContent = stepText; el.step.title = stepText;
  }
  // A reply's Markdown as plain elements: paragraphs, headings, lists, quotes, code and tables. Nothing runs as HTML.
  function markdown(text) {
    const box = node('div', 'lane-markdown');
    const inline = (parent, value) => {
      for (const part of logic ? logic.spans(value) : [{ type: 'text', text: value }]) {
        if (part.type === 'code') parent.append(node('code', '', part.text));
        else if (part.type === 'bold') parent.append(node('strong', '', part.text));
        else if (part.type === 'italic') parent.append(node('em', '', part.text));
        else if (part.type === 'link') {
          const link = node('a', '', part.text); link.href = part.href; link.rel = 'noopener noreferrer';
          link.addEventListener('click', event => { event.preventDefault(); if (desktop?.openExternal) desktop.openExternal(part.href).catch(() => {}); else window.open(part.href, '_blank', 'noopener,noreferrer'); });
          parent.append(link);
        } else parent.append(document.createTextNode(part.text));
      }
      return parent;
    };
    for (const block of logic ? logic.blocks(text) : [{ type: 'paragraph', text }]) {
      if (block.type === 'code') { const pre = node('pre'); pre.append(node('code', '', block.text)); box.append(pre); }
      else if (block.type === 'heading') box.append(inline(node('p', 'lane-md-heading'), block.text));
      else if (block.type === 'rule') box.append(node('hr'));
      else if (block.type === 'quote') box.append(inline(node('blockquote'), block.text));
      else if (block.type === 'list') { const list = node(block.ordered ? 'ol' : 'ul'); for (const item of block.items) list.append(inline(node('li'), item)); box.append(list); }
      else if (block.type === 'table') {
        const table = node('table'), head = node('tr');
        for (const cell of block.head) head.append(inline(node('th'), cell));
        table.append(head);
        for (const row of block.rows) { const line = node('tr'); for (const cell of row) line.append(inline(node('td'), cell)); table.append(line); }
        const wrap = node('div', 'lane-md-table'); wrap.append(table); box.append(wrap);
      } else box.append(inline(node('p'), block.text));
    }
    return box;
  }

  // The chat's approvals and questions, with the same cards as the main view, answered for the lane's workspace.
  function renderRequests(lane) {
    const { el } = lane, c = lane.c, pending = c?.pendingApprovals || [];
    const signature = JSON.stringify(pending.map(item => [item.id, item.runId, item.kind]));
    if (lane.signatures.requests === signature) return;
    lane.signatures.requests = signature;
    el.requests.replaceChildren();
    const fresh = [];
    for (const item of pending) {
      if (item.id && !lane.known.has(item.id)) { lane.known.add(item.id); fresh.push(item); }
      const options = { projectId: lane.id, done: () => load(lane) };
      const card = item.kind === 'question' ? window.relayQuestions?.card(item, c.id, options) : window.relayApprovals?.card(item, c.id, options);
      if (card) el.requests.append(card);
    }
    el.requests.hidden = !el.requests.children.length;
    if (fresh.length) api.announce?.(`${nameOf(lane.id)}: ${fresh.length === 1 ? (fresh[0].kind === 'question' ? `${agentName(fresh[0].provider)} has a question` : `${agentName(fresh[0].provider)} needs your approval`) : `${fresh.length} requests need you`}, in its lane.`);
  }
  // Anything else waiting: each opens in the main view, where it can be reviewed or decided.
  const ACT = { review: 'Review', card: 'Review', check: 'Open', retry: 'Open', handoff: 'Open', plan: 'Review', held: 'Open', limit: 'Open', schedule: 'Open', approval: 'Open', question: 'Answer' };
  const WORD = { review: 'Ready to review', card: 'Card to review', check: 'Tests failed', retry: 'Tests failed', handoff: 'Handoff offer', plan: 'Plan to approve', held: 'Paused', limit: 'Usage limit', schedule: 'Missed schedule', approval: 'Approval', question: 'Question' };
  function renderNeeds(lane) {
    const { el } = lane, items = needsFor(lane.id);
    const signature = JSON.stringify(items.map(item => [item.id, item.kind, item.detail]));
    if (lane.signatures.needs !== signature) {
      lane.signatures.needs = signature;
      el.waiting.replaceChildren(...items.slice(0, 4).map(item => {
        const row = node('li', 'lane-need'), open = node('button', 'lane-need-open');
        open.type = 'button'; row.dataset.kind = item.kind;
        const words = node('span', 'lane-need-words');
        words.append(node('span', 'lane-need-title', item.taskId ? item.title : WORD[item.kind] || 'Needs you'), node('span', 'lane-need-detail', item.taskId ? `${WORD[item.kind] || ''}${item.detail && !['review', 'card', 'check'].includes(item.kind) ? ` · ${item.detail}` : ''}` : item.detail || ''));
        open.append(words, node('span', 'lane-need-act', ACT[item.kind] || 'Open'));
        open.title = `${item.title}: ${item.detail || ''}. Opens in the main view.`;
        open.addEventListener('click', () => expand(lane.id, item.taskId || null));
        row.append(open); return row;
      }));
      if (items.length > 4) { const more = node('li', 'lane-need-more'), open = node('button', 'lane-need-open', `${items.length - 4} more · Expand`); open.type = 'button'; open.addEventListener('click', () => expand(lane.id)); more.append(open); el.waiting.append(more); }
      el.waiting.hidden = !items.length;
    }
    renderHead(lane);
  }
  function renderComposer(lane) {
    const { el } = lane, c = lane.c, running = isRunning(c), queueing = running || Boolean(c?.resume);
    const draftKey = c?.id ? `ai-relay:project:${lane.id}:draft:${c.id}` : null;
    if (draftKey && lane.draftKey !== draftKey) {
      lane.draftKey = draftKey;
      if (!el.input.value && document.activeElement !== el.input) { try { el.input.value = localStorage.getItem(draftKey) || ''; } catch { /* Drafts are a convenience. */ } size(el.input); }
    }
    el.input.placeholder = queueing ? 'Queue a follow-up…' : `Message ${nameOf(lane.id)}…`;
    el.input.disabled = !c;
    el.stop.hidden = !running;
    const label = queueing ? 'Queue it for after this run' : 'Send';
    el.send.setAttribute('aria-label', label); el.send.title = `${label} (Enter)`;
    el.send.classList.toggle('queueing', queueing);
    el.send.disabled = !c || lane.sending || !el.input.value.trim();
    const message = lane.notice?.text || '';
    el.error.hidden = !message; el.error.replaceChildren();
    if (message) {
      el.error.append(node('span', '', message));
      if (lane.notice.expand) { const go = node('button', 'lane-error-act', 'Expand'); go.type = 'button'; go.addEventListener('click', () => expand(lane.id)); el.error.append(go); }
    }
  }
  function saveDraft(lane) {
    if (!lane.draftKey) return;
    try { if (lane.el.input.value) localStorage.setItem(lane.draftKey, lane.el.input.value); else localStorage.removeItem(lane.draftKey); } catch { /* Drafts are a convenience. */ }
  }

  // ---- Acting from a lane.
  async function submit(lane) {
    const text = lane.el.input.value.trim();
    if (!text || lane.sending || !lane.c) return;
    lane.sending = true; lane.notice = null; renderComposer(lane);
    // A retry of the same text sends the same request ID, so a message that did arrive doesn't run twice.
    if (lane.retry?.text !== text) lane.retry = { text, id: crypto.randomUUID() };
    try {
      const result = await api.sendTo(lane.id, lane.c, text, { requestId: lane.retry.id });
      lane.retry = null;
      if (lane.el.input.value.trim() === text) { lane.el.input.value = ''; size(lane.el.input); saveDraft(lane); }
      api.announce?.(result?.queued ? `Queued in ${nameOf(lane.id)}.` : `Sent to ${nameOf(lane.id)}.`);
    } catch (error) { lane.notice = { text: error.message || 'This message could not be sent.', expand: error.expand === true }; }
    finally { lane.sending = false; renderComposer(lane); load(lane); }
  }
  async function stopRun(lane) {
    if (!lane.c?.id) return;
    lane.el.stop.disabled = true;
    try { await api.post(`/api/conversations/${encodeURIComponent(lane.c.id)}/stop`, {}, lane.id); }
    catch (error) { lane.notice = { text: error.message }; }
    finally { lane.el.stop.disabled = false; load(lane); }
  }
  // Expand: the lane's workspace goes to the main view and the one you were in takes its place (see sync()). A task
  // waiting for review opens there, with the main view's review, diff and merge.
  async function expand(id, taskId = null) {
    closeOverlay();
    await api.selectProject(id);
    if (taskId && state().projectId === id) await window.relayTaskThreads?.select?.(taskId);
  }
  function popOut(id) {
    if (!desktop?.openWorkspaceWindow) return;
    unpin(id, { quiet: true });
    desktop.openWorkspaceWindow(id).catch(error => api.showNotice?.(error.message));
  }
  function pin(id) {
    if (!canPin(id)) return false;
    let dropped = null;
    if (pins.length >= MAX) dropped = pins.shift();
    pins.push(id); save(); sync();
    api.announce?.(`${nameOf(id)} is pinned beside this workspace${dropped ? `, in place of ${nameOf(dropped)}` : ''}.`);
    return true;
  }
  function unpin(id, { quiet = false } = {}) {
    if (!pins.includes(id)) return false;
    pins = pins.filter(item => item !== id); save(); sync();
    if (!quiet) api.announce?.(`${nameOf(id)} is no longer pinned.`);
    return true;
  }
  // A notification or the menu bar asks for a pinned workspace: its lane comes forward, at the request if one is named.
  function reveal(id, approvalId = null) {
    const lane = lanes.get(id);
    if (!lane || host.hidden) return false;
    if (lane.el.root.dataset.compact === 'true') openOverlay(id);
    load(lane).then(() => {
      const cards = [...lane.el.requests.querySelectorAll('article')], card = cards.find(item => item.dataset.approvalId === approvalId) || cards[0];
      const target = card || lane.el.root;
      target.scrollIntoView?.({ block: 'nearest' }); target.focus?.({ preventScroll: true });
      lane.el.root.classList.add('lane-highlight'); setTimeout(() => lane.el.root.classList.remove('lane-highlight'), 1600);
    });
    return true;
  }

  // ---- The strip's lane over the page.
  function openOverlay(id) {
    if (overlay && overlay !== id) closeOverlay();
    overlay = id; layout();
    const lane = lanes.get(id); lane?.el.input.focus({ preventScroll: true });
  }
  function closeOverlay(focusStrip = false) {
    if (!overlay) return;
    const lane = lanes.get(overlay); overlay = null; layout();
    if (focusStrip) lane?.el.strip.focus();
  }
  function toggleOverlay(id) { if (overlay === id) closeOverlay(); else openOverlay(id); }
  document.addEventListener('pointerdown', event => { if (overlay && !host.contains(event.target) && !event.target.closest?.('[popover], dialog')) closeOverlay(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay && host.contains(document.activeElement) && !event.defaultPrevented) { closeOverlay(true); } });

  // ---- Where lanes go. In Normal and Flow they sit in the chat's column, right of the chat; as many as fit at full
  // width while the chat keeps MIN_CHAT pixels, the rest as strips. In the Plan they are strips at the window's edge.
  let laid = '', wasPlanning = shell.classList.contains('plan');
  function layout() {
    const planning = shell.classList.contains('plan'), want = pins.length > 0 && Boolean(state().projectId) && lanes.size > 0;
    // A lane opened from a strip closes when the view changes, so it never lies over the next view's lanes.
    if (planning !== wasPlanning) { overlay = null; wasPlanning = planning; }
    const parent = planning ? shell : panel;
    if (host.parentNode !== parent) parent.append(host);
    host.hidden = !want;
    let fullCount = 0, width = 0;
    if (want && !planning) {
      const room = panel.getBoundingClientRect().width;
      width = Math.round(Math.min(380, Math.max(300, room * 0.27)));
      for (let k = pins.length; k >= 0; k--) if (room - k * width - (pins.length - k ? STRIP : 0) >= MIN_CHAT) { fullCount = k; break; }
    }
    const strips = want ? pins.length - fullCount : 0, used = want ? fullCount * width + (strips ? STRIP : 0) : 0;
    const key = JSON.stringify([want, planning, fullCount, width, strips, overlay, pins]);
    if (key === laid) return;
    laid = key;
    panel.classList.toggle('has-lanes', want && !planning);
    shell.classList.toggle('has-lane-strips', want && planning);
    host.classList.toggle('planning', planning);
    panel.style.setProperty('--lanes-width', `${planning ? 0 : used}px`);
    host.style.setProperty('--lane-width', `${width || 360}px`);
    full.replaceChildren(); rail.replaceChildren();
    pins.forEach((id, index) => {
      const lane = lanes.get(id); if (!lane) return;
      const compact = index >= fullCount;
      lane.el.root.dataset.compact = String(compact);
      lane.el.root.classList.toggle('overlay', compact && overlay === id);
      if (!compact) full.append(lane.el.root);
      else { rail.append(lane.el.strip); if (overlay === id) host.append(lane.el.root); else lane.el.root.remove(); }
      renderHead(lane);
    });
    if (overlay && (!pins.includes(overlay) || lanes.get(overlay)?.el.root.dataset.compact !== 'true')) overlay = null;
    rail.hidden = !strips; full.hidden = !fullCount;
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => layout()).observe(panel);
  if (typeof MutationObserver === 'function') new MutationObserver(() => layout()).observe(shell, { attributes: true, attributeFilter: ['class'] });

  // ---- Following the main view. Choosing a pinned workspace in the main view swaps it with the one you were in; a
  // workspace that went away or opened in another window leaves its lane.
  let previous = null;
  function sync() {
    const s = state(), current = s.projectId || null;
    if (current !== previous) {
      const at = current ? pins.indexOf(current) : -1;
      if (at >= 0) {
        if (previous && project(previous) && !elsewhere().includes(previous)) pins[at] = previous; else pins.splice(at, 1);
        save();
      }
      previous = current;
    }
    if (s.projectsLoaded) {
      const kept = pins.filter(id => id !== current && project(id) && !elsewhere().includes(id));
      if (kept.length !== pins.length) { pins = kept; save(); }
    }
    for (const id of [...lanes.keys()]) if (!pins.includes(id)) destroy(id);
    for (const id of pins) if (!lanes.has(id)) load(create(id));
    layout();
    api.renderSidebar?.();
    const running = [...lanes.values()].some(lane => isRunning(lane.c));
    if (running && !ticker) ticker = setInterval(() => { for (const lane of lanes.values()) if (isRunning(lane.c)) renderHead(lane); }, 30000);
    else if (!running && ticker) { clearInterval(ticker); ticker = null; }
  }
  window.addEventListener('relay-state', sync);
  window.addEventListener('relay-project-update', event => {
    const id = event.detail?.projectId;
    if (!id) { for (const lane of lanes.values()) schedule(lane); return; }
    const lane = lanes.get(id); if (lane) { needs.at = 0; schedule(lane); }
  });
  setInterval(() => { if (!document.hidden) { needs.at = 0; for (const lane of lanes.values()) schedule(lane, 0); } }, POLL);
  window.addEventListener('focus', () => { needs.at = 0; for (const lane of lanes.values()) schedule(lane, 0); });
  save();
  sync();

  window.relayLanes = { has: id => pins.includes(id), ids: () => [...pins], canPin, pin, unpin, reveal, expand };
})();

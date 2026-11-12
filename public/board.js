// The task board (#132, first stage), full window, opened by Board beside Plan. A workspace's cards in five columns:
// Backlog and Ready are yours to fill and order (drag a card, or use the buttons in its drawer); Doing and Review follow the
// task a card started; Done is what you accepted. Selecting a card opens it in a drawer to edit and act on. Run Ready opens
// the same drawer with the Ready cards to choose from, and runs exactly the ones ticked.
// The Canvas view (#97) shows the same cards placed freely, with arrows for what waits for what: drag a card to place it,
// drag from the dot on its right edge to another card to make that one wait, and undo either. Columns stays the list for
// the keyboard and screen readers. Export saves the board as Markdown with a Mermaid chart.
// Schedules (#132) run a Ready card, or a prompt, once at a set time or every day, weekday or week, from the same drawer.
// One Plan (#162): this is the Plan, opened by the Plan button. Cards also carry a group, a role, what they produce, an
// acceptance check, their files, a size and Auto. The Outline lists the cards by group, with Run and Stop for a group.
// An agent's drafted plan arrives as draft cards, with a banner to accept or discard them, and a finished card is tested
// before the cards that wait for it start, with Check again and Continue anyway when its tests fail.
// Closed to agents (#97): the whole Plan, or one card, can be kept from agents: it can't run, be scheduled or attached, and
// Export leaves it out unless you choose everything. Attach to message puts the Plan, or a card, in your next message.
// Subtasks (#155): a major card is split into subtasks when it starts. Its drawer lists them as they run, with the ones
// not started yet to edit, remove or add to, and Pause after the subtask it is on.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('board-view'), api = window.relayUI;
  if (!dialog || !api) return;
  const node = (tag, cls, text) => { const value = document.createElement(tag); if (cls) value.className = cls; if (text !== undefined) value.textContent = text; return value; };
  const button = (text, handler, cls = 'secondary-button') => { const value = node('button', cls, text); value.type = 'button'; value.addEventListener('click', handler); return value; };
  // The modifier that moves a card on the canvas, named as the keyboard labels it.
  const altKey = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? 'Option' : 'Alt';
  const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
  const listNames = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const listed = items => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const COLUMNS = [
    ['backlog', 'Backlog', 'Work for later. Move a card to Ready when it’s clear enough to run.'],
    ['ready', 'Ready', 'Cards with an agent, ready to run.'],
    ['doing', 'Doing', 'An agent is working on these, each as its own task.'],
    ['review', 'Review', 'Finished, waiting for you to accept or send back.'],
    ['done', 'Done', 'Work you accepted.'],
  ];
  const AGENTS = [['codex', 'Codex'], ['claude', 'Claude'], ['gemini', 'Gemini']], AGENT = Object.fromEntries(AGENTS);
  const ROLES = [['builder', 'Builder'], ['frontend', 'Frontend'], ['backend', 'Backend'], ['database', 'Database'], ['design', 'Design'], ['qa', 'QA'], ['reviewer', 'Reviewer']], ROLE = Object.fromEntries(ROLES);
  const PRODUCES = [['', 'Nothing in particular'], ['contract', 'A contract'], ['schema', 'A schema'], ['diff', 'Changes'], ['test_evidence', 'Test evidence'], ['findings', 'Findings']];
  const SIZES = [['light', 'Light'], ['standard', 'Standard'], ['deep', 'Deep']];
  // A card's own tests (#162), as its result and its task report them.
  const TESTS = { running: 'Testing…', passed: 'Tests passed', failed: 'Tests failed', interrupted: 'Tests interrupted', 'no-change': 'No changes to test', unverified: 'Not tested' };
  const NO_GROUP = 'Not in a group';
  const PRIORITIES = [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
  const OUTCOME = { complete: 'Finished', integrated: 'Merged', kept: 'Kept as a branch', stopped: 'Stopped', failed: 'Didn’t finish', cancelled: 'Cancelled', discarded: 'Discarded', blocked: 'Blocked', lost: 'Copy gone', detached: 'Folder removed' };
  const when = iso => { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return ''; } };
  // A due date is a calendar day (YYYY-MM-DD), compared with today where you are.
  const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
  const dayName = day => { const [y, m, d] = day.split('-').map(Number); try { return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) }); } catch { return day; } };
  function dueOf(card) {
    if (!card.due) return null;
    if (card.column === 'done') return { text: `Due ${dayName(card.due)}`, tone: '' };
    const now = today();
    if (card.due < now) return { text: `Overdue · ${dayName(card.due)}`, tone: 'late' };
    return card.due === now ? { text: 'Due today', tone: 'soon' } : { text: `Due ${dayName(card.due)}`, tone: '' };
  }
  const lockIcon = () => { const icon = svg('svg'); icon.setAttribute('class', 'icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); const body = svg('rect'); for (const [name, value] of [['x', '5'], ['y', '11'], ['width', '14'], ['height', '9'], ['rx', '1.5']]) body.setAttribute(name, value); const loop = svg('path'); loop.setAttribute('d', 'M8 11V8a4 4 0 0 1 8 0v3'); icon.append(body, loop); return icon; };
  const commentIcon = () => { const icon = svg('svg'); icon.setAttribute('class', 'icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); const path = svg('path'); path.setAttribute('d', 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'); icon.append(path); return icon; };

  // board: the last answer from the server. selected: the card in the drawer, 'new' for a new one, 'run' for Run Ready.
  // draft: what the drawer edits, kept apart so a refresh never overwrites typing. picked: the cards ticked in Run Ready.
  // seen: what the board was last loaded for; cleared when a load fails, so the next update tries again.
  // sdraft: the schedule being written, when selected is 'schedule'; 'schedules' lists them all.
  // filter: the label whose cards are shown, lower case, or '' for all. threads: each card's comments once read, and
  // asked: the comment count they were read for, so a card is asked again only when that changes. said: a comment being
  // written, per card, kept when the drawer is drawn again.
  let seen = null, board = null, selected = null, draft = null, sdraft = null, picked = new Set(), failure = '', busy = false, loading = 0, drawn = null, dragging = null;
  let filter = '', threads = new Map(), asked = new Map(), said = new Map(), moreOpen = false;
  // subEdit: a subtask being written or edited in a card's drawer, kept when the drawer is drawn again.
  let subEdit = null;
  const cards = () => board?.cards || [];
  const shown = card => !filter || (card.labels || []).some(name => name.toLowerCase() === filter);
  // Every label on the board, in the case first used, with how many cards have it.
  function allLabels() {
    const out = new Map();
    for (const card of cards()) for (const name of card.labels || []) { const key = name.toLowerCase(), had = out.get(key); out.set(key, had ? { ...had, count: had.count + 1 } : { name, count: 1 }); }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  const cardBy = id => cards().find(card => card.id === id);
  const folderName = id => board?.folders.find(folder => folder.id === id)?.name || '';
  const VIEW_KEY = 'throughline:board-view', VIEWS = ['columns', 'canvas', 'outline'];
  let view = (() => { try { const saved = localStorage.getItem(VIEW_KEY); return VIEWS.includes(saved) ? saved : 'columns'; } catch { return 'columns'; } })();
  // The agent Auto would pick for a card now, as Orchestrate's steps showed it (#12): routing's choice at the card's size, or
  // the conversation's own agent when routing is off. In Flow it is chosen again when the card starts.
  function autoPick(card) {
    const state = api.getState(), routed = api.routeFor?.(card.notes || card.title || 'Plan card', 0, null, { tier: card.tier || 'standard' });
    if (!routed) { const provider = state.provider || 'codex', model = state.model || null; return { provider, model, effort: state.effort || null, text: `${AGENT[provider] || provider} · ${model || 'default model'}` }; }
    if (routed.error) return { error: routed.error, text: routed.error };
    const effort = routed.effort ? `${routed.effort[0].toUpperCase()}${routed.effort.slice(1)} effort` : '';
    return { provider: routed.provider, model: routed.model || null, effort: routed.effort || null, auto: true, text: ['Auto:', [AGENT[routed.provider] || routed.provider, routed.modelName || 'default model', effort].filter(Boolean).join(' · ')].join(' ') };
  }
  const shut = card => board?.closed === true || card?.closed === true;
  const runnable = card => !card.draft && !shut(card) && (Boolean(card.agent) || card.auto === true);
  // What a Run sends for the cards on Auto: the pick shown, or the reason none can be made.
  function assignments(list) {
    const out = {};
    for (const card of list.filter(item => !item.agent && item.auto)) { const pick = autoPick(card); if (pick.error) return { error: `“${card.title}”: ${pick.error}` }; out[card.id] = { provider: pick.provider, model: pick.model, effort: pick.effort, ...(pick.auto ? { auto: true } : {}) }; }
    return { assignments: out };
  }
  // What a card's agent bills (#108): 'api' for an API account, 'unknown' when its billing couldn't be confirmed, null for a
  // subscription. Said only once the account has been checked, as the message box does; until then a run that turns out to
  // bill by use stops when it starts, without charging.
  function bills(provider) {
    const account = provider ? api.getState().accounts?.[provider] : null;
    if (!account || account.installed === false || account.authenticated === false || ['subscription', 'local'].includes(account.billingSource)) return null;
    return account.billingSource === 'api' ? 'api' : 'unknown';
  }
  const billsLabel = provider => bills(provider) === 'api' ? 'Bills by use' : 'Billing not confirmed';
  const billsSentence = provider => bills(provider) === 'api' ? `${AGENT[provider]} bills your API account.` : `${AGENT[provider]}’s billing couldn’t be confirmed.`;
  // Before a run: one question for every card in it whose agent bills by use, unless Settings already allows it for this
  // session. Returns what the run sends, or null when you said no.
  function billingFor(list, picks = {}) {
    const allowed = window.relayBillingConfirmed === true;
    const charged = list.map(card => ({ card, provider: card.agent?.provider || picks[card.id]?.provider })).filter(item => bills(item.provider));
    if (!charged.length || allowed) return { billingConfirmed: allowed };
    const agents = [...new Set(charged.map(item => item.provider))], which = charged.length === 1 ? `“${charged[0].card.title}”` : plural(charged.length, 'card');
    const ok = window.confirm(`Run ${which} with charges?\n\n${agents.map(billsSentence).join(' ')} Running ${charged.length === 1 ? 'it' : 'them'} may cost money.\n\nTo stop this question for this session, turn on Allow API and unconfirmed billing in Settings.`);
    return ok ? { billingConfirmed: true } : null;
  }
  // Canvas changes in flight: a load that answers meanwhile would draw cards back where they were, so it waits.
  let writes = 0, written = 0;

  async function load() {
    if (!api.getState().projectId) return;
    const request = ++loading;
    try { const result = await api.api('/api/board'); if (request === loading) { if (writes) { seen = null; return; } board = result; render(); } }
    catch (error) { if (request === loading) { seen = null; failure = error.message; render(); } }
  }
  async function act(path, input = {}, done) {
    if (busy) return; busy = true; failure = ''; render();
    try { const result = await api.post(path, input); board = result.board || board; done?.(result); }
    catch (error) { failure = error.message; }
    finally { busy = false; render(); }
  }

  // ---- The columns
  // A major card's subtasks in a few words for its face, and in a sentence.
  function subtaskLine(card) {
    const list = card.subtasks || [];
    if (list.length) { const done = list.filter(item => item.status === 'done').length; return { short: `${done}/${list.length} subtasks`, long: `${done} of ${plural(list.length, 'subtask')} done` }; }
    return card.split ? { short: 'Major', long: 'Split into subtasks when it starts' } : null;
  }
  // What a card says about itself in one short line, from its task while it has one.
  function stateOf(card) {
    const task = card.taskState;
    if (card.draft) return { text: 'Draft', tone: 'draft', detail: (card.draft.notes || []).join(' ') };
    if (card.column === 'doing') {
      if (task?.approvals) return { text: 'Needs you', tone: 'attention' };
      if (task?.status === 'running' && card.splitting) return { text: 'Splitting', tone: 'running', detail: 'Splitting it into subtasks, reading only.' };
      const at = (card.subtasks || []).findIndex(item => item.status === 'running');
      if (task?.status === 'running' && at >= 0) return { text: 'Working', tone: 'running', detail: `Subtask ${at + 1} of ${card.subtasks.length}: ${card.subtasks[at].title}${card.subtasksPaused ? '. Pauses after it.' : ''}` };
      if (task?.status === 'running') return { text: 'Working', tone: 'running' };
      return { text: task?.held ? 'Held' : 'Waiting', tone: 'waiting', detail: task?.reason || '' };
    }
    if (card.column === 'review') {
      if (task?.hasWorktree) return { text: 'Merge first', tone: 'attention', detail: 'Its changes are in the task’s own copy. Review and merge them in its task.' };
      const tests = card.result?.tests;
      if (tests === 'running') return { text: TESTS.running, tone: 'running', detail: 'Running the project’s tests on this card’s result. The cards after it wait for them.' };
      if (tests === 'failed' || tests === 'interrupted') return { text: card.result.testsAccepted ? `${TESTS[tests]} · continued` : TESTS[tests], tone: 'trouble', detail: card.result.testsAccepted ? 'You chose to let the cards after it build on it anyway.' : `${card.result.testsReason || ''}${task?.holds ? ' The cards after it wait until you check it again or continue anyway.' : ''}`.trim() };
      return { text: tests === 'passed' ? TESTS.passed : 'Finished', tone: 'done' };
    }
    if (card.column === 'ready' && card.reason) return { text: 'Back', tone: 'trouble', detail: card.reason };
    return null;
  }
  function cardButton(card, onCanvas = false) {
    const item = node('button', 'board-card'); item.type = 'button';
    item.dataset.card = card.id; item.dataset.column = card.column; item.dataset.priority = card.priority;
    item.setAttribute('aria-pressed', String(selected === card.id));
    const state = stateOf(card), top = node('span', 'board-card-top');
    // On the canvas there are no columns to say where a card stands, so the card says it.
    if (onCanvas) top.append(node('span', 'board-card-column', COLUMNS.find(([id]) => id === card.column)[1]));
    if (card.role && card.role !== 'builder') { const role = node('span', 'orchestration-step-role', ROLE[card.role] || card.role); role.dataset.role = card.role; top.append(role); }
    if (card.priority !== 'normal') top.append(node('span', `board-priority ${card.priority}`, card.priority === 'high' ? 'High' : 'Low'));
    if (state) { const badge = node('span', 'board-card-state', state.text); badge.dataset.tone = state.tone; top.append(badge); }
    const title = node('span', 'board-card-title', card.title);
    // Up to three labels, then how many more; the one being filtered by is marked.
    const names = card.labels || [], tags = node('span', 'board-card-labels');
    for (const name of names.slice(0, names.length > 3 ? 2 : 3)) { const tag = node('span', 'board-label', name); if (filter && name.toLowerCase() === filter) tag.classList.add('current'); tags.append(tag); }
    if (names.length > 3) { const more = node('span', 'board-label more', `+${names.length - 2}`); more.title = names.slice(2).join(', '); tags.append(more); }
    const meta = node('span', 'board-card-meta'), provider = card.taskState?.provider || card.agent?.provider;
    const icon = node('i', `agent-icon ${provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
    const who = provider ? AGENT[provider] : card.auto ? 'Auto' : 'No agent yet';
    meta.append(icon, node('span', provider || card.auto ? 'board-card-agent' : 'board-card-missing', who));
    // Before a card runs, including a draft, it says when its agent bills by use (#108).
    const charged = (card.draft || ['backlog', 'ready'].includes(card.column)) && card.agent && bills(card.agent.provider) ? billsLabel(card.agent.provider) : '';
    if (charged) { const tag = node('span', 'board-card-billing', charged); tag.title = `${billsSentence(card.agent.provider)} You’re asked before it runs.`; meta.append(tag); }
    if (card.checks?.length) meta.append(node('span', 'board-card-checks', `${card.checks.filter(item => item.done).length}/${card.checks.length}`));
    // A major card (#155): how far its subtasks have got, or that it splits when it starts.
    const parts$ = subtaskLine(card);
    if (parts$) { const tag = node('span', 'board-card-subtasks', parts$.short); tag.title = parts$.long; meta.append(tag); }
    const due = dueOf(card);
    if (due) { const day = node('span', `board-card-due${due.tone ? ` ${due.tone}` : ''}`, due.text); day.title = card.due; meta.append(day); }
    // A card closed to agents says so; when the whole Plan is closed, the banner above says it once instead.
    if (card.closed && !board?.closed) { const lock = node('span', 'board-card-closed'); lock.append(lockIcon(), document.createTextNode('Closed')); lock.title = 'Closed to agents'; meta.append(lock); }
    if (card.commentCount) { const count = node('span', 'board-card-comments'); count.append(commentIcon(), document.createTextNode(String(card.commentCount))); count.title = plural(card.commentCount, 'comment'); meta.append(count); }
    const timed = schedulesOf(card), soon = timed.filter(item => !item.paused && item.nextAt).sort((a, b) => a.nextAt.localeCompare(b.nextAt))[0];
    if (timed.some(item => item.missed)) meta.append(node('span', 'board-card-schedule missed', 'Scheduled run missed'));
    else if (timed.some(item => item.waiting && !item.paused)) meta.append(node('span', 'board-card-schedule', 'Waiting for a usage reset'));
    else if (soon) meta.append(node('span', 'board-card-schedule', `Runs ${when(soon.nextAt)}`));
    const after = (card.dependsOn || []).map(cardBy).filter(item => item && item.column !== 'done');
    if (after.length && ['backlog', 'ready'].includes(card.column)) meta.append(node('span', 'board-card-after', `After ${after.map(item => item.title).join(', ')}`));
    const group = card.group && view !== 'outline' ? node('span', 'board-card-group', card.group) : null;
    item.append(top, ...(group ? [group] : []), title, ...(names.length ? [tags] : []), meta);
    if (state?.detail && card.column === 'ready') item.append(node('span', 'board-card-reason', state.detail));
    item.title = state?.detail || card.title;
    item.setAttribute('aria-label', [card.draft ? 'Draft' : '', card.title, card.group ? `group ${card.group}` : '', card.role && card.role !== 'builder' ? `${ROLE[card.role]} role` : '', card.priority !== 'normal' ? `${card.priority} priority` : '', names.length ? `${names.length === 1 ? 'label' : 'labels'} ${listed(names)}` : '', provider ? AGENT[provider] : card.auto ? 'agent on Auto' : 'no agent yet', charged, subtaskLine(card)?.long || '', due?.text || '', card.commentCount ? plural(card.commentCount, 'comment') : '', card.closed ? 'closed to agents' : '', state?.text || '', state?.detail || '', timed.some(item => item.missed) ? 'a scheduled run was missed' : soon ? `scheduled to run ${when(soon.nextAt)}` : ''].filter(Boolean).join('. '));
    item.addEventListener('click', () => { if (moved === card.id) { moved = null; return; } select(card.id); });
    // Backlog, Ready and Done cards can be dragged: between Backlog and Ready, back from Done, and into a new order.
    if (!onCanvas && view === 'columns' && ['backlog', 'ready', 'done'].includes(card.column) && !card.draft) {
      item.draggable = true;
      item.addEventListener('dragstart', event => { dragging = card.id; event.dataTransfer?.setData('text/plain', card.id); item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { dragging = null; item.classList.remove('dragging'); for (const zone of dialog.querySelectorAll('.board-column.drop')) zone.classList.remove('drop'); });
    }
    return item;
  }
  function dropTarget(column, zone, list) {
    const accepts = id => { const card = cardBy(id); return card && (card.column === column || ({ backlog: ['ready', 'done'], ready: ['backlog', 'done'] }[column] || []).includes(card.column)); };
    zone.addEventListener('dragover', event => { if (!dragging || !accepts(dragging)) return; event.preventDefault(); zone.classList.add('drop'); });
    zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop'); });
    zone.addEventListener('drop', event => {
      const id = dragging; zone.classList.remove('drop');
      if (!id || !accepts(id)) return; event.preventDefault();
      const under = [...list.querySelectorAll('.board-card')].find(element => element.dataset.card !== id && event.clientY < element.getBoundingClientRect().top + element.offsetHeight / 2);
      act(`/api/board/cards/${id}/move`, { column, before: under?.dataset.card || null });
    });
  }
  function drawColumns() {
    $('board-columns').replaceChildren(...COLUMNS.map(([id, name, hint]) => {
      const column = node('section', 'board-column'), head = node('header', 'board-column-head'), list = node('div', 'board-column-cards'), all = cards().filter(card => card.column === id), own = all.filter(shown);
      // With a label chosen, a column shows only its cards with that label, and says how many of its cards that is.
      const count = filter ? `${own.length} of ${all.length}` : String(all.length);
      column.dataset.column = id; column.setAttribute('aria-label', `${name}, ${filter ? `${own.length} of ${plural(all.length, 'card')} shown` : plural(all.length, 'card')}`);
      head.append(node('span', 'board-column-name', name), node('span', 'board-column-count', count));
      if (id === 'backlog' || id === 'ready') { const add = button('+', () => openNew(id), 'icon-button board-column-add'); add.setAttribute('aria-label', `New card in ${name}`); add.title = `New card in ${name}`; head.append(add); }
      list.append(...own.map(card => cardButton(card)));
      if (!own.length) list.append(node('p', 'board-column-empty', all.length ? 'No cards here with this label.' : hint));
      column.append(head, list);
      if (id === 'backlog' || id === 'ready') dropTarget(id, column, list);
      return column;
    }));
  }

  // ---- The drawer
  const blank = (column, at = null, prefill = {}) => ({ title: '', notes: '', priority: 'normal', labels: filter ? [allLabels().find(item => item.name.toLowerCase() === filter)?.name].filter(Boolean) : [], due: null, agent: null, auto: false, folderId: null, dependsOn: [], checks: [], group: '', role: 'builder', artifact: null, check: '', files: '', tier: 'standard', closed: false, split: false, column, revision: null, at, ...prefill });
  const editable = card => ({ title: card.title, notes: card.notes || '', priority: card.priority, labels: [...(card.labels || [])], due: card.due || null, agent: card.agent ? { ...card.agent } : null, auto: card.auto === true, folderId: card.folderId || null, dependsOn: [...(card.dependsOn || [])], checks: (card.checks || []).map(item => ({ ...item })), group: card.group || '', role: card.role || 'builder', artifact: card.artifact || null, check: card.check || '', files: (card.files || []).join(', '), tier: card.tier || 'standard', closed: card.closed === true, split: card.split === true, column: card.column, revision: card.revision });
  const fileList = text => [...new Set(String(text || '').split(',').map(item => item.trim()).filter(Boolean))];
  const fields = value => JSON.stringify([value.title.trim(), value.notes.trim(), value.priority, value.labels, value.due, value.agent?.provider || null, value.auto, value.folderId, [...value.dependsOn].sort(), value.checks.map(item => [item.text.trim(), item.done]), value.group.trim(), value.role, value.artifact, value.check.trim(), fileList(value.files), value.tier, value.closed === true, value.split === true]);
  // Every group on the Plan, in the order first used.
  const allGroups = () => [...new Set(cards().map(card => card.group).filter(Boolean))];
  const dirty = () => { if (!draft) return false; if (selected === 'new') return Boolean(draft.title.trim() || draft.notes.trim()); const card = cardBy(selected); return card ? fields(draft) !== fields(editable(card)) : false; };
  function select(id) {
    if (selected && selected !== id && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = selected === id ? null : id; failure = '';
    draft = selected && cardBy(selected) ? editable(cardBy(selected)) : null; drawn = null;
    render();
    if (selected) $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function openNew(column = 'backlog', at = null, prefill = {}) {
    if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = 'new'; draft = blank(column, at, prefill); failure = ''; drawn = null; render();
    $('board-drawer-body').querySelector('.board-field-title')?.focus();
  }
  // Run Ready, or one group's Ready cards when a group is given.
  function openRun(group = null) {
    if (selected && selected !== 'run' && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = 'run'; draft = null; failure = ''; drawn = null;
    picked = new Set(cards().filter(card => card.column === 'ready' && runnable(card) && (group === null || (card.group || NO_GROUP) === group)).map(card => card.id));
    render();
  }
  function closeDrawer() { if (dirty() && !window.confirm('Leave this card without saving your changes?')) return; const was = selected; selected = null; draft = null; failure = ''; render(); if (was) $('board-columns').querySelector(`[data-card="${was}"]`)?.focus(); }

  function segment(label, options, current, choose, disabled) {
    const group = node('div', 'board-segment'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [value, text, iconClass] of options) {
      const choice = node('button', 'board-choice'); choice.type = 'button'; choice.disabled = disabled;
      if (iconClass) { const icon = node('i', iconClass); icon.setAttribute('aria-hidden', 'true'); choice.append(icon); }
      choice.append(document.createTextNode(text)); choice.setAttribute('aria-pressed', String(value === current));
      choice.addEventListener('click', () => { choose(value); for (const other of group.children) other.setAttribute('aria-pressed', String(other === choice)); changed(); });
      group.append(choice);
    }
    return group;
  }
  const labelled = (text, control, note) => { const row = node('div', 'board-field'); row.append(node('span', 'board-field-label', text), control); if (note) row.append(node('span', 'board-field-note', note)); return row; };
  // Typing changes only the draft and the Save button; the drawer itself is rebuilt only when the card or the mode changes.
  function changed() { failure = ''; const save = $('board-drawer-body').querySelector('.board-save'); if (save) save.disabled = busy || !dirty() || !draft.title.trim(); const revert = $('board-drawer-body').querySelector('.board-revert'); if (revert) revert.hidden = selected === 'new' || !dirty(); showError(); }

  function editor(card) {
    const locked = card?.column === 'doing', parts = [];
    const title = node('input', 'board-input board-field-title'); title.value = draft.title; title.maxLength = board?.limits?.title || 200; title.placeholder = 'What needs doing'; title.setAttribute('aria-label', 'Card title'); title.disabled = locked;
    title.addEventListener('input', () => { draft.title = title.value; changed(); });
    const notes = node('textarea', 'board-input board-field-notes'); notes.value = draft.notes; notes.rows = 5; notes.maxLength = board?.limits?.notes || 20000; notes.placeholder = 'Details the agent needs: where, what, and anything to avoid'; notes.setAttribute('aria-label', 'Card description'); notes.disabled = locked;
    notes.addEventListener('input', () => { draft.notes = notes.value; changed(); });
    parts.push(title, notes);
    if (locked) parts.push(node('p', 'board-note', 'An agent is working from this card. Stop it to change what it says.'));
    parts.push(labelled('Priority', segment('Priority', PRIORITIES, draft.priority, value => { draft.priority = value; }, false)));
    // Labels and the due date are yours to sort and plan by: the agent isn't told them, so they can change while it works.
    const tags = node('div', 'board-labels-edit'), entry$ = node('input', 'board-label-input'), options = node('datalist');
    options.id = 'board-label-options'; entry$.setAttribute('list', options.id);
    entry$.maxLength = board?.limits?.label || 32; entry$.placeholder = draft.labels.length ? 'Add another' : 'Add a label'; entry$.setAttribute('aria-label', 'Add a label');
    const most = board?.limits?.labels || 8;
    const addLabel = () => {
      const name = entry$.value.replace(/\s+/g, ' ').replace(/,/g, '').trim(); entry$.value = '';
      if (!name || draft.labels.some(item => item.toLowerCase() === name.toLowerCase())) return;
      if (draft.labels.length >= most) { failure = `A card can have up to ${most} labels.`; showError(); return; }
      // A label already on the board keeps the case it was first written in, so the filter finds one label, not two.
      draft.labels = [...draft.labels, allLabels().find(item => item.name.toLowerCase() === name.toLowerCase())?.name || name]; drawTags(); changed();
    };
    const drawTags = () => {
      const chips = draft.labels.map((name, index) => {
        const chip = node('span', 'board-label editable'), remove = button('×', () => { draft.labels = draft.labels.filter((_, at) => at !== index); drawTags(); changed(); entry$.focus(); }, 'board-label-remove');
        remove.setAttribute('aria-label', `Remove the label “${name}”`); remove.title = 'Remove';
        chip.append(node('span', '', name), remove); return chip;
      });
      options.replaceChildren(...allLabels().filter(item => !draft.labels.some(name => name.toLowerCase() === item.name.toLowerCase())).map(item => { const option = node('option'); option.value = item.name; return option; }));
      entry$.hidden = draft.labels.length >= most; entry$.placeholder = draft.labels.length ? 'Add another' : 'Add a label';
      tags.replaceChildren(...chips, entry$, options);
    };
    entry$.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addLabel(); }
      else if (event.key === 'Backspace' && !entry$.value && draft.labels.length) { draft.labels = draft.labels.slice(0, -1); drawTags(); changed(); }
    });
    // Choosing a suggestion, or leaving the field with a name typed, adds it too.
    entry$.addEventListener('input', event => { if (event.inputType === 'insertReplacementText' || (!event.inputType && allLabels().some(item => item.name === entry$.value))) addLabel(); });
    entry$.addEventListener('blur', () => { if (entry$.value.trim()) addLabel(); });
    tags.addEventListener('click', event => { if (event.target === tags) entry$.focus(); });
    drawTags();
    parts.push(labelled('Labels', tags));
    const day = node('input', 'board-input board-due-input'); day.type = 'date'; day.value = draft.due || ''; day.setAttribute('aria-label', 'Due date');
    const clear = button('Clear', () => { draft.due = null; day.value = ''; clear.hidden = true; changed(); day.focus(); }, 'text-link board-due-clear'); clear.hidden = !draft.due;
    day.addEventListener('change', () => { draft.due = /^\d{4}-\d{2}-\d{2}$/.test(day.value) ? day.value : null; clear.hidden = !draft.due; changed(); });
    const dueRow = node('div', 'board-due'); dueRow.append(day, clear);
    parts.push(labelled('Due', dueRow));
    // Closed to agents (#97): yours alone. Like labels it's not something the agent reads, so it saves with the card.
    const privacy = node('label', 'board-closed-edit'), shutBox = node('input'); shutBox.type = 'checkbox';
    shutBox.checked = board?.closed === true || draft.closed === true; shutBox.disabled = board?.closed === true || (locked && !draft.closed);
    shutBox.addEventListener('change', () => { draft.closed = shutBox.checked; changed(); });
    privacy.append(shutBox, lockIcon(), node('span', '', 'Closed to agents'));
    parts.push(labelled('Agents', privacy, board?.closed ? 'The whole Plan is closed to agents. Open it to agents from the top of the Plan.' : locked ? 'An agent is working on this card. Stop it before closing it to agents.' : 'A closed card can’t run, be scheduled or attached, isn’t named to the cards after it, and is left out of exports. An agent allowed to read anywhere on this computer could still find Codeshi’s own files.'));
    // Auto (#162) is chosen here like an agent: routing picks the agent, model and effort when the card runs.
    // What the agent bills is said either way (#108): a subscription, or by use, which asks before the card runs.
    const billedNote = provider => { if (!provider) return ''; const account = api.getState().accounts?.[provider]; return bills(provider) ? ` ${billsSentence(provider)} You’re asked before it runs, as it may cost money.` : account?.billingSource === 'subscription' ? ` Uses your ${AGENT[provider]} subscription.` : ''; };
    const agentNote = () => { if (draft.auto) { const pick = autoPick(draft); return `Codeshi picks the agent, model and effort for a ${SIZES.find(([value]) => value === draft.tier)[1].toLowerCase()} card when it runs. Now that would be ${pick.text.replace(/^Auto: /, '')}.${pick.error ? '' : billedNote(pick.provider)}`; } return draft.agent ? `Runs with this agent’s default model and effort.${billedNote(draft.agent.provider)}` : 'Choose an agent, or Auto, before the card can run.'; };
    const agentField = labelled('Agent', segment('Agent', [['auto', 'Auto', 'agent-icon auto'], ...AGENTS.map(([value, text]) => [value, text, `agent-icon ${value}`])], draft.auto ? 'auto' : draft.agent?.provider || null, value => { if (value === 'auto') { draft.auto = true; draft.agent = null; } else { draft.auto = false; draft.agent = { provider: value, model: null, effort: null }; } agentField.querySelector('.board-field-note').textContent = agentNote(); }, locked), agentNote());
    parts.push(agentField);
    parts.push(labelled('Size', segment('Size', SIZES, draft.tier, value => { draft.tier = value; agentField.querySelector('.board-field-note').textContent = agentNote(); }, locked)));
    // A major card (#155): split into subtasks when it starts, against the code the cards before it produced.
    const major = node('label', 'board-closed-edit board-split-edit'), majorBox = node('input'); majorBox.type = 'checkbox';
    majorBox.checked = draft.split === true; majorBox.disabled = locked || Boolean(card?.subtasks?.length);
    majorBox.addEventListener('change', () => { draft.split = majorBox.checked; changed(); });
    major.append(majorBox, node('span', '', 'Split into subtasks when it starts'));
    parts.push(labelled('Subtasks', major, card?.subtasks?.length ? 'It has subtasks. Split again from its subtasks to plan them afresh.' : 'For a big card. When it starts, a short read-only run splits it into subtasks, which then run one after another in its task. Its check runs after the last one.'));
    if ((board?.folders || []).length > 1) {
      const folder = node('select', 'board-input'); folder.setAttribute('aria-label', 'Folder the card works in'); folder.disabled = locked;
      folder.append(...[['', 'Choose a folder'], ...board.folders.map(item => [item.id, item.name])].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
      folder.value = draft.folderId || ''; folder.addEventListener('change', () => { draft.folderId = folder.value || null; changed(); });
      parts.push(labelled('Works in', folder));
    }
    // Waits for: the cards chosen, each with a way to take it off, and a menu of the other cards not yet done.
    const others = cards().filter(other => other.id !== card?.id && other.column !== 'done');
    if (others.length || draft.dependsOn.length) {
      const waits = node('div', 'board-waits');
      const drawWaits = () => {
        const chosen = draft.dependsOn.map(id => cardBy(id)).filter(Boolean), list = node('ul', 'board-wait-list');
        list.append(...chosen.map(other => {
          const row = node('li', 'board-wait'), name = node('span', 'board-wait-title', other.title); name.title = other.title;
          const remove = button('×', () => { draft.dependsOn = draft.dependsOn.filter(id => id !== other.id); drawWaits(); changed(); }, 'icon-button board-check-remove');
          remove.setAttribute('aria-label', `Stop waiting for “${other.title}”`); remove.disabled = locked;
          row.append(name, node('span', 'board-wait-column', COLUMNS.find(([id]) => id === other.column)[1]), remove); return row;
        }));
        const add = node('select', 'board-input'); add.setAttribute('aria-label', 'Add a card this one waits for'); add.disabled = locked;
        const left = others.filter(other => !draft.dependsOn.includes(other.id));
        add.append(...[['', left.length ? 'Add a card it waits for…' : 'No other cards to wait for'], ...left.map(other => [other.id, other.title])].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
        add.disabled = locked || !left.length;
        add.addEventListener('change', () => { if (!add.value) return; draft.dependsOn = [...draft.dependsOn, add.value]; drawWaits(); changed(); waits.querySelector('select')?.focus(); });
        waits.replaceChildren(...(chosen.length ? [list] : []), add);
      };
      drawWaits();
      parts.push(labelled('Waits for', waits, 'It runs only after these are done, or together with them.'));
    }
    // What a plan step had (#162): its group, role, what it produces, its check and its files. Folded away until used.
    const more = node('details', 'board-more'); more.open = moreOpen || Boolean(draft.group || draft.role !== 'builder' || draft.artifact || draft.check || draft.files);
    more.addEventListener('toggle', () => { moreOpen = more.open; });
    more.append(node('summary', '', 'Plan details'));
    const group = node('input', 'board-input'); group.value = draft.group; group.maxLength = board?.limits?.group || 60; group.placeholder = 'A phase, such as Build or QA'; group.setAttribute('aria-label', 'Group');
    const groups = node('datalist'); groups.id = 'board-group-options'; group.setAttribute('list', groups.id);
    groups.append(...allGroups().map(name => { const option = node('option'); option.value = name; return option; }));
    group.addEventListener('input', () => { draft.group = group.value; changed(); });
    const groupRow = node('div', 'board-group-edit'); groupRow.append(group, groups);
    const choose = (label, options, current, set) => { const pick = node('select', 'board-input'); pick.setAttribute('aria-label', label); pick.disabled = locked; pick.append(...options.map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; })); pick.value = current; pick.addEventListener('change', () => { set(pick.value); changed(); }); return pick; };
    const check = node('input', 'board-input'); check.value = draft.check; check.maxLength = 300; check.placeholder = 'A command that tests it, such as npm test'; check.setAttribute('aria-label', 'Acceptance check'); check.disabled = locked;
    check.addEventListener('input', () => { draft.check = check.value; changed(); });
    const files = node('input', 'board-input'); files.value = draft.files; files.placeholder = 'Files or folders it changes, separated by commas'; files.setAttribute('aria-label', 'Files it expects to change'); files.disabled = locked;
    files.addEventListener('input', () => { draft.files = files.value; changed(); });
    more.append(labelled('Group', groupRow, 'Cards in a group run and stop together from the Outline.'), labelled('Role', choose('Role', ROLES, draft.role, value => { draft.role = value; })), labelled('Produces', choose('What it produces', PRODUCES, draft.artifact || '', value => { draft.artifact = value || null; }), 'The cards after it are told this.'), labelled('Acceptance check', check, 'The agent is told this. The test command marked in Run is what tests the card.'), labelled('Files', files));
    parts.push(more);
    // Done means: what you'll check before accepting it. The agent is told these; ticking one isn't a change to the card.
    const checks = node('ul', 'board-checks');
    const drawChecks = () => checks.replaceChildren(...draft.checks.map((item, index) => {
      const row = node('li', 'board-check'), tick = node('input'); tick.type = 'checkbox'; tick.checked = item.done; tick.setAttribute('aria-label', `Done: ${item.text || 'check'}`);
      tick.addEventListener('change', () => { item.done = tick.checked; changed(); });
      const text = node('input', 'board-input'); text.value = item.text; text.maxLength = board?.limits?.check || 300; text.placeholder = 'Something you’ll check'; text.setAttribute('aria-label', `Check ${index + 1}`); text.disabled = locked;
      text.addEventListener('input', () => { item.text = text.value; changed(); });
      const remove = button('×', () => { draft.checks.splice(index, 1); drawChecks(); changed(); }, 'icon-button board-check-remove'); remove.setAttribute('aria-label', `Remove check ${index + 1}`); remove.disabled = locked;
      row.append(tick, text, remove); return row;
    }));
    drawChecks();
    const addCheck = button('Add a check', () => { draft.checks.push({ text: '', done: false }); drawChecks(); checks.lastElementChild?.querySelector('.board-input')?.focus(); changed(); }, 'text-link board-add-check'); addCheck.disabled = locked || draft.checks.length >= (board?.limits?.checks || 20);
    const checksField = labelled('Done means', checks); checksField.append(addCheck);
    parts.push(checksField);
    const save = button(selected === 'new' ? 'Add card' : 'Save', save$ , 'primary-button board-save');
    const revert = button('Revert', () => { draft = editable(cardBy(selected)); drawn = null; render(); }, 'text-link board-revert');
    const saving = node('div', 'board-save-row'); saving.append(revert, save);
    parts.push(saving);
    return parts;
  }
  function save$() {
    if (!draft?.title.trim()) return;
    const input = { title: draft.title, notes: draft.notes, priority: draft.priority, labels: draft.labels, due: draft.due, agent: draft.auto ? null : draft.agent, auto: draft.auto, folderId: draft.folderId, dependsOn: draft.dependsOn, checks: draft.checks.filter(item => item.text.trim()), group: draft.group.trim() || null, role: draft.role, artifact: draft.artifact, check: draft.check.trim() || null, files: fileList(draft.files), tier: draft.tier, closed: draft.closed === true, split: draft.split === true };
    if (selected === 'new') act('/api/board/cards', { ...input, column: draft.column, ...(draft.at ? { at: draft.at } : {}) }, result => { selected = result.card.id; draft = editable(result.card); drawn = null; api.announce(`Added “${result.card.title}” to ${COLUMNS.find(([id]) => id === result.card.column)[1]}.`); });
    else act(`/api/board/cards/${selected}/edit`, { ...input, revision: draft.revision }, result => { draft = editable(result.card); drawn = null; api.announce('Card saved.'); });
  }
  const openTask = card => { dialog.close(); window.relayTaskThreads?.select(card.taskState.id); };
  // What can be done with a card where it is now.
  function actions(card) {
    const row = node('div', 'board-actions'), state = stateOf(card);
    const move = (text, column) => button(text, () => act(`/api/board/cards/${card.id}/move`, { column }));
    const remove = button('Remove', () => { if (window.confirm(`Remove “${card.title}” from the board?`)) act(`/api/board/cards/${card.id}/remove`, {}, () => { selected = null; draft = null; api.announce('Card removed.'); }); }, 'text-link board-remove');
    // A draft (#162) is accepted or discarded; nothing else runs it.
    if (card.draft) {
      row.append(button(runnable({ ...card, draft: null }) ? 'Accept to Ready' : 'Accept', () => act('/api/board/drafts', { action: 'accept', ids: [card.id] }, () => api.announce(`“${card.title}” accepted.`)), 'primary-button'),
        button('Discard', () => act('/api/board/drafts', { action: 'discard', ids: [card.id] }, () => { selected = null; draft = null; api.announce('Draft discarded.'); }), 'text-link board-remove'));
      return row;
    }
    if (card.column === 'backlog') row.append(move('Move to Ready', 'ready'), remove);
    if (card.column === 'ready') {
      const pick = card.auto && !card.agent && !shut(card) ? autoPick(card) : null, why = shut(card) ? 'Closed to agents. Open it to agents to run it.' : !runnable(card) ? 'Choose an agent, or Auto, first.' : pick?.error ? pick.error : dirty() ? 'Save your changes first.' : '';
      const run = button('Run', () => { const chosen = assignments([card]); if (chosen.error) { failure = chosen.error; showError(); return; } const billing = billingFor([card], chosen.assignments); if (!billing) return; act('/api/board/run', { ids: [card.id], assignments: chosen.assignments, ...billing }, () => api.announce(`“${card.title}” is running as a task.`)); }, 'primary-button');
      run.disabled = Boolean(why); run.title = why || (pick ? `Run this card as its own task. ${pick.text}.` : 'Run this card as its own task.');
      row.append(run, scheduleButton(card), move('Move to Backlog', 'backlog'), remove);
    }
    if (card.column === 'doing') row.append(button('Open its task', () => openTask(card), 'primary-button'), button(card.taskState?.status === 'running' ? 'Stop' : 'Cancel', () => act(`/api/board/cards/${card.id}/stop`)));
    if (card.column === 'review') {
      const accept = button('Accept', () => act(`/api/board/cards/${card.id}/accept`, {}, () => api.announce(`“${card.title}” is done.`)), 'primary-button');
      if (card.taskState?.hasWorktree) { row.append(button('Review and merge', () => openTask(card), 'primary-button')); accept.className = 'secondary-button'; accept.disabled = true; accept.title = state?.detail || ''; }
      row.append(accept);
      // Its tests hold the cards after it (#162): check it again, or let them build on it anyway.
      const tests = card.taskState?.tests;
      if (card.taskState?.status === 'complete' && tests && tests !== 'running' && tests !== 'passed') row.append(button('Check again', () => act(`/api/board/cards/${card.id}/recheck`, {}, () => api.announce('Checking the card again.'))));
      if (card.taskState?.holds && tests !== 'running') row.append(button('Continue anyway', () => act(`/api/board/cards/${card.id}/continue`, {}, () => api.announce('The cards after it can start.'))));
      if (!card.taskState?.hasWorktree) row.append(button('Send back…', () => sendBack(card)));
      if (card.taskState) row.append(button('Open its task', () => openTask(card), 'text-link'));
    }
    if (card.column === 'done') row.append(move('Reopen', 'ready'), scheduleButton(card), remove);
    row.append(attachButton(card));
    return row;
  }
  function sendBack(card) {
    const reason = window.prompt('What should change? It goes back to Ready with this note. (Optional)', '');
    if (reason === null) return;
    act(`/api/board/cards/${card.id}/send-back`, { reason }, () => api.announce(`“${card.title}” is back in Ready.`));
  }
  // Where a card stands: why it's waiting or back, and what its last run did.
  function status(card) {
    const parts = [], state = stateOf(card);
    if (card.draft) {
      const by = card.draft.by?.kind === 'agent' ? [AGENT[card.draft.by.provider] || card.draft.by.provider, card.draft.by.model].filter(Boolean).join(' · ') : 'You';
      parts.push(node('p', 'board-status', `${by} drafted this card${card.source?.goal ? ' from your message' : ''}. Edit it, then accept or discard it. Nothing runs until you accept it.`));
      if (card.draft.notes?.length) { const list = node('ul', 'board-draft-notes'); list.setAttribute('aria-label', 'What the plan checks found'); list.append(...card.draft.notes.map(text => node('li', '', text))); parts.push(list); }
    }
    if (card.column === 'doing' && state) parts.push(node('p', 'board-status', state.detail ? `${state.text}: ${state.detail}` : state.text));
    if (card.column === 'ready' && card.reason) parts.push(node('p', 'board-status trouble', card.reason));
    if (card.result && ['review', 'done'].includes(card.column)) {
      const tests = card.result.tests, box = node('div', 'board-result'), facts = [card.result.files != null ? plural(card.result.files, 'file') + ' changed' : '', tests ? (TESTS[tests] || `tests ${tests}`).toLowerCase() + (card.result.testsAccepted ? ', continued anyway' : '') : 'no tests recorded', card.result.inCopy ? (card.result.status === 'complete' ? 'in its own copy, not merged yet' : OUTCOME[card.result.status]?.toLowerCase()) : ''].filter(Boolean);
      const line = facts.join(' · ');
      box.append(node('p', 'board-result-facts', line.charAt(0).toUpperCase() + line.slice(1)));
      if (card.result.summary) box.append(node('p', 'board-result-summary', card.result.summary));
      if (card.result.testsReason && tests !== 'passed') box.append(node('p', 'board-result-facts', card.result.testsReason));
      if (card.taskState?.testOutput && card.column === 'review') { const output = node('pre', 'plan-drawer-output', card.taskState.testOutput.trim().split('\n').slice(-20).join('\n')); output.setAttribute('aria-label', 'The end of the test output'); box.append(output); }
      parts.push(box);
    }
    if (card.column === 'done' && card.acceptedAt) parts.push(node('p', 'board-status done', `Accepted by you, ${when(card.acceptedAt)}.`));
    return parts;
  }
  function history(card) {
    if (!card.attempts?.length) return [];
    const list = node('ol', 'board-history');
    list.append(...[...card.attempts].reverse().map(item => node('li', '', `${AGENT[item.provider] || item.provider} · ${item.outcome ? OUTCOME[item.outcome] || item.outcome : 'Running'} · ${when(item.endedAt || item.startedAt)}`)));
    const box = node('details', 'board-history-box'); box.append(node('summary', '', `Runs (${card.attempts.length})`), list);
    return [box];
  }

  // ---- Subtasks (#155)
  // A major card's subtasks, in order, as they run: the agent and what it reported for each done, the one working now, and
  // the ones to come, which are yours to edit, remove, add to or pin to an agent. Pause stops the card after the subtask
  // it's on; Run then carries on from the next one. Split again clears them, so the next run splits the card afresh.
  const SUB_STATE = { pending: 'Waiting', running: 'Working', done: 'Done' };
  function subtasksPanel(card) {
    const list = card.subtasks || [];
    if (!list.length && !card.split) return [];
    if (subEdit && subEdit.cardId !== card.id) subEdit = null;
    const box = node('section', 'board-subtasks'), live = card.column === 'doing' && card.taskState?.status === 'running';
    box.setAttribute('aria-label', 'Subtasks');
    const done = list.filter(item => item.status === 'done').length;
    box.append(node('h4', 'board-field-label', list.length ? `Subtasks (${done} of ${list.length} done)` : 'Subtasks'));
    if (!list.length) box.append(node('p', 'board-field-note', card.splitting && live ? 'Splitting it into subtasks now, reading only.' : card.draft ? 'Once accepted, it is split into subtasks when it starts. You can also write them yourself.' : 'It is split into subtasks when it starts, against the code the cards before it produced. You can also write them yourself.'));
    const rows = node('ol', 'board-subtask-list');
    list.forEach((sub, index) => {
      const row = node('li', 'board-subtask'), head = node('div', 'board-subtask-head');
      // A subtask left running by a task that ended was stopped there; Run starts it again.
      const stateText = sub.status === 'running' && !live ? 'Stopped' : SUB_STATE[sub.status], state = node('span', 'board-subtask-state', stateText);
      state.dataset.tone = sub.status === 'done' ? 'done' : sub.status === 'running' ? (live ? 'running' : 'trouble') : '';
      head.append(node('span', 'board-subtask-number', `${index + 1}.`), node('span', 'board-subtask-title', sub.title), state);
      row.append(head);
      const who = sub.provider ? [AGENT[sub.provider] || sub.provider, sub.model].filter(Boolean).join(' · ') : sub.agent ? `${AGENT[sub.agent.provider]}, pinned` : null;
      const facts = [SIZES.find(([value]) => value === sub.tier)?.[1] || 'Standard', who, sub.by?.kind === 'you' ? 'Added by you' : ''].filter(Boolean).join(' · ');
      row.append(node('p', 'board-subtask-meta', facts));
      if (sub.status === 'done' && sub.summary) row.append(node('p', 'board-subtask-summary', sub.summary));
      if (subEdit?.id === sub.id) row.append(subtaskForm(card));
      else if (sub.status === 'pending' && !card.draft) {
        const tools$ = node('div', 'board-subtask-tools');
        const edit = button('Edit', () => { subEdit = { cardId: card.id, id: sub.id, title: sub.title, instructions: sub.instructions || '', tier: sub.tier, agent: sub.agent?.provider || '' }; drawn = null; renderDrawer(); $('board-drawer-body').querySelector('.board-subtask-form .board-input')?.focus(); }, 'text-link');
        const remove = button('Remove', () => act(`/api/board/cards/${card.id}/subtasks`, { action: 'remove', subtaskId: sub.id }, () => api.announce('Subtask removed.')), 'text-link board-remove');
        edit.setAttribute('aria-label', `Edit subtask ${index + 1}`); remove.setAttribute('aria-label', `Remove subtask ${index + 1}`); edit.disabled = remove.disabled = busy;
        tools$.append(edit, remove); row.append(tools$);
      }
      rows.append(row);
    });
    if (list.length) box.append(rows);
    if (subEdit?.id === 'new') box.append(subtaskForm(card));
    const foot = node('div', 'board-subtask-foot');
    if (!card.draft && !(card.splitting && live) && subEdit?.id !== 'new') { const add = button('Add a subtask', () => { subEdit = { cardId: card.id, id: 'new', title: '', instructions: '', tier: 'standard', agent: '' }; drawn = null; renderDrawer(); $('board-drawer-body').querySelector('.board-subtask-form .board-input')?.focus(); }, 'text-link'); add.disabled = busy; foot.append(add); }
    if (card.column === 'doing' && list.some(item => item.status === 'pending')) {
      const pause = button(card.subtasksPaused ? 'Don’t pause' : 'Pause after this subtask', () => act(`/api/board/cards/${card.id}/subtasks`, { action: card.subtasksPaused ? 'resume' : 'pause' }, () => api.announce(card.subtasksPaused ? 'It carries on after this subtask.' : 'It pauses after this subtask.')));
      pause.disabled = busy; foot.append(pause);
    }
    if (card.column !== 'doing' && list.length && !card.draft) { const again = button('Split again', () => { if (window.confirm('Clear these subtasks? The card is split afresh the next time it runs.')) act(`/api/board/cards/${card.id}/subtasks`, { action: 'clear' }, () => api.announce('Subtasks cleared.')); }, 'text-link'); again.disabled = busy; foot.append(again); }
    if (foot.children.length) box.append(foot);
    return [box];
  }
  function subtaskForm(card) {
    const form = node('div', 'board-subtask-form'), adding = subEdit.id === 'new';
    const title = node('input', 'board-input'); title.value = subEdit.title; title.maxLength = 200; title.placeholder = 'What this subtask does'; title.setAttribute('aria-label', 'Subtask title');
    const notes = node('textarea', 'board-input'); notes.value = subEdit.instructions; notes.rows = 3; notes.maxLength = 4000; notes.placeholder = 'Instructions, and how to know it’s done'; notes.setAttribute('aria-label', 'Subtask instructions');
    title.addEventListener('input', () => { subEdit.title = title.value; save.disabled = busy || !title.value.trim(); });
    notes.addEventListener('input', () => { subEdit.instructions = notes.value; });
    const who = node('select', 'board-input'); who.setAttribute('aria-label', 'Subtask agent');
    who.append(...[['', card.auto ? 'The card’s agent (Auto)' : 'The card’s agent'], ...AGENTS].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
    who.value = subEdit.agent; who.addEventListener('change', () => { subEdit.agent = who.value; });
    const row = node('div', 'board-subtask-form-row');
    row.append(segment('Subtask size', SIZES, subEdit.tier, value => { subEdit.tier = value; }, false), who);
    const cancel = button('Cancel', () => { subEdit = null; drawn = null; renderDrawer(); }, 'text-link');
    const save = button(adding ? 'Add' : 'Save', () => {
      const input = { title: subEdit.title, instructions: subEdit.instructions, tier: subEdit.tier, agent: subEdit.agent ? { provider: subEdit.agent } : null };
      act(`/api/board/cards/${card.id}/subtasks`, adding ? { action: 'add', ...input } : { action: 'edit', subtaskId: subEdit.id, ...input }, () => { subEdit = null; drawn = null; api.announce(adding ? 'Subtask added.' : 'Subtask saved.'); });
    }, 'secondary-button');
    save.disabled = busy || !subEdit.title.trim();
    const buttons = node('div', 'board-subtask-tools'); buttons.append(cancel, save);
    form.append(title, notes, row, buttons);
    form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); subEdit = null; drawn = null; renderDrawer(); } });
    return form;
  }

  // ---- Comments (#97)
  // Read when a card opens, and again only when its count changes. Each says who wrote it and when; the agent is told
  // yours the next time the card runs.
  const authorOf = by => by?.kind === 'agent' ? [AGENT[by.provider] || by.provider, by.model].filter(Boolean).join(' · ') || 'Agent' : by?.kind === 'guest' ? `${by.name || 'Guest'} (guest)` : 'You';
  async function readComments(id) {
    const count = cardBy(id)?.commentCount || 0;
    if (asked.get(id) === count) return; asked.set(id, count);
    if (!count) { threads.set(id, []); return; }
    try { const result = await api.api(`/api/board/cards/${id}/comments`); threads.set(id, result.comments || []); }
    catch (error) { asked.delete(id); failure = error.message; showError(); return; }
    if (selected === id) { drawn = null; renderDrawer(); }
  }
  function commentsPanel(card) {
    const box = node('section', 'board-comments'), list = node('ol', 'board-comment-list'), thread = threads.get(card.id);
    box.setAttribute('aria-label', 'Comments');
    box.append(node('h4', 'board-field-label', card.commentCount ? `Comments (${card.commentCount})` : 'Comments'));
    if (!thread && card.commentCount) list.append(node('li', 'board-comment-empty', 'Loading comments…'));
    for (const item of thread || []) {
      const row = node('li', 'board-comment'), head = node('div', 'board-comment-head'), stamp = node('time', 'board-comment-when', when(item.at));
      stamp.setAttribute('datetime', item.at);
      const remove = button('Remove', () => { if (window.confirm('Remove this comment? The agent won’t be told it any more.')) act(`/api/board/cards/${card.id}/uncomment`, { commentId: item.id }, result => took(card.id, result, 'Comment removed.')); }, 'text-link board-comment-remove');
      remove.setAttribute('aria-label', `Remove your comment from ${when(item.at)}`); remove.disabled = busy;
      head.append(node('span', 'board-comment-author', authorOf(item.by)), stamp, ...(item.by?.kind === 'you' ? [remove] : []));
      row.append(head, node('p', 'board-comment-text', item.text)); list.append(row);
    }
    if (list.children.length) box.append(list);
    const write = node('textarea', 'board-input board-comment-input'); write.rows = 2; write.maxLength = board?.limits?.comment || 4000;
    write.placeholder = 'Leave a comment'; write.setAttribute('aria-label', 'New comment'); write.value = said.get(card.id) || '';
    const send = button('Comment', () => postComment(card), 'secondary-button board-comment-send'); send.disabled = busy || !write.value.trim();
    write.addEventListener('input', () => { said.set(card.id, write.value); send.disabled = busy || !write.value.trim(); });
    write.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); postComment(card); } });
    const foot = node('div', 'board-comment-foot');
    foot.append(node('span', 'board-field-note', card.column === 'doing' ? 'The agent working now started without it. It’s told your comments the next time this card runs.' : 'The agent is told your comments when this card runs.'), send);
    box.append(write, foot);
    return [box];
  }
  // A comment changes what the agent is told, so it's a new revision of the card. A card you're editing keeps your
  // changes: its draft moves on to the new revision when that comment was the only difference.
  function took(id, result, said$) {
    threads.set(id, result.comments || []); asked.set(id, result.card?.commentCount ?? (result.comments || []).length);
    if (draft && selected === id && result.card && draft.revision === result.card.revision - 1) draft.revision = result.card.revision;
    drawn = null; api.announce(said$);
  }
  function postComment(card) {
    const text = (said.get(card.id) || '').trim();
    if (!text || busy) return;
    act(`/api/board/cards/${card.id}/comment`, { text }, result => { said.delete(card.id); took(card.id, result, 'Comment added.'); });
  }

  // Run Ready: the Ready cards with a box each. A card that waits for one that isn't done must run with it.
  function runPanel() {
    const ready = cards().filter(card => card.column === 'ready'), parts = [];
    if (!ready.length) { parts.push(node('p', 'board-note', 'Nothing is in Ready. Move cards there, with an agent or Auto each, to run them.')); return parts; }
    const blocked = card => !runnable(card) ? 'Choose an agent, or Auto, first.' : (card.auto && !card.agent && autoPick(card).error) || (card.dependsOn || []).map(cardBy).filter(item => item && item.column !== 'done' && !picked.has(item.id)).map(item => `Waits for “${item.title}”`)[0] || '';
    const list = node('ul', 'board-run-list');
    for (const card of ready) {
      const row = node('li', 'board-run-row'), label = node('label', 'board-run-label'), tick = node('input'); tick.type = 'checkbox';
      tick.checked = picked.has(card.id); tick.disabled = !runnable(card) || busy;
      tick.addEventListener('change', () => { if (tick.checked) picked.add(card.id); else picked.delete(card.id); drawn = null; render(); });
      const icon = node('i', `agent-icon ${card.agent?.provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
      const pick = card.auto && !card.agent ? autoPick(card) : null;
      if (pick && !pick.error) icon.className = `agent-icon ${pick.provider}`;
      label.append(tick, node('span', 'board-run-title', card.title), icon, node('span', 'board-run-agent', card.agent ? AGENT[card.agent.provider] : pick ? (pick.error ? 'Auto' : pick.text) : 'No agent'));
      const runsWith = card.agent?.provider || (pick && !pick.error ? pick.provider : null);
      if (bills(runsWith)) { const tag = node('span', 'board-card-billing', billsLabel(runsWith)); tag.title = billsSentence(runsWith); label.append(tag); }
      row.append(label);
      const why = picked.has(card.id) || !runnable(card) ? blocked(card) : '';
      if (why) { const note = node('span', 'board-run-why', why); row.append(note); row.dataset.blocked = 'true'; }
      list.append(row);
    }
    parts.push(list);
    const access = board.access, how = access.mode === 'read' ? 'read only' : access.approvalPolicy === 'auto' ? 'can edit files, and approves its own requests' : 'can edit files, and asks before anything that needs approval';
    parts.push(node('p', 'board-note', `Each card runs as its own task with its agent, using this workspace’s access: ${how}. A card that waits for another starts after it, once that one’s tests pass, and is told what it did. Tasks at once in the task limits decides how many run together. Nothing is pushed or published.`));
    const chosen = ready.filter(card => picked.has(card.id)), problem = chosen.map(blocked).find(Boolean);
    const run = button(chosen.length ? `Run ${plural(chosen.length, 'card')}` : 'Run', () => { const auto = assignments(chosen); if (auto.error) { failure = auto.error; showError(); return; } const billing = billingFor(chosen, auto.assignments); if (!billing) return; act('/api/board/run', { ids: chosen.map(card => card.id), assignments: auto.assignments, ...billing }, () => { api.announce(`${plural(chosen.length, 'card')} running as tasks.`); selected = null; }); }, 'primary-button');
    run.disabled = busy || !chosen.length || Boolean(problem); if (problem) run.title = problem;
    const row = node('div', 'board-save-row'); row.append(run); parts.push(row);
    return parts;
  }

  // ---- Schedules (#132)
  // A card or a prompt run at a set time, in the computer's local time, with the agent and the workspace's access saved
  // with it. The server keeps the time and starts the run; this only writes and shows them.
  const REPEAT = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week']];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const schedules = () => board?.schedules || [];
  const schedulesOf = card => schedules().filter(item => item.target.type === 'card' && item.target.cardId === card.id);
  const pad = value => String(value).padStart(2, '0');
  const localDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = time => { const [hour, minute] = time.split(':').map(Number); return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  function describe(time) {
    const at = clock(time.time);
    if (time.repeat === 'daily') return `Every day at ${at}`;
    if (time.repeat === 'weekdays') return `Weekdays at ${at}`;
    if (time.repeat === 'weekly') return `Every ${DAYS[time.weekday]} at ${at}`;
    const [year, month, day] = time.date.split('-').map(Number);
    return `Once, ${new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${at}`;
  }
  const how = access => access.mode === 'read' ? 'read only' : access.approvalPolicy === 'auto' ? 'can edit files, and approves its own requests' : 'can edit files, and asks before anything that needs approval';
  const LAST = { running: 'Working', waiting: 'Waiting to start' };
  function scheduleButton(card) {
    const value = button('Schedule…', () => newSchedule({ type: 'card', cardId: card.id }, card.id));
    value.disabled = shut(card) || !card.agent || dirty(); value.title = shut(card) ? 'Closed to agents. Open it to agents to schedule it.' : !card.agent ? 'Choose an agent first.' : dirty() ? 'Save your changes first.' : 'Run this card at a set time, once or on repeat.';
    return value;
  }
  // ---- Attaching (#97)
  // The Plan, or one card, goes into your next message as a text attachment: the message box shows its size, and opening
  // it shows exactly what the agent will read. Cards closed to agents are left out.
  function attachButton(card) {
    const value = button('Attach to message', () => attach(card.id), 'text-link board-attach');
    value.disabled = busy || shut(card) || dirty(); value.title = shut(card) ? 'Closed to agents.' : dirty() ? 'Save your changes first.' : 'Put this card in your next message, for the agent to read.';
    return value;
  }
  async function attach(cardId = null) {
    if (busy) return; busy = true; failure = ''; render();
    try {
      const result = await api.post('/api/board/attach', cardId ? { cardId } : {}), added = window.relayFiles?.attachSaved(result.attachment);
      const what = cardId ? `“${cardBy(cardId)?.title || 'The card'}”` : `The Plan (${plural(result.cards, 'card')})`;
      const said = `${what} is attached to your next message: ${added || 'a few KB'} of text.${result.leftOut ? ` ${plural(result.leftOut, 'card')} closed to agents ${result.leftOut === 1 ? 'is' : 'are'} left out.` : ''}`;
      busy = false; selected = null; draft = null; dialog.close();
      api.showNotice(said); api.announce(said);
      document.getElementById('message-input')?.focus();
    } catch (error) { failure = error.message; }
    finally { busy = false; if (dialog.open) render(); }
  }
  // ---- Closed to agents (#97), for the whole Plan
  function drawClosed() {
    const toggle = $('board-agents'), note = $('board-closed-note'), closed = board?.closed === true;
    if (toggle) { toggle.setAttribute('aria-pressed', String(closed)); toggle.disabled = busy || !board; $('board-agents-label').textContent = closed ? 'Closed to agents' : 'Open to agents'; toggle.title = closed ? 'Agents can’t read this Plan. Select to open it to agents.' : 'Agents can read this Plan when its cards run or are attached. Select to close it to agents.'; }
    if (note) note.hidden = !closed;
    const attach$ = $('board-attach');
    if (attach$) { const open = cards().filter(card => !shut(card)).length; attach$.disabled = busy || !open; attach$.title = closed ? 'This Plan is closed to agents.' : !cards().length ? 'The Plan has no cards yet.' : !open ? 'Every card is closed to agents.' : 'Put the Plan in your next message, for the agent to read. Cards closed to agents are left out.'; }
  }
  function setClosed(closed) {
    if (closed && !window.confirm('Close this Plan to agents?\n\nIts cards then can’t run, be scheduled or attached, and Export leaves them out unless you choose everything. A Plan attachment you already sent is left out of later prompts and handoffs.\n\nAn agent allowed to read anywhere on this computer could still find Codeshi’s own files.')) return;
    act('/api/board/access', { closed }, () => api.announce(closed ? 'The Plan is closed to agents.' : 'The Plan is open to agents.'));
  }
  function newSchedule(target, back) {
    if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    const soon = new Date(Date.now() + 3600000); soon.setMinutes(0, 0, 0);
    sdraft = { id: null, back, target, title: '', text: '', agent: null, folderId: null, when: { repeat: 'once', time: `${pad(soon.getHours())}:00`, date: localDate(soon), weekday: soon.getDay() }, runLate: false };
    selected = 'schedule'; draft = null; failure = ''; drawn = null; render();
    $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function editSchedule(item, back) {
    const today = new Date(), prompt = item.target.type === 'prompt';
    sdraft = { id: item.id, back, target: prompt ? { type: 'prompt' } : { type: 'card', cardId: item.target.cardId }, title: prompt ? item.title || '' : '', text: item.target.text || '', agent: item.target.agent ? { ...item.target.agent } : null, folderId: item.target.folderId || null, when: { date: localDate(today), weekday: today.getDay(), ...item.when }, runLate: item.runLate === true };
    selected = 'schedule'; draft = null; failure = ''; drawn = null; render();
    $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function leaveSchedule() { const back = sdraft?.back; sdraft = null; selected = back && (back === 'schedules' || cardBy(back)) ? back : 'schedules'; draft = cardBy(selected) ? editable(cardBy(selected)) : null; failure = ''; drawn = null; render(); }
  function scheduleRow(item, back) {
    const row = node('li', 'board-schedule'); row.dataset.state = item.missed ? 'missed' : item.paused ? 'paused' : item.waiting ? 'reset' : 'waiting';
    const head = node('div', 'board-schedule-head'), icon = node('i', `agent-icon ${item.agent?.provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
    head.append(icon, node('span', 'board-schedule-title', item.title), node('span', 'board-schedule-kind', item.target.type === 'card' ? 'Card' : 'Prompt'));
    row.append(head, node('p', 'board-schedule-when', `${describe(item.when)} · ${item.paused ? 'Paused' : item.nextAt ? `next ${when(item.nextAt)}` : 'nothing left to run'}`));
    if (item.missed) row.append(node('p', 'board-status trouble', `The run for ${when(item.missed.dueAt)} didn’t start. ${item.missed.reason}`));
    else if (item.waiting) { const agent = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' }[item.waiting.provider] || 'Its agent'; row.append(node('p', 'board-status', `The run for ${when(item.waiting.dueAt)} is waiting: ${agent} is at its usage limit${item.waiting.resetsAt ? ` until ${when(item.waiting.resetsAt)}` : ''}. It starts on ${agent} once there’s room${item.runLate ? '' : ', if that’s within ten minutes of its time'}.`)); }
    else if (item.changed) row.append(node('p', 'board-status', 'The card changed after it was scheduled, so it won’t run on its own. Run it now, or save the schedule again.'));
    if (item.last) row.append(node('p', 'board-schedule-last', `Last run ${when(item.last.at)}${item.last.manual ? ', started by you' : ''}${item.last.status ? ` · ${LAST[item.last.status] || OUTCOME[item.last.status] || item.last.status}` : ''}`));
    const actions = node('div', 'board-schedule-actions');
    actions.append(button('Run now', () => act(`/api/board/schedules/${item.id}/run`, {}, () => api.announce(`“${item.title}” is running as a task.`)), item.missed ? 'primary-button' : 'secondary-button'));
    if (item.missed) actions.append(button('Dismiss', () => act(`/api/board/schedules/${item.id}/dismiss`)));
    actions.append(button('Edit', () => editSchedule(item, back)));
    if (item.nextAt || item.waiting || item.paused) actions.append(button(item.paused ? 'Resume' : 'Pause', () => act(`/api/board/schedules/${item.id}/${item.paused ? 'resume' : 'pause'}`, {}, () => api.announce(item.paused ? 'Schedule resumed.' : 'Schedule paused.'))));
    actions.append(button('Remove', () => { if (window.confirm(`Remove the schedule for “${item.title}”?`)) act(`/api/board/schedules/${item.id}/remove`, {}, () => api.announce('Schedule removed.')); }, 'text-link board-remove'));
    row.append(actions);
    return row;
  }
  function cardSchedules(card) {
    const own = schedulesOf(card);
    if (!own.length) return [];
    const list = node('ul', 'board-schedules'); list.setAttribute('aria-label', 'Schedules for this card'); list.append(...own.map(item => scheduleRow(item, card.id)));
    return [list];
  }
  function schedulesPanel() {
    const parts = [node('p', 'board-note', 'Run a card or a prompt at a set time, once or on repeat, with its agent and this workspace’s access saved with it. Schedules run while Codeshi is open and the computer is awake; while one is waiting, closing the window leaves Codeshi in the menu bar.')];
    if (schedules().length) { const list = node('ul', 'board-schedules'); list.append(...schedules().map(item => scheduleRow(item, 'schedules'))); parts.push(list); }
    else parts.push(node('p', 'board-note', 'Nothing is scheduled. Open a Ready card and choose Schedule…, or schedule a prompt.'));
    const row = node('div', 'board-save-row'); row.append(button('Schedule a prompt…', () => newSchedule({ type: 'prompt' }, 'schedules'), 'primary-button')); parts.push(row);
    return parts;
  }
  function scheduleForm() {
    const plan = sdraft, parts = [], card = plan.target.type === 'card' ? cardBy(plan.target.cardId) : null;
    if (plan.target.type === 'card' && !card) { parts.push(node('p', 'board-note', 'That card is no longer on the board.')); return parts; }
    // A schedule runs with no one there to ask about charges (#108), so an agent that bills by use won't start from one.
    const unasked = provider => bills(provider) ? `${billsSentence(provider)} A schedule can’t ask you before it runs, so its runs won’t start with ${AGENT[provider]}. Choose an agent on a subscription.` : '';
    if (card) { parts.push(node('p', 'board-status', `Runs “${card.title}” with ${card.agent ? AGENT[card.agent.provider] : 'its agent'}, as the card says when you save. A card that repeats runs again from Ready or Done; if it’s still in Doing or Review, that time is skipped and shown here.`)); const warn = unasked(card.agent?.provider); if (warn) parts.push(node('p', 'board-note board-billing-note', warn)); }
    else {
      const title = node('input', 'board-input'); title.value = plan.title; title.maxLength = 200; title.placeholder = 'Name (optional)'; title.setAttribute('aria-label', 'Schedule name');
      title.addEventListener('input', () => { plan.title = title.value; });
      const text = node('textarea', 'board-input board-field-notes'); text.value = plan.text; text.rows = 5; text.maxLength = 20000; text.placeholder = 'What the agent should do each time'; text.setAttribute('aria-label', 'Prompt');
      text.addEventListener('input', () => { plan.text = text.value; });
      parts.push(title, text);
      const agentNote = () => ['Runs with this agent’s default model and effort.', unasked(plan.agent?.provider)].filter(Boolean).join(' ');
      const agentField = labelled('Agent', segment('Agent', AGENTS.map(([value, name]) => [value, name, `agent-icon ${value}`]), plan.agent?.provider || null, value => { plan.agent = { provider: value, model: null, effort: null }; agentField.querySelector('.board-field-note').textContent = agentNote(); }, false), agentNote());
      parts.push(agentField);
      if ((board?.folders || []).length > 1) {
        const folder = node('select', 'board-input'); folder.setAttribute('aria-label', 'Folder it works in');
        folder.append(...[['', 'Choose a folder'], ...board.folders.map(item => [item.id, item.name])].map(([value, name]) => { const option = node('option', '', name); option.value = value; return option; }));
        folder.value = plan.folderId || ''; folder.addEventListener('change', () => { plan.folderId = folder.value || null; });
        parts.push(labelled('Works in', folder));
      }
    }
    parts.push(labelled('Repeat', segment('Repeat', REPEAT, plan.when.repeat, value => { plan.when.repeat = value; drawn = null; render(); $('board-drawer-body').querySelector('.board-segment[aria-label="Repeat"] [aria-pressed="true"]')?.focus(); }, false)));
    const at = node('div', 'board-schedule-at');
    if (plan.when.repeat === 'once') { const date = node('input', 'board-input'); date.type = 'date'; date.value = plan.when.date; date.min = localDate(new Date()); date.setAttribute('aria-label', 'Date'); date.addEventListener('input', () => { plan.when.date = date.value; }); at.append(date); }
    if (plan.when.repeat === 'weekly') {
      const day = node('select', 'board-input'); day.setAttribute('aria-label', 'Day of the week');
      day.append(...DAYS.map((name, index) => { const option = node('option', '', name); option.value = String(index); return option; }));
      day.value = String(plan.when.weekday); day.addEventListener('change', () => { plan.when.weekday = Number(day.value); }); at.append(day);
    }
    const time = node('input', 'board-input'); time.type = 'time'; time.value = plan.when.time; time.setAttribute('aria-label', 'Time'); time.addEventListener('input', () => { plan.when.time = time.value; }); at.append(time);
    parts.push(labelled(plan.when.repeat === 'once' ? 'On' : 'At', at, 'In this computer’s time.'));
    const late = node('label', 'board-schedule-late'), box = node('input'); box.type = 'checkbox'; box.checked = plan.runLate;
    box.addEventListener('change', () => { plan.runLate = box.checked; });
    late.append(box, node('span', '', 'Run late if Codeshi was closed, the computer was asleep or the agent was at its usage limit at that time. Otherwise a missed time waits for you.'));
    parts.push(late);
    parts.push(node('p', 'board-note', `It runs as its own task with this workspace’s access as it is now: ${how(board.access)}. Changing the workspace later doesn’t change it; saving the schedule again does.${card ? ' If the card is edited, it waits for you instead of running.' : ''} The agent is told not to push, deploy or publish anything.`));
    const save = button(plan.id ? 'Save schedule' : 'Schedule', saveSchedule, 'primary-button board-schedule-save'); save.disabled = busy;
    const row = node('div', 'board-save-row'); row.append(button('Cancel', leaveSchedule, 'text-link'), save); parts.push(row);
    return parts;
  }
  function saveSchedule() {
    const plan = sdraft; if (!plan) return;
    const time = { repeat: plan.when.repeat, time: plan.when.time, ...(plan.when.repeat === 'once' ? { date: plan.when.date } : {}), ...(plan.when.repeat === 'weekly' ? { weekday: Number(plan.when.weekday) } : {}) };
    const target = plan.target.type === 'card' ? plan.target : { type: 'prompt', text: plan.text, agent: plan.agent, folderId: plan.folderId };
    act(plan.id ? `/api/board/schedules/${plan.id}/edit` : '/api/board/schedules', { target, when: time, runLate: plan.runLate, ...(target.type === 'prompt' ? { title: plan.title } : {}) }, result => { api.announce(`Scheduled: ${describe(result.schedule.when)}.`); leaveSchedule(); });
  }

  function renderDrawer() {
    const aside = $('board-drawer'), body = $('board-drawer-body');
    if (!selected || (!['new', 'run', 'schedules', 'schedule'].includes(selected) && !cardBy(selected))) { aside.hidden = true; body.replaceChildren(); drawn = null; if (selected && !cardBy(selected)) { selected = null; draft = null; } return; }
    aside.hidden = false;
    const card = cardBy(selected);
    // An untouched draft follows the card when it changes elsewhere; one you're editing waits for Save.
    if (card && draft && !dirty() && draft.revision !== card.revision) draft = editable(card);
    // A schedule being written is drawn again only when its kind of time changes, so typing keeps its place.
    if (card) readComments(card.id);
    const key = JSON.stringify([selected, card && [card.column, card.revision, card.reason, card.taskState, card.result, card.acceptedAt, card.attempts?.length, card.priority, card.labels, card.due, card.checks, card.commentCount, card.draft, card.auto, card.group, card.split, card.subtasks, card.splitting, card.subtasksPaused, subEdit?.cardId === card.id ? [subEdit.id, subEdit.tier, subEdit.agent] : null, threads.get(card.id)?.length ?? null, schedulesOf(card)], selected === 'run' ? [...picked] : null, selected === 'run' ? cards().map(item => [item.id, item.column, item.agent?.provider, item.dependsOn]) : null, selected === 'schedules' ? schedules() : null, selected === 'schedule' ? [sdraft?.id, sdraft?.when.repeat, sdraft?.target] : null, busy]);
    if (key === drawn) { changed(); return; }
    drawn = key;
    if (selected === 'run') { $('board-drawer-title').textContent = 'Run Ready cards'; body.replaceChildren(...runPanel()); return; }
    if (selected === 'schedules') { $('board-drawer-title').textContent = 'Schedules'; body.replaceChildren(...schedulesPanel()); return; }
    if (selected === 'schedule') { if (!sdraft) { selected = 'schedules'; drawn = null; renderDrawer(); return; } $('board-drawer-title').textContent = sdraft.id ? 'Edit schedule' : 'New schedule'; body.replaceChildren(...scheduleForm()); return; }
    $('board-drawer-title').textContent = selected === 'new' ? `New card · ${COLUMNS.find(([id]) => id === draft.column)[1]}` : `${card.draft ? 'Draft' : COLUMNS.find(([id]) => id === card.column)[1]}${card.agent ? ` · ${AGENT[card.agent.provider]}` : card.auto ? ' · Auto' : ''}`;
    // Someone writing a comment keeps their place when the drawer is drawn again.
    const writing = ['board-comment-input', 'board-comment-send'].some(name => document.activeElement?.classList?.contains(name)) && body.contains(document.activeElement);
    body.replaceChildren(...(card ? [...status(card), actions(card), ...subtasksPanel(card), ...cardSchedules(card)] : []), ...editor(card), ...(card ? [...commentsPanel(card), ...history(card)] : []));
    if (writing) { const box = body.querySelector('.board-comment-input'); box?.focus(); box?.setSelectionRange?.(box.value.length, box.value.length); }
    changed();
  }
  function showError() { $('board-error').textContent = failure; $('board-error').hidden = !failure; }

  // ---- Drafts (#162)
  // A banner for each plan an agent drafted: who drafted it, its summary, the questions it couldn't answer, and Accept all
  // or Discard all. Each card can also be opened, edited and accepted on its own.
  function drawDrafts() {
    const box = $('board-drafts'); if (!box) return;
    const batches = new Map();
    for (const card of cards().filter(item => item.draft)) { const id = card.draft.batch?.id || 'own'; if (!batches.has(id)) batches.set(id, []); batches.get(id).push(card); }
    const key = JSON.stringify([...batches].map(([id, list]) => [id, list.map(card => [card.id, card.draft.notes?.length || 0])]).concat([busy]));
    box.hidden = !batches.size;
    if (box.dataset.drawn === key) return;
    box.dataset.drawn = key;
    box.replaceChildren(...[...batches].map(([, list]) => {
      const first = list[0], batch = first.draft.batch || {}, by = first.draft.by?.kind === 'agent' ? AGENT[first.draft.by.provider] || first.draft.by.provider : 'You';
      const row = node('section', 'board-draft-batch'), text = node('div', 'board-draft-text');
      row.setAttribute('aria-label', `Drafted cards from ${by}`);
      text.append(node('p', 'board-draft-lead', `${by} drafted ${plural(list.length, 'card')}${batch.summary ? `: ${batch.summary}` : '.'}`));
      if (batch.documents?.length) text.append(node('p', 'board-draft-note board-draft-documents', `Planned from ${listNames(batch.documents)}.`));
      const noted = list.filter(card => card.draft.notes?.length).length;
      text.append(node('p', 'board-draft-note', `Nothing runs until you accept it. Open a card to edit it first.${noted ? ` The plan checks noted something on ${plural(noted, 'card')}.` : ''}`));
      if (batch.questions?.length) { const asks = node('ul', 'board-draft-questions'); asks.setAttribute('aria-label', 'Questions from the planner'); asks.append(...batch.questions.map(question => node('li', '', question))); text.append(node('p', 'board-draft-note', 'It asks:'), asks); }
      const ids = list.map(card => card.id), actions$ = node('div', 'board-draft-actions');
      const accept = button(`Accept ${list.length === 1 ? '' : 'all '}${plural(list.length, 'card')}`, () => act('/api/board/drafts', { action: 'accept', ids }, () => api.announce(`${plural(list.length, 'card')} accepted.`)), 'primary-button');
      const discard = button('Discard', () => { if (window.confirm(`Discard ${plural(list.length, 'drafted card')}?`)) act('/api/board/drafts', { action: 'discard', ids }, () => { if (ids.includes(selected)) { selected = null; draft = null; } api.announce('Drafts discarded.'); }); }, 'secondary-button');
      accept.disabled = discard.disabled = busy;
      actions$.append(discard, accept);
      row.append(text, actions$);
      return row;
    }));
  }
  // An Orchestrate plan from before the Plan held its cards, still running or stopped, stays where it was (plan-view.js).
  function drawEarlier() {
    const note = $('board-earlier'); if (!note) return;
    const plan = api.getState().conversation?.orchestrations?.[0], open = plan && ['running', 'stopped'].includes(plan.status);
    note.hidden = !open;
  }

  // ---- The outline (#162)
  // The same cards as a list, by group in the order groups were first used, each group's cards in the order they can run.
  // A group heading says how far it has got, and runs or stops the group. It's the view for the keyboard, screen readers
  // and narrow windows.
  function ordered(list) {
    const own = new Map(list.map(card => [card.id, card])), depth = new Map();
    const deep = (id, trail = new Set()) => { if (depth.has(id)) return depth.get(id); if (trail.has(id)) return 0; trail.add(id); const value = Math.max(-1, ...(own.get(id).dependsOn || []).filter(other => own.has(other)).map(other => deep(other, trail))) + 1; depth.set(id, value); return value; };
    return [...list].sort((a, b) => deep(a.id) - deep(b.id) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.order - b.order);
  }
  function groupsOf(list) {
    const out = new Map();
    for (const card of ordered(list)) { const name = card.group || NO_GROUP; if (!out.has(name)) out.set(name, []); out.get(name).push(card); }
    // Cards in no group come last, after the groups.
    if (out.has(NO_GROUP) && out.size > 1) { const loose = out.get(NO_GROUP); out.delete(NO_GROUP); out.set(NO_GROUP, loose); }
    return out;
  }
  function drawOutline() {
    const list = $('board-outline'), all = cards();
    if (!all.length) { list.replaceChildren(node('li', 'board-column-empty', 'No cards yet. Add one with New card, or turn on Orchestrate in the message box to have an agent draft a plan.')); return; }
    list.replaceChildren(...[...groupsOf(all)].map(([name, own]) => {
      const item = node('li', 'board-outline-group'), head = node('div', 'board-outline-head'), rows = node('ol', 'board-outline-cards');
      const done = own.filter(card => card.column === 'done').length, doing = own.filter(card => card.column === 'doing'), ready = own.filter(card => card.column === 'ready' && runnable(card));
      head.append(node('h3', 'board-outline-name', name), node('span', 'board-outline-progress', `${done} of ${plural(own.length, 'card')} done`));
      if (ready.length) { const run = button(`Run ${plural(ready.length, 'Ready card')}…`, () => openRun(name), 'secondary-button'); run.setAttribute('aria-label', `Run the Ready cards in ${name}`); head.append(run); }
      if (doing.length) { const stop = button('Stop', () => { if (window.confirm(`Stop ${plural(doing.length, 'running card')} in ${name}?`)) act('/api/board/stop', { ids: doing.map(card => card.id) }, () => api.announce(`Stopped ${name}.`)); }, 'secondary-button'); stop.setAttribute('aria-label', `Stop the running cards in ${name}`); head.append(stop); }
      rows.append(...own.filter(shown).map(card => {
        const row = node('li'), face = node('button', 'board-outline-card'), state = stateOf(card); face.type = 'button';
        face.dataset.card = card.id; face.dataset.column = card.column; face.setAttribute('aria-pressed', String(selected === card.id));
        const after = (card.dependsOn || []).map(cardBy).filter(Boolean).map(other => `“${other.title}”`);
        const agent = card.taskState?.provider ? AGENT[card.taskState.provider] : card.agent ? AGENT[card.agent.provider] : card.auto ? 'Auto' : 'No agent yet';
        face.append(node('span', 'board-outline-title', card.title), node('span', 'board-outline-meta', [card.draft ? 'Draft' : COLUMNS.find(([id]) => id === card.column)[1], card.role !== 'builder' ? ROLE[card.role] : '', agent, card.closed && !board?.closed ? 'Closed to agents' : '', state && !card.draft ? state.text : '', after.length ? `after ${listed(after)}` : ''].filter(Boolean).join(' · ')));
        if (state?.tone) face.dataset.tone = state.tone;
        face.addEventListener('click', () => select(card.id));
        row.append(face); return row;
      }));
      item.append(head, rows); return item;
    }));
  }

  // ---- The canvas (#97)
  // A world of cards at their saved places, moved and scaled as one by the camera: screen = world × zoom + offset. A card
  // nobody has placed yet is laid out by what it waits for, below the placed ones, and stays there until it's dragged.
  const SVG = 'http://www.w3.org/2000/svg', WIDTH = 220, FALLBACK = 88, STEP_X = 290, GAP_Y = 22, ZOOM = [0.25, 2];
  const frame = fn => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : fn());
  // camera: { x, y, z }, null until the canvas is first shown, when it fits the cards. heights: each card's last measured
  // height. gesture: a drag, a pan or a new arrow in progress. picked: the arrow chosen, as [from, to]. moved: the card
  // just dragged, whose click that ends the drag isn't a selection. undos and redos: what Undo and Redo do, newest last.
  let camera = null, heights = new Map(), gesture = null, picked$ = null, moved = null, stale = false, undos = [], redos = [];
  const space = $('board-space');
  const svg = tag => document.createElementNS ? document.createElementNS(SVG, tag) : document.createElement(tag);
  const height = id => heights.get(id) || FALLBACK;
  const title = id => `“${cardBy(id)?.title || 'a card'}”`;

  // How deep each card sits in its chain of waits, among the given cards only.
  function layout(list, top, left) {
    const own = new Map(list.map(card => [card.id, card])), depth = new Map(), rows = new Map(), out = new Map();
    const deep = (id, trail) => {
      if (depth.has(id)) return depth.get(id);
      if (trail.has(id)) return 0; trail.add(id);
      const value = Math.max(-1, ...(own.get(id).dependsOn || []).filter(other => own.has(other)).map(other => deep(other, trail))) + 1;
      depth.set(id, value); return value;
    };
    // Cards in a chain stand in a column per step of it; cards with no arrows at all fill a grid below, so a board of
    // unconnected cards doesn't become one long column.
    const linked = new Set(list.flatMap(card => { const waits = (card.dependsOn || []).filter(id => own.has(id)); return waits.length ? [card.id, ...waits] : []; }));
    const chained = list.filter(card => linked.has(card.id)), single = list.filter(card => !linked.has(card.id));
    for (const card of chained) {
      const level = deep(card.id, new Set()), y = rows.get(level) ?? top;
      out.set(card.id, { x: left + level * STEP_X, y }); rows.set(level, y + height(card.id) + GAP_Y);
    }
    const across = Math.max(4, rows.size), start = chained.length ? Math.max(...rows.values()) + 60 : top;
    let y = start;
    for (let first = 0; first < single.length; first += across) {
      const line = single.slice(first, first + across);
      line.forEach((card, index) => out.set(card.id, { x: left + index * (WIDTH + 30), y }));
      y += Math.max(...line.map(card => height(card.id))) + GAP_Y;
    }
    return out;
  }
  function places() {
    const all = cards(), placed = all.filter(card => card.at), out = new Map(placed.map(card => [card.id, { x: card.at.x, y: card.at.y }]));
    const loose = all.filter(card => !card.at);
    if (loose.length) {
      const top = placed.length ? Math.max(...placed.map(card => card.at.y + height(card.id))) + 80 : 0, left = placed.length ? Math.min(...placed.map(card => card.at.x)) : 0;
      for (const [id, at] of layout(loose, top, left)) out.set(id, at);
    }
    if (gesture?.kind === 'move') out.set(gesture.id, gesture.at);
    return out;
  }
  const toWorld = (event, rect = space.getBoundingClientRect()) => ({ x: (event.clientX - rect.left - camera.x) / camera.z, y: (event.clientY - rect.top - camera.y) / camera.z });
  const cardAt = (point, at, skip) => [...cards()].reverse().find(card => { const p = at.get(card.id); return card.id !== skip && p && point.x >= p.x && point.x <= p.x + WIDTH && point.y >= p.y && point.y <= p.y + height(card.id); });

  function aim() {
    const world = space.querySelector('.board-world'); if (!world || !camera) return;
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`;
    const zoom = space.querySelector('.board-zoom-level'); if (zoom) zoom.textContent = `${Math.round(camera.z * 100)}%`;
    space.style.backgroundSize = `${18 * camera.z}px ${18 * camera.z}px`; space.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
  }
  function fit() {
    const rect = space.getBoundingClientRect(), at = places(), all = cards();
    if (!all.length || !rect.width) { camera = { x: 40, y: 40, z: 1 }; aim(); return; }
    const xs = all.map(card => at.get(card.id).x), ys = all.map(card => at.get(card.id).y);
    const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs) + WIDTH, bottom = Math.max(...all.map(card => at.get(card.id).y + height(card.id)));
    const z = Math.max(ZOOM[0], Math.min(1, (rect.width - 80) / (right - left), (rect.height - 120) / (bottom - top)));
    camera = { x: (rect.width - (right - left) * z) / 2 - left * z, y: Math.max(40, (rect.height - 60 - (bottom - top) * z) / 2) - top * z, z };
    aim();
  }
  function zoom(factor, around = null) {
    const rect = space.getBoundingClientRect(), point = around || { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const z = Math.max(ZOOM[0], Math.min(ZOOM[1], camera.z * factor)), sx = point.clientX - rect.left, sy = point.clientY - rect.top;
    camera = { x: sx - (sx - camera.x) * z / camera.z, y: sy - (sy - camera.y) * z / camera.z, z };
    aim();
    if (picked$) drawLinks();
  }

  // An arrow from the card waited for to the card that waits, leaving one's right edge and entering the other's left.
  function curve(from, to, fromHeight, toHeight) {
    const x0 = from.x + WIDTH, y0 = from.y + fromHeight / 2, x3 = to.x, y3 = to.y + toHeight / 2, bend = Math.max(40, Math.abs(x3 - x0) / 2);
    return { d: `M${x0} ${y0} C${x0 + bend} ${y0} ${x3 - bend} ${y3} ${x3} ${y3}`, mid: { x: (x0 + x3) / 2, y: (y0 + y3) / 2 } };
  }
  function links() {
    const out = [];
    for (const card of cards()) for (const from of card.dependsOn || []) if (cardBy(from)) out.push([from, card.id]);
    return out;
  }
  function drawLinks(at = places()) {
    const layer = space.querySelector('.board-links'); if (!layer) return;
    const head = svg('marker'); head.setAttribute('id', 'board-link-head'); head.setAttribute('viewBox', '0 0 8 8'); head.setAttribute('refX', '7'); head.setAttribute('refY', '4');
    head.setAttribute('markerWidth', '8'); head.setAttribute('markerHeight', '8'); head.setAttribute('orient', 'auto-start-reverse');
    const tip = svg('path'); tip.setAttribute('d', 'M0 0L8 4L0 8z'); head.append(tip);
    const defs = svg('defs'); defs.append(head);
    const drawn$ = [defs];
    for (const [from, to] of links()) {
      const line = curve(at.get(from), at.get(to), height(from), height(to)), done = cardBy(from).column === 'done';
      const chosen = picked$ && picked$[0] === from && picked$[1] === to, related = selected === from || selected === to;
      const path = svg('path'); path.setAttribute('d', line.d); path.setAttribute('marker-end', 'url(#board-link-head)'); path.dataset.from = from; path.dataset.to = to;
      path.setAttribute('class', `board-link${done ? ' done' : ''}${related ? ' related' : ''}${chosen ? ' picked' : ''}${filter && !(shown(cardBy(from)) && shown(cardBy(to))) ? ' faded' : ''}`);
      // A wider, invisible line over it is what the pointer catches.
      const hit = svg('path'); hit.setAttribute('d', line.d); hit.setAttribute('class', 'board-link-hit'); hit.dataset.from = from; hit.dataset.to = to;
      const tooltip = svg('title'); tooltip.textContent = `${title(to)} waits for ${title(from)}`; hit.append(tooltip);
      hit.addEventListener('pointerdown', event => { event.stopPropagation?.(); });
      hit.addEventListener('click', event => { event.stopPropagation?.(); picked$ = chosen ? null : [from, to]; drawLinks(); });
      drawn$.push(path, hit);
    }
    // An arrow being drawn is its own line (startLink), kept across a redraw.
    const drafting = gesture?.kind === 'link' ? [...layer.children].filter(line => line.getAttribute?.('class')?.includes('drafting')) : [];
    layer.replaceChildren(...drawn$, ...drafting);
    // The chosen arrow gets a button at its middle to take it away.
    space.querySelector('.board-link-remove')?.remove();
    if (picked$ && cardBy(picked$[0]) && cardBy(picked$[1])?.dependsOn?.includes(picked$[0])) {
      const [from, to] = picked$, mid = curve(at.get(from), at.get(to), height(from), height(to)).mid;
      const remove = button('×', () => disconnect(from, to), 'icon-button board-link-remove');
      remove.setAttribute('aria-label', `Stop ${title(to)} waiting for ${title(from)}`); remove.title = `Stop ${title(to)} waiting for ${title(from)} (Delete)`;
      // Kept the same size at any zoom, so it's always easy to hit.
      remove.style.transform = `translate(${mid.x}px, ${mid.y}px) scale(${1 / (camera?.z || 1)}) translate(-50%, -50%)`;
      space.querySelector('.board-world').append(remove);
    } else picked$ = null;
  }

  // Each group's area: around its cards, with its name above them. Drawn again when cards move or change size.
  function drawGroups(at = places()) {
    const layer = space.querySelector('.board-groups'); if (!layer) return;
    const areas = [];
    for (const [name, own] of groupsOf(cards())) {
      if (name === NO_GROUP) continue;
      const boxes = own.map(card => ({ at: at.get(card.id), h: height(card.id) })).filter(item => item.at);
      if (!boxes.length) continue;
      const left = Math.min(...boxes.map(item => item.at.x)) - 16, top = Math.min(...boxes.map(item => item.at.y)) - 34, right = Math.max(...boxes.map(item => item.at.x)) + WIDTH + 16, bottom = Math.max(...boxes.map(item => item.at.y + item.h)) + 16;
      const area = node('div', 'board-group-area'); area.style.transform = `translate(${left}px, ${top}px)`; area.style.width = `${right - left}px`; area.style.height = `${bottom - top}px`;
      area.append(node('span', 'board-group-name', name)); areas.push(area);
    }
    layer.replaceChildren(...areas);
  }
  function tools() {
    const bar = node('div', 'board-canvas-tools'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Canvas');
    const tool = (text, label, handler, cls = '') => { const value = button(text, handler, `board-tool ${cls}`.trim()); value.setAttribute('aria-label', label); value.title = label; return value; };
    const undo = tool('Undo', `Undo${undos.length ? `: ${undos.at(-1).label}` : ''} (⌘Z)`, () => step(undos, redos)), redo = tool('Redo', `Redo${redos.length ? `: ${redos.at(-1).label}` : ''} (⇧⌘Z)`, () => step(redos, undos));
    undo.disabled = !undos.length; redo.disabled = !redos.length;
    const level = tool('100%', 'Zoom to 100%', () => { zoom(1 / camera.z); }, 'board-zoom-level');
    bar.append(undo, redo, node('span', 'board-tool-gap'), tool('−', 'Zoom out', () => zoom(1 / 1.2)), level, tool('+', 'Zoom in', () => zoom(1.2)), tool('Fit', 'Fit the cards in view', fit), node('span', 'board-tool-gap'), tool('Arrange', 'Lay every card out by what it waits for', arrange));
    return bar;
  }
  // A card on the canvas is built again only when something it shows changes; the rest keep their elements, so a board of
  // a few hundred cards redraws in a few milliseconds when one changes (#97). Its place isn't part of this: it's only where
  // the element is moved to.
  let world$ = null, built = new Map();
  const nodeKey = card => JSON.stringify([{ ...card, at: undefined }, selected === card.id, filter, schedulesOf(card), (card.dependsOn || []).map(id => { const other = cardBy(id); return other ? [other.title, other.column] : null; }), today()]);
  function canvasNode(card) {
    // A card without the chosen label stays in its place, faded, so the arrows around it still make sense.
    const item = node('div', `board-node${shown(card) ? '' : ' faded'}`); item.dataset.card = card.id;
    const face = cardButton(card, true);
    face.addEventListener('pointerdown', event => startMove(event, card.id));
    face.addEventListener('keydown', event => nudge(event, card.id));
    face.setAttribute('aria-describedby', 'board-canvas-keys');
    // The dot on the right edge starts an arrow to a card that will wait for this one.
    const port = node('span', 'board-port'); port.setAttribute('aria-hidden', 'true'); port.title = 'Drag to a card that should wait for this one';
    port.addEventListener('pointerdown', event => startLink(event, card.id));
    item.append(face, port);
    return item;
  }
  function drawSpace() {
    // A drag keeps its cards under the pointer: anything that arrives meanwhile is drawn when it ends.
    if (gesture) { stale = true; return; }
    stale = false;
    // The frame is made once, and again only if something else took the canvas's place (a loading or error message).
    if (!world$ || world$.parentNode !== space) {
      world$ = node('div', 'board-world'); built = new Map();
      // Groups (#162) are labelled areas behind their cards.
      world$.append(node('div', 'board-groups'));
      const layer = svg('svg'); layer.setAttribute('class', 'board-links'); layer.setAttribute('aria-hidden', 'true'); layer.setAttribute('width', '1'); layer.setAttribute('height', '1');
      world$.append(layer);
      // The keyboard way to do what dragging does, read with each card (#26).
      const keys = node('p', 'sr-only', `${altKey} and the arrow keys move this card. Open it to choose which cards it waits for.`); keys.id = 'board-canvas-keys';
      space.replaceChildren(world$, tools(), node('p', 'board-canvas-hint', `Drag a card to place it, or use ${altKey} and the arrow keys. Drag its dot onto another card to make that card wait. Double-click to add a card.`), keys);
    } else space.querySelector('.board-canvas-tools')?.replaceWith(tools());
    const world = world$, fresh = [], present = new Set();
    for (const card of cards()) {
      const key = nodeKey(card), had = built.get(card.id);
      present.add(card.id);
      if (had?.key === key) continue;
      const item = canvasNode(card);
      if (had) had.item.replaceWith(item); else world.append(item);
      built.set(card.id, { key, item }); fresh.push(item);
    }
    for (const [id, had] of built) if (!present.has(id)) { had.item.remove(); built.delete(id); }
    const at = places();
    for (const [id, { item }] of built) { const place = at.get(id); item.style.transform = `translate(${place.x}px, ${place.y}px)`; }
    drawGroups(at);
    space.querySelector('.board-canvas-empty')?.remove();
    if (!cards().length) space.append(node('p', 'board-canvas-empty', 'No cards yet. Double-click anywhere to add one, or use New card.'));
    frame(() => {
      // Only cards just built can have changed height.
      let changed = false;
      for (const item of fresh) { if (!item.parentNode) continue; const measured = item.offsetHeight; if (measured && measured !== heights.get(item.dataset.card)) { heights.set(item.dataset.card, measured); changed = true; } }
      if (!camera) fit(); else aim();
      // Cards not placed yet sit by their heights: once those are known, they're drawn again where they belong.
      if (changed && cards().some(card => !card.at)) { const again = places(); for (const item of world.querySelectorAll('.board-node')) { const p = again.get(item.dataset.card); if (p) item.style.transform = `translate(${p.x}px, ${p.y}px)`; } drawLinks(again); drawGroups(again); }
      else { drawLinks(at); if (changed) drawGroups(at); }
    });
  }

  // ---- Gestures
  function follow(onMove, onEnd) {
    const move = event => onMove(event), end = event => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); onEnd(event); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  function startMove(event, id) {
    if (event.button !== 0 || gesture) return;
    const at = places(), start = at.get(id), origin = toWorld(event);
    // Only this card moves, so only its own arrows are drawn again on each move, from the places when the drag began.
    const item = built.get(id)?.item || space.querySelector(`.board-node[data-card="${id}"]`);
    const own = [...(space.querySelector('.board-links')?.children || [])].filter(line => line.dataset?.from === id || line.dataset?.to === id);
    gesture = { kind: 'move', id, at: { ...start }, start, moved: false };
    follow(next => {
      const point = toWorld(next), x = Math.round(start.x + point.x - origin.x), y = Math.round(start.y + point.y - origin.y);
      if (!gesture.moved && Math.hypot(x - start.x, y - start.y) < 4) return;
      gesture.moved = true; gesture.at = { x, y }; at.set(id, gesture.at);
      if (item) { item.style.transform = `translate(${x}px, ${y}px)`; item.classList.add('moving'); }
      for (const line of own) line.setAttribute('d', curve(at.get(line.dataset.from), at.get(line.dataset.to), height(line.dataset.from), height(line.dataset.to)).d);
      if (picked$?.includes(id)) space.querySelector('.board-link-remove')?.remove();
    }, () => {
      const done = gesture; gesture = null;
      space.querySelector('.board-node.moving')?.classList.remove('moving');
      if (!done.moved) { if (stale) drawSpace(); return; }
      moved = id; setTimeout(() => { if (moved === id) moved = null; }, 0);
      const before = cardBy(id)?.at || null;
      record(`Move ${title(id)}`, { [id]: before }, { [id]: done.at });
      place({ [id]: done.at });
    });
  }
  function startLink(event, from) {
    if (event.button !== 0 || gesture) return;
    event.preventDefault(); event.stopPropagation?.();
    gesture = { kind: 'link', from, to: null, over: null };
    // The new arrow is one line that follows the pointer; the others stay as they are until it's dropped.
    const at = places(), layer = space.querySelector('.board-links'), line = svg('path');
    line.setAttribute('class', 'board-link drafting'); line.setAttribute('marker-end', 'url(#board-link-head)');
    follow(next => {
      gesture.to = toWorld(next);
      const over = cardAt(gesture.to, at, from)?.id || null;
      if (over !== gesture.over) { space.querySelector('.board-node.link-target')?.classList.remove('link-target'); if (over) space.querySelector(`.board-node[data-card="${over}"]`)?.classList.add('link-target'); gesture.over = over; }
      const start = at.get(from), end = gesture.to, x0 = start.x + WIDTH, y0 = start.y + height(from) / 2, bend = Math.max(40, Math.abs(end.x - x0) / 2);
      line.setAttribute('d', `M${x0} ${y0} C${x0 + bend} ${y0} ${end.x - bend} ${end.y} ${end.x} ${end.y}`);
      if (!line.parentNode) layer?.append(line);
    }, () => {
      line.remove();
      const target = gesture.over; gesture = null;
      space.querySelector('.board-node.link-target')?.classList.remove('link-target');
      if (target) connect(from, target); else if (stale) drawSpace(); else drawLinks();
    });
  }
  function startPan(event) {
    if (event.button !== 0 || gesture || event.target.closest?.('.board-node, .board-canvas-tools, .board-link-remove')) return;
    const origin = { x: event.clientX, y: event.clientY, cx: camera.x, cy: camera.y };
    gesture = { kind: 'pan' }; space.classList.add('panning');
    if (picked$) { picked$ = null; drawLinks(); }
    follow(next => { camera = { ...camera, x: origin.cx + next.clientX - origin.x, y: origin.cy + next.clientY - origin.y }; aim(); }, () => { gesture = null; space.classList.remove('panning'); if (stale) drawSpace(); });
  }
  // Alt and an arrow key move the focused card, for those who'd rather not drag.
  function nudge(event, id) {
    const by = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!by || !event.altKey) return;
    event.preventDefault();
    const from = places().get(id), to = { x: from.x + by[0], y: from.y + by[1] };
    record(`Move ${title(id)}`, { [id]: cardBy(id)?.at || null }, { [id]: to });
    place({ [id]: to });
  }

  // ---- Changes, and undoing them
  // Canvas changes show at once and are saved behind; one that fails reloads the board as it is.
  async function quietly(path, input) {
    const request = ++written; writes++; failure = '';
    try { const result = await api.post(path, input); writes--; if (request === written && result.board) { board = result.board; render(); } return true; }
    catch (error) { writes--; failure = error.message; showError(); await load(); return false; }
  }
  function place(positions) {
    for (const [id, at] of Object.entries(positions)) { const card = cardBy(id); if (card) card.at = at; }
    render();
    return quietly('/api/board/place', { positions });
  }
  // Waits are part of what an agent is told, so they change through the card's own edit, which checks for circles.
  function setWaits(id, change) {
    const card = cardBy(id); if (!card) return Promise.resolve(false);
    const dependsOn = change(card.dependsOn || []);
    card.dependsOn = dependsOn; render();
    return quietly(`/api/board/cards/${id}/edit`, { dependsOn, revision: card.revision });
  }
  async function connect(from, to) {
    const card = cardBy(to);
    if (!card || card.dependsOn?.includes(from)) { drawSpace(); return; }
    if (card.column === 'doing') { failure = `An agent is working on ${title(to)}. Stop it before changing what it waits for.`; showError(); drawSpace(); return; }
    if (await setWaits(to, waits => [...waits, from])) { record(`${title(to)} waits for ${title(from)}`, null, null, { undo: () => setWaits(to, waits => waits.filter(id => id !== from)), redo: () => setWaits(to, waits => [...new Set([...waits, from])]) }); api.announce(`${title(to)} now waits for ${title(from)}.`); }
  }
  async function disconnect(from, to) {
    picked$ = null;
    if (cardBy(to)?.column === 'doing') { failure = `An agent is working on ${title(to)}. Stop it before changing what it waits for.`; showError(); drawSpace(); return; }
    if (await setWaits(to, waits => waits.filter(id => id !== from))) { record(`${title(to)} stops waiting for ${title(from)}`, null, null, { undo: () => setWaits(to, waits => [...new Set([...waits, from])]), redo: () => setWaits(to, waits => waits.filter(id => id !== from)) }); api.announce(`${title(to)} no longer waits for ${title(from)}.`); }
  }
  function arrange() {
    const all = cards(); if (!all.length) return;
    const before = Object.fromEntries(all.map(card => [card.id, card.at || null])), after = Object.fromEntries([...layout(all, 0, 0)].map(([id, at]) => [id, at]));
    record('Arrange', before, after);
    place(after).then(() => fit());
  }
  // A move undoes to the places before it; an arrow undoes with its own pair of changes.
  function record(label, before, after, own = null) {
    undos.push(own ? { label, ...own } : { label, undo: () => place(before), redo: () => place(after) });
    if (undos.length > 100) undos.shift();
    redos = []; refreshTools();
  }
  async function step(from, to) {
    const entry = from.pop(); if (!entry) return;
    const ok = await (from === undos ? entry.undo() : entry.redo());
    if (ok !== false) { to.push(entry); api.announce(`${from === undos ? 'Undone' : 'Redone'}: ${entry.label}.`); }
    refreshTools();
  }
  function refreshTools() {
    const bar = space.querySelector('.board-canvas-tools');
    if (!bar || view !== 'canvas') return;
    bar.replaceWith(tools()); aim();
  }

  function showView(next) {
    view = next; try { localStorage.setItem(VIEW_KEY, next); } catch {}
    for (const [id, mode] of [['board-columns-mode', 'columns'], ['board-canvas-mode', 'canvas'], ['board-outline-mode', 'outline']]) $(id)?.setAttribute('aria-pressed', String(view === mode));
    picked$ = null; render();
  }
  // With cards closed to agents, Export asks whether to leave them out (the default) or include everything.
  function exportChoice() {
    const menu = $('board-export-menu'), closed = cards().filter(shut).length;
    if (!closed) { exportBoard(false); return; }
    if (!menu) { exportBoard(false); return; }
    if (!menu.hidden) { menu.hidden = true; $('board-export').setAttribute('aria-expanded', 'false'); return; }
    $('board-export-closed').textContent = `Everything, including ${board?.closed ? 'the closed Plan' : plural(closed, 'closed card')}`;
    menu.hidden = false; $('board-export').setAttribute('aria-expanded', 'true'); menu.querySelector('button')?.focus();
  }
  async function exportBoard(includeClosed = false) {
    const menu = $('board-export-menu'); if (menu) { menu.hidden = true; $('board-export').setAttribute('aria-expanded', 'false'); }
    try {
      const result = await api.api(`/api/board/export${includeClosed ? '?closed=include' : ''}`), url = URL.createObjectURL(new Blob([result.markdown], { type: 'text/markdown' })), link = document.createElement('a');
      link.href = url; link.download = result.filename || 'codeshi-board.md'; document.body?.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      api.announce('Board saved as Markdown.');
    } catch (error) { failure = error.message; showError(); }
  }

  function render() {
    if (!dialog.open) { entry(); return; }
    const onCanvas = view === 'canvas', outline = view === 'outline';
    $('board-canvas').classList.toggle('canvas-mode', onCanvas); $('board-columns').hidden = view !== 'columns'; space.hidden = !onCanvas; $('board-outline').hidden = !outline;
    for (const [id, mode] of [['board-columns-mode', 'columns'], ['board-canvas-mode', 'canvas'], ['board-outline-mode', 'outline']]) $(id)?.setAttribute('aria-pressed', String(view === mode));
    drawEarlier();
    if (!board) { const message = node('p', 'plan-view-empty', failure ? `The Plan couldn’t be loaded. ${failure}` : 'Loading the Plan…'); (onCanvas ? space : outline ? $('board-outline') : $('board-columns')).replaceChildren(message); return; }
    drawFilter(); drawDrafts(); drawClosed();
    const ready = cards().filter(card => card.column === 'ready');
    $('board-run-ready').disabled = busy || !ready.some(runnable);
    $('board-run-ready').title = ready.length ? 'Choose Ready cards to run' : 'Nothing is in Ready';
    const timed = $('board-schedules'), waitingFor = schedules().filter(item => item.missed).length, active = schedules().filter(item => !item.paused && (item.nextAt || item.waiting)).length;
    if (timed) { const count = $('board-schedules-count'); count.textContent = String(waitingFor || active || ''); count.hidden = !(waitingFor || active); timed.dataset.state = waitingFor ? 'missed' : ''; timed.title = waitingFor ? `${plural(waitingFor, 'scheduled run')} didn’t start` : active ? `${plural(active, 'schedule')} waiting` : 'Run a card or a prompt at a set time'; }
    // Typing keeps its place: the columns are drawn again only when the cards change.
    const where = onCanvas ? space : outline ? $('board-outline') : $('board-columns'), focused = document.activeElement?.closest?.(onCanvas ? '#board-space' : outline ? '#board-outline' : '#board-columns') ? document.activeElement.dataset?.card : null;
    if (onCanvas) drawSpace(); else if (outline) drawOutline(); else drawColumns();
    if (focused) where.querySelector(`${outline ? '.board-outline-card' : '.board-card'}[data-card="${focused}"]`)?.focus();
    renderDrawer(); showError(); entry();
  }
  // The label filter appears once a card has a label. A label no card has any more stops being the filter.
  function drawFilter() {
    const pick = $('board-label-filter'); if (!pick) return;
    const labels = allLabels();
    if (filter && !labels.some(item => item.name.toLowerCase() === filter)) filter = '';
    pick.hidden = !labels.length && !filter;
    pick.classList.toggle('active', Boolean(filter));
    const want = JSON.stringify([labels, filter]);
    if (pick.dataset.drawn === want) return;
    const option = (value, text) => { const item = node('option', '', text); item.value = value; return item; };
    pick.replaceChildren(option('', 'All labels'), ...labels.map(item => option(item.name.toLowerCase(), `${item.name} (${item.count})`)));
    pick.value = filter; pick.dataset.drawn = want;
  }
  $('board-label-filter')?.addEventListener('change', () => {
    filter = $('board-label-filter').value; render();
    const name = allLabels().find(item => item.name.toLowerCase() === filter)?.name, count = cards().filter(shown).length;
    api.announce(filter ? `Showing ${plural(count, 'card')} labelled ${name}.` : 'Showing every card.');
  });

  // The Plan button (#162) says what waits for you: drafted cards first, then cards to review, then how many are working.
  function entry() {
    const button = $('open-plan'); if (!button) return;
    button.disabled = !api.getState().projectId;
    const drafts = cards().filter(card => card.draft).length, waiting = cards().filter(card => card.column === 'review').length, working = cards().filter(card => card.column === 'doing').length;
    const planning = api.getState().conversation?.orchestrations?.[0]?.status === 'planning';
    const [state, short, long] = planning ? ['planning', 'Planning…', 'Plan: an agent is drafting cards.'] : drafts ? ['ready', String(drafts), `Plan: ${plural(drafts, 'drafted card')} waiting for you to accept or discard.`] : waiting ? ['ready', String(waiting), `Plan: ${plural(waiting, 'card')} to review.`] : working ? ['running', String(working), `Plan: ${plural(working, 'card')} working.`] : ['none', '', 'Plan: plan, run and review this workspace’s cards.'];
    button.dataset.state = state; button.title = long; button.setAttribute('aria-label', long);
    const badge = $('open-plan-state');
    if (badge) { badge.textContent = short; badge.hidden = !short; }
  }

  function open(prefill = null) {
    if (dialog.open || !api.getState().projectId) return;
    selected = null; draft = null; failure = ''; drawn = null;
    dialog.showModal(); render();
    load().then(() => { if (prefill) openNew('backlog', null, prefill); else (view === 'canvas' ? space : view === 'outline' ? $('board-outline') : $('board-columns')).querySelector('[data-card]')?.focus(); });
  }
  dialog.addEventListener('cancel', event => {
    if (picked$) { event.preventDefault(); picked$ = null; drawLinks(); }
    else if (selected) { event.preventDefault(); closeDrawer(); } else if (dirty()) event.preventDefault();
  });
  $('board-columns-mode')?.addEventListener('click', () => showView('columns'));
  $('board-canvas-mode')?.addEventListener('click', () => showView('canvas'));
  $('board-outline-mode')?.addEventListener('click', () => showView('outline'));
  $('board-earlier-open')?.addEventListener('click', () => { dialog.close(); window.relayPlanView?.open(); });
  $('board-export')?.addEventListener('click', exportChoice);
  $('board-export-open')?.addEventListener('click', () => exportBoard(false));
  $('board-export-closed')?.addEventListener('click', () => exportBoard(true));
  $('board-export-menu')?.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $('board-export-menu').hidden = true; $('board-export').setAttribute('aria-expanded', 'false'); $('board-export').focus(); } });
  dialog.addEventListener('click', event => { const menu = $('board-export-menu'); if (menu && !menu.hidden && !event.target?.closest?.('#board-export-menu, #board-export')) { menu.hidden = true; $('board-export').setAttribute('aria-expanded', 'false'); } });
  $('board-attach')?.addEventListener('click', () => attach());
  $('board-agents')?.addEventListener('click', () => setClosed(board?.closed !== true));
  // The canvas: drag empty space to pan, scroll to pan, pinch or ⌘-scroll to zoom, double-click for a new card there.
  const onCard = event => event.target?.closest?.('.board-node') || event.target?.closest?.('.board-canvas-tools') || event.target?.closest?.('.board-link-remove');
  space.addEventListener('pointerdown', startPan);
  space.addEventListener('wheel', event => {
    if (!camera) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * 0.01), event);
    else { camera = { ...camera, x: camera.x - event.deltaX, y: camera.y - event.deltaY }; aim(); }
  }, { passive: false });
  space.addEventListener('dblclick', event => {
    if (!camera || onCard(event)) return;
    const point = toWorld(event);
    openNew('backlog', { x: Math.round(point.x - WIDTH / 2), y: Math.round(point.y - 20) });
  });
  // ⌘Z and ⇧⌘Z undo and redo canvas changes; Delete takes away the chosen arrow. Typing in a field keeps its own undo.
  dialog.addEventListener('keydown', event => {
    if (view !== 'canvas' || !board) return;
    const target = event.target, typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || target?.closest?.('#board-drawer');
    if (typing) return;
    const key = String(event.key || '').toLowerCase(), command = event.metaKey || event.ctrlKey;
    if (command && key === 'z') { event.preventDefault(); if (event.shiftKey) step(redos, undos); else step(undos, redos); }
    else if (command && key === 'y') { event.preventDefault(); step(redos, undos); }
    else if ((key === 'delete' || key === 'backspace') && picked$) { event.preventDefault(); disconnect(...picked$); }
  });
  dialog.addEventListener('close', () => { selected = null; draft = null; sdraft = null; drawn = null; entry(); });
  $('board-close').addEventListener('click', () => { if (!dirty() || window.confirm('Leave this card without saving your changes?')) { selected = null; draft = null; dialog.close(); } });
  $('board-drawer-close').addEventListener('click', closeDrawer);
  $('board-new').addEventListener('click', () => openNew('backlog'));
  $('board-run-ready').addEventListener('click', () => openRun());
  $('board-schedules')?.addEventListener('click', () => { if (selected === 'schedules') { closeDrawer(); return; } if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return; selected = 'schedules'; draft = null; sdraft = null; failure = ''; drawn = null; render(); });
  $('open-plan')?.addEventListener('click', () => open());
  // The board is read again when its cards or their tasks change: the workspace chat says when, and so do the tasks.
  let project = null;
  window.addEventListener('relay-state', () => {
    const state = api.getState();
    if (state.projectId !== project) { project = state.projectId; board = null; seen = null; camera = null; heights = new Map(); undos = []; redos = []; picked$ = null; filter = ''; threads = new Map(); asked = new Map(); said = new Map(); if (dialog.open) dialog.close(); }
    const key = JSON.stringify([state.projectId, state.conversation?.boardRevision, (state.conversation?.parallelTasks || []).map(task => [task.id, task.status, task.approvals, task.hasWorktree])]);
    if (key === seen) { entry(); if (dialog.open) drawEarlier(); return; }
    seen = key;
    if (state.projectId) load(); else entry();
  });
  // open({ title, notes }) opens the Plan with a new card written from them, as Write it yourself does.
  window.relayBoard = { open, close: () => { if (dialog.open) dialog.close(); }, isOpen: () => dialog.open, reload: load, drafts: () => cards().filter(card => card.draft) };
})();

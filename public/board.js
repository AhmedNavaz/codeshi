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
// Asking about the Plan (#162): in the Plan view the chat's message box sends the Plan and the open card with a message,
// and its Draft cards switch has an agent draft cards from what you write and a brief or spec you attach. It replaced
// Orchestrate's switch in the message box.
// Subtasks (#155): a major card is split into subtasks when it starts. Its drawer lists them as they run, with the ones
// not started yet to edit, remove or add to, and Pause after the subtask it is on.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  // The Plan is a view of the window (#162), beside Normal and Flow. flow.js changes view and calls show() and hide();
  // open() asks for the Plan view. The Workspace chat stays on the right, and the button at the end of the toolbar hides it.
  // In the Plan view the chat's message box knows it (see "Asking the chat about the Plan" below).
  const dialog = $('board-view'), api = window.relayUI;
  if (!dialog || !api) return;
  let showing = false;
  const shell = $('app-shell'), CHAT_KEY = 'throughline:plan-chat';
  const chatHidden = () => Boolean(shell?.classList.contains('plan-chat-hidden'));
  function setChat(open, remember = true) {
    shell?.classList.toggle('plan-chat-hidden', !open);
    const toggle = $('board-chat');
    if (toggle) { toggle.setAttribute('aria-pressed', String(open)); toggle.title = 'Show the chat'; toggle.hidden = open; }
    if (remember) { try { localStorage.setItem(CHAT_KEY, open ? 'shown' : 'hidden'); } catch { /* A convenience only. */ } }
    chatAttention();
  }
  // While the chat is hidden, a dot on its button says an agent there waits for an approval or an answer.
  function chatAttention() {
    const dot = $('board-chat-attention'), waiting = api.getState().conversation?.pendingApprovals?.length || 0, toggle = $('board-chat');
    if (dot) dot.hidden = !(chatHidden() && waiting);
    if (toggle) toggle.setAttribute('aria-label', chatHidden() && waiting ? `Chat: ${plural(waiting, 'approval')} waiting` : 'Chat');
  }
  // Something that happens in the chat, such as an attached card or a card's task, shows the chat.
  const showChat = () => { if (chatHidden()) setChat(true); };
  // A model's name: as its agent reports it, or a readable form of its id (claude-opus-5-5 is Opus 5.5).
  const modelLabel = (provider, id) => { if (!id) return ''; const named = window.relayModelPicker?.modelName?.(provider, id); if (named && named !== id) return named; const short = String(id).replace(/^claude-/, '').replace(/-(\d+)-(\d+)(?=$|-)/, ' $1.$2').replace(/-/g, ' '); return /^claude-/.test(id) ? short.replace(/\b\w/g, char => char.toUpperCase()) : id; };
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
  const OUTCOME = { complete: 'Finished', integrated: 'Merged', kept: 'Kept as a branch', stopped: 'Stopped', failed: 'Didn’t finish', cancelled: 'Cancelled', discarded: 'Discarded', blocked: 'Blocked', lost: 'Copy gone', detached: 'Folder removed' };
  const when = iso => { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return ''; } };
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
  // Flow's Run Ready (#132): the limit the cards you run together share, as typed. Filled from the task limits when it opens.
  let shared = null;
  let filter = '', threads = new Map(), asked = new Map(), said = new Map();
  // subEdit: a subtask being written or edited in a card's drawer, kept when the drawer is drawn again.
  // draftNotice: inline undo banner for the last draft accept/discard; suggestConfirm: card ID confirming Suggest next.
  let subEdit = null, draftNotice = null, suggestConfirm = null;
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
  // Smart routing is chosen on the card, so it routes in Normal too, with the workspace's routing preference.
  const LEGACY_MODES = { saving: 'saver', balanced: 'smart', quality: 'ultra' };
  const smartMode = () => { const mode = api.getState().conversation?.routing?.mode || api.getState().conversation?.execution?.defaults?.routingMode || 'smart'; return LEGACY_MODES[mode] || mode; };
  // Auto's three modes. A card can choose one; until it does, it follows the workspace's routing preference.
  const MODES = [['saver', 'Saver'], ['smart', 'Smart'], ['ultra', 'Ultra']], MODE = Object.fromEntries(MODES);
  const modeOf = card => card?.routingMode || smartMode();
  const modeName = card => MODE[modeOf(card)] || 'Smart';
  function autoPick(card) {
    const state = api.getState(), routed = api.routeFor?.(card.notes || card.title || 'Plan card', 0, modeOf(card), card.tier ? { tier: card.tier } : undefined);
    if (!routed) { const provider = state.provider || 'codex', model = state.model || null; return { provider, model, effort: state.effort || null, text: `${AGENT[provider] || provider} · ${model || 'default model'}` }; }
    if (routed.error) return { error: routed.error, text: routed.error };
    const effort = routed.effort ? `${routed.effort[0].toUpperCase()}${routed.effort.slice(1)} effort` : '';
    return { provider: routed.provider, model: routed.model || null, effort: routed.effort || null, auto: true, text: [`${modeName(card)}:`, [AGENT[routed.provider] || routed.provider, routed.modelName || 'default model', effort].filter(Boolean).join(' · ')].join(' ') };
  }
  const shut = card => board?.closed === true || card?.closed === true;
  // A major card (#162) runs only through its subtasks: it needs one still to do before it can run.
  const needsSubtasks = card => Boolean(card.split || card.subtasks?.length) && !(card.subtasks || []).some(item => item.status !== 'done') && card.column !== 'done';
  // In Flow (#132) a card with no agent of its own runs on Auto, chosen when it starts; the card itself stays as it is.
  const inFlow = () => window.relayFlow?.isRouted?.() === true;
  const onAuto = card => !card.agent && (card.auto === true || inFlow());
  const notRunnable = card => needsSubtasks(card) ? 'It needs subtasks first. Split it with an agent, or add them yourself.' : 'Choose Auto or an agent first.';
  const runnable = card => !card.draft && !shut(card) && (Boolean(card.agent) || onAuto(card)) && !needsSubtasks(card);
  // What a Run sends for the cards on Auto: the pick shown, or the reason none can be made.
  function assignments(list) {
    const out = {};
    for (const card of list.filter(onAuto)) { const pick = autoPick(card); if (pick.error) return { error: `“${card.title}”: ${pick.error}` }; out[card.id] = { provider: pick.provider, model: pick.model, effort: pick.effort, ...(pick.auto ? { auto: true } : {}) }; }
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
  // era goes up when the workspace changes, so a reply that comes back for the workspace you left is dropped.
  let writes = 0, written = 0, era = 0;

  async function load() {
    if (!api.getState().projectId) return;
    const request = ++loading;
    try { const result = await api.api('/api/board'); if (request === loading) { if (writes) { seen = null; return; } board = result; render(); } }
    catch (error) { if (request === loading) { seen = null; failure = error.message; render(); } }
  }
  async function act(path, input = {}, done) {
    if (busy) return null; busy = true; failure = ''; render();
    const from = era;
    try { const result = await api.post(path, input); if (from !== era) return null; board = result.board || board; done?.(result); return result; }
    catch (error) { if (from === era) failure = error.message; return null; }
    finally { busy = false; render(); }
  }

  // ---- The columns
  // A major card's subtasks in a few words for its face, and in a sentence.
  function subtaskLine(card) {
    const list = card.subtasks || [];
    if (list.length) { const done = list.filter(item => item.status === 'done').length; return { short: `${done}/${list.length} subtasks`, long: `${done} of ${plural(list.length, 'subtask')} done` }; }
    return card.split ? { short: 'Needs subtasks', long: 'Runs through its subtasks, and has none yet' } : null;
  }
  // What a drafted change names for each field it changed.
  const CHANGED = { title: 'title', notes: 'description', checks: 'what done means', group: 'phase', role: 'role', artifact: 'what it produces', check: 'test command', files: 'files', tier: 'size', dependsOn: 'what it waits for' };
  // A drafted card (#162): a new card, a change to a card already on the Plan, or a card to remove or to merge into another.
  const draftKind = card => !card.draft ? null : card.draft.remove ? 'remove' : card.draft.was ? 'change' : 'new';
  const draftWord = card => ({ new: 'Draft', change: 'Changed', remove: card.draft?.into ? 'To merge' : 'To remove' })[draftKind(card)] || '';
  // What a card says about itself in one short line, from its task while it has one.
  function stateOf(card) {
    const task = card.taskState;
    if (card.draft) return { text: draftWord(card), tone: 'draft', detail: (card.draft.notes || []).join(' ') };
    if (board?.suggest?.kind === 'split' && board.suggest.status === 'running' && (board.suggest.cardIds || [board.suggest.cardId]).includes(card.id)) return { text: 'Splitting…', tone: 'running', detail: 'An agent is splitting it into subtasks, reading only.' };
    if (card.column === 'doing') {
      if (task?.approvals) return { text: 'Needs you', tone: 'attention' };
      // A review round (#89): the card being repaired, and the review checking the repairs.
      if (task?.status === 'running' && task.repairOf?.running) return { text: 'Repairing', tone: 'running', detail: task.repairOf.title ? `Fixing what “${task.repairOf.title}” found.` : 'Fixing what a review found.' };
      if (task?.status === 'running' && task.review?.status === 'reviewing') return { text: 'Reviewing again', tone: 'running', detail: 'Checking the repairs. This is the last review round.' };
      if (task?.status === 'running' && card.splitting) return { text: 'Splitting', tone: 'running', detail: 'Splitting it into subtasks, reading only.' };
      const at = (card.subtasks || []).findIndex(item => item.status === 'running');
      // The running subtask's name sits on the progress line, so this line only adds what that line can't say.
      if (task?.status === 'running' && at >= 0) return { text: 'Working', tone: 'running', detail: card.subtasksPaused ? 'Pauses after it.' : '' };
      if (task?.status === 'running') return { text: 'Working', tone: 'running' };
      return { text: task?.held ? 'Held' : 'Waiting', tone: 'waiting', detail: task?.reason || '' };
    }
    if (card.column === 'review') {
      if (task?.hasWorktree) return { text: 'Merge first', tone: 'attention', detail: 'Its changes are in the task’s own copy. Review and merge them in its task.' };
      const tests = card.result?.tests;
      if (tests === 'running') return { text: TESTS.running, tone: 'running', detail: 'Running the project’s tests on this card’s result. The cards after it wait for them.' };
      if (tests === 'failed' || tests === 'interrupted') return { text: card.result.testsAccepted ? `${TESTS[tests]} · continued` : TESTS[tests], tone: 'trouble', detail: card.result.testsAccepted ? 'You chose to let the cards after it build on it anyway.' : `${card.result.testsReason || ''}${task?.holds ? ' The cards after it wait until you check it again or continue anyway.' : ''}`.trim() };
      const review = task?.review;
      if (review?.status === 'repairing') return { text: 'Repairing', tone: 'running', detail: review.waiting || review.reason || '' };
      if (review?.status === 'held') return { text: review.accepted ? `${review.verdict ? 'Changes needed' : 'No verdict'} · continued` : review.verdict ? 'Changes needed' : 'No verdict', tone: 'trouble', detail: review.accepted ? 'You chose to let the cards after it build on it anyway.' : review.reason || '' };
      if (review?.status === 'passed') return { text: review.round ? 'Passed after repair' : 'Passed review', tone: 'done', detail: review.reason || '' };
      return { text: tests === 'passed' ? TESTS.passed : 'Finished', tone: 'done' };
    }
    if (card.column === 'ready' && /already running/i.test(card.reason || '')) return { text: 'Waiting', tone: 'waiting', detail: 'Waiting for a free slot' };
    if (card.column === 'ready' && card.reason) return { text: 'Back', tone: 'trouble', detail: card.reason };
    return null;
  }
  // Small stroke icons for the card's footer, drawn like the rest of the app's icons.
  const glyph = d => { const icon = svg('svg'); icon.setAttribute('class', 'icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); for (const part of d.split('|')) { const path = svg('path'); path.setAttribute('d', part); icon.append(path); } return icon; };
  const ICONS = { checks: 'M4 12.5l3 3 6-7|M14 9h6M14 15h6', waits: 'M4 6h7a4 4 0 0 1 4 4v8|M11 14l4 4 4-4', smart: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z', subtasks: 'M5 6h4M5 12h4M5 18h4|M13 6h6M13 12h6M13 18h6' };
  // Who does a card, in a few words: its task's agent while it runs, otherwise Smart routing or the agent chosen.
  function whoOf(card) {
    const provider = card.taskState?.provider || card.agent?.provider || null;
    // A running card names the agent, model and effort its run is on now, which can change from one subtask to the next.
    const live = liveOf(card);
    if (live?.provider) return { provider: live.provider, short: AGENT[live.provider] || live.provider, text: [AGENT[live.provider] || live.provider, live.model ? modelLabel(live.provider, live.model) : '', effortWord(live.effort)].filter(Boolean).join(' · ') };
    if (card.taskState?.provider) return { provider, text: AGENT[provider] || provider };
    if (card.agent) return { provider, text: [AGENT[provider] || provider, card.agent.model ? modelLabel(provider, card.agent.model) : ''].filter(Boolean).join(' · ') };
    if (card.auto) return { provider: 'auto', text: modeName(card), smart: true };
    // In Flow a card with no agent runs on Auto when it runs (#132), so it says so rather than asking for one.
    if (inFlow() && !card.draft) return { provider: 'auto', text: 'Flow picks', smart: true, title: 'No agent chosen: Flow picks one when this card runs. Choose one to keep it.' };
    return { provider: null, text: 'No agent yet' };
  }
  // ---- Watching the Plan run (#162 stage 5)
  // A running card reads its task as the workspace chat last reported it, so what it's doing now shows without reading the
  // whole Plan again. Only the few lines that changed are rewritten (patchLive), and the minutes are counted here, once a
  // minute, so a long run that's quiet doesn't redraw anything.
  const PHASE = { starting: 'Starting', probing: 'Checking usage', reasoning: 'Thinking', responding: 'Writing', tool: 'Running tools', working: 'Working', compacting: 'Organizing its context', approval: 'Waiting for you' };
  const effortWord = effort => effort ? `${String(effort).charAt(0).toUpperCase()}${String(effort).slice(1)} effort` : '';
  const liveTask = card => { const id = card.taskState?.id; return id ? (api.getState().conversation?.parallelTasks || []).find(task => task.id === id) || null : null; };
  function minutes(ms) { const total = Math.floor(Math.max(0, ms) / 60000); return total < 1 ? 'under a minute' : total < 60 ? `${total} min` : `${Math.floor(total / 60)} h${total % 60 ? ` ${total % 60} min` : ''}`; }
  function tokenWord(count) { const value = Number(count) || 0; return value >= 1e6 ? `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M tokens` : value >= 1000 ? `${(value / 1000).toFixed(value >= 1e4 ? 0 : 1)}k tokens` : `${value} tokens`; }
  // Time, tokens, spend, retries and handoffs so far, in a few words, from what the task's limits count.
  function usageWords(usage) {
    if (!usage) return [];
    const worked = (usage.workedMs || 0) + (usage.activeSince ? Math.max(0, Date.now() - Date.parse(usage.activeSince)) : 0);
    const times = count => count === 1 ? 'once' : `${count} times`;
    return [worked ? minutes(worked) : '', usage.tokens ? tokenWord(usage.tokens) : '', usage.spendUSD >= 0.005 ? `$${usage.spendUSD.toFixed(2)}` : '', usage.retries ? `retried ${times(usage.retries)}` : '', usage.handoffs ? `handed off ${times(usage.handoffs)}` : '', usage.reviews ? `reviewed ${times(usage.reviews)}` : ''].filter(Boolean);
  }
  function liveOf(card) {
    if (card.column !== 'doing' || !card.taskState || card.draft) return null;
    const task = liveTask(card), base = card.taskState, status = task?.status || base.status, running = status === 'running';
    const provider = (running && task?.runningProvider) || base.provider || null, model = (running && task?.runningModel) || base.model || null, effort = (running && task?.runningEffort) || base.effort || null;
    const needs = task ? task.approvals : base.approvals, sub = (card.subtasks || []).findIndex(item => item.status === 'running');
    const now = needs ? `Needs you: ${needs === 1 ? 'an approval or a question' : `${needs} approvals or questions`}` : task?.testing ? 'Running its tests' : !running ? '' : card.splitting ? 'Splitting it into subtasks' : task?.runningStep ? `On “${task.runningStep}”` : PHASE[task?.runningPhase] || 'Working';
    return { provider, model, effort, running, needs, now, sub, usage: usageWords(task?.usage || base.usage), brief: usageBrief(task?.usage || base.usage) };
  }
  // The same numbers as usageWords, short enough to share a card's row: "2m · 2.5k · $0.04".
  function usageBrief(usage) {
    if (!usage) return '';
    const worked = (usage.workedMs || 0) + (usage.activeSince ? Math.max(0, Date.now() - Date.parse(usage.activeSince)) : 0), mins = Math.floor(worked / 60000);
    const count = Number(usage.tokens) || 0;
    return [worked ? (mins < 1 ? '<1m' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`) : '', count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1000 ? `${(count / 1000).toFixed(count >= 1e4 ? 0 : 1)}k` : count ? String(count) : '', usage.spendUSD >= 0.005 ? `$${usage.spendUSD.toFixed(2)}` : ''].filter(Boolean).join(' · ');
  }
  // The live lines inside a card's face: what it's doing now, and what it has used. Their own elements, so they can be
  // rewritten in place.
  function liveLines(card, live, { withWho = false, agent = null } = {}) {
    const box = node('span', 'board-card-live'); box.dataset.live = card.id;
    const who = withWho ? node('span', 'board-card-who') : null, now = node('span', `board-card-now${live.needs ? ' attention' : ''}`), used = node('span', 'board-card-used');
    box.liveParts = { who, now, used, agent };
    if (who) box.append(who);
    box.append(now, used); paintLive(box, card, live);
    return box;
  }
  function paintLive(box, card, live = liveOf(card)) {
    if (!live) return;
    const who = whoOf(card), now = live.now || (live.running ? 'Working' : stateOf(card)?.text || ''), used = live.usage.join(' · ');
    const key = JSON.stringify([who.text, now, used, live.brief, live.needs]);
    if (box.dataset.liveKey === key) return;
    box.dataset.liveKey = key;
    const { who: whoLine, now: nowLine, used: usedLine, agent } = box.liveParts;
    // Both lines keep their height when empty, so a card on the Canvas doesn't grow under its arrows as usage arrives.
    nowLine.textContent = now; nowLine.classList.toggle('attention', Boolean(live.needs));
    // On a card the numbers share the status row, so they're short; the drawer and the tooltip say them in full.
    usedLine.textContent = whoLine ? used : live.brief; usedLine.title = used ? `Used so far: ${used}` : '';
    if (whoLine) whoLine.textContent = who.text;
    // The agent named on the card's face follows the run too: a subtask can be on another model.
    const face = who.short || who.text; if (agent && agent.textContent !== face) agent.textContent = face; if (agent?.parentElement) agent.parentElement.title = who.text;
    box.title = [who.text, now, used].filter(Boolean).join('. ');
  }
  // Called on every update from the chat: a card whose run changed what it's doing gets its lines rewritten; the rest are
  // left alone. A card that needs you, or stopped needing you, is said aloud once.
  let heard = new Map();
  function patchLive() {
    if (!showing || !board) return;
    for (const box of document.querySelectorAll('.board-card-live')) { const card = box.liveParts && cardBy(box.dataset.live); if (card) paintLive(box, card); }
    for (const row of document.querySelectorAll('.board-outline-live')) { const card = cardBy(row.dataset.outlineLive); const live = card && liveOf(card); if (live) { const text = [whoOf(card).text, live.now, ...live.usage].filter(Boolean).join(' · '); if (row.textContent !== text) row.textContent = text; } }
    for (const card of cards().filter(item => item.column === 'doing')) {
      const live = liveOf(card), needs = live?.needs || 0, before = heard.get(card.id);
      if (before !== undefined && needs && !before) api.announce(`“${card.title}” needs you: open its task beside the Plan.`);
      heard.set(card.id, needs);
    }
    paintTotals();
  }
  // The whole Plan's working time, tokens and spend so far, beside its progress, from the cards' current tasks.
  function paintTotals() {
    const line = $('board-progress'), slot = line?.querySelector('.board-progress-used'); if (!slot) return;
    let worked = 0, tokens = 0, spend = 0, any = false;
    for (const card of cards().filter(item => item.taskState && !item.draft)) {
      const usage = liveTask(card)?.usage || card.taskState.usage; if (!usage) continue;
      any = true; worked += (usage.workedMs || 0) + (usage.activeSince ? Math.max(0, Date.now() - Date.parse(usage.activeSince)) : 0); tokens += usage.tokens || 0; spend += usage.spendUSD || 0;
    }
    const text = any ? [worked ? minutes(worked) : '', tokens ? tokenWord(tokens) : '', spend >= 0.005 ? `$${spend.toFixed(2)}` : ''].filter(Boolean).join(' · ') : '';
    if (slot.textContent !== text) { slot.textContent = text; slot.hidden = !text; slot.title = text ? `Used so far by the cards’ current tasks: ${text}` : ''; }
  }
  // Minutes move on by themselves: once every 20 seconds while a card works, and only lines whose words changed are written.
  let ticker = null;
  function tick() {
    const working = showing && cards().some(card => card.column === 'doing');
    if (working && !ticker) ticker = setInterval(patchLive, 20000);
    if (!working && ticker) { clearInterval(ticker); ticker = null; }
  }
  // A card's status in one word, for the Canvas, where no column says it.
  const STATUS = { backlog: 'Backlog', ready: 'Ready', doing: 'Working', review: 'Review', done: 'Done' };
  function cardButton(card, onCanvas = false) {
    const item = node('button', 'board-card'); item.type = 'button';
    item.dataset.card = card.id; item.dataset.column = card.draft ? 'draft' : card.column;
    if (card.draft) item.dataset.draft = draftKind(card);
    item.setAttribute('aria-pressed', String(selected === card.id));
    const state = stateOf(card), needs = !card.draft && needsSubtasks(card), top = node('span', 'board-card-top');
    // The status: on the Canvas always, in Columns only what the column doesn't say.
    const badge = state ? { text: state.text, tone: state.tone } : needs ? { text: 'Needs subtasks', tone: 'needs' } : onCanvas ? { text: STATUS[card.column], tone: card.column } : null;
    if (badge) { const pill = node('span', 'board-card-state'); pill.dataset.tone = badge.tone; pill.append(node('span', 'board-card-dot'), document.createTextNode(badge.text)); top.append(pill); }
    // The role: when it isn't the usual Builder, and always on a working card, so you can see who it is working as.
    const showRole = card.role && (card.role !== 'builder' || card.column === 'doing');
    if (showRole) { const role = node('span', 'orchestration-step-role', ROLE[card.role] || card.role); role.dataset.role = card.role; role.title = `Working as ${ROLE[card.role] || card.role}${card.taskState?.notIndependent ? '. Not independent: it ran on an agent that built what it checks' : ''}`; if (card.taskState?.notIndependent) role.dataset.shared = 'true'; top.append(role); }
    const title = node('span', 'board-card-title', card.title);
    const parts = [top, title];
    // The first lines of what it says, so a card can be read without opening it.
    const gist = String(card.notes || '').replace(/[#*`>_]+/g, '').replace(/\s+/g, ' ').trim();
    if (gist) parts.push(node('span', 'board-card-notes', gist));
    // Up to three labels, then how many more; the one being filtered by is marked.
    const names = card.labels || [];
    if (names.length) {
      const tags = node('span', 'board-card-labels');
      for (const name of names.slice(0, names.length > 3 ? 2 : 3)) { const tag = node('span', 'board-label', name); if (filter && name.toLowerCase() === filter) tag.classList.add('current'); tags.append(tag); }
      if (names.length > 3) { const more = node('span', 'board-label more', `+${names.length - 2}`); more.title = names.slice(2).join(', '); tags.append(more); }
      parts.push(tags);
    }
    // A major card's subtasks: how far they've got, as a bar and a count.
    const list = card.subtasks || [];
    if (list.length) {
      const done = list.filter(sub => sub.status === 'done').length, row = node('span', 'board-card-progress'), bar = node('span', 'board-card-bar'), fill = node('span', 'board-card-fill');
      fill.style.width = `${Math.round(done / list.length * 100)}%`; bar.append(fill);
      // The subtask running now (or "Subtasks") and the count on one line, the bar full width under them.
      const running = card.column === 'doing' ? list.find(sub => sub.status === 'running') : null, head = node('span', 'board-card-progress-head');
      head.append(node('span', 'board-card-progress-now', running ? running.title : 'Subtasks'), node('span', 'board-card-progress-text', `${done}/${list.length}`));
      row.append(head, bar);
      row.title = [subtaskLine(card)?.long, running ? `Running now: ${running.title}` : ''].filter(Boolean).join('. ');
      parts.push(row);
    }
    const meta = node('span', 'board-card-meta'), who = whoOf(card);
    const agent = node('span', `board-card-agent${who.provider ? '' : ' missing'}`);
    if (who.smart) agent.append(glyph(ICONS.smart)); else { const icon = node('i', `agent-icon ${who.provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true'); agent.append(icon); }
    const agentName = node('span', '', who.short || who.text); agent.append(agentName);
    agent.title = who.title ? who.title : who.smart ? `Auto, in ${who.text}${card.routingMode ? '' : ', as the workspace'}: ${card.split || list.length ? 'routing picks who splits it and who does each subtask, unless you choose one.' : 'routing picks the agent, model and effort when it runs.'}` : who.text;
    // Who does it sits in the top row, at the right of the status, so it never takes a row of its own.
    top.append(agent);
    const fact = (cls, icon, text, tip) => { const value = node('span', `board-card-fact ${cls}`); if (icon) value.append(glyph(icon)); value.append(node('span', '', text)); if (tip) value.title = tip; meta.append(value); return value; };
    // Before a card runs, including a draft, it says when its agent bills by use (#108).
    const charged = (card.draft || ['backlog', 'ready'].includes(card.column)) && card.agent && bills(card.agent.provider) ? billsLabel(card.agent.provider) : '';
    if (charged) fact('board-card-billing', '', charged, `${billsSentence(card.agent.provider)} You’re asked before it runs.`);
    if (card.checks?.length && !['doing', 'done'].includes(card.column)) fact('board-card-checks', ICONS.checks, `${card.checks.filter(check => check.done).length}/${card.checks.length}`, `Done means: ${plural(card.checks.length, 'check')}`);
    const after = (card.dependsOn || []).map(cardBy).filter(other => other && other.column !== 'done');
    if (after.length && (card.draft || ['backlog', 'ready'].includes(card.column))) fact('board-card-after', ICONS.waits, after.length === 1 ? after[0].title : `Waits for ${after.length}`, `Waits for ${after.map(other => `“${other.title}”`).join(', ')}`);
    // A card closed to agents says so; when the whole Plan is closed, the banner above says it once instead.
    if (card.closed && !board?.closed) { const lock = node('span', 'board-card-fact board-card-closed'); lock.append(lockIcon(), node('span', '', 'Closed')); lock.title = 'Closed to agents'; meta.append(lock); }
    if (card.commentCount) { const count = node('span', 'board-card-fact board-card-comments'); count.append(commentIcon(), node('span', '', String(card.commentCount))); count.title = plural(card.commentCount, 'comment'); meta.append(count); }
    const timed = schedulesOf(card), soon = timed.filter(sched => !sched.paused && sched.nextAt).sort((a, b) => a.nextAt.localeCompare(b.nextAt))[0];
    if (timed.some(sched => sched.missed)) fact('board-card-schedule missed', '', 'Scheduled run missed');
    else if (timed.some(sched => sched.waiting && !sched.paused)) fact('board-card-schedule', '', 'Waiting for a usage reset');
    else if (soon) fact('board-card-schedule', '', `Runs ${when(soon.nextAt)}`);
    if (meta.children.length) parts.push(meta);
    if (state?.detail && ['ready', 'doing'].includes(card.column)) parts.push(node('span', `board-card-reason${state.tone === 'trouble' ? ' trouble' : ''}`, state.detail));
    const live = liveOf(card);
    if (live && (live.running || live.needs)) { parts.push(liveLines(card, live, { agent: agentName })); item.classList.add('watching'); if (live.running) item.classList.add('live'); }
    item.append(...parts);
    item.title = state?.detail || card.title;
    item.setAttribute('aria-label', [card.draft ? '' : onCanvas ? STATUS[card.column] : '', card.title, card.group ? `group ${card.group}` : '', showRole ? `${ROLE[card.role]} role` : '', names.length ? `${names.length === 1 ? 'label' : 'labels'} ${listed(names)}` : '', who.smart ? `Auto routing, ${who.text}` : who.provider ? who.text : 'no agent yet', needs ? 'needs subtasks before it can run' : '', charged, subtaskLine(card)?.long || '', after.length ? `waits for ${listed(after.map(other => other.title))}` : '', card.commentCount ? plural(card.commentCount, 'comment') : '', card.closed ? 'closed to agents' : '', state?.text || '', state?.detail || '', live?.now || '', live?.usage.length ? `so far ${live.usage.join(', ')}` : '', timed.some(sched => sched.missed) ? 'a scheduled run was missed' : soon ? `scheduled to run ${when(soon.nextAt)}` : ''].filter(Boolean).join('. '));
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
  const blank = (column, at = null, prefill = {}) => ({ title: '', notes: '', labels: filter ? [allLabels().find(item => item.name.toLowerCase() === filter)?.name].filter(Boolean) : [], agent: null, auto: false, routingMode: null, folderId: null, dependsOn: [], checks: [], group: '', role: 'builder', artifact: null, check: '', files: '', tier: null, closed: false, split: false, column, revision: null, at, ...prefill });
  const editable = card => ({ title: card.title, notes: card.notes || '', labels: [...(card.labels || [])], agent: card.agent ? { ...card.agent } : null, auto: card.auto === true, routingMode: card.routingMode || null, folderId: card.folderId || null, dependsOn: [...(card.dependsOn || [])], checks: (card.checks || []).map(item => ({ ...item })), group: card.group || '', role: card.role || 'builder', artifact: card.artifact || null, check: card.check || '', files: (card.files || []).join(', '), tier: card.tier || null, closed: card.closed === true, split: card.split === true, column: card.column, revision: card.revision });
  const fileList = text => [...new Set(String(text || '').split(',').map(item => item.trim()).filter(Boolean))];
  const fields = value => JSON.stringify([value.title.trim(), value.notes.trim(), value.labels, value.agent?.provider || null, value.auto, value.routingMode || null, value.folderId, [...value.dependsOn].sort(), value.checks.map(item => [item.text.trim(), item.done]), value.group.trim(), value.role, value.artifact, value.check.trim(), fileList(value.files), value.tier, value.closed === true, value.split === true]);
  // Every group on the Plan, in the order first used.
  const allGroups = () => [...new Set(cards().map(card => card.group).filter(Boolean))];
  const dirty = () => { if (!draft) return false; if (selected === 'new') return Boolean(draft.title.trim() || draft.notes.trim()); const card = cardBy(selected); return card ? fields(draft) !== fields(editable(card)) : false; };
  function select(id) {
    if (selected && selected !== id && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = selected === id ? null : id; failure = ''; suggestConfirm = null;
    draft = selected && cardBy(selected) ? editable(cardBy(selected)) : null; drawn = null;
    render();
    // A card that's working shows its task beside the Plan: its messages, approvals, questions and Stop (#162 stage 5).
    const chosen = selected && cardBy(selected);
    if (chosen?.column === 'doing' && chosen.taskState?.id && api.getState().taskId !== chosen.taskState.id) openTask(chosen);
    if (selected) $('board-drawer-body').querySelector('input, textarea, button')?.focus();
  }
  function openNew(column = 'backlog', at = null, prefill = {}) {
    if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = 'new'; draft = blank(column, at, prefill); failure = ''; suggestConfirm = null; drawn = null; render();
    $('board-drawer-body').querySelector('.board-field-title')?.focus();
  }
  // Run Ready, or one group's Ready cards when a group is given.
  function openRun(group = null) {
    if (selected && selected !== 'run' && dirty() && !window.confirm('Leave this card without saving your changes?')) return;
    selected = 'run'; draft = null; failure = ''; suggestConfirm = null; drawn = null;
    picked = new Set(cards().filter(card => card.column === 'ready' && runnable(card) && (group === null || (card.group || NO_GROUP) === group)).map(card => card.id));
    const policy = board?.taskLimits || {}, typed = value => value === null || value === undefined ? '' : String(value);
    shared = { maxWorkingMinutes: typed(policy.maxWorkingMinutes), maxTokens: typed(policy.maxTokens), maxSpendUSD: typed(policy.maxSpendUSD) };
    render();
  }
  function closeDrawer() { if (dirty() && !window.confirm('Leave this card without saving your changes?')) return; const was = selected; selected = null; draft = null; failure = ''; suggestConfirm = null; render(); if (was) [...(shownCards()?.querySelectorAll(view === 'outline' ? '.board-outline-card' : '.board-card') || [])].find(item => item.dataset.card === was)?.focus(); }
  // Where the cards are drawn in the view now showing, so focus goes back to the card whose drawer closed in any view.
  const shownCards = () => view === 'canvas' ? $('board-space') : view === 'outline' ? $('board-outline') : $('board-columns');

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

  // The card opens as a dialog over the Plan: what the card says, its subtasks and what done means in the wide column,
  // and who does it, what it waits for and how it's sorted in the narrow one. Each part says which column it goes in.
  const slot = (element, name) => { element.dataset.slot = name; return element; };
  function editor(card) {
    const locked = card?.column === 'doing', parts = [];
    const title = node('input', 'board-input board-field-title'); title.value = draft.title; title.maxLength = board?.limits?.title || 200; title.placeholder = 'What needs doing'; title.setAttribute('aria-label', 'Card title'); title.disabled = locked;
    title.addEventListener('input', () => { draft.title = title.value; changed(); });
    const notes = node('textarea', 'board-input board-field-notes'); notes.value = draft.notes; notes.rows = 5; notes.maxLength = board?.limits?.notes || 20000; notes.placeholder = 'Details the agent needs: where, what, and anything to avoid'; notes.setAttribute('aria-label', 'Card description'); notes.disabled = locked;
    notes.addEventListener('input', () => { draft.notes = notes.value; changed(); });
    parts.push(slot(title, 'main'), slot(notes, 'main'));
    if (locked) parts.push(slot(node('p', 'board-note', 'An agent is working from this card. Stop it to change what it says.'), 'main'));
    // Labels are yours to sort by: the agent isn't told them, so they can change while it works.
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
    const labelsField = labelled('Labels', tags);
    // Closed to agents (#97): yours alone. Like labels it's not something the agent reads, so it saves with the card.
    const privacy = node('label', 'board-closed-edit'), shutBox = node('input'); shutBox.type = 'checkbox';
    shutBox.checked = board?.closed === true || draft.closed === true; shutBox.disabled = board?.closed === true || (locked && !draft.closed);
    shutBox.addEventListener('change', () => { draft.closed = shutBox.checked; changed(); });
    privacy.append(shutBox, lockIcon(), node('span', '', 'Closed to agents'));
    const privacyField = slot(labelled('Privacy', privacy, board?.closed ? 'The whole Plan is closed to agents. Open it to agents from the top of the Plan.' : locked ? 'An agent is working on this card. Stop it before closing it to agents.' : 'Keeps it out of every prompt, run, attachment and export.'), 'side');
    privacy.title = 'A closed card can’t run, be scheduled or attached, isn’t named to the cards after it, and is left out of exports. An agent allowed to read anywhere on this computer could still find Codeshi’s own files.';
    // Smart (#162) is chosen here like an agent: routing picks the agent, model and effort when the card runs, and for a
    // major card who splits it and who does each subtask that follows the card. Or choose an agent, and its model.
    // What the agent bills is said either way (#108): a subscription, or by use, which asks before the card runs.
    const billedNote = provider => { if (!provider) return ''; const account = api.getState().accounts?.[provider]; return bills(provider) ? ` ${billsSentence(provider)} You’re asked before it runs, as it may cost money.` : account?.billingSource === 'subscription' ? ` Uses your ${AGENT[provider]} subscription.` : ''; };
    const major = Boolean(draft.split || card?.subtasks?.length);
    const agentNote = () => { if (draft.auto) { const pick = autoPick(draft); return `${major ? 'Routing picks who splits this card and who does each subtask, unless you choose one on the subtask.' : 'Routing picks the agent, model and effort when the card runs.'} Now that would be ${pick.text.replace(/^\w+: /, '')}.${pick.error ? '' : billedNote(pick.provider)} ${draft.routingMode ? `${MODE[draft.routingMode]} for this card and its subtasks, whatever the workspace uses.` : `Mode follows the workspace, now ${MODE[smartMode()] || 'Smart'}, until you choose one.`}`; } return draft.agent ? `${major ? 'Splits this card into subtasks and does them, unless you choose another agent on a subtask.' : 'Does this card’s work.'}${billedNote(draft.agent.provider)}` : 'Choose Auto or an agent before the card can run.'; };
    const modelRow = node('div', 'board-model-row');
    const cell = (text, control) => { const box = node('div', 'board-agent-cell'); box.append(node('span', 'board-field-label', text), control); return box; };
    const drawModel = () => {
      modelRow.replaceChildren();
      if (!draft.agent) { modelRow.hidden = true; return; }
      modelRow.hidden = false;
      const models = window.relayModelPicker?.models?.(draft.agent.provider) || [], ids = models.map(row => row.id || row.model || row.value).filter(Boolean);
      if (draft.agent.model && !ids.includes(draft.agent.model)) ids.unshift(draft.agent.model);
      const model = node('select', 'board-input board-mini-select'); model.setAttribute('aria-label', 'Model'); model.disabled = locked;
      model.append(...[['', 'Default model'], ...ids.map(id => [id, modelLabel(draft.agent.provider, id)])].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
      model.value = draft.agent.model || ''; model.addEventListener('change', () => { draft.agent = { ...draft.agent, model: model.value || null }; changed(); });
      const effort = node('select', 'board-input board-mini-select'); effort.setAttribute('aria-label', 'Effort'); effort.disabled = locked;
      effort.append(...EFFORTS.map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
      effort.value = draft.agent.effort || ''; effort.addEventListener('change', () => { draft.agent = { ...draft.agent, effort: effort.value || null }; changed(); });
      modelRow.append(cell('Model', model), cell('Effort', effort));
    };
    const agentPick = node('select', 'board-input'); agentPick.setAttribute('aria-label', 'Agent'); agentPick.disabled = locked;
    agentPick.append(...[['auto', 'Auto (routing picks)'], ...AGENTS].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
    agentPick.value = draft.auto ? 'auto' : draft.agent?.provider || '';
    if (!agentPick.value) { const none = node('option', '', 'Choose…'); none.value = ''; agentPick.prepend(none); agentPick.value = ''; }
    agentPick.addEventListener('change', () => { const value = agentPick.value; if (value === 'auto') { draft.auto = true; draft.agent = null; } else { draft.auto = false; draft.agent = { provider: value, model: null, effort: null }; } drawModel(); modeField.hidden = !draft.auto; agentField.querySelector('.board-field-note').textContent = agentNote(); changed(); });
    const agentField = node('div', 'board-field'), agentRow = node('div', 'board-agent-row');
    agentRow.append(cell('Agent', agentPick), modelRow); agentField.append(agentRow, node('span', 'board-field-note', agentNote()));
    drawModel();
    parts.push(slot(agentField, 'side'));
    // Auto's mode: the workspace's until you choose one for this card, which then stays with it. Its subtasks on Auto
    // use it too, as a card's task runs in one mode.
    const modeNote = () => draft.routingMode ? `${MODE[draft.routingMode]} for this card and its subtasks, whatever the workspace uses.` : `Follows the workspace, now ${MODE[smartMode()] || 'Smart'}, until you choose one here.`;
    // Mode and Size sit with the agent, under one heading: Mode picks how Auto chooses, Size how big the card is.
    const modeControls = node('div', 'board-mode');
    const drawMode = () => {
      const follow = button('Follow the workspace', () => { draft.routingMode = null; drawMode(); refreshNotes(); changed(); }, 'text-link board-mode-follow');
      follow.hidden = !draft.routingMode; follow.disabled = locked;
      modeControls.replaceChildren(node('span', 'board-field-label', 'Mode'), segment('Mode', MODES.map(([value, text]) => [value, text, `board-mode-icon ${value}`]), modeOf(draft), value => { draft.routingMode = value; drawMode(); refreshNotes(); changed(); }, locked), follow);
    };
    const refreshNotes = () => { agentField.querySelector('.board-field-note').textContent = agentNote(); };
    const modeField = modeControls;
    drawMode(); modeField.hidden = !draft.auto; agentField.insertBefore(modeControls, agentField.querySelector('.board-field-note'));
    if ((board?.folders || []).length > 1) {
      const folder = node('select', 'board-input'); folder.setAttribute('aria-label', 'Folder the card works in'); folder.disabled = locked;
      folder.append(...board.folders.map(item => [item.id, item.name]).map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
      folder.value = draft.folderId || board.folders[0].id; folder.addEventListener('change', () => { draft.folderId = folder.value === board.folders[0].id && !draft.folderId ? null : folder.value; changed(); });
      parts.push(slot(labelled('Folder', folder, 'The one folder the agent works in. A card runs in a single folder; the first is used unless you choose another.'), 'side'));
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
      parts.push(slot(labelled('Waits for', waits, 'It starts after these finish and pass their tests.'), 'side'));
    }
    // What a plan step had (#162): its group, what it produces and its check, each shown. The role sits above the title.
    const group = node('input', 'board-input'); group.value = draft.group; group.maxLength = board?.limits?.group || 60; group.placeholder = 'A phase, such as Build or QA'; group.setAttribute('aria-label', 'Group');
    const groups = node('datalist'); groups.id = 'board-group-options'; group.setAttribute('list', groups.id);
    groups.append(...allGroups().map(name => { const option = node('option'); option.value = name; return option; }));
    group.addEventListener('input', () => { draft.group = group.value; changed(); });
    const groupRow = node('div', 'board-group-edit'); groupRow.append(group, groups);
    const choose = (label, options, current, set) => { const pick = node('select', 'board-input'); pick.setAttribute('aria-label', label); pick.disabled = locked; pick.append(...options.map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; })); pick.value = current; pick.addEventListener('change', () => { set(pick.value); changed(); }); return pick; };
    const check = node('input', 'board-input'); check.value = draft.check; check.maxLength = 300; check.placeholder = 'npm test'; check.setAttribute('aria-label', 'Test command'); check.disabled = locked;
    check.addEventListener('input', () => { draft.check = check.value; changed(); });
    // The role, in the colour it has on the card in Columns and Canvas, above the title: who the agent works as.
    const rolePick = choose('Role', ROLES, draft.role, value => { draft.role = value; rolePick.dataset.role = value; });
    rolePick.className = 'orchestration-step-role board-role-pick'; rolePick.dataset.role = draft.role;
    rolePick.title = 'Role: told to the agent, so it works as that specialist. QA and Reviewer cards check the work before them.';
    const roleRow = slot(node('div', 'board-role-row'), 'lead'); roleRow.append(rolePick);
    parts.push(roleRow);
    parts.push(slot(labelled('Test command', check, 'Runs when the agent finishes. If it passes, the cards after this one can start; if it fails, they wait for you. Empty uses the command marked in Run.'), 'side'), slot(labelled('Produces', choose('What it produces', PRODUCES, draft.artifact || '', value => { draft.artifact = value || null; }), 'Its report is passed to the cards after it as this.'), 'side'), slot(labelled('Group', groupRow, 'A phase. The List runs and stops a group together.'), 'side'));
    // Labels are only for you to sort by: the agent isn't told them.
    labelsField.dataset.slot = 'side'; labelsField.append(node('span', 'board-field-note', 'Only for you to sort by. The agent isn’t told them.'));
    parts.push(labelsField, privacyField);
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
    const checksField = labelled('Done means', checks, 'The agent is told these. You tick them when you review it.'); checksField.insertBefore(addCheck, checksField.querySelector('.board-field-note')); checksField.classList.add('board-done-means');
    parts.push(slot(checksField, 'main'));
    const save = button(selected === 'new' ? 'Add card' : 'Save', save$ , 'primary-button board-save');
    const revert = button('Revert', () => { draft = editable(cardBy(selected)); drawn = null; render(); }, 'text-link board-revert');
    const saving = slot(node('div', 'board-save-row'), 'foot'); saving.append(revert, save);
    parts.push(saving);
    return parts;
  }
  function save$() {
    if (!draft?.title.trim()) return;
    const input = { title: draft.title, notes: draft.notes, labels: draft.labels, agent: draft.auto ? null : draft.agent, auto: draft.auto, routingMode: draft.auto ? draft.routingMode || null : null, folderId: draft.folderId, dependsOn: draft.dependsOn, checks: draft.checks.filter(item => item.text.trim()), group: draft.group.trim() || null, role: draft.role, artifact: draft.artifact, check: draft.check.trim() || null, files: fileList(draft.files), tier: draft.tier, closed: draft.closed === true, split: draft.split === true };
    if (selected === 'new') act('/api/board/cards', { ...input, column: draft.column, ...(draft.at ? { at: draft.at } : {}) }, result => { selected = result.card.id; draft = editable(result.card); drawn = null; api.announce(`Added “${result.card.title}” to ${COLUMNS.find(([id]) => id === result.card.column)[1]}.`); });
    else act(`/api/board/cards/${selected}/edit`, { ...input, revision: draft.revision }, result => { draft = editable(result.card); drawn = null; api.announce('Card saved.'); });
  }
  // A card's task opens in the chat beside the Plan.
  const openTask = card => { showChat(); window.relayTaskThreads?.select(card.taskState.id); };
  // Accept or discard drafted cards (#162), recording a server-backed Undo/Redo step when an undoId is returned.
  async function draftAction(action, ids, announcement, onDone) {
    return act('/api/board/drafts', { action, ids }, result => {
      onDone?.(result);
      if (result?.undoId) {
        let currentUndoId = result.undoId;
        const past = action === 'accept' ? 'Accepted' : 'Discarded';
        const label = `${past} ${plural(ids.length, 'draft')}`;
        const entry = {
          label,
          anyView: true,
          async undo() {
            const undoRes = await act('/api/board/drafts', { action: 'undo', undoId: currentUndoId }, () => { draftNotice = null; });
            return Boolean(undoRes);
          },
          async redo() {
            const redoRes = await act('/api/board/drafts', { action, ids }, nextRes => {
              if (nextRes?.undoId) currentUndoId = nextRes.undoId;
              if (action === 'discard' && ids.includes(selected)) { selected = null; draft = null; }
              draftNotice = { text: `${label}.`, entry };
            });
            return Boolean(redoRes);
          },
        };
        undos.push(entry);
        if (undos.length > 100) undos.shift();
        redos = [];
        draftNotice = { text: `${label}.`, entry };
        refreshTools();
      }
      api.announce(announcement);
    });
  }
  // Exact agent, model and effort that Suggest next (#162) will use when confirmed.
  function suggestPick(card, mode = smartMode()) {
    const state = api.getState();
    const routed = api.routeFor?.(card?.notes || card?.title || 'Suggest follow-up cards', 0, mode, { plan: true });
    if (routed?.error) return { error: routed.error };
    const provider = routed ? routed.provider : (state.provider || 'codex');
    const model = routed ? (routed.model || null) : (state.model || null);
    const effort = routed ? (routed.effort || null) : (state.effort || null);
    const modelLabel = routed?.modelName || (model ? (window.relayModelPicker?.modelName?.(provider, model) || model) : 'default model');
    const effortText = effort ? `${effort[0].toUpperCase()}${effort.slice(1)} effort` : '';
    const who = [AGENT[provider] || provider, modelLabel, effortText].filter(Boolean).join(' · ');
    const billed = bills(provider);
    const account = provider ? state.accounts?.[provider] : null;
    const usageNote = billed ? `${billsSentence(provider)} Suggesting may cost money.` : account?.billingSource === 'subscription' ? `Uses your ${AGENT[provider] || provider} subscription.` : '';
    return { provider, model, effort, who, usageNote, billed, mode };
  }
  function addNext(card) {
    const nextAt = card.at ? { x: Math.min(100000, card.at.x + STEP_X), y: card.at.y } : null;
    openNew('backlog', nextAt, { dependsOn: [card.id], group: card.group || '', folderId: card.folderId || null });
  }
  function addNextButton(card) {
    const limit = board?.limits?.cards || 300, full = cards().length >= limit;
    const value = button('Add next', () => addNext(card));
    value.disabled = busy || full;
    value.title = full ? `This Plan already has ${limit} cards. Remove some finished cards first.` : 'Write a new card that waits for this one, without an agent.';
    return value;
  }
  function suggestNextButton(card) {
    const limit = board?.limits?.cards || 300, full = cards().length >= limit, running = board?.suggest?.status === 'running';
    const why = shut(card) ? 'Closed to agents. Open it to agents before suggesting next cards.' : full ? `This Plan already has ${limit} cards. Remove some finished cards first.` : running ? 'Wait for the current suggestion to finish, or stop it first.' : dirty() ? 'Save your changes first.' : '';
    const value = button('Suggest next', () => { suggestConfirm = suggestConfirm === card.id ? null : card.id; drawn = null; renderDrawer(); });
    value.disabled = busy || Boolean(why);
    value.setAttribute('aria-expanded', String(suggestConfirm === card.id));
    value.title = why || 'Have an agent suggest 1 to 3 follow-up cards as drafts, reading only.';
    return value;
  }
  function suggestPanel(card) {
    if (suggestConfirm !== card.id) return [];
    const box = node('div', 'board-suggest-confirm'), pick = suggestPick(card), limit = board?.limits?.cards || 300;
    const lead = node('p', 'board-suggest-lead', pick.error ? pick.error : `Suggest follow-up cards with ${pick.who}.`);
    const note = node('p', 'board-suggest-note', pick.error ? 'Choose an agent or connect one in the message box before suggesting.' : `One read-only run. Counts toward your usage.${pick.usageNote ? ` ${pick.usageNote}` : ''} Suggested cards arrive as drafts for you to accept or discard.`);
    const row = node('div', 'board-suggest-actions');
    const cancel = button('Cancel', () => { suggestConfirm = null; drawn = null; renderDrawer(); }, 'secondary-button');
    const go = button('Suggest cards', () => {
      if (pick.error) { failure = pick.error; showError(); return; }
      if (pick.billed && window.relayBillingConfirmed !== true && !window.confirm(`Run Suggest next with charges?\n\n${billsSentence(pick.provider)} This read-only run may cost money.\n\nTo stop this question for this session, turn on Allow API and unconfirmed billing in Settings.`)) return;
      suggestConfirm = null;
      act(`/api/board/cards/${card.id}/suggest`, { provider: pick.provider, model: pick.model, effort: pick.effort, billingConfirmed: pick.billed ? true : window.relayBillingConfirmed === true }, result => {
        if (result?.suggest && board) board.suggest = result.suggest;
        api.announce(`Suggesting next cards after “${card.title}”.`);
      });
    }, 'primary-button');
    go.disabled = busy || Boolean(pick.error) || shut(card) || board?.suggest?.status === 'running' || cards().length >= limit;
    row.append(cancel, go);
    box.append(lead, note, row);
    return [box];
  }
  // What can be done with a card where it is now: the one or two things that move it on as full buttons, then the rest as
  // a short list of rows with icons, like a menu, and Remove on its own at the end. Each row keeps its label as its text.
  const ACTION_ICONS = {
    'Move to Backlog': 'M4 8h16v11H4z|M6 5h12l2 3H4z|M10 12h4',
    'Suggest next': ICONS.smart,
    'Add next': 'M12 5v14|M5 12h14',
    'Attach to message': 'M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
    'Open its task': 'M14 4h6v6|M20 4l-9 9|M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    Remove: 'M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13'
  };
  function actionRow(value) {
    const label = value.textContent;
    value.classList.remove('secondary-button', 'text-link'); value.classList.add('board-action-row');
    const text = node('span', 'board-action-label', label);
    value.replaceChildren(...(ACTION_ICONS[label] ? [glyph(ACTION_ICONS[label])] : []), text);
    return value;
  }
  function actions(card) {
    const box = node('div', 'board-actions'), row = node('div', 'board-actions-main'), quiet = node('div', 'board-actions-more'), next = node('div', 'board-actions-next'), state = stateOf(card);
    const link = actionRow;
    const move = (text, column, cls) => button(text, () => act(`/api/board/cards/${card.id}/move`, { column }), cls);
    const remove = actionRow(button('Remove', () => { if (window.confirm(`Remove “${card.title}” from the board?`)) act(`/api/board/cards/${card.id}/remove`, {}, () => { selected = null; draft = null; api.announce('Card removed.'); }); }, 'board-remove'));
    quiet.setAttribute('role', 'group'); quiet.setAttribute('aria-label', 'More for this card');
    box.append(row, quiet, next);
    // A draft (#162) is accepted or discarded; nothing else runs it.
    if (card.draft) {
      row.append(button('Accept', () => draftAction('accept', [card.id], `“${card.title}” accepted.`), 'primary-button'), button('Discard', () => draftAction('discard', [card.id], 'Draft discarded.', () => { selected = null; draft = null; }), 'secondary-button'));
      next.append(suggestNextButton(card), addNextButton(card));
      return box;
    }
    if (card.column === 'backlog') { row.append(move('Move to Ready', 'ready', needsSubtasks(card) ? 'secondary-button' : 'primary-button')); }
    if (card.column === 'ready') {
      const pick = card.auto && !card.agent && !shut(card) ? autoPick(card) : null, why = shut(card) ? 'Closed to agents. Open it to agents to run it.' : !runnable(card) ? notRunnable(card) : pick?.error ? pick.error : dirty() ? 'Save your changes first.' : '';
      const run = button('Run', () => { const chosen = assignments([card]); if (chosen.error) { failure = chosen.error; showError(); return; } const billing = billingFor([card], chosen.assignments); if (!billing) return; act('/api/board/run', { ids: [card.id], assignments: chosen.assignments, ...billing }, () => api.announce(`“${card.title}” is running as a task.`)); }, 'primary-button');
      run.disabled = Boolean(why); run.title = why || (pick ? `Run this card as its own task. ${pick.text}.` : 'Run this card as its own task.');
      row.append(run, ...(card.agent ? [scheduleButton(card)] : []));
      quiet.append(link(move('Move to Backlog', 'backlog')));
    }
    if (card.column === 'doing') row.append(button('Open its task', () => openTask(card), 'primary-button'), button(card.taskState?.status === 'running' ? 'Stop' : 'Cancel', () => act(`/api/board/cards/${card.id}/stop`)));
    if (card.column === 'review') {
      const accept = button('Accept', () => act(`/api/board/cards/${card.id}/accept`, {}, () => api.announce(`“${card.title}” is done.`)), 'primary-button');
      if (card.taskState?.hasWorktree) { row.append(button('Review and merge', () => openTask(card), 'primary-button')); accept.className = 'secondary-button'; accept.disabled = true; accept.title = state?.detail || ''; }
      row.append(accept);
      // Its tests hold the cards after it (#162): check it again, or let them build on it anyway.
      const tests = card.taskState?.tests;
      if (card.taskState?.status === 'complete' && tests && tests !== 'running' && tests !== 'passed') row.append(button('Check again', () => act(`/api/board/cards/${card.id}/recheck`, {}, () => api.announce('Checking the card again.'))));
      if (card.taskState?.holds && tests !== 'running' && card.taskState.review?.status !== 'repairing') row.append(button('Continue anyway', () => act(`/api/board/cards/${card.id}/continue`, {}, () => api.announce('The cards after it can start.'))));
      if (!card.taskState?.hasWorktree) row.append(button('Send back…', () => sendBack(card)));
      if (card.taskState) quiet.append(link(button('Open its task', () => openTask(card))));
    }
    if (card.column === 'done') { row.append(move('Reopen', 'ready'), ...(card.agent ? [scheduleButton(card)] : [])); }
    next.append(suggestNextButton(card), addNextButton(card));
    quiet.append(link(attachButton(card)));
    if (['backlog', 'ready', 'done'].includes(card.column)) quiet.append(remove);
    // The action that moves the card on is the last one, at the far right of the bar.
    row.append(...[...row.children].sort((a, b) => a.classList.contains('primary-button') - b.classList.contains('primary-button')));
    if (!row.children.length) row.remove();
    if (!quiet.children.length) quiet.remove();
    return box;
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
      const origin = card.draft.batch?.kind === 'suggest' && card.draft.batch.cardTitle ? ` as a follow-up to “${card.draft.batch.cardTitle}”` : card.source?.goal ? ' from your message' : '';
      const kind = draftKind(card), target = card.draft.into ? cardBy(card.draft.into) : null;
      if (kind === 'change') {
        // A change to a card already on the Plan: what changed, and the short fields as they were.
        const what = (card.draft.changed || []).map(key => CHANGED[key]).filter(Boolean), was = card.draft.was?.fields || {};
        parts.push(node('p', 'board-status', `${by} changed this card${what.length ? `: ${listed(what)}` : ''}. Accept to keep the change, or discard to put it back as it was.`));
        const before = ['title', 'group', 'role', 'tier'].filter(key => key in was);
        if (before.length) { const list = node('ul', 'board-draft-was'); list.setAttribute('aria-label', 'Before the change'); list.append(...before.map(key => node('li', '', `Was ${CHANGED[key]}: ${was[key] == null || was[key] === '' ? 'none' : key === 'role' ? ROLE[was[key]] || was[key] : String(was[key])}`))); parts.push(list); }
      } else if (kind === 'remove') parts.push(node('p', 'board-status', target ? `${by} would merge this card into “${target.title}”. Accept to remove it, and the cards that wait for it wait for “${target.title}” instead. Discard to keep it.` : `${by} would remove this card. Accept to remove it, or discard to keep it.`));
      else parts.push(node('p', 'board-status', `${by} drafted this card${origin}. Edit it, then accept or discard it. Nothing runs until you accept it.`));
      if (card.draft.notes?.length) { const list = node('ul', 'board-draft-notes'); list.setAttribute('aria-label', 'What the plan checks found'); list.append(...card.draft.notes.map(text => node('li', '', text))); parts.push(list); }
    }
    const suggest = board?.suggest;
    if (suggest?.cardId === card.id && ['running', 'failed', 'interrupted'].includes(suggest.status)) {
      const box = node('div', `board-suggest-status${suggest.status === 'running' ? ' running' : ' trouble'}`), detail = [AGENT[suggest.provider] || suggest.provider, suggest.model, suggest.phase && suggest.phase !== 'starting' ? suggest.phase : 'reading the project', suggest.toolCount ? plural(suggest.toolCount, 'tool call') : ''].filter(Boolean).join(' · ');
      if (suggest.status === 'running') {
        box.append(node('p', 'board-suggest-lead', 'Suggesting next cards…'), node('p', 'board-suggest-note', detail));
        const stop = button('Stop', () => act('/api/board/suggest/stop', {}, () => api.announce('Stopping suggestions.')), 'secondary-button');
        stop.disabled = busy; box.append(stop);
      } else {
        box.append(node('p', 'board-suggest-lead', suggest.status === 'interrupted' ? 'Stopped suggesting next cards.' : 'Couldn’t suggest next cards.'), node('p', 'board-suggest-note', suggest.summary || 'Try again when ready.'));
        const dismiss = button('Dismiss', () => act('/api/board/suggest/dismiss', {}, () => api.announce('Dismissed.')), 'secondary-button');
        dismiss.disabled = busy; box.append(dismiss);
      }
      parts.push(box);
    }
    // While it runs: who's on it now, what it's doing and what it has used, kept up to date in place (#162 stage 5).
    // One box says all of it, so a running card doesn't also get a separate "Working" line above it.
    const watching = liveOf(card);
    if (card.column === 'doing' && state && !(watching && (watching.running || watching.needs))) parts.push(node('p', 'board-status', state.detail ? `${state.text}: ${state.detail}` : state.text));
    else if (state?.detail && watching) parts.push(node('p', 'board-status', state.detail));
    if (watching) { const lines = liveLines(card, watching, { withWho: true }); lines.classList.add('board-watch'); lines.setAttribute('aria-label', 'This card’s run'); parts.push(lines); }
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
    const findings = reviewBox(card); if (findings) parts.push(findings);
    if (card.column === 'done' && card.acceptedAt) parts.push(node('p', 'board-status done', `Accepted by you, ${when(card.acceptedAt)}.`));
    return parts;
  }
  // A review card's verdict (#89): what it found, on which card, and how the one repair round went.
  const REPAIR = { pending: 'Waiting to repair', running: 'Repairing', done: 'Repaired', failed: 'Repair didn’t finish', skipped: 'Not repaired' };
  function reviewBox(card) {
    const review = card.taskState?.review, independent = card.taskState?.notIndependent ? node('p', 'board-result-facts', 'Not independent: it ran on an agent that built what it checks, as no other agent could take it.') : null;
    if (!review) return independent;
    const box = node('section', 'board-review'); box.setAttribute('aria-label', 'Review');
    const lead = review.status === 'passed' ? (review.round ? `Passed after one repair round. ${plural(review.earlier, 'problem')} found the first time.` : 'Passed: nothing must change before the cards after it build on it.')
      : review.status === 'repairing' ? `Found ${plural(review.findings.length, 'problem')}. One repair round, then a second review.`
      : review.status === 'reviewing' ? 'Reviewing the repairs. This is the last review round.'
      : review.verdict ? `${review.round ? 'Still found' : 'Found'} ${plural(review.findings.length, 'problem')}.` : 'It didn’t end with a verdict.';
    box.append(node('p', 'board-review-lead', lead));
    if (review.reason && review.status !== 'passed') box.append(node('p', 'board-result-facts', review.waiting || review.reason));
    if (review.findings.length) {
      const list = node('ol', 'board-review-findings'); list.setAttribute('aria-label', 'Findings');
      list.append(...review.findings.map(item => { const row = node('li'); row.append(node('span', 'board-review-problem', item.problem)); const meta = [item.cardTitle ? `On “${item.cardTitle}”` : item.card ? `Names “${item.card}”, which it didn’t check` : 'No card named', item.file, item.fix ? `Fix: ${item.fix}` : ''].filter(Boolean).join(' · '); if (meta) row.append(node('span', 'board-review-meta', meta)); return row; }));
      box.append(list);
    }
    if (review.repairs.length) {
      const list = node('ul', 'board-review-repairs'); list.setAttribute('aria-label', 'Repairs');
      list.append(...review.repairs.map(item => node('li', `board-review-repair ${item.status}`, `${REPAIR[item.status] || item.status}: “${item.title}”${item.tests ? ` · ${TESTS[item.tests]?.toLowerCase() || `tests ${item.tests}`}` : ''}${item.reason ? ` · ${item.reason}` : ''}`)));
      box.append(list);
    }
    if (independent) box.append(independent);
    return box;
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
  const SUB_STATE = { pending: 'To do', running: 'Working', done: 'Done' };
  const EFFORTS = [['', 'Default effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
  // Who does a subtask: what its card says (Smart, or the card's agent), Smart routing, or an agent and model you choose.
  // A change saves at once: it's a choice about who works, not what the card says.
  function whoPicker(card, sub, index) {
    const wrap = node('span', 'board-subtask-who'), mode = sub.agent ? sub.agent.provider : sub.auto ? 'smart' : '';
    const cardChoice = card.auto ? `Auto · ${modeName(card)}` : card.agent ? AGENT[card.agent.provider] : 'the card’s agent';
    const pick = node('select', 'board-input board-mini-select'); pick.setAttribute('aria-label', `Who does subtask ${index + 1}`);
    pick.append(...[['', `Card: ${cardChoice}`], ['smart', `Auto · ${modeName(card)}`], ...AGENTS].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
    pick.value = mode; pick.disabled = busy;
    const save = changes => act(`/api/board/cards/${card.id}/subtasks`, { action: 'edit', subtaskId: sub.id, ...changes }, () => api.announce(`Subtask ${index + 1} saved.`));
    pick.addEventListener('change', () => save(pick.value === '' ? { agent: null, auto: false } : pick.value === 'smart' ? { auto: true } : { agent: { provider: pick.value, model: null, effort: null } }));
    wrap.append(pick);
    if (sub.agent) {
      const models = window.relayModelPicker?.models?.(sub.agent.provider) || [], model = node('select', 'board-input board-mini-select');
      model.setAttribute('aria-label', `Model for subtask ${index + 1}`);
      const ids = models.map(row => row.id || row.model || row.value).filter(Boolean);
      if (sub.agent.model && !ids.includes(sub.agent.model)) ids.unshift(sub.agent.model);
      model.append(...[['', 'Default model'], ...ids.map(id => [id, modelLabel(sub.agent.provider, id)])].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
      model.value = sub.agent.model || ''; model.disabled = busy;
      model.addEventListener('change', () => save({ agent: { ...sub.agent, model: model.value || null } }));
      const effort = node('select', 'board-input board-mini-select'); effort.setAttribute('aria-label', `Effort for subtask ${index + 1}`);
      effort.append(...EFFORTS.map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
      effort.value = sub.agent.effort || ''; effort.disabled = busy;
      effort.addEventListener('change', () => save({ agent: { ...sub.agent, effort: effort.value || null } }));
      wrap.append(model, effort);
    }
    return wrap;
  }
  const subWho = (card, sub) => sub.provider ? [AGENT[sub.provider] || sub.provider, sub.model].filter(Boolean).join(' · ') : sub.agent ? [AGENT[sub.agent.provider], modelLabel(sub.agent.provider, sub.agent.model)].filter(Boolean).join(' · ') : sub.auto || (!sub.agent && card.auto) ? modeName(card) : card.agent ? AGENT[card.agent.provider] : '';
  let splitOne = null;
  function subtasksPanel(card) {
    const list = card.subtasks || [];
    if (!list.length && !card.split && card.column === 'done') return [];
    if (subEdit && subEdit.cardId !== card.id) subEdit = null;
    const box = node('section', 'board-subtasks'), live = card.column === 'doing' && card.taskState?.status === 'running';
    box.setAttribute('aria-label', 'Subtasks');
    const done = list.filter(item => item.status === 'done').length, head = node('div', 'board-subtasks-head');
    head.append(node('h4', 'board-field-label', list.length ? `Subtasks · ${done} of ${list.length} done` : 'Subtasks'));
    const splitting = board?.suggest?.kind === 'split' && board.suggest.status === 'running' && (board.suggest.cardIds || []).includes(card.id);
    const canSplit = !card.draft && !shut(card) && !['doing', 'done'].includes(card.column) && !list.some(item => item.status !== 'pending') && !splitting;
    const tools$ = node('div', 'board-subtasks-tools');
    if (canSplit) { const split = button(list.length ? 'Split again…' : 'Split with an agent…', () => { splitOne = splitOne === card.id ? null : card.id; drawn = null; renderDrawer(); }, 'secondary-button'); split.disabled = busy || board?.suggest?.status === 'running'; split.setAttribute('aria-expanded', String(splitOne === card.id)); if (board?.suggest?.status === 'running') split.title = 'Wait for the agent working on the Plan to finish.'; tools$.append(split); }
    if (!card.draft && !(card.splitting && live) && !splitting && subEdit?.id !== 'new' && card.column !== 'done') { const add = button('Add', () => { subEdit = { cardId: card.id, id: 'new', title: '', instructions: '', tier: 'standard', agent: '' }; drawn = null; renderDrawer(); $('board-drawer-body').querySelector('.board-subtask-form .board-input')?.focus(); }, 'secondary-button'); add.disabled = busy; add.title = 'Write a subtask yourself'; tools$.append(add); }
    head.append(tools$); box.append(head);
    if (splitOne === card.id && canSplit) box.append(splitPanel([card.id], () => { splitOne = null; drawn = null; renderDrawer(); }));
    if (!list.length) box.append(node('p', `board-subtasks-empty${needsSubtasks(card) && !card.draft ? ' needs' : ''}`, splitting ? 'An agent is splitting it into subtasks now, reading only.' : card.draft ? 'This card runs through its subtasks. Accept it, then split it with an agent or write them yourself.' : card.split ? 'This card runs through its subtasks, so it needs at least one before it can run. Split it with an agent, or add them yourself.' : 'Optional. Split the card into subtasks to run it in smaller steps, each with its own agent if you like.'));
    const rows = node('ol', 'board-subtask-list');
    list.forEach((sub, index) => {
      const row = node('li', 'board-subtask'), top = node('div', 'board-subtask-head');
      // A subtask left running by a task that ended was stopped there; Run starts it again.
      const stateText = sub.status === 'running' && !live ? 'Stopped' : SUB_STATE[sub.status], state = node('span', 'board-subtask-state', stateText);
      state.dataset.tone = sub.status === 'done' ? 'done' : sub.status === 'running' ? (live ? 'running' : 'trouble') : '';
      top.append(node('span', 'board-subtask-number', `${index + 1}`), node('span', 'board-subtask-title', sub.title));
      const editable$ = sub.status === 'pending' && !card.draft && subEdit?.id !== sub.id;
      if (editable$) {
        const edit = button('Edit', () => { subEdit = { cardId: card.id, id: sub.id, title: sub.title, instructions: sub.instructions || '', tier: sub.tier, agent: sub.agent?.provider || '' }; drawn = null; renderDrawer(); $('board-drawer-body').querySelector('.board-subtask-form .board-input')?.focus(); }, 'text-link');
        const remove = button('Remove', () => act(`/api/board/cards/${card.id}/subtasks`, { action: 'remove', subtaskId: sub.id }, () => api.announce('Subtask removed.')), 'text-link board-remove');
        edit.setAttribute('aria-label', `Edit subtask ${index + 1}`); remove.setAttribute('aria-label', `Remove subtask ${index + 1}`); edit.disabled = remove.disabled = busy;
        const links = node('span', 'board-subtask-links'); links.append(edit, remove); top.append(links);
      } else top.append(state);
      row.dataset.status = sub.status;
      row.append(top);
      if (sub.instructions && subEdit?.id !== sub.id) row.append(node('p', 'board-subtask-notes', sub.instructions));
      if (sub.status === 'done' && sub.summary) row.append(node('p', 'board-subtask-summary', sub.summary));
      if (subEdit?.id === sub.id) row.append(subtaskForm(card));
      else {
        // Its size only steers Smart routing, so it shows only where Smart picks who does it.
        const foot = node('div', 'board-subtask-foot'), smart = !sub.agent && (sub.auto || card.auto);
        if (smart && sub.status === 'pending') { const size = node('span', 'board-subtask-size', SIZES.find(([value]) => value === sub.tier)?.[1] || 'Standard'); size.title = 'Auto picks a model for a subtask this size.'; foot.append(size); }
        if (sub.status === 'pending' && !card.draft) foot.append(whoPicker(card, sub, index));
        else { const who = subWho(card, sub); if (who) foot.append(node('span', 'board-subtask-agent', who)); if (sub.by?.kind === 'you') foot.append(node('span', 'board-subtask-agent', 'Added by you')); }
        row.append(foot);
      }
      rows.append(row);
    });
    if (list.length) box.append(rows);
    if (subEdit?.id === 'new') box.append(subtaskForm(card));
    const foot = node('div', 'board-subtask-foot board-subtasks-foot');
    if (card.column === 'doing' && list.some(item => item.status === 'pending')) {
      const pause = button(card.subtasksPaused ? 'Don’t pause' : 'Pause after this subtask', () => act(`/api/board/cards/${card.id}/subtasks`, { action: card.subtasksPaused ? 'resume' : 'pause' }, () => api.announce(card.subtasksPaused ? 'It carries on after this subtask.' : 'It pauses after this subtask.')));
      pause.disabled = busy; foot.append(pause);
    }
    if (!['doing'].includes(card.column) && list.length && !card.draft) { const clear = button('Clear subtasks', () => { if (window.confirm('Clear these subtasks? The card then needs new ones before it can run.')) act(`/api/board/cards/${card.id}/subtasks`, { action: 'clear' }, () => api.announce('Subtasks cleared.')); }, 'text-link board-remove'); clear.disabled = busy; foot.append(clear); }
    if (foot.children.length) box.append(foot);
    return [box];
  }
  function subtaskForm(card) {
    const form = node('div', 'board-subtask-form'), adding = subEdit.id === 'new';
    const title = node('input', 'board-input'); title.value = subEdit.title; title.maxLength = 200; title.placeholder = 'What this subtask does'; title.setAttribute('aria-label', 'Subtask title');
    const notes = node('textarea', 'board-input'); notes.value = subEdit.instructions; notes.rows = 3; notes.maxLength = 4000; notes.placeholder = 'Instructions, and how to know it’s done'; notes.setAttribute('aria-label', 'Subtask instructions');
    title.addEventListener('input', () => { subEdit.title = title.value; save.disabled = busy || !title.value.trim(); });
    notes.addEventListener('input', () => { subEdit.instructions = notes.value; });
    // Who does it is chosen on the subtask's row once it exists; a new one can say it here.
    const who = node('select', 'board-input'); who.setAttribute('aria-label', 'Who does the subtask');
    who.append(...[['', `As the card (${card.auto ? `Auto · ${modeName(card)}` : card.agent ? AGENT[card.agent.provider] : 'its agent'})`], ['smart', `Auto · ${modeName(card)}`], ...AGENTS].map(([value, text]) => { const option = node('option', '', text); option.value = value; return option; }));
    who.value = subEdit.agent; who.addEventListener('change', () => { subEdit.agent = who.value; });
    const row = node('div', 'board-subtask-form-row');
    row.append(segment('Subtask size', SIZES, subEdit.tier, value => { subEdit.tier = value; }, false), ...(adding ? [who] : []));
    const cancel = button('Cancel', () => { subEdit = null; drawn = null; renderDrawer(); }, 'text-link');
    const save = button(adding ? 'Add' : 'Save', () => {
      const input = { title: subEdit.title, instructions: subEdit.instructions, tier: subEdit.tier, ...(adding ? subEdit.agent === 'smart' ? { auto: true } : { agent: subEdit.agent ? { provider: subEdit.agent } : null } : {}) };
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
    if (!ready.length) { parts.push(node('p', 'board-note', 'Nothing is in Ready. Move cards there, with Auto or an agent each, to run them.')); return parts; }
    const flow = inFlow();
    const blocked = card => !runnable(card) ? notRunnable(card) : (onAuto(card) && autoPick(card).error) || (card.dependsOn || []).map(cardBy).filter(item => item && item.column !== 'done' && !picked.has(item.id)).map(item => `Waits for “${item.title}”`)[0] || '';
    const list = node('ul', 'board-run-list');
    for (const card of ready) {
      const row = node('li', 'board-run-row'), label = node('label', 'board-run-label'), tick = node('input'); tick.type = 'checkbox';
      tick.checked = picked.has(card.id); tick.disabled = !runnable(card) || busy;
      tick.addEventListener('change', () => { if (tick.checked) picked.add(card.id); else picked.delete(card.id); drawn = null; render(); });
      const icon = node('i', `agent-icon ${card.agent?.provider || 'auto'}`); icon.setAttribute('aria-hidden', 'true');
      const pick = onAuto(card) ? autoPick(card) : null;
      if (pick && !pick.error) icon.className = `agent-icon ${pick.provider}`;
      const agent = node('span', 'board-run-agent', card.agent ? AGENT[card.agent.provider] : pick ? (pick.error ? 'Auto' : pick.text) : 'No agent');
      agent.title = card.agent ? `${AGENT[card.agent.provider]}, the agent you chose for this card. Flow keeps it.` : pick && !card.auto ? 'The card has no agent, so Flow picks one when it starts, from fresh usage. This is the pick now.' : pick ? 'Auto picks again when the card starts, from fresh usage. This is the pick now.' : '';
      const title = node('span', 'board-run-title', card.title); title.title = card.title;
      label.append(tick, title);
      // Who runs it, on its own line, so a long Auto pick never cuts the title short.
      const who = node('span', 'board-run-who'); who.append(icon, agent);
      const runsWith = card.agent?.provider || (pick && !pick.error ? pick.provider : null);
      if (bills(runsWith)) { const tag = node('span', 'board-card-billing', billsLabel(runsWith)); tag.title = billsSentence(runsWith); who.append(tag); }
      row.append(label, who);
      const why = picked.has(card.id) || !runnable(card) ? blocked(card) : '';
      if (why) { const note = node('span', 'board-run-why', why); row.append(note); row.dataset.blocked = 'true'; }
      list.append(row);
    }
    parts.push(list);
    const access = board.access, how = access.mode === 'read' ? 'read only' : access.approvalPolicy === 'auto' ? 'can edit files, and approves its own requests' : 'can edit files, and asks before anything that needs approval';
    const chosen = ready.filter(card => picked.has(card.id)), at = board.taskLimits?.maxConcurrent || 2;
    if (flow) parts.push(sharedPanel(() => paintRun()));
    parts.push(node('p', 'board-note', flow
      ? `Only the ticked cards run, in Ready order, each after the cards it waits for pass their tests. Flow picks an agent for a card without one as it starts. Up to ${at} at once; each ${access.mode === 'read' ? 'only reads files' : how}. Nothing is pushed or published.`
      : `Each card runs as its own task with its agent, using this workspace’s access: ${how}. A card that waits for another starts after it, once that one’s tests pass, and is told what it did. Tasks at once in the task limits decides how many run together. Nothing is pushed or published.`));
    const cardProblem = chosen.map(blocked).find(Boolean);
    const run = button(chosen.length ? `Run ${plural(chosen.length, 'card')}` : 'Run', () => {
      const { limit, wrong } = flow ? readShared() : { limit: null, wrong: '' }; if (wrong) return;
      const auto = assignments(chosen); if (auto.error) { failure = auto.error; showError(); return; }
      const billing = billingFor(chosen, auto.assignments); if (!billing) return;
      act('/api/board/run', { ids: chosen.map(card => card.id), assignments: auto.assignments, ...billing, ...(limit ? { shared: limit } : {}) }, () => { api.announce(`${plural(chosen.length, 'card')} running as tasks.`); selected = null; });
    }, 'primary-button');
    // The button follows the limit as you type, without drawing the panel again.
    const paintRun = () => { const problem = cardProblem || (flow ? readShared().wrong : ''); run.disabled = busy || !chosen.length || Boolean(problem); run.title = problem || ''; };
    paintRun();
    const row = node('div', 'board-save-row'); row.append(run); parts.push(row);
    return parts;
  }

  // The limit Flow's run shares: minutes, tokens and API spend for every card together. An empty box is no limit.
  const SHARED = [['maxWorkingMinutes', 'Minutes', 'working minutes', 1], ['maxTokens', 'New tokens', 'new tokens', 1000], ['maxSpendUSD', 'API spend, $', 'API spend in US dollars', 0.5]];
  // The limit as typed, read into numbers, with what is wrong with it, if anything.
  function readShared() {
    const limit = {}; let wrong = '';
    for (const [key, label] of SHARED) {
      const typed = String(shared?.[key] ?? '').trim(), value = typed === '' ? null : Number(typed);
      if (value !== null && !(Number.isFinite(value) && value > 0)) wrong ||= `${label} must be a positive number, or empty for no limit.`;
      limit[key] = value !== null && Number.isFinite(value) && value > 0 ? value : null;
    }
    return { limit, wrong, none: Object.values(limit).every(value => value === null) };
  }
  const sharedSays = ({ wrong, none }) => wrong || (none
    ? 'No limit: the cards run until each is done. Fill in a box to cap the run.'
    : 'Counted across every card in the run, in place of each card’s own task limits. When it runs out, working cards stop and the rest don’t start.');
  // Typing changes only the note and the Run button, so the drawer isn't drawn again under your cursor.
  function sharedPanel(changed) {
    const box = node('fieldset', 'board-run-limit'), grid = node('div', 'board-run-limit-fields');
    const note = node('p', 'board-run-limit-note'); note.id = 'board-run-limit-note';
    for (const [key, label, unit, step] of SHARED) {
      const field = node('label', 'board-run-limit-field'), input = node('input', 'board-run-limit-input');
      input.type = 'number'; input.min = String(step); input.step = 'any'; input.inputMode = key === 'maxSpendUSD' ? 'decimal' : 'numeric'; input.placeholder = 'No limit'; input.value = shared?.[key] ?? '';
      input.disabled = busy; input.setAttribute('aria-describedby', note.id); input.setAttribute('aria-label', `${unit[0].toUpperCase()}${unit.slice(1)} for the whole run`);
      input.addEventListener('input', () => { shared = { ...shared, [key]: input.value }; const read = readShared(); note.textContent = sharedSays(read); note.dataset.wrong = read.wrong ? 'true' : ''; changed(); });
      field.append(node('span', 'board-run-limit-label', label), input);
      grid.append(field);
    }
    const read = readShared(); note.textContent = sharedSays(read); note.dataset.wrong = read.wrong ? 'true' : '';
    box.append(node('legend', 'board-run-limit-title', 'One limit for the whole run'), grid, note);
    return box;
  }
  // The Flow runs still going, each with what its cards have used of their shared limit, and Stop for all of them.
  function drawRuns() {
    const host = $('board-runs'); if (!host) return;
    const runs = board?.runs || [];
    host.hidden = !runs.length; if (!runs.length) { host.replaceChildren(); return; }
    host.replaceChildren(...runs.map(item => {
      const row = node('div', 'board-run-strip'), { limits, used } = item, parts = [];
      // "11 of 30 min", "184k of 250k tokens", or the amount alone when that limit is off.
      const of = (value, cap, say, unit) => cap === null ? `${say(value)}${unit}` : `${say(value)} of ${say(cap)}${unit}`;
      const k = value => value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
      parts.push(of(Math.round(used.workingMs / 60000), limits.maxWorkingMinutes, String, ' min'));
      parts.push(of(used.tokens, limits.maxTokens, k, ' tokens'));
      if (limits.maxSpendUSD !== null || used.spendUSD) parts.push(of(used.spendUSD, limits.maxSpendUSD, value => `$${value.toFixed(2)}`, ''));
      const state = [item.running ? `${item.running} working` : '', item.waiting ? `${item.waiting} waiting` : ''].filter(Boolean).join(', ');
      const meter = node('span', 'board-run-strip-bar'), worst = Math.max(...[[used.workingMs / 60000, limits.maxWorkingMinutes], [used.tokens, limits.maxTokens], [used.spendUSD, limits.maxSpendUSD]].filter(([, cap]) => cap).map(([value, cap]) => value / cap), 0);
      const fill = node('span', 'board-run-strip-fill'); fill.style.width = `${Math.min(100, Math.round(worst * 100))}%`; meter.append(fill); meter.setAttribute('aria-hidden', 'true'); meter.hidden = !Object.values(limits).some(value => value !== null);
      row.dataset.state = worst >= 0.9 ? 'near' : '';
      const title = node('span', 'board-run-strip-title', `Run of ${plural(item.cards.length, 'card')}`);
      const live = item.cards.map(cardBy).filter(card => card && card.column === 'doing');
      const stop = button('Stop run', () => { if (window.confirm(`Stop the ${plural(live.length, 'card')} still in this run?`)) act('/api/board/stop', { ids: live.map(card => card.id) }, () => api.announce('Stopped the run.')); }, 'text-link board-run-strip-stop');
      stop.disabled = busy || !live.length;
      row.append(title, node('span', 'board-run-strip-state', state), meter, node('span', 'board-run-strip-used', parts.join(' · ')), stop);
      row.title = Object.values(limits).some(value => value !== null) ? 'What the cards in this run have used together, of the limit they share.' : 'What the cards in this run have used together. It has no limit.';
      return row;
    }));
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
      busy = false; selected = null; draft = null; showChat(); render();
      api.showNotice(said); api.announce(said);
      document.getElementById('message-input')?.focus();
    } catch (error) { failure = error.message; }
    finally { busy = false; if (showing) render(); }
  }
  // ---- Closed to agents (#97), for the whole Plan
  function drawClosed() {
    const toggle = $('board-agents'), note = $('board-closed-note'), closed = board?.closed === true;
    if (toggle) { toggle.setAttribute('aria-pressed', String(closed)); toggle.disabled = busy || !board; $('board-agents-label').textContent = closed ? 'Closed to agents' : 'Open to agents'; toggle.title = closed ? 'Agents can’t read this Plan. Select to open it to agents.' : 'Agents can read this Plan when its cards run, when you ask about it in the chat, or when a card is attached. Select to close it to agents.'; }
    if (note) note.hidden = !closed;
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

  // ---- Asking the chat about the Plan (#162)
  // In the Plan view the chat's message box knows it. A line above what you write shows what goes with your message: the
  // Plan, and the card open beside it, sent as the text Attach to message makes, read again at Send so the agent sees the
  // Plan as it is then, with cards closed to agents left out. × leaves one out of the next message. Ask | Draft cards says
  // what Send does: ask the agent, or have it draft new cards in one read-only run, from what you write and any brief or
  // spec attached to the message. The drafted cards arrive on the Plan to accept or discard. app.js asks asking() at Send.
  let drafting = false, leftOut = { plan: false, card: null }, replaces = null;
  function setDrafting(value, { focus = true } = {}) {
    if (drafting !== value) { drafting = value; if (!value) replaces = null; contextDrawn = null; drawContext(); }
    if (focus) $('message-input')?.focus();
  }
  const planningPlan = () => { const plan = api.getState().conversation?.orchestrations?.[0]; return plan?.status === 'planning' ? plan : null; };
  // A draft that ended without cards: its reply couldn't be used, the planner didn't finish, or it was stopped. It shows
  // here, where the cards would have been, until you draft again or dismiss it.
  const failedPlan = () => { const plan = api.getState().conversation?.orchestrations?.[0]; return ['unstructured', 'failed', 'interrupted'].includes(plan?.status) && !api.getState().taskId && !api.getState().taskDraft ? plan : null; };
  const cannotDraft = () => planningPlan() ? 'An agent is drafting cards now. Wait for it, or stop it, before drafting more.' : window.relayOrchestration?.cannotDraft?.() || '';
  // What the next message takes from the Plan: the Plan's open cards and the card open beside it.
  function asked$() {
    if (!showing || !board) return null;
    const open = cards().filter(card => !shut(card)).length, card = selected ? cardBy(selected) : null;
    return {
      plan: { count: open, closed: board.closed === true, on: board.closed !== true && open > 0 && !leftOut.plan },
      card: card && !shut(card) ? { id: card.id, title: card.title, on: leftOut.card !== card.id } : null,
    };
  }
  const planIcon = (kind = 'plan') => { const icon = node('span', `plan-context-icon${kind === 'card' ? ' card' : ''}`); icon.setAttribute('aria-hidden', 'true'); return icon; };
  function chip(text, title, on, toggle, what, kind = 'plan') {
    const value = node('span', `plan-context-chip${on ? '' : ' off'}`); value.title = title;
    const name = node('span', 'plan-context-name'); name.append(...(Array.isArray(text) ? text : [text])); value.append(planIcon(kind), name);
    const flip = button(on ? '×' : '+', toggle, 'plan-context-flip'); flip.setAttribute('aria-label', on ? `Don’t send ${what} with this message` : `Send ${what} with this message`);
    value.append(flip); return value;
  }
  // Ask only answers, so a message in Ask that asks for new cards ("add that to the plan", "create cards for…") offers
  // Draft cards while you write. It's a suggestion: Send still asks, and the agent then says Ask can't add cards.
  const wantsCards = value => /\b(?:add|create|make|draft|write|put|turn|split|break)\b[^.?!\n]{0,80}\bcards?\b/i.test(value)
    || /\b(?:add|put|include|insert|append)\b[^.?!\n]{0,80}\b(?:to|in|into|on)\s+(?:(?:the|my|our|this)\s+)?plan\b/i.test(value);
  let contextDrawn = null;
  function drawContext() {
    const box = $('plan-context'); if (!box) return;
    const now = asked$(), blocked = drafting ? cannotDraft() : '', planner = drafting ? window.relayOrchestration?.planner?.() || 'with the message box’s agent' : '';
    const offer = Boolean(now && !drafting && wantsCards($('message-input')?.value || ''));
    const key = JSON.stringify([now, drafting, blocked, planner, replaces, offer]);
    for (const [id, on] of [['plan-mode-ask', !drafting], ['plan-mode-draft', drafting]]) $(id)?.setAttribute('aria-pressed', String(on));
    $('plan-chat-modes')?.classList.toggle('drafting', drafting);
    const draftTitle = planner ? `An agent drafts cards for you to review, ${planner}. Attach a brief or spec to plan from it.` : 'An agent drafts cards for you to review. Attach a brief or spec to plan from it.';
    if ($('plan-mode-draft')) $('plan-mode-draft').title = draftTitle;
    if (key === contextDrawn) return;
    contextDrawn = key; box.hidden = !now;
    $('composer')?.classList.toggle('plan-asking', Boolean(now));
    $('composer')?.classList.toggle('plan-drafting', Boolean(now && drafting));
    api.renderControls?.();
    if (!now) { box.replaceChildren(); return; }
    const parts = [];
    if (now.plan.closed) { const shutChip = node('span', 'plan-context-chip off'); shutChip.append(planIcon(), node('span', 'plan-context-name', 'Plan closed to agents')); shutChip.title = 'Agents can’t read this Plan, so nothing from it goes with your message. Open it to agents from ⋯ at the top of the Plan.'; parts.push(shutChip); }
    else if (now.plan.count) parts.push(chip([`Plan · ${now.plan.count}`, node('span', 'plan-context-unit', ` ${now.plan.count === 1 ? 'card' : 'cards'}`)], now.plan.on ? 'The Plan goes with your message, as it is when you send. Cards closed to agents are left out.' : 'The Plan won’t go with this message.', now.plan.on, () => { leftOut.plan = !leftOut.plan; drawContext(); }, 'the Plan'));
    else if (!drafting) parts.push(node('span', 'plan-context-empty', 'The Plan has no cards yet'));
    if (now.card) parts.push(chip(now.card.title, now.card.on ? `${now.card.title} — goes with your message, so “this card” means it.` : `${now.card.title} — won’t go with this message.`, now.card.on, () => { leftOut.card = leftOut.card === now.card.id ? null : now.card.id; drawContext(); }, `“${now.card.title}”`, 'card'));
    // Drafting with your answers to the planner's questions replaces that draft once the new one arrives.
    if (drafting && replaces) { const redo = node('span', 'plan-context-chip plan-context-redraft'); redo.append(planIcon(), node('span', 'plan-context-name', 'Redrafts the plan with your answers')); const undo = button('×', () => { replaces = null; contextDrawn = null; drawContext(); }, 'plan-context-flip'); undo.setAttribute('aria-label', 'Draft new cards instead of redrafting'); redo.append(undo); parts.push(redo); }
    const chips = node('div', 'plan-context-chips'); chips.append(...parts);
    const row = node('div', 'plan-context-row'); row.append(chips);
    box.replaceChildren(...(parts.length ? [row] : []));
    // Why drafting can't start now.
    if (blocked) { const why = node('p', 'plan-context-note plan-context-blocked', blocked); why.setAttribute('role', 'status'); box.append(why); }
    if (offer) {
      const note = node('p', 'plan-context-note plan-context-offer', 'Ask only answers questions. To add cards, draft them. ');
      note.setAttribute('role', 'status');
      note.append(button('Draft cards instead', () => setDrafting(true), 'text-link plan-context-offer-action'));
      box.append(note);
    }
    box.hidden = !box.children.length;
  }
  // At Send: null outside the Plan view; otherwise whether Send drafts cards, why it can't, and attach() for the Plan's text.
  function asking() {
    const now = asked$(); if (!now) return null;
    return {
      draft: drafting, blocked: drafting ? cannotDraft() : '', replaces: drafting ? replaces : null,
      // The Plan and the card as attachments; the open card is named at the top of the Plan's text rather than sent twice.
      async attach() {
        const ids = [];
        // Asking tells the agent to answer in prose and point a request for cards to Draft cards (src/board.mjs ASK_NOTE).
        // Drafting gives each card its Id, so the planner can change, merge or remove the cards already on the Plan.
        const ask = drafting ? { draft: true } : { ask: true };
        if (now.plan.on) ids.push((await api.post('/api/board/attach', now.card?.on ? { focus: now.card.id, ...ask } : ask)).attachment);
        else if (now.card?.on) ids.push((await api.post('/api/board/attach', { cardId: now.card.id, ...ask })).attachment);
        return ids.map(meta => meta.id);
      },
      // Once sent, the next message takes the Plan and the card again, and a draft goes back to asking.
      sent() { leftOut = { plan: false, card: null }; if (drafting) { drafting = false; replaces = null; api.announce('Drafting cards. They’ll appear on the Plan for you to accept or discard.'); } contextDrawn = null; drawContext(); },
    };
  }

  // The title bar's own spot for the card's actions, made once beside the Close button.
  function headActions() {
    let bar = $('board-drawer-actions');
    if (!bar) { bar = node('div', 'board-head-actions'); bar.id = 'board-drawer-actions'; { const close = $('board-drawer-close'); close.parentNode.insertBefore(bar, close); } }
    return bar;
  }
  // After this card: the cards that wait for it, each opens on a click, and the two ways to add one, Suggest next with an
  // agent or Add next by hand. Suggest's confirmation opens here, under its button.
  function afterPanel(card, followUps) {
    const box = node('section', 'board-after'), head = node('div', 'board-subtasks-head'), after = cards().filter(other => other.dependsOn?.includes(card.id));
    box.setAttribute('aria-label', 'After this card');
    head.append(node('h4', 'board-field-label', after.length ? `After this card · ${after.length}` : 'After this card'));
    if (followUps?.children.length) { followUps.className = 'board-subtasks-tools'; for (const item of followUps.children) { const label = item.textContent; item.classList.add('board-head-button'); item.replaceChildren(glyph(ACTION_ICONS[label]), node('span', '', label)); } head.append(followUps); }
    box.append(head);
    if (after.length) {
      const list = node('ul', 'board-wait-list board-after-list');
      list.append(...after.map(other => {
        const row = node('li'), open = button('', () => select(other.id), 'board-wait board-after-card');
        if (other.role && other.role !== 'builder') { const role = node('span', 'orchestration-step-role', ROLE[other.role] || other.role); role.dataset.role = other.role; open.append(role); }
        const name = node('span', 'board-wait-title', other.title); name.title = other.title;
        open.append(name, node('span', 'board-wait-column', other.draft ? 'Draft' : COLUMNS.find(([id]) => id === other.column)[1]));
        open.setAttribute('aria-label', `Open “${other.title}”`);
        row.append(open); return row;
      }));
      box.append(list);
    } else box.append(node('p', 'board-field-note', 'No card waits for this one yet. Suggest next has an agent draft follow-ups; Add next writes one yourself.'));
    box.append(...suggestPanel(card));
    return [box];
  }
  function renderDrawer() {
    const aside = $('board-drawer'), body = $('board-drawer-body');
    // A card opens as a dialog over the Plan, with a backdrop that closes it; Run and Schedules stay beside the board.
    const shade = $('board-card-shade') || { hidden: true };
    if (!selected || (!['new', 'run', 'schedules', 'schedule'].includes(selected) && !cardBy(selected))) { aside.hidden = true; shade.hidden = true; aside.classList.remove('board-card-dialog'); headActions().replaceChildren(); body.replaceChildren(); drawn = null; if (selected && !cardBy(selected)) { selected = null; draft = null; } return; }
    aside.hidden = false;
    const asCard = !['run', 'schedules', 'schedule'].includes(selected);
    if (!asCard) headActions().replaceChildren();
    aside.classList.toggle('board-card-dialog', asCard); shade.hidden = !asCard;
    if (asCard) { aside.setAttribute('role', 'dialog'); aside.setAttribute('aria-modal', 'true'); } else { aside.removeAttribute('role'); aside.removeAttribute('aria-modal'); }
    const card = cardBy(selected);
    // An untouched draft follows the card when it changes elsewhere; one you're editing waits for Save.
    if (card && draft && !dirty() && draft.revision !== card.revision) draft = editable(card);
    // A schedule being written is drawn again only when its kind of time changes, so typing keeps its place.
    if (card) readComments(card.id);
    const key = JSON.stringify([selected, card && [card.column, card.revision, card.reason, card.taskState, card.result, card.acceptedAt, card.attempts?.length, card.labels, card.checks, card.commentCount, card.draft, card.auto, card.routingMode, card.group, card.split, card.subtasks, card.splitting, card.subtasksPaused, card.closed, cards().filter(other => other.dependsOn?.includes(card.id)).map(other => [other.id, other.title, other.column, other.role]), subEdit?.cardId === card.id ? [subEdit.id, subEdit.tier, subEdit.agent] : null, threads.get(card.id)?.length ?? null, schedulesOf(card)], suggestConfirm === card?.id, board?.suggest, board?.closed, cards().length >= (board?.limits?.cards || 300), selected === 'run' ? [...picked] : null, selected === 'run' ? cards().map(item => [item.id, item.column, item.agent?.provider, item.dependsOn]) : null, selected === 'schedules' ? schedules() : null, selected === 'schedule' ? [sdraft?.id, sdraft?.when.repeat, sdraft?.target] : null, busy]);
    if (key === drawn) { changed(); return; }
    drawn = key;
    if (selected === 'run') { $('board-drawer-title').textContent = 'Run Ready cards'; body.replaceChildren(...runPanel()); return; }
    if (selected === 'schedules') { $('board-drawer-title').textContent = 'Schedules'; body.replaceChildren(...schedulesPanel()); return; }
    if (selected === 'schedule') { if (!sdraft) { selected = 'schedules'; drawn = null; renderDrawer(); return; } $('board-drawer-title').textContent = sdraft.id ? 'Edit schedule' : 'New schedule'; body.replaceChildren(...scheduleForm()); return; }
    $('board-drawer-title').textContent = selected === 'new' ? `New card · ${COLUMNS.find(([id]) => id === draft.column)[1]}` : `${card.draft ? draftWord(card) : COLUMNS.find(([id]) => id === card.column)[1]}${card.agent ? ` · ${AGENT[card.agent.provider]}` : card.auto ? ` · ${modeName(card)}` : ''}`;
    // Someone writing a comment keeps their place when the drawer is drawn again.
    const writing = ['board-comment-input', 'board-comment-send'].some(name => document.activeElement?.classList?.contains(name)) && body.contains(document.activeElement);
    const fields$ = editor(card), part = name => fields$.filter(item => item.dataset.slot === name);
    const main = node('div', 'board-card-main'), side = node('div', 'board-card-side');
    // Wide: where it stands, what it says, its subtasks, what done means, then the talk about it. Narrow: what to do
    // with it now, who does it and what it waits for, then the sorting that's only for you.
    // Like a desktop editor: what to do with the card sits in the title bar, the action that moves it on at the far right
    // beside Close, and the column on the right holds its settings. Remove, Move to Backlog and Save sit in the bar under it.
    const bar = headActions(); bar.replaceChildren();
    const footActions = [];
    let followUps = null;
    if (card) {
      const box = actions(card), primary = box.querySelector('.board-actions-main'), more = box.querySelector('.board-actions-more');
      followUps = box.querySelector('.board-actions-next');
      for (const item of [...(more?.children || [])]) {
        item.classList.remove('board-action-row');
        if (item.classList.contains('board-remove') || item.textContent === 'Move to Backlog') { item.classList.add('text-link', 'board-foot-action'); if (item.classList.contains('board-remove')) item.classList.add('board-foot-remove'); footActions.push(item); continue; }
        item.classList.add('secondary-button', 'board-head-button');
        bar.append(item);
      }
      if (primary) bar.append(...primary.children);
    }
    main.append(...(card ? status(card) : []), ...part('lead'), ...part('main').slice(0, locked$(card) ? 3 : 2), ...(card ? subtasksPanel(card) : []), ...part('main').slice(locked$(card) ? 3 : 2), ...(card ? afterPanel(card, followUps) : []), ...(card ? [...commentsPanel(card), ...history(card)] : []));
    side.append(...part('side'), ...(card ? cardSchedules(card) : []));
    const columns = node('div', 'board-card-columns'); columns.append(main, side);
    body.replaceChildren(columns, ...part('foot'));
    if (footActions.length) body.querySelector('.board-save-row')?.prepend(...footActions.sort((a, b) => b.classList.contains('board-remove') - a.classList.contains('board-remove')), node('span', 'board-save-spacer'));
    if (writing) { const box = body.querySelector('.board-comment-input'); box?.focus(); box?.setSelectionRange?.(box.value.length, box.value.length); }
    changed();
  }
  const locked$ = card => card?.column === 'doing';
  function showError() { $('board-error').textContent = failure; $('board-error').hidden = !failure; }

  // ---- Drafts (#162)
  // A banner for each plan an agent drafted: who drafted it, its summary, the questions it couldn't answer, and Accept all
  // or Discard all. Each card can also be opened, edited and accepted on its own.
  function undoNoticeRow() {
    if (!draftNotice) return null;
    const { text: msg, entry } = draftNotice;
    const row = node('section', 'board-draft-batch board-draft-undo'), text = node('div', 'board-draft-text'), actions$ = node('div', 'board-draft-actions');
    row.setAttribute('aria-label', 'Draft change');
    text.append(node('p', 'board-draft-lead', msg), node('p', 'board-draft-note', 'Undo to restore it, or press ⌘Z.'));
    const dismiss = button('Dismiss', () => { draftNotice = null; render(); }, 'text-link');
    const undo = button('Undo', async () => {
      if (undos.at(-1) === entry) { await step(undos, redos); return; }
      if (await entry.undo()) { const idx = undos.lastIndexOf(entry); if (idx >= 0) undos.splice(idx, 1); redos.push(entry); api.announce(`Undone: ${entry.label}.`); refreshTools(); }
    }, 'secondary-button');
    dismiss.disabled = undo.disabled = busy;
    actions$.append(dismiss, undo);
    row.append(text, actions$);
    return row;
  }
  function drawDrafts() {
    const box = $('board-drafts'); if (!box) return;
    const batches = new Map();
    for (const card of cards().filter(item => item.draft)) { const id = card.draft.batch?.id || 'own'; if (!batches.has(id)) batches.set(id, []); batches.get(id).push(card); }
    const planning = planningPlan(), suggest = board?.suggest, suggestShown = suggest && ['running', 'failed', 'interrupted'].includes(suggest.status) ? suggest : null;
    const failed = failedPlan();
    const splits = needingSplit().map(card => card.id);
    const key = JSON.stringify([...batches].map(([id, list]) => [id, list.map(card => [card.id, card.draft.notes?.length || 0])]).concat([busy, planning?.id || null, failed ? [failed.id, failed.status, failed.summary] : null, suggestShown, draftNotice?.text || null, splits, splitAsk ? [splitAsk.ids, splitAsk.who] : null, cannotDraft()]));
    box.hidden = !batches.size && !planning && !failed && !suggestShown && !draftNotice && !splits.length;
    if (box.dataset.drawn === key) return;
    box.dataset.drawn = key;
    // While the planner or Suggest next works, a line says so, with Stop; failed/interrupted offers Dismiss.
    const working = [];
    if (planning) {
      const row = node('section', 'board-draft-batch board-draft-planning'), text = node('div', 'board-draft-text'), actions$ = node('div', 'board-draft-actions');
      row.setAttribute('aria-label', 'Drafting cards');
      text.append(node('p', 'board-draft-lead', `Drafting cards${planning.documents?.length ? ` from ${listNames(planning.documents)}` : ''}…`), node('p', 'board-draft-note', 'They’ll appear here to accept or discard. The planner’s progress shows in the Workspace chat.'));
      const stop = button('Stop', () => api.stopRun?.(), 'secondary-button'); stop.setAttribute('aria-label', 'Stop drafting cards');
      actions$.append(stop); row.append(text, actions$); working.push(row);
    }
    if (failed) {
      const row = node('section', 'board-draft-batch board-suggest-trouble'), text = node('div', 'board-draft-text'), actions$ = node('div', 'board-draft-actions');
      const who = AGENT[failed.planner?.provider] || 'The agent', stopped = failed.status === 'interrupted';
      row.setAttribute('aria-label', stopped ? 'Drafting stopped' : 'Drafting cards didn’t work');
      const goal = (failed.goal || '').trim().split('\n')[0], lead = stopped ? 'Drafting stopped. No cards were added.' : `${who}’s draft couldn’t be used. No cards were added.`;
      text.append(node('p', 'board-draft-lead', lead), node('p', 'board-draft-note', [goal ? `For “${goal.length > 120 ? `${goal.slice(0, 119).trimEnd()}…` : goal}”.` : '', failed.summary || ''].filter(Boolean).join(' ')));
      const dismiss = button('Dismiss', () => window.relayOrchestration?.dismiss?.(), 'secondary-button');
      const again = button('Draft again', () => window.relayOrchestration?.again?.(), 'primary-button');
      dismiss.disabled = busy; again.disabled = busy || Boolean(cannotDraft());
      if (again.disabled && cannotDraft()) again.title = cannotDraft();
      actions$.append(dismiss, again); row.append(text, actions$); working.push(row);
    }
    if (suggestShown) {
      const isRun = suggestShown.status === 'running';
      const row = node('section', `board-draft-batch ${isRun ? 'board-draft-planning board-suggest-running' : 'board-suggest-trouble'}`), text = node('div', 'board-draft-text'), actions$ = node('div', 'board-draft-actions');
      row.setAttribute('aria-label', isRun ? 'Suggesting next cards' : 'Suggestions did not finish');
      const who = [AGENT[suggestShown.provider] || suggestShown.provider, suggestShown.model, suggestShown.phase && suggestShown.phase !== 'starting' ? suggestShown.phase : 'reading the project', suggestShown.toolCount ? plural(suggestShown.toolCount, 'tool call') : ''].filter(Boolean).join(' · ');
      const splitting = suggestShown.kind === 'split';
      if (isRun) {
        text.append(node('p', 'board-draft-lead', splitting ? `Splitting ${suggestShown.cardIds?.length > 1 ? plural(suggestShown.cardIds.length, 'card') : `“${suggestShown.cardTitle}”`} into subtasks…` : `Suggesting next cards after “${suggestShown.cardTitle}”…`), node('p', 'board-draft-note', `${who}. ${splitting ? 'The subtasks appear on each card for you to review.' : 'Suggested cards will appear here as drafts.'}`));
        const stop = button('Stop', () => act('/api/board/suggest/stop', {}, () => api.announce('Stopping suggestions.')), 'secondary-button'); stop.setAttribute('aria-label', 'Stop suggesting cards'); stop.disabled = busy;
        actions$.append(stop);
      } else {
        text.append(node('p', 'board-draft-lead', splitting ? (suggestShown.status === 'interrupted' ? 'Stopped splitting.' : 'Couldn’t split the cards.') : suggestShown.status === 'interrupted' ? `Stopped suggesting after “${suggestShown.cardTitle}”.` : `Couldn’t suggest cards after “${suggestShown.cardTitle}”.`), node('p', 'board-draft-note', suggestShown.summary || 'Try again when ready.'));
        const dismiss = button('Dismiss', () => act('/api/board/suggest/dismiss', {}, () => api.announce('Dismissed.')), 'secondary-button'); dismiss.disabled = busy;
        actions$.append(dismiss);
      }
      row.append(text, actions$); working.push(row);
    }
    const noticeRow = undoNoticeRow();
    if (noticeRow) working.push(noticeRow);
    box.replaceChildren(...working, ...[...batches].map(([, list]) => {
      const first = list[0], batch = first.draft.batch || {}, by = first.draft.by?.kind === 'agent' ? AGENT[first.draft.by.provider] || first.draft.by.provider : 'You';
      const model = first.draft.by?.model ? modelLabel(first.draft.by.provider, first.draft.by.model) : '';
      const row = node('section', 'board-draft-batch board-draft-plan'), text = node('div', 'board-draft-text');
      row.setAttribute('aria-label', `Drafted cards from ${by}`);
      // A draft can change the Plan as well as add to it: new cards, changed cards and cards to remove or merge.
      const fresh = list.filter(card => draftKind(card) === 'new').length, changing = list.filter(card => draftKind(card) === 'change').length, removing = list.length - fresh - changing;
      const verb = batch.kind === 'suggest' && batch.cardTitle ? `suggested ${plural(list.length, 'card')} after “${batch.cardTitle}”`
        : changing || removing ? listed([fresh ? `drafted ${plural(fresh, 'new card')}` : '', changing ? `changed ${plural(changing, 'card')}` : '', removing ? `would remove ${plural(removing, 'card')}` : ''].filter(Boolean))
        : `drafted ${plural(list.filter(card => card.createdBy !== 'codeshi').length, 'card')}${list.some(card => card.createdBy === 'codeshi') ? ', and Codeshi added a review of the whole result' : ''}`;
      const lead = node('p', 'board-draft-lead'); lead.append(glyph(ICONS.smart), node('span', '', `${by} ${verb}`));
      if (model) lead.append(node('span', 'board-draft-by', model));
      text.append(lead);
      if (batch.summary) {
        const summary = node('p', `board-draft-summary${openSummaries.has(batch.id) ? ' open' : ''}`, batch.summary);
        text.append(summary);
        if (batch.summary.length > 220) { const more = button(openSummaries.has(batch.id) ? 'Less' : 'More', () => { if (openSummaries.has(batch.id)) openSummaries.delete(batch.id); else openSummaries.add(batch.id); box.dataset.drawn = ''; drawDrafts(); }, 'text-link board-draft-more'); text.append(more); }
      }
      // Changes the plan asked for that weren't made, such as to a card that's already running.
      if (batch.left?.length) text.append(node('p', 'board-draft-left', `Left out: ${batch.left.join(' ')}`));
      const noted = list.filter(card => card.draft.notes?.length).length, facts = [];
      if (batch.documents?.length) facts.push(`Planned from ${listNames(batch.documents)}`);
      facts.push('Nothing runs until you accept');
      if (noted) facts.push(`Plan checks noted something on ${plural(noted, 'card')}`);
      text.append(node('p', 'board-draft-note', `${facts.join(' · ')}.`));
      const ids = list.map(card => card.id), actions$ = node('div', 'board-draft-actions');
      const revises = Boolean(changing || removing);
      const accept = button(revises ? (list.length === 1 ? 'Accept the change' : 'Accept all changes') : `Accept ${list.length === 1 ? '' : 'all '}${plural(list.length, 'card')}`, () => draftAction('accept', ids, revises ? 'Changes accepted.' : `${plural(list.length, 'card')} accepted.`), 'primary-button');
      const ask = revises ? `Discard this draft? ${listed([fresh ? `${plural(fresh, 'new card')} ${fresh === 1 ? 'is' : 'are'} removed` : '', changing ? `${plural(changing, 'changed card')} ${changing === 1 ? 'goes' : 'go'} back to how ${changing === 1 ? 'it was' : 'they were'}` : '', removing ? `${plural(removing, 'card')} marked to remove ${removing === 1 ? 'stays' : 'stay'}` : ''].filter(Boolean))}.` : `Discard ${plural(list.length, 'drafted card')}?`;
      const discard = button('Discard', () => { if (window.confirm(ask)) draftAction('discard', ids, 'Drafts discarded.', () => { if (ids.includes(selected) && list.find(card => card.id === selected && draftKind(card) === 'new')) { selected = null; draft = null; } }); }, 'secondary-button');
      accept.disabled = discard.disabled = busy;
      actions$.append(discard, accept);
      // The banner folds to one line, to give the cards the room; the questions stay a click away.
      const folded = foldedBatches.has(batch.id), fold = button(folded ? (batch.questions?.length ? `Show ${plural(batch.questions.length, 'question')}` : 'Show details') : 'Hide', () => { if (foldedBatches.has(batch.id)) foldedBatches.delete(batch.id); else foldedBatches.add(batch.id); box.dataset.drawn = ''; drawDrafts(); }, 'text-link board-draft-fold');
      fold.setAttribute('aria-expanded', String(!folded));
      actions$.prepend(fold);
      if (folded) { row.classList.add('folded'); for (const extra of text.querySelectorAll(':scope > :not(.board-draft-lead)')) extra.remove(); }
      const head = node('div', 'board-draft-head'); head.append(text, actions$);
      row.append(head);
      if (batch.questions?.length && !folded) row.append(questionsPanel(batch, by));
      return row;
    }), ...splitRows());
  }
  // The planner's questions (#162), each with the answers it offers and your own. Update the plan sends your answers
  // through the chat, and the agent redrafts the plan, replacing this draft once the new one arrives.
  let answers = new Map(), openSummaries = new Set(), foldedBatches = new Set();
  const questionOf = item => typeof item === 'string' ? { question: item, options: [] } : { question: item?.question || '', options: item?.options || [] };
  function questionsPanel(batch, by) {
    const list = batch.questions.map(questionOf), mine = answers.get(batch.id) || list.map(() => ({ pick: null, own: '' }));
    answers.set(batch.id, mine);
    const panel = node('div', 'board-questions'); panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', `${by}’s questions`);
    const head = node('div', 'board-questions-head');
    head.append(node('span', 'board-questions-title', `${by} has ${plural(list.length, 'question')}`), node('span', 'board-questions-note', 'Answer them to redraft the plan, or accept it as it is.'));
    panel.append(head);
    const send = button('Update the plan', () => redraft(batch, list), 'primary-button board-questions-send');
    const answered = () => mine.filter(item => item.pick !== null || item.own.trim()).length;
    const sync = () => { const count = answered(); send.disabled = busy || !count || Boolean(cannotDraft()); send.textContent = count && count < list.length ? `Update the plan with ${count} of ${list.length}` : 'Update the plan'; send.title = cannotDraft() || (count ? 'Send your answers through the chat. The agent redrafts the plan, replacing this draft.' : 'Answer at least one question first.'); };
    list.forEach((item, index) => {
      const field = node('fieldset', 'board-question'), legend = node('legend', 'board-question-text');
      legend.append(node('span', 'board-question-number', `${index + 1}`), node('span', '', item.question));
      field.append(legend);
      const choices = node('div', 'board-question-choices'), name = `board-q-${batch.id}-${index}`;
      const own = node('input', 'board-input board-question-own'); own.type = 'text'; own.maxLength = 300; own.value = mine[index].own; own.placeholder = 'Your answer'; own.setAttribute('aria-label', `Your own answer to question ${index + 1}`);
      item.options.forEach((option, at) => {
        const label = node('label', 'board-question-choice'), radio = node('input'); radio.type = 'radio'; radio.name = name; radio.checked = mine[index].pick === at;
        radio.addEventListener('change', () => { mine[index].pick = at; mine[index].own = ''; own.value = ''; own.hidden = item.options.length > 0; sync(); });
        label.append(radio, node('span', '', option));
        if (at === 0) label.append(node('span', 'board-question-recommended', 'Recommended'));
        choices.append(label);
      });
      own.addEventListener('input', () => { mine[index].own = own.value; sync(); });
      own.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && !send.disabled) { event.preventDefault(); send.click(); } });
      if (item.options.length) {
        // Your own answer is one more choice, which opens a box to write it.
        const other = node('label', 'board-question-choice'), radio = node('input'); radio.type = 'radio'; radio.name = name; radio.checked = Boolean(mine[index].own);
        own.hidden = !mine[index].own;
        radio.addEventListener('change', () => { mine[index].pick = null; own.hidden = false; own.focus(); sync(); });
        other.append(radio, node('span', '', 'Other…')); choices.append(other);
        field.append(choices);
      }
      field.append(own);
      panel.append(field);
    });
    const foot = node('div', 'board-questions-foot'); foot.append(send); panel.append(foot);
    sync();
    return panel;
  }
  function redraft(batch, list) {
    const mine = answers.get(batch.id) || [];
    const lines = list.map((item, index) => { const pick = mine[index]?.pick, own = mine[index]?.own?.trim(); const answer = own || (pick !== null && pick !== undefined ? item.options[pick] : ''); return answer ? `${index + 1}. ${item.question}\n   ${answer}` : ''; }).filter(Boolean);
    if (!lines.length) return;
    const input = $('message-input'); if (!input) return;
    input.value = ['Redraft the plan with my answers to your questions. Keep what still fits, and change only what the answers affect.', '', ...lines].join('\n');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setChat(true); drafting = true; replaces = batch.id; contextDrawn = null; drawContext();
    answers.delete(batch.id);
    // One click: the answers go now, through the same chat, as a drafting message.
    $('composer')?.requestSubmit?.();
  }
  // Major cards (#162) run only through their subtasks. Once accepted, the ones without any say so here, with one
  // read-only run to split them all, or the card's own drawer to split one or write its subtasks yourself.
  let splitAsk = null;
  const needingSplit = () => cards().filter(card => !card.draft && needsSubtasks(card) && !shut(card) && ['backlog', 'ready'].includes(card.column));
  function splitRows() {
    const list = needingSplit(), job = board?.suggest;
    if (!list.length || splitQueue.length || (job?.kind === 'split' && job.status === 'running')) return [];
    const row = node('section', 'board-draft-batch board-split-row'), text = node('div', 'board-draft-text'), actions$ = node('div', 'board-draft-actions');
    row.setAttribute('aria-label', 'Cards that need subtasks');
    const lead = node('p', 'board-draft-lead'); lead.append(glyph(ICONS.subtasks), node('span', '', `${plural(list.length, 'card needs', 'cards need')} subtasks before ${list.length === 1 ? 'it' : 'they'} can run`));
    text.append(lead, node('p', 'board-draft-note', 'An agent splits them in one read-only run, and you review the subtasks and who does each before anything runs. Or open a card to write its subtasks yourself.'));
    const head = node('div', 'board-draft-head'); head.append(text, actions$); row.append(head);
    if (!splitAsk) {
      const go = button(list.length === 1 ? 'Split it…' : `Split all ${list.length}…`, () => { splitAsk = { ids: list.map(card => card.id) }; box$().dataset.drawn = ''; drawDrafts(); }, 'primary-button');
      go.disabled = busy || Boolean(board?.suggest?.status === 'running');
      if (board?.suggest?.status === 'running') go.title = 'Wait for the agent working on the Plan to finish.';
      actions$.append(go);
    } else row.append(splitPanel(splitAsk.ids, () => { splitAsk = null; box$().dataset.drawn = ''; drawDrafts(); }));
    return [row];
  }
  const box$ = () => $('board-drafts');
  // Every card splits with its own choice: its agent, model and effort, or Auto in its own mode (the workspace's when the
  // card follows it). Cards that land on the same choice are split in one read-only run; the runs go one after another.
  function cardSplitPick(card) {
    if (card.agent?.provider) {
      const provider = card.agent.provider, model = card.agent.model || null, effort = card.agent.effort || null, billed = bills(provider), account = api.getState().accounts?.[provider];
      return { provider, model, effort, mode: null, billed, who: [AGENT[provider] || provider, model ? modelLabel(provider, model) : 'default model', effortWord(effort)].filter(Boolean).join(' · '), usageNote: billed ? `${billsSentence(provider)} Splitting may cost money.` : account?.billingSource === 'subscription' ? `Uses your ${AGENT[provider] || provider} subscription.` : '' };
    }
    return suggestPick({ title: card.title, notes: `${card.title}\n${card.notes || ''}`.slice(0, 4000) }, modeOf(card));
  }
  function splitPlan(ids) {
    const groups = new Map();
    for (const card of ids.map(cardBy).filter(Boolean)) {
      const pick = cardSplitPick(card);
      if (pick.error) return { error: `“${card.title}”: ${pick.error}`, groups: [] };
      const key = [pick.provider, pick.model, pick.effort].join('|');
      if (!groups.has(key)) groups.set(key, { pick, ids: [], modes: new Set() });
      const group = groups.get(key); group.ids.push(card.id); if (pick.mode) group.modes.add(pick.mode);
    }
    return { groups: [...groups.values()] };
  }
  let splitQueue = [];
  const splitGroup = group => act('/api/board/split', { ids: group.ids, provider: group.pick.provider, model: group.pick.model, effort: group.pick.effort, billingConfirmed: group.pick.billed ? true : window.relayBillingConfirmed === true }, result => { if (result?.suggest && board) board.suggest = result.suggest; api.announce(`Splitting ${plural(group.ids.length, 'card')} into subtasks.`); });
  // The next run starts when the one before it has finished. If one fails or is stopped, the rest wait for you.
  async function pumpSplits() {
    if (!splitQueue.length || busy) return;
    const job = board?.suggest; if (!job || job.kind !== 'split' || job.status === 'running') return;
    if (job.status !== 'complete') { splitQueue = []; return; }
    const next = splitQueue.shift();
    if (!await splitGroup(next)) splitQueue = [];
  }
  function splitPanel(ids, cancel) {
    const box = node('div', 'board-split-confirm'), plan = splitPlan(ids), many = plan.groups.length > 1;
    const cardsText = plural(ids.length, 'card');
    if (plan.error) box.append(node('p', 'board-suggest-note', plan.error));
    else {
      box.append(node('p', 'board-suggest-note', `Each card is split with its own agent, model or Auto mode. ${many ? `${plural(plan.groups.length, 'read-only run')}, one after another` : 'One read-only run'}, counted toward your usage. You can change any subtask before it runs.`));
      const lines = node('ul', 'board-split-runs');
      for (const group of plan.groups) { const mode = group.modes.size === 1 ? `Auto (${MODE[[...group.modes][0]] || 'Smart'}) · ` : group.modes.size > 1 ? 'Auto · ' : ''; lines.append(node('li', '', `${mode}${group.pick.who}: ${plural(group.ids.length, 'card')}${group.pick.usageNote ? `. ${group.pick.usageNote}` : ''}`)); }
      box.append(lines);
    }
    const row = node('div', 'board-suggest-actions');
    const go = button(ids.length === 1 ? 'Split the card' : `Split ${cardsText}`, async () => {
      if (plan.error) { failure = plan.error; showError(); return; }
      const billed = plan.groups.find(group => group.pick.billed);
      if (billed && window.relayBillingConfirmed !== true && !window.confirm(`Split with charges?\n\n${billsSentence(billed.pick.provider)} This read-only run may cost money.\n\nTo stop this question for this session, turn on Allow API and unconfirmed billing in Settings.`)) return;
      splitAsk = null; splitQueue = plan.groups.slice(1);
      if (!await splitGroup(plan.groups[0])) splitQueue = [];
    }, 'primary-button');
    go.disabled = busy || Boolean(plan.error) || board?.suggest?.status === 'running';
    row.append(button('Cancel', cancel, 'secondary-button'), go);
    box.append(row);
    return box;
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
    if (!all.length) { list.replaceChildren(node('li', 'board-column-empty', 'No cards yet. Add one with New card, or use Draft with an agent to have an agent draft them.')); return; }
    list.replaceChildren(...[...groupsOf(all)].map(([name, own], at) => {
      const item = node('li', 'board-outline-group'), head = node('div', 'board-outline-head'), rows = node('ol', 'board-outline-cards');
      const done = own.filter(card => card.column === 'done').length, doing = own.filter(card => card.column === 'doing'), ready = own.filter(card => card.column === 'ready' && runnable(card));
      // Groups are the List's top headings (the Plan view has no other), and each group's cards are a list named by it.
      const title = node('h2', 'board-outline-name', name); title.id = `board-outline-group-${at}`; rows.setAttribute('aria-labelledby', title.id);
      head.append(title, node('span', 'board-outline-progress', `${done} of ${plural(own.length, 'card')} done`));
      if (ready.length) { const run = button(`Run ${plural(ready.length, 'Ready card')}…`, () => openRun(name), 'secondary-button'); run.setAttribute('aria-label', `Run the Ready cards in ${name}`); head.append(run); }
      if (doing.length) { const stop = button('Stop', () => { if (window.confirm(`Stop ${plural(doing.length, 'running card')} in ${name}?`)) act('/api/board/stop', { ids: doing.map(card => card.id) }, () => api.announce(`Stopped ${name}.`)); }, 'secondary-button'); stop.setAttribute('aria-label', `Stop the running cards in ${name}`); head.append(stop); }
      rows.append(...own.filter(shown).map(card => {
        const row = node('li'), face = node('button', 'board-outline-card'), state = stateOf(card); face.type = 'button';
        face.dataset.card = card.id; face.dataset.column = card.column; face.setAttribute('aria-pressed', String(selected === card.id));
        const after = (card.dependsOn || []).map(cardBy).filter(Boolean).map(other => `“${other.title}”`);
        const agent = card.taskState?.provider ? AGENT[card.taskState.provider] : card.agent ? AGENT[card.agent.provider] : card.auto ? modeName(card) : inFlow() && !card.draft ? 'Flow picks' : 'No agent yet';
        face.append(node('span', 'board-outline-title', card.title), node('span', 'board-outline-meta', [card.draft ? draftWord(card) : COLUMNS.find(([id]) => id === card.column)[1], card.role !== 'builder' ? ROLE[card.role] : '', agent, card.closed && !board?.closed ? 'Closed to agents' : '', card.taskState?.notIndependent ? 'Not independent' : '', state && !card.draft ? state.text : !card.draft && needsSubtasks(card) ? 'Needs subtasks' : '', after.length ? `after ${listed(after)}` : ''].filter(Boolean).join(' · ')));
        if (state?.tone) face.dataset.tone = state.tone;
        // A running card's agent, what it's doing now and what it has used, rewritten in place as it changes (patchLive).
        const live = liveOf(card);
        if (live) { const line = node('span', 'board-outline-live', [whoOf(card).text, live.now, ...live.usage].filter(Boolean).join(' · ')); line.dataset.outlineLive = card.id; face.append(line); }
        face.addEventListener('click', () => select(card.id));
        row.append(face); return row;
      }));
      item.append(head, rows); return item;
    }));
  }

  // ---- The canvas (#97)
  // A world of cards at their saved places, moved and scaled as one by the camera: screen = world × zoom + offset. A card
  // nobody has placed yet is laid out by what it waits for, below the placed ones, and stays there until it's dragged.
  const SVG = 'http://www.w3.org/2000/svg', WIDTH = 248, FALLBACK = 120, STEP_X = 300, GAP_Y = 18, ROW_GAP = 64, ZOOM = [0.25, 2];
  const frame = fn => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : fn());
  // camera: { x, y, z }, null until the canvas is first shown, when it fits the cards. heights: each card's last measured
  // height. gesture: a drag, a pan or a new arrow in progress. picked: the arrow chosen, as [from, to]. moved: the card
  // just dragged, whose click that ends the drag isn't a selection. undos and redos: what Undo and Redo do, newest last.
  const FLOW_KEY = 'codeshi.planFlow';
  let flow = (() => { try { return localStorage.getItem(FLOW_KEY) === 'down' ? 'down' : 'across'; } catch { return 'across'; } })();
  let fitted = false, camera = null, heights = new Map(), gesture = null, picked$ = null, moved = null, stale = false, undos = [], redos = [];
  const space = $('board-space');
  const svg = tag => document.createElementNS ? document.createElementNS(SVG, tag) : document.createElement(tag);
  const height = id => heights.get(id) || FALLBACK;
  const title = id => `“${cardBy(id)?.title || 'a card'}”`;

  // Where cards go when nobody has placed them: a tree running down. A card sits one row under the latest card it waits
  // for, so work reads top to bottom like a waterfall; cards in a row sit side by side, each under the middle of the cards
  // it waits for, and the rows are centred on one another. Cards that wait on nothing form the top row.
  // With phases, each phase is laid out as its own tree in its own area, so its frame holds only its cards. A phase comes
  // after the phases its cards wait for, along the way the tree runs; phases at the same step sit side by side across it.
  const PHASE_GAP = 96;
  function layout(list, top, left) {
    const groups = groupsOf(list);
    if (groups.size <= 1) return tree(list, top, left);
    const groupOf = new Map(list.map(card => [card.id, card.group || NO_GROUP])), level = new Map();
    const deep = (name, trail) => {
      if (level.has(name)) return level.get(name);
      if (trail.has(name)) return 0; trail.add(name);
      const before = new Set(groups.get(name).flatMap(card => (card.dependsOn || []).map(id => groupOf.get(id)).filter(other => other && other !== name)));
      const value = Math.max(-1, ...[...before].map(other => deep(other, trail))) + 1;
      level.set(name, value); return value;
    };
    const steps = [];
    for (const name of groups.keys()) (steps[deep(name, new Set())] ||= []).push(name);
    const out = new Map(), across = flow === 'across';
    let along = across ? left : top;
    for (const names of steps) {
      if (!names) continue;
      let side = across ? top : left, extent = 0;
      for (const name of names) {
        const placed = across ? tree(groups.get(name), side, along) : tree(groups.get(name), along, side);
        const xs = [...placed.values()].map(at => at.x), ys = [...placed].map(([id, at]) => [at.y, at.y + height(id)]);
        const width = Math.max(...xs) + WIDTH - Math.min(...xs), tall = Math.max(...ys.map(pair => pair[1])) - Math.min(...ys.map(pair => pair[0]));
        for (const [id, at] of placed) out.set(id, at);
        side += (across ? tall : width) + PHASE_GAP; extent = Math.max(extent, across ? width : tall);
      }
      along += extent + PHASE_GAP;
    }
    return out;
  }
  function tree(list, top, left) {
    const own = new Map(list.map(card => [card.id, card])), depth = new Map(), order = new Map(ordered(list).map((card, index) => [card.id, index]));
    const parents = id => (own.get(id).dependsOn || []).filter(other => own.has(other));
    const deep = (id, trail) => {
      if (depth.has(id)) return depth.get(id);
      if (trail.has(id)) return 0; trail.add(id);
      const value = Math.max(-1, ...parents(id).map(other => deep(other, trail))) + 1;
      depth.set(id, value); return value;
    };
    for (const card of list) deep(card.id, new Set());
    const rows = [];
    for (const card of ordered(list)) (rows[depth.get(card.id)] ||= []).push(card);
    const out = new Map(), mid = new Map(), SPAN = WIDTH + 36;
    if (flow === 'across') {
      // Across: a column per level, left to right; cards in a column stack, each level with its parents' middle.
      const centre = new Map(); let x = left;
      rows.forEach(row => {
        if (!row) return;
        const want = card => { const ys = parents(card.id).map(id => centre.get(id)).filter(v => v !== undefined); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null; };
        row.sort((a, b) => ((want(a) ?? Infinity) - (want(b) ?? Infinity)) || order.get(a.id) - order.get(b.id));
        let edge = -Infinity; const ys = [];
        row.forEach((card, index) => { const h = height(card.id), ideal = (want(card) ?? (index ? edge : 0)) - h / 2; ys[index] = Math.max(ideal, edge === -Infinity ? ideal : edge + GAP_Y); edge = ys[index] + h; });
        row.forEach((card, index) => { centre.set(card.id, ys[index] + height(card.id) / 2); out.set(card.id, { x, y: ys[index] }); });
        x += WIDTH + 76;
      });
      const least = Math.min(...[...out.values()].map(at => at.y));
      for (const [id, at] of out) out.set(id, { x: Math.round(at.x), y: Math.round(at.y - least + top) });
      return out;
    }
    let y = top;
    rows.forEach((row, level) => {
      if (!row) return;
      // Order a row by where its parents sit, so arrows cross as little as they can.
      const want = card => { const xs = parents(card.id).map(id => mid.get(id)).filter(x => x !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
      row.sort((a, b) => { const x = want(a), z = want(b); return (x ?? Infinity) - (z ?? Infinity) || order.get(a.id) - order.get(b.id); });
      // Each card as near its parents as the row allows: left to right, never closer than a card and its gap.
      const xs = []; let edge = -Infinity;
      row.forEach((card, index) => { const x = want(card) ?? (index ? edge + SPAN : 0); xs[index] = Math.max(x, edge + SPAN); edge = xs[index]; });
      // A level with parents slides back toward them as one block when the packing pushed it right.
      const pull = row.map((card, index) => (want(card) ?? xs[index]) - xs[index]).reduce((a, b) => a + b, 0) / row.length;
      row.forEach((card, index) => { const x = xs[index] + Math.min(0, pull); mid.set(card.id, x); });
      row.forEach(card => out.set(card.id, { x: mid.get(card.id), y }));
      y += Math.max(...row.map(card => height(card.id))) + ROW_GAP;
    });
    // Everything starts at the left edge asked for.
    const least = Math.min(...[...out.values()].map(at => at.x));
    for (const [id, at] of out) out.set(id, { x: Math.round(at.x - least + left), y: Math.round(at.y) });
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
  // Fit puts every card in view. The first look at a large Plan starts readable at its top left instead, at no less than
  // 60%, and Fit is one click away.
  function fit(first = false) {
    const rect = space.getBoundingClientRect(), at = places(), all = cards();
    if (!rect.width || !rect.height) { camera = null; return; }
    if (!all.length) { camera = { x: 40, y: 40, z: 1 }; aim(); return; }
    const xs = all.map(card => at.get(card.id).x), ys = all.map(card => at.get(card.id).y);
    const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs) + WIDTH, bottom = Math.max(...all.map(card => at.get(card.id).y + height(card.id)));
    const z = Math.max(ZOOM[0], Math.min(1, (rect.width - 80) / (right - left), (rect.height - 120) / (bottom - top)));
    if (first && z < 0.6) { camera = { x: 40 - left * 0.6, y: 56 - top * 0.6, z: 0.6 }; aim(); return; }
    camera = { x: (rect.width - (right - left) * z) / 2 - left * z, y: Math.max(56, (rect.height - 60 - (bottom - top) * z) / 2) - top * z, z };
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
    // Under its card, an arrow leaves the bottom and enters the top; beside or above, it leaves the right and enters the left.
    const beside = to.x >= from.x + WIDTH + 8;
    if (to.y >= from.y + fromHeight + 8 && !(flow === 'across' && beside)) {
      const x0 = from.x + WIDTH / 2, y0 = from.y + fromHeight, x3 = to.x + WIDTH / 2, y3 = to.y, bend = Math.max(30, (y3 - y0) / 2);
      return { d: `M${x0} ${y0} C${x0} ${y0 + bend} ${x3} ${y3 - bend} ${x3} ${y3}`, mid: { x: (x0 + x3) / 2, y: (y0 + y3) / 2 } };
    }
    const x0 = from.x + WIDTH, y0 = from.y + fromHeight / 2, x3 = to.x, y3 = to.y + toHeight / 2, bend = Math.max(40, Math.abs(x3 - x0) / 2);
    return { d: `M${x0} ${y0} C${x0 + bend} ${y0} ${x3 - bend} ${y3} ${x3} ${y3}`, mid: { x: (x0 + x3) / 2, y: (y0 + y3) / 2 } };
  }
  // What's moving along an arrow while the Plan runs (#162 stage 5): work arriving at a card that's running, a card waiting
  // on one that's still working, or a finished card's test gate, testing or failed and holding the card after it. Nothing
  // moves on screen: the arrow changes how it's drawn, so a long run doesn't redraw it every frame.
  function flowOf(from, to) {
    if (!from || !to || from.draft || to.draft) return null;
    if (to.column === 'doing' && from.column === 'done') return { kind: 'feeding', say: `${to.title} is working with what ${from.title} did.` };
    if (from.column === 'doing') return { kind: 'working', say: `${from.title} is still working.` };
    if (from.column === 'review') {
      const tests = from.result?.tests, held = from.taskState?.holds;
      if (tests === 'running') return { kind: 'testing', label: 'Testing', say: `${from.title}’s tests are running. ${to.title} starts when they pass.` };
      if ((tests === 'failed' || tests === 'interrupted') && !from.result?.testsAccepted && held) return { kind: 'held', label: tests === 'failed' ? 'Tests failed' : 'Tests stopped', say: `${from.title}’s tests didn’t pass, so ${to.title} waits until you check it again or continue anyway.` };
      if (to.column === 'doing') return { kind: 'feeding', say: `${to.title} is working with what ${from.title} did.` };
      return { kind: 'review', say: `${from.title} is finished and waits for your review.` };
    }
    return null;
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
    const drawn$ = [defs], gates = [];
    for (const [from, to] of links()) {
      const line = curve(at.get(from), at.get(to), height(from), height(to)), done = cardBy(from).column === 'done';
      const chosen = picked$ && picked$[0] === from && picked$[1] === to, related = selected === from || selected === to;
      const moving = flowOf(cardBy(from), cardBy(to));
      const path = svg('path'); path.setAttribute('d', line.d); path.setAttribute('marker-end', 'url(#board-link-head)'); path.dataset.from = from; path.dataset.to = to;
      if (moving) path.dataset.flow = moving.kind;
      path.setAttribute('class', `board-link${done ? ' done' : ''}${related ? ' related' : ''}${chosen ? ' picked' : ''}${filter && !(shown(cardBy(from)) && shown(cardBy(to))) ? ' faded' : ''}`);
      // A test gate on the way says so at the arrow's middle: testing, or failed and holding the card after it.
      if (moving?.label) gates.push({ ...moving, mid: line.mid, from, to });
      // A wider, invisible line over it is what the pointer catches.
      const hit = svg('path'); hit.setAttribute('d', line.d); hit.setAttribute('class', 'board-link-hit'); hit.dataset.from = from; hit.dataset.to = to;
      const tooltip = svg('title'); tooltip.textContent = `${title(to)} waits for ${title(from)}${moving ? `. ${moving.say}` : ''}`; hit.append(tooltip);
      hit.addEventListener('pointerdown', event => { event.stopPropagation?.(); });
      hit.addEventListener('click', event => { event.stopPropagation?.(); picked$ = chosen ? null : [from, to]; drawLinks(); });
      drawn$.push(path, hit);
    }
    // An arrow being drawn is its own line (startLink), kept across a redraw.
    const drafting = gesture?.kind === 'link' ? [...layer.children].filter(line => line.getAttribute?.('class')?.includes('drafting')) : [];
    layer.replaceChildren(...drawn$, ...drafting);
    // The gates' labels sit over the arrows' middles and zoom with the cards, so they stay in proportion to them.
    for (const old of space.querySelectorAll('.board-link-gate')) old.remove();
    for (const gate of gates) {
      const chip = node('span', 'board-link-gate', gate.label); chip.dataset.flow = gate.kind; chip.title = gate.say; chip.setAttribute('aria-hidden', 'true');
      chip.style.transform = `translate(${gate.mid.x}px, ${gate.mid.y}px) translate(-50%, -50%)`;
      space.querySelector('.board-world')?.append(chip);
    }
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
  // A frame never takes in another group's card. Where a group's cards are spread among other groups' (cards placed by
  // hand, or before the Plan had phases), it gets a frame for each run of its cards that can be boxed alone, so every
  // group still shows. Arrange lays each group out in one area, with one frame.
  function drawGroups(at = places()) {
    const layer = space.querySelector('.board-groups'); if (!layer) return;
    const rects = cards().map(card => { const p = at.get(card.id); return p && { group: card.group || NO_GROUP, left: p.x, top: p.y, right: p.x + WIDTH, bottom: p.y + height(card.id) }; }).filter(Boolean);
    const frame = rect => ({ left: rect.left - 16, top: rect.top - 34, right: rect.right + 16, bottom: rect.bottom + 16 });
    const join = (a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
    const foreign = (box, name) => rects.some(rect => rect.group !== name && rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top);
    const areas = [];
    for (const name of groupsOf(cards()).keys()) {
      if (name === NO_GROUP) continue;
      const own = rects.filter(rect => rect.group === name).map(frame);
      if (!own.length) continue;
      let boxes = [own.reduce(join)];
      if (foreign(boxes[0], name)) {
        // Along the way the tree runs, each card joins the frame before it when that takes in no other group's card.
        own.sort((a, b) => flow === 'across' ? a.left - b.left || a.top - b.top : a.top - b.top || a.left - b.left);
        boxes = [];
        for (const box of own) { const last = boxes.at(-1), both = last && join(last, box); if (both && !foreign(both, name)) boxes[boxes.length - 1] = both; else boxes.push(box); }
        // Then any two frames that can be one are.
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const both = join(boxes[i], boxes[j]); if (!foreign(both, name)) { boxes[i] = both; boxes.splice(j, 1); j = i; } }
      }
      for (const box of boxes) {
        const area = node('div', 'board-group-area'); area.style.transform = `translate(${box.left}px, ${box.top}px)`; area.style.width = `${box.right - box.left}px`; area.style.height = `${box.bottom - box.top}px`;
        area.append(node('span', 'board-group-name', name)); areas.push(area);
      }
    }
    layer.replaceChildren(...areas);
  }
  function tools() {
    const bar = node('div', 'board-canvas-tools'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Canvas');
    const tool = (text, label, handler, cls = '') => { const value = button(text, handler, `board-tool ${cls}`.trim()); value.setAttribute('aria-label', label); value.title = label; return value; };
    const undo = tool('Undo', `Undo${undos.length ? `: ${undos.at(-1).label}` : ''} (⌘Z)`, () => step(undos, redos)), redo = tool('Redo', `Redo${redos.length ? `: ${redos.at(-1).label}` : ''} (⇧⌘Z)`, () => step(redos, undos));
    undo.disabled = !undos.length; redo.disabled = !redos.length;
    const level = tool('100%', 'Zoom to 100%', () => { zoom(1 / camera.z); }, 'board-zoom-level');
    bar.append(undo, redo, node('span', 'board-tool-gap'), tool('−', 'Zoom out', () => zoom(1 / 1.2)), level, tool('+', 'Zoom in', () => zoom(1.2)), tool('Fit', 'Fit the cards in view', () => fit()), node('span', 'board-tool-gap'), tool('Arrange', 'Lay every card out by what it waits for', arrange), tool(flow === 'across' ? 'Across' : 'Down', flow === 'across' ? 'Arranged left to right. Switch to top to bottom' : 'Arranged top to bottom. Switch to left to right', turn));
    return bar;
  }
  // A card on the canvas is built again only when something it shows changes; the rest keep their elements, so a board of
  // a few hundred cards redraws in a few milliseconds when one changes (#97). Its place isn't part of this: it's only where
  // the element is moved to.
  let world$ = null, built = new Map();
  const nodeKey = card => JSON.stringify([{ ...card, at: undefined }, selected === card.id, filter, schedulesOf(card), (card.dependsOn || []).map(id => { const other = cardBy(id); return other ? [other.title, other.column] : null; })]);
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
    if (!cards().length) space.append(node('p', 'board-canvas-empty', 'No cards yet. Double-click anywhere to add one, use New card, or use Draft with an agent.'));
    frame(() => {
      // Only cards just built can have changed height.
      let changed = false;
      for (const item of fresh) { if (!item.parentNode) continue; const measured = item.offsetHeight; if (measured && measured !== heights.get(item.dataset.card)) { heights.set(item.dataset.card, measured); changed = true; } }
      if (!camera) fit(true); else aim();
      // Cards not placed yet sit by their heights: once those are known, they're drawn again where they belong.
      const firstLook = !fitted && camera; if (camera) fitted = true;
      if (changed && cards().some(card => !card.at)) { const again = places(); for (const item of world.querySelectorAll('.board-node')) { const p = again.get(item.dataset.card); if (p) item.style.transform = `translate(${p.x}px, ${p.y}px)`; } drawLinks(again); drawGroups(again); if (firstLook) fit(true); }
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
    const request = ++written, from = era; writes++; failure = '';
    try { const result = await api.post(path, input); if (from !== era) return true; writes--; if (request === written && result.board) { board = result.board; render(); } return true; }
    catch (error) { if (from !== era) return false; writes--; failure = error.message; showError(); await load(); return false; }
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
  // Down or across: the way the tree runs. Choosing one lays every card out again, as one step to undo.
  function turn() {
    flow = flow === 'across' ? 'down' : 'across'; try { localStorage.setItem(FLOW_KEY, flow); } catch { /* A convenience only. */ }
    api.announce(flow === 'across' ? 'The tree now runs left to right.' : 'The tree now runs top to bottom.');
    arrange(); drawSpace();
  }
  function arrange() {
    const all = cards(); if (!all.length) return;
    const before = Object.fromEntries(all.map(card => [card.id, card.at || null])), after = Object.fromEntries([...layout(all, 0, 0)].map(([id, at]) => [id, at]));
    record('Arrange', before, after);
    place(after).then(() => fit(true));
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
    if (!showing) { entry(); return; }
    const onCanvas = view === 'canvas', outline = view === 'outline';
    $('board-canvas').classList.toggle('canvas-mode', onCanvas); $('board-columns').hidden = view !== 'columns'; space.hidden = !onCanvas; $('board-outline').hidden = !outline;
    for (const [id, mode] of [['board-columns-mode', 'columns'], ['board-canvas-mode', 'canvas'], ['board-outline-mode', 'outline']]) $(id)?.setAttribute('aria-pressed', String(view === mode));
    drawEarlier();
    if (!board) { const message = node('p', 'plan-view-empty', failure ? `The Plan couldn’t be loaded. ${failure}` : 'Loading the Plan…'); (onCanvas ? space : outline ? $('board-outline') : $('board-columns')).replaceChildren(message); drawContext(); return; }
    drawFilter(); drawDrafts(); drawClosed(); drawProgress(); drawRuns(); Promise.resolve().then(pumpSplits);
    // With no cards and nothing being drafted, the Plan starts here: an agent drafts it, or you write the first card.
    const starting = !cards().length && !planningPlan();
    $('board-start').hidden = !starting;
    $('board-canvas').classList.toggle('starting', starting);
    if (starting) { $('board-columns').hidden = true; space.hidden = true; $('board-outline').hidden = true; }
    const ready = cards().filter(card => card.column === 'ready');
    $('board-run-ready').disabled = busy || !ready.some(runnable);
    $('board-run-ready').title = ready.length ? 'Choose Ready cards to run' : 'Nothing is in Ready';
    const timed = $('board-schedules'), waitingFor = schedules().filter(item => item.missed).length, active = schedules().filter(item => !item.paused && (item.nextAt || item.waiting)).length;
    if (timed) { const count = $('board-schedules-count'); count.textContent = String(waitingFor || active || ''); count.hidden = !(waitingFor || active); timed.dataset.state = waitingFor ? 'missed' : ''; timed.title = waitingFor ? `${plural(waitingFor, 'scheduled run')} didn’t start` : active ? `${plural(active, 'schedule')} waiting` : 'Run a card or a prompt at a set time'; }
    // Typing keeps its place: the columns are drawn again only when the cards change.
    const where = onCanvas ? space : outline ? $('board-outline') : $('board-columns'), focused = document.activeElement?.closest?.(onCanvas ? '#board-space' : outline ? '#board-outline' : '#board-columns') ? document.activeElement.dataset?.card : null;
    if (starting) { /* The start step stands in for the cards. */ } else if (onCanvas) drawSpace(); else if (outline) drawOutline(); else drawColumns();
    if (focused) where.querySelector(`${outline ? '.board-outline-card' : '.board-card'}[data-card="${focused}"]`)?.focus();
    renderDrawer(); drawContext(); showError(); entry();
  }
  // Where the Plan stands, in one line beside the views: done of all, then what's working, waiting for you, or blocked.
  function drawProgress() {
    const line = $('board-progress'); if (!line) return;
    const all = cards(), live = all.filter(card => !card.draft), count = column => live.filter(card => card.column === column).length;
    const needs = live.filter(needsSubtasks).length, drafts = all.length - live.length;
    const parts = live.length ? [`${count('done')} of ${plural(live.length, 'card')} done`, count('doing') ? `${count('doing')} working` : '', count('review') ? `${count('review')} to review` : '', needs ? `${needs} need subtasks` : '', count('ready') - live.filter(card => card.column === 'ready' && needsSubtasks(card)).length > 0 ? `${count('ready') - live.filter(card => card.column === 'ready' && needsSubtasks(card)).length} ready` : ''].filter(Boolean) : [];
    if (drafts) parts.push(plural(drafts, 'draft'));
    line.replaceChildren();
    if (live.length) { const bar = node('span', 'board-progress-bar'), fill = node('span', 'board-progress-fill'); fill.style.width = `${Math.round(count('done') / live.length * 100)}%`; bar.append(fill); bar.setAttribute('aria-hidden', 'true'); line.append(bar); }
    // What the cards' tasks have used so far follows, kept up to date by paintTotals.
    const used = node('span', 'board-progress-used'); used.hidden = true; used.setAttribute('aria-hidden', 'true');
    line.append(node('span', '', parts.join(' · ')), used);
    line.hidden = !parts.length;
    paintTotals(); tick();
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
    const suggesting = board?.suggest?.status === 'running' || api.getState().conversation?.boardSuggest?.status === 'running';
    const [state, short, long] = planning ? ['planning', 'Planning…', 'Plan: an agent is drafting cards.'] : suggesting ? ['planning', 'Suggesting…', 'Plan: an agent is suggesting next cards.'] : drafts ? ['ready', String(drafts), `Plan: ${plural(drafts, 'drafted card')} waiting for you to accept or discard.`] : waiting ? ['ready', String(waiting), `Plan: ${plural(waiting, 'card')} to review.`] : working ? ['running', String(working), `Plan: ${plural(working, 'card')} working.`] : ['none', '', 'Plan: plan, run and review this workspace’s cards.'];
    button.dataset.state = state; button.title = long; button.setAttribute('aria-label', long);
    const badge = $('open-plan-state');
    if (badge) { badge.textContent = short; badge.hidden = !short; }
  }

  // What to do once the Plan shows: a new card written from a prefill.
  let then = null;
  function open(prefill = null) {
    if (!api.getState().projectId) return false;
    if (showing) { if (prefill) openNew('backlog', null, prefill); return true; }
    then = prefill ? { prefill } : null;
    return window.relayFlow?.plan?.() !== false;
  }
  function show() {
    if (showing) return;
    showing = true; dialog.hidden = false;
    selected = null; draft = null; failure = ''; drawn = null;
    const next = then; then = null;
    render(); chatAttention();
    load().then(() => {
      if (!showing) return;
      if (next?.prefill) openNew('backlog', null, next.prefill);
      // Focus lands on the first card so the keys work at once, but without the ring: opening the Plan isn't choosing a card.
      else (view === 'canvas' ? space : view === 'outline' ? $('board-outline') : $('board-columns')).querySelector('[data-card]')?.focus({ focusVisible: false });
    });
  }
  function hide() {
    if (!showing) return;
    showing = false; dialog.hidden = true; then = null; tick();
    selected = null; draft = null; sdraft = null; drawn = null; picked$ = null; suggestConfirm = null;
    const menu = $('board-export-menu'); if (menu) menu.hidden = true;
    drafting = false; replaces = null; leftOut = { plan: false, card: null }; drawContext(); entry();
  }
  // Esc lets go of a chosen arrow, then closes the card beside the board. It never leaves the Plan: the view switch does.
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    if (picked$) { event.preventDefault(); picked$ = null; drawLinks(); }
    else if (selected) { event.preventDefault(); closeDrawer(); }
  });
  $('board-columns-mode')?.addEventListener('click', () => showView('columns'));
  $('board-canvas-mode')?.addEventListener('click', () => showView('canvas'));
  $('board-outline-mode')?.addEventListener('click', () => showView('outline'));
  // In the List, Up and Down step from card to card across groups, and Home and End go to the first and last card. Tab still
  // stops at every card and group button.
  $('board-outline')?.addEventListener('keydown', event => {
    const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key) || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || !event.target.closest?.('.board-outline-card')) return;
    const all = [...$('board-outline').querySelectorAll('.board-outline-card')], at = all.indexOf(event.target.closest('.board-outline-card'));
    const next = { ArrowUp: all[at - 1], ArrowDown: all[at + 1], Home: all[0], End: all[all.length - 1] }[event.key];
    event.preventDefault(); next?.focus();
  });
  $('board-earlier-open')?.addEventListener('click', () => window.relayPlanView?.open());
  $('board-export')?.addEventListener('click', exportChoice);
  $('board-export-open')?.addEventListener('click', () => exportBoard(false));
  $('board-export-closed')?.addEventListener('click', () => exportBoard(true));
  $('board-export-menu')?.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $('board-export-menu').hidden = true; $('board-export').setAttribute('aria-expanded', 'false'); $('board-export').focus(); } });
  dialog.addEventListener('click', event => { const menu = $('board-export-menu'); if (menu && !menu.hidden && !event.target?.closest?.('#board-export-menu, #board-export')) { menu.hidden = true; $('board-export').setAttribute('aria-expanded', 'false'); } });
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
  // ⌘Z and ⇧⌘Z undo and redo canvas changes (and draft accept/discard in any view); Delete takes away the chosen arrow. Typing in a field keeps its own undo.
  dialog.addEventListener('keydown', event => {
    if (!board) return;
    const target = event.target, typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || target?.closest?.('#board-drawer');
    if (typing) return;
    const key = String(event.key || '').toLowerCase(), command = event.metaKey || event.ctrlKey;
    if (command && key === 'z') {
      const stack = event.shiftKey ? redos : undos, top = stack.at(-1);
      if (view === 'canvas' || top?.anyView) { event.preventDefault(); step(stack, event.shiftKey ? undos : redos); }
    } else if (command && key === 'y') {
      const top = redos.at(-1);
      if (view === 'canvas' || top?.anyView) { event.preventDefault(); step(redos, undos); }
    } else if (view === 'canvas' && (key === 'delete' || key === 'backspace') && picked$) { event.preventDefault(); disconnect(...picked$); }
  });
  $('board-chat')?.addEventListener('click', () => { setChat(true); $('message-input')?.focus(); });
  $('plan-chat-hide')?.addEventListener('click', () => { setChat(false); $('board-chat')?.focus(); });
  // The chat's header says what Send does: ask, or have an agent draft the plan.
  $('plan-mode-ask')?.addEventListener('click', () => setDrafting(false));
  $('plan-mode-draft')?.addEventListener('click', () => setDrafting(true));
  // What you write decides whether Ask offers Draft cards (wantsCards). drawContext redraws only when that changes.
  $('message-input')?.addEventListener('input', () => { if (showing && !drafting) drawContext(); });
  // With no cards yet, the Plan starts with an agent drafting it from the chat, a brief or spec, or a card you write.
  const startDrafting = () => { setChat(true); setDrafting(true); };
  $('board-start-draft')?.addEventListener('click', startDrafting);
  $('board-start-brief')?.addEventListener('click', () => { startDrafting(); $('attachment-input')?.click(); });
  $('board-start-card')?.addEventListener('click', () => openNew('backlog'));
  // The More menu closes once a choice is made; Export stays open when it asks what to include.
  $('board-more-menu')?.addEventListener('click', event => {
    const item = event.target?.closest?.('button'), menu = $('board-more-menu');
    if (!item || item.id === 'board-export' && !$('board-export-menu')?.hidden) return;
    menu?.hidePopover?.();
  });
  $('board-more-menu')?.addEventListener('toggle', event => { if (event.newState === 'closed' && $('board-export-menu')) { $('board-export-menu').hidden = true; $('board-export')?.setAttribute('aria-expanded', 'false'); } });
  $('board-drawer-close').addEventListener('click', closeDrawer);
  $('board-card-shade')?.addEventListener('click', closeDrawer);
  $('board-new').addEventListener('click', () => openNew('backlog'));
  $('board-run-ready').addEventListener('click', () => openRun());
  $('board-schedules')?.addEventListener('click', () => { if (selected === 'schedules') { closeDrawer(); return; } if (selected && dirty() && !window.confirm('Leave this card without saving your changes?')) return; selected = 'schedules'; draft = null; sdraft = null; failure = ''; drawn = null; render(); });
  // Leaving the Plan, or its workspace, asks first when a card has unsaved edits.
  const canLeave = () => !dirty() || window.confirm('Leave this card without saving your changes?');
  { let chat = null; try { chat = localStorage.getItem(CHAT_KEY); } catch { /* A convenience only. */ } setChat(chat !== 'hidden', false); }
  // The board is read again when its cards or their tasks change: the workspace chat says when, and so do the tasks. A task
  // starting or ending a run is part of that, so a major card's subtasks move on even while the chat shows another task;
  // what a run is doing within it is drawn in place instead (patchLive).
  let project = null;
  window.addEventListener('relay-state', () => {
    const state = api.getState();
    // Another workspace: the Plan stays and shows that workspace's cards, as Flow stays on.
    if (state.projectId !== project) {
      project = state.projectId; era++; splitQueue = []; writes = 0; loading++; drafting = false; replaces = null; answers = new Map(); leftOut = { plan: false, card: null }; board = null; seen = null; camera = null; fitted = false; heights = new Map(); undos = []; redos = []; draftNotice = null; suggestConfirm = null; picked$ = null; filter = ''; threads = new Map(); asked = new Map(); said = new Map(); heard = new Map();
      selected = null; draft = null; sdraft = null; drawn = null; failure = ''; picked = new Set();
      if (showing) { renderDrawer(); render(); }
    }
    chatAttention();
    const key = JSON.stringify([state.projectId, state.conversation?.boardRevision, state.conversation?.boardSuggest ? [state.conversation.boardSuggest.id, state.conversation.boardSuggest.status, state.conversation.boardSuggest.phase, state.conversation.boardSuggest.toolCount] : null, (state.conversation?.parallelTasks || []).map(task => [task.id, task.status, task.approvals, task.hasWorktree, task.testing, Boolean(task.runningProvider), task.runningModel])]);
    if (key === seen) { entry(); if (showing) { drawEarlier(); if (board) drawDrafts(); drawContext(); patchLive(); } return; }
    seen = key;
    if (state.projectId) load(); else entry();
  });
  // open({ title, notes }) opens the Plan with a new card written from them, as Write it yourself does.
  // close() goes back to Normal, or to Flow when routing was on. showChat() opens the chat beside the Plan.
  window.relayBoard = { open, show, hide, canLeave, showChat, asking, close: () => showing ? window.relayFlow?.setView?.(window.relayFlow.isRouted?.() ? 'flow' : 'normal') !== false : true, isOpen: () => showing, reload: load, drafts: () => cards().filter(card => card.draft) };
})();

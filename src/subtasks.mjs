import { randomUUID } from 'node:crypto';

// Subtasks (#155, #162 stage 3): a major card, such as one drafted from a document, is split into small subtasks when it
// starts, not up front, so the split is planned against the code the earlier cards actually produced. All of it is the
// card's one task: a short read-only run splits the card, then each subtask is a run of its own in the same task, one after
// another. A card on Auto in Flow has each subtask routed at the subtask's size, as a Flow message is (#12); otherwise each
// runs with the card's agent, unless you pinned another agent on it. The card's tests run after the last subtask, so done
// still comes from its check, and the task's limits (#87) and Stop cover every subtask.
// You can edit, remove or add the subtasks that haven't started, and pause the card after the subtask it is on. Pausing,
// Stop, a failure or a restart ends the task as any card's does; Run then carries on from the first unfinished subtask.
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const TIERS = ['light', 'standard', 'deep'], PROVIDERS = ['codex', 'claude', 'gemini'];
// No fixed number of subtasks: this only bounds what one card keeps, far beyond any split that fits one card.
export const SUBTASK_LIMITS = { subtasks: 100, title: 200, instructions: 4000, summary: 600, reply: 64000 };
const clip = (value, limit) => { const line = String(value || '').replace(/\s+/g, ' ').trim(); return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line; };
const text = (value, limit) => typeof value === 'string' && value.trim() && value.trim().length <= limit ? value.trim() : null;

// What the split run is asked, after the card's own brief.
export const splitRequest = brief => [
  brief,
  '',
  '---',
  'This is a major card. Before any work on it, split it into subtasks. This is a read-only run: inspect the project as needed, including what the earlier cards produced, but do not edit files or run commands that change anything.',
  '- Each subtask is one small piece of work, in order, that one agent can finish and check in one run, against the code as it is now.',
  '- As many subtasks as the card needs and no more. A small card may need only one.',
  '- Together they do everything the card asks, and the last one checks what done means for the card. Tests are part of each subtask.',
  '- Don\'t redo what earlier cards already did. Where something is unclear, decide the simplest reading that fits the card, and say so in that subtask\'s instructions.',
  '',
  'Return only a JSON object with subtasks (an array, in order). Each has title (short), instructions (what to do and how to know it is done) and tier ("light" for a small well-defined change, "standard" for a focused change, "deep" for complex reasoning). Do not choose agents or models.',
].join('\n');

// What each subtask's run is asked. The first run of a task also carries the card's brief and what earlier subtasks did,
// as a card that was paused or stopped carries on in a new task; later runs continue the same conversation.
export function subtaskRequest(card, sub, { brief = null } = {}) {
  const list = card.subtasks || [], number = list.findIndex(item => item.id === sub.id) + 1, done = list.filter(item => item.status === 'done');
  const parts = [];
  if (brief) {
    parts.push(brief, '', '---');
    if (done.length) parts.push('Subtasks already done for this card, by earlier runs:', ...done.map(item => `- ${list.indexOf(item) + 1}. ${item.title}${item.summary ? `: ${item.summary}` : ''}`), 'Check the files themselves before relying on those reports.', '');
  }
  parts.push(`Subtask ${number} of ${list.length} for the card “${card.title}”: ${sub.title}`, '', sub.instructions || sub.title, '');
  const rest = list.slice(number);
  if (rest.length) parts.push(`Do only this subtask. ${rest.length === 1 ? 'One more follows' : `${rest.length} more follow`}: ${rest.map(item => `“${item.title}”`).join(', ')}.`);
  else parts.push('This is the card’s last subtask: check what done means for the card as a whole.');
  parts.push('When you finish, say in a few sentences what you changed and how you checked it.');
  return parts.join('\n');
}

// The split run's reply, as subtasks, or an error that says what was wrong.
export function parseSplit(reply) {
  if (typeof reply !== 'string' || !reply.trim() || Buffer.byteLength(reply) > SUBTASK_LIMITS.reply) throw fail('The split didn’t return any subtasks.', 422);
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
  let value;
  try { value = JSON.parse(reply.slice(start, end + 1)); } catch { throw fail('The split didn’t return its subtasks as JSON.', 422); }
  const raw = Array.isArray(value) ? value : value?.subtasks;
  if (!Array.isArray(raw) || !raw.length) throw fail('The split didn’t return any subtasks.', 422);
  if (raw.length > SUBTASK_LIMITS.subtasks) throw fail(`The split returned ${raw.length} subtasks, more than the ${SUBTASK_LIMITS.subtasks} a card keeps. Split the card into smaller cards instead.`, 422);
  return raw.map((item, index) => {
    const title = text(item?.title, SUBTASK_LIMITS.title);
    if (!title) throw fail(`Subtask ${index + 1} from the split has no title.`, 422);
    return fresh({ title, instructions: text(item.instructions, SUBTASK_LIMITS.instructions) || '', tier: TIERS.includes(item.tier) ? item.tier : 'standard' }, { kind: 'agent' });
  });
}
const fresh = ({ title, instructions = '', tier = 'standard', agent = null }, by) => ({ id: randomUUID().slice(0, 8), title, instructions, tier, agent, status: 'pending', by, createdAt: new Date().toISOString() });

export class Subtasks {
  constructor(board) { this.board = board; this.starting = new Set(); }
  get main() { return this.board.main; }
  card(c, task) { const card = this.board.cards(c).find(item => item.id === task.board?.cardId); return card && card.task === task.id && (card.split || card.subtasks?.length) ? card : null; }

  // When the card's task begins: split it, or carry on from its first unfinished subtask. Returns false for a card that
  // isn't split, so the task runs its prompt as any card's does.
  begin(c, task, lane) {
    const card = this.card(c, task);
    if (!card) return false;
    let list = card.subtasks || [];
    // A card whose subtasks all finished runs again from a new split: it was sent back, or runs again from Done.
    if (list.length && list.every(item => item.status === 'done')) { list = []; this.board.update(c, card, { subtasks: [] }); }
    const next = list.find(item => item.status !== 'done');
    if (!next) {
      const requestId = `task-${task.id}-split-${randomUUID().slice(0, 6)}`;
      this.board.update(c, card, { splitting: { taskId: task.id, requestId, at: new Date().toISOString() }, subtasksPaused: false });
      // The split reads and plans only, with the card's own agent: a short run, never routed a size up.
      lane.broker.start(lane.c, { text: splitRequest(task.text), provider: task.provider, model: task.model, effort: task.effort, mode: 'read', approvalPolicy: 'ask', billingConfirmed: task.billingConfirmed, requestId }, { execution: task.execution });
      return true;
    }
    // Run again after a pause carries on, unpaused.
    if (card.splitting || card.subtasksPaused) this.board.update(c, card, { splitting: null, subtasksPaused: false });
    this.launch(c, task, lane, card, next, { brief: task.text });
    return true;
  }

  // Starts one subtask in the card's task. Errors reach the caller: in begin they fail the task as any start does.
  launch(c, task, lane, card, sub, { brief = null } = {}) {
    const requestId = `task-${task.id}-sub-${sub.id}-${randomUUID().slice(0, 6)}`;
    const subtasks = (card.subtasks || []).map(item => item.id === sub.id ? { ...item, status: 'running', taskId: task.id, requestId, startedAt: new Date().toISOString() } : item);
    this.board.update(c, card, { subtasks });
    const input = { text: subtaskRequest({ ...card, subtasks }, sub, { brief }), mode: task.accessMode, approvalPolicy: task.approvalPolicy, billingConfirmed: task.billingConfirmed, requestId };
    // Pinned by you: that agent at its default model and effort. On Auto in Flow: routed at the subtask's size. Otherwise
    // the card's own agent.
    if (sub.agent) return lane.broker.start(lane.c, { ...input, provider: sub.agent.provider, model: null, effort: null }, { execution: task.execution });
    if (task.routing) {
      this.starting.add(task.id);
      return lane.broker.dispatch(lane.c, { ...input, provider: task.provider, model: task.model, effort: task.effort, routing: { ...task.routing, planned: sub.tier } }, { execution: task.execution })
        .catch(error => this.main.tasks.update(c, task, { status: 'failed', reason: clip(error.message, 500), subtasksEnded: true, endedAt: new Date().toISOString() }))
        .finally(() => { this.starting.delete(task.id); this.main.tasks.sync(c, task); });
    }
    return lane.broker.start(lane.c, { ...input, provider: task.provider, model: task.model, effort: task.effort }, { execution: task.execution });
  }

  // Each time the card's task finishes a run. 'continue' while the card has more to do, so the task keeps running; a
  // status to end it with (paused, or a split that failed); or null when its last subtask is done and the task finishes,
  // which runs the card's tests.
  ended(c, task, lane) {
    const card = this.card(c, task);
    if (!card || this.main.tasks.closed) return null;
    if (this.starting.has(task.id)) return 'continue';
    // A routed run that changed files may be checked, and retried, before the next subtask starts (#12).
    const pending = lane.broker.checks?.pending;
    if (pending?.size) { Promise.allSettled([...pending]).then(() => setImmediate(() => this.main.tasks.sync(c, task))); return 'continue'; }
    const reply = () => lane.c.messages?.findLast(message => message.role === 'assistant' && message.runId === lane.c.lastRun?.id && message.text?.trim())?.text || '';
    let list = card.subtasks || [];
    if (card.splitting?.taskId === task.id) {
      if (!lane.c.requests?.[card.splitting.requestId]) return 'continue';
      try { list = parseSplit(reply()); }
      catch (error) { this.board.update(c, card, { splitting: null }); return { status: 'failed', reason: `${error.message} Run the card again, or add its subtasks yourself.` }; }
      this.board.update(c, card, { splitting: null, subtasks: list, splitAt: new Date().toISOString() });
      this.main.message(c, 'system', `“${card.title}” was split into ${list.length} ${list.length === 1 ? 'subtask' : 'subtasks'}.`);
    } else {
      const running = list.find(item => item.status === 'running' && item.taskId === task.id);
      if (running) {
        if (!lane.c.requests?.[running.requestId]) return 'continue';
        const run = lane.c.lastRun;
        list = list.map(item => item.id === running.id ? { ...item, status: 'done', summary: clip(reply(), SUBTASK_LIMITS.summary), provider: run?.provider || null, model: run?.model ?? null, effort: run?.effort ?? null, endedAt: new Date().toISOString() } : item);
        this.board.update(c, card, { subtasks: list });
      }
    }
    const next = list.find(item => item.status === 'pending');
    if (!next) return null;
    const done = list.filter(item => item.status === 'done').length;
    if (card.subtasksPaused) return { status: 'stopped', reason: `Paused after ${done} of ${list.length} subtasks. Run carries on from “${next.title}”.` };
    // The next subtask starts once the run that ended has let go of the task.
    this.starting.add(task.id);
    const go = () => {
      // Tests the run that ended started go first: they may retry it (#12).
      const checks = lane.broker.checks?.pending;
      if (checks?.size) { Promise.allSettled([...checks]).then(() => setImmediate(go)); return; }
      this.starting.delete(task.id);
      const current = this.card(c, task);
      if (!current || this.main.tasks.closed || lane.broker.running) return this.main.tasks.sync(c, task);
      const sub = (current.subtasks || []).find(item => item.id === next.id && item.status === 'pending');
      if (!sub) return this.main.tasks.sync(c, task);
      try { const started = this.launch(c, task, lane, current, sub); if (!(started instanceof Promise)) this.main.tasks.sync(c, task); }
      catch (error) {
        // No free slot, a limit or a setting stops it here: the card goes back to Ready, and Run carries on from it.
        this.board.update(c, current, { subtasks: (current.subtasks || []).map(item => item.id === sub.id ? { ...item, status: 'pending', taskId: null, requestId: null, startedAt: null } : item) });
        this.main.tasks.update(c, task, { status: 'stopped', reason: `Paused before “${sub.title}”: ${clip(error.message, 400)}`, subtasksEnded: true, endedAt: new Date().toISOString() });
      }
    };
    setImmediate(go);
    return 'continue';
  }

  // ---- Editing (from the card's drawer)
  // Subtasks that haven't started are yours to edit, remove, add to or pin to an agent. Pausing stops the card after the
  // subtask it is on. Split again clears them while the card isn't running, so its next run splits it afresh.
  act(c, id, input = {}) {
    const card = this.board.find(c, id), list = card.subtasks || [], running = card.column === 'doing';
    const find = () => { const sub = list.find(item => item.id === input.subtaskId); if (!sub) throw fail('That subtask is no longer on the card.', 404); return sub; };
    const open = sub => { if (sub.status !== 'pending') throw fail(sub.status === 'done' ? 'That subtask is done.' : 'An agent is working on that subtask.'); };
    const fields = (sub = {}) => {
      const out = {};
      if (!sub.id || 'title' in input) { out.title = text(input.title, SUBTASK_LIMITS.title); if (!out.title) throw fail(`Give the subtask a title of up to ${SUBTASK_LIMITS.title} characters.`, 400); }
      if ('instructions' in input) { const value = input.instructions == null ? '' : String(input.instructions).trim(); if (value.length > SUBTASK_LIMITS.instructions) throw fail(`A subtask’s instructions can be up to ${SUBTASK_LIMITS.instructions.toLocaleString('en-US')} characters.`, 400); out.instructions = value; }
      if ('tier' in input) { if (!TIERS.includes(input.tier)) throw fail('Choose light, standard or deep as the subtask’s size.', 400); out.tier = input.tier; }
      if ('agent' in input) {
        if (input.agent === null) out.agent = null;
        else { if (!PROVIDERS.includes(input.agent?.provider)) throw fail('Choose Codex, Claude or Gemini for this subtask, or leave it to the card.', 400); out.agent = { provider: input.agent.provider, model: null, effort: null }; }
      }
      return out;
    };
    if (card.draft) throw fail('An agent drafted this card. Accept it before working on its subtasks.');
    let changes;
    switch (input.action) {
      case 'add': {
        if (list.length >= SUBTASK_LIMITS.subtasks) throw fail(`A card keeps up to ${SUBTASK_LIMITS.subtasks} subtasks. Split it into smaller cards instead.`);
        if (card.splitting) throw fail('The card is being split. Add subtasks once it’s done.');
        // At the end, or after the subtask named, but never before one that has started.
        const after = input.after ? list.findIndex(item => item.id === input.after) : list.length - 1;
        if (input.after && after < 0) throw fail('That subtask is no longer on the card.', 404);
        if (list.slice(after + 1).some(item => item.status !== 'pending')) throw fail('A new subtask can only go before ones that haven’t started.');
        const sub = fresh({ instructions: '', tier: 'standard', ...fields() }, { kind: 'you' });
        changes = { subtasks: [...list.slice(0, after + 1), sub, ...list.slice(after + 1)], split: true };
        break;
      }
      case 'edit': { const sub = find(); open(sub); changes = { subtasks: list.map(item => item.id === sub.id ? { ...item, ...fields(sub) } : item) }; break; }
      case 'remove': { const sub = find(); open(sub); changes = { subtasks: list.filter(item => item.id !== sub.id) }; break; }
      case 'pause': if (!running) throw fail('Only a running card can be paused.'); changes = { subtasksPaused: true }; break;
      case 'resume': changes = { subtasksPaused: false }; break;
      case 'clear': if (running) throw fail('An agent is working on this card. Stop it before splitting it again.'); changes = { subtasks: [], splitting: null, subtasksPaused: false }; break;
      default: throw fail('Choose what to do with the subtasks.', 400);
    }
    this.board.update(c, card, changes);
    return this.board.public(c, this.board.find(c, id));
  }
}

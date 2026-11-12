import { randomUUID } from 'node:crypto';

// The task board (#132, first stage): cards you write, sort and run by hand. Cards are records in the workspace chat's
// journal, beside the tasks they start, so they live in Codeshi's data and a crash finds them as they were. Running a card
// starts an ordinary task (#88) with the card's own agent under a Normal policy. From then on the task decides where the card
// is: working puts it in Doing, finishing in Review, and stopping, failing or being discarded back in Ready with the reason.
// Only you move a card to Done. Schedules live in src/schedules.mjs; Flow choosing cards from the backlog comes later.
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export const COLUMNS = ['backlog', 'ready', 'doing', 'review', 'done'];
export const PRIORITIES = ['high', 'normal', 'low'];
const PROVIDERS = ['codex', 'claude', 'gemini'];
export const LIMITS = { cards: 300, title: 200, notes: 20000, checks: 20, check: 300, dependsOn: 20, reason: 500, summary: 600, labels: 8, label: 32, comments: 100, comment: 4000, promptComments: 8000 };
// Tasks that can't change any more, and the ones whose changes are already in the folder.
const ENDED = new Set(['integrated', 'kept', 'discarded', 'cancelled']);
const LIVE = new Set(['waiting', 'running']);
const COLUMN_NAME = { backlog: 'Backlog', ready: 'Ready', doing: 'Doing', review: 'Review', done: 'Done' };
const text = (value, limit, name, required = false) => {
  if (value === undefined || value === null) { if (required) throw fail(`Give the card a ${name}.`, 400); return ''; }
  if (typeof value !== 'string') throw fail(`The card’s ${name} must be text.`, 400);
  const trimmed = value.trim();
  if (required && !trimmed) throw fail(`Give the card a ${name}.`, 400);
  if (trimmed.length > limit) throw fail(`A card’s ${name} can be up to ${limit.toLocaleString('en-US')} characters.`, 400);
  return trimmed;
};
// Where a card sits on the canvas (#97): whole pixels, within a generous square. Only the canvas reads it.
const REACH = 100000;
const position = at => {
  if (!at || typeof at !== 'object' || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw fail('A card’s place on the canvas needs an x and a y.', 400);
  const keep = value => Math.max(-REACH, Math.min(REACH, Math.round(value)));
  return { x: keep(at.x), y: keep(at.y) };
};
// Labels (#97): short names to sort cards by, each once whatever its case, in the order given.
const labelList = value => {
  if (!Array.isArray(value)) throw fail('A card’s labels must be a list.', 400);
  const out = [], seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') throw fail('Each label must be text.', 400);
    const name = item.replace(/\s+/g, ' ').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    if (name.length > LIMITS.label) throw fail(`A label can be up to ${LIMITS.label} characters.`, 400);
    seen.add(name.toLowerCase()); out.push(name);
  }
  if (out.length > LIMITS.labels) throw fail(`A card can have up to ${LIMITS.labels} labels.`, 400);
  return out;
};
// A due date is a day on the calendar, with no time or zone: the person's own day.
const dueDay = value => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('A due date is a day, written as YYYY-MM-DD.', 400);
  const [y, m, d] = value.split('-').map(Number), day = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2200 || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) throw fail('That due date isn’t a day on the calendar.', 400);
  return value;
};
// Mermaid reads quotes and angle brackets in a label as its own syntax; these are its entity codes.
const label = value => String(value).replace(/\s+/g, ' ').replace(/[#"<>]/g, char => ({ '#': '#35;', '"': '#quot;', '<': '#lt;', '>': '#gt;' })[char]);
// Who wrote a comment, as the export names them.
const author = by => by?.kind === 'agent' ? [by.provider, by.model].filter(Boolean).join(' ') || 'An agent' : by?.kind === 'guest' ? `${by.name || 'A guest'} (guest)` : 'You';
const clip = (value, limit) => { const line = String(value || '').trim(); return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line; };

export class Board {
  constructor(main) {
    this.main = main;
    // The coordinator tells the board each time a task's record changes; the card follows its task from there.
    main.tasks.onTask = (c, task) => this.follow(c, task);
    for (const c of main.conversations.values()) this.reconcile(c);
  }
  cards(c) { return c.board || []; }
  find(c, id) { const card = this.cards(c).find(item => item.id === id); if (!card) throw fail('That card is no longer on the board.', 404); return card; }
  update(c, card, changes) { this.main.record(c, { type: 'board_card_update', id: card.id, changes: { ...changes, updatedAt: new Date().toISOString() } }); }
  task(c, card) { return card.task ? (c.parallelTasks || []).find(task => task.id === card.task) || null : null; }
  folders() { return this.main.workspaceFolders; }

  // ---- Writing cards
  clean(c, input, card = null) {
    const changes = {};
    if (!card || 'title' in input) changes.title = text(input.title, LIMITS.title, 'title', true);
    if (!card || 'notes' in input) changes.notes = text(input.notes, LIMITS.notes, 'description');
    if (!card || 'priority' in input) {
      const priority = input.priority ?? 'normal';
      if (!PRIORITIES.includes(priority)) throw fail('Choose high, normal or low priority.', 400);
      changes.priority = priority;
    }
    // Labels and the due date are for you to sort and plan by. The agent isn't told them, so like the priority they can
    // change at any time without a new revision.
    if (!card || 'labels' in input) changes.labels = labelList(input.labels ?? []);
    if (!card || 'due' in input) changes.due = dueDay(input.due ?? null);
    if (!card || 'checks' in input) {
      const checks = input.checks ?? [];
      if (!Array.isArray(checks) || checks.length > LIMITS.checks) throw fail(`A card can have up to ${LIMITS.checks} checks.`, 400);
      changes.checks = checks.map(item => {
        const value = typeof item === 'string' ? { text: item, done: false } : item;
        if (!value || typeof value !== 'object') throw fail('Each check needs its text.', 400);
        return { text: text(value.text, LIMITS.check, 'check', true), done: value.done === true };
      });
    }
    if (!card || 'agent' in input) {
      const agent = input.agent ?? null;
      if (agent !== null) {
        if (typeof agent !== 'object' || !PROVIDERS.includes(agent.provider)) throw fail('Choose Codex, Claude or Gemini for this card.', 400);
        const model = agent.model ? text(agent.model, 200, 'model') : null, effort = agent.effort || null;
        this.main.validateSelection(model, 'auto', effort);
        changes.agent = { provider: agent.provider, model: model || null, effort };
      } else changes.agent = null;
    }
    if (!card || 'folderId' in input) {
      const folderId = input.folderId ?? null;
      if (folderId !== null && !this.folders().some(folder => folder.id === folderId)) throw fail('Choose a folder in this workspace.', 400);
      changes.folderId = folderId;
    }
    if (!card && input.at != null) changes.at = position(input.at);
    if (!card || 'dependsOn' in input) {
      const ids = input.dependsOn ?? [];
      if (!Array.isArray(ids) || ids.length > LIMITS.dependsOn) throw fail(`A card can wait for up to ${LIMITS.dependsOn} others.`, 400);
      const unique = [...new Set(ids)];
      for (const id of unique) {
        if (card && id === card.id) throw fail('A card can’t wait for itself.', 400);
        this.find(c, id);
      }
      if (card && this.reaches(c, unique, card.id)) throw fail('That would make cards wait for each other in a circle.', 400);
      changes.dependsOn = unique;
    }
    return changes;
  }
  // Whether following the given cards' waits ever reaches the target.
  reaches(c, start, target) {
    const seen = new Set(), next = [...start];
    while (next.length) {
      const id = next.pop(); if (id === target) return true; if (seen.has(id)) continue; seen.add(id);
      next.push(...(this.cards(c).find(item => item.id === id)?.dependsOn || []));
    }
    return false;
  }
  lastOrder(c, column) { return Math.max(0, ...this.cards(c).filter(card => card.column === column).map(card => card.order || 0)); }
  create(c, input = {}) {
    if (this.cards(c).length >= LIMITS.cards) throw fail(`A board holds up to ${LIMITS.cards} cards. Remove some finished ones first.`);
    const column = input.column ?? 'backlog';
    if (!['backlog', 'ready'].includes(column)) throw fail('A new card goes in Backlog or Ready.', 400);
    const now = new Date().toISOString();
    // A new card never runs on Auto: it has no agent until you choose one (#132).
    const card = { id: randomUUID(), ...this.clean(c, input), column, order: this.lastOrder(c, column) + 1, revision: 1, createdBy: 'you', createdAt: now, updatedAt: now, attempts: [] };
    this.main.record(c, { type: 'board_card', card });
    return this.public(c, this.find(c, card.id));
  }
  edit(c, id, input = {}) {
    const card = this.find(c, id);
    if (input.revision !== undefined && input.revision !== card.revision) throw fail('This card changed since you opened it. Look at it again before saving.');
    const changes = this.clean(c, input, card), material = ['title', 'notes', 'agent', 'folderId', 'dependsOn'].some(key => key in changes && JSON.stringify(changes[key]) !== JSON.stringify(card[key]))
      || 'checks' in changes && JSON.stringify(changes.checks.map(item => item.text)) !== JSON.stringify((card.checks || []).map(item => item.text));
    // What an agent is working from stays as it started. Ticking checks and the priority can change at any time.
    if (material && card.column === 'doing') throw fail('An agent is working on this card. Stop it first, or wait until it’s in Review.');
    if (!Object.keys(changes).some(key => JSON.stringify(changes[key]) !== JSON.stringify(card[key]))) return this.public(c, card);
    this.update(c, card, { ...changes, ...(material ? { revision: card.revision + 1 } : {}) });
    return this.public(c, card);
  }
  // You move cards between Backlog and Ready, reopen a Done card, and order any column. Doing and Review are the runs' to
  // decide; a card leaves Review by Accept or Send back.
  move(c, id, { column = null, before = null } = {}) {
    const card = this.find(c, id), to = column || card.column;
    if (!COLUMNS.includes(to)) throw fail('Choose a column.', 400);
    if (to !== card.column) {
      const allowed = { backlog: ['ready'], ready: ['backlog'], done: ['ready', 'backlog'] }[card.column] || [];
      if (!allowed.includes(to)) throw fail(card.column === 'doing' ? 'An agent is working on this card. Stop it to move it.' : card.column === 'review' ? 'Accept this card, or send it back to Ready.' : `A card can’t be moved to ${COLUMN_NAME[to]} by hand. Running it moves it there.`);
    }
    const others = this.cards(c).filter(item => item.column === to && item.id !== card.id).sort((a, b) => a.order - b.order);
    const at = before ? others.findIndex(item => item.id === before) : -1;
    const order = at < 0 ? (others.at(-1)?.order || 0) + 1 : at === 0 ? others[0].order - 1 : (others[at - 1].order + others[at].order) / 2;
    this.update(c, card, { column: to, order, ...(to !== card.column ? { reason: null, ...(card.column === 'done' ? { acceptedAt: null } : {}) } : {}) });
    return this.public(c, card);
  }
  remove(c, id) {
    const card = this.find(c, id);
    if (card.column === 'doing') throw fail('An agent is working on this card. Stop it before removing it.');
    for (const other of this.cards(c).filter(item => item.dependsOn?.includes(id))) this.update(c, other, { dependsOn: other.dependsOn.filter(item => item !== id) });
    this.main.record(c, { type: 'board_card_remove', id });
    this.main.schedules?.forgetCard(c, id);
    return { removed: true };
  }
  // Where cards sit on the canvas (#97), several at once so Arrange and its undo are one step. null hands a card back to
  // the canvas's own layout. A place is only where the card is drawn: it changes nothing an agent reads, so it never bumps
  // the revision and can change while the card runs. Every id is checked before anything is recorded.
  place(c, { positions } = {}) {
    if (!positions || typeof positions !== 'object' || Array.isArray(positions)) throw fail('Say where each card goes.', 400);
    const entries = Object.entries(positions);
    if (!entries.length || entries.length > LIMITS.cards) throw fail(`Place between 1 and ${LIMITS.cards} cards at a time.`, 400);
    const changes = entries.map(([id, at]) => [this.find(c, id), at === null ? null : position(at)]);
    for (const [card, at] of changes) if (JSON.stringify(card.at ?? null) !== JSON.stringify(at)) this.update(c, card, { at });
    return { placed: changes.length };
  }

  // ---- Comments (#97)
  // Each says who wrote it and when. Today that's always you; by is an object so an agent and its model, or a guest's
  // name, can say the same later. The agent is told your comments the next time the card runs, so adding or removing
  // one is a new revision: a scheduled run waits for you, as for any edit. One already working doesn't see it. Comments
  // have records of their own rather than rewriting the card's whole list each time.
  comments(c, id) { return this.find(c, id).comments || []; }
  comment(c, id, { text: value } = {}) {
    const card = this.find(c, id);
    if (typeof value !== 'string' || !value.trim()) throw fail('Write the comment first.', 400);
    const body = value.replace(/\r\n?/g, '\n').trim();
    if (body.length > LIMITS.comment) throw fail(`A comment can be up to ${LIMITS.comment.toLocaleString('en-US')} characters.`, 400);
    if ((card.comments || []).length >= LIMITS.comments) throw fail(`A card holds up to ${LIMITS.comments} comments. Remove some old ones first.`);
    const comment = { id: randomUUID(), text: body, by: { kind: 'you' }, at: new Date().toISOString() };
    this.main.record(c, { type: 'board_comment', cardId: card.id, comment, revision: card.revision + 1 });
    return comment;
  }
  uncomment(c, id, { commentId } = {}) {
    const card = this.find(c, id);
    if (!(card.comments || []).some(item => item.id === commentId)) throw fail('That comment is no longer on the card.', 404);
    this.main.record(c, { type: 'board_comment_remove', cardId: card.id, commentId, revision: card.revision + 1, at: new Date().toISOString() });
    return { removed: true };
  }

  // ---- Export (#97)
  // The board as Markdown that reads well without Codeshi: a Mermaid chart of the cards and what waits for what, then each
  // column's cards with everything you wrote on them. Task ids, run history and the agents' own summaries are left out.
  markdown(c, { now = new Date() } = {}) {
    const all = this.list(c), short = new Map(all.map((card, index) => [card.id, `c${index + 1}`]));
    const folder = id => this.folders().find(item => item.id === id), folderName = id => { const found = folder(id); return found ? found.displayName || found.name : ''; };
    const lines = ['# Task board', '', `Exported from Codeshi on ${now.toISOString().slice(0, 10)}. ${all.length} ${all.length === 1 ? 'card' : 'cards'}.`, ''];
    if (all.length) {
      lines.push('```mermaid', 'flowchart LR');
      for (const card of all) lines.push(`  ${short.get(card.id)}["${label(card.title)}"]:::${card.column}`);
      for (const card of all) for (const id of card.dependsOn || []) if (short.has(id)) lines.push(`  ${short.get(id)} --> ${short.get(card.id)}`);
      lines.push('  classDef backlog fill:#f4f1ec,stroke:#9a958d', '  classDef ready fill:#eef3fb,stroke:#5b7fb8', '  classDef doing fill:#fdecea,stroke:#d9381e', '  classDef review fill:#fdf4e3,stroke:#c48a1a', '  classDef done fill:#eaf5ec,stroke:#3d8b4f', '```', '');
    }
    for (const column of COLUMNS) {
      const own = all.filter(card => card.column === column);
      if (!own.length) continue;
      lines.push(`## ${COLUMN_NAME[column]}`, '');
      for (const card of own) {
        lines.push(`### ${card.title.replace(/\s+/g, ' ')}`, '');
        const facts = [];
        if (card.priority !== 'normal') facts.push(`Priority: ${card.priority}`);
        if (card.labels?.length) facts.push(`Labels: ${card.labels.join(', ')}`);
        if (card.due) facts.push(`Due: ${card.due}`);
        facts.push(`Agent: ${card.agent ? `${card.agent.provider[0].toUpperCase()}${card.agent.provider.slice(1)}${card.agent.model ? ` (${card.agent.model}${card.agent.effort ? `, ${card.agent.effort}` : ''})` : ''}` : 'not chosen'}`);
        if (card.folderId && this.folders().length > 1 && folderName(card.folderId)) facts.push(`Works in: ${folderName(card.folderId)}`);
        const after = (card.dependsOn || []).map(id => all.find(item => item.id === id)?.title).filter(Boolean);
        if (after.length) facts.push(`Waits for: ${after.map(title => `“${title.replace(/\s+/g, ' ')}”`).join(', ')}`);
        if (card.result?.tests && ['review', 'done'].includes(card.column)) facts.push(`Tests: ${card.result.tests}`);
        if (card.acceptedAt && card.column === 'done') facts.push(`Accepted: ${card.acceptedAt.slice(0, 10)}`);
        if (card.reason && card.column === 'ready') facts.push(`Note: ${card.reason}`);
        lines.push(...facts.map(fact => `- ${fact}`), '');
        if (card.notes) lines.push(card.notes, '');
        if (card.checks?.length) lines.push('Done means:', '', ...card.checks.map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`), '');
        const said = this.comments(c, card.id);
        if (said.length) lines.push('Comments:', '', ...said.map(item => `- ${author(item.by)}, ${item.at.slice(0, 10)}: ${item.text.replace(/\n/g, '\n  ')}`), '');
      }
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }

  // ---- Running cards
  // The exact cards you chose, and nothing else. Each must be Ready with its agent, and each card it waits for must be Done
  // or chosen too; then a chosen card's task waits for those tasks. Every card is checked before any task is recorded, and
  // the tasks are recorded held, so a run that can't start starts nothing. Tasks at once and the task limits decide when
  // each starts, as for any task.
  // A schedule (src/schedules.mjs) runs its card with the access saved with it, an ID made from its time, and a note for
  // the agent; a repeating one can run a card again from Done.
  run(c, { ids, executionRevision } = {}, { access = null, requestId = null, from = ['ready'], note = '', source = 'board' } = {}) {
    if (!Array.isArray(ids) || !ids.length) throw fail('Choose the cards to run.', 400);
    const chosen = [...new Set(ids)].map(id => this.find(c, id)), picked = new Set(chosen.map(card => card.id));
    const folders = this.folders(), mode = access?.mode || c.mode, approvalPolicy = access?.approvalPolicy || c.approvalPolicy || 'ask';
    for (const card of chosen) {
      const name = `“${card.title}”`;
      if (!from.includes(card.column)) throw fail(card.column === 'doing' ? `${name} is still running.` : card.column === 'review' ? `${name} is waiting in Review.` : `${name} isn’t in Ready. Move it there to run it.`);
      if (!card.agent) throw fail(`Choose an agent for ${name}.`, 400);
      const folderId = card.folderId || (folders.length === 1 ? folders[0].id : null);
      if (!folderId || !folders.some(folder => folder.id === folderId)) throw fail(`Choose the folder ${name} works in.`, 400);
      for (const id of card.dependsOn || []) {
        const before = this.cards(c).find(item => item.id === id);
        if (before && before.column !== 'done' && !picked.has(id)) throw fail(`${name} waits for “${before.title}”, which isn’t done. Run them together, or finish that one first.`);
      }
      this.main.checkRunSettings(card.agent.provider, mode, approvalPolicy);
      const allowed = this.main.budget.allows(c, card.agent.provider, card.agent.model);
      if (!allowed.allowed) throw fail(`${name}: ${allowed.reason}`);
    }
    // Cards a chosen card waits for start first.
    const order = [], placed = new Set(), visit = card => { if (placed.has(card.id)) return; placed.add(card.id); for (const id of card.dependsOn || []) if (picked.has(id)) visit(this.find(c, id)); order.push(card); };
    for (const card of chosen) visit(card);
    const tasks = {}, made = [], attempt = randomUUID().slice(0, 8);
    try {
      for (const card of order) {
        const folderId = card.folderId || folders[0].id, policyId = randomUUID(), id = requestId && chosen.length === 1 ? requestId : `board-${card.id}-${attempt}`;
        // Normal: the card's own agent, model and effort, whatever the workspace's default is.
        this.main.execution.ensure(c, policyId, { config: { mode: 'normal' }, source, requestId: id });
        const task = this.main.tasks.start(c, { text: this.prompt(c, card) + (note ? `\n\n${note}` : ''), title: card.title, provider: card.agent.provider, model: card.agent.model, effort: card.agent.effort, mode, approvalPolicy, folderId, requestId: id, dependsOn: (card.dependsOn || []).filter(id => picked.has(id)).map(id => tasks[id]), executionRevision }, { held: true, queueExecution: this.main.execution.token(c, policyId), board: { cardId: card.id, revision: card.revision } });
        tasks[card.id] = task.id; made.push(task.id);
      }
    } catch (error) {
      for (const id of made) { const task = this.main.tasks.find(c, id); if (task.status === 'waiting') this.main.tasks.finish(c, task, { status: 'cancelled' }); }
      throw error;
    }
    const now = new Date().toISOString();
    for (const card of order) {
      const attemptRecord = { taskId: tasks[card.id], revision: card.revision, provider: card.agent.provider, model: card.agent.model, effort: card.agent.effort, startedAt: now };
      this.update(c, card, { column: 'doing', task: tasks[card.id], reason: null, result: null, attempts: [...(card.attempts || []), attemptRecord].slice(-20) });
    }
    for (const id of made) this.main.tasks.update(c, this.main.tasks.find(c, id), { held: false, reason: 'Starting' });
    this.main.tasks.tick(c);
    return { tasks, cards: this.list(c) };
  }
  // What the agent is told: the card as you wrote it, with what done means.
  prompt(c, card) {
    const parts = [card.title];
    if (card.notes) parts.push('', card.notes);
    if (card.checks?.length) parts.push('', 'Done means:', ...card.checks.map(item => `- ${item.text}`));
    const after = (card.dependsOn || []).map(id => this.cards(c).find(item => item.id === id)?.title).filter(Boolean);
    if (after.length) parts.push('', `This builds on earlier cards: ${after.map(title => `“${title}”`).join(', ')}.`);
    // Only your own comments, newest kept when there are many: anyone else's reach an agent only once you accept them.
    const said = (card.comments || []).filter(item => item.by?.kind === 'you'), kept = [];
    let size = 0;
    for (const item of [...said].reverse()) {
      const line = `- ${item.at.slice(0, 10)}: ${item.text.replace(/\n/g, '\n  ')}`;
      if (kept.length && size + line.length > LIMITS.promptComments) break;
      kept.unshift(line); size += line.length;
    }
    if (kept.length) parts.push('', 'The person’s comments on this card, oldest first:', ...(kept.length < said.length ? [`(${said.length - kept.length} earlier ${said.length - kept.length === 1 ? 'comment' : 'comments'} left out.)`] : []), ...kept);
    parts.push('', 'This is a card from the project’s task board. When you finish, say in a few sentences what you changed and how you checked it. You review nothing yourself: the person accepts the card.');
    return parts.join('\n');
  }
  // Stopping a card stops its task if it's working and cancels it if it hasn't started. Either way the card goes back to Ready.
  stop(c, id) {
    const card = this.find(c, id), task = this.task(c, card);
    if (card.column !== 'doing' || !task) throw fail('This card isn’t running.');
    const lane = this.main.tasks.lanes.get(task.id);
    if (lane?.broker.running && lane.c) lane.broker.stop(lane.c.id);
    else if (task.status === 'waiting') this.main.tasks.finish(c, task, { status: 'cancelled' });
    return this.public(c, this.find(c, id));
  }
  // An agent never marks its own work done. A card in Review is accepted by you, once its changes are in the folder.
  accept(c, id) {
    const card = this.find(c, id), task = this.task(c, card);
    if (card.column !== 'review') throw fail('Only a card in Review can be accepted.');
    if (task && task.mode === 'worktree' && !['integrated', 'kept'].includes(task.status)) throw fail('Its changes are still in the task’s own copy. Review and merge them first, or keep them as a branch.');
    if (task && LIVE.has(task.status)) throw fail('Its task is working again. Wait until it finishes.');
    this.update(c, card, { column: 'done', order: this.lastOrder(c, 'done') + 1, acceptedAt: new Date().toISOString(), acceptedBy: 'you', reason: null });
    return this.public(c, card);
  }
  sendBack(c, id, { reason = '' } = {}) {
    const card = this.find(c, id), task = this.task(c, card);
    if (card.column !== 'review') throw fail('Only a card in Review can be sent back.');
    if (task?.mode === 'worktree' && !ENDED.has(task.status) && !['lost', 'detached'].includes(task.status)) throw fail('Its changes are still in the task’s own copy. Discard them in its task first, so they aren’t left behind.');
    const why = text(reason, LIMITS.reason, 'reason');
    this.update(c, card, { column: 'ready', order: this.lastOrder(c, 'ready') + 1, reason: why ? `Sent back: ${why}` : 'Sent back for another try.', task: null });
    return this.public(c, card);
  }

  // ---- Following tasks
  follow(c, task) {
    if (!task.board) return;
    const card = this.cards(c).find(item => item.id === task.board.cardId);
    if (!card || card.task !== task.id || !['doing', 'review'].includes(card.column)) return;
    const next = this.placement(c, card, task);
    if (next) this.update(c, card, next);
  }
  // Where a card belongs given its task's state, or null when it is where it should be.
  placement(c, card, task) {
    const status = task.status;
    if (LIVE.has(status)) return card.column === 'doing' ? null : { column: 'doing', reason: null };
    if (status === 'complete' || (['integrated', 'kept'].includes(status) && task.integration)) {
      if (card.column === 'review' && card.result?.status === status) return null;
      return { column: 'review', ...(card.column === 'review' ? {} : { order: this.lastOrder(c, 'review') + 1 }), reason: null, result: this.result(task), attempts: this.ended(card, task) };
    }
    const why = {
      stopped: 'Stopped before it finished.',
      failed: `Didn’t finish${task.reason ? `: ${clip(task.reason, 300)}` : '.'}`,
      blocked: `Blocked${task.reason ? `: ${clip(task.reason, 300)}` : '.'}`,
      cancelled: 'Cancelled before it started.',
      discarded: 'Its changes were discarded.',
      lost: 'Its working copy is gone.',
      detached: 'Its folder was removed from the workspace.',
    }[status];
    if (!why) return null;
    const copy = task.mode === 'worktree' && !ENDED.has(status) && !['lost', 'detached'].includes(status) ? ' Its copy is still in Tasks, to merge or discard.' : '';
    return { column: 'ready', order: this.lastOrder(c, 'ready') + 1, reason: why + copy, task: null, attempts: this.ended(card, task) };
  }
  ended(card, task) { return (card.attempts || []).map(item => item.taskId === task.id ? { ...item, outcome: task.status, endedAt: task.endedAt || new Date().toISOString(), provider: task.provider, model: task.model ?? null, effort: task.effort ?? null } : item); }
  // What a finished card shows in Review: the agent's own summary, the files it changed and its test result.
  result(task) {
    const lane = this.main.tasks.lanes.get(task.id), conversation = lane?.c, run = conversation?.lastRun;
    const reply = conversation?.messages?.findLast(message => message.role === 'assistant' && message.runId === run?.id && message.text?.trim())?.text || '';
    const files = task.integration?.files ?? (run && conversation.snapshots?.[run.id]?.files != null ? Number(conversation.snapshots[run.id].files) || 0 : null);
    return { status: task.status, summary: clip(reply.replace(/\s+/g, ' '), LIMITS.summary), files, tests: run?.check?.status || null, inCopy: task.mode === 'worktree', at: new Date().toISOString() };
  }
  // After a restart, or anything else that moved a task while the board wasn't listening.
  reconcile(c) {
    for (const card of this.cards(c).filter(item => item.task && ['doing', 'review'].includes(item.column))) {
      const task = this.task(c, card);
      if (!task) { if (card.column === 'doing') this.update(c, card, { column: 'ready', task: null, reason: 'Its task is gone.' }); continue; }
      const next = this.placement(c, card, task);
      if (next) this.update(c, card, next);
    }
  }

  // ---- Showing the board
  // The board carries how many comments each card has, not their text: a full board's worth would be sent on every change.
  // The card's drawer reads them on their own.
  public(c, card) {
    const task = this.task(c, card), lane = task && this.main.tasks.lanes.get(task.id), { comments, ...rest } = card;
    return { ...rest, labels: card.labels || [], due: card.due || null, commentCount: comments?.length || 0, ...(task ? { taskState: { id: task.id, status: task.status, reason: task.reason || null, held: Boolean(task.held), mode: task.mode || null, hasWorktree: Boolean(task.worktree) && !ENDED.has(task.status), conversationId: task.conversationId || null, provider: lane?.c?.activeRun?.provider || task.provider, approvals: lane?.broker.pendingCount() || 0 } } : {}) };
  }
  list(c) { return [...this.cards(c)].sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || a.order - b.order).map(card => this.public(c, card)); }
  view(c) {
    return { cards: this.list(c), schedules: this.main.schedules?.view(c) || [], revision: c.boardRevision || 0, access: { mode: c.mode, approvalPolicy: c.approvalPolicy || 'ask' }, folders: this.folders().map(({ id, name, displayName }) => ({ id, name: displayName || name })), limits: LIMITS };
  }
}

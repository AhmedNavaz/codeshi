import { randomUUID } from 'node:crypto';
import { ARTIFACT_KINDS, SPECIALIST_ROLES, reviewDraft, upstreamLines } from './orchestration.mjs';
import { attachmentLimits } from './attachments.mjs';

// The task board (#132, first stage): cards you write, sort and run by hand. Cards are records in the workspace chat's
// journal, beside the tasks they start, so they live in Codeshi's data and a crash finds them as they were. Running a card
// starts an ordinary task (#88) with the card's own agent under a Normal policy. From then on the task decides where the card
// is: working puts it in Doing, finishing in Review, and stopping, failing or being discarded back in Ready with the reason.
// Only you move a card to Done. Schedules live in src/schedules.mjs; Flow choosing cards from the backlog comes later.
// One Plan (#162): the board is the Plan. A card also carries what an Orchestrate step had (a group, a role, the result it
// should produce, an acceptance check, the files it expects to change, a size, and Auto), and a plan an agent drafts
// arrives as draft cards that you edit, accept or discard. Cards run the way plan steps did: each finished card is tested
// before the cards that wait for it start, and each card is briefed, when it starts, from what earlier cards actually did.
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export const COLUMNS = ['backlog', 'ready', 'doing', 'review', 'done'];
export const PRIORITIES = ['high', 'normal', 'low'];
const PROVIDERS = ['codex', 'claude', 'gemini'], TIERS = ['light', 'standard', 'deep'];
export const LIMITS = { cards: 300, title: 200, notes: 20000, checks: 20, check: 300, dependsOn: 20, reason: 500, summary: 600, labels: 8, label: 32, comments: 100, comment: 4000, promptComments: 8000, group: 60, files: 12, path: 300, goal: 4000 };
const ARTIFACT_NAME = { contract: 'Contract', schema: 'Schema', diff: 'Changes', test_evidence: 'Test evidence', findings: 'Findings' };
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
    for (const c of main.conversations.values()) { this.reconcile(c); this.adopt(c); }
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
    // Auto (#162) is a choice you make on the card: routing picks the agent when it runs. Choosing an agent turns it off.
    if (!card || 'auto' in input) changes.auto = input.auto === true;
    if (changes.auto) changes.agent = null;
    else if (changes.agent && card?.auto && !('auto' in input)) changes.auto = false;
    // What a plan step had (#162). The agent is told the role, the files, the result and the check; the group only sorts.
    if (!card || 'group' in input) {
      const group = input.group == null ? '' : text(String(input.group).replace(/\s+/g, ' '), LIMITS.group, 'group');
      changes.group = group || null;
    }
    if (!card || 'role' in input) {
      const role = input.role ?? 'builder';
      if (!SPECIALIST_ROLES.includes(role)) throw fail('Choose builder, reviewer, frontend, backend, database, design or QA as the card’s role.', 400);
      changes.role = role;
    }
    if (!card || 'artifact' in input) {
      const artifact = input.artifact ?? null;
      if (artifact !== null && !ARTIFACT_KINDS.includes(artifact)) throw fail('Choose a contract, schema, changes, test evidence or findings as what the card produces.', 400);
      changes.artifact = artifact;
    }
    if (!card || 'check' in input) changes.check = text(input.check ?? '', LIMITS.check, 'acceptance check') || null;
    if (!card || 'files' in input) {
      const files = input.files ?? [];
      if (!Array.isArray(files) || files.length > LIMITS.files || files.some(file => typeof file !== 'string' || !file.trim() || file.trim().length > LIMITS.path)) throw fail(`List up to ${LIMITS.files} files or folders, each as a path.`, 400);
      changes.files = [...new Set(files.map(file => file.trim()))];
    }
    if (!card || 'tier' in input) {
      const tier = input.tier ?? 'standard';
      if (!TIERS.includes(tier)) throw fail('Choose light, standard or deep as the card’s size.', 400);
      changes.tier = tier;
    }
    if (!card || 'folderId' in input) {
      const folderId = input.folderId ?? null;
      if (folderId !== null && !this.folders().some(folder => folder.id === folderId)) throw fail('Choose a folder in this workspace.', 400);
      changes.folderId = folderId;
    }
    // Closed to agents (#97): yours alone. Codeshi never puts it in a prompt, a brief, an attachment or an export.
    if (!card || 'closed' in input) changes.closed = input.closed === true;
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
    const changes = this.clean(c, input, card), material = ['title', 'notes', 'agent', 'auto', 'folderId', 'dependsOn', 'role', 'artifact', 'check', 'files', 'tier'].some(key => key in changes && JSON.stringify(changes[key] ?? null) !== JSON.stringify(card[key] ?? null))
      || 'checks' in changes && JSON.stringify(changes.checks.map(item => item.text)) !== JSON.stringify((card.checks || []).map(item => item.text));
    // What an agent is working from stays as it started. Ticking checks and the priority can change at any time.
    if (material && card.column === 'doing') throw fail('An agent is working on this card. Stop it first, or wait until it’s in Review.');
    // Closing a card an agent is working from can't take back what it already has, or keep it out of that task's handoffs.
    if (changes.closed && !card.closed && card.column === 'doing') throw fail('An agent is working on this card. Stop it before closing it to agents.');
    if (!Object.keys(changes).some(key => JSON.stringify(changes[key] ?? null) !== JSON.stringify(card[key] ?? null))) return this.public(c, card);
    this.update(c, card, { ...changes, ...(material ? { revision: card.revision + 1 } : {}) });
    return this.public(c, card);
  }
  // You move cards between Backlog and Ready, reopen a Done card, and order any column. Doing and Review are the runs' to
  // decide; a card leaves Review by Accept or Send back.
  move(c, id, { column = null, before = null } = {}) {
    const card = this.find(c, id), to = column || card.column;
    if (!COLUMNS.includes(to)) throw fail('Choose a column.', 400);
    if (to !== card.column && card.draft) throw fail('An agent drafted this card. Accept it first, or discard it.');
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
    if (card.draft) setTimeout(() => this.main.queue?.tick(c), 0);
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

  // ---- Closed to agents (#97)
  // The whole Plan, or one card, can be closed to agents. Codeshi then never puts it in a prompt: a closed card can't run,
  // be scheduled or attached, the cards that build on it aren't told about it, attaching the Plan leaves it out, and so
  // does an export unless you ask for everything. A Plan attachment sent before it was closed is left out of every later
  // prompt, retry and handoff (see gate). What it can't promise: an agent allowed to read anywhere on this computer could
  // still find Codeshi's own data files.
  closed(c, card) { return c.planClosed === true || card?.closed === true; }
  open(c) { return this.cards(c).filter(card => !this.closed(c, card)); }
  access(c, { closed } = {}) {
    if (typeof closed !== 'boolean') throw fail('Say whether agents can read the Plan.', 400);
    if (closed === (c.planClosed === true)) return { closed };
    const working = this.cards(c).filter(card => card.column === 'doing');
    if (closed && working.length) throw fail(`${working.length === 1 ? `An agent is working on “${working[0].title}”` : `Agents are working on ${working.length} cards`}. Stop ${working.length === 1 ? 'it' : 'them'} before closing the Plan to agents.`);
    this.main.record(c, { type: 'plan_access', closed, at: new Date().toISOString() });
    return { closed };
  }
  // The Plan, or some of its cards, as text for an agent: what each card says, where it stands and what it waits for, with
  // only your own comments. Closed cards aren't in it or named by the cards that wait for them. Task ids, places on the
  // canvas and run history are left out.
  agentText(c, chosen, { whole = false } = {}) {
    const open = new Set(this.open(c).map(card => card.id)), all = this.list(c);
    const shown = all.filter(card => open.has(card.id) && (whole || chosen.includes(card.id)));
    const name = id => all.find(item => item.id === id)?.title.replace(/\s+/g, ' ');
    const lines = whole ? ['# Plan', '', `This workspace’s Plan in Codeshi: ${shown.length} ${shown.length === 1 ? 'card' : 'cards'}. It is the person’s plan of the work, for reference. Do only what the message asks.`, ''] : [];
    for (const card of shown) {
      lines.push(`${whole ? '## ' : '# Card: '}${card.title.replace(/\s+/g, ' ')}`, '');
      const facts = [`Status: ${card.draft ? 'Draft, not accepted yet' : COLUMN_NAME[card.column]}`];
      if (card.group) facts.push(`Group: ${card.group}`);
      if (card.role && card.role !== 'builder') facts.push(`Role: ${card.role}`);
      if (card.priority !== 'normal') facts.push(`Priority: ${card.priority}`);
      if (card.labels?.length) facts.push(`Labels: ${card.labels.join(', ')}`);
      if (card.due) facts.push(`Due: ${card.due}`);
      if (card.artifact) facts.push(`Produces: ${ARTIFACT_NAME[card.artifact]}`);
      if (card.files?.length) facts.push(`Files: ${card.files.join(', ')}`);
      if (card.check) facts.push(`Acceptance check: ${card.check}`);
      const after = (card.dependsOn || []).filter(id => open.has(id)).map(name).filter(Boolean);
      if (after.length) facts.push(`Waits for: ${after.map(title => `“${title}”`).join(', ')}`);
      if (!whole) {
        const next = all.filter(other => open.has(other.id) && other.dependsOn?.includes(card.id)).map(other => `“${other.title.replace(/\s+/g, ' ')}”`);
        if (next.length) facts.push(`Cards that wait for it: ${next.join(', ')}`);
      }
      if (card.result?.summary && ['review', 'done'].includes(card.column)) facts.push(`What its agent reported: ${card.result.summary}`);
      lines.push(...facts.map(fact => `- ${fact}`), '');
      if (card.notes) lines.push(card.notes, '');
      if (card.checks?.length) lines.push('Done means:', '', ...card.checks.map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`), '');
      const said = this.comments(c, card.id).filter(item => item.by?.kind === 'you');
      if (said.length) lines.push('The person’s comments:', '', ...said.map(item => `- ${item.at.slice(0, 10)}: ${item.text.replace(/\n/g, '\n  ')}`), '');
    }
    return { text: `${lines.join('\n').trimEnd()}\n`, cards: shown.map(card => card.id), leftOut: whole ? all.length - shown.length : 0 };
  }
  // Attaching the Plan, or one card, to your next message: its text is saved as an attachment, so the message box shows
  // its size and you can open exactly what will be sent. The attachment remembers its cards, so closing any of them, or
  // the Plan, later keeps it out of every prompt from then on.
  attach(c, { cardId = null } = {}) {
    if (c.planClosed) throw fail('This Plan is closed to agents. Open it to agents to attach it.');
    let made;
    if (cardId) {
      const card = this.find(c, cardId);
      if (card.closed) throw fail(`“${card.title}” is closed to agents. Open it to agents to attach it.`);
      made = this.agentText(c, [card.id]);
    } else {
      if (!this.cards(c).length) throw fail('The Plan has no cards to attach yet.');
      made = this.agentText(c, [], { whole: true });
      if (!made.cards.length) throw fail('Every card on the Plan is closed to agents, so there is nothing to attach.');
    }
    const bytes = Buffer.byteLength(made.text), most = attachmentLimits.textBytes;
    if (bytes > most) throw fail(`${cardId ? 'This card’s' : 'The Plan’s'} text is ${Math.ceil(bytes / 1024)} KB, more than the ${most / 1024} KB an attachment can hold.${cardId ? ' Shorten its description or comments.' : ' Attach single cards instead.'}`, 413);
    const card = cardId ? this.find(c, cardId) : null;
    const name = card ? `Card – ${card.title.replace(/[\x00-\x1f\x7f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}.md` : 'Plan.md';
    const meta = this.main.attachments.put({ name, data: Buffer.from(made.text).toString('base64') }, { plan: { conversationId: c.id, cards: made.cards, whole: !card } });
    return { attachment: meta, cards: made.cards.length, leftOut: made.leftOut };
  }
  // Why a Plan attachment must stay out of a prompt now, or null when it can go. Asked each time a prompt is put together,
  // so a handoff or retry after closing leaves it out too.
  gate(plan) {
    const c = this.main.conversations.get(plan?.conversationId);
    if (!c) return null;
    if (c.planClosed) return 'the Plan was closed to agents after it was attached';
    if ((plan.cards || []).some(id => this.cards(c).find(card => card.id === id)?.closed)) return 'a card in it was closed to agents after it was attached';
    return null;
  }

  // ---- Drafts (#162)
  // A plan an agent drafted becomes draft cards in Backlog, in its order, each waiting for the cards its step waited for.
  // A draft can be edited like any card but can't run, be scheduled or move to Ready until you accept it. The plan checks
  // (reviewDraft) are written on the cards they're about. Every card is checked before any is recorded, so a plan that
  // doesn't fit adds nothing.
  draft(c, plan, { by = null } = {}) {
    const steps = plan.steps || [], room = LIMITS.cards - this.cards(c).length;
    if (steps.length > room) throw fail(`This plan has ${steps.length} cards, and the Plan has room for ${Math.max(0, room)} more. Remove some finished cards, then plan again.`);
    const ids = new Map(steps.map(step => [step.id, randomUUID()])), notes = reviewDraft(steps), now = new Date().toISOString();
    const documents = (plan.documents || []).slice(0, 20).map(name => String(name).slice(0, 200));
    const batch = { id: plan.id, summary: plan.summary || '', ...(plan.questions?.length ? { questions: plan.questions } : {}), ...(documents.length ? { documents } : {}) };
    const source = { kind: 'orchestrate', planId: plan.id, goal: String(plan.goal || '').slice(0, LIMITS.goal), summary: plan.summary || '', ...(documents.length ? { documents } : {}) };
    const made = steps.map((step, index) => {
      const input = { title: step.title, notes: step.instructions, checks: (step.done || []).map(item => ({ text: item.slice(0, LIMITS.check), done: false })), role: step.role || 'builder', artifact: step.artifact || null, check: step.check || null, files: (step.files || []).slice(0, LIMITS.files), tier: step.tier || 'standard', group: step.phase ? step.phase.slice(0, LIMITS.group) : null, priority: 'normal', labels: [], due: null, folderId: null, dependsOn: [] };
      const fields = this.clean(c, input);
      // A drafted step has no agent: it's Auto, shown as such on the draft, until you choose one or accept it.
      return { id: ids.get(step.id), ...fields, agent: step.agent || null, auto: !step.agent, dependsOn: step.dependsOn.map(id => ids.get(id)).filter(Boolean), column: 'backlog', order: this.lastOrder(c, 'backlog') + 1 + index, revision: 1, createdBy: 'agent', createdAt: now, updatedAt: now, attempts: [], source, draft: { by, at: now, batch, notes: notes[step.id] || [] } };
    });
    for (const card of made) this.main.record(c, { type: 'board_card', card });
    return made.map(card => card.id);
  }
  // A plan the planner just returned, or a draft plan saved before the Plan held them, moves onto the Plan as draft cards.
  // One that doesn't fit stays a plan that says why, so nothing is lost.
  adopt(c, id = null) {
    for (const plan of (c.orchestrations || []).filter(item => (id ? item.id === id : true) && item.status === 'draft' && item.steps?.length)) {
      try {
        const cards = this.draft(c, plan, { by: plan.planner ? { kind: 'agent', provider: plan.planner.provider, model: plan.planner.model || null } : { kind: 'you' } });
        this.main.record(c, { type: 'orchestration_moved', id: plan.id, cards });
      } catch (error) {
        this.main.record(c, { type: 'orchestration_result', id: plan.id, result: { status: 'failed', summary: error.message, steps: [] } });
      }
    }
  }
  // Accepting keeps the card as you left it and takes away the draft mark: one with an agent, or on Auto, goes to Ready.
  // Accepting several keeps their order. Discarding removes them, and the cards that waited for one stop waiting.
  drafts(c, { action, ids } = {}) {
    if (!['accept', 'discard'].includes(action)) throw fail('Accept or discard the drafts.', 400);
    if (!Array.isArray(ids) || !ids.length) throw fail('Choose the drafts.', 400);
    const chosen = [...new Set(ids)].map(id => this.find(c, id));
    for (const card of chosen) if (!card.draft) throw fail(`“${card.title}” isn’t a draft.`);
    // Queued messages wait while a drafted plan's cards are undecided, so they look again once they are.
    setTimeout(() => this.main.queue?.tick(c), 0);
    if (action === 'discard') { for (const card of chosen) this.remove(c, card.id); return { discarded: chosen.length }; }
    for (const card of [...chosen].sort((a, b) => a.order - b.order)) {
      const ready = Boolean(card.agent || card.auto);
      this.update(c, card, { draft: null, ...(ready ? { column: 'ready', order: this.lastOrder(c, 'ready') + 1 } : {}), acceptedDraftAt: new Date().toISOString() });
    }
    return { accepted: chosen.length };
  }

  // ---- Export (#97)
  // The board as Markdown that reads well without Codeshi: a Mermaid chart of the cards and what waits for what, then each
  // column's cards with everything you wrote on them. Task ids, run history and the agents' own summaries are left out.
  // Cards closed to agents (#97) are left out unless you ask for everything, since an export can end up where an agent
  // reads it; then each says it's closed.
  markdown(c, { now = new Date(), includeClosed = false } = {}) {
    const every = this.list(c), all = includeClosed ? every : every.filter(card => !this.closed(c, card)), short = new Map(all.map((card, index) => [card.id, `c${index + 1}`]));
    const folder = id => this.folders().find(item => item.id === id), folderName = id => { const found = folder(id); return found ? found.displayName || found.name : ''; };
    const closedCount = every.filter(card => this.closed(c, card)).length;
    const lines = ['# Plan', '', `Exported from Codeshi on ${now.toISOString().slice(0, 10)}. ${all.length} ${all.length === 1 ? 'card' : 'cards'}.${closedCount ? includeClosed ? ` ${closedCount === every.length ? 'The Plan is' : closedCount === 1 ? '1 card is' : `${closedCount} cards are`} closed to agents: keep this file where agents can’t read it.` : ` ${closedCount === 1 ? '1 card' : `${closedCount} cards`} closed to agents ${closedCount === 1 ? 'is' : 'are'} left out.` : ''}`, ''];
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
        if (card.draft) facts.push('Draft: drafted by an agent, not accepted yet');
        if (includeClosed && this.closed(c, card)) facts.push('Closed to agents');
        if (card.group) facts.push(`Group: ${card.group}`);
        if (card.role && card.role !== 'builder') facts.push(`Role: ${card.role}`);
        if (card.priority !== 'normal') facts.push(`Priority: ${card.priority}`);
        if (card.labels?.length) facts.push(`Labels: ${card.labels.join(', ')}`);
        if (card.due) facts.push(`Due: ${card.due}`);
        facts.push(`Agent: ${card.agent ? `${card.agent.provider[0].toUpperCase()}${card.agent.provider.slice(1)}${card.agent.model ? ` (${card.agent.model}${card.agent.effort ? `, ${card.agent.effort}` : ''})` : ''}` : card.auto ? `Auto (${card.tier || 'standard'})` : 'not chosen'}`);
        if (card.artifact) facts.push(`Produces: ${ARTIFACT_NAME[card.artifact]}`);
        if (card.files?.length) facts.push(`Files: ${card.files.join(', ')}`);
        if (card.check) facts.push(`Acceptance check: \`${card.check.replace(/`/g, "'")}\``);
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
  // A card on Auto (#162) runs with the agent the page shows for it now, sent in assignments as plan steps' were. In Flow
  // with routing on, it is chosen again when it starts, at the card's size, from fresh usage (#12); in Normal it runs with
  // exactly what was shown. A schedule can't run an Auto card, as it has no page to show the choice.
  // billingConfirmed (#108) is your yes, asked on the Plan before any card whose agent bills by use, or whose billing can't be
  // confirmed. Without it such a card's task stops when it starts, as any run does, so nothing is charged unasked. A schedule
  // never sends it, as no one is there to ask.
  run(c, { ids, executionRevision, assignments = null, billingConfirmed = false } = {}, { access = null, requestId = null, from = ['ready'], note = '', source = 'board' } = {}) {
    if (!Array.isArray(ids) || !ids.length) throw fail('Choose the cards to run.', 400);
    if (typeof billingConfirmed !== 'boolean') throw fail('Confirm billing explicitly.', 400);
    const chosen = [...new Set(ids)].map(id => this.find(c, id)), picked = new Set(chosen.map(card => card.id));
    const folders = this.folders(), mode = access?.mode || c.mode, approvalPolicy = access?.approvalPolicy || c.approvalPolicy || 'ask';
    const defaults = this.main.execution.defaults(c), routed = Boolean(c.routing) && defaults.automation?.routing === true, who = new Map();
    for (const card of chosen) {
      const name = `“${card.title}”`;
      if (card.draft) throw fail(`An agent drafted ${name}. Accept it before running it.`);
      if (this.closed(c, card)) throw fail(c.planClosed ? 'This Plan is closed to agents. Open it to agents to run its cards.' : `${name} is closed to agents. Open it to agents to run it.`);
      if (!from.includes(card.column)) throw fail(card.column === 'doing' ? `${name} is still running.` : card.column === 'review' ? `${name} is waiting in Review.` : `${name} isn’t in Ready. Move it there to run it.`);
      let pick = card.agent ? { provider: card.agent.provider, model: card.agent.model, effort: card.agent.effort, routing: null } : null;
      if (!pick && card.auto) {
        const given = assignments && typeof assignments === 'object' ? assignments[card.id] : null;
        if (!given || typeof given !== 'object' || !PROVIDERS.includes(given.provider)) throw fail(`${name} is on Auto. Run it from the Plan, which shows the agent Auto picks, or choose an agent for it.`, 400);
        const model = given.model ? text(given.model, 200, 'model') : null, effort = given.effort || null;
        this.main.validateSelection(model, 'auto', effort);
        pick = { provider: given.provider, model, effort, routing: routed ? { mode: defaults.routingMode, planned: card.tier || 'standard', ...(c.routing.allowApi === true ? { allowApi: true } : {}) } : null };
      }
      if (!pick) throw fail(`Choose an agent for ${name}.`, 400);
      const folderId = card.folderId || (folders.length === 1 ? folders[0].id : null);
      if (!folderId || !folders.some(folder => folder.id === folderId)) throw fail(`Choose the folder ${name} works in.`, 400);
      for (const id of card.dependsOn || []) {
        const before = this.cards(c).find(item => item.id === id);
        if (before && before.column !== 'done' && !picked.has(id)) throw fail(`${name} waits for “${before.title}”, which isn’t done. Run them together, or finish that one first.`);
      }
      this.main.checkRunSettings(pick.provider, mode, approvalPolicy);
      const allowed = this.main.budget.allows(c, pick.provider, pick.model);
      if (!allowed.allowed) throw fail(`${name}: ${allowed.reason}`);
      who.set(card.id, pick);
    }
    // Cards a chosen card waits for start first.
    const order = [], placed = new Set(), visit = card => { if (placed.has(card.id)) return; placed.add(card.id); for (const id of card.dependsOn || []) if (picked.has(id)) visit(this.find(c, id)); order.push(card); };
    for (const card of chosen) visit(card);
    const tasks = {}, made = [], attempt = randomUUID().slice(0, 8);
    try {
      for (const card of order) {
        const folderId = card.folderId || folders[0].id, policyId = randomUUID(), id = requestId && chosen.length === 1 ? requestId : `board-${card.id}-${attempt}`, pick = who.get(card.id);
        // Normal: the card's own agent, model and effort, whatever the workspace's default is. An Auto card routed in Flow
        // runs under the workspace's own policy, which is what lets it be chosen again when it starts.
        this.main.execution.ensure(c, policyId, pick.routing ? { source, requestId: id } : { config: { mode: 'normal' }, source, requestId: id });
        // The text here is the card as it is now; the task is briefed again when it starts, with what earlier cards did.
        const task = this.main.tasks.start(c, { text: this.prompt(c, card) + (note ? `\n\n${note}` : ''), title: card.title, provider: pick.provider, model: pick.model, effort: pick.effort, ...(pick.routing ? { routing: pick.routing } : {}), mode, approvalPolicy, folderId, billingConfirmed, requestId: id, dependsOn: (card.dependsOn || []).filter(id => picked.has(id)).map(id => tasks[id]), executionRevision }, { held: true, queueExecution: this.main.execution.token(c, policyId), board: { cardId: card.id, revision: card.revision, ...(card.group ? { group: card.group } : {}), ...(note ? { note } : {}) } });
        tasks[card.id] = task.id; made.push(task.id);
      }
    } catch (error) {
      for (const id of made) { const task = this.main.tasks.find(c, id); if (task.status === 'waiting') this.main.tasks.finish(c, task, { status: 'cancelled' }); }
      throw error;
    }
    const now = new Date().toISOString();
    for (const card of order) {
      const pick = who.get(card.id), attemptRecord = { taskId: tasks[card.id], revision: card.revision, provider: pick.provider, model: pick.model, effort: pick.effort, ...(card.auto ? { auto: true } : {}), startedAt: now };
      this.update(c, card, { column: 'doing', task: tasks[card.id], reason: null, result: null, attempts: [...(card.attempts || []), attemptRecord].slice(-20) });
    }
    for (const id of made) this.main.tasks.update(c, this.main.tasks.find(c, id), { held: false, reason: 'Starting' });
    this.main.tasks.tick(c);
    return { tasks, cards: this.list(c) };
  }
  // What the agent is told: the card as you wrote it, with what done means, its role, files, result and check, the plan it
  // came from, and, once results is given (when it starts), what each card it builds on did: its report, files and tests.
  prompt(c, card, results = {}) {
    const parts = [];
    if (card.source?.goal) parts.push('This card is part of a plan for:', card.source.goal, ...(card.source.summary ? ['', `Plan: ${card.source.summary}`] : []), '', 'Other agents do the other cards, so do only this one.', '');
    parts.push(`${card.title}${card.role && card.role !== 'builder' ? ` (${card.role})` : ''}`);
    if (card.notes) parts.push('', card.notes);
    if (card.files?.length) parts.push('', `Files or folders it expects to change: ${card.files.join(', ')}`);
    if (card.checks?.length) parts.push('', 'Done means:', ...card.checks.map(item => `- ${item.text}`));
    if (card.check) parts.push('', `Acceptance check: ${card.check}`);
    if (card.artifact) parts.push('', `When you finish, your report is this card’s ${ARTIFACT_NAME[card.artifact].toLowerCase()}: the cards after it are told it.`);
    // A card closed to agents (#97) isn't named, and its result isn't passed on.
    const before = (card.dependsOn || []).map(id => this.cards(c).find(item => item.id === id)).filter(other => other && !this.closed(c, other));
    if (before.length) {
      const reported = before.some(other => results[other.id]);
      parts.push('', reported ? 'This builds on these cards, which have finished:' : `This builds on earlier cards: ${before.map(other => `“${other.title}”`).join(', ')}.`);
      if (reported) for (const other of before) parts.push(`- “${other.title}”${other.role && other.role !== 'builder' ? ` (${other.role})` : ''}`, ...(results[other.id] ? upstreamLines(other, results[other.id]) : []));
      if (reported) parts.push('', 'Those reports are what the earlier agents said. Check the files themselves before relying on them.');
    }
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
  // ---- One way to run (#162)
  // The brief a card's task starts with, written when it starts: what each card it waits for actually did, from that card's
  // task in this run, or from its accepted result when it finished earlier. builtOn says which version of each it saw.
  brief(c, task) {
    const card = this.cards(c).find(item => item.id === task.board?.cardId);
    if (!card) return null;
    const results = {}, builtOn = {};
    for (const id of card.dependsOn || []) {
      const other = this.cards(c).find(item => item.id === id); if (!other || this.closed(c, other)) continue;
      const earlier = (c.parallelTasks || []).filter(item => item.board?.cardId === id && item.id !== task.id && ['complete', 'integrated', 'kept'].includes(item.status)).at(-1);
      if (earlier) {
        results[id] = { status: earlier.status, branch: earlier.integration?.branch || null, files: earlier.stepResult?.files || [], summary: earlier.stepResult?.summary || other.result?.summary || '', check: earlier.stepCheck?.status === 'running' ? null : earlier.stepCheck || null };
        if (earlier.stepResult?.at) builtOn[id] = earlier.stepResult.at;
      } else if (other.result) results[id] = { status: other.result.status, files: [], summary: other.result.summary || '', check: other.result.tests === 'passed' ? { outcome: 'passed', command: other.result.testCommand || '' } : null };
    }
    const note = task.board?.note ? `\n\n${task.board.note}` : '';
    return { text: this.prompt(c, card, results) + note, builtOn };
  }
  // The card a task works on, as the step the coordinator tests and gates (#89): its title, role, result and check, and
  // whether any card waits for it.
  stepFor(c, task) {
    const card = this.cards(c).find(item => item.id === task.board?.cardId);
    if (!card) return null;
    return { card, step: { id: card.id, title: card.title, role: card.role || 'builder', artifact: card.artifact || null, check: card.check || null, dependsOn: card.dependsOn || [] }, dependents: this.cards(c).some(other => other.dependsOn?.includes(card.id)) };
  }
  // A finished card's tests: run them again, or let the cards after it build on it anyway. Either is yours to decide.
  recheck(c, id) {
    const card = this.find(c, id), task = this.task(c, card);
    if (!task || card.column !== 'review') throw fail('Only a finished card can be checked again.');
    this.main.tasks.recheckTask(c, task);
    return this.public(c, this.find(c, id));
  }
  proceed(c, id) {
    const card = this.find(c, id), task = this.task(c, card);
    if (!task || card.column !== 'review') throw fail('Nothing is holding the cards after this one.');
    this.main.tasks.continueTask(c, task);
    return this.public(c, this.find(c, id));
  }
  // Stopping a group, or any set of cards, at once: those working stop and those waiting are cancelled.
  stopMany(c, { ids } = {}) {
    if (!Array.isArray(ids) || !ids.length) throw fail('Choose the cards to stop.', 400);
    let stopped = 0;
    for (const id of new Set(ids)) { const card = this.find(c, id); if (card.column === 'doing' && this.task(c, card)) { this.stop(c, id); stopped++; } }
    if (!stopped) throw fail('None of these cards is running.');
    return { stopped };
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
      // Its tests finish after the task does (#162), so the card's result follows them too.
      if (card.column === 'review' && card.result?.status === status && card.result?.tests === this.tests(task) && Boolean(card.result?.testsAccepted) === Boolean(task.stepCheck?.accepted)) return null;
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
    const check = task.stepCheck;
    return { status: task.status, summary: clip(reply.replace(/\s+/g, ' '), LIMITS.summary), files, tests: this.tests(task) ?? run?.check?.status ?? null, ...(check?.reason ? { testsReason: clip(check.reason, LIMITS.reason) } : {}), ...(check?.command ? { testCommand: check.command } : {}), ...(check?.accepted ? { testsAccepted: true } : {}), inCopy: task.mode === 'worktree', at: new Date().toISOString() };
  }
  // What the card's own tests say (#162): running, passed, failed, interrupted, no changes to test, or not tested.
  tests(task) {
    const check = task.stepCheck;
    if (!check) return null;
    if (check.status === 'running') return 'running';
    if (check.status === 'interrupted') return 'interrupted';
    return { passed: 'passed', failed: 'failed', no_change: 'no-change' }[check.outcome] || 'unverified';
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
    const check = task?.stepCheck, held = Boolean(task && task.status === 'complete' && check && (check.status === 'running' || ((check.outcome === 'failed' || check.status === 'interrupted') && !check.accepted)));
    return { ...rest, labels: card.labels || [], due: card.due || null, group: card.group || null, role: card.role || 'builder', artifact: card.artifact || null, check: card.check || null, files: card.files || [], tier: card.tier || 'standard', auto: card.auto === true, closed: card.closed === true, draft: card.draft || null, commentCount: comments?.length || 0, ...(task ? { taskState: { id: task.id, status: task.status, reason: task.reason || null, held: Boolean(task.held), mode: task.mode || null, hasWorktree: Boolean(task.worktree) && !ENDED.has(task.status), conversationId: task.conversationId || null, provider: lane?.c?.activeRun?.provider || task.provider, model: lane?.c?.activeRun?.model ?? task.model ?? null, effort: lane?.c?.activeRun?.effort ?? task.effort ?? null, approvals: lane?.broker.pendingCount() || 0, ...(check ? { tests: this.tests(task), testsReason: check.reason || null, testCommand: check.command || null, testOutput: check.outcome === 'failed' ? String(check.output || '').slice(-2000) : null, holds: held } : {}) } } : {}) };
  }
  list(c) { return [...this.cards(c)].sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || a.order - b.order).map(card => this.public(c, card)); }
  view(c) {
    return { cards: this.list(c), closed: c.planClosed === true, schedules: this.main.schedules?.view(c) || [], revision: c.boardRevision || 0, access: { mode: c.mode, approvalPolicy: c.approvalPolicy || 'ask' }, folders: this.folders().map(({ id, name, displayName }) => ({ id, name: displayName || name })), limits: LIMITS };
  }
}

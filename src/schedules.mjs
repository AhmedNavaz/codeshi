import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { limitState } from './resume.mjs';
import { sharedLimits } from './board.mjs';

// Schedules (#132, second stage): a board card or a prompt that runs once at a set time, or every day, every weekday or
// every week. A Normal schedule binds the agent, model and effort, the folder, the workspace's access and
// permission setting when it was scheduled, and for a card the card's revision. Nothing is chosen for it later.
//
// A Flow schedule (#132, third stage) is made in Flow and binds a scope instead of an agent: the exact cards you ticked,
// at their revisions, or a prompt, with Flow's mode as it was then and one limit that every run shares. At its time Flow
// picks an agent for each card without one, as Flow's Run Ready does, and nothing else from the Plan is added:
// - It needs a limit (working minutes, new tokens or API spend), as no one may be watching. Agents that bill by use are
//   never picked, and a card you gave one of those agents stops when it starts, as for any schedule.
// - A ticked card that changed or left the Plan stops the time from running, as an edited card does in Normal.
// - Before it starts, Flow reads every agent's usage and picks again. When no agent it may use has room, the time
//   waits or is missed as a Normal one does, without naming one agent.
// - Leaving Flow, or taking over from it, pauses every Flow schedule as well as ending what its runs haven't started.
//   It is made, changed, resumed and run by you only in Flow.
//
// - Each schedule is a record in the workspace chat's journal, beside the board's cards. Its next time is moved on in
//   the same record that starts a run, and the run's task has an ID made from the schedule and that time, so a restart
//   or a second timer never starts the same time twice.
// - Times are the computer's local time. A run that starts more than ten minutes late (Codeshi was closed, or the
//   computer was asleep) is missed: it waits for you with Run now, unless you allowed it to run late. Missed times of a
//   repeating schedule fold into one, and a schedule never wakes a sleeping computer.
// - A card edited after it was scheduled doesn't run: what it says has changed, so it waits for Run now, which uses
//   the card as it is now. Saving the schedule again does the same.
// - A scheduled run is told not to push, deploy or publish anything. Approvals wait for you as for any run.
// - At its time, Codeshi reads the agent's usage first. An agent at its limit doesn't start a run that would stop at
//   once: with Run late, or when the limit resets within the ten minutes, the time waits for the reset on the same agent
//   (never another one), checked again at the reset and every ten minutes. Otherwise it is missed, with the reset time.
//   A wait gives way to the schedule's next time, and ends as missed after a day. Usage that can't be read doesn't stop
//   the run.
export const REPEATS = ['once', 'daily', 'weekdays', 'weekly'];
export const LATE_MS = 10 * 60 * 1000;
export const RECHECK_MS = 10 * 60 * 1000;
export const WAIT_MS = 24 * 60 * 60 * 1000;
const READ_MS = 6000, ROUTE_MS = 15000;
export const LIMITS = { schedules: 50, title: 200, text: 20000, reason: 300, cards: 20 };
const EFFORT = { light: 'low', standard: 'medium', deep: 'high' };
const routing = () => globalThis.relayRouting;
const modeOf = mode => routing()?.normalizeMode?.(mode) || mode || 'smart';
const PROVIDERS = ['codex', 'claude', 'gemini'];
const NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
const LIVE = new Set(['waiting', 'running']);
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/, DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const iso = ms => new Date(ms).toISOString();
const clip = (value, limit) => { const line = String(value || '').replace(/\s+/g, ' ').trim(); return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line; };

// The first time after `after` (milliseconds) that a schedule runs, in the computer's local time, or null when a
// one-off time has passed. A time that a clock change skips runs when the clock reaches it again, as Date places it.
export function nextOccurrence(when, after) {
  const [hour, minute] = when.time.split(':').map(Number);
  if (when.repeat === 'once') {
    const [year, month, day] = when.date.split('-').map(Number), at = new Date(year, month - 1, day, hour, minute).getTime();
    return at > after ? at : null;
  }
  const from = new Date(after);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hour, minute), at = day.getTime(), weekday = day.getDay();
    if (at <= after) continue;
    if (when.repeat === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (when.repeat === 'weekly' && weekday !== when.weekday) continue;
    return at;
  }
  return null;
}

// What `when` must look like: a repeat, a 24-hour time, a date for a one-off time and a weekday for a weekly one.
export function cleanWhen(input) {
  if (!input || typeof input !== 'object') throw fail('Choose when it runs.', 400);
  const repeat = input.repeat ?? 'once';
  if (!REPEATS.includes(repeat)) throw fail('Choose once, every day, every weekday or every week.', 400);
  if (typeof input.time !== 'string' || !TIME.test(input.time)) throw fail('Choose a time of day.', 400);
  const when = { repeat, time: input.time };
  if (repeat === 'once') {
    const match = typeof input.date === 'string' && input.date.match(DATE);
    const date = match && new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!date || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) throw fail('Choose a date.', 400);
    when.date = input.date;
  }
  if (repeat === 'weekly') {
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) throw fail('Choose the day of the week.', 400);
    when.weekday = input.weekday;
  }
  return when;
}

export class Schedules {
  constructor(main, { now = () => Date.now(), tickMs = 20000 } = {}) {
    Object.assign(this, { main, now, tickMs });
    this.timer = null; this.closed = false;
    // The marker reopens this workspace when Codeshi starts, so its schedules keep running after a restart.
    this.marker = path.join(main.dataDir, 'schedules-pending');
    this.arm();
    // A time that passed while Codeshi was closed is looked at once startup has finished.
    setTimeout(() => this.tick(), 0).unref?.();
  }
  all() { return [...this.main.conversations.values()].flatMap(c => (c.schedules || []).map(schedule => ({ c, schedule }))); }
  list(c) { return c.schedules || []; }
  find(c, id) { const schedule = this.list(c).find(item => item.id === id); if (!schedule) throw fail('That schedule is no longer here.', 404); return schedule; }
  update(c, schedule, changes) { this.main.record(c, { type: 'schedule_update', id: schedule.id, changes: { ...changes, updatedAt: new Date(this.now()).toISOString() } }); }
  // Schedules with a time still to come, or a time waiting for a usage limit to reset. Only these keep Codeshi open in
  // the menu bar after its window closes.
  get waiting() { return this.all().filter(({ schedule }) => !schedule.paused && (schedule.nextAt || schedule.waiting)).length; }
  // Times waiting for a reset, for the menu bar.
  get resets() { return this.all().filter(({ schedule }) => !schedule.paused && schedule.waiting).map(({ c, schedule }) => ({ id: schedule.id, title: this.title(c, schedule), provider: schedule.waiting.provider, resetsAt: schedule.waiting.resetsAt })); }
  folders() { return this.main.workspaceFolders; }

  arm() {
    if (this.closed) return;
    const waiting = this.waiting > 0;
    try { if (waiting) fs.writeFileSync(this.marker, ''); else fs.rmSync(this.marker, { force: true }); } catch {}
    if (waiting && !this.timer) { this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref?.(); }
    if (!waiting && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ---- Writing schedules
  // The workspace's access now, which the schedule keeps: a later change to the workspace doesn't change a scheduled run.
  access(c) { return { mode: c.mode, approvalPolicy: c.approvalPolicy || 'ask' }; }
  // Whether the workspace is in Flow now: only then is a Flow schedule made, changed, resumed or run by you.
  inFlow(c) { return Boolean(c.routing) && this.main.execution.defaults(c).automation?.routing === true; }
  needFlow(c, what) { if (!this.inFlow(c)) throw fail(`Turn Flow on to ${what} a Flow schedule. Leaving Flow paused it.`); }
  // What a Flow schedule binds besides its scope: Flow's mode now and the limit each run shares. Null for a Normal one.
  flowOf(c, input, previous = null) {
    if (previous && 'flow' in input && Boolean(input.flow) !== Boolean(previous.flow)) throw fail('A schedule stays Normal or Flow. Remove it and schedule it again to change that.', 400);
    if (!('flow' in input ? input.flow : previous?.flow)) return null;
    if (!this.inFlow(c)) throw fail(previous ? 'Turn Flow on to change a Flow schedule.' : 'Flow schedules are made in Flow. Turn Flow on first.');
    const shared = sharedLimits(input.flow?.shared ?? previous?.flow.shared);
    if (Object.values(shared).every(value => value === null)) throw fail('Give a Flow schedule a limit for each run, in working minutes, new tokens or API spend. No one may be watching it.', 400);
    return { routingMode: modeOf(this.main.execution.defaults(c).routingMode), shared };
  }
  // The exact cards a Flow schedule runs, each at its revision now. A card with no agent gets one from Flow at its time.
  cards(c, ids) {
    if (!Array.isArray(ids) || !ids.length) throw fail('Tick the cards it runs.', 400);
    const unique = [...new Set(ids)];
    if (unique.length > LIMITS.cards) throw fail(`A Flow schedule can run up to ${LIMITS.cards} cards.`, 400);
    return unique.map(id => {
      const card = this.main.board.find(c, id), name = `“${card.title}”`;
      if (card.draft) throw fail(`An agent drafted ${name}. Accept it before scheduling it.`, 400);
      if (this.main.board.closed(c, card)) throw fail(c.planClosed ? 'This Plan is closed to agents, so its cards can’t be scheduled. Open it to agents first.' : `${name} is closed to agents, so it can’t be scheduled. Open it to agents first.`, 400);
      if (this.main.board.needsSubtasks(card)) throw fail(`${name} needs subtasks before it can run. Split it with an agent, or add them yourself.`, 400);
      return { cardId: card.id, revision: card.revision };
    });
  }
  target(c, input, previous = null, flow = null) {
    const type = input.target?.type ?? previous?.target.type;
    // In Flow, one card is scheduled the way several are.
    if (type === 'card' && flow) return { type: 'cards', cards: this.cards(c, [input.target?.cardId ?? previous?.target.cardId]) };
    if (type === 'cards') {
      if (!flow) throw fail('Several cards are scheduled together in Flow. Turn Flow on, or schedule each card.', 400);
      return { type: 'cards', cards: this.cards(c, input.target?.cardIds ?? previous?.target.cards?.map(item => item.cardId)) };
    }
    if (type === 'card') {
      const cardId = input.target?.cardId ?? previous?.target.cardId, card = this.main.board.find(c, cardId);
      if (card.draft) throw fail(`An agent drafted “${card.title}”. Accept it before scheduling it.`, 400);
      if (this.main.board.closed(c, card)) throw fail(c.planClosed ? 'This Plan is closed to agents, so its cards can’t be scheduled. Open it to agents first.' : `“${card.title}” is closed to agents, so it can’t be scheduled. Open it to agents first.`, 400);
      if (!card.agent) throw fail(card.auto ? `“${card.title}” is on Auto. Choose an agent for it before scheduling it, so the schedule knows who runs it.` : `Choose an agent for “${card.title}” before scheduling it.`, 400);
      return { type: 'card', cardId: card.id, revision: card.revision };
    }
    if (type !== 'prompt') throw fail('Schedule a card or a prompt.', 400);
    const given = input.target || {}, before = previous?.target.type === 'prompt' ? previous.target : {};
    const text = typeof (given.text ?? before.text) === 'string' ? (given.text ?? before.text).trim() : '';
    if (!text) throw fail('Write what the agent should do.', 400);
    if (text.length > LIMITS.text) throw fail(`A scheduled prompt can be up to ${LIMITS.text.toLocaleString('en-US')} characters.`, 400);
    const agent = given.agent === undefined ? before.agent : given.agent;
    // In a Flow schedule a prompt with no agent is Flow's to route at its time.
    if (!agent && flow) {
      const folders = this.folders(), folderId = (given.folderId ?? before.folderId) || (folders.length === 1 ? folders[0].id : null);
      if (!folderId || !folders.some(folder => folder.id === folderId)) throw fail('Choose the folder it works in.', 400);
      return { type: 'prompt', text, agent: null, folderId };
    }
    if (!agent || typeof agent !== 'object' || !PROVIDERS.includes(agent.provider)) throw fail('Choose Codex, Claude or Gemini for this schedule.', 400);
    const model = agent.model ? String(agent.model).slice(0, 200) : null, effort = agent.effort || null;
    this.main.validateSelection(model, 'auto', effort);
    const folders = this.folders(), folderId = (given.folderId ?? before.folderId) || (folders.length === 1 ? folders[0].id : null);
    if (!folderId || !folders.some(folder => folder.id === folderId)) throw fail('Choose the folder it works in.', 400);
    return { type: 'prompt', text, agent: { provider: agent.provider, model, effort }, folderId };
  }
  provider(c, target) { return target.type === 'card' ? this.main.board.find(c, target.cardId).agent?.provider || null : target.type === 'cards' ? null : target.agent?.provider || null; }
  // The agents a schedule names itself, each checked against the access it runs with. Flow's picks are checked when made.
  checkAgents(c, target, access) {
    const named = target.type === 'cards' ? target.cards.map(item => (c.board || []).find(card => card.id === item.cardId)?.agent?.provider).filter(Boolean) : [this.provider(c, target)].filter(Boolean);
    for (const provider of new Set(named)) this.main.checkRunSettings(provider, access.mode, access.approvalPolicy);
  }
  defaultTitle(c, target) {
    if (target.type === 'prompt') return clip(target.text.split('\n')[0], LIMITS.title);
    if (target.type !== 'cards' || target.cards.length < 2) return null;
    const first = (c.board || []).find(card => card.id === target.cards[0].cardId)?.title || 'A card';
    return clip(`${first} and ${target.cards.length - 1} more`, LIMITS.title);
  }
  create(c, input = {}) {
    if (this.list(c).length >= LIMITS.schedules) throw fail(`A workspace can have up to ${LIMITS.schedules} schedules. Remove some first.`);
    const flow = this.flowOf(c, input), target = this.target(c, input, null, flow), when = cleanWhen(input.when), access = this.access(c), now = this.now();
    this.checkAgents(c, target, access);
    const next = nextOccurrence(when, now);
    if (!next) throw fail('That time has passed. Choose a time still to come.', 400);
    const title = typeof input.title === 'string' && input.title.trim() ? clip(input.title, LIMITS.title) : this.defaultTitle(c, target);
    const schedule = { id: randomUUID(), ...(title ? { title } : {}), target, ...(flow ? { flow } : {}), when, runLate: input.runLate === true, access, paused: false, nextAt: iso(next), createdAt: iso(now), updatedAt: iso(now), last: null, missed: null, runs: 0 };
    this.main.record(c, { type: 'schedule', schedule });
    this.arm();
    return this.public(c, this.find(c, schedule.id));
  }
  // Saving a schedule again is agreeing to it again: it takes the card as it is now and the workspace's access now, and
  // for a Flow schedule Flow's mode now.
  edit(c, id, input = {}) {
    const schedule = this.find(c, id);
    const flow = this.flowOf(c, input, schedule), target = this.target(c, input, schedule, flow), when = 'when' in input ? cleanWhen(input.when) : schedule.when, access = this.access(c), now = this.now();
    this.checkAgents(c, target, access);
    const next = nextOccurrence(when, now);
    if (!next && !schedule.paused) throw fail('That time has passed. Choose a time still to come.', 400);
    const title = 'title' in input ? (typeof input.title === 'string' && input.title.trim() ? clip(input.title, LIMITS.title) : this.defaultTitle(c, target)) : schedule.title ?? null;
    this.update(c, schedule, { title, target, ...(flow ? { flow } : {}), when, access, runLate: 'runLate' in input ? input.runLate === true : schedule.runLate, nextAt: next ? iso(next) : null, missed: null, waiting: null });
    this.arm();
    return this.public(c, schedule);
  }
  // Paused, a schedule keeps its settings and runs nothing. Resumed, it starts from the next time still to come: the
  // times it was paused through aren't missed. A Flow schedule is resumed only in Flow.
  pause(c, id, { paused = true } = {}) {
    const schedule = this.find(c, id);
    if (paused === schedule.paused) return this.public(c, schedule);
    if (!paused && schedule.flow) this.needFlow(c, 'resume');
    const next = paused ? null : nextOccurrence(schedule.when, this.now());
    if (!paused && !next) throw fail('That time has passed. Edit the schedule to choose a new one.');
    this.update(c, schedule, { paused, nextAt: next ? iso(next) : null, waiting: null, pausedBy: null });
    this.arm();
    return this.public(c, schedule);
  }
  // Leaving Flow, or taking over from it, ends what Flow was trusted to do by itself (src/board.mjs flowEnded), so every
  // Flow schedule stops until you resume it in Flow.
  flowEnded(c) {
    for (const schedule of this.list(c).filter(item => item.flow && !item.paused)) this.update(c, schedule, { paused: true, pausedBy: 'flow', nextAt: null, waiting: null });
    this.arm();
  }
  remove(c, id) { this.find(c, id); this.main.record(c, { type: 'schedule_remove', id }); this.arm(); return { removed: true }; }
  // A card leaving the board takes its schedules with it. A Flow schedule goes once none of its cards is left; until then
  // the card it lost stops it from running on its own, as an edited one does.
  forgetCard(c, cardId) {
    for (const schedule of this.list(c)) {
      const gone = schedule.target.type === 'card' ? schedule.target.cardId === cardId : schedule.target.type === 'cards' && schedule.target.cards.every(item => item.cardId === cardId || !(c.board || []).some(card => card.id === item.cardId));
      if (gone) this.main.record(c, { type: 'schedule_remove', id: schedule.id });
    }
    this.arm();
  }
  dismiss(c, id) { const schedule = this.find(c, id); if (schedule.missed) this.update(c, schedule, { missed: null }); return this.public(c, schedule); }
  // Run now: you start it, so a card runs as it is now, with the workspace's access now, and the schedule takes both.
  // A Flow schedule runs now only in Flow, with the cards still on the Plan, and reads usage first to pick its agents.
  runNow(c, id) {
    const schedule = this.find(c, id), at = this.now();
    if (schedule.flow) return this.runFlowNow(c, schedule, at);
    if (schedule.target.type === 'card') {
      const card = this.main.board.find(c, schedule.target.cardId);
      if (card.revision !== schedule.target.revision || JSON.stringify(this.access(c)) !== JSON.stringify(schedule.access)) this.update(c, schedule, { target: { ...schedule.target, revision: card.revision }, access: this.access(c) });
    } else if (JSON.stringify(this.access(c)) !== JSON.stringify(schedule.access)) this.update(c, schedule, { access: this.access(c) });
    this.launch(c, this.find(c, id), iso(at), { manual: true });
    return this.public(c, this.find(c, id));
  }
  async runFlowNow(c, schedule, at) {
    this.needFlow(c, 'run');
    const id = schedule.id, target = schedule.target;
    if (target.type === 'cards') {
      const cards = target.cards.map(item => (c.board || []).find(card => card.id === item.cardId)).filter(Boolean);
      if (!cards.length) throw fail('None of its cards is on the Plan any more.');
      // You start it, so it takes its cards as they are now, without any that left the Plan.
      this.update(c, schedule, { target: { type: 'cards', cards: cards.map(card => ({ cardId: card.id, revision: card.revision })) }, access: this.access(c) });
    } else if (JSON.stringify(this.access(c)) !== JSON.stringify(schedule.access)) this.update(c, schedule, { access: this.access(c) });
    const { limit, picks } = await this.flowCheck(c, this.find(c, id));
    if (limit?.limited === true) throw fail(limit.reason ? `Flow found no agent for it: ${limit.reason}` : `${this.who(limit)} at its usage limit. Try again once there’s room.`);
    this.launch(c, this.find(c, id), iso(at), { manual: true, picks });
    return this.public(c, this.find(c, id));
  }

  // ---- Running
  // One look at every schedule at a time. Returns a promise, as each due time reads its agent's usage before it starts.
  tick() {
    if (this.closed) return Promise.resolve();
    this.ticking ||= this.check().catch(error => console.error('Codeshi could not check its schedules:', error.message)).finally(() => { this.ticking = null; this.arm(); });
    return this.ticking;
  }
  async check() {
    const now = this.now();
    for (const { c, schedule } of this.all()) {
      if (this.closed) return;
      if (schedule.paused) continue;
      if (schedule.nextAt && Date.parse(schedule.nextAt) <= now) {
        const dueAt = schedule.nextAt, next = nextOccurrence(schedule.when, now);
        // The next time is saved before anything starts, so this time is never started twice. A time still waiting for
        // a reset gives way to it: one run waits, not two.
        this.update(c, schedule, { nextAt: next ? iso(next) : null, ...(schedule.waiting ? { waiting: null } : {}) });
        if (now - Date.parse(dueAt) > LATE_MS && !schedule.runLate) this.miss(c, schedule, dueAt, 'Codeshi wasn’t open, or the computer was asleep, at that time.');
        else await this.attempt(c, schedule, dueAt);
      } else if (schedule.waiting && now >= Date.parse(schedule.waiting.checkAt)) await this.attempt(c, schedule, schedule.waiting.dueAt);
    }
  }
  // Reads the agent's usage, then starts the run, waits for a reset or misses the time. Anything you did meanwhile, such
  // as Run now, pausing, editing or removing the schedule, wins over what this read found.
  async attempt(c, schedule, dueAt) {
    const id = schedule.id, before = JSON.stringify([schedule.last, schedule.waiting, schedule.updatedAt]);
    // A Flow schedule whose cards changed waits for you before any usage is read.
    if (schedule.flow) { try { this.scope(c, schedule); } catch (error) { return this.miss(c, schedule, dueAt, error.message); } }
    let limit = null, picks = null;
    try { if (schedule.flow) ({ limit, picks } = await this.flowCheck(c, schedule)); else limit = await this.limit(c, schedule); } catch { /* Usage that can't be read doesn't stop the run. */ }
    schedule = this.list(c).find(item => item.id === id);
    if (this.closed || !schedule || schedule.paused || JSON.stringify([schedule.last, schedule.waiting, schedule.updatedAt]) !== before) return;
    if (limit?.limited === true) return this.wait(c, schedule, dueAt, limit);
    this.launch(c, schedule, dueAt, { waited: Boolean(schedule.waiting), picks });
  }
  // A Flow schedule's cards as they are now, or why it can't run on its own: one changed or left the Plan.
  scope(c, schedule, { manual = false } = {}) {
    if (schedule.target.type !== 'cards') return [];
    return schedule.target.cards.map(({ cardId, revision }) => {
      const card = (c.board || []).find(item => item.id === cardId);
      if (!card) throw fail('A card it runs left the Plan. Run it now to run the rest, or save the schedule again.');
      if (!manual && card.revision !== revision) throw fail(`“${card.title}” changed after it was scheduled.`);
      return card;
    });
  }
  // Flow's check before a run: every agent's usage read now, and an agent picked for each card with none, and for a
  // prompt with none, as Flow's Run Ready picks them. Each is picked again when its task starts. A card's own agent at
  // its limit, or no agent Flow may use with room, holds the time back as a Normal one is. Readings that don't come in
  // time leave the choice to each task's start.
  async flowCheck(c, schedule) {
    const target = schedule.target, mode = schedule.flow.routingMode;
    const jobs = target.type === 'prompt' ? [{ key: 'prompt', text: target.text, tier: null, agent: target.agent, mode }]
      : this.scope(c, schedule, { manual: true }).map(card => ({ key: card.id, text: card.notes ? `${card.title}\n\n${card.notes}` : card.title, tier: card.tier || null, agent: card.agent || null, mode: card.routingMode || mode }));
    if (!jobs.length) return { limit: null, picks: null };
    let timer;
    const rows = await Promise.race([this.main.router.candidates(c, { text: jobs[0].text, attachments: [], mode: schedule.access.mode, routing: { mode } }), new Promise(resolve => { timer = setTimeout(() => resolve(null), ROUTE_MS); timer.unref?.(); })]).finally(() => clearTimeout(timer));
    if (!rows) return { limit: null, picks: null };
    const picks = {};
    for (const job of jobs) {
      if (job.agent) {
        const row = rows.find(item => item.provider === job.agent.provider), state = row ? limitState(row.usage, job.agent.model) : { limited: null };
        if (state.limited === true) return { limit: { limited: true, provider: job.agent.provider, resetsAt: state.resetsAt }, picks: null };
        continue;
      }
      const choice = routing().route({ text: job.text, ...(job.tier ? { assessment: { tier: job.tier, effort: EFFORT[job.tier], reason: 'a scheduled card' } } : {}), mode: job.mode, candidates: rows, allowApi: false });
      if (choice.error) return { limit: { limited: true, provider: null, resetsAt: null, reason: choice.error }, picks: null };
      if (choice.quota?.state === 'exhausted') {
        const times = (choice.quota.windows || []).filter(row => row.state === 'exhausted').map(row => Date.parse(row.resetsAt)).filter(Number.isFinite);
        return { limit: { limited: true, provider: null, resetsAt: times.length ? iso(Math.max(...times)) : null }, picks: null };
      }
      picks[job.key] = { provider: choice.provider, model: choice.model || null, effort: choice.effort || null, auto: true };
    }
    return { limit: null, picks };
  }
  // Who a wait or a miss is about: the schedule's own agent, or every agent Flow may use.
  who(limit) { return limit.provider ? `${NAMES[limit.provider] || limit.provider} is` : 'Every agent Flow may use is'; }
  // Whether the schedule's own agent is at its limit for its model, read now. Null when it can't be told.
  async limit(c, schedule) {
    const target = schedule.target, provider = this.provider(c, target);
    if (!provider || !this.main.availableProviders().includes(provider)) return null;
    const model = target.type === 'card' ? this.main.board.find(c, target.cardId).agent?.model || null : target.agent.model;
    let timer;
    const usage = await Promise.race([this.main.checks.usage(provider, { ...this.main.usageOptions(provider), refresh: true }), new Promise(resolve => { timer = setTimeout(() => resolve(null), READ_MS); timer.unref?.(); })]).finally(() => clearTimeout(timer));
    try { this.main.observeQuota(c, provider, usage); } catch { /* A reading kept for later is a nicety. */ }
    return { provider, ...limitState(usage, model) };
  }
  // Without Run late a time may wait only as long as it may start late: ten minutes. With it, a day.
  // A Flow schedule waits for any agent Flow may use (provider null), and with a reason when Flow found none at all.
  wait(c, schedule, dueAt, { provider, resetsAt, reason = null }) {
    const now = this.now(), due = Date.parse(dueAt), reset = resetsAt ? Date.parse(resetsAt) : NaN, until = due + (schedule.runLate ? WAIT_MS : LATE_MS);
    const name = provider ? NAMES[provider] || provider : 'Every agent Flow may use', at = Number.isFinite(reset) ? this.clock(reset) : null;
    if (now >= until || (!schedule.runLate && !(Number.isFinite(reset) && reset <= until))) {
      if (reason) return this.miss(c, schedule, dueAt, `Flow found no agent for it${schedule.runLate ? ' all day' : ''}: ${reason}`);
      return this.miss(c, schedule, dueAt, schedule.runLate
        ? `${name} was still at its usage limit a day after this time.`
        : `${name} had reached its usage limit${at ? `, which resets at ${at}` : ''}. Tick Run late to have a schedule wait for the reset.`);
    }
    const checkAt = Number.isFinite(reset) && reset > now ? Math.min(reset + 15000, now + RECHECK_MS) : now + RECHECK_MS;
    const first = schedule.waiting?.dueAt !== dueAt;
    this.update(c, schedule, { waiting: { dueAt, provider: provider || null, resetsAt: Number.isFinite(reset) ? iso(reset) : null, ...(reason ? { reason: clip(reason, LIMITS.reason) } : {}), since: first ? iso(now) : schedule.waiting.since, checkAt: iso(Math.min(checkAt, until)) } });
    if (first) this.main.emit('notify', { conversationId: c.id, kind: 'waiting', title: 'A scheduled run is waiting for a usage reset', body: `${this.title(c, schedule)}: ${reason ? `Flow found no agent for it yet: ${clip(reason, 120)}` : `${name} is at its usage limit${at ? ` until ${at}` : ''}.`}` });
  }
  clock(ms) { return new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
  miss(c, schedule, dueAt, reason) {
    this.update(c, schedule, { missed: { dueAt, reason: clip(reason, LIMITS.reason), at: new Date(this.now()).toISOString() }, ...(schedule.waiting ? { waiting: null } : {}) });
    this.main.emit('notify', { conversationId: c.id, kind: 'missed', title: 'A scheduled run didn’t start', body: `${this.title(c, schedule)}: ${clip(reason, 160)}` });
  }
  launch(c, schedule, dueAt, { manual = false, waited = false, picks = null } = {}) {
    try {
      const provider = waited ? schedule.waiting.provider : null;
      const started = this.start(c, schedule, dueAt, { manual, picks }), taskIds = Array.isArray(started) ? started : [started], taskId = taskIds[0];
      this.update(c, schedule, { last: { dueAt, at: new Date(this.now()).toISOString(), taskId, ...(taskIds.length > 1 ? { taskIds } : {}), manual }, missed: null, waiting: null, runs: (schedule.runs || 0) + 1 });
      if (!manual) this.main.emit('notify', { conversationId: c.id, kind: 'scheduled', title: 'Scheduled run started', body: provider ? `${this.title(c, schedule)}: ${NAMES[provider] || provider} has room again.` : waited ? `${this.title(c, schedule)}: an agent Flow may use has room again.` : this.title(c, schedule) });
      return taskId;
    } catch (error) {
      if (manual) throw error;
      if (error.status === 503) return null;
      this.miss(c, schedule, dueAt, error.message);
      return null;
    }
  }
  // What the agent is also told: when it was scheduled for, and that nobody may be watching.
  note(dueAt) {
    const at = new Date(dueAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `This run was scheduled in Codeshi for ${at}, and the person may not be watching. Don’t push, deploy, publish or release anything: leave that to them.`;
  }
  // A placeholder for a card or prompt Flow routes when no reading came in time: its task picks again when it starts.
  placeholder(c) {
    const connected = this.main.availableProviders(), provider = connected.includes(c.provider) ? c.provider : connected[0];
    if (!provider) throw fail('No agent is connected on this computer.');
    return { provider, model: null, effort: null, auto: true };
  }
  start(c, schedule, dueAt, { manual, picks = null }) {
    const target = schedule.target, requestId = `schedule-${schedule.id.slice(0, 8)}-${Date.parse(dueAt).toString(36)}`;
    const live = schedule.last?.taskId && (c.parallelTasks || []).find(task => task.id === schedule.last.taskId);
    if (target.type === 'prompt' && live && LIVE.has(live.status)) throw fail('Its last run is still working.');
    if (schedule.flow) return this.startFlow(c, schedule, dueAt, { manual, picks, requestId });
    const provider = this.provider(c, target);
    if (!this.main.availableProviders().includes(provider)) throw fail(`${NAMES[provider]} isn’t connected on this computer.`);
    if (target.type === 'card') {
      const card = this.main.board.find(c, target.cardId);
      if (!manual && card.revision !== target.revision) throw fail('The card changed after it was scheduled.');
      const result = this.main.board.run(c, { ids: [card.id] }, { access: schedule.access, requestId, from: ['ready', 'done'], note: this.note(dueAt), source: 'schedule' });
      return result.tasks[card.id];
    }
    const policyId = randomUUID();
    this.main.execution.ensure(c, policyId, { config: { mode: 'normal' }, source: 'schedule', requestId });
    const task = this.main.tasks.start(c, { text: `${target.text}\n\n${this.note(dueAt)}`, title: schedule.title || target.text.split('\n')[0], provider, model: target.agent.model, effort: target.agent.effort, mode: schedule.access.mode, approvalPolicy: schedule.access.approvalPolicy, folderId: target.folderId, requestId }, { queueExecution: this.main.execution.token(c, policyId) });
    return task.id;
  }
  // A Flow schedule's run: its cards as Flow's Run Ready runs them, or its prompt as one task, under the Flow mode and the
  // shared limit saved with it. Nothing is billed by use, as no one is there to agree.
  startFlow(c, schedule, dueAt, { manual, picks, requestId }) {
    const target = schedule.target, { routingMode, shared } = schedule.flow;
    if (target.type === 'cards') {
      const cards = this.scope(c, schedule, { manual }), assignments = {};
      const live = cards.find(card => card.column === 'doing' || card.column === 'review');
      if (live) throw fail(`“${live.title}” is still ${live.column === 'doing' ? 'running' : 'waiting in Review'}.`);
      for (const card of cards) if (!card.agent) assignments[card.id] = picks?.[card.id] || this.placeholder(c);
      const result = this.main.board.run(c, { ids: cards.map(card => card.id), assignments, shared }, { access: schedule.access, requestId, from: ['ready', 'done'], note: this.note(dueAt), source: 'schedule', flow: { routingMode } });
      return cards.map(card => result.tasks[card.id]).filter(Boolean);
    }
    const pick = target.agent || picks?.prompt || this.placeholder(c), routed = !target.agent;
    if (!routed && !this.main.availableProviders().includes(pick.provider)) throw fail(`${NAMES[pick.provider]} isn’t connected on this computer.`);
    this.main.checkRunSettings(pick.provider, schedule.access.mode, schedule.access.approvalPolicy);
    const policyId = randomUUID(), title = schedule.title || target.text.split('\n')[0];
    this.main.execution.ensure(c, policyId, { config: routed ? { mode: 'flow', routingMode } : { mode: 'normal' }, source: 'schedule', requestId });
    const batch = { id: `run-${randomUUID().slice(0, 8)}`, title: clip(title, 90), flow: true, limits: shared, cards: 0, startedAt: new Date(this.now()).toISOString() };
    const task = this.main.tasks.start(c, { text: `${target.text}\n\n${this.note(dueAt)}`, title, provider: pick.provider, model: pick.model, effort: pick.effort, ...(routed ? { routing: { mode: routingMode, planned: null } } : {}), mode: schedule.access.mode, approvalPolicy: schedule.access.approvalPolicy, folderId: target.folderId, requestId }, { queueExecution: this.main.execution.token(c, policyId), batch });
    return task.id;
  }

  // ---- Showing schedules
  title(c, schedule) {
    if (schedule.target.type === 'card') return (c.board || []).find(card => card.id === schedule.target.cardId)?.title || schedule.title || 'A card';
    if (schedule.target.type === 'cards') return schedule.title || (c.board || []).find(card => card.id === schedule.target.cards[0]?.cardId)?.title || 'Cards';
    return schedule.title || clip(schedule.target.text.split('\n')[0], 90);
  }
  public(c, schedule) {
    const card = schedule.target.type === 'card' ? (c.board || []).find(item => item.id === schedule.target.cardId) : null;
    const tasks = (schedule.last?.taskIds || [schedule.last?.taskId]).filter(Boolean).map(id => (c.parallelTasks || []).find(item => item.id === id)).filter(Boolean);
    // A run of several cards is working while any of them is, and otherwise shows how its first card ended.
    const status = tasks.find(task => task.status === 'running')?.status || tasks.find(task => task.status === 'waiting')?.status || tasks[0]?.status || null;
    const flowCards = schedule.target.type === 'cards' ? schedule.target.cards.map(({ cardId, revision }) => { const item = (c.board || []).find(other => other.id === cardId); return { cardId, title: item?.title || null, gone: !item, changed: Boolean(item) && item.revision !== revision }; }) : null;
    return { ...schedule, title: this.title(c, schedule), agent: card ? card.agent : schedule.target.agent || null, ...(card ? { changed: card.revision !== schedule.target.revision } : {}), ...(flowCards ? { cards: flowCards, changed: flowCards.some(item => item.gone || item.changed) } : {}), ...(schedule.last ? { last: { ...schedule.last, status } } : {}) };
  }
  view(c) { return this.list(c).map(schedule => this.public(c, schedule)).sort((a, b) => (a.nextAt || '9').localeCompare(b.nextAt || '9')); }
  // Every missed run still waiting for you, for the recap.
  missed(c) { return this.list(c).filter(schedule => schedule.missed).map(schedule => ({ id: schedule.id, title: this.title(c, schedule), dueAt: schedule.missed.dueAt, reason: schedule.missed.reason })); }

  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { limitState } from './resume.mjs';

// Schedules (#132, second stage): a board card or a prompt that runs once at a set time, or every day, every weekday or
// every week. Normal only: a schedule binds the agent, model and effort, the folder, the workspace's access and
// permission setting when it was scheduled, and for a card the card's revision. Nothing is chosen for it later.
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
const READ_MS = 6000;
export const LIMITS = { schedules: 50, title: 200, text: 20000, reason: 300 };
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
  target(c, input, previous = null) {
    const type = input.target?.type ?? previous?.target.type;
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
    const agent = given.agent ?? before.agent;
    if (!agent || typeof agent !== 'object' || !PROVIDERS.includes(agent.provider)) throw fail('Choose Codex, Claude or Gemini for this schedule.', 400);
    const model = agent.model ? String(agent.model).slice(0, 200) : null, effort = agent.effort || null;
    this.main.validateSelection(model, 'auto', effort);
    const folders = this.folders(), folderId = (given.folderId ?? before.folderId) || (folders.length === 1 ? folders[0].id : null);
    if (!folderId || !folders.some(folder => folder.id === folderId)) throw fail('Choose the folder it works in.', 400);
    return { type: 'prompt', text, agent: { provider: agent.provider, model, effort }, folderId };
  }
  provider(c, target) { return target.type === 'card' ? this.main.board.find(c, target.cardId).agent?.provider || null : target.agent.provider; }
  create(c, input = {}) {
    if (this.list(c).length >= LIMITS.schedules) throw fail(`A workspace can have up to ${LIMITS.schedules} schedules. Remove some first.`);
    const target = this.target(c, input), when = cleanWhen(input.when), access = this.access(c), now = this.now();
    this.main.checkRunSettings(this.provider(c, target), access.mode, access.approvalPolicy);
    const next = nextOccurrence(when, now);
    if (!next) throw fail('That time has passed. Choose a time still to come.', 400);
    const title = typeof input.title === 'string' && input.title.trim() ? clip(input.title, LIMITS.title) : target.type === 'prompt' ? clip(target.text.split('\n')[0], LIMITS.title) : null;
    const schedule = { id: randomUUID(), ...(title ? { title } : {}), target, when, runLate: input.runLate === true, access, paused: false, nextAt: iso(next), createdAt: iso(now), updatedAt: iso(now), last: null, missed: null, runs: 0 };
    this.main.record(c, { type: 'schedule', schedule });
    this.arm();
    return this.public(c, this.find(c, schedule.id));
  }
  // Saving a schedule again is agreeing to it again: it takes the card as it is now and the workspace's access now.
  edit(c, id, input = {}) {
    const schedule = this.find(c, id);
    const target = this.target(c, input, schedule), when = 'when' in input ? cleanWhen(input.when) : schedule.when, access = this.access(c), now = this.now();
    this.main.checkRunSettings(this.provider(c, target), access.mode, access.approvalPolicy);
    const next = nextOccurrence(when, now);
    if (!next && !schedule.paused) throw fail('That time has passed. Choose a time still to come.', 400);
    const title = 'title' in input ? (typeof input.title === 'string' && input.title.trim() ? clip(input.title, LIMITS.title) : (target.type === 'prompt' ? clip(target.text.split('\n')[0], LIMITS.title) : null)) : schedule.title ?? null;
    this.update(c, schedule, { title, target, when, access, runLate: 'runLate' in input ? input.runLate === true : schedule.runLate, nextAt: next ? iso(next) : null, missed: null, waiting: null });
    this.arm();
    return this.public(c, schedule);
  }
  // Paused, a schedule keeps its settings and runs nothing. Resumed, it starts from the next time still to come: the
  // times it was paused through aren't missed.
  pause(c, id, { paused = true } = {}) {
    const schedule = this.find(c, id);
    if (paused === schedule.paused) return this.public(c, schedule);
    const next = paused ? null : nextOccurrence(schedule.when, this.now());
    if (!paused && !next) throw fail('That time has passed. Edit the schedule to choose a new one.');
    this.update(c, schedule, { paused, nextAt: next ? iso(next) : null, waiting: null });
    this.arm();
    return this.public(c, schedule);
  }
  remove(c, id) { this.find(c, id); this.main.record(c, { type: 'schedule_remove', id }); this.arm(); return { removed: true }; }
  // A card leaving the board takes its schedules with it.
  forgetCard(c, cardId) { for (const schedule of this.list(c).filter(item => item.target.type === 'card' && item.target.cardId === cardId)) this.main.record(c, { type: 'schedule_remove', id: schedule.id }); this.arm(); }
  dismiss(c, id) { const schedule = this.find(c, id); if (schedule.missed) this.update(c, schedule, { missed: null }); return this.public(c, schedule); }
  // Run now: you start it, so a card runs as it is now, with the workspace's access now, and the schedule takes both.
  runNow(c, id) {
    const schedule = this.find(c, id), at = this.now();
    if (schedule.target.type === 'card') {
      const card = this.main.board.find(c, schedule.target.cardId);
      if (card.revision !== schedule.target.revision || JSON.stringify(this.access(c)) !== JSON.stringify(schedule.access)) this.update(c, schedule, { target: { ...schedule.target, revision: card.revision }, access: this.access(c) });
    } else if (JSON.stringify(this.access(c)) !== JSON.stringify(schedule.access)) this.update(c, schedule, { access: this.access(c) });
    this.launch(c, this.find(c, id), iso(at), { manual: true });
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
    let limit = null;
    try { limit = await this.limit(c, schedule); } catch { /* Usage that can't be read doesn't stop the run. */ }
    schedule = this.list(c).find(item => item.id === id);
    if (this.closed || !schedule || schedule.paused || JSON.stringify([schedule.last, schedule.waiting, schedule.updatedAt]) !== before) return;
    if (limit?.limited === true) return this.wait(c, schedule, dueAt, limit);
    this.launch(c, schedule, dueAt, { waited: Boolean(schedule.waiting) });
  }
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
  wait(c, schedule, dueAt, { provider, resetsAt }) {
    const now = this.now(), due = Date.parse(dueAt), reset = resetsAt ? Date.parse(resetsAt) : NaN, until = due + (schedule.runLate ? WAIT_MS : LATE_MS);
    const name = NAMES[provider] || provider, at = Number.isFinite(reset) ? this.clock(reset) : null;
    if (now >= until || (!schedule.runLate && !(Number.isFinite(reset) && reset <= until))) {
      return this.miss(c, schedule, dueAt, schedule.runLate
        ? `${name} was still at its usage limit a day after this time.`
        : `${name} had reached its usage limit${at ? `, which resets at ${at}` : ''}. Tick Run late to have a schedule wait for the reset.`);
    }
    const checkAt = Number.isFinite(reset) && reset > now ? Math.min(reset + 15000, now + RECHECK_MS) : now + RECHECK_MS;
    const first = schedule.waiting?.dueAt !== dueAt;
    this.update(c, schedule, { waiting: { dueAt, provider, resetsAt: Number.isFinite(reset) ? iso(reset) : null, since: first ? iso(now) : schedule.waiting.since, checkAt: iso(Math.min(checkAt, until)) } });
    if (first) this.main.emit('notify', { conversationId: c.id, kind: 'waiting', title: 'A scheduled run is waiting for a usage reset', body: `${this.title(c, schedule)}: ${name} is at its usage limit${at ? ` until ${at}` : ''}.` });
  }
  clock(ms) { return new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
  miss(c, schedule, dueAt, reason) {
    this.update(c, schedule, { missed: { dueAt, reason: clip(reason, LIMITS.reason), at: new Date(this.now()).toISOString() }, ...(schedule.waiting ? { waiting: null } : {}) });
    this.main.emit('notify', { conversationId: c.id, kind: 'missed', title: 'A scheduled run didn’t start', body: `${this.title(c, schedule)}: ${clip(reason, 160)}` });
  }
  launch(c, schedule, dueAt, { manual = false, waited = false } = {}) {
    try {
      const provider = waited ? schedule.waiting.provider : null;
      const taskId = this.start(c, schedule, dueAt, { manual });
      this.update(c, schedule, { last: { dueAt, at: new Date(this.now()).toISOString(), taskId, manual }, missed: null, waiting: null, runs: (schedule.runs || 0) + 1 });
      if (!manual) this.main.emit('notify', { conversationId: c.id, kind: 'scheduled', title: 'Scheduled run started', body: provider ? `${this.title(c, schedule)}: ${NAMES[provider] || provider} has room again.` : this.title(c, schedule) });
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
  start(c, schedule, dueAt, { manual }) {
    const target = schedule.target, requestId = `schedule-${schedule.id.slice(0, 8)}-${Date.parse(dueAt).toString(36)}`;
    const live = schedule.last?.taskId && (c.parallelTasks || []).find(task => task.id === schedule.last.taskId);
    if (target.type === 'prompt' && live && LIVE.has(live.status)) throw fail('Its last run is still working.');
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

  // ---- Showing schedules
  title(c, schedule) {
    if (schedule.target.type === 'card') return (c.board || []).find(card => card.id === schedule.target.cardId)?.title || schedule.title || 'A card';
    return schedule.title || clip(schedule.target.text.split('\n')[0], 90);
  }
  public(c, schedule) {
    const card = schedule.target.type === 'card' ? (c.board || []).find(item => item.id === schedule.target.cardId) : null;
    const task = schedule.last?.taskId ? (c.parallelTasks || []).find(item => item.id === schedule.last.taskId) : null;
    return { ...schedule, title: this.title(c, schedule), agent: card ? card.agent : schedule.target.agent, ...(card ? { changed: card.revision !== schedule.target.revision } : {}), ...(schedule.last ? { last: { ...schedule.last, status: task?.status || null } } : {}) };
  }
  view(c) { return this.list(c).map(schedule => this.public(c, schedule)).sort((a, b) => (a.nextAt || '9').localeCompare(b.nextAt || '9')); }
  // Every missed run still waiting for you, for the recap.
  missed(c) { return this.list(c).filter(schedule => schedule.missed).map(schedule => ({ id: schedule.id, title: this.title(c, schedule), dueAt: schedule.missed.dueAt, reason: schedule.missed.reason })); }

  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}

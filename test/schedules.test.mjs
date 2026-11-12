import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { MutationCoordinator } from '../src/mutation-lock.mjs';
import { LATE_MS, cleanWhen, nextOccurrence } from '../src/schedules.mjs';
import { alertPlan, alertPush, alertDefaults, momentOf } from '../src/alerts.mjs';
import { buildRecap } from '../src/recap.mjs';

// Schedules (#132, second stage): a board card or a prompt run once at a set time, or every day, weekday or week, under
// Normal with the agent and access saved with it.
const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repository(folder) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.mock-scenarios.json'), '{}');
  fs.writeFileSync(path.join(folder, '.gitignore'), '.release\n.mock-captures.jsonl\nnode_modules\n');
  git(folder, 'init', '-q'); git(folder, 'config', 'user.email', 't@t.t'); git(folder, 'config', 'user.name', 't');
  git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'first');
  return folder;
}
// The clock starts on a Wednesday at 8:00 local time, and `env.at` moves it.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-schedules-')), bins = {}, dataDir = path.join(root, 'data');
  for (const provider of ['codex', 'claude']) { bins[provider] = path.join(root, `${provider}-mock.mjs`); fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 }); }
  bins.gemini = path.join(root, 'missing-gemini');
  const list = [{ id: 'a', name: 'a', path: repository(path.join(root, 'w', 'a')) }];
  const mutations = new MutationCoordinator(path.join(root, 'locks'));
  let clock = new Date(2026, 10, 11, 8, 0).getTime();
  const open = () => {
    const paths = list.map(folder => folder.path);
    const broker = new Broker({ workspace: paths[0], workspaceFolders: list, dataDir, bins, handoffPreferences: () => ({ threshold: 0, automatic: false }), acquireMutation: operation => mutations.acquireMany(paths, operation), acquireFolders: (where, operation) => mutations.acquireMany(where, operation), withFolders: (where, operation, work) => mutations.withMutations(where, operation, work) });
    broker.schedules.now = () => clock;
    // Usage is recorded, never read from this computer's real accounts: unknown unless a test sets it.
    broker.checks.usage = async provider => { reads.push(provider); return typeof usage === 'function' ? usage(provider) : usage; };
    return broker;
  };
  let usage = { available: false };
  const reads = [];
  const broker = open(), c = broker.get(broker.create().id);
  broker.budget.setPolicy(c, { maxConcurrent: 5 });
  t.after(async () => { await env.broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { broker, c, list, dataDir, folder: fs.realpathSync(list[0].path),
    get schedules() { return env.broker.schedules; },
    get board() { return env.broker.board; },
    at: (...parts) => { clock = new Date(...parts).getTime(); return clock; },
    reads,
    usage: value => { usage = value; },
    card: id => env.c.board.find(item => item.id === id),
    schedule: id => env.c.schedules.find(item => item.id === id),
    task: id => env.c.parallelTasks.find(item => item.id === id),
    captured: () => { const file = path.join(env.folder, '.mock-captures.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : []; },
    script: (request, behavior) => { const file = path.join(env.folder, '.mock-scenarios.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved[request] = { behavior }; fs.writeFileSync(file, JSON.stringify(saved)); git(env.folder, 'commit', '-qam', 'script'); },
    release: () => fs.writeFileSync(path.join(env.folder, '.release'), ''),
    reopen: async () => { await env.broker.close(); env.broker = open(); env.c = env.broker.get(c.id); return env.broker; },
  };
  return env;
}
const until = async (check, what) => { for (let i = 0; i < 1500; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Timed out waiting for ${what}.`); };
const local = (...parts) => new Date(...parts).getTime();

test('times are worked out in local time: once, every day, weekdays and every week', () => {
  const wednesday8 = local(2026, 10, 11, 8, 0);
  assert.equal(nextOccurrence({ repeat: 'once', date: '2026-11-11', time: '09:30' }, wednesday8), local(2026, 10, 11, 9, 30));
  assert.equal(nextOccurrence({ repeat: 'once', date: '2026-11-11', time: '07:30' }, wednesday8), null, 'A one-off time that has passed has no next time.');
  assert.equal(nextOccurrence({ repeat: 'daily', time: '07:30' }, wednesday8), local(2026, 10, 12, 7, 30), 'Today’s time has passed, so tomorrow.');
  assert.equal(nextOccurrence({ repeat: 'daily', time: '08:00' }, wednesday8), local(2026, 10, 12, 8, 0), 'The time itself counts as passed.');
  const friday10 = local(2026, 10, 13, 10, 0);
  assert.equal(nextOccurrence({ repeat: 'weekdays', time: '09:00' }, friday10), local(2026, 10, 16, 9, 0), 'Weekdays skip Saturday and Sunday.');
  assert.equal(nextOccurrence({ repeat: 'weekly', weekday: 1, time: '09:00' }, wednesday8), local(2026, 10, 16, 9, 0), 'Every Monday.');
  assert.equal(nextOccurrence({ repeat: 'weekly', weekday: 3, time: '08:00' }, wednesday8), local(2026, 10, 18, 8, 0), 'Every Wednesday, a week on when today’s has passed.');
  assert.deepEqual(cleanWhen({ repeat: 'weekly', weekday: 5, time: '17:45', date: 'ignored' }), { repeat: 'weekly', time: '17:45', weekday: 5 });
  assert.throws(() => cleanWhen({ repeat: 'hourly', time: '09:00' }), /once, every day/);
  assert.throws(() => cleanWhen({ repeat: 'daily', time: '9am' }), /time of day/);
  assert.throws(() => cleanWhen({ repeat: 'once', time: '09:00', date: '2026-02-30' }), /Choose a date/);
  assert.throws(() => cleanWhen({ repeat: 'weekly', time: '09:00', weekday: 7 }), /day of the week/);
});

test('a schedule keeps its card revision and the access it was made with, and is kept with the workspace', async t => {
  const env = setup(t);
  const bare = env.board.create(env.c, { title: 'No agent yet', column: 'ready' });
  assert.throws(() => env.schedules.create(env.c, { target: { type: 'card', cardId: bare.id }, when: { repeat: 'daily', time: '09:00' } }), /Choose an agent/, 'Nothing is scheduled to run on Auto.');
  const card = env.board.create(env.c, { title: 'Update dependencies', column: 'ready', agent: { provider: 'codex' }, folderId: 'a' });
  assert.throws(() => env.schedules.create(env.c, { target: { type: 'card', cardId: card.id }, when: { repeat: 'once', date: '2026-11-11', time: '07:00' } }), /has passed/);
  assert.throws(() => env.schedules.create(env.c, { target: { type: 'prompt', text: 'Check the logs' }, when: { repeat: 'daily', time: '09:00' } }), /Codex, Claude or Gemini/);
  assert.throws(() => env.schedules.create(env.c, { target: { type: 'prompt', text: ' ', agent: { provider: 'codex' } }, when: { repeat: 'daily', time: '09:00' } }), /what the agent should do/);
  const access = { mode: env.c.mode, approvalPolicy: env.c.approvalPolicy || 'ask' };
  const made = env.schedules.create(env.c, { target: { type: 'card', cardId: card.id }, when: { repeat: 'weekdays', time: '09:00' } });
  assert.deepEqual([made.target, made.access, made.nextAt, made.paused, made.runLate, made.title], [{ type: 'card', cardId: card.id, revision: 1 }, access, new Date(local(2026, 10, 11, 9, 0)).toISOString(), false, false, 'Update dependencies']);
  assert.ok(fs.existsSync(path.join(env.dataDir, 'schedules-pending')), 'The workspace reopens when Codeshi starts.');
  assert.equal(env.schedules.waiting, 1);
  // Paused, it has no next time and doesn't keep Codeshi open.
  env.schedules.pause(env.c, made.id);
  assert.deepEqual([env.schedule(made.id).paused, env.schedule(made.id).nextAt, env.schedules.waiting], [true, null, 0]);
  assert.ok(!fs.existsSync(path.join(env.dataDir, 'schedules-pending')));
  env.at(2026, 10, 12, 10, 0);
  env.schedules.pause(env.c, made.id, { paused: false });
  assert.equal(env.schedule(made.id).nextAt, new Date(local(2026, 10, 13, 9, 0)).toISOString(), 'Resumed, it starts from the next time to come, and the paused times aren’t missed.');
  assert.equal(env.schedule(made.id).missed, null);
  await env.reopen();
  assert.deepEqual(env.board.view(env.c).schedules.map(item => [item.title, item.when.repeat, item.changed]), [['Update dependencies', 'weekdays', false]], 'It’s kept with the workspace, and the board shows it.');
  // Removing the card removes its schedules.
  env.board.remove(env.c, card.id);
  assert.deepEqual(env.c.schedules, []);
  assert.equal(env.c.messages.length, 0, 'None of this shows in the chat.');
});

test('a scheduled card runs once at its time as a Normal task, and a restart doesn’t start it again', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.execution.setDefault(env.c, { mode: 'flow' });
  const card = env.board.create(env.c, { title: 'Nightly tidy', column: 'ready', agent: { provider: 'claude' }, folderId: 'a' });
  const made = env.schedules.create(env.c, { target: { type: 'card', cardId: card.id }, when: { repeat: 'daily', time: '09:00' } });
  await env.schedules.tick();
  assert.equal(env.card(card.id).column, 'ready', 'Nothing runs before its time.');
  const notices = []; env.broker.on('notify', notice => notices.push(notice));
  env.at(2026, 10, 11, 9, 2);
  await env.schedules.tick();
  const schedule = env.schedule(made.id), task = env.task(schedule.last.taskId);
  assert.equal(env.card(card.id).column, 'doing');
  assert.deepEqual([task.provider, task.board.cardId, schedule.runs, schedule.nextAt], ['claude', card.id, 1, new Date(local(2026, 10, 12, 9, 0)).toISOString()]);
  assert.equal(env.broker.execution.current(env.c, task.execution.taskId).mode, 'normal', 'A scheduled card runs under Normal, whatever the workspace default.');
  assert.match(task.requestId, /^schedule-/);
  assert.deepEqual(notices.map(notice => notice.kind), ['scheduled']);
  await until(() => env.captured().length, 'the scheduled run to start');
  assert.match(env.captured()[0].context.currentRequest, /scheduled in Codeshi for .*Don’t push, deploy, publish or release anything/s, 'The agent is told nobody may be watching, and not to publish.');
  await until(() => env.card(card.id).column === 'review', 'the card to reach Review');
  // The same time is never started twice: not by another tick, nor after a restart.
  await env.schedules.tick();
  await env.reopen();
  env.broker.schedules.now = () => local(2026, 10, 11, 9, 3);
  await env.schedules.tick();
  assert.equal(env.c.parallelTasks.length, 1);
  // The next day it runs again from Done, once you accepted it.
  env.board.accept(env.c, card.id);
  env.broker.schedules.now = () => local(2026, 10, 12, 9, 0);
  await env.schedules.tick();
  assert.equal(env.card(card.id).column, 'doing', 'A repeating card runs again from Done.');
  assert.equal(env.c.parallelTasks.length, 2);
});

test('a time passed while Codeshi was closed, an edited card or a card still in Review waits for you', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const card = env.board.create(env.c, { title: 'Weekly report', column: 'ready', agent: { provider: 'codex' }, folderId: 'a' });
  const late = env.schedules.create(env.c, { target: { type: 'card', cardId: card.id }, when: { repeat: 'daily', time: '09:00' } });
  const notices = []; env.broker.on('notify', notice => notices.push(notice));
  // Codeshi was closed from 9:00 until 9:00 plus more than ten minutes.
  env.at(local(2026, 10, 11, 9, 0) + LATE_MS + 60000);
  await env.schedules.tick();
  assert.equal(env.card(card.id).column, 'ready', 'A late time doesn’t run unless you allowed it.');
  assert.match(env.schedule(late.id).missed.reason, /wasn’t open, or the computer was asleep/);
  assert.equal(env.schedule(late.id).nextAt, new Date(local(2026, 10, 12, 9, 0)).toISOString(), 'Missed times fold into one and the schedule carries on.');
  assert.deepEqual(notices.map(notice => notice.kind), ['missed']);
  assert.deepEqual(env.schedules.missed(env.c).map(item => item.title), ['Weekly report']);
  // Two days closed: one missed run, not two.
  env.at(2026, 10, 14, 12, 0);
  await env.schedules.tick();
  assert.equal(env.schedule(late.id).missed.dueAt, new Date(local(2026, 10, 12, 9, 0)).toISOString());
  assert.equal(env.schedule(late.id).nextAt, new Date(local(2026, 10, 15, 9, 0)).toISOString());
  env.schedules.dismiss(env.c, late.id);
  assert.equal(env.schedule(late.id).missed, null);
  // With Run late, a late time runs as soon as Codeshi can.
  env.schedules.edit(env.c, late.id, { runLate: true });
  env.at(local(2026, 10, 15, 9, 0) + 3 * 60 * 60 * 1000);
  await env.schedules.tick();
  assert.equal(env.card(card.id).column, 'doing');
  await until(() => env.card(card.id).column === 'review', 'the late run to finish');
  // Still in Review at the next time: that time is skipped and shown.
  env.at(2026, 10, 16, 9, 0);
  await env.schedules.tick();
  assert.match(env.schedule(late.id).missed.reason, /waiting in Review/);
  // An edited card doesn't run as it was scheduled; Run now takes the card as it is now.
  env.board.accept(env.c, card.id); env.board.move(env.c, card.id, { column: 'ready' });
  env.board.edit(env.c, card.id, { notes: 'Include the CI numbers too.' });
  assert.equal(env.board.view(env.c).schedules[0].changed, true);
  env.at(2026, 10, 17, 9, 0);
  await env.schedules.tick();
  assert.match(env.schedule(late.id).missed.reason, /changed after it was scheduled/);
  assert.equal(env.card(card.id).column, 'ready');
  env.schedules.runNow(env.c, late.id);
  assert.deepEqual([env.card(card.id).column, env.schedule(late.id).target.revision, env.schedule(late.id).missed, env.schedule(late.id).last.manual], ['doing', 2, null, true]);
});

test('a scheduled prompt runs as its own task with the access saved with it, and skips a time while its last run works', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const made = env.schedules.create(env.c, { target: { type: 'prompt', text: 'Read the error log and summarize new errors.', agent: { provider: 'codex' } }, when: { repeat: 'daily', time: '09:00' } });
  assert.equal(made.title, 'Read the error log and summarize new errors.');
  assert.equal(made.target.folderId, 'a', 'With one folder, it works there.');
  const saved = made.access;
  // Changing the workspace's access later doesn't change a scheduled run.
  env.c.mode = saved.mode === 'read' ? 'edit' : 'read';
  const dueAt = new Date(local(2026, 10, 11, 9, 0)).toISOString();
  env.script(`Read the error log and summarize new errors.\n\n${env.schedules.note(dueAt)}`, 'hold');
  env.at(2026, 10, 11, 9, 0);
  await env.schedules.tick();
  const task = env.task(env.schedule(made.id).last.taskId);
  assert.deepEqual([task.provider, task.accessMode, task.approvalPolicy], ['codex', saved.mode, saved.approvalPolicy]);
  assert.equal(env.broker.execution.current(env.c, task.execution.taskId).mode, 'normal');
  await until(() => env.task(task.id).status === 'running', 'the prompt to run');
  env.at(2026, 10, 12, 9, 0);
  await env.schedules.tick();
  assert.match(env.schedule(made.id).missed.reason, /last run is still working/);
  assert.equal(env.c.parallelTasks.length, 1);
  env.release();
  await until(() => !['waiting', 'running'].includes(env.task(task.id).status), 'the prompt to finish');
});

test('a scheduled run checks its agent’s usage first: at the limit it waits for the reset or is missed, never on another agent', { skip: scriptCLIs }, async t => {
  const env = setup(t), iso = (...parts) => new Date(local(...parts)).toISOString();
  const limited = resetsAt => ({ available: true, windows: [{ id: 'five-hour', label: '5-hour', usedPercent: 100, resetsAt }] });
  const card = env.board.create(env.c, { title: 'Nightly tidy', column: 'ready', agent: { provider: 'claude' }, folderId: 'a' });
  const made = env.schedules.create(env.c, { target: { type: 'card', cardId: card.id }, when: { repeat: 'daily', time: '09:00' } });
  let notices = []; env.broker.on('notify', notice => notices.push(notice));
  // The limit resets within the ten minutes a time may start late, so it waits without Run late.
  env.usage(limited(iso(2026, 10, 11, 9, 5)));
  env.at(2026, 10, 11, 9, 0);
  await env.schedules.tick();
  assert.equal(env.card(card.id).column, 'ready', 'Nothing starts that would stop at once.');
  assert.deepEqual(env.reads, ['claude'], 'Only its own agent is read.');
  assert.deepEqual([env.schedule(made.id).waiting.provider, env.schedule(made.id).waiting.dueAt, env.schedule(made.id).waiting.resetsAt], ['claude', iso(2026, 10, 11, 9, 0), iso(2026, 10, 11, 9, 5)]);
  assert.deepEqual(notices.map(notice => notice.kind), ['waiting']);
  assert.match(notices[0].body, /Claude is at its usage limit until/);
  assert.equal(env.schedules.resets.length, 1, 'The menu bar lists it.');
  // Before the reset it isn't read again.
  env.at(2026, 10, 11, 9, 3);
  await env.schedules.tick();
  assert.equal(env.reads.length, 1);
  // The wait is saved, so it carries on after a restart.
  await env.reopen();
  notices = []; env.broker.on('notify', notice => notices.push(notice));
  assert.equal(env.schedule(made.id).waiting.dueAt, iso(2026, 10, 11, 9, 0));
  assert.ok(fs.existsSync(path.join(env.dataDir, 'schedules-pending')));
  env.usage({ available: true, windows: [{ id: 'five-hour', label: '5-hour', usedPercent: 4, resetsAt: iso(2026, 10, 11, 14, 0) }] });
  env.at(local(2026, 10, 11, 9, 5) + 20000);
  await env.schedules.tick();
  const schedule = env.schedule(made.id), task = env.task(schedule.last.taskId);
  assert.deepEqual([env.card(card.id).column, schedule.waiting, schedule.last.dueAt, task.provider], ['doing', null, iso(2026, 10, 11, 9, 0), 'claude'], 'It runs for the time it waited for, on the same agent.');
  assert.match(task.requestId, new RegExp(`${local(2026, 10, 11, 9, 0).toString(36)}`));
  assert.deepEqual(notices.map(notice => [notice.kind, /Claude has room again/.test(notice.body)]), [['scheduled', true]]);
  await until(() => env.card(card.id).column === 'review', 'the card to reach Review');
  env.board.accept(env.c, card.id);
  // A reset hours away, without Run late: missed, with the reset time, and nothing else runs it.
  env.usage(limited(iso(2026, 10, 12, 13, 0)));
  env.at(2026, 10, 12, 9, 0);
  await env.schedules.tick();
  assert.match(env.schedule(made.id).missed.reason, /^Claude had reached its usage limit, which resets at .*1:00 PM\. Tick Run late/);
  assert.deepEqual([env.schedule(made.id).waiting, env.c.parallelTasks.length, env.card(card.id).column], [null, 1, 'done']);
  // With Run late it waits, checked again every ten minutes while the limit holds, and announced once.
  env.schedules.edit(env.c, made.id, { runLate: true });
  env.usage(limited(iso(2026, 10, 13, 13, 0)));
  env.at(2026, 10, 13, 9, 0);
  notices = [];
  await env.schedules.tick();
  assert.equal(env.schedule(made.id).waiting.checkAt, iso(2026, 10, 13, 9, 10));
  env.at(2026, 10, 13, 9, 10);
  await env.schedules.tick();
  assert.deepEqual([env.schedule(made.id).waiting.checkAt, notices.map(notice => notice.kind), env.c.parallelTasks.length], [iso(2026, 10, 13, 9, 20), ['waiting'], 1]);
  // Pausing ends the wait; resumed, the schedule starts from its next time.
  env.schedules.pause(env.c, made.id);
  assert.equal(env.schedule(made.id).waiting, null);
  env.schedules.pause(env.c, made.id, { paused: false });
  // Usage that can't be read doesn't stop a run.
  env.usage({ available: false });
  env.at(2026, 10, 14, 9, 0);
  await env.schedules.tick();
  assert.equal(env.card(card.id).column, 'doing');
  await until(() => env.card(card.id).column === 'review', 'the last run to finish');
});

test('scheduled runs and missed ones are alerts of their own, and a missed one shows in the recap', () => {
  assert.equal(momentOf('scheduled'), 'finished');
  assert.equal(momentOf('missed'), 'stopped');
  assert.equal(alertPlan({ kind: 'scheduled' }, alertDefaults).sound, false, 'Starting on time plays no sound.');
  assert.equal(alertPush({ kind: 'missed', projectName: 'Shop' }, alertDefaults).message.title, 'A scheduled run didn’t start');
  const conversation = { id: 'c1', messages: [], runs: [], parallelTasks: [] };
  const registry = { list: () => [{ id: 'p', name: 'Shop', conversationId: 'c1', folders: [] }], brokers: new Map([['p', { broker: { conversations: new Map([['c1', conversation]]), running: null, schedules: { missed: () => [{ id: 's', title: 'Nightly tidy', dueAt: '2026-11-11T09:00:00.000Z', reason: 'Codeshi wasn’t open.' }] } } }]]) };
  const [workspace] = buildRecap({ since: '2026-11-11T08:00:00.000Z', now: new Date('2026-11-11T12:00:00.000Z'), registry, git: () => ({ repositories: [] }) }).workspaces;
  assert.deepEqual(workspace.missed.map(item => item.title), ['Nightly tidy'], 'A missed run alone is enough to show the workspace.');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { continuationRequest } from '../src/context.mjs';
import { limitState, RESUME_EXPIRES_MS } from '../src/resume.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));

function setup(t, scenarios = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-resume-'));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Quota stop': { behavior: 'quota' }, ...scenarios }));
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}-mock.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  }
  const brokers = [];
  t.after(async () => { await Promise.all(brokers.map(broker => broker.close())); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    dataDir, marker: path.join(dataDir, 'resume-pending'),
    open() { const broker = new Broker({ workspace, dataDir, bins }); brokers.push(broker); return broker; },
    captures() { const file = path.join(workspace, '.mock-captures.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : []; },
  };
}
async function run(broker, c, text, provider) { broker.execution.setDefault(c, { mode: 'flow' }); broker.start(c, { text, provider, mode: 'edit' }); await broker.running.done; }
// A broker whose clock and plan usage the test controls.
function controlled(broker, usage) {
  const clock = { now: Date.now() };
  broker.resume.now = () => clock.now;
  broker.resume.usage = async provider => usage[provider] ?? { available: false };
  return clock;
}
const full = resetsAt => ({ available: true, windows: [{ id: 'primary', usedPercent: 100, resetsAt }] });
const room = { available: true, windows: [{ id: 'primary', usedPercent: 12, resetsAt: null }] };

test('plan usage tells whether an agent is limited and when every full window resets', () => {
  assert.deepEqual(limitState({ available: false }), { limited: null, resetsAt: null });
  assert.deepEqual(limitState(room), { limited: false, resetsAt: null });
  assert.deepEqual(limitState({ available: true, windows: [{ usedPercent: 100, resetsAt: '2026-11-02T10:00:00Z' }, { usedPercent: 100, resetsAt: '2026-11-03T10:00:00Z' }] }), { limited: true, resetsAt: '2026-11-03T10:00:00.000Z' });
  assert.deepEqual(limitState({ available: true, windows: [{ usedPercent: 100 }] }), { limited: true, resetsAt: null }, 'A full window without a reset time stays unknown.');
  assert.equal(limitState({ available: true, windows: [{ usedPercent: 100, scope: 'opus', resetsAt: '2026-11-03T10:00:00Z' }] }, 'sonnet').limited, null, 'A limit on another model does not apply.');
});

test('a run stopped on a limit waits, then continues on whichever agent resets first with the access chosen when it was scheduled', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id), notices = [];
  broker.on('notify', notice => notices.push(notice));
  await run(broker, c, 'Quota stop', 'codex');
  assert.equal(c.lastRun.errorCategory, 'quota');
  const usage = {}, clock = controlled(broker, usage);
  usage.codex = full(new Date(clock.now + 3600000).toISOString());
  usage.claude = full(new Date(clock.now + 1800000).toISOString());
  const view = broker.scheduleResume(c, { providers: ['codex', 'claude'], mode: 'edit', approvalPolicy: 'ask' });
  assert.deepEqual(view.resume.providers, ['codex', 'claude']);
  await broker.resume.tick();
  assert.equal(broker.running, null, 'Nothing starts while every agent is limited.');
  assert.equal(broker.view(c).resume.agents.claude.resetsAt, usage.claude.windows[0].resetsAt);
  assert(fs.existsSync(env.marker), 'The wait is marked so it survives a restart.');

  clock.now += 1800000 + 20000; usage.claude = room;
  await broker.resume.tick();
  assert.equal(broker.running?.provider, 'claude', 'Claude reset first, so it continues.');
  assert.equal(broker.running.approvalPolicy, 'ask');
  await broker.running.done;
  assert.equal(c.resume, null); assert.equal(c.resumeEnded.outcome, 'started'); assert.equal(c.resumeEnded.provider, 'claude');
  assert.equal(c.lastRun.status, 'complete');
  const sent = env.captures().at(-1);
  assert.equal(sent.context.currentRequest, continuationRequest);
  assert.equal(sent.args.includes('--resume'), false, 'The other agent continues from the shared conversation.');
  assert(c.messages.some(message => message.role === 'system' && /Claude has room again/.test(message.text)));
  assert.deepEqual(notices.map(notice => notice.kind), ['stopped', 'started', 'finished'], 'The limit, the continuation and the finish are each reported once.');
  assert.equal(fs.existsSync(env.marker), false);
});

// One line for the whole task (#12): a routed task resumes as it would be placed, first on an agent under its mode's
// handoff line. Past the line still counts when no agent is under it, so a wait never lasts longer than before.
test('a routed task resumes first on an agent under its mode’s handoff line, and past it only when none is', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  await run(broker, c, 'Quota stop', 'codex');
  const usage = {}, clock = controlled(broker, usage);
  const at = usedPercent => ({ available: true, checkedAt: new Date(clock.now).toISOString(), windows: [{ id: 'primary', usedPercent, resetsAt: null }] });
  const ready = async (routing, codex, claude) => {
    usage.codex = at(codex); usage.claude = at(claude);
    c.resume = { id: `wait-${codex}-${claude}`, createdAt: new Date(clock.now).toISOString(), expiresAt: new Date(clock.now + RESUME_EXPIRES_MS).toISOString(), providers: ['codex', 'claude'], execution: broker.execution.token(c, c.lastRun.taskId || c.lastRun.id), selection: { provider: 'codex', model: null, effort: null }, delegated: true, requireQuota: true, ...(routing ? { routing } : {}) };
    broker.resume.status.delete(c.id);
    return broker.resume.firstReady(c);
  };
  const smart = { mode: 'smart', tier: 'standard' };
  assert.equal(await ready(smart, 89, 10), 'codex', 'Under the line, the task stays with the agent that ran it.');
  assert.equal(await ready(smart, 92, 50), 'claude', 'Past Smart’s 90% line, an agent with room comes first.');
  assert.equal(await ready(smart, 92, 93), 'codex', 'With no agent under the line, allowance short of the limit is still used.');
  assert.equal(await ready({ mode: 'ultra', tier: 'standard' }, 92, 50), 'codex', 'Ultra’s line is 95%.');
  assert.equal(await ready({ mode: 'saver', tier: 'standard' }, 85, 50), 'claude', 'Saver’s line is 80%.');
  assert.equal(await ready(smart, 96, 50), 'claude', 'At the 95% safety margin an agent is never resumed on.');
  assert.equal(await ready(null, 92, 50), 'codex', 'A task that wasn’t routed keeps the earlier rule.');
  c.resume = null;
});

test('a wait survives a restart, ends when cancelled, and gives way to a message sent by hand', { skip: scriptCLIs }, async t => {
  const env = setup(t), first = env.open(), c = first.get(first.create().id);
  await run(first, c, 'Quota stop', 'codex');
  controlled(first, { codex: full(new Date(Date.now() + 3600000).toISOString()) });
  first.scheduleResume(c, { providers: ['codex'], mode: 'edit', approvalPolicy: 'ask' });
  await first.resume.tick(); await first.close();

  const reopened = env.open(), again = reopened.get(c.id);
  controlled(reopened, { codex: full(new Date(Date.now() + 3600000).toISOString()) });
  assert.equal(again.resume.providers[0], 'codex'); assert.equal(reopened.waitingResumes, 1);
  reopened.cancelResume(again);
  assert.equal(again.resume, null); assert.equal(again.resumeEnded.outcome, 'cancelled'); assert.equal(fs.existsSync(env.marker), false);

  reopened.scheduleResume(again, { providers: ['codex'], mode: 'edit', approvalPolicy: 'ask' });
  await reopened.resume.tick();
  await run(reopened, again, 'Done by hand', 'claude');
  assert.equal(again.resumeEnded.outcome, 'superseded'); assert.equal(reopened.waitingResumes, 0);
});

test('a wait ends after a day, and a resumed run that reaches another limit waits again', { skip: scriptCLIs }, async t => {
  const env = setup(t, { [continuationRequest]: { behavior: 'quota' } }), broker = env.open(), c = broker.get(broker.create().id), notices = [];
  broker.on('notify', notice => notices.push(notice));
  await run(broker, c, 'Quota stop', 'codex');
  const usage = { codex: room }, clock = controlled(broker, usage);
  broker.scheduleResume(c, { providers: ['codex'], mode: 'edit', approvalPolicy: 'ask' });
  await broker.resume.tick(); await broker.running.done;
  assert.equal(c.lastRun.errorCategory, 'quota');
  assert(c.resume, 'The continued run reached a limit again, so the task waits again.'); assert.equal(c.resume.attempts, 1);
  assert(notices.some(notice => notice.kind === 'waiting'));

  usage.codex = full(null);
  clock.now += RESUME_EXPIRES_MS + 1000;
  await broker.resume.tick();
  assert.equal(c.resume, null); assert.equal(c.resumeEnded.outcome, 'expired');
  assert(c.messages.at(-1).text.includes('stopped waiting'));
  assert(notices.some(notice => notice.kind === 'expired'));
});

test('a wait is offered only after a usage limit, for connected agents, and never with settings a run would refuse', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  assert.throws(() => broker.scheduleResume(c, { providers: ['codex'] }), /after a run stops on a usage limit/);
  await run(broker, c, 'Quota stop', 'codex');
  assert.throws(() => broker.scheduleResume(c, { providers: ['nonexistent'] }), /connected agent/);
  assert.throws(() => broker.scheduleResume(c, { providers: ['codex'], mode: 'read', approvalPolicy: 'auto' }), /read/i);
  assert.equal(c.resume, null);
});

test('agents and the commands they run do not inherit the worker’s run-as-Node setting', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  await run(broker, c, 'Start the app from source', 'codex');
  await run(broker, c, 'Start it again', 'claude');
  assert.deepEqual(env.captures().map(capture => capture.electronRunAsNode), [null, null], 'An Electron app an agent starts, such as Codeshi from source, runs as an app.');
});

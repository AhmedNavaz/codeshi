import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { continuationRequest } from '../src/context.mjs';
import { highest, taskLine } from '../src/handoff.mjs';
import { limitState } from '../src/resume.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));

// Codex holds the workspace while Claude, Codex and Gemini report the usage and billing each test sets.
function setup(t, { preferences = { threshold: 90, automatic: false }, scenarios = {}, gemini = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-handoff-'));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Build the feature': { behavior: 'hold' }, 'Quota stop': { behavior: 'quota' }, ...scenarios }));
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}-mock.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  }
  bins.gemini = gemini ? path.join(root, 'gemini.mjs') : path.join(root, 'missing-gemini');
  if (gemini) fs.writeFileSync(bins.gemini, gemini, { mode: 0o700 });
  const settings = { ...preferences }, usage = { codex: 92, claude: 20 }, billing = { claude: 'subscription' }, notices = [];
  const broker = new Broker({ workspace, dataDir, bins, handoffPreferences: () => settings });
  broker.handoff.usage = async provider => usage[provider] === undefined ? { available: false } : { available: true, windows: [{ id: 'primary', label: '5-hour', usedPercent: usage[provider], resetsAt: new Date(Date.now() + 3600000).toISOString() }] };
  broker.resume.usage = (...args) => broker.handoff.usage(...args);
  // Gemini is not installed in these tests, as its missing binary says.
  broker.handoff.account = async provider => ({ installed: provider !== 'gemini' || Boolean(gemini), authenticated: true, billingSource: billing[provider] || 'subscription' });
  broker.on('notify', notice => notices.push(notice));
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  return {
    broker, c, settings, usage, billing, notices, workspace, dataDir, bins,
    // Returns once the mock agent is working, so what it was asked is on record.
    async start() {
      broker.start(c, { text: 'Build the feature', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
      for (let i = 0; i < 1500 && !this.requests().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      return broker.running;
    },
    release() { fs.writeFileSync(path.join(workspace, '.release'), ''); },
    // Only complete lines: the mock agent may be writing the next one.
    requests() { const file = path.join(workspace, '.mock-captures.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(JSON.parse).map(entry => [entry.provider, entry.context.currentRequest]) : []; },
  };
}

test('an exhausted window for another model neither blocks an agent nor raises a false alarm', () => {
  // As Antigravity reports them: groups of models, with Gemini 4 Argon out and Flash fine.
  const usage = { available: true, windows: [
    { id: 'weekly', label: 'Weekly · Gemini Models', scopes: ['gemini'], usedPercent: 37, resetsAt: '2026-11-07T14:15:00Z' },
    { id: 'five', label: 'Five Hour · Gemini Models', scopes: ['gemini'], usedPercent: 0, resetsAt: '2026-11-04T19:40:00Z' },
    { id: 'others', label: 'Weekly · Claude and GPT models', scopes: ['claude', 'gpt'], usedPercent: 51 },
    { id: 'argon', label: 'Weekly · Gemini 4 Argon', scopes: ['argon'], usedPercent: 100, resetsAt: '2026-11-07T13:38:00Z' },
    { id: 'unknown', label: 'Something else', scopes: [], usedPercent: 100 },
  ] };
  assert.equal(highest(usage, 'gemini-3.8-flash').id, 'weekly');
  assert.deepEqual(limitState(usage, 'gemini-3.8-flash'), { limited: false, resetsAt: null });
  assert.equal(highest(usage, 'gemini-4-argon').id, 'argon', 'A model is still limited by its own window.');
  assert.deepEqual(limitState(usage, 'gemini-4-argon'), { limited: true, resetsAt: '2026-11-07T13:38:00.000Z' });
  assert.equal(highest({ available: true, windows: [{ id: 'all', scopes: null, usedPercent: 95 }] }, 'anything').id, 'all', 'A window for the whole account covers every model.');
  assert.equal(highest({ available: true, windows: [{ id: 'opus', scope: 'opus', usedPercent: 95 }] }, 'claude-haiku-5-5'), null, 'A single named model works the same way.');
  assert.equal(highest({ available: true, windows: [{ id: 'opus', scope: 'opus', usedPercent: 95 }] }, 'claude-opus-5-5').id, 'opus');
});

test('with the agent’s default model selected, the offer goes by the model the run is really using', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.broker.handoff.usage = async provider => provider === 'codex' ? { available: true, windows: [{ id: 'sol', label: 'Weekly · Sol', scope: 'sol', usedPercent: 95 }] } : { available: true, windows: [{ id: 'primary', usedPercent: 10 }] };
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer, null, 'Nothing says this run uses that model yet.');
  env.c.activeRun.effectiveModel = 'gpt-sol';
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer.from.usedPercent, 95);
  env.release(); await run.done;
});

test('the offer names the task by its first line, cut at a word and shown to be cut', () => {
  assert.equal(taskLine('  Build the feature.\nThen more detail on it.'), 'Build the feature.');
  assert.equal(taskLine('x'.repeat(100)), 'x'.repeat(100));
  const cut = taskLine('Append a line containing alpha to notes.txt, creating it if needed, then run this exact command and wait for it to finish');
  assert.equal(cut, 'Append a line containing alpha to notes.txt, creating it if needed, then run this exact command and…');
  assert.equal(taskLine(''), '');
});

test('near its limit, a run is offered a handoff to the agent with room, naming the destination, billing and task', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  await env.broker.handoff.check(run);
  const offer = env.c.handoffOffer;
  assert.equal(offer.from.provider, 'codex'); assert.equal(offer.from.usedPercent, 92); assert.equal(offer.from.window, '5-hour');
  assert.deepEqual([offer.to.provider, offer.to.billingSource, offer.to.mode, offer.to.approvalPolicy], ['claude', 'subscription', 'edit', 'ask']);
  assert.equal(offer.task, 'Build the feature');
  assert.equal(env.notices.at(-1).kind, 'handoff');
  assert.equal(env.broker.view(env.c).handoffOffer.id, offer.id);
  assert.equal(env.broker.running, run, 'An offer alone never switches.');
  env.release(); await run.done;
  assert.equal(env.c.handoffOffer, null, 'The offer ends with its run.');
});

test('no offer below the threshold, when offers are off, or when every other agent is near or at its limit', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.usage.codex = 70; await env.broker.handoff.check(run); assert.equal(env.c.handoffOffer, null);
  env.usage.codex = 95; env.settings.threshold = 0; await env.broker.handoff.check(run); assert.equal(env.c.handoffOffer, null, 'Offers can be turned off.');
  env.settings.threshold = 90; env.usage.claude = 100; await env.broker.handoff.check(run); assert.equal(env.c.handoffOffer, null, 'An agent at its limit is not a destination.');
  env.usage.claude = 93; await env.broker.handoff.check(run); assert.equal(env.c.handoffOffer, null, 'Nor is one past the threshold itself.');
  env.release(); await run.done;
});

test('accepting stops the run and the destination continues the task from the shared conversation; the queue carries on afterwards', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.broker.queueAction(env.c, { action: 'add', text: 'Then write the release notes', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  await env.broker.handoff.check(run);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  assert.equal(run.stopped, true); assert.equal(env.broker.running.provider, 'claude');
  await env.broker.running.done;
  assert.deepEqual(env.requests().slice(1, 2), [['claude', continuationRequest]]);
  assert(env.c.messages.some(message => message.role === 'system' && /Codex was close to its usage limit, so you handed the task to Claude/.test(message.text)));
  assert(!env.c.messages.some(message => message.role === 'error'), 'A handoff is not shown as an error.');
  for (let i = 0; i < 500 && (env.c.queue.length || env.broker.running); i++) { if (env.broker.running) await env.broker.running.done; else await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(env.c.queuePaused, null, 'A handoff is not a stop that pauses the queue.');
  assert.deepEqual(env.requests().at(-1), ['codex', 'Then write the release notes']);
});

test('a stale offer is refused before anything starts on the destination, and a fresh offer replaces it', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  await env.broker.handoff.check(run);
  const old = env.c.handoffOffer;
  env.broker.updateContext(env.c, { goal: 'A different goal' });
  await assert.rejects(env.broker.acceptHandoff(env.c, { offerId: old.id }), error => error.status === 409 && /changed since this offer was made/.test(error.message) && error.offer && error.offer.id !== old.id);
  assert.equal(env.broker.running, run, 'The run keeps working.'); assert.equal(run.stopped, false);
  assert.deepEqual(env.requests().map(([provider]) => provider), ['codex'], 'The destination was never started.');
  await assert.rejects(env.broker.acceptHandoff(env.c, { offerId: old.id }), /no longer current/);
  // Progress within the same task does not invalidate the fresh offer.
  env.broker.message(env.c, 'activity', '$ npm test\nok', 'codex');
  env.c.models.claude = 'claude-sonnet';
  await assert.rejects(env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id }), /no longer available with the same settings/, 'A changed destination model needs a new offer.');
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  assert.equal(env.broker.running.provider, 'claude'); await env.broker.running.done;
});

test('a destination billed outside a subscription needs its own confirmation, and is never chosen automatically', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: { threshold: 90, automatic: true } });
  env.billing.claude = 'api';
  const run = await env.start();
  await env.broker.handoff.check(run);
  assert.equal(env.broker.running, run, 'Automatic handoff never goes to API billing.'); assert.equal(env.c.handoffOffer.to.billingSource, 'api');
  await assert.rejects(env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id }), error => error.status === 409 && error.billingRequired === true);
  assert.equal(run.stopped, false); assert.deepEqual(env.requests().map(([provider]) => provider), ['codex'], 'No API-billed request was started.');
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id, billingConfirmed: true });
  assert.equal(env.broker.running.provider, 'claude'); await env.broker.running.done;
});

test('automatic handoff to a subscription agent switches and says so; Not now holds for the rest of the run', { skip: scriptCLIs }, async t => {
  const automatic = setup(t, { preferences: { threshold: 90, automatic: true } }), first = await automatic.start();
  await automatic.broker.handoff.check(first);
  await first.done; assert.equal(automatic.broker.running?.provider, 'claude');
  await automatic.broker.running.done;
  assert(automatic.c.messages.some(message => /Codeshi handed the task to Claude/.test(message.text)));
  assert(automatic.notices.some(notice => notice.title === 'Handed off to Claude'));

  const manual = setup(t), run = await manual.start();
  await manual.broker.handoff.check(run);
  manual.broker.dismissHandoff(manual.c, manual.c.handoffOffer.id);
  await manual.broker.handoff.check(run);
  assert.equal(manual.c.handoffOffer, null, 'A dismissed offer is not repeated during this run.');
  manual.release(); await run.done;
});

// Reaching a limit (#91).
const until = async (check, what) => { for (let i = 0; i < 1500; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Timed out waiting for ${what}.`); };
const errors = c => c.messages.filter(message => message.role === 'error').map(message => message.text);
const notes = c => c.messages.filter(message => message.role === 'system').map(message => message.text);
const allowed = { threshold: 90, automatic: true };
const reached = (env, text = 'Quota stop', provider = 'codex', approvalPolicy = 'ask') => env.broker.start(env.c, { text, provider, mode: 'edit', approvalPolicy });
const continued = (env, provider) => until(() => env.requests().find(([agent, request]) => agent === provider && request === continuationRequest), `${provider} to continue`);
const done = env => until(() => !env.broker.running && !env.c.limitSwitching && env.c.lastRun, 'the runs to end');
const captures = env => fs.readFileSync(path.join(env.workspace, '.mock-captures.jsonl'), 'utf8').split('\n').slice(0, -1).map(JSON.parse);

test('with automatic handoff allowed, a Codex run stopped on a limit continues on an agent with room, as a handoff and not an error', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  env.usage.codex = 100; env.usage.claude = 20;
  reached(env, 'Quota stop', 'codex', 'auto');
  await continued(env, 'claude'); await done(env);
  assert.deepEqual(errors(env.c), [], 'A handoff is not shown as an error.');
  assert.equal(env.c.lastRun.provider, 'claude'); assert.equal(env.c.lastRun.status, 'complete');
  assert.equal(env.c.lastRun.mode, 'edit'); assert.equal(env.c.lastRun.approvalPolicy, 'auto', 'The same access and permission as the stopped run.');
  const note = notes(env.c).at(-1);
  assert.match(note, /^Codex reached its usage limit, which resets .+, so Codeshi handed the task to Claude\.$/, 'It names both agents and the reset time.');
  assert.equal(env.notices.find(notice => notice.kind === 'started')?.title, 'Handed off to Claude');
  assert.equal(env.notices.some(notice => notice.kind === 'stopped'), false);
  assert.equal(env.c.limitSwitching, null);
});

test('the agent that takes over works from what was saved before the limit stopped the run', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  env.usage.codex = 100; env.usage.claude = 20;
  const run = await env.start();
  env.broker.message(env.c, 'assistant', 'The promo form is done; the API route is next.', 'codex');
  env.broker.event(run, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  env.release();
  await continued(env, 'claude'); await done(env);
  const context = captures(env).find(entry => entry.provider === 'claude');
  assert(JSON.stringify(context).includes('The promo form is done; the API route is next.'), 'The old run can write nothing after it stops, so this comes from the journal.');
  assert(JSON.stringify(context).includes('Build the feature'), 'The original task goes with it.');
});

test('Claude’s rejected rate limit event continues on another agent, with the reset time it gave', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  env.usage.claude = 100; env.usage.codex = 20;
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const run = reached(env, 'Build the feature', 'claude');
  await until(() => env.requests().length, 'Claude to start');
  env.broker.event(env.broker.running, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } });
  env.release();
  await continued(env, 'codex'); await done(env);
  assert(run);
  assert.deepEqual(errors(env.c), []);
  const shown = new Date(resetsAt * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  assert.equal(notes(env.c).at(-1), `Claude reached its usage limit, which resets ${shown}, so Codeshi handed the task to Codex.`);
  const unknown = setup(t, { preferences: allowed });
  unknown.broker.handoff.usage = async provider => provider === 'codex' ? { available: false } : { available: true, windows: [{ id: 'primary', usedPercent: 20 }] };
  reached(unknown);
  await continued(unknown, 'claude'); await done(unknown);
  assert.equal(notes(unknown.c).at(-1), 'Codex reached its usage limit, so Codeshi handed the task to Claude.', 'With no reset time known, it still reads properly.');
});

test('a Gemini quota error continues on another agent', { skip: scriptCLIs }, async t => {
  const gemini = `#!${process.execPath}
import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'native-session'}});
if(m.method==='session/prompt')emit({id:m.id,error:{code:429,message:'Quota exceeded for this account.'}});
}
`;
  const env = setup(t, { preferences: allowed, gemini });
  env.usage.gemini = 100; env.usage.codex = 60; env.usage.claude = 20;
  reached(env, 'Fix the checkout', 'gemini');
  await continued(env, 'claude'); await done(env);
  assert.deepEqual(errors(env.c), []);
  assert.match(notes(env.c).at(-1), /^Gemini reached its usage limit.* so Codeshi handed the task to Claude\.$/, 'The agent with the most room is chosen.');
});

test('with automatic handoff off, or offers off, or a run stopped by hand, a limit stops the run as it always has', { skip: scriptCLIs }, async t => {
  for (const preferences of [{ threshold: 90, automatic: false }, { threshold: 0, automatic: true }]) {
    const env = setup(t, { preferences });
    env.usage.codex = 100; env.usage.claude = 20;
    reached(env);
    await done(env);
    assert.equal(env.c.lastRun.provider, 'codex'); assert.equal(env.c.lastRun.errorCategory, 'quota');
    assert.match(errors(env.c).join(), /Usage limit reached in mock Codex/);
    assert.equal(env.c.resume, null); assert.equal(env.requests().length, 1, 'Nothing else started.');
    assert.equal(env.notices.at(-1).kind, 'stopped');
  }
  const env = setup(t, { preferences: allowed });
  reached(env, 'Build the feature', 'claude');
  await until(() => env.requests().length, 'Claude to start');
  const run = env.broker.running;
  env.broker.event(run, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
  env.broker.stop(env.c.id); await run.done; await done(env);
  assert.equal(env.requests().length, 1, 'Stopping it means stopping it.');
  assert.match(errors(env.c).join(), /usage limit reached/, 'What the agent said still shows.');
  for (const kind of [{ review: {} }, { local: {} }, { automaticReview: {} }, { resume: {} }, { stopped: true }, { handoff: {} }]) assert.equal(env.broker.handoff.atLimit(kind), false, Object.keys(kind)[0]);
});

test('with no agent that can take over and no plan to wait for, the run stops with its error and the usual choices', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  env.billing.codex = 'api'; env.billing.claude = 'api';
  env.usage.codex = 100; env.usage.claude = 20;
  reached(env);
  await done(env); await until(() => errors(env.c).length, 'the error');
  assert.match(errors(env.c).join(), /Usage limit reached in mock Codex/);
  assert.equal(env.c.resume, null); assert.equal(env.requests().length, 1, 'An agent billed to an API is never chosen without its own confirmation.');
  assert.equal(env.c.lastRun.errorCategory, 'quota'); assert.equal(env.c.limitSwitching, null);
  assert.equal(env.notices.at(-1).kind, 'stopped');
});

test('if every agent is out, the wait starts by itself, survives a restart, can be cancelled, and continues at the first reset', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  env.usage.codex = 100; env.usage.claude = 100;
  reached(env, 'Quota stop', 'codex', 'auto');
  await until(() => env.c.resume, 'the wait');
  assert.deepEqual([...env.c.resume.providers].sort(), ['claude', 'codex']);
  assert.equal(env.c.resume.approvalPolicy, 'auto'); assert.equal(env.c.resume.mode, 'edit');
  assert.deepEqual(errors(env.c), []);
  assert.match(notes(env.c).at(-1), /^Codex reached its usage limit, which resets .+, and no other agent has room, so the task continues at the first reset\.$/);
  assert.equal(env.notices.at(-1).kind, 'waiting');
  assert.equal(fs.existsSync(path.join(env.dataDir, 'resume-pending')), true, 'The wait is marked so it survives a restart.');

  await env.broker.close();
  const reopened = new Broker({ workspace: env.workspace, dataDir: env.dataDir, bins: env.bins });
  reopened.resume.usage = async provider => provider === 'claude' ? { available: true, windows: [{ id: 'primary', usedPercent: 10 }] } : { available: true, windows: [{ id: 'primary', usedPercent: 100 }] };
  t.after(() => reopened.close());
  const c = reopened.get(env.c.id);
  assert.equal(c.resume?.approvalPolicy, 'auto', 'The wait is still there after a restart.');
  // It checks by itself after the restart, and continues on the first agent with room.
  await until(() => c.lastRun?.provider === 'claude' && !reopened.running, 'Claude to continue');
  assert.equal(c.lastRun.status, 'complete'); assert.equal(c.lastRun.approvalPolicy, 'auto'); assert.equal(c.resume, null);

  const cancelled = setup(t, { preferences: allowed });
  cancelled.usage.codex = 100; cancelled.usage.claude = 100;
  reached(cancelled);
  await until(() => cancelled.c.resume, 'the second wait');
  cancelled.broker.cancelResume(cancelled.c); assert.equal(cancelled.c.resume, null, 'It can be cancelled.');
  assert.equal(cancelled.broker.running, null);
});

test('a weekly or model-specific limit on the destination counts as no room, even with its 5-hour window free', { skip: scriptCLIs }, async t => {
  for (const window of [{ id: 'seven_day', label: 'Weekly', usedPercent: 100 }, { id: 'opus', label: 'Weekly · Opus', scope: 'opus', usedPercent: 100 }]) {
    const env = setup(t, { preferences: allowed });
    env.c.models.claude = 'opus';
    env.broker.handoff.usage = async provider => provider === 'codex' ? { available: true, windows: [{ id: 'primary', usedPercent: 100 }] } : { available: true, windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 5 }, window] };
    reached(env);
    await until(() => env.c.resume, `the wait with ${window.id} out`);
    assert.equal(env.requests().length, 1, 'Claude has no room, so it does not start.');
  }
});

test('a task does not bounce back to an agent that already reached its limit, even when its usage is not reported', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed, scenarios: { [continuationRequest]: { behavior: 'hold' } } });
  // Neither agent reports usage, so each looks as if it has room.
  env.broker.handoff.usage = async () => ({ available: false });
  reached(env);
  await continued(env, 'claude');
  const second = env.broker.running;
  assert.deepEqual(second.limitChain, ['codex']);
  env.broker.event(second, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
  env.release();
  await until(() => env.c.resume, 'the wait');
  assert.deepEqual(env.c.resume.limited, ['codex', 'claude']);
  await env.broker.resume.tick();
  assert.equal(env.broker.running, null, 'Reporting no usage does not make an agent that just ran out look ready.');
  assert.equal(env.requests().filter(([agent]) => agent === 'codex').length, 1, 'Codex is not tried again.');
});

test('something sent while the switch is being worked out goes ahead, and the switch steps aside', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  let open; const gate = new Promise(resolve => { open = resolve; });
  env.broker.handoff.usage = async () => { await gate; return { available: true, windows: [{ id: 'primary', usedPercent: 10 }] }; };
  reached(env);
  await until(() => env.c.limitSwitching, 'the switch to begin');
  assert.equal(env.broker.view(env.c).limitSwitching.provider, 'codex', 'The page can say what is happening.');
  env.broker.start(env.c, { text: 'By hand', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  const mine = env.broker.running;
  open(); await mine.done; await until(() => !env.c.limitSwitching, 'the switch to step aside');
  assert.deepEqual(env.requests().map(([agent, request]) => [agent, request]), [['codex', 'Quota stop'], ['codex', 'By hand']]);
  assert.deepEqual(notes(env.c).filter(note => /handed the task/.test(note)), []);
});

test('queued prompts wait for the agent that takes over, then carry on', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  env.usage.codex = 100; env.usage.claude = 20;
  const run = await env.start();
  env.broker.queueAction(env.c, { action: 'add', text: 'Later work', provider: 'claude', mode: 'edit', approvalPolicy: 'ask' });
  env.broker.event(run, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  env.release();
  await continued(env, 'claude');
  await until(() => env.requests().some(([, request]) => request === 'Later work'), 'the queued prompt');
  assert.deepEqual(env.requests().map(([, request]) => request), ['Build the feature', continuationRequest, 'Later work']);
  assert.equal(env.c.queuePaused ?? null, null);
  await done(env);
});

test('a move the task limits would refuse is never offered, and the running agent is left working', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.broker.budget.setPolicy(env.c, { maxHandoffs: 0 });
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer ?? null, null);
  assert.equal(env.broker.running, run);
  env.broker.budget.setPolicy(env.c, { maxHandoffs: 1, allowedProviders: ['codex'] });
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer ?? null, null, 'An agent the policy leaves out is not a destination.');
  env.broker.budget.setPolicy(env.c, { allowedProviders: null });
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer.to.provider, 'claude');
  // The limits change after the offer was made: accepting is refused before anything stops.
  const { id } = env.c.handoffOffer;
  env.broker.budget.setPolicy(env.c, { maxHandoffs: 0 });
  await assert.rejects(env.broker.acceptHandoff(env.c, { offerId: id }), /no longer available/);
  assert.equal(env.broker.running, run, 'The agent working on the task keeps working.');
  assert.equal(run.stopped, false);
  env.release(); await run.done;
});

test('an unknown destination can still be offered, but not presented as having room', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  const real = env.broker.handoff.usage;
  env.broker.handoff.usage = async provider => provider === 'claude' ? { available: false, reason: 'Not reported' } : real(provider);
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer.to.quota, 'unknown');
  env.release(); await run.done;
});

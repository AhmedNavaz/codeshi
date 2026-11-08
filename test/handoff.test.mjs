import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { continuationRequest } from '../src/context.mjs';
import { HandoffMonitor, highest, taskLine } from '../src/handoff.mjs';
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
  broker.handoff.usage = async provider => usage[provider] === undefined ? { available: false } : { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', label: '5-hour', usedPercent: usage[provider], resetsAt: new Date(Date.now() + 3600000).toISOString() }] };
  broker.resume.usage = (...args) => broker.handoff.usage(...args);
  broker.checks.usage = (...args) => broker.handoff.usage(...args);
  // Gemini is not installed in these tests, as its missing binary says.
  broker.handoff.account = async provider => ({ installed: provider !== 'gemini' || Boolean(gemini), authenticated: true, billingSource: billing[provider] || 'subscription' });
  const fixtureModels = {
    codex: [{ id: 'gpt-codex', displayName: 'GPT Codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] }],
    claude: [{ id: 'haiku', value: 'haiku', displayName: 'Haiku' }, { id: 'sonnet', value: 'sonnet', displayName: 'Sonnet', isDefault: true, supportedEffortLevels: ['low', 'medium', 'high'] }, { id: 'opus', value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }],
  };
  broker.handoff.models = async provider => ({ models: fixtureModels[provider] || [] });
  broker.on('notify', notice => notices.push(notice));
  // Everything a test reopens closes before the folder goes: a late checkpoint write would break the removal.
  const opened = new Set([broker]);
  t.reopened = next => { opened.add(next); return next; };
  t.after(async () => { for (const open of opened) await open.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  broker.execution.setDefault(c, { mode: 'flow' });
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
  const usage = { available: true, checkedAt: new Date().toISOString(), windows: [
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
  assert.equal(highest({ available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'all', scopes: null, usedPercent: 95 }] }, 'anything').id, 'all', 'A window for the whole account covers every model.');
  assert.equal(highest({ available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'opus', scope: 'opus', usedPercent: 95 }] }, 'claude-haiku-5-5'), null, 'A single named model works the same way.');
  assert.equal(highest({ available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'opus', scope: 'opus', usedPercent: 95 }] }, 'claude-opus-5-5').id, 'opus');
});

test('handoff checks Antigravity additional-folder support in Normal and Flow and preserves the CLI folder limit', async () => {
  const account = { installed: true, authenticated: true, billingSource: 'subscription', source: 'antigravity-acp', capabilities: { additionalDirectories: true } };
  const broker = { execution: { allows: () => true, current: () => null }, workspace: '/first', workspaces: ['/first', '/second'], availableProviders: () => ['codex', 'gemini'], usageOptions: () => ({}), observeQuota() {}, budget: { refusal: () => null } };
  const handoff = new HandoffMonitor(broker, {
    account: async () => account,
    models: async () => ({ models: [{ id: 'gemini-3.8-flash', displayName: 'Gemini Flash', isDefault: true }] }),
    usage: async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'all', scopes: null, usedPercent: 10 }] }),
  });
  const c = { models: {}, messages: [{ role: 'user', runId: 'run', text: 'Update the files in both folders' }] };
  for (const routing of [null, { mode: 'balanced' }]) {
    const run = { id: 'run', taskId: 'run', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', routing };
    account.capabilities.additionalDirectories = true;
    assert.equal((await handoff.destination(c, run)).provider, 'gemini');
    account.capabilities.additionalDirectories = false;
    assert.equal(await handoff.destination(c, run), null);
    delete account.capabilities.additionalDirectories;
    assert.equal(await handoff.destination(c, run), null, 'Automatic moves require confirmed folder support.');
    account.capabilities.additionalDirectories = true;
    assert.equal(await handoff.destination(c, { ...run, mode: 'read' }), null);
  }
  account.source = 'gemini-cli';
  broker.workspaces = Array.from({ length: 6 }, (_, i) => '/' + i);
  assert.equal((await handoff.destination(c, { id: 'run', taskId: 'run', provider: 'codex', mode: 'edit' })).provider, 'gemini');
  broker.workspaces.push('/extra');
  assert.equal(await handoff.destination(c, { id: 'run', taskId: 'run', provider: 'codex', mode: 'edit' }), null);
});

test('with the agent’s default model selected, the offer goes by the model the run is really using', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.broker.handoff.usage = async provider => provider === 'codex' ? { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'sol', label: 'Weekly · Sol', scope: 'sol', usedPercent: 95 }] } : { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', usedPercent: 10 }] };
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
  assert.deepEqual(env.requests().at(-1), ['claude', 'Then write the release notes'], 'A prompt for the agent that ran out goes to the one that took over.');
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

// In Flow a routed run hands off by its mode (#107), whatever Settings says for the normal view.
test('a routed run hands off by its routing mode, without asking: Cost saving at 80%, Maximum quality not before 95%', { skip: scriptCLIs }, async t => {
  const routed = mode => ({ text: 'Build the feature', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', routing: { mode, reason: 'A test', tier: 'standard' } });
  const saving = setup(t);
  saving.broker.execution.setDefault(saving.c, { mode: 'flow', routingMode: 'saver' });
  saving.broker.start(saving.c, routed('saving'));
  const first = await until(() => saving.requests().length && saving.broker.running, 'the Cost saving run');
  await saving.broker.handoff.check(first);
  await first.done; assert.equal(saving.broker.running?.provider, 'claude', 'Offers-only Settings do not hold Flow back: at 92% used, Cost saving moves on.');
  await saving.broker.running.done;
  assert(saving.c.messages.some(message => /Codeshi handed the task to Claude/.test(message.text)));
  const quality = setup(t);
  quality.broker.execution.setDefault(quality.c, { mode: 'flow', routingMode: 'ultra' });
  quality.broker.start(quality.c, routed('quality'));
  const run = await until(() => quality.requests().length && quality.broker.running, 'the Maximum quality run');
  await quality.broker.handoff.check(run);
  assert.equal(quality.c.handoffOffer, null, 'Maximum quality holds the strongest model until 95%.'); assert.equal(quality.broker.running, run);
  quality.release(); await run.done;
});

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
  unknown.broker.handoff.usage = async provider => provider === 'codex' ? { available: false } : { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', usedPercent: 20 }] };
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
  assert.match(notes(env.c).at(-1), /^Codex reached its usage limit, which resets .+, and no other agent has confirmed room, so the task waits for a fresh allowance reading after a reset\.$/);
  assert.equal(env.notices.at(-1).kind, 'waiting');
  assert.equal(fs.existsSync(path.join(env.dataDir, 'resume-pending')), true, 'The wait is marked so it survives a restart.');

  await env.broker.close();
  const reopened = new Broker({ workspace: env.workspace, dataDir: env.dataDir, bins: env.bins });
  reopened.resume.usage = async provider => provider === 'claude' ? { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', usedPercent: 10 }] } : { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', usedPercent: 100 }] };
  t.reopened(reopened);
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
    env.broker.handoff.usage = async provider => provider === 'codex' ? { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', usedPercent: 100 }] } : { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 5 }, window] };
    reached(env);
    await until(() => env.c.resume, `the wait with ${window.id} out`);
    assert.equal(env.requests().length, 1, 'Claude has no room, so it does not start.');
  }
});

test('automatic fallback waits when allowance is unknown, including agents that have not yet run', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  env.broker.handoff.usage = async () => ({ available: false });
  reached(env);
  await until(() => env.c.resume, 'the wait');
  assert.deepEqual(env.c.resume.limited, ['codex', 'claude']);
  assert.equal(env.c.resume.requireQuota, true);
  env.broker.resume.now = () => Date.now() + 20 * 60000;
  env.broker.resume.status.clear();
  await env.broker.resume.tick();
  assert.equal(env.broker.running, null, 'Unknown usage does not establish that another agent has room.');
  assert.deepEqual(env.requests().map(([agent]) => agent), ['codex']);
});

test('something sent while the switch is being worked out goes ahead, and the switch steps aside', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed });
  let open; const gate = new Promise(resolve => { open = resolve; });
  env.broker.handoff.usage = async () => { await gate; return { available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', usedPercent: 10 }] }; };
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

test('automatic handoff requires fresh confirmed room again when the offer is accepted', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  await env.broker.handoff.check(run);
  const offer = env.c.handoffOffer;
  env.broker.handoff.usage = async () => ({ available: false });
  await assert.rejects(env.broker.handoff.accept(env.c, { offerId: offer.id, automatic: true }), /allowance could not be confirmed/);
  assert.equal(env.broker.running, run);
  assert.deepEqual(env.requests().map(([provider]) => provider), ['codex']);
  assert.equal(env.c.handoffOffer.to.quota, 'unknown');
  env.release(); await run.done;
});

test('automatic handoff does not treat stale usage or a missing observation time as room', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed }), run = await env.start();
  env.broker.handoff.usage = async provider => ({ available: true, ...(provider === 'codex' ? { checkedAt: new Date().toISOString() } : { checkedAt: new Date(Date.now() - 3600000).toISOString() }), windows: [{ label: '5-hour', usedPercent: provider === 'codex' ? 92 : 5 }] });
  await env.broker.handoff.check(run);
  assert.equal(env.broker.running, run);
  assert.equal(env.c.handoffOffer.to.quota, 'stale');
  env.release(); await run.done;
});

// Queued prompts moving with a handoff (#93).
const queue = (env, text, extra = {}) => env.broker.queueAction(env.c, { action: 'add', text, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', ...extra });
const named = (env, text) => env.c.queue.find(item => item.text === text);

test('the offer says how many prompts would move and only those for the limited agent do, with their access and the new agent’s model', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.c.models.claude = 'claude-sonnet'; env.c.efforts.claude = { 'claude-sonnet': 'high' };
  queue(env, 'For Codex', { model: 'gpt-old', effort: 'low' }); queue(env, 'Read only', { mode: 'read' }); queue(env, 'For Gemini', { provider: 'gemini', model: 'gemini-one' });
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer.queue.count, 2, 'Only the prompts for the limited agent.');
  queue(env, 'Added after the offer');
  assert.equal(env.c.handoffOffer.queue.count, 3, 'An open offer keeps saying what would really move.');
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id, queueDigest: env.c.handoffOffer.queue.digest });
  const moved = named(env, 'For Codex');
  assert.deepEqual([moved.provider, moved.model, moved.effort, moved.mode, moved.approvalPolicy, moved.movedFrom], ['claude', 'claude-sonnet', 'high', 'edit', 'ask', 'codex']);
  assert.deepEqual([named(env, 'Read only').provider, named(env, 'Read only').mode], ['claude', 'read'], 'Read-only stays read-only.');
  assert.deepEqual([named(env, 'For Gemini').provider, named(env, 'For Gemini').model, named(env, 'For Gemini').movedFrom], ['gemini', 'gemini-one', undefined], 'A prompt for another agent is left alone.');
  assert.match(notes(env.c).at(-1), /3 queued prompts moved to Claude\.$/);
  await env.broker.running.done;
});

test('a moved prompt keeps its place, can be reordered before and after, and the move survives a restart', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  queue(env, 'First'); queue(env, 'Second'); queue(env, 'Third');
  env.broker.queueAction(env.c, { action: 'move', id: named(env, 'Third').id, index: 0 });
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  assert.deepEqual(env.c.queue.map(item => item.text), ['Third', 'First', 'Second']);
  env.broker.queueAction(env.c, { action: 'move', id: named(env, 'Second').id, index: 0 });
  assert.deepEqual(env.c.queue.map(item => [item.text, item.provider]), [['Second', 'claude'], ['Third', 'claude'], ['First', 'claude']]);
  await env.broker.running.done;
  await env.broker.close();
  const reopened = new Broker({ workspace: env.workspace, dataDir: env.dataDir, bins: env.bins });
  t.reopened(reopened);
  const c = reopened.get(env.c.id);
  assert.deepEqual(c.queue.map(item => [item.text, item.provider, item.movedFrom]), [['Second', 'claude', 'codex'], ['Third', 'claude', 'codex'], ['First', 'claude', 'codex']]);
});

test('an agent billed per use needs its own yes for the queued prompts, and an earlier yes for the old agent never carries over', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.billing.claude = 'api';
  queue(env, 'Approved for Codex', { billingConfirmed: true });
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer.queue.billingRequired, true);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id, billingConfirmed: true });
  assert.deepEqual([named(env, 'Approved for Codex').provider, named(env, 'Approved for Codex').billingConfirmed], ['codex', true], 'Accepting the handoff’s charges does not cover the prompts.');
  assert.match(notes(env.c).at(-1), /1 queued prompt stays with Codex, because Claude's charges weren't accepted for it\.$/);
  await env.broker.running.done;

  const second = setup(t), secondRun = await second.start();
  second.billing.claude = 'api';
  queue(second, 'Later', { billingConfirmed: false });
  second.broker.queueAction(second.c, { action: 'pause' });
  await second.broker.handoff.check(secondRun);
  await second.broker.acceptHandoff(second.c, { offerId: second.c.handoffOffer.id, billingConfirmed: true, queueBillingConfirmed: true });
  assert.deepEqual([named(second, 'Later').provider, named(second, 'Later').billingConfirmed], ['claude', true], 'With its own yes, it moves.');
  await second.broker.running.done;

  // Moving to a subscription: a yes given for the old agent's charges is not kept for anything later.
  const third = setup(t), thirdRun = await third.start();
  queue(third, 'Charged before', { billingConfirmed: true });
  third.broker.queueAction(third.c, { action: 'pause' });
  await third.broker.handoff.check(thirdRun);
  await third.broker.acceptHandoff(third.c, { offerId: third.c.handoffOffer.id });
  assert.deepEqual([named(third, 'Charged before').provider, named(third, 'Charged before').billingConfirmed], ['claude', false]);
  await third.broker.running.done;
});

test('a prompt that changed after the offer was accepted is not covered by it, and a stale answer is refused', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  queue(env, 'Shown'); queue(env, 'Will be edited'); queue(env, 'Will gain access', { approvalPolicy: 'ask' });
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  const seen = env.c.handoffOffer.queue.digest;
  queue(env, 'Added while deciding');
  await assert.rejects(env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id, queueDigest: seen }), /queued prompts changed/, 'The person agreed to the prompts they saw.');
  assert.equal(env.broker.running, run, 'The agent keeps working.');
  const offer = env.c.handoffOffer;
  assert.equal(offer.queue.count, 4);
  // Accepted, then changed while the old run is stopping.
  const stop = env.broker.stop.bind(env.broker);
  env.broker.stop = id => { env.broker.queueAction(env.c, { action: 'update', id: named(env, 'Will be edited').id, text: 'Edited after accepting' }); env.broker.stop = stop; return stop(id); };
  await env.broker.acceptHandoff(env.c, { offerId: offer.id, queueDigest: offer.queue.digest });
  assert.equal(named(env, 'Edited after accepting').provider, 'codex', 'What changed stays where it was.');
  assert.equal(named(env, 'Shown').provider, 'claude');
  assert.match(notes(env.c).at(-1), /3 queued prompts moved to Claude\. 1 queued prompt changed after the offer, so it stays with Codex\.$/);
  await env.broker.running.done;
});

test('routed prompts are routed again for the new agent, and a list that can’t be read falls back to its model', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  env.broker.handoff.models = async () => ({ models: [{ id: 'claude-haiku', supportedEffortLevels: ['low', 'medium'] }, { id: 'claude-opus', supportedEffortLevels: ['low', 'high'] }] });
  queue(env, 'Fix a typo in the readme', { model: 'gpt-mini', effort: 'low', routing: { mode: 'balanced', reason: 'Light', tier: 'light' } });
  queue(env, 'Refactor the payment module', { model: 'gpt-max', effort: 'high', routing: { mode: 'balanced', reason: 'Deep', tier: 'deep', escalation: { provider: 'codex', model: 'gpt-max', modelName: 'Max', effort: 'xhigh' } } });
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  const light = named(env, 'Fix a typo in the readme'), deep = named(env, 'Refactor the payment module');
  assert.deepEqual([light.provider, light.model, light.effort, light.routing.mode], ['claude', 'claude-haiku', 'low', 'smart']);
  assert.deepEqual([deep.provider, deep.model, deep.effort, deep.routing.tier], ['claude', 'claude-opus', 'high', 'deep']);
  assert.notEqual(deep.routing.escalation?.provider, 'codex', 'Its step up belongs to the new agent too.');
  assert.match(light.routing.reason, /^Moved at a handoff/);
  await env.broker.running.done;

  const second = setup(t), run2 = await second.start();
  second.broker.handoff.models = async () => { throw new Error('offline'); };
  queue(second, 'Fix a typo', { routing: { mode: 'saving', reason: 'Light', tier: 'light' } });
  second.broker.queueAction(second.c, { action: 'pause' });
  await second.broker.handoff.check(run2);
  await second.broker.acceptHandoff(second.c, { offerId: second.c.handoffOffer.id });
  assert.deepEqual([named(second, 'Fix a typo').provider, named(second, 'Fix a typo').model], ['claude', null]);
  await second.broker.running.done;
});

test('automatic handoff follows the same rules and says so in the conversation', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: allowed }), run = await env.start();
  queue(env, 'Next up'); queue(env, 'For Gemini', { provider: 'gemini' });
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  await until(() => env.broker.running && env.broker.running !== run, 'the handoff');
  assert.deepEqual([named(env, 'Next up').provider, named(env, 'For Gemini').provider], ['claude', 'gemini']);
  assert.match(notes(env.c).at(-1), /so Codeshi handed the task to Claude\. 1 queued prompt moved to Claude\.$/);
  await env.broker.running.done;

  // At the limit itself, too.
  const limit = setup(t, { preferences: allowed });
  limit.usage.codex = 100;
  const limited = await limit.start();
  queue(limit, 'After the limit'); limit.broker.queueAction(limit.c, { action: 'pause' });
  limit.broker.event(limited, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  limit.release();
  await continued(limit, 'claude'); await done(limit);
  assert.equal(named(limit, 'After the limit').provider, 'claude');
  assert.match(notes(limit.c).at(-1), /handed the task to Claude\. 1 queued prompt moved to Claude\.$/);
});

test('Flow mode executes handoff autonomously without publishing an interactive handoff offer card (#135)', { skip: scriptCLIs }, async t => {
  const env = setup(t, { preferences: { ...allowed, mode: 'smart' } }), run = await env.start();
  queue(env, 'Flow queued task');
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  assert.equal(env.c.handoffOffer, null, 'Flow mode does not set c.handoffOffer');
  await until(() => env.broker.running && env.broker.running !== run, 'Flow autonomous handoff');
  assert.equal(named(env, 'Flow queued task').provider, 'claude');
  assert.match(notes(env.c).at(-1), /handed the task to Claude/);
  await env.broker.running.done;
});

test('continuing with another agent after a limit takes the queued prompts along, if that agent needs no charges accepted', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.usage.codex = 100;
  const run = await env.start();
  queue(env, 'Waiting'); env.broker.queueAction(env.c, { action: 'pause' });
  env.broker.event(run, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  env.release(); await done(env);
  assert.equal(env.c.lastRun.errorCategory, 'quota');
  await env.broker.continueTask(env.c, { provider: 'claude', mode: 'edit', approvalPolicy: 'ask' });
  await until(() => named(env, 'Waiting')?.provider === 'claude', 'the prompt to move');
  assert.match(notes(env.c).at(-1), /1 queued prompt moved to Claude\.$/);
  await env.broker.running?.done;
});

test('after a stop between the move and the next prompt, each prompt has one owner and nothing is sent twice', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  queue(env, 'Moved, not sent'); queue(env, 'Sent, outcome unknown');
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  await env.broker.running.done;
  // The next prompt's run was saved, and then Codeshi stopped before noting it had started.
  const sent = named(env, 'Sent, outcome unknown');
  env.broker.record(env.c, { type: 'submission', id: 'unknown-run', task: { id: 'unknown-run', parentRunId: null, relation: null }, requestId: 'queue-' + sent.id, fingerprint: 'saved', provider: 'claude', mode: 'edit', approvalPolicy: 'ask', model: null, transport: 'auto', context: {}, workspaceSignature: env.broker.workspaceSignature, message: { id: 'unknown-message', role: 'user', text: sent.text, provider: 'claude', runId: 'unknown-run' } });
  await env.broker.close();
  const count = () => fs.existsSync(path.join(env.workspace, '.mock-captures.jsonl')) ? captures(env).filter(entry => entry.context.currentRequest === sent.text).length : 0, before = count();
  const reopened = new Broker({ workspace: env.workspace, dataDir: env.dataDir, bins: env.bins });
  t.reopened(reopened);
  const c = reopened.get(env.c.id);
  assert.deepEqual(c.queue.map(item => [item.text, item.provider]), [['Moved, not sent', 'claude']], 'One owner: the moved prompt waits for the new agent, and the uncertain one has left the queue.');
  assert(c.messages.some(message => message.role === 'system' && /was being sent when Codeshi stopped, so it wasn't sent again: “Sent, outcome unknown”/.test(message.text)));
  assert(c.queuePaused, 'After a restart the queue waits for the person.');
  reopened.queueAction(c, { action: 'resume' });
  await until(() => !reopened.running && !c.queue.length, 'the queue to finish');
  assert.equal(count(), before, 'The uncertain prompt is never sent again.');
});

test('a destination that turned out not to be a subscription refuses a moved prompt, and pauses the queue instead of charging', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  queue(env, 'Moved on a subscription');
  env.broker.queueAction(env.c, { action: 'pause' });
  await env.broker.handoff.check(run);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  assert.equal(named(env, 'Moved on a subscription').billingConfirmed, false, 'The prompt carries no yes to charges, so a run that would be billed can’t start without one.');
  await env.broker.running.done;
});

// The task plan across agents (#92).
const planned = [{ text: 'Read the code', status: 'done' }, { text: 'Write the tests', status: 'active' }, { text: 'Run them', status: 'pending' }];
const report = (env, run, steps = planned) => env.broker.event(run, { type: 'relay.plan', steps });
const lastBrief = env => captures(env).at(-1).context.brief;

test('a plan goes with the task at a handoff, with each step’s status and the run it came from', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  report(env, run);
  assert.deepEqual(env.broker.briefPreview(env.c).brief.unfinishedPlan, planned, 'While the run works, the Brief panel shows its plan.');
  await env.broker.handoff.check(run);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  const next = env.broker.running;
  assert.deepEqual(env.c.activeRun.plan.steps, planned);
  assert.deepEqual(env.c.activeRun.plan.carriedFrom, { runId: run.id, provider: 'codex' });
  await continued(env, 'claude');
  assert.deepEqual(lastBrief(env).unfinishedPlan, planned, 'The next agent knows what is done, in progress and left.');
  assert.match(lastBrief(env).unfinishedPlanNote, /codex last reported.*Check it against the files/s, 'As history to check, not as instructions.');
  await next.done;
  assert.deepEqual(env.c.lastRun.plan.steps, planned, 'An agent that reports no plan leaves it as it was.');
  await env.broker.close();
  const reopened = new Broker({ workspace: env.workspace, dataDir: env.dataDir, bins: env.bins });
  t.reopened(reopened);
  assert.deepEqual(reopened.get(env.c.id).lastRun.plan.steps, planned, 'It survives a restart.');
  assert.deepEqual(reopened.get(env.c.id).lastRun.plan.carriedFrom.provider, 'codex');
});

test('the next agent’s plan replaces the carried one, and done steps stay done unless it says otherwise', { skip: scriptCLIs }, async t => {
  const env = setup(t), run = await env.start();
  report(env, run);
  await env.broker.handoff.check(run);
  await env.broker.acceptHandoff(env.c, { offerId: env.c.handoffOffer.id });
  const next = env.broker.running;
  report(env, next, [{ text: 'Write the tests', status: 'done' }, { text: 'Fix what they find', status: 'active' }]);
  assert.deepEqual(env.c.activeRun.plan.steps.map(step => [step.text, step.status]), [['Read the code', 'done'], ['Write the tests', 'done'], ['Fix what they find', 'active']], 'A step it left out that was done stays; one that was not done is replaced.');
  report(env, next, [{ text: 'read the code', status: 'pending' }, { text: 'Fix what they find', status: 'active' }]);
  assert.deepEqual(env.c.activeRun.plan.steps.map(step => [step.text, step.status]), [['Write the tests', 'done'], ['read the code', 'pending'], ['Fix what they find', 'active']], 'Listing a done step again is reporting otherwise.');
  await next.done;
});

test('a plan carries through Continue with another agent and a wait for a reset, but not to a new prompt or once finished', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.usage.codex = 100;
  const run = await env.start();
  report(env, run);
  env.broker.event(run, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  env.release(); await done(env);
  await env.broker.continueTask(env.c, { provider: 'claude', mode: 'edit', approvalPolicy: 'ask' });
  assert.deepEqual(env.c.activeRun.plan.steps, planned, 'Continue with another agent.');
  await done(env);

  env.broker.start(env.c, { text: 'Something new', provider: 'claude', mode: 'edit', approvalPolicy: 'ask' });
  assert.equal(env.c.activeRun.plan, undefined, 'A new prompt does not inherit the old plan.');
  await env.broker.running.done;
  assert.equal(captures(env).at(-1).context.brief?.unfinishedPlan, undefined);

  // Continuing after a reset.
  const waiting = setup(t);
  waiting.usage.codex = 100;
  const first = await waiting.start();
  report(waiting, first);
  waiting.broker.event(first, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  waiting.release(); await done(waiting);
  waiting.broker.scheduleResume(waiting.c, { providers: ['claude'] });
  await until(() => waiting.broker.running || !waiting.c.resume, 'the wait to end');
  assert.deepEqual(waiting.c.activeRun?.plan?.steps, planned, 'Continuing after a reset.');
  await done(waiting);

  // Nothing left to carry.
  const finished = setup(t), last = await finished.start();
  report(finished, last, [{ text: 'All of it', status: 'done' }]);
  finished.release(); await done(finished);
  assert.equal(finished.c.lastRun.status, 'complete');
  await finished.broker.continueTask(finished.c, { provider: 'claude', mode: 'edit', approvalPolicy: 'ask' });
  assert.equal(finished.c.activeRun.plan, undefined);
  await done(finished);
});

test('a plan reported over Gemini’s protocol is carried like any other', { skip: scriptCLIs }, async t => {
  const gemini = `#!${process.execPath}
import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'native-session'}});
if(m.method==='session/prompt'){emit({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'plan',entries:[{content:'Gemini step done',status:'completed'},{content:'Gemini step now',status:'in_progress'},{content:'Gemini step later',status:'pending'}]}}});emit({id:m.id,error:{code:429,message:'Quota exceeded for this account.'}});}
}
`;
  const env = setup(t, { preferences: allowed, gemini });
  env.usage.gemini = 100;
  reached(env, 'Fix the checkout', 'gemini');
  await continued(env, 'claude');
  const wanted = [{ text: 'Gemini step done', status: 'done' }, { text: 'Gemini step now', status: 'active' }, { text: 'Gemini step later', status: 'pending' }];
  await until(() => captures(env).at(-1).context.brief?.unfinishedPlan, 'the brief');
  assert.deepEqual(captures(env).at(-1).context.brief.unfinishedPlan, wanted);
  await done(env);
  assert.deepEqual(env.c.lastRun.plan.steps, wanted);
  assert.equal(env.c.lastRun.plan.carriedFrom.provider, 'gemini');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { continuationRequest } from '../src/context.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));

// Codex holds the workspace while Claude, Codex and Gemini report the usage and billing each test sets.
function setup(t, { preferences = { threshold: 90, automatic: false } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-handoff-'));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Build the feature': { behavior: 'hold' } }));
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}-mock.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  }
  bins.gemini = path.join(root, 'missing-gemini');
  const settings = { ...preferences }, usage = { codex: 92, claude: 20 }, billing = { claude: 'subscription' }, notices = [];
  const broker = new Broker({ workspace, dataDir, bins, handoffPreferences: () => settings });
  broker.handoff.usage = async provider => usage[provider] === undefined ? { available: false } : { available: true, windows: [{ id: 'primary', label: '5-hour', usedPercent: usage[provider], resetsAt: new Date(Date.now() + 3600000).toISOString() }] };
  // Gemini is not installed in these tests, as its missing binary says.
  broker.handoff.account = async provider => ({ installed: provider !== 'gemini', authenticated: true, billingSource: billing[provider] || 'subscription' });
  broker.on('notify', notice => notices.push(notice));
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  return {
    broker, c, settings, usage, billing, notices,
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
  assert(automatic.c.messages.some(message => /Throughline handed the task to Claude/.test(message.text)));
  assert(automatic.notices.some(notice => notice.title === 'Handed off to Claude'));

  const manual = setup(t), run = await manual.start();
  await manual.broker.handoff.check(run);
  manual.broker.dismissHandoff(manual.c, manual.c.handoffOffer.id);
  await manual.broker.handoff.check(run);
  assert.equal(manual.c.handoffOffer, null, 'A dismissed offer is not repeated during this run.');
  manual.release(); await run.done;
});

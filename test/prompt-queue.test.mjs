import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { QUEUE_LIMIT } from '../src/prompt-queue.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));

function setup(t, scenarios = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-queue-'));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Hold the workspace': { behavior: 'hold' }, 'Quota stop': { behavior: 'quota' }, ...scenarios }));
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}-mock.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  }
  const brokers = [];
  t.after(async () => { await Promise.all(brokers.map(broker => broker.close())); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    workspace,
    open() { const broker = new Broker({ workspace, dataDir, bins }); brokers.push(broker); return broker; },
    release() { fs.writeFileSync(path.join(workspace, '.release'), ''); },
    requests() { const file = path.join(workspace, '.mock-captures.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(JSON.parse).map(entry => [entry.provider, entry.context.currentRequest]) : []; },
  };
}
const add = (broker, c, text, options = {}) => broker.queueAction(c, { action: 'add', text, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', ...options });
async function idle(broker, c) {
  for (let i = 0; i < 1500; i++) { if (!broker.running && !c.queue.length) return; if (broker.running) await broker.running.done; else await new Promise(resolve => setTimeout(resolve, 10)); if (c.queuePaused) return; }
}

test('queued prompts run in order after the current work, each with the settings it was queued with, and can be reordered and edited first', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  broker.start(c, { text: 'Hold the workspace', provider: 'codex', mode: 'edit' });
  const first = add(broker, c, 'First queued').queue[0].id;
  add(broker, c, 'Second queued', { provider: 'claude', mode: 'read' });
  assert.equal(c.queue.length, 2, 'Nothing starts while the workspace is busy.');
  broker.queueAction(c, { action: 'move', id: c.queue[1].id, index: 0 });
  broker.queueAction(c, { action: 'update', id: first, text: 'First queued, edited' });
  assert.deepEqual(c.queue.map(item => item.text), ['Second queued', 'First queued, edited']);
  env.release();
  await idle(broker, c);
  assert.deepEqual(env.requests().slice(1), [['claude', 'Second queued'], ['codex', 'First queued, edited']]);
  assert.equal(c.queue.length, 0); assert.equal(c.lastRun.status, 'complete');
  assert(c.messages.some(message => message.role === 'user' && message.text === 'Second queued' && message.provider === 'claude'));
});

test('a stop pauses the queue with the reason until it is resumed, and the queue survives a restart paused', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  broker.start(c, { text: 'Hold the workspace', provider: 'codex', mode: 'edit' });
  add(broker, c, 'After the stop');
  const running = broker.running; broker.stop(c.id); await running.done;
  assert.equal(c.queuePaused.reason, 'You stopped the run.'); assert.equal(c.queue.length, 1); assert.equal(broker.running, null);
  await broker.close();

  const reopened = env.open(), again = reopened.get(c.id);
  assert.equal(again.queue[0].text, 'After the stop'); assert(again.queuePaused, 'Queued work waits for the person after a restart.');
  reopened.queueAction(again, { action: 'resume' });
  assert.equal(again.queuePaused, null); assert(reopened.running, 'Resuming starts the next prompt when the workspace is free.');
  await idle(reopened, again);
  assert.deepEqual(env.requests().at(-1), ['codex', 'After the stop']);
});

test('a queued prompt that reaches a usage limit waits for a reset instead of pausing', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  broker.start(c, { text: 'Hold the workspace', provider: 'codex', mode: 'edit' });
  add(broker, c, 'Quota stop'); add(broker, c, 'Later work');
  // The first wait check finds no agent with room, so the queue stays behind the wait.
  broker.resume.usage = async () => ({ available: true, windows: [{ id: 'primary', usedPercent: 100, resetsAt: new Date(Date.now() + 3600000).toISOString() }] });
  env.release();
  for (let i = 0; i < 1500 && !c.resume; i++) { if (broker.running) await broker.running.done; else await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(c.lastRun.errorCategory, 'quota'); assert(c.resume, 'The queue waits for a reset.');
  assert.equal(c.queuePaused, null); assert.deepEqual(c.queue.map(item => item.text), ['Later work']);
});

test('the queue has a limit, refuses settings a run would refuse, and stale edits fail clearly', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  broker.start(c, { text: 'Hold the workspace', provider: 'codex', mode: 'edit' });
  assert.throws(() => add(broker, c, 'Read and approve everything', { mode: 'read', approvalPolicy: 'auto' }), /read/i);
  assert.throws(() => add(broker, c, '   '), /between 1 and 100,000/);
  assert.throws(() => add(broker, c, 'With a missing file', { attachments: ['missing-attachment'] }));
  assert.throws(() => broker.queueAction(c, { action: 'remove', id: 'gone' }), /already started or been removed/);
  for (let i = 0; i < QUEUE_LIMIT; i++) add(broker, c, `Prompt ${i + 1}`);
  assert.throws(() => add(broker, c, 'One too many'), /up to 20/);
  assert.throws(() => broker.queueAction(c, { action: 'move', id: c.queue[0].id, index: QUEUE_LIMIT }), /position/);
  broker.queueAction(c, { action: 'pause' });
  const running = broker.running; env.release(); await running.done;
  assert.equal(c.queue.length, QUEUE_LIMIT, 'A paused queue does not start the next prompt.');
});

test('choosing and editing model and effort for queued prompts survives restarts and applies to the run', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  broker.start(c, { text: 'Hold the workspace', provider: 'codex', mode: 'edit', model: 'initial-model', effort: 'low' });
  assert.equal(c.activeRun.model, 'initial-model');
  assert.equal(c.activeRun.effort, 'low');

  broker.settings(c, { model: 'next-model', effort: 'high' });
  assert.equal(c.activeRun.model, 'initial-model');
  assert.equal(c.activeRun.effort, 'low');
  assert.equal(c.model, 'next-model');
  assert.equal(c.effort, 'high');

  broker.execution.setDefault(c, { mode: 'flow' });
  const q1 = add(broker, c, 'First queued with routing', { model: 'routed-model', effort: 'medium', routing: { mode: 'balanced', reason: 'Initial routing reason', tier: 'standard' } }).queue[0].id;
  assert.equal(c.queue[0].model, 'routed-model');
  assert.equal(c.queue[0].effort, 'medium');
  assert.equal(c.queue[0].routing.reason, 'Initial routing reason');

  broker.queueAction(c, { action: 'update', id: q1, text: 'First queued, edited model', model: 'manual-model', effort: 'high' });
  assert.equal(c.queue[0].model, 'manual-model');
  assert.equal(c.queue[0].effort, 'high');
  assert.equal(c.queue[0].routing, undefined, 'Changing model clears routing so reason is no longer shown');

  assert.throws(() => broker.queueAction(c, { action: 'update', id: q1, effort: 'unsupported-effort' }), /supported reasoning effort/);

  await broker.close();
  const reopened = env.open(), again = reopened.get(c.id);
  assert.equal(again.queue[0].model, 'manual-model');
  assert.equal(again.queue[0].effort, 'high');
  assert.equal(again.queue[0].routing, undefined);

  env.release();
  reopened.queueAction(again, { action: 'resume' });
  await idle(reopened, again);
  assert.equal(again.lastRun.model, 'manual-model');
  assert.equal(again.lastRun.effort, 'high');
});

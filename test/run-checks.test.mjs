import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { CHECK_PAUSE, retryPrompt } from '../src/run-checks.mjs';
import { createRelayServer } from '../src/server.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
const changes = [{ path: 'src/checkout.js', kind: 'modify' }];
const step = { provider: 'codex', model: 'gpt-codex', modelName: 'GPT Codex', effort: 'high', tier: 'deep' };

// A workspace with a mock Codex, and a stand-in for the saved Test command that ends as each scenario says.
function setup(t, results = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-checks-'));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Add promo codes': { changes }, 'Hold the workspace': { behavior: 'hold', changes } }));
  const bin = path.join(root, 'codex-mock.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  const runs = [], brokers = [], notices = [];
  let saved = { command: 'npm test', folderId: 'f', directory: '' };
  const tests = {
    saved: () => saved,
    run() {
      const result = results.shift() || { status: 'exited', exitCode: 0, output: '24 passing' };
      if (result.busy) throw Object.assign(new Error('The Test command was already running.'), { status: 409 });
      const session = { view: () => result, stopped: false };
      session.done = result.hang ? new Promise(resolve => { session.release = resolve; }) : Promise.resolve();
      session.stop = async () => { session.stopped = true; result.status = 'stopped'; session.release?.(); };
      runs.push(session);
      return session;
    },
  };
  t.after(async () => { await Promise.all(brokers.map(broker => broker.close())); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    runs, notices, release: () => fs.writeFileSync(path.join(workspace, '.release'), ''), unsave: () => { saved = null; },
    open(usedPercent = 10) {
      const broker = new Broker({ workspace, dataDir, bins: { codex: bin }, tests });
      broker.checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ usedPercent }] });
      broker.on('notify', notice => notices.push(notice));
      brokers.push(broker); return broker;
    },
  };
}
const routed = (mode, extra = {}) => ({ provider: 'codex', mode: 'edit', model: 'gpt-codex-mini', effort: 'low', routing: { mode, reason: 'A focused change', tier: 'standard', escalation: step, ...extra } });
async function until(check, ms = 15000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const checks = c => c.messages.filter(message => message.role === 'activity' && message.text.startsWith('Tests ')).map(message => message.text.split('\n')[0]);
const settled = (broker, c, count) => until(() => !broker.running && c.runs.filter(run => run.check && run.check.status !== 'running').length >= count);

test('a routed run that changes files is checked with the saved Test command, and queued prompts wait for it', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'balanced', check: true });
  broker.start(c, { text: 'Hold the workspace', ...routed('balanced') });
  broker.queueAction(c, { action: 'add', text: 'Then update the changelog', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', routing: { mode: 'balanced', reason: 'A small change', tier: 'light' } });
  env.release();
  await until(() => c.runs.length === 2 && !broker.running);
  assert.equal(env.runs.length, 1, 'The queued prompt changed nothing, so only the first run was checked.');
  assert.deepEqual(checks(c), ['Tests passed: npm test']);
  const [first, second] = c.runs;
  assert.equal(first.check.status, 'passed'); assert.equal(second.check, undefined);
  assert(Date.parse(second.startedAt) >= Date.parse(first.check.startedAt), 'The queued prompt started after the check.');
  assert.deepEqual(first.routing, { mode: 'balanced', tier: 'standard' }, 'The history keeps how each run was routed.');

  broker.setRouting(c, { mode: 'balanced', check: false });
  broker.start(c, { text: 'Add promo codes', ...routed('balanced') });
  await until(() => !broker.running && c.runs.length === 3);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(env.runs.length, 1, 'With Check with tests off, nothing is checked.');
  broker.setRouting(c, { mode: 'balanced', check: true });
  broker.start(c, { text: 'Add promo codes', provider: 'codex', mode: 'edit' });
  await until(() => !broker.running && c.runs.length === 4);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(env.runs.length, 1, 'A model chosen by hand is not routed, so it is not checked.');
});

test('failing tests are retried once, one step up and told what failed; a retry that still fails stops there and holds the queue', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ status: 'failed', exitCode: 1, output: 'checkout › applies a promo code\nExpected 90, received 100' }, { status: 'failed', exitCode: 1, output: 'still failing' }]);
  const broker = env.open(), c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'balanced', check: true });
  broker.start(c, { text: 'Hold the workspace', ...routed('balanced') });
  broker.queueAction(c, { action: 'add', text: 'Then update the changelog', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  env.release();
  await settled(broker, c, 2);
  const [first, retry] = c.runs;
  assert.equal(retry.retryOf, first.id);
  const prompt = c.messages.find(message => message.runId === retry.id && message.role === 'user');
  assert.deepEqual(prompt.retry, { of: first.id });
  assert.deepEqual([prompt.provider, prompt.routing.model, prompt.routing.effort], ['codex', 'gpt-codex', 'high'], 'The retry goes one step up with the same agent.');
  assert.match(prompt.text, /tests failed after your changes[\s\S]*Test command: npm test[\s\S]*Exit code: 1[\s\S]*Expected 90, received 100/);
  assert.deepEqual(checks(c), ['Tests failed: npm test', 'Tests failed: npm test']);
  assert.equal(c.runs.length, 2, 'A retry is never retried.');
  assert.deepEqual(c.queuePaused?.reason, CHECK_PAUSE, 'Queued prompts wait while the tests fail.');
  assert.equal(c.queue.length, 1);
  assert(env.notices.some(notice => notice.title === 'Tests still fail'));
});

test('Cost saving, or an agent near its limit, offers the retry; accepting starts it, and passing tests let the queue carry on', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ status: 'failed', exitCode: 1, output: 'fail' }, { status: 'exited', exitCode: 0, output: 'pass' }, { status: 'failed', exitCode: 2, output: 'fail' }]);
  const broker = env.open(), c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'saving', check: true });
  broker.start(c, { text: 'Hold the workspace', ...routed('saving') });
  broker.queueAction(c, { action: 'add', text: 'Then update the changelog', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  env.release();
  await until(() => c.retryOffer);
  assert.deepEqual([c.retryOffer.provider, c.retryOffer.model, c.retryOffer.effort, c.retryOffer.blocked], ['codex', 'gpt-codex', 'high', undefined]);
  assert.equal(c.runs.length, 1, 'Cost saving asks before retrying.');
  assert.equal(c.queuePaused?.reason, CHECK_PAUSE);
  assert(env.notices.some(notice => notice.title === 'Tests failed' && /Retry with Codex · GPT Codex · High effort/.test(notice.body)));
  assert.throws(() => broker.acceptRetry(c, { offerId: 'other' }), /no longer offered/);
  broker.acceptRetry(c, { offerId: c.retryOffer.id });
  assert.equal(c.retryOffer, null);
  await until(() => c.runs.length === 3 && !broker.running);
  assert.deepEqual(c.runs.map(run => run.check?.status), ['failed', 'passed', undefined], 'The retry passed, so the queue resumed and its prompt ran.');
  assert.equal(c.queuePaused, null);

  const busy = env.open(85), b = busy.get(busy.create().id);
  busy.setRouting(b, { mode: 'balanced', check: true });
  busy.start(b, { text: 'Add promo codes', ...routed('balanced') });
  await until(() => b.retryOffer);
  assert.equal(b.retryOffer.blocked, 'Codex is at 85% of its limit', 'An agent near its limit asks first, even in Balanced.');
  busy.start(b, { text: 'Hello', provider: 'codex', mode: 'edit' });
  assert.equal(b.retryOffer, null, 'A new message replaces the offer.');
  await busy.running.done;
});

test('a slow check is stopped at its limit, a busy Test command skips it, and a restart ends a running check', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ hang: true, status: 'running', exitCode: null, output: 'watching for changes' }, { busy: true }, { hang: true, status: 'running', exitCode: null, output: '' }]);
  let broker = env.open();
  broker.checks.limitMs = 50;
  const c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'balanced', check: true });
  broker.start(c, { text: 'Add promo codes', ...routed('balanced') });
  await settled(broker, c, 1);
  assert(env.runs[0].stopped, 'The Test command was stopped.');
  assert.equal(c.runs[0].check.status, 'timed-out');
  assert.match(c.messages.find(message => message.text?.startsWith('Tests timed out')).text, /mark one that exits/);
  assert.equal(c.runs.length, 1, 'A check that didn’t finish is not a failure to retry.');

  broker.start(c, { text: 'Add promo codes', ...routed('balanced') });
  await settled(broker, c, 2);
  assert.equal(c.runs[1].check.status, 'skipped');

  broker.checks.limitMs = 60000;
  broker.start(c, { text: 'Add promo codes', ...routed('balanced') });
  await until(() => c.runs[2]?.check?.status === 'running');
  await broker.close();
  broker = env.open();
  const reopened = broker.get(c.id);
  assert.equal(reopened.runs[2].check.status, 'interrupted');
  assert(checks(reopened).includes('Tests interrupted: npm test'));
});

test('the retry prompt names the command and keeps only the end of the output', () => {
  const text = retryPrompt({ command: 'pnpm test', directory: 'web' }, { exitCode: 1, output: 'FAIL src/cart.test.js' });
  assert.match(text, /Test command: pnpm test \(in web\)\nExit code: 1/);
  assert.match(text, /Don't skip, delete or weaken tests/);
  assert.match(text, /```\nFAIL src\/cart.test.js\n```/);
});

test('unavailable or stale quota makes a failed routed check ask before retrying automatically', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ status: 'failed', exitCode: 1, output: 'Failing assertion' }]), broker = env.open(), c = broker.get(broker.create().id);
  broker.checks.usage = async () => ({ available: false });
  broker.setRouting(c, { mode: 'balanced', check: true });
  broker.start(c, { text: 'Add promo codes', ...routed('balanced') });
  await until(() => c.retryOffer);
  assert.match(c.retryOffer.blocked, /allowance is unknown/);
  assert.equal(c.runs.length, 1);
  broker.checks.usage = async () => ({ available: true, checkedAt: new Date(Date.now() - 3600000).toISOString(), windows: [{ usedPercent: 1 }] });
  assert.match(await broker.checks.limited(step, 80), /allowance is stale/);
});

test('through the app, the Test command saved in Project commands checks a routed run, and the retry route answers', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-checks-app-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Add promo codes': { changes } }));
  const bin = path.join(root, 'codex-mock.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  const app = createRelayServer({ workspace, dataRoot: path.join(root, 'data'), bins: { codex: bin } });
  t.after(async () => { await app.close({ force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const project = app.registry.list()[0], id = app.registry.mainConversation(project.id).id;
  const post = async (route, body) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}?projectId=${project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await post('/api/commands/save', { name: 'Tests', folderId: project.folders[0].id, directory: '', command: `"${process.execPath}" -e "process.stdout.write('31 passing')"`, test: true })).status, 200);
  assert.deepEqual((await post(`/api/conversations/${id}/routing`, { mode: 'quality', check: true })).body.routing, { mode: 'quality', allowApi: false, check: true });
  assert.equal((await post(`/api/conversations/${id}/messages`, { text: 'Add promo codes', ...routed('quality'), requestId: 'checked' })).status, 202);
  const c = app.registry.broker(project.id).get(id);
  await until(() => c.runs[0]?.check && c.runs[0].check.status !== 'running');
  assert.equal(c.runs[0].check.status, 'passed');
  assert.match(c.messages.find(message => message.text?.startsWith('Tests passed')).text, /Passed in \d+s\.\n\n31 passing/);
  assert.equal(app.commands.state(project.id).sessions.tests.status, 'exited', 'The check ran as the session the panel shows.');
  assert.equal((await post(`/api/conversations/${id}/retry`, { offerId: 'none', accept: true })).status, 409);
  assert.equal((await post(`/api/conversations/${id}/retry`, { offerId: 'none', accept: false })).status, 200);
});

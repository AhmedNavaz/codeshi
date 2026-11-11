import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { CHECK_PAUSE, RunChecks, retryPrompt } from '../src/run-checks.mjs';
import { createRelayServer } from '../src/server.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
const changes = [{ path: 'src/checkout.js', kind: 'modify' }];
const step = { provider: 'codex', model: 'gpt-codex', modelName: 'GPT Codex', effort: 'high', tier: 'deep' };

// A routed Send rates its request before it starts. Here only the mock Codex is connected, and the rating is a stand-in.
function connectMock(broker) {
  broker.availableProviders = () => ['codex'];
  broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
  broker.handoff.models = async () => ({ data: [{ id: 'gpt-codex', displayName: 'GPT Codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] });
  broker.router.worker = async () => JSON.stringify({ tier: 'light', effort: 'low', reason: 'A small change.' });
}

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
    root, workspace, runs, notices, release: () => fs.writeFileSync(path.join(workspace, '.release'), ''), unsave: () => { saved = null; },
    open(usedPercent = 10, verificationCadence = () => 'as-needed') {
      const broker = new Broker({ workspace, dataDir, bins: { codex: bin }, tests, verificationCadence });
      broker.checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ usedPercent }] });
      connectMock(broker);
      broker.on('notify', notice => notices.push(notice));
      brokers.push(broker); return broker;
    },
  };
}
const routed = (mode, extra = {}) => ({ provider: 'codex', mode: 'edit', model: 'gpt-codex-mini', effort: 'low', routing: { mode, reason: 'A focused change', tier: 'standard', escalation: step, ...extra } });
async function until(check, ms = 15000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const checks = c => c.messages.filter(message => message.role === 'activity' && message.text.startsWith('Tests ')).map(message => message.text.split('\n')[0]);
const settled = (broker, c, count) => until(() => !broker.running && c.runs.filter(run => run.check && run.check.status !== 'running').length >= count);

test('Review first defers the routine check and repair loop, preserves queues and snapshots the starting cadence', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ status: 'failed', exitCode: 1, output: 'Would fail if run.' }]);
  let cadence = 'review-first';
  const broker = env.open(10, () => cadence), c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'smart', check: true });
  broker.start(c, { text: 'Hold the workspace', ...routed('smart') });
  broker.queueAction(c, { action: 'add', text: 'A follow-up without edits', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  cadence = 'as-needed';
  env.release();
  await until(() => c.runs.length === 2 && !broker.running);
  assert.equal(env.runs.length, 0, 'The routine test command and its failure retry were never started.');
  assert.equal(c.runs[0].check.status, 'deferred');
  assert.equal(c.runs[0].verification.cadence, 'review-first');
  assert.equal(c.runs[1].verification.cadence, 'as-needed', 'New turns use the latest setting.');
  assert.deepEqual(checks(c), ['Tests deferred: npm test']);
  assert.equal(c.queue.length, 0); assert.equal(c.retryOffer, null);
  assert.equal(c.messages.find(message => message.text.startsWith('Tests deferred:')).runId, c.runs[0].id);
  await broker.close();
  const reopened = env.open();
  assert.equal(reopened.get(c.id).runs[0].check.status, 'deferred', 'Deferral stays explicit after restart.');
});

test('Review first never skips explicitly selected workflow checks or test repair', async () => {
  const checks = new RunChecks({ record() { assert.fail('A required check must not be deferred.'); } });
  let started = 0;
  checks.wanted = () => ({ command: 'npm test' });
  checks.check = async () => { started++; };
  for (const workflow of [{ retryOf: 'failed-run' }, { automaticReview: { enabled: true } }]) assert.equal(checks.runEnded({}, { verification: { cadence: 'review-first' }, ...workflow }, 'complete'), true);
  await Promise.all(checks.pending);
  assert.equal(started, 2);
});

test('a routed run that changes files is checked with the saved Test command, and queued prompts wait for it', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'smart', check: true });
  broker.start(c, { text: 'Hold the workspace', ...routed('smart') });
  broker.queueAction(c, { action: 'add', text: 'Then update the changelog', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', routing: { mode: 'smart', reason: 'A small change', tier: 'light' } });
  env.release();
  await until(() => c.runs.length === 2 && !broker.running);
  assert.equal(env.runs.length, 1, 'The queued prompt changed nothing, so only the first run was checked.');
  assert.deepEqual(checks(c), ['Tests passed: npm test']);
  const [first, second] = c.runs;
  assert.equal(first.check.status, 'passed'); assert.equal(second.check, undefined);
  assert(Date.parse(second.startedAt) >= Date.parse(first.check.startedAt), 'The queued prompt started after the check.');
  assert.deepEqual(first.routing, { mode: 'smart', tier: 'standard', reason: 'A focused change' }, 'The history keeps how each run was routed, with its reason.');

  broker.setRouting(c, { mode: 'smart', check: false });
  broker.start(c, { text: 'Add promo codes', ...routed('smart') });
  await until(() => !broker.running && c.runs.length === 3);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(env.runs.length, 1, 'With Check with tests off, nothing is checked.');
  broker.setRouting(c, { mode: 'smart', check: true });
  broker.start(c, { text: 'Add promo codes', provider: 'codex', mode: 'edit' });
  await until(() => !broker.running && c.runs.length === 4);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(env.runs.length, 1, 'A model chosen by hand is not routed, so it is not checked.');
});

// An Ultra build in a Git repository with a second subscription agent, Claude, connected to review it.
function ultraBuild(t, claudePercent = 10) {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  execFileSync('git', ['init', '-b', 'main'], { cwd: env.workspace });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: env.workspace });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: env.workspace });
  fs.mkdirSync(path.join(env.workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(env.workspace, 'src/checkout.js'), 'export const price = 100;\n');
  execFileSync('git', ['add', 'src/checkout.js'], { cwd: env.workspace });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: env.workspace });
  fs.writeFileSync(path.join(env.workspace, 'src/checkout.js'), 'export const price = 90;\n');

  const claudeBin = path.join(env.root, 'claude-mock.mjs');
  fs.writeFileSync(claudeBin, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  broker.configuredBins.claude = claudeBin;
  broker.availableProviders = () => ['codex', 'claude'];
  broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
  broker.handoff.models = async provider => ({ data: provider === 'claude' ? [{ id: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }] : [{ id: 'gpt-codex', displayName: 'GPT Codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] });

  broker.checks.usage = async provider => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ usedPercent: provider === 'claude' ? claudePercent : 10 }] });
  broker.setRouting(c, { mode: 'ultra', check: true });
  broker.start(c, { text: 'Add promo codes', ...routed('ultra') });
  return { broker, c };
}

test('in Ultra, passing tests send the finished changes for an independent read-only review when a second subscription agent has room', { skip: scriptCLIs }, async t => {
  const { broker, c } = ultraBuild(t);
  await until(() => c.runs.some(run => run.review) && !broker.running && !broker.backgroundReview);
  const reviewRun = c.runs.find(run => run.review);
  assert.equal(reviewRun.provider, 'claude');
  assert.equal(reviewRun.mode, 'read');
  assert.equal(c.reviews.length, 1);
  assert.equal(c.reviews[0].provider, 'claude');
  assert.equal(c.taskBudgets[c.runs[0].taskId].reviews, 1);
});

// The reviewer is held to Ultra's own 95% line (#12), with room for a usual run, as an agent taking over a task would be.
test('Ultra asks a reviewer only with room under its 95% handoff line for a usual run', { skip: scriptCLIs }, async t => {
  const fits = ultraBuild(t, 90);
  await until(() => fits.c.runs.some(run => run.review) && !fits.broker.running && !fits.broker.backgroundReview);
  assert.equal(fits.c.runs.find(run => run.review).provider, 'claude', 'At 90%, five points under the line is room for a usual run.');

  const full = ultraBuild(t, 91);
  await until(() => full.c.runs[0]?.check?.status === 'passed' && !full.broker.running);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(full.c.runs.some(run => run.review), false, 'At 91%, a usual run would take the reviewer past the line.');
});

test('failing tests are retried once, one step up and told what failed; a retry that still fails stops there and holds the queue', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ status: 'failed', exitCode: 1, output: 'checkout › applies a promo code\nExpected 90, received 100' }, { status: 'failed', exitCode: 1, output: 'still failing' }]);
  const broker = env.open(), c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'smart', check: true });
  broker.start(c, { text: 'Hold the workspace', ...routed('smart') });
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

test('Saver, or an agent near its limit, offers the retry; accepting starts it, and passing tests let the queue carry on', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ status: 'failed', exitCode: 1, output: 'fail' }, { status: 'exited', exitCode: 0, output: 'pass' }, { status: 'failed', exitCode: 2, output: 'fail' }]);
  const broker = env.open(), c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'saver', check: true });
  broker.start(c, { text: 'Hold the workspace', ...routed('saver') });
  broker.queueAction(c, { action: 'add', text: 'Then update the changelog', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  env.release();
  await until(() => c.retryOffer);
  assert.deepEqual([c.retryOffer.provider, c.retryOffer.model, c.retryOffer.effort, c.retryOffer.blocked], ['codex', 'gpt-codex', 'high', undefined]);
  assert.equal(c.runs.length, 1, 'Saver asks before retrying.');
  assert.equal(c.queuePaused?.reason, CHECK_PAUSE);
  assert(env.notices.some(notice => notice.title === 'Tests failed' && /Retry with Codex · GPT Codex · High effort/.test(notice.body)));
  assert.throws(() => broker.acceptRetry(c, { offerId: 'other' }), /no longer offered/);
  broker.acceptRetry(c, { offerId: c.retryOffer.id });
  assert.equal(c.retryOffer, null);
  await until(() => c.runs.length === 3 && !broker.running);
  assert.deepEqual(c.runs.map(run => run.check?.status), ['failed', 'passed', undefined], 'The retry passed, so the queue resumed and its prompt ran.');
  assert.equal(c.queuePaused, null);

  const busy = env.open(92), b = busy.get(busy.create().id);
  busy.setRouting(b, { mode: 'smart', check: true });
  busy.start(b, { text: 'Add promo codes', ...routed('smart') });
  await until(() => b.retryOffer);
  assert.equal(b.retryOffer.blocked, 'Codex is at 92% of its limit, past Smart’s 90% handoff line', 'An agent past its mode’s line asks first, even in Smart.');
  busy.start(b, { text: 'Hello', provider: 'codex', mode: 'edit' });
  assert.equal(b.retryOffer, null, 'A new message replaces the offer.');
  await busy.running.done;
});

test('a slow check is stopped at its limit, a busy Test command skips it, and a restart ends a running check', { skip: scriptCLIs }, async t => {
  const env = setup(t, [{ hang: true, status: 'running', exitCode: null, output: 'watching for changes' }, { busy: true }, { hang: true, status: 'running', exitCode: null, output: '' }]);
  let broker = env.open();
  broker.checks.limitMs = 50;
  const c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'smart', check: true });
  broker.start(c, { text: 'Add promo codes', ...routed('smart') });
  await settled(broker, c, 1);
  assert(env.runs[0].stopped, 'The Test command was stopped.');
  assert.equal(c.runs[0].check.status, 'timed-out');
  assert.match(c.messages.find(message => message.text?.startsWith('Tests timed out')).text, /mark one that exits/);
  assert.equal(c.runs.length, 1, 'A check that didn’t finish is not a failure to retry.');

  broker.start(c, { text: 'Add promo codes', ...routed('smart') });
  await settled(broker, c, 2);
  assert.equal(c.runs[1].check.status, 'skipped');

  broker.checks.limitMs = 60000;
  broker.start(c, { text: 'Add promo codes', ...routed('smart') });
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
  broker.setRouting(c, { mode: 'smart', check: true });
  broker.start(c, { text: 'Add promo codes', ...routed('smart') });
  await until(() => c.retryOffer);
  assert.match(c.retryOffer.blocked, /allowance is unknown/);
  assert.equal(c.runs.length, 1);
  broker.checks.usage = async () => ({ available: true, checkedAt: new Date(Date.now() - 3600000).toISOString(), windows: [{ usedPercent: 1 }] });
  assert.match(await broker.checks.limited(c, { provider: 'codex', routing: { mode: 'smart', tier: 'deep' } }, step), /allowance is stale/);
});

// One line for the whole task (#12): a retry goes ahead on its own exactly while the agent could keep the task, so a
// Smart task never pauses at 85% for a retry when the same agent would carry on working there.
test('an automatic retry follows the mode’s handoff line at the 80, 90 and 95% boundaries', () => {
  const checks = new RunChecks({ usageOptions: () => ({}) }), c = { runs: [] };
  const retryAt = async (mode, usedPercent, resetsAt = null) => {
    checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', label: '5-hour', usedPercent, resetsAt }] });
    return checks.limited(c, { provider: 'codex', routing: { mode, tier: 'deep' } }, step);
  };
  return (async () => {
    assert.equal(await retryAt('smart', 85), null, 'Smart retries under its 90% line.');
    assert.equal(await retryAt('smart', 89.9), null);
    assert.equal(await retryAt('smart', 90), 'Codex is at 90% of its limit, past Smart’s 90% handoff line');
    assert.equal(await retryAt('ultra', 94), null, 'Ultra retries under its 95% line.');
    assert.equal(await retryAt('ultra', 95), 'Codex is at 95% of its limit, past Ultra’s 95% handoff line');
    assert.equal(await retryAt('balanced', 85), null, 'A saved Balanced task is Smart.');
    assert.equal(await retryAt('smart', 100), 'Codex has reached its limit');
    // Past the line in a window about to reset, what is left would expire unused, so the task's agent may spend it (#153).
    assert.equal(await retryAt('smart', 93, new Date(Date.now() + 15 * 60000).toISOString()), null);
  })();
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
  connectMock(app.registry.broker(project.id));
  const usedNothing = { available: true, checkedAt: new Date().toISOString(), windows: [{ usedPercent: 10 }] };
  app.registry.broker(project.id).checks.usage = async () => usedNothing;
  const post = async (route, body) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}?projectId=${project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await post('/api/commands/save', { name: 'Tests', folderId: project.folders[0].id, directory: '', command: `"${process.execPath}" -e "process.stdout.write('31 passing')"`, test: true })).status, 200);
  assert.deepEqual((await post(`/api/conversations/${id}/routing`, { mode: 'ultra', check: true, executionRevision: 0 })).body.routing, { mode: 'ultra', allowApi: false, check: true });
  assert.equal((await post(`/api/conversations/${id}/messages`, { text: 'Add promo codes', ...routed('ultra'), executionRevision: 1, requestId: 'checked' })).status, 202);
  const c = app.registry.broker(project.id).get(id);
  await until(() => c.runs[0]?.check && c.runs[0].check.status !== 'running');
  assert.equal(c.runs[0].check.status, 'passed');
  assert.match(c.messages.find(message => message.text?.startsWith('Tests passed')).text, /Passed in \d+s\.\n\n31 passing/);
  assert.equal(app.commands.state(project.id).sessions.tests.status, 'exited', 'The check ran as the session the panel shows.');
  assert.equal((await post(`/api/conversations/${id}/retry`, { offerId: 'none', accept: true })).status, 409);
  assert.equal((await post(`/api/conversations/${id}/retry`, { offerId: 'none', accept: false })).status, 200);
});

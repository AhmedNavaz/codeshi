import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { ReviewJobs } from '../src/review-jobs.mjs';
import { executionConfig } from '../src/execution-policy.mjs';
import { continuationRequest } from '../src/context.mjs';
import { createRelayServer } from '../src/server.mjs';
import { phoneRemoteRequest, phoneRemotePath } from '../src/phone-remote.mjs';
import { scriptCLIs } from './platform.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const usage = { available: true, checkedAt: new Date().toISOString(), windows: [{ usedPercent: 10 }] };
async function until(check) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-policy-')), workspace = path.join(root, 'project'), dataDir = path.join(root, 'journal');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ Hold: { behavior: 'hold' }, Quota: { behavior: 'quota' }, Change: { changes: [{ path: 'feature.js', kind: 'modify' }] } }));
  const bins = {};
  for (const provider of ['codex', 'claude']) { bins[provider] = path.join(root, provider + '.mjs'); fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 }); }
  const opened = [];
  const open = () => { const broker = new Broker({ workspace, dataDir, bins, ...options }); opened.push(broker); broker.availableProviders = () => ['codex', 'claude']; broker.checks.usage = async () => usage; broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' }); return broker; };
  const broker = open(), c = broker.get(broker.create().id);
  const captures = () => { try { return fs.readFileSync(path.join(workspace, '.mock-captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  t.after(async () => { for (const broker of opened) await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const takeover = (taskId = broker.execution.active(c)?.taskId) => broker.execution.change(c, { taskId, revision: broker.execution.current(c, taskId).revision, action: 'takeover' });
  return { addCloser: close => opened.push({ close }), root, workspace, dataDir, bins, broker, c, open, captures, takeover, release: () => fs.writeFileSync(path.join(workspace, '.release'), '') };
}

function flow(broker, c, mode = 'smart') { broker.setRouting(c, { mode, check: true }); }
const routed = (text, mode = 'smart') => ({ text, provider: 'codex', routing: { mode }, mode: 'edit' });

test('turning routing off restores manual control for the previous Flow task and new work', async t => {
  const { broker, c, open } = setup(t);
  flow(broker, c, 'ultra');
  const taskId = 'completed-flow-task';
  broker.execution.ensure(c, taskId);
  broker.record(c, { type: 'run_start', id: taskId, taskId, provider: 'codex' });
  broker.record(c, { type: 'run_metadata', metadata: { taskId } });
  broker.record(c, { type: 'run_end', status: 'complete' });
  const revision = broker.execution.defaults(c).revision;
  assert.throws(() => broker.setRouting(c, { mode: null, executionRevision: revision - 1 }), /Execution policy changed/);
  assert.equal(broker.execution.active(c).mode, 'flow', 'A stale request cannot revoke task authority.');
  broker.setRouting(c, { mode: null, executionRevision: revision });
  assert.equal(c.routing, null);
  assert.equal(broker.execution.defaults(c).mode, 'normal');
  assert.equal(broker.execution.active(c).mode, 'normal');
  assert.equal(Object.values(broker.execution.active(c).automation).every(value => value === false), true);
  const recovered = open(), saved = recovered.get(c.id);
  assert.equal(recovered.execution.active(saved).mode, 'normal', 'Manual control survives reopening the conversation.');
});

test('execution policy validates automation, restrictions and step/pinned overrides separately from access', () => {
  assert.equal(executionConfig().automation.handoff, false);
  assert.equal(executionConfig({ mode: 'flow', automation: { retry: false } }).automation.retry, false);
  for (const value of [{ mode: 'edit' }, { allowedProviders: ['bad'] }, { allowedModels: { codex: [] } }, { override: { provider: 'codex', scope: 'forever' } }]) assert.throws(() => executionConfig(value), /Choose/);
});

test('Normal refuses delegated routing even through direct broker calls and preserves explicit selection', { skip: scriptCLIs }, async t => {
  const { broker, c } = setup(t, { handoffPreferences: () => ({ threshold: 90, automatic: true }) });
  assert.throws(() => broker.start(c, routed('Hello')), /Normal/);
  await assert.rejects(broker.dispatch(c, routed('Hello')), /Normal/);
  broker.start(c, { text: 'Hello', provider: 'claude', model: 'sonnet', effort: 'low' });
  const run = broker.running;
  assert.equal(broker.handoff.policy(run).automatic, false, 'Global automatic handoff cannot grant Normal task authority.');
  await run.done;
  assert.equal(c.lastRun.provider, 'claude'); assert.equal(broker.execution.active(c).mode, 'normal');
});

test('takeover preserves the current native turn, invalidates automatic queue decisions, and survives restart', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; flow(broker, c);
  broker.start(c, routed('Hold')); const run = broker.running;
  await until(() => env.captures().length === 1);
  broker.queue.pause(c, 'Preparing a queue');
  broker.queueAction(c, { action: 'add', text: 'Automatic follow-up', provider: 'codex', routing: { mode: 'smart' } });
  broker.queueAction(c, { action: 'add', text: 'Fixed follow-up', provider: 'claude', model: 'sonnet' });
  const queued = c.queue[0], fixed = c.queue[1], policyId = run.taskId;
  env.takeover();
  assert.equal(broker.running, run); assert.equal(run.stopped, false);
  assert.equal(broker.execution.defaults(c).mode, 'normal');
  assert.equal(broker.execution.allows(c, queued.execution, { action: 'routing' }), false);
  assert.equal(broker.execution.allows(c, fixed.execution, { action: 'manual' }), true);
  env.release(); await run.done;
  assert.equal(c.lastRun.status, 'complete'); assert.equal(env.captures().length, 1);
  assert.throws(() => broker.execution.change(c, { taskId: policyId, revision: 1, action: 'takeover' }), /changed/);
  await broker.close(); const before = await broker.ledger(c);
  const reopened = env.open(), saved = reopened.get(c.id);
  assert.equal(reopened.execution.current(saved, policyId).mode, 'normal');
  assert.deepEqual((await reopened.ledger(saved)).tasks, before.tasks);
  assert.equal(saved.queue.length, 2); assert(saved.queuePaused);
  reopened.queueAction(saved, { action: 'update', id: queued.id, clearRouting: true });
  assert.equal(saved.queue[0].routing, undefined);
  assert(reopened.execution.allows(saved, saved.queue[0].execution, { action: 'manual' }));
});

test('resuming the queue after a takeover runs a routed prompt manually with the agent its row shows', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; flow(broker, c);
  broker.queue.pause(c, 'Preparing a queue');
  broker.queueAction(c, { action: 'add', text: 'Hello', provider: 'claude', model: 'sonnet', effort: 'low', mode: 'edit', routing: { mode: 'smart' } });
  const item = c.queue[0];
  env.takeover(item.execution.taskId);
  assert.notEqual(broker.execution.current(c, item.execution.taskId).revision, item.execution.revision, 'The takeover moved the task on while its prompt waited.');
  broker.queueAction(c, { action: 'resume' });
  await until(() => c.lastRun?.status === 'complete');
  assert.equal(c.queue.length, 0); assert.equal(c.queuePaused, null);
  assert.equal(c.lastRun.provider, 'claude'); assert.equal(env.captures().length, 1);
});

test('revocation while checkpoint preparation awaits prevents a native process from starting', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; flow(broker, c);
  const gate = deferred(); broker.checkpoints.before = () => gate.promise;
  broker.start(c, routed('Hello')); const run = broker.running;
  env.takeover(); gate.resolve(); await run.done;
  assert.equal(env.captures().length, 0); assert.equal(c.lastRun.errorCategory, 'execution-policy');
});

test('takeover during routing account probes makes no assessment or coding start', async t => {
  const { broker, c, takeover, captures } = setup(t); flow(broker, c);
  const gate = deferred(); let assessments = 0;
  broker.router.candidates = () => gate.promise;
  broker.router.worker = async () => { assessments++; return '{}'; };
  const starting = broker.dispatch(c, routed('Repair a concurrent queue')); const rejected = assert.rejects(starting, /stopped|revoked|authority/);
  takeover(); gate.resolve([]); await rejected;
  assert.equal(assessments, 0); assert.equal(captures().length, 0); assert.equal(broker.running, null);
});

test('Normal reset waits keep their chosen agent and model; takeover cancels a Flow wait during quota reads', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env;
  broker.start(c, { text: 'Quota', provider: 'codex', model: 'chosen' }); await broker.running.done;
  assert.throws(() => broker.scheduleResume(c, { providers: ['claude'] }), /Normal/);
  broker.resume.usage = async () => ({ available: true, windows: [{ usedPercent: 100 }] });
  broker.scheduleResume(c, { providers: ['codex'] }); await broker.resume.tick();
  broker.settings(c, { model: 'changed-in-another-tab' });
  assert.equal(c.resume.selection.model, 'chosen'); broker.cancelResume(c);
  flow(broker, c); broker.start(c, routed('Quota')); await broker.running.done;
  const gate = deferred(); broker.resume.usage = () => gate.promise;
  broker.scheduleResume(c, { providers: ['codex', 'claude'] }); const checking = broker.resume.tick();
  env.takeover(); gate.resolve(usage); await checking;
  assert.equal(c.resume, null); assert.equal(broker.running, null); assert.equal(env.captures().length, 2);
});

test('takeover during failed-check quota lookup revokes retries and offers', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; flow(broker, c);
  broker.start(c, routed('Hello')); const run = broker.running; await run.done;
  run.routing.escalation = { provider: 'claude', model: 'sonnet' };
  const gate = deferred(); broker.checks.usage = () => gate.promise;
  const failed = broker.checks.failed(c, run, { command: 'npm test' }, { exitCode: 1, output: 'failed' });
  env.takeover(); gate.resolve(usage); await failed;
  assert.equal(c.retryOffer, null); assert.equal(env.captures().length, 1);
});

test('takeover during a handoff lookup cannot stop current work or create a stale offer', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; flow(broker, c);
  broker.start(c, routed('Hold')); const run = broker.running; await until(() => env.captures().length === 1);
  const gate = deferred(); broker.handoff.destination = () => gate.promise;
  const offered = broker.handoff.offer(c, run, { usedPercent: 95 }); env.takeover(); gate.resolve({ provider: 'claude', model: 'sonnet', billingSource: 'subscription' });
  assert.equal(await offered, null); assert.equal(c.handoffOffer, null); assert.equal(broker.running, run);
  env.release(); await run.done; assert.equal(env.captures().length, 1);
});

test('provider restrictions and one-step overrides are enforced before provider starts', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env;
  broker.execution.setDefault(c, { mode: 'normal', allowedProviders: ['codex'], allowedModels: { codex: ['small', 'large'] }, override: { scope: 'step', provider: 'codex', model: 'small', effort: 'low' } });
  assert.throws(() => broker.start(c, { text: 'Hello', provider: 'claude' }), /outside/);
  assert.throws(() => broker.start(c, { text: 'Hello', provider: 'codex', model: 'large' }), /override/);
  broker.start(c, { text: 'Hello', provider: 'codex', model: 'small', effort: 'low' }); await broker.running.done;
  broker.start(c, { text: continuationRequest, provider: 'codex', model: 'large' }); await broker.running.done;
  assert.equal(env.captures().length, 2); assert.equal(broker.execution.active(c).overrideUsed, true);
});

test('a Flow task limited to some models can still queue routed follow-ups, while manual ones stay limited', async t => {
  const { broker, c } = setup(t);
  broker.queue.pause(c, 'Preparing a queue');
  broker.execution.setDefault(c, { mode: 'flow', routingMode: 'smart', allowedProviders: ['claude'], allowedModels: { claude: ['haiku'] } });
  broker.queueAction(c, { action: 'add', text: 'Then document it', provider: 'codex', routing: { mode: 'smart' } });
  assert.equal(c.queue.length, 1, 'Routing chooses the agent and model later, inside the limits.');
  assert.throws(() => broker.queueAction(c, { action: 'add', text: 'Fixed', provider: 'claude', model: 'sonnet' }), /outside/);
  assert.throws(() => broker.queueAction(c, { action: 'add', text: 'Fixed', provider: 'codex' }), /outside/);
  assert.equal(c.queue.length, 1);
});

test('simultaneous Normal and Flow conversations keep independent task authority', { skip: scriptCLIs }, async t => {
  const { broker, c } = setup(t); flow(broker, c);
  broker.start(c, routed('Hello')); const flowId = broker.running.taskId; await broker.running.done;
  const normal = broker.get(broker.create().id); broker.start(normal, { text: 'Hello', provider: 'claude' }); await broker.running.done;
  assert.equal(broker.execution.current(c, flowId).mode, 'flow'); assert.equal(broker.execution.active(normal).mode, 'normal');
});

test('legacy recovery records existing routing authorization without delegating new work', async t => {
  const env = setup(t), { broker, c } = env;
  broker.record(c, { type: 'run_start', id: 'old-run', provider: 'codex' });
  broker.record(c, { type: 'run_metadata', metadata: { routing: { mode: 'smart' } } });
  broker.record(c, { type: 'run_end', status: 'incomplete', errorCategory: 'quota' });
  // Old run history did not always include routing. Its saved queue still carries explicit authority.
  broker.record(c, { type: 'queue_add', item: { id: 'old-queue', text: 'Hello', provider: 'codex', routing: { mode: 'smart' } } });
  await broker.close(); const reopened = env.open(), saved = reopened.get(c.id);
  assert.equal(reopened.execution.defaults(saved).mode, 'normal');
  const policy = reopened.execution.current(saved, saved.queue[0].execution.taskId);
  assert.equal(policy.mode, 'flow'); assert.equal(policy.authorization.source, 'legacy-queue');
  assert(saved.queuePaused);
});

test('desktop and encrypted phone API share revision checks, policy state and takeover', { skip: scriptCLIs }, async t => {
  const env = setup(t); await env.broker.close();
  const app = createRelayServer({ workspace: env.workspace, dataRoot: path.join(env.root, 'app'), bins: env.bins });
  env.addCloser(() => app.close({ force: true })); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const project = app.registry.list()[0], c = app.registry.mainConversation(project.id), id = c.id, broker = app.registry.broker(project.id);
  const post = async (action, body) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/conversations/${id}/${action}?projectId=${project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await post('routing', { mode: 'smart' })).status, 409);
  assert.equal((await post('routing', { mode: 'smart', executionRevision: 0 })).status, 200);
  assert.equal((await post('routing', { mode: null, executionRevision: 0 })).status, 409);
  broker.start(broker.get(id), routed('Hold')); const run = broker.running; await until(() => env.captures().length === 1);
  assert(phoneRemotePath('POST', `/api/conversations/${id}/execution-policy`));
  const remote = await phoneRemoteRequest({ handle: (req, res) => app.server.emit('request', req, res), local: () => ({ port: app.server.address().port }) }, { method: 'POST', path: `/api/conversations/${id}/execution-policy?projectId=${project.id}`, body: { taskId: run.taskId, revision: 1, action: 'takeover' } });
  assert.equal(remote.status, 200); assert.equal(remote.body.execution.active.mode, 'normal'); assert.equal(broker.running, run);
  const stale = await post('messages', { ...routed('Stale tab'), executionRevision: 1 }); assert.equal(stale.status, 409);
  env.release(); await run.done; assert.equal(env.captures().length, 1);
});

test('pausing an accepted queued prompt during checkpoint preparation prevents its provider start', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; const gate = deferred();
  broker.checkpoints.before = () => gate.promise;
  broker.queueAction(c, { action: 'add', text: 'Hello', provider: 'codex' });
  const run = broker.running; assert(run);
  broker.queue.pause(c, 'Paused before native startup'); gate.resolve(); await run.done;
  assert.equal(env.captures().length, 0);
});

test('Flow restrictions can disable discretionary retry and review independently', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env;
  broker.execution.setDefault(c, { mode: 'flow', automation: { retry: false, review: false } });
  broker.start(c, routed('Hello')); const run = broker.running; await run.done;
  run.routing.escalation = { provider: 'claude', model: 'sonnet' };
  await broker.checks.failed(c, run, { command: 'npm test' }, { exitCode: 1, output: 'failed' });
  assert.equal(env.captures().length, 1); assert(c.retryOffer, 'The person may still accept an explicit retry.');
  assert.equal(await broker.checks.reviewUltra(c, run), false);
});

test('a pinned Flow override uses exactly the authorized provider, model and effort without an assessor', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env;
  broker.execution.setDefault(c, { mode: 'flow', routingMode: 'smart', override: { scope: 'pinned', provider: 'codex', model: 'chosen', effort: 'low' } });
  broker.router.candidates = async () => [{ provider: 'codex', models: [], usage, readAt: Date.now(), account: { authenticated: true, billingSource: 'subscription' }, billingSource: 'subscription' }];
  broker.router.rows = () => [{ provider: 'codex', models: [], usage, readAt: Date.now(), account: { authenticated: true, billingSource: 'subscription' }, billingSource: 'subscription' }];
  broker.router.worker = () => { throw Error('An override must not spend allowance on assessment.'); };
  const sent = await broker.dispatch(c, routed('Repair the concurrent queue')); await broker.running.done;
  assert.deepEqual([sent.provider, sent.model, sent.effort], ['codex', 'chosen', 'low']);
  assert.equal(env.captures().length, 1);
});

test('a Plan review routed on Auto prefers an agent that didn’t build what it checks, and falls back when none can take it (#89)', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; flow(broker, c);
  const row = provider => ({ provider, models: [], usage, readAt: Date.now(), account: { authenticated: true, billingSource: 'subscription' }, billingSource: 'subscription' });
  let rows = [row('codex'), row('claude')];
  broker.router.candidates = async () => rows; broker.router.rows = () => rows;
  // Ranking is routing's own business: here it simply takes the first agent offered, so only the avoiding is tested.
  const route = globalThis.relayRouting.route;
  globalThis.relayRouting.route = ({ candidates, mode, assessment }) => candidates.length ? { provider: candidates[0].provider, model: null, effort: null, mode, tier: assessment.tier, reason: 'First offered', quota: { state: 'ok' } } : { error: 'Nothing to route to.' };
  t.after(() => { globalThis.relayRouting.route = route; });
  const review = (avoid, requestId) => ({ text: 'Review the changes', provider: 'codex', routing: { mode: 'smart', planned: 'standard', ...(avoid ? { avoid } : {}) }, mode: 'edit', requestId });
  const free = await broker.dispatch(c, review(null, 'free')); await broker.running.done;
  assert.equal(free.provider, 'codex');
  // A review of work Codex built goes to Claude.
  const avoided = await broker.dispatch(c, review(['codex'], 'avoid')); await broker.running.done;
  assert.equal(avoided.provider, 'claude');
  // With only the builder's agent connected, the review still runs on it.
  rows = [row('codex')];
  const only = await broker.dispatch(c, review(['codex'], 'only')); await broker.running.done;
  assert.equal(only.provider, 'codex');
});

test('takeover while queue routing awaits a model lookup leaves the queued ownership unchanged', { skip: scriptCLIs }, async t => {
  const env = setup(t), { broker, c } = env; flow(broker, c);
  broker.start(c, routed('Hold')); const run = broker.running; await until(() => env.captures().length === 1);
  broker.queueAction(c, { action: 'add', text: 'Then document it', provider: 'codex', routing: { mode: 'smart' } });
  const gate = deferred(); const moving = broker.queue.move(c, { from: 'codex', to: { provider: 'claude', model: 'sonnet', billingSource: 'subscription' }, choose: () => gate.promise, verifyExecution: () => broker.execution.assert(c, run.execution, { action: 'handoff' }) });
  const revoked = assert.rejects(moving, /revoked/); env.takeover(); gate.resolve({ model: 'sonnet' }); await revoked;
  assert.equal(c.queue[0].provider, 'codex'); assert.equal(c.queue.length, 1);
  env.release(); await run.done;
});

test('a task started automatically for a split needs its parent to be in Flow, and records the parent whose limits it shares', { skip: scriptCLIs }, async t => {
  const { broker, c } = setup(t);
  broker.start(c, { text: 'Hello', provider: 'codex' }); await broker.running.done;
  const taskId = c.lastRun.taskId;
  const input = { text: 'Child', requestId: 'child', provider: 'codex', folderId: broker.workspaceFolders[0].id, parent: { taskId, execution: broker.execution.token(c, taskId), automatic: true } };
  assert.throws(() => broker.tasks.start(c, input), /Normal/);
  assert.throws(() => broker.tasks.start(c, { ...input, parent: { taskId, execution: { taskId: 'another', revision: 1 }, automatic: true } }), /parent execution policy/);
  assert.equal(c.parallelTasks, undefined);
  broker.execution.change(c, { taskId, revision: 1, policy: { mode: 'flow' } });
  broker.tasks.tick = () => {};
  const task = broker.tasks.start(c, { ...input, parent: { taskId, execution: broker.execution.token(c, taskId), automatic: true } });
  assert.equal(c.parallelTasks.find(item => item.id === task.id).parentTaskId, taskId);
});

test('a direct task caller cannot supply an internal queue token to bypass Normal authority', async t => {
  const { broker, c } = setup(t);
  broker.execution.ensure(c, 'other-task', { config: { mode: 'flow' } });
  assert.throws(() => broker.tasks.start(c, { ...routed('Hello'), requestId: 'forged-queue-token', folderId: broker.workspaceFolders[0].id, queueExecution: broker.execution.token(c, 'other-task') }), /Normal/);
  assert.equal(broker.running, null); assert.equal(c.parallelTasks, undefined);
});


test('a background-review caller cannot replace the active task authority with a supplied token', { skip: scriptCLIs }, async t => {
  const { broker, c } = setup(t);
  broker.execution.setDefault(c, { mode: 'normal', allowedProviders: ['codex'] });
  broker.start(c, { text: 'Hello', provider: 'codex' }); await broker.running.done;
  broker.execution.ensure(c, 'other-policy', { config: { mode: 'flow' } });
  const jobs = new ReviewJobs();
  assert.throws(() => jobs.start({ id: 'project' }, broker, c, { provider: 'claude', model: 'sonnet' }, { requestId: 'forged-review', execution: broker.execution.token(c, 'other-policy'), executionAction: 'sequence' }), /outside/);
  assert.equal(jobs.jobs.size, 0);
});

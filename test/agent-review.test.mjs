import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { scriptCLIs, noSymlinks } from './platform.mjs';
import { captureReview, parseReviewResult, reviewFreshness, reviewPrompt } from '../src/agent-review.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';
import { createRelayServer } from '../src/server.mjs';
import { ConversationImporter } from '../src/conversation-import.mjs';
import { continuationRequest } from '../src/context.mjs';
import { readLedger } from '../src/task-ledger.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-review-')), workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const git = (...args) => { const result = spawnSync(gitExecutable(), args, { cwd: workspace, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(workspace, 'app.js'), 'export const value = 1;\n'); git('add', '.'); git('commit', '-qm', 'Initial');
  fs.writeFileSync(path.join(workspace, 'app.js'), 'export const value = 2;\n');
  const capture = path.join(root, 'captures.jsonl'), configuration = path.join(root, 'scenario.json'); fs.writeFileSync(configuration, '{}');
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, provider + '.mjs');
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport fs from 'node:fs';
if(process.argv.includes('--version')){console.log('mock 1');process.exit(0);}
if(process.argv[2]==='auth'){const scenario=JSON.parse(fs.readFileSync(${JSON.stringify(configuration)},'utf8'));console.log(JSON.stringify({loggedIn:true,authMethod:scenario.authMethod??'api_key'}));process.exit(0);}
let prompt='';for await(const part of process.stdin)prompt+=part;
const payload=JSON.parse(prompt.split('\\n').at(-1)),scenario=JSON.parse(fs.readFileSync(${JSON.stringify(configuration)},'utf8'));
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({provider:${JSON.stringify(provider)},args:process.argv.slice(2),payload})+'\\n');
const output=scenario.output??JSON.stringify({summary:'One actionable finding.',findings:[{severity:'medium',title:'Check the return value',detail:'The changed value breaks the documented contract.',fileId:payload.files[0].id,line:1}]});
const emit=value=>console.log(JSON.stringify(value));
if(${JSON.stringify(provider)}==='codex'){
emit({type:'thread.started',thread_id:'review-only-session'});
emit({type:'item.completed',item:{id:'answer',type:'agent_message',text:output}});
if(scenario.hang)setInterval(()=>{},1000);else if(scenario.fail){emit({type:'turn.failed',error:{message:'Usage limit reached'}});process.exitCode=1;}else emit({type:'turn.completed'});
}else{
emit({type:'system',subtype:'init',session_id:'review-only-session'});
emit({type:'assistant',message:{id:'answer',content:[{type:'text',text:output}]}});
if(scenario.hang)setInterval(()=>{},1000);else emit({type:'result',subtype:scenario.fail?'error_max_turns':'success',session_id:'review-only-session',result:output,is_error:!!scenario.fail});
}
`, { mode: 0o700 });
  }
  const apps = [];
  const launch = async (accessToken) => { const app = createRelayServer({ workspace, dataRoot: path.join(root, 'history'), bins, accessToken }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); apps.push(app); return app; };
  t.after(async () => { for (const app of apps) await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, git, bins, launch, scenario: value => fs.writeFileSync(configuration, JSON.stringify(value)), captures: () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [] };
}
function client(app, token) {
  const project = app.registry.list()[0], broker = app.registry.broker(project.id), c = broker.get(app.registry.mainConversation(project.id).id);
  const request = async (route, input, headers = {}) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/reviews${route}?projectId=${project.id}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1', ...(token ? { 'X-AI-Relay-Token': token } : {}), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, body: await response.json() }; };
  const files = [{ folderId: project.folders[0].id, path: 'app.js' }];
  const preview = async () => { const result = await request('/preview', { files }); assert.equal(result.status, 200); return result.body.snapshot; };
  return { request, project, broker, c, files, preview };
}

test('background reviews read approved copies while the builder continues, retry idempotently and stop independently', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  f.scenario({ hang: true });
  const snapshot = await api.preview(), input = { files: api.files, goal: 'Review the approved version', approvedDigest: snapshot.digest, requestId: 'background-review', background: true };
  const result = await api.request('/start', input); assert.equal(result.status, 202);
  const job = api.broker.backgroundReview; assert(job); assert.equal(api.broker.running, null); assert.equal(api.c.status, 'idle');
  assert.notEqual(job.worker.workspace, fs.realpathSync(f.workspace)); assert.equal(fs.readFileSync(path.join(job.worker.workspace, 'app.js'), 'utf8'), 'export const value = 2;\n');
  // The reviewer starts in its own process; under a busy full test run that can take more than a second.
  for (let i = 0; i < 1000 && !f.captures().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(f.captures().length);
  fs.writeFileSync(path.join(f.workspace, 'app.js'), 'export const value = 3;\n');
  assert.equal(fs.readFileSync(path.join(job.worker.workspace, 'app.js'), 'utf8'), 'export const value = 2;\n');
  f.scenario({ output: 'Builder continued with its next task.' });
  api.broker.start(api.c, { text: 'Work on the next task', provider: 'codex', requestId: 'builder-next' }); await api.broker.running.done;
  assert.equal(api.c.status, 'complete'); assert.equal(api.c.reviews[0].status, 'running'); const lastRun = api.c.lastRun.id;
  const duplicate = await api.request('/start', input); assert.equal(duplicate.status, 202); assert.equal(duplicate.body.reviewId, result.body.reviewId); assert.equal(duplicate.body.duplicate, true);
  assert.equal((await api.request('/start', { ...input, goal: 'Different task' })).status, 409);
  assert.equal((await api.request('/' + result.body.reviewId)).body.stale, true);
  assert.equal((await api.request('/' + result.body.reviewId + '/stop', {})).status, 200); await job.done;
  assert.equal(api.c.reviews[0].status, 'interrupted'); assert.equal(api.c.lastRun.id, lastRun); assert.equal(api.c.status, 'complete'); assert(!fs.existsSync(job.directory));
});

test('background review tokens stop the worker against its parent budget and release its reservation', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  api.broker.start(api.c, { text: 'Build', provider: 'codex', requestId: 'build' });
  // Give this mock builder a complete zero-token reading so the review can test the remaining allowance.
  api.broker.record(api.c, { type: 'run_metadata', metadata: { usage: { input_tokens: 0, output_tokens: 0 } } });
  await api.broker.running.done;
  const taskId = api.c.lastRun.taskId;
  api.broker.budget.setPolicy(api.c, { maxTokens: 100 });
  f.scenario({ hang: true });
  const snapshot = await api.preview(), input = { files: api.files, goal: 'Review', approvedDigest: snapshot.digest, requestId: 'limited-review', background: true };
  assert.equal((await api.request('/start', input)).status, 202);
  const job = api.broker.backgroundReview;
  for (let i = 0; i < 1000 && f.captures().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.captures().length, 2);
  assert.equal(job.worker.budget.remainingSpend(job.conversation, 'anything'), null);
  assert.throws(() => api.broker.start(api.c, { text: continuationRequest, provider: 'codex', requestId: 'carry-on' }), /allowance is reserved/);
  const duplicate = await api.request('/start', input); assert.equal(duplicate.body.duplicate, true);
  job.worker.message(job.conversation, 'activity', '$ node --test\nOne test passed.', 'claude');
  job.worker.event(job.worker.running, { type: 'relay.progress', phase: 'compacting' });
  job.worker.record(job.conversation, { type: 'run_metadata', metadata: { usage: { input_tokens: 110, output_tokens: 10, partial: true } } });
  await job.done;
  const saved = api.c.taskBudgets[taskId];
  assert.equal(saved.stopped.kind, 'maxTokens'); assert.equal(saved.tokens.input + saved.tokens.output, 120);
  assert.equal(saved.reviews, 1); assert.equal(Object.keys(saved.active).length, 0);
  assert.equal(api.c.reviews[0].errorCategory, 'budget'); assert.equal(api.c.reviews[0].status, 'interrupted');
  assert.equal(api.broker.budget.watches.size, 0); assert.equal(api.broker.budget.timers.size, 0);
  assert.equal(fs.existsSync(job.directory), false);
  const ledger = await readLedger(path.join(api.broker.dataDir, `${api.c.id}.jsonl`));
  assert.equal(ledger.tasks.find(task => task.id === taskId).usage.input, 110);
  assert.equal(ledger.runs.find(run => run.relation === 'review').tools.commands, 1, 'The worker journal was deleted, but its tool accounting stays.');
  assert.equal(ledger.runs.find(run => run.relation === 'review').compactionEvents.length, 1, 'The reviewer compaction observation survives cleanup too.');
  assert.throws(() => api.broker.start(api.c, { text: continuationRequest, provider: 'codex', requestId: 'retry-over-limit' }), /used 120 tokens/);
  api.broker.budget.extend(api.c, { taskId, limit: 'maxTokens' });
  assert.throws(() => api.broker.start(api.c, { text: continuationRequest, provider: 'codex', requestId: 'still-partial' }), /complete token usage/, 'Increasing the cap cannot fill in an interrupted partial usage report.');
  api.broker.budget.setPolicy(api.c, { maxTokens: null });
  f.scenario({}); api.broker.start(api.c, { text: continuationRequest, provider: 'codex', requestId: 'allowed-more' }); await api.broker.running.done;
  assert.equal(api.c.lastRun.taskId, taskId);
});

test('a quiet background review shares its parent deadline, including policy changes during work', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  api.broker.start(api.c, { text: 'Build', provider: 'codex', requestId: 'build' }); await api.broker.running.done;
  f.scenario({ hang: true });
  const snapshot = await api.preview();
  assert.equal((await api.request('/start', { files: api.files, goal: 'Review', approvedDigest: snapshot.digest, requestId: 'deadline-review', background: true })).status, 202);
  const job = api.broker.backgroundReview, taskId = api.c.lastRun.taskId;
  for (let i = 0; i < 1000 && f.captures().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.captures().length, 2);
  const used = api.broker.budget.used(api.c.taskBudgets[taskId]).workingMs;
  api.broker.budget.setPolicy(api.c, { maxWorkingMinutes: (used + 200) / 60000 });
  await Promise.race([job.done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Shared deadline did not stop review')), 5000); timer.unref(); })]);
  assert.equal(api.c.reviews[0].errorCategory, 'budget'); assert.equal(api.c.taskBudgets[taskId].stopped.kind, 'maxWorkingMinutes');
  assert.equal(api.broker.budget.watches.size, 0);
});

test('background and foreground reviews share workspace concurrency slots with builder tasks', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  api.broker.budget.setPolicy(api.c, { maxConcurrent: 1 });
  f.scenario({ hang: true });
  const snapshot = await api.preview(), input = { files: api.files, goal: 'Review', approvedDigest: snapshot.digest, requestId: 'slot-review', background: true };
  assert.equal((await api.request('/start', input)).status, 202);
  const job = api.broker.backgroundReview;
  assert.throws(() => api.broker.start(api.c, { text: 'New independent task', provider: 'codex', requestId: 'new' }), /already running/);
  assert.equal((await api.request('/start', { ...input, requestId: 'foreground', background: false })).status, 409);
  assert.equal(api.broker.tasks.activeWorkers, 1);
  assert.equal((await api.request('/' + api.c.reviews[0].id + '/stop', {})).status, 200); await job.done;
  assert.equal(api.broker.tasks.activeWorkers, 0);
  f.scenario({}); api.broker.start(api.c, { text: 'New independent task', provider: 'codex', requestId: 'new' }); await api.broker.running.done;
});

test('a task reviews only its own folder, saves the review with the task and counts as one more agent at once', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), project = app.registry.list()[0];
  // A second repository in the workspace, with a change of its own that the task's review must not reach.
  const other = path.join(f.root, 'other'); fs.mkdirSync(other);
  const run = (...args) => assert.equal(spawnSync(gitExecutable(), args, { cwd: other, encoding: 'utf8' }).status, 0);
  run('init', '-q'); run('config', 'user.name', 'Fixture'); run('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(other, 'b.js'), 'export const b = 1;\n'); run('add', '.'); run('commit', '-qm', 'Initial'); fs.writeFileSync(path.join(other, 'b.js'), 'export const b = 2;\n');
  app.registry.addFolder(project.id, other);
  const folders = app.registry.get(project.id).folders, mine = folders.find(item => item.path === fs.realpathSync(f.workspace)) || folders[0], theirs = folders.find(item => item !== mine);
  const broker = app.registry.broker(project.id), home = broker.get(app.registry.mainConversation(project.id).id);
  const call = async (route, input, task) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/reviews${route}?projectId=${project.id}${task ? `&task=${task}` : ''}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, body: await response.json() }; };
  f.scenario({ output: 'Changed the value.' });
  const task = broker.tasks.start(home, { text: 'Change the value in the task', folderId: mine.id, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'task-build' });
  for (let i = 0; i < 1500 && broker.tasks.find(home, task.id).status !== 'complete'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(broker.tasks.find(home, task.id).status, 'complete');
  const lane = broker.tasks.lanes.get(task.id);
  // The task's review lists only its folder and starts from what the task was asked to do.
  const listed = await call('', undefined, task.id);
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.repositories.map(repo => repo.folderId), [mine.id]);
  assert.equal(listed.body.goal, 'Change the value in the task'); assert.equal(listed.body.task.id, task.id); assert.equal(listed.body.task.mode, 'direct');
  assert.equal((await call('/preview', { files: [{ folderId: theirs.id, path: 'b.js' }] }, task.id)).status, 409, 'Another folder is out of the task’s reach.');
  assert.equal((await call('/automatic/preview', {}, task.id)).status, 409);
  assert.equal((await call('', undefined, '00000000-0000-4000-8000-000000000000')).status, 404);
  f.scenario({ hang: true });
  const files = [{ folderId: mine.id, path: 'app.js' }], snapshot = (await call('/preview', { files }, task.id)).body.snapshot;
  const input = { files, goal: 'Review the task', approvedDigest: snapshot.digest, requestId: 'task-review', background: true };
  assert.equal((await call('/start', { ...input, requestId: 'task-foreground', background: false }, task.id)).status, 400, 'A task’s review always reads a copy.');
  // With one agent allowed at once, a task's review waits its turn like any other.
  broker.budget.setPolicy(home, { maxConcurrent: 1 });
  broker.start(home, { text: 'Hold the workspace', provider: 'codex', requestId: 'main-hold' });
  assert.equal((await call('/start', input, task.id)).status, 409);
  await broker.running.done;
  const started = await call('/start', input, task.id);
  assert.equal(started.status, 202);
  assert.equal(lane.c.reviews[0].id, started.body.reviewId); assert.equal(lane.c.reviews[0].status, 'running');
  assert(!home.reviews.some(review => review.id === started.body.reviewId), 'The review is saved with the task, not the workspace chat.');
  assert.equal(broker.tasks.activeWorkers, 1);
  assert.throws(() => broker.start(home, { text: 'Another', provider: 'codex', requestId: 'blocked' }), /already running/);
  assert.equal((await call(`/${started.body.reviewId}`)).status, 404, 'The workspace chat doesn’t answer for the task’s review.');
  const job = lane.broker.backgroundReview;
  assert.equal((await call(`/${started.body.reviewId}/stop`, {}, task.id)).status, 200); await job.done;
  assert.equal(lane.c.reviews[0].status, 'interrupted'); assert.equal(broker.tasks.activeWorkers, 0);
});

for (const authMethod of ['api_key', 'unknown']) test(`a background review requires separate ${authMethod} billing consent`, { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  api.broker.start(api.c, { text: 'Build', provider: 'codex', requestId: 'build' }); await api.broker.running.done;
  const taskId = api.c.lastRun.taskId;
  api.broker.budget.setPolicy(api.c, { maxSpendUSD: 2 });
  // The environment override resolves only this fake CLI; removing the configured custom adapter enables the real account check.
  const previous = process.env.AI_RELAY_CLAUDE_BIN; process.env.AI_RELAY_CLAUDE_BIN = f.bins.claude;
  t.after(() => { if (previous === undefined) delete process.env.AI_RELAY_CLAUDE_BIN; else process.env.AI_RELAY_CLAUDE_BIN = previous; });
  delete api.broker.configuredBins.claude;
  f.scenario({ authMethod, hang: true });
  const snapshot = await api.preview(), input = { files: api.files, goal: 'Review', approvedDigest: snapshot.digest, requestId: 'unconfirmed', background: true };
  assert.equal((await api.request('/start', input)).status, 202);
  await api.broker.backgroundReview.done;
  assert.equal(api.c.reviews[0].errorCategory, 'permission'); assert.equal(f.captures().length, 1, 'Account probes did not launch a billed turn.');
  assert.equal(api.c.taskBudgets[taskId].reviews, 0, 'The refused reservation was returned.');
});

test('a running background review uses the remaining parent spend and stops on a reported overshoot', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  api.broker.start(api.c, { text: 'Build', provider: 'codex', requestId: 'build' }); await api.broker.running.done;
  const taskId = api.c.lastRun.taskId;
  api.broker.budget.setPolicy(api.c, { maxSpendUSD: 2 });
  // Earlier API work on this same task left $1.50. Journal records are used so the cap is durable.
  const snapshot = await api.preview();
  api.broker.record(api.c, { type: 'background_review', taskId, review: { id: 'earlier', requestId: 'earlier', snapshot, goal: 'Earlier review', provider: 'claude', background: true, status: 'running', findings: [] } });
  api.broker.record(api.c, { type: 'review_result', id: 'earlier', result: { status: 'complete', billingSource: 'api', costUSD: 0.5 } });
  f.scenario({ hang: true });
  const input = { files: api.files, goal: 'Review', approvedDigest: snapshot.digest, background: true };
  assert.equal((await api.request('/start', { ...input, requestId: 'confirmed', billingConfirmed: true })).status, 202);
  const job = api.broker.backgroundReview;
  for (let i = 0; i < 1000 && f.captures().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.captures().length, 2);
  assert.equal(job.worker.budget.remainingSpend(job.conversation, 'local-task-id'), 1.5);
  job.worker.record(job.conversation, { type: 'run_metadata', metadata: { account: { billingSource: 'api' }, costUSD: 2 } });
  await job.done;
  assert.equal(api.c.taskBudgets[taskId].spendUSD, 2.5);
  assert.equal(api.c.reviews[0].errorCategory, 'budget');
});

for (const builder of ['codex', 'claude']) test(`${builder} changes are reviewed by the other agent with fresh read-only state, saved findings and an explicit fix draft`, { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  api.broker.settings(api.c, { provider: builder, mode: 'edit', model: 'builder-model', effort: 'high' });
  api.broker.record(api.c, { type: 'session', provider: builder === 'codex' ? 'claude' : 'codex', id: 'previous-coding-session', workspaceSignature: api.broker.workspaceSignature });
  api.broker.message(api.c, 'assistant', 'BUILDER_CLAIMS_EVERYTHING_IS_PERFECT', builder);
  const settings = { provider: api.c.provider, mode: api.c.mode, model: api.c.model, effort: api.c.effort, sessions: structuredClone(api.c.sessions) };
  const snapshot = await api.preview(), input = { files: api.files, goal: 'Keep the public contract intact', approvedDigest: snapshot.digest, requestId: 'review-one' };
  const started = await api.request('/start', { ...input, mode: 'edit', provider: builder, fresh: false }); assert.equal(started.status, 202);
  const run = api.broker.running; assert.equal(run.provider, builder === 'codex' ? 'claude' : 'codex'); await run.done;
  assert.deepEqual({ provider: api.c.provider, mode: api.c.mode, model: api.c.model, effort: api.c.effort, sessions: api.c.sessions }, settings);
  const [capture] = f.captures(); assert(!capture.args.includes('--resume')); assert(!capture.args.includes('resume')); assert(!JSON.stringify(capture.payload).includes('BUILDER_CLAIMS'));
  assert(capture.args.includes(builder === 'codex' ? 'Read,Glob,Grep' : 'read-only'));
  const report = await api.request('/' + started.body.reviewId); assert.equal(report.body.status, 'complete'); assert.equal(report.body.stale, false); assert.equal(report.body.findings[0].path, 'app.js');
  assert.equal(report.body.snapshot.digest, snapshot.digest); assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'export const value = 2;\n');
  const fix = await api.request('/' + report.body.id + '/prepare-fix', { findingIds: ['1'] }); assert.equal(fix.status, 200); assert.equal(fix.body.provider, builder); assert.match(fix.body.text, /Check the return value/); assert.equal(f.captures().length, 1, 'Preparing fixes never starts an agent.');
  const retry = await api.request('/start', input); assert.equal(retry.body.runId, started.body.runId); assert.equal(retry.body.duplicate, true); assert.equal(f.captures().length, 1);
  await app.close(); const reopened = client(await f.launch()); assert.equal(reopened.c.reviews[0].findings.length, 1); assert.deepEqual(reopened.c.sessions, settings.sessions);
  fs.appendFileSync(path.join(f.workspace, 'app.js'), '// edited after review\n');
  assert.equal((await reopened.request('/' + report.body.id)).body.stale, true);
  assert.equal((await reopened.request('/' + report.body.id + '/prepare-fix', { findingIds: ['1'] })).status, 409);
});

test('previews bind exact selected bytes and Git base, including untracked content and deleted nested files', t => {
  const f = fixture(t), folders = [{ id: 'root', name: 'Project', path: f.workspace }];
  fs.mkdirSync(path.join(f.workspace, 'new')); fs.writeFileSync(path.join(f.workspace, 'new', 'file.js'), 'new content\n');
  const selection = [{ folderId: 'root', path: 'new/file.js' }], snapshot = captureReview(folders, selection), review = { snapshot };
  assert.match(snapshot.files[0].diff, /new content/);
  fs.writeFileSync(path.join(f.workspace, 'new', 'file.js'), 'different content\n');
  assert.notEqual(captureReview(folders, selection).digest, snapshot.digest); assert.equal(reviewFreshness(review, folders).stale, true);
  fs.writeFileSync(path.join(f.workspace, 'new', 'file.js'), 'new content\n');
  f.git('add', 'new/file.js'); f.git('commit', '-qm', 'Add file'); fs.rmSync(path.join(f.workspace, 'new'), { recursive: true });
  assert.equal(captureReview(folders, selection).files[0].contentHash, null);
  assert.equal(reviewFreshness(review, folders).stale, true, 'A changed Git base invalidates old findings even when a path becomes unavailable.');
});

test('review scope rejects private, foreign, binary, symlink, duplicate and oversized inputs, with literal Git paths', { skip: noSymlinks }, t => {
  const f = fixture(t), folders = [{ id: 'root', name: 'Project', path: f.workspace }], choose = name => [{ folderId: 'root', path: name }];
  for (const name of ['.env', 'binary.bin', 'literal[1].js']) fs.writeFileSync(path.join(f.workspace, name), name === 'binary.bin' ? Buffer.from([0, 1, 2]) : 'safe text\n');
  fs.writeFileSync(path.join(f.workspace, 'literal1.js'), 'must not appear\n');
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.workspace, 'link'));
  for (const selections of [choose('.env'), choose('../outside'), choose('link'), choose('binary.bin'), [...choose('app.js'), ...choose('app.js')], [{ folderId: 'foreign', path: 'app.js' }], Array.from({ length: 13 }, () => choose('app.js')[0])]) assert.throws(() => captureReview(folders, selections));
  assert(!captureReview(folders, choose('literal[1].js')).files[0].diff.includes('must not appear'));
  fs.writeFileSync(path.join(f.workspace, 'large.js'), 'x'.repeat(73000)); assert.throws(() => captureReview(folders, choose('large.js')), error => error.status === 413);
});

test('stale approval, busy workspaces and local-server access checks cannot start an extra review', async t => {
  const f = fixture(t), app = await f.launch('test-token'), api = client(app, 'test-token'), snapshot = await api.preview();
  const input = { files: api.files, approvedDigest: snapshot.digest, goal: 'Review the change' };
  assert.equal((await api.request('/start', input, { 'X-AI-Relay-Token': 'wrong' })).status, 403);
  assert.equal((await api.request('/start', input, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await api.request('/start', input, { 'X-AI-Relay': '0' })).status, 403);
  fs.appendFileSync(path.join(f.workspace, 'app.js'), '// new\n'); assert.equal((await api.request('/start', input)).status, 409); assert.equal(f.captures().length, 0);
  f.scenario({ hang: true }); input.approvedDigest = (await api.preview()).digest;
  const started = await api.request('/start', input); assert.equal(started.status, 202); const run = api.broker.running;
  assert.equal((await api.request('/start', { ...input, requestId: 'other' })).status, 409);
  api.broker.stop(api.c.id); await run.done; assert.equal(api.c.reviews[0].status, 'interrupted');
});

test('malformed or invalid findings and failed providers never become a clean review', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app), snapshot = await api.preview();
  for (const wrong of ['plain prose', '{"summary":"Fine"}', JSON.stringify({ summary: 'Fine', findings: [{ severity: 'high', title: 'Bad', detail: 'Bad', fileId: 'foreign', line: 1 }] }), JSON.stringify({ summary: 'Fine', findings: [{ severity: 'high', title: 'Bad', detail: 'Bad', fileId: snapshot.files[0].id, line: 999999 }] })]) assert.equal(parseReviewResult(wrong, snapshot).status, 'unstructured');
  for (const scenario of [{ output: 'I think it is fine.' }, { fail: true }]) {
    f.scenario(scenario); const started = await api.request('/start', { files: api.files, goal: 'Review this', approvedDigest: snapshot.digest }); assert.equal(started.status, 202); await api.broker.running.done;
    assert.equal(api.c.reviews[0].status, scenario.fail ? 'failed' : 'unstructured');
  }
});

test('review preparation never runs repository filters, diff drivers or hooks', { skip: scriptCLIs }, async t => {
  const f = fixture(t), marker = path.join(f.root, 'filter-ran');
  f.git('config', 'filter.fixture.clean', `touch '${marker}'; cat`);
  f.git('config', 'diff.fixture.command', `touch '${marker}'`);
  fs.writeFileSync(path.join(f.workspace, '.gitattributes'), '*.js filter=fixture diff=fixture\n');
  const app = await f.launch(), api = client(app), snapshot = await api.preview();
  const response = await api.request('/start', { files: api.files, approvedDigest: snapshot.digest, goal: 'Review safely' });
  assert.equal(response.status, 202); await api.broker.running.done;
  assert.equal(fs.existsSync(marker), false);
});

test('a mutation between preview validation and lease acquisition is rejected before recording or launching a review', async t => {
  const f = fixture(t), app = await f.launch(), api = client(app), snapshot = await api.preview();
  const acquire = api.broker.acquireMutation;
  let released = false;
  api.broker.acquireMutation = operation => { const lease = acquire(operation); fs.appendFileSync(path.join(f.workspace, 'app.js'), '// changed by another writer\n'); return { ...lease, release() { released = true; lease.release(); } }; };
  const response = await api.request('/start', { files: api.files, approvedDigest: snapshot.digest, goal: 'Review safely' });
  assert.equal(response.status, 409); assert.equal(released, true); assert.equal(api.c.reviews.length, 0); assert.equal(f.captures().length, 0);
});

test('a new review with a valid empty report is distinct from an unstructured response and cannot target another workspace', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app), snapshot = await api.preview();
  f.scenario({ output: '```json\n{"summary":"No actionable bugs found in the selected scope.","findings":[]}\n```' });
  const started = await api.request('/start', { files: api.files, approvedDigest: snapshot.digest, goal: 'Review this' }); await api.broker.running.done;
  assert.equal(api.c.reviews[0].status, 'complete'); assert.equal(api.c.reviews[0].findings.length, 0);
  const other = path.join(f.root, 'other'); fs.mkdirSync(other); const project = app.registry.add({ path: other });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/reviews/${started.body.reviewId}?projectId=${project.id}`);
  assert.equal(response.status, 404); assert.equal((await api.request('/' + started.body.reviewId + '/prepare-fix', { findingIds: ['1'] })).status, 400);
});

test('reviews before a first commit include current text beyond the staged version', t => {
  const f = fixture(t), workspace = path.join(f.root, 'new-repository'); fs.mkdirSync(workspace);
  const git = args => { const result = spawnSync(gitExecutable(), args, { cwd: workspace }); assert.equal(result.status, 0); };
  git(['init', '-q']); fs.writeFileSync(path.join(workspace, 'new.js'), 'staged version\n'); git(['add', '.']); fs.writeFileSync(path.join(workspace, 'new.js'), 'current version\n');
  const snapshot = captureReview([{ id: 'new', name: 'New', path: workspace }], [{ folderId: 'new', path: 'new.js' }]);
  assert.equal(snapshot.files[0].head, null); assert.match(snapshot.files[0].diff, /\+current version/); assert(!snapshot.files[0].diff.includes('+staged version'));
});

test('native review sessions stay excluded from previous-chat discovery', async t => {
  const f = fixture(t), folders = [{ id: 'root', name: 'Project', path: f.workspace }], snapshot = captureReview(folders, [{ folderId: 'root', path: 'app.js' }]);
  const importer = new ConversationImporter({ codexBin: () => '/mock/codex', clientFactory: () => ({ initialize: async () => {}, close() {}, request: async () => ({ data: [{ id: 'own-review', preview: reviewPrompt({ snapshot, goal: 'Review' }, {}), cwd: f.workspace, updatedAt: 1792000000 }, { id: 'external', preview: 'A real earlier conversation', cwd: f.workspace, updatedAt: 1792000001 }] }) }) });
  const listed = await importer.list('codex', folders); assert.deepEqual(listed.sessions.map(session => session.id), ['external']);
});

test('an editor changing a selected file during diff capture invalidates the preview', t => {
  const f = fixture(t), source = path.join(f.workspace, 'app.js'), inode = fs.statSync(source).ino, original = fs.readSync; let changed = false;
  fs.readSync = (...args) => { const count = original(...args); if (!changed && fs.fstatSync(args[0]).ino === inode) { changed = true; fs.appendFileSync(source, '// edited during preview\n'); } return count; };
  try { assert.throws(() => captureReview([{ id: 'root', name: 'Project', path: f.workspace }], [{ folderId: 'root', path: 'app.js' }]), error => error.status === 409); }
  finally { fs.readSync = original; }
});

test('native Codex reviews start a fresh read-only thread, reject command approval, and retain the coding session', { skip: scriptCLIs }, async t => {
  const f = fixture(t), protocol = path.join(f.root, 'native-protocol.jsonl');
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';
const emit=value=>console.log(JSON.stringify(value));let payload;
for await(const line of readline.createInterface({input:process.stdin})){
const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(protocol)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')emit({id:message.id,result:{userAgent:'mock'}});
else if(message.method==='thread/start')emit({id:message.id,result:{thread:{id:'fresh-review-thread'},model:'mock-model'}});
else if(message.method==='turn/start'){payload=JSON.parse(message.params.input[0].text.split('\\n').at(-1));emit({id:message.id,result:{turn:{id:'review-turn'}}});setTimeout(()=>emit({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'fresh-review-thread',turnId:'review-turn',command:'touch forbidden'}}),20);}
else if(message.id===900){emit({method:'item/completed',params:{threadId:'fresh-review-thread',item:{id:'answer',type:'agentMessage',text:JSON.stringify({summary:'No actionable issues found.',findings:[]})}}});emit({method:'turn/completed',params:{threadId:'fresh-review-thread',turn:{id:'review-turn',status:'completed'}}});}
}
`, { mode: 0o700 });
  const app = await f.launch(), api = client(app);
  api.broker.settings(api.c, { provider: 'codex', mode: 'edit', transport: 'app-server' });
  api.broker.record(api.c, { type: 'session', provider: 'codex', id: 'existing-coding-session', workspaceSignature: api.broker.workspaceSignature });
  api.broker.settings(api.c, { provider: 'claude', mode: 'edit', transport: 'cli' });
  const sessions = structuredClone(api.c.sessions), snapshot = await api.preview();
  const started = await api.request('/start', { files: api.files, approvedDigest: snapshot.digest, goal: 'Review via native Codex' }); assert.equal(started.status, 202); await api.broker.running.done;
  const messages = fs.readFileSync(protocol, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(messages.find(message => message.method === 'turn/start').params.sandboxPolicy.type, 'readOnly');
  assert.equal(messages.find(message => message.id === 900).result.decision, 'decline');
  assert(!messages.some(message => message.method === 'thread/resume')); assert.deepEqual(api.c.sessions, sessions); assert.equal(api.c.reviews[0].status, 'complete');
});

test('file mode and staging changes invalidate the captured Git scope even when file contents stay the same', { skip: process.platform === 'win32' && 'Windows files have no execute permission' }, t => {
  const f = fixture(t), folders = [{ id: 'root', name: 'Project', path: f.workspace }], files = [{ folderId: 'root', path: 'app.js' }];
  f.git('config', 'core.filemode', 'true'); const review = { snapshot: captureReview(folders, files) };
  fs.chmodSync(path.join(f.workspace, 'app.js'), 0o755); assert.equal(reviewFreshness(review, folders).stale, true);
  fs.chmodSync(path.join(f.workspace, 'app.js'), 0o644); assert.equal(reviewFreshness(review, folders).stale, false);
  f.git('add', 'app.js'); assert.equal(reviewFreshness(review, folders).stale, true);
});

test('a broker-ended review retains the protocol failure instead of claiming the user stopped it', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app), snapshot = await api.preview();
  f.scenario({ output: 'x'.repeat(9 * 1024 * 1024) });
  const started = await api.request('/start', { files: api.files, approvedDigest: snapshot.digest, goal: 'Review current changes' });
  assert.equal(started.status, 202); await api.broker.running.done;
  assert.equal(api.c.status, 'incomplete'); assert.equal(api.c.lastRun.errorCategory, 'protocol'); assert.equal(api.c.reviews[0].status, 'failed');
  const errors = api.c.messages.filter(message => message.role === 'error').map(message => message.text);
  assert.equal(errors.length, 1); assert.match(errors[0], /^Oversized provider protocol event\./); assert.doesNotMatch(errors[0], /JSON|Files already changed|Review stopped/);
});

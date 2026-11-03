import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRelayServer } from '../src/server.mjs';
import { createReviewRoutes } from '../src/agent-review-routes.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';
import { HandoffMonitor } from '../src/handoff.mjs';
import { scriptCLIs } from './platform.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = 'Automatic review did not settle') {
  const end = Date.now() + 20000;
  while (!predicate()) { if (Date.now() > end) assert.fail(message); await delay(10); }
}
const terminal = phase => phase && !['building', 'checking', 'capturing', 'reviewing'].includes(phase.status);

async function fixture(t, scenario = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-auto-flow-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const git = (...args) => { const result = spawnSync(gitExecutable(), args, { cwd: workspace, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(workspace, 'app.js'), 'export const value = 1;\n'); git('add', '.'); git('commit', '-qm', 'Initial');
  const configuration = path.join(root, 'scenario.json'), capture = path.join(root, 'captures.jsonl');
  fs.writeFileSync(configuration, JSON.stringify(scenario));
  const buildRelease = path.join(root, 'release-build'), reviewRelease = path.join(root, 'release-review'), bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, provider + '.mjs');
    fs.writeFileSync(bins[provider], `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
if(process.argv.includes('--version')){console.log('mock 1');process.exit(0);}
if(process.argv[2]==='auth'&&process.argv[3]==='status'){console.log(JSON.stringify({loggedIn:true,authMethod:'api-key'}));process.exit(0);}
let prompt='';for await(const part of process.stdin)prompt+=part;
const payload=JSON.parse(prompt.split('\\n').at(-1)),scenario=JSON.parse(fs.readFileSync(${JSON.stringify(configuration)},'utf8'));
const review=Array.isArray(payload.files),provider=${JSON.stringify(provider)};
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({provider,review,args:process.argv.slice(2),payload,cwd:process.cwd()})+'\\n');
if(!review)for(const [file,content]of Object.entries(scenario.write||{})){const target=path.join(process.cwd(),file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);}
if(review?scenario.holdReview:scenario.holdBuild)await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(review?${JSON.stringify(reviewRelease)}:${JSON.stringify(buildRelease)})){clearInterval(timer);resolve();}},10);});
const behavior=review?scenario.reviewBehavior:scenario.buildBehavior;
if(behavior==='hang')await new Promise(()=>setInterval(()=>{},1000));
const output=review?JSON.stringify({summary:scenario.findings?'Check the changed return value.':'No actionable issues.',findings:scenario.findings?[{severity:'medium',title:'Preserve the public contract',detail:'The new return value breaks the documented contract.',fileId:payload.files[0].id,line:1}]:[]}):'Completed the requested build.';
const emit=value=>console.log(JSON.stringify(value));
if(provider==='codex'){
emit({type:'thread.started',thread_id:review?'review-session':'build-session'});
emit({type:'item.completed',item:{id:'answer',type:'agent_message',text:output}});
if(behavior==='quota'||behavior==='failure'){emit({type:'turn.failed',error:{message:behavior==='quota'?'Usage limit reached':'Mock build failed'}});process.exitCode=1;}else emit({type:'turn.completed'});
}else{
emit({type:'system',subtype:'init',session_id:review?'review-session':'build-session'});
emit({type:'assistant',message:{id:'answer',content:[{type:'text',text:output}]}});
const failed=behavior==='quota'||behavior==='failure';
emit({type:'result',subtype:failed?'error_max_turns':'success',session_id:review?'review-session':'build-session',result:failed?(behavior==='quota'?'Usage limit reached':'Mock build failed'):output,is_error:failed});
}
`, { mode: 0o700 });
  }
  const apps = [];
  const open = async () => {
    const app = createRelayServer({ workspace, dataRoot: path.join(root, 'data'), bins });
    // Exercise the production routes without binding a socket; the process lifecycle is still real.
    const routes = createReviewRoutes({ registry: app.registry, body: async req => req.input, json: (res, status, body) => Object.assign(res, { status, body }) });
    const close = app.close.bind(app); app.close = async () => { await routes.close(); await close(); };
    apps.push(app);
    const project = app.registry.list()[0], broker = app.registry.broker(project.id), c = broker.get(app.registry.mainConversation(project.id).id);
    const request = async (route, input) => {
      const res = {};
      try { assert.equal(await routes({ req: { method: input === undefined ? 'GET' : 'POST', input }, res, url: new URL(`http://127.0.0.1/api/reviews${route}?projectId=${project.id}`) }), true); }
      catch (error) { Object.assign(res, { status: error.status || 500, body: { error: error.message } }); }
      return res;
    };
    const prepare = async (builder = 'codex', text = 'Update the public value', extra = {}) => {
      broker.settings(c, { provider: builder, mode: 'edit', model: 'builder-model' });
      const result = await request('/automatic/preview', { text, provider: builder, model: 'builder-model', mode: 'edit', approvalPolicy: 'ask', folderIds: [project.folders[0].id] });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const plan = result.body;
      return { text, provider: builder, model: 'builder-model', mode: 'edit', approvalPolicy: 'ask', automaticReview: { approvedDigest: plan.approvedDigest, reviewer: plan.reviewer, model: plan.model, folderIds: plan.folderIds, billingConfirmed: false }, ...extra };
    };
    return { app, project, broker, c, request, prepare };
  };
  t.after(async () => { for (const app of apps) await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const captures = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...(await open()), root, workspace, bins, open, captures, setScenario: value => fs.writeFileSync(configuration, JSON.stringify(value)), releaseBuild: () => fs.writeFileSync(buildRelease, ''), releaseReview: () => fs.writeFileSync(reviewRelease, '') };
}

for (const builder of ['codex', 'claude']) test(`automatic review hands ${builder} changes to the other agent once, preserves the brief and requires explicit fixes`, { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { write: { 'app.js': 'export const value = 2;\n' }, findings: true });
  f.broker.updateContext(f.c, { goal: 'Keep public APIs stable', summary: 'The return value is part of the public contract.' });
  const input = await f.prepare(builder, undefined, { requestId: 'one-approved-cycle' });
  const result = f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => terminal(f.c.runs[0].automaticReview));
  const phase = f.c.runs[0].automaticReview, review = f.c.reviews[0];
  assert.equal(phase.status, 'needs-fixes'); assert.equal(phase.reviewId, review.id); assert.equal(review.builderRunId, result.runId);
  assert.equal(review.builder, builder); assert.equal(review.provider, builder === 'codex' ? 'claude' : 'codex'); assert.equal(review.status, 'complete');
  assert.equal(f.c.provider, builder); assert.equal(f.c.model, 'builder-model'); assert.equal(f.c.mode, 'edit');
  const captures = f.captures(); assert.equal(captures.length, 2); assert.equal(captures[0].review, false); assert.equal(captures[1].review, true);
  assert.match(JSON.stringify(captures[1].payload.project), /Keep public APIs stable/); assert.match(JSON.stringify(captures[1].payload.project), /public contract/);
  assert.notEqual(captures[1].cwd, f.workspace); assert.match(captures[1].payload.files[0].diff, /\+export const value = 2/);
  assert(!captures[1].args.includes('--resume')); assert(!captures[1].args.includes('resume'));
  assert.equal(f.broker.start(f.c, input).duplicate, true); assert.equal(f.captures().length, 2, 'A repeated start does not launch another builder or review.');
  const fix = await f.request('/' + review.id + '/prepare-fix', { findingIds: ['1'] });
  assert.equal(fix.status, 200); assert.equal(fix.body.provider, builder); assert.match(fix.body.text, /Preserve the public contract/);
  assert.equal(f.captures().length, 2, 'Preparing a fix never starts it.');
  fs.appendFileSync(path.join(f.workspace, 'app.js'), '// later edits\n');
  assert.equal((await f.request('/' + review.id)).body.stale, true);
  assert.equal((await f.request('/' + review.id + '/prepare-fix', { findingIds: ['1'] })).status, 409);
  await f.app.close(); const reopened = await f.open();
  assert.equal(reopened.c.runs[0].automaticReview.status, 'needs-fixes'); assert.equal(reopened.c.reviews[0].id, review.id);
});

test('automatic review authorization rejects changed tasks and models before launching a builder', { skip: scriptCLIs }, async t => {
  const f = await fixture(t), input = await f.prepare();
  assert.throws(() => f.broker.start(f.c, { ...input, text: 'A materially different task' }), error => error.status === 409);
  assert.throws(() => f.broker.start(f.c, { ...input, model: 'another-builder-model' }), error => error.status === 409);
  const reviewer = input.automaticReview.reviewer;
  f.c.models[reviewer] = 'another-reviewer-model';
  assert.throws(() => f.broker.start(f.c, input), error => error.status === 409);
  assert.equal(f.c.runs.length, 0); assert.equal(f.captures().length, 0);
});

test('queued prompts wait for an automatic review and remain paused for the user afterwards', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { write: { 'app.js': 'export const value = 2;\n' }, holdReview: true });
  const input = await f.prepare(); f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => f.broker.backgroundReview && f.captures().some(capture => capture.review));
  const review = f.broker.backgroundReview;
  f.broker.queueAction(f.c, { action: 'add', text: 'Then document the public API', provider: 'codex', mode: 'edit' });
  await delay(40); assert.equal(f.broker.running, null); assert.equal(f.c.runs.length, 1); assert.equal(f.c.queue.length, 1);
  f.releaseReview(); await review.done;
  assert.equal(f.c.runs[0].automaticReview.status, 'complete'); assert(f.c.queuePaused, 'The queue waits for an explicit user decision after the cycle.');
  assert.equal(f.c.queue.length, 1); assert.equal(f.captures().length, 2);
});

test('failed, quota-limited and stopped builders never launch an automatic reviewer', { skip: scriptCLIs }, async t => {
  const f = await fixture(t);
  for (const behavior of ['failure', 'quota', 'hang']) {
    f.setScenario({ buildBehavior: behavior, write: { 'app.js': `export const value = '${behavior}';\n` } });
    const input = await f.prepare('codex', 'Try ' + behavior); f.broker.start(f.c, input); const run = f.broker.running;
    if (behavior === 'hang') { await until(() => f.captures().some(capture => capture.payload.currentRequest === input.text)); f.broker.stop(f.c.id); }
    await run.done; await until(() => terminal(f.c.runs.at(-1).automaticReview));
    assert(['blocked', 'interrupted'].includes(f.c.runs.at(-1).automaticReview.status));
    assert.equal(f.c.reviews.length, 0); assert.equal(f.broker.backgroundReview, undefined);
  }
  assert.equal(f.captures().filter(capture => capture.review).length, 0);
});

test('automatic scope skips an unchanged repository and refuses an over-budget partial review', { skip: scriptCLIs }, async t => {
  const f = await fixture(t); let input = await f.prepare(); f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => terminal(f.c.runs.at(-1).automaticReview));
  assert.equal(f.c.runs.at(-1).automaticReview.status, 'skipped'); assert.equal(f.c.reviews.length, 0);
  f.setScenario({ write: Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`file${index}.js`, 'export const value = 2;\n'])) });
  input = await f.prepare('codex', 'Change thirteen files'); f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => terminal(f.c.runs.at(-1).automaticReview));
  assert.equal(f.c.runs.at(-1).automaticReview.status, 'blocked'); assert.equal(f.c.reviews.length, 0);
  assert.match(f.c.runs.at(-1).automaticReview.summary, /12|limit/i);
});

test('automatic cycles wait for checks and stop after failing tests without starting a retry', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { write: { 'app.js': 'export const value = 2;\n' } });
  f.broker.setRouting(f.c, { mode: 'balanced', check: true });
  let finishTests, result = { status: 'failed', exitCode: 1, output: 'The public contract changed.' }, testCount = 0;
  f.broker.checks.tests = { saved: () => ({ command: 'npm test', directory: '' }), run() { testCount++; return { done: new Promise(resolve => { finishTests = resolve; }), view: () => result, stop: async () => finishTests() }; } };
  const input = await f.prepare('codex', 'Update with tests', { routing: { mode: 'balanced', reason: 'A focused build', tier: 'standard', escalation: { provider: 'codex', model: 'stronger-model', effort: 'high', tier: 'deep' } } });
  f.broker.start(f.c, input); await f.broker.running.done; await until(() => testCount === 1);
  assert.equal(f.c.reviews.length, 0); assert.equal(f.captures().length, 1);
  finishTests(); await until(() => terminal(f.c.runs[0].automaticReview));
  assert.equal(f.c.runs[0].automaticReview.status, 'blocked'); assert.equal(f.c.runs.length, 1); assert.equal(f.c.retryOffer, null); assert.equal(f.c.reviews.length, 0);
  result = { status: 'exited', exitCode: 0, output: 'All tests passed.' };
  f.setScenario({ write: { 'app.js': 'export const value = 3;\n' } });
  const second = await f.prepare('codex', 'Check the build again', { routing: { mode: 'balanced', reason: 'A focused build', tier: 'standard' } });
  f.broker.start(f.c, second); await f.broker.running.done;
  await until(() => testCount === 2); assert.equal(f.c.reviews.length, 0); finishTests();
  await until(() => terminal(f.c.runs.at(-1).automaticReview));
  assert.equal(f.c.runs.at(-1).automaticReview.status, 'complete'); assert.equal(f.c.reviews.length, 1);
});

test('a material note added during the build invalidates automatic review authorization', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { holdBuild: true, write: { 'app.js': 'export const value = 2;\n' } });
  const input = await f.prepare(); f.broker.start(f.c, input); const run = f.broker.running;
  await until(() => f.captures().length);
  run.steerable = true;
  const send = run.child.send.bind(run.child);
  run.child.send = (message, ...args) => {
    if (message.type !== 'steer') return send(message, ...args);
    queueMicrotask(() => run.steers.get(message.id)?.({ ok: true }));
  };
  const result = await f.broker.addToRun(f.c, { text: 'Actually change the public contract too.' });
  assert.equal(result.added, true); run.child.send = send;
  f.releaseBuild(); await run.done; await until(() => terminal(f.c.runs[0].automaticReview));
  assert.equal(f.c.runs[0].automaticReview.status, 'blocked'); assert.equal(f.c.reviews.length, 0);
});

test('reviewer failures and Stop finish the automatic phase without a fix run', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { write: { 'app.js': 'export const value = 2;\n' }, reviewBehavior: 'quota' });
  let input = await f.prepare(); f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => terminal(f.c.runs.at(-1).automaticReview));
  assert.equal(f.c.runs.at(-1).automaticReview.status, 'blocked'); assert.equal(f.c.reviews[0].status, 'failed');
  assert.equal(f.c.runs.length, 1); assert.equal(f.captures().length, 2);
  f.setScenario({ write: { 'app.js': 'export const value = 3;\n' }, holdReview: true });
  input = await f.prepare('codex', 'Build another version'); f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => f.broker.backgroundReview && f.captures().filter(capture => capture.review).length === 2);
  const job = f.broker.backgroundReview;
  assert.equal((await f.request('/' + job.id + '/stop', {})).status, 200); await job.done;
  await until(() => terminal(f.c.runs.at(-1).automaticReview));
  assert.equal(f.c.runs.at(-1).automaticReview.status, 'interrupted'); assert.equal(f.c.reviews[0].status, 'interrupted');
  assert.equal(f.c.runs.length, 2); assert.equal(f.captures().length, 4);
});

test('a provider ending with a pending approval cannot launch its automatic review', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { holdBuild: true, write: { 'app.js': 'export const value = 2;\n' } });
  const input = await f.prepare(); f.broker.start(f.c, input); const run = f.broker.running;
  await until(() => f.captures().length);
  run.child.emit('message', { type: 'approval', request: { id: 'pending-command', kind: 'Bash', command: 'npm test', title: 'Run the tests' } });
  assert.equal(run.approvals.size, 1); f.releaseBuild(); await run.done;
  await until(() => terminal(f.c.runs[0].automaticReview));
  assert.equal(f.c.runs[0].automaticReview.status, 'blocked'); assert.equal(f.c.reviews.length, 0);
});

test('restart marks an unfinished handoff interrupted instead of repeating its provider work', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { write: { 'app.js': 'export const value = 2;\n' } });
  const input = await f.prepare(); const started = f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => terminal(f.c.runs[0].automaticReview));
  assert.equal(f.c.runs[0].automaticReview.status, 'complete');
  // Recreate the durable point after review_result but before its automatic phase's completion append.
  f.broker.record(f.c, { type: 'automatic_review_phase', runId: started.runId, phase: { status: 'reviewing', summary: 'Reviewing captured changes.' } });
  await f.app.close(); const reopened = await f.open();
  assert.equal(reopened.c.runs[0].automaticReview.status, 'interrupted'); assert.equal(reopened.c.reviews[0].status, 'complete');
  assert.equal(reopened.broker.running, null); assert.equal(reopened.broker.backgroundReview, undefined);
  assert.equal(f.captures().length, 2, 'Recovery must not spend another build or review.');
});

test('a reviewer becoming unavailable blocks the handoff without choosing a different provider', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { holdBuild: true, write: { 'app.js': 'export const value = 2;\n' } });
  const input = await f.prepare(); f.broker.start(f.c, input); const run = f.broker.running;
  await until(() => f.captures().length); fs.rmSync(f.bins[input.automaticReview.reviewer]);
  f.releaseBuild(); await run.done;
  await until(() => terminal(f.c.runs[0].automaticReview));
  assert.equal(f.c.runs[0].automaticReview.status, 'blocked'); assert.equal(f.c.provider, 'codex');
  assert.equal(f.captures().length, 1); assert.equal(f.broker.backgroundReview, undefined);
});

test('a saved brief changed during the build checks needs new automatic review authorization', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { write: { 'app.js': 'export const value = 2;\n' } });
  f.broker.setRouting(f.c, { mode: 'balanced', check: true });
  let finishTests;
  f.broker.checks.tests = { saved: () => ({ command: 'npm test', directory: '' }), run() { return { done: new Promise(resolve => { finishTests = resolve; }), view: () => ({ status: 'exited', exitCode: 0, output: 'All tests passed.' }), stop: async () => finishTests() }; } };
  const input = await f.prepare('codex', 'Build under the current project brief', { routing: { mode: 'balanced', reason: 'A focused build', tier: 'standard' } });
  f.broker.start(f.c, input); await f.broker.running.done; await until(() => finishTests);
  f.broker.updateContext(f.c, { goal: 'A materially different project goal' }); finishTests();
  await until(() => terminal(f.c.runs[0].automaticReview));
  assert.equal(f.c.runs[0].automaticReview.status, 'blocked'); assert.equal(f.c.reviews.length, 0); assert.equal(f.captures().length, 1);
});

test('an automatic review cycle offers quota handoff instead of silently changing its builder', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { holdBuild: true, write: { 'app.js': 'export const value = 2;\n' } });
  f.broker.handoff.close();
  f.broker.handoff = new HandoffMonitor(f.broker, {
    usage: async provider => ({ available: true, windows: [{ usedPercent: provider === 'codex' ? 95 : 10 }] }),
    account: async () => ({ installed: true, authenticated: true, billingSource: 'subscription' }),
    preferences: () => ({ automatic: true, threshold: 90 }), firstCheckMs: 60000,
  });
  const input = await f.prepare(); f.broker.start(f.c, input); const run = f.broker.running;
  await until(() => f.captures().length); await f.broker.handoff.check(run);
  assert.equal(f.broker.running, run); assert.equal(run.stopped, false); assert.equal(f.c.handoffOffer?.to.provider, 'claude');
  assert.equal(f.c.runs.length, 1); assert.equal(f.captures().length, 1, 'No destination runs before the user accepts its changed builder.');
  f.broker.stop(f.c.id); await run.done;
  await until(() => terminal(f.c.runs[0].automaticReview)); assert.equal(f.c.runs[0].automaticReview.status, 'interrupted');
});

test('reviewer API billing still needs its own consent before the provider can consume usage', { skip: scriptCLIs }, async t => {
  const f = await fixture(t, { write: { 'app.js': 'export const value = 2;\n' } });
  const previous = process.env.AI_RELAY_CLAUDE_BIN;
  process.env.AI_RELAY_CLAUDE_BIN = f.bins.claude;
  t.after(() => { if (previous === undefined) delete process.env.AI_RELAY_CLAUDE_BIN; else process.env.AI_RELAY_CLAUDE_BIN = previous; });
  // Resolve the fake reviewer as a normal installed provider, rather than the test-only configured-bin bypass.
  delete f.broker.configuredBins.claude;
  const input = await f.prepare(); input.billingConfirmed = true;
  assert.equal(input.automaticReview.billingConfirmed, false);
  f.broker.start(f.c, input); await f.broker.running.done;
  await until(() => terminal(f.c.runs[0].automaticReview));
  assert.equal(f.c.runs[0].automaticReview.status, 'blocked'); assert.equal(f.c.reviews[0].status, 'failed');
  assert.match(f.c.reviews[0].summary, /billing|confirm/i); assert.equal(f.captures().length, 1, 'Builder consent never permits a paid reviewer run.');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { continuationRequest } from '../src/context.mjs';
import { applyBudgetRecord, assessQuota, classifyStep, defaultPolicy, validatePolicy } from '../src/task-budget.mjs';
import { ledgerFromRecords } from '../src/task-ledger.mjs';
import { scriptCLIs } from './platform.mjs';

// Two stand-in agents speaking Codex's protocol: what each does comes from the marker in its prompt, and each records its prompts.
function setup(t, policy = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-budget-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data'), prompts = path.join(root, 'prompts.jsonl'), bin = path.join(root, 'agent.mjs');
  fs.mkdirSync(workspace);
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('budget-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value)),threadId='t';
const finish=()=>{send({method:'item/completed',params:{threadId,item:{id:'a',type:'agentMessage',text:'Done'}}});send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});};
const fail=id=>send({method:'item/completed',params:{threadId,item:{id,type:'commandExecution',command:'npm test',exitCode:1,aggregatedOutput:'Error: the same failure at line 12\\nfailed'}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='model/list')send({id:m.id,result:{data:[]}});
if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:threadId},model:'fixture'}});
if(m.method==='turn/start'){const text=m.params.input[0].text,prompt=JSON.parse(text.slice(text.indexOf('\\n')+1)).currentRequest;fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(text)+'\\n');send({id:m.id,result:{turn:{id:'x'}}});
if(prompt.includes('RUN-HOLD'))return setInterval(()=>{},1000);
if(prompt.includes('RUN-TOKENS')){send({method:'thread/tokenUsage/updated',params:{threadId,tokenUsage:{total:{inputTokens:6000,cachedInputTokens:1000,outputTokens:500,reasoningOutputTokens:0}}}});return setInterval(()=>{},1000);}
if(prompt.includes('RUN-FAILS-ONCE')){fail('f1');return finish();}
if(prompt.includes('RUN-FAILS-TWICE')){fail('f1');fail('f2');return setInterval(()=>{},1000);}
finish();}
});
`, { mode: 0o700 });
  const claudeBin = path.join(root, 'claude.mjs');
  fs.writeFileSync(claudeBin, `#!${process.execPath}
import fs from 'node:fs';
if(process.argv.includes('--version')){console.log('budget-fixture 1');process.exit(0);}
let prompt='';for await(const part of process.stdin)prompt+=part;
fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(prompt)+'\\n');
const emit=value=>console.log(JSON.stringify(value));
emit({type:'assistant',message:{id:'step',content:[{type:'tool_use',id:'failure',name:'Bash',input:{command:'npm test'}}]}});
emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'failure',is_error:true,content:'Error: the same failure at line 12\\nfailed'}]}});
emit({type:'assistant',message:{id:'answer',content:[{type:'text',text:'Done'}]}});
emit({type:'result',subtype:'success',result:'Done'});
`, { mode: 0o700 });
  const brokers = [], bins = { codex: bin, claude: claudeBin, gemini: path.join(root, 'none') };
  const open = () => { const broker = new Broker({ workspace, dataDir, bins, handoffPreferences: () => ({ threshold: 0, automatic: false }) }); brokers.push(broker); return broker; };
  t.after(async () => { await Promise.all(brokers.map(broker => broker.close())); });
  const broker = open(), c = broker.get(broker.create().id);
  if (policy) broker.budget.setPolicy(c, policy);
  let count = 0;
  const start = (b, conv, text, extra = {}) => { b.start(conv, { text, provider: 'codex', transport: 'app-server', mode: 'edit', approvalPolicy: 'auto', requestId: `req-${++count}`, ...extra }); return b.running; };
  const prompt = () => fs.readFileSync(prompts, 'utf8').trim().split('\n').at(-1);
  return { root, broker, c, open, start, prompt, workspace, dataDir };
}
const refused = pattern => error => { assert.equal(error.status, 409); assert.equal(error.category, 'budget'); assert.match(error.message, pattern); assert(error.details.budget); return true; };
const state = (c, id) => c.taskBudgets[id || c.lastRun.taskId];

test('policies are checked, and the defaults limit loops but not time or tokens', () => {
  const policy = defaultPolicy();
  assert.deepEqual([policy.maxWorkingMinutes, policy.maxTokens, policy.maxSpendUSD, policy.allowedProviders], [null, null, null, null], 'Nothing stops an ordinary task unless asked for.');
  assert(policy.maxRepeatedFailures > 0 && policy.maxHandoffs > 0);
  assert.equal(validatePolicy({ maxTokens: 1000 }).maxTokens, 1000);
  assert.equal(validatePolicy({ maxTokens: null }, { ...policy, maxTokens: 5 }).maxTokens, null);
  for (const bad of [{ maxTokens: -1 }, { maxRetries: 1.5 }, { maxConcurrent: 0 }, { maxRepeatedFailures: 0 }, { allowedProviders: [] }, { allowedProviders: ['grok'] }, { allowedModels: { codex: [] } }]) assert.throws(() => validatePolicy(bad), JSON.stringify(bad));
});

test('each usage limit is judged on its own: room in the five-hour window does not make up for a full weekly one', () => {
  const now = Date.parse('2026-11-05T10:00:00Z'), reset = '2026-11-05T12:00:00Z', fetchedAt = now - 1000;
  const windows = (five, week, extra = {}) => ({ available: true, fetchedAt, windows: [{ label: '5-hour', usedPercent: five, resetsAt: reset }, { label: 'Weekly', usedPercent: week, resetsAt: reset }, ...(extra.rows || [])] });
  const weekly = assessQuota(windows(5, 100), null, { now });
  assert.equal(weekly.state, 'exhausted');
  assert.deepEqual(weekly.windows.map(row => [row.label, row.state]), [['5-hour', 'ok'], ['Weekly', 'exhausted']]);
  assert.equal(assessQuota(windows(95, 10), null, { now }).state, 'near');
  assert.equal(assessQuota(windows(10, 10), null, { now }).state, 'ok');
  const scoped = windows(10, 10, { rows: [{ label: 'Weekly · Opus', usedPercent: 100, resetsAt: reset, scope: 'opus' }] });
  assert.equal(assessQuota(scoped, 'claude-opus-5', { now }).state, 'exhausted');
  assert.equal(assessQuota(scoped, 'claude-haiku-5', { now }).state, 'ok', 'A limit for another model does not apply.');
  assert.equal(assessQuota({ ...windows(10, 10), fetchedAt: now - 3600000 }, null, { now }).state, 'stale', 'An old reading is not evidence of room.');
  assert.equal(assessQuota(windows(100, 10), null, { now: Date.parse(reset) + 1000 }).state, 'stale', 'A full window past its reset time needs reading again.');
  assert.equal(assessQuota({ available: false, reason: 'Not reported' }, null, { now }).state, 'unknown');
  assert.equal(assessQuota(null, null, { now }).state, 'unknown');
});

test('the same failure counts across a restart and a change of agent, and goes with the task to the next agent', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  await env.start(env.broker, env.c, 'RUN-FAILS-ONCE').done;
  const taskId = env.c.lastRun.taskId, [first] = Object.values(state(env.c, taskId).failures);
  assert.deepEqual([first.count, first.what, first.agents], [1, 'npm test', ['codex']]);
  // A restart: everything is read back from the journal.
  await env.broker.close();
  const reopened = env.open(), c = reopened.get(env.c.id);
  assert.equal(Object.values(state(c, taskId).failures)[0].count, 1, 'The restart kept it.');
  // A fresh agent carrying on, as after a handoff, adds to the same count.
  await env.start(reopened, c, continuationRequest, { provider: 'claude', transport: 'cli', fresh: true }).done;
  assert.equal(c.lastRun.taskId, taskId);
  assert.equal(c.lastRun.relation, 'continuation');
  assert.match(env.prompt(), /failedAttempts/);
  assert.match(env.prompt(), /task-record/);
  assert.match(env.prompt(), /npm test/);
  const [continued] = Object.values(state(c, taskId).failures);
  assert.equal(continued.count, 2);
  assert.deepEqual(continued.agents, ['codex', 'claude'], 'Restart and changing provider cannot reset the same-failure counter.');
});

test('a repeated failure stops the run with its reason, saves the checkpoint and frees the workspace, and only the person can allow more', { skip: scriptCLIs }, async t => {
  const env = setup(t, { maxRepeatedFailures: 2 }), notices = [];
  env.broker.on('notify', notice => notices.push(notice));
  const run = env.start(env.broker, env.c, 'RUN-FAILS-TWICE');
  await run.done;
  assert.equal(env.c.status, 'interrupted');
  assert.equal(env.c.lastRun.errorCategory, 'budget');
  assert.equal(env.broker.running, null, 'The worker and lease are released.');
  assert(env.c.messages.some(message => message.role === 'error' && /gone wrong 2 times in this task: npm test/.test(message.text) && /remain in the workspace/.test(message.text)));
  assert(notices.some(notice => notice.title === 'Task limit reached'));
  const taskId = env.c.lastRun.taskId;
  assert.deepEqual(state(env.c, taskId).stopped.kind, 'maxRepeatedFailures');
  // Carrying on with the same task is refused, and says it can be raised; a new prompt is a new task.
  assert.throws(() => env.start(env.broker, env.c, continuationRequest, { fresh: true }), refused(/gone wrong 2 times/));
  try { env.broker.start(env.c, { text: continuationRequest, provider: 'codex', transport: 'app-server', requestId: 'again' }); } catch (error) { assert.deepEqual([error.details.budget.limit, error.details.budget.canExtend], ['maxRepeatedFailures', true]); }
  await env.start(env.broker, env.c, 'Something else entirely').done;
  assert.equal(env.c.status, 'complete');
  const other = env.c.lastRun.taskId;
  assert.notEqual(other, taskId);
  assert.throws(() => env.broker.budget.extend(env.c, { taskId: 'gone', limit: 'maxRetries' }), /no longer tracked/);
  env.broker.budget.extend(env.c, { taskId, limit: 'maxRepeatedFailures' });
  assert.equal(env.broker.budget.limits(env.c, state(env.c, taskId)).maxRepeatedFailures, 5);
  assert.equal(state(env.c, taskId).stopped, null);
  assert.equal(env.broker.budget.limits(env.c, state(env.c, other)).maxRepeatedFailures, 2, 'Allowing more is for that task only.');
});

test('a token limit stops a run as soon as it is reported over, says what it really used, and the count survives a restart', { skip: scriptCLIs }, async t => {
  const env = setup(t, { maxTokens: 5000 }), run = env.start(env.broker, env.c, 'RUN-TOKENS');
  await run.done;
  const taskId = env.c.lastRun.taskId;
  assert.equal(env.c.lastRun.errorCategory, 'budget');
  assert(env.c.messages.some(message => message.role === 'error' && /used 5,500 tokens, over its limit of 5,000/.test(message.text)), 'The overshoot is reported, not hidden.');
  assert.deepEqual(state(env.c, taskId).tokens, { input: 5000, output: 500, cacheWrite: 0, cacheRead: 1000 }, 'Cached input is kept apart: it is not new work.');
  await env.broker.close();
  const c = env.open().get(env.c.id);
  assert.deepEqual(state(c, taskId).tokens.input, 5000);
});

test('a working-time limit stops a run on time, and nothing else stops a quiet one', { skip: scriptCLIs }, async t => {
  const env = setup(t, { maxWorkingMinutes: 0.01 }), run = env.start(env.broker, env.c, 'RUN-HOLD'), started = Date.now();
  await run.done;
  assert(Date.now() - started < 8000);
  assert.equal(env.c.lastRun.errorCategory, 'budget');
  assert(env.c.messages.some(message => /limit of 0.01 working minutes/.test(message.text)));
  const quiet = setup(t), held = quiet.start(quiet.broker, quiet.c, 'RUN-HOLD');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(quiet.broker.running, held, 'With no limit set, a run that says nothing is left to work.');
  quiet.broker.stop(quiet.c.id); await held.done;
  assert.notEqual(quiet.c.lastRun.errorCategory, 'budget');
});

test('agents and models outside the policy are refused for every run, and a refused handoff is never offered', { skip: scriptCLIs }, async t => {
  const env = setup(t, { allowedProviders: ['claude'] });
  assert.throws(() => env.start(env.broker, env.c, 'Hello'), refused(/Codex isn't allowed/));
  assert.equal(env.broker.running, null);
  assert.deepEqual(env.c.messages, [], 'Nothing was saved or started.');
  const models = setup(t, { allowedModels: { codex: ['small'] } });
  assert.throws(() => models.start(models.broker, models.c, 'Hello', { model: 'big' }), refused(/The model big isn't allowed/));
  assert.throws(() => models.start(models.broker, models.c, 'Hello'), refused(/default model isn't allowed/));
  await models.start(models.broker, models.c, 'Hello', { model: 'small' }).done;
  assert.equal(models.c.status, 'complete');
  assert.equal(env.broker.budget.refusal(env.c, { task: { id: 'x', relation: 'continuation' }, provider: 'codex', model: null, previousProvider: 'claude' }).limit, 'allowed', 'What handoff asks before it offers.');
  assert.equal(env.broker.budget.refusal(env.c, { task: { id: 'x', relation: 'continuation' }, provider: 'claude', model: null, previousProvider: 'codex' }), null);
});

test('counts are reserved when a run is saved, a run that never began gives its back, and an accepted request is not counted twice', { skip: scriptCLIs }, async t => {
  const env = setup(t, { maxHandoffs: 1 });
  await env.start(env.broker, env.c, 'First').done;
  const taskId = env.c.lastRun.taskId, c = env.c, broker = env.broker;
  const plan = { task: { id: taskId, relation: 'continuation' }, provider: 'claude', model: null };
  assert.equal(broker.budget.refusal(c, plan), null);
  // A handoff saved but gone before it began returns what it reserved.
  broker.record(c, { type: 'submission', id: 'never', task: { id: taskId, parentRunId: c.lastRun.id, relation: 'continuation' }, provider: 'claude', previousProvider: 'codex', message: { id: 'never-message', role: 'user', text: continuationRequest, provider: 'claude' }, requestId: 'never', mode: 'edit', model: null, context: {} });
  assert.equal(state(c, taskId).handoffs, 1);
  assert.equal(broker.budget.refusal(c, { ...plan, previousProvider: 'codex' }).limit, 'maxHandoffs', 'The reservation counts while it is out, so two can not take the last one.');
  broker.record(c, { type: 'run_end', status: 'incomplete' });
  assert.equal(state(c, taskId).handoffs, 0);
  assert.equal(broker.budget.refusal(c, { ...plan, previousProvider: 'codex' }), null);
  const runs = state(c, taskId).runs, again = broker.start(c, { text: 'First', provider: 'codex', transport: 'app-server', mode: 'edit', approvalPolicy: 'auto', requestId: c.runs.at(-1) ? 'req-1' : 'req-1' });
  assert.equal(again.duplicate, true);
  assert.equal(state(c, taskId).runs, runs, 'A request already accepted starts nothing and counts nothing, also after a restart.');
  await broker.close();
  const reopened = env.open();
  assert.equal(reopened.start(reopened.get(c.id), { text: 'First', provider: 'codex', transport: 'app-server', mode: 'edit', approvalPolicy: 'auto', requestId: 'req-1' }).duplicate, true);
});

test('retries and reviews meet their own limits, and at most so many agents work on a task at once', { skip: scriptCLIs }, async t => {
  const env = setup(t, { maxRetries: 0, maxReviews: 0 });
  await env.start(env.broker, env.c, 'First').done;
  const id = env.c.lastRun.id, taskId = env.c.lastRun.taskId;
  assert.equal(env.broker.budget.refusal(env.c, { task: { id: taskId, relation: 'retry', parentRunId: id }, provider: 'codex', model: null }).limit, 'maxRetries');
  assert.equal(env.broker.budget.refusal(env.c, { task: { id: taskId, relation: 'review' }, provider: 'codex', model: null }).limit, 'maxReviews');
  env.broker.budget.setPolicy(env.c, { maxConcurrent: 1 });
  state(env.c, taskId).active.other = { startedAt: new Date().toISOString(), usage: null };
  assert.equal(env.broker.budget.refusal(env.c, { task: { id: taskId, relation: 'continuation' }, provider: 'codex', model: null, previousProvider: 'codex' }).limit, 'maxConcurrent');
  delete state(env.c, taskId).active.other;
});

test('a reviewer running in the background counts toward its task', t => {
  const env = setup(t), { broker, c } = env;
  broker.record(c, { type: 'submission', id: 'build', task: { id: 'build', parentRunId: null, relation: null }, provider: 'codex', message: { id: 'm', role: 'user', text: 'Build' }, requestId: 'b', mode: 'edit', model: null, context: {} });
  broker.record(c, { type: 'run_metadata', metadata: { effectiveModel: 'x', usage: { input_tokens: 10, output_tokens: 1 } } });
  broker.record(c, { type: 'run_end', status: 'complete' });
  broker.record(c, { type: 'background_review', taskId: 'build', review: { id: 'rev', provider: 'claude', model: 'm', requestId: 'q', fingerprint: 'f', status: 'running', findings: [] } });
  assert.deepEqual([state(c, 'build').reviews, Object.keys(state(c, 'build').active)], [1, ['rev']]);
  broker.record(c, { type: 'review_result', id: 'rev', result: { status: 'complete', findings: [], usage: { input_tokens: 90, output_tokens: 9 } } });
  assert.deepEqual([state(c, 'build').tokens.input, state(c, 'build').tokens.output, Object.keys(state(c, 'build').active).length], [100, 10, 0]);
});

test('API spending only counts what is really billed per use, and a subscription dollar figure never does', t => {
  const env = setup(t), { broker, c } = env, run = (id, billing, costUSD) => { broker.record(c, { type: 'submission', id, task: { id: 'task', parentRunId: null, relation: null }, provider: 'claude', message: { id: `${id}-m`, role: 'user', text: 'x' }, requestId: id, mode: 'edit', model: null, context: {} }); broker.record(c, { type: 'run_metadata', metadata: { account: { billingSource: billing }, effectiveModel: 'm', usage: { input_tokens: 1, output_tokens: 1 }, costUSD } }); broker.record(c, { type: 'run_end', status: 'complete' }); };
  run('sub', 'subscription', 9); assert.equal(state(c, 'task').spendUSD, 0);
  run('api', 'api', 1.5); assert.equal(state(c, 'task').spendUSD, 1.5);
  broker.budget.setPolicy(c, { maxSpendUSD: 1 });
  assert.equal(broker.budget.exceeded(c, state(c, 'task')).limit, 'maxSpendUSD');
  assert.equal(broker.budget.remainingSpend(c, 'task'), 0);
});

test('steps are recognized by what they did, ignoring numbers and timings', () => {
  const a = classifyStep('$ npm test\nError: failed in 1.32s at line 12'), b = classifyStep('$ npm test\nError: failed in 9.08s at line 44'), c = classifyStep('$ npm test\nError: something else broke');
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
  assert.equal(classifyStep('$ npm test\nall good'), null);
  assert.equal(classifyStep('$ npm test\n'), null, 'A command still running says nothing yet.');
  assert.equal(classifyStep('Read\n{"file_path":"/a"}\nError in the file text'), null, 'Reading a file that mentions an error is not a failure.');
  assert.equal(classifyStep(`Bash\n${JSON.stringify({ command: 'make' })}\nfatal: no`).what, 'make');
  // The same failure from two agents, one wrapping the command in a shell.
  const claude = classifyStep(`Bash\n${JSON.stringify({ command: 'node check.mjs', description: 'Run it' })}\nError: the same failure`), codex = classifyStep(`$ /bin/zsh -lc 'node check.mjs'\nError: the same failure`);
  assert.equal(codex.what, 'node check.mjs');
  assert.equal(claude.signature, codex.signature);
  const edit = classifyStep(`Edit\n${JSON.stringify({ file_path: '/a.js', old_string: 'x', new_string: 'y' })}\nok`);
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.signature, classifyStep(`Edit\n${JSON.stringify({ file_path: '/a.js', old_string: 'x', new_string: 'y' })}`).signature);
});

test('the policy and counters stay out of each conversation update and out of what a resumed run is told', t => {
  const env = setup(t, { maxRetries: 1 }), view = env.broker.view(env.c);
  assert.equal(view.taskPolicy.maxRetries, 1, 'The page needs the policy to route within it.');
  for (const key of ['taskBudgets', 'taskOfRun', 'budgetActive', 'budgetTotals', 'quotaReadings']) assert.equal(key in view, false, key);
});

test('measured allowance is reserved once per task, released after cancellation and never consumed twice on replay', t => {
  for (const limit of ['maxTokens', 'maxSpendUSD', 'maxWorkingMinutes']) {
    const { broker, c } = setup(t, { [limit]: 100 });
    const reservation = { type: 'background_review', taskId: 'parent', review: { id: 'review', provider: 'claude', requestId: 'review', status: 'running', background: true } };
    broker.record(c, reservation);
    // A duplicate journal record must not allocate again (request retries normally return before writing one).
    applyBudgetRecord(c, reservation);
    assert.equal(state(c, 'parent').reviews, 1);
    const plan = { provider: 'claude', model: null, task: { id: 'parent', relation: 'review' } };
    assert.equal(broker.budget.refusal(c, plan).limit, 'reservation');
    assert.throws(() => broker.budget.assertCanStart(c, plan), error => error.details.budget.canExtend === false);
    assert.equal(broker.budget.refusal(c, { ...plan, task: { id: 'unrelated', relation: null } }), null);
    broker.record(c, { type: 'review_result', id: 'review', result: { status: 'failed', summary: 'Refused before launch' } });
    assert.deepEqual([state(c, 'parent').reviews, state(c, 'parent').runs, Object.keys(state(c, 'parent').active).length], [0, 0, 0]);
    assert.equal(broker.budget.refusal(c, plan), null, 'An unused reservation is returned.');
    applyBudgetRecord(c, reservation);
    assert.equal(state(c, 'parent').runs, 0, 'Replaying an old accepted ID cannot reopen a finished reservation.');
  }
});

test('review usage is live, replacement-based and preserved through restart even without a final report', async t => {
  const { broker, c, open } = setup(t, { maxTokens: 1000, maxSpendUSD: 5 });
  broker.record(c, { type: 'background_review', taskId: 'parent', parentRunId: 'build', review: { id: 'review', provider: 'claude', requestId: 'review', background: true, status: 'running' } });
  const sample = { type: 'review_budget', id: 'review', began: true, metadata: { account: { billingSource: 'api' }, usage: { input_tokens: 80, output_tokens: 20, partial: true }, costUSD: 0.5 } };
  broker.record(c, sample); broker.record(c, sample);
  assert.equal(broker.budget.view(c).task.taskId, 'parent', 'A review before any builder run still has visible task limits.');
  assert.deepEqual([broker.budget.used(state(c, 'parent')).tokens, broker.budget.remainingSpend(c, 'parent')], [100, 4.5]);
  await broker.close();
  const next = open(), restored = next.get(c.id), saved = state(restored, 'parent');
  assert.equal(restored.reviews[0].status, 'interrupted');
  assert.deepEqual([next.budget.used(saved).tokens, saved.spendUSD, saved.reviews, Object.keys(saved.active).length], [100, 0.5, 1, 0]);
  assert.equal(next.budget.refusal(restored, { task: { id: 'parent', relation: 'review' }, provider: 'claude' }), null);
  const ledger = ledgerFromRecords(fs.readFileSync(path.join(next.dataDir, `${c.id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(ledger.runs[0].taskId, 'parent'); assert.equal(ledger.runs[0].parentRunId, 'build');
  assert.equal(ledger.runs[0].usage.input, 80); assert.equal(ledger.runs[0].costEstimateUSD, 0.5);
});

test('a measured limit cannot promise one remaining allowance to two workers already on the same task', t => {
  const { broker, c } = setup(t);
  for (const id of ['one', 'two']) broker.record(c, { type: 'background_review', taskId: 'parent', review: { id, provider: 'claude', requestId: id, status: 'running' } });
  assert.throws(() => broker.budget.setPolicy(c, { maxSpendUSD: 5 }), /only one agent/);
  assert.equal(broker.budget.policy(c).maxSpendUSD, null, 'A refused policy leaves the previous one intact.');
  broker.budget.setPolicy(c, { maxHandoffs: 2 });
  assert.equal(broker.budget.policy(c).maxHandoffs, 2, 'Count-only changes remain available.');
  broker.record(c, { type: 'review_result', id: 'one', result: { status: 'failed' } });
  broker.budget.setPolicy(c, { maxSpendUSD: 5 });
  assert.equal(broker.budget.policy(c).maxSpendUSD, 5);
});

test('a partial and then final review sample replaces live usage and is charged exactly once', t => {
  const { broker, c } = setup(t);
  c.budgetTotals = { codex: { input: 9000, output: 1000 } };
  broker.record(c, { type: 'background_review', taskId: 'parent', review: { id: 'r', provider: 'codex', requestId: 'r', status: 'running' } });
  broker.record(c, { type: 'review_budget', id: 'r', began: true, metadata: { usage: { total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 20 } }, costUSD: 10, account: { billingSource: 'subscription' } } });
  assert.equal(broker.budget.used(state(c, 'parent')).tokens, 420);
  const result = { type: 'review_result', id: 'r', result: { status: 'complete', usage: { total: { inputTokens: 600, cachedInputTokens: 100, outputTokens: 30 } }, costUSD: 12, billingSource: 'subscription' } };
  broker.record(c, result); broker.record(c, result);
  assert.equal(broker.budget.used(state(c, 'parent')).tokens, 530);
  assert.equal(state(c, 'parent').spendUSD, 0);
  assert.deepEqual(c.budgetTotals.codex, { input: 9000, output: 1000 }, 'A fresh reviewer cannot change the builder’s session baseline.');
});

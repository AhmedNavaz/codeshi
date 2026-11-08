import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Broker } from '../src/broker.mjs';
import { assessmentPrompt, parseAssessment, runAssessmentWorker } from '../src/routing-assessment.mjs';
import { CodexClient, runClaude, runCodex } from '../src/providers.mjs';
import { scriptCLIs } from './platform.mjs';

const assessment = { tier: 'deep', effort: 'high', reason: 'Continue the cross-module repair and verify its correctness.' };
const usage = (used = 10) => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: used, resetsAt: new Date(Date.now() + 3600000).toISOString() }] });
const models = [{ id: 'gpt-codex', displayName: 'Codex', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }, { id: 'gpt-codex-mini', displayName: 'Mini', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-assessment-test-')), workspace = path.join(root, 'project');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), '{}');
  const bin = path.join(root, 'codex.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  const broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin, claude: path.join(root, 'missing'), gemini: path.join(root, 'missing') } });
  broker.availableProviders = () => ['codex'];
  broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
  broker.handoff.models = async () => ({ data: models });
  broker.checks.usage = async () => usage();
  const c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'smart' });
  const input = { text: 'Yes, do it', provider: 'codex', model: 'gpt-codex-mini', effort: 'low', mode: 'edit', approvalPolicy: 'ask', requestId: 'send-one', routing: { mode: 'smart', tier: 'light', reason: 'Draft estimate' } };
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { broker, c, input, root, workspace };
}

test('assessment sees a bounded task brief and quoted conversation, without historical tool logs', () => {
  const c = { messages: [{ role: 'user', text: 'Repair a concurrent worker queue' }, { role: 'activity', text: 'PRIVATE-TOOL-OUTPUT' }, { role: 'assistant', text: 'The locking needs a redesign.' }], context: { goal: 'Preserve queued jobs' } };
  const prompt = assessmentPrompt(c, { text: 'Do it', attachments: [] }, { workspaceFolders: [{ id: 'folder', name: 'api' }], attachments: { select: () => [] } });
  assert.match(prompt, /Repair a concurrent worker queue/); assert.match(prompt, /Do it/); assert.doesNotMatch(prompt, /PRIVATE-TOOL-OUTPUT/);
  assert.deepEqual(parseAssessment(JSON.stringify(assessment)), { ...assessment, source: 'agent' });
  for (const value of ['not json', '{}', JSON.stringify({ ...assessment, provider: 'claude', allowApi: true }), JSON.stringify({ ...assessment, effort: 'ultra' })]) assert.throws(() => parseAssessment(value), /assessment/);
  const long = 'x'.repeat(50000), huge = { messages: Array.from({ length: 40 }, () => ({ role: 'user', text: long })), context: { goal: long, summary: long, decisions: [long, long, long, long], tasks: [long, long, long, long, long] }, lastRun: { plan: { steps: Array.from({ length: 20 }, () => ({ text: long, status: 'pending' })) } } };
  assert(assessmentPrompt(huge, { text: long, attachments: [] }, { workspaceFolders: [], attachments: { select: () => [] } }).length < 13000, 'However long the thread, a rating costs about the same.');
});

test('a semantic assessment replaces the draft estimate before dispatch and shares the task budget and ledger', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t); let calls = 0;
  broker.message(c, 'user', 'Repair the concurrent worker queue without losing jobs.', 'codex');
  broker.router.worker = async (_broker, run, config, metadata) => {
    calls++; assert.equal(broker.running, run); assert.equal(broker.view(c).activeRun.purpose, 'routing');
    assert.match(config.prompt, /concurrent worker queue/); assert.equal(c.messages.at(-1).role, 'user');
    metadata({ effectiveModel: config.model, usage: { total: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10 } } });
    return JSON.stringify(assessment);
  };
  const starting = broker.dispatch(c, input);
  assert.equal(broker.dispatch(c, input), starting, 'Concurrent retries share the same assessment and submission.');
  const accepted = await starting; await broker.running.done;
  assert.equal(accepted.model, 'gpt-codex'); assert.equal(accepted.effort, 'high');
  const sent = c.messages.filter(message => message.role === 'user').at(-1);
  assert.equal(sent.text, input.text); assert.equal(sent.routing.tier, 'deep');
  assert.equal(c.lastRun.routing.assessment.source, 'agent');
  assert.equal(c.lastRun.taskId, c.routingRequests[input.requestId].taskId);
  const ledger = await broker.ledger(c), assessor = ledger.runs.find(run => run.relation === 'assessment');
  assert.equal(assessor.usage.input, 40); assert.equal(assessor.taskId, c.lastRun.taskId);
  const budget = c.taskBudgets[c.lastRun.taskId]; assert.equal(budget.reviews, 0); assert.equal(budget.handoffs, 0); assert.equal(budget.runs, 2);
  assert(budget.tokens.input >= 40);
  assert.equal((await broker.dispatch(c, input)).runId, accepted.runId); assert.equal(calls, 1, 'Retrying an accepted Send never assesses or executes twice.');
  await assert.rejects(broker.dispatch(c, { ...input, text: 'Something else' }), /request ID/);
});

test('Saver uses local rules only on Send, making no agent assessment call and keeping effort low', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t); let calls = 0;
  broker.setRouting(c, { mode: 'saver' });
  broker.router.worker = async () => { calls++; return JSON.stringify(assessment); };
  const accepted = await broker.dispatch(c, { ...input, requestId: 'saver-send', text: 'Refactor the payment module', routing: { mode: 'saver', tier: 'deep', reason: 'Draft' } });
  await broker.running.done;
  assert.equal(calls, 0, 'Saver never calls an assessment agent on Send.');
  assert.equal(accepted.model, 'gpt-codex');
  assert.equal(accepted.effort, 'low');
  assert.equal(c.lastRun.routing.mode, 'saver');
  assert.equal(c.lastRun.routing.assessment.source, 'local');
  assert.equal(c.messages.findLast(message => message.role === 'user').routing.ratedBy, 'local');
});

test('a Send reads each agent once and starts on that reading, and a full limit costs no assessment', { skip: scriptCLIs }, async t => {
  const { broker, c, input, workspace } = setup(t); let reads = 0, assessed = 0;
  broker.checks.usage = async () => { reads++; return usage(); };
  broker.router.worker = async () => { assessed++; return JSON.stringify(assessment); };
  const accepted = await broker.dispatch(c, input); await broker.running.done;
  assert.equal(reads, 1, 'Not before and after the assessment and again at launch.'); assert.equal(assessed, 1); assert.equal(c.lastRun.provider, accepted.provider);
  const launched = fs.readFileSync(path.join(workspace, '.mock-captures.jsonl'), 'utf8').trim().split('\n').length;
  broker.checks.usage = async () => ({ ...usage(), windows: [...usage().windows, { label: 'Weekly', usedPercent: 100 }] });
  await assert.rejects(broker.dispatch(c, { ...input, requestId: 'send-two', text: 'Another request' }), /no connected agent/);
  assert.equal(assessed, 1); assert.equal(broker.running, null); assert.equal(fs.readFileSync(path.join(workspace, '.mock-captures.jsonl'), 'utf8').trim().split('\n').length, launched);
});

test('a slow agent check holds up neither Send nor the next reading, but Send waits for the agent keeping the session', { skip: scriptCLIs }, async t => {
  const { broker, c, input, root } = setup(t); let release;
  const bin = path.join(root, 'claude.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 }); broker.configuredBins.claude = bin;
  broker.availableProviders = () => ['codex', 'claude']; broker.router.settleMs = 10;
  broker.handoff.models = async provider => ({ data: provider === 'codex' ? models : [{ id: 'claude-opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high'] }] });
  const slow = new Promise(resolve => { release = resolve; }), account = { installed: true, authenticated: true, billingSource: 'subscription' };
  broker.handoff.account = provider => provider === 'claude' ? slow.then(() => account) : Promise.resolve(account);
  broker.router.worker = async (_broker, run) => { assert.equal(run.provider, 'codex', 'An agent still being checked does not assess.'); return JSON.stringify(assessment); };
  const first = await broker.dispatch(c, input); await broker.running.done;
  assert.equal(first.provider, 'codex');
  assert.equal(broker.router.readings.has('claude'), false); release();
  await broker.router.probes.get('claude');
  assert.equal(broker.router.readings.has('claude'), true, 'The check finished for next time.');
  // No reading for the agent that holds the session: moving it elsewhere would lose that session, so this one is worth the wait.
  broker.router.readings.clear();
  broker.handoff.account = async provider => { if (provider === 'codex') await new Promise(resolve => setTimeout(resolve, 60)); return account; };
  broker.router.worker = async () => JSON.stringify(assessment);
  const second = await broker.dispatch(c, { ...input, requestId: 'send-two', text: 'A different follow-up' }); await broker.running.done;
  assert.equal(second.provider, 'codex');
});

test('the execution agent is chosen on quota rather than the provisional provider, and Claude rates whenever it has room', { skip: scriptCLIs }, async t => {
  const { broker, c, input, root } = setup(t); const assessors = [];
  const bin = path.join(root, 'claude.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 }); broker.configuredBins.claude = bin;
  broker.availableProviders = () => ['codex', 'claude'];
  broker.handoff.models = async provider => ({ data: provider === 'codex' ? models : [{ id: 'claude-opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high'] }, { id: 'haiku', displayName: 'Haiku', supportedEffortLevels: ['low'] }] });
  broker.checks.usage = async provider => usage(provider === 'claude' ? 20 : 90);
  broker.router.worker = async (_broker, run, config) => { assessors.push([run.provider, config.model]); return JSON.stringify(assessment); };
  const accepted = await broker.dispatch(c, input); await broker.running.done;
  assert.equal(accepted.provider, 'claude'); assert.equal(accepted.model, 'claude-opus'); assert.equal(accepted.effort, 'high');
  assert.equal(c.lastRun.provider, 'claude'); assert.equal(c.taskBudgets[c.lastRun.taskId].handoffs, 0, 'Choosing a different executor than assessor is not a coding handoff.');
  assert.deepEqual(assessors, [['claude', 'haiku']], 'The smallest model of the quickest assessor.');
  // A last run on Codex gives no reason to spend Codex: an assessor keeps no session. Without room on Claude, Codex rates.
  broker.checks.usage = async provider => provider === 'claude' ? { ...usage(), windows: [{ label: 'Weekly', usedPercent: 100 }] } : usage(30);
  await broker.dispatch(c, { ...input, requestId: 'send-two', text: 'Another request' }); await broker.running.done;
  assert.deepEqual(assessors[1], ['codex', 'gpt-codex-mini']);
});

test('unknown quota never starts a paid assessment, and API consent applies to assessment as well as execution', async t => {
  const { broker, c, input } = setup(t); let calls = 0;
  broker.router.worker = async () => { calls++; return JSON.stringify(assessment); };
  broker.checks.usage = async () => ({ available: false });
  await assert.rejects(broker.dispatch(c, input), /fresh allowance/); assert.equal(calls, 0);
  broker.checks.usage = async () => usage(); broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'api' });
  broker.setRouting(c, { mode: 'smart', allowApi: true });
  await assert.rejects(broker.dispatch(c, input), /bills by use/); assert.equal(calls, 0);
});

test('Stop and changed scope preserve the prompt and never launch a coding run', async t => {
  const { broker, c, input, workspace } = setup(t);
  for (const behavior of ['stop', 'scope']) {
    broker.router.worker = async () => {
      if (behavior === 'stop') broker.stop(c.id);
      if (behavior === 'scope') broker.updateContext(c, { goal: 'Changed during assessment' });
      return JSON.stringify(assessment);
    };
    await assert.rejects(broker.dispatch(c, { ...input, requestId: behavior }), /stopped|settings changed/);
    assert.equal(broker.running, null); assert.equal(c.routingPending, undefined);
  }
  assert.equal(fs.existsSync(path.join(workspace, '.mock-captures.jsonl')), false);
  assert.equal(c.messages.filter(message => message.role === 'user').length, 0, 'The failed Send remains a draft, without duplicate synthetic prompts.');
});

test('an assessment that fails or runs out of time never blocks the work, and the estimate then never picks a light model', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t); broker.router.limitMs = 30;
  const failures = { malformed: async () => 'Oops', crashed: async () => { throw new Error('The assessor exited.'); }, slow: () => new Promise(() => {}) };
  for (const [name, worker] of Object.entries(failures)) {
    broker.router.worker = worker;
    const accepted = await broker.dispatch(c, { ...input, requestId: name, text: `Fix a typo ${name}` }); await broker.running.done;
    assert.equal(accepted.model, 'gpt-codex', `${name}: a typo looks light, but nobody rated it.`);
    assert.equal(c.lastRun.routing.assessment.source, 'fallback');
    const sent = c.messages.findLast(message => message.role === 'user');
    assert.equal(sent.routing.ratedBy, 'fallback');
    assert.equal(c.routingRequests[name].result.assessment.source, 'fallback');
    const ledger = await broker.ledger(c), assessor = ledger.runs.find(run => run.relation === 'assessment' && run.taskId === c.lastRun.taskId);
    assert(assessor, `${name}: the failed attempt stays on the task's record.`);
  }
});

test('a bare go-ahead carries on the last rating with no agent call, and a retry never runs twice', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t); let calls = 0, rating = assessment;
  broker.router.worker = async () => { calls++; return JSON.stringify(rating); };
  await broker.dispatch(c, { ...input, text: 'Repair the worker queue' }); await broker.running.done;
  assert.equal(calls, 1);
  const goAhead = { ...input, requestId: 'go', text: 'Yes, do it' }, accepted = await broker.dispatch(c, goAhead); await broker.running.done;
  assert.equal(calls, 1, 'Nothing to judge, so no allowance spent judging.');
  assert.equal(accepted.model, 'gpt-codex'); assert.equal(accepted.effort, 'high');
  assert.equal(c.lastRun.routing.assessment.source, 'local'); assert.equal(c.lastRun.routing.tier, 'deep');
  assert.equal(c.messages.findLast(message => message.role === 'user').routing.ratedBy, 'local');
  assert.equal((await broker.dispatch(c, goAhead)).runId, accepted.runId); assert.equal(c.messages.filter(message => message.text === 'Yes, do it').length, 1);
  // A go-ahead after light work may approve something bigger than that work, so it is rated.
  rating = { tier: 'light', effort: 'low', reason: 'A small edit.' };
  await broker.dispatch(c, { ...input, requestId: 'small', text: 'Rename the helper' }); await broker.running.done;
  assert.equal(calls, 2);
  await broker.dispatch(c, { ...input, requestId: 'go-small', text: 'Yes, do it' }); await broker.running.done;
  assert.equal(calls, 3);
});

test('assessment usage can reach the shared token budget before the coding agent starts', async t => {
  const { broker, c, input } = setup(t);
  broker.budget.setPolicy(c, { maxTokens: 20 });
  broker.router.worker = async (_broker, _run, _config, metadata) => { metadata({ usage: { total: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 5 } } }); return JSON.stringify(assessment); };
  await assert.rejects(broker.dispatch(c, input), /stopped/);
  const request = c.routingRequests[input.requestId], budget = c.taskBudgets[request.taskId];
  assert.equal(budget.tokens.input, 40); assert.equal(budget.stopped.kind, 'maxTokens');
  assert.equal(c.requests[input.requestId], undefined);
});

test('a routed queued prompt is assessed at execution time and editing or pausing it prevents stale execution', async t => {
  const { broker, c, workspace } = setup(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  broker.router.worker = async () => { entered(); await new Promise(resolve => { release = resolve; }); return JSON.stringify(assessment); };
  broker.queueAction(c, { action: 'pause' });
  broker.queueAction(c, { action: 'add', text: 'Do it', provider: 'codex', mode: 'edit', routing: { mode: 'smart', tier: 'light', reason: 'Estimate' } });
  broker.queueAction(c, { action: 'resume' });
  await ready;
  const run = broker.running;
  broker.queueAction(c, { action: 'update', id: c.queue[0].id, text: 'A different request' });
  release(); await run.done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.queue[0].text, 'A different request'); assert.match(c.queuePaused.reason, /changed/);
  assert.equal(fs.existsSync(path.join(workspace, '.mock-captures.jsonl')), false);
});

test('the native assessment worker returns its structured result and usage without touching coding-session state', { skip: scriptCLIs }, async t => {
  const { broker, c, input, root, workspace } = setup(t), log = path.join(root, 'assessment-rpc.jsonl');
  fs.writeFileSync(broker.configuredBins.codex, `#!${process.execPath}
import fs from 'node:fs'; import readline from 'node:readline';
if (!process.argv.includes('app-server')) { await import(${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)}); }
else {
  const send = value => console.log(JSON.stringify(value));
  readline.createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({cwd:process.cwd(),args:process.argv,message})+'\\n');
    if(message.method==='initialize')send({id:message.id,result:{}});
    if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'assessment-only'},model:'gpt-codex-mini'}});
    if(message.method==='turn/start'){
      send({id:message.id,result:{turn:{id:'assess-turn'}}});
      if (JSON.stringify(message.params.input).includes('WAIT-IN-ASSESSMENT')) return;
      send({method:'thread/tokenUsage/updated',params:{threadId:'assessment-only',tokenUsage:{total:{inputTokens:30,cachedInputTokens:0,outputTokens:10}}}});
      send({method:'item/completed',params:{threadId:'assessment-only',item:{type:'agentMessage',id:'answer',text:${JSON.stringify(JSON.stringify(assessment))}}}});
      send({method:'turn/completed',params:{threadId:'assessment-only',turn:{status:'completed'}}});
    }
  });
}
`, { mode: 0o700 });
  const accepted = await broker.dispatch(c, input); await broker.running.done;
  assert.equal(accepted.effort, 'high');
  const rpc = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), start = rpc.find(row => row.message.method === 'thread/start');
  assert.notEqual(start.cwd, fs.realpathSync(workspace));
  for (const setting of ['features.shell_tool=false', 'features.multi_agent=false', 'features.apps=false', 'features.plugins=false', 'skills.include_instructions=false']) assert(start.args.includes(setting), setting);
  assert.match(start.message.params.baseInstructions, /rate coding requests/); assert.equal(start.message.params.developerInstructions, '');
  assert.equal(start.message.params.ephemeral, true); assert.equal(start.message.params.sandbox, 'read-only');
  assert.equal(c.sessions.codex?.id === 'assessment-only', false);
  const ledger = await broker.ledger(c); assert.equal(ledger.runs.find(run => run.relation === 'assessment').usage.input, 30);
  assert.equal(fs.existsSync(start.cwd), false, 'The isolated assessor cwd is cleaned up.');
  const stopped = broker.dispatch(c, { ...input, requestId: 'stop-native', text: 'WAIT-IN-ASSESSMENT' });
  const rejected = assert.rejects(stopped, /assessment stopped/);
  let began = false;
  for (let at = 0; at < 200; at++) {
    if (fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.message.method === 'turn/start').length === 2) { began = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(began, true); assert.equal(broker.stop(c.id).stopped, true);
  await rejected; assert.equal(broker.running, null);
});

test('Send goes on as soon as the assessor has answered, without waiting for its process to shut down', { skip: scriptCLIs }, async t => {
  const { broker, c, root } = setup(t);
  fs.writeFileSync(broker.configuredBins.codex, `#!${process.execPath}
import readline from 'node:readline';
const send = value => console.log(JSON.stringify(value));
process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if(message.method==='initialize')send({id:message.id,result:{}});
  if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'assessment-only'},model:'small'}});
  if(message.method==='turn/start'){
    send({id:message.id,result:{turn:{id:'assess-turn'}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'assessment-only',tokenUsage:{total:{inputTokens:30,cachedInputTokens:0,outputTokens:10}}}});
    send({method:'item/completed',params:{threadId:'assessment-only',item:{type:'agentMessage',id:'answer',text:'{}'}}});
    send({method:'turn/completed',params:{threadId:'assessment-only',turn:{status:'completed'}}});
  }
});
`, { mode: 0o700 });
  broker.execution.ensure(c, 'assessment-task');
  const run = { id: 'assessor', c, execution: broker.execution.token(c, 'assessment-task'), approvals: new Map(), stopped: false, ending: false }, seen = [];
  const answer = await runAssessmentWorker(broker, run, { provider: 'codex', bin: broker.configuredBins.codex, transport: 'app-server', model: 'small', effort: 'low', prompt: 'Rate this.' }, value => seen.push(value));
  assert.equal(answer, '{}'); assert(run.child, 'The process was still on its way out.');
  assert.equal(seen.find(value => value.usage).usage.total.inputTokens, 30, 'Its usage had already arrived.');
  for (let at = 0; at < 600 && run.child; at++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(run.child, null, 'It does not outlive the Send, even if it ignores being asked to stop.');
});

test('Codex assessment starts without plugins, skills or the instructions for coding work', () => {
  let args;
  const child = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), on() {}, kill() {} };
  const client = new CodexClient({ bin: '/fake', routingAssessment: true, spawnImpl: (_bin, list) => { args = list; return child; } });
  for (const setting of ['features.plugins=false', 'features.skill_search=false', 'features.computer_use=false', 'features.shell_tool=false', 'skills.include_instructions=false', 'include_permissions_instructions=false', 'project_doc_max_bytes=0']) assert(args.includes(setting), setting);
  client.closed = true;
  const ordinary = new CodexClient({ bin: '/fake', spawnImpl: (_bin, list) => { args = list; return { ...child, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() }; } });
  assert.equal(args.includes('features.plugins=false'), false, 'A coding run keeps them.'); ordinary.closed = true;
});

test('Claude assessment disables tools, hooks, MCP and session persistence', async () => {
  let options;
  await runClaude({ bin: '/fake', workspace: '/empty', prompt: 'Assess', mode: 'read', routingAssessment: true }, {
    queryImpl: args => { options = args.options; return (async function* () { yield { type: 'result', is_error: false, result: JSON.stringify(assessment) }; })(); }, event() {}, metadata() {}, approval: async () => { throw Error('No approval should be forwarded'); },
  });
  assert.deepEqual(options.tools, []); assert.deepEqual(options.mcpServers, {}); assert.equal(options.maxTurns, 1); assert.equal(options.persistSession, false); assert.equal(options.settings.disableAllHooks, true);
  assert.equal((await options.canUseTool('Bash', {}, {})).behavior, 'deny');
});

test('Codex assessment is ephemeral, read-only, isolated from coding sessions and uses a constrained output schema', async () => {
  const calls = []; let flags;
  class Client extends EventEmitter {
    async initialize() {}
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'assessment-thread' }, model: 'small' };
      if (method === 'turn/start') { setImmediate(() => this.emit('message', { method: 'turn/completed', params: { threadId: 'assessment-thread', turn: { status: 'completed' } } })); return { turn: { id: 'turn' } }; }
      return {};
    }
    close() {}
  }
  const schema = { type: 'object' };
  await runCodex({ bin: '/fake', workspace: '/empty', prompt: 'Assess', mode: 'read', model: 'small', effort: 'low', routingAssessment: true, outputSchema: schema }, { clientFactory: value => { flags = value; return new Client(); }, event() {}, metadata() {}, approval: async () => false });
  const thread = calls.find(call => call.method === 'thread/start').params, turn = calls.find(call => call.method === 'turn/start').params;
  assert.equal(flags.routingAssessment, true); assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.config.web_search, 'disabled'); assert.deepEqual(thread.config.mcp_servers, {});
  assert.equal(thread.config['tools.update_plan'], undefined); assert.deepEqual(turn.outputSchema, schema); assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.equal(calls.some(call => call.method === 'thread/resume'), false);
});

test('cold start: First Send waits for in-flight probe and succeeds without spurious rejection', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.settleMs = 10;
  broker.router.probeLimitMs = 200;
  broker.checks.usage = async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return usage();
  };
  broker.router.worker = async () => JSON.stringify(assessment);
  const accepted = await broker.dispatch(c, input);
  await broker.running.done;
  assert.equal(accepted.provider, 'codex');
  assert.equal(c.lastRun.provider, 'codex');
});

test('stale cache: First Send joins and refreshes stale readings rather than rejecting on first send', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  const staleTime = Date.now() - 20 * 60 * 1000;
  broker.router.readings.set('codex', {
    at: staleTime,
    bin: broker.configuredBins.codex,
    account: { installed: true, authenticated: true, billingSource: 'subscription' },
    usage: { available: true, checkedAt: new Date(staleTime).toISOString(), windows: [{ label: '5-hour', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }] },
    models,
  });
  broker.router.settleMs = 10;
  broker.router.probeLimitMs = 200;
  let usageReads = 0;
  broker.checks.usage = async () => {
    usageReads++;
    await new Promise(resolve => setTimeout(resolve, 30));
    return usage();
  };
  broker.router.worker = async () => JSON.stringify(assessment);
  const accepted = await broker.dispatch(c, input);
  await broker.running.done;
  assert.equal(usageReads, 1);
  assert.equal(accepted.provider, 'codex');
  assert.equal(c.lastRun.provider, 'codex');
  assert.equal(c.messages.filter(m => m.text === input.text).length, 1, 'No prompt runs twice.');
});

test('probes completing near the deadline are rechecked and can authorize work before timeout', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.settleMs = 5;
  broker.router.probeLimitMs = 80;
  broker.checks.usage = async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return usage();
  };
  broker.router.worker = async () => JSON.stringify(assessment);
  const accepted = await broker.dispatch(c, input);
  await broker.running.done;
  assert.equal(accepted.provider, 'codex');
});

test('timeout identification: an actual probe timeout identifies check timed out rather than generic stale reading', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  const staleTime = Date.now() - 20 * 60 * 1000;
  broker.router.readings.set('codex', {
    at: staleTime,
    bin: broker.configuredBins.codex,
    account: { installed: true, authenticated: true, billingSource: 'subscription' },
    usage: { available: true, checkedAt: new Date(staleTime).toISOString(), windows: [{ label: '5-hour', usedPercent: 10 }] },
    models,
  });
  broker.router.settleMs = 5;
  broker.router.probeLimitMs = 30;
  broker.checks.usage = () => new Promise(resolve => setTimeout(resolve, 150));
  broker.router.worker = async () => JSON.stringify(assessment);
  await assert.rejects(broker.dispatch(c, input), /timed out/i);
  assert.equal(broker.running, null);
});

test('cancellation during probe wait stops cleanly and leaves no duplicate run', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.settleMs = 5;
  broker.router.probeLimitMs = 500;
  broker.checks.usage = () => new Promise(resolve => setTimeout(resolve, 200));
  const dispatching = broker.dispatch(c, input);
  setTimeout(() => broker.stop(c.id), 25);
  await assert.rejects(dispatching, /assessment stopped/i);
  assert.equal(broker.running, null);
  assert.equal(c.messages.filter(m => m.role === 'user').length, 0);
});

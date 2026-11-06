import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { createRelayServer } from '../src/server.mjs';
import { Broker } from '../src/broker.mjs';
import { parsePlan, planningRequest, validateSteps } from '../src/orchestration.mjs';

// A planner's reply in the agreed shape: steps refer to earlier steps by number, and never choose an agent.
const reply = {
  summary: 'Add the endpoint, then the page that lists it.',
  steps: [
    { title: 'Add the API route', instructions: 'Add GET /api/items returning the saved items.', files: ['src/server.mjs'], tier: 'standard', dependsOn: [] },
    { title: 'Show the items', instructions: 'List the items from /api/items on the page.', files: ['public/app.js', 'public/styles.css'], tier: 'light', dependsOn: [1], agent: 'claude' },
  ],
};
const parsed = [
  { id: 's1', title: 'Add the API route', instructions: 'Add GET /api/items returning the saved items.', files: ['src/server.mjs'], tier: 'standard', dependsOn: [], agent: null },
  { id: 's2', title: 'Show the items', instructions: 'List the items from /api/items on the page.', files: ['public/app.js', 'public/styles.css'], tier: 'light', dependsOn: ['s1'], agent: null },
];
const step = (id, extra = {}) => ({ id, title: `Step ${id}`, instructions: `Do ${id}.`, files: [], tier: 'standard', dependsOn: [], agent: null, ...extra });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-orchestration-')), workspace = path.join(root, 'project');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'app.js'), 'export const value = 1;\n');
  const capture = path.join(root, 'captures.jsonl'), configuration = path.join(root, 'scenario.json'); fs.writeFileSync(configuration, '{}');
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, provider + '.mjs');
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport fs from 'node:fs';
if(process.argv.includes('--version')){console.log('mock 1');process.exit(0);}
if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'api_key'}));process.exit(0);}
let prompt='';for await(const part of process.stdin)prompt+=part;
const payload=JSON.parse(prompt.split('\\n').at(-1)),scenario=JSON.parse(fs.readFileSync(${JSON.stringify(configuration)},'utf8'));
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({provider:${JSON.stringify(provider)},args:process.argv.slice(2),payload})+'\\n');
const output=scenario.output??'Done.';
const emit=value=>console.log(JSON.stringify(value));
if(${JSON.stringify(provider)}==='codex'){
emit({type:'thread.started',thread_id:'planning-session'});
emit({type:'item.completed',item:{id:'answer',type:'agent_message',text:output}});
if(scenario.hang)setInterval(()=>{},1000);else if(scenario.fail){emit({type:'turn.failed',error:{message:'The planner failed.'}});process.exitCode=1;}else emit({type:'turn.completed'});
}else{
emit({type:'system',subtype:'init',session_id:'planning-session'});
emit({type:'assistant',message:{id:'answer',content:[{type:'text',text:output}]}});
emit({type:'result',subtype:scenario.fail?'error_max_turns':'success',session_id:'planning-session',result:output,is_error:!!scenario.fail});
}
`, { mode: 0o700 });
  }
  const apps = [], dataRoot = path.join(root, 'history');
  const launch = async () => { const app = createRelayServer({ workspace, dataRoot, bins }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); apps.push(app); return app; };
  t.after(async () => { for (const app of apps) await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, workspace, bins, launch, scenario: value => fs.writeFileSync(configuration, JSON.stringify(value)),
    captures: () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
  };
}
function client(app) {
  const project = app.registry.list()[0], conversation = app.registry.mainConversation(project.id).id;
  const broker = () => app.registry.broker(project.id), c = () => broker().get(conversation);
  const post = async (route, input) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/conversations/${conversation}/${route}?projectId=${project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  return { project, broker, c, post, plan: input => post('orchestration', input) };
}

test('a planner reply becomes numbered steps that refer to earlier steps, without the planner choosing agents', () => {
  assert.deepEqual(parsePlan(JSON.stringify(reply)), { status: 'draft', summary: reply.summary, steps: parsed });
  // A fenced reply is read the same way, and text is trimmed.
  const fenced = '```json\n' + JSON.stringify({ ...reply, summary: `  ${reply.summary}  `, steps: [{ ...reply.steps[0], title: '  Add the API route ' }, reply.steps[1]] }) + '\n```';
  assert.deepEqual(parsePlan(fenced), { status: 'draft', summary: reply.summary, steps: parsed });
  // The limits themselves are allowed: 5 steps, a 1,000-character summary, 120-character titles, 4,000 characters of
  // instructions and 12 paths of up to 300 characters.
  const most = { summary: 's'.repeat(1000), steps: Array.from({ length: 5 }, (_, index) => ({ title: index ? `Step ${index + 1}` : 'x'.repeat(120), instructions: 'y'.repeat(index ? 10 : 4000), files: index ? [] : Array.from({ length: 12 }, (_, file) => file ? `file${file}.js` : 'p'.repeat(300)), tier: 'standard', dependsOn: index ? [index] : [] })) };
  const planned = parsePlan(JSON.stringify(most));
  assert.equal(planned.status, 'draft');
  assert.deepEqual(planned.steps.map(item => [item.id, item.dependsOn]), [['s1', []], ['s2', ['s1']], ['s3', ['s2']], ['s4', ['s3']], ['s5', ['s4']]]);
  // A reply of up to 64,000 bytes is read; extra keys are ignored.
  const padded = `{"notes":"${'n'.repeat(63000)}",${JSON.stringify(reply).slice(1)}`;
  assert.ok(Buffer.byteLength(padded) <= 64000); assert.equal(parsePlan(padded).status, 'draft');
  // Files and dependencies may be left out.
  assert.deepEqual(parsePlan(JSON.stringify({ summary: 'One step.', steps: [{ title: 'Fix it', instructions: 'Fix the bug.', tier: 'deep' }] })).steps, [{ id: 's1', title: 'Fix it', instructions: 'Fix the bug.', files: [], tier: 'deep', dependsOn: [], agent: null }]);
});

test('a reply that is not a valid plan is reported, never guessed at', () => {
  const steps = count => Array.from({ length: count }, (_, index) => ({ title: `Step ${index + 1}`, instructions: 'Work.', tier: 'standard' }));
  const wrong = [
    'I would start with the API, then the page.',
    JSON.stringify({ steps: reply.steps }),
    JSON.stringify({ summary: 'Nothing to do.', steps: [] }),
    JSON.stringify({ summary: 'Too many.', steps: steps(6) }),
    JSON.stringify({ ...reply, summary: 's'.repeat(1001) }),
    JSON.stringify({ summary: 'Bad tier.', steps: [{ ...reply.steps[0], tier: 'huge' }] }),
    JSON.stringify({ summary: 'Later step first.', steps: [{ ...reply.steps[0], dependsOn: [2] }, reply.steps[1]] }),
    JSON.stringify({ summary: 'Depends on itself.', steps: [{ ...reply.steps[0], dependsOn: [1] }] }),
    JSON.stringify({ summary: 'Twice.', steps: [reply.steps[0], { ...reply.steps[1], dependsOn: [1, 1] }] }),
    JSON.stringify({ summary: 'Not a number.', steps: [reply.steps[0], { ...reply.steps[1], dependsOn: ['1'] }] }),
    JSON.stringify({ summary: 'No instructions.', steps: [{ ...reply.steps[0], instructions: ' ' }] }),
    JSON.stringify({ summary: 'Long title.', steps: [{ ...reply.steps[0], title: 'x'.repeat(121) }] }),
    JSON.stringify({ summary: 'Long instructions.', steps: [{ ...reply.steps[0], instructions: 'y'.repeat(4001) }] }),
    JSON.stringify({ summary: 'Too many files.', steps: [{ ...reply.steps[0], files: Array.from({ length: 13 }, (_, index) => `file${index}.js`) }] }),
    JSON.stringify({ summary: 'Long path.', steps: [{ ...reply.steps[0], files: ['p'.repeat(301)] }] }),
    JSON.stringify({ summary: 'Step zero.', steps: [reply.steps[0], { ...reply.steps[1], dependsOn: [0] }] }),
    'x'.repeat(70000),
    // A valid plan in a reply over 64,000 bytes is not read.
    `{"notes":"${'n'.repeat(64000)}",${JSON.stringify(reply).slice(1)}`,
  ];
  for (const text of wrong) {
    const result = parsePlan(text);
    assert.equal(result.status, 'unstructured', text.slice(0, 80));
    assert.deepEqual(result.steps, []);
  }
  assert.equal(parsePlan(undefined).status, 'unstructured');
});

test('edited steps are checked before they are saved', () => {
  assert.deepEqual(validateSteps([step('s1'), step('s4', { dependsOn: ['s1'], agent: { provider: 'claude', model: 'claude-sonnet', effort: 'high' } })]),
    [step('s1'), step('s4', { dependsOn: ['s1'], agent: { provider: 'claude', model: 'claude-sonnet', effort: 'high' } })]);
  // An empty plan is a draft you write yourself.
  assert.deepEqual(validateSteps([]), []);
  // An agent can be chosen without a model or effort.
  assert.deepEqual(validateSteps([step('s1', { agent: { provider: 'gemini' } })])[0].agent, { provider: 'gemini', model: null, effort: null });
  const invalid = [
    [null, /steps/i],
    [Array.from({ length: 6 }, (_, index) => step(`s${index + 1}`)), /at most 5/],
    [[step('s1'), step('s1')], /once/],
    [[step('one')], /steps/i],
    [[step('s1', { title: ' ' })], /title/i],
    [[step('s1', { instructions: '' })], /instructions/i],
    [[step('s1', { tier: 'huge' })], /tier/i],
    [[step('s1', { dependsOn: ['s2'] }), step('s2')], /earlier step/i],
    [[step('s1', { dependsOn: ['s9'] })], /earlier step/i],
    [[step('s1'), step('s2', { dependsOn: ['s1', 's1'] })], /earlier step/i],
    [[step('s1', { files: ['a.js', 7] })], /files/i],
    [[step('s1', { agent: { provider: 'other' } })], /agent/i],
    [[step('s1', { agent: { provider: 'codex', effort: 'enormous' } })], /effort/i],
  ];
  for (const [steps, message] of invalid) assert.throws(() => validateSteps(steps), error => error.status === 400 && message.test(error.message), JSON.stringify(steps)?.slice(0, 80));
});

test('the planning request asks for a bounded JSON plan of the fewest steps and carries the goal', () => {
  const prompt = planningRequest('Add a list of saved items.');
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /usually 2 to 4 and at most 5/);
  assert.match(prompt, /fewest/);
  assert.match(prompt, /Return only a JSON object/);
  assert.match(prompt, /Do not choose agents or models\./);
  assert.ok(prompt.endsWith('Add a list of saved items.'));
});

test('a planning run is read-only, leaves the conversation settings alone and saves the plan it returns', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  f.scenario({ output: JSON.stringify(reply) });
  const settings = await api.post('provider', { provider: 'codex', mode: 'edit', approvalPolicy: 'auto' });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  // A routed run reads plan usage again just before it starts.
  api.broker().checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 5 }] });
  assert.deepEqual(api.broker().view(api.c()).orchestrations, []);
  const sent = await api.post('messages', { text: 'Add a list of saved items.', provider: 'codex', model: 'gpt-5.5', effort: 'high', mode: 'edit', approvalPolicy: 'auto', orchestrate: true, routing: { mode: 'balanced', reason: 'Plans the work', tier: 'deep' } });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await api.broker().running.done;
  const [capture] = f.captures();
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--sandbox'), capture.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.match(capture.payload.currentRequest, /Return only a JSON object/);
  assert.match(capture.payload.currentRequest, /Add a list of saved items\.$/);
  const c = api.c();
  // The plan run is read-only by itself; the person's own access and approval settings stay as they were.
  assert.equal(c.mode, 'edit'); assert.equal(c.approvalPolicy, 'auto');
  const [plan] = c.orchestrations;
  assert.equal(plan.id, sent.body.runId);
  assert.equal(plan.status, 'draft'); assert.equal(plan.source, 'agent'); assert.equal(plan.goal, 'Add a list of saved items.');
  assert.equal(plan.summary, reply.summary); assert.deepEqual(plan.steps, parsed);
  assert.equal(plan.review, true); assert.equal(plan.revision, 1);
  assert.deepEqual(plan.planner, { provider: 'codex', model: 'gpt-5.5', effort: 'high' });
  const prompt = c.messages.find(message => message.runId === sent.body.runId && message.role === 'user');
  assert.equal(prompt.text, 'Add a list of saved items.'); assert.equal(prompt.orchestrationId, plan.id);
  assert.equal(prompt.routing.reason, 'Plans the work');
  assert.equal(c.messages.find(message => message.runId === sent.body.runId && message.role === 'assistant').orchestrationId, plan.id);
  assert.deepEqual(api.broker().view(c).orchestrations.map(item => item.id), [plan.id]);
});

test('a failed planner or an unreadable plan is recorded as such', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  for (const [scenario, status] of [[{ output: 'Start with the API, then the page.' }, 'unstructured'], [{ fail: true }, 'failed']]) {
    f.scenario(scenario);
    const sent = await api.post('messages', { text: `Plan ${status}.`, provider: 'codex', orchestrate: true });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await api.broker().running.done;
    const plan = api.c().orchestrations.find(item => item.id === sent.body.runId);
    assert.equal(plan.status, status); assert.deepEqual(plan.steps, []);
    // It can't be edited, but it can be put away.
    assert.equal((await api.plan({ action: 'update', id: plan.id, revision: plan.revision, steps: [] })).status, 409);
    assert.equal((await api.plan({ action: 'discard', id: plan.id })).body.orchestrations.find(item => item.id === plan.id).status, 'discarded');
  }
});

test('a stopped planning run says so, and takes no notes while it plans', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  f.scenario({ hang: true });
  const sent = await api.post('messages', { text: 'Plan the change.', provider: 'codex', mode: 'read', approvalPolicy: 'ask', orchestrate: true, requestId: 'plan-once' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(api.c().orchestrations[0].status, 'planning');
  // A plan written by hand waits too, so the planner's result can't land on a plan that was replaced.
  const meanwhile = await api.plan({ action: 'create', goal: 'Write it myself instead.' });
  assert.equal(meanwhile.status, 409); assert.match(meanwhile.body.error, /Wait for the planner/);
  assert.equal(api.broker().view(api.c()).canAddToRun, false, 'A note would be planned, not done, so it waits for the plan.');
  // A plan that is still being made can't be edited or discarded.
  const early = await api.plan({ action: 'update', id: sent.body.runId, revision: 0, steps: [] });
  assert.equal(early.status, 409); assert.match(early.body.error, /Wait for the planner/);
  const done = api.broker().running.done;
  assert.equal((await api.post('stop', {})).status, 200);
  await done;
  const [plan] = api.c().orchestrations;
  assert.equal(plan.status, 'interrupted'); assert.deepEqual(plan.steps, []);
  // Review after belongs to a coding prompt, not to planning.
  const reviewed = await api.post('messages', { text: 'Plan it again.', provider: 'codex', orchestrate: true, automaticReview: { folderIds: [] } });
  assert.equal(reviewed.status, 400); assert.match(reviewed.body.error, /Review after/);
  // The same request ID without Orchestrate is another request, even with the planning run's own access settings.
  const reused = await api.post('messages', { text: 'Plan the change.', provider: 'codex', mode: 'read', approvalPolicy: 'ask', requestId: 'plan-once' });
  assert.equal(reused.status, 409, JSON.stringify(reused.body));
  // Only true turns Orchestrate on, and continuing after a stop is never a plan.
  f.scenario({ output: JSON.stringify(reply) });
  for (const [route, input] of [['messages', { text: 'Fix it now.', provider: 'codex', orchestrate: 'true' }], ['continue', { provider: 'codex', orchestrate: true }]]) {
    const result = await api.post(route, input);
    assert.equal(result.status, 202, JSON.stringify(result.body));
    await api.broker().running.done;
    assert.equal(api.c().orchestrations.length, 1, route);
    assert.doesNotMatch(f.captures().at(-1).payload.currentRequest, /Return only a JSON object/, route);
  }
});

// Codex's own connection, which can take notes during a run: planning still takes none, and runs in Codex's read-only
// sandbox.
test('a planning run over the Codex app-server is read-only and takes no notes', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-orchestration-rpc-')), workspace = path.join(root, 'project'), log = path.join(root, 'rpc.jsonl'), release = path.join(root, 'release');
  fs.mkdirSync(workspace);
  const bin = path.join(root, 'codex-rpc.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('rpc 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start'||message.method==='thread/resume')send({id:message.id,result:{thread:{id:'plan-thread'},model:'rpc-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'plan-turn'}}});
const wait=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(wait);
send({method:'item/completed',params:{threadId:'plan-thread',item:{id:'answer',type:'agentMessage',text:${JSON.stringify(JSON.stringify(reply))}}}});
send({method:'turn/completed',params:{threadId:'plan-thread',turn:{status:'completed'}}});},20);}
});
`, { mode: 0o700 });
  const broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin, claude: path.join(root, 'none'), gemini: path.join(root, 'none') } });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  broker.settings(c, { provider: 'codex', mode: 'edit', approvalPolicy: 'auto', transport: 'app-server' });
  broker.start(c, { text: 'Plan the change.', provider: 'codex', transport: 'app-server', orchestrate: true });
  const rpc = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  for (let i = 0; i < 500 && !rpc().some(message => message.method === 'turn/start'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const thread = rpc().find(message => message.method === 'thread/start'), turn = rpc().find(message => message.method === 'turn/start');
  assert.equal(thread.params.sandbox, 'read-only'); assert.equal(thread.params.approvalPolicy, 'never');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(broker.view(c).canAddToRun, false, 'A note would be planned, not done, so it waits for the plan.');
  const done = broker.running.done; fs.writeFileSync(release, '');
  await done;
  assert.deepEqual([c.orchestrations[0].status, c.orchestrations[0].steps], ['draft', parsed]);
  assert.deepEqual([c.mode, c.approvalPolicy], ['edit', 'auto']);
});

test('a planning run cut off by a restart is reported as interrupted and can be put away', { skip: scriptCLIs }, async t => {
  const f = fixture(t), broker = new Broker({ workspace: f.workspace, dataDir: path.join(f.root, 'data'), bins: f.bins });
  t.after(() => broker.close());
  const c = broker.get(broker.create().id);
  f.scenario({ hang: true });
  broker.start(c, { text: 'Plan the change.', provider: 'codex', orchestrate: true });
  for (let i = 0; i < 500 && !f.captures().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.captures().length, 1);
  // Restart from the journal saved so far, as after a crash. The process record is left out, so the restart doesn't
  // wait for the planner, which is still running in this test.
  const records = fs.readFileSync(path.join(f.root, 'data', `${c.id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(record => record.type !== 'run_process');
  const dataDir = path.join(f.root, 'restarted'); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, `${c.id}.jsonl`), `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  const restarted = new Broker({ workspace: f.workspace, dataDir, bins: f.bins });
  t.after(() => restarted.close());
  const recovered = restarted.get(c.id), [plan] = recovered.orchestrations;
  assert.deepEqual([plan.status, plan.steps], ['interrupted', []]);
  assert.match(plan.summary, /Codeshi restarted while planning/);
  assert.equal(restarted.orchestrationAction(recovered, { action: 'discard', id: plan.id }).orchestrations[0].status, 'discarded');
});

test('plans are edited with a revision check, superseded by a newer plan, discarded, and kept across a restart', { skip: scriptCLIs }, async t => {
  const f = fixture(t), app = await f.launch(), api = client(app);
  const created = await api.plan({ action: 'create', goal: 'Write the plan myself.' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const [plan] = created.body.orchestrations;
  assert.deepEqual({ status: plan.status, source: plan.source, goal: plan.goal, steps: plan.steps, revision: plan.revision, review: plan.review }, { status: 'draft', source: 'manual', goal: 'Write the plan myself.', steps: [], revision: 0, review: true });
  assert.equal((await api.plan({ action: 'create', goal: ' ' })).status, 400);

  const steps = [step('s1'), step('s2', { dependsOn: ['s1'], agent: { provider: 'claude', model: null, effort: 'high' } })];
  const saved = await api.plan({ action: 'update', id: plan.id, revision: 0, steps, review: false });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.orchestrations[0].steps, steps);
  assert.equal(saved.body.orchestrations[0].revision, 1); assert.equal(saved.body.orchestrations[0].review, false);
  // Another window's older copy can't overwrite it, and invalid steps are refused.
  assert.equal((await api.plan({ action: 'update', id: plan.id, revision: 0, steps: [] })).status, 409);
  assert.equal((await api.plan({ action: 'update', id: plan.id, revision: 1, steps: [step('s1', { dependsOn: ['s2'] }), step('s2')] })).status, 400);
  assert.equal((await api.plan({ action: 'update', id: 'missing', revision: 1, steps: [] })).status, 404);
  assert.equal(api.c().orchestrations[0].revision, 1);
  // Leaving the review out keeps the earlier choice, and only true turns it on.
  assert.equal((await api.plan({ action: 'update', id: plan.id, revision: 1, steps })).body.orchestrations[0].review, false);
  assert.equal((await api.plan({ action: 'update', id: plan.id, revision: 2, steps, review: 'yes' })).body.orchestrations[0].review, false);
  assert.equal((await api.plan({ action: 'update', id: plan.id, revision: 3, steps, review: true })).body.orchestrations[0].review, true);

  // One plan is worked on at a time: a newer one replaces a draft.
  const newer = (await api.plan({ action: 'create', goal: 'A different plan.' })).body.orchestrations;
  assert.deepEqual(newer.map(item => [item.goal, item.status]), [['A different plan.', 'draft'], ['Write the plan myself.', 'superseded']]);
  assert.equal((await api.plan({ action: 'update', id: plan.id, revision: 4, steps })).status, 409);
  const discarded = await api.plan({ action: 'discard', id: newer[0].id });
  assert.equal(discarded.status, 200); assert.equal(discarded.body.orchestrations[0].status, 'discarded');
  assert.equal((await api.plan({ action: 'update', id: newer[0].id, revision: 0, steps })).status, 409);
  assert.equal((await api.plan({ action: 'rename', id: newer[0].id })).status, 400);

  // A conversation keeps its 10 newest plans.
  for (let index = 1; index <= 10; index++) assert.equal((await api.plan({ action: 'create', goal: `Plan ${index}.` })).status, 200);
  assert.deepEqual(api.c().orchestrations.map(item => item.goal), ['Plan 10.', 'Plan 9.', 'Plan 8.', 'Plan 7.', 'Plan 6.', 'Plan 5.', 'Plan 4.', 'Plan 3.', 'Plan 2.', 'Plan 1.']);
  const before = api.c().orchestrations;
  await app.close();
  const restarted = client(await f.launch());
  assert.deepEqual(restarted.c().orchestrations, before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker } from '../src/broker.mjs';
import { blockedBySandbox, requestSummary } from '../src/approval-rules.mjs';
import { cannotShow, elicitationQuestions, isToolApprovalQuestion, toolApprovalRequest, toolCallOutcome, toolQuestionAnswer, toolQuestionRequest } from '../src/codex-requests.mjs';
import { scriptCLIs } from './platform.mjs';

// A Codex app-server that asks to run a network command in every turn and records what it was told. Its output is
// what a blocked command prints when the prompt says so, and it stays running after approval when the prompt says hold.
// The markers are unusual words because the prompt also holds Codeshi's own instructions.
const toolApproval = { threadId: 'auto-thread', turnId: 'auto-turn', serverName: 'codex_apps', mode: 'form', message: 'Allow GitHub to run tool "github.create_issue"?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_title: 'create_issue', source: 'connector', connector_name: 'GitHub', tool_params: { repository_full_name: 'me/repo', command: 'rm -rf /', path: '/etc/passwd', title: 'Bug' }, tool_params_display: [{ name: 'repository_full_name', value: 'me/repo', display_name: 'repository_full_name' }, { name: 'command', value: 'rm -rf /', display_name: 'command' }, { name: 'path', value: '/etc/passwd', display_name: 'path' }, { name: 'title', value: 'Bug', display_name: 'title' }] } };
const requests = [
  { marker: 'RUN-CONNECTOR-TOOL', method: 'mcpServer/elicitation/request', params: toolApproval },
  { marker: 'RUN-MORE-ACCESS', method: 'item/permissions/requestApproval', params: { threadId: 'auto-thread', turnId: 'auto-turn', itemId: 'access', environmentId: 'local', startedAtMs: 1, cwd: '/tmp', reason: 'Needs to fetch', permissions: { network: { enabled: true }, fileSystem: null } } },
  { marker: 'RUN-TOOL-QUESTION', method: 'item/tool/requestUserInput', params: { threadId: 'auto-thread', turnId: 'auto-turn', itemId: 'exec-1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'mcp_tool_call_approval_exec-1', header: 'Approve app tool call?', question: 'Allow GitHub to run tool "github.create_issue"?', isOther: false, isSecret: false, options: [{ label: 'Allow', description: 'Run the tool and continue.' }, { label: 'Allow for this session', description: 'Remember this.' }, { label: 'Cancel', description: 'Cancel this tool call.' }] }] } },
  { marker: 'RUN-SIGN-IN', method: 'mcpServer/elicitation/request', params: { threadId: 'auto-thread', turnId: 'auto-turn', serverName: 'codex_apps', mode: 'url', message: 'Sign in to GitHub to continue', url: 'https://example.com/sign-in?token=one-time', elicitationId: 'sign-in', _meta: null } },
  { marker: 'RUN-BAD-LINK', method: 'mcpServer/elicitation/request', params: { threadId: 'auto-thread', turnId: 'auto-turn', serverName: 'odd', mode: 'url', message: 'Open this', url: 'javascript:alert(1)', elicitationId: 'bad', _meta: null } },
  { marker: 'RUN-SERVER-FORM', method: 'mcpServer/elicitation/request', params: { threadId: 'auto-thread', turnId: 'auto-turn', serverName: 'deploys', mode: 'form', message: 'Choose how to deploy', _meta: null, requestedSchema: { type: 'object', properties: { target: { type: 'string', title: 'Target', oneOf: [{ const: 'eu-1', title: 'Europe' }, { const: 'us-1', title: 'America' }] }, canary: { type: 'boolean', title: 'Canary' }, count: { type: 'integer', title: 'Count' } } } } },
  { marker: 'RUN-OPAQUE-FORM', method: 'mcpServer/elicitation/request', params: { threadId: 'auto-thread', turnId: 'auto-turn', serverName: 'custom', mode: 'openai/form', message: 'Fill this in', _meta: null, requestedSchema: { anything: true } } },
];
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-full-auto-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data'), log = path.join(root, 'rpc.jsonl'), bin = path.join(root, 'codex-mock.mjs');
  fs.mkdirSync(workspace);
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('full-auto-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));let prompt='';
const finish=text=>{send({method:'item/completed',params:{threadId:'auto-thread',item:{id:'answer',type:'agentMessage',text}}});send({method:'turn/completed',params:{threadId:'auto-thread',turn:{status:'completed'}}});};
const command=(id,output)=>send({method:'item/completed',params:{threadId:'auto-thread',item:{id,type:'commandExecution',command:'git push origin main',aggregatedOutput:output}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start'||message.method==='thread/resume')send({id:message.id,result:{thread:{id:'auto-thread'},model:'auto-model'}});
if(message.method==='turn/start'){prompt=JSON.stringify(message.params.input);send({id:message.id,result:{turn:{id:'auto-turn'}}});
if(prompt.includes('RUN-ALL-FINE')){command('one','Everything up-to-date');finish('Done');return;}
if(prompt.includes('RUN-CONNECTOR-READ-ONLY')){send({method:'item/completed',params:{threadId:'auto-thread',item:{id:'tool',type:'mcpToolCall',server:'codex_apps',tool:'github.create_issue',status:'failed',arguments:{},error:{message:'MCP tool call requires approval, but approval policy is never'}}}});finish('Refused');return;}
const ask=${JSON.stringify(requests)}.find(entry=>prompt.includes(entry.marker));if(ask){send({method:'item/started',params:{threadId:'auto-thread',item:{id:'tool',type:'mcpToolCall',server:'codex_apps',tool:'github.create_issue',status:'inProgress',arguments:{title:'Bug'}}}});send({id:89,method:ask.method,params:ask.params});return;}
if(prompt.includes('RUN-READ-ONLY')){command('one','fatal: unable to access: Could not resolve host: github.com');command('two','ssh: Could not resolve hostname: nodename nor servname provided');command('three','Could not resolve host: github.com');finish('It looks like GitHub is down');return;}
send({id:88,method:'item/commandExecution/requestApproval',params:{threadId:'auto-thread',turnId:'auto-turn',itemId:'push',command:['/bin/zsh','-lc','git push origin main'],cwd:process.cwd(),reason:'Needs the network'}});}
if(message.id===88&&message.result&&!prompt.includes('RUN-HOLD'))finish(message.result.decision==='accept'?'Pushed':'Not pushed');
if(message.id===89&&message.result){send({method:'item/completed',params:{threadId:'auto-thread',item:{id:'tool',type:'mcpToolCall',server:'codex_apps',tool:'github.create_issue',status:'completed',arguments:{title:'Bug'},error:null,result:{content:[{type:'text',text:'Created issue 7'}]}}}});finish('Answered');}
});
`, { mode: 0o700 });
  const brokers = [];
  const open = () => { const broker = new Broker({ workspace, dataDir, bins: { codex: bin, claude: path.join(root, 'none'), gemini: path.join(root, 'none') } }); brokers.push(broker); return broker; };
  t.after(async () => { await Promise.all(brokers.map(broker => broker.close())); });
  const rpc = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { open, rpc };
}
let count = 0;
const start = (broker, c, text, approvalPolicy, mode = 'edit') => { broker.start(c, { text, provider: 'codex', transport: 'app-server', mode, approvalPolicy, requestId: 'full-auto-' + ++count }); return broker.running; };
const asking = async run => { for (let i = 0; i < 400 && !run.approvals.size && !run.ended; i++) await new Promise(resolve => setTimeout(resolve, 10)); return [...run.approvals.values()]; };
const decisions = rpc => rpc.filter(message => message.id === 88 && message.result).map(message => message.result.decision);

test('Full auto-approval gives Codex the network, lets it ask for what its sandbox still blocks, and approves and shows that, in fresh and resumed sessions', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  await start(broker, c, 'Push it', 'auto').done;
  assert.equal(c.status, 'complete');
  assert(c.messages.some(message => message.text === 'Pushed'));
  assert(c.messages.some(message => message.role === 'activity' && message.text === 'Auto-approved: git push origin main'));
  await start(broker, c, 'Push it again', 'auto').done;
  const rpc = env.rpc(), threads = rpc.filter(message => /^thread\/(start|resume)$/.test(message.method)), turns = rpc.filter(message => message.method === 'turn/start');
  assert.deepEqual(threads.map(message => message.method), ['thread/start', 'thread/resume']);
  for (const message of [...threads, ...turns]) assert.equal(message.params.approvalPolicy, 'on-request', 'With "never", Codex could not ask at all.');
  for (const message of turns) { assert.equal(message.params.sandboxPolicy.type, 'workspaceWrite', 'Codex keeps its sandbox.'); assert.equal(message.params.sandboxPolicy.networkAccess, true, 'A push works the first time, without failing and hoping Codex asks.'); }
  for (const message of threads) assert.equal(message.params.config['sandbox_workspace_write.network_access'], true);
  assert.deepEqual(decisions(rpc), ['accept', 'accept']);
});

test('switching between Ask before changes and Full auto-approval applies to each run', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  let run = start(broker, c, 'First', 'ask');
  const [first] = await asking(run);
  assert(first, 'Ask before changes shows the request.');
  assert.equal(broker.view(c).pendingApprovals.length, 1);
  await broker.approve(run.id, first.id, true);
  await run.done;
  await start(broker, c, 'Second', 'auto').done;
  assert.equal(c.messages.filter(message => message.text.startsWith('Auto-approved: ')).length, 1, 'Only the Full auto-approval run approves by itself.');
  run = start(broker, c, 'Third', 'ask');
  const [third] = await asking(run);
  assert(third, 'Back in Ask before changes, the same action asks again.');
  assert.deepEqual(env.rpc().filter(message => message.method === 'turn/start').map(message => message.params.sandboxPolicy.networkAccess), [false, true, false], 'Only Full auto-approval has the network without asking.');
  await broker.approve(run.id, third.id, true);
  await run.done;
  assert.equal(c.messages.filter(message => message.text.startsWith('Auto-approved: ')).length, 1);
  assert.deepEqual(decisions(env.rpc()), ['accept', 'accept', 'accept']);
});

test('a rejection applies to that one request, so a later run in either mode can ask again', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  let run = start(broker, c, 'First', 'ask');
  await broker.approve(run.id, (await asking(run))[0].id, false);
  await run.done;
  assert(c.messages.some(message => message.text === 'Not pushed'));
  run = start(broker, c, 'Second', 'ask');
  const [again] = await asking(run);
  assert(again, 'The same action asks again in the next run.');
  await broker.approve(run.id, again.id, true);
  await run.done;
  await start(broker, c, 'Third', 'auto').done;
  assert.deepEqual(decisions(env.rpc()), ['decline', 'accept', 'accept']);
  assert.equal(c.status, 'complete');
});

test('Stop while a request is being auto-approved ends the run and leaves the workspace free', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  const approved = () => c.messages.filter(message => message.text.startsWith('Auto-approved: ')).length;
  const until = async count => { for (let i = 0; i < 400 && approved() < count; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(approved(), count); };
  const run = start(broker, c, 'RUN-HOLD', 'auto');
  await until(1);
  assert.deepEqual(broker.stop(c.id), { stopped: true });
  await run.done;
  assert.equal(c.status, 'interrupted');
  assert.equal(broker.running, null);
  // A new run can start straight after, and gets as far as its own request.
  const next = start(broker, c, 'Next', 'auto');
  await until(2);
  broker.stop(c.id);
  await next.done;
  assert.equal(c.status, 'interrupted');
});

test('in Read only Codex cannot ask, and a blocked command says the setting stopped it, once', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  await start(broker, c, 'RUN-READ-ONLY', 'ask', 'read').done;
  const turn = env.rpc().find(message => message.method === 'turn/start');
  assert.equal(turn.params.approvalPolicy, 'never');
  assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
  const notes = c.messages.filter(message => message.text.startsWith('Blocked by Read only: '));
  assert.equal(notes.length, 1, 'Several blocked commands in a run get one note.');
  assert.match(notes[0].text, /Can edit files/);
  await start(broker, c, 'RUN-ALL-FINE', 'ask', 'read').done;
  assert.equal(c.messages.filter(message => message.text.startsWith('Blocked by Read only: ')).length, 1, 'A command that worked gets no note.');
});

const answers = rpc => rpc.filter(message => message.id === 89 && (message.result || message.error)).map(message => message.result || message.error);
const accepted = { action: 'accept', content: {}, _meta: null }, declined = { action: 'decline', content: null, _meta: null }, cancelled = { action: 'cancel', content: null, _meta: null };
const REJECTED_BY_NOBODY = -32601;

test('Full auto-approval runs a connector write in fresh and resumed sessions, and says it did (#111)', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  await start(broker, c, 'RUN-CONNECTOR-TOOL', 'auto').done;
  await start(broker, c, 'RUN-CONNECTOR-TOOL again', 'auto').done;
  const rpc = env.rpc();
  assert.deepEqual(rpc.filter(message => /^thread\/(start|resume)$/.test(message.method)).map(message => message.method), ['thread/start', 'thread/resume']);
  assert.deepEqual(answers(rpc), [accepted, accepted], 'Never the error Codex reports as "user rejected MCP tool call".');
  assert.equal(c.messages.filter(message => message.text === 'Auto-approved: GitHub: create_issue').length, 2, 'Where the decision came from stays in the timeline.');
  const tool = c.messages.find(message => message.text.startsWith('mcp_tool_call: github.create_issue'));
  assert.match(tool.text, /Created issue 7/, 'The call itself shows too.');
});

test('a connector rejection applies to that one request, so a later run asks again or follows its policy (#111)', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  let run = start(broker, c, 'RUN-CONNECTOR-TOOL', 'ask');
  const [asked] = await asking(run);
  assert(asked, 'Ask before changes shows the request.');
  assert.equal(asked.connector, 'GitHub');
  assert.equal(asked.title, 'create_issue');
  assert.match(asked.details, /repository_full_name: me\/repo/, 'You see what it will do before deciding.');
  assert.equal(asked.scope, undefined, 'A tool call can only be allowed once: no rule is offered.');
  assert.equal(asked.command, undefined, 'A parameter called command is not a shell command.');
  assert.equal(asked.input, undefined, 'A parameter called path is not a file to change.');
  await broker.approve(run.id, asked.id, false);
  await run.done;
  assert.deepEqual(answers(env.rpc()), [declined]);
  run = start(broker, c, 'RUN-CONNECTOR-TOOL resumed', 'ask');
  const [again] = await asking(run);
  assert(again, 'The next run asks again, with no denial remembered.');
  await broker.approve(run.id, again.id, true);
  await run.done;
  await start(broker, c, 'RUN-CONNECTOR-TOOL full auto', 'auto').done;
  assert.deepEqual(answers(env.rpc()), [declined, accepted, accepted]);
  assert.equal(c.messages.filter(message => message.text.startsWith('Auto-approved: ')).length, 1, 'Only the Full auto-approval run approves by itself.');
  assert.deepEqual(env.rpc().filter(message => /^thread\/(start|resume)$/.test(message.method)).map(message => message.method), ['thread/start', 'thread/resume', 'thread/resume'], 'Fresh and resumed sessions both ask.');
});

test('stopping a run with a connector request waiting declines it and starts nothing', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  const run = start(broker, c, 'RUN-CONNECTOR-TOOL', 'ask');
  await asking(run);
  broker.stop(c.id);
  await run.done;
  assert.equal(c.status, 'interrupted');
  assert.equal(c.messages.some(message => message.text.startsWith('Auto-approved: ')), false);
  assert.equal(answers(env.rpc()).some(answer => answer.action === 'accept'), false);
});

test('the same approval sent as a question follows the policy too, and never remembers a session (#111)', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id), id = 'mcp_tool_call_approval_exec-1';
  await start(broker, c, 'RUN-TOOL-QUESTION', 'auto').done;
  assert(c.messages.some(message => message.text === 'Auto-approved: GitHub: github.create_issue'));
  let run = start(broker, c, 'RUN-TOOL-QUESTION asks', 'ask');
  const [asked] = await asking(run);
  assert.notEqual(asked.kind, 'question', 'It is an approval, so it does not wait forever in Full auto-approval.');
  await broker.approve(run.id, asked.id, false);
  await run.done;
  assert.deepEqual(answers(env.rpc()), [{ answers: { [id]: { answers: ['Allow'] } } }, { answers: { [id]: { answers: ['Cancel'] } } }]);
});

test('asking for more access follows the policy and grants exactly that, for one turn (#111)', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  await start(broker, c, 'RUN-MORE-ACCESS', 'auto').done;
  assert(c.messages.some(message => message.text === 'Auto-approved: Network access'));
  const run = start(broker, c, 'RUN-MORE-ACCESS asks', 'ask');
  const [asked] = await asking(run);
  assert.equal(asked.title, 'Network access');
  assert.match(asked.details, /Needs to fetch/);
  await broker.approve(run.id, asked.id, false);
  await run.done;
  assert.deepEqual(answers(env.rpc()), [{ permissions: { network: { enabled: true } }, scope: 'turn' }, { permissions: {}, scope: 'turn' }]);
});

test('Full auto-approval never answers what a server asks of a person: a sign-in waits for you, and its link stays out of the journal', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  let run = start(broker, c, 'RUN-SIGN-IN', 'auto');
  const [asked] = await asking(run);
  assert.equal(asked.kind, 'question');
  assert.equal(asked.questions[0].link, 'https://example.com/sign-in?token=one-time');
  assert.equal(asked.questions[0].header, '', "Codex's internal server name is not shown.");
  assert.equal(c.messages.some(message => message.text.startsWith('Auto-approved: ')), false);
  await broker.answer(run.id, asked.id, [['Done']]);
  await run.done;
  run = start(broker, c, 'RUN-SIGN-IN skip', 'auto');
  const [skipped] = await asking(run);
  await broker.answer(run.id, skipped.id, null);
  await run.done;
  run = start(broker, c, 'RUN-SIGN-IN refuse', 'ask');
  const [refused] = await asking(run);
  await broker.answer(run.id, refused.id, [['Cancel']]);
  await run.done;
  assert.deepEqual(answers(env.rpc()), [{ action: 'accept', content: null, _meta: null }, cancelled, declined]);
  assert.doesNotMatch(JSON.stringify(c.messages), /one-time/, 'A sign-in link can carry a one-time token.');
});

test('a server\'s form becomes questions and its answers go back typed; what cannot be shown says so (#111)', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  let run = start(broker, c, 'RUN-SERVER-FORM', 'auto');
  const [asked] = await asking(run);
  assert.deepEqual(asked.questions.map(question => question.id), ['target', 'canary', 'count']);
  assert.deepEqual(asked.questions[0].options.map(option => option.label), ['Europe', 'America']);
  await broker.answer(run.id, asked.id, [['Europe'], ['No'], ['3']]);
  await run.done;
  run = start(broker, c, 'RUN-SERVER-FORM bad number', 'ask');
  await broker.answer(run.id, (await asking(run))[0].id, [['America'], ['Yes'], ['lots']]);
  await run.done;
  await start(broker, c, 'RUN-OPAQUE-FORM', 'auto').done;
  await start(broker, c, 'RUN-BAD-LINK', 'auto').done;
  assert.deepEqual(answers(env.rpc()), [{ action: 'accept', content: { target: 'eu-1', canary: false, count: 3 }, _meta: null }, cancelled, cancelled, cancelled]);
  assert.equal(answers(env.rpc()).some(answer => answer.code === REJECTED_BY_NOBODY), false);
  assert(c.messages.some(message => /^custom asked for something Codeshi can't show, so it was cancelled: Fill this in/.test(message.text)));
  assert(c.messages.some(message => /^odd asked for something Codeshi can't show/.test(message.text)));
});

test('Read only explains a refused connector call once, and no request reaches a person', { skip: scriptCLIs }, async t => {
  const env = setup(t), broker = env.open(), c = broker.get(broker.create().id);
  await start(broker, c, 'RUN-CONNECTOR-READ-ONLY', 'ask', 'read').done;
  const notes = c.messages.filter(message => message.text.startsWith('Blocked by Read only: '));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /connectors and MCP tools/);
  // A Codex that asks anyway in Read only is refused rather than prompted.
  await start(broker, c, 'RUN-CONNECTOR-TOOL', 'ask', 'read').done;
  await start(broker, c, 'RUN-SIGN-IN', 'ask', 'read').done;
  assert.deepEqual(answers(env.rpc()), [declined, cancelled]);
  assert.equal(broker.view(c).pendingApprovals.length, 0);
});

test('the summary of a connector request names the connector and its tool', () => {
  assert.equal(requestSummary({ connector: 'GitHub', title: 'create_issue' }), 'GitHub: create_issue');
  assert.equal(requestSummary({ connector: 'GitHub', title: 'create_issue', reason: 'Other words' }), 'GitHub: create_issue');
});

test('a tool question that names unexpected options refuses rather than guessing', () => {
  const params = { questions: [{ id: 'mcp_tool_call_approval_x', question: 'Allow the node_repl MCP server to run tool "js"?', options: [{ label: 'Allow for this session' }, { label: 'Later' }] }] };
  assert.equal(isToolApprovalQuestion(params), true);
  assert.deepEqual(toolQuestionRequest(1, params), { id: '1', kind: 'item/tool/requestUserInput', connector: 'node_repl', title: 'js', details: '' });
  assert.deepEqual(toolQuestionAnswer(params, true), { answers: { mcp_tool_call_approval_x: { answers: [] } } }, 'Allow for this session is never picked for you.');
  assert.deepEqual(toolQuestionAnswer(params, false), { answers: { mcp_tool_call_approval_x: { answers: [] } } });
  assert.equal(isToolApprovalQuestion({ questions: [{ id: 'region' }] }), false);
  assert.equal(isToolApprovalQuestion({ questions: [{ id: 'mcp_tool_call_approval_a' }, { id: 'other' }] }), false);
});

test('only forms Codeshi can show all of become questions', () => {
  const form = properties => elicitationQuestions({ serverName: 's', mode: 'form', message: 'm', requestedSchema: { type: 'object', properties } });
  assert.equal(form({ a: { type: 'object' } }), null, 'Unknown field types are not half-asked.');
  assert.equal(form(Object.fromEntries(Array.from({ length: 7 }, (_, i) => ['f' + i, { type: 'string' }]))), null, 'Questions past the sixth would be dropped.');
  assert.equal(form({ a: { type: 'string', enum: Array.from({ length: 9 }, (_, i) => 'o' + i) } }), null, 'Options past the eighth would be dropped.');
  const many = form({ tags: { type: 'array', title: 'Tags', items: { enum: ['x', 'y'] } } });
  assert.equal(many.questions[0].multiple, true);
  assert.deepEqual(many.respond([['x', 'y']]).content, { tags: ['x', 'y'] });
  assert.deepEqual(form({}).respond([['Continue']]), accepted);
  assert.deepEqual(form({}).respond([['Cancel']]), declined);
  assert.equal(elicitationQuestions({ mode: 'url', url: 'https://example.com', message: 'm', serverName: 'codex_apps', _meta: { connector_name: 'GitHub' } }).questions[0].header, 'GitHub');
  assert.match(cannotShow({ serverName: 'codex_apps', mode: 'openaiForm', message: 'Fill this in' }), /^A connector asked for something Codeshi can't show, so it was cancelled: Fill this in/);
  assert.equal(toolApprovalRequest(1, { serverName: 'codex_apps', message: 'x' }).connector, 'A connector');
  assert.equal(elicitationQuestions({ mode: 'url', url: 'http://example.com/plain', message: 'm' }), null, 'Plain http to another machine is not offered.');
  assert.equal(elicitationQuestions({ mode: 'url', url: 'https://user:pw@example.com', message: 'm' }), null);
  assert.equal(elicitationQuestions({ mode: 'url', url: 'http://127.0.0.1:9/x', message: 'm' }).questions[0].link, 'http://127.0.0.1:9/x');
});

test('a timeline row for a tool shows its answer, or why it failed, and not an image', () => {
  assert.equal(toolCallOutcome({ error: { message: 'user rejected MCP tool call' } }), 'user rejected MCP tool call');
  assert.equal(toolCallOutcome({ status: 'completed', result: { content: [{ type: 'image', data: 'AAAA' }, { type: 'text', text: 'ok' }] } }), 'ok');
  assert.deepEqual(toolCallOutcome({ status: 'inProgress', arguments: { a: 1 } }), { a: 1 });
  assert.match(toolCallOutcome({ status: 'completed', result: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }), /cut here/);
});

test('a request is summed up in one line, and only sandbox failures count as blocked', () => {
  assert.equal(requestSummary({ command: 'git push' }), 'git push');
  assert.equal(requestSummary({ command: ['/bin/zsh', '-lc', 'git push\nrm x'] }), 'git push');
  assert.equal(requestSummary({ command: ['git', 'push'] }), 'git push');
  assert.equal(requestSummary({ reason: 'Write outside the folder' }), 'Write outside the folder');
  assert.equal(requestSummary({}), 'A change outside the sandbox');
  assert.equal(requestSummary({ command: 'x'.repeat(500) }).length, 200);
  for (const output of ['Could not resolve host: github.com', 'npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org', 'sh: x: Read-only file system', 'cp: y: Operation not permitted']) assert.equal(blockedBySandbox(output), true, output);
  for (const output of ['', null, 'Tests failed: 2', 'Everything up-to-date']) assert.equal(blockedBySandbox(output), false, String(output));
});

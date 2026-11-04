import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker } from '../src/broker.mjs';
import { blockedBySandbox, requestSummary } from '../src/approval-rules.mjs';
import { scriptCLIs } from './platform.mjs';

// A Codex app-server that asks to run a network command in every turn and records what it was told. Its output is
// what a blocked command prints when the prompt says so, and it stays running after approval when the prompt says hold.
// The markers are unusual words because the prompt also holds Codeshi's own instructions.
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
if(prompt.includes('RUN-READ-ONLY')){command('one','fatal: unable to access: Could not resolve host: github.com');command('two','ssh: Could not resolve hostname: nodename nor servname provided');command('three','Could not resolve host: github.com');finish('It looks like GitHub is down');return;}
send({id:88,method:'item/commandExecution/requestApproval',params:{threadId:'auto-thread',turnId:'auto-turn',itemId:'push',command:['/bin/zsh','-lc','git push origin main'],cwd:process.cwd(),reason:'Needs the network'}});}
if(message.id===88&&message.result&&!prompt.includes('RUN-HOLD'))finish(message.result.decision==='accept'?'Pushed':'Not pushed');
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

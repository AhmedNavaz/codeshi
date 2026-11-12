import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { ProjectRegistry } from '../src/projects.mjs';
import { MutationCoordinator, acquireProjectLock, withFileGuard } from '../src/mutation-lock.mjs';
import { prepareContext } from '../src/context.mjs';
import { runCodex, runClaude, classifyError, CodexClient } from '../src/providers.mjs';

test('overlapping workspaces exclude mutations even with different history roots',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-cross-root-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const child=path.join(root,'workspace','child');fs.mkdirSync(child,{recursive:true});
  const first=new MutationCoordinator(path.join(root,'one'));
  const second=new MutationCoordinator(path.join(root,'two'));
  const lease=first.acquire(path.dirname(child),'provider');
  try {assert.throws(()=>second.acquire(child,'patch'),/overlapping workspace/);}finally{lease.release();}
  const next=second.acquire(child,'patch');next.release();
});

test('overlapping workspaces exclude mutations when a folder is typed in another letter case',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'relay-case-root-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const shop=path.join(root,'Shop');fs.mkdirSync(path.join(shop,'backend'),{recursive:true});
  if(!fs.existsSync(path.join(root,'shop')))return t.skip('This file system distinguishes letter case.');
  const coordinator=new MutationCoordinator(path.join(root,'data'));
  const lease=coordinator.acquire(shop,'provider');
  try {assert.throws(()=>coordinator.acquire(path.join(root,'shop','BACKEND'),'patch'),/overlapping workspace/);}finally{lease.release();}
});

test('a lease saved with a folder typed in another letter case still excludes overlapping mutations',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'relay-case-lease-')));
  const coordinator=new MutationCoordinator(path.join(root,'data')),saved=path.join(coordinator.root,`relay-case-lease-${process.pid}.json`);
  // Other test files take leases in this shared folder at the same time. Change it under the application's guard, so they never read a half-written or removed lease.
  const guarded=callback=>withFileGuard(path.join(coordinator.root,'coordinator'),callback);
  t.after(()=>{guarded(()=>fs.rmSync(saved,{force:true}));fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'Shop','Backend'),{recursive:true});
  if(!fs.existsSync(path.join(root,'shop')))return t.skip('This file system distinguishes letter case.');
  // Earlier versions saved a lease's folders as they were typed. This one belongs to a live instance.
  guarded(()=>fs.writeFileSync(saved,JSON.stringify({id:'before-the-upgrade',workspace:path.join(root,'shop'),workspaces:[path.join(root,'shop')],operation:'provider:codex',pid:process.pid,processGroup:null,createdAt:new Date().toISOString()})));
  assert.throws(()=>coordinator.acquire(path.join(root,'shop','Backend'),'patch'),/overlapping workspace/);
  assert.ok(fs.existsSync(saved),'The saved lease still belongs to its instance.');
});

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reliability-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), '{}');
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  }
  const instances = [];
  const broker = () => { const value = new Broker({ workspace, dataDir: path.join(root, 'history'), bins }); instances.push(value); return value; };
  const registry = () => { const value = new ProjectRegistry({ dataRoot: path.join(root, 'registry'), bins }); instances.push(value); return value; };
  t.after(async () => { for (const item of instances) await item.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, bins, broker, registry };
}
test('validation is atomic, long history is bounded, and request IDs deduplicate accepted runs across restart', { skip: scriptCLIs }, async t => {
  const f = setup(t); let broker = f.broker(); let c = broker.get(broker.create().id);
  const before = fs.readFileSync(path.join(f.root, 'history', `${c.id}.jsonl`), 'utf8');
  assert.throws(() => broker.start(c, { text: '🧠'.repeat(50000), requestId: 'oversize' }), { status: 400 });
  assert.equal(fs.readFileSync(path.join(f.root, 'history', `${c.id}.jsonl`), 'utf8'), before);
  broker.message(c, 'user', 'old'.repeat(400000));
  broker.updateContext(c, { summary: 'Manual continuity', goal: 'Finish work', decisions: ['Keep existing user edits'], tasks: ['Verify result'] });
  const prepared = prepareContext(c, 'New request', { workspace: f.workspace, fresh: true });
  assert.ok(Buffer.byteLength(prepared.prompt) < 192000);
  assert.match(prepared.prompt, /Manual continuity/);
  const first = broker.start(c, { text: 'Deduplicated work', provider: 'codex', requestId: 'request-one' });
  const active = broker.running;
  assert.equal(broker.start(c, { text: 'Deduplicated work', provider: 'codex', requestId: 'request-one' }).runId, first.runId);
  assert.throws(() => broker.start(c, { text: 'Different work', provider: 'codex', requestId: 'request-one' }), { status: 409 });
  await active.done; await broker.close();
  broker = f.broker(); c = broker.get(c.id);
  const duplicate = broker.start(c, { text: 'Deduplicated work', provider: 'codex', requestId: 'request-one' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, first.runId); assert.equal(broker.running, null);
  assert.equal(c.messages.filter(m => m.text === 'Deduplicated work').length, 1);
  assert.equal(c.context.goal, 'Finish work'); assert.equal(c.lastRun.baseline.git, false);
});
test('stream persistence stores deltas and replays legacy snapshot records', async t => {
  const f = setup(t); const broker = f.broker(); const c = broker.get(broker.create().id);
  const id = broker.message(c, 'assistant', 'A', 'claude', 'stream', 'streaming');
  for (let index = 2; index <= 200; index++) broker.message(c, 'assistant', 'A'.repeat(index), 'claude', id, 'streaming');
  const lines = fs.readFileSync(path.join(f.root, 'history', `${c.id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.filter(record => record.type === 'message_delta').length, 199);
  assert.equal(lines.filter(record => record.type === 'message_delta').reduce((sum, record) => sum + record.text.length, 0), 199);
  broker.record(c, { type: 'message_update', id, update: { text: 'Legacy snapshot', status: 'complete' } });
  await broker.close(); const reopened = f.broker(); assert.equal(reopened.get(c.id).messages[0].text, 'Legacy snapshot');
});
test('registry merges stale instances and overlapping mutations exclude provider runs and patches', async t => {
  const f = setup(t); const nested = path.join(f.workspace, 'nested'); fs.mkdirSync(nested);
  const first = f.registry(); const second = f.registry();
  const parent = first.add({ path: f.workspace, name: 'Parent' });
  const child = second.add({ path: nested, name: 'Child' });
  assert.equal(first.list().length, 2); assert.equal(second.list().length, 2);
  second.add({ path: f.workspace, name: 'Renamed' }); assert.equal(first.get(parent.id).name, 'Renamed');
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const held = first.withMutation(parent.id, 'verification', () => barrier);
  await assert.rejects(second.withMutation(child.id, 'patch', async () => {}), { status: 409 });
  const broker = first.broker(parent.id); const c = broker.get(broker.create().id);
  assert.throws(() => broker.start(c, { text: 'Do work', provider: 'codex' }), { status: 409 });
  assert.equal(c.messages.length, 0);
  release(); await held;
  await second.withMutation(child.id, 'patch', async () => {});
});

// Other test files take leases in the shared lease folder at the same time, so these tests change it under the application's guard.
function leases(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reused-pid-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const coordinator = new MutationCoordinator(path.join(root, 'history'));
  const guarded = callback => withFileGuard(path.join(coordinator.root, 'coordinator'), callback);
  const groups = [], files = [];
  t.after(() => {
    for (const group of groups) { try { process.kill(-group, 'SIGKILL'); } catch {} }
    guarded(() => { for (const file of files) fs.rmSync(file, { force: true }); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    workspace, coordinator, guarded,
    file(id) { const file = path.join(coordinator.root, `${id}.json`); files.push(file); return file; },
    // Like an assistant, each process leads its own process group.
    group(pid = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' }).pid) { groups.push(pid); return pid; },
  };
}
async function stopped(pid) {
  for (const until = Date.now() + 5000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 20))) {
    // macOS answers EPERM while a stopped group is waiting to be reaped.
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; if (error.code !== 'EPERM') throw error; }
  }
  throw new Error(`Process ${pid} is still running.`);
}

test('a lease is kept while its owner or its assistant is running, even after the clock is set back', async t => {
  if (process.platform !== 'darwin') return t.skip('Process start times are read on macOS only.');
  const f = leases(t);
  // The owner runs in another time zone and language, like an instance started after the user changed them.
  const owner = fork(fileURLToPath(new URL('./fixtures/lease-owner.mjs', import.meta.url)), [f.workspace], { env: { ...process.env, TZ: 'Asia/Tokyo', LC_ALL: 'de_DE.UTF-8' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => owner.kill('SIGKILL'));
  const [{ id, assistant }] = await Promise.race([once(owner, 'message'), once(owner, 'exit').then(() => { throw new Error('The lease owner exited before taking its lease.'); })]);
  const file = f.file(id), earlier = new Date(Date.now() - 60 * 1000);
  f.group(assistant);
  // A backward clock correction after the owner started makes its lease look older than the owner.
  f.guarded(() => fs.utimesSync(file, earlier, earlier));
  assert.throws(() => f.coordinator.acquire(f.workspace, 'patch'), /Project files are busy/, 'The owner is running.');
  owner.kill('SIGKILL'); await once(owner, 'exit'); await stopped(assistant);
  assert.throws(() => f.coordinator.acquire(f.workspace, 'patch'), /Project files are busy/, 'The owner crashed and the assistant\'s leader exited, while a command it started kept running.');
  process.kill(-assistant, 'SIGKILL'); await stopped(-assistant);
  f.coordinator.acquire(f.workspace, 'patch').release();
  assert.equal(fs.existsSync(file), false, 'Once both have stopped, the lease is stale.');
});

test('a lease left by a crash is cleared once its process IDs belong to a process that started later', async t => {
  if (process.platform !== 'darwin') return t.skip('Process start times are read on macOS only.');
  const f = leases(t);
  const taken = f.coordinator.acquire(f.workspace, 'provider:codex');
  taken.setProcess(f.group());
  const file = f.file(taken.id), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  // ps reports start times to the second, so the process that takes over the IDs starts in a later second.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const later = f.group(), exited = spawnSync('/usr/bin/true').pid;
  const save = ids => f.guarded(() => fs.writeFileSync(file, JSON.stringify({ ...saved, ...ids })));
  // The crashed instance's own process ID, then its assistant's process group ID, now belong to the later process.
  for (const ids of [{ pid: later, processGroup: null }, { pid: exited, processGroup: later }]) {
    save(ids);
    f.coordinator.acquire(f.workspace, 'patch').release();
    assert.equal(fs.existsSync(file), false);
  }
  // Earlier versions saved no start times, so a live process ID still holds their leases.
  for (const ids of [{ pid: later, processGroup: null }, { pid: exited, processGroup: later }]) {
    save({ ...ids, pidStart: undefined, processGroupStart: undefined });
    assert.throws(() => f.coordinator.acquire(f.workspace, 'patch'), /Project files are busy/);
  }
});

// Like a full disk: a file in the folder is created, or emptied, as asked, but nothing can be written into it.
function fullDisk(folder, callback) {
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, data, options) => {
    if (typeof file !== 'string' || !file.startsWith(folder + path.sep)) return write(file, data, options);
    fs.closeSync(fs.openSync(file, options?.flag || 'w', options?.mode));
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  };
  try { return callback(); } finally { fs.writeFileSync = write; }
}
// An unreadable lease blocks every change, so these leases stay in a folder of their own, away from other test files.
function privateLeases(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-full-disk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const one = path.join(root, 'one'), two = path.join(root, 'two'); fs.mkdirSync(one); fs.mkdirSync(two);
  const coordinator = new MutationCoordinator(path.join(root, 'data'));
  coordinator.root = path.join(root, 'leases'); fs.mkdirSync(coordinator.root);
  return { one, two, coordinator };
}

test('a lease that a full disk keeps from being saved leaves nothing behind to block later changes', t => {
  const { one, two, coordinator } = privateLeases(t);
  assert.throws(() => fullDisk(coordinator.root, () => coordinator.acquire(one, 'patch')), { code: 'ENOSPC' });
  coordinator.acquire(two, 'patch').release();
  const lease = coordinator.acquire(one, 'provider:codex');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(coordinator.root, `${lease.id}.json`)).mode & 0o777, 0o600);
  assert.throws(() => fullDisk(coordinator.root, () => lease.setProcess(process.pid)), { code: 'ENOSPC' });
  // The lease as saved before the update still holds its folder.
  assert.throws(() => coordinator.acquire(one, 'patch'), /Project files are busy/);
  coordinator.acquire(two, 'patch').release();
  lease.release();
  assert.deepEqual(fs.readdirSync(coordinator.root), []);
});

test('a lease an earlier version left unreadable is named, and kept because its owner is unknown', t => {
  const { one, coordinator } = privateLeases(t);
  // Earlier versions left an empty lease when the disk filled up or the app stopped while saving it.
  const left = path.join(coordinator.root, 'left-by-an-earlier-version.json'); fs.writeFileSync(left, '');
  assert.throws(() => coordinator.acquire(one, 'patch'), error => error.status === 409 && error.message.includes(left));
  assert.ok(fs.existsSync(left));
});

test('a project lock that a full disk keeps from being saved does not block the project later', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-full-disk-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), lock = path.join(project, 'server.lock');
  assert.throws(() => fullDisk(project, () => acquireProjectLock(project)), { code: 'ENOSPC' });
  acquireProjectLock(project)();
  assert.deepEqual(fs.readdirSync(project), []);
  // Earlier versions left an empty lock the same way. It names its file, not an instance that is running.
  fs.writeFileSync(lock, '');
  assert.throws(() => acquireProjectLock(project), error => error.status === 409 && error.message === `Invalid project lock: ${lock}`);
});
test('Codex official JSON-RPC approvals return decisions and respect native access/model settings', async () => {
  class FakeClient extends EventEmitter {
    sent = []; requests = [];
    async initialize() {}
    async request(method, params) {
      this.requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'native-thread' }, model: 'reported-model' };
      if (method === 'turn/start') {
        setTimeout(() => this.emit('message', { id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', command: 'npm test' } }), 1);
        return { turn: { id: 'native-turn' } };
      }
    }
    send(message) { this.sent.push(message); if (message.id === 99) this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } }); }
    close() {}
  }
  const client = new FakeClient(); const metadata = []; const events = []; let approvals = 0;
  await runCodex({ bin: '/unused', workspace: '/project', mode: 'edit', prompt: 'Run tests', model: 'selected-model' }, {
    clientFactory: () => client, event: value => events.push(value), metadata: value => metadata.push(value), approval: async request => { approvals++; assert.equal(request.command, 'npm test'); return true; },
  });
  assert.equal(approvals, 1); assert.deepEqual(client.sent[0], { id: 99, result: { decision: 'accept' } });
  assert.equal(client.requests.find(row => row.method === 'thread/start').params.sandbox, 'workspace-write'); assert.equal(client.requests.find(row => row.method === 'thread/start').params.approvalsReviewer, 'user');
  assert.equal(client.requests.find(row => row.method === 'turn/start').params.model, 'selected-model'); assert.equal(metadata[0].effectiveModel, 'reported-model');
  assert.ok(events.some(event => event.type === 'turn.completed'));
});
test('Claude official SDK approval callback uses installed binary and excludes repository hook/settings sources', async () => {
  let captured; let approvals = 0;
  async function* queryImpl(input) {
    captured = input.options;
    const allowed = await input.options.canUseTool('Bash', { command: 'npm test' }, { toolUseID: 'approval-one' });
    assert.equal(allowed.behavior, 'allow'); assert.deepEqual(allowed.updatedInput, { command: 'npm test' });
    yield { type: 'system', subtype: 'init', model: 'effective-claude' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Done' };
  }
  await runClaude({ bin: '/installed/unmodified/claude', workspace: '/project', mode: 'edit', prompt: 'Run tests' }, {
    queryImpl, event() {}, metadata() {}, approval: async request => { approvals++; assert.equal(request.id, 'approval-one'); return true; },
  });
  assert.equal(captured.pathToClaudeCodeExecutable, '/installed/unmodified/claude');
  assert.equal(captured.permissionMode, 'default'); assert.deepEqual(captured.settingSources, []); assert.equal(captured.settings.disableAllHooks, true); assert.equal(approvals, 1);
});
test('error categories distinguish unavailable account causes', () => {
  assert.equal(classifyError('UsageLimitExceeded'), 'quota'); assert.equal(classifyError("You've hit your limit · resets later"), 'quota'); assert.equal(classifyError('401 unauthorized'), 'authentication');
  assert.equal(classifyError({ message: 'Turn failed', codexErrorInfo: 'UsageLimitExceeded' }), 'quota');
  assert.equal(classifyError({ code: 'ENOENT' }), 'installation'); assert.equal(classifyError('permission denied'), 'permission');
  assert.equal(classifyError('Gemini protocol timed out: initialize'), 'timeout');
  assert.equal(classifyError('invalid JSON protocol'), 'protocol');
});

test('Broker GUI approval traverses its worker and actual Codex JSON-RPC adapter before execution', { skip: scriptCLIs }, async t => {
  const f = setup(t); const log = path.join(f.root, 'rpc.jsonl');
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('approval-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'approval-thread'},model:'actual-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'approval-turn'}}});send({id:77,method:'item/commandExecution/requestApproval',params:{threadId:'approval-thread',turnId:'approval-turn',command:'reviewed-command',cwd:process.cwd()}});}
if(message.id===77&&message.result){send({method:'item/completed',params:{threadId:'approval-thread',item:{id:'answer',type:'agentMessage',text:message.result.decision==='accept'?'Approved action finished':'Action declined'}}});send({method:'turn/completed',params:{threadId:'approval-thread',turn:{status:'completed'}}});}
});\n`);
  const broker = f.broker(); const c = broker.get(broker.create().id);
  const { runId } = broker.start(c, { text: 'Ask before action', provider: 'codex', transport: 'app-server', requestId: 'real-adapter-approval' });
  const active = broker.running;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { broker.off('update', check); reject(new Error('No approval arrived.')); }, 5000);
    const check = () => { if (broker.view(c).pendingApprovals.length) { clearTimeout(timer); broker.off('update', check); resolve(); } };
    broker.on('update', check); check();
  });
  assert.equal(c.messages.some(m => m.text === 'Approved action finished'), false);
  const pending = broker.view(c).pendingApprovals[0]; assert.equal(pending.command, 'reviewed-command'); assert.equal(pending.runId, runId);
  assert.deepEqual(broker.approve(runId, pending.id, true), { resolved: true });
  await active.done;
  assert.equal(c.status, 'complete'); assert.equal(c.lastRun.effectiveModel, 'actual-model');
  assert.ok(c.messages.some(m => m.text === 'Approved action finished'));
  assert.throws(() => broker.approve(runId, pending.id, true), { status: 409 });
  const messages = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.find(message => message.id === 77).result, { decision: 'accept' });
});

test('An agent’s question traverses its worker and actual Codex JSON-RPC adapter, and only a checked answer goes back', { skip: scriptCLIs }, async t => {
  const f = setup(t); const log = path.join(f.root, 'rpc.jsonl');
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('question-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'question-thread'},model:'actual-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'question-turn'}}});send({id:78,method:'item/tool/requestUserInput',params:{threadId:'question-thread',turnId:'question-turn',itemId:'ask',isBlocking:true,questions:[{id:'storage',header:'Storage',question:'Where should sessions be kept?',isOther:false,options:[{label:'Cookies (Recommended)',description:'Sent with each request'},{label:'Database',description:'One row per session'}]}]}});}
if(message.id===78&&message.result){const chosen=message.result.answers.storage?.answers?.[0]||'nothing';send({method:'item/completed',params:{threadId:'question-thread',item:{id:'answer',type:'agentMessage',text:'Keeping sessions in '+chosen}}});send({method:'turn/completed',params:{threadId:'question-thread',turn:{id:'question-turn',status:'completed'}}});}
});\n`);
  const broker = f.broker(); const c = broker.get(broker.create().id), notices = [];
  broker.on('notify', notice => { if (notice.kind === 'approval') notices.push(notice); });
  const { runId } = broker.start(c, { text: 'Add sessions', provider: 'codex', transport: 'app-server', requestId: 'real-adapter-question' });
  const active = broker.running;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { broker.off('update', check); reject(new Error('No question arrived.')); }, 5000);
    const check = () => { if (broker.view(c).pendingApprovals.length) { clearTimeout(timer); broker.off('update', check); resolve(); } };
    broker.on('update', check); check();
  });
  const pending = broker.view(c).pendingApprovals[0];
  assert.equal(pending.kind, 'question'); assert.equal(pending.runId, runId);
  assert.deepEqual(pending.questions.map(question => [question.id, question.header, question.other, question.options.map(option => [option.label, option.recommended])]), [['storage', 'Storage', false, [['Cookies (Recommended)', true], ['Database', false]]]]);
  assert.deepEqual(notices.map(notice => [notice.title, notice.body, notice.approvalId]), [['Codex has a question', 'Where should sessions be kept?', pending.id]]);
  assert.throws(() => broker.approve(runId, pending.id, true), { status: 409 }, 'A question is answered, not approved.');
  assert.throws(() => broker.answer(runId, pending.id, [['Redis']]), { status: 400 }, 'This question takes only its options.');
  assert.throws(() => broker.answer('another-run', pending.id, [['Database']]), { status: 409 });
  assert.equal(c.messages.some(m => /Keeping sessions/.test(m.text)), false, 'Codex waits for the answer.');
  assert.deepEqual(broker.answer(runId, pending.id, [['Database']]), { resolved: true });
  await active.done;
  assert.equal(c.status, 'complete');
  assert.ok(c.messages.some(m => m.text === 'Keeping sessions in Database'));
  assert.ok(c.messages.some(m => m.role === 'activity' && m.text === 'Answered:\nWhere should sessions be kept? → Database'), 'The conversation keeps what was asked and answered.');
  assert.throws(() => broker.answer(runId, pending.id, [['Database']]), { status: 409 });
  const messages = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.find(message => message.id === 78).result, { answers: { storage: { answers: ['Database'] } } });
});

test('a Codex async question crosses the worker and its answer steers the same live turn', { skip: scriptCLIs }, async t => {
  const f = setup(t), log = path.join(f.root, 'async-question-rpc.jsonl');
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('async-question-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'async-thread'},model:'actual-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'async-turn'}}});send({method:'item/completed',params:{threadId:'async-thread',item:{id:'ask',type:'agentMessage',text:'Do you have a Firebase project?',questions:[{title:'Do you have a Firebase project?',options:['No project yet','Yes']}]}}});send({method:'item/completed',params:{threadId:'async-thread',item:{id:'working',type:'agentMessage',text:'Continuing to inspect the code.'}}});}
if(message.method==='turn/steer'){send({id:message.id,result:{turnId:'async-turn'}});setTimeout(()=>{send({method:'item/completed',params:{threadId:'async-thread',item:{id:'answer',type:'agentMessage',text:'Received your project answer.'}}});send({method:'turn/completed',params:{threadId:'async-thread',turn:{id:'async-turn',status:'completed'}}});},50);}
});
`);
  const broker = f.broker(), c = broker.get(broker.create().id);
  const { runId } = broker.start(c, { text: 'Connect remotely', provider: 'codex', transport: 'app-server', requestId: 'async-question' });
  const active = broker.running;
  await new Promise((resolve, reject) => {
    // Codex asks and then keeps working, so wait for both: under load the second message can come a moment later.
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(broker.view(c).pendingApprovals.length ? 'Codex did not keep working without an answer.' : 'Async question did not arrive.')); }, 5000);
    const poll = setInterval(() => {
      if (!broker.view(c).pendingApprovals.length || !broker.view(c).canAddToRun || !c.messages.some(message => message.text === 'Continuing to inspect the code.')) return;
      clearTimeout(timer); clearInterval(poll); resolve();
    }, 10);
  });
  const pending = broker.view(c).pendingApprovals[0];
  assert.equal(pending.blocking, false);
  const result = await broker.answer(runId, pending.id, [['No project yet']], c);
  assert.equal(result.added, true); assert.equal(broker.view(c).pendingApprovals.length, 0);
  await active.done;
  assert.equal(c.status, 'complete');
  assert.ok(c.messages.some(message => message.role === 'user' && message.steer && /→ No project yet/.test(message.text)));
  const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const steered = requests.find(request => request.method === 'turn/steer');
  assert.equal(steered.params.threadId, 'async-thread');
  assert.equal(steered.params.expectedTurnId, 'async-turn');
  assert.match(steered.params.input[0].text, /→ No project yet/);
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
});

test('a long final Codex answer reaches the broker before its worker exits', { skip: scriptCLIs }, async t => {
  const f = setup(t);
  // The final item is far larger than a pipe buffer, so its IPC write is still pending when the turn ends.
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}\nimport readline from 'node:readline';
if(process.argv.includes('--version')){console.log('long-answer-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'long-thread'},model:'actual-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'long-turn'}}});send({method:'item/completed',params:{threadId:'long-thread',item:{id:'answer',type:'agentMessage',text:'x'.repeat(262144)}}});send({method:'turn/completed',params:{threadId:'long-thread',turn:{status:'completed'}}});}
});\n`);
  const broker = f.broker(); const c = broker.get(broker.create().id);
  const { runId } = broker.start(c, { text: 'Write a long answer', provider: 'codex', transport: 'app-server' });
  await broker.running.done;
  assert.equal(c.status, 'complete');
  assert.equal(c.messages.find(m => m.runId === runId && m.role === 'assistant')?.text.length, 262144);
});

test('the CLI worker forwards all provider output to a slow reader before it exits', { skip: scriptCLIs }, async t => {
  const f = setup(t), bin = path.join(f.root, 'large-output.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(1048576));\n`, { mode: 0o700 });
  const worker = fork(fileURLToPath(new URL('../src/provider-worker.mjs', import.meta.url)), [], { silent: true });
  worker.send({ type: 'start', config: { transport: 'cli', bin, args: [], workspace: f.workspace, prompt: '' } });
  // A busy broker reads slowly, so output is still queued in the worker when the CLI exits.
  let received = 0;
  worker.stdout.on('data', chunk => { received += chunk.length; worker.stdout.pause(); setTimeout(() => worker.stdout.resume(), 5); });
  await once(worker, 'close');
  assert.equal(received, 1048576);
});

test('Claude native rate-limit metadata distinguishes warnings from quota rejection', t => {
  const f = setup(t); const broker = f.broker(); const c = broker.get(broker.create().id);
  const run = { id: 'rate-test', c, provider: 'claude', failed: false };
  broker.event(run, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.9 } });
  assert.equal(run.failed, false);
  broker.event(run, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1234, rateLimitType: 'five_hour' } });
  assert.equal(run.failed, true); assert.equal(run.errorCategory, 'quota');
  const error = c.messages.find(m => m.role === 'error' && /usage limit reached/.test(m.text));
  assert.match(error.text, /5-hour window\. It resets /); assert.doesNotMatch(error.text, /[{}"]/, 'The notice is readable text, not raw provider JSON.');
});

test('fresh Codex CLI reconstruction retains non-Git opt-in and installed process guards', { skip: scriptCLIs }, async t => {
  const f = setup(t); const broker = f.broker(); const c = broker.get(broker.create().id);
  broker.start(c, { text: 'Initial', provider: 'codex' }); await broker.running.done;
  broker.start(c, { text: 'Reconstruct', provider: 'codex', fresh: true }); await broker.running.done;
  const captures = fs.readFileSync(path.join(f.workspace, '.mock-captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(captures.at(-1).args.includes('resume'), false);
  assert.equal(captures.at(-1).args.includes('--skip-git-repo-check'), true);
});
test('invalid Codex JSON-RPC fails before later valid responses can hide dropped events', { skip: scriptCLIs }, async t => {
  const f = setup(t); const executable = path.join(f.root, 'malformed.mjs');
  fs.writeFileSync(executable, `#!${process.execPath}\nimport readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log('invalid-json-protocol');console.log(JSON.stringify({id:m.id,result:{}}));});\n`, { mode: 0o700 });
  const client = new CodexClient({ bin: executable, cwd: f.workspace });
  try { await assert.rejects(client.initialize(), /protocol/); } finally { client.close(); }
});

test('Broker full auto-approval handles Codex tool requests without manual clicks and logs activity', { skip: scriptCLIs }, async t => {
  const f = setup(t); const log = path.join(f.root, 'rpc-auto.jsonl');
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('auto-approval-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'auto-thread'},model:'auto-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'auto-turn'}}});send({id:88,method:'item/commandExecution/requestApproval',params:{threadId:'auto-thread',turnId:'auto-turn',command:'auto-command',cwd:process.cwd()}});}
if(message.id===88&&message.result){send({method:'item/completed',params:{threadId:'auto-thread',item:{id:'answer',type:'agentMessage',text:message.result.decision==='accept'?'Auto-approved action finished':'Action declined'}}});send({method:'turn/completed',params:{threadId:'auto-thread',turn:{status:'completed'}}});}
});\n`);
  const broker = f.broker(); const c = broker.get(broker.create().id);
  broker.settings(c, { approvalPolicy: 'auto' });
  assert.equal(c.approvalPolicy, 'auto');
  const { runId } = broker.start(c, { text: 'Auto run', provider: 'codex', transport: 'app-server', approvalPolicy: 'auto', requestId: 'real-auto-approval' });
  const active = broker.running;
  assert.equal(active.approvalPolicy, 'auto');

  await active.done;
  assert.equal(c.status, 'complete');
  assert.ok(c.messages.some(m => m.text === 'Auto-approved action finished'));
  assert.ok(c.messages.some(m => m.role === 'activity' && m.text === 'Auto-approved: auto-command'), 'Codex asks only for what its sandbox blocks, so the run shows what was allowed.');
  const messages = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.find(message => message.id === 88).result, { decision: 'accept' });
});

test('Claude official SDK routes tool approvals to approval handler', async () => {
  let captured; let approvals = 0;
  async function* queryImpl(input) {
    captured = input.options;
    const allowed = await input.options.canUseTool('Bash', { command: 'npm test' }, { toolUseID: 'auto-one' });
    assert.equal(allowed.behavior, 'allow');
    assert.deepEqual(allowed.updatedInput, { command: 'npm test' });
    yield { type: 'system', subtype: 'init', model: 'effective-claude' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Done' };
  }
  await runClaude({ bin: '/installed/unmodified/claude', workspace: '/project', mode: 'edit', approvalPolicy: 'auto', prompt: 'Run tests' }, {
    queryImpl, event() {}, metadata() {}, approval: async request => { approvals++; assert.equal(request.id, 'auto-one'); return true; },
  });
  assert.equal(approvals, 1);
});

test('changing preference during a run preserves in-flight policy and existing pending requests', { skip: scriptCLIs }, async t => {
  const f = setup(t); const log = path.join(f.root, 'rpc-pending.jsonl');
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('pending-retention-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(message)+'\\n');
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'pending-thread'},model:'test-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'pending-turn'}}});send({id:55,method:'item/commandExecution/requestApproval',params:{threadId:'pending-thread',turnId:'pending-turn',command:'pending-command',cwd:process.cwd()}});}
if(message.id===55&&message.result){send({method:'item/completed',params:{threadId:'pending-thread',item:{id:'answer',type:'agentMessage',text:'Done'}}});send({method:'turn/completed',params:{threadId:'pending-thread',turn:{status:'completed'}}});}
});\n`);
  const broker = f.broker(); const c = broker.get(broker.create().id);
  const { runId } = broker.start(c, { text: 'Start with ask', provider: 'codex', transport: 'app-server', approvalPolicy: 'ask', requestId: 'pending-retention' });
  const active = broker.running;
  assert.equal(active.approvalPolicy, 'ask');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { broker.off('update', check); reject(new Error('No approval arrived.')); }, 5000);
    const check = () => { if (broker.view(c).pendingApprovals.length) { clearTimeout(timer); broker.off('update', check); resolve(); } };
    broker.on('update', check); check();
  });

  const pending = broker.view(c).pendingApprovals[0];
  assert.equal(pending.id, '55');

  // Change conversation settings while run is active - must fail because run is active
  assert.throws(() => broker.settings(c, { approvalPolicy: 'auto' }), { status: 409 });

  // Manually approve the pending request
  broker.approve(runId, pending.id, true);
  await active.done;
  assert.equal(c.status, 'complete');

  // Now change settings for subsequent runs
  broker.settings(c, { approvalPolicy: 'auto' });
  assert.equal(c.approvalPolicy, 'auto');
});

test('auto-approved run cancellation cleanly interrupts child and releases mutation lease', { skip: scriptCLIs }, async t => {
  const f = setup(t);
  fs.writeFileSync(f.bins.codex, `#!${process.execPath}\nimport readline from 'node:readline';
if(process.argv.includes('--version')){console.log('cancel-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'hang-thread'},model:'test-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'hang-turn'}}});setInterval(()=>{},1000);}
});\n`);
  const broker = f.broker(); const c = broker.get(broker.create().id);
  broker.start(c, { text: 'Hanging task', provider: 'codex', transport: 'app-server', approvalPolicy: 'auto', requestId: 'cancel-test' });
  const active = broker.running;
  assert.equal(active.approvalPolicy, 'auto');

  await new Promise(resolve => setTimeout(resolve, 300));
  broker.stop(c.id);
  await active.done;
  assert.equal(c.status, 'interrupted');
  assert.equal(broker.running, null);
});

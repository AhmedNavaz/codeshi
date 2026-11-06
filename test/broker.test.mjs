import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { Broker, commandFor } from '../src/broker.mjs';

const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));

function setup(t, scenarios = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-relay-test-'));
  const workspace = path.join(root, 'workspace with spaces');
  const dataDir = path.join(root, 'private-data');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify(scenarios));
  fs.writeFileSync(path.join(workspace, 'project.txt'), 'A local mock project.');
  const bins = {};
  for (const provider of ['codex', 'claude']) {
    bins[provider] = path.join(root, `${provider}-mock.mjs`);
    fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  }
  const options = { workspace, dataDir, bins };
  const brokers = [];
  function open() {
    const broker = new Broker(options);
    brokers.push(broker);
    return broker;
  }
  t.after(async () => {
    await Promise.all(brokers.map(broker => broker.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ...options, open, captures: () => {
    const filename = path.join(workspace, '.mock-captures.jsonl');
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : [];
  } };
}

function conversation(broker) {
  return broker.get(broker.create().id);
}

async function run(broker, c, text, provider, extra = {}) {
  const result = broker.start(c, { text, provider, mode: 'edit', ...extra });
  const active = broker.running;
  assert.equal(result.runId, active.id);
  await active.done;
  return result;
}

async function untilUpdate(broker, predicate) {
  if (predicate()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for mock provider output.')); }, 5000);
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timer); broker.off('update', check); };
    broker.on('update', check);
    check();
  });
}

test('cross-agent switches rebuild from shared history; same-agent turns resume only the current native session', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  let broker = env.open();
  let c = conversation(broker);
  const id = c.id;

  await run(broker, c, 'Build the first part', 'codex');
  assert.equal(c.status, 'complete');
  assert.equal(c.sessions.codex.id, 'codex-test-session');
  assert.ok(c.sessions.codex.cursor > 0);
  await run(broker, c, 'Improve it with Claude', 'claude');

  const claude = env.captures()[1];
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.cwd, fs.realpathSync(env.workspace));
  assert.ok(claude.context.context.some(m => m.role === 'assistant' && m.text === 'Codex: Build the first part'));
  assert.ok(claude.context.context.some(m => m.role === 'activity' && m.text.includes('project inspection retained')));
  assert.equal(claude.args.includes('--resume'), false);
  assert.equal(c.messages.filter(m => m.provider === 'claude' && m.role === 'assistant').length, 1, 'Claude deltas and final message must merge');
  assert.ok(c.messages.some(m => m.role === 'activity' && m.text.includes('Claude project inspection retained')));

  await broker.close();
  broker = env.open();
  c = broker.get(id);
  await run(broker, c, 'Finish with Codex', 'codex');
  const resumedCodex = env.captures()[2];
  assert.equal(resumedCodex.args.includes('resume'), false);
  assert.equal(c.lastRun.context.sessionMode, 'fresh');
  assert.equal(c.lastRun.context.sessionReason, 'cross-agent-handoff');
  assert.ok(resumedCodex.context.context.some(m => m.text === 'Claude: Improve it with Claude'));
  assert.ok(resumedCodex.context.context.some(m => m.text.includes('Claude project inspection retained')));
  assert(resumedCodex.context.context.some(m => m.text === 'Codex: Build the first part'), 'A different agent worked since the old native checkpoint.');
  assert.equal(resumedCodex.context.currentRequest, 'Finish with Codex');

  await run(broker, c, 'Review once more', 'claude');
  const resumedClaude = env.captures()[3];
  assert.equal(resumedClaude.args.includes('--resume'), false);
  assert.equal(c.lastRun.context.sessionReason, 'cross-agent-handoff');
  assert.ok(resumedClaude.context.context.some(m => m.text === 'Codex: Finish with Codex'));
  assert(resumedClaude.context.context.some(m => m.text === 'Claude: Improve it with Claude'));
  await run(broker, c, 'Same-agent follow-up', 'claude');
  const sameAgent = env.captures()[4];
  assert.equal(sameAgent.args[sameAgent.args.indexOf('--resume') + 1], 'claude-test-session');
  assert.equal(c.lastRun.context.sessionMode, 'resumed');
  assert.equal(c.lastRun.context.sessionReason, 'same-agent-continuation');
  assert.equal(sameAgent.context.context.some(m => m.text === 'Claude: Review once more'), false);
  assert.equal(c.status, 'complete');
  assert.equal(broker.running, null);
  assert.equal('sessions' in broker.view(c), false);
});

test('quota failure retains partial text and tool activity without committing its cursor', { skip: scriptCLIs }, async t => {
  const env = setup(t, { 'Hit the limit': { behavior: 'quota', text: 'I changed the first file, then stopped' } });
  const broker = env.open();
  const c = conversation(broker);
  await run(broker, c, 'Successful checkpoint', 'codex');
  const cursor = c.sessions.codex.cursor;
  const { runId } = await run(broker, c, 'Hit the limit', 'codex');

  assert.equal(c.status, 'incomplete');
  assert.equal(c.sessions.codex.cursor, cursor);
  assert.ok(c.messages.some(m => m.runId === runId && m.role === 'assistant' && m.status === 'incomplete' && m.text === 'I changed the first file, then stopped'));
  assert.ok(c.messages.some(m => m.runId === runId && m.role === 'activity' && m.text.includes('project inspection retained')));
  assert.ok(c.messages.some(m => m.runId === runId && m.role === 'error' && /Usage limit reached/.test(m.text)));

  await run(broker, c, 'Continue after the limit', 'claude');
  const shared = env.captures().at(-1).context.context;
  assert.ok(shared.some(m => m.text === 'I changed the first file, then stopped' && m.status === 'incomplete'));
  assert.ok(shared.some(m => m.role === 'activity' && m.text.includes('project inspection retained')));
});

test('restart recovers an unfinished run and repairs a torn final journal line', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const broker = env.open();
  const c = conversation(broker);
  await run(broker, c, 'Save a checkpoint', 'codex');
  const cursor = c.sessions.codex.cursor;
  broker.record(c, { type: 'run_start', id: 'interrupted-run', provider: 'codex' });
  broker.message(c, 'assistant', 'Saved before the process crashed', 'codex', 'crash-message', 'streaming');
  const filename = path.join(env.dataDir, `${c.id}.jsonl`);
  fs.appendFileSync(filename, '{"type":"message_update"');

  const restarted = env.open();
  const recovered = restarted.get(c.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.activeRun, null);
  assert.equal(recovered.sessions.codex.cursor, cursor);
  assert.equal(recovered.messages.find(m => m.id === 'crash-message').status, 'incomplete');
  assert.ok(recovered.messages.some(m => m.role === 'error' && /previous run was interrupted/.test(m.text)));
  for (const line of fs.readFileSync(filename, 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));

  await run(restarted, recovered, 'Continue after restarting', 'claude');
  assert.ok(env.captures().at(-1).context.context.some(m => m.text === 'Saved before the process crashed' && m.status === 'incomplete'));
});

test('a failed journal append is cut off so later records still load after a restart', t => {
  const env = setup(t);
  const broker = env.open();
  const c = conversation(broker);
  const { writeSync, fsyncSync } = fs;
  t.after(() => Object.assign(fs, { writeSync, fsyncSync }));
  // The disk fills partway through a record.
  let writes = 0;
  fs.writeSync = (fd, buffer, offset, length) => {
    if (writes++) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return writeSync(fd, buffer, offset, Math.ceil(length / 2));
  };
  assert.throws(() => broker.message(c, 'user', 'Lost when the disk filled', 'codex'), { code: 'ENOSPC' });
  fs.writeSync = writeSync;
  fs.fsyncSync = () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); };
  assert.throws(() => broker.message(c, 'user', 'Written but never synced', 'codex'), { code: 'EIO' });
  fs.fsyncSync = fsyncSync;
  broker.message(c, 'user', 'Saved after the disk recovered', 'codex');

  for (const line of fs.readFileSync(path.join(env.dataDir, `${c.id}.jsonl`), 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  assert.deepEqual(env.open().get(c.id).messages.map(m => m.text), ['Saved after the disk recovered']);
});

test('a journal left without a complete record does not stop the workspace from opening', t => {
  const env = setup(t);
  const kept = conversation(env.open());
  // A crash or a full disk while a new conversation writes its first record.
  fs.writeFileSync(path.join(env.dataDir, '00000000-0000-4000-8000-000000000001.jsonl'), '');
  fs.writeFileSync(path.join(env.dataDir, '00000000-0000-4000-8000-000000000002.jsonl'), '{"type":"created","title":"New conv');

  assert.deepEqual(env.open().list().map(row => row.id), [kept.id]);
});

test('signalling an exited process group on macOS counts as stopped, not as an error', t => {
  const kill = process.kill, platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => { process.kill = kill; Object.defineProperty(process, 'platform', platform); });
  process.kill = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
  const run = { child: { pid: 4242, kill() {} } };
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  assert.doesNotThrow(() => Broker.prototype.signal.call(null, run, 'SIGKILL'), 'macOS returns EPERM while the exited group awaits reaping.');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  assert.throws(() => Broker.prototype.signal.call(null, run, 'SIGKILL'), { code: 'EPERM' }, 'Elsewhere EPERM is a real permission error.');
});

test('restart recovers a run whose process group ID belongs to a process that started later, and refuses while its assistant is still working, even after the clock is set back', async t => {
  if (process.platform !== 'darwin') return t.skip('Process start times are read on macOS only.');
  const env = setup(t, { 'Keep working': { behavior: 'hang', text: 'Partial work' } });
  const broker = env.open();
  const c = conversation(broker);
  broker.start(c, { text: 'Keep working', provider: 'codex', mode: 'edit' });
  await untilUpdate(broker, () => c.messages.some(m => m.role === 'activity'));
  const records = fs.readFileSync(path.join(env.dataDir, `${c.id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  // Restarts from a copy of the journal saved so far, as after a crash, with the run's process record changed.
  const restart = change => {
    const dataDir = fs.mkdtempSync(path.join(path.dirname(env.dataDir), 'restart-'));
    fs.writeFileSync(path.join(dataDir, `${c.id}.jsonl`), `${records.map(record => JSON.stringify(record.type === 'run_process' ? change(record) : record)).join('\n')}\n`);
    const restarted = new Broker({ workspace: env.workspace, dataDir, bins: env.bins });
    t.after(() => restarted.close());
    return restarted;
  };
  // ps reports start times to the second, so the process that takes over the ID starts in a later second.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const later = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => later.kill());
  const recovered = restart(record => ({ ...record, pid: later.pid })).get(c.id);
  assert.equal(recovered.status, 'interrupted');
  assert.ok(recovered.messages.some(m => m.role === 'error' && /previous run was interrupted/.test(m.text)));
  // A run saved by an earlier version has no start time, so a live process group still counts as its assistant.
  assert.throws(() => restart(({ pidStart, ...record }) => ({ ...record, pid: later.pid })), { status: 409, message: /previous run may still be active \(process group \d+\)/ });
  // A backward clock correction after the assistant started makes its process record look older than the assistant.
  assert.throws(() => restart(record => ({ ...record, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })), { status: 409, message: /previous run may still be active/ });
});

test('rejects concurrent turns and preserves partial output when cancelled', { skip: scriptCLIs }, async t => {
  const env = setup(t, { 'Keep working': { behavior: 'hang', text: 'Partial work before cancellation' } });
  const broker = env.open();
  const c = conversation(broker);
  const other = conversation(broker);
  const { runId } = broker.start(c, { text: 'Keep working', provider: 'codex', mode: 'edit' });
  const active = broker.running;
  await untilUpdate(broker, () => c.messages.some(m => m.role === 'activity'));
  if (process.platform !== 'win32') {
    assert.throws(() => env.open(), /previous run may still be active/, 'restart must refuse an assistant process group that is still running');
  }
  assert.throws(() => broker.start(other, { text: 'Run concurrently', provider: 'claude', mode: 'edit' }), { status: 409 });
  assert.throws(() => broker.settings(c, { provider: 'claude' }), { status: 409 });
  assert.deepEqual(broker.stop(other.id), { stopped: false });
  assert.equal(broker.running, active);
  assert.deepEqual(broker.stop(c.id), { stopped: true });
  const completion = await active.done;
  assert.equal(completion.error, undefined, completion.error);

  assert.equal(c.status, 'interrupted');
  assert.equal(c.activeRun, null);
  assert.equal(broker.running, null);
  assert.equal(c.sessions.codex.cursor, 0);
  assert.ok(c.messages.some(m => m.runId === runId && m.role === 'assistant' && m.status === 'incomplete' && m.text === 'Partial work before cancellation'));
  assert.ok(c.messages.some(m => m.role === 'error' && /Files already changed/.test(m.text)));
  assert.deepEqual(broker.stop(c.id), { stopped: false });
  await run(broker, other, 'Start after stopping', 'claude');
  assert.equal(other.status, 'complete');
});

test('a run ended for an oversized provider event reports that, not a Stop', { skip: scriptCLIs }, async t => {
  const env = setup(t, { 'Send a huge event': { text: 'x'.repeat(9 * 1024 * 1024) } });
  const broker = env.open();
  const c = conversation(broker);
  await run(broker, c, 'Send a huge event', 'codex');
  assert.equal(c.status, 'incomplete');
  assert.equal(c.lastRun.errorCategory, 'protocol');
  const errors = c.messages.filter(m => m.role === 'error').map(m => m.text);
  assert.deepEqual(errors.map(text => text.split('\n')[0]), ['Oversized provider protocol event.']);
  assert.doesNotMatch(errors[0], /JSON/, 'The cut-off rest of the event is not parsed.');
});

test('a run ended after a provider message could not be handled reports that failure, even if Stop follows', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  fs.writeFileSync(env.bins.codex, `#!${process.execPath}\nimport readline from 'node:readline';
if(process.argv.includes('--version')){console.log('handler-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='initialize')send({id:message.id,result:{}});
if(message.method==='model/list')send({id:message.id,result:{data:[]}});
if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'handler-thread'},model:'actual-model'}});
if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'handler-turn'}}});send({method:'item/completed',params:{threadId:'handler-thread',item:{id:'answer',type:'agentMessage',text:'An answer'}}});send({method:'turn/completed',params:{threadId:'handler-thread',turn:{status:'completed'}}});}
});\n`);
  const broker = env.open();
  const c = conversation(broker);
  // Stands in for any failure while the broker handles a provider message, such as a journal write that fails.
  const handle = broker.event.bind(broker);
  const signals = [], signal = broker.signal.bind(broker);
  broker.signal = (active, name) => { signals.push(name); return signal(active, name); };
  let stop;
  broker.event = (active, event) => {
    if (event.item?.type !== 'agent_message') return handle(active, event);
    // Stop arrives while the failed run is still ending.
    setImmediate(() => { stop = broker.stop(c.id); });
    throw new Error('Could not save the answer.');
  };
  await run(broker, c, 'Answer', 'codex', { transport: 'app-server' });
  assert.deepEqual(stop, { stopped: true });
  assert.equal(signals.filter(name => name === 'SIGTERM').length, 1, 'Stop does not end the process a second time.');
  assert.equal(c.status, 'incomplete');
  assert.deepEqual(c.messages.filter(m => m.role === 'error').map(m => m.text.split('\n')[0]), ['Could not save the answer.']);
});

test('a view can hold only the messages changed after a record, unless an import may have moved them', t => {
  const env = setup(t), broker = env.open(), c = conversation(broker);
  broker.message(c, 'system', 'one', 'codex', 'm1');
  broker.message(c, 'system', 'two', 'codex', 'm2');
  const whole = broker.view(c);
  assert.equal(whole.messageCount, undefined, 'A whole view does not need a count.');
  assert.equal(whole.cursor, c.records);
  assert.deepEqual(whole.messages.map(message => message.id), ['m1', 'm2']);

  const nothing = broker.view(c, { since: whole.cursor });
  assert.deepEqual(nothing.messages, []);
  assert.equal(nothing.messageCount, 2);

  broker.message(c, 'system', 'two and more', 'codex', 'm2');
  broker.message(c, 'system', 'three', 'codex', 'm3');
  const update = broker.view(c, { since: whole.cursor });
  assert.deepEqual(update.messages.map(message => [message.id, message.text]), [['m2', 'two and more'], ['m3', 'three']]);
  assert.equal(update.messageCount, 3);
  assert.equal(update.cursor, c.records);
  assert.equal('seq' in update.messages[0], false, 'Journal details stay out of the view.');

  for (const since of [c.records + 1, NaN, -0.5, null]) assert.equal(broker.view(c, { since }).messageCount, undefined, `${since} is no usable position, so the view is whole.`);

  const before = c.records;
  broker.record(c, { type: 'import', importId: 'old', messages: [{ id: 'i1', role: 'user', text: 'Imported', importSource: 'old' }], after: { i1: null } });
  assert.deepEqual(broker.view(c, { since: before }).messages.map(message => message.id), ['i1', 'm1', 'm2', 'm3'], 'An import can put messages anywhere, so a copy from before it gets them all.');
  assert.equal(broker.view(c, { since: before }).messageCount, undefined);
  assert.equal(broker.view(c, { since: c.records }).messageCount, 4, 'A copy from after it gets just the changes again.');
  assert.equal(env.open().view(env.open().get(c.id), { since: before }).messageCount, undefined, 'That holds after a restart too.');
});

test('requires both a successful terminal event and a successful process exit', { skip: scriptCLIs }, async t => {
  const env = setup(t, {
    'Missing terminal event': { behavior: 'no-terminal' },
    'Terminal but bad exit': { behavior: 'bad-exit' },
    'Permission denied': { behavior: 'permission-denied' },
  });
  const broker = env.open();
  const c = conversation(broker);
  for (const text of ['Missing terminal event', 'Terminal but bad exit']) {
    await run(broker, c, text, 'codex');
    assert.equal(c.status, 'incomplete');
    assert.equal(c.sessions.codex.cursor, 0);
  }
  await run(broker, c, 'Permission denied', 'claude');
  assert.equal(c.status, 'incomplete');
  assert.equal(c.sessions.claude.cursor, 0);
  // One plain error: no raw JSON, no second "exit 0" message, and no talk of a terminal that nothing was waiting in (#112).
  const errors = c.messages.filter(m => m.role === 'error' && m.runId === c.runs.at(-1).id || m.role === 'error' && /permission/.test(m.text));
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /couldn't get permission to use Bash/);
  assert.doesNotMatch(errors[0].text, /native terminal|tool_name|exit 0/);
});

test('a recovered Codex connection diagnostic does not fail a completed turn', { skip: scriptCLIs }, async t => {
  const env = setup(t, { 'Recover the connection': { behavior: 'reconnect' } });
  const broker = env.open();
  const c = conversation(broker);
  await run(broker, c, 'Recover the connection', 'codex');
  assert.equal(c.status, 'complete');
  assert.ok(c.sessions.codex.cursor > 0);
  assert.ok(c.messages.some(m => m.role === 'activity' && /Reconnecting/.test(m.text)));
  assert.equal(c.messages.some(m => m.role === 'error'), false);
  assert.ok(c.messages.some(m => m.role === 'assistant' && m.status === 'complete'));
});

test('fresh sessions replay shared history and omit native resume flags', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const broker = env.open();
  const c = conversation(broker);
  await run(broker, c, 'Prior task', 'codex');
  await run(broker, c, 'Fresh context', 'codex', { fresh: true });
  const capture = env.captures().at(-1);
  assert.equal(capture.args.includes('resume'), false);
  assert.ok(capture.context.context.some(m => m.text === 'Codex: Prior task'));
});

test('command construction preserves CLI permissions and passes paths without a shell', () => {
  const codex = commandFor('codex', { mode: 'read', sessionId: 'thread-123', bin: '/a path/codex' });
  assert.equal(codex.bin, '/a path/codex');
  assert.deepEqual(codex.args, ['--ask-for-approval', 'never', '--sandbox', 'read-only', 'exec', 'resume', 'thread-123', '--json', '-']);
  const claude = commandFor('claude', { mode: 'read', sessionId: 'session-123' });
  assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(claude.args[claude.args.indexOf('--resume') + 1], 'session-123');
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(claude.args[claude.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.equal(claude.args.some(arg => /dangerously|skip-permissions|bypass/.test(arg)), false);
  assert.throws(() => commandFor('unknown', { mode: 'edit' }), { status: 400 });
});

test('approval policy enforces permission scope, rejects incompatible read-only auto-approval and persists per workspace', async t => {
  const env = setup(t);
  const broker = env.open();
  const c = conversation(broker);

  // New conversation defaults to 'ask'
  assert.equal(c.approvalPolicy, 'ask');
  assert.equal(broker.view(c).approvalPolicy, 'ask');

  // Incompatible combination: read-only with auto-approval is rejected
  assert.throws(() => commandFor('codex', { mode: 'read', approvalPolicy: 'auto' }), { status: 400, category: 'permission' });
  assert.throws(() => broker.settings(c, { mode: 'read', approvalPolicy: 'auto' }), { status: 400, category: 'permission' });
  assert.throws(() => broker.start(c, { text: 'Hello', mode: 'read', approvalPolicy: 'auto', provider: 'codex' }), { status: 400, category: 'permission' });
  assert.throws(() => broker.settings(c, { approvalPolicy: 'unsupported' }), { status: 400 });

  // Update approvalPolicy to auto in edit mode
  broker.settings(c, { approvalPolicy: 'auto' });
  assert.equal(c.approvalPolicy, 'auto');
  assert.equal(broker.view(c).approvalPolicy, 'auto');

  // Reopen broker and verify approvalPolicy is restored from journal
  const reopened = env.open();
  const restored = reopened.get(c.id);
  assert.equal(restored.approvalPolicy, 'auto');
  assert.equal(reopened.view(restored).approvalPolicy, 'auto');

  // Importing external transcript never imports or changes approvalPolicy
  const preview = {
    provider: 'codex',
    sessionId: 'session-xyz',
    digest: 'abc123',
    approvalPolicy: 'ask',
    messages: [{ sourceId: 'msg-1', text: 'External task', role: 'user', timestamp: new Date().toISOString() }],
  };
  restored.imports = {};
  reopened.importTranscript(restored, preview);
  assert.equal(restored.approvalPolicy, 'auto');
});

test('quota handoff to Gemini and back to either cloud agent rebuilds intent from the canonical journal', { skip: scriptCLIs }, async t => {
  const env = setup(t, { 'Quota stop': { behavior: 'quota' } });
  const gemini = path.join(path.dirname(env.workspace), 'gemini-acp.mjs');
  fs.writeFileSync(gemini, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'gemini-native',models:{currentModelId:'gemini-test'}}});
if(m.method==='session/prompt'){
const prompt=m.params.prompt.find(item=>item.type==='text').text;
fs.writeFileSync('gemini-context.json',prompt);
emit({method:'session/update',params:{sessionId:'gemini-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Gemini continued from shared history.'}}}});
emit({id:m.id,result:{stopReason:'end_turn'}});
}}
`, { mode: 0o700 });
  env.bins.gemini = gemini;
  const broker = env.open(), c = conversation(broker);
  await run(broker, c, 'Keep user edits and implement the requested feature', 'claude');
  await run(broker, c, 'Quota stop', 'codex'); assert.equal(c.lastRun.errorCategory, 'quota');
  for(let i=0;i<40;i++) broker.message(c, 'activity', '$ npm test\n' + 'verbose output\n'.repeat(1000), 'codex');
  await run(broker, c, 'Continue the unfinished task from this shared conversation. Inspect the current files and saved activity first, and finish what remains.', 'gemini', { model:'gemini-test', mode:'read' });
  assert.equal(c.status, 'complete'); assert.equal(c.lastRun.context.sessionMode, 'fresh');
  const googlePrompt = fs.readFileSync(path.join(env.workspace,'gemini-context.json'),'utf8'), googleContext = JSON.parse(googlePrompt.slice(googlePrompt.indexOf('\n')+1));
  assert(googleContext.context.some(item=>item.text==='Keep user edits and implement the requested feature'));
  assert.equal(googleContext.continuation.previousErrorCategory,'quota');
  assert(googleContext.compactedActivityMessages>0);
  await run(broker,c,'Continue with Claude','claude');
  const claude=env.captures().at(-1);assert.equal(claude.args.includes('--resume'),false);assert(claude.context.context.some(item=>item.text==='Gemini continued from shared history.'));
  assert.equal(c.lastRun.context.sessionReason,'cross-agent-handoff');
  await run(broker,c,'Continue with Codex','codex');
  const codex=env.captures().at(-1);assert.equal(codex.args.includes('resume'),false);assert.equal(c.lastRun.context.sessionReason,'cross-agent-handoff');
});

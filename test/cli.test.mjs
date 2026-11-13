import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scriptCLIs } from './platform.mjs';
import { createRelayServer } from '../src/server.mjs';
import { EXIT, chooseWorkspace, connectionCandidates, consoleInput, describePending, main, parseArgs, readConnection } from '../src/cli.mjs';
import { commandState, installCommand, removeConnection, uninstallCommand, windowsCommandLink, writeConnection } from '../desktop/cli.mjs';
import { menuTemplate } from '../desktop/menu.mjs';

// The codeshi command (#90): a client of the open app's engine, tested against the real server and the mock agent.
const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url)), entry = fileURLToPath(new URL('../bin/codeshi.mjs', import.meta.url));
const until = async (check, what) => { for (let i = 0; i < 1500; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Timed out waiting for ${what}.`); };

async function engine(t, scenarios = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-cli-'))), workspace = path.join(root, 'app'), bins = {};
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify(scenarios));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  for (const provider of ['codex', 'claude']) { bins[provider] = path.join(root, `${provider}-mock.mjs`); fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 }); }
  bins.gemini = path.join(root, 'missing-gemini');
  const token = 'cli-test-token', app = createRelayServer({ workspace, dataRoot: path.join(root, 'data'), bins, accessToken: token });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`, file = path.join(root, 'cli.json');
  writeConnection(file, { url, token, version: 'test' });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = app.registry.list()[0], broker = app.registry.broker(project.id);
  const env = { root, workspace, app, url, token, file, project, broker,
    get c() { return broker.get(app.registry.mainConversation(project.id).id); },
    release: () => fs.writeFileSync(path.join(workspace, '.release'), ''),
    // As the window sends a message.
    send: async text => (await fetch(`${url}/api/conversations/${env.c.id}/messages?projectId=${project.id}`, { method: 'POST', headers: { 'x-ai-relay-token': token, 'x-ai-relay': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text, provider: 'codex', requestId: `app-${Math.random().toString(36).slice(2)}` }) })).json(),
    // The command in this process, with its own streams, from a folder inside the workspace.
    cli: async (args, { cwd = path.join(workspace, 'src'), input = null, signals = new EventEmitter(), connection = file, terminal = null } = {}) => {
      const stdout = new PassThrough(), stderr = new PassThrough(), stdin = terminal || new PassThrough(); let out = '', err = '';
      if (terminal) { stderr.isTTY = true; stderr.on('data', chunk => terminal.onPrompt?.(String(chunk))); }
      stdout.on('data', chunk => { out += chunk; }); stderr.on('data', chunk => { err += chunk; });
      if (input !== null) stdin.end(input); else if (!terminal) stdin.isTTY = false;
      const code = await main(args, { stdin, stdout, stderr, cwd, env: { CODESHI_CONNECTION: connection }, version: '9.9.9', signals });
      return { code, out, err, json: () => JSON.parse(out) };
    },
  };
  return env;
}

test('arguments are checked before anything is sent', () => {
  assert.deepEqual(parseArgs(['run', 'Fix', 'the', 'login', '-a', 'claude', '--json']).words, ['Fix', 'the', 'login']);
  assert.equal(parseArgs(['run', '--agent=gemini', 'x']).agent, 'gemini');
  assert.equal(parseArgs([]).command, 'session');
  assert.equal(parseArgs(['-a', 'claude']).agent, 'claude');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.equal(parseArgs(['run', 'x', '--flow', 'Saver']).flow, 'saver');
  assert.equal(parseArgs(['--flow=off', '-a', 'claude']).flow, 'off', 'Turning Flow off and naming the agent go together.');
  for (const [args, message] of [[['run', 'x', '--flow', 'fast'], /smart, saver, ultra or off/], [['continue', '--flow', 'smart'], /--flow applies to run and the session/], [['run', 'x', '--flow', 'smart', '--agent', 'codex'], /not both/], [['launch'], /Unknown command launch/], [['run', '--agent', 'gpt'], /codex, claude or gemini/], [['status', '--agent', 'codex'], /apply to run, continue and the session/], [['--json'], /The session is interactive/], [['run', 'x', '--json', '--jsonl'], /--json or --jsonl/], [['wait', 'now'], /takes no message/], [['run', '--model'], /needs a value/], [['tasks', '--detach'], /applies to run and continue/], [['run', '--force', 'x'], /Unknown option --force/]]) {
    assert.throws(() => parseArgs(args), error => message.test(error.message) && error.code === EXIT.usage, args.join(' '));
  }
});

test('the connection file is readable only by its owner and removed only by the app that wrote it', { skip: process.platform === 'win32' && 'Windows has no Unix file modes' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-cli-file-')), file = path.join(root, 'cli.json');
  try {
    writeConnection(file, { url: 'http://127.0.0.1:4100', token: 'secret', version: '1.0.0' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, url: 'http://127.0.0.1:4100', token: 'secret', pid: process.pid, appVersion: '1.0.0' });
    assert.equal(readConnection([path.join(root, 'missing.json'), file]).url, 'http://127.0.0.1:4100');
    removeConnection(file, process.pid + 1); assert(fs.existsSync(file), 'Another copy of the app quitting leaves it.');
    removeConnection(file); assert(!fs.existsSync(file));
    // A file left by an app that crashed points at nothing.
    writeConnection(file, { url: 'http://127.0.0.1:4100', token: 'secret', pid: 2 ** 22 + 7 });
    assert.throws(() => readConnection([file]), error => error.code === EXIT.unavailable && /isn't open/.test(error.message));
    assert.deepEqual(connectionCandidates({ env: {}, platform: 'darwin', home: '/Users/me' }).slice(0, 2), ['/Users/me/Library/Application Support/Codeshi/cli.json', '/Users/me/Library/Application Support/Throughline/cli.json']);
    assert.deepEqual(connectionCandidates({ env: { CODESHI_CONNECTION: '/x/cli.json' } }), ['/x/cli.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the workspace is the one holding the current folder, the deepest when nested, or the one named', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-cli-ws-')));
  try {
    for (const folder of ['a/inner/deep', 'b', 'c']) fs.mkdirSync(path.join(root, folder), { recursive: true });
    const projects = [{ id: 'p1', name: 'Outer', folders: [{ path: path.join(root, 'a') }] }, { id: 'p2', name: 'Inner', folders: [{ path: path.join(root, 'a', 'inner') }, { path: path.join(root, 'b') }] }];
    assert.equal(chooseWorkspace(projects, { cwd: path.join(root, 'a', 'inner', 'deep') }).id, 'p2');
    assert.equal(chooseWorkspace(projects, { cwd: path.join(root, 'a') }).id, 'p1');
    assert.equal(chooseWorkspace(projects, { cwd: path.join(root, 'b') }).id, 'p2');
    assert.equal(chooseWorkspace(projects, { name: 'outer', cwd: path.join(root, 'b') }).id, 'p1');
    assert.equal(chooseWorkspace(projects, { name: path.join(root, 'b'), cwd: root }).id, 'p2');
    assert.throws(() => chooseWorkspace(projects, { cwd: path.join(root, 'c') }), /isn't in a Codeshi workspace.*Outer, Inner/);
    assert.throws(() => chooseWorkspace(projects, { name: 'Nope', cwd: root }), /No workspace is called Nope/);
    assert.equal(chooseWorkspace([projects[0]], { cwd: path.join(root, 'c') }).id, 'p1', 'With one workspace, it is that one.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('approvals and questions are described in general words', () => {
  assert.deepEqual(describePending({ provider: 'codex', kind: 'item/commandExecution/requestApproval', command: 'npm install left-pad' }), { kind: 'approval', summary: 'Codex wants to run a command', detail: 'npm install left-pad' });
  assert.deepEqual(describePending({ provider: 'claude', kind: 'Edit', input: { file_path: 'src/app.js' } }), { kind: 'approval', summary: 'Claude wants to change files', detail: 'src/app.js' });
  assert.equal(describePending({ provider: 'claude', kind: 'question', questions: [{ question: 'Which database?' }] }).summary, 'Claude has a question: Which database?');
});

test('a run started from the terminal is the workspace chat’s run: the app sees it, and its reply is printed', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Explain the build': { text: 'It builds with esbuild.' } });
  const result = await env.cli(['run', 'Explain', 'the', 'build', '--agent', 'codex']);
  assert.equal(result.code, EXIT.ok, result.err);
  assert.equal(result.out, 'It builds with esbuild.\n', 'Only the reply goes to standard output.');
  assert.match(result.err, /Codex is working in app…/); assert.match(result.err, /\$ inspect-project/, 'Progress goes to standard error.');
  // The same run, in the same journal the window reads.
  const c = env.c;
  assert.equal(c.lastRun.status, 'complete'); assert.equal(c.lastRun.provider, 'codex');
  assert.deepEqual(c.messages.filter(message => message.role === 'user').map(message => message.text), ['Explain the build']);

  const json = await env.cli(['wait', '--json']);
  assert.equal(json.code, EXIT.ok);
  assert.deepEqual({ ...json.json(), conversationId: null, runId: null, taskId: null }, { v: 1, result: 'complete', workspace: { id: env.project.id, name: 'app' }, conversationId: null, runId: null, taskId: null, agent: 'codex', model: null, routing: null, reply: 'It builds with esbuild.', error: null, errorCategory: null });
  assert.equal(json.json().runId, c.lastRun.id, 'wait with nothing working reports the last run.');

  const piped = await env.cli(['run', '--jsonl'], { input: 'Explain the build\n' });
  assert.equal(piped.code, EXIT.ok, piped.err);
  const events = piped.out.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type).sort(), ['activity', 'message', 'result', 'started']); assert.equal(events[0].type, 'started'); assert.equal(events.at(-1).type, 'result');
  assert(events.every(event => event.v === 1 && (event.type === 'result' || event.runId === events[0].runId)));
  assert.equal(events.at(-1).reply, 'It builds with esbuild.');
});

// Flow's routing reads each agent's account, models and usage; these stand in for a connected Codex on a subscription.
const flowModels = [{ id: 'gpt-6.1-sol', displayName: 'Codex', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }, { id: 'gpt-6-luna', displayName: 'Mini', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
function connectFlow(broker, { billingSource = 'subscription' } = {}) {
  broker.availableProviders = () => ['codex'];
  broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource });
  broker.handoff.models = async () => ({ data: flowModels });
  broker.checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }] });
}

test('in Flow, a message from the terminal is placed by the engine, as one from the window is (#90, #12)', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Fix the typo in the README': { text: 'Fixed.' }, 'Explain the build': { text: 'It builds with esbuild.' } });
  connectFlow(env.broker);

  // --flow turns Flow on for the workspace, as Flow's switch in the window does, and Saver places the message by local rules.
  const routed = await env.cli(['run', 'Fix', 'the', 'typo', 'in', 'the', 'README', '--flow', 'saver']);
  assert.equal(routed.code, EXIT.ok, routed.err);
  assert.equal(routed.out, 'Fixed.\n');
  assert.equal(env.c.routing.mode, 'saver', 'The workspace is in Flow, so the window shows it too.');
  assert.equal(env.c.lastRun.routing.mode, 'saver'); assert.equal(env.c.lastRun.provider, 'codex'); assert.equal(env.c.lastRun.effort, 'low', 'Saver keeps effort low.');
  assert.equal(env.c.messages.findLast(message => message.role === 'user').routing.ratedBy, 'local', 'The engine rated it, not the command.');
  assert.match(routed.err, /Flow \(Saver\) is choosing an agent…/); assert.match(routed.err, /Flow \(Saver\) chose Codex · gpt-6-luna · low: .+\.\nCodex is working in app…/, 'A typo goes to the light model.');

  // Without --flow, the next message follows the workspace's setting, and the result and events say what Flow chose.
  const events = await env.cli(['run', 'Explain the build', '--jsonl']);
  assert.equal(events.code, EXIT.ok, events.err);
  const lines = events.out.trim().split('\n').map(line => JSON.parse(line)), started = lines.find(event => event.type === 'started'), result = lines.at(-1);
  assert.equal(started.routing.mode, 'saver'); assert.equal(typeof started.routing.reason, 'string');
  assert.deepEqual(result.routing, started.routing); assert.equal(result.agent, 'codex');

  // Naming the agent sends this one message to it, unrouted; Flow stays on for the next.
  const named = await env.cli(['run', 'Explain the build', '--agent', 'codex', '--json']);
  assert.equal(named.code, EXIT.ok, named.err);
  assert.equal(named.json().routing, null); assert.equal(env.c.lastRun.routing, undefined);
  assert.equal(env.c.routing.mode, 'saver');

  // --flow off leaves Flow; messages go to the agent picked in the app again.
  const off = await env.cli(['run', 'Explain the build', '--flow', 'off', '--json']);
  assert.equal(off.code, EXIT.ok, off.err);
  assert.equal(env.c.routing, null); assert.equal(off.json().routing, null);
});

test('codeshi wait while Flow is still rating a message follows on to the run it starts', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Explain the build': { text: 'It builds with esbuild.' } });
  connectFlow(env.broker);
  env.broker.setRouting(env.c, { mode: 'smart' });
  let rate; const rated = new Promise(resolve => { rate = resolve; });
  env.broker.router.worker = async () => { await rated; return JSON.stringify({ tier: 'standard', effort: 'medium', reason: 'Explains the build setup' }); };
  const sending = env.broker.dispatch(env.c, { text: 'Explain the build', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'window-send', routing: { mode: 'smart' } });
  await until(() => env.broker.view(env.c).activeRun?.purpose === 'routing' && env.broker.running?.assessorStarted, 'Flow to start rating');
  const waiting = env.cli(['wait']);
  await new Promise(resolve => setTimeout(resolve, 200));
  rate(); await sending;
  const result = await waiting;
  assert.equal(result.code, EXIT.ok, result.err);
  assert.equal(result.out, 'It builds with esbuild.\n');
  assert.match(result.err, /Flow is choosing an agent…\nFlow \(Smart\) chose Codex · gpt-6\.1-sol · medium: Explains the build setup\.\nCodex is working/);
});

test('codeshi stop while Flow rates a message from codeshi run ends it as stopped, with nothing run', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Explain the build': { text: 'It builds with esbuild.' } });
  connectFlow(env.broker);
  env.broker.setRouting(env.c, { mode: 'smart' });
  env.broker.router.worker = (_broker, run) => new Promise((resolve, reject) => { const check = setInterval(() => { if (run.stopped) { clearInterval(check); reject(new Error('stopped')); } }, 10); });
  const running = env.cli(['run', 'Explain the build', '--json']);
  await until(() => env.broker.running?.assessorStarted, 'Flow to start rating');
  const stop = await env.cli(['stop', '--json']);
  assert.equal(stop.json().result, 'stopped');
  const result = await running;
  assert.equal(result.code, EXIT.failed, result.err);
  assert.equal(result.json().result, 'stopped'); assert.equal(result.json().runId, null);
  assert.equal(env.c.lastRun, null, 'No agent started.');
});

test('in Flow, the terminal never agrees to charges: an agent that bills by use is refused, and says how to send it', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Fix the typo in the README': { text: 'Fixed.' } });
  connectFlow(env.broker, { billingSource: 'api' });
  env.broker.setRouting(env.c, { mode: 'saver', allowApi: true });
  const refused = await env.cli(['run', 'Fix the typo in the README', '--json']);
  assert.equal(refused.code, EXIT.failed);
  assert.equal(refused.json().result, 'error');
  assert.match(refused.json().error, /bills by use, and the terminal never agrees to charges.*--agent/);
  assert.equal(env.c.lastRun, null, 'No agent started.');
});

test('a run started in the app is followed, refused a second start, and stopped from the terminal', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Hold the build': { behavior: 'hold', text: 'Held, then done.' } });
  const { runId } = await env.send('Hold the build');
  await until(() => env.broker.running, 'the run to start');
  const busy = await env.cli(['run', 'Something else', '--json']);
  assert.equal(busy.code, EXIT.busy); assert.match(busy.json().error, /already working in app.*codeshi wait.*codeshi stop/);
  assert.equal(env.c.messages.filter(message => message.role === 'user').length, 1, 'Nothing else was sent.');

  const status = await env.cli(['status', '--json'], { cwd: env.workspace });
  assert.deepEqual(status.json().workspaces.map(({ name, working, waiting, current }) => ({ name, working, waiting, current })), [{ name: 'app', working: true, waiting: 0, current: true }]);

  const following = env.cli(['wait', '--json']);
  await new Promise(resolve => setTimeout(resolve, 200)); env.release();
  const waited = await following;
  assert.equal(waited.code, EXIT.ok); assert.equal(waited.json().runId, runId); assert.equal(waited.json().reply, 'Held, then done.');

  fs.rmSync(path.join(env.workspace, '.release'));
  await env.send('Hold the build').catch(() => {});
  await env.cli(['run', 'Hold the build', '--detach']).then(result => assert.equal(result.code, EXIT.busy, 'A duplicate start is refused while it runs.'));
  const stopped = await env.cli(['stop']);
  assert.equal(stopped.code, EXIT.ok); assert.match(stopped.err, /Stopped the run in app/);
  await until(() => !env.broker.running, 'the run to stop');
  const after = await env.cli(['wait', '--json']);
  assert.equal(after.code, EXIT.failed); assert.equal(after.json().result, 'stopped');
  assert.match((await env.cli(['stop'])).err, /Nothing is working in app/);
});

test('without a terminal, a waiting approval ends the command with needs_input and leaves the run waiting', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Hold for approval': { behavior: 'hold' } });
  await env.send('Hold for approval');
  const run = await until(() => env.broker.running, 'the run to start');
  run.approvals.set('a1', { id: 'a1', runId: run.id, provider: 'codex', kind: 'item/commandExecution/requestApproval', command: 'npm publish' });
  const result = await env.cli(['wait', '--json']);
  assert.equal(result.code, EXIT.needsInput);
  assert.deepEqual(result.json().pending, [{ id: 'a1', kind: 'approval', summary: 'Codex wants to run a command', detail: 'npm publish' }]);
  assert(env.broker.running && run.approvals.has('a1'), 'Nothing was approved or stopped: the absence of a terminal never answers.');
  const plain = await env.cli(['wait']);
  assert.equal(plain.code, EXIT.needsInput); assert.match(plain.err, /Codex wants to run a command:\n {4}npm publish\nIt waits for you in Codeshi/);
  run.approvals.delete('a1'); env.release();
  await until(() => !env.broker.running, 'the run to finish');
});

test('in a terminal, an approval is answered there, or in the app, whichever comes first', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Hold for the terminal': { behavior: 'hold', text: 'All done.' } });
  const terminal = new PassThrough(); terminal.isTTY = true;
  let prompts = 0; terminal.onPrompt = text => { if (text.startsWith('Allow?')) prompts++; };
  const following = env.cli(['run', 'Hold for the terminal'], { terminal });
  const run = await until(() => env.broker.running, 'the run to start');
  run.approvals.set('a1', { id: 'a1', runId: run.id, provider: 'codex', kind: 'item/commandExecution/requestApproval', command: 'npm test', scope: { key: 'npm test', label: 'npm test' } });
  env.broker.emit('update', { conversationId: run.c.id });
  await until(() => prompts === 1, 'the terminal to ask');
  terminal.write('maybe\n');
  await until(() => prompts === 2, 'the terminal to ask again after an unclear answer');
  assert(run.approvals.has('a1'), 'An unclear answer answers nothing.');
  terminal.write('r\n');
  await until(() => !run.approvals.has('a1'), 'the approval to be answered');
  assert(run.allowances?.has('npm test'), 'r allows it for the rest of this run.');
  // Answered in the app while the terminal asks.
  run.approvals.set('a2', { id: 'a2', runId: run.id, provider: 'codex', kind: 'item/commandExecution/requestApproval', command: 'npm run lint' });
  env.broker.emit('update', { conversationId: run.c.id });
  await until(() => prompts === 3, 'the terminal to ask about the second');
  env.broker.approve(run.id, 'a2', false);
  env.release();
  const result = await following;
  assert.equal(result.code, EXIT.ok, result.err);
  const lines = result.err.split('\n').map(line => line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim());
  const order = ['npm test', 'Allowed for this run: npm test', 'npm run lint', 'Answered in Codeshi.', 'Approval denied by the user.'].map(text => lines.indexOf(text));
  assert(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), result.err);
  assert.equal(result.out, 'All done.\n');
});

test('Ctrl+C stops following and leaves the run working', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Hold on': { behavior: 'hold' } });
  const signals = new EventEmitter();
  const following = env.cli(['run', 'Hold on', '--jsonl'], { signals });
  await until(() => env.broker.running, 'the run to start');
  // Pressed while following, after the run has started and been reported.
  await until(() => signals.listenerCount('SIGINT') === 1 && env.c.messages.some(message => message.role === 'activity'), 'the run to be followed');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(signals.listenerCount('SIGINT'), 1, 'Ctrl+C is still handled while the run is followed.');
  signals.emit('SIGINT');
  const result = await following;
  assert.equal(result.code, EXIT.detached);
  assert.equal(JSON.parse(result.out.trim().split('\n').at(-1)).result, 'detached');
  assert(env.broker.running, 'The run carries on in Codeshi.');
  assert.equal(signals.listenerCount('SIGINT'), 0, 'The command leaves no handler behind.');
  env.release(); await until(() => !env.broker.running, 'the run to finish');
});

test('a closed pipe on standard output stops following and leaves the run working', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Hold the pipe': { behavior: 'hold' } });
  const child = spawn(process.execPath, [entry, 'run', 'Hold the pipe', '--jsonl'], { cwd: env.workspace, env: { ...process.env, CODESHI_CONNECTION: env.file }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', chunk => { err += chunk; });
  // Like head -1: read the first line, then close the pipe.
  await once(child.stdout, 'data'); child.stdout.destroy();
  const [code] = await once(child, 'exit');
  assert.equal(code, EXIT.detached, err); assert.equal(err, '', 'With --jsonl, nothing human-readable is printed.');
  assert(env.broker.running, 'The run carries on in Codeshi.');
  env.release(); await until(() => !env.broker.running, 'the run to finish');
});

test('a run that reaches a usage limit reports it with exit code 1', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Use it all': { behavior: 'quota' } });
  const result = await env.cli(['run', 'Use it all', '--json']);
  assert.equal(result.code, EXIT.failed);
  assert.equal(result.json().result, 'incomplete'); assert.equal(result.json().errorCategory, 'quota');
});

test('the installed command runs as a program, and a wrong token or a closed app is exit code 5', { skip: scriptCLIs }, async t => {
  const env = await engine(t, { 'Say hi': { text: 'Hi.' } });
  const run = (args, connection = env.file) => new Promise(resolve => execFile(process.execPath, [entry, ...args], { cwd: env.workspace, env: { ...process.env, CODESHI_CONNECTION: connection } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  const said = await run(['run', 'Say hi']);
  assert.equal(said.code, 0, said.stderr); assert.equal(said.stdout, 'Hi.\n');
  assert.equal((await run(['--version'])).stdout, `codeshi ${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`);
  const tasks = await run(['tasks', '--json']);
  assert.deepEqual(JSON.parse(tasks.stdout).tasks, []);
  const wrong = path.join(env.root, 'wrong.json');
  writeConnection(wrong, { url: env.url, token: 'not-the-token' });
  const refused = await run(['status'], wrong);
  assert.equal(refused.code, EXIT.unavailable); assert.match(refused.stderr, /didn't accept this connection/);
  const closed = await run(['status'], path.join(env.root, 'none.json'));
  assert.equal(closed.code, EXIT.unavailable); assert.match(closed.stderr, /Codeshi isn't open/);
});

test('the command is installed as a link to the app’s own, never over something else', { skip: process.platform === 'win32' && 'The command is installed on macOS' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-cli-link-')), target = path.join(root, 'app', 'codeshi'), link = path.join(root, 'bin', 'codeshi');
  try {
    fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
    const elevated = [];
    assert.equal(commandState({ link, target }), 'missing');
    assert.deepEqual(await installCommand({ link, target, elevate: async script => { elevated.push(script); return true; } }), { installed: true, changed: true });
    assert.equal(commandState({ link, target }), 'installed'); assert.deepEqual(elevated, [], 'A writable folder needs no password.');
    assert.deepEqual(await installCommand({ link, target }), { installed: true, changed: false });
    assert.deepEqual(await uninstallCommand({ link, target }), { removed: true });
    fs.writeFileSync(link, 'someone else’s');
    await assert.rejects(installCommand({ link, target }), /already exists and isn't from Codeshi/);
    assert.equal(fs.readFileSync(link, 'utf8'), 'someone else’s');
    assert.deepEqual(await uninstallCommand({ link, target }), { removed: false }, 'Remove leaves what isn’t Codeshi’s.');
    // A folder the person can't write asks macOS for an administrator, with the paths quoted for the shell.
    fs.rmSync(link); fs.chmodSync(path.dirname(link), 0o555);
    const asked = await installCommand({ link, target, elevate: async script => { elevated.push(script); return false; } });
    assert.deepEqual(asked, { installed: false, changed: false, cancelled: true });
    assert.equal(elevated[0], `mkdir -p '${path.dirname(link)}' && ln -sfn '${target}' '${link}'`);
    fs.chmodSync(path.dirname(link), 0o755);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('on Windows the command is a launcher on the PATH for the app’s own, never over something else', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-cli-cmd-')), target = path.join(root, 'app', 'bin', 'codeshi.cmd'), link = path.join(root, 'WindowsApps', 'codeshi.cmd');
  const on = { platform: 'win32', link, target, env: { PATH: `C:\\Windows;${path.dirname(link)}${path.sep}` } };
  try {
    assert.match(windowsCommandLink({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), /^C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\codeshi\.cmd$/);
    assert.equal(commandState(on), 'missing');
    assert.deepEqual(await installCommand(on), { installed: true, changed: true });
    assert.equal(fs.readFileSync(link, 'utf8'), `@echo off\r\nrem Codeshi's codeshi command. Installed from Codeshi's File menu, which also removes it.\r\n"${target}" %*\r\n`);
    assert.equal(commandState(on), 'installed');
    assert.deepEqual(await installCommand(on), { installed: true, changed: false });
    // Codeshi moved to another folder: its own launcher is replaced, and only the current app's is removed.
    const moved = { ...on, target: path.join(root, 'moved', '100% new', 'codeshi.cmd') };
    assert.equal(commandState(moved), 'other-link');
    assert.deepEqual(await uninstallCommand(moved), { removed: false });
    assert.deepEqual(await installCommand(moved), { installed: true, changed: true });
    assert.match(fs.readFileSync(link, 'utf8'), /100%% new/, 'A percent sign in the folder name is written so cmd reads it as itself.');
    assert.deepEqual(await uninstallCommand(moved), { removed: true });
    assert.equal(commandState(on), 'missing');
    fs.writeFileSync(link, '@echo someone else’s\r\n');
    await assert.rejects(installCommand(on), /already exists and isn't from Codeshi/);
    assert.deepEqual(await uninstallCommand(on), { removed: false }, 'Remove leaves what isn’t Codeshi’s.');
    assert.equal(fs.readFileSync(link, 'utf8'), '@echo someone else’s\r\n');
    fs.rmSync(link);
    await assert.rejects(installCommand({ ...on, env: { PATH: 'C:\\Windows' } }), /isn't on your PATH/);
    assert.equal(commandState(on), 'missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the launcher inside the Windows app runs the command with the app’s own Node and passes its exit code on', { skip: process.platform !== 'win32' && 'cmd runs it on Windows' }, async () => {
  const launcher = fileURLToPath(new URL('../bin/codeshi.cmd', import.meta.url));
  const text = fs.readFileSync(launcher, 'utf8');
  assert.match(text, /\.\.\\\.\.\\\.\.\\Codeshi\.exe/); assert.match(text, /set ELECTRON_RUN_AS_NODE=1/);
  // From a checkout there is no Codeshi.exe three folders up, so it uses the Node on the PATH: this test's own.
  const run = args => new Promise(resolve => execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}" ${args}`], { windowsVerbatimArguments: true, env: { ...process.env, PATH: `${path.dirname(process.execPath)};${process.env.PATH}` } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  if (path.basename(process.execPath).toLowerCase() !== 'node.exe') return;
  const version = await run('--version');
  assert.equal(version.code, 0); assert.match(version.stdout, /^codeshi \d+\.\d+\.\d+/);
  const unknown = await run('no-such-command');
  assert.equal(unknown.code, EXIT.usage); assert.match(unknown.stderr, /Unknown command/);
});

test('the menu offers to install the command, or to remove it once installed: in the Codeshi menu on macOS and File on Windows', () => {
  const calls = [], base = { packaged: true, version: '1', osVersion: '26', arch: 'arm64', appearance: 'system', keepAwake: false, send: () => {}, open: () => {} };
  const item = (platform, state) => menuTemplate({ ...base, platform, command: { state, install: () => calls.push('install'), uninstall: () => calls.push('uninstall') } }).flatMap(menu => menu.submenu || []).find(entry => entry.id === 'codeshi-command');
  item('darwin', 'missing').click(); item('darwin', 'other').click(); item('darwin', 'installed').click();
  assert.equal(item('darwin', 'missing').label, 'Install ‘codeshi’ Command…');
  assert.equal(item('darwin', 'installed').label, 'Remove ‘codeshi’ Command');
  assert.deepEqual(calls, ['install', 'install', 'uninstall']);
  assert.equal(item('win32', 'missing').label, 'Install ‘codeshi’ Command…');
  assert.equal(item('win32', 'installed').label, 'Remove ‘codeshi’ Command');
  const menus = platform => menuTemplate({ ...base, platform, command: { state: 'missing', install() {}, uninstall() {} } });
  assert(menus('win32').find(menu => menu.label === 'File').submenu.some(entry => entry.id === 'codeshi-command'));
  assert(menus('darwin').find(menu => menu.label === 'Codeshi').submenu.some(entry => entry.id === 'codeshi-command'));
  assert(!menus('darwin').find(menu => menu.label === 'File').submenu.some(entry => entry.id === 'codeshi-command'));
  // Linux has no installer yet, so the app passes no command there.
  assert.equal(menuTemplate({ ...base, platform: 'linux' }).flatMap(menu => menu.submenu || []).find(entry => entry.id === 'codeshi-command'), undefined);
});

test('on Windows in Node mode, consoleInput recovers the console input stream without replacing pipes or files', () => {
  const original = { isTTY: false }, ttyOut = { isTTY: true }, pipeOut = { isTTY: false };
  const charStat = { isCharacterDevice: () => true, isFIFO: () => false, isFile: () => false };
  const pipeStat = { isCharacterDevice: () => false, isFIFO: () => false, isFile: () => false };
  const fileStat = { isCharacterDevice: () => false, isFIFO: () => false, isFile: () => true };

  // Skipped outside Windows Node-mode, or when stdin is already a TTY or no standard stream is attached to a console.
  assert.equal(consoleInput({ stdin: original, stdout: ttyOut, stderr: ttyOut, env: { ELECTRON_RUN_AS_NODE: '1' }, platform: 'darwin' }).stdin, original);
  assert.equal(consoleInput({ stdin: original, stdout: ttyOut, stderr: ttyOut, env: {}, platform: 'win32' }).stdin, original);
  assert.equal(consoleInput({ stdin: { isTTY: true }, stdout: ttyOut, stderr: ttyOut, env: { ELECTRON_RUN_AS_NODE: '1' }, platform: 'win32' }).stdin.isTTY, true);
  assert.equal(consoleInput({ stdin: original, stdout: pipeOut, stderr: pipeOut, env: { ELECTRON_RUN_AS_NODE: '1' }, platform: 'win32' }).stdin, original);

  // Pipes, files and unexpected fstat errors keep the original stream.
  for (const stub of [() => pipeStat, () => fileStat, () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); }]) {
    let opened = false;
    const picked = consoleInput({ stdin: original, stdout: ttyOut, stderr: ttyOut, env: { ELECTRON_RUN_AS_NODE: '1' }, platform: 'win32', fstatSync: stub, openSync: () => { opened = true; return 9; } });
    assert.equal(picked.stdin, original); assert.equal(opened, false);
  }

  // If CONIN$ cannot be opened or isn't a TTY, fd is closed cleanly and original stdin stays.
  const closed = [];
  const notTty = consoleInput({ stdin: original, stdout: ttyOut, stderr: ttyOut, env: { ELECTRON_RUN_AS_NODE: '1' }, platform: 'win32', fstatSync: () => charStat, openSync: () => 42, isatty: () => false, closeSync: fd => closed.push(fd) });
  assert.equal(notTty.stdin, original); assert.deepEqual(closed, [42]);
  const failedOpen = consoleInput({ stdin: original, stdout: ttyOut, stderr: ttyOut, env: { ELECTRON_RUN_AS_NODE: '1' }, platform: 'win32', fstatSync: () => charStat, openSync: () => { throw new Error('ENOENT'); } });
  assert.equal(failedOpen.stdin, original);

  // On an attached Windows console (both chr and EBADF on fd 0), CONIN$ becomes a destroyable ReadStream.
  for (const stat of [() => charStat, () => { throw Object.assign(new Error('bad fd'), { code: 'EBADF' }); }]) {
    let destroyed = false, pathOpened = null;
    class FakeReadStream { constructor(fd) { this.fd = fd; this.isTTY = true; } destroy() { destroyed = true; } }
    const recovered = consoleInput({ stdin: original, stdout: pipeOut, stderr: ttyOut, env: { ELECTRON_RUN_AS_NODE: '1' }, platform: 'win32', fstatSync: stat, openSync: p => { pathOpened = p; return 77; }, isatty: fd => fd === 77, ReadStream: FakeReadStream });
    assert.equal(pathOpened, '\\\\.\\CONIN$');
    assert.equal(recovered.stdin.fd, 77);
    assert.equal(recovered.stdin.isTTY, true);
    recovered.close();
    assert.equal(destroyed, true);
  }
});

test('on Windows, packaged Node mode treats a console as interactive for run, while keeping pipes as pipes', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-win-node-')));
  const conn = path.join(root, 'cli.json');
  const app = createRelayServer({ workspace: root, dataRoot: path.join(root, 'data'), accessToken: 'tok', lock: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  writeConnection(conn, { url: `http://127.0.0.1:${app.server.address().port}`, token: 'tok', version: 'test' });
  const { default: electron } = await import('electron');
  const { default: pty } = await import('node-pty');
  const ptys = [];
  t.after(async () => {
    for (const term of ptys) try { term.kill(); } catch {}
    await app.close({ force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runInPty = (command, extraEnv = {}) => new Promise((resolve, reject) => {
    let out = '';
    const term = pty.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${command}"`, {
      cols: 120, rows: 24, cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODESHI_CONNECTION: conn, CLI_EXEC: electron, CLI_ENTRY: entry, ...extraEnv },
    });
    ptys.push(term);
    term.onData(chunk => { out += chunk; });
    term.onExit(({ exitCode }) => resolve({ code: exitCode, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '') }));
    setTimeout(() => reject(new Error(`Timed out:\n${out}`)), 15000).unref();
  });

  const interactive = await runInPty('"%CLI_EXEC%" "%CLI_ENTRY%" run');
  assert.equal(interactive.code, EXIT.usage);
  assert.match(interactive.out, /Write the message after codeshi run, or pipe it in/);

  const piped = await runInPty('echo. | "%CLI_EXEC%" "%CLI_ENTRY%" run');
  assert.equal(piped.code, EXIT.usage);
  assert.match(piped.out, /The message is empty/);
});

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
import { EXIT, chooseWorkspace, connectionCandidates, describePending, main, parseArgs, readConnection } from '../src/cli.mjs';
import { commandState, installCommand, removeConnection, uninstallCommand, writeConnection } from '../desktop/cli.mjs';
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
  for (const [args, message] of [[['launch'], /Unknown command launch/], [['run', '--agent', 'gpt'], /codex, claude or gemini/], [['status', '--agent', 'codex'], /apply to run, continue and the session/], [['--json'], /The session is interactive/], [['run', 'x', '--json', '--jsonl'], /--json or --jsonl/], [['wait', 'now'], /takes no message/], [['run', '--model'], /needs a value/], [['tasks', '--detach'], /applies to run and continue/], [['run', '--force', 'x'], /Unknown option --force/]]) {
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
  assert.deepEqual({ ...json.json(), conversationId: null, runId: null, taskId: null }, { v: 1, result: 'complete', workspace: { id: env.project.id, name: 'app' }, conversationId: null, runId: null, taskId: null, agent: 'codex', model: null, reply: 'It builds with esbuild.', error: null, errorCategory: null });
  assert.equal(json.json().runId, c.lastRun.id, 'wait with nothing working reports the last run.');

  const piped = await env.cli(['run', '--jsonl'], { input: 'Explain the build\n' });
  assert.equal(piped.code, EXIT.ok, piped.err);
  const events = piped.out.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type).sort(), ['activity', 'message', 'result', 'started']); assert.equal(events[0].type, 'started'); assert.equal(events.at(-1).type, 'result');
  assert(events.every(event => event.v === 1 && (event.type === 'result' || event.runId === events[0].runId)));
  assert.equal(events.at(-1).reply, 'It builds with esbuild.');
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

test('the Codeshi menu offers to install the command, or to remove it once installed, on macOS only', () => {
  const calls = [], base = { packaged: true, version: '1', osVersion: '26', arch: 'arm64', appearance: 'system', keepAwake: false, send: () => {}, open: () => {} };
  const item = (platform, state) => menuTemplate({ ...base, platform, command: { state, install: () => calls.push('install'), uninstall: () => calls.push('uninstall') } }).flatMap(menu => menu.submenu || []).find(entry => entry.id === 'codeshi-command');
  item('darwin', 'missing').click(); item('darwin', 'other').click(); item('darwin', 'installed').click();
  assert.equal(item('darwin', 'missing').label, 'Install ‘codeshi’ Command…');
  assert.equal(item('darwin', 'installed').label, 'Remove ‘codeshi’ Command');
  assert.deepEqual(calls, ['install', 'install', 'uninstall']);
  assert.equal(item('win32', 'missing'), undefined);
});

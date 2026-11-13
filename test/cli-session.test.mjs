import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pty from 'node-pty';
import { scriptCLIs } from './platform.mjs';
import { createRelayServer } from '../src/server.mjs';
import { prepareHelper } from '../src/terminal.mjs';
import { EXIT, appLocation, connect, startApp } from '../src/cli.mjs';
import { writeConnection } from '../desktop/cli.mjs';
import {
  accessLabel, approvalChoices, describeRequest, formatActivity, formatMarkdown, lineDiff, modelName, nextAccess, parseActivity, settledMessages, unwrapShell,
} from '../src/cli-format.mjs';

// The interactive codeshi session (#90): how it draws a conversation, how it reaches or starts Codeshi, and the session
// itself in a real pseudo-terminal against the real engine and the mock agent.
const text = lines => lines.map(line => line.map(part => part.text).join('')).join('\n');
const strip = value => value.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]/g, '');

test('steps are drawn as tools with what they did: Claude tools, Codex commands and file changes, and notes', () => {
  const roots = ['/work/app'];
  const read = parseActivity('Read\n{"file_path":"/work/app/src/a.js"}\n1\tconst a = 1;\n2\t');
  assert.equal(read.tool, 'Read'); assert.equal(read.input.file_path, '/work/app/src/a.js');
  assert.equal(text(formatActivity({ text: 'Read\n{"file_path":"/work/app/src/a.js"}\n1\tx\n2\ty', toolOutcome: { status: 'completed' } }, { roots })), `● Read(${path.join('src', 'a.js')})\n  ⎿ Read 2 lines`, 'a path in the system\'s own form');
  const edit = formatActivity({ text: 'Edit\n{"file_path":"/work/app/a.js","old_string":"a\\nb\\n","new_string":"a\\nc\\nd\\n"}', toolOutcome: { status: 'completed' } }, { roots });
  assert.equal(text(edit), '● Update(a.js)\n  ⎿ Added 2 lines, removed 1 line\n    - b\n    + c\n    + d');
  assert.equal(edit[2][1].color, 'red'); assert.equal(edit[3][1].color, 'green');
  assert.equal(text(formatActivity({ text: 'Edit\n{"file_path":"/work/app/a.js","old_string":"a","new_string":"b"}' }, { roots, pending: true })), '● Update(a.js)\n  ⎿ Waiting for your answer…');
  // Codex runs commands through a login shell; the session shows the command itself, and keeps the output's alignment.
  assert.equal(unwrapShell("/bin/zsh -lc 'git log --oneline'"), 'git log --oneline');
  assert.equal(unwrapShell('/bin/bash -lc ls'), 'ls');
  assert.equal(text(formatActivity({ text: "$ /bin/zsh -lc 'wc -l a b'\n   7 a\n   3 b\n  10 total\n" }, { roots })), '● Bash(wc -l a b)\n  ⎿  7 a\n     3 b\n    10 total');
  assert.equal(text(formatActivity({ text: 'File changes: [{"path":"/work/app/math.js","kind":"update","added":1,"removed":0}]' }, { roots })), '● Update(math.js)\n  ⎿ Added 1 line');
  assert.equal(text(formatActivity({ text: 'Approval allowed by the user.' }, { roots })), '  ⎿ Approval allowed by the user.');
  assert.equal(text(formatActivity({ text: 'AskUserQuestion\n{"questions":[{"question":"mod or remainder?"}]}\nYour questions have been answered' }, { roots })), '● Question(mod or remainder?)');
  assert.deepEqual(lineDiff('x\ny\nz\n', 'x\nY\nz\n'), { removed: ['y'], added: ['Y'] });
});

test('replies are Markdown drawn for a terminal', () => {
  const lines = formatMarkdown('## Done\n\nI changed **two** files:\n- `a.js`\n- b.js\n\n```js\nconst a = 1;\n```');
  assert.equal(text(lines), '● Done\n  \n  I changed two files:\n  • a.js\n  • b.js\n  \n  │ const a = 1;');
  assert.equal(lines[2].find(part => part.text === 'two').bold, true);
  assert.equal(lines[3].find(part => part.text === 'a.js').color, 'cyan');
});

test('only finished messages go to the scrollback, in order; the first one still changing holds the rest back', () => {
  const messages = [
    { id: 'u', runId: 'r', role: 'user', text: 'Go' },
    { id: 'a1', runId: 'r', role: 'activity', text: 'Read\n{}', toolOutcome: { status: 'completed' } },
    { id: 'a2', runId: 'r', role: 'activity', text: 'Edit\n{}' },
    { id: 'm', runId: 'r', role: 'assistant', text: 'Writ', status: 'streaming' },
  ];
  const printed = new Set(['u']);
  const { ready, live } = settledMessages(messages, { printed, activeRunId: 'r' });
  assert.deepEqual(ready.map(message => message.id), ['a1', 'a2']);
  assert.deepEqual(live.map(message => message.id), ['m']);
  assert.deepEqual(settledMessages(messages, { printed, activeRunId: null }).ready.map(message => message.id), ['a1', 'a2', 'm']);
});

test('approvals offer yes, yes for the run when the engine can remember it, and no; access steps round', () => {
  assert.deepEqual(approvalChoices({ scope: { label: 'Edit math.js' } }).map(choice => choice.id), ['yes', 'run', 'no']);
  assert.deepEqual(approvalChoices({}).map(choice => choice.id), ['yes', 'no']);
  const edit = describeRequest({ kind: 'Edit', provider: 'claude', input: { file_path: '/w/a.js', old_string: 'a', new_string: 'b' } }, { roots: ['/w'] });
  assert.equal(edit.title, 'Edit a.js'); assert.equal(edit.question, 'Do you want Claude to make this edit?');
  const command = describeRequest({ kind: 'item/commandExecution/requestApproval', provider: 'codex', command: "/bin/zsh -lc 'npm test'" });
  assert.equal(command.title, 'Run a command'); assert.equal(text(command.lines), '    npm test');
  assert.deepEqual(nextAccess('edit', 'ask'), { mode: 'edit', approvalPolicy: 'auto' });
  assert.deepEqual(nextAccess('edit', 'auto'), { mode: 'read', approvalPolicy: 'ask' });
  assert.deepEqual(nextAccess('read', 'auto'), { mode: 'edit', approvalPolicy: 'ask' });
  assert.equal(accessLabel('read', 'auto'), 'read only');
  assert.equal(modelName([{ value: 'default', resolvedModel: 'm-1' }, { value: 'big', resolvedModel: 'm-1', displayName: 'Big 1' }], null), 'Big 1');
  assert.equal(modelName([{ id: 'sol', displayName: 'Sol', isDefault: true }], null), 'Sol');
  assert.equal(modelName([], 'custom-model'), 'custom-model');
});

test('when Codeshi is closed the command starts the app with no window, and waits for its engine', async () => {
  assert.deepEqual(appLocation({ env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: '/Applications/Codeshi.app/Contents/MacOS/Codeshi' }), { kind: 'bundle', path: '/Applications/Codeshi.app' });
  assert.deepEqual(appLocation({ env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: 'C:\\Codeshi\\Codeshi.exe' }), { kind: 'binary', path: 'C:\\Codeshi\\Codeshi.exe' });
  assert.equal(appLocation({ env: {} }).kind, 'source');
  const spawned = [];
  const spawnImpl = (command, args, options) => { spawned.push({ command, args, options }); const child = new EventEmitter(); child.unref = () => {}; return child; };
  startApp({ kind: 'bundle', path: '/Applications/Codeshi.app' }, { spawnImpl, env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' } });
  assert.deepEqual(spawned[0].args, ['-g', '-a', '/Applications/Codeshi.app', '--args', '--background']);
  assert.equal(spawned[0].command, 'open'); assert.equal(spawned[0].options.env.ELECTRON_RUN_AS_NODE, undefined, 'The app runs as an app, not as Node.');
  startApp({ kind: 'source', path: '/src/codeshi' }, { spawnImpl, env: {}, node: '/bin/node' });
  assert.deepEqual([spawned[1].command, ...spawned[1].args], ['/bin/node', path.join('/src/codeshi', 'desktop', 'launch.mjs'), '--background']);
  assert.equal(spawned[1].options.windowsHide, true);
  startApp({ kind: 'binary', path: 'C:\\Codeshi\\Codeshi.exe' }, { spawnImpl, env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual([spawned[2].command, ...spawned[2].args], ['C:\\Codeshi\\Codeshi.exe', '--background']);
  assert.equal(spawned[2].options.windowsHide, undefined, 'A GUI executable starts without suppressing future window activation.');
  assert.throws(() => startApp(null), error => error.code === EXIT.unavailable);

  // Not open: started once, then found when its engine is ready.
  let reads = 0; const said = [];
  const found = await connect({ env: { HOME: '/nowhere' }, say: line => said.push(line), poll: 5, location: { kind: 'source', path: '/src/codeshi' }, spawnImpl,
    readImpl: () => { if (++reads < 3) throw Object.assign(new Error('closed'), { code: EXIT.unavailable }); return { url: 'http://127.0.0.1:1', token: 't', pid: 1, version: 1 }; } });
  assert.equal(found.token, 't'); assert.equal(spawned.length, 4); assert.deepEqual(said, ['Starting Codeshi in the background…']);
  // A connection named for a test, or start: false (stop, wait), is never started.
  await assert.rejects(connect({ env: { CODESHI_CONNECTION: '/none.json' }, spawnImpl, readImpl: () => { throw new Error('closed'); } }), /closed/);
  await assert.rejects(connect({ env: {}, start: false, spawnImpl, readImpl: () => { throw new Error('closed'); } }), /closed/);
  assert.equal(spawned.length, 4);
  await assert.rejects(connect({ env: { HOME: '/nowhere' }, wait: 30, poll: 5, location: { kind: 'source', path: '/x' }, spawnImpl, readImpl: () => { throw new Error('closed'); } }), /didn't start/);
});

test('the window opens on a workspace when the command asks, only in the desktop app', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-window-'))), opened = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = async onOpenWindow => {
    const app = createRelayServer({ workspace: root, dataRoot: path.join(root, `data-${Boolean(onOpenWindow)}`), accessToken: 't', onOpenWindow });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
    const post = body => fetch(`http://127.0.0.1:${app.server.address().port}/api/window`, { method: 'POST', headers: { 'x-ai-relay-token': 't', 'x-ai-relay': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { app, post };
  };
  const desktop = await make(target => opened.push(target)), id = desktop.app.registry.list()[0].id;
  assert.equal((await desktop.post({ projectId: id })).status, 200);
  assert.equal((await desktop.post({ projectId: 'not-a-workspace' })).status, 200);
  assert.deepEqual(opened, [{ projectId: id }, { projectId: null }]);
  assert.equal(desktop.app.eventClients(), 0);
  const browser = await make(null);
  assert.equal((await browser.post({})).status, 409);
});

// The session in a real terminal against the real engine, with the mock agent standing in for Codex.
test('the session sends, follows a run, answers an approval, stops a run with esc and leaves with ctrl+d', { skip: scriptCLIs, timeout: 60000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-session-'))), workspace = path.join(root, 'app'), bins = {};
  const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url)), entry = fileURLToPath(new URL('../bin/codeshi.mjs', import.meta.url));
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({ 'Say hi': { text: 'Hi **there**.' }, 'Hold on': { behavior: 'hold', text: 'Held.' } }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  for (const provider of ['codex', 'claude']) { bins[provider] = path.join(root, `${provider}-mock.mjs`); fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o755 }); }
  bins.gemini = path.join(root, 'missing-gemini');
  const app = createRelayServer({ workspace, dataRoot: path.join(root, 'data'), bins, accessToken: 'tok' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let term = null, screen = '', exited = null;
  // Cleanup comes first, so a terminal that can't start still closes the engine and the test file ends.
  t.after(async () => { if (term && exited === null) term.kill(); await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'cli.json');
  writeConnection(file, { url: `http://127.0.0.1:${app.server.address().port}`, token: 'tok', version: 'test' });
  const project = app.registry.list()[0], broker = app.registry.broker(project.id);
  // A fresh npm install leaves node-pty's macOS helper unable to run, as the app's own terminal knows.
  prepareHelper();
  term = pty.spawn(process.execPath, [entry], { name: 'xterm-256color', cols: 100, rows: 30, cwd: workspace, env: { ...process.env, CODESHI_CONNECTION: file } });
  term.onData(chunk => { screen += chunk; }); term.onExit(({ exitCode }) => { exited = exitCode; });
  const until = async (check, what) => { for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Timed out waiting for ${what}:\n${strip(screen).slice(-1500)}`); };
  const seen = pattern => () => pattern.test(strip(screen));
  const type = async keys => { for (const key of keys) { term.write(key); await new Promise(resolve => setTimeout(resolve, 5)); } };

  await until(seen(/for shortcuts/), 'the prompt');
  assert.match(strip(screen), /Codeshi \d+\.\d+/); assert.match(strip(screen), /app ⎇ main/);
  await type('/help'); term.write('\r');
  await until(seen(/Commands[\s\S]*\/handoff/), 'the commands');
  await type('Say hi'); term.write('\r');
  await until(seen(/● Hi there\./), 'the reply, drawn as Markdown');
  await until(seen(/Worked for/), 'the run to end');
  assert.equal(broker.get(app.registry.mainConversation(project.id).id).messages.find(message => message.role === 'user').text, 'Say hi', 'The message is the workspace chat’s.');

  // Flow (#12): /flow saver hands the choice of agent to the engine; the line under the prompt says Flow, not one agent.
  broker.availableProviders = () => ['codex'];
  broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
  broker.handoff.models = async () => ({ data: [{ id: 'gpt-6.1-sol', displayName: 'Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }, { id: 'gpt-6-luna', displayName: 'Luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] });
  broker.checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }] });
  await type('/flow saver'); term.write('\r');
  await until(seen(/Flow · Saver: Codeshi picks/), 'Flow to turn on');
  await until(seen(/main {2}· {2}Flow · Saver {2}· {2}asks before changes/), 'Flow under the prompt');
  const conversation = () => broker.get(app.registry.mainConversation(project.id).id);
  assert.equal(conversation().routing.mode, 'saver');
  await type('Say hi'); term.write('\r');
  await until(seen(/Flow chose Codex/), 'what Flow chose');
  await until(() => (strip(screen).match(/Worked for/g) || []).length >= 2, 'the routed run to end');
  assert.equal(conversation().lastRun.routing.mode, 'saver');
  await type('/flow off'); term.write('\r');
  await until(() => conversation().routing === null, 'Flow to turn off');

  // An approval asks in its own box; y answers it.
  await type('Hold on'); term.write('\r');
  await until(() => broker.running, 'the held run');
  const run = broker.running;
  run.approvals.set('a1', { id: 'a1', runId: run.id, provider: 'codex', kind: 'item/commandExecution/requestApproval', command: 'npm test', scope: { key: 'npm test', label: 'npm test' } });
  broker.emit('update', { conversationId: run.c.id });
  await until(seen(/Do you want Codex to run it\?/), 'the approval box');
  // The box's choices can arrive in a later frame than its question.
  await until(seen(/Yes, and don't ask again for npm test in this run/), 'the choice that remembers the command for the run');
  term.write('y');
  await until(() => !run.approvals.has('a1'), 'the approval to be answered');
  // Esc stops the run that's working.
  term.write('\x1b');
  await until(seen(/Stopped after/), 'the run to stop');
  assert.equal(broker.running, null);
  term.write('\x04');
  await until(() => exited !== null, 'the session to end');
  assert.equal(exited, 0);
});

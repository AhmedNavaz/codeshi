import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SCROLLBACK, TerminalSessions, loginShell, prepareHelper, processTree, shellArguments } from '../src/terminal.mjs';
import { createRelayServer } from '../src/server.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 8000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting'); await wait(20); } }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A pseudo-terminal stand-in: records what it was asked to do, and lets a test send output or end the shell.
function fakePty() {
  const spawned = [];
  return { spawned, spawn(file, args, options) {
    const listeners = { data: [], exit: [] };
    const shell = { file, args, options, pid: 999000 + spawned.length, input: [], sizes: [], killed: [],
      onData: fn => listeners.data.push(fn), onExit: fn => listeners.exit.push(fn),
      write: data => shell.input.push(data), resize: (cols, rows) => shell.sizes.push([cols, rows]),
      kill: signal => { shell.killed.push(signal); setTimeout(() => shell.exit(0, 1), 5); },
      emit: data => listeners.data.forEach(fn => fn(data)), exit: (exitCode, signal = 0) => listeners.exit.forEach(fn => fn({ exitCode, signal })) };
    spawned.push(shell); return shell;
  } };
}
function workspaces(t, count = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-terminal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = new Map();
  for (let index = 0; index < count; index++) {
    const folders = ['web', 'api'].map(name => { const where = path.join(root, `project-${index}`, name); fs.mkdirSync(where, { recursive: true }); return { id: name, name, path: where }; });
    projects.set(`project-${index}`, { id: `project-${index}`, folders });
  }
  const registry = Object.assign(new EventEmitter(), { get: id => { if (!projects.has(id)) throw Object.assign(new Error('No such workspace.'), { status: 404 }); return projects.get(id); } });
  return { root, projects, registry };
}

test('a terminal opens the person’s login shell in the chosen folder, one session per workspace', async t => {
  const { registry, projects } = workspaces(t), pty = fakePty();
  const sessions = new TerminalSessions({ registry, pty, shell: '/bin/zsh', flushMs: 1 });
  t.after(() => sessions.close());
  const session = sessions.start('project-0', { folderId: 'api', cols: 120, rows: 40 });
  assert.deepEqual([session.status, session.folderName, session.cwd, session.cols, session.rows], ['running', 'api', projects.get('project-0').folders[1].path, 120, 40]);
  const [shell] = pty.spawned;
  assert.deepEqual([shell.file, shell.args, shell.options.cwd, shell.options.name, shell.options.env.TERM, shell.options.env.TERM_PROGRAM], ['/bin/zsh', ['-l'], projects.get('project-0').folders[1].path, 'xterm-256color', 'xterm-256color', 'Throughline']);
  assert.throws(() => sessions.start('project-0', { folderId: 'web' }), /already has a terminal/);
  assert.throws(() => sessions.start('project-1', { folderId: 'missing' }), /Choose an attached workspace folder/);
  assert.equal(sessions.start('project-1', { folderId: 'web', cols: 5000 }).cols, 1000, 'Sizes are kept within bounds.');
  assert.equal(sessions.state('project-1').session.folderId, 'web');
  assert.equal(sessions.state('project-1').shell, 'zsh');
});

test('input, resizing and output stay with their own workspace’s session', async t => {
  const { registry } = workspaces(t), pty = fakePty();
  const sessions = new TerminalSessions({ registry, pty, shell: '/bin/zsh', flushMs: 1 });
  t.after(() => sessions.close());
  const first = sessions.start('project-0', { folderId: 'web' }), second = sessions.start('project-1', { folderId: 'web' });
  const seen = { first: [], second: [] };
  sessions.subscribe('project-0', first.id, null, event => seen.first.push(event));
  sessions.subscribe('project-1', second.id, null, event => seen.second.push(event));
  sessions.write('project-0', first.id, 'ls\r');
  sessions.resize('project-1', second.id, { cols: 90, rows: 20 });
  assert.deepEqual(pty.spawned[0].input, ['ls\r']); assert.deepEqual(pty.spawned[1].input, []);
  assert.deepEqual(pty.spawned[1].sizes, [[90, 20]]);
  assert.throws(() => sessions.write('project-1', first.id, 'rm -rf .\r'), /session ended/, 'A session id from another workspace is refused.');
  pty.spawned[0].emit('README.md\r\n');
  await until(() => seen.first.some(event => event.type === 'data' && event.data));
  assert.deepEqual(seen.second.filter(event => event.data), [], 'Output never reaches another workspace.');
  assert.throws(() => sessions.write('project-0', first.id, 'x'.repeat(70000)), /too large/);
});

test('scrollback is bounded, and a view that reconnects gets what it missed, or all of it when it fell too far behind', async t => {
  const { registry } = workspaces(t, 1), pty = fakePty();
  const sessions = new TerminalSessions({ registry, pty, shell: '/bin/zsh', flushMs: 1 });
  t.after(() => sessions.close());
  const session = sessions.start('project-0', { folderId: 'web' }), shell = pty.spawned[0];
  shell.emit('one\r\n'); shell.emit('two\r\n');
  const replay = []; sessions.subscribe('project-0', session.id, 5, event => replay.push(event));
  assert.deepEqual(replay[0], { type: 'data', data: 'two\r\n', offset: 10 });
  const fresh = []; sessions.subscribe('project-0', session.id, null, event => fresh.push(event));
  assert.deepEqual(fresh[0], { type: 'reset', data: 'one\r\ntwo\r\n', offset: 10 });
  shell.emit('x'.repeat(SCROLLBACK));
  const behind = []; sessions.subscribe('project-0', session.id, 5, event => behind.push(event));
  assert.equal(behind[0].type, 'reset'); assert.equal(behind[0].data.length, SCROLLBACK);
});

test('an exited shell keeps its output and says how it ended; a new session replaces it; a failed start is reported', async t => {
  const { registry } = workspaces(t, 1), pty = fakePty();
  const sessions = new TerminalSessions({ registry, pty, shell: '/bin/zsh', flushMs: 1 });
  t.after(() => sessions.close());
  const session = sessions.start('project-0', { folderId: 'web' }), events = [];
  sessions.subscribe('project-0', session.id, null, event => events.push(event));
  pty.spawned[0].emit('bye\r\n'); pty.spawned[0].exit(3);
  assert.deepEqual(events.at(-1).session.status, 'exited'); assert.equal(events.at(-1).session.exitCode, 3);
  assert(events.some(event => event.data === 'bye\r\n'), 'Output before the exit is delivered first.');
  assert.throws(() => sessions.write('project-0', session.id, 'ls\r'), /The shell has exited/);
  const later = []; sessions.subscribe('project-0', session.id, null, event => later.push(event));
  assert.deepEqual(later.map(event => event.type), ['reset', 'exit']);
  const next = sessions.start('project-0', { folderId: 'api' });
  assert.notEqual(next.id, session.id);
  const broken = new TerminalSessions({ registry, pty: { spawn: () => { throw new Error('posix_spawnp failed.'); } }, shell: '/bin/zsh' });
  const failed = broken.start('project-0', { folderId: 'web' });
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /The shell could not start: posix_spawnp failed/);
});

test('ending a session hangs up the shell and stops every process it started; removing the workspace or quitting does the same', async t => {
  const { registry, projects } = workspaces(t), pty = fakePty(), children = [];
  t.after(() => { for (const child of children) try { child.kill('SIGKILL'); } catch {} });
  const started = () => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); children.push(child); return child.pid; };
  const trees = new Map();
  const sessions = new TerminalSessions({ registry, pty, shell: '/bin/zsh', flushMs: 1, stopGrace: 200, tree: async pid => trees.get(pid) || [], platform: 'darwin' });
  const one = sessions.start('project-0', { folderId: 'web' }), two = sessions.start('project-1', { folderId: 'web' });
  const first = [started(), started()], second = [started()];
  trees.set(pty.spawned[0].pid, first); trees.set(pty.spawned[1].pid, second);
  const ended = await sessions.stop('project-0', one.id);
  assert.equal(ended.status, 'stopped');
  assert.deepEqual(pty.spawned[0].killed, ['SIGHUP']);
  await until(() => first.every(pid => !alive(pid)));
  assert(second.every(alive), 'Another workspace’s terminal keeps running.');
  assert.equal(sessions.state('project-0').session, null);
  projects.delete('project-1'); registry.emit('projects');
  await until(() => second.every(pid => !alive(pid)));
  sessions.start('project-0', { folderId: 'api' }); trees.set(pty.spawned[2].pid, [started()]);
  await sessions.close();
  await until(() => !alive(trees.get(pty.spawned[2].pid)[0]));
  assert.throws(() => sessions.start('project-0', { folderId: 'web' }), /stopping/);
});

test('on Windows, ending a session ends the shell’s whole process tree at once', async t => {
  const { registry } = workspaces(t), pty = fakePty(), ended = [];
  const sessions = new TerminalSessions({ registry, pty, shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', flushMs: 1, stopGrace: 200, platform: 'win32', endTree: async pid => { ended.push(pid); }, tree: async () => { throw new Error('Windows has no process list to walk.'); } });
  t.after(() => sessions.close());
  const session = sessions.start('project-0', { folderId: 'web' });
  assert.deepEqual(pty.spawned[0].args, ['-NoLogo'], 'PowerShell is not given a login flag.');
  assert.equal(sessions.state('project-0').shell, 'powershell');
  assert.equal((await sessions.stop('project-0', session.id)).status, 'stopped');
  assert.deepEqual(ended, [pty.spawned[0].pid]);
  assert.deepEqual(pty.spawned[0].killed, [undefined], 'Windows has no hangup signal to send.');
});

test('Windows opens PowerShell 7 when it is installed, then Windows PowerShell, then Command Prompt', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-windows-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const system = path.join(root, 'Windows'), tools = path.join(root, 'PowerShell 7');
  const env = { SystemRoot: system, Path: `.;${tools}`, ComSpec: path.join(system, 'System32', 'cmd.exe') };
  assert.equal(loginShell(env, 'win32'), env.ComSpec);
  const windowsPowerShell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  fs.mkdirSync(path.dirname(windowsPowerShell), { recursive: true }); fs.writeFileSync(windowsPowerShell, '');
  assert.equal(loginShell(env, 'win32'), windowsPowerShell);
  fs.mkdirSync(tools); fs.writeFileSync(path.join(tools, 'pwsh.exe'), '');
  assert.equal(loginShell(env, 'win32'), path.join(tools, 'pwsh.exe'));
  assert.deepEqual([shellArguments('C:\\Windows\\System32\\cmd.exe'), shellArguments('/bin/zsh'), shellArguments(path.join(tools, 'pwsh.exe'))], [[], ['-l'], ['-NoLogo']]);
});

test('the process tree includes every descendant of a shell', { skip: process.platform === 'win32' }, async t => {
  const parent = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30 & wait']);
  t.after(() => { try { process.kill(parent.pid, 'SIGKILL'); } catch {} });
  await until(() => execFileSync('/bin/ps', ['-axo', 'ppid=']).toString().split('\n').filter(line => Number(line.trim()) === parent.pid).length === 2);
  const tree = await processTree(parent.pid);
  assert.equal(tree.length, 2);
  for (const pid of tree) process.kill(pid, 'SIGKILL');
});

test('node-pty’s helper is made executable for a copy run from source', { skip: process.platform === 'win32' && 'Windows files have no execute permission' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-pty-helper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true }); fs.writeFileSync(helper, '', { mode: 0o644 });
  prepareHelper(root, 'darwin', 'arm64');
  assert.equal(fs.statSync(helper).mode & 0o111, 0o111);
});

test('a real shell runs commands and resizes through the HTTP routes, streams its output, and ending it stops what it started', { skip: process.platform !== 'darwin' }, async t => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-terminal-live-')));
  const saved = process.env.SHELL; process.env.SHELL = '/bin/sh';
  const relay = createRelayServer({ workspace, dataDir: path.join(workspace, '.relay-data'), lock: false });
  process.env.SHELL = saved;
  t.after(async () => { await relay.close({ force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`, [project] = relay.registry.list();
  const post = async (name, body) => { const response = await fetch(`${base}/api/terminal/${name}?projectId=${project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  const started = await post('start', { folderId: project.folders[0].id, cols: 80, rows: 24 });
  assert.equal(started.status, 201); assert.equal(started.data.status, 'running');
  const id = started.data.id;
  const stream = await fetch(`${base}/api/terminal/stream?projectId=${project.id}&id=${id}`);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  let received = '', closed = false;
  (async () => { const decoder = new TextDecoder(); for await (const chunk of stream.body) received += decoder.decode(chunk); closed = true; })().catch(() => { closed = true; });
  const marker = path.join(workspace, 'background.pid');
  await post('input', { id, data: `echo "in $(pwd)"; stty size; sleep 300 & echo $! > ${JSON.stringify(marker)}\r` });
  await until(() => received.includes(`in ${workspace}`) && received.includes('24 80') && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim());
  await post('resize', { id, cols: 132, rows: 50 });
  await post('input', { id, data: 'stty size\r' });
  await until(() => received.includes('50 132'));
  const background = Number(fs.readFileSync(marker, 'utf8').trim());
  assert(alive(background));
  const ended = await post('stop', { id });
  assert.equal(ended.data.status, 'stopped');
  await until(() => !alive(background) && closed);
  assert.match(received, /^id: \d+\nevent: reset\n/);
  assert.equal((await post('input', { id, data: 'ls\r' })).status, 409);
});

test('on Windows, a real shell runs commands through the HTTP routes, and ending it stops what it started', { skip: process.platform !== 'win32' }, async t => {
  // The long form of the folder's path, as the shell reports it, also when the temporary folder has a short 8.3 name.
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-terminal-live-')));
  const relay = createRelayServer({ workspace, dataDir: path.join(workspace, '.relay-data'), lock: false });
  t.after(async () => { await relay.close({ force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`, [project] = relay.registry.list();
  const post = async (name, body) => { const response = await fetch(`${base}/api/terminal/${name}?projectId=${project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  const started = await post('start', { folderId: project.folders[0].id, cols: 80, rows: 24 });
  assert.equal(started.status, 201); assert.equal(started.data.status, 'running');
  const id = started.data.id;
  const stream = await fetch(`${base}/api/terminal/stream?projectId=${project.id}&id=${id}`);
  let received = '', closed = false;
  (async () => { const decoder = new TextDecoder(); for await (const chunk of stream.body) received += decoder.decode(chunk); closed = true; })().catch(() => { closed = true; });
  // Joined text is printed so the shell's echo of the command never matches. The background process has no console of
  // its own to close with the terminal, so only ending the process tree stops it.
  const marker = path.join(workspace, 'background.pid');
  const command = /cmd\.exe$/i.test(started.data.shell)
    ? `if /i "%CD%"=="${workspace}" (echo cwd-%OS%)\r`
    : `if ((Get-Location).Path -eq '${workspace}') { 'cwd-' + 'ok' }; $p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; Set-Content -Encoding ascii -Path '${marker}' -Value $p.Id\r`;
  await post('input', { id, data: command });
  await until(() => /cwd-(?:ok|Windows_NT)/.test(received), 20000);
  if (!/cmd\.exe$/i.test(started.data.shell)) {
    await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim(), 20000);
    const background = Number(fs.readFileSync(marker, 'utf8').trim());
    assert(alive(background));
    t.after(() => { try { process.kill(background); } catch {} });
    assert.equal((await post('stop', { id })).data.status, 'stopped');
    await until(() => !alive(background) && closed);
  } else {
    assert.equal((await post('stop', { id })).data.status, 'stopped');
    await until(() => closed);
  }
  assert.equal((await post('input', { id, data: 'dir\r' })).status, 409);
});

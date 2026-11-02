import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { noSymlinks } from './platform.mjs';
import { ProjectRegistry } from '../src/projects.mjs';
import { ProjectCommands, commandLogLimit, localCommandURLs } from '../src/project-commands.mjs';
import { commandEnvironment } from '../src/resolve-binary.mjs';
import { createRelayServer } from '../src/server.mjs';

const waitFor = async predicate => {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out waiting for command fixture'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-commands-')));
  const frontend = path.join(root, 'frontend'), backend = path.join(root, 'backend');
  fs.mkdirSync(frontend); fs.mkdirSync(backend);
  const registry = new ProjectRegistry({ dataRoot: path.join(root, 'data'), lock: false });
  const project = registry.add({ folders: [frontend, backend] });
  const commands = new ProjectCommands({ registry, stopGrace: 40, ...options });
  t.after(async () => { await commands.close(); await registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = (command = 'printf done', folder = project.folders[0], directory = '') => ({ folderId: folder.id, directory, command });
  return { root, frontend, backend, registry, project, commands, config };
}
const quote = value => process.platform === 'win32' ? `"${value}"` : "'" + value.replaceAll("'", "'\\''") + "'";
// Prints text without a newline, in sh and in Command Prompt alike.
const print = text => `${quote(process.execPath)} -e "process.stdout.write('${text}')"`;

test('command detection is inert, editable and scoped to a selected package and workspace', { skip: noSymlinks }, async t => {
  const f = fixture(t); const nested = path.join(f.backend, 'packages/app'); fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { dev: 'touch NEVER_EXECUTE', test: 'echo test', 'danger;touch BAD': 'true' } }));
  const detected = f.commands.detect(f.project.id, f.config('', f.project.folders[1], 'packages/app'));
  assert.equal(detected.cwd, nested); assert.equal(detected.manager, 'pnpm'); assert.deepEqual(detected.suggestions, { run: 'pnpm run dev', test: 'pnpm run test' });
  assert.deepEqual(detected.scripts, ['dev', 'test']); assert.equal(fs.existsSync(path.join(nested, 'NEVER_EXECUTE')), false);
  assert.deepEqual(f.commands.state(f.project.id).commands, {});
  const custom = f.config('node app.mjs --port 4010', f.project.folders[1], 'packages/app');
  f.commands.save(f.project.id, 'run', custom);
  const reopened = new ProjectCommands({ registry: f.registry });
  assert.deepEqual(reopened.state(f.project.id).commands.run, custom);
  const other = f.registry.add({ path: f.frontend }); assert.deepEqual(reopened.state(other.id).commands, {});
  assert.throws(() => f.commands.detect(other.id, { folderId: f.project.folders[1].id }), /attached/);
  assert.throws(() => f.commands.save(f.project.id, 'run', f.config('echo hi\necho bye')), /single-line/);
  assert.throws(() => f.commands.detect(f.project.id, { folderId: f.project.folders[0].id, directory: '../backend' }), /relative/);
  fs.symlinkSync(f.backend, path.join(f.frontend, 'escape'));
  assert.throws(() => f.commands.detect(f.project.id, f.config('', f.project.folders[0], 'escape')), /inside/);
});

test('managed commands use the selected cwd, retain bounded UTF-8 output and useful nonzero failures', async t => {
  const f = fixture(t);
  const script = path.join(f.backend, 'output.cjs');
  fs.writeFileSync(script, `process.stdout.write('x'.repeat(${commandLogLimit + 100})); process.stdout.write(Buffer.from('🌍').subarray(0, 2)); setTimeout(() => { process.stdout.write(Buffer.from('🌍').subarray(2)); console.error('EADDRINUSE: port 3000 already in use'); console.log(process.cwd()); process.exitCode=7; }, 30);`);
  const value = f.commands.start(f.project.id, 'test', f.config(`${quote(process.execPath)} output.cjs`, f.project.folders[1]));
  await f.commands.sessions.get(f.commands.key(f.project.id, 'test')).done;
  const session = f.commands.state(f.project.id).sessions.test;
  assert.equal(session.id, value.id); assert.equal(session.status, 'failed'); assert.equal(session.exitCode, 7); assert.equal(session.truncated, true);
  assert(session.output.length <= commandLogLimit); assert(session.output.includes('🌍')); assert(session.output.includes('EADDRINUSE')); assert(session.output.includes(f.backend));
  assert.equal(session.output.includes('�'), false);
  assert.equal('child' in session, false); assert.equal('done' in session, false);
  const next = f.commands.start(f.project.id, 'test', f.config(print('recovered')));
  await f.commands.sessions.get(f.commands.key(f.project.id, 'test')).done;
  assert.notEqual(next.id, value.id); assert.equal(f.commands.state(f.project.id).sessions.test.status, 'exited');
});

test('Start deduplicates running commands, Stop and shutdown clean up child processes without blocking agent editing leases', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.frontend, 'server.cjs'), `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e', 'setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('child='+child.pid);console.log('http://localhost:4321');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const config = f.config(`${quote(process.execPath)} server.cjs`);
  const run = f.commands.start(f.project.id, 'run', config);
  const key = f.commands.key(f.project.id, 'run');
  // The two lines can arrive in separate chunks on a slow machine, so wait for both.
  await waitFor(() => { const output = f.commands.state(f.project.id).sessions.run.output; return output.includes('child=') && output.includes('http://localhost:4321'); });
  assert.throws(() => f.commands.start(f.project.id, 'run', config), /already/);
  assert.deepEqual(f.commands.state(f.project.id).sessions.run.urls, ['http://localhost:4321/']);
  await assert.rejects(f.commands.stop(f.project.id, 'run', 'outdated-session'), /changed/);
  assert.throws(() => f.registry.remove(f.project.id), /Stop the project commands/);
  assert.throws(() => f.registry.removeFolder(f.project.id, f.project.folders[1].id), /Stop the project commands/);
  const lease = f.registry.mutations.acquireMany([f.frontend], 'agent'); lease.release();
  const pid = f.commands.sessions.get(key).child.pid;
  const childPid = Number(f.commands.state(f.project.id).sessions.run.output.match(/child=(\d+)/)[1]);
  const stopped = await f.commands.stop(f.project.id, 'run', run.id);
  assert.equal(stopped.status, 'stopped'); assert.equal(f.commands.active(f.project.id), false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await waitFor(() => { try { process.kill(childPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  const second = f.commands.start(f.project.id, 'run', config); assert.notEqual(second.id, run.id);
  await waitFor(() => f.commands.state(f.project.id).sessions.run.output.includes('child='));
  await f.commands.close(); assert.equal(f.commands.state(f.project.id).sessions.run.status, 'stopped');
  assert.throws(() => f.commands.start(f.project.id, 'run', config), /stopping/);
});

test('a shell exiting early still terminates its inherited server and releases the session', { skip: process.platform === 'win32' && 'Leaves a server running in the background with POSIX shell syntax' }, async t => {
  const f = fixture(t);
  const run = f.commands.start(f.project.id, 'run', f.config(`${quote(process.execPath)} -e 'setInterval(()=>{},1000)' & echo background`));
  const owned = f.commands.sessions.get(f.commands.key(f.project.id, 'run'));
  await Promise.race([owned.done, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('orphaned server')), 4000); timer.unref(); })]);
  assert.equal(f.commands.state(f.project.id).sessions.run.status, 'exited'); assert.equal(f.commands.active(f.project.id), false); assert.equal(run.command.includes('background'), true);
});

test('spawn failures remain visible and local URL actions reject credentials and remote hosts', async t => {
  const f = fixture(t, { spawnImpl() { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); queueMicrotask(() => { child.emit('error', new Error('Shell unavailable')); child.emit('close', -2, null); }); return child; } });
  f.commands.start(f.project.id, 'run', f.config()); await f.commands.sessions.get(f.commands.key(f.project.id, 'run')).done;
  const result = f.commands.state(f.project.id).sessions.run;
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'Shell unavailable');
  assert.deepEqual(localCommandURLs('\u001b[32mhttp://localhost:3000/path\u001b[0m http://127.0.0.1:8000 https://[::1]:443 http://evil.example http://localhost.evil http://user:secret@localhost:4000 javascript:alert(1)'), ['http://localhost:3000/path', 'http://127.0.0.1:8000/', 'https://[::1]/']);
  const env = commandEnvironment({ PATH: ['.', path.resolve('/usr/bin'), '', 'relative'].join(path.delimiter), AI_RELAY_TOKEN: 'private', ELECTRON_RUN_AS_NODE: '1' }, f.root);
  assert.equal(env.AI_RELAY_TOKEN, undefined); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(env.PATH.split(path.delimiter).some(entry => !path.isAbsolute(entry)), false);
});

test('command routes retain token, origin and local application header checks and never start on detection', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-command-http-'))), workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const app = createRelayServer({ workspace, dataRoot: path.join(root, 'data'), accessToken: 'fixture-token', lock: false });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const project = app.registry.list()[0], base = `http://127.0.0.1:${app.server.address().port}`;
  const url = action => `${base}/api/commands${action}?projectId=${project.id}`;
  const headers = { 'Content-Type': 'application/json', 'X-AI-Relay': '1', 'X-AI-Relay-Token': 'fixture-token' };
  const input = { folderId: project.folders[0].id, directory: '', command: print('from-http') };
  const post = (action, body = input, changes = {}) => fetch(url(action), { method: 'POST', headers: { ...headers, ...changes }, body: JSON.stringify(body) });
  assert.equal((await fetch(url(''))).status, 403);
  assert.equal((await post('/run/start', input, { 'X-AI-Relay': '0', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/run/start', input, { 'X-AI-Relay': '' })).status, 403);
  assert.equal((await post('/detect')).status, 200); assert.equal(app.commands.active(project.id), false);
  assert.equal((await fetch(url('/run/start'), { headers })).status, 405);
  const started = await post('/run/start'); assert.equal(started.status, 202);
  await app.commands.sessions.get(app.commands.key(project.id, 'run')).done;
  const state = await (await fetch(url(''), { headers })).json(); assert.equal(state.sessions.run.output, 'from-http');
  fs.renameSync(workspace, workspace + '-moved'); assert.equal((await post('/run/start')).status, 404);
  // Host checks apply to command reads as well as writes.
  const status = await new Promise(resolve => http.get(url(''), { headers: { ...headers, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); })); assert.equal(status, 403);
});


test('separate workspace and action sessions survive stopping another command and persist their configuration', async t => {
  const f = fixture(t);
  const second = f.registry.add({ path: f.backend });
  const command = `${quote(process.execPath)} -e "console.log(process.cwd());setInterval(()=>{},1000)"`;
  const first = f.commands.start(f.project.id, 'run', f.config(command));
  const testRun = f.commands.start(f.project.id, 'test', f.config(command, f.project.folders[1]));
  const other = f.commands.start(second.id, 'run', { folderId: second.folders[0].id, directory: '', command });
  await waitFor(() => f.commands.state(second.id).sessions.run.output.includes(f.backend));
  await f.commands.stop(f.project.id, 'run', first.id);
  assert.equal(f.commands.state(second.id).sessions.run.id, other.id);
  assert.equal(f.commands.state(second.id).sessions.run.status, 'running');
  assert.equal(f.commands.state(f.project.id).sessions.test.id, testRun.id);
  assert.equal(f.commands.state(f.project.id).sessions.test.status, 'running');
  assert.equal(f.commands.state(f.project.id).commands.test.folderId, f.project.folders[1].id);
  assert.equal(f.commands.state(second.id).commands.run.folderId, second.folders[0].id);
});

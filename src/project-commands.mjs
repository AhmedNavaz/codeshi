import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { atomicJSON } from './patches.mjs';
import { withFileGuard } from './mutation-lock.mjs';
import { commandEnvironment } from './resolve-binary.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const commandLogLimit = 64 * 1024;
export const COMMAND_LIMIT = 12;
export const commandActive = session => ['starting', 'running', 'stopping'].includes(session?.status);
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function location(project, input) {
  const folder = project.folders.find(folder => folder.id === input.folderId);
  if (!folder) fail('Choose an attached workspace folder.');
  const directory = input.directory ?? '';
  if (typeof directory !== 'string' || directory.length > 1024 || directory.includes('\0') || path.isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) fail('Use a relative project directory inside the selected folder.');
  let root, cwd;
  try { root = fs.realpathSync(folder.path); cwd = fs.realpathSync(path.join(root, directory)); if (!fs.statSync(cwd).isDirectory()) throw Error(); }
  catch { fail('The project directory is unavailable. Restore it or choose another directory.', 404); }
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('The project directory must stay inside its attached folder.');
  return { folderId: folder.id, directory, cwd };
}
function configuration(project, input) {
  const selected = location(project, input);
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 4096 || /[\0\r\n]/.test(input.command)) fail('Enter a single-line command (up to 4096 characters).');
  return { folderId: selected.folderId, directory: selected.directory, command: input.command.trim() };
}
// Only literal loopback HTTP(S) links become actions. Logs themselves are always plain text.
export function localCommandURLs(output) {
  const urls = new Set();
  for (const match of stripVTControlCharacters(output).matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ''));
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password) urls.add(url.href);
    } catch {}
    if (urls.size === 5) break;
  }
  return [...urls];
}
const readSmall = file => { try { return fs.statSync(file).size <= 256 * 1024 ? fs.readFileSync(file, 'utf8') : null; } catch { return null; } };
const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
// Commands a folder offers, found by reading its files and never by running them: package.json scripts, Makefile
// targets, and the usual commands of Cargo, Go and Python projects. Script and target names are data from the
// repository, never shell syntax, so only plain names are offered.
function suggestions(project, input) {
  const selected = location(project, input), found = [], add = (name, command, test = false) => { if (found.length < 40 && !found.some(item => item.command === command)) found.push({ name, command, ...(test ? { test: true } : {}) }); };
  let manager = null;
  const packageFile = path.join(selected.cwd, 'package.json');
  if (exists(packageFile) && fs.statSync(packageFile).size > 256 * 1024) fail('package.json is too large to inspect. Enter commands manually.');
  let manifest = null; try { manifest = exists(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')) : null; } catch { manifest = null; }
  if (manifest) {
    const declared = typeof manifest?.packageManager === 'string' ? manifest.packageManager.split('@')[0] : null;
    manager = ['npm', 'pnpm', 'yarn', 'bun'].includes(declared) ? declared :
      [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']].find(([file]) => fs.existsSync(path.join(selected.cwd, file)))?.[1] || 'npm';
    const scripts = Object.entries(manifest?.scripts || {}).filter(([name, value]) => /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(name) && typeof value === 'string').map(([name]) => name);
    // The usual ones first: the dev server, then the tests, then the rest in the order package.json lists them.
    const rank = name => ['dev', 'start', 'serve', 'test', 'build', 'lint'].indexOf(name) + 1 || 99;
    for (const name of [...scripts].sort((a, b) => rank(a) - rank(b))) add(name, `${manager} run ${name}`, name === 'test');
  }
  const makefile = readSmall(path.join(selected.cwd, 'Makefile'));
  if (makefile) for (const [, target] of makefile.matchAll(/^([A-Za-z0-9][\w-]{0,39}):(?!=)/gm)) add(target, `make ${target}`, target === 'test');
  if (exists(path.join(selected.cwd, 'Cargo.toml'))) { add('run', 'cargo run'); add('test', 'cargo test', true); }
  if (exists(path.join(selected.cwd, 'go.mod'))) { add('run', 'go run .'); add('test', 'go test ./...', true); }
  if (exists(path.join(selected.cwd, 'manage.py'))) add('runserver', 'python manage.py runserver');
  if (['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some(file => exists(path.join(selected.cwd, file))) && !found.some(item => item.test)) add('test', 'pytest', true);
  return { ...selected, manager, suggestions: found, message: found.length ? 'Found in this folder. Check a command before running it; scripts can run other commands.' : 'Nothing found here. Enter any command, or choose a package subdirectory.' };
}
const tidyName = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

// A workspace's commands: its dev servers, tests, builds and scripts, each saved with a name, the folder and
// subdirectory it runs in, and its command line. Each runs as a session under the person's own shell, independently
// of agent access settings, and keeps its latest output while the panel is hidden. One command can be marked for
// Check with tests (#12); the others are only run when the person starts them.
export class ProjectCommands {
  constructor({ registry, spawnImpl = spawn, stopGrace = 1500 } = {}) {
    this.registry = registry; this.spawn = spawnImpl; this.stopGrace = stopGrace; this.sessions = new Map(); this.closing = false;
    registry.hasRunningCommands = id => this.active(id);
    // Checks after routed runs (#12) use the command marked for them, as configured.
    registry.testCommand = id => this.list(id).find(command => command.test) || null;
    registry.runTest = id => this.runTest(id);
  }
  active(id) { return [...this.sessions.values()].some(session => session.projectId === id && commandActive(session)); }
  key(id, commandId) { return `${id}:${commandId}`; }
  filename(id) { return path.join(this.registry.dataRoot, id, 'commands.json'); }
  // Saved commands, oldest first. A file from before named commands held one Run and one Test command; they become
  // commands called Run and Test, the second marked for checks.
  list(id) {
    this.registry.get(id);
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filename(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; fail('Cannot read saved project commands. Restore commands.json before saving new commands.', 409); }
    if (value?.version === 1 && value.commands && typeof value.commands === 'object' && !Array.isArray(value.commands)) return ['run', 'test'].filter(key => value.commands[key]).map(key => ({ id: key, name: key === 'run' ? 'Run' : 'Test', ...value.commands[key], ...(key === 'test' ? { test: true } : {}) }));
    if (value?.version !== 2 || !Array.isArray(value.commands)) fail('Cannot read saved project commands. Restore commands.json before saving new commands.', 409);
    return value.commands;
  }
  find(id, commandId) {
    const command = this.list(id).find(item => item.id === commandId);
    if (!command) fail('That command was removed. Refresh the Run panel.', 404);
    return command;
  }
  write(id, commands) {
    fs.mkdirSync(path.dirname(this.filename(id)), { recursive: true, mode: 0o700 });
    withFileGuard(this.filename(id), () => atomicJSON(this.filename(id), { version: 2, commands }));
  }
  view(session, { output = true } = {}) {
    if (!session) return null;
    const fields = ['id', 'projectId', 'commandId', 'name', 'folderId', 'directory', 'command', 'cwd', 'status', 'truncated', 'exitCode', 'signal', 'error', 'startedAt', 'endedAt'];
    // The output comes plain, and as written (with its colours) for the panel to show.
    return { ...Object.fromEntries(fields.map(key => [key, session[key]])), ...(output ? { output: stripVTControlCharacters(session.output), ansi: session.output } : {}), urls: localCommandURLs(session.output) };
  }
  // Every command with its latest session. The output of one command, or of all when none is named, comes with it.
  state(id, { output } = {}) {
    const commands = this.list(id);
    return { commands, sessions: Object.fromEntries(commands.map(command => [command.id, this.view(this.sessions.get(this.key(id, command.id)), { output: output === undefined || output === command.id })]).filter(([, view]) => view)) };
  }
  detect(id, input) { return suggestions(this.registry.get(id), input); }
  // Adds a command, or changes one. Marking one for checks unmarks the others.
  save(id, input = {}) {
    if (this.closing) fail('Throughline is stopping.', 503);
    const config = configuration(this.registry.get(id), input), name = tidyName(input.name), commands = this.list(id);
    if (!name || name.length > 40) fail('Name the command in 40 characters or fewer.');
    const existing = input.id === undefined || input.id === null ? null : commands.find(command => command.id === input.id);
    if (input.id !== undefined && input.id !== null && !existing) fail('That command was removed. Refresh the Run panel.', 404);
    if (commands.some(command => command !== existing && command.name.toLowerCase() === name.toLowerCase())) fail(`A command called “${name}” already exists.`, 409);
    if (!existing && commands.length >= COMMAND_LIMIT) fail(`A workspace can keep up to ${COMMAND_LIMIT} commands.`, 409);
    let commandId = existing?.id;
    if (!commandId) { const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'command'; commandId = slug; for (let n = 2; commands.some(command => command.id === commandId) || commandId === 'detect'; n++) commandId = `${slug}-${n}`; }
    const test = typeof input.test === 'boolean' ? input.test : existing?.test === true;
    const saved = { id: commandId, name, ...config, ...(test ? { test: true } : {}) };
    const next = existing ? commands.map(command => command === existing ? saved : command) : [...commands, saved];
    this.write(id, next.map(command => command !== saved && test && command.test ? (({ test: _, ...rest }) => rest)(command) : command));
    return saved;
  }
  remove(id, commandId) {
    const key = this.key(id, commandId); this.find(id, commandId);
    if (commandActive(this.sessions.get(key))) fail('Stop this command before removing it.', 409);
    this.sessions.delete(key);
    this.write(id, this.list(id).filter(command => command.id !== commandId));
    return this.state(id, { output: null });
  }
  // A finished command's output is cleared; a running one keeps its output.
  clear(id, commandId) {
    const key = this.key(id, commandId); this.find(id, commandId);
    if (commandActive(this.sessions.get(key))) fail('Stop this command before clearing its output.', 409);
    this.sessions.delete(key);
    return this.state(id, { output: null });
  }
  start(id, commandId) {
    if (this.closing) fail('Throughline is stopping.', 503);
    const command = this.find(id, commandId), key = this.key(id, commandId);
    if (commandActive(this.sessions.get(key))) fail(`${command.name} is already running. Stop it or restart it.`, 409);
    if ([...this.sessions.values()].filter(commandActive).length >= 16) fail('Stop an active project command before starting another.', 409);
    // Acquire the existing per-workspace instance lock, but not the editing lease:
    // a dev server is allowed to stay alive during agent edits and reviewed patches.
    this.registry.broker(id);
    const { cwd } = location(this.registry.get(id), command);
    const session = { id: randomUUID(), projectId: id, commandId, name: command.name, folderId: command.folderId, directory: command.directory, command: command.command, cwd, status: 'starting', output: '', truncated: false, exitCode: null, signal: null, error: null, startedAt: new Date().toISOString(), endedAt: null, decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') } };
    session.done = new Promise(resolve => { session.resolve = resolve; }); this.sessions.set(key, session);
    const append = value => { session.output += value; if (session.output.length > commandLogLimit) { session.output = session.output.slice(-commandLogLimit); if (/^[\uDC00-\uDFFF]/.test(session.output)) session.output = session.output.slice(1); session.truncated = true; } };
    const finish = (code, signal, error) => {
      if (session.cleanupStarted) return; session.cleanupStarted = true;
      for (const decoder of Object.values(session.decoders)) append(decoder.end());
      session.exitCode = code; session.signal = signal; session.error ||= error?.message || null;
      const stopped = session.status === 'stopping';
      // A shell can exit leaving a server behind. Always clean its owned group.
      (session.cleanupPromise ||= this.terminate(session)).then(() => {
        session.status = stopped ? 'stopped' : session.error || code !== 0 ? 'failed' : 'exited';
        session.endedAt = new Date().toISOString(); session.resolve();
      }).catch(error => { session.error = `Process cleanup failed: ${error.message}`; session.status = 'failed'; session.endedAt = new Date().toISOString(); session.resolve(); });
    };
    try {
      const win = process.platform === 'win32';
      // Command Prompt reads the command line as written, as Node's own shell option passes it; quoted paths in a command
      // would otherwise reach it escaped for programs that are not Command Prompt.
      session.child = this.spawn(win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', win ? ['/d', '/s', '/c', `"${command.command}"`] : ['-c', command.command], { cwd, env: commandEnvironment(), detached: !win, windowsHide: true, windowsVerbatimArguments: win, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of ['stdout', 'stderr']) session.child[stream].on('data', chunk => append(session.decoders[stream].write(chunk)));
      session.child.once('spawn', () => { if (session.status === 'starting') session.status = 'running'; });
      session.child.once('error', error => { session.error = error.message; });
      // exit precedes close when descendants inherit stdout. Kill them before waiting for pipes.
      session.child.once('exit', (code, signal) => finish(code, signal));
      session.child.once('close', (code, signal) => finish(code, signal));
    } catch (error) { finish(null, null, error); }
    return this.view(session);
  }
  async restart(id, commandId) {
    const session = this.sessions.get(this.key(id, commandId));
    if (commandActive(session)) await this.stop(id, commandId, session.id);
    return this.start(id, commandId);
  }
  // Starts the command marked for Check with tests. The session shows in the panel as usual and Stop works.
  runTest(id) {
    const command = this.list(id).find(item => item.test);
    if (!command) fail('Mark a command for Check with tests in the Run panel first.', 404);
    if (commandActive(this.sessions.get(this.key(id, command.id)))) fail(`${command.name} was already running.`, 409);
    this.start(id, command.id);
    const session = this.sessions.get(this.key(id, command.id));
    return { done: session.done, view: () => this.view(session), stop: () => this.stop(id, command.id, session.id) };
  }
  async terminate(session) {
    const pid = session.child?.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, error => error && ![128, 255].includes(error.code) ? reject(error) : resolve())); return;
    }
    const signal = kind => { try { process.kill(-pid, kind); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    if (!signal('SIGTERM')) return;
    await new Promise(resolve => setTimeout(resolve, this.stopGrace));
    signal('SIGKILL');
  }
  async stop(id, commandId, sessionId) {
    this.registry.get(id);
    const session = this.sessions.get(this.key(id, commandId));
    if (!session || session.id !== sessionId) fail('That command session changed. Refresh before stopping it.', 409);
    if (!commandActive(session)) return this.view(session);
    if (session.status !== 'stopping') {
      session.status = 'stopping';
      // Start cleanup once; finish() will share it after the shell exits.
      session.cleanupPromise ||= this.terminate(session);
      await session.cleanupPromise;
    }
    await session.done; return this.view(session);
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.sessions.values()].filter(commandActive).map(session => this.stop(session.projectId, session.commandId, session.id)));
  }
}

export function createCommandRoutes({ registry, body, json }) {
  const commands = new ProjectCommands({ registry });
  return {
    commands,
    async route({ req, res, url }) {
      const match = /^\/api\/commands(?:\/(detect|save|remove|clear|start|stop|restart))?$/.exec(url.pathname);
      if (!match) return false;
      const id = url.searchParams.get('projectId'); if (!id) fail('Select a workspace first.'); registry.get(id);
      if (req.method === 'GET' && !match[1]) { const output = url.searchParams.get('output'); json(res, 200, commands.state(id, { output: output === null ? undefined : output })); return true; }
      if (req.method !== 'POST' || !match[1]) fail('Use GET to read commands or POST for a command action.', 405);
      const input = await body(req, 16 * 1024); registry.get(id);
      const action = match[1], commandId = input.id;
      if (['remove', 'clear', 'start', 'stop', 'restart'].includes(action) && (typeof commandId !== 'string' || !ID.test(commandId))) fail('Choose a command.');
      const value = action === 'detect' ? commands.detect(id, input) : action === 'save' ? commands.save(id, input) : action === 'remove' ? commands.remove(id, commandId) : action === 'clear' ? commands.clear(id, commandId)
        : action === 'start' ? commands.start(id, commandId) : action === 'restart' ? await commands.restart(id, commandId) : await commands.stop(id, commandId, input.sessionId);
      json(res, ['start', 'restart'].includes(action) ? 202 : 200, value); return true;
    },
    close: () => commands.close(),
  };
}

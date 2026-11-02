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
const actions = ['run', 'test'];
export const commandLogLimit = 64 * 1024;
export const commandActive = session => ['starting', 'running', 'stopping'].includes(session?.status);

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
function suggestions(project, input) {
  const selected = location(project, input);
  let manifest;
  try {
    const filename = path.join(selected.cwd, 'package.json');
    if (fs.statSync(filename).size > 256 * 1024) fail('package.json is too large to inspect. Enter commands manually.');
    manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.status) throw error;
    return { ...selected, manager: null, suggestions: {}, scripts: [], message: 'No readable package.json here. Enter any project command, or choose a package subdirectory.' };
  }
  const declared = typeof manifest?.packageManager === 'string' ? manifest.packageManager.split('@')[0] : null;
  const manager = ['npm', 'pnpm', 'yarn', 'bun'].includes(declared) ? declared :
    [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']].find(([file]) => fs.existsSync(path.join(selected.cwd, file)))?.[1] || 'npm';
  // Script names are data from an untrusted repo, never shell syntax.
  const scripts = Object.entries(manifest?.scripts || {}).filter(([name, value]) => /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(name) && typeof value === 'string').map(([name]) => name).slice(0, 100);
  const run = ['dev', 'start', 'serve'].find(name => scripts.includes(name));
  return { ...selected, manager, scripts, suggestions: { ...(run ? { run: `${manager} run ${run}` } : {}), ...(scripts.includes('test') ? { test: `${manager} run test` } : {}) }, message: 'Suggestions only. Review the command before running; package scripts can execute other commands.' };
}

export class ProjectCommands {
  constructor({ registry, spawnImpl = spawn, stopGrace = 1500 } = {}) {
    this.registry = registry; this.spawn = spawnImpl; this.stopGrace = stopGrace; this.sessions = new Map(); this.closing = false;
    registry.hasRunningCommands = id => this.active(id);
  }
  active(id) { return [...this.sessions.values()].some(session => session.projectId === id && commandActive(session)); }
  key(id, action) { if (!actions.includes(action)) fail('Choose Run or Test.'); return `${id}:${action}`; }
  filename(id) { return path.join(this.registry.dataRoot, id, 'commands.json'); }
  saved(id) {
    this.registry.get(id);
    try { const value = JSON.parse(fs.readFileSync(this.filename(id), 'utf8')); if (value.version !== 1 || !value.commands || typeof value.commands !== 'object') throw Error(); return value.commands; }
    catch (error) { if (error.code === 'ENOENT') return {}; fail('Cannot read saved project commands. Restore commands.json before saving new commands.', 409); }
  }
  view(session) {
    if (!session) return null;
    const fields = ['id', 'projectId', 'action', 'folderId', 'directory', 'command', 'cwd', 'status', 'output', 'truncated', 'exitCode', 'signal', 'error', 'startedAt', 'endedAt'];
    return { ...Object.fromEntries(fields.map(key => [key, session[key]])), output: stripVTControlCharacters(session.output), urls: localCommandURLs(session.output) };
  }
  state(id) { return { commands: this.saved(id), sessions: Object.fromEntries(actions.map(action => [action, this.view(this.sessions.get(this.key(id, action)))])) }; }
  detect(id, input) { return suggestions(this.registry.get(id), input); }
  save(id, action, input) {
    this.key(id, action); if (this.closing) fail('Throughline is stopping.', 503);
    const config = configuration(this.registry.get(id), input);
    fs.mkdirSync(path.dirname(this.filename(id)), { recursive: true, mode: 0o700 });
    withFileGuard(this.filename(id), () => atomicJSON(this.filename(id), { version: 1, commands: { ...this.saved(id), [action]: config } }));
    return config;
  }
  start(id, action, input) {
    if (this.closing) fail('Throughline is stopping.', 503);
    const key = this.key(id, action);
    if (commandActive(this.sessions.get(key))) fail(`This workspace already has an active ${action} command. Stop it before restarting.`, 409);
    if ([...this.sessions.values()].filter(commandActive).length >= 16) fail('Stop an active project command before starting another.', 409);
    // Acquire the existing per-workspace instance lock, but not the editing lease:
    // a dev server is allowed to stay alive during agent edits and reviewed patches.
    this.registry.broker(id);
    const config = this.save(id, action, input), { cwd } = location(this.registry.get(id), config);
    const session = { id: randomUUID(), projectId: id, action, ...config, cwd, status: 'starting', output: '', truncated: false, exitCode: null, signal: null, error: null, startedAt: new Date().toISOString(), endedAt: null, decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') } };
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
      session.child = this.spawn(win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', win ? ['/d', '/s', '/c', `"${config.command}"`] : ['-c', config.command], { cwd, env: commandEnvironment(), detached: !win, windowsHide: true, windowsVerbatimArguments: win, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of ['stdout', 'stderr']) session.child[stream].on('data', chunk => append(session.decoders[stream].write(chunk)));
      session.child.once('spawn', () => { if (session.status === 'starting') session.status = 'running'; });
      session.child.once('error', error => { session.error = error.message; });
      // exit precedes close when descendants inherit stdout. Kill them before waiting for pipes.
      session.child.once('exit', (code, signal) => finish(code, signal));
      session.child.once('close', (code, signal) => finish(code, signal));
    } catch (error) { finish(null, null, error); }
    return this.view(session);
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
  async stop(id, action, sessionId) {
    this.registry.get(id);
    const session = this.sessions.get(this.key(id, action));
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
    await Promise.all([...this.sessions.values()].filter(commandActive).map(session => this.stop(session.projectId, session.action, session.id)));
  }
}

export function createCommandRoutes({ registry, body, json }) {
  const commands = new ProjectCommands({ registry });
  return {
    commands,
    async route({ req, res, url }) {
      const match = /^\/api\/commands(?:\/(detect|run|test)(?:\/(start|stop))?)?$/.exec(url.pathname);
      if (!match) return false;
      const id = url.searchParams.get('projectId'); if (!id) fail('Select a workspace first.'); registry.get(id);
      if (req.method === 'GET' && !match[1]) { json(res, 200, commands.state(id)); return true; }
      if (req.method !== 'POST' || !match[1]) fail('Use GET to read commands or POST for a command action.', 405);
      const input = await body(req, 16 * 1024); registry.get(id);
      const value = match[1] === 'detect' && !match[2] ? commands.detect(id, input) : match[2] === 'start' ? commands.start(id, match[1], input) : match[2] === 'stop' ? await commands.stop(id, match[1], input.sessionId) : commands.save(id, match[1], input);
      json(res, match[2] === 'start' ? 202 : 200, value); return true;
    },
    close: () => commands.close(),
  };
}

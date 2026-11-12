import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { commandEnvironment } from './resolve-binary.mjs';

// The workspace terminal (#7, #70): interactive shells in pseudo-terminals from node-pty, each started in an attached
// folder. A workspace keeps several: each opens as a tab of its own, or as the second pane of a tab split side by side
// or stacked. They are the person's own shells, so agent access settings such as Read only do not apply to them, and
// like project commands they take no editing lease: a dev server keeps running while agents edit files. Output is
// kept as bounded scrollback so a view that reconnects, or a workspace opened again, shows each session as it was.
// Ending a session, removing its workspace or quitting Codeshi stops the shell and every process it started.
const require = createRequire(import.meta.url);
export const SCROLLBACK = 256 * 1024;
const INPUT_LIMIT = 64 * 1024;
// Shells one workspace keeps open at once, and panes in one tab.
export const MAX_SESSIONS = 8, MAX_PANES = 2;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const terminalActive = session => ['running', 'stopping'].includes(session?.status);

// npm installs node-pty's macOS helper without its execute bit, and the shell cannot start without it. The packaged app
// is fixed when it is built (desktop/package.mjs); a copy run from source is fixed here.
export function prepareHelper(root = path.dirname(require.resolve('node-pty/package.json')), platform = process.platform, arch = process.arch) {
  const helper = path.join(root, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
  try { fs.accessSync(helper, fs.constants.X_OK); } catch { try { fs.chmodSync(helper, 0o755); } catch { /* A missing helper fails at start with node-pty's own error. */ } }
}

// The person's login shell, read from the environment Codeshi was opened with. Windows has none, so PowerShell 7 is
// used when it is installed, then the Windows PowerShell every system has, then Command Prompt.
export function loginShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const system = env.SystemRoot || 'C:\\Windows';
    const pwsh = (env.PATH || env.Path || '').split(';').filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, 'pwsh.exe')).find(file => fs.existsSync(file));
    return [pwsh, path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')].find(file => file && fs.existsSync(file)) || env.ComSpec || path.join(system, 'System32', 'cmd.exe');
  }
  const shell = env.SHELL;
  return shell && path.isAbsolute(shell) && fs.existsSync(shell) ? shell : fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
}
// A POSIX shell starts as a login shell, so it reads the person's profile. PowerShell reads its profile anyway.
export function shellArguments(shell) {
  const name = path.win32.basename(shell).toLowerCase();
  return ['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell'].includes(name) ? ['-NoLogo'] : ['cmd.exe', 'cmd'].includes(name) ? [] : ['-l'];
}
// Windows has no signal that asks a process to stop, so a shell and every process it started end together.
export function endProcessTree(pid) {
  const taskkill = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise(resolve => execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

// Every process the shell started, found before the shell ends, since its children are then adopted by launchd.
export function processTree(root) {
  return new Promise(resolve => execFile('/bin/ps', ['-axo', 'pid=,ppid='], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) return resolve([]);
    const children = new Map();
    for (const line of String(stdout).trim().split('\n')) { const [pid, ppid] = line.trim().split(/\s+/).map(Number); if (pid && ppid) children.set(ppid, [...children.get(ppid) || [], pid]); }
    const found = [], queue = [...children.get(root) || []];
    while (queue.length) { const pid = queue.shift(); if (found.includes(pid)) continue; found.push(pid); queue.push(...children.get(pid) || []); }
    resolve(found);
  }));
}
const signal = (pid, kind) => { try { process.kill(pid, kind); return true; } catch { return false; } };

// The codeshi command (#90) in a tab of the window: the command inside this app, run by the app's own binary acting as
// Node, and pointed at this engine through its connection file. Without a connection file (a test, the smoke run or a
// plain server) there is no CLI tab.
export const CLI_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'codeshi.mjs');
export function cliCommand(connection, { execPath = process.execPath, entry = CLI_ENTRY } = {}) {
  if (!connection) return null;
  // The window's terminal draws the 256 standard colours with its own styles, but full 24-bit colours only as inline
  // styles, which the page's security policy blocks, so the command is asked for 256 colours.
  return { file: execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1', CODESHI_CONNECTION: connection, CODESHI_EMBEDDED: '1', COLORTERM: '', FORCE_COLOR: '2' } };
}
// On Windows, Codeshi.exe / electron.exe is a GUI executable: spawned directly inside ConPTY it drops its output, so it
// starts through cmd.exe with paths in environment variables where cmd's quote and metacharacter rules cannot corrupt them.
export function windowsCliLaunch({ file, args = [], env = {} }, shellEnv = process.env) {
  const comspec = shellEnv.ComSpec || path.win32.join(shellEnv.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const command = ['"%CODESHI_CLI_EXEC%"', ...args.map((_, index) => `"%CODESHI_CLI_ARG_${index}%"`)].join(' ');
  return {
    file: comspec,
    args: `/d /s /c "${command}"`,
    env: { ...env, CODESHI_CLI_EXEC: file, ...Object.fromEntries(args.map((value, index) => [`CODESHI_CLI_ARG_${index}`, value])) },
  };
}

export class TerminalSessions {
  constructor({ registry, pty = null, shell = loginShell(), stopGrace = 1500, tree = processTree, flushMs = 8, platform = process.platform, endTree = endProcessTree, cli = null } = {}) {
    this.registry = registry; this.ptyImpl = pty; this.shell = shell; this.stopGrace = stopGrace; this.tree = tree; this.flushMs = flushMs; this.platform = platform; this.endTree = endTree; this.cli = cli;
    // Every session, by its own id; each knows its workspace, its tab and its place in that tab.
    // Tabs keep the order they opened in, counted rather than timed so two opened at once keep theirs.
    this.sessions = new Map(); this.closing = false; this.opened = 0;
    // A removed workspace takes its terminals with it.
    this.onProjects = () => { for (const session of [...this.sessions.values()]) { try { registry.get(session.projectId); } catch { this.stop(session.projectId, session.id).catch(() => {}); } } };
    registry.on?.('projects', this.onProjects);
  }
  pty() { if (!this.ptyImpl) { prepareHelper(); this.ptyImpl = require('node-pty'); } return this.ptyImpl; }
  view(session) {
    if (!session) return null;
    return Object.fromEntries(['id', 'kind', 'projectId', 'folderId', 'folderName', 'cwd', 'shell', 'status', 'exitCode', 'signal', 'error', 'startedAt', 'endedAt', 'cols', 'rows', 'tabId', 'pane', 'split', 'order'].map(key => [key, session[key]]));
  }
  // A workspace's shells in the order its tabs opened, each tab's panes in their order. Its CLI tab is kept apart: it
  // shows over the conversation, not in the bottom panel, and doesn't count toward the shells a workspace keeps.
  list(projectId) { return [...this.sessions.values()].filter(session => session.projectId === projectId && session.kind !== 'cli').sort((a, b) => a.order - b.order || a.pane - b.pane); }
  cliSession(projectId) { return [...this.sessions.values()].find(session => session.projectId === projectId && session.kind === 'cli') || null; }
  state(projectId) { this.registry.get(projectId); return { sessions: this.list(projectId).map(session => this.view(session)), shell: path.win32.basename(this.shell).replace(/\.exe$/i, ''), cli: this.view(this.cliSession(projectId)), cliAvailable: Boolean(this.cli) }; }
  // A session of this workspace; an id from another workspace is refused like one that ended.
  session(projectId, id) {
    this.registry.get(projectId);
    const session = this.sessions.get(id);
    if (!session || session.projectId !== projectId) fail('That terminal session ended. Open the terminal again.', 409);
    return session;
  }
  size(cols, rows) {
    const value = (input, fallback) => Number.isInteger(input) ? Math.max(2, Math.min(1000, input)) : fallback;
    return { cols: value(cols, 100), rows: value(rows, 30) };
  }

  // Opens a shell in an attached folder: in a tab of its own, as the second pane of a tab (split: the session to split
  // and 'right' or 'down'), or in place of a session that has ended (replace), keeping that one's tab and place.
  start(projectId, { folderId, cols, rows, split = null, replace = null, kind = 'shell' } = {}) {
    if (this.closing) fail('Codeshi is stopping.', 503);
    if (kind === 'cli') return this.startCli(projectId, { folderId, cols, rows });
    const project = this.registry.get(projectId), open = this.list(projectId);
    let place = { tabId: null, pane: 0, split: null, order: ++this.opened }, replaced = null;
    if (replace) {
      replaced = this.session(projectId, replace);
      if (terminalActive(replaced)) fail('That shell is still running. End it before starting another in its place.', 409);
      place = { tabId: replaced.tabId, pane: replaced.pane, split: replaced.split, order: replaced.order };
    } else {
      if (open.length >= MAX_SESSIONS) fail(`A workspace keeps up to ${MAX_SESSIONS} terminals. End one to open another.`, 409);
      if (split) {
        if (!['right', 'down'].includes(split.direction)) fail('Split the terminal to the right or down.');
        const beside = this.session(projectId, split.of);
        if (open.filter(session => session.tabId === beside.tabId).length >= MAX_PANES) fail('This tab already has two panes. Open a new tab instead.', 409);
        place = { tabId: beside.tabId, pane: 1, split: split.direction, order: beside.order };
      }
    }
    const { folder, cwd } = this.folder(project, folderId);
    const session = this.create({ projectId, folder, cwd, size: this.size(cols, rows), place, kind: 'shell', shell: this.shell });
    // A session that ended gives its place to the new one; its views are told it closed.
    if (replaced) this.discard(replaced);
    return this.launch(session, this.shell, shellArguments(this.shell), {}, 'The shell');
  }

  // The workspace's CLI tab: one per workspace. Opening it again returns the one that runs; one that ended gives way to
  // a new one. It starts in the chosen folder (else the first), on the workspace's conversation.
  startCli(projectId, { folderId, cols, rows } = {}) {
    if (!this.cli) fail('The codeshi tab works in the Codeshi app.', 409);
    const project = this.registry.get(projectId), existing = this.cliSession(projectId);
    if (existing && terminalActive(existing)) return this.view(existing);
    const { folder, cwd } = this.folder(project, folderId || project.folders[0]?.id);
    const session = this.create({ projectId, folder, cwd, size: this.size(cols, rows), place: { tabId: null, pane: 0, split: null, order: ++this.opened }, kind: 'cli', shell: 'codeshi' });
    if (existing) this.discard(existing);
    const argv = [...this.cli.args, '--workspace', projectId];
    const target = this.platform === 'win32' ? windowsCliLaunch({ file: this.cli.file, args: argv, env: this.cli.env }) : { file: this.cli.file, args: argv, env: this.cli.env };
    return this.launch(session, target.file, target.args, target.env, 'codeshi');
  }

  folder(project, folderId) {
    const folder = project.folders.find(entry => entry.id === folderId);
    if (!folder) fail('Choose an attached workspace folder.');
    let cwd;
    try { cwd = fs.realpathSync(folder.path); if (!fs.statSync(cwd).isDirectory()) throw new Error(); }
    catch { fail('That folder is unavailable. Restore it or choose another folder.', 404); }
    return { folder, cwd };
  }
  create({ projectId, folder, cwd, size, place, kind, shell }) {
    const session = { id: randomUUID(), kind, projectId, folderId: folder.id, folderName: folder.displayName || folder.name, cwd, shell, status: 'running', exitCode: null, signal: null, error: null, startedAt: new Date().toISOString(), endedAt: null, ...size, ...place, scrollback: '', offset: 0, pending: '', timer: null, listeners: new Set() };
    session.tabId ||= session.id;
    session.done = new Promise(resolve => { session.resolve = resolve; });
    return session;
  }
  discard(session) { this.sessions.delete(session.id); for (const listener of session.listeners) listener({ type: 'closed' }); session.listeners.clear(); }
  launch(session, file, args, env, name) {
    this.sessions.set(session.id, session);
    try {
      session.process = this.pty().spawn(file, args, { name: 'xterm-256color', cols: session.cols, rows: session.rows, cwd: session.cwd, env: { ...commandEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Codeshi', ...env } });
      session.pid = session.process.pid;
    } catch (error) {
      Object.assign(session, { status: 'failed', error: `${name} could not start: ${error.message}`, endedAt: new Date().toISOString() });
      session.resolve();
      return this.view(session);
    }
    session.process.onData(data => this.output(session, data));
    session.process.onExit(({ exitCode, signal: code }) => this.exited(session, exitCode, code));
    return this.view(session);
  }

  // Output is kept as bounded scrollback and sent to open views in small batches.
  output(session, data) {
    session.scrollback += data; session.offset += data.length;
    if (session.scrollback.length > SCROLLBACK) session.scrollback = session.scrollback.slice(-SCROLLBACK);
    session.pending += data;
    if (!session.timer) session.timer = setTimeout(() => this.flush(session), this.flushMs);
  }
  flush(session) {
    clearTimeout(session.timer); session.timer = null;
    if (!session.pending) return;
    const data = session.pending; session.pending = '';
    for (const listener of session.listeners) listener({ type: 'data', data, offset: session.offset });
  }
  exited(session, exitCode, code) {
    if (session.endedAt) return;
    this.flush(session);
    Object.assign(session, { status: session.status === 'stopping' ? 'stopped' : 'exited', exitCode, signal: code || null, endedAt: new Date().toISOString() });
    for (const listener of session.listeners) listener({ type: 'exit', session: this.view(session) });
    session.resolve();
  }

  write(projectId, id, data) {
    const session = this.session(projectId, id);
    if (typeof data !== 'string' || data.length > INPUT_LIMIT) fail('Terminal input is too large.');
    if (session.status !== 'running') fail('The shell has exited. Start a new session.', 409);
    session.process.write(data);
    return { written: data.length };
  }
  resize(projectId, id, { cols, rows } = {}) {
    const session = this.session(projectId, id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) fail('Give the terminal size in columns and rows.');
    Object.assign(session, this.size(cols, rows));
    if (session.status === 'running') try { session.process.resize(session.cols, session.rows); } catch { /* The shell is exiting. */ }
    return this.view(session);
  }

  // A view gets the scrollback it has not seen, then live output. A view that fell further behind than the scrollback
  // keeps is reset and gets all of it.
  subscribe(projectId, id, since, listener) {
    const session = this.session(projectId, id), start = session.offset - session.scrollback.length;
    const known = Number.isSafeInteger(since) && since >= start && since <= session.offset;
    listener({ type: known ? 'data' : 'reset', data: known ? session.scrollback.slice(since - start) : session.scrollback, offset: session.offset });
    if (session.endedAt) { listener({ type: 'exit', session: this.view(session) }); return () => {}; }
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  // Ends the shell and everything it started: the shell gets a hangup, as when a terminal window closes, and its
  // processes are asked to stop, then stopped.
  async stop(projectId, id) {
    const session = this.sessions.get(id);
    if (!session || session.projectId !== projectId) return null;
    if (terminalActive(session) && session.status !== 'stopping') {
      session.status = 'stopping';
      if (this.platform === 'win32') {
        if (session.pid) await this.endTree(session.pid);
        try { session.process.kill(); } catch { /* Already gone. */ }
      } else {
        const processes = session.pid ? await this.tree(session.pid) : [];
        try { session.process.kill('SIGHUP'); } catch { /* Already gone. */ }
        for (const pid of processes) signal(pid, 'SIGTERM');
        const ended = await Promise.race([session.done.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), this.stopGrace))]);
        for (const pid of processes) signal(pid, 'SIGKILL');
        if (!ended && session.pid) signal(session.pid, 'SIGKILL');
      }
      await Promise.race([session.done, new Promise(resolve => setTimeout(resolve, this.stopGrace))]);
      if (!session.endedAt) this.exited(session, null, 'SIGKILL');
    }
    if (this.sessions.get(id) === session) {
      this.sessions.delete(id);
      // The other pane of a split tab is now the tab's only one.
      const partner = this.list(projectId).find(other => other.tabId === session.tabId);
      if (partner) Object.assign(partner, { pane: 0, split: null });
    }
    for (const listener of session.listeners) listener({ type: 'closed' });
    session.listeners.clear();
    return this.view(session);
  }
  async close() {
    this.closing = true;
    this.registry.off?.('projects', this.onProjects);
    await Promise.all([...this.sessions.values()].map(session => this.stop(session.projectId, session.id)));
  }
}

export function createTerminalRoutes({ registry, body, json, cli = null, sessions = new TerminalSessions({ registry, cli }) }) {
  return {
    sessions,
    async route({ req, res, url }) {
      const match = /^\/api\/terminal(?:\/(start|input|resize|stop|stream))?$/.exec(url.pathname);
      if (!match) return false;
      const projectId = url.searchParams.get('projectId');
      if (!projectId) fail('Select a workspace first.');
      if (!match[1]) { if (req.method !== 'GET') fail('Use GET to read the terminal.', 405); json(res, 200, sessions.state(projectId)); return true; }
      if (match[1] === 'stream') {
        if (req.method !== 'GET') fail('Use GET to follow the terminal.', 405);
        const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since'));
        // Each message carries its offset, so a stream that reconnects resumes where it left off.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = event => {
          if (event.type === 'closed') { res.end(); return; }
          res.write(`${event.offset !== undefined ? `id: ${event.offset}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event.type === 'exit' ? event.session : { data: event.data })}\n\n`);
        };
        const unsubscribe = sessions.subscribe(projectId, url.searchParams.get('id'), Number.isSafeInteger(since) && (req.headers['last-event-id'] || url.searchParams.has('since')) ? since : null, send);
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
        req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
        return true;
      }
      if (req.method !== 'POST') fail('Use POST to control the terminal.', 405);
      const input = await body(req, 128 * 1024);
      const value = match[1] === 'start' ? sessions.start(projectId, input)
        : match[1] === 'input' ? sessions.write(projectId, input.id, input.data)
        : match[1] === 'resize' ? sessions.resize(projectId, input.id, input)
        : await sessions.stop(projectId, input.id);
      json(res, match[1] === 'start' ? 201 : 200, value ?? { session: null }); return true;
    },
    close: () => sessions.close(),
  };
}

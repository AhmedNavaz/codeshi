import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { commandEnvironment } from './resolve-binary.mjs';

// The workspace terminal (#7, #70): interactive shells in pseudo-terminals from node-pty, each started in an attached
// folder. A workspace keeps several: each opens as a tab of its own, or as the second pane of a tab split side by side
// or stacked. They are the person's own shells, so agent access settings such as Read only do not apply to them, and
// like project commands they take no editing lease: a dev server keeps running while agents edit files. Output is
// kept as bounded scrollback so a view that reconnects, or a workspace opened again, shows each session as it was.
// Ending a session, removing its workspace or quitting Throughline stops the shell and every process it started.
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

// The person's login shell, read from the environment Throughline was opened with. Windows has none, so PowerShell 7 is
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

export class TerminalSessions {
  constructor({ registry, pty = null, shell = loginShell(), stopGrace = 1500, tree = processTree, flushMs = 8, platform = process.platform, endTree = endProcessTree } = {}) {
    this.registry = registry; this.ptyImpl = pty; this.shell = shell; this.stopGrace = stopGrace; this.tree = tree; this.flushMs = flushMs; this.platform = platform; this.endTree = endTree;
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
    return Object.fromEntries(['id', 'projectId', 'folderId', 'folderName', 'cwd', 'shell', 'status', 'exitCode', 'signal', 'error', 'startedAt', 'endedAt', 'cols', 'rows', 'tabId', 'pane', 'split', 'order'].map(key => [key, session[key]]));
  }
  // A workspace's sessions in the order its tabs opened, each tab's panes in their order.
  list(projectId) { return [...this.sessions.values()].filter(session => session.projectId === projectId).sort((a, b) => a.order - b.order || a.pane - b.pane); }
  state(projectId) { this.registry.get(projectId); return { sessions: this.list(projectId).map(session => this.view(session)), shell: path.win32.basename(this.shell).replace(/\.exe$/i, '') }; }
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
  start(projectId, { folderId, cols, rows, split = null, replace = null } = {}) {
    if (this.closing) fail('Throughline is stopping.', 503);
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
    const folder = project.folders.find(entry => entry.id === folderId);
    if (!folder) fail('Choose an attached workspace folder.');
    let cwd;
    try { cwd = fs.realpathSync(folder.path); if (!fs.statSync(cwd).isDirectory()) throw new Error(); }
    catch { fail('That folder is unavailable. Restore it or choose another folder.', 404); }
    const size = this.size(cols, rows);
    const session = { id: randomUUID(), projectId, folderId: folder.id, folderName: folder.displayName || folder.name, cwd, shell: this.shell, status: 'running', exitCode: null, signal: null, error: null, startedAt: new Date().toISOString(), endedAt: null, ...size, ...place, scrollback: '', offset: 0, pending: '', timer: null, listeners: new Set() };
    session.tabId ||= session.id;
    session.done = new Promise(resolve => { session.resolve = resolve; });
    // A session that ended gives its place to the new one; its views are told it closed.
    if (replaced) { this.sessions.delete(replaced.id); for (const listener of replaced.listeners) listener({ type: 'closed' }); replaced.listeners.clear(); }
    this.sessions.set(session.id, session);
    try {
      session.process = this.pty().spawn(this.shell, shellArguments(this.shell), { name: 'xterm-256color', ...size, cwd, env: { ...commandEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Throughline' } });
      session.pid = session.process.pid;
    } catch (error) {
      Object.assign(session, { status: 'failed', error: `The shell could not start: ${error.message}`, endedAt: new Date().toISOString() });
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

export function createTerminalRoutes({ registry, body, json, sessions = new TerminalSessions({ registry }) }) {
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

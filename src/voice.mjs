import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Voice input (#11): speech is recognized on this Mac by a small helper, "Codeshi Speech"
// (native/macos/speech), with Apple's on-device recognizer. Audio never leaves the computer. One listening session
// runs at a time; the page follows its transcript as it is heard, and listening stops when asked or after two minutes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'native', 'macos', 'speech');
export const LISTEN_LIMIT = 2 * 60 * 1000;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export const helperPath = (arch = process.arch) => path.join(root, 'native', 'bin', `darwin-${arch}`, 'Codeshi Speech');

// Builds the helper with the Swift compiler from Xcode or its command line tools: at packaging time for the release,
// or on first use when running from source. Its usage descriptions are embedded, and it is signed so macOS can keep
// its permissions.
export function buildHelper({ arch = process.arch, out = helperPath(arch), run = execFile } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const exec = (file, args) => new Promise((resolve, reject) => run(file, args, { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr || '') })) : resolve(String(stdout || ''))));
  const temporary = `${out}.build-${process.pid}`;
  return exec('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos13.0`, path.join(SOURCE, 'main.swift'), '-o', temporary, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(SOURCE, 'Info.plist')])
    .then(() => exec('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'local.throughline.speech', temporary]))
    .then(() => { fs.renameSync(temporary, out); return out; })
    .catch(error => { fs.rmSync(temporary, { force: true }); throw new Error(/xcrun|swiftc|developer tools/i.test(`${error.message} ${error.stderr}`) ? 'Voice input needs the Swift compiler to build from source. Install Xcode or its command line tools (xcode-select --install).' : `The speech helper could not be built: ${String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ')}`); });
}

export class VoiceSessions {
  constructor({ platform = process.platform, helper = helperPath(), build = () => buildHelper(), spawnImpl = spawn, limit = LISTEN_LIMIT, readyWait = 60000 } = {}) {
    Object.assign(this, { platform, helper, build, spawnImpl, limit, readyWait });
    this.session = null; this.building = null; this.closing = false;
  }
  supported() { return this.platform === 'darwin'; }
  async ensureHelper() {
    if (!this.supported()) fail('Voice input is available on macOS for now.', 409);
    if (fs.existsSync(this.helper)) return this.helper;
    this.building ||= this.build().finally(() => { this.building = null; });
    try { await this.building; } catch (error) { fail(error.message, 503); }
    return this.helper;
  }
  // Permission and on-device availability, read without asking for anything.
  async status({ locale } = {}) {
    if (!this.supported()) return { supported: false };
    if (!fs.existsSync(this.helper) && !this.building) return { supported: true, helper: 'missing' };
    if (this.building) return { supported: true, helper: 'building' };
    const check = await new Promise(resolve => execFile(this.helper, ['--check', ...locale ? ['--locale', locale] : []], { timeout: 10000 }, (_error, stdout) => {
      const line = String(stdout || '').trim().split('\n').reverse().map(row => { try { return JSON.parse(row); } catch { return null; } }).find(Boolean);
      resolve(line || { type: 'error', code: 'helper', message: 'The speech helper did not answer.' });
    }));
    return { supported: true, helper: 'ready', ...(check.type === 'check' ? { speech: check.speech, microphone: check.microphone, onDevice: check.onDevice, locale: check.locale } : { error: check.message, code: check.code }), listening: Boolean(this.session) };
  }

  async start({ locale } = {}) {
    if (this.closing) fail('Codeshi is stopping.', 503);
    if (locale !== undefined && (typeof locale !== 'string' || !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(locale))) fail('Choose a language for voice input.');
    if (this.session) fail('Voice input is already listening.', 409);
    const session = { id: randomUUID(), status: 'starting', text: '', events: [], listeners: new Set(), startedAt: new Date().toISOString() };
    this.session = session;
    let helper;
    try { helper = await this.ensureHelper(); } catch (error) { this.session = null; throw error; }
    const child = this.spawnImpl(helper, locale ? ['--locale', locale] : [], { stdio: ['pipe', 'pipe', 'pipe'] });
    session.child = child;
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        this.event(session, event);
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', error => this.event(session, { type: 'error', code: 'helper', message: `The speech helper could not start: ${error.message}` }));
    child.on('close', () => { if (!session.done) this.event(session, session.text ? { type: 'final', text: session.text } : { type: 'error', code: 'helper', message: 'Voice input stopped unexpectedly.' }); });
    // macOS asks for permission the first time; a request nobody answers should not listen forever.
    session.waiting = setTimeout(() => { if (session.status === 'starting') this.event(session, { type: 'error', code: 'permission-wait', message: 'Codeshi Speech is waiting for permission. Answer the macOS prompt, then try again.' }); }, this.readyWait);
    session.limit = setTimeout(() => this.stop(session.id).catch(() => {}), this.limit);
    return { id: session.id, status: session.status };
  }

  event(session, event) {
    if (session.done) return;
    if (event.type === 'ready') session.status = 'listening';
    if (event.type === 'partial' || event.type === 'final') session.text = String(event.text || '');
    const view = event.type === 'level' ? { type: 'level', value: Number(event.value) || 0 }
      : event.type === 'partial' || event.type === 'final' ? { type: event.type, text: session.text }
      : event.type === 'error' ? { type: 'error', code: String(event.code || 'error'), message: String(event.message || 'Voice input failed.') }
      : { type: event.type };
    if (view.type !== 'level') session.events.push(view);
    for (const listener of session.listeners) listener(view);
    if (view.type === 'final' || view.type === 'error') this.end(session);
  }
  end(session) {
    session.done = true; session.status = 'done';
    clearTimeout(session.waiting); clearTimeout(session.limit);
    try { session.child?.kill('SIGTERM'); } catch { /* Already gone. */ }
    for (const listener of session.listeners) listener({ type: 'closed' });
    session.listeners.clear();
    if (this.session === session) this.session = null;
  }
  current(id) {
    if (!this.session || this.session.id !== id) fail('That voice input ended.', 409);
    return this.session;
  }
  // A listener gets what was heard so far, then the rest as it comes.
  subscribe(id, listener) {
    const session = this.current(id);
    for (const event of session.events) listener(event);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }
  // Stopping keeps what was said; the helper sends its final transcript and exits.
  async stop(id) {
    const session = this.current(id);
    if (session.status !== 'stopping') { session.status = 'stopping'; try { session.child.stdin.write('stop\n'); session.child.stdin.end(); } catch { /* It has already exited. */ } }
    return { id, status: 'stopping' };
  }
  // Cancelling discards it.
  cancel(id) {
    const session = this.current(id);
    this.event(session, { type: 'error', code: 'cancelled', message: 'Voice input was cancelled.' });
    return { id, status: 'cancelled' };
  }
  async close() { this.closing = true; if (this.session) this.end(this.session); }
}

export function createVoiceRoutes({ body, json, sessions = new VoiceSessions() }) {
  return {
    sessions,
    async route({ req, res, url }) {
      const match = /^\/api\/voice(?:\/(start|stop|cancel|stream))?$/.exec(url.pathname);
      if (!match) return false;
      if (!match[1]) { if (req.method !== 'GET') fail('Use GET to read voice input.', 405); json(res, 200, await sessions.status({ locale: url.searchParams.get('locale') || undefined })); return true; }
      if (match[1] === 'stream') {
        if (req.method !== 'GET') fail('Use GET to follow voice input.', 405);
        const unsubscribe = sessions.subscribe(url.searchParams.get('id'), event => {
          if (event.type === 'closed') { res.end(); return; }
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        if (!res.headersSent && !res.writableEnded) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        req.on('close', unsubscribe);
        return true;
      }
      if (req.method !== 'POST') fail('Use POST to control voice input.', 405);
      const input = await body(req, 16 * 1024);
      json(res, match[1] === 'start' ? 201 : 200, match[1] === 'start' ? await sessions.start(input) : match[1] === 'stop' ? await sessions.stop(input.id) : sessions.cancel(input.id));
      return true;
    },
    close: () => sessions.close(),
  };
}

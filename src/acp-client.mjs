import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ACP is newline-delimited JSON-RPC. Bound frames before parsing, and fail all
// outstanding requests on malformed output, timeout, exit or cancellation.
export class GeminiClient extends EventEmitter {
  constructor({ bin, cwd, args, env, spawnImpl = spawn, platform = process.platform, killTree = null } = {}) {
    super(); this.pending = new Map(); this.counter = 0; this.closed = false; this.silencePaused = false;
    this.realSpawn = spawnImpl === spawn; this.platform = platform; this.killTree = killTree;
    this.child = spawnImpl(bin, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', diagnostic = '';
    this.child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8000); this.emit('diagnostic', diagnostic); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.restartSilence();
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { this.fail(new Error('Oversized Gemini protocol event.')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (!message || message.jsonrpc !== '2.0') throw new Error('Expected JSON-RPC 2.0.');
          if (message.id !== undefined && !message.method) {
            const request = this.pending.get(message.id); if (!request) continue;
            clearTimeout(request.timer); this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message || 'Gemini protocol error.'));
            else request.resolve(message.result);
          } else this.emit('message', message);
        } catch (error) { this.fail(new Error('Invalid Gemini protocol: ' + error.message)); return; }
      }
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => this.fail(new Error(diagnostic || `Gemini ACP closed (${code ?? signal}).`)));
  }
  send(message) { if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  // With `silence`, the timeout measures how long the agent has said nothing rather than how long the request has taken:
  // a turn can run for hours and still be working.
  request(method, params = {}, timeout = 30000, { silence = false } = {}) {
    if (this.closed) return Promise.reject(new Error('Gemini ACP is closed.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const reason = silence ? `no activity for ${Math.round(timeout / 60000)} minutes while nothing was running or waiting for you.` : method;
      const expire = () => { this.pending.delete(id); reject(new Error('Gemini protocol timed out: ' + reason)); this.close(); };
      const entry = { resolve, reject, timer: setTimeout(expire, timeout) };
      if (silence) entry.restart = () => { clearTimeout(entry.timer); entry.timer = this.silencePaused ? null : setTimeout(expire, timeout); };
      this.pending.set(id, entry); this.send({ id, method, params });
    });
  }
  restartSilence() { for (const request of this.pending.values()) request.restart?.(); }
  // A long command or an unanswered approval is silent by nature, so neither counts against the agent.
  pauseSilence(paused) { if (paused === this.silencePaused) return; this.silencePaused = paused; this.restartSilence(); }
  fail(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin?.end(); } catch {}
    if (this.child.exitCode != null || this.child.signalCode != null) return;
    // Windows single-file runtimes (agy_acp_server.exe) spawn an unpacked child process that survives killing only the launcher PID.
    if (this.platform === 'win32' && typeof this.child?.pid === 'number' && (this.killTree || this.realSpawn)) {
      const kill = this.killTree || (pid => execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => { try { this.child.kill('SIGTERM'); } catch {} }));
      kill(this.child.pid);
      return;
    }
    try { this.child.kill('SIGTERM'); } catch {}
  }
}

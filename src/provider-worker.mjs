import { runGemini } from './gemini.mjs';
import { spawn } from 'node:child_process';
import { runCodex, runClaude, classifyError } from './providers.mjs';
import { withBinaryPath } from './resolve-binary.mjs';
// The desktop app runs this worker as Node through its Electron binary. Agents and the commands they run must not
// inherit that setting, or an Electron app they start (such as Codeshi itself, run from source) runs as plain
// Node and fails.
delete process.env.ELECTRON_RUN_AS_NODE;
let running = false;
let cancelled = false;
let finished = false;
const pending = new Map();
// Set by the adapter while its turn can take more input from the person (a note added during the run).
let steer = null;
const send = value => { if (process.connected) process.send(value); };
// Resolves once the message is written. IPC writes finish in order, so every earlier message has been written too.
const sendLast = value => new Promise(resolve => { if (process.connected) process.send(value, () => resolve()); else resolve(); });
process.on('disconnect', () => { if (!finished && process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGTERM'); } catch {} } process.exit(finished ? process.exitCode || 0 : 1); });
process.on('message', async message => {
  if (message.type === 'approval-result') { pending.get(message.id)?.(message.allow); pending.delete(message.id); return; }
  // Answers to an agent's questions, one list per question, or null when the person skipped them.
  if (message.type === 'question-result') { pending.get(message.id)?.(Array.isArray(message.answers) ? message.answers : null); pending.delete(message.id); return; }
  if (message.type === 'steer') {
    let error = 'This run cannot take more input now.';
    try { if (steer && !cancelled) { await steer(String(message.text)); error = null; } } catch (failure) { error = failure.message; }
    send({ type: 'steer-result', id: message.id, ok: !error, error }); return;
  }
  if (message.type === 'cancel') { cancelled = true; for (const resolve of pending.values()) resolve(false); pending.clear(); return; }
  if (message.type !== 'start' || running) return;
  running = true;
  const config = message.config;
  try {
    if (config.transport === 'cli') {
      const child = spawn(config.bin, config.args, { cwd: config.workspace, env: withBinaryPath(config.bin), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
      child.on('error', error => { send({ type: 'failure', message: error.message, category: classifyError(error) }); process.exitCode = 1; });
      // Piped output can still be queued, and disconnecting exits the worker, so wait until it is written.
      child.on('close', (code, signal) => { process.exitCode = code ?? 1; finished = true; process.stdout.write('', () => process.disconnect()); });
      child.stdin.on('error', () => {}); child.stdin.end(config.prompt);
      return;
    }
    const callbacks = {
      event: event => send({ type: 'event', event }),
      metadata: metadata => send({ type: 'metadata', metadata }),
      cancelled: () => cancelled,
      approval: request => new Promise(resolve => { const id = String(request.id); pending.set(id, resolve); send({ type: 'approval', request: { ...request, id } }); }),
      // Stopping the run answers a waiting question with nothing, as it declines a waiting approval.
      question: request => new Promise(resolve => { const id = String(request.id); pending.set(id, answers => resolve(Array.isArray(answers) ? answers : null)); send({ type: 'question', request: { ...request, id } }); }),
      steerable: handler => { steer = handler; },
    };
    await (config.transport === 'acp' ? runGemini(config, callbacks) : config.transport === 'app-server' ? runCodex(config, callbacks) : runClaude(config, callbacks));
    await sendLast({ type: 'adapter-complete' });
  } catch (error) { await sendLast({ type: 'failure', message: error.message, category: error.category || classifyError(error) }); process.exitCode = 1; }
  finally { if (config.transport !== 'cli') { finished = true; process.disconnect(); } }
});
setTimeout(() => { if (!running) process.exit(1); }, 10000).unref();

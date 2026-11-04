// Quitting closes the local server first, which stops agents, terminals and commands and releases the workspaces.
// A stuck step must not hold the app open: the window would sit there, and the updater's installer only waits two
// minutes for Codeshi to go. Slow or failed shutdowns are written down with each step's time, so they can be traced.
import fs from 'node:fs';

// Longer than the agents, terminals and commands take to stop when they ignore a polite request.
export const SHUTDOWN_LIMIT = 10000;
const SLOW_SHUTDOWN = 2000, LOG_LIMIT = 64 * 1024;

// Resolves true once everything has closed, or false if the time ran out first.
export function closeWithin(close, { limit = SHUTDOWN_LIMIT, slow = SLOW_SHUTDOWN, log = () => {}, now = Date.now, timers = { setTimeout, clearTimeout } } = {}) {
  const started = now(), steps = [];
  return new Promise(resolve => {
    let done = false, timer = null;
    const finish = (closed, problem = '') => {
      if (done) return;
      done = true; timers.clearTimeout(timer);
      const took = now() - started;
      if (!closed || problem || took >= slow) {
        const finished = steps.map(({ name, ms, error }) => `${name} ${ms} ms${error ? ` (${error})` : ''}`).join(', ') || 'no step finished';
        log(`${new Date(now()).toISOString()} Shutdown took ${took} ms${closed ? '' : ', and stopped waiting'}: ${finished}.${problem ? ` ${problem}` : ''}`);
      }
      resolve(closed);
    };
    timer = timers.setTimeout(() => finish(false), limit);
    Promise.resolve().then(() => close({ force: true, onStep: step => steps.push(step) })).then(() => finish(true), error => finish(true, error.message));
  });
}

// Keeps the log small: a shutdown that needs writing down is rare, and only the latest ones matter.
export function writeShutdownLog(file, line) {
  try {
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > LOG_LIMIT) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch { /* Quitting matters more than the note about it. */ }
}

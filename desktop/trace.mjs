import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {pipeline} from 'node:stream/promises';

// Help › Record Performance Trace: ten seconds of Chromium's own tracing for every Codeshi process, saved as a file on
// this computer, gzipped, that Perfetto (ui.perfetto.dev) or Chrome's trace viewer opens as it is. With it comes how much of a CPU core each kind of process
// used over those seconds, which is what a battery report needs first. Nothing is sent anywhere.
//
// The categories are most of what a browser's Performance panel records: every task each process ran and for how long
// (toplevel, which covers the GPU process too), what ran on the page's main thread (scripts with their file and line,
// style, layout, paint), the frames it produced, and samples of the JavaScript that was running. The compositor's and
// GPU's own detailed categories are left out: they made a ten-second trace about 100 MB without changing the answer.
// The trace holds request addresses, script names and timings, not chat text.
export const TRACE_CATEGORIES = [
  'toplevel', 'blink', 'blink.user_timing', 'v8.execute', 'loading', 'devtools.timeline',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-v8.cpu_profiler',
];
export const TRACE_SECONDS = 10, TRACES_KEPT = 5;

// Electron's process types, in the words a person sees.
const GROUPS = { Tab: 'pages', GPU: 'graphics', Browser: 'app' };
export const group = type => GROUPS[type] || 'other';

// Per-process CPU seconds, by pid, from app.getAppMetrics().
export function cpuSeconds(metrics) {
  const seconds = new Map();
  for (const entry of metrics || []) {
    const used = entry?.cpu?.cumulativeCPUUsage;
    if (Number.isInteger(entry?.pid) && typeof used === 'number' && Number.isFinite(used)) seconds.set(entry.pid, { type: entry.type, used });
  }
  return seconds;
}

// How much of one core each group used between two readings, in percent. A process that started in between counts
// from zero; one that ended in between is left out, since its last seconds are unknown.
export function cpuShare(before, after, elapsedMs) {
  const share = { pages: 0, graphics: 0, app: 0, other: 0 };
  if (!(elapsedMs > 0)) return share;
  for (const [pid, { type, used }] of after) {
    const start = before.get(pid)?.used ?? 0;
    share[group(type)] += Math.max(0, used - start);
  }
  for (const key of Object.keys(share)) share[key] = Math.round(share[key] / (elapsedMs / 1000) * 1000) / 10;
  return share;
}

const stamp = date => date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

export function createTraceRecorder({ tracing, metrics, directory, seconds = TRACE_SECONDS, keep = TRACES_KEPT, now = () => new Date(), clock = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onChange = () => {} }) {
  let recording = false;
  // Older traces go once there are more than `keep`: they are large, and only the latest few help.
  function prune() {
    let names = [];
    try { names = fs.readdirSync(directory).filter(name => /^codeshi-trace-\d{8}-\d{6}\.json\.gz$/.test(name)).sort(); } catch { return; }
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      fs.rmSync(path.join(directory, name), { force: true });
      fs.rmSync(path.join(directory, name.replace(/\.json\.gz$/, '.summary.json')), { force: true });
    }
  }
  async function record() {
    if (recording) throw new Error('A performance trace is already being recorded.');
    recording = true; onChange(true);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const started = now(), name = `codeshi-trace-${stamp(started)}`, raw = path.join(directory, `${name}.json`), file = `${raw}.gz`;
      await tracing.startRecording({ included_categories: TRACE_CATEGORIES, excluded_categories: ['*'] });
      const before = cpuSeconds(metrics()), from = clock();
      // Tracing is stopped even if the wait fails, so Chromium never keeps recording in the background.
      try { await wait(seconds * 1000); } catch (error) { await tracing.stopRecording().catch(() => {}); throw error; }
      const after = cpuSeconds(metrics()), elapsedMs = clock() - from;
      await tracing.stopRecording(raw);
      // About a tenth of the size: ten seconds are some 50 MB of JSON before this.
      try { await pipeline(fs.createReadStream(raw), zlib.createGzip(), fs.createWriteStream(file, { mode: 0o600 })); } finally { fs.rmSync(raw, { force: true }); }
      const summary = { recordedAt: started.toISOString(), seconds: Math.round(elapsedMs / 100) / 10, cpu: cpuShare(before, after, elapsedMs),
        processes: [...after].map(([pid, { type }]) => ({ pid, type, group: group(type) })) };
      fs.writeFileSync(path.join(directory, `${name}.summary.json`), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
      prune();
      return { file, summary };
    } finally { recording = false; onChange(false); }
  }
  return { record, isRecording: () => recording };
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import {createTraceRecorder,cpuSeconds,cpuShare,TRACE_CATEGORIES} from '../desktop/trace.mjs';

// A stand-in for Electron's contentTracing that writes a small file where Chromium would write the trace.
function tracing() {
  const calls = [];
  return { calls,
    async startRecording(options) { calls.push(['start', options]); },
    async stopRecording(file) { calls.push(['stop', file]); if (file) fs.writeFileSync(file, '{"traceEvents":[]}'); return file; } };
}
const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-trace-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'performance-traces'); };
// Readings of app.getAppMetrics(): CPU seconds used so far by each process.
const reading = used => Object.entries(used).map(([pid, [type, seconds]]) => ({ pid: Number(pid), type, cpu: { cumulativeCPUUsage: seconds } }));

test('CPU share is the part of one core each kind of process used between two readings', () => {
  const before = cpuSeconds(reading({ 10: ['Browser', 5], 11: ['Tab', 20], 12: ['GPU', 30], 13: ['Utility', 1], 14: ['Tab', 9] }));
  // Over 10 seconds: the page used 3.7 s, graphics 3.8 s, the app 0.1 s; a new helper 0.5 s; one page closed.
  const after = cpuSeconds(reading({ 10: ['Browser', 5.1], 11: ['Tab', 23.7], 12: ['GPU', 33.8], 13: ['Utility', 1], 15: ['Utility', 0.5] }));
  assert.deepEqual(cpuShare(before, after, 10000), { pages: 37, graphics: 38, app: 1, other: 5 });
  assert.deepEqual(cpuShare(before, after, 0), { pages: 0, graphics: 0, app: 0, other: 0 }, 'no time, no share');
  assert.equal(cpuSeconds([{ pid: 1, type: 'Tab', cpu: {} }, null, { pid: 'x' }]).size, 0, 'readings without numbers are left out');
});

test('a trace records the Performance panel categories for ten seconds and saves the trace with what each process used', async t => {
  const dir = folder(t), chromium = tracing(), changes = [];
  let used = { 1: ['Browser', 2], 2: ['Tab', 10], 3: ['GPU', 4] }, waited = 0, time = 0;
  const recorder = createTraceRecorder({ tracing: chromium, metrics: () => reading(used), directory: dir, now: () => new Date('2026-11-11T09:08:07.123Z'), clock: () => time, onChange: on => changes.push(on),
    wait: async ms => { waited = ms; assert.equal(recorder.isRecording(), true); time += ms; used = { 1: ['Browser', 2.2], 2: ['Tab', 13.6], 3: ['GPU', 7.9] }; } });
  const { file, summary } = await recorder.record();
  assert.equal(waited, 10000);
  assert.equal(file, path.join(dir, 'codeshi-trace-20261111-090807.json.gz'));
  assert.deepEqual(chromium.calls.map(([name]) => name), ['start', 'stop']);
  assert.deepEqual(chromium.calls[0][1], { included_categories: TRACE_CATEGORIES, excluded_categories: ['*'] });
  for (const category of ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-v8.cpu_profiler']) assert(TRACE_CATEGORIES.includes(category), category);
  for (const category of ['cc', 'viz', 'gpu']) assert(!TRACE_CATEGORIES.includes(category), `${category} is left out: it made traces about 100 MB`);
  assert.equal(chromium.calls[1][1], path.join(dir, 'codeshi-trace-20261111-090807.json'), 'Chromium writes the trace');
  assert.equal(zlib.gunzipSync(fs.readFileSync(file)).toString(), '{"traceEvents":[]}', 'and it is kept gzipped');
  assert(!fs.existsSync(path.join(dir, 'codeshi-trace-20261111-090807.json')), 'with no uncompressed copy left');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(summary.recordedAt, '2026-11-11T09:08:07.123Z');
  assert.deepEqual(summary.cpu, { pages: 36, graphics: 39, app: 2, other: 0 }, 'part of one core over the ten seconds');
  assert.equal(summary.seconds, 10);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'codeshi-trace-20261111-090807.summary.json'), 'utf8')), summary, 'the summary is saved beside the trace');
  assert.deepEqual(summary.processes.map(entry => entry.group), ['app', 'pages', 'graphics']);
  assert.deepEqual(changes, [true, false], 'the menu hears when it starts and ends');
  assert.equal(recorder.isRecording(), false);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'the folder is private to this user');
});

test('one trace at a time, and tracing stops even if waiting fails', async t => {
  const dir = folder(t), chromium = tracing();
  let release;
  const recorder = createTraceRecorder({ tracing: chromium, metrics: () => [], directory: dir, wait: () => new Promise(resolve => { release = resolve; }) });
  const first = recorder.record();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(recorder.record(), /already being recorded/);
  release(); await first;
  const failing = createTraceRecorder({ tracing: chromium, metrics: () => [], directory: dir, wait: async () => { throw new Error('interrupted'); } });
  chromium.calls.length = 0;
  await assert.rejects(failing.record(), /interrupted/);
  assert.deepEqual(chromium.calls.map(([name]) => name), ['start', 'stop'], 'Chromium is not left recording');
  assert.equal(failing.isRecording(), false);
});

test('only the latest five traces are kept, with their summaries', async t => {
  const dir = folder(t);
  let minute = 0;
  const recorder = createTraceRecorder({ tracing: tracing(), metrics: () => [], directory: dir, wait: async () => {}, now: () => new Date(Date.UTC(2026, 10, 11, 9, minute++, 0)) });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  for (let i = 0; i < 7; i++) await recorder.record();
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names.filter(name => name.endsWith('.summary.json')).map(name => name.slice(23, 27)), ['0902', '0903', '0904', '0905', '0906']);
  assert.equal(names.filter(name => /^codeshi-trace-\d{8}-\d{6}\.json\.gz$/.test(name)).length, 5);
  assert(names.includes('notes.txt'), 'other files in the folder are left alone');
});

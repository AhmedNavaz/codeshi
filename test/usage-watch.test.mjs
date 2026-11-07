import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { observeReading, observeRunSize, runTokens, usageWatch } from '../src/usage-watch.mjs';
import { scriptCLIs } from './platform.mjs';

const START = Date.parse('2026-11-07T08:00:00Z'), MINUTE = 60000;
const time = minutes => new Date(START + minutes * MINUTE).toISOString();
const measured = tokens => ({ input: 100, cacheRead: tokens - 300, cacheWrite: 100, output: 100 });

// A conversation with these finished runs, each observed in order the way the journal does it. A run takes ten minutes.
function history(runs) {
  const c = { runs: [], lastRun: null };
  runs.forEach(({ provider = 'codex', tokens = null, partial = false, ...rest }, index) => {
    const run = { id: `run-${index}`, provider, startedAt: time(index * 20), endedAt: time(index * 20 + 10),
      usageMeasured: tokens === null ? null : { ...measured(tokens), ...(partial ? { partial: true } : {}) }, ...rest };
    c.runs.push(run); observeRunSize(c, run); c.lastRun = { id: run.id, provider, errorCategory: rest.errorCategory || null };
  });
  return c;
}
const usual = (count, tokens = 1e6, options = {}) => Array.from({ length: count }, () => ({ tokens, ...options }));
const reading = (minutes, usedPercent, { id = 'primary', label = '5-hour', resetsAt = time(300), ...row } = {}) => ({ observedAt: time(minutes), windows: [{ id, label, usedPercent, resetsAt, ...row }] });
const refreshDue = { hasSession: true, used: 318000, rollover: true };

test('run size counts everything sent and received, and an unreported size is unknown rather than zero', () => {
  assert.equal(runTokens({ input: 108, cacheRead: 10408077, cacheWrite: 318388, output: 350 }), 10726923);
  assert.equal(runTokens({ input: null, cacheRead: 5, cacheWrite: null, output: null }), 5);
  assert.equal(runTokens({ input: null, cacheRead: null, cacheWrite: null, output: 9 }), null);
  assert.equal(runTokens(null), null);
});

test('a run is flagged when well above both the median and nearly every recent run', () => {
  const big = usageWatch(history([...usual(8), { tokens: 6e6 }]), refreshDue);
  assert.equal(big.notice.heavy, true);
  assert.deepEqual([big.tokens, big.usual, big.samples], [6e6, 1e6, 8]);
  assert.equal(usageWatch(history(usual(9)), refreshDue).notice, null, 'A usual run says nothing.');
  assert.equal(usageWatch(history([...usual(8), { tokens: 2.9e6 }]), refreshDue).notice, null, 'Under three times usual.');
  assert.equal(usageWatch(history([...usual(8, 1e5), { tokens: 1.9e6 }]), refreshDue).notice, null, 'Many times usual, but still small.');
  const spread = [...usual(7), ...usual(3, 1e7)];
  assert.equal(usageWatch(history([...spread, { tokens: 5e6 }]), refreshDue).notice, null, 'Runs this size are already common here, whatever the median says.');
});

test('with too little history only a very large run counts', () => {
  assert.equal(usageWatch(history([{ tokens: 19e6 }]), refreshDue).notice, null);
  const large = usageWatch(history([{ tokens: 20e6 }]), refreshDue);
  assert.equal(large.notice.heavy, true);
  assert.equal(large.usual, null);
});

test('each agent is compared with its own runs, however rarely it is used', () => {
  const claude = usual(8, 4e6, { provider: 'claude' }), codex = usual(60, 1e5);
  const c = history([...claude, ...codex, { provider: 'claude', tokens: 13e6 }]);
  c.runs = c.runs.slice(-50);
  const watch = usageWatch(c, refreshDue);
  assert.equal(watch.usual, 4e6, 'Claude keeps its history after Codex has filled the recent runs.');
  assert.equal(watch.notice.heavy, true);
  assert.equal(usageWatch(history([...claude, { tokens: 13e6 }]), refreshDue).notice, null, 'Codex has no history of its own yet.');
});

test('a stretch of large runs is mentioned once, unless it gets much worse or carries on after a while', () => {
  const quiet = history([...usual(8), { tokens: 6e6 }, { tokens: 6e6 }]);
  assert.equal(usageWatch(quiet, refreshDue).notice, null);
  assert.equal(usageWatch(history([...usual(8), { tokens: 6e6 }, { tokens: 13e6 }]), refreshDue).notice.heavy, true, 'At least twice the last one mentioned.');
  assert.equal(usageWatch(history([...usual(8), { tokens: 6e6 }, ...usual(4), { tokens: 30e6 }]), refreshDue).notice.heavy, true);
});

test('what was seen of a stopped run is a lower bound: reported as one, and left out of what is usual', () => {
  const watch = usageWatch(history([...usual(8), { tokens: 10e6, partial: true }]), refreshDue);
  assert.equal(watch.partial, true);
  assert.equal(watch.notice.heavy, true);
  const after = history([...usual(8), { tokens: 10e6, partial: true }, { tokens: 1e6 }]);
  assert.equal(after.usageSeen.codex.tokens.length, 9);
  assert.equal(after.runs.at(-1).usageSize.samples, 8);
});

function withReadings(runs, readings, provider = 'codex') {
  const c = history(runs);
  for (const item of readings) observeReading(c, provider, item);
  return c;
}

test('a limit is reported from readings on each side of the run, and only while it is one period', () => {
  const run = [{ tokens: 1e6 }];
  const moved = usageWatch(withReadings(run, [reading(-1, 34), reading(11, 52)]), refreshDue);
  assert.deepEqual(moved.notice.moves.map(({ label, from, to, points, near }) => [label, from, to, points, near]), [['5-hour', 34, 52, 18, false]]);
  assert.equal(moved.notice.heavy, false);
  assert.equal(usageWatch(withReadings(run, [reading(-1, 34), reading(11, 48)]), refreshDue).notice, null, 'Under fifteen points of a short limit.');
  assert.equal(usageWatch(withReadings(run, [reading(-1, 34), reading(11, 48)]), refreshDue).moves.length, 1, 'Still kept for the run details.');
  assert.equal(usageWatch(withReadings(run, [reading(-1, 80), reading(11, 10, { resetsAt: time(600) })]), refreshDue).notice, null, 'A reset between them says nothing about this run.');
  assert.equal(usageWatch(withReadings(run, [reading(-1, 10), reading(11, 60, { resetsAt: time(600) })]), refreshDue).moves.length, 0);
  assert.equal(usageWatch(withReadings(run, [reading(-40, 10), reading(11, 60)]), refreshDue).moves.length, 0, 'A reading from long before the run can include anything since.');
  assert.equal(usageWatch(withReadings(run, [reading(-1, 10), reading(16, 60)]), refreshDue).moves.length, 0, 'A reading from long after the run can too.');
  assert.equal(usageWatch(withReadings(run, [reading(-1, 10)]), refreshDue).moves.length, 0, 'No reading after the run leaves it unknown.');
  assert.equal(usageWatch(withReadings(run, [reading(-1, 10, { id: 'opus', scope: 'opus', label: 'Weekly · Opus' }), reading(11, 60, { id: 'opus', scope: 'opus', label: 'Weekly · Opus' })]), refreshDue).moves.length, 0, 'A limit for one model is left out.');
});

test('a run shorter than a minute keeps its before and after readings apart', () => {
  const c = withReadings([{ tokens: 1e6 }], [reading(.25, 20), reading(.75, 40)]);
  c.runs[0].endedAt = time(.5);
  assert.deepEqual(usageWatch(c, refreshDue).moves.map(({ from, to }) => [from, to]), [[20, 40]]);
});

test('a move seen during a long run still counts when the final reading was unchanged and so not saved again', () => {
  const during = withReadings([{ tokens: 1e6 }], [reading(-1, 20), reading(9.5, 60)]);
  assert.deepEqual(usageWatch(during, refreshDue).moves.map(({ from, to }) => [from, to]), [[20, 60]]);
  const old = withReadings([{ tokens: 1e6 }], [reading(-1, 20), reading(5, 60)]);
  assert.deepEqual(usageWatch(old, refreshDue).moves, [], 'From too long before the end, that reading says nothing about how the run ended.');
});

test('runs that share their readings report the move once, on the latest of them', () => {
  // Three runs start within one reading's reach, and the only later reading falls after the last of them ends.
  const c = withReadings(usual(3), [reading(-1, 19), reading(51, 71)]);
  c.runs[0].startedAt = time(0); c.runs[0].endedAt = time(1); c.runs[1].startedAt = time(2); c.runs[1].endedAt = time(3); c.runs[2].startedAt = time(4); c.runs[2].endedAt = time(50);
  assert.equal(usageWatch(c, refreshDue).notice.moves.length, 1, 'An earlier run sharing them does not use up the mention.');
  assert.deepEqual(usageWatch(c, refreshDue).moves.map(({ from, to }) => [from, to]), [[19, 71]]);
});

test('a weekly limit needs a smaller move, and reaching the near mark always counts', () => {
  const run = [{ tokens: 1e6 }], week = { id: 'secondary', label: 'Weekly', resetsAt: time(5000) };
  assert.equal(usageWatch(withReadings(run, [reading(-1, 20, week), reading(11, 23, week)]), refreshDue).notice.moves.length, 1);
  assert.equal(usageWatch(withReadings(run, [reading(-1, 20, week), reading(11, 22, week)]), refreshDue).notice, null);
  const near = usageWatch(withReadings(run, [reading(-1, 79), reading(11, 81)]), refreshDue).notice;
  assert.equal(near.moves[0].near, true);
  assert.equal(usageWatch(withReadings(run, [reading(-1, 81), reading(11, 84)]), refreshDue).notice, null, 'Only crossing it counts, so this is said once.');
});

test('one limit filling up over several runs is one message, until it reaches the near mark or a new period', () => {
  const runs = usual(4);
  // The runs start at minutes 0, 20, 40 and 60, and each moves the limit further.
  const climbing = [reading(-1, 10), reading(11, 30), reading(19, 30), reading(31, 50), reading(39, 50), reading(51, 75), reading(59, 75), reading(71, 85)];
  const upTo = count => { const c = withReadings(runs.slice(0, count), climbing); return usageWatch(c, refreshDue); };
  assert.equal(upTo(1).notice.moves.length, 1);
  assert.equal(upTo(2).notice, null, 'Twenty more points tells nothing new.');
  assert.equal(upTo(3).notice, null);
  assert.equal(upTo(4).notice.moves[0].near, true);
  const further = withReadings(usual(2), [reading(-1, 10), reading(11, 25), reading(19, 25), reading(31, 55)]);
  assert.equal(usageWatch(further, refreshDue).notice.moves.length, 1, 'Moving at least twice as far is worth saying.');
  const nextPeriod = withReadings(usual(2), [reading(-1, 10), reading(11, 30), reading(19, 0, { resetsAt: time(800) }), reading(31, 20, { resetsAt: time(800) })]);
  assert.equal(usageWatch(nextPeriod, refreshDue).notice.moves.length, 1);
});

test('the suggestion is what actually helps next, in normal and Flow', () => {
  const big = () => history([...usual(8), { tokens: 6e6 }]), small = { hasSession: true, used: 12000, rollover: false };
  const step = (decision, routing) => { const c = big(); if (routing) c.routing = { mode: routing }; return usageWatch(c, decision).notice; };

  assert.deepEqual(step(refreshDue).context, { used: 318000, state: 'due' });
  assert.equal(step(refreshDue).action, null, 'Compact would only ask for the refresh that is already coming.');
  assert.deepEqual([step({ hasSession: true, used: 90000, rollover: false }).context.state, step({ hasSession: true, used: 90000, rollover: false }).action], ['large', 'compact']);
  assert.deepEqual([step(small).context.state, step(small).action], ['small', null], 'Almost nothing to compact.');
  assert.deepEqual([step({ hasSession: true, used: null, rollover: false }).context.state, step({ hasSession: true, used: null, rollover: false }).action], ['small', null], 'An unknown size is not a large one.');
  assert.deepEqual([step({ hasSession: false, used: 90000, rollover: false }).action], [null], 'No session means the next message already starts fresh.');
  assert.deepEqual([step({ hasSession: true, used: 90000, pending: true, rollover: true }).context.state, step({ hasSession: true, used: 90000, pending: true, rollover: true }).action], ['scheduled', null]);

  assert.equal(step(refreshDue, 'balanced').action, 'saving');
  assert.equal(step(refreshDue, 'quality').action, 'saving');
  assert.equal(step(refreshDue, 'saving').action, null, 'Already on it.');
  assert.equal(step({ hasSession: true, used: 90000, rollover: false }, 'balanced').action, 'compact');

  const gemini = withReadings([{ provider: 'gemini' }], [reading(-1, 10), reading(11, 40)], 'gemini');
  assert.equal(usageWatch(gemini, { hasSession: true, used: 90000, rollover: false }).notice.action, null, 'Gemini has no context refresh, and its tokens are unknown.');
  assert.equal(usageWatch(gemini, { hasSession: true, used: 90000, rollover: false }).tokens, null);
});

test('nothing is said during a run, for a local model, or when a limit already has its own message', () => {
  const big = [...usual(8), { tokens: 6e6 }];
  assert.equal(usageWatch({ ...history(big), activeRun: { id: 'next' } }, refreshDue), null);
  assert.equal(usageWatch({ ...history(big), routingPending: { id: 'next' } }, refreshDue), null);
  assert.equal(usageWatch({ runs: [], lastRun: null }, refreshDue), null);
  assert.equal(usageWatch(history([...usual(8, 1e6, { local: true }), { tokens: 6e6, local: true }]), refreshDue), null);
  const stopped = history([...usual(8), { tokens: 6e6, errorCategory: 'quota' }]);
  assert.equal(usageWatch(stopped, refreshDue).notice, null);
  assert.equal(usageWatch(stopped, refreshDue).tokens, 6e6, 'What it used stays in the run details.');
  assert.equal(usageWatch({ ...history(big), resume: { at: time(100) } }, refreshDue).notice, null);
  assert.equal(usageWatch({ ...history(big), limitSwitching: { provider: 'codex' } }, refreshDue).notice, null);
});

test('usage history is rebuilt from the journal and stays out of the conversation view', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-usage-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { workspace: root, dataDir: path.join(root, 'data'), bins: { codex: '/not-installed/codex', claude: '/not-installed/claude', gemini: '/not-installed/gemini' } };
  const broker = new Broker(options), c = broker.get(broker.create().id);
  for (let index = 0; index < 9; index++) {
    const id = `00000000-0000-4000-8000-00000000000${index}`;
    broker.record(c, { type: 'run_start', id, provider: 'codex' });
    broker.record(c, { type: 'run_metadata', metadata: { usage: { input_tokens: 100, cache_read_input_tokens: index === 8 ? 6e6 : 1e6, cache_creation_input_tokens: 0, output_tokens: 100 } } });
    broker.record(c, { type: 'run_end', status: 'complete' });
  }
  const live = broker.view(c);
  assert.equal(live.usageWatch.notice.heavy, true);
  assert.equal(live.usageWatch.usual, 1000200);
  assert.equal('usageSeen' in live, false);
  assert.equal('quotaHistory' in live, false);
  const reopened = new Broker(options), copy = reopened.get(c.id);
  assert.deepEqual(reopened.view(copy).usageWatch, live.usageWatch);
});

// A stand-in for a Codex subscription whose reported limit moves once it has done any work.
function subscriptionCodex(root) {
  const bin = path.join(root, 'codex-stand-in.mjs'), worked = path.join(root, 'worked');
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('usage-fixture 1');process.exit(0);}
const send=value=>console.log(JSON.stringify(value)),threadId='t',worked=${JSON.stringify(worked)};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt',planType:'plus'},requiresOpenaiAuth:true}});
if(m.method==='account/rateLimits/read')send({id:m.id,result:{rateLimits:{planType:'plus',primary:{usedPercent:fs.existsSync(worked)?40:20,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}}});
if(m.method==='model/list')send({id:m.id,result:{data:[]}});
if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:threadId},model:'fixture'}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'x'}}});
setTimeout(()=>{fs.writeFileSync(worked,'');
send({method:'thread/tokenUsage/updated',params:{threadId,tokenUsage:{total:{inputTokens:6000,cachedInputTokens:1000,outputTokens:500,reasoningOutputTokens:0}}}});
send({method:'item/completed',params:{threadId,item:{id:'a',type:'agentMessage',text:'Done'}}});
send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});},300);}
});
`, { mode: 0o755 });
  return bin;
}

test('a subscription run is read on both sides without being held up, and the move reaches the view', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-usage-reading-')), workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const before = process.env.AI_RELAY_CODEX_BIN;
  process.env.AI_RELAY_CODEX_BIN = subscriptionCodex(root);
  const broker = new Broker({ workspace, dataDir: path.join(root, 'data') }), c = broker.get(broker.create().id);
  t.after(() => { broker.close?.(); if (before === undefined) delete process.env.AI_RELAY_CODEX_BIN; else process.env.AI_RELAY_CODEX_BIN = before; fs.rmSync(root, { recursive: true, force: true }); });
  await broker.dispatch(c, { text: 'Do the work', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  const deadline = Date.now() + 15000;
  while (!broker.view(c).usageWatch?.moves?.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const watch = broker.view(c).usageWatch;
  assert.deepEqual(watch?.moves.map(({ from, to, label }) => [from, to, label]), [[20, 40, '5-hour']]);
  assert.equal(watch.notice.moves.length, 1);
});

test('a failed reading is ignored and leaves the move unknown', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-usage-failed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = new Broker({ workspace: root, dataDir: path.join(root, 'data'), bins: { codex: '/not-installed/codex', claude: '/not-installed/claude', gemini: '/not-installed/gemini' } }), c = broker.get(broker.create().id);
  let reads = 0;
  broker.checks.usage = async () => { reads++; throw new Error('Offline'); };
  broker.readQuota(c, 'codex', { refresh: true });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(c.quotaHistory, undefined);
});

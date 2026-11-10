import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { continuationRequest } from '../src/context.mjs';
import { runClaude } from '../src/providers.mjs';
import { applyBudgetRecord } from '../src/task-budget.mjs';
import { combineUsage, ledgerFromRecords, normalizeUsage, readLedger, summarizePlans, sumUsage, taskIdentity } from '../src/task-ledger.mjs';

const at = minute => `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z`;
const submission = (id, minute, extra = {}, text = 'Build it') => ({ type: 'submission', id, provider: 'claude', model: 'haiku', mode: 'edit', at: at(minute), message: { role: 'user', text, runId: id }, ...extra });
const metadata = (minute, value) => ({ type: 'run_metadata', at: at(minute), metadata: value });
const end = (minute, status = 'complete', errorCategory) => ({ type: 'run_end', at: at(minute), status, ...(errorCategory ? { errorCategory } : {}) });

test('role totals include failed assessments and unknown reviews without counting either as builder work', () => {
  const { runs, tasks: [task] } = ledgerFromRecords([
    { type: 'routing_assessment_start', id: 'assess', taskId: 'task', provider: 'claude', at: at(0) },
    { type: 'routing_assessment_end', id: 'assess', at: at(1), result: { status: 'failed', effectiveEffort: 'low', usage: { input_tokens: 20, output_tokens: 5 } } },
    submission('build', 2, { task: { id: 'task', parentRunId: 'assess', relation: 'assessed' } }),
    metadata(2, { usage: { input_tokens: 100, output_tokens: 10 } }), end(3),
    { type: 'background_review', taskId: 'task', at: at(4), review: { id: 'review', provider: 'codex' } },
    { type: 'review_result', id: 'review', at: at(5), result: { status: 'complete' } },
  ]);
  assert.deepEqual(runs.map(run => run.role), ['assessment', 'builder', 'review']);
  assert.equal(runs[0].effort, 'low');
  assert.equal(task.startedAt, at(0), 'Task time includes its assessor before the builder starts.');
  assert.equal(task.roles.assessment.usage.input, 20);
  assert.equal(task.roles.builder.usage.input, 100);
  assert.equal(task.roles.review.usage.input, null);
  assert.equal(task.roles.review.usage.runsWithTokens, 0);
  assert.equal(task.usage.input, 120);
  assert.equal(task.usage.runs, 3);
  assert.equal(task.workingMs, Object.values(task.roles).reduce((sum, role) => sum + role.workingMs, 0));
});

test('the Claude native adapter receives the remaining API budget without turning it into a token estimate', async () => {
  let options;
  async function* queryImpl(input) { options = input.options; yield { type: 'result', subtype: 'success', result: 'Done' }; }
  await runClaude({ workspace: '/project', prompt: 'Review', mode: 'read', bin: '/fake', maxBudgetUsd: 1.25 }, { queryImpl, event() {}, metadata() {}, approval: async () => false });
  assert.equal(options.maxBudgetUsd, 1.25);
});

test('native and reported spend enforcement survive ledger export for builders, reviews and assessments', () => {
  const native = { spend: 'native', maxSpendUSD: 1.25 }, reported = { spend: 'reported-usage', maxSpendUSD: 1 };
  const { runs } = ledgerFromRecords([
    submission('builder', 0), metadata(0, { budgetEnforcement: native }), end(1),
    { type: 'background_review', taskId: 'builder', at: at(2), review: { id: 'review', provider: 'codex' } },
    { type: 'review_budget', id: 'review', metadata: { budgetEnforcement: reported } },
    { type: 'review_result', id: 'review', result: { status: 'complete', budgetEnforcement: reported } },
    { type: 'routing_assessment_start', id: 'assess', taskId: 'builder', provider: 'claude', at: at(3) },
    { type: 'routing_assessment_metadata', id: 'assess', metadata: { budgetEnforcement: native } },
    { type: 'routing_assessment_end', id: 'assess', result: { status: 'complete' } },
  ]);
  assert.deepEqual(runs.map(run => run.budgetEnforcement), [native, reported, native]);
});

test('each agent\'s usage has one shape, and what it did not report stays unknown', () => {
  const claude = normalizeUsage('claude', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 });
  assert.deepEqual([claude.input, claude.output, claude.cacheRead, claude.cacheWrite, claude.reasoning], [10, 20, 300, 40, null]);
  assert.deepEqual(claude.reported, ['input', 'output', 'cacheRead', 'cacheWrite']);
  assert.equal(claude.raw.input_tokens, 10, 'What the agent sent is kept.');
  const codex = normalizeUsage('codex', { total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50, reasoningOutputTokens: 5 } });
  assert.deepEqual([codex.input, codex.cacheRead, codex.output, codex.reasoning, codex.cacheWrite], [600, 400, 50, 5, null], 'Codex counts cached input inside its input.');
  const gemini = normalizeUsage('gemini', { used: 5000, size: 100000 });
  assert.deepEqual([gemini.input, gemini.output, gemini.reported], [null, null, []], 'Context held is not tokens used.');
  assert.deepEqual(gemini.context, { used: 5000, size: 100000 });
  const turns = normalizeUsage('gemini', { inputTokens: 100, outputTokens: 20, thoughtTokens: 10, cachedReadTokens: 60, cachedWriteTokens: null });
  assert.deepEqual([turns.source, turns.input, turns.output, turns.reasoning, turns.cacheRead, turns.cacheWrite], ['acp-prompt-usage', 100, 20, 10, 60, null], 'What the run\'s own turns used.');
  assert.deepEqual(turns.reported, ['input', 'output', 'cacheRead', 'reasoning']);
  assert.equal(normalizeUsage('gemini', null), null);
});

test('a run stopped before its result keeps a partial count, and a result replaces it', () => {
  const partial = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, partial: true };
  const { runs, tasks } = ledgerFromRecords([submission('stopped', 0), metadata(1, { usage: partial }), end(1, 'interrupted'), submission('done', 2), metadata(3, { usage: partial }), metadata(3, { usage: { input_tokens: 12, output_tokens: 6 } }), end(3)]);
  assert.equal(runs[0].usage.partial, true);
  assert.equal(runs[0].usage.cacheRead, 100);
  assert.equal(runs[1].usage.partial, undefined);
  assert.equal(runs[1].usage.input, 12);
  assert.equal(tasks[0].usage.partialRuns, 1);
});

test('Claude reports a stopped run from its messages: each message counts once, however many times it is streamed', async () => {
  const seen = [], usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 100 });
  async function* queryImpl() {
    yield { type: 'assistant', message: { id: 'one', content: [], usage: usage(1, 2) } };
    yield { type: 'assistant', message: { id: 'one', content: [], usage: usage(1, 5) } };
    yield { type: 'assistant', message: { id: 'two', content: [], usage: usage(3, 4) } };
  }
  await runClaude({ workspace: '/project', prompt: 'Go', mode: 'edit', bin: '/x' }, { queryImpl, event() {}, metadata: value => seen.push(value), approval: async () => false }).catch(() => {});
  const last = seen.filter(value => value.usage).at(-1).usage;
  assert.deepEqual([last.input_tokens, last.output_tokens, last.cache_read_input_tokens, last.partial], [4, 9, 200, true]);
});

test('a resumed Codex session only counts what this run added to the running total', () => {
  const total = (input, output) => ({ total: { inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 } });
  const { runs } = ledgerFromRecords([
    submission('one', 0, { provider: 'codex', context: { sessionMode: 'fresh' } }), metadata(1, { usage: total(1000, 100) }), end(1),
    submission('two', 2, { provider: 'codex', context: { sessionMode: 'resumed' } }), metadata(3, { usage: total(1500, 160) }), end(3),
    submission('three', 4, { provider: 'codex', context: { sessionMode: 'fresh' }, resetSession: true }), metadata(5, { usage: total(200, 20) }), end(5),
  ]);
  assert.deepEqual(runs.map(run => [run.usage.input, run.usage.output]), [[1000, 100], [500, 60], [200, 20]]);
});

test('totals never turn unknown into zero, and say how many runs they cover', () => {
  const unknown = sumUsage([null, normalizeUsage('gemini', { used: 1 })]);
  assert.equal(unknown.input, null);
  assert.equal(unknown.runsWithTokens, 0);
  const partial = sumUsage([normalizeUsage('claude', { input_tokens: 5, output_tokens: 1 }), null]);
  assert.equal(partial.input, 5);
  assert.deepEqual([partial.reportedBy.input, partial.runs, partial.runsWithTokens], [1, 2, 1]);
});

test('missing cache counters, missing baselines and counter resets never invent fresh or negative tokens', () => {
  const missing = normalizeUsage('codex', { total: { inputTokens: 100, outputTokens: 10 } });
  assert.equal(missing.input, null);
  assert.equal(missing.cacheRead, null);
  const next = normalizeUsage('codex', { total: { inputTokens: 200, cachedInputTokens: 40, outputTokens: 20 } }, { previous: missing.sessionTotal });
  assert.equal(next.input, null);
  assert.equal(next.cacheRead, null);
  assert.equal(next.output, 10);
  const reset = normalizeUsage('codex', { total: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 1 } }, { previous: next.sessionTotal });
  assert.equal(reset.input, null);
  assert.equal(reset.output, null);
  assert.deepEqual(reset.raw.total, { inputTokens: 20, cachedInputTokens: 0, outputTokens: 1 });
});

test('Claude pipeline totals include auxiliary models once, with per-run deltas and API estimates across resumes', () => {
  const model = (input, output, cost, thinking = 2) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 20, cacheCreationInputTokens: 5, thinkingTokens: thinking, costUSD: cost });
  const first = { input_tokens: 1, output_tokens: 1, modelUsage: { builder: model(100, 10, 0.1), helper: model(200, 20, 0.2) } };
  const second = { input_tokens: 2, output_tokens: 2, modelUsage: { builder: model(150, 15, 0.15), helper: model(250, 25, 0.25), reviewer: model(40, 4, 0.04) } };
  const records = [
    submission('first', 0), metadata(1, { usage: first, account: { billingSource: 'api' }, costUSD: 0.3 }), end(1),
    submission('next', 2, { context: { sessionMode: 'resumed' }, task: { id: 'first', parentRunId: 'first', relation: 'continuation' } }), metadata(3, { usage: second, account: { billingSource: 'api' }, costUSD: 0.44 }), end(3),
  ];
  const { runs, tasks } = ledgerFromRecords(records);
  assert.deepEqual(runs.map(run => run.usage.input), [300, 140]);
  assert.equal(tasks[0].usage.input, 440, 'Main-loop usage is not added to the broader pipeline total.');
  assert.equal(runs[0].usage.source, 'claude-model-usage-total');
  assert.equal(runs[0].usage.coverage.scope, 'query-pipeline');
  assert.equal(runs[1].usage.raw.modelUsage.reviewer.inputTokens, 40);
  assert(Math.abs(runs[1].costEstimateUSD - 0.14) < 1e-10, 'Cumulative dollar estimates are differenced as well.');
  assert.equal(runs[1].costBasis, 'api-estimate');
  const c = {};
  for (const record of records) applyBudgetRecord(c, record);
  assert.equal(c.taskBudgets.first.tokens.input, tasks[0].usage.input, 'The shared budget uses the same pipeline deltas as the ledger.');
  assert(Math.abs(c.taskBudgets.first.spendUSD - 0.44) < 1e-10);
  const unreported = normalizeUsage('claude', { modelUsage: { builder: model(100, 10, 0.1), old: { inputTokens: 20, outputTokens: 2 } } });
  assert.equal(unreported.reasoning, null);
  assert.equal(unreported.cacheRead, null);
  assert.equal(unreported.coverage.reportedBy.reasoning, 1);
  const missingBaseline = ledgerFromRecords([submission('resumed', 0, { context: { sessionMode: 'resumed' } }), metadata(1, { usage: second }), end(1)]);
  assert.equal(missingBaseline.runs[0].usage.input, null, 'An unobserved earlier session cannot be attributed to this run.');
});

test('a stopped Claude follow-up retains prior pipeline work and adds only new partial messages', async () => {
  const seen = [], base = { builder: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 5, thinkingTokens: 2, costUSD: 0.1 } };
  async function* queryImpl() {
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: base };
    yield { type: 'assistant', message: { id: 'follow-up', content: [], usage: { input_tokens: 30, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    yield { type: 'assistant', message: { id: 'follow-up', content: [], usage: { input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  }
  await runClaude({ workspace: '/project', prompt: 'Go', mode: 'edit', bin: '/x' }, { queryImpl, event() {}, metadata: value => seen.push(value), approval: async () => false });
  const partial = normalizeUsage('claude', seen.filter(value => value.usage).at(-1).usage);
  assert.deepEqual([partial.input, partial.output, partial.cacheRead, partial.partial], [130, 14, 20, true]);
  assert.equal(partial.costEstimateUSD, null);
  assert.equal(partial.reasoning, null, 'The partial messages did not report thinking separately.');
  assert.equal(partial.sessionTotal.input, null, 'A partial lower bound cannot be used as a precise baseline for a resumed run.');
});

test('review accounting survives worker deletion and keeps final model, tools and elapsed time', () => {
  const { runs, tasks } = ledgerFromRecords([submission('build', 0), end(1),
    { type: 'background_review', at: at(2), taskId: 'build', parentRunId: 'build', review: { id: 'rev', provider: 'codex', model: 'alias' } },
    { type: 'review_result', id: 'rev', at: at(4), result: { status: 'complete', effectiveModel: 'actual-model', elapsedMs: 500,
      accounting: { effort: 'high', tools: { commands: 2, edits: 0, other: 1 }, approvals: { allowed: 0, denied: 1, automatic: 0, byRule: 0 }, interventions: 1, compactions: 1 } } }]);
  assert.equal(runs[1].effectiveModel, 'actual-model');
  assert.equal(runs[1].effort, 'high');
  assert.equal(runs[1].elapsedMs, 500);
  assert.equal(tasks[0].agents.codex.commands, 2);
  assert.equal(tasks[0].interventions, 1);
  assert.equal(tasks[0].endedAt, at(4));
  assert.equal(tasks[0].usage.runsWithTokens, 0);
});

test('a task follows its handoff, retry and review, and its totals leave out the wait for a reset', () => {
  const { tasks, runs } = ledgerFromRecords([
    submission('first', 0, { task: { id: 'first', parentRunId: null, relation: null } }), metadata(0, { account: { billingSource: 'subscription' }, usage: { input_tokens: 100, output_tokens: 10 }, costUSD: 0.5 }),
    { type: 'message', at: at(1), message: { runId: 'first', role: 'activity', text: '$ npm test\nok' } }, { type: 'message', at: at(1), message: { runId: 'first', role: 'activity', text: 'File changes: []' } }, { type: 'message', at: at(1), message: { runId: 'first', role: 'activity', text: 'Approval allowed by the user.' } },
    end(10, 'incomplete', 'quota'), { type: 'run_snapshot', runId: 'first', phase: 'after', files: 2 },
    // Twenty minutes waiting for a reset, then another agent carries on.
    submission('second', 30, { provider: 'codex', task: { id: 'first', parentRunId: 'first', relation: 'continuation' } }, continuationRequest), end(35),
    { type: 'check', runId: 'second', check: { status: 'failed', exitCode: 1, durationMs: 100 } },
    submission('third', 36, { provider: 'codex', retryOf: 'second', task: { id: 'first', parentRunId: 'second', relation: 'retry' } }), end(38),
    { type: 'check', runId: 'third', check: { status: 'passed', exitCode: 0, durationMs: 100, command: 'npm test' } },
    submission('other', 40), end(41),
  ]);
  assert.equal(tasks.length, 2);
  const [task] = tasks;
  assert.deepEqual([task.runs, task.continuations, task.retries, task.reviews, task.interventions, task.status], [3, 1, 1, 0, 1, 'complete']);
  assert.equal(task.workingMs, (10 + 5 + 2) * 60000, 'Working time, not time on the clock.');
  assert.equal(task.firstAttemptSuccess, false);
  assert.equal(task.verification, 'passed');
  assert.deepEqual([task.agents.claude.runs, task.agents.claude.filesChanged, task.agents.claude.commands, task.agents.claude.edits, task.agents.codex.runs], [1, 2, 1, 1, 2]);
  assert.equal(task.usage.input, 100);
  assert.equal(task.usage.runsWithTokens, 1, 'Two of its runs reported nothing.');
  assert.equal(runs[0].costEstimateUSD, 0.5);
  assert.equal(runs[0].costBasis, 'not-charged-subscription', 'A dollar figure on a subscription is not a charge.');
  assert.equal(tasks[1].verification, 'unverified', 'A clean finish alone is not evidence.');
});

test('older journals without task records still group continuations and retries', () => {
  const { tasks } = ledgerFromRecords([submission('a', 0), end(1), submission('b', 2, {}, continuationRequest), end(3), submission('c', 4, { retryOf: 'b' }), end(5), submission('d', 6), end(7)]);
  assert.deepEqual(tasks.map(task => task.runs), [3, 1]);
});

test('usage limit readings stay apart from tasks, and prompts and commands only appear when asked for', () => {
  const records = [submission('a', 0), { type: 'check', runId: 'a', check: { status: 'passed', command: 'npm test' } }, end(1), { type: 'quota_observation', provider: 'claude', observedAt: at(2), plan: 'max', windows: [{ id: 'five', label: '5-hour', usedPercent: 40, resetsAt: at(50) }, { id: 'week', label: 'Weekly', usedPercent: 70, resetsAt: at(59) }] }];
  const plain = ledgerFromRecords(records), detailed = ledgerFromRecords(records, { prompts: true });
  assert.deepEqual(plain.quotaObservations[0].windows.map(row => row.label), ['5-hour', 'Weekly']);
  assert.equal(plain.quotaObservations[0].observedAt, at(2));
  assert.equal('quota' in plain.tasks[0], false);
  assert.equal(JSON.stringify(plain).includes('Build it'), false);
  assert.equal(JSON.stringify(plain).includes('npm test'), false);
  assert.equal(detailed.tasks[0].prompt, 'Build it');
  assert.equal(detailed.runs[0].check.command, 'npm test');
});

test('a background review counts toward the task it reviewed', () => {
  const { tasks } = ledgerFromRecords([submission('build', 0), end(1), { type: 'background_review', at: at(2), review: { id: 'rev', provider: 'codex', model: 'm' } }, { type: 'review_result', id: 'rev', at: at(4), result: { status: 'complete', usage: { total: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 5 } } } }]);
  assert.equal(tasks.length, 1);
  assert.deepEqual([tasks[0].reviews, tasks[0].usage.input, tasks[0].status], [1, 50, 'complete']);
  assert.equal(tasks[0].workingMs, 3 * 60000);
});

test('a new run knows its task, and the broker saves it and each changed usage reading in the journal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-ledger-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: {} }), c = broker.get(broker.create().id);
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(taskIdentity(c, { runId: 'new', text: 'Do it' }), { id: 'new', parentRunId: null, relation: null });
  c.lastRun = { id: 'previous', taskId: 'task-1' };
  assert.deepEqual(taskIdentity(c, { runId: 'new', text: continuationRequest }), { id: 'task-1', parentRunId: 'previous', relation: 'continuation' });
  assert.deepEqual(taskIdentity(c, { runId: 'new', text: 'Something new' }), { id: 'new', parentRunId: null, relation: null });
  c.lastRun = { id: 'older-journal' };
  assert.deepEqual(taskIdentity(c, { runId: 'new', text: continuationRequest }), { id: 'older-journal', parentRunId: 'older-journal', relation: 'continuation' });
  c.lastRun = null;
  const usage = percent => ({ available: true, plan: 'plus', fetchedAt: Date.parse(at(5)), windows: [{ id: 'primary', label: '5-hour', usedPercent: percent, resetsAt: at(50) }] });
  broker.observeQuota(c, 'codex', usage(40)); broker.observeQuota(c, 'codex', usage(40)); broker.observeQuota(c, 'codex', usage(41));
  broker.observeQuota(c, 'codex', { available: false }); broker.observeQuota(c, 'gemini', null);
  const { quotaObservations } = await broker.ledger(c);
  assert.deepEqual(quotaObservations.map(reading => reading.windows[0].usedPercent), [40, 41], 'Only a reading that changed is saved.');
  assert.equal(quotaObservations[0].observedAt, at(5));
});

test('the ledger ignores a torn last line, skips streaming text, and treats a missing journal as empty', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'journal.jsonl');
  fs.writeFileSync(file, [submission('a', 0), { type: 'message_delta', id: 'gone', text: 'x' }, end(1)].map(value => JSON.stringify(value)).join('\n') + '\n{"type":"mess');
  assert.equal((await readLedger(file)).runs[0].status, 'complete');
  assert.deepEqual((await readLedger(path.join(root, 'missing.jsonl'))).runs, []);
});

test('an Orchestrate plan adds up its planning run and every step, while each stays its own task (#84)', () => {
  const planning = ledgerFromRecords([
    submission('plan', 0, { mode: 'read', orchestration: { goal: 'Build it' } }),
    metadata(1, { usage: { input_tokens: 40, output_tokens: 10 } }), end(1),
  ]).tasks.map(task => ({ ...task }));
  assert.equal(planning[0].plan.id, 'plan');
  assert.equal(planning[0].plan.part, 'planning');
  assert.equal(planning[0].taskClass, null, 'A planning run is not a question to compare with other questions.');
  assert.deepEqual(Object.keys(planning[0].roles), ['planning']);
  // Steps run as tasks beside the conversation; the coordinator tags each with its plan.
  const step = (id, number, records) => ledgerFromRecords(records).tasks.map(task => ({ ...task, plan: { id: 'plan', part: 'step', stepId: `s${number}`, number } }));
  const first = step('one', 1, [
    submission('one', 2), metadata(3, { usage: { input_tokens: 100, output_tokens: 20 } }), end(3, 'complete'),
    { type: 'check', runId: 'one', check: { status: 'failed' } },
    submission('one-retry', 4, { retryOf: 'one' }), metadata(5, { usage: { input_tokens: 50, output_tokens: 5 } }), end(5),
    { type: 'check', runId: 'one-retry', check: { status: 'passed' } },
  ]);
  const second = step('two', 2, [submission('two', 6, { provider: 'codex' }), end(8)]);
  const unrelated = ledgerFromRecords([submission('other', 9), metadata(9, { usage: { input_tokens: 999, output_tokens: 1 } }), end(10)]).tasks;
  const [total, ...rest] = summarizePlans([...planning, ...first, ...second, ...unrelated]);
  assert.equal(rest.length, 0, 'A task outside a plan has no plan total.');
  assert.equal(total.id, 'plan');
  assert.equal(total.planned, true);
  assert.equal(total.steps, 2);
  assert.equal(total.runs, 4);
  assert.equal(total.retries, 1);
  assert.equal(total.workingMs, 5 * 60000, 'Working time only: 1 + 1 + 1 + 2 minutes, not the gaps between runs.');
  assert.equal(total.usage.input, 190);
  assert.equal(total.usage.output, 35);
  assert.equal(total.usage.runs, 4);
  assert.equal(total.usage.runsWithTokens, 3, 'The step that reported nothing stays unreported, not zero.');
  assert.equal(total.usage.reportedBy.input, 3);
  assert.equal(total.roles.planning.usage.input, 40);
  assert.equal(total.roles.builder.runs, 3);
  assert.deepEqual(total.providers, ['claude', 'codex']);
  assert.deepEqual(total.tests, { passed: 1, failed: 0, unverified: 1 });
  assert.equal(total.endedAt, at(8));
});

test('a plan nobody planned and whose steps reported no tokens keeps its tokens unknown', () => {
  const tasks = ledgerFromRecords([submission('a', 0), end(1)]).tasks.map(task => ({ ...task, plan: { id: 'manual', part: 'step', stepId: 's1', number: 1 } }));
  const [total] = summarizePlans(tasks);
  assert.equal(total.planned, false);
  assert.equal(total.usage.input, null);
  assert.equal(total.usage.runsWithTokens, 0);
  assert.equal(combineUsage([]).input, null);
});

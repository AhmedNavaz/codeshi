import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { assessmentPrompt, parseAssessment } from '../src/routing-assessment.mjs';
import { groupName, readParts } from '../src/flow-split.mjs';
import { TaskBudgets } from '../src/task-budget.mjs';
import { scriptCLIs } from './platform.mjs';

const usage = (used = 10) => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: used, resetsAt: new Date(Date.now() + 3600000).toISOString() }] });
const models = [{ id: 'gpt-6.1-sol', displayName: 'Codex', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }, { id: 'gpt-6-luna', displayName: 'Mini', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }];
const parts = [
  { title: 'Fix the login redirect', instructions: 'After signing in, users land on /home instead of the page they asked for. Send them back to the page they came from.', tier: 'standard', dependsOn: [] },
  { title: 'Add CSV export to reports', instructions: 'Add an Export CSV button to the reports page that downloads the visible rows.', tier: 'standard', dependsOn: [] },
  { title: 'Document the export', instructions: 'Describe the CSV export in the README.', tier: 'light', dependsOn: [2] },
];
const rating = { tier: 'standard', effort: 'medium', reason: 'Two unrelated changes and a note.' };
const request = 'Fix the login redirect so people land where they were going, add a CSV export to the reports page, and document the export in the README.';

function setup(t, { billing = 'subscription' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-split-test-')), workspace = path.join(root, 'project');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), '{}');
  const bin = path.join(root, 'codex.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  const broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin, claude: path.join(root, 'missing'), gemini: path.join(root, 'missing') } });
  broker.availableProviders = () => ['codex'];
  broker.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: billing });
  broker.handoff.models = async () => ({ data: models });
  broker.checks.usage = async () => usage();
  // The parts are recorded as tasks; these tests read the records rather than run agents in them.
  broker.tasks.tick = () => {};
  const c = broker.get(broker.create().id);
  broker.setRouting(c, { mode: 'smart', executionRevision: broker.execution.defaults(c).revision });
  const input = { text: request, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'send-split', executionRevision: broker.execution.defaults(c).revision, allowSplit: true, routing: { mode: 'smart', tier: 'standard', reason: 'Draft estimate' } };
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { broker, c, input };
}

test('the rater names parts only when asked, and parts that break a rule leave the rating as it is', () => {
  const brief = { workspaceFolders: [], attachments: { select: () => [] } }, c = { messages: [] };
  assert.doesNotMatch(assessmentPrompt(c, { text: request, attachments: [] }, brief), /parts:/);
  assert.match(assessmentPrompt(c, { text: request, attachments: [] }, brief, [], { split: true }), /parts: almost always \[\]/);
  assert.deepEqual(parseAssessment(JSON.stringify({ ...rating, parts }), { split: true }).parts, parts);
  assert.deepEqual(parseAssessment(JSON.stringify({ ...rating, parts: [] }), { split: true }), { ...rating, source: 'agent' });
  assert.throws(() => parseAssessment(JSON.stringify({ ...rating, parts })), /assessment/, 'Parts are refused when they weren’t asked for.');
  // One part, too many parts, a wait for a later part, or every part waiting on the last: no split, and the rating stands.
  for (const bad of [parts.slice(0, 1), [...parts, ...parts], [{ ...parts[0], dependsOn: [2] }, parts[1]], [parts[0], { ...parts[1], dependsOn: [1] }], [{ ...parts[0], tier: 'huge' }, parts[1]]]) {
    assert.equal(readParts(bad).length, 0);
    assert.equal(parseAssessment(JSON.stringify({ ...rating, parts: bad }), { split: true }).tier, 'standard');
  }
  assert.equal(groupName('Fix the redirect\nand more', new Set(['Fix the redirect'])), 'Fix the redirect (2)');
});

test('a split is proposed with each part’s agent and billing, and nothing starts or shows in the chat until you choose', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  let prompts = [];
  broker.router.worker = async (_broker, _run, config) => { prompts.push(config.prompt); return JSON.stringify({ ...rating, parts }); };
  const answer = await broker.dispatch(c, input);
  assert.equal(answer.split.proposed, true);
  assert.match(prompts[0], /parts: almost always/);
  assert.equal(broker.running, null); assert.equal(c.lastRun, null);
  assert.equal(c.messages.filter(message => message.role === 'user').length, 0, 'The message isn’t in the chat until you choose.');
  const proposal = broker.view(c).splitProposal;
  assert.equal(proposal.parts.length, 3);
  for (const part of proposal.parts) { assert.equal(part.pick.provider, 'codex'); assert.equal(part.pick.billing, 'subscription'); }
  assert.equal(proposal.assessment.parts, undefined);
  assert.deepEqual((await broker.dispatch(c, input)).split, answer.split, 'Sending the same request again answers with the same suggestion.');
  assert.equal(prompts.length, 1);
});

test('without the composer asking, a queued prompt or a short message is rated without parts and runs as it is', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  const prompts = [];
  broker.router.worker = async (_broker, _run, config) => { prompts.push(config.prompt); return JSON.stringify(rating); };
  await broker.dispatch(c, { ...input, allowSplit: false }); await broker.running.done;
  assert.doesNotMatch(prompts[0], /parts:/);
  assert.equal(c.splitProposal ?? null, null);
});

test('doing it as one runs the message once with the rating it was shown with', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  let calls = 0;
  broker.router.worker = async () => { calls++; return JSON.stringify({ ...rating, parts }); };
  const { split } = await broker.dispatch(c, input);
  const done = await broker.splits.act(c, { id: split.id, action: 'one' });
  assert(done.accepted.runId); await broker.running?.done;
  assert.equal(calls, 1, 'It isn’t rated twice.');
  assert.equal(c.lastRun.routing.assessment.tier, 'standard');
  assert.equal(c.lastRun.routing.assessment.parts, undefined);
  assert.equal(c.messages.filter(message => message.role === 'user' && message.text === request).length, 1);
  assert.equal(c.splitProposal, null); assert.equal(c.splitHistory.at(-1).outcome, 'one');
  await assert.rejects(broker.splits.act(c, { id: split.id, action: 'tasks' }), /no longer open/);
});

test('running the parts makes Plan cards in one group, run as tasks that wait for the parts they need and share the message’s task', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const { split } = await broker.dispatch(c, input);
  const taskId = c.splitProposal.taskId;
  const done = await broker.splits.act(c, { id: split.id, action: 'tasks' });
  const cards = done.cards.map(id => broker.board.find(c, id));
  assert.equal(cards.length, 3);
  assert(cards.every(card => card.group === done.group && card.auto === true && card.source.kind === 'flow-split' && card.column === 'doing'));
  assert.deepEqual(cards[2].dependsOn, [cards[1].id]);
  const tasks = cards.map(card => broker.tasks.find(c, card.task));
  assert(tasks.every(task => task.parentTaskId === taskId && task.splitId === split.id));
  assert.deepEqual(tasks[2].dependsOn, [tasks[1].id]);
  // A part that ended before a restart counts with the usage saved on its task.
  broker.tasks.update(c, tasks[1], { budgetUsed: { tokens: 500, retries: 1 } });
  const shared = broker.tasks.sharedUsage(c, tasks[0]);
  assert(shared.tokens >= 500); assert.equal(shared.retries, 1);
  assert.equal(c.messages.filter(message => message.role === 'user' && message.splitId === split.id).length, 1);
  assert.match(c.messages.at(-1).text, /3 tasks that run side by side/);
  assert.equal(c.splitProposal, null);
});

test('parts that bill by use need your yes, and splitting without asking never uses them', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t, { billing: 'api' });
  broker.splits.prefer(c, { auto: true });
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const answer = await broker.dispatch(c, { ...input, billingConfirmed: true, routing: { ...input.routing, allowApi: true } });
  assert.equal(answer.split.proposed, true, 'An API agent means Flow asks, even with splitting without asking on.');
  await assert.rejects(broker.splits.act(c, { id: answer.split.id, action: 'tasks' }), /bills by use/);
  const done = await broker.splits.act(c, { id: answer.split.id, action: 'tasks', billingConfirmed: true });
  assert.equal(done.cards.length, 3);
});

test('with splitting without asking on, subscription parts start at once; putting a suggestion away gives the message back', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const first = await broker.dispatch(c, input);
  const back = await broker.splits.act(c, { id: first.split.id, action: 'dismiss' });
  assert.equal(back.text, request); assert.equal(c.splitProposal, null);
  broker.splits.prefer(c, { auto: true });
  const second = await broker.dispatch(c, { ...input, requestId: 'send-split-2' });
  assert.equal(second.split.automatic, true);
  assert.equal(second.split.cards.length, 3);
  assert.match(c.messages.at(-1).text, /^Flow split this into 3 tasks/);
});

test('a part’s limits count what its message and the other parts used', () => {
  const budgets = new TaskBudgets({ record() {}, emit() {} });
  const c = { taskPolicy: { maxTokens: 1000, maxRetries: 3 }, taskBudgets: {} };
  const state = { taskId: 'part', runs: 1, retries: 1, reviews: 0, handoffs: 0, workingMs: 0, tokens: { input: 300, output: 0, cacheWrite: 0, cacheRead: 0 }, spendUSD: 0, runsWithoutUsage: 0, runsWithPartialUsage: 0, runsWithoutCost: 0, spendCaps: {}, active: {}, failures: {}, extra: {} };
  c.taskBudgets.part = state;
  assert.equal(budgets.exceeded(c, state), null);
  budgets.shared = (_c, taskId) => taskId === 'part' ? { tokens: 800, retries: 2 } : null;
  assert.equal(budgets.exceeded(c, state).limit, 'maxTokens');
  assert.equal(budgets.used(state).tokens, 300, 'Without the conversation, a part’s own usage alone, as the other parts read it.');
  const refused = budgets.refusal({ taskPolicy: { maxRetries: 3 }, taskBudgets: { part: { ...state, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } } } }, { task: { id: 'part', relation: 'retry' }, provider: 'codex' });
  assert.equal(refused.limit, 'maxRetries'); assert.match(refused.message, /other parts of its split/);
});

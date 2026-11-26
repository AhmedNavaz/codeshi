import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Broker } from '../src/broker.mjs';
import { MutationCoordinator } from '../src/mutation-lock.mjs';
import { assessmentPrompt, parseAssessment } from '../src/routing-assessment.mjs';
import { groupName, readParts } from '../src/flow-split.mjs';
import { TaskBudgets } from '../src/task-budget.mjs';
import { TOOK_OVER } from '../src/task-coordinator.mjs';
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

function setup(t, { billing = 'subscription', ask = true } = {}) {
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
  // Splitting without asking is on by default in Flow; most of these tests look at the suggestion, so they turn it off.
  if (ask) broker.splits.prefer(c, { auto: false });
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

test('running the parts makes hidden cards in one group, with a review after them, run as tasks that wait for the parts they need and share the message’s task', { skip: scriptCLIs }, async t => {
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
  assert.match(c.messages.at(-1).text, /3 parts that run side by side.*answers here/);
  assert.equal(c.splitProposal, null);
  // One review of the combined result waits for every part, and Flow finishes them out of sight.
  const run = c.splitRuns.at(-1), review = broker.board.find(c, run.reviewCardId);
  assert.deepEqual([run.status, run.automatic, review.role, review.column], ['working', false, 'reviewer', 'doing']);
  assert.deepEqual(review.dependsOn, done.cards);
  assert(broker.board.view(c).cards.every(card => card.managed), 'The parts aren’t the Plan’s while Flow finishes them.');
  assert(broker.view(c).parallelTasks.every(task => task.managed), 'Nor are they in Tasks.');
});

const settle = () => new Promise(resolve => setTimeout(resolve, 30));
// A part's task as it would end: finished in the folder, with its report, files and tests.
const finishPart = (broker, c, cardId, changes = {}) => {
  const task = broker.tasks.find(c, broker.board.find(c, cardId).task);
  broker.tasks.update(c, task, { status: 'complete', mode: 'direct', provider: 'codex', stepResult: { summary: 'Did it.', files: [`${cardId.slice(0, 4)}.js`] }, stepCheck: { id: 'x', status: 'done', outcome: 'passed', command: 'npm test' }, ...changes });
  return task;
};

test('Flow finishes a split by itself: it accepts each part, waits for the review, answers once and clears the parts away', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const { split } = await broker.dispatch(c, input);
  const done = await broker.splits.act(c, { id: split.id, action: 'tasks' });
  const run = c.splitRuns.at(-1);
  finishPart(broker, c, done.cards[0], { worktree: '/tmp/codeshi-wt/worktree', stepResult: { summary: 'Did it.', files: ['/tmp/codeshi-wt/worktree/src/redirect.js'] } });
  for (const id of done.cards.slice(1)) finishPart(broker, c, id);
  await settle();
  assert(done.cards.every(id => broker.board.find(c, id).column === 'done' && broker.board.find(c, id).acceptedBy === 'flow'), 'Flow accepts a finished part whose tests passed.');
  assert.equal(c.splitRuns.at(-1).status, 'working', 'It waits for the review.');
  assert(!c.messages.some(message => /The Plan’s run/.test(message.text || '')), 'The Plan’s own end-of-run note isn’t given for Flow’s parts.');
  const reviewTask = broker.tasks.find(c, broker.board.find(c, run.reviewCardId).task);
  broker.tasks.update(c, reviewTask, { status: 'complete', mode: 'direct', provider: 'codex', review: { status: 'passed', verdict: 'pass', round: 1, earlier: [{ problem: 'x' }], findings: [] }, stepCheck: { id: 'y', status: 'done', outcome: 'passed', command: 'npm test' } });
  await settle();
  assert.equal(c.splitRuns.at(-1).status, 'finished'); assert.equal(c.splitRuns.at(-1).outcome, 'done');
  const answer = c.messages.at(-1);
  assert.deepEqual([answer.role, answer.splitResult.parts], ['assistant', 3]);
  assert.match(answer.text, /^Flow did this in 3 parts side by side and merged them into project\./);
  assert.match(answer.text, /\*\*1\. Fix the login redirect\*\* · Codex/);
  assert.match(answer.text, /\*\*Review\*\* · Codex found 1 problem; one repair round fixed it\./);
  assert.match(answer.text, /\*\*Tests\*\* · `npm test` passed on the combined result\./);
  assert.match(answer.text, /\*\*Changed\*\* · `src\/redirect\.js`/);
  assert.doesNotMatch(answer.text, /codeshi-wt/, 'Changed paths are folder-relative rather than worktree paths.');
  assert.equal(broker.board.cards(c).length, 0, 'The parts and the review leave the Plan.');
  assert.equal(broker.view(c).parallelTasks.length, 0, 'And Tasks; their conversations stay.');
  assert.equal(c.parallelTasks.length, 4);
});

// Flow answers only for a result its review passed. Each of these ends the review another way, as its task would record
// it: the parts are already merged, and they and the review go to the Plan with the reason instead of being cleared away.
const failedCheck = { id: 'review-check', status: 'done', outcome: 'failed', command: 'npm test', exitCode: 1 }, finding = { problem: 'The export omits the final row.', fix: 'Include the final row.', file: 'src/export.js' };
const inReview = /their review are on the Plan as “.*” for you to finish: read the review there, then accept it or send it back\.$/;
const unsettledReviews = [
  // Failed tests come before any verdict, even a pass.
  { name: 'failed combined tests', changes: { review: { status: 'passed', verdict: 'pass', findings: [] }, stepCheck: failedCheck }, reason: /^The tests failed on the combined result \(npm test\)\.$/ },
  // A second review's verdict isn't read when its tests fail, so it stays as the repair round left it. Flow waited for good.
  { name: 'failed second-review tests before a new verdict', changes: { review: { status: 'reviewing', verdict: 'changes', round: 1, findings: [finding] }, stepCheck: failedCheck }, reason: /^The tests failed on the combined result \(npm test\)\.$/ },
  { name: 'findings after the repair round', changes: { review: { status: 'held', verdict: 'changes', round: 1, findings: [{ ...finding, problem: 'The export still omits the final row.' }], earlier: [finding], reason: 'The review still found 1 problem after the repair round. The cards after it wait for you: continue anyway, or send cards back.' } }, reason: /^The review of the combined result still found 1 problem after the repair round\.$/ },
  { name: 'findings no repair could take', changes: { review: { status: 'held', verdict: 'changes', round: 0, findings: [finding, { problem: 'The README names the wrong button.' }], repairs: [], reason: 'The findings don’t name a card it checked, so nothing could be repaired. The cards after it wait for you.' } }, reason: /^The review of the combined result found 2 problems that Flow couldn’t repair by itself\.$/ },
  { name: 'a missing review verdict', changes: { review: null }, reason: /^The review of the combined result didn’t end with a verdict\.$/ },
  { name: 'interrupted combined tests', changes: { review: { status: 'passed', verdict: 'pass', findings: [] }, stepCheck: { id: 'review-check', status: 'interrupted', command: 'npm test' } }, reason: /^The tests on the combined result were interrupted\.$/ },
  // Stopped, as Stop on the split's line does once only the review is left: its card is back in Ready, to run again.
  { name: 'a stopped reviewer', changes: { status: 'stopped', reason: 'Stopped by the person.', review: null }, reason: /^The review of the combined result didn’t finish: Stopped before it finished\.$/, next: /their review are on the Plan as “.*” for you to finish: run the review again there, or remove it\.$/, column: 'ready' },
];
for (const scenario of unsettledReviews) test(`Flow keeps the split on the Plan after ${scenario.name}`, { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const { split } = await broker.dispatch(c, input);
  const done = await broker.splits.act(c, { id: split.id, action: 'tasks' });
  const run = c.splitRuns.at(-1);
  for (const id of done.cards) finishPart(broker, c, id);
  await settle();
  assert(done.cards.every(id => broker.board.find(c, id).column === 'done'), 'The parts have already been accepted before the combined review ends.');
  const reviewCard = broker.board.find(c, run.reviewCardId), reviewTask = broker.tasks.find(c, reviewCard.task);
  broker.tasks.update(c, reviewTask, { status: 'complete', mode: 'direct', provider: 'codex', stepCheck: { id: 'review-check', status: 'done', outcome: 'passed', command: 'npm test' }, ...scenario.changes });
  await settle();

  assert.deepEqual([run.status, run.merged], ['handed', 3]);
  assert.match(run.reason, scenario.reason);
  assert.deepEqual(broker.board.cards(c).map(card => card.id).sort(), [...done.cards, run.reviewCardId].sort(), 'The parts and their review remain available for recovery.');
  assert(done.cards.every(id => broker.board.find(c, id).column === 'done' && broker.board.find(c, id).acceptedBy === 'flow'), 'Already finished work stays accepted.');
  assert.equal(broker.board.find(c, run.reviewCardId).column, scenario.column || 'review', 'The unsuccessful review is not accepted.');
  assert(broker.board.view(c).cards.every(card => !card.managed), 'The cards are visible on the Plan.');
  assert.equal(c.parallelTasks.length, 4, 'No additional repair or review task is created.');
  assert(c.parallelTasks.every(task => !task.closed), 'The task results remain available.');
  assert(broker.view(c).parallelTasks.every(task => !task.managed), 'The person can open every task.');
  assert.deepEqual(broker.tasks.find(c, reviewTask.id).review, scenario.changes.review, 'The original findings or missing verdict remain unchanged.');
  const said = c.messages.at(-1);
  assert.equal(said.role, 'system');
  assert.match(said.text, /3 of 3 parts.*stay in your folder.*on the Plan/);
  assert(said.text.startsWith(`${run.reason} Flow had finished 3 of 3 parts`), 'The chat says why, in the same words the split is saved with.');
  assert.match(said.text, scenario.next || inReview, 'With every part merged, the chat points at the review, not at merging the parts.');
  assert(!c.messages.some(message => message.splitResult?.id === run.id), 'An unsettled split does not produce a finished Flow answer.');
  const messageCount = c.messages.length;
  await broker.splits.finisher.drive(c);
  assert.equal(c.messages.length, messageCount, 'Another state update does not repeat the handover or restart work.');
  assert.equal(c.parallelTasks.length, 4);
  // Nothing of the split was still working, so its run ended with the handover: the Plan doesn't then announce the end of
  // a run of cards the person never started, as it would for its own cards once a task of theirs changes.
  broker.tasks.update(c, broker.tasks.find(c, reviewTask.id), { budgetUsed: { tokens: 1 } });
  await settle();
  assert.equal(c.messages.length, messageCount, 'Flow’s message is the only one about the end of this run.');
});

test('a second review that still finds a problem is said once, by Flow, and its findings are on the Plan', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const { split } = await broker.dispatch(c, input);
  const done = await broker.splits.act(c, { id: split.id, action: 'tasks' });
  const run = c.splitRuns.at(-1);
  for (const id of done.cards) finishPart(broker, c, id);
  await settle();
  // The second review's run has ended: its verdict is read while its tests are still running, as a card's task does it.
  const reviewTask = broker.tasks.find(c, broker.board.find(c, run.reviewCardId).task);
  broker.tasks.update(c, reviewTask, { status: 'complete', mode: 'direct', provider: 'codex', review: { status: 'reviewing', verdict: 'changes', round: 1, findings: [{ ...finding, cardId: done.cards[1] }], repairs: [{ cardId: done.cards[1], title: parts[1].title, count: 1, status: 'done' }] }, stepCheck: { id: 'review-check', status: 'running' } });
  const before = c.messages.length;
  const review = broker.board.reviews.ended(c, reviewTask, `It is still wrong.\n\n\`\`\`json\n${JSON.stringify({ verdict: 'changes', findings: [{ card: parts[1].title, problem: 'The export still omits the final row.' }] })}\n\`\`\``);
  assert.deepEqual([review.status, review.round, review.findings.length, review.earlier.length], ['held', 1, 1, 1]);
  await settle();
  assert.equal(run.status, 'working', 'Flow waits for the tests on the combined result.');
  assert.equal(c.messages.length, before, 'The review’s own note for the Plan is left out: Flow says it as it hands the parts over.');
  broker.tasks.update(c, reviewTask, { stepCheck: { id: 'review-check', status: 'done', outcome: 'passed', command: 'npm test' } });
  await settle();
  assert.equal(run.status, 'handed');
  const said = c.messages.slice(before);
  assert.deepEqual(said.map(message => message.role), ['system'], 'One message, not the review’s and Flow’s.');
  assert.match(said[0].text, /^The review of the combined result still found 1 problem after the repair round\. Flow had finished 3 of 3 parts, and they stay in your folder\. The parts and their review are on the Plan/);
  const shown = broker.board.view(c).cards.find(card => card.id === run.reviewCardId);
  assert.deepEqual([shown.column, shown.managed, shown.taskState.review.status, shown.taskState.holds], ['review', false, 'held', true]);
  assert.deepEqual(shown.taskState.review.findings.map(item => [item.cardTitle, item.problem]), [[parts[1].title, 'The export still omits the final row.']], 'The review’s card names the part each finding is about.');
});

test('a part Flow can’t settle hands the split to the Plan, and what it finished stays', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const { split } = await broker.dispatch(c, input);
  const done = await broker.splits.act(c, { id: split.id, action: 'tasks' });
  finishPart(broker, c, done.cards[0]);
  await settle();
  assert.equal(broker.board.find(c, done.cards[0]).column, 'done');
  finishPart(broker, c, done.cards[1], { stepCheck: { id: 'z', status: 'done', outcome: 'failed', command: 'npm test', exitCode: 1 } });
  await settle();
  const run = c.splitRuns.at(-1);
  assert.deepEqual([run.status, run.merged], ['handed', 1]);
  assert.match(c.messages.at(-1).text, /The tests failed on “Add CSV export to reports” \(npm test\)\. Flow had finished 1 of 3 parts.*on the Plan as “.*” for you to finish/);
  assert(broker.board.view(c).cards.every(card => !card.managed), 'Every card is on the Plan now.');
  assert(broker.view(c).parallelTasks.every(task => !task.managed));
  assert.equal(broker.board.find(c, done.cards[1]).column, 'review', 'The failed part waits in Review as any card does.');
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

test('splitting without asking is on by default in Flow, in the folder you are in; putting a suggestion away gives the message back', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t);
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const first = await broker.dispatch(c, input);
  const back = await broker.splits.act(c, { id: first.split.id, action: 'dismiss' });
  assert.equal(back.text, request); assert.equal(c.splitProposal, null);
  broker.splits.prefer(c, { auto: true });
  const second = await broker.dispatch(c, { ...input, requestId: 'send-split-2' });
  assert.equal(second.split.automatic, true);
  assert.equal(second.split.cards.length, 3);
  assert.match(c.messages.at(-1).text, /^Flow split this into 3 parts/);
  assert.equal(c.splitRuns.at(-1).automatic, true);
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

test('Flow splits subscription parts without asking by default, with no folder question', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t, { ask: false });
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const answer = await broker.dispatch(c, input);
  assert.equal(answer.split.automatic, true);
  assert.equal(answer.split.cards.length, 3);
});

// Leaving Flow (#107, #132): a split Flow made by itself is yours at once. Flow merges, reviews and answers nothing more.
test('leaving Flow hands a split Flow made by itself to the Plan at once: what hadn’t started goes back to Ready, and a part working carries on without Flow', { skip: scriptCLIs }, async t => {
  const { broker, c, input } = setup(t, { ask: false });
  broker.router.worker = async () => JSON.stringify({ ...rating, parts });
  const answer = await broker.dispatch(c, input);
  assert.equal(answer.split.automatic, true);
  const run = c.splitRuns.at(-1), [working, ...rest] = run.cards.map(id => broker.tasks.find(c, broker.board.find(c, id).task));
  broker.tasks.update(c, working, { status: 'running' });
  const policyId = working.execution.taskId;
  assert.equal(broker.execution.current(c, policyId).mode, 'flow');
  broker.setRouting(c, { mode: null, executionRevision: broker.execution.defaults(c).revision });
  assert.equal(run.status, 'handed');
  assert.match(c.messages.at(-1).text, /^You took over from Flow, so Flow stopped finishing this message by itself, and what hadn’t started is back in Ready\. The parts are on the Plan as “.*” for you to finish: run the ones in Ready again, and merge, send back or discard the others there\.$/);
  for (const id of [...run.cards.slice(1), run.reviewCardId]) assert.deepEqual([broker.board.find(c, id).column, broker.board.find(c, id).reason], ['ready', TOOK_OVER], 'What hadn’t started, the review too, is back in Ready.');
  assert(rest.every(task => task.status === 'cancelled'));
  assert(broker.board.view(c).cards.every(card => !card.managed), 'Every card is on the Plan now.');
  const policy = broker.execution.current(c, policyId);
  assert.deepEqual([broker.board.find(c, run.cards[0]).column, policy.mode, working.execution.revision], ['doing', 'normal', policy.revision], 'The part working carries on, as a Normal task.');
  // When it finishes, Flow neither accepts nor answers for it: it waits in Review, as any card you finish does.
  finishPart(broker, c, run.cards[0]);
  await settle();
  assert.equal(broker.board.find(c, run.cards[0]).column, 'review');
  assert.equal(c.messages.filter(message => message.splitResult).length, 0, 'Flow doesn’t answer for the split.');
});

// With real copies. Each part works in a Git worktree made from the last commit, and Flow merges it without committing.
// So the review, the repair and the second review each start with the work before them, brought from the folder: the
// review once read copies with none of the parts in them, and a repair began without the part it fixed and conflicted
// with it on the way back.
test('in a split, the review reads every merged part in its own copy, a repair starts from the parts as merged, and the second review reads the repair', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-split-copies-'))), workspace = path.join(root, 'project');
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const verdict = value => `I read the combined changes.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, broken = 'export const rows = all => all.slice(0, -1);\n', fixed = 'export const rows = all => all;\n';
  fs.mkdirSync(workspace);
  // The mock agent answers by what its request contains, the most specific first. Both reviews and the repair hold, so
  // their copies can be read while they work.
  fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), JSON.stringify({
    '~The cards you reviewed had one repair run': { behavior: 'hold', text: verdict({ verdict: 'pass' }) },
    '~This part is already done and merged into the folder': { behavior: 'hold', text: 'Included the final row.', write: { 'src/export.js': fixed } },
    '~Every part of this request was done by its own agent': { behavior: 'hold', text: verdict({ verdict: 'changes', findings: [{ card: parts[1].title, problem: 'The export omits the final row.', fix: 'Include the final row.', file: 'src/export.js' }] }) },
    '~Describe the CSV export in the README': { text: 'Documented the export.', write: { 'README.md': '# Project\n\nReports export to CSV.\n' } },
    '~Add an Export CSV button': { text: 'Added the export.', write: { 'src/export.js': broken } },
    '~Send them back to the page they came from': { text: 'Fixed the redirect.', write: { 'src/redirect.js': 'export const next = url => url;\n' } },
  }));
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.release\n.mock-captures.jsonl\nnode_modules\n'); fs.writeFileSync(path.join(workspace, 'README.md'), '# Project\n');
  git('init', '-q'); git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't'); git('add', '.'); git('commit', '-qm', 'first');
  const head = git('rev-parse', 'HEAD').trim(), bin = path.join(root, 'codex.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  const mutations = new MutationCoordinator(path.join(root, 'locks'));
  const broker = new Broker({ workspace, workspaceFolders: [{ id: 'project', name: 'project', path: workspace }], dataDir: path.join(root, 'data'), bins: { codex: bin, claude: path.join(root, 'missing'), gemini: path.join(root, 'missing') }, handoffPreferences: () => ({ threshold: 0, automatic: false }), acquireMutation: operation => mutations.acquireMany([workspace], operation), acquireFolders: (where, operation) => mutations.acquireMany(where, operation), withFolders: (where, operation, work) => mutations.withMutations(where, operation, work) });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Each task runs in a lane with a broker of its own, which reads the same stand-in account, models and usage.
  const stub = target => {
    target.availableProviders = () => ['codex'];
    target.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
    target.handoff.models = async () => ({ data: models });
    target.checks.usage = async () => usage();
    target.router.worker = async (_broker, _run, config) => JSON.stringify(/parts:/.test(config.prompt) ? { ...rating, parts } : rating);
  };
  stub(broker);
  broker.tasks.BrokerClass = class extends Broker { constructor(options) { super(options); stub(this); } };
  broker.tasks.tests = { saved: () => null };
  const c = broker.get(broker.create().id);
  broker.budget.setPolicy(c, { maxConcurrent: 5 });
  broker.setRouting(c, { mode: 'smart', executionRevision: broker.execution.defaults(c).revision });
  broker.splits.prefer(c, { auto: false });
  const until = async (check, what) => { for (let i = 0; i < 3000; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Timed out waiting for ${what}.`); };
  const read = (place, name) => fs.existsSync(path.join(place, name)) ? fs.readFileSync(path.join(place, name), 'utf8') : null;
  const sent = task => { const file = path.join(task.scopePath, '.mock-captures.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).context) : []; };
  const { split } = await broker.dispatch(c, { text: request, provider: 'codex', mode: 'edit', approvalPolicy: 'ask', requestId: 'send-split', executionRevision: broker.execution.defaults(c).revision, allowSplit: true, routing: { mode: 'smart', tier: 'standard', reason: 'Draft estimate' } });
  await broker.splits.act(c, { id: split.id, action: 'tasks' });
  const run = c.splitRuns.at(-1), reviewTask = () => { const card = broker.board.cards(c).find(item => item.id === run.reviewCardId); return card && broker.board.task(c, card); };

  // The review starts once every part is merged. Its copy has all three, though the folder's last commit has none.
  const review = await until(() => { const task = reviewTask(); return task?.scopePath && sent(task).length === 1 ? task : null; }, 'the review to start');
  assert.deepEqual([git('rev-parse', 'HEAD').trim(), git('status', '--porcelain')], [head, ' M README.md\n?? src/\n'], 'Flow merged the parts and committed nothing.');
  assert.deepEqual([read(review.scopePath, 'src/redirect.js'), read(review.scopePath, 'src/export.js'), read(review.scopePath, 'README.md')], ['export const next = url => url;\n', broken, '# Project\n\nReports export to CSV.\n']);
  assert.deepEqual([review.carried, review.uncommitted || 0], [{ from: head, files: 3 }, 0]);
  assert.ok(sent(review)[0].taskScope.includes('so this copy also has the 3 files it changed, as they are in project now'), sent(review)[0].taskScope);
  // A part that waited for another began with that part's file too.
  const docs = c.parallelTasks.find(task => task.title === parts[2].title);
  assert.equal(docs.carried.files, 1);
  fs.writeFileSync(path.join(review.scopePath, '.release'), '');

  // The repair is a new task, as the part's copy is merged and gone. It says which part it repairs from the start, so its
  // copy begins with every part as merged, and what it changes merges back as a change to the part's file.
  const repair = await until(() => { const task = c.parallelTasks.find(item => item.splitRepair); return task?.scopePath && sent(task).length ? task : null; }, 'the repair to start');
  assert.deepEqual([repair.carried, read(repair.scopePath, 'src/redirect.js'), read(repair.scopePath, 'README.md')], [{ from: head, files: 3 }, 'export const next = url => url;\n', '# Project\n\nReports export to CSV.\n']);
  // The mock records its prompt before it writes its change, so wait for the change to land (a slow runner can be behind).
  const changed = await until(() => { const out = execFileSync('git', ['diff', '--name-status', repair.base], { cwd: repair.scopePath, encoding: 'utf8' }); return out.trim() ? out : null; }, 'the repair to change its file');
  assert.equal(changed, 'M\tsrc/export.js\n', 'Against what it began with, it changed the part’s file, where it once added a second one beside the folder’s.');
  // The first review's run has ended, so its copy can hold the second one.
  fs.rmSync(path.join(review.scopePath, '.release'));
  fs.writeFileSync(path.join(repair.scopePath, '.release'), '');

  // Flow merges the repair, and the second review reads it in the copy the first one read.
  await until(() => sent(review).length === 2, 'the second review to start');
  assert.deepEqual([read(workspace, 'src/export.js'), repair.status, run.status], [fixed, 'integrated', 'working'], 'The repair merged without a conflict.');
  assert.equal(read(review.scopePath, 'src/export.js'), fixed, 'The review’s copy has the repaired file.');
  assert.match(sent(review)[1].currentRequest, /^The cards you reviewed had one repair run each\. Check the files again: is each finding fixed, and did a repair break anything\?\nThe repairs are merged, and your copy now has what changed since your review, 1 file: `git diff [0-9a-f]{12} [0-9a-f]{12}` shows it\.\n/);
  assert.equal(execFileSync('git', ['diff', '--name-only', ...sent(review)[1].currentRequest.match(/`git diff ([0-9a-f]{12}) ([0-9a-f]{12})`/).slice(1)], { cwd: review.scopePath, encoding: 'utf8' }), 'src/export.js\n', 'The command it is given shows the repair.');
  assert.equal(review.carried.files, 3);
  assert.deepEqual(broker.tasks.planFor(c, review).plan.files, [], 'The review itself still changed nothing: what came into its copy isn’t its own change.');
  fs.writeFileSync(path.join(review.scopePath, '.release'), '');

  // The review passes, so Flow answers for the whole message.
  await until(() => run.status !== 'working', 'Flow to finish the split');
  assert.deepEqual([run.status, run.outcome], ['finished', 'done']);
  assert.match(c.messages.findLast(message => message.splitResult).text, /\*\*Review\*\* · Codex found 1 problem; one repair round fixed it\./);
  assert.deepEqual([read(workspace, 'src/export.js'), git('rev-parse', 'HEAD').trim()], [fixed, head]);
});

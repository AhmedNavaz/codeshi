import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import '../public/routing.js';
import { Broker } from '../src/broker.mjs';

const { classify, modelTier, route, escalate, planner } = globalThis.relayRouting;
const levels = (...values) => values.map(reasoningEffort => ({ reasoningEffort }));
const models = {
  codex: [{ id: 'gpt-codex', displayName: 'GPT Codex', isDefault: true, supportedReasoningEfforts: levels('low', 'medium', 'high', 'xhigh') }, { id: 'gpt-codex-mini', displayName: 'GPT Codex Mini', supportedReasoningEfforts: levels('low', 'medium') }],
  claude: [{ value: 'default', id: 'default', displayName: 'Default' }, { id: 'haiku', displayName: 'Haiku' }, { id: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium', 'high'] }, { id: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }],
};
const agents = (overrides = {}) => ['codex', 'claude'].map(provider => ({ provider, eligible: true, billingSource: 'subscription', usedPercent: 20, models: models[provider], ...overrides[provider], usage: overrides[provider]?.usage || { available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: overrides[provider]?.usedPercent ?? 20 }] } }));

test('requests are classified by simple local rules: small edits and quick questions are light, complex work is deep', () => {
  assert.equal(classify('Fix the typo in the README').tier, 'light');
  assert.equal(classify('Where is the login form defined?').tier, 'light');
  assert.equal(classify('Why does the build fail with a missing module error?').tier, 'standard', 'A question about a failure is not a quick one.');
  assert.equal(classify('Add a loading spinner to the checkout button').tier, 'standard');
  assert.deepEqual(classify('Refactor the payment module into separate services'), { tier: 'deep', reason: 'a complex task (refactoring)' });
  assert.equal(classify('Track down the race condition in the job queue').tier, 'deep');
  assert.equal(classify('Update src/a.js, src/b.js, src/c.js, src/d.js and src/e.js to use the new logger').tier, 'deep', 'Many files make a large task.');
  assert.equal(classify('Rename the variable', { attachments: 1 }).tier, 'standard', 'Attachments mean there is more to read.');
  assert.deepEqual(['GPT Codex Mini', 'Haiku', 'Gemini Flash', 'Sonnet', 'GPT Codex', 'Opus', 'Gemini Pro'].map(displayName => modelTier({ displayName })), ['light', 'light', 'light', 'standard', 'standard', 'deep', 'deep']);
});

test('each mode matches the model and effort to the task, within the levels each model supports', () => {
  const pick = (text, mode, current = 'claude') => { const { provider, model, effort } = route({ text, mode, candidates: agents(), current }); return [provider, model, effort]; };
  assert.deepEqual(pick('Fix the typo in the README', 'balanced'), ['claude', 'haiku', null], 'Haiku reports no effort levels, so the agent decides.');
  assert.deepEqual(pick('Add a loading spinner to the checkout button', 'balanced'), ['claude', 'sonnet', 'medium']);
  assert.deepEqual(pick('Refactor the payment module', 'balanced'), ['claude', 'opus', 'high']);
  assert.deepEqual(pick('Refactor the payment module', 'quality'), ['claude', 'opus', 'max'], 'Maximum quality takes the highest level for complex work.');
  assert.deepEqual(pick('Refactor the payment module', 'saving'), ['claude', 'sonnet', 'medium'], 'Cost saving keeps the strongest model for later.');
  assert.deepEqual(pick('Add a loading spinner to the checkout button', 'quality', 'codex'), ['codex', 'gpt-codex', 'high'], 'Without a deeper Codex model, the default with more effort.');
  assert.deepEqual(pick('Fix the typo in the README', 'saving', 'codex'), ['codex', 'gpt-codex-mini', 'low']);
  const routed = route({ text: 'Refactor the payment module', mode: 'balanced', candidates: agents(), current: 'claude' });
  assert.equal(routed.reason, 'A complex task (refactoring)'); assert.equal(routed.modelName, 'Opus');
  assert.deepEqual(route({ text: 'Add a test', mode: 'balanced', candidates: agents({ claude: { models: [] } }), current: 'claude' }).model, null, 'Without a model list, the agent’s default.');
});

test('a plan step is routed by the tier it was planned with, and the planner gets the deepest work each mode allows', () => {
  const step = (tier, mode = 'balanced') => { const { model, effort, tier: given } = route({ text: 'Fix the typo in the README', tier, mode, candidates: agents(), current: 'claude' }); return [model, effort, given]; };
  assert.deepEqual(step('deep'), ['opus', 'high', 'deep'], 'The planned tier wins over how the text reads.');
  assert.deepEqual(step('standard'), ['sonnet', 'medium', 'standard']);
  assert.deepEqual(step('light', 'quality'), ['sonnet', 'medium', 'light']);
  assert.deepEqual(step('huge'), ['haiku', null, 'light'], 'An unknown tier is read from the text, as before.');
  assert.equal(route({ text: 'Fix the typo', tier: 'deep', mode: 'balanced', candidates: agents(), current: 'claude' }).reason, 'A complex step, as planned');

  const plans = mode => { const { provider, model, effort, reason, escalation } = planner({ text: 'Fix the typo in the README', mode, candidates: agents(), current: 'claude' }); return [provider, model, effort, reason, escalation]; };
  assert.deepEqual(plans('balanced'), ['claude', 'opus', 'high', 'Plans the steps', null]);
  assert.deepEqual(plans('quality'), ['claude', 'opus', 'max', 'Plans the steps', null]);
  assert.deepEqual(plans('saving'), ['claude', 'sonnet', 'medium', 'Plans the steps', null], 'Cost saving plans with a standard model, not its lightest: a weak plan costs more runs than it saves.');
  // The planner follows the same allowance rules as any message.
  assert.equal(planner({ text: 'Plan it', mode: 'balanced', candidates: agents({ claude: { usedPercent: 96 } }), current: 'claude' }).provider, 'codex');
  // With no agent allowed, the planner gets the same answer as any message.
  const none = { text: 'Plan it', mode: 'balanced', candidates: agents({ claude: { eligible: false }, codex: { eligible: false } }) };
  assert.match(planner(none).error, /no connected agent/);
  assert.deepEqual(planner(none), route({ ...none, tier: 'deep' }));
});

test('Auto keeps the agent that did the last run, moves away from one near its limit, and only uses API billing when allowed', () => {
  const text = 'Add a loading spinner to the checkout button';
  assert.equal(route({ text, mode: 'balanced', candidates: agents(), current: 'codex' }).provider, 'codex', 'The conversation keeps its agent.');
  const busy = route({ text, mode: 'balanced', candidates: agents({ codex: { usedPercent: 85 } }), current: 'codex' });
  assert.equal(busy.provider, 'claude'); assert.match(busy.reason, /Codex is at 85% of its limit/);
  assert.equal(route({ text, mode: 'quality', candidates: agents({ codex: { usedPercent: 85 } }), current: 'codex' }).provider, 'codex', 'Maximum quality stays until 90%.');
  assert.equal(route({ text, mode: 'saving', candidates: agents({ codex: { usedPercent: 60 } }), current: 'codex' }).provider, 'claude', 'Cost saving goes where the most allowance is left.');
  assert.equal(route({ text, mode: 'quality', candidates: agents({ codex: { usedPercent: 96 } }), current: 'codex' }).provider, 'claude', 'An agent at 95% is never chosen.');

  const api = agents({ claude: { billingSource: 'api' }, codex: { eligible: false } });
  const refused = route({ text, mode: 'balanced', candidates: api, current: 'claude' });
  assert.match(refused.error, /no connected agent within your rules \(Claude isn’t billed to a subscription\)/);
  assert.equal(route({ text, mode: 'balanced', candidates: api, current: 'claude', allowApi: true }).provider, 'claude');
  assert.match(route({ text, mode: 'balanced', candidates: agents({ claude: { billingSource: 'unknown' } }), current: 'claude' }).reason, /Claude isn’t available under your rules/, 'Unknown billing is not treated as free.');
});

test('a retry after failed tests goes one step up with the same agent: a stronger model, or more effort on the strongest', () => {
  const step = (provider, model, effort) => { const next = escalate(provider, models[provider], { model, effort }); return next && [next.provider, next.model, next.effort, next.tier]; };
  assert.deepEqual(step('claude', 'sonnet', 'medium'), ['claude', 'opus', 'high', 'deep']);
  assert.deepEqual(step('claude', 'haiku', null), ['claude', 'sonnet', 'medium', 'standard'], 'A light model steps up to the standard one.');
  assert.deepEqual(step('claude', 'opus', 'high'), ['claude', 'opus', 'max', 'deep'], 'The strongest model gets more effort.');
  assert.equal(step('claude', 'opus', 'max'), null, 'Nothing is stronger than the strongest model at its highest effort.');
  assert.deepEqual(step('codex', 'gpt-codex-mini', 'low'), ['codex', 'gpt-codex', 'medium', 'standard']);
  assert.deepEqual(step('codex', 'gpt-codex', 'high'), ['codex', 'gpt-codex', 'xhigh', 'standard'], 'Without a deeper Codex model, more effort.');
  assert.equal(escalate('claude', [], { model: null, effort: null }), null, 'Without a model list there is nothing to step up to.');
  assert.deepEqual(route({ text: 'Add a loading spinner to the checkout button', mode: 'balanced', candidates: agents(), current: 'claude' }).escalation, { provider: 'claude', model: 'opus', modelName: 'Opus', effort: 'high', tier: 'deep' }, 'Each choice carries its step up.');
});

test('routing evaluates the chosen model against every applicable quota window before choosing its agent', () => {
  const usage = windows => ({ available: true, checkedAt: new Date().toISOString(), windows });
  const candidates = agents({ claude: { usage: usage([{ label: '5-hour', usedPercent: 5 }, { label: 'Opus weekly', scopes: ['opus'], usedPercent: 100 }]) } });
  const deep = route({ text: 'Refactor the payment module', current: 'claude', candidates });
  assert.equal(deep.provider, 'codex', 'A fresh five-hour window cannot hide the chosen Opus model’s weekly exhaustion.');
  const light = route({ text: 'Fix the typo', current: 'claude', candidates });
  assert.equal(light.model, 'haiku', 'Opus exhaustion does not block Haiku.');
  const onlyClaude = route({ text: 'Refactor the payment module', current: 'claude', candidates: candidates.filter(row => row.provider === 'claude') });
  assert(onlyClaude.error, 'Do not pick Haiku for deep work merely to escape Opus’s limit.');
  const allowed = route({ text: 'Fix the typo', current: 'claude', candidates: agents({ claude: { allowedModels: ['sonnet'] } }) });
  assert.equal(allowed.model, 'sonnet', 'Model restrictions are applied before selection, not only when starting.');
});

test('unknown and stale readings are not capacity, and matching model groups and observation times are preserved', () => {
  const now = Date.now(), fresh = { available: true, checkedAt: new Date(now).toISOString(), windows: [{ id: 'week', label: 'Weekly', scopes: ['opus', 'sonnet'], usedPercent: 100 }, { label: '5-hour', usedPercent: 5 }] };
  const assess = globalThis.relayRouting.assessQuota;
  assert.equal(assess(fresh, 'opus', { now }).state, 'exhausted');
  assert.equal(assess(fresh, 'haiku', { now }).state, 'ok');
  assert.deepEqual(assess(fresh, 'opus', { now }).windows[0].scopes, ['opus', 'sonnet']);
  assert.equal(assess({ ...fresh, windows: [{ usedPercent: 0 }] }, 'opus', { now: now + 3600000 }).state, 'stale');
  assert.equal(assess({ ...fresh, checkedAt: new Date(now - 3600000).toISOString(), fetchedAt: now, windows: [{ usedPercent: 0 }] }, 'opus', { now }).state, 'stale', 'Loading an old server result into the UI cache does not make its observation fresh.');
  assert.equal(assess({ available: true, windows: [{ usedPercent: 0 }] }, 'opus', { now }).state, 'unknown');
  assert.equal(assess({ ...fresh, windows: [{ usedPercent: 100, disabled: true }, { usedPercent: 10 }] }, 'opus', { now }).state, 'ok');
  assert.equal(assess(fresh, null, { now }).state, 'unknown', 'An unresolved default cannot claim a model-scoped allowance.');
  const choice = route({ text: 'Add a test', current: 'codex', candidates: agents({ codex: { usage: { available: false } } }) });
  assert.equal(choice.provider, 'claude', 'Known allowance is preferred to an unknown current account.');
  const unknown = route({ text: 'Add a test', current: 'codex', candidates: agents({ codex: { usage: { available: false } }, claude: { usage: { available: false } } }) });
  assert.equal(unknown.provider, 'codex');
  assert.match(globalThis.relayRouting.quotaText(unknown.quota), /Plan usage unknown/);
  assert.equal(unknown.quota.usedPercent, null);
});

test('a fresh backend reading can stop a routed dispatch before any agent starts, and its evidence survives replay', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-routing-quota-')), workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, '.mock-scenarios.json'), '{}');
  const bin = path.join(root, 'codex.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  const broker = new Broker({ workspace, dataDir, bins: { codex: bin } });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id); let reads = 0;
  broker.checks.usage = async (_provider, options) => { reads++; assert.equal(options.refresh, true); return { available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 5 }, { label: 'Weekly', scopes: ['gpt-codex'], usedPercent: 100 }] }; };
  broker.start(c, { text: 'Add a test', provider: 'codex', model: 'gpt-codex', routing: { mode: 'balanced', reason: 'A focused change' } });
  await broker.running.done;
  assert.equal(reads, 1);
  assert.equal(fs.existsSync(path.join(workspace, '.mock-captures.jsonl')), false);
  assert.equal(c.lastRun.routingQuota.state, 'exhausted');
  assert.equal(c.runs[0].routingQuota.windows[1].label, 'Weekly');
  assert.match(c.messages.at(-1).text, /Routing paused before starting/);
  const replay = new Broker({ workspace, dataDir, bins: { codex: bin } });
  try { assert.deepEqual(replay.get(c.id).lastRun.routingQuota, c.lastRun.routingQuota); }
  finally { await replay.close(); }
});

test('quota observations keep model groups, real observation times and refreshes without assigning unknown times', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-routing-observation-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: path.join(root, 'missing') } });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id), began = Date.now() - 120000, windows = [{ label: 'Weekly models', scopes: ['opus', 'sonnet'], usedPercent: 20 }];
  const usage = { available: true, checkedAt: new Date(began).toISOString(), windows };
  broker.observeQuota(c, 'claude', usage);
  broker.observeQuota(c, 'claude', usage);
  assert.equal((await broker.ledger(c)).quotaObservations.length, 1);
  broker.observeQuota(c, 'claude', { ...usage, checkedAt: new Date(began + 61000).toISOString() });
  const saved = (await broker.ledger(c)).quotaObservations;
  assert.equal(saved.length, 2, 'A new observation updates freshness even when the percentage did not change.');
  assert.deepEqual(saved[1].windows[0].scopes, ['opus', 'sonnet']);
  assert.equal(saved[1].observedAt, new Date(began + 61000).toISOString());
  broker.observeQuota(c, 'codex', { available: true, windows: [{ label: '5-hour', usedPercent: 10 }] });
  assert.equal((await broker.ledger(c)).quotaObservations.at(-1).observedAt, null);
});

test('the broker saves the Auto mode with the workspace and records what Auto chose with the run and its prompt', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-routing-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const bin = path.join(root, 'codex.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  let broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin } });
  broker.checks.usage = async () => ({ available: false });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  assert.throws(() => broker.setRouting(c, { mode: 'fastest' }), /Cost saving, Balanced or Maximum quality/);
  broker.setRouting(c, { mode: 'saving', allowApi: true });
  await assert.rejects(async () => broker.start(c, { text: 'Hello', provider: 'codex', routing: { mode: 'cheap' } }), /Invalid automatic agent choice/);
  broker.start(c, { text: 'Fix the typo in the README', provider: 'codex', model: 'gpt-codex-mini', effort: 'low', routing: { mode: 'saving', reason: 'A small, well-defined change', tier: 'light', extra: 'ignored' } });
  await broker.running.done;
  const prompt = c.messages.find(message => message.role === 'user');
  assert.deepEqual(prompt.routing, { mode: 'saving', reason: 'A small, well-defined change', tier: 'light', model: 'gpt-codex-mini', effort: 'low' });
  assert.deepEqual(c.lastRun.routing, { mode: 'saving', reason: 'A small, well-defined change', tier: 'light' });
  broker.queueAction(c, { action: 'pause' });
  broker.queueAction(c, { action: 'add', text: 'Then update the changelog', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', routing: { mode: 'saving', reason: 'A small, well-defined change', tier: 'light' } });
  assert.equal(c.queue[0].routing.mode, 'saving', 'A queued prompt keeps the choice shown when it was queued.');
  await broker.close();
  broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin } });
  broker.checks.usage = async () => ({ available: false });
  assert.deepEqual(broker.get(c.id).routing, { mode: 'saving', allowApi: true, check: false }, 'The mode survives a restart.');
  broker.setRouting(broker.get(c.id), { mode: null });
  assert.equal(broker.get(c.id).routing, null);
});

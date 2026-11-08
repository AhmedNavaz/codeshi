import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import '../public/routing.js';
import { Broker } from '../src/broker.mjs';

const { classify, modelTier, route, escalate, triage, replay } = globalThis.relayRouting;
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

test('Send settles only a bare go-ahead on its own: anything that needs judging goes to an agent', () => {
  const deep = { tier: 'deep', effort: 'high' }, standard = { tier: 'standard', effort: 'medium' };
  for (const text of ['yes', 'Yes, do it', 'okay do it then', 'Do it', 'continue', 'go ahead please', 'OK, proceed.', 'fix it']) assert.deepEqual(triage(text, { previous: deep }), { tier: 'deep', effort: 'high', reason: 'Continuing the same task', source: 'local' }, text);
  assert.equal(triage('continue', { previous: standard }).tier, 'standard');
  // Words that merely sound like a go-ahead, and a go-ahead with more in it.
  for (const text of ['ok', 'thanks', 'great', 'yes but also add a test', 'continue with the migration', 'now do #92, #93, #94', 'okay then go ahead with firebase approach now', 'fix the login bug', 'why?', '']) assert.equal(triage(text, { previous: deep }), null, text);
  assert.equal(triage('do it', {}), null, 'There is nothing to carry on.');
  assert.equal(triage('do it', { previous: { tier: 'light', effort: 'low' } }), null, 'What it approves may be bigger than the light work before it.');
  assert.equal(triage('do it', { previous: deep, attachments: 1 }), null, 'An attachment may change the task.');
});

test('a model named for neither end is placed by its catalog description, and this reaches the light choice', () => {
  const catalog = [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', isDefault: true, supportedReasoningEfforts: levels('low', 'medium', 'high') },
    { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', supportedReasoningEfforts: levels('low', 'medium', 'high') },
    { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', supportedReasoningEfforts: levels('low', 'medium') },
    { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', description: 'Older fast and efficient model.', supportedReasoningEfforts: levels('low') },
  ];
  assert.deepEqual(catalog.map(modelTier), ['standard', 'standard', 'light', 'light']);
  assert.equal(modelTier({ id: 'sonnet', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' }), 'standard', 'Efficient is not the same as small.');
  assert.equal(modelTier({ id: 'opus', displayName: 'Opus 5.5', description: 'Fast for its size' }), 'deep', 'A name that says what it is wins.');
  const pick = tier => route({ text: 'x', assessment: { tier, effort: 'low', reason: 'rated' }, mode: 'smart', candidates: [{ provider: 'codex', eligible: true, billingSource: 'subscription', models: catalog, usage: { available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 10 }] } }] }).model;
  assert.equal(pick('light'), 'gpt-6-luna'); assert.equal(pick('standard'), 'gpt-6.1-sol'); assert.equal(pick('deep'), 'gpt-6.1-sol', 'Stronger models stay as they were.');
});

test('Smart, Saver and Ultra match the model and effort to the task, within the levels each model supports', () => {
  const pick = (text, mode, current = 'claude') => { const { provider, model, effort } = route({ text, mode, candidates: agents(), current }); return [provider, model, effort]; };
  assert.deepEqual(pick('Fix the typo in the README', 'smart'), ['claude', 'haiku', null], 'Haiku reports no effort levels, so the agent decides.');
  assert.deepEqual(pick('Add a loading spinner to the checkout button', 'smart'), ['claude', 'sonnet', 'medium']);
  assert.deepEqual(pick('Refactor the payment module', 'smart'), ['claude', 'opus', 'high']);
  assert.deepEqual(pick('Fix the typo in the README', 'ultra'), ['claude', 'opus', 'high'], 'Ultra starts with the strongest models first.');
  assert.deepEqual(pick('Add a loading spinner to the checkout button', 'ultra'), ['claude', 'opus', 'high']);
  assert.deepEqual(pick('Refactor the payment module', 'ultra'), ['claude', 'opus', 'max'], 'Ultra takes the highest level for complex work.');
  assert.deepEqual(pick('Refactor the payment module', 'saver'), ['claude', 'sonnet', 'low'], 'Saver uses light and standard models at low effort.');
  assert.deepEqual(pick('Add a loading spinner to the checkout button', 'saver'), ['claude', 'sonnet', 'low']);
  assert.deepEqual(pick('Add a loading spinner to the checkout button', 'ultra', 'codex'), ['codex', 'gpt-codex', 'high'], 'Without a deeper Codex model, the default with more effort.');
  assert.deepEqual(pick('Fix the typo in the README', 'saver', 'codex'), ['codex', 'gpt-codex-mini', 'low']);
  // Saved conversations with legacy mode IDs map cleanly to Saver, Smart and Ultra.
  assert.equal(route({ text: 'Refactor the payment module', mode: 'saving', candidates: agents(), current: 'claude' }).mode, 'saver');
  assert.equal(route({ text: 'Refactor the payment module', mode: 'balanced', candidates: agents(), current: 'claude' }).mode, 'smart');
  assert.equal(route({ text: 'Refactor the payment module', mode: 'quality', candidates: agents(), current: 'claude' }).mode, 'ultra');
  const routed = route({ text: 'Refactor the payment module', mode: 'smart', candidates: agents(), current: 'claude' });
  assert.equal(routed.reason, 'A complex task (refactoring)'); assert.equal(routed.modelName, 'Opus');
  assert.deepEqual(route({ text: 'Add a test', mode: 'smart', candidates: agents({ claude: { models: [] } }), current: 'claude' }).model, null, 'Without a model list, the agent’s default.');
});

test('short follow-ups inherit task difficulty for the estimate, and assessed meaning overrides keyword guesses', () => {
  assert.equal(classify('Do it', { context: 'Refactor the worker pool to avoid deadlocks.' }).tier, 'deep');
  assert.equal(classify('Fix a typo', { context: 'Refactor the worker pool to avoid deadlocks.' }).tier, 'light', 'A separate small edit stays small.');
  const choice = route({ text: 'Rename the variable', assessment: { tier: 'deep', effort: 'high', reason: 'The name is part of a public serialization contract.' }, candidates: agents(), current: 'claude' });
  assert.equal(choice.model, 'opus'); assert.equal(choice.effort, 'high'); assert.match(choice.reason, /serialization contract/);
});

test('allowance is spent where it resets soonest, without masking weekly exhaustion or assuming a reset happened', () => {
  const now = Date.parse('2026-11-08T12:00:00Z'); // Sunday noon UTC -> Monday is +18h, Friday is +114h
  const reading = (hours, weeklyUsed = 30, shortHours = hours) => ({ available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: '5-hour', usedPercent: 10, resetsAt: new Date(now + shortHours * 3600000).toISOString() }, { label: 'Weekly', usedPercent: weeklyUsed, resetsAt: new Date(now + hours * 3600000).toISOString() }] });
  const candidates = agents({ codex: { usage: reading(150) }, claude: { usage: reading(0.1) } });
  const chosen = route({ text: 'Add a button', candidates, current: 'codex', now });
  assert.equal(chosen.provider, 'claude'); assert.match(chosen.reason, /resets sooner/);
  // Claude with 19% of its week left resetting Monday is chosen before Codex with 23% left that must last until Friday.
  const weekChoice = route({
    text: 'Add a button',
    now,
    current: 'codex',
    candidates: agents({
      codex: { usage: { available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: 'Weekly', usedPercent: 77, resetsAt: new Date(now + 114 * 3600000).toISOString() }] } },
      claude: { usage: { available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: 'Weekly', usedPercent: 81, resetsAt: new Date(now + 18 * 3600000).toISOString() }] } },
    }),
  });
  assert.equal(weekChoice.provider, 'claude');
  assert.match(weekChoice.reason, /Claude has 19% of its week left and resets Monday; Codex is kept for later in the week/);
  candidates[1].usage = reading(150, 30, 0.1);
  assert.equal(route({ text: 'Add a button', candidates, current: 'codex', now }).provider, 'codex', 'An early five-hour reset cannot outweigh the tighter weekly window.');
  candidates[1].usage = reading(0.1, 100);
  assert.equal(route({ text: 'Add a button', candidates, current: 'codex', now }).provider, 'codex', 'Even an imminent reset does not make exhausted usage available.');
  candidates[1].usage = reading(-0.1, 30);
  assert.equal(route({ text: 'Add a button', candidates, current: 'codex', now }).provider, 'codex', 'A passed reset requires a fresh observation.');
});

test('Auto keeps the agent that did the last run while continuity is worth its price, moves away when tight, and only uses API billing when allowed', () => {
  const text = 'Add a loading spinner to the checkout button';
  assert.equal(route({ text, mode: 'smart', candidates: agents(), current: 'codex' }).provider, 'codex', 'The conversation keeps its agent.');
  assert.equal(route({ text, mode: 'smart', candidates: agents({ codex: { usedPercent: 30 } }), current: 'codex' }).provider, 'codex', 'Continuity keeps the current agent across small differences.');
  const busy = route({ text, mode: 'smart', candidates: agents({ codex: { usedPercent: 85 } }), current: 'codex' });
  assert.equal(busy.provider, 'claude'); assert.match(busy.reason, /Codex is at 85% of its limit/);
  assert.equal(route({ text, mode: 'saver', candidates: agents({ codex: { usedPercent: 60 } }), current: 'codex' }).provider, 'claude', 'Continuity has a price at Send when another agent has much more allowance left.');
  assert.equal(route({ text, mode: 'ultra', candidates: agents({ codex: { usedPercent: 96 } }), current: 'codex' }).provider, 'claude', 'An agent at 95% is never chosen.');

  const api = agents({ claude: { billingSource: 'api' }, codex: { eligible: false } });
  const refused = route({ text, mode: 'smart', candidates: api, current: 'claude' });
  assert.match(refused.error, /no connected agent within your rules \(Claude isn’t billed to a subscription\)/);
  assert.equal(route({ text, mode: 'smart', candidates: api, current: 'claude', allowApi: true }).provider, 'claude');
  assert.match(route({ text, mode: 'smart', candidates: agents({ claude: { billingSource: 'unknown' } }), current: 'claude' }).reason, /Claude isn’t available under your rules/, 'Unknown billing is not treated as free.');
});

test('before a standard or deep task starts, usual run spend is compared with the binding window', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const text = 'Refactor the payment module';
  // Codex has 12% left (with 4h to reset) and usually spends 20% on a deep run -> selects Claude instead.
  const switched = route({
    text,
    mode: 'smart',
    now,
    current: 'codex',
    candidates: agents({
      codex: { usualSpend: { short: 20 }, usage: { available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: '5-hour', usedPercent: 88, resetsAt: new Date(now + 4 * 3600000).toISOString() }] } },
      claude: { usualSpend: { short: 15 }, usage: { available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: '5-hour', usedPercent: 30, resetsAt: new Date(now + 4 * 3600000).toISOString() }] } },
    }),
  });
  assert.equal(switched.provider, 'claude');
  assert.match(switched.reason, /Codex has 12% left and usually spends ~20% on a deep run/);

  // When the current agent's window resets soon (within the hour), it can start with a handoff planned.
  const planned = route({
    text,
    mode: 'smart',
    now,
    current: 'codex',
    candidates: agents({
      codex: { usualSpend: { short: 20 }, usage: { available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: '5-hour', usedPercent: 88, resetsAt: new Date(now + 1800000).toISOString() }] } },
      claude: { eligible: false },
    }),
  });
  assert.equal(planned.provider, 'codex');
  assert.equal(planned.plannedHandoff, true);
  assert.match(planned.reason, /handoff is planned/);
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
  assert.deepEqual(route({ text: 'Add a loading spinner to the checkout button', mode: 'smart', candidates: agents(), current: 'claude' }).escalation, { provider: 'claude', model: 'opus', modelName: 'Opus', effort: 'high', tier: 'deep' }, 'Each choice carries its step up.');
});

test('weekly and model-specific windows count separately: an exhausted Opus window steps down to Sonnet when needed, never Haiku for deep work', () => {
  const usage = windows => ({ available: true, checkedAt: new Date().toISOString(), windows });
  const candidates = agents({ claude: { usage: usage([{ label: '5-hour', usedPercent: 5 }, { label: 'Opus weekly', scopes: ['opus'], usedPercent: 100 }]) } });
  const deep = route({ text: 'Refactor the payment module', current: 'claude', candidates });
  assert.equal(deep.provider, 'codex', 'When another agent has full-tier room, it is chosen over stepping down.');
  const light = route({ text: 'Fix the typo', current: 'claude', candidates });
  assert.equal(light.model, 'haiku', 'Opus exhaustion does not block Haiku.');
  const onlyClaude = route({ text: 'Refactor the payment module', mode: 'ultra', current: 'claude', candidates: candidates.filter(row => row.provider === 'claude') });
  assert.equal(onlyClaude.model, 'sonnet', 'An exhausted Opus weekly window leaves Claude usable at the next tier down.');
  assert.equal(onlyClaude.steppedDown, true);
  assert.match(onlyClaude.reason, /Opus has no usable allowance.*stepping down one tier to Sonnet/);
  const haikuOnlyClaude = route({ text: 'Refactor the payment module', current: 'claude', candidates: [{ ...candidates[1], models: models.claude.filter(row => row.id !== 'sonnet') }] });
  assert(haikuOnlyClaude.error, 'Do not pick Haiku for deep work merely to escape Opus’s limit.');
  const allowed = route({ text: 'Fix the typo', current: 'claude', candidates: agents({ claude: { allowedModels: ['sonnet'] } }) });
  assert.equal(allowed.model, 'sonnet', 'Model restrictions are applied before selection, not only when starting.');
});

test('replay compares Smart, Saver and Ultra across a prompt sequence with recorded usage readings', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const candidates = agents({
    codex: { usage: { available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: '5-hour', usedPercent: 20, resetsAt: new Date(now + 2 * 3600000).toISOString() }, { label: 'Weekly', usedPercent: 40, resetsAt: new Date(now + 96 * 3600000).toISOString() }] } },
    claude: { usage: { available: true, checkedAt: new Date(now).toISOString(), windows: [{ label: '5-hour', usedPercent: 15, resetsAt: new Date(now + 4 * 3600000).toISOString() }, { label: 'Weekly', usedPercent: 25, resetsAt: new Date(now + 24 * 3600000).toISOString() }] } },
  });
  const prompts = [
    'Fix the typo in the README',
    'Add a loading spinner to the checkout button',
    'Yes, do it',
    'Refactor the payment module into separate services',
  ];
  const compared = replay(prompts, { candidates, current: 'claude', now });
  assert.equal(compared.saver.assessmentCalls, 0, 'Saver makes no agent assessment calls on Send.');
  assert.equal(compared.smart.assessmentCalls, 3, 'Bare go-ahead after standard work is settled locally.');
  assert.equal(compared.ultra.assessmentCalls, 3);
  assert.equal(compared.saver.choices[0].model, 'haiku');
  assert.equal(compared.ultra.choices[0].model, 'opus');
  assert(compared.saver.remaining.claude['Weekly'] > compared.ultra.remaining.claude['Weekly'], 'Saver leaves more weekly allowance at the end of the sequence.');
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
  broker.execution.setDefault(c, { mode: 'flow' });
  broker.start(c, { text: 'Add a test', provider: 'codex', model: 'gpt-codex', routing: { mode: 'smart', reason: 'A focused change' } });
  await broker.running.done;
  assert.equal(reads, 1);
  assert.equal(fs.existsSync(path.join(workspace, '.mock-captures.jsonl')), false);
  assert.equal(c.lastRun.routingQuota.state, 'exhausted');
  assert.equal(c.lastRun.routingQuota.windows[1].label, 'Weekly');
  assert.match(c.messages.at(-1).text, /Routing paused before starting/);
  const replayBroker = new Broker({ workspace, dataDir, bins: { codex: bin } });
  try { assert.deepEqual(replayBroker.get(c.id).lastRun.routingQuota, c.lastRun.routingQuota); }
  finally { await replayBroker.close(); }
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
  assert.throws(() => broker.setRouting(c, { mode: 'fastest' }), /Choose Smart, Saver or Ultra/);
  broker.setRouting(c, { mode: 'saving', allowApi: true });
  assert.equal(c.routing.mode, 'saver', 'Legacy mode IDs normalize to Saver, Smart and Ultra.');
  await assert.rejects(async () => broker.start(c, { text: 'Hello', provider: 'codex', routing: { mode: 'cheap' } }), /Invalid automatic agent choice/);
  broker.start(c, { text: 'Fix the typo in the README', provider: 'codex', model: 'gpt-codex-mini', effort: 'low', routing: { mode: 'saver', reason: 'A small, well-defined change', tier: 'light', extra: 'ignored' } });
  await broker.running.done;
  const prompt = c.messages.find(message => message.role === 'user');
  assert.deepEqual(prompt.routing, { mode: 'saver', reason: 'A small, well-defined change', tier: 'light', model: 'gpt-codex-mini', effort: 'low' });
  assert.deepEqual(c.lastRun.routing, { mode: 'saver', reason: 'A small, well-defined change', tier: 'light' });
  broker.queueAction(c, { action: 'pause' });
  broker.queueAction(c, { action: 'add', text: 'Then update the changelog', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', routing: { mode: 'saver', reason: 'A small, well-defined change', tier: 'light' } });
  assert.equal(c.queue[0].routing.mode, 'saver', 'A queued prompt keeps the choice shown when it was queued.');
  await broker.close();
  broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin } });
  broker.checks.usage = async () => ({ available: false });
  assert.deepEqual(broker.get(c.id).routing, { mode: 'saver', allowApi: true, check: false }, 'The mode survives a restart.');
  broker.setRouting(broker.get(c.id), { mode: null });
  assert.equal(broker.get(c.id).routing, null);
});

test('adaptive quota thresholds: weekly windows expand headroom up to 97-98% based on remaining allowance and reset cadence (#135)', () => {
  const { adaptiveThreshold, assessQuota } = globalThis.relayRouting;
  const now = Date.parse('2026-11-08T12:00:00Z');
  // 5-hour window with 4 hours left: does not arbitrarily bump above baseThreshold (90%)
  const fiveHourRow = { label: '5-hour', period: '5-hour', usedPercent: 92, resetsAt: new Date(now + 4 * 3600000).toISOString() };
  assert.equal(adaptiveThreshold(fiveHourRow, 90, { now, tier: 'standard' }), 90);

  // 5-hour window with imminent reset (< 30 min): expands threshold to allow finishing
  const imminentFiveHour = { label: '5-hour', period: '5-hour', usedPercent: 92, resetsAt: new Date(now + 15 * 60000).toISOString() };
  assert(adaptiveThreshold(imminentFiveHour, 90, { now, tier: 'standard' }) > 90);

  // Weekly window (periodHours >= 168) with 91% used (9% left) and 18h left out of 168h:
  // Favorable reset cadence expands effective threshold to >= 95%
  const weeklyRow = { label: 'Weekly', period: 'Weekly', usedPercent: 91, resetsAt: new Date(now + 18 * 3600000).toISOString() };
  const adapted = adaptiveThreshold(weeklyRow, 90, { now, tier: 'standard' });
  assert(adapted >= 95, `Expected adapted threshold >= 95, got ${adapted}`);

  // assessQuota uses adaptive threshold for weekly window: 91% used is ok when threshold adapted to >= 95%
  const quota = assessQuota({ available: true, checkedAt: new Date(now).toISOString(), windows: [weeklyRow] }, null, { threshold: 90, now, tier: 'standard' });
  assert.equal(quota.state, 'ok', 'Weekly capacity remains spendable rather than hard-failing at static 90%');
});

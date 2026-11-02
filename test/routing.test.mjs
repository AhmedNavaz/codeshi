import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import '../public/routing.js';
import { Broker } from '../src/broker.mjs';

const { classify, modelTier, route } = globalThis.relayRouting;
const levels = (...values) => values.map(reasoningEffort => ({ reasoningEffort }));
const models = {
  codex: [{ id: 'gpt-codex', displayName: 'GPT Codex', isDefault: true, supportedReasoningEfforts: levels('low', 'medium', 'high', 'xhigh') }, { id: 'gpt-codex-mini', displayName: 'GPT Codex Mini', supportedReasoningEfforts: levels('low', 'medium') }],
  claude: [{ value: 'default', id: 'default', displayName: 'Default' }, { id: 'haiku', displayName: 'Haiku' }, { id: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium', 'high'] }, { id: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }],
};
const agents = (overrides = {}) => ['codex', 'claude'].map(provider => ({ provider, eligible: true, billingSource: 'subscription', usedPercent: 20, models: models[provider], ...overrides[provider] }));

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

test('the broker saves the Auto mode with the workspace and records what Auto chose with the run and its prompt', { skip: scriptCLIs }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-routing-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const bin = path.join(root, 'codex.mjs'); fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  let broker = new Broker({ workspace, dataDir: path.join(root, 'data'), bins: { codex: bin } });
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
  assert.deepEqual(broker.get(c.id).routing, { mode: 'saving', allowApi: true }, 'The mode survives a restart.');
  broker.setRouting(broker.get(c.id), { mode: null });
  assert.equal(broker.get(c.id).routing, null);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8');

test('phone runSheet leaves model and effort usable while running, and queueSheet displays and edits model and effort', async () => {
  const block = source.slice(source.indexOf('  let showAllModels = false;'), source.indexOf('  // ---- Drawing.'));
  const requests = [];
  let sheetDrawn = 0;
  const S = {
    settings: { provider: 'codex', model: 'codex-mini', effort: 'low', mode: 'edit', approvalPolicy: 'ask' },
    models: {
      codex: {
        rows: [
          { id: 'codex-mini', name: 'Codex Mini', supportedEffortLevels: ['low', 'medium'] },
          { id: 'codex-max', name: 'Codex Max', supportedEffortLevels: ['low', 'medium', 'high'] },
        ],
      },
    },
    providers: { codex: { available: true } },
    accounts: { codex: { authenticated: true, billingSource: 'subscription' } },
    usage: { codex: { available: false } },
    c: {
      id: 'test-c',
      queue: [
        { id: 'q1', text: 'Queue item text', provider: 'codex', model: 'codex-mini', effort: 'low', mode: 'edit', approvalPolicy: 'ask' },
      ],
      queuePaused: null,
    },
  };

  const context = {
    S,
    AGENTS: ['codex', 'claude', 'gemini'],
    EFFORT_NAMES: { low: 'Low', medium: 'Medium', high: 'High' },
    isRunning: () => true,
    routing: () => null,
    name: p => p[0].toUpperCase() + p.slice(1),
    modelRows: provider => S.models[provider]?.rows || [],
    effortsOf: row => row?.supportedEffortLevels || [],
    modelName: row => row.displayName || row.name || row.id || 'Default',
    modelId: row => row.id || '',
    available: p => true,
    signedOut: p => false,
    charged: p => false,
    usedPercent: () => null,
    glyph: () => ({ tag: 'i' }),
    icon: name => ({ tag: 'svg', icon: name }),
    loadModels: () => {},
    changeSettings: patch => Object.assign(S.settings, patch),
    setRouting: () => {},
    segmented: (label, options, current, onChange, disabled) => ({ tag: 'segmented', label, options, current, onChange, disabled }),
    node: (tag, cls = '', text = '') => {
      const el = { tag, cls, text, children: [], attributes: {}, append(...items) { el.children.push(...items); }, setAttribute(k, v) { el.attributes[k] = v; }, replaceChildren(...items) { el.children = items; }, addEventListener(n, fn) { (el.listeners ||= {})[n] = fn; } };
      return el;
    },
    button: (label, onClick, cls = '') => {
      const btn = { tag: 'button', label, onClick, cls, children: [], attributes: {}, append(...items) { btn.children.push(...items); }, setAttribute(k, v) { btn.attributes[k] = v; } };
      return btn;
    },
    openSheet: () => {},
    closeSheet: () => {},
    drawSheet: () => { sheetDrawn++; },
    refreshConversation: async () => {},
    attempt: fn => fn(),
    endpoint: name => `/api/conversations/test-c/${name}`,
    api: async (path, options) => { requests.push({ path, body: options.body }); return {}; },
    $: () => ({ addEventListener: () => {} }),
  };

  const exports = vm.runInNewContext(`${block}
({ runSheet, queueSheet })`, context);

  // 1. Check runSheet while running
  const runHost = context.node('div');
  exports.runSheet(runHost);

  // Model choice buttons must not be disabled
  const modelChoices = runHost.children.flatMap(c => c.children || []).filter(c => c.cls === 'row row-model');
  assert.equal(modelChoices.length, 3);
  for (const choice of modelChoices) assert.equal(Boolean(choice.disabled), false, 'Model choice is enabled while running');

  // Effort segmented control must not be disabled
  const effortControl = runHost.children.find(c => c.tag === 'segmented' && c.label === 'Effort');
  assert(effortControl, 'Effort control exists');
  assert.equal(effortControl.disabled, undefined, 'Effort control is not disabled while running');

  // 2. Check queueSheet display
  const queueHost = context.node('div');
  exports.queueSheet(queueHost);

  const row = queueHost.children.find(c => c.cls === 'queue-row');
  assert(row, 'Queue row exists');
  const smallMeta = row.children[0].children.find(c => c.tag === 'small');
  assert.match(smallMeta.text, /Codex · Codex Mini · low effort/);

  // Edit button exists
  const editBtn = row.children.find(c => c.attributes?.['aria-label']?.startsWith('Edit queued message'));
  assert(editBtn, 'Edit button exists on queue row');

  // Click edit button
  editBtn.onClick();
  assert.equal(sheetDrawn, 1);

  // Render queueSheet again in editing mode
  const editHost = context.node('div');
  exports.queueSheet(editHost);
  const editRow = editHost.children.find(c => c.cls === 'queue-row');
  const form = editRow.children.find(c => c.cls === 'queue-edit-form');
  assert(form, 'Edit form rendered in queueSheet');

  const textarea = form.children.find(c => c.cls === 'queue-edit-input');
  assert.equal(textarea.value, 'Queue item text');
  textarea.value = 'Updated text from phone';

  const controls = form.children.find(c => c.cls === 'queue-edit-controls');
  const mSelect = controls.children.find(c => c.cls?.includes('queue-model-select'));
  const eSelect = controls.children.find(c => c.cls?.includes('queue-effort-select'));
  assert.equal(mSelect.value, 'codex-mini');
  assert.equal(eSelect.value, 'low');

  // Change model to codex-max
  mSelect.value = 'codex-max';
  // Trigger updateEfforts via event or onChange simulation
  eSelect.value = 'high';

  const actions = form.children.find(c => c.cls === 'queue-edit-actions');
  const saveBtn = actions.children.find(c => c.label === 'Save');
  assert(saveBtn, 'Save button exists');

  await saveBtn.onClick();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body)), {
    action: 'update',
    id: 'q1',
    text: 'Updated text from phone',
    model: 'codex-max',
    effort: 'high',
  });
});

test('phone Normal reset waits name only the task agent; Flow can compare connected agents', async () => {
  const block = source.slice(source.indexOf('  async function waitForReset()'), source.indexOf('  function renderDock()'));
  for (const delegated of [false, true]) {
    let sent;
    const context = { S: { c: { lastRun: { provider: 'codex' }, execution: { active: { automation: { wait: delegated } } } }, settings: { provider: 'claude', mode: 'edit', approvalPolicy: 'ask' } }, AGENTS: ['codex', 'claude'], available: () => true, signedOut: () => false, endpoint: value => value, api: async (_path, input) => { sent = input.body; }, refreshConversation: async () => {} };
    vm.createContext(context); await vm.runInContext(block + '\nwaitForReset();', context);
    assert.deepEqual([...sent.providers], delegated ? ['codex', 'claude'] : ['codex']);
    assert.equal(sent.approvalPolicy, 'ask'); assert.equal(sent.billingConfirmed, false);
  }
});

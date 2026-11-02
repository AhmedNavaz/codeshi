import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { alertChannels, currentAction, overlayBounds, statusMenu, statusSnapshot, statusTitle } from '../desktop/status.mjs';
import { createOverlay } from '../desktop/overlay.mjs';

// A registry stand-in: workspaces with their main conversation and, when an agent works, its run.
function registry(workspaces) {
  return {
    list: () => workspaces.map(({ id, name }) => ({ id, name })),
    brokers: new Map(workspaces.map(({ id, c, running = null }) => [id, { broker: { mainConversationId: c.id, conversations: new Map([[c.id, c]]), running: running && { c, ...running } } }])),
  };
}
const conversation = (id, extra = {}) => ({ id, messages: [], runs: [], queue: [], queuePaused: null, activeRun: null, lastRun: null, resume: null, retryOffer: null, handoffOffer: null, ...extra });
const step = text => ({ role: 'activity', runId: 'r', text });
const working = (messages, extra = {}) => conversation('c', { activeRun: { id: 'r', provider: 'codex', phase: 'tool' }, messages, ...extra });

test('a run’s current action is said in general words with a count, never a command, file path or the agent’s text', () => {
  const edits = step('File changes: [{"path":"src/checkout.js","kind":"modify"},{"path":"src/promo.js","kind":"add"}]');
  assert.equal(currentAction(working([edits])), 'Editing · 2 files changed');
  assert.equal(currentAction(working([step('Edit\n{"file_path":"/w/src/cart.js","old_string":"a","new_string":"b"}')])), 'Editing · 1 file changed');
  assert.equal(currentAction(working([step('$ npm test\n24 passing')])), 'Running tests');
  assert.equal(currentAction(working([step('$ curl -H "Authorization: Bearer secret" https://api.example.com')])), 'Running a command');
  assert.equal(currentAction(working([step('Bash\n{"command":"git push --force","description":"Push the secret branch"}')])), 'Running a command', 'The agent’s description is its own text and stays in the app.');
  assert.equal(currentAction(working([edits, step('Read\n{"file_path":"/w/src/cart.js"}')])), 'Reading files');
  assert.equal(currentAction(working([step('Grep\n{"pattern":"promo"}')])), 'Searching the project');
  assert.equal(currentAction(working([edits, step('mcp_tool_call: something')])), 'Working · 2 files changed');
  assert.equal(currentAction(working([{ ...step('$ npm test'), runId: 'earlier' }])), 'Working', 'Only the running run’s steps count.');
  assert.equal(currentAction(working([], { activeRun: { id: 'r', provider: 'codex', phase: 'starting' } })), 'Starting');
  assert.equal(currentAction(conversation('idle')), '');
});

test('the status lists busy workspaces, most urgent first, and leaves quiet ones out', () => {
  const approval = { id: 'ap1', title: 'Install the rate limiter', command: 'npm install express-rate-limit' };
  const snapshot = statusSnapshot(registry([
    { id: 'shop', name: 'acme-shop', c: working([step('$ npm test')]), running: { provider: 'codex', approvals: new Map() } },
    { id: 'api', name: 'payments-api', c: working([]), running: { provider: 'claude', approvals: new Map([['ap1', approval]]) } },
    { id: 'docs', name: 'docs', c: conversation('d', { resume: { providers: ['claude'] } }) },
    { id: 'web', name: 'web', c: conversation('w', { lastRun: { id: 'x', check: { status: 'failed' } } }) },
    { id: 'cli', name: 'cli', c: conversation('q', { queue: [{ id: 'q1' }, { id: 'q2' }], queuePaused: { reason: 'You stopped the run.' } }) },
    { id: 'idle', name: 'idle', c: conversation('i') },
  ]));
  assert.deepEqual(snapshot.rows.map(row => [row.name, row.kind, row.text]), [
    ['payments-api', 'approval', 'Approval needed · Claude'],
    ['web', 'failed', 'Tests failed'],
    ['acme-shop', 'running', 'Codex · Running tests'],
    ['docs', 'waiting', 'Waiting for a usage limit to reset'],
    ['cli', 'paused', 'Queue paused · 2 waiting'],
  ]);
  assert.deepEqual([snapshot.attention, snapshot.running], [2, 1]);
  assert.equal(snapshot.rows[0].approvalId, 'ap1');
  const offer = statusSnapshot(registry([{ id: 'shop', name: 'acme-shop', c: conversation('o', { retryOffer: { provider: 'claude' } }) }]));
  assert.deepEqual(offer.rows.map(row => [row.kind, row.text]), [['offer', 'Tests failed · retry with Claude?']]);
});

test('the words beside the icon say what needs you, or what the one running agent is doing, or how many are working', () => {
  const rows = (...kinds) => ({ rows: kinds.map((kind, index) => ({ kind, attention: ['approval', 'failed', 'offer'].includes(kind), agent: 'Codex', action: index ? 'Reading files' : 'Editing checkout.js and 2 more files today' })), attention: kinds.filter(kind => ['approval', 'failed', 'offer'].includes(kind)).length, running: kinds.filter(kind => kind === 'running').length });
  assert.equal(statusTitle(rows()), '');
  assert.equal(statusTitle(rows('running')), 'Codex · Editing checkout.js and…', 'A long action is shortened.');
  assert.equal(statusTitle(rows('running', 'running')), '2 working');
  assert.equal(statusTitle(rows('approval', 'running')), 'Approval needed');
  assert.equal(statusTitle(rows('failed')), 'Tests failed');
  assert.equal(statusTitle(rows('approval', 'offer', 'running')), '2 need you');
});

test('the status menu opens the right workspace or request and only changes Keep Awake when it is clicked', () => {
  const calls = [];
  const snapshot = { rows: [{ projectId: 'api', name: 'payments-api', kind: 'approval', text: 'Approval needed: npm install', approvalId: 'ap1', attention: true }, { projectId: 'shop', name: 'acme-shop', kind: 'running', text: 'Codex · Reading files' }], attention: 1, running: 1 };
  const template = statusMenu(snapshot, { keepAwake: { enabled: true, active: true }, overlay: false, open: target => calls.push(['open', target]), show: () => calls.push(['show']), setKeepAwake: value => calls.push(['keep-awake', value]), setOverlay: value => calls.push(['overlay', value]), hide: () => calls.push(['hide']), quit: () => calls.push(['quit']) });
  const labels = template.map(item => item.type === 'separator' ? '-' : item.label);
  assert.deepEqual(labels, ['1 needs you · 1 working', '-', 'payments-api — Approval needed: npm install', 'acme-shop — Codex · Reading files', '-', 'Open Throughline', 'Keep Awake', 'Keeping your Mac awake while agents work', 'Show Alerts Near the Top of the Screen', 'Hide from Menu Bar', '-', 'Quit Throughline']);
  assert.equal(calls.length, 0, 'Building the menu changes nothing.');
  const item = label => template.find(entry => entry.label === label);
  item('payments-api — Approval needed: npm install').click(); item('acme-shop — Codex · Reading files').click();
  item('Keep Awake').click(); item('Show Alerts Near the Top of the Screen').click(); item('Hide from Menu Bar').click();
  assert.deepEqual(calls, [['open', { projectId: 'api', approvalId: 'ap1' }], ['open', { projectId: 'shop' }], ['keep-awake', false], ['overlay', true], ['hide']]);
  assert.equal(item('Keep Awake').checked, true);
  assert.equal(statusMenu({ rows: [], attention: 0, running: 0 })[0].label, 'Nothing running');
});

test('alerts go to the overlay instead of a banner when it is on, never both, and nowhere while the window is in front', () => {
  const on = { enabled: true, overlay: true }, off = { enabled: true, overlay: false };
  assert.deepEqual(alertChannels({ focused: true, preferences: on }), { badge: false, bounce: false, notification: false, overlay: false });
  assert.deepEqual(alertChannels({ focused: false, preferences: on }), { badge: true, bounce: true, notification: false, overlay: true });
  assert.deepEqual(alertChannels({ focused: false, preferences: off }), { badge: true, bounce: true, notification: true, overlay: false });
  assert.deepEqual(alertChannels({ focused: false, preferences: on, overlayAvailable: false }), { badge: true, bounce: true, notification: true, overlay: false }, 'Without the overlay, the banner shows.');
  assert.deepEqual(alertChannels({ focused: false, preferences: { enabled: false, overlay: true } }), { badge: true, bounce: false, notification: false, overlay: false }, 'Alerts turned off leave only the Dock badge.');
});

test('the overlay sits centred under the menu bar of its display, and its page runs only its own script', () => {
  assert.deepEqual(overlayBounds({ workArea: { x: 0, y: 38, width: 1512, height: 944 } }), { x: 546, y: 46, width: 420, height: 88 }, 'Below the menu bar, which is taller on a Mac with a notch.');
  assert.deepEqual(overlayBounds({ workArea: { x: 1512, y: 25, width: 2560, height: 1415 } }), { x: 2582, y: 33, width: 420, height: 88 }, 'On a second display, centred on that one.');
  const page = fs.readFileSync(new URL('../desktop/overlay.html', import.meta.url), 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert(page.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`), 'The policy allows exactly the page’s script; update its hash when the script changes.');
  assert.match(page, /default-src 'none'/);
});

test('an alert taken away while the panel’s page loads never shows, and of several waiting only the latest does', () => {
  // The panel loads its page on the first alert. One that goes in the meantime must not leave an empty panel on top.
  function overlay() {
    const panel = { loaded: [], sent: [], shown: 0 };
    class Panel {
      constructor() { this.webContents = { isLoading: () => true, once: (_name, callback) => panel.loaded.push(callback), send: (_channel, alert) => panel.sent.push(alert.title), setWindowOpenHandler() {}, on() {} }; }
      setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {} setBounds() {} hide() {} destroy() {} isDestroyed() { return false; } showInactive() { panel.shown++; }
    }
    const screen = { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) };
    return { panel, overlay: createOverlay({ BrowserWindow: Panel, screen, ipcMain: { on() {}, off() {} }, root: '/app', open() {}, mac: true }) };
  }
  const first = overlay();
  first.overlay.show({ kind: 'approval', title: 'Approval needed', projectName: 'Shop' }); first.overlay.hide();
  for (const callback of first.panel.loaded) callback();
  assert.deepEqual([first.panel.sent, first.panel.shown], [[], 0]);
  first.overlay.dispose();
  const second = overlay();
  second.overlay.show({ kind: 'finished', title: 'Task finished' }); second.overlay.show({ kind: 'failed', title: 'Task failed' });
  for (const callback of second.panel.loaded) callback();
  assert.deepEqual([second.panel.sent, second.panel.shown], [['Task failed'], 1]);
  second.overlay.dispose();
});

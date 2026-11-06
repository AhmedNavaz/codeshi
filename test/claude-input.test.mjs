import assert from 'node:assert/strict';
import test from 'node:test';
import { runClaude } from '../src/providers.mjs';

// Claude's permission requests use the same connection as its input, so closing input too early fails every later
// request with "Stream closed" (#112). These follow the order of messages real Claude Code sends.
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
const running = { type: 'system', subtype: 'session_state_changed', state: 'running' };
const requesting = { type: 'system', subtype: 'status', status: 'requesting' };
const tasks = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map(task_id => ({ task_id, task_type: 'local_bash' })) });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done', ...extra });
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

// Follows the messages of a fake Claude, which can check at any point whether its input has closed.
async function run(script, { waits = { settleMs: 30, backgroundMs: 60000 }, ...callbacks } = {}) {
  const events = [];
  await runClaude({ bin: '/claude', workspace: '/project', mode: 'edit', prompt: 'Go' }, {
    waits, event: event => events.push(event), metadata() {}, approval: async () => true,
    queryImpl: ({ prompt, options }) => (async function* () {
      const input = prompt[Symbol.asyncIterator]();
      await input.next();
      let closed = false; const ended = (async () => { while (!(await input.next()).done); closed = true; })();
      yield* script({ options, isClosed: async () => { await later(5); return closed; }, ended });
    })(),
    ...callbacks,
  });
  return events;
}

test('input stays open for the turn a finished background command starts, so it can still ask for permission', async () => {
  const seen = [];
  await run(async function* ({ options, isClosed }) {
    yield running; yield requesting; yield tasks('sleep'); yield result(); yield idle;
    seen.push(['waiting on the command', await isClosed()]);
    yield tasks(); yield running; yield requesting;
    seen.push(['in the woken turn', await isClosed()]);
    seen.push(['permission', (await options.canUseTool('Bash', { command: 'mkdir x' }, { toolUseID: 'woken' })).behavior]);
    yield result(); yield idle;
    seen.push(['after the last turn', await isClosed()]);
  });
  assert.deepEqual(seen, [['waiting on the command', false], ['in the woken turn', false], ['permission', 'allow'], ['after the last turn', true]]);
});

test('a run with no background work closes as soon as Claude is idle, without waiting', async () => {
  let closedAt;
  const started = Date.now();
  await run(async function* ({ isClosed }) {
    yield running; yield requesting; yield result(); yield idle;
    assert.equal(await isClosed(), true); closedAt = Date.now() - started;
  }, { waits: { settleMs: 60000, backgroundMs: 60000 } });
  assert.ok(closedAt < 5000);
});

test('a command that finishes during the turn it started delays nothing once a later model request has seen it', async () => {
  await run(async function* ({ isClosed }) {
    yield running; yield requesting; yield tasks('sleep'); yield tasks(); yield requesting; yield result(); yield idle;
    assert.equal(await isClosed(), true);
  }, { waits: { settleMs: 60000, backgroundMs: 60000 } });
});

test('a background command that ends without waking Claude still lets the run end', async () => {
  await run(async function* ({ isClosed, ended }) {
    yield running; yield requesting; yield tasks('sleep'); yield result(); yield idle; yield tasks();
    assert.equal(await isClosed(), false, 'It gets a moment to start another turn.');
    await ended;
  });
});

for (const reportsState of [false, true]) test(`a woken model request cancels the closing timer before its first assistant message (${reportsState ? 'delayed session state' : 'no session state'})`, async () => {
  await run(async function* ({ options, isClosed }) {
    // Some clients report background membership and request status without session-state events. Others can
    // deliver requesting before running. Neither ordering may close input while the model request is in flight.
    if (reportsState) yield running;
    yield requesting; yield tasks('sleep'); yield result();
    if (reportsState) yield idle;
    yield tasks(); yield requesting;
    await later(70);
    assert.equal(await isClosed(), false, 'The request outlives the settle window and still has its permission connection.');
    assert.equal((await options.canUseTool('Bash', { command: 'mkdir second-step-ran' }, { toolUseID: 'late-wake' })).behavior, 'allow');
    yield result();
    if (reportsState) yield idle;
    assert.equal(await isClosed(), true);
  });
});

test('a note that arrives as a turn ends gets a moment to start its own turn, which can still ask for permission', async () => {
  let note;
  await run(async function* ({ options, isClosed }) {
    yield running; yield requesting;
    await note('One more thing');
    yield result(); yield idle;
    assert.equal(await isClosed(), false);
    yield running; yield requesting;
    assert.equal((await options.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'note' })).behavior, 'allow');
    yield result(); yield idle;
    assert.equal(await isClosed(), true);
  }, { steerable: handler => { if (handler) note = handler; }, waits: { settleMs: 50, backgroundMs: 60000 } });
});

test('a background command that never finishes ends the run with a plain explanation', async () => {
  await assert.rejects(run(async function* ({ options }) {
    yield running; yield requesting; yield tasks('stuck'); yield result(); yield idle;
    await new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' }))));
  }, { waits: { settleMs: 30, backgroundMs: 20 } }), /still running after .* so Codeshi ended this run/);
});

test('stopping a run while it waits on a background command works as before', async () => {
  let stop = false;
  await assert.rejects(run(async function* ({ options }) {
    yield running; yield requesting; yield tasks('sleep'); yield result(); yield idle;
    stop = true;
    await new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user'))));
  }, { cancelled: () => stop }), /aborted by user/);
});

test('activity that is not background work does not keep a run open', async () => {
  await run(async function* ({ isClosed }) {
    yield running; yield requesting;
    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', task_type: 'monitor', ambient: true }] };
    yield result(); yield idle;
    assert.equal(await isClosed(), true);
  }, { waits: { settleMs: 60000, backgroundMs: 60000 } });
});

test('a Claude that reports no state still closes input at its result', async () => {
  await run(async function* ({ isClosed }) {
    yield { type: 'system', subtype: 'init', model: 'older' }; yield result();
    assert.equal(await isClosed(), true);
  }, { waits: { settleMs: 60000, backgroundMs: 60000 } });
});

test('a tool Codeshi declined is not reported as a permission failure, but one that never reached it is', async () => {
  const events = await run(async function* ({ options }) {
    yield running;
    assert.equal((await options.canUseTool('Bash', { command: 'rm x' }, { toolUseID: 'declined' })).behavior, 'deny');
    yield result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'declined' }, { tool_name: 'Edit', tool_use_id: 'never-asked' }] }); yield idle;
  }, { approval: async () => false });
  assert.deepEqual(events.find(event => event.type === 'result').permission_denials, [{ tool_name: 'Edit', tool_use_id: 'never-asked' }]);
});

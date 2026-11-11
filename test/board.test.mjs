import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scriptCLIs } from './platform.mjs';
import { Broker } from '../src/broker.mjs';
import { MutationCoordinator } from '../src/mutation-lock.mjs';
import { createRelayServer } from '../src/server.mjs';

// The task board (#132, first stage): cards you write and run by hand, each run an ordinary task (#88).
const fixture = fileURLToPath(new URL('./mock-cli.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repository(folder) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.mock-scenarios.json'), JSON.stringify({ 'Hold main': { behavior: 'hold' } }));
  fs.writeFileSync(path.join(folder, '.gitignore'), '.release\n.mock-captures.jsonl\nnode_modules\n');
  git(folder, 'init', '-q'); git(folder, 'config', 'user.email', 't@t.t'); git(folder, 'config', 'user.name', 't');
  git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'first');
  return folder;
}
function setup(t, names = ['a'], { policy = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-board-')), bins = {}, dataDir = path.join(root, 'data');
  for (const provider of ['codex', 'claude']) { bins[provider] = path.join(root, `${provider}-mock.mjs`); fs.writeFileSync(bins[provider], `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 }); }
  bins.gemini = path.join(root, 'missing-gemini');
  const list = names.map(name => ({ id: name, name, path: repository(path.join(root, 'w', name)) }));
  const mutations = new MutationCoordinator(path.join(root, 'locks'));
  const open = () => { const paths = list.map(folder => folder.path); return new Broker({ workspace: paths[0], workspaceFolders: list, dataDir, bins, handoffPreferences: () => ({ threshold: 0, automatic: false }), acquireMutation: operation => mutations.acquireMany(paths, operation), acquireFolders: (where, operation) => mutations.acquireMany(where, operation), withFolders: (where, operation, work) => mutations.withMutations(where, operation, work) }); };
  const broker = open(), c = broker.get(broker.create().id);
  broker.checks.usage = async () => ({ available: false });
  broker.budget.setPolicy(c, { maxConcurrent: 5, ...policy });
  t.after(async () => { await env.broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { broker, c, list, folder: id => list.find(folder => folder.id === id).path,
    get board() { return env.broker.board; },
    card: id => env.c.board.find(item => item.id === id),
    task: id => env.c.parallelTasks.find(item => item.id === id),
    lane: id => env.broker.tasks.lanes.get(id),
    add: (input = {}) => env.board.create(env.c, { title: 'Card', agent: { provider: 'codex' }, folderId: list[0].id, ...input }),
    // What the mock agent does when it's sent this card: hold until released, or answer at once. Committed, so a task's own
    // copy has it too.
    script: (card, behavior, text) => {
      const folder = env.folder(card.folderId || list[0].id), file = path.join(folder, '.mock-scenarios.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      saved[env.board.prompt(env.c, env.card(card.id))] = { ...(behavior ? { behavior } : {}), ...(text ? { text } : {}) };
      fs.writeFileSync(file, JSON.stringify(saved)); git(folder, 'commit', '-qam', 'script');
    },
    captured: place => { const file = path.join(place, '.mock-captures.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : []; },
    release: place => fs.writeFileSync(path.join(place, '.release'), ''),
    reopen: async () => { await env.broker.close(); env.broker = open(); env.c = env.broker.get(c.id); return env.broker; },
  };
  return env;
}
const until = async (check, what) => { for (let i = 0; i < 1500; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`Timed out waiting for ${what}.`); };
const column = (env, card) => env.card(card.id).column;

test('cards are written, checked and kept with the workspace, and never default to an agent', async t => {
  const env = setup(t, ['a', 'b']);
  const first = env.board.create(env.c, { title: '  Add a login page  ', notes: 'Email and password.', checks: ['Tests pass', { text: 'Has a logout link', done: true }] });
  assert.deepEqual([first.column, first.priority, first.agent, first.folderId, first.revision, first.createdBy], ['backlog', 'normal', null, null, 1, 'you'], 'A new card has no agent until you choose one: nothing runs on Auto by default.');
  assert.equal(first.title, 'Add a login page');
  assert.deepEqual(first.checks, [{ text: 'Tests pass', done: false }, { text: 'Has a logout link', done: true }]);
  assert.throws(() => env.board.create(env.c, { title: ' ' }), /Give the card a title/);
  assert.throws(() => env.board.create(env.c, { title: 'x', priority: 'urgent' }), /high, normal or low/);
  assert.throws(() => env.board.create(env.c, { title: 'x', agent: { provider: 'auto' } }), /Codex, Claude or Gemini/);
  assert.throws(() => env.board.create(env.c, { title: 'x', folderId: 'elsewhere' }), /folder in this workspace/);
  assert.throws(() => env.board.create(env.c, { title: 'x', column: 'doing' }), /Backlog or Ready/);
  const second = env.board.create(env.c, { title: 'Style it', column: 'ready', dependsOn: [first.id] });
  assert.throws(() => env.board.edit(env.c, first.id, { dependsOn: [second.id] }), /circle/, 'Cards can’t wait for each other in a circle.');
  assert.throws(() => env.board.edit(env.c, first.id, { dependsOn: [first.id] }), /itself/);
  // Saving over a newer version of a card is refused; ticking a check isn't a new version.
  const edited = env.board.edit(env.c, first.id, { revision: 1, notes: 'Email, password and a reset link.' });
  assert.equal(edited.revision, 2);
  assert.throws(() => env.board.edit(env.c, first.id, { revision: 1, title: 'Stale' }), /changed since you opened it/);
  assert.equal(env.board.edit(env.c, first.id, { checks: [{ text: 'Tests pass', done: true }, { text: 'Has a logout link', done: true }] }).revision, 2);
  // Moving: Backlog and Ready by hand, any order; Doing and Review only by running.
  assert.equal(env.board.move(env.c, first.id, { column: 'ready', before: second.id }).column, 'ready');
  assert.deepEqual(env.board.list(env.c).filter(card => card.column === 'ready').map(card => card.title), ['Add a login page', 'Style it']);
  assert.throws(() => env.board.move(env.c, first.id, { column: 'doing' }), /Running it moves it there/);
  assert.throws(() => env.board.move(env.c, first.id, { column: 'done' }), /Running it moves it there/);
  // Removing a card takes it out of what others wait for.
  env.board.remove(env.c, first.id);
  assert.deepEqual(env.card(second.id).dependsOn, []);
  await env.reopen();
  assert.deepEqual(env.board.view(env.c).cards.map(card => [card.title, card.column]), [['Style it', 'ready']], 'The board is kept with the workspace.');
  assert.equal(env.c.messages.length, 0, 'None of this shows in the chat.');
  assert.equal(env.broker.view(env.c).board, undefined, 'The conversation view doesn’t carry the whole board.');
  assert(env.broker.view(env.c).boardRevision > 0, 'It says when the board changed.');
});

test('a card runs as its own task under Normal, finishes in Review with its summary, and only you accept it', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  // The workspace's own default is Flow; a card still runs with exactly its agent.
  env.broker.execution.setDefault(env.c, { mode: 'flow' });
  const card = env.add({ title: 'Fix the footer', notes: 'It overlaps on phones.', checks: ['Looks right at 375 px'], agent: { provider: 'claude', model: null, effort: null } });
  assert.throws(() => env.board.run(env.c, { ids: [card.id] }), /isn’t in Ready/);
  env.board.move(env.c, card.id, { column: 'ready' });
  env.script(card, 'hold', 'Moved the footer below the content. Checked at 375 px.');
  const { tasks } = env.board.run(env.c, { ids: [card.id] }), task = env.task(tasks[card.id]);
  assert.equal(column(env, card), 'doing');
  assert.deepEqual([task.title, task.provider, task.board.cardId, task.board.revision], ['Fix the footer', 'claude', card.id, 1]);
  assert.equal(env.broker.execution.current(env.c, task.execution.taskId).mode, 'normal', 'The card’s task is Normal, whatever the workspace default.');
  await until(() => env.captured(fs.realpathSync(env.folder('a'))).length, 'the card’s task to start');
  const sent = env.captured(fs.realpathSync(env.folder('a')))[0].context.currentRequest;
  assert.match(sent, /^Fix the footer\n\nIt overlaps on phones\.\n\nDone means:\n- Looks right at 375 px/);
  assert.throws(() => env.board.edit(env.c, card.id, { notes: 'Changed while it works' }), /Stop it first/, 'What the agent works from stays as it started.');
  assert.equal(env.board.edit(env.c, card.id, { priority: 'high' }).priority, 'high', 'The priority can still change.');
  assert.throws(() => env.board.accept(env.c, card.id), /Only a card in Review/);
  env.release(fs.realpathSync(env.folder('a')));
  await until(() => column(env, card) === 'review', 'the card to reach Review');
  const shown = env.board.list(env.c)[0];
  assert.equal(shown.result.summary, 'Moved the footer below the content. Checked at 375 px.');
  assert.equal(shown.result.status, 'complete'); assert.equal(shown.result.inCopy, false);
  assert.equal(shown.attempts.length, 1); assert.equal(shown.attempts[0].outcome, 'complete'); assert.equal(shown.attempts[0].provider, 'claude');
  assert.equal(shown.column, 'review', 'Finishing isn’t the same as done: the agent never accepts its own work.');
  const accepted = env.board.accept(env.c, card.id);
  assert.deepEqual([accepted.column, accepted.acceptedBy], ['done', 'you']);
  assert.ok(accepted.acceptedAt);
  // Reopening a done card puts it back to run again.
  assert.equal(env.board.move(env.c, card.id, { column: 'ready' }).acceptedAt, null);
});

test('a stopped or cancelled card goes back to Ready with the reason, and a card in Review can be sent back', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const card = env.add({ title: 'Long job', column: 'ready' });
  env.script(card, 'hold');
  env.board.run(env.c, { ids: [card.id] });
  await until(() => env.task(env.card(card.id).task)?.status === 'running', 'it to start');
  assert.throws(() => env.board.remove(env.c, card.id), /Stop it before removing/);
  assert.throws(() => env.board.move(env.c, card.id, { column: 'backlog' }), /Stop it to move it/);
  env.board.stop(env.c, card.id);
  await until(() => column(env, card) === 'ready', 'it to go back to Ready');
  assert.equal(env.card(card.id).reason, 'Stopped before it finished.'); assert.equal(env.card(card.id).task, null);
  assert.equal(env.card(card.id).attempts[0].outcome, 'stopped');
  // Run again: it finishes this time, and is sent back from Review with a note.
  env.release(fs.realpathSync(env.folder('a')));
  env.board.run(env.c, { ids: [card.id] });
  await until(() => column(env, card) === 'review', 'the second try to finish');
  assert.equal(env.card(card.id).attempts.length, 2);
  env.board.sendBack(env.c, card.id, { reason: 'It missed the empty state.' });
  assert.deepEqual([column(env, card), env.card(card.id).reason], ['ready', 'Sent back: It missed the empty state.']);
  assert.throws(() => env.board.sendBack(env.c, card.id), /Only a card in Review/);
});

test('Run Ready runs the exact cards chosen, in the order their waits give, and nothing else', { skip: scriptCLIs }, async t => {
  const env = setup(t, ['a', 'b']);
  const first = env.add({ title: 'Schema', column: 'ready', folderId: 'a' }), second = env.add({ title: 'API', column: 'ready', folderId: 'b', dependsOn: [first.id] }), other = env.add({ title: 'Unrelated', column: 'ready', folderId: 'b' });
  const noAgent = env.add({ title: 'No agent yet', column: 'ready', agent: null });
  env.script(first, 'hold'); env.script(second); env.script(other);
  assert.throws(() => env.board.run(env.c, { ids: [second.id] }), /waits for “Schema”, which isn’t done/, 'A card can’t run before what it waits for, unless they run together.');
  assert.throws(() => env.board.run(env.c, { ids: [first.id, noAgent.id] }), /Choose an agent for “No agent yet”/);
  assert.deepEqual(env.c.parallelTasks || [], [], 'A run that can’t start starts nothing.');
  assert.equal(column(env, first), 'ready');
  const { tasks } = env.board.run(env.c, { ids: [second.id, first.id] });
  assert.deepEqual(Object.keys(tasks).sort(), [first.id, second.id].sort());
  assert.deepEqual(env.task(tasks[second.id]).dependsOn, [tasks[first.id]], 'API’s task waits for Schema’s.');
  await until(() => env.task(tasks[first.id]).status === 'running', 'Schema to start');
  assert.equal(env.task(tasks[second.id]).status, 'waiting'); assert.match(env.task(tasks[second.id]).reason, /Waiting for “Schema”/);
  assert.deepEqual([column(env, first), column(env, second), column(env, other)], ['doing', 'doing', 'ready'], 'A Ready card nobody chose stays where it is.');
  env.release(fs.realpathSync(env.folder('a')));
  await until(() => column(env, second) === 'review', 'API to finish after Schema');
  assert.equal(column(env, first), 'review'); assert.equal(column(env, other), 'ready');
  assert.equal(env.c.parallelTasks.length, 2);
});

test('after a restart a working card goes back to Ready, and one waiting for it waits for you', { skip: scriptCLIs }, async t => {
  const env = setup(t, ['a', 'b']);
  const working = env.add({ title: 'Working', column: 'ready', folderId: 'a' }), queued = env.add({ title: 'Queued', column: 'ready', folderId: 'b', dependsOn: [working.id] });
  env.script(working, 'hold'); env.script(queued, 'hold');
  env.board.run(env.c, { ids: [working.id, queued.id] });
  await until(() => env.task(env.card(working.id).task)?.status === 'running', 'the first to start');
  assert.match(env.task(env.card(queued.id).task).reason, /Waiting for “Working”/, 'The second waits for the first.');
  await env.reopen();
  assert.deepEqual([column(env, working), env.card(working.id).reason], ['ready', 'Stopped before it finished.'], 'What was working is known to have stopped.');
  const waiting = env.board.list(env.c).find(card => card.id === queued.id);
  assert.deepEqual([waiting.column, waiting.taskState.status, waiting.taskState.held], ['doing', 'waiting', true], 'Nothing starts by itself after a restart.');
  env.board.stop(env.c, queued.id);
  assert.deepEqual([column(env, queued), env.card(queued.id).reason], ['ready', 'Cancelled before it started.']);
});

test('a card that worked in its own copy is accepted only once its changes are merged or kept', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  // A main run in the same repository makes the card's task take its own copy.
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folder('a'))).length, 'the main run');
  const card = env.add({ title: 'In a copy', column: 'ready' });
  env.script(card, null, 'Done in a copy.');
  const { tasks } = env.board.run(env.c, { ids: [card.id] });
  await until(() => column(env, card) === 'review', 'it to finish in its copy');
  assert.equal(env.task(tasks[card.id]).mode, 'worktree'); assert.equal(env.card(card.id).result.inCopy, true);
  assert.throws(() => env.board.accept(env.c, card.id), /Review and merge them first/);
  assert.throws(() => env.board.sendBack(env.c, card.id), /Discard them in its task first/);
  env.release(fs.realpathSync(env.folder('a'))); await main.done;
  fs.writeFileSync(path.join(env.task(tasks[card.id]).scopePath, 'made.txt'), 'by the card\n');
  await env.broker.tasks.integrate(env.c, tasks[card.id], { digest: env.broker.tasks.review(env.c, tasks[card.id]).digest });
  await until(() => env.card(card.id).result.status === 'integrated', 'the card to see the merge');
  assert.equal(env.card(card.id).result.files, 1);
  assert.equal(env.board.accept(env.c, card.id).column, 'done');
});

test('a card’s place on the canvas is saved without changing what an agent reads, and survives a restart (#97)', async t => {
  const env = setup(t);
  const first = env.add({ title: 'Agree the API', at: { x: 10.4, y: -20.6 } }), second = env.add({ title: 'Build "the" <form> #2', dependsOn: [first.id], checks: [{ text: 'Tests pass', done: true }], notes: 'Email only.' });
  assert.deepEqual(env.card(first.id).at, { x: 10, y: -21 }, 'A new card can start where it was made, in whole pixels.');
  assert.equal(env.card(second.id).at, undefined, 'A card made in Columns has no place until the canvas gives it one.');
  assert.deepEqual(env.board.place(env.c, { positions: { [second.id]: { x: 400, y: 9e9 }, [first.id]: null } }), { placed: 2 });
  assert.deepEqual(env.card(second.id).at, { x: 400, y: 100000 }, 'A place stays within the canvas.');
  assert.equal(env.card(first.id).at, null, 'null hands a card back to the canvas’s own layout.');
  assert.equal(env.card(second.id).revision, 1, 'Moving a card changes nothing an agent reads, so its revision stays.');
  // Every id is checked before anything moves.
  assert.throws(() => env.board.place(env.c, { positions: { [second.id]: { x: 1, y: 1 }, 'not-a-card': { x: 0, y: 0 } } }), /no longer on the board/);
  assert.deepEqual(env.card(second.id).at, { x: 400, y: 100000 });
  for (const bad of [{}, { positions: [] }, { positions: {} }, { positions: { [second.id]: { x: 'a', y: 1 } } }]) assert.throws(() => env.board.place(env.c, bad), error => error.status === 400);
  // A card that's working can still be moved on the canvas.
  env.c.board.find(card => card.id === second.id).column = 'doing';
  env.board.place(env.c, { positions: { [second.id]: { x: 5, y: 5 } } });
  env.c.board.find(card => card.id === second.id).column = 'backlog';
  const markdown = env.board.markdown(env.c, { now: new Date('2026-11-11T12:00:00Z') });
  assert.match(markdown, /^# Task board\n\nExported from Codeshi on 2026-11-11\. 2 cards\./);
  assert.match(markdown, /```mermaid\nflowchart LR\n {2}c1\["Agree the API"\]:::backlog\n {2}c2\["Build #quot;the#quot; #lt;form#gt; #35;2"\]:::backlog\n {2}c1 --> c2\n/, 'The chart escapes what Mermaid would read as its own syntax.');
  assert.match(markdown, /## Backlog\n\n### Agree the API\n\n- Agent: Codex\n/);
  assert.match(markdown, /- Waits for: “Agree the API”\n\nEmail only\.\n\nDone means:\n\n- \[x\] Tests pass\n/);
  assert.doesNotMatch(markdown, new RegExp(first.id), 'Card ids stay out of the export.');
  await env.reopen();
  assert.deepEqual(env.card(second.id).at, { x: 5, y: 5 }, 'Places are kept in the workspace’s journal.');
});

test('through the real server: the board is read and changed for the workspace chat', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-board-server-'))), a = repository(path.join(root, 'a')), cli = path.join(root, 'codex-mock.mjs');
  fs.writeFileSync(cli, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`, { mode: 0o700 });
  const app = createRelayServer({ workspace: a, dataRoot: path.join(root, 'data'), bins: { codex: cli, claude: cli, gemini: path.join(root, 'missing') }, accessToken: 'fixture-token' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = app.registry.list()[0];
  const call = async (route, input) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}?projectId=${project.id}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'X-AI-Relay-Token': 'fixture-token', 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, body: await response.json() }; };
  const empty = await call('/api/board');
  assert.equal(empty.status, 200); assert.deepEqual(empty.body.cards, []); assert.equal(empty.body.folders.length, 1); assert.deepEqual(empty.body.access, { mode: 'edit', approvalPolicy: 'ask' });
  const made = await call('/api/board/cards', { title: 'From the page', column: 'ready', agent: { provider: 'codex' } });
  assert.equal(made.status, 201); assert.equal(made.body.board.cards[0].title, 'From the page');
  const id = made.body.card.id;
  assert.equal((await call(`/api/board/cards/${id}/edit`, { priority: 'high' })).body.card.priority, 'high');
  const placed = await call('/api/board/place', { positions: { [id]: { x: 120, y: 40 } } });
  assert.equal(placed.status, 200); assert.deepEqual(placed.body.board.cards[0].at, { x: 120, y: 40 });
  assert.equal((await call('/api/board/place', { positions: {} })).status, 400);
  const exported = await call('/api/board/export');
  assert.equal(exported.status, 200); assert.equal(exported.body.filename, 'codeshi-board.md'); assert.match(exported.body.markdown, /## Ready\n\n### From the page/);
  assert.equal((await call(`/api/board/cards/${id}/move`, { column: 'doing' })).status, 409);
  assert.equal((await call(`/api/board/cards/${id}/accept`, {})).status, 409);
  assert.equal((await call('/api/board/run', { ids: [] })).status, 400);
  const ran = await call('/api/board/run', { ids: [id] });
  assert.equal(ran.status, 202); assert.equal(ran.body.board.cards[0].column, 'doing');
  const main = app.registry.broker(project.id), home = main.get(app.registry.mainConversation(project.id).id);
  await until(() => home.board[0].column === 'review', 'the card to finish');
  assert.equal((await call(`/api/board/cards/${id}/accept`, {})).body.card.column, 'done');
  assert.equal((await call(`/api/board/cards/${id}/remove`, {})).body.removed, true);
  assert.equal((await call('/api/board/cards/not-a-card/edit', {})).status, 404);
});

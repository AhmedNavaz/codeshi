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
import { LIMITS } from '../src/board.mjs';
import { TaskBudgets } from '../src/task-budget.mjs';
import { TaskCoordinator } from '../src/task-coordinator.mjs';
import { openPlan, parsePlan } from '../src/orchestration.mjs';
import { prepareContext } from '../src/context.mjs';

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-board-'))), bins = {}, dataDir = path.join(root, 'data');
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
  assert.deepEqual([first.column, 'normal', first.agent, first.folderId, first.revision, first.createdBy], ['backlog', 'normal', null, null, 1, 'you'], 'A new card has no agent until you choose one: nothing runs on Auto by default.');
  assert.equal(first.title, 'Add a login page');
  assert.deepEqual(first.checks, [{ text: 'Tests pass', done: false }, { text: 'Has a logout link', done: true }]);
  assert.throws(() => env.board.create(env.c, { title: ' ' }), /Give the card a title/);
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
  assert.equal(env.board.edit(env.c, card.id, { labels: ['later'] }).labels[0], 'later', 'Labels can still change.');
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
  assert.match(markdown, /^# Plan\n\nExported from Codeshi on 2026-11-11\. 2 cards\./);
  assert.match(markdown, /```mermaid\nflowchart LR\n {2}c1\["Agree the API"\]:::backlog\n {2}c2\["Build #quot;the#quot; #lt;form#gt; #35;2"\]:::backlog\n {2}c1 --> c2\n/, 'The chart escapes what Mermaid would read as its own syntax.');
  assert.match(markdown, /## Backlog\n\n### Agree the API\n\n- Agent: Codex\n/);
  assert.match(markdown, /- Waits for: “Agree the API”\n\nEmail only\.\n\nDone means:\n\n- \[x\] Tests pass\n/);
  assert.doesNotMatch(markdown, new RegExp(first.id), 'Card ids stay out of the export.');
  await env.reopen();
  assert.deepEqual(env.card(second.id).at, { x: 5, y: 5 }, 'Places are kept in the workspace’s journal.');
});

test('labels sort cards without changing what an agent reads (#97)', async t => {
  const env = setup(t);
  const card = env.add({ title: 'Agree the API', labels: [' backend ', 'API', 'Backend', '', 'api  contract'] });
  assert.deepEqual(env.card(card.id).labels, ['backend', 'API', 'api contract'], 'Labels are trimmed and kept once whatever their case, in the order given.');
  assert.deepEqual(env.add().labels, [], 'A card starts with no labels.');
  for (const [input, message] of [[{ labels: 'backend' }, /must be a list/], [{ labels: [3] }, /must be text/], [{ labels: ['x'.repeat(33)] }, /up to 32 characters/], [{ labels: Array.from({ length: 9 }, (_, i) => `l${i}`) }, /up to 8 labels/]]) {
    assert.throws(() => env.board.edit(env.c, card.id, input), error => error.status === 400 && message.test(error.message), JSON.stringify(input));
  }
  assert.equal(env.board.edit(env.c, card.id, { labels: ['frontend'] }).revision, 1, 'The agent isn’t told labels, so they are no new revision.');
  assert.deepEqual(env.card(card.id).labels, ['frontend']);
  assert.doesNotMatch(env.board.prompt(env.c, env.card(card.id)), /frontend/);
  // Like labels, they can change while an agent works on the card; what it reads can't.
  env.c.board.find(item => item.id === card.id).column = 'doing';
  assert.deepEqual(env.board.edit(env.c, card.id, { labels: ['frontend', 'urgent'] }).labels, ['frontend', 'urgent']);
  assert.throws(() => env.board.edit(env.c, card.id, { title: 'Something else' }), /An agent is working on this card/);
  env.c.board.find(item => item.id === card.id).column = 'backlog';
  const markdown = env.board.markdown(env.c, { now: new Date('2026-11-12T12:00:00Z') });
  assert.match(markdown, /### Agree the API\n\n- Labels: frontend, urgent\n- Agent: Codex\n/);
  await env.reopen();
  assert.deepEqual(env.card(card.id).labels, ['frontend', 'urgent'], 'They are kept in the workspace’s journal.');
});

test('a card’s comments say who wrote them and when, reach the agent on its next run and are read on their own (#97)', async t => {
  const env = setup(t);
  const card = env.add({ title: 'Build the form', notes: 'Email only.' });
  const first = env.board.comment(env.c, card.id, { text: '  The design is changing:\r\nwait for the new mockups.  ' });
  assert.deepEqual([first.text, first.by], ['The design is changing:\nwait for the new mockups.', { kind: 'you' }], 'A comment keeps its lines and says you wrote it.');
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(env.card(card.id).revision, 2, 'The agent is told your comments, so a comment is a new revision: a scheduled run waits for you.');
  for (const [input, message] of [[{}, /Write the comment first/], [{ text: '   ' }, /Write the comment first/], [{ text: 'x'.repeat(4001) }, /up to 4,000 characters/]]) assert.throws(() => env.board.comment(env.c, card.id, input), error => error.status === 400 && message.test(error.message));
  assert.throws(() => env.board.comment(env.c, 'not-a-card', { text: 'Hi' }), error => error.status === 404);
  const second = env.board.comment(env.c, card.id, { text: 'Keep the old route working.' });
  const prompt = env.board.prompt(env.c, env.card(card.id));
  assert.match(prompt, /The person’s comments on this card, oldest first:\n- \d{4}-\d{2}-\d{2}: The design is changing:\n {2}wait for the new mockups\.\n- \d{4}-\d{2}-\d{2}: Keep the old route working\.\n/, 'The next run is told your comments, oldest first.');
  // The board carries a count, not the text; the drawer reads them on their own.
  const shown = env.board.view(env.c).cards.find(item => item.id === card.id);
  assert.equal(shown.comments, undefined); assert.equal(shown.commentCount, 2);
  assert.deepEqual(env.board.comments(env.c, card.id).map(item => item.id), [first.id, second.id]);
  // Anyone else's comment reaches an agent only once you accept it, so it isn't in the prompt.
  env.c.board.find(item => item.id === card.id).comments.push({ id: 'g1', text: 'Ship it today!', by: { kind: 'guest', name: 'Sam' }, at: '2026-11-12T10:00:00.000Z' });
  assert.doesNotMatch(env.board.prompt(env.c, env.card(card.id)), /Ship it today/);
  assert.match(env.board.markdown(env.c), /Comments:\n\n- You, \d{4}-\d{2}-\d{2}: The design is changing:\n {2}wait for the new mockups\.\n- You, [\d-]+: Keep the old route working\.\n- Sam \(guest\), 2026-11-12: Ship it today!\n/, 'The export names who wrote each comment.');
  env.c.board.find(item => item.id === card.id).comments.pop();
  assert.deepEqual(env.board.uncomment(env.c, card.id, { commentId: first.id }), { removed: true });
  assert.equal(env.card(card.id).revision, 4);
  assert.throws(() => env.board.uncomment(env.c, card.id, { commentId: first.id }), error => error.status === 404);
  assert.doesNotMatch(env.board.prompt(env.c, env.card(card.id)), /design is changing/, 'A removed comment isn’t told to the agent.');
  // A long thread sends its newest comments, up to a limit, and says how many it left out.
  for (let i = 0; i < 6; i++) env.board.comment(env.c, card.id, { text: `${i} ${'y'.repeat(3000)}` });
  const long = env.board.prompt(env.c, env.card(card.id));
  assert.match(long, /\(5 earlier comments left out\.\)\n- [\d-]+: 4 y+\n- [\d-]+: 5 y+/);
  // Comments are kept with the card and survive a restart.
  await env.reopen();
  assert.deepEqual(env.board.comments(env.c, card.id).map(item => item.text.slice(0, 1)), ['K', '0', '1', '2', '3', '4', '5']);
  assert.equal(env.card(card.id).revision, 10);
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
  assert.equal((await call(`/api/board/cards/${id}/edit`, { labels: ['api'] })).body.card.labels[0], 'api');
  assert.deepEqual((await call(`/api/board/cards/${id}/edit`, { labels: ['web'] })).body.card.labels, ['web']);
  const commented = await call(`/api/board/cards/${id}/comment`, { text: 'Use the new logo.' });
  assert.equal(commented.status, 201); assert.equal(commented.body.comment.text, 'Use the new logo.'); assert.equal(commented.body.card.commentCount, 1); assert.equal(commented.body.card.comments, undefined);
  assert.deepEqual((await call(`/api/board/cards/${id}/comments`)).body.comments.map(item => item.text), ['Use the new logo.']);
  assert.equal((await call(`/api/board/cards/${id}/comment`, { text: '' })).status, 400);
  assert.deepEqual((await call(`/api/board/cards/${id}/uncomment`, { commentId: commented.body.comment.id })).body.comments, []);
  assert.equal((await call(`/api/board/cards/${id}/comments`, {})).status, 405);
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

// One Plan (#162): an agent's plan arrives as draft cards on the Plan, and cards run the way plan steps did.
const drafted = (env, { steps, summary = 'Contract first, then the page and its tests.', questions = [] }) => {
  const id = `plan-${Math.random().toString(16).slice(2, 10)}`, plan = parsePlan(JSON.stringify({ summary, questions, steps }));
  assert.equal(plan.status, 'draft', 'The fixture is a valid plan.');
  env.broker.record(env.c, { type: 'orchestration_plan', id, plan: { id, goal: 'Add saved items, with an API and a page.', source: 'agent', status: 'draft', summary: plan.summary, steps: plan.steps, ...(plan.questions ? { questions: plan.questions } : {}), review: true, revision: 1, planner: { provider: 'claude', model: 'opus', effort: 'high' } } });
  env.board.adopt(env.c, id);
  return env.c.orchestrations.find(item => item.id === id);
};

test('an agent’s plan becomes draft cards you edit, accept or discard, with what the plan checks found (#162)', async t => {
  const env = setup(t);
  const plan = drafted(env, { questions: ['Should saved items sync across devices?', { question: 'Which store?', options: ['SQLite', 'Files', 'SQLite'] }], steps: [
    { title: 'Build the list page', instructions: 'Show the saved items.', tier: 'light', dependsOn: [], role: 'frontend' },
    { title: 'Agree the API', instructions: 'Write the contract for /api/items.', done: ['The contract lists every field'], files: ['docs/items.md'], tier: 'deep', dependsOn: [1], role: 'backend', artifact: 'contract', phase: 'Contracts' },
    { title: 'Check it all', instructions: 'Run the whole suite.', done: ['Suite passes'], tier: 'standard', dependsOn: [2], role: 'qa', check: 'npm test', phase: 'Verify' },
    { title: 'Polish after QA', instructions: 'Tidy the page.', done: ['Looks right'], tier: 'light', dependsOn: [3], role: 'frontend', phase: 'Verify' },
  ] });
  assert.equal(plan.status, 'moved'); assert.equal(plan.cards.length, 4);
  const cards = plan.cards.map(id => env.card(id)), [page, api, qa, polish] = cards;
  // Each card keeps what its step said and waits for what its step waited for. It's a major card on Smart routing, with no
  // agent of its own, and runs only through its subtasks.
  assert.deepEqual(cards.map(card => [card.title, card.column, card.auto, card.agent, card.split, card.tier, card.role, card.group]), [
    ['Build the list page', 'backlog', true, null, true, 'light', 'frontend', null],
    ['Agree the API', 'backlog', true, null, true, 'deep', 'backend', 'Contracts'],
    ['Check it all', 'backlog', true, null, true, 'standard', 'qa', 'Verify'],
    ['Polish after QA', 'backlog', true, null, true, 'light', 'frontend', 'Verify'],
  ]);
  assert.deepEqual([api.dependsOn, qa.dependsOn, polish.dependsOn], [[page.id], [api.id], [qa.id]]);
  assert.deepEqual([api.artifact, api.files, api.checks, qa.check], ['contract', ['docs/items.md'], [{ text: 'The contract lists every field', done: false }], 'npm test']);
  assert.deepEqual(api.draft.by, { kind: 'agent', provider: 'claude', model: 'opus' });
  assert.deepEqual(api.draft.batch, { id: plan.id, summary: 'Contract first, then the page and its tests.', questions: [{ question: 'Should saved items sync across devices?', options: [] }, { question: 'Which store?', options: ['SQLite', 'Files'] }] });
  assert.equal(api.source.goal, 'Add saved items, with an API and a page.');
  // The plan checks are written on the cards they're about, and change nothing.
  assert.match(page.draft.notes.join(' '), /doesn’t say what done means/);
  assert.match(api.draft.notes.join(' '), /comes after building work \(card 1\)/);
  assert.match(polish.draft.notes.join(' '), /builds on card 3, a QA card/);
  assert.deepEqual(qa.draft.notes, []);
  // A draft can be edited, but runs, moves to Ready and is scheduled only once accepted. Queued messages don't wait for
  // it: the drafts are reviewed on the Plan.
  assert.equal(openPlan(env.c), null, 'Queued messages go on while the plan’s cards are drafts.');
  assert.throws(() => env.board.run(env.c, { ids: [page.id] }), /Accept it before running it/);
  assert.throws(() => env.board.move(env.c, page.id, { column: 'ready' }), /Accept it first/);
  assert.throws(() => env.broker.schedules.create(env.c, { target: { type: 'card', cardId: page.id }, when: { repeat: 'daily', time: '09:00' } }), /Accept it before scheduling it/);
  assert.equal(env.board.edit(env.c, page.id, { checks: ['The list shows every item'], agent: { provider: 'codex' } }).draft.batch.id, plan.id, 'Editing keeps it a draft.');
  assert.deepEqual([env.card(page.id).auto, env.card(page.id).agent.provider], [false, 'codex'], 'Choosing an agent turns Auto off.');
  assert.throws(() => env.board.drafts(env.c, { action: 'keep', ids: [page.id] }), /Accept or discard/);
  // Accepting keeps your edits. A major card stays in Backlog until it has subtasks, and can't run without them.
  env.board.drafts(env.c, { action: 'accept', ids: [page.id, api.id] });
  assert.deepEqual([env.card(page.id).draft, env.card(page.id).column, env.card(api.id).column], [null, 'backlog', 'backlog']);
  env.board.move(env.c, page.id, { column: 'ready' });
  assert.throws(() => env.board.run(env.c, { ids: [page.id] }), /needs subtasks before it can run\. Split it with an agent, or add them yourself/);
  assert.throws(() => env.board.drafts(env.c, { action: 'accept', ids: [page.id] }), /isn’t a draft/);
  // Discarding removes the rest.
  env.board.drafts(env.c, { action: 'discard', ids: [qa.id, polish.id] });
  assert.deepEqual([env.card(qa.id), env.card(polish.id)], [undefined, undefined]);
  // A plan that doesn't fit on the Plan adds nothing, and says why.
  const most = LIMITS.cards; LIMITS.cards = 3; t.after(() => { LIMITS.cards = most; });
  // A redraft from your answers replaces the draft it answered, and keeps the cards you already accepted from it.
  const first = drafted(env, { steps: [{ title: 'Old one', instructions: 'Old.', tier: 'light' }] });
  const id = `plan-${Math.random().toString(16).slice(2, 10)}`, next = parsePlan(JSON.stringify({ summary: 'With your answers.', steps: [{ title: 'New one', instructions: 'New.', tier: 'light' }] }));
  env.broker.record(env.c, { type: 'orchestration_plan', id, plan: { id, goal: 'Answers', source: 'agent', status: 'draft', summary: next.summary, steps: next.steps, replaces: first.id, review: true, revision: 1 } });
  env.board.adopt(env.c, id);
  assert.deepEqual(env.c.board.map(card => card.title), ['Build the list page', 'Agree the API', 'New one']);
  env.board.drafts(env.c, { action: 'discard', ids: [env.c.board.at(-1).id] });
  const big = drafted(env, { steps: [{ title: 'One', instructions: 'One.', tier: 'light' }, { title: 'Two', instructions: 'Two.', tier: 'light' }] });
  assert.deepEqual([big.status, env.c.board.length], ['failed', 2]);
  assert.match(big.summary, /2 cards, and the Plan has room for 1 more/);
});

test('a card on Auto runs with the agent the Plan shows, and a schedule needs an agent it can name (#162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const card = env.add({ title: 'Rename the helper', column: 'ready', agent: null, auto: true, tier: 'light' });
  assert.deepEqual([card.auto, card.agent, card.tier], [true, null, 'light']);
  assert.throws(() => env.board.run(env.c, { ids: [card.id] }), /is on Auto\. Run it from the Plan/);
  assert.throws(() => env.board.run(env.c, { ids: [card.id], assignments: { [card.id]: { provider: 'nobody' } } }), /is on Auto/);
  assert.throws(() => env.broker.schedules.create(env.c, { target: { type: 'card', cardId: card.id }, when: { repeat: 'daily', time: '09:00' } }), /on Auto\. Choose an agent/);
  env.script(card, 'hold');
  const { tasks } = env.board.run(env.c, { ids: [card.id], assignments: { [card.id]: { provider: 'claude', model: null, effort: null, auto: true } } }), task = env.task(tasks[card.id]);
  // Smart routing was chosen on the card, so even in Normal it starts with what was shown and is routed at its size when it
  // starts, under a Flow policy of its own. The card remembers it ran on Smart.
  assert.deepEqual([task.provider, task.routing, env.card(card.id).attempts[0].auto], ['claude', { mode: 'smart', planned: 'light' }, true]);
  assert.equal(env.broker.execution.current(env.c, task.execution?.taskId || Object.keys(env.c.executionPolicies).at(-1)).mode, 'flow');
  env.board.stopMany(env.c, { ids: [card.id] });
  await until(() => column(env, card) === 'ready', 'it to stop');
  assert.throws(() => env.board.stopMany(env.c, { ids: [card.id] }), /None of these cards is running/);
});

test('a card on Auto can choose Saver, Smart or Ultra, and runs its task in that mode', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  assert.throws(() => env.add({ title: 'Bad mode', column: 'ready', auto: true, routingMode: 'max' }), /Choose Saver, Smart or Ultra/);
  const follows = env.add({ title: 'Follows the workspace', column: 'ready', auto: true });
  assert.equal(follows.routingMode, null, 'A card follows the workspace until you choose a mode.');
  const card = env.add({ title: 'Ultra card', column: 'ready', auto: true, routingMode: 'ultra', tier: 'deep' });
  assert.equal(card.routingMode, 'ultra');
  env.script(card, 'hold');
  const { tasks } = env.board.run(env.c, { ids: [card.id], assignments: { [card.id]: { provider: 'claude', model: null, effort: null, auto: true } } }), task = env.task(tasks[card.id]);
  assert.deepEqual(task.routing, { mode: 'ultra', planned: 'deep' });
  const policy = env.broker.execution.current(env.c, task.execution?.taskId || Object.keys(env.c.executionPolicies).at(-1));
  assert.deepEqual([policy.mode, policy.routingMode], ['flow', 'ultra']);
  env.board.stopMany(env.c, { ids: [card.id] });
  await until(() => column(env, card) === 'ready', 'it to stop');
});

test('your yes to charges, asked on the Plan, goes with each card’s task, and is never assumed (#108)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const asked = env.add({ title: 'Charged', column: 'ready' }), unasked = env.add({ title: 'Not asked', column: 'ready' });
  assert.throws(() => env.board.run(env.c, { ids: [asked.id], billingConfirmed: 'yes' }), /Confirm billing explicitly/);
  assert.equal(env.c.parallelTasks?.length || 0, 0, 'A refused run starts nothing.');
  env.script(asked, 'hold'); env.script(unasked, 'hold');
  const yes = env.board.run(env.c, { ids: [asked.id], billingConfirmed: true }).tasks[asked.id];
  const no = env.board.run(env.c, { ids: [unasked.id] }).tasks[unasked.id];
  assert.deepEqual([env.task(yes).billingConfirmed, env.task(no).billingConfirmed], [true, false], 'Without your yes, an agent billed by use stops when its task starts.');
  // A schedule has no one to ask, so it never says yes.
  const timed = env.add({ title: 'Nightly', column: 'ready' });
  env.script(timed, 'hold');
  const schedule = env.broker.schedules.create(env.c, { target: { type: 'card', cardId: timed.id }, when: { repeat: 'daily', time: '09:00' } });
  env.broker.schedules.runNow(env.c, schedule.id);
  const scheduled = env.c.parallelTasks.find(task => task.board?.cardId === timed.id);
  assert.equal(scheduled.billingConfirmed, false);
  env.board.stopMany(env.c, { ids: [asked.id, unasked.id, timed.id] });
  await until(() => [asked, unasked, timed].every(card => column(env, card) === 'ready'), 'them to stop');
});

test('a finished card is tested before the cards after it start, and each card is briefed from what they did (#162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  let command = { command: 'node -e "console.log(\'contract broken\');process.exit(2)"', directory: '' };
  env.broker.tasks.tests = { saved: () => command };
  const contract = env.add({ title: 'Agree the API', column: 'ready', role: 'backend', artifact: 'contract', group: 'Contracts' });
  const page = env.add({ title: 'Build the page', column: 'ready', role: 'frontend', dependsOn: [contract.id], files: ['public/items.js'], check: 'npm test', group: 'Build' });
  env.board.run(env.c, { ids: [page.id, contract.id] });
  const taskOf = card => env.task(env.card(card.id).task);
  await until(() => taskOf(contract)?.stepCheck?.status === 'done', 'the first card’s tests');
  assert.equal(taskOf(contract).stepCheck.outcome, 'failed');
  await until(() => /tests failed on “Agree the API”/.test(taskOf(page)?.reason || ''), 'the second card to be held');
  assert.equal(taskOf(page).status, 'waiting', 'Nothing builds on a card whose tests failed.');
  await until(() => env.card(contract.id).result?.tests === 'failed', 'the card’s result to show its tests');
  const shown = env.board.list(env.c).find(item => item.id === contract.id);
  assert.deepEqual([shown.column, shown.taskState.tests, shown.taskState.holds], ['review', 'failed', true]);
  assert.match(shown.taskState.testOutput, /contract broken/);
  assert.match(env.c.messages.at(-1).text, /tests failed on “Agree the API”, so the cards after it wait/);
  assert.throws(() => env.board.proceed(env.c, page.id), /Nothing is holding|Only a finished/);
  // Continuing anyway is your call; the next card is told the tests failed, and what the first card reported.
  env.board.proceed(env.c, contract.id);
  await until(() => env.card(page.id).column === 'review', 'the second card to finish');
  const brief = env.captured(fs.realpathSync(env.folder('a'))).map(capture => capture.context.currentRequest).find(text => text.startsWith('Build the page'));
  assert.ok(brief, 'The second card ran.');
  assert.match(brief, /^Build the page \(frontend\)/);
  assert.match(brief, /Files or folders it expects to change: public\/items\.js/);
  assert.match(brief, /Acceptance check: npm test/);
  assert.match(brief, /This builds on these cards, which have finished:\n- “Agree the API” \(backend\)/);
  assert.match(brief, /Tests failed on its result: node -e/);
  assert.match(brief, /Its contract, in its own words:/);
  assert.match(brief, /Check the files themselves/);
  assert.deepEqual(Object.keys(taskOf(page).builtOn), [contract.id]);
  // Checking again with tests that pass replaces the result on the card.
  command = { command: 'node -e "process.exit(0)"', directory: '' };
  env.board.recheck(env.c, contract.id);
  await until(() => env.card(contract.id).result?.tests === 'passed', 'the tests to pass');
  assert.equal(env.board.list(env.c).find(item => item.id === contract.id).taskState.holds, false);
  // The cards' tasks count toward their groups' totals.
  const ledgers = await env.broker.tasks.ledgers();
  assert.deepEqual([...new Set(ledgers.map(item => item.plan?.id))].sort(), ['group:Build', 'group:Contracts']);
});

// Closed to agents (#97): a card or the whole Plan that Codeshi never puts in a prompt, and the Plan attached to a message.
test('a card or the Plan closed to agents can’t run, be scheduled or attached, and stays out of briefs and exports (#97)', async t => {
  const env = setup(t);
  const open = env.add({ title: 'Build the form', notes: 'Visible notes.', column: 'ready' });
  const shut = env.add({ title: 'Salary bands', notes: 'SECRET-BANDS', column: 'ready', closed: true });
  const after = env.add({ title: 'Wire it up', column: 'ready', dependsOn: [open.id, shut.id] });
  assert.equal(shut.closed, true); assert.equal(open.closed, false);
  assert.throws(() => env.board.run(env.c, { ids: [shut.id] }), /“Salary bands” is closed to agents/);
  assert.throws(() => env.broker.schedules.create(env.c, { target: { type: 'card', cardId: shut.id }, when: { at: new Date(Date.now() + 3600000).toISOString(), repeat: 'once' } }), /closed to agents, so it can’t be scheduled/);
  // The card after it isn't told its title or its result, even once it has one.
  env.c.board.find(item => item.id === shut.id).result = { status: 'complete', summary: 'SECRET-RESULT' };
  const prompt = env.board.prompt(env.c, env.card(after.id)), brief = env.board.brief(env.c, { id: 'x', board: { cardId: after.id } }).text;
  for (const text of [prompt, brief]) { assert.match(text, /Build the form/); assert.doesNotMatch(text, /Salary bands|SECRET/); }
  // Export leaves it out unless you ask for everything, and then says it's closed.
  const plain = env.board.markdown(env.c), every = env.board.markdown(env.c, { includeClosed: true });
  assert.doesNotMatch(plain, /Salary bands|SECRET/); assert.match(plain, /1 card closed to agents is left out/);
  assert.match(every, /### Salary bands[\s\S]*- Closed to agents/); assert.match(every, /keep this file where agents can’t read it/);
  // Attaching: the Plan without the closed card, a single open card, and never the closed one.
  assert.throws(() => env.board.attach(env.c, { cardId: shut.id }), /closed to agents/);
  const whole = env.board.attach(env.c, {}), single = env.board.attach(env.c, { cardId: open.id });
  assert.deepEqual([whole.cards, whole.leftOut, whole.attachment.name, whole.attachment.kind, whole.attachment.plan], [2, 1, 'Plan.md', 'text', { cards: 2, whole: true }]);
  assert.equal(single.attachment.name, 'Card – Build the form.md');
  const text = env.broker.attachments.forAgent(whole.attachment.id).text;
  assert.match(text, /^# Plan/); assert.match(text, /## Wire it up[\s\S]*Waits for: “Build the form”$/m); assert.doesNotMatch(text, /Salary bands|SECRET/);
  assert.match(env.broker.attachments.forAgent(single.attachment.id).text, /Cards that wait for it: “Wire it up”/);
  // Asked from the Plan with a card open (#162): the whole Plan, naming that card at the top, and never a closed one.
  const focused = env.board.attach(env.c, { focus: open.id });
  assert.equal(focused.attachment.name, 'Plan.md'); assert.notEqual(focused.attachment.id, whole.attachment.id);
  assert.match(env.broker.attachments.forAgent(focused.attachment.id).text, /^# Plan\n\n.+\n\nThe person has the card “Build the form” open beside the Plan, so “this card” in the message means it\.\n\n## /);
  assert.equal(env.board.attach(env.c, { focus: open.id }).attachment.id, focused.attachment.id, 'The same Plan sends the same attachment.');
  assert.throws(() => env.board.attach(env.c, { focus: shut.id }), /closed to agents/);
  // Closing a card that was attached keeps the attachment out of every prompt from then on, and says so with the message.
  env.board.edit(env.c, open.id, { closed: true });
  assert.equal(env.broker.attachments.forAgent(whole.attachment.id).text, '[Left out: a card in it was closed to agents after it was attached.]');
  assert.equal(env.broker.attachments.select([whole.attachment.id])[0].withheld, 'a card in it was closed to agents after it was attached');
  env.board.edit(env.c, open.id, { closed: false });
  assert.match(env.broker.attachments.forAgent(whole.attachment.id).text, /Build the form/);
  // An upload can't claim to be a Plan attachment.
  const uploaded = env.broker.attachments.put({ name: 'notes.md', data: Buffer.from('hello').toString('base64'), plan: { conversationId: env.c.id, cards: [open.id] } });
  assert.equal(uploaded.plan, undefined); assert.equal(env.broker.attachments.read(uploaded.id).plan, undefined);
  // The whole Plan: nothing runs, is attached or scheduled, and the setting survives a restart.
  assert.deepEqual(env.board.access(env.c, { closed: true }), { closed: true });
  assert.equal(env.board.view(env.c).closed, true);
  assert.throws(() => env.board.run(env.c, { ids: [open.id] }), /This Plan is closed to agents/);
  assert.throws(() => env.board.attach(env.c, {}), /This Plan is closed to agents/);
  assert.equal(env.broker.attachments.forAgent(single.attachment.id).text, '[Left out: the Plan was closed to agents after it was attached.]');
  assert.doesNotMatch(env.board.markdown(env.c), /Build the form/);
  assert.throws(() => env.board.access(env.c, { closed: 'yes' }), /Say whether agents can read the Plan/);
  await env.reopen();
  assert.equal(env.board.view(env.c).closed, true, 'Closing the Plan is kept with the workspace.');
  assert.equal(env.broker.attachments.forAgent(single.attachment.id).withheld, 'the Plan was closed to agents after it was attached');
  env.board.access(env.c, { closed: false });
  assert.equal(env.broker.attachments.forAgent(single.attachment.id).withheld, undefined);
});

test('a Plan attachment closed after it was sent is left out of the prompt every agent gets next, including after a switch (#97)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const card = env.add({ title: 'Checkout API', notes: 'PLAN-DETAIL-42', column: 'ready' });
  const { attachment } = env.board.attach(env.c, { cardId: card.id });
  const place = fs.realpathSync(env.folder('a')), scenarios = path.join(place, '.mock-scenarios.json');
  // The mock agent repeats what it was asked unless told what to say; a real one might quote it too, which no setting can undo.
  const asked = `Read the attached card.\n\nAttached file "${attachment.name}":\n${env.broker.attachments.forAgent(attachment.id).text}`;
  fs.writeFileSync(scenarios, JSON.stringify({ ...JSON.parse(fs.readFileSync(scenarios, 'utf8')), [asked]: { text: 'I read it.' } }));
  env.broker.start(env.c, { text: 'Read the attached card.', attachments: [attachment.id], provider: 'codex', mode: 'read', approvalPolicy: 'ask' });
  await env.broker.running.done;
  assert.match(JSON.stringify(env.captured(place).at(-1).context), /PLAN-DETAIL-42/, 'While it is open, the agent reads the card.');
  // Switching agent sends the conversation again from the start, and the attachment goes with it.
  env.broker.start(env.c, { text: 'Take over.', provider: 'claude', mode: 'read', approvalPolicy: 'ask' });
  await env.broker.running.done;
  assert.equal(env.captured(place).at(-1).provider, 'claude');
  assert.match(env.captured(place).at(-1).prompt, /PLAN-DETAIL-42/, 'An open attachment stays with the conversation through a switch.');
  env.board.edit(env.c, card.id, { closed: true });
  // Once closed, a fresh start gets only a note that it was left out.
  env.broker.start(env.c, { text: 'Carry on.', provider: 'codex', mode: 'read', approvalPolicy: 'ask', fresh: true });
  await env.broker.running.done;
  const next = env.captured(place).at(-1);
  assert.equal(next.provider, 'codex');
  assert.doesNotMatch(next.prompt, /PLAN-DETAIL-42/);
  assert.match(next.prompt, /Left out: a card in it was closed to agents after it was attached/);
  // Sending it again is listed with the message, marked as left out.
  env.broker.start(env.c, { text: 'Once more.', attachments: [attachment.id], provider: 'codex', mode: 'read', approvalPolicy: 'ask' });
  await env.broker.running.done;
  assert.doesNotMatch(env.captured(place).at(-1).prompt, /PLAN-DETAIL-42/);
  assert.equal(env.c.messages.findLast(message => message.role === 'user').attachments[0].withheld, 'a card in it was closed to agents after it was attached');
});

test('every agent’s prompt is put together without a closed Plan attachment: Codex, Claude, Gemini and Antigravity (#97)', async t => {
  const env = setup(t);
  const card = env.add({ title: 'Pricing rules', notes: 'PRIVATE-PRICING', column: 'ready' });
  const { attachment } = env.board.attach(env.c, {});
  env.c.messages.push({ id: 'm1', seq: 1, role: 'user', text: 'Plan with this.', attachments: [attachment], provider: 'codex', createdAt: new Date().toISOString() });
  const build = (provider, fresh) => prepareContext(env.c, 'Next step.', { workspace: env.list[0].path, workspaceFolders: env.list, provider, fresh, attachments: [], readAttachment: id => env.broker.attachments.forAgent(id) }).prompt;
  for (const provider of ['codex', 'claude', 'gemini', 'antigravity']) assert.match(build(provider, true), /PRIVATE-PRICING/, `${provider} reads it while it's open.`);
  env.board.edit(env.c, card.id, { closed: true });
  for (const provider of ['codex', 'claude', 'gemini', 'antigravity']) for (const fresh of [true, false]) {
    const prompt = build(provider, fresh);
    assert.doesNotMatch(prompt, /PRIVATE-PRICING|Pricing rules/, `${provider} never gets a closed card.`);
    if (fresh) assert.match(prompt, /Left out: a card in it was closed to agents/);
  }
});

test('a card or the Plan can’t be closed to agents while an agent works on it (#97)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const card = env.add({ title: 'Long job', column: 'ready' });
  env.script(card, 'hold');
  env.board.run(env.c, { ids: [card.id] });
  await until(() => env.task(env.card(card.id).task)?.status === 'running', 'the card to start');
  assert.throws(() => env.board.edit(env.c, card.id, { closed: true }), /Stop it before closing it to agents/);
  assert.throws(() => env.board.access(env.c, { closed: true }), /An agent is working on “Long job”\. Stop it before closing the Plan to agents/);
  env.board.stop(env.c, card.id);
  await until(() => column(env, card) === 'ready', 'the card to stop');
  assert.equal(env.board.edit(env.c, card.id, { closed: true }).closed, true);
});

// Subtasks (#155): a major card is split into subtasks when it starts, and each runs in the card's task.
function scriptMatch(env, part, scenario) {
  const folder = env.folder('a'), file = path.join(folder, '.mock-scenarios.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved[`~${part}`] = scenario; fs.writeFileSync(file, JSON.stringify(saved)); git(folder, 'commit', '-qam', 'script');
}
const requests = env => env.captured(fs.realpathSync(env.folder('a'))).map(capture => capture.context.currentRequest);

test('a major card is split with an agent before it runs, each subtask runs in its task, and its tests run after the last (#155, #162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => ({ command: 'node -e "process.exit(0)"', directory: '' }) };
  const card = env.add({ title: 'Build checkout', column: 'backlog', split: true, notes: 'A cart and a receipt.' });
  assert.equal(card.split, true);
  assert.throws(() => env.board.run(env.c, { ids: [card.id] }), /isn’t in Ready|needs subtasks/);
  // Split with an agent: one read-only run, before anything runs. The subtasks wait for you, and the card moves to Ready.
  scriptMatch(env, 'into subtasks, before any work', { text: `Here it is:\n${JSON.stringify({ cards: [{ card: 1, subtasks: [{ title: 'Add the cart', instructions: 'A cart model.', tier: 'light' }, { title: 'Add the receipt', instructions: 'A receipt page.', tier: 'deep' }] }] })}` });
  assert.equal(env.board.split(env.c, { ids: [card.id], provider: 'codex' }).kind, 'split');
  await until(() => env.c.boardSuggest?.status === 'complete', 'the split to finish');
  const [split] = env.captured(fs.realpathSync(env.folder('a')));
  assert.deepEqual(split.args.slice(split.args.indexOf('--sandbox'), split.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only'], 'The split only reads.');
  assert.match(split.context.currentRequest, /# Card 1\n\nBuild checkout\n\nA cart and a receipt\./, 'The split is planned from the card’s own brief.');
  assert.match(split.context.currentRequest, /Return only a JSON object with cards/);
  assert.match(env.c.boardSuggest.summary, /Split “Build checkout” into 2 subtasks\./);
  assert.deepEqual([env.card(card.id).column, env.card(card.id).subtasks.map(item => item.status)], ['ready', ['pending', 'pending']]);
  scriptMatch(env, 'Subtask 1 of 2', { behavior: 'hold', text: 'Added the cart model and its tests.' });
  env.board.run(env.c, { ids: [card.id] });
  await until(() => env.card(card.id).subtasks?.[0]?.status === 'running', 'the first subtask');
  const { subtasks } = env.card(card.id), [first, second] = subtasks;
  assert.deepEqual(subtasks.map(item => [item.title, item.tier, item.by.kind]), [['Add the cart', 'light', 'agent'], ['Add the receipt', 'deep', 'agent']]);
  assert.equal(env.task(env.card(card.id).task).status, 'running');
  // While it runs: the subtasks that haven't started are yours to edit, remove and add to; the running one isn't.
  const act = input => env.board.subtasks.act(env.c, card.id, input);
  assert.throws(() => act({ action: 'edit', subtaskId: first.id, title: 'Changed' }), /An agent is working on that subtask/);
  act({ action: 'edit', subtaskId: second.id, instructions: 'A receipt page with totals.' });
  act({ action: 'add', title: 'Email the receipt', tier: 'light', agent: { provider: 'claude' } });
  assert.deepEqual(env.card(card.id).subtasks.at(-1).agent, { provider: 'claude', model: null, effort: null });
  act({ action: 'add', title: 'Not needed' });
  act({ action: 'remove', subtaskId: env.card(card.id).subtasks.at(-1).id });
  assert.throws(() => act({ action: 'clear' }), /Stop it before splitting it again/);
  assert.equal(env.card(card.id).revision, 2, 'Editing subtasks isn’t a change to what the card says; only the split was.');
  env.release(env.folder('a'));
  await until(() => env.card(card.id).column === 'review', 'the card to finish');
  const done = env.card(card.id).subtasks;
  assert.deepEqual(done.map(item => [item.title, item.status, item.provider]), [['Add the cart', 'done', 'codex'], ['Add the receipt', 'done', 'codex'], ['Email the receipt', 'done', 'claude']]);
  assert.equal(done[0].summary, 'Added the cart model and its tests.');
  // Each subtask continues the same task, told its place among the others.
  const asked = requests(env);
  assert.equal(asked.length, 4, 'One split, then one run for each subtask.');
  assert.ok(asked[1].startsWith('Build checkout'), 'The first subtask is the task’s first run, so it carries the card’s brief.');
  assert.match(asked[1], /Subtask 1 of 2 for the card “Build checkout”: Add the cart\n\nA cart model\./);
  assert.match(asked[2], /^Subtask 2 of 3 for the card “Build checkout”: Add the receipt\n\nA receipt page with totals\./);
  assert.match(asked[2], /Do only this subtask\. One more follows: “Email the receipt”\./);
  assert.match(asked[3], /^Subtask 3 of 3[\s\S]*This is the card’s last subtask/);
  const task = env.task(env.card(card.id).task);
  assert.equal(task.status, 'complete');
  await until(() => env.card(card.id).result?.tests === 'passed', 'the card’s tests after its last subtask');
  // Export lists them.
  assert.match(env.board.markdown(env.c), /Subtasks:\n\n1\. \[x\] Add the cart\n2\. \[x\] Add the receipt\n3\. \[x\] Email the receipt/);
});

test('a paused major card stops after its subtask, Run carries on from the next, and a bad split fails the card (#155)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  // Subtasks you write yourself make the card a major card, and it isn't split again.
  const card = env.add({ title: 'Ship search', column: 'ready' });
  const act = input => env.board.subtasks.act(env.c, card.id, input);
  act({ action: 'add', title: 'Index the items', instructions: 'Build the index.' });
  act({ action: 'add', title: 'Search box' });
  assert.equal(env.card(card.id).split, true);
  assert.throws(() => act({ action: 'pause' }), /Only a running card can be paused/);
  scriptMatch(env, 'Subtask 1 of 2', { behavior: 'hold', text: 'Indexed.' });
  env.board.run(env.c, { ids: [card.id] });
  await until(() => env.card(card.id).subtasks[0].status === 'running', 'the first subtask');
  act({ action: 'pause' });
  env.release(env.folder('a'));
  await until(() => env.card(card.id).column === 'ready', 'the card to pause');
  assert.equal(env.card(card.id).reason, 'Paused after 1 of 2 subtasks. Run carries on from “Search box”.');
  assert.deepEqual(env.card(card.id).subtasks.map(item => item.status), ['done', 'pending']);
  let asked = requests(env);
  assert.equal(asked.length, 1, 'No split: the card already had its subtasks.');
  assert.ok(asked[0].startsWith('Ship search'), 'The first run of a task carries the card’s brief.');
  assert.match(asked[0], /Subtask 1 of 2 for the card “Ship search”: Index the items\n\nBuild the index\./);
  // Run carries on in a new task, told what the earlier subtasks did.
  env.board.run(env.c, { ids: [card.id] });
  await until(() => env.card(card.id).column === 'review', 'the card to finish');
  asked = requests(env);
  assert.match(asked[1], /Subtasks already done for this card, by earlier runs:\n- 1\. Index the items: Indexed\./);
  assert.match(asked[1], /Subtask 2 of 2 for the card “Ship search”: Search box/);
  assert.equal(env.card(card.id).subtasksPaused, false);
  // Sent back, a major card gets one more subtask for what should change. Cleared, it needs subtasks again, and a split
  // that isn't JSON changes nothing.
  env.board.sendBack(env.c, card.id, { reason: 'Rethink it.' });
  assert.deepEqual(env.card(card.id).subtasks.at(-1).title, 'Address: Rethink it.');
  assert.equal(env.card(card.id).subtasks.at(-1).status, 'pending');
  act({ action: 'clear' });
  assert.deepEqual(env.card(card.id).subtasks, []);
  assert.throws(() => env.board.run(env.c, { ids: [card.id] }), /needs subtasks before it can run/);
  scriptMatch(env, 'into subtasks, before any work', { text: 'I would rather not.' });
  env.board.split(env.c, { ids: [card.id], provider: 'codex' });
  await until(() => env.c.boardSuggest?.status === 'failed', 'the split to fail');
  assert.equal(env.c.boardSuggest.summary, 'The split didn’t return its subtasks as JSON.');
  assert.deepEqual(env.card(card.id).subtasks, []);
});

test('each subtask runs with the agent and model chosen on it, is routed at its size on Smart, or else uses the card’s agent (#155, #162)', async () => {
  const { Subtasks, parseSplit } = await import('../src/subtasks.mjs');
  const card = { id: 'k', title: 'Card', split: true, auto: true, subtasks: [{ id: 'a', title: 'One', instructions: 'Do one.', tier: 'light', agent: null, status: 'pending' }, { id: 'b', title: 'Two', instructions: '', tier: 'deep', agent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, status: 'pending' }] };
  const calls = [], board = { cards: () => [card], update: (c, target, changes) => Object.assign(target, changes), main: { tasks: { update() {}, sync() {}, admit() { if (full) throw Object.assign(new Error('2 tasks are already running, the most this workspace\'s task limits allow at once.'), { status: 409 }); }, closed: false } } };
  let full = false;
  const lane = { c: {}, broker: { start: (c, input) => { calls.push(['start', input]); return {}; }, dispatch: async (c, input) => { calls.push(['dispatch', input]); } } };
  const subtasks = new Subtasks(board), base = { id: 't', board: { cardId: 'k' }, provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', accessMode: 'edit', approvalPolicy: 'ask', billingConfirmed: false, execution: {} };
  card.task = 't';
  await subtasks.launch({}, { ...base, routing: { mode: 'smart', planned: 'standard' } }, lane, card, card.subtasks[0]);
  subtasks.launch({}, { ...base, routing: { mode: 'smart', planned: 'standard' } }, lane, card, card.subtasks[1]);
  card.subtasks[0].status = 'pending';
  subtasks.launch({}, base, lane, card, card.subtasks[0]);
  // A card with its own agent: a subtask that follows it uses that agent, and one set to Smart is routed.
  card.auto = false; card.subtasks[0].status = 'pending';
  subtasks.launch({}, { ...base, routing: { mode: 'smart', planned: 'standard' } }, lane, card, card.subtasks[0]);
  card.subtasks[0].auto = true; card.subtasks[0].status = 'pending';
  await subtasks.launch({}, { ...base, routing: { mode: 'smart', planned: 'standard' } }, lane, card, card.subtasks[0]);
  assert.deepEqual(calls.map(([how, input]) => [how, input.provider, input.model, input.effort ?? null, input.routing?.planned ?? null, input.mode]), [['dispatch', 'codex', 'gpt-6.1-sol', 'medium', 'light', 'edit'], ['start', 'claude', 'claude-opus-5-5', 'high', null, 'edit'], ['start', 'codex', 'gpt-6.1-sol', 'medium', null, 'edit'], ['start', 'codex', 'gpt-6.1-sol', 'medium', null, 'edit'], ['dispatch', 'codex', 'gpt-6.1-sol', 'medium', 'light', 'edit']]);
  // A full workspace stops the subtask before anything changes, so the card waits for a slot and its routed start can't fail later.
  full = true; card.subtasks[0].status = 'pending'; const before = calls.length;
  assert.throws(() => subtasks.launch({}, { ...base, routing: { mode: 'smart', planned: 'standard' } }, lane, card, card.subtasks[0]), /already running, the most/);
  assert.equal(calls.length, before); assert.equal(card.subtasks[0].status, 'pending'); full = false;
  // Splitting several cards in one run: one list per card, in order; a card the reply leaves out gets none.
  const { parseSplitCards } = await import('../src/subtasks.mjs');
  assert.deepEqual(parseSplitCards('{"cards":[{"card":2,"subtasks":[{"title":"B1"}]},{"card":1,"subtasks":[{"title":"A1"},{"title":"A2"}]}]}', 3).map(list => list?.map(item => item.title) ?? null), [['A1', 'A2'], ['B1'], null]);
  assert.throws(() => parseSplitCards('{"cards":[]}', 2), /didn’t return any subtasks/);
  // The split's reply: JSON anywhere in it, each subtask with a title; a size it doesn't know is standard.
  assert.deepEqual(parseSplit('Sure: {"subtasks":[{"title":"A","tier":"huge"}]}').map(item => [item.title, item.tier, item.status]), [['A', 'standard', 'pending']]);
  assert.throws(() => parseSplit('{"subtasks":[]}'), /didn’t return any subtasks/);
  assert.throws(() => parseSplit('{"subtasks":[{"instructions":"x"}]}'), /Subtask 1 from the split has no title/);
});

test('drafts accept and discard can be undone and redone cleanly, and undo stops once a card runs (#162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const a = env.add({ title: 'Step A', column: 'backlog', agent: null, auto: true });
  const b = env.add({ title: 'Step B', column: 'backlog', agent: null, auto: true, dependsOn: [a.id] });
  const d = env.add({ title: 'Downstream', column: 'backlog', dependsOn: [a.id] });
  const batch = { id: 'plan-undo', summary: 'Two drafted cards.' };
  env.board.update(env.c, env.card(a.id), { draft: { by: { kind: 'agent', provider: 'claude', model: 'opus' }, at: new Date().toISOString(), batch, notes: [] } });
  env.board.update(env.c, env.card(b.id), { draft: { by: { kind: 'agent', provider: 'claude', model: 'opus' }, at: new Date().toISOString(), batch, notes: [] } });

  // Accept both -> moves them to Ready, clears draft, returns undoId.
  const accepted = env.board.drafts(env.c, { action: 'accept', ids: [a.id, b.id] });
  assert.equal(accepted.accepted, 2);
  assert.ok(accepted.undoId);
  assert.deepEqual([env.card(a.id).draft, env.card(a.id).column, env.card(b.id).column], [null, 'ready', 'ready']);

  // Undo accept -> restores drafts and Backlog column/order.
  const undoneAccept = env.board.drafts(env.c, { action: 'undo', undoId: accepted.undoId });
  assert.deepEqual(undoneAccept, { undone: 'accept', count: 2, ids: [a.id, b.id] });
  assert.equal(env.card(a.id).draft.batch.id, 'plan-undo');
  assert.deepEqual([env.card(a.id).column, env.card(a.id).acceptedDraftAt, env.card(b.id).column], ['backlog', null, 'backlog']);
  assert.throws(() => env.board.drafts(env.c, { action: 'undo', undoId: accepted.undoId }), /Nothing left to undo/);

  // Discard A -> removes A and drops A from B and Downstream dependsOn.
  const discarded = env.board.drafts(env.c, { action: 'discard', ids: [a.id] });
  assert.equal(discarded.discarded, 1);
  assert.equal(env.card(a.id), undefined);
  assert.deepEqual(env.card(b.id).dependsOn, []);
  assert.deepEqual(env.card(d.id).dependsOn, []);

  // Undo discard -> restores A and restores dependsOn on B and Downstream.
  const undoneDiscard = env.board.drafts(env.c, { action: 'undo', undoId: discarded.undoId });
  assert.deepEqual(undoneDiscard, { undone: 'discard', count: 1, ids: [a.id] });
  assert.equal(env.card(a.id).title, 'Step A');
  assert.equal(env.card(a.id).draft.batch.id, 'plan-undo');
  assert.deepEqual(env.card(b.id).dependsOn, [a.id]);
  assert.deepEqual(env.card(d.id).dependsOn, [a.id]);

  // Accepting and running a card refuses undo once it starts.
  const acceptAgain = env.board.drafts(env.c, { action: 'accept', ids: [a.id] });
  env.script(env.card(a.id), 'hold');
  env.board.run(env.c, { ids: [a.id], assignments: { [a.id]: { provider: 'codex', model: null, effort: null, auto: true } } });
  await until(() => env.card(a.id).column === 'doing', 'card A to start');
  assert.throws(() => env.board.drafts(env.c, { action: 'undo', undoId: acceptAgain.undoId }), /already run or moved/);
  env.board.stop(env.c, a.id);
  await until(() => column(env, a) === 'ready', 'card A to stop');
});

test('Suggest next reads the card and open neighbors in a read-only run, drafts 1-3 linked cards, and supports Stop and restart (#162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const upstream = env.add({ title: 'Set up schema', column: 'ready', role: 'database', artifact: 'schema', group: 'Auth' });
  env.board.update(env.c, env.card(upstream.id), { column: 'done' });
  const target = env.add({ title: 'Add OAuth login', notes: 'Handle GitHub callback.', column: 'ready', role: 'builder', group: 'Auth', dependsOn: [upstream.id], at: { x: 100, y: 200 } });
  env.board.update(env.c, env.card(target.id), { column: 'review', result: { status: 'complete', summary: 'Added OAuth routes.', files: 2, tests: 'passed' } });
  const waiting = env.add({ title: 'Add logout', column: 'backlog', dependsOn: [target.id], group: 'Auth' });
  const other = env.add({ title: 'Polish header', column: 'ready', group: 'UI' });
  const secret = env.add({ title: 'Salary bands', notes: 'SECRET-SUGGEST', column: 'backlog', closed: true });

  // Closed card or closed Plan is refused and never enters the prompt.
  const promptText = env.board.suggestPrompt(env.c, env.card(target.id));
  assert.match(promptText, /Target card: Add OAuth login/);
  assert.match(promptText, /Added OAuth routes/);
  assert.match(promptText, /Upstream cards that this card waits for[\s\S]*Set up schema/);
  assert.match(promptText, /Cards already waiting for the target card[\s\S]*Add logout/);
  assert.match(promptText, /Other open cards in this Plan[\s\S]*Polish header/);
  assert.doesNotMatch(promptText, /Salary bands|SECRET-SUGGEST/);
  assert.throws(() => env.board.suggest(env.c, secret.id, { provider: 'codex' }), /closed to agents/);
  env.board.access(env.c, { closed: true });
  assert.throws(() => env.board.suggest(env.c, target.id, { provider: 'codex' }), /This Plan is closed to agents/);
  env.board.access(env.c, { closed: false });

  // Real suggest run with mock-cli returning 2 linked cards (including a contract root card after builder to exercise plan check).
  const reply = JSON.stringify({
    summary: 'Verify login and document the session contract.',
    questions: ['Keep GitHub only for now?'],
    steps: [
      { title: 'Document session contract', instructions: 'Write auth session schema.', done: ['Session fields listed'], tier: 'light', dependsOn: [], role: 'backend', artifact: 'contract' },
      { title: 'Test OAuth flow', instructions: 'Run login integration tests.', done: ['All login tests pass'], tier: 'standard', dependsOn: [1], role: 'qa', check: 'npm test', phase: 'Verify' },
    ],
  });
  scriptMatch(env, 'Suggest 1 to 3 follow-up cards', { text: reply });
  const started = env.board.suggest(env.c, target.id, { provider: 'codex' });
  assert.equal(started.status, 'running');
  await until(() => env.c.boardSuggest?.status === 'complete', 'suggest next to finish');

  // Worker ran read-only.
  const cap = env.captured(fs.realpathSync(env.folder('a'))).at(-1);
  assert.deepEqual(cap.args.slice(cap.args.indexOf('--sandbox'), cap.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.equal(env.c.boardSuggest.cards.length, 2);

  const [first, second] = env.c.boardSuggest.cards.map(id => env.card(id));
  assert.equal(first.title, 'Document session contract');
  assert.deepEqual(first.dependsOn, [target.id]);
  assert.deepEqual([first.auto, first.agent, first.group, first.folderId], [true, null, 'Auth', 'a']);
  assert.deepEqual(first.at, { x: 390, y: 200 });
  assert.equal(first.draft.batch.kind, 'suggest');
  assert.equal(first.draft.batch.cardId, target.id);
  assert.equal(first.draft.batch.cardTitle, 'Add OAuth login');
  assert.match(first.draft.notes.join(' '), /contract comes after building work/);

  assert.equal(second.title, 'Test OAuth flow');
  assert.deepEqual(second.dependsOn, [first.id]);
  assert.equal(second.group, 'Verify');
  assert.deepEqual(second.at, { x: 680, y: 200 });

  // Hold -> activeWorkers includes it -> Stop -> interrupted -> Dismiss.
  scriptMatch(env, 'Suggest 1 to 3 follow-up cards', { behavior: 'hold', text: reply });
  env.board.suggest(env.c, target.id, { provider: 'codex' });
  await until(() => env.board.suggestJobs.size === 1, 'suggest job to be tracked');
  assert.equal(env.broker.tasks.activeWorkers >= 1, true);
  env.board.stopSuggest(env.c);
  await until(() => env.c.boardSuggest?.status === 'interrupted', 'suggest next to stop');
  assert.equal(env.c.boardSuggest.summary, 'Stopped suggesting next cards.');
  env.board.dismissSuggest(env.c);
  assert.equal(env.c.boardSuggest, null);

  // More than 3 suggested cards is rejected cleanly.
  scriptMatch(env, 'Suggest 1 to 3 follow-up cards', { text: JSON.stringify({ summary: 'Too many', steps: [1, 2, 3, 4].map(n => ({ title: `Card ${n}`, instructions: `Do ${n}.`, tier: 'light' })) }) });
  env.board.suggest(env.c, target.id, { provider: 'codex' });
  await until(() => env.c.boardSuggest?.status === 'failed', 'over-limit suggestion to fail');
  assert.match(env.c.boardSuggest.summary, /more than the 3/i);
  env.board.dismissSuggest(env.c);

  // Restart recovery marks an interrupted suggest run cleanly.
  env.broker.record(env.c, { type: 'board_suggest', suggest: { id: 'sug-restart', cardId: target.id, cardTitle: target.title, provider: 'codex', model: null, effort: null } });
  assert.equal(env.c.boardSuggest.status, 'running');
  await env.reopen();
  assert.equal(env.c.boardSuggest.status, 'interrupted');
  assert.match(env.c.boardSuggest.summary, /restarted/i);
});

// Watching the Plan run (#162 stage 5): a task's usage as the Plan shows it. Working time comes as what finished runs took
// plus when the running ones began, so the page counts the minutes and isn't sent a new number on every update.
test('a running card’s task reports its usage with the start of the runs still going, and a saved total once its lane is gone', () => {
  const budget = new TaskBudgets({ record() {}, emit() {} });
  const state = { taskId: 't1', runs: 2, retries: 1, reviews: 0, handoffs: 1, workingMs: 90000, tokens: { input: 1000, output: 200, cacheWrite: 0, cacheRead: 5000 }, spendUSD: 0.25, runsWithoutUsage: 0, runsWithPartialUsage: 0, runsWithoutCost: 0, spendCaps: {}, failures: {}, extra: {}, active: { r2: { provider: 'codex', startedAt: '2026-11-13T10:00:00.000Z', usage: null, costUSD: null, billing: 'subscription' }, r3: { provider: 'claude', startedAt: '2026-11-13T09:59:00.000Z', usage: null, costUSD: null, billing: 'subscription' } } };
  const lane = { c: { taskBudgets: { t1: state } }, broker: { budget } };
  const usageOf = TaskCoordinator.prototype.usageOf;
  assert.deepEqual(usageOf.call({ lanes: new Map() }, { id: 't1' }, lane), { workedMs: 90000, activeSince: '2026-11-13T09:59:00.000Z', tokens: 1200, spendUSD: 0.25, retries: 1, reviews: 0, handoffs: 1 });
  // A part that ended before a restart reads the usage saved on its task.
  assert.deepEqual(usageOf.call({ lanes: new Map() }, { id: 't2', budgetUsed: { workingMs: 60000, tokens: 400, spendUSD: 0, retries: 0, reviews: 1, handoffs: 0 } }), { workedMs: 60000, activeSince: null, tokens: 400, spendUSD: 0, retries: 0, reviews: 1, handoffs: 0 });
  assert.equal(usageOf.call({ lanes: new Map() }, { id: 't3' }), null, 'A task with nothing recorded shows no usage.');
});

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
import { AGENT_COMMENTS, LIMITS, commentItems, planChanges, openQuestions } from '../src/board.mjs';
import { TaskBudgets } from '../src/task-budget.mjs';
import { TaskCoordinator } from '../src/task-coordinator.mjs';
import { openPlan, parsePlan, parseSuggest, planningRequest } from '../src/orchestration.mjs';
import { summarizePlans } from '../src/task-ledger.mjs';
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
  await until(() => task.scopePath && env.captured(task.scopePath).length, 'the card’s task to start');
  const sent = env.captured(task.scopePath)[0].context.currentRequest;
  assert.match(sent, /^Fix the footer\n\nIt overlaps on phones\.\n\nDone means:\n- Looks right at 375 px/);
  assert.throws(() => env.board.edit(env.c, card.id, { notes: 'Changed while it works' }), /Stop it first/, 'What the agent works from stays as it started.');
  assert.equal(env.board.edit(env.c, card.id, { labels: ['later'] }).labels[0], 'later', 'Labels can still change.');
  assert.throws(() => env.board.accept(env.c, card.id), /Only a card in Review/);
  env.release(task.scopePath);
  await until(() => column(env, card) === 'review', 'the card to reach Review');
  const shown = env.board.list(env.c)[0];
  assert.equal(shown.result.summary, 'Moved the footer below the content. Checked at 375 px.');
  assert.equal(shown.result.status, 'complete'); assert.equal(shown.result.inCopy, true);
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
  assert.equal(env.card(card.id).reason, 'Stopped before it finished. Its copy is still in Tasks, to merge or discard.'); assert.equal(env.card(card.id).task, null);
  assert.equal(env.card(card.id).attempts[0].outcome, 'stopped');
  // Run again: it finishes this time, and is sent back from Review with a note.
  env.board.run(env.c, { ids: [card.id] });
  await until(() => env.task(env.card(card.id).task)?.status === 'running' && env.task(env.card(card.id).task)?.scopePath, 'the second try to start');
  env.release(env.task(env.card(card.id).task).scopePath);
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
  // A Plan card running in its own copy never blocks Workspace chat (no 409 Project files are busy).
  assert.equal(env.task(tasks[first.id]).mode, 'worktree');
  env.broker.start(env.c, { text: 'Main work while card runs', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' });
  await env.broker.running.done;
  assert.equal(env.c.status, 'complete');
  assert.equal(env.task(tasks[first.id]).status, 'running');
  env.release(env.task(tasks[first.id]).scopePath);
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
  assert.deepEqual([column(env, working), env.card(working.id).reason], ['ready', 'Stopped before it finished. Its copy is still in Tasks, to merge or discard.'], 'What was working is known to have stopped.');
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
  fs.writeFileSync(path.join(env.task(tasks[card.id]).scopePath, 'made.txt'), 'by the card\n');
  assert.throws(() => env.board.accept(env.c, card.id), /Review and merge them first/);
  assert.throws(() => env.board.sendBack(env.c, card.id), /Discard them in its task first/);
  env.release(fs.realpathSync(env.folder('a'))); await main.done;
  await env.broker.tasks.integrate(env.c, tasks[card.id], { digest: env.broker.tasks.review(env.c, tasks[card.id]).digest });
  await until(() => env.card(card.id).result.status === 'integrated', 'the card to see the merge');
  assert.equal(env.card(card.id).result.files, 1);
  assert.equal(env.board.accept(env.c, card.id).column, 'done');
});

test('a card that saves files Git ignores waits for its folder rather than work in a copy that would lose them', { skip: scriptCLIs }, async t => {
  const env = setup(t), folder = env.folder('a');
  fs.appendFileSync(path.join(folder, '.gitignore'), 'output/\n'); git(folder, 'commit', '-qam', 'ignore output');
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(folder)).length, 'the main run');
  const notes = env.add({ title: 'Launch notes', column: 'ready', files: ['output/launch/notes.md', 'README.md'] }), code = env.add({ title: 'Code', column: 'ready', files: ['src/'] });
  env.script(notes, null, 'Wrote the notes.'); env.script(code, null, 'Changed the code.');
  const { tasks } = env.board.run(env.c, { ids: [notes.id, code.id] });
  await until(() => column(env, code) === 'review', 'the code card to finish in its copy');
  assert.equal(env.task(tasks[code.id]).mode, 'worktree', 'A card whose files Git keeps still works in a copy.');
  const waiting = env.task(tasks[notes.id]);
  assert.deepEqual([waiting.status, waiting.mode, waiting.ignoredFiles], ['waiting', undefined, ['output/launch/notes.md']]);
  assert.match(waiting.reason, /^The main conversation is using this repository, and this card saves files Git ignores \(output\/launch\/notes\.md\), which its own copy would lose\. So it waits until that finishes/);
  assert.equal(env.board.public(env.c, env.card(notes.id)).taskState.reason, waiting.reason, 'The Plan shows why it waits.');
  env.release(fs.realpathSync(folder)); await main.done;
  await until(() => column(env, notes) === 'review', 'the notes card to run once the folder is free');
  assert.equal(env.task(tasks[notes.id]).mode, 'direct', 'It works in the folder itself.');
});

// A card works in a copy made from the last commit, and merging a card commits nothing. So the cards a card waits for
// would be missing from its copy: their files are brought into it from the folder (task-coordinator.mjs before).
// What the mock agent does for each card is found by the card's title at the start of its request, followed by a line
// break: a card's request also names, in quotes, the cards it builds on and the cards after it.
function chain(t, scripts, { ignore = '' } = {}) {
  const env = setup(t), folder = env.folder('a'), file = path.join(folder, '.mock-scenarios.json');
  env.broker.tasks.tests = { saved: () => null };
  const own = Object.fromEntries(Object.entries(scripts).map(([key, value]) => [key.startsWith('~') ? `${key}\n` : key, value]));
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...own }));
  if (ignore) fs.appendFileSync(path.join(folder, '.gitignore'), ignore);
  git(folder, 'commit', '-qam', 'script');
  const taskOf = card => env.task(env.card(card.id).task);
  return { env, folder, taskOf, head: git(folder, 'rev-parse', 'HEAD').trim(),
    read: (place, name) => fs.existsSync(path.join(place, name)) ? fs.readFileSync(path.join(place, name), 'utf8') : null,
    started: card => until(() => { const task = taskOf(card); return task?.scopePath && env.captured(task.scopePath).length ? task : null; }, `“${card.title}” to start`),
    inReview: card => until(() => column(env, card) === 'review' && taskOf(card)?.stepCheck?.status === 'done', `“${card.title}” to reach Review`),
    merge: card => env.broker.tasks.integrate(env.c, taskOf(card).id, { digest: env.broker.tasks.review(env.c, taskOf(card).id).digest }) };
}

test('a card starts with what the cards it waits for merged, in this run or an earlier one, and a card sent back with what it merged itself (#162)', { skip: scriptCLIs }, async t => {
  const { env, folder, taskOf, head, read, started, inReview, merge } = chain(t, {
    '~Write the docs': { behavior: 'hold', text: 'Wrote the docs.' },
    '~Build the page': { behavior: 'hold', text: 'Built the page.' },
    '~Build the API': { text: 'Built the API.', write: { 'api.js': 'api\n' } },
  });
  const api = env.add({ title: 'Build the API', column: 'ready' }), page = env.add({ title: 'Build the page', column: 'ready', dependsOn: [api.id] }), docs = env.add({ title: 'Write the docs', column: 'ready', dependsOn: [page.id] });
  // An earlier run: the API card alone, merged and accepted. Merging commits nothing.
  env.board.run(env.c, { ids: [api.id] });
  await inReview(api); await merge(api); env.board.accept(env.c, api.id);
  assert.deepEqual([column(env, api), git(folder, 'rev-parse', 'HEAD').trim(), git(folder, 'status', '--porcelain')], ['done', head, '?? api.js\n']);
  // A later run: the page waits for the API on the Plan, though its task waits for no task of this run.
  env.board.run(env.c, { ids: [page.id] });
  const first = await started(page), sent = env.captured(first.scopePath)[0].context;
  assert.deepEqual([first.dependsOn, first.mode, read(first.scopePath, 'api.js'), first.carried], [null, 'worktree', 'api\n', { from: head, files: 1 }]);
  assert.match(sent.currentRequest, /- “Build the API”\n {2}Its changes were merged into the folder\.\n {2}Files it changed: api\.js/);
  assert.ok(sent.taskScope.includes('so this copy also has the file it changed, as it is in a now (`git diff --stat '), sent.taskScope);
  // The page's own work is merged, and the card is then sent back: its next run carries on from what it merged.
  fs.writeFileSync(path.join(first.scopePath, 'page.js'), 'page\n'); env.release(first.scopePath);
  await inReview(page);
  assert.deepEqual(env.broker.tasks.review(env.c, first.id).files.map(file => file.path), ['page.js'], 'Its changes are only its own, not the API card’s.');
  await merge(page);
  env.board.sendBack(env.c, page.id, { reason: 'Add a footer.' });
  env.board.run(env.c, { ids: [page.id, docs.id] });
  const second = await started(page);
  assert.notEqual(second.id, first.id);
  assert.deepEqual([read(second.scopePath, 'api.js'), read(second.scopePath, 'page.js'), second.carried.files], ['api\n', 'page\n', 2]);
  fs.writeFileSync(path.join(second.scopePath, 'page.js'), 'page\nfooter\n'); env.release(second.scopePath);
  await inReview(page);
  assert.deepEqual(env.broker.tasks.review(env.c, second.id).files.map(file => [file.path, file.change, file.status]), [['page.js', 'update', 'clean']], 'It changed the file it merged before, rather than adding it again beside the folder’s.');
  await merge(page);
  // Two cards on, the docs card has all of it: the API from the earlier run, and the page as its second run left it.
  const third = await started(docs);
  assert.deepEqual([read(third.scopePath, 'api.js'), read(third.scopePath, 'page.js'), third.carried.files], ['api\n', 'page\nfooter\n', 2]);
  env.release(third.scopePath); await inReview(docs);
  assert.equal(git(folder, 'rev-parse', 'HEAD').trim(), head, 'Nothing was committed along the way.');
});

test('a card after one that worked in the folder itself starts with the files that one changed, and without what Git ignores (#162)', { skip: scriptCLIs }, async t => {
  const { env, taskOf, read, started } = chain(t, {
    '~Use the notes': { behavior: 'hold', text: 'Used them.' },
    '~Write the launch notes': { text: 'Wrote the notes.', write: { 'README.md': 'Launch\n', 'output/notes.md': 'notes\n' }, changes: [{ path: 'README.md', kind: 'add' }, { path: 'output/notes.md', kind: 'add' }] },
  }, { ignore: 'output/\n' });
  // A card that saves a file Git ignores works in the folder, as a copy would lose it. The card after it works in a copy.
  const notes = env.add({ title: 'Write the launch notes', column: 'ready', files: ['output/notes.md', 'README.md'] }), after = env.add({ title: 'Use the notes', column: 'ready', dependsOn: [notes.id] });
  env.board.run(env.c, { ids: [notes.id, after.id] });
  const task = await started(after);
  assert.deepEqual([taskOf(notes).mode, task.mode], ['direct', 'worktree']);
  assert.deepEqual([read(task.scopePath, 'README.md'), read(task.scopePath, 'output/notes.md'), task.carried.files], ['Launch\n', null, 1]);
  env.release(task.scopePath);
  await until(() => column(env, after) === 'review', 'the second card to finish');
});

test('a card whose copy changed nothing is accepted without merging, and a discarded copy keeps the card in Review', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folder('a'))).length, 'the main run');
  const research = env.add({ title: 'Research', column: 'ready' }), built = env.add({ title: 'Build', column: 'ready' });
  env.script(research, null, 'The answer is **here**, in full.'); env.script(built, null, 'Built it.');
  const { tasks } = env.board.run(env.c, { ids: [research.id, built.id] });
  await until(() => column(env, research) === 'review' && column(env, built) === 'review', 'both to finish in their copies');
  await until(() => !(env.c.parallelTasks || []).some(task => task.stepCheck?.status === 'running'), 'their checks');
  assert.equal(env.task(tasks[research.id]).copyFiles, 0, 'The copy itself is counted, not what the agent said.');
  assert.equal(env.board.public(env.c, env.card(research.id)).taskState.copyFiles, 0);
  // The whole answer is read from the card's task.
  assert.equal(env.board.answer(env.c, research.id).text, 'The answer is **here**, in full.');
  // One note in the workspace chat when the run is over, and only one.
  const notes = () => env.c.messages.filter(message => message.role === 'system' && /The Plan’s run of 2 cards ended/.test(message.text));
  await until(() => notes().length === 1, 'the end-of-run note');
  assert.match(notes()[0].text, /2 to review/);
  // Nothing to merge: accepting frees the copy.
  const worktree = env.task(tasks[research.id]).worktree;
  assert.equal(env.board.accept(env.c, research.id).column, 'done');
  assert.equal(env.task(tasks[research.id]).status, 'integrated'); assert.equal(fs.existsSync(worktree), false);
  assert.equal(column(env, research), 'done', 'Freeing the copy doesn’t move the card.');
  // Discarding a copy with changes keeps the card in Review with its answer, to accept without them.
  fs.writeFileSync(path.join(env.task(tasks[built.id]).scopePath, 'made.txt'), 'by the card\n');
  assert.throws(() => env.board.accept(env.c, built.id), /Review and merge them first/);
  env.release(fs.realpathSync(env.folder('a'))); await main.done;
  env.broker.tasks.discard(env.c, tasks[built.id]);
  assert.equal(column(env, built), 'review'); assert.equal(env.card(built.id).result.status, 'discarded'); assert.equal(env.card(built.id).result.summary, 'Built it.');
  assert.equal(env.card(built.id).reason, null);
  assert.equal(env.board.accept(env.c, built.id).column, 'done');
  assert.equal(notes().length, 1);
});

test('resolving a card’s merge conflict in its copy keeps its report, and a resolve that stops leaves it in Review', { skip: scriptCLIs }, async t => {
  const env = setup(t), folder = env.folder('a'), scenarios = path.join(folder, '.mock-scenarios.json');
  fs.writeFileSync(path.join(folder, 'page.md'), 'Title\n');
  fs.writeFileSync(scenarios, JSON.stringify({ ...JSON.parse(fs.readFileSync(scenarios, 'utf8')), '~Settle every conflict here': { behavior: 'hold', text: 'Kept both titles.' } }));
  git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'page');
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(folder)).length, 'the main run');
  const card = env.add({ title: 'Retitle', column: 'ready' });
  env.script(card, null, 'Changed the title.');
  const { tasks } = env.board.run(env.c, { ids: [card.id] }), id = tasks[card.id];
  await until(() => column(env, card) === 'review' && env.task(id).stepCheck?.status === 'done', 'it to finish in its copy');
  const copy = env.task(id).scopePath;
  fs.writeFileSync(path.join(copy, 'page.md'), 'Card title\n');
  env.release(fs.realpathSync(folder)); await main.done;
  fs.writeFileSync(path.join(folder, 'page.md'), 'Folder title\n');
  env.broker.tasks.resolve(env.c, id, { digest: env.broker.tasks.review(env.c, id).digest });
  await until(() => column(env, card) === 'doing', 'the card to work again');
  assert.equal(env.board.public(env.c, env.card(card.id)).taskState.resolving, true);
  // Stopped part-way: the card's own work is as it finished, so it stays in Review.
  const resolves = () => env.captured(copy).filter(item => String(item.context.currentRequest).includes('Settle every conflict here')).length;
  await until(() => resolves() === 1, 'the resolving run'); env.lane(id).broker.stop(env.lane(id).c.id);
  await until(() => column(env, card) === 'review' && env.task(id).status === 'stopped', 'the card back in Review');
  assert.match(env.card(card.id).reason, /^Resolving its merge conflicts was stopped/); assert.equal(env.task(id).resolve.open, true);
  // Again, to the end.
  env.broker.tasks.resolve(env.c, id, { digest: env.broker.tasks.review(env.c, id).digest });
  await until(() => column(env, card) === 'doing' && resolves() === 2, 'the second resolving run');
  fs.writeFileSync(path.join(copy, 'page.md'), 'Card title\nFolder title\n'); env.release(copy);
  await until(() => column(env, card) === 'review' && env.task(id).status === 'complete' && env.task(id).stepCheck?.status === 'done', 'the card back in Review');
  assert.deepEqual([env.card(card.id).reason, env.card(card.id).result.summary, env.task(id).stepResult.summary], [null, 'Changed the title.', 'Changed the title.'], 'Its report is still its own.');
  assert.deepEqual(env.board.answer(env.c, card.id).followUps, [], 'Resolving isn’t a follow-up you asked.');
  assert.deepEqual(env.task(id).laterRuns.map(item => item.kind), ['resolve', 'resolve']);
  await env.broker.tasks.integrate(env.c, id, { digest: env.broker.tasks.review(env.c, id).digest });
  assert.equal(fs.readFileSync(path.join(folder, 'page.md'), 'utf8'), 'Card title\nFolder title\n');
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

test('a reply’s “Comments for other cards” are read one per item, up to the next heading, and one that says none is none', () => {
  assert.deepEqual(commentItems('Moved the API to v2.\n\n## Comments for other cards\n- “Build the page”: totals are `total_cents` now.\n  They’re integers.\n- **QA**: try an empty cart.\n\nThat’s all.\n\n## Questions for you\n- Keep v1?'),
    ['“Build the page”: totals are `total_cents` now.\nThey’re integers.', '**QA**: try an empty cart.']);
  assert.deepEqual(commentItems('**Comments for other cards:**\n1. Release: ship the config first.\n2) QA — check the totals.'), ['Release: ship the config first.', 'QA — check the totals.']);
  assert.deepEqual(commentItems('Comments for other cards: - “QA”: check totals'), ['“QA”: check totals']);
  assert.deepEqual(commentItems('Done.\n\nComments for other cards: none.'), []);
  assert.deepEqual(commentItems('### Comments for other cards\nNo comments.'), []);
  assert.deepEqual(commentItems('Done.\n\n## Comments\n- QA: x'), [], 'Only the heading it was asked for counts.');
  assert.deepEqual(commentItems('## Comments for other cards\n- QA: x\n\n```json\n{"verdict":"pass"}\n```'), ['QA: x'], 'A review’s verdict ends it.');
});

test('a card’s agent leaves comments on the cards after it, and the agent doing one is told only those you accept (#97)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => null };
  const api = env.add({ title: 'Agree the API', column: 'ready' });
  const page = env.add({ title: 'Build the checkout page', dependsOn: [api.id] });
  const qa = env.add({ title: 'QA', dependsOn: [page.id] });
  const secret = env.add({ title: 'Secret pricing', dependsOn: [api.id] });
  env.board.edit(env.c, secret.id, { closed: true });
  const readme = env.add({ title: 'Write the README' });
  // Told which cards come after it, nearest first, and how to comment on them; never a card closed to agents.
  const asked = env.board.prompt(env.c, env.card(api.id));
  assert.match(asked, /Other agents do the cards after this one: “Build the checkout page”, “QA”\. If you learned something whoever does one of them should know[\s\S]*heading “Comments for other cards”/);
  assert.doesNotMatch(asked, /Secret pricing/);
  assert.doesNotMatch(env.board.prompt(env.c, env.card(readme.id)), /Comments for other cards/, 'A card with none after it isn’t asked.');
  env.script(api, null, ['Agreed the API: v2, with prices in cents.', '', '## Comments for other cards',
    '- “Build the checkout page”: totals are `total_cents` now, as integers.', '- **QA**: try an empty cart too.',
    '- Secret pricing: use the 2027 prices.', '- Agree the API: done.', '- “No such card”: hello.', '- Write the README — mention v2.'].join('\n'));
  const { tasks } = env.board.run(env.c, { ids: [api.id] });
  await until(() => column(env, api) === 'review', 'the card to finish');
  const task = env.task(tasks[api.id]), from = comment => comment.by;
  const [onPage] = env.board.comments(env.c, page.id), [onQa] = env.board.comments(env.c, qa.id);
  assert.equal(onPage.text, 'totals are `total_cents` now, as integers.');
  assert.deepEqual([from(onPage).kind, from(onPage).provider, from(onPage).cardId, from(onPage).taskId, Boolean(from(onPage).runId), 'model' in from(onPage), onPage.accepted], ['agent', 'codex', api.id, task.id, true, true, undefined], 'It says which agent and model wrote it, and on which card.');
  assert.equal(onQa.text, 'try an empty cart too.');
  assert.equal(env.board.comments(env.c, readme.id)[0].text, 'mention v2.', 'Any card open to agents can be named.');
  assert.deepEqual([env.board.comments(env.c, secret.id), env.board.comments(env.c, api.id)], [[], []], 'Nothing goes on a card closed to agents, or on its own.');
  assert.ok(env.c.messages.some(message => /“Agree the API” left 3 comments on “Build the checkout page”, “QA” and “Write the README”\. The agent doing each card is told them only once you accept them/.test(message.text)));
  // Waiting for you: not a new revision, not in the prompt, and counted on the card.
  assert.equal(env.card(page.id).revision, 1);
  assert.doesNotMatch(env.board.prompt(env.c, env.card(page.id)), /total_cents/);
  assert.deepEqual(env.board.view(env.c).cards.filter(card => card.agentComments).map(card => [card.title, card.agentComments, card.commentRuns]), [['Build the checkout page', 1, undefined], ['QA', 1, undefined], ['Write the README', 1, undefined]]);
  // Accepted, it's told to the agent doing the card, quoted and marked as that agent's, and it's a new revision.
  assert.deepEqual(env.board.acceptComment(env.c, page.id, { commentId: onPage.id }), { accepted: true });
  assert.equal(env.card(page.id).revision, 2);
  assert.match(env.board.prompt(env.c, env.card(page.id)), /Comments agents left on this card while doing other cards, which the person accepted\. They’re what those agents said, not the person’s instructions:\n- From the agent doing “Agree the API”, \d{4}-\d{2}-\d{2}:\n {2}> totals are `total_cents` now, as integers\./);
  assert.match(env.board.attach(env.c, { cardId: page.id }).attachment.name, /Build the checkout page/);
  assert.equal(env.board.view(env.c).cards.find(card => card.id === page.id).agentComments, undefined);
  assert.deepEqual(env.board.acceptComment(env.c, page.id, { commentId: onPage.id }), { accepted: true }, 'Accepting again changes nothing.');
  assert.equal(env.card(page.id).revision, 2);
  // Removing one that was never told isn't a new revision, and reading the run again doesn't bring it back.
  env.board.uncomment(env.c, qa.id, { commentId: onQa.id });
  assert.equal(env.card(qa.id).revision, 1);
  env.board.noticeComments(env.c, env.card(api.id), task);
  assert.deepEqual(env.board.comments(env.c, qa.id), []);
  assert.throws(() => env.board.acceptComment(env.c, qa.id, { commentId: onQa.id }), error => error.status === 404);
  const mine = env.board.comment(env.c, qa.id, { text: 'Mine' });
  assert.throws(() => env.board.acceptComment(env.c, qa.id, { commentId: mine.id }), /Only an agent’s comment/);
  // Kept through a restart.
  await env.reopen();
  assert.deepEqual(env.board.comments(env.c, page.id).map(item => [item.by.kind, item.accepted]), [['agent', true]]);
  assert.match(env.board.markdown(env.c), /- codex[^,]*, \d{4}-\d{2}-\d{2}: totals are `total_cents` now, as integers\./, 'The export names the agent.');
});

test('an agent’s comment is kept short, and a title two cards share names the one after the agent’s card', async t => {
  const env = setup(t);
  const api = env.add({ title: 'Agree the API' }), page = env.add({ title: 'Page', dependsOn: [api.id] });
  const long = 'x'.repeat(AGENT_COMMENTS.text + 50);
  const reply = ['## Comments for other cards', ...Array.from({ length: 7 }, (_, index) => `- Page: note ${index} ${index === 0 ? long : ''}`)].join('\n');
  const targets = env.board.commentTargets(env.c, env.card(api.id), reply);
  assert.equal(targets.length, 7);
  assert.equal(targets[0].text.length, AGENT_COMMENTS.text, 'Clipped to its limit.');
  // Two cards with the same title: the one after this card.
  const other = env.add({ title: 'Page' });
  assert.deepEqual(env.board.commentTargets(env.c, env.card(api.id), '## Comments for other cards\n- “Page”: hi').map(item => item.target.id), [page.id]);
  env.board.remove(env.c, page.id);
  const copy = env.add({ title: 'Page' });
  assert.deepEqual(env.board.commentTargets(env.c, env.card(api.id), '## Comments for other cards\n- “Page”: hi'), [], 'Neither is after it, so it names no single card.');
  assert.ok(other && copy);
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
  assert.equal((await call(`/api/board/cards/${id}/accept-comment`, { commentId: commented.body.comment.id })).status, 400, 'Only an agent’s comment is accepted: yours are told already.');
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
const drafted = (env, { steps, summary = 'Contract first, then the page and its tests.', questions = [], remove, replaces }) => {
  const id = `plan-${Math.random().toString(16).slice(2, 10)}`, plan = parsePlan(JSON.stringify({ summary, questions, steps, ...(remove ? { remove } : {}) }));
  assert.equal(plan.status, 'draft', 'The fixture is a valid plan.');
  env.broker.record(env.c, { type: 'orchestration_plan', id, plan: { id, goal: 'Add saved items, with an API and a page.', source: 'agent', status: 'draft', summary: plan.summary, steps: plan.steps, ...(plan.remove ? { remove: plan.remove } : {}), ...(replaces ? { replaces } : {}), ...(plan.questions ? { questions: plan.questions } : {}), review: true, revision: 1, planner: { provider: 'claude', model: 'opus', effort: 'high' } } });
  env.board.adopt(env.c, id);
  return env.c.orchestrations.find(item => item.id === id);
};

test('Ask tells the agent to reply in prose, draft replies reach later agents as notes, and a stray draft reply can become draft cards (#162)', t => {
  const env = setup(t);
  const steps = [{ title: 'Add a sitemap', instructions: 'Generate sitemap.xml.', tier: 'light', dependsOn: [] }, { title: 'Check it', instructions: 'Validate the sitemap.', tier: 'light', dependsOn: [1], role: 'qa' }];
  const json = JSON.stringify({ summary: 'A sitemap, then a check.', questions: [], steps });
  // A Draft cards run: its reply is JSON, and it became cards on the Plan.
  const plan = drafted(env, { steps, summary: 'A sitemap, then a check.' });
  env.broker.message(env.c, 'user', 'add SEO cards', 'claude');
  env.broker.message(env.c, 'assistant', json, 'claude', 'drafted-reply', 'complete');
  env.c.messages.at(-1).orchestrationId = plan.id;
  // Ask: the Plan's text says to answer in prose and that a reply can't add cards; attaching it otherwise doesn't.
  const asked = env.board.attach(env.c, { ask: true }), plain = env.board.attach(env.c, {});
  assert.notEqual(asked.attachment.id, plain.attachment.id);
  const askText = env.broker.attachments.forAgent(asked.attachment.id).text;
  assert.match(askText, /^# Plan\n\n.+\n\nSent from the Plan’s Ask mode[^\n]*plain prose[^\n]*can’t add, change or remove cards[^\n]*Draft cards/);
  assert.doesNotMatch(env.broker.attachments.forAgent(plain.attachment.id).text, /Ask mode/);
  assert.match(env.broker.attachments.forAgent(env.board.attach(env.c, { cardId: plan.cards[0], ask: true }).attachment.id).text, /^Sent from the Plan’s Ask mode.+\n\n# Card: Add a sitemap/);
  // An Ask answered with a draft anyway, as a plain reply.
  env.broker.message(env.c, 'user', 'also add a robots.txt card', 'claude');
  env.broker.message(env.c, 'assistant', '```json\n' + JSON.stringify({ summary: 'Robots rules.', steps: [{ title: 'Write robots.txt', instructions: 'Allow search, block training.', tier: 'light', dependsOn: [] }] }) + '\n```', 'claude', 'stray-reply', 'complete');
  // Later agents read both as one-line notes, never as the JSON to copy.
  const context = JSON.parse(prepareContext(env.c, 'What is left?', { workspace: env.list[0].path, workspaceFolders: env.list, provider: 'codex', fresh: true, attachments: [], readAttachment: id => env.broker.attachments.forAgent(id) }).prompt.replace(/^[^\n]*\n/, '')).context;
  const replies = context.filter(item => item.role === 'assistant').map(item => item.text);
  assert.equal(replies.length, 2);
  assert.match(replies[0], /^\[Draft cards reply, shown here as a note\. .*became 2 draft cards on the Plan\. Other replies are plain prose\.\] A sitemap, then a check\.$/);
  assert.match(replies[1], /^\[A reply written as a draft plan of 1 card, shown here as a note\. Replies outside Draft cards are plain prose\.\] Robots rules\.$/);
  assert.ok(replies.every(text => !text.includes('"steps"')));
  // The stray reply's cards go on the Plan as drafts once you ask, once only. Other replies and Draft cards replies can't.
  const before = env.c.board.length;
  assert.deepEqual(env.board.fromReply(env.c, { messageId: 'stray-reply' }), { cards: 1 });
  const added = env.c.board.slice(before);
  assert.deepEqual(added.map(card => [card.title, Boolean(card.draft), card.column, card.auto, card.agent]), [['Write robots.txt', true, 'backlog', true, null]]);
  assert.equal(env.c.orchestrations[0].fromMessage, 'stray-reply');
  assert.throws(() => env.board.fromReply(env.c, { messageId: 'stray-reply' }), /already on the Plan/);
  assert.throws(() => env.board.fromReply(env.c, { messageId: 'drafted-reply' }), /Choose a reply/);
  env.broker.message(env.c, 'assistant', 'Plain prose.', 'claude', 'prose-reply', 'complete');
  assert.throws(() => env.board.fromReply(env.c, { messageId: 'prose-reply' }), error => error.status === 422 && /This reply could not be read as a plan/.test(error.message));
  // Discarding them lets the same reply add them again.
  env.board.drafts(env.c, { action: 'discard', ids: added.map(card => card.id) });
  assert.deepEqual(env.board.fromReply(env.c, { messageId: 'stray-reply' }), { cards: 1 });
});

test('an agent’s plan becomes draft cards you edit, accept or discard, with what the plan checks found (#162)', async t => {
  const env = setup(t);
  const plan = drafted(env, { questions: ['Should saved items sync across devices?', { question: 'Which store?', options: ['SQLite', 'Files', 'SQLite'] }], steps: [
    { title: 'Build the list page', instructions: 'Show the saved items.', tier: 'light', dependsOn: [], role: 'frontend' },
    { title: 'Agree the API', instructions: 'Write the contract for /api/items.', done: ['The contract lists every field'], files: ['docs/items.md'], tier: 'deep', dependsOn: [1], role: 'backend', artifact: 'contract', phase: 'Contracts' },
    { title: 'Check it all', instructions: 'Run the whole suite.', done: ['Suite passes'], tier: 'standard', dependsOn: [2], role: 'qa', check: 'npm test', phase: 'Verify' },
    { title: 'Polish after QA', instructions: 'Tidy the page.', done: ['Looks right'], tier: 'light', dependsOn: [3], role: 'frontend', phase: 'Verify' },
  ] });
  assert.equal(plan.status, 'moved'); assert.equal(plan.cards.length, 5);
  const cards = plan.cards.map(id => env.card(id)), [page, api, qa, polish, review] = cards;
  // Each card keeps what its step said and waits for what its step waited for. It's a major card on Smart routing, with no
  // agent of its own, and runs only through its subtasks. A QA or review card is one pass that ends with a verdict (#89), and
  // a plan that changes code in more than one card ends with a review of the whole result, added by Codeshi.
  assert.deepEqual(cards.map(card => [card.title, card.column, card.auto, card.agent, card.split, card.tier, card.role, card.group]), [
    ['Build the list page', 'backlog', true, null, true, 'light', 'frontend', null],
    ['Agree the API', 'backlog', true, null, true, 'deep', 'backend', 'Contracts'],
    ['Check it all', 'backlog', true, null, false, 'standard', 'qa', 'Verify'],
    ['Polish after QA', 'backlog', true, null, true, 'light', 'frontend', 'Verify'],
    ['Review the whole result', 'backlog', true, null, false, 'standard', 'reviewer', 'Verify'],
  ]);
  assert.deepEqual([api.dependsOn, qa.dependsOn, polish.dependsOn, review.dependsOn], [[page.id], [api.id], [qa.id], [polish.id]]);
  assert.match(review.draft.notes[0], /Codeshi added this review of the whole result/);
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
  env.board.drafts(env.c, { action: 'discard', ids: [qa.id, polish.id, review.id] });
  assert.deepEqual([env.card(qa.id), env.card(polish.id), env.card(review.id)], [undefined, undefined, undefined]);
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
  // Two cards that change code gain a review of the whole result, so the plan needs room for three.
  assert.match(big.summary, /3 new cards, and the Plan has room for 1 more/);
});

test('a draft from the attached Plan changes, merges, regroups and removes its cards instead of adding a copy (#162)', t => {
  const env = setup(t);
  const a = env.add({ title: 'Write the README', column: 'ready', auto: true, group: 'Docs', notes: 'Old notes.' });
  const b = env.add({ title: 'Add SEO tags', group: 'Website', dependsOn: [a.id] });
  const m = env.add({ title: 'Add GEO tags', group: 'Website' });
  const w = env.add({ title: 'Check SEO', dependsOn: [m.id] });
  const gone = env.add({ title: 'Old idea' });
  const shipped = env.add({ title: 'Shipped' });
  env.board.update(env.c, env.card(shipped.id), { column: 'done' });
  const ref = id => env.board.refOf(env.c, id);
  // Draft cards attaches the Plan with each card's Id, and the planner is told to change that Plan, not draft a copy.
  const sent = env.board.attach(env.c, { draft: true });
  assert.match(env.broker.attachments.forAgent(sent.attachment.id).text, new RegExp(`## Write the README\\n\\n- Id: ${ref(a.id)}\\n- Status: Ready\\n- Group: Docs`));
  assert.equal(env.broker.attachments.select([sent.attachment.id])[0].plan.ids, true);
  assert.doesNotMatch(env.broker.attachments.forAgent(env.board.attach(env.c, {}).attachment.id).text, /- Id: /);
  assert.match(planningRequest('Merge the SEO cards', { revising: true }), /treat it as a change to that Plan[^\n]*Never draft a copy/);
  assert.doesNotMatch(planningRequest('Build it'), /attached Plan/);
  // Suggest next still takes only new cards.
  assert.equal(parseSuggest(JSON.stringify({ summary: 'S.', steps: [{ title: 'T', instructions: 'I.', tier: 'light', dependsOn: [ref(a.id)] }] })).status, 'unstructured');
  const count = env.c.board.length;
  const plan = drafted(env, { summary: 'One SEO and GEO card; the README moves to Launch.', steps: [
    { card: ref(a.id), title: 'Rewrite the README', phase: 'Launch' },
    { card: ref(b.id), title: 'Add SEO and GEO tags', instructions: 'Both kinds of tag.', merges: [ref(m.id)] },
    { title: 'Submit the sitemap', instructions: 'In Search Console.', tier: 'light', dependsOn: [2, ref(a.id)], phase: 'Website' },
    { card: ref(shipped.id), title: 'Shipped again' },
  ], remove: [ref(gone.id), 'nope1234'] });
  assert.equal(plan.status, 'moved');
  assert.equal(env.c.board.length, count + 1, 'Only the new card is added; the changed ones aren’t copied.');
  const added = env.c.board.at(-1);
  // A changed card shows its new version as a draft in Backlog, keeping what it was.
  assert.deepEqual([env.card(a.id).title, env.card(a.id).group, env.card(a.id).notes, env.card(a.id).column], ['Rewrite the README', 'Launch', 'Old notes.', 'backlog']);
  assert.deepEqual(env.card(a.id).draft.changed, ['title', 'group']);
  assert.deepEqual([env.card(a.id).draft.was.fields, env.card(a.id).draft.was.column, env.card(a.id).draft.was.draft], [{ title: 'Write the README', group: 'Docs' }, 'ready', null]);
  assert.deepEqual([env.card(b.id).title, env.card(b.id).notes, env.card(b.id).dependsOn], ['Add SEO and GEO tags', 'Both kinds of tag.', [a.id]]);
  assert.deepEqual([env.card(m.id).draft.remove, env.card(m.id).draft.into, env.card(gone.id).draft.remove, env.card(gone.id).draft.into], [true, b.id, true, undefined]);
  assert.deepEqual([added.title, added.group, added.dependsOn, Boolean(added.draft.was)], ['Submit the sitemap', 'Website', [b.id, a.id], false]);
  // What it couldn't change is left alone and said so.
  assert.deepEqual([env.card(shipped.id).title, env.card(shipped.id).draft ?? null], ['Shipped', null]);
  assert.match(added.draft.batch.left.join(' '), /“Shipped” is done, so it wasn’t changed\..*isn’t on the Plan \(nope1234\), so it wasn’t removed/);
  // Accepting keeps the changes: the changed card goes back to Ready, the merged card's waiters wait for the card it
  // merged into, and the removed card goes.
  const drafts = () => env.c.board.filter(card => card.draft).map(card => card.id);
  const accepted = env.board.drafts(env.c, { action: 'accept', ids: drafts() });
  assert.deepEqual([env.card(a.id).column, env.card(a.id).draft, env.card(m.id), env.card(gone.id), env.card(w.id).dependsOn], ['ready', null, undefined, undefined, [b.id]]);
  // Undo brings it all back as drafts.
  env.board.drafts(env.c, { action: 'undo', undoId: accepted.undoId });
  assert.deepEqual([env.card(a.id).column, Boolean(env.card(a.id).draft?.was), env.card(m.id).draft.into, Boolean(env.card(gone.id).draft.remove), env.card(w.id).dependsOn], ['backlog', true, b.id, true, [m.id]]);
  // Discarding puts the changed cards back as they were, keeps the cards marked to remove, and removes the new card.
  env.board.drafts(env.c, { action: 'discard', ids: drafts() });
  assert.deepEqual([env.card(a.id).title, env.card(a.id).group, env.card(a.id).column, env.card(a.id).draft], ['Write the README', 'Docs', 'ready', null]);
  assert.deepEqual([env.card(b.id).title, env.card(b.id).notes, env.card(m.id).draft, env.card(gone.id).column, env.card(added.id)], ['Add SEO tags', '', null, 'backlog', undefined]);
  // A redraft replaces the draft it answered: a change it keeps stays, one it drops goes back.
  const first = drafted(env, { steps: [{ card: ref(a.id), title: 'Draft one' }, { card: ref(b.id), title: 'Draft one too' }] });
  drafted(env, { replaces: first.id, steps: [{ card: ref(b.id), phase: 'Launch' }] });
  assert.deepEqual([env.card(a.id).title, env.card(a.id).draft, env.card(b.id).title, env.card(b.id).group, env.card(b.id).draft.was.fields], ['Write the README', null, 'Draft one too', 'Launch', { title: 'Add SEO tags', group: 'Website' }]);
  env.board.drafts(env.c, { action: 'discard', ids: drafts() });
  assert.deepEqual([env.card(b.id).title, env.card(b.id).group], ['Add SEO tags', 'Website']);
  // A plan that would make cards wait in a circle changes nothing.
  const before = JSON.stringify(env.c.board);
  const circle = drafted(env, { steps: [{ title: 'After README', instructions: 'X.', tier: 'light', dependsOn: [ref(a.id)] }, { card: ref(a.id), dependsOn: [1] }] });
  assert.equal(circle.status, 'failed'); assert.match(circle.summary, /in a circle/);
  assert.equal(JSON.stringify(env.c.board), before);
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

// Flow's Run Ready (#132): you choose the cards and one limit; Flow picks agents for the cards without one.
const flowOn = env => env.broker.setRouting(env.c, { mode: 'smart', executionRevision: env.broker.execution.defaults(env.c).revision });
test('Flow’s Run Ready runs only the cards ticked, gives a card with no agent Auto for that run, and keeps a chosen agent', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const pinned = env.add({ title: 'Pinned', column: 'ready', agent: { provider: 'codex' } });
  const loose = env.add({ title: 'No agent', column: 'ready', agent: null, tier: 'light', dependsOn: [pinned.id] });
  const left = env.add({ title: 'Left in Ready', column: 'ready', agent: null });
  env.script(pinned, 'hold');
  const shared = { maxWorkingMinutes: 30, maxTokens: 200000, maxSpendUSD: null };
  assert.throws(() => env.board.run(env.c, { ids: [pinned.id], shared }), /for Flow’s Run Ready/, 'Normal keeps each card’s own task limits.');
  assert.throws(() => env.board.run(env.c, { ids: [loose.id, pinned.id] }), /Choose an agent for “No agent”/, 'In Normal a card with no agent can’t run.');
  flowOn(env);
  const revision = env.broker.execution.defaults(env.c).revision;
  assert.throws(() => env.board.run(env.c, { ids: [pinned.id], shared: { maxTokens: -5 }, executionRevision: revision }), /positive numbers/);
  assert.throws(() => env.board.run(env.c, { ids: [loose.id, pinned.id], shared, executionRevision: revision }), /is on Auto\. Run it from the Plan/, 'Flow’s pick comes from the Plan, which shows it first.');
  assert.equal(env.c.parallelTasks?.length || 0, 0, 'A refused run starts nothing.');
  const { tasks } = env.board.run(env.c, { ids: [loose.id, pinned.id], shared, executionRevision: revision, assignments: { [loose.id]: { provider: 'claude', model: null, effort: null, auto: true } } });
  const a = env.task(tasks[pinned.id]), b = env.task(tasks[loose.id]);
  assert.deepEqual([a.provider, a.routing, b.provider, b.routing], ['codex', undefined, 'claude', { mode: 'smart', planned: 'light' }], 'The pinned card keeps its agent; the card with none is routed at its size.');
  assert.deepEqual(b.dependsOn, [a.id], 'It still waits for the card it depends on.');
  assert.equal(a.batch.id, b.batch.id); assert.deepEqual(a.batch.limits, shared); assert.equal(a.batch.cards, 2);
  assert.deepEqual([env.card(loose.id).agent, env.card(loose.id).auto, env.card(loose.id).attempts[0].auto, env.card(loose.id).attempts[0].run], [null, false, true, a.batch.id], 'The card itself stays without an agent; the run records Auto.');
  assert.equal(column(env, left), 'ready', 'A Ready card you didn’t tick isn’t added.');
  const [run] = env.board.view(env.c).runs;
  assert.deepEqual([run.cards.sort(), run.limits, run.used.tokens], [[pinned.id, loose.id].sort(), shared, 0]);
  await until(() => env.task(a.id).status === 'running', 'the pinned card to start');
  assert.deepEqual(env.lane(a.id).broker.budget.policy(env.lane(a.id).c).maxTokens, 200000, 'Its task works under the run’s limit, not the workspace’s.');
  env.board.stopMany(env.c, { ids: [pinned.id, loose.id] });
  await until(() => column(env, pinned) === 'ready' && column(env, loose) === 'ready', 'the run to stop');
  assert.deepEqual(env.board.view(env.c).runs, [], 'A stopped run leaves the bar.');
});

test('a card in Flow’s Run Ready doesn’t start once the run has used up its shared limit', { skip: scriptCLIs }, async t => {
  const env = setup(t, ['a', 'b']);
  flowOn(env);
  const first = env.add({ title: 'First', column: 'ready', folderId: 'a' }), second = env.add({ title: 'Second', column: 'ready', folderId: 'b', dependsOn: [first.id] });
  env.script(first, 'hold'); env.script(second, 'hold');
  const { tasks } = env.board.run(env.c, { ids: [first.id, second.id], shared: { maxTokens: 1000 }, executionRevision: env.broker.execution.defaults(env.c).revision });
  await until(() => env.task(tasks[first.id]).status === 'running', 'the first card to start');
  // What the first card's agent reported using, counted for every card in the run.
  const lane = env.lane(tasks[first.id]), state = lane.c.taskBudgets[tasks[first.id]];
  state.tokens.input = 4000;
  assert.equal(env.broker.tasks.sharedUsage(env.c, env.task(tasks[second.id])).tokens, 4000, 'The second card counts what the first used.');
  assert.match(env.broker.tasks.runSpent(env.c, env.task(tasks[second.id]).batch), /used 4,000 tokens, its limit of 1,000/);
  env.release(env.task(tasks[first.id]).scopePath);
  await until(() => column(env, second) === 'ready', 'the second card to be held back');
  assert.equal(env.task(tasks[second.id]).status, 'cancelled');
  assert.match(env.card(second.id).reason, /^Not started: This run has used 4,000 tokens/);
  assert.equal(env.captured(fs.realpathSync(env.folder('b'))).length, 0, 'Its agent was never started.');
  // The second card is held back as soon as the run's limit is used up, which can be before the first card's task ends.
  await until(() => env.task(tasks[first.id]).budgetUsed, 'the first card’s task to end');
  assert.equal(env.task(tasks[first.id]).budgetUsed.tokens, 4000, 'What the first card used is kept with its task.');
});

// Leaving Flow (#132): Flow's Run Ready starts nothing more. Its cards still waiting go back to Ready with the reason,
// whether Flow chose their agent or you did, and a card already working finishes as usual.
const tookOver = 'Not started: you took over from Flow. Run it again when you’re ready.';
test('leaving Flow stops Flow’s Run Ready from starting the cards still waiting, and the card working finishes', { skip: scriptCLIs }, async t => {
  const env = setup(t, ['a', 'b']);
  flowOn(env);
  const first = env.add({ title: 'First', column: 'ready', folderId: 'a' });
  const auto = env.add({ title: 'Auto next', column: 'ready', folderId: 'b', agent: null, tier: 'light', dependsOn: [first.id] });
  const pinned = env.add({ title: 'Pinned next', column: 'ready', folderId: 'b', dependsOn: [first.id] });
  env.script(first, 'hold', 'First is done.');
  const { tasks } = env.board.run(env.c, { ids: [first.id, auto.id, pinned.id], executionRevision: env.broker.execution.defaults(env.c).revision, assignments: { [auto.id]: { provider: 'claude', model: null, effort: null, auto: true } } });
  assert.equal(env.task(tasks[auto.id]).board.flow, true, 'Its tasks are Flow’s Run Ready.');
  await until(() => env.task(tasks[first.id]).status === 'running' && env.task(tasks[first.id]).scopePath, 'the first card to start');
  // No Flow task of the workspace chat's own is active: leaving Flow still ends the run's waiting cards.
  assert.equal(env.broker.execution.active(env.c), null);
  env.broker.setRouting(env.c, { mode: null });
  for (const card of [auto, pinned]) {
    assert.equal(env.task(tasks[card.id]).status, 'cancelled');
    assert.deepEqual([column(env, card), env.card(card.id).reason, env.card(card.id).task], ['ready', tookOver, null], `“${card.title}” is back in Ready with the reason.`);
  }
  assert.equal(column(env, first), 'doing', 'The card already working carries on.');
  env.release(env.task(tasks[first.id]).scopePath);
  await until(() => column(env, first) === 'review', 'the first card to finish');
  await until(() => env.c.messages.some(message => /run of 3 cards ended: 1 to review.*2 back in Ready/.test(message.text || '')), 'the run’s end to be noted');
  assert.deepEqual([column(env, auto), column(env, pinned)], ['ready', 'ready'], 'Finishing it starts neither card that waited for it.');
  assert.equal(env.lane(tasks[auto.id]), undefined); assert.equal(env.lane(tasks[pinned.id]), undefined);
});

test('taking manual control from Flow stops only Flow’s Run Ready: cards you ran in Normal still start in turn', { skip: scriptCLIs }, async t => {
  const env = setup(t, ['a', 'b']);
  const mine = env.add({ title: 'Mine first', column: 'ready', folderId: 'a' }), mineNext = env.add({ title: 'Mine next', column: 'ready', folderId: 'a', dependsOn: [mine.id] });
  env.script(mine, 'hold'); env.script(mineNext);
  const normal = env.board.run(env.c, { ids: [mine.id, mineNext.id] }).tasks;
  assert.equal(env.task(normal[mineNext.id]).board.flow, undefined, 'A run started in Normal isn’t Flow’s.');
  flowOn(env);
  const theirs = env.add({ title: 'Flow first', column: 'ready', folderId: 'b' }), theirsNext = env.add({ title: 'Flow next', column: 'ready', folderId: 'b', agent: null, dependsOn: [theirs.id] });
  env.script(theirs, 'hold');
  const flow = env.board.run(env.c, { ids: [theirs.id, theirsNext.id], executionRevision: env.broker.execution.defaults(env.c).revision, assignments: { [theirsNext.id]: { provider: 'claude', model: null, effort: null, auto: true } } }).tasks;
  // Running, not only preparing its copy: a card still preparing hasn't started, so leaving Flow would send it back too.
  await until(() => [normal[mine.id], flow[theirs.id]].every(id => env.task(id).status === 'running' && env.task(id).scopePath), 'both first cards to start');
  // Taking manual control of the workspace chat's Flow task.
  const chat = env.broker.execution.ensure(env.c, 'chat-task');
  assert.equal(chat.mode, 'flow');
  env.broker.execution.change(env.c, { taskId: chat.taskId, revision: chat.revision, action: 'takeover' });
  assert.equal(env.c.routing, null, 'The workspace left Flow.');
  assert.deepEqual([env.task(flow[theirsNext.id]).status, column(env, theirsNext), env.card(theirsNext.id).reason], ['cancelled', 'ready', tookOver]);
  assert.deepEqual([env.task(normal[mineNext.id]).status, column(env, mineNext)], ['waiting', 'doing'], 'The card you ran in Normal still waits for its turn.');
  env.release(env.task(normal[mine.id]).scopePath);
  await until(() => column(env, mineNext) === 'review', 'the Normal run’s next card to run after the first');
  env.release(env.task(flow[theirs.id]).scopePath);
  await until(() => column(env, theirs) === 'review', 'Flow’s first card to finish');
  assert.equal(column(env, theirsNext), 'ready', 'Flow’s next card didn’t start.');
});

// Lanes that can route: each task's own broker reads these accounts, models and usage, and rates every request light.
// beforeStart, when given, holds each run before its agent's process starts until the promise it returns settles.
const routedLanes = (env, { beforeStart = null } = {}) => {
  env.broker.tasks.BrokerClass = class extends Broker {
    constructor(options) {
      super(options);
      this.availableProviders = () => ['codex'];
      this.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
      this.handoff.models = async () => ({ data: [{ id: 'gpt-6.1-sol', displayName: 'Codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }, { id: 'gpt-6-luna', displayName: 'Mini', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] });
      this.checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }] });
      this.router.worker = async () => JSON.stringify({ tier: 'light', effort: 'low', reason: 'A small change.' });
      if (beforeStart) { const before = this.checkpoints.before.bind(this.checkpoints); this.checkpoints.before = async (...args) => { await beforeStart(); return before(...args); }; }
    }
  };
};

// A card Flow's Run Ready started that is working when you leave Flow carries on as a Normal task with the agent it's on.
test('leaving Flow takes a working Flow card off Flow’s decisions: it finishes with no handoff or reset wait, and its tests still run', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  routedLanes(env);
  env.broker.tasks.tests = { saved: () => ({ command: 'node -e "process.exit(0)"', directory: '' }) };
  flowOn(env);
  const card = env.add({ title: 'Working on Auto', column: 'ready', agent: null, tier: 'light' });
  env.script(card, 'hold', 'Done.');
  const { tasks } = env.board.run(env.c, { ids: [card.id], executionRevision: env.broker.execution.defaults(env.c).revision, assignments: { [card.id]: { provider: 'codex', model: null, effort: null, auto: true } } });
  const id = tasks[card.id];
  await until(() => env.lane(id)?.c?.activeRun && env.captured(env.task(id).scopePath).length, 'the card’s agent to start');
  const lane = env.lane(id), run = lane.broker.running, policyId = env.task(id).execution.taskId;
  assert.equal(lane.broker.handoff.policy(run).automatic, true, 'In Flow it hands off by itself near a limit.');
  env.broker.setRouting(env.c, { mode: null });
  const own = lane.broker.execution.current(lane.c, policyId);
  assert.deepEqual([own.mode, Object.values(own.automation).some(Boolean)], ['normal', false], 'Its own conversation is taken over from Flow.');
  assert.equal(env.broker.execution.current(env.c, policyId).revision, own.revision, 'The workspace records the same policy for it.');
  assert.deepEqual(env.task(id).execution, { taskId: policyId, revision: own.revision }, 'Its task carries the new one.');
  assert.equal(lane.broker.handoff.policy(run).automatic, false, 'Flow no longer hands it off.');
  for (const action of ['handoff', 'wait', 'retry', 'routing']) assert.equal(lane.broker.execution.allows(lane.c, run.execution, { action }), false, `Its run can’t ${action} on Flow’s say-so.`);
  assert.deepEqual([lane.broker.running, column(env, card)], [run, 'doing'], 'The run it’s on carries on.');
  env.release(env.task(id).scopePath);
  await until(() => column(env, card) === 'review' && env.task(id).stepCheck?.status === 'done', 'the card to finish and be tested');
  assert.deepEqual([env.task(id).stepCheck.command, env.task(id).stepCheck.exitCode], ['node -e "process.exit(0)"', 0], 'Its own tests still ran.');
});

test('a card with subtasks that Flow’s Run Ready started carries on after you leave Flow, with the agent it’s on', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  t.after(() => open());
  routedLanes(env, { beforeStart: () => gate });
  flowOn(env);
  const card = env.add({ title: 'Two steps', column: 'ready', auto: true, tier: 'light' });
  for (const title of ['First step', 'Second step']) env.board.subtasks.act(env.c, card.id, { action: 'add', title });
  scriptMatch(env, 'Subtask 1 of 2', { behavior: 'hold', text: 'First step done.' });
  const { tasks } = env.board.run(env.c, { ids: [card.id], executionRevision: env.broker.execution.defaults(env.c).revision, assignments: { [card.id]: { provider: 'codex', model: null, effort: null, auto: true } } });
  const id = tasks[card.id];
  assert.equal(env.task(id).board.flow, true);
  await until(() => env.card(card.id).subtasks[0].status === 'running' && env.lane(id)?.c?.activeRun, 'the first subtask');
  const lane = env.lane(id), policyId = env.task(id).execution.taskId;
  assert(lane.c.activeRun.routing, 'In Flow its subtask is routed.');
  assert.ok(!lane.broker.running.child, 'Its agent hasn’t started yet.');
  // Leaving Flow while that run is still starting: the start goes ahead, as the policy it checks last is still Flow's,
  // and the card is taken over once its agent is up.
  env.broker.setRouting(env.c, { mode: null });
  assert.equal(lane.broker.execution.current(lane.c, policyId).mode, 'flow');
  open();
  await until(() => lane.broker.execution.current(lane.c, policyId).mode === 'normal', 'the card to be taken over once its agent started');
  env.release(env.task(id).scopePath);
  await until(() => column(env, card) === 'review', 'the card to finish');
  assert.deepEqual(env.card(card.id).subtasks.map(sub => sub.status), ['done', 'done']);
  const [first, second] = lane.c.runs.slice(-2);
  assert.deepEqual([second.provider, second.model, Boolean(second.routing)], [first.provider, first.model, false], 'The next subtask runs with the agent the card was on, not one Flow chose.');
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
  const brief = env.captured(taskOf(page).scopePath).map(capture => capture.context.currentRequest).find(text => text.startsWith('Build the page'));
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

// Review and one repair round (#89): a Reviewer card's findings go back to the card they name for one repair run in its own
// task, then the review checks once more. The cards after the review wait throughout.
function reviewRound(t, { second }) {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => null };
  const verdict = value => `I read the changes.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const found = { verdict: 'changes', findings: [{ card: 'Build the API', problem: 'The items route has no auth check.', fix: 'Require a session.', file: 'src/items.js' }] };
  // The mock agent answers by what its request contains, most specific first. A card's own request starts with its title
  // and role, which other requests only name in quotes.
  const folder = env.folder('a'), file = path.join(folder, '.mock-scenarios.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(saved, {
    '~The cards you reviewed had one repair run': { text: verdict(second) },
    '~asked for changes. Fix these': { behavior: 'hold', text: 'Added the session check to the items route.' },
    '~Write the docs\n': { text: 'Wrote the docs.' },
    '~Review the API (reviewer)\n': { text: verdict(found) },
    '~Build the API (backend)\n': { text: 'Built the items route.' },
  });
  fs.writeFileSync(file, JSON.stringify(saved)); git(folder, 'commit', '-qam', 'script');
  const api = env.add({ title: 'Build the API', column: 'ready', role: 'backend' });
  const review = env.add({ title: 'Review the API', column: 'ready', role: 'reviewer', agent: { provider: 'claude' }, dependsOn: [api.id] });
  const docs = env.add({ title: 'Write the docs', column: 'ready', dependsOn: [review.id] });
  env.board.run(env.c, { ids: [api.id, review.id, docs.id] });
  // What each agent was sent, read from the folder and from every copy that is still there (a merged or discarded one is gone).
  const taskOf = card => env.task(env.card(card.id).task), requests = () => [...new Set([folder, ...(env.c.parallelTasks || []).map(item => item.scopePath)].filter(place => place && fs.existsSync(place)).map(place => fs.realpathSync(place)))].flatMap(place => env.captured(place)).map(capture => capture.context.currentRequest);
  return { env, api, review, docs, taskOf, requests, folder };
}

test('a review’s findings go back to the card they name for one repair run, and the review checks again before anything builds on it (#89)', { skip: scriptCLIs }, async t => {
  const { env, api, review, docs, taskOf, requests, folder } = reviewRound(t, { second: { verdict: 'pass' } });
  // The review card is told to end with a verdict, and it ran on another agent than the one that built the API.
  await until(() => taskOf(review)?.review?.status === 'repairing', 'the review to find a problem');
  assert.match(requests().find(text => text.startsWith('Review the API')), /End your report with your verdict as a JSON block/);
  // The API card repairs in its own task, with its own agent, while the cards after the review wait.
  await until(() => requests().some(text => /asked for changes\. Fix these/.test(text)), 'the repair to start');
  const repair = requests().find(text => /asked for changes\. Fix these/.test(text));
  assert.match(repair, /^A review card, “Review the API”, checked this card’s work/);
  assert.match(repair, /1\. The items route has no auth check\. Fix: Require a session\. \(src\/items\.js\)/);
  await until(() => env.card(api.id).column === 'doing', 'the API card to be working again');
  const shown = env.board.list(env.c);
  assert.equal(shown.find(item => item.id === api.id).taskState.repairOf.title, 'Review the API');
  assert.deepEqual(shown.find(item => item.id === review.id).taskState.review.findings.map(item => item.cardTitle), ['Build the API']);
  assert.equal(shown.find(item => item.id === review.id).taskState.holds, true);
  assert.equal(taskOf(docs).status, 'waiting');
  await until(() => /to repair what it found and review again/.test(taskOf(docs).reason || ''), 'the docs card to say why it waits');
  env.release(taskOf(api).scopePath);
  // The review checks the repair, with what the repair reported, and passes: only then do the docs start.
  await until(() => taskOf(review)?.review?.status === 'passed', 'the second review to pass');
  const again = requests().find(text => text.startsWith('The cards you reviewed had one repair run'));
  assert.match(again, /- “Build the API”: Added the session check to the items route\./);
  assert.match(again, /This is the last review round/);
  await until(() => env.card(docs.id).column === 'review', 'the docs card to finish');
  const order = requests();
  assert.ok(order.findIndex(text => text.startsWith('Write the docs')) > order.findIndex(text => text.startsWith('The cards you reviewed')), 'Nothing built on the review before it passed.');
  assert.equal(order.filter(text => /Fix these/.test(text)).length, 1);
  const after = env.board.list(env.c).find(item => item.id === review.id).taskState;
  assert.deepEqual([after.review.status, after.review.round, after.review.earlier, after.holds, Boolean(after.notIndependent)], ['passed', 1, 1, false, false]);
});

test('findings left after the repair round wait for you, never repair twice, and Continue anyway lets the cards after it start (#89)', { skip: scriptCLIs }, async t => {
  const { env, api, review, docs, taskOf, requests, folder } = reviewRound(t, { second: { verdict: 'changes', findings: [{ card: 'Build the API', problem: 'Sessions are still not checked on delete.' }] } });
  await until(() => requests().some(text => /Fix these/.test(text)), 'the repair to start');
  env.release(taskOf(api).scopePath);
  await until(() => taskOf(review)?.review?.status === 'held', 'the second review to hold');
  assert.match(taskOf(review).review.reason, /still found 1 problem after the repair round/);
  await until(() => /couldn’t settle/.test(taskOf(docs).reason || ''), 'the docs card to wait for you');
  assert.equal(taskOf(docs).status, 'waiting');
  assert.equal(requests().filter(text => /Fix these/.test(text)).length, 1, 'There is one repair round, never a second.');
  assert.match(env.c.messages.filter(message => message.role === 'system').at(-1).text, /“Review the API”: The review still found 1 problem/);
  // Building on it anyway is your call.
  env.board.proceed(env.c, review.id);
  assert.equal(taskOf(review).review.accepted, true);
  await until(() => env.card(docs.id).column === 'review', 'the docs card to run');
});

test('a repair that changed files in its card’s own copy is merged before the review checks again, and the review then reads it in its own copy (#89)', { skip: scriptCLIs }, async t => {
  const { env, api, review, docs, taskOf, requests } = reviewRound(t, { second: { verdict: 'pass' } });
  await until(() => requests().some(text => /asked for changes\. Fix these/.test(text)), 'the repair to start');
  // The repair's work is in the API card's own copy, and nothing reaches the folder until it is merged.
  const copy = taskOf(api).scopePath, told = () => env.c.messages.filter(message => message.role === 'system' && /was repaired in its own copy/.test(message.text));
  fs.mkdirSync(path.join(copy, 'src')); fs.writeFileSync(path.join(copy, 'src/items.js'), 'session check\n');
  env.release(copy);
  await until(() => taskOf(review)?.review?.waiting === 'Waiting for “Build the API” to be merged, so the review can read its repair.', 'the review to wait for the merge');
  assert.equal(taskOf(review).review.status, 'repairing');
  assert.ok(!requests().some(text => text.startsWith('The cards you reviewed had one repair run')), 'The second review doesn’t run on a copy without the repair.');
  assert.deepEqual(told().map(message => message.text), ['“Build the API” was repaired in its own copy. Review and merge it from its card, and “Review the API” reviews again. Discarding it ends the repair round.']);
  const shown = env.board.list(env.c);
  assert.deepEqual([shown.find(item => item.id === review.id).taskState.review.waiting, shown.find(item => item.id === api.id).column, taskOf(docs).status], ['Waiting for “Build the API” to be merged, so the review can read its repair.', 'review', 'waiting']);
  env.board.reviews.drive(env.c);
  assert.equal(told().length, 1, 'It is said once.');
  // You merge it: the review checks again, with the repaired file in its own copy.
  await env.broker.tasks.integrate(env.c, taskOf(api).id, { digest: env.broker.tasks.review(env.c, taskOf(api).id).digest });
  await until(() => taskOf(review)?.review?.status === 'passed', 'the second review to pass');
  assert.match(requests().find(text => text.startsWith('The cards you reviewed had one repair run')), /\nThe repairs are merged, and your copy now has what changed since your review, 1 file: `git diff [0-9a-f]{12} [0-9a-f]{12}` shows it\.\n/);
  assert.equal(fs.readFileSync(path.join(taskOf(review).scopePath, 'src/items.js'), 'utf8'), 'session check\n');
  assert.equal(env.board.list(env.c).find(item => item.id === review.id).taskState.review.repairs[0].status, 'done');
  await until(() => env.card(docs.id).column === 'review', 'the docs card to finish');
});

test('a repair whose copy is discarded ends the repair round, and the cards after the review wait for you (#89)', { skip: scriptCLIs }, async t => {
  const { env, api, review, docs, taskOf, requests } = reviewRound(t, { second: { verdict: 'pass' } });
  await until(() => requests().some(text => /asked for changes\. Fix these/.test(text)), 'the repair to start');
  fs.writeFileSync(path.join(taskOf(api).scopePath, 'items.js'), 'session check\n'); env.release(taskOf(api).scopePath);
  await until(() => /to be merged/.test(taskOf(review)?.review?.waiting || ''), 'the review to wait for the merge');
  env.broker.tasks.discard(env.c, taskOf(api).id);
  await until(() => taskOf(review)?.review?.status === 'held', 'the repair round to end');
  assert.equal(taskOf(review).review.reason, 'The repair on “Build the API” was discarded, so the cards after the review wait for you.');
  assert.equal(taskOf(review).review.waiting, null);
  assert.deepEqual(taskOf(review).review.repairs.map(item => [item.status, item.reason]), [['failed', 'Its repair was discarded.']]);
  assert.ok(!requests().some(text => text.startsWith('The cards you reviewed had one repair run')));
  assert.equal(taskOf(docs).status, 'waiting');
});

test('a review that ends without a verdict holds the cards after it, and a plan’s final review is added only for new plans (#89)', async () => {
  const { parseVerdict, withFinalReview } = await import('../src/plan-review.mjs');
  assert.equal(parseVerdict('Looks fine to me.'), null);
  assert.equal(parseVerdict('```json\n{"verdict": "changes", "findings": []}\n```'), null, 'Changes with nothing named isn’t a verdict.');
  assert.deepEqual(parseVerdict('Earlier: {"verdict": "pass"}\n\nThen:\n```json\n{"verdict": "changes", "findings": [{"card": "A", "problem": "Broken"}]}\n```'), { verdict: 'changes', findings: [{ card: 'A', problem: 'Broken', fix: '', file: '' }] });
  assert.equal(parseVerdict(`\`\`\`json\n${JSON.stringify({ verdict: 'changes', findings: Array.from({ length: 9 }, (_, i) => ({ problem: `P${i}` })) })}\n\`\`\``).findings.length, 5);
  const steps = [{ id: 's1', role: 'backend', dependsOn: [] }, { id: 's2', role: 'frontend', dependsOn: ['s1'] }, { id: 's3', dependsOn: [] }];
  assert.deepEqual(withFinalReview(steps).steps.at(-1).dependsOn, ['s2', 's3']);
  assert.equal(withFinalReview(steps).added, 's4');
  assert.equal(withFinalReview([steps[0], { id: 's2', role: 'qa', dependsOn: ['s1'] }]).added, null, 'One card that changes code needs no review of the whole.');
  assert.equal(withFinalReview([...steps, { id: 's4', role: 'reviewer', dependsOn: ['s2', 's3'] }]).added, null, 'The planner already ended it with a review.');
  assert.equal(withFinalReview([{ ...steps[0], card: 'abc' }, steps[1]]).added, null, 'A plan that edits the Plan you have is left as it is.');
});

// The Plan chat (#162): the Plan's own conversation, apart from the Workspace chat, that reads and drafts cards.
test('the Plan chat opens once, reads only, carries what the Workspace chat said, and drafts cards onto the Plan', { skip: scriptCLIs }, async t => {
  const env = setup(t, ['a', 'b']);
  env.broker.message(env.c, 'user', 'We agreed the sitemap goes in codeshi-web.');
  const { task } = env.board.chat(env.c);
  assert.equal(task.purpose, 'plan-chat'); assert.equal(task.title, 'Plan chat'); assert.equal(task.status, 'complete');
  assert.equal(env.board.chat(env.c).task.id, task.id, 'It is opened once and kept.');
  assert.deepEqual(env.board.view(env.c).chat, { taskId: task.id, conversationId: task.conversationId, status: 'complete', running: false, approvals: 0 });
  const lane = env.lane(task.id);
  assert.deepEqual(lane.broker.workspaceFolders.map(folder => folder.id), ['a', 'b'], 'It reads every folder of the workspace.');
  assert.equal(lane.c.messages.length, 0, 'The Workspace chat isn’t copied into it.');
  // The Workspace chat reaches it as an attachment on its next message, and only what's new after that.
  const first = env.board.workspaceContext(env.c);
  assert.equal(first.messages, 1);
  assert.match(Buffer.from(env.broker.attachments.read(first.attachment.id).data, 'base64').toString(), /# Workspace chat[\s\S]*The person[\s\S]*sitemap goes in codeshi-web/);
  assert.deepEqual(env.board.workspaceContext(env.c), { attachment: null, messages: 0 }, 'Nothing new, nothing attached.');
  env.broker.message(env.c, 'assistant', 'Noted.');
  assert.equal(env.board.workspaceContext(env.c).messages, 1);
  // A message there runs read-only whatever the box says, and a draft goes on the Plan, not into the Workspace chat.
  const plan = { summary: 'Sitemap, then a check.', questions: [], steps: [{ title: 'Add a sitemap', instructions: 'Generate sitemap.xml.', tier: 'light', dependsOn: [] }, { title: 'Check it', instructions: 'Validate the sitemap.', tier: 'light', dependsOn: [1], role: 'qa' }] };
  const file = path.join(env.folder('a'), '.mock-scenarios.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const answer = 'The sitemap should go in codeshi-web.';
  fs.writeFileSync(file, JSON.stringify({ ...saved, '~Where should the sitemap go': { text: JSON.stringify({ answer, steps: [] }) }, '~Plan the sitemap': { text: JSON.stringify(plan) } }));
  await lane.broker.dispatch(lane.c, { text: 'Where should the sitemap go?', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', orchestrate: true, requestId: 'plan-chat-answer-1' });
  await until(() => lane.c.orchestrations?.[0]?.status === 'answered' && !lane.broker.running, 'the question to be answered without drafting');
  assert.equal(lane.c.orchestrations[0].summary, answer);
  assert.equal(env.c.board?.length || 0, 0, 'A question does not create cards.');
  assert.match(env.captured(fs.realpathSync(env.folder('a')))[0].context.currentRequest, /No mode switch is needed/);
  await lane.broker.dispatch(lane.c, { text: 'Plan the sitemap', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', orchestrate: true, requestId: 'plan-chat-draft-1' });
  await until(() => lane.c.orchestrations?.[0]?.status === 'moved' && !lane.broker.running, 'the drafted cards to reach the Plan');
  assert.equal(lane.c.lastRun.mode, 'read');
  const drafts = env.c.board.filter(card => card.draft);
  assert.deepEqual(drafts.map(card => card.title), ['Add a sitemap', 'Check it']);
  assert.equal(env.c.orchestrations?.length || 0, 0, 'The Workspace chat has no plan of its own.');
  assert.equal(env.c.messages.filter(message => message.role === 'user').length, 1, 'Nothing was said in the Workspace chat.');
  // It stays out of what's left to recap, and has no changes to review.
  assert.throws(() => env.broker.tasks.reviewScope(env.c, task.id), /only reads the workspace/);
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
  // A complete list with the outer ]} missing still reaches Ready and can run, as a well-formed reply does.
  scriptMatch(env, 'into subtasks, before any work', { text: `Here it is:\n${JSON.stringify({ cards: [{ card: 1, subtasks: [{ title: 'Add the cart', instructions: 'A cart model.', tier: 'light' }, { title: 'Add the receipt', instructions: 'A receipt page.', tier: 'deep' }] }] }).slice(0, -2)}` });
  assert.equal(env.board.split(env.c, { ids: [card.id], provider: 'codex' }).kind, 'split');
  assert.equal(env.c.boardSuggest, null, 'A split keeps its own list, so Suggest next and Plan updates stay free.');
  assert.throws(() => env.board.split(env.c, { ids: [card.id], provider: 'codex' }), /already splitting “Build checkout”/, 'One card is split by one run at a time.');
  await until(() => env.c.boardSplits?.[0]?.status === 'complete', 'the split to finish');
  const [split] = env.captured(fs.realpathSync(env.folder('a')));
  assert.deepEqual(split.args.slice(split.args.indexOf('--sandbox'), split.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only'], 'The split only reads.');
  assert.match(split.context.currentRequest, /# Card 1\n\nBuild checkout\n\nA cart and a receipt\./, 'The split is planned from the card’s own brief.');
  assert.match(split.context.currentRequest, /Return only a JSON object with cards/);
  assert.match(env.c.boardSplits[0].summary, /Split “Build checkout” into 2 subtasks\./);
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
  const task = env.task(env.card(card.id).task);
  env.release(task.scopePath);
  await until(() => env.card(card.id).column === 'review', 'the card to finish');
  const done = env.card(card.id).subtasks;
  assert.deepEqual(done.map(item => [item.title, item.status, item.provider]), [['Add the cart', 'done', 'codex'], ['Add the receipt', 'done', 'codex'], ['Email the receipt', 'done', 'claude']]);
  assert.equal(done[0].summary, 'Added the cart model and its tests.');
  // Each subtask continues the same task, told its place among the others.
  const asked = [...requests(env), ...env.captured(task.scopePath).map(capture => capture.context.currentRequest)];
  assert.equal(asked.length, 4, 'One split, then one run for each subtask.');
  assert.ok(asked[1].startsWith('Build checkout'), 'The first subtask is the task’s first run, so it carries the card’s brief.');
  assert.match(asked[1], /Subtask 1 of 2 for the card “Build checkout”: Add the cart\n\nA cart model\./);
  assert.match(asked[2], /^Subtask 2 of 3 for the card “Build checkout”: Add the receipt\n\nA receipt page with totals\./);
  assert.match(asked[2], /Do only this subtask\. One more follows: “Email the receipt”\./);
  assert.match(asked[3], /^Subtask 3 of 3[\s\S]*This is the card’s last subtask/);
  assert.equal(task.status, 'complete');
  await until(() => env.card(card.id).result?.tests === 'passed', 'the card’s tests after its last subtask');
  // Export lists them.
  assert.match(env.board.markdown(env.c), /Subtasks:\n\n1\. \[x\] Add the cart\n2\. \[x\] Add the receipt\n3\. \[x\] Email the receipt/);
});

test('a subtask keeps its card, conversation and slot across a handoff, and a failed handoff releases them', { skip: scriptCLIs }, async t => {
  for (const fails of [false, true]) await t.test(fails ? 'destination fails' : 'destination continues', async t => {
    const env = setup(t, ['a'], { policy: { maxConcurrent: 2 } });
    const card = env.add({ title: 'Build checkout', column: 'ready' });
    for (const title of ['Add cart', 'Add receipt', 'Check checkout']) env.board.subtasks.act(env.c, card.id, { action: 'add', title });
    scriptMatch(env, 'Subtask 2 of 3', { behavior: 'hold', text: 'Receipt complete.' });
    const { tasks } = env.board.run(env.c, { ids: [card.id] }), task = env.task(tasks[card.id]);
    await until(() => env.card(card.id).subtasks[1].status === 'running' && env.captured(task.scopePath).length === 2, 'the second subtask');
    const lane = env.lane(task.id), run = lane.broker.running, conversationId = lane.c.id;
    const handoff = lane.broker.handoff;
    handoff.preferences = () => ({ threshold: 90, automatic: false });
    handoff.usage = async provider => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ id: 'primary', label: '5-hour', usedPercent: provider === 'codex' ? 96 : 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }] });
    handoff.account = async provider => ({ installed: provider !== 'gemini', authenticated: true, billingSource: 'subscription' });
    handoff.models = async () => ({ models: [{ id: 'haiku', displayName: 'Haiku' }] });
    await handoff.check(run);
    assert(lane.c.handoffOffer, 'A handoff offer is prepared for the lane.');
    let releaseMove;
    const gate = new Promise(resolve => { releaseMove = resolve; });
    t.after(() => releaseMove());
    const move = handoff.moveQueue.bind(handoff);
    handoff.moveQueue = async (...args) => { await gate; return move(...args); };
    const start = lane.broker.start.bind(lane.broker);
    lane.broker.start = (...args) => { if (fails && args[0] === lane.c) throw new Error('Destination unavailable'); return start(...args); };
    const switching = lane.broker.acceptHandoff(lane.c, { offerId: lane.c.handoffOffer.id });
    await until(() => !lane.broker.running && lane.c.limitSwitching, 'the gap between agents');
    env.broker.budget.setPolicy(env.c, { maxConcurrent: 1 });
    assert.equal(task.status, 'running');
    assert.equal(env.card(card.id).column, 'doing');
    assert.equal(env.card(card.id).task, task.id);
    assert.deepEqual(env.card(card.id).subtasks.map(sub => sub.status), ['done', 'running', 'pending']);
    assert.equal(env.broker.tasks.activeWorkers, 1, 'The handoff keeps its concurrency slot.');
    assert.throws(() => env.broker.tasks.admit(env.c, null), /already running/);
    assert.equal(env.broker.tasks.occupants(env.c).length, 1, 'Its folder stays occupied.');
    releaseMove();
    if (fails) {
      await assert.rejects(switching, /Destination unavailable/);
      assert.equal(lane.c.limitSwitching, null);
      assert.equal(task.status, 'stopped');
      assert.equal(env.card(card.id).column, 'ready');
      assert.equal(env.broker.tasks.activeWorkers, 0, 'A failed start releases its slot.');
      return;
    }
    await switching;
    assert.equal(lane.c.id, conversationId);
    assert.equal(lane.broker.running.provider, 'claude');
    assert.equal(env.card(card.id).task, task.id);
    await until(() => env.card(card.id).column === 'review', 'the remaining subtasks');
    assert.deepEqual(env.card(card.id).subtasks.map(sub => sub.status), ['done', 'done', 'done']);
    assert.equal(env.card(card.id).subtasks[1].provider, 'claude');
    assert.equal(env.captured(task.scopePath).filter(entry => entry.context.currentRequest.includes('Subtask 1 of 3')).length, 1, 'The completed subtask never restarts.');
    assert.equal(env.c.parallelTasks.filter(item => item.board?.cardId === card.id).length, 1);
    assert.equal(lane.c.limitSwitching, null);
  });
});

test('splits run side by side, each with its own line, up to Tasks at once (#162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.budget.setPolicy(env.c, { maxConcurrent: 2 });
  const one = env.add({ title: 'Build checkout', column: 'backlog', split: true, notes: 'A cart and a receipt.' });
  const two = env.add({ title: 'Build search', column: 'backlog', split: true, notes: 'An index and a box.' });
  const three = env.add({ title: 'Build email', column: 'backlog', split: true, notes: 'A template.' });
  scriptMatch(env, 'into subtasks, before any work', { behavior: 'hold', text: JSON.stringify({ cards: [{ card: 1, subtasks: [{ title: 'Do it', instructions: 'All of it.', tier: 'light' }] }] }) });
  env.board.split(env.c, { ids: [one.id], provider: 'codex' });
  env.board.split(env.c, { ids: [two.id], provider: 'codex' });
  assert.deepEqual(env.c.boardSplits.map(item => [item.cardTitle, item.status]), [['Build checkout', 'running'], ['Build search', 'running']], 'The second split starts while the first runs.');
  assert.throws(() => env.board.split(env.c, { ids: [three.id], provider: 'codex' }), /already running/, 'Splits count toward Tasks at once.');
  assert.deepEqual(env.board.view(env.c).splits.map(item => item.cardIds), [[one.id], [two.id]]);
  env.release(fs.realpathSync(env.folder('a')));
  await until(() => env.c.boardSplits.every(item => item.status === 'complete'), 'both splits to finish');
  assert.deepEqual([one, two].map(card => env.card(card.id).subtasks.map(item => item.title)), [['Do it'], ['Do it']]);
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
  const firstRun = env.board.run(env.c, { ids: [card.id] }).tasks[card.id];
  await until(() => env.card(card.id).subtasks[0].status === 'running', 'the first subtask');
  act({ action: 'pause' });
  env.release(env.task(firstRun).scopePath);
  await until(() => env.card(card.id).column === 'ready', 'the card to pause');
  assert.equal(env.card(card.id).reason, 'Paused after 1 of 2 subtasks. Run carries on from “Search box”. Its copy is still in Tasks, to merge or discard.');
  assert.deepEqual(env.card(card.id).subtasks.map(item => item.status), ['done', 'pending']);
  let asked = env.captured(env.task(firstRun).scopePath).map(capture => capture.context.currentRequest);
  assert.equal(asked.length, 1, 'No split: the card already had its subtasks.');
  assert.ok(asked[0].startsWith('Ship search'), 'The first run of a task carries the card’s brief.');
  assert.match(asked[0], /Subtask 1 of 2 for the card “Ship search”: Index the items\n\nBuild the index\./);
  // Run carries on in a new task, told what the earlier subtasks did.
  const secondRun = env.board.run(env.c, { ids: [card.id] }).tasks[card.id];
  await until(() => env.card(card.id).column === 'review', 'the card to finish');
  asked = env.captured(env.task(secondRun).scopePath).map(capture => capture.context.currentRequest);
  assert.match(asked[0], /Subtasks already done for this card, by earlier runs:\n- 1\. Index the items: Indexed\./);
  assert.match(asked[0], /Subtask 2 of 2 for the card “Ship search”: Search box/);
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
  await until(() => env.c.boardSplits?.at(-1)?.status === 'failed', 'the split to fail');
  assert.equal(env.c.boardSplits.at(-1).summary, 'The split didn’t return its subtasks as JSON.');
  env.board.dismissSuggest(env.c, env.c.boardSplits.at(-1).id);
  assert.equal(env.c.boardSplits.some(item => item.status === 'failed'), false, 'Dismiss clears that split’s line.');
  assert.deepEqual(env.card(card.id).subtasks, []);
});

test('each subtask runs with the agent and model chosen on it, is routed at its size on Smart, or else uses the card’s agent (#155, #162)', async () => {
  const { Subtasks, parseSplit } = await import('../src/subtasks.mjs');
  const card = { id: 'k', title: 'Card', split: true, auto: true, subtasks: [{ id: 'a', title: 'One', instructions: 'Do one.', tier: 'light', agent: null, status: 'pending' }, { id: 'b', title: 'Two', instructions: '', tier: 'deep', agent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, status: 'pending' }] };
  const calls = [], board = { cards: () => [card], update: (c, target, changes) => Object.assign(target, changes), main: { tasks: { update() {}, sync() {}, admit() { if (full) throw Object.assign(new Error('2 tasks are already running, the most this workspace\'s task limits allow at once.'), { status: 409 }); }, closed: false } } };
  let full = false, routes = true;
  const lane = { c: {}, broker: { execution: { allows: (c, token, { action }) => routes || action !== 'routing' }, start: (c, input) => { calls.push(['start', input]); return {}; }, dispatch: async (c, input) => { calls.push(['dispatch', input]); } } };
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
  // A card you took over from Flow (its policy no longer allows routing): a subtask on Smart runs with the card's agent.
  routes = false; card.subtasks[0].status = 'pending';
  subtasks.launch({}, { ...base, routing: { mode: 'smart', planned: 'standard' } }, lane, card, card.subtasks[0]);
  assert.deepEqual(calls.slice(before).map(([how, input]) => [how, input.provider, input.model, input.effort ?? null, input.routing ?? null]), [['start', 'codex', 'gpt-6.1-sol', 'medium', null]]);
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
    questions: [],
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

test('Suggest next asks before drafting, resumes the same agent from saved answers, and refuses stale answers (#162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const target = env.add({ title: 'Add login', column: 'ready' }), other = env.add({ title: 'Other work' });
  const questions = [{ question: 'Which login provider?', options: ['GitHub', 'Google'] }];
  const steps = [{ title: 'Test GitHub login', instructions: 'Verify the GitHub login flow.', done: ['Login works'], tier: 'light', dependsOn: [] }];
  const choice = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
  const prompt = env.board.suggestPrompt(env.c, env.card(target.id));
  assert.match(prompt, /When questions has any, return steps \[\] and say in summary what you’ll suggest once they answer/);
  assert.doesNotMatch(prompt, /Suggest next always returns its cards/);
  assert.doesNotMatch(prompt, /The person’s answers to your questions/, 'A first run is told of no answers.');
  // Even a mixed reply must ask first, with no draft based on an unanswered decision.
  scriptMatch(env, 'Suggest 1 to 3 follow-up cards', { text: JSON.stringify({ summary: 'Choose the login provider first.', questions, steps }) });
  env.board.suggest(env.c, target.id, choice);
  await until(() => env.c.boardSuggest?.status === 'complete', 'the suggestion questions');
  const asked = env.c.boardSuggest.id;
  assert.deepEqual(env.c.boardSuggest.questions, questions);
  assert.deepEqual(env.c.boardSuggest.cards, []);
  assert.equal(env.c.board.length, 2);
  await env.reopen();
  assert.equal(env.c.boardSuggest.id, asked, 'Questions remain answerable after a restart.');
  assert.deepEqual(env.board.view(env.c).suggest.questions, questions);
  const answer = { asked, answers: 'Use GitHub.' };
  for (const input of [{ ...answer, asked: 'old-job' }, { answers: answer.answers }, { asked, answers: '' }]) {
    assert.throws(() => env.board.suggest(env.c, target.id, input), /Those questions are gone/);
  }
  assert.throws(() => env.board.suggest(env.c, other.id, answer), /Those questions are gone/);
  // Another genuine decision can be asked, retaining the first answer for the final draft.
  scriptMatch(env, 'Suggest 1 to 3 follow-up cards', { text: JSON.stringify({ summary: 'Choose where to test it.', questions: [{ question: 'Where should the login be tested?', options: ['Staging', 'Local'] }], steps: [] }) });
  const second = env.board.suggest(env.c, target.id, { ...answer, provider: 'claude', model: 'changed-model', effort: 'low' });
  assert.deepEqual([second.provider, second.model, second.effort], [choice.provider, choice.model, choice.effort], 'Continuing cannot silently switch the agent shown with the questions.');
  // The page is told the run has answers, not what they are: they stay with the run that reads them.
  assert.deepEqual([second.answered, 'answers' in second], [true, false]);
  assert.match(env.c.boardSuggest.answers, /Which login provider\?[\s\S]*Use GitHub\./);
  await until(() => env.c.boardSuggest?.status === 'complete', 'the follow-up questions');
  assert.equal(env.c.board.length, 2);
  const captured = env.captured(fs.realpathSync(env.folder('a'))).at(-1);
  assert.match(captured.prompt, /Which login provider\?[\s\S]*Use GitHub\./);
  assert.match(captured.prompt, /don’t ask again what they answered\. Where they left a question unanswered, go with the option you recommended/);
  assert.deepEqual(captured.args.slice(captured.args.indexOf('--sandbox'), captured.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.throws(() => env.board.suggest(env.c, target.id, answer), /Those questions are gone/);
  const secondId = env.c.boardSuggest.id;
  scriptMatch(env, 'Suggest 1 to 3 follow-up cards', { text: JSON.stringify({ summary: 'Test the chosen login.', questions: [], steps }) });
  env.board.suggest(env.c, target.id, { asked: secondId, answers: 'Use staging.' });
  await until(() => env.c.boardSuggest?.status === 'complete', 'the answered suggestion to draft');
  const finalPrompt = env.captured(fs.realpathSync(env.folder('a'))).at(-1).prompt;
  assert.match(finalPrompt, /Which login provider\?[\s\S]*Use GitHub\.[\s\S]*Where should the login be tested\?[\s\S]*Use staging\./);
  assert.equal(env.c.board.length, 3);
  const drafted = env.card(env.c.boardSuggest.cards[0]);
  assert.deepEqual(drafted.dependsOn, [target.id]);
  assert.equal(drafted.column, 'backlog');
  assert.ok(drafted.draft, 'Answering only drafts the suggestion; it does not accept or run it.');
  assert.throws(() => env.board.suggest(env.c, target.id, { asked: secondId, answers: 'Use staging.' }), /Those questions are gone/);
});

test('Update the Plan reads a finished card’s findings and the Plan, and drafts changes, removals and new cards named after it', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const cache = env.add({ title: 'Add Redis cache', notes: 'Cache sessions in Redis.', column: 'ready', group: 'Build' });
  const limiter = env.add({ title: 'Write a rate limiter', column: 'backlog', group: 'Build' });
  const secret = env.add({ title: 'Salary bands', notes: 'SECRET-UPDATE', column: 'backlog', closed: true });
  const research = env.add({ title: 'Research caching', column: 'ready', artifact: 'findings', group: 'Research' });
  // Not finished yet: nothing to update with.
  assert.throws(() => env.board.updateFrom(env.c, research.id, { provider: 'codex' }), /hasn’t finished/);
  env.board.update(env.c, env.card(research.id), { column: 'review', result: { status: 'complete', summary: 'FINDING-42: sessions already live in Postgres, and the gateway rate-limits.', files: 0 } });

  const prompt = env.board.updatePrompt(env.c, env.card(research.id));
  assert.match(prompt, /read-only planning run/);
  assert.match(prompt, /FINDING-42/);
  assert.match(prompt, new RegExp(`Id: ${env.board.refOf(env.c, cache.id)}`));
  assert.match(prompt, /Don’t change, merge or remove “Research caching” itself/);
  assert.doesNotMatch(prompt, /Salary bands|SECRET-UPDATE/);

  const ref = id => env.board.refOf(env.c, id);
  scriptMatch(env, 'has finished, and its findings are below', { text: JSON.stringify({
    summary: 'Sessions stay in Postgres; the gateway already limits rates.',
    questions: [{ question: 'Keep the Postgres sessions table?', options: ['Yes', 'No'] }],
    steps: [
      { card: ref(cache.id), title: 'Index the Postgres sessions table', instructions: 'Sessions live in Postgres. Add an index on user_id.' },
      { card: ref(research.id), title: 'Should stay as it is' },
      { title: 'Document the gateway rate limit', instructions: 'Write down the gateway limits.', done: ['Limits documented'], tier: 'light', dependsOn: [ref(research.id)], role: 'builder' },
      { title: 'Second build card', instructions: 'Another change.', tier: 'light', dependsOn: [], role: 'builder' },
    ],
    remove: [ref(limiter.id), ref(research.id)],
  }) });
  const started = env.board.updateFrom(env.c, research.id, { provider: 'codex' });
  assert.equal(started.kind, 'update');
  await until(() => env.c.boardSuggest?.status === 'complete', 'the update to finish');
  const cap = env.captured(fs.realpathSync(env.folder('a'))).at(-1);
  assert.deepEqual(cap.args.slice(cap.args.indexOf('--sandbox'), cap.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);

  const drafted = env.c.boardSuggest.cards.map(id => env.card(id));
  // Two new cards, the changed cache card and the limiter to remove; no review of the whole result is added.
  assert.equal(drafted.length, 4);
  for (const card of drafted) assert.deepEqual([card.draft.batch.kind, card.draft.batch.cardId, card.draft.batch.cardTitle], ['update', research.id, 'Research caching']);
  assert.equal(drafted[0].draft.batch.questions[0].question, 'Keep the Postgres sessions table?');
  const documented = drafted.find(card => card.title === 'Document the gateway rate limit');
  assert.deepEqual(documented.dependsOn, [research.id]);
  assert.equal(drafted.some(card => card.role === 'reviewer'), false);
  assert.equal(env.card(cache.id).title, 'Index the Postgres sessions table');
  assert.equal(env.card(cache.id).draft.was.fields.title, 'Add Redis cache');
  assert.equal(env.card(limiter.id).draft.remove, true);
  // The card the findings came from is never changed or removed.
  assert.equal(env.card(research.id).title, 'Research caching');
  assert.equal(env.card(research.id).draft ?? null, null);

  // Discarding puts the Plan back as it was.
  env.board.drafts(env.c, { action: 'discard', ids: drafted.map(card => card.id) });
  assert.equal(env.card(cache.id).title, 'Add Redis cache');
  assert.equal(env.card(limiter.id).draft ?? null, null);
  // The card keeps what the update drafted and what you did with it, so it isn't offered as if it never ran.
  assert.deepEqual((({ added, changed, removed, accepted, discarded }) => ({ added, changed, removed, accepted, discarded }))(env.card(research.id).updates[0]), { added: 2, changed: 1, removed: 1, accepted: 0, discarded: 4 });
  // A later update is told what the earlier one did, and so is every agent reading the Plan once one is accepted.
  assert.match(env.board.updatePrompt(env.c, env.card(research.id)), /# Earlier updates from these findings[\s\S]*2 new, 1 changed, 1 removed; its changes were discarded by the person/);
  env.board.dismissSuggest(env.c);

  // Findings that change nothing say so, with what's left to decide, and add nothing.
  const before = env.board.cards(env.c).length;
  scriptMatch(env, 'has finished, and its findings are below', { text: JSON.stringify({ summary: 'The Plan already covers this.', questions: ['Drop Redis entirely?'], steps: [] }) });
  env.board.updateFrom(env.c, research.id, { provider: 'codex' });
  await until(() => env.c.boardSuggest?.status === 'complete', 'the no-change update to finish');
  assert.deepEqual(env.c.boardSuggest.cards, []);
  assert.equal(env.c.boardSuggest.summary, 'The Plan already covers this.');
  assert.equal(env.c.boardSuggest.questions[0].question, 'Drop Redis entirely?');
  assert.equal(env.board.cards(env.c).length, before);
  assert.deepEqual(env.card(research.id).updates.map(item => item.added + item.changed + item.removed), [4, 0]);
});

test('a report’s “Plan changes” section is read up to the next heading or verdict, and one that changes nothing counts as none', () => {
  assert.equal(planChanges('All done.\n\n## Plan changes\n- “Build the store” should use Postgres.\n- Drop “Add Redis”.\n\n## Questions for you\n- Keep it?'), '- “Build the store” should use Postgres.\n- Drop “Add Redis”.');
  assert.equal(planChanges('**Plan changes:** add a card for the gateway limits.\n\n```json\n{"verdict": "pass"}\n```'), 'add a card for the gateway limits.');
  assert.equal(planChanges('Checked it.\n\nPlan changes\n\nNone.'), '');
  assert.equal(planChanges('### Plan changes\n- No changes needed'), '');
  assert.equal(planChanges('Nothing about the plan here.'), '');
  // Asked to leave the section out, a real agent often writes it on one line with “none”, and its questions the same way
  // (#162, seen live). That starts no update, with or without a sentence after it.
  assert.equal(planChanges('Created notes/alpha.txt.\n\nPlan changes: none.\n\nQuestions for you: none.'), '');
  assert.equal(planChanges('Done.\n\n**Plan changes:** None.\n\n**Questions for you:** None.'), '');
  assert.equal(planChanges('Done.\n\nPlan changes: None. The Plan fits as it is.\n\nThanks.'), '');
  assert.equal(planChanges('Done.\n\n## Plan changes\nNo plan changes are needed.'), '');
  // A change is still a change: one that starts with “None of…”, one listed under “None.”, and one before the questions.
  assert.equal(planChanges('Plan changes: None of the cards covers rate limits, so add one.'), 'None of the cards covers rate limits, so add one.');
  assert.equal(planChanges('## Plan changes\nNone.\n- Except: drop “Add Redis”.'), 'None.\n- Except: drop “Add Redis”.');
  assert.equal(planChanges('Plan changes: add a card for the footer links.\n\nQuestions for you: keep the old route?'), 'add a card for the footer links.');
});

test('a card whose report says the Plan should change updates it by itself, and the cards after it wait until you settle it', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => null };
  const research = env.add({ title: 'Research sessions', column: 'ready', artifact: 'findings' });
  const build = env.add({ title: 'Build the session store', notes: 'Add Redis.', column: 'ready', dependsOn: [research.id] });
  env.script(research, null, 'Sessions already live in Postgres.\n\n## Plan changes\n- “Build the session store” should index the Postgres table instead of adding Redis.');
  scriptMatch(env, 'has finished, and its findings are below', { behavior: 'hold', text: JSON.stringify({ summary: 'Sessions stay in Postgres.', steps: [{ card: env.board.refOf(env.c, build.id), title: 'Index the Postgres sessions table', instructions: 'Add an index on user_id.' }] }) });
  const { tasks } = env.board.run(env.c, { ids: [build.id, research.id] });
  // It starts by itself, with the agent that wrote the report, and says so in the chat.
  await until(() => env.c.boardSuggest?.kind === 'update' && env.c.boardSuggest.status === 'running', 'the update to start by itself');
  assert.deepEqual([env.c.boardSuggest.cardId, env.c.boardSuggest.provider], [research.id, 'codex']);
  assert.match(env.card(research.id).autoUpdate.said, /index the Postgres table/);
  assert.equal(env.card(research.id).autoUpdate.jobId, env.c.boardSuggest.id);
  assert.match(env.captured(env.task(tasks[research.id]).scopePath).map(c => c.context.currentRequest).find(text => /^Research sessions/.test(text || '')), /add a heading “Plan changes” near the end/);
  assert.ok(env.c.messages.some(message => /“Research sessions” found that the Plan should change/.test(message.text)));
  // The queued card is told it may change, and waits rather than starting from a Plan that's about to.
  assert.match(await until(() => requests(env).find(text => /has finished, and its findings are below/.test(text || '')), 'the update’s request'), /haven’t started: they are queued to run[\s\S]*Build the session store/);
  await until(() => /Plan updates from what “Research sessions” found/.test(env.task(tasks[build.id]).reason || ''), 'the next card to wait for the update');
  assert.equal(env.task(tasks[build.id]).status, 'waiting');
  const held = () => env.board.list(env.c).find(item => item.id === research.id).taskState;
  assert.deepEqual([held().holds, /Plan updates/.test(held().planUpdate)], [true, true]);
  env.release(fs.realpathSync(env.folder('a')));
  await until(() => env.c.boardSuggest?.status === 'complete', 'the update to draft');
  // The queued card it changes leaves the run and waits in the draft, which names what it was.
  assert.equal(env.task(tasks[build.id]).status, 'cancelled');
  const changed = env.card(build.id);
  assert.deepEqual([changed.title, changed.draft.was.column, changed.draft.batch.cardId], ['Index the Postgres sessions table', 'ready', research.id]);
  assert.match(changed.reason, /Taken out of its run by the Plan update from “Research sessions”/);
  assert.match(held().planUpdate, /accept or discard the Plan changes from “Research sessions”/);
  // Accepting settles it: nothing holds the cards after it any more, and the same report isn't noticed twice.
  env.board.drafts(env.c, { action: 'accept', ids: [build.id] });
  assert.equal(held().planUpdate, undefined);
  const id = env.c.boardSuggest.id;
  env.board.follow(env.c, env.task(tasks[research.id]));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(env.c.boardSuggest.id, id);
});

test('a Plan update a card starts by itself waits while Suggest next’s questions wait for you, and starts once they are dismissed (#162)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => null };
  const login = env.add({ title: 'Add login', column: 'ready' });
  const research = env.add({ title: 'Research sessions', column: 'ready', artifact: 'findings' });
  scriptMatch(env, 'Suggest 1 to 3 follow-up cards', { text: JSON.stringify({ summary: 'Choose the login provider first.', questions: [{ question: 'Which login provider?', options: ['GitHub', 'Google'] }], steps: [] }) });
  env.board.suggest(env.c, login.id, { provider: 'codex' });
  await until(() => env.c.boardSuggest?.status === 'complete', 'the suggestion’s questions');
  const asked = env.c.boardSuggest.id;
  // A card finishes meanwhile and says the Plan should change. Its update would take the questions away, so it waits.
  env.script(research, null, 'Sessions already live in Postgres.\n\n## Plan changes\n- Add a card that indexes the Postgres sessions table.');
  scriptMatch(env, 'has finished, and its findings are below', { text: JSON.stringify({ summary: 'One new card.', steps: [{ title: 'Index the sessions table', instructions: 'Add an index on user_id.', tier: 'light' }] }) });
  env.board.run(env.c, { ids: [research.id] });
  await until(() => env.card(research.id).autoUpdate, 'the card to say the Plan should change');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(env.c.boardSuggest.id, asked, 'The questions stay on the Plan.');
  assert.deepEqual([env.card(research.id).autoUpdate.jobId, env.card(research.id).autoUpdate.error], [null, null], 'The update is queued, not failed.');
  assert.equal(env.board.view(env.c).suggest.questions.length, 1);
  // Dismissing the questions, like answering them, lets the queued update start.
  env.board.dismissSuggest(env.c);
  await until(() => env.c.boardSuggest?.kind === 'update', 'the queued update to start');
  assert.equal(env.c.boardSuggest.cardId, research.id);
  await until(() => env.c.boardSuggest?.status === 'complete', 'the update to draft');
});

test('a reply’s questions for the person are read from its heading or a last paragraph of questions, and “None” asks nothing', () => {
  assert.deepEqual(openQuestions('Done.\n\n## Plan changes\n- Add a card.\n\n## Questions for you\n1. Also trim the footer?\n2. **Keep the old route?**'), ['Also trim the footer?', 'Keep the old route?']);
  assert.deepEqual(openQuestions('Done.\n\n**Questions for you**\n- None.'), []);
  assert.deepEqual(openQuestions('Changed the header.\n\nShould the logo link home?\nKeep the beta badge?'), ['Should the logo link home?', 'Keep the beta badge?']);
  assert.deepEqual(openQuestions('Changed the header. Is that all?'), []);
});

test('a card that ends with questions keeps its Plan update waiting for your answers, and the cards after it wait too', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => null };
  const research = env.add({ title: 'Polish the header', column: 'ready', artifact: 'findings' });
  const after = env.add({ title: 'Write the guide', column: 'ready', dependsOn: [research.id] });
  env.script(research, null, 'Changed the header.\n\n## Plan changes\n- Add a card for the footer links.\n\n## Questions for you\n- Should the logo link home too?');
  env.script(after, null, 'Wrote the guide.');
  const { tasks } = env.board.run(env.c, { ids: [after.id, research.id] });
  await until(() => env.card(research.id).autoUpdate?.asking, 'the update to wait for the answers');
  assert.match(env.captured(env.task(tasks[research.id]).scopePath).map(c => c.context.currentRequest).find(text => /^Polish the header/.test(text || '')), /Follow-ups to this card’s own work aren’t Plan changes/);
  assert.ok(env.c.messages.some(message => /“Polish the header” has questions for you/.test(message.text)));
  await until(() => /has questions for you/.test(env.task(tasks[after.id]).reason || ''), 'the next card to wait for the answers');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(env.c.boardSuggest?.kind === 'update' ? env.c.boardSuggest.status : null, null, 'No Plan update starts while the card asks.');
  // Continuing anyway lets the cards after it go, and the update doesn't start by itself.
  env.board.proceed(env.c, research.id);
  await until(() => env.card(after.id).column === 'review', 'the next card to run once you continue');
  assert.equal(env.card(research.id).autoUpdate.released, true);
});

test('continuing anyway lets the cards after a card go while its Plan update is still to settle', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => null };
  const research = env.add({ title: 'Audit the docs', column: 'ready', artifact: 'findings' });
  const after = env.add({ title: 'Write the guide', column: 'ready', dependsOn: [research.id] });
  env.script(research, null, 'Read every page.\n\n## Plan changes\n- Add a card for the missing install page.');
  env.script(after, null, 'Wrote the guide.');
  scriptMatch(env, 'has finished, and its findings are below', { behavior: 'hold', text: JSON.stringify({ summary: 'One new card.', steps: [{ title: 'Write the install page', instructions: 'Cover macOS and Windows.', tier: 'light' }] }) });
  const { tasks } = env.board.run(env.c, { ids: [after.id, research.id] });
  await until(() => /Plan updates from what “Audit the docs” found/.test(env.task(tasks[after.id]).reason || ''), 'the next card to wait for the update');
  env.board.proceed(env.c, research.id);
  await until(() => env.card(after.id).column === 'review', 'the next card to run once you continue');
  assert.equal(env.card(research.id).autoUpdate.released, true);
  env.release(fs.realpathSync(env.folder('a')));
  await until(() => env.c.boardSuggest?.status === 'complete', 'the update to finish');
  assert.equal(env.board.list(env.c).find(item => item.id === research.id).taskState.planUpdate, undefined);
});

test('a follow-up asked in a finished card’s task is listed after its report, and a review’s verdict stands without a new one (#89)', async t => {
  const env = setup(t);
  const apiCard = env.add({ title: 'Build the API', column: 'ready', files: ['src/api.js'] }); env.card(apiCard.id).column = 'review';
  const card = env.add({ title: 'Review the API', column: 'ready', role: 'reviewer', dependsOn: [apiCard.id] });
  const message = (role, runId, text) => ({ id: `${runId}-${role}`, role, runId, text, createdAt: new Date().toISOString() });
  const task = { id: 'task-followup', status: 'complete', board: { cardId: card.id }, review: { verdict: 'pass', status: 'passed', round: 0, findings: [], repairs: [] }, laterRuns: [{ runId: 'run-2', kind: 'follow-up' }] };
  const lane = { approvals: { pendingCount: 0 }, broker: { running: () => false, pendingCount: () => 0 }, c: { lastRun: { id: 'run-2' }, messages: [message('user', 'run-1', 'Review the API'), message('assistant', 'run-1', 'REPORT: all good.\n\n```json\n{"verdict": "pass"}\n```'), message('user', 'run-2', 'Save it to a file?'), message('assistant', 'run-2', 'Thanks, saved.')] } };
  env.broker.tasks.lanes.set(task.id, lane);
  const thread = env.board.thread(env.c, task);
  assert.match(thread.report.text, /^REPORT/);
  assert.deepEqual(thread.followUps.map(item => [item.ask, item.text]), [['Save it to a file?', 'Thanks, saved.']]);
  assert.match(env.board.result(task, env.c).summary, /^REPORT/);
  assert.equal(env.board.result(task, env.c).followUps, 1);
  // The follow-up's reply has no verdict: the review's pass stands, and nothing is saved over it.
  const saved = [], update = env.broker.tasks.update;
  env.broker.tasks.update = (c, item, changes) => { saved.push(changes); };
  try {
    assert.equal(env.board.reviews.ended(env.c, task, 'Thanks, saved.'), task.review);
    assert.deepEqual(saved, []);
    // A user follow-up while a review is waiting on a repair round is recorded as a follow-up (not a second review), and once the repaired task finishes its repair entry reconciles to done.

    const apiTask = { id: 'task-api-repaired', status: 'complete', tests: 'passed', endedAt: '2026-11-18T10:00:00.000Z', board: { cardId: apiCard.id }, stepResult: { files: ['src/api.js'] }, testCommand: 'npm test' };
    env.c.parallelTasks = [apiTask, task];
    env.card(apiCard.id).task = apiTask.id;
    env.card(card.id).task = task.id;
    task.review = { verdict: 'changes', status: 'repairing', round: 0, findings: [{ card: 'Build the API', cardId: apiCard.id, cardTitle: 'Build the API', problem: 'Missing check.', fix: 'Add it.', file: 'src/api.js' }], repairs: [{ cardId: apiCard.id, title: 'Build the API', count: 1, status: 'running' }] };
    lane.c.lastRun = { id: 'run-3' };
    env.board.laterRun(env.c, task);
    assert.equal(task.laterRuns.at(-1).kind, 'follow-up');
    const reconciled = env.board.reviews.ended(env.c, task, 'Still waiting on the repair.');
    assert.equal(reconciled.repairs[0].status, 'done');
    assert.equal(reconciled.repairs[0].tests, 'passed');
    const pub = env.board.list(env.c).find(item => item.id === card.id);
    assert.deepEqual(pub.checkedCards, [{ id: apiCard.id, title: 'Build the API', role: 'builder', column: 'review' }]);
    const ans = env.board.answer(env.c, card.id);
    assert.equal(ans.inspected.cards.length, 1);
    assert.equal(ans.inspected.cards[0].id, apiCard.id);
    assert.deepEqual(ans.inspected.cards[0].files.map(f => f.path), ['src/api.js']);
  } finally { env.broker.tasks.update = update; env.broker.tasks.lanes.delete(task.id); }
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

// A card works in one folder. One with none chosen works in the folder its files point to, and its agent is told that it
// changes only that folder.
test('a card with no folder runs in the one its files point to, shows it, and its agent is told it changes only that folder', { skip: scriptCLIs }, async t => {
  const env = setup(t, ['a', 'b']);
  fs.mkdirSync(path.join(env.folder('a'), 'src'), { recursive: true });
  fs.mkdirSync(path.join(env.folder('b'), 'components', 'demos'), { recursive: true });
  const guess = files => env.board.folderGuess({ files });
  assert.equal(guess(['b/app/', 'b/lib/site.ts']), 'b', 'A path that starts with a folder’s name names that folder.');
  assert.equal(guess(['components/demos/flow.tsx']), 'b', 'A new file counts for the folder its parent is in.');
  assert.equal(guess(['src/new.mjs', 'components/demos/x.tsx', 'src/other.mjs']), 'a', 'The folder most of its files are in.');
  assert.equal(guess(['src/x.mjs', 'components/demos/x.tsx']), null, 'Split evenly, they point nowhere.');
  assert.equal(guess(['.gitignore']), null, 'A file both folders have says nothing.');
  assert.equal(guess(['a/x.mjs', 'b/y.ts']), null);
  assert.equal(guess([]), null);
  // The Plan shows where it will run, Plan.md says so, and its agent reads its files from inside that folder.
  const card = env.add({ title: 'Site copy', folderId: null, files: ['b/lib/content.ts'], column: 'ready' });
  const shown = () => env.board.list(env.c).find(item => item.id === card.id);
  assert.deepEqual([shown().folderId, shown().folderGuessed], ['b', true]);
  assert.equal(env.card(card.id).folderId, null, 'The guess isn’t saved on the card: choosing a folder still decides.');
  assert.match(env.board.prompt(env.c, env.card(card.id)), /Files or folders it expects to change: lib\/content\.ts$/m);
  assert.match(env.board.markdown(env.c), /### Site copy[\s\S]*?Works in: b/);
  const chosen = env.add({ title: 'Engine', folderId: 'a', files: ['b/lib/content.ts'] });
  assert.equal(env.board.list(env.c).find(item => item.id === chosen.id).folderGuessed, undefined, 'A folder you chose stays.');
  env.script({ ...card, folderId: 'b' }, 'hold', 'Updated the copy.');
  const { tasks } = env.board.run(env.c, { ids: [card.id] }), task = env.task(tasks[card.id]);
  assert.equal(task.folderId, 'b', 'It runs in the folder its files point to, not the first one.');
  const b = fs.realpathSync(env.folder('b')), a = fs.realpathSync(env.folder('a'));
  await until(() => task.scopePath && env.captured(task.scopePath).length, 'the card’s task to start');
  const scope = env.captured(task.scopePath)[0].context.taskScope;
  assert.ok(scope.startsWith(`This task works in its own copy of b, at ${task.scopePath}, made from that folder's last commit.`), scope);
  assert.ok(scope.includes(`other folder, a (${a}), copy files out of it`) && scope.includes('dev servers there, but Codeshi refuses changes there'), scope);
  assert.deepEqual(env.lane(task.id).broker.guarded.map(folder => [folder.name, folder.copy]), [['a', null], ['b', task.scopePath]]);
  env.release(task.scopePath);
  await until(() => column(env, card) === 'review', 'the card to reach Review');
});

test('a drafted card works in the folder its planner names, or the one its files point to (#162)', t => {
  const env = setup(t, ['a', 'b']);
  fs.mkdirSync(path.join(env.folder('b'), 'components'), { recursive: true });
  drafted(env, { steps: [
    { title: 'Named', instructions: 'Change the site.', tier: 'light', dependsOn: [], folder: 'B' },
    { title: 'From its files', instructions: 'Add a demo.', tier: 'light', dependsOn: [], files: ['components/flow.tsx'] },
    { title: 'Nowhere', instructions: 'Something.', tier: 'light', dependsOn: [], folder: 'elsewhere' },
  ] });
  const folderOf = title => env.c.board.find(card => card.title === title).folderId;
  assert.deepEqual([folderOf('Named'), folderOf('From its files'), folderOf('Nowhere')], ['b', 'b', null], 'A folder that isn’t in the workspace leaves it to the first.');
  // The planner is told the folders only when there is a choice.
  assert.match(planningRequest('Ship it', { folders: env.list }), /This workspace has 2 folders: "a", "b"\. Give every card folder/);
  assert.doesNotMatch(planningRequest('Ship it', { folders: env.list.slice(0, 1) }), /Give every card folder/);
});

test('a merged or kept Plan card preserves its changed files, stats and diffs after reload, and falls back to recorded edits', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  fs.writeFileSync(path.join(env.folder('a'), 'notes.txt'), 'alpha\nbeta\n');
  git(env.folder('a'), 'add', 'notes.txt'); git(env.folder('a'), 'commit', '-qm', 'notes');
  env.broker.start(env.c, { text: 'Hold main', provider: 'codex', mode: 'edit', approvalPolicy: 'ask' }); const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folder('a'))).length, 'the main run');

  const mergedCard = env.add({ title: 'Update notes', column: 'ready' });
  const emptyCard = env.add({ title: 'Read only check', column: 'ready' });
  env.script(mergedCard, null, 'Updated notes and added summary.');
  env.script(emptyCard, null, 'No edits needed.');
  const { tasks } = env.board.run(env.c, { ids: [mergedCard.id, emptyCard.id] });
  await until(() => column(env, mergedCard) === 'review' && column(env, emptyCard) === 'review', 'both cards in review');
  const mergedTask = env.task(tasks[mergedCard.id]);
  fs.writeFileSync(path.join(mergedTask.scopePath, 'notes.txt'), 'alpha\ngamma\n');
  fs.writeFileSync(path.join(mergedTask.scopePath, 'summary.md'), '# Done\n');
  env.release(fs.realpathSync(env.folder('a'))); await main.done;

  await env.broker.tasks.integrate(env.c, mergedTask.id, { digest: env.broker.tasks.review(env.c, mergedTask.id).digest });
  await until(() => env.card(mergedCard.id).result?.status === 'integrated', 'card result updated to integrated');
  assert.equal(env.board.accept(env.c, mergedCard.id).column, 'done');
  assert.equal(env.board.accept(env.c, emptyCard.id).column, 'done');
  assert.equal(env.card(emptyCard.id).result.status, 'integrated');
  assert.equal(env.card(emptyCard.id).result.inCopy, false);

  await env.reopen();
  const shown = env.board.public(env.c, env.card(mergedCard.id));
  assert.deepEqual(shown.taskState.integration, { files: 2, branch: null, at: env.task(mergedTask.id).integration.at, folder: 'a' });
  const ans = env.board.answer(env.c, mergedCard.id);
  assert.equal(ans.filesSource, 'merged');
  assert.deepEqual(ans.integration, { files: 2, branch: null, at: env.task(mergedTask.id).integration.at, folder: 'a', totalFiles: 2 });
  assert.deepEqual(ans.files.map(({ path: p, change, added, removed, status }) => ({ path: p, change, added, removed, status })), [
    { path: 'notes.txt', change: 'update', added: 1, removed: 1, status: 'clean' },
    { path: 'summary.md', change: 'add', added: 1, removed: 0, status: 'clean' },
  ]);
  assert.match(ans.files[0].diff, /\+gamma/);
  assert.match(ans.files[1].diff, /\+# Done/);

  // Fallback for an older merged or direct card without integration.changes: normalized recorded paths.
  const directCard = env.add({ title: 'Direct edit', column: 'ready' });
  const fakeTask = { id: 't-direct', title: 'Direct edit', status: 'integrated', mode: 'direct', folderId: 'a', folderName: 'a', folderPath: env.folder('a'), provider: 'codex', board: { cardId: directCard.id }, integration: { files: 1, at: new Date().toISOString() }, stepResult: { summary: 'Done', files: [path.join(env.folder('a'), 'src/app.mjs'), 'src/app.mjs'] } };
  env.c.parallelTasks.push(fakeTask);
  env.board.update(env.c, env.card(directCard.id), { column: 'done', task: fakeTask.id, result: { status: 'integrated', files: 1, tests: 'passed', summary: 'Done', at: new Date().toISOString() } });
  const fallback = env.board.answer(env.c, directCard.id);
  assert.equal(fallback.filesSource, 'recorded');
  assert.deepEqual(fallback.files, [{ path: 'src/app.mjs' }]);
});

test("answering a planner's questions carries forward the attached brief across ask-first and redraft turns (#162)", { skip: scriptCLIs }, async t => {
  const env = setup(t);
  const brief = env.broker.attachments.put({ name: "brief.md", data: Buffer.from("# Brief\nUse SQLite and session cookies.\n").toString("base64") });
  const workspaceNote = env.broker.attachments.put({ name: "Workspace chat.md", data: Buffer.from("# Workspace chat\nContext.\n").toString("base64") });
  const folder = env.folder("a"), scenariosFile = path.join(folder, ".mock-scenarios.json");
  const askReply = JSON.stringify({ summary: "One question before drafting.", steps: [], questions: [{ question: "Storage?", options: ["SQLite", "Postgres"] }] });
  const draftWithQuestion = JSON.stringify({ summary: "Initial draft.", steps: [{ id: "db", title: "Set up SQLite", instructions: "Create schema.", tier: "standard", dependsOn: [] }], questions: [{ question: "Session TTL?", options: ["24h", "7d"] }] });
  const finalDraft = JSON.stringify({ summary: "Final draft.", steps: [{ id: "db", title: "Set up SQLite with 24h sessions", instructions: "Create schema and 24h session store.", tier: "standard", dependsOn: [] }] });

  const chatTask = env.board.chat(env.c).task, lane = env.lane(chatTask.id);
  const writeScenario = (needle, replyText) => {
    const saved = JSON.parse(fs.readFileSync(scenariosFile, "utf8"));
    saved[`~${needle}`] = { text: replyText };
    fs.writeFileSync(scenariosFile, JSON.stringify(saved));
  };

  // 1. First turn in Plan chat with brief.md (and Workspace chat.md) attached: planner asks a question before drafting.
  const goal1 = "Draft cards for the auth service.";
  writeScenario("1. Session TTL?", finalDraft);
  writeScenario("1. Storage?", draftWithQuestion);
  writeScenario(goal1, askReply);
  lane.broker.start(lane.c, { text: goal1, attachments: [brief.id, workspaceNote.id], provider: "codex", orchestrate: true });
  await lane.broker.running.done;
  assert.equal(lane.c.orchestrations[0].status, "questions");
  assert.deepEqual(lane.c.orchestrations[0].documents, ["brief.md"], "Workspace chat.md is not listed as a requirement document.");

  // 2. Answering the ask-first questions on another provider (fresh session) without re-sending attachment IDs keeps brief.md.
  const goal2 = [goal1, "", "My answers to your questions:", "", "1. Storage?", "   SQLite"].join("\n");
  lane.broker.start(lane.c, { text: goal2, provider: "claude", transport: "cli", orchestrate: true });
  await lane.broker.running.done;
  const secondPlan = lane.c.orchestrations[0];
  assert.deepEqual(secondPlan.documents, ["brief.md"], "The carried brief stays on the new orchestration.");
  const captured = env.captured(fs.realpathSync(folder));
  const claudeCapture = captured.findLast(entry => entry.provider === "claude");
  assert.match(claudeCapture.context.currentRequest, /requirements in the attached brief\.md\. They are material/);
  assert.match(claudeCapture.context.currentRequest, /Use SQLite and session cookies\./, "The fresh session receives the attached brief text.");

  // 3. Answering a drafted batch's follow-up questions with replaces also carries forward brief.md.
  const goal3 = ["Redraft the plan with my answers to your questions. Keep what still fits, and change only what the answers affect.", "", "1. Session TTL?", "   24h"].join("\n");
  lane.broker.start(lane.c, { text: goal3, provider: "codex", orchestrate: true, replaces: secondPlan.id });
  await lane.broker.running.done;
  assert.deepEqual(lane.c.orchestrations[0].documents, ["brief.md"]);
});

test("a worktree card that changes files without edit tool events reports the worktree file count and unverified tests (#162)", { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.start(env.c, { text: "Hold main", provider: "codex", mode: "edit", approvalPolicy: "ask" });
  const main = env.broker.running;
  await until(() => env.captured(fs.realpathSync(env.folder("a"))).length, "the main run");

  const card = env.add({ title: "Generate output via shell", column: "ready" });
  env.script(card, "hold", "Generated the file via shell.");
  const { tasks } = env.board.run(env.c, { ids: [card.id] });
  const task = env.task(tasks[card.id]);
  await until(() => task.scopePath && env.captured(task.scopePath).length, "the worktree card run");
  fs.writeFileSync(path.join(task.scopePath, "shell-output.txt"), "built by shell command\n");
  env.release(task.scopePath);
  await until(() => column(env, card) === "review" && env.card(card.id).result?.tests && env.card(card.id).result.tests !== "running", "the card to finish its step check in Review");

  const finished = env.card(card.id);
  assert.equal(finished.result.files, 1, "The card result counts the file changed in its worktree copy.");
  assert.equal(finished.result.tests, "unverified", "Changing a file in the worktree copy is not marked no-change.");
  assert.deepEqual(env.task(task.id).stepResult.files, ["shell-output.txt"]);
  assert.equal(env.task(task.id).stepCheck.outcome, "unverified");
  assert.equal(env.board.answer(env.c, card.id).files.length, 1);

  env.release(fs.realpathSync(env.folder("a")));
  await main.done;
});

test('Suggest next warns on out-of-order specialist steps and ignores draft, done or closed contracts (#89)', t => {
  const env = setup(t);
  const now = new Date().toISOString();
  const contract = env.add({ title: 'Agree promo contract', column: 'ready', role: 'backend', artifact: 'contract', group: 'Promo' });
  const draftContract = env.add({ title: 'Draft promo contract', column: 'backlog', role: 'backend', artifact: 'contract', group: 'Promo' });
  env.board.update(env.c, env.card(draftContract.id), { draft: { by: { kind: 'agent' }, at: now, batch: { id: 'b1', summary: 'Draft' }, notes: [] } });
  const doneContract = env.add({ title: 'Done promo contract', column: 'ready', role: 'backend', artifact: 'contract', group: 'Promo' });
  env.board.update(env.c, env.card(doneContract.id), { column: 'done' });
  env.add({ title: 'Closed promo contract', column: 'ready', role: 'backend', artifact: 'contract', group: 'Promo', closed: true });
  env.add({ title: 'Other group contract', column: 'ready', role: 'backend', artifact: 'contract', group: 'Other' });
  const target = env.add({ title: 'Prepare promo assets', column: 'ready', group: 'Promo' });

  const [missingId] = env.board.draftSuggested(env.c, env.card(target.id), parseSuggest(JSON.stringify({
    summary: 'Add frontend step.',
    steps: [{ title: 'Build promo banner', instructions: 'Render banner.', tier: 'light', role: 'frontend', dependsOn: [] }],
  })), { suggestId: 'sug-order-1' });
  const missingNotes = env.card(missingId).draft.notes.join(' ');
  assert.match(missingNotes, /doesn’t wait for “Agree promo contract”/);
  assert.doesNotMatch(missingNotes, /Draft promo contract|Done promo contract|Closed promo contract|Other group contract/);

  // Once the open contract is done, no missing-contract warning is emitted.
  env.board.update(env.c, env.card(contract.id), { column: 'done' });
  const [cleanId] = env.board.draftSuggested(env.c, env.card(target.id), parseSuggest(JSON.stringify({
    summary: 'Add second frontend step.',
    steps: [{ title: 'Build promo footer', instructions: 'Render footer.', tier: 'light', role: 'frontend', dependsOn: [] }],
  })), { suggestId: 'sug-order-2' });
  assert.equal(env.card(cleanId).draft.notes.some(n => /doesn’t wait for/.test(n)), false);

  // Build step following QA/reviewer warns; contract/schema following build work warns.
  const qa = env.add({ title: 'Verify promo flow', column: 'ready', role: 'qa', group: 'QA' });
  const [afterQaId] = env.board.draftSuggested(env.c, env.card(qa.id), parseSuggest(JSON.stringify({
    summary: 'Follow-up UI.',
    steps: [{ title: 'Fix promo UI', instructions: 'Adjust spacing.', tier: 'light', role: 'frontend', dependsOn: [] }],
  })), { suggestId: 'sug-order-3' });
  assert.match(env.card(afterQaId).draft.notes.join(' '), /builds on “Verify promo flow”, a QA card/);

  const reviewer = env.add({ title: 'Review promo flow', column: 'ready', role: 'reviewer', group: 'Review' });
  const [afterRevId] = env.board.draftSuggested(env.c, env.card(reviewer.id), parseSuggest(JSON.stringify({
    summary: 'Follow-up API.',
    steps: [{ title: 'Adjust promo API', instructions: 'Fix endpoint.', tier: 'light', role: 'backend', dependsOn: [] }],
  })), { suggestId: 'sug-order-4' });
  assert.match(env.card(afterRevId).draft.notes.join(' '), /builds on “Review promo flow”, a review card/);

  const built = env.add({ title: 'Implement checkout', column: 'ready', role: 'backend', group: 'Checkout' });
  const [lateContractId] = env.board.draftSuggested(env.c, env.card(built.id), parseSuggest(JSON.stringify({
    summary: 'Document contract.',
    steps: [{ title: 'Define checkout contract', instructions: 'Write spec.', tier: 'light', role: 'backend', artifact: 'contract', dependsOn: [] }],
  })), { suggestId: 'sug-order-5' });
  assert.match(env.card(lateContractId).draft.notes.join(' '), /This contract comes after building work \(“Implement checkout”\)/);
});

test('Board.run enforces specialist workflow ordering across contract, schema, build and check cards (#89)', t => {
  const env = setup(t);
  // 1. Specialist build cannot depend (even transitively) on a check card.
  const qa = env.add({ title: 'Run QA', column: 'ready', role: 'qa', group: 'G1' });
  const mid = env.add({ title: 'Summarize QA', column: 'ready', role: 'builder', group: 'G1', dependsOn: [qa.id] });
  const feAfterCheck = env.add({ title: 'Build UI after QA', column: 'ready', role: 'frontend', group: 'G1', dependsOn: [mid.id] });
  assert.throws(() => env.board.run(env.c, { ids: [qa.id, mid.id, feAfterCheck.id] }), /cannot depend on check card “Run QA”/);

  // 2. Contract or schema card cannot depend on a non-contract build card.
  const buildFirst = env.add({ title: 'Build first', column: 'ready', role: 'frontend', group: 'G2' });
  const lateSchema = env.add({ title: 'Write schema', column: 'ready', role: 'database', artifact: 'schema', group: 'G2', dependsOn: [buildFirst.id] });
  assert.throws(() => env.board.run(env.c, { ids: [buildFirst.id, lateSchema.id] }), /cannot depend on build card “Build first”/);

  // 3. Specialist builds must wait for non-done same-group contract cards, and database/backend must wait for schema cards.
  const contract = env.add({ title: 'Define promo contract', column: 'ready', role: 'backend', artifact: 'contract', group: 'Promo' });
  const feNoContract = env.add({ title: 'Build promo UI', column: 'ready', role: 'frontend', group: 'Promo' });
  assert.throws(() => env.board.run(env.c, { ids: [feNoContract.id] }), /must depend on contract card “Define promo contract”/);

  const schema = env.add({ title: 'Add promo schema', column: 'ready', role: 'database', artifact: 'schema', group: 'Promo', dependsOn: [contract.id] });
  const beNoSchema = env.add({ title: 'Implement promo API', column: 'ready', role: 'backend', group: 'Promo', dependsOn: [contract.id] });
  assert.throws(() => env.board.run(env.c, { ids: [contract.id, schema.id, beNoSchema.id] }), /must depend on schema card “Add promo schema”/);
  assert.equal(env.c.parallelTasks?.length || 0, 0, 'Rejected runs record no tasks.');
});

test('board_card_artifact and board_card_outcome persist, invalidate downstream cards on contract/schema changes, and clear on recheck or rerun (#89)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  let command = { command: 'node -e "process.exit(0)"', directory: '' };
  env.broker.tasks.tests = { saved: () => command };

  const contract = env.add({ title: 'Agree API contract', column: 'ready', role: 'backend', artifact: 'contract', group: 'Feature' });
  const ui = env.add({ title: 'Build feature UI', column: 'ready', role: 'frontend', dependsOn: [contract.id], files: ['src/ui.js'], group: 'Feature' });
  env.script(contract, null, 'Contract v1: POST /promo returns { discountPct }.');
  env.script(ui, null, 'Built feature UI.');

  env.board.run(env.c, { ids: [contract.id, ui.id] });
  await until(() => column(env, contract) === 'review' && column(env, ui) === 'review' && env.card(ui.id).result?.tests === 'passed', 'initial run to finish');
  assert.equal(env.c.boardArtifacts?.[contract.id]?.kind, 'contract');
  assert.match(env.c.boardArtifacts?.[contract.id]?.content || '', /Contract v1/);
  assert.equal(env.c.boardOutcomes?.[ui.id]?.outcome, 'passed');
  assert.equal(env.card(ui.id).needsRecheck, undefined);

  // Material edit on an upstream contract/schema card invalidates finished downstream cards.
  env.board.edit(env.c, contract.id, { notes: 'Contract v2: return { discountCents }.' });
  assert.equal(env.card(ui.id).needsRecheck, true);
  assert.deepEqual([env.card(ui.id).invalidatedBy?.cardId, env.card(ui.id).invalidatedBy?.kind, env.card(ui.id).invalidatedBy?.revision], [contract.id, 'contract', '2']);

  await env.reopen();
  assert.equal(env.card(ui.id).needsRecheck, true);
  assert.equal(env.board.list(env.c).find(item => item.id === ui.id).needsRecheck, true);
  assert.equal(env.c.boardArtifacts?.[contract.id]?.kind, 'contract');
  assert.equal(env.c.boardOutcomes?.[ui.id]?.outcome, 'passed');

  // Rechecking the downstream card with passing tests clears needsRecheck/invalidatedBy.
  env.broker.tasks.tests = { saved: () => command };
  env.board.recheck(env.c, ui.id);
  await until(() => env.card(ui.id).needsRecheck === false && env.task(env.card(ui.id).task)?.stepCheck?.status === 'done', 'recheck to clear needsRecheck');
  assert.equal(env.card(ui.id).invalidatedBy, null);

  // Re-running an upstream contract card to completion records a fresh board_card_artifact and re-invalidates downstream Review/Done cards.
  env.board.accept(env.c, ui.id);
  assert.equal(column(env, ui), 'done');
  env.board.sendBack(env.c, contract.id, { reason: 'Revise contract' });
  env.script(contract, null, 'Contract v3: add currency field.');
  env.board.run(env.c, { ids: [contract.id] });
  await until(() => column(env, contract) === 'review' && /Contract v3/.test(env.c.boardArtifacts?.[contract.id]?.content || ''), 're-run contract to record new artifact');
  assert.equal(env.card(ui.id).needsRecheck, true);
  assert.equal(env.card(ui.id).invalidatedBy?.cardId, contract.id);

  // Failing a card's tests and calling proceed records an accepted board_card_outcome; re-running an invalidated card clears needsRecheck.
  env.board.accept(env.c, contract.id);
  env.board.move(env.c, ui.id, { column: 'ready' });
  command = { command: 'node -e "process.exit(2)"', directory: '' };
  env.board.run(env.c, { ids: [ui.id] });
  assert.equal(env.card(ui.id).needsRecheck, false);
  await until(() => env.task(env.card(ui.id).task)?.stepCheck?.outcome === 'failed', 'ui tests to fail');
  env.board.proceed(env.c, ui.id);
  await env.reopen();
  assert.equal(env.c.boardOutcomes?.[ui.id]?.status, 'accepted');
  assert.equal(env.c.boardOutcomes?.[ui.id]?.accepted, true);
});

test('TaskCoordinator.ledgers attributes role, scopeFiles and board vs group plan IDs, and summarizePlans aggregates them (#89)', { skip: scriptCLIs }, async t => {
  const env = setup(t);
  env.broker.tasks.tests = { saved: () => null };
  const ungrouped = env.add({ title: 'Standalone backend fix', column: 'ready', role: 'backend', files: ['src/a.js', 'src/b.js'] });
  const grouped = env.add({ title: 'Grouped frontend UI', column: 'ready', role: 'frontend', group: 'Checkout', files: ['public/checkout.js'] });
  env.script(ungrouped, null, 'Fixed backend.');
  env.script(grouped, null, 'Built checkout UI.');

  const { tasks } = env.board.run(env.c, { ids: [ungrouped.id, grouped.id] });
  await until(() => column(env, ungrouped) === 'review' && column(env, grouped) === 'review', 'both cards to reach Review');

  const ledgers = await env.broker.tasks.ledgers();
  const byTask = new Map(ledgers.map(item => [item.parallelTask, item]));
  const uEntry = byTask.get(tasks[ungrouped.id]);
  const gEntry = byTask.get(tasks[grouped.id]);
  assert.equal(uEntry.role, 'backend');
  assert.equal(uEntry.scopeFiles, 2);
  assert.equal(uEntry.plan.id, `board:${env.task(tasks[ungrouped.id]).board.run}`);
  assert.equal(gEntry.role, 'frontend');
  assert.equal(gEntry.scopeFiles, 1);
  assert.equal(gEntry.plan.id, 'group:Checkout');

  const plans = summarizePlans(ledgers);
  assert.equal(plans.length, 2);
  const checkoutPlan = plans.find(item => item.id === 'group:Checkout');
  const boardPlan = plans.find(item => item.id.startsWith('board:'));
  assert.equal(checkoutPlan.steps, 1);
  assert.ok(checkoutPlan.roles.frontend);
  assert.equal(boardPlan.steps, 1);
  assert.ok(boardPlan.roles.backend);
});

test('a Design card hands design notes to the frontend, and a card carries its screenshots to its task (#125)', t => {
  const env = setup(t);
  // A Design card produces design notes unless you chose what it produces, and is told how to write them.
  const design = env.add({ title: 'Design the pricing page', column: 'ready', role: 'design', group: 'Pricing' });
  assert.equal(design.artifact, 'design');
  assert.equal(env.add({ title: 'Design tokens', role: 'design', artifact: 'diff' }).artifact, 'diff', 'What you chose stays.');
  assert.match(env.board.prompt(env.c, env.card(design.id)), /your report is this card’s design notes[\s\S]*You are the designer for this card[\s\S]*heading “Design notes”/);
  // The frontend card in its group waits for it; once it does, it can run.
  const frontend = env.add({ title: 'Build the pricing page', column: 'ready', role: 'frontend', group: 'Pricing' });
  assert.throws(() => env.board.run(env.c, { ids: [frontend.id] }), /must depend on design card “Design the pricing page”/);
  env.board.edit(env.c, frontend.id, { dependsOn: [design.id] });
  assert.match(env.board.prompt(env.c, env.card(frontend.id), { [design.id]: { status: 'integrated', files: [], summary: '## Design notes\n1. Plans: three cards.' } }), /“Design the pricing page” \(design\)\n {2}Its changes were merged into the folder\.\n {2}Its design notes, in its own words:\n {4}## Design notes\n {4}1\. Plans: three cards\./);

  // Attachments: saved files only, up to 6, named in the prompt and the export, and sent with the card's task.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const shot = env.broker.attachments.put({ name: 'design-page.png', data: png });
  assert.throws(() => env.add({ title: 'Missing', attachments: ['0'.repeat(64)] }), /no longer available/);
  assert.throws(() => env.add({ title: 'Too many', attachments: Array(7).fill(shot.id) }), /up to 6 files/);
  assert.throws(() => env.add({ title: 'Not ids', attachments: [{ id: shot.id }] }), /up to 6 files/);
  const card = env.add({ title: 'Apply the design notes', column: 'ready', notes: 'Design notes for the preview of localhost:3000, 1 section.', attachments: [shot.id] });
  assert.deepEqual(card.attachments, [{ id: shot.id, name: 'design-page.png', kind: 'image', mime: 'image/png', bytes: shot.bytes }]);
  assert.match(env.board.prompt(env.c, env.card(card.id)), /Attached to this card, and given with this message: design-page\.png\./);
  assert.match(env.board.markdown(env.c), /Attached: design-page\.png/);
  const before = env.card(card.id).revision;
  env.board.edit(env.c, card.id, { attachments: [] });
  assert.equal(env.card(card.id).revision, before + 1, 'Taking a screenshot off changes what the agent gets.');
  assert.doesNotMatch(env.board.prompt(env.c, env.card(card.id)), /Attached to this card/);
  env.board.edit(env.c, card.id, { attachments: [shot.id] });
  const { tasks } = env.board.run(env.c, { ids: [card.id] });
  assert.deepEqual(env.task(tasks[card.id]).attachments, [shot.id]);
});

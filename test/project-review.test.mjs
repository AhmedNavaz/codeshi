import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { ProjectRegistry } from '../src/projects.mjs';
import { ProjectCommands } from '../src/project-commands.mjs';
import { ProjectReview, readReviewPlan, validateReviewPlan, preparationPrompt, parsePreparedReviewPlan } from '../src/project-review.mjs';
import { Broker } from '../src/broker.mjs';
import { scriptCLIs } from './platform.mjs';
import { createRelayServer } from '../src/server.mjs';

const quote = value => process.platform === 'win32' ? `"${value}"` : "'" + value.replaceAll("'", "'\\''") + "'";
const nodeCommand = file => `${quote(process.execPath)} ${quote(file)}`;
const waitFor = async fn => { const until = Date.now() + 7000; while (!fn()) { if (Date.now() > until) throw Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-review-')));
  const web = path.join(root, 'web'), api = path.join(root, 'api'); fs.mkdirSync(web); fs.mkdirSync(api);
  const registry = new ProjectRegistry({ dataRoot: path.join(root, 'data'), lock: false });
  const project = registry.add({ folders: [web, api] });
  const commands = new ProjectCommands({ registry, stopGrace: 20 }), review = new ProjectReview({ registry, commands });
  t.after(async () => { await review.close(); await commands.close(); await registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(web, '.codeshi/preview.json');
  const write = plan => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(plan)); return readReviewPlan(project); };
  const task = (id = 'setup') => ({ id, name: id, description: 'Prepare local fixture', folder: project.folders[0].name, directory: '', command: `${quote(process.execPath)} -e "process.stdout.write('done')"`, kind: 'task' });
  const plan = services => ({ version: 1, profiles: [{ id: 'dev', name: 'Development', services }] });
  return { root, web, api, registry, project, commands, review, write, task, plan, filename };
}
function launch(f, plan) { const saved = f.write(plan); return f.review.start(f.project.id, { revision: saved.revision, profileId: 'dev' }); }

test('background preparation uses Flow assessment across all folders while the main chat keeps working', { skip: scriptCLIs }, async t => {
  const f = fixture(t), bin = path.join(f.root, 'codex.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs', import.meta.url).href)};\n`, { mode: 0o700 });
  Object.assign(f.registry.bins, { codex: bin, claude: path.join(f.root, 'missing'), gemini: path.join(f.root, 'missing') });
  const broker = f.registry.broker(f.project.id), c = broker.get(f.registry.mainConversationId(f.project.id));
  broker.availableProviders = () => ['codex'];
  broker.settings(c, { mode: 'edit', approvalPolicy: 'auto' });
  broker.setRouting(c, { mode: 'smart' });
  let assessments = 0;
  broker.tasks.BrokerClass = class extends Broker {
    constructor(options) {
      super(options);
      this.availableProviders = () => ['codex'];
      this.handoff.account = async () => ({ installed: true, authenticated: true, billingSource: 'subscription' });
      this.handoff.models = async () => ({ data: [{ id: 'gpt-codex', supportedEffortLevels: ['low', 'medium', 'high'] }] });
      this.checks.usage = async () => ({ available: true, checkedAt: new Date().toISOString(), windows: [{ usedPercent: 10 }] });
      this.router.worker = async () => { assessments++; return JSON.stringify({ tier: 'standard', effort: 'medium', reason: 'Inspect app launch requirements' }); };
    }
  };
  const map = f.plan([f.task()]), prompt = preparationPrompt(f.project, '', null);
  // Agents frequently format responses with introductory conversational text and markdown fences.
  fs.writeFileSync(path.join(f.web, '.mock-scenarios.json'), JSON.stringify({ 'Keep coding': { behavior: 'hold' }, [prompt]: { text: "The launch map for Bizbay is ready:\n\n```json\n" + JSON.stringify(map, null, 2) + "\n```\nLet me know if you need any adjustments.", behavior: 'hold' } }));
  broker.budget.setPolicy(c, { ...broker.budget.policy(c), allowedModels: { codex: ['gpt-codex'] } });
  broker.start(c, { text: 'Keep coding', provider: 'codex', model: 'gpt-codex', mode: 'edit', approvalPolicy: 'auto' });
  const mainRun = broker.running;
  const input = { executionRevision: broker.execution.defaults(c).revision, requestId: 'prepare-test', change: '' };
  const value = f.review.prepare(f.project.id, input), task = broker.tasks.find(c, value.preparation.id);
  await waitFor(() => assessments && broker.tasks.lane(c, task)?.c?.messages.some(message => message.role === 'assistant')).catch(error => { throw Error(`${error.message}: ${JSON.stringify({ assessments, task: broker.tasks.public(task), messages: broker.tasks.lane(c, task)?.c?.messages })}`); });
  const lane = broker.tasks.lane(c, task);
  assert.equal(lane.broker.workspaceFolders.length, 2);
  assert.equal(task.accessMode, 'read'); assert.equal(task.routing.mode, 'smart');
  assert.equal(task.approvalPolicy, 'ask', 'Read-only preparation does not inherit full auto-approval.');
  assert.equal(lane.c.activeRun.approvalPolicy, 'ask');
  assert.equal(c.approvalPolicy, 'auto', 'The main conversation keeps its approval setting.');
  assert.equal(lane.c.activeRun?.model, 'gpt-codex', 'The dispatcher selects an allowed model rather than requiring a manual one.');
  assert.equal(task.mode, 'direct'); assert.equal(task.worktree, undefined);
  assert.throws(() => lane.broker.checkRunSettings('codex', 'edit', 'ask'), /only inspects files/, 'Preparation cannot turn into a concurrent writer.');
  assert.equal(broker.running, mainRun, 'Preparation does not replace or stop the main run.');
  assert.equal(c.messages.filter(message => message.role === 'user').length, 1, 'The internal request never enters the main chat.');
  assert.equal(f.review.prepare(f.project.id, input).preparation.id, task.id, 'Repeated clicks share the active preparation.');
  assert.equal(fs.existsSync(f.filename), false, 'Partial output is not saved.');
  fs.writeFileSync(path.join(f.web, '.release'), '');
  await waitFor(() => f.review.state(f.project.id).preparation?.status === 'ready');
  assert.equal(readReviewPlan(f.project).profiles[0].services[0].command, map.profiles[0].services[0].command);
  assert.equal(f.commands.sessions.size, 0, 'Preparing never starts project services.');
  await mainRun.done;
  fs.unlinkSync(path.join(f.web, '.release'));
  const source = fs.readFileSync(f.filename, 'utf8'), change = 'Add a second profile';
  fs.writeFileSync(path.join(f.web, '.mock-scenarios.json'), JSON.stringify({ [preparationPrompt(f.project, change, source)]: { text: JSON.stringify(map), behavior: 'hold' } }));
  const update = f.review.prepare(f.project.id, { ...input, requestId: 'prepare-update', change });
  const updateTask = broker.tasks.find(c, update.preparation.id);
  await waitFor(() => broker.tasks.lane(c, updateTask)?.c?.messages.some(message => message.role === 'assistant'));
  const manual = JSON.stringify({ ...map, profiles: [{ ...map.profiles[0], name: 'My manual edit' }] });
  fs.writeFileSync(f.filename, manual); fs.writeFileSync(path.join(f.web, '.release'), '');
  await waitFor(() => f.review.state(f.project.id).preparation.status === 'failed');
  assert.match(f.review.state(f.project.id).preparation.error, /changed during preparation/);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), manual, 'Concurrent launch-map edits survive preparation.');
  fs.writeFileSync(path.join(f.web, '.mock-scenarios.json'), JSON.stringify({ [preparationPrompt(f.project, 'Invalid result', manual)]: { text: '{"version":1,"profiles":[]}' } }));
  f.review.prepare(f.project.id, { ...input, requestId: 'prepare-invalid', change: 'Invalid result' });
  await waitFor(() => f.review.state(f.project.id).preparation.status === 'failed');
  assert.match(f.review.state(f.project.id).preparation.error, /one to four profiles/);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), manual, 'Invalid results never replace the saved map.');
  fs.unlinkSync(path.join(f.web, '.release'));
  fs.writeFileSync(path.join(f.web, '.mock-scenarios.json'), JSON.stringify({ [preparationPrompt(f.project, 'Cancel this', manual)]: { text: JSON.stringify(map), behavior: 'hold' } }));
  const cancelled = f.review.prepare(f.project.id, { ...input, requestId: 'prepare-cancel', change: 'Cancel this' });
  const cancelledTask = broker.tasks.find(c, cancelled.preparation.id);
  await waitFor(() => broker.tasks.lane(c, cancelledTask)?.c?.messages.some(message => message.role === 'assistant'));
  f.review.stopPreparation(f.project.id, { taskId: cancelled.preparation.id });
  await waitFor(() => f.review.state(f.project.id).preparation.status === 'stopped');
  assert.equal(fs.readFileSync(f.filename, 'utf8'), manual, 'Stopping never saves a partial map.');
});

test('review maps validate folder identity, dependency order, commands and loopback addresses without executing', t => {
  const f = fixture(t);
  const setup = f.task(), web = { ...f.task('web'), folder: f.project.folders[1].id, kind: 'service', dependsOn: ['setup'], ready: { url: 'http://localhost:38001' } };
  const raw = f.plan([web, setup]); raw.profiles[0].preview = { service: 'web', url: 'http://localhost:38001' };
  const saved = f.write(raw); assert.deepEqual(saved.profiles[0].order, ['setup', 'web']);
  assert.equal(saved.profiles[0].services[0].folderId, f.project.folders[1].id);
  assert.equal(f.commands.sessions.size, 0);
  for (const change of [
    plan => { delete plan.profiles[0].id; },
    plan => { delete plan.profiles[0].services[0].id; },
    plan => { plan.profiles[0].services[0].folder = 'missing-folder'; },
    plan => { plan.profiles[0].services[0].directory = '../api'; },
    plan => { plan.profiles[0].services[0].command = 'echo a\necho b'; },
    plan => { plan.profiles[0].services[1].dependsOn = ['web']; },
    plan => { plan.profiles[0].services[0].dependsOn = ['missing']; },
    plan => { plan.profiles[0].services[0].ready = { url: 'http://example.com' }; },
    plan => { plan.profiles[0].preview.url = 'http://127.0.0.1@evil.example'; },
    plan => { plan.profiles[0].preview.url = 'http://localhost:39001'; },
    plan => { plan.profiles[0].services.push({ ...web, id: 'another' }); },
  ]) { const next = structuredClone(raw); change(next); assert.throws(() => validateReviewPlan(next, f.project)); }
});

test('long or many prerequisites are shortened for the card instead of failing the launch map', t => {
  const f = fixture(t), raw = f.plan([f.task()]);
  const mongo = `MongoDB running on 127.0.0.1:27017 (already running locally; backend APP_ENV=local reads the bizbaydev database from it)${', with a seeded admin user'.repeat(6)}`;
  raw.profiles[0].prerequisites = ['node', '  npm  ', ' ', mongo, ...Array.from({ length: 9 }, (_, index) => `Tool ${index + 1}`)];
  const [profile] = f.write(raw).profiles;
  assert.equal(profile.prerequisites.length, 10, 'At most ten lines, as the agent is asked.');
  assert.deepEqual(profile.prerequisites.slice(0, 2), ['node', 'npm']);
  assert.equal(profile.prerequisites[2].length, 200); assert.equal(profile.prerequisites[2], `${mongo.slice(0, 199)}…`);
  assert.deepEqual(profile.prerequisites.slice(3), ['Tool 1', 'Tool 2', 'Tool 3', 'Tool 4', 'Tool 5', 'Tool 6', '3 more in .codeshi/preview.json']);
  assert.equal(JSON.parse(fs.readFileSync(f.filename, 'utf8')).profiles[0].prerequisites[3], mongo, 'The map itself keeps what the agent wrote.');
  // It is still a list of text.
  for (const value of [{}, 'node', [{ name: 'node' }], [42]]) { const next = structuredClone(raw); next.profiles[0].prerequisites = value; assert.throws(() => validateReviewPlan(next, f.project), /prerequisite/i); }
  assert.match(preparationPrompt(f.project), /At most 10 prerequisites per profile, each one line under 120 characters/);
});

test('review exposes multiple destinations from existing maps and validates explicit destinations', t => {
  const f = fixture(t);
  const services = ['website', 'admin'].map((id, index) => ({ ...f.task(id), kind: 'service', ready: { url: `http://localhost:${38001 + index}` } }));
  const raw = f.plan(services); raw.profiles[0].preview = { service: 'website', url: 'http://localhost:38001/shop' };
  const saved = validateReviewPlan(raw, f.project);
  assert.deepEqual(saved.profiles[0].previews, [
    { service: 'website', url: 'http://localhost:38001/shop' }, { service: 'admin', url: 'http://localhost:38002/' },
  ]);
  const run = { id: 'multi', projectId: f.project.id, profile: saved.profiles[0], status: 'ready', steps: { website: { status: 'ready' }, admin: { status: 'ready' } } };
  assert.deepEqual(f.review.view(run).previews, saved.profiles[0].previews);
  run.status = 'stopped'; assert.deepEqual(f.review.view(run).previews, []);
  raw.profiles[0].previews = [{ service: 'admin', url: 'http://localhost:38002/dashboard' }];
  assert.equal(validateReviewPlan(raw, f.project).profiles[0].preview.url, 'http://localhost:38002/dashboard');
  for (const destination of [{ service: 'admin', url: 'http://localhost:38001' }, { service: 'missing', url: 'http://localhost:38002' }, { service: 'admin', url: 'https://example.com' }]) {
    raw.profiles[0].previews = [destination]; assert.throws(() => validateReviewPlan(raw, f.project));
  }
});

test('review launches setup and services across folders, waits for readiness, preserves named commands and stops owned processes', async t => {
  const f = fixture(t), port = await freePort(), webPort = await freePort();
  fs.writeFileSync(path.join(f.web, 'setup.cjs'), "require('node:fs').writeFileSync('ready.txt','ok')");
  fs.writeFileSync(path.join(f.api, 'server.cjs'), `const fs=require('node:fs'); if(!fs.existsSync(${JSON.stringify(path.join(f.web, 'ready.txt'))}))process.exit(2); require('node:http').createServer((q,s)=>s.end('ready')).listen(${port},'127.0.0.1'); console.log('started backend');`);
  fs.writeFileSync(path.join(f.web, 'web.cjs'), `fetch('http://127.0.0.1:${port}').then(r=>{if(!r.ok)process.exit(2);require('node:http').createServer((q,s)=>s.end('frontend ready')).listen(${webPort},'127.0.0.1');});`);
  const setup = { ...f.task(), command: nodeCommand('setup.cjs') }, backend = { ...f.task('backend'), folder: f.project.folders[1].name, command: nodeCommand('server.cjs'), kind: 'service', dependsOn: ['setup'], ready: { url: `http://127.0.0.1:${port}` } };
  const frontend = { ...f.task('frontend'), command: nodeCommand('web.cjs'), kind: 'service', dependsOn: ['backend'], ready: { url: `http://127.0.0.1:${webPort}` } };
  const raw = f.plan([backend, setup, frontend]); raw.profiles[0].preview = { service: 'frontend', url: `http://127.0.0.1:${webPort}` };
  f.commands.save(f.project.id, { name: 'Existing command', folderId: f.project.folders[0].id, directory: '', command: 'echo existing' });
  const started = launch(f, raw); assert.equal(started.status, 'starting');
  assert.throws(() => f.review.start(f.project.id, { revision: started.revision, profileId: 'dev' }), /Stop/);
  const run = f.review.runs.get(f.project.id); await run.done;
  const state = f.review.state(f.project.id); assert.equal(state.run.status, 'ready'); assert.equal(state.run.preview.url, `http://127.0.0.1:${webPort}/`);
  assert.equal(await (await fetch(state.run.preview.url)).text(), 'frontend ready');
  assert.equal(state.run.steps.find(step => step.id === 'setup').status, 'done');
  assert.equal(state.run.steps[0].session.cwd, f.api); assert.match(state.run.steps[0].session.output, /started backend/);
  assert.equal(f.commands.list(f.project.id).length, 1, 'Normal Run commands are untouched.');
  await assert.rejects(f.review.stop(f.project.id, 'old-session'), /session changed/);
  // Broken/edited recipes never hide the current Stop or log state.
  fs.writeFileSync(f.filename, '{broken'); assert.match(f.review.state(f.project.id).error, /valid JSON/);
  await f.review.stop(f.project.id, run.id); assert.equal(f.review.state(f.project.id).run.status, 'stopped');
  assert.equal(f.commands.active(f.project.id), false);
  const restored = new ProjectReview({ registry: f.registry, commands: f.commands });
  assert.equal(restored.state(f.project.id).run, null, 'Restart does not auto-launch a saved plan.');
});

test('changed review revisions are rejected and missing maps are inert', t => {
  const f = fixture(t); assert.equal(f.review.state(f.project.id).plan, null);
  const raw = f.plan([f.task()]), saved = f.write(raw);
  raw.profiles[0].services[0].command = 'echo changed'; f.write(raw);
  assert.throws(() => f.review.start(f.project.id, { revision: saved.revision, profileId: 'dev' }), /changed/);
  assert.equal(f.commands.sessions.size, 0);
});

test('failed setup blocks dependent services and keeps its output', async t => {
  const f = fixture(t), setup = { ...f.task(), command: `${quote(process.execPath)} -e "console.error('missing prerequisite');process.exit(3)"` };
  launch(f, f.plan([setup, { ...f.task('web'), dependsOn: ['setup'] }]));
  await f.review.runs.get(f.project.id).done;
  const run = f.review.state(f.project.id).run;
  assert.equal(run.status, 'failed'); assert.equal(run.steps[1].status, 'blocked'); assert.equal(run.steps[1].session, null);
  assert.match(run.steps[0].session.output, /missing prerequisite/); assert.equal(run.steps[0].session.exitCode, 3);
});

test('occupied ports are rejected before any setup executes, leaving the unrelated server alive', async t => {
  const f = fixture(t), external = http.createServer((req, res) => res.end('not ours'));
  external.listen(0, '127.0.0.1'); await once(external, 'listening'); t.after(() => new Promise(resolve => external.close(resolve)));
  const port = external.address().port;
  launch(f, f.plan([f.task(), { ...f.task('web'), kind: 'service', dependsOn: ['setup'], ready: { port } }]));
  await f.review.runs.get(f.project.id).done;
  assert.match(f.review.state(f.project.id).run.error, /already in use/);
  assert.match(f.review.state(f.project.id).run.error, new RegExp(String(port)));
  assert.equal(f.commands.sessions.size, 0);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'not ours');
});

test('Stop cancels readiness waits and never dispatches dependent steps', async t => {
  const f = fixture(t), port = await freePort();
  launch(f, f.plan([{ ...f.task('web'), command: `${quote(process.execPath)} -e "setInterval(()=>{},1000)"`, kind: 'service', ready: { port } }, { ...f.task('after'), dependsOn: ['web'] }]));
  const run = f.review.runs.get(f.project.id);
  await waitFor(() => f.commands.active(f.project.id));
  const stopped = await f.review.stop(f.project.id, run.id);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.steps[1].session, null); assert.equal(f.commands.active(f.project.id), false);
});

test('readiness timeouts clean up owned processes and keep failures inspectable', async t => {
  const f = fixture(t), port = await freePort();
  launch(f, f.plan([{ ...f.task('web'), command: `${quote(process.execPath)} -e "setInterval(()=>{},1000)"`, kind: 'service', timeoutMs: 1000, ready: { port } }]));
  await f.review.runs.get(f.project.id).done;
  assert.match(f.review.state(f.project.id).run.error, /did not become ready/);
  assert.equal(f.commands.active(f.project.id), false);
});

test('editing a map during startup halts the old launch before subsequent dispatch', async t => {
  const f = fixture(t), raw = f.plan([{ ...f.task(), command: `${quote(process.execPath)} -e "setTimeout(()=>{},1000)"` }, { ...f.task('after'), dependsOn: ['setup'] }]);
  launch(f, raw); await waitFor(() => f.commands.active(f.project.id));
  raw.profiles[0].name = 'Changed profile'; f.write(raw);
  await f.review.runs.get(f.project.id).done;
  const run = f.review.state(f.project.id).run; assert.equal(run.status, 'failed'); assert.match(run.error, /changed during startup/);
  assert.equal(run.steps[1].session, null); assert.equal(f.commands.active(f.project.id), false);
});

test('review HTTP routes bind the current map revision and serve the Flow assets', async t => {
  const f = fixture(t), saved = f.write(f.plan([f.task()]));
  const app = createRelayServer({ dataRoot: f.registry.dataRoot, lock: false });
  t.after(() => app.close()); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`, url = `${origin}/api/commands/review?projectId=${f.project.id}`;
  assert.equal((await (await fetch(url)).json()).plan.revision, saved.revision);
  for (const asset of ['/project-review.js', '/project-review.css']) assert.equal((await fetch(origin + asset)).status, 200);
  const post = (action, input) => fetch(`${origin}/api/commands/review/${action}?projectId=${f.project.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Relay': '1', Origin: origin }, body: JSON.stringify(input) });
  assert.equal((await post('start', { revision: 'stale', profileId: 'dev' })).status, 409);
  const started = await post('start', { revision: saved.revision, profileId: 'dev' }); assert.equal(started.status, 202);
  assert.equal((await post('stop', { runId: (await started.json()).id })).status, 200);
});

test('prepared review plans extract json across markdown fences, conversational text, and trailing commas', () => {
  const valid = { version: 1, profiles: [{ id: 'dev', name: 'Dev', services: [] }] };
  assert.deepEqual(parsePreparedReviewPlan(JSON.stringify(valid)), valid);
  assert.deepEqual(parsePreparedReviewPlan('```json\n' + JSON.stringify(valid) + '\n```'), valid);
  assert.deepEqual(parsePreparedReviewPlan('The launch map has been prepared:\n\n```json\n' + JSON.stringify(valid, null, 2) + '\n```\nLet me know if you need anything else.'), valid);
  assert.deepEqual(parsePreparedReviewPlan('The launch map for this project:\n' + JSON.stringify(valid) + '\nEnjoy!'), valid);
  assert.deepEqual(parsePreparedReviewPlan('```json\n{"version":1,"profiles":[{"id":"dev","name":"Dev","services":[],},],}\n```'), valid);
  assert.throws(() => parsePreparedReviewPlan('The launch map cannot be created because MongoDB is missing.'), /did not return a valid launch map JSON: "The launch map cannot be created/);
  assert.throws(() => parsePreparedReviewPlan(''), /empty response/);
});

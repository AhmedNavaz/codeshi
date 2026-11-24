import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareContext, emptyContext } from '../src/context.mjs';
import { definitionsIn, RetrievalIndex } from '../src/retrieval-index.mjs';
import { fileNameWords } from '../src/request-words.mjs';
import { privatePath } from '../src/task-context.mjs';

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
function repository(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-index-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'app');
  for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); fs.writeFileSync(path.join(folder, file), content); }
  git(folder, 'init', '-q'); git(folder, 'add', '.'); git(folder, 'commit', '-qm', 'start');
  return { root, folder: { id: 'app', name: 'app', path: folder }, data: path.join(root, 'data', 'retrieval') };
}
const FILES = {
  'src/routing.js': '// Ratings.\nconst tiers = {};\nexport function rateModel(id) {\n  return tiers[id];\n}\nexport class Router {\n  pick(task) {\n    return task;\n  }\n}\n',
  'test/routing.test.js': "import { rateModel } from '../src/routing.js';\nfunction rateModel() {}\n",
  'README.md': 'Call rateModel to rate a model. SECRET-BODY-TEXT\n',
  'src/github-signin.mjs': 'export const CLIENT_ID = "x";\n',
  'test/github-signin.test.mjs': '// tests\n',
  'src/github-repos.mjs': '// repos\n',
  'docs/provider-accounts.md': '# Accounts\n',
  '.env': 'TOKEN=1\n',
  '.gitignore': 'build/\n',
  'build/out.js': 'export function rateModel() {}\n',
};

test('definitions are found by their shape, and keywords are not names', () => {
  assert.deepEqual(definitionsIn(FILES['src/routing.js']), [['tiers', 2], ['rateModel', 3], ['Router', 6], ['pick', 7]]);
  assert.deepEqual(definitionsIn('  if (ready) {\n  for (const x of y) {\n'), []);
  assert.deepEqual(definitionsIn('def load(path):\nclass Store:\nfunc (s *S) Save() {}\npub fn parse() {}\n').map(([name]) => name), ['load', 'Store', 'Save', 'parse']);
});

test('the index lists a folder without its text, finds files and definitions, and leaves private and ignored files out', t => {
  const { folder, data } = repository(t, FILES);
  const view = new RetrievalIndex(data, { privatePath }).for(folder);
  const saved = fs.readdirSync(data).map(name => fs.readFileSync(path.join(data, name), 'utf8')).join('');
  assert.equal(saved.includes('SECRET-BODY-TEXT'), false, 'No file text is saved.');
  assert.equal(saved.includes('TOKEN'), false);
  assert.equal(view.paths.includes('.env'), false, 'A private file is not indexed.');
  assert.equal(view.paths.includes('build/out.js'), false, 'An ignored file is not indexed.');
  assert.deepEqual(view.named('routing.js'), ['src/routing.js']);
  assert.deepEqual(view.named('signin.mjs'), [], 'Only a whole file name or the end of a path counts.');
  assert.deepEqual(view.defined('rateModel').map(item => item.path), ['src/routing.js', 'test/routing.test.js'], 'The code comes before a test.');
  assert.deepEqual(view.matching(fileNameWords('Quick check before I test Sign in with GitHub')).map(item => item.path), ['src/github-signin.mjs', 'test/github-signin.test.mjs']);
  assert.deepEqual(view.matching(fileNameWords('my proposal for several accounts per provider')).map(item => item.path), ['docs/provider-accounts.md']);
  assert.deepEqual(view.matching(fileNameWords('Tidy the README')), []);
});

test('the index follows edits, new and deleted files, and reads only what changed', t => {
  const { folder, data } = repository(t, FILES);
  new RetrievalIndex(data, { privatePath }).for(folder);
  fs.writeFileSync(path.join(folder.path, 'src/routing.js'), '\n\n\n\nexport function rateModel(id) { return id; }\n');
  fs.rmSync(path.join(folder.path, 'src/github-repos.mjs'));
  fs.writeFileSync(path.join(folder.path, 'src/fresh.mjs'), 'export function newHelper() {}\n');
  const view = new RetrievalIndex(data, { privatePath }).for(folder);
  assert.deepEqual(view.defined('rateModel')[0], { path: 'src/routing.js', line: 5 });
  assert.equal(view.paths.includes('src/github-repos.mjs'), false);
  assert.deepEqual(view.defined('newHelper'), [{ path: 'src/fresh.mjs', line: 1 }], 'An untracked file is indexed too.');
  assert.equal(new RetrievalIndex(path.join(data, 'other')).for({ id: 'x', path: path.dirname(folder.path) }), null, 'A folder that is not a Git working tree has no index.');
});

const conversation = () => ({ id: 'c', provider: 'claude', mode: 'edit', context: emptyContext(), sessions: {}, runs: [], lastRun: null, messages: [] });
const brief = (folder, text, retrieval) => JSON.parse((p => p.prompt.slice(p.prompt.indexOf('\n') + 1))(prepareContext(conversation(), text, { workspace: folder.path, workspaceFolders: [folder], fresh: true, provider: 'claude', policy: 'task', readAttachment: () => ({ text: '' }), retrieval }))).brief;

test('a fresh brief points at a definition, a file named by its name and files named like the request', t => {
  const { folder, data } = repository(t, FILES);
  const retrieval = new RetrievalIndex(data, { privatePath });
  const files = brief(folder, 'Why does `rateModel` return undefined? Also check routing.js and the Sign in with GitHub code.', retrieval).relevantFiles;
  const definition = files.find(file => file.reason === 'defines rateModel');
  assert.equal(definition.path, 'src/routing.js', 'The excerpt is where it is defined, not the README that mentions it first.');
  assert.match(definition.excerpt, /export function rateModel/);
  assert.ok(files.some(file => file.path === 'src/github-signin.mjs' && file.reason === 'name matches github, signin'));
  // Without the index the same request finds the first mention, as before.
  const before = brief(folder, 'Why does `rateModel` return undefined?', null).relevantFiles;
  assert.equal(before[0].reason, 'mentions rateModel');
  assert.equal(before.some(file => file.reason.startsWith('name matches')), false);
});

test('a definition that moved without the index noticing is not sent from the old line, and is found again next time', t => {
  const { folder, data } = repository(t, FILES);
  const retrieval = new RetrievalIndex(data, { privatePath });
  retrieval.for(folder);
  // Same size and change time, so the saved stamp still matches: only the line check can tell.
  const file = path.join(folder.path, 'src/routing.js'), { mtimeMs } = fs.statSync(file), text = fs.readFileSync(file, 'utf8');
  const moved = text.replace('// Ratings.\nconst tiers = {};\n', 'const tiers = {};\n// Ratings.\n').replace('export function rateModel(id) {\n  return tiers[id];\n}', 'const unused = 1;\nexport function rateModel(id) { return tiers[id]; }').padEnd(text.length, ' ');
  fs.writeFileSync(file, moved.slice(0, text.length)); fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  assert.equal(Math.trunc(fs.statSync(file).mtimeMs), Math.trunc(mtimeMs), 'The stamp is unchanged.');
  const fresh = new RetrievalIndex(data, { privatePath });
  const firstFiles = brief(folder, 'Why does `rateModel` return undefined?', fresh).relevantFiles;
  const first = firstFiles.find(item => /rateModel/.test(item.reason));
  assert.notEqual(first?.reason, 'defines rateModel', 'A stale line is not sent as the definition.');
  const again = brief(folder, 'Why does `rateModel` return undefined?', fresh).relevantFiles.find(item => item.reason === 'defines rateModel');
  assert.equal(again.path, 'src/routing.js');
  assert.match(again.excerpt, /export function rateModel/);
});

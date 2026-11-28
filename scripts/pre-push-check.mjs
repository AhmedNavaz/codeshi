#!/usr/bin/env node
// Pre-push and release checks (`npm run check:push`, `npm run check:release`, and `.githooks/pre-push`), plus a one-step
// hook installer (`npm run hooks:install`). Catches syntax errors, failing tests on changed code, missing changelog
// entries, and broken desktop smoke tests locally in seconds before Git pushes or tags a release.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandEnvironment, gitExecutable } from '../src/resolve-binary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO_SHA = /^0+$/;
const CODE_DIRS = ['src', 'public', 'desktop', 'sharing', 'scripts', 'remote', 'evals', 'test'];
const FULL_SUITE_FILES = new Set(['package-lock.json', 'test/isolate.mjs', 'test/platform.mjs', 'test/mock-cli.mjs']);

// The variables `git rev-parse --local-env-vars` lists, which tie a command to one repository.
const REPOSITORY_GIT_ENV = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR'];
export function withoutRepositoryGitEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !REPOSITORY_GIT_ENV.includes(name) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)));
}

const normalize = file => file.replace(/\\/g, '/').replace(/^\.\//, '');

function git(root, args) {
  const result = spawnSync(gitExecutable(), ['--no-pager', '--literal-pathspecs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  });
  return { status: result.status ?? 1, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

export function listTestFiles(root = ROOT) {
  const read = dir => {
    const folder = path.join(root, dir);
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(name => name.endsWith('.test.mjs')).map(name => `${dir}/${name}`);
  };
  return [...read('test'), ...read('sharing/test')].sort();
}

// Builds a reverse-import map across repository modules so changing a helper or route finds the test files that import it.
export function reverseDependencies(root = ROOT) {
  const revDeps = new Map();
  const add = (from, to) => {
    const source = normalize(path.relative(root, path.resolve(root, from)));
    const target = normalize(path.relative(root, path.resolve(root, to)));
    if (!revDeps.has(target)) revDeps.set(target, new Set());
    revDeps.get(target).add(source);
  };
  const scan = file => {
    const full = path.resolve(root, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
    const text = fs.readFileSync(full, 'utf8'), dir = path.dirname(full);
    for (const match of text.matchAll(/(?:from\s+|import\s*\(?\s*|new\s+URL\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      add(full, path.resolve(dir, match[1]));
    }
  };
  for (const dir of CODE_DIRS) {
    const folder = path.join(root, dir);
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name)) scan(path.join(folder, entry.name));
    }
  }
  for (const file of listTestFiles(root)) scan(path.join(root, file));
  return revDeps;
}

// Chooses the focused test files that cover a list of changed paths, and whether the desktop smoke test is needed.
export function selectChecks(changedFiles, { root = ROOT, release = false } = {}) {
  const allTests = listTestFiles(root), testSet = new Set(allTests);
  const revDeps = reverseDependencies(root);
  const normalized = [...new Set(changedFiles.map(normalize).filter(Boolean))];
  const tests = new Set();
  let smoke = release;

  const testsFor = file => {
    if (testSet.has(file)) return [file];
    const base = path.basename(file).replace(/\.(?:mjs|js|cjs)$/, '');
    const dir = path.posix.dirname(file);
    if (dir === 'public') {
      if (file.endsWith('.css') && !['public/editor-theme.css', 'public/phone.css'].includes(file)) return [];
      const direct = [...(revDeps.get(file) || [])].filter(candidate => testSet.has(candidate));
      return direct.length ? direct : (testSet.has('test/frontend.test.mjs') ? ['test/frontend.test.mjs'] : []);
    }
    const byName = [
      `test/${base}.test.mjs`,
      `test/${dir}-${base}.test.mjs`,
      `test/${base.replace(/-routes$/, '')}.test.mjs`,
    ].filter(candidate => testSet.has(candidate));
    if (byName.length) return byName;
    if (dir === 'sharing' || file.startsWith('sharing/')) {
      return ['sharing/test/service.test.mjs', 'sharing/test/deploy.test.mjs'].filter(candidate => testSet.has(candidate));
    }
    const direct = [...(revDeps.get(file) || [])].filter(candidate => testSet.has(candidate));
    if (direct.length) return direct;
    const hop2 = new Set();
    for (const dep of revDeps.get(file) || []) {
      const depBase = path.basename(dep).replace(/\.(?:mjs|js|cjs)$/, '');
      if (testSet.has(`test/${depBase}.test.mjs`)) hop2.add(`test/${depBase}.test.mjs`);
      else for (const dep2 of revDeps.get(dep) || []) if (testSet.has(dep2)) hop2.add(dep2);
    }
    return [...hop2];
  };

  for (const file of normalized) {
    if (FULL_SUITE_FILES.has(file)) {
      return { tests: allTests, syntax: normalized.filter(item => /\.(?:mjs|js|cjs)$/.test(item) && fs.existsSync(path.join(root, item))), smoke: true };
    }
    if (file.startsWith('desktop/')) smoke = true;
    if (file === 'CHANGELOG.md' || file === 'package.json') {
      if (testSet.has('test/updates.test.mjs')) tests.add('test/updates.test.mjs');
    }
    if (file === 'install.sh' || file === 'install.ps1') {
      if (testSet.has('test/desktop.test.mjs')) tests.add('test/desktop.test.mjs');
    }
    if (file === '.github/workflows/release.yml') {
      if (testSet.has('sharing/test/deploy.test.mjs')) tests.add('sharing/test/deploy.test.mjs');
    }
    for (const matched of testsFor(file)) tests.add(matched);
  }
  if (release && testSet.has('test/updates.test.mjs')) tests.add('test/updates.test.mjs');
  if (release && testSet.has('test/desktop.test.mjs')) tests.add('test/desktop.test.mjs');
  if (release && testSet.has('sharing/test/deploy.test.mjs')) tests.add('sharing/test/deploy.test.mjs');

  const syntax = normalized.filter(file => /\.(?:mjs|js|cjs)$/.test(file) && fs.existsSync(path.join(root, file)));
  return { tests: [...tests].sort(), syntax, smoke };
}

// Extracts the release notes section for a given version from CHANGELOG.md, matching `.github/workflows/release.yml`.
export function extractChangelogSection(changelogText, version) {
  const lines = String(changelogText || '').replace(/\r\n/g, '\n').split('\n');
  const collected = [];
  let found = false;
  const heading = `## [${version}]`;
  for (const line of lines) {
    if (line.startsWith(heading)) { found = true; continue; }
    if (found && /^## \[/.test(line)) break;
    if (found && !/^\[[^\]]*\]: /.test(line)) collected.push(line);
  }
  return collected.join('\n').trim();
}

// Checks that package.json, CHANGELOG.md, and any pushed v* tag agree before a release or tag push.
export function verifyReleaseMetadata({ root = ROOT, tag = null, requireClean = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json version "${version}" is not a valid semantic version.`);
  }
  if (tag) {
    const cleanTag = tag.replace(/^refs\/tags\//, '');
    if (cleanTag !== `v${version}`) {
      throw new Error(`Tag ${cleanTag} does not match package.json version v${version}.`);
    }
  }
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const notes = extractChangelogSection(changelog, version);
  if (!notes) {
    throw new Error(`CHANGELOG.md has no release notes under ## [${version}]. Add the section before releasing.`);
  }
  if (requireClean) {
    const status = git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
    if (status.status !== 0) throw new Error('Could not inspect Git working tree status.');
    if (status.stdout) {
      throw new Error(`Working tree has uncommitted tracked changes:\n${status.stdout}`);
    }
  }
  return { version, notes };
}

// Parses Git's pre-push stdin lines (`<local ref> <local sha> <remote ref> <remote sha>`) into changed files and tags.
export function parsePrePushInput(stdinText, { root = ROOT } = {}) {
  const lines = String(stdinText || '').split('\n').map(line => line.trim()).filter(Boolean);
  const changed = new Set(), tags = [];
  for (const line of lines) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localRef || !localSha || ZERO_SHA.test(localSha)) continue; // Deleting a remote ref needs no local test run.
    if (localRef.startsWith('refs/tags/v') || remoteRef?.startsWith('refs/tags/v')) {
      tags.push((remoteRef?.startsWith('refs/tags/v') ? remoteRef : localRef).replace(/^refs\/tags\//, ''));
    }
    const base = remoteSha && !ZERO_SHA.test(remoteSha)
      ? remoteSha
      : git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).stdout;
    const range = base ? [`${base}..${localSha}`] : [localSha];
    const diff = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', ...range]);
    if (diff.status === 0 && diff.stdout) {
      for (const file of diff.stdout.split('\n').filter(Boolean)) changed.add(file);
    }
  }
  return { changedFiles: [...changed].sort(), tags };
}

export function changedFilesSinceOrigin({ root = ROOT, includeUntracked = true } = {}) {
  const changed = new Set();
  const base = git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).stdout || 'HEAD~1';
  const committed = git(root, ['diff', '--name-only', `${base}...HEAD`]);
  if (committed.status === 0 && committed.stdout) {
    for (const file of committed.stdout.split('\n').filter(Boolean)) changed.add(file);
  }
  const working = git(root, ['status', '--porcelain=v1', '-z', `--untracked-files=${includeUntracked ? 'normal' : 'no'}`]);
  if (working.status === 0 && working.stdout) {
    const entries = working.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2), file = entry.slice(3);
      if (code !== '??' || CODE_DIRS.some(dir => file.startsWith(`${dir}/`))) changed.add(file);
      if (/[RC]/.test(code)) i++;
    }
  }
  return [...changed].sort();
}

export function installHooks({ root = ROOT } = {}) {
  const hookFile = path.join(root, '.githooks', 'pre-push');
  if (!fs.existsSync(hookFile)) throw new Error(`Missing hook file: ${hookFile}`);
  try { fs.chmodSync(hookFile, 0o755); } catch { /* Windows ignores POSIX mode bits. */ }
  const configured = git(root, ['config', 'core.hooksPath', '.githooks']);
  if (configured.status !== 0) throw new Error(`Could not set core.hooksPath: ${configured.stderr || configured.stdout}`);
  return { hooksPath: '.githooks', hookFile };
}

export function runChecks({
  root = ROOT,
  changedFiles = [],
  tags = [],
  release = false,
  requireClean = false,
  execImpl = execFileSync,
  log = message => console.log(message),
} = {}) {
  // Git gives the hook this repository's GIT_DIR (an absolute path in a linked worktree) and similar settings. The checks
  // below run tests and the app, which make throwaway repositories of their own, so they mustn't inherit them.
  const env = commandEnvironment(withoutRepositoryGitEnv(process.env));
  if (release || tags.length > 0) {
    for (const tag of (tags.length ? tags : [null])) {
      const { version } = verifyReleaseMetadata({ root, tag, requireClean });
      log(`Verified release metadata for v${version}${tag ? ` (${tag})` : ''}.`);
    }
  }

  const plan = selectChecks(changedFiles, { root, release: release || tags.length > 0 });
  for (const file of plan.syntax) {
    execImpl(process.execPath, ['--check', path.join(root, file)], { cwd: root, env, stdio: 'inherit' });
  }
  if (plan.syntax.length) log(`Syntax checked (${plan.syntax.length} file${plan.syntax.length === 1 ? '' : 's'}).`);

  if (plan.tests.length) {
    log(`Running ${plan.tests.length} affected test file${plan.tests.length === 1 ? '' : 's'}…`);
    execImpl(process.execPath, ['--import', './test/isolate.mjs', '--test', ...plan.tests], { cwd: root, env, stdio: 'inherit' });
  } else {
    log('No test files affected by these changes.');
  }

  if (plan.smoke) {
    log('Running desktop smoke test…');
    execImpl(process.execPath, ['desktop/launch.mjs', '--smoke-test'], { cwd: root, env, stdio: 'inherit' });
  }
  return plan;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--install-hooks')) {
    const { hooksPath } = installHooks();
    console.log(`Configured Git hooks path: ${hooksPath}`);
    return;
  }
  if (process.env.CODESHI_SKIP_PREPUSH === '1') {
    console.log('Skipping pre-push checks (CODESHI_SKIP_PREPUSH=1).');
    return;
  }
  const release = argv.includes('--release');
  const fromHook = argv.includes('--pre-push');
  let changedFiles = [], tags = [];
  if (fromHook && !process.stdin.isTTY) {
    const stdinText = fs.readFileSync(0, 'utf8');
    const parsed = parsePrePushInput(stdinText);
    changedFiles = parsed.changedFiles;
    tags = parsed.tags;
    if (!changedFiles.length && !tags.length && stdinText.trim()) return;
  }
  if (!changedFiles.length) changedFiles = changedFilesSinceOrigin({ includeUntracked: !fromHook });
  runChecks({ changedFiles, tags, release, requireClean: release });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

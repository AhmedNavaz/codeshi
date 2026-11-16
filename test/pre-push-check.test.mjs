import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  extractChangelogSection,
  installHooks,
  parsePrePushInput,
  runChecks,
  selectChecks,
  verifyReleaseMetadata,
} from '../scripts/pre-push-check.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';

function git(cwd, ...args) {
  const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('selectChecks maps changed source, frontend, desktop and workflow files to their focused tests and smoke check', () => {
  const backend = selectChecks(['src/activity.mjs']);
  assert.deepEqual(backend.tests, ['test/activity.test.mjs']);
  assert.deepEqual(backend.syntax, ['src/activity.mjs']);
  assert.equal(backend.smoke, false);

  const frontend = selectChecks(['public/updater.js', 'public/board.css']);
  assert.deepEqual(frontend.tests, ['test/frontend.test.mjs']);
  assert.deepEqual(frontend.syntax, ['public/updater.js']);
  assert.equal(frontend.smoke, false);

  const desktop = selectChecks(['desktop/updater.mjs', 'CHANGELOG.md']);
  assert.deepEqual(desktop.tests, ['test/updater.test.mjs', 'test/updates.test.mjs']);
  assert.equal(desktop.smoke, true);

  const docsOnly = selectChecks(['README.md', 'ROADMAP.md']);
  assert.deepEqual(docsOnly.tests, []);
  assert.equal(docsOnly.smoke, false);

  const full = selectChecks(['test/isolate.mjs']);
  assert(full.tests.length > 50, 'Changing shared test isolation runs the full suite.');
  assert.equal(full.smoke, true);
});

test('verifyReleaseMetadata checks package.json version, tag match, CHANGELOG section and working tree cleanliness', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-prepush-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'codeshi', version: '0.60.0' }));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [0.60.0] - 2026-11-16\n\n### Added\n- Fast pre-push checks.\n\n[0.60.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.60.0\n');

  const verified = verifyReleaseMetadata({ root, tag: 'refs/tags/v0.60.0' });
  assert.equal(verified.version, '0.60.0');
  assert.match(verified.notes, /Fast pre-push checks/);
  assert.equal(extractChangelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), '0.60.0'), '### Added\n- Fast pre-push checks.');

  assert.throws(() => verifyReleaseMetadata({ root, tag: 'v0.59.0' }), /does not match package\.json version v0\.60\.0/);

  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.60.0] - 2026-11-16\n\n## [0.59.0] - 2026-11-15\n- Previous.\n');
  assert.throws(() => verifyReleaseMetadata({ root }), /no release notes under ## \[0\.60\.0\]/);
});

test('parsePrePushInput reads pushed commit ranges and tags, and installHooks configures .githooks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-prepush-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Pat Example');
  git(root, 'config', 'user.email', 'pat@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'First');
  const first = git(root, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(root, 'src', 'b.mjs'), 'export const b = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Second');
  const second = git(root, 'rev-parse', 'HEAD');

  const parsed = parsePrePushInput(`refs/heads/main ${second} refs/heads/main ${first}\nrefs/tags/v0.60.0 ${second} refs/tags/v0.60.0 0000000000000000000000000000000000000000\n`, { root });
  assert.deepEqual(parsed.changedFiles, ['src/b.mjs']);
  assert.deepEqual(parsed.tags, ['v0.60.0']);

  const deleted = parsePrePushInput(`(delete) 0000000000000000000000000000000000000000 refs/heads/old ${first}\n`, { root });
  assert.deepEqual(deleted, { changedFiles: [], tags: [] });

  installHooks({ root });
  assert.equal(git(root, 'config', '--get', 'core.hooksPath'), '.githooks');
});

test('runChecks runs syntax, selected tests and smoke test when releasing', () => {
  const calls = [], logs = [];
  runChecks({
    changedFiles: ['src/activity.mjs'],
    execImpl: (bin, args) => calls.push([path.basename(bin), ...args.map(arg => arg.startsWith('/') ? path.basename(arg) : arg)]),
    log: message => logs.push(message),
  });
  assert.deepEqual(calls, [
    [path.basename(process.execPath), '--check', 'activity.mjs'],
    [path.basename(process.execPath), '--import', './test/isolate.mjs', '--test', 'test/activity.test.mjs'],
  ]);
});

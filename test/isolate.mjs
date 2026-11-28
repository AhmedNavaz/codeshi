// Loaded by `npm test`. The running app and every copy of it coordinate through one folder in the temporary directory, so
// tests using it would wait for a Codeshi you have open, or for another test run, and could make that app wait too. Each
// test run keeps to its own folder instead. The test files run as child processes, and inherit it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.AI_RELAY_MUTATIONS_DIR) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-test-mutations-'));
  process.env.AI_RELAY_MUTATIONS_DIR = folder;
  process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));
}

// Git sets these for a hook, such as the pre-push check, and in a linked worktree GIT_DIR is an absolute path. Inherited,
// they would point every test's own throwaway repository at this one, so its fixtures would rewrite this repository's
// config, branches and HEAD. The list is `git rev-parse --local-env-vars`.
for (const name of ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR']) delete process.env[name];
for (const name of Object.keys(process.env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];

// A routed Send considers every agent it can find, so a test could otherwise reach the ones installed on this machine and
// spend real allowance on them. A test that needs an agent names its own stand-in, which takes precedence over these.
for (const provider of ['CODEX', 'CLAUDE', 'GEMINI']) process.env[`AI_RELAY_${provider}_BIN`] ||= path.join(os.tmpdir(), `codeshi-test-no-${provider.toLowerCase()}`);

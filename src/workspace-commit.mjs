import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitExecutable } from './resolve-binary.mjs';

// Staging and committing from the Git panel (#6). The panel's reads turn off hooks, fsmonitor and filter programs, since
// looking should never run code. A commit is a deliberate action, so these use the person's own Git setup instead, as a
// commit from their terminal would: their identity and signing, filters such as Git LFS, and the project's commit hooks.
// A hook that stops the commit is reported with its output, and committing without hooks is a separate, explicit choice.
// Throughline never pushes.
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
const MESSAGE_LIMIT = 20000, OUTPUT_LIMIT = 6000;
// Details reach the panel with the message: why a commit stopped, and a hook's output.
const fail = (message, status = 400, details = null) => { throw Object.assign(new Error(message), { status, ...details ? { details } : {} }); };

function git(cwd, args, { timeout = 30000 } = {}) {
  return new Promise(resolve => execFile(gitExecutable(), ['--no-pager', '--literal-pathspecs', ...args], {
    cwd, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    // Nothing waits for a terminal: no credential prompt, pager or editor.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true' },
  }, (error, stdout, stderr) => resolve({ status: error ? (Number.isInteger(error.code) ? error.code : -1) : 0, timedOut: Boolean(error?.killed), stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

// The repository root and this folder's place in it. Commands run from the root with root-relative paths, the form
// `git status --porcelain` reports, and changes are limited to the folder.
async function locate(folder) {
  const top = await git(folder.path, ['rev-parse', '--show-toplevel']);
  if (top.status) fail('No Git repository in this folder.', 404);
  const prefix = (await git(folder.path, ['rev-parse', '--show-prefix'])).stdout.trim();
  return { root: top.stdout.trim(), prefix, scope: prefix || '.' };
}

async function changes(root, scope) {
  const result = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', scope]);
  if (result.status) fail('Could not read the working changes.', 500);
  const entries = result.stdout.split('\0'), found = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]; if (entry.length < 4) continue;
    const code = entry.slice(0, 2), file = entry.slice(3), originalPath = /[RC]/.test(code) ? entries[++index] : undefined;
    found.push({ path: file, code, ...(originalPath ? { originalPath } : {}) });
  }
  return found;
}

// Only files Git currently reports as changed in this folder can be staged or unstaged; a rename takes both its paths.
async function targets(root, scope, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some(item => typeof item !== 'string' || !item || item.includes('\0'))) fail('Choose the changed files.');
  const current = await changes(root, scope), chosen = new Set();
  for (const item of paths) {
    const entry = current.find(change => change.path === item || change.originalPath === item);
    if (!entry) fail(`${item} has no current changes. Refresh Git activity.`, 409);
    chosen.add(entry.path); if (entry.originalPath) chosen.add(entry.originalPath);
  }
  return [...chosen];
}

const busy = new Set();
async function exclusive(folder, work) {
  const place = await locate(folder);
  if (busy.has(place.root)) fail('Another Git action is still running in this repository.', 409);
  busy.add(place.root);
  try { return await work(place); } finally { busy.delete(place.root); }
}

export function stageChanges(folder, { paths, all = false } = {}) {
  return exclusive(folder, async ({ root, scope }) => {
    const result = await git(root, ['add', '-A', '--', ...all ? [scope] : await targets(root, scope, paths)]);
    if (result.status) fail(`Git could not stage the changes: ${firstLines(result.stderr)}`, 409);
    return { staged: true };
  });
}

export function unstageChanges(folder, { paths, all = false } = {}) {
  return exclusive(folder, async ({ root, scope }) => {
    const chosen = all ? [scope] : await targets(root, scope, paths);
    // Before the first commit there is nothing to restore from, so the files leave the index instead.
    const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const result = await git(root, head.status ? ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...chosen] : ['restore', '--staged', '--', ...chosen]);
    if (result.status) fail(`Git could not unstage the changes: ${firstLines(result.stderr)}`, 409);
    return { unstaged: true };
  });
}

// The person's own name and email, which a commit from Throughline uses.
export async function committer(folder) {
  const [name, email] = await Promise.all(['user.name', 'user.email'].map(key => git(folder.path, ['config', '--get', key], { timeout: 5000 })));
  return { name: name.status ? null : name.stdout.trim() || null, email: email.status ? null : email.stdout.trim() || null };
}

function firstLines(text) { return String(text).trim().split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 400) || 'unknown error.'; }

async function hooksInstalled(root) {
  const where = (await git(root, ['rev-parse', '--git-path', 'hooks'])).stdout.trim();
  const directory = path.resolve(root, where || '.git/hooks');
  return HOOKS.some(name => { try { fs.accessSync(path.join(directory, name), fs.constants.X_OK); return true; } catch { return false; } });
}

// Commits exactly what the panel showed as staged. If anything staged differs from that list, including files staged
// outside this folder, nothing is committed and the panel shows the current state instead.
export function commitChanges(folder, { message, expected, skipHooks = false } = {}) {
  return exclusive(folder, async ({ root, prefix }) => {
    const text = String(message ?? '').trim();
    if (!text) fail('Write a commit message.');
    if (text.length > MESSAGE_LIMIT) fail('The commit message is too long.');
    if (!Array.isArray(expected) || expected.some(item => typeof item !== 'string')) fail('Show the staged changes before committing.');
    const listed = await git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z']);
    if (listed.status) fail('Could not read the staged changes.', 500);
    const staged = listed.stdout.split('\0').filter(Boolean);
    if (!staged.length) fail('Stage the changes to commit first.', 409);
    const outside = staged.filter(file => prefix && !file.startsWith(prefix));
    if (outside.length) fail(`Files outside this folder are staged too: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ` and ${outside.length - 3} more` : ''}. Unstage them, or commit from the folder that holds them.`, 409, { code: 'outside' });
    const shown = new Set(expected);
    if (staged.length !== shown.size || staged.some(file => !shown.has(file))) fail('The staged changes changed since you looked. Review them and commit again.', 409, { code: 'changed' });
    const result = await git(root, ['commit', '--quiet', ...skipHooks ? ['--no-verify'] : [], '-m', text], { timeout: 5 * 60 * 1000 });
    if (result.status) {
      const output = `${result.stdout}\n${result.stderr}`.trim().slice(-OUTPUT_LIMIT);
      if (result.timedOut) fail('The commit took more than five minutes, so it was stopped. A commit hook may be waiting for input.', 409, { output, hooks: !skipHooks && await hooksInstalled(root) });
      if (/Author identity unknown|unable to auto-detect email|empty ident name|no (?:email|name) was given/i.test(output)) fail('Git doesn’t know who you are yet. Set your name and email, then commit again: git config --global user.name "Your Name" and git config --global user.email you@example.com', 409, { code: 'identity' });
      if (!skipHooks && await hooksInstalled(root)) fail('A commit hook stopped the commit. Its output is below.', 409, { code: 'hook', hooks: true, output });
      fail(`Git could not commit: ${firstLines(result.stderr || result.stdout)}`, 409, { output });
    }
    const head = await git(root, ['log', '-1', '--format=%H%x1f%h%x1f%s']);
    const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const [hash, shortHash, subject] = head.stdout.trim().split('\x1f');
    return { commit: { hash, shortHash, subject, branch: branch.status ? null : branch.stdout.trim(), files: staged.length, hooks: !skipHooks } };
  });
}

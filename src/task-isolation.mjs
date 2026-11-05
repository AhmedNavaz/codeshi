import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitExecutable } from './resolve-binary.mjs';

// How a task can run beside other work (#88), and how its changes come back. Folder labels prove nothing: two folders can be
// one repository, one can sit inside another, and a link can name either. So everything here goes by the path on disk and
// by Git's own common directory. Ownership is coordination, not a sandbox: a worktree keeps honest work apart, and the
// agent's own restrictions are what limit it.
const PREFIX = ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'];
const MAX_OUTPUT = 256 * 1024 * 1024, DIFF_LIMIT = 64 * 1024, CHECK_LIMIT_MS = 10 * 60 * 1000, OUTPUT_TAIL = 4000;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const sha = value => createHash('sha256').update(value).digest('hex');

export function git(cwd, args, { encoding = 'utf8', timeout = 30000 } = {}) {
  return spawnSync(gitExecutable(), [...PREFIX, ...args], { cwd, encoding, timeout, maxBuffer: MAX_OUTPUT, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}
function must(cwd, args, options) {
  const result = git(cwd, args, options);
  if (result.error || result.status !== 0) throw fail(`Git could not ${args.find(arg => !arg.startsWith('-') && !arg.includes('=')) || 'continue'}: ${String(result.stderr || result.error?.message || '').trim().slice(0, 400)}`, 500);
  return result.stdout;
}
// Git refuses for a moment while another process holds a lock, such as an agent's own Git command in the same repository.
function patient(cwd, args, options) {
  for (let attempt = 0; ; attempt++) {
    const result = git(cwd, args, options);
    if (!result.error && result.status === 0) return result.stdout;
    if (attempt >= 5 || !/\.lock|could not lock|unable to create .*lock/i.test(String(result.stderr))) throw fail(`Git could not ${args[0]}: ${String(result.stderr || result.error?.message || '').trim().slice(0, 400)}`, 500);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + attempt * 200);
  }
}

// What a folder really is. A repository with no commit has nothing to make a worktree from, which `head` says.
export function folderIdentity(folder) {
  const real = fs.realpathSync.native(folder), found = git(real, ['rev-parse', '--show-toplevel', '--git-common-dir'], { timeout: 10000 });
  if (found.error || found.status !== 0) return { real, git: false };
  const [root, common] = found.stdout.trim().split('\n');
  if (!root || !common) return { real, git: false };
  const rootReal = fs.realpathSync.native(root), commonDir = fs.realpathSync.native(path.resolve(real, common));
  const prefix = path.relative(rootReal, real).split(path.sep).join('/');
  return { real, git: true, root: rootReal, commonDir, prefix, head: git(real, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 10000 }).status === 0 };
}
export function pathsOverlap(first, second) {
  const outside = (from, to) => { const relative = path.relative(from, to); return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); };
  return !outside(first, second) || !outside(second, first);
}
// An agent that can do anything without asking, and has no sandbox of its own, could reach any folder. Codex keeps its
// sandbox with Full auto-approval, because it still asks for what the sandbox blocks.
export const unrestricted = ({ provider, mode, approvalPolicy }) => mode === 'edit' && approvalPolicy === 'auto' && provider !== 'codex';

// occupants: what is working now, each { real, commonDir, unrestricted, label }.
export function planIsolation(identity, occupants, { loose = false } = {}) {
  const sharing = occupants.find(item => pathsOverlap(item.real, identity.real) || (identity.commonDir && item.commonDir === identity.commonDir));
  const blocker = sharing || occupants.find(item => item.unrestricted) || (loose ? occupants[0] : null);
  if (!blocker) return { mode: 'direct', reason: 'Runs directly in this folder, as nothing else is using it.' };
  const why = sharing ? `${blocker.label} is using ${identity.commonDir && blocker.commonDir === identity.commonDir ? 'this repository' : 'this folder'}` : `${blocker.label} could reach this folder, as it isn't asked before acting`;
  if (identity.git && identity.head) return { mode: 'worktree', blocker: blocker.label, reason: `${why}, so this task works in its own copy from the last commit. You review its changes before they're merged.` };
  return { mode: 'wait', blocker: blocker.label, reason: `${why}, and ${identity.git ? 'a repository with no commits' : 'a folder outside Git'} can't have its own copy, so this task waits until that finishes.` };
}
// Uncommitted work isn't in a worktree, which starts from the last commit, so the person is told how much that leaves out.
export function uncommittedCount(folder) {
  const status = git(folder, ['status', '--porcelain=v1', '--untracked-files=normal', '--', '.'], { timeout: 10000 });
  return status.status === 0 ? status.stdout.split('\n').filter(Boolean).length : 0;
}

const refs = id => ({ base: `refs/codeshi/tasks/${id}/base`, result: `refs/codeshi/tasks/${id}/result` });
// A detached worktree under Codeshi's own folder, so the person's branches, index and files are untouched. Refs under a
// private name keep the commits safe from cleanup without adding to the branch list.
export function createWorktree(identity, target, id) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  patient(identity.root, ['worktree', 'add', '--detach', '--quiet', target, 'HEAD']);
  const base = must(target, ['rev-parse', 'HEAD']).trim();
  patient(identity.root, ['update-ref', refs(id).base, base]);
  const scopePath = path.join(target, identity.prefix);
  fs.mkdirSync(scopePath, { recursive: true });
  return { worktree: target, scopePath: fs.realpathSync.native(scopePath), base };
}
// Saves what the task did as a commit in its worktree. Ignored files stay out, as they would from any commit.
export function snapshotWorktree(worktree, id) {
  patient(worktree, ['add', '-A']);
  if (git(worktree, ['diff', '--cached', '--quiet']).status !== 0) patient(worktree, ['-c', 'user.name=Codeshi', '-c', 'user.email=codeshi@localhost', 'commit', '--no-verify', '--quiet', '-m', `Codeshi task ${id}`]);
  const result = must(worktree, ['rev-parse', 'HEAD']).trim();
  patient(worktree, ['update-ref', refs(id).result, result]);
  return result;
}
export function removeWorktree(root, worktree, id) {
  if (worktree && fs.existsSync(worktree)) { git(root, ['worktree', 'remove', '--force', worktree]); fs.rmSync(worktree, { recursive: true, force: true }); }
  git(root, ['worktree', 'prune']);
  for (const ref of Object.values(refs(id))) git(root, ['update-ref', '-d', ref]);
}
export function keepBranch(root, result, title, id) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task', name = `codeshi/${slug}-${id.slice(0, 6)}`;
  patient(root, ['branch', name, result]);
  return name;
}

const blob = (root, rev, file) => { const found = git(root, ['cat-file', 'blob', `${rev}:${file}`], { encoding: 'buffer' }); return found.status === 0 ? found.stdout : null; };
const modeOf = (root, rev, file) => { const line = git(root, ['ls-tree', rev, '--', file]).stdout?.split('\n')[0] || ''; return line.split(' ')[0] || null; };
const isText = buffer => !buffer.includes(0);
// Nothing is written through a link or into Git's own folder, whatever a path in the commit says.
function reachable(root, file) {
  const parts = file.split('/');
  if (!file || parts.includes('..') || parts.includes('.git') || path.isAbsolute(file)) return false;
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try { if (!fs.lstatSync(current).isDirectory()) return false; } catch (error) { if (error.code === 'ENOENT') return true; return false; }
  }
  return true;
}
function readCurrent(target) {
  try { const stat = fs.lstatSync(target); return stat.isFile() ? { content: fs.readFileSync(target) } : { unreadable: true }; }
  catch (error) { return error.code === 'ENOENT' ? { content: null } : { unreadable: true }; }
}
function mergeText(root, current, base, theirs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-merge-'));
  try {
    const names = ['current', 'base', 'theirs'].map(name => path.join(directory, name));
    fs.writeFileSync(names[0], current); fs.writeFileSync(names[1], base); fs.writeFileSync(names[2], theirs);
    const merged = git(root, ['merge-file', '-p', ...names], { encoding: 'buffer' });
    return merged.status === 0 ? merged.stdout : null;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
// What merging a task would do, file by file, against the folder as it is right now. Nothing is written here. A file changed
// only by the task is taken from it; one changed on both sides is merged if the changes don't touch, and otherwise is a
// conflict, which stops the whole merge rather than overwriting either side.
export function integrationPlan({ root, prefix = '', base, result }) {
  const named = must(root, ['diff', '--no-renames', '--no-ext-diff', '--name-status', '-z', base, result]).split('\0').filter(Boolean);
  const counts = new Map(must(root, ['diff', '--no-renames', '--no-ext-diff', '--numstat', '-z', base, result]).split('\0').filter(Boolean).map(line => { const [added, removed, ...file] = line.split('\t'); return [file.join('\t'), { added: Number(added) || 0, removed: Number(removed) || 0 }]; }));
  const files = [], writes = [];
  let total = 0;
  for (let index = 0; index < named.length; index += 2) {
    const code = named[index], file = named[index + 1], target = path.join(root, file), row = { path: file, change: code === 'A' ? 'add' : code === 'D' ? 'delete' : 'update', ...(counts.get(file) || { added: 0, removed: 0 }) };
    const conflict = reason => files.push({ ...row, status: 'conflict', reason });
    if (prefix && file !== prefix && !file.startsWith(`${prefix}/`)) { conflict(`It's outside this task's folder.`); continue; }
    const baseMode = modeOf(root, base, file), theirMode = modeOf(root, result, file);
    if (['120000', '160000'].includes(baseMode) || ['120000', '160000'].includes(theirMode)) { conflict(`Links and submodules aren't merged.`); continue; }
    if (!reachable(root, file)) { conflict(`Its path goes through a link or into Git's own folder.`); continue; }
    const current = readCurrent(target);
    if (current.unreadable) { conflict('Something other than a plain file is at this path now.'); continue; }
    const was = baseMode ? blob(root, base, file) : null, theirs = theirMode ? blob(root, result, file) : null, now = current.content;
    const same = (a, b) => a === b || (a && b && a.equals(b));
    let content, status;
    if (same(now, theirs)) status = 'same';
    else if (same(now, was)) { status = 'clean'; content = theirs; }
    else if (now && was && theirs && isText(now) && isText(was) && isText(theirs)) {
      const merged = mergeText(root, now, was, theirs);
      if (merged === null) { conflict('This file also changed here, in the same lines.'); continue; }
      status = 'merged'; content = merged;
    } else { conflict(now === null ? 'This file was deleted here after the task began.' : theirs === null ? 'The task deleted this file, and it also changed here.' : 'This file also changed here.'); continue; }
    if (status !== 'same') writes.push({ path: file, content, mode: theirMode });
    const diff = total < 512 * 1024 ? git(root, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', base, result, '--', file]).stdout || '' : '';
    total += diff.length;
    files.push({ ...row, status, ...(diff ? { diff: diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n[Shortened here. The whole change is in the task's commit.]` : diff } : {}) });
  }
  // The digest covers what would be written and what it would replace, so a change on either side means reviewing again.
  const digest = sha(JSON.stringify([result, files.map(file => [file.path, file.status]), writes.map(item => [item.path, item.content ? sha(item.content) : null, item.mode]), writes.map(item => { const now = readCurrent(path.join(root, item.path)); return now.content ? sha(now.content) : null; })]));
  return { files, writes, digest, conflicts: files.filter(file => file.status === 'conflict').length };
}
function writeFile(target, content, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.codeshi-${randomUUID()}`;
  try { fs.writeFileSync(temporary, content, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}
// Writes a plan, putting everything back as it was if any file can't be written.
export function applyPlan(root, plan) {
  const done = [];
  try {
    for (const item of plan.writes) {
      const target = path.join(root, item.path), before = readCurrent(target);
      if (before.unreadable) throw fail(`${item.path} can't be replaced.`);
      done.push({ target, before: before.content });
      if (item.content === null || item.content === undefined) fs.rmSync(target, { force: true }); else writeFile(target, item.content, item.mode);
    }
  } catch (error) {
    for (const { target, before } of done.reverse()) { try { if (before === null) fs.rmSync(target, { force: true }); else writeFile(target, before); } catch { /* The error below is what the person needs to know. */ } }
    throw error;
  }
}

// The tests against the combined result: a temporary worktree with the folder's current changes and the task's merged on
// top, so nothing real is touched and a failure can't damage either side. It borrows installed dependencies by link, since
// a fresh checkout has none. The command is the one the person marked in the Run panel, never one from an agent or a repository.
export async function checkCombined({ root, prefix = '', plan, command, directory = '', target, signal }) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  patient(root, ['worktree', 'add', '--detach', '--quiet', target, 'HEAD']);
  try {
    const status = must(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).split('\0').filter(Boolean);
    for (const entry of status) {
      const file = entry.slice(3), from = path.join(root, file), to = path.join(target, file), found = readCurrent(from);
      if (found.unreadable) continue;
      if (found.content === null) fs.rmSync(to, { force: true }); else writeFile(to, found.content);
    }
    for (const item of plan.writes) { const to = path.join(target, item.path); if (item.content === null || item.content === undefined) fs.rmSync(to, { force: true }); else writeFile(to, item.content, item.mode); }
    for (const place of new Set(['', prefix, path.posix.join(prefix, directory)])) {
      const real = path.join(root, place, 'node_modules'), copy = path.join(target, place, 'node_modules');
      if (fs.existsSync(real) && !fs.existsSync(copy)) { fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.symlinkSync(real, copy, process.platform === 'win32' ? 'junction' : 'dir'); }
    }
    const cwd = path.join(target, prefix, directory);
    if (!fs.existsSync(cwd)) return { status: 'failed', exitCode: null, output: `${path.posix.join(prefix, directory)} doesn't exist in the combined result.` };
    return await new Promise(resolve => {
      const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
      let output = '', timedOut = false, settled = false;
      const keep = chunk => { output = (output + chunk).slice(-OUTPUT_TAIL); };
      child.stdout.on('data', keep); child.stderr.on('data', keep);
      const end = () => { try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch { /* It has already gone. */ } };
      const timer = setTimeout(() => { timedOut = true; end(); }, CHECK_LIMIT_MS); timer.unref?.();
      signal?.addEventListener('abort', end, { once: true });
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', end); resolve(result); };
      child.on('error', error => finish({ status: 'failed', exitCode: null, output: error.message }));
      child.on('close', code => finish({ status: timedOut ? 'timed-out' : code === 0 ? 'passed' : 'failed', exitCode: code, output }));
    });
  } finally {
    git(root, ['worktree', 'remove', '--force', target]); fs.rmSync(target, { recursive: true, force: true }); git(root, ['worktree', 'prune']);
  }
}

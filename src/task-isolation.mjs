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

// `magic` lets a call use pathspec magic such as :(exclude); every other call takes paths literally.
export function git(cwd, args, { encoding = 'utf8', timeout = 30000, input, magic = false, env = null } = {}) {
  return spawnSync(gitExecutable(), [...(magic ? PREFIX.filter(arg => arg !== '--literal-pathspecs') : PREFIX), ...args], { cwd, encoding, timeout, input, maxBuffer: MAX_OUTPUT, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
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

// The paths a folder's Git ignores, of those given relative to it. A tracked file is never ignored, whatever its name, as
// its changes come back from a copy like any other. A copy starts without the folder's ignored files, and its own are
// left out when it's merged and deleted with it, so a Plan card that saves some (notes or screenshots under output/,
// say) works in the folder itself instead. Pathspec magic (a leading ':') would stop Git reading the rest, so it's skipped.
export function ignoredPaths(folder, paths = []) {
  const clean = [...new Set((Array.isArray(paths) ? paths : []).map(item => String(item ?? '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')).filter(item => item && item.length <= 300 && !item.startsWith(':') && !item.startsWith('~') && !path.isAbsolute(item) && !item.split('/').includes('..') && !item.includes('\0')))].slice(0, 40);
  // Without a folder Git would answer for wherever Codeshi happens to run.
  if (!clean.length || typeof folder !== 'string' || !path.isAbsolute(folder)) return [];
  const found = git(folder, ['check-ignore', '-z', '--stdin'], { input: `${clean.join('\0')}\0`, timeout: 10000, magic: true });
  // 1 is none ignored; a folder outside Git has none either.
  if (found.error || typeof found.stdout !== 'string') return [];
  const ignored = new Set(found.stdout.split('\0').filter(Boolean));
  return clean.filter(item => ignored.has(item));
}
const someOf = (list, most = 3) => list.length <= most ? list.join(', ') : `${list.slice(0, most).join(', ')} and ${list.length - most} more`;
// A card's own check can start by moving into the card's folder, as one written when cards ran in the workspace's first
// folder did (cd ../site && npm test). It runs from that folder already, and from a copy the path leads nowhere, so the
// move is dropped. A move anywhere else is left as written.
export function ownCheck(command, folder) {
  const value = String(command || '').trim(), match = /^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|<>()`$"']+))\s*&&\s*/.exec(value);
  if (!match || !folder) return value;
  try { if (fs.realpathSync.native(path.resolve(folder, match[1] ?? match[2] ?? match[3])) === fs.realpathSync.native(folder)) return value.slice(match[0].length).trim() || value; } catch { /* A folder that isn't there: the command fails as written. */ }
  return value;
}

// occupants: what is working now, each { real, commonDir, unrestricted, label }.
// keeps: the files a Plan card saves that Git ignores (ignoredPaths), which a copy would lose, so it waits for the folder.
export function planIsolation(identity, occupants, { loose = false, keeps = [] } = {}) {
  const sharing = occupants.find(item => pathsOverlap(item.real, identity.real) || (identity.commonDir && item.commonDir === identity.commonDir));
  const blocker = sharing || occupants.find(item => item.unrestricted) || (loose ? occupants[0] : null);
  if (!blocker) return { mode: 'direct', reason: 'Runs directly in this folder, as nothing else is using it.' };
  const why = sharing ? `${blocker.label} is using ${identity.commonDir && blocker.commonDir === identity.commonDir ? 'this repository' : 'this folder'}` : `${blocker.label} could reach this folder, as it isn't asked before acting`;
  if (keeps.length) return { mode: 'wait', blocker: blocker.label, keeps: true, reason: `${why}, and this card saves files Git ignores (${someOf(keeps)}), which its own copy would lose. So it waits until that finishes, then works in the folder itself.` };
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
// A fresh worktree has none of the folder's ignored files, so an agent's build or tests would fail in it. Installed
// dependencies are brought over: each ignored node_modules gets its own copy-on-write clone, which takes about a second
// and no extra disk space, so installing in the task can't touch the folder's. Where the disk can't clone (another volume,
// or a file system without it) it is linked instead, and then it is shared. Secrets are never brought over: ignored .env
// files are only listed, so the person knows the copy lacks them. Python environments stay out too, since a virtual
// environment points at its own path and a copy would still install into the original.
const DEPENDENCY = 'node_modules', MAX_DEPENDENCIES = 40, CLONE_LIMIT_MS = 2 * 60 * 1000;
const ENV_FILE = /^\.env(?:\..+)?$/;
function cloneFolder(from, to) {
  const flags = process.platform === 'darwin' ? ['-c', '-R'] : process.platform === 'linux' ? ['-R', '--reflink=always'] : null;
  if (!flags) return Promise.resolve(false);
  // A clone can't cross volumes, and macOS's cp would quietly make a full copy instead.
  try { if (fs.statSync(from).dev !== fs.statSync(path.dirname(to)).dev) return Promise.resolve(false); } catch { return Promise.resolve(false); }
  return new Promise(resolve => {
    const child = spawn('/bin/cp', [...flags, from, to], { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => child.kill('SIGKILL'), CLONE_LIMIT_MS); timer.unref?.();
    const done = ok => { clearTimeout(timer); if (!ok) fs.rmSync(to, { recursive: true, force: true }); resolve(ok); };
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}
export async function prepareWorktree(identity, target) {
  const listed = git(identity.root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], { timeout: 60000 });
  const entries = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
  const dependencies = [], missing = [];
  for (const entry of entries) {
    const clean = entry.replace(/\/$/, ''), name = path.posix.basename(clean);
    if (name === DEPENDENCY && entry.endsWith('/') && dependencies.length < MAX_DEPENDENCIES) dependencies.push(clean);
    else if (!entry.endsWith('/') && ENV_FILE.test(name) && !clean.split('/').includes(DEPENDENCY) && missing.length < 20) missing.push(clean);
  }
  const prepared = [];
  for (const place of dependencies.sort()) {
    const from = path.join(identity.root, place), to = path.join(target, place);
    // Only where the copy has the folder around it, and never over something already there.
    if (!reachable(target, place) || !fs.existsSync(path.dirname(to)) || fs.existsSync(to)) continue;
    try { if (!fs.lstatSync(from).isDirectory()) continue; } catch { continue; }
    if (await cloneFolder(from, to)) { prepared.push({ path: place, how: 'copy' }); continue; }
    try { fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir'); prepared.push({ path: place, how: 'link' }); } catch { /* The task runs without it, as before. */ }
  }
  return { dependencies: prepared, missing: missing.sort() };
}

// Saves what the task did as a commit in its worktree. Ignored files stay out, as they would from any commit, and so do
// the dependencies brought in above, which a link or a .gitignore change could otherwise let in.
// Git refuses to be told about a path it already ignores, so only the others are named.
export function snapshotWorktree(worktree, id, exclude = []) {
  // A folder is asked about as one (a trailing slash), since a pattern like `node_modules/` matches only folders, not links.
  const kind = place => { try { return fs.lstatSync(path.join(worktree, place)).isDirectory() ? `${place}/` : place; } catch { return null; } };
  const named = exclude.map(kind).filter(Boolean).filter(place => git(worktree, ['check-ignore', '-q', '--no-index', '--', place], { magic: true }).status === 1).map(place => place.replace(/\/$/, ''));
  patient(worktree, ['add', '-A', '--', '.', ...named.map(place => `:(top,literal,exclude)${place}`)], { magic: true });
  if (git(worktree, ['diff', '--cached', '--quiet']).status !== 0) patient(worktree, ['-c', 'user.name=Codeshi', '-c', 'user.email=codeshi@localhost', 'commit', '--no-verify', '--quiet', '-m', `Codeshi task ${id}`]);
  const result = must(worktree, ['rev-parse', 'HEAD']).trim();
  patient(worktree, ['update-ref', refs(id).result, result]);
  return result;
}
export function removeWorktree(root, worktree, id, dependencies = []) {
  // A linked dependency is unlinked first, so nothing that deletes the copy can reach into the folder's own.
  for (const item of dependencies) {
    const place = worktree && path.join(worktree, item.path);
    try { if (place && fs.lstatSync(place).isSymbolicLink()) fs.unlinkSync(place); } catch { /* Already gone. */ }
  }
  if (worktree && fs.existsSync(worktree)) { git(root, ['worktree', 'remove', '--force', worktree]); fs.rmSync(worktree, { recursive: true, force: true }); }
  git(root, ['worktree', 'prune']);
  for (const ref of Object.values(refs(id))) git(root, ['update-ref', '-d', ref]);
}
export function keepBranch(root, result, title, id) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task', name = `codeshi/${slug}-${id.slice(0, 6)}`;
  patient(root, ['branch', name, result]);
  return name;
}

// Git can change a file between the repository and the folder: line endings with core.autocrlf (on by default in Git for
// Windows) or an eol attribute, or a filter. So the folder's copy is compared as Git would store it, and each side is read
// both as stored and as a checkout writes it.
const entryOf = (root, rev, file) => { const [mode, , id] = (git(root, ['ls-tree', rev, '--', file]).stdout?.split('\n')[0] || '').split('\t')[0].split(' '); return { mode: mode || null, id: id || null }; };
// These never fail quietly, since a missing answer would read as an empty or deleted file.
const stored = (root, rev, file) => must(root, ['cat-file', 'blob', `${rev}:${file}`], { encoding: 'buffer' });
const checkedOut = (root, rev, file) => must(root, ['cat-file', '--filters', `${rev}:${file}`], { encoding: 'buffer' });
const storedId = (root, file, content) => must(root, ['hash-object', '--stdin', `--path=${file}`], { input: content }).trim();
const same = (a, b) => a === b || Boolean(a && b && a.equals(b));
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
// conflict, which stops the whole merge rather than overwriting either side. Each conflict has a kind, which says whether
// an agent can settle it in the task's copy (RESOLVABLE, prepareResolution).
// pending: the files an agent is resolving, which can't be merged while they still have the markers they were given.
export function integrationPlan({ root, prefix = '', base, result, pending = null }) {
  const named = must(root, ['diff', '--no-renames', '--no-ext-diff', '--name-status', '-z', base, result]).split('\0').filter(Boolean);
  const counts = new Map(must(root, ['diff', '--no-renames', '--no-ext-diff', '--numstat', '-z', base, result]).split('\0').filter(Boolean).map(line => { const [added, removed, ...file] = line.split('\t'); return [file.join('\t'), { added: Number(added) || 0, removed: Number(removed) || 0 }]; }));
  const files = [], writes = [], resolving = new Set(pending?.files || []);
  let total = 0;
  for (let index = 0; index < named.length; index += 2) {
    const code = named[index], file = named[index + 1], target = path.join(root, file), row = { path: file, change: code === 'A' ? 'add' : code === 'D' ? 'delete' : 'update', ...(counts.get(file) || { added: 0, removed: 0 }) };
    const conflict = (reason, kind) => files.push({ ...row, status: 'conflict', kind, reason });
    if (prefix && file !== prefix && !file.startsWith(`${prefix}/`)) { conflict(`It's outside this task's folder.`, 'outside'); continue; }
    const { mode: baseMode, id: baseId } = entryOf(root, base, file), { mode: theirMode, id: theirId } = entryOf(root, result, file);
    if (['120000', '160000'].includes(baseMode) || ['120000', '160000'].includes(theirMode)) { conflict(`Links and submodules aren't merged.`, 'link'); continue; }
    if (!reachable(root, file)) { conflict(`Its path goes through a link or into Git's own folder.`, 'path'); continue; }
    const current = readCurrent(target);
    if (current.unreadable) { conflict('Something other than a plain file is at this path now.', 'path'); continue; }
    if (resolving.has(file) && theirMode && markersIn(stored(root, result, file), pending.labels) > (pending.known?.[file] || 0)) { conflict('It still has conflict markers, so resolving it isn’t finished.', 'unresolved'); continue; }
    const now = current.content, nowId = now === null ? null : storedId(root, file, now), is = id => nowId === id;
    // A file keeps the form it has here: the stored bytes if that's what it holds, as when Git converts nothing, and
    // otherwise what a checkout writes, which is also what a new file gets.
    const read = how => ({ was: baseMode ? how(root, base, file) : null, theirs: theirMode ? how(root, result, file) : null });
    const forms = [read(checkedOut)], raw = read(stored);
    if (!(same(raw.was, forms[0].was) && same(raw.theirs, forms[0].theirs))) forms.push(raw);
    const texts = forms.filter(form => now && form.was && form.theirs && isText(now) && isText(form.was) && isText(form.theirs));
    let content, status;
    if (is(theirId)) status = 'same';
    else if (is(baseId)) { status = 'clean'; content = (forms.find(form => now && same(form.was, now)) || forms[0]).theirs; }
    else if (texts.length) {
      const merged = texts.reduce((done, form) => done ?? mergeText(root, now, form.was, form.theirs), null);
      if (merged === null) { conflict('This file also changed here, in the same lines.', 'lines'); continue; }
      status = 'merged'; content = merged;
    } else {
      // Where one side has no file, the others decide: text on every side that has one can still be combined.
      const textual = [now, forms[0].was, forms[0].theirs].every(item => item === null || isText(item));
      conflict(now === null ? 'This file was deleted here after the task began.' : !theirMode ? 'The task deleted this file, and it also changed here.' : !baseMode && textual ? 'This file was also added here, with other content.' : 'This file also changed here.',
        !textual ? 'binary' : now === null ? 'deleted-here' : !theirMode ? 'deleted-by-task' : !baseMode ? 'added-both' : 'binary');
      continue;
    }
    if (status !== 'same') writes.push({ path: file, content, mode: theirMode });
    const diff = total < 512 * 1024 ? git(root, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', base, result, '--', file]).stdout || '' : '';
    total += diff.length;
    files.push({ ...row, status, ...(resolving.has(file) ? { resolved: true } : {}), ...(diff ? { diff: diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n[Shortened here. The whole change is in the task's commit.]` : diff } : {}) });
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

// ---- Resolving a conflict with an agent, in the task's own copy and never the folder.
// The conflicts an agent can settle: both sides changed the same lines, or one side deleted or both added a file, with
// text on every side that has one. A file still marked from an earlier try starts again from where that one began.
export const RESOLVABLE = new Set(['lines', 'deleted-here', 'deleted-by-task', 'added-both', 'unresolved']);
// The markers' labels say whose each side is. The folder's name becomes one short line, as it goes into the file.
export function markerLabels(folder) {
  const name = String(folder || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'the folder';
  return { ours: 'this copy', base: 'when this copy was made', theirs: `${name} now` };
}
// How many of Codeshi's own marker lines a file has. Only those count, never a line of seven <s that a file holds anyway.
export function markersIn(content, labels) {
  if (!content || !labels) return 0;
  const marks = new Set([`<<<<<<< ${labels.ours}`, `||||||| ${labels.base}`, `>>>>>>> ${labels.theirs}`]);
  let count = 0;
  for (const line of content.toString('utf8').split('\n')) if (marks.has(line.endsWith('\r') ? line.slice(0, -1) : line)) count++;
  return count;
}
// The files an agent was given that still have more of those markers in the copy than they started with.
export function unfinishedFiles(worktree, resolve) {
  return (resolve?.files || []).filter(file => { const found = readCurrent(path.join(worktree, file)); return Boolean(found.content) && markersIn(found.content, resolve.labels) > (resolve.known?.[file] || 0); });
}
// Both sides of a file as Git merges them, with diff3 markers where they changed the same lines. A missing side is empty.
function mergeMarked(root, file, mine, was, theirs, labels) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-resolve-'));
  try {
    const names = ['mine', 'was', 'theirs'].map(name => path.join(directory, name)), empty = Buffer.alloc(0);
    fs.writeFileSync(names[0], mine || empty); fs.writeFileSync(names[1], was || empty); fs.writeFileSync(names[2], theirs || empty);
    const merged = git(root, ['merge-file', '-p', '--diff3', '-L', labels.ours, '-L', labels.base, '-L', labels.theirs, ...names], { encoding: 'buffer' });
    // Git answers with the number of conflicts, and with more than 127 only on an error.
    if (merged.error || merged.status === null || merged.status > 127) throw fail(`Git could not combine ${file}: ${String(merged.stderr || merged.error?.message || '').trim().slice(0, 300)}`, 500);
    return { content: merged.stdout, conflicts: merged.status };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
// A commit of parent's files with some changed: { path, content, mode } stores content as Git would for that path,
// { path, id, mode } names a file already stored, and { path, content: null } removes one. A temporary index leaves the
// repository's own index and every worktree alone.
function commitWith(root, parent, changes, message) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-index-')), env = { GIT_INDEX_FILE: path.join(directory, 'index') };
  try {
    must(root, ['read-tree', parent], { env });
    for (const change of changes) {
      if (!change.id && change.content === null) { must(root, ['update-index', '--force-remove', '--', change.path], { env }); continue; }
      const id = change.id || must(root, ['hash-object', '-w', `--path=${change.path}`, '--stdin'], { input: change.content }).trim();
      must(root, ['update-index', '--add', '--cacheinfo', `${change.mode || '100644'},${id},${change.path}`], { env });
    }
    const tree = must(root, ['write-tree'], { env }).trim();
    return must(root, ['-c', 'user.name=Codeshi', '-c', 'user.email=codeshi@localhost', 'commit-tree', tree, '-p', parent, '-m', message]).trim();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
// Brings the folder's current version of each conflicting file into the task's copy, merged with the task's own where Git
// can and marked where both changed the same lines, for an agent to settle there. Only the copy is written. The base then
// holds the folder's versions of those files, so the review afterwards shows what merging would change in the folder,
// and a later change there merges as any change does. Returns the new base and, for each file, its kind, how many
// conflicts are marked, and how many marker lines its two sides already had, which never count (markersIn).
export function prepareResolution({ root, worktree, id, base, result, plan, labels }) {
  const changes = [], files = [], writes = [];
  // Everything is worked out before anything is written, so a file that can't be combined changes nothing.
  for (const row of plan.files.filter(file => file.status === 'conflict')) {
    const file = row.path, copy = path.join(worktree, file);
    if (!RESOLVABLE.has(row.kind) || row.kind === 'unresolved') throw fail(`${file} can’t be combined: ${row.reason}`);
    if (!reachable(worktree, file)) throw fail(`${file} can’t be written in the task’s copy.`);
    const mine = readCurrent(copy), now = readCurrent(path.join(root, file));
    if (mine.unreadable || now.unreadable) throw fail(`${file} isn’t a plain file on both sides, so it can’t be combined.`);
    const before = entryOf(root, base, file), theirs = entryOf(root, result, file);
    const merged = mergeMarked(root, file, mine.content, before.mode ? checkedOut(root, base, file) : null, now.content, labels);
    writes.push({ copy, content: merged.content, mode: theirs.mode || before.mode, was: mine.content, wasMode: theirs.mode });
    changes.push(now.content === null ? { path: file, content: null } : { path: file, content: now.content, mode: before.mode || theirs.mode || '100644' });
    const known = markersIn(mine.content, labels) + markersIn(now.content, labels);
    files.push({ path: file, kind: row.kind, conflicts: merged.conflicts, ...(known ? { known } : {}) });
  }
  if (!files.length) return { base, files };
  const done = [];
  try {
    for (const item of writes) { writeFile(item.copy, item.content, item.mode); done.push(item); }
    const next = commitWith(root, base, changes, `Codeshi task ${id}: the folder's versions of the files it resolves`);
    patient(root, ['update-ref', refs(id).base, next]);
    return { base: next, files };
  } catch (error) {
    for (const item of done.reverse()) { try { if (item.was === null) fs.rmSync(item.copy, { force: true }); else writeFile(item.copy, item.was, item.wasMode); } catch { /* The error below is what the person needs to know. */ } }
    throw error;
  }
}
// Files whose resolving didn't finish go back to where it began: the task's own version in the copy, from before (the
// task's commit then), and the folder's version it was compared with, from from (the base then). Returns the new base.
export function restoreResolution({ root, worktree, id, base, before, from, files }) {
  const changes = [];
  for (const file of files) {
    if (!reachable(worktree, file)) continue;
    const mine = entryOf(root, before, file), was = entryOf(root, from, file), copy = path.join(worktree, file);
    if (mine.mode) writeFile(copy, checkedOut(root, before, file), mine.mode); else fs.rmSync(copy, { force: true });
    changes.push(was.mode ? { path: file, id: was.id, mode: was.mode } : { path: file, content: null });
  }
  if (!changes.length) return base;
  const next = commitWith(root, base, changes, `Codeshi task ${id}: back to before resolving`);
  patient(root, ['update-ref', refs(id).base, next]);
  return next;
}
// What the agent resolving the conflicts is asked, in the task's own conversation. Paths are from its own folder.
export function resolvePrompt({ folder, card = false, prefix = '', files, labels }) {
  const here = file => prefix ? path.posix.relative(prefix, file) : file, many = files.length !== 1;
  const kind = file => ({
    'deleted-here': `it was deleted in ${folder} since, so the “${labels.theirs}” side is empty`,
    'deleted-by-task': `you deleted it, and it changed in ${folder} since, so the “${labels.ours}” side is empty`,
    'added-both': `you both added it`,
  })[file.kind] || `${file.conflicts} conflict${file.conflicts === 1 ? '' : 's'}`;
  return [
    `This ${card ? 'card' : 'task'}’s changes can’t be merged into ${folder} yet: ${many ? `${files.length} files` : 'a file'} you changed also changed there since this copy was made. Codeshi brought ${folder}’s current version of ${many ? 'them' : 'it'} into this copy and merged what Git could. Where both sides changed the same lines, there are conflict markers:`,
    '',
    '```text', `<<<<<<< ${labels.ours}`, 'your version', `||||||| ${labels.base}`, 'the lines as they were', '=======', `${folder}’s version now`, `>>>>>>> ${labels.theirs}`, '```',
    '',
    ...files.map(file => `- ${here(file.path)}: ${kind(file)}`),
    '',
    'Settle every conflict here, in this copy, and remove each marker line.',
    '- Where both sides want things that fit together, keep both: two added imports, two new entries in a list, two new sections.',
    `- Where they really disagree, don't choose: two different texts for one heading, say, or two values for one setting. Leave that conflict as it is and ask me which to keep, showing both versions. Use your tool for asking questions if you have one; otherwise end your reply with a heading “Questions for you”.`,
    '- Where one side deleted the file, ask me too. To keep the deletion, delete the file rather than leaving it empty.',
    `- Change nothing else, and don't commit: Codeshi saves this copy. ${folder} itself stays as it is until I review the combined result and merge it.`,
    '',
    'When you finish, say in a line per file how you combined it.',
  ].join('\n');
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

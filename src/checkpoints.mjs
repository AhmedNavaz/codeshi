// Checkpoints (#20): each run's folders are saved before and after it, so the run's changes can be undone later,
// whichever agent made them. Snapshots live in a private Git object store per folder, inside Codeshi's data
// folder. The project's own .git, branches, index and stash are never read or written.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitExecutable } from './resolve-binary.mjs';

export const checkpointLimits = { fileBytes: 8 * 1024 * 1024, files: 60000, largeFiles: 2000, keepRuns: 100, keepRewinds: 100, beforeMs: 20000, afterMs: 120000, diffLines: 400, diffTotal: 4000 };
const EMPTY = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
// Folders that are rebuilt rather than written, left out when a folder has no .gitignore of its own for them.
const EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.parcel-cache/', '.gradle/', '.DS_Store'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const clip = text => String(text || '').slice(0, 300);
const regular = entry => !entry || /^100(644|755)$/.test(entry.mode);
const same = (x, y) => (!x && !y) || Boolean(x && y && x.oid === y.oid && x.mode === y.mode);
const binary = buffer => buffer.subarray(0, 8000).includes(0);
export const ACTIONS = ['remove', 'restore', 'merge', 'recreate'];

// Git with no inherited repository variables, no hooks, no user or system config and no prompts, so it can only
// ever act on the private store it is pointed at.
function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Codeshi', GIT_AUTHOR_EMAIL: 'checkpoints@throughline.invalid', GIT_COMMITTER_NAME: 'Codeshi', GIT_COMMITTER_EMAIL: 'checkpoints@throughline.invalid' };
}
export function git(args, { gitDir, workTree, input, buffer = false, timeout = 60000, codes = [0], literal = false } = {}) {
  const bin = gitExecutable();
  if (!bin) return Promise.reject(new Error('Git is not available, so checkpoints are off.'));
  const prefix = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...(literal ? ['--literal-pathspecs'] : []), ...(gitDir ? ['--git-dir', gitDir] : []), ...(workTree ? ['--work-tree', workTree] : [])];
  return new Promise((resolve, reject) => {
    const child = execFile(bin, [...prefix, ...args], { encoding: buffer ? 'buffer' : 'utf8', env: environment(), timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      if (!codes.includes(code)) return reject(new Error(error?.killed ? `Git took longer than ${Math.round(timeout / 1000)} seconds.` : String(stderr || error?.message || '').trim().split('\n').at(-1) || 'Git failed.'));
      resolve({ stdout, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// A workspace path from a snapshot, checked so a write can't leave the folder through a link or a non-folder.
export function safeTarget(root, relative) {
  const parts = String(relative).split('/');
  if (!relative || relative.includes('\0') || path.isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..')) fail(`Unsafe path in checkpoint: ${relative}`, 409);
  let directory = fs.realpathSync(root);
  const base = directory;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    let stat; try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${relative} is inside a link or a file, so it was left as is.`, 409);
  }
  const target = path.join(base, ...parts);
  if (path.relative(base, target).startsWith('..')) fail(`Unsafe path in checkpoint: ${relative}`, 409);
  return target;
}

// Paths in a diff-tree --raw -z listing, with each side's mode and blob, or null for a side where the path is absent.
function parseRaw(stdout) {
  const fields = stdout.split('\0'), changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index].match(/^:(\d{6}) (\d{6}) ([\da-f]+) ([\da-f]+) ([A-Z])/);
    if (!meta) continue;
    const side = (mode, oid) => /^0+$/.test(oid) || mode === '000000' ? null : { mode, oid };
    changes.push({ path: fields[index + 1], before: side(meta[1], meta[3]), after: side(meta[2], meta[4]) });
  }
  return changes;
}

export class RunCheckpoints {
  constructor(broker, limits = {}) {
    this.broker = broker; this.limits = { ...checkpointLimits, ...limits };
    this.root = path.join(broker.dataDir, 'checkpoints');
    this.chain = Promise.resolve(); this.ready = new Set(); this.closed = false;
  }
  // One snapshot at a time: they share each store's index.
  serial(task) { const next = this.chain.then(task, task); this.chain = next.catch(() => {}); return next; }
  idle() { return this.chain; }
  close() { this.closed = true; return this.chain; }

  folders() { return this.broker.workspaceFolders; }
  async store(folder) {
    const gitDir = path.join(this.root, `${folder.id}.git`);
    if (this.ready.has(gitDir)) return gitDir;
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) { fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); await git(['init', '--bare', '--quiet', gitDir]); }
    for (const [key, value] of [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.symlinks', 'true'], ['core.ignoreCase', process.platform === 'linux' ? 'false' : 'true'], ['core.precomposeUnicode', 'true'], ['gc.auto', '0'], ['core.logAllRefUpdates', 'false']]) await git(['config', key, value], { gitDir });
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
    // Saved byte for byte: no line-ending conversion or filters from the project's .gitattributes.
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* -text -eol -crlf -filter -ident -working-tree-encoding\n');
    await git(['hash-object', '-w', '--stdin'], { gitDir, input: '' });
    this.ready.add(gitDir);
    return gitDir;
  }
  // Codeshi's own data, when it sits inside a workspace folder, is never part of a snapshot.
  ownData(folder) {
    try { const relative = path.relative(fs.realpathSync(folder.path), fs.realpathSync(this.broker.dataDir)); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? [relative.split(path.sep).join('/')] : []; }
    catch { return []; }
  }

  async captureFolder(folder, ref, timeout) {
    const base = { folderId: folder.id, path: folder.path };
    try {
      const gitDir = await this.store(folder), run = (args, options = {}) => git(args, { gitDir, workTree: folder.path, timeout, ...options });
      // Only this process uses the store, so a lock left behind is from an interrupted snapshot.
      fs.rmSync(path.join(gitDir, 'index.lock'), { force: true });
      const listed = [...new Set((await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(Boolean))];
      if (listed.length > this.limits.files) return { ...base, commit: null, error: `This folder has more than ${this.limits.files.toLocaleString('en-US')} files. Add a .gitignore so Codeshi can keep checkpoints.` };
      const large = [];
      for (const name of listed) {
        let stat; try { stat = fs.lstatSync(path.join(folder.path, ...name.split('/'))); } catch { continue; }
        if (stat.isFile() && stat.size > this.limits.fileBytes) large.push(name);
      }
      if (large.length > this.limits.largeFiles) return { ...base, commit: null, error: 'This folder has too many large files to keep checkpoints.' };
      const left = [...large, ...this.ownData(folder)];
      await run(['add', '-A', '--', '.', ...left.map(name => `:(exclude,literal,top)${name}`)]);
      if (left.length) await run(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...left.map(name => `:(literal,top)${name}`)]);
      const tree = (await run(['write-tree'])).stdout.trim();
      const commit = (await run(['commit-tree', tree, '-m', ref || 'Current files'])).stdout.trim();
      if (ref) await run(['update-ref', `refs/throughline/${ref}`, commit]);
      return { ...base, commit, ...(large.length ? { skipped: large } : {}) };
    } catch (error) { return { ...base, commit: null, error: clip(error.message) }; }
  }
  capture(ref, timeout = this.limits.afterMs) { return Promise.all(this.folders().map(folder => this.captureFolder(folder, ref && `${ref}`, timeout))); }

  async changes(gitDir, from, to, paths = null) {
    if (paths && !paths.length) return [];
    return parseRaw((await git(['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to, ...(paths ? ['--', ...paths] : [])], { gitDir, literal: true })).stdout);
  }
  async count(before, after) {
    let files = 0;
    for (const folder of this.folders()) {
      const was = before.find(item => item.folderId === folder.id), made = after.find(item => item.folderId === folder.id);
      if (!was?.commit || !made?.commit) continue;
      const skipped = new Set([...(was.skipped || []), ...(made.skipped || [])]);
      files += (await this.changes(path.join(this.root, `${folder.id}.git`), was.commit, made.commit)).filter(change => !skipped.has(change.path)).length;
    }
    return files;
  }

  // Saved before an agent starts, so it can't change anything first. A snapshot that fails or takes too long
  // never stops the run; that run just can't be undone.
  async before(c, run) {
    if (this.closed) return;
    const folders = await this.serial(() => this.capture(`runs/${run.id}/before`, this.limits.beforeMs));
    run.checkpoint = folders.some(folder => folder.commit);
    try { this.broker.record(c, { type: 'run_snapshot', runId: run.id, phase: 'before', folders }); } catch (error) { console.error('Codeshi could not save a checkpoint:', error.message); run.checkpoint = false; }
  }
  // Saved once the agent's process has ended. Queued after anything pending, so a next run's "before" follows it.
  after(c, run) {
    if (!run.checkpoint || this.closed) return;
    this.serial(async () => {
      const folders = await this.capture(`runs/${run.id}/after`);
      const files = await this.count(c.snapshots?.[run.id]?.before?.folders || [], folders).catch(() => 0);
      this.broker.record(c, { type: 'run_snapshot', runId: run.id, phase: 'after', folders, files });
      await this.prune(c);
    }).catch(error => console.error('Codeshi could not save a checkpoint:', error.message));
  }
  // Keeps the newest runs and undos; older ones are let go, with their snapshots.
  async prune(c) {
    const runs = Object.keys(c.snapshots || {}), rewinds = (c.rewinds || []).map(item => item.id);
    const runIds = runs.slice(0, Math.max(0, runs.length - this.limits.keepRuns)), rewindIds = rewinds.slice(0, Math.max(0, rewinds.length - this.limits.keepRewinds));
    if (!runIds.length && !rewindIds.length) return;
    for (const folder of this.folders()) {
      const gitDir = path.join(this.root, `${folder.id}.git`);
      if (!fs.existsSync(gitDir)) continue;
      const refs = [...runIds.map(id => `runs/${id}`), ...rewindIds.map(id => `rewinds/${id}`)].flatMap(name => [`refs/throughline/${name}/before`, `refs/throughline/${name}/after`]);
      await git(['update-ref', '--stdin'], { gitDir, input: refs.map(ref => `delete ${ref}\n`).join('') }).catch(() => {});
      await git(['-c', 'gc.pruneExpire=now', 'gc', '--auto', '--quiet'], { gitDir, timeout: 120000 }).catch(() => {});
    }
    this.broker.record(c, { type: 'snapshot_expired', runIds, rewindIds });
  }

  // The two snapshots an undo reverses: a run's own, or an earlier undo's (which redoes the run).
  pair(c, target) {
    if (!target || !['run', 'rewind', 'checkpoint'].includes(target.kind) || typeof target.id !== 'string' || !/^[\da-f-]{36}$/.test(target.id)) fail('Choose a run, an undo or a checkpoint.');
    if (target.kind === 'checkpoint') {
      if (!['before', 'after'].includes(target.phase)) fail('Choose the checkpoint before or after this step.');
      const saved = c.snapshots?.[target.id]?.[target.phase], rewind = c.rewinds?.find(item => item.id === target.id);
      const folders = saved?.folders || rewind?.folders.map(item => ({ folderId: item.folderId, path: item.path, ...item[target.phase] }));
      if (!folders?.length) fail('This checkpoint is no longer available.', 404);
      const current = this.folders();
      if (folders.length !== current.length || folders.some(item => !current.some(folder => folder.id === item.folderId && folder.path === item.path))) fail('The workspace folders changed since this checkpoint. Restore is unavailable.', 409);
      if (folders.some(item => !item.commit)) fail('This checkpoint did not save every folder. Choose another checkpoint.', 409);
      return { runId: saved ? target.id : rewind.runId, before: folders, restore: true, checkpointAt: saved?.at || rewind.at, checkpointKind: saved ? 'run' : rewind.target.kind === 'checkpoint' ? 'restore' : 'undo' };
    }
    if (target.kind === 'run') {
      const saved = c.snapshots?.[target.id];
      if (!saved?.before || !saved?.after) fail('This run has no checkpoint. Runs are saved from this version on, and older checkpoints are let go after 100 runs.', 404);
      return { runId: target.id, before: saved.before.folders, after: saved.after.folders };
    }
    const rewind = c.rewinds?.find(item => item.id === target.id);
    if (!rewind) fail('This undo is no longer available.', 404);
    return { runId: rewind.runId, before: rewind.folders.map(({ folderId, path: where, before }) => ({ folderId, path: where, ...before })), after: rewind.folders.map(({ folderId, path: where, after }) => ({ folderId, path: where, ...after })) };
  }

  async blob(gitDir, entry) { return entry ? (await git(['cat-file', 'blob', entry.oid], { gitDir, buffer: true })).stdout : Buffer.alloc(0); }
  async merge(gitDir, ours, base, theirs) {
    const directory = fs.mkdtempSync(path.join(this.root, 'merge-'));
    try {
      const files = [['current', ours], ['run', base], ['before', theirs]].map(([name, content]) => { const file = path.join(directory, name); fs.writeFileSync(file, content); return file; });
      const result = await git(['merge-file', '-p', '-q', ...files], { buffer: true, codes: Array.from({ length: 128 }, (_, index) => index) });
      return { content: result.stdout, conflicts: result.code };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  // What undoing does to one path, given its content before the run (was), after it (made) and now.
  async decide(gitDir, item) {
    const { was, made, now } = item, left = reason => ({ ...item, action: 'conflict', reason });
    if (item.skipped) return { ...item, action: 'skip', reason: 'Too large to keep in a checkpoint.' };
    if (same(now, was)) return { ...item, action: 'unchanged' };
    if (![was, made, now].every(regular)) return { ...item, action: 'skip', reason: 'Links and nested repositories are not restored.' };
    if (same(now, made)) return !was ? { ...item, action: 'remove', result: null } : !now ? { ...item, action: 'recreate', result: was } : { ...item, action: 'restore', result: was };
    // Changed again since the run: take the run's own edit out and keep the rest, when that is unambiguous.
    if (!was || !made || !now) return left(!now ? 'Deleted since the run.' : !made ? 'Created again since the run.' : 'Changed since the run; undoing would remove those changes.');
    const [ours, base, theirs] = await Promise.all([this.blob(gitDir, now), this.blob(gitDir, made), this.blob(gitDir, was)]);
    if ([ours, base, theirs].some(binary)) return left('Changed since the run, and binary files cannot be merged.');
    const merged = await this.merge(gitDir, ours, base, theirs);
    if (merged.conflicts) return left('Changed since the run in the same places.');
    if (merged.content.equals(ours)) return { ...item, action: 'unchanged' };
    const oid = (await git(['hash-object', '-w', '--stdin'], { gitDir, input: merged.content })).stdout.trim();
    return { ...item, action: 'merge', result: { mode: now.mode, oid } };
  }
  async diff(gitDir, from, to) {
    const [a, b] = await Promise.all([this.blob(gitDir, from), this.blob(gitDir, to)]);
    if (binary(a) || binary(b)) return { binary: true };
    const text = (await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', from?.oid || EMPTY, to?.oid || EMPTY], { gitDir })).stdout;
    const lines = text.slice(Math.max(0, text.indexOf('\n@@') + 1)).split('\n').filter(Boolean);
    return { diff: lines.slice(0, this.limits.diffLines).join('\n'), ...(lines.length > this.limits.diffLines ? { truncated: lines.length - this.limits.diffLines } : {}) };
  }

  async plan(c, target) {
    const pair = this.pair(c, target), current = await this.capture(null), files = [], stores = [];
    if (pair.restore) {
      if (current.some(item => !item.commit)) fail('Could not save every current folder. No files can be restored until a recovery checkpoint can be made.', 409);
      pair.after = current;
    }
    for (const folder of this.folders()) {
      const was = pair.before.find(item => item.folderId === folder.id), made = pair.after.find(item => item.folderId === folder.id), now = current.find(item => item.folderId === folder.id);
      if (!was?.commit || !made?.commit) continue;
      const label = folder.displayName || folder.name;
      if (was.path !== folder.path) { files.push({ folderId: folder.id, folder: label, path: '', action: 'skip', reason: 'This folder moved since the run.' }); continue; }
      if (!now?.commit) fail(`Could not read the current files in ${label}: ${now?.error || 'unknown error'}`, 409);
      const gitDir = path.join(this.root, `${folder.id}.git`), changed = await this.changes(gitDir, was.commit, made.commit);
      if (!changed.length) continue;
      const since = new Map((await this.changes(gitDir, made.commit, now.commit, changed.map(change => change.path))).map(change => [change.path, change.after]));
      const skipped = new Set([...(was.skipped || []), ...(made.skipped || []), ...(now.skipped || [])]);
      stores.push({ folder, gitDir, now, was });
      for (const change of changed) files.push({ ...await this.decide(gitDir, { folderId: folder.id, folder: label, path: change.path, was: change.before, made: change.after, now: since.has(change.path) ? since.get(change.path) : change.after, skipped: skipped.has(change.path) }), gitDir });
    }
    const digest = createHash('sha256').update(JSON.stringify([target, files.map(file => [file.folderId, file.path, file.action, file.now?.oid || null, file.now?.mode || null, file.result?.oid || null, file.result?.mode || null])])).digest('hex');
    return { pair, files, stores, digest, current };
  }

  async preview(c, target) {
    return this.serial(async () => {
      const plan = await this.plan(c, target), run = c.runs?.find(item => item.id === plan.pair.runId);
      let lines = 0;
      const files = [];
      for (const file of plan.files.filter(item => item.action !== 'unchanged')) {
        const shown = { folderId: file.folderId, folder: file.folder, path: file.path, action: file.action, ...(file.reason ? { reason: file.reason } : {}) };
        if (ACTIONS.includes(file.action) && lines < this.limits.diffTotal) { Object.assign(shown, await this.diff(file.gitDir, file.now, file.result)); lines += shown.diff ? shown.diff.split('\n').length : 0; }
        files.push(shown);
      }
      return { target, runId: plan.pair.runId, provider: run?.provider || null, local: Boolean(run?.local), prompt: run?.prompt || '', startedAt: run?.startedAt || null, ...(plan.pair.restore ? { checkpointAt: plan.pair.checkpointAt, checkpointKind: plan.pair.checkpointKind } : {}), digest: plan.digest, files, unchanged: plan.files.filter(file => file.action === 'unchanged').length };
    });
  }

  // Writes one path as a snapshot entry says, or removes it for none. Writes go through a temporary file and a rename.
  async put(folder, gitDir, relative, entry) {
    const target = safeTarget(folder.path, relative);
    let stat = null; try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && !stat.isFile()) fail(`${relative} is no longer a file, so it was left as is.`, 409);
    if (!entry) { if (stat) fs.unlinkSync(target); return; }
    const content = await this.blob(gitDir, entry), executable = entry.mode === '100755';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const permissions = stat ? (executable ? (stat.mode & 0o777) | ((stat.mode & 0o444) >> 2) : stat.mode & 0o666) : executable ? 0o755 : 0o644;
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID().slice(0, 8)}.throughline`);
    try { fs.writeFileSync(temporary, content, { mode: permissions, flag: 'wx' }); fs.chmodSync(temporary, permissions); fs.renameSync(temporary, target); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  // Folders a removed file leaves empty go too, when they didn't exist before the run.
  tidy(folder, relative, kept) {
    const parts = relative.split('/'); parts.pop();
    while (parts.length) {
      const directory = parts.join('/');
      if (kept.some(name => name.startsWith(directory + '/'))) return;
      try { fs.rmdirSync(safeTarget(folder.path, directory)); } catch { return; }
      parts.pop();
    }
  }

  async apply(c, target, digest) {
    return this.serial(async () => {
      if (this.broker.running) fail('Wait for the current run to finish before undoing changes.', 409);
      const plan = await this.plan(c, target);
      if (typeof digest !== 'string' || plan.digest !== digest) fail('Files changed since you reviewed this. Review the changes again.', 409);
      const order = file => ACTIONS.indexOf(file.action);
      // Removals first: on a case-insensitive disk, a renamed file would otherwise be written and then removed.
      const work = plan.files.filter(file => ACTIONS.includes(file.action)).sort((a, b) => order(a) - order(b));
      if (!work.length) fail(plan.pair.restore ? 'The saved files already match this checkpoint.' : 'There is nothing to undo: these files are already as they were, or changed since.', 409);
      const id = randomUUID(), folderOf = new Map(this.folders().map(folder => [folder.id, folder])), done = [];
      const savedStores = plan.pair.restore ? this.folders().map(folder => ({ folder, gitDir: path.join(this.root, `${folder.id}.git`), now: plan.current.find(item => item.folderId === folder.id) })) : plan.stores;
      for (const store of savedStores) await git(['update-ref', `refs/throughline/rewinds/${id}/before`, store.now.commit], { gitDir: store.gitDir });
      // Record recovery before the first write. If Codeshi stops mid-restore, Timeline can still restore these files.
      if (plan.pair.restore) this.broker.record(c, { type: 'rewind', id, target, runId: plan.pair.runId, pending: true,
        folders: plan.current.map(item => ({ folderId: item.folderId, path: item.path, before: { commit: item.commit, skipped: item.skipped || [] }, after: { commit: null } })), counts: {}, left: [] });
      try {
        for (const file of work) { await this.put(folderOf.get(file.folderId), file.gitDir, file.path, file.result); done.push(file); }
      } catch (error) {
        for (const file of done.reverse()) try { await this.put(folderOf.get(file.folderId), file.gitDir, file.path, file.now); } catch (restoreError) { console.error('Codeshi could not put a file back:', restoreError.message); }
        throw Object.assign(new Error(`Undo stopped and put back the files it had changed: ${error.message}`), { status: error.status || 500 });
      }
      for (const store of plan.stores) {
        const removed = work.filter(file => file.folderId === store.folder.id && !file.result);
        if (!removed.length) continue;
        const kept = (await git(['ls-tree', '-r', '-z', '--name-only', store.was.commit], { gitDir: store.gitDir }).catch(() => ({ stdout: '' }))).stdout.split('\0').filter(Boolean);
        for (const file of removed) this.tidy(store.folder, file.path, kept);
      }
      const after = await this.capture(`rewinds/${id}/after`);
      const folders = savedStores.map(store => {
        const saved = after.find(item => item.folderId === store.folder.id);
        return { folderId: store.folder.id, path: store.folder.path, before: { commit: store.now.commit, ...(store.now.skipped ? { skipped: store.now.skipped } : {}) }, after: { commit: saved?.commit || null, ...(saved?.skipped ? { skipped: saved.skipped } : {}) } };
      });
      const counts = Object.fromEntries(ACTIONS.map(action => [action, work.filter(file => file.action === action).length]));
      const left = plan.files.filter(file => ['conflict', 'skip'].includes(file.action)).map(({ folderId, path: where, reason }) => ({ folderId, path: where, reason }));
      const run = c.runs?.find(item => item.id === plan.pair.runId);
      this.broker.record(c, { type: 'rewind', id, target, runId: plan.pair.runId, folders, counts, left: left.slice(0, 200) });
      this.broker.message(c, 'system', plan.pair.restore
        ? `Restored the workspace to the checkpoint ${target.phase} ${plan.pair.checkpointKind === 'run' ? agentName(run) + '’s step' : plan.pair.checkpointKind === 'restore' ? 'a workspace restore' : 'an undo or redo'}. Changed ${plural(work.length, 'file')}.${left.length ? ` Left ${plural(left.length, 'file')} as they are; review the Timeline for details.` : ''} The conversation is kept. Earlier messages describe historical files; inspect the current files before continuing. A recovery checkpoint is available in Timeline.`
        : note({ redo: target.kind === 'rewind', run, counts, work, left, multi: this.folders().length > 1 }), run?.provider || c.provider);
      await this.prune(c);
      return { id, counts, left };
    });
  }

  // Public history contains descriptions and targets, never private object-store paths or blob identities.
  timeline(c) {
    const entries = [], current = this.folders();
    const point = (id, phase, folders, at) => {
      const available = folders?.length === current.length && folders?.length > 0 && folders.every(item => item.commit && current.some(folder => folder.id === item.folderId && folder.path === item.path));
      return { target: { kind: 'checkpoint', id, phase }, at, available: Boolean(available),
        ...(!available ? { reason: folders?.some(item => !item.commit) ? 'Not every folder was saved.' : 'Workspace folders changed since this checkpoint.' } : {}) };
    };
    for (const [id, saved] of Object.entries(c.snapshots || {})) {
      const message = c.messages?.find(item => item.runId === id && item.role === 'user');
      const run = c.runs?.find(item => item.id === id) || c.activeRun?.id === id && c.activeRun || {};
      entries.push({ id, kind: 'run', runId: id, provider: run.provider || message?.provider || null, local: Boolean(run.local || run.connection === 'local' || message?.connection === 'local'), prompt: run.prompt || message?.text.slice(0, 200) || '',
        at: saved.before?.at || saved.after?.at, status: run.status || (c.activeRun?.id === id ? 'running' : 'unknown'), files: saved.files ?? null,
        checkpoints: ['before', 'after'].filter(phase => saved[phase]).map(phase => point(id, phase, saved[phase].folders, saved[phase].at)) });
    }
    for (const rewind of c.rewinds || []) entries.push({ id: rewind.id, kind: rewind.target.kind === 'checkpoint' ? 'restore' : 'undo', runId: rewind.runId, at: rewind.at, pending: Boolean(rewind.pending),
      files: Object.values(rewind.counts || {}).reduce((sum, count) => sum + count, 0), left: rewind.left?.length || 0,
      checkpoints: ['before', 'after'].filter(phase => phase === 'before' || !rewind.pending).map(phase => point(rewind.id, phase, rewind.folders.map(item => ({ folderId: item.folderId, path: item.path, ...item[phase] })), rewind.at)) });
    return entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  // Which runs can be undone or redone, for the conversation view.
  summary(c) {
    // A whole-workspace restore supersedes earlier undo/redo labels. Their old checkpoints remain in Timeline,
    // but whether any run can still be undone is determined from the current files when its preview opens.
    const rewinds = c.rewinds || [], restored = rewinds.findLastIndex(item => item.target.kind === 'checkpoint' && !item.pending), recent = rewinds.slice(restored + 1);
    const reverted = new Set(recent.filter(item => item.target.kind === 'rewind').map(item => item.target.id)), result = {};
    for (const [runId, saved] of Object.entries(c.snapshots || {})) {
      if (!saved.before || !saved.after || !saved.files) continue;
      const undo = recent.findLast(item => item.target.kind === 'run' && item.target.id === runId && !reverted.has(item.id));
      result[runId] = { files: saved.files, ...(undo ? { undone: undo.id } : {}) };
    }
    return result;
  }
}

const agentName = run => run?.local ? 'the local model' : run?.provider === 'claude' ? 'Claude' : run?.provider === 'gemini' ? 'Gemini' : run?.provider === 'codex' ? 'Codex' : 'the agent';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// The note every agent reads next, so nobody builds on changes that were taken back.
function note({ redo, run, counts, work, left, multi }) {
  const task = run?.prompt ? ` from “${run.prompt.length > 80 ? run.prompt.slice(0, 79) + '…' : run.prompt}”` : '';
  const parts = [counts.restore && `restored ${plural(counts.restore, 'file')}`, counts.merge && `took its edits out of ${plural(counts.merge, 'file')} and kept later changes`, counts.remove && `removed ${plural(counts.remove, 'file')} it added`, counts.recreate && `brought back ${plural(counts.recreate, 'file')} it deleted`].filter(Boolean);
  const files = work.slice(0, 12).map(file => multi ? `${file.folder}/${file.path}` : file.path).join(', ') + (work.length > 12 ? `, and ${work.length - 12} more` : '');
  const lines = [redo ? `Redid ${agentName(run)}’s changes${task}: put back ${plural(work.length, 'file')} (${files}).` : `Undid ${agentName(run)}’s changes${task}: ${parts.join(', ')} (${files}).`];
  if (left.length) lines.push(`Left as they are: ${left.slice(0, 8).map(file => file.path).join(', ')}${left.length > 8 ? ` and ${left.length - 8} more` : ''}.`);
  lines.push(redo ? 'The files are back as that run left them.' : 'The project files no longer contain that run’s changes. Inspect the current files before building on that run’s work.');
  return lines.join(' ');
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitExecutable } from './resolve-binary.mjs';

const prefix = ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
export function githubRepository(remote = '') {
  const match = remote.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}
export function runner(folder, spawnImpl, { timeout = 5000, maxBuffer = 1024 * 1024, encoding = 'utf8' } = {}) {
  return (args, extra = []) => spawnImpl(gitExecutable(), [...prefix, ...extra, ...args], { cwd: folder.path, shell: false, encoding, timeout, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PAGER: 'cat' } });
}
export function isRepository(run) { const inside = run(['rev-parse', '--is-inside-work-tree']); return inside.status === 0 && String(inside.stdout || '').trim() === 'true'; }
// Status and diff can invoke attributes filters. Returns -c overrides that disable configured external drivers.
export function filterOverrides(run) {
  const config = run(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']);
  if (config.error || ![0, 1].includes(config.status)) return { error: 'Could not inspect Git filter settings safely.' };
  const overrides = [];
  for (const key of config.stdout.split('\0').filter(Boolean)) {
    const driver = key.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/)?.[1];
    if (!driver || !/^[\w.-]{1,200}$/.test(driver)) return { error: 'Unsupported Git filter configuration.' };
    for (const setting of ['clean', 'smudge', 'process', 'required']) overrides.push('-c', `filter.${driver}.${setting}=${setting === 'required' ? 'false' : ''}`);
  }
  return { overrides };
}
function workingChanges(run, overrides, untracked = 'normal') {
  const status = run(['status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`, '--', '.'], overrides);
  const changes = [], entries = String(status.stdout || '').split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (entry.length < 4) continue;
    const code = entry.slice(0, 2), name = entry.slice(3), originalPath = /[RC]/.test(code) ? entries[++i] : undefined;
    changes.push({ path: name, code, staged: code[0] !== ' ' && code[0] !== '?', ...(originalPath ? { originalPath } : {}) });
  }
  return { ok: status.status === 0, changes };
}
// What a list of changes needs to show each file (#194): the lines it gained and lost since the last commit, and the
// files inside a new folder, which Git reports as one entry. A file Git doesn't follow yet is counted from disk when it
// is text of a modest size. A binary file gets no counts, and neither does anything that can't be read: the list still
// shows the file. A new folder with many files stays one entry, with how many it holds.
const COUNT_FILE_BYTES = 512 * 1024, COUNT_TOTAL_BYTES = 4 * 1024 * 1024, NEW_FOLDER_FILES = 30;
function describeChanges(run, overrides, changes, spawnImpl) {
  const counts = new Map();
  if (run(['rev-parse', '--verify', '--quiet', 'HEAD']).status === 0) {
    const stat = run(['diff', 'HEAD', '--numstat', '-z', '-M', '--no-relative', '--no-ext-diff', '--no-textconv', '--', '.'], overrides), parts = stat.status === 0 ? String(stat.stdout || '').split('\0') : [];
    for (let index = 0; index < parts.length; index++) {
      const match = parts[index].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
      if (!match) continue;
      // A rename's two paths follow as entries of their own: the old name, then the new one.
      const file = match[3] === '' ? parts[index += 2] : match[3];
      if (file && match[1] !== '-') counts.set(file, { added: Number(match[1]), removed: Number(match[2]) });
    }
  }
  // Git reports paths from the repository's root, which is above the folder when a nested folder is attached.
  const top = run(['rev-parse', '--show-toplevel']), root = top.status === 0 ? String(top.stdout || '').trim() : '';
  if (!root) return;
  const atRoot = runner({ path: root }, spawnImpl, { timeout: 3000, maxBuffer: 256 * 1024 });
  let budget = COUNT_TOTAL_BYTES;
  const fromDisk = file => {
    const target = path.resolve(root, file), inside = path.relative(root, target);
    if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) return null;
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > COUNT_FILE_BYTES || stat.size > budget) return null;
      const real = path.relative(fs.realpathSync(root), fs.realpathSync(target));
      if (!real || real === '..' || real.startsWith('..' + path.sep) || path.isAbsolute(real)) return null;
      // A file being written cannot make this background read grow past its budget.
      const buffer = Buffer.alloc(stat.size + 1), length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      budget -= length;
      if (length !== stat.size) return null;
      const bytes = buffer.subarray(0, length);
      if (bytes.subarray(0, 8000).includes(0)) return null;
      const text = bytes.toString('utf8');
      return { added: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, removed: 0 };
    } catch { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  for (const change of changes) {
    const known = counts.get(change.path);
    if (known) { Object.assign(change, known); continue; }
    if (change.code !== '??' && !change.code.includes('A')) continue;
    if (!change.path.endsWith('/')) { Object.assign(change, fromDisk(change.path)); continue; }
    const listed = atRoot(['ls-files', '--others', '--exclude-standard', '-z', '--', change.path]);
    const files = listed.status === 0 && !listed.error ? String(listed.stdout || '').split('\0').filter(Boolean) : null;
    if (files?.length && files.length <= NEW_FOLDER_FILES) change.files = files.map(file => ({ path: file, ...fromDisk(file) }));
    else if (files?.length) change.fileCount = files.length;
  }
}
export function workspaceGit(folders, { spawnImpl = spawnSync, untracked = 'normal', lines = false } = {}) {
  return { checkedAt: new Date().toISOString(), repositories: folders.map(folder => {
    const run = runner(folder, spawnImpl);
    const base = { folderId: folder.id, name: folder.displayName || folder.name, alias: folder.name };
    if (!isRepository(run)) return { ...base, available: false, error: 'No Git repository in this folder.' };
    const filters = filterOverrides(run);
    if (filters.error) return { ...base, available: false, error: filters.error };
    const status = workingChanges(run, filters.overrides, untracked);
    if (lines && status.ok) describeChanges(run, filters.overrides, status.changes.slice(0, 100), spawnImpl);
    const branch = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const log = run(['log', '-15', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x00', '--', '.']);
    const origin = run(['config', '--get', 'remote.origin.url']);
    const githubURL = githubRepository(origin.stdout);
    const changes = status.changes;
    const commits = log.status === 0 ? log.stdout.split('\0').map(row => row.trim()).filter(Boolean).map(row => {
      const [hash, shortHash, author, date, ...subject] = row.split('\x1f');
      return { hash, shortHash, author, date, subject: subject.join('\x1f'), url: githubURL && /^[a-f0-9]{40,64}$/.test(hash) ? `${githubURL}/commit/${hash}` : null };
    }) : [];
    // Everything staged, past the 100 changes listed: a commit from the panel must match it exactly.
    const stagedPaths = changes.filter(change => change.staged).flatMap(change => [change.path, change.originalPath].filter(Boolean));
    return { ...base, available: true, branch: branch.status === 0 ? branch.stdout.trim() : 'Detached HEAD', githubURL, changes: changes.slice(0, 100), totalChanges: changes.length, changesClipped: changes.length > 100, stagedPaths, commits, error: status.ok ? null : 'Could not read working changes.' };
  }) };
}
// Unified diff of one currently changed file against HEAD. Only paths Git reports as changed are accepted.
// Changed images are shown as pictures: the committed one and the one on disk, from their own bytes, and only when
// those bytes are the image their name says.
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
export const IMAGE_PREVIEW_BYTES = 4 * 1024 * 1024;
function isImage(type, bytes) {
  const text = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (type === 'image/png') return bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
  if (type === 'image/jpeg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/gif') return text(0, 4) === 'GIF8';
  if (type === 'image/webp') return text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP';
  if (type === 'image/bmp') return text(0, 2) === 'BM';
  if (type === 'image/x-icon') return bytes.length > 4 && bytes.readUInt32LE(0) === 0x00010000;
  if (type === 'image/avif') return text(4, 12).startsWith('ftypavi');
  return false;
}
function imageSide(type, bytes) {
  if (!bytes) return null;
  if (bytes.length > IMAGE_PREVIEW_BYTES) return { bytes: bytes.length, tooLarge: true };
  return isImage(type, bytes) ? { src: `data:${type};base64,${bytes.toString('base64')}`, bytes: bytes.length } : { bytes: bytes.length, unreadable: true };
}
function imagePreview(folder, file, head, spawnImpl) {
  const type = IMAGE_TYPES[path.extname(file.path).slice(1).toLowerCase()];
  if (!type) return null;
  // Before: the committed file, unless the change added it.
  let before = null;
  if (head && file.code !== '??' && !file.code.includes('A')) {
    const read = runner(folder, spawnImpl, { timeout: 10000, maxBuffer: IMAGE_PREVIEW_BYTES + 1, encoding: 'buffer' })(['cat-file', 'blob', `HEAD:${file.originalPath || file.path}`]);
    before = read.error?.code === 'ENOBUFS' ? { bytes: IMAGE_PREVIEW_BYTES + 1, tooLarge: true } : read.status === 0 ? imageSide(type, read.stdout) : null;
  }
  // After: the file on disk, unless the change deleted it. Only a regular file inside the folder is read.
  let after = null;
  const target = path.resolve(folder.path, file.path), inside = path.relative(path.resolve(folder.path), target);
  if (!file.code.includes('D') && inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
    try { const stat = fs.lstatSync(target); if (stat.isFile()) after = stat.size > IMAGE_PREVIEW_BYTES ? { bytes: stat.size, tooLarge: true } : imageSide(type, fs.readFileSync(target)); } catch { after = null; }
  }
  return before || after ? { before, after } : null;
}
export function workspaceGitDiff(folder, filePath, { spawnImpl = spawnSync, limit = 400 * 1024 } = {}) {
  const fail = (message, status) => Object.assign(new Error(message), { status });
  const run = runner(folder, spawnImpl, { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (!isRepository(run)) throw fail('No Git repository in this folder.', 404);
  const filters = filterOverrides(run);
  if (filters.error) throw fail(filters.error, 409);
  const file = workingChanges(run, filters.overrides).changes.find(entry => entry.path === filePath) || workingChanges(run, filters.overrides, 'all').changes.find(entry => entry.path === filePath);
  if (!file) throw fail('This file has no current changes. Refresh Git activity.', 404);
  const base = { folderId: folder.id, path: file.path, code: file.code, ...(file.originalPath ? { originalPath: file.originalPath } : {}) };
  if (file.path.endsWith('/')) return { ...base, diff: '', directory: true, truncated: false };
  // Porcelain paths are relative to the repository root even when the attached folder is nested. Keep validation
  // scoped to the attached folder above, then read those exact paths from the root.
  const top = run(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !String(top.stdout || '').trim()) throw fail('Could not locate this file’s repository.', 500);
  const repository = { ...folder, path: String(top.stdout).trim() };
  const atRoot = runner(repository, spawnImpl, { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  const options = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];
  let result;
  const head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (file.code === '??') result = atRoot(['diff', '--no-index', ...options, '--', '/dev/null', file.path], filters.overrides);
  else {
    const paths = ['--', ...(file.originalPath ? [file.originalPath] : []), file.path];
    // Before the first commit, the base is empty. Include current bytes even if a new staged file was edited again.
    if (head.status !== 0 && file.code.includes('D')) return { ...base, diff: '', truncated: false };
    result = atRoot(head.status === 0 ? ['diff', 'HEAD', ...options, ...paths] : ['diff', '--no-index', ...options, '--', '/dev/null', file.path], filters.overrides);
  }
  // --no-index exits 1 when the files differ; ENOBUFS keeps the output read so far.
  const overflow = result.error?.code === 'ENOBUFS';
  if ((result.error && !overflow) || (!overflow && ![0, 1].includes(result.status))) throw fail('Could not read this file’s changes.', 500);
  const diff = String(result.stdout || '');
  const images = /^Binary files /m.test(diff) ? imagePreview(repository, file, head.status === 0, spawnImpl) : null;
  return { ...base, diff: diff.slice(0, limit), truncated: overflow || diff.length > limit, ...(images ? { images } : {}) };
}

export function workspaceGitIdentity(folder) {
  const run = runner(folder, spawnSync), root = run(['rev-parse', '--show-toplevel']), head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (root.status !== 0) throw Object.assign(new Error('Attach a Git repository root to review its changes.'), { status: 400 });
  return { root: root.stdout.trim(), head: head.status === 0 ? head.stdout.trim() : null };
}

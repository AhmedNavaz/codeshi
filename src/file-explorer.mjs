import fs from 'node:fs';
import path from 'node:path';
import { MAX_FILE_BYTES, isTextBytes, sha256, validateRelativePath } from './collaboration-format.mjs';
import { inspectAttachment, attachmentLimits } from './attachments.mjs';
import { readWorkspaceFile, safeWorkspacePath, writeWorkspaceFile } from './workspace-files.mjs';

const fail = (message, status = 400, details = null) => { throw Object.assign(new Error(message), { status, ...(details ? { details } : {}) }); };
const allowed = value => { try { validateRelativePath(value); return true; } catch { return false; } };
const NON_TEXT_EXT = /\.(pdf|docx?|png|jpe?g|gif|webp|xlsx?|pptx?|zip|gz|mp[34]|mov|wav|heic|avif)$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function location(folder, relative = '') {
  if (typeof relative !== 'string') fail('Choose a folder or file.');
  if (relative) validateRelativePath(relative);
  const root = path.resolve(folder.path);
  if (fs.realpathSync(root) !== root) fail('Symbolic-link roots cannot be explored.');
  let target = root;
  for (const part of relative ? relative.split('/') : []) {
    target = path.join(target, part);
    if (fs.lstatSync(target).isSymbolicLink()) fail('Symbolic links are not opened in the explorer.');
  }
  return target;
}
export function listFiles(folder, relative = '', offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) fail('Invalid directory offset.');
  const target = location(folder, relative);
  if (!fs.statSync(target).isDirectory()) fail('Choose a directory.');
  const rows = fs.readdirSync(target, { withFileTypes: true }).filter(entry => (entry.isDirectory() || entry.isFile()) && allowed(relative ? relative + '/' + entry.name : entry.name));
  rows.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { folderId: folder.id, path: relative, entries: rows.slice(offset, offset + 200).map(entry => ({ name: entry.name, path: relative ? relative + '/' + entry.name : entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })), nextOffset: rows.length > offset + 200 ? offset + 200 : null };
}
export function readExplorerFile(folder, relative) {
  if (!relative) fail('Choose a file.');
  const target = location(folder, relative);
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('Only regular files can be previewed.');
    if (fs.realpathSync(target) !== target) fail('The file path changed while opening it. Try again.', 409);
    if (stat.size > attachmentLimits.imageBytes) fail('Preview supports images up to 5 MB and text/code up to 256 KB.', 413);
    const bytes = Buffer.alloc(stat.size + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size) fail('The file changed while reading. Try again.', 409);
    const contents = bytes.subarray(0, length), name = path.basename(relative), hash = sha256(new Uint8Array(contents));
    if (!contents.length && !NON_TEXT_EXT.test(name)) {
      return { name, mime: 'text/plain', kind: 'text', bytes: 0, folderId: folder.id, path: relative, data: '', text: '', sha256: hash, editable: true };
    }
    if (contents.length > attachmentLimits.textBytes && contents.length <= MAX_FILE_BYTES && !NON_TEXT_EXT.test(name) && isTextBytes(contents)) {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents);
      if (!CONTROL_CHARS.test(text)) {
        return { name, mime: 'text/plain', kind: 'text', bytes: contents.length, folderId: folder.id, path: relative, data: contents.toString('base64'), text, sha256: hash, editable: true };
      }
    }
    const { text: inspectedText, ...meta } = inspectAttachment(name, contents);
    const editable = meta.kind === 'text' && !/\.(pdf|docx)$/i.test(meta.name);
    const text = editable ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents) : inspectedText;
    return { ...meta, folderId: folder.id, path: relative, data: contents.toString('base64'), sha256: hash, editable, ...(meta.kind === 'text' ? { text } : {}) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function conflictDetails(before, running = null) {
  const deleted = before.sha256 === null;
  const current = {
    deleted,
    sha256: before.sha256,
    text: before.content,
    bytes: before.content === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
  };
  return {
    message: deleted ? 'This file was deleted on disk since you opened it.' : 'This file changed on disk since you opened it.',
    details: { code: 'FILE_CHANGED', current, ...(running ? { activeRun: running } : {}) },
  };
}

// Saves a UTF-8 text file edited in the file view (#195) through the server's guarded write.
// Refuses paths outside the folder, symlinks, private paths, binary/oversized files and stale hashes.
export function saveExplorerFile(folder, relative, content, { expectedHash, force = false, activeRun = null } = {}) {
  if (!relative || typeof relative !== 'string') fail('Choose a file.');
  validateRelativePath(relative);
  if (NON_TEXT_EXT.test(relative)) fail('Only plain text and code files can be edited here.');
  if (typeof content !== 'string') fail('File content must be text.');
  if (content.includes('\u0000')) fail('Binary content cannot be saved here.');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) fail('Files must be 256 KB or smaller to save here.', 413);
  if (!force && (typeof expectedHash !== 'string' || !HASH_PATTERN.test(expectedHash))) {
    fail('Missing file version hash. Reload the file and try again.');
  }
  const safe = safeWorkspacePath(folder.path, relative, { allowMissing: true, allowPrivate: false });
  if (!safe.missing) {
    const stat = fs.lstatSync(safe.target);
    if (stat.isSymbolicLink()) fail('Symlink operations are unsupported: ' + relative);
    if (!stat.isFile()) fail('Only regular text files are supported: ' + relative);
    if (stat.size > MAX_FILE_BYTES) fail('Files over 256 KB stay read-only here.', 413);
  }
  const before = readWorkspaceFile(folder.path, relative, { allowMissing: true, binary: false, allowPrivate: false });
  if (!force && before.sha256 !== expectedHash) {
    const running = typeof activeRun === 'function' ? activeRun() : activeRun;
    const conflict = conflictDetails(before, running);
    fail(conflict.message, 409, conflict.details);
  }
  const running = typeof activeRun === 'function' ? activeRun() : activeRun;
  if (running) {
    fail(
      running.touched
        ? `An agent (${running.label}) is working in this folder and has touched ${relative}.`
        : `An agent (${running.label}) is working in this folder.`,
      409,
      { code: 'ACTIVE_RUN', activeRun: running }
    );
  }
  try {
    writeWorkspaceFile(folder.path, relative, content, {
      expectedHash: force ? undefined : expectedHash,
      binary: false,
      allowPrivate: false,
    });
  } catch (error) {
    if (error?.status === 409 && !force) {
      let latest = { sha256: null, content: null };
      try { latest = readWorkspaceFile(folder.path, relative, { allowMissing: true, binary: false, allowPrivate: false }); } catch { /* Fall back to conflict error below. */ }
      const conflict = conflictDetails(latest, running);
      fail(conflict.message, 409, conflict.details);
    }
    throw error;
  }
  const savedHash = sha256(content);
  return {
    name: path.basename(relative),
    folderId: folder.id,
    path: relative,
    kind: 'text',
    mime: 'text/plain',
    bytes,
    text: content,
    data: Buffer.from(content, 'utf8').toString('base64'),
    sha256: savedHash,
    editable: true,
  };
}

// File search for the search bar, across every workspace folder. It follows the explorer's rules, so private,
// credential and runtime paths (such as .git, node_modules and .env) never appear, and it skips build output and
// symbolic links. Each folder's file list is read at most every 30 seconds, and a large folder stops at a limit.
const SKIPPED = /^(?:dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|target|vendor|__pycache__|\.venv|venv|\.cache|\.turbo|\.parcel-cache|\.gradle|Pods|DerivedData)$/;
const fileLists = new Map();
export const FILE_SEARCH_LIMIT = 20000;
function folderFiles(folder) {
  const root = path.resolve(folder.path), cached = fileLists.get(root);
  if (cached && Date.now() - cached.at < 30000) return cached.files;
  const files = [], queue = [''];
  while (queue.length && files.length < FILE_SEARCH_LIMIT) {
    const relative = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(relative ? path.join(root, relative) : root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink() || !allowed(child)) continue;
      if (entry.isDirectory()) { if (!SKIPPED.test(entry.name)) queue.push(child); }
      else if (entry.isFile()) { files.push(child); if (files.length >= FILE_SEARCH_LIMIT) break; }
    }
  }
  fileLists.set(root, { at: Date.now(), files });
  return files;
}
// Matches rank by name first: an exact name, a name that starts with the text, then one that contains it, then a path.
export function searchFiles(workspaces, query, limit = 20) {
  const text = String(query || '').trim().toLowerCase();
  if (text.length < 2) return [];
  const found = [];
  for (const workspace of workspaces) for (const folder of workspace.folders || []) {
    let files;
    try { if (fs.realpathSync(path.resolve(folder.path)) !== path.resolve(folder.path)) continue; files = folderFiles(folder); } catch { continue; }
    for (const file of files) {
      const lower = file.toLowerCase(), name = lower.slice(lower.lastIndexOf('/') + 1);
      const rank = name === text ? 0 : name.startsWith(text) ? 1 : name.includes(text) ? 2 : lower.includes(text) ? 3 : -1;
      if (rank >= 0) found.push({ rank, projectId: workspace.id, projectName: workspace.name, folderId: folder.id, folderName: folder.name || path.basename(folder.path), path: file });
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return found.slice(0, limit).map(({ rank, ...file }) => file);
}

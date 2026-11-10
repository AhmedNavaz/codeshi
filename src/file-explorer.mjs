import fs from 'node:fs';
import path from 'node:path';
import { validateRelativePath } from './collaboration-format.mjs';
import { inspectAttachment, attachmentLimits } from './attachments.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const allowed = value => { try { validateRelativePath(value); return true; } catch { return false; } };
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
    if (stat.size > attachmentLimits.imageBytes) fail('Preview supports images up to 5 MB and text/code up to 64 KB.', 413);
    const bytes = Buffer.alloc(stat.size + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size) fail('The file changed while reading. Try again.', 409);
    const contents = bytes.subarray(0, length), { text, ...meta } = inspectAttachment(path.basename(relative), contents);
    return { ...meta, folderId: folder.id, path: relative, data: contents.toString('base64'), ...(meta.kind === 'text' ? { text } : {}) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
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

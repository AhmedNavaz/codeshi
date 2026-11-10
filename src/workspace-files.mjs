import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspaceFile } from './workspace-layout.mjs';
import { MAX_FILE_BYTES, MAX_BINARY_BYTES, sha256, fileBytes, isTextBytes, validateRelativePath, invalid } from './collaboration-format.mjs';

export function safeWorkspacePath(workspace, relative, { allowMissing = false } = {}) {
  validateRelativePath(relative);
  const selection=resolveWorkspaceFile(workspace,relative);
  const root=fs.realpathSync(selection.root);
  if(root!==path.resolve(selection.root))throw invalid('The workspace folder moved or became a symlink. Reattach its real folder.');
  const target = path.resolve(root, ...selection.relative.split('/'));
  if (!target.startsWith(root + path.sep) && !(root === path.parse(root).root && target.startsWith(root))) throw invalid('File is outside the selected workspace.');
  const parts = selection.relative.split('/');
  let current = root;
  let missing = false;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if (missing) continue;
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT' && allowMissing) { missing = true; continue; } throw invalid('Cannot access selected file: ' + relative); }
    if (stat.isSymbolicLink()) throw invalid('Symlink operations are unsupported: ' + relative);
    if (index < parts.length - 1 && !stat.isDirectory()) throw invalid('File parent is not a directory: ' + relative);
    if (index === parts.length - 1 && !stat.isFile()) throw invalid('Only regular text files are supported: ' + relative);
  }
  return { root, target, missing, relative:selection.relative };
}

// Text by default. With binary, a file that isn't UTF-8 text comes back as base64 with encoding 'base64'
// (#25); its hash is over the same bytes, so a text file's hash doesn't depend on the option.
export function readWorkspaceFile(workspace, relative, { allowMissing = false, binary = false } = {}) {
  const safe = safeWorkspacePath(workspace, relative, { allowMissing });
  if (safe.missing) return { path:relative, content:null, sha256:null, mode:null };
  let fd;
  try {
    fd = fs.openSync(safe.target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > (binary ? MAX_BINARY_BYTES : MAX_FILE_BYTES)) throw invalid((binary ? 'Only regular files up to 256 KiB of text or 1 MiB of binary data are supported: ' : 'Only regular text files up to 256 KiB are supported: ') + relative);
    const bytes = fs.readFileSync(fd);
    if (!isTextBytes(bytes)) {
      if (!binary && !bytes.includes(0)) throw invalid('Files must contain valid UTF-8 text: ' + relative);
      if (!binary || bytes.length > MAX_BINARY_BYTES) throw invalid('Binary or oversized files are unsupported: ' + relative);
      return { path:relative, content:bytes.toString('base64'), encoding:'base64', sha256:sha256(new Uint8Array(bytes)), mode:stat.mode & 0o777 };
    }
    if (bytes.length > MAX_FILE_BYTES) throw invalid('Only text files up to 256 KiB are supported: ' + relative);
    const content = new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(bytes);
    return { path:relative, content, sha256:sha256(content), mode:stat.mode & 0o777 };
  } catch (error) { if (error.status) throw error; throw invalid('Cannot safely read selected file: ' + relative); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function captureSelectedFiles(workspace, files = [], newPaths = []) {
  if (!Array.isArray(files) || !Array.isArray(newPaths) || files.length + newPaths.length > 128) throw invalid('Select at most 128 file paths.');
  if (new Set([...files,...newPaths]).size !== files.length + newPaths.length) throw invalid('Selected file and new-file paths must be unique.');
  const snapshots = files.map(relative => readWorkspaceFile(workspace, relative, { binary:true }));
  const absent = newPaths.map(relative => {
    const file = readWorkspaceFile(workspace, relative, { allowMissing:true, binary:true });
    if (file.sha256 !== null) throw invalid('A proposed new file already exists: ' + relative, 409);
    return file;
  });
  return { files:snapshots.map(({path,content,sha256,encoding})=>({path,content,sha256,...(encoding?{encoding}:{})})), baseline:[...snapshots,...absent].map(({path,sha256})=>({path,sha256})) };
}

function ensureParents(workspace, relative) {
  const { root,relative:local } = safeWorkspacePath(workspace, relative, { allowMissing:true });
  let current = root;
  for (const part of local.split('/').slice(0,-1)) {
    current = path.join(current,part);
    try { fs.mkdirSync(current); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid('Unsafe file parent: ' + relative);
  }
}

// Writes text, or with encoding 'base64' a binary file's bytes. binary also allows the file being replaced
// to be binary; without it, as before, only text is read or written.
export function writeWorkspaceFile(workspace, relative, content, { expectedHash, mode, encoding, binary = encoding !== undefined } = {}) {
  let data = content;
  if (content !== null && encoding !== undefined) {
    if (!binary) throw invalid('Unsupported text-file content.');
    try { data = fileBytes({ path:relative, content, encoding }); } catch (error) { throw invalid('Unsupported binary content: ' + relative); }
  } else if (content !== null && (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\u0000'))) throw invalid('Unsupported text-file content.');
  const before = readWorkspaceFile(workspace, relative, { allowMissing:true, binary });
  if (expectedHash !== undefined && before.sha256 !== expectedHash) throw invalid('File changed during application: ' + relative, 409);
  const safe = safeWorkspacePath(workspace, relative, { allowMissing:true });
  if (content === null) {
    if (before.sha256 !== null) { safeWorkspacePath(workspace,relative); fs.unlinkSync(safe.target); }
    return;
  }
  ensureParents(workspace,relative);
  const temporary = path.join(path.dirname(safe.target), '.ai-relay-' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode ?? before.mode ?? 0o644);
    fs.fchmodSync(fd, mode ?? before.mode ?? 0o644);
    if (typeof data === 'string') fs.writeFileSync(fd, data, 'utf8'); else fs.writeFileSync(fd, data);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const latest = readWorkspaceFile(workspace,relative,{allowMissing:true,binary});
    if (expectedHash !== undefined && latest.sha256 !== expectedHash) throw invalid('File changed during application: ' + relative,409);
    safeWorkspacePath(workspace,relative,{allowMissing:true});
    fs.renameSync(temporary,safe.target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function compareBaseline(workspace, baseline) {
  return baseline.flatMap(file => {
    try { const actual=readWorkspaceFile(workspace,file.path,{allowMissing:true,binary:true}); return actual.sha256===file.sha256?[]:[{path:file.path,expected:file.sha256,actual:actual.sha256,reason:'File differs from the approved baseline.'}]; }
    catch(error){return [{path:file.path,expected:file.sha256,actual:null,reason:error.message}];}
  });
}

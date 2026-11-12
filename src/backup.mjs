// Codeshi backups (#160): workspaces with their conversations, memory, skills, board cards and tasks, and settings, in
// one file sealed with a passphrase, for moving to another computer by disk or keeping a copy. There is no account and
// no server: the file is sealed on this computer and opened only where the passphrase is typed.
//
// The file is a short header in the clear (what's needed to derive the key, nothing about you), then the contents in
// 1 MiB pieces, each sealed with AES-256-GCM under a key derived from the passphrase with scrypt. Each piece's nonce
// carries its position and whether it is the last, and the header is authenticated with every piece, so a file that was
// changed, reordered, cut short or extended is refused rather than read.
//
// Inside are records: the manifest first (what the backup holds), then each file of each workspace's data, then an end
// record. Paths differ between computers, so the import asks which folder each workspace folder is here and rewrites
// the folder IDs and paths that Codeshi's own records hold. Text people and agents wrote stays as it was written.
//
// What never moves: agent sign-ins, the GitHub login, remote-access pairings, the keychain, approvals you chose to
// always allow, and the private copies parallel tasks worked in. A checkpoint store is taken only as Git objects and
// refs, never its config or hooks, so a crafted file can't make Codeshi run anything.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { canonicalFolder, stableId } from './projects.mjs';
import { STARTER_ROOT } from './skills.mjs';
import { acquireProjectLock } from './mutation-lock.mjs';
import { expandFolder, localClones, originRepository, suggestedCloneFolder } from './github-repos.mjs';

const fail = (message, status = 400, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
export const BACKUP_EXTENSION = '.codeshibackup';
const MAGIC = Buffer.from('CODESHI-BACKUP\n'), CHUNK = 1024 * 1024, TAG = 16, MAX_HEADER = 4096, MAX_RECORD = 8 * 1024 * 1024;
// About half a second and 128 MiB on a recent Mac, once per export or import. Files may ask for less or more, within
// limits, so a crafted header can't make opening it take minutes or exhaust memory.
export const DEFAULT_KDF = Object.freeze({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
const scrypt = promisify(scryptCallback);
const deriveKey = (passphrase, kdf, salt) => scrypt(Buffer.from(passphrase.normalize('NFC'), 'utf8'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 160 * kdf.N * kdf.r + 16 * 1024 * 1024 });
const version = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();
// Settings that mean the same on another computer. Paths, pairings, the share server and the setup guide's progress
// stay with the computer they were made on.
export const PORTABLE_SETTINGS = ['appearance', 'language', 'defaults', 'notifications', 'handoff', 'contextLimit', 'verificationCadence', 'suggestions'];

export function checkPassphrase(value) {
  if (typeof value !== 'string' || value.length < 8) fail('Use a passphrase of at least 8 characters.');
  if (value.length > 1024) fail('Use a passphrase of at most 1,024 characters.');
  return value;
}

function nonce(prefix, counter, last) {
  if (counter > 0xffffffff) fail('This backup is too large.', 413);
  const value = Buffer.alloc(12); prefix.copy(value, 0); value.writeUInt32BE(counter, 7); value[11] = last ? 1 : 0; return value;
}
const u32 = value => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };

// Writes plaintext in sealed pieces. The last piece is sealed by finish(), even when empty, so a cut file is noticed.
class SealWriter {
  static async create(file, passphrase, kdf = DEFAULT_KDF) {
    const salt = randomBytes(16), prefix = randomBytes(7);
    const header = Buffer.from(JSON.stringify({ format: 'codeshi-backup', version: 1, kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', chunk: CHUNK, nonce: prefix.toString('base64') }));
    const key = await deriveKey(passphrase, kdf, salt), aad = Buffer.concat([MAGIC, u32(header.length), header]);
    const handle = await fsp.open(file, 'wx', 0o600);
    try { await handle.write(aad); } catch (error) { await handle.close(); throw error; }
    return new SealWriter(handle, key, prefix, aad);
  }
  constructor(handle, key, prefix, aad) { this.handle = handle; this.key = key; this.prefix = prefix; this.aad = aad; this.pending = []; this.pendingBytes = 0; this.counter = 0; this.bytes = aad.length; }
  async seal(plain, last) {
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.counter++, last)); cipher.setAAD(this.aad);
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    await this.handle.write(Buffer.concat([u32(body.length), body])); this.bytes += 4 + body.length;
  }
  async write(buffer) {
    if (!buffer.length) return;
    this.pending.push(buffer); this.pendingBytes += buffer.length;
    while (this.pendingBytes >= CHUNK) {
      const all = Buffer.concat(this.pending), piece = all.subarray(0, CHUNK);
      this.pending = [all.subarray(CHUNK)]; this.pendingBytes = all.length - CHUNK;
      await this.seal(piece, false);
    }
  }
  async record(header, content = null) { const json = Buffer.from(JSON.stringify(header)); await this.write(u32(json.length)); await this.write(json); if (content) await this.write(content); }
  async finish() { await this.seal(Buffer.concat(this.pending), true); this.pending = []; await this.handle.sync(); await this.handle.close(); return this.bytes; }
  async abort() { try { await this.handle.close(); } catch { /* Already closed. */ } }
}

// Reads what SealWriter wrote, refusing anything that doesn't authenticate.
class SealReader {
  static async open(file, passphrase) {
    let handle;
    try { handle = await fsp.open(file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') fail(`There's no file at ${file}.`, 404); if (error.code === 'EISDIR') fail('Choose a backup file, not a folder.'); throw error; }
    try {
      const read = async (length, position) => { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, position); return buffer.subarray(0, bytesRead); };
      const magic = await read(MAGIC.length, 0);
      if (!magic.equals(MAGIC)) fail('This isn’t a Codeshi backup file.');
      const length = (await read(4, MAGIC.length)); if (length.length < 4) fail('This backup file is incomplete.');
      const size = length.readUInt32BE(); if (size < 2 || size > MAX_HEADER) fail('This backup file is damaged.');
      const raw = await read(size, MAGIC.length + 4); if (raw.length < size) fail('This backup file is incomplete.');
      let header; try { header = JSON.parse(raw.toString('utf8')); } catch { fail('This backup file is damaged.'); }
      if (header?.format !== 'codeshi-backup') fail('This isn’t a Codeshi backup file.');
      if (header.version !== 1) fail('This backup was made by a newer Codeshi. Update Codeshi here, then import it again.');
      const kdf = header.kdf || {}, salt = Buffer.from(String(kdf.salt || ''), 'base64'), prefix = Buffer.from(String(header.nonce || ''), 'base64');
      if (kdf.name !== 'scrypt' || !Number.isInteger(kdf.N) || kdf.N < 2 ** 14 || kdf.N > 2 ** 20 || (kdf.N & (kdf.N - 1)) || kdf.r !== 8 || !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 4 || salt.length !== 16 || prefix.length !== 7 || header.cipher !== 'aes-256-gcm' || header.chunk !== CHUNK) fail('This backup file is damaged.');
      const key = await deriveKey(checkPassphrase(passphrase), kdf, salt);
      return new SealReader(handle, key, prefix, Buffer.concat([MAGIC, length, raw]), MAGIC.length + 4 + size);
    } catch (error) { await handle.close(); throw error; }
  }
  constructor(handle, key, prefix, aad, position) { this.handle = handle; this.key = key; this.prefix = prefix; this.aad = aad; this.position = position; this.counter = 0; this.done = false; this.buffer = Buffer.alloc(0); }
  async bytesAt(length) { const buffer = Buffer.alloc(length); const { bytesRead } = await this.handle.read(buffer, 0, length, this.position); this.position += bytesRead; return buffer.subarray(0, bytesRead); }
  open(body, last) {
    try { const decipher = createDecipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.counter, last)); decipher.setAAD(this.aad); decipher.setAuthTag(body.subarray(body.length - TAG)); return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG)), decipher.final()]); }
    catch { return null; }
  }
  async piece() {
    if (this.done) return false;
    const length = await this.bytesAt(4);
    if (length.length < 4) fail('This backup file is incomplete. Copy it again from the other computer.');
    const size = length.readUInt32BE(); if (size < TAG || size > CHUNK + TAG) fail('This backup file is damaged.');
    const body = await this.bytesAt(size); if (body.length < size) fail('This backup file is incomplete. Copy it again from the other computer.');
    let plain = this.open(body, false), last = false;
    if (!plain) { plain = this.open(body, true); last = true; }
    if (!plain) fail(this.counter === 0 ? 'The passphrase is wrong, or this backup file is damaged.' : 'This backup file is damaged.', this.counter === 0 ? 401 : 400);
    this.counter++;
    if (last) { this.done = true; if ((await this.bytesAt(1)).length) fail('This backup file is damaged.'); }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, plain]) : plain;
    return true;
  }
  async read(length) {
    while (this.buffer.length < length) if (!await this.piece()) fail('This backup file is incomplete. Copy it again from the other computer.');
    const value = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return value;
  }
  // Up to max bytes, without waiting for more than one piece.
  async some(max) {
    if (!this.buffer.length && !await this.piece()) fail('This backup file is incomplete. Copy it again from the other computer.');
    const value = this.buffer.subarray(0, Math.min(max, this.buffer.length)); this.buffer = this.buffer.subarray(value.length); return value;
  }
  async record() {
    const size = (await this.read(4)).readUInt32BE(); if (size < 2 || size > MAX_RECORD) fail('This backup file is damaged.');
    try { return JSON.parse((await this.read(size)).toString('utf8')); } catch { fail('This backup file is damaged.'); }
  }
  async close() { try { await this.handle.close(); } catch { /* Already closed. */ } }
}

// Which files of a workspace's data move, by their path inside it. Conversations (memory and board cards are records in
// them), attached images, enabled skills, saved commands and tasks' own conversations. Checkpoint stores only when
// chosen, and then only their objects and refs.
const SAFE = /^(?!\.\.?$)[A-Za-z0-9._@+,=-]{1,200}$/;
const UUID = '[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}';
const JOURNAL = new RegExp(`^${UUID}\\.jsonl$`), TASK = new RegExp(`^${UUID}$`);
function laneFile(parts, checkpoints) {
  const [first, ...rest] = parts;
  if (!rest.length) return JOURNAL.test(first) || first === 'commands.json';
  if (first === 'attachments') return rest.length <= 2;
  if (first === 'skills') return rest.length <= 8;
  if (first === 'checkpoints') {
    if (!checkpoints || !/^[a-f\d]{16}\.git$/.test(rest[0])) return false;
    const inside = rest.slice(1);
    if (inside.length === 1) return inside[0] === 'packed-refs';
    if (inside[0] === 'refs') return inside.length <= 8;
    if (inside[0] !== 'objects') return false;
    return (inside.length === 3 && /^[\da-f]{2}$/.test(inside[1]) && /^[\da-f]{38,62}$/.test(inside[2])) || (inside.length === 3 && inside[1] === 'pack' && /^pack-[\da-f]{40,64}\.(?:pack|idx|rev)$/.test(inside[2]));
  }
  return false;
}
// Folders that can hold such files. Nothing else is opened, so a task's working copy is never even listed.
function laneFolder(parts, checkpoints) {
  const [first, ...rest] = parts;
  if (first === 'attachments') return rest.length <= 1;
  if (first === 'skills') return rest.length <= 7;
  if (first !== 'checkpoints' || !checkpoints) return false;
  if (!rest.length) return true;
  if (!/^[a-f\d]{16}\.git$/.test(rest[0])) return false;
  const inside = rest.slice(1);
  if (!inside.length) return true;
  if (inside[0] === 'refs') return inside.length <= 7;
  return inside[0] === 'objects' && (inside.length === 1 || (inside.length === 2 && (/^[\da-f]{2}$/.test(inside[1]) || inside[1] === 'pack')));
}
const pathParts = relative => { if (typeof relative !== 'string' || relative.length > 1000) return null; const parts = relative.split('/'); return parts.length <= 14 && parts.every(part => SAFE.test(part)) ? parts : null; };
export function portablePath(relative, { checkpoints = false } = {}) {
  const parts = pathParts(relative); if (!parts) return false;
  if (parts[0] === 'tasks') return parts.length >= 4 && TASK.test(parts[1]) && parts[2] === 'journal' && laneFile(parts.slice(3), checkpoints);
  return laneFile(parts, checkpoints);
}
function portableFolder(relative, { checkpoints = false } = {}) {
  const parts = pathParts(relative); if (!parts) return false;
  if (parts[0] === 'tasks') return parts.length === 1 || (TASK.test(parts[1]) && (parts.length === 2 || (parts[2] === 'journal' && (parts.length === 3 || laneFolder(parts.slice(3), checkpoints)))));
  return laneFolder(parts, checkpoints);
}
const isCheckpoint = relative => /(?:^|\/)checkpoints\//.test(relative);

// Files of one workspace's data folder that move, with their sizes now. A conversation is taken up to its last
// complete record.
function lastLineEnd(file, size) {
  if (!size) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - 65536), buffer = Buffer.alloc(end - start); fs.readSync(fd, buffer, 0, buffer.length, start);
      const index = buffer.lastIndexOf(10); if (index >= 0) return start + index + 1;
      end = start;
    }
    return 0;
  } finally { fs.closeSync(fd); }
}
export function workspaceFiles(dataDir, { checkpoints = false } = {}) {
  const files = [];
  const visit = (directory, relative, depth) => {
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name, abs = path.join(directory, entry.name);
      // Links are never followed: a workspace's data holds none, and one could lead anywhere.
      if (entry.isDirectory()) { if (depth < 13 && portableFolder(rel, { checkpoints })) visit(abs, rel, depth + 1); continue; }
      if (!entry.isFile() || !portablePath(rel, { checkpoints })) continue;
      const stat = fs.statSync(abs), size = rel.endsWith('.jsonl') ? lastLineEnd(abs, stat.size) : stat.size;
      if (size) files.push({ rel, abs, size, modifiedAt: stat.mtime.toISOString() });
    }
  };
  visit(dataDir, '', 0);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function running(registry, id) {
  const broker = registry.brokers.get(id)?.broker;
  return Boolean(broker && (broker.running || broker.backgroundReview || broker.tasks?.busy));
}

// What Settings › Backup shows before an export: each workspace and how much it would add.
export function backupSummary(registry) {
  const documents = path.join(os.homedir(), 'Documents');
  return {
    suggestedFolder: tilde(isDirectory(documents) ? documents : os.homedir()),
    workspaces: registry.list().map(project => {
      const files = workspaceFiles(path.join(registry.dataRoot, project.id), { checkpoints: true });
      const sum = list => list.reduce((total, file) => total + file.size, 0);
      return { id: project.id, name: project.name, folders: project.folders.map(folder => folder.displayName || folder.name), running: running(registry, project.id), bytes: sum(files.filter(file => !isCheckpoint(file.rel))), checkpointBytes: sum(files.filter(file => isCheckpoint(file.rel))) };
    }),
  };
}

// Where a backup is written or read: an absolute path or one beginning with ~/, in a folder that exists.
export function backupFile(value, { writing = false } = {}) {
  let file = expandFolder(typeof value === 'string' ? value : '');
  if (writing && !file.toLowerCase().endsWith(BACKUP_EXTENSION)) file += BACKUP_EXTENSION;
  let parent; try { parent = fs.statSync(path.dirname(file)); } catch { parent = null; }
  if (!parent?.isDirectory()) fail(`The folder ${path.dirname(file)} doesn’t exist on this computer.`, 404);
  return file;
}

export async function exportBackup({ registry, settings = {}, file, passphrase, workspaces = [], includeSettings = true, replace = false, kdf = DEFAULT_KDF, origin = originRepository }) {
  checkPassphrase(passphrase);
  const target = backupFile(file, { writing: true });
  if (fs.existsSync(target) && !replace) fail(`${path.basename(target)} already exists there. Choose another name.`, 409);
  if (!Array.isArray(workspaces) || workspaces.length > 200) fail('Choose the workspaces to back up.');
  if (!workspaces.length && !includeSettings) fail('Choose at least one workspace, or settings.');
  registry.reload();
  const chosen = workspaces.map((item, index) => {
    const entry = registry.entry(String(item?.id || ''));
    if (running(registry, entry.id)) fail(`${entry.name} is working. Wait for it to finish, or stop it, then export again.`, 409);
    const dataDir = path.join(registry.dataRoot, entry.id), files = workspaceFiles(dataDir, { checkpoints: item.checkpoints === true });
    return { key: `w${index + 1}`, entry, dataDir, files, checkpoints: item.checkpoints === true };
  });
  if (new Set(chosen.map(item => item.entry.id)).size !== chosen.length) fail('Choose each workspace once.');
  const manifest = {
    type: 'manifest', format: 'codeshi-backup', version: 1, createdAt: new Date().toISOString(), appVersion: version, computer: os.hostname().replace(/\.local$/, '').slice(0, 120), platform: process.platform,
    dataRoot: registry.dataRoot, starterRoot: STARTER_ROOT,
    settings: includeSettings ? Object.fromEntries(PORTABLE_SETTINGS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]])) : null,
    workspaces: chosen.map(({ key, entry, dataDir, files, checkpoints }) => ({
      key, id: entry.id, name: entry.name, createdAt: entry.createdAt, conversationId: entry.conversationId || null, folderAliases: entry.folderAliases || {}, dataDir, checkpoints,
      folders: entry.folders.map(folder => ({ id: folder.id, name: folder.name, displayName: folder.displayName || folder.name, path: folder.path, repository: fs.existsSync(folder.path) ? origin(folder.path) : null })),
      conversations: files.filter(item => JOURNAL.test(item.rel)).map(item => ({ id: item.rel.slice(0, -6), bytes: item.size, modifiedAt: item.modifiedAt })),
      files: files.length, bytes: files.reduce((total, item) => total + item.size, 0),
    })),
  };
  // Written beside the target and renamed at the end, so a failed export leaves no half file under the chosen name.
  const partial = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID().slice(0, 8)}.partial`);
  const writer = await SealWriter.create(partial, passphrase, kdf);
  let count = 0;
  try {
    await writer.record(manifest);
    for (const { key, files, entry } of chosen) {
      for (const item of files) {
        await writer.record({ type: 'file', workspace: key, path: item.rel, size: item.size, modifiedAt: item.modifiedAt });
        const handle = await fsp.open(item.abs, 'r');
        try {
          for (let done = 0; done < item.size;) {
            const buffer = Buffer.alloc(Math.min(256 * 1024, item.size - done)), { bytesRead } = await handle.read(buffer, 0, buffer.length, done);
            if (!bytesRead) fail(`${entry.name} changed while it was being exported. Export again.`, 409);
            await writer.write(buffer.subarray(0, bytesRead)); done += bytesRead;
          }
        } finally { await handle.close(); }
        count++;
      }
    }
    await writer.record({ type: 'end', files: count });
    const bytes = await writer.finish();
    fs.renameSync(partial, target);
    return { path: target, bytes, files: count, workspaces: chosen.length, settings: Boolean(manifest.settings) };
  } catch (error) { await writer.abort(); fs.rmSync(partial, { force: true }); throw error; }
}

// The manifest is checked before anything in it is used: it decides which folders are suggested and how files are named.
function checkManifest(manifest) {
  const bad = () => fail('This backup file is damaged.');
  if (manifest?.type !== 'manifest' || manifest.format !== 'codeshi-backup' || manifest.version !== 1 || !Array.isArray(manifest.workspaces) || manifest.workspaces.length > 200) bad();
  const keys = new Set();
  for (const workspace of manifest.workspaces) {
    if (!/^w\d{1,4}$/.test(workspace?.key) || keys.has(workspace.key) || !/^[a-f\d]{16}$/.test(workspace.id) || typeof workspace.name !== 'string' || !workspace.name.trim() || workspace.name.length > 120 || !Array.isArray(workspace.folders) || !workspace.folders.length || workspace.folders.length > 32 || typeof workspace.dataDir !== 'string' || !Array.isArray(workspace.conversations)) bad();
    keys.add(workspace.key);
    if (workspace.conversationId !== null && !/^[\da-f-]{36}$/.test(workspace.conversationId || '')) bad();
    if (!workspace.folderAliases || typeof workspace.folderAliases !== 'object' || Array.isArray(workspace.folderAliases)) bad();
    const ids = new Set();
    for (const folder of workspace.folders) {
      if (!/^[a-f\d]{16}$/.test(folder?.id) || ids.has(folder.id) || typeof folder.path !== 'string' || !folder.path || folder.path.length > 4096 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder.name) || typeof folder.displayName !== 'string' || folder.displayName.length > 120) bad();
      if (folder.repository !== null && folder.repository !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(folder.repository)) bad();
      ids.add(folder.id);
    }
    for (const conversation of workspace.conversations) if (!new RegExp(`^${UUID}$`).test(conversation?.id || '')) bad();
  }
  if (manifest.settings !== null && (typeof manifest.settings !== 'object' || Array.isArray(manifest.settings))) bad();
  return manifest;
}

async function openBackup(file, passphrase) {
  const reader = await SealReader.open(backupFile(file), passphrase);
  try { return { reader, manifest: checkManifest(await reader.record()) }; }
  catch (error) { await reader.close(); throw error; }
}

const isDirectory = folder => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } };
const tilde = folder => folder === os.homedir() ? '~' : folder.startsWith(os.homedir() + path.sep) ? '~/' + folder.slice(os.homedir().length + 1) : folder;

// What the import screen shows: what the backup holds, and for each folder a suggested folder on this computer, found
// by its GitHub address among the workspaces and the clone folder, or by the same path.
export async function readBackup({ registry, settings = {}, file, passphrase, origin = originRepository }) {
  const { reader, manifest } = await openBackup(file, passphrase);
  await reader.close();
  const folders = registry.list().flatMap(project => project.folders.map(folder => folder.path));
  const cloneFolder = settings.githubCloneFolder || expandFolder(suggestedCloneFolder(folders));
  const clones = localClones({ folders, cloneFolder, origin });
  return {
    createdAt: manifest.createdAt, computer: manifest.computer, appVersion: manifest.appVersion,
    settings: manifest.settings ? Object.keys(manifest.settings).filter(key => PORTABLE_SETTINGS.includes(key)) : null,
    hasWorkspaces: registry.list().length > 0, cloneFolder: tilde(cloneFolder),
    workspaces: manifest.workspaces.map(workspace => ({
      key: workspace.key, name: workspace.name, conversations: workspace.conversations.length, bytes: Number(workspace.bytes) || 0, checkpoints: workspace.checkpoints === true,
      folders: workspace.folders.map(folder => {
        const repository = folder.repository || null, clone = repository ? clones.get(repository.toLowerCase()) : null;
        const same = !clone && isDirectory(folder.path) && (!repository || origin(folder.path) === repository.toLowerCase()) ? folder.path : null;
        return { id: folder.id, name: folder.name, displayName: folder.displayName, path: folder.path, repository, suggestion: clone ? { path: clone, reason: 'clone' } : same ? { path: same, reason: 'same-path' } : null };
      }),
    })),
  };
}

// Folder IDs and paths in Codeshi's own records, from the other computer's to this one's: whole values only, so text
// people and agents wrote keeps what it said. A record is rewritten only when something in it changed.
export function rewriter({ ids = new Map(), prefixes = [], fromSeparator = '/', toSeparator = path.sep } = {}) {
  const pairs = prefixes.filter(([from, to]) => from && from !== to).sort((a, b) => b[0].length - a[0].length);
  const needles = [...ids.keys(), ...pairs.flatMap(([from]) => [from, JSON.stringify(from).slice(1, -1)])];
  const text = value => {
    if (ids.has(value)) return ids.get(value);
    for (const [from, to] of pairs) {
      if (value === from) return to;
      if (value.startsWith(from + fromSeparator)) { const rest = value.slice(from.length); return to + (fromSeparator === toSeparator ? rest : rest.split(fromSeparator).join(toSeparator)); }
    }
    return value;
  };
  const walk = value => typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map(walk) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [ids.get(key) ?? key, walk(item)])) : value;
  const line = source => {
    if (!needles.length || !needles.some(needle => source.includes(needle))) return source;
    let parsed; try { parsed = JSON.parse(source); } catch { return source; }
    const before = JSON.stringify(parsed), after = JSON.stringify(walk(parsed));
    return after === before ? source : after;
  };
  return { line, value: walk, active: needles.length > 0 };
}

// Where each backed-up workspace goes here, from the folders chosen for it: an existing workspace with exactly those
// folders, or a new one.
function placeWorkspace(registry, workspace, chosen) {
  const mapped = [];
  for (const folder of workspace.folders) {
    const value = chosen?.[folder.id];
    if (value === null || value === undefined || value === '') continue;
    let directory; try { directory = canonicalFolder(value); } catch (error) { fail(`${folder.displayName}: ${error.message}`, error.status || 400); }
    if (mapped.some(item => item.path === directory)) fail(`${workspace.name}: two folders can’t use ${tilde(directory)}.`);
    mapped.push({ from: folder, path: directory, id: stableId(directory) });
  }
  if (!mapped.length) return null;
  const roots = mapped.map(item => item.path).sort();
  const disk = folder => { try { return fs.realpathSync.native(folder); } catch { return folder; } };
  const existing = [...registry.projects.values()].find(project => project.folders.length === roots.length && project.folders.every(folder => roots.includes(disk(folder.path))));
  let id = existing?.id || stableId(mapped[0].path);
  if (!existing && registry.projects.has(id)) id = stableId(randomUUID());
  return { mapped, existing: existing ? { id: existing.id, name: existing.name, removed: Boolean(existing.removedAt) } : null, id };
}

// How a conversation from the backup relates to the copy here: the same, a continuation of it, behind it, or both
// changed since they parted.
function compare(local, incoming) {
  if (local.equals(incoming)) return 'same';
  if (incoming.length > local.length && incoming.subarray(0, local.length).equals(local)) return 'newer';
  if (local.length > incoming.length && local.subarray(0, incoming.length).equals(incoming)) return 'older';
  return 'diverged';
}
const hasUserMessage = file => { try { const stat = fs.statSync(file); if (stat.size > 2 * 1024 * 1024) return true; return /"role":"user"/.test(fs.readFileSync(file, 'utf8')); } catch { return false; } };

export async function importBackup({ registry, file, passphrase, workspaces = [], includeSettings = false, decisions = {}, applySettings = () => [], origin = originRepository }) {
  checkPassphrase(passphrase);
  if (!Array.isArray(workspaces)) fail('Choose where each workspace goes.');
  const { reader, manifest } = await openBackup(file, passphrase);
  const stage = path.join(registry.dataRoot, `.import-${randomUUID()}`);
  try {
    registry.reload();
    // Where each workspace goes, and how its records are rewritten for this computer.
    const plans = new Map();
    for (const workspace of manifest.workspaces) {
      const choice = workspaces.find(item => item?.key === workspace.key);
      if (!choice) continue;
      const place = placeWorkspace(registry, workspace, choice.folders || {});
      if (!place) continue;
      if (place.existing && running(registry, place.existing.id)) fail(`${place.existing.name} is working. Wait for it to finish, or stop it, then import again.`, 409);
      const ids = new Map([[workspace.id, place.id]]), dataDir = path.join(registry.dataRoot, place.id);
      for (const item of place.mapped) ids.set(item.from.id, item.id);
      const prefixes = [...place.mapped.map(item => [item.from.path, item.path]), [workspace.dataDir, dataDir], [manifest.starterRoot, STARTER_ROOT]];
      const rewrite = rewriter({ ids, prefixes, fromSeparator: manifest.platform === 'win32' ? '\\' : '/' });
      // Checkpoint stores are named by folder ID. A folder that isn't coming leaves its store behind (null).
      const folderIds = new Map(place.mapped.map(item => [item.from.id, item.id]));
      const rename = relative => {
        const store = relative.match(/(?:^|\/)checkpoints\/([a-f\d]{16})\.git\//); if (!store) return relative;
        return folderIds.has(store[1]) ? relative.replace(`checkpoints/${store[1]}.git/`, `checkpoints/${folderIds.get(store[1])}.git/`) : null;
      };
      plans.set(workspace.key, { workspace, place, dataDir, rewrite, rename, staged: path.join(stage, workspace.key), files: [] });
    }
    if (!plans.size && !(includeSettings && manifest.settings)) fail('Choose a folder for at least one workspace, or settings.');

    // Decrypt into a folder beside Codeshi's data, rewritten for this computer. Nothing here changes yet.
    fs.mkdirSync(stage, { mode: 0o700 });
    let count = 0;
    for (;;) {
      const record = await reader.record();
      if (record?.type === 'end') { if (record.files !== count) fail('This backup file is damaged.'); break; }
      if (record?.type !== 'file' || typeof record.workspace !== 'string' || !Number.isSafeInteger(record.size) || record.size < 0) fail('This backup file is damaged.');
      const workspace = manifest.workspaces.find(item => item.key === record.workspace);
      if (!workspace || !portablePath(record.path, { checkpoints: workspace.checkpoints === true })) fail('This backup file is damaged.');
      count++;
      const plan = plans.get(record.workspace), relative = plan ? plan.rename(record.path) : null;
      if (!plan || !relative) { for (let left = record.size; left > 0;) left -= (await reader.some(left)).length; continue; }
      const target = path.join(plan.staged, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await fsp.open(target, 'wx', 0o600);
      try {
        if (relative.endsWith('.jsonl')) {
          // Record by record, so a long conversation is never held whole.
          const decoder = new StringDecoder('utf8'); let carry = '';
          for (let left = record.size; left > 0;) {
            const piece = await reader.some(left); left -= piece.length;
            const text = carry + decoder.write(piece), end = text.lastIndexOf('\n');
            if (end < 0) { carry = text; continue; }
            carry = text.slice(end + 1);
            await handle.write(Buffer.from(text.slice(0, end + 1).split('\n').map(item => item ? plan.rewrite.line(item) : item).join('\n'), 'utf8'));
          }
          carry += decoder.end(); if (carry) await handle.write(Buffer.from(plan.rewrite.line(carry), 'utf8'));
        } else if (relative.endsWith('commands.json')) {
          const parts = []; for (let left = record.size; left > 0;) { const piece = await reader.some(left); parts.push(piece); left -= piece.length; }
          const source = Buffer.concat(parts).toString('utf8');
          let output = source; try { output = `${JSON.stringify(plan.rewrite.value(JSON.parse(source)), null, 2)}\n`; } catch { /* Kept as it was; it's checked when used. */ }
          await handle.write(Buffer.from(output, 'utf8'));
        } else for (let left = record.size; left > 0;) { const piece = await reader.some(left); await handle.write(piece); left -= piece.length; }
      } finally { await handle.close(); }
      plan.files.push({ relative, modifiedAt: typeof record.modifiedAt === 'string' ? record.modifiedAt : null });
    }

    // Conversations that changed both here and in the backup since they parted need your choice.
    const conflicts = [];
    for (const [key, plan] of plans) {
      if (!plan.place.existing) continue;
      for (const item of plan.files.filter(entry => JOURNAL.test(entry.relative))) {
        const here = path.join(plan.dataDir, item.relative);
        if (!fs.existsSync(here)) continue;
        if (compare(fs.readFileSync(here), fs.readFileSync(path.join(plan.staged, item.relative))) !== 'diverged') continue;
        const id = item.relative.slice(0, -6), decision = decisions[`${key}:${id}`];
        if (decision === 'keep' || decision === 'backup') continue;
        const main = registry.projects.get(plan.place.existing.id)?.conversationId === id;
        conflicts.push({ key: `${key}:${id}`, workspace: plan.place.existing.name, conversationId: id, current: main, here: { bytes: fs.statSync(here).size, modifiedAt: fs.statSync(here).mtime.toISOString() }, backup: { bytes: fs.statSync(path.join(plan.staged, item.relative)).size, modifiedAt: item.modifiedAt } });
      }
    }
    if (conflicts.length) fail(conflicts.length === 1 ? 'A conversation changed both here and in the backup. Choose which to keep.' : `${conflicts.length} conversations changed both here and in the backup. Choose which to keep.`, 409, { conflicts });

    // Now the changes: each workspace is added or found, and its files moved in under its lock.
    const results = [];
    for (const [key, plan] of plans) {
      const { workspace, place } = plan, before = new Set(registry.projects.keys());
      const entry = registry.add({ folders: place.mapped.map(item => ({ path: item.path, name: item.from.name, displayName: item.from.displayName })), id: place.id });
      const created = !before.has(entry.id);
      if (created && entry.name !== workspace.name) registry.update(entry.id, { name: workspace.name });
      if (running(registry, entry.id)) fail(`${entry.name} started working during the import. Import again when it has finished.`, 409);
      const localMain = registry.projects.get(entry.id)?.conversationId || null, dataDir = path.join(registry.dataRoot, entry.id);
      registry.retireBroker(entry.id, false, 'A backup was imported into this workspace. Refresh to continue.');
      const unlock = registry.lock ? acquireProjectLock(dataDir) : () => {};
      const outcome = { id: entry.id, name: created ? workspace.name : entry.name, created, added: 0, updated: 0, kept: 0, replaced: 0, skippedCheckpoints: 0, skippedFolders: workspace.folders.filter(folder => !place.mapped.some(item => item.from.id === folder.id)).map(folder => folder.displayName) };
      try {
        const replacedDir = path.join(dataDir, 'import-replaced', new Date().toISOString().replace(/[:.]/g, '-'));
        const move = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.renameSync(from, to); };
        // A task already here keeps its own history, and a checkpoint store already here keeps its own checkpoints.
        // Both are decided before anything moves.
        const taskOf = relative => relative.match(/^tasks\/([^/]+)\//)?.[1], storeOf = relative => relative.match(/^(.*checkpoints\/[a-f\d]{16}\.git)\//)?.[1];
        const skipTasks = new Set(plan.files.map(item => taskOf(item.relative)).filter(id => id && fs.existsSync(path.join(dataDir, 'tasks', id))));
        const skipStores = new Set(plan.files.map(item => storeOf(item.relative)).filter(store => store && !skipTasks.has(taskOf(store + '/')) && fs.existsSync(path.join(dataDir, ...store.split('/')))));
        outcome.skippedCheckpoints = skipStores.size;
        for (const item of plan.files) {
          const from = path.join(plan.staged, item.relative), to = path.join(dataDir, item.relative);
          if (skipTasks.has(taskOf(item.relative)) || skipStores.has(storeOf(item.relative))) continue;
          if (JOURNAL.test(item.relative)) {
            if (!fs.existsSync(to)) { move(from, to); outcome.added++; continue; }
            const relation = compare(fs.readFileSync(to), fs.readFileSync(from)), decision = decisions[`${key}:${item.relative.slice(0, -6)}`];
            if (relation === 'same' || relation === 'older' || (relation === 'diverged' && decision !== 'backup')) { outcome.kept++; continue; }
            if (relation === 'diverged') { move(to, path.join(replacedDir, item.relative)); outcome.replaced++; } else outcome.updated++;
            fs.renameSync(from, to); continue;
          }
          if (item.relative === 'commands.json' && fs.existsSync(to)) {
            // Saved commands are combined; one with the same name here stays as it is.
            try {
              const here = JSON.parse(fs.readFileSync(to, 'utf8')), incoming = JSON.parse(fs.readFileSync(from, 'utf8'));
              if (here?.version === 2 && incoming?.version === 2 && Array.isArray(here.commands) && Array.isArray(incoming.commands)) {
                const known = new Set(here.commands.map(command => command?.id)), merged = { ...here, commands: [...here.commands, ...incoming.commands.filter(command => command && !known.has(command.id))].slice(0, 64) };
                const temporary = `${to}.${randomUUID().slice(0, 8)}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, to);
              }
            } catch { /* An unreadable list here is left as it is. */ }
            continue;
          }
          // Attachments and skill snapshots are named by their content, so one already here is the same.
          if (fs.existsSync(to)) continue;
          move(from, to);
        }
        // The moved conversation becomes the workspace's own when the workspace is new, or when its own has nothing
        // you wrote in it yet. Otherwise it's under previous conversations.
        const incomingMain = workspace.conversationId && fs.existsSync(path.join(dataDir, `${workspace.conversationId}.jsonl`)) ? workspace.conversationId : null;
        const adopt = incomingMain && (created || !localMain || (localMain !== incomingMain && !hasUserMessage(path.join(dataDir, `${localMain}.jsonl`)))) ? incomingMain : null;
        const aliases = {}; for (const [id, name] of Object.entries(workspace.folderAliases)) aliases[place.mapped.find(item => item.from.id === id)?.id || id] = name;
        registry.adoptImport(entry.id, { conversationId: adopt, folderAliases: aliases });
        outcome.previous = Boolean(incomingMain && !adopt && incomingMain !== localMain);
      } finally { unlock(); }
      results.push(outcome);
    }
    const appliedSettings = includeSettings && manifest.settings ? applySettings(Object.fromEntries(PORTABLE_SETTINGS.filter(key => manifest.settings[key] !== undefined).map(key => [key, manifest.settings[key]]))) : [];
    return { workspaces: results, settings: appliedSettings, from: { computer: manifest.computer, createdAt: manifest.createdAt } };
  } finally {
    await reader.close();
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function createBackupRoutes({ registry, body, json, settings, applySettings, origin = originRepository, kdf = DEFAULT_KDF }) {
  let busy = false;
  const once = async work => { if (busy) fail('Another backup is being made or imported. Wait for it to finish.', 409); busy = true; try { return await work(); } finally { busy = false; } };
  return async ({ req, res, url }) => {
    if (!url.pathname.startsWith('/api/backup')) return false;
    if (req.phoneClient) fail('Back up and import on the computer.', 403);
    if (url.pathname === '/api/backup') {
      if (req.method !== 'GET') fail('Use GET for the backup summary.', 405);
      json(res, 200, backupSummary(registry)); return true;
    }
    if (req.method !== 'POST') fail('Use POST for backups.', 405);
    const input = await body(req, 256 * 1024);
    if (url.pathname === '/api/backup/export') {
      json(res, 200, await once(() => exportBackup({ registry, settings: settings(), file: input.path, passphrase: input.passphrase, workspaces: input.workspaces, includeSettings: input.settings === true, replace: input.replace === true, kdf, origin }))); return true;
    }
    if (url.pathname === '/api/backup/read') { json(res, 200, await once(() => readBackup({ registry, settings: settings(), file: input.path, passphrase: input.passphrase, origin }))); return true; }
    if (url.pathname === '/api/backup/import') {
      try { json(res, 200, await once(() => importBackup({ registry, file: input.path, passphrase: input.passphrase, workspaces: input.workspaces, includeSettings: input.settings === true, decisions: input.decisions && typeof input.decisions === 'object' ? input.decisions : {}, applySettings, origin }))); }
      catch (error) { if (error.conflicts) { json(res, 409, { error: error.message, details: { conflicts: error.conflicts } }); return true; } throw error; }
      return true;
    }
    fail('Not found.', 404);
  };
}

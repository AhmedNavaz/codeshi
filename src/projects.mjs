import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker } from './broker.mjs';
import { acquireProjectLock, withFileGuard, MutationCoordinator } from './mutation-lock.mjs';

const journalName = /^[\da-f-]{36}\.jsonl$/;
const stableId = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function folderAvailable(directory) { try { return fs.statSync(directory).isDirectory(); } catch { return false; } }
function canonicalFolder(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail('Enter an absolute project folder path or a path starting with ~/.');
  let directory = input.trim();
  if (directory === '~') directory = os.homedir();
  else if (directory.startsWith('~/')) directory = path.join(os.homedir(), directory.slice(2));
  if (!path.isAbsolute(directory)) throw fail('Use an absolute project folder path or a path starting with ~/.');
  // The native realpath also returns each name's letter case as stored on disk, so a folder typed in another case
  // on a case-insensitive volume gets the same identity. The JavaScript version keeps the case as typed.
  try { directory = fs.realpathSync.native(directory); if (!fs.statSync(directory).isDirectory()) throw fail('The project path must be a folder.'); return directory; }
  catch (error) { if (error.status) throw error; throw fail(`Cannot open the project folder: ${input.trim()}. Check that it exists and is accessible.`); }
}
// Earlier versions saved folders in the letter case they were typed in, with IDs derived from that path.
// Compare saved folders by their path on disk, and keep the saved path and ID.
function diskPath(directory) { try { return fs.realpathSync.native(directory); } catch { return directory; } }
function displayName(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw fail('Enter a name between 1 and 120 characters.');
  return value.trim();
}
function alias(value, reserved) {
  const base = String(value).normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 48) || 'folder';
  let name = base; let suffix = 2;
  while (reserved.has(name)) name = `${base}-${suffix++}`;
  return name;
}
function folderRecord(input, previous = [], aliases = {}) {
  const value = typeof input === 'string' ? { path: input } : input;
  const directory = canonicalFolder(value?.path); const id = stableId(directory);
  const existing = previous.find(folder => folder.id === id || diskPath(folder.path) === directory);
  if (existing) return { ...existing };
  const human = displayName(value.displayName ?? value.name, path.basename(directory) || directory);
  const name = aliases[id] || alias(value.name || path.basename(directory), new Set(Object.values(aliases)));
  aliases[id] = name;
  return { id, name, displayName: human, path: directory };
}
function rootsSignature(folders) { return folders.map(folder => folder.path).join('\0'); }

export class ProjectRegistry extends EventEmitter {
  constructor({ dataRoot, bins = {}, lock = true }) {
    super();
    if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('ProjectRegistry requires a dataRoot folder.');
    this.dataRoot = path.resolve(dataRoot); this.bins = bins; this.lock = lock;
    // The app sets these from its saved preferences; workspaces read them when they check usage.
    this.handoffPreferences = () => ({ threshold: 90, automatic: false });
    this.verificationCadence = () => 'as-needed';
    this.contextLimit = () => 'auto';
    this.projects = new Map(); this.brokers = new Map(); this.closing = false; this.closePromise = null; this.activeMutations = new Set();
    fs.mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(this.dataRoot, 0o700);
    this.filename = path.join(this.dataRoot, 'projects.json'); this.mutations = new MutationCoordinator(this.dataRoot);
    this.reload();
    if (this.needsMigration) withFileGuard(this.filename, () => {
      this.reload();
      if(this.needsMigration){
        try{fs.copyFileSync(this.filename,this.filename+'.v1-backup',fs.constants.COPYFILE_EXCL);fs.chmodSync(this.filename+'.v1-backup',0o600);}catch(error){if(error.code!=='EEXIST')throw error;}
        this.persist();
      }
    });
  }

  reload() {
    const loaded = new Map(); this.needsMigration = false;
    if (fs.existsSync(this.filename)) {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(this.filename, 'utf8')); } catch { throw new Error(`Cannot read the project registry: ${this.filename}`); }
      if (![1, 2].includes(saved?.version) || !Array.isArray(saved.projects)) throw new Error(`Invalid project registry: ${this.filename}`);
      this.needsMigration = saved.version === 1;
      for (const item of saved.projects) {
        if (!item || !/^[a-f\d]{16}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || loaded.has(item.id)) throw new Error(`Invalid project entry in: ${this.filename}`);
        let folders; let folderAliases;
        if (saved.version === 1) {
          if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.id !== stableId(item.path)) throw new Error(`Invalid legacy project entry in: ${this.filename}`);
          const id = stableId(item.path); const name = alias(path.basename(item.path), new Set());
          folders = [{ id, name, displayName: path.basename(item.path) || item.path, path: item.path }]; folderAliases = { [id]: name };
        } else {
          if (!Array.isArray(item.folders) || !item.folders.length || item.folders.length > 32) throw new Error(`Invalid project folders in: ${this.filename}`);
          folders = item.folders.map(folder => {
            if (!folder || typeof folder.path !== 'string' || !path.isAbsolute(folder.path) || folder.id !== stableId(folder.path) || !tokenPattern.test(folder.name)) throw new Error(`Invalid project folder in: ${this.filename}`);
            return { id: folder.id, name: folder.name, displayName: typeof folder.displayName === 'string' ? folder.displayName : folder.name, path: folder.path };
          });
          if (new Set(folders.map(folder => folder.id)).size !== folders.length || new Set(folders.map(folder => folder.name)).size !== folders.length) throw new Error(`Duplicate project folders in: ${this.filename}`);
          folderAliases = { ...(item.folderAliases || {}) };
          for (const [id, name] of Object.entries(folderAliases)) if (!/^[a-f\d]{16}$/.test(id) || !tokenPattern.test(name)) throw new Error(`Invalid folder aliases in: ${this.filename}`);
          for (const folder of folders) folderAliases[folder.id] = folder.name;
        }
        if (item.conversationId && !/^[\da-f-]{36}$/.test(item.conversationId)) throw new Error(`Invalid permanent conversation in: ${this.filename}`);
        if (item.removedAt !== undefined && (typeof item.removedAt !== 'string' || !Number.isFinite(Date.parse(item.removedAt)))) throw new Error(`Invalid workspace removal in: ${this.filename}`);
        loaded.set(item.id, { id: item.id, name: item.name, path: folders[0].path, folders, folderAliases, conversationId: item.conversationId || null, createdAt: item.createdAt, previousConversationsDismissed: item.previousConversationsDismissed === true, ...(item.removedAt ? { removedAt: item.removedAt } : {}) });
      }
    }
    this.projects = loaded;
  }

  persist() {
    const temporary = path.join(this.dataRoot, `.projects-${process.pid}-${randomUUID()}.tmp`); let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, `${JSON.stringify({ version: 2, projects: [...this.projects.values()] }, null, 2)}\n`); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.filename); this.needsMigration = false;
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  assertOpen() { if (this.closing) throw fail('Codeshi is shutting down. Start it again to open a project.', 503); }
  entry(id, includeRemoved = false) { const entry = this.projects.get(id); if (!entry || entry.removedAt && !includeRemoved) throw fail('Project not found.', 404); return entry; }
  journalIds(id) { try { return fs.readdirSync(path.join(this.dataRoot, id)).filter(name => journalName.test(name)).map(name => name.slice(0, -6)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  workspace(id) { this.reload(); const entry = this.entry(id); return { path: entry.path, folders: entry.folders.map(folder => ({ ...folder, available: folderAvailable(folder.path) })) }; }
  public(entry) {
    const broker = this.brokers.get(entry.id)?.broker;
    const count = broker ? broker.conversations.size : this.journalIds(entry.id).length;
    const { folderAliases, removedAt, ...visible } = entry;
    return { ...visible, previousConversationsDismissed: entry.previousConversationsDismissed === true, folders: entry.folders.map(folder => ({ ...folder, available: folderAvailable(folder.path) })), available: folderAvailable(entry.path), runningConversationId: broker?.running?.c.id || (broker?.tasks?.running ? 'parallel-task' : null), pendingApprovals: (broker?.pendingCount() || 0) + (broker?.tasks?.openLanes().reduce((sum, lane) => sum + lane.pendingCount(), 0) || 0), conversationCount: count ? 1 : 0, archivedConversationCount: Math.max(0, count - 1) };
  }
  list() { this.reload(); return [...this.projects.values()].filter(entry => !entry.removedAt).map(entry => this.public(entry)); }
  get(id) { this.reload(); return this.public(this.entry(id)); }

  add(input = {}) {
    this.assertOpen();
    let supplied = input.folders === undefined ? [input.path] : input.folders;
    if (!Array.isArray(supplied) || !supplied.length || supplied.length > 32) throw fail('Select between 1 and 32 workspace folders.');
    if (input.path !== undefined && input.folders !== undefined) supplied = [input.path, ...supplied];
    let changed = false;
    const entry = withFileGuard(this.filename, () => {
      this.reload(); const aliases = {}; const folders = [];
      for (const item of supplied) { const folder = folderRecord(item, folders, aliases); if (!folders.some(existing => existing.id === folder.id)) folders.push(folder); }
      if (folders.length > 32) throw fail('Select between 1 and 32 workspace folders.');
      const roots = [...folders.map(folder => folder.path)].sort();
      const previous = [...this.projects.values()].find(project => project.folders.length === roots.length && project.folders.every(folder => roots.includes(diskPath(folder.path))));
      if (previous) {
        const name = input.name === undefined ? previous.name : displayName(input.name, previous.name);
        if (name === previous.name && !previous.removedAt) return previous;
        const { removedAt, ...saved } = previous;
        const renamed = { ...saved, name }; this.projects.set(previous.id, renamed); try { this.persist(); } catch (error) { this.reload(); throw error; } changed = true; return renamed;
      }
      let id = stableId(folders[0].path); if (this.projects.has(id)) id = stableId(randomUUID());
      const created = { id, name: displayName(input.name, folders[0].displayName), path: folders[0].path, folders, folderAliases: aliases, conversationId: null, createdAt: new Date().toISOString() };
      this.projects.set(id, created); try { this.persist(); } catch (error) { this.reload(); throw error; } changed = true; return created;
    });
    if (changed) this.emit('projects', { projectId: entry.id }); return this.public(entry);
  }

  update(id, input = {}) {
    this.assertOpen();
    if (input.previousConversationsDismissed !== undefined && typeof input.previousConversationsDismissed !== 'boolean') throw fail('Choose whether to dismiss previous conversations.');
    const entry = withFileGuard(this.filename, () => { this.reload(); const previous = this.entry(id); const value = { ...previous, name: displayName(input.name, previous.name), ...(input.previousConversationsDismissed !== undefined ? { previousConversationsDismissed: input.previousConversationsDismissed } : {}) }; this.projects.set(id, value); try { this.persist(); } catch (error) { this.reload(); throw error; } return value; });
    this.emit('projects', { projectId: id }); return this.public(entry);
  }

  remove(id) {
    this.assertOpen(); this.reload(); const before = this.entry(id, true);
    if (before.removedAt) return { id, removed: true };
    if (this.hasRunningCommands?.(id)) throw fail('Stop the project commands before removing this workspace.', 409);
    if (this.brokers.get(id)?.broker.running || this.brokers.get(id)?.broker.backgroundReview || this.brokers.get(id)?.broker.tasks?.busy) throw fail('Stop the current run and background review before removing this workspace.', 409);
    const signature = rootsSignature(before.folders);
    const lease = this.mutations.acquireMany(before.folders.map(folder => folder.path), 'workspace-removal');
    let held; let releaseHeld = false;
    try {
      const cached = this.brokers.get(id);
      held = cached?.unlock || (this.lock ? acquireProjectLock(path.join(this.dataRoot, id)) : () => {}); releaseHeld = !cached;
      withFileGuard(this.filename, () => {
        this.reload(); const previous = this.entry(id, true);
        if (previous.removedAt) return;
        if (rootsSignature(previous.folders) !== signature) throw fail('Workspace folders changed in another window. Refresh and retry.', 409);
        this.projects.set(id, { ...previous, removedAt: new Date().toISOString() });
        try { this.persist(); } catch (error) { this.reload(); throw error; }
      });
      this.retireBroker(id, true, 'This workspace was removed. Add its folders again to continue.');
      releaseHeld = true;
      this.emit('projects', { projectId: id });
      return { id, removed: true };
    } finally { try { if (held && releaseHeld) held(); } finally { lease.release(); } }
  }

  restore(id) {
    this.assertOpen(); let changed = false;
    const entry = withFileGuard(this.filename, () => {
      this.reload(); const previous = this.entry(id, true);
      if (!previous.removedAt) return previous;
      const { removedAt, ...restored } = previous;
      this.projects.set(id, restored); try { this.persist(); } catch (error) { this.reload(); throw error; }
      changed = true; return restored;
    });
    if (changed) this.emit('projects', { projectId: id });
    return this.public(entry);
  }

  // Adds one folder ({ path }) or several at once ({ folders }): all of them in one change, or none if any is not a
  // usable folder. Folders already in the workspace are left as they are.
  addFolder(id, input) {
    this.reload(); const entry = this.entry(id); const aliases = { ...entry.folderAliases }; const folders = [...entry.folders];
    const supplied = input?.folders === undefined ? [input] : input.folders;
    if (!Array.isArray(supplied) || !supplied.length || supplied.length > 32) throw fail('Choose between 1 and 32 folders to add.');
    for (const item of supplied) { const added = folderRecord(item, folders, aliases); if (!folders.some(folder => folder.id === added.id)) folders.push(added); }
    if (folders.length === entry.folders.length) return this.public(entry);
    if (folders.length > 32) throw fail('A workspace supports at most 32 folders.');
    return this.changeFolders(id, folders, aliases);
  }
  removeFolder(id, folderId) {
    this.reload(); const entry = this.entry(id);
    if (!entry.folders.some(folder => folder.id === folderId)) throw fail('Workspace folder not found.', 404);
    if (entry.folders.length === 1) throw fail('Keep at least one workspace folder. Add another folder before removing this one.');
    return this.changeFolders(id, entry.folders.filter(folder => folder.id !== folderId), { ...entry.folderAliases });
  }

  retireBroker(id, keepLock = false, message = 'Workspace folders changed. Refresh the project before continuing.') {
    const existing = this.brokers.get(id); if (!existing) return null;
    if (existing.broker.running || existing.broker.backgroundReview || existing.broker.tasks?.busy) throw fail('Stop the current run, tasks and background review before changing workspace folders.', 409);
    existing.broker.close().catch(() => {}); existing.broker.off('update', existing.update); if (existing.notify) existing.broker.off('notify', existing.notify);
    existing.broker.record = () => { throw fail(message, 409); };
    existing.broker.start = () => { throw fail(message, 409); };
    this.brokers.delete(id); if (!keepLock) existing.unlock(); return existing;
  }

  changeFolders(id, folders, aliases) {
    this.assertOpen(); this.reload(); const before = this.entry(id); const signature = rootsSignature(before.folders);
    if (this.hasRunningCommands?.(id)) throw fail('Stop the project commands before changing workspace folders.', 409);
    if (this.brokers.get(id)?.broker.running || this.brokers.get(id)?.broker.backgroundReview || this.brokers.get(id)?.broker.tasks?.busy) throw fail('Stop the current run and background review before changing workspace folders.', 409);
    const lease = this.mutations.acquireMany([...new Set([...before.folders, ...folders].map(folder => folder.path))], 'workspace-membership');
    let held = null; let releaseHeld = false;
    let changed;
    try {
      const cached = this.brokers.get(id); held = cached?.unlock || (this.lock ? acquireProjectLock(path.join(this.dataRoot, id)) : () => {}); releaseHeld = !cached;
      changed = withFileGuard(this.filename, () => {
        this.reload(); const previous = this.entry(id);
        if (rootsSignature(previous.folders) !== signature) throw fail('Workspace folders changed in another window. Refresh and retry.', 409);
        // Listeners snapshot OLD roots for approved patches before a primary change.
        this.emit('beforeFoldersChange', { projectId: id, workspace: { path: previous.path, folders: previous.folders.map(folder => ({ ...folder })) } });
        const next = { ...previous, folders, folderAliases: aliases, path: folders[0].path };
        this.projects.set(id, next); try { this.persist(); } catch (error) { this.reload(); throw error; }
        return next;
      });
      const retired = this.retireBroker(id, true);
      if (retired) { releaseHeld = true; this.openBroker(changed, held); held = null; releaseHeld = false; }
      this.emit('projects', { projectId: id }); return this.public(changed);
    } finally { try { if (held && releaseHeld) held(); } finally { lease.release(); } }
  }

  async withMutation(id, operationName, callback, { workspaces = null } = {}) {
    this.assertOpen(); this.reload(); const entry = this.entry(id);
    const operation = this.mutations.withMutations(workspaces || entry.folders.map(folder => folder.path), operationName, callback); this.activeMutations.add(operation);
    try { return await operation; } finally {
      this.activeMutations.delete(operation);
      // A task may have waited for a Git hook, patch or restore rather than another agent. Reconsider it after the lease
      // is released, including tasks in another workspace attached to the same repository.
      for (const { broker } of this.brokers.values()) {
        try { broker.tasks?.tickAll(); } catch (error) { console.error('Codeshi could not resume waiting tasks:', error.message); }
      }
    }
  }

  broker(id) {
    this.assertOpen(); this.reload(); const entry = this.entry(id); const existing = this.brokers.get(id);
    if (existing) {
      if (rootsSignature(existing.broker.workspaceFolders) === rootsSignature(entry.folders)) return existing.broker;
      this.retireBroker(id);
    }
    const unlock = this.lock ? acquireProjectLock(path.join(this.dataRoot, id)) : () => {};
    try { return this.openBroker(entry, unlock); } catch (error) { unlock(); throw error; }
  }

  openBroker(entry, unlock) {
    const paths = entry.folders.map(folder => folder.path);
    let broker;
    try { broker = new Broker({ workspace: entry.path, workspaces: paths, workspaceFolders: entry.folders, dataDir: path.join(this.dataRoot, entry.id), googleRoot: path.join(this.dataRoot, 'google'), bins: this.bins, handoffPreferences: () => this.handoffPreferences(), verificationCadence: () => this.verificationCadence(), contextLimit: () => this.contextLimit(), tests: { saved: () => this.testCommand?.(entry.id) ?? null, run: () => this.runTest(entry.id) }, acquireMutation: operation => this.mutations.acquireMany(paths, operation), acquireFolders: (folders, operation) => this.mutations.acquireMany(folders, operation), withFolders: (folders, operation, work) => this.mutations.withMutations(folders, operation, work) }); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw fail(`Project folder is unavailable: ${entry.path}. Restore it or update workspace folders.`, 404); if (['EACCES', 'EPERM'].includes(error.code)) throw fail(`Cannot access the project or saved conversation: ${entry.path}. Check permissions.`, 400); throw error; }
    broker.workspaces = paths; broker.workspaceFolders = entry.folders.map(folder => ({ ...folder }));
    const rawCreate = broker.create.bind(broker); const rawList = broker.list.bind(broker);
    broker._createConversation = rawCreate;
    broker.create = () => this.mainConversation(entry.id);
    broker.list = (options = {}) => { this.mainConversation(entry.id); return rawList().filter(conversation => options.archived ? conversation.id !== broker.mainConversationId : conversation.id === broker.mainConversationId); };
    broker.archivedConversations = () => broker.list({ archived: true });
    const update = ({ conversationId }) => this.emit('update', { projectId: entry.id, conversationId }); broker.on('update', update);
    // Notifications name the workspace, so the desktop app can say where work happened and open it.
    const notify = notice => this.emit('notify', { ...notice, projectId: entry.id, projectName: this.entry(entry.id)?.name || entry.name }); broker.on('notify', notify);
    this.brokers.set(entry.id, { broker, unlock, update, notify });
    try { this.mainConversation(entry.id); } catch (error) { broker.off('update', update); broker.off('notify', notify); this.brokers.delete(entry.id); throw error; }
    return broker;
  }

  mainConversation(id, options) {
    this.assertOpen(); const broker = this.broker(id); let changed = false;
    const conversationId = withFileGuard(this.filename, () => {
      this.reload(); const entry = this.entry(id);
      if (entry.conversationId) { if (!broker.conversations.has(entry.conversationId)) throw fail('The permanent conversation journal is missing. Restore the saved journal before continuing.', 409); return entry.conversationId; }
      const previous = [...broker.conversations.values()].sort((first, second) => String(second.updatedAt || '').localeCompare(String(first.updatedAt || '')) || first.id.localeCompare(second.id));
      const selected = previous[0]?.id || broker._createConversation().id;
      if (!previous.length && this.conversationDefaults?.()) broker.settings(broker.get(selected), this.conversationDefaults());
      this.projects.set(id, { ...entry, conversationId: selected }); try { this.persist(); } catch (error) { this.reload(); throw error; } changed = true; return selected;
    });
    broker.mainConversationId = conversationId;
    if (changed) this.emit('projects', { projectId: id });
    return broker.view(broker.get(conversationId), options);
  }

  close() {
    if (this.closePromise) return this.closePromise; this.closing = true;
    this.closePromise = (async () => {
      const entries = [...this.brokers]; const results = await Promise.allSettled(entries.map(([, entry]) => entry.broker.close())); await Promise.allSettled([...this.activeMutations]);
      for (let index = 0; index < entries.length; index++) if (results[index].status === 'fulfilled') { const [id, entry] = entries[index]; entry.broker.off('update', entry.update); entry.unlock(); this.brokers.delete(id); }
      const rejected = results.find(result => result.status === 'rejected'); if (rejected) throw rejected.reason;
    })(); return this.closePromise;
  }
}

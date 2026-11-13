import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { continuationRequest } from './context.mjs';
import { failedAttempts, fileHash, fileText, foldersInText, headOf, looksFailed, privatePath, revisionOf } from './task-context.mjs';
import { commandOutcome } from './tool-outcomes.mjs';

// Project memory (#21): what should outlive a single task, shared by every agent in a workspace. Entries are records in the
// conversation's journal, and nothing enters without the person's approval, so a file or a command can't plant an instruction.
// Suggestions come from local rules, with no model. They stay apart from the saved goal and decisions, because changing those
// cancels a pending handoff offer and a planned review.
export const MEMORY_KINDS = ['convention', 'decision', 'solution', 'failed-approach'];
const MAX_ENTRIES = 200, MAX_TEXT = 2000, SEND_BYTES = 4000, MAX_SUGGESTIONS = 8;
// What a memory rests on besides the files it names. Rules you set, conventions and decisions, hold until a file they name
// changes. Facts found in the code, working fixes and failed approaches, also need a recheck after a branch switch or a change
// to the dependencies of their folder. A commit by itself changes neither, and a version bump isn't a dependency change.
const FACT_KINDS = new Set(['solution', 'failed-approach']);
const MANIFEST_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'engines', 'packageManager', 'workspaces', 'require', 'require-dev', 'imports', 'scopes'];
const jsonManifest = text => { try { const data = JSON.parse(text); return JSON.stringify(MANIFEST_KEYS.map(key => [key, data?.[key] ?? null])); } catch { return text; } };
const OWN_TABLES = new Set(['package', 'project', 'tool.poetry', 'workspace.package']);
const tomlManifest = text => { let table = ''; return text.split(/\r?\n/).filter(line => { const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]/); if (header) table = header[1]; return !(OWN_TABLES.has(table) && /^\s*version\s*=/.test(line)); }).join('\n'); };
const asIs = text => text;
// Manifests at the top of a folder. Lock files are left out: they change on routine updates within the same ranges.
const MANIFESTS = { 'package.json': jsonManifest, 'composer.json': jsonManifest, 'deno.json': jsonManifest, 'Cargo.toml': tomlManifest, 'pyproject.toml': tomlManifest, 'pubspec.yaml': text => text.replace(/^version:.*$/gm, ''), 'go.mod': asIs, 'requirements.txt': asIs, 'Pipfile': asIs, 'Gemfile': asIs, 'Package.swift': asIs };
export function dependencyFingerprint(folder) {
  const found = {};
  for (const [name, read] of Object.entries(MANIFESTS)) {
    const text = fileText(folder, name);
    if (text !== null) found[name] = createHash('sha256').update(read(text)).digest('hex');
  }
  return found;
}
// Where an entry was saved: the folder's commit and branch, and its dependencies. Saving an edit counts as checking it again.
function groundsOf(folderId, folders) {
  const folder = folders.find(item => item.id === (folderId || folders[0]?.id));
  if (!folder) return { source: {}, dependencies: null };
  const commit = headOf(folder);
  return { source: commit ? { commit, revision: revisionOf(folder), folderId: folder.id } : {}, dependencies: { folderId: folder.id, files: dependencyFingerprint(folder) } };
}
export function editedEntry(entry, clean, folders) {
  const grounds = groundsOf(clean.folderId, folders), { commit, revision, folderId, ...source } = entry.source || {};
  return { ...clean, files: attachedFiles(clean.text, folders, clean.folderId), dependencies: grounds.dependencies, source: { ...source, ...grounds.source } };
}
const fail = message => Object.assign(new Error(message), { status: 400 });
const signature = entry => `${entry.id}:${entry.updatedAt}`;
const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'should', 'would', 'could', 'there', 'their', 'then', 'them', 'they', 'when', 'what', 'which', 'into', 'also', 'only', 'make', 'each', 'some', 'file', 'files', 'code', 'task', 'please', 'after', 'before', 'failed', 'error']);
const tokens = text => new Set((String(text || '').toLowerCase().match(/[a-z][\w$-]{3,}/g) || []).filter(word => !STOP_WORDS.has(word)));

// Files an entry names that exist now, so it can say when they have changed.
export function attachedFiles(text, folders, folderId = null) {
  const found = [], names = new Set(String(text || '').match(/[\w@.-]+(?:\/[\w@.-]+)+|[\w-]+\.[A-Za-z]\w{0,7}\b/g) || []);
  for (const name of [...names].slice(0, 20)) for (const folder of folders.filter(item => !folderId || item.id === folderId)) {
    const sha256 = fileHash(folder, name);
    if (sha256) found.push({ folderId: folder.id, path: name, sha256 });
  }
  return found.slice(0, 10);
}

export function cleanEntryInput(input = {}, folders = []) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw fail('Say what should be remembered.');
  if (text.length > MAX_TEXT) throw fail(`A memory can be at most ${MAX_TEXT.toLocaleString('en-US')} characters. Shorten it to what matters.`);
  if (!MEMORY_KINDS.includes(input.kind)) throw fail('Choose what kind of memory this is.');
  const folderId = input.folderId || null;
  if (folderId && !folders.some(folder => folder.id === folderId)) throw fail('That folder is no longer in this workspace.');
  return { text, kind: input.kind, folderId };
}

export function newEntry(input, folders, { now = new Date().toISOString() } = {}) {
  const clean = cleanEntryInput(input, folders), grounds = groundsOf(clean.folderId, folders);
  return { id: randomUUID(), ...clean, status: 'active', createdAt: now, updatedAt: now, files: attachedFiles(clean.text, folders, clean.folderId), dependencies: grounds.dependencies,
    source: { ...(typeof input.messageId === 'string' ? { messageId: input.messageId.slice(0, 200) } : {}), ...(typeof input.runId === 'string' ? { runId: input.runId.slice(0, 200) } : {}), ...grounds.source, suggested: input.suggested === true, ...(input.suggested === true && isSuggestionKey(input.suggestion) ? { suggestion: input.suggestion } : {}) } };
}

// Whether what an entry rests on has moved. It stays usable, but is no longer stated as fact.
export function entryState(entry, folders, cache = new Map()) {
  const current = (entry.files || []).map(file => {
    const folder = folders.find(item => item.id === file.folderId), key = file.folderId + '\0' + file.path;
    if (!cache.has(key)) cache.set(key, folder ? fileHash(folder, file.path) : null);
    return { ...file, current: cache.get(key) };
  });
  const changed = current.filter(file => file.current !== file.sha256).map(file => file.path);
  const folderGone = Boolean(entry.folderId) && !folders.some(folder => folder.id === entry.folderId);
  const fact = FACT_KINDS.has(entry.kind), savedBranch = entry.source?.revision?.branch ?? null;
  let currentBranch = null, branchChanged = false, dependenciesChanged = [];
  if (fact && entry.source?.revision) {
    const folder = folders.find(item => item.id === (entry.source.folderId || entry.folderId || folders[0]?.id)), key = 'revision\0' + folder?.id;
    if (!cache.has(key)) cache.set(key, folder ? revisionOf(folder) : null);
    currentBranch = cache.get(key)?.branch ?? null;
    branchChanged = savedBranch !== currentBranch;
  }
  const owner = fact && entry.dependencies?.files ? folders.find(item => item.id === entry.dependencies.folderId) : null;
  if (owner) {
    const key = 'dependencies\0' + owner.id;
    if (!cache.has(key)) cache.set(key, dependencyFingerprint(owner));
    const saved = entry.dependencies.files, now = cache.get(key);
    dependenciesChanged = [...new Set([...Object.keys(saved), ...Object.keys(now)])].filter(name => saved[name] !== now[name]).sort();
  }
  return { needsRecheck: changed.length > 0 || folderGone || branchChanged || dependenciesChanged.length > 0, changedFiles: changed, folderGone, branchChanged,
    ...(branchChanged ? { savedBranch, currentBranch } : {}), dependenciesChanged,
    validationHash: createHash('sha256').update(JSON.stringify({ files: current.map(file => [file.folderId, file.path, file.current]), branch: fact ? currentBranch : null, dependenciesChanged, folderGone })).digest('hex') };
}

export function memoryView(c, folders) {
  const cache = new Map();
  return { entries: (c.memory || []).map(entry => ({ ...entry, ...entryState(entry, folders, cache) })), suggestions: memorySuggestions(c, folders), limit: MAX_ENTRIES };
}

// What a task should be told. Conventions and decisions for its folders always qualify; a fix or a failed approach only when
// the task mentions what it is about. A session that resumes only hears what it hasn't been told.
export function memoryForTask(c, { words, scope, folders, fresh, provider, limit = SEND_BYTES }) {
  const wanted = tokens(words), named = String(words || '').toLowerCase(), delivered = new Set(!fresh && c.lastRun?.provider === provider ? c.lastRun.context?.memory || [] : []);
  const scored = [];
  for (const entry of c.memory || []) {
    if (entry.status !== 'active' || (entry.folderId && !scope.includes(entry.folderId))) continue;
    const shared = [...tokens(entry.text)].filter(word => wanted.has(word)).length, fileNamed = (entry.files || []).some(file => named.includes(file.path.toLowerCase()) || named.includes(file.path.split('/').pop().toLowerCase()));
    const standing = ['convention', 'decision'].includes(entry.kind);
    if (!standing && !shared && !fileNamed) continue;
    scored.push({ entry, score: (standing ? 2 : 0) + (fileNamed ? 3 : 0) + Math.min(shared, 3) });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
  const sent = [], ids = [], cache = new Map();
  let spent = 0, left = 0;
  for (const { entry } of scored) {
    const state = entryState(entry, folders, cache), version = signature(entry) + ':' + state.validationHash;
    if (delivered.has(version)) { ids.push(version); continue; }
    const folder = folders.find(item => item.id === entry.folderId);
    const item = { kind: entry.kind, text: entry.text, ...(folder ? { folder: folder.displayName || folder.name } : {}), savedAt: entry.createdAt, ...(entry.source?.commit ? { commit: entry.source.commit } : {}), ...(state.needsRecheck ? { needsRecheck: true, ...(state.branchChanged ? { branchChanged: true, savedOnBranch: state.savedBranch } : {}), ...(state.changedFiles.length ? { changedFiles: state.changedFiles } : {}), ...(state.dependenciesChanged.length ? { dependenciesChanged: state.dependenciesChanged } : {}) } : {}) };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (spent + size > limit) { left++; continue; }
    spent += size; sent.push(item); ids.push(version);
  }
  return { entries: sent, ids, left };
}

const suggestionKey = (kind, text) => createHash('sha256').update(`${kind}\0${text.trim().toLowerCase()}`).digest('hex').slice(0, 16);
export const isSuggestionKey = value => typeof value === 'string' && /^[\da-f]{16}$/.test(value);
const SAID = /\b(decision|convention)\s*:\s*([^\n]{8,400})/gi, REMEMBER = /\bremember (?:that |to )([^\n]{8,400})/gi, RULE = /^\s*(?:[-*]\s*)?((?:always|never)\s[^\n]{8,300})$/gim;
// Commands that check the work. Only these can show a fix: a build or a test that failed, then passed after edits.
const CHECKING = /\b(?:test|tests|spec|build|lint|check|typecheck|tsc|compile|pytest|jest|vitest|mocha|eslint|cargo|go (?:test|build|vet)|make|mvn|gradle|swift build|xcodebuild)\b/i;
const FIXES = 3;

// Files a step edited, as paths inside the workspace's folders. Paths outside them, and private files, are left out.
function editedFiles(message, folders) {
  const text = String(message.text || ''), found = [];
  const take = target => {
    if (typeof target !== 'string' || !target) return;
    const folder = path.isAbsolute(target) ? folders.find(item => target === item.path || target.startsWith(item.path + path.sep)) : folders[0];
    // Written with / on every system, so a memory reads the same on Windows and moves between computers unchanged.
    const relative = folder && (path.isAbsolute(target) ? path.relative(folder.path, target) : target).split(path.sep).join('/');
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !privatePath(relative)) found.push({ folderId: folder.id, path: relative });
  };
  if (text.startsWith('File changes: ')) { try { for (const change of JSON.parse(text.slice(14))) take(change.path); } catch { /* Not the usual shape. */ } }
  else if (/^(?:Edit|Write|MultiEdit|NotebookEdit)\n/.test(text)) { try { take(JSON.parse(text.split('\n')[1]).file_path); } catch { /* Cut short in the journal. */ } }
  return found;
}
// A working fix, found without a model: in one task, a checking command failed, files were edited, and the same command then
// finished without failing. It says what failed and which files the fix touched, not why it worked.
function workingFixes(messages, folders) {
  const fixes = [], fixed = new Set(), failures = new Map();
  for (const message of messages) {
    if (message.role !== 'activity') continue;
    for (const file of editedFiles(message, folders)) for (const failure of failures.values()) failure.edits.set(file.folderId + '\0' + file.path, file);
    const outcome = commandOutcome(message), command = outcome?.command?.trim();
    if (!command || command.length > 200 || !CHECKING.test(command) || fixed.has(command)) continue;
    if (outcome.failed) { if (!failures.has(command)) failures.set(command, { message, output: outcome.output, edits: new Map() }); continue; }
    const failure = failures.get(command);
    if (!failure || !(outcome.completed || outcome.output.trim())) continue;
    failures.delete(command);
    if (!failure.edits.size) continue; // Passing again with nothing changed is a flaky check, not a fix.
    const files = [...failure.edits.values()], owners = [...new Set(files.map(file => file.folderId))];
    const error = failure.output.split('\n').map(line => line.trim()).filter(Boolean).find(line => looksFailed(`$ ${command}\n${line}`)) || failure.output.trim().split('\n').at(-1) || '';
    const names = files.slice(0, 5).map(file => file.path).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
    fixed.add(command);
    fixes.push({ command, text: `\`${command}\` failed${error ? ` with “${error.slice(0, 160)}”` : ''}; it passed after changes to ${names}.`, folderId: owners.length === 1 ? owners[0] : null, message: failure.message });
  }
  return { fixes, fixed };
}

// Suggestions, worked out when asked for and never sent to an agent until accepted: what the person wrote themselves as a
// lasting rule, and, in a task whose tests later passed, the fixes that worked and the approaches that failed. Nothing else
// here counts as verified. Keeping one opens it for review first, and an entry kept from a suggestion remembers which, so
// the suggestion stays gone even when the text was edited.
export function memorySuggestions(c, folders) {
  const taken = new Set([...(c.memory || []).flatMap(entry => [suggestionKey(entry.kind, entry.text), entry.source?.suggestion].filter(Boolean)), ...(c.memoryDismissed || [])]), found = new Map();
  const add = (kind, text, message, folderId) => {
    const clean = text.trim().slice(0, MAX_TEXT), key = suggestionKey(kind, clean);
    if (taken.has(key) || found.has(key)) return;
    const seen = foldersInText(message?.text, folders);
    found.set(key, { key, kind, text: clean, folderId: folderId !== undefined ? folderId : seen.length === 1 ? seen[0] : null, messageId: message?.id || null, runId: message?.runId || null });
  };
  const said = (c.messages || []).filter(message => message.role === 'user' && !message.rewound && !message.imported && !message.retry && !message.reviewId && message.text && message.text !== continuationRequest).slice(-200).reverse();
  for (const message of said) {
    for (const match of message.text.matchAll(SAID)) add(match[1].toLowerCase(), match[2], message);
    for (const match of message.text.matchAll(REMEMBER)) add('convention', match[1], message);
    for (const match of message.text.matchAll(RULE)) add('convention', match[1], message);
  }
  const tasks = new Set();
  for (const run of [...(c.runs || [])].reverse()) {
    const task = run.taskId || run.id;
    if (run.check?.status !== 'passed' || tasks.has(task) || found.size >= MAX_SUGGESTIONS * 2) continue;
    tasks.add(task);
    const taskRuns = new Set((c.runs || []).filter(item => (item.taskId || item.id) === task).map(item => item.id));
    const messages = (c.messages || []).filter(message => taskRuns.has(message.runId));
    const { fixes, fixed } = workingFixes(messages, folders);
    for (const fix of fixes.slice(-FIXES)) add('solution', fix.text, fix.message, fix.folderId);
    // A command that was fixed later is a working fix, not a failed approach.
    for (const attempt of failedAttempts(messages, [])) if (attempt.source === 'step' && attempt.what !== run.check.command && !fixed.has(attempt.what.trim())) add('failed-approach', `${attempt.what}: ${attempt.how}`, messages.find(message => message.id === attempt.messageId));
  }
  return [...found.values()].slice(0, MAX_SUGGESTIONS);
}
export const memoryLimit = MAX_ENTRIES;

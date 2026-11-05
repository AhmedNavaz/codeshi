import { createHash, randomUUID } from 'node:crypto';
import { continuationRequest } from './context.mjs';
import { failedAttempts, fileHash, foldersInText, headOf } from './task-context.mjs';

// Project memory (#21): what should outlive a single task, shared by every agent in a workspace. Entries are records in the
// conversation's journal, and nothing enters without the person's approval, so a file or a command can't plant an instruction.
// Suggestions come from local rules, with no model. They stay apart from the saved goal and decisions, because changing those
// cancels a pending handoff offer and a planned review.
export const MEMORY_KINDS = ['convention', 'decision', 'solution', 'failed-approach'];
const MAX_ENTRIES = 200, MAX_TEXT = 2000, SEND_BYTES = 4000, MAX_SUGGESTIONS = 8;
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
  const clean = cleanEntryInput(input, folders), folder = folders.find(item => item.id === (clean.folderId || folders[0]?.id));
  const commit = folder ? headOf(folder) : null;
  return { id: randomUUID(), ...clean, status: 'active', createdAt: now, updatedAt: now, files: attachedFiles(clean.text, folders, clean.folderId),
    source: { ...(typeof input.messageId === 'string' ? { messageId: input.messageId.slice(0, 200) } : {}), ...(typeof input.runId === 'string' ? { runId: input.runId.slice(0, 200) } : {}), ...(commit ? { commit } : {}), suggested: input.suggested === true } };
}

// Whether what an entry rests on has moved. It stays usable, but is no longer stated as fact.
export function entryState(entry, folders) {
  const changed = (entry.files || []).filter(file => { const folder = folders.find(item => item.id === file.folderId); return !folder || fileHash(folder, file.path) !== file.sha256; }).map(file => file.path);
  const folderGone = Boolean(entry.folderId) && !folders.some(folder => folder.id === entry.folderId);
  return { needsRecheck: changed.length > 0 || folderGone, changedFiles: changed, folderGone };
}

export function memoryView(c, folders) {
  return { entries: (c.memory || []).map(entry => ({ ...entry, ...entryState(entry, folders) })), suggestions: memorySuggestions(c, folders), limit: MAX_ENTRIES };
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
  const sent = [], ids = [];
  let spent = 0, left = 0;
  for (const { entry } of scored) {
    if (delivered.has(signature(entry))) { ids.push(signature(entry)); continue; }
    const state = entryState(entry, folders), folder = folders.find(item => item.id === entry.folderId);
    const item = { kind: entry.kind, text: entry.text, ...(folder ? { folder: folder.displayName || folder.name } : {}), savedAt: entry.createdAt, ...(entry.source?.commit ? { commit: entry.source.commit } : {}), ...(state.needsRecheck ? { needsRecheck: true, ...(state.changedFiles.length ? { changedFiles: state.changedFiles } : {}) } : {}) };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (spent + size > limit) { left++; continue; }
    spent += size; sent.push(item); ids.push(signature(entry));
  }
  return { entries: sent, ids, left };
}

const suggestionKey = (kind, text) => createHash('sha256').update(`${kind}\0${text.trim().toLowerCase()}`).digest('hex').slice(0, 16);
const SAID = /\b(decision|convention)\s*:\s*([^\n]{8,400})/gi, REMEMBER = /\bremember (?:that |to )([^\n]{8,400})/gi, RULE = /^\s*(?:[-*]\s*)?((?:always|never)\s[^\n]{8,300})$/gim;

// Suggestions, worked out when asked for and never sent to an agent until accepted: what the person wrote themselves as a
// lasting rule, and approaches that failed in a task whose tests later passed. Nothing else here counts as verified.
export function memorySuggestions(c, folders) {
  const taken = new Set([...(c.memory || []).map(entry => suggestionKey(entry.kind, entry.text)), ...(c.memoryDismissed || [])]), found = new Map();
  const add = (kind, text, message) => {
    const clean = text.trim().slice(0, MAX_TEXT), key = suggestionKey(kind, clean);
    if (taken.has(key) || found.has(key)) return;
    const seen = foldersInText(message?.text, folders);
    found.set(key, { key, kind, text: clean, folderId: seen.length === 1 ? seen[0] : null, messageId: message?.id || null, runId: message?.runId || null });
  };
  const said = (c.messages || []).filter(message => message.role === 'user' && !message.imported && !message.retry && !message.reviewId && message.text && message.text !== continuationRequest).slice(-200).reverse();
  for (const message of said) {
    for (const match of message.text.matchAll(SAID)) add(match[1].toLowerCase(), match[2], message);
    for (const match of message.text.matchAll(REMEMBER)) add('convention', match[1], message);
    for (const match of message.text.matchAll(RULE)) add('convention', match[1], message);
  }
  for (const run of [...(c.runs || [])].reverse()) {
    if (run.check?.status !== 'passed' || found.size >= MAX_SUGGESTIONS * 2) continue;
    const taskRuns = new Set((c.runs || []).filter(item => (item.taskId || item.id) === (run.taskId || run.id)).map(item => item.id));
    const messages = (c.messages || []).filter(message => taskRuns.has(message.runId));
    for (const attempt of failedAttempts(messages, [])) if (attempt.source === 'step' && attempt.what !== run.check.command) add('failed-approach', `${attempt.what}: ${attempt.how}`, messages.find(message => message.id === attempt.messageId));
  }
  return [...found.values()].slice(0, MAX_SUGGESTIONS);
}
export const memoryLimit = MAX_ENTRIES;

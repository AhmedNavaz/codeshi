// Portable conversation files: one workspace conversation another Codeshi user can import and continue
// with their own Claude or Codex account. No filesystem, network or provider access.
import { randomUUID } from 'node:crypto';
import { byteLength, canonicalStringify, invalid, redactPublicText, scanSecrets, sha256 } from './collaboration-format.mjs';
import { validateContext } from './context.mjs';

export const CONVERSATION_SCHEMA = 'ai-relay.conversation';
export const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 5000, MAX_TEXT = 200000;
const agents = ['codex', 'claude', 'gemini'];

const clean = value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''));
const contextOf = context => { const value = validateContext(context || {}); return clean({ goal: value.goal, summary: value.summary, decisions: value.decisions.length ? value.decisions : undefined, tasks: value.tasks.length ? value.tasks : undefined }); };

// Workspace folders become "[name]" so paths stay meaningful; other secrets and local paths are removed.
function redactor(folders) {
  const roots = [...folders].sort((a, b) => b.path.length - a.path.length);
  return text => redactPublicText(roots.reduce((value, folder) => value.split(folder.path).join(`[${folder.displayName || folder.name}]`), String(text)));
}
// Counts the messages (and context fields) that contain each kind of sensitive text.
function findings(messages, context) {
  const places = { credential: new Set(), 'absolute-path': new Set() };
  for (const warning of scanSecrets({ messages: messages.map(message => message.text), context })) places[warning.code]?.add(warning.location);
  return { secrets: places.credential.size, localPaths: places['absolute-path'].size };
}

export function exportConversation(conversation, project, { range = 'all', activity = false, redact = true } = {}) {
  const roles = activity ? ['user', 'assistant', 'activity'] : ['user', 'assistant'];
  let source = conversation.messages.filter(message => roles.includes(message.role) && typeof message.text === 'string' && message.text.trim());
  const limit = Number.parseInt(range, 10);
  if (range !== 'all' && Number.isSafeInteger(limit) && limit > 0) source = source.slice(-limit);
  const transform = redact ? redactor(project.folders) : text => text;
  const rawContext = contextOf(conversation.context), found = findings(source, rawContext);
  const messages = source.map((message, index) => clean({
    id: String(message.id || index).slice(0, 128), role: message.role, text: transform(message.text).slice(0, MAX_TEXT),
    provider: message.role === 'user' ? undefined : agents.includes(message.provider) ? message.provider : 'codex',
    createdAt: Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toISOString() : undefined,
    model: typeof message.model === 'string' && message.model !== 'unknown' ? message.model.slice(0, 200) : undefined,
    connection: message.connection === 'local' ? 'local' : undefined,
  }));
  const context = redact ? JSON.parse(transform(JSON.stringify(rawContext))) : rawContext;
  const value = clean({ schema: CONVERSATION_SCHEMA, version: 1, id: randomUUID(), exportedAt: new Date().toISOString(), workspace: { name: project.name, folders: project.folders.map(folder => folder.displayName || folder.name) }, context: Object.keys(context).length ? context : undefined, messages, clipped: false });
  // Keep the most recent messages when the file would be too large to share and import.
  // Each message is measured once: the file's size is the size without messages plus theirs and the commas between them,
  // so it isn't serialized again after every drop.
  const maxBytes = MAX_CONVERSATION_BYTES - 1024, count = value.messages.length;
  if (count > 1 && byteLength(canonicalStringify(value)) > maxBytes) {
    const sizes = value.messages.map(message => byteLength(canonicalStringify(message)));
    let size = byteLength(canonicalStringify({ ...value, messages: [], clipped: true })) + sizes.reduce((sum, bytes) => sum + bytes, 0) + count - 1, drop = 0;
    do size -= sizes[drop++] + 1; while (count - drop > 1 && size > maxBytes);
    value.messages = value.messages.slice(drop); value.clipped = true;
  }
  const file = { ...value, digest: sha256(canonicalStringify(value)) };
  const times = messages.map(message => message.createdAt).filter(Boolean);
  return { package: file, stats: { messages: file.messages.length, omitted: source.length - file.messages.length, bytes: byteLength(JSON.stringify(file)), from: times[0] || null, to: times.at(-1) || null, providers: [...new Set(file.messages.map(message => message.provider).filter(Boolean))] }, findings: found, redacted: Boolean(redact) };
}

// Validates an untrusted conversation file and returns it in the importer's preview shape.
export function readConversationPackage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schema !== CONVERSATION_SCHEMA) throw invalid('This is not a Codeshi conversation file.');
  if (input.version !== 1) throw invalid('This conversation file needs a newer version of Codeshi.');
  if (byteLength(JSON.stringify(input)) > MAX_CONVERSATION_BYTES) throw invalid('This conversation file is larger than 2 MB.', 413);
  const { digest, ...value } = input;
  if (typeof digest !== 'string' || sha256(canonicalStringify(value)) !== digest) throw invalid('This conversation file was changed or damaged after it was exported.');
  if (typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id)) throw invalid('This conversation file has no valid identifier.');
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > MAX_MESSAGES) throw invalid(`A conversation file must contain between 1 and ${MAX_MESSAGES} messages.`);
  const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace : {};
  const title = typeof workspace.name === 'string' && workspace.name.trim() ? workspace.name.trim().slice(0, 120) : 'Shared conversation';
  const folders = Array.isArray(workspace.folders) ? workspace.folders.filter(name => typeof name === 'string' && name.trim()).slice(0, 32).map(name => name.trim().slice(0, 200)) : [];
  const messages = value.messages.map((message, index) => {
    if (!message || typeof message !== 'object' || !['user', 'assistant', 'activity'].includes(message.role)) throw invalid(`Message ${index + 1} has an unsupported role.`);
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > MAX_TEXT) throw invalid(`Message ${index + 1} has no valid text.`);
    if (message.role !== 'user' && !agents.includes(message.provider)) throw invalid(`Message ${index + 1} names an unsupported assistant.`);
    const createdAt = Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toISOString() : undefined;
    return clean({ sourceId: typeof message.id === 'string' && /^[\w:.-]{1,128}$/.test(message.id) ? message.id : String(index), role: message.role, text: message.text, provider: message.role === 'user' ? undefined : message.provider, model: typeof message.model === 'string' ? message.model.slice(0, 200) : undefined, connection: message.connection === 'local' ? 'local' : undefined, timestamp: createdAt });
  });
  const context = value.context === undefined ? null : contextOf(value.context);
  return { provider: 'file', sessionId: value.id, title, cwd: null, folders, exportedAt: Number.isFinite(Date.parse(value.exportedAt)) ? new Date(value.exportedAt).toISOString() : null, context: context && Object.keys(context).length ? context : null, clipped: value.clipped === true, messages, messageCount: messages.length, digest };
}

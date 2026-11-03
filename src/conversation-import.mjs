import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexClient } from './providers.mjs';
import { resolveBinary } from './resolve-binary.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const providers = ['codex', 'claude', 'gemini'];
const MAX_BYTES = 2 * 1024 * 1024;
function geminiFolderMatch(cwd, root) {
  const canonical = folder => { try { return fs.realpathSync.native(folder); } catch { return path.resolve(folder); } };
  const relative = path.relative(canonical(root), canonical(cwd));
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function readGeminiLog(filename, home, limit = MAX_BYTES) {
  const target = fs.realpathSync(filename);
  const allowed = ['antigravity', 'antigravity-cli', 'antigravity-ide'].some(name => {
    try { const root = fs.realpathSync(path.join(home, '.gemini', name, 'brain')); const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); } catch { return false; }
  });
  if (!allowed) fail('This transcript is outside the native conversation store.', 403);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile()) fail('This transcript is not a regular file.');
    const buffer = Buffer.alloc(limit + 1); let bytes = 0;
    while (bytes < buffer.length) { const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes); if (!count) break; bytes += count; }
    const clipped = bytes > limit || stat.size > limit; let content = buffer.subarray(0, Math.min(bytes, limit)).toString('utf8');
    if (clipped) content = content.slice(0, Math.max(0, content.lastIndexOf('\n')));
    return { content, clipped };
  } finally { fs.closeSync(fd); }
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isoTime = (value, scale = 1) => { const time = typeof value === 'number' ? value * scale : Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined; };
// The app's own runs, under its current name and the earlier ones, are not offered for import.
const ownPrompt = /You are working in (?:Codeshi|Throughline|AI Relay)/;
const relaySession = text => ownPrompt.test(String(text || ''));
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text').map(block => block.text || '').join('\n') : '';
// Claude Code saves slash commands and their local output as user turns; they are not part of the conversation.
const commandMarkup = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g;
export const conversationText = text => String(text || '').replace(commandMarkup, '').trim();
export function conversationTitle(input, fallback = 'Untitled conversation') {
  let text = conversationText(input) || fallback;
  if (ownPrompt.test(text)) {
    try { const envelope = JSON.parse(text.slice(text.indexOf('{'))); if (typeof envelope.currentRequest === 'string' && envelope.currentRequest.trim()) text = envelope.currentRequest; else text = 'Codeshi coding session'; }
    catch { text = 'Codeshi coding session'; }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function readGeminiSummaries(home = os.homedir()) {
  const dirs = ['antigravity', 'antigravity-cli', 'antigravity-ide'].map(name => path.join(home, '.gemini', name));
  const sessions = [];
  const seen = new Set();
  for (const dir of dirs) {
    const db = path.join(dir, 'conversation_summaries.db');
    if (fs.existsSync(db)) {
      try {
        const res = spawnSync(process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3', ['-init', process.platform === 'win32' ? 'NUL' : '/dev/null', '-readonly', '-json', db, 'SELECT conversation_id, title, preview, last_modified_time, workspace_uris FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1000;'], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, shell: false });
        if (res.status === 0 && res.stdout.trim()) {
          const rows = JSON.parse(res.stdout);
          for (const row of rows) {
            if (typeof row.conversation_id !== 'string' || !/^[\w-]{1,128}$/.test(row.conversation_id) || seen.has(row.conversation_id)) continue;
            seen.add(row.conversation_id);
            let uris = [];
            try { uris = JSON.parse(row.workspace_uris); } catch {}
            const cwds = (Array.isArray(uris) ? uris : []).flatMap(u => { try { const folder = typeof u === 'string' ? (u.startsWith('file://') ? fileURLToPath(u) : u) : ''; return path.isAbsolute(folder) ? [path.resolve(folder)] : []; } catch { return []; } });
            const updatedAt = Number.isFinite(Date.parse(row.last_modified_time)) ? new Date(row.last_modified_time).toISOString() : new Date().toISOString();
            sessions.push({
              id: row.conversation_id,
              title: conversationTitle(row.title || row.preview, 'Gemini conversation'),
              provider: 'gemini',
              updatedAt,
              cwds,
              folder: cwds[0] ? path.basename(cwds[0]) : 'Unknown folder',
              cwd: cwds[0] || null,
              baseDir: dir,
            });
          }
        }
      } catch {}
    }
    const brainDir = path.join(dir, 'brain');
    if (fs.existsSync(brainDir)) {
      try {
        const subdirs = fs.readdirSync(brainDir);
        for (const sub of subdirs) {
          if (!/^[\w-]{1,128}$/.test(sub) || seen.has(sub)) continue;
          const transcriptPath = path.join(brainDir, sub, '.system_generated/logs/transcript.jsonl');
          if (fs.existsSync(transcriptPath)) {
            seen.add(sub);
            try {
              const stat = fs.statSync(transcriptPath);
              const { content: text } = readGeminiLog(transcriptPath, home, 4096);
              const firstLine = text.split('\n')[0];
              let title = 'Gemini conversation', time = stat.mtime.toISOString();
              try {
                const parsed = JSON.parse(firstLine);
                if (parsed.created_at) time = new Date(parsed.created_at).toISOString();
                if (parsed.content) {
                  const m = parsed.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                  title = conversationTitle(m ? m[1] : parsed.content, 'Gemini conversation');
                }
              } catch {}
              sessions.push({
                id: sub,
                title,
                provider: 'gemini',
                updatedAt: time,
                cwds: [],
                folder: 'Gemini conversation',
                cwd: null,
                baseDir: dir,
              });
            } catch {}
          }
        }
      } catch {}
    }
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export class ConversationImporter {
  constructor({ clientFactory = options => new CodexClient(options), sdkLoader = () => import('@anthropic-ai/claude-agent-sdk'), codexBin = () => resolveBinary('codex'), geminiHome = () => os.homedir() } = {}) {
    this.clientFactory = clientFactory;
    this.sdkLoader = sdkLoader;
    this.codexBin = codexBin;
    this.geminiHome = geminiHome;
  }
  async withCodex(workspace, fn) {
    const bin = this.codexBin(); if (!bin) fail('Install Codex CLI to browse its conversations.', 503);
    const client = this.clientFactory({ bin, cwd: workspace });
    try { await client.initialize(); return await fn(client); } finally { client.close(); }
  }
  // Without folders, lists conversations from every project on this computer (newest first), excluding Codeshi's own runs.
  async list(provider, folders, { cursor } = {}) {
    if (!providers.includes(provider)) fail('Choose Codex, Claude or Gemini.');
    if (!folders) return this.discover(provider, { cursor });
    const roots = folders.map(folder => path.resolve(folder.path));
    if (provider === 'gemini') {
      const all = readGeminiSummaries(this.geminiHome());
      const sessions = all.filter(session => {
        if (!session.cwds?.length) return false;
        return session.cwds.some(cwd => roots.some(root => geminiFolderMatch(cwd, root)));
      }).map(session => { const cwd = session.cwds.find(cwd => roots.some(root => geminiFolderMatch(cwd, root))); return ({
        id: session.id,
        title: session.title,
        provider: 'gemini',
        updatedAt: session.updatedAt,
        folder: folders[roots.findIndex(root => geminiFolderMatch(cwd, root))]?.displayName || session.folder,
        cwd,
      }); });
      return { sessions: sessions.slice(0, 100), nextCursor: null };
    }
    if (provider === 'codex') return this.withCodex(roots[0], async client => {
      const result = await client.request('thread/list', { cwd: roots, limit: 50, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer', 'exec'], ...(cursor ? { cursor } : {}) });
      return { sessions: (result.data || []).filter(row => roots.includes(path.resolve(row.cwd || '')) && !relaySession(row.preview) && !relaySession(row.name)).map(row => ({ id: row.id, title: conversationTitle(row.name || row.preview, 'Codex conversation'), provider, updatedAt: new Date((row.updatedAt || row.createdAt) * 1000).toISOString(), folder: folders[roots.indexOf(path.resolve(row.cwd))]?.displayName || path.basename(row.cwd), cwd: row.cwd })), nextCursor: result.nextCursor || null };
    });
    const sdk = await this.sdkLoader(), sessions = [];
    for (const folder of folders) {
      const rows = await sdk.listSessions({ dir: folder.path, limit: 50, includeWorktrees: false, includeProgrammatic: false });
      for (const row of rows) {
        if (row.cwd && !roots.includes(path.resolve(row.cwd))) continue;
        if (!sessions.some(item => item.id === row.sessionId)) sessions.push({ id: row.sessionId, title: conversationTitle(row.customTitle || row.summary || row.firstPrompt, 'Claude conversation'), provider, updatedAt: new Date(row.lastModified).toISOString(), folder: folder.displayName || folder.name, cwd: row.cwd || folder.path });
      }
    }
    return { sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100), nextCursor: null };
  }
  async discover(provider, { cursor } = {}) {
    const row = (id, title, updatedAt, cwd) => ({ id, title, provider, updatedAt, cwd: cwd || null, folder: cwd ? path.basename(cwd) : 'Unknown folder' });
    if (provider === 'gemini') {
      const all = readGeminiSummaries(this.geminiHome());
      const offset = Number.parseInt(cursor || '0', 10) || 0, limit = 50;
      const page = all.slice(offset, offset + limit).map(session => row(session.id, session.title, session.updatedAt, session.cwd));
      return { sessions: page, nextCursor: all.length > offset + limit ? String(offset + limit) : null };
    }
    if (provider === 'codex') return this.withCodex(os.homedir(), async client => {
      const result = await client.request('thread/list', { limit: 50, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer', 'exec'], ...(cursor ? { cursor } : {}) });
      return { sessions: (result.data || []).filter(thread => !relaySession(thread.preview) && !relaySession(thread.name)).map(thread => row(thread.id, conversationTitle(thread.name || thread.preview, 'Codex conversation'), new Date((thread.updatedAt || thread.createdAt) * 1000).toISOString(), thread.cwd)), nextCursor: result.nextCursor || null };
    });
    const sdk = await this.sdkLoader(), offset = Number.parseInt(cursor || '0', 10) || 0, limit = 50;
    // Programmatic sessions include Codeshi's own Claude runs.
    const rows = await sdk.listSessions({ limit, offset, includeProgrammatic: false });
    return { sessions: rows.map(session => row(session.sessionId, conversationTitle(session.customTitle || session.summary || session.firstPrompt, 'Claude conversation'), new Date(session.lastModified).toISOString(), session.cwd)), nextCursor: rows.length === limit ? String(offset + limit) : null };
  }
  // Without folders the conversation may come from any project; its folder is returned as cwd.
  async preview(provider, sessionId, folders) {
    if (!providers.includes(provider) || typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)) fail('Choose a valid conversation.');
    const roots = folders?.map(folder => path.resolve(folder.path));
    let messages = [], title = '', clipped = false, cwd = null;
    if (provider === 'codex') await this.withCodex(roots?.[0] || os.homedir(), async client => {
      const { thread } = await client.request('thread/read', { threadId: sessionId });
      if (roots && !roots.includes(path.resolve(thread.cwd || ''))) fail('This conversation belongs to a different workspace.', 403);
      cwd = thread.cwd || null;
      title = conversationTitle(thread.name || thread.preview, 'Codex conversation');
      let cursor;
      for (let page = 0; page < 10; page++) {
        let result;
        try { result = await client.request('thread/turns/list', { threadId: sessionId, itemsView: 'full', sortDirection: 'desc', limit: 50, ...(cursor ? { cursor } : {}) }); }
        catch (error) {
          if (page || !/method|unsupported|not found/i.test(error.message)) throw error;
          const full = await client.request('thread/read', { threadId: sessionId, includeTurns: true });
          result = { data: [...(full.thread.turns || [])].reverse() };
        }
        const turns = [];
        for (const turn of [...(result.data || [])].reverse()) for (const item of turn.items || []) {
          const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : null;
          const text = role === 'user' ? conversationText(textOf(item.content)) : item.text;
          const timestamp = isoTime(role === 'user' ? turn.startedAt : turn.completedAt || turn.startedAt, 1000);
          if (role && typeof text === 'string' && text.trim()) turns.push({ sourceId: String(item.id || digest([turn.id, role, text])), role, text, ...(turn.model ? { model: turn.model } : {}), ...(timestamp ? { timestamp } : {}) });
        }
        messages.unshift(...turns); cursor = result.nextCursor;
        if (!cursor) break;
        if (page === 9 || Buffer.byteLength(JSON.stringify(messages)) > MAX_BYTES) { clipped = true; break; }
      }
    });
    else if (provider === 'gemini') {
      const home = this.geminiHome();
      const candidates = [
        path.join(home, '.gemini/antigravity/brain', sessionId, '.system_generated/logs/transcript.jsonl'),
        path.join(home, '.gemini/antigravity-cli/brain', sessionId, '.system_generated/logs/transcript.jsonl'),
        path.join(home, '.gemini/antigravity-ide/brain', sessionId, '.system_generated/logs/transcript.jsonl'),
      ];
      const transcriptFile = candidates.find(p => fs.existsSync(p));
      if (!transcriptFile) fail(folders ? 'This conversation was not found in the attached workspace folders.' : 'This conversation was not found.', 404);
      const allSummaries = readGeminiSummaries(home);
      const summary = allSummaries.find(s => s.id === sessionId);
      cwd = roots ? summary?.cwds?.find(cwd => roots.some(root => geminiFolderMatch(cwd, root))) || null : summary?.cwd || null;
      title = summary?.title || 'Gemini conversation';
      if (roots && !cwd) {
        fail('This conversation belongs to a different workspace.', 403);
      }
      const read = readGeminiLog(transcriptFile, home); clipped = read.clipped;
      const content = read.content;
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
            let text = step.content || '';
            const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (m) text = m[1].trim();
            else text = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
            if (text) {
              if (messages.length === 1000) { clipped = true; break; }
              const timestamp = isoTime(step.created_at);
              messages.push({ sourceId: `step-${step.step_index}-user`, role: 'user', text, ...(timestamp ? { timestamp } : {}) });
            }
          } else if (step.type === 'PLANNER_RESPONSE' && typeof step.content === 'string' && step.content.trim()) {
            if (messages.length === 1000) { clipped = true; break; }
            const timestamp = isoTime(step.created_at);
            messages.push({ sourceId: `step-${step.step_index}-model`, role: 'assistant', text: step.content.trim(), provider: 'gemini', ...(timestamp ? { timestamp } : {}) });
          }
        } catch {}
      }
      if (!title || title === 'Gemini conversation') {
        const firstUser = messages.find(m => m.role === 'user');
        if (firstUser) title = conversationTitle(firstUser.text, 'Gemini conversation');
      }
    }
    else {
      const sdk = await this.sdkLoader();
      let found;
      if (!folders) { const info = await sdk.getSessionInfo(sessionId, {}); if (info) found = { info, dir: null }; }
      else for (const folder of folders) { const info = await sdk.getSessionInfo(sessionId, { dir: folder.path }); if (info && (!info.cwd || roots.includes(path.resolve(info.cwd)))) { found = { info, dir: folder.path }; break; } }
      if (!found) fail(folders ? 'This conversation was not found in the attached workspace folders.' : 'This conversation was not found.', 404);
      cwd = found.info.cwd || found.dir || null;
      title = conversationTitle(found.info.customTitle || found.info.summary, 'Claude conversation');
      // The SDK's limit keeps the oldest messages, so read them all and walk back from the newest.
      const rows = await sdk.getSessionMessages(sessionId, found.dir ? { dir: found.dir } : {});
      for (const row of rows.toReversed()) {
        if (!['user', 'assistant'].includes(row.type) || row.parent_tool_use_id) continue;
        const raw = textOf(typeof row.message === 'string' ? row.message : row.message?.content), text = row.type === 'user' ? conversationText(raw) : raw;
        if (!text.trim()) continue;
        if (messages.length === 1000) { clipped = true; break; }
        const timestamp = isoTime(row.timestamp);
        messages.unshift({ sourceId: row.uuid || digest([row.type, text]), role: row.type, text, ...(row.message?.model ? { model: row.message.model } : {}), ...(timestamp ? { timestamp } : {}) });
      }
    }
    // Drop the oldest messages until the list fits. Each message is measured once: the list's size is its messages' sizes,
    // the commas between them and the brackets, so it isn't serialized again after every drop.
    const sizes = messages.map(message => Buffer.byteLength(JSON.stringify(message)));
    let size = 2 + sizes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, messages.length - 1), drop = 0;
    while (messages.length - drop > 1000 || size > MAX_BYTES) size -= sizes[drop++] + (messages.length - drop > 0 ? 1 : 0);
    if (drop) { messages.splice(0, drop); clipped = true; }
    if (!messages.length) fail('This conversation has no importable text messages.', 422);
    const value = { provider, sessionId, title, cwd, messages, clipped };
    return { ...value, digest: digest(value), messageCount: messages.length };
  }
}

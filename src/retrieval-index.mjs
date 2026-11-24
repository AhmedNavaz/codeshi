import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stem } from './request-words.mjs';
import { gitExecutable } from './resolve-binary.mjs';

// A saved index of each folder's files and the names they define (#85), so a fresh agent's brief can point at the file a
// request means without a search of the whole folder on every prompt. It lives in Codeshi's data folder next to the
// journal, one file per folder, and holds paths, sizes, change times and definition names with their lines: never file
// text. It is a locator, not evidence. Every excerpt is read from the file as it is now, and a definition no longer on
// its line sends that file to be read again, so an edit, a branch change or a deleted file can't put stale code in a prompt.
const VERSION = 1, LIST_LIMIT_MS = 2000, MAX_FILES = 20000, MAX_FILE_BYTES = 512 * 1024, MAX_READ_BYTES = 48 * 1024 * 1024, MAX_DEFINITIONS = 300, REFRESH_MS = 2000;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|m|mm|cs|php|scala|sh|bash|zsh|css|scss|less|html|vue|svelte|astro|md|mdx|sql|ya?ml|toml|json)$/i;
const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|m|mm|cs|php|scala|sh|bash|zsh|vue|svelte|astro)$/i;
const NAME = '[A-Za-z_$][\\w$]*';
const DEFINITIONS = [
  new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${NAME})`),
  new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${NAME})\\s*[=:]`),
  new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${NAME})`),
  new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum)\\s+(${NAME})`),
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/,
  // A method in a class body: a name, its parameters and a brace, indented, and not a keyword.
  new RegExp(`^\\s{2,4}(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?(${NAME})\\s*\\([^)]*\\)\\s*\\{\\s*$`),
];
// "test" in a request is more often a verb than a request for the tests, so it never makes a file name match.
const TEST_WORDS = new Set(['test', 'tests', 'spec']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try', 'with']);
const sha = text => createHash('sha256').update(text).digest('hex');

export function definitionsIn(text) {
  const found = [];
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length && found.length < MAX_DEFINITIONS; index++) {
    const line = lines[index];
    if (line.length > 400) continue;
    for (const pattern of DEFINITIONS) {
      const name = line.match(pattern)?.[1];
      if (name && !KEYWORDS.has(name)) { found.push([name, index + 1]); break; }
    }
  }
  return found;
}

// The words a file's path is made of, with their endings folded as in a request: src/github-signin.mjs is src, github,
// signin and mjs; providerAccounts is provider and account.
export const pathWords = relative => relative.split(/[\\/._\-\s]+|(?<=[a-z\d])(?=[A-Z])/).map(word => word.toLowerCase()).filter(word => word.length >= 3).map(stem);

export class RetrievalIndex {
  constructor(directory, { privatePath = () => false } = {}) { this.directory = directory; this.privatePath = privatePath; this.folders = new Map(); }

  file(folder) { return path.join(this.directory, `${sha(`${folder.id || ''}\0${folder.path}`).slice(0, 24)}.json`); }

  // The folder's index, brought up to date. Null when the folder isn't a Git working tree or can't be listed in time;
  // callers then search the way they did before the index.
  for(folder) {
    const key = `${folder.id || ''}\0${folder.path}`, held = this.folders.get(key);
    if (held && Date.now() - held.checkedAt < REFRESH_MS) return held.view;
    let saved = held?.data || null;
    if (!saved) { try { const value = JSON.parse(fs.readFileSync(this.file(folder), 'utf8')); if (value.version === VERSION && value.folder === folder.path) saved = value; } catch { /* None yet. */ } }
    const listed = spawnSync(gitExecutable(), ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd: folder.path, encoding: 'utf8', timeout: LIST_LIMIT_MS, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (listed.status !== 0) { this.folders.delete(key); return null; }
    const previous = saved?.files || {}, files = {};
    let read = 0, changed = false, partial = false;
    const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))];
    if (paths.length > MAX_FILES) partial = true;
    for (const relative of paths.slice(0, MAX_FILES)) {
      if (this.privatePath(relative) || !SOURCE.test(relative)) continue;
      let stat;
      try { stat = fs.lstatSync(path.join(folder.path, relative)); } catch { continue; }
      if (!stat.isFile()) continue;
      const stamp = `${stat.size}:${Math.trunc(stat.mtimeMs)}`, before = previous[relative];
      if (before?.stamp === stamp) { files[relative] = before; continue; }
      changed = true;
      if (!CODE.test(relative) || stat.size > MAX_FILE_BYTES || read + stat.size > MAX_READ_BYTES) { files[relative] = { stamp, defs: [] }; if (CODE.test(relative) && stat.size <= MAX_FILE_BYTES) partial = true; continue; }
      let text = '';
      try { text = fs.readFileSync(path.join(folder.path, relative), 'utf8'); } catch { continue; }
      read += stat.size;
      files[relative] = { stamp, defs: definitionsIn(text) };
    }
    if (Object.keys(previous).some(relative => !files[relative])) changed = true;
    const data = { version: VERSION, folder: folder.path, updatedAt: changed || !saved ? new Date().toISOString() : saved.updatedAt, ...(partial ? { partial: true } : {}), files };
    if (changed || !saved) {
      try {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const target = this.file(folder), temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(temporary, target);
      } catch { /* The index still works from memory this time. */ }
    }
    const view = viewOf(data);
    this.folders.set(key, { data, view, checkedAt: Date.now() });
    return view;
  }

  // A file found not to match its index, as when a definition moved: it is read again on the next lookup.
  forget(folder, relative) {
    const held = this.folders.get(`${folder.id || ''}\0${folder.path}`);
    if (held?.data.files[relative]) { held.data.files[relative] = { ...held.data.files[relative], stamp: 'stale' }; held.checkedAt = 0; }
  }
}

function viewOf(data) {
  const paths = Object.keys(data.files), definitions = new Map(), words = new Map();
  for (const [relative, entry] of Object.entries(data.files)) {
    for (const [name, line] of entry.defs) { if (!definitions.has(name)) definitions.set(name, []); definitions.get(name).push({ path: relative, line }); }
    for (const word of new Set(pathWords(relative))) words.set(word, (words.get(word) || 0) + 1);
  }
  return {
    paths, partial: Boolean(data.partial),
    // A file named by its name or the end of its path, as people write them: routing.js for public/routing.js.
    named: token => { const tail = '/' + token.replace(/^\.?\//, ''); return paths.filter(relative => ('/' + relative).endsWith(tail)); },
    // Where a name is defined. A definition in a test or an example comes after one in the code.
    defined: name => (definitions.get(name) || []).slice().sort((a, b) => Number(/(?:^|\/)(?:test|tests|__tests__|spec|examples?)\/|\.(?:test|spec)\./.test(a.path)) - Number(/(?:^|\/)(?:test|tests|__tests__|spec|examples?)\/|\.(?:test|spec)\./.test(b.path))),
    // Files whose path shares at least two telling words with the request. A word most paths share says nothing.
    matching: (wanted, limit = 3) => {
      const common = Math.max(3, Math.ceil(paths.length * 0.05)), scored = [];
      for (const relative of paths) {
        const matched = [...new Set(pathWords(relative))].filter(word => wanted.has(word) && words.get(word) <= common && !TEST_WORDS.has(word));
        if (matched.length >= 2) scored.push({ path: relative, matched, depth: relative.split('/').length });
      }
      return scored.sort((a, b) => b.matched.length - a.matched.length || a.depth - b.depth || a.path.localeCompare(b.path)).slice(0, limit);
    },
  };
}

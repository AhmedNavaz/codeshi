import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { continuationRequest } from './context.mjs';
import { gitExecutable } from './resolve-binary.mjs';
import { privatePath } from './task-context.mjs';

// Skills (#86): reusable procedures in the Agent Skills format (a folder with a SKILL.md), which follow a task when its agent
// changes. A skill is a procedure; which agent carries it out is a separate choice.
//
// Finding a skill only reads its SKILL.md, and nothing in a skill is ever run by Codeshi. Enabling takes a private copy, so a
// skill stays at the version you saw until you accept an update, and your own files are never touched. Agents get the names and
// descriptions, and the full instructions only for a task that needs them. All three agents get a skill as instructions in
// the prompt, so what relies on one agent's own skill system is listed as unavailable rather than pretended. A skill can't
// change access, approvals or billing, because those aren't decided by anything in a prompt.
const here = path.dirname(fileURLToPath(import.meta.url));
export const STARTER_ROOT = path.join(here, '..', 'starter-skills');
const SKILL_FILE_BYTES = 64 * 1024, RESOURCE_BYTES = 1024 * 1024, RESOURCE_FILES = 50, BODY_BYTES = 16000, BODY_TOTAL = 24000, CATALOG_BYTES = 3000, MATCH_WORDS = 3;
const REPO_FOLDERS = ['.agents/skills', '.claude/skills', '.codex/skills', '.gemini/skills'];
const NATIVE_FIELDS = { hooks: 'hooks', context: 'running in its own context', agent: 'a chosen subagent', model: 'a chosen model', 'disable-model-invocation': 'invocation rules', 'user-invocable': 'invocation rules', 'argument-hint': 'arguments' };
const fail = (message, status = 400, details) => Object.assign(new Error(message), { status, ...(details ? { details } : {}) });
const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'when', 'what', 'which', 'into', 'also', 'only', 'make', 'each', 'some', 'file', 'files', 'code', 'task', 'please', 'after', 'before', 'them', 'they', 'then', 'have', 'will', 'should', 'would', 'could', 'used', 'using', 'working', 'need', 'needs', 'changes', 'change', 'work']);
const words = text => new Set((String(text || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter(word => !STOP_WORDS.has(word)));

// The part of YAML that SKILL.md frontmatter uses: plain and quoted values, block text, and a one-level map. Anything else
// is kept as present, so a feature can be named as unavailable without being understood.
function parseFrontmatter(source) {
  const result = {}, lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match, nested = [];
    while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || lines[index + 1].trim() === '')) nested.push(lines[++index]);
    if (/^[|>][+-]?$/.test(raw.trim())) { const text = nested.map(item => item.trim()); result[key] = raw.trim().startsWith('|') ? text.join('\n').trim() : text.join(' ').trim(); continue; }
    if (raw.trim()) { const value = raw.trim(); result[key] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value; continue; }
    const map = {};
    for (const item of nested) { const pair = item.match(/^\s+([\w.-]+):\s*(.*)$/); if (pair) map[pair[1]] = pair[2].trim().replace(/^(['"])(.*)\1$/, '$2'); }
    result[key] = Object.keys(map).length ? map : nested.length ? true : '';
  }
  return result;
}
export function parseSkill(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!match) throw fail('SKILL.md must start with frontmatter between --- lines.');
  return { frontmatter: parseFrontmatter(match[1].replace(/\r\n/g, '\n')), body: match[2].trim() };
}
export function validateSkill({ frontmatter }, folderName) {
  const { name, description, compatibility } = frontmatter, problems = [];
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push('name must be up to 64 lowercase letters, numbers and single hyphens');
  else if (name !== folderName) problems.push(`name "${name}" must match its folder "${folderName}"`);
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) problems.push('description must be 1 to 1,024 characters');
  if (compatibility !== undefined && (typeof compatibility !== 'string' || compatibility.length > 500)) problems.push('compatibility can be at most 500 characters');
  return problems;
}

const onPath = tool => (process.env.PATH || '').split(path.delimiter).some(folder => { try { fs.accessSync(path.join(folder, tool), fs.constants.X_OK); return true; } catch { return false; } });
// What this skill relies on that a prompt can't provide, for each agent. All three use the same instructions-only route today.
export function compatibilityOf({ frontmatter, body }, files = []) {
  const unavailable = [];
  if (files.some(file => file.startsWith('scripts/'))) unavailable.push({ feature: 'scripts', detail: 'Codeshi never runs its scripts. An agent may run them with its own tools, under your approvals.', blocking: false });
  if (frontmatter['allowed-tools']) unavailable.push({ feature: 'allowed-tools', detail: 'Not applied: your access setting and approvals still decide what runs.', blocking: false });
  for (const [field, name] of Object.entries(NATIVE_FIELDS)) if (frontmatter[field] !== undefined) unavailable.push({ feature: field, detail: `Relies on ${name} from one agent's own skill system, which isn't available here.`, blocking: field === 'hooks' });
  if (/\$ARGUMENTS|\$\{CLAUDE_[A-Z_]+\}|\$[0-9]\b/.test(body)) unavailable.push({ feature: 'substitutions', detail: 'Its placeholders stay as written, because nothing fills them in here.', blocking: true });
  if (/!`[^`]+`/.test(body)) unavailable.push({ feature: 'command output', detail: 'Its !`command` lines are not run, so the output they expect is missing.', blocking: true });
  const tools = [...String(frontmatter['allowed-tools'] || '').matchAll(/Bash\(([\w.-]+)[:\s)]/g)].map(match => match[1]), missing = [...new Set(tools)].filter(tool => !onPath(tool));
  if (missing.length) unavailable.push({ feature: 'tools', detail: `Needs ${missing.join(', ')}, not found on this computer.`, blocking: true });
  return { route: 'instructions', adapters: { claude: 'instructions', codex: 'instructions', gemini: 'instructions' }, unavailable, blocking: unavailable.some(item => item.blocking) };
}

// A skill's files, refusing anything that leads outside it. Symbolic links are never followed.
function skillFiles(directory) {
  const files = [], root = fs.realpathSync(directory);
  let total = 0;
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw fail(`${name} is a link. A skill's files must be inside its folder.`);
      if (entry.isDirectory()) { if (entry.name === '.git' || entry.name === 'node_modules') continue; walk(name); continue; }
      if (!entry.isFile()) continue;
      if (privatePath(name)) throw fail(`${name} looks private, so it isn't copied with the skill.`);
      total += fs.statSync(path.join(root, name)).size;
      if (files.length >= RESOURCE_FILES || total > RESOURCE_BYTES) throw fail(`This skill is larger than ${RESOURCE_FILES} files or 1 MB.`);
      files.push(name.split(path.sep).join('/'));
    }
  };
  walk('');
  return files.sort();
}
function versionOf(directory, files) {
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(path.join(directory, file))); hash.update('\0'); }
  return hash.digest('hex');
}
const revisionOf = directory => { const result = spawnSync(gitExecutable(), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--short', 'HEAD'], { cwd: directory, encoding: 'utf8', timeout: 400 }); return result.status === 0 ? result.stdout.trim() : null; };

// Reads a skill's metadata. Nothing else in it is opened, and a broken one is listed with what is wrong.
function readSkill(directory, source) {
  const folderName = path.basename(directory), base = { folder: folderName, path: directory, source };
  try {
    const stat = fs.lstatSync(path.join(directory, 'SKILL.md'));
    if (!stat.isFile()) throw fail('SKILL.md is not a regular file.');
    if (stat.size > SKILL_FILE_BYTES) throw fail('SKILL.md is larger than 64 KB.');
    const parsed = parseSkill(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')), problems = validateSkill(parsed, folderName);
    const { name, description, license = null, compatibility = null } = parsed.frontmatter;
    if (problems.length) return { ...base, name: typeof name === 'string' ? name : folderName, problems };
    const files = skillFiles(directory);
    return { ...base, name, description: description.trim(), license, compatibilityNote: compatibility, compatibility: compatibilityOf(parsed, files), version: versionOf(directory, files), problems: [] };
  } catch (error) { return { ...base, name: folderName, problems: [error.message] }; }
}
function listRoot(root, source) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && fs.existsSync(path.join(root, entry.name, 'SKILL.md'))).slice(0, 200).map(entry => readSkill(path.join(root, entry.name), source));
}

export class SkillCatalog {
  constructor(broker) { this.broker = broker; this.root = path.join(broker.dataDir, 'skills'); }

  // Everything that could be enabled: the starter set, each folder's own skills, and folders you added.
  available(c) {
    const found = [...listRoot(STARTER_ROOT, { kind: 'starter' })];
    for (const folder of this.broker.workspaceFolders) for (const relative of REPO_FOLDERS) found.push(...listRoot(path.join(folder.path, relative), { kind: 'repository', folder: folder.displayName || folder.name }));
    for (const directory of c.skillDirs || []) found.push(...listRoot(directory, { kind: 'folder', folder: directory }));
    return found;
  }
  view(c) {
    const enabled = c.skills || [], found = this.available(c), sameName = name => found.filter(item => item.name === name);
    return {
      dirs: c.skillDirs || [],
      enabled: enabled.map(skill => {
        const source = found.find(item => item.path === skill.sourcePath);
        return { ...skill, sourceMissing: !source && !skill.provenance, updateAvailable: Boolean(source?.version && source.version !== skill.version && !skill.pinned) };
      }),
      available: found.filter(item => !enabled.some(skill => skill.sourcePath === item.path)).map(item => ({ ...item, conflict: sameName(item.name).length > 1 || enabled.some(skill => skill.name === item.name) })),
    };
  }
  snapshot(directory, version, files) {
    const target = path.join(this.root, version.slice(0, 24), path.basename(directory));
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    // Copies with no execute permission: nothing in a skill runs from here unless an agent runs it through its own tools.
    for (const file of files) { const to = path.join(target, file); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.writeFileSync(to, fs.readFileSync(path.join(directory, file)), { mode: 0o600 }); }
    return target;
  }
  save(c, skills, dirs = c.skillDirs || []) { this.broker.record(c, { type: 'skills', skills, dirs }); return this.view(c); }
  change(c, input = {}) {
    const skills = c.skills || [], named = () => { const skill = skills.find(item => item.name === input.name); if (!skill) throw fail('That skill is no longer enabled.', 404); return skill; };
    if (input.action === 'add-folder') {
      if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || !fs.statSync(input.path, { throwIfNoEntry: false })?.isDirectory()) throw fail('Choose a folder that exists.');
      return this.save(c, skills, [...new Set([...(c.skillDirs || []), input.path])]);
    }
    if (input.action === 'remove-folder') return this.save(c, skills, (c.skillDirs || []).filter(item => item !== input.path));
    if (input.action === 'enable' || input.action === 'update') {
      const found = this.available(c).find(item => item.path === input.path);
      if (!found) throw fail('That skill is no longer there.', 404);
      if (found.problems.length) throw fail(`This skill can't be used: ${found.problems.join('; ')}.`, 409);
      const current = skills.find(item => item.name === found.name);
      if (input.action === 'enable' && current) throw fail(`A skill named ${found.name} is already enabled, from ${current.sourceLabel}. Disable that one first.`, 409);
      if (found.compatibility.blocking && input.acceptPartial !== true) throw fail(`${found.name} relies on what isn't available here: ${found.compatibility.unavailable.filter(item => item.blocking).map(item => item.detail).join(' ')} Enable it as instructions only if that's still useful.`, 409, { skill: { name: found.name, needsAcceptance: true } });
      if (input.action === 'update' && !current) throw fail('That skill is no longer enabled.', 404);
      const files = skillFiles(found.path), snapshot = this.snapshot(found.path, found.version, files);
      const entry = { name: found.name, description: found.description, license: found.license, compatibilityNote: found.compatibilityNote, compatibility: found.compatibility, version: found.version, snapshot, files, sourcePath: found.path, sourceLabel: found.source.kind === 'starter' ? 'the starter set' : found.source.folder, sourceKind: found.source.kind, revision: revisionOf(found.path), enabled: true, pinned: current?.pinned || false, enabledAt: new Date().toISOString() };
      return this.save(c, current ? skills.map(item => item === current ? entry : item) : [...skills, entry]);
    }
    if (input.action === 'preview-update') {
      const skill = named(), found = this.available(c).find(item => item.path === skill.sourcePath);
      if (!found?.version) throw fail('Its source folder is no longer there.', 404);
      const result = spawnSync(gitExecutable(), ['diff', '--no-index', '--no-color', '--no-ext-diff', skill.snapshot, found.path], { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
      return { name: skill.name, source: skill.sourceLabel, diff: String(result.stdout || '').split(skill.snapshot).join('a').split(found.path).join('b').slice(0, 16000) };
    }
    if (input.action === 'disable' || input.action === 'restore') { const skill = named(); return this.save(c, skills.map(item => item === skill ? { ...item, enabled: input.action === 'restore' } : item)); }
    if (input.action === 'pin' || input.action === 'unpin') { const skill = named(); return this.save(c, skills.map(item => item === skill ? { ...item, pinned: input.action === 'pin' } : item)); }
    if (input.action === 'remove') {
      const skill = named();
      // Only Codeshi's private copy goes. The folder it came from is left as it is.
      if (inside(skill.snapshot, this.root) && !skills.some(item => item !== skill && item.snapshot === skill.snapshot)) fs.rmSync(path.dirname(skill.snapshot), { recursive: true, force: true });
      return this.save(c, skills.filter(item => item !== skill));
    }
    if (input.action === 'from-memory') return this.fromMemory(c, input);
    throw fail('Unknown skill action.');
  }
  // A reviewed step: the person has read and edited this before saving, and the skill records what it came from.
  fromMemory(c, input) {
    const entry = (c.memory || []).find(item => item.id === input.entryId), name = input.name, description = String(input.description || '').trim(), body = String(input.body || '').trim();
    if (!entry) throw fail('That memory is no longer here.', 404);
    const problems = validateSkill({ frontmatter: { name, description } }, name);
    if (problems.length) throw fail(`This skill can't be saved: ${problems.join('; ')}.`);
    if (!body) throw fail('Say what the skill should have an agent do.');
    if ((c.skills || []).some(item => item.name === name)) throw fail(`A skill named ${name} is already enabled.`, 409);
    const text = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  source-memory: "${entry.id}"\n  source-commit: "${entry.source?.commit || 'unknown'}"\n---\n\n${body}\n`;
    const version = createHash('sha256').update(text).digest('hex'), snapshot = path.join(this.root, version.slice(0, 24), name);
    fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(snapshot, 'SKILL.md'), text, { mode: 0o600 });
    const skill = { name, description, license: null, compatibilityNote: null, compatibility: compatibilityOf({ frontmatter: { name, description }, body }, ['SKILL.md']), version, snapshot, files: ['SKILL.md'], sourcePath: snapshot, sourceLabel: 'your memory', sourceKind: 'memory', provenance: { entryId: entry.id, commit: entry.source?.commit || null, messageId: entry.source?.messageId || null }, revision: null, enabled: true, pinned: false, enabledAt: new Date().toISOString() };
    return this.save(c, [...(c.skills || []), skill]);
  }

  // What a run is told. Names and descriptions always; full instructions for a skill the person asked for, one that clearly
  // matches, or one this task was already using, including after it moved to another agent.
  forTask(c, { text, relation = null, fresh = true, provider }) {
    const enabled = (c.skills || []).filter(skill => skill.enabled), chosen = new Map(), request = text === continuationRequest ? '' : String(text || '');
    if (!enabled.length) return { catalog: [], active: [], records: [] };
    for (const skill of enabled) {
      const escaped = skill.name.replace(/-/g, '[- ]');
      if (new RegExp(`(?:^|[\\s(])[/$]${skill.name}(?![\\w-])`, 'i').test(request) || new RegExp(`\\b(?:use|using|follow|with)\\s+(?:the\\s+|our\\s+)?${escaped}\\s+skill\\b`, 'i').test(request)) chosen.set(skill.name, 'asked for');
    }
    if (relation) for (const item of c.lastRun?.context?.skills || []) { const skill = enabled.find(entry => entry.name === item.name); if (skill && !chosen.has(skill.name)) chosen.set(skill.name, skill.version === item.version ? 'continuing this task' : 'continuing this task, at its updated version'); }
    // At most one chosen by its words, and only on a strong match, so a skill isn't pulled in for every message.
    if (!chosen.size && request) {
      const wanted = words(request);
      const scored = enabled.map(skill => { const nameWords = skill.name.split('-').filter(word => word.length > 3), shared = [...words(skill.description)].filter(word => wanted.has(word)); return { skill, shared, named: nameWords.length > 0 && nameWords.every(word => wanted.has(word)) }; }).filter(item => item.named || item.shared.length >= MATCH_WORDS).sort((a, b) => Number(b.named) - Number(a.named) || b.shared.length - a.shared.length);
      if (scored[0]) chosen.set(scored[0].skill.name, scored[0].named ? 'its name matches the request' : `the request mentions ${scored[0].shared.slice(0, 3).join(', ')}`);
    }
    const delivered = new Set(!fresh && c.lastRun?.provider === provider ? (c.lastRun.context?.skills || []).filter(item => item.delivered).map(item => `${item.name}@${item.version}`) : []);
    const active = [], records = [];
    let spent = 0;
    for (const [name, reason] of chosen) {
      const skill = enabled.find(item => item.name === name), key = `${name}@${skill.version}`;
      const record = { name, version: skill.version, reason, source: skill.sourceLabel, ...(skill.revision ? { revision: skill.revision } : {}) };
      if (delivered.has(key)) { records.push({ ...record, delivered: true }); continue; }
      let body = '';
      try { body = parseSkill(fs.readFileSync(path.join(skill.snapshot, 'SKILL.md'), 'utf8')).body; } catch { records.push({ ...record, unavailable: true }); continue; }
      const room = Math.min(BODY_BYTES, BODY_TOTAL - spent), cut = Buffer.byteLength(body) > room;
      const text = cut ? Buffer.from(body).subarray(0, Math.max(0, room)).toString('utf8').replace(/�+$/, '') : body;
      spent += Buffer.byteLength(text);
      const notAvailable = (skill.compatibility?.unavailable || []).map(item => item.detail);
      active.push({ name, reason, version: skill.version.slice(0, 12), instructions: text, ...(cut ? { truncated: true, readTheRestAt: path.join(skill.snapshot, 'SKILL.md') } : {}), ...(skill.files.length > 1 ? { resources: { folder: skill.snapshot, files: skill.files.filter(file => file !== 'SKILL.md').slice(0, 20) } } : {}), ...(notAvailable.length ? { notAvailable } : {}) });
      records.push({ ...record, delivered: true });
    }
    // The catalog is what lets an agent pick a skill up by itself. A resumed session already has it, unless it has changed.
    const catalogKey = enabled.map(skill => `${skill.name}@${skill.version}`).join(' '), catalog = [];
    if (fresh || c.lastRun?.context?.skillCatalog !== catalogKey) {
      let used = 0;
      for (const skill of enabled) {
        if (chosen.has(skill.name)) continue;
        const item = { name: skill.name, description: skill.description.slice(0, 200), path: path.join(skill.snapshot, 'SKILL.md') }, size = Buffer.byteLength(JSON.stringify(item));
        if (used + size > CATALOG_BYTES) break;
        used += size; catalog.push(item);
      }
    }
    return { catalog, active, records, catalogKey };
  }
}
const inside = (target, root) => target.startsWith(root + path.sep);

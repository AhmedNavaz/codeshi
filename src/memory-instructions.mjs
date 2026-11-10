import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Copy to AGENTS.md (#21): shares chosen memories with a team through the folder's own instruction file. Codeshi only ever
// writes one marked section; the rest of the file is kept byte for byte. A preview comes first, and the write is refused if
// the file changed after it, so nothing the person hasn't seen is overwritten.
export const INSTRUCTIONS_FILE = 'AGENTS.md';
const START = '<!-- codeshi:memory -->', END = '<!-- /codeshi:memory -->', MAX_FILE = 256 * 1024;
const HEADINGS = { convention: 'Conventions', decision: 'Decisions', solution: 'Working fixes', 'failed-approach': 'Approaches that failed' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const count = (text, part) => text.split(part).length - 1;

// Entry text as one Markdown list item. Comment markers are broken up so an entry can't end the section early.
const item = text => '- ' + String(text).replace(/\r\n?/g, '\n').replaceAll('<!--', '< !--').replaceAll('-->', '-- >')
  .split('\n').map(line => line.trimEnd()).filter((line, index, lines) => line || lines[index - 1]).join('\n').trim().split('\n').map((line, index) => index && line ? '  ' + line : line).join('\n');

export function memorySection(entries) {
  const lines = [START, '## Project memory', '', '_Copied from Codeshi project memory. Copying again replaces this section only._'];
  for (const [kind, heading] of Object.entries(HEADINGS)) {
    const chosen = entries.filter(entry => entry.kind === kind);
    if (chosen.length) lines.push('', `### ${heading}`, '', ...chosen.map(entry => item(entry.text)));
  }
  lines.push(END);
  return lines.join('\n');
}

// The file as it is now. A link, a folder in its place or a very large file is left for the person to edit themselves.
function readCurrent(folder) {
  const file = path.join(folder.path, INSTRUCTIONS_FILE);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { file, bytes: null }; throw error; }
  if (stat.isSymbolicLink()) throw fail(`${INSTRUCTIONS_FILE} in ${folder.displayName || folder.name} is a link. Edit it yourself, or copy the section from the preview.`, 409);
  if (!stat.isFile()) throw fail(`${INSTRUCTIONS_FILE} in ${folder.displayName || folder.name} isn't a file.`, 409);
  if (stat.size > MAX_FILE) throw fail(`${INSTRUCTIONS_FILE} in ${folder.displayName || folder.name} is over 256 KB. Edit it yourself.`, 409);
  return { file, bytes: fs.readFileSync(file), mode: stat.mode };
}

// The file with the section added at the end, or put in place of the one copied before.
function compose(current, section) {
  if (current === null) return { text: section + '\n', previous: null };
  const newline = current.includes('\r\n') ? '\r\n' : '\n', block = section.replaceAll('\n', newline);
  const starts = count(current, START), ends = count(current, END);
  if (!starts && !ends) return { text: current.replace(/\s*$/, '') + newline + newline + block + newline, previous: null };
  const from = current.indexOf(START), to = current.indexOf(END);
  if (starts !== 1 || ends !== 1 || to < from) throw fail(`The Project memory section in ${INSTRUCTIONS_FILE} has missing or extra ${START} markers. Fix them by hand first.`, 409);
  return { text: current.slice(0, from) + block + current.slice(to + END.length), previous: current.slice(from, to + END.length) };
}

// The memories this folder can carry: active ones for this folder or for every folder, in the order they were saved.
export function copyableEntries(c, folderId) {
  return (c.memory || []).filter(entry => entry.status === 'active' && (!entry.folderId || entry.folderId === folderId));
}

export function planCopy(c, folders, input = {}) {
  const folder = folders.find(item => item.id === input.folderId);
  if (!folder) throw fail('That folder is no longer in this workspace.', 404);
  const ids = new Set(Array.isArray(input.ids) ? input.ids.filter(id => typeof id === 'string') : []);
  const entries = copyableEntries(c, folder.id).filter(entry => ids.has(entry.id));
  if (!entries.length) throw fail('Choose at least one memory to copy.');
  const current = readCurrent(folder), before = current.bytes?.toString('utf8') ?? null;
  const section = memorySection(entries), { text, previous } = compose(before, section);
  return { folder, file: current.file, mode: current.mode, entries, text,
    preview: { folderId: folder.id, folder: folder.displayName || folder.name, path: INSTRUCTIONS_FILE, exists: before !== null, replaces: previous, section,
      ids: entries.map(entry => entry.id), sha256: current.bytes ? hash(current.bytes) : null, unchanged: before === text } };
}

// Written beside the file and renamed over it, so a reader never sees half a file. Refused if it moved since the preview.
export function writeCopy(plan, expected) {
  if ((expected ?? null) !== plan.preview.sha256) throw fail(`${INSTRUCTIONS_FILE} changed after the preview. Look at it again before copying.`, 409);
  if (plan.preview.unchanged) return;
  const temporary = path.join(path.dirname(plan.file), `.${INSTRUCTIONS_FILE}.codeshi-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, plan.text, { flag: 'wx', ...(plan.mode ? { mode: plan.mode & 0o777 } : {}) });
    fs.renameSync(temporary, plan.file);
  } catch (error) { try { fs.rmSync(temporary, { force: true }); } catch { /* Already gone. */ } throw error; }
}

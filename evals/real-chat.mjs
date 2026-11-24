import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from './experiment.mjs';

// A person's own long conversation as an evaluation (#85). The built fixtures show what each context setting keeps on
// tasks written for it; this one continues a real conversation from a chosen point, in copies of its real folders, so
// what each setting keeps is measured on history nobody arranged.
//
// The setup lives in a private file the person writes and keeps out of the repository (output/ is ignored), since the
// questions are about their own work. Nothing is read from the original conversation or folders after the copy is made:
// the journal is copied up to the last finished run before the chosen request, every path in it is moved to the copies,
// and each folder is a local clone at its current commit with its uncommitted and untracked files laid over it, without
// a remote. Results keep hashes, counts and the names of the checks a reply missed, never the questions or the replies.
//
// {
//   "journal": "…/relay-data/<workspace>/<conversation>.jsonl",
//   "until": "<id of the request to cut before>",
//   "folders": [{ "id": "…", "name": "…", "path": "…" }],
//   "turns": [{ "prompt": "…", "expect": { "a short label": "regular expression" }, "facts": ["…"] }],
//   "facts": ["text the conversation settled, looked for in a fresh agent's first message"]
// }
const CONVERSATION = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.jsonl$/;
const FIXED_DATE = '2026-01-01T00:00:00Z';
const git = (cwd, args) => {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE } });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in ${path.basename(cwd)}: ${String(result.stderr).trim().split('\n')[0]}`);
  return result.stdout;
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pattern = (value, where) => {
  try { return new RegExp(value, 'i'); } catch { throw new Error(`${where} is not a valid regular expression.`); }
};

// The journal up to and including the last finished run before the request `until`, so the copy never holds a run in
// progress. The record order is the journal's own; nothing is rewritten here.
export function cutJournal(text, until) {
  const lines = text.split('\n');
  let at = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith('{"type":"submission"') || !line.includes(until)) continue;
    try { if (JSON.parse(line).id === until) { at = index; break; } } catch { /* A torn record is not the request. */ }
  }
  if (at < 0) throw new Error('The conversation has no request with the id in "until".');
  for (let index = at - 1; index >= 0; index--) {
    if (!lines[index].includes('"type":"run_end"')) continue;
    try { if (JSON.parse(lines[index]).type === 'run_end') return lines.slice(0, index + 1).join('\n') + '\n'; } catch { /* Keep looking. */ }
  }
  throw new Error('No run finished before that request, so there is nothing to continue.');
}

// Moves every mention of the original folders and data folder to the copies, longest first so a folder inside another
// is moved to its own copy.
export function movePaths(text, moves) {
  let result = text;
  for (const [from, to] of [...moves].sort((a, b) => b[0].length - a[0].length)) {
    for (const [a, b] of [[from, to], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]]) if (a) result = result.split(a).join(b);
  }
  return result;
}

// A copy of a folder as it is now: a local clone at its current commit, with the working tree's changes laid over it.
// The remote is removed, so nothing done in the copy can reach the original or its remote.
export function snapshotFolder(source, target) {
  const head = git(source, ['rev-parse', 'HEAD']).trim();
  let branch = null;
  try { branch = git(source, ['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null; } catch { /* Detached. */ }
  git(path.dirname(target), ['clone', '-q', '--local', '--no-checkout', source, target]);
  git(target, ['checkout', '-q', ...(branch ? ['-B', branch, head] : ['--detach', head])]);
  git(target, ['remote', 'remove', 'origin']);
  const overlay = [];
  for (const relative of git(source, ['ls-files', '-z', '-m', '-o', '--exclude-standard']).split('\0').filter(Boolean)) {
    let stat;
    try { stat = fs.lstatSync(path.join(source, relative)); } catch { continue; }
    if (!stat.isFile()) continue;
    const bytes = fs.readFileSync(path.join(source, relative));
    fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
    fs.writeFileSync(path.join(target, relative), bytes);
    overlay.push([relative, sha256(bytes)]);
  }
  for (const relative of git(source, ['ls-files', '-z', '-d']).split('\0').filter(Boolean)) {
    fs.rmSync(path.join(target, relative), { force: true });
    overlay.push([relative, null]);
  }
  overlay.sort((a, b) => a[0].localeCompare(b[0]));
  return { head, branch, overlay: sha256(JSON.stringify(overlay)) };
}

export function realChat(config, { configFile = null } = {}) {
  const where = configFile ? path.basename(configFile) : 'The real-conversation setup';
  if (typeof config?.journal !== 'string' || !CONVERSATION.test(path.basename(config.journal)) || !fs.statSync(config.journal, { throwIfNoEntry: false })?.isFile()) throw new Error(`${where}: "journal" must name a saved conversation (<id>.jsonl).`);
  if (typeof config.until !== 'string' || !config.until) throw new Error(`${where}: "until" must be the id of the request to cut before.`);
  if (!Array.isArray(config.folders) || !config.folders.length) throw new Error(`${where}: list the workspace's folders in "folders".`);
  for (const folder of config.folders) {
    if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string' || !/^[\w.-]+$/.test(folder.name) || typeof folder.path !== 'string' || !path.isAbsolute(folder.path) || !fs.existsSync(path.join(folder.path, '.git'))) throw new Error(`${where}: each folder needs an id, a plain name and the absolute path of a Git repository.`);
  }
  if (new Set(config.folders.map(folder => folder.name)).size !== config.folders.length) throw new Error(`${where}: folder names must differ.`);
  if (!Array.isArray(config.turns) || !config.turns.length || config.turns.some(turn => typeof turn?.prompt !== 'string' || !turn.prompt.trim() || !turn.expect || typeof turn.expect !== 'object' || !Object.keys(turn.expect).length)) throw new Error(`${where}: each turn needs a prompt and at least one expected part of its reply.`);
  const turns = config.turns.map((turn, index) => ({ prompt: turn.prompt, facts: Array.isArray(turn.facts) ? turn.facts.map(String) : [],
    expect: Object.fromEntries(Object.entries(turn.expect).map(([label, value]) => [label, pattern(String(value), `${where}: turn ${index + 1}, "${label}"`)])) }));
  const facts = Array.isArray(config.facts) ? config.facts.map(String) : [];
  const cut = cutJournal(fs.readFileSync(config.journal, 'utf8'), config.until);
  const hash = fingerprint({ kind: 'real-chat', conversation: sha256(cut), folders: config.folders.map(({ id, name }) => ({ id, name })),
    turns: turns.map(turn => ({ prompt: sha256(turn.prompt), facts: turn.facts.map(sha256), expect: Object.entries(turn.expect).map(([label, value]) => [label, value.source]) })), facts: facts.map(sha256) });
  return {
    id: typeof config.id === 'string' && /^[\w-]+$/.test(config.id) ? config.id : 'real-chat',
    title: 'A real conversation, continued from a chosen request in copies of its folders',
    real: true, hash, readOnly: config.readOnly !== false, freshTurns: true, turns, facts,
    rubric: 'Answers each follow-up from what the conversation settled, reading the code only where it has to. Compare repeated reads and total usage between context settings as well as the replies.',
    ...(Array.isArray(config.trace) ? { trace: config.trace } : {}),
    // Builds the copies under root. dataDir is where the copied conversation goes, for the Broker to load.
    setup(root, dataDir) {
      const work = path.join(root, 'work'); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const folders = {}, snapshot = {}, moves = [];
      for (const folder of config.folders) {
        const target = path.join(work, folder.name), taken = snapshotFolder(folder.path, target);
        folders[folder.name] = fs.realpathSync(target);
        snapshot[folder.name] = `${taken.head.slice(0, 12)}+${taken.overlay.slice(0, 12)}`;
        moves.push([folder.path, folders[folder.name]]);
        try { const real = fs.realpathSync(folder.path); if (real !== folder.path) moves.push([real, folders[folder.name]]); } catch { /* Checked above. */ }
      }
      const source = path.dirname(config.journal);
      moves.push([source, dataDir]);
      const name = path.basename(config.journal);
      fs.writeFileSync(path.join(dataDir, name), movePaths(cut, moves), { mode: 0o600 });
      // Saved attachments are what earlier requests carried. Saved approvals, tasks and checkpoints are not copied: the
      // evaluation answers nothing on the person's behalf and starts no task of the original conversation.
      if (fs.existsSync(path.join(source, 'attachments'))) fs.cpSync(path.join(source, 'attachments'), path.join(dataDir, 'attachments'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      return { folders, snapshot, conversationId: name.slice(0, -6),
        workspaceFolders: config.folders.map(folder => ({ id: folder.id, name: folder.name, displayName: folder.name, path: folders[folder.name] })) };
    },
  };
}

export const readRealChat = file => realChat(JSON.parse(fs.readFileSync(file, 'utf8')), { configFile: file });

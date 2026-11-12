import { spawnSync } from 'node:child_process';
import { filterOverrides, githubRepository, isRepository, runner } from './workspace-git.mjs';

// Commits in Timeline (#20). Read only: Codeshi reads each folder's history on its current branch and never writes to Git.
// Restoring stays with checkpoints. A commit says who made it only from what Codeshi recorded: the Git panel's own commits,
// and commits made while an agent's run was working. Anything else shows its author, since Codeshi can't tell more.
const LIMIT = 30, EMPTY_LIMIT = 15, FILES = 300, FILE_LINES = 400, TOTAL_LINES = 4000, BODY = 4000;
const HASH = /^[0-9a-f]{7,64}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const time = value => { const at = new Date(value).getTime(); return Number.isNaN(at) ? null : at; };

// When each run was working, from its checkpoints. Git keeps commit times to the second, so a run starts a second early.
export function runWindows(entries, now = Date.now()) {
  return entries.filter(entry => entry.kind === 'run').map(entry => {
    const before = entry.checkpoints?.find(point => point.target.phase === 'before'), after = entry.checkpoints?.find(point => point.target.phase === 'after');
    const start = time(before?.at || entry.at), end = after ? time(after.at) : entry.status === 'running' ? now : null;
    return start !== null && end !== null ? { runId: entry.runId || entry.id, provider: entry.provider, local: entry.local, start: start - 1000, end } : null;
  }).filter(Boolean);
}

// The latest commits of each folder, from the oldest Timeline entry on, or the latest few when there is none yet.
export function timelineCommits(folders, { since = null, runs = [], panel = [], spawnImpl = spawnSync } = {}) {
  const commits = [], from = since && time(since) !== null ? time(since) - 1000 : null;
  for (const folder of folders) {
    const run = runner(folder, spawnImpl);
    if (!isRepository(run)) continue;
    const log = run(['log', `-${from === null ? EMPTY_LIMIT : LIMIT}`, '--format=%H%x1f%h%x1f%an%x1f%cI%x1f%P%x1f%s%x00', '--', '.']);
    if (log.status !== 0) continue;
    const url = githubRepository(run(['config', '--get', 'remote.origin.url']).stdout || '');
    for (const row of String(log.stdout).split('\0').map(item => item.trim()).filter(Boolean)) {
      const [hash, shortHash, author, committed, parents, ...subject] = row.split('\x1f'), at = time(committed);
      if (at === null || (from !== null && at < from)) continue;
      const byPanel = panel.some(item => item.folderId === folder.id && item.hash === hash);
      const during = byPanel ? null : runs.find(window => window.start <= at && at <= window.end);
      commits.push({ id: `commit:${folder.id}:${hash}`, kind: 'commit', folderId: folder.id, folder: folder.displayName || folder.name, hash, shortHash, author, at: new Date(at).toISOString(),
        subject: subject.join('\x1f'), merge: parents.trim().split(/\s+/).filter(Boolean).length > 1, url: url && /^[a-f0-9]{40,64}$/.test(hash) ? `${url}/commit/${hash}` : null,
        ...(byPanel ? { by: 'panel' } : during ? { by: 'run', runId: during.runId, provider: during.provider || null, local: Boolean(during.local) } : {}) });
    }
  }
  return commits;
}

const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type' };
// One commit's files and lines, read only. A merge is shown against its first parent, as the branch saw it.
export function timelineCommit(folder, hash, { spawnImpl = spawnSync } = {}) {
  if (typeof hash !== 'string' || !HASH.test(hash)) fail('Choose a commit.');
  const run = runner(folder, spawnImpl, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  if (!isRepository(run)) fail('No Git repository in this folder.', 404);
  const filters = filterOverrides(run);
  if (filters.error) fail(filters.error, 409);
  const info = run(['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%cI%x1f%P%x1f%s%x1f%b', `${hash}^{commit}`, '--']);
  if (info.status !== 0) fail('That commit is no longer in this repository.', 404);
  const [full, shortHash, author, committed, parents, subject, ...body] = String(info.stdout).replace(/\n$/, '').split('\x1f');
  const parent = parents.trim().split(/\s+/).filter(Boolean);
  const range = parent.length ? [parent[0], full] : ['--root', full], common = ['diff-tree', '-r', '-M', '--relative', '--no-commit-id'];
  const names = run([...common, '--name-status', '-z', ...range], filters.overrides);
  if (names.status !== 0) fail('Could not read this commit’s files.', 500);
  const listed = [], parts = String(names.stdout).split('\0');
  for (let i = 0; i < parts.length - 1;) {
    const code = parts[i++];
    if (!code) continue;
    const kind = STATUS[code[0]] || 'modified', moved = code[0] === 'R' || code[0] === 'C';
    const from = moved ? parts[i++] : null, name = parts[i++];
    listed.push({ path: name, status: kind, ...(from ? { originalPath: from } : {}) });
  }
  const patch = run([...common, '-p', '--no-color', '--no-ext-diff', '--no-textconv', ...range], filters.overrides);
  const chunks = patch.status === 0 ? String(patch.stdout).split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith('diff --git ')) : [];
  const withDiffs = chunks.length === listed.length;
  let spent = 0;
  const files = listed.slice(0, FILES).map((file, index) => {
    if (!withDiffs) return { ...file, diff: null };
    const chunk = chunks[index];
    if (/^(?:Binary files |GIT binary patch)/m.test(chunk)) return { ...file, binary: true, diff: null };
    const start = chunk.search(/^@@/m);
    if (start < 0) return { ...file, diff: '' };
    const lines = chunk.slice(start).replace(/\n$/, '').split('\n'), room = Math.max(0, Math.min(FILE_LINES, TOTAL_LINES - spent)), kept = lines.slice(0, room);
    spent += kept.length;
    return { ...file, diff: kept.length ? kept.join('\n') : null, ...(lines.length > kept.length ? { truncated: lines.length - kept.length } : {}) };
  });
  const url = githubRepository(run(['config', '--get', 'remote.origin.url']).stdout || '');
  return { folderId: folder.id, folder: folder.displayName || folder.name, hash: full, shortHash, author, at: new Date(committed).toISOString(), subject, body: body.join('\x1f').trim().slice(0, BODY),
    merge: parent.length > 1, url: url ? `${url}/commit/${full}` : null, files, totalFiles: listed.length, ...(withDiffs ? {} : { linesUnavailable: true }) };
}

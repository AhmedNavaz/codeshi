import { spawnSync } from 'node:child_process';

const prefix = ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
export function githubRepository(remote = '') {
  const match = remote.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}
function runner(folder, spawnImpl, { timeout = 5000, maxBuffer = 1024 * 1024 } = {}) {
  return (args, extra = []) => spawnImpl('/usr/bin/git', [...prefix, ...extra, ...args], { cwd: folder.path, shell: false, encoding: 'utf8', timeout, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PAGER: 'cat' } });
}
function isRepository(run) { const inside = run(['rev-parse', '--is-inside-work-tree']); return inside.status === 0 && String(inside.stdout || '').trim() === 'true'; }
// Status and diff can invoke attributes filters. Returns -c overrides that disable configured external drivers.
function filterOverrides(run) {
  const config = run(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']);
  if (config.error || ![0, 1].includes(config.status)) return { error: 'Could not inspect Git filter settings safely.' };
  const overrides = [];
  for (const key of config.stdout.split('\0').filter(Boolean)) {
    const driver = key.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/)?.[1];
    if (!driver || !/^[\w.-]{1,200}$/.test(driver)) return { error: 'Unsupported Git filter configuration.' };
    for (const setting of ['clean', 'smudge', 'process', 'required']) overrides.push('-c', `filter.${driver}.${setting}=${setting === 'required' ? 'false' : ''}`);
  }
  return { overrides };
}
function workingChanges(run, overrides, untracked = 'normal') {
  const status = run(['status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`, '--', '.'], overrides);
  const changes = [], entries = String(status.stdout || '').split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (entry.length < 4) continue;
    const code = entry.slice(0, 2), name = entry.slice(3), originalPath = /[RC]/.test(code) ? entries[++i] : undefined;
    changes.push({ path: name, code, staged: code[0] !== ' ' && code[0] !== '?', ...(originalPath ? { originalPath } : {}) });
  }
  return { ok: status.status === 0, changes };
}
export function workspaceGit(folders, { spawnImpl = spawnSync, untracked = 'normal' } = {}) {
  return { checkedAt: new Date().toISOString(), repositories: folders.map(folder => {
    const run = runner(folder, spawnImpl);
    const base = { folderId: folder.id, name: folder.displayName || folder.name, alias: folder.name };
    if (!isRepository(run)) return { ...base, available: false, error: 'No Git repository in this folder.' };
    const filters = filterOverrides(run);
    if (filters.error) return { ...base, available: false, error: filters.error };
    const status = workingChanges(run, filters.overrides, untracked);
    const branch = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const log = run(['log', '-15', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x00', '--', '.']);
    const origin = run(['config', '--get', 'remote.origin.url']);
    const githubURL = githubRepository(origin.stdout);
    const changes = status.changes;
    const commits = log.status === 0 ? log.stdout.split('\0').map(row => row.trim()).filter(Boolean).map(row => {
      const [hash, shortHash, author, date, ...subject] = row.split('\x1f');
      return { hash, shortHash, author, date, subject: subject.join('\x1f'), url: githubURL && /^[a-f0-9]{40,64}$/.test(hash) ? `${githubURL}/commit/${hash}` : null };
    }) : [];
    // Everything staged, past the 100 changes listed: a commit from the panel must match it exactly.
    const stagedPaths = changes.filter(change => change.staged).flatMap(change => [change.path, change.originalPath].filter(Boolean));
    return { ...base, available: true, branch: branch.status === 0 ? branch.stdout.trim() : 'Detached HEAD', githubURL, changes: changes.slice(0, 100), totalChanges: changes.length, changesClipped: changes.length > 100, stagedPaths, commits, error: status.ok ? null : 'Could not read working changes.' };
  }) };
}
// Unified diff of one currently changed file against HEAD. Only paths Git reports as changed are accepted.
export function workspaceGitDiff(folder, filePath, { spawnImpl = spawnSync, limit = 400 * 1024 } = {}) {
  const fail = (message, status) => Object.assign(new Error(message), { status });
  const run = runner(folder, spawnImpl, { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (!isRepository(run)) throw fail('No Git repository in this folder.', 404);
  const filters = filterOverrides(run);
  if (filters.error) throw fail(filters.error, 409);
  const file = workingChanges(run, filters.overrides).changes.find(entry => entry.path === filePath) || workingChanges(run, filters.overrides, 'all').changes.find(entry => entry.path === filePath);
  if (!file) throw fail('This file has no current changes. Refresh Git activity.', 404);
  const base = { folderId: folder.id, path: file.path, code: file.code, ...(file.originalPath ? { originalPath: file.originalPath } : {}) };
  if (file.path.endsWith('/')) return { ...base, diff: '', directory: true, truncated: false };
  const options = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];
  let result;
  if (file.code === '??') result = run(['diff', '--no-index', ...options, '--', '/dev/null', file.path], filters.overrides);
  else {
    const paths = ['--', ...(file.originalPath ? [file.originalPath] : []), file.path];
    const head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    // Before the first commit, the base is empty. Include current bytes even if a new staged file was edited again.
    if (head.status !== 0 && file.code.includes('D')) return { ...base, diff: '', truncated: false };
    result = run(head.status === 0 ? ['diff', 'HEAD', ...options, ...paths] : ['diff', '--no-index', ...options, '--', '/dev/null', file.path], filters.overrides);
  }
  // --no-index exits 1 when the files differ; ENOBUFS keeps the output read so far.
  const overflow = result.error?.code === 'ENOBUFS';
  if ((result.error && !overflow) || (!overflow && ![0, 1].includes(result.status))) throw fail('Could not read this file’s changes.', 500);
  const diff = String(result.stdout || '');
  return { ...base, diff: diff.slice(0, limit), truncated: overflow || diff.length > limit };
}

export function workspaceGitIdentity(folder) {
  const run = runner(folder, spawnSync), root = run(['rev-parse', '--show-toplevel']), head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (root.status !== 0) throw Object.assign(new Error('Attach a Git repository root to review its changes.'), { status: 400 });
  return { root: root.stdout.trim(), head: head.status === 0 ? head.stdout.trim() : null };
}

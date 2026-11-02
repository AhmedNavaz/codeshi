import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitExecutable } from './resolve-binary.mjs';
export function workspaceBaseline(workspace, workspaceFolders) {
  const primary = folderBaseline(workspace);
  if (!workspaceFolders) return primary;
  return { ...primary, folders: workspaceFolders.map(folder => ({ id: folder.id, name: folder.name, path: folder.path, ...(folder.path === workspace ? primary : folderBaseline(folder.path)) })) };
}
function folderBaseline(workspace) {
  const run = args => spawnSync(gitExecutable(), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: workspace, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const head = run(['rev-parse', '--verify', 'HEAD']);
  const status = run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.status !== 0) return { kind: 'directory', git: false, capturedAt: new Date().toISOString(), note: 'No Git snapshot. Provider runs do not reset, stash, or commit files.' };
  const diff = run(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']);
  return { kind: 'git', git: true, head: head.status === 0 ? head.stdout.trim() : null, dirty: Boolean(status.stdout), statusHash: createHash('sha256').update(status.stdout).update(diff.status === 0 ? diff.stdout : '').digest('hex'), capturedAt: new Date().toISOString(), note: 'Workspace identity only; handoff baselines must hash approved file contents, including untracked files.' };
}

import { workspaceGit, workspaceGitDiff } from './workspace-git.mjs';
import { commitChanges, committer, stageChanges, unstageChanges } from './workspace-commit.mjs';
import { listFiles, readExplorerFile, searchFiles } from './file-explorer.mjs';
import { githubContext } from './github-context.mjs';
import { openPullRequest, pullRequestPreview } from './pull-request.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
// Git activity, with the name and email a commit from the panel would use.
async function gitActivity(folders) {
  const data = workspaceGit(folders);
  await Promise.all(data.repositories.filter(repo => repo.available).map(async repo => { repo.committer = await committer(folders.find(folder => folder.id === repo.folderId)); }));
  return data;
}
const gitActions = { '/api/git/stage': stageChanges, '/api/git/unstage': unstageChanges, '/api/git/commit': commitChanges };

export function createWorkspaceRoutes({ registry, body, json, readGitHub = githubContext, pullRequests = { preview: pullRequestPreview, open: openPullRequest } }) {
  return async ({ req, res, url }) => {
    // An issue or pull request read through the person's gh login, cleaned and returned for the message box. Read only.
    if (url.pathname === '/api/git/github-context') {
      if (req.method !== 'POST') fail('Use POST to read GitHub context.', 405);
      const projectId = url.searchParams.get('projectId');
      if (!projectId) fail('Select a workspace first.');
      const input = await body(req, 16 * 1024), project = registry.get(projectId);
      json(res, 200, await readGitHub(project.folders, { reference: typeof input.reference === 'string' ? input.reference.slice(0, 500) : '', folderId: typeof input.folderId === 'string' ? input.folderId : '' })); return true;
    }
    // Open pull request (#18): a preview of what would be pushed and opened, then the push and gh pr create, only on a
    // click. Both read GitHub through the person's gh login; only the second writes, under the folder's Git lease.
    if (url.pathname === '/api/git/pull-request/preview' || url.pathname === '/api/git/pull-request') {
      if (req.method !== 'POST') fail('Use POST for pull requests.', 405);
      const projectId = url.searchParams.get('projectId');
      if (!projectId) fail('Select a workspace first.');
      const input = await body(req, 128 * 1024), project = registry.get(projectId);
      const folder = project.folders.find(entry => entry.id === input.folderId);
      if (!folder) fail('That folder is no longer in this workspace.', 404);
      if (url.pathname.endsWith('/preview')) {
        let conversation = null;
        try { if (typeof input.conversationId === 'string') conversation = registry.broker(projectId).get(input.conversationId); } catch { conversation = null; }
        json(res, 200, await pullRequests.preview(folder, { conversation, folders: project.folders })); return true;
      }
      const result = await pullRequests.open(folder, input, { withMutation: (root, operation, work) => registry.withMutation(projectId, operation, () => {
        const current = registry.get(projectId).folders.find(entry => entry.id === input.folderId);
        if (!current || current.path !== folder.path) fail('That folder is no longer in this workspace.', 404);
        return work();
      }, { workspaces: [root] }) });
      json(res, 200, { ...result, git: await gitActivity(project.folders) }); return true;
    }
    // The search bar finds files across all workspaces.
    if (url.pathname === '/api/file-search') {
      if (req.method !== 'GET') fail('File search is read only.', 405);
      const workspaces = registry.list().filter(project => project.available !== false).map(project => registry.get(project.id));
      json(res, 200, { files: searchFiles(workspaces, url.searchParams.get('q') || '') }); return true;
    }
    if (['/api/files', '/api/files/preview', '/api/attachments', '/api/attachments/preview'].includes(url.pathname)) {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) fail('Select a workspace first.');
      const project = registry.get(projectId);
      if (url.pathname.startsWith('/api/attachments')) {
        const store = registry.broker(projectId).attachments;
        if (req.method === 'POST' && url.pathname === '/api/attachments') {
          const input = await body(req, 7 * 1024 * 1024);
          registry.get(projectId); // It may have been removed during upload.
          json(res, 201, store.put(input)); return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/attachments/preview') {
          json(res, 200, store.read(url.searchParams.get('id'))); return true;
        }
        fail('Unsupported attachment operation.', 405);
      }
      if (req.method !== 'GET') fail('The file explorer is read only.', 405);
      const folder = project.folders.find(entry => entry.id === url.searchParams.get('folderId'));
      if (!folder) fail('That folder is no longer in this workspace.', 404);
      const relative = url.searchParams.get('path') || '';
      json(res, 200, url.pathname === '/api/files' ? listFiles(folder, relative, Number(url.searchParams.get('offset') || 0)) : readExplorerFile(folder, relative)); return true;
    }
    // Staging and committing answer with the refreshed Git activity, so the panel shows the result at once.
    if (gitActions[url.pathname]) {
      if (req.method !== 'POST') fail('Use POST to stage, unstage or commit.', 405);
      const projectId = url.searchParams.get('projectId');
      if (!projectId) fail('Select a workspace first.');
      const input = await body(req, 64 * 1024), project = registry.get(projectId);
      const folder = project.folders.find(entry => entry.id === input.folderId);
      if (!folder) fail('That folder is no longer in this workspace.', 404);
      const result = await gitActions[url.pathname](folder, input, { withMutation: (root, operation, work) => registry.withMutation(projectId, operation, () => {
        // Membership can change during the body upload or asynchronous Git root lookup. Validate again under the lease.
        const current = registry.get(projectId).folders.find(entry => entry.id === input.folderId);
        if (!current || current.path !== folder.path) fail('That folder is no longer in this workspace.', 404);
        return work();
      }, { workspaces: [root] }) });
      json(res, 200, { ...result, git: await gitActivity(project.folders) }); return true;
    }
    if (!['/api/git', '/api/git/diff'].includes(url.pathname)) return false;
    if (req.method !== 'GET') fail('Git activity is read only.', 405);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail('Select a workspace first.');
    const project = registry.get(projectId);
    if (url.pathname === '/api/git') { json(res, 200, await gitActivity(project.folders)); return true; }
    const folder = project.folders.find(entry => entry.id === url.searchParams.get('folderId'));
    if (!folder) fail('That folder is no longer in this workspace.', 404);
    json(res, 200, workspaceGitDiff(folder, url.searchParams.get('path') || '')); return true;
  };
}

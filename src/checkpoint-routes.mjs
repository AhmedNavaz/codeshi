import { runWindows, timelineCommit, timelineCommits } from './timeline-commits.mjs';

// Undo and redo a run's changes from its checkpoints (#20). Preview reads only; applying holds the workspace's
// mutation lease, so no agent, patch or other undo can change the same folders meanwhile.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const PATHS = ['/api/checkpoints', '/api/checkpoints/commit', '/api/checkpoints/preview', '/api/checkpoints/apply'];
const READS = ['/api/checkpoints', '/api/checkpoints/commit'];

export function createCheckpointRoutes({ registry, body, json }) {
  return async ({ req, res, url }) => {
    if (!PATHS.includes(url.pathname)) return false;
    if (req.method !== (READS.includes(url.pathname) ? 'GET' : 'POST')) fail(READS.includes(url.pathname) ? 'Use GET.' : 'Use POST.', 405);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail('Select a workspace first.');
    const broker = registry.broker(projectId), c = broker.get(registry.mainConversationId(projectId));
    if (url.searchParams.get('task')) fail('Timeline currently belongs to the main workspace conversation.', 409);
    // Checkpoints, undos and restores, with each folder's commits among them in time order. Commits are read only.
    if (url.pathname === '/api/checkpoints') {
      const entries = broker.checkpoints.timeline(c), oldest = entries.map(entry => entry.at).filter(Boolean).sort()[0] || null;
      const commits = timelineCommits(registry.get(projectId).folders, { since: oldest, runs: runWindows(entries), panel: c.gitCommits || [] });
      json(res, 200, { entries: [...entries, ...commits].sort((a, b) => String(b.at).localeCompare(String(a.at))) }); return true;
    }
    if (url.pathname === '/api/checkpoints/commit') {
      const folder = registry.get(projectId).folders.find(entry => entry.id === url.searchParams.get('folderId'));
      if (!folder) fail('That folder is no longer in this workspace.', 404);
      json(res, 200, timelineCommit(folder, url.searchParams.get('hash'))); return true;
    }
    const input = await body(req, 16000);
    if (url.pathname === '/api/checkpoints/preview') { json(res, 200, await broker.checkpoints.preview(c, input.target)); return true; }
    if (broker.running) fail('Wait for the current run to finish before undoing changes.', 409);
    const conversation = input.conversation == null ? null : Number.isSafeInteger(input.conversation?.count) && input.conversation.count > 0 ? { count: input.conversation.count } : fail('Review the conversation rewind again.');
    json(res, 200, await registry.withMutation(projectId, 'undo', () => broker.checkpoints.apply(c, input.target, input.digest, conversation)));
    return true;
  };
}

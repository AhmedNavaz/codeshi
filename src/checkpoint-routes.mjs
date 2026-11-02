// Undo and redo a run's changes from its checkpoints (#20). Preview reads only; applying holds the workspace's
// mutation lease, so no agent, patch or other undo can change the same folders meanwhile.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function createCheckpointRoutes({ registry, body, json }) {
  return async ({ req, res, url }) => {
    if (!['/api/checkpoints/preview', '/api/checkpoints/apply'].includes(url.pathname)) return false;
    if (req.method !== 'POST') fail('Use POST.', 405);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail('Select a workspace first.');
    const input = await body(req, 16000);
    const broker = registry.broker(projectId), c = broker.get(registry.mainConversation(projectId).id);
    if (url.pathname === '/api/checkpoints/preview') { json(res, 200, await broker.checkpoints.preview(c, input.target)); return true; }
    if (broker.running) fail('Wait for the current run to finish before undoing changes.', 409);
    json(res, 200, await registry.withMutation(projectId, 'undo', () => broker.checkpoints.apply(c, input.target, input.digest)));
    return true;
  };
}

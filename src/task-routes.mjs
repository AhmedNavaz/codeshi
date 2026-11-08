// Starting and finishing independent tasks (#88). Each answers for the workspace's main conversation, which records who owns what.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function createTaskRoutes({ registry, body, json }) {
  return async ({ req, res, url }) => {
    if (url.pathname !== '/api/tasks' && !url.pathname.startsWith('/api/tasks/')) return false;
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail('Select a workspace first.');
    const broker = registry.broker(projectId), c = broker.get(registry.mainConversationId(projectId)), tasks = broker.tasks;
    if (url.pathname === '/api/tasks') {
      if (req.method === 'GET') { json(res, 200, { tasks: tasks.list(c) }); return true; }
      if (req.method !== 'POST') fail('Use GET or POST.', 405);
      json(res, 202, tasks.start(c, await body(req)));
      return true;
    }
    if (req.method !== 'POST') fail('Use POST.', 405);
    const input = await body(req);
    if (url.pathname === '/api/tasks/plan') { json(res, 200, tasks.preview(c, input)); return true; }
    if (url.pathname === '/api/tasks/from-queue') { json(res, 202, tasks.fromQueue(c, input)); return true; }
    const match = url.pathname.match(/^\/api\/tasks\/([\da-f-]{36})\/(review|check|merge|keep|discard|start|close)$/);
    if (!match) fail('Not found.', 404);
    const [, id, action] = match;
    json(res, 200, action === 'review' ? tasks.review(c, id) : action === 'check' ? await tasks.check(c, id, input) : action === 'merge' ? await tasks.integrate(c, id, input) : action === 'keep' ? tasks.keep(c, id) : action === 'discard' ? tasks.discard(c, id) : action === 'start' ? tasks.resumeWaiting(c, id) : tasks.closeTask(c, id));
    return true;
  };
}

// The task board (#132). Every route answers for the workspace chat, whose journal holds the cards and their tasks.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function createBoardRoutes({ registry, body, json }) {
  return async ({ req, res, url }) => {
    if (url.pathname !== '/api/board' && !url.pathname.startsWith('/api/board/')) return false;
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail('Select a workspace first.');
    const broker = registry.broker(projectId), c = broker.get(registry.mainConversationId(projectId)), board = broker.board;
    if (url.pathname === '/api/board') {
      if (req.method !== 'GET') fail('Use GET.', 405);
      json(res, 200, board.view(c)); return true;
    }
    if (req.method !== 'POST') fail('Use POST.', 405);
    const input = await body(req, 256 * 1024);
    if (url.pathname === '/api/board/cards') { json(res, 201, { card: board.create(c, input), board: board.view(c) }); return true; }
    if (url.pathname === '/api/board/run') { const result = board.run(c, input); json(res, 202, { tasks: result.tasks, board: board.view(c) }); return true; }
    const match = url.pathname.match(/^\/api\/board\/cards\/([\da-f-]{36})\/(edit|move|remove|stop|accept|send-back)$/);
    if (!match) fail('Not found.', 404);
    const [, id, action] = match;
    const result = action === 'edit' ? board.edit(c, id, input) : action === 'move' ? board.move(c, id, input) : action === 'remove' ? board.remove(c, id) : action === 'stop' ? board.stop(c, id) : action === 'accept' ? board.accept(c, id) : board.sendBack(c, id, input);
    json(res, 200, { ...(result.id ? { card: result } : result), board: board.view(c) });
    return true;
  };
}

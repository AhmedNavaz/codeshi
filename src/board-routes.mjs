// The task board (#132). Every route answers for the workspace chat, whose journal holds the cards, their schedules and
// their tasks.
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
    if (url.pathname === '/api/board/export') {
      if (req.method !== 'GET') fail('Use GET.', 405);
      json(res, 200, { markdown: board.markdown(c), filename: 'codeshi-board.md' }); return true;
    }
    // A card's comments (#97), read when its drawer opens rather than with every board.
    const thread = url.pathname.match(/^\/api\/board\/cards\/([\da-f-]{36})\/comments$/);
    if (thread) {
      if (req.method !== 'GET') fail('Use GET.', 405);
      json(res, 200, { comments: board.comments(c, thread[1]) }); return true;
    }
    if (req.method !== 'POST') fail('Use POST.', 405);
    const input = await body(req, 256 * 1024);
    if (url.pathname === '/api/board/cards') { json(res, 201, { card: board.create(c, input), board: board.view(c) }); return true; }
    if (url.pathname === '/api/board/place') { const result = board.place(c, input); json(res, 200, { ...result, board: board.view(c) }); return true; }
    if (url.pathname === '/api/board/run') { const result = board.run(c, input); json(res, 202, { tasks: result.tasks, board: board.view(c) }); return true; }
    // Schedules (#132): a card or a prompt run at a set time.
    const schedules = broker.schedules;
    if (url.pathname === '/api/board/schedules') { json(res, 201, { schedule: schedules.create(c, input), board: board.view(c) }); return true; }
    const timed = url.pathname.match(/^\/api\/board\/schedules\/([\da-f-]{36})\/(edit|pause|resume|run|dismiss|remove)$/);
    if (timed) {
      const [, id, action] = timed;
      const result = action === 'edit' ? schedules.edit(c, id, input) : action === 'pause' ? schedules.pause(c, id, { paused: true }) : action === 'resume' ? schedules.pause(c, id, { paused: false }) : action === 'run' ? schedules.runNow(c, id) : action === 'dismiss' ? schedules.dismiss(c, id) : schedules.remove(c, id);
      json(res, 200, { ...(result.id ? { schedule: result } : result), board: board.view(c) });
      return true;
    }
    const match = url.pathname.match(/^\/api\/board\/cards\/([\da-f-]{36})\/(edit|move|remove|stop|accept|send-back|comment|uncomment)$/);
    if (!match) fail('Not found.', 404);
    const [, id, action] = match;
    if (action === 'comment' || action === 'uncomment') {
      const result = action === 'comment' ? { comment: board.comment(c, id, input) } : board.uncomment(c, id, input);
      json(res, action === 'comment' ? 201 : 200, { ...result, comments: board.comments(c, id), card: board.public(c, board.find(c, id)), board: board.view(c) });
      return true;
    }
    const result = action === 'edit' ? board.edit(c, id, input) : action === 'move' ? board.move(c, id, input) : action === 'remove' ? board.remove(c, id) : action === 'stop' ? board.stop(c, id) : action === 'accept' ? board.accept(c, id) : board.sendBack(c, id, input);
    json(res, 200, { ...(result.id ? { card: result } : result), board: board.view(c) });
    return true;
  };
}

import { captureReview, fixPrompt, listReviewChanges, publicReview, reviewAgents, reviewFreshness, reviewLimits } from './agent-review.mjs';
import { ReviewJobs, reviewRequestKey } from './review-jobs.mjs';
import { automaticReviewPlan } from './automatic-review.mjs';
import { AutomaticReviewRuns } from './automatic-review-runs.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function createReviewRoutes({ registry, body, json }) {
  const jobs = new ReviewJobs(), controllers = new Set();
  const route = async ({ req, res, url }) => {
    if (url.pathname !== '/api/reviews' && !url.pathname.startsWith('/api/reviews/')) return false;
    const projectId = url.searchParams.get('projectId'), taskId = url.searchParams.get('task');
    if (!projectId) fail('Select a workspace first.');
    if (taskId !== null && !/^[\da-f-]{36}$/.test(taskId)) fail('Choose a task from this workspace.');
    let project, broker, c, agents, task = null;
    // The workspace chat reviews the workspace's folders. A task (#88) reviews only its own folder or copy, in its own
    // conversation, so its review, findings and fix request stay with the task.
    const scope = () => {
      const workspace = registry.broker(projectId), home = workspace.get(registry.mainConversationId(projectId));
      if (taskId) { const found = workspace.tasks.reviewScope(home, taskId); ({ project, task } = found); broker = found.lane.broker; c = found.lane.c; }
      else { project = registry.get(projectId); broker = workspace; c = home; }
      agents = reviewAgents(c);
      return { workspace, home };
    };
    scope();
    const shownTask = () => task && { id: task.id, title: task.title, folderName: task.folderName, mode: task.mode || 'direct' };
    const selected = () => { const id = url.pathname.match(/^\/api\/reviews\/([a-f0-9-]{36})(?:\/(?:prepare-fix|stop))?$/)?.[1]; const review = c.reviews.find(item => item.id === id); if (!review) fail(task ? 'Review not found in this task.' : 'Review not found in this workspace.', 404); return review; };
    // A task's goal is what it was asked to do, not the workspace's wider goal.
    const goal = () => ((task ? '' : c.context.goal) || c.messages.filter(message => message.role === 'user' && !message.reviewId).at(-1)?.text || '').slice(0, 4000);
    if (req.method === 'GET' && url.pathname === '/api/reviews') {
      json(res, 200, { ...agents, reviewerModel: c.models[agents.reviewer] || null, limits: reviewLimits, goal: goal(), ...(task ? { task: shownTask() } : {}), repositories: listReviewChanges(project.folders), reviews: c.reviews.map((review, index) => ({ ...publicReview(review), ...(index === 0 ? reviewFreshness(review, project.folders) : {}) })) }); return true;
    }
    if (req.method === 'GET') { const review = selected(); json(res, 200, { ...review, ...reviewFreshness(review, project.folders) }); return true; }
    if (req.method !== 'POST') fail('Use POST to preview or start a review.', 405);
    const input = await body(req, url.pathname === '/api/reviews/automatic/preview' ? 512000 : 32000);
    // Folder membership can change while a request body arrives; use the current broker and roots.
    const { workspace, home } = scope();
    if (url.pathname === '/api/reviews/automatic/preview') {
      if (task) fail('Automatic review is set up from the workspace chat.', 409);
      if (broker.running || broker.backgroundReview) fail('Finish the current run and review before configuring automatic review.', 409);
      const folderIds = input.folderIds ?? listReviewChanges(project.folders).filter(repo => repo.available).map(repo => repo.folderId);
      const plan = automaticReviewPlan(broker, c, { ...input, folderIds });
      if (!broker.automaticReviews) { broker.automaticReviews = new AutomaticReviewRuns({ broker, jobs, project: () => registry.get(projectId) }); controllers.add(broker.automaticReviews); }
      json(res, 200, plan); return true;
    }
    if (url.pathname.endsWith('/stop')) { const review = selected(); json(res, 200, jobs.stop(task ? project.id : projectId, review.id)); return true; }
    if (url.pathname === '/api/reviews/preview') {
      if (broker.running) fail(task ? 'Wait for this task’s run to finish before preparing a review.' : 'Wait for the current run to finish before preparing a review.', 409);
      json(res, 200, { ...agents, snapshot: captureReview(project.folders, input.files) }); return true;
    }
    if (url.pathname === '/api/reviews/start') {
      if (input.background === true && c.reviewRequests[input.requestId]) { const accepted = c.reviewRequests[input.requestId]; if (accepted.fingerprint !== reviewRequestKey(input)) fail('This request ID was used for another review.', 409); json(res, 202, { ...accepted, duplicate: true }); return true; }
      if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 4000) fail('Describe the goal in at most 4,000 characters.');
      if (typeof input.approvedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.approvedDigest)) fail('Preview the selected changes before starting.');
      const snapshot = captureReview(project.folders, input.files);
      if (snapshot.digest !== input.approvedDigest) fail('The selected changes have changed. Preview them again.', 409);
      const review = { snapshot, goal: input.goal.trim(), builder: agents.builder, ...(agents.builderConnection ? { builderConnection: agents.builderConnection, builderModel: agents.builderModel } : {}), provider: agents.reviewer, model: c.models[agents.reviewer] || null };
      // A task's reviewer is one more agent working at once, so it counts against Tasks at once like the task's own run.
      if (task) { if (input.background !== true) fail('A task’s review runs on a copy of its files. Start it again.'); if (!c.reviewRequests[input.requestId]) workspace.tasks.admit(home, null); }
      if (input.background === true) { json(res, 202, jobs.start(project, broker, c, review, input)); return true; }
      const result = broker.start(c, { text: `Review selected changes: ${review.goal}`, provider: agents.reviewer, model: review.model, mode: 'read', requestId: input.requestId, billingConfirmed: input.billingConfirmed === true }, { review, verifyReview: () => {
        if (captureReview(registry.get(projectId).folders, input.files).digest !== input.approvedDigest) fail('The selected changes have changed. Preview them again.', 409);
      } });
      json(res, 202, { ...result, reviewId: result.runId }); return true;
    }
    if (url.pathname.endsWith('/prepare-fix')) {
      const review = selected();
      if (broker.running) fail('Wait for the current run to finish before preparing fixes.', 409);
      if (reviewFreshness(review, project.folders).stale) fail('This review is outdated. Run a new review before preparing fixes.', 409);
      json(res, 200, { provider: review.builder, text: fixPrompt(review, input.findingIds) }); return true;
    }
    fail('Review operation not found.', 404);
  };
  route.close = () => { for (const controller of controllers) controller.closed = true; return jobs.close(); };
  return route;
}

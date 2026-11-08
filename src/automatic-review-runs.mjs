import { captureAutomaticReview, automaticReviewContextDigest } from './automatic-review.mjs';

// One authorized build followed by one snapshot review. Fixes always go through the existing findings picker and
// a separate Send. This controller shares the ordinary review jobs, account gates and cancellation path.
export class AutomaticReviewRuns {
  constructor({ broker, jobs, project }) { Object.assign(this, { broker, jobs, project }); this.closed = false; }

  phase(c, run, status, summary, reviewId) {
    this.broker.record(c, { type: 'automatic_review_phase', runId: run.id, phase: { status, summary, ...(reviewId ? { reviewId } : {}) } });
    this.broker.record(c, { type: 'message', message: { id: `automatic-review-${run.id}-${status}`, role: 'activity',
      text: `Tag-team review: ${summary}`, runId: run.id, provider: run.provider, createdAt: new Date().toISOString() } });
  }

  finish(c, run, status, summary, reviewId) {
    this.phase(c, run, status, summary, reviewId);
    if (c.queue.length && !c.queuePaused) this.broker.queue.pause(c, 'Automatic review stopped here. Check the result before resuming queued prompts.');
    this.broker.emit('notify', { conversationId: c.id, kind: status === 'complete' || status === 'skipped' ? 'finished' : 'stopped', title: 'Tag-team review', body: summary });
  }

  runEnded(c, run, status) {
    const plan = run.automaticReview;
    if (!plan) return false;
    const current = c.runs.find(item => item.id === run.id)?.automaticReview;
    if (!current || current.status !== 'building') {
      if (c.queue.length && !c.queuePaused) this.broker.queue.pause(c, 'Automatic review stopped here. Check the result before resuming queued prompts.');
      return true;
    }
    if (!this.broker.execution.allows(c, run.execution, { action: 'review', sequence: true }) || this.closed || status !== 'complete' || run.hadPendingInput || run.persistenceError) {
      this.finish(c, run, status === 'interrupted' || this.closed ? 'interrupted' : 'blocked', 'The build did not finish cleanly. Start a new review when ready.');
      return true;
    }
    if (this.broker.running || c.lastRun?.id !== run.id || this.broker.workspaceSignature !== plan.workspaceSignature || automaticReviewContextDigest(c) !== plan.contextDigest) {
      this.finish(c, run, 'blocked', 'The task or workspace changed. Authorize a new review.'); return true;
    }
    let lease;
    try {
      lease = this.broker.acquireMutation('automatic-review');
      const project = this.project(), snapshot = captureAutomaticReview(plan, project.folders);
      if (!snapshot) { this.finish(c, run, 'skipped', 'No reviewable text changes in the selected folders.'); return true; }
      const result = this.jobs.start(project, this.broker, c, { snapshot, goal: plan.goal, builder: run.provider,
        provider: plan.reviewer, model: plan.model, builderRunId: run.id }, { requestId: `automatic-review-${run.id}`, goal: plan.goal,
        files: snapshot.files.map(({ folderId, path }) => ({ folderId, path })), approvedDigest: snapshot.digest, billingConfirmed: plan.billingConfirmed }, { execution: run.execution, sequence: true });
      this.phase(c, run, 'reviewing', 'Reviewing the captured changes. You can compose your next prompt.', result.reviewId);
      const job = this.broker.backgroundReview;
      job.done.then(() => {
        const review = c.reviews.find(item => item.id === result.reviewId);
        const state = review?.status === 'complete' ? review.findings.length ? 'needs-fixes' : 'complete' : review?.status === 'interrupted' ? 'interrupted' : 'blocked';
        const summary = state === 'needs-fixes' ? `${review.findings.length} review finding${review.findings.length === 1 ? '' : 's'}. Choose findings before preparing fixes.`
          : state === 'complete' ? 'Review finished with no actionable findings in the captured scope.' : review?.summary || 'The review did not finish. Start a new review when ready.';
        this.finish(c, run, state, summary, result.reviewId);
      }).catch(error => console.error('Codeshi could not save the automatic review result:', error.message));
    } catch (error) { this.finish(c, run, 'blocked', `Review not started: ${error.message}`); }
    finally { lease?.release(); }
    return true;
  }

  invalidate(c, run, reason) {
    if (run?.automaticReview && c.runs.find(item => item.id === run.id)?.automaticReview?.status === 'building') this.finish(c, run, 'blocked', reason);
  }
}

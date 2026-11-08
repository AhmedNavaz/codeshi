import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Broker } from './broker.mjs';
import { copyReviewFiles, reviewFreshness } from './agent-review.mjs';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
// What the reviewer used, for the task's totals (#84). The reviewer's own journal goes away with its temporary folder.
const reviewCost = run => ({ ...(run?.usage ? { usage: run.usage } : {}), ...(typeof run?.costUSD === 'number' ? { costUSD: run.costUSD } : {}), ...(run?.account?.billingSource ? { billingSource: run.account.billingSource } : {}) });
export const reviewRequestKey = input => createHash('sha256').update(JSON.stringify({ goal: input.goal, files: input.files, approvedDigest: input.approvedDigest })).digest('hex');

export class ReviewJobs {
  constructor() { this.jobs = new Map(); this.closing = false; }
  async close() { this.closing = true; await Promise.all([...this.jobs.values()].map(job => job.worker.close())); await Promise.all([...this.jobs.values()].map(job => job.done)); }
  stop(projectId, reviewId) {
    const job = this.jobs.get(projectId);
    if (!job || job.id !== reviewId) fail('This review is no longer running.');
    return job.worker.stop(job.conversation.id);
  }
  start(project, main, c, review, input, { execution = null, sequence = false } = {}) {
    if (this.closing) fail('Codeshi is shutting down.');
    const fingerprint = reviewRequestKey(input), accepted = c.reviewRequests[input.requestId];
    if (accepted) { if (accepted.fingerprint !== fingerprint) fail('This request ID was used for another review.'); return { ...accepted, duplicate: true }; }
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId)) fail('Invalid review request ID.', 400);
    const parent = c.activeRun || c.lastRun, taskId = parent?.taskId || parent?.id || null;
    execution ||= main.execution.token(c, taskId);
    if (execution) main.execution.assert(c, execution, { action: sequence ? 'review' : 'manual', sequence: sequence, provider: review.provider, model: review.model });
    main.admit?.(c);
    main.budget.assertCanStart(c, { task: taskId ? { id: taskId, relation: 'review' } : null, provider: review.provider, model: review.model });
    if (this.jobs.has(project.id)) fail('A background review is already running in this workspace.');
    if (this.jobs.size >= 4) fail('Four background reviews are running. Wait for one to finish.');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-review-'));
    fs.chmodSync(directory, 0o700);
    let worker, savedId;
    try {
      const folders = copyReviewFiles(review.snapshot, project.folders, path.join(directory, 'snapshot'));
      if (reviewFreshness(review, project.folders).stale) fail('The selected changes moved. Refresh the review preview.');
      worker = new Broker({ workspace: folders[0].path, workspaces: folders.map(folder => folder.path), workspaceFolders: folders, bins: main.configuredBins, dataDir: path.join(directory, 'journal') });
      const conversation = worker.get(worker.create().id), id = randomUUID();
      const budgetTaskId = taskId || id;
      // The copied-files worker has no previous task history. Its native API cap must come from its parent's remaining
      // allowance, and the parent's monitor below enforces all measured limits against the shared, durable totals.
      worker.budget.remainingSpend = () => main.budget.remainingSpend(c, budgetTaskId);
      worker.updateContext(conversation, c.context);
      // Save ownership before launching a provider. A crash in either journal can then be recovered as interrupted.
      main.record(c, { type: 'background_review', taskId: budgetTaskId, parentRunId: parent?.id || null, review: { ...review, id, requestId: input.requestId, fingerprint, background: true, startedAt: new Date().toISOString(), status: 'running', findings: [] } });
      savedId = id;
      let budgetSample = null, watchedRun = null;
      const progress = () => {
        const current = c.reviews.find(item => item.id === id), run = conversation.activeRun;
        if (current && run?.pid && current.pid !== run.pid) main.record(c, { type: 'review_process', id, pid: run.pid, pidStart: run.pidStart });
        if (current && run && worker.running) {
          const entry = conversation.taskBudgets?.[run.taskId]?.active[run.id];
          const sample = { began: Boolean(entry?.began), metadata: { ...(run.usage ? { usage: run.usage } : {}), ...(typeof run.costUSD === 'number' ? { costUSD: run.costUSD } : {}), ...(run.account ? { account: run.account } : {}), ...(run.effectiveModel ? { effectiveModel: run.effectiveModel } : {}) } };
          const signature = JSON.stringify(sample);
          if (signature !== budgetSample) { main.record(c, { type: 'review_budget', id, ...sample }); budgetSample = signature; }
          watchedRun = worker.running;
          if (!main.budget.watches.has(watchedRun.id)) main.budget.watch(watchedRun, { owner: worker, c, taskId: budgetTaskId, recordRunId: id });
          main.budget.check(watchedRun);
        }
        if (current && run) { current.progress = { phase: run.phase, toolCount: run.toolCount || 0, startedAt: run.startedAt }; main.emit('update', { conversationId: c.id }); }
      };
      // Persist the worker PID in the main journal before its start message can launch the native provider.
      worker.on('update', progress);
      const result = worker.start(conversation, { text: 'Review approved changes: ' + review.goal, provider: review.provider, model: review.model, mode: 'read', requestId: input.requestId, billingConfirmed: input.billingConfirmed === true }, { review: { ...review, background: true }, verifyReview() {}, verifyExecution: () => { if (execution) main.execution.assert(c, execution, { action: sequence ? 'review' : 'manual', sequence: sequence, provider: review.provider, model: review.model }); } });
      const job = { id, worker, conversation, directory, done: null }; this.jobs.set(project.id, job); main.backgroundReview = job;
      progress();
      job.done = worker.running.done.then(async () => {
        const report = conversation.reviews[0];
        // Preserve the worker's measured activity before its temporary journal is deleted. A review is a model run,
        // including its tools and interventions, rather than just its final answer and token count.
        const measured = (await worker.ledger(conversation)).runs.at(-1);
        const failure = report?.status === 'failed' ? conversation.messages.filter(message => message.role === 'error').at(-1)?.text?.split('\n')[0].slice(0, 1000) : null;
        main.record(c, { type: 'review_result', id, result: { ...reviewCost(conversation.lastRun), status: report?.status || 'failed', summary: failure || report?.summary || 'Review did not finish.', findings: report?.findings || [], errorCategory: conversation.lastRun?.errorCategory || null, rawResponse: conversation.messages.filter(message => message.role === 'assistant').at(-1)?.text?.slice(0, 64000), elapsedMs: measured?.elapsedMs ?? conversation.lastRun?.elapsedMs, effectiveModel: measured?.effectiveModel ?? conversation.lastRun?.effectiveModel,
          accounting: measured ? { sourceRunId: measured.runId, effort: measured.effort, tools: measured.tools, approvals: measured.approvals, interventions: measured.interventions, compactions: measured.compactions, compactionEvents: measured.compactionEvents } : null } });
      }).catch(error => {
        main.record(c, { type: 'review_result', id, result: { status: 'failed', summary: error.message, findings: [] } });
      }).finally(async () => {
        if (watchedRun) main.budget.unwatch(watchedRun);
        await worker.close(); fs.rmSync(directory, { recursive: true, force: true });
        if (main.backgroundReview === job) delete main.backgroundReview;
        if (this.jobs.get(project.id) === job) this.jobs.delete(project.id);
        main.emit('update', { conversationId: c.id });
      });
      job.done.catch(() => {});
      return { reviewId: id, runId: result.runId, requestId: input.requestId, background: true };
    } catch (error) {
      if (savedId) main.record(c, { type: 'review_result', id: savedId, result: { status: 'failed', summary: error.message, findings: [] } });
      if (worker) worker.close().finally(() => fs.rmSync(directory, { recursive: true, force: true })).catch(() => {}); else fs.rmSync(directory, { recursive: true, force: true }); throw error;
    }
  }
}

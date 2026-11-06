import { randomUUID } from 'node:crypto';
import { providerUsage } from './providers.mjs';
import { runSteps } from './recap.mjs';
import { workspaceBaseline } from './workspace-baseline.mjs';
import { assessQuota } from './task-budget.mjs';

// Checking routed runs with the workspace's own tests (#12, stage 2). With Check with tests on, a routed run that
// changed files is followed by the workspace's test command, the one marked for checks in the Run panel, never a
// command from the agent or the repository. It runs as the usual Test session, so it shows in that panel and Stop works.
//
// When the tests fail, routing tries once more one step up: the same agent, so it keeps its session, with a stronger
// model or more effort, told what failed. Balanced and Maximum quality retry on their own unless that agent is close
// to its limit; Cost saving, and a retry that would go past the limit, ask first. A retry is never retried: if the
// tests still fail, the work stops there. Queued prompts wait for the check and only carry on once the tests pass.
export const CHECK_LIMIT_MS = 10 * 60 * 1000;
export const CHECK_PAUSE = 'The tests failed after the last run.';
const OUTPUT_TAIL = 4000;
const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
const AUTOMATIC = { balanced: 80, quality: 90 };
const seconds = ms => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;
const effortName = effort => effort ? `${effort[0].toUpperCase()}${effort.slice(1)} effort` : '';
export const stepName = step => [names[step.provider], step.modelName || step.model, effortName(step.effort)].filter(Boolean).join(' · ');

// What the agent is told when it retries: what ran, how it ended, and the end of its output.
export function retryPrompt(command, result) {
  return [`The project's tests failed after your changes. Find the cause and fix it so they pass. Don't skip, delete or weaken tests to make them pass.`,
    '', `Test command: ${command.command}${command.directory ? ` (in ${command.directory})` : ''}`, `Exit code: ${result.exitCode ?? 'none'}`, '', 'End of the output:', '```', result.output.trim() || '(no output)', '```'].join('\n');
}

// A workspace's Git state, for telling whether a run changed anything its steps didn't name.
const gitState = baseline => baseline?.git ? JSON.stringify([baseline.head, baseline.statusHash, (baseline.folders || []).map(folder => [folder.id, folder.head, folder.statusHash])]) : null;

export class RunChecks {
  constructor(broker, { tests = null, usage = providerUsage, limitMs = CHECK_LIMIT_MS } = {}) {
    Object.assign(this, { broker, tests, usage, limitMs });
    this.closed = false; this.pending = new Set();
  }

  // A check cut short by a restart ends as interrupted, and the queue it held waits for the person.
  restore() {
    for (const c of this.broker.conversations.values()) {
      const run = c.runs?.findLast(item => item.check?.status === 'running');
      if (!run) continue;
      this.finish(c, run.id, run.check, { status: 'interrupted', exitCode: null, output: '' }, 0);
      if (c.queue.length && !c.queuePaused) this.broker.queue.pause(c, 'Codeshi restarted while the tests were running.');
    }
  }

  // The command marked for checks when a finished run should be checked: a complete routed run, with Check with tests on,
  // that changed files. A retry is always checked, so its result is known even if it changed nothing.
  wanted(c, run, status) {
    if (this.closed || !this.tests || status !== 'complete' || run.review || run.local || !run.routing || c.routing?.check !== true) return null;
    let command = null;
    try { command = this.tests.saved(); } catch { return null; }
    if (!command?.command) return null;
    return run.retryOf || this.changed(c, run) ? command : null;
  }

  changed(c, run) {
    if (runSteps(c.messages.filter(message => message.runId === run.id)).files.length) return true;
    const before = gitState(run.baseline);
    if (!before) return false;
    try { return gitState(workspaceBaseline(this.broker.workspace, this.broker.workspaceFolders)) !== before; } catch { return false; }
  }

  // Called once a run has ended. True when a check started, which then decides when queued prompts continue.
  runEnded(c, run, status) {
    const command = this.wanted(c, run, status);
    if (!command) return false;
    const task = this.check(c, run, command).catch(error => { console.error('Codeshi could not check the run:', error.message); this.hold(c, `Checking the run failed: ${error.message}`); });
    this.pending.add(task); task.finally(() => this.pending.delete(task));
    return true;
  }

  async check(c, run, command) {
    const started = Date.now(), messageId = randomUUID(), check = { status: 'running', command: command.command, messageId, startedAt: new Date(started).toISOString() };
    this.broker.record(c, { type: 'message', message: { id: messageId, role: 'activity', text: `Tests running: ${command.command}`, provider: run.provider, runId: run.id, status: 'running', createdAt: check.startedAt } });
    this.broker.record(c, { type: 'check', runId: run.id, check });
    const result = await this.execute();
    if (this.closed) return;
    this.finish(c, run.id, check, result, Date.now() - started);
    if (run.automaticReview) {
      if (result.status === 'passed') this.broker.automaticReviews.runEnded(c, run, 'complete');
      else this.broker.automaticReviews.invalidate(c, run, 'The build checks did not pass. Review stopped; inspect the test result before continuing.');
      return;
    }
    if (result.status === 'failed') return this.failed(c, run, command, result);
    if (result.status === 'timed-out') return this.hold(c, 'The tests didn’t finish after the last run.', 'The tests didn’t finish', 'They ran for 10 minutes and were stopped.');
    // Passed, stopped by the person, or skipped because the test command was already running: carry on.
    if (result.status === 'passed' && c.queuePaused?.reason === CHECK_PAUSE) this.broker.record(c, { type: 'queue_resume' });
    this.carryOn(c);
  }

  // Runs the test command and waits for it, stopping it at the time limit.
  async execute() {
    let session;
    try { session = this.tests.run(); }
    catch (error) { return error.status === 409 ? { status: 'skipped', exitCode: null, output: error.message } : { status: 'failed', exitCode: null, output: error.message }; }
    let timer, timedOut = false;
    const limit = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, this.limitMs); timer.unref?.(); });
    await Promise.race([session.done, limit]);
    clearTimeout(timer);
    if (timedOut) await session.stop().catch(() => {});
    const view = session.view();
    const status = timedOut ? 'timed-out' : view.status === 'stopped' ? 'stopped' : view.status === 'exited' ? 'passed' : 'failed';
    return { status, exitCode: view.exitCode ?? null, output: String(view.output || view.error || '').slice(-OUTPUT_TAIL) };
  }

  // The result goes on the run's timeline and into its history.
  finish(c, runId, check, result, durationMs) {
    const word = { passed: 'passed', failed: 'failed', 'timed-out': 'timed out', stopped: 'stopped', skipped: 'skipped', interrupted: 'interrupted' }[result.status];
    const line = { passed: `Passed in ${seconds(durationMs)}.`, failed: `Exit code ${result.exitCode ?? 'none'} after ${seconds(durationMs)}.`,
      'timed-out': 'Still running after 10 minutes, so it was stopped. A test command that watches for changes never finishes; mark one that exits.',
      stopped: 'Stopped before it finished.', skipped: 'The test command was already running, so this run wasn’t checked.', interrupted: 'Codeshi closed while the tests were running.' }[result.status];
    const output = result.status === 'skipped' || !result.output.trim() ? '' : `\n\n${result.output.trim()}`;
    this.broker.record(c, { type: 'message_update', id: check.messageId, update: { text: `Tests ${word}: ${check.command}\n${line}${output}`, status: 'complete' } });
    this.broker.record(c, { type: 'check', runId, check: { ...check, status: result.status, exitCode: result.exitCode, durationMs } });
  }

  // Failed tests: retry one step up, offer to, or stop there.
  async failed(c, run, command, result) {
    const step = run.routing?.escalation, agent = names[run.provider];
    if (run.retryOf || !step) return this.hold(c, CHECK_PAUSE, run.retryOf ? 'Tests still fail' : 'Tests failed', run.retryOf ? `They still fail after ${agent} tried again. Open the workspace to see why.` : `${agent} can’t go a step higher. Open the workspace to see what failed.`);
    // Someone started another run while the tests ran: theirs comes first, and this result stays on the timeline.
    if (this.broker.running) return;
    const automatic = AUTOMATIC[run.routing.mode];
    const blocked = automatic ? await this.limited(step, automatic) : null;
    if (this.closed || this.broker.running) return;
    if (automatic && !blocked) {
      try { this.retry(c, run, step, command, result); return; }
      catch (error) { return this.hold(c, `The retry could not start: ${error.message}`, 'Tests failed', `The retry with ${stepName(step)} could not start.`); }
    }
    const offer = { id: randomUUID(), runId: run.id, provider: step.provider, model: step.model || null, modelName: step.modelName || null, effort: step.effort || null, tier: step.tier || null, mode: run.mode, approvalPolicy: run.approvalPolicy, billingConfirmed: run.billingConfirmed === true, routingMode: run.routing.mode, command: command.command, directory: command.directory || '', exitCode: result.exitCode, output: result.output, ...(blocked ? { blocked } : {}), createdAt: new Date().toISOString() };
    this.broker.record(c, { type: 'retry_offer', offer });
    this.hold(c, CHECK_PAUSE, 'Tests failed', `Retry with ${stepName(step)}?`);
  }

  // Why an automatic retry should wait for the person: the agent has reached, or is close to, its limit.
  async limited(step, threshold) {
    let usage = null;
    try { usage = await this.usage(step.provider, this.broker.usageOptions(step.provider)); } catch { return `${names[step.provider]}'s allowance could not be checked`; }
    const quota = assessQuota(usage, step.model, { threshold });
    if (quota.state === 'unknown' || quota.state === 'stale') return `${names[step.provider]}'s allowance is ${quota.state}`;
    if (quota.state === 'exhausted') return `${names[step.provider]} has reached its limit`;
    return quota.state === 'near' ? `${names[step.provider]} is at ${Math.round(quota.usedPercent)}% of its limit` : null;
  }

  retry(c, run, step, command, result) {
    return this.broker.start(c, { text: retryPrompt(command, result), provider: step.provider, model: step.model || null, effort: step.effort || null, mode: run.mode, approvalPolicy: run.approvalPolicy, billingConfirmed: run.billingConfirmed === true,
      routing: { mode: run.routing.mode, tier: step.tier, reason: 'The tests failed, so one step up' }, requestId: `retry-${run.id}` }, { retryOf: run.id });
  }

  // A retry the person accepted from an offer.
  accept(c, offerId) {
    const offer = c.retryOffer;
    if (!offer || offer.id !== offerId) throw Object.assign(new Error('This retry is no longer offered.'), { status: 409 });
    if (this.broker.running) throw Object.assign(new Error('An agent is working in this workspace. Retry once it finishes.'), { status: 409 });
    if (c.lastRun?.id !== offer.runId) throw Object.assign(new Error('Another run has finished since. Send a new message instead.'), { status: 409 });
    this.broker.record(c, { type: 'retry_offer_end', id: offer.id, outcome: 'accepted' });
    const run = { id: offer.runId, mode: offer.mode, approvalPolicy: offer.approvalPolicy, billingConfirmed: offer.billingConfirmed, routing: { mode: offer.routingMode } };
    return this.retry(c, run, offer, { command: offer.command, directory: offer.directory }, { exitCode: offer.exitCode, output: offer.output });
  }
  dismiss(c, offerId) {
    if (c.retryOffer?.id === offerId) this.broker.record(c, { type: 'retry_offer_end', id: offerId, outcome: 'dismissed' });
  }

  // Queued prompts wait while the tests fail; the person sees why.
  hold(c, reason, title, body) {
    if (c.queue.length && !c.queuePaused) this.broker.queue.pause(c, reason);
    if (title) this.broker.emit('notify', { conversationId: c.id, kind: 'stopped', title, body });
  }
  carryOn(c) { if (c.queue.length && !c.queuePaused) setTimeout(() => this.broker.queue.tick(c), 0); }

  close() { this.closed = true; }
}

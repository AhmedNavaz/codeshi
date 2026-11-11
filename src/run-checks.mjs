import { randomUUID } from 'node:crypto';
import { isAntigravityACP } from './antigravity.mjs';
import { captureReview, listReviewChanges, reviewLimits } from './agent-review.mjs';
import { providerUsage } from './providers.mjs';
import { runSteps } from './recap.mjs';
import { usualWindowSpend } from './usage-watch.mjs';
import { workspaceBaseline } from './workspace-baseline.mjs';
import '../public/routing.js';

// Checking routed runs with the workspace's own tests (#12, stage 2; #128). With Check with tests on, a routed run that
// changed files is followed by the workspace's test command, the one marked for checks in the Run panel, never a
// command from the agent or the repository. It runs as the usual Test session, so it shows in that panel and Stop works.
//
// When the tests fail, routing tries once more one step up: the same agent, so it keeps its session, with a stronger
// model or more effort, told what failed. Smart and Ultra retry on their own while that agent is under the mode's
// handoff line (#12), the same line that decides whether a running task moves; Saver, and a retry past that line, ask
// first. A retry is never retried: if the tests still fail, the work stops there. In Ultra, once the tests pass and a
// second subscription agent has room under that line, the finished changes are sent for an independent read-only review
// (#15) within the task budget. Queued prompts wait for the check.
export const CHECK_LIMIT_MS = 10 * 60 * 1000;
export const CHECK_PAUSE = 'The tests failed after the last run.';
const OUTPUT_TAIL = 4000;
const names = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
// Modes that retry without asking. Saver asks first: it keeps extra work restrained (#128).
const AUTOMATIC = new Set(['smart', 'ultra']);
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
      if (!run || run.check?.status !== 'running') continue;
      this.finish(c, run.id, run.check, { status: 'interrupted', exitCode: null, output: '' }, 0);
      if (c.queue.length && !c.queuePaused) this.broker.queue.pause(c, 'Codeshi restarted while the tests were running.');
    }
  }

  // The command marked for checks when a finished run should be checked: a complete routed run (not a planning run), with Check with tests on,
  // that changed files. A retry is always checked, so its result is known even if it changed nothing.
  wanted(c, run, status) {
    if (!this.broker.execution.allows(c, run.execution, { action: 'check', sequence: Boolean(run.automaticReview) }) || this.closed || !this.tests || status !== 'complete' || run.review || run.orchestrate || run.local || !run.routing || c.routing?.check !== true) return null;
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
    // This is only the routine post-run loop. A deliberately selected review workflow or a test repair still checks.
    // The native agent receives the same cadence and handles explicit test/finalization requests before publication.
    if (run.verification?.cadence === 'review-first' && !run.retryOf && !run.automaticReview) {
      this.broker.record(c, { type: 'check', runId: run.id, check: { status: 'deferred', command: command.command, reason: 'review-first' } });
      this.broker.record(c, { type: 'message', message: { id: randomUUID(), role: 'activity', text: `Tests deferred: ${command.command}\nReview first is on. Codeshi did not run its automatic test command or start a test-repair loop. The agent follows your explicit test and finalization requests; no Codeshi-managed test result is available for this run.`, provider: run.provider, runId: run.id, status: 'complete', createdAt: new Date().toISOString() } });
      return false;
    }
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
    if (!this.broker.execution.allows(c, run.execution, { action: 'manual' })) return;
    if (run.automaticReview) {
      if (result.status === 'passed') this.broker.automaticReviews.runEnded(c, run, 'complete');
      else this.broker.automaticReviews.invalidate(c, run, 'The build checks did not pass. Review stopped; inspect the test result before continuing.');
      return;
    }
    if (result.status === 'failed') return this.failed(c, run, command, result);
    if (result.status === 'timed-out') return this.hold(c, 'The tests didn’t finish after the last run.', 'The tests didn’t finish', 'They ran for 10 minutes and were stopped.');
    // Passed, stopped by the person, or skipped because the test command was already running: carry on.
    if (result.status === 'passed' && c.queuePaused?.reason === CHECK_PAUSE) this.broker.record(c, { type: 'queue_resume' });
    if (result.status === 'passed' && globalThis.relayRouting.normalizeMode(run.routing?.mode) === 'ultra') {
      if (await this.reviewUltra(c, run)) return;
    }
    this.carryOn(c);
  }


  // Ultra (#128): with a second subscription agent connected with confirmed room, sends the finished changes for one
  // independent read-only review (#15) within the task budget. Sequential after the build and check, never a race (#16).
  async reviewUltra(c, run) {
    if (!this.broker.execution.allows(c, run.execution, { action: 'review' }) || this.closed || this.broker.running || this.broker.backgroundReview || c.lastRun?.id !== run.id) return false;
    const folders = this.broker.workspaceFolders;
    let repos = [];
    try { repos = listReviewChanges(folders).filter(repo => repo.available && !repo.error && !repo.changesClipped); } catch { return false; }
    const selections = [];
    for (const repo of repos) for (const file of repo.changes) {
      if (file.reason) continue;
      const selection = { folderId: repo.folderId, path: file.path };
      try { captureReview(folders, [selection]); selections.push(selection); } catch { continue; }
      if (selections.length > reviewLimits.files) return false;
    }
    if (!selections.length) return false;
    let snapshot;
    try { snapshot = captureReview(folders, selections); } catch { return false; }

    const candidates = [], taskId = run.taskId || run.id;
    for (const provider of this.broker.availableProviders().filter(value => value !== run.provider)) {
      const options = this.broker.usageOptions(provider);
      if (provider === 'gemini' && isAntigravityACP(options.bin)) continue;
      let account, usage, models;
      try {
        account = await this.broker.handoff.account(provider, { bin: options.bin, workspace: this.broker.workspace, googleRoot: this.broker.googleRoot });
        if (!account?.installed || account.authenticated === false || account.billingSource !== 'subscription') continue;
        usage = await this.usage(provider, options);
        this.broker.observeQuota(c, provider, usage);
        models = await this.broker.handoff.modelRows(provider);
      } catch { continue; }
      const allowed = model => this.broker.execution.allows(c, run.execution, { action: 'review', provider, model }) && !this.broker.budget.refusal(c, { task: { id: taskId, relation: 'review' }, provider, model, previousProvider: run.provider });
      const allowedModels = models.map(row => row.id || row.model || row.value).filter(id => id && allowed(id));
      if (models.length ? !allowedModels.length : !allowed(null)) continue;
      const usualSpend = usualWindowSpend(c, provider);
      candidates.push({ provider, models, billingSource: 'subscription', usage, eligible: true, ...(models.length ? { allowedModels } : {}), ...(usualSpend ? { usualSpend } : {}) });
    }
    if (!candidates.length || this.closed || this.broker.running || c.lastRun?.id !== run.id) return false;
    const goal = (c.messages.find(message => message.role === 'user' && message.runId === (run.retryOf || run.id))?.text || run.prompt || c.context?.goal || 'Review the finished changes').slice(0, 4000);
    // The task's own mode and rating (#12). A reviewer is extra work on another agent, so like a handoff destination it
    // needs room under the mode's line for a usual run; an agent past it is never asked to review.
    const mode = globalThis.relayRouting.normalizeMode(run.routing?.mode) || 'ultra', assessment = run.routing?.assessment?.tier ? run.routing.assessment : null;
    const choice = globalThis.relayRouting.route({ text: goal, assessment, mode, candidates });
    if (choice.error || choice.quota.state !== 'ok' || !choice.handoffLine?.fits) return false;
    const review = { snapshot, goal, builder: run.provider, provider: choice.provider, model: choice.model || null };
    try {
      this.broker.start(c, {
        text: `Review selected changes: ${goal}`,
        provider: choice.provider,
        model: choice.model || null,
        effort: choice.effort || null,
        mode: 'read',
        requestId: `ultra-review-${run.id}`,
      }, {
        review, execution: run.execution, executionAction: 'review',
        verifyReview: () => {
          if (captureReview(this.broker.workspaceFolders, selections).digest !== snapshot.digest) {
            throw Object.assign(new Error('The selected changes changed before the review started.'), { status: 409 });
          }
        },
      });
      return true;
    } catch { return false; }
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
    const automatic = AUTOMATIC.has(globalThis.relayRouting.normalizeMode(run.routing.mode));
    const blocked = automatic ? await this.limited(c, run, step) : null;
    if (!this.broker.execution.allows(c, run.execution, { action: 'manual' }) || this.closed || this.broker.running) return;
    if (automatic && !blocked && this.broker.execution.allows(c, run.execution, { action: 'retry' })) {
      try { this.retry(c, run, step, command, result); return; }
      catch (error) { return this.hold(c, `The retry could not start: ${error.message}`, 'Tests failed', `The retry with ${stepName(step)} could not start.`); }
    }
    const offer = { id: randomUUID(), execution: run.execution, runId: run.id, provider: step.provider, model: step.model || null, modelName: step.modelName || null, effort: step.effort || null, tier: step.tier || null, mode: run.mode, approvalPolicy: run.approvalPolicy, billingConfirmed: run.billingConfirmed === true, routingMode: run.routing.mode, command: command.command, directory: command.directory || '', exitCode: result.exitCode, output: result.output, ...(blocked ? { blocked } : {}), createdAt: new Date().toISOString() };
    this.broker.record(c, { type: 'retry_offer', offer });
    this.hold(c, CHECK_PAUSE, 'Tests failed', `Retry with ${stepName(step)}?`);
  }

  // Why an automatic retry should wait for the person: the agent is past the mode's handoff line (#12), judged as for the
  // task it keeps working on, or its allowance can't be confirmed. Past the line but in windows about to reset, what is
  // left would expire unused, so the retry goes ahead as a running task would stay (#153).
  async limited(c, run, step) {
    let usage = null;
    try { usage = await this.usage(step.provider, this.broker.usageOptions(step.provider)); } catch { return `${names[step.provider]}'s allowance could not be checked`; }
    const routing = globalThis.relayRouting, mode = routing.normalizeMode(run.routing.mode);
    const fit = routing.handoffFit(usage, step.model, { mode, current: step.provider === run.provider, tier: step.tier || run.routing.tier || null, usual: usualWindowSpend(c, step.provider) });
    if (fit.fits) return null;
    const quota = fit.quota;
    if (quota.state === 'unknown' || quota.state === 'stale') return `${names[step.provider]}'s allowance is ${quota.state}`;
    if (quota.state === 'exhausted') return `${names[step.provider]} has reached its limit`;
    const used = Math.round(fit.window?.usedPercent ?? quota.usedPercent);
    return `${names[step.provider]} is at ${used}% of its limit, past ${routing.modeNames[mode]}’s ${fit.line}% handoff line`;
  }

  retry(c, run, step, command, result, automatic = true) {
    return this.broker.start(c, { text: retryPrompt(command, result), provider: step.provider, model: step.model || null, effort: step.effort || null, mode: run.mode, approvalPolicy: run.approvalPolicy, billingConfirmed: run.billingConfirmed === true,
      routing: { mode: run.routing.mode, tier: step.tier, reason: 'The tests failed, so one step up' }, requestId: `retry-${run.id}` }, { retryOf: run.id, execution: run.execution, executionAction: automatic ? 'retry' : 'manual' });
  }

  // A retry the person accepted from an offer.
  accept(c, offerId) {
    const offer = c.retryOffer;
    if (!offer || offer.id !== offerId) throw Object.assign(new Error('This retry is no longer offered.'), { status: 409 });
    if (this.broker.running) throw Object.assign(new Error('An agent is working in this workspace. Retry once it finishes.'), { status: 409 });
    if (c.lastRun?.id !== offer.runId) throw Object.assign(new Error('Another run has finished since. Send a new message instead.'), { status: 409 });
    this.broker.record(c, { type: 'retry_offer_end', id: offer.id, outcome: 'accepted' });
    this.broker.execution.assert(c, offer.execution, { action: 'manual' });
    const run = { id: offer.runId, execution: offer.execution, mode: offer.mode, approvalPolicy: offer.approvalPolicy, billingConfirmed: offer.billingConfirmed, routing: { mode: offer.routingMode } };
    return this.retry(c, run, offer, { command: offer.command, directory: offer.directory }, { exitCode: offer.exitCode, output: offer.output }, false);
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

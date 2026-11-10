import { isAntigravityACP, antigravityReadOnly } from './antigravity.mjs';
import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { probeCli } from './cli-probe.mjs';
import { isAgy, agyUnsupported } from './gemini.mjs';
import { resolveBinary } from './resolve-binary.mjs';
import { fileURLToPath } from 'node:url';
import { prepareContext, emptyContext, validateContext, continuationRequest } from './context.mjs';
import { classifyError, capabilities, accountStatus } from './providers.mjs';
import { workspaceBaseline } from './workspace-baseline.mjs';
import { RunCheckpoints } from './checkpoints.mjs';
import { normalizeUsage, readLedger, taskIdentity, taskResult } from './task-ledger.mjs';
import { smartResults } from './smart-results.mjs';
import { claudeRequestContext, contextReading, restoreAfterCompaction } from './context-state.mjs';
import { observeReading, observeRunSize, usageWatch, usualWindowSpend } from './usage-watch.mjs';
import { contextControlView, estimateContext, findMessage, managedContextVersion, milestoneMemory, observationsFor, REFRESH_HISTORY, rolloverDecision, sessionSeed } from './context-rollover.mjs';
import { carriedPlan, reportedPlan } from './task-plan.mjs';
import { TaskCoordinator } from './task-coordinator.mjs';
import { attachedFiles, cleanEntryInput, memoryLimit, memoryView, newEntry } from './project-memory.mjs';
import { planCopy, writeCopy } from './memory-instructions.mjs';
import { applyBudgetRecord, isExplicitRetry, TaskBudgets } from './task-budget.mjs';
import { SkillCatalog } from './skills.mjs';
import { fileChanges, toolInput } from './activity-format.mjs';
import { AttachmentStore } from './attachments.mjs';
import { processStart, reused } from './mutation-lock.mjs';
import { parseReviewResult, publicReview, reviewPrompt } from './agent-review.mjs';
import { validateAutomaticReview } from './automatic-review.mjs';
import { ResumeScheduler } from './resume.mjs';
import { readOnlyRequest, approvalScope, requestSummary, blockedBySandbox } from './approval-rules.mjs';
import { cleanQuestions, checkAnswers, answerSummary, codexAsyncQuestions } from './agent-questions.mjs';
import { PermissionRules } from './permission-rules.mjs';
import { PromptQueue } from './prompt-queue.mjs';
import { HandoffMonitor } from './handoff.mjs';
import { RunChecks } from './run-checks.mjs';
import { RoutingDispatcher } from './routing-assessment.mjs';
import { ExecutionPolicies, executionConfig } from './execution-policy.mjs';
import { verificationForRun } from './verification.mjs';
import { applyOrchestration, checkPlanning, orchestrationAction, planningRequest, planningResult, restartedPlanning } from './orchestration.mjs';

export const PROVIDERS = ['codex', 'claude', 'gemini'];
// Which file a command is, and which version of it: installing, moving or updating a CLI changes this.
const fileIdentity = file => { try { const stat = fs.statSync(file); return [file, stat.size, stat.mtimeMs, stat.ino]; } catch { return [file]; } };
const transportFor = (provider, transport, configured) => transport === 'auto' ? provider === 'gemini' ? 'acp' : configured ? 'cli' : provider === 'codex' ? 'app-server' : 'sdk' : transport;
const MODES = ['edit', 'read'];
export const APPROVAL_POLICIES = ['ask', 'auto'];
// macOS reports EPERM, not ESRCH, for a process group whose remaining members have exited but are not yet reaped.
const groupGone = error => error.code === 'ESRCH' || (error.code === 'EPERM' && process.platform === 'darwin');
const clip = (text, max = 16000) => String(text ?? '').length > max
  ? `${String(text).slice(0, max)}\n[Output shortened; inspect project files for the full state.]`
  : String(text ?? '');

function checkSettings(provider, mode, approvalPolicy = 'ask') {
  if (!PROVIDERS.includes(provider) || !MODES.includes(mode)) {
    throw Object.assign(new Error('Choose Codex, Claude or Gemini and an edit or read mode.'), { status: 400 });
  }
  if (!APPROVAL_POLICIES.includes(approvalPolicy)) {
    throw Object.assign(new Error('Choose Ask for permission or Full auto-approval.'), { status: 400 });
  }
  if (mode === 'read' && approvalPolicy === 'auto') {
    throw Object.assign(new Error('Full auto-approval requires edit access and cannot be enabled in read-only mode.'), { status: 400, category: 'permission' });
  }
}

function savedWorkspace(directory) {
  try { return fs.realpathSync(directory); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code) && path.isAbsolute(directory)) return path.resolve(directory);
    throw error;
  }
}

export function commandFor(provider, { mode, approvalPolicy = 'ask', sessionId, bin, workspace, workspaces = [], effort }) {
  checkSettings(provider, mode, approvalPolicy);
  if (provider === 'gemini') return { bin: bin || 'gemini', args: [] };
  if (provider === 'codex') {
    const args = ['--ask-for-approval', 'never', '--sandbox', mode === 'edit' ? 'workspace-write' : 'read-only'];
    if (effort) args.push('-c', 'model_reasoning_effort=' + effort);
    // --add-dir grants writes, so never use it with a read-only invocation.
    if (mode === 'edit') for (const directory of workspaces.filter(directory => directory !== workspace)) args.push('--add-dir', directory);
    args.push('exec');
    if (sessionId) args.push('resume', sessionId);
    args.push('--json', '-');
    return { bin: bin || 'codex', args };
  }
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', mode === 'edit' ? 'acceptEdits' : 'plan',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'mcp__*'];
  // Restrict built-in tools in read mode; a previous session's allowed write tools cannot carry over.
  if (mode === 'read') args.push('--tools', 'Read,Glob,Grep');
  if (effort) args.push('--effort', effort);
  for (const directory of workspaces.filter(directory => directory !== workspace)) args.push('--add-dir', directory);
  if (sessionId) args.push('--resume', sessionId);
  return { bin: bin || 'claude', args };
}

const ROUTING_MODES = ['saver', 'smart', 'ultra', 'saving', 'balanced', 'quality'], TIERS = ['light', 'standard', 'deep'];
const normalizeRoutingMode = mode => ({ saving: 'saver', balanced: 'smart', quality: 'ultra' })[mode] || mode;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// What Auto chose and why, as shown before sending; kept with the run and its prompt.
export function routingNote(routing) {
  if (routing === null || routing === undefined) return null;
  if (typeof routing !== 'object' || !ROUTING_MODES.includes(routing.mode)) throw Object.assign(new Error('Invalid automatic agent choice.'), { status: 400 });
  const mode = normalizeRoutingMode(routing.mode);
  const step = routing.escalation, text = value => typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
  // The step up a failed check retries with (#12): the same kind of choice, checked again when the retry starts.
  const escalation = step && typeof step === 'object' && PROVIDERS.includes(step.provider) ? { provider: step.provider, model: text(step.model), modelName: text(step.modelName), effort: EFFORTS.includes(step.effort) ? step.effort : null, ...(TIERS.includes(step.tier) ? { tier: step.tier } : {}) } : null;
  const assessed = routing.assessment;
  const assessment = assessed && typeof assessed.id === 'string' && TIERS.includes(assessed.tier) && ['low', 'medium', 'high'].includes(assessed.effort) && ['agent', 'local', 'fallback', 'plan'].includes(assessed.source)
    ? { id: assessed.id.slice(0, 128), tier: assessed.tier, effort: assessed.effort, source: assessed.source, reason: typeof assessed.reason === 'string' ? assessed.reason.slice(0, 300) : '', ...(Number.isFinite(assessed.ms) ? { ms: assessed.ms } : {}) } : null;
  return { mode, reason: typeof routing.reason === 'string' ? routing.reason.slice(0, 300) : '', ...(TIERS.includes(routing.tier) ? { tier: routing.tier } : {}), ...(routing.steppedDown === true ? { steppedDown: true } : {}), ...(routing.plannedHandoff === true ? { plannedHandoff: true } : {}), ...(['expiring', 'asked'].includes(routing.remainder) ? { remainder: routing.remainder } : {}), ...(assessment ? { assessment } : {}), ...(escalation ? { escalation } : {}) };
}

// Where each new imported message goes, as the id of the message it follows (null for the start). A run's prompt and replies stay together as one turn,
// timed from its prompt, and each message goes before the first later turn, so on equal times the turn already there comes first (#55).
function importPlaces(existing, entries) {
  const turns = [];
  for (const message of existing) { const turn = turns.at(-1); if (message.runId && turn?.runId === message.runId) turn.end = message.id; else turns.push({ runId: message.runId, time: Date.parse(message.createdAt), end: message.id }); }
  // The entries are in time order, so the first later turn never moves back.
  const after = {}; let index = 0, tail = null;
  for (const { time, message } of entries) {
    while (index < turns.length && !(turns[index].time > time)) tail = turns[index++].end;
    after[message.id] = tail; tail = message.id;
  }
  return after;
}

export class Broker extends EventEmitter {
  constructor({ workspace, workspaces = [], workspaceFolders = [], dataDir, googleRoot = path.join(dataDir, 'google'), bins = {}, acquireMutation = () => ({ release() {}, setProcess() {} }), acquireFolders, withFolders, lane = false, contextPolicy = 'task', handoffPreferences = () => ({ threshold: 90, automatic: false }), verificationCadence = () => 'as-needed', contextLimit = () => 'auto', contextRouting = () => null, tests = null }) {
    super();
    this.execution = new ExecutionPolicies(this); this.handoffPreferences = handoffPreferences;
    this.workspace = savedWorkspace(workspace); this.contextPolicy = contextPolicy; this.budget = new TaskBudgets(this);
    this.workspaces = [...new Set([this.workspace, ...workspaces.map(savedWorkspace), ...workspaceFolders.map(folder => savedWorkspace(folder.path))])];
    this.workspaceFolders = this.workspaces.map(directory => {
      const configured = workspaceFolders.find(folder => savedWorkspace(folder.path) === directory);
      return { id: configured?.id || createHash('sha256').update(directory).digest('hex').slice(0, 16), name: configured?.name || path.basename(directory), ...(configured?.displayName ? { displayName: configured.displayName } : {}), path: directory };
    });
    this.workspaceSignature = createHash('sha256').update(JSON.stringify({ primary: this.workspace, roots: [...this.workspaces].sort() })).digest('hex');
    this.dataDir = dataDir; this.googleRoot = googleRoot; this.verificationCadence = verificationCadence; this.contextLimit = contextLimit; this.contextRouting = contextRouting;
    this.skills = new SkillCatalog(this);
    this.attachments = new AttachmentStore(dataDir);
    this.configuredBins = { ...bins };
    this.acquireMutation = acquireMutation;
    this.bins = Object.fromEntries(PROVIDERS.map(provider => [provider, resolveBinary(provider, { override: bins[provider], googleRoot: this.googleRoot })]));
    this.conversations = new Map();
    this.running = null;
    this.router = new RoutingDispatcher(this);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const filename of fs.readdirSync(dataDir).filter(name => /^[\da-f-]{36}\.jsonl$/.test(name))) {
      const id = filename.slice(0, -6);
      const conversation = this.empty(id);
      const source = fs.readFileSync(path.join(dataDir, filename), 'utf8');
      const lines = source.split('\n');
      // A crash may tear the last append. Repair only that unterminated record.
      if (lines.at(-1)) {
        let valid = true;
        try { JSON.parse(lines.at(-1)); } catch { valid = false; }
        if (valid) { fs.appendFileSync(path.join(dataDir, filename), '\n'); lines.push(''); }
        else { lines.pop(); fs.writeFileSync(path.join(dataDir, filename), `${lines.join('\n')}\n`, { mode: 0o600 }); }
      }
      // A crash or a full disk while a new conversation writes its first record leaves nothing to load.
      if (!lines.some(Boolean)) continue;
      for (const line of lines.filter(Boolean)) this.apply(conversation, JSON.parse(line));
      if (!conversation.createdAt) throw new Error(`Invalid conversation journal: ${filename}`);
      this.conversations.set(id, conversation);
      if (conversation.routingAssessment) {
        const previous = conversation.routingAssessment;
        if (previous.pid && process.platform !== 'win32') {
          try { process.kill(-previous.pid, 0); if (!reused(previous.pid, previous.pidStart)) throw Object.assign(new Error(`A routing assessor from the previous run may still be active (process group ${previous.pid}). Stop that process group before restarting Codeshi.`), { status: 409 }); }
          catch (error) { if (!groupGone(error)) throw error; }
        }
        this.record(conversation, { type: 'routing_assessment_end', id: previous.id, result: { status: 'interrupted', error: 'Codeshi restarted during task assessment. Send again when ready.' } });
      }
      if (conversation.activeRun) {
        if (conversation.activeRun.pid && process.platform !== 'win32') {
          try {
            process.kill(-conversation.activeRun.pid, 0);
            // A leader with another start time than the one the run saved means the ID now names a new group.
            if (!reused(conversation.activeRun.pid, conversation.activeRun.pidStart)) throw Object.assign(new Error(`An assistant from the previous run may still be active (process group ${conversation.activeRun.pid}). Stop that process group before restarting Codeshi.`), { status: 409 });
          } catch (error) { if (!groupGone(error)) throw error; }
        }
        for (const message of conversation.messages.filter(m => m.runId === conversation.activeRun.id && m.role === 'assistant')) {
          this.record(conversation, { type: 'message_update', id: message.id, update: { status: 'incomplete' } });
        }
        this.message(conversation, 'error', 'The previous run was interrupted. Its saved output is available; inspect project changes before continuing.', conversation.provider);
        if (conversation.activeRun.reviewId) this.record(conversation, { type: 'review_result', id: conversation.activeRun.reviewId, result: { status: 'interrupted', summary: 'The review was interrupted. Start a new review to check these changes.', findings: [] } });
        if (conversation.activeRun.orchestrationId) this.record(conversation, { type: 'orchestration_result', id: conversation.activeRun.orchestrationId, result: restartedPlanning() });
        this.record(conversation, { type: 'run_end', status: 'interrupted', errorCategory: 'interrupted' });
      }
      for (const review of conversation.reviews.filter(item => item.background && item.status === 'running')) {
        if (review.pid && process.platform !== 'win32') {
          try { process.kill(-review.pid, 0); if (!reused(review.pid, review.pidStart)) throw Object.assign(new Error(`A background reviewer from the previous run may still be active (process group ${review.pid}). Stop that process group before restarting Codeshi.`), { status: 409 }); }
          catch (error) { if (!groupGone(error)) throw error; }
        }
        this.record(conversation, { type: 'review_result', id: review.id, result: { status: 'interrupted', summary: 'Background review was interrupted. Start a new review when ready.', findings: [] } });
      }
      for (const run of conversation.runs.filter(item => ['building', 'reviewing'].includes(item.automaticReview?.status))) {
        this.record(conversation, { type: 'automatic_review_phase', runId: run.id, phase: { status: 'interrupted', summary: 'Codeshi restarted. Review stopped; start a new review when ready.' } });
      }
    }
    this.permissions = new PermissionRules(dataDir);
    this.resume = new ResumeScheduler(this);
    for (const c of this.conversations.values()) this.execution.migrate(c);
    this.resume.arm();
    this.queue = new PromptQueue(this);
    this.queue.restore();
    this.handoff = new HandoffMonitor(this, { preferences: handoffPreferences });
    this.checks = new RunChecks(this, { tests });
    this.checkpoints = new RunCheckpoints(this);
    // A lane runs one task, so only the workspace's own broker coordinates others.
    if (!lane) { this.tasks = new TaskCoordinator(this, { BrokerClass: this.constructor, ...(acquireFolders ? { acquireFolders } : {}), ...(withFolders ? { withFolders } : {}), tests }); this.tasks.restore(); }
    this.checks.restore();
    // The first check of a wait saved before a restart runs once startup has finished.
    if (this.resume.waiting) setTimeout(() => this.resume.tick(), 0);
  }

  // Waiting for a usage limit to reset (#32).
  get waitingResumes() { return this.resume.waiting; }
  availableProviders() { const hasConfigured = Object.keys(this.configuredBins).length > 0; return PROVIDERS.filter(provider => { if (hasConfigured && !this.configuredBins[provider]) return false; return resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot }); }); }
  checkRunSettings(provider, mode, approvalPolicy) { checkSettings(provider, mode, approvalPolicy); }
  usageOptions(provider) { return { bin: resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot }), workspace: this.workspace, googleRoot: this.googleRoot, refresh: true }; }
  scheduleResume(c, input = {}) { return this.resume.schedule(c, input); }
  cancelResume(c) { return this.resume.cancel(c); }
  queueAction(c, input = {}) { return this.queue.act(c, input); }
  // A note added to the run that is working (#32): the agent takes it into the same task instead of after it. If
  // the run finishes first, the note runs next from the queue instead, with the same settings.
  async addToRun(c, input = {}) {
    const run = this.running, text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > 100000) throw Object.assign(new Error('Enter a message between 1 and 100,000 characters.'), { status: 400 });
    if (!run || run.c !== c) throw Object.assign(new Error('Nothing is running in this workspace. Send your message instead.'), { status: 409 });
    if (!run.steerable) throw Object.assign(new Error('This run cannot take more input. Queue your message instead.'), { status: 409 });
    if (run.provider === 'gemini' && run.approvals.size) throw Object.assign(new Error('Answer Gemini’s waiting approval first, then add your note.'), { status: 409 });
    this.automaticReviews?.invalidate(c, run, 'The task changed while the builder worked. Authorize a new review.');
    const id = randomUUID();
    const result = run.ending || !run.child?.connected ? { ok: false } : await new Promise(resolve => {
      const timer = setTimeout(() => { run.steers.delete(id); resolve({ ok: false }); }, 15000); timer.unref();
      run.steers.set(id, value => { clearTimeout(timer); resolve(value); });
      run.child.send({ type: 'steer', id, text }, error => { if (error) { run.steers.delete(id); clearTimeout(timer); resolve({ ok: false }); } });
    });
    if (result.ok && this.running === run) {
      this.record(c, { type: 'message', message: { id, role: 'user', text, provider: run.provider, steer: true, createdAt: new Date().toISOString(), runId: run.id } });
      this.emit('update', { conversationId: c.id });
      return { added: true, conversation: this.view(c) };
    }
    this.queue.act(c, { action: 'add', text, provider: run.provider, model: run.model, effort: run.effort, mode: run.mode, approvalPolicy: run.approvalPolicy, billingConfirmed: run.billingConfirmed });
    if (c.queue.length > 1) this.queue.act(c, { action: 'move', id: c.queue.at(-1).id, index: 0 });
    return { added: false, queued: true, conversation: this.view(c) };
  }
  // Handing off before a usage limit stops the run (#17).
  // What an agent said went wrong. A usage limit that may be handed off (#91) stays quiet until that's decided, so a
  // handoff doesn't look like an error.
  agentError(run, text) {
    if (run.errorCategory === 'quota' && this.handoff.atLimit(run)) run.limitNotice ||= text;
    else this.message(run.c, 'error', text, run.provider);
  }
  acceptHandoff(c, input = {}) { return this.handoff.accept(c, { offerId: input.offerId, billingConfirmed: input.billingConfirmed === true, queueBillingConfirmed: input.queueBillingConfirmed === true, queueDigest: input.queueDigest }); }
  // Continue with another agent after a limit: the person's own handoff, so queued prompts for the limited agent follow it (#93).
  async continueTask(c, input = {}) {
    const previous = c.lastRun;
    // Continuing a planning run would do the work it was only asked to plan (#12).
    if (previous?.purpose === 'plan') throw Object.assign(new Error('A planning run isn’t continued. Plan again from the plan card, or write the steps yourself.'), { status: 409 });
    if (input.resetFailures && previous?.taskId && c.taskBudgets?.[previous.taskId]) {
      this.budget.reset(c, { taskId: previous.taskId });
    }
    const result = this.start(c, { ...input, orchestrate: false, fresh: true, text: continuationRequest });
    if (!result.duplicate && previous?.errorCategory === 'quota' && this.running?.provider !== previous.provider) await this.handoff.followContinue(c, previous.provider, this.running).catch(error => console.error('Codeshi could not move the queued prompts:', error.message));
    return result;
  }
  dismissHandoff(c, offerId) { this.handoff.dismiss(c, offerId); return this.view(c); }
  // A retry one step up after failed tests, offered instead of started (#12).
  acceptRetry(c, input = {}) { return this.checks.accept(c, input.offerId); }
  dismissRetry(c, offerId) { this.checks.dismiss(c, offerId); return this.view(c); }

  empty(id) {
    return { id, title: 'New conversation', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', status: 'idle', messages: [], messageById: new Map(),
      sessions: {}, models: {}, efforts: {}, effort: null, imports: {}, runs: [], transports: {}, requests: {}, reviewRequests: {}, reviews: [], orchestrations: [], snapshots: {}, rewinds: [], context: emptyContext(), model: null, transport: 'auto', settingsRevision: 0, lastRun: null, records: 0, activeRun: null, resume: null, resumeEnded: null, queue: [], queuePaused: null, handoffOffer: null, retryOffer: null, routing: null, createdAt: null, updatedAt: null };
  }

  apply(c, record) {
    c.messageById ||= new Map(c.messages.map(message => [message.id, message]));
    const previousBytes = record.type === 'message_update' ? Buffer.byteLength(findMessage(c, record.id)?.text || '') : 0;
    c.records = record.seq;
    if (!(record.type === 'execution_migrated' || record.type === 'queue_execution' || record.type === 'execution_policy' && record.policy?.authorization?.source?.startsWith('legacy') || record.type === 'resume' && record.resume?.legacy)) c.updatedAt = record.at;
    if (record.type === 'execution_default') c.executionDefault = record.policy;
    if (record.type === 'execution_policy') { c.executionPolicies ||= {}; c.executionPolicies[record.policy.taskId] = record.policy; }
    if (record.type === 'execution_migrated') c.executionMigrated = true;
    if (record.type === 'queue_execution') { const item = c.queue.find(item => item.id === record.id); if (item) item.execution = record.execution; }
    if (record.type === 'execution_override_used') { const policy = c.executionPolicies?.[record.taskId]; if (policy) policy.overrideUsed = true; }
    if (record.type === 'created') Object.assign(c, { createdAt: record.at, title: record.title });
    if (record.type === 'settings') { Object.assign(c, { provider: record.provider, mode: record.mode, approvalPolicy: record.approvalPolicy || 'ask', model: record.model ?? null, transport: record.transport || c.transport, settingsRevision: record.seq }); c.models[record.provider] = record.model ?? null; c.transports[record.provider] = record.transport || c.transport; }
    if (record.type === 'context') c.context = record.context;
    if (record.type === 'semantic_observation') c.semanticObservations = [...(c.semanticObservations || []).filter(item => item.id !== record.observation.id), { ...record.observation, observedAt: record.at }].slice(-200);
    if (record.type === 'context_compact_requested') {
      const replaced = c.sessions[record.provider], history = c.contextRollovers?.[record.provider]?.history || [];
      const entry = { at: record.at, reason: 'manual', used: replaced?.contextUsage?.used ?? null, source: replaced?.contextUsage?.source || null, thresholdTokens: null, modeTarget: null, capacity: replaced?.contextUsage?.capacity ?? null,
        previousSessionId: replaced?.id || null, previousTurns: replaced?.turns ?? null, previousSeed: replaced?.seed || null, seedBytes: null };
      c.contextRollovers ||= {}; c.contextRollovers[record.provider] = { pending: true, reason: 'manual', at: record.at, history: c.contextRollovers[record.provider]?.pending ? history : [...history, entry].slice(-REFRESH_HISTORY) };
      delete c.sessions[record.provider];
      const milestone = { id: `compact-${record.seq}`, role: 'system', text: 'Context refresh scheduled. The next message to this agent starts a fresh session with a task brief. Chat history stays saved.', contextMilestone: true, createdAt: record.at, seq: record.seq };
      c.messages.push(milestone); c.messageById.set(milestone.id, milestone);
    }
    if (record.type === 'async_question') c.asyncQuestions = [...(c.asyncQuestions || []), record.question];
    if (record.type === 'async_question_end') c.asyncQuestions = (c.asyncQuestions || []).filter(item => item.id !== record.id);
    // A new prompt supersedes optional questions from earlier work. Background reviews do not.
    if (record.type === 'submission' && !record.review) c.asyncQuestions = [];
    // Project memory (#21). Removing an entry stops it being used; the conversation it came from stays saved.
    if (record.type === 'memory_add') c.memory = [...(c.memory || []), record.entry];
    if (record.type === 'memory_update') c.memory = (c.memory || []).map(entry => entry.id === record.id ? { ...entry, ...record.changes, updatedAt: record.at } : entry);
    if (record.type === 'memory_remove') c.memory = (c.memory || []).filter(entry => entry.id !== record.id);
    if (record.type === 'memory_dismiss') c.memoryDismissed = [...(c.memoryDismissed || []), record.key];
    if (record.type === 'skills') { c.skills = record.skills; c.skillDirs = record.dirs; }
    if (record.type === 'quota_observation') { c.quotaReadings ||= {}; c.quotaReadings[record.provider] = { windows: record.windows, observedAt: Object.hasOwn(record, 'observedAt') ? record.observedAt : record.at }; observeReading(c, record.provider, c.quotaReadings[record.provider]); }
    applyBudgetRecord(c, record);
    if (record.type === 'routing') c.routing = record.routing ? { ...record.routing, mode: normalizeRoutingMode(record.routing.mode) } : null;
    if (record.type === 'routing_assessment_start') c.routingAssessment = { ...record, startedAt: record.at };
    if (record.type === 'routing_assessment_metadata' && c.routingAssessment?.id === record.id) Object.assign(c.routingAssessment, record.metadata);
    if (record.type === 'routing_decision' || record.type === 'routing_assessment_end' && c.routingAssessment?.id === record.id) {
      const decided = record.type === 'routing_decision' ? record : c.routingAssessment;
      c.routingRequests ||= {};
      c.routingRequests[decided.requestId] = { id: decided.id, taskId: decided.taskId, fingerprint: decided.fingerprint, scope: decided.scope, result: record.result };
      const keys = Object.keys(c.routingRequests);
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete c.routingRequests[key];
      if (record.type !== 'routing_decision') c.routingAssessment = null;
    }
    if (record.type === 'routing_submission' && c.routingRequests?.[record.requestId]) c.routingRequests[record.requestId].submission = record.submission;
    if (record.type === 'retry_offer') c.retryOffer = record.offer ? { ...record.offer, ...(record.offer.routingMode ? { routingMode: normalizeRoutingMode(record.offer.routingMode) } : {}) } : null;
    if (record.type === 'retry_offer_end' && c.retryOffer?.id === record.id) c.retryOffer = null;
    if (record.type === 'check') { const run = c.runs?.findLast(item => item.id === record.runId); if (run) run.check = record.check; if (c.lastRun?.id === record.runId) c.lastRun.check = record.check; }
    if (record.type === 'resume') c.resume = record.resume;
    // Independent tasks (#88): saved before anything starts, so a crash can always find who owned what.
    if (record.type === 'parallel_task') c.parallelTasks = [...(c.parallelTasks || []), record.task];
    if (record.type === 'parallel_task_update') { const task = c.parallelTasks?.find(item => item.id === record.id); if (task) Object.assign(task, record.changes); }
    if (record.type === 'queue_add') c.queue = [...c.queue, record.item?.routing?.mode ? { ...record.item, routing: { ...record.item.routing, mode: normalizeRoutingMode(record.item.routing.mode) } } : record.item];
    if (record.type === 'queue_update') c.queue = c.queue.map(item => { if (item.id !== record.id) return item; const updated = { ...item }; if (record.text !== undefined) updated.text = record.text; if ('provider' in record) updated.provider = record.provider; if ('model' in record) updated.model = record.model; if ('effort' in record) updated.effort = record.effort; if (record.clearRouting) delete updated.routing; return updated; });
    if (record.type === 'queue_move') { const item = c.queue.find(entry => entry.id === record.id); if (item) { const rest = c.queue.filter(entry => entry !== item); rest.splice(record.index, 0, item); c.queue = rest; } }
    // "Proceed with remaining allowance" holds for the rest of the queue, so each later prompt doesn't pause again.
    if (record.type === 'queue_remove' || record.type === 'queue_started') { c.queue = c.queue.filter(item => item.id !== record.id); if (!c.queue.length) delete c.queueResumeProceed; }
    // One record, so a restart finds each prompt with one owner: moved or not, never both (#93).
    if (record.type === 'queue_moved') { const moves = new Map(record.moves.map(move => [move.id, move])); c.queue = c.queue.map(item => { const move = moves.get(item.id); if (!move) return item; const { routing, ...rest } = item; const { id, ...fields } = move; return { ...rest, ...(routing && !('routing' in fields) ? { routing } : {}), ...fields }; }); }
    if (record.type === 'queue_pause') c.queuePaused = { reason: record.reason, at: record.at, ...(record.proceedTried ? { proceedTried: true } : {}) };
    if (record.type === 'queue_resume') { c.queuePaused = null; if (record.proceedWithNearQuota) c.queueResumeProceed = true; else delete c.queueResumeProceed; }
    if (record.type === 'resume_end' && c.resume?.id === record.id) { c.resume = null; c.resumeEnded = { id: record.id, outcome: record.outcome, provider: record.provider || null, at: record.at }; }
    if (['settings', 'submission'].includes(record.type) && !record.review && !record.local) {
      c.effort = record.effort ?? null;
      c.efforts[record.provider] ||= {};
      c.efforts[record.provider][record.model || 'default'] = c.effort;
    }
    if (record.type === 'import') {
      c.reordered = record.seq;
      for (const importId of record.importIds || [record.importId]) c.imports[importId] = true;
      let last = -1;
      for (const message of record.messages) {
        const previous = c.messages.find(item => item.id === message.id && item.importSource === message.importSource);
        if (previous) { Object.assign(previous, message, { seq: record.seq, imported: true }); c.messageById.set(previous.id, previous); continue; }
        // The record names the message each new one follows (null for the start). Older records name none, so theirs go at the end, as does one whose message is gone (#55).
        const follows = record.after?.[message.id], found = follows == null ? -1 : c.messages[last]?.id === follows ? last : c.messages.findIndex(item => item.id === follows);
        last = follows === null ? 0 : found < 0 ? c.messages.length : found + 1;
        const imported = { ...message, seq: record.seq, imported: true };
        c.messages.splice(last, 0, imported); c.messageById.set(imported.id, imported);
      }
    }
    if (record.type === 'message_delta') { const message = findMessage(c, record.id); if (!message) throw new Error('Message delta has no original message.'); message.text += record.text; message.seq = record.seq; if (record.status) message.status = record.status; if (record.toolOutcome) message.toolOutcome = record.toolOutcome; }
    if (record.type === 'run_metadata') {
      if (c.activeRun) Object.assign(c.activeRun, record.metadata);
      // Routing switched agents before the run started (#144): the saved run is the new agent's, after a restart too.
      const switched = record.metadata?.routingFallback;
      if (c.activeRun && switched?.to) Object.assign(c.activeRun, { provider: switched.to, model: switched.toModel ?? null, ...(switched.toEffort !== undefined ? { effort: switched.toEffort } : {}), ...(switched.toTransport ? { transport: switched.toTransport } : {}) });
      if (c.activeRun && record.metadata?.usage) c.activeRun.usageMeasured = normalizeUsage(c.activeRun.provider, record.metadata.usage, { previous: c.budgetTotals?.[c.activeRun.provider] });
      const reading = c.activeRun && contextReading(c.activeRun.provider, record.metadata || {}, record.at);
      if (reading) {
        const previous = c.sessions[c.activeRun.provider]?.contextUsage;
        if (reading.source === 'claude-last-request-input' && previous?.cacheTtlMs && !reading.cacheTtlMs) reading.cacheTtlMs = previous.cacheTtlMs;
        if (reading.capacity === null && previous?.capacity > 0) reading.capacity = previous.capacity;
        c.activeRun.contextUsage = reading; if (c.sessions[c.activeRun.provider]) c.sessions[c.activeRun.provider].contextUsage = reading;
      }
      if (record.metadata?.routingQuota && c.activeRun) { const run = c.runs?.find(item => item.id === c.activeRun.id); if (run) run.routingQuota = record.metadata.routingQuota; }
    }
    if (record.type === 'native_compaction' && c.activeRun?.id === record.runId) {
      const run = c.activeRun, events = run.compactionEvents || [], prior = events.find(item => item.id === record.event.id);
      run.compactions = (run.compactions || 0) + (prior ? 0 : 1);
      run.compactionEvents = [...events.filter(item => item.id !== record.event.id), { ...prior, ...record.event, observedAt: record.at }].slice(-20);
      if (c.sessions[record.provider]) c.sessions[record.provider].needsContextRefresh = true;
      run.contextUsage = { used: record.event.afterTokens ?? null, capacity: run.contextUsage?.capacity ?? null,
        source: 'native-compaction', estimated: true, observedAt: record.at,
        note: record.event.afterTokens == null ? 'Awaiting a provider context reading after compaction.' : 'Provider-reported estimate after compaction.' };
      if (c.sessions[record.provider]) c.sessions[record.provider].contextUsage = run.contextUsage;
    }
    if (record.type === 'submission') {
      if (record.context?.rollover) {
        // The refresh history keeps what the session being replaced started with and how long it lasted, so repeated
        // quick refreshes can be explained later (#85). Bounded; the journal keeps every record.
        const replaced = c.sessions[record.provider], rollover = record.context.rollover, history = c.contextRollovers?.[record.provider]?.history || [];
        const scheduled = c.contextRollovers?.[record.provider]?.pending && !replaced && history.length && history.at(-1).seedBytes === null;
        const entry = scheduled ? { ...history.at(-1), seedBytes: record.context.bytes || 0, thresholdTokens: rollover.thresholdTokens ?? null, modeTarget: rollover.modeTarget ?? null }
          : { at: record.at, reason: rollover.reason, used: rollover.used ?? null, source: rollover.source || null, thresholdTokens: rollover.thresholdTokens ?? null, modeTarget: rollover.modeTarget ?? null, capacity: rollover.capacity ?? null,
            previousSessionId: replaced?.id || rollover.previousSessionId || null, previousTurns: replaced?.turns ?? null, previousSeed: replaced?.seed || null, seedBytes: record.context.bytes || 0 };
        c.contextRollovers ||= {}; c.contextRollovers[record.provider] = { pending: true, reason: rollover.reason, at: record.at, history: [...(scheduled ? history.slice(0, -1) : history), entry].slice(-REFRESH_HISTORY) };
        const milestone = { id: `rollover-${record.id}`, role: 'system', text: 'Starting a fresh agent session with a task brief. Chat history stays saved.', contextMilestone: true, createdAt: record.at, seq: record.seq };
        c.messages.push(milestone); c.messageById.set(milestone.id, milestone);
      }
      if (!record.review && !record.local) {
        if (record.resetSession) delete c.sessions[record.provider];
        // Turns count the messages a native session has received; a fresh session's first turn is counted when it is recorded.
        if (c.sessions[record.provider]?.id && record.context?.sessionMode !== 'fresh') c.sessions[record.provider].turns = (c.sessions[record.provider].turns || 0) + 1;
        // A planning run is read-only by itself; the person's own access and approval settings stay as they were.
        Object.assign(c, { provider: record.provider, ...(record.orchestration ? {} : { mode: record.mode, approvalPolicy: record.approvalPolicy || 'ask' }), model: record.model, transport: record.transport, settingsRevision: record.seq });
        c.models[record.provider] = record.model; c.transports[record.provider] = record.transport;
      } else if (record.review) c.reviews = [{ ...record.review, id: record.id, startedAt: record.at, status: 'running', findings: [] }, ...c.reviews].slice(0, 10);
      if (record.title) c.title = record.title;
      if (record.execution) c.activeExecution = record.execution;
      const routing = record.routing?.mode ? { ...record.routing, mode: normalizeRoutingMode(record.routing.mode) } : record.routing;
      const submitted = { ...record.message, ...(record.message?.routing?.mode ? { routing: { ...record.message.routing, mode: normalizeRoutingMode(record.message.routing.mode) } } : {}), seq: record.seq };
      c.messages.push(submitted); c.messageById.set(submitted.id, submitted);
      c.requests[record.requestId] = { runId: record.id, requestId: record.requestId, fingerprint: record.fingerprint };
      c.activeRun = { id: record.id, ...(record.execution ? { execution: record.execution } : {}), provider: record.provider, mode: record.mode, approvalPolicy: record.approvalPolicy || 'ask', model: record.model, transport: record.effectiveTransport || record.transport, baseline: record.baseline, context: record.context, ...(record.context?.verification ? { verification: record.context.verification } : {}), ...(record.local ? { connection: 'local', local: record.local } : {}), ...(record.review ? { purpose: 'review', reviewId: record.id } : {}), ...(routing ? { routing } : {}), ...(record.automaticReview ? { automaticReview: { ...record.automaticReview, status: 'building' } } : {}), effort: record.effort ?? null, phase: 'starting', lastEventAt: record.at, toolCount: 0, startedAt: record.at }; c.status = 'running';
      if (record.task) Object.assign(c.activeRun, { taskId: record.task.id, parentRunId: record.task.parentRunId, relation: record.task.relation });
      if (record.plan) c.activeRun.plan = record.plan;
      if (record.orchestration) Object.assign(c.activeRun, { purpose: 'plan', orchestrationId: record.id });
    }
    applyOrchestration(c, record);
    if (record.type === 'background_review') { c.reviews = [record.review, ...c.reviews].slice(0, 10); c.reviewRequests[record.review.requestId] = { reviewId: record.review.id, requestId: record.review.requestId, fingerprint: record.review.fingerprint }; }
    if (record.type === 'review_process') { const review = c.reviews.find(item => item.id === record.id); if (review) Object.assign(review, { pid: record.pid, pidStart: record.pidStart }); }
    if (record.type === 'review_result') { const review = c.reviews.find(item => item.id === record.id); if (review) Object.assign(review, record.result, { endedAt: record.at }); }
    if (record.type === 'title') c.title = record.title;
    // Checkpoints (#20): a run's folders saved before and after it, and the undos made from them.
    if (['run_snapshot', 'rewind', 'snapshot_expired'].includes(record.type)) c.checkpointRevision = record.seq;
    if (record.type === 'run_snapshot') { c.snapshots ||= {}; const saved = c.snapshots[record.runId] ||= {}; saved[record.phase] = { folders: record.folders, at: record.at }; if (record.phase === 'after') { saved.files = record.files || 0; const run = c.runs?.findLast(item => item.id === record.runId); if (run) run.files = saved.files; } }
    if (record.type === 'rewind') c.rewinds = [...(c.rewinds || []).filter(item => item.id !== record.id), { id: record.id, target: record.target, runId: record.runId, folders: record.folders, counts: record.counts, left: record.left || [], pending: Boolean(record.pending), at: record.at }];
    if (record.type === 'snapshot_expired') { for (const id of record.runIds || []) delete c.snapshots?.[id]; const gone = new Set(record.rewindIds || []); c.rewinds = (c.rewinds || []).filter(item => !gone.has(item.id)); }
    if (record.type === 'message') { const added = { ...record.message, ...(record.message?.routing?.mode ? { routing: { ...record.message.routing, mode: normalizeRoutingMode(record.message.routing.mode) } } : {}), seq: record.seq }; c.messages.push(added); c.messageById.set(added.id, added); }
    if (record.type === 'message_update') {
      const message = findMessage(c, record.id);
      if (!message) throw new Error('Conversation contains an update without its original message.');
      Object.assign(message, record.update, { seq: record.seq });
    }
    if (record.type === 'session') {
      const previous = c.sessions[record.provider], same = previous?.id === record.id;
      c.sessions[record.provider] = {
      id: record.id, cursor: c.sessions[record.provider]?.id === record.id ? c.sessions[record.provider].cursor : 0,
      managedContextVersion: record.managedContextVersion ?? (same ? previous.managedContextVersion : undefined),
      ...(same ? { turns: previous.turns || 1, ...(previous.seed ? { seed: previous.seed } : {}) } : { turns: 1, ...(sessionSeed(c.activeRun?.context, record.at) ? { seed: sessionSeed(c.activeRun?.context, record.at) } : {}) }),
      ...(same && previous.contextEstimate ? { contextEstimate: previous.contextEstimate } : record.managedContextVersion ? { contextEstimate: { baseTokens: 0, bytes: c.activeRun?.context?.bytes || 0, observedAt: record.at } } : {}),
      ...(c.sessions[record.provider]?.id === record.id && c.sessions[record.provider]?.needsContextRefresh ? { needsContextRefresh: true } : {}),
      ...(c.sessions[record.provider]?.id === record.id && c.sessions[record.provider]?.contextUsage ? { contextUsage: c.sessions[record.provider].contextUsage } : {}),
      workspaceSignature: record.workspaceSignature,
      };
    }
    if (record.type === 'session_lost' && c.sessions[record.provider]?.id === record.id) delete c.sessions[record.provider];
    if (record.type === 'checkpoint' && c.sessions[record.provider]) {
      c.sessions[record.provider].cursor = record.seq;
      if (c.lastRun?.context?.restoredAfterCompaction && !c.lastRun.compactions) c.sessions[record.provider].needsContextRefresh = false;
      if (c.lastRun?.context?.rollover && c.contextRollovers?.[record.provider]) c.contextRollovers[record.provider].pending = false;
    }
    if (record.type === 'run_start') {
      c.activeRun = { id: record.id, provider: record.provider, startedAt: record.at };
      c.status = 'running';
    }
    if (record.type === 'run_process' && c.activeRun) Object.assign(c.activeRun, { pid: record.pid, pidStart: record.pidStart });
    if (record.type === 'run_end') { if (c.activeRun && !c.activeRun.reviewId) c.lastBuilder = c.activeRun.provider; c.lastRun = { ...c.activeRun, status: record.status, errorCategory: record.errorCategory || null, endedAt: record.at }; c.activeRun = null; c.status = record.status; }
      // A short history of runs, rebuilt from the journal, for "while you were away" recaps (#22).
    if (record.type === 'submission' || record.type === 'run_start') {
      const runText = String(record.message?.text || '');
      const isContinuationRun = record.task?.relation === 'continuation' || /^\s*Continue the unfinished task from this shared conversation/i.test(runText);
      const taskPrompt = isContinuationRun
        ? ((c.runs || []).findLast(r => r.taskId === record.task?.id && r.prompt && !/^\s*Continue the unfinished task from this shared conversation/i.test(r.prompt))?.prompt
           || c.messages?.find(m => m.role === 'user' && !/^\s*Continue the unfinished task from this shared conversation/i.test(m.text || '') && (m.runId === record.task?.id || c.taskOfRun?.[m.runId] === record.task?.id))?.text?.slice(0, 300)
           || runText.slice(0, 300))
        : runText.slice(0, 300);
      c.runs = [...(c.runs || []), { id: record.id, ...(record.execution ? { execution: record.execution } : {}), ...(record.task ? { taskId: record.task.id, parentRunId: record.task.parentRunId, relation: record.task.relation } : {}), ...(record.context?.scope ? { context: { scope: record.context.scope } } : {}), provider: record.provider, model: record.model || null, mode: record.mode || null, ...(record.review ? { review: record.review } : {}), ...(record.context?.verification ? { verification: record.context.verification } : {}), local: Boolean(record.local), prompt: taskPrompt, startedAt: record.at, endedAt: null, status: 'running', errorCategory: null,
        ...(record.automaticReview ? { automaticReview: { ...record.automaticReview, status: 'building', summary: 'Build first, then one read-only review of the selected folders.' } } : {}),
        ...(record.routing ? { routing: { mode: normalizeRoutingMode(record.routing.mode), tier: record.routing.tier || null } } : {}), ...(record.retryOf ? { retryOf: record.retryOf } : {}) }].slice(-50);
    }
    if (record.type === 'run_end') {
      const run = c.runs?.findLast(item => item.id === c.lastRun?.id && !item.endedAt);
      if (run) Object.assign(run, { status: record.status, errorCategory: record.errorCategory || null, endedAt: record.at,
        ...(c.lastRun ? { compactions: c.lastRun.compactions, compactionEvents: c.lastRun.compactionEvents, contextUsage: c.lastRun.contextUsage, usageMeasured: c.lastRun.usageMeasured } : {}),
        ...(typeof c.lastRun?.elapsedMs === 'number' ? { elapsedMs: c.lastRun.elapsedMs } : {}) });
      if (run) observeRunSize(c, run);
    }
    if (record.type === 'automatic_review_phase') {
      for (const run of [c.activeRun, c.lastRun, ...c.runs]) if (run?.id === record.runId && run.automaticReview) Object.assign(run.automaticReview, record.phase);
    }
    estimateContext(c, record, previousBytes);
  }

  // Keeps usage limit readings apart from what runs used: these are account-wide and may include other tools (#84). Only a
  // reading that differs from the last one is saved.
  observeQuota(c, provider, usage) {
    if (!usage?.available || !Array.isArray(usage.windows) || !usage.windows.length) return;
    const windows = usage.windows.filter(row => Number.isFinite(row.usedPercent) && !row.disabled).map(({ id, label, usedPercent, resetsAt, scope, scopes }) => ({ id, label, usedPercent, resetsAt: resetsAt || null, ...(scope ? { scope } : {}), ...(Array.isArray(scopes) ? { scopes } : {}) }));
    const signature = JSON.stringify(windows), key = `${c.id}:${provider}`;
    this.quotaSeen ||= new Map();
    const at = usage.checkedAt ?? usage.observedAt ?? usage.fetchedAt, time = at && new Date(at).getTime();
    const priorTime = Date.parse(c.quotaReadings?.[provider]?.observedAt);
    if (!windows.length || this.quotaSeen.get(key) === signature && (!Number.isFinite(time) || time - priorTime < 60000)) return;
    this.quotaSeen.set(key, signature);
    this.record(c, { type: 'quota_observation', provider, observedAt: Number.isFinite(time) ? new Date(time).toISOString() : null, plan: usage.plan || null, windows });
  }
  // A reading on each side of a run says what moved during it. Reading a limit uses no allowance, nothing waits for it, and a
  // reading that can't be had leaves that run's move unknown.
  readQuota(c, provider, { refresh = false } = {}) {
    Promise.resolve().then(() => this.checks.usage(provider, { ...this.usageOptions(provider), refresh })).then(usage => this.observeQuota(c, provider, usage)).catch(() => {});
  }

  // Project memory (#21): every change comes from the person, through here.
  memory(c) { return memoryView(c, this.workspaceFolders); }
  async copyMemoryToInstructions(c, input) {
    const folder = this.workspaceFolders.find(item => item.id === input.folderId);
    if (!folder) throw Object.assign(new Error('That folder is no longer in this workspace.'), { status: 404 });
    const withFolders = this.tasks?.withFolders || ((paths, operation, work) => work());
    // Worked out again under the lease: the preview's hash must still match the file before anything is written.
    const plan = await withFolders([folder.path], 'copying memory to AGENTS.md', async () => { const current = planCopy(c, this.workspaceFolders, input); writeCopy(current, input.sha256); return current; });
    if (input.retire === true) for (const entry of plan.entries) this.record(c, { type: 'memory_update', id: entry.id, changes: { status: 'retired' } });
    return { ...this.memory(c), copied: plan.preview };
  }
  changeMemory(c, input = {}) {
    const found = () => { const entry = (c.memory || []).find(item => item.id === input.id); if (!entry) throw Object.assign(new Error('That memory is no longer here.'), { status: 404 }); return entry; };
    // Copy to AGENTS.md: a preview first, then the write under the folder's lease, so no run edits the file meanwhile.
    if (input.action === 'instructions-preview') return { ...this.memory(c), copy: planCopy(c, this.workspaceFolders, input).preview };
    if (input.action === 'instructions-write') return this.copyMemoryToInstructions(c, input);
    if (input.action === 'add') {
      if ((c.memory || []).filter(entry => entry.status === 'active').length >= memoryLimit) throw Object.assign(new Error(`Memory holds up to ${memoryLimit} entries. Retire some first.`), { status: 409 });
      this.record(c, { type: 'memory_add', entry: newEntry(input, this.workspaceFolders) });
    } else if (input.action === 'edit') {
      found();
      const clean = cleanEntryInput(input, this.workspaceFolders);
      this.record(c, { type: 'memory_update', id: input.id, changes: { ...clean, files: attachedFiles(clean.text, this.workspaceFolders, clean.folderId) } });
    } else if (input.action === 'retire' || input.action === 'restore') {
      found();
      this.record(c, { type: 'memory_update', id: input.id, changes: { status: input.action === 'retire' ? 'retired' : 'active' } });
    } else if (input.action === 'remove') { found(); this.record(c, { type: 'memory_remove', id: input.id }); }
    else if (input.action === 'dismiss') {
      if (typeof input.key !== 'string' || !/^[\da-f]{16}$/.test(input.key)) throw Object.assign(new Error('Choose a suggestion to dismiss.'), { status: 400 });
      this.record(c, { type: 'memory_dismiss', key: input.key });
    } else throw Object.assign(new Error('Unknown memory action.'), { status: 400 });
    return this.memory(c);
  }

  // The task ledger for a conversation (#84), worked out from its journal. Prompts and commands only when asked for.
  // Smart results (#139) for the whole workspace: every conversation and its parallel tasks. Only task summaries are
  // kept between requests, and a journal is read again only once it has changed.
  async results(options = {}) {
    const prompts = options.prompts === true, tasks = [];
    this.resultsCache ||= new Map();
    for (const c of this.conversations.values()) {
      const file = path.join(this.dataDir, `${c.id}.jsonl`), key = `${c.id}:${prompts}`;
      let stat;
      try { stat = await fs.promises.stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const version = `${stat.size}:${stat.mtimeMs}`, cached = this.resultsCache.get(key);
      if (cached?.version !== version) this.resultsCache.set(key, { version, tasks: (await readLedger(file, { prompts })).tasks });
      tasks.push(...this.resultsCache.get(key).tasks);
    }
    if (this.tasks) tasks.push(...await this.tasks.ledgers({ prompts }));
    return smartResults(tasks, { ...options, prompts });
  }
  async ledger(c, options = {}) { const ledger = await readLedger(path.join(this.dataDir, `${c.id}.jsonl`), options); return this.tasks ? { ...ledger, tasks: [...ledger.tasks, ...await this.tasks.ledgers(options)].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))) } : ledger; }

  compactContext(c, { provider = c.provider } = {}, viewOptions = {}) {
    if (!PROVIDERS.includes(provider)) throw Object.assign(new Error('Choose a supported agent.'), { status: 400 });
    if (this.running || c.resume || c.limitSwitching) throw Object.assign(new Error('Finish or stop the current run or reset wait before compacting context.'), { status: 409 });
    if (c.contextRollovers?.[provider]?.pending) return this.view(c, viewOptions);
    const lease = this.acquireMutation('compact-context');
    try {
      const milestone = milestoneMemory(c, { folders: this.workspaceFolders, text: continuationRequest });
      this.record(c, { type: 'context_compact_requested', provider, milestone });
    } finally { lease.release(); }
    return this.view(c, viewOptions);
  }

  // What a fresh agent would be told if this task moved now, without starting anything (#85).
  briefPreview(c) {
    const provider = c.provider, text = c.messages.some(message => message.role === 'user') ? continuationRequest : 'Preview';
    const decision = rolloverDecision(c, provider, { normalLimit: this.contextLimit(), routingMode: c.routing?.mode || this.contextRouting() });
    const rollover = decision.rollover ? { ...decision, memory: milestoneMemory(c, { folders: this.workspaceFolders, text }) } : null;
    const prepared = prepareContext(c, text, { verification: verificationForRun(this.verificationCadence()), rollover, workspace: this.workspace, workspaceFolders: this.workspaceFolders, fresh: true, provider, mode: c.mode, policy: this.contextPolicy, journal: path.join(this.dataDir, `${c.id}.jsonl`), skills: this.skills.forTask(c, { text, relation: text === continuationRequest ? 'continuation' : null, fresh: true, provider }), readAttachment: () => ({ text: '' }), includeImages: false });
    const envelope = JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf('\n') + 1));
    return { brief: envelope.brief || null, ...(envelope.milestone ? { milestone: envelope.milestone } : {}), metadata: prepared.metadata };
  }

  record(c, value) {
    const record = { ...value, seq: c.records + 1, at: new Date().toISOString() };
    const filename = path.join(this.dataDir, `${c.id}.jsonl`), fd = fs.openSync(filename, 'a', 0o600);
    try {
      const start = fs.fstatSync(fd).size;
      try { const bytes = Buffer.from(`${JSON.stringify(record)}\n`); let offset = 0; while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!count) throw new Error('Journal write made no progress.'); offset += count; } fs.fsyncSync(fd); }
      // Remove a failed append, or the next record would be joined onto it. Windows cannot truncate through an append handle, so truncate by path.
      catch (error) { try { fs.truncateSync(filename, start); } catch {} throw error; }
    } finally { fs.closeSync(fd); }
    this.apply(c, record);
    for (const observation of observationsFor(c, record)) {
      const prior = c.semanticObservations?.find(item => item.id === observation.id);
      const { observedAt, ...value } = prior || {};
      if (JSON.stringify(value) !== JSON.stringify(observation)) this.record(c, { type: 'semantic_observation', observation });
    }
    this.emit('update', { conversationId: c.id });
    return record;
  }

  message(c, role, text, provider, id = randomUUID(), status, toolOutcome = null) {
    const existing = findMessage(c, id);
    const outcome = toolOutcome ? { toolOutcome } : {};
    if (existing && text.startsWith(existing.text) && text !== existing.text) this.record(c, { type: 'message_delta', id, text: text.slice(existing.text.length), ...(status ? { status } : {}), ...outcome });
    else if (existing && (text !== existing.text || (status && status !== existing.status) || toolOutcome && JSON.stringify(toolOutcome) !== JSON.stringify(existing.toolOutcome))) this.record(c, { type: 'message_update', id, update: { ...(text !== existing.text ? { text } : {}), ...(status ? { status } : {}), ...outcome } });
    else if (existing) return id;
    else this.record(c, { type: 'message', message: { id, role, text, provider, status, ...outcome,
      createdAt: new Date().toISOString(), runId: c.activeRun?.id, ...(c.activeRun?.connection === 'local' ? { connection: 'local' } : {}), ...(c.activeRun?.reviewId ? { reviewId: c.activeRun.reviewId } : {}), ...(c.activeRun?.orchestrationId ? { orchestrationId: c.activeRun.orchestrationId } : {}), model: c.activeRun?.effectiveModel || c.activeRun?.model || null, effort: c.activeRun?.effectiveEffort || c.activeRun?.effort || null } });
    if (role === 'activity' && c.activeRun?.id) { try { this.budget.observeStep(c, findMessage(c, id)); } catch (error) { console.error('Codeshi could not count a step:', error.message); } }
    return id;
  }

  get(id) {
    const conversation = this.conversations.get(id);
    if (!conversation) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
    return conversation;
  }

  // With since, the messages changed after that record; an import can put messages anywhere, so one after it sends them all.
  view(c, { since = null, limit = null, before = null, toRun = null, toMessage = null } = {}) {
    const { messageById, sessions, requests, reviewRequests, records, imports, reviews, snapshots, rewinds, reordered, memory, memoryDismissed, skills, skillDirs, taskBudgets, taskOfRun, budgetActive, budgetLast, budgetTotals, quotaReadings, quotaHistory, usageSeen, parallelTasks, asyncQuestions, semanticObservations, contextRollovers, executionPolicies, executionDefault, executionMigrated, activeExecution, routingRequests, routingAssessment, routingPending, ...visible } = c;
    const changed = Number.isSafeInteger(since) && since >= (reordered || 0) && since <= records ? c.messages.filter(message => message.seq > since) : null;
    if (c.routingPending) { visible.status = 'running'; visible.activeRun = c.routingPending; visible.canAddToRun = false; }
    const contextFor = provider => contextControlView(c, provider, rolloverDecision(c, provider, { normalLimit: this.contextLimit(), routingMode: c.routing?.mode || this.contextRouting() }));

    let messages = changed || c.messages;
    let earlier = undefined;
    let messageCount = changed ? c.messages.length : undefined;

    if (!changed && (toRun || toMessage || (Number.isInteger(Number(limit)) && Number(limit) > 0))) {
      let end = c.messages.length;
      if (before) {
        const idx = c.messages.findIndex(m => m.id === before);
        if (idx !== -1) end = idx;
      }
      if (toRun) {
        const idx = c.messages.findIndex(m => m.runId === toRun);
        if (idx !== -1) {
          let start = idx;
          while (start > 0 && !(c.messages[start].role === 'user' && !c.messages[start].steer)) start--;
          earlier = start;
          messages = c.messages.slice(start, end);
          messageCount = c.messages.length;
        } else if (Number.isInteger(Number(limit)) && Number(limit) > 0) {
          const lim = Number(limit);
          const start = Math.max(0, end - lim);
          earlier = start;
          messages = c.messages.slice(start, end);
          messageCount = c.messages.length;
        }
      } else if (toMessage) {
        const idx = c.messages.findIndex(m => m.id === toMessage);
        if (idx !== -1) {
          let start = idx;
          while (start > 0 && !(c.messages[start].role === 'user' && !c.messages[start].steer)) start--;
          earlier = start;
          messages = c.messages.slice(start, end);
          messageCount = c.messages.length;
        } else if (Number.isInteger(Number(limit)) && Number(limit) > 0) {
          const lim = Number(limit);
          const start = Math.max(0, end - lim);
          earlier = start;
          messages = c.messages.slice(start, end);
          messageCount = c.messages.length;
        }
      } else {
        const lim = Number(limit);
        const start = Math.max(0, end - lim);
        earlier = start;
        messages = c.messages.slice(start, end);
        messageCount = c.messages.length;
      }
    }

    return { ...visible, execution: this.execution.view(c), contextControl: contextFor(c.activeRun?.provider || c.provider), usageWatch: c.lastRun?.provider ? usageWatch(c, contextFor(c.lastRun.provider)) : null, cursor: records, ...(this.tasks ? { parallelTasks: this.tasks.list(c) } : {}), ...(c.status === 'running' ? {} : { taskResult: taskResult(c) }), ...(messageCount !== undefined ? { messageCount } : {}), ...(earlier !== undefined ? { earlier } : {}), checkpoints: this.checkpoints?.summary(c) || {}, resume: c.resume ? { ...c.resume, ...this.resume?.view(c) } : null, reviews: reviews.map(publicReview), pendingApprovals: this.pendingApprovals(c), canAddToRun: this.running?.c.id === c.id && this.running.steerable && !this.running.ending, messages: messages.map(({ seq, ...m }) => m) };
  }

  pendingApprovals(c) {
    return [...(this.running?.c === c ? this.running.approvals.values() : []), ...(c.asyncQuestions || [])];
  }

  pendingCount() { return [...this.conversations.values()].reduce((sum, c) => sum + this.pendingApprovals(c).length, 0); }

  list() {
    return [...this.conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, provider, mode, approvalPolicy, status, updatedAt }) => ({ id, title, provider, mode, approvalPolicy: approvalPolicy || 'ask', status, updatedAt }));
  }

  create() {
    const c = this.empty(randomUUID());
    this.conversations.set(c.id, c);
    this.record(c, { type: 'created', title: 'New conversation' });
    return this.view(c);
  }

  settings(c, { provider = c.provider, mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', model = provider === c.provider ? c.model : c.models[provider] || null, transport = provider === c.provider ? c.transport || 'auto' : c.transports[provider] || 'auto', effort = c.efforts[provider]?.[model || 'default'] ?? null }, viewOptions = {}) {
    checkSettings(provider, mode, approvalPolicy);
    this.validateSelection(model, transport, effort);
    if (c.activeRun && (provider !== c.provider || mode !== c.mode || approvalPolicy !== (c.approvalPolicy || 'ask'))) throw Object.assign(new Error('Stop the current run before switching assistants.'), { status: 409 });
    this.record(c, { type: 'settings', provider, mode, approvalPolicy, model, transport, effort });
    return this.view(c, viewOptions);
  }

  // Auto (#12, #128): Codeshi picks the agent, model and effort for each message, in Smart, Saver or Ultra. Agents billed
  // outside a subscription are only chosen when allowed. Choosing a model by hand turns it off.
  orchestrationAction(c, input) { return orchestrationAction(this, c, input); }

  setRouting(c, input = {}, viewOptions = {}) {
    if (input.mode !== null && input.mode !== undefined && !ROUTING_MODES.includes(input.mode)) throw Object.assign(new Error('Choose Smart, Saver or Ultra.'), { status: 400 });
    const routing = input.mode === null || input.mode === undefined ? null : { mode: normalizeRoutingMode(input.mode), allowApi: input.allowApi === true, check: input.check === true };
    if (c.activeRun) throw Object.assign(new Error('Stop the current run before changing how agents are chosen.'), { status: 409 });
    const defaults = this.execution.defaults(c), active = this.execution.active(c);
    this.execution.expect(defaults.revision, input.executionRevision);
    if (!routing && active?.mode === 'flow') {
      // Leaving Flow also revokes the previous task's automatic continuations and queued decisions.
      this.execution.change(c, { taskId: active.taskId, revision: active.revision, action: 'takeover' });
    } else {
      this.execution.setDefault(c, { ...defaults, mode: routing ? 'flow' : 'normal', automation: undefined, routingMode: routing?.mode || 'smart', ...(!routing ? { override: null } : {}) }, { expectedRevision: input.executionRevision });
    }
    this.record(c, { type: 'routing', routing });
    return this.view(c, viewOptions);
  }

  validateSelection(model, transport, effort = null) {
    if (model !== null && model !== undefined && (typeof model !== 'string' || model.length > 200 || !model.trim())) throw Object.assign(new Error('Enter a model identifier of at most 200 characters.'), { status: 400 });
    if (effort !== null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw Object.assign(new Error('Choose a supported reasoning effort or provider default.'), { status: 400 });
    if (!['auto', 'cli', 'app-server', 'sdk', 'acp'].includes(transport)) throw Object.assign(new Error('Choose a supported provider transport.'), { status: 400 });
  }

  importTranscript(c, preview) { return this.importTranscripts(c, [preview]); }
  // Imports one or more reviewed native conversations as a single journal record, interleaved by original time.
  importTranscripts(c, previews) {
    if (c.activeRun || this.running) throw Object.assign(new Error('Stop the current run before importing a conversation.'), { status: 409 });
    const pending = previews.map(preview => ({ preview, importId: `${preview.provider}:${preview.sessionId}:${preview.digest}` })).filter(({ importId }) => !c.imports[importId]);
    if (!pending.length) return { imported: 0, updated: 0, duplicate: true, conversationId: c.id };
    const known = new Map(c.messages.filter(m => m.importSource).map(m => [m.importSource, m]));
    // A message without a timestamp takes the time of the nearest timed message before it in its conversation (or after it, at the start), so it stays beside it. A conversation with no times at all goes at the end.
    const rows = pending.flatMap(({ preview }, source) => {
      const times = preview.messages.map(message => Date.parse(message.timestamp)); let time = times.find(Number.isFinite) ?? Infinity;
      return preview.messages.map((message, index) => { if (Number.isFinite(times[index])) time = times[index]; return { preview, message, time, source, index }; });
    });
    rows.sort((first, second) => (first.time > second.time) - (first.time < second.time) || first.source - second.source || first.index - second.index);
    const entries = rows.map(({ preview, time, message: { timestamp, ...message } }) => {
      const importSource = `${preview.provider}:${preview.sessionId}:${message.sourceId}`, previous = known.get(importSource);
      return { time, message: { ...message, provider: preview.provider === 'file' ? message.provider : preview.provider, id: previous?.id || randomUUID(), createdAt: previous?.createdAt || (Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : new Date().toISOString()), importSource } };
    }).filter(({ message }) => !known.has(message.importSource) || known.get(message.importSource).text !== message.text);
    const messages = entries.map(entry => entry.message), updated = messages.filter(message => known.has(message.importSource)).length;
    this.record(c, { type: 'import', importId: pending[0].importId, importIds: pending.map(row => row.importId), messages, after: importPlaces(c.messages, entries.filter(({ message }) => !known.has(message.importSource))) });
    return { imported: messages.length - updated, updated, duplicate: !messages.length, conversationId: c.id };
  }

  touch(run, phase) {
    if (!run.c.activeRun) return;
    const now = new Date().toISOString();
    Object.assign(run.c.activeRun, { lastEventAt: now, ...(phase ? { phase } : {}) });
    run.lastPhase = phase || run.lastPhase;
    if (!run.lastProgressNotice || Date.now() - run.lastProgressNotice > 750) { run.lastProgressNotice = Date.now(); this.emit('update', { conversationId: run.c.id }); }
  }

  updateContext(c, input) { const context = validateContext(input, c.context); if (JSON.stringify(context) !== JSON.stringify(c.context)) this.automaticReviews?.invalidate(c, this.running, 'The saved project brief changed. Authorize a new review.'); this.record(c, { type: 'context', context }); return this.view(c); }

  // `remember` keeps an allowed action's exact scope for the rest of the run ('run') or for the workspace ('workspace').
  approve(runId, approvalId, allow, remember = null) {
    const run = this.running;
    if (!run || run.id !== runId || !run.approvals.has(approvalId)) throw Object.assign(new Error('This approval is no longer pending.'), { status: 409 });
    if (typeof allow !== 'boolean') throw Object.assign(new Error('Choose allow or deny.'), { status: 400 });
    if (remember !== null && !['run', 'workspace'].includes(remember)) throw Object.assign(new Error('Choose this run or this workspace.'), { status: 400 });
    const approval = run.approvals.get(approvalId);
    if (approval.kind === 'question') throw Object.assign(new Error('This is a question. Choose your answers, or skip it.'), { status: 409 });
    if (remember && (!allow || !approval.scope)) throw Object.assign(new Error('Only an allowed action with an exact scope can be remembered.'), { status: 400 });
    run.approvals.delete(approvalId);
    if (remember === 'run') (run.allowances ||= new Set()).add(approval.scope.key);
    if (remember === 'workspace') this.permissions.remember(approval.scope, run.provider);
    run.child?.send({ type: 'approval-result', id: approvalId, allow });
    this.message(run.c, 'activity', remember ? `Allowed ${remember === 'run' ? 'for this run' : 'and remembered for this workspace'}: ${approval.scope.label}` : `Approval ${allow ? 'allowed' : 'denied'} by the user.`, run.provider);
    return { resolved: true };
  }

  // Answers to an agent's questions: one list per question, each an option's label or the person's own words, or
  // null to skip them. The conversation keeps what was asked and answered, for the agents that read it later.
  answer(runId, questionId, answers, conversation = null) {
    const c = conversation || [...this.conversations.values()].find(c => c.asyncQuestions?.some(item => item.runId === runId && item.id === questionId));
    const optional = c?.asyncQuestions?.find(item => item.runId === runId && item.id === questionId);
    if (optional) return this.answerAsync(c, optional, answers);
    const run = this.running, item = run && run.id === runId ? run.approvals.get(questionId) : null;
    if (!item || item.kind !== 'question' || conversation && run.c !== conversation) throw Object.assign(new Error('This question is no longer waiting for an answer.'), { status: 409 });
    const checked = checkAnswers(item.questions, answers);
    run.approvals.delete(questionId);
    run.child?.send({ type: 'question-result', id: questionId, answers: checked });
    this.message(run.c, 'activity', answerSummary(item.questions, checked), run.provider);
    return { resolved: true };
  }

  async answerAsync(c, item, answers) {
    const checked = checkAnswers(item.questions, answers), text = answerSummary(item.questions, checked);
    this.answeringQuestions ||= new Set();
    if (this.answeringQuestions.has(item.id)) throw Object.assign(new Error('This answer is already being sent.'), { status: 409 });
    this.answeringQuestions.add(item.id);
    try {
      let result = {};
      if (checked) {
        const run = this.running;
        // An async question never pauses Codex. While it works, send the answer as input to the same turn. Once
        // finished, prepare a normal prompt so the person can review it and use the usual Send/billing controls.
        if (run?.c === c && run.steerable && !run.ending) result = await this.addToRun(c, { text });
        else result = { draft: text };
      } else this.message(c, 'activity', text, item.provider);
      this.record(c, { type: 'async_question_end', id: item.id });
      return { resolved: true, ...result };
    } finally { this.answeringQuestions.delete(item.id); }
  }

  async status() {
    // Checking starts an agent CLI with --version, and the window asks for status every 15 seconds while it is shown.
    // So a check that succeeded stands for five minutes, or until the CLI is installed, moved or updated. A check that
    // failed or timed out is made again after ten seconds, so a CLI that starts working is seen as soon as before.
    const bins = Object.fromEntries(PROVIDERS.map(provider => [provider, resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot })]));
    const identities = Object.fromEntries(PROVIDERS.map(provider => [provider, JSON.stringify(fileIdentity(bins[provider]))]));
    const checks = this.providerChecks || {}, now = performance.now();
    const due = PROVIDERS.filter(provider => !this.providerStatus?.[provider] || checks[provider]?.identity !== identities[provider] || now - checks[provider].at >= (checks[provider].ok ? 5 * 60 * 1000 : 10000));
    if (due.length) {
      if (!this.providerStatusPending) {
        this.providerStatusPending = Promise.all(PROVIDERS.map(async provider => {
          if (!due.includes(provider)) return [provider, this.providerStatus[provider], checks[provider]];
          const bin = bins[provider];
          this.bins[provider] = bin;
          const check = ok => ({ identity: identities[provider], ok, at: performance.now() });
          if (provider === 'gemini' && isAntigravityACP(bin)) return [provider, { installed: true, available: true, path: bin, authenticated: 'unknown', billingSource: 'unknown', capabilities: { ...capabilities(provider), readOnly: 'unavailable' } }, check(true)];
          const result = bin ? await probeCli(bin, ['--version'], 4000) : null;
          // A CLI that is slow to answer is still installed: keep its last known status, or treat it as usable but unverified.
          if (result?.timedOut && this.providerStatus?.[provider]) return [provider, this.providerStatus[provider], check(false)];
          const usable = result?.status === 0 || Boolean(result?.timedOut);
          const agyBlocked = provider === 'gemini' && isAgy(bin) && Boolean(this.configuredBins[provider]);
          return [provider, { available: usable && !agyBlocked, version: clip(result?.stdout?.trim(), 200), path: bin, installed: usable, ...(result?.timedOut && { errorCategory: 'timeout' }), authenticated: 'unknown', billingSource: 'unknown', authMode: 'unknown', usage: 'unknown', capabilities: capabilities(provider, this.configuredBins[provider] ? 'cli' : 'auto') }, check(result?.status === 0)];
        })).then(entries => {
          this.providerStatus = Object.fromEntries(entries.map(([provider, status]) => [provider, status]));
          this.providerChecks = Object.fromEntries(entries.map(([provider, , check]) => [provider, check]));
        }).finally(() => { this.providerStatusPending = null; });
        // A background check that nobody awaits must not become an unhandled rejection.
        this.providerStatusPending.catch(() => {});
      }
      // Only the first check waits. Later ones refresh in the background, so a slow CLI never delays the conversation.
      if (!this.providerStatus) await this.providerStatusPending;
    }
    return { workspace: this.workspace, workspaces: this.workspaces, workspaceFolders: this.workspaceFolders, providers: this.providerStatus, runningConversationId: this.running?.c.id || null, workspaceActivity: this.workspaceActivity(), verificationCadence: this.verificationCadence(), pendingApprovals: [...this.conversations.values()].flatMap(c => this.pendingApprovals(c)) };
  }

  // Read-only activity across the workspace, even when the viewer has a different task open. This describes
  // pending work for the Flow preview's view-switch guard; it does not grant or change execution authority.
  workspaceActivity() {
    const activity = { running: 0, checking: this.tasks?.checking?.size || 0, reviewing: 0, waiting: 0, queued: 0 };
    for (const broker of [this, ...(this.tasks?.openLanes() || [])]) for (const c of broker.conversations.values()) {
      if (c.status === 'running' || broker.running?.c === c) activity.running++;
      activity.checking += (c.runs || []).filter(run => run.check?.status === 'running').length;
      activity.reviewing += (c.reviews || []).filter(review => review.status === 'running').length;
      if (c.resume || c.limitSwitching) activity.waiting++;
      if (!c.queuePaused) activity.queued += c.queue?.length || 0;
      activity.waiting += (c.parallelTasks || []).filter(task => task.status === 'waiting' && !task.held && !task.closed).length;
    }
    return { ...activity, busy: Object.values(activity).some(count => count > 0) };
  }

  prompt(c, text, fresh = false) { return prepareContext(c, text, { verification: verificationForRun(this.verificationCadence()), workspace: this.workspace, workspaceFolders: this.workspaceFolders, fresh: fresh || c.sessions[c.provider]?.workspaceSignature !== this.workspaceSignature }).prompt; }

  dispatch(c, input, options = {}) { return this.router.start(c, input, options); }

  async findRoutingFallback(c, run, { failedProvider, failedModel, failedQuota, usage = null } = {}) {
    if (!run?.routing) return null;
    const mode = run.routing.mode || 'smart';
    const text = run.message?.text || c.messages.find(m => m.runId === run.id && m.role === 'user')?.text || '';
    const assessment = run.routing.assessment || null;
    const allowApi = run.billingConfirmed === true;
    // The mode's handoff line, so the fallback never starts an agent the running task would leave at its first check (#12).
    const threshold = globalThis.relayRouting.handoffThresholds[globalThis.relayRouting.normalizeMode(mode)] ?? 90;
    const candidates = [];
    const providers = this.availableProviders();
    for (const provider of providers) {
      const options = this.usageOptions(provider);
      let account, provUsage, models;
      try {
        account = await this.handoff.account(provider, { bin: options.bin, workspace: this.workspace, googleRoot: this.googleRoot });
        if (!account?.installed || account.authenticated === false || (!allowApi && account.billingSource !== 'subscription') || !this.handoff.supportsWorkspace(provider, account, run)) continue;
        if (provider === failedProvider && usage) { provUsage = usage; } else { provUsage = this.router?.readings?.get(provider)?.usage; if (!provUsage && c.quotaReadings?.[provider]) { provUsage = { available: true, windows: c.quotaReadings[provider].windows, checkedAt: c.quotaReadings[provider].observedAt }; } if (!provUsage) provUsage = await this.checks.usage(provider, options); }
        this.observeQuota(c, provider, provUsage);
        models = await this.handoff.modelRows(provider);
      } catch { continue; }
      // The run is already saved and holds its task's reservation and counts (#87). Choosing another agent before it
      // starts hands nothing off, so only the task's own limits and allow-lists apply, not its own reservation.
      const allowed = m => (!run.execution || this.execution.allows(c, run.execution, { action: 'routing', provider, model: m }) || this.execution.allows(c, run.execution, { action: 'manual', provider, model: m })) && !this.budget.refusal(c, { task: { id: run.taskId, relation: null }, provider, model: m, runId: run.id });
      let allowedModels = models.map(row => row.id || row.model || row.value).filter(id => id && allowed(id));
      if (provider === failedProvider && failedModel) {
        allowedModels = allowedModels.filter(id => id !== failedModel);
      }
      if (models.length ? !allowedModels.length : !allowed(null)) continue;
      const usualSpend = usualWindowSpend(c, provider);
      candidates.push({ provider, account, models: models.filter(m => !allowedModels.length || allowedModels.includes(m.id || m.model || m.value)), billingSource: account.billingSource, usage: provUsage, eligible: true, ...(allowedModels.length ? { allowedModels } : {}), ...(usualSpend ? { usualSpend } : {}) });
    }
    if (!candidates.length) return null;
    const choice = globalThis.relayRouting.route({ text, attachments: run.message?.attachments?.length || 0, assessment, mode, candidates, current: failedProvider, allowApi, quotaThreshold: threshold });
    if (!choice || choice.error || choice.quota?.state !== 'ok') return null;
    const chosenRow = candidates.find(item => item.provider === choice.provider);
    return {
      provider: choice.provider,
      model: choice.model,
      effort: choice.effort,
      steppedDown: choice.steppedDown || false,
      routing: { mode, reason: choice.reason, tier: choice.tier },
      usage: chosenRow?.usage || null,
      account: chosenRow?.account || null,
      quota: choice.quota
    };
  }

  start(c, { text, attachments: attachmentIds = [], provider = c.provider, mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', fresh = false, model = provider === c.provider ? c.model : c.models[provider] || null, transport = provider === c.provider ? c.transport || 'auto' : c.transports[provider] || 'auto', requestId = randomUUID(), billingConfirmed = false, effort = c.efforts[provider]?.[model || 'default'] ?? null, routing = null, automaticReview = null, orchestrate = false, executionRevision, proceedWithNearQuota = false, role = null }, { execution = null, executionAction = 'manual', verifyExecution, review, verifyReview, local, verifyLocal, resume, queued, retryOf = null, limitChain = null, assessedTask = null, routingEvidence = null, proceedWithNearQuota: optionProceedWithNearQuota = false } = {}) {
    if (review) { mode = 'read'; approvalPolicy = 'ask'; fresh = true; attachmentIds = []; }
    // Orchestrate (#12): a read-only run that proposes a plan, in the conversation's own session so it knows the context.
    // Only a new message asks for one; reviews, queued prompts, retries, resumes and local runs never pass it.
    orchestrate = orchestrate === true;
    if (orchestrate) { checkPlanning(this, { routing, automaticReview }); mode = 'read'; approvalPolicy = 'ask'; }
    if (local) { if (review || typeof verifyLocal !== 'function') throw Object.assign(new Error('Invalid local run.'), { status: 400 }); provider = 'codex'; model = local.model; transport = 'app-server'; effort = null; fresh = true; }
    checkSettings(provider, mode, approvalPolicy);
    this.validateSelection(model, transport, effort);
    routing = review || local ? null : routingNote(routing);
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw Object.assign(new Error('Enter a message between 1 and 100,000 characters.'), { status: 400 });
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw Object.assign(new Error('Invalid request ID.'), { status: 400 });
    const attachments = this.attachments.select(attachmentIds);
    if (local && attachments.some(file => file.kind !== 'text')) throw Object.assign(new Error('This local connection supports text and code attachments. Remove image attachments or choose a cloud agent; your draft stays saved.'), { status: 400 });
    text = text.trim(); model = model || null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ text, ...(orchestrate ? { orchestrate } : {}), ...(automaticReview !== null ? { automaticReview } : {}), ...(local ? { local } : {}), ...(review ? { review: review.snapshot.digest } : {}), ...(attachments.length ? { attachments: attachmentIds } : {}), provider, mode, approvalPolicy, fresh, model, ...(effort ? { effort } : {}), transport: transportFor(provider, transport, this.configuredBins[provider]) })).digest('hex');
    const accepted = c.requests[requestId];
    if (accepted) { if (accepted.fingerprint !== fingerprint) throw Object.assign(new Error('This request ID was already used for another message.'), { status: 409 }); return { runId: accepted.runId, requestId, duplicate: true }; }
    if (this.running) throw Object.assign(new Error('An assistant is already working in this workspace. Stop it before starting another run.'), { status: 409 });
    // Every task in a workspace shares one limit on how many work at once (#88).
    this.admit?.(c);
    // The one place every run starts from, so nothing gets past the task's limits (#87). A request already accepted returned above.
    const runId = randomUUID(), identity = taskIdentity(c, { runId, text, retryOf, review }), task = assessedTask || (execution ? { ...identity, id: execution.taskId } : identity);
    this.execution.expect(this.execution.defaults(c).revision, executionRevision);
    const prospective = this.execution.current(c, task.id) || { ...executionConfig(this.execution.defaults(c)), taskId: task.id, revision: 1 };
    execution ||= { taskId: task.id, revision: prospective.revision };
    const executionOptions = { action: executionAction === 'manual' && routing && !retryOf && !review ? 'routing' : executionAction, provider, model, effort };
    this.execution.assert(c, execution, executionOptions, prospective);
    if (routing && executionOptions.action === 'routing' && routing.mode !== prospective.routingMode) throw Object.assign(new Error('The task routing preference changed. Refresh before sending.'), { status: 409, category: 'execution-policy' });
    verifyExecution?.();
    const targetTaskId = task?.id || c.lastRun?.taskId;
    if (targetTaskId && (retryOf || isExplicitRetry(text)) && c.taskBudgets?.[targetTaskId] && (c.taskBudgets[targetTaskId].stopped?.kind === 'maxRepeatedFailures' || this.budget.exceeded(c, c.taskBudgets[targetTaskId])?.limit === 'maxRepeatedFailures')) {
      this.budget.reset(c, { taskId: targetTaskId });
    }
    this.budget.assertCanStart(c, { task, provider, model, local: Boolean(local) });
    // A task that continues keeps its plan (#92), and a new prompt starts without one.
    const plan = task.relation === 'continuation' ? carriedPlan(c.lastRun) : null;
    if (automaticReview !== null) {
      if (review || local || resume || queued || retryOf || !this.automaticReviews || this.automaticReviews.closed || this.backgroundReview) throw Object.assign(new Error('Preview automatic review for a new coding prompt after the current review finishes.'), { status: 409 });
      automaticReview = validateAutomaticReview(this, c, automaticReview, { text, provider, model, mode, approvalPolicy, attachments: attachmentIds });
    }
    for (const directory of this.workspaces) {
      let available = false;
      try { available = fs.statSync(directory).isDirectory(); } catch {}
      if (!available) throw Object.assign(new Error(`Workspace folder is unavailable: ${directory}. Reconnect it or remove it from this project before starting an assistant.`), { status: 409 });
    }
    let bin = resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot });
    if (!bin) throw Object.assign(new Error(`${provider === 'gemini' ? 'Gemini' : provider === 'codex' ? 'Codex' : 'Claude'} CLI could not be found. Install it or set AI_RELAY_${provider.toUpperCase()}_BIN to its executable path, then retry.`), { status: 503, category: 'installation' });
    if (provider === 'gemini' && isAntigravityACP(bin) && mode === 'read') throw Object.assign(new Error(antigravityReadOnly), { status: 400, category: 'permission' });
    // Gemini CLI takes its effort from the model, so a level saved under the Antigravity connection doesn't apply and can't stop a run.
    if (provider === 'gemini' && !isAntigravityACP(bin)) effort = null;
    // Antigravity negotiates additional folders with the runtime before any prompt is sent.
    if (provider === 'gemini' && isAgy(bin)) throw Object.assign(new Error(agyUnsupported), { status: 503, category: 'installation' });
    let actualTransport = transportFor(provider, transport, this.configuredBins[provider]);
    if ((provider === 'gemini' && actualTransport !== 'acp') || (provider !== 'gemini' && actualTransport === 'acp') || (provider === 'codex' && actualTransport === 'sdk') || (provider === 'claude' && actualTransport === 'app-server')) throw Object.assign(new Error('This transport does not support the selected provider.'), { status: 400 });
    // A native session may retain tool permissions for folders since removed.
    // Reconstruct from the canonical journal whenever membership changes.
    const switchedAgent = Boolean(c.lastRun && (c.lastRun.provider !== provider || c.lastRun.connection === 'local'));
    const changedWorkspace = Boolean(c.sessions[provider] && c.sessions[provider].workspaceSignature !== this.workspaceSignature);
    const ordinaryFresh = Boolean(fresh || changedWorkspace || switchedAgent || !c.sessions[provider]?.id);
    const decision = rolloverDecision(c, provider, { normalLimit: this.contextLimit(), routingMode: routing?.mode || c.routing?.mode || this.contextRouting(), model, effort });
    const rollover = !review && !local && decision.rollover
      ? { ...decision, previousSessionId: c.sessions[provider]?.id || null, previousTurns: c.sessions[provider]?.turns ?? null, memory: milestoneMemory(c, { folders: this.workspaceFolders, text }) } : null;
    const resetSession = Boolean(c.sessions[provider] && (changedWorkspace || switchedAgent || fresh || rollover));
    const effectiveFresh = ordinaryFresh || Boolean(rollover);
    const sessionReason = review ? 'review' : local ? 'local-handoff' : rollover ? 'context-rollover' : changedWorkspace ? 'workspace-changed' : switchedAgent ? 'cross-agent-handoff' : fresh ? 'explicit-restart' : effectiveFresh ? 'new-conversation' : 'same-agent-continuation';
    let sessionId = effectiveFresh ? null : c.sessions[provider]?.id;
    const verification = verificationForRun(this.verificationCadence(), { retryOf, automaticReview });
    let prepared = review ? { prompt: reviewPrompt(review, { ...validateContext(c.context), workspaceFolders: this.workspaceFolders }), images: [], metadata: { purpose: 'review', fresh: true, digest: review.snapshot.digest } } : prepareContext(c, orchestrate ? planningRequest(text) : text, { verification, rollover, workspace: this.workspace, workspaceFolders: this.workspaceFolders, fresh: effectiveFresh, provider, mode, session: { sessionReason, ...(switchedAgent ? { previousProvider: c.lastRun.provider } : {}) }, attachments, readAttachment: id => this.attachments.read(id), policy: this.contextPolicy, journal: path.join(this.dataDir, `${c.id}.jsonl`), skills: local ? null : this.skills.forTask(c, { text, relation: task.relation, fresh: effectiveFresh || restoreAfterCompaction(c, provider, effectiveFresh), provider }), ...(local ? { maxBytes: 96000, includeImages: false } : {}) });
    if (review && Buffer.byteLength(prepared.prompt) > 192000) throw Object.assign(new Error('Review context exceeds 192 KB. Select fewer files or shorten the saved project brief.'), { status: 413 });
    if (actualTransport === 'cli' && prepared.images.length) throw Object.assign(new Error('Image attachments require the native Codex or Claude connection. Switch the transport from CLI, or remove the images.'), { status: 400 });
    const images = prepared.images.map(file => this.attachments.imageInput(file.id));
    let lease = this.acquireMutation(`provider:${provider}`);
    let baseline;
    try { if (review) verifyReview(); baseline = review ? { kind: 'review', git: true, digest: review.snapshot.digest, capturedAt: new Date().toISOString() } : workspaceBaseline(this.workspace, this.workspaceFolders); } catch (error) { lease.release(); throw error; }
    const run = { id: runId, taskId: task.id, c, provider, mode, approvalPolicy, child: null, terminalSuccess: false, failed: false, stopped: false,
      stderr: '', tools: new Map(), approvals: new Map(), currentClaudeMessage: null, killTimer: null, done: null, lease, review, local, resume: resume || null, queued: queued || null, limitChain, billingConfirmed: billingConfirmed === true, errorCategory: null, workspaceSignature: this.workspaceSignature,
      execution, executionOptions, model, effort, steerable: !review && !orchestrate && actualTransport !== 'cli', steers: new Map(), routing, baseline, retryOf, automaticReview, orchestrate, verification: prepared.metadata.verification, proceedWithNearQuota: Boolean(proceedWithNearQuota || optionProceedWithNearQuota || queued && c.queueResumeProceed), role: role || null };
    let finish;
    run.done = new Promise(resolve => { finish = resolve; });
    try {
      this.execution.ensure(c, task.id, { requestId });
      this.execution.assert(c, execution, executionOptions);
      this.record(c, { type: 'submission', id: runId, task, execution, ...(plan ? { plan } : {}), previousProvider: c.lastRun?.provider || null, requestId, fingerprint, provider, mode, approvalPolicy, model, effort, transport, effectiveTransport: actualTransport, baseline, context: prepared.metadata, resetSession, workspaceSignature: this.workspaceSignature, ...(role ? { role } : {}),
        ...(local ? { local } : {}), ...(review ? { review } : {}), ...(orchestrate ? { orchestration: { goal: text } } : {}), ...(c.messages.every(m => m.role !== 'user') ? { title: text.slice(0, 64) } : {}),
        ...(routing ? { routing } : {}), ...(retryOf ? { retryOf } : {}),
        ...(automaticReview ? { automaticReview } : {}),
        message: { id: randomUUID(), role: 'user', text, ...(text === continuationRequest ? { continuation: true } : {}), ...(local ? { connection: 'local' } : {}), ...(review ? { reviewId: runId } : {}), ...(orchestrate ? { orchestrationId: runId } : {}), ...(attachments.length ? { attachments } : {}), ...(routing ? { routing: { mode: routing.mode, reason: routing.reason, policy: globalThis.relayRouting.POLICY_VERSION, ...(routing.selectedBy === 'you' ? { selectedBy: 'you' } : {}), ...(routing.tier ? { tier: routing.tier } : {}), ...(routing.steppedDown ? { steppedDown: true } : {}), ...(routing.plannedHandoff ? { plannedHandoff: true } : {}), ...(routing.assessment ? { ratedBy: routing.assessment.source, ...(routing.assessment.ms ? { ratedMs: routing.assessment.ms } : {}) } : {}), model, effort } } : {}), ...(retryOf ? { retry: { of: retryOf } } : {}), provider, createdAt: new Date().toISOString(), runId } });
    } catch (error) { lease.release(); throw error; }
    for (const skill of prepared.metadata?.skills || []) this.message(c, 'activity', `Using skill ${skill.name}: ${skill.reason}`, provider);
    // A message sent by hand takes the place of a wait for a reset.
    if (c.resume && !resume && !review) this.resume.end(c, 'superseded');
    // So does any new run for an offered retry.
    if (c.retryOffer && !review) this.record(c, { type: 'retry_offer_end', id: c.retryOffer.id, outcome: 'superseded' });
    this.running = run; this.bins[provider] = bin;
    let finished = false;
    const complete = (code, signal, error) => {
      if (finished) return; finished = true; clearTimeout(run.killTimer);
      let success = code === 0 && run.terminalSuccess && !run.failed && !run.stopped && !error, continuing = false;
      try {
        if (run.child?.pid) this.signal(run, 'SIGKILL');
        run.hadPendingInput = run.approvals.size > 0; run.approvals.clear();
        for (const resolve of run.steers.values()) resolve({ ok: false, error: 'The run ended.' });
        run.steers.clear();
        if (!success) {
          // A planning run was read-only, and is planned again rather than continued.
          const kept = orchestrate ? 'It was read-only, so it changed no files.' : 'Files already changed by this run remain in the workspace.';
          const detail = run.budgetStop ? `Stopped: ${run.budgetStop.message} ${kept}` : run.stopped ? `${orchestrate ? 'Planning stopped.' : 'Stopped.'} ${kept}` : error?.message || run.failureDetail || run.stderr.trim() || `The assistant ended without completing the turn (exit ${code ?? signal ?? 'unknown'}).`;
          run.errorCategory ||= run.stopped ? 'interrupted' : classifyError(error || detail);
          const notice = clip(detail) + (review ? '\nStart a new read-only review when ready.' : orchestrate ? `${run.stopped || run.budgetStop ? ' ' : '\n'}Plan again from the plan card, or write the steps yourself.` : run.stopped ? '' : '\nYour conversation is saved. Select the other assistant and continue, or retry after resolving the error.');
          if (run.errorCategory === 'quota' && this.handoff.atLimit(run)) { run.limitNotice ||= notice; continuing = true; }
          else {
            if (run.limitNotice) this.message(c, 'error', run.limitNotice, provider);
            // A handoff says itself why the run stopped, so it is not shown as an error.
            if (!run.handoff) this.message(c, 'error', notice, provider);
          }
        }
        for (const message of c.messages.filter(m => m.runId === runId && m.role === 'assistant')) this.record(c, { type: 'message_update', id: message.id, update: { status: success ? 'complete' : 'incomplete' } });
        this.record(c, { type: 'run_metadata', metadata: { elapsedMs: Date.now() - Date.parse(c.activeRun.startedAt), phase: success ? 'complete' : 'stopped', lastEventAt: c.activeRun.lastEventAt } });
        if (orchestrate) this.record(c, { type: 'orchestration_result', id: runId, result: planningResult(success, run.stopped, c.messages.filter(message => message.runId === runId && message.role === 'assistant').at(-1)?.text) });
        if (review) this.record(c, { type: 'review_result', id: runId, result: success ? parseReviewResult(c.messages.filter(message => message.runId === runId && message.role === 'assistant').at(-1)?.text, review.snapshot) : { status: run.stopped ? 'interrupted' : 'failed', summary: run.stopped ? 'Review stopped. Start a new review when ready.' : 'The review did not finish. Check the agent response and try again.', findings: [] } });
        this.record(c, { type: 'run_end', status: run.stopped ? 'interrupted' : success ? 'complete' : 'incomplete', errorCategory: run.errorCategory });
        if (!review) this.checkpoints.after(c, run);
        if (success && !review && !local && c.sessions[provider]) this.record(c, { type: 'checkpoint', provider });
      } catch (persistError) { success = false; run.persistenceError = persistError.message; }
      finally { try { lease.release(); } catch (releaseError) { success = false; run.persistenceError ||= releaseError.message; } finally {
        this.handoff.unwatch(run); this.budget.unwatch(run);
        if (continuing) c.limitSwitching = { provider };
        this.running = null; this.emit('update', { conversationId: c.id }); finish({ success, error: run.persistenceError });
        if (!review && run.billingSource === 'subscription') this.readQuota(c, provider, { refresh: true });
        const settle = () => {
          // A run that continued after a reset may wait again if it reached another limit; otherwise say how the run ended.
          let waiting = false;
          try { waiting = this.resume.runEnded(c, run, run.stopped ? 'interrupted' : success ? 'complete' : 'incomplete'); } catch (error) { console.error('Codeshi could not report a resumed run:', error.message); }
          const agent = provider === 'claude' ? 'Claude' : provider === 'gemini' ? 'Gemini' : run.local ? 'The local model' : 'Codex';
          // A planning run says whether a plan is ready.
          const planned = orchestrate ? c.orchestrations.find(item => item.id === runId) : null;
          if (!review && !waiting && !run.stopped) this.emit('notify', planned
            ? planned.status === 'draft' ? { conversationId: c.id, kind: 'finished', title: 'Plan ready', body: `${agent} proposed a plan. Nothing from it runs until you approve it.` }
            : { conversationId: c.id, kind: 'stopped', title: 'No plan yet', body: run.errorCategory === 'quota' ? `${agent} reached a usage limit while planning. Open the workspace to plan again.` : `${agent} didn’t return a plan. Open the workspace to plan again or write the steps yourself.` }
            : success
            ? { conversationId: c.id, kind: 'finished', title: 'Task finished', body: `${agent} finished${run.resume ? ' the work it continued while you were away' : ''}.` }
            : { conversationId: c.id, kind: 'stopped', title: 'Task stopped', body: run.errorCategory === 'quota' ? `${agent} reached a usage limit.` : `${agent} stopped before finishing. Open the workspace to see why.` });
          // A routed run that changed files is checked with the workspace's tests first (#12); the check then decides
          // when queued prompts continue. Otherwise they carry on after a finished run, wait after a limit, and pause
          // after anything else.
          const ending = run.stopped ? 'interrupted' : success ? 'complete' : 'incomplete';
          let checking = false;
          try { checking = this.checks.runEnded(c, run, ending); } catch (error) { console.error('Codeshi could not check the run:', error.message); }
          const automatic = !checking && run.automaticReview;
          if (automatic) try { this.automaticReviews.runEnded(c, run, ending); } catch (error) { console.error('Codeshi could not start automatic review:', error.message); }
          if (!checking && !automatic) try { this.queue.runEnded(c, run, ending); } catch (error) { console.error('Codeshi could not continue the prompt queue:', error.message); }
        };
        // With automatic handoff allowed, a limit moves the task on (#91). Only if it can't does the run end as usual.
        if (!continuing) settle();
        else this.handoff.continueAfterLimit(c, run).then(handled => { if (!handled) { this.message(c, 'error', run.limitNotice, provider); settle(); } });
      } }
    };
    const launch = async () => {
      // What routing read seconds ago, for the agent it chose: the same checks below, without reading it all again.
      const evidence = routingEvidence?.provider === provider && Date.now() - routingEvidence.at < 60000 ? routingEvidence : null;
      try {
        if (local) {
          local = { ...local, ...await verifyLocal() };
          this.record(c, { type: 'run_metadata', metadata: { account: { authenticated: true, authMode: 'local', billingSource: 'local' } } });
        } else if (!this.configuredBins[provider]) {
          const account = evidence?.account || await accountStatus(provider, { bin, workspace: this.workspace, googleRoot: this.googleRoot });
          this.record(c, { type: 'run_metadata', metadata: { account: { authenticated: account.authenticated, authMode: account.authMode, billingSource: account.billingSource } } });
          if (account.authenticated === false) throw Object.assign(new Error('Sign in through the provider’s supported authentication flow before running.'), { category: 'authentication' });
          run.billingSource = account.billingSource;
          if (account.billingSource !== 'subscription' && !billingConfirmed) throw Object.assign(new Error(`Billing source is ${account.billingSource}. Explicitly confirm this provider run before it may consume usage.`), { category: 'permission' });
        }
        if (routing && !review && !local) {
          let usage = evidence?.usage || null, timer;
          try {
            // A check the routing step already started is reused rather than repeated.
            usage ||= await Promise.race([this.checks.usage(provider, { ...this.usageOptions(provider), refresh: !routingEvidence }), new Promise(resolve => { timer = setTimeout(() => resolve(null), 6000); })]);
          } catch { /* Unavailable stays unknown, with no assumed capacity. */ }
          finally { clearTimeout(timer); }
          if (run.stopped) return complete(null, null, new Error('Run stopped.'));
          const quota = globalThis.relayRouting.assessQuota(usage, model, { threshold: 95, tier: routing?.tier, workload: usualWindowSpend(c, provider) });
          this.observeQuota(c, provider, usage);
          this.record(c, { type: 'run_metadata', metadata: { routingQuota: quota } });
          if (['near', 'exhausted', 'stale'].includes(quota.state)) {
            // Past the safety margin but not at the limit (#153): spent when you chose "Proceed with remaining allowance",
            // or when the window resets soon enough that the rest would expire. Auto already chose knowing that, or a
            // fresh reading shows it now, in which case an agent with ordinary headroom is tried first.
            const spendRemainder = quota.state === 'near' && (run.proceedWithNearQuota || Boolean(quota.burndown));
            const remainderNote = () => { const note = globalThis.relayRouting.remainderText(provider, quota, { asked: run.proceedWithNearQuota && !quota.burndown }); this.message(c, 'activity', `${note}.`, provider); this.record(c, { type: 'run_metadata', metadata: { routingRemainder: { provider, reason: quota.burndown ? 'expiring' : 'asked', ...(quota.burndown ? { resetsAt: quota.burndown.resetsAt } : {}) } } }); };
            if (spendRemainder && (run.proceedWithNearQuota || run.routing?.remainder)) {
              remainderNote();
            } else if (['near', 'exhausted'].includes(quota.state)) {
              const fallback = await this.findRoutingFallback(c, run, { failedProvider: provider, failedModel: model, failedQuota: quota, usage });
              if (fallback) {
                const previousProvider = provider, previousModel = model;
                provider = fallback.provider;
                model = fallback.model;
                effort = fallback.effort;
                run.provider = provider;
                run.model = model;
                run.effort = effort;
                run.routing = { ...run.routing, ...(fallback.routing || {}), steppedDown: fallback.steppedDown || false, fallbackFrom: previousProvider };
                lease.release();
                lease = this.acquireMutation(`provider:${provider}`);
                run.lease = lease;
                bin = resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot });
                this.bins[provider] = bin;
                actualTransport = transportFor(provider, transport, this.configuredBins[provider]);
                run.steerable = !review && actualTransport !== 'cli';
                // Another agent starts a fresh session with the brief prepared below; a smaller model of the same agent keeps its own.
                sessionId = effectiveFresh || provider !== previousProvider ? null : c.sessions[provider]?.id;
                // The account the switch was chosen from, read moments ago. A charge needs the same consent as any other
                // start (#87): an agent that isn't billed to a subscription only runs if you confirmed charges for this run.
                const account = fallback.account || (this.configuredBins[provider] ? { authenticated: true, authMode: "test", billingSource: "subscription" } : await accountStatus(provider, { bin, workspace: this.workspace, googleRoot: this.googleRoot }));
                this.record(c, { type: 'run_metadata', metadata: { account: { authenticated: account.authenticated, authMode: account.authMode, billingSource: account.billingSource } } });
                if (account.authenticated === false) throw Object.assign(new Error('Sign in through the provider’s supported authentication flow before running.'), { category: 'authentication' });
                if (account.billingSource !== 'subscription' && !billingConfirmed) throw Object.assign(new Error(`Billing source is ${account.billingSource}. Explicitly confirm this provider run before it may consume usage.`), { category: 'permission' });
                run.billingSource = account.billingSource;
                prepared = prepareContext(c, text, { verification, rollover, workspace: this.workspace, workspaceFolders: this.workspaceFolders, fresh: true, provider, mode, session: { sessionReason: 'cross-agent-handoff', previousProvider }, attachments, readAttachment: id => this.attachments.read(id), policy: this.contextPolicy, journal: path.join(this.dataDir, `${c.id}.jsonl`), skills: local ? null : this.skills.forTask(c, { text, relation: task.relation, fresh: true, provider }), ...(local ? { maxBytes: 96000, includeImages: false } : {}) });
                this.record(c, { type: 'run_metadata', metadata: { routingFallback: { from: previousProvider, fromModel: previousModel, to: provider, toModel: model, toEffort: effort ?? null, toTransport: actualTransport, freshSession: !sessionId, reason: `${previousProvider} quota is ${quota.state} (${globalThis.relayRouting.quotaText(quota)})` } } });
                this.message(c, 'activity', `${previousProvider === 'codex' ? 'Codex' : previousProvider === 'claude' ? 'Claude' : 'Gemini'} is near its quota limit (${globalThis.relayRouting.quotaText(quota)}). Smart routing switched to ${provider === 'claude' ? 'Claude' : provider === 'gemini' ? 'Gemini' : 'Codex'}${model ? ` (${model})` : ''}.`, provider);
                if (fallback.usage) this.observeQuota(c, provider, fallback.usage);
                if (fallback.quota) this.record(c, { type: 'run_metadata', metadata: { routingQuota: fallback.quota } });
                Object.assign(executionOptions, { provider, model, effort });
                this.emit('update', { conversationId: c.id });
              } else if (spendRemainder) {
                remainderNote();
              } else {
                throw Object.assign(new Error(`Routing paused before starting ${provider}: ${globalThis.relayRouting.quotaText(quota)}. Refresh plan usage or choose a model manually.`), { category: 'routing', quotaState: quota.state });
              }
            } else {
              throw Object.assign(new Error(`Routing paused before starting ${provider}: ${globalThis.relayRouting.quotaText(quota)}. Refresh plan usage or choose a model manually.`), { category: 'routing', quotaState: quota.state });
            }
          }
        } else if (!review && !local && run.billingSource === 'subscription') this.readQuota(c, provider);
        if (!review) await this.checkpoints.before(c, run);
        if (run.stopped) return complete(null, null, new Error('Run stopped.'));
        this.execution.assert(c, execution, executionOptions); verifyExecution?.();
        const command = commandFor(provider, { mode, approvalPolicy, sessionId, bin, workspace: this.workspace, workspaces: this.workspaces, effort });
        if (provider === 'codex') {
          command.args.unshift('-c', 'features.hooks=false', '-c', 'notify=[]');
          if (model) command.args.unshift('--model', model);
          if (!baseline.git && !sessionId) command.args.splice(command.args.indexOf('exec') + 1, 0, '--skip-git-repo-check');
        } else if (provider === 'claude') {
          command.args.push('--setting-sources', '', '--settings', '{"disableAllHooks":true}');
          command.args.push('--model', model || 'default');
        }
        const remainingSpend = run.billingSource === 'api' ? this.budget.remainingSpend(c, run.taskId) : null;
        // Claude stops itself at a dollar cap, through the SDK or `claude -p`. Other agents offer none, so their spend is
        // checked as they report it and can overshoot (#87).
        const maxBudgetUsd = provider === 'claude' && ['sdk', 'cli'].includes(actualTransport) ? remainingSpend : null;
        if (maxBudgetUsd !== null && actualTransport === 'cli') command.args.push('--max-budget-usd', String(Math.max(0, maxBudgetUsd)));
        if (remainingSpend !== null) this.record(c, { type: 'run_metadata', metadata: { budgetEnforcement: { spend: maxBudgetUsd !== null ? 'native' : 'reported-usage', maxSpendUSD: remainingSpend } } });
        // The worker cannot launch a provider until its PID and mutation lease are durable.
        if (this.execution.current(c, task.id)?.override?.scope === 'step') this.record(c, { type: 'execution_override_used', taskId: task.id });
        run.child = fork(fileURLToPath(new URL('./provider-worker.mjs', import.meta.url)), [], { cwd: this.workspace, silent: true, detached: process.platform !== 'win32', execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        run.child.on('error', error => { run.spawnError = error; });
        // The run ends on 'close', which waits for the IPC channel. Keep that channel referenced so a host with nothing
        // else pending (a test or a script) still reads its end, instead of exiting with the run unfinished.
        run.child.channel?.ref?.();
        let buffer = '';
        const consume = line => { if (!line.trim()) return; try { this.event(run, JSON.parse(line)); } catch (error) { run.failed = true; run.errorCategory = 'protocol'; run.stderr = clip(`${run.stderr}\n${error.message}`); } };
        run.child.stdout.setEncoding('utf8'); run.child.stderr.setEncoding('utf8');
        run.child.stdout.on('data', chunk => {
          if (buffer === null) return;
          buffer += chunk;
          // An oversized event ends the run. The rest of the output is dropped, so the cut-off event isn't parsed when the process closes.
          if (buffer.length > 8 * 1024 * 1024) { buffer = null; run.failed = true; run.errorCategory = 'protocol'; run.stderr = 'Oversized provider protocol event.'; this.cancel(run); return; }
          let newline; while ((newline = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        });
        run.child.stderr.on('data', chunk => { run.stderr = clip(run.stderr + chunk); });
        run.child.on('message', message => {
          try {
            if (message.type === 'event') this.event(run, message.event);
            if (message.type === 'metadata') { this.record(c, { type: 'run_metadata', metadata: message.metadata }); if (message.metadata?.usage || typeof message.metadata?.costUSD === 'number') this.budget.check(run); }
            if (message.type === 'steer-result') { run.steers.get(message.id)?.(message); run.steers.delete(message.id); }
            if (message.type === 'failure') {
              run.failed = true; run.errorCategory = message.category; run.stderr = clip(run.stderr + '\n' + message.message);
              // A saved session the agent can no longer continue: the next message starts a fresh one with a task brief.
              if (message.category === 'session' && sessionId && c.sessions[provider]?.id === sessionId) this.record(c, { type: 'session_lost', provider, id: sessionId });
            }
            if (message.type === 'approval') {
              if (review && !['Read', 'Glob', 'Grep'].includes(message.request.kind)) { run.child.send({ type: 'approval-result', id: message.request.id, allow: false }); return; }
              if (run.approvalPolicy === 'auto') {
                run.child.send({ type: 'approval-result', id: message.request.id, allow: true });
                // Codex asks only for what its sandbox blocks, such as the network, so each request is worth showing.
                // The others ask for every tool, and their steps already show those.
                this.message(c, 'activity', provider === 'codex' ? `Auto-approved: ${requestSummary(message.request)}` : `Tool ${message.request.kind || message.request.title || 'use'} auto-approved by policy.`, run.provider);
                return;
              }
              // Ask before changes: an action that only reads the workspace folders goes ahead without asking.
              if (!review && run.mode === 'edit' && readOnlyRequest(message.request, { workspaces: [...this.workspaces, this.skills.root] })) { run.child.send({ type: 'approval-result', id: message.request.id, allow: true }); return; }
              // A rule the person chose earlier, for this run or this workspace, allows the same exact action again.
              const scope = !review && run.mode === 'edit' ? approvalScope(message.request, { provider, workspaces: this.workspaces }) : null;
              const rule = scope && !run.allowances?.has(scope.key) ? this.permissions.find(scope.key) : null;
              if (scope && (run.allowances?.has(scope.key) || rule)) {
                if (rule) this.permissions.used(rule);
                run.child.send({ type: 'approval-result', id: message.request.id, allow: true });
                this.message(c, 'activity', `Allowed by your rule for ${rule ? 'this workspace' : 'this run'}: ${scope.label}`, run.provider);
                return;
              }
              const approval = { ...message.request, runId, provider, ...(scope ? { scope } : {}) }; run.approvals.set(approval.id, approval); this.emit('update', { conversationId: c.id });
              // The run pauses here until the person answers, so tell them.
              this.emit('notify', { conversationId: c.id, kind: 'approval', approvalId: approval.id, title: 'Approval needed', body: `${provider === 'claude' ? 'Claude' : provider === 'gemini' ? 'Gemini' : 'Codex'} is waiting for your approval.` });
            }
            // A question with options waits with the approvals, so everything that shows an approval waiting shows it
            // too. It is never answered by a policy or a rule; a background review, which nobody answers, skips it.
            if (message.type === 'question') {
              const questions = cleanQuestions(message.request?.questions), id = String(message.request?.id || '');
              if (review || !questions.length || !id || run.approvals.has(id)) { run.child.send({ type: 'question-result', id, answers: null }); return; }
              run.approvals.set(id, { id, kind: 'question', runId, provider, questions }); this.emit('update', { conversationId: c.id });
              const name = provider === 'claude' ? 'Claude' : provider === 'gemini' ? 'Gemini' : 'Codex';
              this.emit('notify', { conversationId: c.id, kind: 'approval', approvalId: id, title: questions.length === 1 ? `${name} has a question` : `${name} has ${questions.length} questions`, body: questions[0].question });
            }
          } catch (error) { run.failed = true; run.errorCategory = classifyError(error); run.stderr = error.message; this.cancel(run); }
        });
        run.child.on('close', (code, signal) => { if (buffer?.trim()) consume(buffer); complete(code, signal, run.spawnError); });
        const pidStart = processStart(run.child.pid);
        this.record(c, { type: 'run_process', pid: run.child.pid, pidStart });
        lease.setProcess(run.child.pid, pidStart);
        this.execution.assert(c, execution, executionOptions); verifyExecution?.();
        run.child.send({ type: 'start', config: { ...(maxBudgetUsd !== null && actualTransport === 'sdk' ? { maxBudgetUsd } : {}), bin, googleRoot: this.googleRoot, args: command.args, workspace: this.workspace, workspaces: this.workspaces, workspaceFolders: this.workspaceFolders, prompt: prepared.prompt, images, transport: actualTransport, provider, mode, approvalPolicy, model, effort, sessionId, ...(local ? { local } : {}), ...(review ? { reviewSnapshot: true } : {}) } });
      } catch (error) { run.errorCategory = error.category || classifyError(error); complete(null, null, error); }
    };
    launch();
    this.handoff.watch(run); this.budget.watch(run);
    return { runId, requestId };
  }

  compaction(run, event) {
    run.compactionKeys ||= new Map();
    const known = event.id && run.compactionKeys.get(event.id);
    const id = known || (event.stage === 'complete' ? run.pendingCompaction : run.lastProgress === 'compacting' ? run.pendingCompaction : null) || randomUUID();
    if (event.id) run.compactionKeys.set(event.id, id);
    const prior = run.c.activeRun?.compactionEvents?.find(item => item.id === id);
    if (prior?.stage === event.stage) return;
    if (!prior) run.compactions = (run.compactions || 0) + 1;
    run.pendingCompaction = event.stage === 'complete' ? null : id;
    const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    this.record(run.c, { type: 'native_compaction', runId: run.id, provider: run.provider,
      event: { id, stage: event.stage || 'started', source: event.source || 'provider-status', trigger: event.trigger || null,
        ...(count(event.beforeTokens) !== undefined ? { beforeTokens: event.beforeTokens } : {}),
        ...(count(event.afterTokens) !== undefined ? { afterTokens: event.afterTokens } : {}) } });
  }

  event(run, event) {
    const phase = event.type === 'thread.started' || event.type === 'system' && event.subtype === 'init' ? 'working' : event.item?.type === 'reasoning' ? 'reasoning' : event.type === 'relay.progress' ? event.phase : event.type === 'relay.delta' ? 'responding' : event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' ? 'responding' : ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'agent_tool'].includes(event.item?.type) ? (event.type === 'item.started' ? 'tool' : 'working') : event.type === 'assistant' && event.message?.content?.some(block => block.type === 'tool_use') ? 'tool' : null;
    const toolIds = [...(event.item && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'agent_tool'].includes(event.item.type) && event.item.id ? [event.item.id] : []), ...(event.type === 'assistant' ? (event.message?.content || []).filter(block => block.type === 'tool_use').map(block => block.id) : [])];
    run.seenTools ||= new Set();
    for (const id of toolIds) if (!run.seenTools.has(id)) { run.seenTools.add(id); if (run.c.activeRun) run.c.activeRun.toolCount = run.seenTools.size; }
    this.touch(run, phase);
    const { c, provider } = run;
    if (provider === 'claude' && c.activeRun?.transport === 'cli' && event.type === 'assistant' && !event.parent_tool_use_id && !event.agent_id) {
      const reading = claudeRequestContext(event.message?.usage);
      if (reading) this.record(c, { type: 'run_metadata', metadata: { contextUsage: reading } });
    }
    if (c.activeRun?.transport === 'cli' && event.context_usage && !event.parent_tool_use_id) this.record(c, { type: 'run_metadata', metadata: { contextUsage: {
      used: event.context_usage.total_tokens, capacity: event.context_usage.raw_max_tokens, model: event.context_usage.model,
      source: 'claude-context-report', estimated: true, windowKind: 'compaction-policy-or-model' } } });
    // The agent shortened its own context, which Codeshi can't see into, so it is only counted (#85).
    if (event.type === 'relay.compaction') { this.touch(run, 'compacting'); this.compaction(run, event); run.lastProgress = 'compacting'; return; }
    if (event.type === 'system' && event.subtype === 'compact_boundary') { this.compaction(run, { stage: 'complete', id: event.uuid, source: 'claude-compact-boundary', trigger: event.compact_metadata?.trigger, beforeTokens: event.compact_metadata?.pre_tokens, afterTokens: event.compact_metadata?.post_tokens }); run.lastProgress = 'compacting'; return; }
    if (event.type === 'relay.progress' && event.phase === 'compacting' && run.lastProgress !== 'compacting') this.compaction(run, { stage: 'started', source: 'provider-status' });
    if (event.type === 'relay.progress') { run.lastProgress = event.phase; return; }
    if (!event || typeof event !== 'object') throw new Error('Invalid provider protocol event.');
    // The agent's own plan for the run, shown as a to-do list.
    if (event.type === 'relay.plan') {
      const steps = (Array.isArray(event.steps) ? event.steps : []).filter(step => typeof step?.text === 'string' && step.text.trim()).slice(0, 50)
        .map(step => ({ text: step.text.trim().slice(0, 300), status: ['done', 'active'].includes(step.status) ? step.status : 'pending' }));
      this.record(c, { type: 'run_metadata', metadata: { plan: { steps: reportedPlan(c.activeRun?.plan, steps), explanation: typeof event.explanation === 'string' ? event.explanation.slice(0, 500) : null, updatedAt: new Date().toISOString(), ...(c.activeRun?.plan?.carriedFrom ? { carriedFrom: c.activeRun.plan.carriedFrom } : {}) } } });
      return;
    }
    if (event.type === 'relay.delta') { const id = `${run.id}:${event.id}`; const existing = findMessage(c, id); this.message(c, 'assistant', (existing?.text || '') + event.text, provider, id, 'streaming'); return; }
    if (event.type === 'relay.notice') { this.message(c, 'activity', clip(event.text), provider); return; }
    if (provider === 'codex' || provider === 'gemini') {
      if (!run.review && !run.local && event.type === 'thread.started' && event.thread_id) this.record(c, { type: 'session', provider, id: event.thread_id, workspaceSignature: run.workspaceSignature || this.workspaceSignature, managedContextVersion: c.activeRun?.context?.sessionMode === 'fresh' ? managedContextVersion : c.sessions[provider]?.managedContextVersion });
      if (event.type === 'turn.completed') run.terminalSuccess = true;
      if (event.type === 'error') this.message(c, 'activity', clip(`Codex diagnostic: ${event.message || JSON.stringify(event)}`), provider);
      if (event.type === 'turn.failed') {
        run.failed = true; run.errorCategory = classifyError(event.error || event.message);
        this.agentError(run, clip(event.message || event.error?.message || JSON.stringify(event.error || event)));
      }
      const item = event.item;
      if (!item || !['item.started', 'item.updated', 'item.completed'].includes(event.type)) return;
      const id = `${run.id}:${item.id || randomUUID()}`;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        this.message(c, 'assistant', item.text, provider, id, event.type === 'item.completed' ? 'complete' : 'streaming');
        const questions = provider === 'codex' && !run.review && event.type === 'item.completed' ? codexAsyncQuestions(item.questions) : [];
        if (questions.length && !(run.asyncQuestionIds ||= new Set()).has(id)) {
          run.asyncQuestionIds.add(id);
          this.record(c, { type: 'async_question', question: { id, kind: 'question', runId: run.id, provider, questions, blocking: false } });
          this.emit('notify', { conversationId: c.id, kind: 'approval', approvalId: id, title: questions.length === 1 ? 'Codex has a question' : `Codex has ${questions.length} questions`, body: questions[0].question });
        }
      }
      if (item.type === 'command_execution') {
        this.message(c, 'activity', clip(`$ ${item.command}\n${item.aggregated_output || ''}`), provider, id, undefined,
          { status: event.type === 'item.completed' ? 'completed' : 'running', ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}), isError: item.status === 'failed' || item.status === 'declined' });
        // In Read only, a blocked command looks like a network or disk fault, so the run says what stopped it, once.
        if (event.type === 'item.completed' && provider === 'codex' && run.mode === 'read' && !run.review && !run.blockExplained && blockedBySandbox(item.aggregated_output)) {
          run.blockExplained = true;
          this.message(c, 'activity', 'Blocked by Read only: switch to Can edit files to let Codex use the network or change files.', provider);
        }
      }
      if (item.type === 'file_change') this.message(c, 'activity', `File changes: ${JSON.stringify(fileChanges(item.changes))}`, provider, id);
      // Saved as Claude's steps are: the tool's name, its input as one line of JSON, then its result.
      if (item.type === 'agent_tool') this.message(c, 'activity', clip(`${item.name}\n${toolInput(item.name, item.input)}${item.result ? `\n${item.result}` : ''}`), provider, id, undefined, { status: event.type === 'item.completed' ? 'completed' : 'running', isError: item.failed === true });
      if (['mcp_tool_call', 'web_search'].includes(item.type)) this.message(c, 'activity', clip(`${item.type}: ${item.tool || item.query || ''}\n${typeof item.result === 'string' && item.result ? item.result : JSON.stringify(item.result || item.arguments || '')}`), provider, id);
      // Codex refuses a connector call in Read only without asking, in words that don't name the setting.
      if (item.type === 'mcp_tool_call' && event.type === 'item.completed' && provider === 'codex' && run.mode === 'read' && !run.review && !run.blockExplained && /approval policy is never/i.test(item.error?.message || '')) {
        run.blockExplained = true;
        this.message(c, 'activity', 'Blocked by Read only: switch to Can edit files to let Codex use connectors and MCP tools.', provider);
      }
      return;
    }
    if (event.type === 'rate_limit_event') {
      // Kept apart from `usage`, which holds the run's token counts.
      this.record(c, { type: 'run_metadata', metadata: { rateLimit: event.rate_limit_info } });
      if (event.rate_limit_info?.status === 'rejected') {
        const info = event.rate_limit_info, period = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', overage: 'extra usage' }[info.rateLimitType];
        const resets = Number.isFinite(info.resetsAt) ? new Date(info.resetsAt * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
        run.failed = true; run.errorCategory = 'quota';
        if (Number.isFinite(info.resetsAt)) run.limitResetsAt = info.resetsAt * 1000;
        this.agentError(run, `Claude usage limit reached${period ? ` for the ${period} window` : ''}.${resets ? ` It resets ${resets}.` : ''} Switch to Codex or continue after the reset.`);
      }
    }
    if (event.type === 'assistant' && event.error) { run.failed = true; run.errorCategory = classifyError(event.error + ' ' + JSON.stringify(event.message?.content || [])); }
    if (!run.review && event.session_id && c.sessions.claude?.id !== event.session_id) this.record(c, { type: 'session', provider, id: event.session_id, workspaceSignature: run.workspaceSignature || this.workspaceSignature, managedContextVersion: c.activeRun?.context?.sessionMode === 'fresh' ? managedContextVersion : c.sessions[provider]?.managedContextVersion });
    if (event.type === 'stream_event') {
      const stream = event.event;
      if (stream?.type === 'message_start') run.currentClaudeMessage = stream.message?.id || randomUUID();
      if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta') {
        const id = `${run.id}:${run.currentClaudeMessage || 'response'}`;
        const existing = findMessage(c, id);
        this.message(c, 'assistant', (existing?.text || '') + stream.delta.text, provider, id, 'streaming');
      }
    }
    if (event.type === 'assistant') {
      const content = event.message?.content || [];
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const id = `${run.id}:${event.message?.id || run.currentClaudeMessage || 'response'}`;
      if (text) this.message(c, 'assistant', text, provider, id, 'complete');
      for (const tool of content.filter(block => block.type === 'tool_use')) {
        run.tools.set(tool.id, tool.name);
        this.message(c, 'activity', clip(`${tool.name}\n${toolInput(tool.name, tool.input)}`), provider, `${run.id}:tool:${tool.id}`, undefined, { status: 'running' });
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const tool of event.message.content.filter(block => block.type === 'tool_result')) {
        const id = `${run.id}:tool:${tool.tool_use_id}`;
        const existing = findMessage(c, id);
        const content = typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content || []);
        this.message(c, 'activity', clip(`${existing?.text || run.tools.get(tool.tool_use_id) || 'Tool result'}\n${content}`), provider, id, undefined, { status: 'completed', isError: tool.is_error === true });
      }
    }
    if (event.type === 'system' && event.subtype === 'init' && event.model) this.record(c, { type: 'run_metadata', metadata: { effectiveModel: event.model } });
    if (event.type === 'result') {
      if (c.activeRun?.transport === 'cli' && (event.usage || event.modelUsage)) {
        this.record(c, { type: 'run_metadata', metadata: { usage: { ...event.usage, ...(event.modelUsage ? { modelUsage: event.modelUsage } : {}) }, ...(typeof event.total_cost_usd === 'number' ? { costUSD: event.total_cost_usd } : {}) } });
        this.budget.check(run);
      }
      run.terminalSuccess = event.subtype === 'success' && !event.is_error;
      // Claude reached the spending cap Codeshi gave it (#87): a task limit, saved and shown like one. If the cost it just
      // reported already stopped the run, that stop says it once.
      if (event.subtype === 'error_max_budget_usd') {
        run.failed = true;
        if (!run.budgetStop) this.budget.nativeStop(run, { allowed: c.activeRun?.budgetEnforcement?.maxSpendUSD ?? null, agent: 'Claude' });
      } else if (!run.terminalSuccess) {
        run.failed = true; if (run.errorCategory !== 'quota') run.errorCategory = classifyError(event.result || event.errors?.join(' '));
        this.agentError(run, clip(event.result || event.errors?.join('\n') || event.subtype || 'Claude could not complete this turn.'));
      } else if (event.result && !c.messages.some(m => m.runId === run.id && m.role === 'assistant')) {
        this.message(c, 'assistant', event.result, provider, `${run.id}:response`, 'complete');
      }
      if (event.permission_denials?.length) {
        // Only requests that never reached Codeshi get here: a tool you declined was answered, and Claude carries on.
        const tools = [...new Set(event.permission_denials.map(denial => denial.tool_name).filter(Boolean))].join(', ') || 'a tool';
        run.failed = true; run.errorCategory = 'permission';
        run.failureDetail = `Claude couldn't get permission to use ${tools}, so that step didn't run. Some work may be incomplete.`;
      }
    }
  }

  signal(run, signal) {
    try {
      if (process.platform !== 'win32') process.kill(-run.child.pid, signal);
      else run.child.kill(signal);
    } catch (error) { if (!groupGone(error)) throw error; }
  }

  stop(id) {
    if (!this.running || this.running.c.id !== id) return { stopped: false };
    const run = this.running;
    // A run the broker is already ending keeps the reason it gave.
    if (!run.ending) run.stopped = true;
    this.cancel(run);
    return { stopped: true };
  }

  // Ends the provider process. Stop uses it, and so does the broker when it ends a run itself; that run counts as failed, not stopped.
  cancel(run) {
    if (run.ending) return;
    run.ending = true;
    run.approvals.clear();
    // The worker may already be exiting. Then the cancel can't be delivered, and that error isn't why the run ended.
    if (run.child?.connected) run.child.send({ type: 'cancel' }, () => {});
    if (run.child?.pid) {
      this.signal(run, 'SIGTERM');
      run.killTimer = setTimeout(() => this.signal(run, 'SIGKILL'), 3000);
      run.killTimer.unref();
    }
  }

  async close() {
    if (this.automaticReviews) this.automaticReviews.closed = true;
    this.resume.close(); this.queue.close(); this.handoff.close(); this.checks.close();
    await this.tasks?.close();
    if (this.running) {
      const run = this.running;
      this.stop(run.c.id);
      await run.done;
    }
    await this.checkpoints.close();
  }
}

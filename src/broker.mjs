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
import { readLedger, taskIdentity, taskResult } from './task-ledger.mjs';
import { carriedPlan, reportedPlan } from './task-plan.mjs';
import { TaskCoordinator } from './task-coordinator.mjs';
import { attachedFiles, cleanEntryInput, memoryLimit, memoryView, newEntry } from './project-memory.mjs';
import { applyBudgetRecord, TaskBudgets } from './task-budget.mjs';
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

export const PROVIDERS = ['codex', 'claude', 'gemini'];
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

const ROUTING_MODES = ['saving', 'balanced', 'quality'], TIERS = ['light', 'standard', 'deep'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// What Auto chose and why, as shown before sending; kept with the run and its prompt.
export function routingNote(routing) {
  if (routing === null || routing === undefined) return null;
  if (typeof routing !== 'object' || !ROUTING_MODES.includes(routing.mode)) throw Object.assign(new Error('Invalid automatic agent choice.'), { status: 400 });
  const step = routing.escalation, text = value => typeof value === 'string' && value.trim() && value.length <= 200 ? value : null;
  // The step up a failed check retries with (#12): the same kind of choice, checked again when the retry starts.
  const escalation = step && typeof step === 'object' && PROVIDERS.includes(step.provider) ? { provider: step.provider, model: text(step.model), modelName: text(step.modelName), effort: EFFORTS.includes(step.effort) ? step.effort : null, ...(TIERS.includes(step.tier) ? { tier: step.tier } : {}) } : null;
  return { mode: routing.mode, reason: typeof routing.reason === 'string' ? routing.reason.slice(0, 300) : '', ...(TIERS.includes(routing.tier) ? { tier: routing.tier } : {}), ...(escalation ? { escalation } : {}) };
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
  constructor({ workspace, workspaces = [], workspaceFolders = [], dataDir, googleRoot = path.join(dataDir, 'google'), bins = {}, acquireMutation = () => ({ release() {}, setProcess() {} }), acquireFolders, withFolders, lane = false, contextPolicy = 'task', handoffPreferences = () => ({ threshold: 90, automatic: false }), tests = null }) {
    super();
    this.workspace = savedWorkspace(workspace); this.contextPolicy = contextPolicy; this.budget = new TaskBudgets(this);
    this.workspaces = [...new Set([this.workspace, ...workspaces.map(savedWorkspace), ...workspaceFolders.map(folder => savedWorkspace(folder.path))])];
    this.workspaceFolders = this.workspaces.map(directory => {
      const configured = workspaceFolders.find(folder => savedWorkspace(folder.path) === directory);
      return { id: configured?.id || createHash('sha256').update(directory).digest('hex').slice(0, 16), name: configured?.name || path.basename(directory), ...(configured?.displayName ? { displayName: configured.displayName } : {}), path: directory };
    });
    this.workspaceSignature = createHash('sha256').update(JSON.stringify({ primary: this.workspace, roots: [...this.workspaces].sort() })).digest('hex');
    this.dataDir = dataDir; this.googleRoot = googleRoot;
    this.skills = new SkillCatalog(this);
    this.attachments = new AttachmentStore(dataDir);
    this.configuredBins = { ...bins };
    this.acquireMutation = acquireMutation;
    this.bins = Object.fromEntries(PROVIDERS.map(provider => [provider, resolveBinary(provider, { override: bins[provider], googleRoot: this.googleRoot })]));
    this.conversations = new Map();
    this.running = null;
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
  availableProviders() { return PROVIDERS.filter(provider => resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot })); }
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
    const previous = c.lastRun, result = this.start(c, { ...input, fresh: true, text: continuationRequest });
    if (!result.duplicate && previous?.errorCategory === 'quota' && this.running?.provider !== previous.provider) await this.handoff.followContinue(c, previous.provider, this.running).catch(error => console.error('Codeshi could not move the queued prompts:', error.message));
    return result;
  }
  dismissHandoff(c, offerId) { this.handoff.dismiss(c, offerId); return this.view(c); }
  // A retry one step up after failed tests, offered instead of started (#12).
  acceptRetry(c, input = {}) { return this.checks.accept(c, input.offerId); }
  dismissRetry(c, offerId) { this.checks.dismiss(c, offerId); return this.view(c); }

  empty(id) {
    return { id, title: 'New conversation', provider: 'codex', mode: 'edit', approvalPolicy: 'ask', status: 'idle', messages: [],
      sessions: {}, models: {}, efforts: {}, effort: null, imports: {}, runs: [], transports: {}, requests: {}, reviewRequests: {}, reviews: [], snapshots: {}, rewinds: [], context: emptyContext(), model: null, transport: 'auto', settingsRevision: 0, lastRun: null, records: 0, activeRun: null, resume: null, resumeEnded: null, queue: [], queuePaused: null, handoffOffer: null, retryOffer: null, routing: null, createdAt: null, updatedAt: null };
  }

  apply(c, record) {
    c.records = record.seq;
    c.updatedAt = record.at;
    if (record.type === 'created') Object.assign(c, { createdAt: record.at, title: record.title });
    if (record.type === 'settings') { Object.assign(c, { provider: record.provider, mode: record.mode, approvalPolicy: record.approvalPolicy || 'ask', model: record.model ?? null, transport: record.transport || c.transport, settingsRevision: record.seq }); c.models[record.provider] = record.model ?? null; c.transports[record.provider] = record.transport || c.transport; }
    if (record.type === 'context') c.context = record.context;
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
    if (record.type === 'quota_observation') { c.quotaReadings ||= {}; c.quotaReadings[record.provider] = { windows: record.windows, observedAt: record.observedAt || record.at }; }
    applyBudgetRecord(c, record);
    if (record.type === 'routing') c.routing = record.routing;
    if (record.type === 'retry_offer') c.retryOffer = record.offer;
    if (record.type === 'retry_offer_end' && c.retryOffer?.id === record.id) c.retryOffer = null;
    if (record.type === 'check') { const run = c.runs?.findLast(item => item.id === record.runId); if (run) run.check = record.check; if (c.lastRun?.id === record.runId) c.lastRun.check = record.check; }
    if (record.type === 'resume') c.resume = record.resume;
    // Independent tasks (#88): saved before anything starts, so a crash can always find who owned what.
    if (record.type === 'parallel_task') c.parallelTasks = [...(c.parallelTasks || []), record.task];
    if (record.type === 'parallel_task_update') { const task = c.parallelTasks?.find(item => item.id === record.id); if (task) Object.assign(task, record.changes); }
    if (record.type === 'queue_add') c.queue = [...c.queue, record.item];
    if (record.type === 'queue_update') c.queue = c.queue.map(item => item.id === record.id ? { ...item, text: record.text } : item);
    if (record.type === 'queue_move') { const item = c.queue.find(entry => entry.id === record.id); if (item) { const rest = c.queue.filter(entry => entry !== item); rest.splice(record.index, 0, item); c.queue = rest; } }
    if (record.type === 'queue_remove' || record.type === 'queue_started') c.queue = c.queue.filter(item => item.id !== record.id);
    // One record, so a restart finds each prompt with one owner: moved or not, never both (#93).
    if (record.type === 'queue_moved') { const moves = new Map(record.moves.map(move => [move.id, move])); c.queue = c.queue.map(item => { const move = moves.get(item.id); if (!move) return item; const { routing, ...rest } = item; const { id, ...fields } = move; return { ...rest, ...(routing && !('routing' in fields) ? { routing } : {}), ...fields }; }); }
    if (record.type === 'queue_pause') c.queuePaused = { reason: record.reason, at: record.at };
    if (record.type === 'queue_resume') c.queuePaused = null;
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
        if (previous) { Object.assign(previous, message, { seq: record.seq, imported: true }); continue; }
        // The record names the message each new one follows (null for the start). Older records name none, so theirs go at the end, as does one whose message is gone (#55).
        const follows = record.after?.[message.id], found = follows == null ? -1 : c.messages[last]?.id === follows ? last : c.messages.findIndex(item => item.id === follows);
        last = follows === null ? 0 : found < 0 ? c.messages.length : found + 1;
        c.messages.splice(last, 0, { ...message, seq: record.seq, imported: true });
      }
    }
    if (record.type === 'message_delta') { const message = c.messages.find(m => m.id === record.id); if (!message) throw new Error('Message delta has no original message.'); message.text += record.text; message.seq = record.seq; if (record.status) message.status = record.status; }
    if (record.type === 'run_metadata') { if (c.activeRun) Object.assign(c.activeRun, record.metadata); }
    if (record.type === 'submission') {
      if (!record.review && !record.local) {
        if (record.resetSession) delete c.sessions[record.provider];
        Object.assign(c, { provider: record.provider, mode: record.mode, approvalPolicy: record.approvalPolicy || 'ask', model: record.model, transport: record.transport, settingsRevision: record.seq });
        c.models[record.provider] = record.model; c.transports[record.provider] = record.transport;
      } else if (record.review) c.reviews = [{ ...record.review, id: record.id, startedAt: record.at, status: 'running', findings: [] }, ...c.reviews].slice(0, 10);
      if (record.title) c.title = record.title;
      c.messages.push({ ...record.message, seq: record.seq });
      c.requests[record.requestId] = { runId: record.id, requestId: record.requestId, fingerprint: record.fingerprint };
      c.activeRun = { id: record.id, provider: record.provider, mode: record.mode, approvalPolicy: record.approvalPolicy || 'ask', model: record.model, transport: record.effectiveTransport || record.transport, baseline: record.baseline, context: record.context, ...(record.local ? { connection: 'local', local: record.local } : {}), ...(record.review ? { purpose: 'review', reviewId: record.id } : {}), ...(record.routing ? { routing: record.routing } : {}), ...(record.automaticReview ? { automaticReview: { ...record.automaticReview, status: 'building' } } : {}), effort: record.effort ?? null, phase: 'starting', lastEventAt: record.at, toolCount: 0, startedAt: record.at }; c.status = 'running';
      if (record.task) Object.assign(c.activeRun, { taskId: record.task.id, parentRunId: record.task.parentRunId, relation: record.task.relation });
      if (record.plan) c.activeRun.plan = record.plan;
    }
    if (record.type === 'background_review') { c.reviews = [record.review, ...c.reviews].slice(0, 10); c.reviewRequests[record.review.requestId] = { reviewId: record.review.id, requestId: record.review.requestId, fingerprint: record.review.fingerprint }; }
    if (record.type === 'review_process') { const review = c.reviews.find(item => item.id === record.id); if (review) Object.assign(review, { pid: record.pid, pidStart: record.pidStart }); }
    if (record.type === 'review_result') { const review = c.reviews.find(item => item.id === record.id); if (review) Object.assign(review, record.result, { endedAt: record.at }); }
    if (record.type === 'title') c.title = record.title;
    // Checkpoints (#20): a run's folders saved before and after it, and the undos made from them.
    if (record.type === 'run_snapshot') { c.snapshots ||= {}; const saved = c.snapshots[record.runId] ||= {}; saved[record.phase] = { folders: record.folders, at: record.at }; if (record.phase === 'after') { saved.files = record.files || 0; const run = c.runs?.findLast(item => item.id === record.runId); if (run) run.files = saved.files; } }
    if (record.type === 'rewind') c.rewinds = [...(c.rewinds || []), { id: record.id, target: record.target, runId: record.runId, folders: record.folders, counts: record.counts, left: record.left || [], at: record.at }];
    if (record.type === 'snapshot_expired') { for (const id of record.runIds || []) delete c.snapshots?.[id]; const gone = new Set(record.rewindIds || []); c.rewinds = (c.rewinds || []).filter(item => !gone.has(item.id)); }
    if (record.type === 'message') c.messages.push({ ...record.message, seq: record.seq });
    if (record.type === 'message_update') {
      const message = c.messages.find(m => m.id === record.id);
      if (!message) throw new Error('Conversation contains an update without its original message.');
      Object.assign(message, record.update, { seq: record.seq });
    }
    if (record.type === 'session') c.sessions[record.provider] = {
      id: record.id, cursor: c.sessions[record.provider]?.id === record.id ? c.sessions[record.provider].cursor : 0,
      workspaceSignature: record.workspaceSignature,
    };
    if (record.type === 'checkpoint' && c.sessions[record.provider]) c.sessions[record.provider].cursor = record.seq;
    if (record.type === 'run_start') {
      c.activeRun = { id: record.id, provider: record.provider, startedAt: record.at };
      c.status = 'running';
    }
    if (record.type === 'run_process' && c.activeRun) Object.assign(c.activeRun, { pid: record.pid, pidStart: record.pidStart });
    if (record.type === 'run_end') { if (c.activeRun && !c.activeRun.reviewId) c.lastBuilder = c.activeRun.provider; c.lastRun = { ...c.activeRun, status: record.status, errorCategory: record.errorCategory || null, endedAt: record.at }; c.activeRun = null; c.status = record.status; }
      // A short history of runs, rebuilt from the journal, for "while you were away" recaps (#22).
    if ((record.type === 'submission' && !record.review) || record.type === 'run_start') {
      c.runs = [...(c.runs || []), { id: record.id, ...(record.task ? { taskId: record.task.id, parentRunId: record.task.parentRunId, relation: record.task.relation } : {}), ...(record.context?.scope ? { context: { scope: record.context.scope } } : {}), provider: record.provider, model: record.model || null, local: Boolean(record.local), prompt: String(record.message?.text || '').slice(0, 300), startedAt: record.at, endedAt: null, status: 'running', errorCategory: null,
        ...(record.automaticReview ? { automaticReview: { ...record.automaticReview, status: 'building', summary: 'Build first, then one read-only review of the selected folders.' } } : {}),
        ...(record.routing ? { routing: { mode: record.routing.mode, tier: record.routing.tier || null } } : {}), ...(record.retryOf ? { retryOf: record.retryOf } : {}) }].slice(-50);
    }
    if (record.type === 'run_end') {
      const run = c.runs?.findLast(item => item.id === c.lastRun?.id && !item.endedAt);
      if (run) Object.assign(run, { status: record.status, errorCategory: record.errorCategory || null, endedAt: record.at, ...(typeof c.lastRun?.elapsedMs === 'number' ? { elapsedMs: c.lastRun.elapsedMs } : {}) });
    }
    if (record.type === 'automatic_review_phase') {
      for (const run of [c.activeRun, c.lastRun, ...c.runs]) if (run?.id === record.runId && run.automaticReview) Object.assign(run.automaticReview, record.phase);
    }
  }

  // Keeps usage limit readings apart from what runs used: these are account-wide and may include other tools (#84). Only a
  // reading that differs from the last one is saved.
  observeQuota(c, provider, usage) {
    if (!usage?.available || !Array.isArray(usage.windows) || !usage.windows.length) return;
    const windows = usage.windows.filter(row => typeof row.usedPercent === 'number').map(({ id, label, usedPercent, resetsAt, scope }) => ({ id, label, usedPercent, resetsAt: resetsAt || null, ...(scope ? { scope } : {}) }));
    const signature = JSON.stringify(windows.map(row => [row.id, row.usedPercent, row.resetsAt])), key = `${c.id}:${provider}`;
    this.quotaSeen ||= new Map();
    if (!windows.length || this.quotaSeen.get(key) === signature) return;
    this.quotaSeen.set(key, signature);
    this.record(c, { type: 'quota_observation', provider, observedAt: usage.fetchedAt ? new Date(usage.fetchedAt).toISOString() : undefined, plan: usage.plan || null, windows });
  }

  // Project memory (#21): every change comes from the person, through here.
  memory(c) { return memoryView(c, this.workspaceFolders); }
  changeMemory(c, input = {}) {
    const found = () => { const entry = (c.memory || []).find(item => item.id === input.id); if (!entry) throw Object.assign(new Error('That memory is no longer here.'), { status: 404 }); return entry; };
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
  async ledger(c, options = {}) { const ledger = await readLedger(path.join(this.dataDir, `${c.id}.jsonl`), options); return this.tasks ? { ...ledger, tasks: [...ledger.tasks, ...await this.tasks.ledgers(options)].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))) } : ledger; }

  // What a fresh agent would be told if this task moved now, without starting anything (#85).
  briefPreview(c) {
    const provider = c.provider, text = c.messages.some(message => message.role === 'user') ? continuationRequest : 'Preview';
    const prepared = prepareContext(c, text, { workspace: this.workspace, workspaceFolders: this.workspaceFolders, fresh: true, provider, mode: c.mode, policy: this.contextPolicy, journal: path.join(this.dataDir, `${c.id}.jsonl`), skills: this.skills.forTask(c, { text, relation: text === continuationRequest ? 'continuation' : null, fresh: true, provider }), readAttachment: () => ({ text: '' }), includeImages: false });
    return { brief: JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf('\n') + 1)).brief || null, metadata: prepared.metadata };
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
    this.emit('update', { conversationId: c.id });
    return record;
  }

  message(c, role, text, provider, id = randomUUID(), status) {
    const existing = c.messages.find(m => m.id === id);
    if (existing && text.startsWith(existing.text) && text !== existing.text) this.record(c, { type: 'message_delta', id, text: text.slice(existing.text.length), ...(status ? { status } : {}) });
    else if (existing && (text !== existing.text || (status && status !== existing.status))) this.record(c, { type: 'message_update', id, update: { ...(text !== existing.text ? { text } : {}), ...(status ? { status } : {}) } });
    else if (existing) return id;
    else this.record(c, { type: 'message', message: { id, role, text, provider, status,
      createdAt: new Date().toISOString(), runId: c.activeRun?.id, ...(c.activeRun?.connection === 'local' ? { connection: 'local' } : {}), ...(c.activeRun?.reviewId ? { reviewId: c.activeRun.reviewId } : {}), model: c.activeRun?.effectiveModel || c.activeRun?.model || null, effort: c.activeRun?.effectiveEffort || c.activeRun?.effort || null } });
    if (role === 'activity' && c.activeRun?.id) { try { this.budget.observeStep(c, { id, role, text, runId: c.activeRun.id }); } catch (error) { console.error('Codeshi could not count a step:', error.message); } }
    return id;
  }

  get(id) {
    const conversation = this.conversations.get(id);
    if (!conversation) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
    return conversation;
  }

  // With since, the messages changed after that record; an import can put messages anywhere, so one after it sends them all.
  view(c, { since = null } = {}) {
    const { sessions, requests, reviewRequests, records, imports, reviews, snapshots, rewinds, reordered, memory, memoryDismissed, skills, skillDirs, taskBudgets, taskOfRun, budgetActive, budgetLast, budgetTotals, quotaReadings, parallelTasks, asyncQuestions, ...visible } = c;
    const changed = Number.isSafeInteger(since) && since >= (reordered || 0) && since <= records ? c.messages.filter(message => message.seq > since) : null;
    return { ...visible, cursor: records, ...(this.tasks ? { parallelTasks: this.tasks.list(c) } : {}), ...(c.status === 'running' ? {} : { taskResult: taskResult(c) }), ...(changed ? { messageCount: c.messages.length } : {}), checkpoints: this.checkpoints?.summary(c) || {}, resume: c.resume ? { ...c.resume, ...this.resume?.view(c) } : null, reviews: reviews.map(publicReview), pendingApprovals: this.pendingApprovals(c), canAddToRun: this.running?.c.id === c.id && this.running.steerable && !this.running.ending, messages: (changed || c.messages).map(({ seq, ...m }) => m) };
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

  settings(c, { provider = c.provider, mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', model = provider === c.provider ? c.model : c.models[provider] || null, transport = provider === c.provider ? c.transport || 'auto' : c.transports[provider] || 'auto', effort = c.efforts[provider]?.[model || 'default'] ?? null }) {
    checkSettings(provider, mode, approvalPolicy);
    this.validateSelection(model, transport, effort);
    if (c.activeRun) throw Object.assign(new Error('Stop the current run before switching assistants.'), { status: 409 });
    this.record(c, { type: 'settings', provider, mode, approvalPolicy, model, transport, effort });
    return this.view(c);
  }

  // Auto (#12): Codeshi picks the agent, model and effort for each message, in one of three modes. Agents billed
  // outside a subscription are only chosen when allowed. Choosing a model by hand turns it off.
  setRouting(c, input = {}) {
    const routing = input.mode === null || input.mode === undefined ? null : { mode: input.mode, allowApi: input.allowApi === true, check: input.check === true };
    if (routing && !ROUTING_MODES.includes(routing.mode)) throw Object.assign(new Error('Choose Cost saving, Balanced or Maximum quality.'), { status: 400 });
    if (c.activeRun) throw Object.assign(new Error('Stop the current run before changing how agents are chosen.'), { status: 409 });
    this.record(c, { type: 'routing', routing });
    return this.view(c);
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
    if (!this.providerStatus || Date.now() - this.providerStatusCheckedAt >= 10000) {
      if (!this.providerStatusPending) {
        this.providerStatusPending = Promise.all(PROVIDERS.map(async provider => {
          const bin = resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot });
          this.bins[provider] = bin;
          if (provider === 'gemini' && isAntigravityACP(bin)) return [provider, { installed: true, available: true, path: bin, authenticated: 'unknown', billingSource: 'unknown', capabilities: { ...capabilities(provider), readOnly: 'unavailable' } }];
          const result = bin ? await probeCli(bin, ['--version'], 4000) : null;
          // A CLI that is slow to answer is still installed: keep its last known status, or treat it as usable but unverified.
          if (result?.timedOut && this.providerStatus?.[provider]) return [provider, this.providerStatus[provider]];
          const usable = result?.status === 0 || Boolean(result?.timedOut);
          const agyBlocked = provider === 'gemini' && isAgy(bin) && Boolean(this.configuredBins[provider]);
          return [provider, { available: usable && !agyBlocked, version: clip(result?.stdout?.trim(), 200), path: bin, installed: usable, ...(result?.timedOut && { errorCategory: 'timeout' }), authenticated: 'unknown', billingSource: 'unknown', authMode: 'unknown', usage: 'unknown', capabilities: capabilities(provider, this.configuredBins[provider] ? 'cli' : 'auto') }];
        })).then(entries => {
          this.providerStatus = Object.fromEntries(entries);
          this.providerStatusCheckedAt = Date.now();
        }).finally(() => { this.providerStatusPending = null; });
        // A background check that nobody awaits must not become an unhandled rejection.
        this.providerStatusPending.catch(() => {});
      }
      // Only the first check waits. Later ones refresh in the background, so a slow CLI never delays the conversation.
      if (!this.providerStatus) await this.providerStatusPending;
    }
    return { workspace: this.workspace, workspaces: this.workspaces, workspaceFolders: this.workspaceFolders, providers: this.providerStatus, runningConversationId: this.running?.c.id || null, pendingApprovals: [...this.conversations.values()].flatMap(c => this.pendingApprovals(c)) };
  }

  prompt(c, text, fresh = false) { return prepareContext(c, text, { workspace: this.workspace, workspaceFolders: this.workspaceFolders, fresh: fresh || c.sessions[c.provider]?.workspaceSignature !== this.workspaceSignature }).prompt; }

  start(c, { text, attachments: attachmentIds = [], provider = c.provider, mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', fresh = false, model = provider === c.provider ? c.model : c.models[provider] || null, transport = provider === c.provider ? c.transport || 'auto' : c.transports[provider] || 'auto', requestId = randomUUID(), billingConfirmed = false, effort = c.efforts[provider]?.[model || 'default'] ?? null, routing = null, automaticReview = null }, { review, verifyReview, local, verifyLocal, resume, queued, retryOf = null, limitChain = null } = {}) {
    if (review) { mode = 'read'; approvalPolicy = 'ask'; fresh = true; attachmentIds = []; }
    if (local) { if (review || typeof verifyLocal !== 'function') throw Object.assign(new Error('Invalid local run.'), { status: 400 }); provider = 'codex'; model = local.model; transport = 'app-server'; effort = null; fresh = true; }
    checkSettings(provider, mode, approvalPolicy);
    this.validateSelection(model, transport, effort);
    routing = review || local ? null : routingNote(routing);
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw Object.assign(new Error('Enter a message between 1 and 100,000 characters.'), { status: 400 });
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw Object.assign(new Error('Invalid request ID.'), { status: 400 });
    const attachments = this.attachments.select(attachmentIds);
    if (local && attachments.some(file => file.kind !== 'text')) throw Object.assign(new Error('This local connection supports text and code attachments. Remove image attachments or choose a cloud agent; your draft stays saved.'), { status: 400 });
    text = text.trim(); model = model || null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ text, ...(automaticReview !== null ? { automaticReview } : {}), ...(local ? { local } : {}), ...(review ? { review: review.snapshot.digest } : {}), ...(attachments.length ? { attachments: attachmentIds } : {}), provider, mode, approvalPolicy, fresh, model, ...(effort ? { effort } : {}), transport: transportFor(provider, transport, this.configuredBins[provider]) })).digest('hex');
    const accepted = c.requests[requestId];
    if (accepted) { if (accepted.fingerprint !== fingerprint) throw Object.assign(new Error('This request ID was already used for another message.'), { status: 409 }); return { runId: accepted.runId, requestId, duplicate: true }; }
    if (this.running) throw Object.assign(new Error('An assistant is already working in this workspace. Stop it before starting another run.'), { status: 409 });
    // Every task in a workspace shares one limit on how many work at once (#88).
    if (!review) this.admit?.(c);
    // The one place every run starts from, so nothing gets past the task's limits (#87). A request already accepted returned above.
    const runId = randomUUID(), task = taskIdentity(c, { runId, text, retryOf, review });
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
    const bin = resolveBinary(provider, { override: this.configuredBins[provider], googleRoot: this.googleRoot });
    if (!bin) throw Object.assign(new Error(`${provider === 'gemini' ? 'Gemini' : provider === 'codex' ? 'Codex' : 'Claude'} CLI could not be found. Install it or set AI_RELAY_${provider.toUpperCase()}_BIN to its executable path, then retry.`), { status: 503, category: 'installation' });
    if (provider === 'gemini' && isAntigravityACP(bin) && mode === 'read') throw Object.assign(new Error(antigravityReadOnly), { status: 400, category: 'permission' });
    // Gemini CLI takes its effort from the model, so a level saved under the Antigravity connection doesn't apply and can't stop a run.
    if (provider === 'gemini' && !isAntigravityACP(bin)) effort = null;
    if (provider === 'gemini' && isAntigravityACP(bin) && this.workspaces.length > 1) throw Object.assign(new Error('This Antigravity connection currently supports one project folder. Choose a workspace with one folder.'), { status: 400 });
    if (provider === 'gemini' && isAgy(bin)) throw Object.assign(new Error(agyUnsupported), { status: 503, category: 'installation' });
    const actualTransport = transportFor(provider, transport, this.configuredBins[provider]);
    if ((provider === 'gemini' && actualTransport !== 'acp') || (provider !== 'gemini' && actualTransport === 'acp') || (provider === 'codex' && actualTransport === 'sdk') || (provider === 'claude' && actualTransport === 'app-server')) throw Object.assign(new Error('This transport does not support the selected provider.'), { status: 400 });
    // A native session may retain tool permissions for folders since removed.
    // Reconstruct from the canonical journal whenever membership changes.
    const switchedAgent = Boolean(c.lastRun && (c.lastRun.provider !== provider || c.lastRun.connection === 'local'));
    const changedWorkspace = Boolean(c.sessions[provider] && c.sessions[provider].workspaceSignature !== this.workspaceSignature);
    const resetSession = Boolean(c.sessions[provider] && (changedWorkspace || switchedAgent || fresh));
    const effectiveFresh = Boolean(fresh || changedWorkspace || switchedAgent || provider === 'gemini' || !c.sessions[provider]?.id);
    const sessionReason = review ? 'review' : local ? 'local-handoff' : changedWorkspace ? 'workspace-changed' : switchedAgent ? 'cross-agent-handoff' : fresh ? 'explicit-restart' : provider === 'gemini' ? 'provider-fresh-session' : effectiveFresh ? 'new-conversation' : 'same-agent-continuation';
    const sessionId = effectiveFresh ? null : c.sessions[provider]?.id;
    const prepared = review ? { prompt: reviewPrompt(review, { ...validateContext(c.context), workspaceFolders: this.workspaceFolders }), images: [], metadata: { purpose: 'review', fresh: true, digest: review.snapshot.digest } } : prepareContext(c, text, { workspace: this.workspace, workspaceFolders: this.workspaceFolders, fresh: effectiveFresh, provider, mode, session: { sessionReason, ...(switchedAgent ? { previousProvider: c.lastRun.provider } : {}) }, attachments, readAttachment: id => this.attachments.read(id), policy: this.contextPolicy, journal: path.join(this.dataDir, `${c.id}.jsonl`), skills: local ? null : this.skills.forTask(c, { text, relation: task.relation, fresh: effectiveFresh, provider }), ...(local ? { maxBytes: 96000, includeImages: false } : {}) });
    if (review && Buffer.byteLength(prepared.prompt) > 192000) throw Object.assign(new Error('Review context exceeds 192 KB. Select fewer files or shorten the saved project brief.'), { status: 413 });
    if (actualTransport === 'cli' && prepared.images.length) throw Object.assign(new Error('Image attachments require the native Codex or Claude connection. Switch the transport from CLI, or remove the images.'), { status: 400 });
    const images = prepared.images.map(file => this.attachments.imageInput(file.id));
    const lease = this.acquireMutation(`provider:${provider}`);
    let baseline;
    try { if (review) verifyReview(); baseline = review ? { kind: 'review', git: true, digest: review.snapshot.digest, capturedAt: new Date().toISOString() } : workspaceBaseline(this.workspace, this.workspaceFolders); } catch (error) { lease.release(); throw error; }
    const run = { id: runId, taskId: task.id, c, provider, mode, approvalPolicy, child: null, terminalSuccess: false, failed: false, stopped: false,
      stderr: '', tools: new Map(), approvals: new Map(), currentClaudeMessage: null, killTimer: null, done: null, lease, review, local, resume: resume || null, queued: queued || null, limitChain, billingConfirmed: billingConfirmed === true, errorCategory: null, workspaceSignature: this.workspaceSignature,
      model, effort, steerable: !review && actualTransport !== 'cli', steers: new Map(), routing, baseline, retryOf, automaticReview };
    let finish;
    run.done = new Promise(resolve => { finish = resolve; });
    try {
      this.record(c, { type: 'submission', id: runId, task, ...(plan ? { plan } : {}), previousProvider: c.lastRun?.provider || null, requestId, fingerprint, provider, mode, approvalPolicy, model, effort, transport, effectiveTransport: actualTransport, baseline, context: prepared.metadata, resetSession, workspaceSignature: this.workspaceSignature,
        ...(local ? { local } : {}), ...(review ? { review } : {}), ...(c.messages.every(m => m.role !== 'user') ? { title: text.slice(0, 64) } : {}),
        ...(routing ? { routing } : {}), ...(retryOf ? { retryOf } : {}),
        ...(automaticReview ? { automaticReview } : {}),
        message: { id: randomUUID(), role: 'user', text, ...(local ? { connection: 'local' } : {}), ...(review ? { reviewId: runId } : {}), ...(attachments.length ? { attachments } : {}), ...(routing ? { routing: { mode: routing.mode, reason: routing.reason, ...(routing.tier ? { tier: routing.tier } : {}), model, effort } } : {}), ...(retryOf ? { retry: { of: retryOf } } : {}), provider, createdAt: new Date().toISOString(), runId } });
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
          const detail = run.budgetStop ? `Stopped: ${run.budgetStop.message} Files already changed by this run remain in the workspace.` : run.stopped ? 'Stopped. Files already changed by this run remain in the workspace.' : error?.message || run.stderr.trim() || `The assistant ended without completing the turn (exit ${code ?? signal ?? 'unknown'}).`;
          run.errorCategory ||= run.stopped ? 'interrupted' : classifyError(error || detail);
          const notice = clip(detail) + (review ? '\nStart a new read-only review when ready.' : run.stopped ? '' : '\nYour conversation is saved. Select the other assistant and continue, or retry after resolving the error.');
          if (run.errorCategory === 'quota' && this.handoff.atLimit(run)) { run.limitNotice ||= notice; continuing = true; }
          else {
            if (run.limitNotice) this.message(c, 'error', run.limitNotice, provider);
            // A handoff says itself why the run stopped, so it is not shown as an error.
            if (!run.handoff) this.message(c, 'error', notice, provider);
          }
        }
        for (const message of c.messages.filter(m => m.runId === runId && m.role === 'assistant')) this.record(c, { type: 'message_update', id: message.id, update: { status: success ? 'complete' : 'incomplete' } });
        this.record(c, { type: 'run_metadata', metadata: { elapsedMs: Date.now() - Date.parse(c.activeRun.startedAt), phase: success ? 'complete' : 'stopped', lastEventAt: c.activeRun.lastEventAt } });
        if (review) this.record(c, { type: 'review_result', id: runId, result: success ? parseReviewResult(c.messages.filter(message => message.runId === runId && message.role === 'assistant').at(-1)?.text, review.snapshot) : { status: run.stopped ? 'interrupted' : 'failed', summary: run.stopped ? 'Review stopped. Start a new review when ready.' : 'The review did not finish. Check the agent response and try again.', findings: [] } });
        this.record(c, { type: 'run_end', status: run.stopped ? 'interrupted' : success ? 'complete' : 'incomplete', errorCategory: run.errorCategory });
        if (!review) this.checkpoints.after(c, run);
        if (success && !review && !local && c.sessions[provider]) this.record(c, { type: 'checkpoint', provider });
      } catch (persistError) { success = false; run.persistenceError = persistError.message; }
      finally { try { lease.release(); } catch (releaseError) { success = false; run.persistenceError ||= releaseError.message; } finally {
        this.handoff.unwatch(run); this.budget.unwatch(run);
        if (continuing) c.limitSwitching = { provider };
        this.running = null; this.emit('update', { conversationId: c.id }); finish({ success, error: run.persistenceError });
        const settle = () => {
          // A run that continued after a reset may wait again if it reached another limit; otherwise say how the run ended.
          let waiting = false;
          try { waiting = this.resume.runEnded(c, run, run.stopped ? 'interrupted' : success ? 'complete' : 'incomplete'); } catch (error) { console.error('Codeshi could not report a resumed run:', error.message); }
          const agent = provider === 'claude' ? 'Claude' : provider === 'gemini' ? 'Gemini' : run.local ? 'The local model' : 'Codex';
          if (!review && !waiting && !run.stopped) this.emit('notify', success
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
      try {
        if (local) {
          local = { ...local, ...await verifyLocal() };
          this.record(c, { type: 'run_metadata', metadata: { account: { authenticated: true, authMode: 'local', billingSource: 'local' } } });
        } else if (!this.configuredBins[provider]) {
          const account = await accountStatus(provider, { bin, workspace: this.workspace, googleRoot: this.googleRoot });
          this.record(c, { type: 'run_metadata', metadata: { account: { authenticated: account.authenticated, authMode: account.authMode, billingSource: account.billingSource } } });
          if (account.authenticated === false) throw Object.assign(new Error('Sign in through the provider’s supported authentication flow before running.'), { category: 'authentication' });
          run.billingSource = account.billingSource;
          if (account.billingSource !== 'subscription' && !billingConfirmed) throw Object.assign(new Error(`Billing source is ${account.billingSource}. Explicitly confirm this provider run before it may consume usage.`), { category: 'permission' });
        }
        if (!review) await this.checkpoints.before(c, run);
        if (run.stopped) return complete(null, null, new Error('Run stopped.'));
        const command = commandFor(provider, { mode, approvalPolicy, sessionId, bin, workspace: this.workspace, workspaces: this.workspaces, effort });
        if (provider === 'codex') {
          command.args.unshift('-c', 'features.hooks=false', '-c', 'notify=[]');
          if (model) command.args.unshift('--model', model);
          if (!baseline.git && !sessionId) command.args.splice(command.args.indexOf('exec') + 1, 0, '--skip-git-repo-check');
        } else if (provider === 'claude') {
          command.args.push('--setting-sources', '', '--settings', '{"disableAllHooks":true}');
          command.args.push('--model', model || 'default');
        }
        // The worker cannot launch a provider until its PID and mutation lease are durable.
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
            if (message.type === 'failure') { run.failed = true; run.errorCategory = message.category; run.stderr = clip(run.stderr + '\n' + message.message); }
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
        run.child.send({ type: 'start', config: { ...(run.billingSource === 'api' && this.budget.remainingSpend(c, run.taskId) !== null ? { maxBudgetUsd: this.budget.remainingSpend(c, run.taskId) } : {}), bin, googleRoot: this.googleRoot, args: command.args, workspace: this.workspace, workspaces: this.workspaces, workspaceFolders: this.workspaceFolders, prompt: prepared.prompt, images, transport: actualTransport, provider, mode, approvalPolicy, model, effort, sessionId, ...(local ? { local } : {}), ...(review ? { reviewSnapshot: true } : {}) } });
      } catch (error) { run.errorCategory = error.category || classifyError(error); complete(null, null, error); }
    };
    launch();
    this.handoff.watch(run); this.budget.watch(run);
    return { runId, requestId };
  }

  event(run, event) {
    const phase = event.type === 'thread.started' || event.type === 'system' && event.subtype === 'init' ? 'working' : event.item?.type === 'reasoning' ? 'reasoning' : event.type === 'relay.progress' ? event.phase : event.type === 'relay.delta' ? 'responding' : event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' ? 'responding' : ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(event.item?.type) ? (event.type === 'item.started' ? 'tool' : 'working') : event.type === 'assistant' && event.message?.content?.some(block => block.type === 'tool_use') ? 'tool' : null;
    const toolIds = [...(event.item && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(event.item.type) && event.item.id ? [event.item.id] : []), ...(event.type === 'assistant' ? (event.message?.content || []).filter(block => block.type === 'tool_use').map(block => block.id) : [])];
    run.seenTools ||= new Set();
    for (const id of toolIds) if (!run.seenTools.has(id)) { run.seenTools.add(id); if (run.c.activeRun) run.c.activeRun.toolCount = run.seenTools.size; }
    this.touch(run, phase);
    const { c, provider } = run;
    // The agent shortened its own context, which Codeshi can't see into, so it is only counted (#85).
    if (event.type === 'relay.progress' && event.phase === 'compacting' && run.lastProgress !== 'compacting') { run.compactions = (run.compactions || 0) + 1; this.record(c, { type: 'run_metadata', metadata: { compactions: run.compactions } }); }
    if (event.type === 'relay.progress') { run.lastProgress = event.phase; return; }
    if (!event || typeof event !== 'object') throw new Error('Invalid provider protocol event.');
    // The agent's own plan for the run, shown as a to-do list.
    if (event.type === 'relay.plan') {
      const steps = (Array.isArray(event.steps) ? event.steps : []).filter(step => typeof step?.text === 'string' && step.text.trim()).slice(0, 50)
        .map(step => ({ text: step.text.trim().slice(0, 300), status: ['done', 'active'].includes(step.status) ? step.status : 'pending' }));
      this.record(c, { type: 'run_metadata', metadata: { plan: { steps: reportedPlan(c.activeRun?.plan, steps), explanation: typeof event.explanation === 'string' ? event.explanation.slice(0, 500) : null, updatedAt: new Date().toISOString(), ...(c.activeRun?.plan?.carriedFrom ? { carriedFrom: c.activeRun.plan.carriedFrom } : {}) } } });
      return;
    }
    if (event.type === 'relay.delta') { const id = `${run.id}:${event.id}`; const existing = c.messages.find(m => m.id === id); this.message(c, 'assistant', (existing?.text || '') + event.text, provider, id, 'streaming'); return; }
    if (provider === 'codex' || provider === 'gemini') {
      if (!run.review && !run.local && event.type === 'thread.started' && event.thread_id) this.record(c, { type: 'session', provider, id: event.thread_id, workspaceSignature: run.workspaceSignature || this.workspaceSignature });
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
        this.message(c, 'activity', clip(`$ ${item.command}\n${item.aggregated_output || ''}`), provider, id);
        // In Read only, a blocked command looks like a network or disk fault, so the run says what stopped it, once.
        if (event.type === 'item.completed' && provider === 'codex' && run.mode === 'read' && !run.review && !run.blockExplained && blockedBySandbox(item.aggregated_output)) {
          run.blockExplained = true;
          this.message(c, 'activity', 'Blocked by Read only: switch to Can edit files to let Codex use the network or change files.', provider);
        }
      }
      if (item.type === 'file_change') this.message(c, 'activity', `File changes: ${JSON.stringify(fileChanges(item.changes))}`, provider, id);
      if (['mcp_tool_call', 'web_search'].includes(item.type)) this.message(c, 'activity', clip(`${item.type}: ${item.tool || item.query || ''}\n${JSON.stringify(item.result || item.arguments || '')}`), provider, id);
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
    if (!run.review && event.session_id && c.sessions.claude?.id !== event.session_id) this.record(c, { type: 'session', provider, id: event.session_id, workspaceSignature: run.workspaceSignature || this.workspaceSignature });
    if (event.type === 'stream_event') {
      const stream = event.event;
      if (stream?.type === 'message_start') run.currentClaudeMessage = stream.message?.id || randomUUID();
      if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta') {
        const id = `${run.id}:${run.currentClaudeMessage || 'response'}`;
        const existing = c.messages.find(m => m.id === id);
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
        this.message(c, 'activity', clip(`${tool.name}\n${toolInput(tool.name, tool.input)}`), provider, `${run.id}:tool:${tool.id}`);
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const tool of event.message.content.filter(block => block.type === 'tool_result')) {
        const id = `${run.id}:tool:${tool.tool_use_id}`;
        const existing = c.messages.find(m => m.id === id);
        const content = typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content || []);
        this.message(c, 'activity', clip(`${existing?.text || run.tools.get(tool.tool_use_id) || 'Tool result'}\n${content}`), provider, id);
      }
    }
    if (event.type === 'system' && event.subtype === 'init' && event.model) this.record(c, { type: 'run_metadata', metadata: { effectiveModel: event.model } });
    if (event.type === 'result') {
      run.terminalSuccess = event.subtype === 'success' && !event.is_error;
      if (!run.terminalSuccess) {
        run.failed = true; if (run.errorCategory !== 'quota') run.errorCategory = classifyError(event.result || event.errors?.join(' '));
        this.agentError(run, clip(event.result || event.errors?.join('\n') || event.subtype || 'Claude could not complete this turn.'));
      } else if (event.result && !c.messages.some(m => m.runId === run.id && m.role === 'assistant')) {
        this.message(c, 'assistant', event.result, provider, `${run.id}:response`, 'complete');
      }
      if (event.permission_denials?.length) {
        run.failed = true; run.errorCategory = 'permission';
        this.message(c, 'error', 'Claude requested a tool that needs approval in its native terminal. Some work may be incomplete.\n' + clip(JSON.stringify(event.permission_denials)), provider);
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

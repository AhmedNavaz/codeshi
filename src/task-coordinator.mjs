import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readLedger } from './task-ledger.mjs';
import { designSection, evaluateIntegration, stepPrompt } from './orchestration.mjs';
import { reviewHolds } from './plan-review.mjs';
import { runSteps } from './recap.mjs';
import { noteActivity } from './activity.mjs';
import { attachmentLimits, inspectAttachment } from './attachments.mjs';
import { validateRelativePath } from './collaboration-format.mjs';
import { readExplorerFile } from './file-explorer.mjs';
import { workspaceGitDiff } from './workspace-git.mjs';
import { executionConfig } from './execution-policy.mjs';
import { RESOLVABLE, applyPlan, broughtFiles, checkCombined, createWorktree, folderIdentity, git, integrationPlan, keepBranch, markerLabels, ownCheck, planIsolation, prepareResolution, prepareWorktree, refreshWorktree, removeWorktree, resolvePrompt, restoreResolution, snapshotWorktree, uncommittedCount, unfinishedFiles, unrestricted } from './task-isolation.mjs';

// Independent tasks in one workspace (#88). Each task is a lane: a broker of its own, scoped to one folder, with its own
// journal, native sessions, approvals, queue and Stop. A late event can't reach the wrong task, because a lane has no other
// task to reach. The main conversation's journal records who owns what before anything starts, so a crash can always be
// recovered from, and the coordinator decides how each lane may run (see task-isolation.mjs).
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const ENDED = new Set(['integrated', 'kept', 'discarded', 'cancelled']);
// Why a task Flow started never did: you took over from Flow before it started (src/board.mjs flowEnded).
export const TOOK_OVER = 'Not started: you took over from Flow. Run it again when you’re ready.';
const MAX_INTEGRATION_CHANGES = 200, MAX_INTEGRATION_REST = 5000;
const integrationChanges = (files = []) => files.slice(0, MAX_INTEGRATION_CHANGES).map(file => ({
  path: file.path,
  change: file.change,
  added: Number(file.added) || 0,
  removed: Number(file.removed) || 0,
  status: file.status,
  ...(file.resolved ? { resolved: true } : {}),
  ...(file.diff ? { diff: file.diff } : {}),
}));
const STOPPED = { complete: 'complete', interrupted: 'stopped', incomplete: 'failed' };
// The tasks one waits for: none, one (as a task started by hand saves it) or several (a plan step after more than one step).
const waitsFor = task => task.dependsOn ? [].concat(task.dependsOn) : [];
// The dependency folders brought into a task's copy, which never become part of its changes.
const brought = task => (task.setup?.dependencies || []).map(item => item.path);
// The files a Plan card saves that Git ignores (task-isolation.mjs ignoredPaths), as the Plan found them when it started
// the card. Such a card waits for its folder rather than work in a copy that would lose them.
const keptFiles = list => Array.isArray(list) ? list.filter(item => typeof item === 'string' && item && item.length <= 300).slice(0, 40) : [];
const line = text => { const first = String(text || '').trim().split('\n')[0]; return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first; };
const clip = (text, limit) => { const value = String(text || '').trim(); return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value; };
// A plan step that finished in place is built on once its tests pass (#89). Failed or interrupted tests hold the steps
// after it until you check it again or choose to continue anyway. A step in its own copy waits for your merge instead.
// A card from the Plan (#162) is held the same way.
const tested = task => Boolean(task.plan || task.board);
// A handoff keeps its task and slot while the old run has ended and the destination is starting.
const working = lane => Boolean(lane?.broker.running || lane?.c?.limitSwitching);
// Usage rows added up, for limits shared by several tasks.
const sum = rows => {
  const total = { workingMs: 0, tokens: 0, spendUSD: 0, retries: 0, reviews: 0, handoffs: 0, runsWithoutUsage: 0, runsWithPartialUsage: 0, runsWithoutCost: 0, running: 0 };
  for (const row of rows.filter(Boolean)) for (const key of Object.keys(total)) total[key] += Number(row[key]) || 0;
  return total;
};
// A review card's findings hold the cards after it too (#89), while it repairs and once it needs you (src/plan-review.mjs).
const gated = task => Boolean(tested(task) && task.status === 'complete' && ((task.stepCheck && (task.stepCheck.status === 'running' || ((task.stepCheck.outcome === 'failed' || task.stepCheck.status === 'interrupted') && !task.stepCheck.accepted))) || reviewHolds(task)));

const AGENT_LEASE = /^(?:provider:|compact-context$|automatic-review$)/;

export class TaskCoordinator {
  constructor(main, { BrokerClass, acquireFolders = () => ({ release() {}, setProcess() {} }), withFolders = async (paths, operation, work) => work(), activeMutations = () => [], tests = null }) {
    Object.assign(this, { main, BrokerClass, acquireFolders, withFolders, activeMutations, tests });
    this.lanes = new Map(); this.closed = false; this.ticking = false; this.mainBusy = false; this.checking = new Map(); this.aborts = new Set();
    // Tasks whose copy is still being prepared. They hold a slot, and the queue leaves them alone until they start.
    this.preparing = new Map();
    // Waiting tasks look again when the main conversation's run begins or ends.
    main.on('update', () => { const busy = this.activeWorkers; if (busy !== this.mainBusy) { this.mainBusy = busy; this.tickAll(); } });
    main.admit = c => this.admit(c, null);
  }
  all() { return [...this.main.conversations.values()].flatMap(c => (c.parallelTasks || []).map(task => ({ c, task }))); }
  find(c, id) { const task = (c.parallelTasks || []).find(item => item.id === id); if (!task) throw fail('That task is no longer here.', 404); return task; }
  // A card on the board (#132) follows the task it started, so the board hears about every change.
  update(c, task, changes) { this.main.record(c, { type: 'parallel_task_update', id: task.id, changes }); this.onTask?.(c, task); this.main.emit('update', { conversationId: c.id }); }
  get running() { return [...this.lanes.values()].filter(working).length; }
  get activeWorkers() { return (this.main.running ? 1 : 0) + this.running + this.holding() + this.preparing.size + (this.main.board?.suggestJobs?.size || 0) + [...this.main.conversations.values(), ...[...this.lanes.values()].map(lane => lane.c).filter(Boolean)].reduce((sum, c) => sum + c.reviews.filter(review => review.background && review.status === 'running').length, 0); }
  // Cards between two subtasks have no run for a moment but keep their slot (src/subtasks.mjs).
  holding() { let count = 0; for (const [id, lane] of this.lanes) if (!working(lane) && lane.task && this.main.board?.subtasks.holding(lane.task)) count++; return count; }
  get busy() { return this.running > 0 || this.checking.size > 0; }
  get waitingResumes() { return [...this.lanes.values()].reduce((count, lane) => count + (lane.broker.waitingResumes || 0), 0); }
  openLanes() { return [...this.lanes.values()].map(lane => lane.broker); }
  // The lane that owns a conversation, for routes that arrive by conversation ID.
  owner(conversationId) {
    for (const { c, task } of this.all()) if (task.conversationId === conversationId) { const lane = this.lane(c, task); return lane && { ...lane, home: c }; }
    return null;
  }
  // Workspace-wide concurrency: the main conversation's run and every lane share one limit.
  admit(c, task) {
    if (task && !this.available(task)) throw fail(`${task.folderName} is no longer in this workspace, so this task can't run. Its history stays.`);
    if (task && (ENDED.has(task.status) || task.status === 'lost')) throw fail('This task has ended, so it can’t run again. Its history stays. Start a new task to carry on.');
    const home = c || [...this.main.conversations.values()].find(item => item.id === this.main.mainConversationId) || [...this.main.conversations.values()][0];
    const limit = this.main.budget.policy(home).maxConcurrent, others = this.activeWorkers - (task && (working(this.lanes.get(task.id)) || this.main.board?.subtasks.holding(task)) ? 1 : 0);
    if (others >= limit) throw fail(`${others} ${others === 1 ? 'task is' : 'tasks are'} already running, the most this workspace's task limits allow at once.`);
    if (task) this.syncPolicy(home, task);
  }
  available(task) { return task.purpose === 'plan-chat' ? this.main.workspaceFolders.some(folder => folder.id === task.folderId) : task.purpose === 'project-review' ? JSON.stringify(task.workspaceFolders.map(({ id, path }) => ({ id, path }))) === JSON.stringify(this.main.workspaceFolders.map(({ id, path }) => ({ id, path }))) : this.main.workspaceFolders.some(folder => folder.id === task.folderId); }
  syncPolicy(c, task) {
    const lane = this.lanes.get(task.id); if (!lane) return;
    const policy = this.policyFor(c, task);
    if (JSON.stringify(lane.broker.budget.policy(lane.c)) !== JSON.stringify(policy)) lane.broker.budget.setPolicy(lane.c, policy);
  }

  // What is working right now, for the plan: lanes as their records say, and the main run in every folder it can reach.
  occupants(c, except = null) {
    const rows = [];
    if (this.main.running && !this.main.running.review) {
      const run = this.main.running, loose = unrestricted(run);
      for (const folder of this.main.workspaceFolders) { try { const identity = folderIdentity(folder.path); rows.push({ real: identity.real, commonDir: identity.commonDir || null, unrestricted: loose, label: 'The main conversation' }); } catch { /* A folder that's gone holds nothing. */ } }
    }
    for (const { task } of this.all()) {
      if (task.id === except || !working(this.lanes.get(task.id))) continue;
      rows.push({ real: task.scopePath, commonDir: task.commonDir || null, unrestricted: task.mode === 'direct' && unrestricted({ provider: task.provider, mode: task.accessMode, approvalPolicy: task.approvalPolicy }), label: `“${task.title}”` });
    }
    return rows;
  }
  plan(c, input) {
    const folder = this.main.workspaceFolders.find(item => item.id === input.folderId);
    if (!folder) throw fail('Choose a folder in this workspace.', 400);
    let identity;
    try { identity = folderIdentity(folder.path); } catch { throw fail(`${folder.displayName || folder.name} is unavailable.`, 404); }
    // Launch-map preparation reads the actual attached workspace concurrently. It never edits files or uses a worktree.
    if (input.purpose === 'project-review') return { mode: 'direct', reason: 'Inspecting the attached workspace', identity, folder };
    // Git commits, merges, staging, patches and restores briefly rewrite repository state or move HEAD: wait for them
    // before branching a worktree or entering the folder so the new task starts from clean, post-mutation state.
    const folderBusy = this.activeMutations([...new Set([identity.root, identity.real].filter(Boolean))]).find(entry => !AGENT_LEASE.test(entry.operation));
    if (folderBusy) return { mode: 'wait', blocker: folderBusy.operation, reason: `Project files are busy: ${folderBusy.operation} is active in an overlapping workspace.`, identity, folder };
    const plan = planIsolation(identity, this.occupants(c, input.taskId), { loose: unrestricted({ provider: input.provider || c.provider, mode: input.accessMode || input.mode || c.mode, approvalPolicy: input.approvalPolicy || c.approvalPolicy || 'ask' }), keeps: keptFiles(input.ignoredFiles) });
    return { ...plan, identity, folder, ...(plan.mode === 'worktree' ? { uncommitted: uncommittedCount(folder.path) } : {}) };
  }
  // How a task would run, and whether it would have to wait for a free slot, for the page to say before it starts.
  preview(c, input) {
    const { identity, folder, ...plan } = this.plan(c, input), limit = this.main.budget.policy(c).maxConcurrent, running = this.activeWorkers;
    return { ...plan, running, limit, full: running >= limit };
  }

  start(c, input = {}, { queueExecution = null, prepareReview = false, held = false, plan = null, board = null, batch = null, splitRepair = null } = {}) {
    input = { ...input, purpose: prepareReview ? 'project-review' : null, ...(prepareReview ? { mode: 'read', approvalPolicy: 'ask' } : {}) };
    if (this.closed) throw fail('Codeshi is stopping.', 503);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > 100000) throw fail('Enter a message between 1 and 100,000 characters.', 400);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId)) throw fail('Invalid request ID.', 400);
    const accepted = (c.parallelTasks || []).find(task => task.requestId === input.requestId);
    if (accepted) return this.public(accepted);
    const provider = input.provider || c.provider, mode = input.mode || c.mode, approvalPolicy = input.approvalPolicy || c.approvalPolicy || 'ask', model = input.model || null, effort = input.effort || null;
    this.main.checkRunSettings(provider, mode, approvalPolicy);
    this.main.validateSelection(model, 'auto', effort);
    const allowed = this.main.budget.allows(c, provider, model);
    if (!allowed.allowed && !(prepareReview && input.routing)) throw fail(allowed.reason);
    this.main.execution.expect(this.main.execution.defaults(c).revision, input.executionRevision);
    // A part of a split message (#107 stage 2): it names the message's task, whose limits it shares (#87). Flow splitting
    // by itself needs that task's policy to allow children; a split you chose is your own explicit action. A task that is
    // already a part can't split again, as only the workspace chat proposes splits.
    const parent = input.parent && typeof input.parent === 'object' ? input.parent : null;
    if (parent) {
      if (typeof parent.taskId !== 'string' || !parent.execution || parent.execution.taskId !== parent.taskId) throw fail('The child task must name its parent execution policy.');
      if (parent.automatic === true) this.main.execution.assert(c, parent.execution, { action: 'children' });
      else if (!this.main.execution.current(c, parent.taskId)) throw fail('The message this part came from is no longer recorded. Send it again.');
    }
    const policyId = queueExecution?.taskId || randomUUID(); this.main.execution.ensure(c, policyId, { requestId: input.requestId });
    const execution = queueExecution || this.main.execution.token(c, policyId);
    this.main.execution.assert(c, execution, { action: input.routing ? 'routing' : 'manual', ...(prepareReview && input.routing ? {} : { provider, model, effort }) });
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    this.main.attachments.select(attachments);
    // One task to wait for, or several for a plan step that waits for more than one earlier step.
    const dependsOn = Array.isArray(input.dependsOn) ? (input.dependsOn.length ? [...new Set(input.dependsOn)] : null) : input.dependsOn || null;
    for (const id of waitsFor({ dependsOn })) { const before = this.find(c, id); if (['discarded', 'cancelled'].includes(before.status)) throw fail(`“${before.title}” was ${before.status}, so nothing can wait for it.`); }
    const folder = this.plan(c, { ...input, provider, accessMode: mode, approvalPolicy }).folder;
    // Ownership is saved before anything can start, so a crash at any point finds a task it can recover. So is the part a
    // split's repair fixes (src/split-finish.mjs), which says what its copy starts with (before).
    const keeps = board ? keptFiles(input.ignoredFiles) : [];
    const task = { id: policyId, execution, requestId: input.requestId, title: prepareReview ? 'Prepare project review' : line(input.title || text), ...(input.role ? { role: input.role } : {}), ...(plan ? { plan } : {}), ...(board ? { board } : {}), ...(splitRepair ? { splitRepair } : {}), ...(keeps.length ? { ignoredFiles: keeps } : {}), ...(batch ? { batch } : {}), ...(held ? { held: true } : {}),...(prepareReview ? { purpose: 'project-review', workspaceFolders: this.main.workspaceFolders.map(folder => ({ ...folder })) } : {}), text, folderId: folder.id, folderName: folder.displayName || folder.name, folderPath: folder.path, provider, model, effort, accessMode: mode, approvalPolicy, billingConfirmed: input.billingConfirmed === true, attachments, includeHistory: input.includeHistory === true, dependsOn, ...(input.routing ? { routing: input.routing } : {}), ...(parent ? { parentTaskId: parent.taskId, splitId: typeof parent.splitId === 'string' ? parent.splitId : null } : {}), status: 'waiting', reason: 'Starting', createdAt: new Date().toISOString() };
    this.main.record(c, { type: 'parallel_task', task });
    const saved = this.find(c, task.id);
    this.tick(c);
    this.main.emit('update', { conversationId: c.id });
    return this.public(saved);
  }
  // The Plan's own chat (#162): one per workspace, apart from the Workspace chat. Asking about the Plan and drafting cards
  // happen there, in a lane of its own that reads every folder and changes none, so neither chat waits for the other.
  // It opens with no first message, as an idle conversation, and stays; cards it drafts go on the Plan (Board.adoptFrom).
  planChat(c) {
    const saved = c.planChat?.taskId ? (c.parallelTasks || []).find(task => task.id === c.planChat.taskId) : null;
    if (saved && saved.conversationId && this.available(saved) && !['detached', 'lost'].includes(saved.status) && !saved.closed) { this.lane(c, saved); return this.public(saved); }
    if (this.closed) throw fail('Codeshi is stopping.', 503);
    const folder = this.main.workspaceFolders[0];
    if (!folder) throw fail('Add a folder to this workspace first.');
    let identity;
    try { identity = folderIdentity(folder.path); } catch { throw fail(`${folder.displayName || folder.name} is unavailable.`, 404); }
    const id = randomUUID(), requestId = `plan-chat-${id}`;
    this.main.execution.ensure(c, id, { requestId });
    const task = { id, execution: this.main.execution.token(c, id), requestId, title: 'Plan chat', purpose: 'plan-chat', text: 'Plan chat', folderId: folder.id, folderName: folder.displayName || folder.name, folderPath: folder.path, provider: c.provider, model: null, effort: null, accessMode: 'read', approvalPolicy: 'ask', billingConfirmed: false, attachments: [], includeHistory: false, dependsOn: null, status: 'complete', reason: null, mode: 'direct', modeReason: 'Reads the workspace for the Plan', scopePath: identity.real, commonDir: identity.commonDir || null, createdAt: new Date().toISOString() };
    this.main.record(c, { type: 'parallel_task', task });
    const made = this.find(c, id), lane = this.lane(c, made);
    const conversation = lane.broker.get(lane.broker.create().id); lane.c = conversation;
    lane.broker.updateContext(conversation, c.context);
    for (const entry of (c.memory || []).filter(item => item.status === 'active')) lane.broker.record(conversation, { type: 'memory_add', entry });
    if (c.skills?.length) lane.broker.record(conversation, { type: 'skills', skills: c.skills, dirs: c.skillDirs || [] });
    lane.broker.budget.setPolicy(conversation, this.policyFor(c, made));
    lane.broker.record(conversation, { type: 'execution_policy', policy: this.main.execution.current(c, id) });
    this.update(c, made, { conversationId: conversation.id });
    this.main.record(c, { type: 'plan_chat', taskId: id });
    this.main.emit('update', { conversationId: c.id });
    return this.public(made);
  }
  // The Workspace chat's messages since the Plan chat last had them, for the Plan chat's next message to carry: at most
  // the last 20 the first time, then only what's new. Returns null when there is nothing new.
  workspaceSince(c) {
    const said = c.messages.filter(item => ['user', 'assistant'].includes(item.role) && item.text?.trim() && !item.reviewId && !item.rewound && item.status !== 'streaming');
    const after = c.planChat?.syncedThrough ? said.findIndex(item => item.id === c.planChat.syncedThrough) : -1;
    const fresh = (after >= 0 ? said.slice(after + 1) : said).slice(-20);
    return fresh.length ? fresh : null;
  }
  // A queued prompt started now as a task beside the main conversation (#108, first stage). It keeps the agent, model, effort,
  // access and permission setting it was queued with, and leaves the queue only once the task is recorded, so a task that can't
  // start leaves the prompt where it was. Asking twice for the same prompt gets the same task.
  fromQueue(c, input = {}) {
    const requestId = `queue-${input.id}`, accepted = (c.parallelTasks || []).find(task => task.requestId === requestId);
    if (accepted) return this.public(accepted);
    const item = this.main.queue.item(c, input.id);
    const task = this.start(c, { text: item.text, provider: item.provider, model: item.model, effort: item.effort, mode: item.mode, approvalPolicy: item.approvalPolicy, attachments: item.attachments, billingConfirmed: item.billingConfirmed, ...(item.routing ? { routing: item.routing } : {}), folderId: input.folderId, requestId }, { queueExecution: item.execution });
    this.main.queue.act(c, { action: 'remove', id: item.id });
    return task;
  }
  // An approved Orchestrate plan, each step started as its own task (#108). Every step is checked before any is recorded,
  // and the tasks are recorded held, so a plan that can't start starts nothing. A step with an agent you chose gets exactly
  // that agent, model and effort; a step left to Auto in Flow is routed when it starts. Every step gets the conversation's
  // own access and permission setting, never more. Steps wait for the
  // steps they depend on, and Tasks at once and the task limits decide when each starts, as for any task.
  fromPlan(c, plan, input = {}, prompt) {
    const folders = this.main.workspaceFolders, folderId = input.folderId || (folders.length === 1 ? folders[0].id : null);
    if (!folderId || !folders.some(folder => folder.id === folderId)) throw fail('Choose the folder these steps work in.', 400);
    const mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', assignments = input.assignments && typeof input.assignments === 'object' ? input.assignments : {};
    // A step left to Auto is chosen when it starts, as any routed task is (#12): a step that waits for earlier ones may
    // start hours later, when the usage it was shown with no longer holds. It keeps the size the plan gave it.
    const defaults = this.main.execution.defaults(c), routed = Boolean(c.routing) && defaults.automation.routing;
    const chosen = plan.steps.map((step, index) => {
      const pick = assignments[step.id], number = index + 1;
      if (!pick || typeof pick !== 'object' || typeof pick.provider !== 'string') throw fail(`Choose an agent for step ${number}.`, 400);
      const provider = pick.provider, model = pick.model || null, effort = pick.effort || null;
      if (step.agent && (provider !== step.agent.provider || (step.agent.model && model !== step.agent.model) || (step.agent.effort && effort !== step.agent.effort))) throw fail(`Step ${number}’s agent changed. Check the plan again before running it.`);
      this.main.checkRunSettings(provider, mode, approvalPolicy);
      this.main.validateSelection(model, 'auto', effort);
      const allowed = this.main.budget.allows(c, provider, model);
      if (!allowed.allowed) throw fail(`Step ${number}: ${allowed.reason}`);
      const routing = pick.auto === true && !step.agent && routed ? { mode: defaults.routingMode, planned: step.tier, ...(c.routing.allowApi === true ? { allowApi: true } : {}) } : null;
      return { step, number, provider, model, effort, routing };
    });
    // Each attempt has its own request IDs, so a plan that failed to start can be run again; the plan's status stops a double run.
    const ids = {}, made = [], attempt = randomUUID().slice(0, 8);
    try {
      for (const { step, number, provider, model, effort, routing } of chosen) {
        const task = this.start(c, { text: prompt(step, number), title: `${number}. ${step.title}`, ...(step.role ? { role: step.role } : {}), provider, model, effort, ...(routing ? { routing } : {}), mode, approvalPolicy, folderId, requestId: `plan-${plan.id}-${attempt}-${step.id}`, dependsOn: step.dependsOn.map(id => ids[id]), executionRevision: input.executionRevision }, { held: true, plan: { id: plan.id, stepId: step.id, number } });
        ids[step.id] = task.id; made.push(task.id);
      }
    } catch (error) {
      for (const id of made) { const task = this.find(c, id); if (task.status === 'waiting') this.finish(c, task, { status: 'cancelled' }); }
      throw error;
    }
    for (const id of made) this.update(c, this.find(c, id), { held: false, reason: 'Starting' });
    this.tick(c);
    return { tasks: ids, folderId };
  }
  planTasks(c, plan) { return Object.values(plan.tasks || {}).map(id => (c.parallelTasks || []).find(task => task.id === id)).filter(Boolean); }
  // Stopping a plan stops the steps that are working and cancels the ones that haven't started. Steps that finished keep
  // their work: a step in its own copy still waits to be reviewed and merged.
  stopPlan(c, plan) {
    let stopped = 0, cancelled = 0;
    for (const task of this.planTasks(c, plan)) {
      const lane = this.lanes.get(task.id);
      if (lane?.broker.running && lane.c) { if (lane.broker.stop(lane.c.id).stopped) stopped++; }
      else if (task.status === 'waiting') { this.finish(c, task, { status: 'cancelled' }); cancelled++; }
    }
    return { stopped, cancelled };
  }
  // Closing a plan closes all its tasks at once, but only when none is working and nothing is left unmerged.
  closePlan(c, plan) {
    const tasks = this.planTasks(c, plan);
    if (tasks.some(task => this.lanes.get(task.id)?.broker.running || task.status === 'waiting')) throw fail('Stop the plan before closing it.');
    const unmerged = tasks.filter(task => task.mode === 'worktree' && !ENDED.has(task.status) && !['lost', 'detached'].includes(task.status));
    if (unmerged.length) throw fail(`Merge or discard ${unmerged.map(task => `“${task.title}”`).join(', ')} first, so ${unmerged.length === 1 ? 'its changes aren’t' : 'their changes aren’t'} left behind.`);
    for (const task of tasks) if (!task.closed) this.update(c, task, { closed: true });
  }
  tickAll() { for (const c of this.main.conversations.values()) if (c.parallelTasks?.some(task => task.status === 'waiting')) this.tick(c); }
  emptyCopy(c, task) {
    if (task.mode !== 'worktree' || task.status !== 'complete' || working(this.lanes.get(task.id))) return false;
    if (!task.worktree || !task.repoRoot || !fs.existsSync(task.worktree) || !fs.existsSync(task.repoRoot)) return false;
    try { const { plan } = this.planFor(c, task); return !plan.conflicts && plan.files.length === 0; }
    catch { return false; }
  }
  tick(c) {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      for (const task of (c.parallelTasks || []).filter(item => item.status === 'waiting' && !item.held && !this.preparing.has(item.id))) {
        const wait = reason => { if (task.reason !== reason) this.update(c, task, { reason }); };
        if (!this.available(task)) { this.update(c, task, { status: 'detached', reason: `${task.folderName} is no longer in this workspace.` }); continue; }
        // A card whose run has used up its shared limit doesn't start, and nothing waits on it quietly.
        const spent = task.batch && this.runSpent(c, task.batch);
        if (spent) { this.update(c, task, { status: 'cancelled', batchHeld: true, reason: `Not started: ${spent}`, endedAt: new Date().toISOString() }); continue; }
        // A card whose findings are updating the Plan holds the cards after it until you settle the update (src/board.mjs).
        const updating = before => this.main.board?.holdsAfter?.(c, before) || null;
        const needsMerge = before => before.mode === 'worktree' && before.status === 'complete' && !this.emptyCopy(c, before);
        const built = before => before.status === 'integrated' || before.status === 'kept' || (before.status === 'complete' && !needsMerge(before));
        const pending = waitsFor(task).map(id => this.find(c, id)).find(before => !built(before) || gated(before) || updating(before));
        if (pending) {
          // A step that ended without finishing can't be built on, so this one says what it needs instead of waiting quietly.
          const ended = { stopped: 'stopped', failed: 'did not finish', discarded: 'was discarded', cancelled: 'was cancelled', lost: 'lost its copy', detached: 'lost its folder', blocked: 'is blocked' }[pending.status];
          const check = pending.status === 'complete' ? pending.stepCheck : null, mergePending = needsMerge(pending);
          const held = ['complete', 'integrated', 'kept'].includes(pending.status) && !mergePending && !gated(pending) ? updating(pending) : null;
          wait(ended ? `Waiting for “${pending.title}”, which ${ended}. Continue it in its task, or cancel this one.`
            : held ? held
            : check?.status === 'running' ? `Waiting for the tests on “${pending.title}”.`
            : check?.outcome === 'failed' && !check.accepted ? `The tests failed on “${pending.title}”. Fix it in its task, or ${mergePending ? 'merge it anyway' : 'continue anyway from the plan'}.`
            : check?.status === 'interrupted' && !check.accepted ? `The tests on “${pending.title}” were interrupted. Check it again or continue anyway from the plan.`
            : pending.review?.status === 'repairing' ? `Waiting for “${pending.title}” to repair what it found and review again.`
            : reviewHolds(pending) ? `“${pending.title}” found problems it couldn’t settle. Read it, then continue anyway or send cards back.`
            : mergePending ? `Waiting for “${pending.title}” to be merged.` : `Waiting for “${pending.title}”.`);
          continue;
        }
        try { this.admit(c, task); } catch (error) { wait(error.message); continue; }
        let plan;
        try { plan = this.plan(c, { ...task, taskId: task.id }); }
        catch (error) { this.update(c, task, { status: 'failed', reason: error.message }); continue; }
        if (plan.mode === 'wait') { wait(plan.reason); continue; }
        try { this.launch(c, task, plan); }
        catch (error) {
          if (error.status === 409 && /busy|already/i.test(error.message)) wait(error.message);
          else this.update(c, task, { status: 'failed', reason: String(error.message).slice(0, 500) });
        }
      }
    } finally { this.ticking = false; }
  }
  directory(task) { return path.join(this.main.dataDir, 'tasks', task.id); }
  launch(c, task, plan) {
    if (!task.execution) { this.main.execution.ensure(c, task.id, { source: 'legacy-task', config: { mode: task.routing ? 'flow' : 'normal', routingMode: task.routing?.mode } }); this.update(c, task, { execution: this.main.execution.token(c, task.id) }); }
    this.main.execution.assert(c, task.execution, { action: task.routing ? 'routing' : 'manual', ...(task.purpose === 'project-review' && task.routing ? {} : { provider: task.provider, model: task.model, effort: task.effort }) });
    const { identity } = plan, where = { mode: plan.mode, modeReason: plan.reason, commonDir: identity.commonDir || null, ...(identity.git ? { repoRoot: identity.root, prefix: identity.prefix } : {}), ...(plan.uncommitted ? { uncommitted: plan.uncommitted } : {}) };
    if (plan.mode !== 'worktree') { this.update(c, task, { ...where, reason: null, scopePath: identity.real }); this.begin(c, task); return; }
    // A copy left by an interrupted start is kept once the task has a conversation, as its agent may have worked in it, and
    // otherwise made again.
    const target = path.join(this.directory(task), 'worktree'), reuse = task.worktree === target && fs.existsSync(target) && Boolean(task.conversationId || task.setup);
    if (!reuse && fs.existsSync(target)) removeWorktree(identity.root, target, task.id, task.setup?.dependencies);
    // A copy that is kept keeps the count of what it left out, which was worked out without the files it was given (copyFor).
    const place = reuse ? { worktree: target, scopePath: task.scopePath, base: task.base, ...(task.carried ? { uncommitted: task.uncommitted || 0 } : {}) } : this.copyFor(c, task, identity, target);
    if (reuse && task.setup) { this.update(c, task, { ...where, ...place, reason: null }); this.begin(c, task); return; }
    // Installed dependencies are brought into the copy in the background, so the app stays responsive meanwhile.
    this.update(c, task, { ...where, ...place, reason: 'Preparing its copy' });
    const preparing = prepareWorktree(identity, target).catch(() => ({ dependencies: [], missing: [] }));
    this.preparing.set(task.id, preparing);
    preparing.then(setup => {
      this.preparing.delete(task.id);
      // Cancelled meanwhile, or Codeshi is stopping: whatever was brought in goes with the copy.
      if (this.closed || task.status !== 'waiting') { if (ENDED.has(task.status) && fs.existsSync(target)) { try { removeWorktree(identity.root, target, task.id, setup.dependencies); } catch { /* Cleared on the next start. */ } } return; }
      this.update(c, task, { setup, reason: null });
      try { this.begin(c, task); }
      catch (error) {
        if (error.status === 409 && /busy|already/i.test(error.message)) this.update(c, task, { reason: error.message });
        else this.update(c, task, { status: 'failed', reason: String(error.message).slice(0, 500) });
      }
      setImmediate(() => this.tick(c));
    });
  }
  // ---- The work a task builds on
  // A copy is made from the folder's last commit, and merging writes to the folder without committing. So what a task
  // builds on is brought into its copy from the folder (task-isolation.mjs createWorktree), or a card that waits for
  // another would start without that card's files, and a review would have nothing to read.
  // The tasks whose work a task builds on: the ones it waits for, the ones those wait for, and for a Plan card or a
  // split's repair the ones the Plan names (src/board.mjs tasksBefore).
  before(c, task) {
    const all = c.parallelTasks || [], seen = new Set([task.id]), found = [];
    const next = item => [...waitsFor(item), ...(this.main.board?.tasksBefore?.(c, item) || [])];
    for (const queue = next(task); queue.length;) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const other = all.find(item => item.id === id);
      if (other) { found.push(other); queue.push(...next(other)); }
    }
    return found;
  }
  // What that work left in the task's repository, as paths from its top: the files each merged, and what one that worked
  // in the folder itself reported changing. Work in another repository, kept as a branch or not merged yet leaves nothing.
  mergedBefore(c, task, root) {
    const files = new Set();
    for (const other of this.before(c, task)) {
      if (!other.repoRoot || other.repoRoot !== root) continue;
      if (other.status === 'integrated') { for (const file of [...(other.integration?.changes || []).map(item => item?.path), ...(other.integration?.rest || [])]) if (file) files.add(file); continue; }
      if (other.status !== 'complete' || other.mode !== 'direct') continue;
      for (const file of other.stepResult?.files || []) {
        const place = path.relative(root, path.resolve(other.scopePath || root, String(file)));
        if (place && place !== '..' && !place.startsWith(`..${path.sep}`) && !path.isAbsolute(place)) files.add(place.split(path.sep).join('/'));
      }
    }
    return [...files];
  }
  // A new copy with that work in it. carried says how many files came from the folder and which commit the copy was made
  // from, and the folder's other uncommitted changes are counted without them.
  copyFor(c, task, identity, target) {
    const { from, brought: has, ...place } = createWorktree(identity, target, task.id, this.mergedBefore(c, task, identity.root));
    return { ...place, carried: has.length ? { from, files: has.length } : null, ...(has.length ? { uncommitted: uncommittedCount(identity.real, has) } : {}) };
  }
  // The same before a later run in a copy that is already there (refreshWorktree): a review checking again reads the
  // repairs once they're merged. Returns how many files came in, and the base the copy had, to compare the new one with.
  refreshCopy(c, task) {
    const none = { files: 0 };
    if (task.mode !== 'worktree' || ENDED.has(task.status) || task.resolve?.open || !task.worktree || !task.repoRoot || !fs.existsSync(task.worktree) || !fs.existsSync(task.repoRoot)) return none;
    const files = this.mergedBefore(c, task, task.repoRoot);
    if (!files.length) return none;
    const was = task.base, fresh = refreshWorktree({ root: task.repoRoot, worktree: task.worktree, id: task.id, base: was, files });
    if (!fresh.files.length) return none;
    // A folder emptied by what came in goes with it, as in any checkout, but the task still needs its own to work in.
    if (task.scopePath) fs.mkdirSync(task.scopePath, { recursive: true });
    const from = task.carried?.from || was, has = broughtFiles(task.repoRoot, from, fresh.base);
    this.update(c, task, { base: fresh.base, carried: { from, files: has.length }, uncommitted: uncommittedCount(task.folderPath, has) });
    const lane = this.lanes.get(task.id);
    if (lane) lane.broker.guarded = this.guardedFor(task);
    return { files: fresh.files.length, was, base: fresh.base };
  }
  begin(c, task) {
    // A task begins once: saving its setup can wake the queue before this call returns, and a second begin in the same lane
    // would start a second run beside the first and fail the task for it.
    if (task.status !== 'waiting' || this.lanes.get(task.id)?.broker.running) return;
    const lane = this.lane(c, task), first = !task.conversationId;
    if (first) {
      const conversation = lane.broker.get(lane.broker.create().id); lane.c = conversation;
      for (const [provider, transport] of Object.entries(c.transports || {})) {
        if (transport && transport !== 'auto') lane.broker.record(conversation, { type: 'settings', provider, mode: task.accessMode || conversation.mode, approvalPolicy: task.approvalPolicy || conversation.approvalPolicy, model: null, transport });
      }
      if (c.transport && c.transport !== 'auto') {
        lane.broker.record(conversation, { type: 'settings', provider: c.provider, mode: task.accessMode || conversation.mode, approvalPolicy: task.approvalPolicy || conversation.approvalPolicy, model: c.model ?? null, transport: c.transport });
      }
      lane.broker.updateContext(conversation, c.context);
      this.update(c, task, { conversationId: conversation.id });
      for (const entry of (c.memory || []).filter(item => item.status === 'active' && (task.purpose === 'project-review' || !item.folderId || item.folderId === task.folderId))) lane.broker.record(conversation, { type: 'memory_add', entry });
      if (c.skills?.length) lane.broker.record(conversation, { type: 'skills', skills: c.skills, dirs: c.skillDirs || [] });
      lane.broker.budget.setPolicy(conversation, this.policyFor(c, task));
      if (task.includeHistory) for (const message of c.messages.filter(item => ['user', 'assistant'].includes(item.role) && item.text?.trim() && !item.reviewId && !item.rewound).slice(-20)) lane.broker.record(conversation, { type: 'message', message: { id: randomUUID(), role: message.role, text: message.text, provider: message.provider, status: 'complete', createdAt: message.createdAt } });
    }
    if (first) lane.broker.record(lane.c, { type: 'execution_policy', policy: this.main.execution.current(c, task.execution.taskId) });
    // A plan step's brief is written now, not when the plan started (#89): it carries what the steps before it actually did.
    if (first && task.plan) { const brief = this.stepBrief(c, task); if (brief) this.update(c, task, brief); }
    else if (first && task.board) { const brief = this.main.board?.brief(c, task); if (brief) this.update(c, task, brief); }
    // A major card (#155) is split into subtasks first, or carries on from its first unfinished one (src/subtasks.mjs).
    if (task.board && this.main.board?.subtasks.begin(c, task, lane)) { this.sync(c, task); return; }
    // A Reviewer or QA card on Auto prefers an agent other than the ones that built what it checks (#89).
    const avoid = task.routing && task.board ? this.main.board?.reviews.avoid(c, task) || [] : [];
    const role = task.role || task.board?.role || null;
    const input = { text: task.text, ...(role ? { role } : {}), provider: task.provider, model: task.model, effort: task.effort, mode: task.accessMode, approvalPolicy: task.approvalPolicy, attachments: task.attachments, billingConfirmed: task.billingConfirmed, ...(task.routing ? { routing: { ...task.routing, ...(avoid.length ? { avoid } : {}) } } : {}), requestId: `task-${task.id}` };
    if (task.routing) lane.broker.dispatch(lane.c, input, { execution: task.execution }).catch(error => { this.update(c, task, { status: task.preparationCancelled ? 'stopped' : 'failed', reason: String(error.message).slice(0, 500), endedAt: new Date().toISOString() }); });
    else lane.broker.start(lane.c, input, { execution: task.execution });
    this.sync(c, task);
  }
  // carried: the work the task builds on that its copy has from the folder (copyFor), which its agent is told.
  guardedFor(task) {
    const out = [];
    for (const folder of this.main.workspaceFolders) {
      let real; try { real = fs.realpathSync.native(folder.path); } catch { continue; }
      const copy = task.mode === 'worktree' && folder.id === task.folderId && task.scopePath ? task.scopePath : null;
      out.push({ path: real, name: folder.displayName || folder.name || path.basename(real), copy, ...(copy && task.carried?.files ? { carried: { files: task.carried.files, from: task.carried.from, base: task.base } } : {}) });
    }
    return out;
  }
  // Opens a task's lane. It only ever holds the task's own folder, so reopening it after a crash can't widen what it reaches.
  lane(c, task) {
    const open = this.lanes.get(task.id);
    if (open) return open;
    if (!task.scopePath) return null;
    const broker = new this.BrokerClass({ lane: true, workspace: task.scopePath, workspaceFolders: task.purpose === 'project-review' ? task.workspaceFolders : task.purpose === 'plan-chat' ? this.main.workspaceFolders.map(folder => ({ ...folder })) : [{ id: task.folderId, name: task.folderName, path: task.scopePath }], dataDir: path.join(this.directory(task), 'journal'), googleRoot: this.main.googleRoot, bins: this.main.configuredBins, contextPolicy: this.main.contextPolicy, handoffPreferences: this.main.handoff.preferences, verificationCadence: this.main.verificationCadence, contextLimit: this.main.contextLimit, contextRouting: () => c.routing?.mode || null, acquireMutation: operation => ['project-review', 'plan-chat'].includes(task.purpose) ? { release() {}, setProcess() {} } : this.acquireFolders([task.scopePath], `${operation} for “${task.title}”`) });
    if (task.purpose === 'plan-chat') {
      broker.planChat = true; broker.mainConversation = c;
      // The Plan chat only reads, whatever the message box is set to, so it never holds a folder another chat writes to.
      // A draft it returns goes on the Plan, which lives in the Workspace chat's journal.
      for (const name of ['dispatch', 'start']) { const original = broker[name].bind(broker); broker[name] = (laneC, input = {}, ...rest) => original(laneC, { ...input, mode: 'read' }, ...rest); }
      broker.board = { adopt: (laneC, runId) => this.main.board?.adoptFrom(c, broker, laneC, runId) };
    }
    if (task.purpose === 'project-review') {
      // This lane only reads project files; the validated map is saved by ProjectReview. It needs no exclusive writer lease.
      const check = broker.checkRunSettings.bind(broker);
      broker.checkRunSettings = (provider, mode, approvalPolicy) => {
        if (mode !== 'read') throw fail('Project-review preparation only inspects files. Use the main chat to edit the project.');
        return check(provider, mode, approvalPolicy);
      };
    }
    broker.attachments = this.main.attachments; broker.skills.root = this.main.skills.root;
    // The workspace's real folders, which the task can't change: it works in its own copy, or directly in its own folder
    // (which its lane holds, so that one stays open to it). A copy is named, so the agent is told to make a change there.
    broker.guarded = this.guardedFor(task);
    broker.admit = () => this.admit(c, task);
    // A part of a split message counts what the message and its other parts used against the same limits (#87).
    // So does a card in Flow's Run Ready (#132) with the other cards of its run.
    if (task.parentTaskId || task.batch) broker.budget.shared = (laneC, taskId) => taskId === task.id ? this.sharedUsage(c, task) : null;
    const lane = { broker, task, c: task.conversationId ? broker.conversations.get(task.conversationId) : null };
    broker.on('update', () => { if (lane.c) this.main.emit('update', { conversationId: lane.c.id }); this.sync(c, task); });
    broker.on('notify', notice => this.main.emit('notify', { ...notice, conversationId: c.id, taskId: task.id, title: `${task.folderName}: ${notice.title}` }));
    this.lanes.set(task.id, lane);
    return lane;
  }
  // A lane's state, read from the lane, and saved only when it changes.
  sync(c, task) {
    const lane = this.lanes.get(task.id);
    if (!lane?.c || this.closed || ENDED.has(task.status) || ['detached', 'lost', 'blocked'].includes(task.status)) return;
    const status = working(lane) ? 'running' : task.preparationCancelled ? 'stopped' : STOPPED[lane.c.status] || (lane.c.status === 'running' ? 'running' : task.status);
    // A major card's task keeps running from one subtask to the next, or ends paused (#155). How it ended stays, though
    // its last run completed, until someone works in the task again.
    if (task.subtasksEnded) { if (!lane.broker.running) return; this.update(c, task, { subtasksEnded: false }); }
    // A run while the task's conflicts are being resolved in its copy (resolve) is part of that, not one of its subtasks.
    const resolving = Boolean(task.resolve?.open);
    if (status === 'complete' && task.board && task.status === 'running' && !resolving) {
      const next = this.main.board?.subtasks.ended(c, task, lane);
      if (next === 'continue') return;
      if (next?.status) { this.update(c, task, { status: next.status, reason: next.reason, subtasksEnded: true, endedAt: new Date().toISOString() }); setImmediate(() => this.tick(c)); return; }
    }
    const selected = lane.c.activeRun || (status !== 'running' ? lane.c.lastRun : null);
    const provider = selected?.provider || task.provider, model = selected ? selected.model ?? null : task.model, effort = selected ? selected.effort ?? null : task.effort;
    if (status === task.status && provider === task.provider && model === task.model && effort === task.effort) {
      if (task.board && status === 'complete') this.onTask?.(c, task);
      return;
    }
    // A plan step that finishes is checked before anything builds on it, so the hold is saved with the status (#89). Working
    // on it again drops the old result; the next finish checks it afresh.
    const finished = tested(task) && status === 'complete' && task.status !== 'complete', check = finished ? { id: randomUUID().slice(0, 8), status: 'running', at: new Date().toISOString() } : null;
    const spent = (task.parentTaskId || task.batch) && status !== 'running' ? this.budgetUsage(lane.c.taskBudgets?.[task.id], lane.broker.budget) : null;
    // A run that was resolving ends: resolving is finished once no file it was given still has its markers. How the run
    // ended is kept until the task works again, so a Plan card whose resolving stopped stays in Review (board placement).
    const resolve = resolving && status !== 'running' ? { ...task.resolve, open: unfinishedFiles(task.worktree, task.resolve).length > 0, ended: status, endedAt: new Date().toISOString() } : status === 'running' && task.resolve?.ended && !resolving ? { ...task.resolve, ended: null } : null;
    this.update(c, task, { status, reason: null, ...(status === 'running' ? { endedAt: null } : { endedAt: new Date().toISOString() }), ...(spent ? { budgetUsed: { ...spent, running: 0 } } : {}), provider, model, effort, ...(selected?.routing ? { routing: selected.routing } : {}), ...(check ? { stepCheck: check } : tested(task) && status === 'running' && task.stepCheck ? { stepCheck: null } : {}), ...(resolve ? { resolve } : {}) });
    // After resolving, the card's tests run again on the combined result, and what it reported stays its result.
    if (check) this.stepEnded(c, task, check.id, { recheck: resolving, resolved: resolving }).catch(error => console.error('Codeshi could not check a plan step:', error.message));
    if (status !== 'running') setImmediate(() => this.tick(c));
  }

  // ---- Split messages (#107 stage 2)
  // What a part's message and its other parts have used, for the limits they share. A part whose lane is open reads its
  // live record; one that ended before a restart reads the usage saved on its task when it stopped working.
  budgetUsage(state, budget) {
    if (!state) return null;
    const used = budget.used(state);
    return { workingMs: used.workingMs, tokens: used.tokens, spendUSD: used.spendUSD, retries: state.retries, reviews: state.reviews, handoffs: state.handoffs, runsWithoutUsage: state.runsWithoutUsage, runsWithPartialUsage: state.runsWithPartialUsage, runsWithoutCost: state.runsWithoutCost, running: Object.keys(state.active).length };
  }
  // What one task has used, for watching it on the Plan (#162 stage 5). Working time is split into what finished runs took
  // and when the runs still going began, so the page can count the minutes itself instead of being sent a new number on
  // every update. Tokens and spend only change when the agent reports usage.
  usageOf(task, lane = this.lanes.get(task.id)) {
    const state = lane?.c?.taskBudgets?.[task.id];
    if (!state) {
      const saved = task.budgetUsed;
      return saved ? { workedMs: Number(saved.workingMs) || 0, activeSince: null, tokens: Number(saved.tokens) || 0, spendUSD: Number(saved.spendUSD) || 0, retries: saved.retries || 0, reviews: saved.reviews || 0, handoffs: saved.handoffs || 0 } : null;
    }
    const used = lane.broker.budget.used(state), since = Object.values(state.active || {}).map(entry => entry.startedAt).filter(Boolean).sort()[0] || null;
    return { workedMs: state.workingMs || 0, activeSince: since, tokens: used.tokens, spendUSD: used.spendUSD, retries: state.retries || 0, reviews: state.reviews || 0, handoffs: state.handoffs || 0 };
  }
  sharedUsage(c, task) {
    const rows = task.batch ? [] : [this.budgetUsage(c.taskBudgets?.[task.parentTaskId], this.main.budget)];
    const kin = task.batch ? item => item.batch?.id === task.batch.id : item => item.parentTaskId === task.parentTaskId;
    for (const other of (c.parallelTasks || []).filter(item => kin(item) && item.id !== task.id)) rows.push(this.spentBy(other));
    return sum(rows);
  }
  spentBy(task) {
    const lane = this.lanes.get(task.id), state = lane?.c?.taskBudgets?.[task.id];
    return state ? this.budgetUsage(state, lane.broker.budget) : task.budgetUsed || null;
  }

  // ---- Flow's Run Ready (#132)
  // A card in a run with one shared limit works under the workspace's task limits with the run's minutes, tokens and spend
  // in place of the per-task ones; its lane counts the other cards' usage against them.
  policyFor(c, task) {
    const policy = this.main.budget.policy(c);
    return task.batch ? { ...policy, ...task.batch.limits } : policy;
  }
  // Every card of a run together, and the first of its limits they have used up, if any.
  runUsage(c, batchId) {
    const tasks = (c.parallelTasks || []).filter(item => item.batch?.id === batchId);
    return { tasks, used: sum(tasks.map(item => this.spentBy(item))) };
  }
  // The runs still going, for the Plan to show what each has used of its limit.
  runs(c) {
    const ids = [...new Set((c.parallelTasks || []).filter(item => item.batch && ['waiting', 'running'].includes(item.status)).map(item => item.batch.id))];
    return ids.map(id => {
      const { tasks, used } = this.runUsage(c, id), batch = tasks[0].batch;
      // A Flow schedule's prompt is a run with no cards, named by its title.
      return { id, ...(batch.title ? { title: batch.title } : {}), limits: batch.limits, startedAt: batch.startedAt, cards: tasks.map(item => item.board?.cardId).filter(Boolean), running: tasks.filter(item => item.status === 'running').length, waiting: tasks.filter(item => item.status === 'waiting').length, used: { workingMs: used.workingMs, tokens: used.tokens, spendUSD: used.spendUSD } };
    });
  }
  runSpent(c, batch) {
    const { used } = this.runUsage(c, batch.id), limits = batch.limits;
    if (limits.maxWorkingMinutes !== null && used.workingMs >= limits.maxWorkingMinutes * 60000) return `This run has used its ${limits.maxWorkingMinutes} working minutes.`;
    if (limits.maxTokens !== null && used.tokens >= limits.maxTokens) return `This run has used ${used.tokens.toLocaleString('en-US')} tokens, its limit of ${limits.maxTokens.toLocaleString('en-US')}.`;
    if (limits.maxSpendUSD !== null && used.spendUSD >= limits.maxSpendUSD) return `This run has reached its API spending limit of $${limits.maxSpendUSD}.`;
    if (limits.maxTokens !== null && (used.runsWithoutUsage || used.runsWithPartialUsage)) return 'Earlier cards in this run did not report all their token usage, so what is left of its limit is unknown.';
    if (limits.maxSpendUSD !== null && used.runsWithoutCost) return 'Earlier cards in this run did not report their cost, so what is left of its spending limit is unknown.';
    return null;
  }

  // ---- Plan steps (#89): briefs written from what earlier steps did, and each finished step checked before it is built on.
  planOf(c, task) { return task.plan ? (c.orchestrations || []).find(plan => plan.id === task.plan.id) || null : null; }
  // A plan step's plan and step, or a Plan card as its step (#162), with whether anything waits for it.
  stepOf(c, task) {
    if (task.board) { const found = this.main.board?.stepFor(c, task); return { plan: null, step: found?.step || null, dependents: Boolean(found?.dependents) }; }
    const plan = this.planOf(c, task), step = plan?.steps?.find(item => item.id === task.plan.stepId) || null;
    return { plan, step, dependents: Boolean(step && plan.steps.some(other => other.dependsOn.includes(step.id))) };
  }
  stepTask(c, plan, stepId) {
    if (!plan.steps?.some(step => step.id === stepId)) throw fail('Choose a step from this plan.', 400);
    const task = plan.tasks?.[stepId] && (c.parallelTasks || []).find(item => item.id === plan.tasks[stepId]);
    if (!task) throw fail('That step’s task is no longer here.', 404);
    return task;
  }
  // The step's prompt, with each earlier step's report, files and tests, and which version of each it was built on.
  stepBrief(c, task) {
    const { plan, step } = this.stepOf(c, task);
    if (!plan || !step) return null;
    const results = {}, builtOn = {};
    for (const id of step.dependsOn) {
      const before = plan.tasks?.[id] && (c.parallelTasks || []).find(item => item.id === plan.tasks[id]);
      if (!before) continue;
      results[id] = { status: before.status, branch: before.integration?.branch || null, files: before.stepResult?.files || [], summary: before.stepResult?.summary || '', check: before.stepCheck?.status === 'running' ? null : before.stepCheck || null };
      if (before.stepResult?.at) builtOn[id] = before.stepResult.at;
    }
    return { text: stepPrompt(plan, step, task.plan.number, results), builtOn };
  }
  // What a finished step reported and changed, then its tests on its result. A result that arrives after the step was
  // worked on again, or checked again, belongs to an older version and is dropped.
  // resolved: the run that ended resolved a conflict in the card's copy, which can change how many files it would merge.
  async stepEnded(c, task, id, { recheck = false, resolved = false } = {}) {
    const { plan, step, dependents } = this.stepOf(c, task), current = () => !this.closed && task.stepCheck?.id === id;
    if (!step) { if (current()) this.update(c, task, { stepCheck: null }); return; }
    const conversation = this.lanes.get(task.id)?.c, run = conversation?.lastRun;
    let reply = '';
    if (resolved && task.board && task.mode === 'worktree' && task.worktree && fs.existsSync(task.worktree)) { try { const files = this.planFor(c, task).plan.files.length; if (files !== task.copyFiles) this.update(c, task, { copyFiles: files }); } catch { /* Counted again when it's accepted. */ } }
    if (!recheck) {
      const messages = conversation?.messages || [];
      reply = messages.findLast(message => message.role === 'assistant' && message.text?.trim() && (!run || message.runId === run.id))?.text || '';
      // A Plan card in its own copy counts the files the copy really changed, including files changed by shell commands,
      // and one that changed nothing, such as research, needn't be merged (src/board.mjs).
      const strip = file => task.prefix && file.startsWith(`${task.prefix}/`) ? file.slice(task.prefix.length + 1) : file;
      let copyFiles = null, copyPaths = [];
      if ((task.board || task.plan) && task.mode === 'worktree' && task.worktree && fs.existsSync(task.worktree)) { try { copyPaths = this.planFor(c, task).plan.files.map(file => strip(file.path)); copyFiles = copyPaths.length; } catch { /* Counted again when it's accepted. */ } }
      const result = { summary: clip(step.artifact === 'design' ? designSection(reply) || reply : reply, 3000), files: [...new Set([...copyPaths, ...runSteps(messages).files])].slice(0, 20), runId: run?.id || null, at: new Date().toISOString() };
      this.update(c, task, { stepResult: result, ...(copyFiles !== null ? { copyFiles } : {}) });
      if (plan && step.artifact) this.main.record(c, { type: 'orchestration_artifact', id: plan.id, stepId: step.id, kind: step.artifact, content: result.summary, revision: result.runId || id, role: step.role || null });
      if (task.board && step.artifact) this.main.record(c, { type: 'board_card_artifact', cardId: step.id, taskId: task.id, kind: step.artifact, content: result.summary, revision: result.runId || id, role: step.role || null });
    }
    const ran = await this.runStepCheck(c, task);
    if (!current()) return;
    const snapFiles = run && Number.isInteger(conversation?.snapshots?.[run.id]?.files) ? conversation.snapshots[run.id].files : null;
    const filesChanged = Number.isInteger(task.copyFiles) ? Math.max(task.copyFiles, task.stepResult?.files?.length || 0) : snapFiles !== null ? Math.max(snapFiles, task.stepResult?.files?.length || 0) : (task.stepResult?.files?.length ?? null);
    const evaluated = evaluateIntegration({ step, checkResult: ran.result ? { status: ran.result.status, exitCode: ran.result.exitCode } : null, filesChanged });
    // A command that stops at a missing folder or tool never reached the tests: still a failure, but named as the command's.
    const unrunnable = evaluated.outcome === 'failed' && /(cd: [^\n]*No such file or directory|command not found)/.test(String(ran.result?.output || ''));
    const reason = ran.reason && evaluated.outcome === 'unverified' ? ran.reason : ran.result?.status === 'timed-out' ? 'The tests were still running after 10 minutes, so they were stopped.' : evaluated.outcome === 'failed' ? (unrunnable ? `The check command couldn’t run (exit code ${ran.result.exitCode ?? 'none'}): it needs a folder or tool that isn’t in this card’s folder. That’s the command, not the code.` : `Exit code ${ran.result.exitCode ?? 'none'}.`) : evaluated.reason;
    const outcome = { id, status: 'done', outcome: evaluated.outcome, reason, ...(unrunnable ? { unrunnable: true } : {}), ...(ran.command ? { command: ran.command } : {}), ...(ran.result ? { exitCode: ran.result.exitCode ?? null, output: String(ran.result.output || '').slice(-4000) } : {}), at: new Date().toISOString() };
    // A Reviewer or QA card's verdict decides the rest (#89): pass, one repair round, or the cards after it wait for you.
    // Failed tests come first: nothing is repaired on top of them. It is settled before the tests' result is saved, as saving
    // it can wake the queue, and the cards after the review mustn't start in between.
    if (task.board && !recheck && evaluated.outcome !== 'failed') this.main.board?.reviews.ended(c, task, reply);
    this.update(c, task, { stepCheck: outcome });
    if (plan) this.main.record(c, { type: 'orchestration_step_outcome', id: plan.id, stepId: step.id, outcome: evaluated.outcome, status: evaluated.status, reason, ...(ran.command ? { command: ran.command } : {}) });
    if (task.board) {
      this.main.record(c, { type: 'board_card_outcome', cardId: step.id, taskId: task.id, outcome: evaluated.outcome, status: evaluated.status, reason, ...(ran.command ? { command: ran.command } : {}), ...(task.review ? { reviewStatus: task.review.status, reviewVerdict: task.review.verdict ?? null } : {}) });
      if (recheck && evaluated.outcome === 'passed') {
        const boardCard = this.main.board?.cards(c).find(item => item.id === step.id);
        if (boardCard?.needsRecheck || boardCard?.invalidatedBy) this.main.board.update(c, boardCard, { needsRecheck: false, invalidatedBy: null });
      }
    }
    const mergePending = task.mode === 'worktree' && !this.emptyCopy(c, task);
    if (evaluated.outcome === 'failed' && dependents) this.main.message(c, 'system', plan ? `The tests failed on step ${task.plan.number}, “${step.title}”, so the steps after it wait. Fix it in its task, or ${mergePending ? 'merge it anyway' : 'continue anyway from the plan'}.` : `The tests failed on “${step.title}”, so the cards after it wait. Fix it in its task, or ${mergePending ? 'merge it anyway' : 'continue anyway from the Plan'}.`);
    setImmediate(() => this.tick(c));
  }
  // The test command marked in the Run panel, on a temporary copy of the step's result: the folder as it is for a step
  // that worked in place, or the folder with the step's copy merged on top. Neither the folder nor the copy is touched.
  async runStepCheck(c, task) {
    let command = null;
    // A Plan card's own test command (the one on its card) is what tests it; without one, the command marked in Run is.
    const own = task.board ? ownCheck(this.stepOf(c, task).step?.check, task.folderPath) : '';
    if (own) command = { command: own, directory: '' };
    else try { command = this.tests?.saved?.(); } catch { /* No Run panel, no command. */ }
    if (!command?.command) return { reason: task.board ? 'The card has no test command and none is marked in the Run panel, so Codeshi didn’t check it.' : 'No test command is marked in the Run panel, so Codeshi didn’t check this step.' };
    if (!this.main.execution.allows(c, task.execution, { action: 'check', sequence: true })) return { reason: 'This task’s execution policy doesn’t allow automatic checks.' };
    if (!task.repoRoot || !fs.existsSync(task.repoRoot)) return { reason: `${task.folderName} isn’t a Git repository, so its tests can’t run on a separate copy.` };
    if (this.checking.has(task.id)) return { reason: 'Its tests were already running.' };
    let plan = { writes: [] };
    if (task.mode === 'worktree') {
      if (!task.worktree || !fs.existsSync(task.worktree)) return { reason: 'Its working copy is gone.' };
      plan = this.planFor(c, task).plan;
      if (plan.conflicts) return { reason: 'Its changes conflict with the folder, so the tests can’t run until that is resolved.' };
    }
    const abort = new AbortController();
    this.checking.set(task.id, abort); this.main.emit('update', { conversationId: c.id });
    try {
      const result = await checkCombined({ root: task.repoRoot, prefix: task.prefix || '', plan, command: command.command, directory: command.directory || '', target: path.join(this.directory(task), `check-${randomUUID().slice(0, 8)}`), signal: abort.signal });
      // A copy's result is the one the merge review shows, so the tests needn't run twice.
      if (task.mode === 'worktree' && !this.closed) this.update(c, task, { check: { digest: plan.digest, status: result.status, exitCode: result.exitCode, output: result.output, command: command.command, at: new Date().toISOString() } });
      return { command: command.command, result };
    } catch (error) { return { command: command.command, result: { status: 'failed', exitCode: null, output: String(error.message).slice(0, 2000) } }; }
    finally { this.checking.delete(task.id); this.main.emit('update', { conversationId: c.id }); }
  }
  recheckStep(c, plan, stepId) { this.recheckTask(c, this.stepTask(c, plan, stepId)); }
  recheckTask(c, task) {
    if (task.status !== 'complete') throw fail(task.board ? 'Only a card that finished in place can be checked again. One in its own copy is tested when you review it.' : 'Only a finished step can be checked again.');
    if (task.stepCheck?.status === 'running' || this.checking.has(task.id)) throw fail('Its tests are already running.');
    const check = { id: randomUUID().slice(0, 8), status: 'running', at: new Date().toISOString() };
    this.update(c, task, { stepCheck: check });
    this.stepEnded(c, task, check.id, { recheck: true }).catch(error => console.error('Codeshi could not check a plan step:', error.message));
  }
  // Building on a step whose tests failed, or were interrupted, is your call, and it is recorded as yours.
  continueStep(c, plan, stepId) {
    const task = this.stepTask(c, plan, stepId), check = task.stepCheck;
    this.continueTask(c, task);
    this.main.record(c, { type: 'orchestration_step_outcome', id: plan.id, stepId, outcome: check.outcome || 'unverified', status: 'accepted', reason: check.status === 'interrupted' ? 'You chose to continue without the tests.' : 'You chose to continue past the failed tests.', accepted: true, ...(check.command ? { command: check.command } : {}) });
  }
  continueTask(c, task) {
    // A review's findings you've read, and decided to build on anyway (#89).
    if (task.board && task.status === 'complete' && reviewHolds(task) && !(task.stepCheck && (task.stepCheck.outcome === 'failed' || task.stepCheck.status === 'interrupted') && !task.stepCheck.accepted)) {
      this.main.board.reviews.accept(c, task);
      this.main.record(c, { type: 'board_card_outcome', cardId: task.board.cardId, taskId: task.id, outcome: task.stepCheck?.outcome || 'passed', status: 'accepted', reason: 'You read the review findings and chose to continue anyway.', accepted: true });
      this.tick(c); return;
    }
    const check = task.stepCheck;
    if (task.status !== 'complete' || !check || !(check.outcome === 'failed' || check.status === 'interrupted') || check.accepted) throw fail(task.board ? 'Nothing is holding the cards after this one.' : 'Nothing is holding the steps after this one.');
    this.update(c, task, { stepCheck: { ...check, accepted: true, acceptedAt: new Date().toISOString() } });
    if (task.board) this.main.record(c, { type: 'board_card_outcome', cardId: task.board.cardId, taskId: task.id, outcome: check.outcome || 'unverified', status: 'accepted', reason: check.status === 'interrupted' ? 'You chose to continue without the tests.' : 'You chose to continue past the failed tests.', accepted: true, ...(check.command ? { command: check.command } : {}) });
    this.tick(c);
  }
  // After a restart. Whatever a lane was doing ended with the app, so its run is marked interrupted by its own journal, and
  // what was waiting waits for the person, as the queue does. Each lane still holds only its own folder.
  restore() {
    for (const { c, task } of this.all()) {
      if (ENDED.has(task.status)) continue;
      // Tests that were running on a plan step ended with the app: that isn't evidence either way, so the steps after it wait.
      if (task.stepCheck?.status === 'running') this.update(c, task, { stepCheck: { ...task.stepCheck, status: 'interrupted', outcome: 'unverified', reason: 'Codeshi closed while the tests were running.' } });
      if (!this.available(task) && !['detached', 'lost'].includes(task.status)) { this.update(c, task, { status: 'detached', reason: `${task.folderName} is no longer in this workspace. Its history stays, and it can't run.` }); continue; }
      if (task.mode === 'worktree' && !fs.existsSync(task.worktree)) { if (task.status !== 'lost') this.update(c, task, { status: 'lost', reason: 'Its working copy is gone, so there is nothing to merge. Its history stays.' }); continue; }
      if (task.status === 'waiting') { if (!task.held) this.update(c, task, { held: true, reason: 'Codeshi restarted. Start it when you’re ready.' }); continue; }
      if (task.status !== 'running' && task.status !== 'blocked') continue;
      try { this.lane(c, task); this.update(c, task, { status: 'stopped', reason: null, endedAt: new Date().toISOString(), ...(task.resolve?.open && task.status === 'running' ? { resolve: { ...task.resolve, ended: 'stopped' } } : {}) }); }
      catch (error) { this.update(c, task, { status: 'blocked', reason: String(error.message).slice(0, 500) }); }
    }
  }

  public(task) {
    const lane = this.lanes.get(task.id), { text, attachments, requestId, folderPath, commonDir, repoRoot, preparationSource, workspaceFolders, resolve, integration, ...shown } = task;
    const active = lane?.c?.activeRun;
    const runningProvider = (lane?.broker?.running && active?.provider) || (task.status === "running" && (active?.provider || lane?.c?.provider || task.provider)) || null;
    // The page gets each saved file without its diff, and not the names kept past those (integrate).
    const { rest, ...merged } = integration || {};
    const publicIntegration = integration ? {
      ...merged,
      ...(Array.isArray(integration.changes) ? { changes: integration.changes.map(({ diff, ...meta }) => meta) } : {}),
    } : undefined;
    return {
      ...shown,
      ...(publicIntegration ? { integration: publicIntegration } : {}),
      // Whether an agent is resolving its conflicts, and with how many files; the commits behind it stay here.
      resolving: resolve ? { open: Boolean(resolve.open), files: resolve.files.length } : null,
      runningProvider,
      runningModel: active?.model || null,
      runningEffort: (runningProvider && active?.effort) || null,
      runningPhase: active?.phase || null,
      runningStep: active?.plan?.steps?.find(s => s.status === "active")?.text || null,
      usage: this.usageOf(task, lane),
      approvals: lane?.broker.pendingCount() || 0,
      testing: this.checking.has(task.id),
      hasWorktree: Boolean(task.worktree) && !ENDED.has(task.status)
    };
  }
  // A Plan card's task says where its card is, so a summary of the Plan's tasks knows which still need you. A split's parts,
  // while Flow finishes them by itself, are marked managed, which keeps them out of Tasks unless they need you.
  list(c) {
    return (c.parallelTasks || []).filter(task => !task.closed).map(task => {
      const shown = { ...this.public(task), ...(task.splitId && this.main.splits?.finisher?.manages(c, task.splitId) ? { managed: true } : {}) }, card = task.board && this.main.board?.cards?.(c).find(item => item.id === task.board.cardId);
      return card ? { ...shown, cardColumn: card.task === task.id ? card.column : null } : shown;
    });
  }
  // One task's conversation, as the page shows it. Undo works on the real folders from the main conversation, so a lane doesn't offer it.
  view(c, id, options) {
    const task = this.find(c, id), lane = this.lane(c, task);
    if (!lane?.c) return { execution: { defaults: this.main.execution.defaults(c), active: this.main.execution.current(c, task.execution?.taskId), policies: [] }, id: null, messages: [], status: task.status, queue: [], runs: [], task: this.public(task), parallelTasks: this.list(c), checkpoints: {} };
    // The Plan's revision and suggestion come along, so the Plan beside a task's chat, such as the Plan chat (#162), stays current.
    return { ...lane.broker.view(lane.c, options), task: this.public(task), parallelTasks: this.list(c), checkpoints: {}, boardRevision: c.boardRevision || 0, boardSuggest: c.boardSuggest ? (({ pid, pidStart, answers, ...rest }) => ({ ...rest, ...(answers ? { answered: true } : {}) }))(c.boardSuggest) : null, boardSplits: (c.boardSplits || []).map(({ pid, pidStart, ...rest }) => rest) };
  }

  // A task's own changes, reviewed by another agent from inside the task (#88). The reviewer reads a copy of the files the
  // person chose from the task's folder, or from its own copy, never the rest of the workspace. The review is saved in the
  // task's conversation and counts against the task's limits and the workspace's tasks at once.
  reviewScope(c, id) {
    const task = this.find(c, id);
    if (task.purpose === 'project-review') throw fail('This task only prepares the app review, so it has no changes to review.');
    if (task.purpose === 'plan-chat') throw fail('The Plan chat only reads the workspace, so it has no changes to review.');
    if (ENDED.has(task.status)) throw fail(task.status === 'cancelled' ? 'This task never started, so it has no changes to review.' : 'This task has ended and its copy is gone. Review its changes from the workspace chat.');
    if (!this.available(task) || task.status === 'detached') throw fail(`${task.folderName} is no longer in this workspace, so this task’s changes can’t be reviewed.`);
    if (task.mode === 'worktree' && (!task.worktree || !fs.existsSync(task.worktree))) throw fail('This task’s working copy is gone, so there is nothing to review.');
    const lane = this.lane(c, task);
    if (!lane?.c) throw fail('This task hasn’t started yet, so it has no changes to review.');
    // A copy is compared with the commit it started from (src/agent-review.mjs).
    const folders = lane.broker.workspaceFolders.map(folder => task.mode === 'worktree' ? { ...folder, base: task.base } : folder);
    return { task, lane, project: { id: `task:${task.id}`, folders } };
  }

  executionPolicy(c, id, input) {
    const task = this.find(c, id), lane = this.lanes.get(task.id);
    const broker = lane?.c ? lane.broker : this.main, conversation = lane?.c || c;
    if (!task.execution) throw fail('Refresh this task after its legacy policy has been restored.');
    return broker.execution.change(conversation, { ...input, taskId: task.execution.taskId });
  }
  // Flow ended while this task worked on Flow's say-so (src/board.mjs flowEnded): it carries on as a task you started in
  // Normal, with the agent it's on. Its run finishes, and its tests, its review and its next subtask go on as for any card,
  // but Flow decides nothing more for it: no handoff near a limit, no wait for a reset and no choosing an agent. Its own
  // conversation is taken over first, which revokes what its run left pending (src/execution-policy.mjs change). The
  // workspace's record of the policy and the task's token follow it, as the card's tests and review check that token.
  // A run still starting, while Flow chooses its agent or before its agent's process is up, starts first, as a run already
  // going would, and the task is taken over then: a start checks the policy once more just before the process, so a
  // takeover in between would only fail the card. Once the process is up, the run has passed that check.
  // Only a task with something going is taken over: one working, or with its lane open, as every task that worked or was
  // looked at since Codeshi started has. One that finished before has nothing of Flow's pending, so it isn't opened for this.
  leaveFlow(c, task) {
    const id = task.execution?.taskId, policy = id ? this.main.execution.current(c, id) : null;
    if (!policy || policy.mode !== 'flow' || ENDED.has(task.status) || ['lost', 'detached'].includes(task.status)) return false;
    const open = this.lanes.get(task.id);
    if (!open && !['running', 'blocked'].includes(task.status)) return false;
    const lane = open || (task.conversationId ? this.lane(c, task) : null);
    if (lane && !lane.c) lane.c = lane.broker.conversations.get(task.conversationId) || null;
    const starting = lane?.broker.running;
    if (starting && (starting.purpose === 'routing' || !starting.child)) {
      setTimeout(() => { if (this.closed) return; try { this.leaveFlow(c, task); } catch (error) { console.error('Codeshi could not take a task over from Flow:', error.message); } }, 100).unref?.();
      return true;
    }
    const own = lane?.c ? lane.broker.execution.current(lane.c, id) : null;
    if (own?.mode === 'flow') lane.broker.execution.change(lane.c, { taskId: id, revision: own.revision, action: 'takeover' });
    const after = own ? lane.broker.execution.current(lane.c, id) : null;
    const next = after?.mode === 'normal' ? after : { ...executionConfig({ ...policy, mode: 'normal', override: null }), taskId: id, revision: Math.max(policy.revision, own?.revision || 0) + 1, authorization: { source: 'manual-takeover', at: new Date().toISOString() } };
    if (lane?.c && !after) lane.broker.record(lane.c, { type: 'execution_policy', policy: next });
    this.main.record(c, { type: 'execution_policy', policy: next });
    this.update(c, task, { execution: { taskId: id, revision: next.revision } });
    return true;
  }

  // Reading a file or diff associated with a task, whether from its active copy, kept branch, saved merge record or the merged folder.
  previewFile(c, id, folder, relative) {
    const task = this.find(c, id);
    const targetFolder = folder || this.main.workspaceFolders.find(item => item.id === task.folderId);
    if (!targetFolder) throw fail('That folder is no longer in this workspace.', 404);
    if (!relative) throw fail('Choose a file.', 400);
    const readFrom = target => {
      try { return readExplorerFile(target, relative); }
      catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail('File not found.', 404);
        throw error;
      }
    };
    if (task.mode !== 'worktree') return readFrom(targetFolder);
    const copyPath = task.scopePath || task.worktree;
    if (!ENDED.has(task.status) && copyPath && fs.existsSync(copyPath)) {
      const realCopy = fs.realpathSync.native(copyPath);
      return { ...readFrom({ id: targetFolder.id, path: realCopy }), taskId: task.id, inCopy: true, folderName: targetFolder.displayName || targetFolder.name };
    }
    if (task.status === 'integrated') return { ...readFrom(targetFolder), folderName: targetFolder.displayName || targetFolder.name };
    if (task.status === 'kept' && task.integration?.branch) {
      validateRelativePath(relative);
      const repoPath = task.prefix ? `${task.prefix}/${relative}` : relative;
      const repoRoot = task.repoRoot && fs.existsSync(task.repoRoot) ? task.repoRoot : targetFolder.path;
      const tree = git(repoRoot, ['ls-tree', task.integration.branch, '--', repoPath]);
      const line = tree.status === 0 ? tree.stdout.trim().split('\n')[0] || '' : '';
      const mode = line.split(' ')[0];
      if (!line || !['100644', '100755'].includes(mode)) throw fail(`File not found in branch ${task.integration.branch}.`, 404);
      const blob = git(repoRoot, ['cat-file', 'blob', `${task.integration.branch}:${repoPath}`], { encoding: 'buffer' });
      if (blob.error || blob.status !== 0) throw fail(`Could not read ${relative} from branch ${task.integration.branch}.`, 404);
      const contents = blob.stdout;
      if (contents.length > attachmentLimits.imageBytes) throw fail('Preview supports images up to 5 MB and text/code up to 64 KB.', 413);
      const { text, ...meta } = inspectAttachment(path.basename(relative), contents);
      return { ...meta, folderId: targetFolder.id, path: relative, data: contents.toString('base64'), ...(meta.kind === 'text' ? { text } : {}), folderName: targetFolder.displayName || targetFolder.name, branch: task.integration.branch };
    }
    if (task.status === 'discarded') throw fail('This task’s changes were discarded, so its working copy is gone.', 404);
    throw fail('This task’s working copy is gone.', 404);
  }
  fileDiff(c, id, folder, relative) {
    const task = this.find(c, id);
    const targetFolder = folder || this.main.workspaceFolders.find(item => item.id === task.folderId);
    if (!targetFolder) throw fail('That folder is no longer in this workspace.', 404);
    if (!relative) throw fail('Choose a file.', 400);
    validateRelativePath(relative);
    const repoPath = task.prefix ? `${task.prefix}/${relative}` : relative;
    const saved = (task.integration?.changes || []).find(item => item.path === repoPath || item.path === relative);
    if (saved?.diff) {
      return {
        folderId: targetFolder.id,
        folderName: targetFolder.displayName || targetFolder.name,
        path: relative,
        code: saved.change === 'add' ? ' A' : saved.change === 'delete' ? ' D' : ' M',
        diff: saved.diff,
        truncated: false,
        status: saved.change === 'add' ? 'added' : saved.change === 'delete' ? 'deleted' : 'modified',
      };
    }
    const copyPath = task.scopePath || task.worktree;
    if (task.mode === 'worktree' && !ENDED.has(task.status) && task.worktree && fs.existsSync(copyPath)) {
      const realWorktree = fs.realpathSync.native(task.worktree);
      const wtFolder = { id: targetFolder.id, path: realWorktree };
      try {
        const current = workspaceGitDiff(wtFolder, repoPath);
        if (current?.diff) return { ...current, path: relative, folderName: targetFolder.displayName || targetFolder.name };
      } catch { /* Check diff against task.base below. */ }
      if (task.base) {
        const diffRes = git(realWorktree, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', task.base, '--', repoPath]);
        if (diffRes.status === 0 && diffRes.stdout) {
          const limit = 400 * 1024;
          return {
            folderId: targetFolder.id,
            folderName: targetFolder.displayName || targetFolder.name,
            path: relative,
            code: ' M',
            diff: diffRes.stdout.slice(0, limit),
            truncated: diffRes.stdout.length > limit,
          };
        }
      }
      throw fail('This file has no current changes in this task’s copy.', 404);
    }
    if (task.mode !== 'worktree' || task.status === 'integrated') {
      return workspaceGitDiff(targetFolder, task.prefix ? repoPath : relative);
    }
    throw fail(task.status === 'discarded' ? 'This task’s changes were discarded, so its working copy is gone.' : 'This file has no saved diff for this task.', 404);
  }

  // ---- Coming back: a worktree task's changes against the folder as it is now.
  reviewable(c, id) {
    const task = this.find(c, id);
    if (task.mode !== 'worktree' || ENDED.has(task.status)) throw fail('This task has nothing to merge.');
    if (this.lanes.get(task.id)?.broker.running) throw fail('Wait for this task to finish, or stop it, before merging.');
    if (!fs.existsSync(task.worktree)) throw fail('This task’s working copy is gone, so there is nothing to merge.');
    if (!fs.existsSync(task.repoRoot)) throw fail(`${task.folderName} is unavailable, so nothing can be merged into it.`);
    return task;
  }
  planFor(c, task) { const result = snapshotWorktree(task.worktree, task.id, brought(task)); return { result, plan: integrationPlan({ root: task.repoRoot, prefix: task.prefix, base: task.base, result, pending: task.resolve || null }) }; }
  review(c, id) {
    const task = this.reviewable(c, id), { result, plan } = this.planFor(c, task);
    if (result !== task.result) this.update(c, task, { result });
    const command = this.tests?.saved?.(), check = task.check?.digest === plan.digest ? task.check : null;
    return { files: plan.files, digest: plan.digest, conflicts: plan.conflicts, check, canCheck: Boolean(command?.command), testCommand: command?.command || null, testing: this.checking.has(task.id), folder: task.folderName, resolve: this.resolvable(task, plan), task: this.public(task) };
  }
  // Whether the task's own agent can settle its conflicts in its copy, or why not, and how far resolving has got:
  // files still marked, and files it combined.
  resolvable(task, plan) {
    const conflicts = plan.files.filter(file => file.status === 'conflict'), stuck = conflicts.filter(file => !RESOLVABLE.has(file.kind));
    const which = { binary: 'isn’t text on both sides', outside: 'is outside this task’s folder', link: 'is a link or a submodule' }[stuck[0]?.kind] || 'isn’t a plain file here';
    const why = !conflicts.length ? null
      : stuck.length ? (stuck.length === 1 ? `${stuck[0].path} ${which}, so an agent can’t combine it.` : `${stuck.length} files can’t be combined by an agent, such as ${stuck[0].path}, which ${which}.`)
      : task.accessMode !== 'edit' ? 'This task’s agent only reads files, so it can’t combine them in its copy.'
      : !task.conversationId ? 'This task has no conversation for an agent to work in.' : null;
    return { can: conflicts.length > 0 && !why, ...(why ? { why } : {}), provider: task.provider, model: task.model || null, unresolved: conflicts.filter(file => file.kind === 'unresolved').length, combined: plan.files.filter(file => file.resolved && file.status !== 'conflict').length };
  }
  // ---- Resolving conflicts with an agent, in the task's own copy and never the folder (task-isolation.mjs
  // prepareResolution). The agent that made the changes, in its own conversation, combines both sides where they fit and
  // asks you where they really disagree. Any run in the task while a file it was given still has markers is part of it.
  // The review afterwards shows the combined result against the folder, and you still merge.
  resolve(c, id, { digest } = {}) {
    const task = this.reviewable(c, id);
    if (this.checking.has(task.id)) throw fail('Its tests are running on the combined result. Wait for them to finish.');
    const { plan: seen } = this.planFor(c, task);
    if (seen.digest !== digest) throw fail('The changes moved since you reviewed them. Review them again.');
    const can = this.resolvable(task, seen);
    if (!can.can) throw fail(can.why || 'Nothing conflicts now. Review it again to merge.');
    const lane = this.lane(c, task);
    if (!lane?.c) throw fail('This task’s conversation is gone, so no agent can work in its copy. Keep it as a branch to merge by hand.');
    // What would stop the run is checked before the copy changes: an agent that can't run here, or a full workspace.
    this.main.checkRunSettings(task.provider, task.accessMode, task.approvalPolicy);
    this.admit(c, task);
    const earlier = task.resolve || null, labels = markerLabels(task.folderName), where = { root: task.repoRoot, worktree: task.worktree, id: task.id };
    // Files an earlier try left marked start again from where it began.
    const left = earlier ? unfinishedFiles(task.worktree, earlier) : [];
    if (left.length) this.update(c, task, { base: restoreResolution({ ...where, base: task.base, before: earlier.before, from: earlier.from, files: left }) });
    const from = task.base, { result, plan } = this.planFor(c, task);
    let prepared;
    try { prepared = prepareResolution({ ...where, base: from, result, plan, labels }); }
    catch (error) { if (earlier?.open) this.update(c, task, { resolve: { ...earlier, open: unfinishedFiles(task.worktree, earlier).length > 0 } }); throw error; }
    const marked = prepared.files.filter(file => file.conflicts > 0);
    const known = { ...earlier?.known };
    for (const file of prepared.files) { if (file.known) known[file.path] = file.known; else delete known[file.path]; }
    this.update(c, task, { base: prepared.base, resolve: { files: [...new Set([...(earlier?.files || []), ...prepared.files.map(file => file.path)])], labels, ...(Object.keys(known).length ? { known } : {}), from, before: result, open: marked.length > 0, at: new Date().toISOString() } });
    // Git combined everything itself, so there is nothing to ask an agent.
    if (!marked.length) return { started: false, files: 0, task: this.public(task) };
    try {
      const run = lane.broker.start(lane.c, { text: resolvePrompt({ folder: task.folderName, card: Boolean(task.board), prefix: task.prefix || '', files: marked, labels }), provider: task.provider, model: task.model, effort: task.effort, mode: task.accessMode, approvalPolicy: task.approvalPolicy, billingConfirmed: task.billingConfirmed, requestId: `resolve-${task.id}-${randomUUID().slice(0, 6)}` }, { execution: task.execution });
      this.update(c, task, { resolve: { ...task.resolve, runId: run.runId } });
    } catch (error) {
      // Nothing started, so the copy and what it's compared with go back to how they were.
      try { this.update(c, task, { base: restoreResolution({ ...where, base: task.base, before: result, from, files: prepared.files.map(file => file.path) }), resolve: earlier ? { ...earlier, open: false } : null }); }
      catch (undo) { console.error('Codeshi could not put a task’s copy back after resolving failed to start:', undo.message); }
      throw error;
    }
    this.sync(c, task);
    return { started: true, files: marked.length, task: this.public(task) };
  }
  async check(c, id, { digest } = {}) {
    const task = this.reviewable(c, id), command = this.tests?.saved?.();
    if (!command?.command) throw fail('Mark a test command in the Run panel first.');
    if (this.checking.has(task.id)) throw fail('These tests are already running.');
    const { plan } = this.planFor(c, task);
    if (plan.digest !== digest) throw fail('The changes moved since you reviewed them. Review them again.');
    if (plan.conflicts) throw fail('Resolve the conflicts first. The tests can only run on a result that can be merged.');
    const abort = new AbortController(), running = checkCombined({ root: task.repoRoot, prefix: task.prefix, plan, command: command.command, directory: command.directory || '', target: path.join(this.directory(task), `check-${randomUUID().slice(0, 8)}`), signal: abort.signal });
    this.checking.set(task.id, abort); this.main.emit('update', { conversationId: c.id });
    try {
      const result = await running, check = { digest, status: result.status, exitCode: result.exitCode, output: result.output, command: command.command, at: new Date().toISOString() };
      this.update(c, task, { check });
      return check;
    } finally { this.checking.delete(task.id); this.main.emit('update', { conversationId: c.id }); }
  }
  // Under a lease on this folder, so no run, patch or undo can change it meanwhile. The plan is worked out again inside it,
  // and anything different from what was reviewed stops the merge.
  // Flow merging a split's part by itself (src/split-finish.mjs) is quiet: it answers once for the whole message.
  integrate(c, id, { digest, acceptFailedCheck = false, quiet = false } = {}) {
    const task = this.reviewable(c, id);
    return this.withFolders([task.folderPath], 'merging a task', async () => {
      const { plan } = this.planFor(c, task);
      if (plan.digest !== digest) throw fail('The changes moved since you reviewed them. Review them again.');
      if (plan.conflicts) throw fail(`${plan.conflicts} file${plan.conflicts === 1 ? ' conflicts' : 's conflict'}, so nothing was merged and both versions are safe. Keep it as a branch to merge by hand.`);
      if (task.check?.digest === digest && task.check.status !== 'passed' && acceptFailedCheck !== true) throw fail('The tests failed on the combined result. Confirm to merge anyway.');
      applyPlan(task.repoRoot, plan);
      const count = plan.writes.length, changes = integrationChanges(plan.files);
      if (!quiet) this.main.message(c, 'system', count ? `Merged “${task.title}” into ${task.folderName}: ${count} file${count === 1 ? '' : 's'}.` : `“${task.title}” had nothing left to merge into ${task.folderName}.`);
      // Past the files saved with their diffs, the names alone are kept, so work that builds on this starts with them all (mergedBefore).
      this.finish(c, task, { status: 'integrated', integration: { files: count, at: new Date().toISOString(), changes, ...(plan.files.length > changes.length ? { totalFiles: plan.files.length, rest: plan.files.slice(changes.length, changes.length + MAX_INTEGRATION_REST).map(file => file.path) } : {}) } });
      if (count) noteActivity('merges');
      return { merged: count, task: this.public(task) };
    });
  }
  // Leaves both sides as they are and gives the person the task's work as an ordinary branch.
  keep(c, id) {
    const task = this.reviewable(c, id);
    // Files still marked from resolving go back to the task's own version first, so the branch holds its work, not markers.
    const left = task.resolve?.open ? unfinishedFiles(task.worktree, task.resolve) : [];
    if (left.length) this.update(c, task, { base: restoreResolution({ root: task.repoRoot, worktree: task.worktree, id: task.id, base: task.base, before: task.resolve.before, from: task.resolve.from, files: left }), resolve: { ...task.resolve, open: false } });
    const result = snapshotWorktree(task.worktree, task.id, brought(task)), branch = keepBranch(task.repoRoot, result, task.title, task.id);
    let changes = [], totalFiles = 0;
    try { const plan = integrationPlan({ root: task.repoRoot, prefix: task.prefix, base: task.base, result, pending: null }); totalFiles = plan.files.length; changes = integrationChanges(plan.files); } catch { /* Branch is saved; file summary unavailable. */ }
    this.main.message(c, 'system', `“${task.title}” is kept as the branch ${branch}. Nothing was merged into ${task.folderName}.`);
    this.finish(c, task, { status: 'kept', integration: { branch, files: totalFiles, at: new Date().toISOString(), changes, ...(totalFiles > changes.length ? { totalFiles } : {}) } });
    return { branch, task: this.public(task) };
  }
  discard(c, id) {
    const task = this.find(c, id);
    if (this.lanes.get(task.id)?.broker.running) throw fail('Stop this task before discarding it.');
    if (task.status === 'waiting') { this.finish(c, task, { status: 'cancelled', reason: null }); return { task: this.public(task) }; }
    if (task.mode !== 'worktree') throw fail('This task worked directly in the folder, so there is no separate copy to discard.');
    this.finish(c, task, { status: 'discarded' });
    return { task: this.public(task) };
  }
  // Ending a task frees its working copy. The conversation stays, so what it did can still be read.
  finish(c, task, changes) {
    const lane = this.lanes.get(task.id);
    // A reason given here is kept, such as why a card's task never started (src/board.mjs flowEnded).
    this.update(c, task, { reason: null, ...changes, endedAt: task.endedAt || new Date().toISOString() });
    // A copy still being prepared is removed once that ends, so nothing is deleted from under it.
    if (task.worktree && task.repoRoot && fs.existsSync(task.repoRoot) && !this.preparing.has(task.id)) { try { removeWorktree(task.repoRoot, task.worktree, task.id, task.setup?.dependencies); } catch (error) { console.error('Codeshi could not remove a task’s working copy:', error.message); } }
    // Prompts queued in it go no further: what they would have worked on has gone.
    if (lane?.c?.queue.length && !lane.c.queuePaused) lane.broker.queue.pause(lane.c, 'This task has ended.');
    setImmediate(() => this.tick(c));
  }
  resumeWaiting(c, id) { const task = this.find(c, id); if (task.status !== 'waiting') throw fail('This task isn’t waiting.'); this.update(c, task, { held: false }); this.tick(c); return this.public(task); }
  closeTask(c, id) { const task = this.find(c, id); if (this.lanes.get(task.id)?.broker.running || task.status === 'waiting') throw fail('Stop this task before closing it.'); if (task.mode === 'worktree' && !ENDED.has(task.status) && !['lost', 'detached'].includes(task.status)) throw fail('Merge or discard this task’s changes first, so they aren’t left behind.'); this.update(c, task, { closed: true }); return { closed: true }; }

  // Every lane's tasks with the main conversation's, for the Tasks panel.
  async ledgers(options = {}) {
    const lists = await Promise.all(this.all().filter(({ task }) => task.conversationId).map(async ({ task }) => {
      const ledger = await readLedger(path.join(this.directory(task), 'journal', `${task.conversationId}.jsonl`), options);
      // A Plan card counts toward its group's total (#162), as a plan step counts toward its plan's.
      return ledger.tasks.map(item => ({ ...item, parallelTask: task.id, folder: task.folderName, ...(task.role || task.board?.role ? { role: task.role || task.board.role } : {}), ...(task.board?.files?.length ? { scopeFiles: task.board.files.length } : {}), ...(task.plan ? { plan: { id: task.plan.id, part: 'step', stepId: task.plan.stepId, number: task.plan.number } } : task.board ? { plan: { id: task.board.group ? `group:${task.board.group}` : `board:${task.board.run || task.board.cardId}`, part: 'step', stepId: task.board.cardId } } : {}) }));
    }));
    return lists.flat();
  }
  async close() {
    this.closed = true;
    for (const abort of this.checking.values()) abort.abort();
    await Promise.allSettled([...this.lanes.values()].map(lane => lane.broker.close()));
  }
}

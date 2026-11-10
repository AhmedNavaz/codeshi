import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readLedger } from './task-ledger.mjs';
import { applyPlan, checkCombined, createWorktree, folderIdentity, integrationPlan, keepBranch, planIsolation, prepareWorktree, removeWorktree, snapshotWorktree, uncommittedCount, unrestricted } from './task-isolation.mjs';

// Independent tasks in one workspace (#88). Each task is a lane: a broker of its own, scoped to one folder, with its own
// journal, native sessions, approvals, queue and Stop. A late event can't reach the wrong task, because a lane has no other
// task to reach. The main conversation's journal records who owns what before anything starts, so a crash can always be
// recovered from, and the coordinator decides how each lane may run (see task-isolation.mjs).
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const ENDED = new Set(['integrated', 'kept', 'discarded', 'cancelled']);
const STOPPED = { complete: 'complete', interrupted: 'stopped', incomplete: 'failed' };
// The tasks one waits for: none, one (as a task started by hand saves it) or several (a plan step after more than one step).
const waitsFor = task => task.dependsOn ? [].concat(task.dependsOn) : [];
// The dependency folders brought into a task's copy, which never become part of its changes.
const brought = task => (task.setup?.dependencies || []).map(item => item.path);
const line = text => { const first = String(text || '').trim().split('\n')[0]; return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first; };

export class TaskCoordinator {
  constructor(main, { BrokerClass, acquireFolders = () => ({ release() {}, setProcess() {} }), withFolders = async (paths, operation, work) => work(), tests = null }) {
    Object.assign(this, { main, BrokerClass, acquireFolders, withFolders, tests });
    this.lanes = new Map(); this.closed = false; this.ticking = false; this.mainBusy = false; this.checking = new Map(); this.aborts = new Set();
    // Tasks whose copy is still being prepared. They hold a slot, and the queue leaves them alone until they start.
    this.preparing = new Map();
    // Waiting tasks look again when the main conversation's run begins or ends.
    main.on('update', () => { const busy = this.activeWorkers; if (busy !== this.mainBusy) { this.mainBusy = busy; this.tickAll(); } });
    main.admit = c => this.admit(c, null);
  }
  all() { return [...this.main.conversations.values()].flatMap(c => (c.parallelTasks || []).map(task => ({ c, task }))); }
  find(c, id) { const task = (c.parallelTasks || []).find(item => item.id === id); if (!task) throw fail('That task is no longer here.', 404); return task; }
  update(c, task, changes) { this.main.record(c, { type: 'parallel_task_update', id: task.id, changes }); this.main.emit('update', { conversationId: c.id }); }
  get running() { return [...this.lanes.values()].filter(lane => lane.broker.running).length; }
  get activeWorkers() { return (this.main.running ? 1 : 0) + this.running + this.preparing.size + [...this.main.conversations.values()].reduce((sum, c) => sum + c.reviews.filter(review => review.background && review.status === 'running').length, 0); }
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
    const limit = this.main.budget.policy(home).maxConcurrent, others = this.activeWorkers - (task && this.lanes.get(task.id)?.broker.running ? 1 : 0);
    if (others >= limit) throw fail(`${others} ${others === 1 ? 'task is' : 'tasks are'} already running, the most this workspace's task limits allow at once.`);
    if (task) this.syncPolicy(home, task);
  }
  available(task) { return task.purpose === 'project-review' ? JSON.stringify(task.workspaceFolders.map(({ id, path }) => ({ id, path }))) === JSON.stringify(this.main.workspaceFolders.map(({ id, path }) => ({ id, path }))) : this.main.workspaceFolders.some(folder => folder.id === task.folderId); }
  syncPolicy(c, task) {
    const lane = this.lanes.get(task.id); if (!lane) return;
    const policy = this.main.budget.policy(c);
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
      if (task.id === except || !this.lanes.get(task.id)?.broker.running) continue;
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
    const plan = planIsolation(identity, this.occupants(c, input.taskId), { loose: unrestricted({ provider: input.provider || c.provider, mode: input.accessMode || input.mode || c.mode, approvalPolicy: input.approvalPolicy || c.approvalPolicy || 'ask' }) });
    return { ...plan, identity, folder, ...(plan.mode === 'worktree' ? { uncommitted: uncommittedCount(folder.path) } : {}) };
  }
  // How a task would run, and whether it would have to wait for a free slot, for the page to say before it starts.
  preview(c, input) {
    const { identity, folder, ...plan } = this.plan(c, input), limit = this.main.budget.policy(c).maxConcurrent, running = this.activeWorkers;
    return { ...plan, running, limit, full: running >= limit };
  }

  start(c, input = {}, { queueExecution = null, prepareReview = false, held = false, plan = null } = {}) {
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
    if (input.parentTaskId) { if (input.execution?.taskId !== input.parentTaskId) throw fail('The child task must name its parent execution policy.'); this.main.execution.assert(c, input.execution, { action: 'children' }); throw fail('Automatic child assignment is not available yet. Start an explicit independent task.'); }
    const policyId = queueExecution?.taskId || randomUUID(); this.main.execution.ensure(c, policyId, { requestId: input.requestId });
    const execution = queueExecution || this.main.execution.token(c, policyId);
    this.main.execution.assert(c, execution, { action: input.routing ? 'routing' : 'manual', ...(prepareReview && input.routing ? {} : { provider, model, effort }) });
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    this.main.attachments.select(attachments);
    // One task to wait for, or several for a plan step that waits for more than one earlier step.
    const dependsOn = Array.isArray(input.dependsOn) ? (input.dependsOn.length ? [...new Set(input.dependsOn)] : null) : input.dependsOn || null;
    for (const id of waitsFor({ dependsOn })) { const before = this.find(c, id); if (['discarded', 'cancelled'].includes(before.status)) throw fail(`“${before.title}” was ${before.status}, so nothing can wait for it.`); }
    const folder = this.plan(c, { ...input, provider, accessMode: mode, approvalPolicy }).folder;
    // Ownership is saved before anything can start, so a crash at any point finds a task it can recover.
    const task = { id: policyId, execution, requestId: input.requestId, title: prepareReview ? 'Prepare project review' : line(input.title || text), ...(plan ? { plan } : {}), ...(held ? { held: true } : {}),...(prepareReview ? { purpose: 'project-review', workspaceFolders: this.main.workspaceFolders.map(folder => ({ ...folder })) } : {}), text, folderId: folder.id, folderName: folder.displayName || folder.name, folderPath: folder.path, provider, model, effort, accessMode: mode, approvalPolicy, billingConfirmed: input.billingConfirmed === true, attachments, includeHistory: input.includeHistory === true, dependsOn, ...(input.routing ? { routing: input.routing } : {}), status: 'waiting', reason: 'Starting', createdAt: new Date().toISOString() };
    this.main.record(c, { type: 'parallel_task', task });
    const saved = this.find(c, task.id);
    this.tick(c);
    this.main.emit('update', { conversationId: c.id });
    return this.public(saved);
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
  // and the tasks are recorded held, so a plan that can't start starts nothing. Each step gets exactly the agent, model and
  // effort the plan showed, and the conversation's own access and permission setting, never more. Steps wait for the
  // steps they depend on, and Tasks at once and the task limits decide when each starts, as for any task.
  fromPlan(c, plan, input = {}, prompt) {
    const folders = this.main.workspaceFolders, folderId = input.folderId || (folders.length === 1 ? folders[0].id : null);
    if (!folderId || !folders.some(folder => folder.id === folderId)) throw fail('Choose the folder these steps work in.', 400);
    const mode = c.mode, approvalPolicy = c.approvalPolicy || 'ask', assignments = input.assignments && typeof input.assignments === 'object' ? input.assignments : {};
    const chosen = plan.steps.map((step, index) => {
      const pick = assignments[step.id], number = index + 1;
      if (!pick || typeof pick !== 'object' || typeof pick.provider !== 'string') throw fail(`Choose an agent for step ${number}.`, 400);
      const provider = pick.provider, model = pick.model || null, effort = pick.effort || null;
      if (step.agent && (provider !== step.agent.provider || (step.agent.model && model !== step.agent.model) || (step.agent.effort && effort !== step.agent.effort))) throw fail(`Step ${number}’s agent changed. Check the plan again before running it.`);
      this.main.checkRunSettings(provider, mode, approvalPolicy);
      this.main.validateSelection(model, 'auto', effort);
      const allowed = this.main.budget.allows(c, provider, model);
      if (!allowed.allowed) throw fail(`Step ${number}: ${allowed.reason}`);
      return { step, number, provider, model, effort };
    });
    // Each attempt has its own request IDs, so a plan that failed to start can be run again; the plan's status stops a double run.
    const ids = {}, made = [], attempt = randomUUID().slice(0, 8);
    try {
      for (const { step, number, provider, model, effort } of chosen) {
        const task = this.start(c, { text: prompt(step, number), title: `${number}. ${step.title}`, provider, model, effort, mode, approvalPolicy, folderId, requestId: `plan-${plan.id}-${attempt}-${step.id}`, dependsOn: step.dependsOn.map(id => ids[id]), executionRevision: input.executionRevision }, { held: true, plan: { id: plan.id, stepId: step.id, number } });
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
  tick(c) {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      for (const task of (c.parallelTasks || []).filter(item => item.status === 'waiting' && !item.held && !this.preparing.has(item.id))) {
        const wait = reason => { if (task.reason !== reason) this.update(c, task, { reason }); };
        if (!this.available(task)) { this.update(c, task, { status: 'detached', reason: `${task.folderName} is no longer in this workspace.` }); continue; }
        const pending = waitsFor(task).map(id => this.find(c, id)).find(before => !(before.status === 'integrated' || before.status === 'kept' || (before.mode !== 'worktree' && before.status === 'complete')));
        if (pending) {
          // A step that ended without finishing can't be built on, so this one says what it needs instead of waiting quietly.
          const ended = { stopped: 'stopped', failed: 'did not finish', discarded: 'was discarded', cancelled: 'was cancelled', lost: 'lost its copy', detached: 'lost its folder', blocked: 'is blocked' }[pending.status];
          wait(ended ? `Waiting for “${pending.title}”, which ${ended}. Continue it in its task, or cancel this one.` : pending.mode === 'worktree' && pending.status === 'complete' ? `Waiting for “${pending.title}” to be merged.` : `Waiting for “${pending.title}”.`);
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
    const place = reuse ? { worktree: target, scopePath: task.scopePath, base: task.base } : createWorktree(identity, target, task.id);
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
  begin(c, task) {
    const lane = this.lane(c, task), first = !task.conversationId;
    if (first) {
      const conversation = lane.broker.get(lane.broker.create().id); lane.c = conversation;
      lane.broker.updateContext(conversation, c.context);
      this.update(c, task, { conversationId: conversation.id });
      for (const entry of (c.memory || []).filter(item => item.status === 'active' && (task.purpose === 'project-review' || !item.folderId || item.folderId === task.folderId))) lane.broker.record(conversation, { type: 'memory_add', entry });
      if (c.skills?.length) lane.broker.record(conversation, { type: 'skills', skills: c.skills, dirs: c.skillDirs || [] });
      lane.broker.budget.setPolicy(conversation, this.main.budget.policy(c));
      if (task.includeHistory) for (const message of c.messages.filter(item => ['user', 'assistant'].includes(item.role) && item.text?.trim() && !item.reviewId).slice(-20)) lane.broker.record(conversation, { type: 'message', message: { id: randomUUID(), role: message.role, text: message.text, provider: message.provider, status: 'complete', createdAt: message.createdAt } });
    }
    if (first) lane.broker.record(lane.c, { type: 'execution_policy', policy: this.main.execution.current(c, task.execution.taskId) });
    const input = { text: task.text, provider: task.provider, model: task.model, effort: task.effort, mode: task.accessMode, approvalPolicy: task.approvalPolicy, attachments: task.attachments, billingConfirmed: task.billingConfirmed, ...(task.routing ? { routing: task.routing } : {}), requestId: `task-${task.id}` };
    if (task.routing) lane.broker.dispatch(lane.c, input, { execution: task.execution }).catch(error => { this.update(c, task, { status: task.preparationCancelled ? 'stopped' : 'failed', reason: String(error.message).slice(0, 500), endedAt: new Date().toISOString() }); });
    else lane.broker.start(lane.c, input, { execution: task.execution });
    this.sync(c, task);
  }
  // Opens a task's lane. It only ever holds the task's own folder, so reopening it after a crash can't widen what it reaches.
  lane(c, task) {
    const open = this.lanes.get(task.id);
    if (open) return open;
    if (!task.scopePath) return null;
    const broker = new this.BrokerClass({ lane: true, workspace: task.scopePath, workspaceFolders: task.purpose === 'project-review' ? task.workspaceFolders : [{ id: task.folderId, name: task.folderName, path: task.scopePath }], dataDir: path.join(this.directory(task), 'journal'), googleRoot: this.main.googleRoot, bins: this.main.configuredBins, contextPolicy: this.main.contextPolicy, handoffPreferences: this.main.handoff.preferences, verificationCadence: this.main.verificationCadence, contextLimit: this.main.contextLimit, contextRouting: () => c.routing?.mode || null, acquireMutation: operation => task.purpose === 'project-review' ? { release() {}, setProcess() {} } : this.acquireFolders([task.scopePath], `${operation} for “${task.title}”`) });
    if (task.purpose === 'project-review') {
      // This lane only reads project files; the validated map is saved by ProjectReview. It needs no exclusive writer lease.
      const check = broker.checkRunSettings.bind(broker);
      broker.checkRunSettings = (provider, mode, approvalPolicy) => {
        if (mode !== 'read') throw fail('Project-review preparation only inspects files. Use the main chat to edit the project.');
        return check(provider, mode, approvalPolicy);
      };
    }
    broker.attachments = this.main.attachments; broker.skills.root = this.main.skills.root;
    broker.admit = () => this.admit(c, task);
    const lane = { broker, task, c: task.conversationId ? broker.conversations.get(task.conversationId) : null };
    broker.on('update', () => { if (lane.c) this.main.emit('update', { conversationId: lane.c.id }); this.sync(c, task); });
    broker.on('notify', notice => this.main.emit('notify', { ...notice, conversationId: c.id, title: `${task.folderName}: ${notice.title}` }));
    this.lanes.set(task.id, lane);
    return lane;
  }
  // A lane's state, read from the lane, and saved only when it changes.
  sync(c, task) {
    const lane = this.lanes.get(task.id);
    if (!lane?.c || this.closed || ENDED.has(task.status) || ['detached', 'lost', 'blocked'].includes(task.status)) return;
    const status = lane.broker.running ? 'running' : task.preparationCancelled ? 'stopped' : STOPPED[lane.c.status] || (lane.c.status === 'running' ? 'running' : task.status);
    const selected = lane.c.activeRun || (status !== 'running' ? lane.c.lastRun : null);
    const provider = selected?.provider || task.provider, model = selected ? selected.model ?? null : task.model, effort = selected ? selected.effort ?? null : task.effort;
    if (status === task.status && provider === task.provider && model === task.model && effort === task.effort) return;
    this.update(c, task, { status, reason: null, ...(status === 'running' ? { endedAt: null } : { endedAt: new Date().toISOString() }), provider, model, effort, ...(selected?.routing ? { routing: selected.routing } : {}) });
    if (status !== 'running') setImmediate(() => this.tick(c));
  }
  // After a restart. Whatever a lane was doing ended with the app, so its run is marked interrupted by its own journal, and
  // what was waiting waits for the person, as the queue does. Each lane still holds only its own folder.
  restore() {
    for (const { c, task } of this.all()) {
      if (ENDED.has(task.status)) continue;
      if (!this.available(task) && !['detached', 'lost'].includes(task.status)) { this.update(c, task, { status: 'detached', reason: `${task.folderName} is no longer in this workspace. Its history stays, and it can't run.` }); continue; }
      if (task.mode === 'worktree' && !fs.existsSync(task.worktree)) { if (task.status !== 'lost') this.update(c, task, { status: 'lost', reason: 'Its working copy is gone, so there is nothing to merge. Its history stays.' }); continue; }
      if (task.status === 'waiting') { if (!task.held) this.update(c, task, { held: true, reason: 'Codeshi restarted. Start it when you’re ready.' }); continue; }
      if (task.status !== 'running' && task.status !== 'blocked') continue;
      try { this.lane(c, task); this.update(c, task, { status: 'stopped', reason: null, endedAt: new Date().toISOString() }); }
      catch (error) { this.update(c, task, { status: 'blocked', reason: String(error.message).slice(0, 500) }); }
    }
  }

  public(task) {
    const lane = this.lanes.get(task.id), { text, attachments, requestId, folderPath, commonDir, repoRoot, preparationSource, workspaceFolders, ...shown } = task;
    const active = lane?.c?.activeRun;
    const runningProvider = (lane?.broker?.running && active?.provider) || (task.status === "running" && (active?.provider || lane?.c?.provider || task.provider)) || null;
    return {
      ...shown,
      runningProvider,
      runningModel: active?.model || null,
      runningPhase: active?.phase || null,
      runningStep: active?.plan?.steps?.find(s => s.status === "active")?.text || null,
      approvals: lane?.broker.pendingCount() || 0,
      hasWorktree: Boolean(task.worktree) && !ENDED.has(task.status)
    };
  }
  list(c) { return (c.parallelTasks || []).filter(task => !task.closed).map(task => this.public(task)); }
  // One task's conversation, as the page shows it. Undo works on the real folders from the main conversation, so a lane doesn't offer it.
  view(c, id, options) {
    const task = this.find(c, id), lane = this.lane(c, task);
    if (!lane?.c) return { execution: { defaults: this.main.execution.defaults(c), active: this.main.execution.current(c, task.execution?.taskId), policies: [] }, id: null, messages: [], status: task.status, queue: [], runs: [], task: this.public(task), parallelTasks: this.list(c), checkpoints: {} };
    return { ...lane.broker.view(lane.c, options), task: this.public(task), parallelTasks: this.list(c), checkpoints: {} };
  }

  executionPolicy(c, id, input) {
    const task = this.find(c, id), lane = this.lanes.get(task.id);
    const broker = lane?.c ? lane.broker : this.main, conversation = lane?.c || c;
    if (!task.execution) throw fail('Refresh this task after its legacy policy has been restored.');
    return broker.execution.change(conversation, { ...input, taskId: task.execution.taskId });
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
  planFor(c, task) { const result = snapshotWorktree(task.worktree, task.id, brought(task)); return { result, plan: integrationPlan({ root: task.repoRoot, prefix: task.prefix, base: task.base, result }) }; }
  review(c, id) {
    const task = this.reviewable(c, id), { result, plan } = this.planFor(c, task);
    if (result !== task.result) this.update(c, task, { result });
    const command = this.tests?.saved?.(), check = task.check?.digest === plan.digest ? task.check : null;
    return { files: plan.files, digest: plan.digest, conflicts: plan.conflicts, check, canCheck: Boolean(command?.command), testCommand: command?.command || null, folder: task.folderName, task: this.public(task) };
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
  integrate(c, id, { digest, acceptFailedCheck = false } = {}) {
    const task = this.reviewable(c, id);
    return this.withFolders([task.folderPath], 'merging a task', async () => {
      const { plan } = this.planFor(c, task);
      if (plan.digest !== digest) throw fail('The changes moved since you reviewed them. Review them again.');
      if (plan.conflicts) throw fail(`${plan.conflicts} file${plan.conflicts === 1 ? ' conflicts' : 's conflict'}, so nothing was merged and both versions are safe. Keep it as a branch to merge by hand.`);
      if (task.check?.digest === digest && task.check.status !== 'passed' && acceptFailedCheck !== true) throw fail('The tests failed on the combined result. Confirm to merge anyway.');
      applyPlan(task.repoRoot, plan);
      const count = plan.writes.length;
      this.main.message(c, 'system', count ? `Merged “${task.title}” into ${task.folderName}: ${count} file${count === 1 ? '' : 's'}.` : `“${task.title}” had nothing left to merge into ${task.folderName}.`);
      this.finish(c, task, { status: 'integrated', integration: { files: count, at: new Date().toISOString() } });
      return { merged: count, task: this.public(task) };
    });
  }
  // Leaves both sides as they are and gives the person the task's work as an ordinary branch.
  keep(c, id) {
    const task = this.reviewable(c, id), result = snapshotWorktree(task.worktree, task.id, brought(task)), branch = keepBranch(task.repoRoot, result, task.title, task.id);
    this.main.message(c, 'system', `“${task.title}” is kept as the branch ${branch}. Nothing was merged into ${task.folderName}.`);
    this.finish(c, task, { status: 'kept', integration: { branch, at: new Date().toISOString() } });
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
    this.update(c, task, { ...changes, reason: null, endedAt: task.endedAt || new Date().toISOString() });
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
      return ledger.tasks.map(item => ({ ...item, parallelTask: task.id, folder: task.folderName, ...(task.plan ? { plan: { id: task.plan.id, part: 'step', stepId: task.plan.stepId, number: task.plan.number } } : {}) }));
    }));
    return lists.flat();
  }
  async close() {
    this.closed = true;
    for (const abort of this.checking.values()) abort.abort();
    await Promise.allSettled([...this.lanes.values()].map(lane => lane.broker.close()));
  }
}

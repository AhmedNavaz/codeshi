import { randomUUID } from 'node:crypto';

// Orchestrate (#12, #89, #97): one message becomes a short plan of steps, each done by the agent and role that suits it.
// Specialist team workflows (#89) coordinate frontend, backend, database, design, QA and reviewer roles with shared
// contracts, task-scoped briefs, structured artifacts and gated integration checks.
export const planLimits = { steps: 5, title: 120, instructions: 4000, files: 12, path: 300, goal: 100000, summary: 1000, reply: 64000, plans: 10 };
const PROVIDERS = ['codex', 'claude', 'gemini'], TIERS = ['light', 'standard', 'deep'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const SPECIALIST_ROLES = ['builder', 'reviewer', 'frontend', 'backend', 'database', 'design', 'qa'];
export const ARTIFACT_KINDS = ['contract', 'schema', 'diff', 'test_evidence', 'findings'];
export const INTEGRATION_OUTCOMES = ['passed', 'failed', 'blocked', 'skipped', 'unverified', 'no_change'];

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, limit) => typeof value === 'string' && value.trim() && value.trim().length <= limit ? value.trim() : null;

// What the planner is asked. The goal comes last, so the conversation's context reads as before it.
export function planningRequest(goal) {
  return [
    'Plan this request as steps for coding agents. This is a read-only planning run: inspect the project as needed, but do not edit files or run commands that change anything.',
    `Use the fewest steps that do the job, usually 2 to 4 and at most ${planLimits.steps}. Each step must be a piece of work one agent can finish and check on its own, in order. Don't add steps for reviewing or testing the whole result; Codeshi does that after the last step.`,
    'Return only a JSON object with summary (one or two sentences) and steps (an array). Each step has title (short), instructions (what to do and how to know it is done), files (the folders or files it expects to change, as paths relative to the project), tier ("light" for a small well-defined change, "standard" for a focused change, "deep" for complex reasoning), dependsOn (the numbers of earlier steps it needs, starting at 1), and optional role ("builder", "reviewer", "frontend", "backend", "database", "design", "qa") and optional artifact ("contract", "schema", "diff", "test_evidence", "findings"). Do not choose agents or models.',
    '',
    'Request:',
    goal,
  ].join('\n');
}

// The plan the card shows, while it is open: being made, a draft, or one that never became a plan and waits to be planned
// again or put away. Queued messages wait while it is open (see PromptQueue.tick).
export const OPEN_PLANS = ['planning', 'draft', 'unstructured', 'failed', 'interrupted'];
export const openPlan = c => { const plan = c.orchestrations?.[0]; return plan && OPEN_PLANS.includes(plan.status) ? plan : null; };

// Orchestrate plans from the main conversation, which holds the plan. Review after belongs to the steps' combined
// changes, not to the planning run.
export function checkPlanning(broker, { routing = null, automaticReview = null } = {}) {
  if (!broker.tasks) fail('Orchestrate plans from the main conversation. Switch to it to plan this message.');
  if (automaticReview !== null && automaticReview !== undefined) fail('Review after doesn\u2019t apply to planning. The plan reviews the combined changes after its last step.');
}

// One step, from the planner (dependencies are step numbers) or from the page (dependencies are step ids). Throws a
// message that says what to fix.
function checkStep(raw, index, earlier, { fromPlanner }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each of the steps needs a title, instructions and a tier.');
  const id = fromPlanner ? `s${index + 1}` : raw.id;
  if (typeof id !== 'string' || !/^s\d{1,3}$/.test(id)) fail('Each of the steps needs its own id.');
  const title = text(raw.title, planLimits.title), instructions = text(raw.instructions, planLimits.instructions);
  if (!title) fail(`Give step ${index + 1} a title of at most ${planLimits.title} characters.`);
  if (!instructions) fail(`Give step ${index + 1} instructions of at most ${planLimits.instructions.toLocaleString('en-US')} characters.`);
  if (!TIERS.includes(raw.tier)) fail(`Choose light, standard or deep as step ${index + 1}'s tier.`);
  const files = raw.files ?? [];
  if (!Array.isArray(files) || files.length > planLimits.files || files.some(file => !text(file, planLimits.path))) fail(`List at most ${planLimits.files} files or folders for step ${index + 1}, each as a path.`);
  const dependsOn = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOn)) fail(`Step ${index + 1} can only depend on an earlier step.`);
  const needs = dependsOn.map(value => fromPlanner ? (Number.isSafeInteger(value) ? `s${value}` : null) : value);
  if (needs.some(value => !earlier.includes(value)) || new Set(needs).size !== needs.length) fail(`Step ${index + 1} can only depend on an earlier step.`);
  let agent = null;
  if (!fromPlanner && raw.agent !== null && raw.agent !== undefined) {
    if (typeof raw.agent !== 'object' || !PROVIDERS.includes(raw.agent.provider)) fail(`Choose Codex, Claude or Gemini as step ${index + 1}'s agent, or leave it to Auto.`);
    const model = raw.agent.model ?? null, effort = raw.agent.effort ?? null;
    if (model !== null && !text(model, 200)) fail(`Choose a model for step ${index + 1}, or leave it to the agent's default.`);
    if (effort !== null && !EFFORTS.includes(effort)) fail(`Choose a supported effort for step ${index + 1}.`);
    agent = { provider: raw.agent.provider, model: model === null ? null : model.trim(), effort };
  }
  const role = raw.role ? String(raw.role).trim().toLowerCase() : 'builder';
  if (!SPECIALIST_ROLES.includes(role)) fail(`Choose builder, reviewer, frontend, backend, database, design or qa as step ${index + 1}'s role.`);
  let artifact = null;
  if (raw.artifact !== null && raw.artifact !== undefined && raw.artifact !== '') {
    const art = String(raw.artifact).trim().toLowerCase();
    if (!ARTIFACT_KINDS.includes(art)) fail(`Choose contract, schema, diff, test_evidence or findings as step ${index + 1}'s artifact.`);
    artifact = art;
  }
  let check = null;
  if (raw.check !== null && raw.check !== undefined && raw.check !== '') {
    check = text(raw.check, 300);
    if (!check) fail(`Give step ${index + 1} an acceptance check of at most 300 characters.`);
  }
  const skills = Array.isArray(raw.skills) ? raw.skills.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 100)) : [];
  return { id, title, instructions, files: files.map(file => file.trim()), tier: raw.tier, dependsOn: needs, agent, role, artifact, check, skills };
}

// Verify specialist workflow dependency rules:
// Shared contract first, independent implementation second, integration/checks third.
export function validateWorkflowOrder(steps) {
  const stepMap = new Map(steps.map(s => [s.id, s]));
  for (const step of steps) {
    for (const depId of step.dependsOn) {
      const dep = stepMap.get(depId);
      if (!dep) continue;
      if (['qa', 'reviewer'].includes(dep.role) && ['builder', 'frontend', 'backend', 'database'].includes(step.role)) {
        fail(`Step ${step.id} (${step.role}) cannot depend on check step ${dep.id} (${dep.role}). Integration and checks must run after implementation.`);
      }
    }
  }
}

function checkSteps(steps, options) {
  if (!Array.isArray(steps)) fail('Send the plan\'s steps as a list.');
  if (steps.length > planLimits.steps) fail(`A plan has at most ${planLimits.steps} steps.`);
  const ids = [];
  const checkedSteps = steps.map((raw, index) => {
    const checked = checkStep(raw, index, ids, options);
    if (ids.includes(checked.id)) fail('Each step can appear only once.');
    ids.push(checked.id); return checked;
  });
  validateWorkflowOrder(checkedSteps);
  return checkedSteps;
}

// The steps as the person edited them. An empty plan is a draft still being written.
export const validateSteps = steps => checkSteps(steps, { fromPlanner: false });

// Find all downstream steps that depend directly or transitively on changedStepId.
export function invalidatedDownstream(steps, changedStepId) {
  const direct = new Map();
  for (const step of steps) direct.set(step.id, step.dependsOn || []);
  const invalidated = new Set(), queue = [changedStepId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [id, deps] of direct.entries()) {
      if (deps.includes(current) && !invalidated.has(id)) {
        invalidated.add(id);
        queue.push(id);
      }
    }
  }
  return [...invalidated];
}

// Attach task-specific briefs instead of broadcasting the entire conversation to every teammate.
export function stepBrief(plan, step, { artifacts = {}, sourceRevision = null } = {}) {
  const stepMap = new Map((plan.steps || []).map(s => [s.id, s]));
  const upstreamArtifacts = (step.dependsOn || []).map(id => {
    const upstream = stepMap.get(id);
    const artifact = artifacts[id] || (plan.artifacts && plan.artifacts[id]);
    return artifact ? {
      stepId: id,
      role: upstream?.role || 'builder',
      title: upstream?.title || '',
      kind: artifact.kind,
      content: artifact.content,
      revision: artifact.revision || null,
    } : null;
  }).filter(Boolean);

  return {
    goal: plan.goal,
    summary: plan.summary,
    stepId: step.id,
    role: step.role || 'builder',
    title: step.title,
    instructions: step.instructions,
    files: step.files || [],
    tier: step.tier,
    skills: step.skills || [],
    expectedArtifact: step.artifact || null,
    acceptanceCheck: step.check || null,
    upstreamArtifacts,
    sourceRevision: sourceRevision || null,
    briefNote: 'Task-specific brief for this specialist role. Contains only relevant scope, upstream contracts, and acceptance checks.',
  };
}

// Record and validate a structured artifact tied to source revision.
export function recordArtifact(plan, { stepId, kind, content, revision, role = null }) {
  if (!plan) fail('No plan provided.', 400);
  const step = (plan.steps || []).find(s => s.id === stepId);
  if (!step) fail(`Step ${stepId} is not in this plan.`, 404);
  if (!ARTIFACT_KINDS.includes(kind)) fail('Choose contract, schema, diff, test_evidence or findings as artifact kind.', 400);
  if (revision === null || revision === undefined) fail('A source revision is required for structured artifacts.', 400);

  plan.artifacts ||= {};
  const artifact = {
    stepId,
    role: role || step.role || 'builder',
    kind,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    revision: String(revision),
    recordedAt: new Date().toISOString(),
  };
  plan.artifacts[stepId] = artifact;

  const invalidated = invalidatedDownstream(plan.steps, stepId);
  plan.stepOutcomes ||= {};
  for (const id of invalidated) {
    if (plan.stepOutcomes[id]) {
      plan.stepOutcomes[id] = { ...plan.stepOutcomes[id], status: 'invalidated', needsRecheck: true };
    }
  }

  return artifact;
}

// Gate integration on applicable tests, types, build and independent review.
// QA failure blocks completion; an agent's self-report does not substitute for check evidence.
// Distinct outcomes: passed, failed, blocked, skipped, unverified, no_change.
export function evaluateIntegration({ step, checkResult = null, reviewFindings = [], repairCycles = 0, filesChanged = null }) {
  if (checkResult && (checkResult.status === 'failed' || checkResult.exitCode !== 0)) {
    return {
      outcome: 'failed',
      status: 'blocked',
      reason: 'QA check failed. Self-report cannot substitute for check evidence.',
      check: checkResult,
    };
  }

  if (step?.check && (!checkResult || checkResult.status === 'unverified')) {
    return {
      outcome: 'unverified',
      status: 'unverified',
      reason: 'Acceptance check was not executed or remains unverified.',
      check: checkResult,
    };
  }

  if (reviewFindings && reviewFindings.length > 0) {
    if (repairCycles < 1) {
      return {
        outcome: 'passed',
        status: 'repair',
        needsRepair: true,
        repairFindings: reviewFindings.slice(0, 5),
        reason: 'Review findings surfaced; finite repair cycle available.',
      };
    } else {
      return {
        outcome: 'blocked',
        status: 'blocked',
        needsRepair: false,
        reason: 'Repair cycle limit reached. Further findings require human acceptance.',
      };
    }
  }

  if (checkResult && (checkResult.status === 'passed' || checkResult.exitCode === 0)) {
    return {
      outcome: 'passed',
      status: 'complete',
      reason: 'Acceptance check passed.',
      check: checkResult,
    };
  }

  if (filesChanged === 0) {
    return {
      outcome: 'no_change',
      status: 'complete',
      reason: 'No files were changed.',
    };
  }

  return {
    outcome: 'unverified',
    status: 'complete',
    reason: 'Step completed without automated check evidence.',
  };
}

// The planner's reply, read strictly: a plan that doesn't match is reported, never repaired by guessing.
export function parsePlan(reply) {
  try {
    if (typeof reply !== 'string' || Buffer.byteLength(reply) > planLimits.reply) throw Error();
    const plan = JSON.parse(reply.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
    const summary = text(plan?.summary, planLimits.summary);
    if (!summary || !Array.isArray(plan.steps) || !plan.steps.length) throw Error();
    return { status: 'draft', summary, steps: checkSteps(plan.steps, { fromPlanner: true }) };
  } catch { return { status: 'unstructured', summary: 'The planner\'s reply could not be read as a plan. Open its response, plan again, or write the steps yourself.', steps: [] }; }
}

// The conversation's plans, newest first, from the journal. A new plan replaces an open one that was never run. A plan
// can't be added while one is being made (see orchestrationAction), so the planner's result always lands on its own plan.
export function applyOrchestration(c, record) {
  const plan = c.orchestrations.find(item => item.id === record.id);
  const add = value => {
    for (const item of c.orchestrations) if (OPEN_PLANS.includes(item.status)) Object.assign(item, { status: 'superseded', updatedAt: record.at });
    c.orchestrations = [value, ...c.orchestrations].slice(0, planLimits.plans);
  };
  if (record.type === 'submission' && record.orchestration) add({ id: record.id, goal: record.orchestration.goal, source: 'agent', status: 'planning', summary: '', steps: [], review: true, revision: 0, planner: { provider: record.provider, model: record.model ?? null, effort: record.effort ?? null }, createdAt: record.at, updatedAt: record.at });
  if (record.type === 'orchestration_plan') add({ ...record.plan, createdAt: record.at, updatedAt: record.at });
  if (!plan) return;
  if (record.type === 'orchestration_result') Object.assign(plan, record.result, { revision: plan.revision + 1, updatedAt: record.at });
  if (record.type === 'orchestration_update') Object.assign(plan, { steps: record.steps, review: record.review, revision: plan.revision + 1, updatedAt: record.at });
  if (record.type === 'orchestration_discard') Object.assign(plan, { status: 'discarded', updatedAt: record.at });
  if (record.type === 'orchestration_artifact') {
    plan.artifacts ||= {};
    plan.artifacts[record.stepId] = {
      kind: record.kind,
      content: record.content,
      revision: record.revision,
      stepId: record.stepId,
      role: record.role || plan.steps?.find(s => s.id === record.stepId)?.role || 'builder',
      updatedAt: record.at,
    };
    const invalidated = invalidatedDownstream(plan.steps || [], record.stepId);
    if (plan.stepOutcomes) {
      for (const id of invalidated) {
        if (plan.stepOutcomes[id]) plan.stepOutcomes[id] = { ...plan.stepOutcomes[id], status: 'invalidated', needsRecheck: true };
      }
    }
    plan.revision = (plan.revision || 0) + 1;
    plan.updatedAt = record.at;
  }
  if (record.type === 'orchestration_step_outcome') {
    plan.stepOutcomes ||= {};
    plan.stepOutcomes[record.stepId] = {
      outcome: record.outcome,
      status: record.status,
      reason: record.reason || null,
      updatedAt: record.at,
    };
    plan.revision = (plan.revision || 0) + 1;
    plan.updatedAt = record.at;
  }
}

// The plan a planning run ended with, or the one a restart cut short.
export const restartedPlanning = () => ({ status: 'interrupted', summary: 'Codeshi restarted while planning. Plan again or write the steps yourself.', steps: [] });
export function planningResult(success, stopped, reply) {
  if (success) return parsePlan(reply);
  return { status: stopped ? 'interrupted' : 'failed', summary: stopped ? 'Planning stopped. Plan again or write the steps yourself.' : 'The planner did not finish. Check its response, then plan again or write the steps yourself.', steps: [] };
}

// Writing a plan by hand, saving edits, recording artifacts and discarding.
export function orchestrationAction(broker, c, input = {}) {
  if (input.action === 'create') {
    if (c.orchestrations?.some(item => item.status === 'planning')) fail('Wait for the planner to finish.', 409);
    const goal = text(input.goal, planLimits.goal);
    if (!goal) fail(`Describe what the plan is for in at most ${planLimits.goal.toLocaleString('en-US')} characters.`);
    const id = randomUUID();
    broker.record(c, { type: 'orchestration_plan', id, plan: { id, goal, source: 'manual', status: 'draft', summary: '', steps: [], review: true, revision: 0, artifacts: {}, stepOutcomes: {} } });
    return broker.view(c);
  }
  if (!['update', 'discard', 'artifact', 'outcome'].includes(input.action)) fail('Choose update, discard, artifact, outcome or create.');
  const plan = (c.orchestrations || []).find(item => item.id === input.id);
  if (!plan) fail('That plan is no longer in this conversation.', 404);
  if (plan.status === 'planning') fail('Wait for the planner to finish.', 409);
  if (input.action === 'discard' && OPEN_PLANS.includes(plan.status)) { broker.record(c, { type: 'orchestration_discard', id: plan.id }); setTimeout(() => broker.queue.tick(c), 0); return broker.view(c); }
  if (input.action === 'artifact') {
    const step = (plan.steps || []).find(s => s.id === input.stepId);
    if (!step) fail('Choose a step from this plan.', 400);
    if (!ARTIFACT_KINDS.includes(input.kind)) fail('Choose contract, schema, diff, test_evidence or findings as artifact kind.', 400);
    broker.record(c, { type: 'orchestration_artifact', id: plan.id, stepId: input.stepId, kind: input.kind, content: input.content || '', revision: input.revision ?? plan.revision, role: input.role || step.role || null });
    return broker.view(c);
  }
  if (input.action === 'outcome') {
    const step = (plan.steps || []).find(s => s.id === input.stepId);
    if (!step) fail('Choose a step from this plan.', 400);
    const evaluated = evaluateIntegration({ step, checkResult: input.checkResult, reviewFindings: input.reviewFindings, repairCycles: input.repairCycles || 0, filesChanged: input.filesChanged });
    broker.record(c, { type: 'orchestration_step_outcome', id: plan.id, stepId: input.stepId, outcome: evaluated.outcome, status: evaluated.status, reason: evaluated.reason });
    return broker.view(c);
  }
  if (plan.status !== 'draft') fail('This plan can no longer be changed. Start a new one.', 409);
  if (input.revision !== plan.revision) fail('This plan changed in another window. Your view now shows the latest version.', 409);
  const steps = validateSteps(input.steps);
  broker.record(c, { type: 'orchestration_update', id: plan.id, steps, review: input.review === undefined ? plan.review : input.review === true });
  return broker.view(c);
}

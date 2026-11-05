// A task's plan across its agents (#92). An agent reports a plan for its own run, and when the task moves on, the steps
// go with it: the person keeps seeing the same checklist, and the next agent is told what was done, what was in progress
// and what remains. The journal stays the source of truth, so the plan needs nothing of its own to survive a restart.
const BRIEF_BYTES = 6000, BRIEF_STEP = 240;
const sameStep = text => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
const finished = steps => !steps?.length || steps.every(step => step.status === 'done');

// What a continuing run starts with: the last plan while any of it is unfinished, and which run it came from, so a wrong
// step can be traced to the agent that reported it. A finished plan has nothing left to carry.
export function carriedPlan(run) {
  const plan = run?.plan;
  if (finished(plan?.steps)) return null;
  return { steps: plan.steps.map(({ text, status }) => ({ text, status })), explanation: plan.explanation || null, updatedAt: plan.updatedAt || null, carriedFrom: { runId: run.id, provider: run.provider, ...(run.connection === 'local' ? { local: true } : {}) } };
}

// A plan the next agent reports replaces the carried one, except that a step already done stays done unless the agent
// lists it again, which is the agent reporting otherwise. Done steps it leaves out keep their place at the top.
export function reportedPlan(current, steps) {
  if (!current?.carriedFrom) return steps;
  const named = new Set(steps.map(step => sameStep(step.text)));
  return [...current.steps.filter(step => step.status === 'done' && !named.has(sameStep(step.text))), ...steps].slice(-50);
}

// The plan as the next agent's brief has it. Bounded: what remains always goes first, and the oldest done steps give way.
export function planForBrief(run) {
  const steps = run?.plan?.steps;
  if (finished(steps)) return null;
  const shown = step => ({ text: step.text.length > BRIEF_STEP ? `${step.text.slice(0, BRIEF_STEP - 1)}…` : step.text, status: step.status });
  const keep = new Set();
  let bytes = 0;
  const fits = step => { bytes += Buffer.byteLength(shown(step).text) + 24; return bytes <= BRIEF_BYTES; };
  for (const step of steps.filter(step => step.status !== 'done')) if (fits(step)) keep.add(step);
  for (const step of steps.filter(step => step.status === 'done').reverse()) if (fits(step)) keep.add(step);
  const left = steps.length - keep.size;
  return { steps: steps.filter(step => keep.has(step)).map(shown), ...(left ? { stepsLeftOut: left } : {}), ...(run.plan.carriedFrom || run.provider ? { reportedBy: run.provider } : {}) };
}

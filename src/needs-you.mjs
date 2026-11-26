import { openPlan } from './orchestration.mjs';
import { CHECK_PAUSE } from './run-checks.mjs';

// Needs you (#201): everything waiting for the person, across every open workspace, one line each, for the phone. It is
// read from what Codeshi already holds, as the recap is (src/recap.mjs), and changes nothing. Each line says where it
// opens: its workspace, and the task it belongs to or the workspace chat. Only short labels leave the computer, never a
// file's contents or a reply.
//
// A workspace counts once Codeshi has opened it since it started. Approvals, questions and offers only exist in an open
// one, and workspaces with a usage-limit wait or a schedule reopen at startup (src/server.mjs).

// The order things are listed in: what holds an agent up first, then what waits for a decision, then what can wait.
export const NEEDS_YOU_KINDS = ['approval', 'question', 'handoff', 'retry', 'plan', 'check', 'review', 'card', 'held', 'limit', 'schedule'];
const RANK = Object.fromEntries(NEEDS_YOU_KINDS.map((kind, index) => [kind, index]));
const MAX_ITEMS = 60;
const AGENTS = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', antigravity: 'Antigravity' };

const clip = (text, size = 90) => {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > size ? `${line.slice(0, size - 1).replace(/\s+\S*$/, '')}…` : line;
};
const agent = provider => AGENTS[provider] || (provider ? String(provider) : '');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const mergeable = task => Boolean(task.hasWorktree && ['complete', 'stopped', 'failed'].includes(task.status));
const checkFailed = task => Boolean(task.stepCheck && !task.stepCheck.accepted && (task.stepCheck.outcome === 'failed' || task.stepCheck.status === 'failed'));

// What one approval or question is about, in a few words. Commands are shown as the conversation shows them.
function asks(pending) {
  const first = pending[0], command = first?.command || first?.input?.command;
  if (first?.kind === 'question') return clip(first.questions?.[0]?.question || first.questions?.[0]?.header || 'An agent has a question');
  if (command) return clip(`Run ${command}`);
  const file = first?.input?.file_path || first?.input?.path;
  if (file) return clip(`Change ${String(file).split(/[\\/]/).pop()}`);
  return clip(first?.title || 'Allow what the agent asked for');
}

// The offers and waits one conversation can have: the workspace chat's, or a task's own.
function conversationNeeds(c, pending, place, broker) {
  const items = [];
  const questions = pending.filter(item => item.kind === 'question'), approvals = pending.filter(item => item.kind !== 'question');
  if (approvals.length) items.push({ ...place, kind: 'approval', title: place.label, detail: approvals.length === 1 ? asks(approvals) : `${plural(approvals.length, 'approval')} · ${asks(approvals)}`, provider: approvals[0].provider || null, count: approvals.length });
  if (questions.length) items.push({ ...place, kind: 'question', title: place.label, detail: asks(questions), provider: questions[0].provider || null, count: questions.length });
  if (c?.handoffOffer) {
    const from = c.handoffOffer.from?.provider, to = c.handoffOffer.to?.provider;
    items.push({ ...place, kind: 'handoff', title: place.label, detail: to ? `Hand off from ${agent(from) || 'this agent'} to ${agent(to)}?` : 'Approve the handoff', provider: from || null });
  }
  if (c?.retryOffer) {
    const to = c.retryOffer.provider;
    items.push({ ...place, kind: 'retry', title: place.label, detail: to ? `Tests failed. Try again with ${agent(to)}?` : 'Tests failed. Try again?', provider: to || null });
  } else if (c?.queuePaused && c.queuePaused.reason === CHECK_PAUSE) {
    items.push({ ...place, kind: 'check', title: place.label, detail: `Tests failed, so ${plural(c.queue?.length || 0, 'queued message')} wait${c.queue?.length === 1 ? 's' : ''}` });
  }
  if (c?.resume) {
    const providers = (c.resume.providers || []).map(agent).filter(Boolean);
    const agents = { ...(c.resume.agents || {}), ...(broker?.resume?.view?.(c)?.agents || {}) };
    const resets = Object.values(agents).map(entry => entry?.resetsAt).filter(Boolean).sort()[0] || null;
    items.push({ ...place, kind: 'limit', title: place.label, detail: `Waiting for ${providers.length ? providers.join(' or ') : 'an agent'}’s usage limit to reset`, provider: c.resume.providers?.[0] || null, ...(resets ? { at: resets } : {}) });
  }
  return items;
}

export function buildNeedsYou({ registry, now = new Date() }) {
  const items = [];
  for (const project of registry.list()) {
    const broker = registry.brokers.get(project.id)?.broker;
    const c = project.conversationId ? broker?.conversations.get(project.conversationId) : null;
    if (!c) continue;
    const workspace = { projectId: project.id, workspace: project.name };
    const chat = { ...workspace, taskId: null, label: 'Workspace chat' };
    items.push(...conversationNeeds(c, broker.pendingApprovals(c), chat, broker));
    const plan = openPlan(c);
    if (plan?.status === 'draft') items.push({ ...chat, kind: 'plan', title: clip(plan.goal || plan.title || 'A plan'), detail: plan.steps?.length ? `A plan of ${plural(plan.steps.length, 'step')} waits for your approval` : 'A plan waits for your approval' });
    const lanes = broker.tasks?.lanes;
    for (const task of broker.tasks?.list(c) || []) {
      if (['project-review'].includes(task.purpose) && !task.approvals) continue;
      const lane = lanes?.get(task.id), place = { ...workspace, taskId: task.id, label: clip(task.title || 'Task', 60), ...(task.folderName ? { folder: task.folderName } : {}) };
      const pending = lane ? [...lane.broker.conversations.values()].flatMap(item => lane.broker.pendingApprovals(item)) : [];
      items.push(...conversationNeeds(lane?.c || null, pending, place, lane?.broker));
      // A split's parts that Flow finishes by itself are only listed when something above needs you.
      if (task.managed) continue;
      const doneAt = task.endedAt || task.updatedAt || null;
      if (checkFailed(task)) items.push({ ...place, kind: 'check', title: place.label, detail: 'Its tests failed', provider: task.provider || null, ...(doneAt ? { at: doneAt } : {}) });
      else if (task.board && task.cardColumn === 'review') items.push({ ...place, kind: 'card', title: place.label, detail: 'A Plan card is ready for review', provider: task.provider || null, ...(doneAt ? { at: doneAt } : {}) });
      else if (!task.board && mergeable(task)) items.push({ ...place, kind: 'review', title: place.label, detail: task.status === 'complete' ? 'Finished. Ready to review and merge' : 'Ended with changes to review', provider: task.provider || null, ...(doneAt ? { at: doneAt } : {}) });
      else if (task.status === 'waiting' && task.held) items.push({ ...place, kind: 'held', title: place.label, detail: 'Paused, ready to start', provider: task.provider || null });
    }
    for (const missed of broker.schedules?.missed(c) || []) {
      items.push({ ...chat, id: `schedule:${project.id}:${missed.id}`, kind: 'schedule', title: clip(missed.title || 'A scheduled run', 60), detail: clip(`Didn’t start: ${missed.reason || 'missed'}`), at: missed.dueAt || null });
    }
  }
  const listed = items.map(({ label, ...item }) => ({ id: item.id || `${item.kind}:${item.projectId}:${item.taskId || 'chat'}`, ...item }));
  listed.sort((a, b) => RANK[a.kind] - RANK[b.kind] || String(b.at || '').localeCompare(String(a.at || '')));
  return { at: now.toISOString(), total: listed.length, items: listed.slice(0, MAX_ITEMS) };
}

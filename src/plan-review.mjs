import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Review and one repair round on the Plan (#89). A Reviewer or QA card checks the cards it builds on and ends with a verdict:
// pass, or up to five findings, each naming the card it's about. With findings, the cards after the review wait while each
// named card gets one repair run in its own task, with its own agent and history, under the limits it already has. Then
// the review runs once more in its task. Whatever it still finds goes to the person: the cards after it wait until they
// continue anyway or send cards back. There is never a second repair round, and an agent's word that it fixed something
// never stands in for the second review.
export const REVIEW_ROLES = ['reviewer', 'qa'];
export const BUILD_ROLES = ['builder', 'frontend', 'backend', 'database'];
export const REVIEW_LIMITS = { findings: 5, card: 200, problem: 600, fix: 600, file: 300, reply: 64000, summary: 800 };
const RETRY_MS = 5000;
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text; };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What a reviewer or QA card is told to end with, after its own report.
export function verdictRequest(role) {
  return [
    role === 'qa'
      ? 'You check the cards above. Run their tests and try what they built; you may add tests, but don’t fix the product code yourself: what needs fixing goes back to the card it belongs to.'
      : 'You check the cards above. Read their changes; don’t change any files yourself: what needs fixing goes back to the card it belongs to.',
    'End your report with your verdict as a JSON block. When the work can be built on as it is:',
    '```json',
    '{"verdict": "pass"}',
    '```',
    'When something must change first:',
    '```json',
    '{"verdict": "changes", "findings": [{"card": "the exact title of the card it is about", "problem": "what is wrong", "fix": "what to change", "file": "a path, if there is one"}]}',
    '```',
    `At most ${REVIEW_LIMITS.findings} findings, the most important first. Name only cards listed above. Leave out style preferences and anything that doesn’t need to change before the work is built on.`,
  ].join('\n');
}

// The last verdict block in a reply, or null when there is none or it doesn't say pass or name what should change.
export function parseVerdict(reply) {
  const text = String(reply || '').slice(-REVIEW_LIMITS.reply);
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]);
  const bare = text.lastIndexOf('{"verdict"');
  if (bare >= 0) blocks.push(text.slice(bare));
  for (const raw of blocks.reverse()) {
    let value;
    try { value = JSON.parse(raw.trim()); } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    if (value.verdict === 'pass') return { verdict: 'pass', findings: [] };
    if (value.verdict !== 'changes' || !Array.isArray(value.findings)) continue;
    const findings = value.findings.filter(item => item && typeof item === 'object').map(item => ({
      card: clip(item.card, REVIEW_LIMITS.card), problem: clip(item.problem ?? item.title ?? item.detail, REVIEW_LIMITS.problem),
      fix: clip(item.fix, REVIEW_LIMITS.fix), file: clip(item.file, REVIEW_LIMITS.file),
    })).filter(item => item.problem).slice(0, REVIEW_LIMITS.findings);
    if (findings.length) return { verdict: 'changes', findings };
  }
  return null;
}

// A new plan that changes code in two or more cards ends with one review of the whole result, waiting for every card
// nothing else waits for, unless the planner already ended it with a review. A plan that edits the Plan you have is left
// as it is. The card arrives as a draft like the others, with a note saying Codeshi added it.
export const FINAL_REVIEW_NOTE = 'Codeshi added this review of the whole result, as the plan changes code in more than one card. Delete it if you don’t want one.';
export function withFinalReview(steps, { editing = false } = {}) {
  if (editing || !Array.isArray(steps) || steps.some(step => step.card || step.merges?.length)) return { steps, added: null };
  if (steps.filter(step => BUILD_ROLES.includes(step.role || 'builder')).length < 2) return { steps, added: null };
  const waited = new Set(steps.flatMap(step => step.dependsOn || []));
  if (steps.some(step => REVIEW_ROLES.includes(step.role) && !waited.has(step.id))) return { steps, added: null };
  const last = steps.filter(step => !waited.has(step.id)).map(step => step.id);
  const id = `s${Math.max(0, ...steps.map(step => Number(String(step.id).slice(1)) || 0)) + 1}`;
  const added = {
    id, title: 'Review the whole result', tier: 'standard', role: 'reviewer', artifact: 'findings', check: null, files: [], dependsOn: last, phase: steps.at(-1)?.phase || null,
    instructions: 'Review the combined changes from every card in this plan against what the plan set out to do. Check that the pieces fit together, nothing asked for is missing, and nothing was broken along the way. Run the project’s tests if it has them.',
    done: ['Every card’s changes were read together', 'Each problem found names the card it is about'],
  };
  return { steps: [...steps, added], added: id };
}

// The cards after a review wait while it repairs, and once it has found something it couldn't repair, until you decide.
export const reviewHolds = task => Boolean(task?.review && ['repairing', 'held'].includes(task.review.status) && !task.review.accepted);

const findingLine = (item, index) => `${index + 1}. ${item.problem}${item.fix ? ` Fix: ${item.fix}` : ''}${item.file ? ` (${item.file})` : ''}`;
// How a repair that never reached the folder ended, after “Its repair”: its run stopped or failed, or its copy wasn't merged.
const unfinished = status => ({ stopped: 'run was stopped', discarded: 'was discarded', kept: 'was kept as a branch, not merged' })[status] || 'run didn’t finish';
const norm = value => String(value || '').toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/\s+/g, ' ').trim();

export class PlanReviews {
  constructor(board) { this.board = board; this.timers = new Map(); this.driving = false; }
  get main() { return this.board.main; }
  get tasks() { return this.main.tasks; }
  cardOf(c, task) { return this.board.cards(c).find(item => item.id === task.board?.cardId) || null; }
  isReview(card) { return Boolean(card && REVIEW_ROLES.includes(card.role)); }
  // Every card a review builds on, nearest first: the cards it waits for, and the ones those wait for.
  checked(c, card) {
    const out = [], seen = new Set([card.id]), queue = [...(card.dependsOn || [])];
    while (queue.length) {
      const id = queue.shift(); if (seen.has(id)) continue; seen.add(id);
      const other = this.board.cards(c).find(item => item.id === id);
      if (!other || this.board.closed(c, other)) continue;
      out.push(other); queue.push(...(other.dependsOn || []));
    }
    return out;
  }
  // The providers that built what a review checks, which an Auto review avoids when another agent can take it.
  builders(c, card) {
    return [...new Set(this.checked(c, card).filter(other => !this.isReview(other)).map(other => {
      const task = this.board.task(c, other);
      return task?.provider || other.attempts?.at(-1)?.provider || null;
    }).filter(Boolean))];
  }
  // What a review card's task asks routing to avoid when it starts: the providers that built what it checks.
  avoid(c, task) { const card = this.cardOf(c, task); return this.isReview(card) ? this.builders(c, card) : []; }
  // Whether a review ran on an agent that built what it checks, for the 'Not independent' label.
  independent(c, card, provider) { return !provider || !this.isReview(card) || !this.builders(c, card).includes(provider); }
  // Which card each finding is about: the one it names, or the only card that changed code when it names none.
  assign(c, card, findings) {
    const candidates = this.checked(c, card), builds = candidates.filter(other => !this.isReview(other));
    return findings.map(item => {
      const wanted = norm(item.card);
      let target = wanted ? candidates.find(other => norm(other.title) === wanted) : null;
      if (!target && wanted) { const loose = candidates.filter(other => norm(other.title).includes(wanted) || wanted.includes(norm(other.title))); if (loose.length === 1) [target] = loose; }
      if (!target && builds.length === 1) [target] = builds;
      return { ...item, cardId: target?.id || null };
    });
  }
  // Whether a card can be repaired in its task now, or why not. A part of a split Flow is finishing by itself was accepted
  // by Flow, not you, and one merged from its own copy is repaired as a new task (src/split-finish.mjs).
  repairable(c, card) {
    if (this.isReview(card)) return 'It is a review card, which changes nothing itself.';
    if (this.board.managed(c, card)) {
      const task = this.board.task(c, card);
      if (!task) return 'It has no task to repair in.';
      return task.status === 'integrated' || (task.status === 'complete' && task.mode !== 'worktree' && task.conversationId && task.scopePath) ? null : `Its task is ${task.status}, not finished.`;
    }
    if (card.column === 'done') return 'You’ve accepted it, so it isn’t changed without you. Send it back from Done to change it.';
    const task = this.board.task(c, card);
    if (!task) return 'It has no task to repair in. Run it again with the findings in a comment.';
    if (task.mode === 'worktree' && task.status !== 'complete') return 'It worked in its own copy, so a repair would need a new run. Send it back with the findings to repair it.';
    if (task.status !== 'complete') return `Its task is ${task.status}, not finished.`;
    if (!task.conversationId || !task.scopePath || (task.mode === 'worktree' && (!task.worktree || !fs.existsSync(task.worktree)))) return 'Its task’s conversation is gone.';
    return null;
  }
  // Reconcile repair entries whose target task finished while a follow-up or restart intervened.
  reconcileRepairs(c, repairs = []) {
    if (!Array.isArray(repairs) || !repairs.length) return repairs;
    let changed = false;
    const next = repairs.map(item => {
      if (item?.status !== 'running') return item;
      const taskId = item.taskId || this.board.cards(c).find(card => card.id === item.cardId)?.task;
      if (!taskId) return item;
      const target = (c.parallelTasks || []).find(other => other.id === taskId);
      if (!target || ['running', 'waiting'].includes(target.status)) return item;
      if (target.status === 'complete' && target.stepCheck?.status === 'running') return item;
      if (this.awaitsMerge(target)) return item;
      changed = true;
      if (this.repaired(target)) {
        return { ...item, status: 'done', tests: this.board.tests(target) || target.tests || item.tests || null, endedAt: target.endedAt || item.endedAt || new Date().toISOString() };
      }
      return { ...item, status: 'failed', reason: item.reason || `Its repair ${unfinished(target.status)}.` };
    });
    return changed ? next : repairs;
  }
  // A repair that changed files in a copy isn't in the folder until it is merged, and the review reads merged work, in a
  // copy of its own (task-coordinator.mjs before). So the second review waits for that merge: Flow's for a split's repair
  // (src/split-finish.mjs), and yours for a card repaired in its own copy.
  awaitsMerge(target) { return Boolean(target?.status === 'complete' && target.mode === 'worktree' && (target.splitRepair || target.copyFiles > 0)); }
  // A repair is done when its task finished, and was merged where it had changes to merge.
  repaired(target) { return Boolean(target?.status === 'complete' || (target?.status === 'integrated' && (target.splitRepair || target.repairOf))); }

  // A review card's task finished: read its verdict and decide what happens next. Returns the review saved on the task.
  ended(c, task, reply) {
    const card = this.cardOf(c, task);
    if (!this.isReview(card)) return null;
    const was = task.review || null, round = was?.round || 0, at = new Date().toISOString();
    const parsed = parseVerdict(reply);
    // A follow-up you asked in its task after the review answers your question; it doesn't review again. Without a new
    // verdict, the one it gave stands, and so does what you decided about it. While a repair round is still running, a
    // follow-up in the review task must not end the repair round early.
    const runId = this.tasks.lanes.get(task.id)?.c?.lastRun?.id, followUp = Boolean(runId && (task.laterRuns || []).some(item => item.runId === runId && item.kind === 'follow-up'));
    const reconciledRepairs = was ? this.reconcileRepairs(c, was.repairs) : [];
    const currentWas = was && reconciledRepairs !== was.repairs ? { ...was, repairs: reconciledRepairs } : was;
    if (currentWas && currentWas.status === 'repairing' && followUp) return currentWas;
    if (!parsed && currentWas && currentWas.status !== 'reviewing' && (followUp || currentWas.verdict)) return currentWas;
    const keep = was ? { findings: was.findings, repairs: reconciledRepairs } : {};
    let review;
    if (!parsed) review = { ...keep, round, verdict: null, status: 'held', reason: 'The review didn’t end with a verdict, so the cards after it wait. Read its report, then continue anyway or send it back.', at };
    else if (parsed.verdict === 'pass') review = { ...keep, round, verdict: 'pass', status: 'passed', reason: round ? 'The repairs fixed what the review found.' : 'The review found nothing that must change.', at, ...(round ? { earlier: was.findings } : {}), findings: [] };
    else {
      const findings = this.assign(c, card, parsed.findings);
      if (round >= 1) review = { round, verdict: 'changes', findings, repairs: reconciledRepairs, earlier: was?.findings || [], status: 'held', reason: `The review still found ${plural(findings.length, 'problem')} after the repair round. The cards after it wait for you: continue anyway, or send cards back.`, at };
      else if (!this.main.execution.allows(c, task.execution, { action: 'review', sequence: true })) review = { round, verdict: 'changes', findings, status: 'held', reason: 'This task’s execution policy doesn’t allow an automatic repair, so the cards after it wait for you.', at };
      else {
        const ids = [...new Set(findings.map(item => item.cardId).filter(Boolean))], repairs = [];
        for (const id of ids) {
          const target = this.board.cards(c).find(item => item.id === id), why = this.repairable(c, target);
          repairs.push({ cardId: id, title: target.title, count: findings.filter(item => item.cardId === id).length, status: why ? 'skipped' : 'pending', ...(why ? { reason: why } : {}) });
        }
        const loose = findings.filter(item => !item.cardId).length;
        if (!repairs.some(item => item.status === 'pending')) {
          const why = loose === findings.length ? 'The findings don’t name a card it checked, so nothing could be repaired.' : 'None of the cards it named could be repaired here.';
          review = { round, verdict: 'changes', findings, repairs, status: 'held', reason: `${why} The cards after it wait for you.`, at };
        } else review = { round: 1, verdict: 'changes', findings, repairs, status: 'repairing', reason: `Repairing ${plural(repairs.filter(item => item.status === 'pending').length, 'card')}, then reviewing again.`, at };
      }
    }
    this.tasks.update(c, task, { review });
    const name = `“${card.title}”`;
    if (review.status === 'repairing') this.main.message(c, 'system', `${name} found ${plural(review.findings.length, 'problem')}. ${review.repairs.filter(item => item.status === 'pending').map(item => `“${item.title}”`).join(', ')} ${review.repairs.filter(item => item.status === 'pending').length === 1 ? 'gets' : 'get'} one repair run, then ${name} reviews again. The cards after it wait.`);
    // For the review of a split Flow is finishing, Flow says so itself as it hands the parts to the Plan (src/split-finish.mjs).
    else if (review.status === 'held' && !this.board.managed(c, card)) this.main.message(c, 'system', `${name}: ${review.reason}`);
    this.later(c);
    return review;
  }

  // Moves every repairing review on: the next repair, then the second review. Called after any task changes.
  later(c, ms = 0) {
    if (this.timers.has(c.id)) return;
    const timer = setTimeout(() => { this.timers.delete(c.id); try { this.drive(c); } catch (error) { console.error('Codeshi could not move a Plan review on:', error.message); } }, ms);
    timer.unref?.(); this.timers.set(c.id, timer);
  }
  drive(c) {
    if (this.driving || this.tasks.closed) return;
    this.driving = true;
    try { for (const task of (c.parallelTasks || []).filter(item => item.review?.status === 'repairing')) this.step(c, task); }
    finally { this.driving = false; }
  }
  step(c, task) {
    const review = task.review, card = this.cardOf(c, task), save = changes => this.tasks.update(c, task, { review: { ...task.review, ...changes } });
    if (!card || card.task !== task.id) return save({ status: 'held', waiting: null, reason: 'The review card was run again or removed, so this repair round ended.' });
    const repairs = review.repairs.map(item => ({ ...item }));
    const running = repairs.find(item => item.status === 'running');
    if (running) {
      const target = (c.parallelTasks || []).find(item => item.id === running.taskId);
      if (target && ['running', 'waiting'].includes(target.status)) return;
      if (target?.status === 'complete' && target.stepCheck?.status === 'running') return;
      // A repair in a copy is done once it is merged (awaitsMerge). Flow merges a split's; a card's own waits for you,
      // which is said once, as nothing else would tell you the round has stopped for it.
      if (this.awaitsMerge(target)) {
        const waiting = `Waiting for “${running.title}” to be merged, so the review can read its repair.`;
        if (target.splitRepair || review.waiting === waiting) return;
        save({ waiting });
        return this.main.message(c, 'system', `“${running.title}” was repaired in its own copy. Review and merge it from its card, and “${card.title}” reviews again. Discarding it ends the repair round.`);
      }
      if (this.repaired(target)) Object.assign(running, { status: 'done', tests: this.board.tests(target) || null, endedAt: new Date().toISOString() });
      else {
        Object.assign(running, { status: 'failed', reason: target ? `Its repair ${unfinished(target.status)}.` : 'Its task is gone.' });
        return save({ repairs, status: 'held', waiting: null, reason: `The repair on “${running.title}” ${target ? unfinished(target.status).replace(/^run /, '') : 'didn’t finish'}, so the cards after the review wait for you.` });
      }
      save({ repairs, waiting: null });
    }
    const next = repairs.find(item => item.status === 'pending');
    if (next) {
      const target = this.board.cards(c).find(item => item.id === next.cardId), why = target ? this.repairable(c, target) : 'It was removed from the Plan.';
      if (why) { Object.assign(next, { status: 'skipped', reason: why }); save({ repairs, waiting: null }); return this.later(c); }
      try { next.taskId = this.repair(c, task, card, target); next.status = 'running'; next.startedAt = new Date().toISOString(); save({ repairs, waiting: null }); }
      catch (error) {
        // A full workspace or a busy folder: the repair waits and tries again, as a waiting task does.
        if (error.status === 409 && /busy|already|at once|slot/i.test(error.message)) { if (review.waiting !== error.message) save({ waiting: clip(error.message, 300) }); return this.later(c, RETRY_MS); }
        Object.assign(next, { status: 'failed', reason: clip(error.message, 300) });
        save({ repairs, status: 'held', waiting: null, reason: `The repair on “${next.title}” couldn’t start: ${clip(error.message, 200)}` });
      }
      return;
    }
    // Every repair finished: the review checks once more, in its own task, with what each repair did.
    // Set status to 'reviewing' before starting the run so laterRun records this run as 'rereview', while any user
    // message sent while status === 'repairing' is recorded as 'follow-up'.
    try { save({ repairs, status: 'reviewing', waiting: null, reason: 'Reviewing the repairs.' }); this.again(c, task, card, repairs); }
    catch (error) {
      if (error.status === 409 && /busy|already|at once|slot/i.test(error.message)) { save({ repairs, status: 'repairing', waiting: clip(error.message, 300) }); return this.later(c, RETRY_MS); }
      save({ repairs, status: 'held', waiting: null, reason: `The second review couldn’t start: ${clip(error.message, 200)}` });
    }
  }
  laneOf(c, task) {
    const lane = this.tasks.lanes.get(task.id) || this.tasks.lane(c, task);
    if (!lane) throw Object.assign(new Error('Its task’s conversation is gone.'), { status: 409 });
    if (!lane.c && task.conversationId) lane.c = lane.broker.conversations.get(task.conversationId) || null;
    if (!lane.c) throw Object.assign(new Error('Its task’s conversation is gone.'), { status: 409 });
    return lane;
  }
  // One more run in the repaired card's own task, with the agent, model and effort that did it, and its history.
  repair(c, reviewTask, reviewCard, card) {
    const target = this.board.task(c, card), mine = reviewTask.review.findings.filter(item => item.cardId === card.id);
    if (this.board.managed(c, card) && target.status === 'integrated') return this.main.splits.finisher.repair(c, card, target, mine.map(findingLine));
    const lane = this.laneOf(c, target);
    const text = [
      `A ${reviewCard.role === 'qa' ? 'QA' : 'review'} card, “${reviewCard.title}”, checked this card’s work and asked for changes. Fix these, and only these:`,
      ...mine.map(findingLine),
      '',
      'This is the one repair round: the review checks again after it, and anything still wrong goes to the person. When you finish, say in a few sentences what you changed and how you checked it.',
    ].join('\n');
    this.tasks.update(c, target, { repairOf: { taskId: reviewTask.id, cardId: reviewCard.id, round: 1 } });
    lane.broker.start(lane.c, { text, role: card.role || target.role || 'builder', provider: target.provider, model: target.model, effort: target.effort, mode: target.accessMode, approvalPolicy: target.approvalPolicy, billingConfirmed: target.billingConfirmed, requestId: `repair-${reviewTask.id}-${card.id}-${randomUUID().slice(0, 6)}` }, { execution: target.execution });
    this.tasks.sync(c, target);
    return target.id;
  }
  // The second and last review, in the review card's task, with its first findings and what each repair did. A review in
  // its own copy read the cards' work there, so what the repairs merged since is brought into that copy first
  // (task-coordinator.mjs refreshCopy): it would otherwise check the files as they were and find nothing fixed.
  again(c, task, card, repairs) {
    const lane = this.laneOf(c, task);
    // A full workspace is found out before the copy changes, so a review that waits for a slot tries again as it was.
    this.tasks.admit(c, task);
    const fresh = this.tasks.refreshCopy(c, task);
    const lines = repairs.map(item => {
      if (item.status !== 'done') return `- “${item.title}”: not repaired. ${item.reason || ''}`.trim();
      const target = (c.parallelTasks || []).find(other => other.id === item.taskId), conversation = this.tasks.lanes.get(item.taskId)?.c;
      const reply = conversation?.messages?.findLast(message => message.role === 'assistant' && message.runId === conversation.lastRun?.id && message.text?.trim())?.text || '';
      return `- “${item.title}”: ${clip(reply, REVIEW_LIMITS.summary) || 'it gave no report.'}${item.tests ? ` Tests: ${item.tests}.` : ''}${target ? '' : ' Its task is gone.'}`;
    });
    const text = [
      'The cards you reviewed had one repair run each. Check the files again: is each finding fixed, and did a repair break anything?',
      ...(fresh.files ? [`The repairs are merged, and your copy now has what changed since your review, ${plural(fresh.files, 'file')}: \`git diff ${fresh.was.slice(0, 12)} ${fresh.base.slice(0, 12)}\` shows it.`] : []),
      '',
      'Your findings were:',
      ...task.review.findings.map(findingLine),
      '',
      'What the repairs reported (their own words; check the files themselves):',
      ...lines,
      '',
      'This is the last review round: anything still wrong goes to the person. End with your verdict in the same JSON format as before.',
    ].join('\n');
    lane.broker.start(lane.c, { text, role: card.role || task.role || 'reviewer', provider: task.provider, model: task.model, effort: task.effort, mode: task.accessMode, approvalPolicy: task.approvalPolicy, billingConfirmed: task.billingConfirmed, requestId: `rereview-${task.id}-${randomUUID().slice(0, 6)}` }, { execution: task.execution });
    this.tasks.sync(c, task);
  }

  // Building on a review you've read is your call, and it's recorded as yours.
  accept(c, task) {
    if (!reviewHolds(task)) return false;
    if (task.review.status === 'repairing') throw Object.assign(new Error('The repair round is still running. Stop the repairing card first, or wait for the second review.'), { status: 409 });
    this.tasks.update(c, task, { review: { ...task.review, accepted: true, acceptedAt: new Date().toISOString() } });
    return true;
  }
  // Before follow-ups kept a review's verdict, a question asked in its task after the review replaced the verdict with
  // "no verdict". Read when the card opens: the verdict comes back from the review's own reply, as a decision for you
  // (no repair starts after the fact), and the runs after it count as follow-ups.
  recover(c, task) {
    if (task.review?.status !== 'held' || task.review.verdict !== null || task.review.accepted || task.status !== 'complete') return false;
    const card = this.cardOf(c, task);
    if (!this.isReview(card) || card.task !== task.id) return false;
    const all = this.board.runsOf(c, task), index = all.findLastIndex(run => parseVerdict(run.text));
    if (index < 0 || index === all.length - 1) return false;
    const parsed = parseVerdict(all[index].text), was = task.review, at = new Date().toISOString();
    const findings = parsed.verdict === 'pass' ? [] : this.assign(c, card, parsed.findings);
    const review = parsed.verdict === 'pass'
      ? { ...was, verdict: 'pass', status: 'passed', findings: [], reason: 'The review found nothing that must change.', at }
      : { ...was, verdict: 'changes', findings, status: 'held', reason: `The review found ${plural(findings.length, 'problem')}. The cards after it wait for you: continue anyway, or send cards back.`, at };
    const known = new Set((task.laterRuns || []).map(item => item.runId));
    const later = all.slice(index + 1).filter(run => !known.has(run.runId)).map(run => ({ runId: run.runId, kind: 'follow-up', at }));
    this.tasks.update(c, task, { review, laterRuns: [...(task.laterRuns || []), ...later].slice(-30) });
    // The card's result shows the report again, with the replies after it as follow-ups.
    if (card.result && ['review', 'done'].includes(card.column)) this.board.update(c, card, { result: { ...card.result, summary: clip(all[index].text, 600), reportRun: all[index].runId, followUps: all.length - index - 1, at } });
    return true;
  }
  // After a restart, a repair round that was under way waits for you: its runs ended with the app.
  restore(c) {
    for (const task of (c.parallelTasks || []).filter(item => ['repairing', 'reviewing'].includes(item.review?.status))) {
      if (task.review.status === 'reviewing' && ['running', 'waiting'].includes(task.status)) continue;
      if (task.review.status === 'repairing') { this.later(c); continue; }
      this.tasks.update(c, task, { review: { ...task.review, status: 'held', waiting: null, reason: 'Codeshi closed during the second review, so the cards after it wait for you.' } });
    }
  }
  close() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}

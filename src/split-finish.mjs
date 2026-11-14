import { randomUUID } from 'node:crypto';

// Finishing a split message by itself. A split (src/flow-split.mjs) is Flow's way of doing one message faster, or with
// agents suited to each part, so its parts aren't the person's to manage: they run as hidden cards, and Flow takes each
// one to the end. A part that finished in its own copy is merged into the folder when that is safe: it finished, its
// tests didn't fail, and none of its files changed in the folder meanwhile. Then one Reviewer card checks the combined
// result in the folder, with one repair round for what it finds (src/plan-review.mjs), and the chat gets one answer with
// what each part did, the review and the tests.
// Flow never guesses. A part that didn't finish, failed its tests, or conflicts with the folder stops the finishing: the
// parts appear on the Plan as an ordinary group, and the person merges, sends back or discards them as for any card.
// So does a change to the message's permissions, as an automatic split runs on them.
const LIVE = new Set(['waiting', 'running']);
const RETRY_MS = 5000;
const NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini' };
const clip = (value, limit) => { const flat = String(value ?? '').replace(/\s+/g, ' ').trim(); return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat; };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// Moments the folder is in use, which pass: the merge waits and tries again.
const PASSING = /busy|already|another operation|moved since/i;
export const REVIEW_CARD = {
  title: 'Review the combined result',
  notes: 'Every part of this request was done by its own agent and is now in the folder. Read the combined changes against the request: check that the parts fit together, nothing asked for is missing, and nothing was broken along the way. Run the project’s tests if it has them.',
};

// An agent's answer, shortened at a paragraph so a code block or list isn't cut in half.
export function excerpt(text, limit = 1500) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  let cut = value.slice(0, limit);
  const paragraph = cut.lastIndexOf('\n\n');
  if (paragraph > limit / 2) cut = cut.slice(0, paragraph);
  if ((cut.match(/```/g) || []).length % 2) cut += '\n```';
  return `${cut.trimEnd()}\n\n_Shortened. The whole answer is in the part’s conversation._`;
}

// Applying the journal: a split being finished, and how it ended.
export function applySplitRunRecord(c, record) {
  if (record.type === 'split_run') c.splitRuns = [...(c.splitRuns || []).filter(run => run.id !== record.run.id), { ...record.run, startedAt: record.at }].slice(-20);
  if (record.type === 'split_run_update') { const run = c.splitRuns?.find(item => item.id === record.id); if (run) Object.assign(run, record.changes); }
}

export class SplitFinish {
  constructor(broker) { this.broker = broker; this.timers = new Map(); this.driving = new Set(); this.again = new Set(); }
  get board() { return this.broker.board; }
  get tasks() { return this.broker.tasks; }
  working(c) { return (c.splitRuns || []).filter(run => run.status === 'working'); }
  // Whether Flow is still finishing the split a task or card belongs to, which keeps it out of Tasks and off the Plan.
  manages(c, splitId) { return Boolean(splitId) && this.working(c).some(run => run.id === splitId); }
  save(c, run, changes) { this.broker.record(c, { type: 'split_run_update', id: run.id, changes }); this.broker.emit('update', { conversationId: c.id }); }

  // Saved once the parts have started.
  begin(c, { proposal, group, cards, reviewCardId, folderId, by }) {
    this.broker.record(c, { type: 'split_run', run: { id: proposal.id, group, cards, reviewCardId, folderId, parentTaskId: proposal.taskId, execution: proposal.execution, automatic: by === 'flow', status: 'working' } });
  }

  // Moves every split on after any of its tasks changes. One pass at a time per conversation; a change during a pass asks
  // for another.
  later(c, ms = 0) {
    if (!this.working(c).length) return;
    if (this.driving.has(c.id)) { this.again.add(c.id); return; }
    if (this.timers.has(c.id)) return;
    const timer = setTimeout(() => { this.timers.delete(c.id); this.drive(c).catch(error => console.error('Codeshi could not finish a split message:', error.message)); }, ms);
    timer.unref?.(); this.timers.set(c.id, timer);
  }
  async drive(c) {
    if (this.driving.has(c.id) || this.tasks.closed) return;
    this.driving.add(c.id);
    try { for (const run of this.working(c)) await this.step(c, run); }
    finally { this.driving.delete(c.id); if (this.again.delete(c.id)) this.later(c); }
  }
  // After a restart: what was running stopped with the app, and what was waiting waits for the person, so the person
  // decides how each split goes on.
  restore() { for (const c of this.broker.conversations.values()) for (const run of this.working(c)) this.handOver(c, run, 'Codeshi closed while Flow was finishing this message.'); }
  close() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }

  async step(c, run) {
    const board = this.board, cards = run.cards.map(id => board.cards(c).find(card => card.id === id));
    if (cards.some(card => !card)) return this.handOver(c, run, 'A part was removed from the Plan.');
    // An automatic split runs on the message's own permission to start tasks. Once that changes, the person decides.
    if (run.automatic && !this.broker.execution.allows(c, run.execution, { action: 'children' })) return this.handOver(c, run, 'The message’s permissions changed, so Flow stopped finishing it by itself.');
    // A repair from the review that ran in its own copy is merged as a part is.
    for (const task of (c.parallelTasks || []).filter(item => item.splitId === run.id && item.splitRepair && item.mode === 'worktree' && item.status === 'complete')) {
      const merged = await this.merge(c, run, task, `the repair of “${task.splitRepair.title}”`);
      if (merged !== true) return;
    }
    let pending = false;
    for (const card of cards) {
      if (card.column === 'done') continue;
      const task = board.task(c, card);
      if (!task) return this.handOver(c, run, `“${card.title}” didn’t finish: ${card.reason || 'it stopped'}`);
      if (LIVE.has(task.status) || task.stepCheck?.status === 'running' || this.tasks.checking.has(task.id)) { pending = true; continue; }
      if (task.status === 'complete') {
        const check = task.stepCheck;
        if (check?.outcome === 'failed' && !check.accepted) return this.handOver(c, run, `The tests failed on “${card.title}”${check.command ? ` (${check.command})` : ''}.`);
        if (check?.status === 'interrupted' && !check.accepted) return this.handOver(c, run, `The tests on “${card.title}” were interrupted.`);
        if (task.mode === 'worktree') {
          // A copy that changed nothing, such as research, is accepted as it is: there is nothing to merge.
          if (board.emptyCopy(c, task)) { board.accept(c, card.id, { by: 'flow' }); continue; }
          const merged = await this.merge(c, run, task, `“${card.title}”`);
          if (merged !== true) return;
        }
      }
      const now = board.cards(c).find(item => item.id === card.id), after = now && board.task(c, now);
      if (now?.column === 'review' && after && ['complete', 'integrated'].includes(after.status)) { board.accept(c, now.id, { by: 'flow' }); continue; }
      return this.handOver(c, run, after?.status === 'discarded' ? `The changes of “${card.title}” were discarded.` : `“${card.title}” didn’t finish: ${now?.reason || task.reason || 'it stopped'}`);
    }
    if (pending) return;
    // Every part is in the folder. The review checks them together, unless none of them changed a file.
    const review = run.reviewCardId ? board.cards(c).find(card => card.id === run.reviewCardId) : null;
    if (!review) return this.finish(c, run, { review: null });
    const task = board.task(c, review);
    if (!task) return this.finish(c, run, { review, note: `The review didn’t run: ${review.reason || 'it stopped'}` });
    if (task.status === 'waiting' && !task.conversationId && run.cards.every(id => board.cards(c).find(card => card.id === id)?.result?.files === 0)) {
      this.tasks.finish(c, task, { status: 'cancelled' });
      return this.finish(c, run, { review: null, nothingChanged: true });
    }
    if (LIVE.has(task.status) || task.stepCheck?.status === 'running' || ['repairing', 'reviewing'].includes(task.review?.status) || this.tasks.checking.has(task.id)) return;
    if (task.status !== 'complete') return this.finish(c, run, { review, note: `The review didn’t finish${task.reason ? `: ${clip(task.reason, 200)}` : '.'}` });
    return this.finish(c, run, { review });
  }

  // Merges one finished copy: true once it's in the folder, false when it waits or was handed over.
  async merge(c, run, task, name) {
    let plan;
    try { plan = this.tasks.planFor(c, task).plan; }
    catch (error) { this.handOver(c, run, `Flow couldn’t read the changes of ${name}: ${clip(error.message, 200)}`); return false; }
    if (plan.conflicts) { this.handOver(c, run, `${name[0].toUpperCase()}${name.slice(1)} changed ${plural(plan.conflicts, 'file')} that also changed in your folder, so Flow didn’t merge it.`); return false; }
    try { await this.tasks.integrate(c, task.id, { digest: plan.digest, quiet: true }); return true; }
    catch (error) {
      if (error.status === 409 && PASSING.test(error.message)) { this.later(c, RETRY_MS); return false; }
      this.handOver(c, run, `Flow couldn’t merge ${name}: ${clip(error.message, 200)}`);
      return false;
    }
  }

  // A part the review found problems with, repaired as a new task when its own can't take another run: it finished in a
  // copy that is now merged and gone. It has the part's own agent, model and effort, and counts toward the message's limits.
  repair(c, card, target, findings) {
    const run = this.working(c).find(item => item.id === card.managed?.splitId);
    if (!run) throw Object.assign(new Error('Flow is no longer finishing this split.'), { status: 409 });
    const text = [this.board.prompt(c, card), '', 'This part is already done and merged into the folder. A review of the combined result asked for changes to it. Fix these, and only these, in the files as they are now:', ...findings, '', 'This is the one repair round: the review checks again after it. When you finish, say in a few sentences what you changed and how you checked it.'].join('\n');
    const started = this.tasks.start(c, { text, title: `Repair: ${card.title}`, provider: target.provider, model: target.model, effort: target.effort, mode: target.accessMode, approvalPolicy: target.approvalPolicy, folderId: target.folderId, billingConfirmed: target.billingConfirmed, requestId: `split-repair-${card.id}-${randomUUID().slice(0, 6)}`, executionRevision: this.broker.execution.defaults(c).revision, parent: { taskId: run.parentTaskId, execution: run.execution, splitId: run.id, automatic: run.automatic } });
    this.tasks.update(c, this.tasks.find(c, started.id), { splitRepair: { cardId: card.id, title: card.title } });
    return started.id;
  }

  // The parts go to the Plan as an ordinary group, to finish by hand. What Flow already merged stays merged.
  handOver(c, run, reason) {
    const board = this.board, ids = [...run.cards, ...(run.reviewCardId ? [run.reviewCardId] : [])];
    const cards = ids.map(id => board.cards(c).find(card => card.id === id)).filter(Boolean);
    for (const card of cards) if (card.managed) board.update(c, card, { managed: null });
    const merged = run.cards.map(id => board.cards(c).find(card => card.id === id)).filter(card => card?.column === 'done').length;
    this.save(c, run, { status: 'handed', reason: clip(reason, 400), merged, endedAt: new Date().toISOString() });
    const done = merged ? ` Flow had finished ${merged} of ${run.cards.length} parts, and they stay in your folder.` : '';
    this.broker.message(c, 'system', `${clip(reason, 400)}${done} The parts are on the Plan as “${run.group}” for you to finish: merge, send back or discard each one there.`);
  }

  // One answer in the chat, as one message would have given, then the parts leave the Plan and Tasks.
  finish(c, run, { review, note = null, nothingChanged = false }) {
    const board = this.board, cards = run.cards.map(id => board.cards(c).find(card => card.id === id)).filter(Boolean);
    const folder = this.broker.workspaceFolders.find(item => item.id === run.folderId), where = folder ? folder.displayName || folder.name : 'the folder';
    const lines = [nothingChanged ? `Flow did this in ${cards.length} parts side by side. None of them changed a file.` : `Flow did this in ${cards.length} parts side by side and merged them into ${where}.`];
    const files = new Set();
    for (const [index, card] of cards.entries()) {
      const task = board.task(c, card), answer = board.answer(c, card.id);
      for (const file of task?.stepResult?.files || []) files.add(file);
      const who = [NAMES[task?.provider] || task?.provider, task?.model].filter(Boolean).join(' · '), count = card.result?.files;
      lines.push('', `**${index + 1}. ${card.title}**${who ? ` · ${who}` : ''}${Number.isInteger(count) ? ` · ${plural(count, 'file')}` : ''}`, '', excerpt(answer.text) || 'It gave no report.');
    }
    const reviewTask = review ? board.task(c, review) : null, verdict = reviewTask?.review || null, check = reviewTask?.stepCheck || null;
    for (const task of (c.parallelTasks || []).filter(item => item.splitId === run.id && item.splitRepair)) for (const file of task.stepResult?.files || []) files.add(file);
    if (review) {
      const by = NAMES[reviewTask?.provider] || reviewTask?.provider || 'An agent', alone = reviewTask && !board.reviews.independent(c, review, reviewTask.provider) ? ' It ran on an agent that also built a part, as no other was available.' : '';
      let said;
      if (note) said = note;
      else if (check?.outcome === 'failed') said = 'The tests failed on the combined result, so the review’s verdict wasn’t read. Its report is in its conversation.';
      else if (verdict?.status === 'passed') said = verdict.earlier?.length ? `${by} found ${plural(verdict.earlier.length, 'problem')}; one repair round fixed ${verdict.earlier.length === 1 ? 'it' : 'them'}.` :`${by} found nothing that must change.`;
      else if (verdict?.findings?.length) said = [`${by} still found ${plural(verdict.findings.length, 'problem')}${verdict.round ? ' after the repair round' : ''}:`, ...verdict.findings.map(item => `- ${item.problem}${item.fix ? ` Fix: ${item.fix}` : ''}${item.file ? ` (\`${item.file}\`)` : ''}`)].join('\n');
      else said = verdict?.reason || `${by} didn’t end with a verdict. Its report is in its conversation.`;
      lines.push('', `**Review** · ${said}${alone}`);
    }
    if (check?.command) lines.push('', `**Tests** · \`${check.command}\` ${check.outcome === 'passed' ? 'passed' : check.outcome === 'failed' ? `failed${check.exitCode !== null && check.exitCode !== undefined ? ` (exit code ${check.exitCode})` : ''}` : 'didn’t give a result'} on the combined result.`);
    else if (review && check?.reason) lines.push('', `**Tests** · ${clip(check.reason, 300)}`);
    if (files.size) { const list = [...files]; lines.push('', `**Changed** · ${list.slice(0, 20).map(file => `\`${file}\``).join(', ')}${list.length > 20 ? ` and ${list.length - 20} more` : ''}`); }
    const problems = Boolean(note || check?.outcome === 'failed' || (verdict && verdict.status !== 'passed'));
    this.broker.record(c, { type: 'message', message: { id: randomUUID(), role: 'assistant', text: lines.join('\n'), splitResult: { id: run.id, parts: cards.length }, status: 'complete', createdAt: new Date().toISOString() } });
    if (review?.column === 'review') { try { board.accept(c, review.id, { by: 'flow' }); } catch { /* It leaves the Plan below either way. */ } }
    // The parts and the review leave the Plan; their tasks stay readable from the answer, out of the Tasks list.
    for (const id of [...run.cards, ...(run.reviewCardId ? [run.reviewCardId] : [])]) { try { board.remove(c, id); } catch { /* A card still working stays. */ } }
    for (const task of (c.parallelTasks || []).filter(item => item.splitId === run.id && !item.closed && !LIVE.has(item.status) && !(item.mode === 'worktree' && item.status === 'complete'))) this.tasks.update(c, task, { closed: true });
    this.save(c, run, { status: 'finished', outcome: problems ? 'attention' : 'done', endedAt: new Date().toISOString() });
  }
}

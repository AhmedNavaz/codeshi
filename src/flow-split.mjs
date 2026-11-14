import { randomUUID } from 'node:crypto';
import { REVIEW_CARD, SplitFinish, applySplitRunRecord } from './split-finish.mjs';

// Flow splitting a request (#107 stage 2, #108). On Smart and Ultra every Flow message is rated by a small model before it
// runs (routing-assessment.mjs). When the desktop composer allows it, that same rating can also name the request's separate
// parts: pieces of work different agents could do at the same time. Nothing starts from them by itself. Codeshi shows the
// parts, the agent and model routing would pick for each and what each is billed to, and you choose to run them as tasks
// side by side or as one message. Running them makes them cards in a group named after the message, with one review of the
// combined result after them, and they share the message's task limits (#87). Flow finishes them by itself and answers once
// (src/split-finish.mjs), so they stay off the Plan and out of Tasks unless something needs you. Splitting without asking
// is a preference you turn on first, and it applies only when every part would use an agent on a subscription.
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const TIERS = ['light', 'standard', 'deep'];
export const SPLIT_LIMITS = { parts: 4, title: 120, instructions: 4000, group: 60 };
const clip = (value, limit) => { const flat = String(value || '').trim(); return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat; };

// What the rater may add to its answer. Every property is required, as structured output asks: no split is an empty list.
export const partsSchema = { type: 'array', items: { type: 'object', additionalProperties: false,
  properties: { title: { type: 'string' }, instructions: { type: 'string' }, tier: { type: 'string', enum: TIERS }, dependsOn: { type: 'array', items: { type: 'integer' } } },
  required: ['title', 'instructions', 'tier', 'dependsOn'] } };
export const splitGuidance = `parts: almost always []. List 2 to ${SPLIT_LIMITS.parts} parts only when the request itself asks for separate pieces of work that different agents could do at the same time, each complete and testable on its own, such as unrelated fixes or features in different areas. Never split one change into steps, a single bug, a question, a review, a plan request, or work whose parts would all edit the same code. Each part has title (short), instructions (self-contained: everything from the request that part needs, as its agent sees nothing else; at most ${SPLIT_LIMITS.instructions} characters), tier (light, standard or deep, as above) and dependsOn (the numbers of earlier parts it needs finished first, starting at 1; usually empty).`;

// The parts as the rater gave them, or none. A rating is still used when its parts aren't: a list that breaks a rule means
// the request runs as one message, never a split repaired by guessing.
export function readParts(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > SPLIT_LIMITS.parts) return [];
  const parts = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const title = typeof raw.title === 'string' ? raw.title.trim() : '', instructions = typeof raw.instructions === 'string' ? raw.instructions.trim() : '';
    if (!title || title.length > SPLIT_LIMITS.title || !instructions || instructions.length > SPLIT_LIMITS.instructions || !TIERS.includes(raw.tier)) return [];
    const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn : [];
    if (dependsOn.some(number => !Number.isSafeInteger(number) || number < 1 || number > index) || new Set(dependsOn).size !== dependsOn.length) return [];
    parts.push({ title, instructions, tier: raw.tier, dependsOn: [...dependsOn] });
  }
  // Parts that all wait for one another in a line are one change in steps, which one agent does better in order.
  if (parts.every((part, index) => index === 0 || part.dependsOn.includes(index))) return [];
  return parts;
}

// The group the parts share on the Plan: the message's first line, made unique among the Plan's open groups.
export function groupName(text, taken = new Set()) {
  const first = String(text || '').trim().split('\n')[0].replace(/\s+/g, ' ');
  const base = clip(first || 'Split request', SPLIT_LIMITS.group - 4);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) { const name = `${base} (${n})`; if (!taken.has(name)) return name; }
  return `${base} (${randomUUID().slice(0, 4)})`;
}

// Applying the journal: one proposal is open at a time, and a new message replaces it.
export function applySplitRecord(c, record) {
  if (record.type === 'split_proposal') c.splitProposal = { ...record.proposal, createdAt: record.at };
  if (record.type === 'split_proposal_end' && c.splitProposal?.id === record.id) {
    c.splitHistory = [...(c.splitHistory || []), { id: record.id, outcome: record.outcome, cards: record.cards || [], group: record.group || null, at: record.at }].slice(-20);
    c.splitProposal = null;
  }
  if (record.type === 'split_preference') c.splitPreference = { auto: record.auto === true, at: record.at };
  applySplitRunRecord(c, record);
}

export class FlowSplits {
  constructor(broker) { this.broker = broker; this.acting = new Set(); this.finisher = new SplitFinish(broker); this.finisher.restore(); }

  // Whether this message may come back as parts: only the desktop composer asks (allowSplit), in the workspace chat, for a
  // new message rated by an agent. A queued prompt, a retry, a plan, a card, a message with attachments or one with Review
  // after runs exactly as you wrote it.
  allowed(c, input, options, policy) {
    const broker = this.broker;
    return input.allowSplit === true && Boolean(broker.tasks && broker.board) && !options.queued && !options.execution && !input.orchestrate && !input.automaticReview && !input.routing?.planned
      && !(input.attachments?.length) && !input.splitOf && policy?.mode === 'flow' && policy.automation?.children === true && !policy.override;
  }

  // What routing would pick for each part now, from the same readings as the message. Each part is chosen again when it
  // starts, as any Auto card is, so this is what you're shown, not a promise.
  preview(c, input, parts, candidates, routingMode) {
    const allowApi = c.routing?.allowApi === true || input.routing?.allowApi === true;
    return parts.map(part => {
      const choice = globalThis.relayRouting.route({ text: part.instructions, assessment: { tier: part.tier, effort: { light: 'low', standard: 'medium', deep: 'high' }[part.tier], reason: 'a part of a split request' }, mode: routingMode, candidates, allowApi });
      if (choice.error) return { error: clip(choice.error, 300) };
      const row = candidates.find(item => item.provider === choice.provider);
      return { provider: choice.provider, model: choice.model || null, modelName: choice.modelName || null, effort: choice.effort || null, billing: row?.billingSource || 'unknown', quota: choice.quota?.state || 'unknown' };
    });
  }

  // Saves the proposal. Nothing is started, so a restart finds it waiting for you.
  propose(c, input, { taskId, execution, assessment, parts, picks, routingMode }) {
    const { parts: _, ...rating } = assessment;
    const id = randomUUID();
    const request = { text: input.text, provider: input.provider || null, mode: input.mode, approvalPolicy: input.approvalPolicy, billingConfirmed: input.billingConfirmed === true, routing: { mode: routingMode, ...(input.routing?.allowApi === true ? { allowApi: true } : {}) } };
    const proposal = { id, requestId: input.requestId, taskId, execution, assessment: rating, routingMode, request, parts: parts.map((part, index) => ({ ...part, pick: picks[index] })) };
    this.broker.record(c, { type: 'split_proposal', proposal });
    return proposal;
  }

  // Split without asking: only when you turned it on, and only when every part would use an agent on a subscription
  // with room left, as automatic handoff does.
  automatic(c, picks) {
    return c.splitPreference?.auto === true && picks.every(pick => !pick.error && pick.billing === 'subscription' && pick.quota === 'ok');
  }

  prefer(c, { auto } = {}) {
    if (typeof auto !== 'boolean') throw fail('Choose whether Flow splits without asking.', 400);
    this.broker.record(c, { type: 'split_preference', auto });
    this.broker.emit('update', { conversationId: c.id });
    return this.broker.view(c);
  }

  // Your answer: run the parts as tasks, do it as one message, or put it away. Each answers only the proposal it was shown.
  async act(c, { id, action, billingConfirmed = false, folderId = null } = {}) {
    const proposal = c.splitProposal;
    if (!proposal || proposal.id !== id) throw fail('This suggestion is no longer open. Send the message again.');
    if (!['tasks', 'one', 'dismiss'].includes(action)) throw fail('Run the parts as tasks, do it as one, or dismiss it.', 400);
    if (this.acting.has(c.id)) throw fail('Wait for the last answer to finish.');
    this.acting.add(c.id);
    try {
      if (action === 'dismiss') { this.broker.record(c, { type: 'split_proposal_end', id, outcome: 'dismissed' }); this.broker.emit('update', { conversationId: c.id }); return { view: this.broker.view(c), text: proposal.request.text }; }
      if (action === 'one') return await this.asOne(c, proposal);
      return this.asTasks(c, proposal, { billingConfirmed: billingConfirmed === true, folderId, by: 'you' });
    } finally { this.acting.delete(c.id); }
  }

  // The message runs as it would have, with the rating it already has, so nothing is rated twice.
  async asOne(c, proposal) {
    const broker = this.broker;
    if (broker.running) throw fail('An assistant is already working in this workspace. Wait for it, or stop it, then try again.');
    broker.record(c, { type: 'split_proposal_end', id: proposal.id, outcome: 'one' });
    const input = { ...proposal.request, requestId: `split-${proposal.id}`, executionRevision: broker.execution.defaults(c).revision, splitOf: proposal.id };
    const accepted = await broker.dispatch(c, input, { splitRating: proposal.assessment, ...(broker.execution.current(c, proposal.taskId) ? { execution: broker.execution.token(c, proposal.taskId) } : {}) });
    return { view: broker.view(c), accepted };
  }

  // The parts become cards in Ready, on Auto in the message's mode, each waiting for the parts it needs, and run at once as
  // tasks. A Reviewer card waits for all of them and checks the combined result; routing gives it another agent than the
  // parts' when one can take it. They count toward Tasks at once like any task, and toward the message's own limits together.
  // Flow then finishes them by itself (src/split-finish.mjs): the cards are marked as Flow's, which keeps them off the Plan
  // until something needs you.
  asTasks(c, proposal, { billingConfirmed, folderId = null, by }) {
    const broker = this.broker, board = broker.board, parts = proposal.parts;
    if (board.cards(c).length + parts.length + 1 > 300) throw fail(`The Plan has room for ${Math.max(0, 300 - board.cards(c).length)} more cards. Remove some finished ones, or do it as one message.`);
    if (c.planClosed) throw fail('The Plan is closed to agents, so its cards can’t run. Open it to agents, or do it as one message.');
    const unpicked = parts.findIndex(part => part.pick?.error || !part.pick?.provider);
    if (unpicked >= 0) throw fail(`Routing found no agent for part ${unpicked + 1}: ${parts[unpicked].pick?.error || 'nothing could take it'}. Do it as one message, or refresh plan usage and send it again.`);
    const charged = parts.filter(part => part.pick.billing !== 'subscription').length;
    if (charged && !billingConfirmed && c.routing?.allowApi !== true) throw fail(`${charged === 1 ? 'One part uses' : `${charged} parts use`} an agent that bills by use, or whose billing couldn’t be confirmed. Confirm it to run them.`, 409);
    const folders = broker.workspaceFolders, folder = folderId || (folders.length === 1 ? folders[0].id : null);
    if (!folder || !folders.some(item => item.id === folder)) throw Object.assign(fail('Choose the folder these parts work in.', 400), { details: { folderChoice: true } });
    const taken = new Set(board.cards(c).filter(card => card.group).map(card => card.group)), group = groupName(proposal.request.text, taken);
    const source = { kind: 'flow-split', splitId: proposal.id, goal: clip(proposal.request.text, 4000), summary: `Split from one message into ${parts.length} parts that run side by side, then one review of the combined result.` };
    const managed = { splitId: proposal.id }, ids = [];
    let reviewId = null;
    try {
      for (const [index, part] of parts.entries()) {
        const card = board.create(c, { title: part.title, notes: part.instructions, tier: part.tier, auto: true, routingMode: proposal.routingMode, group, folderId: folder, column: 'ready', dependsOn: part.dependsOn.map(number => ids[number - 1]) }, { createdBy: 'agent', source, splitPart: index + 1, managed });
        ids.push(card.id);
      }
      reviewId = board.create(c, { ...REVIEW_CARD, role: 'reviewer', tier: 'standard', auto: true, routingMode: proposal.routingMode, group, folderId: folder, column: 'ready', dependsOn: [...ids] }, { createdBy: 'agent', source, managed }).id;
      // The review is chosen again when it starts, away from the parts' agents; until then it is counted as the first part's.
      const assignments = Object.fromEntries([...ids.map((cardId, index) => [cardId, { provider: parts[index].pick.provider, model: parts[index].pick.model, effort: parts[index].pick.effort }]), [reviewId, { provider: parts[0].pick.provider, model: parts[0].pick.model, effort: parts[0].pick.effort }]]);
      const access = { mode: proposal.request.mode, approvalPolicy: proposal.request.approvalPolicy };
      board.run(c, { ids: [...ids, reviewId], executionRevision: broker.execution.defaults(c).revision, assignments, billingConfirmed: billingConfirmed || charged === 0 }, { access, source: by === 'flow' ? 'flow-split' : 'split', parent: { taskId: proposal.taskId, execution: proposal.execution, splitId: proposal.id, automatic: by === 'flow' } });
    } catch (error) {
      for (const cardId of [...ids, ...(reviewId ? [reviewId] : [])]) { try { board.remove(c, cardId); } catch { /* A card that ran stays, with its task. */ } }
      throw error;
    }
    this.finisher.begin(c, { proposal, group, cards: ids, reviewCardId: reviewId, folderId: folder, by });
    broker.record(c, { type: 'split_proposal_end', id: proposal.id, outcome: 'tasks', cards: ids, group });
    // The message you sent is saved with the split, not when it was rated, so doing it as one never shows it twice.
    broker.record(c, { type: 'message', message: { id: randomUUID(), role: 'user', text: proposal.request.text, splitId: proposal.id, status: 'complete', createdAt: new Date().toISOString() } });
    broker.message(c, 'system', `${by === 'flow' ? 'Flow split this' : 'Split this'} into ${parts.length} parts that run side by side${parts.some(part => part.dependsOn.length) ? ', each after the parts it needs' : ''}. Flow merges each one when it’s safe, reviews the combined result, and answers here.`);
    broker.emit('update', { conversationId: c.id });
    return { view: broker.view(c), cards: ids, group };
  }
}

import { randomUUID } from 'node:crypto';
import { routingNote } from './broker.mjs';

// Prompts queued for a workspace (#32). They run one after another: each with the agent, model, effort, access and
// permission setting chosen when it was queued, never more. A run that reaches a usage limit waits for a reset and
// the queue carries on; any other stop pauses the queue, as does a restart, so queued work never continues blindly.
// The queue lives in the conversation journal, so it survives restarts and runs while the window is closed.
export const QUEUE_LIMIT = 20;

export class PromptQueue {
  constructor(broker) { this.broker = broker; this.closed = false; }

  // Work queued when the app last closed waits for the person to resume it.
  restore() {
    for (const c of this.broker.conversations.values()) if (c.queue.length && !c.queuePaused) this.pause(c, 'Throughline restarted while prompts were queued.');
  }

  pause(c, reason) {
    this.broker.record(c, { type: 'queue_pause', reason: String(reason).slice(0, 300) });
    this.broker.emit('update', { conversationId: c.id });
  }

  item(c, id) {
    const item = c.queue.find(entry => entry.id === id);
    if (!item) throw Object.assign(new Error('This queued prompt has already started or been removed.'), { status: 409 });
    return item;
  }

  act(c, input = {}) {
    const broker = this.broker, action = input.action;
    if (action === 'add') {
      if (c.queue.length >= QUEUE_LIMIT) throw Object.assign(new Error(`A workspace can queue up to ${QUEUE_LIMIT} prompts.`), { status: 409 });
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 100000) throw Object.assign(new Error('Enter a message between 1 and 100,000 characters.'), { status: 400 });
      const provider = input.provider || c.provider, mode = input.mode || c.mode, approvalPolicy = input.approvalPolicy || c.approvalPolicy || 'ask';
      const model = input.model || null, effort = input.effort || null, attachments = Array.isArray(input.attachments) ? input.attachments : [];
      broker.checkRunSettings(provider, mode, approvalPolicy);
      broker.validateSelection(model, 'auto', effort);
      broker.attachments.select(attachments);
      const routing = routingNote(input.routing);
      broker.record(c, { type: 'queue_add', item: { id: randomUUID(), text, provider, model, effort, mode, approvalPolicy, attachments, billingConfirmed: input.billingConfirmed === true, ...(routing ? { routing } : {}), createdAt: new Date().toISOString() } });
    } else if (action === 'update') {
      this.item(c, input.id);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 100000) throw Object.assign(new Error('Enter a message between 1 and 100,000 characters.'), { status: 400 });
      broker.record(c, { type: 'queue_update', id: input.id, text });
    } else if (action === 'move') {
      this.item(c, input.id);
      const index = Number(input.index);
      if (!Number.isInteger(index) || index < 0 || index >= c.queue.length) throw Object.assign(new Error('Choose a position in the queue.'), { status: 400 });
      broker.record(c, { type: 'queue_move', id: input.id, index });
    } else if (action === 'remove') {
      this.item(c, input.id);
      broker.record(c, { type: 'queue_remove', id: input.id });
    } else if (action === 'pause') {
      if (!c.queuePaused) this.pause(c, 'You paused the queue.');
    } else if (action === 'resume') {
      if (c.queuePaused) broker.record(c, { type: 'queue_resume' });
    } else throw Object.assign(new Error('Choose add, update, move, remove, pause or resume.'), { status: 400 });
    broker.emit('update', { conversationId: c.id });
    this.tick(c);
    return broker.view(c);
  }

  // Starts the next prompt when the workspace is free: nothing running, no wait for a reset, and the queue not paused.
  tick(c) {
    const broker = this.broker;
    if (this.closed || !c.queue.length || c.queuePaused || broker.running || c.resume || c.runs.some(run => ['building', 'reviewing'].includes(run.automaticReview?.status))) return;
    const item = c.queue[0];
    try {
      const { runId } = broker.start(c, { text: item.text, provider: item.provider, model: item.model, effort: item.effort, mode: item.mode, approvalPolicy: item.approvalPolicy, attachments: item.attachments, billingConfirmed: item.billingConfirmed, routing: item.routing || null, requestId: `queue-${item.id}` }, { queued: item.id });
      broker.record(c, { type: 'queue_started', id: item.id, runId });
      broker.emit('update', { conversationId: c.id });
    } catch (error) {
      if (error.status === 409 && broker.running) return;
      this.pause(c, `The next prompt could not start: ${error.message}`);
      broker.emit('notify', { conversationId: c.id, kind: 'stopped', title: 'Queue paused', body: 'The next queued prompt could not start. Open the workspace to see why.' });
    }
  }

  // After a run: carry on when it finished, wait for a reset when it reached a limit, and pause otherwise.
  runEnded(c, run, status) {
    // A handoff stops a run on purpose and continues the task, so the queue waits for that run instead of pausing.
    if (run.review || run.handoff || !c.queue.length || c.queuePaused) return;
    if (status === 'complete') { setTimeout(() => this.tick(c), 0); return; }
    if (run.errorCategory === 'quota') {
      if (!c.resume) {
        try { this.broker.resume.schedule(c, { providers: this.broker.availableProviders(), mode: run.mode, approvalPolicy: run.approvalPolicy, billingConfirmed: run.billingConfirmed === true }); }
        catch (error) { this.pause(c, `Waiting for a reset could not start: ${error.message}`); }
      }
      return;
    }
    this.pause(c, run.stopped ? 'You stopped the run.' : 'The last run did not finish.');
  }

  close() { this.closed = true; }
}

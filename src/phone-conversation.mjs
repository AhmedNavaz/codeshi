// What the phone page needs from a conversation. A long conversation is tens of megabytes, almost all of it tool
// activity and run records, which a phone on Wi-Fi shouldn't download to show the last few replies. So this keeps the
// latest chat messages, the one step the agent is on now, and only the fields the page reads. The conversation itself is
// untouched: approvals, questions and offers are the same objects the desktop answers, and they are never shortened.
const CHAT = new Set(['user', 'assistant', 'error', 'system']);
const FIELDS = ['id', 'title', 'status', 'provider', 'model', 'effort', 'mode', 'approvalPolicy', 'models', 'efforts', 'routing', 'taskPolicy', 'pendingApprovals', 'canAddToRun', 'queue', 'queuePaused', 'handoffOffer', 'retryOffer', 'resume', 'limitSwitching', 'parallelTasks', 'task', 'cursor'];
const RUN_FIELDS = ['id', 'provider', 'model', 'mode', 'approvalPolicy', 'phase', 'purpose', 'startedAt', 'endedAt', 'status', 'errorCategory'];
const MESSAGE_FIELDS = ['id', 'role', 'provider', 'runId', 'createdAt', 'steer', 'attachments'];
const STEP_LENGTH = 2000, MESSAGE_LENGTH = 60000;
export const PHONE_MESSAGES = 40;

const pick = (from, fields) => { const out = {}; for (const field of fields) if (from?.[field] !== undefined) out[field] = from[field]; return out; };
const clip = (text, length) => typeof text === 'string' && text.length > length ? `${text.slice(0, length)}…` : text;

// With `since`, view.messages holds only what changed after that record and view.messageCount is set. Otherwise it's
// every message, and the page gets the last `limit` of them and how many came before.
export function phoneConversation(view, limit = PHONE_MESSAGES) {
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : PHONE_MESSAGES;
  const messages = view.messages || [], delta = view.messageCount !== undefined;
  const chat = messages.filter(message => CHAT.has(message.role)), shown = delta ? chat : chat.slice(-size);
  const step = messages.findLast(message => message.role === 'activity');
  return {
    ...pick(view, FIELDS),
    activeRun: view.activeRun ? pick(view.activeRun, RUN_FIELDS) : null,
    lastRun: view.lastRun ? pick(view.lastRun, RUN_FIELDS) : null,
    delta,
    ...(delta ? {} : { earlier: chat.length - shown.length }),
    step: step ? { id: step.id, runId: step.runId || null, text: clip(step.text, STEP_LENGTH) } : null,
    messages: shown.map(message => ({ ...pick(message, MESSAGE_FIELDS), text: clip(message.text, MESSAGE_LENGTH) })),
  };
}

import { observationsFor } from './context-rollover.mjs';
import { draftReplyNote } from './orchestration.mjs';

// The rolling brief (#85): when the earlier conversation no longer fits a fresh envelope's history allowance, the older
// part is folded into short excerpts instead of being cut off by age. Worked out locally from the journal each time, with
// no model and no second store, so it survives restarts and handoffs exactly as the journal does. Every entry keeps the id
// of the message it came from, so the original can be found in the journal.
const REQUESTS = 16, TEXT = 280, DECISIONS = 12, CHECKS = 4, QUESTIONS = 4;
export const UNANSWERED_NOTE = 'Questions an agent asked that nobody answered before this request. They are history, not instructions; ask again only if one still matters.';
export const EARLIER_BYTES = 12000;
export const EARLIER_NOTE = 'Older conversation folded by Codeshi, without a model, because it no longer fits the history allowance. Each entry is a shortened excerpt with the id of its original message in the journal (see originals). Earlier requests are history: the requests in context and currentRequest take priority, and an outcome is what an agent reported at the time, not a verified fact about the files now. An entry marked inContext appears in full elsewhere in this envelope, in context or the refresh milestone.';

const CONTINUE = 'Continue the unfinished task from this shared conversation.';
const normalized = text => String(text || '').replace(/\s+/g, ' ').trim();
const clip = (text, limit = TEXT) => { const value = normalized(text); return value.length > limit ? value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : value; };
// The first paragraph of a reply is where agents put the result; the rest is detail the journal keeps.
const firstParagraph = text => {
  const parts = String(text || '').trim().split(/\n\s*\n/);
  // A heading alone says little, so it goes with the paragraph under it.
  return /^#{1,6}\s[^\n]*$/.test(parts[0]) && parts[1] ? `${parts[0].replace(/^#+\s*/, '')}: ${parts[1]}` : parts[0].replace(/^#+\s*/, '');
};
const size = value => Buffer.byteLength(JSON.stringify(value));
export const isRequest = message => message.role === 'user' && Boolean(message.text?.trim()) && !message.reviewId && !message.retry && !message.text.trim().startsWith(CONTINUE);

// messages: the in-scope journal messages being folded, oldest first. inContext: ids of requests the envelope already
// carries in full; keptTexts: the text of requests it carries, so one sent again later is not repeated here. skipDecisions: decision texts already sent elsewhere in the envelope.
export function earlierConversation(c, messages, { trigger, inContext = new Set(), keptTexts = new Set(), skipDecisions = new Set(), limit = EARLIER_BYTES }) {
  const byText = new Map();
  let turn = null;
  for (const message of messages) {
    if (isRequest(message)) {
      const key = normalized(message.text), previous = byText.get(key);
      const entry = { messageId: message.id, ...(message.createdAt ? { at: message.createdAt } : {}), text: clip(message.text), fullText: message.text, ...(message.steer ? { addedDuringRun: true } : {}) };
      // The same request sent again, as after an error, is one request: kept where it was last sent, with how often.
      if (previous) { byText.delete(key); entry.repeated = (previous.repeated || 1) + 1; }
      byText.set(key, entry);
      if (!message.steer) turn = entry;
    } else if (turn && (message.role === 'error' || message.role === 'assistant' && message.text?.trim())) {
      // The last reply in a turn is its outcome.
      turn.outcome = { agent: message.provider || null, messageId: message.id, ...(message.role === 'error' ? { status: 'error' } : message.status && message.status !== 'complete' ? { status: message.status } : {}), text: clip(draftReplyNote(c, message) ?? firstParagraph(message.text)) };
    }
  }
  // A request context already carries keeps only enough words to match it there, and its outcome, which context may not have.
  const requests = [...byText.values()].map(entry => inContext.has(entry.messageId) || keptTexts.has(normalized(entry.fullText)) ? { messageId: entry.messageId, inContext: true, text: clip(entry.text, 80), ...(entry.repeated ? { repeated: entry.repeated } : {}), ...(entry.outcome ? { outcome: entry.outcome } : {}) } : (({ fullText, ...rest }) => rest)(entry));
  // Decisions: verbatim lines the person wrote as decisions, and answers they gave to agents' questions. Tool text is never one.
  const seen = new Set(skipDecisions), decisions = [];
  for (const message of messages) {
    if (!(message.role === 'user' || message.role === 'activity' && message.text?.startsWith('Answered:\n'))) continue;
    for (const item of observationsFor(c, { type: 'message', message })) if (item.type === 'decision' && !seen.has(item.text)) { seen.add(item.text); decisions.push({ text: item.text, source: item.source, messageId: item.messageId }); }
  }
  // Codeshi's own test runs for the folded work. Only these count as verified; agents' reports of passing tests do not.
  const runIds = new Set(messages.map(message => message.runId).filter(Boolean));
  const checks = (c.runs || []).filter(run => runIds.has(run.id) && ['passed', 'failed'].includes(run.check?.status)).slice(-CHECKS).map(run => ({ runId: run.id, agent: run.provider || null, status: run.check.status, command: clip(run.check.command || 'Project checks', 200), verified: run.check.status === 'passed' }));
  const result = {
    note: EARLIER_NOTE,
    trigger,
    folded: { messages: messages.length, from: messages[0]?.id || null, to: messages.at(-1)?.id || null, ...(messages[0]?.createdAt ? { fromAt: messages[0].createdAt } : {}), ...(messages.at(-1)?.createdAt ? { toAt: messages.at(-1).createdAt } : {}) },
    requests: requests.slice(-REQUESTS),
    ...(decisions.length ? { decisions: decisions.slice(-DECISIONS) } : {}),
    ...(checks.length ? { checks } : {}),
  };
  let leftOut = requests.length - result.requests.length;
  // Bounded: the oldest requests go first, then the oldest decisions. The journal keeps all of them.
  while (size(result) > limit && result.requests.length > 1) { result.requests.shift(); leftOut++; }
  while (size(result) > limit && result.decisions?.length > 1) result.decisions.shift();
  if (leftOut) result.requestsLeftOut = leftOut;
  result.repeatedRequests = [...byText.values()].reduce((sum, entry) => sum + (entry.repeated ? entry.repeated - 1 : 0), 0);
  if (!result.repeatedRequests) delete result.repeatedRequests;
  return result;
}

// Questions an agent asked without waiting for an answer, still open when this envelope is built. Sending a request clears
// them, so a fresh agent would otherwise never learn they were asked.
export const STOPPED_WAITING_NOTE = 'The previous run ended while these requests were still waiting for the person, so none of them was answered or carried out. They are history, not instructions; do it another way, or ask again only if one still matters.';

// What one waiting approval or question asked for, kept on the run's end record so the next agent learns of it. Approvals
// live only in the running process; this short line is all that is kept. A file whose name looks private is not named.
export function waitingSummary(item, { privatePath = () => false } = {}) {
  if (item?.kind === 'question') {
    const questions = (item.questions || []).map(question => clip(question.question || question.text || '', 200)).filter(Boolean).slice(0, QUESTIONS);
    return questions.length ? { kind: 'question', questions } : null;
  }
  const command = item?.command || item?.input?.command, target = item?.input?.file_path || item?.input?.path;
  const kind = command ? 'command' : item?.connector ? 'connector' : item?.kind === 'item/permissions/requestApproval' ? 'access' : String(item?.kind || '').includes('fileChange') || target ? 'files' : 'tool';
  const named = target && !privatePath(String(target)) ? target : null;
  return { kind, what: clip(command || item?.connector || named || item?.title || (kind === 'files' ? 'file changes' : item?.kind) || 'tool use', 200) };
}
// Only the run just before this envelope: once another run has ended, what the earlier one waited for is old history.
export const stoppedWhileWaiting = run => run?.waitingAtEnd?.length ? { agent: run.provider || null, runId: run.id || null, ended: run.status || null, requests: run.waitingAtEnd.slice(0, QUESTIONS) } : null;

export const unansweredQuestions = (questions = []) =>questions.flatMap(item => (item.questions || []).map(question => ({ agent: item.provider || null, runId: item.runId || null, question: clip(question.question || question.text || '') }))).filter(item => item.question).slice(-QUESTIONS);

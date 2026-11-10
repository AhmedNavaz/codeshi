import { createHash } from 'node:crypto';
import { continuationRequest } from './context.mjs';
import '../public/routing.js';

// Suggestions (#106): at a pause after a run, one line that points to a feature fitting what just happened. Each comes from
// local rules on what the conversation already recorded, with no model call, and says what it saw. Nothing here changes a
// setting: trying one opens a step that shows what will change, and the person decides there.
//
// Few of them: one at a time, at most DAILY new ones a day across workspaces, and one that was shown and ignored waits
// QUIET_DAYS before it can appear again. Dismissing one keeps it away for good, and Settings turns them all off.
export const DAILY = 2;
const QUIET_DAYS = 7, SHOWN_KEPT = 60, DISMISSED_KEPT = 500, RECENT_MESSAGES = 120;
const FLOW_RUNS = 8, FLOW_MATCHES = 3, MEMORY_TIMES = 2, SKILL_TIMES = 3, SKILL_STEPS = 3;
const STRONG_EFFORTS = ['high', 'xhigh', 'max', 'ultra'];
const STOP_WORDS = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'have', 'will', 'should', 'would', 'could', 'there', 'their', 'then', 'them', 'they', 'when', 'what', 'which', 'into', 'also', 'only', 'make', 'each', 'some', 'please', 'after', 'before', 'are', 'was', 'you', 'your', 'our', 'its', 'not', 'any', 'all', 'can', 'but', 'just']);
const RULE = /\b(always|never|don'?t|do not|make sure|remember (?:that|to)|convention|prefer|avoid|must|instead of)\b/i;
const STEP = /^\s*(?:\d+[.)]|[-*•])\s+(\S.*)$/;

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const wordsOf = text => new Set((String(text || '').toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []).filter(word => !STOP_WORDS.has(word)));
const similarity = (a, b) => { if (!a.size || !b.size) return 0; let shared = 0; for (const word of a) if (b.has(word)) shared++; return shared / (a.size + b.size - shared); };
const quote = text => { const clean = text.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, ''); return clean.length > 90 ? `${clean.slice(0, 87).trimEnd()}…` : clean; };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What the person wrote themselves: not a continuation, a retry, a review request, an imported or rewound message.
function written(c) {
  return (c.messages || []).filter(message => message.role === 'user' && message.text && !message.rewound && !message.imported && !message.retry && !message.reviewId && !message.continuation && message.text !== continuationRequest).slice(-RECENT_MESSAGES);
}

// "Remember this": the same rule written in two messages. A sentence counts as a rule when it says always, never, prefer,
// avoid and the like, and two count as the same when most of their words match.
export function memoryTip(c) {
  const messages = written(c), latest = messages.at(-1);
  if (!latest) return null;
  const saved = (c.memory || []).filter(entry => entry.status === 'active').map(entry => wordsOf(entry.text));
  const groups = [];
  for (const message of messages) {
    const sentences = message.text.split(/\n+|(?<=[.!?])\s+/).map(item => item.replace(STEP, '$1').trim()).filter(item => item.length >= 12 && item.length <= 400 && RULE.test(item));
    for (const sentence of sentences) {
      const words = wordsOf(sentence);
      if (words.size < 3) continue;
      const group = groups.find(item => similarity(item.words, words) >= 0.75);
      if (group) { group.messages.add(message.id); group.text = sentence; group.messageId = message.id; }
      else groups.push({ words, text: sentence, messages: new Set([message.id]), messageId: message.id });
    }
  }
  const found = groups.filter(group => group.messages.size >= MEMORY_TIMES && group.messages.has(latest.id) && !saved.some(words => similarity(words, group.words) >= 0.6)).sort((a, b) => b.messages.size - a.messages.size)[0];
  if (!found) return null;
  const times = found.messages.size;
  return { key: `memory:${hash([...found.words].sort().join(' '))}`, kind: 'memory',
    text: `You’ve written “${quote(found.text)}” in ${plural(times, 'message')}. Remember it, and every agent in this workspace will know it without being told again.`,
    action: 'Remember…', memory: { kind: 'convention', text: found.text.trim(), messageId: found.messageId } };
}

// "This could be a skill": the same list of steps given in three messages.
export function skillTip(c) {
  const messages = written(c), latest = messages.at(-1);
  if (!latest) return null;
  const enabled = (c.skills || []).filter(skill => skill.enabled).map(skill => skill.name);
  const groups = [];
  for (const message of messages) {
    if (enabled.some(name => new RegExp(`(?:^|[\\s(])[/$]${name}(?![\\w-])`, 'i').test(message.text))) continue;
    const steps = message.text.split('\n').map(line => line.match(STEP)?.[1]?.trim()).filter(Boolean);
    if (steps.length < SKILL_STEPS) continue;
    const words = wordsOf(steps.join(' '));
    if (words.size < 5) continue;
    const group = groups.find(item => similarity(item.words, words) >= 0.6);
    if (group) { group.messages.add(message.id); group.steps = steps; group.ids.push(message.id); }
    else groups.push({ words, steps, messages: new Set([message.id]), ids: [message.id] });
  }
  const found = groups.filter(group => group.messages.size >= SKILL_TIMES && group.messages.has(latest.id) && !(c.skills || []).some(skill => skill.provenance?.messageIds?.some(id => group.messages.has(id)))).sort((a, b) => b.messages.size - a.messages.size)[0];
  if (!found) return null;
  return { key: `skill:${hash([...found.words].sort().join(' '))}`, kind: 'skill',
    text: `You’ve given these ${found.steps.length} steps in ${plural(found.messages.size, 'message')}. As a skill, any agent can follow them when you type its name.`,
    action: 'Make a skill…', skill: { steps: found.steps.map(step => step.slice(0, 400)).slice(0, 30), messageIds: found.ids.slice(-10) } };
}

// "Flow would pick the model": in Normal, small changes or quick questions sent to a strong model or high effort. The rating
// is Codeshi's local keyword rules, which say "light" only for clear cases, and the line says so rather than promising a saving.
export function flowTip(c) {
  if (c.routing?.mode) return null;
  const messages = written(c), firstMessage = new Map();
  for (const message of messages) if (message.runId && !firstMessage.has(message.runId)) firstMessage.set(message.runId, message);
  const runs = (c.runs || []).filter(run => !run.routing && !run.review && !run.local && run.endedAt && run.status === 'complete' && run.model && firstMessage.has(run.id)).slice(-FLOW_RUNS);
  if (!runs.length || runs.at(-1).id !== c.lastRun?.id) return null;
  const routing = globalThis.relayRouting, strong = run => routing.modelTier({ id: run.model }) === 'deep' || STRONG_EFFORTS.includes(run.effort);
  let previous = null;
  const matched = runs.filter(run => {
    const message = firstMessage.get(run.id), light = routing.classify(message.text, { attachments: message.attachments?.length || 0, context: previous }).tier === 'light';
    previous = message.text;
    return light && strong(run);
  });
  if (matched.length < FLOW_MATCHES || matched.at(-1).id !== c.lastRun.id) return null;
  const models = [...new Set(matched.map(run => run.model))], efforts = [...new Set(matched.map(run => run.effort).filter(Boolean))];
  const on = models.length === 1 ? models[0] : 'strong models', at = efforts.length === 1 && STRONG_EFFORTS.includes(efforts[0]) ? ` at ${efforts[0]} effort` : '';
  return { key: 'flow:strong-for-small', kind: 'flow',
    text: `${matched.length} of your last ${runs.length} messages looked like small changes or quick questions to Codeshi’s rules, and ran on ${on}${at}. Flow chooses the agent, model and effort for each message.`,
    action: 'Try Flow…' };
}

export const candidates = c => [memoryTip(c), skillTip(c), flowTip(c)].filter(Boolean);

export function tipRecords(value) {
  const shown = Array.isArray(value?.shown) ? value.shown.filter(item => item && typeof item.key === 'string' && Number.isFinite(Date.parse(item.at))) : [];
  return { dismissed: Array.isArray(value?.dismissed) ? value.dismissed.filter(key => typeof key === 'string') : [], shown };
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

// The one suggestion for this pause, if any. A suggestion already shown at this pause stays, so a refresh doesn't swap it.
export function chooseTip(c, { on = true, tips, waiting = false, now = Date.now() } = {}) {
  if (!on || waiting || c.activeRun || c.routingPending || c.resume || c.limitSwitching || c.handoffOffer || c.status === 'running' || !c.lastRun?.id || c.lastRun.status !== 'complete') return null;
  const { dismissed, shown } = tipRecords(tips), found = candidates(c).filter(tip => !dismissed.includes(tip.key));
  const here = shown.find(item => item.runId === c.lastRun.id && item.conversationId === c.id), kept = here && found.find(tip => tip.key === here.key);
  if (here) return kept ? { ...kept, runId: c.lastRun.id } : null;
  const recent = new Set(shown.filter(item => now - Date.parse(item.at) < QUIET_DAYS * 86400000).map(item => item.key));
  if (shown.filter(item => sameDay(Date.parse(item.at), now)).length >= DAILY) return null;
  const tip = found.find(item => !recent.has(item.key));
  return tip ? { ...tip, runId: c.lastRun.id } : null;
}

export function markShown(tips, { key, runId, conversationId, now = Date.now() }) {
  const { dismissed, shown } = tipRecords(tips);
  if (shown.some(item => item.key === key && item.runId === runId && item.conversationId === conversationId)) return { dismissed, shown };
  return { dismissed, shown: [...shown, { key, runId, conversationId, at: new Date(now).toISOString() }].slice(-SHOWN_KEPT) };
}
export function dismissTip(tips, key) {
  const { dismissed, shown } = tipRecords(tips);
  return { dismissed: [...new Set([...dismissed, key])].slice(-DISMISSED_KEPT), shown };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareContext, continuationRequest } from '../src/context.mjs';

const envelope = prepared => JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf('\n') + 1));
const conversation = () => ({ provider: 'gemini', mode: 'edit', sessions: {}, context: { summary: 'Current project brief', goal: 'Finish issue 69', decisions: ['Preserve unrelated edits'], tasks: ['Verify handoffs'] }, messages: [] });
const message = (c, role, text, provider = 'codex', extra = {}) => c.messages.push({ seq: c.messages.length + 1, role, text, provider, ...extra });

test('Flow context tells agents how to prepare a saved project review without authorizing a launch', () => {
  const c = conversation(); c.routing = { mode: 'smart' };
  const value = envelope(prepareContext(c, 'Help me review the project'));
  assert.match(value.projectReview, /\.codeshi\/preview.json/); assert.match(value.projectReview, /dependsOn/);
  assert.match(value.projectReview, /person starts the reviewed profile/);
  assert.match(value.projectReview, /do not store secrets or perform installations/);
  c.routing = null; assert.equal(envelope(prepareContext(c, 'Manual task')).projectReview, undefined);
});

test('handoffs preserve primary and recent real user instructions instead of filling up on command output', () => {
  const c = conversation();
  message(c, 'user', 'Build the project runner. Keep commands local and never execute on detection.');
  for (let i = 0; i < 500; i++) message(c, 'activity', '$ npm test\n' + 'test output\n'.repeat(5000));
  message(c, 'assistant', 'The runner exists. Stop cleanup still needs verification.', 'claude', { status: 'incomplete' });
  message(c, 'user', 'Also keep saved Run and Test commands separate.');
  for (let i = 0; i < 80; i++) { message(c, 'user', continuationRequest); message(c, 'activity', '$ node tests.mjs\n' + 'verbose result\n'.repeat(2000)); }
  c.lastRun = { provider: 'codex', status: 'incomplete', errorCategory: 'quota' };
  const prepared = prepareContext(c, continuationRequest, { fresh: true, session: { sessionReason: 'cross-agent-handoff' } });
  const value = envelope(prepared);
  assert.equal(value.currentRequest, continuationRequest); assert.equal(value.summary, c.context.summary); assert.deepEqual(value.decisions, c.context.decisions);
  assert(value.context.some(item => item.text === c.messages[0].text));
  assert(value.context.some(item => item.text === 'Also keep saved Run and Test commands separate.'));
  assert(value.context.some(item => item.text.includes('Stop cleanup still needs verification.') && item.status === 'incomplete'));
  assert(value.context.filter(item => item.role === 'activity').every(item => Buffer.byteLength(JSON.stringify(item)) < 1600));
  assert(value.omittedMessages > 0); assert(prepared.metadata.omittedActivityMessages > 0); assert(prepared.metadata.compactedActivityMessages > 0);
  assert.equal(prepared.metadata.protectedUserMessages, 2); assert.equal(value.continuation.previousErrorCategory, 'quota');
  assert.equal(value.continuation.sessionMode, 'fresh'); assert.equal(value.continuation.sessionReason, 'cross-agent-handoff');
  assert.equal(prepared.metadata.bytes, Buffer.byteLength(prepared.prompt)); assert(prepared.metadata.bytes <= 192000);
  assert.match(prepared.prompt.slice(0, prepared.prompt.indexOf('\n')), /save it inside a workspace folder .* as a Markdown image/, 'Every agent is told how to make a screenshot show in the chat.');
  assert.equal(prepared.metadata.includedMessages + prepared.metadata.omittedMessages, c.messages.length);
});

test('protected requests and manual context survive a smaller local budget with explicit Unicode-safe excerpts', () => {
  const c = conversation();
  message(c, 'user', 'PRIMARY ' + '🧠"\\'.repeat(20000) + ' ORIGINAL-END');
  for (let i=0; i<10; i++) message(c, 'user', 'Instruction ' + i + ': ' + '🌍'.repeat(8000) + ' INSTRUCTION-END-' + i);
  for (let i=0; i<30; i++) message(c, 'activity', '$ command\n' + 'x'.repeat(100000));
  const prepared = prepareContext(c, 'Continue this task', { fresh: true, maxBytes: 12000 });
  const value = envelope(prepared), users = value.context.filter(item => item.role === 'user');
  assert.equal(prepared.metadata.protectedUserMessages, 9); assert(users.length >= 9);
  for (let i=2;i<10;i++) assert(users.some(item => item.text.startsWith('Instruction ' + i + ':')));
  assert(users[0].text.startsWith('PRIMARY')); assert(users[0].text.endsWith('ORIGINAL-END'));
  assert(users.at(-1).text.startsWith('Instruction 9:')); assert(users.at(-1).text.endsWith('INSTRUCTION-END-9'));
  assert(users.every(item => item.text.includes('[Middle omitted')));
  assert.equal(value.summary, c.context.summary); assert.equal(value.goal, c.context.goal); assert(Buffer.byteLength(prepared.prompt) <= 12000);
  assert(!/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/.test(JSON.stringify(users)), 'No split surrogate escapes');
  assert.equal(c.messages[0].text.includes('[Middle omitted'), false, 'Compaction never rewrites journal messages.');
});

test('same-agent native resumption supplies only unseen history while fresh sessions retain task intent', () => {
  const c = conversation(); c.provider = 'codex';
  message(c, 'user', 'Original task'); message(c, 'assistant', 'Prior work'); message(c, 'user', 'New steering');
  c.sessions.codex = { cursor: 2 };
  const resumed = prepareContext(c, 'Follow-up');
  assert.deepEqual(envelope(resumed).context.map(item => item.text), ['New steering']); assert.equal(resumed.metadata.sessionMode, 'resumed');
  const fresh = prepareContext(c, continuationRequest, { fresh: true }); assert.equal(envelope(fresh).context[0].text, 'Original task');
  assert.equal(fresh.metadata.sessionMode, 'fresh');
});

test('images cannot displace protected instructions, and attachments and manual context remain subject to the actual byte limit', () => {
  const c = conversation(), image = { id: 'a'.repeat(64), kind: 'image', bytes: 8, name: '🌍'.repeat(100) + '.png' };
  message(c, 'user', 'Keep the primary requirement.', 'codex', { attachments: [image] });
  for (let i=0;i<80;i++) message(c, 'activity', '$ verbose\n' + 'q'.repeat(24000));
  const prepared = prepareContext(c, 'Next step', { fresh: true, maxBytes: 6000, readAttachment: () => ({}) });
  assert.equal(envelope(prepared).context[0].text, 'Keep the primary requirement.'); assert.equal(prepared.images.length, 1); assert(prepared.metadata.bytes <= 6000);
  const noImages = prepareContext(c, 'Next step', { fresh: true, includeImages: false, readAttachment: () => ({}) }); assert.equal(noImages.images.length, 0);
  assert.throws(() => prepareContext(c, 'x'.repeat(9000), { maxBytes: 2000 }), /context budget/);
});

test('the whole Plan reaches the agent once: with the current request, or else with the latest message that carried it', () => {
  const c = conversation(), plan = (n, cards) => ({ id: n.repeat(64), kind: 'text', name: 'Plan.md', bytes: 100, plan: { cards, whole: true } });
  const card = { id: 'c'.repeat(64), kind: 'text', name: 'Card – Tests.md', bytes: 40, plan: { cards: 1, whole: false } };
  const texts = { ['a'.repeat(64)]: 'OLD PLAN TEXT', ['b'.repeat(64)]: 'NEWER PLAN TEXT', ['c'.repeat(64)]: 'CARD TEXT', ['d'.repeat(64)]: 'CURRENT PLAN TEXT' };
  const readAttachment = id => ({ text: texts[id] });
  message(c, 'user', 'What is missing?', 'codex', { id: 'm1', attachments: [plan('a', 20)] });
  message(c, 'assistant', 'Tests.', 'codex', { id: 'm2' });
  message(c, 'user', 'And now?', 'codex', { id: 'm3', attachments: [plan('b', 22), card] });
  message(c, 'user', 'Same Plan again', 'codex', { id: 'm4', attachments: [plan('b', 22)] });
  // No Plan with the current request: only the latest message keeps the Plan's text, even when it's the same snapshot.
  let context = envelope(prepareContext(c, 'Carry on', { fresh: true, policy: 'task', readAttachment })).context.map(item => item.text).join('\n');
  assert.doesNotMatch(context, /OLD PLAN TEXT/); assert.equal(context.match(/NEWER PLAN TEXT/g).length, 1);
  assert.match(context, /The Plan was attached here \(20 cards\) as it was then\. Left out because a later message carries a newer copy/);
  assert.match(context, /CARD TEXT/);
  // With the Plan on the current request, every earlier copy is a note.
  const value = envelope(prepareContext(c, 'Draft more', { fresh: true, policy: 'task', readAttachment, attachments: [plan('d', 23)] }));
  context = value.context.map(item => item.text).join('\n');
  assert.doesNotMatch(context, /PLAN TEXT/); assert.match(context, /the current request carries the Plan as it is now/);
  assert.match(value.currentRequest, /CURRENT PLAN TEXT/);
});

test('a long original request keeps its middle requirements in full when intent fits the budget', () => {
  const c=conversation(), original='Start '+ 'a'.repeat(25000) + ' NEVER OVERWRITE USER DATA ' + 'z'.repeat(30000) + ' end';
  message(c,'user',original);message(c,'user','Use the existing interfaces.');
  for(let i=0;i<100;i++)message(c,'activity','$ noisy command\n'+'output'.repeat(10000));
  const prepared=prepareContext(c,continuationRequest,{fresh:true});
  assert.equal(envelope(prepared).context[0].text,original);
  assert.equal(envelope(prepared).context[0].contextRole,'primary-user-request');
  assert(envelope(prepared).context.some(item=>item.text==='Use the existing interfaces.'));
  assert(prepared.metadata.bytes<=192000);
});

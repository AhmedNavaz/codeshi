import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { cleanQuestions, claudeQuestions, claudeAnswers, codexQuestions, codexAnswers, checkAnswers, answerSummary } from '../src/agent-questions.mjs';
import { runClaude, runCodex } from '../src/providers.mjs';

// Claude's AskUserQuestion input: two questions, the first suggesting an option, the second allowing several.
const claudeInput = { questions: [
  { header: 'Library', question: 'Which library should we use for dates?', multiSelect: false, options: [{ label: 'date-fns (Recommended)', description: 'Small and tree-shakeable' }, { label: 'Luxon', description: 'Time zones built in' }] },
  { header: 'Storage', question: 'Where should sessions be kept?', multiSelect: true, options: [{ label: 'Cookies', description: 'Sent with each request' }, { label: 'Local storage', description: 'Stays in the browser' }] },
] };

test('questions from either agent arrive in one shape, cut to size, with the suggested option marked', () => {
  const claude = claudeQuestions(claudeInput);
  assert.deepEqual(claude.map(question => [question.id, question.header, question.multiple, question.other, question.secret]), [['q1', 'Library', false, true, false], ['q2', 'Storage', true, true, false]]);
  assert.deepEqual(claude[0].options.map(option => [option.label, option.recommended]), [['date-fns (Recommended)', true], ['Luxon', false]]);
  const codex = codexQuestions({ questions: [
    { id: 'token', header: 'Token', question: 'Paste the deploy token', isSecret: true, options: null },
    { id: 'region', header: 'Region', question: 'Which region?', isOther: false, options: [{ label: 'EU', description: '' }, { label: 'US', description: '' }] },
  ] });
  assert.deepEqual(codex.map(question => [question.id, question.other, question.secret, question.options.length]), [['token', true, true, 0], ['region', false, false, 2]], 'A question without options takes your own answer; isOther false means the options only.');
  const messy = cleanQuestions([{ question: '  ', options: [] }, { question: 'Q'.repeat(5000), header: 'H'.repeat(90), options: [{ label: 'Same' }, { label: 'Same' }, { label: '' }, ...Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i}` }))] }]);
  assert.equal(messy.length, 1, 'A question with no text is dropped.');
  assert.equal(messy[0].question.length, 1000); assert.equal(messy[0].header.length, 40);
  assert.deepEqual(messy[0].options.slice(0, 2).map(option => option.label), ['Same', 'Option 0'], 'Repeated and empty labels are dropped.');
  assert.ok(messy[0].options.length <= 8);
  assert.equal(cleanQuestions('not a list').length, 0);
  assert.equal(cleanQuestions(Array.from({ length: 9 }, (_, i) => ({ question: `Q${i}?` }))).length, 6, 'At most six questions show at once.');
});

test('answers are one list per question: an option, several where allowed, or your own words where allowed', () => {
  const questions = claudeQuestions(claudeInput);
  assert.deepEqual(checkAnswers(questions, [['date-fns (Recommended)'], ['Cookies', 'Local storage']]), [['date-fns (Recommended)'], ['Cookies', 'Local storage']]);
  assert.deepEqual(checkAnswers(questions, [['  Day.js  '], ['Cookies', 'A database\nrow']]), [['Day.js'], ['Cookies', 'A database row']], 'Your own words are trimmed and kept on one line.');
  assert.equal(checkAnswers(questions, null), null, 'Null skips the questions.');
  const rejects = (answers, pattern) => assert.throws(() => checkAnswers(questions, answers), error => error.status === 400 && pattern.test(error.message));
  rejects([['Luxon']], /Answer each question/);
  rejects([['Luxon'], []], /Answer “Storage”/);
  rejects([['Luxon', 'date-fns (Recommended)'], ['Cookies']], /Choose one answer for “Library”/);
  rejects([['Luxon'], ['Mine', 'Also mine']], /Write one answer of your own/);
  rejects([['Luxon'], ['x'.repeat(2001)]], /up to 2000 characters/);
  rejects('Luxon', /Answer each question/);
  const strict = codexQuestions({ questions: [{ id: 'region', header: 'Region', question: 'Which region?', isOther: false, options: [{ label: 'EU', description: '' }, { label: 'US', description: '' }] }] });
  assert.throws(() => checkAnswers(strict, [['Mars']]), /Choose one of the options for “Region”/);
});

test('each agent gets the answers in its own shape, and the conversation keeps what was decided', () => {
  const questions = claudeQuestions(claudeInput), answers = [['date-fns (Recommended)'], ['Cookies', 'Local storage']];
  assert.deepEqual(claudeAnswers(claudeInput, answers), { 'Which library should we use for dates?': 'date-fns (Recommended)', 'Where should sessions be kept?': 'Cookies, Local storage' });
  const params = { questions: [{ id: 'region', header: 'Region', question: 'Which region?', options: [{ label: 'EU', description: '' }] }, { id: 'token', header: 'Token', question: 'Deploy token?', isSecret: true }] };
  assert.deepEqual(codexAnswers(params, [['EU'], ['s3cret']]), { answers: { region: { answers: ['EU'] }, token: { answers: ['s3cret'] } } });
  assert.deepEqual(codexAnswers(params, null), { answers: {} }, 'Skipped questions go back unanswered.');
  assert.equal(answerSummary(questions, answers), 'Answered:\nWhich library should we use for dates? → date-fns (Recommended)\nWhere should sessions be kept? → Cookies, Local storage');
  assert.equal(answerSummary(codexQuestions(params), [['EU'], ['s3cret']]), 'Answered:\nWhich region? → EU\nDeploy token? → (hidden)', 'A hidden answer is not written down.');
  assert.equal(answerSummary(questions, null), 'Skipped 2 questions; the agent continues on its own judgement.');
  assert.equal(answerSummary(questions.slice(0, 1), null), 'Skipped the question; the agent continues on its own judgement.');
});

test('Claude can ask in any run but a background review, and gets your answers or is told to decide', async () => {
  const asked = [];
  const run = async (config, answers) => {
    let options, decision;
    async function* queryImpl(input) { options = input.options; decision = options.tools.includes('AskUserQuestion') ? await options.canUseTool('AskUserQuestion', claudeInput, { toolUseID: 'ask-1' }) : null; yield { type: 'result', subtype: 'success' }; }
    await runClaude({ workspace: '/project', prompt: 'Add sessions', ...config }, { queryImpl, event() {}, metadata() {}, approval: async () => false, question: async request => { asked.push(request); return answers; } });
    return { options, decision };
  };
  const answered = await run({ mode: 'edit' }, [['Luxon'], ['Cookies']]);
  assert.deepEqual(answered.options.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'TodoWrite', 'AskUserQuestion']);
  assert.equal(asked[0].id, 'ask-1'); assert.equal(asked[0].questions.length, 2); assert.equal(asked[0].questions[0].options[0].recommended, true);
  assert.deepEqual(answered.decision, { behavior: 'allow', updatedInput: { ...claudeInput, answers: { 'Which library should we use for dates?': 'Luxon', 'Where should sessions be kept?': 'Cookies' } } });
  const skipped = await run({ mode: 'read' }, null);
  assert.deepEqual(skipped.options.tools, ['Read', 'Glob', 'Grep', 'TodoWrite', 'AskUserQuestion'], 'Asking changes nothing, so a read-only run can ask too.');
  assert.equal(skipped.decision.behavior, 'deny'); assert.match(skipped.decision.message, /skipped these questions.*best judgement/);
  const review = await run({ mode: 'read', reviewSnapshot: true }, [['Luxon'], ['Cookies']]);
  assert.equal(review.options.tools.includes('AskUserQuestion'), false, 'A background review, which nobody answers, cannot ask.');
  assert.equal(asked.length, 2);
});

test('Codex’s request for your input waits for the answers and gets them back by question id', async () => {
  class Client extends EventEmitter {
    sent = []; async initialize() {} close() {} send(message) { this.sent.push(message); if (message.id === 41) queueMicrotask(() => this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } })); }
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') { queueMicrotask(() => this.emit('message', { id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions: [{ id: 'region', header: 'Region', question: 'Which region?', options: [{ label: 'EU (Recommended)', description: 'Closest to most users' }, { label: 'US', description: '' }] }] } })); return { turn: { id: 'turn' } }; }
      return {};
    }
  }
  const run = async answers => {
    const client = new Client(), asked = [];
    await runCodex({ workspace: '/project', prompt: 'Deploy', mode: 'edit', model: 'm', effort: 'low' }, { clientFactory: () => client, event() {}, metadata() {}, approval: async () => false, question: async request => { asked.push(request); return answers; } });
    return { reply: client.sent.find(message => message.id === 41), asked };
  };
  const answered = await run([['EU (Recommended)']]);
  assert.deepEqual(answered.asked.map(request => [request.id, request.questions[0].id, request.questions[0].options[0].recommended]), [['41', 'region', true]]);
  assert.deepEqual(answered.reply, { id: 41, result: { answers: { region: { answers: ['EU (Recommended)'] } } } });
  assert.deepEqual((await run(null)).reply, { id: 41, result: { answers: {} } }, 'Skipping sends no answers, so Codex decides.');
});

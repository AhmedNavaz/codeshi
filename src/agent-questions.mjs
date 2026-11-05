// Questions an agent asks you with choices: Claude's AskUserQuestion and Codex's request_user_input. Each arrives in
// its own shape and is kept here in one: an id, a short header, the question, its options (an agent marks the one it
// suggests by ending its label with "(Recommended)") and whether you may pick several, write your own answer, or
// answer without the text being shown. Answers are one list of strings per question, and go back in each agent's
// own shape.

const LIMITS = { questions: 6, options: 8, id: 100, header: 40, question: 1000, label: 200, description: 600, answer: 2000 };
const RECOMMENDED = /\s*\(recommended\)\s*$/i;
const text = (value, max) => (typeof value === 'string' ? value : '').trim().slice(0, max);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// What the person sees: only text, cut to size, and only questions that say something.
export function cleanQuestions(list) {
  return (Array.isArray(list) ? list : []).slice(0, LIMITS.questions).map((item, index) => {
    const seen = new Set(), options = [];
    for (const option of Array.isArray(item?.options) ? item.options.slice(0, LIMITS.options) : []) {
      const label = text(option?.label, LIMITS.label);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      options.push({ label, description: text(option?.description, LIMITS.description), recommended: RECOMMENDED.test(label) });
    }
    return { id: text(item?.id, LIMITS.id) || `q${index + 1}`, header: text(item?.header, LIMITS.header), question: text(item?.question, LIMITS.question), options, multiple: item?.multiple === true && options.length > 1, other: item?.other === true || !options.length, secret: item?.secret === true };
  }).filter(item => item.question);
}

// Claude asks 1 to 4 questions with 2 to 4 options each, and always lets you write your own answer.
export function claudeQuestions(input) {
  return cleanQuestions((Array.isArray(input?.questions) ? input.questions : []).map(question => ({ header: question?.header, question: question?.question, options: question?.options, multiple: question?.multiSelect === true, other: true })));
}
// Claude reads each answer by the question's own text; several choices are one answer, separated by commas.
export function claudeAnswers(input, answers) {
  return Object.fromEntries((input?.questions || []).map((question, index) => [question.question, (answers[index] || []).join(', ')]));
}

// Codex names each question; an option list is optional, and a question may allow your own answer or hide it.
export function codexQuestions(params) {
  return cleanQuestions((Array.isArray(params?.questions) ? params.questions : []).map(question => ({ id: question?.id, header: question?.header, question: question?.question, options: question?.options || [], other: question?.isOther === true, secret: question?.isSecret === true })));
}

// Newer Codex versions attach optional, non-blocking questions to an agentMessage instead of sending an RPC
// request. They have titles and string options, and always allow an answer in the person's own words.
export function codexAsyncQuestions(questions) {
  return cleanQuestions((Array.isArray(questions) ? questions : []).map((question, index) => ({
    id: `q${index + 1}`, question: question?.title, other: true,
    options: Array.isArray(question?.options) ? question.options.map(label => ({ label })) : [],
  })));
}
// Skipped questions go back unanswered, so Codex carries on with its own judgement.
export function codexAnswers(params, answers) {
  if (!answers) return { answers: {} };
  return { answers: Object.fromEntries((params?.questions || []).map((question, index) => [question.id, { answers: answers[index] || [] }])) };
}

// The person's answers, one list per question: an option's label, or their own words where the question allows it.
// Null skips the questions.
export function checkAnswers(questions, answers) {
  if (answers === null) return null;
  if (!Array.isArray(answers) || answers.length !== questions.length) fail('Answer each question, or skip them.');
  return questions.map((question, index) => {
    const values = answers[index], name = `“${question.header || question.question}”`;
    if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) fail('Answer each question, or skip them.');
    const picked = [...new Set(values.map(value => value.trim()).filter(Boolean))];
    if (!picked.length) fail(`Answer ${name}, or skip the questions.`);
    if (!question.multiple && picked.length > 1) fail(`Choose one answer for ${name}.`);
    const labels = new Set(question.options.map(option => option.label)), own = picked.filter(value => !labels.has(value));
    if (own.length && !question.other) fail(`Choose one of the options for ${name}.`);
    if (own.length > 1) fail(`Write one answer of your own for ${name}.`);
    if (own.some(value => value.length > LIMITS.answer)) fail(`An answer can be up to ${LIMITS.answer} characters.`);
    return picked.map(value => labels.has(value) ? value : oneLine(value));
  });
}
const oneLine = value => value.replace(/\s*\n+\s*/g, ' ');

// The conversation keeps what was asked and answered, so any agent reading it later knows what you decided. An
// answer to a question that hides it is not written down.
export function answerSummary(questions, answers) {
  if (!answers) return `Skipped ${questions.length === 1 ? 'the question' : `${questions.length} questions`}; the agent continues on its own judgement.`;
  return ['Answered:', ...questions.map((question, index) => `${oneLine(question.question)} → ${question.secret ? '(hidden)' : answers[index].join(', ')}`)].join('\n');
}

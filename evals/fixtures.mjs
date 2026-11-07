// The tasks an evaluation runs (#84). Each is a small pinned repository, what the agent is asked, and a check it never sees:
// the check's files are only written after the agent has finished, so it can't be edited or passed by reading it.
const test = body => `import assert from 'node:assert/strict';\nimport test from 'node:test';\n${body}\n`;

const CHANGE_NOTE = '---\nname: change-note\ndescription: Record a change in CHANGES.md in the format this project requires.\nlicense: MIT\n---\n\nUnder "## Unreleased" in CHANGES.md, add one line in exactly this format:\n\n- [<area>] <one sentence saying what changed>. (#<issue>)\n\nThe square brackets and the (#number) are required. Do not add anything else to the file.\n';
const CHANGE_CHECK = test("import fs from 'node:fs';\nimport { add } from '../math.mjs';\ntest('procedure', () => { assert.equal(add(2, 3), 5); assert.match(fs.readFileSync(new URL('../CHANGES.md', import.meta.url), 'utf8'), /^- \\[math\\] .+\\. \\(#12\\)$/m); });");

export const fixtures = [
  {
    id: 'small-edit', title: 'Small edit in one file',
    folders: { app: { 'greet.mjs': 'export function greet(name) {\n  return `Hello ${name}`;\n}\n' } },
    prompt: 'In greet.mjs, make greet() end with an exclamation mark, so greet("Ana") returns "Hello Ana!". Change nothing else.',
    check: { app: { 'greet.test.mjs': test("import { greet } from '../greet.mjs';\ntest('greet', () => assert.equal(greet('Ana'), 'Hello Ana!'));") } },
    rubric: 'One line changed, nothing else touched.',
    trace: [{ steps: [{ type: 'write', folder: 'app', file: 'greet.mjs', content: 'export function greet(name) {\n  return `Hello ${name}!`;\n}\n' }, { type: 'say', text: 'greet() now ends with an exclamation mark.' }], usage: { input: 1200, cached: 400, output: 90, reasoning: 20 } }],
  },
  {
    id: 'cross-folder', title: 'One change across two folders',
    folders: { api: { 'limits.mjs': 'export const MAX_ITEMS = 10;\n' }, web: { 'form.mjs': "export const maxItemsLabel = 'Up to 10 items';\n" } },
    prompt: 'Raise the item limit from 10 to 25 across both folders: MAX_ITEMS in limits.mjs in api, and the label in form.mjs in web.',
    check: { api: { 'limits.test.mjs': test("import { MAX_ITEMS } from '../limits.mjs';\ntest('limit', () => assert.equal(MAX_ITEMS, 25));") }, web: { 'form.test.mjs': test("import { maxItemsLabel } from '../form.mjs';\ntest('label', () => assert.equal(maxItemsLabel, 'Up to 25 items'));") } },
    rubric: 'Both folders changed, and nothing else.',
    trace: [{ steps: [{ type: 'write', folder: 'api', file: 'limits.mjs', content: 'export const MAX_ITEMS = 25;\n' }, { type: 'write', folder: 'web', file: 'form.mjs', content: "export const maxItemsLabel = 'Up to 25 items';\n" }, { type: 'say', text: 'Both now say 25.' }], usage: { input: 2100, cached: 300, output: 140, reasoning: 40 } }],
  },
  {
    id: 'bug-repair', title: 'Repair a failing test',
    folders: { app: { 'total.mjs': 'export function total(prices, percentOff = 0) {\n  const sum = prices.reduce((all, price) => all + price, 0);\n  return sum - percentOff;\n}\n', 'total.test.mjs': test("import { total } from './total.mjs';\ntest('takes off a percentage', () => assert.equal(total([200, 200], 10), 360));") } },
    prompt: 'node --test fails in this project. Find the cause and fix it. Do not change the test.',
    check: { app: { 'hidden.test.mjs': test("import { total } from '../total.mjs';\ntest('percentage of the sum', () => { assert.equal(total([50], 10), 45); assert.equal(total([10, 20]), 30); });") } },
    rubric: 'Fixes the calculation rather than the test.',
    trace: [{ steps: [{ type: 'command', command: 'node --test', output: 'not ok 1 - takes off a percentage\nexpected 360, got 390\n' }, { type: 'write', folder: 'app', file: 'total.mjs', content: 'export function total(prices, percentOff = 0) {\n  const sum = prices.reduce((all, price) => all + price, 0);\n  return sum - sum * percentOff / 100;\n}\n' }, { type: 'say', text: 'It took the percentage off as a flat amount; it now works it out from the sum.' }], usage: { input: 3000, cached: 900, output: 260, reasoning: 120 } }],
  },
  {
    id: 'quota-handoff', title: 'Handed off part way through', needsSecondAgent: true,
    folders: { app: { 'strings.mjs': "export function slugify(text) { throw new Error('not implemented'); }\nexport function titleCase(text) { throw new Error('not implemented'); }\nexport function truncate(text, length) { throw new Error('not implemented'); }\n" } },
    prompt: 'Implement slugify ("Hello World" gives "hello-world"), titleCase ("hello world" gives "Hello World") and truncate (truncate("abcdef", 3) gives "abc") in strings.mjs, one at a time, saving the file after each.',
    // Stops the first agent at its first edit, as a handoff does, and the second continues the same way a handoff does.
    stopAfterFirstEdit: true,
    check: { app: { 'strings.test.mjs': test("import { slugify, titleCase, truncate } from '../strings.mjs';\ntest('all three', () => { assert.equal(slugify('Hello World'), 'hello-world'); assert.equal(titleCase('hello world'), 'Hello World'); assert.equal(truncate('abcdef', 3), 'abc'); });") } },
    rubric: 'The second agent carries on instead of starting over, and keeps what the first one did.',
    trace: [
      { hold: true, steps: [{ type: 'write', folder: 'app', file: 'strings.mjs', content: "export function slugify(text) { return text.toLowerCase().replace(/\\s+/g, '-'); }\nexport function titleCase(text) { throw new Error('not implemented'); }\nexport function truncate(text, length) { throw new Error('not implemented'); }\n" }], usage: { input: 1500, cached: 200, output: 80, reasoning: 30 } },
      { steps: [{ type: 'command', command: 'cat strings.mjs', output: 'export function slugify(text) { ... }' }, { type: 'write', folder: 'app', file: 'strings.mjs', content: "export function slugify(text) { return text.toLowerCase().replace(/\\s+/g, '-'); }\nexport function titleCase(text) { return text.replace(/\\b\\w/g, letter => letter.toUpperCase()); }\nexport function truncate(text, length) { return text.slice(0, length); }\n" }, { type: 'say', text: 'slugify was done; I finished titleCase and truncate.' }], usage: { input: 2400, cached: 600, output: 170, reasoning: 60 } },
    ],
  },
  {
    id: 'context-heavy', title: 'Continuing after a long history', 
    folders: { shop: { 'money.mjs': '// Prices are shown with formatPrice, once it exists.\n' }, ops: { 'deploy.log': 'deployed\n' } },
    // The earlier conversation a fresh agent has to pick up from, including work in another folder that has nothing to do with this.
    history: ({ shop, ops }) => [
      { role: 'user', text: 'Rotate the deploy logs in ops and check the server restarts.' },
      ...Array.from({ length: 160 }, (_, index) => ({ role: 'activity', text: `$ tail -n 400 ${ops}/deploy.log\nops-noise-${index} ${'restart ok; '.repeat(40)}` })),
      { role: 'assistant', text: 'The ops logs rotate nightly now.' },
      { role: 'user', text: 'Add formatPrice(amount) to money.mjs in shop. Decision: it returns the currency code first, like "EUR 1.50", always two decimals, and defaults to EUR.' },
      { role: 'activity', text: `$ node -e "new Intl.NumberFormat('de-DE').format(1.5)" # in ${shop}\nError: Intl formatted the amount as 1,5, which breaks the decided format\nfailed` },
      { role: 'assistant', text: 'Intl with de-DE gave "1,5", so that approach does not meet the decided format. I will use toFixed(2) instead.' },
    ],
    prompt: null, continues: true,
    check: { shop: { 'money.test.mjs': test("import { formatPrice } from '../money.mjs';\ntest('format', () => { assert.equal(formatPrice(1.5), 'EUR 1.50'); assert.equal(formatPrice(2), 'EUR 2.00'); });") } },
    facts: ['formatPrice', 'EUR 1.50', 'toFixed(2)', 'Intl'], leakMarker: 'ops-noise-',
    rubric: 'Follows the earlier decision and avoids the approach that already failed.',
    trace: [{ steps: [{ type: 'write', folder: 'shop', file: 'money.mjs', content: "export function formatPrice(amount, currency = 'EUR') {\n  return `${currency} ${amount.toFixed(2)}`;\n}\n" }, { type: 'say', text: 'Added formatPrice with toFixed(2), as decided.' }], usage: { input: 2600, cached: 300, output: 120, reasoning: 50 } }],
  },
  {
    id: 'memory-reuse', title: 'A convention only memory knows',
    folders: { app: { 'stamp.mjs': '// Date helpers live here.\n' } },
    // Nothing in the code shows this convention, so an agent can only follow it by being told. The unrelated entry must stay out.
    memory: [{ kind: 'convention', text: 'Our timestamps are ISO 8601 UTC with no milliseconds, like 2026-01-02T03:04:05Z.' }, { kind: 'failed-approach', text: 'Kubernetes ingress annotations broke the canary rollout.' }],
    prompt: 'Add an exported function stamp(date) to stamp.mjs that returns the date as a string in our usual timestamp format.',
    check: { app: { 'stamp.test.mjs': test("import { stamp } from '../stamp.mjs';\ntest('format', () => assert.equal(stamp(new Date('2026-01-02T03:04:05.678Z')), '2026-01-02T03:04:05Z'));") } },
    facts: ['no milliseconds'], leakMarker: 'Kubernetes',
    rubric: 'Follows the saved convention without being told it again.',
    trace: [{ steps: [{ type: 'write', folder: 'app', file: 'stamp.mjs', content: "export function stamp(date) {\n  return date.toISOString().replace(/\\.\\d+Z$/, 'Z');\n}\n" }, { type: 'say', text: 'Added stamp(), using the saved format.' }], usage: { input: 1300, cached: 200, output: 100, reasoning: 20 } }],
  },
  {
    id: 'skill-procedure', title: 'A procedure only a skill knows',
    folders: { app: { 'math.mjs': '// Small helpers.\n', 'CHANGES.md': '# Changes\n\n## Unreleased\n' } },
    skills: { 'change-note': CHANGE_NOTE },
    prompt: 'Add an exported function add(a, b) to math.mjs, then record it in CHANGES.md using the /change-note skill. The area is math and the issue is 12.',
    check: { app: { 'changes.test.mjs': CHANGE_CHECK } },
    rubric: 'Follows the skill exactly, without being told its format.',
    trace: [{ steps: [{ type: 'write', folder: 'app', file: 'math.mjs', content: 'export function add(a, b) { return a + b; }\n' }, { type: 'write', folder: 'app', file: 'CHANGES.md', content: '# Changes\n\n## Unreleased\n\n- [math] Added add(a, b). (#12)\n' }, { type: 'say', text: 'Added add() and recorded it.' }], usage: { input: 1400, cached: 200, output: 120, reasoning: 20 } }],
  },
  {
    id: 'skill-handoff', title: 'A skill follows the task to another agent', needsSecondAgent: true, stopAfterFirstEdit: true,
    folders: { app: { 'math.mjs': '// Small helpers.\n', 'CHANGES.md': '# Changes\n\n## Unreleased\n' } },
    skills: { 'change-note': CHANGE_NOTE },
    prompt: 'Add an exported function add(a, b) to math.mjs and save it, and only then record it in CHANGES.md using the /change-note skill. The area is math and the issue is 12.',
    check: { app: { 'changes.test.mjs': CHANGE_CHECK } },
    rubric: 'The second agent finishes the procedure the first one was following.',
    trace: [
      { hold: true, steps: [{ type: 'write', folder: 'app', file: 'math.mjs', content: 'export function add(a, b) { return a + b; }\n' }], usage: { input: 1400, cached: 200, output: 60, reasoning: 20 } },
      { steps: [{ type: 'write', folder: 'app', file: 'CHANGES.md', content: '# Changes\n\n## Unreleased\n\n- [math] Added add(a, b). (#12)\n' }, { type: 'say', text: 'Recorded it, as the skill says.' }], usage: { input: 1600, cached: 300, output: 70, reasoning: 20 } },
    ],
  },
  {
    id: 'long-thread', title: 'Decisions survive successive tasks and switching back',
    folders: { shop: { 'money.mjs': '// Money helpers.\n', 'receipt.mjs': '// Receipt helpers.\n' }, ops: { 'limit.mjs': 'export const limit = 10;\n' } },
    history: ({ ops }) => [
      { role: 'user', text: 'Shop conventions: formatPrice uses EUR by default, currency code first, two decimal places with toFixed(2). Receipt entries are joined with a semicolon without spaces. Do not use Intl: it previously produced comma decimals. Blocker: tax calculation is awaiting a decision; leave tax out.' },
      ...Array.from({ length: 200 }, (_, index) => ({ role: 'activity', text: `$ tail -n 500 ${ops}/deploy.log\nold-deploy-${index} ${'restart successful; '.repeat(50)}` })),
      { role: 'assistant', text: 'Deployment investigation finished. Shop conventions and the unresolved tax decision still apply.' },
    ],
    turns: [
      { prompt: 'In shop/money.mjs, export formatPrice(amount) using the earlier shop conventions. Leave ops unchanged.',
        standalone: 'In shop/money.mjs, export formatPrice(amount): default EUR, currency code first, two decimal places using toFixed(2), e.g. EUR 1.50. Do not use Intl (it gave comma decimals). Tax is undecided; leave it out. Leave ops unchanged.',
        facts: ['EUR', 'toFixed(2)', 'Intl', 'tax'] },
      { prompt: 'Separate task: change only ops/limit.mjs so limit is 25. Keep the shop work and its decisions for later.',
        standalone: 'Change only ops/limit.mjs so its exported limit is 25. Keep all shop files unchanged.', facts: ['25'] },
      { prompt: 'Return to shop. Export receipt(amounts) from receipt.mjs, importing formatPrice from money.mjs. Format each amount and join them with the separator agreed earlier. Respect the unresolved blocker. Leave ops as it is.',
        standalone: 'In shop/receipt.mjs, export receipt(amounts), importing formatPrice from ./money.mjs. Shop conventions: default EUR, currency code first, two decimal places with toFixed(2), entries joined with a semicolon (no space). Intl gave comma decimals; do not use it. The tax calculation is awaiting a decision; leave it out. Leave ops unchanged.',
        facts: ['EUR', 'semicolon', 'tax', 'Intl'] },
    ],
    check: { shop: { 'money.test.mjs': test("import { formatPrice } from '../money.mjs';\nimport { receipt } from '../receipt.mjs';\ntest('decisions retained', () => { assert.equal(formatPrice(1.5), 'EUR 1.50'); assert.equal(receipt([1.5, 2]), 'EUR 1.50;EUR 2.00'); assert.equal(receipt([]), ''); });") },
      ops: { 'limit.test.mjs': test("import { limit } from '../limit.mjs';\ntest('other task kept', () => assert.equal(limit, 25));") } },
    rubric: 'Preserves currency, precision and separator decisions after unrelated folder work; does not invent tax behavior. Compare the final diff as well as checks. The reconstruction probe is not evidence of retention inside a native session or a native compaction.',
    trace: [
      { steps: [{ type: 'command', command: 'cat money.mjs', output: '// Money helpers.' }, { type: 'write', folder: 'shop', file: 'money.mjs', content: "export function formatPrice(amount) { return `EUR ${amount.toFixed(2)}`; }\n" }, { type: 'say', text: 'Price formatting follows the agreed conventions.' }], usage: { input: 3500, cached: 800, output: 120, reasoning: 40 } },
      { compact: true, steps: [{ type: 'write', folder: 'ops', file: 'limit.mjs', content: 'export const limit = 25;\n' }, { type: 'say', text: 'Only the ops limit changed.' }], usage: { input: 1200, cached: 900, output: 60, reasoning: 20 } },
      { requiresPrompt: ['EUR', 'semicolon', 'tax'], steps: [{ type: 'command', command: 'cat money.mjs', output: 'export function formatPrice(amount) { ... }' }, { type: 'write', folder: 'shop', file: 'receipt.mjs', content: "import { formatPrice } from './money.mjs';\nexport function receipt(amounts) { return amounts.map(formatPrice).join(';'); }\n" }, { type: 'say', text: 'Receipt uses the existing formatter and semicolon separator. Tax remains undecided.' }], usage: { input: 1800, cached: 600, output: 130, reasoning: 30 } },
    ],
  },
  {
    id: 'review', title: 'Read-only review finds a seeded bug', readOnly: true,
    folders: { app: { 'discount.mjs': 'export function discount(price, percent) {\n  // percent is 0 to 100\n  return price * percent;\n}\n' } },
    prompt: 'Review discount.mjs and tell me what is wrong with it. Do not change anything.',
    checkReply: /100|percent(age)?\b/i,
    rubric: 'Names that the percentage is never divided by 100, and changes nothing.',
    trace: [{ steps: [{ type: 'say', text: 'discount() multiplies by the percent without dividing by 100.' }], usage: { input: 900, cached: 0, output: 60, reasoning: 10 } }],
  },
];
export const fixtureById = id => fixtures.find(fixture => fixture.id === id);

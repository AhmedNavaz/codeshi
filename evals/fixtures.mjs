// The tasks an evaluation runs (#84). Each is a small pinned repository, what the agent is asked, and a check it never sees:
// the check's files are only written after the agent has finished, so it can't be edited or passed by reading it.
const test = body => `import assert from 'node:assert/strict';\nimport test from 'node:test';\n${body}\n`;

const CHANGE_NOTE = '---\nname: change-note\ndescription: Record a change in CHANGES.md in the format this project requires.\nlicense: MIT\n---\n\nUnder "## Unreleased" in CHANGES.md, add one line in exactly this format:\n\n- [<area>] <one sentence saying what changed>. (#<issue>)\n\nThe square brackets and the (#number) are required. Do not add anything else to the file.\n';
const CHANGE_CHECK = test("import fs from 'node:fs';\nimport { add } from '../math.mjs';\ntest('procedure', () => { assert.equal(add(2, 3), 5); assert.match(fs.readFileSync(new URL('../CHANGES.md', import.meta.url), 'utf8'), /^- \\[math\\] .+\\. \\(#12\\)$/m); });");

// The starter skills' tasks (#86). Each is an ordinary request that leaves out the point its starter covers, so running
// it with and without the starter shows whether the procedure changes the result, and what it costs. They were written
// knowing the starters, so they show whether a procedure is followed where it matters, not how often it matters.
const lines = list => list.join('\n') + '\n';
const UI = lines([
  '// Shared pieces every view uses.',
  "export const escape = text => String(text).replace(/[&<>\"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[character]);",
  "export const spinner = () => '<p class=\"spinner\" aria-busy=\"true\">Loading…</p>';",
  'export const errorState = message => `<p class="error" role="alert">${escape(message)}</p>`;',
  'export const emptyState = message => `<p class="empty">${escape(message)}</p>`;',
]);
const view = (name, item, empty, row) => lines([
  "import { emptyState, errorState, escape, spinner } from './ui.mjs';",
  '',
  `// state is { status: 'loading' | 'error' | 'ready', error, ${name} } from the ${name} store.`,
  `export function render${name[0].toUpperCase()}${name.slice(1)}(state) {`,
  "  if (state.status === 'loading') return spinner();",
  "  if (state.status === 'error') return errorState(state.error);",
  `  if (!state.${name}.length) return emptyState('${empty}');`,
  `  return \`<ul class="${name}">\${state.${name}.map(${item} => \`<li>${row}</li>\`).join('')}</ul>\`;`,
  '}',
]);
const ROUTES = lines([
  "import { users } from './store.mjs';",
  '',
  '// Handlers take { user, params, body } and return { status, body }. user is whoever is signed in.',
  'const fail = (status, code, message) => ({ status, body: { error: { code, message } } });',
  'const publicUser = ({ id, name, email }) => ({ id, name, email });',
  '',
  'export function getUser({ params }) {',
  '  const found = users.get(params.id);',
  "  return found ? { status: 200, body: publicUser(found) } : fail(404, 'not_found', 'No such user.');",
  '}',
  '',
  'export function deleteUser({ user, params }) {',
  "  if (!users.has(params.id)) return fail(404, 'not_found', 'No such user.');",
  "  if (user.id !== params.id && !user.admin) return fail(403, 'forbidden', 'You can only delete your own account.');",
  '  users.delete(params.id);',
  '  return { status: 204, body: null };',
  '}',
]);
const TABLES = lines([
  '// A small in-memory table store that follows the same rules as the production database.',
  'export class Database {',
  '  constructor() { this.tables = {}; }',
  '  table(name) { const table = this.tables[name]; if (!table) throw new Error(`No table ${name}.`); return table; }',
  '  createTable(name, columns) { if (this.tables[name]) throw new Error(`Table ${name} exists.`); this.tables[name] = { columns: structuredClone(columns), rows: [] }; }',
  '  dropTable(name) { this.table(name); delete this.tables[name]; }',
  '  // As in the real database, a required column without a default can only be added to an empty table.',
  '  addColumn(name, column, { required = false, default: fallback = null } = {}) {',
  '    const table = this.table(name);',
  '    if (table.columns[column]) throw new Error(`Column ${column} exists.`);',
  '    if (required && fallback === null && table.rows.length) throw new Error(`Cannot add required column ${column} to ${name}: it has ${table.rows.length} rows and no default.`);',
  '    table.columns[column] = { required, default: fallback };',
  '    for (const row of table.rows) row[column] = fallback;',
  '  }',
  '  setRequired(name, column, required) {',
  '    const table = this.table(name);',
  '    if (required && table.rows.some(row => row[column] === null)) throw new Error(`Cannot make ${column} required: some rows have no value.`);',
  '    table.columns[column].required = required;',
  '  }',
  '  dropColumn(name, column) { const table = this.table(name); if (!table.columns[column]) throw new Error(`No column ${column}.`); delete table.columns[column]; for (const row of table.rows) delete row[column]; }',
  '  insert(name, values) {',
  '    const table = this.table(name), row = {};',
  '    for (const key of Object.keys(values)) if (!table.columns[key]) throw new Error(`No column ${key}.`);',
  '    for (const [column, spec] of Object.entries(table.columns)) { row[column] = values[column] ?? spec.default ?? null; if (spec.required && row[column] === null) throw new Error(`${column} is required.`); }',
  '    table.rows.push(row);',
  '  }',
  '  update(name, change) { for (const row of this.table(name).rows) change(row); }',
  '  select(name) { return this.table(name).rows.map(row => ({ ...row })); }',
  '}',
]);
const MIGRATE = lines([
  "import fs from 'node:fs';",
  '',
  "const folder = new URL('./migrations/', import.meta.url);",
  '// Migrations are migrations/NNN_name.mjs, each exporting up(db) and down(db), applied in order.',
  'export async function migrations() {',
  '  const files = fs.readdirSync(folder).filter(file => /^\\d{3}_.+\\.mjs$/.test(file)).sort();',
  '  return Promise.all(files.map(async file => ({ file, ...(await import(new URL(file, folder))) })));',
  '}',
  'export async function migrate(db) { db.applied ||= []; for (const step of await migrations()) if (!db.applied.includes(step.file)) { step.up(db); db.applied.push(step.file); } }',
  'export async function rollback(db) { const file = db.applied?.pop(); if (file) (await migrations()).find(step => step.file === file).down(db); }',
]);
const COUPON = lines([
  '// Applies a coupon code to a cart. Totals are in cents.',
  'const coupons = { WELCOME10: { percent: 10, oncePerCustomer: true }, SPRING5: { percent: 5 } };',
  '',
  'export function applyCoupon(cart, code, customer) {',
  '  const coupon = coupons[code.toUpperCase()];',
  "  if (!coupon) return { ok: false, reason: 'unknown-code' };",
  "  if (coupon.oncePerCustomer && customer.usedCoupons.includes(code)) return { ok: false, reason: 'already-used' };",
  '  const discount = Math.round(cart.total * coupon.percent / 100);',
  '  return { ok: true, total: cart.total - discount };',
  '}',
]);
const REVIEW_FINDINGS = {
  'names the use that is never recorded': /(?=[\s\S]*usedCoupons)[\s\S]*\b(never|not|isn't|doesn't|missing|nothing)\b[^\n]{0,120}\b(record|recorded|records|add|added|adds|push|pushed|pushes|track|tracked|tracks|mark|marked|marks|save|saved|saves|store|stored|stores|update|updated|updates)\b/i,
  'names the case-sensitive check': /[\s\S]*(toUpperCase|upper-?case|lower-?case|case[- ]?(in)?sensitiv|normali[sz])/i,
};
const DURATION = lines([
  '// Parses a duration like "1h30m", "45s" or "2h" into seconds. Anything else throws.',
  'export function parseDuration(text) {',
  '  const value = String(text).trim();',
  '  const match = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(value);',
  '  if (!value || !match) throw new Error(`Not a duration: ${text}`);',
  '  const [, hours = 0, minutes = 0, seconds = 0] = match;',
  '  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);',
  '}',
]);
// Each is a realistic slip that a thorough set of tests catches: the main path, every unit, empty text and wrong text.
export const DURATION_MUTANTS = {
  'minutes counted as 100 seconds': DURATION.replace('Number(minutes) * 60', 'Number(minutes) * 100'),
  'seconds ignored': DURATION.replace('+ Number(seconds);', '+ 0;'),
  'empty text gives 0': DURATION.replace('if (!value || !match)', 'if (!match)'),
  'other text gives 0': DURATION.replace('if (!value || !match) throw', 'if (!match) return 0;\n  if (!value) throw'),
};
// Runs the agent's own tests in copies of its folder: once on the real code, where they must pass, then once on each slip,
// where they must fail.
const MUTATION_CHECK = lines([
  "import assert from 'node:assert/strict';",
  "import { spawnSync } from 'node:child_process';",
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import test from 'node:test';",
  "import { fileURLToPath } from 'node:url';",
  "const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
  `const mutants = ${JSON.stringify(DURATION_MUTANTS)};`,
  'const runIn = source => {',
  "  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-mutant-'));",
  '  try {',
  "    fs.cpSync(folder, copy, { recursive: true, filter: file => !['.eval-check', '.git', 'node_modules'].includes(path.basename(file)) });",
  "    if (source) fs.writeFileSync(path.join(copy, 'duration.mjs'), source);",
  '    // Without NODE_TEST_CONTEXT, which this check inherits from its own test runner, the copy reports as a run of its own.',
  "    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: copy, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH } });",
  '    return { passed: result.status === 0, tests: Number(/^# tests (\\d+)/m.exec(result.stdout)?.[1] || 0) };',
  '  } finally { fs.rmSync(copy, { recursive: true, force: true }); }',
  '};',
  "test('the tests pass on the real code', () => { const real = runIn(null); assert(real.tests > 0, 'No tests were written.'); assert(real.passed); });",
  "for (const [name, source] of Object.entries(mutants)) test(`the tests catch: ${name}`, () => assert.equal(runIn(source).passed, false));",
]);
const starterTasks = [
  {
    id: 'view-states', starter: 'frontend-implementation', title: 'A new view that holds up in every state',
    folders: { web: { 'ui.mjs': UI, 'users.mjs': view('users', 'user', 'No users yet.', '${escape(user.name)}'), 'projects.mjs': view('projects', 'project', 'No projects yet.', '${escape(project.title)} · ${project.open} open'), 'orders.mjs': '// The orders view.\n' } },
    prompt: 'Write renderOrders(state) in orders.mjs for the orders page. Show each order as a list item with its number and the customer\'s name, like "#1042 Ana". Its state comes from the orders store, with the orders in state.orders, each { number, customer }.',
    check: { web: { 'orders.test.mjs': test("import { renderOrders } from '../orders.mjs';\nconst ready = () => renderOrders({ status: 'ready', orders: [{ number: 1042, customer: 'Ana' }, { number: 1043, customer: '<b>Ben</b>' }] });\ntest('lists the orders', () => { assert.match(ready(), /1042/); assert.match(ready(), /Ana/); });\ntest('escapes customer names', () => { assert.match(ready(), /&lt;b&gt;Ben/); assert.doesNotMatch(ready(), /<b>Ben/); });\ntest('loading shows the spinner', () => assert.match(renderOrders({ status: 'loading' }), /class=\"spinner\"/));\ntest('an error shows the error state', () => { const failed = renderOrders({ status: 'error', error: 'Server <down>' }); assert.match(failed, /role=\"alert\"/); assert.match(failed, /Server &lt;down&gt;/); });\ntest('no orders shows the empty state', () => assert.match(renderOrders({ status: 'ready', orders: [] }), /class=\"empty\"/));") } },
    rubric: 'Handles loading, error and empty the way the other views do, reusing their helpers, and escapes names.',
    trace: [{ steps: [{ type: 'write', folder: 'web', file: 'orders.mjs', content: view('orders', 'order', 'No orders yet.', '#${order.number} ${escape(order.customer)}') }, { type: 'say', text: 'renderOrders follows the other views.' }], usage: { input: 1500, cached: 400, output: 160, reasoning: 30 } }],
  },
  {
    id: 'api-endpoint', starter: 'api-contracts', title: 'A new endpoint that checks who may call it',
    folders: { api: { 'store.mjs': "export const users = new Map([\n  ['u1', { id: 'u1', name: 'Ana', email: 'ana@example.com', passwordHash: 'hash-1', admin: false }],\n  ['u2', { id: 'u2', name: 'Ben', email: 'ben@example.com', passwordHash: 'hash-2', admin: false }],\n  ['u3', { id: 'u3', name: 'Cy', email: 'cy@example.com', passwordHash: 'hash-3', admin: true }],\n]);\n", 'routes.mjs': ROUTES } },
    prompt: "Add renameUser to routes.mjs so a user's name can be changed. The web app will call it with the user's id and the new name.",
    check: { api: { 'rename.test.mjs': test("import { getUser, renameUser } from '../routes.mjs';\nconst ana = { id: 'u1', admin: false }, ben = { id: 'u2', admin: false }, cy = { id: 'u3', admin: true };\nconst call = (user, id, name) => renameUser({ user, params: { id }, body: name === undefined ? {} : { name } });\nconst nameOf = id => getUser({ params: { id } }).body.name;\ntest('a user can rename themselves, and the reply leaks nothing', () => { const own = call(ana, 'u1', 'Ana Maria'); assert.equal(own.status, 200); assert.doesNotMatch(JSON.stringify(own.body), /passwordHash|hash-1/); assert.equal(nameOf('u1'), 'Ana Maria'); });\ntest('someone else is refused with 403', () => { const before = nameOf('u1'), other = call(ben, 'u1', 'Taken'); assert.equal(other.status, 403); assert.equal(typeof other.body?.error?.code, 'string'); assert.equal(nameOf('u1'), before); });\ntest('an admin can rename anyone', () => { assert.equal(call(cy, 'u2', 'Benjamin').status, 200); assert.equal(nameOf('u2'), 'Benjamin'); });\ntest('an unknown user is 404', () => { const missing = call(cy, 'nobody', 'X'); assert.equal(missing.status, 404); assert.equal(typeof missing.body?.error?.code, 'string'); });\ntest('a missing, empty or non-text name is refused with 400', () => { const before = nameOf('u1'); for (const name of [undefined, '', 42]) { const bad = call(ana, 'u1', name); assert.equal(bad.status, 400, String(name)); assert.equal(typeof bad.body?.error?.code, 'string'); } assert.equal(nameOf('u1'), before); });") } },
    rubric: 'Only the user or an admin may rename; bad input is refused in the project\'s error shape; the response leaks nothing new.',
    trace: [{ steps: [{ type: 'write', folder: 'api', file: 'routes.mjs', content: ROUTES + lines(['', 'export function renameUser({ user, params, body }) {', '  const found = users.get(params.id);', "  if (!found) return fail(404, 'not_found', 'No such user.');", "  if (user.id !== params.id && !user.admin) return fail(403, 'forbidden', 'You can only rename your own account.');", '  const name = body?.name;', "  if (typeof name !== 'string' || !name.trim()) return fail(400, 'invalid_name', 'Give a name.');", '  found.name = name.trim();', '  return { status: 200, body: publicUser(found) };', '}']) }, { type: 'say', text: 'POST renameUser { name } returns the public user; 400, 403 and 404 use the usual error shape.' }], usage: { input: 1800, cached: 400, output: 220, reasoning: 40 } }],
  },
  {
    id: 'data-migration', starter: 'database-migration-planning', title: 'A migration that works on existing data and can be undone',
    folders: { db: { 'db.mjs': TABLES, 'migrate.mjs': MIGRATE,
      'migrations/001_create_users.mjs': "export function up(db) { db.createTable('users', { id: { required: true }, email: { required: true } }); }\nexport function down(db) { db.dropTable('users'); }\n",
      'migrations/002_add_nickname.mjs': "export function up(db) { db.addColumn('users', 'nickname'); }\nexport function down(db) { db.dropColumn('users', 'nickname'); }\n",
      'migrate.test.mjs': test("import { Database } from './db.mjs';\nimport { migrate, rollback } from './migrate.mjs';\ntest('every migration applies and rolls back', async () => {\n  const db = new Database();\n  await migrate(db);\n  while (db.applied.length) await rollback(db);\n  assert.deepEqual(db.tables, {});\n});") } },
    prompt: 'Every user now needs a country, as a two-letter code, and sign-up will always send one. All existing users signed up in Germany. Add the migration for it.',
    check: { db: { 'country.test.mjs': test("import { Database } from '../db.mjs';\nimport { migrations } from '../migrate.mjs';\n// The database as it is in production: the earlier migrations applied, with users in it, then the new ones.\nconst applied = async () => {\n  const all = await migrations(); assert(all.length >= 3, 'No new migration.');\n  const db = new Database();\n  for (const step of all.slice(0, 2)) step.up(db);\n  db.insert('users', { id: 1, email: 'a@example.com' }); db.insert('users', { id: 2, email: 'b@example.com', nickname: 'bee' });\n  for (const step of all.slice(2)) step.up(db);\n  return { db, added: all.slice(2) };\n};\ntest('applies to a table that already has users, who get DE', async () => { const { db } = await applied(); assert.deepEqual(db.select('users').map(row => row.country), ['DE', 'DE']); });\ntest('country is required', async () => { const { db } = await applied(); assert.equal(db.table('users').columns.country.required, true); });\ntest('undoing it removes only the country', async () => {\n  const { db, added } = await applied();\n  db.insert('users', { id: 3, email: 'c@example.com', country: 'FR' });\n  for (const step of [...added].reverse()) step.down(db);\n  assert.equal('country' in db.table('users').columns, false);\n  assert.deepEqual(db.select('users').map(row => [row.email, row.nickname]), [['a@example.com', null], ['b@example.com', 'bee'], ['c@example.com', null]]);\n  for (const step of added) step.up(db);\n});") } },
    rubric: 'Works on a table that already has rows, fills in existing users, and its undo removes only what it added.',
    trace: [{ steps: [{ type: 'write', folder: 'db', file: 'migrations/003_add_country.mjs', content: lines(['// Every user has a country. Existing users all signed up in Germany.', 'export function up(db) {', "  db.addColumn('users', 'country');", "  db.update('users', row => { row.country = 'DE'; });", "  db.setRequired('users', 'country', true);", '}', "export function down(db) { db.dropColumn('users', 'country'); }"]) }, { type: 'say', text: 'Added 003_add_country: optional first, filled with DE, then required.' }], usage: { input: 2200, cached: 500, output: 180, reasoning: 40 } }],
  },
  {
    id: 'accessible-toolbar', starter: 'accessibility', title: 'Controls a keyboard and a screen reader can use',
    folders: { web: { 'ui.mjs': UI, 'toolbar.mjs': lines(["import { escape } from './ui.mjs';", '', '// The toolbar above the results list. query is the current search, and count how many results match it.', "export function renderToolbar({ query = '', count = 0 } = {}) {", "  return '<div class=\"toolbar\"><h2>Results</h2></div>';", '}']) } },
    prompt: 'In toolbar.mjs, add a search field showing the current query, a small × button that clears it, and a line saying how many results match, like "12 results".',
    check: { web: { 'toolbar.test.mjs': test("import { renderToolbar } from '../toolbar.mjs';\nconst html = () => renderToolbar({ query: 'red', count: 12 });\ntest('the search field has a label', () => {\n  const input = html().match(/<input\\b[^>]*>/i); assert(input, 'No search field.');\n  const id = input[0].match(/\\bid=\"([^\"]+)\"/i)?.[1];\n  assert(/aria-label(ledby)?=\"[^\"]+\"/i.test(input[0]) || (id && new RegExp(`<label[^>]*\\\\bfor=\"${id}\"`, 'i').test(html())) || /<label\\b[^>]*>(?:(?!<\\/label>)[\\s\\S])*<input/i.test(html()));\n});\ntest('the clear control is a button with a name', () => assert([...html().matchAll(/<button\\b([^>]*)>([\\s\\S]*?)<\\/button>/gi)].some(([, attributes, inner]) => /(aria-label|aria-labelledby|title)=\"[^\"]*[a-z][^\"]*\"/i.test(attributes) || /[a-z]{2}/i.test(inner.replace(/<([a-z]+)[^>]*aria-hidden=\"true\"[^>]*>[\\s\\S]*?<\\/\\1>/gi, '').replace(/<[^>]+>/g, '').replace(/&\\w+;/g, '')))));\ntest('the result count is announced', () => assert.match(html(), /<\\w+\\b[^>]*(role=\"status\"|aria-live=\"(polite|assertive)\")[^>]*>[\\s\\S]*?12/i));") } },
    rubric: 'The field has a label, the × is a real button with a name, and the count is announced when it changes.',
    trace: [{ steps: [{ type: 'write', folder: 'web', file: 'toolbar.mjs', content: lines(["import { escape } from './ui.mjs';", '', '// The toolbar above the results list. query is the current search, and count how many results match it.', "export function renderToolbar({ query = '', count = 0 } = {}) {", '  return `<div class="toolbar"><h2>Results</h2>`', '    + `<label for="search">Search</label><input id="search" type="search" value="${escape(query)}">`', '    + \'<button type="button" aria-label="Clear search">×</button>\'', '    + `<p role="status">${count} ${count === 1 ? \'result\' : \'results\'}</p></div>`;', '}']) }, { type: 'say', text: 'Added a labelled field, a named clear button and an announced count.' }], usage: { input: 1400, cached: 300, output: 170, reasoning: 30 } }],
  },
  {
    id: 'review-intent', starter: 'independent-review', title: 'Review a change against what it says it does', readOnly: true,
    folders: { app: { 'coupon.mjs': COUPON,
      'coupon.test.mjs': test("import { applyCoupon } from './coupon.mjs';\ntest('WELCOME10 takes 10% off', () => assert.equal(applyCoupon({ total: 1000 }, 'WELCOME10', { usedCoupons: [] }).total, 900));\ntest('WELCOME10 works only once', () => assert.equal(applyCoupon({ total: 1000 }, 'WELCOME10', { usedCoupons: ['WELCOME10'] }).reason, 'already-used'));"),
      'PR.md': '# Coupon codes\n\nAdds coupon codes at checkout. WELCOME10 takes 10% off and each customer can use it only once. SPRING5 takes 5% off. Codes are case-insensitive. Covered by coupon.test.mjs.\n' } },
    prompt: 'Review the coupon change described in PR.md. Do not change anything.',
    // Both seeded defects: a use is never recorded, so "only once" isn't enforced, and the used-code check is case-sensitive.
    replyParts: REVIEW_FINDINGS,
    checkReply: new RegExp(`^${Object.values(REVIEW_FINDINGS).map(pattern => `(?=${pattern.source})`).join('')}`, 'i'),
    rubric: 'Finds that a use is never recorded and that the check is case-sensitive, notices the test starts already used, and changes nothing.',
    trace: [{ steps: [{ type: 'say', text: 'applyCoupon never records a use in customer.usedCoupons, so WELCOME10 can be used again and again; the "only once" test passes only because it starts with the code already used. And usedCoupons.includes(code) compares the code as typed, while the lookup uses toUpperCase(), so "welcome10" gets past the check.' }], usage: { input: 1200, cached: 0, output: 140, reasoning: 30 } }],
  },
  {
    id: 'test-writing', starter: 'test-authoring', title: 'Tests that would catch a realistic slip',
    folders: { lib: { 'duration.mjs': DURATION, 'package.json': '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' } },
    prompt: 'Write tests for parseDuration in duration.mjs.',
    check: { lib: { 'mutants.test.mjs': MUTATION_CHECK } },
    rubric: 'Tests the observable results, including every unit, empty text and wrong text, and they pass on the real code.',
    trace: [{ steps: [{ type: 'write', folder: 'lib', file: 'duration.test.mjs', content: test("import { parseDuration } from './duration.mjs';\ntest('units and combinations', () => { assert.equal(parseDuration('2h'), 7200); assert.equal(parseDuration('1h30m'), 5400); assert.equal(parseDuration('45s'), 45); assert.equal(parseDuration(' 1m5s '), 65); });\ntest('empty or wrong text throws', () => { for (const text of ['', '   ', 'abc', '5', '1x']) assert.throws(() => parseDuration(text)); });") }, { type: 'say', text: 'Added duration.test.mjs: each unit, a combination, and empty and wrong text.' }], usage: { input: 1300, cached: 300, output: 200, reasoning: 40 } }],
  },
];

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
  ...starterTasks,
];
// The same repository and hidden acceptance check as the manual small-edit baseline. Only the routing policy and
// recorded assessor prefix differ; both invocations go through provider workers and the broker journal.
fixtures.push({
  ...fixtures[0], id: 'routing-assessment', title: 'Routing assessment and builder on the small-edit baseline', routing: 'smart',
  trace: [
    { steps: [{ type: 'say', text: JSON.stringify({ tier: 'light', effort: 'low', reason: 'A single formatter edit with a precise expected result.' }) }], usage: { input: 300, cached: 0, output: 40, reasoning: 10 } },
    ...fixtures[0].trace,
  ],
});
export const fixtureById = id => fixtures.find(fixture => fixture.id === id);

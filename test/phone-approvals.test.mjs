import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/phone.js', import.meta.url), 'utf8');

// Just enough of a page to draw the phone's cards.
function element(tag, cls = '', text) {
  const value = { tag, className: cls, textContent: text ?? '', children: [], attributes: {}, disabled: false, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute(key, next) { this.attributes[key] = next; }, querySelectorAll: () => [] };
  return value;
}
const flat = root => [root, ...root.children.flatMap(flat)];
function load(from, to) {
  const context = { URL, setTimeout: () => {}, node: element, glyph: () => element('i'), name: provider => provider[0].toUpperCase() + provider.slice(1), attempt: fn => fn, S: {} };
  context.button = (text, handler, cls) => { const value = element('button', cls, text); value.handler = handler; return value; };
  context.card = (cls = '') => element('article', `card ${cls}`.trim());
  context.armed = () => {}; context.openSheet = () => {}; context.closeSheet = () => {}; context.api = async () => ({}); context.endpoint = () => ''; context.refreshConversation = async () => {};
  vm.runInNewContext(source.slice(source.indexOf(from), source.indexOf(to)), context);
  return context;
}

test('the phone says who a connector request reaches and what it will do, and never reads a parameter as a command (#111)', () => {
  const { approvalCard } = load('function approvalCard', "// An agent's questions, one at a time.");
  const tool = flat(approvalCard({ id: 'tool', provider: 'codex', kind: 'mcpServer/elicitation/request', connector: 'GitHub', title: 'create_issue', details: 'repository_full_name: me/repo' }, 1));
  assert.equal(tool.find(item => item.tag === 'h2').textContent, 'Codex wants to use GitHub');
  assert.deepEqual(tool.filter(item => item.tag === 'pre').map(item => item.textContent), ['repository_full_name: me/repo']);
  assert.deepEqual(tool.filter(item => item.tag === 'button').map(item => item.textContent), ['Deny', 'Approve'], 'A tool call can only be allowed once.');
  const bare = flat(approvalCard({ id: 'bare', provider: 'codex', kind: 'mcpServer/elicitation/request', connector: 'Notes', title: 'clear', details: '' }, 1));
  assert.equal(bare.some(item => /Requested action/.test(item.textContent)), false, "The protocol's method name is not shown.");
  const access = flat(approvalCard({ id: 'access', provider: 'codex', kind: 'item/permissions/requestApproval', title: 'Network access', details: 'Reason: Needs to fetch' }, 1));
  assert.equal(access.find(item => item.tag === 'h2').textContent, 'Codex wants more access');
  assert.deepEqual(access.filter(item => item.tag === 'pre').map(item => item.textContent), ['Reason: Needs to fetch']);
});

test('a question on the phone offers its link and shows who it goes to (#111)', () => {
  const { questionCard } = load('function questionCard', '  function handoffCard(offer)');
  const link = 'https://example.com/sign-in?token=one-time';
  const card = flat(questionCard({ id: 'ask', provider: 'codex', questions: [{ id: 'confirm', header: 'codex_apps', question: 'Sign in to GitHub to continue', link, options: [{ label: 'Done' }, { label: 'Cancel' }] }] }));
  const open = card.find(item => item.tag === 'a');
  assert.equal(open.textContent, 'Open example.com', 'The label shows the address, not its one-time token.');
  assert.equal(open.href, link);
  assert.equal(open.rel, 'noopener noreferrer');
  const plain = flat(questionCard({ id: 'ask', provider: 'codex', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'One' }] }] }));
  assert.equal(plain.some(item => item.tag === 'a'), false);
});

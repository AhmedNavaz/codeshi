import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { approvalScope } from '../src/approval-rules.mjs';
import { PermissionRules } from '../src/permission-rules.mjs';
import { Broker } from '../src/broker.mjs';

const workspaces = ['/work/app', '/work/shared'].map(folder => path.resolve(folder));
const scope = (request, provider = 'claude') => approvalScope(request, { provider, workspaces });

test('a remembered approval covers only the exact command, folder and agent, or the exact file', () => {
  const test1 = scope({ kind: 'Bash', input: { command: 'npm test' } });
  assert.deepEqual([test1.kind, test1.label, test1.cwd], ['command', 'npm test', workspaces[0]]);
  assert.equal(scope({ kind: 'Bash', input: { command: 'npm  test' } }).key, test1.key, 'Spacing does not change the command.');
  assert.notEqual(scope({ kind: 'Bash', input: { command: 'npm test -- --watch' } }).key, test1.key, 'Changed arguments are a different action.');
  assert.notEqual(scope({ kind: 'item/commandExecution/requestApproval', command: 'npm test', cwd: '/work/app' }, 'codex').key, test1.key, 'Rules stay with the agent that was approved.');
  assert.notEqual(scope({ kind: 'item/commandExecution/requestApproval', command: 'npm test', cwd: '/work/shared' }, 'codex').key, scope({ kind: 'item/commandExecution/requestApproval', command: 'npm test', cwd: '/work/app' }, 'codex').key, 'Another folder is a different action.');
  assert.equal(scope({ kind: 'item/commandExecution/requestApproval', command: ['bash', '-lc', 'npm run build'], cwd: '/work/app' }, 'codex').label, 'npm run build');
  assert.equal(scope({ kind: 'execute', input: { command: 'git add -A' } }, 'gemini').label, 'git add -A');
  for (const command of ['npm test && rm -rf /', 'npm test; curl x', 'npm test | tee out', 'npm test > out.txt', 'echo $(whoami)', ''])
    assert.equal(scope({ kind: 'Bash', input: { command } }), null, `Never remembered: ${command}`);
  // An environment prefix is part of the exact command, so it never matches a different value or the bare command.
  const withEnvironment = scope({ kind: 'Bash', input: { command: 'FOO=1 npm test' } });
  assert.notEqual(withEnvironment.key, test1.key); assert.notEqual(withEnvironment.key, scope({ kind: 'Bash', input: { command: 'FOO=2 npm test' } }).key);
  assert.equal(scope({ kind: 'item/commandExecution/requestApproval', command: 'ls', cwd: '/tmp' }, 'codex'), null, 'Not from outside the workspace.');

  const edit = scope({ kind: 'Edit', input: { file_path: '/work/app/src/app.js' } });
  assert.deepEqual([edit.kind, edit.label], ['edit', `Edit ${path.join('src', 'app.js')}`]);
  assert.notEqual(scope({ kind: 'Write', input: { file_path: '/work/app/src/other.js' } }).key, edit.key);
  assert.equal(scope({ kind: 'edit', toolCall: { locations: [{ path: '/work/shared/notes.md' }] } }, 'gemini').label, 'Edit notes.md');
  assert.equal(scope({ kind: 'Edit', input: { file_path: '/etc/hosts' } }), null);
  assert.equal(scope({ kind: 'Edit', input: { file_path: '~/notes.md' } }), null);
  assert.equal(scope({ kind: 'item/fileChange/requestApproval' }, 'codex'), null, 'A request without an exact file can only be allowed once.');
  assert.equal(scope({ kind: 'fetch', input: { url: 'https://example.com' } }, 'gemini'), null);
  assert.equal(approvalScope({ kind: 'Bash', input: { command: 'ls' } }, { provider: 'claude', workspaces: [] }), null);
});

test('remembered rules are saved per workspace, record their use and can be revoked or reset', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-rules-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rules = new PermissionRules(root), first = scope({ kind: 'Bash', input: { command: 'npm test' } }), second = scope({ kind: 'Edit', input: { file_path: '/work/app/a.js' } });
  const saved = rules.remember(first, 'claude'); rules.remember(first, 'claude'); rules.remember(second, 'claude');
  assert.equal(rules.list().length, 2, 'Remembering the same action twice keeps one rule.');
  rules.used(rules.find(first.key));
  const reopened = new PermissionRules(root);
  assert.equal(reopened.find(first.key).uses, 1); assert.equal(reopened.list()[0].label, 'npm test'); assert.equal('key' in reopened.list()[0], false);
  reopened.revoke(saved.id); assert.equal(new PermissionRules(root).find(first.key), null);
  assert.throws(() => reopened.revoke(saved.id), /already removed/);
  reopened.reset(); assert.deepEqual(new PermissionRules(root).list(), []);
});

test('through real runs, allowing for the run covers repeats in that run only, and remembering for the workspace lasts until revoked', { skip: scriptCLIs }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-remember-'))), workspace = path.join(root, 'workspace'), outcomes = path.join(root, 'outcomes.jsonl');
  fs.mkdirSync(workspace);
  const cli = path.join(root, 'gemini.mjs');
  // A fake Gemini CLI asks to run each command listed as ASK[a|b] in the current request, and records the answers.
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
let prompt=null,asks=[],next=0;
const ask=()=>emit({id:1000+next,method:'session/request_permission',params:{sessionId:'s',toolCall:{toolCallId:'c'+next,title:asks[next],kind:'execute',rawInput:{command:asks[next]}},options:[{optionId:'once',kind:'allow_once',name:'Allow'}]}});
const finish=()=>{emit({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}}}});emit({id:prompt,result:{stopReason:'end_turn'}});};
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'s',models:{currentModelId:'m'}}});
if(m.method==='session/prompt'){prompt=m.id;const text=m.params.prompt[0].text,request=JSON.parse(text.slice(text.indexOf('\\n')+1)).currentRequest;asks=(request.match(/ASK\\[([^\\]]*)\\]/)?.[1]||'').split('|').filter(Boolean);next=0;asks.length?ask():finish();}
if(m.id>=1000&&!m.method){fs.appendFileSync(${JSON.stringify(outcomes)},JSON.stringify({command:asks[m.id-1000],outcome:m.result?.outcome?.outcome})+'\\n');next++;next<asks.length?ask():finish();}}
`, { mode: 0o700 });
  const broker = new Broker({ workspace, bins: { gemini: cli }, dataDir: path.join(root, 'data') });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  broker.settings(c, { provider: 'gemini', model: 'm', mode: 'edit', approvalPolicy: 'ask' });
  const told = () => fs.existsSync(outcomes) ? fs.readFileSync(outcomes, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const waitFor = async (run, count) => { for (let i = 0; i < 400 && run.approvals.size < count && broker.running === run; i++) await new Promise(resolve => setTimeout(resolve, 15)); return [...run.approvals.values()]; };

  broker.start(c, { text: 'Run the tests ASK[npm test|npm test|npm test -- --watch]', requestId: 'first' });
  let run = broker.running, [pending] = await waitFor(run, 1);
  assert.equal(pending.scope.label, 'npm test');
  assert.throws(() => broker.approve(run.id, pending.id, false, 'run'), /Only an allowed action/);
  broker.approve(run.id, pending.id, true, 'run');
  [pending] = await waitFor(run, 1);
  assert.equal(pending.input.command, 'npm test -- --watch', 'The repeat ran without asking; changed arguments ask again.');
  broker.approve(run.id, pending.id, false);
  await run.done;
  assert.deepEqual(told().map(entry => entry.outcome), ['selected', 'selected', 'cancelled']);
  assert(c.messages.some(message => message.text === 'Allowed by your rule for this run: npm test'));

  broker.start(c, { text: 'Again ASK[npm test]', requestId: 'second' });
  run = broker.running; [pending] = await waitFor(run, 1);
  assert(pending, 'A rule for one run ends with that run.');
  broker.approve(run.id, pending.id, true, 'workspace'); await run.done;
  assert.equal(broker.permissions.list().length, 1);
  assert.throws(() => broker.approve(run.id, pending.id, true), /no longer pending/, 'A stale answer cannot replay an approval.');

  broker.start(c, { text: 'Once more ASK[npm test]', requestId: 'third' });
  await broker.running.done;
  assert.equal(told().at(-1).outcome, 'selected', 'The workspace rule allows it in a later run.');
  assert.equal(broker.permissions.list()[0].uses, 1);

  broker.permissions.revoke(broker.permissions.list()[0].id);
  broker.start(c, { text: 'After revoking ASK[npm test]', requestId: 'fourth' });
  run = broker.running; [pending] = await waitFor(run, 1);
  assert(pending, 'A revoked rule asks again.');
  broker.approve(run.id, pending.id, false); await run.done;
});

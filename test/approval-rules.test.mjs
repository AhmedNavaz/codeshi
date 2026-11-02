import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import { readOnlyCommand, readOnlyRequest } from '../src/approval-rules.mjs';

const workspaces = ['/work/app', '/work/shared'], cwd = '/work/app';
const reads = command => readOnlyCommand(command, { cwd, workspaces });

test('commands that only read the workspace run without asking', () => {
  for (const command of [
    'ls', 'ls -la src', 'pwd', 'cat README.md', 'head -n 40 src/app.js', 'tail -n 20 logs/out.txt', 'wc -l src/*.js',
    'grep -rn "TODO" src', 'rg --hidden -n useState', 'rg -n foo | head -20', 'find . -name "*.test.mjs"', 'tree -L 2',
    'git status', 'git status --short', 'git diff', 'git diff --stat HEAD~1', 'git log --oneline -20', 'git show HEAD', 'git branch',
    'git branch --show-current', 'git -C ../shared log -3', 'git --no-pager diff', 'git ls-files', 'git tag', 'git tag -l "v*"',
    'git remote -v', 'git config --get user.name', 'git blame src/app.js', 'node --version', 'npm -v', 'python3 --version', 'go version',
    'cat ../shared/notes.md', 'stat package.json', 'du -sh src', 'which node', 'echo done', 'date +%Y',
  ]) assert.equal(reads(command), true, command);
});

test('commands that change things, run code, reach the network or leave the workspace still ask', () => {
  for (const command of [
    'rm -rf dist', 'mv a b', 'cp a b', 'touch x', 'mkdir out', 'chmod +x run.sh', 'npm install', 'npm test', 'node script.js', 'python3 run.py',
    './run.sh', '/usr/bin/ls', 'curl https://example.com', 'wget https://example.com', 'git commit -m x', 'git push', 'git checkout main',
    'git branch new-feature', 'git branch -D old', 'git tag v1.0', 'git reset --hard', 'git stash', 'git fetch', 'git pull', 'git remote add x y',
    'git config user.name x', 'git -c core.pager=less log', 'git reflog expire --all', 'git diff --output=patch.txt',
    'find . -delete', 'find . -name x -exec rm {} ;', 'sort -o out.txt in.txt', 'sed -i s/a/b/ file', 'awk "{print}" file', 'xargs rm',
    'rg --pre ./decode foo', 'tail -f server.log', 'date -s 2020-01-01',
    'cat file > out.txt', 'cat file >> out.txt', 'ls; rm x', 'ls && rm x', 'ls || rm x', 'echo $(rm x)', 'echo `rm x`', 'echo $HOME',
    'FOO=1 ls', 'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat ../../outside.txt', 'ls /', 'git -C /tmp status', 'cat "unterminated',
    'grep -r secret ~', '', 'printenv', 'env',
  ]) assert.equal(reads(command), false, command);
});

test('a read outside the workspace folders asks, as does any command run from outside them', () => {
  assert.equal(readOnlyCommand('ls', { cwd: '/tmp', workspaces }), false);
  assert.equal(readOnlyCommand('ls', { cwd: '/work/shared/docs', workspaces }), true);
});

test('Codex argv commands, including a shell wrapper, are judged by the command they run', () => {
  assert.equal(reads(['bash', '-lc', 'git status']), true);
  assert.equal(reads(['/bin/zsh', '-lc', 'rg -n foo src']), true);
  assert.equal(reads(['bash', '-lc', 'npm install']), false);
  assert.equal(reads(['ls', '-la']), true);
  assert.equal(reads(['rm', '-rf', 'dist']), false);
});

test('approval requests from each agent are recognized: reads inside the workspace pass, edits and outside reads ask', () => {
  const allowed = request => readOnlyRequest(request, { workspaces });
  // Claude
  assert.equal(allowed({ kind: 'Read', input: { file_path: '/work/app/src/app.js' } }), true);
  assert.equal(allowed({ kind: 'Read', input: { file_path: '/Users/me/.aws/credentials' } }), false);
  assert.equal(allowed({ kind: 'Glob', input: { pattern: '**/*.ts' } }), true);
  assert.equal(allowed({ kind: 'Glob', input: { pattern: '/etc/*' } }), false);
  assert.equal(allowed({ kind: 'Grep', input: { pattern: 'TODO', path: 'src' } }), true);
  assert.equal(allowed({ kind: 'Bash', input: { command: 'git diff --stat' } }), true);
  assert.equal(allowed({ kind: 'Bash', input: { command: 'npm run build' } }), false);
  assert.equal(allowed({ kind: 'Edit', input: { file_path: '/work/app/src/app.js' } }), false);
  assert.equal(allowed({ kind: 'Write', input: { file_path: '/work/app/new.js' } }), false);
  // Codex
  assert.equal(allowed({ kind: 'item/commandExecution/requestApproval', command: 'ls -la', cwd: '/work/app' }), true);
  assert.equal(allowed({ kind: 'item/commandExecution/requestApproval', command: 'ls -la', cwd: '/' }), false);
  assert.equal(allowed({ kind: 'item/fileChange/requestApproval', changes: {} }), false);
  // Gemini and Antigravity (ACP)
  assert.equal(allowed({ kind: 'read', input: { absolute_path: '/work/app/README.md' }, toolCall: { locations: [{ path: '/work/app/README.md' }] } }), true);
  assert.equal(allowed({ kind: 'read', toolCall: { locations: [{ path: '/etc/hosts' }] } }), false);
  assert.equal(allowed({ kind: 'search', input: { pattern: 'foo', dir_path: '/work/shared' } }), true);
  assert.equal(allowed({ kind: 'execute', input: { command: 'git log -5' } }), true);
  assert.equal(allowed({ kind: 'execute', input: { command: 'rm -rf .' } }), false);
  assert.equal(allowed({ kind: 'edit', input: { path: '/work/app/a.js' } }), false);
  assert.equal(allowed({ kind: 'fetch', input: { url: 'https://example.com' } }), false);
  assert.equal(allowed({ kind: 'delete', toolCall: { locations: [{ path: '/work/app/a.js' }] } }), false);
  assert.equal(readOnlyRequest({ kind: 'Read', input: { file_path: 'a.js' } }, { workspaces: [] }), false, 'With no workspace folder nothing is judged inside.');
});

test('through a real run, a read-only command goes ahead while a change waits for approval', { skip: scriptCLIs }, async t => {
  const fs = (await import('node:fs')).default, os = (await import('node:os')).default, path = (await import('node:path')).default;
  const { Broker } = await import('../src/broker.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-approval-'))), workspace = path.join(root, 'workspace'), outcomes = path.join(root, 'outcomes.jsonl');
  fs.mkdirSync(workspace);
  const cli = path.join(root, 'gemini.mjs');
  // A fake Gemini CLI asks permission to run two commands and records what it was told.
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
const asks=[['git-status','git status'],['remove','rm -rf build']];let prompt=null,next=0;
const ask=()=>{const [id,command]=asks[next];emit({id:1000+next,method:'session/request_permission',params:{sessionId:'s',toolCall:{toolCallId:id,title:command,kind:'execute',rawInput:{command}},options:[{optionId:'once',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});};
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'s',models:{currentModelId:'m'}}});
if(m.method==='session/prompt'){prompt=m.id;ask();}
if(m.id>=1000&&!m.method){fs.appendFileSync(${JSON.stringify(outcomes)},JSON.stringify({command:asks[m.id-1000][1],outcome:m.result?.outcome?.outcome})+'\\n');next++;if(next<asks.length)ask();else{emit({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}}}});emit({id:prompt,result:{stopReason:'end_turn'}});}}}
`, { mode: 0o700 });
  const broker = new Broker({ workspace, bins: { gemini: cli }, dataDir: path.join(root, 'data') });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const c = broker.get(broker.create().id);
  broker.settings(c, { provider: 'gemini', model: 'm', mode: 'edit', approvalPolicy: 'ask' });
  broker.start(c, { text: 'Tidy the build', requestId: 'approval-run' });
  const run = broker.running;
  for (let i = 0; i < 200 && run.approvals.size === 0; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const pending = [...run.approvals.values()];
  assert.equal(pending.length, 1, 'Only the change waits for approval.');
  assert.equal(pending[0].input.command, 'rm -rf build');
  const told = () => fs.readFileSync(outcomes, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(told(), [{ command: 'git status', outcome: 'selected' }], 'The read-only command went ahead without asking.');
  await broker.approve(run.id, pending[0].id, false);
  await run.done;
  assert.deepEqual(told().map(entry => entry.outcome), ['selected', 'cancelled']);
});

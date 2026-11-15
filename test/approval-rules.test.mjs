import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptCLIs } from './platform.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardedReason, guardedWrite, readOnlyCommand, readOnlyRequest } from '../src/approval-rules.mjs';
import { runClaude } from '../src/providers.mjs';

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

// A task changes only its own copy or folder: the workspace's real folders are guarded, whatever the approval policy.
function guardedFolders(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeshi-guard-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'app'), site = path.join(root, 'my site'), copy = path.join(root, 'data', 'tasks', 't1', 'worktree');
  for (const folder of [real, site, copy]) fs.mkdirSync(folder, { recursive: true });
  return { root, real, site, copy, guarded: [{ path: real, name: 'app', copy }, { path: site, name: 'my site', copy: null }] };
}

test('a task can’t change the workspace’s real folders: edits, file changes, write access and commands that name them are refused', t => {
  const { root, real, site, copy, guarded } = guardedFolders(t);
  const guard = request => guardedWrite(request, { own: [copy], guarded, home: root, caseless: false })?.folder.name ?? null;
  // Changes by path, as each agent asks for them.
  assert.equal(guard({ kind: 'Edit', input: { file_path: path.join(real, 'src/a.js') } }), 'app', 'The real folder its copy came from.');
  assert.equal(guard({ kind: 'Write', input: { file_path: path.join(site, 'lib/content.ts') } }), 'my site', 'Another folder of the workspace.');
  assert.equal(guard({ kind: 'MultiEdit', input: { file_path: path.join(real, 'a.js') } }), 'app');
  assert.equal(guard({ kind: 'edit', input: { action: 'Edit 2 files' }, paths: [path.join(copy, 'a.js'), path.join(site, 'b.ts')] }), 'my site', 'A multi-file edit is checked file by file.');
  assert.equal(guard({ kind: 'item/fileChange/requestApproval', itemId: 'i1', paths: [path.join(real, 'x.js')] }), 'app', 'A Codex file change, by the files it started with.');
  assert.equal(guard({ kind: 'item/fileChange/requestApproval', itemId: 'i2', grantRoot: site }), 'my site', 'Or by the folder it asks to write to.');
  assert.equal(guard({ kind: 'item/permissions/requestApproval', writes: [real] }), 'app', 'Write access asked for.');
  // Its own copy, and anywhere else, are left to the approval policy.
  assert.equal(guard({ kind: 'Edit', input: { file_path: path.join(copy, 'src/a.js') } }), null);
  assert.equal(guard({ kind: 'Write', input: { file_path: path.join(root, 'scratch', 'capture.cjs') } }), null);
  assert.equal(guard({ kind: 'item/fileChange/requestApproval', itemId: 'i3' }), null, 'A change it can’t see the files of is up to the policy.');
  // Reading a guarded folder changes nothing.
  assert.equal(guard({ kind: 'Read', input: { file_path: path.join(site, 'lib/content.ts') } }), null);
  assert.equal(guard({ kind: 'read', toolCall: { locations: [{ path: path.join(site, 'x') }] } }), null);
  assert.equal(guard({ kind: 'Bash', input: { command: `cat "${path.join(site, 'lib/content.ts')}"` } }), null);
  assert.equal(guard({ kind: 'Bash', input: { command: `git -C ${real} status --short` } }), null);
  // A command is refused when it names a guarded folder, however it writes the path, or runs there.
  for (const command of [`touch ${site.replace(' ', '\\ ')}/x`, `sed -i '' s/a/b/ '${path.join(site, 'x.ts')}'`, 'rm -rf ~/app/dist', 'echo hi > $HOME/app/notes.md', 'cp a ${HOME}/app/a', `npm --prefix=${real} run build`])
    assert.notEqual(guard({ kind: 'Bash', input: { command } }), null, command);
  assert.equal(guard({ kind: 'item/commandExecution/requestApproval', command: ['/bin/zsh', '-lc', `touch ${path.join(real, 'x')}`], cwd: copy }), 'app', 'Codex argv, through its shell wrapper.');
  assert.equal(guard({ kind: 'item/commandExecution/requestApproval', command: 'npm test', cwd: real }), 'app', 'A command that runs in the real folder.');
  for (const command of ['npm test && touch build/x', 'npm install', `node ${path.join(copy, 'run.mjs')}`, 'curl https://example.com/a/b', "sed -i '' s/app/site/ src/a.js", `cat > notes.md <<'EOF'\ncd "${site}" && rm -rf lib\nEOF`])
    assert.equal(guard({ kind: 'Bash', input: { command } }), null, command);
  // In another folder a task can run builds, tests, type checks, linters and dev servers, and copy files out.
  for (const command of [`cd "${site}" && npm run typecheck && npm run build`, `cd "${site}" && (PORT=3210 nohup npm run start > /tmp/site.log 2>&1 &) && sleep 4 && curl -sI http://localhost:3210/`, `npm --prefix "${site}" run build`, `cd "${site}" && npx next build 2>&1 | tail -30`, `cd "${site}" && npx tsc --noEmit && npm test`, `git clone "${site}" /tmp/site-base && cd /tmp/site-base && npm ci && npm run build`, `cp "${path.join(site, 'public/logo.svg')}" out/`, `cat "${path.join(site, 'lib/content.ts')}" | node check.mjs`, `bash -lc 'cd "${site}" && yarn build'`, `cp ${path.join(real, 'output/audit.md')} output/`])
    assert.equal(guard({ kind: 'Bash', input: { command } }), null, command);
  assert.equal(guard({ kind: 'execute', input: { command: 'npm run build', cwd: site } }), null, 'Run there by the folder it asks for.');
  assert.equal(guard({ kind: 'item/commandExecution/requestApproval', command: ['/bin/zsh', '-lc', 'npm run dev'], cwd: site }), null);
  // Anything else that changes it, or runs something unknown there, is still refused, as are runs in the real folder of
  // a copy, which belong in the copy.
  for (const command of [`cd "${site}" && npm install`, `cd "${site}" && npm run lint -- --fix`, `cd "${site}" && npm run format`, `cd "${site}" && npm test -- -u`, `cd "${site}" && npm run build > build.log`, `cd "${site}" && cat > lib/x.ts <<'EOF'\nexport const x = 1;\nEOF`, `cd "${site}" && npx prettier --write .`, `cd "${site}" && node scripts/gen.mjs`, `cd "${site}" && npm run build && git add -A`, `npm run build | tee "${site}/build.log"`, `echo "$(cd "${site}" && touch x)"`, `cp out/x.png "${site}/public/"`, `ffmpeg -i "${site}/demo.mp4" out.mp4`, `cd "${real}" && npm run build`])
    assert.notEqual(guard({ kind: 'Bash', input: { command } }), null, command);
  // A link into a guarded folder is followed, and on a case-insensitive disk any case names it.
  fs.symlinkSync(site, path.join(root, 'link'));
  assert.equal(guard({ kind: 'Write', input: { file_path: path.join(root, 'link', 'x.ts') } }), 'my site');
  assert.equal(guardedWrite({ kind: 'Edit', input: { file_path: path.join(real, 'A.js').toUpperCase() } }, { own: [copy], guarded, caseless: true })?.folder.name, 'app');
  // Working directly in its own folder keeps that folder open to it, and the workspace's other folders closed.
  const direct = [{ path: real, name: 'app', copy: null }, { path: site, name: 'my site', copy: null }];
  assert.equal(guardedWrite({ kind: 'Edit', input: { file_path: path.join(real, 'a.js') } }, { own: [real], guarded: direct }), null);
  assert.equal(guardedWrite({ kind: 'Edit', input: { file_path: path.join(site, 'a.ts') } }, { own: [real], guarded: direct })?.folder.name, 'my site');
  assert.equal(guardedWrite({ kind: 'Edit', input: { file_path: path.join(site, 'a.ts') } }, { own: [real], guarded: [] }), null, 'Outside a task nothing is guarded.');
  // The agent is told where to make the change instead.
  const fromCopy = guardedReason(guardedWrite({ kind: 'Edit', input: { file_path: path.join(real, 'src/a.js') } }, { own: [copy], guarded }), { own: [copy] });
  assert.match(fromCopy, /real app folder/); assert.ok(fromCopy.includes(`instead (${path.join(copy, 'src/a.js')})`), fromCopy);
  assert.match(guardedReason(guardedWrite({ kind: 'Edit', input: { file_path: path.join(site, 'a.ts') } }, { own: [copy], guarded }), { own: [copy] }), /another folder of this workspace.*say in your reply what it needs/);
});

test('Claude is told why Codeshi refused an action, and otherwise that it was declined', async () => {
  const decide = async refusal => {
    let decision;
    async function* queryImpl({ options }) { decision = await options.canUseTool('Edit', { file_path: '/site/x.ts' }, { toolUseID: 'edit-1' }); yield { type: 'result', subtype: 'success' }; }
    await runClaude({ workspace: '/copy', prompt: 'Change it', mode: 'edit' }, { queryImpl, event() {}, metadata() {}, approval: async () => false, ...(refusal ? { refusal } : {}) });
    return decision;
  };
  assert.deepEqual(await decide(id => id === 'edit-1' ? 'Codeshi blocked this: make the change in the copy.' : null), { behavior: 'deny', message: 'Codeshi blocked this: make the change in the copy.' });
  assert.deepEqual(await decide(null), { behavior: 'deny', message: 'The user declined this action.' });
});

test('through a real run with Full auto-approval, a task’s changes to the workspace’s real folders are refused and its own go ahead', { skip: scriptCLIs }, async t => {
  const { Broker } = await import('../src/broker.mjs');
  const { root, real, site, copy, guarded } = guardedFolders(t), outcomes = path.join(root, 'outcomes.jsonl'), cli = path.join(root, 'gemini.mjs');
  const asks = [
    { toolCallId: 'edit-real', title: 'Edit content.ts', kind: 'edit', rawInput: {}, content: [{ type: 'diff', path: path.join(site, 'lib/content.ts'), oldText: 'a', newText: 'b' }] },
    { toolCallId: 'build-real', title: 'npm run build', kind: 'execute', rawInput: { command: `cd "${real}" && npm run build` } },
    { toolCallId: 'build-site', title: 'npm run build', kind: 'execute', rawInput: { command: `cd "${site}" && npm run build` } },
    { toolCallId: 'build-copy', title: 'npm run build', kind: 'execute', rawInput: { command: 'npm run build' } },
  ];
  // A fake Gemini CLI asks permission for each, and records what it was told.
  fs.writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('0.66.0');process.exit(0);}
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
const asks=${JSON.stringify(asks)};let prompt=null,next=0;
const ask=()=>emit({id:1000+next,method:'session/request_permission',params:{sessionId:'s',toolCall:asks[next],options:[{optionId:'once',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);
if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')emit({id:m.id,result:{sessionId:'s',models:{currentModelId:'m'}}});
if(m.method==='session/prompt'){prompt=m.id;ask();}
if(m.id>=1000&&!m.method){fs.appendFileSync(${JSON.stringify(outcomes)},JSON.stringify({id:asks[m.id-1000].toolCallId,outcome:m.result?.outcome?.outcome})+'\\n');next++;if(next<asks.length)ask();else{emit({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}}}});emit({id:prompt,result:{stopReason:'end_turn'}});}}}
`, { mode: 0o700 });
  const broker = new Broker({ workspace: copy, bins: { gemini: cli }, dataDir: path.join(root, 'data', 'journal') });
  broker.guarded = guarded;
  try {
    // What the agent is told about where it works.
    const scope = broker.taskScope();
    assert.ok(scope.includes(`its own copy of app, at ${copy}`) && scope.includes(`Paths in the request under ${real} mean the same files in this copy`), scope);
    assert.ok(scope.includes(`other folder, my site (${site}), copy files out of it into this task's folder or a scratch folder, and run its builds, tests, type checks, linters and dev servers there, but Codeshi refuses changes there`), scope);
    const c = broker.get(broker.create().id);
    broker.settings(c, { provider: 'gemini', model: 'm', mode: 'edit', approvalPolicy: 'auto' });
    broker.start(c, { text: 'Build the site', requestId: 'guard-run' });
    await broker.running.done;
    // The site's build runs in the site, a folder with no copy; the app's belongs in the task's copy of it.
    assert.deepEqual(fs.readFileSync(outcomes, 'utf8').trim().split('\n').map(JSON.parse), [{ id: 'edit-real', outcome: 'cancelled' }, { id: 'build-real', outcome: 'cancelled' }, { id: 'build-site', outcome: 'selected' }, { id: 'build-copy', outcome: 'selected' }]);
    const blocked = c.messages.filter(message => message.role === 'activity' && /^Blocked: /.test(message.text)).map(message => message.text);
    assert.equal(blocked.length, 2);
    assert.match(blocked[0], /my site, another folder of this workspace\. A task changes only its own folder\./);
    assert.match(blocked[1], /the real app folder, not this task’s copy\. A task changes only its own copy\./);
  } finally { await broker.close(); }
});

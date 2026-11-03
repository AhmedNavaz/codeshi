import test from 'node:test';
import { noSymlinks } from './platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { workspaceGit, workspaceGitDiff, githubRepository, IMAGE_PREVIEW_BYTES } from '../src/workspace-git.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';

// Antigravity keeps its conversation index in SQLite, which is read with the sqlite3 program. Windows does not include
// it, and reading the index there has not been checked yet.
const noSqlite = process.platform === 'win32' ? 'Reading Antigravity’s conversation index has not been checked on Windows yet' : spawnSync('sqlite3', ['-version']).status !== 0 && 'Needs the sqlite3 program';
import { ConversationImporter } from '../src/conversation-import.mjs';
import { exportConversation, readConversationPackage } from '../src/conversation-export.mjs';
import { Broker, commandFor } from '../src/broker.mjs';
import { prepareContext } from '../src/context.mjs';
import { runCodex, runClaude, codexUsageWindows, claudeUsageWindows } from '../src/providers.mjs';
import { createRelayServer } from '../src/server.mjs';

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-insights-')); const workspace = path.join(root, 'project'); fs.mkdirSync(workspace); const closers = []; t.after(async () => { for (const close of closers) await close(); fs.rmSync(root, { recursive: true, force: true }); }); return { root, workspace, closers, folders: [{ id: 'root', name: 'app', path: workspace }] }; }
function git(cwd, ...args) { const result = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; }

test('Git activity reads real commits, branch, staged/untracked changes and safe GitHub URLs', t => {
  const f = fixture(t); git(f.workspace, 'init', '-q'); git(f.workspace, 'config', 'user.name', 'Fixture'); git(f.workspace, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(f.workspace, 'app.js'), 'const value = 1;\n'); git(f.workspace, 'add', '.'); git(f.workspace, 'commit', '-qm', 'Initial application');
  git(f.workspace, 'remote', 'add', 'origin', 'git@github.com:example/fixture.git'); fs.appendFileSync(path.join(f.workspace, 'app.js'), '// staged\n'); git(f.workspace, 'add', '.'); fs.writeFileSync(path.join(f.workspace, 'new.js'), 'new file');
  const [repo] = workspaceGit(f.folders).repositories; assert.equal(repo.available, true); assert.equal(repo.commits[0].subject, 'Initial application'); assert.equal(repo.commits[0].author, 'Fixture'); assert.match(repo.commits[0].url, /^https:\/\/github.com\/example\/fixture\/commit\/[a-f0-9]+$/); assert.equal(repo.totalChanges, 2); assert(repo.changes.some(file => file.path === 'app.js' && file.staged)); assert(repo.changes.some(file => file.path === 'new.js' && file.code === '??'));
  assert.equal(githubRepository('https://secret@github.com/example/repo.git'), null); assert.equal(githubRepository('https://github.com.evil.test/example/repo'), null);
});

test('Git gracefully handles empty repositories and unavailable folders', t => { const f = fixture(t); git(f.workspace, 'init', '-q'); assert.deepEqual(workspaceGit(f.folders).repositories[0].commits, []); assert.equal(workspaceGit([{ id: 'gone', path: path.join(f.root, 'gone') }]).repositories[0].available, false); });

test('Git status cannot run configured clean filters', t => {
  const f = fixture(t), marker = path.join(f.root, 'filter-ran'); git(f.workspace, 'init', '-q'); git(f.workspace, 'config', 'user.name', 'Fixture'); git(f.workspace, 'config', 'user.email', 'fixture@example.invalid'); fs.writeFileSync(path.join(f.workspace, 'app.js'), 'const value = 1;\n'); git(f.workspace, 'add', '.'); git(f.workspace, 'commit', '-qm', 'Initial');
  git(f.workspace, 'config', 'filter.fixture.clean', `touch '${marker}'; cat`); fs.writeFileSync(path.join(f.workspace, '.gitattributes'), '*.js filter=fixture\n'); fs.appendFileSync(path.join(f.workspace, 'app.js'), '// dirty\n'); assert.equal(workspaceGit(f.folders).repositories[0].available, true); assert.equal(fs.existsSync(marker), false);
});

test('first-run discovery lists conversations from every project, excluding Throughline runs, with folders and original times', async t => {
  const f = fixture(t), calls = [];
  const importer = new ConversationImporter({
    codexBin: () => '/fixture/codex',
    sdkLoader: async () => ({
      listSessions: async options => { calls.push(['claude', options]); return [{ sessionId: 'claude-one', summary: 'Claude task', lastModified: Date.parse('2026-10-20T10:00:00Z'), cwd: f.workspace }]; },
      getSessionInfo: async (_id, options) => { calls.push(['info', options]); return { cwd: f.workspace, summary: 'Claude task' }; },
      getSessionMessages: async (_id, options) => { calls.push(['messages', options]); return [{ uuid: 'cmd', type: 'user', timestamp: '2026-10-20T08:59:00Z', message: { content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>' } }, { uuid: 'out', type: 'user', timestamp: '2026-10-20T08:59:01Z', message: { content: '<local-command-stdout>Set effort level to high</local-command-stdout>' } }, { uuid: 'u', type: 'user', timestamp: '2026-10-20T09:00:00Z', message: { content: 'Plan the API' } }, { uuid: 'a', type: 'assistant', timestamp: '2026-10-20T09:01:00Z', message: { content: [{ type: 'text', text: 'API planned' }] } }]; },
    }),
    clientFactory: () => ({ initialize: async () => {}, close() {}, request: async (method, params) => { calls.push([method, params]); if (method === 'thread/list') return { data: [{ id: 'codex-one', preview: 'Build the UI', updatedAt: 1792000000, cwd: '/elsewhere/ui' }, { id: 'codex-command', preview: '<command-name>/effort</command-name>', updatedAt: 1791000000, cwd: '/elsewhere/ui' }, { id: 'relay-run', preview: 'You are working in Throughline {"currentRequest":"x"}', updatedAt: 1792000001, cwd: '/elsewhere/ui' }] }; if (method === 'thread/read') return { thread: { cwd: '/elsewhere/ui', name: 'UI' } }; return { data: [{ id: 'turn', startedAt: 1792000100, completedAt: 1792000160, items: [{ type: 'userMessage', id: 'q', content: [{ type: 'text', text: 'Build the UI' }] }, { type: 'agentMessage', id: 'r', text: 'UI built' }] }] }; } }),
  });
  const claude = await importer.list('claude', null); assert.deepEqual(claude.sessions.map(row => [row.id, row.cwd, row.folder]), [['claude-one', f.workspace, 'project']]); assert.equal(calls[0][1].includeProgrammatic, false, 'Throughline\'s own SDK sessions are not offered for import.'); assert.equal(calls[0][1].dir, undefined);
  const codex = await importer.list('codex', null); assert.deepEqual(codex.sessions.map(row => [row.id, row.title]), [['codex-one', 'Build the UI'], ['codex-command', 'Codex conversation']], 'Slash-command markup never becomes a title.'); assert.equal(calls.find(row => row[0] === 'thread/list')[1].cwd, undefined);
  const preview = await importer.preview('codex', 'codex-one', null); assert.equal(preview.cwd, '/elsewhere/ui'); assert.deepEqual(preview.messages.map(row => row.timestamp), [new Date(1792000100000).toISOString(), new Date(1792000160000).toISOString()]);
  const claudePreview = await importer.preview('claude', 'claude-one', null); assert.equal(claudePreview.cwd, f.workspace); assert.deepEqual(claudePreview.messages.map(row => row.text), ['Plan the API', 'API planned'], 'Slash commands and their local output are not imported.'); assert.equal(claudePreview.messages[0].timestamp, '2026-10-20T09:00:00.000Z'); assert.equal(calls.find(row => row[0] === 'messages')[1].dir, undefined);
  assert(!calls.some(([method]) => /resume|turn\/start/.test(method)), 'Discovery and preview never resume or run a session.');
});

test('workspace discovery matches attached folder paths and excludes Throughline sessions',async t=>{
  const f=fixture(t),other=path.join(f.root,'other','project'),calls=[];fs.mkdirSync(other,{recursive:true});
  const importer=new ConversationImporter({
    sdkLoader:async()=>({listSessions:async options=>{calls.push(options);return [{sessionId:'claude-match',summary:'Matching chat',cwd:f.workspace,lastModified:1},{sessionId:'claude-other',summary:'Same folder name elsewhere',cwd:other,lastModified:1}];}}),
    codexBin:()=>'/mock/codex',
    clientFactory:()=>({initialize:async()=>{},close(){},request:async()=>({data:[
      {id:'codex-match',preview:'Matching chat',cwd:f.workspace,updatedAt:1},
      {id:'codex-other',preview:'Same folder name elsewhere',cwd:other,updatedAt:1},
      {id:'throughline-run',preview:'You are working in Throughline {"currentRequest":"test"}',cwd:f.workspace,updatedAt:1},
    ]})}),
  });
  assert.deepEqual((await importer.list('claude',f.folders)).sessions.map(session=>session.id),['claude-match']);
  assert.equal(calls[0].includeProgrammatic,false);
  assert.deepEqual((await importer.list('codex',f.folders)).sessions.map(session=>session.id),['codex-match']);
});

test('gemini discovery reads Antigravity summaries and parses transcripts into review previews', { skip: noSqlite }, async t => {
  const f = fixture(t);
  const geminiDir = path.join(f.root, '.gemini', 'antigravity');
  const brainDir = path.join(geminiDir, 'brain', 'gemini-chat-1');
  const logsDir = path.join(brainDir, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const dbPath = path.join(geminiDir, 'conversation_summaries.db');
  const fileUri = 'file://' + f.workspace;
  spawnSync('sqlite3', [
    dbPath,
    `CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, last_modified_time TEXT, workspace_uris TEXT);
     INSERT INTO conversation_summaries VALUES ('gemini-chat-1', 'Implement OAuth flow', 'Implement OAuth flow preview', '2026-10-20T10:00:00.000Z', '${JSON.stringify([fileUri])}');`
  ]);

  const transcript = [
    JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-10-20T10:00:00.000Z', content: '<USER_REQUEST>Implement OAuth flow</USER_REQUEST>' }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-20T10:00:05.000Z', content: 'OAuth flow implemented with PKCE.' }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), transcript, 'utf8');

  const importer = new ConversationImporter({
    geminiHome: () => f.root,
  });

  const workspaceSessions = await importer.list('gemini', f.folders);
  assert.equal(workspaceSessions.sessions.length, 1);
  assert.equal(workspaceSessions.sessions[0].id, 'gemini-chat-1');
  assert.equal(workspaceSessions.sessions[0].title, 'Implement OAuth flow');
  assert.equal(workspaceSessions.sessions[0].provider, 'gemini');

  const allSessions = await importer.discover('gemini');
  assert.equal(allSessions.sessions.length, 1);
  assert.equal(allSessions.sessions[0].id, 'gemini-chat-1');

  const preview = await importer.preview('gemini', 'gemini-chat-1', f.folders);
  assert.equal(preview.provider, 'gemini');
  assert.equal(preview.sessionId, 'gemini-chat-1');
  assert.equal(preview.title, 'Implement OAuth flow');
  assert.equal(preview.messageCount, 2);
  assert.deepEqual(preview.messages, [
    { sourceId: 'step-1-user', role: 'user', text: 'Implement OAuth flow', timestamp: '2026-10-20T10:00:00.000Z' },
    { sourceId: 'step-2-model', role: 'assistant', text: 'OAuth flow implemented with PKCE.', provider: 'gemini', timestamp: '2026-10-20T10:00:05.000Z' },
  ]);
  assert.ok(preview.digest);
});

test('Gemini previews bound large transcripts and require known workspace membership',async t=>{
  const f=fixture(t),logs=path.join(f.root,'.gemini/antigravity/brain/unlinked/.system_generated/logs');fs.mkdirSync(logs,{recursive:true});
  const first=JSON.stringify({type:'USER_INPUT',source:'USER_EXPLICIT',step_index:1,content:'<USER_REQUEST>Keep this visible request</USER_REQUEST>'});
  const large=JSON.stringify({type:'PLANNER_RESPONSE',step_index:2,content:'x'.repeat(3*1024*1024)});fs.writeFileSync(path.join(logs,'transcript.jsonl'),first+'\n'+large+'\n');
  const importer=new ConversationImporter({geminiHome:()=>f.root});
  await assert.rejects(importer.preview('gemini','unlinked',f.folders),error=>error.status===403);
  const preview=await importer.preview('gemini','unlinked');assert.equal(preview.clipped,true);assert.equal(preview.messages.length,1);assert.equal(preview.messages[0].text,'Keep this visible request');
});

test('Gemini transcript symlinks cannot read outside the native conversation store',{skip:noSymlinks},async t=>{
  const f=fixture(t),logs=path.join(f.root,'.gemini/antigravity/brain/linked/.system_generated/logs');fs.mkdirSync(logs,{recursive:true});const outside=path.join(f.root,'outside.jsonl');fs.writeFileSync(outside,JSON.stringify({type:'USER_INPUT',source:'USER_EXPLICIT',content:'private'}));fs.symlinkSync(outside,path.join(logs,'transcript.jsonl'));
  const importer=new ConversationImporter({geminiHome:()=>f.root});await assert.rejects(importer.preview('gemini','linked'),error=>error.status===403);assert.equal(fs.readFileSync(outside,'utf8').includes('private'),true);
});

test('Gemini conversations linked through a secondary folder remain previewable',{skip:noSqlite},async t=>{
  const f=fixture(t),native=path.join(f.root,'.gemini/antigravity'),logs=path.join(native,'brain/multiple/.system_generated/logs');fs.mkdirSync(logs,{recursive:true});fs.writeFileSync(path.join(logs,'transcript.jsonl'),JSON.stringify({type:'USER_INPUT',source:'USER_EXPLICIT',content:'<USER_REQUEST>Secondary workspace</USER_REQUEST>'})+'\n');
  const uris=JSON.stringify(['file://'+path.join(f.root,'another-project'),'file://'+f.workspace]);const db=path.join(native,'conversation_summaries.db');const result=spawnSync('sqlite3',[db,`CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,preview TEXT,last_modified_time TEXT,workspace_uris TEXT); INSERT INTO conversation_summaries VALUES('multiple','Multiple folders','','2026-11-01T00:00:00Z','${uris}');`]);assert.equal(result.status,0);
  const before=fs.statSync(db).mtimeMs,importer=new ConversationImporter({geminiHome:()=>f.root}),listed=await importer.list('gemini',f.folders);assert.equal(listed.sessions[0].cwd,f.workspace);assert.equal((await importer.preview('gemini','multiple',f.folders)).messages[0].text,'Secondary workspace');assert.equal(fs.statSync(db).mtimeMs,before);
});

test('a previous chat from a subfolder typed in another letter case stays inside the workspace folder',async t=>{
  const f=fixture(t),workspace=fs.realpathSync(f.workspace);fs.mkdirSync(path.join(workspace,'Backend'));
  const typed=path.join(path.dirname(workspace),path.basename(workspace).toUpperCase(),'backend');
  if(!fs.existsSync(typed))return t.skip('This file system distinguishes letter case.');
  const importer={preview:async(provider,sessionId)=>({provider,sessionId,title:'Backend chat',cwd:typed,digest:'reviewed',messages:[{sourceId:sessionId,role:'user',text:'Backend history',timestamp:'2026-10-20T09:00:00Z'}]})};
  const app=createRelayServer({workspace,dataRoot:path.join(f.root,'app'),importer,bins:{codex:'/missing',claude:'/missing'}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');f.closers.push(()=>app.close());
  const project=app.registry.list()[0];
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/import-sources/import',{method:'POST',headers:{'X-AI-Relay':'1','Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,sessions:[{provider:'claude',sessionId:'claude-backend',approvedDigest:'reviewed'}]})});
  assert.equal(response.status,200);
  assert.deepEqual(app.registry.get(project.id).folders.map(folder=>folder.path),[workspace],'The chat comes from a subfolder of the workspace folder, so no folder is added.');
});

test('a previous chat from a subfolder stays inside a workspace folder saved in another letter case',async t=>{
  const f=fixture(t),workspace=fs.realpathSync(f.workspace);fs.mkdirSync(path.join(workspace,'Backend'));
  const saved=path.join(path.dirname(workspace),path.basename(workspace).toUpperCase());
  if(!fs.existsSync(saved))return t.skip('This file system distinguishes letter case.');
  // Earlier versions saved a folder as it was typed, with IDs derived from that path.
  const id=createHash('sha256').update(saved).digest('hex').slice(0,16),dataRoot=path.join(f.root,'app');
  fs.mkdirSync(dataRoot,{recursive:true});
  fs.writeFileSync(path.join(dataRoot,'projects.json'),JSON.stringify({version:2,projects:[{id,name:'saved',path:saved,folders:[{id,name:'saved',displayName:'saved',path:saved}],folderAliases:{[id]:'saved'},conversationId:null,createdAt:'2026-10-01T09:00:00.000Z'}]}));
  const importer={preview:async(provider,sessionId)=>({provider,sessionId,title:'Backend chat',cwd:path.join(workspace,'Backend'),digest:'reviewed',messages:[{sourceId:sessionId,role:'user',text:'Backend history',timestamp:'2026-10-20T09:00:00Z'}]})};
  const app=createRelayServer({dataRoot,importer,bins:{codex:'/missing',claude:'/missing'}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');f.closers.push(()=>app.close());
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/import-sources/import',{method:'POST',headers:{'X-AI-Relay':'1','Content-Type':'application/json'},body:JSON.stringify({projectId:id,sessions:[{provider:'claude',sessionId:'claude-backend',approvedDigest:'reviewed'}]})});
  assert.equal(response.status,200);
  assert.deepEqual(app.registry.get(id).folders.map(folder=>folder.path),[saved],'The chat comes from a subfolder of the saved folder, so no folder is added.');
});

test('workspace history marks previously merged sources and remembers the completed review',async t=>{
  const f=fixture(t),workspace=fs.realpathSync(f.workspace);
  const importer={
    list:async(provider,folders)=>{assert.equal(folders[0].path,workspace);return {sessions:[{id:provider+'-old',provider,title:'Previous chat',cwd:workspace},{id:provider+'-new',provider,title:'Another chat',cwd:workspace}],nextCursor:null};},
    preview:async(provider,sessionId)=>({provider,sessionId,title:'Previous chat',cwd:workspace,digest:'reviewed',messages:[{sourceId:sessionId,role:'user',text:provider+' history',timestamp:provider==='claude'?'2026-10-20T09:00:00Z':'2026-10-20T09:01:00Z'}]}),
  };
  const app=createRelayServer({workspace,dataRoot:path.join(f.root,'app'),importer,bins:{codex:'/missing',claude:'/missing'}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');f.closers.push(()=>app.close());
  const project=app.registry.list()[0],address='http://127.0.0.1:'+app.server.address().port;
  app.registry.broker(project.id).start=()=>assert.fail('Discovery and merging never run a provider.');
  const read=async provider=>(await fetch(address+'/api/import-sources?scope=workspace&provider='+provider+'&projectId='+project.id)).json();
  assert.deepEqual((await read('claude')).sessions.map(session=>session.imported),[false,false]);
  const response=await fetch(address+'/api/import-sources/import',{method:'POST',headers:{'X-AI-Relay':'1','Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,sessions:['claude','codex'].map(provider=>({provider,sessionId:provider+'-old',approvedDigest:'reviewed'}))})});
  assert.equal(response.status,200);assert.equal((await response.json()).imported,2);
  for(const provider of ['claude','codex'])assert.deepEqual((await read(provider)).sessions.map(session=>session.imported),[true,false]);
  assert.equal(app.registry.get(project.id).previousConversationsDismissed,true);
  assert.deepEqual(app.registry.mainConversation(project.id).messages.map(message=>message.text),['claude history','codex history']);
});

test('separate Claude and Codex chats merge into one conversation in original time order', async t => {
  const f = fixture(t), options = { workspace: f.workspace, dataDir: path.join(f.root, 'journal') }; let broker = new Broker(options); const c = broker.get(broker.create().id); broker.start = () => assert.fail('Import must not invoke a model');
  const claude = { provider: 'claude', sessionId: 'c1', digest: 'c', messages: [{ sourceId: 'c-q', role: 'user', text: 'Design the schema', timestamp: '2026-10-20T09:00:00Z' }, { sourceId: 'c-a', role: 'assistant', text: 'Schema designed', timestamp: '2026-10-20T09:05:00Z' }] };
  const codex = { provider: 'codex', sessionId: 'x1', digest: 'x', messages: [{ sourceId: 'x-q', role: 'user', text: 'Implement the schema', timestamp: '2026-10-20T09:02:00Z' }, { sourceId: 'x-a', role: 'assistant', text: 'Implemented', timestamp: '2026-10-20T09:10:00Z' }] };
  const result = broker.importTranscripts(c, [claude, codex]); assert.equal(result.imported, 4);
  assert.deepEqual(c.messages.map(row => [row.provider, row.text]), [['claude', 'Design the schema'], ['codex', 'Implement the schema'], ['claude', 'Schema designed'], ['codex', 'Implemented']]);
  assert.equal(c.messages[0].createdAt, '2026-10-20T09:00:00.000Z', 'Imported messages keep their original time.'); assert(!c.messages.some(row => 'timestamp' in row));
  await broker.close(); broker = new Broker(options); const restored = broker.get(c.id); assert.equal(broker.importTranscript(restored, codex).duplicate, true, 'Both merged sources are remembered after reload.'); assert.equal(restored.messages.length, 4); await broker.close();
});

// Saves messages with fixed times, as a conversation from an earlier day: a run's prompt and replies share its runId.
function seedMessages(broker, c, rows) { for (const [id, role, text, createdAt, runId] of rows) broker.record(c, { type: 'message', message: { id, role, text, provider: 'codex', createdAt, ...(runId ? { runId } : {}) } }); }
const textsOf = c => c.messages.map(message => message.text);
const today = [['p1', 'user', 'Today: add the promo field', '2026-11-02T10:00:00.000Z', 'r1'], ['a1', 'assistant', 'Today: done', '2026-11-02T10:05:00.000Z', 'r1']];
const october = { provider: 'codex', sessionId: 'cart', digest: 'cart', messages: [{ sourceId: 'q', role: 'user', text: '20 Oct: set up the cart', timestamp: '2026-10-20T09:00:00Z' }, { sourceId: 'a', role: 'assistant', text: '20 Oct: cart ready', timestamp: '2026-10-20T09:05:00Z' }] };

test('imported older messages go before newer ones and keep that place after a reload', async t => {
  const f = fixture(t), options = { workspace: f.workspace, dataDir: path.join(f.root, 'journal') }; let broker = new Broker(options); const c = broker.get(broker.create().id); seedMessages(broker, c, today);
  const later = { provider: 'claude', sessionId: 'later', digest: 'later', messages: [{ sourceId: 'l', role: 'user', text: '3 Nov: ship it', timestamp: '2026-11-03T08:00:00Z' }] };
  broker.importTranscripts(c, [october, later]);
  const expected = ['20 Oct: set up the cart', '20 Oct: cart ready', 'Today: add the promo field', 'Today: done', '3 Nov: ship it'];
  assert.deepEqual(textsOf(c), expected);
  await broker.close(); broker = new Broker(options); assert.deepEqual(textsOf(broker.get(c.id)), expected, 'The journal keeps each imported message in its place.'); await broker.close();
});

test('an imported message goes between runs, never inside one', async t => {
  const f = fixture(t), broker = new Broker({ workspace: f.workspace, dataDir: path.join(f.root, 'journal') }), c = broker.get(broker.create().id);
  seedMessages(broker, c, [['p1', 'user', 'Run one', '2026-11-02T10:00:00.000Z', 'r1'], ['s1', 'activity', 'Run one step', '2026-11-02T10:01:00.000Z', 'r1'], ['a1', 'assistant', 'Run one reply', '2026-11-02T10:05:00.000Z', 'r1'], ['p2', 'user', 'Run two', '2026-11-02T11:00:00.000Z', 'r2'], ['a2', 'assistant', 'Run two reply', '2026-11-02T11:05:00.000Z', 'r2'], ['n1', 'assistant', 'Note at noon', '2026-11-02T12:00:00.000Z']]);
  broker.importTranscript(c, { provider: 'claude', sessionId: 'side', digest: 'side', messages: [{ sourceId: 'during', role: 'assistant', text: 'Imported 10:02', timestamp: '2026-11-02T10:02:00Z' }, { sourceId: 'tie', role: 'user', text: 'Imported 11:00', timestamp: '2026-11-02T11:00:00Z' }, { sourceId: 'noon', role: 'user', text: 'Imported 12:00', timestamp: '2026-11-02T12:00:00Z' }] });
  // A run counts from its prompt, and on equal times the message already there comes first.
  assert.deepEqual(textsOf(c), ['Run one', 'Run one step', 'Run one reply', 'Imported 10:02', 'Run two', 'Run two reply', 'Imported 11:00', 'Note at noon', 'Imported 12:00']);
  await broker.close();
});

test('an untimed imported message stays next to its own chat, and a chat with no times goes at the end', async t => {
  const f = fixture(t), broker = new Broker({ workspace: f.workspace, dataDir: path.join(f.root, 'journal') }), c = broker.get(broker.create().id); seedMessages(broker, c, today);
  const partly = { provider: 'codex', sessionId: 'partly', digest: 'partly', messages: [{ sourceId: 'first', role: 'user', text: 'Partly: untimed start' }, { sourceId: 'timed', role: 'assistant', text: 'Partly: 20 Oct', timestamp: '2026-10-20T09:00:00Z' }, { sourceId: 'last', role: 'user', text: 'Partly: untimed end' }] };
  const never = { provider: 'claude', sessionId: 'never', digest: 'never', messages: [{ sourceId: 'one', role: 'user', text: 'No times: one' }, { sourceId: 'two', role: 'assistant', text: 'No times: two' }] };
  broker.importTranscripts(c, [partly, never]);
  assert.deepEqual(textsOf(c), ['Partly: untimed start', 'Partly: 20 Oct', 'Partly: untimed end', 'Today: add the promo field', 'Today: done', 'No times: one', 'No times: two']);
  await broker.close();
});

test('messages imported by an earlier version keep their saved order', async t => {
  const f = fixture(t), dataDir = path.join(f.root, 'journal'), id = '6f0c2a52-5d1e-4c8e-9b7a-3d2f1e0a9b8c'; fs.mkdirSync(dataDir, { recursive: true });
  // Records as 0.20.0 writes them: its import record has no placement, so the imported messages were added at the end.
  const records = [{ type: 'created', title: 'Cart', seq: 1, at: '2026-11-02T09:59:00.000Z' }, ...today.map(([mid, role, text, createdAt, runId], index) => ({ type: 'message', message: { id: mid, role, text, provider: 'codex', createdAt, runId }, seq: index + 2, at: createdAt })),
    { type: 'import', importId: 'codex:cart:cart', importIds: ['codex:cart:cart'], messages: [{ sourceId: 'q', role: 'user', text: '20 Oct: set up the cart', provider: 'codex', id: 'old-q', createdAt: '2026-10-20T09:00:00.000Z', importSource: 'codex:cart:q' }, { sourceId: 'a', role: 'assistant', text: '20 Oct: cart ready', provider: 'codex', id: 'old-a', createdAt: '2026-10-20T09:05:00.000Z', importSource: 'codex:cart:a' }], seq: 4, at: '2026-11-02T10:10:00.000Z' }];
  fs.writeFileSync(path.join(dataDir, `${id}.jsonl`), records.map(record => JSON.stringify(record) + '\n').join(''));
  const broker = new Broker({ workspace: f.workspace, dataDir }), c = broker.get(id);
  assert.deepEqual(textsOf(c), ['Today: add the promo field', 'Today: done', '20 Oct: set up the cart', '20 Oct: cart ready']);
  // A new import goes before the first newer message and leaves the saved ones where they are.
  broker.importTranscript(c, { provider: 'claude', sessionId: 'mid', digest: 'mid', messages: [{ sourceId: 'm', role: 'user', text: '25 Oct: pick a theme', timestamp: '2026-10-25T09:00:00Z' }] });
  assert.deepEqual(textsOf(c), ['25 Oct: pick a theme', 'Today: add the promo field', 'Today: done', '20 Oct: set up the cart', '20 Oct: cart ready']);
  await broker.close();
});

test('with a tight context budget the newest request survives an import of older messages', async t => {
  const f = fixture(t), broker = new Broker({ workspace: f.workspace, dataDir: path.join(f.root, 'journal') }), c = broker.get(broker.create().id), long = 'Checked the field and its tests. '.repeat(60);
  seedMessages(broker, c, [today[0], ['a1', 'assistant', `Today: done. ${long}`, '2026-11-02T10:05:00.000Z', 'r1']]);
  broker.importTranscript(c, { ...october, messages: [october.messages[0], { ...october.messages[1], text: `20 Oct: cart ready. ${long}` }] });
  // Both requests are kept; room is left for about one reply, which is taken from the end.
  const prompt = prepareContext(c, 'Next request', { workspace: f.workspace, maxBytes: 3000 }).prompt, context = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).context.map(item => item.text);
  assert.deepEqual(context.map(text => text.split('.')[0]), ['20 Oct: set up the cart', 'Today: add the promo field', 'Today: done']);
  await broker.close();
});

test('imported messages placed earlier still reach a resumed native session', async t => {
  const f = fixture(t), broker = new Broker({ workspace: f.workspace, dataDir: path.join(f.root, 'journal') }), c = broker.get(broker.create().id); seedMessages(broker, c, today);
  broker.record(c, { type: 'session', provider: 'codex', id: 'native', workspaceSignature: broker.workspaceSignature }); broker.record(c, { type: 'checkpoint', provider: 'codex' });
  broker.importTranscript(c, october); assert.equal(c.messages[0].text, '20 Oct: set up the cart');
  // The session already saw today's messages, so only the imported ones are new to it, wherever they sit.
  const prompt = prepareContext(c, 'Next request', { workspace: f.workspace, provider: 'codex' }).prompt; assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).context.map(item => item.text), ['20 Oct: set up the cart', '20 Oct: cart ready']);
  await broker.close();
});

test('HTTP import from any project creates or extends a workspace, merges chats, and starts no inference', async t => {
  const f = fixture(t), other = path.join(f.root, 'backend'); fs.mkdirSync(other); let version = 'one';
  const sources = { claude: { cwd: other, title: 'Backend plan', at: '2026-10-20T09:00:00Z' }, codex: { cwd: other, title: 'Backend build', at: '2026-10-20T09:30:00Z' }, gone: { cwd: path.join(f.root, 'deleted'), title: 'Old', at: '2026-10-19T09:00:00Z' } };
  const importer = { list: async (provider, folders) => ({ sessions: folders ? [] : [{ id: provider, provider, title: sources[provider].title, cwd: other }], nextCursor: null }), preview: async (provider, sessionId, folders) => { assert.equal(folders, null); const source = sources[sessionId]; return { provider, sessionId, title: source.title, cwd: source.cwd, digest: sessionId === 'claude' ? version : 'fixed', messages: [{ sourceId: sessionId, role: 'user', text: source.title, timestamp: source.at }] }; } };
  const app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'app'), importer, bins: { codex: '/missing', claude: '/missing' } }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); f.closers.push(() => app.close());
  const request = async (route, value) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method: value ? 'POST' : 'GET', headers: { 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await request('/api/import-sources?provider=claude')).body.sessions[0].cwd, other);
  const sessions = [{ provider: 'claude', sessionId: 'claude', approvedDigest: 'one' }, { provider: 'codex', sessionId: 'codex', approvedDigest: 'fixed' }];
  version = 'two'; assert.equal((await request('/api/import-sources/import', { sessions })).status, 409, 'A source that changed after review is not imported.'); version = 'one';
  const created = await request('/api/import-sources/import', { sessions, name: 'Backend' }); assert.equal(created.status, 200); assert.equal(created.body.imported, 2); assert.equal(created.body.projectName, 'Backend');
  const project = app.registry.get(created.body.projectId); assert.deepEqual(project.folders.map(folder => folder.path), [fs.realpathSync(other)]);
  for (const id of app.registry.list().map(entry => entry.id)) app.registry.broker(id).start = () => assert.fail('Import must not run inference');
  assert.deepEqual(app.registry.mainConversation(project.id).messages.map(row => [row.provider, row.text]), [['claude', 'Backend plan'], ['codex', 'Backend build']]);
  const original = app.registry.list().find(entry => entry.id !== project.id);
  const extended = await request('/api/import-sources/import', { sessions: [sessions[1], { provider: 'claude', sessionId: 'gone', approvedDigest: 'fixed' }], projectId: original.id }); assert.equal(extended.status, 200);
  assert.deepEqual(app.registry.get(original.id).folders.map(folder => folder.path).sort(), [fs.realpathSync(f.workspace), fs.realpathSync(other)].sort(), 'The conversation folder is attached to the chosen workspace.'); assert.deepEqual(extended.body.missingFolders, [path.join(f.root, 'deleted')]);
  assert.equal((await request('/api/import-sources/import', { sessions: [{ provider: 'claude', sessionId: 'gone', approvedDigest: 'fixed' }] })).status, 422, 'A new workspace needs at least one existing folder.');
  assert.equal((await request('/api/import-sources/import', { sessions: [sessions[0], sessions[0]] })).status, 400);
});

test('conversation export keeps chat text, redacts secrets and local paths, and rejects altered files', () => {
  const project = { name: 'Shop', folders: [{ id: 'web', name: 'web', displayName: 'web', path: '/Users/dev/shop/web' }] };
  const conversation = { context: { goal: 'Ship checkout', decisions: ['Use Stripe'], tasks: [] }, messages: [
    { id: 'u1', role: 'user', text: 'Fix /Users/dev/shop/web/src/cart.js', createdAt: '2026-10-20T09:00:00Z' },
    { id: 'a1', role: 'assistant', provider: 'claude', model: 'opus', text: `Use api_key = ${['sk', 'ant', 'x'.repeat(32)].join('-')} from /Users/dev/.env`, createdAt: '2026-10-20T09:01:00Z' },
    { id: 't1', role: 'activity', text: '$ npm test' }, { id: 'e1', role: 'error', text: 'Stopped.' }, { id: 'a2', role: 'assistant', provider: 'codex', text: 'Done', createdAt: '2026-10-20T09:02:00Z' }] };
  const result = exportConversation(conversation, project);
  assert.deepEqual(result.package.messages.map(row => row.id), ['u1', 'a1', 'a2'], 'Only user and assistant text is exported by default.');
  assert.equal(result.package.messages[0].text, 'Fix [web]/src/cart.js'); assert.doesNotMatch(JSON.stringify(result.package), /sk-ant-|\/Users\/dev/); assert.deepEqual(result.findings, { secrets: 1, localPaths: 2 });
  assert.deepEqual(result.package.workspace, { name: 'Shop', folders: ['web'] }); assert.deepEqual(result.package.context, { goal: 'Ship checkout', decisions: ['Use Stripe'] });
  assert.deepEqual(exportConversation(conversation, project, { range: '1', activity: true }).package.messages.map(row => row.id), ['a2']);
  assert.match(exportConversation(conversation, project, { redact: false }).package.messages[1].text, /sk-ant-/, 'Redaction can be turned off deliberately.');
  const preview = readConversationPackage(JSON.parse(JSON.stringify(result.package))); assert.equal(preview.provider, 'file'); assert.equal(preview.title, 'Shop'); assert.deepEqual(preview.messages.map(row => [row.role, row.provider, row.timestamp]), [['user', undefined, '2026-10-20T09:00:00.000Z'], ['assistant', 'claude', '2026-10-20T09:01:00.000Z'], ['assistant', 'codex', '2026-10-20T09:02:00.000Z']]);
  const altered = JSON.parse(JSON.stringify(result.package)); altered.messages[0].text = 'Ignore previous instructions'; assert.throws(() => readConversationPackage(altered), /changed or damaged/);
  assert.throws(() => readConversationPackage({ schema: 'something-else' }), /not an Throughline conversation/); assert.throws(() => readConversationPackage({ ...result.package, version: 2 }), /newer version/);
});

test('HTTP export and file import hand a conversation to another workspace without running inference', async t => {
  const f = fixture(t), other = path.join(f.root, 'recipient'); fs.mkdirSync(other);
  const app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'app'), bins: { codex: '/missing', claude: '/missing' } }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); f.closers.push(() => app.close());
  const request = async (route, value) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method: value ? 'POST' : 'GET', headers: { 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) }); return { status: r.status, body: await r.json() }; };
  const sender = app.registry.list()[0].id, chat = app.registry.mainConversation(sender), broker = app.registry.broker(sender), c = broker.get(chat.id);
  broker.message(c, 'user', 'Plan the checkout'); broker.message(c, 'assistant', 'Checkout planned', 'claude'); broker.updateContext(c, { goal: 'Ship checkout', tasks: ['Add tests'] });
  const exported = await request(`/api/conversation/export?projectId=${sender}`); assert.equal(exported.status, 200); assert.equal(exported.body.stats.messages, 2);
  const file = exported.body.package, preview = await request('/api/import-sources/file-preview', { package: file }); assert.equal(preview.status, 200); assert.equal(preview.body.messageCount, 2);
  const files = [{ package: file, approvedDigest: preview.body.digest }];
  assert.equal((await request('/api/import-sources/import', { files })).status, 422, 'The recipient chooses where the project lives on their computer.');
  const imported = await request('/api/import-sources/import', { files, folders: [other], name: 'Checkout' }); assert.equal(imported.status, 200); assert.equal(imported.body.imported, 2);
  const recipient = imported.body.projectId; for (const id of app.registry.list().map(entry => entry.id)) app.registry.broker(id).start = () => assert.fail('Importing a shared conversation must not run inference');
  const received = app.registry.mainConversation(recipient); assert.deepEqual(received.messages.map(row => [row.role, row.provider, row.text]), [['user', undefined, 'Plan the checkout'], ['assistant', 'claude', 'Checkout planned']]);
  assert.equal(received.context.goal, 'Ship checkout'); assert.deepEqual(received.context.tasks, ['Add tests']); assert.deepEqual(app.registry.get(recipient).folders.map(folder => folder.path), [fs.realpathSync(other)]);
  assert.equal((await request('/api/import-sources/import', { files, projectId: recipient })).body.duplicate, true);
  assert.equal((await request('/api/import-sources/import', { files: [{ package: { ...file, workspace: { name: 'Changed' } }, approvedDigest: preview.body.digest }], projectId: recipient })).status, 400, 'Altered files are rejected.');
});

test('several large conversation files import together, though they exceed the general request limit', async t => {
  const f = fixture(t), other = path.join(f.root, 'recipient'); fs.mkdirSync(other);
  const app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'app'), bins: { codex: '/missing', claude: '/missing' } }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); f.closers.push(() => app.close());
  // Each file is under the 2 MB file limit; together they are over the 3 MB limit for other requests.
  const project = { name: 'Shop', folders: [{ id: 'web', name: 'web', displayName: 'web', path: '/Users/dev/shop/web' }] };
  const exported = name => exportConversation({ messages: Array.from({ length: 9 }, (_, index) => ({ id: `${name}-${index}`, role: index % 2 ? 'assistant' : 'user', provider: 'claude', text: `${name} ${index} ${'x'.repeat(190000)}`, createdAt: new Date(Date.UTC(2026, 9, 20, 9, index)).toISOString() })) }, project).package;
  const files = ['first', 'second'].map(exported).map(file => ({ package: file, approvedDigest: file.digest })), input = JSON.stringify({ files, folders: [other], name: 'Checkout' });
  assert.ok(files.every(file => Buffer.byteLength(JSON.stringify(file.package)) < 2 * 1024 * 1024) && Buffer.byteLength(input) > 3 * 1024 * 1024, 'Each file fits the file limit, but the request is over the general one.');
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/import-sources/import`, { method: 'POST', headers: { 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, body: input });
  const result = await response.json(); assert.equal(response.status, 200, result.error); assert.equal(result.imported, 18);
  assert.equal(app.registry.mainConversation(result.projectId).messages.length, 18);
  const preview = await fetch(`http://127.0.0.1:${app.server.address().port}/api/import-sources/file-preview`, { method: 'POST', headers: { 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ package: { padding: 'x'.repeat(3 * 1024 * 1024) } }) });
  assert.equal(preview.status, 413, 'Other requests keep the general limit.');
});

test('a changed image shows as pictures before and after, from its own bytes only', t => {
  const f = fixture(t), [folder] = f.folders, file = name => path.join(f.workspace, name);
  const png = color => Buffer.from(color === 'red' ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  git(f.workspace, 'init', '-q'); git(f.workspace, 'config', 'user.name', 'Fixture'); git(f.workspace, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(file('logo.png'), png('red')); fs.writeFileSync(file('old.png'), png('red')); fs.writeFileSync(file('fake.png'), Buffer.from([0, 1, 2, 3, 0, 5]));
  git(f.workspace, 'add', '.'); git(f.workspace, 'commit', '-qm', 'Images');
  fs.writeFileSync(file('logo.png'), png('blue')); fs.rmSync(file('old.png')); fs.writeFileSync(file('new.png'), png('blue')); fs.writeFileSync(file('fake.png'), Buffer.from([0, 9, 9, 9, 0]));
  fs.writeFileSync(file('data.bin'), Buffer.from([0, 1, 0, 1])); fs.writeFileSync(file('huge.png'), Buffer.concat([png('red'), Buffer.alloc(IMAGE_PREVIEW_BYTES)]));
  const changed = workspaceGitDiff(folder, 'logo.png');
  assert.equal(changed.images.before.src, `data:image/png;base64,${png('red').toString('base64')}`, 'Before is the committed image.');
  assert.equal(changed.images.after.src, `data:image/png;base64,${png('blue').toString('base64')}`, 'After is the image on disk.');
  assert.equal(changed.images.after.bytes, png('blue').length);
  assert.deepEqual([workspaceGitDiff(folder, 'new.png').images.before, Boolean(workspaceGitDiff(folder, 'new.png').images.after.src)], [null, true], 'A new image has only its after side.');
  assert.deepEqual([Boolean(workspaceGitDiff(folder, 'old.png').images.before.src), workspaceGitDiff(folder, 'old.png').images.after], [true, null], 'A deleted image has only its before side.');
  assert.deepEqual(workspaceGitDiff(folder, 'fake.png').images, { before: { bytes: 6, unreadable: true }, after: { bytes: 5, unreadable: true } }, 'Bytes that are not the image the name says are never shown.');
  assert.equal(workspaceGitDiff(folder, 'data.bin').images, undefined, 'Other binary files keep the binary note.');
  assert.deepEqual(workspaceGitDiff(folder, 'huge.png').images.after, { bytes: IMAGE_PREVIEW_BYTES + png('red').length, tooLarge: true });
});

test('Git diff shows tracked, staged and untracked changes but only for paths Git reports as changed', t => {
  const f = fixture(t), [folder] = f.folders; git(f.workspace, 'init', '-q'); git(f.workspace, 'config', 'user.name', 'Fixture'); git(f.workspace, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(f.workspace, 'app.js'), 'const value = 1;\n'); fs.writeFileSync(path.join(f.workspace, 'clean.js'), 'clean\n'); git(f.workspace, 'add', '.'); git(f.workspace, 'commit', '-qm', 'Initial');
  fs.appendFileSync(path.join(f.workspace, 'app.js'), '// staged\n'); git(f.workspace, 'add', 'app.js'); fs.appendFileSync(path.join(f.workspace, 'app.js'), '// unstaged\n'); fs.writeFileSync(path.join(f.workspace, 'new.js'), 'brand new\n');
  const tracked = workspaceGitDiff(folder, 'app.js'); assert.match(tracked.diff, /^\+\/\/ staged$/m); assert.match(tracked.diff, /^\+\/\/ unstaged$/m); assert.equal(tracked.truncated, false);
  assert.match(workspaceGitDiff(folder, 'new.js').diff, /^\+brand new$/m);
  for (const rejected of ['clean.js', '../outside.js', '--output=/tmp/x', '']) assert.throws(() => workspaceGitDiff(folder, rejected), error => error.status === 404);
  assert.equal(workspaceGitDiff(folder, 'app.js', { limit: 20 }).truncated, true);
});

test('Git diff cannot run configured clean filters, external diff drivers or textconv', t => {
  const f = fixture(t), marker = path.join(f.root, 'driver-ran'); git(f.workspace, 'init', '-q'); git(f.workspace, 'config', 'user.name', 'Fixture'); git(f.workspace, 'config', 'user.email', 'fixture@example.invalid'); fs.writeFileSync(path.join(f.workspace, 'app.js'), 'const value = 1;\n'); git(f.workspace, 'add', '.'); git(f.workspace, 'commit', '-qm', 'Initial');
  for (const [key, value] of [['filter.fixture.clean', `touch '${marker}'; cat`], ['diff.fixture.command', `touch '${marker}'`], ['diff.fixture.textconv', `touch '${marker}'; cat`], ['diff.external', `touch '${marker}'`]]) git(f.workspace, 'config', key, value);
  fs.writeFileSync(path.join(f.workspace, '.gitattributes'), '*.js filter=fixture diff=fixture\n'); fs.appendFileSync(path.join(f.workspace, 'app.js'), '// dirty\n');
  assert.match(workspaceGitDiff(f.folders[0], 'app.js').diff, /^\+\/\/ dirty$/m); assert.equal(fs.existsSync(marker), false);
});

test('provider usage windows normalize Codex and Claude plan limits to percent used with reset times', () => {
  assert.deepEqual(codexUsageWindows({ primary: { usedPercent: 26, windowDurationMins: 300, resetsAt: 1793302849 }, secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: null } }), [{ id: 'primary', label: '5-hour', usedPercent: 26, resetsAt: new Date(1793302849000).toISOString() }, { id: 'secondary', label: 'Weekly', usedPercent: 18, resetsAt: null }]);
  assert.deepEqual(codexUsageWindows('unknown'), []);
  const claude = claudeUsageWindows({ five_hour: { utilization: 74, resets_at: '2026-10-29T18:19:59Z' }, seven_day: { utilization: 35, resets_at: null }, seven_day_opus: null, seven_day_sonnet: { utilization: null }, model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: null }] });
  assert.deepEqual(claude.map(row => [row.label, row.usedPercent, row.scope]), [['5-hour', 74, undefined], ['Weekly', 35, undefined], ['Weekly · Fable', 12, 'fable']]);
  assert.deepEqual(claudeUsageWindows(null), []);

});

test('effort persists independently for each provider and model across journal reload', async t => {
  const f = fixture(t), options = { workspace: f.workspace, dataDir: path.join(f.root, 'journal') }; let broker = new Broker(options); const c = broker.get(broker.create().id);
  broker.settings(c, { model: 'first', effort: 'high' }); broker.settings(c, { model: 'second', effort: 'low' }); broker.settings(c, { model: 'first' }); assert.equal(c.effort, 'high'); broker.settings(c, { provider: 'claude', model: 'sonnet', effort: 'medium' });
  await broker.close(); broker = new Broker(options); const restored = broker.get(c.id); broker.settings(restored, { provider: 'codex', model: 'first' }); assert.equal(restored.effort, 'high'); assert.equal(restored.efforts.claude.sonnet, 'medium'); assert.throws(() => broker.settings(restored, { effort: 'made-up' }), /reasoning effort/); await broker.close();
  assert(commandFor('codex', { mode: 'edit', effort: 'high' }).args.includes('model_reasoning_effort=high')); assert(commandFor('claude', { mode: 'read', effort: 'low' }).args.includes('--effort'));
});

test('native provider transports receive the selected effort without exposing reasoning text', async () => {
  const calls = [], events = [];
  class Client extends EventEmitter { async initialize() {} close() {} async request(method, params) { calls.push({ method, params }); if (method === 'thread/start') return { thread: { id: 'thread' } }; if (method === 'turn/start') { queueMicrotask(() => { this.emit('message', { method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread', delta: 'private text' } }); this.emit('message', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } }); }); return { turn: { id: 'turn' } }; } } }
  await runCodex({ workspace: '/tmp', mode: 'read', effort: 'high' }, { clientFactory: () => new Client(), event: value => events.push(value), metadata() {}, approval: async () => false });
  assert.equal(calls.find(row => row.method === 'turn/start').params.effort, 'high'); assert(events.some(row => row.phase === 'reasoning')); assert(!JSON.stringify(events).includes('private text'));
  let options; await runClaude({ workspace: '/tmp', mode: 'read', effort: 'low' }, { queryImpl: input => { options = input.options; return (async function* () { yield { type: 'result', subtype: 'success' }; })(); }, event() {}, metadata() {}, approval: async () => false }); assert.equal(options.effort, 'low');
});

test('selecting provider defaults on a resumed Codex thread resets the model and effort', async () => {
  const calls = []; class Client extends EventEmitter { async initialize() {} close() {} async request(method, params) { calls.push({ method, params }); if (method === 'model/list') return { data: [{ id: 'selected', isDefault: true, defaultReasoningEffort: 'medium' }] }; if (method === 'thread/resume') return { thread: { id: 'existing' } }; if (method === 'turn/start') { queueMicrotask(() => this.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } })); return { turn: { id: 'turn' } }; } } }
  await runCodex({ workspace: '/tmp', mode: 'read', model: null, sessionId: 'existing', effort: null }, { clientFactory: () => new Client(), event() {}, metadata() {}, approval: async () => false }); assert.equal(calls.find(row => row.method === 'turn/start').params.effort, 'medium'); assert.equal(calls.find(row => row.method === 'turn/start').params.model, 'selected');
});

test('Claude import preview is scoped, excludes private reasoning/tools, and imports atomically without running a model', async t => {
  const f = fixture(t); const importer = new ConversationImporter({ sdkLoader: async () => ({ getSessionInfo: async (_id, options) => options.dir === f.workspace ? { cwd: f.workspace, summary: 'Existing task' } : null, getSessionMessages: async () => [{ uuid: 'u', type: 'user', message: { content: [{ type: 'text', text: 'Build this' }] } }, { uuid: 'a', type: 'assistant', message: { model: 'sonnet', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Implemented' }, { type: 'tool_use', input: { secret: 'no' } }] } }] }) });
  const preview = await importer.preview('claude', 'source-session', f.folders); assert.equal(preview.messageCount, 2); assert(!JSON.stringify(preview).includes('private')); assert(!JSON.stringify(preview).includes('secret'));
  const options = { workspace: f.workspace, dataDir: path.join(f.root, 'journal') }; const broker = new Broker(options), c = broker.get(broker.create().id); broker.message(c, 'user', 'Existing Relay message'); broker.start = () => assert.fail('Import must not invoke a model');
  assert.equal(broker.importTranscript(c, preview).imported, 2); assert.equal(c.messages[0].text, 'Existing Relay message'); assert.equal(broker.importTranscript(c, preview).duplicate, true); assert.equal(c.messages.length, 3); await broker.close();
  const restored = new Broker(options); assert.equal(restored.importTranscript(restored.get(c.id), preview).duplicate, true); await restored.close();
});

test('Claude import of a long conversation keeps its newest messages', async t => {
  const f = fixture(t), rows = Array.from({ length: 3000 }, (_, i) => ({ uuid: `m${i}`, type: i % 2 ? 'assistant' : 'user', message: { content: [{ type: 'text', text: `message #${i}` }] } }));
  // Like the SDK, offset and limit count from the oldest message.
  const importer = new ConversationImporter({ sdkLoader: async () => ({ getSessionInfo: async () => ({ cwd: f.workspace, summary: 'Long task' }), getSessionMessages: async (_id, { offset = 0, limit = rows.length } = {}) => rows.slice(offset, offset + limit) }) });
  const preview = await importer.preview('claude', 'long-session', f.folders);
  assert.equal(preview.messageCount, 1000); assert.equal(preview.clipped, true); assert.equal(preview.messages[0].text, 'message #2000'); assert.equal(preview.messages.at(-1).text, 'message #2999');
});

test('reimporting a growing conversation updates an imported partial message without duplicating it', async t => {
  const f = fixture(t), broker = new Broker({ workspace: f.workspace, dataDir: path.join(f.root, 'journal') }), c = broker.get(broker.create().id); const first = { provider: 'codex', sessionId: 'native', digest: 'one', messages: [{ sourceId: 'answer', role: 'assistant', text: 'Partial' }] };
  broker.importTranscript(c, first); const updated = broker.importTranscript(c, { ...first, digest: 'two', messages: [{ sourceId: 'answer', role: 'assistant', text: 'Completed answer' }] }); assert.equal(updated.updated, 1); assert.equal(updated.imported, 0); assert.equal(c.messages.length, 1); assert.equal(c.messages[0].text, 'Completed answer'); await broker.close();
});

test('Codex preview pages text chronologically and rejects a thread from another workspace', async t => {
  const f = fixture(t), requests = []; let outside = false;
  await assert.rejects(new ConversationImporter({ codexBin: () => null }).list('codex', null), /Install Codex CLI/);
  const importer = new ConversationImporter({ codexBin: () => '/fixture/codex', clientFactory: () => ({ initialize: async () => {}, close() {}, request: async (method, params) => { requests.push({ method, params }); if (method === 'thread/read') return { thread: { cwd: outside ? '/elsewhere' : f.workspace, name: 'A task' } }; return { data: [{ id: 'turn', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Question' }] }, { type: 'reasoning', text: 'hidden' }, { type: 'agentMessage', id: 'a', text: 'Answer' }] }] }; } }) });
  const preview = await importer.preview('codex', 'native-thread', f.folders); assert.deepEqual(preview.messages.map(row => row.text), ['Question', 'Answer']); assert(!JSON.stringify(preview).includes('hidden')); outside = true; await assert.rejects(importer.preview('codex', 'native-thread', f.folders), /different workspace/); assert(!requests.some(row => /resume|turn\/start/.test(row.method)));
});

test('HTTP imports require exact preview approval, preserve one chat, deduplicate, and start no inference', async t => {
  const f = fixture(t); let version = 'one'; const importer = { list: async () => ({ sessions: [{ id: 'source', provider: 'codex', title: 'Task' }] }), preview: async () => ({ provider: 'codex', sessionId: 'source', title: 'Task', digest: version, messages: [{ sourceId: version, role: 'user', text: 'Imported request' }] }) };
  const app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'app'), importer, bins: { codex: '/missing', claude: '/missing' } }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); f.closers.push(() => app.close()); const projectId = app.registry.list()[0].id;
  const request = async (route, value) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}${route}?projectId=${projectId}`, { method: value ? 'POST' : 'GET', headers: { 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) }); return { status: r.status, body: await r.json() }; };
  const c = (await request('/api/conversation')).body; app.registry.broker(projectId).start = () => assert.fail('Import must not run inference'); assert.equal((await request('/api/imports', { provider: 'codex', sessionId: 'source', approvedDigest: 'stale' })).status, 409);
  const result = await request('/api/imports', { provider: 'codex', sessionId: 'source', approvedDigest: 'one' }); assert.equal(result.status, 200); assert.equal(result.body.conversationId, c.id); assert.equal(result.body.imported, 1); assert.equal((await request('/api/imports', { provider: 'codex', sessionId: 'source', approvedDigest: 'one' })).body.duplicate, true); assert.equal((await request('/api/conversation')).body.messages.length, 1);
});

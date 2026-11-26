import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs, noSymlinks } from './platform.mjs';
import { EventEmitter, once } from 'node:events';
import { AttachmentStore, describeAttachment } from '../src/attachments.mjs';
import { listFiles, readExplorerFile, saveExplorerFile } from '../src/file-explorer.mjs';
import { MAX_FILE_BYTES } from '../src/collaboration-format.mjs';
import { prepareContext } from '../src/context.mjs';
import { runCodex, runClaude } from '../src/providers.mjs';
import { Broker } from '../src/broker.mjs';
import { createRelayServer } from '../src/server.mjs';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'relay-files-'))), workspace = path.join(root,'project'); fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  return { root, workspace, folder:{id:'root',name:'project',path:workspace}, store:new AttachmentStore(path.join(root,'data')) };
}

test('explorer is lazy, sorted, bounded, multi-root scoped and excludes private paths and links',{skip:noSymlinks},t => {
  const f=fixture(t);fs.mkdirSync(path.join(f.workspace,'src'));fs.mkdirSync(path.join(f.workspace,'.data'));fs.mkdirSync(path.join(f.workspace,'node_modules'));
  fs.writeFileSync(path.join(f.workspace,'main.js'),'export const answer = 42;');fs.writeFileSync(path.join(f.workspace,'.env'),'private');fs.symlinkSync(f.root,path.join(f.workspace,'outside'));
  assert.deepEqual(listFiles(f.folder).entries.map(e=>e.name),['src','main.js']);
  assert.equal(readExplorerFile(f.folder,'main.js').text,'export const answer = 42;');
  for (const value of ['../data','/etc/passwd','.data','node_modules','.env','outside/data']) assert.throws(()=>listFiles(f.folder,value));
  for (let i=0;i<203;i++) fs.writeFileSync(path.join(f.workspace,'src',`${i}.txt`),'test');
  const page=listFiles(f.folder,'src');assert.equal(page.entries.length,200);assert.equal(page.nextOffset,200);assert.equal(listFiles(f.folder,'src',200).entries.length,3);
  fs.writeFileSync(path.join(f.workspace,'binary.bin'),Buffer.from([0,255]));assert.throws(()=>readExplorerFile(f.folder,'binary.bin'),/binary/);
});

test('a directory junction never leads the explorer outside the workspace',t => {
  const f=fixture(t);fs.writeFileSync(path.join(f.workspace,'main.js'),'');fs.mkdirSync(path.join(f.root,'elsewhere'));fs.writeFileSync(path.join(f.root,'elsewhere','secret.txt'),'private');
  // A junction needs no special rights on Windows; elsewhere this makes an ordinary folder link.
  fs.symlinkSync(path.join(f.root,'elsewhere'),path.join(f.workspace,'joined'),'junction');
  assert.deepEqual(listFiles(f.folder).entries.map(e=>e.name),['main.js']);
  assert.throws(()=>listFiles(f.folder,'joined'));
  assert.throws(()=>readExplorerFile(f.folder,'joined/secret.txt'));
});

test('attachment snapshots are immutable, bounded, content-verified and isolated by workspace',t=>{
  const f=fixture(t), one=f.store.put({name:'notes.md',data:Buffer.from('Saved notes').toString('base64')});
  assert.equal(new AttachmentStore(path.join(f.root,'data')).read(one.id).text,'Saved notes');
  assert.deepEqual(f.store.put({name:'notes.md',data:Buffer.from('Saved notes').toString('base64')}),one);
  assert.throws(()=>new AttachmentStore(path.join(f.root,'other')).read(one.id),/no longer available/);
  assert.throws(()=>f.store.read('../../private'),/Invalid attachment/);
  assert.throws(()=>f.store.select([one.id,one.id]),/different files/);
  assert.throws(()=>describeAttachment('image.png',Buffer.from('not an image')),/format/);
  assert.throws(()=>describeAttachment('file.pdf',Buffer.from('%PDF-1.2')),/doesn't preview PDFs/);
  assert.throws(()=>describeAttachment('big.txt',Buffer.alloc(65537,65)),/64 KB/);
  assert.throws(()=>f.store.put({name:'bad',data:'!base64'}),/Invalid/);
  const image=f.store.put({name:'screen.png',data:png});assert.equal(image.kind,'image');assert.equal(f.store.imageInput(image.id).data,png);
  assert.equal(fs.readFileSync(f.store.imageInput(image.id).path).toString('base64'),png);
  const disk=path.join(f.store.root,one.id+'.json'), altered=JSON.parse(fs.readFileSync(disk));altered.data=Buffer.from('changed').toString('base64');fs.writeFileSync(disk,JSON.stringify(altered));assert.throws(()=>f.store.read(one.id),/changed/);
});

test('attachments survive model handoff; text is bounded and images are provided only as needed',t=>{
  const f=fixture(t), note=f.store.put({name:'notes.md',data:Buffer.from('Important requirement').toString('base64')}), image=f.store.put({name:'screen.png',data:png});
  const c={provider:'codex',mode:'read',sessions:{codex:{cursor:2}},messages:[{seq:1,role:'user',text:'Review',attachments:[note,image]}]};
  const options={workspace:f.workspace,readAttachment:id=>f.store.read(id)};
  const handoff=prepareContext(c,'Continue',{...options,provider:'claude'});assert.match(handoff.prompt,/Important requirement/);assert.deepEqual(handoff.images,[image]);
  assert.equal(prepareContext(c,'Continue',{...options,provider:'codex'}).images.length,0);
  assert.equal(prepareContext(c,'Continue',{...options,provider:'codex',fresh:true}).images.length,1);
  const current=prepareContext(c,'Review',{...options,attachments:[note,image]});assert.match(current.prompt,/Important requirement/);assert.equal(current.images.length,1);
});

test('native adapters deliver actual image inputs and preserve read-only permissions',async t=>{
  const f=fixture(t), saved=f.store.put({name:'screen.png',data:png}), images=[f.store.imageInput(saved.id)];
  class Client extends EventEmitter {
    requests=[];async initialize(){} close(){}
    async request(method,params){this.requests.push({method,params});if(method==='thread/start')return {thread:{id:'thread'}};if(method==='turn/start'){queueMicrotask(()=>this.emit('message',{method:'turn/completed',params:{turn:{status:'completed'}}}));return {turn:{id:'turn'}};}}}
  const client=new Client();
  await runCodex({workspace:f.workspace,prompt:'Describe the image',mode:'read',images},{clientFactory:()=>client,event(){},metadata(){},approval:async()=>false});
  const turn=client.requests.find(row=>row.method==='turn/start').params;
  assert.deepEqual(turn.input.at(-1),{type:'localImage',path:images[0].path});assert.equal(turn.sandboxPolicy.type,'readOnly');
  let content,options;
  // The prompt is streamed and stays open for notes until the turn's result, so read only the first message.
  async function* queryImpl(input){options=input.options;content=(await input.prompt[Symbol.asyncIterator]().next()).value.message.content;yield {type:'result',subtype:'success'};}
  await runClaude({workspace:f.workspace,prompt:'Describe the image',mode:'read',images},{queryImpl,event(){},metadata(){},approval:async()=>false});
  assert.deepEqual(content.at(-1),{type:'image',source:{type:'base64',media_type:'image/png',data:png}});assert.deepEqual(options.tools,['Read','Glob','Grep','TodoWrite']);
});

test('broker journals metadata only and attachment changes cannot reuse an accepted request ID',{skip:scriptCLIs},async t=>{
  const f=fixture(t), bin=path.join(f.root,'mock');fs.writeFileSync(bin,`#!${process.execPath}\nimport ${JSON.stringify(new URL('./mock-cli.mjs',import.meta.url).href)};\n`,{mode:0o700});fs.writeFileSync(path.join(f.workspace,'.mock-scenarios.json'),'{}');
  const broker=new Broker({workspace:f.workspace,dataDir:path.join(f.root,'broker'),bins:{codex:bin,claude:bin}});t.after(()=>broker.close());
  const note=broker.attachments.put({name:'note.txt',data:Buffer.from('Attachment-only requirement').toString('base64')}), chat=broker.get(broker.create().id), input={text:'Review',attachments:[note.id],requestId:'file-request'};
  broker.start(chat,input);await broker.running.done;
  assert.equal(chat.messages[0].attachments[0].id,note.id);assert.equal('data' in chat.messages[0].attachments[0],false);
  assert.equal(broker.start(chat,input).duplicate,true);assert.throws(()=>broker.start(chat,{...input,attachments:[]}),/another message/);
  const captures=fs.readFileSync(path.join(f.workspace,'.mock-captures.jsonl'),'utf8');assert.match(captures,/Attachment-only requirement/);
  const image=broker.attachments.put({name:'test.png',data:png});assert.throws(()=>broker.start(chat,{text:'Image',attachments:[image.id]}),/native Codex/);
});

test('HTTP files and attachments require the desktop token, current workspace and explicit upload',async t=>{
  const f=fixture(t), app=createRelayServer({workspace:f.workspace,dataRoot:path.join(f.root,'server'),accessToken:'local-test',bins:{codex:process.execPath,claude:process.execPath}});t.after(()=>app.close());
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port, project=app.registry.list()[0], headers={'X-AI-Relay-Token':'local-test'};
  fs.writeFileSync(path.join(f.workspace,'readme.md'),'local content');
  assert.equal((await fetch(base+'/api/files?projectId='+project.id)).status,403);
  const endpoint=base+'/api/files?projectId='+project.id+'&folderId='+project.folders[0].id;
  assert.equal((await (await fetch(endpoint,{headers})).json()).entries[0].name,'readme.md');
  const upload=await fetch(base+'/api/attachments?projectId='+project.id,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-AI-Relay':'1'},body:JSON.stringify({name:'readme.md',data:Buffer.from('snapshot').toString('base64')})});assert.equal(upload.status,201);
  const saved=await upload.json();assert.equal((await (await fetch(base+'/api/attachments/preview?projectId='+project.id+'&id='+saved.id,{headers})).json()).text,'snapshot');
  assert.equal(app.registry.broker(project.id).running,null);
  app.registry.remove(project.id);
  assert.equal((await fetch(endpoint,{headers})).status,404);
});


test('large supported images do not overflow validation and snapshots reject noncanonical base64',t=>{
  const f=fixture(t), bytes=Buffer.alloc(5*1024*1024);bytes.set([137,80,78,71,13,10,26,10]);
  assert.equal(f.store.put({name:'large.png',data:bytes.toString('base64')}).bytes,bytes.length);
  assert.throws(()=>f.store.put({name:'invalid.txt',data:'a==='}),/base64/);
});

test('saveExplorerFile enforces hashes, path bounds, symlinks, binary and size limits', { skip: noSymlinks }, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'notes.txt'), 'first line\n');
  fs.writeFileSync(path.join(f.workspace, 'empty.txt'), '');
  fs.writeFileSync(path.join(f.workspace, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(f.workspace, 'huge.txt'), 'a'.repeat(MAX_FILE_BYTES + 10));
  fs.writeFileSync(path.join(f.workspace, 'medium.txt'), 'b'.repeat(70 * 1024));
  fs.writeFileSync(path.join(f.root, 'outside.txt'), 'secret');
  fs.symlinkSync(path.join(f.root, 'outside.txt'), path.join(f.workspace, 'link.txt'));
  fs.mkdirSync(path.join(f.root, 'elsewhere'));
  fs.writeFileSync(path.join(f.root, 'elsewhere', 'target.txt'), 'secret');
  fs.symlinkSync(path.join(f.root, 'elsewhere'), path.join(f.workspace, 'joined'), 'junction');

  const opened = readExplorerFile(f.folder, 'notes.txt');
  assert.equal(opened.editable, true);
  assert.match(opened.sha256, /^[a-f0-9]{64}$/);
  // Empty and medium (64 KB–256 KB) text files can be opened and edited.
  const empty = readExplorerFile(f.folder, 'empty.txt');
  assert.equal(empty.text, '');
  assert.equal(empty.editable, true);
  assert.equal(readExplorerFile(f.folder, 'medium.txt').editable, true);

  // Matching expectedHash saves cleanly and returns the new hash.
  const saved = saveExplorerFile(f.folder, 'notes.txt', 'second line\n', { expectedHash: opened.sha256 });
  assert.equal(fs.readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8'), 'second line\n');
  assert.notEqual(saved.sha256, opened.sha256);

  // Stale expectedHash is refused with 409 and returns the current disk contents.
  assert.throws(
    () => saveExplorerFile(f.folder, 'notes.txt', 'conflict\n', { expectedHash: opened.sha256 }),
    error => error.status === 409 && error.details?.code === 'FILE_CHANGED' && error.details.current.text === 'second line\n' && error.details.current.sha256 === saved.sha256
  );
  assert.equal(fs.readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8'), 'second line\n');

  // Force saves over a stale file when explicitly chosen.
  const forced = saveExplorerFile(f.folder, 'notes.txt', 'forced\n', { expectedHash: opened.sha256, force: true });
  assert.equal(fs.readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8'), 'forced\n');

  // Deleted file triggers 409 FILE_CHANGED (deleted: true), and force recreates it.
  fs.unlinkSync(path.join(f.workspace, 'notes.txt'));
  assert.throws(
    () => saveExplorerFile(f.folder, 'notes.txt', 'restored\n', { expectedHash: forced.sha256 }),
    error => error.status === 409 && error.details?.code === 'FILE_CHANGED' && error.details.current.deleted === true
  );
  saveExplorerFile(f.folder, 'notes.txt', 'restored\n', { force: true });
  assert.equal(fs.readFileSync(path.join(f.workspace, 'notes.txt'), 'utf8'), 'restored\n');

  // Paths outside the folder, private paths, symlinks and junctions are refused.
  for (const bad of ['../outside.txt', '/etc/passwd', '.env', '.git/config', 'node_modules/a.js', 'link.txt', 'joined/target.txt']) {
    assert.throws(() => saveExplorerFile(f.folder, bad, 'nope', { force: true }));
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'outside.txt'), 'utf8'), 'secret');

  // Binary files, NUL bytes, non-text extensions and oversized files are refused.
  assert.throws(() => saveExplorerFile(f.folder, 'binary.bin', 'text', { force: true }), /Binary|UTF-8/);
  assert.throws(() => saveExplorerFile(f.folder, 'notes.txt', 'a\u0000b', { force: true }), /Binary/);
  assert.throws(() => saveExplorerFile(f.folder, 'photo.png', 'text', { force: true }), /plain text/);
  assert.throws(() => saveExplorerFile(f.folder, 'notes.txt', 'x'.repeat(MAX_FILE_BYTES + 1), { force: true }), error => error.status === 413);
  assert.throws(() => saveExplorerFile(f.folder, 'huge.txt', 'small', { force: true }), error => error.status === 413);
});

test('POST /api/files/save enforces origin, token, stale hash, active-run warning and allows Read-only workspace edits', async t => {
  const f = fixture(t);
  const app = createRelayServer({ workspace: f.workspace, dataRoot: path.join(f.root, 'server'), accessToken: 'local-test', bins: { codex: process.execPath, claude: process.execPath } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const project = app.registry.list()[0], folder = project.folders[0];
  const auth = { 'X-AI-Relay-Token': 'local-test', 'X-AI-Relay': '1', 'Content-Type': 'application/json' };
  fs.writeFileSync(path.join(f.workspace, 'app.js'), 'const a = 1;\n');

  const preview = await (await fetch(`${base}/api/files/preview?projectId=${project.id}&folderId=${folder.id}&path=app.js`, { headers: { 'X-AI-Relay-Token': 'local-test' } })).json();
  assert.equal(preview.editable, true);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);

  const saveUrl = `${base}/api/files/save?projectId=${project.id}`;
  // Missing desktop token -> 403.
  assert.equal((await fetch(saveUrl, { method: 'POST', headers: { 'X-AI-Relay': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: folder.id, path: 'app.js', content: 'x', expectedHash: preview.sha256 }) })).status, 403);
  // Cross-origin request -> 403.
  assert.equal((await fetch(saveUrl, { method: 'POST', headers: { ...auth, Origin: 'http://evil.example' }, body: JSON.stringify({ folderId: folder.id, path: 'app.js', content: 'x', expectedHash: preview.sha256 }) })).status, 403);
  // Missing X-AI-Relay header -> 403.
  assert.equal((await fetch(saveUrl, { method: 'POST', headers: { 'X-AI-Relay-Token': 'local-test', 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: folder.id, path: 'app.js', content: 'x', expectedHash: preview.sha256 }) })).status, 403);
  // GET -> 405.
  assert.equal((await fetch(saveUrl, { headers: { 'X-AI-Relay-Token': 'local-test' } })).status, 405);

  // Set workspace conversation to Read only: user edits are still allowed (Read only limits agents, not the person).
  const broker = app.registry.broker(project.id), chat = broker.get(app.registry.mainConversationId(project.id));
  chat.mode = 'read';
  const ok = await fetch(saveUrl, { method: 'POST', headers: auth, body: JSON.stringify({ folderId: folder.id, path: 'app.js', content: 'const a = 2;\n', expectedHash: preview.sha256 }) });
  assert.equal(ok.status, 200);
  const saved = await ok.json();
  assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'const a = 2;\n');
  assert.equal(chat.messages.length, 0, 'User edits are not recorded as an agent run.');

  // Stale hash returns 409 FILE_CHANGED.
  const stale = await fetch(saveUrl, { method: 'POST', headers: auth, body: JSON.stringify({ folderId: folder.id, path: 'app.js', content: 'const a = 3;\n', expectedHash: preview.sha256 }) });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.details.code, 'FILE_CHANGED');
  assert.equal(staleBody.details.current.text, 'const a = 2;\n');

  // Active edit-mode agent run in the same folder triggers a 409 ACTIVE_RUN warning (with touched detection), and confirmActiveRun allows saving.
  chat.messages.push({ id: 'm1', runId: 'run-live', role: 'activity', text: 'Editing app.js' });
  broker.running = { id: 'run-live', c: chat, mode: 'edit', review: false, approvals: new Map() };
  try {
    const warned = await fetch(saveUrl, { method: 'POST', headers: auth, body: JSON.stringify({ folderId: folder.id, path: 'app.js', content: 'const a = 4;\n', expectedHash: saved.sha256 }) });
    assert.equal(warned.status, 409);
    const warnedBody = await warned.json();
    assert.equal(warnedBody.details.code, 'ACTIVE_RUN');
    assert.equal(warnedBody.details.activeRun.touched, true);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'const a = 2;\n');

    const confirmed = await fetch(saveUrl, { method: 'POST', headers: auth, body: JSON.stringify({ folderId: folder.id, path: 'app.js', content: 'const a = 4;\n', expectedHash: saved.sha256, confirmActiveRun: true }) });
    assert.equal(confirmed.status, 200);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'app.js'), 'utf8'), 'const a = 4;\n');
  } finally {
    broker.running = null;
    await app.close();
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scriptCLIs, noSymlinks } from './platform.mjs';
import { EventEmitter, once } from 'node:events';
import { AttachmentStore, describeAttachment } from '../src/attachments.mjs';
import { listFiles, readExplorerFile } from '../src/file-explorer.mjs';
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

test('attachment snapshots are immutable, bounded, content-verified and isolated by workspace',t=>{
  const f=fixture(t), one=f.store.put({name:'notes.md',data:Buffer.from('Saved notes').toString('base64')});
  assert.equal(new AttachmentStore(path.join(f.root,'data')).read(one.id).text,'Saved notes');
  assert.deepEqual(f.store.put({name:'notes.md',data:Buffer.from('Saved notes').toString('base64')}),one);
  assert.throws(()=>new AttachmentStore(path.join(f.root,'other')).read(one.id),/no longer available/);
  assert.throws(()=>f.store.read('../../private'),/Invalid attachment/);
  assert.throws(()=>f.store.select([one.id,one.id]),/different files/);
  assert.throws(()=>describeAttachment('image.png',Buffer.from('not an image')),/format/);
  assert.throws(()=>describeAttachment('file.pdf',Buffer.from('%PDF-1.2')),/format/);
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

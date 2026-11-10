import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { noSymlinks } from './platform.mjs';
import { ProjectRegistry } from '../src/projects.mjs';
import { gitExecutable } from '../src/resolve-binary.mjs';
import { CollaborationService, testInputs } from '../src/collaboration.mjs';
import { ProjectCommands } from '../src/project-commands.mjs';
import { atomicJSON } from '../src/patches.mjs';
import { readWorkspaceFile } from '../src/workspace-files.mjs';
import { sha256,canonicalStringify,sealPackage,sealSolution,validatePublicPackage,validateSolution,validateRelativePath,scanSecrets,MAX_FILE_BYTES,MAX_BINARY_BYTES } from '../src/collaboration-format.mjs';

function setup(t,{git=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-relay-collaboration-'));
  const dataRoot=path.join(root,'private');const owner=path.join(root,'owner');const friend=path.join(root,'friend');fs.mkdirSync(owner);fs.mkdirSync(friend);
  if(git)execFileSync(gitExecutable(),['init','--quiet'],{cwd:owner});
  const registry=new ProjectRegistry({dataRoot,bins:{codex:path.join(root,'missing-codex'),claude:path.join(root,'missing-claude')}});
  const first=registry.add({path:owner});const second=registry.add({path:friend});
  let modelCalls=0;
  const original=registry.broker.bind(registry);
  registry.broker=id=>{const broker=original(id);broker.start=()=>{modelCalls++;throw new Error('Provider boundary must never be called by collaboration.');};return broker;};
  const broker=registry.broker(first.id);const conversation=broker.create();
  const service=new CollaborationService({registry,dataRoot});
  t.after(async()=>{assert.equal(modelCalls,0);await registry.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,dataRoot,owner,friend,registry,first,second,broker,conversation,service};
}
async function request(env,input={}) {
  const preview=env.service.prepare(env.first.id,env.conversation.id,{mode:'source',goal:'Fix the selected problem.',files:['app.js'],...input});
  return env.service.approve(env.first.id,env.conversation.id,{package:preview.package,approvedIntegrity:preview.package.integrity});
}
function returned(handoff,files,extra={}) {
  return sealSolution({schema:'ai-relay.solution',version:1,id:randomUUID(),handoffId:handoff.id,createdAt:new Date().toISOString(),explanation:'A deterministic friend fix.',assumptions:[],verification:['Contributor reports its tests passed; not verified by recipient.'],patch:{format:'ai-relay.text.v1',files},...extra});
}
function existsContent(folder,file){return fs.existsSync(path.join(folder,file))?fs.readFileSync(path.join(folder,file),'utf8'):null;}

test('portable canonical SHA-256 and exact inventory detect public package edits',async t=>{
  for(const text of ['', 'abc','UTF-8 🍉','x'.repeat(100000)])assert.equal(sha256(text),createHash('sha256').update(text).digest('hex'));
  assert.equal(canonicalStringify({b:1,a:{z:2,y:3}}),'{"a":{"y":3,"z":2},"b":1}');
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'export const dirty = true;\n');
  const preview=env.service.prepare(env.first.id,env.conversation.id,{mode:'source',goal:'Original',files:['app.js']});
  assert.equal(preview.package.inventory.files[0].sha256,sha256('export const dirty = true;\n'));
  const changed=structuredClone(preview.package);changed.goal='Changed';assert.throws(()=>validatePublicPackage(changed),/inventory|integrity/);
  const edited=env.service.prepare(env.first.id,env.conversation.id,{draft:changed});assert.equal(edited.package.id,preview.package.id);assert.notEqual(edited.package.integrity,preview.package.integrity);
  await assert.rejects(env.service.approve(env.first.id,env.conversation.id,{package:edited.package,approvedIntegrity:preview.package.integrity}),/exact preview/);
  const approved=await env.service.approve(env.first.id,env.conversation.id,{package:edited.package,approvedIntegrity:edited.package.integrity});
  assert.deepEqual(approved.package,edited.package);assert(!canonicalStringify(approved.package).includes(env.owner));assert(!Object.hasOwn(approved.package,'projectId'));
  assert.deepEqual(await env.service.approve(env.first.id,env.conversation.id,{package:edited.package,approvedIntegrity:edited.package.integrity}),approved);
});

test('prepare uses only explicit messages/files and redacts common transcript secrets and local paths',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'export const value = 1;\n');fs.writeFileSync(path.join(env.owner,'not-selected.txt'),'PRIVATE UNSELECTED CONTENT');
  const selected=env.broker.message(env.broker.get(env.conversation.id),'user','Investigate '+env.owner+'/app.js at /Users/alice/private/source. Token sk-abcdefghijklmnopqrstuvwxyz1234567890');
  env.broker.message(env.broker.get(env.conversation.id),'assistant','PRIVATE UNSELECTED MESSAGE','codex');
  const {package:publicPackage}=env.service.prepare(env.first.id,env.conversation.id,{mode:'source',messageIds:[selected],files:['app.js']});
  assert.equal(publicPackage.messages.length,1);const encoded=canonicalStringify(publicPackage);assert(!encoded.includes('PRIVATE UNSELECTED'));assert(!encoded.includes(env.owner));assert(!encoded.includes('/Users/alice'));assert(!encoded.includes('sk-abcdefghijklmnopqrstuvwxyz'));assert.equal(scanSecrets(publicPackage).length,0);
  await env.service.approve(env.first.id,env.conversation.id,{package:publicPackage,approvedIntegrity:publicPackage.integrity});
  const context=env.service.prepare(env.first.id,env.conversation.id,{}).package;assert.equal(context.mode,'context');assert.equal(context.messages.length,0);assert.equal(context.files.length,0);
});

test('full offline dirty/untracked source round trip preserves index, unrelated work, and exact recovery bytes',async t=>{
  const env=setup(t,{git:true});fs.writeFileSync(path.join(env.owner,'app.js'),'export const value = "staged";\n');execFileSync(gitExecutable(),['add','app.js'],{cwd:env.owner});
  const dirty='\ufeffexport const value = "my dirty work";\n';fs.writeFileSync(path.join(env.owner,'app.js'),dirty);fs.chmodSync(path.join(env.owner,'app.js'),0o755);fs.writeFileSync(path.join(env.owner,'untracked.txt'),'untracked original\n');fs.writeFileSync(path.join(env.owner,'unrelated.txt'),'do not touch\n');
  const indexBefore=execFileSync(gitExecutable(),['show',':app.js'],{cwd:env.owner,encoding:'utf8'});
  const handoff=await request(env,{files:['app.js','untracked.txt'],newPaths:['new/created.txt']});assert.equal(handoff.package.files[0].content,dirty);assert.equal(handoff.package.baseline[2].sha256,null);
  fs.writeFileSync(path.join(env.friend,'app.js'),'export const value = "friend fix";\n');fs.writeFileSync(path.join(env.friend,'untracked.txt'),'untracked fix\n');fs.mkdirSync(path.join(env.friend,'new'));fs.writeFileSync(path.join(env.friend,'new/created.txt'),'new approved file\n');fs.writeFileSync(path.join(env.friend,'keep.txt'),'friend work');
  const imported=await env.service.importRequest(env.second.id,handoff.package);assert.equal(existsContent(env.friend,'keep.txt'),'friend work');assert.equal(existsContent(env.friend,'app.js'),'export const value = "friend fix";\n');
  assert.deepEqual(await env.service.importRequest(env.second.id,handoff.package),imported);
  const solution=env.service.buildSolution(env.second.id,handoff.id,{files:['app.js','untracked.txt','new/created.txt'],explanation:'Uses my separate account outside this application.',verification:['Contributor syntax check passed.']});
  const received=env.service.receiveSolution(env.first.id,solution);const count=env.broker.get(env.conversation.id).messages.length;assert.deepEqual(env.service.receiveSolution(env.first.id,solution),received);assert.equal(env.broker.get(env.conversation.id).messages.length,count);
  const preview=env.service.previewSolution(env.first.id,received.id);assert.equal(preview.status,'applicable');assert(preview.files[0].diff.includes('my dirty work'));assert(preview.files[0].diff.includes('friend fix'));
  await assert.rejects(env.service.applySolution(env.first.id,received.id,{}),/Explicit approval/);
  const applied=await env.service.applySolution(env.first.id,received.id,{approvedIntegrity:solution.integrity});assert.equal(applied.status,'applied');assert.equal(existsContent(env.owner,'new/created.txt'),'new approved file\n');
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(env.owner,'app.js')).mode&0o777,0o755);assert.equal(execFileSync(gitExecutable(),['show',':app.js'],{cwd:env.owner,encoding:'utf8'}),indexBefore);assert.equal(existsContent(env.owner,'unrelated.txt'),'do not touch\n');
  const secondApply=await env.service.applySolution(env.first.id,received.id,{approvedIntegrity:solution.integrity});assert.deepEqual(secondApply,applied);
  const checked=await env.service.verify(env.first.id,received.id,{argv:['node','--check','app.js'],reviewed:true});assert.equal(checked.passed,true);assert.equal(checked.source,'local');
  const recovered=await env.service.recoverApplication(env.first.id,received.id);assert.equal(recovered.status,'recovered');assert.equal(existsContent(env.owner,'app.js'),dirty);assert.equal(existsContent(env.owner,'untracked.txt'),'untracked original\n');assert.equal(existsContent(env.owner,'new/created.txt'),null);assert.equal(existsContent(env.owner,'unrelated.txt'),'do not touch\n');
});

test('stale preview approval and stale patch application never overwrite changed files',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'original\n');const preview=env.service.prepare(env.first.id,env.conversation.id,{mode:'source',files:['app.js']});fs.writeFileSync(path.join(env.owner,'app.js'),'newer work\n');
  await assert.rejects(env.service.approve(env.first.id,env.conversation.id,{package:preview.package,approvedIntegrity:preview.package.integrity}),{status:409});
  const handoff=await request(env);const solution=returned(handoff,[{path:'app.js',baseHash:handoff.package.baseline[0].sha256,content:'friend change\n'}]);env.service.receiveSolution(env.first.id,solution);fs.writeFileSync(path.join(env.owner,'app.js'),'still newer work\n');
  assert.equal(env.service.previewSolution(env.first.id,solution.id).status,'stale');await assert.rejects(env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity}),{status:409});assert.equal(existsContent(env.owner,'app.js'),'still newer work\n');
});

test('rejects traversal, private paths, symlinks, oversized files and malformed public schemas',{skip:noSymlinks},async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'original');
  for(const relative of ['../x','/absolute','a/../../x','a\\x','a//x','.git/config','.env','.env.production','.data/a','.codex/auth.json','.claude/projects/a','key.pem','a/%2e%2e/x','C:/x'])assert.throws(()=>validateRelativePath(relative),{status:400});
  fs.symlinkSync(path.join(env.owner,'app.js'),path.join(env.owner,'link.js'));fs.symlinkSync(env.friend,path.join(env.owner,'outside'));fs.writeFileSync(path.join(env.owner,'binary.bin'),Buffer.from([0,1,2,3]));fs.writeFileSync(path.join(env.owner,'bad-utf8.txt'),Buffer.from([255]));fs.writeFileSync(path.join(env.owner,'big.txt'),'x'.repeat(MAX_FILE_BYTES+1));fs.writeFileSync(path.join(env.owner,'huge.bin'),Buffer.alloc(MAX_BINARY_BYTES+1));
  for(const file of ['binary.bin','bad-utf8.txt'])assert.equal(env.service.prepare(env.first.id,env.conversation.id,{mode:'source',files:[file]}).package.files[0].encoding,'base64');
  for(const file of ['link.js','outside/created.txt','huge.bin','big.txt'])assert.throws(()=>env.service.prepare(env.first.id,env.conversation.id,{mode:'source',files:[file]}),{status:400});
  const handoff=await request(env);const malformed={...handoff.package,projectId:env.first.id};assert.throws(()=>validatePublicPackage(malformed),/Unsupported field/);
  const solution=returned(handoff,[]);assert.throws(()=>validateSolution({...solution,integrity:'0'.repeat(64)}),/integrity/);
  assert.throws(()=>sealSolution({...solution,patch:{format:'unified-diff',files:[]}}),/Only ai-relay/);
  assert.throws(()=>sealSolution({...solution,patch:{format:'ai-relay.text.v1',files:[{path:'app.js',baseHash:handoff.package.baseline[0].sha256,content:'\u0000'}]}}),/text/);
  assert.throws(()=>sealPackage({...handoff.package,goal:'x'.repeat(2*1024*1024)}),/2 MiB/);
});

test('approval blocks likely source secrets; solution cannot add unapproved paths or change baseline hashes',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),`const token = "${'ghp_'+'x'.repeat(36)}";\n`);const preview=env.service.prepare(env.first.id,env.conversation.id,{mode:'source',files:['app.js']});assert(preview.warnings.some(w=>w.code==='credential'));
  await assert.rejects(env.service.approve(env.first.id,env.conversation.id,{package:preview.package,approvedIntegrity:preview.package.integrity}),/secrets/);
  fs.writeFileSync(path.join(env.owner,'app.js'),'original');const handoff=await request(env);
  const unapproved=returned(handoff,[{path:'other.js',baseHash:null,content:'new'}]);assert.throws(()=>env.service.receiveSolution(env.first.id,unapproved),/not approved/);
  const wrong=returned(handoff,[{path:'app.js',baseHash:sha256('wrong'),content:'new'}]);assert.throws(()=>env.service.receiveSolution(env.first.id,wrong),{status:409});
  const good=returned(handoff,[]);env.service.receiveSolution(env.first.id,good);const collision=sealSolution({...good,explanation:'Different bytes same ID'});assert.throws(()=>env.service.receiveSolution(env.first.id,collision),{status:409});
});

test('instructions-only solution remains reviewable and never interprets prose as a patch',async t=>{
  const env=setup(t);const preview=env.service.prepare(env.first.id,env.conversation.id,{goal:'Explain only.'});const handoff=await env.service.approve(env.first.id,env.conversation.id,{package:preview.package,approvedIntegrity:preview.package.integrity});
  const solution=returned(handoff,[],{explanation:'Run claude -p fix; this prose must never be executed.'});const record=env.service.receiveSolution(env.first.id,solution);assert.equal(env.service.previewSolution(env.first.id,record.id).status,'instructions');await assert.rejects(env.service.applySolution(env.first.id,record.id,{approvedIntegrity:solution.integrity}),/no applicable/);
});

test('safe recovery restores deletions and refuses to clobber newer local edits',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'original');fs.writeFileSync(path.join(env.owner,'delete.txt'),'deleted original');const handoff=await request(env,{files:['app.js','delete.txt']});const hash=new Map(handoff.package.baseline.map(f=>[f.path,f.sha256]));
  const solution=returned(handoff,[{path:'app.js',baseHash:hash.get('app.js'),content:'friend fix'},{path:'delete.txt',baseHash:hash.get('delete.txt'),content:null}]);env.service.receiveSolution(env.first.id,solution);await env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity});assert.equal(existsContent(env.owner,'delete.txt'),null);
  fs.writeFileSync(path.join(env.owner,'app.js'),'new local work after application');const result=await env.service.recoverApplication(env.first.id,solution.id);assert.equal(result.status,'recovery-conflict');assert.equal(existsContent(env.owner,'app.js'),'new local work after application');assert.equal(existsContent(env.owner,'delete.txt'),'deleted original');assert.equal(result.application.conflicts[0].path,'app.js');
});

test('interrupted application recovery infers writes even if completed metadata was not saved',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'original');const handoff=await request(env);const solution=returned(handoff,[{path:'app.js',baseHash:handoff.package.baseline[0].sha256,content:'friend fix'}]);env.service.receiveSolution(env.first.id,solution);await env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity});
  const filename=env.service.patches.filename(env.first.id,solution.id);const checkpoint=JSON.parse(fs.readFileSync(filename,'utf8'));checkpoint.status='applying';checkpoint.completed=[];atomicJSON(filename,checkpoint);
  const reopened=new CollaborationService({registry:env.registry,dataRoot:env.dataRoot});assert.equal(reopened.previewSolution(env.first.id,solution.id).status,'recovery-required');const recovered=await reopened.recoverApplication(env.first.id,solution.id);assert.equal(recovered.status,'recovered');assert.equal(existsContent(env.owner,'app.js'),'original');
});

test('application failure rolls back already-written affected files using a durable checkpoint',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'first original');fs.writeFileSync(path.join(env.owner,'second.txt'),'second original');const handoff=await request(env,{files:['app.js','second.txt']});const hashes=new Map(handoff.package.baseline.map(f=>[f.path,f.sha256]));const solution=returned(handoff,[{path:'app.js',baseHash:hashes.get('app.js'),content:'first new'},{path:'second.txt',baseHash:hashes.get('second.txt'),content:'second new'}]);env.service.receiveSolution(env.first.id,solution);
  const rename=fs.renameSync;const failedTarget=path.join(fs.realpathSync(env.owner),'second.txt');let injected=false;fs.renameSync=(from,to)=>{if(to===failedTarget&&!injected){injected=true;throw Object.assign(new Error('simulated disk write failure'),{code:'EIO'});}return rename(from,to);};
  try{await assert.rejects(env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity}),/Affected files were restored/);}finally{fs.renameSync=rename;}
  assert.equal(existsContent(env.owner,'app.js'),'first original');assert.equal(existsContent(env.owner,'second.txt'),'second original');assert.equal(env.service.patches.getApplication(env.first.id,solution.id).status,'rolled-back');
});

test('verification requires explicit reviewed safe argv and never executes imported or AI commands',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'export const answer = 42;\n');const handoff=await request(env);const solution=returned(handoff,[]);env.service.receiveSolution(env.first.id,solution);
  for(const argv of [['claude','-p','hello'],['codex','exec','hello'],['npm','test'],['node','-e','process.exit(0)'],['sh','-c','echo hi'],['node','--check','../outside.js']])await assert.rejects(env.service.verify(env.first.id,solution.id,{argv,reviewed:true}),{status:400});
  await assert.rejects(env.service.verify(env.first.id,solution.id,{argv:['node','--check','app.js'],reviewed:false}),/Explicitly review/);const result=await env.service.verify(env.first.id,solution.id,{argv:['node','--check','app.js'],reviewed:true});assert.equal(result.passed,true);assert.equal(env.service.getSolution(env.first.id,solution.id).verification.length,1);
});

test('symlink introduced after approval is stale, and tampered recovery paths are rejected',{skip:noSymlinks},async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'original');const handoff=await request(env);const solution=returned(handoff,[{path:'app.js',baseHash:handoff.package.baseline[0].sha256,content:'friend fix'}]);env.service.receiveSolution(env.first.id,solution);fs.writeFileSync(path.join(env.friend,'outside.js'),'outside original');fs.unlinkSync(path.join(env.owner,'app.js'));fs.symlinkSync(path.join(env.friend,'outside.js'),path.join(env.owner,'app.js'));
  assert.equal(env.service.previewSolution(env.first.id,solution.id).status,'stale');await assert.rejects(env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity}),{status:409});assert.equal(existsContent(env.friend,'outside.js'),'outside original');
  const filename=env.service.patches.filename(env.first.id,solution.id);atomicJSON(filename,{schema:'ai-relay.recovery',version:1,projectId:env.first.id,solutionId:solution.id,operations:[{path:'../outside.js',before:{content:null,sha256:null},after:{content:'bad',sha256:sha256('bad')}}]});await assert.rejects(env.service.recoverApplication(env.first.id,solution.id),{status:400});
});

test('git whitespace verification disables configured clean and process filters',async t=>{
  const env=setup(t,{git:true});fs.writeFileSync(path.join(env.owner,'app.js'),'export const n = 1;\n');execFileSync(gitExecutable(),['add','app.js'],{cwd:env.owner});const handoff=await request(env);const solution=returned(handoff,[]);env.service.receiveSolution(env.first.id,solution);
  const sentinel=path.join(env.root,'filter-executed');const script=path.join(env.root,'bad-filter.cjs');fs.writeFileSync(script,'require("node:fs").writeFileSync('+JSON.stringify(sentinel)+',"should never run")');
  execFileSync(gitExecutable(),['config','filter.evil.clean',process.execPath+' '+script],{cwd:env.owner});execFileSync(gitExecutable(),['config','filter.evil.process',process.execPath+' '+script],{cwd:env.owner});fs.writeFileSync(path.join(env.owner,'.gitattributes'),'app.js filter=evil\n');fs.writeFileSync(path.join(env.owner,'app.js'),'export const n = 2;  \n');
  const result=await env.service.verify(env.first.id,solution.id,{argv:['git','diff','--check'],reviewed:true});assert.equal(result.passed,false);assert.equal(fs.existsSync(sentinel),false);assert.match(result.stdout+result.stderr,/trailing whitespace/);
});

// Binary files (#25).
const png=(...body)=>Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,...body]);
const base64=bytes=>Buffer.from(bytes).toString('base64');
function returnedFiles(handoff,files){return returned(handoff,files,{patch:{format:'ai-relay.files.v1',files}});}

test('binary files round trip: shared, returned, previewed, applied and recovered byte for byte',async t=>{
  const env=setup(t);const logo=png(1,2,3,255,0,7);const icon=png(9,9,0,9);const friendLogo=png(4,5,6,0,0,1,2);
  fs.writeFileSync(path.join(env.owner,'app.js'),'export const logo = "logo.png";\n');fs.writeFileSync(path.join(env.owner,'logo.png'),logo);
  const handoff=await request(env,{files:['app.js','logo.png'],newPaths:['assets/icon.png']});
  const shared=handoff.package.files.find(file=>file.path==='logo.png');
  assert.equal(shared.encoding,'base64');assert.equal(shared.content,base64(logo));assert.equal(shared.sha256,createHash('sha256').update(logo).digest('hex'));
  assert.equal(handoff.package.files.find(file=>file.path==='app.js').encoding,undefined);
  assert.equal(handoff.package.inventory.files.find(file=>file.path==='logo.png').bytes,logo.length);
  const imported=await env.service.importRequest(env.second.id,handoff.package);
  const note=env.registry.broker(env.second.id).get(imported.conversationId).messages.at(-1).text;
  assert(!note.includes(base64(logo)));assert.match(note,/binary file, not shown/);
  fs.writeFileSync(path.join(env.friend,'app.js'),'export const logo = "assets/icon.png";\n');fs.writeFileSync(path.join(env.friend,'logo.png'),friendLogo);fs.mkdirSync(path.join(env.friend,'assets'));fs.writeFileSync(path.join(env.friend,'assets/icon.png'),icon);
  assert.equal(env.service.buildSolution(env.second.id,handoff.id,{files:['app.js'],explanation:'Text only.'}).patch.format,'ai-relay.text.v1');
  const solution=env.service.buildSolution(env.second.id,handoff.id,{files:['app.js','logo.png','assets/icon.png'],explanation:'New logo and icon.'});
  assert.equal(solution.patch.format,'ai-relay.files.v1');assert.equal(solution.patch.files.find(file=>file.path==='app.js').encoding,undefined);
  const received=env.service.receiveSolution(env.first.id,solution);const preview=env.service.previewSolution(env.first.id,received.id);
  assert.equal(preview.status,'applicable');
  const changed=preview.files.find(file=>file.path==='logo.png');assert.equal(changed.diff,'');assert.equal(changed.before,null);
  assert.equal(changed.binary.before.kind,'PNG image');assert.equal(changed.binary.before.bytes,logo.length);assert.equal(changed.binary.before.image,'data:image/png;base64,'+base64(logo));
  assert.equal(changed.binary.after.sha256,sha256(new Uint8Array(friendLogo)));assert.equal(changed.binary.after.program,undefined);
  const created=preview.files.find(file=>file.path==='assets/icon.png');assert.equal(created.operation,'create');assert.equal(created.binary.before,null);
  assert.match(preview.files.find(file=>file.path==='app.js').diff,/assets\/icon\.png/);
  await env.service.applySolution(env.first.id,received.id,{approvedIntegrity:solution.integrity});
  assert(fs.readFileSync(path.join(env.owner,'logo.png')).equals(friendLogo));assert(fs.readFileSync(path.join(env.owner,'assets/icon.png')).equals(icon));
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(env.owner,'assets/icon.png')).mode&0o777,0o644);
  const reopened=new CollaborationService({registry:env.registry,dataRoot:env.dataRoot});
  assert.equal((await reopened.recoverApplication(env.first.id,received.id)).status,'recovered');
  assert(fs.readFileSync(path.join(env.owner,'logo.png')).equals(logo));assert.equal(fs.existsSync(path.join(env.owner,'assets/icon.png')),false);
  assert.equal(existsContent(env.owner,'app.js'),'export const logo = "logo.png";\n');
});

test('a binary file changed after a request is stale, and recovery keeps newer binary edits',async t=>{
  const env=setup(t);const logo=png(1,0);fs.writeFileSync(path.join(env.owner,'logo.png'),logo);
  const handoff=await request(env,{files:['logo.png']});const base=handoff.package.baseline[0].sha256;
  const solution=returnedFiles(handoff,[{path:'logo.png',baseHash:base,content:base64(png(2,0)),encoding:'base64'}]);env.service.receiveSolution(env.first.id,solution);
  fs.writeFileSync(path.join(env.owner,'logo.png'),png(3,0));
  assert.equal(env.service.previewSolution(env.first.id,solution.id).status,'stale');await assert.rejects(env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity}),{status:409});
  assert(fs.readFileSync(path.join(env.owner,'logo.png')).equals(png(3,0)));
  fs.writeFileSync(path.join(env.owner,'logo.png'),logo);await env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity});
  fs.writeFileSync(path.join(env.owner,'logo.png'),png(4,0));
  const result=await env.service.recoverApplication(env.first.id,solution.id);assert.equal(result.status,'recovery-conflict');assert(fs.readFileSync(path.join(env.owner,'logo.png')).equals(png(4,0)));
});

test('binary content must be real binary, standard base64, within 1 MiB and in the files format',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'original');fs.writeFileSync(path.join(env.owner,'logo.png'),png(1,0));
  const handoff=await request(env,{files:['app.js','logo.png']});const hash=new Map(handoff.package.baseline.map(file=>[file.path,file.sha256]));
  // Text sent as base64 would have no diff to review, so it could hide a change.
  assert.throws(()=>returnedFiles(handoff,[{path:'app.js',baseHash:hash.get('app.js'),content:base64(Buffer.from('steal()')),encoding:'base64'}]),/sent as text/);
  assert.throws(()=>returned(handoff,[{path:'logo.png',baseHash:hash.get('logo.png'),content:base64(png(2,0)),encoding:'base64'}]),/files\.v1/);
  assert.throws(()=>returnedFiles(handoff,[{path:'logo.png',baseHash:hash.get('logo.png'),content:'AAF=',encoding:'base64'}]),/standard base64/);
  assert.throws(()=>returnedFiles(handoff,[{path:'logo.png',baseHash:hash.get('logo.png'),content:'not base64!',encoding:'base64'}]),/standard base64/);
  assert.throws(()=>returnedFiles(handoff,[{path:'logo.png',baseHash:hash.get('logo.png'),content:'0001',encoding:'hex'}]),/Unsupported file encoding/);
  assert.throws(()=>returnedFiles(handoff,[{path:'logo.png',baseHash:hash.get('logo.png'),content:null,encoding:'base64'}]),/files\.v1|base64/);
  assert.throws(()=>validateSolution({...returnedFiles(handoff,[]),patch:{format:'ai-relay.files.v1',files:[{path:'logo.png',baseHash:hash.get('logo.png'),content:base64(Buffer.alloc(MAX_BINARY_BYTES+1)),encoding:'base64'}]}}),/1 MiB|2 MiB/);
  const altered=structuredClone(handoff.package);altered.files.find(file=>file.path==='logo.png').content=base64(png(9,0));assert.throws(()=>validatePublicPackage(altered),/hash|inventory|integrity/);
  // A tampered recovery checkpoint can't smuggle text in as base64 either.
  const good=returnedFiles(handoff,[{path:'logo.png',baseHash:hash.get('logo.png'),content:base64(png(2,0)),encoding:'base64'}]);env.service.receiveSolution(env.first.id,good);await env.service.applySolution(env.first.id,good.id,{approvedIntegrity:good.integrity});
  const filename=env.service.patches.filename(env.first.id,good.id),checkpoint=JSON.parse(fs.readFileSync(filename,'utf8'));
  checkpoint.operations[0].before={content:base64(Buffer.from('text')),encoding:'base64',sha256:sha256('text')};atomicJSON(filename,checkpoint);
  await assert.rejects(env.service.recoverApplication(env.first.id,good.id),/Invalid recovery snapshot/);
});

test('secret scanning reads the strings inside a binary file, not its base64',()=>{
  const token='ghp_'+'x'.repeat(36);
  const leaking={files:[{path:'cache.bin',encoding:'base64',content:base64(Buffer.concat([Buffer.from([0,1]),Buffer.from('token='+token),Buffer.from([0])])),sha256:'0'.repeat(64)}]};
  assert(scanSecrets(leaking).some(warning=>warning.code==='credential'&&warning.location==='files[0].content'));
  // Base64 that only looks like a key is not a finding.
  const lookalike=Buffer.concat([Buffer.from([0]),Buffer.from('AIza'+'A'.repeat(35),'base64')]);
  assert.equal(scanSecrets({files:[{path:'a.bin',encoding:'base64',content:base64(lookalike),sha256:'0'.repeat(64)}]}).length,0);
});

test('the review flags a program, and a code file whose new version is binary shows its readable text',async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'export const safe = true;\n');
  const handoff=await request(env,{files:['app.js'],newPaths:['bin/tool']});const hash=new Map(handoff.package.baseline.map(file=>[file.path,file.sha256]));
  const hidden=Buffer.concat([Buffer.from('export const safe = true;\n// '),Buffer.from([0]),Buffer.from('\nsteal();\n')]);
  const solution=returnedFiles(handoff,[{path:'app.js',baseHash:hash.get('app.js'),content:base64(hidden),encoding:'base64'},{path:'bin/tool',baseHash:null,content:base64(Buffer.from([0x7f,0x45,0x4c,0x46,2,1,1,0])),encoding:'base64'}]);
  env.service.receiveSolution(env.first.id,solution);const preview=env.service.previewSolution(env.first.id,solution.id);
  const code=preview.files.find(file=>file.path==='app.js');assert.equal(code.binary.before.kind,'Text');assert.equal(code.binary.after.textName,true);assert.match(code.binary.after.readable,/steal\(\)/);assert.match(code.binary.after.readable,/\u2400/);
  const tool=preview.files.find(file=>file.path==='bin/tool');assert.equal(tool.binary.after.kind,'Linux program');assert.equal(tool.binary.after.program,true);assert.equal(tool.binary.after.readable,undefined);
});

// #10: the project's own tests on an applied patch.
async function appliedFix(env,files=[['app.js','broken\n','fixed\n']]) {
  for(const [name,before] of files){fs.mkdirSync(path.dirname(path.join(env.owner,name)),{recursive:true});fs.writeFileSync(path.join(env.owner,name),before);}
  const handoff=await request(env,{files:files.map(([name])=>name)}),hash=new Map(handoff.package.baseline.map(file=>[file.path,file.sha256]));
  const solution=returned(handoff,files.map(([name,,after])=>({path:name,baseHash:hash.get(name),content:after})));env.service.receiveSolution(env.first.id,solution);
  return solution;
}
const until=async(check,ms=5000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('Timed out.');await new Promise(resolve=>setTimeout(resolve,20));}};

test('tests run only the command marked in Run, after the patch is applied and the exact command is confirmed',async t=>{
  const env=setup(t),commands=new ProjectCommands({registry:env.registry,stopGrace:20});t.after(()=>commands.close());
  const solution=await appliedFix(env);
  assert.equal(env.service.testPlan(env.first.id,solution.id).status,'not-applied');
  await env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity});
  let plan=env.service.testPlan(env.first.id,solution.id);assert.equal(plan.status,'no-command');assert.equal(plan.command,null);
  await assert.rejects(env.service.runTests(env.first.id,solution.id,{reviewed:true,command:{}}),{status:404});
  const folderId=env.registry.get(env.first.id).folders[0].id;
  commands.save(env.first.id,{name:'Test',folderId,command:'grep -q fixed app.js',test:true});
  plan=env.service.testPlan(env.first.id,solution.id);assert.equal(plan.status,'ready');assert.equal(plan.command.command,'grep -q fixed app.js');assert.equal(plan.covers,true);assert.deepEqual(plan.files,[{path:'app.js',reason:'named in the Test command'}]);assert(!('folderPath' in plan.command));
  const {id,command,directory}=plan.command;
  await assert.rejects(env.service.runTests(env.first.id,solution.id,{command:{id,command,folderId,directory}}),/Review the Test command/);
  await assert.rejects(env.service.runTests(env.first.id,solution.id,{reviewed:true,command:{id,command:'rm -rf .',folderId,directory}}),{status:409});
  const started=await env.service.runTests(env.first.id,solution.id,{reviewed:true,command:{id,command,folderId,directory}});assert.equal(started.status,'running');
  await assert.rejects(env.service.runTests(env.first.id,solution.id,{reviewed:true,command:{id,command,folderId,directory}}),/already running/);
  assert.equal(commands.state(env.first.id).sessions[id].command,'grep -q fixed app.js','it runs as the Run panel’s own Test session');
  await env.service.testing.get(solution.id).finished;
  const record=env.service.getSolution(env.first.id,solution.id),result=record.verification.at(-1);
  assert.equal(result.source,'tests');assert.equal(result.status,'passed');assert.equal(result.passed,true);assert.equal(result.exitCode,0);assert.equal(result.command,'grep -q fixed app.js');
  assert.equal(env.service.testPlan(env.first.id,solution.id).results.length,1);
  const notes=env.broker.get(env.conversation.id).messages.filter(message=>message.role==='system').map(message=>message.text);
  assert.match(notes.at(-1),/^Tests on friend solution .*: grep -q fixed app\.js passed in \d+s\. No AI was used\.$/);
});

test('failing tests keep the patch and its recovery checkpoint, and stopping is recorded as stopped',async t=>{
  const env=setup(t),commands=new ProjectCommands({registry:env.registry,stopGrace:20});t.after(()=>commands.close());
  const solution=await appliedFix(env);await env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity});
  const folderId=env.registry.get(env.first.id).folders[0].id,saved=commands.save(env.first.id,{name:'Test',folderId,command:'echo nope; exit 3',test:true});
  const confirm={reviewed:true,command:{id:saved.id,command:saved.command,folderId,directory:''}};
  await env.service.runTests(env.first.id,solution.id,confirm);await env.service.testing.get(solution.id).finished;
  let result=env.service.getSolution(env.first.id,solution.id).verification.at(-1);
  assert.equal(result.status,'failed');assert.equal(result.exitCode,3);assert.match(result.output,/nope/);
  assert.equal(existsContent(env.owner,'app.js'),'fixed\n','nothing is undone on its own');assert.equal(env.service.getSolution(env.first.id,solution.id).status,'applied');
  assert.match(env.broker.get(env.conversation.id).messages.at(-1).text,/failed \(exit code 3\).*can be undone/);
  commands.save(env.first.id,{id:saved.id,name:'Test',folderId,command:'sleep 30',test:true});
  await env.service.runTests(env.first.id,solution.id,{...confirm,command:{...confirm.command,command:'sleep 30'}});
  await until(()=>commands.state(env.first.id).sessions[saved.id]?.status==='running');
  const after=await env.service.stopTests(env.first.id,solution.id);assert.equal(after.status,'ready');
  result=after.results.at(-1);assert.equal(result.status,'stopped');assert.equal(result.passed,false);
  const undone=await env.service.recoverApplication(env.first.id,solution.id);assert.equal(undone.status,'recovered');assert.equal(existsContent(env.owner,'app.js'),'broken\n');
  assert.equal(env.service.testPlan(env.first.id,solution.id).status,'not-applied');
});

test('the confirmation names patched files that decide what the tests run',async t=>{
  const env=setup(t),commands=new ProjectCommands({registry:env.registry,stopGrace:20});t.after(()=>commands.close());
  const solution=await appliedFix(env,[['app.js','a\n','b\n'],['package.json','{}\n','{"scripts":{"test":"curl x"}}\n'],['test/app.test.js','old\n','new\n'],['vitest.config.mjs','x\n','y\n'],['scripts/check.sh','x\n','y\n'],['README.md','x\n','y\n']]);
  await env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity});
  commands.save(env.first.id,{name:'Test',folderId:env.registry.get(env.first.id).folders[0].id,command:'sh scripts/check.sh && npm test',test:true});
  assert.deepEqual(env.service.testPlan(env.first.id,solution.id).files,[
    {path:'package.json',reason:'decides what the command runs'},{path:'test/app.test.js',reason:'a test file'},{path:'vitest.config.mjs',reason:'test or build settings'},{path:'scripts/check.sh',reason:'named in the Test command'}]);
  for(const [file,reason] of [['src/foo.spec.ts','a test file'],['pkg/thing_test.go','a test file'],['tests/test_api.py','a test file'],['conftest.py','test or build settings'],['Makefile','decides what the command runs'],['src/app.js',null],['src/testing.js',null],['latest/notes.md',null]])assert.equal(testInputs(file),reason,file);
  assert.equal(testInputs('check.sh','./check.sh --fast'),'named in the Test command');assert.equal(testInputs('check.sh','./recheck.sh'),null);
});

test('a Test command in another folder is flagged as not covering the patch',async t=>{
  const env=setup(t),commands=new ProjectCommands({registry:env.registry,stopGrace:20});t.after(()=>commands.close());
  const solution=await appliedFix(env,[['app.js','a\n','b\n']]);
  await env.service.applySolution(env.first.id,solution.id,{approvedIntegrity:solution.integrity});
  const elsewhere=fs.mkdtempSync(path.join(env.root,'tests-'));env.registry.addFolder(env.first.id,{path:elsewhere});
  const folders=env.registry.get(env.first.id).folders;assert.equal(folders.length,2);
  commands.save(env.first.id,{name:'Test',folderId:folders[1].id,command:'true',test:true});
  const plan=env.service.testPlan(env.first.id,solution.id);assert.equal(plan.covers,false);assert.equal(plan.elsewhere.length,1);
});

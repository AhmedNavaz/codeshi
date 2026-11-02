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
import { CollaborationService } from '../src/collaboration.mjs';
import { atomicJSON } from '../src/patches.mjs';
import { readWorkspaceFile } from '../src/workspace-files.mjs';
import { sha256,canonicalStringify,sealPackage,sealSolution,validatePublicPackage,validateSolution,validateRelativePath,scanSecrets,MAX_FILE_BYTES } from '../src/collaboration-format.mjs';

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

test('rejects traversal, private paths, symlinks, binary, oversized files and malformed public schemas',{skip:noSymlinks},async t=>{
  const env=setup(t);fs.writeFileSync(path.join(env.owner,'app.js'),'original');
  for(const relative of ['../x','/absolute','a/../../x','a\\x','a//x','.git/config','.env','.env.production','.data/a','.codex/auth.json','.claude/projects/a','key.pem','a/%2e%2e/x','C:/x'])assert.throws(()=>validateRelativePath(relative),{status:400});
  fs.symlinkSync(path.join(env.owner,'app.js'),path.join(env.owner,'link.js'));fs.symlinkSync(env.friend,path.join(env.owner,'outside'));fs.writeFileSync(path.join(env.owner,'binary.bin'),Buffer.from([0,1,2,3]));fs.writeFileSync(path.join(env.owner,'bad-utf8.txt'),Buffer.from([255]));fs.writeFileSync(path.join(env.owner,'big.txt'),'x'.repeat(MAX_FILE_BYTES+1));
  for(const file of ['link.js','outside/created.txt','binary.bin','bad-utf8.txt','big.txt'])assert.throws(()=>env.service.prepare(env.first.id,env.conversation.id,{mode:'source',files:[file]}),{status:400});
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

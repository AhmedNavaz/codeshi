import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createRelayServer} from '../src/server.mjs';
import {gitExecutable} from '../src/resolve-binary.mjs';
import {createSharingServer} from '../sharing/server.mjs';
import {sealSolution} from '../src/collaboration-format.mjs';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function json(url,method='GET',value){const response=await fetch(url,{method,headers:{'X-AI-Relay':'1',...(value?{'Content-Type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{})});const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error),{status:response.status});return data;}
function git(cwd,...args){const r=spawnSync(gitExecutable(),args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}

test('HTTP acceptance: both providers unavailable, private friend patch reviewed/applied/verified with zero inference and dirty work preserved',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-acceptance-')),workspace=path.join(root,'owner'),friendspace=path.join(root,'friend');fs.mkdirSync(workspace);fs.mkdirSync(friendspace);
 const sharing=createSharingServer({dataDir:path.join(root,'remote')});const sharingURL=await listen(sharing.server);
 const apps=[];let calls=0;
 t.after(async()=>{for(const a of apps)await a.close();await new Promise(r=>sharing.server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 async function launch(space,name){const app=createRelayServer({workspace:space,dataRoot:path.join(root,name),sharingURL,bins:{codex:'/not-installed/codex',claude:'/not-installed/claude'}});apps.push(app);const original=app.registry.broker.bind(app.registry);app.registry.broker=id=>{const b=original(id);b.start=()=>{calls++;throw Error('MODEL BOUNDARY MUST NOT BE CALLED');};return b;};const base=await listen(app.server),projectId=app.registry.list()[0].id;const local=(route,method='GET',value)=>json(base+route+(route.includes('?')?'&':'?')+'projectId='+projectId,method,value);return {app,base,projectId,local};}
 git(workspace,'init','-q');git(workspace,'config','user.name','Relay test');git(workspace,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(workspace,'main.js'),'export const value = 1;\n');git(workspace,'add','main.js');git(workspace,'commit','-qm','fixture');fs.writeFileSync(path.join(workspace,'main.js'),'export const value = 2; // staged user edit\n');git(workspace,'add','main.js');fs.appendFileSync(path.join(workspace,'main.js'),'// unstaged user note\n');fs.writeFileSync(path.join(workspace,'helper.js'),'export const helper = true; // untracked\n');fs.writeFileSync(path.join(workspace,'unrelated.txt'),'keep this user work\n');
 const indexBefore=git(workspace,'show',':main.js'),baseline=fs.readFileSync(path.join(workspace,'main.js'),'utf8');
 const owner=await launch(workspace,'owner-data'),friend=await launch(friendspace,'friend-data');
 const status=await owner.local('/api/status');assert.equal(status.providers.codex.available,false);assert.equal(status.providers.claude.available,false);
 const conversation=await owner.local('/api/conversations','POST',{});
 const prepared=await owner.local('/api/collaboration/handoffs/prepare','POST',{conversationId:conversation.id,mode:'source',goal:'Fix value while preserving notes',problem:'Wrong value',expectedOutcome:'Value is 3',files:['main.js','helper.js'],newPaths:[],messageIds:[],decisions:[],tasks:[]});
 assert.equal(prepared.package.files[0].content,baseline);assert.equal(JSON.stringify(prepared.package).includes(workspace),false);
 const approved=await owner.local('/api/collaboration/handoffs/approve','POST',{conversationId:conversation.id,package:prepared.package,approvedIntegrity:prepared.package.integrity});
 const delivery=await owner.local(`/api/collaboration/handoffs/${approved.id}/publish`,'POST',{});assert.equal(delivery.localOnly,true);assert.equal(delivery.ownerToken,undefined);
 const link=new URL(delivery.viewURL),caps=new URLSearchParams(link.hash.slice(1)),remoteId=link.pathname.split('/').pop();
 const exported=await fetch(sharingURL+`/api/requests/${remoteId}/package`,{headers:{Authorization:'Bearer '+caps.get('view')}}).then(r=>r.json());
 const imported=await friend.local('/api/collaboration/handoffs/import','POST',{package:exported});assert.ok(imported.conversationId);assert.equal(fs.existsSync(path.join(friendspace,'main.js')),false);await assert.rejects(friend.local(`/api/collaboration/handoffs/${approved.id}/publish`,'POST',{}),e=>e.status===409);
 fs.writeFileSync(path.join(friendspace,'main.js'),baseline.replace('value = 2','value = 3'));fs.writeFileSync(path.join(friendspace,'helper.js'),exported.files.find(f=>f.path==='helper.js').content);
 const solution=await friend.local(`/api/collaboration/handoffs/${approved.id}/build`,'POST',{files:['main.js'],deletedPaths:[],explanation:'Update value, preserve both user notes.',assumptions:[],verification:['Contributor inspected the small diff.']});
 const rejectedSolution=sealSolution({...solution,id:crypto.randomUUID(),patch:{format:solution.patch.format,files:solution.patch.files.map(f=>({...f,baseHash:'f'.repeat(64)}))}});
 const rejectedUpload=await fetch(sharingURL+`/api/requests/${remoteId}/solutions`,{method:'POST',headers:{Authorization:'Bearer '+caps.get('submit'),'Content-Type':'application/json'},body:JSON.stringify(rejectedSolution)});assert.equal(rejectedUpload.status,201);
 const submit=await fetch(sharingURL+`/api/requests/${remoteId}/solutions`,{method:'POST',headers:{Authorization:'Bearer '+caps.get('submit'),'Content-Type':'application/json'},body:JSON.stringify(solution)});assert.equal(submit.status,201);
 const retrieval=await owner.local(`/api/collaboration/handoffs/${approved.id}/retrieve`,'POST',{});assert.equal(retrieval.rejected.length,1);assert.equal(retrieval.solutions.length,1);await owner.local(`/api/collaboration/handoffs/${approved.id}/retrieve`,'POST',{});
 assert.equal((await owner.local('/api/collaboration/solutions')).length,1);
 const preview=await owner.local(`/api/collaboration/solutions/${solution.id}/preview`);assert.equal(preview.status,'applicable');assert.match(preview.files[0].diff,/value = 3/);
 const applied=await owner.local(`/api/collaboration/solutions/${solution.id}/apply`,'POST',{approvedIntegrity:solution.integrity});assert.equal(applied.status,'applied');
 const duplicate=await owner.local(`/api/collaboration/solutions/${solution.id}/apply`,'POST',{approvedIntegrity:solution.integrity});assert.equal(duplicate.application.createdAt,applied.application.createdAt);
 const verified=await owner.local(`/api/collaboration/solutions/${solution.id}/verify`,'POST',{argv:['node','--check','main.js'],reviewed:true});assert.equal(verified.passed,true);
 assert.equal(git(workspace,'show',':main.js'),indexBefore);assert.equal(fs.readFileSync(path.join(workspace,'helper.js'),'utf8'),exported.files.find(f=>f.path==='helper.js').content);assert.equal(fs.readFileSync(path.join(workspace,'unrelated.txt'),'utf8'),'keep this user work\n');
 await owner.local(`/api/collaboration/solutions/${solution.id}/recover`,'POST',{});assert.equal(fs.readFileSync(path.join(workspace,'main.js'),'utf8'),baseline);
 const stale=sealSolution({...solution,id:crypto.randomUUID()});await owner.local('/api/collaboration/solutions/receive','POST',{solution:stale});fs.appendFileSync(path.join(workspace,'main.js'),'// newer work\n');
 const conflict=await owner.local(`/api/collaboration/solutions/${stale.id}/preview`);assert.equal(conflict.status,'stale');await assert.rejects(owner.local(`/api/collaboration/solutions/${stale.id}/apply`,'POST',{approvedIntegrity:stale.integrity}),e=>e.status===409);assert.match(fs.readFileSync(path.join(workspace,'main.js'),'utf8'),/newer work/);
 await owner.local(`/api/collaboration/handoffs/${approved.id}/revoke`,'POST',{});const revoked=await fetch(sharingURL+`/api/requests/${remoteId}/package`,{headers:{Authorization:'Bearer '+caps.get('view')}});assert.equal(revoked.status,410);
 const history=await owner.local('/api/conversations/'+conversation.id);assert.ok(history.messages.some(m=>/Friend solution received/.test(m.text)));assert.ok(history.messages.some(m=>/Local verification/.test(m.text)));assert.equal(calls,0);
});

test('desktop session token protects local APIs while keeping static UI loadable',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-session-'));const app=createRelayServer({dataRoot:root,accessToken:'secret-desktop-fixture'});const base=await listen(app.server);t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 assert.equal((await fetch(base)).status,200);assert.equal((await fetch(base+'/api/projects')).status,403);
 // The logo and favicons load like the rest of the page, PNGs as images.
 for(const [file,type] of [['/icon.svg','image/svg+xml'],['/logo.svg','image/svg+xml'],['/mark.svg','image/svg+xml'],['/icon-16.png','image/png'],['/icon-32.png','image/png'],['/icon-180.png','image/png'],['/icon-512.png','image/png']]){const response=await fetch(base+file);assert.equal(response.status,200,file);assert.equal(response.headers.get('content-type'),type,file);if(type==='image/png')assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(1,4)],[80,78,71],file);}assert.equal((await fetch(base+'/api/projects',{headers:{'X-AI-Relay-Token':'secret-desktop-fixture'}})).status,200);
});

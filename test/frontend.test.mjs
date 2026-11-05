import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import test from 'node:test';
import { sealPackage } from '../src/collaboration-format.mjs';
import { exportConversation } from '../src/conversation-export.mjs';
import { preferencePatch, publicPreferences } from '../src/preferences.mjs';

// Minimal DOM/event adapter for executing the actual browser scripts. It does
// not pretend to verify layout, CSS, native dialogs, or browser accessibility.
class Events {
  constructor(){this.listeners=new Map();}
  addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list);}
  dispatchEvent(event){event.target ||= this;for(const fn of this.listeners.get(event.type)||[])fn(event);return !event.defaultPrevented;}
}
// Reads a pasted or dropped file as the browser does, for the composer's paste and drop handlers.
class FileReader {
  readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result='data:'+blob.type+';base64,'+Buffer.from(bytes).toString('base64');this.onload();},()=>this.onerror());}
}
class UIEvent {
  constructor(type,properties={}){this.type=type;this.defaultPrevented=false;Object.assign(this,properties);}
  preventDefault(){this.defaultPrevented=true;}
}
class Element extends Events {
  constructor(tag,document){super();this.tagName=tag.toUpperCase();this.document=document;this.childNodes=[];this.parentNode=null;this.attributes={};this.dataset={};this.style={setProperty(name,value){this[name]=String(value);},removeProperty(name){delete this[name];}};this.className='';this.id='';this.value='';this.disabled=false;this.hidden=false;this.checked=false;this.open=false;this.scrollTop=0;this.scrollHeight=100;this.clientHeight=500;this.classList={contains:name=>this.className.split(/\s+/).includes(name),add:name=>this.classList.toggle(name,true),remove:name=>this.classList.toggle(name,false),toggle:(name,on)=>{const set=new Set(this.className.split(/\s+/).filter(Boolean));if(on===undefined)on=!set.has(name);if(on)set.add(name);else set.delete(name);this.className=[...set].join(' ');return on;}};}
  get isConnected(){for(let current=this;current;current=current.parentNode)if(current===this.document.body)return true;return false;}
  get nodeType(){return this.tagName==='#TEXT'?3:1;}
  get children(){return this.childNodes.filter(child=>child.tagName!=='#TEXT');}
  get firstChild(){return this.childNodes[0]||null;}get lastChild(){return this.childNodes.at(-1)||null;}get firstElementChild(){return this.children[0]||null;}get lastElementChild(){return this.children.at(-1)||null;}
  get textContent(){return this.tagName==='#TEXT'?this.data:this.childNodes.map(child=>child.textContent).join('');}
  set textContent(value){if(this.tagName==='#TEXT')this.data=String(value);else this.replaceChildren(this.document.createTextNode(String(value)));}
  set innerHTML(_){throw new Error('Untrusted innerHTML is forbidden by this test DOM.');}
  append(...nodes){for(let child of nodes){if(typeof child==='string')child=this.document.createTextNode(child);if(child.tagName==='#FRAGMENT'){this.append(...[...child.childNodes]);continue;}child.remove();child.parentNode=this;this.childNodes.push(child);if(this.tagName==='SELECT'&&child.tagName==='OPTION'&&!this.value)this.value=child.value||child.textContent;}}
  prepend(child){child.remove();child.parentNode=this;this.childNodes.unshift(child);}
  insertBefore(child,reference){child.remove();child.parentNode=this;const index=this.childNodes.indexOf(reference);this.childNodes.splice(index<0?this.childNodes.length:index,0,child);return child;}
  replaceChildren(...nodes){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];this.append(...nodes);}
  replaceWith(node){const parent=this.parentNode;if(!parent)return;parent.insertBefore(node,this);this.remove();}
  remove(){if(this.parentNode){this.parentNode.childNodes=this.parentNode.childNodes.filter(child=>child!==this);this.parentNode=null;}}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='id')this.id=String(value);if(key==='class')this.className=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5)]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}removeAttribute(key){delete this.attributes[key];}
  matches(selector){if(selector===':popover-open')return this.popoverOpen===true;if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));const attr=selector.match(/^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/);if(attr)return (!attr[1]||this.tagName===attr[1].toUpperCase())&&(attr[2]==='open'?this.open:attr[3]===undefined?this.getAttribute(attr[2])!==null:this.getAttribute(attr[2])===attr[3]);return this.tagName===selector.toUpperCase();}
  querySelectorAll(selector){const found=[];for(const child of this.children){if(child.matches(selector))found.push(child);found.push(...child.querySelectorAll(selector));}return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){for(let current=this;current;current=current.parentNode)if(current.matches(selector))return current;return selector==='.sidebar'?this.document.sidebar:null;}
  getBoundingClientRect(){return this.bounds || {left:40,top:750,right:240,bottom:774,width:200,height:24};}
  showPopover(){this.popoverOpen=true;this.dispatchEvent(new UIEvent('toggle',{newState:'open'}));}
  hidePopover(){this.popoverOpen=false;this.dispatchEvent(new UIEvent('toggle',{newState:'closed'}));}
  focus(){this.document.activeElement=this;}select(){}click(){if(!this.disabled)this.dispatchEvent(new UIEvent('click'));}showModal(){this.open=true;}close(){if(this.open){this.open=false;this.dispatchEvent(new UIEvent('close'));}}
}
function documentFixture(){
  const document=new Events();document.hidden=false;document.createElement=tag=>new Element(tag,document);document.createTextNode=text=>{const node=new Element('#text',document);node.data=String(text);return node;};document.createDocumentFragment=()=>new Element('#fragment',document);
  const root=document.createElement('document');document.body=root;document.querySelectorAll=selector=>root.querySelectorAll(selector);document.querySelector=selector=>root.querySelector(selector);document.getElementById=id=>root.querySelector('#'+id);document.sidebar=document.createElement('aside');document.sidebar.className='sidebar';root.append(document.sidebar);
  // IDs/tags come from the shipped page. Only the small static child structure
  // accessed by app.js is needed; workbench elements are created by real JS.
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');for(const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const node=document.createElement(match[1]);node.id=match[2];if(/\bhidden(?:\s|>|=)/.test(match[0]))node.hidden=true;root.append(node);}
  for(const match of html.matchAll(/<button\b[^>]*data-import-(provider|scope)="([^"]+)"[^>]*>/g)){const button=document.createElement('button');button.setAttribute('data-import-'+match[1],match[2]);button.dataset[match[1]==='scope'?'importScope':'importProvider']=match[2];root.append(button);}
  // theme.js sets the palette on <html> and the theme-color meta. The element records every palette it is given.
  const page=document.createElement('html');page.palettes=[];const setPageAttribute=page.setAttribute.bind(page);page.setAttribute=(key,value)=>{if(key==='data-theme')page.palettes.push(String(value));setPageAttribute(key,value);};document.documentElement=page;
  const meta=document.createElement('meta');meta.setAttribute('name','theme-color');root.append(meta);
  const appearance=document.getElementById('appearance-options')||root;for(const match of html.matchAll(/<button\b[^>]*data-appearance="([^"]+)"[^>]*>/g)){const button=document.createElement('button');button.setAttribute('data-appearance',match[1]);appearance.append(button);}
  for(const match of html.matchAll(/<button\b[^>]*data-page="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)){const button=document.createElement('button');button.setAttribute('data-page',match[1]);button.textContent=match[2].replace(/<[^>]+>/g,'');document.getElementById('settings-nav').append(button);}
  for(const id of ['send-button','stop-button','conversation-state'])document.getElementById(id).append(document.createElement('span'),document.createElement('span'));
  for(const id of ['save-project','save-folder'])document.getElementById(id).append(document.createTextNode('Save '),document.createElement('span'));
  return document;
}
const clone=value=>JSON.parse(JSON.stringify(value));
const response=(data,status=200)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(data),json:async()=>clone(data)});
async function flush(){for(let index=0;index<12;index++)await new Promise(resolve=>setImmediate(resolve));}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

async function browser({existing=true,available=true,providers={},authenticated=true,billingSource='subscription',accountErrors=[],workbench=false,insights=false,historyUI=insights,empty=false,moreProjects=false,desktop=false,wide=false,stored={},usage=null,setup=false,updatesUI=setup,savedPreferences={},desktopControls=false,filesUI=false,searchUI=false,reviewsUI=false,automaticReviewUI=false,localUI=false,modelPickerUI=false,agentsUI=false,layoutUI=false,commandsUI=false,terminalUI=false,voiceUI=false,recapUI=false,previewUI=false,rewindUI=false,questionsUI=false,alertsUI=false,clock=null,launch=null,update=null,theme=false,systemDark=true}={}){
  const document=documentFixture(),window=new Events(),storage=new Map(Object.entries(stored)),timers=new Map(),requests=[],handoffs=[],pickedFolders=[],updateAcknowledgements=[],externalLinks=[];let timerId=0,intercept=null;
  let preferences=clone(savedPreferences),handoffPreferences={threshold:90,automatic:false};
  window.innerWidth=1280;window.innerHeight=800;
  const awakeChanges=[],menuListeners=[],menuStates=[];
  const folder=(id,name,folderPath)=>({id,name,displayName:name,path:folderPath,available:true});
  const project={id:'project-one',name:'Example workspace',path:'/workspace/example/frontend',available:true,folders:[folder('frontend','Frontend','/workspace/example/frontend'),folder('backend','Backend','/workspace/example/backend')]};
  const projects=empty?[]:[project],removedProjects=new Map();if(moreProjects)projects.push({id:'project-two',name:'Other workspace',path:'/workspace/other/api',available:true,folders:[folder('api','API','/workspace/other/api')]});
  const newConversation=()=>({id:randomUUID(),title:'Conversation',provider:'codex',mode:'edit',approvalPolicy:'ask',models:{},status:'idle',messages:[],context:{goal:'',decisions:[],tasks:[]},updatedAt:'2026-10-20T00:00:00.000Z'});
  const conversations=[],canonical=new Map(),submissions=new Map();let chatCreations=0;
  const commandStates=new Map();
  const snapshots=new Map();
  const importSources=[
    {id:'claude-one',provider:'claude',title:'Plan the API',folder:'frontend',cwd:'/workspace/example/frontend',updatedAt:'2026-10-20T09:02:00.000Z',messages:[{sourceId:'c1',role:'user',text:'Plan the API',timestamp:'2026-10-20T09:00:00.000Z'},{sourceId:'c2',role:'assistant',text:'Claude planned it',timestamp:'2026-10-20T09:02:00.000Z'}]},
    {id:'codex-one',provider:'codex',title:'Build the API',folder:'frontend',cwd:'/workspace/example/frontend',updatedAt:'2026-10-20T09:03:00.000Z',messages:[{sourceId:'x1',role:'user',text:'Build the API',timestamp:'2026-10-20T09:01:00.000Z'},{sourceId:'x2',role:'assistant',text:'Codex built it',timestamp:'2026-10-20T09:03:00.000Z'}]},
    {id:'codex-new',provider:'codex',title:'Start new app',folder:'new-app',cwd:'/workspace/new-app',updatedAt:'2026-10-19T09:00:00.000Z',messages:[{sourceId:'n1',role:'user',text:'Start new app',timestamp:'2026-10-19T09:00:00.000Z'}]}];
  const ensureChat=project=>{if(!canonical.has(project.id)){const conversation=newConversation();canonical.set(project.id,conversation);conversations.push(conversation);project.conversationId=conversation.id;chatCreations++;}return canonical.get(project.id);};
  const providerStatus=provider=>({available:provider==='gemini'?false:available,...providers[provider]});
  const providerAccount=provider=>({installed:providerStatus(provider).available,authenticated:typeof authenticated==='object'?authenticated[provider]??'unknown':provider==='gemini'?'unknown':authenticated,billingSource:typeof billingSource==='object'?billingSource[provider]??'unknown':provider==='gemini'?'unknown':billingSource,usage:'unknown',...(provider==='gemini'?{message:'Configure authentication in Gemini CLI.'}:{})});
  if(existing)for(const project of projects)ensureChat(project);
  async function fetch(url,options={}){
    const address=new URL(url,'http://127.0.0.1:4318');const request={path:address.pathname,projectId:address.searchParams.get('projectId'),params:Object.fromEntries(address.searchParams),method:options.method||'GET',body:options.body?JSON.parse(options.body):null};requests.push(request);
    const next=()=>{
      if (request.path.startsWith('/api/commands')) {
        assert(projects.some(project=>project.id===request.projectId),'Project commands must name the current workspace.');
        let saved=commandStates.get(request.projectId); if(!saved){saved={commands:[],sessions:{}};commandStates.set(request.projectId,saved);}
        // A stand-in for the commands API: named commands, each with its latest session.
        if(request.path==='/api/commands')return response(clone({commands:saved.commands,sessions:Object.fromEntries(Object.entries(saved.sessions).map(([id,session])=>[id,request.params.output===id?session:(({output,ansi,...rest})=>rest)(session)]))}));
        if(request.path==='/api/commands/detect')return response({manager:'npm',suggestions:[{name:'dev',command:'npm run dev'},{name:'test',command:'npm run test',test:true}],message:'Nothing found here.'});
        const action=request.path.slice('/api/commands/'.length),body=request.body||{};
        if(action==='save'){
          const existing=saved.commands.find(command=>command.id===body.id),id=existing?.id||body.name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
          const command={id,name:body.name,folderId:body.folderId,directory:body.directory||'',command:body.command,...(body.test?{test:true}:{})};
          saved.commands=existing?saved.commands.map(item=>item===existing?command:item):[...saved.commands,command];
          if(body.test)saved.commands=saved.commands.map(item=>item.id===id?item:(({test,...rest})=>rest)(item));
          return response(clone(command));
        }
        const command=saved.commands.find(item=>item.id===body.id);assert(command,'A command action names a saved command.');
        if(action==='start'||action==='restart'){saved.sessions[command.id]={id:randomUUID(),commandId:command.id,name:command.name,command:command.command,folderId:command.folderId,status:'running',startedAt:new Date().toISOString(),output:'ready on http://localhost:3000',ansi:'\u001b[32mready\u001b[39m on http://localhost:3000',cwd:'/workspace/example/frontend',exitCode:null,urls:['http://localhost:3000/']};return response(clone(saved.sessions[command.id]),202);}
        if(action==='stop'){assert.equal(body.sessionId,saved.sessions[command.id].id);saved.sessions[command.id].status='stopped';return response(clone(saved.sessions[command.id]));}
        if(action==='clear'){delete saved.sessions[command.id];return response({});}
        if(action==='remove'){saved.commands=saved.commands.filter(item=>item!==command);delete saved.sessions[command.id];return response({});}
      }
      if(request.path==='/api/files')return response({entries:[],nextOffset:null});
      if(request.path==='/api/attachments'&&request.method==='POST'){const id=(snapshots.size+1).toString(16).padStart(64,'0'), file={id,name:request.body.name,kind:'text',mime:'text/plain',bytes:10};snapshots.set(id,file);return response(file,201);}
      if(request.path==='/api/attachments/preview')return response({...snapshots.get(request.params.id),text:'snapshot'});
      if(request.path==='/api/preferences'){if(request.method==='POST')preferences={...preferences,...preferencePatch(request.body,preferences)};return response(publicPreferences(preferences,projects.length>0));}
      if(request.path==='/api/local-models') { const target=projects.find(item=>item.id===request.projectId);assert(target);return response({installed:true,endpoint:'http://127.0.0.1:11434',models:[{id:'fixture-local:8b',model:'fixture-local:8b',digest:'a'.repeat(64),parameterSize:'8B',contextWindow:65536}],context:{conversationId:ensureChat(target).id,workspaceSignature:'fixture-scope',mode:ensureChat(target).mode}}); }
      if(request.path==='/api/local-models/start') { const target=projects.find(item=>item.id===request.projectId);assert(target);if(submissions.has(request.body.requestId))return response({...submissions.get(request.body.requestId),duplicate:true},202);submissions.set(request.body.requestId,{runId:'local-run',requestId:request.body.requestId});const conversation=ensureChat(target);conversation.messages.push({id:'local-reply',role:'assistant',provider:'codex',connection:'local',model:request.body.model,text:'Local task complete.'});conversation.lastRun={provider:'codex',connection:'local',model:request.body.model,status:'complete'};conversation.status='complete';return response({runId:'local-run',requestId:request.body.requestId},202); }
      if(request.path==='/api/appearance'){if(request.method==='POST'){try{preferences={...preferences,...preferencePatch({theme:request.body.theme},preferences)};}catch(error){return response({error:error.message},400);}return response({theme:request.body.theme});}return response({theme:publicPreferences(preferences,true).theme});}
      if(request.path==='/api/handoff-preferences'){if(request.method==='POST')handoffPreferences={...handoffPreferences,...request.body};return response(handoffPreferences);}
      if(request.path==='/api/sharing/config')return response({baseUrl:null});
      const rename=request.path.match(/^\/api\/projects\/([^/]+)$/);if(rename&&request.method==='POST'){const project=projects.find(item=>item.id===rename[1]);if(request.body.name!==undefined)project.name=request.body.name;if(request.body.previousConversationsDismissed!==undefined)project.previousConversationsDismissed=request.body.previousConversationsDismissed;return response(clone(project));}
      if(request.path==='/api/projects'&&request.method==='GET')return response(clone(projects));
      if(request.path==='/api/projects'&&request.method==='POST'){
        assert(Array.isArray(request.body.folders),'Workspace creation must explicitly list its folders.');
        const paths=request.body.folders;const added={id:'project-'+(projects.length+1),name:request.body.name||paths[0].split('/').pop(),path:paths[0],available:true,folders:paths.map((folderPath,index)=>folder('folder-'+index,folderPath.split('/').pop(),folderPath))};projects.push(added);return response(clone(added),201);
      }
      const account=request.path.match(/^\/api\/providers\/(codex|claude|gemini)\/account$/);
      const usageRead=request.path.match(/^\/api\/providers\/(codex|claude|gemini)\/usage$/);
      if(request.path==='/api/import-sources'){const {scope,provider}=request.params;const project=projects.find(project=>project.id===request.projectId);if(scope==='workspace')assert(project,'Workspace-scoped discovery names its workspace.');return response({sessions:importSources.filter(row=>row.provider===provider&&(scope!=='workspace'||project.folders.some(folder=>folder.path===row.cwd))).map(({messages,...row})=>clone(row)),nextCursor:null});}
      if(request.path==='/api/import-sources/preview'){const source=importSources.find(row=>row.provider===request.body.provider&&row.id===request.body.sessionId);return response({provider:source.provider,sessionId:source.id,title:source.title,cwd:source.cwd,digest:'digest-'+source.id,messageCount:source.messages.length,clipped:false,messages:clone(source.messages)});}
      if(request.path==='/api/import-sources/file-preview'){const shared=request.body.package;assert.equal(shared.schema,'ai-relay.conversation');return response({provider:'file',sessionId:shared.id,title:shared.workspace.name,cwd:null,folders:shared.workspace.folders,exportedAt:shared.exportedAt,context:null,clipped:false,messages:shared.messages.map(message=>({sourceId:message.id,role:message.role,text:message.text,provider:message.provider,timestamp:message.createdAt})),messageCount:shared.messages.length,digest:'digest-'+shared.id});}
      if(request.path==='/api/import-sources/import'){
        const chosen=(request.body.sessions||[]).map(item=>{const source=importSources.find(row=>row.provider===item.provider&&row.id===item.sessionId);assert.equal(item.approvedDigest,'digest-'+source.id,'Only reviewed content is imported.');return source;});
        for(const item of request.body.files||[]){assert.equal(item.approvedDigest,'digest-'+item.package.id,'Only the reviewed file is imported.');chosen.push({provider:'file',cwd:null,messages:item.package.messages.map(message=>({sourceId:message.id,role:message.role,text:message.text,provider:message.provider,timestamp:message.createdAt}))});}
        let target=projects.find(project=>project.id===request.body.projectId);const where=chosen.find(source=>source.cwd)?.cwd||request.body.folders?.[0];
        if(!target){assert(where,'A new workspace needs a local folder.');target={id:'project-'+(projects.length+1),name:request.body.name,path:where,available:true,folders:[folder('imported',where.split('/').pop(),where)]};projects.push(target);}
        const chat=ensureChat(target),merged=chosen.flatMap(source=>source.messages.map(message=>({...message,provider:source.provider==='file'?message.provider:source.provider}))).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
        chat.messages.push(...merged.map(({timestamp,sourceId,...message})=>({...message,id:sourceId,imported:true,createdAt:timestamp})));
        target.previousConversationsDismissed=true;
        return response({imported:merged.length,updated:0,duplicate:false,conversationId:chat.id,projectId:target.id,projectName:target.name,conversations:chosen.length,missingFolders:[]});
      }
      if(usageRead){assert.equal(request.method,'GET','Usage is read-only.');return response(usage?.[usageRead[1]]||{provider:usageRead[1],available:false,reason:'Not reported.'});}
      if(account){assert.equal(request.method,'GET','Account discovery is metadata-only.');if(accountErrors.includes(account[1]))return response({error:'Account metadata is unavailable.'},503);return response(providerAccount(account[1]));}
      const workspaceAction=request.path.match(/^\/api\/projects\/([^/]+)\/(remove|restore)$/);
      if(workspaceAction){assert.equal(request.method,'POST');const id=workspaceAction[1];if(workspaceAction[2]==='remove'){const index=projects.findIndex(project=>project.id===id);if(index>=0)removedProjects.set(id,projects.splice(index,1)[0]);return response({id,removed:true});}const restored=removedProjects.get(id)||projects.find(project=>project.id===id);assert(restored);if(!projects.some(project=>project.id===id))projects.push(restored);removedProjects.delete(id);return response(clone(restored));}
      const membership=request.path.match(/^\/api\/projects\/([^/]+)\/folders(?:\/([^/]+)\/remove)?$/);
      if(membership){const selected=projects.find(project=>project.id===membership[1]);assert(selected);if(membership[2]){if(selected.folders.length<=1)return response({error:'A workspace needs a folder.'},400);selected.folders=selected.folders.filter(folder=>folder.id!==membership[2]);}else{for(const folderPath of request.body.folders||[request.body.path])selected.folders.push(folder(randomUUID(),folderPath.split('/').pop(),folderPath));}selected.path=selected.folders[0].path;return response(clone(selected));}
      if (request.path==='/api/providers/gemini/models') return response({models:[],source:'native-cli',manualSelection:true});
      if (/^\/api\/providers\/(codex|claude)\/models$/.test(request.path)) return response({models:[{id:'model-one',value:'model-one',displayName:'Model One',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{id:'model-two',value:'model-two',displayName:'Model Two',supportedEffortLevels:['low','medium']}]});
      const selected=projects.find(project=>project.id===request.projectId);assert(selected,'Project-owned requests need an explicit valid project ID.');

      if (request.path==='/api/git') return response({totalChanges:1,checkedAt:new Date().toISOString(),repositories:[{folderId:'frontend',name:'Frontend',available:true,branch:'feature/design',totalChanges:1,changes:[{path:'app.js',code:' M',staged:false}],commits:[{hash:'abc',shortHash:'abc123',author:'Fixture author',date:new Date().toISOString(),subject:'Improve workspace navigation'}]}]});
      if (request.path==='/api/git/diff') return response({folderId:'frontend',path:'app.js',code:' M',diff:'diff --git a/app.js b/app.js\nindex 1..2 100644\n--- a/app.js\n+++ b/app.js\n@@ -1,2 +1,2 @@\n const value = 1;\n--- old SQL comment\n+// updated\n',truncated:false});
      if (request.path==='/api/imports/preview') return response({provider:'codex',sessionId:'external-one',title:'Existing native task',digest:'reviewed-source',messageCount:2,messages:[{sourceId:'u',role:'user',text:'Original task'},{sourceId:'a',role:'assistant',text:'Saved native answer'}]});
      if (request.path==='/api/imports') {
        if (request.method==='GET') return response({sessions:[{id:'external-one',provider:'codex',title:'Existing native task',folder:'Frontend',updatedAt:new Date().toISOString()}],nextCursor:null});
        assert.equal(request.body.approvedDigest,'reviewed-source');const chat=ensureChat(selected);chat.messages.push({id:'imported-one',provider:'codex',role:'user',text:'Original task',imported:true},{id:'imported-two',provider:'codex',role:'assistant',text:'Saved native answer',imported:true});return response({imported:2,conversationId:chat.id});
      }

      if(request.path==='/api/conversation/export'){const redacted=request.params.redact!=='0';return response({package:{schema:'ai-relay.conversation',version:1,id:'export-one',workspace:{name:selected.name,folders:['frontend']},messages:clone(ensureChat(selected).messages).map(message=>({id:message.id,role:message.role,text:message.text})),digest:'exported'},stats:{messages:ensureChat(selected).messages.length,omitted:0,bytes:420,from:null,to:null,providers:[]},findings:{secrets:1,localPaths:0},redacted});}
      if(request.path==='/api/status')return response({workspace:selected.path,projectId:selected.id,project:clone(selected),providers:{codex:providerStatus('codex'),claude:providerStatus('claude'),gemini:providerStatus('gemini')},runningConversationId:canonical.get(selected.id)?.status==='running'?canonical.get(selected.id).id:null});
      if(request.path==='/api/conversation')return response(clone(ensureChat(selected)));
      if(request.path==='/api/collaboration/handoffs/prepare'){const body=request.body;const outgoing=body.draft?sealPackage(body.draft):sealPackage({schema:'ai-relay.handoff',version:1,id:randomUUID(),createdAt:'2026-10-20T00:00:00.000Z',mode:body.mode||'context',goal:body.goal||'',problem:body.problem||'',expectedOutcome:body.expectedOutcome||'',decisions:body.decisions||[],tasks:body.tasks||[],messages:[],files:[],baseline:[]});return response({package:outgoing,warnings:[]});}
      if(request.path==='/api/collaboration/handoffs/approve'){const record={id:request.body.package.id,package:request.body.package,direction:'outgoing',status:'approved'};handoffs.push(record);return response(clone(record));}
      const match=request.path.match(/^\/api\/conversations\/([^/]+)(?:\/(provider|messages|continue))?$/);
      if(match){const conversation=canonical.get(selected.id);assert(conversation&&conversation.id===match[1],'The browser must target this workspace’s permanent conversation.');if(request.method==='GET')return response(clone(conversation));if(match[2]==='provider'){const provider=request.body.provider,mode=request.body.mode,approvalPolicy=request.body.approvalPolicy||'ask',model=request.body.model===undefined?conversation.models[provider]||null:request.body.model;conversation.efforts ||= {};const effort=request.body.effort===undefined?conversation.efforts[provider]?.[model||'default']??null:request.body.effort;Object.assign(conversation,{provider,mode,approvalPolicy,model,effort});conversation.models[provider]=model;conversation.efforts[provider] ||= {};conversation.efforts[provider][model||'default']=effort;return response(clone(conversation));}if(['messages','continue'].includes(match[2])){if(!submissions.has(request.body.requestId)){submissions.set(request.body.requestId,{runId:randomUUID()});conversation.messages.push({id:randomUUID(),role:'user',text:request.body.text||'Continue',createdAt:'2026-10-20T00:00:00.000Z'});}conversation.status='complete';return response(submissions.get(request.body.requestId),202);}}
      throw new Error('Unexpected browser request: '+request.method+' '+request.path);
    };return intercept?intercept(request,next):next();
  }
  // prefers-color-scheme reports the OS appearance; setSystemDark changes it the way the OS would.
  const colorScheme={matches:systemDark,listeners:[],addEventListener(type,fn){if(type==='change')this.listeners.push(fn);}};
  if(wide||theme)window.matchMedia=query=>query==='(prefers-color-scheme: dark)'?colorScheme:{matches:wide};
  const quitListeners=[];if(desktop)window.relayDesktop={token:'desktop-test-token',pickFolder:async()=>pickedFolders.shift()||null,onQuitting:callback=>quitListeners.push(callback)};
  if(desktop)Object.assign(window.relayDesktop,{getKeepAwake:async()=>({enabled:false,active:false,runningCount:0}),setKeepAwake:async enabled=>{awakeChanges.push(enabled);return {enabled,active:false,runningCount:0};},onKeepAwakeChanged:callback=>{window.addEventListener('desktop-keep-awake',event=>callback(event.detail));return ()=>{};}});
  // The menu bar's side of the bridge: commands arrive through onMenuCommand, and reported states are cloned as IPC would.
  if(desktop)Object.assign(window.relayDesktop,{onMenuCommand:callback=>{menuListeners.push(callback);return ()=>{};},setMenuState:state=>{menuStates.push(clone(state));}});
  if(desktop){launch ||= {version:'0.9.1',previousVersion:null,updated:false,releases:[]};Object.assign(window.relayDesktop,{getLaunchState:async()=>clone(launch),acknowledgeUpdate:async()=>{updateAcknowledgements.push(launch.version);launch={...launch,updated:false};return clone(launch);},openExternal:async url=>{externalLinks.push(url);}});}
  // The updater's side of the bridge: calls are recorded, and the main process's answers and pushed states are cloned as IPC would.
  const eventSources=[],terminals=[],spoken=[];
  const updateCalls=[],updateListeners=[];let updateState=update&&clone(update);
  const answer=(name,next)=>async(...args)=>{updateCalls.push([name,...args]);if(next)updateState={...updateState,...next(...args)};return clone(updateState);};
  if(desktop&&update)Object.assign(window.relayDesktop,{getUpdateState:answer('get'),checkForUpdates:answer('check',()=>({status:updateState.latest?'available':'current'})),installUpdate:answer('install',()=>({status:'downloading',progress:{received:0,total:null}})),restartToUpdate:answer('restart',()=>({status:'installing'})),cancelUpdate:answer('cancel',()=>({status:updateState.status==='waiting'?'ready':'available',progress:null})),skipUpdate:answer('skip',version=>({skipped:version})),setAutomaticUpdates:answer('automatic',automatic=>({automatic})),onUpdateState:callback=>{updateListeners.push(callback);return ()=>{};}});
  // Custom Highlight API stand-ins: ranges record their boundaries, and the registry is a Map.
  class Range{setStart(node,offset){this.startContainer=node;this.startOffset=offset;}setEnd(node,offset){this.endContainer=node;this.endOffset=offset;}getBoundingClientRect(){return this.startContainer.parentNode.getBoundingClientRect();}}
  class Highlight extends Set{constructor(...ranges){super(ranges);this.priority=0;}}
  const highlights=new Map();document.createRange=()=>new Range();
  const context=vm.createContext({document,window,fetch,console,CSS:{highlights},Highlight,crypto:{randomUUID},CustomEvent:UIEvent,Event:UIEvent,EventSource:class extends Events{constructor(url){super();this.url=url;eventSources.push(this);}close(){this.closed=true;}},requestAnimationFrame:fn=>fn(),setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))},URL,Blob,FileReader,navigator:{clipboard:{writeText:async()=>{}}}});
  if(theme)vm.runInContext(fs.readFileSync(new URL('../public/theme.js',import.meta.url),'utf8'),context,{filename:'public/theme.js'});
  vm.runInContext(fs.readFileSync(new URL('../public/routing.js',import.meta.url),'utf8'),context,{filename:'public/routing.js'});
  const previewOpens=[],previewListeners=[];
  if(previewUI)window.relayDesktop=Object.assign(window.relayDesktop||{},{openPreview:async input=>{previewOpens.push(clone(input));return true;},onPreviewPick:callback=>{previewListeners.push(callback);return ()=>{};}});
  vm.runInContext(fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context,{filename:'public/app.js'});if(questionsUI)vm.runInContext(fs.readFileSync(new URL('../public/questions.js',import.meta.url),'utf8'),context,{filename:'public/questions.js'});if(workbench){vm.runInContext(fs.readFileSync(new URL('../public/settings.js',import.meta.url),'utf8'),context,{filename:'public/settings.js'});vm.runInContext(fs.readFileSync(new URL('../public/workbench.js',import.meta.url),'utf8'),context,{filename:'public/workbench.js'});}
  if(insights)vm.runInContext(fs.readFileSync(new URL('../public/insights.js',import.meta.url),'utf8'),context,{filename:'public/insights.js'});
  if(modelPickerUI)vm.runInContext(fs.readFileSync(new URL('../public/model-picker.js',import.meta.url),'utf8'),context,{filename:'public/model-picker.js'});
  if(layoutUI)vm.runInContext(fs.readFileSync(new URL('../public/layout.js',import.meta.url),'utf8'),context,{filename:'public/layout.js'});
  if(agentsUI)vm.runInContext(fs.readFileSync(new URL('../public/agents-panel.js',import.meta.url),'utf8'),context,{filename:'public/agents-panel.js'});
  if(agentsUI)for(const name of ['parallel-tasks','brief-panel','memory','skills','tasks-panel'])vm.runInContext(fs.readFileSync(new URL(`../public/${name}.js`,import.meta.url),'utf8'),context,{filename:`public/${name}.js`});
  if(historyUI)vm.runInContext(fs.readFileSync(new URL('../public/conversation-history.js',import.meta.url),'utf8'),context,{filename:'public/conversation-history.js'});
  if(desktopControls)vm.runInContext(fs.readFileSync(new URL('../public/desktop-controls.js',import.meta.url),'utf8'),context,{filename:'public/desktop-controls.js'});
  if(setup)vm.runInContext(fs.readFileSync(new URL('../public/setup.js',import.meta.url),'utf8'),context,{filename:'public/setup.js'});
  if(updatesUI)vm.runInContext(fs.readFileSync(new URL('../public/updates.js',import.meta.url),'utf8'),context,{filename:'public/updates.js'});
  if(localUI)vm.runInContext(fs.readFileSync(new URL('../public/local-models.js',import.meta.url),'utf8'),context,{filename:'public/local-models.js'});
  if(commandsUI||terminalUI)vm.runInContext(fs.readFileSync(new URL('../public/bottom-panel.js',import.meta.url),'utf8'),context,{filename:'public/bottom-panel.js'});
  if(previewUI)vm.runInContext(fs.readFileSync(new URL('../public/preview.js',import.meta.url),'utf8'),context,{filename:'public/preview.js'});
  if(commandsUI)vm.runInContext(fs.readFileSync(new URL('../public/project-commands.js',import.meta.url),'utf8'),context,{filename:'public/project-commands.js'});
  if(filesUI)vm.runInContext(fs.readFileSync(new URL('../public/files.js',import.meta.url),'utf8'),context,{filename:'public/files.js'});
  if(searchUI)vm.runInContext(fs.readFileSync(new URL('../public/conversation-search.js',import.meta.url),'utf8'),context,{filename:'public/conversation-search.js'});
  if(reviewsUI)vm.runInContext(fs.readFileSync(new URL('../public/agent-review.js',import.meta.url),'utf8'),context,{filename:'public/agent-review.js'});
  if(automaticReviewUI)vm.runInContext(fs.readFileSync(new URL('../public/automatic-review.js',import.meta.url),'utf8'),context,{filename:'public/automatic-review.js'});
  if(rewindUI)vm.runInContext(fs.readFileSync(new URL('../public/rewind.js',import.meta.url),'utf8'),context,{filename:'public/rewind.js'});
  if(alertsUI)vm.runInContext(fs.readFileSync(new URL('../public/alerts.js',import.meta.url),'utf8'),context,{filename:'public/alerts.js'});
  if(update)vm.runInContext(fs.readFileSync(new URL('../public/updater.js',import.meta.url),'utf8'),context,{filename:'public/updater.js'});
  // A stand-in for xterm.js: it records what the page writes and lets a test type into it.
  if(terminalUI){
    window.Terminal=class{constructor(options){this.options=options;this.written='';this.cols=80;this.rows=24;this.focused=0;terminals.push(this);}loadAddon(){}open(host){this.host=host;}onData(fn){this.type=fn;}onResize(fn){this.resized=fn;}write(data){this.written+=data;}reset(){this.written='';}focus(){this.focused++;}dispose(){this.disposed=true;}};
    window.FitAddon={FitAddon:class{fit(){}}};
    vm.runInContext(fs.readFileSync(new URL('../public/terminal.js',import.meta.url),'utf8'),context,{filename:'public/terminal.js'});
  }
  // A stand-in for the system's speech synthesis: it records what would be spoken.
  if(voiceUI){
    window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
    window.speechSynthesis={utterances:[],speak(utterance){spoken.push(utterance.text);this.utterances.push(utterance);},cancel(){},getVoices:()=>[]};
    vm.runInContext(fs.readFileSync(new URL('../public/voice.js',import.meta.url),'utf8'),context,{filename:'public/voice.js'});
  }
  // A test can move the page's clock, for behaviour that depends on how long you were away.
  if(clock){context.clock=clock;vm.runInContext('Date.now=()=>clock()',context);}
  if(recapUI)vm.runInContext(fs.readFileSync(new URL('../public/recap.js',import.meta.url),'utf8'),context,{filename:'public/recap.js'});
  if(theme)document.dispatchEvent(new UIEvent('DOMContentLoaded'));
  await flush();assert.equal(window.relayUI.getState().ready,!empty);assert.equal(window.relayUI.getState().loading,false);
  const $=id=>document.getElementById(id);const fire=(id,type)=>$(id).dispatchEvent(new UIEvent(type));const findButton=text=>document.querySelectorAll('button').find(button=>button.textContent===text);
  const labelledInput=label=>{const entry=document.querySelectorAll('label').find(item=>item.textContent.startsWith(label));assert(entry,'Missing field: '+label);return entry.children.find(child=>['INPUT','TEXTAREA','SELECT'].includes(child.tagName));};
  const switchProject=async id=>{$('project-select').value=id;fire('project-select','change');await flush();};
  const textNodes=node=>node.nodeType===3?[node]:node.childNodes.flatMap(textNodes);
  const rangeText=range=>{const nodes=textNodes($('messages')),first=nodes.indexOf(range.startContainer),last=nodes.indexOf(range.endContainer);return nodes.slice(first,last+1).map((node,index)=>node.data.slice(index===0?range.startOffset:0,first+index===last?range.endOffset:undefined)).join('');};
  return {quitting:()=>quitListeners.forEach(listener=>listener()),previewOpens,pickInPreview:pick=>Promise.all(previewListeners.map(listener=>listener(pick))),runTimers:()=>{for(const [id,timer] of [...timers]){timers.delete(id);timer.fn();}},document,window,$,fire,findButton,highlights,rangeText,labelledInput,requests,conversations,submissions,handoffs,projects,canonical,pickedFolders,updateAcknowledgements,externalLinks,storage,switchProject,awakeChanges,menuStates,menu:(name,value)=>{for(const fn of menuListeners)fn(name,value);},eventSources,terminals,spoken,updateCalls,pushUpdate:next=>{updateState={...updateState,...next};for(const fn of updateListeners)fn(clone(updateState));},get chatCreations(){return chatCreations;},setIntercept:fn=>{intercept=fn;},setSystemDark:value=>{colorScheme.matches=value;for(const fn of colorScheme.listeners)fn({matches:value});},state:()=>window.relayUI.getState()};
}

test('late same-project refresh cannot restore superseded provider/access settings',async()=>{
  const ui=await browser(),held=deferred();let waiting=false;
  ui.setIntercept((request,next)=>{if(!waiting&&request.method==='GET'&&request.path==='/api/conversation'){waiting=true;const stale=next();return held.promise.then(()=>stale);}return next();});
  const refreshing=ui.window.relayUI.refresh();await flush();assert.equal(waiting,true);
  ui.$('select-claude').click();ui.$('mode-select').value='read';ui.fire('mode-select','change');await flush();assert.equal(ui.state().settingsPending,0,'Finish settings POSTs before releasing the older GET.');assert.equal(ui.conversations[0].provider,'claude');assert.equal(ui.conversations[0].mode,'read');
  held.resolve();await refreshing;await flush();assert.equal(ui.state().provider,'claude');assert.equal(ui.state().mode,'read');assert.equal(ui.$('select-claude').getAttribute('aria-pressed'),'true');assert.equal(ui.$('mode-select').value,'read');
});

for(const existing of [true,false])test('accepted-send response loss preserves requestId on retry '+(existing?'in an existing chat':'when the canonical chat is first opened'),async()=>{
  const ui=await browser({existing});let lost=false;ui.setIntercept((request,next)=>{const result=next();if(request.path.endsWith('/messages')&&!lost){lost=true;throw new Error('Response lost after acceptance and completion.');}return result;});
  ui.$('message-input').value='Fix this task exactly once';ui.fire('message-input','input');ui.fire('composer','submit');ui.fire('composer','submit');await flush();assert.equal(lost,true);assert.equal(ui.state().pending,null);assert.equal(ui.$('notice').hidden,false);assert.equal(ui.$('message-input').value,'Fix this task exactly once');assert.equal(ui.submissions.size,1);
  ui.$('notice-retry').click();await flush();const sends=ui.requests.filter(request=>request.path.endsWith('/messages'));assert.equal(sends.length,2);assert.match(sends[0].body.requestId,/^[a-f0-9-]{36}$/);assert.equal(sends[1].body.requestId,sends[0].body.requestId);assert.equal(sends[1].path,sends[0].path);assert.equal(ui.submissions.size,1);assert.equal(ui.$('message-input').value,'');assert.equal(ui.conversations.length,1);
  assert.equal(ui.requests.filter(request=>request.path==='/api/conversations'&&request.method==='POST').length,0,'The UI never creates additional conversations.');assert.equal(ui.chatCreations,1);
});

test('offline Ask a Friend remains enabled with both CLIs absent and request controls never submit model messages',async()=>{
  const ui=await browser({existing:false,available:false,workbench:true});assert.equal(ui.$('select-codex').disabled,true);assert.equal(ui.$('select-claude').disabled,true);assert.equal(ui.$('send-button').disabled,true);assert.equal(ui.$('ask-friend').disabled,false);
  ui.$('ask-friend').click();await flush();assert.equal(ui.$('workbench').open,true);ui.labelledInput('Goal').value='Offline request';ui.findButton('Prepare offline preview').click();await flush();
  const editor=ui.labelledInput('Editable package JSON'),outgoing=JSON.parse(editor.value);assert.equal(outgoing.goal,'Offline request');assert.equal(outgoing.mode,'context');assert.equal(outgoing.messages.length,0);assert.equal(ui.findButton('Approve exact package').disabled,false);
  outgoing.goal='Explicitly edited offline goal';editor.value=JSON.stringify(outgoing);editor.dispatchEvent(new UIEvent('input'));assert.equal(ui.findButton('Approve exact package').disabled,true);ui.findButton('Refresh edited preview').click();await flush();const refreshed=JSON.parse(editor.value);assert.notEqual(refreshed.integrity,outgoing.integrity);
  ui.labelledInput('I inspected the exact package').checked=true;ui.findButton('Approve exact package').click();await flush();assert.equal(ui.handoffs.length,1);assert.equal(ui.handoffs[0].package.integrity,refreshed.integrity);assert(ui.findButton('Export approved request'));
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);assert.equal(ui.requests.filter(request=>request.path.startsWith('/api/providers/')).length,0);assert.equal(ui.requests.filter(request=>/\/(?:publish|retrieve|revoke)$/.test(request.path)).length,0,'Approval cannot publish implicitly.');const prepared=ui.requests.find(request=>request.path==='/api/collaboration/handoffs/prepare');assert.equal(prepared.body.messageIds.length,0);assert.equal(prepared.body.files.length,0);assert.equal(prepared.body.newPaths.length,0);
});


test('each workspace automatically opens one permanent chat and switching preserves separate drafts',async()=>{
  const ui=await browser({moreProjects:true});const firstId=ui.state().conversation.id;
  assert.equal(ui.$('new-chat'),null);assert.equal(ui.$('conversation-list'),null);assert.equal(ui.$('history-toggle'),null);
  assert.equal(ui.$('workspace-count').textContent,'2');assert(ui.$('workspace-list').textContent.includes('Frontend'));assert(ui.$('workspace-list').textContent.includes('Backend'));
  ui.$('message-input').value='first workspace draft';ui.fire('message-input','input');
  await ui.switchProject('project-two');const secondId=ui.state().conversation.id;assert.notEqual(firstId,secondId);assert.equal(ui.$('message-input').value,'');
  ui.$('message-input').value='second workspace draft';ui.fire('message-input','input');await ui.switchProject('project-one');assert.equal(ui.state().conversation.id,firstId);assert.equal(ui.$('message-input').value,'first workspace draft');
  await ui.window.relayUI.ensureConversation();await ui.window.relayUI.ensureConversation();await ui.window.relayUI.refresh();assert.equal(ui.state().conversation.id,firstId);assert.equal(ui.chatCreations,2);assert.equal(ui.requests.filter(request=>request.path==='/api/conversations').length,0);
});

test('workspace creation explicitly accepts multiple folders and opens its canonical chat without a create-chat request',async()=>{
  const ui=await browser({empty:true,existing:false,desktop:true});assert.equal(ui.$('project-empty-state').hidden,false);assert.equal(ui.$('send-button').disabled,true);
  ui.$('add-first-project').click();ui.$('project-name').value='Full stack';ui.$('project-paths').value='/workspace/frontend';ui.pickedFolders.push('/workspace/backend');ui.$('pick-folder').click();await flush();assert.equal(ui.$('project-paths').value,'/workspace/frontend\n/workspace/backend');
  ui.$('project-paths').value+='\n/workspace/frontend';ui.fire('project-form','submit');await flush();const creation=ui.requests.find(request=>request.path==='/api/projects'&&request.method==='POST');assert.deepEqual(creation.body,{name:'Full stack',folders:['/workspace/frontend','/workspace/backend']});assert.equal(ui.state().ready,true);assert.equal(ui.state().conversation.id,ui.canonical.get(ui.state().projectId).id);assert.equal(ui.chatCreations,1);assert.equal(ui.projects[0].folders.length,2);assert.equal(ui.$('project-empty-state').hidden,true);
});

test('adding/removing folders keeps the same chat and draft, including removal of the primary root',async()=>{
  const ui=await browser({moreProjects:true});const chatId=ui.state().conversation.id;
  ui.$('message-input').value='draft across folder changes';ui.fire('message-input','input');ui.findButton('Add folder').click();ui.$('folder-path').value='/workspace/shared';ui.fire('folder-form','submit');await flush();
  assert.equal(ui.projects[0].folders.length,3);assert.equal(ui.state().conversation.id,chatId);assert.equal(ui.$('message-input').value,'draft across folder changes');assert(ui.$('workspace-list').textContent.includes('shared'));
  const remove=ui.document.querySelectorAll('.folder-options').find(button=>button.dataset.folderId==='frontend');remove.click();assert.equal(ui.$('folder-options-dialog').open,true);assert.equal(ui.projects[0].folders.length,3);ui.$('confirm-remove-folder').click();await flush();assert.equal(ui.projects[0].folders.length,2);assert.equal(ui.projects[0].path,'/workspace/example/backend');assert.equal(ui.state().conversation.id,chatId);
  await ui.switchProject('project-two');await ui.switchProject('project-one');assert.equal(ui.$('message-input').value,'draft across folder changes');assert.equal(ui.state().conversation.id,chatId);
  ui.document.querySelectorAll('.folder-options')[0].click();ui.$('confirm-remove-folder').click();await flush();assert.equal(ui.projects[0].folders.length,1);ui.document.querySelectorAll('.folder-options')[0].click();const last=ui.$('confirm-remove-folder');assert.equal(last.disabled,true);const count=ui.requests.length;last.click();await flush();assert.equal(ui.requests.length,count);assert.equal(ui.chatCreations,2);
});

test('folder mutations lock switching while pending and active runs lock folder changes, not workspace selection',async()=>{
  const ui=await browser({moreProjects:true});const held=deferred();let pending=false;
  ui.setIntercept((request,next)=>{const result=next();if(request.path==='/api/projects/project-one/folders'){pending=true;return held.promise.then(()=>result);}return result;});
  ui.findButton('Add folder').click();ui.$('folder-path').value='/workspace/shared';ui.fire('folder-form','submit');await flush();assert.equal(pending,true);assert.equal(ui.$('project-select').disabled,true);await ui.switchProject('project-two');assert.equal(ui.state().projectId,'project-one');held.resolve();await flush();assert.equal(ui.$('project-select').disabled,false);
  ui.canonical.get('project-one').status='running';await ui.window.relayUI.refresh();assert.equal(ui.findButton('Add folder').disabled,true);ui.document.querySelectorAll('.folder-options')[0].click();assert.equal(ui.$('confirm-remove-folder').disabled,true);ui.$('close-folder-options').click();assert.equal(ui.$('project-select').disabled,false);await ui.switchProject('project-two');assert.equal(ui.state().projectId,'project-two');
});

test('late canonical response from a previous workspace cannot replace the current workspace chat',async()=>{
  const ui=await browser({moreProjects:true}),held=deferred();let waiting=false;
  ui.setIntercept((request,next)=>{const result=next();if(!waiting&&request.path==='/api/conversation'&&request.projectId==='project-one'){waiting=true;return held.promise.then(()=>result);}return result;});
  const refreshing=ui.window.relayUI.refresh();await flush();assert.equal(waiting,true);await ui.switchProject('project-two');const current=ui.state().conversation.id;held.resolve();await refreshing;await flush();assert.equal(ui.state().projectId,'project-two');assert.equal(ui.state().conversation.id,current);
});

test('startup checks account metadata without starting a model or repeatedly probing on focus',async()=>{
  const ui=await browser();
  const accountRequests=()=>ui.requests.filter(request=>/^\/api\/providers\/[^/]+\/account$/.test(request.path));
  assert.deepEqual(accountRequests().map(request=>request.path).sort(),['/api/providers/claude/account','/api/providers/codex/account']);
  assert(accountRequests().every(request=>request.method==='GET'));
  assert.equal(ui.$('codex-status-text').textContent,'Connected');assert.equal(ui.$('claude-status-text').textContent,'Connected');
  ui.window.dispatchEvent(new UIEvent('focus'));ui.window.dispatchEvent(new UIEvent('focus'));await flush();
  assert.equal(accountRequests().length,2,'Fresh metadata is cached across repeated focus events.');
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue|connect|models)$/.test(request.path)).length,0,'Metadata discovery never sends prompts, starts login or loads model choices.');
});

test('known signed-out provider offers account setup and blocks Send and Continue',async()=>{
  const ui=await browser({authenticated:{codex:false,claude:true},workbench:true});
  ui.$('message-input').value='Keep this draft while I sign in';ui.fire('message-input','input');
  assert.equal(ui.$('send-button').disabled,true);assert.equal(ui.$('connection-notice').hidden,false);
  assert.equal(ui.$('connection-notice-text').textContent,'Codex is not signed in.');assert.equal(ui.$('connection-action').textContent,'Connect account');
  assert.equal(ui.$('conversation-state').textContent,'Connection required');
  const conversation=ui.canonical.get('project-one');conversation.status='incomplete';conversation.lastRun={provider:'codex',errorCategory:'auth'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('continue-button').disabled,true);ui.fire('composer','submit');ui.$('continue-button').click();await flush();
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
  ui.$('connection-action').click();await flush();assert.equal(ui.$('settings').open,true);assert.equal(ui.$('settings-title').textContent,'Accounts');
  assert.equal(ui.$('message-input').value,'Keep this draft while I sign in');
});

test('Settings is available before any workspace and account discovery is global',async()=>{
  const ui=await browser({empty:true,existing:false,workbench:true});
  assert.equal(ui.$('relay-settings').disabled,false);assert.equal(ui.$('ask-friend').disabled,true);
  ui.$('relay-settings').click();await flush();
  assert.equal(ui.$('settings').open,true);assert.equal(ui.$('settings-title').textContent,'General');assert.equal(ui.$('settings-error').hidden,true);
  const requests=ui.requests.filter(request=>/^\/api\/providers\/[^/]+\/account$/.test(request.path));assert.deepEqual(requests.map(request=>request.path.split('/')[3]).sort(),['claude','codex','gemini']);assert(requests.every(request=>request.projectId===null));
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue|connect|models)$/.test(request.path)).length,0);
});

test('an unavailable selected provider offers the installed alternative without silently changing saved selection',async()=>{
  const ui=await browser({providers:{codex:{available:false},claude:{available:true}}});
  ui.$('message-input').value='Draft for either assistant';ui.fire('message-input','input');
  assert.equal(ui.state().provider,'codex');assert.equal(ui.$('select-codex').disabled,true);assert.equal(ui.$('select-claude').disabled,false);assert.equal(ui.$('send-button').disabled,true);
  assert.equal(ui.$('connection-notice').hidden,false);assert.equal(ui.$('connection-action').textContent,'Use Claude');
  assert.deepEqual(ui.requests.filter(request=>/^\/api\/providers\/[^/]+\/account$/.test(request.path)).map(request=>request.path),['/api/providers/claude/account']);
  ui.$('connection-action').click();await flush();
  assert.equal(ui.state().provider,'claude');assert.equal(ui.canonical.get('project-one').provider,'claude');assert.equal(ui.$('connection-notice').hidden,true);assert.equal(ui.$('send-button').disabled,false);assert.equal(ui.$('message-input').value,'Draft for either assistant');
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
});

test('both missing providers show one setup next action while offline collaboration stays usable',async()=>{
  const ui=await browser({available:false,workbench:true});
  assert.equal(ui.$('provider-empty-state').hidden,false);assert.equal(ui.$('empty-state').hidden,true);assert.equal(ui.$('connection-notice').hidden,true);
  assert.equal(ui.$('conversation-state').textContent,'Connection required');assert.equal(ui.$('ask-friend').disabled,false);assert.equal(ui.$('relay-settings').disabled,false);
  assert.equal(ui.requests.filter(request=>request.path.startsWith('/api/providers/')).length,0,'Installed-false providers are not probed during startup.');
  ui.$('connect-assistant').click();await flush();assert.equal(ui.$('settings').open,true);assert.equal(ui.$('settings-title').textContent,'Accounts');
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue|connect)$/.test(request.path)).length,0);
});

test('failed account probes remain advisory and do not invent an authentication or billing block',async()=>{
  const ui=await browser({accountErrors:['codex','claude']});
  assert.equal(ui.state().accounts?.codex,undefined);assert.equal(ui.state().accounts?.claude,undefined);
  ui.$('message-input').value='Explicit request after unavailable metadata';ui.fire('message-input','input');
  assert.equal(ui.$('send-button').disabled,false);assert.equal(ui.$('conversation-state').textContent,'Not verified');
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
});

const accountReply=(authenticated,extra={})=>response({installed:true,authenticated,billingSource:authenticated===true?'subscription':'unknown',usage:'unknown',...extra});
test('a routine account check keeps a verified connection on screen while it runs',async()=>{
  const ui=await browser(),held=deferred();
  ui.setIntercept((request,next)=>request.path==='/api/providers/codex/account'?held.promise.then(next):next());
  ui.$('message-input').value='Keep working during the check';ui.fire('message-input','input');
  ui.state().accountsCheckedAt=0;ui.window.dispatchEvent(new UIEvent('focus'));await flush();
  assert.equal(ui.requests.filter(request=>request.path==='/api/providers/codex/account').length,2,'Refocusing after a minute checks the account again.');
  assert.equal(ui.$('codex-status-text').textContent,'Connected');assert.equal(ui.$('connection-notice').hidden,true);assert.equal(ui.$('conversation-state').textContent,'Ready');assert.equal(ui.$('send-button').disabled,false);
  held.resolve();await flush();assert.equal(ui.$('codex-status-text').textContent,'Connected');assert.equal(ui.state().accountRefresh,null);
});

test('a first check with nothing known yet shows compact progress without a notice',async()=>{
  const ui=await browser(),held=deferred();
  ui.setIntercept((request,next)=>request.path==='/api/providers/codex/account'?held.promise.then(next):next());
  delete ui.state().accounts.codex;ui.state().accountsCheckedAt=0;const checking=ui.window.relayUI.refreshAccounts();await flush();
  assert.equal(ui.$('codex-status-text').textContent,'Checking…');assert.equal(ui.$('conversation-state').textContent,'Checking connection');assert.equal(ui.$('connection-notice').hidden,true,'A first check does not interrupt the conversation.');
  held.resolve();await checking;assert.equal(ui.$('codex-status-text').textContent,'Connected');assert.equal(ui.$('conversation-state').textContent,'Ready');
});

test('a check that times out or fails keeps the last verified connection, and Settings says why it may be out of date',async()=>{
  const ui=await browser({workbench:true});let reply=null;
  ui.setIntercept((request,next)=>request.path==='/api/providers/codex/account'&&reply?reply():next());
  ui.$('message-input').value='Draft during checks';ui.fire('message-input','input');
  reply=()=>accountReply('unknown',{errorCategory:'timeout'});await ui.window.relayUI.refreshAccounts({force:true});
  assert.equal(ui.state().accounts.codex.authenticated,true);assert.equal(ui.$('codex-status-text').textContent,'Connected');assert.equal(ui.$('connection-notice').hidden,true);assert.equal(ui.$('conversation-state').textContent,'Ready');
  ui.$('relay-settings').click();await flush();
  const card=()=>ui.document.querySelectorAll('.settings-account').find(card=>card.dataset.provider==='codex'),refresh=()=>card().querySelectorAll('button').find(button=>button.textContent==='Refresh status');
  assert.match(card().textContent,/Connected/);assert.match(card().textContent,/Last checked/);assert.match(card().textContent,/last check timed out/i);
  reply=()=>response({error:'Account metadata is unavailable.'},503);refresh().click();await flush();
  assert.match(card().textContent,/Connected/);assert.match(card().textContent,/last check failed/i);assert.equal(ui.$('codex-status-text').textContent,'Connected');
  reply=()=>accountReply(false);ui.state().accountsCheckedAt=0;ui.window.dispatchEvent(new UIEvent('focus'));await flush();
  assert.equal(ui.$('codex-status-text').textContent,'Sign in required','A real change still replaces the last result.');assert.equal(ui.$('connection-notice-text').textContent,'Codex is not signed in.');assert.equal(ui.$('send-button').disabled,true);
  assert.match(card().textContent,/Sign-in required/);assert.doesNotMatch(card().textContent,/last check (timed out|failed)/i);
});

test('overlapping routine checks share one probe, and an older answer cannot overwrite a newer recheck',async()=>{
  const ui=await browser(),older=deferred();let probes=0;
  ui.setIntercept((request,next)=>{if(request.path!=='/api/providers/codex/account')return next();probes++;return probes===1?older.promise.then(()=>accountReply(true)):accountReply(false);});
  ui.state().accountsCheckedAt=0;const routine=ui.window.relayUI.refreshAccounts(),again=ui.window.relayUI.refreshAccounts();ui.window.dispatchEvent(new UIEvent('focus'));await flush();
  assert.equal(probes,1,'Routine checks that overlap share the probe already running.');
  const explicit=ui.window.relayUI.refreshAccounts({force:true});await flush();assert.equal(probes,2,'An explicit recheck asks again instead of reusing an older answer.');
  await explicit;assert.equal(ui.$('codex-status-text').textContent,'Sign in required');
  older.resolve();await routine;await again;await flush();
  assert.equal(ui.$('codex-status-text').textContent,'Sign in required','The older answer arrives last but cannot restore Connected.');assert.equal(ui.state().accounts.codex.authenticated,false);
});

test('an explicit recheck keeps its progress until its own answer arrives',async()=>{
  const ui=await browser(),older=deferred(),newer=deferred();let probes=0;
  ui.setIntercept((request,next)=>{if(request.path!=='/api/providers/codex/account')return next();const call=++probes;return (call===1?older:newer).promise.then(()=>accountReply(call===1));});
  delete ui.state().accounts.codex;ui.state().accountsCheckedAt=0;const routine=ui.window.relayUI.refreshAccounts();await flush();
  const explicit=ui.window.relayUI.refreshAccounts({force:true});await flush();assert.equal(probes,2);
  older.resolve();await routine;await flush();assert.equal(ui.$('codex-status-text').textContent,'Checking…','The recheck is still running after the older answer arrives.');
  newer.resolve();await explicit;assert.equal(ui.$('codex-status-text').textContent,'Sign in required');
});

test('a CLI removed after a failed check shows as not installed, without the earlier failure',async()=>{
  const providers={codex:{available:true},claude:{available:true}},ui=await browser({workbench:true,providers});
  ui.setIntercept((request,next)=>request.path==='/api/providers/codex/account'?accountReply('unknown',{errorCategory:'timeout'}):next());
  await ui.window.relayUI.refreshAccounts({force:true});assert.equal(ui.$('codex-status-text').textContent,'Connected');
  providers.codex.available=false;await ui.window.relayUI.refresh();await ui.window.relayUI.refreshAccounts({force:true});
  assert.equal(ui.$('codex-status-text').textContent,'Not installed');assert.equal(ui.$('connection-notice-text').textContent,'Codex is not installed.');assert.equal(ui.$('connection-action').textContent,'Use Claude');
  ui.$('relay-settings').click();await flush();const card=ui.document.querySelectorAll('.settings-account').find(card=>card.dataset.provider==='codex').textContent;
  assert.match(card,/Not installed/);assert.doesNotMatch(card,/latest check|Not yet/i);
});

test('Settings shows every connection at once, with progress on the card being rechecked',async()=>{
  const ui=await browser({workbench:true}),held=deferred();ui.$('relay-settings').click();await flush();
  ui.setIntercept((request,next)=>request.path==='/api/providers/codex/account'?held.promise.then(next):next());
  const text=provider=>ui.document.querySelectorAll('.settings-account').find(card=>card.dataset.provider===provider)?.textContent;
  ui.document.querySelectorAll('.settings-account')[0].querySelectorAll('button').find(button=>button.textContent==='Refresh status').click();await flush();
  assert.match(text('codex'),/Checking…/);assert.match(text('claude'),/Connected/,'A slow Codex check does not hide Claude.');assert.doesNotMatch(text('claude'),/Checking…/);
  assert.equal(ui.$('settings').getAttribute('aria-busy'),null,'The dialog stays usable while the check runs.');
  held.resolve();await flush();assert.match(text('codex'),/Connected/);assert.doesNotMatch(text('codex'),/Checking…/);
});

test('Settings retries a connection that has not been checked successfully yet',async()=>{
  const ui=await browser({workbench:true,accountErrors:['codex']});ui.$('relay-settings').click();await flush();
  const card=()=>ui.document.querySelectorAll('.settings-account').find(card=>card.dataset.provider==='codex');
  assert.match(card().textContent,/Status unavailable/);assert.match(card().textContent,/Account metadata is unavailable/);
  ui.setIntercept((request,next)=>request.path==='/api/providers/codex/account'?accountReply(true):next());
  card().querySelectorAll('button').find(button=>button.textContent==='Try again').click();await flush();
  assert.match(card().textContent,/Connected/);assert.equal(ui.$('codex-status-text').textContent,'Connected');
});

test('setup shows progress while it refreshes connections, and none after a check has failed',async()=>{
  const ui=await browser({empty:true,existing:false,setup:true,accountErrors:['codex']});ui.document.querySelector('.onboarding-cta').click();await flush();
  const status=provider=>ui.document.querySelectorAll('.setup-agent').find(card=>card.dataset.provider===provider).querySelector('.setup-account-state').textContent;
  assert.equal(status('codex'),'Not verified','A failed check does not look like it is still running.');assert.match(status('claude'),/^Connected/);
  const held=deferred();ui.setIntercept((request,next)=>/^\/api\/providers\/(codex|claude)\/account$/.test(request.path)?held.promise.then(next):next());
  ui.findButton('Refresh').click();await flush();assert.equal(status('claude'),'Checking…');
  held.resolve();await flush();assert.match(status('claude'),/^Connected/);
  ui.setIntercept((request,next)=>request.path==='/api/providers/codex/account'?accountReply('unknown',{errorCategory:'timeout'}):next());
  ui.state().accountsCheckedAt=0;ui.window.dispatchEvent(new UIEvent('focus'));await flush();assert.equal(status('codex'),'Check timed out');
});

test('an explicit recheck reloads the model list, but opening Settings does not',async()=>{
  const ui=await browser({workbench:true,insights:true}),models=()=>ui.requests.filter(request=>request.path==='/api/providers/codex/models').length,before=models();
  ui.$('relay-settings').click();await flush();assert.equal(models(),before,'Opening Settings does not ask Codex for its models again.');
  ui.document.querySelectorAll('.settings-account')[0].querySelectorAll('button').find(button=>button.textContent==='Refresh status').click();await flush();
  assert(models()>before,'A connection that may have changed loads its models again.');
});

for(const billingSource of ['api','unknown'])test('known '+billingSource+' billing waits for explicit session confirmation',async()=>{
  const ui=await browser({billingSource});ui.$('message-input').value='Explicitly billed request';ui.fire('message-input','input');
  assert.equal(ui.$('send-button').disabled,true);assert.equal(ui.$('conversation-state').textContent,'Review billing');
  ui.fire('composer','submit');await flush();assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
  ui.window.relayBillingConfirmed=true;await ui.window.relayUI.refresh();assert.equal(ui.$('send-button').disabled,false);
});

test('workspace header, folder metadata and idle state have distinct concise information',async()=>{
  const ui=await browser({moreProjects:true});assert.equal(ui.$('conversation-title').textContent,'Example workspace');assert.equal(ui.$('conversation-subtitle').textContent,'Conversation');assert.equal(ui.$('conversation-state').textContent,'Ready');assert.equal(ui.$('workspace-count').textContent,'2');
  assert.deepEqual(ui.document.querySelectorAll('.workspace-item-meta').map(item=>item.textContent),['2 folders','1 folder']);
  assert.doesNotMatch(ui.$('workspace-list').textContent,/shared chat|Switch assistants|One conversation/i);assert.doesNotMatch(ui.$('conversation-subtitle').textContent,/folder|switch|shared/i);
  const conversation=ui.canonical.get('project-one');conversation.lastRun={provider:'claude',effectiveModel:'previous-provider-model'};await ui.window.relayUI.refresh();assert.doesNotMatch(ui.$('conversation-subtitle').textContent,/previous-provider-model/,'A model used by the other provider cannot label the current selection.');
});

test('quota, active execution and pending approval use distinct human-readable states',async()=>{
  const ui=await browser(),conversation=ui.canonical.get('project-one');
  conversation.status='incomplete';conversation.lastRun={provider:'codex',errorCategory:'quota'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('conversation-state').textContent,'Stopped');assert.equal(ui.$('continuation').hidden,false);assert.equal(ui.$('select-claude').disabled,false);assert.match(ui.$('continuation-text').textContent,/usage limit/i);assert.match(ui.$('continue-button').textContent,/^Continue with Claude/);
  assert.equal(ui.state().provider,'codex','A limit does not silently switch the selected assistant.');assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
  ui.$('continue-button').click();await flush();const continuation=ui.requests.filter(request=>request.path.endsWith('/continue'));assert.equal(continuation.length,1);assert.equal(continuation[0].body.provider,'claude');assert.equal(conversation.provider,'claude');
  conversation.status='running';conversation.activeRun={provider:'codex'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('conversation-state').textContent,'Running');assert.equal(ui.$('continuation').hidden,true);assert.equal(ui.$('stop-button').hidden,false);
  conversation.pendingApprovals=[{id:'approval-one',runId:'run-one',provider:'codex',kind:'command',command:'git status'}];await ui.window.relayUI.refresh();
  assert.equal(ui.$('conversation-state').textContent,'Approval required');
});

test('a failed Approve or Deny is shown on the page, and a request that is no longer pending disappears',async()=>{
  const ui=await browser({workbench:true}),conversation=ui.canonical.get('project-one'),answers=[];
  const cards=()=>ui.$('pending-approvals')?.querySelectorAll('article')||[],choice=text=>cards()[0].querySelectorAll('button').find(button=>button.textContent===text);
  conversation.status='running';conversation.activeRun={provider:'codex'};conversation.pendingApprovals=[{id:'approval-one',runId:'run-one',provider:'codex',kind:'command',command:'git status'}];await ui.window.relayUI.refresh();
  // The run has already moved on, so the server no longer holds this request.
  ui.setIntercept((request,next)=>{if(!request.path.endsWith('/approval'))return next();answers.push(request.body);conversation.pendingApprovals=[];return response({error:'This approval is no longer pending.'},409);});
  choice('Approve').click();await flush();
  assert.deepEqual(answers,[{runId:'run-one',approvalId:'approval-one',allow:true}]);assert.equal(ui.$('notice').hidden,false);assert.equal(ui.$('notice-text').textContent,'This approval is no longer pending.');assert.equal(cards().length,0,'The stale request disappears.');
  // A failure while the request is still pending keeps the card, and its buttons work again.
  conversation.pendingApprovals=[{id:'approval-two',runId:'run-one',provider:'codex',kind:'command',command:'npm test'}];await ui.window.relayUI.refresh();
  ui.setIntercept((request,next)=>{if(!request.path.endsWith('/approval'))return next();answers.push(request.body);return response({error:'Local server error.'},500);});
  choice('Deny').click();choice('Deny').click();await flush();
  assert.equal(answers.length,2,'A second click while the answer is being sent does nothing.');assert.deepEqual(answers[1],{runId:'run-one',approvalId:'approval-two',allow:false});
  assert.equal(ui.$('notice-text').textContent,'Local server error.');assert.equal(cards().length,1);assert.equal(choice('Deny').disabled,false);assert.equal(ui.$('workbench-error').hidden,true);
});

test('shipped markup has one conversation header and retains distinct primary controls',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const tags=[...html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)];
  const ids=tags.map(match=>match[2]);assert.equal(new Set(ids).size,ids.length,'Control IDs must be unique.');
  for(const id of ['create-workspace','add-first-project','ask-friend','open-setup','relay-settings','connect-assistant','connection-action'])assert.equal(ids.filter(value=>value===id).length,1,'Expected one '+id+' control.');
  assert.equal([...html.matchAll(/class="conversation-header"/g)].length,1);assert.doesNotMatch(html,/class="topbar"/);
  const tag=id=>tags.find(match=>match[2]===id)?.[0]||'';
  assert.match(tag('add-project'),/\bhidden(?:\s|>|=)/);assert.doesNotMatch(tag('create-workspace'),/\bhidden(?:\s|>|=)/);
  assert.match(tag('project-select'),/aria-hidden="true"/);assert.match(tag('project-select'),/tabindex="-1"/);
});

test('composer model and effort choices use provider metadata and save without sending a prompt',async()=>{
  const ui=await browser({insights:true});assert.equal(ui.$('model-select').disabled,false);assert.equal(ui.$('effort-select').disabled,false);
  ui.$('model-select').value='model-one';ui.fire('model-select','change');await flush();ui.$('effort-select').value='high';ui.fire('effort-select','change');await flush();
  assert.equal(ui.state().model,'model-one');assert.equal(ui.state().effort,'high');assert.match(ui.$('model-description').textContent,/Model One.*High/);
  const saved=ui.requests.filter(request=>request.path.endsWith('/provider')).at(-1);assert.equal(saved.body.effort,'high');assert.equal(saved.body.model,'model-one');assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
  ui.$('model-select').value='model-two';ui.fire('model-select','change');await flush();assert.equal(ui.state().effort,null);assert.deepEqual(ui.$('effort-select').children.map(option=>option.value),['','low','medium']);
  ui.$('model-select').value='model-one';ui.fire('model-select','change');await flush();assert.equal(ui.state().effort,'high');
});

test('a model or effort that could not be saved does not stay selected in the composer',async()=>{
  const ui=await browser({insights:true});
  ui.$('model-select').value='model-one';ui.fire('model-select','change');await flush();assert.equal(ui.state().model,'model-one');
  ui.setIntercept((request,next)=>request.path.endsWith('/provider')?response({error:'The selection could not be saved.'},500):next());
  ui.$('model-select').value='model-two';ui.fire('model-select','change');await flush();
  assert.match(ui.$('notice-text').textContent,/could not be saved/);
  assert.equal(ui.$('model-select').value,'model-one','The picker shows the model the next run uses.');
  ui.$('effort-select').value='high';ui.fire('effort-select','change');await flush();
  assert.equal(ui.$('effort-select').value,'','The effort picker shows the saved default.');
  await ui.window.relayUI.refresh();assert.deepEqual([ui.$('model-select').value,ui.$('effort-select').value],['model-one','']);
  ui.setIntercept(null);ui.$('effort-select').value='high';ui.fire('effort-select','change');await flush();
  assert.deepEqual([ui.state().effort,ui.$('effort-select').value],['high','high'],'A choice that is saved stays selected.');
});

test('a custom model can be entered in the composer without starting inference',async()=>{
  const ui=await browser({insights:true});ui.$('model-select').value='__custom__';ui.fire('model-select','change');await flush();assert.equal(ui.$('custom-model-editor').hidden,false);ui.$('custom-model-input').value='custom-model-id';ui.$('save-custom-model').click();await flush();assert.equal(ui.state().model,'custom-model-id');assert.equal(ui.$('model-select').value,'custom-model-id');assert.equal(ui.$('custom-model-editor').hidden,true);assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
});

test('Enter in the custom model field saves the model instead of sending the draft',async()=>{
  const ui=await browser({insights:true});ui.$('message-input').value='Draft for the new model';ui.$('model-select').value='__custom__';ui.fire('model-select','change');await flush();
  ui.$('custom-model-input').value='custom-model-id';const enter=new UIEvent('keydown',{key:'Enter'});ui.$('custom-model-input').dispatchEvent(enter);await flush();
  assert.equal(enter.defaultPrevented,true,'The field is inside the composer form, so an unhandled Enter submits the draft.');assert.equal(ui.state().model,'custom-model-id');assert.equal(ui.$('custom-model-editor').hidden,true);assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
});

test('Git inspector sends workspace-scoped reads and shows changes and commit history',async()=>{
  const ui=await browser({insights:true});ui.$('open-git').click();await flush();assert.equal(ui.$('git-panel').hidden,false);assert.match(ui.$('git-summary').textContent,/feature\/design/);assert.match(ui.$('git-content').textContent,/app.js/);
  const request=ui.requests.find(row=>row.path==='/api/git');assert.equal(request.projectId,'project-one');assert.equal(request.method,'GET');ui.$('git-commits-tab').click();await flush();assert.match(ui.$('git-content').textContent,/Improve workspace navigation/);ui.$('open-git').click();assert.equal(ui.$('git-panel').hidden,true);
});

test('one side panel shows at a time: Agents opens first on docked layouts, the last choice is remembered, and changed files open a line diff',async()=>{
  const ui=await browser({insights:true,agentsUI:true,wide:true});await flush();
  assert.equal(ui.$('agents-panel').hidden,false,'Agents opens first on a docked layout.');assert.equal(ui.$('git-panel').hidden,true);assert.equal(ui.$('open-agents').getAttribute('aria-expanded'),'true');
  ui.$('open-git').click();await flush();
  assert.equal(ui.$('git-panel').hidden,false);assert.equal(ui.$('agents-panel').hidden,true,'Git takes the place of Agents.');assert.equal(ui.storage.get('throughline:side-panel'),'git');
  assert(ui.requests.some(row=>row.path==='/api/git'));
  const file=ui.document.querySelectorAll('.git-file')[0];assert.equal(file.tagName,'BUTTON');file.click();await flush();
  const diff=ui.requests.find(row=>row.path==='/api/git/diff');assert.equal(diff.projectId,'project-one');assert.equal(ui.$('diff-dialog').open,true);assert.equal(ui.$('diff-title').textContent,'app.js');
  const lines=ui.document.querySelectorAll('.diff-line');assert.deepEqual(lines.map(line=>line.className.replace('diff-line ','')),['hunk','context','del','add']);assert.equal(lines[2].children.at(-1).textContent,'-- old SQL comment','Removed lines that start with dashes are content, not file headers.');assert.match(ui.$('diff-meta').textContent,/\+1 -1/);
  ui.$('open-git').click();assert.equal(ui.storage.get('throughline:side-panel'),'none');
  const git=await browser({insights:true,agentsUI:true,wide:true,stored:{'throughline:side-panel':'git'}});await flush();
  assert.equal(git.$('git-panel').hidden,false,'The last panel chosen opens again.');assert.equal(git.$('agents-panel').hidden,true);
  const none=await browser({insights:true,agentsUI:true,wide:true,stored:{'throughline:side-panel':'none'}});await flush();
  assert.equal(none.$('git-panel').hidden,true);assert.equal(none.$('agents-panel').hidden,true,'A closed panel stays closed.');
  const narrow=await browser({insights:true,agentsUI:true});await flush();
  assert.equal(narrow.$('git-panel').hidden,true);assert.equal(narrow.$('agents-panel').hidden,true,'Overlay layouts start with no panel open.');
});

test('Gemini quota uses the reported default model and shows absolute and disabled buckets without percentage bars',async()=>{
  const windows={gemini:{available:true,source:'antigravity-acp',defaultModel:'gemini-argon',windows:[{id:'flash',label:'5-hour · Flash',usedPercent:20,scopes:['flash']},{id:'argon',label:'Weekly · Argon',usedPercent:100,scopes:['argon']},{id:'units',label:'Daily · Gemini',remainingAmount:1200,scopes:['gemini']},{id:'disabled',label:'Weekly · Other',disabled:true,scopes:[]}]}};
  const ui=await browser({insights:true,workbench:true,providers:{gemini:{available:true}},authenticated:{codex:true,claude:true,gemini:true},billingSource:{codex:'subscription',claude:'subscription',gemini:'subscription'},usage:windows});await ui.window.relayUI.refreshAccounts({force:true});await flush();
  ui.$('select-gemini').click();await flush();assert.match(ui.$('gemini-usage').textContent,/0% left.*Weekly limit for Argon/,'A limit for some models says which.');assert.doesNotMatch(ui.$('gemini-usage').textContent,/80%/);
  ui.state().model='gemini-flash';ui.window.dispatchEvent(new UIEvent('relay-state'));assert.match(ui.$('usage-chip').textContent,/80% left/);
  ui.window.relayUsage.open('gemini');await flush();const content=ui.$('usage-details');assert.match(content.textContent,/1,200 units left/);assert.match(content.textContent,/Disabled/);assert.equal(content.querySelectorAll('.usage-track').length,2);
  ui.state().model=null;ui.state().usage.gemini.defaultModel=null;ui.window.dispatchEvent(new UIEvent('relay-state'));assert.equal(ui.$('gemini-usage').hidden,true,'An unknown provider default never assumes Flash.');
  ui.$('relay-settings').click();await flush();assert.match(ui.$('settings-content').textContent,/1,200 units left/);assert.match(ui.$('settings-content').textContent,/Disabled/);assert.doesNotMatch(ui.$('settings-content').textContent,/NaN/);
});

test('unavailable Gemini quota never shows estimates or stale percentage rows',async()=>{
  const ui=await browser({insights:true,providers:{gemini:{available:true}},authenticated:{codex:true,claude:true,gemini:true},usage:{gemini:{available:false,reason:'Google has not reported quota.',windows:[{id:'stale',label:'Weekly',usedPercent:15}]}}});await ui.window.relayUI.refreshAccounts({force:true});await flush();
  ui.window.relayUsage.open('gemini');await flush();assert.equal(ui.$('gemini-usage').hidden,true);assert.match(ui.$('usage-details').textContent,/Google has not reported quota/);assert.equal(ui.$('usage-details').querySelectorAll('.usage-track').length,0);assert.doesNotMatch(ui.$('usage-details').textContent,/85%/);
});

test('signing out hides cached Gemini quota and discards a late reading from that account',async()=>{
  const ui=await browser({insights:true,providers:{gemini:{available:true}},authenticated:{codex:true,claude:true,gemini:true},usage:{gemini:{available:true,defaultModel:'gemini-flash',windows:[{id:'flash',label:'Weekly · Flash',usedPercent:63,scopes:['flash']}]}}}),held=deferred();let calls=0;
  ui.setIntercept((request,next)=>request.path==='/api/providers/gemini/usage'&&++calls===1?held.promise:next());ui.window.relayUsage.open('gemini');await flush();
  ui.state().accounts.gemini.authenticated=false;ui.window.dispatchEvent(new UIEvent('relay-state'));held.resolve({ok:true,json:async()=>({available:true,defaultModel:'gemini-flash',windows:[{id:'old',label:'Weekly · Flash',usedPercent:5,scopes:['flash']}]})});await flush();assert.equal(ui.$('gemini-usage').hidden,true);assert.match(ui.$('usage-details').textContent,/Not signed in/);assert.equal(ui.$('usage-details').querySelectorAll('.usage-track').length,0);
  ui.state().accounts.gemini.authenticated=true;ui.window.dispatchEvent(new UIEvent('relay-state'));await flush();assert.match(ui.$('gemini-usage').textContent,/37% left/);assert.equal(calls,2);
});

test('plan usage shows remaining percent for both agents and the selected model',async()=>{
  const windows={codex:{provider:'codex',available:true,windows:[{id:'primary',label:'5-hour',usedPercent:80,resetsAt:null},{id:'secondary',label:'Weekly',usedPercent:18,resetsAt:null}]},claude:{provider:'claude',available:true,windows:[{id:'five_hour',label:'5-hour',usedPercent:20,resetsAt:null},{id:'seven_day_opus',label:'Weekly · Opus',usedPercent:95,resetsAt:null,scope:'opus'}]}};
  const ui=await browser({insights:true,usage:windows});await ui.window.relayUI.refreshAccounts({force:true});await flush();
  assert.equal(ui.$('codex-usage').hidden,false);assert.match(ui.$('codex-usage').textContent,/^20% left5-hour limit$/,'Limits are named in words, not abbreviations.');assert.doesNotMatch(ui.$('codex-usage').textContent,/82%/,'Plan usage shows only the tightest window; the card lists all of them.');assert.match(ui.$('claude-usage').textContent,/80% left.*5-hour limit/);
  assert.equal(ui.$('codex-usage').querySelector('.usage-bar').style['--left'],'20%','A bar shows what is left.');assert.doesNotMatch(ui.$('claude-usage').textContent,/Opus/,'Model-specific limits appear only for that model.');
  assert.equal(ui.$('usage-chip').textContent,'5-hour · 20% left');assert.match(ui.$('usage-chip').className,/\blow\b/);
  ui.$('select-claude').click();await flush();ui.state().model='claude-opus';ui.window.dispatchEvent(new UIEvent('relay-state'));assert.equal(ui.$('usage-chip').textContent,'Opus · 5% left');assert.match(ui.$('usage-chip').className,/critical/);
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0,'Reading usage never starts inference.');
});

test('separate Claude and Codex chats merge by time into the current workspace after review, without inference',async()=>{
  const ui=await browser({historyUI:true,setup:true});const id=ui.state().conversation.id;ui.canonical.get('project-one').messages.push({id:'existing',role:'user',text:'Keep existing history'});
  assert.equal(ui.$('previous-chats-notice').hidden,false);assert.match(ui.$('previous-chats-text').textContent,/Found 2 previous conversations/);
  assert.equal(ui.$('import-dialog').open,false,'Discovery suggests chats without interrupting the workspace.');
  ui.$('review-previous-chats').click();await flush();assert.equal(ui.$('import-dialog').open,true);assert.equal(ui.$('import-workspace-name').textContent,'Example workspace');assert.equal(ui.$('confirm-import').disabled,true);
  const lists=ui.requests.filter(row=>row.path==='/api/import-sources');assert.deepEqual(lists.map(row=>row.params.provider).sort(),['claude','codex']);assert(lists.every(row=>row.params.scope==='workspace'&&row.params.projectId==='project-one'));
  const sessions=ui.document.querySelectorAll('.import-session');assert.equal(sessions.length,2);assert.ok(sessions.every(session=>session.getAttribute('aria-checked')==='false'),'Nothing is selected automatically.');for(const session of sessions)session.click();await flush();
  assert.match(ui.$('import-preview').textContent,/2 conversations, merged by time/);assert.match(ui.$('import-preview').textContent,/Plan the API.*Build the API.*Claude planned it.*Codex built it/s,'The preview interleaves both chats in original time order.');
  assert.equal(ui.$('confirm-import').disabled,true,'Importing requires confirming the review.');ui.$('import-confirm').checked=true;ui.fire('import-confirm','change');assert.equal(ui.$('confirm-import').disabled,false);
  ui.$('confirm-import').click();await flush();
  const sent=ui.requests.find(row=>row.path==='/api/import-sources/import');assert.equal(sent.body.projectId,'project-one');assert.deepEqual(sent.body.sessions.map(row=>row.approvedDigest).sort(),['digest-claude-one','digest-codex-one']);
  assert.equal(ui.state().conversation.id,id);assert.deepEqual([...ui.state().conversation.messages.map(row=>row.text)],['Keep existing history','Plan the API','Build the API','Claude planned it','Codex built it']);
  assert.match(ui.$('import-result').textContent,/Merged 4 messages into Example workspace/);assert.equal(ui.$('import-dialog').open,false);assert.equal(ui.$('previous-chats-notice').hidden,true);assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
});

test('Not now is saved for its workspace and previous chats stay available manually',async()=>{
  const ui=await browser({insights:true,setup:true,moreProjects:true});
  assert.equal(ui.$('previous-chats-notice').hidden,false);ui.$('dismiss-previous-chats').click();await flush();
  const dismissal=ui.requests.find(request=>request.path==='/api/projects/project-one'&&request.body?.previousConversationsDismissed);
  assert(dismissal);assert.equal(ui.projects[0].previousConversationsDismissed,true);assert.equal(ui.projects[0].name,'Example workspace');assert.equal(ui.$('previous-chats-notice').hidden,true);
  await ui.switchProject('project-two');assert.equal(ui.$('previous-chats-notice').hidden,true);
  await ui.switchProject('project-one');await ui.window.relayUI.refreshProjects();await flush();assert.equal(ui.$('previous-chats-notice').hidden,true);
  assert.equal(ui.requests.filter(request=>request.path==='/api/import-sources'&&request.projectId==='project-one').length,2,'Returning to a dismissed workspace does not repeat discovery.');
  ui.$('open-import').click();await flush();assert.equal(ui.$('import-dialog').open,true);assert.equal(ui.document.querySelectorAll('.import-session').length,2);
});

test('late discovery results stay with their workspace, and the empty workspace is not prompted',async()=>{
  const ui=await browser({insights:true,moreProjects:true}),held=deferred();
  ui.setIntercept((request,next)=>request.path==='/api/import-sources'&&request.projectId==='project-one'?held.promise.then(next):next());
  ui.window.dispatchEvent(new UIEvent('relay-setup-ready'));await flush();assert.equal(ui.$('previous-chats-notice').hidden,true);
  await ui.switchProject('project-two');assert.equal(ui.$('previous-chats-notice').hidden,true);
  held.resolve();await flush();assert.equal(ui.state().projectId,'project-two');assert.equal(ui.$('previous-chats-notice').hidden,true,'Another project’s conversations never appear in the current workspace.');
  await ui.switchProject('project-one');assert.match(ui.$('previous-chats-text').textContent,/Found 2 previous conversations/);
  assert.equal(ui.requests.filter(request=>request.path==='/api/import-sources'&&request.projectId==='project-one').length,2,'Completed discovery is reused for this session.');
  ui.$('review-previous-chats').click();await flush();await ui.switchProject('project-two');assert.equal(ui.$('import-dialog').open,false,'Changing workspaces closes the previous workspace’s review.');
});

test('discovery ignores already merged chats and rechecks when workspace folders change',async()=>{
  const ui=await browser({insights:true});
  ui.setIntercept(async(request,next)=>{
    const result=next();if(request.path!=='/api/import-sources')return result;
    const payload=JSON.parse(await result.text());payload.sessions=payload.sessions.map(session=>({...session,imported:true}));return response(payload);
  });
  ui.window.dispatchEvent(new UIEvent('relay-setup-ready'));await flush();assert.equal(ui.$('previous-chats-notice').hidden,true);
  ui.$('open-import').click();await flush();assert.match(ui.$('import-list').textContent,/Previously merged/);assert.equal(ui.$('confirm-import').disabled,true);ui.$('close-import').click();
  ui.setIntercept(null);ui.projects[0].folders=[{id:'new',name:'new-app',path:'/workspace/new-app',available:true}];await ui.window.relayUI.refreshProjects();await flush();
  assert.match(ui.$('previous-chats-text').textContent,/Found 1 previous conversation/);ui.$('review-previous-chats').click();await flush();
  assert.match(ui.$('import-list').textContent,/Start new app/);assert.doesNotMatch(ui.$('import-list').textContent,/Plan the API/);
});

test('background discovery failures stay quiet, and a failed dismissal does not hide the suggestion permanently',async()=>{
  const ui=await browser({insights:true});
  ui.setIntercept((request,next)=>request.path==='/api/import-sources'?response({error:'Local history is unavailable.'},503):next());
  ui.window.dispatchEvent(new UIEvent('relay-setup-ready'));await flush();assert.equal(ui.$('previous-chats-notice').hidden,true);assert.equal(ui.$('notice').hidden,true);assert.equal(ui.$('import-dialog').open,false);
  ui.$('open-import').click();await flush();assert.match(ui.$('import-error').textContent,/Local history is unavailable/);
  ui.setIntercept(null);ui.$('refresh-imports').click();await flush();assert.equal(ui.document.querySelectorAll('.import-session').length,2);ui.$('close-import').click();
  const other=await browser({insights:true,setup:true});
  other.setIntercept((request,next)=>request.path==='/api/projects/project-one'&&request.method==='POST'?response({error:'Could not save preferences.'},503):next());
  other.$('dismiss-previous-chats').click();await flush();assert.equal(other.$('previous-chats-notice').hidden,false);assert.match(other.$('notice-text').textContent,/Could not save this choice/);
  assert.equal(other.projects[0].previousConversationsDismissed,undefined);
});

test('the setup launcher shows only while setup is unfinished, and Settings reopens the guide',async()=>{
  const fresh=await browser({setup:true,savedPreferences:{onboarding:{step:1}}});assert.equal(fresh.$('open-setup').hidden,false);assert.equal(fresh.$('setup-dialog').open,false,'Setup does not interrupt someone who already has workspaces.');
  fresh.$('open-setup').click();await flush();assert.equal(fresh.$('setup-dialog').dataset.screen,'flow','Resuming skips the welcome.');assert.match(fresh.$('setup-step-status').textContent,/2 of 3/);assert.equal(fresh.$('close-setup').textContent,'Skip for now');
  fresh.$('close-setup').click();await flush();assert.equal(fresh.$('setup-dialog').open,false);assert.equal(fresh.$('open-setup').hidden,true,'Closing setup removes the sidebar launcher.');
  const done=await browser({setup:true,workbench:true,savedPreferences:{onboarding:{step:2,completedAt:'2026-10-29T00:00:00.000Z'}}});assert.equal(done.$('open-setup').hidden,true);
  done.$('relay-settings').click();await flush();assert.equal(done.$('settings').open,true);done.$('open-setup-guide').click();await flush();
  assert.equal(done.$('settings').open,false);assert.equal(done.$('setup-dialog').open,true);assert.match(done.$('setup-step-status').textContent,/1 of 3/,'The guide starts from the beginning once setup is complete.');
  assert.equal(done.$('close-setup').textContent,'Close');assert.equal(done.$('setup-back').disabled,true);
  done.$('setup-next').click();await flush();done.$('setup-next').click();await flush();assert.equal(done.$('setup-next').textContent,'Done');
  done.$('setup-next').click();await flush();assert.equal(done.$('setup-dialog').open,false,'Reviewing skips the welcome and the summary.');
});

test('export shows what a shareable conversation file contains before saving it',async()=>{
  const ui=await browser({historyUI:true});assert.equal(ui.$('open-export').disabled,true,'There is nothing to export yet.');
  ui.canonical.get('project-one').messages.push({id:'m1',role:'user',text:'Plan checkout'});await ui.window.relayUI.refresh();assert.equal(ui.$('open-export').disabled,false);
  ui.$('open-export').click();await flush();assert.equal(ui.$('export-dialog').open,true);
  let request=ui.requests.filter(row=>row.path==='/api/conversation/export').at(-1);assert.equal(request.projectId,'project-one');assert.equal(request.params.redact,'1');assert.equal(request.params.activity,'0');assert.equal(request.params.range,'all');
  assert.match(ui.$('export-summary').textContent,/Cleaned 1 message with possible secrets/);assert.equal(ui.$('export-download').disabled,false);
  ui.$('export-redact').checked=false;ui.fire('export-redact','change');await flush();request=ui.requests.filter(row=>row.path==='/api/conversation/export').at(-1);assert.equal(request.params.redact,'0');assert.match(ui.$('export-summary').textContent,/Review before sharing/);
  ui.$('export-download').click();ui.$('export-markdown').click();assert.equal(ui.requests.filter(row=>/\/(?:messages|continue)$/.test(row.path)).length,0);
});

test('a shared conversation file merges into the open workspace without another destination or folder step',async()=>{
  const ui=await browser({insights:true});ui.$('open-import').click();await flush();
  const shared={schema:'ai-relay.conversation',version:1,id:'shared-one',exportedAt:'2026-10-21T00:00:00.000Z',workspace:{name:'Shop',folders:['web']},messages:[{id:'s1',role:'user',text:'Ship it',createdAt:'2026-10-20T09:00:00.000Z'},{id:'s2',role:'assistant',provider:'claude',text:'Shipped',createdAt:'2026-10-20T09:01:00.000Z'}],digest:'from-sender'};
  ui.$('import-file').files=[{size:600,text:async()=>JSON.stringify(shared)}];ui.fire('import-file','change');await flush();
  assert.equal(ui.requests.find(row=>row.path==='/api/import-sources/file-preview').body.package.id,'shared-one');
  assert.match(ui.$('import-preview').textContent,/import files only from people you trust/);assert.match(ui.$('import-preview').textContent,/User.*Ship it.*Claude.*Shipped/s);
  assert.equal(ui.$('import-workspace-name').textContent,'Example workspace');assert.equal(ui.$('import-target'),null);assert.equal(ui.$('import-folder-path'),null);
  ui.$('import-confirm').checked=true;ui.fire('import-confirm','change');assert.equal(ui.$('confirm-import').disabled,false);ui.$('confirm-import').click();await flush();
  const sent=ui.requests.find(row=>row.path==='/api/import-sources/import');assert.equal(sent.body.projectId,'project-one');assert.equal(sent.body.files[0].approvedDigest,'digest-shared-one');assert.equal(sent.body.sessions.length,0);
  assert.equal(ui.projects.length,1);assert.equal(ui.state().projectId,'project-one');assert.deepEqual([...ui.state().conversation.messages.map(row=>row.text)],['Ship it','Shipped']);assert.equal(ui.requests.filter(row=>/\/(?:messages|continue)$/.test(row.path)).length,0);
});

test('a conversation file saved near the 2 MB limit opens again for import, and larger ones are still refused',async t=>{
  // As many messages as a file may hold, just under 2 MB as the server measures it. The saved file is indented, which takes it over 2 MB.
  const project={name:'Shop',folders:[{id:'web',name:'web',displayName:'web',path:'/Users/dev/shop/web'}]};
  const long=exportConversation({messages:Array.from({length:5000},(_,index)=>({id:'m'+index,role:index%2?'assistant':'user',...(index%2?{provider:'claude',model:'claude-opus-5-5'}:{}),text:`Step ${index}: `+'x'.repeat(300),createdAt:new Date(Date.UTC(2026,9,20,9,0,index)).toISOString()}))},project);
  const ui=await browser({insights:true});ui.canonical.get('project-one').messages.push({id:'m1',role:'user',text:'Plan checkout'});await ui.window.relayUI.refresh();
  ui.setIntercept((request,next)=>request.path==='/api/conversation/export'?response(long):next());
  const saved=[],createObjectURL=URL.createObjectURL;URL.createObjectURL=blob=>{saved.push(blob);return createObjectURL(blob);};t.after(()=>{URL.createObjectURL=createObjectURL;});
  ui.$('open-export').click();await flush();ui.$('export-download').click();
  const text=await saved.at(-1).text(),size=Buffer.byteLength(text);
  assert.ok(long.stats.omitted===0&&long.stats.bytes<2*1024*1024&&size>2*1024*1024,'The saved file is over 2 MB only because it is indented.');
  ui.$('close-export').click();ui.$('open-import').click();await flush();
  const previews=()=>ui.requests.filter(row=>row.path==='/api/import-sources/file-preview');
  ui.$('import-file').files=[{size,text:async()=>text}];ui.fire('import-file','change');await flush();
  assert.equal(ui.$('import-error').textContent,'');assert.equal(previews().at(-1)?.body.package.id,long.package.id);
  // The limit still applies to the conversation itself, and a file far over it is refused without being read.
  const over=JSON.stringify({...long.package,messages:long.package.messages.map((message,index)=>index?message:{...message,text:message.text+'x'.repeat(30000)})});
  ui.$('import-file').files=[{size:Buffer.byteLength(over),text:async()=>over}];ui.fire('import-file','change');await flush();
  assert.equal(ui.$('import-error').textContent,'This conversation file is larger than 2 MB.');assert.equal(previews().length,1);
  ui.$('import-file').files=[{size:5*1024*1024,text:async()=>assert.fail('A file far over the limit is not read.')}];ui.fire('import-file','change');await flush();
  assert.equal(ui.$('import-error').textContent,'This conversation file is larger than 2 MB.');assert.equal(previews().length,1);
});

test('selecting a folder does not open Files; its explicit browser keeps the workspace and folder scopes',async()=>{
  const ui=await browser({filesUI:true,insights:true});const picks=ui.document.querySelectorAll('.workspace-folder-pick');
  assert.deepEqual([...picks.map(pick=>pick.textContent)],['Frontend','Backend']);assert.equal(picks[0].getAttribute('aria-pressed'),'false','At the workspace level no one folder is selected.');
  assert.equal(ui.requests.some(request=>request.path==='/api/files'),false,'No directories are loaded just by selecting a workspace.');
  ui.$('toggle-explorer').click();await flush();
  assert.deepEqual([...ui.document.querySelectorAll('.tree-root').map(root=>root.textContent)],['Frontend','Backend'],'Workspace browsing shows all roots.');
  ui.$('close-files').click();
  picks[1].click();await flush();
  assert.equal(ui.$('files-dialog').open,false,'Selecting a folder leaves navigation in place.');
  ui.$('toggle-explorer').click();await flush();assert.deepEqual([...ui.document.querySelectorAll('.tree-root').map(root=>root.textContent)],['Backend']);
  assert.equal(ui.storage.get('ai-relay:folder:project-one'),'backend');assert.equal(ui.document.querySelectorAll('.workspace-folder-pick')[1].getAttribute('aria-pressed'),'true');
  assert.equal(ui.document.querySelectorAll('.workspace-folder-disclosure').length,0,'Folder management lives in Workspace settings.');assert(ui.$('workspace-folder-settings').textContent.includes('Add folder'));
});

test('changing export options keeps the current summary in place until the new one is ready',async()=>{
  const ui=await browser({insights:true});ui.canonical.get('project-one').messages.push({id:'m1',role:'user',text:'Plan checkout'});await ui.window.relayUI.refresh();
  ui.$('open-export').click();await flush();assert.match(ui.$('export-summary').textContent,/Messages/);
  const gate=deferred();ui.setIntercept(async(request,next)=>{if(request.path==='/api/conversation/export'&&request.params.activity==='1')await gate.promise;return next();});
  ui.$('export-activity').checked=true;ui.fire('export-activity','change');await flush();
  assert.match(ui.$('export-summary').textContent,/Messages/,'The summary is not swapped for a loading line, so the dialog keeps its size.');assert.equal(ui.$('export-summary').getAttribute('aria-busy'),'true');assert.equal(ui.$('export-download').disabled,true);
  gate.resolve();await flush();assert.equal(ui.$('export-summary').getAttribute('aria-busy'),null);assert.equal(ui.$('export-download').disabled,false);
});

test('code blocks are syntax colored without parsing HTML',async()=>{
  const ui=await browser();ui.canonical.get('project-one').messages.push({id:'a1',role:'assistant',provider:'codex',text:'Try this:\n```js\nconst total = sum(items); // <b>not markup</b>\n```'});await ui.window.relayUI.refresh();
  const kinds=ui.document.querySelectorAll('.code-block')[0].querySelectorAll('span').map(span=>span.className+':'+span.textContent);
  assert(kinds.includes('tok-keyword:const'));assert(kinds.includes('tok-function:sum'));assert(kinds.includes('tok-comment:// <b>not markup</b>'));
});

test('code blocks labelled with built-in object property names render as plain code',async()=>{
  const ui=await browser();ui.canonical.get('project-one').messages.push({id:'a1',role:'assistant',provider:'codex',text:'```constructor\nconst a = 1;\n```\n\n```__proto__\nlet b = 2;\n```\n\n```toString\nvar c = 3;\n```'});await ui.window.relayUI.refresh();
  assert.deepEqual(ui.document.querySelectorAll('.code-block').map(block=>block.querySelector('code').textContent),['const a = 1;\n','let b = 2;\n','var c = 3;\n']);
});

test('Find in the conversation matches text across formatting, skips interface labels and moves between matches',async()=>{
  const ui=await browser({searchUI:true});ui.canonical.get('project-one').messages.push({id:'u1',role:'user',text:'Where is the retry limit set?'},{id:'a1',role:'assistant',provider:'codex',text:'The **retry** limit is in `config.js`:\n```js\nconst retryLimit = 3;\n```'},{id:'u2',role:'user',text:'Raise the RETRY limit to 5.'});await ui.window.relayUI.refresh();
  const find=new UIEvent('keydown',{key:'f',ctrlKey:true});ui.document.dispatchEvent(find);assert.equal(find.defaultPrevented,true);assert.equal(ui.$('conversation-search').hidden,false);assert.equal(ui.document.activeElement,ui.$('conversation-search-input'));
  const search=async text=>{ui.$('conversation-search-input').value=text;ui.fire('conversation-search-input','input');await flush();},key=(key,shiftKey=false)=>ui.$('conversation-search-input').dispatchEvent(new UIEvent('keydown',{key,shiftKey})),texts=name=>[...ui.highlights.get(name)||[]].map(ui.rangeText),count=()=>ui.$('conversation-search-count').textContent;
  await search('retry');assert.deepEqual(texts('conversation-search'),['retry','retry','retry','RETRY']);assert.equal(count(),'1 of 4');assert.deepEqual(texts('conversation-search-current'),['retry']);
  key('Enter');assert.equal(count(),'2 of 4');key('Enter',true);key('Enter',true);assert.equal(count(),'4 of 4','Moving back from the first match wraps to the last.');assert.deepEqual(texts('conversation-search-current'),['RETRY']);
  await search('const retry');assert.deepEqual(texts('conversation-search'),['const retry'],'A match can span syntax-colored tokens.');
  await search('js');assert.equal(count(),'1 of 1','The code block language label is not conversation text.');
  await search('codex');assert.equal(count(),'No results','Author names, times and buttons are not conversation text.');assert.equal(texts('conversation-search').length,0);
});

test('Find in the conversation matches run steps, opens a step holding a match, follows re-renders and Escape returns to the composer',async()=>{
  const ui=await browser({searchUI:true}),chat=ui.canonical.get('project-one');chat.messages.push({id:'u1',role:'user',text:'Run the tests'},{id:'t1',role:'activity',text:'Ran npm test: 12 passed'},{id:'t2',role:'activity',text:'$ npm run lint\nfound 0 problems'},{id:'a1',role:'assistant',provider:'codex',text:'All tests pass.'});await ui.window.relayUI.refresh();
  ui.document.dispatchEvent(new UIEvent('keydown',{key:'f',ctrlKey:true}));const search=async text=>{ui.$('conversation-search-input').value=text;ui.fire('conversation-search-input','input');await flush();};
  await search('problems');assert.equal(ui.$('conversation-search-count').textContent,'1 of 1');assert.equal(ui.document.querySelector('pre[data-entry-id="t2"]').hidden,false,'The step holding the match opens.');
  await search('npm test');
  assert.equal(ui.$('conversation-search-count').textContent,'1 of 1');
  chat.messages.push({id:'a2',role:'assistant',provider:'codex',text:'Run npm test again after the change.'});await ui.window.relayUI.refresh();
  const attached=node=>{for(let current=node;current;current=current.parentNode)if(current===ui.$('messages'))return true;return false;};
  assert.equal(ui.$('conversation-search-count').textContent,'1 of 2');assert([...ui.highlights.get('conversation-search')].every(range=>attached(range.startContainer)),'Highlights move to the re-rendered messages.');
  const escape=new UIEvent('keydown',{key:'Escape'});ui.$('conversation-search-input').dispatchEvent(escape);
  assert.equal(escape.defaultPrevented,true);assert.equal(ui.$('conversation-search').hidden,true);assert.equal(ui.highlights.size,0);assert.equal(ui.document.activeElement,ui.$('message-input'));
});

test('Enter and Escape that finish or cancel an IME composition are left to the input method',async()=>{
  const ui=await browser({moreProjects:true,searchUI:true,filesUI:true});
  const key=(target,key,isComposing)=>{const event=new UIEvent('keydown',{key,isComposing});target.dispatchEvent(event);return event;};
  // The workspace filter opens its first match on Enter and clears on Escape.
  await ui.switchProject('project-two');ui.$('workspace-search').value='Example';ui.fire('workspace-search','input');
  assert.equal(key(ui.$('workspace-search'),'Enter',true).defaultPrevented,false);await flush();assert.equal(ui.state().projectId,'project-two');
  assert.equal(key(ui.$('workspace-search'),'Escape',true).defaultPrevented,false);assert.equal(ui.$('workspace-search').value,'Example');
  key(ui.$('workspace-search'),'Enter',false);await flush();assert.equal(ui.state().projectId,'project-one');
  key(ui.$('workspace-search'),'Escape',false);assert.equal(ui.$('workspace-search').value,'');
  // Escape closes the new workspace form, which has a name to type.
  ui.$('create-workspace').click();assert.equal(ui.$('project-panel').hidden,false);
  key(ui.document,'Escape',true);assert.equal(ui.$('project-panel').hidden,false);
  key(ui.document,'Escape',false);assert.equal(ui.$('project-panel').hidden,true);
  // Escape closes Find in the conversation and the file preview.
  ui.document.dispatchEvent(new UIEvent('keydown',{key:'f',ctrlKey:true}));assert.equal(ui.$('conversation-search').hidden,false);
  assert.equal(key(ui.$('conversation-search-input'),'Escape',true).defaultPrevented,false);assert.equal(ui.$('conversation-search').hidden,false);
  key(ui.$('conversation-search-input'),'Escape',false);assert.equal(ui.$('conversation-search').hidden,true);
  ui.$('file-preview').hidden=false;
  key(ui.window,'Escape',true);assert.equal(ui.$('file-preview').hidden,false);
  key(ui.window,'Escape',false);assert.equal(ui.$('file-preview').hidden,true);
});

test('Find in the conversation starts from the match in view, or the closest one above it',async()=>{
  const ui=await browser({searchUI:true});ui.canonical.get('project-one').messages.push({id:'u1',role:'user',text:'retry one'},{id:'u2',role:'user',text:'retry two'},{id:'u3',role:'user',text:'retry three'});await ui.window.relayUI.refresh();
  const place=tops=>ui.document.querySelectorAll('.message-text').forEach((node,index)=>{node.bounds={top:tops[index],bottom:tops[index]+20,height:20};});ui.$('messages-scroll').bounds={top:100,bottom:600,height:500};
  const search=async text=>{ui.$('conversation-search-input').value=text;ui.fire('conversation-search-input','input');await flush();},count=()=>ui.$('conversation-search-count').textContent;
  ui.document.dispatchEvent(new UIEvent('keydown',{key:'f',ctrlKey:true}));place([-400,200,900]);
  const before=ui.$('messages-scroll').scrollTop;await search('retry');assert.equal(count(),'2 of 3');assert.equal(ui.$('messages-scroll').scrollTop,before,'A match already in view does not scroll.');
  place([-900,-600,-300]);await search('retry t');assert.equal(count(),'2 of 2','With every match above the view, the closest one is current.');
  assert.equal(ui.$('messages-scroll').scrollTop,before-300-100-(500-20)/2,'The current match is scrolled to the middle of the view.');
});

test('Find in the conversation closes when another workspace opens',async()=>{
  const ui=await browser({searchUI:true,moreProjects:true});ui.canonical.get('project-one').messages.push({id:'u1',role:'user',text:'Check the retry limit'});await ui.window.relayUI.refresh();
  ui.document.dispatchEvent(new UIEvent('keydown',{key:'f',ctrlKey:true}));ui.$('conversation-search-input').value='retry';ui.fire('conversation-search-input','input');await flush();assert.equal(ui.$('conversation-search-count').textContent,'1 of 1');
  await ui.switchProject('project-two');assert.equal(ui.$('conversation-search').hidden,true,'Matches from the previous conversation are gone.');assert.equal(ui.highlights.size,0);
});

test('previous chats require an open workspace, with other projects available only by explicit choice',async()=>{
  const empty=await browser({insights:true,empty:true});assert.equal(empty.$('project-empty-state').hidden,false);assert.equal(empty.$('open-import').disabled,true);assert.equal(empty.$('import-first'),null);
  empty.$('open-import').click();await flush();assert.equal(empty.$('import-dialog').open,false);assert.equal(empty.requests.filter(request=>request.path==='/api/import-sources').length,0);
  const ui=await browser({insights:true});ui.$('open-import').click();await flush();assert.equal(ui.document.querySelectorAll('.import-session').length,2);assert.doesNotMatch(ui.$('import-list').textContent,/Start new app/);
  ui.document.querySelectorAll('[data-import-scope]').find(button=>button.dataset.importScope==='all').click();await flush();
  const session=ui.document.querySelectorAll('.import-session').find(button=>/Start new app/.test(button.textContent));assert(session);assert.equal(session.getAttribute('aria-checked'),'false');assert.equal(ui.$('confirm-import').disabled,true);
  session.click();await flush();ui.$('import-confirm').checked=true;ui.fire('import-confirm','change');ui.$('confirm-import').click();await flush();
  const sent=ui.requests.find(row=>row.path==='/api/import-sources/import');assert.equal(sent.body.projectId,'project-one');assert.equal(ui.projects.length,1);assert.equal(ui.state().projectId,'project-one');
});

test('import dialog filters conversations by agent using dropdown selector',async()=>{
  const ui=await browser({insights:true});
  ui.setIntercept((request,next)=>{
    if(request.path==='/api/import-sources'&&request.params.provider==='gemini'){
      return response({
        sessions:[{
          id:'gemini-one',
          provider:'gemini',
          title:'Review security findings',
          folder:'frontend',
          cwd:'/workspace/example/frontend',
          updatedAt:'2026-10-20T09:05:00.000Z'
        }],
        nextCursor:null
      });
    }
    return next();
  });
  ui.$('open-import').click();
  await flush();

  assert.equal(ui.$('import-provider-select').value,'all');
  assert.equal(ui.document.querySelectorAll('.import-session').length,3);

  ui.$('import-provider-select').value='codex';
  ui.fire('import-provider-select','change');
  await flush();
  let sessions=ui.document.querySelectorAll('.import-session');
  assert.equal(sessions.length,1);
  assert.match(sessions[0].textContent,/Build the API/);

  ui.$('import-provider-select').value='claude';
  ui.fire('import-provider-select','change');
  await flush();
  sessions=ui.document.querySelectorAll('.import-session');
  assert.equal(sessions.length,1);
  assert.match(sessions[0].textContent,/Plan the API/);

  ui.$('import-provider-select').value='gemini';
  ui.fire('import-provider-select','change');
  await flush();
  sessions=ui.document.querySelectorAll('.import-session');
  assert.equal(sessions.length,1);
  assert.match(sessions[0].textContent,/Review security findings/);

  ui.$('import-provider-select').value='all';
  ui.fire('import-provider-select','change');
  await flush();
  assert.equal(ui.document.querySelectorAll('.import-session').length,3);

  ui.$('import-provider-select').value='gemini';
  ui.fire('import-provider-select','change');
  ui.$('close-import').click();
  await flush();
  ui.$('open-import').click();
  await flush();
  assert.equal(ui.$('import-provider-select').value,'all');
});

test('run indicators distinguish reasoning, quiet providers, approvals, and real token counts',async()=>{
  const ui=await browser({insights:true}),c=ui.canonical.get('project-one');c.status='running';c.activeRun={provider:'codex',phase:'reasoning',startedAt:new Date(Date.now()-50000).toISOString(),lastEventAt:new Date().toISOString(),effectiveModel:'model-one',effort:'high',usage:{total:{inputTokens:100,outputTokens:20}}};await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-phase').textContent,'Reasoning');assert.equal(ui.$('run-action').textContent,'Thinking');assert.equal(ui.$('run-detail').textContent,'');assert.match(ui.$('run-metrics').textContent,/100 input tokens/);assert.equal(ui.$('model-select').disabled,true);
  c.activeRun.lastEventAt=new Date(Date.now()-40000).toISOString();await ui.window.relayUI.refresh();assert.equal(ui.$('run-phase').textContent,'Waiting for provider');assert.equal(ui.$('run-action').textContent,'Waiting for Codex');assert.match(ui.$('run-detail').textContent,/No activity from Codex for 40s/);assert.doesNotMatch(ui.$('run-detail').textContent,/stuck/i);
  c.pendingApprovals=[{id:'approval'}];await ui.window.relayUI.refresh();assert.equal(ui.$('run-phase').textContent,'Waiting for approval');assert.equal(ui.$('run-action').textContent,'Waiting for your approval');
});

test('input token counts include cached input for Claude as they do for Codex',async()=>{
  const ui=await browser({insights:true}),c=ui.canonical.get('project-one'),metrics=()=>ui.$('run-metrics').textContent,tokens=count=>new RegExp(`(^|\\D)${count.toLocaleString().replace(/\W/g,'\\$&')} input tokens`);
  // Claude reports the input it read from and wrote to its prompt cache apart from input_tokens.
  c.lastRun={provider:'claude',status:'complete',usage:{input_tokens:6,cache_creation_input_tokens:9924,cache_read_input_tokens:15198,output_tokens:412}};await ui.window.relayUI.refresh();
  assert.match(metrics(),tokens(25128));assert.match(metrics(),/412 output tokens/);
  c.lastRun.usage={input_tokens:6,output_tokens:412};await ui.window.relayUI.refresh();
  assert.match(metrics(),tokens(6),'A report without cache counts still shows its input.');
  delete c.lastRun.usage;await ui.window.relayUI.refresh();
  assert.doesNotMatch(metrics(),/tokens/,'A run without a usage report shows no token counts.');
  // Codex's inputTokens already include its cached input.
  c.lastRun={provider:'codex',status:'complete',usage:{total:{inputTokens:25128,cachedInputTokens:25122,outputTokens:412}}};await ui.window.relayUI.refresh();
  assert.match(metrics(),tokens(25128));
});

test('cancelling a workspace removal returns focus to that workspace, not the first one',async()=>{
  const ui=await browser({moreProjects:true,desktop:true,desktopControls:true}),options=id=>ui.document.querySelectorAll('.workspace-options').find(button=>button.dataset.projectId===id);
  // Compared by name, since a failed comparison of two elements would print the whole page.
  const focused=()=>{const node=ui.document.activeElement;return node?.className==='workspace-options'?'options of '+node.dataset.projectId:node?.id||node?.tagName;};
  options('project-two').click();ui.$('workspace-remove').click();assert.equal(ui.$('remove-workspace-name').textContent,'Other workspace');
  ui.$('cancel-remove-workspace').click();await flush();
  assert.equal(focused(),'options of project-two','Focus goes back to the workspace whose removal was cancelled.');
  await ui.switchProject('project-two');ui.menu('remove-workspace');assert.equal(ui.$('remove-workspace-dialog').open,true);assert.equal(ui.$('remove-workspace-name').textContent,'Other workspace');
  ui.$('remove-workspace-dialog').dispatchEvent(new UIEvent('cancel'));await flush();
  assert.equal(focused(),'options of project-two','Escape from the menu’s removal does the same.');
  ui.menu('remove-workspace');assert.equal(ui.$('remove-workspace-dialog').open,true);
  ui.projects.splice(1,1);await ui.window.relayUI.refreshProjects();await flush();assert.deepEqual(ui.document.querySelectorAll('.workspace-options').map(button=>button.dataset.projectId),['project-one'],'Another window removed it meanwhile.');
  ui.$('cancel-remove-workspace').click();await flush();assert.equal(focused(),'options of project-one','With that workspace gone from the list, focus goes to the first one.');
});

test('workspace removal confirms, switches safely, and Undo restores the same chat and draft', async()=>{
  const ui=await browser({moreProjects:true}), chatId=ui.state().conversation.id;
  ui.$('message-input').value='Keep my draft';ui.fire('message-input','input');
  ui.document.querySelectorAll('.workspace-options')[0].click();ui.$('workspace-remove').click();
  assert.equal(ui.$('remove-workspace-dialog').open,true);assert.equal(ui.$('remove-workspace-name').textContent,'Example workspace');
  assert.equal(ui.document.activeElement,ui.$('cancel-remove-workspace'));
  ui.$('cancel-remove-workspace').click();await flush();
  assert.equal(ui.$('remove-workspace-dialog').open,false);assert.equal(ui.projects.length,2);
  ui.document.querySelectorAll('.workspace-options')[0].click();ui.$('workspace-remove').click();ui.$('confirm-remove-workspace').click();await flush();
  assert.equal(ui.projects.length,1);assert.equal(ui.state().projectId,'project-two');assert.equal(ui.$('workspace-count').textContent,'1');
  assert.equal(ui.$('remove-workspace-dialog').open,false);assert.equal(ui.$('notice-retry').textContent,'Undo');
  ui.$('notice-retry').click();await flush();
  assert.equal(ui.projects.length,2);assert.equal(ui.state().projectId,'project-one');assert.equal(ui.state().conversation.id,chatId);
  assert.equal(ui.$('message-input').value,'Keep my draft');assert.equal(ui.chatCreations,2);
});

test('last workspace removal clears stale refreshes and Undo restores it', async()=>{
  const ui=await browser(),held=deferred(),chatId=ui.state().conversation.id;let waiting=false;
  ui.setIntercept((request,next)=>{if(!waiting&&request.path==='/api/conversation'){waiting=true;const result=next();return held.promise.then(()=>result);}return next();});
  const refresh=ui.window.relayUI.refresh();await flush();
  ui.document.querySelectorAll('.workspace-options')[0].click();ui.$('workspace-remove').click();ui.$('confirm-remove-workspace').click();await flush();
  assert.equal(ui.state().projectId,null);assert.equal(ui.$('project-empty-state').hidden,false);assert.equal(ui.$('composer-region').hidden,true);
  assert.equal(ui.$('workspace-count').textContent,'0');held.resolve();await refresh;await flush();assert.equal(ui.state().conversation,null);
  ui.$('notice-retry').click();await flush();assert.equal(ui.state().conversation.id,chatId);assert.equal(ui.$('project-empty-state').hidden,true);
});

test('workspace removal failures keep the dialog and current chat; accepted response loss can be retried',async()=>{
  const ui=await browser(),chatId=ui.state().conversation.id;let blocked=true,lost=false;
  ui.setIntercept((request,next)=>{if(request.path.endsWith('/project-one/remove')){if(blocked)return response({error:'Stop the current run before removing this workspace.'},409);const result=next();if(!lost){lost=true;throw new Error('Response lost');}return result;}return next();});
  ui.document.querySelectorAll('.workspace-options')[0].click();ui.$('workspace-remove').click();ui.$('confirm-remove-workspace').click();await flush();
  assert.equal(ui.$('remove-workspace-dialog').open,true);assert.equal(ui.$('remove-workspace-error').hidden,false);assert.equal(ui.state().conversation.id,chatId);
  blocked=false;ui.$('confirm-remove-workspace').click();await flush();assert.equal(ui.$('remove-workspace-dialog').open,true);
  ui.$('confirm-remove-workspace').click();await flush();assert.equal(ui.state().projectId,null);assert.equal(ui.$('notice-retry').textContent,'Undo');
});

const palette=ui=>ui.document.documentElement.getAttribute('data-theme');
const themeColor=ui=>ui.document.querySelector('meta[name="theme-color"]').getAttribute('content');
const pressedAppearance=(ui,scope=ui.document)=>scope.querySelectorAll('[data-appearance]').filter(button=>button.getAttribute('aria-pressed')==='true').map(button=>button.dataset.appearance);
// Setup cards are read by their labels, which earlier versions share.
const pressedCards=ui=>ui.document.querySelectorAll('.setup-theme').filter(card=>card.getAttribute('aria-pressed')==='true').map(card=>card.querySelector('strong').textContent);
const appearanceSaves=ui=>ui.requests.filter(request=>request.path==='/api/appearance'&&request.method==='POST').map(request=>request.body.theme);
const appearanceButton=(ui,value)=>{const button=ui.document.querySelectorAll('[data-appearance]').find(item=>item.dataset.appearance===value);assert(button,'Missing appearance choice: '+value);return button;};

test('first run welcomes, walks through three steps and a summary, saves real choices and never starts a provider run',async()=>{
  const ui=await browser({empty:true,existing:false,setup:true,insights:true,theme:true}),dialog=ui.$('setup-dialog');
  await flush();
  assert.equal(dialog.open,true);assert.equal(dialog.dataset.screen,'welcome');assert.equal(ui.$('setup-flow').hidden,true);assert.match(ui.$('setup-hero-content').textContent,/Your workspace for AI coding agents/);
  assert.equal(ui.$('launch-screen').classList.contains('done'),true,'The launch screen gives way once setup knows what to show.');
  ui.document.querySelector('.onboarding-cta').click();await flush();
  assert.equal(dialog.dataset.screen,'flow');assert.equal(ui.$('setup-hero').hidden,true);assert.match(ui.$('setup-step-status').textContent,/1 of 3/);assert.match(ui.$('setup-content').textContent,/your subscription/);
  ui.$('setup-back').click();await flush();assert.equal(dialog.dataset.screen,'welcome','Back from the first step returns to the welcome.');ui.document.querySelector('.onboarding-cta').click();await flush();
  ui.document.querySelectorAll('.setup-agent-select').find(button=>button.textContent.startsWith('Claude')).click();await flush();ui.$('setup-next').click();await flush();
  assert.match(ui.$('setup-content').textContent,/Make it yours/);
  const model=ui.labelledInput('Default model');model.value='model-one';model.dispatchEvent(new UIEvent('change'));
  const effort=ui.labelledInput('Reasoning effort');effort.value='high';effort.dispatchEvent(new UIEvent('change'));
  ui.document.querySelectorAll('.setup-access-option').find(button=>button.dataset.mode==='read').click();await flush();
  assert.deepEqual(pressedCards(ui),['System'],'A new profile starts on System.');
  ui.document.querySelectorAll('.setup-theme').find(button=>button.dataset.appearance==='light').click();await flush();
  ui.$('setup-next').click();await flush();assert.match(ui.$('setup-content').textContent,/Choose the folders/);assert.equal(ui.document.querySelector('.setup-import-card'),null);
  ui.$('close-setup').click();await flush();assert.equal(dialog.open,false);
  const saved=ui.requests.filter(request=>request.path==='/api/preferences'&&request.method==='POST').at(-1).body;
  assert.deepEqual(saved.defaults,{provider:'claude',model:'model-one',effort:'high',mode:'read',billing:'subscription'});assert.equal(saved.theme,undefined);
  assert.deepEqual(ui.requests.filter(request=>request.path==='/api/appearance'&&request.method==='POST').map(request=>request.body.theme),['light'],'The theme is saved once, the same way as from the status bar.');
  assert.equal(saved.onboarding.step,2);assert.equal(saved.onboarding.dismissed,true);
  ui.$('open-setup').click();await flush();assert.equal(dialog.dataset.screen,'flow');assert.match(ui.$('setup-step-status').textContent,/3 of 3/,'Setup resumes where it was left.');
  ui.$('setup-next').click();await flush();assert.equal(dialog.dataset.screen,'done');
  assert.match(ui.$('setup-hero-content').textContent,/Claude Code starts the conversation/);assert.match(ui.$('setup-hero-content').textContent,/Light theme/);assert.match(ui.$('setup-hero-content').textContent,/read only/);
  ui.document.querySelector('.onboarding-cta').click();await flush();assert.equal(dialog.open,false);assert.equal(ui.$('setup-progress').textContent,'Review');
  assert.equal(ui.window.relayBillingConfirmed,undefined,'Setup does not accept API charges.');
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue|connect)$/.test(request.path)).length,0);
  const completed=ui.requests.filter(request=>request.path==='/api/preferences'&&request.method==='POST').at(-1).body;assert.equal(completed.onboarding.completed,true);
});

test('a new profile paints the system appearance first and follows the OS while System is selected',async()=>{
  for(const systemDark of [false,true]){
    const ui=await browser({theme:true,systemDark});
    assert.equal(ui.document.documentElement.palettes[0],systemDark?'graphite':'light','The palette set before the stylesheets load already matches the OS.');
    assert.equal(ui.window.relayTheme.preference(),'system');assert.deepEqual(pressedAppearance(ui),['system']);assert.equal(themeColor(ui),systemDark?'#161513':'#f4efe6');
    ui.setSystemDark(!systemDark);assert.equal(palette(ui),systemDark?'light':'graphite');assert.equal(themeColor(ui),systemDark?'#f4efe6':'#161513');
    ui.setSystemDark(systemDark);assert.equal(palette(ui),systemDark?'graphite':'light');assert.deepEqual(pressedAppearance(ui),['system']);
    assert.deepEqual(appearanceSaves(ui),[],'Following the OS never saves a choice.');assert.equal(ui.storage.get('ai-relay:appearance'),'system','The preference is cached, not the palette it resolved to.');
  }
});

test('a saved Light or Dark choice ignores OS changes, and returning to System adopts the OS at once',async()=>{
  const ui=await browser({theme:true,systemDark:true,savedPreferences:{appearance:'light'}});
  assert.equal(palette(ui),'light');assert.deepEqual(pressedAppearance(ui),['light']);
  ui.setSystemDark(false);ui.setSystemDark(true);assert.equal(palette(ui),'light','A manual choice ignores the OS.');
  appearanceButton(ui,'system').click();assert.equal(palette(ui),'graphite');assert.equal(themeColor(ui),'#161513');assert.deepEqual(pressedAppearance(ui),['system']);
  appearanceButton(ui,'graphite').click();ui.setSystemDark(false);assert.equal(palette(ui),'graphite');
  await flush();assert.deepEqual(appearanceSaves(ui),['system','graphite']);assert.equal(ui.storage.get('ai-relay:appearance'),'graphite');
});

test('the preference this browser cached paints first, then the saved preference replaces it',async()=>{
  // Earlier versions cached the palette, so a Dark cache can stand for a profile that now follows a light OS.
  const ui=await browser({theme:true,systemDark:false,stored:{'ai-relay:appearance':'graphite'},savedPreferences:{appearance:'system'}});
  assert.equal(ui.document.documentElement.palettes[0],'graphite');assert.equal(palette(ui),'light');
  assert.equal(ui.window.relayTheme.preference(),'system');assert.equal(ui.storage.get('ai-relay:appearance'),'system');assert.deepEqual(appearanceSaves(ui),[]);
});

test('an appearance chosen in the status bar survives reopening the setup checklist',async()=>{
  const ui=await browser({theme:true,setup:true,savedPreferences:{appearance:'graphite',onboarding:{step:1}}});
  appearanceButton(ui,'light').click();await flush();assert.equal(palette(ui),'light');
  ui.window.relaySetup.open();await flush();
  assert.deepEqual(pressedCards(ui),['Light'],'Setup shows the choice made in the status bar.');
  ui.$('setup-next').click();await flush();assert.match(ui.$('setup-content').textContent,/Choose the folders/);
  assert.equal(palette(ui),'light','Moving through setup keeps the choice made since the page loaded.');assert.deepEqual(appearanceSaves(ui),['light']);
});

test('Settings, setup, the status bar and other windows agree on one appearance preference',async()=>{
  const ui=await browser({theme:true,setup:true,workbench:true,systemDark:true,savedPreferences:{onboarding:{step:1}}});
  ui.$('relay-settings').click();await flush();
  assert.equal(ui.$('settings-title').textContent,'General');assert.equal(ui.$('workbench').open,false,'Settings is separate from Ask a friend.');
  await ui.window.relaySettings.open('preferences');await flush();
  assert.equal(ui.$('settings-title').textContent,'General');
  const settings=ui.$('settings-content').querySelectorAll('[data-appearance]');
  assert.deepEqual(settings.map(button=>button.textContent),['System','Dark','Light']);assert.deepEqual(pressedAppearance(ui,ui.$('settings-content')),['system']);
  settings.find(button=>button.dataset.appearance==='light').click();await flush();
  assert.equal(palette(ui),'light');assert.deepEqual([...new Set(pressedAppearance(ui))],['light'],'The status bar shows the choice made in Settings.');
  ui.$('open-setup-guide').click();await flush();assert.equal(ui.$('setup-dialog').open,true);
  const cards=ui.document.querySelectorAll('.setup-theme');assert.deepEqual(cards.map(card=>card.dataset.appearance),['system','graphite','light']);
  assert.deepEqual(pressedCards(ui),['Light']);
  cards.find(card=>card.dataset.appearance==='system').click();await flush();
  assert.equal(palette(ui),'graphite');assert.deepEqual([...new Set(pressedAppearance(ui))],['system'],'Setup, Settings and the status bar show the same choice.');
  ui.$('setup-next').click();await flush();assert.equal(ui.window.relayTheme.preference(),'system');
  // A choice made in another window arrives through storage. That window already saved it.
  ui.window.dispatchEvent(new UIEvent('storage',{key:'ai-relay:appearance',newValue:'light'}));
  assert.equal(palette(ui),'light');assert.deepEqual([...new Set(pressedAppearance(ui))],['light']);
  assert.deepEqual(appearanceSaves(ui),['light','system'],'Each choice is saved once, through one request.');
  assert.equal(ui.requests.some(request=>request.path==='/api/preferences'&&request.method==='POST'&&request.body.theme!==undefined),false);
});

test('setup resumes its folder step without importing, and failed saves keep the current step',async()=>{
  const ui=await browser({empty:true,existing:false,setup:true,insights:true,savedPreferences:{onboarding:{step:3,dismissed:true}}});
  assert.equal(ui.$('setup-dialog').open,false);ui.$('open-setup').click();await flush();assert.match(ui.$('setup-step-status').textContent,/3 of 3/,'A step saved by the earlier four-step setup resumes at the last step.');
  assert.equal(ui.document.querySelector('.setup-import-card'),null);assert.equal(ui.$('import-dialog').open,false);
  assert.equal(ui.requests.some(request=>request.path==='/api/import-sources'),false,'Onboarding does not discover or import chats.');
  ui.setIntercept((request,next)=>request.path==='/api/preferences'&&request.method==='POST'?response({error:'Preferences could not be written.'},503):next());
  ui.$('setup-back').click();await flush();assert.match(ui.$('setup-step-status').textContent,/3 of 3/);assert.equal(ui.$('setup-error').hidden,false);assert.match(ui.$('setup-error').textContent,/could not be written/);
});

test('onboarding finishes folder setup and the summary before discovering project conversations',async()=>{
  const ui=await browser({empty:true,existing:false,desktop:true,setup:true,insights:true}),setup=ui.$('setup-dialog');
  ui.document.querySelector('.onboarding-cta').click();await flush();
  ui.$('setup-next').click();await flush();ui.$('setup-next').click();await flush();
  assert.equal(ui.document.querySelector('.setup-import-card'),null);ui.pickedFolders.push('/workspace/example/frontend');ui.document.querySelector('.setup-folder-card').click();await flush();
  assert.equal(setup.open,true);assert.equal(setup.dataset.screen,'flow');assert.match(ui.$('setup-content').textContent,/frontend is ready/);
  assert.equal(ui.$('previous-chats-notice').hidden,true);assert.equal(ui.requests.some(request=>request.path==='/api/import-sources'),false);
  ui.$('setup-next').click();await flush();assert.equal(setup.dataset.screen,'done');assert.equal(setup.open,true);assert.match(ui.$('setup-hero-content').textContent,/frontend is ready/);
  assert.equal(ui.requests.some(request=>request.path==='/api/import-sources'),false,'Discovery waits until the user enters the workspace.');
  ui.document.querySelector('.onboarding-cta').click();await flush();assert.equal(setup.open,false);
  assert.equal(ui.requests.filter(request=>request.path==='/api/preferences'&&request.method==='POST').at(-1).body.onboarding.completed,true);
  assert.equal(ui.$('previous-chats-notice').hidden,false);assert.match(ui.$('previous-chats-text').textContent,/Found 2 previous conversations/);assert.equal(ui.$('import-dialog').open,false);
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue|connect)$/.test(request.path)).length,0);
  ui.$('open-import').click();await flush();ui.$('close-import').click();await flush();assert.equal(setup.open,false,'Later imports from the main app do not reopen onboarding.');
});

test('a failed merge can be cancelled with Escape without changing the workspace or its conversation',async()=>{
  const ui=await browser({insights:true});const conversationId=ui.state().conversation.id;
  ui.$('open-import').click();await flush();
  ui.document.querySelectorAll('.import-session')[0].click();await flush();ui.$('import-confirm').checked=true;ui.fire('import-confirm','change');
  ui.setIntercept((request,next)=>request.path==='/api/import-sources/import'?response({error:'The source changed; review it again.'},409):next());
  ui.$('confirm-import').click();await flush();assert.equal(ui.$('import-dialog').open,true);assert.match(ui.$('import-error').textContent,/source changed/);
  const cancel=new UIEvent('cancel');ui.$('import-dialog').dispatchEvent(cancel);if(!cancel.defaultPrevented)ui.$('import-dialog').close();await flush();
  assert.equal(ui.$('import-dialog').open,false);assert.equal(ui.state().projectId,'project-one');assert.equal(ui.state().conversation.id,conversationId);assert.equal(ui.state().conversation.messages.length,0);
});

const updateLaunch={version:'0.10.0',previousVersion:'0.9.0',updated:true,releases:[{version:'0.10.0',sections:[{title:'Added',items:['A new feature.','<img src=x onerror=alert(1)>']}]},{version:'0.9.1',sections:[{title:'Fixed',items:['An earlier fix.']}]}]};

test('an update opens the saved workspace with release notes instead of restart choices',async()=>{
  const ui=await browser({setup:true,desktop:true,launch:clone(updateLaunch)});
  assert.equal(ui.$('setup-dialog').open,false);assert.equal(ui.document.querySelector('.onboarding-choice'),null);
  assert.equal(ui.$('updates-dialog').open,true);assert.equal(ui.$('updates-title').textContent,'Codeshi 0.10.0');
  assert.match(ui.$('updates-description').textContent,/Updated from 0.9.0/);assert.match(ui.$('updates-content').textContent,/An earlier fix/);
  assert.match(ui.$('updates-content').textContent,/<img src=x onerror=alert\(1\)>/);assert.equal(ui.$('updates-content').querySelector('img'),null,'Changelog text never creates executable HTML.');
  assert.equal(ui.state().projectId,'project-one');assert.equal(ui.conversations.length,1);assert.equal(ui.updateAcknowledgements.length,0);
  const requests=ui.requests.length,conversationId=ui.state().conversation.id;ui.$('message-input').value='Keep this draft';ui.fire('message-input','input');
  ui.$('updates-dismiss').click();await flush();assert.deepEqual(ui.updateAcknowledgements,['0.10.0']);assert.equal(ui.$('updates-dialog').open,false);
  assert.equal(ui.$('message-input').value,'Keep this draft');assert.equal(ui.state().conversation.id,conversationId);assert.equal(ui.requests.length,requests,'Dismissing notes does not change settings or call a provider.');
  ui.window.dispatchEvent(new UIEvent('relay-state'));await flush();assert.equal(ui.$('updates-dialog').open,false);
  assert.equal(ui.$('launch-screen').classList.contains('done'),true);
});

test('ordinary launches and first-run setup do not open update notes automatically',async()=>{
  const ordinary=await browser({setup:true,desktop:true});assert.equal(ordinary.$('setup-dialog').open,false);assert.equal(ordinary.$('updates-dialog').open,false);
  const first=await browser({setup:true,desktop:true,empty:true,existing:false});assert.equal(first.$('setup-dialog').open,true);assert.equal(first.$('setup-dialog').dataset.screen,'welcome');assert.equal(first.$('updates-dialog').open,false);
  const interrupted=await browser({setup:true,desktop:true,empty:true,existing:false,launch:clone(updateLaunch)});assert.equal(interrupted.$('setup-dialog').open,true);assert.equal(interrupted.$('updates-dialog').open,false,'Onboarding takes precedence over update notes.');
});

test('Help reopens in-app notes and Close or Escape dismisses them without resetting the app',async()=>{
  const ui=await browser({setup:true,desktop:true,desktopControls:true,launch:{...clone(updateLaunch),updated:false}});
  ui.menu('whats-new');await flush();assert.equal(ui.$('updates-dialog').open,true);assert.equal(ui.$('updates-eyebrow').textContent,'WHAT’S NEW');
  ui.$('updates-release-notes').click();await flush();assert.deepEqual(ui.externalLinks,['https://github.com/AhmedNavaz/codeshi/releases']);
  ui.$('updates-close').click();await flush();assert.equal(ui.$('updates-dialog').open,false);
  ui.menu('whats-new');await flush();const event=new UIEvent('cancel');ui.$('updates-dialog').dispatchEvent(event);await flush();
  assert.equal(event.defaultPrevented,true);assert.equal(ui.$('updates-dialog').open,false);assert.equal(ui.state().projectId,'project-one');
  ui.$('setup-dialog').showModal();ui.menu('whats-new');await flush();assert.equal(ui.$('updates-dialog').open,false,'Help does not stack notes over another dialog.');
});

test('failed update dismissal leaves the workspace usable and explains that notes may reappear',async()=>{
  const ui=await browser({setup:true,desktop:true,launch:clone(updateLaunch)});
  ui.window.relayDesktop.acknowledgeUpdate=async()=>{throw new Error('Disk is full.');};
  ui.$('updates-dismiss').click();await flush();assert.equal(ui.$('updates-dialog').open,false);
  assert.match(ui.$('notice-text').textContent,/may appear again.*Disk is full/);assert.equal(ui.state().projectId,'project-one');assert.equal(ui.$('updates-dismiss').disabled,false);
});

test('updates from untracked versions show installed notes without inventing a previous version',async()=>{
  const ui=await browser({setup:true,desktop:true,launch:{...clone(updateLaunch),previousVersion:null}});
  assert.equal(ui.$('updates-dialog').open,true);assert.match(ui.$('updates-description').textContent,/Your update is installed/);assert.equal(ui.$('updates-description').textContent.includes('null'),false);
});

test('workspace options rename without changing chat or draft and never remove on the first click',async()=>{
  const ui=await browser();const id=ui.state().conversation.id;
  ui.$('message-input').value='Keep this draft';ui.fire('message-input','input');
  assert.equal(ui.document.querySelectorAll('.remove-workspace').length,0);assert.equal(ui.document.querySelectorAll('.remove-workspace-folder').length,0);
  ui.document.querySelectorAll('.workspace-options')[0].click();assert.equal(ui.$('workspace-options-dialog').open,true);assert.equal(ui.$('remove-workspace-dialog').open,false);
  ui.$('rename-workspace-name').value='Customer portal';ui.fire('rename-workspace-form','submit');await flush();
  assert.equal(ui.$('workspace-options-dialog').open,false);assert.match(ui.$('workspace-list').textContent,/Customer portal/);
  assert.equal(ui.state().conversation.id,id);assert.equal(ui.$('message-input').value,'Keep this draft');
  assert.equal(ui.requests.filter(request=>request.path.endsWith('/remove')).length,0);
});

test('usage details show exact resets and scoped limits, and retain readings after a refresh error',async()=>{
  const reset=new Date(Date.now()+125*60000).toISOString();
  const ui=await browser({insights:true,usage:{codex:{available:true,plan:'pro',windows:[{id:'primary',label:'5-hour',usedPercent:70,resetsAt:reset},{id:'weekly',label:'Weekly',usedPercent:10,resetsAt:null}]}}});
  ui.$('codex-status').click();await flush();assert.equal(ui.$('usage-dialog').matches(':popover-open'),true);assert.equal(ui.$('usage-title').textContent,'Plan usage');assert.deepEqual([...ui.$('usage-details').children].map(section=>section.dataset.provider),['codex'],'Only the clicked agent is shown.');assert.equal(ui.$('usage-plan').textContent,'From your own Codex account');
  assert.match(ui.$('usage-details').textContent,/30% left/);assert.match(ui.$('usage-details').textContent,/Resets in 2h/);assert.match(ui.$('usage-details').textContent,/Reset time not reported/);
  const time=ui.document.querySelectorAll('time')[0];assert.equal(time.getAttribute('datetime'),reset);assert.match(ui.$('usage-details').children[0].textContent,/pro/);
  ui.setIntercept((request,next)=>request.path.endsWith('/usage')?response({error:'Provider unavailable'},503):next());ui.$('refresh-usage').click();await flush();
  assert.match(ui.$('usage-details').textContent,/30% left/);assert.match(ui.$('usage-details').textContent,/last successful reading/);assert.equal(ui.$('refresh-usage').disabled,false);
  assert.equal(ui.requests.filter(request=>/\/(?:messages|continue)$/.test(request.path)).length,0);
});

test('Ask a Friend explains the round trip and disables private links when no service is configured',async()=>{
  const ui=await browser({workbench:true,available:false,existing:false});ui.$('ask-friend').click();await flush();
  assert.match(ui.$('workbench-content').textContent,/Share with a person/);ui.labelledInput('Goal').value='Help review this';ui.findButton('Prepare offline preview').click();await flush();
  ui.labelledInput('I inspected the exact package').checked=true;ui.findButton('Approve exact package').click();await flush();
  assert.equal(ui.findButton('Link service not configured').disabled,true);assert.equal(ui.findButton('Export approved request').disabled,false);
  assert.match(ui.$('workbench-content').textContent,/Help someone/);assert.equal(ui.requests.filter(request=>request.path.endsWith('/publish')).length,0);
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/id="open-context"|data-tab="context"/);
});

test('usage opens beside its agent, switches providers in place and closes on Escape, and an agent that isn’t connected opens its setup',async()=>{
  const usage={available:true,windows:[{id:'primary',label:'5-hour',usedPercent:20,resetsAt:null}]};
  const ui=await browser({insights:true,usage:{codex:usage,claude:usage}});
  ui.$('usage-dialog').bounds={left:0,top:0,width:340,height:390,right:340,bottom:390};
  ui.$('codex-status').bounds={left:80,top:772,bottom:794,right:290,width:210,height:22};
  ui.$('codex-status').click();await flush();
  const card=ui.$('usage-dialog');assert.equal(card.tagName,'DIV');assert.equal(card.matches(':popover-open'),true);assert.equal(ui.$('codex-status').getAttribute('aria-expanded'),'true');
  assert.equal(card.style.left,'80px');assert.ok(Number.parseFloat(card.style.top)+390<772,'The card stays above its footer meter.');
  ui.$('claude-status').click();await flush();assert.deepEqual([...ui.$('usage-details').children].map(section=>section.dataset.provider),['claude']);assert.equal(ui.$('codex-status').getAttribute('aria-expanded'),'false');
  ui.$('claude-status').click();await flush();assert.equal(card.matches(':popover-open'),false);
  ui.$('usage-chip').bounds={left:1190,top:700,bottom:726,right:1270,width:80,height:26};ui.$('usage-chip').click();await flush();assert.ok(Number.parseFloat(card.style.left)+340<=1280-12,'Composer usage stays inside the window.');
  assert.deepEqual([...ui.$('usage-details').children].map(section=>section.dataset.provider),[ui.state().provider],'The composer chip shows only the selected agent.');
  ui.document.dispatchEvent(new UIEvent('keydown',{key:'Escape'}));assert.equal(card.matches(':popover-open'),false);assert.equal(ui.document.activeElement,ui.$('usage-chip'));
  const opened=[];ui.window.relaySettings={open:tab=>opened.push(tab)};ui.$('gemini-status').click();await flush();
  assert.deepEqual(opened,['accounts'],'An agent that isn’t connected opens its setup, never usage.');assert.equal(card.matches(':popover-open'),false);
});

test('footer keep awake shows armed and native active states, handles errors and stays hidden in web mode',async()=>{
  const web=await browser({desktopControls:true});assert.equal(web.$('keep-awake').hidden,true);
  const ui=await browser({desktop:true,desktopControls:true});assert.equal(ui.$('keep-awake').hidden,false);assert.equal(ui.$('keep-awake').dataset.state,'off');
  ui.$('keep-awake').click();await flush();assert.deepEqual(ui.awakeChanges,[true]);assert.equal(ui.$('keep-awake-label').textContent,'Keep awake · Auto');
  ui.window.dispatchEvent(new UIEvent('desktop-keep-awake',{detail:{enabled:true,active:true,runningCount:2,error:null}}));assert.equal(ui.$('keep-awake-label').textContent,'Keep awake · On');assert.match(ui.$('keep-awake').title,/2 active agents/);
  ui.window.dispatchEvent(new UIEvent('desktop-keep-awake',{detail:{enabled:true,active:false,runningCount:0,error:null}}));assert.equal(ui.$('keep-awake').dataset.state,'armed');
  ui.window.relayDesktop.setKeepAwake=async()=>{throw Error('Disk unavailable');};ui.$('keep-awake').click();await flush();assert.match(ui.$('notice-text').textContent,/Disk unavailable/);assert.equal(ui.$('keep-awake').getAttribute('aria-pressed'),'true');assert.equal(ui.$('keep-awake').disabled,false);
});

test('a shortcut and its menu item run one command with the same checks, so a key the page leaves alone is ignored by the menu too',async()=>{
  const ui=await browser({desktop:true,desktopControls:true,moreProjects:true,insights:true});
  const key=(key,shiftKey=false)=>{const event=new UIEvent('keydown',{key,ctrlKey:true,shiftKey});ui.document.dispatchEvent(event);return event.defaultPrevented;};
  ui.$('message-input').focus();assert.equal(key('k'),true);assert.equal(ui.document.activeElement?.id,'workspace-search');
  ui.$('message-input').focus();ui.menu('filter-workspaces');assert.equal(ui.document.activeElement?.id,'workspace-search');
  assert.equal(key('l'),true);assert.equal(ui.document.activeElement?.id,'message-input');
  ui.$('workspace-search').focus();ui.menu('focus-message');assert.equal(ui.document.activeElement?.id,'message-input');
  assert.equal(key('G',true),true);await flush();assert.equal(ui.$('git-panel').hidden,false);ui.menu('git');assert.equal(ui.$('git-panel').hidden,true);
  // ⌘. and Stop Run only stop a run in progress.
  const stops=()=>ui.requests.filter(request=>request.path.endsWith('/stop')).length;ui.setIntercept((request,next)=>request.path.endsWith('/stop')?response({}):next());
  assert.equal(key('.'),false,'With no run, the page leaves ⌘. alone.');ui.menu('stop');await flush();assert.equal(stops(),0);
  ui.canonical.get('project-one').status='running';await ui.window.relayUI.refresh();
  assert.equal(key('.'),true);await flush();assert.equal(stops(),1);ui.menu('stop');await flush();assert.equal(stops(),2);
  ui.canonical.get('project-one').status='idle';await ui.window.relayUI.refresh();
  // ⌘1–9 and the Workspace items count over the workspaces the filter shows.
  assert.equal(key('2'),true);await flush();assert.equal(ui.state().projectId,'project-two');
  ui.menu('workspace',1);await flush();assert.equal(ui.state().projectId,'project-one');
  ui.$('workspace-search').value='other';ui.fire('workspace-search','input');
  assert.equal(key('2'),true,'Searching does not renumber the workspaces.');await flush();assert.equal(ui.state().projectId,'project-two');
});

test('menu items that stand in for a button do what the button does, and wait while a dialog covers the page',async()=>{
  const ui=await browser({desktop:true,desktopControls:true,workbench:true,historyUI:true,filesUI:true,theme:true,setup:true,stored:{'ai-relay:sidebar-level:project-one':'folder'}}),opened=id=>Boolean(ui.$(id).open);
  const continues=()=>ui.requests.filter(request=>request.path.endsWith('/continue')).length,appearances=()=>ui.requests.filter(request=>request.path==='/api/appearance'&&request.method==='POST').map(request=>request.body.theme);
  ui.menu('settings');await flush();assert.equal(opened('settings'),true,'Settings… opens Settings, as the status bar button does.');
  for(const command of ['new-workspace','add-folder','previous-chats','files','keep-awake','workspace-settings','remove-workspace','setup-guide'])ui.menu(command);
  ui.menu('agent','claude');await flush();
  assert.deepEqual([ui.$('project-panel').hidden,ui.$('folder-panel').hidden,opened('import-dialog'),ui.$('file-tree').hidden,ui.awakeChanges.length,opened('workspace-options-dialog'),opened('remove-workspace-dialog'),opened('setup-dialog'),ui.state().provider],[true,true,false,false,0,false,false,false,'codex'],'Nothing behind the open dialog changes.');
  ui.$('settings').close();
  ui.menu('new-workspace');assert.equal(ui.$('project-panel').hidden,false);ui.$('close-project').click();
  ui.menu('add-folder');assert.equal(ui.$('folder-panel').hidden,false);ui.$('close-folder').click();
  ui.menu('previous-chats');await flush();assert.equal(opened('import-dialog'),true);ui.$('import-dialog').close();
  ui.menu('export');await flush();assert.equal(opened('export-dialog'),false,'Export waits for a conversation to export, as its button does.');assert.equal(ui.window.relayUI.commands.export(),false,'A command reports that it did not act.');
  ui.menu('files');assert.equal(opened('files-dialog'),true);ui.menu('files');assert.equal(opened('files-dialog'),false);
  ui.menu('agent','claude');await flush();assert.equal(ui.$('select-claude').getAttribute('aria-pressed'),'true');ui.menu('agent','gemini');await flush();assert.equal(ui.state().provider,'claude');
  ui.menu('continue');await flush();assert.equal(continues(),0,'Continue waits until the page offers it.');
  ui.menu('keep-awake');await flush();assert.deepEqual(ui.awakeChanges,[true]);
  ui.menu('appearance','light');ui.menu('appearance','sepia');await flush();assert.equal(ui.document.documentElement.getAttribute('data-theme'),'light');assert.deepEqual(appearances(),['light']);
  ui.menu('workspace-settings');assert.equal(opened('workspace-options-dialog'),true);ui.menu('remove-workspace');assert.equal(opened('remove-workspace-dialog'),false);
  ui.$('workspace-options-dialog').close();ui.menu('remove-workspace');assert.equal(opened('remove-workspace-dialog'),true);ui.$('cancel-remove-workspace').click();
  ui.menu('setup-guide');await flush();assert.equal(opened('setup-dialog'),true);
  ui.menu('no-such-command');
});

test('Find in Conversation, Find Next and Find Previous do what ⌘F, Enter and Shift+Enter do, and wait while a dialog is open',async()=>{
  const ui=await browser({desktop:true,desktopControls:true,searchUI:true}),count=()=>ui.$('conversation-search-count').textContent;
  ui.canonical.get('project-one').messages.push({id:'u1',role:'user',text:'Retry once'},{id:'a1',role:'assistant',provider:'codex',text:'Retry twice'},{id:'u2',role:'user',text:'Retry three times'});await ui.window.relayUI.refresh();
  ui.menu('find');assert.equal(ui.$('conversation-search').hidden,false);assert.equal(ui.document.activeElement?.id,'conversation-search-input');
  ui.$('conversation-search-input').value='retry';ui.fire('conversation-search-input','input');await flush();assert.equal(count(),'1 of 3');
  ui.menu('find-next');assert.equal(count(),'2 of 3');ui.menu('find-previous');ui.menu('find-previous');assert.equal(count(),'3 of 3');
  ui.$('conversation-search-close').click();ui.menu('find-next');assert.equal(ui.$('conversation-search').hidden,false,'Find Next opens the search again with its last text.');assert.equal(count(),'1 of 3');
  ui.$('conversation-search-close').click();ui.$('workspace-options-dialog').showModal();
  for(const command of ['find','find-next','find-previous'])ui.menu(command);
  const find=new UIEvent('keydown',{key:'f',ctrlKey:true});ui.document.dispatchEvent(find);
  assert.equal(find.defaultPrevented,false,'Over a dialog ⌘F goes on to the menu, whose item waits too.');assert.equal(ui.$('conversation-search').hidden,true);
});

test('the menu bar follows the page: the workspace, a run, the agent, Continue, Files, Git activity and the first nine workspaces',async()=>{
  const web=await browser({desktopControls:true,insights:true,historyUI:true,filesUI:true});assert.equal(web.menuStates.length,0,'The browser has no menu bar.');
  const none=await browser({empty:true,existing:false,desktop:true,desktopControls:true,historyUI:true});assert.deepEqual(none.menuStates.at(-1),{workspace:false,running:false,agent:'codex',codex:false,claude:false,gemini:false,continue:null,files:false,git:false,terminal:false,imports:false,export:false,workspaces:[]});
  const ui=await browser({desktop:true,desktopControls:true,moreProjects:true,insights:true,historyUI:true,filesUI:true,stored:{'ai-relay:sidebar-level:project-one':'folder'}}),shown=()=>ui.menuStates.at(-1);
  const workspaces=[{name:'Example workspace',current:true},{name:'Other workspace',current:false}];
  assert.deepEqual(shown(),{workspace:true,running:false,agent:'codex',codex:true,claude:true,gemini:false,continue:null,files:false,git:false,terminal:false,imports:true,export:false,workspaces});
  const reported=ui.menuStates.length;ui.window.dispatchEvent(new UIEvent('relay-state'));await flush();assert.equal(ui.menuStates.length,reported,'An unchanged state is not sent again.');
  ui.$('select-claude').click();await flush();assert.equal(shown().agent,'claude');
  ui.$('toggle-explorer').click();await flush();assert.equal(shown().files,true);
  ui.$('close-files').click();await flush();assert.equal(shown().files,false);
  ui.$('open-git').click();await flush();assert.equal(shown().git,true);ui.$('open-git').click();await flush();assert.equal(shown().git,false);
  ui.$('workspace-search').value='other';ui.fire('workspace-search','input');await flush();assert.deepEqual(shown().workspaces,workspaces,'Searching does not filter the workspace list.');
  const chat=ui.canonical.get('project-one');chat.status='running';await ui.window.relayUI.refresh();await flush();
  assert.deepEqual([shown().running,shown().codex,shown().claude,shown().imports],[true,false,false,false],'During a run the agents and imports wait, as their buttons do.');
  // Continue names the agent the page's Continue button would use.
  Object.assign(chat,{status:'interrupted',lastRun:{provider:'claude',errorCategory:'interrupted'}});await ui.window.relayUI.refresh();await flush();assert.deepEqual([shown().running,shown().continue],[false,'claude']);
  chat.lastRun={provider:'claude',errorCategory:'quota'};await ui.window.relayUI.refresh();await flush();assert.equal(shown().continue,'codex','After a usage limit it continues with the other agent.');
  const long='Long '+'name '.repeat(30);
  for(let index=3;index<=11;index++)ui.projects.push({id:'project-'+index,name:index===3?long:'Workspace '+index,path:'/workspace/'+index,available:true,folders:[{id:'f'+index,name:'f'+index,displayName:'f'+index,path:'/workspace/'+index,available:true}]});
  await ui.window.relayUI.refreshProjects();await flush();
  assert.deepEqual(shown().workspaces.map(item=>item.name),['Example workspace','Other workspace',long.slice(0,120),...[4,5,6,7,8,9].map(index=>'Workspace '+index)],'The first nine are listed, each name at most 120 characters.');
});


function reviewBrowserRoutes(ui, { status = null, stale = false, background = false } = {}) {
  const snapshot = { digest: 'd'.repeat(64), files: [{ id: 'frontend:app.js', folderId: 'frontend', folderName: 'Frontend', path: 'app.js', code: ' M', diff: '@@ -1 +1 @@\n-old\n+new\n', lines: 2 }] };
  let report = status ? { id: 'review-one', status, builder: 'codex', provider: 'claude', goal: 'Keep the public contract', startedAt: '2026-10-31T10:00:00Z', summary: status === 'complete' ? 'One issue to consider.' : 'The review needs attention.', findings: status === 'complete' ? [{ id: '1', severity: 'medium', title: '<img onerror=alert(1)>', detail: 'The change breaks the return value.', folderId: 'frontend', path: 'app.js', line: 1 }] : [], snapshot, stale, staleReason: stale ? 'Selected files changed.' : null } : null;
  if (report) ui.canonical.get('project-one').reviews = [report];
  ui.setIntercept((request, next) => {
    if (request.path === '/api/reviews') return response({ builder: 'codex', reviewer: 'claude', goal: 'Keep the public contract', limits: { files: 12 }, reviews: report ? [report] : [], repositories: [{ name: 'Frontend', folderId: 'frontend', available: true, totalChanges: 2, changes: [{ path: 'app.js', code: ' M' }, { path: 'other.js', code: '??' }] }] });
    if (request.path === '/api/reviews/preview') return response({ snapshot });
    if (request.path === '/api/reviews/start') { report = { id: 'review-one', status: 'running', background, builder: 'codex', provider: 'claude', goal: request.body.goal, startedAt: '2026-10-31T10:00:00Z', findings: [], snapshot, stale: false }; const c = ui.canonical.get('project-one'); c.reviews = [report]; if (!background) c.status = 'running'; return response({ reviewId: 'review-one', background }, 202); }
    if (request.path === '/api/reviews/review-one/stop') { report.status = 'interrupted'; return response({stopped:true}); }
    if (request.path === '/api/reviews/review-one/prepare-fix') return response({ provider: 'codex', text: 'Address the selected finding: fix the return value.' });
    if (request.path === '/api/reviews/review-one') return response(report);
    return next();
  });
  return { snapshot, get report() { return report; } };
}

test('cross-agent review requires file selection and a preview before an explicit start, and scope changes invalidate the preview', async () => {
  const ui = await browser({ reviewsUI: true }), fixture = reviewBrowserRoutes(ui);
  const calls = path => ui.requests.filter(request => request.path === path);
  assert.equal(calls('/api/reviews/start').length, 0);
  ui.$('open-review').click(); await flush(); assert.equal(ui.$('review-dialog').open, true); assert.match(ui.$('review-pair').textContent, /Codex builds.*Claude Code reviews/);
  assert.equal(ui.$('start-review').disabled, true);
  const choices = ui.$('review-files').querySelectorAll('input'); choices[0].checked = true; choices[0].dispatchEvent(new UIEvent('change')); assert.equal(ui.$('preview-review').disabled, false);
  ui.$('preview-review').click(); await flush(); assert.equal(ui.$('review-preview').hidden, false); assert.equal(ui.$('start-review').disabled, false);
  assert.equal(calls('/api/reviews/start').length, 0, 'Preview never runs an agent.');
  choices[1].checked = true; choices[1].dispatchEvent(new UIEvent('change')); assert.equal(ui.$('start-review').disabled, true); assert.equal(ui.$('review-preview').hidden, true);
  ui.$('preview-review').click(); await flush(); ui.$('start-review').click(); ui.$('start-review').click(); await flush();
  assert.equal(calls('/api/reviews/start').length, 1, 'A double click cannot start two reviews.');
  for (const request of ui.requests.filter(request => request.path.startsWith('/api/reviews'))) assert.equal(request.projectId, 'project-one', 'Every review request is scoped to its workspace by the real API client.');
  assert.equal(calls('/api/reviews/start')[0].body.approvedDigest, fixture.snapshot.digest); assert.equal(calls('/api/reviews/start')[0].body.billingConfirmed, false);
  assert.equal(ui.$('review-result').hidden, false); assert.match(ui.$('review-result').textContent, /Review in progress/); assert.equal(ui.state().provider, 'codex');
});

test('a review with an unverified billing source needs its own explicit confirmation', async () => {
  const ui = await browser({ reviewsUI: true, billingSource: 'unknown' }); reviewBrowserRoutes(ui);
  ui.$('open-review').click(); await flush(); const choice = ui.$('review-files').querySelectorAll('input')[0]; choice.checked = true; choice.dispatchEvent(new UIEvent('change'));
  ui.$('preview-review').click(); await flush(); assert.equal(ui.$('review-billing-label').hidden, false); assert.equal(ui.$('start-review').disabled, true);
  ui.$('review-billing').checked = true; ui.$('review-billing').dispatchEvent(new UIEvent('change')); assert.equal(ui.$('start-review').disabled, false);
  ui.$('start-review').click(); await flush(); assert.equal(ui.requests.find(request => request.path === '/api/reviews/start').body.billingConfirmed, true);
});

test('selected findings prepare a draft without starting a fix or overwriting existing text, and finding content is rendered as text', async () => {
  const ui = await browser({ reviewsUI: true }); reviewBrowserRoutes(ui, { status: 'complete' }); await ui.window.relayUI.refresh();
  ui.$('view-review').click(); await flush();
  assert.equal(ui.$('review-result').querySelectorAll('img').length, 0); assert.match(ui.$('review-result').textContent, /<img onerror=alert\(1\)>/);
  const choice = ui.$('review-result').querySelectorAll('input')[0]; choice.checked = true; choice.dispatchEvent(new UIEvent('change'));
  ui.$('message-input').value = ''; ui.$('prepare-review-fix').click(); await flush();
  assert.equal(ui.$('message-input').value, 'Address the selected finding: fix the return value.'); assert.equal(ui.$('review-dialog').open, false);
  assert.equal(ui.requests.filter(request => /\/(messages|continue)$/.test(request.path)).length, 0, 'A fix is only drafted; Send remains an explicit action.');
  assert.equal(ui.requests.find(request => request.path.endsWith('/provider')).body.mode, 'edit');
});

test('an outdated review cannot prepare fixes and an unstructured report is never shown as no findings', async () => {
  const ui = await browser({ reviewsUI: true }); reviewBrowserRoutes(ui, { status: 'complete', stale: true }); await ui.window.relayUI.refresh(); ui.$('view-review').click(); await flush();
  assert.match(ui.$('review-result').textContent, /Outdated review/); assert.equal(ui.$('review-result').querySelectorAll('input')[0].disabled, true); assert.equal(ui.$('prepare-review-fix').disabled, true);
  const other = await browser({ reviewsUI: true }); reviewBrowserRoutes(other, { status: 'unstructured' }); await other.window.relayUI.refresh(); other.$('view-review').click(); await flush();
  assert.match(other.$('review-result').textContent, /Review response needs attention/); assert(!other.$('review-result').textContent.includes('No actionable findings reported'));
});

test('a delayed review preview cannot follow the user into another workspace', async () => {
  const ui = await browser({ reviewsUI: true, moreProjects: true }); reviewBrowserRoutes(ui); ui.$('open-review').click(); await flush();
  const choice = ui.$('review-files').querySelectorAll('input')[0]; choice.checked = true; choice.dispatchEvent(new UIEvent('change'));
  const gate = deferred(); ui.setIntercept((request, next) => request.path === '/api/reviews/preview' ? gate.promise : next());
  ui.$('preview-review').click(); await ui.switchProject('project-two'); gate.resolve(response({ snapshot: { digest: 'wrong', files: [] } })); await flush();
  assert.equal(ui.$('review-dialog').open, false); assert.equal(ui.$('review-preview').hidden, true); assert.equal(ui.state().projectId, 'project-two');
});

test('a finished review updates its conversation summary, and an interrupted review never offers an editing continuation', async () => {
  const ui = await browser({ reviewsUI: true, insights: true }); reviewBrowserRoutes(ui, { status: 'running' });
  const c = ui.canonical.get('project-one'); c.messages.push({ id: 'review-response', role: 'assistant', provider: 'claude', reviewId: 'review-one', text: '{"summary":"Finished","findings":[]}', status: 'complete' });
  c.lastRun = { provider: 'claude', purpose: 'review', reviewId: 'review-one', status: 'complete' }; await ui.window.relayUI.refresh();
  c.reviews[0].status = 'complete'; c.reviews[0].summary = 'Updated review summary'; await ui.window.relayUI.refresh(); assert.match(ui.$('messages').textContent, /Updated review summary/);
  c.status = 'interrupted'; c.lastRun.status = 'interrupted'; c.lastRun.errorCategory = 'interrupted'; await ui.window.relayUI.refresh();
  assert.equal(ui.$('continuation').hidden, true); assert.match(ui.$('run-phase').textContent, /Review/);
});

test('drafting a fix keeps the message in progress and its attachments, and sends nothing', async () => {
  const open = async () => { const ui = await browser({ reviewsUI: true }); reviewBrowserRoutes(ui, { status: 'complete' }); await ui.window.relayUI.refresh(); ui.$('view-review').click(); await flush(); const choice = ui.$('review-result').querySelectorAll('input')[0]; choice.checked = true; choice.dispatchEvent(new UIEvent('change')); return ui; };
  const fix = 'Address the selected finding: fix the return value.', sends = ui => ui.requests.filter(request => /\/(messages|continue)$/.test(request.path)).length;
  const typed = await open(); typed.$('message-input').value = 'An existing draft'; typed.$('prepare-review-fix').click(); await flush();
  assert.equal(typed.$('message-input').value, 'An existing draft\n\n' + fix, 'What was being typed stays, with the fix request after it.');
  assert.equal(typed.$('review-error').hidden, true); assert.equal(sends(typed), 0); assert.equal(typed.$('review-dialog').open, false);
  const filed = await open(); const ids = ['file-one']; filed.window.relayFiles = { ids: () => ids, accepted() {} };
  filed.$('prepare-review-fix').click(); await flush();
  assert.equal(filed.$('message-input').value, fix, 'Attachments no longer get in the way.'); assert.deepEqual(ids, ['file-one'], 'And they stay.'); assert.equal(sends(filed), 0);
  const twice = await open(); twice.$('message-input').value = fix; twice.$('prepare-review-fix').click(); await flush();
  assert.equal(twice.$('message-input').value, fix, 'The same request is not added twice.');
});

test('a draft typed while review fixes are being prepared stays, with the fix request after it', async () => {
  const ui = await browser({ reviewsUI: true }); reviewBrowserRoutes(ui, { status: 'complete' }); await ui.window.relayUI.refresh(); ui.$('view-review').click(); await flush();
  const choice = ui.$('review-result').querySelectorAll('input')[0]; choice.checked = true; choice.dispatchEvent(new UIEvent('change'));
  const gate = deferred(); ui.setIntercept((request, next) => request.path.endsWith('/prepare-fix') ? gate.promise : next());
  ui.$('prepare-review-fix').click(); ui.$('message-input').value = 'A newly typed draft'; gate.resolve(response({ provider: 'codex', text: 'Replace the draft' })); await flush();
  assert.equal(ui.$('message-input').value, 'A newly typed draft\n\nReplace the draft', 'Text typed while it was being prepared stays too.'); assert.equal(ui.$('review-error').hidden, true);
});

test('the task plan stays through a switch of agent, says where it came from, and a new prompt starts without it', async () => {
  const ui = await browser(), conversation = ui.canonical.get('project-one');
  const steps = [{ text: 'Read the code', status: 'done' }, { text: 'Write the tests', status: 'active' }, { text: 'Run them', status: 'pending' }];
  Object.assign(conversation, { status: 'running', activeRun: { id: 'run-one', provider: 'codex', startedAt: new Date().toISOString(), plan: { steps } } });
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan').hidden, false); assert.equal(ui.$('run-plan-from').hidden, true); assert.equal(ui.$('run-plan').dataset.held, 'false');
  ui.$('run-plan-toggle').click(); assert.equal(ui.$('run-plan-list').hidden, false);
  // Stopped for the switch, with no run working: the row stays, and the step in progress holds still.
  Object.assign(conversation, { status: 'interrupted', activeRun: null, lastRun: { id: 'run-one', provider: 'codex', status: 'interrupted', errorCategory: 'interrupted', plan: { steps } } });
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan').hidden, false, 'The plan stays visible between the two runs.'); assert.equal(ui.$('run-plan').dataset.held, 'true'); assert.equal(ui.$('run-plan-count').textContent, '1 of 3 done');
  // The next agent has it, saying where from, and the open list stays open.
  Object.assign(conversation, { status: 'running', lastRun: conversation.lastRun, activeRun: { id: 'run-two', provider: 'claude', startedAt: new Date().toISOString(), plan: { steps, carriedFrom: { runId: 'run-one', provider: 'codex' } } } });
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan').hidden, false); assert.equal(ui.$('run-plan-from').textContent, 'From Codex'); assert.equal(ui.$('run-plan-list').hidden, false, 'A switch of agent is not a new plan.');
  // Finished, or a new prompt with no plan: nothing left to show.
  Object.assign(conversation, { status: 'complete', activeRun: null, lastRun: { id: 'run-two', provider: 'claude', status: 'complete', plan: { steps } } });
  await ui.window.relayUI.refresh(); assert.equal(ui.$('run-plan').hidden, true);
  Object.assign(conversation, { status: 'running', activeRun: { id: 'run-three', provider: 'claude', startedAt: new Date().toISOString() }, lastRun: { id: 'run-two', provider: 'codex', status: 'interrupted', plan: { steps } } });
  await ui.window.relayUI.refresh(); assert.equal(ui.$('run-plan').hidden, true, 'A new prompt does not inherit the old plan.');
});

test('the handoff offer says how many queued prompts move, charges for them are a separate yes, and Up next shows the move', async () => {
  const ui = await browser(), conversation = ui.canonical.get('project-one'), answers = [];
  const offer = (queue, billingSource = 'subscription') => ({ id: 'offer-' + JSON.stringify(queue).length, runId: 'run-one', from: { provider: 'codex', usedPercent: 92, window: '5-hour' }, to: { provider: 'claude', model: null, mode: 'edit', approvalPolicy: 'ask', billingSource }, task: 'Build it', queue });
  ui.setIntercept((request, next) => { if (!request.path.endsWith('/handoff')) return next(); answers.push(request.body); return response({}); });
  Object.assign(conversation, { status: 'running', activeRun: { id: 'run-one', provider: 'codex', startedAt: new Date().toISOString() }, handoffOffer: offer({ count: 2, stays: 1, items: [], billingRequired: false, digest: 'abc' }), queue: [{ id: 'q1', text: 'Next', provider: 'claude', movedFrom: 'codex', mode: 'read', approvalPolicy: 'ask', attachments: [] }] });
  await ui.window.relayUI.refresh();
  assert.match(ui.$('handoff-detail').textContent, /2 queued prompts move with it, with the same access\./);
  assert.match(ui.$('handoff-detail').textContent, /1 queued prompt stays with Codex/);
  assert.equal(ui.$('handoff-queue-billing').hidden, true);
  assert.match(ui.$('prompt-queue-list').textContent, /Claude.*Read only.*Moved from Codex/, 'Up next shows the new agent, and the access it kept.');
  ui.$('handoff-accept').click(); await flush();
  assert.deepEqual([answers[0].queueDigest, answers[0].queueBillingConfirmed], ['abc', false], 'The answer says which prompts the person saw.');
  conversation.handoffOffer = offer({ count: 1, stays: 0, items: [], billingRequired: true, digest: 'def' }, 'api');
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('handoff-queue-billing').hidden, false); assert.match(ui.$('handoff-queue-text').textContent, /Also accept charges for 1 queued prompt\. Without this, it stays with Codex\./);
  ui.$('handoff-billing-confirm').checked = true; ui.$('handoff-billing-confirm').dispatchEvent(new UIEvent('change')); assert.equal(ui.$('handoff-accept').disabled, false, 'The handoff can go ahead without the queue going along.');
  ui.$('handoff-accept').click(); await flush(); assert.equal(answers.at(-1).queueBillingConfirmed, false);
  ui.$('handoff-queue-confirm').checked = true; ui.$('handoff-accept').click(); await flush(); assert.deepEqual([answers.at(-1).billingConfirmed, answers.at(-1).queueBillingConfirmed], [true, true]);
});

test('a task that crossed agents ends on one line, and a single run reads as it always has', async () => {
  const ui = await browser({ insights: true }), conversation = ui.canonical.get('project-one'), at = '2026-11-05T10:00:00.000Z', end = '2026-11-05T10:02:00.000Z';
  Object.assign(conversation, { status: 'complete', activeRun: null, lastRun: { id: 'two', provider: 'codex', status: 'complete', startedAt: at, endedAt: end, elapsedMs: 120000 } });
  await ui.window.relayUI.refresh(); assert.equal(ui.$('run-action').textContent, 'Completed in 2m 0s');
  conversation.taskResult = { runs: 2, workingMs: 100000, tests: 'passed', agents: [{ provider: 'claude', files: 2 }, { provider: 'codex', files: 1 }] };
  await ui.window.relayUI.refresh(); assert.equal(ui.$('run-action').textContent, 'Completed in 1m 40s · Claude 2 files · Codex 1 file, tests passed');
  conversation.taskResult = { runs: 2, workingMs: 100000, tests: null, agents: [{ provider: 'claude', files: 0 }, { provider: 'codex', files: null }, { provider: 'codex', local: true, files: 1 }] };
  await ui.window.relayUI.refresh(); assert.match(ui.$('run-action').textContent, /Claude no files · Codex · Local 1 file, no tests recorded$/, 'An unknown count is left out, never shown as zero, and a missing check is said.');
});

test('the moment an agent reaches its limit stands out, and other errors and handoffs stay plain', async () => {
  const ui = await browser(), conversation = ui.canonical.get('project-one'), row = id => ui.$('message-' + id);
  conversation.runs = [{ id: 'limited', provider: 'codex', errorCategory: 'quota' }, { id: 'broken', provider: 'codex', errorCategory: 'protocol' }];
  conversation.messages.push(
    { id: 'handed', role: 'system', text: 'Codex reached its usage limit, which resets Thu 3:00 PM, so Codeshi handed the task to Claude.', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'quota', role: 'error', runId: 'limited', text: 'You have hit your usage limit.', createdAt: new Date().toISOString() },
    { id: 'plain', role: 'system', text: 'Gemini reached its usage limit, so Codeshi handed the task to Claude.' },
    { id: 'wait', role: 'system', text: 'Claude reached its usage limit, and no other agent has room, so the task continues at the first reset.' },
    { id: 'quota-again', role: 'error', runId: 'limited', text: 'You have hit your usage limit. Your conversation is saved.' },
    { id: 'other', role: 'error', runId: 'broken', text: 'The connection dropped.' },
    { id: 'close', role: 'system', text: 'Codex was close to its usage limit, so you handed the task to Claude.' });
  await ui.window.relayUI.refresh();
  assert.equal(row('handed').className, 'limit-moment', 'An old one is shown settled, with no animation.');
  assert.equal(row('handed').querySelector('.limit-moment-text').textContent, 'Codex reached its usage limit');
  assert.equal(row('handed').querySelector('.limit-moment-next').textContent, 'Resets Thu 3:00 PM, so Codeshi handed the task to Claude.');
  assert.equal(row('quota').classList.contains('stamping'), true, 'A new one plays.');
  assert.equal(row('quota').querySelector('.limit-moment-next').textContent, 'You have hit your usage limit.');
  assert.equal(row('plain').querySelector('.limit-moment-next').textContent, 'Codeshi handed the task to Claude.');
  assert.equal(row('wait').querySelector('.limit-moment-next').textContent, 'No other agent has room, so the task continues at the first reset.');
  assert.equal(row('quota-again').className, 'message-error', 'Real agents say it twice, and it is one moment.');
  assert.equal(row('other').className, 'message-error'); assert.equal(row('close').className, 'message-system', 'Handing off before the limit is not this moment.');
});

test('Plan usage marks the agent that is working, not the one selected, and lists Ollama only when it has models', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true }), conversation = ui.canonical.get('project-one'), working = () => ['codex', 'claude', 'gemini', 'ollama'].filter(name => !ui.$(name + '-working').hidden);
  let catalog = { models: [{ id: 'llama3' }], excluded: 0 }; const asked = [];
  ui.setIntercept((request, next) => { if (request.path === '/api/local-models') { asked.push(request.method); if (catalog) return response(catalog); return response({ error: 'Ollama is not running.' }, 502); } return next(); });
  await ui.window.relayUI.refresh(); assert.deepEqual(working(), [], 'With nothing running, no row says Working.');
  Object.assign(conversation, { status: 'running', provider: 'claude', activeRun: { id: 'one', provider: 'codex', startedAt: new Date().toISOString() } });
  await ui.window.relayUI.refresh(); assert.deepEqual(working(), ['codex'], 'Even with another agent selected.');
  Object.assign(conversation, { activeRun: { id: 'two', provider: 'claude', startedAt: new Date().toISOString() } });
  await ui.window.relayUI.refresh(); assert.deepEqual(working(), ['claude'], 'The mark moves at a handoff.');
  Object.assign(conversation, { activeRun: { id: 'three', provider: 'codex', connection: 'local', startedAt: new Date().toISOString() } });
  await ui.window.relayUI.refresh(); assert.deepEqual(working(), ['ollama'], 'A local run is not Codex working.');
  Object.assign(conversation, { status: 'complete', activeRun: null }); await ui.window.relayUI.refresh(); assert.deepEqual(working(), []);
  ui.window.relayAgents.close(); ui.window.relayAgents.open(); await flush();
  assert.equal(ui.$('ollama-status').hidden, false);
  const row = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').match(/<div id="ollama-status"[\s\S]*?<\/div>/)[0];
  assert.match(row, /Ollama/); assert.match(row, /Local models · no limit/); assert.doesNotMatch(row, /usage-meter|usage-bar/, 'No usage bar.');
  assert(asked.length && asked.every(method => method === 'GET'), 'Only reads what is installed: nothing starts or downloads.');
  catalog = null; ui.window.relayAgents.close(); ui.window.relayAgents.open(); await flush(); assert.equal(ui.$('ollama-status').hidden, true, 'Without Ollama there is no row.'); assert.equal(ui.$('notice').hidden, true, 'And no error.');
  catalog = { models: [], excluded: 0 }; ui.window.relayAgents.close(); ui.window.relayAgents.open(); await flush(); assert.equal(ui.$('ollama-status').hidden, true, 'Or with nothing downloaded.');
});

test('attachments stay with their workspace and accepted-send retry preserves attachment identity',async()=>{
  const ui=await browser({filesUI:true,moreProjects:true});
  await ui.window.relayFiles.addSnapshots([{name:'notes.md',data:'bm90ZXM='}]);await flush();
  const id=ui.window.relayFiles.ids()[0];assert.equal(ui.$('send-button').disabled,false,'Attachment-only messages can be sent.');
  await ui.switchProject('project-two');assert.equal(ui.window.relayFiles.ids().length,0);
  await ui.switchProject('project-one');assert.equal(ui.window.relayFiles.ids()[0],id);
  const submissions=[];
  ui.setIntercept((request,next)=>{if(request.path.endsWith('/messages')){submissions.push(request.body);if(submissions.length===1)return response({error:'Connection lost'},503);}return next();});
  ui.fire('composer','submit');await flush();assert.equal(ui.window.relayFiles.ids()[0],id);
  ui.$('notice-retry').click();await flush();
  assert.equal(submissions.length,2);assert.equal(submissions[0].requestId,submissions[1].requestId);
  assert.deepEqual(submissions[1].attachments,[id]);assert.equal(submissions[1].text,'Please review the attached files.');assert.equal(ui.window.relayFiles.ids().length,0);
});

test('an image thumbnail is let go once no draft attachment shows it',async()=>{
  // Only memory shows whether a thumbnail is still held, so the heap is measured after a full collection.
  v8.setFlagsFromString('--expose-gc');const gc=vm.runInNewContext('gc'),heap=()=>{gc();return process.memoryUsage().heapUsed;};
  const ui=await browser({filesUI:true}),megabyte=1024*1024;let count=0;
  ui.setIntercept((request,next)=>request.path==='/api/attachments'?response({id:(++count).toString(16).padStart(64,'0'),name:request.body.name,kind:'image',mime:'image/png',bytes:megabyte},201):next());
  await ui.window.relayFiles.addSnapshots([1,2,3].map(n=>({name:`screen-${n}.png`,data:String(n).repeat(8*megabyte)})));await flush();
  assert.equal(ui.$('attachment-list').querySelectorAll('.attachment-thumbnail').length,3);
  const attached=heap();ui.$('attachment-list').querySelector('.attachment-remove').click();await flush();
  const removed=heap();assert(attached-removed>4*megabyte,`Removing an image released ${((attached-removed)/megabyte).toFixed(1)} MB.`);
  assert.equal(ui.$('attachment-list').querySelectorAll('.attachment-thumbnail').length,2,'The other images keep their thumbnails.');
  ui.$('message-input').value='Review these screens';ui.fire('message-input','input');ui.fire('composer','submit');await flush();assert.equal(ui.window.relayFiles.ids().length,0);
  const sent=heap();assert(removed-sent>12*megabyte,`Sending the other two released ${((removed-sent)/megabyte).toFixed(1)} MB.`);
});

test('a thumbnail stays while another workspace still has the image as a draft',async()=>{
  const ui=await browser({filesUI:true,moreProjects:true}),thumbnails=()=>ui.$('attachment-list').querySelectorAll('.attachment-thumbnail').length;
  ui.setIntercept((request,next)=>request.path==='/api/attachments'?response({id:'a'.repeat(64),name:request.body.name,kind:'image',mime:'image/png',bytes:1024},201):next());
  await ui.window.relayFiles.addSnapshots([{name:'screen.png',data:'c2NyZWVu'}]);await flush();
  await ui.switchProject('project-two');await ui.window.relayFiles.addSnapshots([{name:'screen.png',data:'c2NyZWVu'}]);await flush();assert.equal(thumbnails(),1);
  ui.$('attachment-list').querySelector('.attachment-remove').click();await flush();assert.equal(ui.window.relayFiles.ids().length,0);
  await ui.switchProject('project-one');assert.equal(thumbnails(),1,'The image is still a draft here, so its thumbnail still shows.');
});

test('late attachment uploads stay with their original workspace and block premature send',async()=>{
  const ui=await browser({filesUI:true,moreProjects:true}), gate=deferred();
  ui.setIntercept(async(request,next)=>{if(request.path==='/api/attachments'){await gate.promise;}return next();});
  const adding=ui.window.relayFiles.addSnapshots([{name:'notes.md',data:'bm90ZXM='}]);
  ui.$('message-input').value='Review';ui.fire('message-input','input');assert.equal(ui.$('send-button').disabled,true);
  await ui.switchProject('project-two');gate.resolve();await adding;await flush();assert.equal(ui.window.relayFiles.ids().length,0);
  await ui.switchProject('project-one');assert.equal(ui.window.relayFiles.ids().length,1);assert.equal(ui.$('send-button').disabled,false);
});

test('a paste or drop while an attachment is uploading is added after it instead of being dropped',async()=>{
  const ui=await browser({filesUI:true}),gates=[deferred(),deferred()],names=[];
  ui.setIntercept(async(request,next)=>{if(request.path==='/api/attachments'){names.push(request.body.name);await gates[names.length-1]?.promise;}return next();});
  const paste=name=>ui.$('message-input').dispatchEvent(new UIEvent('paste',{clipboardData:{items:[{kind:'file',getAsFile:()=>new File([name],name,{type:'text/plain'})}]}}));
  paste('first.txt');await flush();assert.deepEqual(names,['first.txt']);
  paste('second.txt');ui.$('composer').dispatchEvent(new UIEvent('drop',{dataTransfer:{files:[new File(['third'],'third.txt',{type:'text/plain'})]}}));await flush();
  ui.$('message-input').value='Review';ui.fire('message-input','input');assert.equal(ui.$('send-button').disabled,true,'Sending waits for every queued file.');
  gates[0].resolve();await flush();assert.deepEqual(names,['first.txt','second.txt']);
  assert.equal(ui.$('send-button').disabled,true,'One file is done, but sending still waits for the others.');assert.equal(ui.$('attachment-status').textContent,'Adding attachments…');
  gates[1].resolve();await flush();
  assert.deepEqual(names,['first.txt','second.txt','third.txt'],'Each file is uploaded once, in the order it was added.');
  assert.deepEqual(ui.$('attachment-list').querySelectorAll('.attachment-name').map(node=>node.textContent),['first.txt','second.txt','third.txt']);
  assert.equal(ui.$('attachment-status').textContent,'3 attached · sent with your next message');assert.equal(ui.$('send-button').disabled,false);
});

test('a problem with a file that waited its turn still shows after the files behind it are added',async()=>{
  const ui=await browser({filesUI:true}),gate=deferred();let held=true;
  ui.setIntercept(async(request,next)=>{if(request.path==='/api/attachments'&&held){held=false;await gate.promise;}return next();});
  const paste=file=>ui.$('message-input').dispatchEvent(new UIEvent('paste',{clipboardData:{items:[{kind:'file',getAsFile:()=>file}]}}));
  paste(new File(['first'],'first.txt',{type:'text/plain'}));await flush();
  paste(new File([new Uint8Array(5*1024*1024+1)],'huge.txt',{type:'text/plain'}));paste(new File(['last'],'last.txt',{type:'text/plain'}));await flush();
  assert.equal(ui.$('attachment-status').textContent,'Adding attachments…');
  gate.resolve();await flush();
  assert.deepEqual(ui.$('attachment-list').querySelectorAll('.attachment-name').map(node=>node.textContent),['first.txt','last.txt']);
  assert.equal(ui.$('attachment-status').textContent,'huge.txt: files must be 5 MB or smaller.');
});

test('a screenshot picked in the preview while an attachment is uploading is still attached',async()=>{
  const ui=await browser({filesUI:true,previewUI:true,desktop:true}),gate=deferred();let held=true;
  ui.setIntercept(async(request,next)=>{if(request.path==='/api/attachments'&&held){held=false;await gate.promise;}return next();});
  const uploading=ui.window.relayFiles.addSnapshots([{name:'notes.md',data:'bm90ZXM='}]);await flush();
  const picked=ui.pickInPreview({projectId:'project-one',text:'The Apply button: ',image:{name:'preview-button.png',data:'iVBORw0KGgo='}});await flush();
  gate.resolve();await uploading;await picked;await flush();
  assert.deepEqual(ui.$('attachment-list').querySelectorAll('.attachment-name').map(node=>node.textContent),['notes.md','preview-button.png']);
});

test('Continue locally works without cloud sign-in and requires a model choice and explicit start',async()=>{
  const ui=await browser({localUI:true,authenticated:false});ui.$('select-claude').click();await flush();
  await ui.window.relayUI.setConfiguration({model:'saved-cloud-model',effort:'high'});await flush();
  ui.$('message-input').value='Finish the saved project';ui.fire('message-input','input');const id=ui.state().conversation.id;
  ui.$('open-local').click();await flush();assert.equal(ui.$('local-dialog').open,true);assert.equal(ui.$('local-start').disabled,true);
  assert.equal(ui.$('local-task').value,'Finish the saved project');assert.equal(ui.requests.some(request=>request.path==='/api/local-models/start'),false);
  ui.$('local-model').value='fixture-local:8b';ui.fire('local-model','change');assert.equal(ui.$('local-start').disabled,false);
  ui.$('local-start').click();ui.$('local-start').click();await flush();
  const requests=ui.requests.filter(request=>request.path==='/api/local-models/start');assert.equal(requests.length,1);assert.equal(requests[0].projectId,'project-one');assert.equal(requests[0].body.digest,'a'.repeat(64));
  assert.equal(ui.$('local-dialog').open,false);assert.equal(ui.state().conversation.id,id);assert.equal(ui.state().provider,'claude');assert.equal(ui.state().model,'saved-cloud-model');assert.equal(ui.state().effort,'high');
  assert.equal(ui.$('message-input').value,'Finish the saved project');assert(ui.document.querySelectorAll('.message-author').some(item=>item.textContent==='Local · Ollama'));
});

test('missing local prerequisites leave setup usable and never start inference',async()=>{
  const ui=await browser({localUI:true});
  ui.setIntercept((request,next)=>request.path==='/api/local-models'?response({installed:false,models:[],context:{mode:'read'}}):next());
  ui.$('open-local').click();await flush();assert.match(ui.$('local-status').textContent,/Install Codex CLI/);assert.equal(ui.$('local-start').disabled,true);
  ui.$('local-close').click();await flush();assert.equal(ui.$('local-dialog').open,false);assert.equal(ui.requests.some(request=>request.path==='/api/local-models/start'),false);
});

test('late local model discovery cannot follow the user into another workspace',async()=>{
  const ui=await browser({localUI:true,moreProjects:true}),held=deferred();
  ui.setIntercept((request,next)=>request.path==='/api/local-models'?held.promise.then(next):next());
  ui.$('open-local').click();await flush();ui.$('local-task').value='First workspace task';
  await ui.switchProject('project-two');assert.equal(ui.$('local-dialog').open,false);held.resolve();await flush();
  assert.equal(ui.state().projectId,'project-two');assert.equal(ui.requests.some(request=>request.path==='/api/local-models/start'),false);
  ui.setIntercept(null);ui.$('open-local').click();await flush();assert.notEqual(ui.$('local-task').value,'First workspace task');
});

test('a lost local-start response retries the same request ID and preserves the composer draft',async()=>{
  const ui=await browser({localUI:true});ui.$('message-input').value='Keep my draft';ui.fire('message-input','input');
  ui.$('open-local').click();await flush();ui.$('local-model').value='fixture-local:8b';ui.fire('local-model','change');let lost=false;
  ui.setIntercept((request,next)=>{const result=next();if(request.path==='/api/local-models/start'&&!lost){lost=true;throw Error('Response lost');}return result;});
  ui.$('local-start').click();await flush();assert.equal(ui.$('local-dialog').open,true);assert.match(ui.$('local-error').textContent,/cannot reach/i);
  ui.$('local-start').click();await flush();const requests=ui.requests.filter(request=>request.path==='/api/local-models/start');
  assert.equal(requests.length,2);assert.equal(requests[0].body.requestId,requests[1].body.requestId);assert.equal(ui.conversations[0].messages.filter(item=>item.connection==='local').length,1);assert.equal(ui.$('message-input').value,'Keep my draft');
});

test('the compact agent picker preserves cloud preferences and attachments when opening or cancelling a local handoff', async () => {
  const ui = await browser({ localUI: true, filesUI: true, moreProjects: true });
  await ui.window.relayUI.setConfiguration({ model: 'saved-cloud-model', effort: 'high' });
  await ui.window.relayFiles.addSnapshots([{ name: 'notes.md', data: 'bm90ZXM=' }]); await flush();
  const attachment = ui.window.relayFiles.ids()[0];
  ui.$('message-input').value = 'Keep this task'; ui.fire('message-input', 'input');
  ui.$('agent-select').value = 'local'; ui.fire('agent-select', 'change'); await flush();
  assert.equal(ui.$('local-dialog').open, true); assert.equal(ui.$('local-start').disabled, true);
  assert.equal(ui.state().model, 'saved-cloud-model'); assert.equal(ui.state().effort, 'high'); assert.equal(ui.$('agent-select').value, 'codex');
  assert(!ui.requests.some(request => request.path === '/api/local-models/start'));
  ui.$('local-close').click(); await flush();
  assert.equal(ui.$('message-input').value, 'Keep this task'); assert.equal(ui.window.relayFiles.ids()[0], attachment);
  ui.$('agent-select').value = 'claude'; ui.fire('agent-select', 'change'); await flush(); assert.equal(ui.state().provider, 'claude');
  await ui.switchProject('project-two'); assert.equal(ui.$('local-dialog').open, false); assert.equal(ui.$('agent-select').value, 'codex');
});

test('post-run shortcuts keep review and sharing behind preview, remain dismissed and never follow a workspace switch', async () => {
  const ui = await browser({ insights: true, reviewsUI: true, workbench: true, moreProjects: true, billingSource: 'unknown' }); reviewBrowserRoutes(ui);
  const chat = ui.canonical.get('project-one'); chat.status = 'complete'; chat.lastRun = { id: 'completed-run', status: 'complete', provider: 'codex' };
  await ui.window.relayUI.refresh(); await flush(); assert.equal(ui.$('next-actions').hidden, false); assert.match(ui.$('next-actions-text').textContent, /1 changed file/);
  ui.$('next-review').click(); await flush(); assert.equal(ui.$('review-dialog').open, true); assert.equal(ui.$('start-review').disabled, true);
  assert(!ui.requests.some(request => request.path === '/api/reviews/start'));
  ui.$('close-review').click(); ui.$('next-friend').click(); await flush(); assert.equal(ui.$('workbench').open, true);
  assert(!ui.requests.some(request => /\/(?:approve|publish)$/.test(request.path)), 'Opening sharing cannot approve or publish material.');
  ui.$('workbench').close(); ui.$('dismiss-next-actions').click(); ui.window.dispatchEvent(new UIEvent('relay-state')); await flush(); assert.equal(ui.$('next-actions').hidden, true);
  chat.lastRun = { ...chat.lastRun, id: 'new-completed-run' }; await ui.window.relayUI.refresh(); await flush(); assert.equal(ui.$('next-actions').hidden, false);
  await ui.switchProject('project-two'); assert.equal(ui.$('next-actions').hidden, true);
  await ui.switchProject('project-one'); chat.status = 'running'; await ui.window.relayUI.refresh(); await flush(); assert.equal(ui.$('next-actions').hidden, true);
});

test('Gemini requires explicit unverified-billing confirmation, supports custom model IDs and receives quota handoffs',async()=>{
  const ui=await browser({providers:{codex:{available:true},claude:{available:false},gemini:{available:true}},workbench:true,insights:true});
  ui.$('select-gemini').click();await flush();
  assert.equal(ui.state().provider,'gemini');assert.equal(ui.$('effort-select').disabled,true,'Gemini reasoning effort stays disabled until a model reports levels.');
  ui.$('message-input').value='Implement the Gemini handoff';ui.fire('message-input','input');
  assert.equal(ui.$('send-button').disabled,true,'Unverified Gemini billing blocks sending until reviewed.');
  assert.match(ui.$('connection-notice-text').textContent,/Billing could not be confirmed/);
  ui.$('relay-settings').click();await flush();
  await ui.window.relaySettings.open('accounts');const billingCheck=ui.labelledInput('Allow API and unconfirmed billing');billingCheck.checked=true;billingCheck.dispatchEvent(new UIEvent('change'));
  ui.$('settings').close();await flush();assert.equal(ui.$('send-button').disabled,false);
  ui.$('model-select').value='__custom__';ui.fire('model-select','change');
  ui.$('custom-model-input').value='gemini-2.5-pro';ui.$('save-custom-model').click();await flush();
  assert.equal(ui.state().model,'gemini-2.5-pro');
  ui.fire('composer','submit');await flush();
  const sent=ui.requests.find(request=>request.path.endsWith('/messages'));
  assert.equal(sent.body.provider,'gemini');assert.equal(sent.body.model,'gemini-2.5-pro');assert.equal(sent.body.billingConfirmed,true);
  const chat=ui.canonical.get('project-one');
  chat.messages.push({id:'gemini-reply',role:'assistant',provider:'gemini',model:'gemini-2.5-pro',text:'Gemini completed the task.'});
  chat.lastRun={provider:'gemini',effectiveModel:'gemini-2.5-pro',status:'complete',startedAt:'2026-10-31T10:00:00Z',endedAt:'2026-10-31T10:00:08Z',usage:{used:4200,size:1000000}};
  await ui.window.relayUI.refresh();await flush();
  assert(ui.document.querySelectorAll('.message-author').some(item=>item.textContent==='Gemini'));
  assert.match(ui.$('run-metrics').textContent,/4,200.*context tokens/);
  // Quota exhaustion on Codex offers Gemini when Claude is unavailable and Gemini billing is confirmed.
  ui.$('select-codex').click();await flush();
  Object.assign(chat,{provider:'codex',status:'incomplete',lastRun:{provider:'codex',status:'incomplete',errorCategory:'quota'}});
  await ui.window.relayUI.refresh();await flush();
  assert.match(ui.$('continue-button').textContent,/Continue with Gemini/);
});

test('the grouped picker selects a downloaded local model for normal Send without changing cloud preferences', async () => {
  const ui = await browser({ insights:true, modelPickerUI:true, filesUI:true, moreProjects:true, authenticated:false });
  await ui.window.relayUI.setConfiguration({ model:'saved-cloud-model', effort:'high' }); await flush();
  ui.$('message-input').value = 'Continue with a local model'; ui.fire('message-input','input');
  await ui.window.relayFiles.addSnapshots([{name:'notes.md',data:'bm90ZXM='}]); await flush(); const attachment = ui.window.relayFiles.ids()[0];
  ui.$('model-picker-button').click(); await flush();
  // One menu lists every agent; downloaded models appear in their own section.
  assert(ui.$('picker-models').querySelectorAll('.picker-section').some(section=>section.textContent.includes('Local · Ollama')));
  const option = ui.$('picker-models').querySelectorAll('button').find(item=>item.textContent.includes('fixture-local:8b')); assert(option); option.click(); await flush();
  assert.equal(ui.state().localSelections['project-one'].model,'fixture-local:8b'); assert.equal(ui.state().model,'saved-cloud-model'); assert.equal(ui.state().effort,'high');
  assert.equal(ui.$('picked-agent').textContent,'Local · Ollama'); assert.equal(ui.$('send-button').disabled,false);
  assert(!ui.requests.some(request=>request.path==='/api/local-models/start'));
  ui.fire('composer','submit'); await flush(); const sent = ui.requests.find(request=>request.path==='/api/local-models/start'); assert(sent);
  assert.equal(sent.body.model,'fixture-local:8b'); assert.deepEqual(sent.body.attachments,[attachment]); assert.equal(sent.body.task,'Continue with a local model');
  assert.equal(ui.state().model,'saved-cloud-model'); assert.equal(ui.window.relayFiles.ids().length,0);
  await ui.switchProject('project-two'); assert.equal(ui.$('picked-agent').textContent,'Codex'); await ui.switchProject('project-one'); assert.equal(ui.$('picked-agent').textContent,'Local · Ollama');
});

test('Ask a Friend prepares the current task and recent conversation, then exports only the visible approved preview', async () => {
  const ui = await browser({ workbench:true }); const chat = ui.canonical.get('project-one');
  chat.messages.push({id:'task',role:'user',text:'The checkout page crashes after payment.'},{id:'answer',role:'assistant',provider:'codex',text:'The error happens in the callback.'});
  await ui.window.relayUI.refresh(); ui.$('ask-friend').click(); await flush();
  assert.equal(ui.labelledInput('What you need help with').value,'The checkout page crashes after payment.');
  const prepare = ui.requests.find(request=>request.path==='/api/collaboration/handoffs/prepare'); assert.deepEqual(prepare.body.messageIds,['task','answer']); assert.equal(prepare.body.mode,'context');
  assert(ui.document.querySelector('.friend-ready-preview').textContent.includes('checkout page crashes'));
  assert(!ui.requests.some(request=>/\/(?:approve|publish)$/.test(request.path)));
  const input = ui.labelledInput('What you need help with'); input.value = 'Please inspect the callback'; input.dispatchEvent(new UIEvent('input'));
  assert.equal(ui.findButton('Export request file').disabled,true); ui.findButton('Refresh preview').click(); await flush(); ui.findButton('Export request file').click(); await flush();
  const approval = ui.requests.find(request=>request.path==='/api/collaboration/handoffs/approve'); assert.equal(approval.body.package.goal,'Please inspect the callback'); assert.equal(approval.body.approvedIntegrity,approval.body.package.integrity);
  assert(!ui.requests.some(request=>request.path.endsWith('/publish')));
});

test('contextual review preselects changes and runs in the side panel while the next prompt can be sent', async () => {
  const ui = await browser({ reviewsUI:true, insights:true }), fixture = reviewBrowserRoutes(ui, {background:true});
  await ui.window.relayReviews.suggest(); await flush();
  assert.equal(ui.$('review-dialog').open,true); assert.equal(ui.$('review-preview').hidden,false); assert.equal(ui.$('start-review').disabled,false);
  assert(!ui.requests.some(request=>request.path==='/api/reviews/start'));
  ui.$('start-review').click(); await flush();
  assert.equal(ui.$('review-dialog').open,false); assert.equal(ui.$('review-panel').hidden,false); assert.equal(ui.$('review-result').parentNode,ui.$('review-panel-body'));
  assert.equal(ui.requests.find(request=>request.path==='/api/reviews/start').body.background,true);
  ui.$('message-input').value='Start the next task'; ui.fire('message-input','input'); assert.equal(ui.$('send-button').disabled,false);
  ui.fire('composer','submit'); await flush(); assert(ui.requests.some(request=>request.path.endsWith('/messages'))); assert.equal(fixture.report.status,'running');
  const stop = ui.$('review-panel-body').querySelectorAll('button').find(button=>button.textContent==='Stop review'); assert(stop); stop.click(); await flush();
  assert(ui.requests.some(request=>request.path==='/api/reviews/review-one/stop')); assert(!ui.requests.some(request=>/conversations\/[^/]+\/stop$/.test(request.path)));
  ui.window.relayReviews.closePanel(); assert.equal(ui.$('review-panel').hidden,true);
});

test('prepared sharing exposes privacy warnings and requires reviewing them before approval or export', async () => {
  const ui = await browser({workbench:true});
  ui.setIntercept(async (request,next) => {
    const result = next();
    if (request.path !== '/api/collaboration/handoffs/prepare') return result;
    const data = await (await result).json(); data.warnings = [{code:'credential',message:'Possible private information in the selected content.'}]; return response(data);
  });
  ui.$('ask-friend').click(); await flush(); assert.equal(ui.findButton('Export request file').disabled,true);
  assert(ui.document.querySelectorAll('.scan-warning').some(item=>item.textContent.includes('1 privacy warning')));
  assert(!ui.requests.some(request=>request.path.endsWith('/approve')));
  const consent = ui.labelledInput('I reviewed the privacy warnings in this preview.'); consent.checked=true; consent.dispatchEvent(new UIEvent('change'));
  assert.equal(ui.findButton('Export request file').disabled,false); ui.findButton('Export request file').click(); await flush();
  assert.equal(ui.requests.filter(request=>request.path.endsWith('/approve')).length,1); assert(!ui.requests.some(request=>request.path.endsWith('/publish')));
});

test('permission controls offer Ask for permission and Full auto-approval and enforce read-only compatibility', async () => {
  const ui = await browser({ insights: true });
  assert.equal(ui.$('approval-select').value, 'ask');
  assert.equal(ui.state().approvalPolicy, 'ask');
  assert.equal(ui.$('approval-select').disabled, false);

  ui.$('approval-select').value = 'auto';
  ui.fire('approval-select', 'change');
  await flush();
  assert.equal(ui.state().approvalPolicy, 'auto');
  const providerPost = ui.requests.find(r => r.path.endsWith('/provider') && r.body.approvalPolicy === 'auto');
  assert(providerPost);
  assert.equal(providerPost.body.mode, 'edit');

  ui.$('mode-select').value = 'read';
  ui.fire('mode-select', 'change');
  await flush();
  assert.equal(ui.state().mode, 'read');
  assert.equal(ui.state().approvalPolicy, 'ask');
  assert.equal(ui.$('approval-select').value, 'ask');
  assert.equal(ui.$('approval-select').disabled, true);
});


test('Run is in the status bar; a command found in the folder is added in one click, and starting, stopping and hiding never touch the conversation',async()=>{
  const ui=await browser({commandsUI:true,desktop:true});
  ui.$('message-input').value='Keep coding while the server runs';ui.fire('message-input','input');
  assert.equal(ui.$('bottom-panel').hidden,true);assert.equal(ui.$('status-run').hidden,false);
  ui.$('status-run').click();await flush();await flush();
  assert.equal(ui.$('project-commands').hidden,false);assert.equal(ui.$('status-run').getAttribute('aria-pressed'),'true');
  assert.equal(ui.$('command-empty').hidden,false,'With no commands, Run offers what the folder defines.');
  const groups=ui.$('command-quick').querySelectorAll('.command-quick-group');
  assert.deepEqual(groups.map(group=>group.querySelector('.command-quick-folder').textContent),['Frontend','Backend'],'With several folders, each offers what it defines under its own name.');
  const quick=groups[0].querySelectorAll('.command-chip');
  assert.deepEqual(quick.map(chip=>chip.querySelector('.command-chip-name').textContent),['dev','test']);
  assert.equal(ui.requests.filter(request=>/\/(start|restart)$/.test(request.path)).length,0,'Finding commands never runs them.');
  quick[1].click();await flush();await flush();
  assert.deepEqual(ui.requests.filter(request=>request.path==='/api/commands/save').at(-1).body,{name:'test',command:'npm run test',folderId:'frontend',directory:'',test:true},'A test script is marked for Check with tests when none is.');
  assert.equal(ui.$('command-empty').hidden,true,'Once there is a command, Run shows it.');
  ui.$('command-add').click();ui.runTimers();await flush();await flush();
  assert.deepEqual(ui.$('command-suggestions').querySelectorAll('.command-chip-name').map(chip=>chip.textContent),['dev'],'Commands already added are not offered again.');
  ui.$('command-suggestions').querySelectorAll('.command-chip')[0].click();ui.$('command-form').dispatchEvent(new UIEvent('submit'));await flush();await flush();
  const rows=()=>ui.$('command-list').querySelectorAll('.command-row');
  assert.deepEqual(rows().map(row=>row.dataset.commandId),['test','dev']);
  assert.equal(ui.$('command-line').textContent,'npm run dev','The command just added is selected.');
  assert.deepEqual(ui.$('command-list').querySelectorAll('.run-folder-name').map(node=>node.textContent),['Frontend'],'Commands are listed under the folder they run in.');
  assert.deepEqual([ui.$('command-place').textContent,ui.$('command-place').hidden],['Frontend',false],'The output says where the command runs.');
  assert(rows()[0].querySelector('.command-test-mark'),'The command used for checks is marked.');
  rows()[0].querySelector('.command-pick').click();await flush();await flush();
  assert.equal(ui.$('command-line').textContent,'npm run test');
  rows()[1].querySelector('.command-pick').click();await flush();await flush();
  assert.equal(ui.$('command-line').textContent,'npm run dev');assert.equal(ui.$('command-state').textContent,'Not started');
  ui.$('command-start').click();ui.$('command-start').click();await flush();await flush();
  assert.equal(ui.requests.filter(request=>request.path==='/api/commands/start').length,1,'A double click starts it once.');
  assert.match(ui.$('command-state').textContent,/^Running · \d+s$/);assert.equal(ui.$('command-start').hidden,true);assert.equal(ui.$('command-stop').hidden,false);assert.equal(ui.$('command-restart').hidden,false);
  assert.equal(ui.$('command-output').querySelector('.ansi-green').textContent,'ready','Output keeps its colours.');
  assert.equal(ui.$('run-tab-count').textContent,'1');assert.equal(ui.$('status-run-state').textContent,'1');assert.equal(ui.$('status-run-state').dataset.state,'running');
  ui.$('command-links').children[0].click();await flush();assert(ui.externalLinks.includes('http://localhost:3000/'));
  ui.$('status-run').click();assert.equal(ui.$('bottom-panel').hidden,true,'Clicking Run again hides the panel.');
  assert.equal(ui.requests.filter(request=>request.path.endsWith('/stop')).length,0,'Hiding leaves commands running.');
  assert.equal(ui.$('status-run-state').textContent,'1','The status bar still says what runs.');
  ui.$('status-run').click();await flush();await flush();
  ui.$('command-stop').click();await flush();await flush();assert.equal(ui.$('command-state').textContent,'Stopped');assert.equal(ui.$('command-start').hidden,false);
  ui.$('command-clear').click();await flush();await flush();assert.equal(ui.$('command-state').textContent,'Not started');
  assert.equal(ui.$('message-input').value,'Keep coding while the server runs');
  assert.equal(ui.requests.filter(request=>/\/(messages|continue)$/.test(request.path)).length,0);
});

test('a running app opens in the preview from Run, and a pick goes into the message box as a sentence with its screenshot attached',async()=>{
  const ui=await browser({commandsUI:true,filesUI:true,previewUI:true,desktop:true});
  const attachments=[];ui.setIntercept((request,next)=>{if(request.path==='/api/attachments'&&request.method==='POST'){attachments.push(request.body);return response({id:'att-1',name:request.body.name,kind:'image',mime:'image/png',bytes:120});}return next();});
  ui.$('status-run').click();await flush();await flush();
  ui.$('command-quick').querySelectorAll('.command-chip')[0].click();await flush();await flush();
  assert.equal(ui.$('command-preview').hidden,true,'A command that isn’t running has nothing to preview.');
  ui.$('command-start').click();await flush();await flush();
  assert.equal(ui.$('command-preview').hidden,false,'A running app with a local address can be previewed.');
  ui.$('command-preview').click();await flush();
  assert.deepEqual(ui.previewOpens,[{projectId:'project-one',url:'http://localhost:3000/'}]);
  assert.equal(ui.window.relayCommands.localURL(),'http://localhost:3000/');
  ui.$('message-input').value='Make the promo field wider';ui.fire('message-input','input');
  await ui.pickInPreview({projectId:'project-one',text:'In the preview of localhost:3000/checkout, the “Apply” button (form#promo > button.apply; src/PromoForm.tsx:42 in PromoForm): ',image:{name:'preview-button.png',data:'iVBORw0KGgo='}});await flush();
  assert.equal(ui.$('message-input').value,'Make the promo field wider\nIn the preview of localhost:3000/checkout, the “Apply” button (form#promo > button.apply; src/PromoForm.tsx:42 in PromoForm): ','Each pick starts its own line after what is already written.');
  assert.deepEqual(attachments,[{name:'preview-button.png',data:'iVBORw0KGgo='}],'The screenshot is attached to the message.');
  assert.deepEqual([...ui.window.relayFiles.ids()],['att-1']);
  assert.equal(ui.requests.filter(request=>/\/(messages|continue)$/.test(request.path)).length,0,'Nothing is sent.');
  const web=await browser({commandsUI:true});assert.equal(web.window.relayPreview,undefined,'Without the desktop app there is no preview.');
});

test('commands are added and edited in a short form, stay with their workspace, and a failure can go to an agent without sending',async()=>{
  const ui=await browser({commandsUI:true,moreProjects:true});
  ui.$('status-run').click();await flush();await flush();
  ui.$('command-add').click();ui.runTimers();await flush();await flush();
  assert.equal(ui.$('command-form').hidden,false);assert.equal(ui.$('command-form-title').textContent,'Add a command');
  ui.$('command-suggestions').querySelectorAll('.command-chip')[0].click();
  assert.deepEqual([ui.$('command-name').value,ui.$('command-text').value],['dev','npm run dev'],'A suggestion fills the form.');
  ui.$('command-name').value='web';ui.$('command-text').value='npm run dev -- --port 3000';ui.$('command-test').checked=false;
  ui.$('command-form').dispatchEvent(new UIEvent('submit'));await flush();await flush();
  assert.deepEqual(ui.requests.filter(request=>request.path==='/api/commands/save').at(-1).body,{name:'web',folderId:'frontend',directory:'',command:'npm run dev -- --port 3000',test:false});
  assert.equal(ui.$('command-form').hidden,true);assert.equal(ui.$('command-line').textContent,'npm run dev -- --port 3000');
  ui.$('command-edit').click();await flush();
  assert.equal(ui.$('command-form-title').textContent,'Edit web');assert.equal(ui.$('command-remove').hidden,false);assert.equal(ui.$('command-text').value,'npm run dev -- --port 3000');
  ui.$('command-cancel').click();await flush();assert.equal(ui.$('command-form').hidden,true);

  await ui.switchProject('project-two');await flush();await flush();
  assert.equal(ui.$('command-empty').hidden,false,'Another workspace has its own commands.');
  await ui.switchProject('project-one');await flush();await flush();
  assert.equal(ui.$('command-line').textContent,'npm run dev -- --port 3000');

  // A failed command offers to put its failure in the message box, where it waits to be read and sent.
  ui.setIntercept((request,next)=>request.path==='/api/commands'?response({commands:[{id:'web',name:'web',folderId:'frontend',directory:'',command:'npm test'}],sessions:{web:{id:'s1',commandId:'web',status:'failed',command:'npm test',cwd:'/workspace/example/frontend',output:'<script>untrusted</script>\nAssertionError: expected 100 to equal 90',ansi:'<script>untrusted</script>\nAssertionError: expected 100 to equal 90',exitCode:1,urls:['javascript:alert(1)','http://evil.example','http://user:pass@localhost:42','http://localhost:42']}}}):next());
  await ui.window.relayCommands.refresh();await flush();
  assert.equal(ui.$('command-state').textContent,'Failed · exit 1');assert.equal(ui.$('command-fix').hidden,false);
  assert.match(ui.$('command-output').textContent,/<script>untrusted<\/script>/,'Output is literal text.');assert.equal(ui.$('command-output').querySelector('script'),null);
  assert.equal(ui.$('command-links').children.length,1,'Only local links without credentials can be opened.');
  assert.equal(ui.$('status-run-state').dataset.state,'failed');
  ui.$('message-input').value='';ui.$('command-fix').click();
  assert.match(ui.$('message-input').value,/^The web command failed with exit code 1\. Find the cause and fix it\.\n\nCommand: npm test \(in Frontend\)\n\nEnd of its output:\n```\n<script>untrusted<\/script>\nAssertionError/);
  assert.equal(ui.requests.filter(request=>/\/(messages|continue)$/.test(request.path)).length,0,'Nothing is sent.');
});

const panelFixture = () => ({ ledgerTask: { id: 't1', prompt: 'Add promo codes to checkout', agents: { claude: {}, codex: {} }, workingMs: 150000, runs: 2, handoffs: 1, retries: 0, reviews: 0, status: 'complete', verification: 'passed', usage: { input: 1200, output: 50, cacheRead: 300, cacheWrite: null, reasoning: null, runs: 2, runsWithTokens: 1, partialRuns: 0 } } });
const emptyUsage = () => ({ input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, runs: 1, runsWithTokens: 0, partialRuns: 0 });

test('the side panel has four tabs; each opens its own panel, is remembered, and old links into the Agents panel still land', async () => {
  const ui = await browser({ insights: true, agentsUI: true, layoutUI: true, wide: true });
  await flush();
  assert.equal(ui.$('agents-panel').hidden, false, 'Agents opens first.');
  const show = ui.window.relayUI.showSidePanel;
  show('brief'); await flush();
  assert.deepEqual([ui.$('brief-panel').hidden, ui.$('agents-panel').hidden, ui.$('git-panel').hidden], [false, true, true], 'One panel at a time.');
  assert.equal(ui.storage.get('throughline:side-panel'), 'brief');
  show('tasks'); await flush();
  assert.deepEqual([ui.$('tasks-panel').hidden, ui.$('brief-panel').hidden], [false, true]);
  show('git'); await flush();
  assert.deepEqual([ui.$('git-panel').hidden, ui.$('tasks-panel').hidden], [false, true]);
  ui.window.relayAgents.open('memory'); await flush();
  assert.equal(ui.$('brief-panel').hidden, false, 'Memory now lives in the Brief panel, and older links follow it there.');
  ui.$('toggle-side-panel').click(); await flush();
  assert.equal(ui.$('brief-panel').hidden, true);
  ui.$('toggle-side-panel').click(); await flush();
  assert.equal(ui.$('brief-panel').hidden, false, 'The layout button brings back the panel last open.');
  const remembered = await browser({ insights: true, agentsUI: true, layoutUI: true, wide: true, stored: { 'throughline:side-panel': 'tasks' } }); await flush();
  assert.deepEqual([remembered.$('tasks-panel').hidden, remembered.$('agents-panel').hidden], [false, true], 'A workspace reopens on the panel last chosen.');
});

test('the Tasks panel shows the current task with its agents, numbers and tests, the tasks before it, and never shows unknown as zero', async () => {
  const { ledgerTask } = panelFixture();
  const ledger = prompts => ({ runs: [], quotaObservations: [], tasks: [
    { id: 'old', ...(prompts ? { prompt: 'Fix the header' } : {}), agents: { gemini: {} }, workingMs: 5000, runs: 1, handoffs: 0, retries: 0, reviews: 0, status: 'complete', verification: 'unverified', usage: emptyUsage() },
    { ...ledgerTask, ...(prompts ? {} : { prompt: undefined }) },
  ] });
  const ui = await browser({ insights: true, agentsUI: true, wide: true });
  const asked = [];
  ui.setIntercept((request, next) => {
    if (request.path === '/api/ledger') { asked.push(request.params.prompts); return response(ledger(request.params.prompts === '1')); }
    if (request.path === '/api/budget') return response({ policy: {}, defaults: {}, quota: {}, task: null });
    return next();
  });
  await ui.window.relayUI.refresh(); ui.window.relayTasks.open(); await flush(); ui.window.dispatchEvent(new UIEvent('relay-state')); await flush();
  const card = ui.$('task-card');
  assert.equal(card.hidden, false);
  assert.equal(ui.$('tasks-empty').hidden, true);
  assert.equal(card.querySelector('.task-prompt').textContent, 'Add promo codes to checkout');
  assert.deepEqual(card.querySelectorAll('.status-pill').map(item => item.textContent), ['Finished', 'Tests passed']);
  assert.deepEqual(card.querySelectorAll('.message-avatar').map(item => item.className), ['message-avatar claude', 'message-avatar codex']);
  assert.deepEqual(card.querySelectorAll('.stat').map(tile => tile.querySelector('strong').textContent), ['2m 30s', '1.3k', '2']);
  assert.match(card.querySelectorAll('.stat')[1].title, /1 of 2 runs reported/);
  assert.equal(card.querySelector('.task-limits'), null, 'No limits set, so no bars.');
  const earlier = ui.$('tasks-list').children;
  assert.equal(earlier.length, 1);
  assert.match(earlier[0].textContent, /Fix the header/);
  assert.match(earlier[0].textContent, /No tests run/);
  assert.match(earlier[0].textContent, /Usage not reported/);
  assert.doesNotMatch(earlier[0].textContent, /\b0 (input|output)/);
  assert.equal(ui.$('tasks-export').hidden, false);
  assert.equal(asked.at(-1), '1');
});

test('the Brief panel says what the next agent gets, opens the full brief, and keeps a note for it', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true });
  const brief = { note: 'Compiled', scope: { folders: ['website'], otherFolders: ['desktop'] }, repositoryInstructions: [{ folder: 'website', path: 'AGENTS.md', text: 'rules' }], memory: [{ kind: 'decision', text: 'Prices show the code first' }], skills: { active: [{ name: 'test-authoring', reason: 'asked for' }], available: [{ name: 'api-contracts' }] }, changedFiles: [{ folder: 'website', path: 'hero.tsx', status: 'M' }], failedAttempts: [{ what: 'npm test', how: 'exit 1', times: 2 }], unfinishedPlan: [{ text: 'Write the test', status: 'pending' }] };
  const posted = [];
  ui.setIntercept((request, next) => {
    if (request.path === '/api/conversation/brief') return response({ brief, metadata: { size: { estimatedTokens: 4200 } } });
    if (request.path === '/api/memory') return response({ entries: [{ id: 'm', kind: 'decision', text: 'Prices show the code first', status: 'active', source: {} }], suggestions: [] });
    if (request.path === '/api/skills') return response({ dirs: [], enabled: [], available: [] });
    if (/\/context$/.test(request.path)) { posted.push(request.body); return next(); }
    return next();
  });
  await ui.window.relayUI.refresh(); ui.window.relayBrief.open(); await flush(); ui.window.dispatchEvent(new UIEvent('relay-state')); await flush();
  const rows = ui.$('brief-composition').querySelectorAll('.brief-item-value').map(item => item.textContent);
  assert.deepEqual(rows, ['website (not desktop)', 'All 1 entry', '2 enabled, 1 in use', 'AGENTS.md', '1', '1 attempt', '1']);
  assert.match(ui.$('brief-size').textContent, /≈4.2k tokens \(estimate\)/);
  ui.$('brief-view').click(); await flush();
  assert.equal(ui.$('brief-dialog').open, true);
  const titles = ui.$('brief-dialog-body').querySelectorAll('.brief-block-title').map(item => item.textContent);
  assert.deepEqual(titles, ['Folders in scope', 'Repository instructions', 'Memory', 'Skills', 'Changed so far', 'Went wrong before', 'The plan so far']);
  assert.match(ui.$('brief-dialog-body').textContent, /npm test.*exit 1 · 2×/);
  ui.$('brief-dialog-close').click();
  assert.equal(ui.$('memory-empty').hidden, true);
  assert.equal(ui.$('skills-empty').hidden, false, 'With nothing enabled, the section explains what a skill is.');
  ui.$('brief-note').value = 'Ship behind a flag'; ui.$('brief-save').click(); await flush();
  assert.deepEqual(posted, [{ summary: 'Ship behind a flag' }]);
});

test('Remember on a message opens the dialog, and memory lists what is kept with its suggestions, recheck flags and retiring', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true, setup: true });
  let view = { entries: [{ id: 'one', kind: 'convention', text: 'Dates are UTC', folderId: null, status: 'active', needsRecheck: true, changedFiles: ['a.js'], source: { commit: 'abc1234' } }], suggestions: [{ key: '0123456789abcdef', kind: 'decision', text: 'Prices show the code first', folderId: null, messageId: 'u1', runId: 'r1' }] };
  const posted = [];
  ui.setIntercept((request, next) => {
    if (request.path === '/api/memory') return response(view);
    if (request.path === '/api/conversation/brief') return response({ brief: null, metadata: {} });
    if (request.path === '/api/skills') return response({ dirs: [], enabled: [], available: [] });
    if (/\/memory$/.test(request.path)) { posted.push(request.body); return response(view); }
    return next();
  });
  ui.canonical.get('project-one').messages.push({ id: 'u1', runId: 'r1', role: 'user', text: 'Keep prices in cents', createdAt: '2026-11-01T10:00:00Z' }, { id: 's1', runId: 'r1', role: 'activity', text: '$ npm test\nok' });
  await ui.window.relayUI.refresh(); ui.window.relayBrief.open(); await flush(); ui.window.dispatchEvent(new UIEvent('relay-state')); await flush();
  const rows = ui.$('memory-list').children, buttons = host => host.querySelectorAll('button'), named = (host, label) => buttons(host).find(item => item.textContent === label);
  assert.equal(rows.length, 1);
  assert.equal(ui.$('memory-count').textContent, '1');
  assert.match(rows[0].textContent, /Dates are UTC/);
  assert.equal(rows[0].querySelector('.kind-dot').dataset.kind, 'convention');
  assert.match(rows[0].querySelector('.panel-row-meta').textContent, /Convention · abc1234/);
  assert.match(rows[0].querySelector('.bad').textContent, /Needs recheck/);
  assert.equal(ui.$('memory-suggested').hidden, false);
  assert.match(ui.$('memory-suggestions').children[0].textContent, /Prices show the code first/);
  named(rows[0], 'Retire').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'retire', id: 'one' });
  named(ui.$('memory-suggestions').children[0], 'Keep').click(); await flush();
  assert.deepEqual([posted.at(-1).action, posted.at(-1).text, posted.at(-1).suggested], ['add', 'Prices show the code first', true], 'Kept only because the person chose it.');
  named(ui.$('memory-suggestions').children[0], 'Dismiss').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'dismiss', key: '0123456789abcdef' });
  ui.$('message-u1').querySelector('.message-remember').click();
  assert.equal(ui.$('memory-dialog').open, true);
  assert.equal(ui.$('memory-text').value, 'Keep prices in cents');
  ui.$('memory-kind').value = 'decision';
  ui.$('memory-form').dispatchEvent(new UIEvent('submit')); await flush();
  assert.deepEqual([posted.at(-1).action, posted.at(-1).kind, posted.at(-1).text, posted.at(-1).messageId, posted.at(-1).runId], ['add', 'decision', 'Keep prices in cents', 'u1', 'r1']);
  assert.equal(ui.$('memory-dialog').open, false);
  assert(ui.document.querySelector('.activity-remember'), 'A step can be remembered too.');
  view = { entries: [{ id: 'old', kind: 'decision', text: 'Old rule', status: 'retired', source: {} }], suggestions: [] };
  ui.$('memory-add').click(); ui.$('memory-cancel').click();
  ui.$('memory-text').value = 'x'; ui.$('memory-form').dispatchEvent(new UIEvent('submit')); await flush();
  assert.deepEqual(buttons(ui.$('memory-list').children[0]).map(item => item.textContent), ['Edit', 'Restore', 'Delete'], 'Deleting takes retiring first.');
  assert.equal(ui.$('memory-count').hidden, true);
});

test('tasks show as threads: each opens its own conversation, says how it runs, and a copy is merged only after review', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true }), conversation = ui.canonical.get('project-one'), asked = [], posted = [], label = [];
  const running = { id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Add promo codes', folderName: 'website', folderId: 'f', status: 'running', mode: 'direct', approvals: 2, conversationId: 'lane-a', hasWorktree: false };
  const copy = { id: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'Fix the tray', folderName: 'desktop', folderId: 'g', status: 'complete', mode: 'worktree', uncommitted: 2, approvals: 0, conversationId: 'lane-b', hasWorktree: true };
  const waiting = { id: 'cccccccc-0000-4000-8000-000000000003', title: 'Update the docs', folderName: 'docs', folderId: 'h', status: 'waiting', held: true, reason: 'Codeshi restarted. Start it when you’re ready.', approvals: 0, hasWorktree: false };
  conversation.parallelTasks = [running, copy, waiting];
  let review = { digest: 'digest-one', conflicts: 0, folder: 'desktop', canCheck: true, testCommand: 'npm test', check: null, files: [{ path: 'tray.js', change: 'update', added: 2, removed: 1, status: 'merged', diff: '+x' }, { path: 'new.js', change: 'add', added: 1, removed: 0, status: 'clean' }] };
  const lane = (id, task, text) => ({ ...conversation, id, status: task.status === 'running' ? 'running' : 'complete', activeRun: task.status === 'running' ? { id: 'run', provider: 'codex', startedAt: new Date().toISOString() } : null, messages: [{ id: id + '-m', role: 'user', text, seq: 1 }], cursor: 1, task, parallelTasks: conversation.parallelTasks, checkpoints: {} });
  ui.setIntercept((request, next) => {
    if (request.path === '/api/conversation' && request.params.task) { asked.push(request.params.task); return response(request.params.task === running.id ? lane('lane-a', running, 'Promo work') : lane('lane-b', copy, 'Tray work')); }
    if (request.path === '/api/tasks/plan') { label.push(request.body); return response({ mode: 'worktree', reason: 'The main conversation is using this repository, so this task works in its own copy from the last commit.', uncommitted: 2 }); }
    if (request.path === '/api/tasks') { posted.push(request.body); return response({ id: 'new' }, 202); }
    const action = request.path.match(/^\/api\/tasks\/[\da-f-]+\/(\w+)$/)?.[1];
    if (action) { posted.push({ action, ...request.body }); return response(action === 'review' ? review : action === 'merge' ? { merged: 2 } : action === 'keep' ? { branch: 'codeshi/fix-the-tray-bbbbbb' } : action === 'check' ? { status: 'failed', exitCode: 1, output: 'boom', command: 'npm test', digest: 'digest-one' } : {}); }
    return next();
  });
  await ui.window.relayUI.refresh(); await flush();
  const row = ui.$('task-list'), tabs = () => row.children.map(item => item.children[0]);
  assert.equal(ui.$('task-section').hidden, false);
  assert.deepEqual(tabs().map(tab => tab.children.map(item => item.textContent).filter(Boolean).join(' / ')), ['Workspace chat / Whole workspace', 'Add promo codes / 2', 'Fix the tray / Review', 'Update the docs / docs']);
  assert.equal(ui.$('task-banner').hidden, true, 'Main needs no banner.');
  tabs()[1].click(); await flush();
  assert.equal(ui.state().taskId, running.id); assert.equal(asked.at(-1), running.id);
  assert.equal(ui.state().conversation.id, 'lane-a'); assert.match(ui.$('messages').textContent, /Promo work/);
  assert.equal(ui.window.relayUI.isRunning(), true, 'This task’s own run.');
  assert.match(ui.$('task-banner').textContent, /website · Working.*directly in this folder/s);
  const stops = ui.requests.length; ui.$('stop-button').click(); await flush();
  assert(ui.requests.slice(stops).some(request => request.path === '/api/conversations/lane-a/stop'), 'Stop goes to this task.');
  // A task that hasn't started shows its details, without leaving this conversation.
  tabs()[3].click(); await flush();
  assert.equal(ui.state().taskId, running.id); assert.match(ui.$('task-banner').textContent, /docs · Waiting.*restarted/s);
  ui.$('task-banner').querySelectorAll('button').find(item => item.textContent === 'Start').click(); await flush();
  assert.equal(posted.at(-1).action, 'start');
  // A copy: reviewing shows every file, and merging sends what was reviewed.
  tabs()[2].click(); await flush();
  assert.equal(ui.state().conversation.id, 'lane-b'); assert.equal(ui.window.relayUI.isRunning(), false);
  assert.match(ui.$('task-banner').textContent, /own copy from the last commit, without 2 uncommitted changes/);
  ui.$('task-banner').querySelectorAll('button').find(item => item.textContent === 'Review and merge').click(); await flush();
  assert.equal(ui.$('task-merge-dialog').open, true);
  assert.match(ui.$('task-merge-title').textContent, /Merge “Fix the tray” into desktop/);
  assert.match(ui.$('task-merge-summary').textContent, /2 files would change/);
  assert.deepEqual(ui.$('task-merge-files').children.map(item => item.dataset.status), ['merged', 'clean']);
  assert.equal(ui.$('task-merge-apply').disabled, false);
  ui.$('task-merge-test').click(); await flush();
  assert.match(ui.$('task-merge-check').textContent, /Tests failed on the combined result/); assert.equal(ui.$('task-merge-output').textContent, 'boom');
  assert.equal(ui.$('task-merge-apply').disabled, true, 'Failing tests need a yes.');
  ui.$('task-merge-accept').checked = true; ui.$('task-merge-accept').dispatchEvent(new UIEvent('change')); assert.equal(ui.$('task-merge-apply').disabled, false);
  ui.$('task-merge-apply').click(); await flush();
  assert.deepEqual([posted.at(-1).action, posted.at(-1).digest, posted.at(-1).acceptFailedCheck], ['merge', 'digest-one', true]);
  assert.equal(ui.$('task-merge-dialog').open, false);
  // A conflict can't be merged, and is said plainly.
  review = { ...review, conflicts: 1, files: [{ path: 'tray.js', change: 'update', added: 1, removed: 1, status: 'conflict', reason: 'This file also changed here, in the same lines.' }] };
  ui.$('task-banner').querySelectorAll('button').find(item => item.textContent === 'Review and merge').click(); await flush();
  assert.equal(ui.$('task-merge-apply').disabled, true); assert.match(ui.$('task-merge-summary').textContent, /1 of 1 file conflicts.*both versions are safe/s);
  assert.equal(ui.$('task-merge-test').hidden, true);
  ui.$('task-merge-keep').click(); await flush(); assert.equal(posted.at(-1).action, 'keep');
  // Back to Main.
  tabs()[0].click(); await flush();
  assert.equal(ui.state().taskId, null); assert.equal(ui.$('task-banner').hidden, true); assert.equal(ui.state().conversation.id, conversation.id);
});

test('with a folder selected, + opens a blank task with the real composer, and sending starts it and moves to it', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true, filesUI: true, modelPickerUI: true }), conversation = ui.canonical.get('project-one'), posted = [], plans = [], settings = [];
  const [first, second] = ui.state().projects.find(project => project.id === 'project-one').folders;
  const beside = { id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Other work', folderName: 'Backend', folderId: second.id, status: 'running', mode: 'direct', approvals: 0, conversationId: 'lane-a', hasWorktree: false };
  conversation.parallelTasks = [beside];
  conversation.memory = undefined;
  let answer = { mode: 'worktree', reason: 'It works in its own copy.', uncommitted: 2, running: 1, limit: 2, full: false };
  ui.setIntercept((request, next) => {
    if (request.path === '/api/tasks/plan') { plans.push(request.body); return response(answer); }
    if (request.path === '/api/memory') return response({ entries: [{ id: 'm1', status: 'active', folderId: null }, { id: 'm2', status: 'active', folderId: first.id }, { id: 'm3', status: 'active', folderId: second.id }, { id: 'm4', status: 'retired', folderId: null }], suggestions: [] });
    if (request.path === '/api/skills') return response({ enabled: [{ name: 's', enabled: true }, { name: 'off', enabled: false }], available: [], dirs: [] });
    if (request.path === '/api/tasks') { posted.push(request.body); const task = { id: 'cccccccc-0000-4000-8000-000000000003', title: request.body.text, folderName: 'Frontend', folderId: request.body.folderId, status: 'running', mode: 'worktree', approvals: 0, conversationId: 'lane-new', hasWorktree: true }; conversation.parallelTasks = [...conversation.parallelTasks, task]; return response(task, 202); }
    if (request.path === '/api/conversation' && request.params.task) return response({ ...conversation, id: 'lane-new', status: 'running', activeRun: { id: 'r', provider: 'claude', startedAt: new Date().toISOString() }, messages: [{ id: 'n', role: 'user', text: 'Build the search page', seq: 1 }], cursor: 1, task: conversation.parallelTasks.at(-1), checkpoints: {} });
    if (/\/provider$/.test(request.path)) { settings.push(request.body); return next(); }
    return next();
  });
  await ui.window.relayUI.refresh(); await flush();
  // The workspace has no one folder to put a task in, so it offers no +.
  assert.equal(ui.window.relayUI.sidebarLevel(), 'workspace'); assert.equal(ui.$('new-task').hidden, true);
  const group = () => ui.document.querySelectorAll('.workspace-group').find(item => item.classList.contains('active')), rows = () => ui.$('task-list').children.map(item => item.querySelector('.task-row-title')?.textContent || item.textContent);
  group().querySelectorAll('.workspace-folder-pick')[0].click(); await flush();
  assert.equal(ui.$('new-task').hidden, false, 'A folder does.');
  assert.equal(ui.state().taskDraft ?? null, null, 'Selecting a folder alone leaves the conversation where it is, so files can be browsed.');
  ui.$('message-input').value = 'Half a thought for Main'; ui.fire('message-input', 'input');
  ui.$('new-task').click(); await flush(); await flush();
  // Nothing is asked: the folder is the one selected, and the real composer is right there.
  assert.equal(ui.state().taskDraft.folderId, first.id); assert.equal(ui.$('task-draft').hidden, false); assert.equal(ui.$('empty-state').hidden, true);
  assert.equal(ui.state().conversation.messages.length, 0); assert.equal(ui.$('message-input').value, '', 'Main’s draft stays with Main.');
  assert.equal(ui.$('task-draft-title').textContent, 'New task in ' + (first.displayName || first.name));
  assert.match(ui.$('task-draft-plan').textContent, /own copy.*2 uncommitted changes aren’t included/s); assert.equal(ui.$('task-draft-plan').dataset.mode, 'worktree');
  assert.match(ui.$('task-draft-beside').textContent, /Backend: Other work/);
  assert.equal(ui.$('task-draft-knows').textContent, 'Your project brief, 2 memories, 1 skill.', 'What applies to this folder and is on.');
  assert.equal(ui.window.relayUI.isRunning(), false);
  assert.equal(ui.$('send-button').hidden, false);
  // The row titles itself as you type.
  assert.deepEqual(rows(), ['New task']);
  ui.$('message-input').value = 'Build the search page'; ui.fire('message-input', 'input');
  assert.equal(ui.$('task-list').querySelector('.task-row-draft-title').textContent, 'Build the search page');
  // Choosing another agent or access here says what changes, and doesn't touch the main conversation.
  const before = plans.length;
  answer = { ...answer, mode: 'wait', reason: 'It waits.', uncommitted: 0, full: true };
  ui.$('provider-select')?.dispatchEvent?.(new UIEvent('change'));
  await ui.window.relayUI.setConfiguration({ model: 'claude-opus', effort: 'high' }); await flush();
  assert.deepEqual([ui.state().model, ui.state().effort], ['claude-opus', 'high']); assert.deepEqual(settings, [], 'The main conversation keeps its own settings.');
  ui.state().approvalPolicy = 'auto'; ui.window.dispatchEvent(new UIEvent('relay-state')); await flush(); await flush();
  assert(plans.length > before, 'How it runs is worked out again.'); assert.equal(plans.at(-1).approvalPolicy, 'auto'); assert.equal(ui.$('task-draft-plan').dataset.mode, 'wait'); assert.match(ui.$('task-draft-plan').textContent, /All 2 task slots are in use/);
  // A refresh doesn't bring the main conversation's messages or settings back in.
  await ui.window.relayUI.refresh(); await flush();
  assert.equal(ui.state().conversation.messages.length, 0); assert.equal(ui.state().model, 'claude-opus');
  // Sending starts it, with the composer's choices, and the conversation moves to it.
  ui.$('task-draft-history').checked = true;
  ui.$('send-button').click?.(); ui.$('composer').dispatchEvent(new UIEvent('submit', { cancelable: true })); await flush(); await flush();
  assert.equal(posted.length, 1, 'Once.');
  assert.deepEqual([posted[0].text, posted[0].folderId, posted[0].model, posted[0].effort, posted[0].approvalPolicy, posted[0].includeHistory, posted[0].dependsOn], ['Build the search page', first.id, 'claude-opus', 'high', 'auto', true, null]);
  assert.equal(ui.state().taskDraft, null); assert.equal(ui.state().taskId, 'cccccccc-0000-4000-8000-000000000003'); assert.equal(ui.state().conversation.id, 'lane-new');
  assert.equal(ui.$('task-draft').hidden, true); assert.equal(ui.$('message-input').value, '');
  assert.equal(ui.requests.filter(request => /\/messages$/.test(request.path)).length, 0, 'Nothing went to the main conversation.');
  // Going elsewhere puts a blank task away, and what was typed is still there when it comes back.
  ui.$('new-task').click(); await flush(); await flush();
  ui.$('message-input').value = 'Kept for later'; ui.fire('message-input', 'input');
  group().querySelector('.workspace-item').click(); await flush(); await flush();
  assert.equal(ui.state().taskDraft, null, 'The workspace puts it away.'); assert.equal(ui.$('task-draft').hidden, true); assert.equal(ui.$('message-input').value, 'Half a thought for Main', 'And Main’s draft comes back.');
  group().querySelectorAll('.workspace-folder-pick')[0].click(); await flush(); ui.$('new-task').click(); await flush(); await flush();
  assert.equal(ui.$('message-input').value, 'Kept for later');
  // A task that has to wait has no conversation yet, so its details show.
  ui.$('task-draft-cancel').click(); await flush(); await flush();
  assert.equal(ui.state().taskDraft, null); assert.equal(ui.state().conversation.id, conversation.id);
});

test('the sidebar keeps workspace chat and scoped tasks independent from opening or closing Files', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true, filesUI: true }), conversation = ui.canonical.get('project-one'), state = () => ui.state();
  const [first, second] = state().projects.find(project => project.id === 'project-one').folders;
  const made = (id, title, folder) => ({ id, title, folderName: folder.displayName || folder.name, folderId: folder.id, status: 'running', mode: 'direct', approvals: 0, conversationId: 'lane-' + id, hasWorktree: false });
  conversation.parallelTasks = [made('aaaaaaaa-0000-4000-8000-000000000001', 'In the first', first), made('bbbbbbbb-0000-4000-8000-000000000002', 'In the second', second)];
  await ui.window.relayUI.refresh(); await flush();
  const titles = () => ui.$('task-list').children.map(item => item.querySelector('.task-row-title')?.textContent || item.textContent), group = () => ui.document.querySelectorAll('.workspace-group').find(item => item.classList.contains('active'));
  assert.equal(ui.window.relayUI.sidebarLevel(), 'workspace', 'A workspace with several folders opens at the workspace level.');
  assert.deepEqual(titles(), ['Workspace chat', 'In the first', 'In the second']);
  assert.equal(ui.$('task-list').querySelector('.task-row-main').title.includes('every folder'), true, 'The main conversation reads differently.');
  assert.equal(ui.$('explorer').hidden, true, 'No files at the workspace level.');
  assert.deepEqual(group().querySelectorAll('.workspace-folder').filter(item => item.classList.contains('selected')), [], 'And no one folder is selected.');
  const folders = () => group().querySelectorAll('.workspace-folder-pick');
  folders()[1].click(); await flush();
  assert.equal(ui.window.relayUI.sidebarLevel(), 'folder'); assert.deepEqual(titles(), ['In the second'], 'A folder lists only its own tasks.');
  assert.equal(ui.$('explorer').hidden, true, 'Folder selection does not open Files.');
  assert.equal(group().querySelectorAll('.workspace-folder')[1].classList.contains('selected'), true);
  assert.equal(ui.storage.get('ai-relay:sidebar-level:project-one'), 'folder', 'It is remembered.');
  conversation.parallelTasks = conversation.parallelTasks.filter(task => task.folderId !== first.id);
  await ui.window.relayUI.refresh(); folders()[0].click(); await flush();
  assert.deepEqual(titles(), [ 'No tasks in ' + (first.displayName || first.name) + ' yet.' ]);
  group().querySelector('.workspace-item').click(); await flush();
  assert.equal(ui.window.relayUI.sidebarLevel(), 'workspace', 'Clicking the open workspace goes back to it.'); assert.equal(ui.$('explorer').hidden, true); assert.deepEqual(titles(), ['Workspace chat', 'In the second']);
  // The Files menu command doesn't do nothing while Files is hidden.
  ui.$('toggle-explorer').click(); await flush();
  assert.equal(ui.$('explorer').hidden, false); assert.equal(ui.window.relayUI.sidebarLevel(), 'workspace');
  assert.deepEqual(titles(), ['Workspace chat', 'In the second']);
  ui.$('close-files').click(); await flush();
  assert.deepEqual(titles(), ['Workspace chat', 'In the second'], 'Closing Files leaves the task scope and rows alone.');
  assert.equal(ui.$('file-tree').hidden, false, 'And it shows Files rather than collapsing them.');
  // One folder: nothing to choose between, so files and the main conversation are both there.
  const project = state().projects.find(item => item.id === 'project-one');
  project.folders = [first]; state().sidebarLevels = {};
  ui.window.dispatchEvent(new UIEvent('relay-state')); await ui.window.relayUI.refresh(); await flush();
  assert.equal(ui.window.relayUI.sidebarLevel(), 'single');
  assert.equal(ui.$('task-list').querySelector('.task-row-main') !== null, true);
});

test('skills show as a list with switches, and Add skills opens everything found with what is unavailable said up front', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true, desktop: true });
  const compatibility = unavailable => ({ route: 'instructions', adapters: {}, unavailable, blocking: unavailable.some(item => item.blocking) });
  let view = { dirs: ['/my/skills'], enabled: [{ name: 'long-guide', description: 'A long description. '.repeat(8), version: 'abcdef1234', license: 'MIT', sourceKind: 'starter', sourceLabel: 'the starter set', sourcePath: '/s/long-guide', enabled: true, pinned: false, updateAvailable: false, sourceMissing: false, compatibility: compatibility([]) }, { name: 'tone-guide', description: 'Copy rules.', version: 'abcdef1234', license: 'MIT', sourceKind: 'folder', sourceLabel: '/my/skills', sourcePath: '/my/skills/tone-guide', enabled: true, pinned: false, updateAvailable: true, sourceMissing: false, compatibility: compatibility([]) }],
    available: [{ name: 'test-authoring', description: 'Write tests.', path: '/s/test-authoring', license: 'MIT', source: { kind: 'starter' }, compatibility: compatibility([]), problems: [] }, { name: 'fills-in', description: 'Uses arguments.', path: '/s/fills-in', source: { kind: 'folder', folder: '/my/skills' }, compatibility: compatibility([{ feature: 'substitutions', detail: 'Its placeholders stay as written.', blocking: true }]), problems: [] }, { name: 'Broken', path: '/s/broken', source: { kind: 'folder' }, problems: ['name must be lowercase'] }] };
  const posted = [];
  ui.setIntercept((request, next) => {
    if (request.path === '/api/skills') return response(view);
    if (request.path === '/api/memory') return response({ entries: [], suggestions: [] });
    if (request.path === '/api/conversation/brief') return response({ brief: null, metadata: {} });
    if (/\/skills$/.test(request.path)) { posted.push(request.body); return response(request.body.action === 'preview-update' ? { name: 'tone-guide', source: '/my/skills', diff: '-old\n+new' } : view); }
    return next();
  });
  await ui.window.relayUI.refresh(); ui.window.relayBrief.open(); await flush(); ui.window.dispatchEvent(new UIEvent('relay-state')); await flush();
  const row = () => ui.$('skills-list').children[1], named = (host, label) => host.querySelectorAll('button').find(item => item.textContent === label);
  assert.equal(ui.$('skills-count').textContent, '2');
  const long = ui.$('skills-list').children[0], more = long.querySelector('.panel-row-more');
  assert.equal(more.textContent, 'More');
  assert.equal(long.querySelector('.panel-row-text').classList.contains('expanded'), false);
  more.click();
  assert.equal(long.querySelector('.panel-row-text').classList.contains('expanded'), true, 'The full description opens in place.');
  assert.equal(more.textContent, 'Less');
  assert.equal(row().querySelector('.skill-name').textContent, '/tone-guide');
  assert.equal(row().querySelector('.panel-row-more'), null, 'A short description has nothing to open.');
  assert.equal(row().querySelector('.mini-switch').getAttribute('aria-checked'), 'true');
  assert.match(row().querySelector('.panel-row-meta').textContent, /Your folder · abcdef1 · MIT/);
  row().querySelector('.mini-switch').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'disable', name: 'tone-guide' });
  named(row(), 'Pin').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'pin', name: 'tone-guide' });
  named(row(), 'See update').click(); await flush();
  assert.equal(posted.at(-1).action, 'preview-update');
  assert.match(row().querySelector('.skill-diff').textContent, /-old[\s\S]*\+new/);
  named(row(), 'Use this version').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'update', path: '/my/skills/tone-guide', acceptPartial: true });
  ui.$('skills-add').click(); await flush();
  assert.equal(ui.$('skills-add-dialog').open, true);
  const groups = ui.$('skills-available').querySelectorAll('.panel-group-title').map(item => item.textContent);
  assert.deepEqual(groups, ['Starter set, from Codeshi', 'From your folders']);
  const rows = ui.$('skills-available').querySelectorAll('.panel-row'), [starter, partial, broken] = rows;
  assert.equal(named(starter, 'Enable').className, 'secondary-button', 'A real button, where a skill is chosen.');
  assert.equal(starter.querySelector('.panel-row-text').className, 'panel-row-text', 'The whole description shows there.');
  named(starter, 'Enable').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'enable', path: '/s/test-authoring' });
  assert.match(partial.textContent, /placeholders stay as written/);
  named(partial, 'Enable as instructions only').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'enable', path: '/s/fills-in', acceptPartial: true }, 'Only an explicit choice accepts what is missing.');
  assert.match(broken.textContent, /Can.t be used: name must be lowercase/);
  assert.equal(broken.querySelectorAll('button').length, 0);
  assert.equal(ui.$('skills-add-folder').hidden, false, 'On the desktop, a folder can be added.');
});

test('task limits show as bars on the current task, are set in a dialog, and a refused run offers to allow more', async () => {
  const ui = await browser({ insights: true, agentsUI: true, wide: true, setup: true }), { ledgerTask } = panelFixture();
  const limits = { maxWorkingMinutes: 30, maxTokens: 5000, maxSpendUSD: null, maxHandoffs: 4, maxRetries: 3, maxReviews: 5, maxRepeatedFailures: 5, maxConcurrent: 2 };
  let view = { policy: { ...limits, allowedProviders: null, allowedModels: null }, defaults: {}, quota: {}, task: { taskId: 't1', limits, runs: 2, retries: 0, reviews: 0, handoffs: 1, workingMs: 120000, tokens: 6200, cacheRead: 900, spendUSD: 0, runsWithoutUsage: 1, active: 0, stopped: null, failures: [{ what: 'npm test', count: 3, kind: 'command' }], exceeded: { limit: 'maxTokens', message: 'This task has used 6,200 tokens, over its limit of 5,000.' } } };
  const posted = [];
  ui.setIntercept((request, next) => {
    if (request.path === '/api/budget') return response(view);
    if (request.path === '/api/ledger') return response({ runs: [], quotaObservations: [], tasks: [ledgerTask] });
    if (/\/budget$/.test(request.path)) { posted.push(request.body); return response(view); }
    return next();
  });
  await ui.window.relayUI.refresh(); ui.window.relayTasks.open(); await flush(); ui.window.dispatchEvent(new UIEvent('relay-state')); await flush();
  const card = ui.$('task-card'), bars = card.querySelectorAll('.limit-row');
  assert.deepEqual(bars.map(row => row.querySelector('.limit-value').textContent), ['2 of 30 min', '6.2k of 5k', '1 of 4', '0 of 3']);
  assert.deepEqual(bars.map(row => row.className), ['limit-row', 'limit-row over', 'limit-row', 'limit-row']);
  assert.match(card.textContent, /1 run reported no tokens, so the total is lower than the real one/);
  assert.match(card.querySelector('.task-note').textContent, /Went wrong 3 of 5 times: npm test/);
  card.querySelector('.limits-reached').querySelector('button').click(); await flush();
  assert.deepEqual(posted.at(-1), { action: 'extend', taskId: 't1', limit: 'maxTokens' });
  ui.$('limits-open').click(); await flush();
  assert.equal(ui.$('limits-dialog').open, true);
  assert.equal(ui.$('limit-maxTokens').value, 5000);
  ui.$('limit-maxTokens').value = ''; ui.$('limit-agent-gemini').checked = false;
  ui.$('limits-form').dispatchEvent(new UIEvent('submit')); await flush();
  const saved = posted.at(-1);
  assert.equal(saved.action, 'policy');
  assert.equal(saved.policy.maxTokens, null, 'Empty means no limit.');
  assert.deepEqual([...saved.policy.allowedProviders].sort(), ['claude', 'codex', 'local']);
  assert.equal(ui.$('limits-dialog').open, false);
});

test('what Full auto-approval allowed for Codex shows in the run, and a block by Read only names the setting', async () => {
  const ui = await browser({ setup: true }), describe = ui.window.relayUI.describeActivity;
  const allowed = describe('Auto-approved: git push origin main');
  assert.equal(allowed.verb, 'Auto-approved');
  assert.equal(allowed.detail, 'git push origin main');
  assert.notEqual(allowed.skip, true);
  assert.equal(describe('Tool Bash auto-approved by policy.').skip, true, 'Agents that ask for every tool still show only the steps.');
  const blocked = describe('Blocked by Read only: switch to Can edit files to let Codex use the network or change files.');
  assert.equal(blocked.verb, 'Blocked by Read only');
  assert.match(blocked.detail, /^Switch to Can edit files/);
});

test('while the app quits or restarts, what stops answering is not shown as an error', async () => {
  const ui = await browser({ desktop: true });
  ui.window.relayUI.showNotice('Something earlier');
  assert.equal(ui.$('notice').hidden, false);
  const before = ui.requests.length;
  ui.quitting();
  assert.equal(ui.$('notice').hidden, true, 'A notice already showing goes too.');
  ui.window.relayUI.showNotice('Codeshi is stopping.');
  assert.equal(ui.$('notice').hidden, true);
  await ui.window.relayUI.refresh();
  assert.equal(ui.requests.length, before, 'It stops asking a server that is going away.');
});

test('a failed install from the last run is explained once at launch, and a clean launch says nothing', async () => {
  const state = { version: '0.14.0', supported: true, automatic: true, skipped: null, checkedAt: null, status: 'current', error: null, progress: null, blocked: null, latest: null };
  const failed = await browser({ desktop: true, update: { ...state, installFailed: true } });
  await flush();
  assert.equal(failed.$('notice').hidden, false);
  assert.match(failed.$('notice-text').textContent, /couldn’t be installed.*still on this version/);
  const clean = await browser({ desktop: true, update: { ...state, installFailed: false } });
  await flush();
  assert.equal(clean.$('notice').hidden, true);
});

test('an update redraws only what changed, so what stayed keeps its elements and what was opened', async () => {
  const ui = await browser({ setup: true });
  const chat = ui.canonical.get('project-one'), createdAt = '2026-11-01T10:00:00Z';
  chat.messages.push(
    { id: 'u1', runId: 'run-1', role: 'user', text: 'First task', createdAt },
    { id: 'a1', runId: 'run-1', role: 'assistant', provider: 'codex', text: 'First answer', createdAt },
    { id: 'u2', runId: 'run-2', role: 'user', text: 'Second task', createdAt },
    { id: 'act2', runId: 'run-2', role: 'activity', text: '$ npm test\n12 passed' },
    { id: 'a2', runId: 'run-2', role: 'assistant', provider: 'codex', text: 'Working', status: 'streaming', createdAt }
  );
  await ui.window.relayUI.refresh();
  const firstTurn = ui.$('message-u1').parentNode, firstAnswer = ui.$('message-a1'), prompt = ui.$('message-u2'), answer = ui.$('message-a2');
  const step = () => ui.document.querySelectorAll('.activity-entry')[0];
  const opened = step(); opened.querySelector('.activity-output-toggle').click();
  assert(opened.classList.contains('open'));

  // Nothing changed: the server's fresh copies of the same messages draw nothing.
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('message-a2'), answer, 'An unchanged reply keeps its element.');

  chat.messages.at(-1).text = 'Working on the tests';
  await ui.window.relayUI.refresh();
  assert.notEqual(ui.$('message-a2'), answer, 'The reply that changed is drawn again.');
  assert.match(ui.$('message-a2').textContent, /Working on the tests/);
  assert.equal(ui.$('message-a1'), firstAnswer, 'An earlier turn keeps its elements.');
  assert.equal(ui.$('message-u1').parentNode, firstTurn);
  assert.equal(ui.$('message-u2'), prompt, 'So does the prompt of the turn that changed.');
  assert.equal(step(), opened, 'So does a step that did not change.');
  assert(opened.classList.contains('open'), 'A step you opened stays open.');

  // A step that changed is drawn again, and stays open.
  chat.messages.find(message => message.id === 'act2').text = '$ npm test\n13 passed';
  await ui.window.relayUI.refresh();
  assert.notEqual(step(), opened);
  assert(step().classList.contains('open'), 'A changed step you opened stays open.');

  // The status line and follow-up actions move to the turn that is now the latest, and the earlier one lets them go.
  assert.equal(ui.$('transcript-footer').parentNode, prompt.parentNode);
  chat.messages.push({ id: 'u3', runId: 'run-3', role: 'user', text: 'Third task', createdAt });
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('transcript-footer').parentNode, ui.$('message-u3').parentNode);
  assert.equal(ui.$('message-u2'), prompt);
  assert.equal(ui.$('messages').querySelectorAll('.turn').length, 3);
});

test('an update asks only for what changed and merges it, and asks for everything when it cannot', async () => {
  const ui = await browser({ setup: true });
  const chat = ui.canonical.get('project-one'), createdAt = '2026-11-01T10:00:00Z';
  chat.messages.push({ id: 'u1', role: 'user', text: 'Task', createdAt }, { id: 'a1', role: 'assistant', provider: 'codex', text: 'Answer', createdAt });
  chat.cursor = 5;
  await ui.window.relayUI.refresh();
  const prompt = ui.$('message-u1'), state = ui.state();
  const kept = state.conversation.messages[0];
  let asked = [], reply = null;
  ui.setIntercept((request, next) => {
    if (request.path !== '/api/conversation') return next();
    asked.push(request.params.since);
    return request.params.since === undefined || !reply ? next() : response({ ...clone(chat), ...reply });
  });

  reply = { cursor: 6, messageCount: 2, messages: [{ id: 'a1', role: 'assistant', provider: 'codex', text: 'A better answer', createdAt }] };
  await ui.window.relayUI.refresh();
  assert.deepEqual(asked, ['5'], 'It asks for what changed since the copy it has.');
  assert.deepEqual(clone(ui.state().conversation.messages.map(message => message.text)), ['Task', 'A better answer']);
  assert.equal(ui.state().conversation.messages[0], kept, 'A message that did not change keeps its object.');
  assert.equal(ui.state().conversation.cursor, 6);
  assert.equal(ui.$('message-u1'), prompt);
  assert.match(ui.$('message-a1').textContent, /A better answer/);

  // A new message joins the end.
  asked = [];
  reply = { cursor: 7, messageCount: 3, messages: [{ id: 'a2', role: 'assistant', provider: 'codex', text: 'One more', createdAt }] };
  await ui.window.relayUI.refresh();
  assert.deepEqual(asked, ['6']);
  assert.deepEqual(clone(ui.state().conversation.messages.map(message => message.id)), ['u1', 'a1', 'a2']);

  // A count that does not add up means this copy is out of step, so it asks for everything.
  asked = []; chat.messages.push({ id: 'a3', role: 'assistant', provider: 'codex', text: 'Whole again', createdAt });
  reply = { cursor: 8, messageCount: 99, messages: [] };
  await ui.window.relayUI.refresh();
  assert.deepEqual(asked, ['7', undefined]);
  assert.deepEqual(clone(ui.state().conversation.messages.map(message => message.id)), ['u1', 'a1', 'a3']);
});

test('while the mouse moves, a small grip shows on each divider that can be dragged, and it fades when the mouse stops', async () => {
  const ui = await browser({ layoutUI: true }), handles = ui.document.querySelectorAll('.resize-handle');
  assert(handles.length > 0);
  assert.equal(handles.some(handle => handle.classList.contains('hinting')), false, 'Nothing shows until the mouse moves.');
  ui.document.dispatchEvent(new UIEvent('pointermove'));
  assert.equal(handles.every(handle => handle.classList.contains('hinting')), true);
  ui.document.dispatchEvent(new UIEvent('pointermove'));
  assert.equal(handles.every(handle => handle.classList.contains('hinting')), true, 'It stays while the mouse keeps moving.');
  ui.runTimers();
  assert.equal(handles.some(handle => handle.classList.contains('hinting')), false, 'It goes once the mouse stops.');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.resize-handle\.columns::after \{[^}]*\bwidth: 1px/, 'The divider itself stays a thin line.');
  assert.match(css, /\.resize-handle\.rows::after \{[^}]*\bheight: 1px/);
  assert.match(css, /\.resize-handle\.columns::before \{[^}]*\bwidth: 3px; height: 16px/, 'The grip is very small.');
});

test('a resize drag holds its cursor with one element, not a rule on every element, and skips turns out of view', async () => {
  const ui = await browser({ setup: true, layoutUI: true });
  const handle = ui.$('bottom-panel').querySelector('.resize-handle');
  assert(handle);
  handle.dispatchEvent(new UIEvent('pointerdown'));
  assert.equal(ui.document.querySelectorAll('.resize-shield').length, 1);
  assert(ui.document.querySelector('.resize-shield').classList.contains('rows'));
  handle.dispatchEvent(new UIEvent('pointerup'));
  assert.equal(ui.document.querySelectorAll('.resize-shield').length, 0);
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.resizing[^{}]*\*/, 'A rule on every element makes the browser recheck the whole page at the start and end of a drag.');
  assert.match(css, /\.turn \{[^}]*content-visibility: auto/);
});

test('resize overlays always release after lost capture, outside release, blur, Escape, hidden pages and a missed pointerup', async () => {
  const ui = await browser({ layoutUI: true }), handle = ui.document.querySelectorAll('.resize-handle').find(bar => bar.getAttribute('aria-label') === 'Resize the sidebar');
  const down = () => handle.dispatchEvent(new UIEvent('pointerdown', { pointerId: 7, button: 0, clientX: 100 }));
  const clear = () => { assert.equal(ui.document.querySelectorAll('.resize-shield').length, 0); assert.equal(handle.classList.contains('dragging'), false); };
  handle.setPointerCapture = () => { throw Error('Capture is unavailable.'); };
  down(); ui.window.dispatchEvent(new UIEvent('pointermove', { pointerId: 7, buttons: 1, clientX: 200 }));
  assert.equal(ui.document.documentElement.style['--sidebar-width'], '300px', 'A drag works through window events when capture fails.');
  ui.window.dispatchEvent(new UIEvent('pointerup', { pointerId: 7 })); clear();
  const exits = [
    () => handle.dispatchEvent(new UIEvent('lostpointercapture', { pointerId: 7 })),
    () => ui.window.dispatchEvent(new UIEvent('pointercancel', { pointerId: 7 })),
    () => ui.window.dispatchEvent(new UIEvent('blur')),
    () => ui.window.dispatchEvent(new UIEvent('pagehide')),
    () => ui.document.dispatchEvent(new UIEvent('keydown', { key: 'Escape' })),
    () => { ui.document.hidden = true; ui.document.dispatchEvent(new UIEvent('visibilitychange')); ui.document.hidden = false; },
    () => ui.window.dispatchEvent(new UIEvent('pointermove', { pointerId: 7, buttons: 0, clientX: 200 })),
    () => ui.window.relayLayout.toggleSidebar(),
  ];
  for (const exit of exits) { down(); assert.equal(ui.document.querySelectorAll('.resize-shield').length, 1); exit(); clear(); }
  handle.dispatchEvent(new UIEvent('pointerdown', { pointerId: 9, button: 2 })); clear();
});

test('Files opens explicitly, previews the selected file and reports failures inside its browser', async () => {
  const ui = await browser({ filesUI: true, agentsUI: true, layoutUI: true }), chat = ui.canonical.get('project-one');
  chat.status = 'running'; chat.activeRun = { id: 'working', provider: 'codex' };
  let fail = true;
  ui.setIntercept((request, next) => {
    if (request.path === '/api/files') return response({ entries: [{ kind: 'file', name: 'app.js', path: 'app.js' }], nextOffset: null });
    if (request.path === '/api/files/preview') return fail ? response({ error: 'The file could not be read.' }, 400) : response({ name: 'app.js', kind: 'text', mime: 'text/plain', bytes: 12, text: 'const x = 1;' });
    return next();
  });
  await ui.window.relayUI.refresh(); await flush();
  const main = () => ui.$('task-list').querySelector('.task-row-main');
  assert.equal(main().querySelector('.task-row-title').textContent, 'Workspace chat');
  assert.equal(main().dataset.status, 'running');
  assert(main().querySelector('.task-row-main-icon'));
  ui.$('toggle-explorer').click(); await flush();
  assert.equal(ui.$('files-dialog').open, true);
  ui.document.querySelectorAll('.tree-file')[0].click(); await flush();
  assert.equal(ui.$('files-dialog').open, true); assert.equal(ui.$('files-error').hidden, false);
  assert.equal(ui.$('files-error').textContent, 'The file could not be read.');
  fail = false; ui.document.querySelectorAll('.tree-file')[0].click(); await flush();
  assert.equal(ui.$('files-dialog').open, false); assert.equal(ui.$('file-preview').hidden, false);
  assert.match(ui.$('file-preview-content').textContent, /const x = 1/);
  assert.equal(main().dataset.status, 'running');
  ui.$('close-file-preview').click(); assert.equal(ui.$('file-preview').hidden, true);
  assert.equal(ui.$('toggle-explorer').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.document.querySelectorAll('.resize-shield').length, 0);
});

test('while a handoff is switching the button says so, and scrolled up, the way back says an offer is waiting', async () => {
  const ui = await browser(), conversation = ui.canonical.get('project-one');
  let answer; const held = new Promise(resolve => { answer = resolve; });
  ui.setIntercept((request, next) => request.path.endsWith('/handoff') ? held : next());
  const scroll = ui.$('messages-scroll'); scroll.clientHeight = 500; scroll.scrollHeight = 5000; scroll.scrollTop = 0;
  conversation.status = 'running'; conversation.activeRun = { id: 'run-one', provider: 'codex' };
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('jump-latest-text').textContent, 'Jump to latest');
  conversation.handoffOffer = { id: 'first', runId: 'run-one', from: { provider: 'codex', usedPercent: 92, window: '5-hour' }, to: { provider: 'claude', model: null, mode: 'edit', approvalPolicy: 'ask', billingSource: 'subscription', usedPercent: 20 }, task: 'Add a promo code field to checkout, then run this exact command…' };
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('jump-latest').hidden, false);
  assert.equal(ui.$('jump-latest-text').textContent, 'Handoff offer below');
  assert.equal(ui.$('handoff-accept').textContent, 'Hand off');
  assert.match(ui.$('handoff-detail').textContent, /run this exact command…”/, 'A cut task still shows that it was cut.');
  ui.$('handoff-accept').click(); await flush();
  assert.equal(ui.$('handoff-accept').textContent, 'Handing off…');
  assert.equal(ui.$('handoff-accept').disabled, true);
  assert.equal(ui.$('handoff-dismiss').disabled, true);
  conversation.handoffOffer = null; answer(response({ runId: 'run-two' }, 202)); await flush(); await flush();
  assert.equal(ui.$('handoff-offer').hidden, true);
  assert.equal(ui.$('jump-latest-text').textContent, 'Jump to latest');
});

test('the first run stopped by a limit offers to handle the next ones without asking, once, and only where it would apply', async () => {
  const stop = (conversation, id, provider = 'codex') => { conversation.status = 'incomplete'; conversation.provider = provider; conversation.lastRun = { id, provider, status: 'incomplete', errorCategory: 'quota' }; };
  const ui = await browser(), conversation = ui.canonical.get('project-one'), saved = () => ui.requests.filter(request => request.path === '/api/handoff-preferences' && request.method === 'POST').map(request => request.body);
  await ui.$('message-input'); stop(conversation, 'run-one'); await ui.window.relayUI.refresh(); await flush(); await flush();
  assert.equal(ui.$('limit-always').hidden, false, 'Offered the first time.');
  assert.equal(ui.$('continuation').hidden, false);
  assert.deepEqual(saved(), [{ limitAsked: true }], 'Being offered is remembered.');
  const sent = ui.requests.length;
  ui.$('limit-always').click(); await flush(); await flush(); await flush();
  assert.deepEqual(saved().at(-1), { automatic: true, limitAsked: true });
  assert(ui.requests.slice(sent).some(request => /\/continue/.test(request.path)), 'It continues this time as well.');

  // Offered once: a later stop doesn't ask again, whichever way it was answered.
  const later = await browser(), again = later.canonical.get('project-one');
  later.setIntercept((request, next) => request.path === '/api/handoff-preferences' ? response({ threshold: 90, automatic: false, limitAsked: true }) : next());
  stop(again, 'run-two'); await later.window.relayUI.refresh(); await flush(); await flush();
  assert.equal(later.$('limit-always').hidden, true);

  // Not with automatic handoff on or offers off, and not when the agent it would go to isn't on a subscription.
  for (const preferences of [{ threshold: 90, automatic: true, limitAsked: true }, { threshold: 0, automatic: false, limitAsked: false }]) {
    const other = await browser(), row = other.canonical.get('project-one');
    other.setIntercept((request, next) => request.path === '/api/handoff-preferences' ? response(preferences) : next());
    stop(row, 'run-three'); await other.window.relayUI.refresh(); await flush(); await flush();
    assert.equal(other.$('limit-always').hidden, true);
  }
  const api = await browser({ billingSource: 'api' }), row = api.canonical.get('project-one');
  stop(row, 'run-four'); await api.window.relayUI.refresh(); await flush(); await flush();
  assert.equal(api.$('limit-always').hidden, true);
});

test('while a limit is being handed off, the page says so instead of offering choices it may not need', async () => {
  const ui = await browser(), conversation = ui.canonical.get('project-one');
  conversation.status = 'incomplete'; conversation.lastRun = { id: 'run-one', provider: 'codex', status: 'incomplete', errorCategory: 'quota' }; conversation.limitSwitching = { provider: 'codex' };
  await ui.window.relayUI.refresh(); await flush();
  assert.equal(ui.$('continuation').hidden, true);
  assert.equal(ui.$('limit-always').hidden, true);
  assert.equal(ui.$('resume-waiting').hidden, false);
  assert.equal(ui.$('resume-waiting-text').textContent, 'Codex reached its usage limit. Finding an agent with room…');
  assert.equal(ui.$('resume-cancel').hidden, true, 'There is nothing to cancel yet.');
  conversation.limitSwitching = null; await ui.window.relayUI.refresh(); await flush();
  assert.equal(ui.$('resume-waiting').hidden, true);
  assert.equal(ui.$('continuation').hidden, false, 'If nothing could take over, the usual choices come back.');
  assert.equal(ui.$('resume-cancel').hidden, false);
});

test('jump to latest goes straight there from far away, and scrolls smoothly from nearby', async () => {
  const ui = await browser({ setup: true });
  const scroll = ui.$('messages-scroll'), smooth = [];
  scroll.scrollTo = options => smooth.push(options);
  scroll.clientHeight = 500; scroll.scrollHeight = 100000; scroll.scrollTop = 0;
  ui.$('jump-latest').click();
  assert.equal(scroll.scrollTop, 100000, 'Passing every turn on the way would draw them all and move the end further away.');
  assert.equal(smooth.length, 0);
  scroll.scrollHeight = 1000; scroll.scrollTop = 200;
  ui.$('jump-latest').click();
  assert.equal(smooth.length, 1);
  assert.equal(scroll.scrollTop, 200);
});

test('user prompts read as bubbles distinct from labelled agent replies and stay pinned above the turn they started', async () => {
  const ui = await browser({ setup: true });
  const chat = ui.canonical.get('project-one');
  chat.messages.push(
    { id: 'u1', runId: 'run-1', role: 'user', text: 'Please refactor tests and check coverage', createdAt: '2026-11-01T10:00:00Z' },
    { id: 'act1', runId: 'run-1', role: 'activity', text: '$ npm test\n12 passed' },
    { id: 'a1', runId: 'run-1', role: 'assistant', provider: 'codex', model: 'gpt-4o', text: 'I updated the test files.', createdAt: '2026-11-01T10:01:00Z' }
  );
  await ui.window.relayUI.refresh();

  const userMsg = ui.$('message-u1');
  assert(userMsg);
  assert(userMsg.classList.contains('message-user'));
  assert.equal(userMsg.dataset.runId, 'run-1');
  assert.equal(userMsg.getAttribute('aria-label'), 'Your message');
  assert.equal(userMsg.querySelector('.message-author'), null, 'A prompt bubble does not repeat a "You" heading.');

  // Jump to run navigation button on user prompt
  const jumpRun = userMsg.querySelector('.message-jump-run');
  assert(jumpRun);
  assert.match(jumpRun.textContent, /Activity/);

  // Assistant response
  const assistantMsg = ui.$('message-a1');
  assert(assistantMsg);
  assert(assistantMsg.classList.contains('message-assistant'));
  assert.equal(assistantMsg.getAttribute('aria-label'), 'Codex response');
  assert.equal(assistantMsg.querySelector('.message-author').textContent, 'Codex');
  assert.match(assistantMsg.querySelector('.message-model').textContent, /gpt-4o/);

  // The prompt and everything that answers it form one turn, so the prompt stays pinned above its results.
  const turn = userMsg.parentNode;
  assert(turn.classList.contains('turn'));
  // The run is one thread in the turn, headed once by the agent, with its steps and replies in order on its line.
  const thread = assistantMsg.parentNode.parentNode;
  assert(thread.classList.contains('run-thread'));
  assert.equal(thread.parentNode, turn);
  assert.equal(thread.dataset.runId, 'run-1');
  assert.equal(thread.querySelector('.run-thread-heading').querySelector('.message-author').textContent, 'Codex');
  assert.match(thread.querySelector('.run-thread-heading').querySelector('.message-model').textContent, /gpt-4o/, 'The heading names the model even when a step comes before the first reply.');
  const step = ui.document.querySelector('.activity-entry');
  assert.deepEqual(assistantMsg.parentNode.children.map(child => child.className.split(' ')[0]), ['activity-entry', 'message']);
  assert.equal(step.querySelector('.activity-entry-title').textContent, 'Run');
  assert.equal(ui.$('transcript-footer').parentNode === turn, true, 'Follow-up actions belong to the latest turn.');
  assert.equal(assistantMsg.querySelector('.message-jump-prompt'), null);
});

test('each step shows its target on the run’s timeline, with file changes separated and full output behind a chevron', async () => {
  const ui = await browser();
  const chat = ui.canonical.get('project-one');
  chat.messages.push(
    { id: 'u1', runId: 'run-42', role: 'user', text: 'Build project' },
    { id: 't1', runId: 'run-42', role: 'activity', text: 'File changes: [{"path":"src/index.js","kind":"modify"},{"path":"src/utils.js","kind":"add"}]' },
    { id: 't2', runId: 'run-42', role: 'activity', text: '$ npm run build\nBundled 2 modules in 42ms' },
    { id: 't3', runId: 'run-42', role: 'activity', text: 'Tool Bash auto-approved by policy.' },
    { id: 't4', runId: 'run-42', role: 'activity', text: 'Bash\n{"command":"npm test","description":"Run the unit tests"}\n12 passed' },
    { id: 't5', runId: 'run-42', role: 'activity', text: 'Edit\n{"file_path":"src/a.js","old_string":"let a = 1;","new_string":"const a = 1;"}\nThe file was updated.' },
    { id: 't6', runId: 'run-42', role: 'activity', text: 'Approval denied by the user.' }
  );
  await ui.window.relayUI.refresh();

  // Every step shows without opening anything; notes from full auto-approval add nothing and are left out.
  const entries = ui.document.querySelectorAll('.activity-entry');
  const target = entry => entry.querySelectorAll('.activity-file-row').map(row => row.querySelector('.activity-file').textContent + (row.querySelector('.activity-file-counts')?.textContent || '')).join(', ') || entry.querySelector('.activity-entry-detail')?.textContent || '';
  assert.deepEqual(entries.map(entry => [entry.querySelector('.activity-entry-title').textContent, target(entry)]), [
    ['Edit', 'src/index.js, src/utils.js'], ['Run', 'npm run build'], ['Run', 'Run the unit tests'], ['Edit', 'src/a.js+1−1'], ['You denied the request', '']
  ]);
  assert.equal(ui.document.querySelector('.activity-group'), null, 'Steps are not folded into a summary.');
  assert(entries.every(entry => entry.querySelector('.timeline-node')), 'Each step has a node on the run’s line.');
  assert(entries[4].classList.contains('activity-entry-error'));

  // The full text opens under its step, and copying takes all of it.
  const command = entries[1], toggle = command.querySelector('.activity-output-toggle'), output = command.querySelector('.activity-output');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(output.hidden, true);
  toggle.click();
  assert.equal(output.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(output.textContent, '$ npm run build\nBundled 2 modules in 42ms');
  assert.equal(entries[2].querySelector('.activity-output').textContent, '$ npm test\n12 passed', 'Claude’s command shows its description first, and the command with its result inside.');
  assert.equal(entries[3].querySelector('.activity-output').textContent, '- let a = 1;\n+ const a = 1;', 'An edit opens to what it changed.');
  const copy = command.querySelector('.activity-copy');
  copy.click();
  await flush();
  assert(copy.classList.contains('copied'));
  assert.equal(entries[4].querySelector('.activity-output'), null, 'A step with nothing more to show has no chevron.');
});

test('a very long stretch of steps keeps its earlier steps behind one row', async () => {
  const ui = await browser();
  const chat = ui.canonical.get('project-one');
  chat.messages.push({ id: 'u1', runId: 'run-long', role: 'user', text: 'Read everything' });
  for (let index = 0; index < 15; index++) chat.messages.push({ id: 'r' + index, runId: 'run-long', role: 'activity', text: `Read\n{"file_path":"src/file-${index}.js"}` });
  await ui.window.relayUI.refresh();
  const earlier = ui.document.querySelector('.activity-earlier');
  assert(earlier);
  assert.equal(earlier.open, false);
  assert.equal(earlier.querySelectorAll('.activity-entry').length, 9);
  assert.equal(ui.document.querySelectorAll('.activity-entry').length, 15);
  assert.match(earlier.querySelector('summary').textContent, /9 earlier steps/);
});

test('activity expansion and reading scroll position are preserved across rerenders', async () => {
  const ui = await browser();
  const chat = ui.canonical.get('project-one');
  chat.messages.push(
    { id: 'u1', runId: 'run-exp', role: 'user', text: 'Run multiple tests' },
    { id: 't1', runId: 'run-exp', role: 'activity', text: '$ npm test\nPass 1' }
  );
  await ui.window.relayUI.refresh();

  const toggle = ui.document.querySelector('.activity-output-toggle');
  toggle.click();
  assert.equal(ui.document.querySelector('.activity-output').hidden, false);

  // New message arrives and refresh triggers
  chat.messages.push({ id: 't2', runId: 'run-exp', role: 'activity', text: '$ npm test\nPass 2' });
  await ui.window.relayUI.refresh();

  // The opened output stays open across the rerender
  const refreshedPre = ui.document.querySelector('pre[data-entry-id="t1"]');
  assert(refreshedPre);
  assert.equal(refreshedPre.hidden, false);
});

test('the run’s status line is the last step of its thread, says what the agent is doing in a word, and opens to token counts', async () => {
  const ui = await browser({ insights: true });
  const c = ui.canonical.get('project-one');
  c.status = 'running';
  c.activeRun = {
    provider: 'codex',
    phase: 'tool',
    startedAt: new Date(Date.now() - 65000).toISOString(),
    lastEventAt: new Date().toISOString(),
    effectiveModel: 'gpt-4o',
    effort: 'high',
    approvalPolicy: 'auto',
    toolCount: 3,
    usage: { total: { inputTokens: 5200, outputTokens: 850, used: 12400, size: 128000 } }
  };
  c.messages.push({ id: 'u1', runId: 'run-meta', role: 'user', text: 'Refactor core modules' });
  await ui.window.relayUI.refresh();

  // Before any reply, the live run already has its thread, headed by the agent, model and effort.
  const thread = ui.$('run-progress').parentNode.parentNode;
  assert(thread.classList.contains('run-thread'));
  assert.match(thread.querySelector('.run-thread-heading').textContent, /Codex.*gpt-4o · high effort/);
  assert.equal(ui.$('run-phase').textContent, 'Running tools');
  assert.equal(ui.$('run-action').textContent, 'Working', 'The steps say what was run; the live line says what is happening.');
  assert.equal(ui.$('run-detail').textContent, '');
  assert.equal(ui.$('run-meta-summary'), null, 'The agent, model, permission setting and step count are not repeated under the line.');

  // Context window tokens distinct from allowance
  const metrics = ui.$('run-metrics');
  assert.match(metrics.textContent, /5,200 input tokens/);
  assert.match(metrics.textContent, /850 output tokens/);
  assert.match(metrics.textContent, /12,400 \/ 128,000 context tokens/);
  assert.equal(ui.$('run-details-disclosure').classList.contains('empty'), false);

  // A finished run ends its thread with how long it took.
  c.status = 'complete'; c.lastRun = { ...c.activeRun, id: 'run-meta', status: 'complete', endedAt: new Date().toISOString(), usage: null }; c.activeRun = null;
  c.messages.push({ id: 'a1', runId: 'run-meta', role: 'assistant', provider: 'codex', text: 'Done.' });
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-progress').parentNode, ui.$('message-a1').parentNode);
  assert.match(ui.$('run-action').textContent, /^Completed in 1m/);
  assert.equal(ui.$('run-details-disclosure').classList.contains('empty'), true, 'With nothing to show, the line does not open.');
});


test('run details expose fresh versus resumed context and actual handoff omissions', async()=>{
  const ui=await browser({insights:true}), chat=ui.canonical.get('project-one');
  chat.status='running';chat.activeRun={id:'handoff-fixture',provider:'claude',phase:'starting',startedAt:new Date().toISOString(),context:{sessionMode:'fresh',sessionReason:'cross-agent-handoff',includedMessages:20,omittedMessages:480,shortenedMessages:9,compactedActivityMessages:8}};
  await ui.window.relayUI.refresh();
  assert.match(ui.$('run-metrics').textContent,/Fresh session · shared history/);assert.match(ui.$('run-metrics').textContent,/Cross-agent handoff/);
  assert.match(ui.$('run-metrics').textContent,/20 history messages included · 480 omitted/);assert.match(ui.$('run-metrics').textContent,/8 tool logs compacted/);
  chat.activeRun.context={sessionMode:'resumed',sessionReason:'same-agent-continuation',includedMessages:0,omittedMessages:0};await ui.window.relayUI.refresh();
  assert.match(ui.$('run-metrics').textContent,/Resumed native session/);assert.doesNotMatch(ui.$('run-metrics').textContent,/Cross-agent handoff|tool logs compacted/);
});

test('after a usage limit the task can wait for a reset without raising access, shows the wait and can cancel it', async () => {
  const ui = await browser(), conversation = ui.canonical.get('project-one');
  const response = (body, status = 200) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
  ui.setIntercept((request, next) => {
    if (!request.path.endsWith('/resume')) return next();
    if (request.body.cancel) { conversation.resume = null; return response(conversation); }
    conversation.resume = { id: 'wait-one', providers: request.body.providers, mode: request.body.mode, approvalPolicy: request.body.approvalPolicy, agents: { codex: { limited: true, resetsAt: '2026-11-02T22:23:00.000Z' }, claude: { limited: true, resetsAt: null } } };
    return response(conversation);
  });
  conversation.status = 'incomplete'; conversation.lastRun = { provider: 'codex', errorCategory: 'quota' };
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('resume-button').hidden, false); assert.equal(ui.$('resume-waiting').hidden, true);

  // With full auto-approval on, the person chooses whether it applies while they are away.
  ui.state().approvalPolicy = 'auto'; ui.state().mode = 'edit';
  ui.$('resume-button').click(); await flush();
  assert.equal(ui.$('resume-choice').hidden, false); assert.equal(ui.$('resume-button').hidden, true);
  assert.equal(ui.requests.filter(request => request.path.endsWith('/resume')).length, 0, 'Nothing is scheduled before the choice.');
  ui.$('resume-ask').click(); await flush();
  const scheduled = ui.requests.filter(request => request.path.endsWith('/resume'));
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].body.approvalPolicy, 'ask'); assert.equal(scheduled[0].body.mode, 'edit');
  assert.equal(scheduled[0].body.providers[0], 'codex', 'The agent that stopped is tried first.');

  assert.equal(ui.$('resume-waiting').hidden, false); assert.equal(ui.$('continuation').hidden, true);
  assert.match(ui.$('resume-waiting-text').textContent, /Codex \(resets .+\)/); assert.match(ui.$('resume-waiting-text').textContent, /checking every 10 min/);
  assert.match(ui.$('resume-waiting-text').textContent, /asks before changes/);
  assert.equal(ui.$('conversation-state').textContent, 'Waiting for reset');

  ui.$('resume-cancel').click(); await flush();
  assert.equal(ui.requests.filter(request => request.path.endsWith('/resume')).at(-1).body.cancel, true);
  assert.equal(ui.$('resume-waiting').hidden, true); assert.equal(ui.$('continuation').hidden, false);
});

test('after a usage limit any agent and model can continue the task, including the one that stopped', async () => {
  const ui = await browser({ insights: true, modelPickerUI: true }), conversation = ui.canonical.get('project-one');
  conversation.status = 'incomplete'; conversation.lastRun = { provider: 'codex', errorCategory: 'quota' };
  await ui.window.relayUI.refresh(); await flush();
  assert.match(ui.$('continue-button').textContent, /^Continue with Claude/, 'The suggestion avoids the agent that stopped.');
  assert.equal(ui.$('continue-choose').disabled, false);

  ui.$('continue-choose').click(); await flush();
  assert.equal(ui.$('picker-title').hidden, false); assert.equal(ui.$('picker-title').textContent, 'Continue with…');
  assert(!ui.$('picker-models').querySelectorAll('.picker-section').some(section => section.textContent.includes('Local')), 'Local models keep their own Continue locally flow.');
  const sections = ui.$('picker-models').querySelectorAll('.picker-section').map(section => section.textContent);
  assert.match(sections[0], /Claude/, 'The suggested agent is listed first.');

  // Choosing Codex and a specific model continues with exactly that, even though Codex reached the limit.
  const codexHeader = ui.$('picker-models').querySelectorAll('.picker-section').find(section => section.textContent.includes('Codex'));
  const children = ui.$('picker-models').children, start = children.indexOf(codexHeader), next = children.findIndex((child, index) => index > start && child.classList.contains('picker-section'));
  const choice = children.slice(start + 1, next < 0 ? undefined : next).find(child => child.textContent.includes('Model One'));
  assert(choice, 'Codex lists its models in its own section.'); choice.click(); await flush(); await flush();
  const continued = ui.requests.filter(request => request.path.endsWith('/continue'));
  assert.equal(continued.length, 1); assert.equal(continued[0].body.provider, 'codex'); assert.equal(continued[0].body.model, 'model-one');
});

test('an approval with an exact scope can be allowed for the run or remembered for the workspace, and remembered approvals can be revoked',async()=>{
  const ui=await browser({workbench:true}),conversation=ui.canonical.get('project-one'),answers=[],permissionRequests=[];
  let rules=[{id:'rule-one',provider:'codex',kind:'command',label:'npm test',uses:3}];
  ui.setIntercept((request,next)=>{
    if(request.path.endsWith('/approval')){answers.push(request.body);conversation.pendingApprovals=[];return response({resolved:true});}
    if(request.path==='/api/permissions'){permissionRequests.push(request);if(request.body?.revoke)rules=rules.filter(rule=>rule.id!==request.body.revoke);return response({rules});}
    return next();
  });
  conversation.status='running';conversation.activeRun={id:'run-one',provider:'codex'};
  conversation.pendingApprovals=[{id:'scoped',runId:'run-one',provider:'codex',kind:'command',command:'npm test',scope:{kind:'command',label:'npm test',key:'k'}},{id:'plain',runId:'run-one',provider:'codex',kind:'fileChange'}];
  await ui.window.relayUI.refresh();
  const cards=ui.$('pending-approvals').querySelectorAll('article');
  assert(cards[0].querySelector('.approval-more'),'An action with an exact scope offers more ways to allow it.');
  assert.equal(cards[1].querySelector('.approval-more'),null,'An action without one can only be allowed once.');
  const menu=cards[0].querySelector('.approval-scope-menu');assert.equal(menu.hidden,true);
  cards[0].querySelector('.approval-more').click();assert.equal(menu.hidden,false);
  const options=menu.querySelectorAll('button');assert.match(options[0].textContent,/Allow for this run.*npm test/);assert.match(options[1].textContent,/Always allow in this workspace.*npm test/);
  options[1].click();await flush();
  assert.deepEqual(answers,[{runId:'run-one',approvalId:'scoped',allow:true,remember:'workspace'}]);

  ui.window.relayUI.commands['workspace-settings']();await flush();
  const listed=ui.$('workspace-permission-list').querySelectorAll('li');assert.equal(listed.length,1);assert.match(listed[0].textContent,/npm test/);assert.match(listed[0].textContent,/used 3 times/);
  assert.equal(ui.$('workspace-permissions-empty').hidden,true);
  listed[0].querySelector('button').click();await flush();
  assert.deepEqual(permissionRequests.at(-1).body,{revoke:'rule-one'});
  assert.deepEqual(permissionRequests.map(request=>request.projectId),['project-one','project-one'],'Rules are read and revoked for that workspace.');
  assert.equal(ui.$('workspace-permission-list').querySelectorAll('li').length,0);assert.equal(ui.$('workspace-permissions-empty').hidden,false);
});

test('a workspace waiting for approval shows its count in the sidebar, and opening the alert focuses that exact request',async()=>{
  const ui=await browser({workbench:true,moreProjects:true});
  ui.projects[1].pendingApprovals=2;await ui.window.relayUI.refreshProjects();await flush();
  const row=()=>ui.document.querySelectorAll('.workspace-item').find(item=>item.dataset.projectId==='project-two');
  assert.equal(row().querySelector('.workspace-approval-badge').textContent,'2');assert.match(row().textContent,/2 waiting for approval/);
  const other=ui.canonical.get('project-two');other.status='running';other.activeRun={id:'run-two',provider:'claude'};
  other.pendingApprovals=[{id:'first',runId:'run-two',provider:'claude',kind:'Bash',command:'npm install'},{id:'second',runId:'run-two',provider:'claude',kind:'Bash',command:'npm publish'}];
  const answered=()=>ui.requests.filter(request=>request.path.endsWith('/approval')).length;
  assert.equal(await ui.window.relayUI.commands['open-approval']({projectId:'project-two',approvalId:'second'}),true);await flush();
  assert.equal(ui.state().projectId,'project-two');
  const focused=ui.document.activeElement;assert.equal(focused?.dataset?.approvalId,'second','The exact request is focused.');
  assert.equal(answered(),0,'Opening an alert never answers it.');
  assert.equal(await ui.window.relayUI.commands['open-approval']({projectId:'missing'}),false);
});

test('while work runs, a message joins the queue with the current settings, and the queue can be reordered, edited, removed and resumed',async()=>{
  const ui=await browser(),conversation=ui.canonical.get('project-one'),actions=[];
  ui.setIntercept((request,next)=>{
    if(!request.path.endsWith('/queue'))return next();
    const body=request.body;actions.push(body);
    if(body.action==='add')conversation.queue=[...(conversation.queue||[]),{id:'q'+(conversation.queue||[]).length,text:body.text,provider:body.provider,model:body.model,mode:body.mode,approvalPolicy:body.approvalPolicy,attachments:[]}];
    if(body.action==='remove')conversation.queue=conversation.queue.filter(item=>item.id!==body.id);
    if(body.action==='resume')conversation.queuePaused=null;
    return response(conversation);
  });
  conversation.status='running';conversation.activeRun={id:'run-one',provider:'codex'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('queue-button').hidden,false);assert.equal(ui.$('send-button').hidden,true);assert.match(ui.$('message-input').placeholder,/queue/);
  ui.$('message-input').value='Then update the changelog';ui.fire('message-input','input');
  ui.$('message-input').dispatchEvent(new UIEvent('keydown',{key:'Enter'}));await flush();await flush();
  assert.equal(actions[0].action,'add');assert.equal(actions[0].text,'Then update the changelog');assert.equal(actions[0].provider,'codex');assert.equal(actions[0].mode,ui.state().mode);
  assert.equal(ui.$('message-input').value,'','The message box clears once the prompt is queued.');
  assert.equal(ui.requests.filter(request=>request.path.endsWith('/messages')).length,0,'Nothing is sent while the run works.');
  conversation.queue.push({id:'q1',text:'And run the tests',provider:'claude',mode:'read',approvalPolicy:'ask',attachments:[]});await ui.window.relayUI.refresh();
  assert.equal(ui.$('prompt-queue').hidden,false);assert.match(ui.$('prompt-queue-title').textContent,/Up next · 2/);
  const items=ui.$('prompt-queue-list').querySelectorAll('li');assert.equal(items.length,2);assert.match(items[1].textContent,/Claude · Read only · asks before changes/);
  assert.equal(items[0].querySelector('.queue-up').disabled,true,'The first prompt cannot move up.');
  items[1].querySelector('.queue-up').click();await flush();assert.deepEqual(actions.at(-1),{action:'move',id:'q1',index:0});
  ui.$('prompt-queue-list').querySelectorAll('li')[0].querySelector('.queue-edit').click();
  const editor=ui.$('prompt-queue-list').querySelector('textarea');editor.value='Then update the changelog for 0.14';
  ui.$('prompt-queue-list').querySelectorAll('button').find(button=>button.textContent==='Save').click();await flush();
  assert.deepEqual(actions.at(-1),{action:'update',id:'q0',text:'Then update the changelog for 0.14'});
  ui.$('prompt-queue-list').querySelectorAll('li')[1].querySelector('.queue-remove').click();await flush();assert.equal(actions.at(-1).action,'remove');
  conversation.queuePaused={reason:'You stopped the run.'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('prompt-queue-paused').hidden,false);assert.match(ui.$('prompt-queue-paused').textContent,/You stopped the run/);assert.equal(ui.$('prompt-queue-toggle').textContent,'Resume queue');
  ui.$('prompt-queue-toggle').click();await flush();assert.deepEqual(actions.at(-1),{action:'resume'});
});

test('a handoff offer names the destination, its billing and the task, needs charges confirmed separately, and a stale answer shows the fresh offer',async()=>{
  const ui=await browser(),conversation=ui.canonical.get('project-one'),answers=[];
  const offer=(id,billingSource='subscription')=>({id,runId:'run-one',from:{provider:'codex',usedPercent:91.6,window:'5-hour'},to:{provider:'claude',model:null,mode:'edit',approvalPolicy:'ask',billingSource,usedPercent:20},task:'Build the feature'});
  ui.setIntercept((request,next)=>{
    if(!request.path.endsWith('/handoff'))return next();
    answers.push(request.body);
    if(request.body.offerId==='first'){conversation.handoffOffer=offer('second','api');return response({error:'The task changed since this offer was made. Review the updated offer before switching.',offer:conversation.handoffOffer,billingRequired:false},409);}
    conversation.handoffOffer=null;return response({runId:'run-two'},202);
  });
  conversation.status='running';conversation.activeRun={id:'run-one',provider:'codex'};conversation.handoffOffer=offer('first');await ui.window.relayUI.refresh();
  assert.equal(ui.$('handoff-offer').hidden,false);
  assert.equal(ui.$('handoff-title').textContent,'Codex has used 92% of its 5-hour limit.');
  assert.match(ui.$('handoff-detail').textContent,/Hand off to Claude \(subscription\) to continue “Build the feature”\. Can edit files · asks before changes\./);
  assert.equal(ui.$('handoff-billing').hidden,true,'A subscription destination has no charges to confirm.');
  ui.$('handoff-accept').click();await flush();await flush();
  assert.deepEqual(answers[0],{offerId:'first',accept:true,billingConfirmed:false,queueBillingConfirmed:false,queueDigest:null});
  assert.equal(ui.$('notice').hidden,false,'A stale offer says why it was refused.');
  assert.match(ui.$('handoff-detail').textContent,/API billing/,'The fresh offer replaces the stale one.');
  assert.equal(ui.$('handoff-billing').hidden,false);assert.match(ui.$('handoff-billing-text').textContent,/Accept charges: Claude bills your API account/);
  assert.equal(ui.$('handoff-accept').disabled,true,'API billing needs its own confirmation first.');
  ui.$('handoff-billing-confirm').checked=true;ui.fire('handoff-billing-confirm','change');assert.equal(ui.$('handoff-accept').disabled,false);
  ui.$('handoff-accept').click();await flush();await flush();
  assert.deepEqual(answers[1],{offerId:'second',accept:true,billingConfirmed:true,queueBillingConfirmed:false,queueDigest:null});
  assert.equal(ui.$('handoff-offer').hidden,true);
  conversation.handoffOffer=offer('third');await ui.window.relayUI.refresh();
  ui.$('handoff-dismiss').click();await flush();
  assert.deepEqual(answers[2],{offerId:'third',accept:false,billingConfirmed:false,queueBillingConfirmed:false,queueDigest:null});
  conversation.status='idle';conversation.activeRun=null;conversation.handoffOffer=offer('fourth');await ui.window.relayUI.refresh();
  assert.equal(ui.$('handoff-offer').hidden,true,'An offer shows only while its run works.');
});

test('a check with the tests shows on its run’s timeline, a retry reads as Codeshi’s, and an offered retry can be accepted or declined',async()=>{
  const ui=await browser(),conversation=ui.canonical.get('project-one'),answers=[];
  ui.setIntercept((request,next)=>{if(!request.path.endsWith('/retry'))return next();answers.push(request.body);conversation.retryOffer=null;return response(request.body.accept?{runId:'retry-run'}:conversation,request.body.accept?202:200);});
  const at=new Date().toISOString();
  conversation.messages=[
    {id:'p1',role:'user',text:'Add promo codes',provider:'codex',runId:'r1',createdAt:at},
    {id:'a1',role:'assistant',text:'Done.',provider:'codex',runId:'r1',status:'complete',createdAt:at},
    {id:'t1',role:'activity',text:'Tests running: npm test',provider:'codex',runId:'r1',status:'running',createdAt:at},
  ];
  conversation.status='complete';conversation.lastRun={id:'r1',provider:'codex',status:'complete'};await ui.window.relayUI.refresh();
  let row=ui.$('messages').querySelector('.activity-entry-check');
  assert.equal(row.querySelector('.activity-entry-title').textContent,'Running the tests');assert.equal(row.querySelector('.activity-entry-detail').textContent,'npm test');
  assert(row.querySelector('.icon-tests-running'),'A running check shows as working.');
  conversation.messages[2]={...conversation.messages[2],text:'Tests failed: npm test\nExit code 1 after 4s.\n\nExpected 90, received 100',status:'complete'};
  conversation.messages.push({id:'p2',role:'user',text:'The project\'s tests failed after your changes.\n\nEnd of the output:\n```\nExpected 90, received 100\n```',provider:'codex',runId:'r2',retry:{of:'r1'},routing:{mode:'balanced',reason:'The tests failed, so one step up',model:'model-two',effort:'high'},createdAt:at});
  await ui.window.relayUI.refresh();
  row=ui.$('messages').querySelector('.activity-entry-check');
  assert.equal(row.querySelector('.activity-entry-title').textContent,'Tests failed');assert(row.classList.contains('activity-entry-error'));
  row.querySelector('.activity-output-toggle').click();assert.match(row.querySelector('.activity-output').textContent,/Exit code 1 after 4s\.[\s\S]*Expected 90/);
  const retry=ui.$('messages').querySelector('.message-retry');
  assert.equal(retry.querySelector('.message-retry-label').textContent,'Sent by Codeshi after the tests failed');
  assert(retry.classList.contains('long')&&!retry.classList.contains('expanded'),'The retry prompt stays short until opened.');

  conversation.retryOffer={id:'offer-one',runId:'r1',provider:'codex',model:'model-two',modelName:'Model Two',effort:'high',command:'npm test',blocked:'Codex is at 85% of its limit'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('retry-offer').hidden,false);
  assert.match(ui.$('retry-title').textContent,/^The tests failed\. Retry with Codex · .* · High effort\?$/);
  assert.match(ui.$('retry-detail').textContent,/^Codex is at 85% of its limit, so routing asked first\. Codex gets the end of the test output and tries once more, one step up\. npm test runs again afterwards\.$/);
  ui.$('retry-accept').click();await flush();await flush();
  assert.deepEqual(answers[0],{offerId:'offer-one',accept:true});assert.equal(ui.$('retry-offer').hidden,true);
  conversation.retryOffer={id:'offer-two',runId:'r1',provider:'codex',model:null,effort:null,command:'npm test'};await ui.window.relayUI.refresh();
  assert.match(ui.$('retry-title').textContent,/Retry with Codex\?$/);
  ui.$('retry-dismiss').click();await flush();await flush();
  assert.deepEqual(answers[1],{offerId:'offer-two',accept:false});
  conversation.retryOffer={id:'offer-three',runId:'r1',provider:'codex',command:'npm test'};conversation.status='running';conversation.activeRun={id:'r3',provider:'codex'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('retry-offer').hidden,true,'An offer waits while another run works.');
});

test('while a run works, a note can be added to it, shown inside that run, and the agent’s plan shows as a to-do list',async()=>{
  const ui=await browser(),conversation=ui.canonical.get('project-one'),notes=[];let answer={added:true};
  ui.setIntercept((request,next)=>{
    if(!request.path.endsWith('/steer'))return next();
    notes.push({body:request.body,projectId:request.projectId});
    if(answer.added)conversation.messages.push({id:'note-'+notes.length,role:'user',steer:true,text:request.body.text,runId:'run-one',provider:'codex',createdAt:new Date().toISOString()});
    return response(answer);
  });
  conversation.messages=[{id:'prompt',role:'user',text:'Build the checkout',runId:'run-one',createdAt:new Date().toISOString()},{id:'reply',role:'assistant',provider:'codex',text:'Reading the code.',runId:'run-one',createdAt:new Date().toISOString()}];
  conversation.status='running';conversation.canAddToRun=true;
  conversation.activeRun={id:'run-one',provider:'codex',plan:{steps:[{text:'Read the code',status:'done'},{text:'Writing tests',status:'active'},{text:'Run the suite',status:'pending'}]}};
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('steer-button').hidden,false);assert.equal(ui.$('steer-button').disabled,true,'Nothing to add yet.');
  assert.match(ui.$('message-input').placeholder,/add it to this run/);
  assert.equal(ui.$('run-plan').hidden,false);assert.equal(ui.$('run-plan-count').textContent,'1 of 3 done');assert.equal(ui.$('run-plan-current').textContent,'Writing tests');
  assert.equal(ui.$('run-plan-list').hidden,true,'The plan keeps its list closed until opened.');
  ui.$('run-plan-toggle').click();
  assert.equal(ui.$('run-plan-list').hidden,false);assert.equal(ui.$('run-plan-toggle').getAttribute('aria-expanded'),'true');
  assert.deepEqual(ui.$('run-plan-list').querySelectorAll('li').map(item=>item.className),['run-plan-step done','run-plan-step active','run-plan-step pending']);

  ui.$('message-input').value='Also update the docs';ui.fire('message-input','input');
  assert.equal(ui.$('steer-button').disabled,false);
  ui.$('message-input').dispatchEvent(new UIEvent('keydown',{key:'Enter',metaKey:true}));await flush();await flush();
  assert.deepEqual(notes[0],{body:{text:'Also update the docs'},projectId:'project-one'});
  assert.equal(ui.$('message-input').value,'');assert.equal(ui.requests.filter(request=>request.path.endsWith('/queue')).length,0,'A note is not queued.');
  const note=ui.$('messages').querySelector('.message-steer');
  assert(note,'The note shows in the conversation.');assert.match(note.textContent,/Added while working/);assert.match(note.textContent,/Also update the docs/);
  assert.equal(ui.$('messages').querySelectorAll('.turn').length,1,'The note stays inside the run it joined.');

  answer={added:false,queued:true};
  ui.$('message-input').value='And the changelog';ui.fire('message-input','input');
  ui.$('steer-button').click();await flush();await flush();
  assert.equal(ui.$('notice').hidden,false);assert.match(ui.$('notice-text').textContent,/runs next from the queue/);

  conversation.canAddToRun=false;await ui.window.relayUI.refresh();
  assert.equal(ui.$('steer-button').hidden,true,'Connections that cannot take notes only queue.');
  conversation.status='complete';conversation.activeRun=null;conversation.lastRun={id:'run-one',status:'complete'};await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan').hidden,true,'The plan shows while its run works.');
});

test('the task plan keeps its list open during progress and closes it for another run or workspace',async()=>{
  const ui=await browser({moreProjects:true}),conversation=ui.canonical.get('project-one');
  const steps=[{text:'Read the code',status:'done'},{text:'Write tests',status:'active'},{text:'Run the suite',status:'pending'}];
  conversation.status='running';conversation.activeRun={id:'planned-run',provider:'codex',plan:{steps}};
  await ui.window.relayUI.refresh();
  assert.match(ui.$('run-plan-toggle').getAttribute('aria-label'),/^Task plan: 1 of 3 done\. In progress: Write tests/);
  assert.equal(ui.$('run-plan-list').hidden,true);
  ui.$('run-plan-toggle').click();
  // Each step says where it stands in words; its mark is only a picture.
  let rows=ui.$('run-plan-list').querySelectorAll('li');
  assert.deepEqual(rows.map(row=>row.getAttribute('aria-label')),['Done: Read the code','In progress: Write tests','To do: Run the suite']);
  assert.deepEqual(rows.map(row=>row.querySelector('.run-plan-mark').textContent),['','','']);
  assert.equal(rows[1].getAttribute('aria-current'),'step');

  steps[1].status='done';steps[2].status='active';await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan-list').hidden,false,'Progress does not close a list the reader opened.');
  assert.equal(ui.$('run-plan-count').textContent,'2 of 3 done');
  assert.equal(ui.$('run-plan-current').textContent,'Run the suite');
  steps[2].status='done';await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan-current').textContent,'All steps done');
  assert.match(ui.$('run-plan-toggle').getAttribute('aria-label'),/3 of 3 done\. Complete: All steps done/);
  assert.equal(ui.$('run-plan').dataset.complete,'true');

  conversation.activeRun={id:'next-plan',provider:'codex',plan:{steps:[{text:'Prepare the next change',status:'pending'}]}};
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan-list').hidden,true,'Another run starts compact.');
  assert.match(ui.$('run-plan-toggle').getAttribute('aria-label'),/0 of 1 done\. Up next: Prepare the next change/);
  ui.$('run-plan-toggle').click();
  await ui.switchProject('project-two');
  assert.equal(ui.$('run-plan').hidden,true,'A workspace without a plan shows no card.');
  const second=ui.canonical.get('project-two');
  second.status='running';second.activeRun={id:'next-plan',provider:'claude',plan:{steps:[{text:'Inspect the other project',status:'active'}]}};
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan-list').hidden,true,'A matching run ID in another workspace does not inherit expansion.');
  assert.equal(ui.$('run-plan-current').textContent,'Inspect the other project');
  second.activeRun.plan.steps=[];await ui.window.relayUI.refresh();
  assert.equal(ui.$('run-plan').hidden,true,'An empty plan has no blank card.');
});

test('routing is chosen in the Agents panel; the model button then shows the mode and opens it, and what will run is shown before sending',async()=>{
  const ui=await browser({modelPickerUI:true,agentsUI:true,insights:true}),conversation=ui.canonical.get('project-one'),choices=[],handoff=[];let preferences={threshold:90,automatic:false};
  ui.setIntercept((request,next)=>{
    if(request.path.endsWith('/routing')){choices.push(request.body);conversation.routing=request.body.mode?{mode:request.body.mode,allowApi:request.body.allowApi===true,check:request.body.check===true}:null;return response(conversation);}
    if(request.path==='/api/handoff-preferences'){if(request.method==='POST'){handoff.push(request.body);preferences={...preferences,...request.body};}return response(preferences);}
    return next();
  });
  await ui.window.relayUI.refresh();await flush();
  assert.equal(ui.$('auto-button'),null,'Routing has no button of its own in the message box.');
  assert.equal(ui.$('picked-agent').textContent,'Codex');
  ui.$('open-agents').click();await flush();await flush();
  const options=ui.$('routing-options').querySelectorAll('.routing-option');
  assert.deepEqual(options.map(row=>row.querySelector('strong').textContent),['Manual','Cost saving','Balanced','Maximum quality']);
  assert.match(options[2].textContent,/Matches the model and effort to each message/,'Each mode says what it does.');
  assert.equal(options[0].getAttribute('aria-checked'),'true');
  options[2].click();await flush();await flush();
  assert.deepEqual(choices[0],{mode:'balanced',allowApi:false,check:false});
  assert.equal(ui.$('picked-agent').textContent,'Routing');assert.equal(ui.$('picked-model').textContent,'Balanced');
  assert(ui.$('model-picker-button').classList.contains('routing'));assert.equal(ui.$('effort-button').hidden,true,'Routing chooses the effort with the model.');
  ui.$('open-agents').click();ui.$('model-picker-button').click();await flush();
  assert.equal(ui.$('agents-panel').hidden,false,'The model button opens Routing while it is on.');

  ui.$('message-input').value='Refactor the payment module into services';ui.fire('message-input','input');
  assert.equal(ui.$('route-preview').hidden,false);
  assert.equal(ui.$('route-choice').textContent,'Codex · Model One · High effort');assert.equal(ui.$('route-reason').textContent,'A complex task (refactoring)');
  ui.$('message-input').dispatchEvent(new UIEvent('keydown',{key:'Enter'}));await flush();await flush();
  const sent=ui.requests.filter(request=>request.path.endsWith('/messages')).at(-1).body;
  assert.deepEqual([sent.provider,sent.model,sent.effort,sent.routing],['codex','model-one','high',{mode:'balanced',reason:'A complex task (refactoring)',tier:'deep',escalation:null}],'Model One at high effort is already its strongest, so there is no step up.');
  conversation.status='complete';conversation.messages.push({id:'routed',role:'user',text:'Refactor the payment module into services',provider:'codex',runId:'routed-run',routing:{mode:'balanced',reason:'A complex task (refactoring)',tier:'deep',model:'model-one',effort:'high'},createdAt:new Date().toISOString()});
  await ui.window.relayUI.refresh();
  const note=ui.$('messages').querySelector('.message-routing');
  assert.equal(note.textContent,'Auto · Codex · Model One · high effort');assert.match(note.title,/Balanced: A complex task/);

  assert.equal(ui.$('handoff-threshold').value,'90');assert.equal(ui.$('handoff-automatic').checked,false);
  ui.$('routing-allow-api').checked=true;ui.fire('routing-allow-api','change');await flush();await flush();
  assert.deepEqual(choices.at(-1),{mode:'balanced',allowApi:true,check:false});
  assert.equal(ui.$('routing-check-row').hidden,false);
  assert.equal(ui.$('routing-check').disabled,true,'Checking needs a Test command.');assert.match(ui.$('routing-check-hint').textContent,/Needs a test command\. Choose one in Run\./);
  assert.equal(ui.$('routing-check-set').hidden,false);
  ui.window.dispatchEvent(new UIEvent('relay-commands',{detail:{projectId:'project-one',commands:[{id:'dev',command:'npm run dev'},{id:'test',command:'npm test',test:true}]}}));
  assert.equal(ui.$('routing-check').disabled,false,'A Test command saved in Run shows at once.');assert.match(ui.$('routing-check-hint').textContent,/runs npm test\. If the tests fail, routing retries once/);
  assert.equal(ui.$('routing-check-set').hidden,true);
  ui.$('routing-check').checked=true;ui.fire('routing-check','change');await flush();await flush();
  assert.deepEqual(choices.at(-1),{mode:'balanced',allowApi:true,check:true});
  conversation.runs=[{id:'a',check:{status:'passed'}},{id:'b',check:{status:'failed'}},{id:'b2',retryOf:'b',check:{status:'passed'}},{id:'c',check:{status:'failed'}},{id:'c2',retryOf:'c',check:{status:'failed'}},{id:'d',check:{status:'skipped'}}];await ui.window.relayUI.refresh();
  assert.equal(ui.$('routing-check-stats').textContent,'Last 3 checked runs: 1 passed first time, 1 after a retry, 1 still failing.');
  ui.$('handoff-threshold').value='80';ui.fire('handoff-threshold','change');await flush();
  ui.$('handoff-automatic').checked=true;ui.fire('handoff-automatic','change');await flush();
  assert.deepEqual(handoff,[{threshold:80},{automatic:true}]);
  ui.$('routing-options').querySelectorAll('.routing-option')[0].click();await flush();await flush();
  assert.deepEqual(choices.at(-1),{mode:null,allowApi:true,check:true});assert.equal(ui.$('picked-agent').textContent,'Codex','Manual shows the chosen agent again.');
  ui.$('open-git').click();await flush();
  assert.equal(ui.$('agents-panel').hidden,true,'Git and Agents share the side panel.');
});

test('the sidebar, side panel and bottom panel resize with keyboard handles; the old Files divider and its saved height are removed',async()=>{
  const ui=await browser({layoutUI:true,stored:{'throughline:layout':JSON.stringify({inspector:999,commands:300,workspaces:500})}});
  const root=ui.document.documentElement,handles=ui.document.querySelectorAll('.resize-handle');
  assert.deepEqual(handles.map(handle=>handle.getAttribute('aria-label')).sort(),['Resize the side panel','Resize the side panel','Resize the side panel','Resize the side panel','Resize the side panel','Resize the sidebar','Resize the terminal and Run panel']);
  assert.equal(JSON.parse(ui.storage.get('throughline:layout')).workspaces,undefined,'An old divider height cannot push tasks down.');
  assert.equal(root.style['--inspector-width'],'720px','Saved sizes come back, within their limits.');assert.equal(ui.$('bottom-panel').style.height,'300px','The Run panel’s height carries over to the shared panel.');
  assert.deepEqual(Object.keys(JSON.parse(ui.storage.get('throughline:layout')||'{}')).filter(key=>['terminal','commands'].includes(key)),[]);
  const sidebar=handles.find(handle=>handle.getAttribute('aria-label')==='Resize the sidebar');assert.equal(sidebar.getAttribute('role'),'separator');assert.equal(sidebar.tabIndex,0);
  sidebar.dispatchEvent(new UIEvent('keydown',{key:'ArrowRight',preventDefault(){}}));
  assert.equal(root.style['--sidebar-width'],'260px','Never narrower than the sidebar can show its contents.');
  sidebar.dispatchEvent(new UIEvent('keydown',{key:'ArrowRight',shiftKey:true,preventDefault(){}}));
  assert.equal(root.style['--sidebar-width'],'308px');
  assert.equal(JSON.parse(ui.storage.get('throughline:layout')).sidebar,308,'The size is remembered.');
  sidebar.dispatchEvent(new UIEvent('dblclick'));
  assert.equal(root.style['--sidebar-width'],undefined,'Double-click returns to the default.');
  assert.equal(JSON.parse(ui.storage.get('throughline:layout')).sidebar,undefined);
});

test('layout buttons at the top right show and hide the sidebar, the Run panel and the side panel, filled while shown, and remember them',async()=>{
  const ui=await browser({layoutUI:true,insights:true,agentsUI:true,wide:true});await flush();
  const shell=ui.$('app-shell'),pressed=id=>ui.$(id).getAttribute('aria-pressed');
  assert.equal(pressed('toggle-sidebar'),'true');assert.equal(pressed('toggle-side-panel'),'true','Agents opens first on a docked layout.');
  ui.$('toggle-sidebar').click();
  assert(shell.classList.contains('sidebar-collapsed'));assert.equal(pressed('toggle-sidebar'),'false');assert.equal(ui.storage.get('throughline:sidebar'),'hidden');
  ui.document.dispatchEvent(new UIEvent('keydown',{key:'b',metaKey:true,ctrlKey:true,preventDefault(){}}));
  assert(!shell.classList.contains('sidebar-collapsed'),'The keyboard shortcut shows it again.');assert.equal(ui.storage.get('throughline:sidebar'),'shown');
  ui.$('toggle-side-panel').click();await flush();
  assert.equal(ui.$('agents-panel').hidden,true);assert.equal(pressed('toggle-side-panel'),'false','Hidden panels leave no buttons in the header.');
  ui.$('git-panel').querySelectorAll('.panel-tab');ui.$('open-git').click();await flush();
  assert.equal(ui.$('git-panel').hidden,false);ui.$('toggle-side-panel').click();await flush();assert.equal(ui.$('git-panel').hidden,true);
  ui.$('toggle-side-panel').click();await flush();
  assert.equal(ui.$('git-panel').hidden,false,'The side panel reopens on the tab last used.');assert.equal(pressed('toggle-side-panel'),'true');
  const again=await browser({layoutUI:true,stored:{'throughline:sidebar':'hidden'}});
  assert(again.$('app-shell').classList.contains('sidebar-collapsed'),'A hidden sidebar stays hidden next time.');assert.equal(again.$('toggle-sidebar').getAttribute('aria-pressed'),'false');
});

test('the search bar at the top finds workspaces, files in every workspace and actions, without filtering the sidebar',async()=>{
  const ui=await browser({moreProjects:true}),search=ui.$('workspace-search'),results=ui.$('command-results');let settings=0;const searches=[];
  ui.setIntercept((request,next)=>{
    if(request.path!=='/api/file-search')return next();
    searches.push(request.params.q);
    return response({files:[{projectId:'project-two',projectName:'Other workspace',folderId:'api',folderName:'API',path:'src/settings.js'}]});
  });
  ui.$('relay-settings').addEventListener('click',()=>settings++);
  search.dispatchEvent(new UIEvent('focus'));
  assert.equal(results.hidden,false);assert.deepEqual(results.querySelectorAll('.command-group').map(node=>node.textContent),['Workspaces','Actions']);
  const labels=()=>results.querySelectorAll('.command-result').map(node=>node.querySelector('.command-label').textContent);
  assert(labels().includes('Example workspace'));assert(labels().includes('Ask a friend…'));
  search.value='sett';ui.fire('workspace-search','input');
  assert.equal(ui.$('workspace-list').querySelectorAll('.workspace-item').length||ui.state().projects.length,2,'The sidebar keeps every workspace.');
  ui.runTimers();await flush();await flush();
  assert.deepEqual(searches,['sett']);
  assert.deepEqual(results.querySelectorAll('.command-group').map(node=>node.textContent),['Files','Actions']);
  assert.deepEqual(labels(),['settings.js','Settings','Alert settings: banners, sounds, the Dock and the menu bar','Voice settings']);
  assert.match(results.querySelectorAll('.command-result')[0].textContent,/Other workspace · src/);
  search.value='>sett';ui.fire('workspace-search','input');ui.runTimers();await flush();
  assert.deepEqual(labels(),['Settings','Alert settings: banners, sounds, the Dock and the menu bar','Voice settings'],'A leading > shows actions only.');assert.deepEqual(searches,['sett'],'Actions-only searches look up no files.');
  search.dispatchEvent(new UIEvent('keydown',{key:'Enter',preventDefault(){}}));
  assert.equal(settings,1);assert.equal(search.value,'','Running a result clears the search.');assert.equal(results.hidden,true);
  search.value='sett';ui.fire('workspace-search','input');ui.runTimers();await flush();await flush();
  results.querySelectorAll('.command-result')[0].click();await flush();await flush();
  assert.equal(ui.state().projectId,'project-two','A file in another workspace opens that workspace.');
  search.value='other';ui.fire('workspace-search','input');
  search.dispatchEvent(new UIEvent('keydown',{key:'Enter',preventDefault(){}}));await flush();
  assert.equal(ui.state().projectId,'project-two','Enter opens the first workspace match.');
});

test('the prompt itself stays at the top of its turn, with no floating copy, and a long prompt shows its first lines until opened',async()=>{
  const ui=await browser(),conversation=ui.canonical.get('project-one');
  const long=Array.from({length:9},(_,index)=>`Step ${index+1}: do the next part of the change.`).join('\n');
  conversation.messages=[{id:'short',role:'user',text:'Tell me about the project',runId:'one',createdAt:new Date().toISOString()},{id:'answer',role:'assistant',provider:'codex',text:'It is a checkout app.',runId:'one',createdAt:new Date().toISOString()},{id:'long',role:'user',text:long,runId:'two',createdAt:new Date().toISOString()}];
  await ui.window.relayUI.refresh();
  assert.equal(ui.$('messages').querySelectorAll('.turn-pin').length,0,'No floating copy of the prompt.');
  const prompts=ui.$('messages').querySelectorAll('.message-prompt');assert.equal(prompts.length,2);
  assert.equal(prompts[0].classList.contains('long'),false);assert.equal(prompts[0].querySelector('.prompt-more'),null);
  const more=prompts[1].querySelector('.prompt-more');assert(prompts[1].classList.contains('long'));assert.equal(more.textContent,'Show more');
  more.click();assert(prompts[1].classList.contains('expanded'));assert.equal(more.textContent,'Show less');
  conversation.messages.push({id:'reply',role:'assistant',provider:'codex',text:'Working on it.',runId:'two',createdAt:new Date().toISOString()});await ui.window.relayUI.refresh();
  assert(ui.$('messages').querySelectorAll('.message-prompt')[1].classList.contains('expanded'),'An opened prompt stays open as the conversation updates.');
});

test('with the sidebar hidden, the top bar names the open workspace, and clicking it shows the sidebar again',async()=>{
  const ui=await browser({layoutUI:true,moreProjects:true});
  assert.equal(ui.$('workspace-chip-name').textContent,'Example workspace');
  await ui.switchProject('project-two');assert.equal(ui.$('workspace-chip-name').textContent,'Other workspace','It follows the open workspace.');
  ui.$('toggle-sidebar').click();assert(ui.$('app-shell').classList.contains('sidebar-collapsed'));
  ui.$('workspace-chip').click();assert(!ui.$('app-shell').classList.contains('sidebar-collapsed'),'Clicking the name shows the sidebar.');
});

test('an update is one click in the status bar: Update downloads it with a ring, then Restart to update restarts', async () => {
  const latest = { version: '0.15.0', notesUrl: 'https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0', publishedAt: null };
  const ui = await browser({ desktop: true, update: { version: '0.14.0', supported: true, automatic: true, skipped: null, checkedAt: null, status: 'current', error: null, progress: null, blocked: null, latest: null } });
  const button = ui.$('update-status'), more = ui.$('update-more'), popover = ui.$('update-popover');
  assert.equal(button.hidden, true, 'Nothing shows while this is the latest version.');

  ui.pushUpdate({ status: 'available', latest });
  assert.deepEqual([button.hidden, more.hidden, button.dataset.status], [false, false, 'available']);
  assert.equal(ui.$('update-status-label').textContent, 'Update to 0.15.0');
  button.click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['install'], 'One click starts the update.');
  assert.equal(popover.matches(':popover-open'), false, 'Nothing to read first.');

  // The download is a ring that fills; its share is only in the button's name, and there are no megabytes.
  ui.pushUpdate({ status: 'downloading', progress: { received: 52428800, total: 136314880 } });
  assert.equal(ui.$('update-status-label').textContent, 'Downloading update');
  assert.deepEqual([button.dataset.progress, button.style['--update-progress'], button.getAttribute('aria-label')], ['determinate', '38', 'Downloading update, 38%']);
  assert.equal(more.hidden, true);
  button.click();
  assert.equal(popover.matches(':popover-open'), true, 'While it downloads, the button opens the details.');
  assert.doesNotMatch(ui.$('update-content').textContent, /MB/);
  ui.findButton('Cancel').click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['cancel']);
  popover.hidePopover();
  ui.pushUpdate({ status: 'downloading', progress: { received: 0, total: null } });
  assert.equal(button.dataset.progress, 'indeterminate', 'A download of unknown size turns the ring instead.');

  // Downloaded and checked: Restart to update restarts with one click.
  ui.pushUpdate({ status: 'ready', progress: null });
  assert.equal(ui.$('update-status-label').textContent, 'Restart to update');
  assert.equal(more.hidden, false);
  button.click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['restart']);
  // An agent at work: the restart waits for the run, and the details can call it off.
  ui.pushUpdate({ status: 'waiting' });
  assert.equal(ui.$('update-status-label').textContent, 'Restarts after this run');
  button.click();
  assert.match(ui.$('update-content').textContent, /as soon as no agent is working/);
  ui.findButton('Don’t restart').click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['cancel']);
  popover.hidePopover();
  ui.pushUpdate({ status: 'error', error: 'The download does not match its published checksum, so nothing was installed.' });
  assert.equal(ui.$('update-status-label').textContent, 'Update failed');
  button.click();
  assert.match(ui.$('update-content').textContent, /does not match its published checksum/);
  ui.findButton('Try again').click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['install']);
});

test('the chevron beside the update has its release notes and Skip, and Check for Updates shows a skipped version', async () => {
  const latest = { version: '0.15.0', notesUrl: 'https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0', publishedAt: null };
  const ui = await browser({ desktop: true, update: { version: '0.14.0', supported: true, automatic: true, skipped: null, checkedAt: null, status: 'available', error: null, progress: null, blocked: null, latest } });
  const button = ui.$('update-status'), more = ui.$('update-more'), popover = ui.$('update-popover');
  more.click();
  assert.equal(popover.matches(':popover-open'), true);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.$('update-title').textContent, 'Codeshi 0.15.0');
  assert.equal(ui.$('update-subtitle').textContent, 'You have 0.14.0');
  ui.findButton('Release notes ↗').click(); await flush();
  assert.deepEqual(ui.externalLinks, [latest.notesUrl]);
  // Skipping hides this version until the next one, and Check for Updates… shows it again.
  ui.findButton('Skip this version').click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['skip', '0.15.0']);
  assert.deepEqual([button.hidden, more.hidden], [true, true]);
  popover.hidePopover();
  ui.window.relayUI.commands['check-updates'](); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['check']);
  assert.equal(popover.matches(':popover-open'), true);
  ui.findButton('Update').click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['install'], 'The details can start the update too.');
});

test('an app that cannot replace itself offers the download instead, and a manual check says when Codeshi is up to date', async () => {
  const ui = await browser({ desktop: true, update: { version: '0.14.0', supported: true, automatic: true, skipped: null, checkedAt: null, status: 'available', error: null, progress: null, blocked: 'translocated', latest: { version: '0.15.0', notesUrl: 'https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0' } } });
  ui.$('update-status').click();
  assert.match(ui.$('update-content').textContent, /Move it to your Applications folder/);
  assert.equal(ui.findButton('Update and restart'), undefined);
  ui.findButton('Download ↗').click(); await flush();
  assert.deepEqual(ui.externalLinks, ['https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0']);
  ui.pushUpdate({ status: 'current', latest: null, blocked: null });
  ui.window.relayUI.commands['check-updates'](); await flush();
  assert.match(ui.$('update-content').textContent, /Codeshi 0\.14\.0 is the latest version/);
});

test('Settings turns automatic update checks off and checks now', async () => {
  const ui = await browser({ desktop: true, workbench: true, update: { version: '0.14.0', supported: true, automatic: true, skipped: null, checkedAt: '2026-11-02T09:30:00.000Z', status: 'current', error: null, progress: null, blocked: null, latest: null } });
  await ui.window.relaySettings.open('preferences'); await flush();
  assert(ui.document.querySelectorAll('h3').some(heading => heading.textContent === 'Updates'));
  const automatic = ui.labelledInput('Check for updates automatically');
  assert.equal(automatic.checked, true);
  automatic.checked = false; automatic.dispatchEvent(new UIEvent('change')); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['automatic', false]);
  ui.findButton('Check now').click(); await flush();
  assert.deepEqual(ui.updateCalls.at(-1), ['check']);
});


test('the Git panel stages changes and commits exactly what is staged, and offers committing without hooks only after a hook stops it', async () => {
  const ui = await browser({ insights: true });
  let repo = { folderId: 'frontend', name: 'Frontend', available: true, branch: 'main', totalChanges: 2, changes: [{ path: 'app.js', code: ' M', staged: false }, { path: 'notes.md', code: '??', staged: false }], stagedPaths: [], commits: [], committer: { name: 'Pat Example', email: 'pat@example.com' } };
  const posts = [], activity = () => ({ checkedAt: new Date().toISOString(), repositories: [clone(repo)] });
  let hookFails = true;
  ui.setIntercept((request, next) => {
    if (request.path === '/api/git' && request.method === 'GET') return response(activity());
    if (request.path === '/api/git/stage' && request.method === 'POST') {
      posts.push(['stage', clone(request.body)]);
      repo = { ...repo, changes: [{ path: 'app.js', code: 'M ', staged: true }, repo.changes[1]], stagedPaths: ['app.js'] };
      return response({ staged: true, git: activity() });
    }
    if (request.path === '/api/git/commit' && request.method === 'POST') {
      posts.push(['commit', clone(request.body)]);
      if (hookFails) { hookFails = false; return response({ error: 'A commit hook stopped the commit. Its output is below.', details: { code: 'hook', hooks: true, output: 'lint: 2 problems in app.js' } }, 409); }
      repo = { ...repo, totalChanges: 1, changes: [repo.changes[1]], stagedPaths: [] };
      return response({ commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Fix the header', branch: 'main', files: 1, hooks: false }, git: activity() });
    }
    return next();
  });
  ui.$('open-git').click(); await flush();
  const heads = () => ui.document.querySelectorAll('.git-section-head').map(head => head.children[0].textContent);
  assert.deepEqual(heads(), ['Changes']);
  assert.equal(ui.$('git-commit').hidden, false);
  assert.equal(ui.$('git-commit-button').disabled, true);
  assert.equal(ui.$('git-committer').textContent, 'as Pat Example');
  const labelled = label => ui.document.querySelectorAll('button').find(button => button.getAttribute('aria-label') === label);
  labelled('Stage app.js').click(); await flush();
  assert.deepEqual(posts[0], ['stage', { folderId: 'frontend', paths: ['app.js'] }]);
  assert.deepEqual(heads(), ['Staged changes', 'Changes']);
  assert(labelled('Unstage app.js'));
  assert.equal(ui.$('git-commit-button').textContent, 'Commit 1 file');
  assert.equal(ui.$('git-commit-button').disabled, true, 'A commit needs a message.');
  ui.$('git-commit-message').value = 'Fix the header'; ui.fire('git-commit-message', 'input');
  assert.equal(ui.$('git-commit-button').disabled, false);

  ui.$('git-commit').dispatchEvent(new UIEvent('submit')); await flush();
  assert.deepEqual(posts[1], ['commit', { folderId: 'frontend', message: 'Fix the header', expected: ['app.js'], skipHooks: false }]);
  assert.match(ui.$('git-commit-result').textContent, /A commit hook stopped the commit/);
  assert.equal(ui.document.querySelector('.git-commit-output').textContent, 'lint: 2 problems in app.js');
  assert.equal(ui.$('git-commit-message').value, 'Fix the header', 'The message is kept to try again.');
  ui.findButton('Commit without hooks').click(); await flush();
  assert.equal(posts[2][1].skipHooks, true);
  assert.equal(ui.$('git-commit-result').textContent, 'Committed aaaaaaa on main · not pushed');
  assert.equal(ui.$('git-commit-message').value, '');
  assert.deepEqual(heads(), ['Changes']);
  assert.equal(ui.findButton('Commit without hooks'), undefined);
});

test('with nothing staged, Commit commits every change listed: it stages exactly those files, then commits them', async () => {
  const ui = await browser({ insights: true });
  let repo = { folderId: 'frontend', name: 'Frontend', available: true, branch: 'main', totalChanges: 2, changes: [{ path: 'app.js', code: ' M', staged: false }, { path: 'docs/', code: '??', staged: false }], stagedPaths: [], commits: [], committer: { name: 'Pat Example', email: 'pat@example.com' } };
  const posts = [], activity = () => ({ checkedAt: new Date().toISOString(), repositories: [clone(repo)] });
  ui.setIntercept((request, next) => {
    if (request.path === '/api/git' && request.method === 'GET') return response(activity());
    if (request.path === '/api/git/stage') { posts.push(['stage', clone(request.body)]); repo = { ...repo, changes: [{ path: 'app.js', code: 'M ', staged: true }, { path: 'docs/guide.md', code: 'A ', staged: true }], stagedPaths: ['app.js', 'docs/guide.md'] }; return response({ staged: true, git: activity() }); }
    if (request.path === '/api/git/commit') { posts.push(['commit', clone(request.body)]); repo = { ...repo, totalChanges: 0, changes: [], stagedPaths: [] }; return response({ commit: { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', subject: 'Ship it', branch: 'main', files: 2, hooks: true }, git: activity() }); }
    return next();
  });
  ui.$('open-git').click(); await flush();
  assert.equal(ui.$('git-commit-button').textContent, 'Commit all 2 files');
  assert.equal(ui.$('git-commit-button').disabled, true, 'A commit needs a message.');
  ui.$('git-commit-message').value = 'Ship it'; ui.fire('git-commit-message', 'input');
  assert.equal(ui.$('git-commit-button').disabled, false, 'A message is enough when there are changes.');
  ui.$('git-commit').dispatchEvent(new UIEvent('submit')); await flush();
  assert.deepEqual(posts, [['stage', { folderId: 'frontend', paths: ['app.js', 'docs/'] }], ['commit', { folderId: 'frontend', message: 'Ship it', expected: ['app.js', 'docs/guide.md'], skipHooks: false }]]);
  assert.equal(ui.$('git-commit-result').textContent, 'Committed bbbbbbb on main · not pushed');
  assert.equal(ui.$('git-commit-button').disabled, true);
});


test('the terminal opens shells as tabs named after their folders, splits a tab into panes, and keeps each workspace’s shells to themselves', async () => {
  const ui = await browser({ terminalUI: true, moreProjects: true });
  const lists = new Map(), posts = [], names = { backend: 'Backend', api: 'API', frontend: 'Frontend' }; let counter = 0;
  ui.setIntercept((request, next) => {
    if (!request.path.startsWith('/api/terminal')) return next();
    const id = request.projectId, list = lists.get(id) || [];
    if (request.path === '/api/terminal') return response({ sessions: clone(list), shell: 'zsh' });
    posts.push([request.path.slice('/api/terminal/'.length), id, clone(request.body)]);
    if (request.path === '/api/terminal/start') {
      const { folderId, split, replace } = request.body, number = ++counter, sessionId = `${id}-shell-${number}`;
      const replaced = replace && list.find(item => item.id === replace), beside = split && list.find(item => item.id === split.of);
      const value = { id: sessionId, projectId: id, folderId, folderName: names[folderId] || folderId, cwd: `/workspace/${folderId}`, shell: '/bin/zsh', status: 'running', exitCode: null, signal: null, error: null, startedAt: new Date().toISOString(), endedAt: null, cols: request.body.cols, rows: request.body.rows,
        tabId: replaced?.tabId || beside?.tabId || sessionId, pane: replaced ? replaced.pane : beside ? 1 : 0, split: replaced ? replaced.split : beside ? split.direction : null, order: replaced?.order || beside?.order || number };
      lists.set(id, [...list.filter(item => item.id !== replace), value]);
      return response(value, 201);
    }
    if (request.path === '/api/terminal/stop') {
      const gone = list.find(item => item.id === request.body.id);
      lists.set(id, list.filter(item => item !== gone).map(item => item.tabId === gone?.tabId ? { ...item, pane: 0, split: null } : item));
      return response({ ...gone, status: 'stopped' });
    }
    return response({ written: 1 });
  });
  const streams = () => ui.eventSources.filter(source => source.url.startsWith('/api/terminal/stream'));
  const send = (stream, type, data) => stream.dispatchEvent(new UIEvent(type, { data: JSON.stringify(data) }));
  const tabNames = () => ui.$('terminal-tabs').querySelectorAll('.terminal-tab-name').map(node => node.textContent);
  const selected = () => ui.$('terminal-tabs').querySelectorAll('.terminal-tab-pick').map(button => button.getAttribute('aria-selected'));

  // A workspace with several folders asks which one the shell starts in. Terminal is in the status bar.
  ui.$('status-terminal').click(); await flush();
  assert.equal(ui.$('terminal-panel').hidden, false); assert.equal(ui.$('bottom-panel').hidden, false);
  assert.equal(ui.$('status-terminal').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.$('bottom-tab-terminal').getAttribute('aria-selected'), 'true');
  assert.equal(ui.$('terminal-start').hidden, false);
  const folders = ui.$('terminal-folders').querySelectorAll('button');
  assert.deepEqual(folders.map(button => button.textContent), ['Frontend', 'Backend'], 'Each folder is a button that opens the shell there.');
  folders[1].click(); await flush();
  assert.deepEqual(posts[0], ['start', 'project-one', { folderId: 'backend', cols: 100, rows: 24 }]);
  const [first] = ui.terminals, [firstStream] = streams();
  assert.equal(firstStream.url, '/api/terminal/stream?projectId=project-one&id=project-one-shell-1');
  send(firstStream, 'reset', { data: 'welcome\r\n' }); send(firstStream, 'data', { data: '$ ' });
  assert.equal(first.written, 'welcome\r\n$ ');
  first.type('ls\r'); await flush();
  assert.deepEqual(posts.at(-1), ['input', 'project-one', { id: 'project-one-shell-1', data: 'ls\r' }]);
  assert.deepEqual(tabNames(), ['Backend'], 'The shell is a tab named after its folder.');
  assert.equal(ui.$('terminal-tabs').hidden, false, 'The list of shells shows from the first one, so its folder is always in view.');
  assert.equal(ui.$('terminal-tabs').querySelectorAll('.terminal-tab-pick')[0].title, 'zsh in /workspace/backend');
  assert.equal(ui.$('terminal-start').hidden, true);

  // + offers the workspace's folders and opens another shell in a tab of its own; only the open tab shows.
  ui.$('terminal-new').click(); await flush();
  assert.equal(ui.$('terminal-new').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(ui.$('terminal-new-menu').querySelectorAll('.terminal-menu-name').map(node => node.textContent), ['Frontend', 'Backend']);
  ui.$('terminal-new-menu').querySelectorAll('button')[0].click(); await flush();
  assert.deepEqual(posts.at(-1), ['start', 'project-one', { folderId: 'frontend', cols: 80, rows: 24 }]);
  assert.equal(ui.$('terminal-new-menu').hidden, true);
  assert.deepEqual([tabNames(), selected()], [['Backend', 'Frontend'], ['false', 'true']]);
  const frontend = ui.terminals[1];
  assert.deepEqual([first.host.hidden, frontend.host.hidden], [true, false]);
  // The arrow keys move between the listed shells, and Tab reaches only the open one's row.
  const arrow = key => { const event = new UIEvent('keydown', { key }); ui.$('terminal-tabs').dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(arrow('ArrowUp'), true);
  assert.deepEqual([selected(), first.host.hidden, frontend.host.hidden], [['true', 'false'], false, true]);
  assert.equal(ui.document.activeElement, ui.$('terminal-tabs').querySelectorAll('.terminal-tab-pick')[0], 'Focus follows the row the arrows chose.');
  assert.deepEqual(ui.$('terminal-tabs').querySelectorAll('.terminal-tab-pick').map(button => button.tabIndex), [0, -1]);
  arrow('ArrowDown'); assert.deepEqual(selected(), ['false', 'true']);
  arrow('ArrowDown'); assert.deepEqual(selected(), ['true', 'false'], 'The arrows wrap around.');
  arrow('End'); assert.deepEqual(selected(), ['false', 'true']);
  assert.equal(arrow('a'), false, 'Other keys are left alone.');
  // Split puts a second shell in the same folder beside it, and input goes only to the pane it was typed in.
  ui.$('terminal-split').click(); await flush();
  assert.deepEqual(posts.at(-1), ['start', 'project-one', { folderId: 'frontend', cols: 80, rows: 24, split: { of: 'project-one-shell-2', direction: 'right' } }]);
  const beside = ui.terminals[2];
  assert.deepEqual(tabNames(), ['Backend', 'Frontend'], 'The split shell joins the open tab.');
  assert.deepEqual([ui.$('terminal-views').dataset.split, frontend.host.hidden, beside.host.hidden, beside.host.dataset.pane], ['right', false, false, '1']);
  assert.equal(ui.$('terminal-split').disabled, true, 'A tab holds two panes.');
  beside.type('npm run dev\r'); await flush();
  assert.deepEqual(posts.at(-1), ['input', 'project-one', { id: 'project-one-shell-3', data: 'npm run dev\r' }]);
  // End acts on the pane in use; the other pane stays as the tab's only one.
  ui.$('terminal-end').click(); await flush();
  assert.deepEqual(posts.at(-1), ['stop', 'project-one', { id: 'project-one-shell-3' }]);
  assert.deepEqual([beside.disposed, ui.$('terminal-views').dataset.split, frontend.host.hidden], [true, '', false]);
  // Closing a tab ends its shell, and the tab beside it opens.
  ui.$('terminal-tabs').querySelectorAll('.terminal-tab-close')[1].click(); await flush();
  assert.deepEqual(posts.at(-1), ['stop', 'project-one', { id: 'project-one-shell-2' }]);
  assert.deepEqual([tabNames(), first.host.hidden, frontend.disposed], [['Backend'], false, true]);

  // Another workspace gets its own shells, and the first one's input still goes to the first workspace.
  await ui.switchProject('project-two'); await flush();
  assert.deepEqual(posts.at(-1).slice(0, 2), ['start', 'project-two'], 'A single-folder workspace opens its shell at once.');
  const second = ui.terminals.at(-1), secondId = posts.length && lists.get('project-two')[0].id;
  assert.equal(first.host.hidden, true); assert.equal(second.host.hidden, false);
  first.type('pwd\r'); await flush();
  assert.deepEqual(posts.at(-1), ['input', 'project-one', { id: 'project-one-shell-1', data: 'pwd\r' }]);

  // Hiding the panel, or switching to Run, leaves the shells running; the menu command shows the terminal again.
  ui.$('bottom-hide').click(); await flush();
  assert.equal(ui.$('terminal-panel').hidden, true); assert.equal(ui.$('bottom-panel').hidden, true);
  assert.deepEqual(JSON.parse(ui.storage.get('throughline:panel')), { open: false, tool: 'terminal' });
  assert.equal(ui.$('status-terminal').hidden, false, 'Terminal stays in the status bar while the panel is hidden.');
  ui.window.relayUI.commands.terminal(); await flush();
  assert.equal(ui.$('terminal-panel').hidden, false);
  assert.equal(second.host.hidden, false);
  ui.$('bottom-tab-run').click(); await flush();
  assert.equal(ui.$('terminal-panel').hidden, true); assert.equal(second.host.hidden, true);
  ui.$('bottom-tab-terminal').click(); await flush();
  assert.equal(second.host.hidden, false);
  assert(!posts.some(([name, id]) => name === 'stop' && id === 'project-two'));

  // Ending a shell stops it; an exited shell keeps its output and offers a new session in its own tab.
  ui.$('terminal-end').click(); await flush();
  assert.deepEqual(posts.at(-1), ['stop', 'project-two', { id: secondId }]);
  assert.equal(second.disposed, true);
  await ui.switchProject('project-one'); await flush();
  assert.equal(first.host.hidden, false, 'The first workspace’s shell returns as it was.');
  send(firstStream, 'exit', { ...lists.get('project-one')[0], status: 'exited', exitCode: 1 });
  assert.equal(firstStream.closed, true);
  assert.match(first.written, /\[The shell exited with code 1\. Its output stays until you close this tab or start a new session\.\]/, 'The exit is said once, in the terminal.');
  assert.equal(ui.$('terminal-message').hidden, true);
  assert.equal(ui.$('terminal-tabs').querySelectorAll('.terminal-tab')[0].dataset.state, 'ended');
  assert.equal(ui.$('terminal-restart').hidden, false); assert.equal(ui.$('terminal-end').hidden, true);
  ui.$('terminal-restart').click(); await flush();
  assert.deepEqual(posts.at(-1), ['start', 'project-one', { folderId: 'backend', cols: 80, rows: 24, replace: 'project-one-shell-1' }]);
  assert.deepEqual([tabNames(), first.disposed], [['Backend'], true], 'The new shell takes the ended one’s tab.');
});

test('voice input fills the message box as you speak, Esc cancels it, and a run started by voice is summarized aloud', async () => {
  const ui = await browser({ voiceUI: true, stored: { 'throughline:voice': JSON.stringify({ sendAfter: true }) } });
  const posts = [];
  ui.setIntercept((request, next) => {
    if (request.path === '/api/voice') return response({ supported: true, helper: 'ready', speech: 'authorized', microphone: 'authorized', onDevice: true, locale: 'en-US' });
    if (request.path.startsWith('/api/voice/')) { posts.push([request.path.slice(11), clone(request.body)]); return response(request.path === '/api/voice/start' ? { id: `v${posts.length}`, status: 'starting' } : {}, request.path === '/api/voice/start' ? 201 : 200); }
    return next();
  });
  ui.window.relayVoice.settings(ui.document.createElement('section')); await flush();
  const mic = ui.$('voice-input'), input = ui.$('message-input');
  assert.equal(mic.hidden, false);
  const send = (stream, type, data) => stream.dispatchEvent(new UIEvent(type, { data: JSON.stringify({ type, ...data }) }));
  const stream = () => ui.eventSources.filter(source => source.url.startsWith('/api/voice/stream')).at(-1);

  // Esc while listening puts the message box back as it was.
  input.value = 'Draft'; ui.fire('message-input', 'input');
  mic.click(); await flush();
  send(stream(), 'ready'); send(stream(), 'partial', { text: 'never mind' });
  assert.equal(input.value, 'Draft never mind');
  ui.document.dispatchEvent(new UIEvent('keydown', { key: 'Escape' })); await flush();
  assert.equal(input.value, 'Draft');
  assert.deepEqual(posts.at(-1), ['cancel', { id: 'v1' }]);
  assert.equal(stream().closed, true);

  // What is heard joins the draft as it comes; stopping keeps it.
  input.value = 'Fix'; ui.fire('message-input', 'input');
  mic.click(); await flush();
  assert.equal(stream().url, '/api/voice/stream?id=v3');
  send(stream(), 'ready');
  assert.equal(mic.getAttribute('aria-pressed'), 'true');
  assert.match(ui.$('voice-status-text').textContent, /Listening/);
  assert.equal(ui.$('voice-status-where').hidden, false);
  assert.match(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /<div id="voice-status"[^>]*role="status"[^>]*>(?:(?!<\/div>).)*<span id="voice-status-where"[^>]*>On this Mac<\/span>/, 'Inside the status, so a screen reader hears it.');
  send(stream(), 'partial', { text: 'the header' });
  assert.equal(input.value, 'Fix the header');
  mic.click(); await flush();
  assert.deepEqual(posts.at(-1), ['stop', { id: 'v3' }]);
  send(stream(), 'final', { text: 'the header colour.' });
  assert.equal(input.value, 'Fix the header colour.');
  assert.equal(mic.getAttribute('aria-pressed'), 'false');

  // "Send when I stop talking" counts down, then sends.
  assert.match(ui.$('voice-status-text').textContent, /Sending in 3/);
  for (let tick = 0; tick < 4 && !ui.requests.some(request => request.path.endsWith('/messages')); tick++) { ui.runTimers(); await flush(); }
  assert.equal(ui.requests.find(request => request.path.endsWith('/messages')).body.text, 'Fix the header colour.');

  // The run it started is summarized aloud from what it recorded, without another agent call.
  const c = ui.canonical.get('project-one'), startedAt = '2026-11-02T10:00:00.000Z';
  c.status = 'running'; c.activeRun = { id: 'run-voice', provider: 'claude', phase: 'tool', startedAt }; await ui.window.relayUI.refresh();
  c.messages.push(
    { id: 'step-1', runId: 'run-voice', role: 'activity', text: 'File changes: [{"path":"src/header.css","kind":"modify"},{"path":"src/theme.js","kind":"modify"}]' },
    { id: 'step-2', runId: 'run-voice', role: 'activity', text: '$ npm test\n12 passing' },
    { id: 'reply', runId: 'run-voice', role: 'assistant', provider: 'claude', text: 'Done. The header now uses the **brand colour** from `theme.js`.\n\n```css\n.header { color: var(--brand); }\n```\n\nI also checked the dark theme.' });
  c.status = 'complete'; c.activeRun = null; c.lastRun = { id: 'run-voice', provider: 'claude', status: 'complete', startedAt, endedAt: '2026-11-02T10:01:40.000Z' };
  await ui.window.relayUI.refresh();
  assert.deepEqual(ui.spoken, ['Claude finished in 1 minute 40 seconds. It changed header.css and theme.js, and ran the tests. Done. The header now uses the brand colour from theme.js. I also checked the dark theme.']);

  // A run started by typing is not read aloud unless that is chosen.
  c.status = 'running'; c.activeRun = { id: 'run-typed', provider: 'codex', startedAt }; await ui.window.relayUI.refresh();
  c.status = 'complete'; c.activeRun = null; c.lastRun = { id: 'run-typed', provider: 'codex', status: 'complete', startedAt, endedAt: startedAt }; await ui.window.relayUI.refresh();
  assert.equal(ui.spoken.length, 1);
  assert.equal(ui.window.relayVoice.summarize({ provider: 'codex', status: 'failed', errorCategory: 'quota' }, []), 'Codex stopped at a usage limit.');
});

test('coming back after two minutes or more shows what ran, changed and is waiting, and can read it aloud', async () => {
  let now = Date.parse('2026-11-02T10:00:00.000Z');
  const ui = await browser({ voiceUI: true, recapUI: true, moreProjects: true, clock: () => now });
  const asked = [];
  let recap = { since: '2026-11-02T10:00:00.000Z', until: '2026-11-02T10:24:00.000Z', workspaces: [
    { projectId: 'project-two', name: 'Other workspace', runs: [
      { id: 'r1', provider: 'claude', prompt: 'Add promo codes to checkout', status: 'complete', startedAt: '2026-11-02T10:02:00.000Z', endedAt: '2026-11-02T10:05:00.000Z', files: ['src/checkout.js', 'src/promo.js'], fileCount: 2, commands: 1, tests: true },
      { id: 'r2', provider: 'codex', prompt: 'Refactor the payment module', status: 'incomplete', errorCategory: 'quota', startedAt: '2026-11-02T10:06:00.000Z', endedAt: '2026-11-02T10:20:00.000Z', files: [], fileCount: 0, commands: 0, tests: false }],
      approvals: 1, waiting: { providers: ['claude', 'codex'], resetsAt: null }, queue: null, handoff: null, uncommitted: 3 }] };
  ui.setIntercept((request, next) => { if (request.path === '/api/recap') { asked.push(request.params.since); return response(recap); } return next(); });
  const leave = () => ui.window.dispatchEvent(new UIEvent('blur')), come = async () => { ui.window.dispatchEvent(new UIEvent('focus')); await flush(); };

  leave(); now += 90 * 1000; await come();
  assert.deepEqual(asked, [], 'A short break shows nothing.');
  leave(); const left = now; now += 24 * 60 * 1000; await come();
  assert.deepEqual(asked, [new Date(left).toISOString()]);
  const panel = ui.$('recap');
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelector('.recap-name').textContent, 'Other workspace');
  assert.deepEqual(panel.querySelectorAll('li').map(item => [item.dataset.kind, item.textContent]), [
    ['done', 'Claude finished “Add promo codes to checkout”3 min · changed checkout.js and promo.js · ran the tests'],
    ['stopped', 'Codex stopped at a usage limit on “Refactor the payment module”14 min'],
    ['approval', '1 approval waiting for you'],
    ['waiting', 'Waiting for a usage limit to reset; it continues with Claude and Codex'],
    ['git', '3 uncommitted changes in Git'],
  ]);
  const spokenBefore = ui.spoken.length;
  ui.findButton('Read aloud').click();
  const utterances = ui.window.speechSynthesis.utterances.slice(spokenBefore), rows = panel.querySelectorAll('li'), reading = () => rows.map((row, index) => row.classList.contains('reading') ? index : -1).filter(index => index >= 0);
  utterances[1].onstart(); assert.deepEqual(reading(), [0], 'The row being read is highlighted.');
  utterances[0].onend(); assert.equal(ui.$('voice-status').dataset.state, 'speaking');
  utterances[2].onstart(); assert.deepEqual(reading(), [1], 'The highlight moves as reading continues.');
  utterances.at(-1).onstart(); utterances.at(-1).onend(); assert.deepEqual(reading(), [], 'It clears when reading ends.'); assert.equal(ui.$('voice-status').dataset.state, '');
  ui.findButton('Read aloud').click(); const again = ui.window.speechSynthesis.utterances.slice(-utterances.length);
  again[1].onstart(); assert.deepEqual(reading(), [0]);
  ui.$('voice-status-actions').children[0].click(); assert.deepEqual(reading(), [], 'It clears when reading is stopped.');
  again[2].onstart(); assert.deepEqual(reading(), [], 'What was cancelled can not bring it back.');
  assert.equal(ui.spoken.slice(spokenBefore, spokenBefore + utterances.length).join(' '), 'While you were away. In Other workspace: Claude finished “Add promo codes to checkout”, 3 min, changed checkout.js and promo.js, ran the tests. Codex stopped at a usage limit on “Refactor the payment module”, 14 min. 1 approval waiting for you. Waiting for a usage limit to reset; it continues with Claude and Codex.');
  panel.querySelector('.recap-name').click(); await flush();
  assert.equal(panel.hidden, true);
  assert.equal(ui.state().projectId, 'project-two', 'A workspace in the recap opens with one click.');

  // Nothing happened: nothing shows; asked for, it says so.
  recap = { ...recap, workspaces: [] };
  leave(); now += 10 * 60 * 1000; await come();
  assert.equal(panel.hidden, true);
  await ui.window.relayRecap.open(); await flush();
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /Nothing ran while you were away/);
  ui.document.dispatchEvent(new UIEvent('keydown', { key: 'Escape' }));
  assert.equal(panel.hidden, true);
});


test('a run that changed files offers Undo, previews every file before anything changes, then offers Redo', async () => {
  const ui = await browser({ rewindUI: true }), runId = '11111111-1111-4111-8111-111111111111', undoId = '22222222-2222-4222-8222-222222222222';
  const reply = (data, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(data), json: async () => clone(data) });
  const conversation = ui.canonical.get('project-one');
  Object.assign(conversation, { status: 'complete', lastRun: { id: runId, provider: 'codex', status: 'complete' }, checkpoints: { [runId]: { files: 3 } },
    messages: [{ id: 'u1', role: 'user', text: 'Add promo codes', runId, provider: 'codex' }, { id: 'a1', role: 'assistant', text: 'Done.', runId, provider: 'codex', status: 'complete' }] });
  const preview = { target: { kind: 'run', id: runId }, runId, provider: 'codex', prompt: 'Add promo codes', startedAt: new Date().toISOString(), digest: 'digest-1', unchanged: 0, files: [
    { folderId: 'f', folder: 'web', path: 'src/checkout.js', action: 'restore', diff: '@@ -1,2 +1,2 @@\n line one\n-PROMO\n+line two' },
    { folderId: 'f', folder: 'web', path: 'src/promo.js', action: 'remove', diff: '@@ -1 +0,0 @@\n-export const promo = 1;' },
    { folderId: 'f', folder: 'web', path: 'notes.md', action: 'conflict', reason: 'Changed since the run in the same places.' }] };
  let applies = 0, stale = true;
  ui.setIntercept((request, next) => {
    if (request.path === '/api/checkpoints/preview') return reply(request.body.target.kind === 'rewind' ? { ...preview, target: request.body.target, digest: 'digest-redo', files: preview.files.slice(0, 2).map(file => ({ ...file, action: 'restore' })) } : preview);
    if (request.path === '/api/checkpoints/apply') {
      applies++;
      if (stale) { stale = false; return reply({ error: 'Files changed since you reviewed this. Review the changes again.' }, 409); }
      conversation.checkpoints = { [runId]: { files: 3, undone: undoId } };
      conversation.messages.push({ id: 'n1', role: 'system', text: 'Undid Codex’s changes from “Add promo codes”.' });
      return reply({ id: undoId, counts: { restore: 1, remove: 1, merge: 0, recreate: 0 }, left: [{ path: 'notes.md' }] });
    }
    return next();
  });
  await ui.window.relayUI.refresh(); await flush();
  const line = () => ui.document.querySelectorAll('.run-checkpoint')[0];
  assert.equal(line().dataset.runId, runId);
  assert.match(line().textContent, /3 files changed/);
  line().querySelectorAll('button')[0].click(); await flush();
  assert.equal(ui.$('rewind-dialog').open, true);
  assert.equal(ui.$('rewind-title').textContent, 'Undo Codex’s changes?');
  assert.equal(ui.$('rewind-summary').textContent, 'This restores 1 file and removes 1 file it added. 1 file stays as it is.');
  assert.equal(ui.document.querySelectorAll('.rewind-file').length, 2);
  assert.match(ui.$('rewind-files').textContent, /notes\.md.*Changed since the run in the same places/);
  assert.equal(applies, 0, 'Opening the preview changes nothing.');
  assert.equal(ui.$('confirm-rewind').disabled, false);

  // Files changed after the preview: the newer preview replaces it, and nothing is applied until confirmed again.
  ui.$('confirm-rewind').click(); await flush();
  assert.equal(applies, 1); assert.equal(ui.$('rewind-dialog').open, true);
  assert.match(ui.$('rewind-error').textContent, /updated preview/);
  ui.$('confirm-rewind').click(); await flush();
  const apply = ui.requests.filter(request => request.path === '/api/checkpoints/apply').at(-1);
  assert.deepEqual(apply.body, { target: { kind: 'run', id: runId }, digest: 'digest-1' }); assert.equal(apply.projectId, 'project-one');
  assert.equal(ui.$('rewind-dialog').open, false);
  assert.match(line().textContent, /Changes undone/);
  assert.equal(line().querySelectorAll('button')[0].textContent, 'Redo');

  line().querySelectorAll('button')[0].click(); await flush();
  assert.deepEqual(ui.requests.filter(request => request.path === '/api/checkpoints/preview').at(-1).body, { target: { kind: 'rewind', id: undoId } });
  assert.equal(ui.$('rewind-title').textContent, 'Redo Codex’s changes?');
  assert.equal(ui.$('rewind-summary').textContent, 'This puts back 2 files as the run left them.');
  ui.$('cancel-rewind').click(); assert.equal(ui.$('rewind-dialog').open, false);

  // While a run works, nothing can be undone.
  Object.assign(conversation, { status: 'running', activeRun: { id: 'other-run', provider: 'codex' } });
  await ui.window.relayUI.refresh(); await flush();
  assert.equal(line().querySelectorAll('button')[0].disabled, true);
});

test('alerts play their sound once, only when allowed, and Settings chooses which sounds play', async () => {
  const ui = await browser({ workbench: true, alertsUI: true });
  // A stand-in for Web Audio that records each tone's pitch.
  const tones = [];
  ui.window.AudioContext = class { constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { return { type: '', frequency: { setValueAtTime: value => tones.push(value) }, connect() {}, start() {}, stop() {} }; } };
  const alert = detail => ui.window.dispatchEvent(new UIEvent('relay-alert', { detail }));
  alert({ id: 'one', sound: 'finished', volume: 70, background: false, kind: 'finished' });
  assert.deepEqual(tones, [659.25, 1318.5, 987.77, 1975.54], 'Two notes, each with a soft octave above.');
  alert({ id: 'one', sound: 'finished', volume: 70, background: false, kind: 'finished' });
  assert.equal(tones.length, 4, 'The same alert plays once, even with several tabs open.');
  ui.document.hasFocus = () => true; ui.document.visibilityState = 'visible';
  alert({ id: 'two', sound: 'attention', volume: 70, background: true, kind: 'approval' });
  assert.equal(tones.length, 4, 'Only when Codeshi isn’t in front: nothing plays while it is.');
  ui.document.hasFocus = () => false;
  alert({ id: 'three', sound: 'attention', volume: 70, background: true, kind: 'approval' });
  assert.deepEqual(tones.slice(4, 6), [880, 1760]);
  alert({ id: 'four', sound: 'chime', volume: 70 }); alert({ id: 'five', sound: 'stopped', volume: 0 });
  assert.equal(tones.length, 10, 'An unknown sound or no volume plays nothing.');

  const { posts } = alertSettings(ui);
  await ui.window.relaySettings.open('alerts'); await flush();
  assert.equal(ui.$('settings-title').textContent, 'Alerts');
  assert.deepEqual(ui.document.querySelectorAll('tr').map(row => row.dataset.channel).filter(Boolean), ['sound'], 'In a browser, only sounds apply.');
  assert.equal(ui.document.querySelectorAll('p').some(line => line.textContent === 'Banners and the Dock icon are part of the desktop app.'), true);
  const master = ui.labelledInput('Sound'), box = label => ui.document.querySelectorAll('input').find(input => input.getAttribute('aria-label') === label);
  assert.equal(master.checked, false); assert.equal(box('Sound when a task finishes').disabled, true, 'Each moment waits for sounds to be turned on, keeping its choice.');
  master.checked = true; master.dispatchEvent(new UIEvent('change')); await flush();
  const finished = box('Sound when a task finishes');
  assert.equal(finished.disabled, false);
  finished.checked = false; finished.dispatchEvent(new UIEvent('change')); await flush();
  assert.deepEqual(posts, [{ sound: { on: true } }, { sound: { finished: false } }]);
  const before = tones.length;
  ui.document.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Play the Stopped sound').click();
  assert.deepEqual(tones.slice(before), [493.88, 987.76, 369.99, 739.98], 'Play lets you hear each sound first.');
});

// A stand-in for the saved alert settings, which records each change and keeps it the way the server does.
function alertSettings(ui) {
  const every = { attention: true, finished: true, stopped: true }, posts = [];
  let saved = { banner: { on: true, ...every, panel: false }, sound: { on: false, ...every, volume: 70, background: false }, bounce: { on: true, ...every }, badge: { on: true, ...every }, statusItem: true };
  const reply = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => clone(data) });
  ui.setIntercept((request, next) => {
    if (request.path !== '/api/notifications') return next();
    if (request.method === 'POST') { posts.push(clone(request.body)); for (const [key, value] of Object.entries(request.body)) saved = { ...saved, [key]: typeof value === 'object' ? { ...saved[key], ...value } : value }; }
    return reply(saved);
  });
  return { posts, saved: () => saved };
}

test('Alerts in Settings turn each way on or off for each moment, with the banner style and the menu bar status in the Mac app', async () => {
  const ui = await browser({ workbench: true, alertsUI: true, desktop: true, desktopControls: true }), { posts, saved } = alertSettings(ui);
  await ui.window.relaySettings.open('preferences', 'Alerts'); await flush();
  const rows = ui.document.querySelectorAll('tr').filter(row => row.dataset.channel);
  assert.deepEqual(rows.map(row => [row.dataset.channel, row.querySelectorAll('th')[0].textContent, row.querySelectorAll('input').map(input => input.checked)]), [
    ['banner', 'Banner', [true, true, true, true]], ['sound', 'Sound', [false, true, true, true]], ['bounce', 'Bounce the Dock icon', [true, true, true, true]], ['badge', 'Badge on the Dock icon', [true, true, true, true]],
  ]);
  assert.deepEqual(ui.document.querySelectorAll('th').filter(column => column.scope === 'col').map(column => [column.textContent, column.title]), [['Needs you', 'An approval, a question or a handoff offer'], ['Finished', 'A task finishes, or continues by itself after a usage limit'], ['Stopped', 'An error, a usage limit or failing tests']]);
  const box = label => ui.document.querySelectorAll('input').find(input => input.getAttribute('aria-label') === label);
  // A way turned off keeps its moments for when it is turned back on.
  const bounce = box('Bounce the Dock icon when a task finishes'); bounce.checked = false; bounce.dispatchEvent(new UIEvent('change')); await flush();
  const banner = ui.labelledInput('Banner'); banner.checked = false; banner.dispatchEvent(new UIEvent('change')); await flush();
  assert.equal(box('Banner when an agent needs you').disabled, true); assert.equal(box('Banner when an agent needs you').checked, true);
  assert.equal(ui.document.querySelectorAll('tr').find(row => row.dataset.channel === 'banner').dataset.off, '');
  const again = ui.labelledInput('Banner'); again.checked = true; again.dispatchEvent(new UIEvent('change')); await flush();
  ui.findButton('Panel at the top of the screen').click(); await flush();
  assert.equal(ui.findButton('Panel at the top of the screen').getAttribute('aria-pressed'), 'true');
  const status = ui.labelledInput('Show what agents are doing in the menu bar'); status.checked = false; status.dispatchEvent(new UIEvent('change')); await flush();
  assert.deepEqual(posts, [{ bounce: { finished: false } }, { banner: { on: false } }, { banner: { on: true } }, { banner: { panel: true } }, { statusItem: false }]);
  assert.deepEqual([saved().bounce.finished, saved().banner.panel, saved().statusItem], [false, true, false]);
  // The menus' Alert Settings… opens this section, even with Settings already open on another tab.
  await ui.window.relaySettings.open('accounts'); ui.menu('alert-settings'); await flush();
  assert.equal(ui.$('settings-title').textContent, 'Alerts');
});

test('steps are coloured by kind, changed files show their line counts, and a cut-off Write still names its file', async () => {
  const ui = await browser();
  const conversation = ui.canonical.get('project-one'), runId = 'run-colours', step = (id, text) => ({ id, runId, role: 'activity', provider: 'claude', text });
  Object.assign(conversation, { status: 'complete', lastRun: { id: runId, provider: 'claude', status: 'complete' }, messages: [
    { id: 'u1', runId, role: 'user', text: 'Add promo codes', provider: 'claude' },
    step('s1', 'Read\n{"file_path":"src/checkout.js"}'),
    step('s2', 'Bash\n{"command":"npm test","description":"Run the tests"}\n24 passing'),
    step('s3', 'Edit\n{"file_path":"src/checkout.js","old_string":"a\\nb\\nc","new_string":"a\\nX\\nc\\nd"}\nThe file has been updated.'),
    step('s4', 'Write\n{"file_path":"src/promo.js","content":"one\\ntwo\\n"}\nFile created successfully at: src/promo.js'),
    step('s5', 'Write\n{"file_path":"src/generated.js","content":"line 1\\nline 2\\nline\n[Output shortened; inspect project files for the full state.]'),
    step('s6', 'File changes: [{"path":"api/new.js","kind":{"type":"add"},"diff":"x\\ny\\n"},{"path":"api/old.js","kind":"delete"}]'),
    step('s7', 'File changes: [{"path":"api/a.js","kind":{"type":"add"}},{"path":"api/b.js","kind":"add","added":4,"removed":0}]'),
    { id: 'a1', runId, role: 'assistant', provider: 'claude', text: 'Done.', status: 'complete' },
  ] });
  await ui.window.relayUI.refresh(); await flush();
  const target = row => row.querySelectorAll('.activity-file-row').map(file => file.querySelector('.activity-file').textContent + (file.querySelector('.activity-file-counts')?.textContent || '')).join(', ') || row.querySelector('.activity-entry-detail')?.textContent;
  const rows = ui.document.querySelectorAll('.activity-entry').map(row => [row.dataset.tone || '', row.querySelectorAll('.activity-entry-title')[0]?.textContent, target(row)]);
  assert.deepEqual(rows, [
    ['read', 'Read', 'src/checkout.js'], ['run', 'Run', 'Run the tests'], ['edit', 'Edit', 'src/checkout.js+2−1'], ['add', 'Create', 'src/promo.js+2'],
    ['edit', 'Write', 'src/generated.js'], ['edit', 'Edit', 'api/new.js+2, api/old.js'], ['add', 'Create', 'api/a.js, api/b.js+4'],
  ]);
  const deleted = ui.document.querySelectorAll('.activity-file').find(file => file.textContent === 'api/old.js');
  assert.equal(deleted.dataset.change, 'delete'); assert.equal(deleted.title, 'Deleted: api/old.js');
  // An opened edit shows its removed and added lines in their colours.
  const edit = ui.document.querySelectorAll('.activity-entry').find(row => row.querySelectorAll('.activity-entry-title')[0]?.textContent === 'Edit');
  edit.querySelectorAll('button')[0].click(); await flush();
  assert.deepEqual(edit.querySelectorAll('.activity-diff').map(line => [line.className, line.textContent.trim()]), [['activity-diff', 'a'], ['activity-diff removed', '- b'], ['activity-diff added', '+ X'], ['activity-diff', 'c'], ['activity-diff added', '+ d']]);
});

test('a long path outside the workspace keeps its file name in view, with the full path on the step', async () => {
  const ui = await browser(), c = ui.canonical.get('project-one'), runId = 'outside-run', describe = text => ui.window.relayUI.describeActivity(text);
  // An agent's own scratch file, far outside the project.
  const scratch = '/private/tmp/claude-501/-Users-pat-Projects-acme/691bf325-a87d-4d75-a7d1-4c38cee24c68/scratchpad/palette/after/hero-graphite.png';
  assert.equal(describe(`Read\n{"file_path":"${scratch}"}`).detail, '…/after/hero-graphite.png');
  assert.equal(describe('Read\n{"file_path":"/etc/hosts"}').detail, '/etc/hosts', 'a short path stays whole');
  assert.equal(describe(`Read\n{"file_path":"/Users/pat/notes/${'a-very-long-folder-name'.repeat(3)}/todo.md"}`).detail, '…/todo.md', 'a folder too long to show drops out');
  assert.equal(describe('Read\n{"file_path":"C:\\\\Users\\\\pat\\\\AppData\\\\Local\\\\Temp\\\\shot.png"}').detail, '…\\Temp\\shot.png');
  Object.assign(c, { status: 'complete', lastRun: { id: runId, provider: 'claude', status: 'complete' }, messages: [
    { id: 'u', runId, role: 'user', text: 'Check the screenshot.', provider: 'claude' },
    { id: 'r', runId, role: 'activity', provider: 'claude', text: `Read\n{"file_path":"${scratch}"}` },
    { id: 'w', runId, role: 'activity', provider: 'claude', text: `Write\n{"file_path":"${scratch.replace('hero-graphite.png', 'shots.mjs')}","content":"x\\n"}\nFile created successfully` },
  ] });
  await ui.window.relayUI.refresh(); await flush();
  const read = ui.document.querySelectorAll('.activity-entry')[0].querySelector('.activity-entry-detail');
  assert.equal(read.textContent, '…/after/hero-graphite.png');
  assert.equal(read.title, scratch, 'pointing at the step shows where the file is');
  const written = ui.document.querySelector('.activity-file');
  assert.deepEqual([written.querySelector('.activity-file-directory').textContent, written.querySelector('.activity-file-name').textContent], ['…/after/', 'shots.mjs']);
  assert.match(written.title, /scratchpad\/palette\/after\/shots\.mjs$/);
});

test('what the agent says carries its agent, and changed files list one per line with their folder, name and counts', async () => {
  const ui = await browser(), c = ui.canonical.get('project-one'), runId = 'readable-run';
  const change = (path, kind, added = 0, removed = 0) => ({ path, kind, added, removed });
  const many = Array.from({ length: 7 }, (_, index) => change(`src/module-${index + 1}.js`, 'update', 1));
  c.status = 'running'; c.activeRun = { id: runId, provider: 'codex' };
  c.messages = [
    { id: 'task', runId, role: 'user', text: 'Update both settings modules.' },
    { id: 'note', runId, role: 'assistant', provider: 'codex', text: 'I found the two settings modules.', status: 'complete' },
    { id: 'files', runId, role: 'activity', provider: 'codex', text: `File changes: ${JSON.stringify([change('web/settings.js', 'update', 3, 1), change('api/settings.js', 'add', 4), change('api/legacy.js', 'delete')])}` },
    { id: 'many', runId, role: 'activity', provider: 'codex', text: `File changes: ${JSON.stringify(many)}` },
    { id: 'local', runId, role: 'assistant', provider: 'codex', connection: 'local', text: 'Checked with the local model.', status: 'complete' },
  ];
  await ui.window.relayUI.refresh();
  // The dot beside what the agent says takes the agent's colour; a local model has its own.
  assert.deepEqual(ui.document.querySelectorAll('.message-assistant').map(message => message.dataset.provider), ['codex', 'local']);
  const [files, more] = ui.document.querySelectorAll('.activity-entry-files');
  assert.deepEqual(files.querySelectorAll('.activity-file-row').map(row => [row.querySelector('.activity-file-directory').textContent, row.querySelector('.activity-file-name').textContent, row.querySelector('.activity-file-counts')?.textContent || '', row.querySelector('.sr-only')?.textContent || '']), [
    ['web/', 'settings.js', '+3−1', ''], ['api/', 'settings.js', '+4', '(added)'], ['api/', 'legacy.js', '', '(deleted)'],
  ]);
  // Every file is already on its line, so the step has nothing more to open; Copy still copies the paths.
  assert.equal(files.querySelector('.activity-output'), null);
  assert.equal(files.querySelector('.activity-output-toggle').tagName, 'DIV');
  assert.equal(ui.window.relayUI.describeActivity(c.messages[2].text).copy, 'web/settings.js\napi/settings.js\napi/legacy.js');
  // Past six files, the rest are counted and the step opens to list them all, and stays open as the run goes on.
  assert.equal(more.querySelectorAll('.activity-file').length, 6);
  assert.equal(more.querySelector('.activity-files-more').textContent, 'and 1 more');
  more.querySelector('.activity-output-toggle').click();
  c.messages.push({ id: 'next', runId, role: 'assistant', provider: 'codex', text: 'Now checking the callers.', status: 'streaming' });
  await ui.window.relayUI.refresh();
  const output = ui.document.querySelectorAll('.activity-entry-files')[1].querySelector('.activity-output');
  assert.equal(output.hidden, false);
  assert.equal(output.textContent.split('\n').length, 7);
});

test('command summaries remove shell wrappers while preserving exact commands and output in details', async () => {
  const ui = await browser(), c = ui.canonical.get('project-one');
  const command = `/bin/zsh -lc 'rg -n "review" src/server.mjs && sed -n "1,20p" src/broker.mjs'`;
  const raw = '$ ' + command + '\nFound the review route.';
  c.messages = [{ id: 'task', role: 'user', runId: 'shell-run', text: 'Find the route' }, { id: 'shell', role: 'activity', runId: 'shell-run', text: raw }];
  await ui.window.relayUI.refresh();
  const entry = ui.document.querySelector('.activity-entry'), detail = entry.querySelector('.activity-entry-detail');
  assert.equal(detail.textContent, 'rg -n "review" src/server.mjs && sed -n "1,20p" src/broker.mjs');
  assert.equal(detail.title, command);
  entry.querySelector('.activity-output-toggle').click();
  assert.equal(entry.querySelector('.activity-output').textContent, raw);
  assert.equal(ui.window.relayUI.describeActivity(raw).cmd, command);
  assert.equal(ui.window.relayUI.describeActivity('$ npm test').detail, 'npm test');
  assert.equal(ui.window.relayUI.describeActivity('Bash\n{"command":"/bin/sh -c \\\"npm test\\\"","description":"Check the unit tests"}').detail, 'Check the unit tests');
});

test('a changed image opens as pictures, before and after, instead of a binary note', async () => {
  const ui = await browser({ insights: true, wide: true }); await flush();
  const reply = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => clone(data) });
  ui.setIntercept((request, next) => request.path === '/api/git/diff' ? reply({ folderId: 'frontend', path: 'app.js', code: ' M', diff: 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n', truncated: false,
    images: { before: { src: 'data:image/png;base64,AAAA', bytes: 2048 }, after: { bytes: 6 * 1024 * 1024, tooLarge: true } } }) : next());
  ui.$('open-git').click(); await flush();
  ui.document.querySelectorAll('.git-file')[0].click(); await flush();
  const figures = ui.document.querySelectorAll('.diff-image');
  assert.equal(figures.length, 2);
  assert.equal(figures[0].querySelectorAll('img')[0].src, 'data:image/png;base64,AAAA');
  assert.match(figures[0].textContent, /Before.*2 KB/);
  assert.match(figures[1].textContent, /Too large to preview.*After.*6\.0 MB/);
  assert.doesNotMatch(ui.$('diff-content').textContent, /Binary file changed/);
});

test('the message box grows a pixel past its text and only scrolls at its full height', async () => {
  const ui = await browser(); await flush();
  const input = ui.$('message-input'), type = (text, height) => { input.value = text; input.scrollHeight = height; ui.fire('message-input', 'input'); };
  // Three lines measure 81.1px, which scrollHeight reports as 81.
  type('one\ntwo\nthree', 81);
  assert.equal(input.style.height, '82px');
  assert.equal(input.style.overflowY, 'hidden');
  type('a long message\n'.repeat(20), 320);
  assert.equal(input.style.height, '200px');
  assert.equal(input.style.overflowY, 'auto');
  type('', 20);
  assert.equal(input.style.height, '64px');
  assert.equal(input.style.overflowY, 'hidden');
});

// An agent's two questions, as the broker lists them with the approvals: the first suggests an option, the second
// allows several, and both take your own words.
const agentQuestion = () => ({ id: 'ask-1', kind: 'question', runId: 'run-one', provider: 'claude', questions: [
  { id: 'q1', header: 'Library', question: 'Which library should we use for dates?', multiple: false, other: true, secret: false, options: [{ label: 'date-fns (Recommended)', description: 'Small and tree-shakeable', recommended: true }, { label: 'Luxon', description: 'Time zones built in', recommended: false }] },
  { id: 'q2', header: 'Storage', question: 'Where should sessions be kept?', multiple: true, other: true, secret: false, options: [{ label: 'Cookies', description: '', recommended: false }, { label: 'Local storage', description: '', recommended: false }] },
] });
async function askedUI(question = agentQuestion()) {
  const ui = await browser({ workbench: true, questionsUI: true, insights: true }), conversation = ui.canonical.get('project-one'), answers = [];
  ui.setIntercept((request, next) => { if (!request.path.endsWith('/answer')) return next(); answers.push(request.body); conversation.pendingApprovals = []; return response({ resolved: true }); });
  const now = new Date().toISOString();
  Object.assign(conversation, { status: 'running', activeRun: { id: 'run-one', provider: 'claude', startedAt: now, lastEventAt: now }, pendingApprovals: [question] });
  await ui.window.relayUI.refresh(); await flush();
  const card = ui.$('pending-approvals').querySelectorAll('article')[0], groups = () => card.querySelectorAll('.question');
  const choice = (index, value) => groups()[index].querySelectorAll('input').find(input => input.value === value && input.type !== 'text');
  const own = index => groups()[index].querySelectorAll('.question-own')[0];
  const button = text => card.querySelectorAll('button').find(node => node.textContent === text);
  const key = (target, value) => card.dispatchEvent(new UIEvent('keydown', { key: value, target }));
  return { ui, card, answers, choice, own, button, key };
}

test('a Codex async question preserves selections when work finishes and adds its answer beside an existing draft', async () => {
  const question = { ...agentQuestion(), provider: 'codex', blocking: false };
  question.questions = [question.questions[0]];
  const { ui, card, choice, button, key } = await askedUI(question);
  key(choice(0, 'Luxon'), '2');
  const c = ui.canonical.get('project-one');
  c.status = 'complete'; c.activeRun = null;
  await ui.window.relayUI.refresh(); await flush();
  assert.equal(ui.$('pending-approvals').querySelector('article'), card, 'Completion must not replace a half-answered question.');
  assert.equal(choice(0, 'Luxon').checked, true);
  assert.match(card.textContent, /can keep working while you answer/);
  ui.$('message-input').value = 'My existing draft';
  ui.setIntercept((request, next) => {
    if (!request.path.endsWith('/answer')) return next();
    assert.deepEqual(request.body.answers, [['Luxon']]);
    c.pendingApprovals = [];
    return response({ resolved: true, draft: 'Answered:\nWhich library should we use for dates? → Luxon' });
  });
  const before = ui.requests.filter(request => request.path.endsWith('/messages')).length;
  button('Send answer').click(); await flush(); await flush();
  assert.equal(ui.$('message-input').value, 'My existing draft\n\nAnswered:\nWhich library should we use for dates? → Luxon');
  assert.ok([...ui.storage.entries()].some(([key, value]) => key.endsWith(`draft:${c.id}`) && value === ui.$('message-input').value));
  assert.equal(ui.requests.filter(request => request.path.endsWith('/messages')).length, before, 'A prepared answer is not an automatic new run.');
  assert.equal(ui.$('pending-approvals').children.length, 0);
});

test('an agent’s questions show one at a time with their choices, the suggested one marked, and your own answer', async () => {
  const { ui, card, answers, choice, own, button, key } = await askedUI();
  const shown = () => card.querySelectorAll('.question').map(field => !field.hidden), tabs = () => card.querySelectorAll('.question-tab');
  assert.equal(card.dataset.approvalId, 'ask-1');
  assert.equal(card.querySelectorAll('h3')[0].textContent, 'Claude has 2 questions');
  assert.deepEqual(tabs().map(tab => [tab.textContent, tab.getAttribute('aria-selected')]), [['Library', 'true'], ['Storage', 'false']], 'Several questions get their headers as tabs.');
  assert.deepEqual(shown(), [true, false], 'One question shows at a time.');
  assert.deepEqual(card.querySelectorAll('.question-option-label').map(node => node.textContent), ['date-fnsRecommended', 'Luxon', 'Cookies', 'Local storage'], 'The suggested option shows a badge instead of its "(Recommended)".');
  assert.deepEqual([choice(0, 'Luxon').type, choice(1, 'Cookies').type], ['radio', 'checkbox']);
  assert.deepEqual([button('Next')?.disabled, button('Submit')], [true, undefined], 'Next waits for an answer to this question.');
  // A number key makes a single choice and moves on to the question still without an answer.
  key(choice(0, 'Luxon'), '2');
  assert.equal(choice(0, 'Luxon').checked, true);
  assert.deepEqual(shown(), [false, true]);
  assert.equal(tabs()[0].classList.contains('answered'), true);
  // Its tab goes back, and one choice replaces another.
  tabs()[0].click(); key(choice(0, 'Luxon'), '1');
  assert.deepEqual([choice(0, 'date-fns (Recommended)').checked, choice(0, 'Luxon').checked], [true, false]);
  assert.deepEqual(shown(), [false, true]);
  // Several can be chosen in the second, and typing your own answer chooses it; number keys stay in the text.
  const cookies = choice(1, 'Cookies'); cookies.checked = true; cookies.dispatchEvent(new UIEvent('change'));
  own(1).value = 'A signed token'; own(1).dispatchEvent(new UIEvent('input'));
  key(own(1), '2');
  assert.equal(choice(1, 'Local storage').checked, false);
  assert.equal(button('Submit').disabled, false, 'With every question answered, Next becomes Submit.');
  button('Submit').click(); await flush();
  assert.deepEqual(answers, [{ runId: 'run-one', questionId: 'ask-1', answers: [['date-fns (Recommended)'], ['Cookies', 'A signed token']] }]);
  assert.equal(ui.$('pending-approvals').querySelectorAll('article').length, 0, 'The answered card goes away.');
});

test('skipping an agent’s question lets it decide, Enter submits, and the status says it waits for your answer', async () => {
  const one = agentQuestion(); one.questions = one.questions.slice(0, 1);
  const { ui, card, answers, choice, button, key } = await askedUI(one);
  assert.equal(card.querySelectorAll('h3')[0].textContent, 'Claude has a question');
  assert.equal(ui.$('conversation-state').lastElementChild.textContent, 'Question for you');
  assert.equal(ui.$('run-action').textContent, 'Waiting for your answer');
  key(choice(0, 'Luxon'), 'Enter');
  assert.equal(answers.length, 0, 'Enter does nothing until each question has an answer.');
  key(choice(0, 'Luxon'), '1'); key(choice(0, 'date-fns (Recommended)'), 'Enter'); await flush();
  assert.deepEqual(answers, [{ runId: 'run-one', questionId: 'ask-1', answers: [['date-fns (Recommended)']] }]);
  ui.canonical.get('project-one').pendingApprovals = [one]; await ui.window.relayUI.refresh(); await flush();
  const again = ui.$('pending-approvals').querySelectorAll('article')[0];
  again.querySelectorAll('button').find(node => node.textContent === 'Skip').click(); await flush();
  assert.deepEqual(answers[1], { runId: 'run-one', questionId: 'ask-1', skip: true });
  assert.equal(button('Skip').title, 'Claude continues with its own judgement');
});

test('a run shows what an agent asked and what you answered or skipped', async () => {
  const ui = await browser(), conversation = ui.canonical.get('project-one'), runId = 'run-asked', step = (id, text) => ({ id, runId, role: 'activity', provider: 'claude', text });
  Object.assign(conversation, { status: 'complete', lastRun: { id: runId, provider: 'claude', status: 'complete' }, messages: [
    { id: 'u1', runId, role: 'user', text: 'Add sessions', provider: 'claude' },
    step('s1', 'AskUserQuestion\n{"questions":[{"header":"Library","question":"Which library should we use for dates?","options":[{"label":"Luxon","description":""}],"multiSelect":false}]}\nUser has answered your questions.'),
    step('s2', 'Answered:\nWhich library should we use for dates? → Luxon'),
    step('s3', 'AskUserQuestion\n{"questions":[{"header":"Library","question":"Which library?"},{"header":"Storage","question":"Where?"}]}'),
    step('s4', 'Skipped 2 questions; the agent continues on its own judgement.'),
    { id: 'a1', runId, role: 'assistant', provider: 'claude', text: 'Done.', status: 'complete' },
  ] });
  await ui.window.relayUI.refresh(); await flush();
  const rows = ui.document.querySelectorAll('.activity-entry').map(row => [row.querySelectorAll('.activity-entry-title')[0]?.textContent, row.querySelectorAll('.activity-entry-detail')[0]?.textContent, row.querySelectorAll('.activity-icon')[0]?.className]);
  assert.deepEqual(rows, [
    ['Asked', 'Which library should we use for dates?', 'activity-icon icon-question'],
    ['You answered', 'Luxon', 'activity-icon icon-question'],
    ['Asked 2 questions', 'Library · Storage', 'activity-icon icon-question'],
    ['You skipped 2 questions', 'The agent decides', 'activity-icon icon-question'],
  ]);
});

test('several folders can be chosen at once and added to a workspace in one go', async () => {
  const ui = await browser({ moreProjects: true, desktop: true }), chatId = ui.state().conversation.id;
  const adds = () => ui.requests.filter(request => request.path === '/api/projects/project-one/folders' && request.method === 'POST');
  ui.findButton('Add folder').click();
  assert.equal(ui.$('save-folder-label').textContent, 'Add folder');
  ui.$('folder-path').value = '/workspace/shared'; ui.fire('folder-path', 'input');
  ui.pickedFolders.push(['/workspace/docs', '/workspace/shared', '/workspace/infra']); ui.$('pick-add-folder').click(); await flush();
  assert.equal(ui.$('folder-path').value, '/workspace/shared\n/workspace/docs\n/workspace/infra', 'Each chosen folder joins the list once.');
  assert.equal(ui.$('save-folder-label').textContent, 'Add 3 folders');
  ui.fire('folder-form', 'submit'); await flush();
  assert.deepEqual(adds().map(request => request.body), [{ folders: ['/workspace/shared', '/workspace/docs', '/workspace/infra'] }], 'All of them go in one request.');
  assert.equal(ui.projects[0].folders.length, 5);
  assert.equal(ui.state().conversation.id, chatId, 'The same conversation stays open.');
  assert.deepEqual([ui.$('folder-panel').hidden, ui.$('folder-path').value, ui.$('save-folder-label').textContent], [true, '', 'Add folder']);
  // One line that isn't a folder path stops the whole list.
  ui.findButton('Add folder').click(); ui.$('folder-path').value = '/workspace/api\nrelative/path'; ui.fire('folder-form', 'submit'); await flush();
  assert.match(ui.$('folder-error').textContent, /one per line/);
  assert.equal(adds().length, 1);
});

test('with several folders, Run lists each command under the folder it runs in, says where the selected one runs, and adds one in a folder', async () => {
  const ui = await browser({ commandsUI: true, desktop: true }), save = body => ui.window.relayUI.post('/api/commands/save', body, 'project-one');
  await save({ name: 'api', command: 'npm run dev', folderId: 'backend', directory: '' });
  await save({ name: 'site', command: 'npm run dev', folderId: 'frontend', directory: '' });
  await save({ name: 'ui', command: 'npm run storybook', folderId: 'frontend', directory: 'packages/ui' });
  ui.$('status-run').click(); await flush(); await flush();
  const list = ui.$('command-list'), entries = () => list.children.map(child => child.className === 'run-folder' ? `# ${child.querySelector('.run-folder-name').textContent}` : child.dataset.commandId);
  assert.deepEqual(entries(), ['# Frontend', 'site', 'ui', '# Backend', 'api'], 'Folders in the workspace’s order, each heading the commands that run in it.');
  assert.deepEqual(list.querySelectorAll('.command-where').map(node => node.textContent), ['packages/ui'], 'A command in a subdirectory says which.');
  // The output bar says where the selected command runs, with its full path on hover.
  list.querySelectorAll('.command-row').find(row => row.dataset.commandId === 'ui').querySelector('.command-pick').click(); await flush(); await flush();
  assert.deepEqual([ui.$('command-place').textContent, ui.$('command-place').title], ['Frontend/packages/ui', 'Runs in /workspace/example/frontend/packages/ui']);
  list.querySelectorAll('.command-row').find(row => row.dataset.commandId === 'api').querySelector('.command-pick').click(); await flush(); await flush();
  assert.equal(ui.$('command-place').textContent, 'Backend');
  // + on a folder's heading opens the form for a command in that folder.
  list.querySelectorAll('.run-folder')[1].querySelector('.run-folder-add').click(); await flush();
  assert.deepEqual([ui.$('command-form').hidden, ui.$('command-folder').value, ui.$('command-form-title').textContent], [false, 'backend', 'Add a command']);
});

function automaticReviewRoutes(ui, intercept) {
  ui.setIntercept((request, next) => {
    if (request.path === '/api/reviews') return response({ repositories: [{ folderId: 'frontend', name: 'Frontend', available: true }, { folderId: 'backend', name: 'Backend', available: true }], reviews: [] });
    if (request.path === '/api/reviews/automatic/preview') return response({ builder: request.body.provider, builderModel: request.body.model || null, reviewer: request.body.provider === 'claude' ? 'codex' : 'claude', model: null, folderIds: request.body.folderIds, folders: ui.projects[0].folders.filter(folder => request.body.folderIds.includes(folder.id)), approvedDigest: 'd'.repeat(64), goal: request.body.text, limits: { files: 12, diffBytes: 72000 } });
    return intercept ? intercept(request, next) : next();
  });
}

async function armAutomaticReview(ui, text = 'Build a safe checkout flow') {
  ui.$('message-input').value = text; ui.fire('message-input', 'input');
  ui.$('automatic-review-toggle').click(); await flush();
  assert.equal(ui.$('automatic-review-dialog').open, true);
  ui.$('automatic-review-enable').click(); await flush();
}

test('automatic review previews the pairing and scope, is billed separately and applies to only the approved send', async () => {
  const ui = await browser({ automaticReviewUI: true, billingSource: { codex: 'subscription', claude: 'api' } }); automaticReviewRoutes(ui);
  ui.$('message-input').value = 'Build the checkout flow'; ui.fire('message-input', 'input');
  ui.$('automatic-review-toggle').click(); await flush();
  assert.match(ui.$('automatic-review-pair').textContent, /Codex.*Claude/);
  assert.equal(ui.$('automatic-review-folders').querySelectorAll('input').length, 2);
  assert.equal(ui.$('automatic-review-billing-label').hidden, false);
  assert.equal(ui.$('automatic-review-enable').disabled, true);
  assert(!ui.requests.some(request => request.path.endsWith('/messages')), 'Preview consumes no agent run.');
  ui.$('automatic-review-billing').checked = true; ui.fire('automatic-review-billing', 'change');
  ui.$('automatic-review-enable').click(); await flush();
  assert.equal(ui.$('automatic-review-armed').hidden, false);
  ui.fire('composer', 'submit'); await flush();
  const send = ui.requests.find(request => request.path.endsWith('/messages'));
  assert.deepEqual(send.body.automaticReview, { approvedDigest: 'd'.repeat(64), folderIds: ['frontend', 'backend'], reviewer: 'claude', model: null, billingConfirmed: true });
  assert.equal(ui.$('automatic-review-armed').hidden, true);
  ui.$('message-input').value = 'Another task'; ui.fire('message-input', 'input'); ui.fire('composer', 'submit'); await flush();
  assert.equal(ui.requests.filter(request => request.path.endsWith('/messages'))[1].body.automaticReview, undefined);
  assert(ui.requests.filter(request => request.path.startsWith('/api/reviews')).every(request => request.projectId === 'project-one'));
});

test('automatic review needs renewed approval after a changed task or model and never follows a draft into another workspace', async () => {
  const ui = await browser({ automaticReviewUI: true, moreProjects: true }); automaticReviewRoutes(ui);
  await armAutomaticReview(ui);
  ui.$('message-input').value = 'A materially different task'; ui.fire('message-input', 'input'); ui.fire('composer', 'submit'); await flush();
  assert(!ui.requests.some(request => request.path.endsWith('/messages')));
  assert.match(ui.$('notice-text').textContent, /Confirm Review after again/);
  assert.equal(ui.$('automatic-review-armed').dataset.stale, 'true');
  ui.$('automatic-review-toggle').click(); await flush(); ui.$('automatic-review-enable').click(); await flush();
  await ui.window.relayUI.setConfiguration({ model: 'model-two' });
  ui.fire('composer', 'submit'); await flush();
  assert(!ui.requests.some(request => request.path.endsWith('/messages')));
  await ui.switchProject('project-two'); assert.equal(ui.$('automatic-review-armed').hidden, true);
  ui.$('message-input').value = 'Only the other workspace'; ui.fire('message-input', 'input'); ui.fire('composer', 'submit'); await flush();
  const send = ui.requests.find(request => request.path.endsWith('/messages'));
  assert.equal(send.projectId, 'project-two'); assert.equal(send.body.automaticReview, undefined);
});

test('automatic review keeps its consent and request identity after an accepted-send response is lost', async () => {
  const ui = await browser({ automaticReviewUI: true }); let lost = false;
  automaticReviewRoutes(ui, (request, next) => { const value = next(); if (request.path.endsWith('/messages') && !lost) { lost = true; throw Error('Response lost after acceptance.'); } return value; });
  await armAutomaticReview(ui); ui.fire('composer', 'submit'); await flush();
  assert.equal(ui.$('automatic-review-armed').hidden, false);
  ui.$('notice-retry').click(); await flush();
  const sends = ui.requests.filter(request => request.path.endsWith('/messages'));
  assert.equal(sends.length, 2); assert.equal(sends[0].body.requestId, sends[1].body.requestId);
  assert.deepEqual(sends[0].body.automaticReview, sends[1].body.automaticReview);
  assert.equal(ui.$('automatic-review-armed').hidden, true);
});

test('automatic review binds the exact attachments and saved project context, even when attachment count stays the same', async () => {
  const ui = await browser({ automaticReviewUI: true, filesUI: true }); automaticReviewRoutes(ui);
  await ui.window.relayFiles.addSnapshots([{ name: 'original.md', data: 'b3JpZ2luYWw=' }]); await flush();
  const original = ui.window.relayFiles.ids()[0];
  await armAutomaticReview(ui);
  assert.deepEqual(ui.requests.find(request => request.path === '/api/reviews/automatic/preview').body.attachments, [original]);
  ui.$('attachment-list').querySelector('.attachment-remove').click();
  await ui.window.relayFiles.addSnapshots([{ name: 'different.md', data: 'ZGlmZmVyZW50' }]); await flush();
  assert.equal(ui.window.relayFiles.ids().length, 1); assert.notEqual(ui.window.relayFiles.ids()[0], original);
  assert.equal(ui.$('automatic-review-armed').dataset.stale, 'true');
  ui.fire('composer', 'submit'); await flush(); assert(!ui.requests.some(request => request.path.endsWith('/messages')));
  ui.$('automatic-review-toggle').click(); await flush(); ui.$('automatic-review-enable').click(); await flush();
  ui.canonical.get('project-one').context.goal = 'A different goal for this workspace'; await ui.window.relayUI.refresh();
  assert.equal(ui.$('automatic-review-armed').dataset.stale, 'true');
  ui.fire('composer', 'submit'); await flush(); assert(!ui.requests.some(request => request.path.endsWith('/messages')));
});

test('Settings has its own pages, keeps Ask a friend separate and opens Accounts from a connection action', async () => {
  const ui = await browser({ workbench: true, authenticated: { codex: false, claude: true } });
  const pages = () => ui.$('settings-content').querySelectorAll('.settings-page').filter(section => !section.hidden).map(section => section.dataset.page);
  const navigate = name => { const target = ui.$('settings-nav').querySelectorAll('[data-page]').find(button => button.dataset.page === name); ui.$('settings-nav').dispatchEvent(new UIEvent('click', { target })); };
  ui.$('relay-settings').click(); await flush();
  assert.equal(ui.$('settings').open, true); assert.equal(ui.$('workbench').open, false);
  assert.equal(ui.$('settings-title').textContent, 'General'); assert.deepEqual(pages(), ['general']);
  assert.deepEqual(ui.$('settings-nav').querySelectorAll('[data-page]').map(button => button.textContent), ['General', 'Accounts', 'Alerts', 'Voice']);
  navigate('accounts');
  assert.deepEqual(pages(), ['accounts']); assert.equal(ui.$('settings-title').textContent, 'Accounts');
  assert.equal(ui.$('settings-nav').querySelectorAll('[data-page]').find(button => button.dataset.page === 'accounts').getAttribute('aria-current'), 'page');
  assert.deepEqual(ui.document.querySelectorAll('.settings-account').map(row => row.dataset.provider), ['codex', 'claude', 'gemini']);
  ui.$('settings-close').click(); assert.equal(ui.$('settings').open, false);
  ui.$('ask-friend').click(); await flush();
  assert.equal(ui.$('workbench').open, true); assert.equal(ui.$('settings').open, false);
  assert.match(ui.$('workbench-content').textContent, /Share with a person/); assert.equal(ui.$('workbench-content').querySelectorAll('.settings-row').length, 0);
  ui.$('workbench').close(); ui.$('connection-action').click(); await flush();
  assert.equal(ui.$('settings').open, true); assert.equal(ui.$('settings-title').textContent, 'Accounts');
});

test('Settings searches across pages, restores its page on Escape and handles no matches', async () => {
  const ui = await browser({ workbench: true, alertsUI: true, voiceUI: true, recapUI: true, desktop: true }), { posts } = alertSettings(ui);
  await ui.window.relaySettings.open('accounts'); await flush();
  const visiblePages = () => ui.$('settings-content').querySelectorAll('.settings-page').filter(section => !section.hidden).map(section => section.dataset.page);
  const visibleRows = () => ui.$('settings-content').querySelectorAll('.settings-row').filter(row => !row.hidden).map(row => row.textContent);
  const search = text => { ui.$('settings-search').value = text; ui.fire('settings-search', 'input'); };
  search('sleep');
  assert.deepEqual(visiblePages(), ['general']); assert.equal(visibleRows().length, 1); assert.match(visibleRows()[0], /Keep awake/);
  assert.equal(ui.$('settings-empty').hidden, true);
  search('sound volume');
  assert.deepEqual(visiblePages(), ['alerts']); assert.equal(visibleRows().length, 1); assert.match(visibleRows()[0], /Volume/);
  // Redrawing one module after a saved preference must preserve search results.
  await ui.window.relaySettings.open('alerts'); await flush();
  ui.labelledInput('Sound').checked = true; ui.labelledInput('Sound').dispatchEvent(new UIEvent('change')); await flush();
  assert.deepEqual(posts, [{ sound: { on: true } }]);
  search('sound volume');
  const volume = ui.document.querySelectorAll('input').find(input => input.getAttribute('aria-label') === 'Sound volume');
  volume.value = '35'; volume.dispatchEvent(new UIEvent('change')); await flush();
  assert.deepEqual(visiblePages(), ['alerts']); assert.equal(visibleRows().length, 1); assert.match(visibleRows()[0], /Volume/);
  search('no-such-setting'); assert.deepEqual(visiblePages(), []); assert.equal(ui.$('settings-empty').hidden, false);
  const escape = new UIEvent('keydown', { key: 'Escape' }); ui.$('settings-search').dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(ui.$('settings-search').value, ''); assert.equal(ui.$('settings').open, true); assert.deepEqual(visiblePages(), ['alerts']);
});

test('Settings applies a search again when delayed alert settings arrive', async () => {
  const ui = await browser({ workbench: true, alertsUI: true }), pending = deferred();
  ui.setIntercept((request, next) => request.path === '/api/notifications' ? pending.promise.then(() => response({ banner: { on: true }, sound: { on: false, attention: true, finished: true, stopped: true, volume: 70, background: false }, bounce: { on: false }, badge: { on: false }, statusItem: true })) : next());
  await ui.window.relaySettings.open();
  ui.$('settings-search').value = 'sound volume'; ui.fire('settings-search', 'input');
  assert.equal(ui.$('settings-empty').hidden, false);
  pending.resolve(); await flush();
  const page = ui.$('settings-content').querySelectorAll('.settings-page').find(section => section.dataset.page === 'alerts');
  assert.equal(page.hidden, false); assert.equal(ui.$('settings-empty').hidden, true);
  assert.equal(page.querySelectorAll('.settings-row').filter(row => !row.hidden).length, 1);
});

test('General Settings saves handoff and keep-awake controls and reports a save failure', async () => {
  const ui = await browser({ workbench: true, desktop: true });
  await ui.window.relaySettings.open(); await flush();
  const threshold = () => ui.labelledInput('Offer a handoff near a usage limit'), automatic = () => ui.labelledInput('Hand off automatically');
  assert.equal(threshold().value, '90'); assert.equal(automatic().checked, false);
  threshold().value = '0'; threshold().dispatchEvent(new UIEvent('change')); await flush();
  assert.deepEqual(ui.requests.filter(request => request.path === '/api/handoff-preferences' && request.method === 'POST').at(-1).body, { threshold: 0 }); assert.equal(automatic().disabled, true);
  threshold().value = '80'; threshold().dispatchEvent(new UIEvent('change')); await flush();
  automatic().checked = true; automatic().dispatchEvent(new UIEvent('change')); await flush();
  assert.deepEqual(ui.requests.filter(request => request.path === '/api/handoff-preferences' && request.method === 'POST').at(-1).body, { automatic: true });
  const awake = ui.$('settings-keep-awake'); awake.checked = true; awake.dispatchEvent(new UIEvent('change')); await flush(); assert.deepEqual(ui.awakeChanges, [true]);
  ui.window.dispatchEvent(new UIEvent('desktop-keep-awake', { detail: { enabled: false, active: false, runningCount: 0 } })); assert.equal(ui.$('settings-keep-awake').checked, false);
  ui.setIntercept((request, next) => request.path === '/api/handoff-preferences' && request.method === 'POST' ? response({ error: 'Cannot save handoff settings.' }, 503) : next());
  threshold().value = '95'; threshold().dispatchEvent(new UIEvent('change')); await flush();
  assert.equal(ui.$('settings-error').hidden, false); assert.match(ui.$('settings-error').textContent, /Cannot save/); assert.equal(threshold().value, '80');
});

for (const connection of ['local', 'remote']) test(`Phone settings reveal a new ${connection} QR once without scrolling on status refreshes`, async () => {
  const ui = await browser({ workbench: true }), frames = [], polls = [], scrolls = [];
  const state = { enabled: false, interfaces: [{ name: 'Wi-Fi', address: '192.168.1.10' }], devices: [], remote: { configured: true, enabled: false, devices: [] } };
  let generation = 0;
  ui.window.matchMedia = () => ({ matches: connection === 'local' });
  const create = ui.document.createElement;
  ui.document.createElement = tag => {
    const element = create(tag);
    element.scrollIntoView = options => scrolls.push({ element, options: clone(options) });
    return element;
  };
  ui.setIntercept((request, next) => {
    if (request.path !== '/api/phone') return next();
    if (request.method === 'POST') {
      const selected = request.body.connection === 'remote' ? state.remote : state;
      if (['start', 'invite'].includes(request.body.action)) {
        selected.enabled = true;
        selected.invite = { qr: `data:image/png;base64,qr-${++generation}`, url: 'https://phone.example/#one-use', code: '12345678' };
      }
    }
    return response(state);
  });
  vm.runInNewContext(fs.readFileSync(new URL('../public/phone-access.js', import.meta.url), 'utf8'), {
    window: ui.window, document: ui.document, requestAnimationFrame: fn => frames.push(fn), setInterval: fn => polls.push(fn),
  });
  await ui.window.relaySettings.open('general'); await flush();
  const select = ui.labelledInput('Connection'); select.value = connection; select.dispatchEvent(new UIEvent('change')); await flush();
  const button = text => ui.document.querySelectorAll('button').find(item => item.textContent === text);
  button(connection === 'remote' ? 'Enable remote access' : 'Enable phone access').click(); await flush();
  assert.equal(scrolls.length, 0, 'Wait for the next layout frame before scrolling.');
  while (frames.length) frames.shift()();
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].element.tagName, 'IMG'); assert.equal(scrolls[0].element.isConnected, true);
  assert.equal(scrolls[0].options.block, 'center');
  assert.equal(scrolls[0].options.behavior, connection === 'local' ? 'instant' : 'smooth');
  const selected = connection === 'remote' ? state.remote : state;
  selected.devices.push({ id: 'pending-phone', name: 'Phone', code: '123456', state: 'pending' });
  polls[0](); await flush();
  while (frames.length) frames.shift()();
  for (const image of ui.document.querySelectorAll('img')) image.dispatchEvent(new UIEvent('load'));
  assert.equal(scrolls.length, 1, 'Status redraws and image loads must not pull the user back to the QR.');
  button('New QR code').click(); await flush();
  while (frames.length) frames.shift()();
  assert.equal(scrolls.length, 2, 'Explicitly requesting another QR reveals it again.');
  button('New QR code').click(); await flush(); ui.$('settings').close();
  while (frames.length) frames.shift()();
  assert.equal(scrolls.length, 2, 'A closed Settings dialog must not scroll the page.');
});

test('Accounts connects through the provider flow, preserves a draft and shows failed actions', async () => {
  const ui = await browser({ workbench: true, desktop: true, authenticated: { codex: false, claude: true } });
  ui.$('message-input').value = 'Keep my draft'; ui.fire('message-input', 'input');
  ui.setIntercept((request, next) => request.path === '/api/providers/codex/connect' ? response({ authUrl: 'https://auth.openai.com/fixture', message: 'Finish sign-in in your browser.' }) : next());
  await ui.window.relaySettings.open('accounts'); await flush();
  const card = () => ui.document.querySelectorAll('.settings-account').find(row => row.dataset.provider === 'codex');
  card().querySelectorAll('button').find(button => button.textContent === 'Connect account').click(); await flush();
  assert.match(card().textContent, /Finish sign-in in your browser/);
  card().querySelectorAll('button').find(button => button.textContent === 'Open sign-in page').click(); await flush();
  assert.deepEqual(ui.externalLinks, ['https://auth.openai.com/fixture']); assert.equal(ui.$('message-input').value, 'Keep my draft');
  ui.setIntercept((request, next) => request.path === '/api/providers/codex/connect' ? response({ error: 'Connection unavailable.' }, 503) : next());
  card().querySelectorAll('button').find(button => button.textContent === 'Connect account').click(); await flush();
  assert.equal(ui.$('settings-error').hidden, false); assert.equal(ui.$('settings-error').textContent, 'Connection unavailable.'); assert.equal(ui.$('settings').open, true);
});

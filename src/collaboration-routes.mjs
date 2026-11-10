import nodePath from 'node:path';
import { installAntigravity } from './antigravity-install.mjs';
import {accountStatus,listModels,connectAccount,disconnectAccount,providerUsage} from './providers.mjs';
import {resolveBinary} from './resolve-binary.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const safeDelivery=r=>r&&({requestId:r.requestId,status:r.status,viewURL:r.viewURL,expiresAt:r.expiresAt,lastError:r.lastError,localOnly:r.localOnly});
export async function collaborationRoute({req,res,url,registry,collaboration:c,sharing,configureSharing,body,json}) {
  if(!url.pathname.startsWith('/api/collaboration')&&!url.pathname.startsWith('/api/providers')&&!url.pathname.startsWith('/api/sharing')) return false;
  const method=req.method;
  if(method!=='GET'&&method!=='POST')fail('Unsupported method.',405);
  const input=method==='POST'?await body(req):{};
  const projectId=url.searchParams.get('projectId');
  if(url.pathname==='/api/sharing/config') {json(res,200,method==='POST'?configureSharing(input):{baseUrl:sharing?.baseUrl||null});return true;}
  const providerMatch=url.pathname.match(/^\/api\/providers\/(codex|claude|gemini)\/(account|models|connect|disconnect|usage|install)$/);
  if(providerMatch) {
    const [,provider,action]=providerMatch;
    const workspace=projectId?registry.get(projectId).path:undefined;
    const googleRoot=nodePath.join(registry.dataRoot,'google');
    if(action==='install') { if(provider!=='gemini'||method!=='POST')fail('Use POST to install the Google connection.',405); json(res,200,await installAntigravity(googleRoot)); return true; }
    const options={workspace,googleRoot,bin:resolveBinary(provider,{googleRoot}),refresh:url.searchParams.get('refresh')==='1'};
    if(['connect','disconnect'].includes(action)&&method!=='POST')fail('Use POST.',405);
    json(res,200,await ({account:accountStatus,models:listModels,connect:connectAccount,disconnect:disconnectAccount,usage:providerUsage}[action])(provider,options));return true;
  }
  if(!projectId)fail('Choose a project before using collaboration.');registry.get(projectId);
  const path=url.pathname.replace('/api/collaboration','');let result;
  if(path==='/handoffs'&&method==='GET')result=c.listHandoffs(projectId);
  else if(path==='/solutions'&&method==='GET')result=c.listSolutions(projectId);
  else if(path==='/handoffs/prepare'&&method==='POST')result=await c.prepare(projectId,input.conversationId,input);
  else if(path==='/handoffs/approve'&&method==='POST')result=await c.approve(projectId,input.conversationId,input);
  else if(path==='/handoffs/import'&&method==='POST')result=await c.importRequest(projectId,input.package,{folderMapping:input.folderMapping});
  else if(path==='/solutions/receive'&&method==='POST')result=await c.receiveSolution(projectId,input.solution);
  else {
    const match=path.match(/^\/(handoffs|solutions)\/([a-zA-Z0-9-]+)(?:\/(build|publish|retrieve|revoke|preview|apply|recover|verify|tests|tests\/stop))?$/);
    if(!match)fail('Not found.',404);const [,type,id,action]=match;
    if(!action&&method==='GET')result=type==='handoffs'?c.getHandoff(projectId,id):c.getSolution(projectId,id);
    else if(type==='handoffs'&&method==='POST') {
      if(action==='build')result=await c.buildSolution(projectId,id,input);
      else if(['publish','retrieve','revoke'].includes(action)) {
        if(!sharing)fail('Configure an HTTPS sharing service, or use offline export/import.',503);
        const handoff=c.getHandoff(projectId,id),delivery=sharing.status(id);
        if(handoff.direction!=='outgoing'||handoff.status!=='approved')fail('Approve an outgoing request before sharing it.',409);
        try {
          if(action==='publish')result=safeDelivery(await sharing.publish(handoff.package,{requestId:id,expiresInSeconds:input.expiresInSeconds||604800}));
          if(action==='retrieve') {
            if(!delivery)fail('Publish this request first.');
            const received=await sharing.retrieve(delivery),solutions=[],rejected=[];
            for(const solution of received.solutions) {
              try {solutions.push(await c.receiveSolution(projectId,solution));}
              catch(error) {rejected.push({id:solution.id,error:error.message});}
            }
            result={delivery:safeDelivery(sharing.status(id)),solutions,rejected};
          }
          if(action==='revoke'){if(!delivery)fail('No link exists.');result=safeDelivery(await sharing.revoke(delivery));}
        } finally {const latest=sharing.status(id);if(latest)c.setDelivery(projectId,id,safeDelivery(latest));}
      } else fail('Unsupported request action.',404);
    } else if(type==='solutions') {
      if(action==='preview'&&method==='GET')result=await c.previewSolution(projectId,id);
      else if(method==='POST'&&action==='apply')result=await c.applySolution(projectId,id,input);
      else if(method==='POST'&&action==='recover')result=await c.recoverApplication(projectId,id);
      else if(method==='POST'&&action==='verify')result=await c.verify(projectId,id,input);
      else if(action==='tests')result=method==='GET'?c.testPlan(projectId,id):await c.runTests(projectId,id,input);
      else if(method==='POST'&&action==='tests/stop')result=await c.stopTests(projectId,id);
      else fail('Unsupported solution action.',404);
    } else fail('Unsupported action.',405);
  }
  json(res,200,await result);return true;
}

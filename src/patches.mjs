import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, fileBytes, validateSolution, validateRelativePath, invalid } from './collaboration-format.mjs';
import { currentWorkspace, workspaceSnapshot, restrictWorkspace } from './workspace-layout.mjs';
import { readWorkspaceFile, writeWorkspaceFile } from './workspace-files.mjs';

export function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive:true,mode:0o700});
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
    fs.renameSync(temporary,filename);
    let directory;
    try { directory=fs.openSync(path.dirname(filename),'r'); fs.fsyncSync(directory); } catch(error) { if(!['EINVAL','EPERM','EISDIR','ENOTSUP'].includes(error.code))throw error; }
    finally { if(directory!==undefined)fs.closeSync(directory); }
  } finally {
    if(fd!==undefined)fs.closeSync(fd);
    try {fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

export function textDiff(relative, before, after) {
  if(before===after)return '';
  const oldLines=before===null?[]:before.split('\n');
  const newLines=after===null?[]:after.split('\n');
  return '--- '+(before===null?'/dev/null':'a/'+relative)+'\n+++ '+(after===null?'/dev/null':'b/'+relative)+'\n@@ -'+(oldLines.length?1:0)+','+oldLines.length+' +'+(newLines.length?1:0)+','+newLines.length+' @@\n'+oldLines.map(line=>'-'+line).concat(newLines.map(line=>'+'+line)).join('\n')+'\n';
}
function privateId(value) { if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw invalid('Invalid private record ID.');return value; }
function validateSnapshot(snapshot) {
  if(!snapshot||!(snapshot.content===null||typeof snapshot.content==='string'))throw invalid('Invalid recovery snapshot.');
  if(snapshot.content===null){if(snapshot.sha256!==null||snapshot.encoding!==undefined)throw invalid('Invalid recovery snapshot.');return;}
  let bytes;try{bytes=fileBytes(snapshot,'recovery snapshot');}catch{throw invalid('Invalid recovery snapshot.');}
  if(snapshot.sha256!==sha256(bytes))throw invalid('Recovery snapshot hash does not match.');
}

// What the review screen can say about a binary side of a change (#25). It never shows a binary file as a
// diff, so it names the kind from the file's first bytes, shows images, and flags what deserves a closer look.
const kinds=[
  [[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],'PNG image','image/png'],[[0xff,0xd8,0xff],'JPEG image','image/jpeg'],[[0x47,0x49,0x46,0x38],'GIF image','image/gif'],
  [[0x00,0x00,0x01,0x00],'Icon'],[[0x25,0x50,0x44,0x46],'PDF document'],[[0x50,0x4b,0x03,0x04],'ZIP archive'],[[0x1f,0x8b],'gzip archive'],[[0x00,0x61,0x73,0x6d],'WebAssembly module'],
  [[0x77,0x4f,0x46,0x46],'Web font'],[[0x77,0x4f,0x46,0x32],'Web font'],[[0x00,0x01,0x00,0x00],'Font'],[[0x4f,0x54,0x54,0x4f],'Font'],
  [[0x53,0x51,0x4c,0x69,0x74,0x65,0x20,0x66,0x6f,0x72,0x6d,0x61,0x74,0x20,0x33,0x00],'SQLite database'],
  [[0x7f,0x45,0x4c,0x46],'Linux program',null,true],[[0x4d,0x5a],'Windows program',null,true],[[0xcf,0xfa,0xed,0xfe],'macOS program',null,true],[[0xce,0xfa,0xed,0xfe],'macOS program',null,true],
  [[0xfe,0xed,0xfa,0xcf],'macOS program',null,true],[[0xfe,0xed,0xfa,0xce],'macOS program',null,true],[[0xca,0xfe,0xba,0xbe],'macOS program or Java class',null,true],
];
const textNames=/\.(?:[cm]?[jt]sx?|json|html?|css|scss|less|vue|svelte|md|mdx|txt|ya?ml|toml|ini|cfg|conf|xml|svg|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|gql|lua|pl|r|scala|dart|ex|exs|erl|hs|clj|env|lock|csv|tsv|gradle|properties)$/i;
export function describeFile(file,relative) {
  if(file.content===null)return null;
  const bytes=fileBytes(file,relative),binary=file.encoding!==undefined;
  const info={binary,bytes:bytes.length,sha256:sha256(bytes)};
  if(!binary)return {...info,kind:'Text'};
  const match=kinds.find(([magic])=>magic.every((byte,index)=>bytes[index]===byte));
  const webp=bytes.length>=12&&String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&String.fromCharCode(...bytes.subarray(8,12))==='WEBP';
  const [,kind,mime,program]=webp?[null,'WebP image','image/webp']:match||[null,'Binary file'];
  return {...info,kind,...(mime?{image:'data:'+mime+';base64,'+file.content}:{}),...(program?{program:true}:{}),...(textNames.test(relative)?{textName:true}:{}),
    // An unknown format may be text with a stray NUL or byte; show what reads as text so nothing hides in it.
    ...(!match&&!webp?{readable:new TextDecoder('utf-8').decode(bytes.subarray(0,16*1024)).replace(/\u0000/g,'\u2400')}:{})};
}

export class PatchService {
  constructor({registry,dataRoot}) { this.registry=registry;this.dataRoot=path.resolve(dataRoot); }
  filename(projectId,solutionId) { return path.join(this.dataRoot,'applications',privateId(projectId),privateId(solutionId)+'.json'); }
  getApplication(projectId,solutionId) {
    this.registry.get(projectId);
    const filename=this.filename(projectId,solutionId);
    if(!fs.existsSync(filename))return null;
    const record=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(record.schema!=='ai-relay.recovery'||record.version!==1||record.projectId!==projectId||record.solutionId!==solutionId||!Array.isArray(record.operations)||record.operations.length>128)throw invalid('Invalid recovery checkpoint.');
    for(const operation of record.operations){validateRelativePath(operation.path);validateSnapshot(operation.before);validateSnapshot(operation.after);}
    return record;
  }
  save(record) { atomicJSON(this.filename(record.projectId,record.solutionId),record);return record; }
  checkApproved(solution,baseline) {
    const approved=new Map(baseline.map(file=>[validateRelativePath(file.path),file.sha256]));
    for(const file of solution.patch.files){if(!approved.has(file.path))throw invalid('Patch touches a file that was not approved for this handoff: '+file.path);if(approved.get(file.path)!==file.baseHash)throw invalid('Patch baseline does not match the handoff: '+file.path,409);}
  }
  preview(projectId,input,baseline,{workspace:snapshot}={}) {
    const solution=validateSolution(input);
    this.checkApproved(solution,baseline);
    const workspace=restrictWorkspace(snapshot||currentWorkspace(this.registry,projectId),currentWorkspace(this.registry,projectId));
    const application=this.getApplication(projectId,solution.id);
    const conflicts=[];
    const files=solution.patch.files.map(file=>{
      let current={content:null};
      try {current=readWorkspaceFile(workspace,file.path,{allowMissing:true,binary:true});if(current.sha256!==file.baseHash)conflicts.push({path:file.path,expected:file.baseHash,actual:current.sha256,reason:'File differs from the approved handoff baseline.'});}
      catch(error){current={content:null};conflicts.push({path:file.path,expected:file.baseHash,actual:null,reason:error.message});}
      const operation=file.content===null?'delete':file.baseHash===null?'create':'replace';
      // A change with a binary side has no text diff: it is described side by side instead.
      if(current.encoding!==undefined||file.encoding!==undefined)return {path:file.path,before:null,after:null,operation,diff:'',binary:{before:describeFile(current,file.path),after:describeFile(file,file.path)}};
      return {path:file.path,before:current.content,after:file.content,operation,diff:textDiff(file.path,current.content,file.content)};
    });
    const status=application?.status==='applied'?'applied':application&&application.status!=='prepared'?'recovery-required':conflicts.length?'stale':files.length?'applicable':'instructions';
    return {solutionId:solution.id,integrity:solution.integrity,status,files,conflicts,application};
  }
  async apply(projectId,input,baseline,{approvedIntegrity,workspace:snapshot}={}) {
    const solution=validateSolution(input);
    if(approvedIntegrity!==solution.integrity)throw invalid('Explicit approval of the exact solution integrity is required.');
    return this.registry.withMutation(projectId,'patch',async()=>{
      const existing=this.getApplication(projectId,solution.id);
      if(existing){if(existing.integrity!==solution.integrity)throw invalid('Solution ID conflicts with the saved application.',409);if(existing.status==='applied')return existing;throw invalid('This application already has a recovery checkpoint. Recover it before using a new solution.',409);}
      const preview=this.preview(projectId,solution,baseline,{workspace:snapshot});
      if(preview.status==='stale')throw Object.assign(invalid('Patch is stale; no files were changed.',409),{conflicts:preview.conflicts});
      if(preview.status!=='applicable')throw invalid('This solution has no applicable patch.');
      const workspace=restrictWorkspace(snapshot||currentWorkspace(this.registry,projectId),currentWorkspace(this.registry,projectId));
      const record={schema:'ai-relay.recovery',version:1,projectId,solutionId:solution.id,integrity:solution.integrity,workspace:workspaceSnapshot(workspace),status:'prepared',createdAt:new Date().toISOString(),completed:[],operations:solution.patch.files.map(file=>({path:file.path,before:readWorkspaceFile(workspace,file.path,{allowMissing:true,binary:true}),after:{content:file.content,...(file.encoding?{encoding:file.encoding}:{}),sha256:file.content===null?null:sha256(fileBytes(file)),mode:null}})),conflicts:[]};
      this.save(record); // The durable copy exists before the first workspace write.
      try {
        record.status='applying';this.save(record);
        for(const operation of record.operations){writeWorkspaceFile(workspace,operation.path,operation.after.content,{expectedHash:operation.before.sha256,mode:operation.before.mode??0o644,encoding:operation.after.encoding,binary:true});record.completed.push(operation.path);this.save(record);}
        record.status='applied';record.appliedAt=new Date().toISOString();this.save(record);return record;
      } catch(error) {
        record.failure=error.message;
        let recovery;
        try{recovery=this.recoverLocked(projectId,record,{automatic:true});}catch(recoveryError){record.status='recovery-required';record.recoveryError=recoveryError.message;try{this.save(record);}catch{}recovery=record;}
        throw Object.assign(invalid('Patch application failed. '+(recovery.status==='rolled-back'?'Affected files were restored.':'A recovery checkpoint is available; newer changes were preserved.'),409),{application:recovery,cause:error});
      }
    });
  }
  recoverLocked(projectId,record,{automatic=false}={}) {
    const workspace=restrictWorkspace(record.workspace||currentWorkspace(this.registry,projectId),currentWorkspace(this.registry,projectId));
    const conflicts=[];
    const restore=[];
    for(const operation of record.operations){
      try{const current=readWorkspaceFile(workspace,operation.path,{allowMissing:true,binary:true});if(current.sha256===operation.before.sha256)continue;if(current.sha256===operation.after.sha256)restore.push(operation);else conflicts.push({path:operation.path,reason:'Newer local changes were preserved; recovery will not overwrite them.',actual:current.sha256});}
      catch(error){conflicts.push({path:operation.path,reason:error.message});}
    }
    for(const operation of restore){try{writeWorkspaceFile(workspace,operation.path,operation.before.content,{expectedHash:operation.after.sha256,mode:operation.before.mode??0o644,encoding:operation.before.encoding,binary:true});}catch(error){conflicts.push({path:operation.path,reason:error.message});}}
    record.status=conflicts.length?'recovery-conflict':automatic?'rolled-back':'recovered';record.conflicts=conflicts;record.recoveredAt=new Date().toISOString();return this.save(record);
  }
  async recover(projectId,solutionId) {
    return this.registry.withMutation(projectId,'patch-recovery',async()=>{const record=this.getApplication(projectId,solutionId);if(!record)throw invalid('No application checkpoint exists.',404);if(['recovered','rolled-back'].includes(record.status))return record;return this.recoverLocked(projectId,record);});
  }
}

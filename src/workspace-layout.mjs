import path from 'node:path';
import { invalid, validateRelativePath } from './collaboration-format.mjs';

// This descriptor is local-only. Portable handoffs contain aliases and hashes,
// never machine paths. A saved mapping cannot silently follow a new primary root.
export function workspaceSnapshot(workspace) {
  if(typeof workspace==='string')return {version:1,path:workspace,pathStyle:'relative',folders:[{path:workspace,name:'root'}]};
  if(!workspace||!Array.isArray(workspace.folders)||!workspace.folders.length)throw invalid('A workspace must contain at least one folder.');
  const folders=workspace.folders.map(folder=>{
    if(!folder||typeof folder.path!=='string'||!path.isAbsolute(folder.path)||typeof folder.name!=='string'||!folder.name||folder.name.includes('/')||folder.name.includes('\\')||['.','..'].includes(folder.name))throw invalid('Invalid local workspace folder mapping.');
    return {id:folder.id,name:folder.name,path:folder.path,displayName:folder.displayName||folder.name};
  });
  if(new Set(folders.map(folder=>folder.path)).size!==folders.length)throw invalid('Map each shared folder to a different local folder.');
  if(new Set(folders.map(folder=>folder.name)).size!==folders.length)throw invalid('Workspace folder aliases must be unique.');
  const pathStyle=workspace.pathStyle || (folders.length>1?'namespaced':'relative');
  if(!['relative','namespaced'].includes(pathStyle))throw invalid('Invalid workspace path style.');
  return {version:1,path:folders[0].path,pathStyle,folders};
}
export function currentWorkspace(registry,projectId) {
  return workspaceSnapshot(typeof registry.workspace==='function'?registry.workspace(projectId):registry.broker(projectId).workspace);
}
export function restrictWorkspace(snapshot,current) {
  return {...workspaceSnapshot(snapshot),allowedPaths:workspaceSnapshot(current).folders.map(folder=>folder.path)};
}
export function resolveWorkspaceFile(workspace,relative,{allowPrivate=false}={}) {
  validateRelativePath(relative,{allowPrivate});
  const descriptor=workspaceSnapshot(workspace);
  let folder=descriptor.folders[0],local=relative;
  if(descriptor.pathStyle==='namespaced') {
    const [name,...parts]=relative.split('/');folder=descriptor.folders.find(entry=>entry.name===name);
    if(!folder||!parts.length)throw invalid('Use a folder alias followed by a file path, such as frontend/src/app.js.');
    local=parts.join('/');validateRelativePath(local,{allowPrivate});
  }
  if(workspace.allowedPaths&&!workspace.allowedPaths.includes(folder.path))throw invalid('This request belongs to a folder no longer attached to the workspace. Reattach the original folder before applying or recovering it.',409);
  return {folder,root:folder.path,relative:local};
}

export function importedWorkspace(registry,projectId,request,mapping={}) {
  if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw invalid('Choose local folder mappings.');
  const current=currentWorkspace(registry,projectId),aliases=request.folderLayout?.folders||['root'];
  if(Object.keys(mapping).some(name=>!aliases.includes(name)))throw invalid('A folder mapping does not belong to this request.');
  const folders=aliases.map(name=>{
    const selected=Object.hasOwn(mapping,name)?current.folders.find(folder=>folder.id===mapping[name]):current.folders.find(folder=>folder.name===name)||(aliases.length===1?current.folders[0]:null);
    if(!selected)throw invalid('Choose a local destination folder for '+name+'.');
    return {...selected,name};
  });
  return workspaceSnapshot({path:folders[0].path,folders,pathStyle:request.folderLayout?'namespaced':'relative'});
}

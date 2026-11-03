import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {migrateLegacyData,preferredUserData} from '../desktop/storage.mjs';
import {APP_ID,ensureStartMenuShortcut} from '../desktop/windows.mjs';

test('the macOS installer is valid POSIX shell and verifies checksums before installing',()=>{const script=new URL('../install.sh',import.meta.url);const check=spawnSync('sh',['-n',fileURLToPath(script)],{encoding:'utf8'});if(!(process.platform==='win32'&&check.error?.code==='ENOENT'))assert.equal(check.status,0,check.stderr);const source=fs.readFileSync(script,'utf8');const move=source.indexOf('mv "$app" "$dest/Codeshi.app"');assert.ok(move>0&&source.indexOf('"$expected" != "$actual"')<move,'The checksum is checked before anything is moved into place.');assert.ok(source.indexOf('rm -rf "$dest/Throughline.app"')>move,'The copy from before the rename goes only once Codeshi is in place.');assert.ok(source.indexOf('"Codeshi-$version-mac-$build.zip" "Throughline-$version-mac-$build.zip"')>0,'Releases from before the rename still install.');});
test('the Windows installer is valid PowerShell and verifies checksums before installing',()=>{
  const script=fileURLToPath(new URL('../install.ps1',import.meta.url)),source=fs.readFileSync(script,'utf8');
  assert.ok(source.indexOf('Get-FileHash')<source.indexOf('Expand-Archive'),'The checksum is checked before the download is opened.');
  assert.ok(source.indexOf("Fail 'The download does not match")<source.indexOf('Remove-Item -Recurse -Force $dest'),'The installed copy is only removed once the download is verified.');
  assert.ok(source.indexOf('Copy-Item -Recurse -Path $app -Destination $dest')<source.indexOf('Remove-Item -Recurse -Force $legacy'),'The copy from before the rename goes only once Codeshi is in place.');
  if(process.platform!=='win32')return;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const check=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command','$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:THROUGHLINE_SCRIPT,[ref]$null,[ref]$errors);if($errors){$errors|ForEach-Object{$_.ToString()};exit 1}'],{encoding:'utf8',env:{...process.env,THROUGHLINE_SCRIPT:script}});
  assert.equal(check.status,0,check.stdout+check.stderr);
});

test('desktop migration copies history reversibly and is idempotent',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const legacy=path.join(root,'legacy'),dest=path.join(root,'data');fs.mkdirSync(path.join(legacy,'p'),{recursive:true});fs.writeFileSync(path.join(legacy,'projects.json'),'{"version":1,"projects":[]}');fs.writeFileSync(path.join(legacy,'p','history.jsonl'),'user history\n');fs.writeFileSync(path.join(legacy,'p','server.lock'),JSON.stringify({pid:2147483647}));const result=migrateLegacyData(legacy,dest);assert.equal(result.migrated,true);assert.equal(fs.readFileSync(path.join(legacy,'p','history.jsonl'),'utf8'),'user history\n');assert.equal(fs.readFileSync(path.join(dest,'p','history.jsonl'),'utf8'),'user history\n');assert.equal(fs.existsSync(path.join(dest,'p','server.lock')),false);assert.equal(migrateLegacyData(legacy,dest).migrated,false);});
test('desktop migration refuses a live old server rather than copying active journals',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-migration-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const legacy=path.join(root,'legacy');fs.mkdirSync(path.join(legacy,'p'),{recursive:true});fs.writeFileSync(path.join(legacy,'projects.json'),'{}');fs.writeFileSync(path.join(legacy,'p','server.lock'),JSON.stringify({pid:process.pid}));assert.throws(()=>migrateLegacyData(legacy,path.join(root,'new')),/Close the existing/);assert.equal(fs.existsSync(path.join(root,'new')),false);});


test('migration rejects numeric live legacy locks and unfinished guards without partial data',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-migration-guards-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const legacy=path.join(root,'legacy');fs.mkdirSync(path.join(legacy,'p'),{recursive:true});fs.writeFileSync(path.join(legacy,'projects.json'),'{}');const lock=path.join(legacy,'p','server.lock');fs.writeFileSync(lock,String(process.pid));assert.throws(()=>migrateLegacyData(legacy,path.join(root,'new')),/Close the existing/);fs.unlinkSync(lock);fs.mkdirSync(path.join(legacy,'projects.json.guard'));assert.throws(()=>migrateLegacyData(legacy,path.join(root,'new')),/unfinished operation guard/);assert.equal(fs.existsSync(path.join(root,'new')),false);assert.ok(fs.existsSync(path.join(legacy,'projects.json')));
});

test('existing installations keep their pre-rename data folder even after Electron creates the new one',t=>{
  const appData=fs.mkdtempSync(path.join(os.tmpdir(),'relay-appdata-'));t.after(()=>fs.rmSync(appData,{recursive:true,force:true}));
  const current=path.join(appData,'Codeshi'),legacy=path.join(appData,'AI Relay');fs.mkdirSync(current);
  assert.equal(preferredUserData(appData,current),current,'New installations use the Codeshi folder.');
  fs.mkdirSync(path.join(legacy,'relay-data'),{recursive:true});assert.equal(preferredUserData(appData,current),current,'An empty legacy folder is ignored.');
  fs.writeFileSync(path.join(legacy,'relay-data','projects.json'),'{}');fs.mkdirSync(path.join(current,'relay-data'));
  assert.equal(preferredUserData(appData,current),legacy,'Saved workspaces in the legacy folder win over a freshly created default.');
});

test('installations from before Codeshi keep their Throughline folder, and a folder with saved workspaces wins',t=>{
  const appData=fs.mkdtempSync(path.join(os.tmpdir(),'relay-appdata-'));t.after(()=>fs.rmSync(appData,{recursive:true,force:true}));
  const current=path.join(appData,'Codeshi'),throughline=path.join(appData,'Throughline'),relay=path.join(appData,'AI Relay');
  const save=folder=>{fs.mkdirSync(path.join(folder,'relay-data'),{recursive:true});fs.writeFileSync(path.join(folder,'relay-data','projects.json'),'{}');};
  fs.mkdirSync(path.join(throughline,'relay-data'),{recursive:true});
  assert.equal(preferredUserData(appData,current),current,'A Throughline folder without saved workspaces is ignored.');
  save(throughline);assert.equal(preferredUserData(appData,current),throughline,'Throughline’s workspaces stay where they are.');
  save(relay);assert.equal(preferredUserData(appData,current),relay,'An AI Relay folder, which Throughline kept using, stays in use.');
  save(current);assert.equal(preferredUserData(appData,current),current,'Once the Codeshi folder has workspaces, it is used.');
  const dev=path.join(appData,'Codeshi Dev'),oldDev=path.join(appData,'Throughline Dev');
  assert.equal(preferredUserData(appData,dev,['Throughline Dev']),dev);
  save(oldDev);assert.equal(preferredUserData(appData,dev,['Throughline Dev']),oldDev,'The development profile from before the rename keeps its workspaces.');
});

test('the Start menu shortcut from before the rename goes once it is known to be this app’s',()=>{
  const programs=path.join('Start Menu','Programs'),legacy=path.join(programs,'Throughline.lnk'),target=path.join('Programs','Codeshi','Codeshi.exe');
  const links=new Map([[legacy,{target:path.join('Programs','Throughline','Throughline.exe')}]]),removed=[];
  const shell={readShortcutLink:file=>{if(!links.has(file))throw new Error('No shortcut.');return links.get(file);},writeShortcutLink:(file,operation,options)=>{links.set(file,options);return true;}};
  const exists=file=>links.has(file),remove=file=>{removed.push(file);links.delete(file);};
  ensureStartMenuShortcut({shell,programs,target,exists,remove});
  assert.deepEqual([removed,[...links.keys()]],[[legacy],[path.join(programs,'Codeshi.lnk')]]);
  removed.length=0;links.set(legacy,{target:path.join('Tools','Other.exe')});
  ensureStartMenuShortcut({shell,programs,target,exists,remove});
  assert.deepEqual(removed,[],'A Throughline shortcut that opens something else is left alone.');
  links.set(legacy,{target:path.join('Elsewhere','Codeshi.exe'),appUserModelId:APP_ID});
  ensureStartMenuShortcut({shell,programs,target,exists,remove});
  assert.deepEqual(removed,[legacy],'One that carries this app’s ID goes too.');
});

test('Windows notifications get a Start menu shortcut that carries the app ID and opens this copy',()=>{
  const links=new Map(),writes=[],programs=path.join('Start Menu','Programs'),link=path.join(programs,'Codeshi.lnk'),target=path.join('Programs','Codeshi','Codeshi.exe');
  const shell={readShortcutLink:file=>{if(!links.has(file))throw new Error('No shortcut.');return links.get(file);},writeShortcutLink:(file,operation,options)=>{writes.push(operation);links.set(file,options);return true;}};
  const exists=file=>links.has(file);
  assert.deepEqual(ensureStartMenuShortcut({shell,programs,target,exists}),{link,changed:true});
  assert.equal(links.get(link).appUserModelId,APP_ID);
  assert.equal(ensureStartMenuShortcut({shell,programs,target,exists}).changed,false,'A current shortcut is left alone.');
  links.set(link,{target});
  assert.equal(ensureStartMenuShortcut({shell,programs,target,exists}).changed,true,'The installer’s shortcut gets the app ID.');
  const moved=path.join('Downloads','Codeshi','Codeshi.exe');
  ensureStartMenuShortcut({shell,programs,target:moved,exists});
  assert.deepEqual([writes,links.get(link).target,links.get(link).appUserModelId],[['create','replace','replace'],moved,APP_ID]);
  assert.throws(()=>ensureStartMenuShortcut({shell:{...shell,writeShortcutLink:()=>false},programs,target,exists}),/did not save/);
});

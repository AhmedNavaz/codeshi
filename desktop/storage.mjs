import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Installations from before a rename keep their history in the folder they started with: "AI Relay", then
// "Throughline". Electron creates the current name's folder at startup, so a folder's existence says nothing; saved
// relay-data decides, and the current folder wins once it has some.
export const LEGACY_DATA_FOLDERS = ['AI Relay', 'Throughline'];
export function preferredUserData(appData, userData, legacy = LEGACY_DATA_FOLDERS) {
  const saved = folder => fs.existsSync(path.join(folder, 'relay-data', 'projects.json'));
  if (saved(userData)) return userData;
  return legacy.map(name => path.join(appData, name)).find(saved) || userData;
}

// Copy, never move: the original remains available for rollback. A staged copy is
// atomically renamed so a killed migration cannot leave a half-populated registry.
export function migrateLegacyData(legacy, destination) {
  if (fs.existsSync(destination)) return { migrated:false, destination };
  fs.mkdirSync(path.dirname(destination), {recursive:true,mode:0o700});
  if (!fs.existsSync(path.join(legacy,'projects.json'))) {
    fs.mkdirSync(destination,{recursive:true,mode:0o700});
    return {migrated:false,destination};
  }
  for (const entry of fs.readdirSync(legacy,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const lock=path.join(legacy,entry.name,'server.lock');
    if (!fs.existsSync(lock)) continue;
    try {const saved=JSON.parse(fs.readFileSync(lock,'utf8'));const pid=typeof saved==='number'?saved:saved.pid;if(!Number.isSafeInteger(pid)||pid<=0)throw Object.assign(new Error('Invalid saved lock. Close all Codeshi instances and inspect '+lock+' before migration.'),{liveRelay:true});process.kill(pid,0);throw Object.assign(new Error('Close the existing Codeshi browser server before migrating saved history.'),{liveRelay:true});}
    catch(e) {if(e.code==='ESRCH')continue;if(e.liveRelay || e.code==='EPERM')throw e;throw new Error('Cannot verify the saved lock '+lock+': '+e.message);}
  }
  const staging=destination+'.migration-'+randomUUID();
  try {
    fs.cpSync(legacy,staging,{recursive:true,errorOnExist:true,filter:source=>{
      if(path.basename(source).endsWith('.guard'))throw new Error('Saved data contains an unfinished operation guard: '+source+'. Close all Codeshi instances and inspect this guard before migration.');
      return !['server.lock','server.log'].includes(path.basename(source)) && !path.basename(source).endsWith('.lock');
    }});
    fs.writeFileSync(path.join(staging,'migration.json'),JSON.stringify({version:1,source:legacy,copiedAt:new Date().toISOString(),reversible:true},null,2),{mode:0o600});
    fs.renameSync(staging,destination);
    return {migrated:true,destination,source:legacy};
  } catch(e) {fs.rmSync(staging,{recursive:true,force:true});throw e;}
}

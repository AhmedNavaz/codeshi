import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const fail = message => Object.assign(new Error(message), { status: 409 });
const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
let ownStart;
// The start time the kernel stored when the process began, so a clock correction doesn't change it. The time zone
// and language are fixed so ps prints it the same way for every instance. It is only read on macOS.
export function processStart(pid) {
  if (pid === process.pid && ownStart) return ownStart;
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const start = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).stdout?.trim() || null;
  if (pid === process.pid) ownStart = start;
  return start;
}
// A process ID saved with a start time belongs to another process once the process using it reports a different one.
// Locks from earlier versions have no start time, and an unreadable one counts as unchanged, so a live ID still holds the lock.
export function reused(pid, start) {
  if (!start) return false;
  const now = processStart(pid);
  return Boolean(now) && now !== start;
}
const alive = (pid, start) => exists(pid) && !reused(pid, start);
// A group ID is its leader's PID, and no new process gets it while the group exists. So a process using it with
// another start time means the group has ended. A leader that exited alone has no start time, so its group still counts.
function groupAlive(pid, start) { return process.platform !== 'win32' && pid ? exists(-pid) && !reused(pid, start) : false; }
// Ownership lives in a unique filename, so a guard says who holds it and a marker can't be mistaken for another's.
function guardOwner() {
  const start = processStart(process.pid);
  return `owner-${process.pid}-${start ? Buffer.from(start).toString('base64url') : 'none'}-${randomUUID()}.json`;
}
function savedGuardOwner(name) {
  const match = /^owner-(\d+)-([A-Za-z0-9_-]+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/.exec(name);
  if (!match || !Number.isSafeInteger(+match[1]) || +match[1] <= 0) return null;
  const start = match[2] === 'none' ? null : Buffer.from(match[2], 'base64url').toString('utf8');
  if (start !== null && (!/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start) || Buffer.from(start).toString('base64url') !== match[2])) return null;
  return { pid: +match[1], start };
}
const busy = error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
// The guard moved or is in use: nothing here can be done now, and it stays protected until a later try. On macOS a
// folder being retired by another process can answer EINVAL instead of ENOENT.
const outOfReach = error => ['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code) || busy(error);
const pauseFor = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ownerRecord = () => JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) });
// Windows refuses to rename a folder for the moment another process is reading in it, so this outlasts that.
const RETIRE_WAIT_MS = 1000;
function discardGuard(guard) {
  // Retire the whole directory before deleting what's in it. A crash during
  // cleanup then leaves only a disposable retired directory, never an empty
  // guard blocking the next application launch.
  const retired = `${guard}.retired-${randomUUID()}`;
  for (const deadline = Date.now() + RETIRE_WAIT_MS; ;) {
    try { fs.renameSync(guard, retired); break; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (!busy(error) || Date.now() >= deadline) throw error;
      pauseFor(5);
    }
  }
  // Anything else inside was left by a recovering process that backed off. The guard is already free, so a retired
  // folder that can't be removed now is swept later.
  try { fs.rmSync(retired, { recursive: true, force: true }); } catch { /* sweepLeftovers removes it once it is old. */ }
}
// Earlier versions created a guard empty and wrote its owner marker straight after, so a guard stayed empty for
// microseconds. One that has been empty for longer was left by a process stopped in between (a force-quit, for
// example), and nothing can still be using it. A rename replaces such a guard on macOS and Linux; on Windows it is
// claimed here.
export const ABANDONED_EMPTY_GUARD_MS = 5000;
// Everything here belongs to a process that has gone. Unknown content has no verifiable owner, so it remains
// fail-closed: age alone never grants permission to remove it.
function abandoned(guard, names, claim) {
  return names.every(name => {
    if (name === claim) return true;
    const owner = savedGuardOwner(name);
    if (!owner || alive(owner.pid, owner.start)) return false;
    try { return fs.lstatSync(path.join(guard, name)).isFile(); } catch { return false; }
  });
}
// Taking over from a dead owner. Each recovering process writes its own marker into the guard, reads the folder back
// and goes on only if everything else in it belongs to a process that has gone. Of any two at work, whichever writes
// second sees the first, so at most one goes on, and the other backs off and tries again. A crash at any point leaves
// only markers of dead processes, which the next one can claim. No step relies on a rename being exclusive: on Windows
// two renames of one file can both succeed, each through a handle it opened beforehand.
function claimGuard(guard, claim) {
  const file = path.join(guard, claim);
  try { fs.writeFileSync(file, ownerRecord(), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (outOfReach(error)) return false;
    // Already there: this process's claim from a try that could not remove it.
    if (error.code !== 'EEXIST') throw error;
  }
  let names;
  try { names = fs.readdirSync(guard); }
  catch (error) { if (outOfReach(error)) return false; throw error; }
  if (!names.includes(claim) || !abandoned(guard, names, claim)) {
    try { fs.unlinkSync(file); } catch { /* Gone with the guard, or removed on a later try. */ }
    return false;
  }
  try { discardGuard(guard); return true; }
  catch (error) { if (busy(error)) return false; throw error; }
}
function recoverGuard(guard, claim) {
  let names, directory;
  try {
    directory = fs.lstatSync(guard);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    names = fs.readdirSync(guard);
  } catch (error) { if (error.code === 'ENOENT') return true; if (outOfReach(error)) return false; throw error; }
  if (names.length === 0 ? Date.now() - directory.mtimeMs < ABANDONED_EMPTY_GUARD_MS : !abandoned(guard, names, claim)) return false;
  return claimGuard(guard, claim);
}
// A guard is built in a staging folder with its owner marker already inside, then renamed into place in one atomic
// step, so it never exists without an owner, even if the process is stopped at any moment. A guard left empty by an
// earlier version is replaced by that rename; one with an owner or other contents makes the rename fail and is handled
// below. Staging folders left by a process stopped before its rename, and retired guards a process could not finish
// removing, are removed once they are a minute old.
const STAGING = '.new-', RETIRED = '.retired-';
function stage(guard, marker) {
  const staging = `${guard}${STAGING}${randomUUID()}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try { fs.writeFileSync(path.join(staging, marker), ownerRecord(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  return staging;
}
const isLink = target => { try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; } };
function sweepLeftovers(guard) {
  const directory = path.dirname(guard), prefixes = [STAGING, RETIRED].map(kind => path.basename(guard) + kind);
  let names = [];
  try { names = fs.readdirSync(directory).filter(name => prefixes.some(prefix => name.startsWith(prefix))); } catch { return; }
  for (const name of names) {
    const target = path.join(directory, name);
    try { if (Date.now() - fs.lstatSync(target).mtimeMs > 60000) fs.rmSync(target, { recursive: true, force: true }); } catch { /* Another process may be using or removing it. */ }
  }
}
export function withFileGuard(filename, callback) {
  const guard = `${filename}.guard`;
  const marker = guardOwner();
  const deadline=Date.now()+500;
  const pause=new Int32Array(new SharedArrayBuffer(4));
  for(;;) {
    const staging = stage(guard, marker);
    try { fs.renameSync(staging, guard); break; }
    catch(error) {
      fs.rmSync(staging, { recursive: true, force: true });
      // The guard is taken: it isn't empty, it isn't a folder (ENOTDIR, such as a symbolic link, which is never
      // replaced), or this is Windows, where a rename never replaces a folder (EPERM).
      if(!['EEXIST','ENOTEMPTY','ENOTDIR','EPERM','EACCES'].includes(error.code))throw error;
      // Released in the meantime: try again at once.
      if(!fs.existsSync(guard)&&!isLink(guard))continue;
      if(recoverGuard(guard, marker))continue;
      if(Date.now()>=deadline)throw fail(`Another operation is updating ${path.basename(filename)}. Retry. If the application crashed while holding this guard, inspect and remove ${guard} only after all Codeshi instances are stopped.`);
      // Guards protect short synchronous filesystem transactions. Another process
      // may finish normally; don't mistake that brief contention for a crash. The
      // pause varies, so two recovering processes that backed off don't keep meeting.
      Atomics.wait(pause,0,0,5+Math.random()*20);
    }
  }
  try {
    sweepLeftovers(guard);
    return callback();
  } finally { discardGuard(guard); }
}
// Locks and leases are written under a temporary name and renamed into place, so a write that fails (on a full disk,
// for example) or stops partway leaves no empty file behind to block later changes.
function atomicWrite(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function acquireProjectLock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'server.lock');
  const contents = JSON.stringify({ pid: process.pid, token: randomUUID(), pidStart: processStart(process.pid) });
  withFileGuard(filename, () => {
    if (fs.existsSync(filename)) {
      const raw = fs.readFileSync(filename, 'utf8');
      let pid, pidStart;
      try { ({ pid, pidStart } = raw.trim().startsWith('{') ? JSON.parse(raw) : { pid: Number(raw) }); } catch { throw fail(`Invalid project lock: ${filename}`); }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw fail(`Invalid project lock: ${filename}`);
      if (alive(pid, pidStart)) throw fail(`Codeshi is already running for this project (process ${pid}).`);
      fs.unlinkSync(filename);
    }
    atomicWrite(filename, contents);
  });
  return () => withFileGuard(filename, () => { if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') === contents) fs.unlinkSync(filename); });
}
function overlaps(first, second) {
  const relative = path.relative(first, second);
  const reverse = path.relative(second, first);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) || (!reverse.startsWith(`..${path.sep}`) && reverse !== '..' && !path.isAbsolute(reverse));
}
export class MutationCoordinator {
  constructor(dataRoot) {
    // Workspace mutations must also exclude runs using another history/data root.
    this.root = process.env.AI_RELAY_MUTATIONS_DIR || path.join(os.tmpdir(), `ai-relay-mutations-${process.getuid?.() ?? os.userInfo().username}`);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  acquire(workspace, operation) {
    return this.acquireMany([workspace], operation);
  }
  acquireMany(workspaces, operation) {
    if (!Array.isArray(workspaces) || !workspaces.length) throw fail('A workspace must contain at least one folder.');
    workspaces = [...new Set(workspaces.map(workspace => {
      // The native realpath matches letter case to the disk, so leases taken through differently typed paths still overlap.
      try { return fs.realpathSync.native(workspace); }
      catch (error) {
        // A saved canonical folder can become unavailable. Retain its absolute
        // identity while removing it from project membership under this lease.
        if (['ENOENT', 'ENOTDIR'].includes(error.code) && path.isAbsolute(workspace)) return path.resolve(workspace);
        throw error;
      }
    }))];
    const id = randomUUID();
    const filename = path.join(this.root, `${id}.json`);
    const coordinator = path.join(this.root,'coordinator');
    const value = { id, workspace: workspaces[0], workspaces, operation, pid: process.pid, pidStart: processStart(process.pid), processGroup: null, processGroupStart: null, createdAt: new Date().toISOString() };
    withFileGuard(coordinator, () => {
      for (const name of fs.readdirSync(this.root).filter(name => name.endsWith('.json'))) {
        const full = path.join(this.root, name);
        // A lease that can't be read has no known owner, so it is kept and blocks changes until it is removed by hand.
        let other;
        try { other = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { throw fail(`Project files are locked by a lease that cannot be read: ${full}. Remove it only after all Codeshi instances are stopped.`); }
        if (!alive(other.pid, other.pidStart) && !groupAlive(other.processGroup, other.processGroupStart)) { fs.unlinkSync(full); continue; }
        const otherRoots = other.workspaces || [other.workspace];
        // Leases from earlier versions hold folders as they were typed, so compare their paths on disk too.
        const otherFolders = otherRoots.map(root => { try { return fs.realpathSync.native(root); } catch { return root; } });
        if (workspaces.some(workspace => otherFolders.some(folder => overlaps(workspace, folder)))) throw fail(`Project files are busy: ${other.operation} is active in an overlapping workspace.`);
      }
      atomicWrite(filename, JSON.stringify(value));
    });
    let released = false;
    return {
      id,
      setProcess(pid, start = processStart(pid)) {
        withFileGuard(coordinator,()=>{value.processGroup=pid;value.processGroupStart=start;atomicWrite(filename,JSON.stringify(value));});
      },
      release() {
        if(!released)withFileGuard(coordinator,()=>{fs.unlinkSync(filename);released=true;});
      },
    };
  }
  async withMutation(workspace, operation, callback) { return this.withMutations([workspace], operation, callback); }
  async withMutations(workspaces, operation, callback) { const lease = this.acquireMany(workspaces, operation); try { return await callback(); } finally { lease.release(); } }
}

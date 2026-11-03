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
// Ownership lives in a unique filename so a recovery process can claim a dead
// owner's marker with one atomic rename. A contender holding an old filename
// can never remove a replacement guard created by another process.
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
function discardGuard(guard, marker) {
  // Retire the whole directory before deleting its marker. A crash during
  // cleanup then leaves only a disposable retired directory, never an empty
  // guard blocking the next application launch.
  const retired = `${guard}.retired-${randomUUID()}`;
  fs.renameSync(guard, retired);
  try { fs.unlinkSync(path.join(retired, marker)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.rmdirSync(retired);
}
// Earlier versions created a guard empty and wrote its owner marker straight after, so a guard stayed empty for
// microseconds. One that has been empty for longer was left by a process stopped in between (a force-quit, for
// example), and nothing can still be using it. A rename replaces such a guard on macOS and Linux; on Windows it is
// claimed here.
export const ABANDONED_EMPTY_GUARD_MS = 5000;
function recoverGuard(guard, claim) {
  let names, directory;
  try {
    directory = fs.lstatSync(guard);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    names = fs.readdirSync(guard);
  } catch (error) { if (error.code === 'ENOENT') return true; if (['ENOTDIR', 'EACCES'].includes(error.code)) return false; throw error; }
  if (names.length === 0) return claimAbandonedEmptyGuard(guard, claim, directory);
  // Unknown content has no verifiable owner. It remains fail-closed; age alone never grants permission to remove it.
  if (names.length !== 1) return false;
  const owner = savedGuardOwner(names[0]);
  if (!owner || alive(owner.pid, owner.start)) return false;
  const source = path.join(guard, names[0]);
  try {
    const marker = fs.lstatSync(source);
    if (!marker.isFile() || marker.isSymbolicLink()) return false;
    fs.renameSync(source, path.join(guard, claim));
  } catch (error) {
    // On macOS, a parent directory retired by another recovery process can
    // yield EINVAL instead of ENOENT. Retry only when the exact old marker is
    // gone; an unexplained rename failure still leaves the guard protected.
    if (error.code === 'ENOENT' || error.code === 'EINVAL' && !fs.existsSync(source)) return false;
    throw error;
  }
  // The marker now names this live recovery process. Other recoverers wait;
  // if this process crashes here, its successor can claim this marker instead.
  discardGuard(guard, claim);
  return true;
}
// An abandoned empty guard is claimed by writing this process's marker into it. It is only ours if the marker is then
// the only thing in it; anything else (another claimant, a late owner) means backing off and leaving it alone.
function claimAbandonedEmptyGuard(guard, claim, directory) {
  if (Date.now() - directory.mtimeMs < ABANDONED_EMPTY_GUARD_MS) return false;
  const file = path.join(guard, claim);
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (['ENOENT', 'EEXIST', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  let names;
  try { names = fs.readdirSync(guard); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (names.length !== 1 || names[0] !== claim) { try { fs.unlinkSync(file); } catch { /* Another claimant may have taken the guard. */ } return false; }
  discardGuard(guard, claim);
  return true;
}
// A guard is built in a staging folder with its owner marker already inside, then renamed into place in one atomic
// step, so it never exists without an owner, even if the process is stopped at any moment. A guard left empty by an
// earlier version is replaced by that rename; one with an owner or other contents makes the rename fail and is handled
// below. Staging folders left by a process stopped before its rename are removed once they are a minute old.
const STAGING = '.new-';
function stage(guard, marker) {
  const staging = `${guard}${STAGING}${randomUUID()}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try { fs.writeFileSync(path.join(staging, marker), JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  return staging;
}
const isLink = target => { try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; } };
function sweepStaging(guard) {
  const directory = path.dirname(guard), prefix = path.basename(guard) + STAGING;
  let names = [];
  try { names = fs.readdirSync(directory).filter(name => name.startsWith(prefix)); } catch { return; }
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
      // may finish normally; don't mistake that brief contention for a crash.
      Atomics.wait(pause,0,0,10);
    }
  }
  try {
    sweepStaging(guard);
    return callback();
  } finally { discardGuard(guard, marker); }
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
    this.root = path.join(os.tmpdir(), `ai-relay-mutations-${process.getuid?.() ?? os.userInfo().username}`);
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

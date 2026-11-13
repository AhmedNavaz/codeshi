import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { command } from './routing-references.mjs';
import { gitExecutable } from './resolve-binary.mjs';
import { friendlyError } from './github-context.mjs';

// Open a GitHub repository as a workspace (#159). The list comes from the person's own gh login, so Codeshi asks for no
// sign-in and stores no token. Cloning runs gh repo clone, which uses the person's git with that same login. Nothing is
// pushed, and nothing is fetched in the background: one list per opening of the panel, one clone per click. Any host gh
// is signed in to can be listed, github.com or a GitHub Enterprise Server, and no other host is ever contacted.

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
// gh's own errors, worded for listing and cloning rather than for reading an issue.
function ghError(error, reference) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}`;
  if (/GitHub CLI unavailable|ENOENT/.test(text)) return Object.assign(new Error('Install the GitHub CLI (gh) and sign in with gh auth login to see your repositories here.'), { status: 400 });
  if (/gh auth login|not logged in|authentication|HTTP 401/i.test(text)) return Object.assign(new Error('Sign in to the GitHub CLI with gh auth login, then try again.'), { status: 400 });
  return friendlyError(error, reference);
}
const PAGE = 100, PAGES = 5, CLONE_TIMEOUT = 10 * 60 * 1000;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const FIELDS = '.[] | {fullName: .full_name, description: .description, private: .private, fork: .fork, archived: .archived, pushedAt: .pushed_at, url: .html_url}';

export function validRepository(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!NAME.test(name) || name.split('/')[1].replace(/\./g, '') === '') fail('Choose a repository from the list.');
  return name;
}
export function expandFolder(value) {
  let folder = typeof value === 'string' ? value.trim() : '';
  if (folder === '~') folder = os.homedir();
  else if (folder.startsWith('~/')) folder = path.join(os.homedir(), folder.slice(2));
  if (!folder || !path.isAbsolute(folder)) fail('Choose a folder to clone into: an absolute path or one beginning with ~/.');
  return path.resolve(folder);
}
const isDirectory = folder => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } };
const tilde = folder => folder === os.homedir() ? '~' : folder.startsWith(os.homedir() + path.sep) ? '~/' + folder.slice(os.homedir().length + 1) : folder;

// Where to suggest cloning the first time: the folder most of your workspace folders sit in, or ~/Developer.
export function suggestedCloneFolder(folders = []) {
  const counts = new Map();
  for (const folder of folders) {
    const parent = path.dirname(folder);
    if (parent === folder || parent === os.homedir() || parent === path.parse(parent).root) continue;
    counts.set(parent, (counts.get(parent) || 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return tilde(best || path.join(os.homedir(), 'Developer'));
}

const DEFAULT_HOST = 'github.com';
// A host name gh may be signed in to: github.com or a GitHub Enterprise Server, without scheme, path or port.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function validHost(value) {
  const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!HOST.test(host)) fail('Choose a GitHub host from the list.');
  return host;
}

// The host and owner/name of a remote address, for any host: git@host:o/n, ssh://[user@]host[:port]/o/n or
// https://[user@]host[:port]/o/n. Host and name are lower-cased for comparison.
export function parseRemote(url) {
  const match = String(url || '').trim().match(/^(?:[\w.-]+@([^:/\s]+):|ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/|https:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? { host: (match[1] || match[2] || match[3]).toLowerCase(), name: `${match[4]}/${match[5]}`.toLowerCase() } : null;
}
function originURL(folder, spawnImpl) {
  const result = spawnImpl(gitExecutable(), ['-C', folder, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 3000, shell: false, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 ? String(result.stdout || '') : null;
}
// owner/name of a folder's origin on one host, lower-cased for comparison, or null. github.com by default, which is
// what backups record.
export function originRepository(folder, spawnImpl = spawnSync, host = DEFAULT_HOST) {
  const remote = parseRemote(originURL(folder, spawnImpl));
  return remote && remote.host === host ? remote.name : null;
}
const originOn = host => folder => originRepository(folder, spawnSync, host);

// Folders on this computer already holding a clone: workspace folders, then the clone folder's own subfolders.
export function localClones({ folders = [], cloneFolder = null, origin = originRepository } = {}) {
  const found = new Map(), seen = new Set();
  const consider = folder => {
    if (seen.has(folder)) return; seen.add(folder);
    const name = isDirectory(folder) ? origin(folder) : null;
    if (name && !found.has(name)) found.set(name, folder);
  };
  for (const folder of folders) consider(folder);
  if (cloneFolder && isDirectory(cloneFolder)) {
    let entries = [];
    try { entries = fs.readdirSync(cloneFolder, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries.slice(0, 500)) if (entry.isDirectory() && !entry.name.startsWith('.')) consider(path.join(cloneFolder, entry.name));
  }
  return found;
}

export function createGitHubRepos({ run = command, origin = originRepository, originFor = originOn } = {}) {
  const cloning = new Set();
  const gh = (args, options = {}) => run('gh', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...options });
  // The origin matcher for a host: the injected one for github.com, the host's own for an Enterprise server.
  const originAt = host => host === DEFAULT_HOST ? origin : originFor(host);
  const api = (host, args) => gh(['api', ...(host === DEFAULT_HOST ? [] : ['--hostname', host]), ...args]);

  // The hosts gh is signed in to, with the active login on each: github.com and any GitHub Enterprise Server. A gh
  // too old to report them as JSON, or one that can't be read, falls back to github.com, which the list then checks.
  async function hosts() {
    let output;
    try { output = await gh(['auth', 'status', '--json', 'hosts'], { timeout: 10000 }); }
    catch (error) { output = error?.stdout; }
    let parsed = null;
    try { parsed = JSON.parse(String(output || '')); } catch { parsed = null; }
    const found = [];
    for (const [name, accounts] of Object.entries(parsed?.hosts || {})) {
      const host = typeof name === 'string' ? name.toLowerCase() : '', active = (Array.isArray(accounts) ? accounts : []).find(entry => entry?.active) || null;
      if (HOST.test(host) && active?.state === 'success') found.push({ host, login: typeof active.login === 'string' ? active.login.slice(0, 100) : null });
    }
    found.sort((a, b) => (b.host === DEFAULT_HOST) - (a.host === DEFAULT_HOST) || a.host.localeCompare(b.host));
    return found.length ? found : [{ host: DEFAULT_HOST, login: null }];
  }
  // A host from the request, refused unless gh is signed in to it, so Codeshi never contacts a host you didn't add.
  async function signedIn(value) {
    const known = await hosts();
    if (value === undefined || value === null || value === '') return { host: known[0].host, hosts: known };
    const host = validHost(value);
    if (!known.some(item => item.host === host)) fail(`The GitHub CLI isn't signed in to ${host}. Run gh auth login --hostname ${host}, then try again.`);
    return { host, hosts: known };
  }

  async function account(host) {
    try { return JSON.parse(await api(host, ['user', '--jq', '{login: .login, name: .name}'])); }
    catch (error) { throw ghError(error, 'your account'); }
  }

  // Your repositories, your organizations' and those you collaborate on, most recently pushed first.
  async function list({ folders = [], cloneFolder = null, host = DEFAULT_HOST } = {}) {
    const fetchPage = page => api(host, [`user/repos?per_page=${PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, '--jq', FIELDS]).catch(error => { throw ghError(error, 'your repositories'); });
    const [who, first] = await Promise.all([account(host), fetchPage(1)]), repos = [];
    let more = false;
    for (let page = 1; page <= PAGES; page++) {
      const output = page === 1 ? first : await fetchPage(page);
      const rows = String(output || '').split('\n').filter(Boolean).map(line => JSON.parse(line));
      repos.push(...rows);
      if (rows.length < PAGE) break;
      if (page === PAGES) more = true;
    }
    const clones = localClones({ folders, cloneFolder, origin: originAt(host) });
    return {
      account: who,
      host,
      more,
      repos: repos.filter(repo => typeof repo.fullName === 'string' && NAME.test(repo.fullName)).map(repo => ({
        fullName: repo.fullName, description: typeof repo.description === 'string' ? repo.description.slice(0, 300) : '',
        private: repo.private === true, fork: repo.fork === true, archived: repo.archived === true, pushedAt: repo.pushedAt || null,
        url: typeof repo.url === 'string' && repo.url.startsWith(`https://${host}/`) ? repo.url : `https://${host}/${repo.fullName}`,
        local: clones.get(repo.fullName.toLowerCase()) || null,
      })),
    };
  }

  // A folder for the repository: an existing clone if there is one, else a fresh clone inside the chosen folder.
  async function clone({ repository, cloneFolder, folders = [], host = DEFAULT_HOST }) {
    const name = validRepository(repository), key = name.toLowerCase(), where = host === DEFAULT_HOST ? 'GitHub' : host;
    const existing = localClones({ folders, cloneFolder: cloneFolder && isDirectory(cloneFolder) ? cloneFolder : null, origin: originAt(host) }).get(key);
    if (existing) return { path: existing, cloned: false };
    if (!cloneFolder) fail('Choose a folder to clone into.');
    // A new folder is made only one level deep, so a mistyped path doesn't leave a trail of folders behind.
    if (!fs.existsSync(cloneFolder) && isDirectory(path.dirname(cloneFolder))) fs.mkdirSync(cloneFolder);
    if (!isDirectory(cloneFolder)) fail(`${tilde(cloneFolder)} isn't a folder on this computer.`, 404);
    const target = path.join(cloneFolder, name.split('/')[1]);
    if (fs.existsSync(target)) fail(`${tilde(target)} already exists and isn't a clone of ${name}. Choose another folder to clone into.`, 409);
    if (cloning.has(target)) fail(`${name} is already being cloned.`, 409);
    cloning.add(target);
    try {
      // gh takes HOST/OWNER/REPO for a repository on an Enterprise server.
      await gh(['repo', 'clone', host === DEFAULT_HOST ? name : `${host}/${name}`, target], { timeout: CLONE_TIMEOUT, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      // gh and git remove a failed clone themselves; a clone stopped by the time limit can leave its folder behind.
      if (isDirectory(target) && origin(target) === null) try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* Left for the person. */ }
      const text = `${error?.message || ''}\n${error?.stderr || ''}`;
      if (error?.killed || /timed? ?out/i.test(text)) fail(`Cloning ${name} took longer than 10 minutes and was stopped. Clone it in a terminal, then add the folder.`, 504);
      if (/GitHub CLI unavailable|ENOENT|not logged in|gh auth login|authentication|HTTP 401/i.test(text)) throw ghError(error);
      if (/Could not resolve|not found|HTTP 404/i.test(text)) fail(`Couldn't find ${name} on ${where}, or your gh login can't see it.`, 404);
      const detail = String(error?.stderr || '').trim().split('\n').slice(-3).join('\n');
      fail(`Couldn't clone ${name}.${detail ? `\n${detail}` : ''}`, 502);
    } finally { cloning.delete(target); }
    return { path: target, cloned: true };
  }

  return { hosts, signedIn, list, clone };
}

export function createGitHubRepoRoutes({ registry, body, json, settings, saveSettings, repos = createGitHubRepos() }) {
  const workspaceFolders = () => registry.list().flatMap(project => (project.folders || []).map(folder => folder.path));
  return async ({ req, res, url }) => {
    if (url.pathname !== '/api/github/repos' && url.pathname !== '/api/github/clone') return false;
    if (req.phoneClient) fail('Open GitHub repositories on the computer.', 403);
    const cloneFolder = settings().githubCloneFolder || null;
    if (url.pathname === '/api/github/repos') {
      if (req.method !== 'GET') fail('Use GET to list repositories.', 405);
      const folders = workspaceFolders(), { host, hosts } = await repos.signedIn(url.searchParams.get('host'));
      json(res, 200, { ...await repos.list({ folders, cloneFolder, host }), hosts, cloneFolder: cloneFolder ? tilde(cloneFolder) : null, suggestedFolder: suggestedCloneFolder(folders) }); return true;
    }
    if (req.method !== 'POST') fail('Use POST to clone a repository.', 405);
    const input = await body(req, 8 * 1024);
    const folder = input.cloneFolder === undefined || input.cloneFolder === null ? cloneFolder : expandFolder(input.cloneFolder);
    // No host means github.com, as backups and earlier windows send.
    const host = input.host === undefined || input.host === null ? DEFAULT_HOST : (await repos.signedIn(input.host)).host;
    const result = await repos.clone({ repository: input.repository, cloneFolder: folder, folders: workspaceFolders(), host });
    // The folder is remembered once a clone into it works, so the next one goes there without asking.
    if (result.cloned && folder !== cloneFolder) saveSettings({ githubCloneFolder: folder });
    // Importing a backup (#160) clones folders for a workspace it makes itself, so it asks for the folder only.
    const project = input.workspace === false ? null : registry.add({ folders: [result.path] });
    json(res, 201, { ...result, project, cloneFolder: (result.cloned ? folder : cloneFolder) ? tilde(result.cloned ? folder : cloneFolder) : null }); return true;
  };
}

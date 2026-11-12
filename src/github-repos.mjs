import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { command } from './routing-references.mjs';
import { gitExecutable } from './resolve-binary.mjs';
import { friendlyError } from './github-context.mjs';

// Open a GitHub repository as a workspace (#159). The list comes from the person's own gh login, so Codeshi asks for no
// sign-in and stores no token. Cloning runs gh repo clone, which uses the person's git with that same login. Nothing is
// pushed, and nothing is fetched in the background: one list per opening of the panel, one clone per click.

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

// owner/name of a folder's origin on GitHub, lower-cased for comparison, or null.
export function originRepository(folder, spawnImpl = spawnSync) {
  const result = spawnImpl(gitExecutable(), ['-C', folder, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 3000, shell: false, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) return null;
  const match = String(result.stdout || '').trim().match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

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

export function createGitHubRepos({ run = command, origin = originRepository } = {}) {
  const cloning = new Set();
  const gh = (args, options = {}) => run('gh', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...options });

  async function account() {
    try { return JSON.parse(await gh(['api', 'user', '--jq', '{login: .login, name: .name}'])); }
    catch (error) { throw ghError(error, 'your account'); }
  }

  // Your repositories, your organizations' and those you collaborate on, most recently pushed first.
  async function list({ folders = [], cloneFolder = null } = {}) {
    const fetchPage = page => gh(['api', `user/repos?per_page=${PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, '--jq', FIELDS]).catch(error => { throw ghError(error, 'your repositories'); });
    const [who, first] = await Promise.all([account(), fetchPage(1)]), repos = [];
    let more = false;
    for (let page = 1; page <= PAGES; page++) {
      const output = page === 1 ? first : await fetchPage(page);
      const rows = String(output || '').split('\n').filter(Boolean).map(line => JSON.parse(line));
      repos.push(...rows);
      if (rows.length < PAGE) break;
      if (page === PAGES) more = true;
    }
    const clones = localClones({ folders, cloneFolder, origin });
    return {
      account: who,
      more,
      repos: repos.filter(repo => typeof repo.fullName === 'string' && NAME.test(repo.fullName)).map(repo => ({
        fullName: repo.fullName, description: typeof repo.description === 'string' ? repo.description.slice(0, 300) : '',
        private: repo.private === true, fork: repo.fork === true, archived: repo.archived === true, pushedAt: repo.pushedAt || null,
        url: typeof repo.url === 'string' && repo.url.startsWith('https://github.com/') ? repo.url : `https://github.com/${repo.fullName}`,
        local: clones.get(repo.fullName.toLowerCase()) || null,
      })),
    };
  }

  // A folder for the repository: an existing clone if there is one, else a fresh clone inside the chosen folder.
  async function clone({ repository, cloneFolder, folders = [] }) {
    const name = validRepository(repository), key = name.toLowerCase();
    const existing = localClones({ folders, cloneFolder: cloneFolder && isDirectory(cloneFolder) ? cloneFolder : null, origin }).get(key);
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
      await gh(['repo', 'clone', name, target], { timeout: CLONE_TIMEOUT, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      // gh and git remove a failed clone themselves; a clone stopped by the time limit can leave its folder behind.
      if (isDirectory(target) && origin(target) === null) try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* Left for the person. */ }
      const text = `${error?.message || ''}\n${error?.stderr || ''}`;
      if (error?.killed || /timed? ?out/i.test(text)) fail(`Cloning ${name} took longer than 10 minutes and was stopped. Clone it in a terminal, then add the folder.`, 504);
      if (/GitHub CLI unavailable|ENOENT|not logged in|gh auth login|authentication|HTTP 401/i.test(text)) throw ghError(error);
      if (/Could not resolve|not found|HTTP 404/i.test(text)) fail(`Couldn't find ${name} on GitHub, or your gh login can't see it.`, 404);
      const detail = String(error?.stderr || '').trim().split('\n').slice(-3).join('\n');
      fail(`Couldn't clone ${name}.${detail ? `\n${detail}` : ''}`, 502);
    } finally { cloning.delete(target); }
    return { path: target, cloned: true };
  }

  return { list, clone };
}

export function createGitHubRepoRoutes({ registry, body, json, settings, saveSettings, repos = createGitHubRepos() }) {
  const workspaceFolders = () => registry.list().flatMap(project => (project.folders || []).map(folder => folder.path));
  return async ({ req, res, url }) => {
    if (url.pathname !== '/api/github/repos' && url.pathname !== '/api/github/clone') return false;
    if (req.phoneClient) fail('Open GitHub repositories on the computer.', 403);
    const cloneFolder = settings().githubCloneFolder || null;
    if (url.pathname === '/api/github/repos') {
      if (req.method !== 'GET') fail('Use GET to list repositories.', 405);
      const folders = workspaceFolders();
      json(res, 200, { ...await repos.list({ folders, cloneFolder }), cloneFolder: cloneFolder ? tilde(cloneFolder) : null, suggestedFolder: suggestedCloneFolder(folders) }); return true;
    }
    if (req.method !== 'POST') fail('Use POST to clone a repository.', 405);
    const input = await body(req, 8 * 1024);
    const folder = input.cloneFolder === undefined || input.cloneFolder === null ? cloneFolder : expandFolder(input.cloneFolder);
    const result = await repos.clone({ repository: input.repository, cloneFolder: folder, folders: workspaceFolders() });
    // The folder is remembered once a clone into it works, so the next one goes there without asking.
    if (result.cloned && folder !== cloneFolder) saveSettings({ githubCloneFolder: folder });
    // Importing a backup (#160) clones folders for a workspace it makes itself, so it asks for the folder only.
    const project = input.workspace === false ? null : registry.add({ folders: [result.path] });
    json(res, 201, { ...result, project, cloneFolder: (result.cloned ? folder : cloneFolder) ? tilde(result.cloned ? folder : cloneFolder) : null }); return true;
  };
}

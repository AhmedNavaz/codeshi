import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { commandEnvironment, gitExecutable } from './resolve-binary.mjs';
import { githubRepository } from './workspace-git.mjs';
import { privatePath } from './task-context.mjs';

const clip = (value, limit) => {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}\n[Excerpt truncated]` : text;
};
async function command(bin, args, { cwd, signal }) {
  // Resolve gh from absolute PATH entries; Windows otherwise also searches the project directory.
  if (bin === 'gh') {
    const env = commandEnvironment(), search = (env.PATH || env.Path || '').split(path.delimiter);
    let found;
    for (const directory of search) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, process.platform === 'win32' ? 'gh.exe' : 'gh');
      try { if ((await fs.stat(candidate)).isFile()) { await fs.access(candidate, fs.constants.X_OK); found = candidate; break; } } catch { /* Try the next installation. */ }
    }
    if (!found) throw new Error('GitHub CLI unavailable');
    bin = found;
  }
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd, signal, timeout: 4000, maxBuffer: 512 * 1024, shell: false,
      env: { ...commandEnvironment(), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end();
  });
}

// Read only explicit references, never instructions found inside retrieved content. Cache is workspace-local,
// short lived and bounded; local plans are read afresh. No model call is needed to build this evidence.
export class RoutingReferences {
  constructor({ run = command, now = Date.now } = {}) { this.run = run; this.now = now; this.cache = new Map(); }

  async issue(repo, number, options) {
    const key = `${repo}#${number}`, cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 60000) return cached.value;
    const issue = JSON.parse(await this.run('gh', ['api', '--hostname', 'github.com', `repos/${repo}/issues/${number}`], options));
    let comments = [], commentsUnavailable = false;
    if (issue.comments > 0) {
      try {
        const page = Math.ceil(issue.comments / 3);
        comments = JSON.parse(await this.run('gh', ['api', '--hostname', 'github.com', `repos/${repo}/issues/${number}/comments?per_page=3&page=${page}`], options));
      } catch { commentsUnavailable = true; }
    }
    const value = { reference: key, title: clip(issue.title, 240), state: issue.state, updatedAt: issue.updated_at,
      body: clip(issue.body, 2600), recentComments: comments.slice(-3).map(comment => clip(comment.body, 500)),
      commentsOmitted: Math.max(0, (issue.comments || 0) - comments.length), ...(commentsUnavailable ? { commentsUnavailable: true } : {}) };
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  async plan(token, folders) {
    const qualified = folders.filter(folder => token.startsWith(`${folder.name}/`));
    const matches = [];
    for (const folder of qualified.length ? qualified : folders) {
      const relative = qualified.length ? token.slice(folder.name.length + 1) : token;
      if (privatePath(relative) || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
      try {
        const root = await fs.realpath(folder.path), file = await fs.realpath(path.join(root, relative));
        const realRelative = path.relative(root, file);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative) || privatePath(realRelative)) continue;
        const handle = await fs.open(file, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 256 * 1024) continue;
          const bytes = Buffer.alloc(Math.min(stat.size, 16000));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          const text = bytes.subarray(0, bytesRead).toString('utf8');
          const pending = text.split('\n').filter(line => /^\s*[-*]\s+\[ \]/.test(line)).slice(0, 12);
          matches.push({ reference: `${folder.name}/${relative}`, body: clip(text, 2600), pendingSteps: pending.map(line => clip(line, 160)), truncated: stat.size > bytesRead || text.length > 2600 });
        } finally { await handle.close(); }
      } catch { /* Missing or inaccessible references are reported below. */ }
    }
    return matches.length === 1 ? matches[0] : { reference: token, unavailable: matches.length > 1 ? 'Ambiguous plan path; qualify with workspace folder name.' : 'Plan could not be read inside the workspace.' };
  }

  async resolve(text, broker) {
    const folders = broker.workspaceFolders || [], options = { cwd: broker.workspace || folders[0]?.path, signal: AbortSignal.timeout(4500) };
    const refs = [], seen = new Set();
    const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b|(?<![\w/])([\w.-]+\/[\w.-]+)?#(\d+)\b|(?<![\w/])((?:[\w.-]+\/)*[\w.-]+\.(?:md|txt))\b|\bissue\s+(?:number\s+)?(\d+)\b/gi;
    let repo;
    for (const match of text.matchAll(pattern)) {
      if (refs.length >= 3) break;
      const token = match[5];
      if (token && !/plan|roadmap/i.test(token) && !/\bplan\b/i.test(text)) continue;
      const key = match[0]; if (seen.has(key)) continue; seen.add(key);
      try {
        if (token) { refs.push(await this.plan(token, folders)); continue; }
        let owner = match[1] || match[3];
        if (!owner) {
          if (repo === undefined) repo = githubRepository(await this.run(gitExecutable(), ['config', '--get', 'remote.origin.url'], options))?.replace('https://github.com/', '') || null;
          owner = repo;
        }
        if (!owner) throw new Error('No GitHub origin');
        refs.push(await this.issue(owner, match[2] || match[4] || match[6], options));
      } catch { refs.push({ reference: key, unavailable: 'Issue could not be retrieved; do not assume its scope from the reference alone.' }); }
    }
    // Also bound JSON escaping, metadata and unusually long paths.
    const result = [];
    for (const ref of refs) { if (JSON.stringify([...result, ref]).length > 9000) { result.push({ reference: clip(ref.reference, 160), unavailable: 'Reference evidence limit reached.' }); break; } result.push(ref); }
    return result;
  }
}

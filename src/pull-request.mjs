import { command } from './routing-references.mjs';
import { githubRepository } from './workspace-git.mjs';
import { redactPublicText, scanSecrets } from './collaboration-format.mjs';
import { exclusive, firstLines, git } from './workspace-commit.mjs';
import { friendlyError } from './github-context.mjs';

// Opening a pull request from the Git panel (#18, stage 3). This is the one place Codeshi pushes, and only when the
// person clicks Open pull request after seeing the remote, the branch, the base and the commits. Agents never push.
//
// The preview reads local Git and asks GitHub, through the person's own gh login, whether the branch already has an
// open pull request. Its title and description are drafted from what Codeshi recorded, with no model call: the
// branch's commits, the request that started the work and Codeshi's own last test result, cleaned as exports are.
// Pushing uses the person's own Git setup (credentials, SSH keys and pre-push hooks), never force-pushes, and never
// writes to the base branch on GitHub. A folder on its base branch first moves its new commits to a branch the person
// names, and the base branch goes back to where the remote has it.

const TITLE_LIMIT = 256, BODY_LIMIT = 60000, COMMITS_SHOWN = 30, OUTPUT_LIMIT = 6000;
const fail = (message, status = 400, details = null) => { throw Object.assign(new Error(message), { status, ...details ? { details } : {} }); };
const gh = (run, args, cwd, extra = {}) => run('gh', args, { cwd, timeout: 20000, maxBuffer: 1024 * 1024, ...extra });

async function read(root, args) { const result = await git(root, args, { timeout: 10000 }); return result.status ? null : result.stdout.trim(); }

// The branch, the repository on GitHub, its base branch and what this branch holds that the base doesn't, all from
// local Git. The base comes from origin/HEAD, or from GitHub when the clone never recorded it.
async function facts(root, { run, cwd }) {
  const branch = await read(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) fail('This folder isn’t on a branch (detached HEAD). Switch to a branch first.', 409);
  const head = await read(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head) fail('There are no commits yet. Commit your changes first.', 409);
  const repoURL = githubRepository(await read(root, ['config', '--get', 'remote.origin.url']) || '');
  if (!repoURL) fail('This folder has no GitHub remote named origin.', 409);
  const repo = repoURL.replace('https://github.com/', '');
  let base = (await read(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '') || null;
  if (!base) {
    try { base = String(await gh(run, ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], cwd)).trim() || null; }
    catch (error) { throw friendlyError(error, repo); }
  }
  if (!base) fail('Couldn’t tell which branch the pull request should merge into.', 502);
  const remoteBase = await read(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
  let commits = [], commitCount = null, since = null;
  if (remoteBase) {
    commitCount = Number(await read(root, ['rev-list', '--count', `${remoteBase}..HEAD`]) || 0);
    const log = await read(root, ['log', `-${COMMITS_SHOWN}`, '--format=%H%x1f%h%x1f%s%x00', `${remoteBase}..HEAD`]) || '';
    commits = log.split('\0').map(row => row.trim()).filter(Boolean).map(row => { const [hash, shortHash, ...subject] = row.split('\x1f'); return { hash, shortHash, subject: subject.join('\x1f') }; });
    const fork = await read(root, ['merge-base', remoteBase, 'HEAD']);
    since = fork ? await read(root, ['log', '-1', '--format=%cI', fork]) : null;
  }
  const upstream = await read(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const remoteBranch = await read(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  const unpushed = remoteBranch ? Number(await read(root, ['rev-list', '--count', `${remoteBranch}..HEAD`]) || 0) : commitCount;
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  let uncommitted = 0;
  if (!status.status) for (let i = 0, entries = status.stdout.split('\0'); i < entries.length; i++) { if (entries[i].length < 4) continue; uncommitted++; if (/[RC]/.test(entries[i].slice(0, 2))) i++; }
  return { branch, head, repo, repoURL, base, remoteBase, commits, commitCount, since, upstream, remoteBranch: Boolean(remoteBranch), unpushed, uncommitted, onBase: branch === base };
}

// The open pull request for this branch, if there is one. A failure here leaves the decision to gh pr create.
async function openPull(run, repo, branch, cwd) {
  try {
    const [pull] = JSON.parse(await gh(run, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url,title,isDraft', '--limit', '1'], cwd));
    return pull ? { number: pull.number, url: pull.url, title: pull.title, draft: Boolean(pull.isDraft) } : null;
  } catch (error) {
    const friendly = friendlyError(error);
    if (friendly.status === 400) throw friendly; // gh is missing or signed out: opening would fail the same way.
    return null;
  }
}

// --- Drafting from records ------------------------------------------------------------------------------------------

const GITHUB_NOTE = /^The (issue|pull request) below was read from GitHub for context\.[^\n]*\n+# GitHub (?:issue|pull request) ([\w.-]+\/[\w.-]+)#(\d+): ([^\n]+)/;
const words = (text, limit) => {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1), space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
};
const sentence = text => text ? text[0].toUpperCase() + text.slice(1) : text;
const branchTitle = branch => sentence(branch.replace(/^[\w-]+\//, '').replace(/[-_]+/g, ' ').trim()) || branch;

// The requests that belong to this branch: the person's messages since the base the branch grew from. The first is
// the one that started the work; GitHub issues brought in as context become links instead of their copied text.
export function branchRequests(conversation, since) {
  const after = since ? Date.parse(since) : NaN;
  const messages = (conversation?.messages || []).filter(message => message.role === 'user' && typeof message.text === 'string' && message.text.trim());
  const relevant = Number.isFinite(after) ? messages.filter(message => Date.parse(message.createdAt) >= after) : [];
  // Without a base to date from: the last request of the person's own, with any GitHub context brought in after it.
  const lastPlain = messages.findLastIndex(message => !GITHUB_NOTE.test(message.text));
  const chosen = relevant.length ? relevant : messages.slice(Math.max(0, lastPlain));
  const linked = new Map(), requests = [];
  for (const message of chosen) {
    const match = message.text.match(GITHUB_NOTE);
    if (match) { if (!linked.has(`${match[2]}#${match[3]}`)) linked.set(`${match[2]}#${match[3]}`, { kind: match[1], repo: match[2], number: Number(match[3]), title: match[4].trim() }); continue; }
    requests.push(message.text.trim());
  }
  return { requests, linked: [...linked.values()] };
}

// Codeshi's own last test result in this conversation: the Run panel's test command after a routed run.
function lastTests(conversation) {
  const run = (conversation?.runs || []).findLast(item => ['passed', 'failed'].includes(item.check?.status));
  return run ? { status: run.check.status, command: run.check.command, at: run.endedAt || run.startedAt || null } : null;
}

export function draftPullRequest({ branch, repo, commits, commitCount, conversation, since, folders = [] }) {
  const { requests, linked } = branchRequests(conversation, since);
  const issue = linked.find(item => item.kind === 'issue' && item.repo.toLowerCase() === repo.toLowerCase());
  const opening = requests[0] ? requests[0].split(/\n\s*\n/)[0] : '';
  const title = commits.length === 1 && commitCount === 1 ? commits[0].subject : issue ? issue.title : opening && opening.length >= 12 ? sentence(words(opening, 72)) : commits[0]?.subject || branchTitle(branch);
  const body = [];
  if (opening && opening !== title) body.push(words(opening, 600), '');
  if (linked.length) body.push(...linked.map(item => `Related to ${item.repo.toLowerCase() === repo.toLowerCase() ? '' : item.repo}#${item.number}`), '');
  if (commits.length) {
    body.push('## Changes', '', ...commits.map(commit => `- ${commit.subject}`));
    if (commitCount > commits.length) body.push(`- …and ${commitCount - commits.length} more`);
    body.push('');
  }
  const tests = lastTests(conversation);
  if (tests) body.push('## Tests', '', `- \`${tests.command}\` ${tests.status === 'passed' ? 'passed' : 'failed'} in Codeshi${tests.at ? ` on ${tests.at.slice(0, 10)}` : ''}.`, '');
  return { title: clean(words(title, TITLE_LIMIT), folders), body: clean(body.join('\n').trim(), folders).slice(0, BODY_LIMIT) };
}

// Same cleaning as exports: workspace folders become their names, then secrets and other local paths are removed.
function clean(text, folders) {
  const named = [...folders].sort((a, b) => b.path.length - a.path.length).reduce((value, folder) => value.split(folder.path).join(`[${folder.displayName || folder.name}]`), String(text || ''));
  return redactPublicText(named);
}

// --- Preview and open -----------------------------------------------------------------------------------------------

function nameFor(text) {
  const slug = String(text || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/[\s_-]+/).filter(Boolean).slice(0, 6).join('-').slice(0, 48).replace(/-+$/, '');
  return slug || 'changes';
}

export async function pullRequestPreview(folder, { conversation = null, folders = [folder] } = {}, { run = command } = {}) {
  const root = await read(folder.path, ['rev-parse', '--show-toplevel']);
  if (!root) fail('No Git repository in this folder.', 404);
  const found = await facts(root, { run, cwd: folder.path });
  const existing = found.onBase ? null : await openPull(run, found.repo, found.branch, folder.path);
  const draft = draftPullRequest({ ...found, conversation, folders });
  // Up to date: the open pull request already has every commit, so there's nothing to push.
  const upToDate = Boolean(existing && found.remoteBranch && found.unpushed === 0);
  const blocked = found.commitCount !== 0 || upToDate ? null : found.onBase ? `${found.base} has no commits that GitHub doesn’t have. Commit your changes first.` : existing ? null : `${found.branch} has no commits that ${found.base} doesn’t have. Commit your changes first.`;
  return {
    folderId: folder.id, repo: found.repo, repoURL: found.repoURL, remote: 'origin', branch: found.branch, base: found.base, head: found.head,
    onBase: found.onBase, compared: found.remoteBase !== null, commits: found.commits.map(({ shortHash, subject }) => ({ shortHash, subject })), commitCount: found.commitCount,
    published: found.remoteBranch, unpushed: found.unpushed, uncommitted: found.uncommitted, existing, upToDate, blocked,
    suggestedBranch: found.onBase ? nameFor(draft.title) : null, draft,
  };
}

const PUSH_HINTS = [
  [/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i, branch => `GitHub has commits on ${branch} that this folder doesn’t. Pull them in a terminal, then try again. Codeshi never force-pushes.`],
  [/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|403|denied to/i, () => 'Git couldn’t sign in to GitHub to push. Run gh auth setup-git in a terminal (or set up your SSH key), then try again.'],
  [/hook declined|pre-push/i, () => 'A pre-push hook stopped the push. Its output is below.'],
];

export async function openPullRequest(folder, input = {}, { run = command, withMutation } = {}) {
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim(), body = String(input.body ?? '').trim();
  if (!title) fail('Write a title for the pull request.');
  if (title.length > TITLE_LIMIT) fail('The title is too long.');
  if (body.length > BODY_LIMIT) fail('The description is too long.');
  const secrets = scanSecrets({ title, body }).filter(warning => warning.code !== 'absolute-path');
  if (secrets.length) fail('The title or description has something that looks like a secret. Remove it before opening the pull request.', 409, { code: 'secret' });
  const expected = input.expected || {};
  return exclusive(folder, 'Opening a pull request', async ({ root }) => {
    const found = await facts(root, { run, cwd: folder.path });
    if (found.branch !== expected.branch || found.head !== expected.head || found.base !== expected.base) fail('The branch changed since you looked. Review it again before opening the pull request.', 409, { code: 'changed' });
    let branch = found.branch, createdBranch = null, restoredBase = null;
    if (found.onBase) {
      const name = String(input.newBranch || '').trim();
      if (!name) fail(`Name a new branch for these commits: a pull request can’t come from ${found.base} itself.`);
      if (name === found.base || (await git(root, ['check-ref-format', '--branch', name])).status) fail(`${name} isn’t a valid branch name.`);
      if (await read(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) || await read(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])) fail(`A branch named ${name} already exists. Choose another name.`, 409);
      const switched = await git(root, ['switch', '--quiet', '-c', name]);
      if (switched.status) fail(`Git couldn’t create ${name}: ${firstLines(switched.stderr)}`, 409);
      branch = createdBranch = name;
      // The base goes back to where the remote has it, only when it simply ran ahead: nothing is lost, since the new branch holds the commits.
      restoredBase = false;
      if (found.remoteBase && !(await git(root, ['merge-base', '--is-ancestor', found.remoteBase, found.head])).status) {
        restoredBase = !(await git(root, ['branch', '--force', found.base, found.remoteBase])).status;
      }
    } else if (input.newBranch) fail('This folder is already on its own branch.');
    const existing = found.onBase ? null : await openPull(run, found.repo, branch, folder.path);
    const moved = { createdBranch, restoredBase, base: found.base };
    // Push the branch to the same name on GitHub, and track it. A plain push: never forced, never to the base.
    if (found.unpushed !== 0 || !found.remoteBranch || createdBranch) {
      const pushed = await git(root, ['push', '--porcelain', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { timeout: 3 * 60 * 1000 });
      if (pushed.status) {
        const output = `${pushed.stdout}\n${pushed.stderr}`.trim().slice(-OUTPUT_LIMIT);
        const hint = pushed.timedOut ? 'The push took more than three minutes, so it was stopped. Git may be waiting for a password or a pre-push hook.' : PUSH_HINTS.find(([pattern]) => pattern.test(output))?.[1](branch);
        fail(hint || `Git couldn’t push ${branch}: ${firstLines(pushed.stderr || pushed.stdout)}`, 409, { code: 'push', output, ...moved });
      }
    }
    if (existing) return { pull: existing, branch, pushed: true, updated: true, ...moved };
    let url;
    try {
      const out = await gh(run, ['pr', 'create', '--repo', found.repo, '--base', found.base, '--head', branch, '--title', title, '--body', body, ...input.draft ? ['--draft'] : []], folder.path, { timeout: 60000 });
      url = String(out).trim().split('\n').reverse().find(line => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(line.trim()))?.trim();
    } catch (error) {
      const text = `${error?.message || ''}\n${error?.stderr || ''}`;
      const reused = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
      if (/already exists/i.test(text) && reused) return { pull: { url: reused, number: Number(reused.split('/').pop()) }, branch, pushed: true, updated: true, ...moved };
      const friendly = friendlyError(error, found.repo);
      fail(`${branch} was pushed, but the pull request couldn’t be opened. ${friendly.message}`, friendly.status || 502, { code: 'create', ...moved });
    }
    if (!url) fail(`${branch} was pushed, but GitHub didn’t return the pull request’s link. Check GitHub.`, 502, { code: 'create', ...moved });
    return { pull: { url, number: Number(url.split('/').pop()), draft: Boolean(input.draft) }, branch, pushed: true, updated: false, ...moved };
  }, { withMutation });
}

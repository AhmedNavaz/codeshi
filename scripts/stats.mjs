#!/usr/bin/env node
// What can be known about who's using Codeshi, from what GitHub already records: `npm run stats`. The app sends nothing anywhere
// for this. Its updater downloads the same files as a person does, so a release's downloads include the people who updated to it,
// which is the closest thing there is to a count of who's still using it. Repository traffic needs your own GitHub login, and
// website visitors are in Vercel's Analytics tab.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'AhmedNavaz/codeshi';
const PLATFORMS = [[/mac-apple-silicon/, 'macOS Apple Silicon'], [/mac-intel/, 'macOS Intel'], [/windows/, 'Windows']];
const platformOf = name => PLATFORMS.find(([pattern]) => pattern.test(name))?.[1] || 'Other';

// Downloads by release and by platform. Only the app counts: a checksum file isn't someone getting it.
export function summarize(releases) {
  const rows = releases.filter(release => !release.draft).map(release => {
    const files = (release.assets || []).filter(asset => asset.name.endsWith('.zip')), platforms = {};
    for (const file of files) platforms[platformOf(file.name)] = (platforms[platformOf(file.name)] || 0) + file.download_count;
    return { version: release.tag_name, publishedAt: release.published_at, total: files.reduce((sum, file) => sum + file.download_count, 0), platforms };
  });
  const platforms = {};
  for (const row of rows) for (const [name, count] of Object.entries(row.platforms)) platforms[name] = (platforms[name] || 0) + count;
  return { rows, total: rows.reduce((sum, row) => sum + row.total, 0), platforms };
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
async function main() {
  const secret = token(), headers = { Accept: 'application/vnd.github+json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
  const read = async path => { const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, { headers }); return response.ok ? response.json() : null; };
  const [repository, releases, views, clones] = await Promise.all([read(''), read('/releases?per_page=100'), read('/traffic/views'), read('/traffic/clones')]);
  if (!repository || !releases) throw new Error('GitHub could not be read. Check your connection, or sign in with gh auth login.');
  const { rows, total, platforms } = summarize(releases), lines = [];
  lines.push(`Downloads: ${total.toLocaleString()}`);
  for (const [name, count] of Object.entries(platforms).sort((a, b) => b[1] - a[1])) lines.push(`  ${name.padEnd(22)}${count.toLocaleString()}`);
  lines.push('', 'Latest releases (people downloading or updating):');
  for (const row of rows.slice(0, 6)) lines.push(`  ${row.version.padEnd(10)}${String(row.publishedAt).slice(0, 10)}  ${row.total.toLocaleString()}`);
  lines.push('', `Stars ${repository.stargazers_count} · Forks ${repository.forks_count} · Watching ${repository.subscribers_count} · Open issues and pull requests ${repository.open_issues_count}`);
  lines.push(views && clones ? `Last 14 days on GitHub: ${views.uniques} visitors (${views.count} views), ${clones.uniques} cloners (${clones.count} clones)` : 'Repository traffic needs a GitHub login with push access: gh auth login');
  lines.push('', 'Website visitors: the Analytics tab of the codeshi-web project on Vercel.');
  console.log(lines.join('\n'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

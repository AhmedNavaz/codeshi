import fs from 'node:fs';
import { atomicJSON } from '../src/patches.mjs';

export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/;
export function compareVersions(left, right) {
  const a = left.match(versionPattern), b = right.match(versionPattern);
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]) ? 1 : -1;
  if (a[4] === b[4]) return 0;
  if (!a[4] || !b[4]) return a[4] ? -1 : 1;
  const ap = a[4].split('.'), bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return Number(ap[i]) > Number(bp[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}

// The installed changelog is the source of truth. Unreleased and newer entries never appear.
// Summarize each item to a brief user-facing sentence without GitHub issue/PR references or HTML.
function summarizeItem(line, stripRefs = false) {
  let text = line
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
  if (stripRefs) {
    text = text
      .replace(/\s*\((?:[^()]*#\d+[^()]*|thanks\s+@[^()]+)\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const boundary = text.search(/[.!?]\s+(?=[A-Z0-9"“‘(<])/);
    if (boundary !== -1) text = text.slice(0, boundary + 1);
  }
  return text.slice(0, 320);
}

const internalSectionPattern = /^(?:internal|developer|tooling|tests?|documentation|docs|chores?|maintenance|infrastructure|ci|build)\b/i;

const internalPatterns = [
  /\b(?:backend\s+modules?|source\s+code|codebase|repository\s+root|repo\s+layout|directory\s+structure)\b/i,
  /\b(?:live|lives|moved)\s+in\s+`?src\/?`?/i,
  /\bcontributor\s+documentation\b/i,
  /\bdeveloper\s+documentation\b/i,
  /\b(?:test\s+coverage|tests?\s+cover|unit\s+tests?|automated\s+checks?|smoke\s+tests?)\b/i,
  /\b(?:sharing-container\s+inputs?|build\s+pipeline|packaging\s+inputs?|CI\/CD|dockerfile)\b/i,
  /\b(?:social-preview\s+artwork|package\s+description\s+in\s+the\s+README)\b/i,
  /\bseparate\s+interface\s+and\s+HTTP\s+route\s+modules\b/i,
];

function isUserFacingItem(text) {
  return !internalPatterns.some(pattern => pattern.test(text));
}

export function releaseNotes(changelog, current, since = null) {
  const releases = []; let release, section;
  for (const line of changelog.slice(0, 256 * 1024).split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const heading = line.match(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/);
      release = heading && versionPattern.test(heading[1]) ? { version: heading[1], date: heading[2] || null, sections: [] } : null;
      section = null; if (release) releases.push(release);
    } else if (release && line.startsWith('### ')) {
      const title = summarizeItem(line.slice(4)).slice(0, 80);
      section = internalSectionPattern.test(title) ? null : { title, items: [] };
      if (section && release.sections.length < 8) release.sections.push(section);
    } else if (section && /^- /.test(line) && isUserFacingItem(line) && section.items.length < 20) {
      section.items.push(summarizeItem(line.slice(2), true));
    }
  }
  if (!releases.some(item => compareVersions(item.version, current) === 0)) return [];
  const available = releases
    .map(item => ({ ...item, sections: item.sections.filter(s => s.items.length > 0) }))
    .filter(item => item.sections.length > 0 && compareVersions(item.version, current) <= 0);
  if (since) {
    return available
      .filter(item => compareVersions(item.version, since) > 0)
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, 5);
  }
  const matching = available.filter(item => compareVersions(item.version, current) === 0);
  if (matching.length > 0) return matching;
  const latest = available.sort((a, b) => compareVersions(b.version, a.version))[0];
  return latest ? [latest] : [];
}

// App bundles change when updated, reinstalled or translocated. Only the app version decides
// whether to announce an update; saved workspaces always open normally.
export function createReleaseState({ filename, version, changelog = '', existing = false }) {
  if (!versionPattern.test(version)) throw new Error('Invalid application version.');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const previous = typeof saved?.lastSeenVersion === 'string' && versionPattern.test(saved.lastSeenVersion) ? saved.lastSeenVersion : null;
  let updated = previous ? compareVersions(version, previous) > 0 : existing || typeof saved?.install === 'string';
  const record = () => atomicJSON(filename, { version: 2, lastSeenVersion: version });
  if (!updated && !previous) record(); // A fresh profile starts onboarding without an update announcement.
  const get = () => ({ version, previousVersion: previous, updated, releases: releaseNotes(changelog, version, updated ? previous : null) });
  return {
    get,
    acknowledge() { if (updated) { record(); updated = false; } return get(); },
  };
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReleaseState, releaseNotes } from '../desktop/updates.mjs';

const changelog = `# Changelog
## [Unreleased]
### Added
- This is not shipped.
## [1.0.0] - 2026-11-10
### Added
- Future work.
## [0.10.0] - 2026-11-02
### Added
- A **new feature** with \`code\` and [details](https://example.com).
## [0.9.2] - 2026-11-01
### Fixed
- Recent fixes.
## [0.9.1] - 2026-10-31
### Fixed
- Earlier fixes.
## [0.9.0] - 2026-10-31
### Added
- Code review.
`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'throughline-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'install.json');
  const open = (version, existing = true) => createReleaseState({ filename, version, changelog, existing });
  return { root, filename, open };
}

test('a new profile starts setup without announcing an update, including on its next launch', t => {
  const f = fixture(t), first = f.open('0.9.1', false);
  assert.equal(first.get().updated, false);
  assert.equal(f.open('0.9.1').get().updated, false);
  assert.equal(JSON.parse(fs.readFileSync(f.filename)).lastSeenVersion, '0.9.1');
});

test('updates announce once after dismissal, while preserving saved workspaces and settings', t => {
  const f = fixture(t); f.open('0.9.0', false);
  const data = path.join(f.root, 'relay-data'); fs.mkdirSync(data);
  const saved = { 'projects.json': '{"projects":[{"id":"original"}]}', 'settings.json': '{"appearance":"light"}', 'history.jsonl': 'original history\n' };
  for (const [name, text] of Object.entries(saved)) fs.writeFileSync(path.join(data, name), text);
  const update = f.open('0.10.0');
  assert.equal(update.get().updated, true); assert.equal(update.get().previousVersion, '0.9.0');
  assert.deepEqual(update.get().releases.map(item => item.version), ['0.10.0', '0.9.2', '0.9.1']);
  assert.equal(f.open('0.10.0').get().updated, true, 'Opening the panel does not acknowledge it.');
  update.acknowledge(); assert.equal(update.get().updated, false);
  assert.equal(f.open('0.10.0').get().updated, false, 'A same-version reinstall opens normally too.');
  assert.equal(f.open('1.0.0').get().updated, true);
  for (const [name, text] of Object.entries(saved)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), text);
});

test('old install markers and migrated profiles show current notes without inventing a previous version', t => {
  const f = fixture(t);
  for (const saved of [null, { version: 1, install: 'old-bundle-inode' }, { version: 2, lastSeenVersion: 'invalid' }]) {
    if (saved) fs.writeFileSync(f.filename, JSON.stringify(saved)); else if (fs.existsSync(f.filename)) fs.unlinkSync(f.filename);
    const old = f.open('0.9.1');
    assert.equal(old.get().updated, true); assert.equal(old.get().previousVersion, null);
    assert.deepEqual(old.get().releases.map(item => item.version), ['0.9.1']);
    old.acknowledge(); assert.equal(f.open('0.9.1').get().updated, false);
  }
});

test('downgrades and build metadata do not announce updates or lower the last seen version', t => {
  const f = fixture(t); f.open('0.10.0', false);
  const older = f.open('0.9.2'); assert.equal(older.get().updated, false); older.acknowledge();
  assert.equal(f.open('0.10.0+rebuilt').get().updated, false);
  assert.equal(f.open('0.10.0').get().updated, false);
  assert.equal(JSON.parse(fs.readFileSync(f.filename)).lastSeenVersion, '0.10.0');
});

test('prerelease updates follow numeric precedence and stable releases follow their prereleases', t => {
  const f = fixture(t); f.open('1.0.0-beta.2', false);
  const next = f.open('1.0.0-beta.10'); assert.equal(next.get().updated, true); next.acknowledge();
  assert.equal(f.open('1.0.0-beta.3').get().updated, false);
  assert.equal(f.open('1.0.0').get().updated, true);
});

test('a failed dismissal remains pending and can be retried', t => {
  const f = fixture(t); f.open('0.9.0', false); const update = f.open('0.9.1');
  fs.unlinkSync(f.filename); fs.mkdirSync(f.filename);
  assert.throws(() => update.acknowledge()); assert.equal(update.get().updated, true);
  fs.rmdirSync(f.filename); update.acknowledge(); assert.equal(f.open('0.9.1').get().updated, false);
});

test('bundled notes exclude unreleased and future work, use plain text and bound long histories', () => {
  const notes = releaseNotes(changelog, '0.10.0', '0.9.1');
  assert.deepEqual(notes.map(item => item.version), ['0.10.0', '0.9.2']);
  assert.equal(notes[0].sections[0].items[0], 'A new feature with code and details.');
  assert.equal(JSON.stringify(notes).includes('not shipped'), false);
  assert.deepEqual(releaseNotes(changelog, '0.8.0'), []);
  const many = Array.from({ length: 20 }, (_, index) => `## [0.${19-index}.0]\n### Added\n${'- '.concat('x'.repeat(index ? 10 : 3000), '\n').repeat(index ? 1 : 30)}`).join('\n');
  const bounded = releaseNotes(many, '0.19.0', '0.0.0'); assert.equal(bounded.length, 5);
  assert(bounded.every(release => release.sections.every(section => section.items.length <= 20 && section.items.every(text => text.length <= 2000))));
});

test('bundled notes filter out internal repository and developer items while preserving user-facing points', () => {
  const mixedChangelog = `# Changelog
## [0.13.0] - 2026-11-01
### Added
- **Project command controls (#47)**: Configure, inspect, and run persistent local commands.
### Changed
- Local backend modules now live in \`src/\`, with updated launch paths, tests, sharing-container inputs and contributor documentation.
### Internal
- Refactored test harness and build pipeline.
## [0.12.0] - 2026-11-01
### Added
- Workspace permission controls offer **Ask for permission** and **Full auto-approval**.
### Changed
- The composer uses a two-line agent/model control.
- Tests cover Claude Code and Codex discovery on Windows and Linux.
`;
  const notes = releaseNotes(mixedChangelog, '0.13.0', '0.11.0');
  assert.equal(notes.length, 2);

  // 0.13.0 has Added (Project command controls), but Changed (modules in src/) and Internal are excluded
  const rel13 = notes.find(r => r.version === '0.13.0');
  assert(rel13);
  assert.deepEqual(rel13.sections.map(s => s.title), ['Added']);
  assert.equal(rel13.sections[0].items.length, 1);
  assert.match(rel13.sections[0].items[0], /Project command controls/);
  assert.equal(JSON.stringify(rel13).includes('src/'), false);
  assert.equal(JSON.stringify(rel13).includes('backend modules'), false);

  // 0.12.0 keeps user-facing Changed item but filters test coverage item
  const rel12 = notes.find(r => r.version === '0.12.0');
  assert(rel12);
  const changedSection = rel12.sections.find(s => s.title === 'Changed');
  assert(changedSection);
  assert.deepEqual(changedSection.items, ['The composer uses a two-line agent/model control.']);
  assert.equal(JSON.stringify(rel12).includes('Tests cover'), false);
});

test('real changelog produces clean user-facing notes for 0.13.0 without internal refactoring', () => {
  const realChangelog = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8');
  const notes = releaseNotes(realChangelog, '0.13.0', '0.12.0');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].version, '0.13.0');
  assert.deepEqual(notes[0].sections.map(s => s.title), ['Added']);
  assert.match(notes[0].sections[0].items[0], /Project command controls/);
  assert.equal(JSON.stringify(notes).includes('src/'), false);
  assert.equal(JSON.stringify(notes).includes('backend modules'), false);
});

test('bundled notes fall back to latest user-facing release when current patch has only internal items', () => {
  const internalPatchChangelog = `# Changelog
## [0.10.1] - 2026-11-03
### Fixed
- Automated checks and unit tests for internal packaging.
## [0.10.0] - 2026-11-02
### Added
- A user facing feature.
`;
  const notes = releaseNotes(internalPatchChangelog, '0.10.1');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].version, '0.10.0');
  assert.equal(notes[0].sections[0].items[0], 'A user facing feature.');
});

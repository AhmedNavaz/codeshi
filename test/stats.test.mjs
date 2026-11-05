import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from '../scripts/stats.mjs';

test('downloads count the app by release and platform, and a checksum file is not someone getting it', () => {
  const { rows, total, platforms } = summarize([
    { tag_name: 'v2', published_at: '2026-11-05T00:00:00Z', assets: [{ name: 'Codeshi-2-mac-apple-silicon.zip', download_count: 5 }, { name: 'Codeshi-2-windows-x64.zip', download_count: 3 }, { name: 'SHA256SUMS.txt', download_count: 90 }] },
    { tag_name: 'v1', published_at: '2026-11-01T00:00:00Z', assets: [{ name: 'Throughline-1-mac-intel.zip', download_count: 2 }, { name: 'Codeshi-1-mac-apple-silicon.zip', download_count: 1 }] },
    { tag_name: 'draft', draft: true, assets: [{ name: 'Codeshi-3-windows-x64.zip', download_count: 50 }] },
  ]);
  assert.equal(total, 11);
  assert.deepEqual(rows.map(row => [row.version, row.total]), [['v2', 8], ['v1', 3]]);
  assert.deepEqual(platforms, { 'macOS Apple Silicon': 6, Windows: 3, 'macOS Intel': 2 });
  assert.deepEqual(summarize([]), { rows: [], total: 0, platforms: {} });
});

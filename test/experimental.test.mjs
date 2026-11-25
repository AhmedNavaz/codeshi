import assert from 'node:assert/strict';
import test from 'node:test';
import { preferencePatch, publicPreferences } from '../src/preferences.mjs';

test('experimental features have expected defaults and change one at a time', () => {
  assert.deepEqual(publicPreferences({}, true).experimental, { remote: true, plan: true, review: true, smartResults: false, tasks: true });
  const patch = preferencePatch({ experimental: { plan: false } }, {});
  assert.deepEqual(patch, { experimental: { remote: true, plan: false, review: true, smartResults: false, tasks: true } });
  assert.deepEqual(publicPreferences(patch, true).experimental, patch.experimental);
  assert.deepEqual(preferencePatch({ experimental: { remote: false } }, patch).experimental, { remote: false, plan: false, review: true, smartResults: false, tasks: true });
});

test('experimental features refuse unknown names and non-boolean values', () => {
  for (const bad of [null, [], 'plan', { plan: 'no' }, { unknown: true }]) assert.throws(() => preferencePatch({ experimental: bad }, {}), /experimental feature/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { preferencePatch, publicPreferences } from '../src/preferences.mjs';
import { prepareContext } from '../src/context.mjs';
import { verificationForRun } from '../src/verification.mjs';
import { ledgerFromRecords } from '../src/task-ledger.mjs';

test('testing cadence validates choices without changing other preferences', () => {
  assert.equal(publicPreferences({}, true).verificationCadence, 'as-needed');
  assert.deepEqual(preferencePatch({ verificationCadence: 'review-first' }, { theme: 'light' }), { verificationCadence: 'review-first' });
  for (const invalid of [null, false, 'never', {}, ['review-first']]) assert.throws(() => preferencePatch({ verificationCadence: invalid }), /Choose As needed or Review first/);
  assert.equal(publicPreferences({ verificationCadence: 'unknown' }, true).verificationCadence, 'as-needed');
});

test('testing cadence reaches every provider on fresh and resumed turns without replacing the current request', () => {
  for (const provider of ['codex', 'claude', 'gemini']) for (const fresh of [false, true]) {
    const c = { provider, mode: 'edit', sessions: { [provider]: { id: 'native-session', cursor: 1 } }, context: {}, messages: [{ seq: 1, role: 'user', text: 'Old testing preference' }] };
    for (const cadence of ['review-first', 'as-needed']) {
      const prepared = prepareContext(c, 'Commit the reviewed change', { fresh, verification: verificationForRun(cadence) });
      const envelope = JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf('\n') + 1));
      assert.equal(envelope.verification.cadence, cadence);
      assert.equal(envelope.currentRequest, 'Commit the reviewed change');
      assert.equal(prepared.metadata.verification.cadence, cadence);
      assert.match(prepared.prompt.split('\n')[0], /superseding older cadence settings/);
      assert.match(envelope.verification.instructions, /does not authorize a commit, push/);
      assert.equal(prepared.metadata.bytes, Buffer.byteLength(prepared.prompt));
      if (cadence === 'review-first') {
        assert.match(envelope.verification.instructions, /verify the relevant current changes before taking that action/);
        assert.match(envelope.verification.instructions, /never describe deferred checks as passed/);
      }
    }
  }
});

test('explicit test repairs and build-review workflows retain their checks in Review first', () => {
  assert.equal(verificationForRun('review-first', { retryOf: 'failed-run' }).required, 'test-repair');
  const review = verificationForRun('review-first', { automaticReview: { enabled: true } });
  assert.equal(review.required, 'build-review');
  assert.match(review.instructions, /still requires its configured checks/);
  assert.doesNotMatch(review.instructions, /defer broad test suites/);
});

test('deferred automatic tests cannot reuse an earlier pass as current verification', () => {
  const at = '2026-11-06T10:00:00.000Z';
  const submission = id => ({ type: 'submission', id, provider: 'codex', at, task: { id: 'task' }, message: { text: 'A change' } });
  const check = (id, status) => ({ type: 'check', runId: id, check: { status, command: 'npm test' } });
  const result = ledgerFromRecords([submission('first'), { type: 'run_end', status: 'complete', at }, check('first', 'passed'), submission('revised'), { type: 'run_end', status: 'complete', at }, check('revised', 'deferred')]);
  assert.equal(result.tasks[0].verification, 'unverified');
  assert.equal(result.tasks[0].latestCheck.status, 'deferred');
});

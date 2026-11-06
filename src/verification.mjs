// Testing cadence is the person's run preference, not permission to execute a command or publish changes.
// Keep it in every turn, including resumed sessions: an older instruction must not outlive a setting change.
export const verificationCadences = ['as-needed', 'review-first'];
export const verificationCadence = config => verificationCadences.includes(config.verificationCadence) ? config.verificationCadence : 'as-needed';

export function verificationForRun(cadence, { retryOf, automaticReview } = {}) {
  cadence = verificationCadences.includes(cadence) ? cadence : 'as-needed';
  const required = retryOf ? 'test-repair' : automaticReview ? 'build-review' : null;
  const instructions = cadence === 'review-first' && !required
    ? 'Review first: while the person reviews and requests revisions, defer broad test suites, repeated builds and exhaustive end-to-end checks. Use a syntax check or focused regression check only when needed to prevent a likely break or diagnose a failure. When explicitly asked to test, verify, finalize, commit, push, release or deploy the changes, verify the relevant current changes before taking that action. Reuse successful results only if their relevant code, configuration, dependencies and environment are unchanged. After fixes, rerun affected checks. Report what remains unverified; never describe deferred checks as passed.'
    : 'Use checks appropriate to the change. Prefer focused regression checks; avoid broad suites after every message and repeated successful checks without changed inputs or unresolved failures. Broaden verification when risk or the person’s testing/finalization request requires it.';
  return { cadence, ...(required ? { required } : {}), instructions: instructions + (required ? ' This explicitly selected test-repair or build/review workflow still requires its configured checks.' : '') + ' Explicit user requests and mandatory repository checks take precedence. This testing preference does not authorize a commit, push, release or other publication.' };
}

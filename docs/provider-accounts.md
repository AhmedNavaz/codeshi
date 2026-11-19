# Multiple provider accounts and quota aware continuation

Design proposal for [#186](https://github.com/AhmedNavaz/codeshi/issues/186). This describes proposed behavior and implementation requirements; multi-account support is not implemented by this change.

## Proposed behavior

Codeshi would let a person connect several accounts for Claude, Codex, or Gemini, see each account's allowance, and continue an unfinished task on another eligible account of the same provider before changing providers. Credentials remain managed by the official provider tools in separate local profiles.

Account rotation would follow the existing handoff and execution policies. Normal offers a switch where manual handoff is permitted; automatic rotation requires existing automatic-continuation authority, including Flow's execution policy. Adding an account grants no new execution or billing permission. Every switch is visible in the conversation.

This proposal answers the issue's three open questions: preserve existing switching permissions, group labelled accounts and their status in Settings, and start a fresh account-specific native session from the shared task brief while transferring only authorized queue entries.

## Scope and constraints

Support additional claude.ai subscription accounts through official Claude Code, Codex accounts through app-server/CLI, and Google accounts through managed Antigravity ACP. Existing native/API configurations and advanced Gemini CLI retain their current behavior; advertise additional managed accounts only for connections with verified credential isolation. Claude Console keyless accounts require separate named-profile-store isolation and are excluded from the initial managed-account pool. Preserve existing single-account behavior and settings when there are no added accounts.

Use plain JavaScript ES modules and existing dependencies. New interface copy uses the existing `t()`/`tn()` conventions, Settings row kit, theme tokens, and Content Security Policy. Local Ollama execution remains outside cloud account selection. Tests use temporary profiles and stand-ins, never real models or saved user credentials.

This feature does not register accounts with providers, import credential files, pool reported allowances, change models on an account-only switch, or expand planning/review restart permissions. Provider sign-up remains with the provider.

## Account registry and identity

Add an application-owned registry, separate from portable preferences, containing provider, generated opaque account ID, user label, enabled state, selected default, and configuration revision. Profile paths are derived from provider and ID beneath the application's data root; HTTP clients cannot provide arbitrary filesystem paths or environment variables. Aliases are bounded plain text and never used as paths. Save registry changes atomically with restrictive permissions.

Each provider initially exposes an `existing` account referencing its current native connection. Do not copy, move, log out, or delete those credentials during migration. Additional accounts get managed profile directories. The default account is app-wide and affects subsequent submissions; a conversation continuation retains its captured account unless the person explicitly switches or an authorized handoff changes it. A running task keeps its captured account even if Settings changes.

Identify every credential context by `(provider, accountId, credentialRevision)`. Reconnection or sign-out advances the revision and invalidates matching cached status, models, quota, offers, and session eligibility. Renaming only changes display metadata. Verify provider-reported identity when available; warn about duplicate identities without assuming two profiles always represent separate quotas. An unverified identity cannot be advertised as an independent allowance.

Public account summaries contain labels and safe status information. Credentials, profile paths, and complete environment objects never enter conversation journals, shared packages, phone state, or account HTTP responses.

## Provider credential isolation

Resolve a frozen account launch descriptor in the server and pass it explicitly to account/status/model/usage checks and provider workers. Do not mutate the server's global environment. All child environments for managed accounts remove conflicting ambient API-key, OAuth-token, and provider credential overrides before applying the selected profile; existing native accounts retain today's behavior.

For managed Codex accounts, create and canonicalize a unique `CODEX_HOME` and preserve its native credential-store mode consistently for login, account reads, usage, models, execution, and logout. Codex 0.167.2 scopes its OS-keyring key to the canonical home path, so forcing plaintext storage is unnecessary; persisted managed accounts must reject ephemeral-only storage. Verify this behavior on supported versions before enabling the account. Never copy a user's existing configuration or auth JSON into another account. Serialize Codex browser logins app-wide: that version's callback server can cancel an earlier login when its fixed port is busy. Report an in-progress login clearly and make cancellation close only that attempt.

For managed Claude accounts, use a unique `CLAUDE_CONFIG_DIR`, and explicitly set `CLAUDE_SECURESTORAGE_CONFIG_DIR` to that same directory where the installed CLI supports it, so an inherited secure-storage override cannot select another account's macOS keychain entry. Start authentication with `claude auth login --claudeai` to restrict managed login to the native subscription flow before any credentials change: Claude Console keyless credentials live in a separate named-profile store outside `CLAUDE_CONFIG_DIR`. Pass the account environment to SDK metadata sessions as well as coding and CLI login/logout. Profile/plan reads must use the same root. Verify both file and keychain isolation without reading actual user secrets; unsupported versions must refuse additional managed accounts rather than silently use the default credentials.

For Google ACP, separate the shared runtime installation root from the account profile root. Keep the existing Google profile in place; give added accounts their own `GEMINI_HOME`. Binary installation stays shared and no added account triggers a second runtime installation. Login, quota, metadata, and coding use the same account profile.

Provider isolation and sign-in behavior must be verified on macOS and Windows before claiming support on both. Failure to isolate a connection is an explicit setup error.

## Runs, sessions, and shared context

Capture account ID and credential revision at submission and journal them with run/session metadata. Broker launches, task-lane brokers, routing assessments, reviews, retries, and prelaunch fallback must consume that captured identity. Refresh results carry their account identity and revision; a late result cannot overwrite a different account's current state. Scope billing consent to the account and revision used for the request.

Native sessions belong to an account and credential revision. An account change always starts a fresh native session from Codeshi's existing task/context brief, preserving files, accepted instructions, plans, task budgets, and pending work. Do not try to resume another account's native session or copy native transcripts between profiles. Existing journals without account metadata resolve to the legacy `existing` account; imports and backups cannot authorize account selection or restore credential authority. When the native account's provider-reported identity changes outside Codeshi, invalidate its cached evidence and session eligibility before the next launch. Codeshi cannot prevent another native client from changing that client's credentials during a run; managed profiles avoid sharing those credential roots.

Single-account usage history remains readable. New quota observations and limit/reset status are keyed by account, with no merging of remaining percentages. Run token/cost totals still aggregate by task for task budgets; account rotation cannot reset a task budget or provider/model restriction.

## Quota selection and handoff order

For a new Normal task, use the explicit account selection or provider default. For a new Flow task, consider every enabled account permitted by the existing execution policy. For each provider/model candidate prefer its selected default account when it has sufficient confirmed room, otherwise its most spendable eligible account; feed that account-bound candidate into existing cross-provider model ranking. A limited default must not hide another usable account. The selected account identity and reading travel with the routing result and its final launch check. A continuation starts with its already captured account rather than reselecting an app-wide default.

Keep the current account while it has sufficient allowance for the selected model. When an existing quota/limit handoff is triggered:

1. Consider other enabled, connected accounts of the same provider, retaining model, effort, access mode, approval policy, and task identity.
2. Require matching model capabilities and workspace/attachment support. Apply all current execution, billing, and task-budget checks. For automatic moves require positively authenticated subscription billing and fresh confirmed allowance; unknown, stale, or exhausted usage is ineligible.
3. Prefer the eligible same-provider account with greatest model-applicable spendability, using a stable account order to break ties. Near-limit Flow checks also retain the current requirement for enough room for a usual continuation; after an actual limit use the existing at-limit policy.
4. If no same-provider account qualifies, use the existing cross-provider destination policy over eligible account contexts. If none qualifies, offer or schedule reset recovery only as today's execution policy permits.

An explicit account-only manual switch never silently substitutes another provider. API or unknown billing remains subject to explicit consent for that destination. A quota-triggered automatic chain tracks account identities rather than excluding an entire provider after its first account fails. Never retry an exhausted identity indefinitely; reset waiting requires new allowance evidence. When a provider can report that two profiles share an identity, treat their exhausted quota as shared for that chain.

Handoff offers bind the source account, destination account and revision, task/execution scope, selected model, billing, and queue digest. Revalidate immediately before stopping the old run and again before starting the new one. Account removal, reconnect, permission changes, and intervening manual submissions make stale offers fail without starting the destination. Keep existing Stop and execution-revision race handling. Planning, read-only reviews, approved build/review sequences, local runs, and reset continuations retain their existing restrictions on autonomous handoff.

## Queues and reset recovery

Queued submissions capture an account choice when accepted. On same-provider rotation, transfer only the unchanged queue entries covered by the accepted/authorized handoff. Preserve order, models, attachments, task limits, and approval policies; changing account identity must not duplicate a prompt. Explicitly pinned entries stay pinned unless the person included them in the switch. API/unconfirmed billing consent does not carry to another account implicitly.

Reset waits store eligible account identities and revisions instead of provider names alone, observe each account's model-applicable reset windows, and resume on a permitted account with confirmed room. Restart replay retains that selection. Removed, disabled, or reauthenticated accounts are invalidated; if no eligible account remains, show an actionable stopped wait. Manual submissions and Stop keep their existing priority over background recovery.

## Settings and connection lifecycle

Within Settings > Accounts, group account rows by provider. Preserve the existing account row and add **Add account**, a user-editable label, connection/billing status, per-account quota/reset display, and **Use for new tasks**. Details provide enable/disable, refresh, sign-in, disconnect, and remove for managed profiles. Show the account label on handoff offers and run details so the person can distinguish two Claude or Codex accounts.

Adding creates an empty managed profile and starts the official provider sign-in flow. Failed/cancelled sign-in leaves a recoverable disconnected row, not a connected account. Disconnect/remove must reject while the account is used by an active run, assessment, review, or login; the UI identifies what to finish first. Removing a managed account clears only its profile and native credential entry after scoped sign-out succeeds. Removing the existing account never deletes native credentials. Block symlink/path escapes during profile cleanup. Lifecycle changes invalidate offers and affected reset waits.

Credential directories and account registry stay outside workspace backup/move allowlists. Exported conversations may retain opaque historical account references but do not include emails, credentials, or reusable account launch descriptors. Imports never create account connections or restore native sessions.

## Implementation boundaries

Add focused account-registry and provider-account-environment modules plus account HTTP routes. Inject the registry/resolver through `server.mjs`, `projects.mjs`, and task/review workers. Update `providers.mjs`, `provider-worker.mjs`, `cli-probe.mjs`, `gemini.mjs`, and `antigravity.mjs` so auth, metadata, and execution consume one descriptor.

Update `broker.mjs`, context/session handling, `usage-watch.mjs`, `routing-assessment.mjs`, `handoff.mjs`, `resume.mjs`, and `prompt-queue.mjs` for captured account identities. In particular, quota histories and usual-spend estimates must not interpret a change of account as a quota increase or decrease. Review separate worker paths in `run-checks.mjs`, `review-jobs.mjs`, `automatic-review-runs.mjs`, and `plan-review.mjs`; task-lane brokers in `task-coordinator.mjs` share the same registry. Keep the browser's provider-keyed compatibility view while supplying per-account summaries to `settings.js`, account/usage controls, and handoff UI. Update the terminal CLI and phone path wherever they submit account-bound work; account connection management remains in Settings.

## Acceptance evidence

- Old settings and journals open unchanged; the existing native login works without credential migration.
- Two managed accounts of each supported provider use distinct credential roots for login, status, models, quota, runs, and logout. Conflicting inherited tokens/secure-storage settings cannot override selection; process-global environment stays unchanged.
- Late checks, reconnects, duplicate identities, and concurrent task lanes cannot mix account status, usage, sessions, or billing consent.
- Normal offers rotation and Flow rotates only within existing authority. Same-provider eligible accounts precede cross-provider destinations. Stale/unknown usage and unconfirmed/API billing never enter automatic rotation.
- Model-specific windows, current Flow spendability rules, image support, task budgets, provider restrictions, and existing planning/review exclusions still apply.
- Switching preserves the shared task/context and files, starts a fresh native session, and transfers only the authorized queue entries once, in order.
- Stop, manual sends, permission revocation, account removal, reconnect, and restart during quota/reset recovery cannot launch stale work or create rotation loops.
- Settings supports add/label/connect/refresh/select/disable/disconnect/remove with accessible errors, long labels, and translated copy; no secrets or profile paths appear in public output or exports.

Write regression tests against current upstream with fake providers and temporary profiles; include journal upgrade fixtures and native launch-environment assertions. Run focused provider, handoff, resume, queue, routing, execution-policy, backup, and frontend suites, then `npm test` and `npm run test:desktop` on the final implementation. Desktop review uses a disposable data profile. Native sign-in and real-account rotation require separate manual testing with disposable test accounts and are reported separately from automated checks.

## Native isolation references

- [Claude multiple account authentication](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) documents config-directory separation and the separate Claude Console keyless profile store.
- [Codex 0.167.2 native credential storage](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/auth/storage.rs) scopes the keyring key to the canonical home path; [its login server](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/server.rs) handles fixed-port conflicts by cancelling an earlier login.
- Current Codeshi `src/antigravity.mjs` sets `GEMINI_HOME` under the Google root and removes competing API credential variables. Its runtime/profile separation needs to be made explicit for multiple accounts.

These observations establish the design constraints; supported-version checks and credential-isolation tests are implementation acceptance criteria, not completed verification.

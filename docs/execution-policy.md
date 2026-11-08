# Task execution policy

Shipped in 0.34.1 ([#131](https://github.com/AhmedNavaz/codeshi/issues/131)). `src/execution-policy.mjs` records authority in each conversation's existing JSONL journal. Task IDs are shared with the task ledger and budget; a policy change does not reset usage, counters or request deduplication.

## New work and existing tasks

New work defaults to **Normal**. Selecting Smart, Saver or Ultra delegates **Flow for new tasks**. Existing tasks retain their own policy. Flow has no manual mode: entering the Flow view turns routing on with the mode that workspace last used in Flow, or Smart, and leaving turns it off, so the normal view chooses the agent and model by hand. Each of those changes goes through the same routing route and policy revision as a choice made in Agent settings. Desktop and phone show both the active task policy and the new-work default above the composer.

Normal permits explicit provider/model selection, fixed queues, accepted handoff/retry offers, a selected agent's reset wait, and an approved exact build/review sequence. The native agent retains its own tools, planning and compaction. Flow additionally permits only the automatic actions enabled in that task's policy. Routing, handoff, retry, review, check, wait selection and child creation each have an independent flag. Existing routing selection and task budgets still supply the choices and limits.

A policy contains `version: 1`, `taskId`, `revision`, `mode`, `routingMode`, `automation`, `allowedProviders`, `allowedModels`, `override`, and timestamped `authorization` provenance. Overrides bind provider, model and effort for one step (`scope: "step"`) or every subsequent step (`"pinned"`). A step override is consumed at provider startup. Restrictions also apply to assessors, reviewers and continuations. Tool access, approval mode, account billing consent and publication permission remain separate.

## Safe takeover

**Take manual control** increments the task policy revision and revokes pending decisions. An already running native turn, reviewer or test command may finish; **Stop** remains the immediate cancellation action. Before a native turn has started, revocation prevents startup even if account checks or checkpoint preparation were already underway.

Pending handoff/retry offers and reset waits are invalidated. Routed queue decisions are revoked and paused for inspection; fixed queued prompts retain their explicit settings. Edit a routed prompt to choose a fixed model or clear its routing before resuming. Completed output, file changes and accounting stay available. No repair, reassignment, assessment or reviewer can start under the old revision.

## Shared API

`GET /api/conversations/:id` returns `execution.defaults`, `execution.active` and recent `execution.policies`. Lane conversations expose their own task policy. Desktop, paired phone and encrypted remote phone use the same backend routes.

- `POST /api/conversations/:id/execution-policy`: `{ taskId, revision, action: "takeover" }` revokes a task. `{ taskId, revision, policy: {...} }` explicitly replaces its policy. Omit `taskId` to change new-work defaults, using their current revision.
- `POST /api/tasks/:id/execution-policy` addresses an independent task before or after its lane starts.
- Routing changes include `executionRevision` for the new-work defaults. Routed messages and queue additions also require it through the HTTP API. Clients send it on all new submissions. A stale revision returns 409 and requires refresh; it never grants billing consent.

Internal dispatch carries a `{ taskId, revision }` token and rechecks it before assessment, queue execution, handoff, reset resumption, retries, reviews and child creation, including after asynchronous checks and immediately before native provider startup. Explicit automatic-review sequences use their existing preview authorization and still obey policy revisions. Duplicate accepted requests return the existing submission.

## Upgrade and recovery

Existing saved work receives a policy labeled `legacy-recovery`, `legacy-queue` or `legacy-task`, preserving the previously recorded routing and automatic handoff authorization for that work. Saved reset waits retain their existing selection; new Normal waits snapshot the chosen provider, model and effort. New work defaults to Normal until explicitly delegated. The composer displays this transition rather than using a browser's saved layout as consent.

Queue restart holds, interrupted-run recovery and background-review recovery retain their existing behavior. A restart never replays a potentially submitted prompt or automatically reopens an interrupted build/review cycle. Policy and ownership records survive alongside the ledger; no additional task store or routing engine is introduced.

Task splitting, board/schedule execution (#132), specialist teams and the CLI remain separate follow-ups. New automation must carry and revalidate these same policy tokens.

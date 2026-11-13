# Core execution roadmap

Status: design proposals tracked in GitHub issues #84–#90, with scope extensions posted to #12, #21 and #15. The first milestones of #84, #85, #86, #87, #88 and #21 shipped in 0.26.0, each noted under its section; everything else here is still a proposal. Existing behavior is described separately from proposals. No runtime feature is implemented by this document.

## Product outcome

Help a person finish a verified task across their chosen coding agents with less repeated work and clear control over allowance. The desktop and a future CLI should expose the same execution engine, history, skills, checks and policy.

Codeshi cannot increase a provider's subscription allowance, change its reset rules or guarantee a token-to-quota conversion. Improvements must come from relevant context, appropriate model/effort selection, reusable procedures, early verification and bounded recovery. More agents can improve elapsed time or coverage while increasing total usage.

## Flow feedback follow-ups

The November 2026 reports extend existing work rather than implying that the focused Flow layout already manages every decision. See the [report-to-issue map](roadmap-details.md#flow-feedback-follow-ups).

- **Fresh routing evidence (#134):** shipped in 0.35.0. Join or refresh account/usage probes on first Send within a bounded deadline, show probing phase in Flow, and progressively recheck completed readings before failing. Cover cold/stale caches, slow/concurrent probes and Stop without manufacturing fresh timestamps, permitting stale quota, or allowing duplicate submissions.
- **Admission and handoff (#12, #135):** shipped in 0.35.0. Adaptive quota thresholds evaluate window duration, reset cadence, and workload size instead of static 90% cutoffs. Autonomous handoff execution in Flow mode transitions seamlessly under task execution policy (#131) without surfacing manual suggestion cards.
- **Codex protocol (#133):** shipped in 0.34.1. The installed desktop runtime's readline split valid JSON strings at Unicode line separators; LF-delimited streaming framing with UTF-8 decoding preserves large prompts, CRLF and EOF behavior.
- **Flow cards and active tasks (#107, #136):** shipped in 0.35.0. Readable separate-task titles, running task badge and pulse indicator, expandable overlay glance view for all rate-limit windows, clean status copy, and prominent highlighting for the actively executing agent.
- **Long shared-history context (#85):** investigate repeated fresh sessions using actual seed/envelope size separately from native context, cached input and cumulative usage. Bound a rolling task brief with provenance and a measurable trigger; retain original source records, user corrections, instructions, decisions, approvals, unfinished work and verification evidence across restart and handoff. Keep the full journal, revalidate file evidence and measure retention/repeated reads/correctness/usage under #84. A 15.1M cumulative-token notice and 273K native context alone do not establish that the full journal was sent or that summarization would save allowance. #123 owns the shipped between-turn refresh; #124 owns long-chat rendering.
- **Task budget probe loop stops (#137):** shipped in 0.35.0. Differentiates non-mutating diagnostic probes (e.g. curl, network health checks, polling commands) from mutating code/build failure loops in classifyStep and budget limits. Explicit user retry prompts, continuation actions and the stopped card ("Dismiss and retry" / "Extend budget") reset or extend the failure counter to restore task readiness.
- **Release packaging CDN resilience (#138):** shipped in 0.34.1. Packaging verifies Electron against the checksums the electron package ships instead of fetching SHASUMS256.txt, retries GitHub with growing pauses, and falls back to the npmmirror.com mirror when GitHub keeps failing, still verified against those checksums. A URL from ELECTRON_MIRROR is used from the start and retried without a fallback.
- **Prompt queue pause and layout clipping (#140):** fixed. Keep queue controls (`#prompt-queue-toggle`, "Resume queue" / "Pause") and row actions visible with `flex-shrink: 0`. Align `.transcript-footer` and `.prompt-queue` within content boundaries with `min-width: 0` and `max-width`, and ensure long pause reasons (such as task authority revocation errors) and multi-field routing metadata truncate or wrap cleanly with full title tooltips without pushing controls off-screen.
- **Project review port conflict handling and prerequisite validation (#141):** fixed. Prerequisite notes are trimmed, truncated to 120 characters and capped at ten per profile instead of rejecting the whole launch map. An in-use service port blocks only its own service and dependents rather than the entire launch, leaving unrelated services running; the review card offers attaching to a healthy already-running service or re-preparing with another port. Codeshi still never adopts or terminates a process it did not start.
- **Concurrent multi-UI preview windows (#142):** support simultaneous access to multiple exposed web interfaces (e.g. website, admin dashboard) without navigating away or closing previous preview instances.
- **Vertical right-hand inspector layout (#143):** relocate the Development/Stack and API inspector from the overhead drawer to a vertical sidebar on the right side of the desktop preview window, preserving full vertical viewport height for the app.
- **Flow Run and Review module (beta):** Visible in Flow mode alongside other beta capabilities. In-use port conflicts ([#141](https://github.com/AhmedNavaz/codeshi/issues/141)) are now handled by attaching to a healthy running service or reassigning its port; follow-up fixes for concurrent multi-UI preview windows ([#142](https://github.com/AhmedNavaz/codeshi/issues/142)) and vertical right-side inspector layout ([#143](https://github.com/AhmedNavaz/codeshi/issues/143)) are tracked and in progress.
- **Smart routing near-quota fallback (#144):** when a candidate agent's quota window is near threshold (`state === "near"`, e.g. Weekly at 97%) right before execution starts in Flow mode, re-route to another eligible provider or lower-tier model before halting with a fatal routing pause, preserving autonomous Flow continuity and queue progression.
- **Spending allowance before it resets (#153, shipped in 0.38.0):** `assessQuota` marks a `near` reading as `burndown` when every near window resets within its horizon (weekly 6 h, daily 2 h, 5-hour 30 min) and the agent's other windows are `ok`. `route()` then accepts it in every routing mode, after all `ok` and `unknown` agents and after an `ok` model one tier down, and before a `near` model one tier down. Among near agents, ranking is by spendability with no continuity bonus. The top effort level steps down to `high`, and the choice carries `remainder: 'expiring' | 'asked'` with a reason saying which window is being spent. `allowNear` carries the queue's **Proceed with remaining allowance** consent through `RoutingAssessment.candidates`/`dispatch`. Before this, only `broker.start` saw it, so routing paused the queue again in a loop. The consent now lasts until the queue empties or is resumed without it, and applies only to queued runs. A pause after consent is recorded with `proceedTried`, and the card then replaces the button with a note. The pre-flight check in `broker.start` accepts burndown readings, trying an `ok` fallback first when routing didn't already choose the remainder, and records `routingRemainder` run metadata. Handoff destinations, the limit-reached move and automatic reviews still require `ok`. The horizons are fixed, not a setting.

## Desktop performance and energy use

Track the significant battery-drain report in [#152](https://github.com/AhmedNavaz/codeshi/issues/152). The supplied Activity Monitor row has no column headers, so its values alone do not establish CPU utilization, energy impact or the responsible process.

A first mitigation, shipped with the Lounge in 0.38.0, removes continuous redraws for unstarted/paused Lounge games and Clear weather, suspends Lounge animation in hidden pages, and shares element layout measurements across settled snow particles. These changes address observed unnecessary work; they do not establish that the reported drain is resolved.

Before closing the issue, capture reproducible before/after profiles for idle Normal/Flow, streaming and long chats, rain/snow/clear, games, multiple previews and hidden/minimized windows. Attribute CPU/GPU, wakeups and memory to main, renderer, GPU and agent/tool processes. Audit rendering, compositing, polling/watchers, history serialization and resource cleanup; establish measured performance/energy budgets and lifecycle regressions. Preserve agent execution, approvals, notifications and review readiness while reducing background visual work.

## Normal and Flow execution contract

Agreed direction, not released behavior: **Normal** is explicit agent/settings/task control; **Flow** delegates execution decisions for an authorized outcome. The [feature ownership matrix](roadmap-details.md#normal-and-flow-the-agreed-execution-split) covers shipped capabilities and planned features. Native agent planning/tool loops, context handling, reviewed memory/skills, explicit queues and exact user-configured workflows remain available in Normal. Budgets, approvals and recovery protect both modes.

### Backend mode policy and safe takeover

**Released preview:** the focused view uses the original routing/handoff settings. Both entry and exit require an idle workspace, including other tasks, reviews, tests, reset waits and unpaused queues. A view request never starts a new task and blocked requests are not deferred. Recheck before applying an animated transition and keep all active work reachable. This read-only activity guard is not the backend execution-policy milestone below.

**Shipped in 0.34.1:** [Task execution policy](execution-policy.md) documents journaled authority, safe takeover, migration and client controls. The future CLI will use the same API.

**Tracking:** [backend task policy #131](https://github.com/AhmedNavaz/codeshi/issues/131). #107 owns the user experience; #12 owns selection; #87 owns accounting and limits. Extend their existing engine/journal rather than inventing another task store or routing engine.

- [x] Persist versioned Normal/Flow policy per task, independently of browser layout, with allowed automation, routing preference, overrides and authorization provenance.
- [x] Check current policy before initial/queued dispatch, handoff, quota/reset continuation, retry, review and child creation; reject stale clients and revoked automatic decisions.
- [x] Let different tasks use different policies. Desktop, phone, restart recovery and CLI share backend authority; opening another view or closing a window does not change it.
- [x] Take manual control revokes future discretionary dispatch at a safe boundary while preserving current/completed work; define in-flight turn behavior. Immediate Stop is distinct.
- [x] Preserve/deduplicate queued work and counters through restart and takeover. Preview migration from existing routing/handoff settings without silently changing in-flight authorization.
- [x] Keep tool access, approval mode and billing separate. Flow, quality preferences and schedules never grant permission to publish, push, deploy or release.

### Common assignment, handoff and recovery policy

The **Testing cadence** preference shipped in 0.29.2 and applies in both views: Review first guides lightweight iteration and verification at an explicit finalization request. New turns inherit it across agents and task lanes; routine post-run checks are explicitly deferred, while selected test-repair/build-review workflows retain required checks. It does not enforce a command ban or cache verified results. Future automation must honor the same cadence and use input-bound evidence before reusing a successful check; count deferred work as unverified and measure repeated verification overhead under #84.

**Tracking:** #12, extending shipped #17/#32/#91 behavior. Existing closed milestones stay closed; new mode enforcement is [backend task policy #131](https://github.com/AhmedNavaz/codeshi/issues/131).

- Required capability, tools/inputs/context and remaining task come before allowance. Model-name tiers are heuristics until verified under #84.
- Select provider, model and effort consistently for initial work, both forms of quota handoff, waits, retries, reviewers and future subtasks. The current handoff selector does not yet implement the complete routing-mode policy.
- Apply Saver (sufficient capability and restrained overhead), Smart (task fit and evidence-based escalation) or Ultra (stronger suitable reasoning and targeted checks) under the same total budget, extending the modes shipped in 0.33.0 (#128).
- Recheck applicable five-hour/weekly/model limits and freshness before dispatch; include concurrent usage, continuity, transfer/re-reading cost and manual pins. Unknown quota/billing does not authorize automatic work.
- Normal keeps manual offers/choices and fixed-agent waits. Flow may choose an eligible alternative or authorized wait. No suitable candidate means a visible wait/blocker, not an incompatible downgrade or unauthorized spend.

### Board and schedule execution

**Tracking:** [board/schedule execution #132](https://github.com/AhmedNavaz/codeshi/issues/132). #97 owns card/canvas/board/outline views; #88 supplies tasks/isolation. Reuse the same cards and IDs in all views.

- Normal: explicit cards, assignments, graphs and fixed schedules. Flow: authorized outcomes or bounded backlog selections with automatic assignments. No default Auto for new Normal cards.
- Bind policy, relevant card revisions, scope, permissions and budget to scheduled work. Preserve user edits, distinguish worker completion from acceptance, deduplicate starts and show missed runs without inventing always-on availability.
- Pauses, failed prerequisites, quota waits, takeover and restart cannot start unapproved or unrelated work. External publication remains user-controlled.

### Feature issue ownership and delivery

| Workstream | Owner | Mode boundary |
| --- | --- | --- |
| Flow experience | #107 | Explain and control delegated outcomes; preserve manual override/recovery |
| Runtime authority, migration and takeover | [backend task policy #131](https://github.com/AhmedNavaz/codeshi/issues/131) | Backend task policy shared across clients |
| Selection and automatic continuation | #12, #17, #32, #91 | Manual choice/fixed wait in Normal; common-policy automatic choices in Flow |
| Queue editing | #113 | Normal explicit settings; Flow automatic versus pinned choices with policy provenance |
| Manual concurrency and bounded fan-out | #88, #108 | Manual tasks remain shared; delegated creation/assignment belongs to Flow |
| Plans, board execution and schedules | #97, [One Plan #162](https://github.com/AhmedNavaz/codeshi/issues/162), [board/schedule execution #132](https://github.com/AhmedNavaz/codeshi/issues/132) | Shared cards, exact Normal execution, authorized Flow management |
| Reviews and teams | #15, #89 | Explicit build/review stays in Normal; discretionary finite cycles and managed teams in Flow |
| Race comparisons | #16 | Explicit comparison in Normal; separately authorized managed comparison in Flow |
| Voice and contextual suggestions | #72, #106 | Dictation/suggestions shared; continuous hands-free loop in Flow |
| GitHub/CI and publication | #18 | Explicit Normal reads; authorized scoped Flow reads; no implied publishing authority |
| CLI | #90 | Same backend policies, journals, budgets and lifecycle |
| Context, accounting and limits | #85, #84, #87, #123 | Shared foundation with honest occupancy/consumption reporting |
| Onboarding and mode selection | #129 | Workspace-first setup; user-selected starting mode (Normal vs Flow) with presentable comparison |
| Interface polish, typography & settings | #127, #130 | Typography scale, non-clipping workspace indicators, and categorized settings |

1. **One managed task:** backend mode policy and safe takeover ([backend task policy #131](https://github.com/AhmedNavaz/codeshi/issues/131)), unified selection/handoff (#12, extending #17/#32/#91), visible decisions, checks and bounded recovery (#15), with measurements (#84) and controlled context (#85).
2. **Managed task splitting:** build on manual task isolation (#88), bounded fan-out (#108), shared Plan cards (#97), board/schedule execution ([board/schedule execution #132](https://github.com/AhmedNavaz/codeshi/issues/132)) and one parent budget (#87).
3. **Specialist teams and hands-free work:** managed contracts and integration (#89), then the continuous voice loop (#72), with verified lifecycle, context retention and measurable overhead.

Existing manual capabilities and exact user-configured sequences remain available throughout. These are implementation stages, not release promises.

## Existing foundation and gaps

- Routing and model/effort selection already ship; see public/routing.js, src/routing-assessment.mjs and #12. Since 0.31.1 a short read-only agent assessment rates each request on Send, and local rules remain the fallback and the bare go-ahead path.
- Context already favors task intent over tool logs, preserves the original journal and uses native-session deltas; see src/context.mjs and #69. Task-focused retrieval and reviewed memory shipped in 0.26.0; further retention/revalidation and context visibility remain planned.
- Handoff/reset waiting, one test-triggered escalation, build/review and checkpoints already exist; see src/handoff.mjs, src/resume.mjs, src/run-checks.mjs and src/automatic-review.mjs.
- Manual folder tasks already use separate brokers/journals, worktree isolation and shared mutation leases (#88). Flow fan-out must reuse that task/ownership model rather than removing guards.
- Native provider capabilities differ. Codeshi disables user/project hooks for its invocations and restricts tools; skills/plugins/team features need an explicit compatibility design.
- Approval correctness (#81) and reliable Stop/completion/worker cleanup must be fixed before widening unattended orchestration. Record actual provider failures separately from frontend state errors.
- First-run onboarding currently puts agent account setup before workspace creation, and drops users into Normal mode without explaining or offering Flow mode. Redesigning onboarding (#129) prompts workspace and folder selection in Step 1, followed by a clear, presentable choice between Normal and Flow execution modes.
- Small UI font sizes (10–11px) across sidebar items, task cards, and the bottom status bar create readability issues. In narrow sidebars, workspace names and running indicators clip against folder disclosures and menu buttons. Refined typography scale, non-clipping two-line workspace items (#127), and restructured Settings categories (#130) resolve these UI/UX inconsistencies.

## Delivery order

| Stage | Deliverable | Exit condition |
| --- | --- | --- |
| 0 | Reliable lifecycle, approval and quota reporting | A completed/stopped run releases ownership; errors identify the real blocking condition; weekly and five-hour windows remain distinct. |
| 1 | Task-efficiency measurements | Representative baseline tasks have reproducible results and honest coverage of usage metrics. |
| 2 | Relevant context, reviewed memory (#21), on-demand skills and shared budgets | Controlled experiments improve correctness or usage without hiding overhead; one-agent work stays simple. |
| 3 | Concurrent folder tasks and builder/reviewer workflows | Independent work is isolated; dependencies, approvals, integration checks and recovery remain correct. |
| 4 | Specialist teams and CLI workflow automation | Desktop and terminal use the same engine; teams demonstrate a quality or elapsed-time benefit worth their additional usage. |

Design of later stages can proceed early. Their execution depends on the earlier invariants; these stages are not release dates.

## What a Codeshi CLI adds

Claude Code and Codex already have skills, subagents and automation interfaces. Codeshi's CLI should coordinate **across** supported providers and preserve the same task in the desktop: route a task, continue it with another agent, apply portable procedures, run the project's checks, obtain an independent review, pause for approval, and resume under one budget/history.

For one prompt to one provider, the native CLI remains sufficient. Do not build a second model runtime or replace native agent loops. Start with a headless service/client contract and commands for run/status/continue/stop; team workflows and a terminal UI come later.

The commands listed in [docs/cli.md](cli.md) are built; the other command names in the CLI proposal are examples, not installed functionality.

## Issue proposals

The following sections preserve the scope, dependencies and acceptance criteria of the linked GitHub issues. Implementation discussion belongs in those issues.

### Task efficiency

**Issue title:** Measure completed-task quality and agent usage before claiming efficiency gains

**Tracking:** [#84](https://github.com/AhmedNavaz/codeshi/issues/84) — the first milestone is built: the ledger in `src/task-ledger.mjs` and the suite in [`evals/`](../evals/README.md). Live comparisons so far are too small to claim a gain.

**Shipped in 0.36.0:** Tasks and evaluation results split whole invocations into builder, read-only, assessment and review roles, each with time and measured usage coverage. Assessments, including failed ones, remain in totals, and task start time includes the assessor. The recorded `routing-assessment` fixture runs the real router and worker against `small-edit`’s repository and hidden checks, reserves assessor and builder invocation slots, and tests pin repetition and failed-assessment accounting. Native planning, summary and delegation costs remain inseparable within provider totals; explicit budgeted live comparisons remain outstanding. No efficiency gain is established by these traces.

**0.28.0:** evaluations can repeat a saved input pin with `--pin`, checking skill versions and resources alongside fixture snapshots, policy, checks, engine and runtime before dispatch. Reports separate incompatible experiments, recorded/live results and changed reported models, and show wall time alongside working time. Pins verify inputs rather than archive them; hosted model behavior cannot be frozen. Full coordination accounting and the broader routing cases below remain open, as do longer live comparisons.

**Shipped in 0.30.0:** `long-thread` runs three successive tasks across two folders, comparing native resumes, separate conversation briefs and repeated agent switches including switching back. Recorded traces test cumulative session accounting and compaction notifications; hidden checks and the human rubric assess retained decisions and unresolved scope. Reports add reasoning-field coverage, observed compactions and a labeled fresh-envelope reconstruction probe. Claude accounting now prefers pipeline `modelUsage` (including reported auxiliary work), subtracts resumed-session baselines for tokens and cost estimates, and retains raw fields and coverage. Background reviewer tool counts survive worker cleanup. Provider-excluded helpers, per-role attribution and live efficiency evidence remain unavailable; the offline suite makes no savings claim.

#### Problem

Codeshi records some provider usage and test results, but does not yet demonstrate whether routing, context handling, skills or extra agents produce more correct completed work for the same allowance. More activity and more agents can increase usage without improving the result.

#### Proposed outcome

Add a local task-efficiency ledger and a reproducible evaluation suite. Compare Codeshi policies against a manually selected single agent on the same repository snapshot and acceptance checks.

#### First milestone

- Record task/run/parent identities, provider/model/effort, elapsed time, completion reason, tests, retries, reviews and tool counts in the existing journal.
- Normalize input/output, cache-read/cache-write and reasoning token counts only where reported; preserve raw provider fields, source and coverage. Missing values are unknown, never zero.
- Show five-hour, weekly and model-specific quota windows separately, with reset times and observation timestamps. Account-wide quota changes may include other clients and are not attributable to a Codeshi task.
- Distinguish API cost estimates from actual charges and subscription allowances. Do not convert tokens or API-equivalent prices into an invented subscription cost.
- Supply representative fixtures: small edit, cross-folder feature, bug repair, quota handoff, context-heavy continuation and review. Verify outcomes with deterministic checks plus a documented human rubric where needed.

#### Acceptance criteria

- [ ] Repeat an experiment from a pinned repository snapshot, policy, skill version, model configuration and check command.
- [ ] Compare first-attempt success, verified completion, total measured usage, wall time, retry count and interventions; report missing data and run variability.
- [ ] Include planning, summaries, retrieval models, reviewers and delegated agents in totals, not just the builder.
- [ ] Offline CI uses recorded/fake-provider traces. Live evaluations are explicit runs on the owner's accounts with a stated budget.
- [ ] Results remain local by default, can be inspected/exported/redacted/deleted, and send no remote telemetry.
- [ ] Publish measured tradeoffs before advertising a token reduction or quality gain.

#### Implementation boundary

Extend broker run metadata, provider usage normalization and run-check results. Keep account quota observations distinct from per-run tokens. This supplies evidence for #12 routing, #17 handoff, #15 review and #21 memory; it is not a dashboard-only project.

#### Next milestone: long-thread and compaction measurements

Track with [#84](https://github.com/AhmedNavaz/codeshi/issues/84), alongside the context milestone in #85. These are planned comparisons, not measured savings.

- [ ] Compare long same-agent continuations, repeated agent switches (including switching back), successive tasks and multi-folder work against separate task threads and a manually selected single-agent baseline, using equivalent pinned snapshots, requests and acceptance checks.
- [ ] Separate current context occupancy from cumulative input/output/cache consumption, and per-run/task usage from native-session totals. Text-envelope estimates do not measure the agent's entire context.
- [ ] Include handoff reconstruction, repeated file reads, summaries/retrieval calls, retries/reviews and native compaction where attribution is available. Mark unavailable or unattributable overhead; do not invent subscription costs.
- [ ] Check retention of instructions, decisions, acceptance criteria and unresolved blockers alongside final correctness. Report wall time, interventions, cache behavior, measured usage and variability before claiming token savings.
- [ ] Keep live comparisons explicit and budgeted; recorded traces cover offline regressions without claiming live-provider efficiency.

#### Planned milestone: personal Smart results and savings evidence

**Tracking:** [#139](https://github.com/AhmedNavaz/codeshi/issues/139), extending #84 measurement, #12 routing and #107's results card. No savings are established: the measurements exist, the evidence does not yet.

**Shipped in 0.38.0:** `src/smart-results.mjs` works out observed results and comparisons from the task ledger with no model call, served at `/api/results` for the workspace's conversations and parallel tasks, and shown in a Flow card and the Tasks panel. The rules are fixed in the module and saved in every report (`METHOD`, version 1):

- **Groups and cohorts.** Smart, Saver and Ultra are each compared with manual tasks, never pooled. A pinned pick while routing is on counts as manual. Routed runs record `routing.policy` (`relayRouting.POLICY_VERSION`), and only the latest version is compared. Tasks are compared within the current context setting. Earlier rules, other or unrecorded context settings, other manual agents than the chosen baseline, and tasks left out by the person are listed by reason.
- **Matching and minimums.** Kind (change or question) and size (light, standard or deep) come from `classify()` on the request at submission. Only the result is saved, never the request. A size needs 3 finished tasks on each side and one verified manual task. A comparison needs 10 matched finished tasks on each side and 5 verified manual tasks.
- **Quality gate.** Verified means finished with passing tests afterwards. Tests must have run after at least half the tasks on each side, and the routed verified share must be no more than 5 points below the manual share, weighted to the routed group's sizes. Otherwise the result is `quality-not-established` or `quality-regression`, never a saving.
- **Arithmetic and uncertainty.** For each size, manual total ÷ manual verified × routed verified is the manual baseline for the same verified work. The difference is the summed baseline minus the routed total, with a percentage only for a positive baseline. Failed and stopped tasks count in usage. A 90% interval comes from 1,000 seeded bootstrap resamples within sizes; one that includes zero is inconclusive. A headline needs the quality gate, complete coverage and a conclusive interval, and for tokens the same agents on both sides.
- **Units.** Working time compares across agents. API estimates are shown and never compared, because no dated price list is kept. Plan allowance is excluded.
- **Measured comparisons.** `npm run eval -- compare` pairs saved `small-edit` and `routing-assessment` results with the same snapshot, checks, agent, context policy, engine and runtime, using the same rules with evaluation minimums (3 repeats on each side).

Still open: budgeted live comparisons on the owner's accounts, opt-in redacted sharing of reports, and any public claim, which must cite a live measured comparison that passes these gates.

Give each person a local **Smart results** summary in Flow and Tasks, using their own recorded task usage and outcomes. Make its underlying evidence useful for evaluating routing changes and supporting defensible marketing claims. Smart, Saver, Ultra and manual runs remain separate groups.

- **Observed results first:** show whole-task usage, elapsed time, verified completion, retries and interventions. Include assessment/reference retrieval, planning, summaries, handoffs, failed/cancelled attempts and reviews where available, without double counting resumed or child runs. Missing usage stays unknown; deferred checks remain unverified. Render from recorded data without an extra model call.
- **Three evidence levels:** distinguish actual observed usage, estimated differences against sufficiently comparable personal manual-task history, and controlled measured comparisons on equivalent pinned inputs/checks. Preserve the person's explicit manual provider/model/effort baseline, matching method, sample count, time range, coverage, exclusions and uncertainty. A same-token price scenario is not evidence of what a different model would have consumed. Without a usable baseline, show actual results and “Not enough comparable data”. Never silently run a duplicate paid task.
- **Honest arithmetic and quality:** for comparable metrics, difference is baseline total minus Smart total; divide by a positive baseline total for a relative difference. Aggregate compatible totals rather than averaging percentages. Include failed work and all known overhead; expose zero/negative results, incomplete coverage and quality regressions. Compare cost/time per verified completion alongside success rates. Define minimum samples, matching rules, uncertainty and quality non-regression thresholds before enabling savings headlines.
- **Keep units truthful:** show input/output/cache/reasoning coverage with provider semantics. Separate API cost estimates (with pricing source/date and cache treatment) from actual charges. Subscription allowance remains per account/model/window with reset and freshness; account-wide changes may include other clients. Do not combine quota percentages or invent dollars saved from subscription tokens.
- **Useful presentation:** a quiet card with a time range, verified tasks, usage and a supported comparison; expand into task records, baseline assumptions, routing reasons and outcome checks. Explain positive results when evidence supports them; give extra usage and insufficient evidence equal prominence. No fabricated cold-start percentage or promotional claim when results are negative or uncertain.
- **Evaluation and marketing:** versioned local reports separate task classes, provider/model, policy versions and billing types, retaining full overhead, quality, variability and missing data. Data stays local by default with inspect/redact/export/delete controls and explicit voluntary sharing that excludes prompts/code/secrets by default; no automatic telemetry. Combine budgeted controlled evaluations with voluntarily shared reports without treating self-selected reports as representative. Public claims must identify their cohort, period, baseline, metric, quality checks and limitations and be reproducible from supporting evidence.

Sequence: #84 accounting and comparison inputs → baseline/evidence specification → observed personal results → qualified comparison/reporting → budgeted live validation before marketing savings. Acceptance coverage must include cold start/no baseline, missing usage, zero/negative differences, incompatible cohorts, mixed billing, price changes, external quota activity, restart/resume and quality regressions.

**Sequence:** Foundation; implement first.

### Task scoped context

**Issue title:** Build task-scoped context from relevant code, history and verified project memory

**Tracking:** [#85](https://github.com/AhmedNavaz/codeshi/issues/85) — the first milestone is built in `src/task-context.mjs`. Retrieval reads Git and the files when a prompt is built, without a saved index, and reviewed memory (#21) goes out with the brief. A saved index is not planned for now: on a 24,000-message conversation in a busy repository, Git and file retrieval took about 155 ms of a 350 ms envelope build, once per fresh start, and a cache would add evidence that can go stale.

**Shipped in 0.31.1:** run details show each run's total against that agent's usual and how each limit moved, and a local check after every prompt shows a notice for an unusually large run or a big limit move. Limit moves are account-wide and are labelled that way. These notices point out large runs; they don't reduce growth inside a running turn, which is still open.

**Shipped in 0.30.0:** native compaction observations now retain source, time and available before/after estimates in the journal and remain visible in run details and Flow. Run consumption, cumulative native usage, last-request input, native context snapshots and outbound text estimates have separate labels; unavailable occupancy stays unknown. Claude context reports retain their provider-estimate and compaction-window semantics. The next send after a reported compaction reconstructs bounded task history, current instructions, memory and file evidence while resuming the same native session; failed sends leave that refresh pending. Ordinary resumes still send deltas. Retrieved file hashes, Git revision changes, nested instruction files and already-delivered memory are revalidated. The Brief panel exposes current evidence and invalidation notices. The saved retrieval index and evidence from real provider compaction remain open.

#### Problem

Codeshi's bounded context envelope preserves user intent and supports native-session deltas, but much of the selection is still based on recency and byte limits. A website task should not repeatedly inherit unrelated desktop logs; a switch to another provider should not require rediscovering the same files and decisions.

#### Proposed outcome

Build a task-scoped context service that supplies the smallest sufficient brief with traceable sources while keeping the full journal available.

#### First milestone

- Select the current task, acceptance criteria, relevant folder identities, governing instructions, unresolved decisions, changed-file references and prior failed approaches ahead of raw tool logs.
- Start with local filename/symbol/search and diff-based retrieval. Embeddings or model-written summaries are optional later experiments whose latency and usage count toward the task.
- Keep relevant code excerpts tied to folder identity, path, content hash, line range and capture time; invalidate on edits, branch changes, folder changes and deleted files.
- Bound bulky tool output and repeated history, retaining error context, omitted-content markers and a way to retrieve the original.
- Integrate the existing brief and native session cursor rather than adding a second memory store. Stable shared prefixes may improve provider caching where supported; measure cache behavior rather than promising it.

#### Acceptance criteria

- [ ] A website-only task receives its relevant code and instructions without unrelated desktop activity; an explicitly cross-folder task receives both.
- [ ] Current user instructions, scope, unresolved blockers and acceptance criteria survive compaction and handoff.
- [ ] Instructions applying to each selected folder are retained; a changed brief can be inspected and manually supplemented.
- [ ] A native resume adds only the needed delta; a fresh-provider handoff includes an explicit bounded continuation brief.
- [ ] Stale summaries or excerpts are revalidated, and untrusted file/tool text is not promoted into higher-priority instructions.
- [ ] Native compaction, context size estimates and unavailable tokenizers are labelled accurately.
- [ ] Evaluate relevant-fact retention, repeated file reads, task correctness and total usage against current prepareContext behavior.

#### Next milestone: controlled working context and visible compaction

Track with [#85](https://github.com/AhmedNavaz/codeshi/issues/85), measured under #84. Product intent: **one continuous conversation with controlled working context**.

Codeshi selects and truncates history into a bounded text envelope, without automatically generating an AI summary. Its default 192,000-byte cloud and 96,000-byte local caps do not bound the native agent's full context or total token consumption. Consecutive same-agent turns resume with unseen history; agent switches, including switching back, rebuild a fresh handoff, and since 0.32.0 Gemini continues its own session too when its runtime can resume one. Version 0.30.0 retains observed native compactions and rebuild context on the next send after one. This cannot inspect a provider's hidden context or establish what survived inside the already-running turn. Shortened tool-log excerpts remain a separate operation.

- [x] Shipped in 0.30.0: show native context readings/capacity separately from cumulative session usage and per-run tokens; label estimates, observation timestamps and missing readings.
- [x] Shipped in 0.30.0: persist observed native compaction records/counts separately from Codeshi history omissions and excerpts, in run details and Flow.
- [x] Shipped in 0.36.0: record each fresh native session's seed (Codeshi's first envelope, in bytes and estimated tokens) and turn count apart from the provider reading, cached input and cumulative usage; keep a bounded per-agent refresh history with the replaced session's seed and turns; detect a fresh session that is due again within two turns and explain it from the records as a large seed, a small reported window or growth within one turn, labelling estimate-based readings. No model call.
- [x] Shipped in 0.38.0: make handoffs smaller around the active task. When the conversation before a task is over its 48,000-byte history allowance, `src/context-fold.mjs` keeps the last two requests and replies word for word and folds older in-scope history into a bounded rolling brief (12,000 bytes, half on a context refresh): one excerpt per earlier request with its reply's first paragraph, the person's decisions and answers, Codeshi's own check results and unanswered agent questions, each with its source message id and the folded range. Resent requests are sent once and a refresh milestone no longer repeats requests context carries in full. Rebuilt from the journal on each fresh start, so it survives restart and handoff without a second store. No model call. Older journal content is retrieved by id, not replayed.
- [ ] Preserve the full journal, source provenance and access boundaries; revalidate file-backed facts and verify retention through native compaction and handoff.
- [ ] Respect native compaction ownership. Proactive policies or fresh-session resets require capability checks and measured retention/cost evidence, rather than a universal invented context percentage.
- [ ] Validate long threads and repeated switches against separate task threads under #84, including re-reading, cache behavior and compaction/summarization overhead where measurable. A smaller envelope or successful compaction alone is not evidence of token savings.

#### Implementation boundary

Build on src/context.mjs and #21 project memory, with a local retrieval index and provider-specific sizing adapters. Preserve the append-only journal and existing secret/path boundaries.

**Dependencies:** Task-efficiency measurements; extends #69 handoff context.

### Context rollover (#123)

**Shipped in 0.30.0.** Codeshi can start a fresh native session before another turn while retaining its full workspace timeline. Flow's routing mode supplies a context target of 40,000 (Cost Saving), 75,000 (Balanced) or 120,000 (Maximum Quality) tokens. A smaller reported window caps the target at 75% of that window. Task lanes inherit the current workspace Flow policy. Normal defaults to Auto and offers Off, presets and custom limits under **Settings → While agents work**. Auto uses a 75,000-token target, capped at 75% of a smaller reported window. **Since 0.31.1:** after recent provider requests with the same model and effort, the targets rise to 120,000 in Normal and Balanced, 80,000 in Cost Saving and 160,000 in Maximum Quality; the 75,000, 40,000 and 120,000 targets apply after a longer pause. This is a heuristic based on reported or conservative cache timing, not a guaranteed cache hit or measured saving. Existing configurations without a saved choice receive Auto; an explicit Off choice remains respected. Older Claude and Codex sessions without a usable context signal refresh once before their next send, without treating cumulative usage as context occupancy. Since 0.32.0 Gemini keeps its session between turns and follows the same targets; before that it started fresh each turn.

The **Compact context** control at the top-right of the typing box, an icon with state marks since 0.31.1, is visible in Normal and Flow; `/compact` remains an optional shortcut. Both show an explanation and require confirmation before scheduling a local refresh without calling a model. The ring is a small, number-free context indicator; detailed readings stay in its tooltip. They detach the selected idle native session and persist a pending rollover; the next Send compiles the seed from current files. Busy runs and reset waits refuse the action without consuming the draft. Automatic rollover occurs at dispatch, preserving the chosen provider, model, access, approvals, billing and shared task budget. Pending rollovers survive restarts and failed dispatches and clear after a successful native checkpoint. Native compaction within a running turn remains owned by the provider.

The journal incrementally records bounded local observations: verbatim user decisions/constraints, changed file references, recorded checks and reported failures. Tool text never creates a user decision, and tool-reported test success never becomes verified completion. A rollover combines scoped observations, the existing project brief/memory, current governing instructions and file evidence, pending steps, timestamp/revision provenance and recent exchanges. Raw tool output is omitted from this seed and remains in the append-only journal. There is no additional model distillation call, no second memory database and no remote telemetry. The Brief panel can inspect the pending seed, and an inline timeline marker identifies the refresh.

Context snapshots, last-request input and consumption totals remain separate. Codex and main-agent Claude single-request input can trigger a refresh as a labeled lower-bound signal; it is not displayed as exact full context occupancy. Managed sessions also track a replayable byte estimate of outbound context and recorded message growth, so absent provider readings do not disable automatic protection. This estimate is labeled and never added to usage or billing totals. Compaction invalidates old snapshots and resets the estimate. These policies operate between turns and cannot guarantee a cap on a native agent's internal tool loop. Mandatory request/instruction content that cannot fit the bounded seed fails before automatic session detachment; it is never silently discarded to meet a target. Thresholds are product policy, not measured optimal operating points or evidence of savings. Offline tests cover threshold modes, old-session upgrades, fresh-session counters, retained acceptance facts, local API/settings/manual actions and restart recovery; budgeted live measurements remain separate under #84.

### Portable skills

**Issue title:** Load reusable skills across providers with explicit compatibility and scope

**Tracking:** [#86](https://github.com/AhmedNavaz/codeshi/issues/86) — the first milestone is built in `src/skills.mjs` and `starter-skills/`. Claude, through its SDK, uses its own skill system with a private plugin built from the enabled versions; Codex and Gemini still get skills as instructions in the prompt.

#### Problem

Reusable procedures should follow a Codeshi task when its provider changes. Codeshi currently restricts native tools and disables user/project hooks for its invocations; importing a provider's skill/plugin configuration therefore cannot be assumed to work. Loading every procedure into every prompt would also waste context.

#### Proposed outcome

A provider-aware skill catalog based on SKILL.md, with on-demand loading, visible scope and reusable workflow templates. A skill is a procedure, a role is an assignment, and a provider/model is its executor.

#### First milestone

- Discover user-selected local/repository skill directories and read metadata before loading a selected skill's body and references.
- Support explicit invocation plus bounded matching, with the selected version and reason recorded per task.
- Validate names, paths, resource sizes, dependencies, licensing and source revision. Show compatibility per adapter, including unsupported tools, scripts, hooks, substitutions and native plugin features.
- Integrate through supported native mechanisms where available; otherwise use an explicit instruction-only subset and say what is unavailable. Do not claim a copied prompt has native plugin parity.
- Offer a small opt-in starter set: frontend implementation, API contracts, database migration planning, accessibility, test authoring and independent review.

#### Acceptance criteria

- [ ] Only catalog metadata is included initially; full instructions and resources load when needed within a context budget.
- [ ] The same supported procedure can be used with at least two provider adapters, including after a handoff.
- [ ] Unsupported features fail clearly or require an explicit compatible alternative.
- [ ] Installing/updating a pack shows its source and changes, preserves existing user files, and can be disabled, pinned and removed.
- [ ] Skill content cannot override project instructions, tool permissions, billing choices or read-only review restrictions. Scripts/hooks are not executed merely by indexing a pack.
- [ ] #21 can propose a skill from a verified reusable solution, but saving or sharing it remains a reviewed action with provenance.
- [ ] Tests cover conflicting names, stale versions, path escape, missing tools and selective loading; evaluate correctness and total usage with and without each starter skill.

**Dependencies:** Task-scoped context and efficiency measurements.

**Technical format:** https://agentskills.io/specification

### Task budgets

**Issue title:** Enforce shared task budgets across agents, retries, reviews and quota fallback

**Tracking:** [#87](https://github.com/AhmedNavaz/codeshi/issues/87) — the first milestone is built in `src/task-budget.mjs`. Concurrent limits now cover the tasks of #88 and the main conversation together.

Shipped in 0.28.0: background reviews occupy workspace concurrency slots and stream usage into the parent's journal and budget checks, including quiet-run deadlines. With a time, token or spend cap, one worker reserves the remaining allowance for that task; additional same-task work waits rather than receiving the same remainder. No per-worker usage estimate is assumed. Cancellation before launch returns count reservations, accepted IDs are deduplicated, and interrupted recovery retains the latest reported usage. Fresh review sessions cannot change the builder's token baseline. The native Claude API cap uses the parent's remaining spend; other adapters use best-effort reported-usage checks. Simulated-provider tests cover API/unknown billing consent, shared token/spend overshoot, cancellation, quiet deadlines and recovery. Routing assessments share task accounting since 0.31.1.

**Shipped in 0.38.0:** a run that routing switches to another agent or a smaller model before it starts (#144) is no longer refused by its own reservation, is not counted as a handoff, needs billing consent again at launch, and books its usage under the agent that worked in the budget, ledger and replayed run. Claude's command-line connection receives `--max-budget-usd` as the SDK does, and Claude stopping at that cap is recorded as a task-limit stop rather than an agent error. Codex and Gemini expose no spend cap, so their checks stay best-effort.

**Shipped in 0.36.0:** the limits form now sets per-agent model allowlists, including local models. Missing API costs or explicitly unknown billing, and partial/missing token readings, persist across recovery as unknown remaining allowance; another run under the affected limit is refused until the person reviews that limit. Increasing a cap cannot repair missing evidence. Tasks shows measured overshoot, missing reports and native versus reported spend checks; reviewer and assessor enforcement details survive in the parent journal and ledger export. The existing task cannot bypass its limits by omitting a relation. Real paid API verification remains open; simultaneous measured workers still serialize rather than splitting an assumed remainder. Future orchestration types must join this same accounting path.

#### Problem

Routing and handoff already use subscription eligibility and available quota, but a user needs one execution policy covering the entire task. A builder, reviewer and repair loop must not each get an unrelated budget or keep launching work after the user intended it to stop.

#### Proposed outcome

A backend policy shared by the desktop, future CLI and team runner. It bounds total work while retaining manual model selection and the existing Cost Saving, Balanced and Maximum Quality modes.

#### First milestone

- Store a task policy with allowed providers/models, maximum concurrent workers, elapsed-work limit, retry/review/handoff counts and optional measured token/API-spend thresholds.
- Account for all child runs and orchestration calls under the parent task. Reserve capacity before scheduling new work and return unused reservations safely after completion/cancellation.
- Evaluate every applicable five-hour, weekly and model-specific quota window separately. Surface missing/stale quota data; do not assume an unused five-hour window overrides an exhausted weekly window.
- Keep subscription use, local execution and separately billed API use explicit. No extra spending remains the default; unknown billing cannot silently become paid usage.
- Reuse #12 selection, #17 handoff and #32 waiting rather than creating a second routing engine.

#### Acceptance criteria

- [x] Budget checks occur in the backend before every spawn, retry, review and handoff; UI/CLI callers cannot bypass them.
- [x] Concurrent work cannot double-allocate the task's remaining budget. Restart recovery preserves counters and deduplicates accepted work (one measured worker per task).
- [x] Native adapter caps are used where supported. Sampled/estimated usage limits are described as best-effort; in-flight overshoot is reported, not hidden (reporting follow-up shipped in 0.36.0).
- [x] Deadline, Stop or a confirmed provider failure saves a checkpoint and releases workers/leases. A quiet but healthy reasoning run is not automatically declared failed just because no text arrived.
- [x] Repeated identical failures/edits trigger a bounded stop or escalation offer, not an unlimited repair loop.
- [x] An exhausted/unknown allowance yields a clear wait, manual choice or eligible fallback, never an unauthorized account/model switch.
- [x] Simulated-provider tests cover weekly exhaustion with five-hour capacity, stale data, child accounting, cancellation, resumption and API consent.
- [ ] Verify spend enforcement and final accounting with a real paid API account; simulation does not prove live billing behavior.

**Dependencies:** Efficiency measurements. Refines #12, #17 and #32; approval correctness in #81 remains a prerequisite for unattended Codex work.

### Concurrent folder tasks

**Issue title:** Run independent folder tasks concurrently with isolated edits and recovery

**Tracking:** [#88](https://github.com/AhmedNavaz/codeshi/issues/88) — the first milestone is built in `src/task-coordinator.mjs` and `src/task-isolation.mjs`. Each task is a lane with its own broker and journal.

Shipped in 0.28.0: the Git panel's stage, unstage and commit actions take the same durable mutation leases as runs, patches, imports, checkpoint restores and task integration. Git writes lease the canonical repository root, including when the attached folder is nested or reached through a link, because sibling folders share the index. Independent repositories and separate worktree indices remain independent. Routes recheck folder membership after upload and under the lease, commit hooks retain the lease until completion, and shutdown waits for tracked Git actions. Tasks waiting on a tracked mutation retry when it releases its lease. Tests cover refusal without changing index/HEAD, cross-process exclusion, aliases, nested roots, separate worktrees/repositories, failed hooks, membership changes and shutdown. This addresses the remaining first-milestone Git-panel gap recorded in the issue comment. Worktree dependency setup, local models, task reviews, undo and recap integration remain follow-up work.

#### Problem

A workspace currently has one active conversation run, so a prompt scoped to one folder prevents independent work in another folder. This also blocks a future team from implementing distinct parts safely.

#### Proposed outcome

Let the user start a task for folder B while folder A's task continues, keeping one workspace history with distinct task threads, outputs, approvals, queues and Stop controls.

#### First milestone

- Choose each task's folder scope, context and dependencies explicitly; independent tasks may run together within the shared allowance policy.
- Establish durable task/run identities and per-task native sessions before allowing concurrent writes.
- Resolve canonical paths, nested roots, symlinks and Git repository identity. Different folder labels do not prove independent ownership.
- Use separate Git worktrees/branches for overlapping repository work. Disjoint repositories may run directly after checking mutation ownership; non-Git or unrestricted-tool cases serialize unless equivalent isolation is available.
- Treat file-ownership assignments as coordination metadata, not a security sandbox. Enforce boundaries with supported provider restrictions and isolated filesystems/worktrees.

#### Acceptance criteria

- [ ] Two independent folder-scoped prompts run simultaneously and remain distinguishable after reload/restart.
- [ ] Each task has its own output, approvals/questions and Stop; stopping one does not cancel the other or misroute a late event.
- [ ] Shared files, repository Git operations, imports, patches and checkpoint restore cannot race. Existing unrelated work is preserved.
- [ ] Combined changes are previewed and checked before integration; conflicts are surfaced without auto-overwriting either result.
- [ ] Folder removal, crashes and orphaned workers recover task ownership safely without widening access.
- [ ] Dependencies keep ordered work in the queue; aggregate usage and concurrency honor the parent/workspace policy.
- [ ] Tests include same repo under multiple roots, nested/symlink roots, concurrent worktree integration and non-Git fallback.

#### Implementation boundary

Refactor the broker's single running slot and workspace mutation leases through an explicit task coordinator; do not simply remove the concurrency guard. Background review isolation provides a useful existing pattern.

**Dependencies:** Shared task budgets and lifecycle recovery. Enables specialist teams; #16 race mode can later reuse this isolation.

### Specialist team workflows

**Issue title:** Coordinate frontend, backend, database, design and QA agents through verified workflows

**Tracking:** [#89](https://github.com/AhmedNavaz/codeshi/issues/89) — proposed, not implemented.

#### Problem

Cross-agent build/review exists, but a feature spanning interface, API and data needs explicit task dependencies, shared contracts and one integrated result. Naming several agents is not sufficient coordination, and creating a full team for a small edit can waste the user's allowance.

#### Proposed outcome

An optional Full-stack team mode with reusable task graphs. Start with a small plan and instantiate only the roles needed. Any supported connected provider/model may fill a role.

#### Example

For a checkout promo-code feature: agree on API/data contracts; frontend and backend work independently against that contract; a database specialist proposes any schema change; QA verifies the integrated result; an independent reviewer checks the final diff. A designer can review interaction/accessibility or produce supported design artifacts when requested.

#### First milestone

- Save an editable plan of bounded tasks, dependencies, role/model/skill assignments, owned scopes, expected artifacts and acceptance checks before starting.
- Ingest project plans, client briefs, and PRDs in arbitrary document formats, decomposing requirements into full-stack modules and sequential/parallel subtasks with assigned specialist roles, models, artifacts, and acceptance checks.
- Attach task-specific briefs instead of broadcasting the entire conversation to every teammate. Changes to a contract invalidate affected downstream work.
- Exchange structured artifacts: API contracts, schema/migration plans, diffs, test evidence and bounded findings, each tied to the source revision.
- Gate integration on applicable tests, types, build and independent review. Frontend visual/a11y checks need declared browser/tool support; unavailable checks are visibly unverified.
- Extend #15's existing build/review flow with a finite selected-findings repair cycle under the same budget; permit sequential teams when isolation is unavailable.

#### Acceptance criteria

- [ ] Begin with builder + independent reviewer, then frontend + backend + QA; a larger team is opt-in after evaluation.
- [ ] Shared contract first, independent implementation second, integration/checks third; dependent database work cannot race deployment or schema changes.
- [ ] Every role's provider, scope, skills, cost/usage and result is attributable in both UI and machine-readable events.
- [ ] QA failure blocks completion; an agent's self-report does not substitute for check evidence. Human acceptance remains distinct from worker completion.
- [ ] No-change, failed, blocked, skipped and unverified outcomes remain distinct. New findings cannot create an unlimited recursive review loop.
- [ ] Stop/pause/resume and targeted retry preserve completed work and do not replay side effects.
- [ ] Benchmark against one competent agent on identical tasks; report quality, coordination overhead, usage and elapsed time.
- [ ] Ingest project plan documents (markdown, text, PRDs, client briefs) to synthesize a draft start-to-end plan with specialist role and model assignments, dependencies, and acceptance checks without modifying project files.
- [ ] User inspection and verification: generated plans are fully editable in the Orchestrate plan panel (Normal and Flow mode) and require explicit user approval before execution begins.

**Dependencies:** Task-scoped context, portable skills, task budgets and concurrent task isolation. Builds on #12 and #15; #21 supplies reviewed project conventions.

### Codeshi CLI

**Issue title:** Add a Codeshi CLI for shared workflows, provider handoff and desktop continuity

**Tracking:** [#90](https://github.com/AhmedNavaz/codeshi/issues/90). A first slice shipped in 0.43.0 on macOS and in 0.48.0 on Windows: an interactive `codeshi` session, and `codeshi status`, `run`, `continue`, `wait`, `stop` and `tasks`, work through the desktop app's engine, starting it without a window when it isn't open, with `--json`/`--jsonl` output, documented exit codes, terminal approvals and `needs_input` without a terminal ([reference](cli.md)). Flow routing, workflows, `skills`, `doctor` and a Linux install remain proposals.

#### Problem

Codeshi workflows are tied to a desktop interface even though their useful behavior is in the broker and provider adapters. A terminal user should be able to use the same cross-provider task history, budgets, skills, checks and handoffs without a second implementation.

#### Proposed outcome

A CLI client of Codeshi's shared local execution engine. Its value is one durable workflow across providers and desktop/terminal sessions, rather than another prompt wrapper for one agent.

#### Proposed command surface (design examples, not shipped commands)

- codeshi run: submit a scoped task with a provider or routing policy.
- codeshi workflow run: execute a versioned build/test/review workflow.
- codeshi tasks, codeshi status, codeshi stop: inspect/control the same tasks seen in the desktop.
- codeshi continue: resume a saved task or explicitly hand it to an eligible provider.
- codeshi skills and codeshi doctor: inspect skill compatibility and connection/permission problems.
- --json/--jsonl output for stable event/result schemas and shell integration.

#### First milestone

Extract a headless service interface used by the desktop first, then implement status/run/continue/stop with identical approvals, leases, journal and billing policy. Avoid duplicating a provider's native agent loop or starting an independent data store.

#### Acceptance criteria

- [ ] A task started in the CLI can be inspected/continued in the desktop and vice versa, without concurrent ownership or duplicate provider runs.
- [ ] One local engine instance owns a workspace. Startup/attach/shutdown work when the desktop is closed, with authenticated local access rather than a new public server.
- [ ] stdout is structured/result output and stderr is human progress; event versions, exit codes and run/task IDs are documented.
- [ ] Interactive approvals use the existing lifecycle. In noninteractive mode, an unanswered approval yields a needs_input result/pause; absence of a terminal never implies approval.
- [ ] SIGINT, pipe closure and reconnect have explicit semantics and preserve recoverable state.
- [ ] Existing subscription connections remain subject to each provider's supported authentication/automation environment. CI/headless use is advertised only for verified adapters; API fallback requires separate opt-in.
- [ ] End-to-end tests use fake providers to cover build → test → review, quota handoff, pause/resume and desktop/CLI ownership.
- [ ] First release omits a custom terminal UI; add it only if task observation needs more than readable output.

**Dependencies:** Shared engine contract, task budgets and durable lifecycle; advanced team commands depend on specialist workflows.

## Updates to existing issues

These scope extensions are posted to the existing routing, memory and review issues rather than opening duplicates.

### Existing issue #12: Extend routing with measured task budgets and capability-aware selection

[Existing issue #12](https://github.com/AhmedNavaz/codeshi/issues/12) · [Posted scope extension](https://github.com/AhmedNavaz/codeshi/issues/12#issuecomment-6627782621)

#### Proposed core-roadmap follow-up

Keep this as the routing issue rather than opening a duplicate. Stages 1 and 2 already route whole prompts and perform one test-triggered escalation; the next stage should use measured completed-task outcomes, task-scoped context and a shared budget across planning, builders, reviewers and retries.

- Choose by required tools/skill compatibility as well as model capability, available allowance and observed outcomes.
- Evaluate applicable five-hour, weekly and model-specific windows independently; missing data stays unknown.
- Keep local rules as the default for straightforward requests. A planning-model call must justify and include its overhead.
- Expose the policy for desktop and CLI; retain manual override and explicit separately billed API consent.
- Prefer one agent until a measured quality or elapsed-time benefit justifies a team.
- Compare against a manually chosen single agent on equivalent tasks, reporting correctness, total measured usage, retries, interventions and wall time.

#### Routing and handoff trust requirements

These are planned acceptance criteria for #12 and #17, not claims about the shipped name-based model tiers. Flow (#107) will own delegated selection, with backend authority in [backend task policy #131](https://github.com/AhmedNavaz/codeshi/issues/131). Normal retains explicit choices and can inspect the same decision records. This is a planned mode boundary; improving presentation does not replace verifying the selection logic.

**0.28.0, quota milestone:** the page, task-budget view, handoff and retry paths share model-specific quota assessment. Routed dispatch refreshes the selected agent's usage before launch and saves its windows and observation time. Unknown readings are explicit for manual Send and cannot trigger automatic handoffs, retries or their reset fallback. Scoped-window arrays survive the journal, and old readings are not scored as known capacity. This does not complete the trust criteria: model capability verification, unified suitability ranking, allowance reservations across concurrent work, decision comparisons and measured manual-agent baselines remain open. Model tiers are still local heuristics.

**0.31.1, task assessment:** on Send a short read-only assessment on the smallest available model rates difficulty, required capabilities and effort from the prompt and recent task context, with no tools, plugins or skills. Selection then applies billing consent, folder support, allowed models, every applicable limit, reset times and continuity. Assessment usage shares the task budget; Stop or changed settings prevent execution; if no agent can rate a request in about twelve seconds, a local estimate is used and it never selects a light model. A replay on past prompts found rules alone matched the agent about half the time, and that sample is a direction rather than a measured quality claim. Model tiers remain heuristics and the comparison with manual selection is still open.

- [ ] Model capabilities have a source and verification date, cover the tools, inputs, context and skill support exposed by Codeshi, and distinguish provider claims from observed task outcomes. An unknown model is not ranked by its name alone.
- [ ] Required capabilities are checked before ranking suitable models by task fit, allowance, continuity and budget. More unused allowance cannot make an incompatible model eligible.
- [ ] Initial dispatch and every handoff refresh or explicitly identify unavailable/stale quota, check the selected model's applicable five-hour, weekly and model-specific windows, and account for concurrent tasks sharing allowance. Recheck after waiting or changing a destination.
- [ ] Usage forecasts expose their uncertainty and include transfer, retries and reviews. Do not convert subscription percentages into invented prompt/token capacity or promise a task will fit when the provider cannot establish that.
- [ ] One policy selects initial models and handoff destinations using the remaining task, current progress and required capabilities. A handoff preserves edits and unfinished work, avoids repeated switching, and prefers a safe boundary where available. With no suitable destination, offer waiting or manual selection within the existing billing rules.
- [ ] Before execution, explain task fit, constraining quota windows and their freshness, the cost of switching, and the tradeoff against staying or an alternative. A manual override remains available. Save the decision and outcome for the normal UI, Flow mode and future CLI without making extra model calls for presentation.
- [ ] Repeatable evaluations cover misleading/new model names, unsupported tools, missing capability data, stale quota, weekly exhaustion despite short-window room, concurrent usage and mid-task handoffs. Compare correctness, total reported usage, repeated work, retries and interventions with a manually chosen single agent, including coordination overhead. Define and meet acceptance thresholds before expanding automatic selection; show missing measurements rather than claiming savings.

This extends routing; measurement, context, task budgets, skills and team isolation are separate implementation workstreams.

Implementation proposals: #84 (measurement), #85 (context), #87 (shared budgets), #89 (specialist workflows).


### Existing issue #21: Promote reviewed project memory into the efficiency foundation

[Existing issue #21](https://github.com/AhmedNavaz/codeshi/issues/21) · [Posted scope extension](https://github.com/AhmedNavaz/codeshi/issues/21#issuecomment-6627785636)

**Tracking:** the first version is built in `src/project-memory.mjs`, following the [design](https://github.com/AhmedNavaz/codeshi/issues/21#issuecomment-6652426011). The proposal below is kept as written.

#### Proposed core-roadmap follow-up

Use this existing issue for persistent project knowledge rather than creating another memory system. The manual summary/goal/decisions/tasks fields already exist; a reviewed, evidence-linked memory layer should reduce rediscovery across providers.

- Store project/folder scope, source revision, evidence, date and status for conventions, decisions, working solutions and failed approaches.
- Suggest updates after verified outcomes. Users inspect, edit, accept, reject, export or delete them; raw history must not silently become permanent instructions.
- Retrieve only task-relevant entries within a small context budget. Show the provenance and invalidate/recheck facts when files, dependencies, branches or folder membership change.
- Separate durable project knowledge from ephemeral task state and private user preferences.
- Propose reusable procedures as SKILL.md candidates in the portable skill catalog, with an explicit review and licensing/source check before saving or sharing.
- Do not add model calls to every message to maintain memory. Account for optional extraction/summarization in the task budget.
- Measure fewer repeated reads/failed approaches without lowering correctness; test stale memories, contradictory user instructions, malicious tool text and cross-project leakage.

Proposed priority: Next, alongside task-scoped context. This remains a design proposal, not a claim that automatic memory is shipped.

Implementation proposals: #85 (context) and #86 (portable skills), evaluated through #84.


### Existing issue #15: Extend build-review into bounded verified workflows

[Existing issue #15](https://github.com/AhmedNavaz/codeshi/issues/15) · [Posted scope extension](https://github.com/AhmedNavaz/codeshi/issues/15#issuecomment-6627787387)

#### Proposed core-roadmap follow-up

Preserve the shipped per-prompt build → tests → read-only review workflow. A future workflow engine should reuse its captured scopes, findings and approval model rather than invent another review engine.

- Define versioned workflows with explicit dependencies, check commands, expected artifacts and completion rules.
- Add finite selected-findings repair cycles only within the user's chosen authorization and total task budget.
- For full-stack teams, review the integrated revision and invalidate findings/check evidence after relevant edits.
- Allow deterministic build/type/lint/test gates before spending allowance on another agent. Include browser/a11y/security checks only when their tools and scope are supported.
- Keep failed, blocked, skipped and unverified checks distinct. Successful agent text alone does not mark a workflow accepted.
- Count coordinator, builder, reviewer and repair work together. Pause/restart recovery must not rerun a migration or other side effect blindly.

Start with a builder and independent reviewer; larger role-based teams follow task isolation and shared budgets. This adds core orchestration to #15 without treating more agents as an automatic quality improvement.

Implementation proposals: #87 (budgets), #88 (task isolation) and #89 (specialist workflows).


## Technical references

- [Agent Skills format](https://agentskills.io/specification): portable SKILL.md structure; provider-specific extensions still need compatibility checks.
- [Claude Code skills](https://code.claude.com/docs/en/skills) and [Codex skills](https://learn.chatgpt.com/docs/build-skills): native skills already exist; load selected procedures rather than the entire library.
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) and [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): useful native foundations, with coordination and token overhead that must be included in evaluation.
- [Claude Code cost management](https://code.claude.com/docs/en/costs): context size, cache behavior, effort and team size influence usage; API prices are not subscription-quota conversions.
- [Codex noninteractive execution](https://learn.chatgpt.com/docs/non-interactive-mode) and [Codex integration layers](https://developers.openai.com/blog/codex-as-a-platform): reuse supported execution interfaces for a shared workflow service.

References were inspected on 2026-11-04. These are design inputs; specific provider versions and account capabilities must be validated during implementation.

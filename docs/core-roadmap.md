# Core execution roadmap

Status: design proposals tracked in GitHub issues #84–#90, with scope extensions posted to #12, #21 and #15. The first milestones of #84, #85, #86, #87, #88 and #21 shipped in 0.26.0, each noted under its section; everything else here is still a proposal. Existing behavior is described separately from proposals. No runtime feature is implemented by this document.

## Product outcome

Help a person finish a verified task across their chosen coding agents with less repeated work and clear control over allowance. The desktop and a future CLI should expose the same execution engine, history, skills, checks and policy.

Codeshi cannot increase a provider's subscription allowance, change its reset rules or guarantee a token-to-quota conversion. Improvements must come from relevant context, appropriate model/effort selection, reusable procedures, early verification and bounded recovery. More agents can improve elapsed time or coverage while increasing total usage.

## Existing foundation and gaps

- Local rule-based routing and model/effort selection already ship; see public/routing.js and #12.
- Context already favors task intent over tool logs, preserves the original journal and uses native-session deltas; see src/context.mjs and #69. Task-based code retrieval and reviewed learned memory remain proposed.
- Handoff/reset waiting, one test-triggered escalation, build/review and checkpoints already exist; see src/handoff.mjs, src/resume.mjs, src/run-checks.mjs and src/automatic-review.mjs.
- The broker still serializes active work per workspace, and mutation leases protect shared files. Concurrency requires a new task/ownership model, not removal of a guard.
- Native provider capabilities differ. Codeshi disables user/project hooks for its invocations and restricts tools; skills/plugins/team features need an explicit compatibility design.
- Approval correctness (#81) and reliable Stop/completion/worker cleanup must be fixed before widening unattended orchestration. Record actual provider failures separately from frontend state errors.

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

All command names in the CLI proposal are examples, not installed functionality.

## Issue proposals

The following sections preserve the scope, dependencies and acceptance criteria of the linked GitHub issues. Implementation discussion belongs in those issues.

### Task efficiency

**Issue title:** Measure completed-task quality and agent usage before claiming efficiency gains

**Tracking:** [#84](https://github.com/AhmedNavaz/codeshi/issues/84) — the first milestone is built: the ledger in `src/task-ledger.mjs` and the suite in [`evals/`](../evals/README.md). Live comparisons so far are too small to claim a gain.

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

**Sequence:** Foundation; implement first.

### Task scoped context

**Issue title:** Build task-scoped context from relevant code, history and verified project memory

**Tracking:** [#85](https://github.com/AhmedNavaz/codeshi/issues/85) — the first milestone is built in `src/task-context.mjs`. Retrieval reads Git and the files when a prompt is built, without a saved index, and reviewed memory (#21) goes out with the brief.

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

#### Implementation boundary

Build on src/context.mjs and #21 project memory, with a local retrieval index and provider-specific sizing adapters. Preserve the append-only journal and existing secret/path boundaries.

**Dependencies:** Task-efficiency measurements; extends #69 handoff context.

### Portable skills

**Issue title:** Load reusable skills across providers with explicit compatibility and scope

**Tracking:** [#86](https://github.com/AhmedNavaz/codeshi/issues/86) — the first milestone is built in `src/skills.mjs` and `starter-skills/`. Every agent gets skills as instructions in the prompt; using each agent's own skill system is still to do.

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

- [ ] Budget checks occur in the backend before every spawn, retry, review and handoff; UI/CLI callers cannot bypass them.
- [ ] Concurrent work cannot double-allocate the task's remaining budget. Restart recovery preserves counters and deduplicates accepted work.
- [ ] Adapter-reported hard limits are used where supported. Sampled/estimated usage limits are described as best-effort; in-flight overshoot is reported, not hidden.
- [ ] Deadline, Stop or a confirmed provider failure saves a checkpoint and releases workers/leases. A quiet but healthy reasoning run is not automatically declared failed just because no text arrived.
- [ ] Repeated identical failures/edits trigger a bounded stop or escalation offer, not an unlimited repair loop.
- [ ] An exhausted/unknown allowance yields a clear wait, manual choice or eligible fallback, never an unauthorized account/model switch.
- [ ] Tests cover weekly exhaustion with five-hour capacity, stale data, child accounting, cancellation, resumption and API consent.

**Dependencies:** Efficiency measurements. Refines #12, #17 and #32; approval correctness in #81 remains a prerequisite for unattended Codex work.

### Concurrent folder tasks

**Issue title:** Run independent folder tasks concurrently with isolated edits and recovery

**Tracking:** [#88](https://github.com/AhmedNavaz/codeshi/issues/88) — the first milestone is built in `src/task-coordinator.mjs` and `src/task-isolation.mjs`. Each task is a lane with its own broker and journal.

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

**Dependencies:** Task-scoped context, portable skills, task budgets and concurrent task isolation. Builds on #12 and #15; #21 supplies reviewed project conventions.

### Codeshi CLI

**Issue title:** Add a Codeshi CLI for shared workflows, provider handoff and desktop continuity

**Tracking:** [#90](https://github.com/AhmedNavaz/codeshi/issues/90) — proposed, not implemented.

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

These are planned acceptance criteria for #12 and #17, not claims about the shipped name-based model tiers. Flow mode (#107) presents the same policy and decision records; improving presentation does not replace verifying the selection logic.

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

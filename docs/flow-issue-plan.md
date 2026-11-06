# Pending Flow issue changes

These are local drafts for the agreed Normal/Flow plan. No issues or issue updates in this file have been published. Existing issue states and shipped milestones should be preserved. Re-read the current issue body and comments before applying a draft so newer discussion is not overwritten.

The canonical product split is in [ROADMAP.md](../ROADMAP.md#normal-and-flow-the-agreed-execution-split), with backend boundaries in the [core roadmap](core-roadmap.md#normal-and-flow-execution-contract). New issue references below link to drafts until GitHub issue numbers exist.

## New issues

### Backend task policy

**Proposed title:** Enforce Normal and Flow execution policies per task with safe manual takeover

#### Problem

Flow currently changes the interface, while routing, automatic handoff and recovery are configured separately. A layout flag stored in one browser cannot authorize work across desktop, phone, restart recovery and a future CLI.

#### Agreed outcome

Normal is explicit control: the person selects agents, models, effort, tasks and next actions. Flow delegates execution decisions within an authorized outcome and budget. Automatic routing, discretionary handoff, bounded repair and future automatic task assignment belong to Flow; manual building blocks and exact user-configured sequences remain available in Normal.

This issue implements that execution boundary. #107 owns the Flow experience, #12 owns shared selection, #87 owns accounting and limits, and #108/#89 own later orchestration. Do not add another routing engine or task store.

#### Scope and acceptance criteria

- [ ] For the preview, block both view changes while workspace tasks/agents, reviews, tests, reset waits or an unpaused queue can still run. Recheck at transition time; do not implicitly create a new task or queue a delayed view change. Keep running task navigation and Stop reachable. This preview activity guard is distinct from the durable authority below.
- [ ] Persist a versioned task execution policy in the shared backend/journal, independent of browser layout and separate from read/edit access, tool approval mode and billing consent.
- [ ] Record Normal/Flow, routing preference, allowed automation, provider/model restrictions, override scope (one step or pinned) and authorization provenance. Different tasks in one workspace may have different policies.
- [ ] Revalidate the current policy before initial dispatch, queued dispatch, handoff, reset resumption, retry, review and child-task creation. A phone, stale tab or direct API caller cannot bypass it.
- [ ] Normal permits manual switching, explicit handoff offers, fixed queued messages, exact user-configured build/review or check sequences, and an explicitly selected agent's reset wait. Codeshi does not choose a new provider, model or task on its own.
- [ ] Flow may make only the decisions authorized for that task, using #12's common selection policy and #87's shared budget. Switching to Flow grants neither extra tool access nor permission to incur separate API charges.
- [ ] Take manual control revokes future discretionary dispatch at a safe boundary, invalidates stale queued automatic decisions and offers, and preserves completed/current work. Define how an in-flight native turn reaches that boundary; Stop remains immediate and distinct.
- [ ] Distinguish inspecting a task in another view from changing its execution policy. Opening a phone, changing a layout or closing a window never silently changes task authority. Surface the active policy on every controlling client.
- [ ] Restart recovery preserves policy, counters, ownership and deduplication. It does not introduce new automatic starts beyond the task's existing authorization.
- [ ] Migrate existing routing, handoff, wait and queue settings without silently broadening or withdrawing in-flight authorization. Preview the change for new work, preserve recoverable legacy work and provide an explicit transition.
- [ ] Tests cover stale-client races, mode changes before dispatch, takeover during quota waits/review/retry, simultaneous Normal and Flow tasks, restart and desktop/phone parity. No extra provider starts or billing requests occur after revocation.

#### Delivery

Implement before presenting Flow as managed execution. Start with one task, unified routing/handoff and bounded verification/recovery; then task splitting; then teams and hands-free operation. Native agents retain their own tool loops, planning and compaction in both modes.

No runtime behavior is changed by this issue. Historical shipped behavior in #17, #32, #91 and #15 remains recorded there; follow-up mode enforcement is tracked here.

### Board and schedule execution

**Proposed title:** Run project task boards and schedules with explicit Normal and Flow policies

#### Problem

The roadmap describes task boards and schedules without a dedicated execution issue. #97 already owns the plan/card/canvas/board views; this issue owns starting that work and scheduling it, without creating another task model.

#### Agreed split

- Normal: manage cards, priorities and assignments; run a selected card or an exact dependency graph; schedule a fixed prompt/workflow with explicit agents/settings.
- Flow: authorize an outcome or bounded backlog selection; Codeshi chooses eligible assignments and execution order under routing and task budgets. Agent-created plans start as drafts; delegated execution requires the relevant task authorization.

#### Acceptance criteria

- [ ] Reuse #97 cards and #88 task identities. Board, plan outline/canvas, queue, Flow task cards and execution history reference the same underlying work.
- [ ] Support Backlog, Ready, Doing, Review and Done with acceptance checks, dependencies, priority and attribution. Worker completion and human acceptance remain distinct.
- [ ] Normal preserves explicit assignments and user edits. Flow uses #12 for assignments; no card defaults silently to Flow or Auto merely because it was created or scheduled.
- [ ] Scheduling binds the task policy, prompt/card revision, provider restrictions, access, approvals and budget. Material changes require updated authorization; harmless progress does not require repeated confirmation.
- [ ] Support one-off and recurring runs with durable identities, cancellation and deduplication. Missed runs are visible and wait unless late execution was explicitly permitted. Sleeping/offline machines are not advertised as always available.
- [ ] Flow's Run Ready work stays within an authorized set of cards, dependency graph and concurrency/usage budget. Unrelated backlog work is never added by implication.
- [ ] Takeover, Stop, failed prerequisites, quota waits and restart recovery prevent unintended starts and preserve prior results. Required approvals pause work.
- [ ] Keep publishing user-controlled; neither a schedule nor Flow mode grants permission to push, deploy or release.
- [ ] Cover fixed Normal schedules, Flow assignment, changed cards, duplicate timers, restart, missed runs, exhausted quota and stale policy with recorded-provider tests.
- [ ] Report total parent/child usage and outcomes under #84/#87; measure scheduling and coordination overhead without claiming unmeasured savings.

#### Dependencies

#97 (shared cards/views), #88 (isolation), #12 (selection), #87 (budgets), #85 (context), #107 (Flow), [backend task policy](flow-issue-plan.md#backend-task-policy) (backend mode policy). Ship manual board execution first, fixed schedules next, then bounded Flow backlog execution.

## Existing issue updates

### Issue 107

[Current issue #107](https://github.com/AhmedNavaz/codeshi/issues/107) · Preserve state: **open**.

**Proposed title:** Flow mode: manage outcomes through routing, handoff and bounded workflows

Replace the issue body with the following draft:

#### Problem

A Flow layout alone does not delegate the work. Routing, handoff, recovery and future task assignment need one execution contract, while Normal must retain full manual control and exact user-configured workflows.

#### Agreed product contract

**Normal:** the person chooses agents, settings, tasks and next actions. **Flow:** the person describes an outcome and Codeshi manages execution decisions within the authorized scope and budget.

Flow-exclusive behavior means delegated decision-making, not every action that runs automatically. A fixed user queue, an exact build-then-review sequence, context protection and native agent planning remain available in Normal. This plan supersedes the earlier layout-only scope; the execution boundary is not implemented merely by updating this issue.

#### Feature ownership

| Feature | Normal | Flow |
| --- | --- | --- |
| Agent, model and effort | Explicit selection; optional recommendations require acceptance | Automatic routing under Cost Saving, Balanced or Maximum Quality; one-step or pinned overrides |
| Near-limit handoff | Chat offer naming destination, settings, billing and allowance; accept or decline | Automatic policy-aware handoff within task authorization |
| Quota failure and reset waits | Manual destination/local choice, or explicitly wait for a selected agent | Choose a suitable allowed alternative; otherwise wait or report the blocker |
| Queued prompts | Exact user prompts and settings, with edit/reorder/cancel | Same user queue plus clearly identified managed work; do not silently rewrite user prompts |
| Tasks and concurrency | Manually create, assign and run independent tasks | Decide whether bounded splitting, assignment and parallel execution are worthwhile |
| Native agent plan and tools | Retain the native agent's own planning and tool loop | Present progress toward the outcome; Codeshi manages cross-agent execution |
| Tests and retries | Run checks directly or attach an exact check sequence; approve new repair decisions | Run agreed checks and choose bounded repair/escalation |
| Reviews | Choose scope/reviewer/findings; retain explicit one-prompt build-then-review | Select a suitable independent reviewer and manage authorized finite repair cycles |
| Local models | Explicit choice or manual continuation | Eligible fallback only after capability/hardware checks; never assume all local models fit |
| Preview and point-and-tell | Full preview and element selection | Central feedback loop: inspect, point, describe and continue |
| Files and attachments | Full browser and exact attachment controls | Simple attach/browse actions with detail available |
| Git, diffs and publishing | Full repository controls | Plain-language change review; publishing remains user-controlled |
| Undo, redo and Timeline | Full recovery controls | Equally accessible previewed recovery; no hidden way back |
| Terminal and Run windows | Full tools | Omitted from Flow UI; authorized agent commands still work |
| Voice | Dictation and read-aloud | Dictation plus the future continuous hands-free conversation loop (#72) |
| Remote access | Control manual work from the phone | Observe, steer, answer requests and stop managed work under the same backend policy |
| Split requests (#108) | Manual split/assignment; accept an agent's draft proposal | Create/assign bounded subtasks within an authorized outcome |
| Specialist teams (#89) | Individual role/task/review building blocks remain usable | Managed contracts, role assignment, dependencies, integration and verification |
| Visual Plans (#97) | Create/edit/connect cards; explicitly assign and run an exact graph | Draft an outcome plan, assign work and manage execution within authorization |
| Task boards and schedules ([board and schedule execution](flow-issue-plan.md#board-and-schedule-execution)) | Fixed prompts/workflows, explicit settings and selected cards/graphs | Authorized outcomes or bounded backlog sets with automatic assignment |
| Race mode (#16) | Explicit two-attempt comparison and result selection | Optional managed comparison; never implied by Maximum Quality |
| GitHub/CI context (#18) | Select context and actions explicitly | Gather relevant context within authorized repository scope; external text remains untrusted |
| Contextual suggestions (#106) | Explain and offer a change for acceptance | Explain decisions and propose meaningful policy changes; suggestions grant no authority |
| Multiplayer (#24) | Shared manual collaboration | Shared observation/steering with explicit authority and no conflicting controllers |
| Future CLI (#90) | Explicit agents and exact workflows | Same backend Flow policy; no second orchestration engine |

#### Shared foundation

Both modes retain context selection and native-compaction visibility, the canonical shared history and briefs, reviewed memory, portable skills, usage readings and task accounting, budgets and concurrency protection, recovery, read/edit access and tool approvals (including optional full auto-approval), import/export, conversation search, Ask a Friend, recaps, notifications and menu-bar status, keep-awake, themes, setup, updates, accessibility, translations and platform/adapter support. Phone notifications/Home Screen support, binary patches and collaboration improvements are also shared. Flow may change their presentation, not remove their protections or grant extra access. Durable memory changes remain reviewed.

#### Flow experience

Keep the chat central with fixed purposeful cards: how work is assigned, remaining allowance, next steps and changed files/recovery. Explain automatic decisions and their reasons from recorded data, without a model call just to render a card. Agents/Timeline/Git details use dismissible Flow sheets. Utilities use the side space; narrow windows retain access. Approvals, questions, Stop and Take manual control are always reachable. Native window controls and interactive buttons must remain clickable; support keyboard/screen readers, reduced motion and both themes. Do not display unmeasured savings.

#### Execution and migration

[backend task policy](flow-issue-plan.md#backend-task-policy) owns durable per-task authority across desktop, phone, restart and CLI, separate from local layout, permissions and billing. Opening another view never changes authorization. Taking manual control revokes future discretionary dispatch at a safe boundary and preserves work; Stop is immediate and separate. Do not silently reinterpret existing queued or in-flight work during migration.

#### Delivery

1. **One managed task:** backend mode policy and safe takeover ([backend task policy](flow-issue-plan.md#backend-task-policy)), unified selection/handoff (#12, extending #17/#32/#91), visible decisions, checks and bounded recovery (#15), with measurements (#84) and controlled context (#85).
2. **Managed task splitting:** build on manual task isolation (#88), bounded fan-out (#108), shared Plan cards (#97), board/schedule execution ([board and schedule execution](flow-issue-plan.md#board-and-schedule-execution)) and one parent budget (#87).
3. **Specialist teams and hands-free work:** managed contracts and integration (#89), then the continuous voice loop (#72), with verified lifecycle, context retention and measurable overhead.

Existing manual capabilities and exact user-configured sequences remain available throughout. These are implementation stages, not release promises.

#### Acceptance criteria

- [ ] Normal retains every manual building block and exact user-authorized sequence in the ownership table.
- [ ] Flow genuinely manages a bounded outcome using the backend policy, rather than toggling hidden controls.
- [ ] Initial assignment, handoff, retry, reviewer selection and future child assignment use one policy (#12) and the same task budget (#87).
- [ ] Native agent loops, context handling, permissions and billing remain correctly separated from Codeshi orchestration.
- [ ] Takeover, Stop, overrides, stale clients and restart preserve authority and completed work.
- [ ] The Flow interface explains decisions, keeps recovery available and works without workbench panels.
- [ ] End-to-end tests verify one managed task before fan-out/teams; live efficiency claims require #84 evidence.

**Related:** #12, #17, #32, #91, #84, #85, #87, #88, #108, #89, #97, #72, #90, #106, #113.

### Issue 12

[Current issue #12](https://github.com/AhmedNavaz/codeshi/issues/12) · Preserve state: **open**.

**Proposed title:** Unify Flow routing, handoff and model/effort selection across each task

Replace the issue body with the following draft:

#### Scope and shipped foundation

Routing chooses an agent, model and supported reasoning effort. Stages 1/2 shipped before Flow: local classification, a visible choice/override and one test-triggered escalation. The selected-model quota milestone shipped in 0.28.0. Model-name tiers remain heuristics; these releases do not prove a saving or a quality ranking.

#### Agreed Normal/Flow boundary

Automatic selection is part of Flow (#107), enforced by [backend task policy](flow-issue-plan.md#backend-task-policy). Normal keeps explicit model/effort choice and optional recommendations that the person accepts. Exact user-configured checks/review sequences remain usable in Normal. Do not silently reinterpret existing routing or queued work during migration.

#### One selection policy for the whole task

- [ ] Use the remaining task, progress, required tools/inputs/context and verified model/skill capability before considering capacity. Unknown models do not inherit proven capabilities from their names.
- [ ] Apply Cost Saving, Balanced or Maximum Quality consistently to initial assignment, near-limit handoff, quota-error fallback, reset resumption, retries, reviewer selection and future subtasks.
- [ ] Select destination model **and effort**, rather than ranking only each provider's saved model by subscription billing and spare allowance.
- [ ] Evaluate every applicable five-hour, weekly and model-specific limit, reading freshness, other active tasks, continuity and transfer/re-reading overhead. Refresh before dispatch; unknown/stale usage cannot authorize automatic work.
- [ ] Respect allowed providers/models, task scope, manual pins, approval mode and shared time/token/spend/retry/review/handoff limits. Separately billed API use needs its own authorization and enforceable budget.
- [ ] Cost Saving prefers sufficient capability and existing allowance with restrained extra work; Balanced matches the remaining work and escalates on evidence; Maximum Quality prefers stronger suitable reasoning and targeted checks without implying unlimited teams or race attempts.
- [ ] Local/free fallback is offered only when the adapter, capabilities and hardware are verified. With no suitable permitted destination, wait or offer a manual choice.
- [ ] Preserve edits and unfinished plans, avoid repeated switching, explain the choice and record alternatives, quota evidence, policy revision and overrides for Normal/Flow/CLI views.
- [ ] Keep routing overhead small. Planning calls, handoff reconstruction, retries and reviews count under #84/#87; compare against a manually chosen single agent on equivalent work.

#### Subtasks and existing discussion

Keep orchestration a per-request action, not a fourth quality mode. #108 owns bounded splitting and #89 managed specialist teams; #97 supplies editable shared cards. Earlier discussion proposed a maximum of five subtasks and one review cycle as an initial bound; actual execution must also honor the current parent policy. Native-session strategy follows the current context rules and retention tests rather than an older comment's assumption that switching agents always resumes old native sessions.

**Dependencies:** [backend task policy](flow-issue-plan.md#backend-task-policy), #84, #85, #87; extends #17/#32/#91. This issue update is a plan, not a runtime change.

### Issue 17

[Current issue #17](https://github.com/AhmedNavaz/codeshi/issues/17) · Preserve state: **closed**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This issue remains closed for its shipped milestone. Future mode enforcement is tracked by [backend task policy](flow-issue-plan.md#backend-task-policy) and #12; the following plan does not mark new behavior as shipped. Product contract: #107.

Normal retains near-limit chat offers with destination agent/model/effort, billing, quota and scope shown before acceptance. Flow may hand off automatically only under its task authorization and #12's common quality/usage policy. Keep stale-offer revalidation and separate API consent. Include continuity and transfer overhead; pause or wait when no suitable destination is confirmed.


### Issue 32

[Current issue #32](https://github.com/AhmedNavaz/codeshi/issues/32) · Preserve state: **closed**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This issue remains closed for its shipped milestone. Future mode enforcement is tracked by [backend task policy](flow-issue-plan.md#backend-task-policy) and #12; the following plan does not mark new behavior as shipped. Product contract: #107.

Normal keeps exact queues and an explicit wait for the person-selected agent. Choosing whichever agent becomes eligible, changing assignments or automatically entering a broader fallback wait belongs to authorized Flow work. Preserve each queued prompt's explicit settings and policy provenance; recovery must not silently turn a fixed Normal wait into an automatic cross-agent choice.


### Issue 91

[Current issue #91](https://github.com/AhmedNavaz/codeshi/issues/91) · Preserve state: **closed**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This issue remains closed for its shipped milestone. Future mode enforcement is tracked by [backend task policy](flow-issue-plan.md#backend-task-policy) and #12; the following plan does not mark new behavior as shipped. Product contract: #107.

Quota-error fallback is delegated Flow behavior, using the same agent/model/effort policy as initial routing and near-limit handoff (#12). Normal stops with manual continue/local/wait choices. A Flow task with no suitable destination may enter an authorized reset wait; unknown quota/billing does not permit dispatch, and a mode change or takeover invalidates pending automatic continuation.


### Issue 88

[Current issue #88](https://github.com/AhmedNavaz/codeshi/issues/88) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Manual task creation, explicit assignment, user-chosen concurrency and Run as a task remain available in Normal. Flow's automatic splitting/assignment is #108 and must reuse these same task IDs, brokers, ownership, worktrees, merge review and recovery paths. Do not create a second Flow task store. Backend policy applies independently per task; budgets and isolation protect both modes.


### Issue 108

[Current issue #108](https://github.com/AhmedNavaz/codeshi/issues/108) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Normal permits manual splitting and assignment, plus an agent-generated draft that the person accepts. Flow may create and assign bounded subtasks only within an explicitly authorized outcome and parent budget. Reuse #88 isolation and #97 cards. Preserve the initial finite fan-out/no recursive splitting rule; model/effort choice uses #12, and takeover/Stop/restart prevent unintended child starts. A planner's draft alone never grants execution authority.


### Issue 89

[Current issue #89](https://github.com/AhmedNavaz/codeshi/issues/89) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

The managed specialist-team workflow belongs to Flow: shared contracts, role assignment, dependencies, integration, evidence and bounded repair. Normal retains the individual task/role/review controls for manually arranging equivalent work. Share #97/#88 task objects and #87 accounting; instantiate only useful roles, never a default full team for every request. Human acceptance remains distinct from worker completion. Native agents' own internal planning/subagents are not disabled in Normal.


### Issue 97

[Current issue #97](https://github.com/AhmedNavaz/codeshi/issues/97) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Plans, canvas/board/outline views and card editing remain shared. Normal can ask an agent for a draft, explicitly assign every card and run a selected card or exact dependency graph. Flow may generate proposed plans and manage assignments/execution only within its approved task policy. Auto is a Flow choice, not the default for every Normal card. Preserve user edits, privacy and draft-review rules; bounded execution authority does not grant permission to rewrite unrelated plans. Reuse one set of cards for plans, board execution ([board and schedule execution](flow-issue-plan.md#board-and-schedule-execution)), #108 and #89.


### Issue 15

[Current issue #15](https://github.com/AhmedNavaz/codeshi/issues/15) · Preserve state: **closed**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This issue remains closed for its shipped milestone. Future mode enforcement is tracked by [backend task policy](flow-issue-plan.md#backend-task-policy) and #12; the following plan does not mark new behavior as shipped. Product contract: #107.

Normal keeps manual reviews and the explicitly selected one-prompt build-then-review sequence. Flow owns discretionary reviewer selection and authorized finite repair/review cycles using #12 and #87. Preserve captured review scope, independent read-only findings and revision validity; no unbounded loops or treating an agent's self-report as verified completion.


### Issue 16

[Current issue #16](https://github.com/AhmedNavaz/codeshi/issues/16) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Normal may explicitly start a two-agent comparison with chosen settings and select the result. Flow may manage a comparison only when that extra work is explicitly allowed and bounded; Maximum Quality alone does not authorize two competing attempts. Count both attempts and integration/selection overhead, preserve isolated worktrees and make result acceptance clear.


### Issue 72

[Current issue #72](https://github.com/AhmedNavaz/codeshi/issues/72) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

The continuous listen → send/steer → work → spoken-result loop belongs to Flow. Ordinary dictation and read-aloud remain available in Normal and Flow. Starting Flow does not enable the microphone or voice sending implicitly. Keep visible listening state, Stop listening/Escape, deliberate approvals, recognizer-limit recovery and platform-specific privacy disclosures.


### Issue 90

[Current issue #90](https://github.com/AhmedNavaz/codeshi/issues/90) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Expose the same Normal and Flow task policies in the shared engine. Normal CLI requests name agents/settings or an exact workflow; delegated CLI work explicitly selects Flow and its bounds. No separate orchestration store or authority inferred from a missing interactive terminal. Report mode/policy revision and takeover/Stop/recovery in structured events; command spellings remain design examples until implemented.


### Issue 18

[Current issue #18](https://github.com/AhmedNavaz/codeshi/issues/18) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Normal retains explicit GitHub/CI context selection and publishing controls. Flow may gather relevant issue/PR/comment/check context only inside the task's authorized repository scope and existing privacy rules; imported text remains marked untrusted. This future scoped read behavior extends the earlier no-background-fetch proposal only for authorized Flow work. Neither Flow nor schedules grant implicit authority to push, deploy or release; retain user-controlled publication and review.


### Issue 84

[Current issue #84](https://github.com/AhmedNavaz/codeshi/issues/84) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Measurement/accounting is shared infrastructure, not Flow-exclusive. Compare Flow against Normal manual selection and exact user-defined workflows on equivalent pinned work. Include long same-agent threads, repeated switches (including switching back), separate-task baselines, multi-folder work and compaction/retention cases. Separate current context occupancy, per-run/task consumption and cumulative native-session totals. Include planning, handoff reconstruction, repeated reads, cache behavior, reviewers, retries, teams and native compaction where measurable; missing attribution stays unknown. Check instruction/decision/blocker retention and correctness alongside wall time, interventions and variability. Live comparisons remain explicit budgeted opt-ins; make no savings claims from smaller prompts alone.


### Issue 85

[Current issue #85](https://github.com/AhmedNavaz/codeshi/issues/85) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Context selection, journal preservation, reviewed memory/skill retrieval and native-compaction visibility serve both modes. The default 192,000-byte cloud / 96,000-byte local text-envelope cap is not a bound on native retained context or cumulative token usage. Show current provider-reported context/capacity separately from session and task consumption; label estimates/unavailable data. Persist native compaction records/counts distinctly from Codeshi's omissions/excerpts, with concise Flow presentation and detailed Normal inspection. Make handoffs task-focused around instructions, acceptance criteria, decisions, blockers, failures and current file references; retrieve older journal material when needed. Preserve provenance/access boundaries, revalidate file-backed facts and test retention through handoff/native compaction under #84. Respect native compaction ownership; do not invent a universal threshold or silently reset sessions.


### Issue 87

[Current issue #87](https://github.com/AhmedNavaz/codeshi/issues/87) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Budgets, concurrency reservations, quota evidence, repeated-failure records, cancellation and recovery protect Normal and Flow equally. This issue owns accounting/limits; [backend task policy](flow-issue-plan.md#backend-task-policy) owns authorization for discretionary actions. One Flow parent budget includes planner, builder, reviewer, repair and all child work; mode changes or agent switches cannot reset it. Exact Normal workflows consume the same ledger and limits. Spending consent and tool approval remain separate from quality preferences.


### Issue 106

[Current issue #106](https://github.com/AhmedNavaz/codeshi/issues/106) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Suggestions remain available in both modes and never grant authority. In Normal, automatic routing or managed execution suggestions should offer a previewed transition to Flow, not silently enable it. In Flow, explain recorded decisions and propose meaningful policy changes without granting them. Memory/skills/budget suggestions remain shared, local, dismissible and free of unmeasured savings claims.


### Issue 113

[Current issue #113](https://github.com/AhmedNavaz/codeshi/issues/113) · Preserve state: **open**.

Append the following scope section, preserving existing body and completion checkboxes:

#### Agreed Normal/Flow execution split

This section governs future implementation where earlier proposal text differs. It does not change shipped behavior or mark new work complete. Product contract: #107.

Normal retains per-message agent/model/effort editing without changing the active run. Flow shows whether a queued item is automatic or explicitly pinned, the override's scope and the settings used at dispatch. Editing a routed item's model/effort creates a clearly recorded manual override; it must not silently restore routing later. Handoff, reset, takeover and restart preserve the item's execution policy, permissions and billing provenance; desktop and phone use the same backend validation.

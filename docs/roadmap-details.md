# Roadmap details

The longer design notes behind the [roadmap](../ROADMAP.md): the direction for core execution, the split between Normal and Flow, and the scope of the larger planned items. The roadmap itself lists what is being worked on and in what order. These are proposals until implemented and released; the [core execution plan](core-roadmap.md) goes deeper on scopes and acceptance criteria.

## Core execution direction

The next core milestone is **more verified work from the allowance users already have**. Codeshi already has routing with a short task assessment, bounded context, native-session continuation, quota handoff, queued prompts and test-triggered escalation. These are useful foundations; they do not yet prove a reduction in tokens or an improvement over a single agent on equivalent tasks.

The proposed order is:

1. **Establish the baseline.** Measure completed-task correctness, total reported usage, retries, elapsed time and interventions. Fix lifecycle and approval failures before expanding unattended work.
2. **Reduce repeated work.** Select relevant code and history, retrieve reviewed project memory, load skills on demand and enforce one budget across a task's planning, implementation, reviews and retries.
3. **Coordinate independent work.** Run folder-scoped tasks concurrently with durable ownership, isolated changes and checked integration. Start with a builder and independent reviewer; add frontend, backend and QA roles when the task benefits.
4. **Use the same engine everywhere.** Expose workflows through desktop and CLI, with the same task history, provider handoff, skills, approvals and budgets.

Specialist roles can include frontend, backend, database, design and QA, but a role is not another model subscription. Instantiate only the roles needed, agree on shared contracts before parallel work, and verify the combined result. Teams must demonstrate a quality or elapsed-time benefit worth their additional usage; more agents do not inherently save tokens.

Codeshi cannot change subscription allowances or reset rules. Keep five-hour, weekly and model-specific windows distinct, label missing usage data, and count coordination overhead. Detailed scopes, dependencies, acceptance criteria, CLI examples and proposed updates to existing issues are in the [core execution plan](core-roadmap.md).

## Normal and Flow: the agreed execution split

This is the direction for future implementation, not a description of released mode enforcement. **Normal** keeps explicit control over agents, models, effort, tasks and next actions. **Flow** lets the person describe an outcome and delegates execution decisions to Codeshi within an authorized scope and budget. Flow is an execution contract as well as a distinct interface.

Flow-exclusive behavior means discretionary routing, handoff, recovery and future task assignment. A queue the person wrote, an exact selected build/review sequence, native agent planning and context protection remain available in Normal. These are working styles, not levels of user expertise.

| Feature | Normal | Flow |
| --- | --- | --- |
| Agent, model and effort | Explicit selection; optional recommendations require acceptance | Automatic routing under Smart, Saver or Ultra ([#128](https://github.com/AhmedNavaz/codeshi/issues/128), shipped in 0.33.0); one-step or pinned overrides |
| Near-limit handoff | Chat offer naming destination, settings, billing and allowance; accept or decline | Automatic policy-aware handoff within task authorization |
| Quota failure and reset waits | Manual destination/local choice, or explicitly wait for a selected agent | Choose a suitable allowed alternative; otherwise wait or report the blocker |
| Queued prompts | Exact user prompts and settings, with edit/reorder/cancel | Same user queue plus clearly identified managed work; do not silently rewrite user prompts |
| Tasks and concurrency | Manually create, assign and run independent tasks | Decide whether bounded splitting, assignment and parallel execution are worthwhile |
| Native agent plan and tools | Retain the native agent's own planning and tool loop | Present progress toward the outcome; Codeshi manages cross-agent execution |
| Tests and retries | Run checks directly or attach an exact check sequence; approve new repair decisions | Run agreed checks and choose bounded repair/escalation |
| Testing cadence | Choose As needed or Review first; explicit test/finalization requests still verify | Same cadence preference; managed recovery must respect it without skipping explicitly selected workflow checks |
| Reviews | Choose scope/reviewer/findings; retain explicit one-prompt build-then-review | Select a suitable independent reviewer and manage authorized finite repair cycles |
| Local models | Explicit choice or manual continuation | Eligible fallback only after capability/hardware checks; never assume all local models fit |
| Preview and point-and-tell | Full preview and element selection | Central feedback loop: inspect, point, describe and continue |
| Files and attachments | Full browser and exact attachment controls | Simple attach/browse actions with detail available |
| Git, diffs and publishing | Full repository controls | Plain-language change review; publishing remains user-controlled |
| Undo, redo and Timeline | Full recovery controls | Equally accessible previewed recovery; no hidden way back |
| Terminal and Run windows | Full tools | Omitted from Flow UI; authorized agent commands still work |
| Voice | Dictation and read-aloud | Dictation plus the future continuous hands-free conversation loop (#72) |
| Remote access | Control manual work from the phone | Observe, steer, answer requests and stop managed work under the same backend policy |
| Split requests (#108) | Manual split/assignment; accept an agent's draft proposal; review and merge each task yourself | Create/assign bounded subtasks within an authorized outcome; merge when safe, review the combined result, answer once, and hand anything unsettled to the Plan |
| Specialist teams (#89) | Individual role/task/review building blocks remain usable; seed plans manually or from uploaded project documents | Managed contracts, role assignment, dependencies, integration and verification |
| Visual Plans (#97) | Create/edit/connect cards or upload a project plan/PRD to draft an end-to-end plan; inspect, assign, verify and run an exact graph | Draft an outcome plan from goals or uploaded project documents, assign specialist team roles, and manage execution within authorization |
| Task boards and schedules ([board/schedule execution #132](https://github.com/AhmedNavaz/codeshi/issues/132)) | Fixed prompts/workflows, explicit settings and selected cards/graphs | Authorized outcomes or bounded backlog sets with automatic assignment |
| Race mode (#16) | Explicit two-attempt comparison and result selection | Optional managed comparison; never implied by Ultra |
| GitHub/CI context (#18) | Select context and actions explicitly | Gather relevant context within authorized repository scope; external text remains untrusted |
| Contextual suggestions (#106) | Explain and offer a change for acceptance | Explain decisions and propose meaningful policy changes; suggestions grant no authority |
| Multiplayer (#24) | Shared manual collaboration. Read-only watching with suggestions shipped in 0.43.0. The host can let each watcher send messages, held for the host or straight to the queue, always run on the host's account with Ask for permission and named in the transcript (0.53.0) | Shared observation/steering with explicit authority and no conflicting controllers |
| CLI (#90) | Explicit agents and exact workflows. The interactive session and script commands shipped in 0.43.0 on macOS and in 0.48.0 on Windows ([docs/cli.md](cli.md)) | Same backend Flow policy; no second orchestration engine |

Both modes retain context selection and native-compaction visibility, the canonical shared history and briefs, reviewed memory, portable skills, usage readings and task accounting, budgets and concurrency protection, recovery, read/edit access and tool approvals (including optional full auto-approval), import/export, conversation search, Ask a Friend, recaps, notifications and menu-bar status, keep-awake, themes, setup, updates, accessibility, translations and platform/adapter support. Phone notifications/Home Screen support, binary patches and collaboration improvements are also shared. Flow may change their presentation, not remove their protections or grant extra access. Durable memory changes remain reviewed.

### One selection policy across a task

Initial assignment, near-limit handoff, quota-error fallback, reset resumption, retry, reviewer selection and future subtasks use the same policy in [#12](https://github.com/AhmedNavaz/codeshi/issues/12). Required tools, inputs, context and verified capability come before allowance. Refresh the selected model's applicable five-hour, weekly and model-specific limits, consider concurrent usage and context-transfer overhead, value what each window has left by how long it must last so the allowance that resets soonest is spent first ([#128](https://github.com/AhmedNavaz/codeshi/issues/128)), and retain a visible reason and override. More unused allowance cannot make an incompatible model suitable.

- **Saver:** sufficient capability and the least allowance across every connected plan, rated by local rules with no agent call, with restrained switches, retries and reviewers.
- **Smart:** match capability and effort to the remaining work, from the lightest model to the strongest, and escalate when verification justifies it.
- **Ultra:** the strongest suitable reasoning and targeted independent checks, within the same limits; no implied full team or race attempts.

The shipped handoff selector does not yet apply the full routing policy to destination model and effort. Model-name tiers remain heuristics. Unknown/stale quota or billing cannot authorize automatic work; local/free fallback needs verified capability and adapter/hardware support. With no suitable destination, wait or offer a manual choice.

### Task authority, takeover and migration

**First release boundary:** keep the existing routing/handoff behavior and present it honestly as a focused view. Before entering or leaving, check that the selected workspace has no running task, review, test, reset continuation or unpaused queue; do not create a task or queue a delayed view change implicitly. Keep task navigation and Stop available; backend-managed Flow exclusivity and takeover remain future work.

Backend enforcement shipped in 0.34.1 ([backend task policy #131](https://github.com/AhmedNavaz/codeshi/issues/131)). Store execution policy per task in the shared journal, separate from layout, read/edit access, tool approvals and API consent. Desktop, phone and the future CLI control the same task authority; different tasks may use different policies. Inspecting another view does not change authorization.

**Take manual control** revokes future discretionary starts at a safe boundary and preserves work; **Stop** is immediate and separate. Saved queues, waits, child work and restart recovery must honor current policy and deduplicate starts. Preview migration from today's routing/handoff preferences and preserve recoverable in-flight work without silently broadening authority. Flow never grants permission to publish, push, deploy or release.

### Flow delivery stages

**Testing cadence, both views:** shipped in 0.29.2; Flow adds a direct switch in 0.30.0. Review first sends lightweight-iteration/final-verification guidance on every new turn, including resumed sessions and task lanes. Routine Codeshi test/retry loops record a deferral, while explicit repair/build-review workflows retain checks. The agent interprets explicit test/commit/push/release requests; a keyword alone never schedules or authorizes publication. This is agent guidance, not command enforcement or a cache of verified results. Future evidence-based reuse should bind a result to the command, relevant files, configuration, dependencies and environment; deferred checks must never count as passed. Measure repeated verification overhead under #84.

1. **One managed task:** backend mode policy and safe takeover ([backend task policy #131](https://github.com/AhmedNavaz/codeshi/issues/131)), unified selection/handoff (#12, extending #17/#32/#91), visible decisions, checks and bounded recovery (#15), with measurements (#84) and controlled context (#85).
2. **Managed task splitting:** build on manual task isolation (#88), bounded fan-out (#108), shared Plan cards (#97), board/schedule execution ([board/schedule execution #132](https://github.com/AhmedNavaz/codeshi/issues/132)) and one parent budget (#87). *Shipped in 0.53.0:* Flow finishes a split message by itself. Its parts stay off the Plan and Tasks, each finished part is merged when it finished, its tests didn't fail and none of its files changed in the folder meanwhile, a review of the combined result runs on another agent when one is available with one repair round, and the chat gets one answer. A part that didn't finish, failed tests, a conflict, Stop or a restart hands the parts to the Plan as an ordinary group, keeping what was merged. Still open: a live run with real agents and a measured comparison with one agent working in order.
3. **Specialist teams and hands-free work:** managed contracts and integration (#89), then the continuous voice loop (#72), with verified lifecycle, context retention and measurable overhead.

Existing manual capabilities and exact user-configured sequences remain available throughout. These are implementation stages, not release promises.

The tracking umbrella is [#107](https://github.com/AhmedNavaz/codeshi/issues/107); [implementation boundaries and issue ownership](core-roadmap.md#normal-and-flow-execution-contract) are in the core roadmap. Manual features, shared protections and explicit workflows are not removed to create the distinction.

## Adaptive agent and model routing

Extend [smart model and effort selection (#12)](https://github.com/AhmedNavaz/codeshi/issues/12) into Flow’s common execution policy. Automatic selection belongs to Flow; Normal keeps explicit settings and recommendations accepted by the person. Historical shipped behavior below predates this planned mode boundary. For each prompt, Codeshi should choose an eligible agent, model and reasoning effort using the task, project context, required tools, available allowance and the user's budget. Larger requests may be split into subtasks when doing so improves the result enough to justify the extra usage and coordination.

The modes shipped as Cost saving, Balanced and Maximum quality, and were replaced in 0.33.0 ([#128](https://github.com/AhmedNavaz/codeshi/issues/128)) by the following:

| Mode | Planned behavior |
| --- | --- |
| **Smart** (default) | Rate the request with the short agent assessment, then use the whole ladder: the lightest model at low effort for small edits and questions, the strongest at its highest effort for hard work, at the lowest allowance that fits. Escalate when verification shows the first approach is insufficient. |
| **Saver** | Spend the least allowance across every connected plan, rated by local rules with no agent call. Lighter models at low effort, limited extra runs, and a local model for light work once its capability is verified. |
| **Ultra** | The strongest suitable model at high effort, with Check with tests and an independent review where a second agent is connected, while respecting the user's limits. It steps down only when no strong model has usable allowance, and says so. |

In every mode, allowance is valued by how long it has to last: a window that resets within the hour is nearly free to spend, a weekly window with days to go is kept for work that needs it, and a handoff goes to the plan that can best afford the rest of the task. Unknown or stale readings still start nothing automatic.

The mode should guide the whole run, including retries, reviews, subtask assignments and quota fallback. Every mode must respect these boundaries:

- Keep spending limits separate from quality preferences. Support a **No extra spending** setting; separately billed API use requires explicit opt-in and an enforceable budget. Unknown billing or unavailable quota data must stay visible and must not be treated as free capacity.
- Choose only from providers and models the user has connected and allowed. Free services still have limits; local options depend on the user's hardware. Additional providers come through [#4](https://github.com/AhmedNavaz/codeshi/issues/4).
- Show the selected agent, model and effort with a short routing explanation, retain attribution for delegated work, and allow a manual override.
- Keep routing overhead small: a short assessment on the smallest available model with no tools, plugins or skills, no agent call for a bare go-ahead, and bounded planning for complex work. Extra planning, reviews and retries count toward the same usage and spending limits.
- Preserve access modes and tool approvals across agents. Routing and quality modes do not grant additional permissions.
- On a verified usage limit, preserve edits and pass a bounded task brief, decisions and unfinished work to an eligible fallback through [#17](https://github.com/AhmedNavaz/codeshi/issues/17). If none is available within the user's rules, queue until a reset through [#32](https://github.com/AhmedNavaz/codeshi/issues/32).

**Trust in routing and handoff is the next requirement.** The shipped local rules and model-name tiers are a starting point. A model's name or unused allowance alone does not establish that it can finish a task. Before extending automatic selection, make these requirements verifiable under #12 and #17:

- **Check suitability before capacity.** Maintain model capabilities with their source and last verification date: supported tools, image inputs, context limits, reasoning controls and skill compatibility, as exposed through Codeshi's adapter. Use provider metadata and representative task evaluations for strengths and limitations; distinguish reported capabilities from observed results. Unknown or newly listed models must not inherit an assumed capability from their name. *Shipped in 0.50.0:* images only. A message with images goes only to a model that takes them over a connection that can send them, from Codex's own model list and the rated list for Claude and Gemini; context size and tools are not checked yet, because no agent reports a context size before a run.
- **Use the allowance that actually applies.** Consider remaining five-hour, weekly and model-specific windows, reset times, observation age and other active tasks sharing the account. Refresh before dispatch and handoff, and recheck the destination model. Missing or stale data stays unknown; a percentage is not a promise of a particular number of prompts or tokens.
- **Choose a model likely to finish the remaining work.** Match task difficulty, current progress, required tools and context to a suitable model, then consider available allowance, continuity and budget. Label usage forecasts as estimates. Include context transfer, retries and reviews in the decision; do not downgrade to an unsuitable model just because it has more allowance.
- **Make handoffs worth their cost.** Use the same selection policy for an initial assignment and its fallback. Prefer a safe stopping point when available, preserve the prompt, edits and unfinished plan, and avoid repeated switches or restarting completed work. If no suitable destination is available, offer waiting or a manual choice without silently spending on another service.
- **Explain before acting.** Show why this model fits, which usage windows constrain it, how fresh those readings are, and the main tradeoff against staying or choosing an alternative. Keep a one-click override and a recorded decision timeline. Normal mode and [Flow mode (#107)](https://github.com/AhmedNavaz/codeshi/issues/107) must read the same decision record, with details available behind plain-language summaries.
- **Prove the policy against manual use.** Extend [#84](https://github.com/AhmedNavaz/codeshi/issues/84) evaluations with misleading model names, unsupported tools, unknown capabilities, stale quota, weekly exhaustion, shared-account activity and mid-task handoffs. Compare equivalent tasks against a manually selected agent for correctness, total usage including transfer, retries, repeated work and user interventions. Define and meet acceptance thresholds before expanding automatic selection; do not claim guaranteed savings or zero wasted tokens.

Deliver in stages:

1. **Route whole requests.** Supported agents and models, the three modes, explicit budget controls, visible decisions and manual overrides. Shipped in 0.14.0 as **Routing**, with local rules for classifying requests, subscription-only billing unless API billing is allowed, and the choice shown before sending. Since [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1), a short read-only agent assessment on Send rates each request, because rules alone misjudged too many real prompts. Its usage counts toward the task budget, a bare go-ahead makes no agent call, and the choice shows with the sent message.
2. **Verify and recover.** Add bounded escalation based on task checks, quota handoff and reset queuing; validate at least one supported free or local integration before promising that fallback. Quota handoff ([#17](https://github.com/AhmedNavaz/codeshi/issues/17)) and reset queuing ([#32](https://github.com/AhmedNavaz/codeshi/issues/32)) shipped in 0.14.0. **Check with tests**, shipped in [0.18.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.18.0), runs the workspace's Test command after a routed run that changes files and, when the tests fail, retries once with the same agent one step up in model or effort, on its own in Balanced and Maximum quality and after asking in Cost saving. The run history records each routed run's tier, check and retry, which the panel summarises; a free or local fallback is still to come.
3. **Coordinate subtasks.** Assign work across agents with shared project context, explicit ownership of edits, bounded review cycles and one consolidated result. Parallel execution must avoid conflicting workspace changes. The [concurrent task proposal](core-roadmap.md#concurrent-folder-tasks) supplies isolation and recovery; [specialist workflows](core-roadmap.md#specialist-team-workflows) add contracts, dependencies and verification under one shared task budget.

Evaluate routing with representative coding tasks, tracking completion quality, allowance consumed, API charges where applicable, elapsed time and retry count. Compare against a manually chosen single agent before claiming savings or quality improvements.

## Everything in the thread

Bring the work around the code into the project conversation, so an agent sees what you see on GitHub, and finish the loop with a pull request. Collaborators with access to the repository work this way rather than through Ask a Friend.

1. **GitHub as context.** Paste or pick an issue, a pull request or the current branch, and Codeshi reads it through your own `gh` login: the issue or pull request with its comments and review threads, and the failing checks with the end of each failing job's log. It never asks for a token of its own and only reads. What comes in is shown for review before it is sent, as part of your message, with secrets and local paths removed by the same step that cleans exports. Nothing is fetched in the background.
2. **Logs from the app.** A failed command in **Run** puts its command and the end of its output in the message box in one click, since [0.19.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.19.0); selected terminal output follows in [#71](https://github.com/AhmedNavaz/codeshi/issues/71).
3. **A pull request from the conversation.** *Shipped in 0.46.0, and tried against GitHub itself on a throwaway repository: a new branch as a draft, a branch that already had a pull request, and starting from the base branch. All three stages are done, and #18 is closed.* After you review the diff and commit in the Git panel, **Open pull request** pushes the branch and opens the pull request with `gh`, with a title and description drafted from the conversation for you to edit. It is the one place Codeshi pushes, only when you click it and after showing the remote and branch; agents never push.

## Onboarding and execution mode selection

**Status:** shipped. The new setup arrived in 0.39.0, and its keyboard and screen-reader pass in 0.44.0. The scope below is kept for reference.

Redesign the first-run onboarding experience ([#129](https://github.com/AhmedNavaz/codeshi/issues/129)) so users start directly with their project codebase and make an informed choice between Codeshi's two execution styles:
1. **Workspace and folder setup first.** Rather than confronting new users with accounts, API credentials, or permissions before they have loaded a project, onboarding prompts the user to create or name their workspace and select project folder(s) upfront.
2. **Normal vs Flow mode selection with clear comparison.** Present a visually engaging side-by-side card comparing the two core operating styles:
   - **Normal Mode (Full Control):** Complete manual orchestration. Select exact agents, models, and reasoning effort; build and inspect queued prompts; full access to terminal, git panel, side panels, and tool logs.
   - **Flow Mode (Outcome-Driven):** Minimal cognitive overhead. Describe the outcome and let Codeshi autonomously route (Smart, Saver, Ultra), perform quota handoffs, and manage verification, surrounded by floating plain-language status cards.
   - Transparently list key differences and benefits so beginners and power users immediately understand which mode fits their workflow.
3. **Persistent preference and easy toggling.** The chosen style sets the workspace's default layout, while clearly explaining that users can switch between Normal and Flow at any point with one click in the status bar or Settings.

## Interface polish, typography scale and settings structure

**Status:** shipped. Themes, the text scale, workspace rows and Settings pages arrived in 0.39.0; badge contrast in every theme and one layout for every dialog in 0.44.0. The scope below is kept for reference.

Enhance legibility, visual hierarchy, and navigation across the desktop interface ([#127](https://github.com/AhmedNavaz/codeshi/issues/127), [#130](https://github.com/AhmedNavaz/codeshi/issues/130)):
1. **Typography scale upgrade.** Increase micro-font sizes across cramped UI areas: sidebar workspace items, task metrics, status bar controls, and secondary chips (scaling up from 10–11px to readable 12.5–14px).
2. **Non-clipping workspace indicators.** Resolve horizontal crowding in compact sidebars (220–250px) where titles, running status dots, folder counts, and action buttons collide. Implement flexible two-line layouts or adaptive badge indicators that prevent truncation.
3. **Categorized settings navigation.** Break up the overloaded General tab into specialized sections (General, Appearance & Typography, AI Agents & Accounts, Routing & Budgets, Testing & Verification, Phone & Remote Access, Voice, Alerts, and Updates & Diagnostics).
4. **App-wide UI/UX consistency.** Standardize button sizes, dialog headers, padding, and theme contrast tokens across all panels and dialogs.

## One Plan

Orchestrate's Plan view and the task board become one view, called **Plan**, for each workspace, tracked in [#162](https://github.com/AhmedNavaz/codeshi/issues/162). Today they keep separate cards, buttons, saved data and runners, so a plan's steps can't be edited on the board, a card you write can't get an agent's help, and test gates and briefs only work for plans.

- **One kind of card** with every field a board card and a plan step have today: description, priority, labels, due date, checklist, comments, dependencies, group, role, expected result, check command, files and agent (chosen by you, or Auto).
- **Columns, Canvas and Outline** show the same cards, and one **Plan** button in the top bar replaces Plan and Board. Groups (phases) show as labelled areas on the Canvas and headings in the Outline.
- **Agents draft, you decide.** **Draft cards** in the Plan view's message box (it replaced Orchestrate), **Plan from a document** (#155: major cards in phases, split into subtasks when each starts) and **Suggest next** on a card each add draft cards that you edit, accept or discard. **Add next** makes an empty linked card. Each agent request is one read-only run, shown with its agent and usage before it starts, and nothing is suggested on its own.
- **No fixed number of cards or subtasks.** A plan gets as many major cards as the project needs, and a major card as many subtasks as its work needs, from you or an agent, bounded by the task's budget (#87), Stop and the card's check. The Plan's overall size (300 cards today) is the only ceiling.
- **One planning method.** Every agent-drafted plan follows the same written method from common software engineering practice: read the project first and extend its architecture, size the plan to the work, contracts before the cards that use them, working slices, unknowns early, one outcome per card with a check, explicit dependencies, and questions instead of guesses. Codeshi checks each draft locally, with no model call, for circular waits, missing done criteria, contract order and cards too large for one run.
- **One way to run.** Run, Run Ready… and running a group test each card before the cards that wait for it, and brief each card from what earlier cards did.
- **Watching the Plan run.** The Plan is where you follow a run, in Normal or Flow, without switching to Flow. Each running card shows its live agent, model, effort, current activity, subtasks, time and usage; arrows show cards working side by side, waits, handoffs, retries and test gates; and the plan shows its overall progress and total. Selecting a card opens its task, approvals, questions, Stop and a message box beside the Plan. Motion respects reduced motion and stops redrawing when nothing changes. The chat stays as it is.

Stages: one card and one Plan button; one runner; plans from documents; Suggest next; watching the Plan run. *Shipped in 0.49.0:* the first four. A plan from attached documents drafts major cards in phases, and a major card is split into subtasks by a short read-only run when it starts; the subtasks run one after another in the card's task, each routed at its size on Auto in Flow, can be edited, removed, added to, pinned to an agent or paused, and the card's check runs after the last one (#155). The planner's own check that a large document gives a plan of fitting size still needs a live run. Cards have the plan fields, Auto, groups and the Outline, **Draft cards** in the Plan view drafts cards with the planning method and the plan checks, and every card is tested before the cards after it and briefed from what they did. A running or stopped plan from before keeps its own view. The boundaries of #97 and #132 still apply: no silent Auto in Normal, drafts until accepted, your edits win, and saved plans and cards open without loss. **Suggest next** confirms the agent, model, effort and usage before running one dedicated read-only run against the target card, its result, its open neighbors and open Plan (never closed cards) to propose 1 to 3 linked draft cards checked against the card and its open ancestors, **Add next** starts an empty linked card with no model call, and accepting or discarding drafts can be undone and redone across Columns, Canvas and Outline until an accepted card runs. *Shipped in 0.50.0:* watching the Plan run: a working card names the agent, model and effort its run is on, what it is doing, its subtask, time and usage; the cards working now are marked, arrows into them are solid or dashed and a finished card's test gate is labelled on its arrow, and choosing a running card opens its task beside the Plan. *Shipped in 0.53.0:* a Plan's results are read on the Plan. An open card in Review or Done shows its agent's whole answer with **Ask a follow-up**, Flow's task list shows a Plan as one row with its counts, and the workspace chat says once when a run's cards have finished. A card whose copy changed no files has nothing to merge, and discarding a card's changes keeps it in Review instead of sending it back to Ready. Still open: Auto parity checks between Normal and Flow and live runs with real agents (drafting from a small message and a large document, Suggest next, and several agents at once).

## Task board and schedules

A board for each project to capture work as it comes up and run it under an explicit Normal or Flow policy, tracked in [board/schedule execution #132](https://github.com/AhmedNavaz/codeshi/issues/132). #97 owns the shared card/canvas/board views; this issue owns execution and schedules, reusing #88 tasks.

1. **The board and running tasks.** *Shipped in 0.43.0 and 0.45.1:* the columns, cards with a description, priority, checklist, dependencies and an explicit agent, **Run** and **Run Ready…** for exactly the chosen cards, Review with the agent's summary, files and test result, and accepting by hand; and in 0.45.1, the Canvas view with dragging, arrows, undo and a Mermaid Markdown export (#97). Shipped in 0.49.0: labels with a filter, due dates, and your comments on cards (#97). Still to do in this stage: dictating cards, and the saved context's unfinished tasks as cards. Columns for Backlog, Ready, Doing, Review and Done. A card has a title, a description, a priority, labels, a checklist of what done means, and the execution policy: explicit assignments in Normal, or authorized automatic assignment in Flow. No new Normal card defaults to Auto. Running a card sends it to the agent and moves it to Doing; when the run ends, the card keeps the files it changed, the result of **Check with tests** and a short summary. **Run the Ready column** executes the exact selected graph in Normal, or an explicitly authorized bounded selection with Flow assignments. Dependencies, workspace concurrency and shared budgets apply in both. Cards can be dictated with voice input, and the saved context's unfinished tasks become the board's open cards, so agents know the backlog.
2. **Schedules.** *Shipped in 0.49.0:* fixed Normal schedules for a card or a prompt, once or daily, on weekdays or weekly, with the agent, the access and the card's revision saved with the schedule, missed runs that wait for you unless running late is allowed, Codeshi staying in the menu bar while a schedule waits, and Open at login; and, also built, a usage check before each scheduled run, which waits for the same agent's reset instead of starting a run that would stop at once, and a scheduled run's approvals and reset waits named in the menu bar. Still to do: Flow schedules of an outcome or backlog scope. Run a card or a prompt once at a set time, or repeat it daily, on weekdays or weekly. Normal binds fixed agents/settings and an exact workflow; Flow binds an outcome/backlog scope and permitted automation. Store the policy and material card revisions with the schedule; deduplicate starts and stop future automatic dispatch after takeover. Codeshi can keep running in the menu bar after its window closes, and open at login. Schedules run while the Mac is awake; a missed run shows in the "While you were away" recap and waits for you, unless you let it run late.
3. **Later.** Turn pasted meeting notes into cards with an agent, checked by you before any is added; sync cards with GitHub Issues through the access from [#18](https://github.com/AhmedNavaz/codeshi/issues/18); and run cards in parallel in separate worktrees with [#16](https://github.com/AhmedNavaz/codeshi/issues/16).

Design boundaries:

- An agent never marks its own work done. A finished card waits in Review with its diff and test result until you accept it; a failed one goes back to Ready with the reason.
- A scheduled run uses the access chosen when it was scheduled. Anything that needs approval waits and shows in the menu bar; nothing is approved for it unless the project already allows it, and nothing is pushed.
- Usage limits, routing and billing rules apply as they do to any run, and a schedule never wakes a sleeping Mac.
- Cards are kept with the project in Codeshi's own data, not in the repository, and work offline.

## Designer module

Point and tell ([#19](https://github.com/AhmedNavaz/codeshi/issues/19)) changes one element at a time. The Designer module is for working on a whole page or screen and telling agents what each part should do, tracked in [#125](https://github.com/AhmedNavaz/codeshi/issues/125).

1. **Design notes in the preview.** *Shipped in 0.43.0:* **Design** in the preview's toolbar marks several parts of the running page, by clicking an element or dragging a box around an area. Each part gets a numbered box and a note. They go into the message box as one numbered list with each part's code location, a screenshot with the same numbers, and screenshots of parts out of view. The boxes are found again by their selectors after a scroll or a reload. Since then, parts can be marked with the arrow keys and Enter, and unsent notes come back when the interface's preview window opens again, while Codeshi is open.
2. **A layout canvas.** For pages that don't exist yet: sketch a screen from boxes (header, hero, cards, form), each with a note, and send it as a plan for the agent to build. It shares its numbering and message format with design notes.
3. **Handing design work over.** A designer's step in team workflows ([#89](https://github.com/AhmedNavaz/codeshi/issues/89)) that produces these notes for frontend agents, and design notes kept as cards in Plans ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)) or on the board ([#132](https://github.com/AhmedNavaz/codeshi/issues/132)).

Design boundaries:

- Notes go into the message box for you to read; nothing is sent to an agent on its own.
- The page never sees the notes or the boxes, and gets no access to Codeshi.
- Models suited to design work, such as Astra and Fable, stay a manual choice in Normal. Flow's routing doesn't pick them.

## Connect GitHub and move to another computer

Two separate pieces, both without a Codeshi account or server. Codeshi stores nothing new in either.

- **[#159, Connect GitHub](https://github.com/AhmedNavaz/codeshi/issues/159):** list your repositories and clone one as a workspace. *The `gh` version shipped in 0.47.0 as **From GitHub** in New workspace, and GitHub Enterprise hosts `gh` is signed in to in 0.52.0.* It uses your `gh` login when present; otherwise **Sign in with GitHub** asks for read-only access and keeps the token in the system keychain.
- **[#160, Move to another computer](https://github.com/AhmedNavaz/codeshi/issues/160):** pair two computers, review what will move, then pick each workspace's local folder, or clone it through #159. An encrypted backup file covers offline moves; *it shipped in 0.47.0 as **Export** and **Import Codeshi Backup…**. Moving directly over the same network shipped in 0.52.0: the old computer shows a move code, the new one types it, both show the same six digits, and nothing is sent until you choose **Allow**.* Agent logins and keychain items never move, and nothing on the old computer is deleted. Moving between networks through the relay is left out, because a data folder can be far larger than its packet limits. Ongoing sync between computers would build on the same pairing and encryption, and has no issue yet.

## Public help requests

Ask a Friend sends a reviewed request to one person you choose, by file or private link. Public help requests would let you post the same kind of request where anyone can pick it up and send back a fix, without access to your repository.

What carries over from Ask a Friend:

1. **Only what you approve is shared.** You choose the messages and files, secrets and local paths are removed, and you see the exact package before it goes out. The rest of the project stays on your computer.
2. **The agent's history goes with it.** The helper sees the problem, what was tried and the decisions made, so their own agent can continue where yours stopped instead of starting over.
3. **Changes come back as a patch you review.** A returned patch can only touch the paths you approved. You review each change, including binary files ([#25](https://github.com/AhmedNavaz/codeshi/issues/25)), before applying it, and recovery can take it back. Nothing a helper sends runs on its own.

Open questions before building:

- **Where requests are listed:** a hosted board, or a GitHub issue with the request attached.
- **Privacy:** a public request is public for good, so it would start with context only, block on any secret warning, and say plainly who can read it.
- **Trust:** patches from strangers need closer review than patches from a friend: programs flagged, no unapproved paths, and your own tests run on a patch only with your approval ([#10](https://github.com/AhmedNavaz/codeshi/issues/10)), with the files that decide what they run named first.
- **Abuse:** spam requests and spam answers, and how to report and remove them.
- **Hosting:** links need a sharing service, and none is hosted yet.
- **Helpers:** what a helper gets in return, such as credit on the request.

## Flow feedback follow-ups

The November 2026 reports are tracked without reopening shipped milestones:

| Report | Tracking and next step |
| --- | --- |
| Smart rejects stale plan usage on first Send, then succeeds on retry | [#134](https://github.com/AhmedNavaz/codeshi/issues/134), shipped in 0.35.0: bounded fresh probes, progressive rechecks, probing phase indicator and deterministic timing tests; stale/unknown readings still cannot authorize work. |
| Smart selects an agent above its handoff threshold and immediately transfers it | [#135](https://github.com/AhmedNavaz/codeshi/issues/135), shipped in 0.35.0: adaptive quota thresholds evaluating window duration, reset cadence, and workload size; autonomous handoff execution in Flow mode without manual suggestion cards. |
| Codex stops with an unterminated JSON-RPC string | [#133](https://github.com/AhmedNavaz/codeshi/issues/133), shipped in 0.34.1: reproduced Unicode separators splitting valid JSON in the desktop runtime; LF-delimited streaming framing fix and adapter regressions. |
| Separate-task actions clip; Flow cards are redundant or hide usage windows | [#136](https://github.com/AhmedNavaz/codeshi/issues/136), shipped in 0.35.0: unclipped task titles, running task badge/pulse, expandable all-limits glance view and clean status copy. |
| Flow does not clearly mark which agent is working | [#136](https://github.com/AhmedNavaz/codeshi/issues/136), shipped in 0.35.0: prominent executing agent highlight in plans and status cards. |
| Long shared chats repeatedly reach native refresh limits | [#85](https://github.com/AhmedNavaz/codeshi/issues/85): bounded rolling task briefs with source retention and separate envelope/native-context/cumulative-usage measurements. Preserve the original journal and #123's shipped refresh behavior. Seed size, turn count and quick-refresh explanations shipped in 0.36.0. Shipped in 0.38.0: a long conversation's older part is folded into the brief with its sources instead of being cut off, resent requests are sent once and a refresh no longer repeats requests already in context. In 0.45.1, waiting approvals and questions are kept across a handoff, context refresh and restart. Growth inside one turn is the agent's own and stays open. Shipped in 0.49.0: `long-chat` and `long-chat-short` evaluation fixtures and `--context task-unfolded` baseline; `long-chat-short` tracks a known gap where the rolling brief keeps fewer short older requests. |
| Task budget stops on repeated read-only diagnostic probes and blocks retries | [#137](https://github.com/AhmedNavaz/codeshi/issues/137), shipped in 0.35.0: distinguish non-mutating network/status checks from mutating failure loops; allow explicit user retry/reset and UI action on stopped tasks. |
| Release packaging fails during GitHub asset CDN timeouts | [#138](https://github.com/AhmedNavaz/codeshi/issues/138), shipped in 0.34.1: packaging verifies Electron against the checksums the electron package ships, retries GitHub with growing pauses and falls back to a mirror. |
| Prompt queue clips paused banner and pushes Resume action offscreen on long error messages | [#140](https://github.com/AhmedNavaz/codeshi/issues/140), shipped in 0.36.0: keep queue controls (`flex-shrink: 0`) and row actions visible, clamp transcript footer width to content boundaries, and truncate or wrap long pause reasons and routing metadata cleanly. |
| Project review: in-use ports and prerequisite validation failures block launch | [#141](https://github.com/AhmedNavaz/codeshi/issues/141), shipped in 0.37.0: sanitize prerequisite strings to prevent launch map preparation errors, and handle in-use ports with graceful attach or alternate port assignment. |
| High battery drain and sustained desktop resource use | [#152](https://github.com/AhmedNavaz/codeshi/issues/152): profile main/renderer/GPU/agent processes across idle, streaming, Lounge and preview workloads; establish energy and performance regression budgets. The Lounge shipped in 0.38.0 with a first mitigation: it stops idle game redraws and Clear-weather loops, suspends hidden-page Lounge animation and reuses snow layout measurements. Battery improvement remains unmeasured. Shipped in 0.49.0: status-line highlight moved to GPU transforms without per-frame repaints (saving not yet re-measured). |
| Project review: concurrent multi-UI access (website, admin dashboard) | [#142](https://github.com/AhmedNavaz/codeshi/issues/142), shipped in 0.38.0: each interface of a review opens in a preview window of its own, with its own address and history, and Stop review closes only that review's windows. |
| Desktop preview: vertical right-hand Development/Stack and API inspector | [#143](https://github.com/AhmedNavaz/codeshi/issues/143), shipped in 0.37.0: move Stack and API tabs to a vertical collapsible sidebar on the right side of the preview window. |
| Smart routing in Flow pauses on near-limit quota instead of falling back to eligible alternatives | [#144](https://github.com/AhmedNavaz/codeshi/issues/144), shipped in 0.37.0: re-route to next best eligible provider or model tier when candidate is near quota threshold before hard-pausing. Fixed in 0.38.0: in 0.37.0 the switch at launch failed with "Assignment to constant variable." whenever an alternative was found; it now works within the task budget and billing consent (#87). |
| Auto pauses near-limit allowance that is about to reset, and Proceed with remaining allowance paused the queue again | [#153](https://github.com/AhmedNavaz/codeshi/issues/153): shipped in 0.38.0. Auto spends allowance past the safety margin when its window resets soon (weekly within 6 hours, daily within 2, 5-hour within 30 minutes) and the agent's other windows have room; mid-window it still keeps the margin. These agents come after any with ordinary headroom, a model one tier down is tried before pausing, and the top effort level is not used. Proceed with remaining allowance now reaches routing, holds for the rest of the queue, and isn't offered again once no agent has allowance left. The run's reason and activity say which allowance is being spent. Handoffs still move work only to agents with ordinary headroom. |

These card changes explain and navigate recorded work; they do not make Flow assignments a manual responsibility. The detailed [follow-up scope](core-roadmap.md#flow-feedback-follow-ups) distinguishes the local protocol fix from planned work.

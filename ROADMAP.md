# Roadmap

What Codeshi already does, what is coming next and the bigger ideas being explored. **Now** is the current focus, **Next** is follow-up work, **Later** is further out, and **Exploring** holds larger ideas that need design before implementation. Dependencies are listed per item; blocked work does not hold up independent improvements. Priorities can change with feedback, so treat this as a plan rather than a promise.

A core goal is to get more work from existing agent allowances and available free or local options, so users can keep projects moving within their chosen budget without needing a higher subscription tier.

Planned items link to their GitHub issue. These are proposals until implemented and released. Comment on an existing issue to shape it or to pick it up, and open one before implementing new work. Release-by-release details are in the [changelog](CHANGELOG.md); bugs are tracked under the [bug label](https://github.com/AhmedNavaz/codeshi/labels/bug).

## Use it and tell us what breaks

The fastest way to make Codeshi better is to use it on your real projects and tell us what you find: bugs, confusing screens, slow spots and rough edges in the design. A small UI or UX note is as welcome as a crash report. [Report a bug](https://github.com/AhmedNavaz/codeshi/issues/new?template=bug_report.yml) or [share design feedback](https://github.com/AhmedNavaz/codeshi/issues/new?template=ux_feedback.yml).

## Core execution direction

The next core milestone is **more verified work from the allowance users already have**. Codeshi already has routing with a short task assessment, bounded context, native-session continuation, quota handoff, queued prompts and test-triggered escalation. These are useful foundations; they do not yet prove a reduction in tokens or an improvement over a single agent on equivalent tasks.

The proposed order is:

1. **Establish the baseline.** Measure completed-task correctness, total reported usage, retries, elapsed time and interventions. Fix lifecycle and approval failures before expanding unattended work.
2. **Reduce repeated work.** Select relevant code and history, retrieve reviewed project memory, load skills on demand and enforce one budget across a task's planning, implementation, reviews and retries.
3. **Coordinate independent work.** Run folder-scoped tasks concurrently with durable ownership, isolated changes and checked integration. Start with a builder and independent reviewer; add frontend, backend and QA roles when the task benefits.
4. **Use the same engine everywhere.** Expose workflows through desktop and CLI, with the same task history, provider handoff, skills, approvals and budgets.

Specialist roles can include frontend, backend, database, design and QA, but a role is not another model subscription. Instantiate only the roles needed, agree on shared contracts before parallel work, and verify the combined result. Teams must demonstrate a quality or elapsed-time benefit worth their additional usage; more agents do not inherently save tokens.

Codeshi cannot change subscription allowances or reset rules. Keep five-hour, weekly and model-specific windows distinct, label missing usage data, and count coordination overhead. Detailed scopes, dependencies, acceptance criteria, CLI examples and proposed updates to existing issues are in the [core execution plan](docs/core-roadmap.md).

## Normal and Flow: the agreed execution split

This is the direction for future implementation, not a description of released mode enforcement. **Normal** keeps explicit control over agents, models, effort, tasks and next actions. **Flow** lets the person describe an outcome and delegates execution decisions to Codeshi within an authorized scope and budget. Flow is an execution contract as well as a distinct interface.

Flow-exclusive behavior means discretionary routing, handoff, recovery and future task assignment. A queue the person wrote, an exact selected build/review sequence, native agent planning and context protection remain available in Normal. These are working styles, not levels of user expertise.

| Feature | Normal | Flow |
| --- | --- | --- |
| Agent, model and effort | Explicit selection; optional recommendations require acceptance | Automatic routing under Smart, Saver or Ultra ([#128](https://github.com/AhmedNavaz/codeshi/issues/128); shipped today as Cost saving, Balanced and Maximum quality); one-step or pinned overrides |
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
| Split requests (#108) | Manual split/assignment; accept an agent's draft proposal | Create/assign bounded subtasks within an authorized outcome |
| Specialist teams (#89) | Individual role/task/review building blocks remain usable | Managed contracts, role assignment, dependencies, integration and verification |
| Visual Plans (#97) | Create/edit/connect cards; explicitly assign and run an exact graph | Draft an outcome plan, assign work and manage execution within authorization |
| Task boards and schedules ([board/schedule issue draft](docs/flow-issue-plan.md#board-and-schedule-execution)) | Fixed prompts/workflows, explicit settings and selected cards/graphs | Authorized outcomes or bounded backlog sets with automatic assignment |
| Race mode (#16) | Explicit two-attempt comparison and result selection | Optional managed comparison; never implied by Maximum Quality |
| GitHub/CI context (#18) | Select context and actions explicitly | Gather relevant context within authorized repository scope; external text remains untrusted |
| Contextual suggestions (#106) | Explain and offer a change for acceptance | Explain decisions and propose meaningful policy changes; suggestions grant no authority |
| Multiplayer (#24) | Shared manual collaboration | Shared observation/steering with explicit authority and no conflicting controllers |
| Future CLI (#90) | Explicit agents and exact workflows | Same backend Flow policy; no second orchestration engine |

Both modes retain context selection and native-compaction visibility, the canonical shared history and briefs, reviewed memory, portable skills, usage readings and task accounting, budgets and concurrency protection, recovery, read/edit access and tool approvals (including optional full auto-approval), import/export, conversation search, Ask a Friend, recaps, notifications and menu-bar status, keep-awake, themes, setup, updates, accessibility, translations and platform/adapter support. Phone notifications/Home Screen support, binary patches and collaboration improvements are also shared. Flow may change their presentation, not remove their protections or grant extra access. Durable memory changes remain reviewed.

### One selection policy across a task

Initial assignment, near-limit handoff, quota-error fallback, reset resumption, retry, reviewer selection and future subtasks use the same policy in [#12](https://github.com/AhmedNavaz/codeshi/issues/12). Required tools, inputs, context and verified capability come before allowance. Refresh the selected model's applicable five-hour, weekly and model-specific limits, consider concurrent usage and context-transfer overhead, value what each window has left by how long it must last so the allowance that resets soonest is spent first ([#128](https://github.com/AhmedNavaz/codeshi/issues/128)), and retain a visible reason and override. More unused allowance cannot make an incompatible model suitable.

- **Saver** (today Cost saving): sufficient capability and the least allowance across every connected plan, rated by local rules with no agent call, with restrained switches, retries and reviewers.
- **Smart** (today Balanced): match capability and effort to the remaining work, from the lightest model to the strongest, and escalate when verification justifies it.
- **Ultra** (today Maximum quality): the strongest suitable reasoning and targeted independent checks, within the same limits; no implied full team or race attempts.

The shipped handoff selector does not yet apply the full routing policy to destination model and effort. Model-name tiers remain heuristics. Unknown/stale quota or billing cannot authorize automatic work; local/free fallback needs verified capability and adapter/hardware support. With no suitable destination, wait or offer a manual choice.

### Task authority, takeover and migration

**First release boundary:** keep the existing routing/handoff behavior and present it honestly as a focused view. Before entering or leaving, check that the selected workspace has no running task, review, test, reset continuation or unpaused queue; do not create a task or queue a delayed view change implicitly. Keep task navigation and Stop available; backend-managed Flow exclusivity and takeover remain future work.

Backend enforcement is [backend task policy draft](docs/flow-issue-plan.md#backend-task-policy). Store execution policy per task in the shared journal, separate from layout, read/edit access, tool approvals and API consent. Desktop, phone and the future CLI control the same task authority; different tasks may use different policies. Inspecting another view does not change authorization.

**Take manual control** revokes future discretionary starts at a safe boundary and preserves work; **Stop** is immediate and separate. Saved queues, waits, child work and restart recovery must honor current policy and deduplicate starts. Preview migration from today's routing/handoff preferences and preserve recoverable in-flight work without silently broadening authority. Flow never grants permission to publish, push, deploy or release.

### Flow delivery stages

**Testing cadence, both views:** shipped in 0.29.2; Flow adds a direct switch in 0.30.0. Review first sends lightweight-iteration/final-verification guidance on every new turn, including resumed sessions and task lanes. Routine Codeshi test/retry loops record a deferral, while explicit repair/build-review workflows retain checks. The agent interprets explicit test/commit/push/release requests; a keyword alone never schedules or authorizes publication. This is agent guidance, not command enforcement or a cache of verified results. Future evidence-based reuse should bind a result to the command, relevant files, configuration, dependencies and environment; deferred checks must never count as passed. Measure repeated verification overhead under #84.

1. **One managed task:** backend mode policy and safe takeover ([backend task policy draft](docs/flow-issue-plan.md#backend-task-policy)), unified selection/handoff (#12, extending #17/#32/#91), visible decisions, checks and bounded recovery (#15), with measurements (#84) and controlled context (#85).
2. **Managed task splitting:** build on manual task isolation (#88), bounded fan-out (#108), shared Plan cards (#97), board/schedule execution ([board/schedule issue draft](docs/flow-issue-plan.md#board-and-schedule-execution)) and one parent budget (#87).
3. **Specialist teams and hands-free work:** managed contracts and integration (#89), then the continuous voice loop (#72), with verified lifecycle, context retention and measurable overhead.

Existing manual capabilities and exact user-configured sequences remain available throughout. These are implementation stages, not release promises.

The tracking umbrella is [#107](https://github.com/AhmedNavaz/codeshi/issues/107); [implementation boundaries and issue ownership](docs/core-roadmap.md#normal-and-flow-execution-contract) are in the core roadmap. Manual features, shared protections and explicit workflows are not removed to create the distinction.

## Shipped

| Feature | Since |
| --- | --- |
| Workspaces with one or more folders and one permanent conversation | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Claude Code and Codex in the same conversation, switching mid-task with shared context | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Model, reasoning effort and access chosen per message, with approvals and a live run view | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Import Claude Code and Codex chats from any project, merged in time order | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Conversation export for other Codeshi users, with secrets and local paths removed | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Ask a Friend: share an approved snapshot and apply a reviewed patch | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Git activity with per-file diffs and recent commits | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| File browser with syntax-highlighted previews, and file and image attachments | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Plan usage for each agent, with reset times | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Keep awake while agents are working | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| Dark and light themes and keyboard shortcuts | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| macOS builds for Apple Silicon and Intel, and a container image for the private-link service | [0.4.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0) |
| One-line install from Terminal, checked against published checksums | [0.5.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.5.0) |
| First-run welcome and guided setup | [0.5.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.5.0) |
| Suggestions for earlier Claude Code and Codex chats that match a workspace's folders | [0.6.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.6.0) |
| Search the conversation with Cmd/Ctrl+F, highlights and next/previous matches | [0.7.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.7.0) |
| System appearance alongside explicit Light and Dark themes | [0.7.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.7.0) |
| Quiet background agent checks that preserve verified connection status | [0.7.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.7.0) |
| Native desktop menus for workspace, conversation, agent, appearance and Help controls | [0.8.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.8.0) |
| Cross-agent review of selected Git changes, with saved findings and explicit fix drafts | [0.9.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.9.0) |
| Gemini CLI (0.66.0+) in the shared project conversation, with ACP approvals, access controls and verified model selection | [0.10.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.10.0) |
| Continue locally with downloaded Ollama models, shared task context and Codex workspace tools | [0.10.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.10.0) |
| In-app release notes after updates, with saved workspaces opening directly | [0.10.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.10.0) |
| Contextual background reviews, grouped cloud/local model selection and prefilled Ask a Friend previews | [0.11.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.11.0) |
| Full auto-approval with an explicit workspace permission mode | [0.12.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.12.0) |
| Gemini conversation discovery, preview and import with an agent filter | [0.12.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.12.0) |
| Project command controls with Run, Test and Stop actions, package suggestions and live output | [0.13.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.13.0) |
| A clearer conversation: prompt bubbles, one-line live activity, pinned prompts and a quiet run status ([#45](https://github.com/AhmedNavaz/codeshi/issues/45)) | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Searchable model picker, and a reasoning effort slider that follows each model's levels | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Agent handoffs that keep the task's intent ahead of tool logs ([#69](https://github.com/AhmedNavaz/codeshi/issues/69)) | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Continue a stopped task with any agent and model, wait for a usage limit to reset and continue automatically, or queue prompts to run one after another ([#32](https://github.com/AhmedNavaz/codeshi/issues/32)) | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Ask before changes: read-only actions run without approval, and an exact action can be allowed for a run or remembered for a workspace, with rules you can review and revoke ([#68](https://github.com/AhmedNavaz/codeshi/issues/68)) | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Dock badge, alerts and a sidebar marker when a run finishes, stops or needs approval, with notifications that open the exact request and settings for alerts and sound ([#46](https://github.com/AhmedNavaz/codeshi/issues/46)) | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Hand off to another agent before a usage limit stops the run, with the destination, billing and task shown first ([#17](https://github.com/AhmedNavaz/codeshi/issues/17)) | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Add a note to the run that is working, and follow the agent's plan as a live to-do list | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Routing: the agent, model and effort picked for each message, shown with its reason before sending ([#12](https://github.com/AhmedNavaz/codeshi/issues/12), stage 1) | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| A new layout: a search bar for workspaces, files and actions, a side panel for Agents and Git, and resizable sections | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Reliable Gemini connection on networks where Google stalls over IPv6 | [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) |
| Update from inside the app with one click: downloaded, checked against its checksum and installed once no agent is working ([#2](https://github.com/AhmedNavaz/codeshi/issues/2)) | [0.15.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0) |
| Each run as a timeline of its steps, with one live status line | [0.15.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0) |
| Stage and commit from the Git panel, with your own identity and the project's commit hooks ([#6](https://github.com/AhmedNavaz/codeshi/issues/6)) | [0.15.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0) |
| A terminal for each workspace in a bottom panel, kept running while hidden ([#7](https://github.com/AhmedNavaz/codeshi/issues/7)) | [0.15.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0) |
| Windows (64-bit) builds with a one-line PowerShell install, checked against published checksums ([#5](https://github.com/AhmedNavaz/codeshi/issues/5)) | [0.16.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.16.0) |
| Voice input on macOS, recognized on the Mac, with spoken summaries of finished runs ([#11](https://github.com/AhmedNavaz/codeshi/issues/11)) | [0.17.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.17.0) |
| "While you were away" recaps of what ran, changed and is waiting, written or read aloud ([#22](https://github.com/AhmedNavaz/codeshi/issues/22)) | [0.17.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.17.0) |
| Live status in the Mac menu bar, and optional alerts near the top of the screen ([#13](https://github.com/AhmedNavaz/codeshi/issues/13)) | [0.18.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.18.0) |
| Point and tell: click an element in your app's preview and say what should change ([#19](https://github.com/AhmedNavaz/codeshi/issues/19)) | [0.19.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.19.0) |
| Undo and redo any run's changes, whichever agent made them, after a preview of every file and line ([#20](https://github.com/AhmedNavaz/codeshi/issues/20), stage 1) | [0.20.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.20.0) |
| Terminal tabs and split panes: several shells per workspace, each in a folder you choose, side by side or stacked ([#70](https://github.com/AhmedNavaz/codeshi/issues/70)) | [0.21.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.21.2) |
| Build, then review: one prompt's finished changes go to another agent for a read-only review once the build and its tests pass, and you choose which findings go back ([#15](https://github.com/AhmedNavaz/codeshi/issues/15)) | [0.22.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.22.0) |
| Network commands such as `git push` work with Full auto-approval on Codex, and under every setting on Gemini ([#81](https://github.com/AhmedNavaz/codeshi/issues/81)) | [0.25.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.25.1) |
| Continue on another agent when a run reaches a usage limit, or wait for the first reset if every agent is out; opt-in ([#91](https://github.com/AhmedNavaz/codeshi/issues/91)) | [0.25.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.25.1) |
| One workspace, several tasks at once: each in its folder, with its own output, approvals, queue and Stop, in its own worktree when a repository is already in use, and merged after review ([#88](https://github.com/AhmedNavaz/codeshi/issues/88), first milestone) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| A side panel with Brief and Tasks tabs: what every agent is told, the memory and skills that feed it, and what each task used | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| What each task used, across handoffs, retries and reviews, and repeatable evaluations with hidden checks ([#84](https://github.com/AhmedNavaz/codeshi/issues/84), first milestone) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| A brief focused on the task for each new agent ([#85](https://github.com/AhmedNavaz/codeshi/issues/85), first milestone) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| Reviewed project memory shared across agents ([#21](https://github.com/AhmedNavaz/codeshi/issues/21), first version) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| Skills any agent can follow, with six optional starters ([#86](https://github.com/AhmedNavaz/codeshi/issues/86), first milestone) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| Limits for a whole task, across its agents, retries and reviews ([#87](https://github.com/AhmedNavaz/codeshi/issues/87), first milestone) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| The task plan goes with the task when another agent takes over ([#92](https://github.com/AhmedNavaz/codeshi/issues/92)) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| Queued prompts follow a handoff, keeping their access ([#93](https://github.com/AhmedNavaz/codeshi/issues/93)) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| One result for a task that crossed agents ([#94](https://github.com/AhmedNavaz/codeshi/issues/94)) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| Drafting review fixes keeps the message in progress ([#95](https://github.com/AhmedNavaz/codeshi/issues/95)) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| Who is working and local models in Plan usage, the agent's edit in the preview, read-aloud highlighting, an on-device voice label and a clearer limit moment ([#96](https://github.com/AhmedNavaz/codeshi/issues/96)) | [0.26.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0) |
| Remote access: pair a phone by QR code, on the same Wi-Fi or over mobile data, with approval on the computer ([#23](https://github.com/AhmedNavaz/codeshi/issues/23), first milestone) | [0.27.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.27.0) |
| Run a queued prompt as a task beside the current run ([#108](https://github.com/AhmedNavaz/codeshi/issues/108), first step) | [0.27.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.27.0) |
| A Timeline of checkpoints, and restoring the workspace to any of them with a recovery point saved first ([#20](https://github.com/AhmedNavaz/codeshi/issues/20), stage 2) | [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) |
| Repeat an evaluation from saved input pins, with incompatible results kept apart ([#84](https://github.com/AhmedNavaz/codeshi/issues/84)) | [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) |
| Background reviews share a task's limits while they run, and one worker at a time holds its remaining allowance ([#87](https://github.com/AhmedNavaz/codeshi/issues/87)) | [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) |
| Stage, unstage and commit in the Git panel share task protection for the repository ([#88](https://github.com/AhmedNavaz/codeshi/issues/88)) | [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) |
| Routing checks the selected model's limits, and unknown usage can't start automatic handoffs or retries ([#12](https://github.com/AhmedNavaz/codeshi/issues/12), quota milestone) | [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) |
| Flow: just the chat, with plain cards for routing, plan allowance, next steps and changed files ([#107](https://github.com/AhmedNavaz/codeshi/issues/107), first milestone) | [0.29.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.29.2) |
| Testing cadence: **Review first** keeps checks small until you ask to finalize | [0.29.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.29.2) |
| Gemini on the Antigravity connection asks which folder to use in a workspace with several ([#116](https://github.com/AhmedNavaz/codeshi/issues/116), first step) | [0.29.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.29.2) |
| Claude keeps permission for commands after a background task wakes it ([#112](https://github.com/AhmedNavaz/codeshi/issues/112)) | [0.29.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.29.2) |
| Open links in terminal output with a click ([#83](https://github.com/AhmedNavaz/codeshi/issues/83)) | [0.29.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.29.2) |
| Deployment templates for the private-link service ([#9](https://github.com/AhmedNavaz/codeshi/issues/9)) | [0.29.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.29.2) |
| Automatic context refresh, a confirmed compact action in the message box, native-compaction visibility and restored task context; long-thread offline evaluations and continued-session accounting ([#123](https://github.com/AhmedNavaz/codeshi/issues/123), [#85](https://github.com/AhmedNavaz/codeshi/issues/85), [#84](https://github.com/AhmedNavaz/codeshi/issues/84)) | [0.30.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.30.0) |
| Rate each request with a short agent assessment on Send, then choose agent, model and effort using every limit and its reset time ([#12](https://github.com/AhmedNavaz/codeshi/issues/12), task assessment) | [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1) |
| Usage notices after each prompt, in Normal and Flow, with no model call: an unusually large run or a big move in a limit, offering Compact or Cost saving | [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1) |
| Gemini on the Antigravity connection works across all of a workspace's folders, in the shared chat ([#116](https://github.com/AhmedNavaz/codeshi/issues/116)) | [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1) |
| Plan usage leads with the five-hour limit; context refresh targets follow recent activity; the Compact context button shows its state as an icon | [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1) |
| Choose the model and effort for each queued message, and change them while a run works ([#113](https://github.com/AhmedNavaz/codeshi/issues/113)) | [0.32.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.32.0) |
| Gemini keeps its session between messages, its steps show commands, reads, edits and searches with their results, and a long run ends only after 15 minutes of silence | [0.32.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.32.0) |
| Codex connectors and MCP tools run under the run's access, and what an MCP server asks shows as a question ([#111](https://github.com/AhmedNavaz/codeshi/issues/111)) | [0.32.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.32.0) |
| Open a long workspace chat on its latest messages and load older ones as you scroll ([#124](https://github.com/AhmedNavaz/codeshi/issues/124)) | [0.32.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.32.0) |
| Links in replies open in the browser; limits stay in Plan usage; the message box options keep to the screen in a narrow layout | [0.32.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.32.0) |
| Smart, Saver and Ultra routing modes, spending allowance where it resets soonest, with local Saver rules and Ultra review passes ([#128](https://github.com/AhmedNavaz/codeshi/issues/128)) | [0.33.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.33.0) |
| Clickable response links, inline file references with line numbers, and activity diff viewer links ([#109](https://github.com/AhmedNavaz/codeshi/issues/109)) | [0.33.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.33.0) |
| Remote access multi-browser transfer, week-long connection persistence, and active status tracking ([#114](https://github.com/AhmedNavaz/codeshi/issues/114)) | [0.33.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.33.0) |
| Interactive Gemini multiple-choice question resolution directly in Codeshi question cards | [0.33.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.33.0) |

## Now

| Feature | Status | Issue |
| --- | --- | --- |
| Normal/Flow execution policy with safe manual takeover | Planned backend foundation for managed Flow; [agreed split](#normal-and-flow-the-agreed-execution-split). The Flow view shipped so far does not enforce this | [backend task policy draft](docs/flow-issue-plan.md#backend-task-policy) |
| More agents and models, such as Grok, DeepSeek, Qwen and free cloud tiers, on your own accounts | Gemini through Google Antigravity and local models through Ollama have shipped; further agents are next | [#4](https://github.com/AhmedNavaz/codeshi/issues/4) |
| Notarized macOS builds, so downloads open without a security prompt | Waiting on an Apple Developer account | [#1](https://github.com/AhmedNavaz/codeshi/issues/1) |
| Install with Homebrew: `brew install --cask codeshi` | Depends on #1 | [#3](https://github.com/AhmedNavaz/codeshi/issues/3) |

## Next

| Feature | Status | Issue |
| --- | --- | --- |
| Reproducible task evaluations and a local ledger of verified outcomes, usage and coordination overhead | First milestone shipped in 0.26.0: the **Tasks** panel and [`evals/`](evals/README.md). Saved experiment pins, skill/resource version checks and separated comparison groups shipped in [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0). Recorded long-thread comparisons, reasoning coverage and continued-session accounting shipped in [0.30.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.30.0). Run details gained each run's total against the agent's usual, and how each limit moved, in [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1). Next: budgeted live comparisons, including retention, cache behavior and total measured overhead before claiming efficiency gains; [measurement plan](docs/core-roadmap.md#next-milestone-long-thread-and-compaction-measurements) | [#84](https://github.com/AhmedNavaz/codeshi/issues/84) |
| Task-scoped context: relevant code, instructions and history, with source references and fresh handoff briefs | First milestone shipped in 0.26.0, with the **Brief** panel showing what a new agent is told; extends #69. [0.30.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.30.0) added visible native context and compaction records, restored bounded context and revalidated file evidence. Automatic context refresh between turns ([#123](https://github.com/AhmedNavaz/codeshi/issues/123)) shipped alongside it. [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1) keeps question answers as decisions in the brief and stops command text being reported as a blocker. Next: a saved retrieval index and live retention comparisons; [context plan](docs/core-roadmap.md#next-milestone-controlled-working-context-and-visible-compaction). Envelope limits do not bound native-session usage; savings remain unproven | [#85](https://github.com/AhmedNavaz/codeshi/issues/85) |
| Reviewed project memory and reusable learnings shared across agents | First version shipped in 0.26.0: **Remember** and rule-based suggestions, sent by relevance, with changed files marked for a recheck, and a memory can become a skill after review; [design](https://github.com/AhmedNavaz/codeshi/issues/21#issuecomment-6652426011) | [#21](https://github.com/AhmedNavaz/codeshi/issues/21) |
| Portable skills and workflow packs loaded on demand, with visible provider compatibility | First milestone shipped in 0.26.0: a catalog with six optional starters, loaded when a task needs them and kept across a handoff. Agents get skills as instructions; their own skill systems are not used yet | [#86](https://github.com/AhmedNavaz/codeshi/issues/86) |
| One task budget across providers, child runs, retries, reviews and handoffs | First milestone shipped in 0.26.0. [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) adds live parent accounting and shared deadlines for background reviews, exclusive reservation of remaining measured allowance per task, and review slots in workspace concurrency. In [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1) routing assessments count toward the task budget. API consent, cancellation and interrupted-usage recovery are covered by simulated-provider tests; real paid API verification remains | [#87](https://github.com/AhmedNavaz/codeshi/issues/87) |
| Concurrent prompts for independent workspace folders, with separate output, approvals and Stop controls | First milestone shipped in 0.26.0. [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) protects Git-panel stage, unstage and commit with shared repository mutation leases and retries tasks waiting on those actions. Not yet in the recap; tasks still can't use local models, reviews or undo | [#88](https://github.com/AhmedNavaz/codeshi/issues/88) |
| Adaptive agent, model and effort selection with Cost Saving, Balanced and Maximum Quality modes | Stage 1, routing whole requests, shipped in [0.14.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0) as **Routing**; stage 2's retry one step up after failed tests shipped in [0.18.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.18.0) as **Check with tests**. [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0) added selected-model quota checks, fresh dispatch revalidation and explicit unknown/stale readings across routing, handoff and retries. [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1) rates each request with a short agent assessment on Send, and reset times now count in the ranking. Shipped in 0.33.0: the Smart, Saver and Ultra modes, with allowance spent where it resets soonest ([#128](https://github.com/AhmedNavaz/codeshi/issues/128)); verified capabilities, measured selection, free/local fallback and subtask coordination follow; [scope and stages below](#adaptive-agent-and-model-routing) | [#12](https://github.com/AhmedNavaz/codeshi/issues/12) |
| A near-black **Dark** theme (keeping Graphite and Light), UI typography scale, non-clipping workspace indicators, and visual polish | Planned | [#127](https://github.com/AhmedNavaz/codeshi/issues/127) |
| Onboarding redesign: workspace-first setup, followed by Normal vs Flow mode choice with clear visual comparison | Planned | [#129](https://github.com/AhmedNavaz/codeshi/issues/129) |
| Reorganize Settings into structured categories and fix UI/UX inconsistencies across the app | Planned | [#130](https://github.com/AhmedNavaz/codeshi/issues/130) |
| Send selected terminal output to the conversation | Needs design | [#71](https://github.com/AhmedNavaz/codeshi/issues/71) |
| Hands-free voice conversations: say "send", keep talking while the agent works, hear what it did | Needs design; follows voice mode | [#72](https://github.com/AhmedNavaz/codeshi/issues/72) |
| Voice input on Windows | Planned, help wanted | [#73](https://github.com/AhmedNavaz/codeshi/issues/73) |
| Status in the Windows notification area | Planned, help wanted; follows the macOS menu bar status | [#74](https://github.com/AhmedNavaz/codeshi/issues/74) |
| Linux builds and CI | Windows builds are done; Linux CI test suite added in PR [#118](https://github.com/AhmedNavaz/codeshi/pull/118) ([#101](https://github.com/AhmedNavaz/codeshi/issues/101)), packaging open | [#5](https://github.com/AhmedNavaz/codeshi/issues/5) |
| Rewind: undo any run's changes, whichever agent made them, then one timeline of checkpoints | Stage 1 shipped in [0.20.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.20.0). Stage 2, the Timeline panel and previewed workspace restore with recovery checkpoints, shipped in [0.28.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0). Commits and optional conversation rewind remain stage 3 | [#20](https://github.com/AhmedNavaz/codeshi/issues/20) |
| Everything in the thread: GitHub issues, pull requests and failing CI checks as context, then pull requests from the conversation | Planned in stages; failed command output from Run shipped in [0.19.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.19.0); [details below](#everything-in-the-thread) | [#18](https://github.com/AhmedNavaz/codeshi/issues/18) |

### Everything in the thread

Bring the work around the code into the project conversation, so an agent sees what you see on GitHub, and finish the loop with a pull request. Collaborators with access to the repository work this way rather than through Ask a Friend.

1. **GitHub as context.** Paste or pick an issue, a pull request or the current branch, and Codeshi reads it through your own `gh` login: the issue or pull request with its comments and review threads, and the failing checks with the end of each failing job's log. It never asks for a token of its own and only reads. What comes in is shown for review before it is sent, as part of your message, with secrets and local paths removed by the same step that cleans exports. Nothing is fetched in the background.
2. **Logs from the app.** A failed command in **Run** puts its command and the end of its output in the message box in one click, since [0.19.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.19.0); selected terminal output follows in [#71](https://github.com/AhmedNavaz/codeshi/issues/71).
3. **A pull request from the conversation.** After you review the diff and commit in the Git panel, **Open pull request** pushes the branch and opens the pull request with `gh`, with a title and description drafted from the conversation for you to edit. It is the one place Codeshi pushes, only when you click it and after showing the remote and branch; agents never push.

### Adaptive agent and model routing

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

- **Check suitability before capacity.** Maintain model capabilities with their source and last verification date: supported tools, image inputs, context limits, reasoning controls and skill compatibility, as exposed through Codeshi's adapter. Use provider metadata and representative task evaluations for strengths and limitations; distinguish reported capabilities from observed results. Unknown or newly listed models must not inherit an assumed capability from their name.
- **Use the allowance that actually applies.** Consider remaining five-hour, weekly and model-specific windows, reset times, observation age and other active tasks sharing the account. Refresh before dispatch and handoff, and recheck the destination model. Missing or stale data stays unknown; a percentage is not a promise of a particular number of prompts or tokens.
- **Choose a model likely to finish the remaining work.** Match task difficulty, current progress, required tools and context to a suitable model, then consider available allowance, continuity and budget. Label usage forecasts as estimates. Include context transfer, retries and reviews in the decision; do not downgrade to an unsuitable model just because it has more allowance.
- **Make handoffs worth their cost.** Use the same selection policy for an initial assignment and its fallback. Prefer a safe stopping point when available, preserve the prompt, edits and unfinished plan, and avoid repeated switches or restarting completed work. If no suitable destination is available, offer waiting or a manual choice without silently spending on another service.
- **Explain before acting.** Show why this model fits, which usage windows constrain it, how fresh those readings are, and the main tradeoff against staying or choosing an alternative. Keep a one-click override and a recorded decision timeline. Normal mode and [Flow mode (#107)](https://github.com/AhmedNavaz/codeshi/issues/107) must read the same decision record, with details available behind plain-language summaries.
- **Prove the policy against manual use.** Extend [#84](https://github.com/AhmedNavaz/codeshi/issues/84) evaluations with misleading model names, unsupported tools, unknown capabilities, stale quota, weekly exhaustion, shared-account activity and mid-task handoffs. Compare equivalent tasks against a manually selected agent for correctness, total usage including transfer, retries, repeated work and user interventions. Define and meet acceptance thresholds before expanding automatic selection; do not claim guaranteed savings or zero wasted tokens.

Deliver in stages:

1. **Route whole requests.** Supported agents and models, the three modes, explicit budget controls, visible decisions and manual overrides. Shipped in 0.14.0 as **Routing**, with local rules for classifying requests, subscription-only billing unless API billing is allowed, and the choice shown before sending. Since [0.31.1](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1), a short read-only agent assessment on Send rates each request, because rules alone misjudged too many real prompts. Its usage counts toward the task budget, a bare go-ahead makes no agent call, and the choice shows with the sent message.
2. **Verify and recover.** Add bounded escalation based on task checks, quota handoff and reset queuing; validate at least one supported free or local integration before promising that fallback. Quota handoff ([#17](https://github.com/AhmedNavaz/codeshi/issues/17)) and reset queuing ([#32](https://github.com/AhmedNavaz/codeshi/issues/32)) shipped in 0.14.0. **Check with tests**, shipped in [0.18.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.18.0), runs the workspace's Test command after a routed run that changes files and, when the tests fail, retries once with the same agent one step up in model or effort, on its own in Balanced and Maximum quality and after asking in Cost saving. The run history records each routed run's tier, check and retry, which the panel summarises; a free or local fallback is still to come.
3. **Coordinate subtasks.** Assign work across agents with shared project context, explicit ownership of edits, bounded review cycles and one consolidated result. Parallel execution must avoid conflicting workspace changes. The [concurrent task proposal](docs/core-roadmap.md#concurrent-folder-tasks) supplies isolation and recovery; [specialist workflows](docs/core-roadmap.md#specialist-team-workflows) add contracts, dependencies and verification under one shared task budget.

Evaluate routing with representative coding tasks, tracking completion quality, allowance consumed, API charges where applicable, elapsed time and retry count. Compare against a manually chosen single agent before claiming savings or quality improvements.

### Onboarding and execution mode selection

Redesign the first-run onboarding experience ([#129](https://github.com/AhmedNavaz/codeshi/issues/129)) so users start directly with their project codebase and make an informed choice between Codeshi's two execution styles:
1. **Workspace and folder setup first.** Rather than confronting new users with accounts, API credentials, or permissions before they have loaded a project, onboarding prompts the user to create or name their workspace and select project folder(s) upfront.
2. **Normal vs Flow mode selection with clear comparison.** Present a visually engaging side-by-side card comparing the two core operating styles:
   - **Normal Mode (Full Control):** Complete manual orchestration. Select exact agents, models, and reasoning effort; build and inspect queued prompts; full access to terminal, git panel, side panels, and tool logs.
   - **Flow Mode (Outcome-Driven):** Minimal cognitive overhead. Describe the outcome and let Codeshi autonomously route (Smart, Saver, Ultra), perform quota handoffs, and manage verification, surrounded by floating plain-language status cards.
   - Transparently list key differences and benefits so beginners and power users immediately understand which mode fits their workflow.
3. **Persistent preference and easy toggling.** The chosen style sets the workspace's default layout, while clearly explaining that users can switch between Normal and Flow at any point with one click in the status bar or Settings.

### Interface polish, typography scale and settings structure

Enhance legibility, visual hierarchy, and navigation across the desktop interface ([#127](https://github.com/AhmedNavaz/codeshi/issues/127), [#130](https://github.com/AhmedNavaz/codeshi/issues/130)):
1. **Typography scale upgrade.** Increase micro-font sizes across cramped UI areas: sidebar workspace items, task metrics, status bar controls, and secondary chips (scaling up from 10–11px to readable 12.5–14px).
2. **Non-clipping workspace indicators.** Resolve horizontal crowding in compact sidebars (220–250px) where titles, running status dots, folder counts, and action buttons collide. Implement flexible two-line layouts or adaptive badge indicators that prevent truncation.
3. **Categorized settings navigation.** Break up the overloaded General tab into specialized sections (General, Appearance & Typography, AI Agents & Accounts, Routing & Budgets, Testing & Verification, Phone & Remote Access, Voice, Alerts, and Updates & Diagnostics).
4. **App-wide UI/UX consistency.** Standardize button sizes, dialog headers, padding, and theme contrast tokens across all panels and dialogs.

## Later

| Feature | Status | Issue |
| --- | --- | --- |
| Binary files in Ask a Friend patches | Planned | [#25](https://github.com/AhmedNavaz/codeshi/issues/25) |
| Run the project's own tests on a returned patch, with approval | On hold until Ask a Friend sees more use; collaborators with access to the repository use Git and CI, which [#18](https://github.com/AhmedNavaz/codeshi/issues/18) brings into the conversation | [#10](https://github.com/AhmedNavaz/codeshi/issues/10) |
| Accessibility pass for keyboard navigation and screen readers | Help wanted | [#26](https://github.com/AhmedNavaz/codeshi/issues/26) |
| Interface translations | Help wanted | [#27](https://github.com/AhmedNavaz/codeshi/issues/27) |

## Exploring

Larger ideas for bringing project context, execution and collaboration into one workspace. Each needs design work first, so join the issue before building. They continue to use your own agent accounts.

| Idea | Issue |
| --- | --- |
| **Parallel tasks from one request.** Split a big request into tasks that run side by side, each with its own agent and model: from **Up next**, by you, or proposed by the agent for you to accept. Tasks stay as ones you can continue in, grouped under the one that started them. | [#108](https://github.com/AhmedNavaz/codeshi/issues/108) |
| **Specialist team workflows.** Frontend, backend, database, design and QA roles assigned only where needed; shared contracts, isolated edits, deterministic checks and bounded independent review. Build on #12/#15 after context, skills, task budgets and concurrency are ready; the editable team plan could use [Plans](https://github.com/AhmedNavaz/codeshi/issues/97). | [#89](https://github.com/AhmedNavaz/codeshi/issues/89) |
| **Designer module.** Design websites and app screens in Codeshi, and guide agents section by section. [Point and tell](https://github.com/AhmedNavaz/codeshi/issues/19) already sends a note about one picked element; this adds tools for working on whole layouts, with direction for each section of the interface. It gives designers their own tool in [specialist teams](https://github.com/AhmedNavaz/codeshi/issues/89), alongside frontend, backend and database work. Models suited to design work, such as Astra and Fable, could be used here; Flow's routing doesn't choose them, and they stay a manual choice in Normal. | [#125](https://github.com/AhmedNavaz/codeshi/issues/125) |
| **Codeshi CLI.** Run, inspect, stop and continue the same workflows from a terminal; coordinate providers and retain desktop continuity through one execution engine. Start with headless run/status/continue/stop; add team commands later. | [#90](https://github.com/AhmedNavaz/codeshi/issues/90) |
| **Task board and schedules.** Normal runs explicit cards/graphs and fixed schedules; Flow executes authorized outcomes or bounded backlog selections. Reuse #97 cards and #88 tasks. [Plan below](#task-board-and-schedules). | [board/schedule issue draft](docs/flow-issue-plan.md#board-and-schedule-execution) |
| **Flow mode.** Managed outcomes with automatic policy-aware routing, handoff and bounded recovery; later task splitting, specialist teams and hands-free operation. The first milestone, a focused view with workspace-wide idle checks before either view change, shipped in [0.29.2](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.29.2), and [0.30.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.30.0) adds a direct **Review first** switch and clearer card actions. Backend execution-mode enforcement is planned in [backend task policy draft](docs/flow-issue-plan.md#backend-task-policy). Normal retains manual controls and exact selected workflows. [Agreed split](#normal-and-flow-the-agreed-execution-split). | [#107](https://github.com/AhmedNavaz/codeshi/issues/107) |
| **Suggestions at the right moment.** A feature that fits what's happening, offered in a sentence at a pause, from local rules: never changing a setting by itself, and easy to dismiss. | [#106](https://github.com/AhmedNavaz/codeshi/issues/106) |
| **Plans.** A visual plan for personal and company projects, as in project management tools: cards and blocks on a canvas, connected like a flowchart, showing what's done. Build it yourself, or give an agent a file or doc and it lays the plan out for you to rearrange and comment on. Set each card's agent, model and effort, then let the agents take it from there. Private until you share it, with a link others can comment on. Cards should be shared with the board and [#89](https://github.com/AhmedNavaz/codeshi/issues/89). | [#97](https://github.com/AhmedNavaz/codeshi/issues/97) |
| **Live progress near the top of the screen.** A compact pill under the menu bar while a run works, alongside the alerts from [#13](https://github.com/AhmedNavaz/codeshi/issues/13). | [#75](https://github.com/AhmedNavaz/codeshi/issues/75) |
| **Repeated tag-team cycles.** Build, then review shipped in [0.22.0](https://github.com/AhmedNavaz/codeshi/releases/tag/v0.22.0) with one review per prompt. Sending the fixes back for another review automatically would need a clear stop condition and a usage limit. | [#15](https://github.com/AhmedNavaz/codeshi/issues/15) |
| **Race mode.** Two agents take the same task in separate worktrees; keep the better result. Reuse concurrent-task isolation and count both attempts in the task's budget. | [#16](https://github.com/AhmedNavaz/codeshi/issues/16) |
| **Phone notifications.** **Remote access** already pairs a phone's browser by QR code with approval on the computer, for live progress, prompts, questions, Stop and approvals, on the same Wi-Fi or over mobile data through an encrypted relay at `remote.codeshi.dev`. Lock-screen notifications and iPhone Live Activities remain future work. | [#23](https://github.com/AhmedNavaz/codeshi/issues/23) |
| **Live multiplayer.** Teammates in the same conversation in real time, each on their own subscription. | [#24](https://github.com/AhmedNavaz/codeshi/issues/24) |

### Task board and schedules

A board for each project to capture work as it comes up and run it under an explicit Normal or Flow policy, tracked in [board/schedule issue draft](docs/flow-issue-plan.md#board-and-schedule-execution). #97 owns the shared card/canvas/board views; this issue owns execution and schedules, reusing #88 tasks.

1. **The board and running tasks.** Columns for Backlog, Ready, Doing, Review and Done. A card has a title, a description, a priority, labels, a checklist of what done means, and the execution policy: explicit assignments in Normal, or authorized automatic assignment in Flow. No new Normal card defaults to Auto. Running a card sends it to the agent and moves it to Doing; when the run ends, the card keeps the files it changed, the result of **Check with tests** and a short summary. **Run the Ready column** executes the exact selected graph in Normal, or an explicitly authorized bounded selection with Flow assignments. Dependencies, workspace concurrency and shared budgets apply in both. Cards can be dictated with voice input, and the saved context's unfinished tasks become the board's open cards, so agents know the backlog.
2. **Schedules.** Run a card or a prompt once at a set time, or repeat it daily, on weekdays or weekly. Normal binds fixed agents/settings and an exact workflow; Flow binds an outcome/backlog scope and permitted automation. Store the policy and material card revisions with the schedule; deduplicate starts and stop future automatic dispatch after takeover. Codeshi can keep running in the menu bar after its window closes, and open at login. Schedules run while the Mac is awake; a missed run shows in the "While you were away" recap and waits for you, unless you let it run late.
3. **Later.** Turn pasted meeting notes into cards with an agent, checked by you before any is added; sync cards with GitHub Issues through the access from [#18](https://github.com/AhmedNavaz/codeshi/issues/18); and run cards in parallel in separate worktrees with [#16](https://github.com/AhmedNavaz/codeshi/issues/16).

Design boundaries:

- An agent never marks its own work done. A finished card waits in Review with its diff and test result until you accept it; a failed one goes back to Ready with the reason.
- A scheduled run uses the access chosen when it was scheduled. Anything that needs approval waits and shows in the menu bar; nothing is approved for it unless the project already allows it, and nothing is pushed.
- Usage limits, routing and billing rules apply as they do to any run, and a schedule never wakes a sleeping Mac.
- Cards are kept with the project in Codeshi's own data, not in the repository, and work offline.

## Good places to start

- Use Codeshi on a real project and report what you notice, from bugs to design details.
- Issues labelled [good first issue](https://github.com/AhmedNavaz/codeshi/labels/good%20first%20issue) or [help wanted](https://github.com/AhmedNavaz/codeshi/labels/help%20wanted), such as tests for Windows and Linux CLI discovery ([#28](https://github.com/AhmedNavaz/codeshi/issues/28)).
- Small interface polish and clearer documentation in the [guide](docs/guide.md).

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and a map of the codebase.

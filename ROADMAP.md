# Roadmap

What Throughline already does, what is coming next and the bigger ideas being explored. **Now** is the current focus, **Next** is follow-up work, **Later** is further out, and **Exploring** holds larger ideas that need design before implementation. Dependencies are listed per item; blocked work does not hold up independent improvements. Priorities can change with feedback, so treat this as a plan rather than a promise.

A core goal is to get more work from existing agent allowances and available free or local options, so users can keep projects moving within their chosen budget without needing a higher subscription tier.

Every planned item has an issue. Comment there to shape it or to pick it up, and open one first for anything new. Release-by-release details are in the [changelog](CHANGELOG.md); bugs are tracked under the [bug label](https://github.com/AhmedNavaz/throughline/labels/bug).

## Use it and tell us what breaks

The fastest way to make Throughline better is to use it on your real projects and tell us what you find: bugs, confusing screens, slow spots and rough edges in the design. A small UI or UX note is as welcome as a crash report. [Report a bug](https://github.com/AhmedNavaz/throughline/issues/new?template=bug_report.yml) or [share design feedback](https://github.com/AhmedNavaz/throughline/issues/new?template=ux_feedback.yml).

## Shipped

| Feature | Since |
| --- | --- |
| Workspaces with one or more folders and one permanent conversation | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Claude Code and Codex in the same conversation, switching mid-task with shared context | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Model, reasoning effort and access chosen per message, with approvals and a live run view | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Import Claude Code and Codex chats from any project, merged in time order | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Conversation export for other Throughline users, with secrets and local paths removed | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Ask a Friend: share an approved snapshot and apply a reviewed patch | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Git activity with per-file diffs and recent commits | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| File browser with syntax-highlighted previews, and file and image attachments | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Plan usage for each agent, with reset times | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Keep awake while agents are working | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| Dark and light themes and keyboard shortcuts | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| macOS builds for Apple Silicon and Intel, and a container image for the private-link service | [0.4.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0) |
| One-line install from Terminal, checked against published checksums | [0.5.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.5.0) |
| First-run welcome and guided setup | [0.5.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.5.0) |
| Suggestions for earlier Claude Code and Codex chats that match a workspace's folders | [0.6.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.6.0) |
| Search the conversation with Cmd/Ctrl+F, highlights and next/previous matches | [0.7.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.7.0) |
| System appearance alongside explicit Light and Dark themes | [0.7.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.7.0) |
| Quiet background agent checks that preserve verified connection status | [0.7.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.7.0) |
| Native desktop menus for workspace, conversation, agent, appearance and Help controls | [0.8.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.8.0) |
| Cross-agent review of selected Git changes, with saved findings and explicit fix drafts | [0.9.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.9.0) |
| Gemini CLI (0.66.0+) in the shared project conversation, with ACP approvals, access controls and verified model selection | [0.10.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.10.0) |
| Continue locally with downloaded Ollama models, shared task context and Codex workspace tools | [0.10.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.10.0) |
| In-app release notes after updates, with saved workspaces opening directly | [0.10.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.10.0) |
| Contextual background reviews, grouped cloud/local model selection and prefilled Ask a Friend previews | [0.11.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.11.0) |
| Full auto-approval with an explicit workspace permission mode | [0.12.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.12.0) |
| Gemini conversation discovery, preview and import with an agent filter | [0.12.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.12.0) |
| Project command controls with Run, Test and Stop actions, package suggestions and live output | [0.13.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.13.0) |
| A clearer conversation: prompt bubbles, one-line live activity, pinned prompts and a quiet run status ([#45](https://github.com/AhmedNavaz/throughline/issues/45)) | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Searchable model picker, and a reasoning effort slider that follows each model's levels | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Agent handoffs that keep the task's intent ahead of tool logs ([#69](https://github.com/AhmedNavaz/throughline/issues/69)) | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Continue a stopped task with any agent and model, wait for a usage limit to reset and continue automatically, or queue prompts to run one after another ([#32](https://github.com/AhmedNavaz/throughline/issues/32)) | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Ask before changes: read-only actions run without approval, and an exact action can be allowed for a run or remembered for a workspace, with rules you can review and revoke ([#68](https://github.com/AhmedNavaz/throughline/issues/68)) | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Dock badge, alerts and a sidebar marker when a run finishes, stops or needs approval, with notifications that open the exact request and settings for alerts and sound ([#46](https://github.com/AhmedNavaz/throughline/issues/46)) | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Hand off to another agent before a usage limit stops the run, with the destination, billing and task shown first ([#17](https://github.com/AhmedNavaz/throughline/issues/17)) | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Add a note to the run that is working, and follow the agent's plan as a live to-do list | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Routing: the agent, model and effort picked for each message, shown with its reason before sending ([#12](https://github.com/AhmedNavaz/throughline/issues/12), stage 1) | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| A new layout: a search bar for workspaces, files and actions, a side panel for Agents and Git, and resizable sections | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Reliable Gemini connection on networks where Google stalls over IPv6 | [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) |
| Update from inside the app with one click: downloaded, checked against its checksum and installed once no agent is working ([#2](https://github.com/AhmedNavaz/throughline/issues/2)) | Next release |
| Each run as a timeline of its steps, with one live status line | Next release |
| Stage and commit from the Git panel, with your own identity and the project's commit hooks ([#6](https://github.com/AhmedNavaz/throughline/issues/6)) | Next release |
| A terminal for each workspace in a bottom panel, kept running while hidden ([#7](https://github.com/AhmedNavaz/throughline/issues/7)) | Next release |

## Now

| Feature | Status | Issue |
| --- | --- | --- |
| More agents and models, including Google's supported coding-agent integration, free cloud tiers and local models, on your own accounts | First milestones shipped in 0.10.0: Gemini CLI over ACP and explicit Ollama local-model handoffs through Codex tools; Google personal-account support now uses Antigravity ACP with native sign-in and model discovery in 0.11.0; further provider adapters are next | [#4](https://github.com/AhmedNavaz/throughline/issues/4) |
| Notarized macOS builds, so downloads open without a security prompt | Waiting on an Apple Developer account | [#1](https://github.com/AhmedNavaz/throughline/issues/1) |
| Install with Homebrew: `brew install --cask throughline` | Depends on #1 | [#3](https://github.com/AhmedNavaz/throughline/issues/3) |

## Next

| Feature | Status | Issue |
| --- | --- | --- |
| Adaptive agent, model and effort selection with Cost Saving, Balanced and Maximum Quality modes | Stage 1, routing whole requests, shipped in [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) as **Routing**; escalation after failed checks and subtask coordination are next; [scope and stages below](#adaptive-agent-and-model-routing) | [#12](https://github.com/AhmedNavaz/throughline/issues/12) |
| Windows and Linux builds | Planned, help wanted | [#5](https://github.com/AhmedNavaz/throughline/issues/5) |
| Deployment templates for the private-link service | Planned, help wanted | [#9](https://github.com/AhmedNavaz/throughline/issues/9) |
| Run the project's own tests on a returned patch, with approval | Planned | [#10](https://github.com/AhmedNavaz/throughline/issues/10) |

### Adaptive agent and model routing

Extend [smart model and effort selection (#12)](https://github.com/AhmedNavaz/throughline/issues/12) into an optional routing mode. For each prompt, Throughline should choose an eligible agent, model and reasoning effort using the task, project context, required tools, available allowance and the user's budget. Larger requests may be split into subtasks when doing so improves the result enough to justify the extra usage and coordination.

| Mode | Planned behavior |
| --- | --- |
| **Cost Saving** | Prioritize suitable free or local options and existing subscription allowances. Use lighter models for straightforward work, limit extra agent runs and reserve stronger reasoning for tasks that need it. |
| **Balanced** | Match capability and effort to task difficulty, balancing result quality, completion time and usage. Escalate when verification shows the first approach is insufficient. |
| **Maximum Quality** | Prioritize the strongest suitable models and deeper reasoning, with targeted independent review or multiple agents where useful, while respecting the user's spending limits. |

The mode should guide the whole run, including retries, reviews, subtask assignments and quota fallback. Every mode must respect these boundaries:

- Keep spending limits separate from quality preferences. Support a **No extra spending** setting; separately billed API use requires explicit opt-in and an enforceable budget. Unknown billing or unavailable quota data must stay visible and must not be treated as free capacity.
- Choose only from providers and models the user has connected and allowed. Free services still have limits; local options depend on the user's hardware. Additional providers come through [#4](https://github.com/AhmedNavaz/throughline/issues/4).
- Show the selected agent, model and effort with a short routing explanation, retain attribution for delegated work, and allow a manual override.
- Keep routing overhead small: use inexpensive rules for straightforward requests and bounded planning for complex work. Extra planning, reviews and retries count toward the same usage and spending limits.
- Preserve access modes and tool approvals across agents. Routing and quality modes do not grant additional permissions.
- On a verified usage limit, preserve edits and pass a bounded task brief, decisions and unfinished work to an eligible fallback through [#17](https://github.com/AhmedNavaz/throughline/issues/17). If none is available within the user's rules, queue until a reset through [#32](https://github.com/AhmedNavaz/throughline/issues/32).

Deliver in stages:

1. **Route whole requests.** Supported agents and models, the three modes, explicit budget controls, visible decisions and manual overrides. Shipped in 0.14.0 as **Routing**, with local rules for classifying requests (no model call), subscription-only billing unless API billing is allowed, and the choice shown before sending.
2. **Verify and recover.** Add bounded escalation based on task checks, quota handoff and reset queuing; validate at least one supported free or local integration before promising that fallback.
3. **Coordinate subtasks.** Assign work across agents with shared project context, explicit ownership of edits, bounded review cycles and one consolidated result. Parallel execution must avoid conflicting workspace changes.

Evaluate routing with representative coding tasks, tracking completion quality, allowance consumed, API charges where applicable, elapsed time and retry count. Compare against a manually chosen single agent before claiming savings or quality improvements.

## Later

| Feature | Status | Issue |
| --- | --- | --- |
| Binary files in Ask a Friend patches | Planned | [#25](https://github.com/AhmedNavaz/throughline/issues/25) |
| Accessibility pass for keyboard navigation and screen readers | Help wanted | [#26](https://github.com/AhmedNavaz/throughline/issues/26) |
| Interface translations | Help wanted | [#27](https://github.com/AhmedNavaz/throughline/issues/27) |

## Exploring

Larger ideas for bringing project context, execution and collaboration into one workspace. Each needs design work first, so join the issue before building. They continue to use your own agent accounts.

| Idea | Issue |
| --- | --- |
| **Voice mode.** Say what you want, the agent does it, then reads back a short spoken summary. Ask about the project out loud too. | [#11](https://github.com/AhmedNavaz/throughline/issues/11) |
| **Live status at a glance.** Progress and input requests in the Mac menu bar and around the notch, extending the desktop approval alerts in [#46](https://github.com/AhmedNavaz/throughline/issues/46). | [#13](https://github.com/AhmedNavaz/throughline/issues/13) |
| **Focus and downtime.** Optional timers, ambient audio, reading and short games during agent runs, with persistent status and a clear return to the project when attention is needed. [Scope and stages below](#focus-and-downtime). | [#14](https://github.com/AhmedNavaz/throughline/issues/14) |
| **Automatic tag-team cycles.** Extend cross-agent review with an opt-in handoff from builder to reviewer and user-approved fix cycles. | [#15](https://github.com/AhmedNavaz/throughline/issues/15) |
| **Race mode.** Two agents take the same task in separate worktrees; keep the better result. | [#16](https://github.com/AhmedNavaz/throughline/issues/16) |
| **Everything in the thread.** Issues, pull requests, CI failures and logs as context, and pull requests from the conversation. | [#18](https://github.com/AhmedNavaz/throughline/issues/18) |
| **Point and tell.** Click an element in your app's preview and say what should change. | [#19](https://github.com/AhmedNavaz/throughline/issues/19) |
| **Rewind.** One timeline of messages, file changes and commits, with checkpoints to undo any step. | [#20](https://github.com/AhmedNavaz/throughline/issues/20) |
| **Project memory.** A living brief of goals, decisions and conventions that every agent reads. | [#21](https://github.com/AhmedNavaz/throughline/issues/21) |
| **"While you were away" recaps.** A short written or spoken briefing of what ran and what is waiting. | [#22](https://github.com/AhmedNavaz/throughline/issues/22) |
| **Approve from your phone.** Extend desktop approval alerts to a paired phone, with run progress and iPhone Live Activities. | [#23](https://github.com/AhmedNavaz/throughline/issues/23) |
| **Live multiplayer.** Teammates in the same conversation in real time, each on their own subscription. | [#24](https://github.com/AhmedNavaz/throughline/issues/24) |

### Focus and downtime

Explore an optional space for focus, breaks and enjoyable downtime while agents work. Users should be able to listen, read, play briefly or step away, then return with a clear account of what changed and what needs their attention. Keep the project conversation, execution and review central; the whole space should be easy to disable.

Deliver in stages, starting with agent awareness:

1. **Stay informed and return easily.** Build on compact activity in [#45](https://github.com/AhmedNavaz/throughline/issues/45) and actionable approval alerts in [#46](https://github.com/AhmedNavaz/throughline/issues/46). Keep status visible within the app and notifications useful outside it; extend those surfaces through [#13](https://github.com/AhmedNavaz/throughline/issues/13). Link a factual return recap in [#22](https://github.com/AhmedNavaz/throughline/issues/22) to the result, changed files and outstanding requests.
2. **Try a small local experience.** Offer a configurable focus or break timer, a clock and optional ambient audio. Start without a network service, model calls or extra account requirements. Timers can be paused, snoozed or dismissed; no fixed routine is imposed.
3. **Validate optional activities.** Experiment with a short pauseable game, saved reading links or user-selected feeds. Add music or video integrations only when users request them and the provider supports the intended desktop experience. General browsing, film and series playback, weather and quote widgets need separate justification before expanding the scope.

Design boundaries:

- Distinguish running, needs input, failed and ready to review. Show actual reported activity; do not invent progress percentages or completion times. An attention indicator opens the correct workspace and request.
- Keep approvals in trusted application UI. Consuming media never grants permission or enables auto-approval. Pause a built-in game when attention is required; pausing or lowering media volume requires the user's preference, and unrelated external players remain under their control.
- Keep remote articles and players isolated from coding capabilities, project files, credentials and the desktop bridge. Prefer official integrations or opening the user's external application. Free APIs and open-source tools still require checks of licenses, content access, account requirements and maintenance costs.
- Load optional services only after the user chooses them. Avoid autoplay, infinite feeds, streaks and incentives to remain in the app. OS notifications remain available when users choose another application or a physical break.
- Trial the small experience with interested users and people who prefer a plain workspace. Evaluate enjoyment, missed requests, time to return and review, unwanted distraction and task completion. Expand based on usefulness rather than time spent inside Throughline; do not claim productivity gains before measuring them.

## Good places to start

- Use Throughline on a real project and report what you notice, from bugs to design details.
- Issues labelled [good first issue](https://github.com/AhmedNavaz/throughline/labels/good%20first%20issue) or [help wanted](https://github.com/AhmedNavaz/throughline/labels/help%20wanted), such as tests for Windows and Linux CLI discovery ([#28](https://github.com/AhmedNavaz/throughline/issues/28)).
- Small interface polish and clearer documentation in the [guide](docs/guide.md).

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and a map of the codebase.

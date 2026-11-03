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
| Update from inside the app with one click: downloaded, checked against its checksum and installed once no agent is working ([#2](https://github.com/AhmedNavaz/throughline/issues/2)) | [0.15.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.15.0) |
| Each run as a timeline of its steps, with one live status line | [0.15.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.15.0) |
| Stage and commit from the Git panel, with your own identity and the project's commit hooks ([#6](https://github.com/AhmedNavaz/throughline/issues/6)) | [0.15.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.15.0) |
| A terminal for each workspace in a bottom panel, kept running while hidden ([#7](https://github.com/AhmedNavaz/throughline/issues/7)) | [0.15.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.15.0) |
| Windows (64-bit) builds with a one-line PowerShell install, checked against published checksums ([#5](https://github.com/AhmedNavaz/throughline/issues/5)) | [0.16.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.16.0) |
| Voice input on macOS, recognized on the Mac, with spoken summaries of finished runs ([#11](https://github.com/AhmedNavaz/throughline/issues/11)) | [0.17.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.17.0) |
| "While you were away" recaps of what ran, changed and is waiting, written or read aloud ([#22](https://github.com/AhmedNavaz/throughline/issues/22)) | [0.17.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.17.0) |
| Live status in the Mac menu bar, and optional alerts near the top of the screen ([#13](https://github.com/AhmedNavaz/throughline/issues/13)) | [0.18.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.18.0) |
| Point and tell: click an element in your app's preview and say what should change ([#19](https://github.com/AhmedNavaz/throughline/issues/19)) | [0.19.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.19.0) |
| Undo and redo any run's changes, whichever agent made them, after a preview of every file and line ([#20](https://github.com/AhmedNavaz/throughline/issues/20), stage 1) | [0.20.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.20.0) |
| Terminal tabs and split panes: several shells per workspace, each in a folder you choose, side by side or stacked ([#70](https://github.com/AhmedNavaz/throughline/issues/70)) | [0.21.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.21.0) |

## Now

| Feature | Status | Issue |
| --- | --- | --- |
| More agents and models, including Google's supported coding-agent integration, free cloud tiers and local models, on your own accounts | First milestones shipped in 0.10.0: Gemini CLI over ACP and explicit Ollama local-model handoffs through Codex tools; Google personal-account support now uses Antigravity ACP with native sign-in and model discovery in 0.11.0; further provider adapters are next | [#4](https://github.com/AhmedNavaz/throughline/issues/4) |
| Notarized macOS builds, so downloads open without a security prompt | Waiting on an Apple Developer account | [#1](https://github.com/AhmedNavaz/throughline/issues/1) |
| Install with Homebrew: `brew install --cask throughline` | Depends on #1 | [#3](https://github.com/AhmedNavaz/throughline/issues/3) |

## Next

| Feature | Status | Issue |
| --- | --- | --- |
| Adaptive agent, model and effort selection with Cost Saving, Balanced and Maximum Quality modes | Stage 1, routing whole requests, shipped in [0.14.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0) as **Routing**; stage 2's retry one step up after failed tests shipped in [0.18.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.18.0) as **Check with tests**; a free or local fallback and subtask coordination are next; [scope and stages below](#adaptive-agent-and-model-routing) | [#12](https://github.com/AhmedNavaz/throughline/issues/12) |
| Send selected terminal output to the conversation | Needs design | [#71](https://github.com/AhmedNavaz/throughline/issues/71) |
| Hands-free voice conversations: say "send", keep talking while the agent works, hear what it did | Needs design; follows voice mode | [#72](https://github.com/AhmedNavaz/throughline/issues/72) |
| Voice input on Windows | Planned, help wanted | [#73](https://github.com/AhmedNavaz/throughline/issues/73) |
| Status in the Windows notification area | Planned, help wanted; follows the macOS menu bar status | [#74](https://github.com/AhmedNavaz/throughline/issues/74) |
| Linux builds | Windows builds are done; Linux packaging is open, help wanted | [#5](https://github.com/AhmedNavaz/throughline/issues/5) |
| Rewind: undo any run's changes, whichever agent made them, then one timeline of checkpoints | Stage 1, undoing and redoing a run with a preview of every file, shipped in [0.20.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.20.0); a Timeline panel and restoring the workspace to any checkpoint follow | [#20](https://github.com/AhmedNavaz/throughline/issues/20) |
| Deployment templates for the private-link service | Planned, help wanted | [#9](https://github.com/AhmedNavaz/throughline/issues/9) |
| Everything in the thread: GitHub issues, pull requests and failing CI checks as context, then pull requests from the conversation | Planned in stages; failed command output from Run shipped in [0.19.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.19.0); [details below](#everything-in-the-thread) | [#18](https://github.com/AhmedNavaz/throughline/issues/18) |

### Everything in the thread

Bring the work around the code into the project conversation, so an agent sees what you see on GitHub, and finish the loop with a pull request. Collaborators with access to the repository work this way rather than through Ask a Friend.

1. **GitHub as context.** Paste or pick an issue, a pull request or the current branch, and Throughline reads it through your own `gh` login: the issue or pull request with its comments and review threads, and the failing checks with the end of each failing job's log. It never asks for a token of its own and only reads. What comes in is shown for review before it is sent, as part of your message, with secrets and local paths removed by the same step that cleans exports. Nothing is fetched in the background.
2. **Logs from the app.** A failed command in **Run** puts its command and the end of its output in the message box in one click, since [0.19.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.19.0); selected terminal output follows in [#71](https://github.com/AhmedNavaz/throughline/issues/71).
3. **A pull request from the conversation.** After you review the diff and commit in the Git panel, **Open pull request** pushes the branch and opens the pull request with `gh`, with a title and description drafted from the conversation for you to edit. It is the one place Throughline pushes, only when you click it and after showing the remote and branch; agents never push.

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
2. **Verify and recover.** Add bounded escalation based on task checks, quota handoff and reset queuing; validate at least one supported free or local integration before promising that fallback. Quota handoff ([#17](https://github.com/AhmedNavaz/throughline/issues/17)) and reset queuing ([#32](https://github.com/AhmedNavaz/throughline/issues/32)) shipped in 0.14.0. **Check with tests**, shipped in [0.18.0](https://github.com/AhmedNavaz/throughline/releases/tag/v0.18.0), runs the workspace's Test command after a routed run that changes files and, when the tests fail, retries once with the same agent one step up in model or effort, on its own in Balanced and Maximum quality and after asking in Cost saving. The run history records each routed run's tier, check and retry, which the panel summarises; a free or local fallback is still to come.
3. **Coordinate subtasks.** Assign work across agents with shared project context, explicit ownership of edits, bounded review cycles and one consolidated result. Parallel execution must avoid conflicting workspace changes.

Evaluate routing with representative coding tasks, tracking completion quality, allowance consumed, API charges where applicable, elapsed time and retry count. Compare against a manually chosen single agent before claiming savings or quality improvements.

## Later

| Feature | Status | Issue |
| --- | --- | --- |
| Binary files in Ask a Friend patches | Planned | [#25](https://github.com/AhmedNavaz/throughline/issues/25) |
| Run the project's own tests on a returned patch, with approval | On hold until Ask a Friend sees more use; collaborators with access to the repository use Git and CI, which [#18](https://github.com/AhmedNavaz/throughline/issues/18) brings into the conversation | [#10](https://github.com/AhmedNavaz/throughline/issues/10) |
| Accessibility pass for keyboard navigation and screen readers | Help wanted | [#26](https://github.com/AhmedNavaz/throughline/issues/26) |
| Interface translations | Help wanted | [#27](https://github.com/AhmedNavaz/throughline/issues/27) |

## Exploring

Larger ideas for bringing project context, execution and collaboration into one workspace. Each needs design work first, so join the issue before building. They continue to use your own agent accounts.

| Idea | Issue |
| --- | --- |
| **Task board and schedules.** Capture tasks from meetings or anywhere on a board for each project, with priority and details, and let agents work through them while you review the results; run tasks on a schedule. [Plan below](#task-board-and-schedules). | Not opened yet |
| **Live progress near the top of the screen.** A compact pill under the menu bar while a run works, alongside the alerts from [#13](https://github.com/AhmedNavaz/throughline/issues/13). | [#75](https://github.com/AhmedNavaz/throughline/issues/75) |
| **Automatic tag-team cycles.** Extend cross-agent review with an opt-in handoff from builder to reviewer and user-approved fix cycles. | [#15](https://github.com/AhmedNavaz/throughline/issues/15) |
| **Race mode.** Two agents take the same task in separate worktrees; keep the better result. | [#16](https://github.com/AhmedNavaz/throughline/issues/16) |
| **Project memory.** A living brief of goals, decisions and conventions that every agent reads. | [#21](https://github.com/AhmedNavaz/throughline/issues/21) |
| **Approve from your phone.** Extend desktop approval alerts to a paired phone, with run progress and iPhone Live Activities. | [#23](https://github.com/AhmedNavaz/throughline/issues/23) |
| **Live multiplayer.** Teammates in the same conversation in real time, each on their own subscription. | [#24](https://github.com/AhmedNavaz/throughline/issues/24) |

### Task board and schedules

A board for each project to capture work as it comes up, in a meeting or anywhere else, and let agents work through it while you review the results. Tasks can also run on a schedule.

1. **The board and running tasks.** Columns for Backlog, Ready, Doing, Review and Done. A card has a title, a description, a priority, labels, a checklist of what done means, and the agent to use, Auto by default so routing chooses. Running a card sends it to the agent and moves it to Doing; when the run ends, the card keeps the files it changed, the result of **Check with tests** and a short summary. **Run the Ready column** works through cards in priority order with the prompt queue, one at a time in each project and in parallel across projects. Cards can be dictated with voice input, and the saved context's unfinished tasks become the board's open cards, so agents know the backlog.
2. **Schedules.** Run a card or a prompt once at a set time, or repeat it daily, on weekdays or weekly. Throughline can keep running in the menu bar after its window closes, and open at login. Schedules run while the Mac is awake; a missed run shows in the "While you were away" recap and waits for you, unless you let it run late.
3. **Later.** Turn pasted meeting notes into cards with an agent, checked by you before any is added; sync cards with GitHub Issues through the access from [#18](https://github.com/AhmedNavaz/throughline/issues/18); and run cards in parallel in separate worktrees with [#16](https://github.com/AhmedNavaz/throughline/issues/16).

Design boundaries:

- An agent never marks its own work done. A finished card waits in Review with its diff and test result until you accept it; a failed one goes back to Ready with the reason.
- A scheduled run uses the access chosen when it was scheduled. Anything that needs approval waits and shows in the menu bar; nothing is approved for it unless the project already allows it, and nothing is pushed.
- Usage limits, routing and billing rules apply as they do to any run, and a schedule never wakes a sleeping Mac.
- Cards are kept with the project in Throughline's own data, not in the repository, and work offline.

## Good places to start

- Use Throughline on a real project and report what you notice, from bugs to design details.
- Issues labelled [good first issue](https://github.com/AhmedNavaz/throughline/labels/good%20first%20issue) or [help wanted](https://github.com/AhmedNavaz/throughline/labels/help%20wanted), such as tests for Windows and Linux CLI discovery ([#28](https://github.com/AhmedNavaz/throughline/issues/28)).
- Small interface polish and clearer documentation in the [guide](docs/guide.md).

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and a map of the codebase.

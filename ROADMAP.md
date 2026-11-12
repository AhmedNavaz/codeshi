# Roadmap

What Codeshi is working on, in priority order. **Now** is the current focus, **Next** follows it, **Later** is further out, and **Exploring** holds larger ideas that need design first. Each table is ordered with the most important item at the top. Priorities can change with feedback, so treat this as a plan rather than a promise.

A core goal is to get more verified work from the agent allowances people already have, without needing a higher subscription tier.

Every item links to its GitHub issue. Comment there to shape it or pick it up, and open an issue before starting new work. What has already shipped is in [shipped features](docs/shipped.md) and the [changelog](CHANGELOG.md); the longer design notes are in [roadmap details](docs/roadmap-details.md); bugs are under the [bug label](https://github.com/AhmedNavaz/codeshi/labels/bug).

## Now

| # | Feature | What's left | Issue |
| --- | --- | --- | --- |
| 1 | **Lower battery and resource use** | Measure idle, streaming, Lounge and preview workloads, fix what the measurements show, and set energy budgets. The Lounge's first mitigation shipped in 0.38.0, and 0.40.0 draws weather at most 30 times a second, paces games at 60 Hz speed and runs the setup glow once. Since 0.42.0, **Help › Record Performance Trace** measures the installed app. In 0.43.0, weather moved from the Lounge to Flow's **Your space**, and Clear draws nothing. Idle, streaming and preview workloads are not measured yet | [#152](https://github.com/AhmedNavaz/codeshi/issues/152) |
| 2 | **Notarized macOS builds** | Downloads that open without a security prompt, with notification banners. Waiting on an Apple Developer account | [#1](https://github.com/AhmedNavaz/codeshi/issues/1) |
| 3 | **One routing policy for the whole task** | Since 0.44.0, retries, Ultra's reviewer, resuming after a reset and Orchestrate steps use the same Smart, Saver or Ultra handoff line as the first assignment and handoffs. Left: Flow handoffs shown as a notice rather than an offer, model abilities that are verified rather than guessed from names, and automatic fallback to a local model. [Scope](docs/roadmap-details.md#adaptive-agent-and-model-routing) | [#12](https://github.com/AhmedNavaz/codeshi/issues/12) |
| 4 | **Evidence that routing and context changes help** | Budgeted live comparisons against a manually chosen agent, and long real tasks measured before and after. An Orchestrate plan's total for planning and every step shipped in 0.41.0, Claude's usage split by model in 0.44.0, and sharing for Smart results in 0.45.1. No savings are claimed until then | [#84](https://github.com/AhmedNavaz/codeshi/issues/84), [#139](https://github.com/AhmedNavaz/codeshi/issues/139), [#85](https://github.com/AhmedNavaz/codeshi/issues/85) |

## Next

| # | Feature | What's left | Issue |
| --- | --- | --- | --- |
| 1 | **Flow manages a whole outcome** | Flow runs a bounded outcome under the backend task policy, with takeover, recovery and end-to-end tests. The focused view, cards and project review have shipped, and What happened in 0.45.1. [Agreed split](docs/roadmap-details.md#normal-and-flow-the-agreed-execution-split) | [#107](https://github.com/AhmedNavaz/codeshi/issues/107) |
| 2 | **More agents and models** | Grok, DeepSeek, Qwen and free cloud tiers on your own accounts. Gemini and local Ollama models have shipped | [#4](https://github.com/AhmedNavaz/codeshi/issues/4) |
| 3 | **Plans** | Plans drafted from an uploaded project document, a board, and cards you place yourself. Orchestrate's step plans shipped in 0.37.0, 0.41.0 shows them as a full-window chart with an outline, and 0.45.1 adds a canvas to the board | [#97](https://github.com/AhmedNavaz/codeshi/issues/97) |
| 4 | **Parallel tasks from one request** | A split proposed by the agent, a total for the group, and a measured comparison with one agent working in order. Running an Orchestrate plan as tasks shipped in 0.39.0, and folding a plan's row with its total in 0.45.1 | [#108](https://github.com/AhmedNavaz/codeshi/issues/108) |
| 5 | **Specialist roles** | One round of repair after a review, an independent review of the final result, and a measured comparison with one agent. Roles, artifacts and checks on Orchestrate steps shipped in 0.38.0. Since 0.46.0, a plan's step is tested before later steps build on it, and each step is briefed from what the earlier steps did | [#89](https://github.com/AhmedNavaz/codeshi/issues/89) |
| 6 | **GitHub in the conversation** | Trying **Open pull request** against GitHub itself: it shipped in 0.46.0 with automated tests only. Issues, pull requests and failing checks as context shipped in 0.39.0. [Scope](docs/roadmap-details.md#everything-in-the-thread) | [#18](https://github.com/AhmedNavaz/codeshi/issues/18) |
| 7 | **Concurrent tasks, finished** | Local models, Review changes and undo inside a task. A task's copy getting your installed packages shipped in 0.40.0, and tasks and plans in the recap in 0.46.0 | [#88](https://github.com/AhmedNavaz/codeshi/issues/88) |
| 8 | **Skills through each agent's own skill system** | The same skill on at least two agents, including after a handoff, with usage measured with and without it | [#86](https://github.com/AhmedNavaz/codeshi/issues/86) |
| 9 | **Task limits checked on a paid API account** | Everything else has shipped; it has only been tested with simulated providers | [#87](https://github.com/AhmedNavaz/codeshi/issues/87) |
| 10 | **Install with Homebrew** | `brew install --cask codeshi`. Depends on notarized builds (#1) | [#3](https://github.com/AhmedNavaz/codeshi/issues/3) |
| 11 | **Linux builds** | Packaging. The test suite already runs on Linux in CI | [#5](https://github.com/AhmedNavaz/codeshi/issues/5) |

## Later

| Feature | Status | Issue |
| --- | --- | --- |
| Hands-free voice conversations: conversation mode with "send" by voice and voice approvals, shipped in Flow on macOS in 0.40.0. Left: a long session with real agents. Windows is #73 | First version shipped in 0.40.0 | [#72](https://github.com/AhmedNavaz/codeshi/issues/72) |
| Project memory: a recheck when a branch or dependency changes, and reviewed suggestions. Copy to AGENTS.md shipped in 0.40.0 | First version shipped in 0.26.0 | [#21](https://github.com/AhmedNavaz/codeshi/issues/21) |
| Rewind stage 3: commits on the Timeline. Rewinding the conversation with a checkpoint shipped in 0.41.0 | Stages 1 and 2 shipped in 0.20.0 and 0.28.0 | [#20](https://github.com/AhmedNavaz/codeshi/issues/20) |
| iPhone Live Activities, which need a native app. Lock-screen notifications shipped in 0.41.0 | Remote access shipped in 0.27.0 | [#23](https://github.com/AhmedNavaz/codeshi/issues/23) |
| Voice input on Windows | Help wanted | [#73](https://github.com/AhmedNavaz/codeshi/issues/73) |
| Status in the Windows notification area: trying it on a real Windows PC. Built with automated tests only | First version shipped in 0.42.0, help wanted | [#74](https://github.com/AhmedNavaz/codeshi/issues/74) |
| Accessibility: a VoiceOver and NVDA check of the whole app. Menus, popovers, the file tree and search shipped in 0.42.0 | First pass shipped in 0.42.0, help wanted | [#26](https://github.com/AhmedNavaz/codeshi/issues/26) |
| Interface translations: the first languages, and the remaining panels, phone page and server messages. The base and main surfaces shipped in 0.42.0 | Base shipped in 0.42.0, help wanted | [#27](https://github.com/AhmedNavaz/codeshi/issues/27) |

## Exploring

Larger ideas that need design work first, so join the issue before building. They continue to use your own agent accounts.

| Idea | Issue |
| --- | --- |
| **Task board and schedules.** A board per project, and cards or prompts that run at a set time. The board you run by hand shipped in 0.43.0, and a canvas view in 0.45.1; schedules and Flow choosing cards are next. [Plan](docs/roadmap-details.md#task-board-and-schedules) | [#132](https://github.com/AhmedNavaz/codeshi/issues/132) |
| **Codeshi CLI.** Run, inspect, stop and continue the same workflows from a terminal, on the same engine as the desktop app. An interactive `codeshi` session and script commands shipped in 0.43.0 on macOS, sharing the window's conversation; Flow routing, workflows and Windows and Linux installs are next. Smart, Saver and Ultra don't apply to messages from the terminal yet, and it doesn't show the Flow mode. [Reference](docs/cli.md) | [#90](https://github.com/AhmedNavaz/codeshi/issues/90) |
| **Connect GitHub.** Pick one of your repositories and open it as a workspace, using your `gh` login or a read-only sign-in. No Codeshi account or server. [Plan](docs/roadmap-details.md#connect-github-and-move-to-another-computer) | [#159](https://github.com/AhmedNavaz/codeshi/issues/159) |
| **Move Codeshi to another computer, with no account.** Pair two computers with a QR code and a six-digit code, review what moves, and pick each workspace's local folder. An encrypted file covers offline moves. Ongoing sync is later. [Plan](docs/roadmap-details.md#connect-github-and-move-to-another-computer) | [#160](https://github.com/AhmedNavaz/codeshi/issues/160) |
| **Designer module.** Design websites and app screens in Codeshi and guide agents section by section. Design notes in the preview shipped in 0.43.0: mark several parts of a page, with a note on each, sent as one message. A layout canvas and handing design work to team workflows are next. [Plan](docs/roadmap-details.md#designer-module) | [#125](https://github.com/AhmedNavaz/codeshi/issues/125) |
| **Race mode.** Two agents take the same task in separate worktrees; keep the better result | [#16](https://github.com/AhmedNavaz/codeshi/issues/16) |
| **Live multiplayer.** Teammates in the same conversation in real time, each on their own subscription. Watching a teammate's conversation read-only, with suggestions, shipped in 0.43.0; steering and running together are next | [#24](https://github.com/AhmedNavaz/codeshi/issues/24) |
| **Public help requests.** Post a reviewed request, with the agent's history, where anyone can pick it up and send back a fix you review, without access to your repository. Builds on Ask a Friend. [Plan](docs/roadmap-details.md#public-help-requests) | [#158](https://github.com/AhmedNavaz/codeshi/issues/158) |

## Recently shipped

- **0.46.0:** a plan's steps tested before later steps build on them, Open pull request in the Git panel, tasks and plans in the recap, and a 12-hour clock.
- **0.45.1:** the board as a canvas, a What happened card in Flow, sharing for Smart results, folded plan rows with totals, and waiting approvals kept across handoffs.
- **0.44.0:** one handoff line for a whole routed task, Claude's usage split by model, one layout for every dialog, setup with the keyboard and a screen reader, and badges that pass contrast checks in every theme.
- **0.43.0:** a task board, the `codeshi` command and a CLI tab, design notes in the preview, watching a teammate's conversation live, and weather in Flow's Your space.
- **0.42.0:** a progress pill under the menu bar, binary files and your own tests in Ask a Friend, suggestions after a run, status in the Windows notification area, an interface ready for translation, a keyboard and screen reader pass, six puzzles in the Lounge, and Record Performance Trace.
- **0.41.0:** Orchestrate plans as a full-window chart, lock-screen notifications on your phone, rewinding the conversation with a checkpoint, a total for a whole plan, Word documents as attachments, and one usage line for assigning and handing off a task.

The full list is in [shipped features](docs/shipped.md).

## Good places to start

- Use Codeshi on a real project and tell us what you find, from bugs to design details: [report a bug](https://github.com/AhmedNavaz/codeshi/issues/new?template=bug_report.yml) or [share design feedback](https://github.com/AhmedNavaz/codeshi/issues/new?template=ux_feedback.yml).
- Issues labelled [good first issue](https://github.com/AhmedNavaz/codeshi/labels/good%20first%20issue) or [help wanted](https://github.com/AhmedNavaz/codeshi/labels/help%20wanted).
- Small interface polish and clearer documentation in the [guide](docs/guide.md).

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and a map of the codebase.

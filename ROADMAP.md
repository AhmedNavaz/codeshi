# Roadmap

What Codeshi is working on, in priority order. **Now** is the current focus, **Next** follows it and **Later** is further out, each with the most important item at the top. **Final checks** lists features that are built and only need one try on the real service or device. **Ongoing checks** is testing that keeps going across releases, and **Exploring** holds larger ideas that need design first. Priorities can change with feedback, so treat this as a plan rather than a promise.

A core goal is to get more verified work from the agent allowances people already have, without needing a higher subscription tier.

Every item links to its GitHub issue. Comment there to shape it or pick it up, and open an issue before starting new work. What has already shipped is in [shipped features](docs/shipped.md) and the [changelog](CHANGELOG.md); the longer design notes are in [roadmap details](docs/roadmap-details.md); bugs are under the [bug label](https://github.com/AhmedNavaz/codeshi/labels/bug).

## Now

| # | Feature | What's left | Issue |
| --- | --- | --- | --- |
| 1 | **Notarized macOS builds** | Downloads that open without a security prompt, with notification banners. Waiting on an Apple Developer account | [#1](https://github.com/AhmedNavaz/codeshi/issues/1) |
| 2 | **Flow manages a whole outcome** | Flow splitting a request into tasks of its own, a Tasks side by side card, and a live check of a handoff between real accounts. One managed task (routing, a retry after a failed check, taking manual control and a restart) has been checked live on a real account. The focused view, cards and project review have shipped, and What happened in 0.45.1. [Agreed split](docs/roadmap-details.md#normal-and-flow-the-agreed-execution-split) | [#107](https://github.com/AhmedNavaz/codeshi/issues/107) |
| 3 | **One Plan** | Orchestrate's Plan view and the task board become one **Plan** with Columns, Canvas and Outline. Agents add cards as drafts you accept, from a message, from a project document or with **Suggest next** on a card, with as many cards and subtasks as the project needs, drafted by one planning method based on software engineering practice and checked before you see it. You can watch a plan run on the Plan itself, in Normal or Flow: each card's live agent, progress and usage, and cards working side by side. One card and one Plan button, Orchestrate drafting onto the Plan, card runs with test gates and briefs, and plans from a document with major cards split into subtasks when each starts (#155) are built for the next release. [Plan](docs/roadmap-details.md#one-plan) | [#162](https://github.com/AhmedNavaz/codeshi/issues/162) |
| 4 | **One routing policy for the whole task** | A live check of Flow handoffs between real accounts, model ratings backed by measured results and checked against what a task needs (images, context size), and automatic fallback to a local model. Routing now chooses only from a list of rated models instead of guessing from names. Since 0.44.0, retries, Ultra's reviewer, resuming after a reset and Orchestrate steps use the same Smart, Saver or Ultra handoff line as the first assignment and handoffs. [Scope](docs/roadmap-details.md#adaptive-agent-and-model-routing) | [#12](https://github.com/AhmedNavaz/codeshi/issues/12) |
| 5 | **More agents and models** | Grok, DeepSeek, Qwen and free cloud tiers on your own accounts. Claude Code, Codex, Gemini and local Ollama models have shipped | [#4](https://github.com/AhmedNavaz/codeshi/issues/4) |

## Next

| # | Feature | What's left | Issue |
| --- | --- | --- | --- |
| 1 | **Linux builds** | Packaging. The test suite already runs on Linux in CI | [#5](https://github.com/AhmedNavaz/codeshi/issues/5) |
| 2 | **Install with Homebrew** | `brew install --cask codeshi`. Depends on notarized builds (#1) | [#3](https://github.com/AhmedNavaz/codeshi/issues/3) |
| 3 | **Task board and schedules** | Flow choosing cards and dictated cards. The board you run by hand shipped in 0.43.0, a canvas view in 0.45.1, and cards or prompts that run at a set time, labels and due dates are built for the next release. [Plan](docs/roadmap-details.md#task-board-and-schedules) | [#132](https://github.com/AhmedNavaz/codeshi/issues/132) |
| 4 | **Plans** | Comments from agents and guests, and shared links. One set of cards for plans and the board, and plans from a document, are in One Plan (#162). Orchestrate's step plans shipped in 0.37.0, 0.41.0 shows them as a full-window chart with an outline, 0.45.1 adds a canvas to the board, and labels, your own comments on cards, closing the Plan or a card to agents, and attaching the Plan or a card to a message are built for the next release | [#97](https://github.com/AhmedNavaz/codeshi/issues/97) |
| 5 | **Parallel tasks from one request** | A split proposed by the agent, and a measured comparison with one agent working in order. Running an Orchestrate plan as tasks shipped in 0.39.0, and folding a plan's row with its total in 0.45.1. Plan cards that ask before an agent bills by use are built, not released | [#108](https://github.com/AhmedNavaz/codeshi/issues/108) |
| 6 | **Specialist roles** | One round of repair after a review, an independent review of the final result, and a measured comparison with one agent. Roles, artifacts and checks on Orchestrate steps shipped in 0.38.0. Since 0.46.0, a plan's step is tested before later steps build on it, and each step is briefed from what the earlier steps did | [#89](https://github.com/AhmedNavaz/codeshi/issues/89) |
| 7 | **Concurrent tasks, finished** | Local models, Review changes and undo inside a task. A task's copy getting your installed packages shipped in 0.40.0, and tasks and plans in the recap in 0.46.0 | [#88](https://github.com/AhmedNavaz/codeshi/issues/88) |
| 8 | **Codeshi CLI, finished** | Flow routing, workflows, `skills`, `doctor` and a Linux install. An interactive `codeshi` session and script commands shipped in 0.43.0 on macOS and in 0.48.0 on Windows, sharing the window's conversation. [Reference](docs/cli.md) | [#90](https://github.com/AhmedNavaz/codeshi/issues/90) |
| 9 | **Skills through each agent's own skill system** | Claude, Codex and Gemini each load skills their own way, instead of receiving them as instructions. Skill packs, starters and their evaluations shipped in 0.47.0 | [#86](https://github.com/AhmedNavaz/codeshi/issues/86) |

## Later

| Feature | Status | Issue |
| --- | --- | --- |
| Connect GitHub: a read-only sign-in without `gh`, and GitHub Enterprise | **From GitHub** in New workspace, using your `gh` login, shipped in 0.47.0 | [#159](https://github.com/AhmedNavaz/codeshi/issues/159) |
| Move to another computer directly, by pairing the two with a QR code and a six-digit code, without a file. Ongoing sync comes after that. [Plan](docs/roadmap-details.md#connect-github-and-move-to-another-computer) | A backup file locked with a passphrase shipped in 0.47.0 | [#160](https://github.com/AhmedNavaz/codeshi/issues/160) |
| Task-scoped context: a before/after run on a long real task. Live runs on long built conversations found that in a chat of many short messages, the rolling brief can leave out requests the older cut-off kept | First version shipped in 0.26.0, the rolling brief in 0.38.0 | [#85](https://github.com/AhmedNavaz/codeshi/issues/85) |
| Project memory: suggested memories you review before they're saved | First version shipped in 0.26.0, Copy to AGENTS.md in 0.40.0 | [#21](https://github.com/AhmedNavaz/codeshi/issues/21) |
| Interface translations: the first languages, and the remaining panels, phone page and server messages | Base and main surfaces shipped in 0.42.0, help wanted | [#27](https://github.com/AhmedNavaz/codeshi/issues/27) |
| iPhone Live Activities, which need a native app | Remote access shipped in 0.27.0, lock-screen notifications in 0.41.0 and replies read aloud in 0.47.0 | [#23](https://github.com/AhmedNavaz/codeshi/issues/23) |

## Final checks

Built and covered by automated tests. Each issue closes after one try on the real service or device, and a report from your own setup helps.

| Feature | The check | Issue |
| --- | --- | --- |
| **Open pull request** | Opening a pull request on GitHub itself. Shipped in 0.46.0, tested against local repositories and a stand-in for `gh` | [#18](https://github.com/AhmedNavaz/codeshi/issues/18) |
| **Task limits on a paid API account** | A time, token or spend limit on a real pay-per-use account. Everything shipped by 0.38.0 and was tested with simulated providers | [#87](https://github.com/AhmedNavaz/codeshi/issues/87) |
| **Status in the Windows notification area** | The icon, tooltip, click and menu on a real Windows PC. Shipped in 0.42.0. Help wanted | [#74](https://github.com/AhmedNavaz/codeshi/issues/74) |

## Ongoing checks

Testing that doesn't end with one release: it needs repeated runs, many setups and different people, and each new feature adds to it. These run alongside everything else, so they have no place in the order above. Results and traces from your own setup help most here.

| Area | What's being checked | Issue |
| --- | --- | --- |
| **Battery and resource use** | Measuring idle, streaming, Lounge and preview workloads on different Macs and PCs, fixing what the measurements show, and keeping energy budgets as features are added. **Help › Record Performance Trace** (since 0.42.0) measures the installed app, and a trace recorded while Codeshi drains your battery is the most useful report | [#152](https://github.com/AhmedNavaz/codeshi/issues/152) |
| **Evidence that Smart routing helps** | Budgeted live comparisons of Smart against a manually chosen agent, repeated across agents, models and task sizes, and Smart results reports people choose to share (**Share…**, since 0.45.1). No savings are claimed until the evidence passes its gates | [#84](https://github.com/AhmedNavaz/codeshi/issues/84), [#139](https://github.com/AhmedNavaz/codeshi/issues/139) |
| **Accessibility with real screen readers** | VoiceOver and NVDA users trying the whole app, including each new view. Keyboard and screen reader passes shipped in 0.42.0, 0.44.0 and 0.47.0. Help wanted | [#26](https://github.com/AhmedNavaz/codeshi/issues/26) |

## Exploring

Larger ideas that need design work first, so join the issue before building. They continue to use your own agent accounts.

| Idea | Issue |
| --- | --- |
| **Designer module.** Design websites and app screens in Codeshi and guide agents section by section. Design notes in the preview shipped in 0.43.0: mark several parts of a page, with a note on each, sent as one message. A layout canvas and handing design work to team workflows are next. [Plan](docs/roadmap-details.md#designer-module) | [#125](https://github.com/AhmedNavaz/codeshi/issues/125) |
| **Live multiplayer.** Teammates in the same conversation in real time, each on their own subscription. Watching a teammate's conversation read-only, with suggestions, shipped in 0.43.0; steering and running together are next | [#24](https://github.com/AhmedNavaz/codeshi/issues/24) |
| **Race mode.** Two agents take the same task in separate worktrees; keep the better result | [#16](https://github.com/AhmedNavaz/codeshi/issues/16) |
| **Public help requests.** Post a reviewed request, with the agent's history, where anyone can pick it up and send back a fix you review, without access to your repository. Builds on Ask a Friend. [Plan](docs/roadmap-details.md#public-help-requests) | [#158](https://github.com/AhmedNavaz/codeshi/issues/158) |

## Recently shipped

- **0.48.0:** voice input on Windows, the `codeshi` command and CLI tab on Windows, and Google Antigravity setup and status fixes on Windows.
- **0.47.0:** commits in Timeline, opening a GitHub repository as a workspace, a Codeshi backup file for moving computers, alerts set up by moment with Try it, replies read aloud on the phone, and memories that no longer need a recheck after every commit.
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

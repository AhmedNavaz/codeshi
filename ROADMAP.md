# Roadmap

What Codeshi is working on, in priority order. **Now** is the current focus, **Next** follows it, **Later** is further out, and **Exploring** holds larger ideas that need design first. Each table is ordered with the most important item at the top. Priorities can change with feedback, so treat this as a plan rather than a promise.

A core goal is to get more verified work from the agent allowances people already have, without needing a higher subscription tier.

Every item links to its GitHub issue. Comment there to shape it or pick it up, and open an issue before starting new work. What has already shipped is in [shipped features](docs/shipped.md) and the [changelog](CHANGELOG.md); the longer design notes are in [roadmap details](docs/roadmap-details.md); bugs are under the [bug label](https://github.com/AhmedNavaz/codeshi/labels/bug).

## Now

| # | Feature | What's left | Issue |
| --- | --- | --- | --- |
| 1 | **Lower battery and resource use** | Measure idle, streaming, Lounge and preview workloads, fix what the measurements show, and set energy budgets. The Lounge's first mitigation shipped in 0.38.0, and 0.40.0 draws weather at most 30 times a second, paces games at 60 Hz speed and runs the setup glow once. Idle, streaming and preview workloads are not measured yet | [#152](https://github.com/AhmedNavaz/codeshi/issues/152) |
| 2 | **Onboarding redesign** | Workspace-first setup and the Normal or Flow choice shipped in 0.39.0. Left: a keyboard and screen-reader pass over the new steps. [Scope](docs/roadmap-details.md#onboarding-and-execution-mode-selection) | [#129](https://github.com/AhmedNavaz/codeshi/issues/129) |
| 3 | **Interface polish** | The near-black Dark theme, the text scale and two-line workspace rows shipped in 0.39.0. Left: contrast checks for every badge state in each theme. [Scope](docs/roadmap-details.md#interface-polish-typography-scale-and-settings-structure) | [#127](https://github.com/AhmedNavaz/codeshi/issues/127) |
| 4 | **Settings in clear categories** | A page for each subject and three button heights shipped in 0.39.0. Left: one header and footer layout for every dialog | [#130](https://github.com/AhmedNavaz/codeshi/issues/130) |
| 5 | **Notarized macOS builds** | Downloads that open without a security prompt, with notification banners. Waiting on an Apple Developer account | [#1](https://github.com/AhmedNavaz/codeshi/issues/1) |
| 6 | **One routing policy for the whole task** | Handoffs, retries and reviewers choose model and effort by the same Smart, Saver or Ultra policy as the first assignment, using verified model capabilities. [Scope](docs/roadmap-details.md#adaptive-agent-and-model-routing) | [#12](https://github.com/AhmedNavaz/codeshi/issues/12) |
| 7 | **Evidence that routing and context changes help** | Budgeted live comparisons against a manually chosen agent, and long real tasks measured before and after. No savings are claimed until then | [#84](https://github.com/AhmedNavaz/codeshi/issues/84), [#139](https://github.com/AhmedNavaz/codeshi/issues/139), [#85](https://github.com/AhmedNavaz/codeshi/issues/85) |

## Next

| # | Feature | What's left | Issue |
| --- | --- | --- | --- |
| 1 | **Flow manages a whole outcome** | Flow runs a bounded outcome under the backend task policy, with takeover, recovery and end-to-end tests. The focused view, cards and project review have shipped. [Agreed split](docs/roadmap-details.md#normal-and-flow-the-agreed-execution-split) | [#107](https://github.com/AhmedNavaz/codeshi/issues/107) |
| 2 | **More agents and models** | Grok, DeepSeek, Qwen and free cloud tiers on your own accounts. Gemini and local Ollama models have shipped | [#4](https://github.com/AhmedNavaz/codeshi/issues/4) |
| 3 | **Plans** | Visual cards on a canvas, drafted from a goal or an uploaded project document, then edited, assigned and run. Orchestrate's step plans shipped in 0.37.0 | [#97](https://github.com/AhmedNavaz/codeshi/issues/97) |
| 4 | **Parallel tasks from one request** | A split proposed by the agent, a total for the group, and a measured comparison with one agent working in order. Running an Orchestrate plan as tasks shipped in 0.39.0 | [#108](https://github.com/AhmedNavaz/codeshi/issues/108) |
| 5 | **Specialist roles** | Role-specific briefs and a gated integration step applied to runs. Roles, artifacts and checks on Orchestrate steps shipped in 0.38.0 | [#89](https://github.com/AhmedNavaz/codeshi/issues/89) |
| 6 | **GitHub in the conversation** | Open a pull request from the conversation. Issues, pull requests and failing checks as context shipped in 0.39.0. [Scope](docs/roadmap-details.md#everything-in-the-thread) | [#18](https://github.com/AhmedNavaz/codeshi/issues/18) |
| 7 | **Concurrent tasks, finished** | Tasks in the recap, with local models, reviews and undo; shared files, imports, patches and restores that cannot race. A task's copy getting your installed packages shipped in 0.40.0 | [#88](https://github.com/AhmedNavaz/codeshi/issues/88) |
| 8 | **Skills through each agent's own skill system** | The same skill on at least two agents, including after a handoff, with usage measured with and without it | [#86](https://github.com/AhmedNavaz/codeshi/issues/86) |
| 9 | **Task limits checked on a paid API account** | Everything else has shipped; it has only been tested with simulated providers | [#87](https://github.com/AhmedNavaz/codeshi/issues/87) |
| 10 | **Install with Homebrew** | `brew install --cask codeshi`. Depends on notarized builds (#1) | [#3](https://github.com/AhmedNavaz/codeshi/issues/3) |
| 11 | **Linux builds** | Packaging. The test suite already runs on Linux in CI | [#5](https://github.com/AhmedNavaz/codeshi/issues/5) |

## Later

| Feature | Status | Issue |
| --- | --- | --- |
| Hands-free voice conversations: conversation mode with "send" by voice, shipped in Flow on macOS in 0.40.0. Left: answering approvals by voice, other platforms | First version shipped in 0.40.0 | [#72](https://github.com/AhmedNavaz/codeshi/issues/72) |
| Project memory: a recheck when a branch or dependency changes, and reviewed suggestions. Copy to AGENTS.md shipped in 0.40.0 | First version shipped in 0.26.0 | [#21](https://github.com/AhmedNavaz/codeshi/issues/21) |
| Rewind stage 3: commits on the Timeline and optional conversation rewind | Stages 1 and 2 shipped in 0.20.0 and 0.28.0 | [#20](https://github.com/AhmedNavaz/codeshi/issues/20) |
| Phone lock-screen notifications and iPhone Live Activities | Remote access shipped in 0.27.0 | [#23](https://github.com/AhmedNavaz/codeshi/issues/23) |
| Suggest the right feature at the right moment, from local rules | Planned | [#106](https://github.com/AhmedNavaz/codeshi/issues/106) |
| Voice input on Windows | Help wanted | [#73](https://github.com/AhmedNavaz/codeshi/issues/73) |
| Status in the Windows notification area | Help wanted | [#74](https://github.com/AhmedNavaz/codeshi/issues/74) |
| Accessibility pass for keyboard navigation and screen readers | Help wanted | [#26](https://github.com/AhmedNavaz/codeshi/issues/26) |
| Interface translations | Help wanted | [#27](https://github.com/AhmedNavaz/codeshi/issues/27) |
| Live progress in a compact pill near the top of the screen | Needs design | [#75](https://github.com/AhmedNavaz/codeshi/issues/75) |
| Binary files in Ask a Friend patches | Planned | [#25](https://github.com/AhmedNavaz/codeshi/issues/25) |
| Run the project's own tests on a returned patch, with approval | On hold until Ask a Friend sees more use | [#10](https://github.com/AhmedNavaz/codeshi/issues/10) |

## Exploring

Larger ideas that need design work first, so join the issue before building. They continue to use your own agent accounts.

| Idea | Issue |
| --- | --- |
| **Task board and schedules.** A board per project, and cards or prompts that run at a set time. [Plan](docs/roadmap-details.md#task-board-and-schedules) | [#132](https://github.com/AhmedNavaz/codeshi/issues/132) |
| **Codeshi CLI.** Run, inspect, stop and continue the same workflows from a terminal, on the same engine as the desktop app | [#90](https://github.com/AhmedNavaz/codeshi/issues/90) |
| **Designer module.** Design websites and app screens in Codeshi and guide agents section by section | [#125](https://github.com/AhmedNavaz/codeshi/issues/125) |
| **Race mode.** Two agents take the same task in separate worktrees; keep the better result | [#16](https://github.com/AhmedNavaz/codeshi/issues/16) |
| **Live multiplayer.** Teammates in the same conversation in real time, each on their own subscription | [#24](https://github.com/AhmedNavaz/codeshi/issues/24) |

## Recently shipped

- **0.40.0:** hands-free voice conversations in Flow, selected terminal output added to your message, Remote access on the Home Screen, Copy to AGENTS.md for project memory, a Lounge that fills the window with rain and snow sounds, and installed packages in a task's own copy.
- **0.39.0:** GitHub issues and pull requests in your message, Orchestrate plans run as tasks, a near-black Dark theme and text size, workspace-first setup, and Settings with a page for each subject.
- **0.38.0:** Smart results, the Lounge, a preview window per interface, roles on Orchestrate steps, long conversations folded into the brief, and allowance that is about to reset.
- **0.37.0:** Orchestrate plans in Flow and Normal, inline image previews, the preview window's Stack and API inspector, and fallback to another agent near a limit.

The full list is in [shipped features](docs/shipped.md).

## Good places to start

- Use Codeshi on a real project and tell us what you find, from bugs to design details: [report a bug](https://github.com/AhmedNavaz/codeshi/issues/new?template=bug_report.yml) or [share design feedback](https://github.com/AhmedNavaz/codeshi/issues/new?template=ux_feedback.yml).
- Issues labelled [good first issue](https://github.com/AhmedNavaz/codeshi/labels/good%20first%20issue) or [help wanted](https://github.com/AhmedNavaz/codeshi/labels/help%20wanted).
- Small interface polish and clearer documentation in the [guide](docs/guide.md).

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and a map of the codebase.

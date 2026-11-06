# Contributing to Codeshi

Thanks for helping. Bug reports, fixes and focused improvements are all welcome.

## Where to start

- Check the [roadmap](ROADMAP.md) for planned work, and issues labelled [good first issue](https://github.com/AhmedNavaz/codeshi/labels/good%20first%20issue) or [help wanted](https://github.com/AhmedNavaz/codeshi/labels/help%20wanted).
- For anything bigger than a bug fix, open an issue first so we can agree on the approach before you write code.
- When a feature ships in stages, the remaining work stays in open issues, linked from the issue that shipped and listed on the roadmap. Closed issues don't hold planned work.
- The [guide](docs/guide.md) describes how each feature behaves, which is useful context before changing it.

## Set up

You need Node.js 22.12 or later. Claude Code, the Codex CLI or the Google connection (**Settings › Install Google connection**) are only needed to try real runs; the tests use stand-ins, so they run with no agents installed.

Codeshi is built for macOS and Windows. The tests run on macOS, Windows and Linux, but there's no Linux build of the app yet, so expect rough edges there; [#5](https://github.com/AhmedNavaz/codeshi/issues/5) tracks that, and help is welcome.

```sh
npm ci
npm start        # desktop app
npm run start:fresh # replay onboarding with a temporary profile
npm run start:update-demo # try the update button: a pretend update, nothing downloaded or replaced
npm run web      # browser-only session on http://127.0.0.1:4318
```

`npm start` opens **Codeshi Dev**, a separate app from an installed release: it keeps its own workspaces and conversations in `~/Library/Application Support/Codeshi Dev` (or `Throughline Dev`, if you ran it before the rename), so both can run side by side, and you can work on Codeshi from the installed app while testing your changes in the dev one. A **Dev** label next to the name tells them apart. To open your real data from source instead, quit the installed app and run `AI_RELAY_DESKTOP_DATA="$HOME/Library/Application Support/Codeshi" npm start`, with `Throughline` in place of `Codeshi` if you installed it before the rename.

## Project map

The app is plain JavaScript with no build step: a local Node.js server, an Electron shell and a static web interface.

The [architecture guide](docs/architecture.md) explains service boundaries, data flow, persistence and where new features belong.

Backend code lives in `src/`; Electron, browser UI and the separately deployable sharing service have their own directories. Use the npm commands above from the project root. To pass browser-server options, use `npm run web -- --workspace /absolute/project/path --port 4318`.

| Path | What it does |
| --- | --- |
| `src/server.mjs` | Local HTTP server bound to 127.0.0.1, with host, origin and token checks |
| `src/projects.mjs` | Workspace registry: folders and each workspace's single conversation |
| `src/broker.mjs`, `src/context.mjs` | Conversation journal, runs, and the shared context handed to each agent |
| `src/checkpoints.mjs` | Run checkpoints (#20): folders saved before and after each run, and undo and redo |
| `src/agent-questions.mjs` | Questions an agent asks with options (Claude's AskUserQuestion, Codex's request_user_input): one shape, answer checks, and the answers in each agent's own format |
| `src/gemini.mjs`, `src/providers.mjs`, `src/provider-worker.mjs` | Claude Agent SDK, Codex app-server and Gemini ACP adapters, accounts and plan usage; runs happen in a worker process |
| `src/local-models.mjs` | Ollama local-model discovery, validation and scoped Codex tool-harness launch routes |
| `src/resolve-binary.mjs` | Finds the installed `claude`, `codex` and `gemini` executables |
| `src/conversation-routes.mjs`, `src/conversation-import.mjs`, `src/conversation-export.mjs` | Previous-chat discovery, reviewed imports and conversation files for other users |
| `src/task-context.mjs` | The brief a fresh agent gets for a task: its folders, instructions, changed files and what went wrong |
| `src/task-coordinator.mjs`, `src/task-isolation.mjs` | Tasks side by side: each in a lane with its own broker, how each may run, and merging a worktree back |
| `src/task-plan.mjs` | A task's plan across its agents: what is carried, how the next agent's report replaces it, and what the brief says |
| `src/project-memory.mjs` | What is kept for every agent in a workspace: entries, what is relevant to a task, and rule-based suggestions |
| `src/skills.mjs`, `starter-skills/` | The skill catalog: finding, checking, private copies and what a task is told, plus the optional starters |
| `src/task-budget.mjs` | Limits for a whole task, checked before every run and worked out from the journal |
| `src/task-ledger.mjs`, `evals/` | What tasks used, worked out from the journal, and repeatable evaluations with hidden checks |
| `src/collaboration*.mjs`, `src/patches.mjs`, `src/sharing-client.mjs` | Ask a Friend: approved packages, returned patches and the private-link client |
| `src/workspace-*.mjs`, `src/file-explorer.mjs`, `src/mutation-lock.mjs` | Safe file access, Git activity, snapshots and locks that prevent conflicting edits |
| `public/` | Interface: `app.js` (core), `insights.js` (models, progress, Git and usage), `conversation-history.js` (import and export), `conversation-search.js` (find in the conversation), `files.js`, `setup.js`, `settings.js` (searchable app settings), `workbench.js` (the separate Ask a Friend dialog) and the CSS |
| `desktop/` | Electron main process, preload bridge, packaging and icon generation (the logo itself is drawn in `brand.mjs`; `npm run icons` writes every icon from it) |
| `sharing/` | The self-hostable private-link service and its container image |
| `test/` | Node test runner suites; the interface tests use a small fake DOM |
| `assets/`, `output/` | Shipped branding assets (generated by `npm run icons`; `assets/brand/` holds both looks of the icon at every size), and disposable generated assets excluded from Git and desktop packages |

## Before you open a pull request

```sh
npm test
npm run test:desktop
```

- Keep changes focused, and add or update tests for behavior you change.
- Tests must never call a real model or touch your saved history.
- Match the surrounding style: plain JavaScript ES modules, no build step and no new runtime dependencies without discussion.
- The interface must work under the server's Content Security Policy: no inline scripts or `style` attributes, and no `innerHTML` for provider or user content. Build DOM nodes instead.
- Colors, sizes and icons come from the tokens in `public/editor-theme.css`; please don't hard-code colors in components.
- App settings belong on General, Accounts, Alerts or Voice in `public/settings.js`; use its shared group/row kit when a feature supplies its own controls. Keep workspace-specific choices in their workspace controls and Ask a Friend actions in its separate dialog.
- Some identifiers still use the project's former names, AI Relay and Throughline: `ai-relay.*` file formats, the `X-AI-Relay` header and `AI_RELAY_*` variables; the app's bundle ID `local.throughline.desktop` and the speech helper's `local.throughline.speech`; `throughline:` keys in the page's storage; the `Throughline` and `AI Relay` data folders; and the `throughline-sharing` container image. Installed copies, saved data and exported files depend on them, so they are kept on purpose; don't rename them without a migration. The repository is now `AhmedNavaz/codeshi`; keep the old `AhmedNavaz/throughline` name unused so GitHub can redirect old links.

## Reporting bugs

Use the [bug report](https://github.com/AhmedNavaz/codeshi/issues/new?template=bug_report.yml) form, or [design feedback](https://github.com/AhmedNavaz/codeshi/issues/new?template=ux_feedback.yml) for anything confusing or rough in the interface. Include your Codeshi version, your system (macOS or Windows) and its version, the agent you used and the steps to reproduce. Please remove anything private from logs and screenshots. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Releasing

Maintainers: `npm run stats` shows downloads by release and platform and repository traffic, from what GitHub already records; the app reports nothing. To release, bump `version` in `package.json`, add a section to [CHANGELOG.md](CHANGELOG.md) and push a matching tag such as `v0.4.1`. GitHub Actions tests and builds both macOS apps and the Windows app, publishes the private-link service image and creates the release.

Before tagging, compare the README and website with the release's user-facing features. Update their descriptions and refresh images when the interface changes; move shipped features out of their planned lists while keeping unfinished work clearly marked. The README should explain the current release without requiring a visit to the website.

The in-app **What’s New** panel reads versioned entries from the bundled changelog. Move completed **Unreleased** entries into the matching release section before packaging; unreleased and newer-version entries are excluded from the panel.

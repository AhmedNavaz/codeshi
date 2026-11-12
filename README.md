<h1 align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/icon-dark.svg"><img src="assets/icon.svg" width="96" align="top" alt=""></picture><br>Codeshi</h1>

<p align="center"><b>Claude Code, Codex, Gemini and local models in one unified conversation.</b><br>
Automatic limit handoffs, parallel task worktrees, phone remote access, and adaptive model routing — on the plans you already pay for.</p>

<p align="center"><a href="#install"><b>Install</b></a> &nbsp;·&nbsp; <a href="#run-from-source"><b>Run from source</b></a> &nbsp;·&nbsp; <a href="https://codeshi.dev"><b>Website & Demos</b></a> &nbsp;·&nbsp; <a href="docs/architecture.md"><b>Architecture</b></a> &nbsp;·&nbsp; <a href="docs/guide.md"><b>User Guide</b></a> &nbsp;·&nbsp; <a href="CONTRIBUTING.md"><b>Contribute</b></a></p>

<p align="center"><a href="https://github.com/AhmedNavaz/codeshi/releases/latest"><img src="https://img.shields.io/github/v/release/AhmedNavaz/codeshi?label=release" alt="Latest release"></a> <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Runs on macOS and Windows"> <a href="https://github.com/AhmedNavaz/codeshi/actions/workflows/ci.yml"><img src="https://github.com/AhmedNavaz/codeshi/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a> <a href="https://www.patreon.com/17048317/join"><img src="https://img.shields.io/badge/Support-Patreon-FF424D?logo=patreon&amp;logoColor=white" alt="Support Codeshi on Patreon"></a></p>

<p align="center"><a href="https://codeshi.dev"><img src="docs/hero.jpg" width="900" alt="Codeshi desktop application with multi-agent workspace chat, active tasks, and agent routing"></a><br><a href="https://codeshi.dev">👉 See interactive walkthroughs, screenshots, and live demos at <b>codeshi.dev</b> →</a></p>

---

## What is Codeshi?

Every coding agent eventually hits a rate or usage limit, and switching tools usually means starting from scratch and re-explaining your project. 

**Codeshi is a free, open-source local orchestration engine and desktop app** for macOS and Windows. It provides a permanent shared conversation and execution environment across the official **Claude Code**, **Codex**, and **Gemini** CLIs, as well as local **Ollama** models:
- **Zero API markup**: Runs directly against your existing personal or subscription logins (Claude Code, ChatGPT/Codex, Gemini/Google). No middleman API keys required.
- **Local first**: Runs on your machine, reads your local folders, and stores your transcripts locally.
- **Multi-agent resilience**: Claude starts a refactor, Codex takes over when Claude hits quota, and local Ollama finishes the review when both run out.

---

## The Engine Under the Hood

Codeshi is not just a UI wrapper—it is an orchestration runtime built to solve the real hurdles of multi-agent development:

- **Unified Agent Protocol (`src/providers.mjs`)**: Normalizes disparate agent protocols (Claude Agent SDK, Codex app-server JSON-RPC, Gemini/Antigravity ACP, and local Ollama) into a single event bus for streaming tool calls, approvals, terminal outputs, and diffs.
- **Lossless Context Rollover (`src/task-context.mjs`)**: When switching agents or refreshing context, Codeshi synthesizes active file diffs, prompt queues, user decisions, and unblocked tasks into a bounded brief, preventing context amnesia and runaway token waste.
- **Shadow Git Checkpoints & Mutation Leases (`src/checkpoints.mjs`, `src/mutation-lock.mjs`)**: Every run operates under filesystem leases. Snapshot checkpoints before and after every run provide instant rollback, conflict prevention, and safe concurrent Git worktrees.
- **Smart Spendability Routing (`src/routing-assessment.mjs`)**: Automatically routes prompts across model tiers (**Saver**, **Smart**, **Ultra**) based on prompt complexity heuristics, file scope, and live quota spendability.
- **Autonomous Verification Loops (`src/run-checks.mjs`, `src/agent-review.mjs`)**: Runs automated test suites and independent cross-agent reviews (e.g. Codex reviewing Claude's changes read-only) before reporting a task complete.

> 📖 **Deep Dive**: See the full design and Mermaid pipeline in the [Engine Architecture Guide](docs/architecture.md).

---

## Quickstart

### Install Pre-built App

**macOS** (Apple Silicon or Intel), in Terminal:
```sh
curl -fsSL https://raw.githubusercontent.com/AhmedNavaz/codeshi/main/install.sh | sh
```

**Windows** (64-bit), in PowerShell:
```powershell
irm https://raw.githubusercontent.com/AhmedNavaz/codeshi/main/install.ps1 | iex
```

*Or download the latest zipped releases directly from [Releases](https://github.com/AhmedNavaz/codeshi/releases/latest).*

### Run from Source

Codeshi has **zero build steps** (vanilla ES modules). All you need is **Node.js 22.12+**:

```sh
git clone https://github.com/AhmedNavaz/codeshi.git
cd codeshi
npm ci
npm start        # Launches desktop app in isolated Dev profile
```

*For browser-only mode without Electron: `npm run web` (available at `http://127.0.0.1:4318`).*

Connect at least one agent: sign in to [Claude Code](https://code.claude.com/docs/en/overview) or the [Codex CLI](https://github.com/openai/codex). For Gemini, choose **Settings › Install Google connection** to pair with Antigravity ACP. For local models, install [Ollama](https://ollama.com/download) and run any tool-capable model.

---

## Core Capabilities

| Capability | How it works | Details |
| :--- | :--- | :--- |
| **Seamless Limit Handoffs** | Tracks 5-hour and weekly usage allowances. When an agent nears its limit, it transitions the task to another agent with full brief context without repeating prompts. | [Guide: Switching & Usage](docs/guide.md#workspaces-accounts-and-switching) |
| **Parallel Task Worktrees** | Run multiple tasks side by side. Tasks sharing the same Git repository get isolated temporary worktrees with collision detection and visual diff merging. | [Guide: Parallel Tasks](docs/guide.md#models-runs-git-and-usage) |
| **Encrypted Remote Mobile Access** | Scan a QR code from your phone to follow live runs, approve commands, and dictate prompts via WebRTC/relay without opening firewall ports. | [Guide: Remote Access](docs/guide.md#private-link-service) |
| **Flow Mode & Routing** | Adaptive tier selection (**Saver**, **Smart**, **Ultra**). Automatically provisions light models for quick typos or top-tier models with mandatory review passes for complex refactors. **Smart results** shows what each mode used and how many tasks your tests verified, compared with your manual tasks once there is enough evidence. A **Lounge** offers built-in games while agents work. | [Guide: Flow & Routing](docs/guide.md#models-runs-git-and-usage) |
| **Interactive Approvals** | Granular permission gates for edits, terminal commands, and network access with "Allow for this run" or "Always allow in workspace". | [Guide: Approvals](docs/guide.md#permission-controls-and-tool-approvals) |
| **Cross-Agent Code Review** | Request a secondary read-only opinion from another provider before merging changes back to your branch. | [Guide: Cross-Agent Review](docs/guide.md#cross-agent-review) |
| **Offline Local Models** | Run downloaded Ollama models through Codex's tool harness when completely offline or conserving allowances. | [Guide: Local Models](docs/guide.md#local-models) |

*Full feature documentation, keyboard shortcuts, and configurations are detailed in the [Codeshi User Guide](docs/guide.md).*

---

## Roadmap

| Feature | Description | Status |
| :--- | :--- | :--- |
| **Rewind Timeline** | Checkpoint commits in timeline with conversational rewind | Planned ([#20](https://github.com/AhmedNavaz/codeshi/issues/20)) |
| **Issue & PR Thread Context** | Pull GitHub issues/PRs directly into context, push PRs from conversation | Planned ([#18](https://github.com/AhmedNavaz/codeshi/issues/18)) |
| **More Providers** | DeepSeek, Grok, Qwen, and custom OpenAI-compatible endpoints | In progress ([#4](https://github.com/AhmedNavaz/codeshi/issues/4)) |
| **Linux Support** | Native Linux packages alongside macOS and Windows | Help wanted ([#5](https://github.com/AhmedNavaz/codeshi/issues/5)) |
| **Mobile Push Notifications** | Native lock-screen alerts for approval requests | Exploring ([#23](https://github.com/AhmedNavaz/codeshi/issues/23)) |

See the complete history and future milestones in [ROADMAP.md](ROADMAP.md).

---

## Contributing

We love contributions! Codeshi is built in the open with plain JavaScript, Node.js, and standard web technologies—no bundlers or transpilation required.

1. **Find an issue**: Check out issues labelled [`good first issue`](https://github.com/AhmedNavaz/codeshi/labels/good%20first%20issue) or [`help wanted`](https://github.com/AhmedNavaz/codeshi/labels/help%20wanted).
2. **Read the codebase map**: Browse [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md) for module mappings.
3. **Run the test suite**:
   ```sh
   npm test
   ```

*Security disclosures: Please report vulnerabilities privately according to [SECURITY.md](SECURITY.md).*

---

## License

[MIT License](LICENSE) · Built independently. Not affiliated with or endorsed by Anthropic, OpenAI, or Google.

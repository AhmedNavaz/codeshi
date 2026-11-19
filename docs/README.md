# Codeshi documentation

Documentation for using Codeshi, understanding how it works locally, and planning future work.

## Using Codeshi

- [User guide](guide.md) — workspaces, modes (**Normal**, **Flow**, and **Plan**), agent handoffs, permissions, approvals, remote phone access, Activity, checkpoints, Git, and troubleshooting.
- [CLI reference](cli.md) — interactive `codeshi` terminal sessions, scripting commands (`run`, `status`, `wait`, `stop`, `continue`, `tasks`), and JSON output.
- [Shipped features](shipped.md) — index of every shipped capability linked to its release tag and issue.

## Architecture and contracts

- [Architecture](architecture.md) — local server, provider adapters, context rollover, checkpoints, mutation leases, routing, and directory layout.
- [Task execution policy](execution-policy.md) — Normal vs. Flow authority, revisions, manual takeover, and API contract.

## Design specs and planning proposals

These documents hold background design exploration and planned work, not guarantees of current app behavior. See the top-level [Roadmap](../ROADMAP.md) for current priorities.

- [Roadmap details](roadmap-details.md) — detailed plans behind items on [ROADMAP.md](../ROADMAP.md) (One Plan, Flow, routing, task board, schedules, designer).
- [Core roadmap](core-roadmap.md) — deeper technical specifications for orchestration, routing evaluations, shared budgets, and isolation.
- [Multiple provider accounts](provider-accounts.md) — proposal for account profiles, quota-aware continuation, and account isolation ([#186](https://github.com/AhmedNavaz/codeshi/issues/186)).

# Evaluations

Small repeatable tasks for finding out whether a change to Codeshi helps, before anyone claims that it does. Each fixture is a pinned repository, a request and a check the agent never sees, because its files are only written after the agent has finished.

| Fixture | What it exercises |
| --- | --- |
| `small-edit` | One change in one file |
| `cross-folder` | One change across two folders |
| `bug-repair` | Repairing a failing test without changing it |
| `quota-handoff` | A first agent stopped at its first edit, then a second continuing, as at a handoff |
| `context-heavy` | Continuing after a long history that includes another folder's work, with facts that must survive |
| `memory-reuse` | Following a saved convention that nothing in the code shows, with an unrelated entry that must stay out |
| `skill-procedure` | Following a procedure only an enabled skill describes |
| `skill-handoff` | The same, with a second agent finishing what the first one started |
| `review` | A read-only review that has to find a seeded bug |

## Running

Recorded runs replay a saved trace through the real broker. They need no account and spend nothing, and they are what CI runs:

```sh
npm run eval -- run --agent codex --context task,recency
```

Live runs use your own agents and allowance, so they only start with `--live` and a budget, and they stop when it is spent:

```sh
npm run eval -- run --live --agent claude:haiku --context task,recency --repeat 3 --max-runs 40 --max-tokens 2000000
npm run eval -- run --live --agent claude:haiku --to codex::low --fixture quota-handoff --max-runs 2
```

`--no-skills` leaves a fixture's own skill out, for comparing with and without it. `--skill test-authoring` enables a starter skill and asks for it in the prompt. `--limits '{"maxTokens":5000}'` sets task limits for the run.

An agent is written `provider:model:effort`, and any part after the provider can be left out. `--context` compares `task`, the current selection, with `recency`, the older one. A run on another billing basis than a subscription fails rather than spending money.

```sh
npm run eval -- report    # compares everything saved
npm run eval -- list
npm run eval -- delete all
```

Results are local files in `evals/results/` (`CODESHI_EVAL_RESULTS` moves them), readable only by you and ignored by Git. They hold counts, times and identities, with no prompts, and nothing is sent anywhere. Each records the fixture's commit and hash, the settings, the models that really ran and the check.

### Repeating a pinned experiment

New results include an `experiment` fingerprint covering the repository snapshots, policy, every enabled skill's version and resource-file hashes (including starters), hidden check files and reply-match flags, recorded trace, per-run time limit, engine source and dependency lockfile, Node version and operating system/architecture. Skill instructions and resource contents are not copied into results. `sourceCommit` identifies the Codeshi checkout; the engine hash also detects uncommitted code changes.

Repeat a result using its saved fixture and policy:

```sh
npm run eval -- run --pin <saved-result.json> --repeat 3
# A live result still needs explicit consent and a fresh budget:
npm run eval -- run --pin <saved-live-result.json> --live --max-runs 6 --max-tokens 2000000
```

Pass a result's path or its filename from the results directory. Policy overrides are refused. If any pinned input changed, the run fails before starting an agent or reading account quota, names the changed inputs, and exits with status 1. Restore the original code, skills and runtime before trying again. Pins verify versions; they do not archive or automatically restore them. Older results without pins cannot be repeated this way.

The provider-reported model and effort are checked after execution too. A changed model alias is marked as a failed repeat, while keeping its measured usage and check outcome. Use explicit model and effort settings for live comparisons; an omitted setting uses the provider's default. Providers can change a model behind an unchanged name, and this cannot make their output deterministic or pin their hosted service. A run with unreported model identity stays separate in reports. A live repeat can spend its new budget even if model drift is only discovered at the end.

## Reading the results

- **Unknown is not zero.** An agent that doesn't report a value shows as `unknown`, and totals only cover the runs that reported. **Runs without usage** says how many didn't.
- **Partial counts.** Claude only sums up a run at its end, so a stopped run is counted from its messages and marked `partial`.
- **Tokens are not a price.** A dollar figure from an agent is kept with its basis, and on a subscription it isn't a charge. Nothing here converts tokens to money.
- **Usage limit readings are separate.** They are account-wide and other tools count toward them, so they are never attributed to a task.
- **`rubric`** in each result says what a person should judge that a check can't. Its `verdict` starts empty.

Run enough repeats to see the spread: agents vary from run to run. Don't advertise a saving or a quality gain from a few runs.

Reports pool repeats only when experiment inputs, live/recorded mode and reported model/effort sequences match. Each row shows its experiment ID and actual models. Changed fixtures, skill resources, checks or engine versions stay separate; legacy results without pins remain readable but are not pooled. **Work (ms)** adds agent working intervals. **Wall (ms)** includes setup, quota observations, checks and cleanup as well, so evaluation overhead stays visible. Neither recorded-provider timings nor token counts are evidence of a live efficiency gain.

Reviewers already count in the task ledger. Planning, summaries and retrieval currently use local rules, not model calls; delegated model workers remain planned. When those calls are introduced, they must carry task identities and join the same totals before this suite can claim to measure their overhead. Broader routing cases from the roadmap (stale quota, unsuitable models and concurrent account usage) and longer live comparisons are still outstanding.

## Measured so far

From November 2026, with `claude:haiku`, `context-heavy`, two runs each. It is too few runs to generalize, and shows the direction only.

| Context | Verified | Tokens read from cache | Output tokens | Time | Unrelated steps in the prompt |
| --- | --- | --- | --- | --- | --- |
| `recency` | 2 of 2 | 44,485 and 64,850 | 1,867 and 2,217 | 14.0 s and 16.6 s | 36 |
| `task` | 2 of 2 | 24,100 and 24,246 | 1,127 and 1,271 | 11.1 s and 11.7 s | 0 |

And `memory-reuse`, one run each with `claude:haiku`, a convention nothing in the code shows. Saved project memory only reaches agents under `task`.

| Context | Verified | Asked a question | Tokens read from cache | Output tokens | Time |
| --- | --- | --- | --- | --- | --- |
| `recency`, no memory | No | Yes | 39,599 | 2,018 | 17.2 s |
| `task`, with memory | Yes | No | 22,235 | 775 | 11.4 s |

`codex::low` with memory also passed, one run. This fixture is built to show the effect: it says memory reaches the agent and is followed, not how often memory helps on real work.

And skills, one run each with `claude:haiku`:

| Fixture and setting | Verified | Tokens read from cache | Output tokens | Time |
| --- | --- | --- | --- | --- |
| `skill-procedure`, skill on | Yes | 22,967 | 815 | 8.9 s |
| `skill-procedure`, skill off | No | 57,481 | 2,247 | 31.3 s |
| `bug-repair`, `test-authoring` starter on | Yes | 43,310 | 2,074 | 13.0 s |
| `bug-repair`, no skill | Yes | 31,033 | 1,287 | 9.2 s |

A skill clearly helps when it holds something the agent can't otherwise know. A general procedure on a task that doesn't need it costs more, with no gain in this run. The other starter skills have not been measured.

Not measured yet: long real tasks, whether smaller prompts lead to more re-reading on them, and other agents on this comparison. The fixtures are small enough that **Repeat reads** barely moves.

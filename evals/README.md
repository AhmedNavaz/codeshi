# Evaluations

Small repeatable tasks for finding out whether a change to Codeshi helps, before anyone claims that it does. Each fixture is a pinned repository, a request and a check the agent never sees, because its files are only written after the agent has finished.

| Fixture | What it exercises |
| --- | --- |
| `small-edit` | One change in one file |
| `routing-assessment` | The same repository and checks as `small-edit`, with a real routing assessor before the builder |
| `cross-folder` | One change across two folders |
| `bug-repair` | Repairing a failing test without changing it |
| `quota-handoff` | A first agent stopped at its first edit, then a second continuing, as at a handoff |
| `context-heavy` | Continuing after a long history that includes another folder's work, with facts that must survive |
| `memory-reuse` | Following a saved convention that nothing in the code shows, with an unrelated entry that must stay out |
| `skill-procedure` | Following a procedure only an enabled skill describes |
| `skill-handoff` | The same, with a second agent finishing what the first one started |
| `long-thread` | Shop decisions carried through unrelated folder work and a return to the shop, across three real broker turns |
| `long-chat` | Formats agreed 17 exchanges back in a chat of long replies: past the old cut-off, within the rolling brief |
| `long-chat-short` | The same formats 31 exchanges back in a chat of short replies: within the old cut-off, and within the rolling brief since it is bounded by size |
| `long-task` | Six turns building a notes library after a long chat: two formats agreed early, a correction, a detour into another folder, then work that needs all of it |
| `review` | A read-only review that has to find a seeded bug |

One task per starter skill, for running with and without it. Each is an ordinary request that leaves out the point its starter covers. They were written knowing the starters, so they show whether a procedure is followed where it matters, not how often real work needs it.

| Fixture | Starter | What the hidden check looks for |
| --- | --- | --- |
| `view-states` | `frontend-implementation` | A new view that, like its neighbours, handles loading, error and no data, and escapes names |
| `api-endpoint` | `api-contracts` | A new endpoint that only lets the user or an admin call it, refuses bad input in the project's error shape and leaks nothing |
| `data-migration` | `database-migration-planning` | A migration that works on a table that already has rows, and whose undo removes only what it added |
| `accessible-toolbar` | `accessibility` | A labelled search field, a × that is a named button, and a result count that is announced |
| `review-intent` | `independent-review` | A read-only review that finds both seeded defects: a use that is never recorded, and a case-sensitive check |
| `test-writing` | `test-authoring` | Tests that pass on the real code and fail on each of four realistic slips |

A failed check lists which of its parts failed, by the check's own names. It never stores the agent's code or reply.

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

### Long conversations and separate task threads

The `long-thread` workload begins with 200 recorded tool-log entries, then runs three successive requests on the same pinned two-folder repository. Its final hidden checks verify earlier currency and precision decisions, the agreed receipt separator, and the other folder's work. The human rubric also checks that the unresolved tax decision remains unresolved.

```sh
# Same agent, native resume versus a separate conversation per task (offline):
npm run eval -- run --fixture long-thread --agent codex --threads continuous,separate --repeat 3
# Repeated provider switches, including switching back (offline):
npm run eval -- run --fixture long-thread --agent codex --to claude --repeat 3
# Live comparisons are a separate, explicit use of the owner's accounts:
npm run eval -- run --live --fixture long-thread --agent codex::low --threads continuous,separate --repeat 3 --max-runs 18 --max-tokens 2000000
```

`--threads fresh` keeps one conversation but starts every turn after the first in a new session, as after a handoff or a context refresh. Each turn is then built from the journal by the `--context` setting, so this is the mode that compares context settings across a whole task, with repeated reads counted per turn (`repeatedFileReadsSoFar`). `long-task` is written for it:

```sh
npm run eval -- run --fixture long-task --agent codex --context task,recency --threads fresh --repeat 3
```

Its early formats sit within reach of every setting, so a difference shows up in usage, repeated reads and correctness rather than in a fact one setting can't see. It is still a built task, not a person's real conversation.

For multi-turn workloads, `--to` alternates the builder and second agent on successive turns. With `--threads separate`, each task gets a new conversation and a fixture-authored standalone brief containing the prior decisions it needs; the working files and final checks remain the same. Skills and task limits carry into every new conversation. This is an explicit manual-brief baseline, not a free model-generated summary. Report its wall time as evaluation execution time; the human time spent authoring baseline briefs is not measured.

Saved `turns` record session mode/reason, text-envelope bytes and estimates, omissions, and a fresh-envelope fact reconstruction probe. That probe does **not** inspect a provider's resumed context or prove retention through a native compaction. Final correctness comes from hidden checks; the saved human rubric covers remaining qualitative judgments. A provider switch, including a return to the first provider, rebuilds a fresh session through the broker's normal path.

Recorded Codex traces persist session totals across worker restarts, and fresh sessions start at zero. A synthetic compaction notification exercises accounting without forcing or measuring a live compaction. Recorded Claude traces use the CLI protocol; live Claude evaluations use the normal SDK. These traces verify lifecycle and accounting, not provider behavior or efficiency. Gemini can be selected for explicit live runs; it has no recorded trace adapter here.

The final `long-thread` trace also requires the actual dispatched prompt to contain the earlier currency, separator and tax-blocker facts. After a native compaction notification, the task policy reconstructs bounded context on the next send, while keeping the native session. Saved turn context labels this as `restoredAfterCompaction`. A trace missing those facts fails before applying its final edit, so a successful fresh-envelope probe alone cannot pass it. This tests delivery after a simulated compaction, not hidden-state retention inside a live provider. Ordinary task-policy resumes remain deltas; the older `recency` policy is retained as a comparison and does not perform this reconstruction.

The shared run budget covers every turn. Evaluation `--max-tokens` counts measured input, output, cache-read and cache-write tokens, with reasoning already included in output. It is checked between turns, so a turn can overshoot it, and unreported fields cannot enforce a hard token ceiling. A budget-stopped workload still receives its final checks and is never declared complete merely because reconstruction passed.

`--context-limit off|auto|<tokens>` pins Normal-mode rollover policy as part of the experiment (custom limits start at 8,000 tokens). Evaluation runs default to Off for an explicit baseline; the product defaults to Auto. For example, `npm run eval -- run --fixture long-thread --agent codex --context-limit 8000` exercises the policy with recorded providers; the dedicated regression trace raises its first reported request above the target and checks that the next thread starts fresh, keeps the task facts and does not inherit old token counters. The stock trace may remain below the target. A live comparison still requires `--live` and a new stated budget. Context limits are checked before turns; they do not constrain provider-internal tool loops, and these recorded counts are not live efficiency evidence.

An agent is written `provider:model:effort`, and any part after the provider can be left out. `--context` compares `task`, the current selection, with `recency`, the older one. `task-unfolded` is `task` without the rolling brief from 0.38.0: history past the 48 KB allowance is cut off by age, as before. Only evaluations use it, as a baseline for `long-chat` and `long-chat-short`. `long-chat-short` was a known gap while the brief kept a fixed 16 requests. It now fills its size instead, and a recorded run under `task` passes. A run on another billing basis than a subscription fails rather than spending money.

```sh
npm run eval -- report    # compares everything saved
npm run eval -- compare   # manual small-edit against routing-assessment, per verified run
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

### Manual against routed

`compare` pairs saved `small-edit` (manual) and `routing-assessment` (routed) results that share the repository snapshot, hidden checks, builder agent, context policy, engine and runtime. It uses the same rules as the app's Smart results (`src/smart-results.mjs`): usage per verified run, failed runs included, totals summed, a fixed-seed range, and a quality gate before anything counts as a saving. Evaluations always run their checks, so the only lower thresholds are the repeat counts: 3 on each side. `--baseline` and `--routed` pick other fixtures, and `--live` keeps live results only. It runs nothing and spends nothing. Recorded results only check the arithmetic; only live repeats are evidence, and only for that fixture and agent.

## Reading the results

- **Unknown is not zero.** An agent that doesn't report a value shows as `unknown`, and totals only cover the runs that reported. **Runs without usage** says how many didn't.
- **Field coverage** lists how many runs reported each token field across repeats. A reasoning or cache total from only some runs is a partial measurement. Missing cache counters or missing session baselines cannot produce a fresh-input estimate; decreasing counters remain unknown rather than negative.
- **Context and consumption are distinct.** Text-envelope estimates cover Codeshi's outbound text only. Native capacity and last-request counters, where reported, are saved under a run's normalized `usage.context`; cumulative native totals are in `usage.sessionTotal`. Last-request counters are not a measurement of the entire native context.
- **Compactions** counts notifications observed by Codeshi; zero means no notification was observed. Their separate token cost is unavailable, and the report makes no inference about savings from their count.
- **Partial counts.** Claude only sums up a run at its end, so a stopped run is counted from its messages and marked `partial`.
- **Claude pipeline coverage.** When `modelUsage` is reported, totals include main-loop, subagent, sidechain and internal query-pipeline work, including compaction. They use cumulative model totals with the preceding session baseline subtracted, rather than adding the narrower main-loop `usage` to them. Raw per-model counters and coverage remain in the local journal. SDK helper calls outside the query pipeline are excluded by the provider. A stopped follow-up retains the last pipeline reading plus newly observed messages; its unreported reasoning and cost remain unknown. Missing per-model fields are unknown, and a resumed session without an observed baseline is unattributable. API dollar figures remain estimates and are differenced with the same baseline.
- **Tokens are not a price.** A dollar figure from an agent is kept with its basis, and on a subscription it isn't a charge. Nothing here converts tokens to money.
- **Usage limit readings are separate.** They are account-wide and other tools count toward them, so they are never attributed to a task.
- **`rubric`** in each result says what a person should judge that a check can't. Its `verdict` starts empty.

Run enough repeats to see the spread: agents vary from run to run. Don't advertise a saving or a quality gain from a few runs.

Reports pool repeats only when experiment inputs, live/recorded mode and reported model/effort sequences match. Each row shows its experiment ID and actual models. Changed fixtures, skill resources, checks or engine versions stay separate; legacy results without pins remain readable but are not pooled. **Work (ms)** adds agent working intervals. **Wall (ms)** includes setup, quota observations, checks and cleanup as well, so evaluation overhead stays visible. Neither recorded-provider timings nor token counts are evidence of a live efficiency gain.

Reviewers count in the task ledger, including their final effective model/effort, elapsed time, tool counts and interventions after temporary worker files are removed. Separate independent folder tasks retain separate task identities. Tasks and saved evaluation `accounting.roles` split whole invocations into builder, read-only, assessment and review roles. Each role has working time, usage and field coverage; these are included in the overall total, never added again. A failed assessor retains its measured usage, and an unreported role stays unknown. Task start time includes assessment before the builder starts. Reports show each role’s measured spread across repeats.

The `routing-assessment` fixture uses the real routing dispatcher and provider worker before the builder. Its repository snapshot and hidden checks match `small-edit`, the manually selected single-agent baseline. Offline runs supply synthetic fresh quota/model observations and an assessor trace; live runs use the selected provider’s actual account, models and quota. Routing stays within the provider chosen by `--agent`, and chooses its model and effort. Both calls count toward tokens, and two invocation slots are reserved before dispatch, even when a fallback ends up using fewer. A one-slot remaining budget cannot start this fixture. Token budgets are checked between dispatched tasks, so the assessor and builder can together overshoot a token target; they are not hard provider caps. For example:

```sh
npm run eval -- run --fixture small-edit,routing-assessment --agent codex --repeat 3
```

These fixtures have separate experiment pins because policy and traces differ; inspect snapshots and checks to establish their common task inputs. Planning and summaries inside a provider turn cannot be separated by role. Retrieval and context reconstruction use local rules; routing assessments are separate Codeshi model calls and count explicitly. Delegated Codeshi model workers remain planned. Claude pipeline totals cover native delegated work where reported, but cannot attribute it to individual roles; other providers' internal delegation coverage is unknown. Broader routing cases from the roadmap (stale quota, unsuitable models and concurrent account usage), delegated-worker evaluations, and budgeted live comparisons remain outstanding. Recorded timings and token counts do not demonstrate efficiency gains.

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

A skill clearly helps when it holds something the agent can't otherwise know. A general procedure on a task that doesn't need it costs more, with no gain in this run.

Then each starter on its own task, with `claude:haiku` on November 12, 2026. With and without ran in alternating pairs, three rounds, within a stated budget of 40 runs and 2M tokens. The budget ran out three runs early, so `review-intent` without and `test-writing` both ways have two runs. Tokens are input, cache reads, cache writes and output together; three runs show the median and range, two show both values. Work is the median agent working time.

| Fixture | Starter | Verified with | Verified without | Tokens with | Tokens without | Output with | Output without | Work with | Work without |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `view-states` | `frontend-implementation` | 1 of 3 | 2 of 3 | 58,636 (47,116–59,316) | 44,378 (43,161–85,031) | 2,684 | 1,835 | 15.3 s | 11.4 s |
| `api-endpoint` | `api-contracts` | 3 of 3 | 3 of 3 | 80,485 (68,155–93,548) | 52,748 (52,648–53,044) | 5,682 | 1,719 | 26.9 s | 12.1 s |
| `data-migration` | `database-migration-planning` | 3 of 3 | 3 of 3 | 76,372 (63,266–109,641) | 57,840 (45,528–62,758) | 4,106 | 2,456 | 23.5 s | 15.4 s |
| `accessible-toolbar` | `accessibility` | 3 of 3 | 3 of 3 | 59,562 (46,693–59,639) | 51,719 (42,501–52,373) | 2,880 | 1,614 | 17.3 s | 11.5 s |
| `review-intent` | `independent-review` | 3 of 3 | 2 of 2 | 32,302 (31,829–32,967) | 30,096 and 30,489 | 1,932 | 1,137 and 1,360 | 19.1 s | 13.4 s |
| `test-writing` | `test-authoring` | 2 of 2 | 2 of 2 | 75,813 and 77,769 | 33,954 and 46,171 | 4,219 and 4,496 | 2,196 and 2,798 | 23.8 s | 13.4 s |

What this shows, for Haiku on these tasks:

- **No starter made a task pass more often.** Five tasks passed every time either way, so their checks didn't tell the two apart: Haiku already handled what each starter covers.
- **`frontend-implementation` did worse.** Both failed runs with it missed the loading and error states, which the other views handle and the starter tells it to check. One run without it missed loading, error and empty. An earlier pair under the same check, before it was split into named parts, went the same way: failed with, passed without. That makes 1 of 4 with and 3 of 4 without. Results don't keep the agent's code, so why isn't known.
- **Every starter cost more.** Median total tokens rose by 7% to 92%, median output by 1.5 to 3.3 times, and median working time by 1.4 to 2.2 times. The starters ask for more reading, checking and reporting, and the agent did it.

So the starters stay opt-in, and none should be turned on by default on the strength of these runs. A starter may still help a weaker or rushed agent, or on larger real work these small tasks don't represent. Neither was measured here. These were 35 runs on one model; other agents and larger tasks are not measured.

### Longer conversations, live

With `claude:haiku` on November 12, 2026, within a stated budget of 36 runs and 1.5M tokens. New tokens are input, cache writes and output; cache reads are listed apart.

**`long-thread`, `task` against `recency`.** Three alternating rounds; each workload is three turns on one native session.

| Context | Verified | First try | New tokens per workload | Cache reads | Work | Repeat reads |
| --- | --- | --- | --- | --- | --- | --- |
| `task` | 3 of 3 | 3 of 3 | 17,237, 17,406, 18,977 | 112,752–128,670 | 26.4–29.6 s | 0 |
| `recency` | 3 of 3 | 3 of 3 | 27,675, 27,925, 28,291 | 171,084–189,930 | 27.5–31.9 s | 0 |

The task selection kept every decision, the same as the old one, with about 37% fewer new tokens and 27% fewer cache reads. Working time was about the same. Nothing was read twice either way, so this task is too small to show re-reading.

**The rolling brief, `task` against `task-unfolded`.** One run each: the budget left after `long-thread` covered one round, not three.

| Fixture | Context | Formats in the prompt | Verified | New tokens | Cache reads | Work | First message |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `long-chat` | `task` (folded) | 3 of 3 | Yes | 17,446 | 33,829 | 11.8 s | 15 KB |
| `long-chat` | `task-unfolded` | 0 of 3 | Yes | 41,607 | 56,862 | 15.6 s | 52 KB |
| `long-chat-short` | `task` (folded) | 0 of 3 | Yes | 19,419 | 64,268 | 20.4 s | 11 KB |
| `long-chat-short` | `task-unfolded` | 3 of 3 | Yes | 40,680 | 56,196 | 15.2 s | 52 KB |

- **Every run passed, even without the formats in the prompt.** Claude's own transcripts show both runs that lacked them searching the conversation file the brief points to (`brief.originals`) and finding them there. Codeshi gives that path so the original can be looked up, and it worked as a safety net here. A weaker or less careful agent might guess instead.
- **The rolling brief used less than half the new tokens in both.** Its first message was a third to a fifth of the size, and the search cost less than sending 52 KB of history.
- **The rolling brief reaches less far back in a chat of short replies.** It keeps the 16 latest folded requests, so a conversation past 48 KB of mostly short exchanges keeps about 18 of them. The old cut-off kept around 60. Searching cost `long-chat-short` about 5 seconds of extra working time. With long replies the reach is about the same: 18 exchanges against about 16. *Since then:* the brief keeps the newest requests that fit its 12 KB instead of a fixed 16, so in a recorded run `long-chat-short` keeps all three formats, with a first message of 17 KB, and `long-chat` grows from 15 KB to 16 KB. Not yet rerun live.
- **`Decision:` lines are kept from any age** (up to 12), so a decision written that way survives either way. These fixtures state the formats in prose, as people usually do.

That's one run each and two built fixtures, so it shows what each setting keeps, not how often real conversations need it. A real long conversation, other agents and repeated runs are not measured.

Not measured yet: long real tasks, whether smaller prompts lead to more re-reading on them, and other agents on this comparison. The fixtures are small enough that **Repeat reads** barely moves.

### A six-turn task, every turn fresh

`long-task` with `--threads fresh`, `claude:haiku`, November 14, 2026, three rounds of `task` and `recency`, within a stated budget of 38 runs and 3.5M tokens. Each round had its own share of the budget, and `recency`'s sixth turn didn't fit in any of them, so the comparison below covers the first five turns, which both settings ran. New tokens are input, cache writes and output.

| Context | Turns 1–5 correct | New tokens, turns 1–5 | Cache reads, turns 1–5 | Work, turns 1–5 | Repeat reads | First message per turn |
| --- | --- | --- | --- | --- | --- | --- |
| `task` | 3 of 3 | 129,966–132,647 | 230,675–270,431 | 43–49 s | 0, 0, 0 | 18–25 KB |
| `recency` | 3 of 3 | 273,826–281,654 | 421,393–424,413 | 51–53 s | 0, 0, 2 | 69–83 KB |

- **Same results, about half the new tokens.** Both settings got ids, tag case after the correction, search and the one-line format right on every run. `task` used about 52% fewer new tokens and 41% fewer cache reads over the same five turns, and slightly less working time.
- **No more re-reading with the smaller brief.** `task` never read a file twice. `recency` did twice in one run.
- **`task` finished all six turns in every round**, and passed every hidden check, including `remove` (29–30k new tokens for that turn). `recency`'s sixth turn was left out by the budget, so its final check failed on `remove` for that reason, not because of a wrong answer.
- **The size fix, live.** After the rolling brief became bounded by size, one run each: `long-chat` and `long-chat-short` both had all three formats in the prompt and passed, with 19,046 and 22,905 new tokens. `long-chat-short` took 13 s, against 20 s before the fix, when the agent had to search the conversation file for the formats.

This is one agent and one built task of six turns, three runs each. It shows what each setting costs when every turn starts fresh, as after a handoff or a context refresh. It is not a person's real conversation, and a resumed session sends only what changed, so these differences apply to fresh starts.

### Manual against routed, live

The first live run of `compare`, with Claude on November 12, 2026: `small-edit` on Claude's default model, as someone who doesn't pick one would run it, against `routing-assessment` in Smart. Rounds alternated, one of each, three rounds. New tokens are input, cache writes and output; cache reads are left out, as in `compare`. The list price is Claude's own estimate at API rates: on a subscription it is not a charge, and each model counts against its own limits.

| | Models | Verified | New tokens per run | Mean | Work per run | List price per run |
| --- | --- | --- | --- | --- | --- | --- |
| Manual | Opus 5.5 | 3 of 3 | 5,913, 5,956, 6,009 | 5,959 | 9.2–10.3 s | about $0.040 |
| Routed | assessment, then Haiku 5.5 at low effort | 3 of 3 | 17,522, 8,296, 9,996 | 11,938 | 10.2–11.5 s | $0.010–0.014 |
| Routed, assessment fixed | Haiku 5.5 at low effort, both calls | 1 of 1 | 7,434 | | 9.5 s | about $0.0016 |

`compare` puts routed at 100% more tokens per verified run (90% range 48% to 153% more) and 9% more working time (2% to 17%), with no quality difference: all six passed.

- **The assessment ran on Sonnet, not Haiku.** Codeshi asked for Haiku, but Claude Code 2.1 runs a Haiku request on Sonnet in plan mode, which read-only Claude runs use. In these three rounds the assessment was 2,000–4,800 new tokens and most of routed's list price. An assessment has no tools, so it now runs outside plan mode. The fixed run's assessment was 1,159 new tokens on Haiku, with no Sonnet call.
- **Routed uses more tokens, on a smaller model.** Haiku started with a cold cache, so the builder wrote more to it than Opus did. Even fixed, one routed run used about 25% more new tokens than the manual mean.
- **What that means depends on how a plan counts models.** By list price, routed was a quarter to a third of manual, and a twenty-fifth once fixed. Whether that saves subscription allowance depends on how Claude's limits weigh Haiku against Opus, and Codeshi doesn't know that.

**Repeated after the fix.** The fix changed engine code, so `compare` doesn't pair new runs with the manual runs above. Three more alternating rounds ran the same day on the fixed engine:

| | Models | Verified | New tokens per run | Mean | Work per verified run | List price per run |
| --- | --- | --- | --- | --- | --- | --- |
| Manual | Opus 5.5 | 3 of 3 | 5,958, 5,962, 5,952 | 5,957 | 10.0 s | $0.039–0.041 |
| Routed | Haiku 5.5, assessment then builder at low effort | 3 of 3 | 8,724, 6,695, 8,772 | 8,064 | 11.4 s | $0.0014–0.0018 |

`compare` puts routed at 35% more tokens per verified run (90% range 24% to 47% more) and 14% more working time (2% to 26%), with no quality difference: all six passed. Every routed call ran on Haiku, with no Sonnet call.

- **The assessment is the difference.** Haiku's builder used 6,258–6,280 new tokens, about 5% more than Opus. The assessment added 420–2,490 more, depending on whether its prompt was already cached.
- **By list price, routed was about a twenty-fifth of manual.** The same caveat applies: on a subscription that is not a charge, and Codeshi doesn't know how Claude's limits weigh Haiku against Opus.

This is one small edit on one agent, three runs a side, so it shows a direction only and supports no claim. On a task this small, routing's assessment costs more tokens than a smaller builder saves. Larger tasks, where a light model might fail or need a retry, and Codex and Gemini are not measured.

### Claude subagents

A live Claude Code 2.1 run through its command line, which started two Haiku subagents, checked against Claude's own transcripts and totals:

- Claude streams only a subagent's messages that call tools, each with the output count from the message's start. A subagent's final reply only arrives as usage on its Agent tool's result.
- Before the fix, the subagent line counted 5 of 7 messages: 59% of cache reads, 98% of cache writes and 6% of output. It now adds each final reply. Input, cache reads and cache writes matched Claude's transcripts exactly, and the main loop plus subagents matched the run's total, apart from one small helper call.
- Output is still undercounted, 642 of 1,288 in this run, because the streamed counts are partial. The line stays "at least".
- Codeshi's usual Claude connection, the SDK, doesn't offer Claude the tool that starts subagents. Only the command-line connection can start them.

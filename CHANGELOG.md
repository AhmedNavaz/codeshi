# Changelog

Notable changes to Codeshi, called Throughline until 0.23; earlier entries use the name each version shipped under. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Choose model and effort for each queued message** (#113). Model and effort pickers remain active while a run is working, applying to the prompt being queued without changing the active run. Queued messages display their model, reasoning effort, and routing details. Both model and effort can be edited directly on queued messages before they start, on desktop and phone. Changing the model of a routed message turns it into a manual choice.

### Fixed

- **Connectors and MCP tools in Codex** (#111). A GitHub connector write, or any tool Codex asks to run, no longer fails with `user rejected MCP tool call` when nobody rejected it. It now follows the run's access: Full auto-approval runs it and notes it in the timeline, and Ask before changes shows who it reaches and what it will do, then Approve or Deny. A denial ends with that call and is not remembered. Read only says it blocked the call.
- **What an MCP server asks of you, in Codex** (#111). A sign-in or a form now shows as a question, with a link that names its address, and waits for you even in Full auto-approval. Anything Codeshi can't show is cancelled with a note that says so. A request for more access also gets a real answer instead of a silent refusal.
- **Long workspace chat opening and paging** (#124). Opening a workspace with thousands of messages no longer stalls or hangs the app. The conversation opens immediately on its latest messages, with older history loaded in pages as you scroll up while preserving scroll position. Search across unloaded history, jumping to past runs or messages, live message streaming, and export continue to cover the full conversation history.

## [0.31.1] - 2026-11-07

### Added

- **Usage notices after each prompt, in Normal and Flow.** With no model call, Codeshi compares each run with that agent's usual size and reads plan limits on each side of it. If the run was unusually large, or a limit moved a lot, one line above the message box says so. It offers Compact or Cost saving when those would help, and says when a context refresh is already coming. Repeats are held back, and run details now keep each run's total, its agent's usual and how limits moved.

### Changed

- **Task assessment before routing.** On Send, a short read-only agent assessment chooses model and reasoning effort from the prompt and recent task context, typically in about three seconds on the smallest model available, with no tools, plugins or skills. A bare go-ahead carries on with the last rating and no agent call. Final selection uses every applicable quota window and considers remaining allowance, reset times and continuity; a slow agent check no longer holds up Send. Assessment usage shares the task budget. Stop and changed settings prevent execution; if no agent can rate a request in time, Codeshi estimates locally and sends it, never to a light model. The note under a sent message shows how it was rated. Routed queued prompts and folder tasks follow the same path.
- **A quieter message box in Flow.** The estimate line above the box is gone, and limits stay on the cards, because the agent isn't chosen until you send.
- **Light work reaches Codex's small models.** Routing now recognises a small model from its catalog description when its name doesn't say, as with Luna.
- **Context refresh keeps recent work longer.** After recent provider requests, the Auto target rises to 120,000 tokens in Normal and Balanced, 80,000 in Cost saving and 160,000 in Maximum quality, because a session that was just used may still be cached. After a longer pause, or a change of model or effort, the targets stay at 75,000, 40,000 and 120,000. Custom Normal limits stay fixed, targets are still capped at 75% of a reported model window, and none of this guarantees a cache hit.
- **The Compact context button.** It's now an icon, quiet in normal use, with a dot near the target and a check once a refresh is arranged. It opens the agent's context details, including during a run, and explains what carries over before you confirm. Manual refresh stays available only when agents are idle.
- **Clearer run details.** Context readings, the last request's input and Codeshi's own message size have plainer labels, and a run being rated shows as **Assessing task**.

### Fixed

- **A Flow sheet could close itself.** Closing one sheet and quickly opening another, such as Agents then Remote access, could shut the new one as well.
- **False failures from command text.** A command that merely mentioned a word like "error" could count as a failed step, end up as a blocker in the next agent's brief, or add to a task's repeated-failure stop. Runs now use the agent's reported result where there is one, and older saved runs are rechecked against real failure messages.
- **Task briefs after a refresh.** Your answers to agent questions are kept as decisions, each with its source, and a resumed task no longer repeats its own continuation prompt as a request. Files outside the workspace are left out.
- **Antigravity could drop out of Auto.** Its model lookup had five seconds for a check that takes about that long, so it was often left out of routing without any message.
- **Five-hour plan usage.** Agents, Flow and the message box keep the reported five-hour allowance as their main reading. The next most restrictive limit appears separately in Agents and Flow, and low weekly or model-specific allowance stays visible as a warning in the message box. Accounts without a five-hour reading keep the period their provider reports.
- **Gemini across workspace folders** (#116). The Antigravity connection now passes additional attached folders through the runtime's advertised ACP capability, so supported runs stay in the workspace chat with their shared history. Flow routing and handoff can choose Gemini for these workspaces. Runtimes without support keep the one-folder task option. Text-file requests remain bounded to the attached folders, and checkpoints and Undo include changes from each folder.

## [0.30.0] - 2026-11-07

### Added

- **Automatic context refresh** (#123). Keep the same workspace chat while Codeshi starts a fresh native agent session between turns when its context signal reaches the selected target. Normal defaults to Auto, with Off, presets and custom limits in Settings; Flow follows its Cost saving, Balanced or Maximum quality target. Older Claude and Codex sessions without a usable reading refresh once before their next send. Explicit Off choices remain respected.
- **Compact context in the message box.** A small, number-free ring shows progress toward the refresh target; hover for reported or estimated readings. Clicking it, or sending `/compact`, explains what will happen and asks for confirmation. Confirming schedules a refresh without calling a model. The next message to that agent starts a fresh session with a bounded task brief; the full chat and draft stay saved. Older details may be omitted from active context. This is a local fresh-session refresh, not a native model-generated summary or a cap on tool loops inside a running turn.
- **Native compaction visibility and context recovery** (#85). Run details and Flow retain observed native compaction counts and available context snapshots. The next send after native compaction rebuilds bounded task context, governing instructions and current file evidence while keeping the native session. The Brief panel shows sources and invalidation notices; changed files, revisions and instructions are rechecked.
- **Long-thread evaluation fixtures** (#84). Recorded traces compare resumed sessions, separate task briefs and repeated agent switches across successive tasks and folders. Reports separate context signals, consumption, cache fields and compactions. Offline checks cover retained facts and outcomes; live efficiency measurements remain budgeted, separate work, with no claim of proven token savings.

### Changed

- **Flow controls.** Review first can be switched directly in the working card. Routing changes stay in Agent settings, and card actions use rounded buttons with hover and keyboard-focus states.

### Fixed

- **Usage accounting across continued sessions.** Claude's reported pipeline totals use a resumed-session baseline instead of repeatedly counting cumulative usage as a new run. Reported auxiliary work, reasoning coverage and reviewer tool counts remain visible; unavailable fields stay unknown. Context readings and journal size estimates never become billing totals.

## [0.29.2] - 2026-11-06

### Fixed

- **Remote access in Flow.** Opening remote access from Flow’s bottom bar now reliably loads connection options in all desktop window environments.
- **Update release notes.** The What’s New viewer reliably loads notes for the current version across platforms.

## [0.29.1] - 2026-11-06

### Fixed

- **Packaging smoke tests.** Automated packaging checks for Flow mode now bypass decorative transition animations in headless environments and allow sufficient time for asynchronous network status probes on CI runners.

## [0.29.0] - 2026-11-06

### Added

- **Flow** (#107, first milestone). The **Flow** button at the right of the header, ⌘⇧F or **View › Flow Mode** keeps just the chat, gives it its own look and puts away the sidebar and every panel; leaving brings them back as they were. In Flow the header spans the window, with the seal and the word Flow beside the window controls, search in the centre and **Leave Flow** at the far right. Four cards either side read what Codeshi already recorded, with no model call: **How it’s working now** (routing and handoff in plain words, where the next message would go, and a mode change that says first what would change, with access, permissions and billing left alone), **What’s left on your plans** (each connected agent’s tightest limit and its reset), **What’s next** (the task plan and the queue) and **Files changed** (each run that changed files, with Undo). Approvals, questions and Stop stay in the chat, live status stays in the working card, appearance and Settings sit at the bottom left and **Remote access** at the bottom right, opening in a Flow sheet rather than Settings, with no bottom bar, and a narrow window turns the cards into chips under the search bar. Agents, Timeline and Git open in a Flow detail sheet with Back to Flow, Escape and backdrop dismissal. Terminal and Run stay outside Flow, including keyboard and menu actions.
- **Gemini in a workspace with several folders** (#116). The Antigravity connection works in one folder at a time. Sending a message to Gemini on that connection in a workspace with more folders now asks which folder to work in, under the message box, and starts the message as a task there with the agent, model and access chosen, beside the workspace chat; before, the message failed with an error. Cancel or editing the message withdraws the choice. A request the page could not check in advance gets the same choice from the server's answer instead of a retry that would fail again.
- **Testing cadence.** **Settings › General › Testing › Review first** asks agents to keep checks small during revisions and verify before an explicit testing or finalization request, including commit, push or release. The preference reaches new turns across agents, task threads and handoffs; running turns retain their starting choice. Routine **Check with tests** runs and their repair loop are deferred with an explicit unverified status. Selected build/review workflows, test repairs and mandatory repository checks retain their checks. **As needed** remains the default.
- **Clickable links in terminal output** (#83). URLs printed in terminal output (such as local dev server addresses or pull request links) open in the default browser with a click, including addresses that wrap across multiple lines and OSC 8 terminal hyperlinks.
- **Deployment templates for the private-link service** (#9). Ready-made Docker Compose (with Caddy HTTPS) and Fly.io configurations under `sharing/deploy` for hosting your own Ask a Friend private sharing service.

### Changed

- **Routing belongs to Flow** (#107, #12). Entering Flow turns routing on, with the mode the workspace last used in Flow or Balanced, and leaving turns it off, so the normal view always uses the agent and model you pick. The Agents panel's Routing section shows in Flow only, with Cost saving, Balanced and Maximum quality and no Manual mode, and the normal view says where routing lives instead; Flow's working card offers the same three. Handoff follows the mode in Flow, with no separate setting: a routed run moves to another agent without asking at 80% of a limit under Cost saving, 90% under Balanced and 95% under Maximum quality, whatever Settings says for the normal view, and the Agents sheet shows no Handoff settings in Flow. Flow's working card leads with the mode, large, and what it does, including when it hands off; the "Near a limit" line is gone.
- **The Codeshi mark.** The sidebar's brand uses the C mark; the seal alone is Flow's.
- **Flow's side columns** are wider, 300 to 360 pixels each, so the cards wrap less and scroll less often; the window counts as narrow, with cards as chips, below 1180 pixels rather than 1100.

### Fixed

- **Merging tasks on Windows Git with CRLF line endings** (#120). Merge comparisons now handle repositories with Git's default `core.autocrlf=true` on Windows, preventing false conflict reports on unchanged files.
- **Spacing.** The Testing note in Settings sits under its rows with room, Remote access keeps its distance from the Updates section above, and the Agents panel's note about routing in Flow is a section of its own rather than text against a line.
- **Claude's plan name.** Claude Code's `auth status` says "pro" for Max accounts too, so Codeshi showed a Max plan as Pro. The plan now comes from the account profile in Claude Code's own config, its organization type and rate-limit tier, so a Max plan shows as Max, with its 5x or 20x where known; the CLI's word is used only when the profile says nothing.
- **Claude can still ask for permission after a background command wakes it** (#112). A Claude run that started a background command and ended its turn lost its connection for permission requests, so once that command finished, every later step needing permission failed with `Stream closed`. The connection now stays open until nothing is left that could start another turn.
- **Declining a Claude tool no longer fails the run.** Choosing **Decline** marked the run incomplete, with a message about a "native terminal", raw JSON and a second "exit 0" error. Claude now carries on from your answer.

## [0.28.0] - 2026-11-06

### Added

- **Timeline checkpoints and workspace restore** (#20, stage 2). The Timeline side panel lists saved runs by agent and the checkpoints before and after runs, undos and restores. Review the file diff before restoring a saved point, including later edits. Restores save a recovery checkpoint before writing, keep the conversation and add a note for the next agent. Changed previews, unavailable folders and active work block restoration.
- **Repeat evaluations from saved input pins** (#84). `npm run eval -- run --pin <result.json>` checks fixture snapshots, policy, skill versions and resources, acceptance checks, engine code and runtime before starting an agent. Live repeats still need an explicit budget. Reports keep incompatible experiments and recorded/live results apart, show the actual models, and include wall time alongside agent working time.

### Changed

- **Git-panel writes share task mutation leases** (#88). Stage, unstage and commit hold the selected folder's canonical repository root, blocking conflicting agent runs, patches, restores, imports and task merges in that repository while leaving independent repositories and worktree indices available. Folder membership is rechecked before writing, shutdown waits for commit hooks, and tasks waiting on a Git action retry when its lease is released.
- **Background reviews share the task's measured limits while they run** (#87). Review usage is saved to the parent journal as it arrives and survives interrupted recovery. A time, token or spend limit reserves the remaining allowance for one worker on that task, so a builder and reviewer cannot both take it. Reviews also occupy workspace concurrency slots. The native Claude API connection receives the parent's remaining spend cap; other connections remain limited by reported usage, with possible overshoot.
- **Routing checks the selected model's allowance** (#12). Five-hour, weekly and model-group limits are evaluated separately, with stale and unknown readings made explicit. Routed dispatch rechecks usage before starting the agent and saves its evidence in run details. Automatic handoffs and their reset waits, and automatic test retries, require fresh confirmed room; manual Send can proceed with an explicit unknown-usage warning. Model tiers remain local heuristics, without a measured quality guarantee.
- **Agent messages on the phone are separated by a line**, so it's easy to find where the latest one starts.
- **The phone's mic stays visible on Same Wi-Fi**, dimmed, and a tap explains why voice needs a secure connection and what to use instead. It used to be hidden there with no explanation.

### Fixed

- **Undo, redo and Timeline work on Windows.** Since 0.20.0, Git refused a setting Codeshi passed on Windows, so no checkpoint was saved and runs there couldn't be undone. Runs themselves weren't affected.

## [0.27.1] - 2026-11-06

### Changed

- **Remote access** is the name throughout the app, website and documentation, covering both same-Wi-Fi and away-from-home connections.
- **The README shows remote access on a phone.** A dedicated approval image accompanies the feature, and the hero and task images use the same framing as the other feature screenshots.

## [0.27.0] - 2026-11-06

### Added

- **Remote access** (#23). **Away from home** under **Remote access** keeps QR pairing and computer approval while allowing the same minimal phone page, at `remote.codeshi.dev`, to work over mobile data or another network. Prompts, progress and approval details are encrypted before reaching Firebase, which carries them. Remote access is optional, can be revoked and turns off on restart. If the service is busy or unavailable, the phone and desktop say so and keep retrying. The local-network connection remains independent.
- **Remote access on your local network** (#23, first milestone). **Remote access** in the bottom bar opens setup with a locally generated, one-use QR code and confirmation on the computer. Scanning connects by itself, and the computer still has to allow it. The phone gets its own one-handed page, not the desktop one: the conversation, a live line saying what the agent is doing, a message box that stays right above the keyboard, and approvals, questions and handoffs one at a time in reach of a thumb. Workspaces, tasks, the agent, model, effort and access open as sheets from the bottom, which keep the keyboard away. It has its own System, Light or Dark appearance, separate from the computer's. It loads the latest messages instead of the whole conversation, and reconnects by itself. Uses unencrypted HTTP, for trusted networks.

- **Voice on the phone.** A microphone beside Send on the phone page turns speech into text as you speak, using the phone's own browser; on an iPhone or Android phone that sends the audio to Apple or Google, which the first use says. Words land in the message box and nothing is sent until you press Send, which also turns the microphone off. It's available away from home, because browsers block the microphone on the same-Wi-Fi connection's plain HTTP.
- **A queued prompt can run as a task** (#108). **Run as a task** on a row under **Up next** moves it out of the queue and starts it beside the current run, in the selected folder, with the agent, model and access it was queued with. In a workspace with several folders and none selected, the row asks which one.

### Changed

- **Files opens in its own browser.** A Files button beside Workspaces opens a compact browser; choosing a folder no longer opens Files automatically. Tasks stay directly below workspaces, and the workspace-wide conversation is named **Workspace chat**, with a subtle working animation on its leading icon.
- **Remote access uses less data.** Streaming replies send only new text when the phone confirms its previous snapshot, with full-text recovery after a reconnect or changed conversation. Progress no longer reloads workspace metadata on every update, hidden pages cancel queued refreshes, and Firebase writes no longer echo encrypted packets back to the sender. Added a repeatable local/live traffic measurement command.
- **The layout buttons sit beside the search bar.** The buttons that show or hide the sidebar and the side panel are at the right of the search bar, after a divider, so a side panel's tabs have the whole of its top. The bottom panel's button is gone: **Terminal** and **Run** in the status bar and ⌘J open and close it.

### Fixed

- **Runs no longer stop when an agent compacts its context.** From 0.26.0, a Codex or Claude run that shortened its context stopped with `Cannot access 'c' before initialization`, and retrying kept failing while the conversation stayed near its context limit.
- **Resizing no longer leaves an input-blocking overlay behind.** Drags end on lost pointer capture, release outside the handle, window blur, Escape and page hiding. The vertical workspace/Files divider is removed, and its saved height is discarded so closing Files cannot push Tasks downward.
- **Remote pairing waits for the computer before listening.** Scanning a QR no longer opens the phone's response connection before Firebase grants it access, and a recovered connection restores the approval instructions instead of leaving a stale error above the pairing number.
- **Settings dropdowns show their chevrons.** Phone pairing scrolls a newly generated QR code into view for local and remote connections, without pulling the page back during status refreshes.
- **Remote phone pairing works with browser networking.** The Firebase client keeps the browser's required `fetch` receiver for sign-in, requests and live updates instead of failing with a Window instance error after scanning a QR code.
- **Codex's optional questions have answer controls.** Questions sent while Codex continues working now show choices, a free-text answer and Skip on desktop and phone. An answer joins the current run; after it finishes, the answer is added to the message draft for review and sending. Unanswered questions survive a restart.
- **Earlier tasks fit the Tasks panel.** The rows under **Earlier** ran past the panel's edge; each prompt now ends with an ellipsis and its usage wraps.
- A working time of a whole number of minutes read as `36m 60s`.

## [0.26.0] - 2026-11-05

### Added

- **A side panel with four tabs.** Agents, Brief, Tasks and Git. **Agents** keeps plan usage, routing and handoff. **Brief** shows what every agent is told when it starts on a task, with the memory and skills you add to it. **Tasks** shows what each task used, and its limits.
- **See what each task used** (#84). The Tasks panel shows the current task with the agents involved, working time, tokens as each agent reported them, and whether the project's tests passed. A task follows its handoffs, retries and reviews. A value an agent didn't report shows as not reported, never as zero. Tokens aren't turned into a price, and usage limit readings are kept apart because other tools count toward them. It all stays on your computer, and **Export without prompts** saves a copy with no prompts or commands.
- **Project memory** (#21). **Remember** on any message or step keeps it for every agent in this workspace, and **Memory** in the Brief panel lists what's kept, to edit, retire, delete or export. Local rules suggest things you wrote as lasting rules and approaches that failed before the tests passed, and nothing is kept unless you choose it. An agent is told only what's relevant to its task, and an entry whose files have changed is marked for a recheck. Memory stays out of your repository and doesn't cross workspaces.
- **Skills** (#86). Reusable procedures in the Agent Skills format, used by Claude, Codex and Gemini alike, and kept when a task moves to another agent. **Skills** in the Brief panel finds your repository's skills and any folder you add, and has six optional starters: frontend implementation, API contracts, database migration planning, accessibility, test authoring and independent review. Type `/name` in a prompt to use one. Agents only get names and descriptions until a task needs the instructions. Nothing is on until you enable it, nothing in a skill is ever run by Codeshi, and enabling keeps a private copy at that version until you accept an update. A skill reaches agents as instructions, so anything that relies on one agent's own skill system is listed as unavailable. A memory can become a skill after you review it.
- **Task limits** (#87). One set of limits for a whole task, across its agents, retries and reviews: working time, tokens, API spend, and how many handoffs, retries and reviews. A new prompt starts a new task. The same failure repeated is counted across restarts and changes of agent, and the next agent is told about it. By default only those counts have limits, and they're generous; time, tokens and spend have no limit until you set one. Reaching a limit stops the run, saves its work and says why, and **Allow more** raises it for that task. You can also choose which agents a workspace may use.
- **Tasks side by side** (#88). **Tasks** in the sidebar lists tasks that run in one folder beside the main conversation, each with its own output, approvals, queue and Stop. With a folder selected, **+** opens a blank task using the usual message box, so any agent and model can be chosen, and it says how it would run before you send it. Separate folders run directly. Work in a repository already in use gets its own Git worktree, and its changes come back through a review that shows every file, can run your tests on the combined result, and refuses to overwrite either side on a conflict. Outside Git, a task waits its turn. Tasks can wait for one another, share one limit on how many run at once, and recover safely from a restart or a folder being removed.
- **The task plan goes with the task** (#92). Through a handoff, **Continue with**, a wait for a reset and continuing locally, the checklist stays, says which agent it came from, and the next agent is told each step's status. A plan that agent reports replaces it, and steps already done stay done unless it lists them again. A new prompt starts without one.
- **Queued prompts follow a handoff** (#93). The offer says how many would move. They keep their access and permission setting and take the new agent's model and effort, and routed prompts are routed again. An agent that bills per use needs its own yes for them, and one that changed after you accepted stays where it was. If Codeshi stops while a prompt is being sent, it isn't sent again by itself.
- **One result for a task across agents** (#94). When a task that crossed agents finishes, one line gives its total working time, without waits for a reset, the files each agent changed and the latest test result.
- **Smaller details** (#96, #98, #99, #100, #102, #103). Plan usage marks the agent that's working and lists Ollama. The preview's toolbar shows the agent's latest edit, as a file name and line counts. Read aloud highlights the recap row being read. Voice says **On this Mac** while it listens. The moment an agent reaches its limit now stands out, stamped with the seal.
- **Evaluations** (#84). `npm run eval` runs nine small tasks with hidden checks and compares settings on the same pinned code. Recorded runs need no account. Live runs use your own agents, only when you pass `--live` with a budget.

### Changed

- **Wider side panels.** Both side panels start wider and can't be dragged narrower than they can show their contents, and the right panel always shows its tab names. You can still resize or hide them.
- **Drafting review fixes keeps your message** (#95). The fix request is added after whatever is in the message box, whose text and attachments stay, instead of being refused.
- **A new agent gets a task-focused brief** (#85). When an agent starts fresh, such as after a handoff, it's told the current task first, along with the folders it concerns, each folder's instruction files, the files changed so far, what already went wrong and the steps left, all worked out locally with no model. Work from other folders and repeated steps are left out, and the full history stays saved. Claude now gets each folder's `AGENTS.md` and `CLAUDE.md`, which it wasn't reading here. The **Brief** panel shows this, with **See the full brief** for all of it, and you can add a note to it.

### Fixed

- **Claude's task plan shows again.** Current versions of Claude Code replace the to-do tool Codeshi reads the plan from, so Claude's plan had stopped appearing.
- **Continue locally is the same task.** It used to count as a new one, so it lost what the task had done so far.

## [0.25.1] - 2026-11-04

### Added

- **A run that reaches its limit continues on another agent** (#91). With **Hand off automatically** on, a task no longer stops when usage jumped between checks or an offer was missed. It continues on a subscription-billed agent with room, with the same access, and the conversation names both agents and when the limit resets. If every agent is out, the task waits for the first reset. It's off until you turn it on: the first time a run stops on a limit, **Always do this** beside **Continue with…** does that.

### Changed

- **Dividers you can drag now show it.** While the mouse moves, a small grip appears at the middle of each divider that can be resized, and it fades when the mouse stops.

### Fixed

- **Restart to update restarts right away** (#82). A slow step, such as an account check, could hold Codeshi open for up to two minutes while "Codeshi is stopping." showed as an error. Quitting now has a time limit, the status bar says **Restarting…**, and if the installer ever gives up, the next launch says so and offers the update again.
- **Pushes and other network commands work on every agent** (#81). With **Full auto-approval**, Codex couldn't ask for anything its sandbox blocked, so `git push`, `gh` and package installs failed. It now has the network, and what its sandbox still blocks is requested and approved automatically. Gemini through Google Antigravity failed the same commands under every permission setting, because Codeshi's connection to Google caught them too; they now go through.
- **Handoff before a limit is more dependable.** Gemini through Google Antigravity is no longer passed over, or told it's out of usage, because a different model's allowance ran out, and **Continue when a limit resets** and routing retries read those limits correctly too. Usage is checked within seconds of a run starting and then about once a minute, so short runs get an offer and a jump in usage is less likely to reach the limit first. The button says **Handing off…** while it switches, and when you've scrolled up, **Jump to latest** says an offer is waiting below. An effort saved for Gemini no longer stops a run on Gemini CLI.
- **Recovering from a crash can't let two processes in at once.** On Windows, if two processes picked up after a crash at the same moment, one could fail with an error and, rarely, both could change the same saved files. They now take turns on every platform, and a crash at any point during recovery is recovered from too.
- Stopping a command in **Run** just as it exits no longer shows an error (macOS).
- **Long conversations stay responsive.** In a long conversation, dragging the side and bottom panels stuttered, and the whole window froze for up to a second when an approval arrived or a run finished. Codeshi now skips messages out of view, redraws only what changed, and fetches only the messages that changed. The terminal fits its new size once a drag settles.
- The divider above **Files** could only be grabbed a few pixels above its line. It now sits on the line.

## [0.24.0] - 2026-11-04

### Changed

- **Codeshi's colours throughout the app.** Dark is now warm black with cream text, and Light is cream paper with dark ink, the two looks of the logo. Vermilion, the red of the seal, replaces blue for the main buttons, selection, focus and links, including in the alert panel and in Point and tell's toolbar and the outline it draws round the element you pick. Errors and failed checks use a deeper crimson, so they don't look like the accent.
- **シ instead of a small C.** At small sizes the C looked like any letter, so the small marks now use シ ("shi"). Beside the name in the sidebar and in setup it's シ in vermilion; in the menu bar it's シ alone, with a dot in its corner when an agent needs you. The panel at the top of the screen shows シ too, with a dot for what happened: amber when an agent needs you, green when it finished, red when it stopped. The browser tab icon and the smallest app icon sizes show the vermilion seal carved with シ, and larger icons keep the brush C with its seal.

### Fixed

- A step that reads or writes a file outside the workspace, such as an agent's own temporary files, showed the whole path, cut off before the file's name. It now shows the last folder and the name, such as `…/after/screenshot.png`, with the full path when you point at it.

## [0.23.0] - 2026-11-03

### Changed

- **Throughline is now Codeshi.** The app, its menus, alerts, setup and installers use the new name. Existing installations keep their workspaces, conversations, settings, undo history and permissions. The installers replace Throughline with Codeshi, including the Windows Start menu entry. Exported conversations are saved as `.codeshi.json`, and `.throughline.json` files still open.
- **A new C logo in Paper and Ink.** The brush-stroke C has a red seal carved with シ ("shi"): black ink on paper, or cream on black in dark mode. On macOS 26 and later the app icon follows the system's light, dark, tinted and clear looks; earlier versions and Windows show Paper. The menu bar, welcome animation and in-app logos use the same mark, with simpler artwork at small sizes.
- Codeshi's Mac updater accepts releases under both repository names. After the GitHub repository is renamed to `codeshi`, Throughline 0.22 and earlier need the installer once because their updater only accepts download URLs under the old name. Their saved data is preserved; later updates work from inside Codeshi. A copy updated from inside the app keeps its old Applications folder name until the installer replaces it.

## [0.22.0] - 2026-11-03

### Added

- **Build, then review** (#15). Turn on **Review after** for a prompt, and when the agent finishes, another agent reviews its changes. Before you send, you see who builds and who reviews, which repositories are reviewed and what the extra run uses. The review starts only after the build succeeds and its tests pass, if any run; it reads a saved copy of the changes, can't change your files, and uses your own account, asking first if that account uses API billing. Its progress shows in the run and above the message box, queued prompts wait for you when it ends, and you choose which findings go back to be fixed. It's one review for one prompt: a failed or stopped build, a usage limit or a restart ends it instead of carrying on.

### Changed

- **Settings** has its own dialog, with **General**, **Accounts**, **Alerts** and **Voice** pages in a sidebar and a search that finds a setting on any page. Each setting is a row with a short description: General has appearance, Keep awake, handoffs and updates; Accounts has agent connections and billing; Alerts also has the recap for when you come back. **Ask a friend** opens on its own, and folders and remembered approvals stay in Workspace settings.
- Runs are easier to read. What the agent says between its steps is now the main text, brighter and larger than the steps around it, with room above and below. A step that changes several files lists them one per line, each file's name stronger than its folder, with the lines it added and removed. A command step leaves off an outer shell wrapper such as `/bin/zsh -lc`; its details still hold the exact command and output. The task plan above the message box is one line with how many steps are done and the current one, and opens into its checklist.
- **Alerts** are in one place. **Settings › Alerts** replaces the Sounds section: each way Throughline tells you about work while you're in another app (a banner, a sound, bouncing the Dock icon and the badge on it) is a row you turn on or off, with a box for each moment it's for: an agent needs you, a task finished or a task stopped. The banner style (a macOS notification or the panel at the top of the screen), the volume and the menu bar status are set there too. In the menu bar, **Agent › Alerts** and the same menu in Throughline's status item turn each way on or off, and **Alert Settings…** opens the section. Your current choices carry over.

### Fixed

- Background reviews now get the project's saved brief, like reviews in the conversation, and are saved before their agent starts, so one cut short by Throughline closing shows as interrupted after a restart.
- The panel at the top of the screen could cover the "While you were away" recap: an approval's panel stayed up after you came back to Throughline. It now closes when Throughline comes to the front, where the recap and the request already show.

## [0.21.2] - 2026-11-03

### Added

- **Terminal tabs and split panes** (#70). A workspace keeps up to eight shells: each is a tab, listed at the right of the terminal and named after its folder, **+** opens another in a folder you choose, and a tab splits into two panes, side by side or stacked (⌥), each its own shell. Input goes only to the pane it was typed in, the trash button ends the shell you're in, closing a tab ends its shells, and a shell that exited can start again in its place. ⌃⇧` opens another shell.
- **Questions from agents.** When Claude stops to ask you to choose, such as which library to use, the question shows where approvals wait: its choices with the agent's suggestion marked **Recommended**, and room for your own answer. Several questions show one at a time, as tabs. Choose with a click or a number key, then **Submit**, or **Skip** to let the agent decide. The agent waits as it does for an approval, with the same alerts and sound, and your answers stay in the conversation for the next agent. Codex's questions work the same way where its connection asks them.

### Changed

- **Run says where each command runs** in a workspace with several folders: commands are listed under their folder, with **+** to add one there, a command in a subdirectory names it, the selected command's output starts with its folder, and the commands found in each folder are offered under its name.
- **Add folder** takes several folders at once: type one path per line, or use **Choose folders…** and select several in the folder picker. They are added together, and none is added if one of them can't be opened. **New workspace** and the first-run setup can choose several folders in the picker too.
- Updating takes two clicks on the status bar and no reading: **Update to 0.x.y** is a blue button that downloads the update and checks it, with a ring that fills instead of megabytes, and then **Restart to update** restarts into it. Restarting still waits for any agent at work, and quitting instead puts the update in place as Throughline closes. The release notes and **Skip this version** are in the chevron beside the button. `npm run start:update-demo` shows the whole flow from a source checkout without downloading or replacing anything.

### Fixed

- A message that wrapped to three lines showed a scroll bar in the message box, though all of it was visible. The box now grows a pixel more and only scrolls once it reaches its full height.
- Imported chats went after newer messages, so with little room for context an agent could lose today's request and keep an old reply. Imported messages now go in time order between runs, never inside one; conversations imported before keep their order ([#55](https://github.com/AhmedNavaz/codeshi/issues/55), [#76](https://github.com/AhmedNavaz/codeshi/pull/76)).
- Files pasted or dropped while another attachment was uploading, including a screenshot picked in the preview, were silently dropped. They now wait their turn, sending waits for all of them, and any problems show together ([#77](https://github.com/AhmedNavaz/codeshi/pull/77)).
- Cancelling the removal of a workspace moved keyboard focus to the first workspace in the list; it now returns to the one you kept ([#78](https://github.com/AhmedNavaz/codeshi/pull/78)).
- Exporting a long conversation, or previewing a long chat to import, could keep Throughline from answering anything else for several seconds while it trimmed the history to fit the 2 MB limit, because it measured the whole file again after each message it dropped. Each message is now measured once, so trimming takes a fraction of a second and keeps the same messages ([#79](https://github.com/AhmedNavaz/codeshi/pull/79)).

Thanks to [@seeebbii](https://github.com/seeebbii) for the import, attachment, focus and long-history fixes.

0.21.0 and 0.21.1 were tagged but not published: checks that run before the builds are released failed, a test of the update demo on Windows and the preview screenshot check on Apple Silicon build machines. 0.21.2 is the same release with both checks fixed.

## [0.20.0] - 2026-11-03

### Added

- **Undo a run** (#20): Throughline saves the workspace folders before and after every run, whichever agent ran it, in its own data folder rather than your project's Git repository. A run that changed files ends with **3 files changed · Undo**. Undo previews every file and the exact lines that change before anything is written, takes the run's edits out of files you changed since when they don't overlap, leaves the rest as they are, and adds a note so the next agent knows. **Redo** puts the changes back.
- **Sounds** for alerts: a short sound when an agent needs your approval or a decision, when a task finishes, and when a task stops because of an error, a usage limit or failing tests. Turn each on or off and hear it first in **Settings › Preferences › Sounds**, set the volume, and choose to hear them only when Throughline isn't in front. Throughline plays them itself, so they work without notification permission, in the desktop app and in a browser.
- Changed images in the Git panel open as pictures, before and after, instead of a note that a binary file changed.

### Changed

- Notification banners are silent, and the Agent menu's **Play Notification Sound** is now **Play Sounds**, which turns on the new sounds. It no longer depends on banners being on.
- A run's steps are coloured by kind, so changes stand out: reading and searching in blue, commands in purple, edits in amber, new files in green and deleted files in red, with the web and other agents in their own colours. Each changed file shows its added and removed lines, and an opened edit shows them as a diff with the unchanged lines around them.
- The bottom panel, with Terminal and Run, has a background of its own, set apart from the conversation above it.

### Fixed

- A step that wrote a very long file showed only **Write**, without the file, because its saved record was cut off mid-line. Long tool input is now shortened inside the record, which stays readable, and steps saved before still show their file.
- New files from Codex's app-server connection showed as **Edit**; they now show as **Create**, and Codex file changes are saved without their full diffs, which kept conversations larger than needed.

## [0.19.0] - 2026-11-02

### Added

- **Point and tell** (#19, desktop app): **Preview** beside a running dev server in Run opens it in a preview window. **Pick element** outlines what is under the pointer, and a click puts it into the message box as a sentence (where it is, its text, a selector and, from the app's development build, its source file and line) with a screenshot attached, for you to say or type what should change. The preview shows local addresses only, keeps its own cookies and storage, opens no windows, downloads or permissions, and runs the picker apart from the page's scripts.

### Changed

- **Terminal and Run share one bottom panel**, with a tab each, and both are always in the status bar, so a hidden tool is one click away. ⌘J shows or hides the panel as you left it, ⌃` the terminal. Hiding never stops what runs in it.
- **Plan usage moves to the Agents panel**, at the top: each connected agent shows what its tightest limit has left as a bar, with the limit named in words and its reset time underneath ("5-hour limit · resets 3:40 pm", "Weekly limit for Opus") instead of abbreviations; selecting it shows all its limits, and selecting an agent that isn't connected opens its setup. The status bar keeps Terminal and Run on the left and your settings on the right. The composer still shows the selected agent's tightest limit.
- **A clearer terminal.** Its header names the shell and folder (zsh · acme-shop) with icon actions; when the shell exits, one line under its output says so instead of a separate message; with several folders, each is a button that opens the shell there; and the text is a little larger with more room around it.
- **Run is rebuilt around its output.** A workspace keeps up to 12 named commands, such as its dev server, tests, build or linter, instead of one Run and one Test command. With none yet, Run offers what the folder defines: `package.json` scripts, `Makefile` targets and the usual Cargo, Go and Python commands, found without running anything. The list shows each command's state; the selected one's output keeps its colours, with links to local addresses and Start, Stop, Restart, Edit and Clear. **Ask an agent to fix it** puts a failed command and the end of its output in the message box to read and send. The status bar shows how many commands run, or that one failed. One command can be marked for Check with tests (#12). Commands saved before appear as Run and Test.

### Fixed

- When the first alert after starting was taken away before its panel had loaded, such as an approval answered right away in the window, an empty, invisible panel no longer stays under the menu bar catching clicks (macOS).

## [0.18.0] - 2026-11-02

### Added

- **Status in the menu bar** (#13, macOS): Throughline's mark in the menu bar says what needs you, or what the working agent is doing, in general words and counts, never commands, chat text or file paths. Its menu lists busy workspaces, approvals first, opens the workspace or the request without answering it, and shows Keep Awake. Hide it from the menu itself or the Agent menu.
- **Alerts near the top of the screen** (#13, macOS, off by default): a small panel under the menu bar takes the place of notification banners, never takes the keyboard, stays off full-screen apps, and opens the workspace or the request when clicked. An approval stays until it is answered or dismissed.
- **Check with tests** (#12): under **Routing** in the Agents panel, a routed run that changes files is followed by the workspace's own **Test** command from **▶ Run**, shown on the run's timeline and in the Test panel, where it can be stopped. If the tests fail, routing tries once more with the same agent, one step up in model or effort, and tells it what failed: on its own in Balanced and Maximum quality, after asking in Cost saving or when the agent is near its limit. A retry is never retried, queued prompts wait until the tests pass, and the panel shows how checked runs went.

## [0.17.0] - 2026-11-02

### Added

- **Preferences** in Settings: appearance, updates, voice and recaps now have their own tab beside **Connections**, which keeps the agent accounts.
- **While you were away** (#22): coming back after two minutes or more, a short recap shows, for each workspace, the runs that finished, stopped or are still working, the files they changed and whether they ran the tests, and what is waiting for you: approvals, handoff offers, usage-limit waits, queued prompts and uncommitted changes. It is put together from what Throughline recorded, with no agent call, can be read aloud, and opens at any time from the search bar.
- **Voice** (#11, macOS): press ⌥⌘V or the microphone beside Send and speak; what you say appears in the message box as it is heard, for you to review and send, and Esc cancels. Speech is recognized on your Mac by Throughline Speech, a small helper that ships with the app, using Apple's on-device recognition, so the audio never leaves your Mac. **Send when I stop talking** in **Settings › Preferences › Voice** sends after a three-second countdown that Esc cancels. When a run you started by voice finishes, a short summary of what it did is read aloud with your system's voice. It is put together from what the run recorded, so it costs no agent usage, and can be turned on for every run or off.

## [0.16.0] - 2026-11-02

### Added

- **Throughline for Windows** (#5): a 64-bit Windows build, published with each release beside the macOS builds. Install it from PowerShell with `irm https://raw.githubusercontent.com/AhmedNavaz/codeshi/main/install.ps1 | iex`, which checks the download against the release's published checksum, installs it in your user folder and adds it to the Start menu; run it again to update. Or unzip the release's Windows zip anywhere. The build is not signed yet, so Windows may ask you to confirm a browser download once. On Windows, the terminal opens PowerShell 7 when it is installed, otherwise Windows PowerShell, and ending a session stops everything it started; the taskbar button flashes when a run finishes or needs approval while you are elsewhere; Keep awake, Git activity and commits, project commands and the folder picker work as on macOS. Claude Code and Codex installed with npm or pnpm are found and started directly, never through a shell, and Git is always started from where it is installed, never from a program of the same name in a workspace folder. Updates install from inside the app on macOS only, and installing the Google connection from Settings is not available on Windows yet.

## [0.15.0] - 2026-11-02

### Added

- **Update from inside the app** (#2): when a newer release is out, **Update available** and its version appear in the status bar, with a link to the release notes. **Update and restart** downloads the build for your Mac, checks it against the release's published checksum and checks the app inside (its version, bundle ID and signature), then quits, replaces the app and reopens it with your workspaces as they were. While an agent works, or a queued prompt is about to start, the update downloads and Throughline restarts once no agent is working, never in the middle of a run. A version can be skipped, **Throughline › Check for Updates…** checks at any time, and **Settings › Updates** turns automatic checks (at launch and every six hours) off. A copy that can't replace itself, such as one opened straight from Downloads, offers the download instead.
- **Commit from the Git panel** (#6): stage or unstage each changed file, or everything in the folder, and commit with a message without leaving Throughline. Staged files are listed apart; with nothing staged, **Commit all** commits every change listed. The commit holds exactly what the panel shows: anything staged meanwhile, or outside the workspace folder, stops the commit until you review it. Commits use your own Git name, email, signing and filters, and run the project's commit hooks as your terminal would; if a hook stops the commit, its output is shown and **Commit without hooks** is a separate choice. Throughline never pushes.
- **Terminal** (#7): your shell in a panel under the conversation, opened from the new bottom-panel button at the top right, ⌃` or **View › Terminal**. Each workspace has its own session in the folder you choose, with full interactive input, colours, resizing and copy and paste. Hiding the panel or switching workspaces leaves the session and what it runs, such as a dev server, running; **End session** stops the shell and everything it started, as do removing the workspace and quitting. It is your own shell, so agent access settings don't apply to it.

### Changed

- Each run now reads as one thread under the agent's name, model and effort. Its replies and every step sit on one line in order, each step showing what it did in a single line, such as **Run** `npm test` or **Read** `src/app.js`, with a chevron for the full output, edit or result. Steps are no longer folded into a "Worked through" summary, and notes from full auto-approval are no longer listed. The run's status line is the last step of its thread and its only live indicator (**Thinking**, **Working**, **Writing** or **Waiting for your approval**, with the elapsed time); its details hold token and context counts instead of repeating the agent, model, permission setting and step count.

## [0.14.0] - 2026-11-02

### Added

- **Routing** (#12): Throughline can pick the agent, model and reasoning effort for each message, in Cost saving, Balanced or Maximum quality mode. Choose it under **Routing** in the **Agents** panel; while it is on, the model button in the message box shows the mode. A line above the message box shows the choice and the reason before you send, and a note under the prompt keeps it. Routing uses simple rules on your message, never a model call; it keeps the conversation's agent unless that agent is near its limit, never picks one at 95%, only uses subscription-billed agents unless you allow API billing, and matches effort to the levels each model supports. Choosing a model yourself turns it off.
- **Add to run**: while an agent works, ⌘↵ (Ctrl+Enter on Windows and Linux) adds your message to the task it is already doing instead of queueing it, so you can add a point or correct yourself without stopping the run. Codex and Claude take the note at their next step; Gemini continues the same session with it. The note appears inside the run, and if the run finishes first it runs next from the queue.
- **The agent's plan as a to-do list**: when an agent plans a task in steps, a line above the message box shows how many are done and what it is working on, and opens into the full list. It follows the agent's own plan from Codex or Claude as the run goes, and from Gemini when its connection reports one.
- **Handoff** (#17): once a cloud agent passes 90% of a plan limit during a run, an offer names the agent with room that would continue the task, with its model, billing, access and the task itself. **Hand off** stops the run and continues it there from the shared conversation; **Not now** keeps going. A destination billed outside a subscription needs its charges accepted separately, and an offer is checked again just before switching, so a changed task, folders, project context or destination settings start nothing and show an updated offer instead. **Handoff** in the **Agents** panel (also **Agent › Hand Off Near Usage Limits**) sets the threshold (80, 90 or 95%) or turns offers off, and can allow handing off automatically to subscription-billed agents only.
- **Queue prompts** (#32): while an agent works or a task waits for a reset, **Queue** adds a message to **Up next**. Queued prompts run one after another with the settings shown on each, never more; they can be reordered, edited and removed until they start. A queued run that reaches a usage limit waits for a reset and the queue carries on; any other stop, or a restart, pauses the queue until you resume it.
- Approvals are hard to miss (#46): a workspace waiting for approval shows how many requests in the sidebar, even while another workspace is open, and an approval notification opens that exact request without answering it. Notifications name the workspace and agent but never show commands, chat text or file paths. **Notify When Runs Finish or Need Approval** and **Play Notification Sound** in the **Agent** menu turn alerts off or add a sound; sound is off by default.
- **Allow for this run** and **Always allow in this workspace** on approvals (#68): an approved action can run again without asking, for the rest of the run or remembered for the workspace. A rule covers only the exact action: the agent, the exact command and its folder (single commands only), or the exact file to edit. The activity log names the rule that allowed an action, and **Workspace settings** lists remembered approvals to revoke one or all. Rules stay with their workspace.
- **Continue when a limit resets** (#32): after a run stops on a usage limit, the task can wait and continue on whichever connected agent has room first, using each agent's reported reset time or checking every ten minutes when none is reported. The continued run keeps the access shown on the wait and never gets more; full auto-approval applies only if you keep it when you choose to wait. When you are in another app, the Dock badge counts what happened and bounces when an approval is waiting; system notifications are added where macOS allows them, which requires a signed build (#1). This covers every run, not only continued ones. The wait survives restarts, Keep awake covers it, and it ends after a day, when cancelled, or when you send a message yourself.

### Changed

- A new layout. The top bar is a search bar (⌘K) that finds workspaces, files in every workspace (start with > for actions only) and actions, including **Review changes**, **Ask a friend**, **Previous chats** and **Export conversation**; those tools are also in the desktop **File** menu, which now has **Ask a Friend…**, and Review and Ask a friend still appear under a finished run when there are changes. A side panel on the right holds **Agents** and **Git**, switched by icon tabs at its top; it opens on the tab last used, **Agents** on first launch. Two layout buttons at the top right, as in an editor, show or hide the sidebar (⌘B) and the side panel, each filled while its area shows; with the sidebar hidden, the top bar names the open workspace. The **Agents** panel holds the **Routing** and **Handoff** settings, each with a short description, and Git's refresh sits beside its repository. **▶ Run** moves beside **Files** in the sidebar. A new conversation lists what Throughline does, with links to the matching settings.
- The sidebar, the side panel, the split between workspaces and files, and the Run panel are resizable. Drag a handle or use the arrow keys on it, double-click to reset; sizes are remembered.
- The model picker lists models only: each agent's own default is **Let Codex choose** (or Claude, Gemini), and a reasoning effort left to the agent reads **Default**. The attach button in the message box sits in its own small box.
- **Continue** after a stopped run offers any agent and model: the button keeps its suggestion and now names the model, and the menu beside it lists every connected agent's models, including the agent that stopped, and continues with the one you choose.
- **Ask for permission** is now **Ask before changes**: actions that only read your workspace folders, such as reading and searching files and read-only commands like `ls`, `rg`, `git status` and `git diff`, run without asking. Editing or deleting files, installing, running scripts or tests, network access, reads outside the workspace and any command Throughline cannot fully judge still ask (#68).
- A calmer conversation: your prompts are bubbles, agent replies read as open text under one header per run, and workspace activity is a single line that shows the current step live and opens into one row per action with its output a click away. Run status, permission requests, errors and **Continue** are quiet lines with pill buttons instead of boxed panels.
- While its results scroll past, a prompt stays at the top of the conversation until the next prompt takes its place, so it is always clear which request the work below belongs to. A long prompt shows its first lines with **Show more**. Run status, permission requests, **Continue** and follow-up actions appear under the latest turn instead of between the conversation and the message box.
- The message box keeps its controls on one line, turning access and permission pickers into icons when space is short.
- A new model picker: one searchable menu with a section per agent, compact rows, **More models** for the rest of each list, and keyboard navigation. The button shows the model's name, such as "Sonnet 5.5". Reasoning effort has its own control beside it, shown as signal bars, so it can be changed right after switching models: a slider over the levels the chosen model supports, coloured from cool to warm as effort rises, with a short note on what each level means. **Auto** leaves the level to the agent and says what that agent does: Claude and Gemini adjust their thinking to the task, and Codex uses its default level. Choices are saved per workspace conversation, agent and model, and persist across restarts.

### Fixed

- Throughline no longer gets blocked with "Another operation is updating server.lock" after it was stopped at the wrong moment, such as a force-quit while closing. A file guard is now created with its owner already inside, in one step, so it can never be left empty, and an empty guard left by an earlier version is replaced at once. Guards with an owner that is still running, or with contents Throughline can't verify, stay protected as before.
- Running Throughline from source no longer collides with an installed release. It opens as **Throughline Dev**, with its own data folder, window and single-instance lock and a **Dev** label, so an agent working in the installed app can start and test the source version side by side. Agents and the commands they run also no longer inherit the worker's `ELECTRON_RUN_AS_NODE` setting, which made an Electron app they started fail.
- Gemini (Google Antigravity) connects reliably and faster. On networks where Google's servers stall secure connections over IPv6, the runtime used to hang for ten seconds and fail with "Internal error", so status showed Checking, Not verified or unavailable and models rarely loaded. Throughline now gives the runtime a local relay that reaches Google over IPv4 first, falling back to IPv6. The relay only tunnels encrypted connections to Google, and a proxy you configured yourself still takes precedence. Opening the app checks the account and its models together in one runtime start, reuses a signed-in result for a minute, and reports a Google network failure in plain words.
- Cross-agent continuation preserves task intent before verbose tool logs: original and recent user instructions take priority, saved project context remains intact, and oversized historical output is passed as bounded excerpts. Full conversation journals remain saved (#69).
- Switching agents rebuilds a fresh native session from shared project history, including when returning from a local run; consecutive same-agent turns retain native resumption. Run details identify fresh or resumed sessions and show how much history was included, omitted or compacted.

## [0.13.0] - 2026-11-01

### Added

- **Project command controls (#47)**: Configure, inspect, and run persistent local commands (such as dev servers and test runners) for each workspace with separate Run and Test actions. Includes inert script detection from `package.json`, bounded UTF-8 output logs with clickable local URL actions, active process badges, and stop/restart controls that remain running during agent editing.

### Changed

- Local backend modules now live in `src/`, with updated launch paths, tests, sharing-container inputs and contributor documentation. The repository root focuses on project information and configuration; saved-data locations and npm commands remain unchanged.

## [0.12.0] - 2026-11-01

### Added

- Workspace permission controls offer **Ask for permission** and **Full auto-approval**, with the selected policy saved per workspace and recorded for each run.
- Native Gemini conversation discovery, previews and imports join Claude Code and Codex in the shared workspace history. The conversation picker can filter by agent.

### Fixed

- Read-only work and background reviews cannot inherit full auto-approval, and imported conversations never change the workspace’s permission policy.
- Native Gemini history databases are opened read-only with bounded queries; transcript previews are size-limited and reject paths outside the native store or conversations not linked to the selected workspace.
- Conversations attached through a secondary workspace folder remain previewable. Truncated previews are explicitly marked.
- Guard recovery retries a lost-ownership rename race on macOS while preserving guards after unexplained filesystem failures.

## [0.11.3] - 2026-11-01

### Fixed

- Gemini account usage now reads the official Antigravity usage report instead of estimated percentages or old CLI logs. Missing quota remains unavailable, and absolute or disabled limits are shown without fabricated progress bars.
- Usage follows the native model default, clears on sign-out, and is cached separately for each Google connection profile. Cached account names no longer substitute for verification of this connection’s authentication.

## [0.11.2] - 2026-11-01

### Added

- **Multi-window Gemini quota tracking**: Separate rolling 5-hour and weekly allowances for Gemini 3.8 Flash, alongside dedicated weekly quota tracking and reset countdowns for Gemini 4 Argon.
- **Minimal model selector**: Streamlined glassmorphic model picker with dark blurred backdrop, fast segmented agent tabs, and instant model selection.
- **Background model preloading**: Agent catalogs and local Ollama models preload automatically in the background on startup and workspace switch, eliminating manual refresh actions.

### Fixed

- Google Antigravity (`agy`) CLI is given automatic priority for Gemini connections over deprecated Gemini CLI installations.
- Antigravity model listings now filter exclusively for native Gemini models.
- When Gemini 4 Argon reaches its weekly limit, the interface dynamically defaults to the active Gemini 3.8 Flash tier rather than reporting complete account exhaustion.

## [0.11.1] - 2026-11-01

### Fixed

- New filesystem transaction guards record their process identity and recover automatically after that owner exits or crashes, preventing an interrupted operation from permanently blocking workspace startup.
- Concurrent recovery preserves exclusive access, including when a recovery process itself crashes; live owners, unrecognized guards and legacy empty guards remain protected for manual inspection.

## [0.11.0] - 2026-10-31

### Added

- **Background code review** checks an approved snapshot of selected files in a separate read-only worker, with live results in a side panel while you send the next prompt; later edits mark findings outdated.
- **A grouped, searchable agent and model picker** lists cloud agents and downloaded Ollama models together, with local selections scoped to each workspace and used by the normal Send button.
- **Ask a Friend previews** are prepared from the current task and recent conversation, with optional changed source files and explicit export or private-link sharing; detailed controls remain in the advanced editor.
- **Google Antigravity connection** adds a checksum-verified official runtime download, personal Google sign-in, account-provided models and thinking levels, and one-time ACP tool approvals.
- Local composer runs support text and code attachments, while unsupported images remain saved until removed or sent to a cloud agent.

### Fixed

- Review and Ask a Friend shortcuts require the existing file selection, exact preview, billing confirmation and sharing approval steps before running an agent or publishing material.
- Local handoffs require an explicit downloaded model choice and preserve cloud preferences, composer drafts and unsent attachments across workspace switches and retries.
- Personal Google setup now uses Antigravity ACP instead of directing consumer accounts to Gemini CLI. Plain Antigravity headless runs stay blocked; read-only work uses Codex or Claude. Gemini CLI 0.66.0+ remains an advanced API-key/enterprise option.
- Google account status and billing are no longer inferred from cached account names, and failed model discovery never invents available models.

### Changed

- The composer uses a two-line agent/model control with a searchable grouped panel, alongside reasoning effort and workspace access controls.
- Completed runs offer review and collaboration next steps that respect the current workspace and stay dismissed until another run completes.

## [0.10.1] - 2026-10-31

### Added

- **Google Antigravity (`agy`) for Gemini**: Gemini now connects through the official Google Antigravity CLI (`agy`) with your Google account, featuring real-time streaming, safe workspace edit permissions, and model selection filtered exclusively for Gemini models.
- **Agent installation guidance**: When an assistant is not detected, Settings and the connection banner display the install command and a direct link to the setup guide.

### Changed

- **What’s New** in the app now shows short, plain-language highlights from the user's perspective without GitHub issue or pull request numbers. Select **Full release notes** at any time to read the complete technical story on GitHub.

### Fixed

- Throughline now finds Gemini CLI / Antigravity, Claude Code and Codex installed with Volta, nvm, pnpm, Bun, mise, asdf or fnm when opened from Applications on macOS. Child CLI runs also keep that runtime directory on `PATH` so Node-based shims start reliably.

## [0.10.0] - 2026-10-31

### Added

- **Gemini**: use Gemini CLI alongside Claude Code and Codex in the same project conversation, signed in with your own Google account. Runs over the Agent Client Protocol (`0.66.0+`) with read-only and edit access modes, isolated per-run policies, in-app approvals for edits and shell commands, verified custom model selection, quota and interruption handoffs, and conversation export ([#4](https://github.com/AhmedNavaz/codeshi/issues/4)).
- **Continue locally**: hand off a task to a downloaded Ollama coding model with your saved project context and workspace approvals. Uses Codex's native workspace tools with separate model and billing attribution, preserves cloud settings and sessions, and never falls back to a cloud model ([#4](https://github.com/AhmedNavaz/codeshi/issues/4)).
- **What’s New** shows recent highlights right after an update and from **Help › What’s New**, including while offline. Dismiss it once per update or open the full release notes for every technical detail.

### Fixed

- Updating or reinstalling the desktop app opens your saved workspaces directly instead of asking to continue or start fresh. Version tracking replaces app-bundle identity checks, and new profiles still receive first-run setup.

## [0.9.1] - 2026-10-31

### Fixed

- Runs ended by the broker for oversized output or a provider-message handling failure now retain the actual error instead of appearing as a user stop. A later Stop does not replace that reason, and failed cross-agent reviews are reported as failures ([#61](https://github.com/AhmedNavaz/codeshi/pull/61)).
- Enter and Escape shortcuts in the workspace filter, workspace forms, conversation search and file preview leave in-progress input-method composition alone ([#62](https://github.com/AhmedNavaz/codeshi/pull/62)).
- After a model or effort selection fails to save, the pickers return to the saved values that the next run will use ([#63](https://github.com/AhmedNavaz/codeshi/pull/63)).
- Removed and sent image attachments release their cached thumbnails when no workspace draft still uses them, reducing memory retained during long sessions ([#65](https://github.com/AhmedNavaz/codeshi/pull/65)).

Thanks to [@seeebbii](https://github.com/seeebbii) for these fixes.

## [0.9.0] - 2026-10-31

### Added

- Cross-agent code review: choose current Git changes, preview their exact scope, then ask the other agent for a fresh read-only review. Saved findings include severity and file locations, preserve the original reviewed diffs, and become outdated when selected files, the Git base or workspace folders change. Selected findings can prepare a fix draft for the builder without starting it automatically. Review runs preserve coding preferences and sessions, retain explicit usage/billing consent, and support cancellation ([#15](https://github.com/AhmedNavaz/codeshi/issues/15)).

### Fixed

- Git diff path arguments are treated literally, so a filename containing wildcard characters cannot expand the selected scope.
- Before the first Git commit, a new staged file's diff includes its current working contents, including edits made after staging.

## [0.8.0] - 2026-10-31

### Added

- Native desktop menus for workspace, conversation, agent and appearance controls, with their keyboard shortcuts and current selection states. Help links open the guide, roadmap, release notes and feedback forms; bug reports include the app and system versions ([#59](https://github.com/AhmedNavaz/codeshi/pull/59)).

### Fixed

- Conversation files exported near the 2 MB limit can be imported again, including formatted JSON files that grow beyond 2 MB on disk. Multiple valid large files can also be imported together while retaining per-file limits and the existing limits on other requests ([#54](https://github.com/AhmedNavaz/codeshi/pull/54)).
- Failed **Approve** and **Deny** actions show a visible notice. Approval cards refresh after either outcome, removing stale requests and allowing pending requests to be retried ([#56](https://github.com/AhmedNavaz/codeshi/pull/56)).
- Failed lock and lease writes no longer leave partial files that block later changes. Failed updates preserve existing leases, and unreadable older files are named without clearing unknown owners ([#57](https://github.com/AhmedNavaz/codeshi/pull/57)).
- Startup and save errors identify a damaged settings file and explain how to recover. The file is preserved, along with the running settings, when it cannot be read ([#58](https://github.com/AhmedNavaz/codeshi/pull/58)).
- Claude run cards include cache reads and writes in their input-token total, making the count consistent with Codex. Existing saved runs show the corrected total too ([#60](https://github.com/AhmedNavaz/codeshi/pull/60)).

Thanks to [@seeebbii](https://github.com/seeebbii) for these improvements.

## [0.7.0] - 2026-10-31

### Added

- Find in the conversation with Cmd/Ctrl+F: highlight matches across text formatting and code, move between results, and reveal matches in collapsed activity groups ([#39](https://github.com/AhmedNavaz/codeshi/pull/39), thanks [@seeebbii](https://github.com/seeebbii)).
- System appearance follows your computer's light or dark setting while the app is open. Onboarding, Settings, the status bar and native dialogs share the same preference; existing Light and Dark choices are preserved ([#52](https://github.com/AhmedNavaz/codeshi/pull/52), thanks [@seeebbii](https://github.com/seeebbii)).

### Fixed

- A failed conversation save no longer corrupts the next saved message. Empty or incomplete unused journals no longer prevent the workspace from opening after restart ([#41](https://github.com/AhmedNavaz/codeshi/pull/41), thanks [@seeebbii](https://github.com/seeebbii)).
- On a Mac's case-insensitive disk, a folder typed in another letter case is now the same folder: no duplicate workspace or folder, and two agents can't edit it at once. Workspaces saved by earlier versions keep their IDs and history ([#40](https://github.com/AhmedNavaz/codeshi/pull/40), thanks [@seeebbii](https://github.com/seeebbii)).
- Connection status no longer flickers to "Checking…" when you switch back to the app. A slow check keeps the last verified result and is reported as a timeout instead of "not installed", and Settings shows when each connection was last checked ([#50](https://github.com/AhmedNavaz/codeshi/pull/50), thanks [@seeebbii](https://github.com/seeebbii)).
- Newly saved macOS locks and run records identify their owning process, allowing safe recovery when an exited process's ID is reused. Live owners and their child processes remain protected across clock and time-zone changes; older records retain conservative locking behavior ([#42](https://github.com/AhmedNavaz/codeshi/pull/42), thanks [@seeebbii](https://github.com/seeebbii)).
- Onboarding's **Skip for now** and step buttons receive clicks correctly instead of being covered by the window-drag area ([#53](https://github.com/AhmedNavaz/codeshi/pull/53), thanks [@seeebbii](https://github.com/seeebbii)).

### Security

- Packaging dependencies use glob 14.0.2 and minimatch 11.0.1 to address published denial-of-service advisories in cancellation and pattern processing. The overrides apply to Electron's archive tooling ([glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)).

## [0.6.2] - 2026-10-30

### Fixed

- Deliver long agent replies and CLI output completely before the provider worker exits ([#34](https://github.com/AhmedNavaz/codeshi/pull/34)).
- Keep code blocks with language labels such as `constructor` or `__proto__` from blanking the conversation ([#35](https://github.com/AhmedNavaz/codeshi/pull/35)).
- Preserve Unicode characters split across HTTP request chunks ([#36](https://github.com/AhmedNavaz/codeshi/pull/36)).
- Save a custom model on Enter without submitting the conversation draft ([#37](https://github.com/AhmedNavaz/codeshi/pull/37)).
- Import the newest visible messages from long Claude conversations ([#38](https://github.com/AhmedNavaz/codeshi/pull/38)).

Thanks to [@seeebbii](https://github.com/seeebbii) for these five fixes.

## [0.6.1] - 2026-10-30

### Changed

- Tests cover Claude Code and Codex discovery on Windows and Linux ([#31](https://github.com/AhmedNavaz/codeshi/pull/31), thanks @Vamsi-2581).

### Fixed

- The app stays responsive while it checks Claude Code and Codex at launch ([#33](https://github.com/AhmedNavaz/codeshi/pull/33), thanks @ungaaaabungaaa).
- **Start fresh** restarts immediately instead of waiting for launch-time checks to finish.
- Stopping a run on macOS no longer reports a false error or leaves the run marked as running when the agent has just exited ([#30](https://github.com/AhmedNavaz/codeshi/issues/30)).

### Security

- Electron 44.10.0, which no longer trusts the compromised eMudhra intermediate certificates.
- body-parser 2.4.0 and fast-uri 3.1.9, fixing a denial of service from compressed request bodies and URL parsing flaws in the Claude Agent SDK's dependencies.

## [0.6.0] - 2026-10-30

### Added

- Optional suggestions for previous Claude Code and Codex conversations matching an opened workspace's folders, with a remembered **Not now** choice for each workspace.
- `npm run start:fresh` and `npm start -- --fresh` replay onboarding in an isolated temporary profile. Add `--no-agents` to preview setup without installed agents; existing workspaces and CLI sign-ins stay intact.
- Patreon support links in the README and the repository's Sponsor button.
- A contributor architecture guide and a roadmap proposal for an integrated workspace terminal.

### Changed

- Onboarding completes the project-folder step and final summary before opening the workspace and suggesting previous chats.
- **Previous chats** reviews and merges selected conversations into the open workspace. Its folders are the default search scope; browsing other projects and opening shared conversation files remain optional.
- Conversation discovery, import and export have separate interface and HTTP route modules, keeping them independent of Git and account-usage controls.
- Clearer Throughline positioning in the README, welcome screen, package description and social-preview artwork: your workspace for AI coding agents, using your own accounts.

### Fixed

- Workspace-scoped chat discovery excludes Throughline's own agent sessions.
- Desktop packages exclude disposable generated assets in `output/`.

## [0.5.0] - 2026-10-30

### Changed

- A new first-run experience: a launch screen, an animated welcome, three short setup steps and a summary, then the app fades in.
- A newly installed copy that finds saved workspaces asks whether to continue with them or start fresh. Starting fresh keeps the old data as a backup.

## [0.4.0] - 2026-10-30

First public release.

### Added

- Workspaces with one or more folders and one permanent conversation, shared by Claude Code and Codex.
- Switch agents mid-task without losing context, for example when one reaches its usage limit.
- Import existing Claude Code and Codex chats from any project, merged in time order.
- Export a conversation file for another Throughline user, with secrets and local paths redacted.
- Ask a Friend: share an approved snapshot and apply the reviewable patch that comes back.
- Git activity with per-file diffs, a file browser with syntax highlighting, and plan usage for each agent.
- Keep awake, which stops your Mac sleeping while agents are working.
- Dark and light themes, keyboard shortcuts and a short setup guide.
- macOS builds for Apple Silicon and Intel, and a container image for the private-link service.

[0.28.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.28.0
[0.27.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.27.1
[0.27.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.27.0
[0.26.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.26.0
[0.25.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.25.1
[0.24.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.24.0
[0.23.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.23.0
[0.22.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.22.0
[0.21.2]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.21.2
[0.20.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.20.0
[0.19.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.19.0
[0.18.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.18.0
[0.17.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.17.0
[0.16.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.16.0
[0.15.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.15.0
[0.14.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.14.0
[0.13.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.13.0
[0.12.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.12.0
[0.11.3]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.11.3
[0.11.2]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.11.2
[0.11.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.11.1
[0.11.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.11.0
[0.10.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.10.1
[0.10.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.10.0
[0.9.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.9.1
[0.9.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.9.0
[0.8.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.8.0
[0.7.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.7.0
[0.6.2]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.6.2
[0.6.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.6.1
[0.6.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.6.0
[0.5.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.5.0
[0.4.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.4.0
[0.31.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1
[0.30.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.30.0

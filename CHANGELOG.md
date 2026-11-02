# Changelog

Notable changes to Throughline. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Undo a run** (#20): Throughline saves the workspace folders before and after every run, whichever agent ran it, in its own data folder rather than your project's Git repository. A run that changed files ends with **3 files changed · Undo**. Undo previews every file and the exact lines that change before anything is written, takes the run's edits out of files you changed since when they don't overlap, leaves the rest as they are, and adds a note so the next agent knows. **Redo** puts the changes back.

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

- **Throughline for Windows** (#5): a 64-bit Windows build, published with each release beside the macOS builds. Install it from PowerShell with `irm https://raw.githubusercontent.com/AhmedNavaz/throughline/main/install.ps1 | iex`, which checks the download against the release's published checksum, installs it in your user folder and adds it to the Start menu; run it again to update. Or unzip the release's Windows zip anywhere. The build is not signed yet, so Windows may ask you to confirm a browser download once. On Windows, the terminal opens PowerShell 7 when it is installed, otherwise Windows PowerShell, and ending a session stops everything it started; the taskbar button flashes when a run finishes or needs approval while you are elsewhere; Keep awake, Git activity and commits, project commands and the folder picker work as on macOS. Claude Code and Codex installed with npm or pnpm are found and started directly, never through a shell, and Git is always started from where it is installed, never from a program of the same name in a workspace folder. Updates install from inside the app on macOS only, and installing the Google connection from Settings is not available on Windows yet.

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

- **Gemini**: use Gemini CLI alongside Claude Code and Codex in the same project conversation, signed in with your own Google account. Runs over the Agent Client Protocol (`0.66.0+`) with read-only and edit access modes, isolated per-run policies, in-app approvals for edits and shell commands, verified custom model selection, quota and interruption handoffs, and conversation export ([#4](https://github.com/AhmedNavaz/throughline/issues/4)).
- **Continue locally**: hand off a task to a downloaded Ollama coding model with your saved project context and workspace approvals. Uses Codex's native workspace tools with separate model and billing attribution, preserves cloud settings and sessions, and never falls back to a cloud model ([#4](https://github.com/AhmedNavaz/throughline/issues/4)).
- **What’s New** shows recent highlights right after an update and from **Help › What’s New**, including while offline. Dismiss it once per update or open the full release notes for every technical detail.

### Fixed

- Updating or reinstalling the desktop app opens your saved workspaces directly instead of asking to continue or start fresh. Version tracking replaces app-bundle identity checks, and new profiles still receive first-run setup.

## [0.9.1] - 2026-10-31

### Fixed

- Runs ended by the broker for oversized output or a provider-message handling failure now retain the actual error instead of appearing as a user stop. A later Stop does not replace that reason, and failed cross-agent reviews are reported as failures ([#61](https://github.com/AhmedNavaz/throughline/pull/61)).
- Enter and Escape shortcuts in the workspace filter, workspace forms, conversation search and file preview leave in-progress input-method composition alone ([#62](https://github.com/AhmedNavaz/throughline/pull/62)).
- After a model or effort selection fails to save, the pickers return to the saved values that the next run will use ([#63](https://github.com/AhmedNavaz/throughline/pull/63)).
- Removed and sent image attachments release their cached thumbnails when no workspace draft still uses them, reducing memory retained during long sessions ([#65](https://github.com/AhmedNavaz/throughline/pull/65)).

Thanks to [@seeebbii](https://github.com/seeebbii) for these fixes.

## [0.9.0] - 2026-10-31

### Added

- Cross-agent code review: choose current Git changes, preview their exact scope, then ask the other agent for a fresh read-only review. Saved findings include severity and file locations, preserve the original reviewed diffs, and become outdated when selected files, the Git base or workspace folders change. Selected findings can prepare a fix draft for the builder without starting it automatically. Review runs preserve coding preferences and sessions, retain explicit usage/billing consent, and support cancellation ([#15](https://github.com/AhmedNavaz/throughline/issues/15)).

### Fixed

- Git diff path arguments are treated literally, so a filename containing wildcard characters cannot expand the selected scope.
- Before the first Git commit, a new staged file's diff includes its current working contents, including edits made after staging.

## [0.8.0] - 2026-10-31

### Added

- Native desktop menus for workspace, conversation, agent and appearance controls, with their keyboard shortcuts and current selection states. Help links open the guide, roadmap, release notes and feedback forms; bug reports include the app and system versions ([#59](https://github.com/AhmedNavaz/throughline/pull/59)).

### Fixed

- Conversation files exported near the 2 MB limit can be imported again, including formatted JSON files that grow beyond 2 MB on disk. Multiple valid large files can also be imported together while retaining per-file limits and the existing limits on other requests ([#54](https://github.com/AhmedNavaz/throughline/pull/54)).
- Failed **Approve** and **Deny** actions show a visible notice. Approval cards refresh after either outcome, removing stale requests and allowing pending requests to be retried ([#56](https://github.com/AhmedNavaz/throughline/pull/56)).
- Failed lock and lease writes no longer leave partial files that block later changes. Failed updates preserve existing leases, and unreadable older files are named without clearing unknown owners ([#57](https://github.com/AhmedNavaz/throughline/pull/57)).
- Startup and save errors identify a damaged settings file and explain how to recover. The file is preserved, along with the running settings, when it cannot be read ([#58](https://github.com/AhmedNavaz/throughline/pull/58)).
- Claude run cards include cache reads and writes in their input-token total, making the count consistent with Codex. Existing saved runs show the corrected total too ([#60](https://github.com/AhmedNavaz/throughline/pull/60)).

Thanks to [@seeebbii](https://github.com/seeebbii) for these improvements.

## [0.7.0] - 2026-10-31

### Added

- Find in the conversation with Cmd/Ctrl+F: highlight matches across text formatting and code, move between results, and reveal matches in collapsed activity groups ([#39](https://github.com/AhmedNavaz/throughline/pull/39), thanks [@seeebbii](https://github.com/seeebbii)).
- System appearance follows your computer's light or dark setting while the app is open. Onboarding, Settings, the status bar and native dialogs share the same preference; existing Light and Dark choices are preserved ([#52](https://github.com/AhmedNavaz/throughline/pull/52), thanks [@seeebbii](https://github.com/seeebbii)).

### Fixed

- A failed conversation save no longer corrupts the next saved message. Empty or incomplete unused journals no longer prevent the workspace from opening after restart ([#41](https://github.com/AhmedNavaz/throughline/pull/41), thanks [@seeebbii](https://github.com/seeebbii)).
- On a Mac's case-insensitive disk, a folder typed in another letter case is now the same folder: no duplicate workspace or folder, and two agents can't edit it at once. Workspaces saved by earlier versions keep their IDs and history ([#40](https://github.com/AhmedNavaz/throughline/pull/40), thanks [@seeebbii](https://github.com/seeebbii)).
- Connection status no longer flickers to "Checking…" when you switch back to the app. A slow check keeps the last verified result and is reported as a timeout instead of "not installed", and Settings shows when each connection was last checked ([#50](https://github.com/AhmedNavaz/throughline/pull/50), thanks [@seeebbii](https://github.com/seeebbii)).
- Newly saved macOS locks and run records identify their owning process, allowing safe recovery when an exited process's ID is reused. Live owners and their child processes remain protected across clock and time-zone changes; older records retain conservative locking behavior ([#42](https://github.com/AhmedNavaz/throughline/pull/42), thanks [@seeebbii](https://github.com/seeebbii)).
- Onboarding's **Skip for now** and step buttons receive clicks correctly instead of being covered by the window-drag area ([#53](https://github.com/AhmedNavaz/throughline/pull/53), thanks [@seeebbii](https://github.com/seeebbii)).

### Security

- Packaging dependencies use glob 14.0.2 and minimatch 11.0.1 to address published denial-of-service advisories in cancellation and pattern processing. The overrides apply to Electron's archive tooling ([glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)).

## [0.6.2] - 2026-10-30

### Fixed

- Deliver long agent replies and CLI output completely before the provider worker exits ([#34](https://github.com/AhmedNavaz/throughline/pull/34)).
- Keep code blocks with language labels such as `constructor` or `__proto__` from blanking the conversation ([#35](https://github.com/AhmedNavaz/throughline/pull/35)).
- Preserve Unicode characters split across HTTP request chunks ([#36](https://github.com/AhmedNavaz/throughline/pull/36)).
- Save a custom model on Enter without submitting the conversation draft ([#37](https://github.com/AhmedNavaz/throughline/pull/37)).
- Import the newest visible messages from long Claude conversations ([#38](https://github.com/AhmedNavaz/throughline/pull/38)).

Thanks to [@seeebbii](https://github.com/seeebbii) for these five fixes.

## [0.6.1] - 2026-10-30

### Changed

- Tests cover Claude Code and Codex discovery on Windows and Linux ([#31](https://github.com/AhmedNavaz/throughline/pull/31), thanks @Vamsi-2581).

### Fixed

- The app stays responsive while it checks Claude Code and Codex at launch ([#33](https://github.com/AhmedNavaz/throughline/pull/33), thanks @ungaaaabungaaa).
- **Start fresh** restarts immediately instead of waiting for launch-time checks to finish.
- Stopping a run on macOS no longer reports a false error or leaves the run marked as running when the agent has just exited ([#30](https://github.com/AhmedNavaz/throughline/issues/30)).

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

[0.19.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.19.0
[0.18.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.18.0
[0.17.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.17.0
[0.16.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.16.0
[0.15.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.15.0
[0.14.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.14.0
[0.13.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.13.0
[0.12.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.12.0
[0.11.3]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.11.3
[0.11.2]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.11.2
[0.11.1]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.11.1
[0.11.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.11.0
[0.10.1]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.10.1
[0.10.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.10.0
[0.9.1]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.9.1
[0.9.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.9.0
[0.8.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.8.0
[0.7.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.7.0
[0.6.2]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.6.2
[0.6.1]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.6.1
[0.6.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.6.0
[0.5.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.5.0
[0.4.0]: https://github.com/AhmedNavaz/throughline/releases/tag/v0.4.0

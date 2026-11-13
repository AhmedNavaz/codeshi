# Changelog

Notable changes to Codeshi, called Throughline until 0.23; earlier entries use the name each version shipped under. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.50.0] - 2026-11-13

### Added
- **Flow suggests splitting a message into tasks** ([#107](https://github.com/AhmedNavaz/codeshi/issues/107), [#108](https://github.com/AhmedNavaz/codeshi/issues/108)). On Smart and Ultra, the rating every Flow message already gets can also find separate pieces of work in it, up to four, without an extra run. Nothing starts then: a card above the message box lists each part, the agent and model routing would pick for it, and whether it uses your subscription or bills by use. **Run as tasks** makes the parts cards on the Plan, in a group named after the message, and runs them side by side, each part waiting for the parts it needs. **Do it as one** runs the message as usual, with the rating it already has, and **×** puts it back in the message box. Charges need their own yes. **Split without asking**, off by default, skips the card only when every part would use an agent on a subscription. The parts share the message's task limits: working time, tokens, spending, retries, reviews and handoffs count across all of them. Saver, queued prompts, messages with attachments or **Review after**, and the phone never split.
- **Watch the Plan run** ([#162](https://github.com/AhmedNavaz/codeshi/issues/162)). A card that's working names the agent, model and effort its run is on now. That can change from one subtask to the next. Under it are what the run is doing (thinking, writing, running tools, the step it's on, or **Needs you** when an approval or a question waits), the time it has worked, its tokens, spending that bills by use, and any retries, handoffs or reviews. The cards working now have a ring around them. The Plan's progress line adds what the cards' tasks have used so far. On the **Canvas**, an arrow into a running card is solid, one from a card still working is dashed, and a finished card's test gate is labelled on its arrow: **Testing**, or **Tests failed** while it holds the card after it. The **List** gives the same in words for the keyboard and screen readers, and a card that starts needing you is announced once. Choosing a running card opens its task in the chat beside the Plan, with its messages, approvals, questions and **Stop**, and shows the run in the card too. This works in Normal and Flow alike. Live lines change in place as the run moves on, without reading the Plan again, and the minutes are counted on your computer once every 20 seconds while a card works. Nothing on the Plan animates except the status dot, which stays still with reduced motion.

### Changed
- **Auto sends a message with images only where they can be read** ([#12](https://github.com/AhmedNavaz/codeshi/issues/12)). When a message has images attached, Auto now chooses only a model that takes images, connected in a way that can send them. Codex's own model list says which models take images. Claude's and Gemini's come from Codeshi's rated list. The CLI connection sends no images, and Gemini must report image input when it connects. An agent with neither is left out, and the reason names it, for example *The message has images, which Codex can't take here*. A model not known to take images is never chosen for them. Handoffs, fallbacks after a usage-limit error, and retries after failed tests follow the same rule. Routed runs record routing policy 5.
- **A running card reads at a glance** ([#162](https://github.com/AhmedNavaz/codeshi/issues/162)). On the Plan, a card's top row holds its status, its role (Builder included while it works, with the tooltip *Working as Builder*) and its agent, so the agent no longer takes a row of its own. A card with subtasks shows one line, a progress bar with **1/3 subtasks** beside it, instead of a bar and a second count. The time and tokens it has used are short numbers on the status row (*5m · 12k*), and the tooltip says them in full, with retries and handoffs, and names the model and effort.
- **The Canvas opens left to right.** The tree runs **Across** by default, with **Down** one click away. A choice you saved is kept.

### Fixed
- **A card's subtask is no longer sent back to Ready for starting twice or for a busy workspace** ([#155](https://github.com/AhmedNavaz/codeshi/pull/155), [#162](https://github.com/AhmedNavaz/codeshi/issues/162)). Two starts of the same task a few milliseconds apart failed the second; a task now starts once. Between one subtask ending and the next starting, the task kept no slot, so another task could take it and push the limit past what you set; it now keeps its slot. And when a routed subtask found every slot taken after its rating, the card failed; it now waits as **Waiting for a free slot** and tries again every 3 seconds.

## [0.49.0] - 2026-11-12

### Added
- **Tasks side by side in Flow** ([#107](https://github.com/AhmedNavaz/codeshi/issues/107), [#88](https://github.com/AhmedNavaz/codeshi/issues/88)). Flow now has a **Tasks side by side** card under **What’s next**, listing the **Workspace chat** and every folder task running beside it with its folder and copy mode (**own copy** or **direct**), live step, approval count, **Start** for a held task, **Review & merge** when a copy is ready, **Close** once a task is done, **New task** (asking which folder when the workspace has several) and **Tasks & limits**. **What’s next** keeps its space for the open conversation's own steps and queue. In a narrow window, its **Tasks** chip shows how many tasks need you or are working, and opens the card in place.
- **One Plan** ([#162](https://github.com/AhmedNavaz/codeshi/issues/162)). The board and Orchestrate's plan are now one **Plan**, opened by the **Plan** button, which replaces **Board**. It shows the same cards as **Columns**, **Canvas** and a new **Outline**. A card can also have what a plan step had: a group (such as Contracts or Build), a role, what it produces, an acceptance check, the files it expects to change, and a size. For its agent you can choose **Auto**, which picks the agent, model and effort when the card runs, as Orchestrate's steps did. Nothing is set to Auto unless you choose it. Groups show as labelled areas on the Canvas and as headings in the Outline, where a group's Ready cards run together and its running cards stop together. Cards now run the way plan steps did. Each finished card is tested with the command marked in **Run** before the cards that wait for it start, and failed tests hold them until you choose **Check again** or **Continue anyway**. Each card is told, when it starts, what the cards it builds on reported, the files they changed and their test results. A group's cards count toward one total.
- **Schedules on the board** ([#132](https://github.com/AhmedNavaz/codeshi/issues/132)). A Ready or Done card's **Schedule…**, or **Schedules › Schedule a prompt…**, runs it once at a set time, every day, on weekdays or every week, in your computer's local time. Each run is a task under Normal with the card's or prompt's own agent, and the workspace's access and approval setting as they were when you scheduled it. The agent is told the run was scheduled and not to push, deploy or publish anything. A card edited after it was scheduled doesn't run on its own: it waits for **Run now**, which runs it as it is now. A time when Codeshi wasn't open or the computer was asleep waits for you, on the board, in **While you were away** and as an alert, unless you allowed it to run late. Before a run starts, Codeshi reads its agent's usage. If the agent has reached its limit, the run doesn't start only to stop at once: it waits for that agent's reset when you allowed it to run late, or when the limit resets within ten minutes, and is otherwise missed with the time the limit resets. A wait never moves the run to another agent, carries on after a restart and ends when the schedule's next time comes. Usage that can't be read doesn't hold a run back. The same time never starts twice, including after a restart. A scheduled run that needs your approval or answer says so in the menu bar, and clicking it opens that run's task. While a schedule has a time to come, closing the window keeps Codeshi in the menu bar, and it quits by itself once nothing is scheduled. Schedules never wake a sleeping computer.
- **Labels, due dates and comments on board cards** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)). A card can have up to eight labels and a due date, shown on the card in **Columns** and on the **Canvas**, with **Overdue** or **Due today** where it applies. They are for you to sort and plan by: the agent isn't told them, so they can change while it works. Once any card has a label, a menu at the top of the board shows only the cards with one label: Columns hides the others and says how many of each column it shows, and the Canvas fades them in place so the arrows still make sense. A card's drawer has **Comments**, each saying who wrote it and when. Today that's always you. The agent is told your comments the next time the card runs, so adding or removing one is a change to the card, and a scheduled run of it waits for you, as after any edit. An agent already working on the card doesn't see a new comment. **Export** includes labels, due dates and comments.
- **Close the Plan, or a card, to agents** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)). **Open to agents** at the top of the Plan switches the whole Plan to **Closed to agents**, and a card's drawer has **Closed to agents** for that card alone. Codeshi then never puts it in a prompt. A closed card can't run, be scheduled or attached, and the cards that wait for it aren't told its title or result. **Export** asks whether to leave closed cards out (the default) or include everything, marked as closed. A Plan attachment sent before you closed it is left out of every later prompt, retry, handoff and context refresh, and the message shows it as left out. It can't be closed while an agent works on it. It doesn't encrypt anything: an agent allowed to read anywhere on your computer could still find Codeshi's own files.
- **Attach the Plan, or a card, to a message** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)). **Attach to message** at the top of the Plan, or in a card's drawer, puts its text in your next message as an attachment. The message box shows its size, and opening it shows exactly what the agent will read: each card's status, group, role, checks, what it waits for, its description and your comments. Cards closed to agents are left out, and Codeshi says how many. Like any attachment, it stays with the conversation when another agent takes over, within the usual context budget.
- **Plan from a document** ([#155](https://github.com/AhmedNavaz/codeshi/pull/155), thanks @seeebbii). In the Plan view, choose **Draft cards** above the message box and attach a brief, a spec or a requirements file, including a Word document, and the planner reads it as the requirements to plan from, not as instructions. It drafts major cards in phases, as many as the project needs, and puts what each card needs from the document in its description, since the agents doing the cards don't see it. The drafts' banner on the Plan says which documents the plan came from.
- **Suggest next, Add next and draft undo on the Plan** ([#162](https://github.com/AhmedNavaz/codeshi/issues/162)). Any card's drawer now has **Suggest next** and **Add next**. **Add next** opens a new card pre-linked after the current one, keeping its group and folder (and placing it to the card's right on the Canvas), with no model call and without setting **Auto**. **Suggest next** shows the exact agent, model, effort and usage notice before starting, then runs one dedicated read-only run reading that card, its finished result, its open upstream and downstream cards and the open Plan's titles and groups (never closed cards or closed Plans) to draft 1 to 3 linked follow-up cards checked locally against the card and its open ancestors, with **Stop** while running and **Dismiss** after a failure or restart. Accepting or discarding drafted cards can also be undone and redone across **Columns**, **Canvas** and **Outline** via the inline **Undo** banner, `⌘Z` / `⇧⌘Z` or the Canvas toolbar before an accepted card runs.
- **Major cards split into subtasks** ([#155](https://github.com/AhmedNavaz/codeshi/pull/155), [#162](https://github.com/AhmedNavaz/codeshi/issues/162)). A card planned from a document, or any card with **Split into subtasks when it starts** ticked, is split when it starts, not up front: a short read-only run with the card's agent plans its subtasks against the code the cards before it produced. The subtasks then run one after another in the card's task. On **Auto** in Flow each is routed at its own size, and otherwise each runs with the card's agent, unless you pinned another on it. The card's drawer lists them with what each agent reported. The ones not started yet can be edited, removed or added to, and **Pause after this subtask** stops the card there. **Run** carries on from the first unfinished subtask, after a pause, Stop, a failure or a restart, and **Split again** clears them. You can also write a card's subtasks yourself, and it isn't split then. The card's tests run after its last subtask, and the task's limits and **Stop** cover every subtask. There is no fixed number of subtasks: a card keeps up to 100.
- **Open at login** in **Settings › General**, in the installed app on macOS and Windows. Codeshi starts in the menu bar when you log in, so schedules carry on after a restart. With nothing scheduled, it quits again after two minutes.
- **Evaluations for long conversations** ([#85](https://github.com/AhmedNavaz/codeshi/issues/85)). `npm run eval` has two new tasks, `long-chat` and `long-chat-short`, where formats agreed many exchanges earlier are needed again in a conversation past the 48 KB a fresh agent takes word for word. `--context task-unfolded` runs them without the rolling brief, as a baseline. `long-chat-short` is marked as a known gap: in a chat of many short messages, the rolling brief keeps fewer earlier requests than the older cut-off did. The first live results for these, for today's context selection against the older one, and for Smart against a model picked by hand are in `evals/README.md`. They are a few small runs on Claude and support no claim.

### Changed
- **The Plan is a view, beside Normal and Flow** ([#162](https://github.com/AhmedNavaz/codeshi/issues/162)). The Plan opened as a window over everything and closed with Esc, so the chat, search and sidebar were out of reach while it was open. One switch at the right of the header now has **Normal**, **Flow** and **Plan**, and the view you choose comes back after a restart. The Plan shows the board on the left and the Workspace chat on the right. The button at the end of the Plan's toolbar hides the chat, with a dot on it while an approval waits there. Esc closes a card but never leaves the Plan. **Open to agents** and **Export** are in the toolbar's **⋯** menu, so the toolbar fits on one line. The Plan keeps the routing you had: opened from Flow, Codeshi still chooses the agent and model, and the Plan can be opened while work runs. Choosing **Normal** turns routing off and waits for the workspace to be idle, as leaving Flow does. Flow and the Plan name their workspace beside the view's name. Clicking it opens a menu of workspaces showing which are working or waiting for an approval, with **New workspace…**, and choosing one keeps you in the same view. Work in the workspace you leave keeps running, and a card with unsaved edits asks first. The ⌘K search and **Settings › General › View** also switch view.
- **The sidebar and side panel buttons sit at the left of the chat's header**, next to the sidebar they collapse, and are no longer mixed in with the view switch.
- **Agents draft cards from the Plan** ([#162](https://github.com/AhmedNavaz/codeshi/issues/162)). **Orchestrate** has left the message box. In the Plan view, **Draft cards** above the message box makes Send draft cards from what you write and any brief or spec attached: one read-only run, with the message box's agent or the deepest work its routing mode allows, drafts the cards. The request and the planner's reply still show in the Workspace chat, and while it works the Plan says it's drafting, with **Stop**. The plan arrives as draft cards on the Plan, in the plan's order, each waiting for the cards its step waited for, and on **Auto** at the step's size. A banner says who drafted them and shows the plan's summary and any questions the planner couldn't answer. **Accept all** or **Discard** handles the whole draft, and each card can be edited, accepted or discarded on its own. A draft can't run, be scheduled or move to Ready until you accept it, and queued messages wait until every draft is decided. The planner no longer stops at 5 steps: it makes as many cards as the work needs, up to the Plan's 300. It follows one written planning method: read the project first, size the plan to the work, contracts first, working slices, unknowns early, one outcome per card with what done means, explicit dependencies, and questions instead of guesses. Before you see a draft, Codeshi checks it on your computer, with no model call, and notes on the card itself any card that doesn't say what done means, a contract that comes after the work that uses it, a card that builds on a QA or review card, and a card that looks too large for one run. A draft plan saved before this version moves onto the Plan the same way. One that is running or stopped stays in its own view, which the Plan links to.
- **The message box starts at one line.** It was three lines tall when empty. It now grows with what you type, up to three lines, and then scrolls.
- **The board's canvas stays smooth with a few hundred cards** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)). Dragging a card drew every arrow on the board again on each move. It now redraws only the dragged card's own arrows, and a change to the board rebuilds only the cards that changed. Measured with 300 cards and 324 arrows on a 120 Hz display: dragging went from 2.4–3.3 ms of script per move, with some frames dropped, to about 0.15 ms and none dropped, and a board update from 25–60 ms to 9–20 ms. Panning and zooming were already at the full frame rate.
- **A long reply stays at its start.** When a reply taller than the window arrived, the conversation jumped to its end and you had to scroll back up. It now stops with the reply's first line at the top, under your request. A reply that fits still shows whole, and if you have already scrolled further down, the conversation keeps following the end.

### Fixed
- **Ask the chat about the Plan** ([#162](https://github.com/AhmedNavaz/codeshi/issues/162)). In the Plan view, a line above the message box shows what goes with your message: **Plan · 20 cards**, and the card open beside the board. The Plan goes as text made when you send, so the agent reads it as it is then, with cards closed to agents left out. The open card is named at the top of that text, so "this card" in your message means it; with the Plan left out, the card goes alone. **×** leaves either out of the next message. **Ask | Draft cards** on the same line says what Send does: ask the agent, or have it draft new cards for you to accept. A queued question takes the Plan too. The message box says which it will do (*Ask about the Plan, a card, or the project…*), and leaving the Plan puts it back as it was. **Attach to message** has left the Plan's **⋯** menu, since the message box sends the Plan; a card's own **Attach to message** stays. Agents can read the Plan this way but can't change cards yet.
- **A narrow message box keeps Send beside its controls.** In a narrow chat, such as the one beside the Plan, the microphone and Send dropped to a second line. **Add from GitHub**, **Review after**, **Access** and **Permissions** now go into a **More** menu by **Attach**, each with its name, so the row keeps Attach, the model, effort, the microphone and Send on one line. Narrower still, the model's name shortens before anything wraps. A wider message box is unchanged.
- **Switching or creating a workspace in Flow no longer opens Your agents.** A new workspace opened the Agents side panel, and Flow shows any open side panel as a sheet over the chat. Flow and the Plan now open no side panel on a workspace change.
- **Plan cards say when their agent bills by use, and ask before running** ([#108](https://github.com/AhmedNavaz/codeshi/issues/108)). A card whose agent uses an API account, or whose billing couldn't be confirmed, ran without warning and then stopped as it started, asking you to confirm billing. The card, including a draft, now shows **Bills by use** or **Billing not confirmed**, its drawer says whether the agent uses your subscription, and **Run Ready…** marks it. **Run**, **Run Ready…** and a group's **Run** ask once for the cards that bill by use, unless **Allow API and unconfirmed billing** is on in Settings for the session. A schedule can't ask, so its form says such an agent's runs won't start.
- **Approvals in tasks beside the conversation open their task** ([#88](https://github.com/AhmedNavaz/codeshi/issues/88)). Clicking a task's approval in the menu bar, its banner or the panel under the menu bar opened the workspace's chat instead of the task where the approval waits. The panel under the menu bar also closed such an alert at the next status update, as if it had been answered. Both now open the task, and the alert stays until the approval is answered.
- **Every card in a board column can be dragged again** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)). Since 0.45.1, only the first card in each column of **Columns** could be dragged, and the cards below it named their own column as if they were on the canvas.
- **Routing no longer sends everyday Claude work to Fable** ([#12](https://github.com/AhmedNavaz/codeshi/issues/12)). A model's size was guessed from its name, and Fable's name matched no rule, so it counted as a mid-sized model. Claude lists Fable 5.2 before Sonnet, so Saver and Smart sent standard work to Claude's most capable model. Routing now chooses only from a list of rated models, matched by exact id. Each one is rated light, standard or deep from its maker's own description, which is not measured quality. Fable and Astra are rated but stay yours to choose. A model not on the list, such as one released after this version, is never chosen automatically, and an agent with no rated model is left out with a reason. You can still choose any model yourself. On today's catalogs, Claude's standard work now goes to Sonnet, and every other choice is unchanged. Routed runs record routing policy 4, so Smart results compare them only with each other.
- **Less CPU and battery use while an agent works** ([#152](https://github.com/AhmedNavaz/codeshi/issues/152)). The moving highlight over the status line ("Reading files…") repainted that line on every frame, 120 times a second on a ProMotion display, for as long as a run lasted. In a ten-second trace this was nearly all of the window's drawing, at about half of one CPU core. The highlight looks the same and is now moved by the graphics card without repainting, and the line's words are only rewritten when they change. It is off with Reduce Motion. The result has not been measured again yet.
- **A Flow handoff that fails its last check is tried again** ([#12](https://github.com/AhmedNavaz/codeshi/issues/12)). When Flow moved a task to another agent near a usage limit and the last check before the switch failed, it left a hidden offer that stopped every later attempt, so the task ran into its limit with no message. It now leaves no offer and tries again at each usage check. If it fails twice, the conversation says once why, and that the agent keeps working.
- **Flow shows a handoff that waits for you** ([#12](https://github.com/AhmedNavaz/codeshi/issues/12)). An offer that needs your answer, because the other agent bills separately or automatic handoff is off for the task, was hidden in Flow, and Flow's card described it as "Moving from…" as if it were happening. The offer now shows in the conversation in Flow too, and the card says **Waiting for you**.
- **Take manual control from Flow** ([#107](https://github.com/AhmedNavaz/codeshi/issues/107)). While a Flow task was still working, the button that takes it back was hidden, and Flow can't be left until the workspace is idle, so Stop was the only way out. **How it's working now** now offers **Take manual control** whenever the task has a run, a queued message, a reset wait or an offer left. Nothing more starts on its own for that task, and the current reply may finish.
- **A Flow task limited to some models can queue follow-ups** ([#107](https://github.com/AhmedNavaz/codeshi/issues/107)). A routed message added to the queue was checked against the task's model limits before routing had chosen a model, so it was always refused. It is now checked once routing chooses.
- **Routing assessments run on Claude's small model** ([#84](https://github.com/AhmedNavaz/codeshi/issues/84)). Codeshi asked for Haiku, but Claude Code 2.1 runs a Haiku request on Sonnet in plan mode, which the assessment used. An assessment has no tools, so it now runs outside plan mode. In a few live runs its share fell from 2,000–4,800 new tokens to 420–2,490.
- **Claude's subagent line counts each subagent's final reply** ([#84](https://github.com/AhmedNavaz/codeshi/issues/84)). Checked against a real run with two subagents, the line had counted 5 of 7 messages. Input and cache tokens now match Claude's own records. Output is still undercounted, so the line stays "at least".

Thanks to [@seeebbii](https://github.com/seeebbii) for planning from attached documents ([#155](https://github.com/AhmedNavaz/codeshi/pull/155)).

## [0.48.0] - 2026-11-12

### Added
- **Voice input on Windows** ([#73](https://github.com/AhmedNavaz/codeshi/issues/73)). The microphone beside Send, Ctrl+Alt+V and **Agent › Voice Input** now work on Windows, in dictation and in Flow's conversation mode. Speech is recognized on your PC by the offline speech recognition that is part of Windows, so the audio never leaves it and nothing needs installing. It needs speech recognition for your language, which Windows installs with the language, and it does not add punctuation. **Settings › Voice** says what Windows allows.
- **The `codeshi` command on Windows** ([#90](https://github.com/AhmedNavaz/codeshi/issues/90)). **File › Install ‘codeshi’ Command…** adds `codeshi` to Command Prompt, PowerShell and Windows Terminal, without an administrator and without restarting the terminal. It is the same command as on macOS: an interactive session, or `status`, `run`, `continue`, `wait`, `stop` and `tasks` for scripts, and it starts Codeshi in the background when it isn't open. **File › Remove ‘codeshi’ Command** takes it away.
- **Install Google Antigravity on Windows from Settings.** In **Settings › Accounts**, **Install Google connection** now downloads and checks Google's official Antigravity runtime directly on Windows as well as macOS and Linux. **Settings › Accounts** also gives Windows PowerShell setup commands for Claude Code, and the Windows installer looks up the latest release without hitting GitHub's API limit.

### Fixed
- **The CLI tab and console input on Windows** ([#90](https://github.com/AhmedNavaz/codeshi/issues/90)). Opening **CLI** in the status bar on Windows now starts the interactive session cleanly inside the tab instead of opening blank and closing right away, and packaged `codeshi` commands read interactive terminal input while keeping piped scripts unchanged.
- **Gemini status and Antigravity startup on Windows.** Codeshi now finds a standalone Antigravity ACP installation under `%LOCALAPPDATA%\agy\bin`, and gives the single-file Windows runtime time to unpack and initialize on startup. Background checks no longer flash console windows, and connection or timeout failures appear clearly in Settings instead of a local server error.

## [0.47.0] - 2026-11-12

### Added
- **Commits in Timeline** ([#20](https://github.com/AhmedNavaz/codeshi/issues/20)). Timeline now shows each folder's commits on its current branch among the checkpoints, in time order, from the oldest checkpoint on (or the latest 15 before there is one), up to 30 per folder. Each commit says who made it as far as Codeshi knows: **From the Git panel** for a commit made there, **During Claude's run** (or another agent's) for one made while a run was working, and otherwise its author. Clicking a commit's message opens its files and lines read only. A merge shows what it brought into the branch, and **Open on GitHub** appears when the folder's `origin` is on GitHub. Nothing in Git is written, and restoring files still goes through checkpoints.
- **An evaluation task for each starter skill** ([#86](https://github.com/AhmedNavaz/codeshi/issues/86)). `npm run eval` has six new tasks, one per starter skill, for running with and without it: a view that handles every state, an endpoint that checks who may call it, a migration that works on existing data and can be undone, an accessible toolbar, a review that has to find two seeded defects, and tests that must catch four realistic slips. A failed check now lists which of its parts failed, by the check's own names, without storing the agent's code or reply. Results so far are in `evals/README.md`.
- **Hear replies on your phone** ([#23](https://github.com/AhmedNavaz/codeshi/issues/23)). On a connected phone, the speaker under a finished reply reads it in the phone's own voice, a paragraph at a time, leaving out code and tables. Tap it again to stop. **Read replies aloud**, at the bottom of the workspace list, reads each reply as its run finishes while Codeshi is open on the phone. It's off by default. It works on Same Wi-Fi too, and stops when you hide the page, move to another conversation or tap the microphone.
- **Open one of your GitHub repositories as a workspace** ([#159](https://github.com/AhmedNavaz/codeshi/issues/159)). **New workspace** has a **From GitHub** tab listing the repositories your GitHub CLI login can see: your own, your organizations' and those you collaborate on, most recently pushed first, with search. Click one and it's cloned into the folder under **Clone into** and opened as a workspace. A repository already on this computer, in a workspace or in that folder, says **Open** and opens its existing folder instead. The first time, Codeshi suggests the folder most of your workspaces are in, then remembers the folder you clone into. It uses `gh` and your own git: Codeshi asks for no sign-in, stores no token and never pushes. The list is read only when you open the tab, and shows up to the 500 most recently pushed repositories. Signing in without `gh`, and GitHub Enterprise, aren't supported yet.
- **Move Codeshi to another computer** ([#160](https://github.com/AhmedNavaz/codeshi/issues/160)). **Export Codeshi Backup…** in the File menu, or **Settings › General**, saves your workspaces, their conversations, memory, skills, board cards and tasks, and your settings to one file locked with a passphrase. Checkpoints can go too. **Import Codeshi Backup…** on the other computer, also offered on the setup guide's first screen, asks where each workspace folder is there: a folder already there (found by its GitHub address or its path), a fresh clone through `gh`, another folder, or none. Folder IDs and paths in Codeshi's own records are rewritten to match. Importing into a workspace that already exists merges with it. A conversation that changed on both computers is replaced only if you choose, and this computer's copy is kept. Sign-ins, the GitHub login, phone pairings, always-allow approvals and tasks' working copies never move. Nothing goes through a server; moving directly between computers without a file isn't built yet.

### Changed
- **Alerts are set up by moment, with Try it.** **Settings › Alerts** now has a card for each moment, **Needs you** first, then **Finished** and **Stopped**, each with a chip for each way: banner, sound, Dock bounce, Dock badge and phone. **Try it** shows the real thing. It plays the sound and, in the desktop app, shows the banner or panel and the Dock badge, then says what happened, including when macOS refused the banner and how to allow it. The Dock bounce comes if you switch to another app within a few seconds. **Needs you** suggests turning on a sound while it has none. Your alert choices carry over unchanged.
- **Live status in one place.** The menu bar status and the pill under it now sit together under **While agents work** at the top of **Settings › Alerts**. They're described as quiet status, apart from the alerts, and **Show the pill** shows the pill for a few seconds. **Agent › Alerts** and the menu bar's own Alerts menu can turn the pill on or off too, and their ticks match what Settings shows.
- **The setup guide asks about alerts.** A last step, **Know when an agent needs you**, shows the **Needs you** card with **Try it** and, on a Mac, the pill with **Show the pill**. Choices save as you make them, and the rest stays in **Settings › Alerts**.
- **One focus ring in Settings search.** The search box drew two rings while you typed in it.

### Fixed
- **The progress pill's × hides it instead of opening Codeshi** ([#75](https://github.com/AhmedNavaz/codeshi/issues/75)). On macOS, pressing **×** on the pill under the menu bar brought Codeshi forward and left the pill on for next time. It now hides the pill and puts you back in the app you were using. The pill stays hidden until you've been back in Codeshi, then shows again the next time you leave while agents work; before, it came back as soon as another run started. The same goes for **×** on an alert in the panel.
- **Keyboard and screen reader fixes** ([#26](https://github.com/AhmedNavaz/codeshi/issues/26)). Switching side panels with Enter or Space dropped keyboard focus to the page, because each panel has its own row of tabs. Focus now stays on the tab, and the row is one stop in the Tab order: Left and Right move to the next panel, Home and End to the first and last. The **Terminal** and **Run** tabs of the bottom panel are one Tab stop too, with Home and End. Entering or leaving **Flow** with the keyboard also dropped focus, because the header moves; it now stays on the **Flow** button. Each message now starts with a heading (*You*, or the agent's name) for screen reader heading navigation. On the board's canvas, each card tells a screen reader that Option (Alt on Windows) with the arrow keys moves it, and the hint at the corner says so too. In the model picker, **Connect…** and **More … models** rows are now read as part of the list.
- **Memories no longer need a recheck after every commit** ([#21](https://github.com/AhmedNavaz/codeshi/issues/21)). Since 0.30.0, any new commit in a folder marked every memory saved there **Needs recheck**, even an unrelated commit. Those memories went to agents as possibly out of date and started unticked in **Copy to AGENTS.md**. Now a commit by itself flags nothing. Conventions and decisions, the rules you set, need a recheck only when a file they name changes. Working fixes and failed approaches, facts found in the code, also need one after a switch to another branch, or when the folder's dependencies change in `package.json`, `composer.json`, `deno.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `Pipfile`, `Gemfile`, `go.mod`, `pubspec.yaml` or `Package.swift`. A project's own version number, its scripts and lock files don't count. Hovering **Needs recheck** says which of these happened. Before, it said the folder had left the workspace whenever no named file had changed. Editing and saving a memory counts as checking it again on the current branch.

## [0.46.0] - 2026-11-12

### Added
- **A plan's steps are tested before later steps build on them** ([#89](https://github.com/AhmedNavaz/codeshi/issues/89)). When a step of a running plan finishes, Codeshi runs the test command marked in the **Run** panel on a temporary copy of its result. For a step that worked in its own copy, that is the folder with the step's changes merged on top. The folder and the copy are left untouched, and the step's merge review shows the same result. If the tests fail, the steps that depend on it wait. Fix the step in its task, or open the **Plan** and choose **Check again** or **Continue anyway**. Continuing is recorded as your decision. Each card in the Plan shows the result: *Tests passed*, *Tests failed*, *No changes* or *Not tested*, with the reason. A step is marked not tested when no test command is marked, its folder isn't a Git repository, or Codeshi closed while its tests were running. Failed tests show the end of their output in the step's details.
- **Open a pull request from the Git panel** ([#18](https://github.com/AhmedNavaz/codeshi/issues/18)). After you commit, **Open pull request** shows where the branch will go before anything is sent: the repository, the branch and the branch it merges into, the commits GitHub doesn't have yet, and any files you haven't committed. The title and description are drafted from what Codeshi recorded, with no model: the branch's commits, the request that started the work, a link to any GitHub issue you brought into the conversation, and Codeshi's last test result. Secrets and local paths are removed as in exports, and you edit both before opening. You can open it as a draft. Clicking pushes the branch with your own Git login and opens the pull request with `gh`. Codeshi never force-pushes and never pushes the branch a pull request merges into. If you're on that branch (main, say), you name a new branch, your commits move to it, and main goes back to where GitHub has it. If the branch already has an open pull request, the same button pushes your new commits to it. This is the only place Codeshi pushes, and agents never push.

### Changed
- **A plan step's instructions are written when it starts** ([#89](https://github.com/AhmedNavaz/codeshi/issues/89)). Until now, every step's instructions were written when the plan started, so a step only saw the titles of the steps before it. Now each step gets what those steps actually did: whether their changes were merged or kept as a branch, the files they changed, their test result, and their final report, labelled as the contract, schema or findings the plan asked for. The step is told to check the files rather than rely on the reports. If an earlier step finishes again after a later one has started, the later step's card says it was built on an older version.
- **The recap includes tasks and plans** ([#88](https://github.com/AhmedNavaz/codeshi/issues/88)). **While you were away** used to cover only each workspace's main conversation. It now also lists tasks that worked, finished or stopped while you were gone: who did each, which files it changed, and whether it waits for you to merge it or approve something. A plan's steps fold into one line, such as *The plan “Checkout rewrite” has 2 of 4 steps done*, followed by the steps still working, the steps whose tests failed and are holding the steps after them, and the steps ready to merge. A step whose tests failed stays in the recap until you deal with it. Merging, keeping and discarding are your own actions, so they're left out.
- **Times use a 12-hour clock.** Every time Codeshi shows is now written like 9:41 PM: on messages, limit resets, checkpoints, the board, the phone view and Ask a Friend's sharing page.
- **Flow's What happened card is shorter.** It shows the latest three runs, and its **Timeline** button is gone, since **Files changed** beside it already has one.

## [0.45.1] - 2026-11-11

### Added
- **The board as a canvas** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)). **Board** has a **Canvas** view beside **Columns**: the same cards, placed wherever you drag them, with arrows from a card to the cards that wait for it. Drag from the dot on a card's right edge onto another card to make it wait, or select an arrow and press **Delete** to remove it. Moves, arrows and **Arrange**, which lays every card out by what it waits for, can be undone with **Undo** or ⌘Z. Scroll to pan, pinch or ⌘-scroll to zoom, and double-click empty space for a new card there. A card's place is only where it's drawn, so moving a card changes nothing an agent reads, and a card that's working can still be moved. Cards you haven't placed sit below the placed ones, in columns by what they wait for or in a grid. **Columns** stays the view for the keyboard and screen readers, and Alt with an arrow key moves a focused card on the canvas. **Export** saves the board as Markdown with a Mermaid chart of the cards and their arrows, followed by each card's details and checklist, without task ids or the agents' summaries.
- **Share your results** ([#139](https://github.com/AhmedNavaz/codeshi/issues/139)). **Smart results** in the **Tasks** panel has a **Share…** link. It shows what a shared copy includes and leaves out, with the post and the file to read first. That copy never has your requests or routing reasons. Tasks are numbered 1, 2, 3 instead of keeping their IDs, and times keep only the date. **Save file and open GitHub** saves the copy and opens a prefilled post on Codeshi's GitHub Discussions. You attach the file there and decide whether to post it. Codeshi sends nothing itself.
- **Approvals still waiting when a run ends** ([#85](https://github.com/AhmedNavaz/codeshi/issues/85)). When a handoff or **Stop** ended a run while an approval or a question was waiting for you, the request was dropped, and the next agent never learned it had been asked. The run now keeps a short line for each: the command, the kind of file change (a file with a private-looking name isn't named) or the question. The next agent gets them as history, told that none was answered or carried out, after a handoff, a context refresh or a restart. Once another run has ended they're left out. **See the full brief** in the **Brief** panel lists them under **Waiting when the last run ended**.
- **What happened in Flow** ([#107](https://github.com/AhmedNavaz/codeshi/issues/107)). A new Flow card lists the decisions behind the last four finished runs, newest first: the agent, model and effort Codeshi chose and for what size of task, a handoff from one agent to another, a switch at a usage limit, a retry after failed tests, or a review. Each line shows how the run ended (tests passed or failed, tests waiting for your review, stopped, or stopped at a usage limit) and the reason Codeshi recorded at the time. It reads saved runs only, with no model call, and routing assessments aren’t listed. **Timeline** opens the full history. Earlier runs are included too, since it reads the reasons already saved with each run.

### Changed
- **What's New thanks contributors.** The notes shown after an update, and under **Help › What's New**, now end each version with a **Thank you** line for the people who contributed to it, as the changelog credits them. A name opens that person's GitHub profile. Under the notes, **Star Codeshi on GitHub** and **Support on Patreon** open those pages, and the **Help** menu has both too. A star helps more contributors find Codeshi. Nothing is sent unless you open a link.
- **The menu bar status is quiet while Codeshi is in front.** On macOS, the words beside Codeshi's mark in the menu bar, such as *Codex · Editing · 3 files changed* or *Approval needed*, and the dot for something that needs you, now show only while Codeshi is behind another app. With a Codeshi window in front, the window already shows it, so the menu bar keeps the plain mark. Its menu still lists every busy workspace.
- **A plan's steps fold into one row once it ends** ([#108](https://github.com/AhmedNavaz/codeshi/issues/108)). Under **Tasks**, a plan's row now says where it stands, such as *1 of 3 done*, *Finished* or *1 didn't finish*. When every step has ended and none waits for review or an approval, the steps fold away and the row shows what the whole plan used: steps, working time and new tokens, including the planning run, with *at least* when an agent didn't report everything. A click opens it again, and its **×** closes the plan. A plan you folded by hand still shows how many steps need you.

### Fixed
- **Smart results in a narrow Tasks panel.** The results table could push the section past the panel's right edge, cutting off the last column, the verdict and the links under it. Column headings now wrap, and the section fits the panel.
- **The board and the Plan view under the window buttons.** On macOS, the close, minimise and zoom buttons sat on top of the top-left corner of **Board** and the Plan view. Both now start below the title bar.
- **The message box in the Lounge during a run.** In the Lounge's narrow chat column, one control could drop to a second line while Stop and Queue sat beside both lines. The row now stays on one line: in a narrow message box, Stop shows as its icon during a run. When the window is too small for one line, the controls keep the first line and Stop and Queue take the second, at the right.

## [0.44.0] - 2026-11-11

### Added
- **Claude's usage by model** ([#84](https://github.com/AhmedNavaz/codeshi/issues/84)). Claude Code calls a small model such as Haiku for its own jobs inside most runs. Its tokens were part of the run's total but couldn't be told apart. The **Tasks** panel and a run's details now split Claude's new tokens by model, for example *Sonnet 5.5 40k · Haiku 5.5 13k*. A run in a resumed session counts only what each model added. When Claude is connected through its command line and starts subagents, a line also shows at least how many new tokens they used. Both are already inside the total and are never added to it. Codex and Gemini report one total per turn, so they have no split.

### Changed
- **One handoff line for the whole task** ([#12](https://github.com/AhmedNavaz/codeshi/issues/12)). Smart, Saver and Ultra already used their 80, 90 and 95% lines to choose an agent and to decide when a task moves. The rest of a routed task now uses the same lines. In Smart and Ultra, a retry after failed tests now asks first only from 90% (Smart) or 95% (Ultra), not from 80% or 90%. Ultra asks another agent to review only when it has room under 95% for a usual run, not under a fixed 90%. After a reset, a waiting task resumes first on an agent under its mode's line, and past it only when no agent is. A step of an Orchestrate plan left to Auto is now chosen when it starts, from fresh usage and at the size the plan gave it, rather than when you pressed **Run**. A step whose agent you chose keeps it. A queued prompt that moves at a handoff keeps the size it was rated as. Routed runs record routing policy 3, so Smart results compare them only with each other.
- **One layout for every dialog** ([#130](https://github.com/AhmedNavaz/codeshi/issues/130)). Dialogs now share one header and one footer: the title with a short line under it, the close button at the top right, and the actions at the bottom right at one height. This covers Previous conversations, Export, Changes, Undo changes, Ask a friend, Continue locally, the review dialogs, Add from GitHub, Run and review your project, workspace and folder settings, and the memory and skill forms. Their titles follow **Text size**, and the review dialogs' close button is the same icon as everywhere else. What's New keeps its logo heading, and Settings keeps its page title.

### Fixed
- **Setup with the keyboard and a screen reader** ([#129](https://github.com/AhmedNavaz/codeshi/issues/129)). Choosing a working style, an agent or what agents can do keeps keyboard focus on that choice. After you choose folders, focus moves to the result. A screen reader hears what each folder is, each agent's connection status with its button, and which steps are done.
- **Badges are easier to read in every theme** ([#127](https://github.com/AhmedNavaz/codeshi/issues/127)). Status text such as Working, Finished, Failed, a waiting approval or a routing mode's limit now reaches WCAG AA contrast in Light, Dark and Graphite, on selected rows and tinted cards too. Running states and labels in the accent's colour use a brighter shade of it, because vermilion itself was too dim for small text. In Graphite, selected rows are a little darker and red and grey text a little lighter. In Light, green, amber, blue and link text are a little darker. The Working badge on Flow's plans card, the approval count in the sidebar and the plan badge in usage are no longer smaller than other badges. A test now checks every badge colour against the theme it appears in.

## [0.43.0] - 2026-11-11

### Added
- **A task board** ([#132](https://github.com/AhmedNavaz/codeshi/issues/132)). **Board**, beside **Plan**, keeps a workspace's work as cards in five columns: Backlog, Ready, Doing, Review and Done. You write each card with a description, a priority, a checklist and the cards it waits for, and choose its agent. **Run** starts a card as its own task, and **Run Ready…** runs exactly the Ready cards you tick, each after the cards it waits for. A finished card waits in Review with the agent's summary, the files it changed and its test result. Only you accept it. A stopped or failed card returns to Ready with the reason. Cards are saved with the workspace, not in your repository.
- **Design notes in the preview** ([#125](https://github.com/AhmedNavaz/codeshi/issues/125)). **Design** in the preview's toolbar lets you mark several parts of your app's page and write a note for each. Click an element, or drag a box around an area, and it gets a numbered box on the page and a row in the Design notes panel beside it. **Add to message** puts every note into the message box as one numbered list, with the code location of each part where your dev build reports it. It adds a screenshot of the page showing the same numbers, and one of each part that has scrolled out of view. Nothing is sent until you send it. The boxes follow the page as it scrolls and reloads. Esc stops marking, so you can use the page between marks. A message holds up to 12 parts.
- **Codeshi in your terminal** ([#90](https://github.com/AhmedNavaz/codeshi/issues/90)). On macOS, **Codeshi › Install ‘codeshi’ Command…** adds `codeshi`. Run it in a project folder and you get an interactive session in that terminal. You type to the agent, and its steps, diffs and replies scroll by, with the agent, model and access shown under the prompt. Approvals and the agent's questions open as a small box you answer with the arrow keys or a number, and Esc stops a run. Shift+Tab switches between asking before changes, editing without asking, and read only. Type `/` for commands such as `/agent`, `/model`, `/handoff`, `/tasks` and `/open`, and `@` to mention a file. It's the same conversation as the window, so you can start a run in one and follow or answer it in the other, and leaving the session never stops a run. Codeshi doesn't need to be open: `codeshi` starts it in the background with no window, and it quits by itself a couple of minutes after you're done. For scripts, `codeshi run "…"`, `status`, `wait`, `stop`, `continue` and `tasks` print plain output, or JSON with `--json` and `--jsonl`. A script never approves anything for you: it ends with exit code 3, and the approval waits in Codeshi. You can also try it without installing anything: **CLI** in the status bar opens the same session in a tab, in the conversation's place, with **Chat** and **CLI** tabs above it. **Chat** goes back to the conversation and leaves the session running. **×**, Ctrl+D or `/exit` closes the tab, and a run carries on in the chat. See [docs/cli.md](docs/cli.md).
- **Watch along with a teammate** ([#24](https://github.com/AhmedNavaz/codeshi/issues/24)). **Share live** in the status bar, beside **Remote access**, makes an invite link for one teammate. They paste it into **Share live › Watch a teammate…** in their own Codeshi, and you allow them after checking that both screens show the same six-digit code. They then see the workspace's conversation as it happens, read-only: messages, replies, what the agent is doing and when it waits for you. A line above your message box says who is watching. Their suggestions wait there until you add one to your message or dismiss it. Watchers can't send messages, answer approvals, open files or see other workspaces. The conversation goes through the remote access relay, encrypted on each computer.

### Changed
- **Weather in Flow.** Rain and Snow, with their sound and volume, moved from the Lounge to **Your space**, beside **Appearance**. They now fall anywhere in Flow, and the choice is kept between sessions; Clear draws nothing.
- **Flow's corners take less room.** **Appearance** in **Your space** is one row of small icons, Graphite has a new icon, and **Remote access**, **Share live** and **Keep awake** sit side by side under **Stay connected**.
- **Board and Plan sit at the left of the top bar.** The search box now stays in the middle of the top bar, whatever the buttons at either end show.
- **What's New explains each change.** The notes shown after an update, and under **Help › What's New**, listed only each change's title. Each change now has its title and a sentence or two on what it does, in larger text.
- **Add from GitHub no longer shows a notice.** Adding an issue or pull request to the message box showed a line such as "Issue #84 is in the message box" above the chat. The text in the message box already says so, so the line is gone. A notice still appears when something was taken out of the text, such as a possible secret or a local path, or when it was shortened to fit.

### Fixed
- **Plan usage from Flow's plans card.** Clicking an agent in **What's left on your plans** could open its usage window at the very top of the screen, often the first time, out of reach of its close button. The card redraws when a fresh reading arrives, and the window lost its place. It now stays beside the agent you clicked.

## [0.42.0] - 2026-11-11

### Added
- **Suggestions after a run** ([#106](https://github.com/AhmedNavaz/codeshi/issues/106)). When a run finishes, the line above the message box can point to a feature that fits what just happened, in Normal and Flow. It suggests **Remember** when you've written the same rule in two messages, **Make a skill** when you've given the same steps in three, and, in Normal, **Try Flow** when small changes keep going to a strong model or high effort. Each says what it saw and opens a step that shows what will change; nothing changes from the line itself. They come from local rules with no model call and promise no saving. There's one at a time, never during a run, an approval or a question, and at most two a day. **×** dismisses one for good, and **Settings › General › Suggestions after a run** turns them off, along with usage notices.
- **A skill from your messages.** **Make a skill** from a suggestion saves steps you gave in several messages as a skill, after the same review as a skill made from memory. It's listed under **Skills** as *From your messages*.
- **Status in the Windows notification area** ([#74](https://github.com/AhmedNavaz/codeshi/issues/74)). On Windows, Codeshi's mark now sits beside the clock, as it does in the macOS menu bar. A dot says something needs you and the tooltip says what, in general words and counts only. A click brings Codeshi forward, to the request when exactly one thing needs you, and a right-click opens a menu of busy workspaces with **Keep Awake** and **Alerts**. The icon follows a dark or a light taskbar. Turn it off in **Settings › Alerts**. It's covered by automated tests but hasn't been tried on a real Windows PC yet.
- **Ready for translation** ([#27](https://github.com/AhmedNavaz/codeshi/issues/27)). Codeshi's interface can now be translated into other languages, with no build step. A language is a catalog file, and **Settings › General › Language** appears once one is added. It follows the computer's language until you choose another. The page's own text, Settings, the message box and model picker, and the desktop and tray menus are translatable, with plurals and values in each language's own order. Other panels, the phone page and messages from the server stay in English for now. No translations ship yet: `npm run i18n -- <language>` starts a catalog with every text to fill in, and [CONTRIBUTING.md](CONTRIBUTING.md#translations) explains how to translate.
- **Record Performance Trace.** **Help › Record Performance Trace** measures Codeshi for ten seconds while it seems slow or uses the battery, in the installed app too. It then says how much of one CPU core the window's pages, the graphics process and the app itself used, and saves a trace of what each one ran, gzipped, under `performance-traces` in Codeshi's data folder. **Show in Finder** finds it, and Perfetto or Chrome's trace viewer opens it as it is. The trace holds timings, script names and request addresses, not chat text, and it stays on the computer. The latest five are kept.
- **Six puzzles in the Lounge.** The Lounge's grid now also has **Codle**, a word game where you guess a five-letter programming word in six tries; **2048**; **Minesweeper**, in three sizes; **Sudoku**, in three levels with pencil notes; **Pairs**, a memory game with code symbols; and **Fifteen**, the sliding-tile puzzle. Each board grows with the window, and each puzzle plays with the mouse or the keyboard. A puzzle stays as you left it while the Lounge is closed, and best results are kept on this computer. The puzzles do no work between your moves, and the Minesweeper and Sudoku clocks stop when you leave them.
- **Progress pill under the menu bar** ([#75](https://github.com/AhmedNavaz/codeshi/issues/75)). On macOS, **Show what agents are doing in a pill under the menu bar** in **Settings › Alerts** keeps a small pill under the menu bar while an agent works and you're in another app. It uses the menu bar status's words, such as *Codex · Editing · 3 files changed* and the workspace. With several runs it shows how many are working and the one whose step changed last. It's useful when the menu bar status is hidden, or a crowded menu bar puts it behind the notch. It changes only when its words do and doesn't move while it shows. It has no animation or sound, isn't read out by screen readers and doesn't appear over full-screen apps. With the panel as the banner style, an alert takes its place, and it comes back afterwards if work is still running. Click it to open the workspace. **×** hides it until another run starts, and it goes when the work ends. It's a choice apart from the menu bar status and the banner style, so you can use either, both or neither. A new installation has it on; an existing one keeps it off until you turn it on.
- **Binary files in Ask a Friend** ([#25](https://github.com/AhmedNavaz/codeshi/issues/25)). A help request and a returned solution can now include binary files such as images, fonts and archives, up to 1 MiB each, as well as text. The review shows a binary change side by side: what each version is, its size and the start of its hash, with images as pictures. A program is flagged, and so is a code file whose new version isn't text, which also shows the text that can be read in it. Text is always sent as text, so every text change still has a diff. Applying and recovery work on the exact bytes, with the same conflict checks as text, and a new file is written without permission to run. Secret scanning reads the strings inside binary files. A patch with a binary file uses a new format that older versions refuse; a text-only patch is unchanged.
- **Run your tests on a friend's patch** ([#10](https://github.com/AhmedNavaz/codeshi/issues/10)). After you apply a returned solution, **Run tests** runs your project's own Test command, the one marked for tests in **Run**, never a command from the friend. It shows the exact command and folder, and nothing runs until you confirm it. It names the patched files that decide what the tests run, such as `package.json`, test settings and test files, and warns when the command runs in a folder the patch didn't change. The run is Run's usual Test session, so it shows there and **Stop** works. Each result is saved with the solution's other checks, with a one-line note in the conversation and no agent called. A failure undoes nothing on its own: the patch stays applied and the result offers **Undo this patch**.

### Changed
- **Weather falls only in the Lounge.** Rain and Snow kept falling over Flow's cards after you left the Lounge. That full-window animation used about a tenth of a CPU core, plus graphics work, for as long as Flow stayed on. The weather now stops when you leave the Lounge or it steps aside for an approval or a finished run, and comes back where it was, with the same choice, when you return. It also no longer asks the system about reduced motion on every frame.

### Fixed
- **An answered approval leaves the panel with the menu bar status hidden.** With the menu bar status turned off, an approval's alert in the panel at the top of the screen stayed after the approval was answered, for example from your phone, until you dismissed it or came back to Codeshi. It now goes as soon as the approval is answered, as it did with the status shown.
- **Keyboard and screen readers** ([#26](https://github.com/AhmedNavaz/codeshi/issues/26)). The **More actions** and **Voice mode** menus now move with the arrow keys, Home, End and letters, and Tab closes them. **Plan usage** and **Software update** take focus when they open, keep Tab inside and give focus back when they close; before, Tab skipped past **Plan usage**. The file tree in **Files** is now a tree for screen readers, one stop in the Tab order, with the arrow keys moving between rows and folders. The search bar now tells a screen reader which result is highlighted, and Tab no longer loses focus in its closing list. A new approval or question is read out once, with what the agent asks. The run's status is no longer re-announced every second. Settings switches, routing choices, the Voice menu and search results are read by their name with the description after it, instead of as one run-together line. These were checked with key presses in the app's page; VoiceOver itself hasn't been tried yet.

## [0.41.0] - 2026-11-10

### Added
- **A plan as a chart** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97)). An Orchestrate plan now opens in a full-window **Plan** view instead of a narrow side panel. Each step is a card, in a column for its phase or for what it waits for, with arrows from a step to the steps that wait for it. A card shows the agent the step would run with, and its task's state once the plan runs. Selecting a card opens it beside the chart: its editor while the plan is a draft, its task while it runs. **Outline** shows the same steps as a list, for the keyboard, screen readers and narrow windows. The plan's cost, **Save changes**, **Run as tasks**, **Stop plan** and **Close plan** are at the bottom of the view. The **Plan** button beside **Flow** opens it and says where the plan stands: planning, ready, how many steps are done, or stopped. **Open plan** under **What's next** in Flow opens it too.
- **Attach Word documents** ([#157](https://github.com/AhmedNavaz/codeshi/pull/157)). A `.docx` attached to a message, or opened in the file browser, is read as its text, with headings, lists and tables as Markdown. A document can be up to 5 MB, and its text counts toward the usual attachment limits. A `.doc`, a document with a password or a damaged one is refused, with what to do instead.
- **Notifications on your phone's lock screen** ([#23](https://github.com/AhmedNavaz/codeshi/issues/23)). A phone connected **Away from home** can now be told when an agent needs you, or a run finishes or stops, while Codeshi isn't open on it. Turn them on from **Notifications** at the bottom of the phone's workspace list. On iPhone that's in the Home Screen icon; Android works in the browser too. A notification says only what happened and in which workspace, never a command, a file or a reply, and tapping it opens that workspace. Your computer sends each one itself, straight to Apple's or Google's push service and encrypted for that phone, with no Codeshi server and no Firebase function in between. Which moments are sent follows a new **Phone notification** row in **Settings › Alerts**. Notifications end with the connection, and Same Wi-Fi has none, as browsers allow them only over HTTPS.
- **What a whole plan used** ([#84](https://github.com/AhmedNavaz/codeshi/issues/84)). An Orchestrate plan's planning run and its steps were counted as unrelated tasks, and planning showed as read-only work. Planning now has its own role, each step is labelled with its number, and the **Tasks** panel and the **Plan** view add up the whole plan: planning and every step, with their retries, follow-ups and reviews, working time, new tokens with planning's share, and how many steps' tests passed. Tokens an agent didn't report stay unreported, never zero.
- **Rewind the conversation with a checkpoint** ([#20](https://github.com/AhmedNavaz/codeshi/issues/20)). Restoring a checkpoint from **Timeline** can now take the conversation back too: tick **Also rewind the conversation** in the restore preview, which says how many later messages that folds away. Folded messages stay in the saved history and in the chat behind one line, **N messages rewound · Show**, but no agent reads them again, and every agent starts a fresh session. Rewinding to before a run puts its prompt back in an empty message box. When the files already match the checkpoint, only the conversation goes back. It isn't offered while prompts are queued or a task waits for a usage limit to reset.

### Changed
- **Smart results leave Orchestrate plans out.** A plan's planning run counted as a question and its steps as manual tasks. They're now listed as part of a plan and not compared, because a plan isn't comparable with a single routed or manual task.

### Fixed
- **Flow no longer starts a task on an agent it would hand off right away** ([#12](https://github.com/AhmedNavaz/codeshi/issues/12)). Choosing an agent for new work and handing a task off now use the same line: 80% of a limit in Saver, 90% in Smart and 95% in Ultra, and it rises near a reset. Smart could pick Claude at 91% of its weekly limit and hand the task off at the first usage check. Now an agent past the line is chosen only when no other agent is under it, and the reason says so. The task then stays until another agent has room. A task moves only to an agent with room under the line for a usual run, judged by what that agent’s runs usually spend in each window, so it isn’t moved twice. A quota-error fallback uses the mode’s line instead of 90%. Routed runs now record routing policy 2, so Smart results compare them only with each other.
- **A notice about the message box goes when you send.** A notice such as "Issue #84 is in the message box" stayed on screen after the message was sent. It now goes as the message is sent. A notice with a **Retry** or other button stays.

Thanks to [@seeebbii](https://github.com/seeebbii) for Word documents ([#157](https://github.com/AhmedNavaz/codeshi/pull/157)).

## [0.40.0] - 2026-11-10

### Added
- **Copy project memory to AGENTS.md** ([#21](https://github.com/AhmedNavaz/codeshi/issues/21)). **Copy to AGENTS.md** under **Memory** in the **Brief** panel writes the memories you choose into a folder's `AGENTS.md` as one marked section, after showing exactly what will be written. The rest of the file is kept as it is, copying again replaces only that section, and nothing is committed. The write is refused if the file changed after the preview or an agent is working in that folder.
- **Hands-free voice conversations** ([#72](https://github.com/AhmedNavaz/codeshi/issues/72)), on macOS, in Flow. Choose **Conversation** from the arrow beside the microphone, or as **Mode** in **Settings › Voice**, and ⌥⌘V or the microphone starts a conversation that listens until you say "stop listening", press Esc or click the microphone. Say "send" as the last word, then pause, to send. "send" in the middle of a sentence stays part of the message, and **Send after a pause** sends after two seconds of silence. While a run works, what you send goes into it when the agent allows additions, or joins the queue, as **While the agent works** chooses. Listening pauses while Codeshi reads a reply or a request aloud, and a short tone says when it listens again. Approvals are read out: "deny" denies, and approving needs "approve" and then "yes, approve". Questions with choices are answered on screen, and listening waits for them. Each listening session still lasts at most two minutes, and the next starts by itself without losing what you said. Speech stays on your Mac.
- **Add terminal output to your message** ([#71](https://github.com/AhmedNavaz/codeshi/issues/71)). Select output in the terminal, such as a failing test or a stack trace, and **Add to message** puts it in the message box as a code block that names its folder: a button at the top of the panel, the right-click menu, or ⇧⌘L (Ctrl+Shift+L on Windows and Linux). With nothing selected, it adds the screen as it shows. Nothing reaches an agent until you send the message, and the conversation never reads the terminal on its own. Output over 200 lines keeps its first 50 and last 150 lines, and at most 16,000 characters. Output that looks like it holds a token, key or password is left as it is, with a notice to check it before you send.
- **Add Remote access to your Home Screen** ([#115](https://github.com/AhmedNavaz/codeshi/issues/115)). The Away from home page now has a web app manifest, the Codeshi icon and Apple's web app tags, so an icon added to the Home Screen opens full screen with the right name and mark. After a phone pairs, it shows **Add to Home Screen** once, suited to the device: the Share menu steps on iPhone, the browser's own **Install** prompt on Android, and on a QR scanner app's built-in browser, a way to move the connection to Safari first. It isn't shown in an installed app or on Same Wi-Fi, which uses plain HTTP and an address that can change, and it stays at the bottom of the workspace list.
- **Type a code to move a connection to a Home Screen icon.** An iPhone Home Screen icon keeps its own storage and has no address bar to open a link in, so **Move to another browser** now also gives an 8-character code for Away from home, valid once for 5 minutes. An unpaired page asks for it. The code only opens a short-lived meeting point; the connection's key then travels sealed with a fresh key exchange, so the code can't be used to open anything stored in Firebase.

### Changed
- **A finished run's reply is read aloud as written.** Reading aloud used to say how long the run took, which files it changed and whether tests ran, then the first sentences of the reply. It now reads only the reply, in full, leaving out code and tables. A run that stopped early or left no reply still gets one short sentence. The setting is now **Read the reply aloud**.
- **A task in its own copy has your installed packages** ([#88](https://github.com/AhmedNavaz/codeshi/issues/88)). Each `node_modules` the folder's `.gitignore` leaves out is cloned into the task's copy before the agent starts, so its builds and tests can run there. On disks that can clone it takes about a second and no extra space, and installing in the task doesn't touch the folder's own; elsewhere it's linked, and the task card says it's shared. `.env` files are never copied, and the task card names the ones the copy lacks. None of this becomes part of the task's changes.
- **The Lounge fills the window** ([#14](https://github.com/AhmedNavaz/codeshi/issues/14)). The chat moves to the right of the window and stays live and full brightness, and the rest of the window is the Lounge. It opens on a grid of things to play, each with a title, a short description and your best score: Breakout, Snake, code trivia and a typing test. The developer quote and the weather choice share one row above the grid; an open game gets the whole Lounge. The weather keeps falling over Flow after you leave the Lounge, with no switch for it. **Rain and Snow now have real sound:** recorded loops that fade in and out as you switch, with a volume slider beside the weather choice (remembered on this computer). Nothing plays until you choose Rain or Snow, Clear is silent, and the recordings come with the app, so it still works offline. Sources and licences are listed in `public/sounds/CREDITS.md`. Choose one and it fills the Lounge, with Breakout and Snake drawn as large as the space allows and kept sharp; **All activities** or Escape goes back to the grid, and a game you leave waits, paused. The chat column is wide enough for the message box to keep its controls on one row. Opening and closing the Lounge moves the chat across to its new place instead of jumping, and the cards and the Lounge keep their size as they slide away.
- **Rain in the Lounge looks more like rain.** Drops now fall at different distances: near ones are longer, faster and brighter, far ones short and faint. Every streak leans with one slow wind and trails behind its drop, and a drop that lands leaves a few fine droplets and a thin ring instead of bouncing dots. Every drop splashes when it reaches the bottom of the window, far ones with a single fine droplet.
- **Screenshots an agent takes show in the chat, side by side.** Every agent is now told to save a picture it wants you to see inside the workspace and put it in its reply, instead of leaving it in a temporary folder for you to find. Images on lines of their own share a row, two or three across depending on the width of the chat, and a single image keeps its full size. Clicking one still opens it in the preview.

### Fixed
- **Rain and snow land only on what you can see.** They used to splash and settle along edges with no visible outline, such as a reply's text and the strip above your prompt, and on cards that were covered or scrolled out of view. They now land only on a top edge whose border or fill shows against what is behind it, in view and not covered, inside its rounded corners, and settled snow goes when its surface does.
- **Voice input keeps what you said before a pause.** After a silence the speech recognizer can start again with only the new words, which replaced the earlier sentence in the message box. The earlier words now stay and the new ones follow them.

Thanks to [@seeebbii](https://github.com/seeebbii) for the energy measurements and fixes ([#152](https://github.com/AhmedNavaz/codeshi/issues/152), [#154](https://github.com/AhmedNavaz/codeshi/pull/154)): weather drawn at most 30 times a second, games paced at 60 Hz speed, the setup glow running once and agent checks reused.

## [0.39.0] - 2026-11-10

### Added
- **Add a GitHub issue or pull request to your message** ([#18](https://github.com/AhmedNavaz/codeshi/issues/18)). **GitHub** in the composer, beside **Attach**, takes an issue or pull request number or link, or **This branch’s pull request**, and puts it in the message box for you to read and send. A pull request comes with its reviews, the review comments on the code and its checks, with the part of each failing job’s log that shows the failure. It reads through your own `gh` login, only when you click, and never writes to GitHub. Secrets and local paths are removed first, as in exports.
- **Run a plan as tasks** ([#108](https://github.com/AhmedNavaz/codeshi/issues/108)). A saved Orchestrate plan has **Run as tasks**, which starts each step as its own task beside the Workspace chat, with the agent, model and effort the step shows and the chat's own access. Steps wait for the steps they run after, count toward **Tasks at once** and the task limits, and work directly, in their own copy or waiting their turn like any task. If any step can't start, none does. The steps are grouped under the plan in **Tasks**, the Plan panel follows each one, **Stop plan** stops the working steps and cancels the rest, and **Close plan** closes them together. A step's task can't split into more tasks.
- **A near-black Dark theme** ([#127](https://github.com/AhmedNavaz/codeshi/issues/127)). The themes are now **Light**, **Dark** and **Graphite**. Dark is new: near-black surfaces with cream text, for low light and OLED screens. Graphite is the warm dark that was called Dark before, and a saved Graphite choice keeps its look. **System** switches between Light and the new Dark, so if you use System on a dark computer, Codeshi now shows the near-black Dark; choose Graphite to keep the warm look. The status bar, Settings, setup, the desktop menu and the phone page all offer the four choices.
- **Text size** in **Settings › Appearance** ([#127](https://github.com/AhmedNavaz/codeshi/issues/127)): **Larger** makes the sidebar, panels, Settings and the status bar about a point larger. Messages keep their size.
- **Setup starts with your workspace and asks how you want to work** ([#129](https://github.com/AhmedNavaz/codeshi/issues/129)). The four steps are now: your workspace, your working style, your agents, then your defaults. Name the workspace and choose its folders, or drop them on the window. Codeshi then shows each folder's Git branch and number of changes, and the kind of project its files suggest. **Choose your working style** puts Normal and Flow side by side, each with a small picture of its layout and three short lines: who chooses the agent and model, what you see, and what happens near a usage limit. Codeshi opens in the one you pick, and you can switch at any time with the Flow button or in **Settings › General**.

### Changed
- **Settings has a page for each subject** ([#130](https://github.com/AhmedNavaz/codeshi/issues/130)): **General** (Normal or Flow, and Keep awake), **Appearance**, **Agents & accounts**, **Routing & handoffs** (handoff offers and the context limit), **Testing**, **Phone & remote**, **Voice**, **Alerts** and **Updates**. Before, General held most of these. Search still finds a setting on any page, and **Remote access**, the command search and the connection prompts open the page that holds the setting.
- **Larger, steadier text and controls** ([#127](https://github.com/AhmedNavaz/codeshi/issues/127), [#130](https://github.com/AhmedNavaz/codeshi/issues/130)). The sidebar, the Tasks and side panels, the status bar and Settings use one type scale, with nothing below 11.5 px and status bar text at 12.5 px. The status bar is a little taller. Buttons use three heights (24, 28 and 32 px), and dialog titles share one size. Faint text is a little brighter in every theme, so it stays readable on selected rows.
- **Entering Flow takes a moment to say what it is.** The seal lands, then the word **Flow** and one line, "Let it flow. Watch it ship.", before the cards appear. It takes under two seconds. Leaving Flow is as quick as before, and with reduced motion the view just changes.
- **Workspace rows in the sidebar use two lines** ([#127](https://github.com/AhmedNavaz/codeshi/issues/127)). The name has the first line to itself, and the folder count, **running** and approvals waiting sit on the line below. Neither cuts off the other, and the row's menu button no longer hides them.

### Fixed
- The message box's bottom row stays on one line when the window is narrower. **Can edit files**, then the permissions picker, shrink to their icons before anything moves to a second line.
- Attachments leave the message box the moment you send or queue a message, together with its text, instead of staying until Auto finishes choosing an agent. The message shows its attachments in the chat at once, and they come back to the box if the message is refused.
- Removing an attachment corrects the "attached" count under the message box, and removing the last one clears the line.
- In Flow's **What's next**, the step being worked on is an ordinary row like the others, with a filled mark and stronger text, instead of a separate highlighted box that looked like the working agent's row in **What's left on your plans**.

## [0.38.2] - 2026-11-10

### Added
- **Ambient weather outside the Lounge.** A **Keep going outside Lounge** switch on the Ambient Weather card, on by default, keeps Rain, Snow or Clear playing over Flow's cards after you leave the Lounge. Turn it off there, or turn Flow off, and the weather goes away. The weather only shows in Flow mode.
- Rain and snow land on Flow's own cards and buttons, not just the Lounge cards.

### Changed
- The Lounge shows one activity at a time. Pick Breakout, Snake, Trivia or Typing on the left; the weather and a quote stay on the right. The Lounge remembers the last activity you picked. A game you switch away from waits, paused.
- The Ambient Weather card starts on Clear instead of Rain.
- The **What's next** card shows the highlighted task without the agent's status line, timer or pulsing "working" badge. The highlight alone marks the task that is running, and a plan step that is running is highlighted the same way.

### Fixed
- The highlighted task in **What's next** no longer runs past the edge of its card; long prompts are cut off with an ellipsis.
- In the Lounge, **Start Game** starts Breakout and Snake; before, the button changed to **Pause** but nothing moved. Keys now go only to the game you clicked, which is outlined, so the arrow keys no longer steer both games at once. A game pauses when you click away from it, and Space no longer starts Breakout while you're playing Snake.

## [0.38.1] - 2026-11-10

### Fixed
- In Flow, **Your space** and **Stay connected** stay fixed at the foot of their side. Only the cards above the divider scroll, and they no longer push those sections out of view.
- In Flow, the chevron for release notes and **Skip this version** sits at the end of the update button, on the same row, instead of on a row of its own below it. The button's label keeps its light colour on the accent fill.

## [0.38.0] - 2026-11-10

### Added

- **Smart results: what routing used and achieved, and how it compares with your manual tasks** ([#139](https://github.com/AhmedNavaz/codeshi/issues/139)). A **Smart results** card in Flow, named for the current mode, and a section in the **Tasks** panel show finished tasks, how many the project's tests verified, working time, new tokens, retries and interventions for Smart, Saver, Ultra and manual tasks, each kept separate. Routing assessments and failed or stopped work are included. Once there is enough evidence (10 finished tasks on each side, 5 verified manual tasks, matched by task size and context setting, and tests after at least half the tasks), each mode is compared per verified task with your manual tasks or the agent you usually choose. Totals are summed by size, a fixed-seed resample gives a range, and extra usage is shown as plainly as a saving. A mode that verified fewer tasks is reported as a quality regression, not a saving. Tokens across different agents and API spend are never stated as a saving, and plan allowance never enters results. **Details** shows the arithmetic and every task, **Leave out** removes one, and **Export report** saves a versioned JSON report without requests. It is worked out locally from saved conversations, with no model call and no telemetry. Routed runs now record which version of the routing rules chose them, and a choice you pinned while routing was on counts as manual.
- **Measured comparisons in evaluations** ([#139](https://github.com/AhmedNavaz/codeshi/issues/139)). `npm run eval -- compare` pairs saved `small-edit` and `routing-assessment` results on the same repository, hidden checks and agent, and reports the difference per verified run with its range and quality, using the same rules as Smart results. It runs nothing itself; live repeats still need `run --live` with a stated budget.
- **Lounge: something to do in Flow while the agents work** ([#14](https://github.com/AhmedNavaz/codeshi/issues/14)). A **Lounge** button beside **Leave Flow** slides Flow's cards away and dims the chat, which stays readable behind. In their place are Breakout and Snake, code trivia, a typing test and rain or snow that lands on the cards. The games start only when you click them, best scores stay on your computer, and nothing is downloaded. When an agent asks a question or needs an approval, or the run ends, the Lounge steps aside and Flow's cards return; once you've answered, it comes back. Drawing stops while a game is idle or paused, in Clear weather and while the window is hidden.
- **Each interface of a project review opens in its own preview window** ([#142](https://github.com/AhmedNavaz/codeshi/issues/142)). A launch profile with several interfaces, such as a website and its admin panel, has an **Open** button for each, and they stay open side by side with their own address and history. Opening one again brings its window forward as you left it. The preview's **Stack** lists the review's interfaces first, with this window's marked. **Pick element** works in each window and names the interface it came from. **Stop review** closes only the windows showing that review's services.
- **Roles, artifacts and checks on Orchestrate steps** ([#89](https://github.com/AhmedNavaz/codeshi/issues/89)). A step in a plan can carry a role (builder, reviewer, frontend, backend, database, design or QA), the artifact it should produce (contract, schema, diff, QA evidence or findings) and an acceptance check. The planning agent proposes them and you can change each one before running. A plan where a build step waits on a QA or review step is refused, and task usage is split by these roles. This is the first part of specialist teams: steps still run one after another, and task-specific briefs and gated integration aren't applied to runs yet.

### Changed

- **Long conversations fold their older part into the brief** ([#85](https://github.com/AhmedNavaz/codeshi/issues/85)). When the conversation before a task is over the 48 KB a fresh agent takes word for word, only the last two requests and their replies stay in full. Everything older becomes one line per request with the first paragraph of its reply, the decisions you wrote or gave as answers, and Codeshi's own test results for that work, each with the id of its original message. Before, the oldest part was simply cut off, and decisions found in your messages and answers only reached an agent after a context refresh; saved memory and context were always sent and still are. A context refresh folds what it leaves out too, in half the room. A request sent more than once is sent once, a refresh no longer repeats requests the brief already carries in full, and questions an agent asked that nobody answered go with the brief. On one long real conversation of about 24,000 messages, a fresh agent's first message went from about 68 KB to 41 KB while gaining 12 earlier decisions; a refresh went from about 30 KB to 34 KB. These are sizes of Codeshi's own message, not measured savings. The fold is worked out locally without a model, and **Earlier chat** in the **Brief** panel shows it with its sources.
- **Auto spends allowance that is about to reset** ([#153](https://github.com/AhmedNavaz/codeshi/issues/153)). Partway through a window, Auto keeps a safety margin below each limit. Close to a reset that margin would only expire unused, so Auto now spends it when every window past the margin resets soon (weekly within 6 hours, daily within 2, five-hour within 30 minutes) and the agent's other windows have room. Agents with ordinary room still come first, a model one tier down is tried before the queue pauses, and the top effort level isn't used on the last of an allowance. The note under the prompt and the run's activity say which allowance is being spent and when it resets. A window at its limit is never used.

### Fixed

- **Switching agents near a usage limit works, within the task's budget** ([#144](https://github.com/AhmedNavaz/codeshi/issues/144), [#87](https://github.com/AhmedNavaz/codeshi/issues/87)). In 0.37.0, whenever the check before launch found another agent or a smaller model, the run failed with "Assignment to constant variable." With a time, token or spend limit, or **Tasks at once** set to 1, the run's own reservation also ruled out every other agent. The switch now goes ahead without counting as a handoff. The run is saved as the new agent's, so its usage is read and counted by that agent's rules, and a restart and the next handoff count both follow the agent that did the work. Another agent starts a fresh session, while a smaller model of the same agent keeps its session. An agent billed per use is only switched to if you confirmed charges for that run, and that is checked again at launch.
- **Claude's spending cap on its command-line connection, and stopping at it** ([#87](https://github.com/AhmedNavaz/codeshi/issues/87)). A task's remaining API spend now reaches Claude as `--max-budget-usd` on the command-line connection too, not only the SDK. When Claude stops itself at the cap, the run ends as a task-limit stop that says how much was left, instead of an agent error reading `error_max_budget_usd`. If the cost Claude reported already stopped the run, only that stop is shown. A cost Claude never reported leaves the remaining allowance unknown, including after a restart.
- **The message box empties as soon as you send.** With Auto on, a sent message stayed in the box until the routing assessment finished. Send, **Queue** and **Add to run** now clear the box at once, and a sent message shows in the chat while the assessment runs. A message that is stopped or refused goes back in the box, ahead of anything typed since.
- **Flow's "How it's working now" card says the step and time once.** The status line already names the agent, its current step and the elapsed time; the row below repeated them, with a time that didn't update. That row now shows the agent, model, effort and phase.
- **Proceed with remaining allowance starts the queue** ([#153](https://github.com/AhmedNavaz/codeshi/issues/153)). The choice never reached routing, so the queue paused again with the same card, in a loop. It now starts the next prompt on the agent with the most room and holds for the rest of the queue, until the queue empties or you press **Resume queue**. If the queue pauses again after that, no agent has allowance left, and the card says so and no longer offers the button.

## [0.37.0] - 2026-11-09

### Added

- **Plan a message as steps with Orchestrate, in Flow and Normal mode** ([#97](https://github.com/AhmedNavaz/codeshi/issues/97), [#117](https://github.com/AhmedNavaz/codeshi/pull/117)).
  - Ask connected agents to plan complex goals into discrete sequential steps with cost and timing previews before executing anything.
  - Normal mode planning toggle in the composer arms read-only agent planning without requiring Flow routing.
  - Dedicated **Plan** side panel tab on the right alongside Brief, Tasks, and Agents with custom workflow pipeline iconography.
  - Inspect, reorder, edit, write, or discard step plans directly before running them.

- **Workspace inline image previews in chat** ([#80](https://github.com/AhmedNavaz/codeshi/issues/80), [#150](https://github.com/AhmedNavaz/codeshi/pull/150)).
  - Image files referenced in agent replies display inline thumbnails directly in the chat transcript.
  - Clicking an image opens full-size previews in the preview pane with zoom and pan controls.

- **Desktop preview vertical right-hand Stack and API inspector** ([#143](https://github.com/AhmedNavaz/codeshi/issues/143), [#147](https://github.com/AhmedNavaz/codeshi/pull/147)).
  - Relocated the Development, Stack, and API inspectors to a vertical collapsible sidebar on the right side of the desktop preview, allowing the live application page to preserve full vertical layout height.

- **Flow card improvements, binding windows and working agent parity** ([#107](https://github.com/AhmedNavaz/codeshi/issues/107)).
  - *What's next*: Replaced clipped separate-task text and cramped buttons with readable task titles, running lane activity (`Claude · on “...”`), accessible status text, a subtle pulsing indicator respecting `prefers-reduced-motion`, and dedicated "Open task" action buttons that keep background tasks reachable at narrow widths.
  - *How it's working now*: Removed redundant "Next message" information. Leads with the task actually running, agent/model, active phase, and reason for handoffs or waits while distinguishing composer agent, routing assessor, reviewer, and task lanes.
  - *What's left on your plans*: Names binding windows and model scopes (e.g. `Weekly limit for Opus`) instead of generic weekly labels.
  - *Highlight working agent parity*: Highlights all agents actively working across main runs and separate task lanes, transfers the indicator on handoffs, and clears it on completion, failure, or manual stop.

### Fixed

- **Project review survives long prerequisites and in-use ports** ([#141](https://github.com/AhmedNavaz/codeshi/issues/141), [#148](https://github.com/AhmedNavaz/codeshi/pull/148)). Prerequisite notes in a launch map are now trimmed, truncated to 120 characters and capped at ten per profile instead of rejecting the whole map, so preparation no longer fails with "List at most ten short prerequisites per profile." An occupied service port blocks only its own service (and anything that depends on it) rather than the entire launch, leaving unrelated services running; the Flow review card lists each busy port and offers **Attach to the running service** when a healthy server already answers its readiness URL, or **Use another port** to re-prepare the map. Codeshi still never adopts or terminates a process it did not start.
- **Smart routing near-quota graceful provider fallback in Flow mode** ([#144](https://github.com/AhmedNavaz/codeshi/issues/144)). In Flow mode with Smart routing, when a candidate provider's binding window is near its quota limit (e.g. weekly window at 97% used) at the pre-flight launch check, Codeshi now automatically re-routes to an eligible alternative subscription provider or model tier instead of hard-pausing prompt queue progression before launch. If no alternative provider or model has usable quota, the queue pauses with clear inline action controls to proceed with remaining allowance or switch providers directly without losing queue position.
- **Test suite stability and teardown races** ([#146](https://github.com/AhmedNavaz/codeshi/pull/146), [#149](https://github.com/AhmedNavaz/codeshi/pull/149), [#151](https://github.com/AhmedNavaz/codeshi/pull/151)). Resolved race conditions in Codex async question tests, usage watcher broker closure waits, Windows file unlinking during test directory cleanup, and mock agent startup timers.

Thanks to [@seeebbii](https://github.com/seeebbii) for Orchestrate plans, images shown in replies, the preview's inspector beside the page and steadier tests ([#117](https://github.com/AhmedNavaz/codeshi/pull/117), [#150](https://github.com/AhmedNavaz/codeshi/pull/150), [#147](https://github.com/AhmedNavaz/codeshi/pull/147), [#146](https://github.com/AhmedNavaz/codeshi/pull/146), [#149](https://github.com/AhmedNavaz/codeshi/pull/149), [#151](https://github.com/AhmedNavaz/codeshi/pull/151)), and to [@maaz-shah7](https://github.com/maaz-shah7) for the project review fixes ([#148](https://github.com/AhmedNavaz/codeshi/pull/148)).

## [0.36.0] - 2026-11-08

### Added

- **Run and review projects from Flow.** A Review your app card presents an agent-maintained launch map across attached folders, with named profiles, prerequisites, service dependencies and readiness checks. Start or stop the saved profile, inspect output and open the desktop preview to point at changes. Launch-map preparation, edits and startup diagnosis run in the background through the selected Flow routing mode, with a preparing indicator and the main chat left free; preparing a map never starts it.

- **Task usage by role** (#84). Tasks and local evaluation exports separate whole builder, read-only, routing assessment and reviewer calls, with time, measured tokens and missing-field coverage. Failed assessments remain in totals. A recorded `routing-assessment` evaluation runs the real assessor and builder against the small-edit baseline’s repository and hidden checks; rated evaluations reserve both invocations before dispatch. This is accounting verification, with no claim of live efficiency gains.

- **Model restrictions in Task limits** (#87). Set allowed model IDs for each agent, including local models, in the limits dialog. Empty allows all models for that agent.

- **Repeated context refreshes are measured and explained** (#85). Each fresh native session now records its seed, Codeshi's own first message in bytes and estimated tokens, and the turns it has had, shown in the context details as **Task brief at session start**, apart from the provider's reading, cached input and cumulative usage. A bounded refresh history per agent keeps the replaced session's seed and turn count. When a fresh session is due for another refresh within two turns, the details say why from those records: the brief alone was most of the target, the model's reported window caps the target, or the agent's own reads and tool output grew the session within one turn. Explanations built on an estimated reading say so. No model call is made.

### Fixed

- **Prompt queue layout clipping and visible pause controls** (#140). Bounded `.transcript-footer` and `#prompt-queue` with `min-width: 0` and container-width constraints so long pause error messages and multi-field routing metadata wrap or truncate cleanly with full title tooltips instead of blowing out horizontal layout tracks. Kept `#prompt-queue-toggle` ("Resume queue" / "Pause") and item action controls anchored and visible with `flex-shrink: 0`.

- **Named macOS bundle icon.** Package the fallback icon as `Codeshi.icns` alongside the layered icon, replacing the generic Electron resource name to help system menus refresh older cached artwork.

- **Unknown task usage no longer becomes reusable allowance** (#87). Missing API costs and partial token reports remain explicit across restarts and block further work under the affected limit until the person reviews it. Increasing a cap cannot fill in missing usage. Tasks shows native versus reported spend checks and measured overshoot; background reviews and routing assessments retain enforcement details in the parent journal and usage export. Local model restrictions are enforced even when every provider is allowed.

- **Smart rates referenced issues and plans before choosing a model.** Requests such as “do #85” now retrieve bounded GitHub issue requirements and recent comments, or explicitly named local plan excerpts, for the assessment. Issue lookups reuse a one-minute cache; missing references stay explicit and cannot receive a light task rating. Saver keeps its local-only assessment.

- **Flow turns routing on.** Entering Flow turns routing on again, with the mode that workspace last used in Flow or Smart, and leaving Flow turns it off. Since 0.34.1 Flow could open with routing **Off**, which Flow has no way to change except Agent settings.

## [0.35.0] - 2026-11-08

### Added

- **Adaptive quota thresholds and autonomous Flow handoffs** (#135). Replaced static 90% quota thresholds with spendability-aware capacity evaluation considering window duration, reset cadence, and expected task workload. In Flow mode, handoffs execute autonomously under the task execution policy without surfacing manual suggestion cards, while Normal mode preserves interactive offers.
- **Flow mode card polish and multi-window glance** (#136). Unclipped extra task button titles in What's next with an active pulse indicator for in-flight tasks, cleaned status copy, highlighted the currently executing agent on the plans and status cards, and added an overlay glance view for all rate-limit windows.
- **Task budget diagnostic probe detection and retry resets** (#137). Read-only commands and diagnostic network probes (such as `curl`, ping, non-mutating `gh` and `git` queries) no longer increment the repeated-failure stop counter on non-zero exits. Stopped tasks can be reset and retried via explicit user prompts ("retry", "dismiss and retry") or the "Dismiss and retry" / "Extend budget" actions.

### Fixed

- **Smart routing quota freshness on first Send** (#134). Bounded joining and refreshing of in-flight account and plan usage probes before rejecting stale readings, avoiding spurious 'no connected agent' errors when usage cache entries age out.

## [0.34.1] - 2026-11-08

### Added

- **Task execution policy and safe manual takeover** (#131). New work defaults to Normal authority, while selecting Smart, Saver or Ultra delegates Flow for new tasks. Each task retains its own journaled policy with independent flags for routing, handoffs, retries, reviews, checks, reset waits and subtasks. Taking manual control increments the policy revision and immediately revokes pending automatic decisions, pauses routed queue items, and prevents native startup under stale authorizations while allowing running commands or turns to settle safely.
- **Codeshi sharing container image.** The private-link Ask a Friend container is now published as `ghcr.io/ahmednavaz/codeshi-sharing`.

### Fixed

- **Codex JSON-RPC framing on long messages and Unicode separators** (#133). Delimit Codex app-server protocol frames strictly on newline characters rather than relying on readline line breaks, preventing unterminated string and unexpected token syntax errors when streaming long replies or multi-chunk messages.
- **Desktop Flow smoke test.** Ensure Flow layout validation accounts for explicit routing mode delegation.
- **Release builds could not get Electron** (#138). Packaging fetched Electron's checksum file from GitHub in a single request, and GitHub's downloads answered with gateway timeouts for a morning, so no build of 0.34.0 could be published. Packaging now verifies Electron against the checksums the electron package itself ships, tries GitHub again with growing pauses when a download fails or stalls, and gets the file from the npmmirror.com mirror when GitHub keeps failing, still checked against those checksums.

## [0.33.1] - 2026-11-08

### Fixed

- **Desktop smoke test routing assertion.** Accept `smart` (and legacy `balanced`) mode during Flow smoke tests.

## [0.33.0] - 2026-11-08

### Added

- **Smart, Saver and Ultra routing modes, spending allowance where it resets soonest** (#128). Three new modes replace Cost saving, Balanced and Maximum quality across Flow, the Agents panel, usage notices and saved conversations. Every mode spends allowance where it resets soonest, valuing remaining headroom by how long it has to last across 5-hour, daily and weekly windows. A prompt is routed to the plan with the most spendable headroom before its reset, with continuity preserved when switching agents isn't worth the brief and reread. Saver uses local rules only on Send with no agent assessment call, keeping effort low and asking before any test retry. Smart assesses on Send and retries failed tests one step up. Ultra uses the strongest models and deepest reasoning first (stepping down within the agent before switching away when a weekly window is exhausted), retries one step up, and sends finished changes for an independent read-only review when a second subscription agent has room.
- **Open files and links from a reply, and changed files from a step** (#109). A web address written plainly in a reply is now a link, like a named one. A file named in a reply or in inline code opens in the file preview, at its line when one is given (`src/app.js:24`, `#L24-L30`); a file in a step's list of changed files opens its uncommitted changes, or the file itself when there are none. In a workspace with several folders, `folder/path` goes to that folder, and a path that exists in more than one folder offers a button for each instead of guessing. Links and files work from the keyboard. A path outside the workspace, a missing file or a folder that isn't on this computer says so, and a reference to a folder reads as plain text.

### Fixed

- **Answer Gemini's questions in Codeshi.** Antigravity's multiple-choice questions now appear in the question card instead of ending the run with an unsupported-action error and a request to continue in its native client. Pick an offered answer or skip the question, and Gemini continues. Full auto-approval still waits for your choice.
- **Remote access asked for the QR code again, while the computer still said connected** (#114). Each browser on a phone keeps its own pairing, so a page opened in a QR scanner's browser wasn't paired in Safari or from a Home Screen icon. A browser that isn't paired now says so, and **Move to another browser**, at the bottom of the phone's workspace list, carries an approved connection over with a one-use link, without approving again. An **Away from home** phone now stays allowed for up to a week and across Codeshi restarts, until you remove it or turn remote access off; **Same Wi-Fi** stays at 12 hours and still ends when Codeshi quits. The computer's list tells a phone that is active now from one that is only allowed, with when it was last seen, and approving the same phone again replaces its old connection instead of using up the five slots.
- **Opening a long workspace chat** (#124). 0.32.0 opened the chat on its latest messages, but the app still stalled for seconds on a workspace with a long history: replaying the saved conversation looked up each message by scanning the whole list, and the side panels fetched the whole conversation just to find its id. A 55 MB journal of 100,000 records now opens in under half a second instead of thirteen. Changing the agent, mode, permissions, model or routing, or refreshing the context, no longer replaces the paged chat with every message, and the first scroll to the end no longer loads older pages by itself.

## [0.32.0] - 2026-11-07

### Added

- **Choose model and effort for each queued message** (#113). Model and effort pickers remain active while a run is working, applying to the prompt being queued without changing the active run. Queued messages display their model, reasoning effort, and routing details. Both model and effort can be edited directly on queued messages before they start, on desktop and phone. Changing the model of a routed message turns it into a manual choice.

### Changed

- **Gemini keeps its session between messages.** Every message used to open a new Antigravity session with only a summary of the chat, so Gemini started each one by reading the files and the issue again. It now continues its own session, as Claude and Codex do, and starts a fresh one with a task brief when you switch agents, change the workspace folders, refresh the context or reach the context limit. If the runtime no longer has the saved session, that message stops and says so, and the next one starts over. Each Gemini run now also records the tokens its turns used, next to the context the session holds.
- **No limits in the message box.** The usage chip is gone from Normal as well as Flow, leaving its room to the options there. Limits are in **Plan usage** in the **Agents** panel, and on Flow's cards.

### Fixed

- **Connectors and MCP tools in Codex** (#111). A GitHub connector write, or any tool Codex asks to run, no longer fails with `user rejected MCP tool call` when nobody rejected it. It now follows the run's access: Full auto-approval runs it and notes it in the timeline, and Ask before changes shows who it reaches and what it will do, then Approve or Deny. A denial ends with that call and is not remembered. Read only says it blocked the call.
- **What an MCP server asks of you, in Codex** (#111). A sign-in or a form now shows as a question, with a link that names its address, and waits for you even in Full auto-approval. Anything Codeshi can't show is cancelled with a note that says so. A request for more access also gets a real answer instead of a silent refusal.
- **Long workspace chat opening and paging** (#124). Opening a workspace with thousands of messages no longer stalls or hangs the app. The conversation opens immediately on its latest messages, with older history loaded in pages as you scroll up while preserving scroll position. Search across unloaded history, jumping to past runs or messages, live message streaming, and export continue to cover the full conversation history.
- **Gemini's messages stay apart and in order.** Everything Gemini wrote in a run used to join into one block, at the point it first spoke, so later text sat above the steps it came after. Each message now appears where it happened.
- **Gemini's steps show what happened.** Steps were labelled only "Tool", with `Running view_file` as their description and no result. Commands now show their output and exit code, reads name the file, edits show their diff, and web searches show their query and answer, as with Claude and Codex. Task records and handoff briefs now see Gemini's file changes and failed commands.
- **Long Gemini runs no longer stop at 30 minutes.** A run ended exactly 30 minutes in however busy it was, with `Gemini protocol timed out`. It now ends only after 15 minutes of silence, and a running command or an unanswered approval doesn't count. Stop still ends a run at any time.
- **Gemini's commands find your tools.** Opened from Finder, Gemini couldn't find `node`, `npm`, `gh` or anything else you installed, and spent turns working around it. Its commands now also search your Node version manager folders, Homebrew, Volta, Bun and pnpm.
- **Ask before changes, with Gemini.** Safe read-only commands such as `git status` no longer ask, and a command can now be allowed for the run or remembered, because the approval rules can read Gemini's commands. One edit asks once instead of twice, and the card names the file instead of `Run client_edit_file?`.
- **A failed read no longer fails a Gemini run.** Reading a folder, a missing file or a very large one is now an error Gemini handles, instead of marking the whole run as denied when it ends. A path outside the workspace is still reported.
- **No stray `skills` folder from Gemini.** The Antigravity runtime adds `skills/system/run-workflow` to the folder it runs in, where it can end up in a commit. Codeshi now removes it after each run, but never a copy that was already there or anything else in that folder.
- **Links in replies.** A link no longer shows as raw `[text](address)`. A web address opens in your browser, and a link to a local file reads as its name.
- **Plan usage rows.** When an agent also showed a weekly limit, the row broke: its bar shrank, its reset time was cut off, the weekly line sat to one side and Gemini's name disappeared.
- **Gemini's 5-hour limit.** Google's "Five Hour" now reads as **5-hour** and leads Gemini's row, as it does for the other agents.
- **Message box options in a narrow layout.** Options now move to a second line instead of shrinking until they overlap or disappear. **Permissions** also keeps its label down to a narrower width.

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

Thanks to [@seeebbii](https://github.com/seeebbii) for links you can click in the terminal, the deployment templates for the private-link service, merging where Git converts line endings, and the test suite on Linux and Windows ([#122](https://github.com/AhmedNavaz/codeshi/pull/122), [#121](https://github.com/AhmedNavaz/codeshi/pull/121), [#120](https://github.com/AhmedNavaz/codeshi/pull/120), [#118](https://github.com/AhmedNavaz/codeshi/pull/118), [#119](https://github.com/AhmedNavaz/codeshi/pull/119)).

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
[0.35.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.35.0
[0.34.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.34.1
[0.33.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.33.1
[0.33.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.33.0
[0.32.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.32.0
[0.31.1]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.31.1
[0.30.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.30.0

[0.37.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.37.0
[0.36.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.36.0
[0.38.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.38.0
[0.39.0]: https://github.com/AhmedNavaz/codeshi/releases/tag/v0.39.0

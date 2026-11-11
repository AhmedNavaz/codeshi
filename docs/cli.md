# The codeshi command

`codeshi` works with your agents from a terminal ([#90](https://github.com/AhmedNavaz/codeshi/issues/90)). On its own it opens an interactive session; with a command it runs once, for scripts. Either way it's a client of Codeshi's engine, not a second one: a run started here is the same run in the window, with the same conversation, approvals, task limits, handoff and history, and a run started in the window can be followed, answered or stopped here.

Codeshi doesn't need to be open. When it isn't, the command starts it in the background: no window and no Dock icon, only the menu bar status. A background start quits by itself after two minutes with no terminal attached and nothing working or queued. `/open`, the status menu, or opening Codeshi brings up the window, and from then on it stays open as usual.

## In the Codeshi window

**CLI** in the status bar, beside **Terminal** and **Run**, runs this same command in a tab of the window, so you can try it without installing anything. It takes the conversation's place, with **Chat** and **CLI** tabs above. Both are the same conversation and agent: a message sent in one shows in the other, and an approval or a handoff can be answered in either. **Chat** goes back to the conversation and leaves the session running. **×** on the CLI tab, Ctrl+D or `/exit` ends the session and closes the tab; a run carries on in the chat. `/open` shows the chat. Each workspace has its own CLI tab, so `/workspace` isn't offered there; pick another workspace in the sidebar. In the tab the command uses the terminal's 256 standard colours.

## Install

On macOS, choose **Codeshi › Install ‘codeshi’ Command…**. It links `/usr/local/bin/codeshi` to the command inside the app, and macOS asks for an administrator's password if that folder needs one. The command runs with the Node built into Codeshi, so nothing else needs installing. **Codeshi › Remove ‘codeshi’ Command** removes the link. If a `codeshi` that isn't Codeshi's is already there, it's left alone and the install says so.

From a source checkout, run `bin/codeshi` (it uses the `node` on your PATH).

Windows and Linux installs come later.

## The session

Run `codeshi` in a workspace's folder. A folder that isn't in a workspace yet is added if you answer yes; `--workspace` picks one by name. `--agent`, `--model` and `--effort` set the conversation's agent, model and effort first, as the picker in the window does.

The finished parts of the conversation go into the terminal's own scrollback, so you scroll and search them as you would any output, and only the run that's working and the prompt are redrawn. The session starts with a few lines from earlier in the conversation. The line under the prompt shows the workspace, branch, agent, model, effort, access and how much context the conversation uses.

- **Steps** show as `● Update(math.js)`, `● Bash(npm test)` and so on, with a short result under each: lines read, matches found, the first lines of a command's output, or an edit's diff.
- **Approvals** open a box with what the agent wants to do (the command, or the edit as a diff) and **Yes**, **Yes, and don't ask again for this in this run** (when Codeshi offers it) and **No**. Choose with the arrow keys and Enter, a number, or `y` and `n`; Esc is No. An approval answered in the window closes here.
- **Questions** from the agent open the same way. With several, they come one at a time. Space or a number picks options when more than one is allowed, **Type something else** takes your own answer, and Esc skips the questions.
- **A handoff offer**, when an agent nears its usage limit, asks whether to hand the task to the agent Codeshi suggests, and says when that would bill an API account.
- **A message sent while a run works** joins that run when the agent can take one, or waits in the queue for the next.

### Keys

| Key | Does |
|---|---|
| Enter | Send. |
| `\` then Enter, Option+Enter, or Shift+Enter where the terminal reports it | New line. |
| Esc | Stop the run that's working; otherwise close the list or clear what you typed. |
| Shift+Tab | Switch access: asks before changes → edits without asking → read only. |
| ↑ ↓ | Earlier messages, or move between lines. |
| Tab | Complete a command or file. |
| `?` | Show the keys, when the prompt is empty. |
| Ctrl+C | Clear what you typed; twice to leave. |
| Ctrl+D | Leave, when the prompt is empty. |
| Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+K, Ctrl+W | Start and end of the line; delete to the start, to the end, or the word before. |

Leaving never stops a run: it carries on in Codeshi, and `codeshi` brings you back to it.

### Slash commands

| Command | Does |
|---|---|
| `/agent [codex\|claude\|gemini]` | Switch agent. Without a name, choose from a list. |
| `/model [id]`, `/effort [level]` | Choose the model, or how hard it thinks, from the agent's own list. |
| `/access` | Read only, ask before changes, or edit without asking. |
| `/stop`, `/continue` | Stop the run; continue the last one. |
| `/handoff [agent]` | Hand the task to another agent: accepts Codeshi's offer while a run works, or continues the last task with the agent you choose. |
| `/queue`, `/tasks`, `/board` | Queued messages, the workspace's tasks, and the board's cards by column. |
| `/status`, `/workspace [name]` | Every workspace and what it's doing; switch to another. |
| `/open` | Open this conversation in the Codeshi window. |
| `/clear`, `/help`, `/exit` | Clear the screen, list commands and keys, leave. |

`@` followed by part of a file name lists matching files in the workspace; Tab or Enter adds the path to your message. To send a message that starts with `/`, start it with `//`.

## Commands

| Command | What it does |
|---|---|
| `codeshi status` | Lists workspaces, whether an agent is working in each and how many approvals or questions wait for you. `*` marks the workspace that holds the current folder. |
| `codeshi run <message>` | Sends the message to the workspace's chat, as typing it in the app does, and follows the run until it ends. `codeshi run -`, or `codeshi run` with a pipe, reads the message from standard input. |
| `codeshi continue` | Continues the last run, as **Continue** does in the app. With `--agent`, another agent continues it. |
| `codeshi wait` | Follows the run that's working now until it ends. With nothing working, it reports how the last run ended. |
| `codeshi stop` | Stops the run that's working in the workspace's chat, as **Stop** does. |
| `codeshi tasks` | Lists the workspace's tasks. |

### Options

| Option | Applies to | Meaning |
|---|---|---|
| `-w`, `--workspace <name\|path>` | all but `status` | The workspace to use. By default it's the one whose folder holds the current directory (the deepest, if folders are nested), or the only one. |
| `-a`, `--agent <codex\|claude\|gemini>` | `run`, `continue` | The agent. By default, the one picked in the app's message box. |
| `-m`, `--model <id>` | `run`, `continue` | The model. By default, that agent's choice in the app. |
| `-e`, `--effort <level>` | `run`, `continue` | The effort. By default, that agent's choice in the app. |
| `--detach` | `run`, `continue` | Returns as soon as the run starts. `codeshi wait` follows it later. |
| `--no-input` | `run`, `continue`, `wait` | Never asks in the terminal. When the run needs you, the command ends with code 3. |
| `--json` | all | Prints one JSON result on standard output when the command ends. |
| `--jsonl` | all | Prints one JSON event per line on standard output as things happen, ending with the result. |

A run uses the workspace chat's access and approval settings. A run from the command line is never published: nothing is pushed, merged or released because of it.

## Output

Progress goes to standard error, and the agent's reply goes to standard output, so `codeshi run "Summarise the README" > summary.md` saves only the reply.

With `--json` or `--jsonl`, standard output holds only JSON. Every object has `"v": 1`, the schema version. A field may be added in version 1; a change in meaning gets a new version.

### The result

```json
{ "v": 1, "result": "complete", "workspace": { "id": "df57262110c988ff", "name": "app" },
  "conversationId": "871f7d05-…", "runId": "b0ef4aa6-…", "taskId": "b0ef4aa6-…",
  "agent": "claude", "model": null, "reply": "Done.", "error": null, "errorCategory": null }
```

| `result` | Meaning | Exit code |
|---|---|---|
| `complete` | The run finished. | 0 |
| `started` | `--detach`: the run started. | 0 |
| `idle` | `wait` or `stop` found nothing working, and no earlier run. | 0 |
| `status`, `tasks` | The listing, in `workspaces` or `tasks`. | 0 |
| `incomplete` | The run ended without finishing. `errorCategory` says why when known, such as `quota` for a usage limit, and `error` holds the message. | 1 |
| `stopped` | The run was stopped, here, in the app or by Codeshi. | 1 |
| `needs_input` | The run waits for an approval or a question. `pending` lists them, each with `id`, `kind` (`approval` or `question`), `summary` and `detail`. | 3 |
| `detached` | You pressed Ctrl+C. The run carries on. | 130 |
| `error` | The command couldn't do what was asked; `error` says why. | 2, 4 or 5 |

`runId` identifies one run of an agent. `taskId` identifies the piece of work, and stays the same when a handoff or retry continues it in a new run. `conversationId` is the workspace chat. They're the IDs Codeshi uses in its own history.

### Events (`--jsonl`)

| `type` | When | Fields |
|---|---|---|
| `started` | The run is seen working. | `workspace`, `conversationId`, `runId`, `taskId`, `agent`, `model` |
| `activity` | A step of the run, such as a command it ran or a file it changed. | `runId`, `id`, `role`, `text` |
| `message` | The agent's reply, once complete. | `runId`, `id`, `role`, `text` |
| `needs_input` | An approval or question appears. | `runId`, `id`, `kind`, `summary`, `detail` |
| `result` | Last line: the result above. | as the result |

When a handoff or retry continues the task in a new run, the command follows it, and `started` comes again with the new `runId`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | The run didn't finish or was stopped. |
| 2 | Usage: an unknown command or option, no message, or no matching workspace. |
| 3 | The run needs your input, and the command can't ask for it. |
| 4 | An agent is already working in the workspace's chat. |
| 5 | Codeshi couldn't be started or reached, or didn't accept the connection. |
| 130 | You pressed Ctrl+C; the run carries on. |

## Approvals and questions

In a terminal, an approval is asked there and in the app at once, and the first answer counts. `y` allows it, `n` denies it, and `r` allows it for the rest of the run when the app offers that. Questions are answered in the app; the command keeps following.

Without a terminal (a script, a pipe, `--no-input`, or a message read from standard input), the command never answers. It ends with `needs_input` and code 3, and the approval keeps waiting in Codeshi. Answer it there, then `codeshi wait` follows the run again.

## Ctrl+C, closed pipes and reconnecting

- **Ctrl+C** stops following, not the run. The command ends with code 130 and says how to follow or stop the run. `codeshi stop` stops it.
- **A closed pipe** on standard output, as in `codeshi run … | head -1`, stops following as Ctrl+C does. The run carries on.
- **Reconnecting:** `codeshi wait` follows whatever is working in the workspace's chat, so it picks up a run after Ctrl+C, `--detach`, `needs_input` or a closed terminal. If the run has ended, it reports how.
- **If Codeshi quits** while a run is followed, the run stops, as quitting Codeshi always stops its runs, and the command ends with code 5. In the session, the line under the prompt says so, and Enter starts Codeshi again.

## How it connects

When Codeshi isn't open, every command but `stop` and `wait` starts it in the background first and waits up to 45 seconds for it; those two have nothing to act on. The command inside the app opens the app itself (`open -g -a Codeshi.app --args --background` on macOS); a source checkout starts `desktop/launch.mjs --background`. A started app loads no page until its window is wanted, so it costs little while it runs in the background.

While Codeshi runs, it writes `cli.json` in its data folder (`~/Library/Application Support/Codeshi` on macOS) with the address of its local engine, an access token made for that launch and the app's process ID. Only your user can read it, and Codeshi removes it when it quits. The command reads it, checks that the app is still running, and talks to the engine on `127.0.0.1` only. `CODESHI_CONNECTION` can name another file, for example a copy of Codeshi run from source with its own data folder.

The command never runs an engine of its own, so the app and the terminal can't both run work in a workspace.

## Not yet

- Running without the desktop app at all, such as over SSH, in CI or on Linux servers.
- Attaching images or files to a message from the session (paste a path instead).
- Flow routing from the command line: a run uses the agent you name or the one picked in the app.
- Starting tasks in their own copy, workflows (`codeshi workflow run`), `codeshi skills` and `codeshi doctor`.
- Installing on Windows and Linux.

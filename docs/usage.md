# Usage

## Starting a session

| | |
| --- | --- |
| `dshtui` | Start in the current folder |
| `dshtui -C ~/code/api` | Start in a different folder |
| `dshtui "run the tests"` | Send a first message on startup |
| `dshtui --resume` | Choose from your twenty most recent sessions |
| `dshtui --resume <id>` | Reopen a session you know the id of |
| `dshtui --help` | All flags this interface adds |
| `dshtui --setup` | Create the `tui` profile, once, before the first run |

`dshtui` is a small wrapper around the harness's own launcher: it finds `dsh`, adds `--profile tui`, and pins the session to the folder you ran it from. Everything else is passed through, so `dshtui <anything>` and `dsh --profile tui <anything>` behave the same. Use whichever you prefer.

`-C` (or `--cwd`) sets the folder the *session* works in. It does not change where the command itself runs from.

Reopening a session with `--resume` keeps the folder that session was created in, because that folder is recorded in the session file. `-C` is therefore ignored when resuming, rather than quietly moving an old conversation to a new folder.

`dshtui` already opens the folder you are standing in, so no alias is needed for that.

If your harness is a source checkout with no global `dsh` command, give `dshtui` its launcher once:

```sh
export DSH_BIN=~/path/to/deepseek-harness/node_modules/.bin/dsh
```

Without a global `dsh` and without that variable, `pnpm dsh` still works — but only from inside the harness folder, because that script belongs to the harness repository. See [Install → Troubleshooting](install.md#command-dsh-not-found).

## Keys

| | |
| --- | --- |
| `enter` | Send |
| `shift-enter`, `alt-enter` | Start a new line without sending |
| `tab` | Accept the highlighted suggestion |
| `ctrl-c` | Stop the agent; if it is not running, quit |
| `ctrl-d` | Quit, from anywhere — including a picker, a question, or an approval prompt |
| `ctrl-l` | Clear the display |
| `ctrl-o` | Change how much tool output is shown: compact, full, hidden |
| `↑` `↓` `enter` `esc` | Move, confirm, and close a box or a suggestion list |

Editing keys: `←` `→` to move, `home` and `end` (or `ctrl-a` and `ctrl-e`) for the ends of the line, `backspace` and `delete`, and `ctrl-u`, `ctrl-k`, `ctrl-w` to delete to the start, to the end, and by word.

Pasting several lines inserts all of them and sends them as a single message.

### About shift-enter

By default, a terminal sends exactly the same bytes for `shift-enter` as for `enter`, so no program can tell them apart. To make the difference visible, this interface asks your terminal for one extra keyboard feature on startup: the lowest option of the kitty keyboard protocol, called *disambiguate escape codes*. Terminals that support it (kitty, Ghostty, WezTerm, foot, recent iTerm2 and Alacritty, Konsole) then report a modified `enter` as its own sequence.

That request has a side effect worth knowing about. On a terminal that supports it, `esc`, `alt`, and `ctrl` combinations also stop arriving in their old form: `ctrl-c` becomes the sequence `CSI 99 ; 5 u` instead of the single byte `0x03`. This project reads both forms, so every shortcut in the table above works either way. The details are in [Design → Keyboard input is read in both formats](design.md#keyboard-input-is-read-in-both-formats).

On a terminal that ignores the request, `shift-enter` still sends the message. That is why the status line suggests `alt-enter` instead: `alt-enter` works everywhere. The extra mode is switched off when the interface exits, so the next program reads your keyboard normally.

If a key does nothing, `node tools/keyprobe.mjs` shows what your terminal sends and how this project reads it. That output is exactly what a bug report needs.

## Commands

Type `/` to see the commands your agent actually has. They come from two places.

**Handled by this interface:**

| | |
| --- | --- |
| `/model` | Change the model — the list shows every model your configured providers offer |
| `/exit`, `/quit` | Leave, the same as `ctrl-d` |

**Coming from the harness**, so the list depends on which plugins your profile loads. With the standard set:

| | |
| --- | --- |
| `/compact` | Summarize older conversation history to free up context |
| `/plan`, `/plan off` | Enter or leave planning mode |
| `/goal` | Show or set the goal for a long task |
| `/permission` | Change the permission preset (see below) |
| `/feedback` | Record a note about this session |

Every command prints its result into the transcript: a `·` line for normal output, and a `✗` line if it failed. A command name that matches nothing is reported instead of being sent to the model:

```
✗ unknown command: /help · type / to see what there is
```

The check uses the harness's own rule for what a command line looks like, so the name must either end the line or be followed by a space. This means `/etc/hosts is missing` is treated as an ordinary message and reaches the model unchanged, while `/tmp is full` is treated as a command and reported as unknown. That trade-off is deliberate: a mistyped command is far more common than a message starting with a folder name.

> [!WARNING]
> **`/goal <objective>` does more than record a goal.** It starts the harness's goal driver, which immediately begins working on that objective by itself, for up to 256 rounds, using tools in your folder. Use `/goal` with no text to just view the current goal, and `/goal pause` or `/goal clear` to stop one.

## Permissions and the sandbox

Read this before pointing a session at code you care about.

In a standard setup, **the agent's ordinary tool calls are not shown to you for approval before they run.** It can create, edit, and delete files inside your working folder and run shell commands there.

This is a property of the harness's standard plugin set, not a decision this interface makes. The approval prompt is implemented here and it does appear — but only when something explicitly asks for approval, and in the standard set only one case does: when the model asks to work outside the sandbox. Ordinary calls inside the folder are simply allowed. Operations outside the folder are refused outright rather than turned into a question.

If you want ordinary tool calls to ask first, add a plugin that makes that decision — `@deepseek-ai/dsh-hooks-claude-code`, or your own `tools/pre-execute` policy. Which calls need approval is a decision about how you deploy the harness, so this interface does not make it for you.

`/permission` shows and changes the preset:

```
· current preset workspace-write (available: read-only, workspace-write, danger-full-access)
```

- `read-only` — the agent can read and search, but not change anything. Use this when you are only asking questions.
- `workspace-write` — the default. The agent can change files inside the folder you opened.
- `danger-full-access` — no sandbox. The name is accurate.

## Sessions

Sessions are saved by the harness itself, so a conversation survives quitting:

```sh
dsh --profile tui --resume          # choose from the twenty most recent
dsh --profile tui --resume <id>     # reopen a session directly
```

A reopened session looks exactly like the one you watched happen — reasoning, diffs, tool output and all — because the saved log is redrawn through the same code that drew it live.

## If it refuses to start

This interface needs a real terminal for both input and output. If its input or output is redirected to a file or another program, it exits with an error instead of waiting forever with nothing on screen:

```
dsh-tui: needs a terminal on stdin and stdout; for a piped or scripted run use --profile headless
```

Some wrapper scripts also cause this, because they do not pass a terminal through to the program they start. Run the harness command directly in that case, or use `--profile headless` for scripts.

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

If your harness is a source checkout rather than a global install, name the checkout once:

```sh
export DSH_HARNESS=~/path/to/deepseek-harness
```

A checkout has no `dsh` executable to point at — its launcher is a script — so this names the folder and lets `dshtui` read that script from it. See [Install → Troubleshooting](install.md#dsh_bin-points-at--which-does-not-exist).

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
| `/model` | Change the model. Takes a name (`/model deepseek-v4-pro`) or opens a picker |
| `/reasoning` | Change how hard the model thinks. Takes a level (`/reasoning max`) or opens a picker |
| `/usage` | Choose what the status line reports: `cost`, `tokens`, or `off`. Opens a picker with no argument |
| `/profile` | `on` or `off` for the per-turn time breakdown; bare flips it |
| `/exit`, `/quit` | Leave, the same as `ctrl-d` |

Each of the first three works the same way: **name the value and it changes, type the command alone and it asks.** You rarely have to do either from memory, because the suggestion list offers the values as soon as the command name is followed by a space:

```
› /reasoning
    › /reasoning off      no thinking at all
      /reasoning high     the usual level
      /reasoning max      as hard as it goes
      /reasoning default  whatever the provider does when nothing is set
      tab complete · esc dismiss
```

`tab` on `/rea` completes the name and leaves the cursor after a space, and the values appear there without another keystroke. The picker is the fallback for when you want to read the descriptions, not the only way in.

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

### Reasoning levels

`/reasoning` lists the levels the provider you are on actually accepts, rather than a fixed set — for the DeepSeek adapter that is `off`, `high`, and `max`, and a deployment configured with thinking switched off offers only `off`. There is also a `default` choice, which is not a level: it clears your selection so the provider does whatever it does when nothing is set.

The change applies from the next step, so pressing it mid-turn does not split a request across two settings. It lasts for the session only; the level your next launch starts on comes from your settings file, not from this.

The status line names the level next to the model, but only while it differs from the one your setup already defaults to — otherwise it would spend columns every frame on a fact you did not choose.

### Tokens and cost

The status line carries a running total for the session:

```
● ready · deepseek-v4-flash · ↑8.8k ↓1.6k $0.018 · ▏░░░░░░░ 14k/1.0M
```

`↑` is every prompt token sent, cached or not; `↓` is every token generated, thinking included. Both come from the provider's own accounting, so they are what you were billed for rather than an estimate, and reopening a session brings its totals back with it.

`/usage` chooses how much of that to show — `cost`, `tokens` for the counts without the money, or `off`.

#### Which rates it uses

DeepSeek's two routes are priced out of the box, at the published rates, and each message is charged at the rate that applied **when it ran** rather than at whatever is in force now. That matters because the standard price is roughly twice the discounted one:

| | | cache hit | cache miss | output |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | off-peak | $0.007 | $0.22 | $0.66 |
| | peak | $0.014 | $0.44 | $1.32 |
| `deepseek-v4-pro` | off-peak | $0.022 | $0.66 | $1.98 |
| | peak | $0.044 | $1.32 | $3.96 |

Dollars per million tokens. Peak is 01:00–04:00 and 06:00–10:00 UTC; every other hour is off-peak, which is most of the day.

Rates move, and this file will not. Both the prices and the peak windows are overridable in `~/.dsh/cordis.patch.yml`, and an entry you write **replaces** the shipped one for that route rather than merging into it — correcting one price should not leave the rest at whatever the release was built with:

```yaml
- id: tui
  config:
    pricing:
      # Keyed provider/model. The bare fields apply off-peak; `peak` is the
      # exception, because it is the narrower window.
      deepseek-official/deepseek-v4-flash:
        input: 0.22          # cache miss
        cachedInput: 0.007   # cache hit
        output: 0.66
        peak:
          input: 0.44
          cachedInput: 0.014
          output: 1.32
      # A model id on its own covers whatever route serves it, which is how you
      # price one model the same way everywhere.
      deepseek-v4-pro:
        input: 0.66
        cachedInput: 0.022
        output: 1.98
    peakHoursUtc:
      - { from: '01:00', to: '04:00' }
      - { from: '06:00', to: '10:00' }
```

**Nothing is priced by model id alone unless you ask for it.** The same model through a gateway is billed by the gateway, on its own terms, so the shipped rates are pinned to the `deepseek-official` route. A model on a route with no entry is counted but not priced — you get the tokens and no `$`, which is the honest reading — and a total that is missing part of the session is marked `~` so it cannot be mistaken for the whole bill.

### Reaching DeepSeek through a gateway

The models are the point here, not the route to them, and reaching them through an OpenAI-compatible gateway is configuration rather than a code change — the harness's `llm-pi-ai` adapter takes a hand-declared route. This interface needs nothing added for one: `/model` lists whatever the route advertises, `/reasoning` offers whatever levels it declares, and the usage counter follows along.

For [opencode](https://opencode.ai)'s Go endpoint, put your key in the environment as `OPENCODE_API_KEY` and add the route:

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencode:
        displayName: opencode
        apiKeyEnv: OPENCODE_API_KEY
        api: openai-completions
        baseURL: https://opencode.ai/zen/go/v1
        # The endpoint speaks DeepSeek's thinking dialect but its URL does not
        # say so, so the reasoning format has to be named.
        compat:
          thinkingFormat: deepseek
        models:
          - id: deepseek-v4-flash
            name: DeepSeek V4 Flash
            contextWindow: 1000000
            reasoningEfforts:
              off:
              high: high
              max: max
          - id: deepseek-v4-pro
            name: DeepSeek V4 Pro
            contextWindow: 1000000
            reasoningEfforts:
              off:
              high: high
              max: max
```

`apiKeyEnv` is a *reference*, resolved per request — the key itself never enters the file.

The one thing that does not carry over is the price. A gateway bills on its own terms, so a route it serves shows tokens and no `$` until you give it rates of its own:

```yaml
- id: tui
  config:
    pricing:
      opencode/deepseek-v4-pro:
        input: 0.66
        output: 1.98
```

### Where a turn's time went

`/profile` prints a breakdown under each reply, from the next turn on:

```
turn 14 · 42.8s
  reasoning  ███████████  18.2s
  bash       ██████████   16.4s
  edit       ██            3.1s
  output     █             2.1s
```

The bars are scaled against the **longest** row, not against the turn. These are spans, not shares: tool calls in a step run at the same time as each other, so their lengths can add up to more than the turn took, and the difference is not idle time. The wall clock in the heading is the turn; the bars only compare the rows with each other.

It is off by default, because a chart between every reply and the next prompt is noise when you are not asking the question it answers. `/profile` on its own flips it — there are only two states, so a list of two would be a ceremony — and `/profile on` or `/profile off` sets it outright.

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

# Usage

## Starting a session

| | |
| --- | --- |
| `dshtui` | Start in the current folder |
| `dshtui -C ~/code/api` | Start in a different folder |
| `dshtui "run the tests"` | Send a first message on startup |
| `dshtui --resume` | Browse, search, and reopen a past session |
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
| `ctrl-o` | Inspect the most recent truncated tool output, at any detail level; otherwise cycle how much tool output is shown: compact, full, hidden |
| `↑` `↓` | Move through your earlier messages; inside a long prompt that wraps, move up and down within it before `↑` recalls history; while a suggestion list is open, move through it instead |
| `enter` `esc` | Confirm or close a box or a suggestion list |

Editing keys: `←` `→` to move, `home` and `end` (or `ctrl-a` and `ctrl-e`) for the ends of the line, `backspace` and `delete`, and `ctrl-u`, `ctrl-k`, `ctrl-w` to delete to the start, to the end, and by word. In a prompt that wraps across rows, `↑` and `↓` also move vertically through the wrapped lines, keeping the column you aimed at across short rows.

Pasting several lines inserts all of them and sends them as a single message.

### Input history

When no suggestion list is open, `↑` steps back through the lines you sent this session — prompts and slash commands alike — and `↓` steps forward again. A half-typed line is kept for you: step back to look at an earlier message, and stepping forward past the newest one restores your unfinished line exactly as it was.

Consecutive identical submissions are remembered once, so running `run tests` three times in a row does not fill the history with three copies of it.

Reopening a session restores the history the saved log recorded: every prompt and every resolved slash command whose input was recorded. The commands this interface handles itself (`/model`, `/reasoning`, `/usage`, `/profile`, `/sessions`, `/work`, `/todos`, `/exit`, `/quit`) and mistyped commands are remembered while the session is open but are not written to the session log, so they are not restored after a resume.

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
| `/model` | Change the model. Takes a name (`/model deepseek-v4-pro`) or opens a picker you can type in |
| `/reasoning` | Change how hard the model thinks. Takes a level (`/reasoning max`) or opens a picker |
| `/connect` | Configure and authenticate the providers Harness can talk to. Takes a route name (`/connect openai`) to open filtered on it |
| `/usage` | Choose what the status line reports: `cost`, `tokens`, or `off`. Opens a picker with no argument |
| `/profile` | `on` or `off` for the per-turn time breakdown; bare flips it |
| `/work` | Open a bounded live view of active Harness jobs and subagents |
| `/sessions` | Browse, search, and reopen past sessions without leaving the window |
| `/todos` | Open a bounded read-only view of the current Harness Todo list |
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
> **`/goal <objective>` does more than record a goal.** It starts the harness's goal driver, which immediately begins working on that objective by itself, for up to 256 rounds, using tools in your folder. Use `/goal` with no text to just view the current goal, and `/goal pause` or `/goal clear` to stop one. Nothing warns you before it begins — but once it has, the status line says so for as long as it runs. See [What the session is about to do](#what-the-session-is-about-to-do).

### Connect

`/model` chooses among models that already exist. `/connect` is how a model
comes to exist.

It opens a bounded overlay listing what Harness says can be configured, in two
sections:

```
┌ Connect ─────────────────────────────────────────────────────────────────┐
│ ⌕                                                          9 rows        │
│                                                                          │
│ Provider routes                                                          │
│ ❯ ● OpenAI  openai                        active · 41 models · key from  │
│       llm-pi-ai · providers.openai · credential field apiKeyEnv          │
│   · Anthropic  anthropic                                        dormant  │
│   ● DeepSeek  deepseek-official     active · DEEPSEEK_API_KEY unset      │
│                                                                          │
│ Sign-ins                                                                 │
│   · ChatGPT (Codex)                                     not signed in    │
└──────────────────────────────────────────────────────────────────────────┘
  ↑↓ move · ctrl-r refresh · ↵ configure · esc close
```

Type to filter, `↵` to see what Harness will let you do to the selected row,
`esc` to clear the query and `esc` again to close. `/connect openai` opens on
that filter — naming a route says which one you mean, and the completion list
offers every route name after a space, the same way `/reasoning` offers levels.
It does not act on it: what to do with a route is still a choice between storing
a key, activating it, and removing it. `ctrl-r` asks Harness again,
which is what you want after editing `settings.yaml` by hand or storing a key
from the web interface in another window.

**Provider routes** are every route a mounted adapter declares configurable,
whether or not it is live. A bare-mounted `llm-pi-ai` publishes its whole
installed catalog this way, so OpenAI, Anthropic, Google, OpenRouter, and the
rest are listed before anything has been configured for them. `active` means an
adapter has registered the route and `/model` can already offer its models;
`dormant` means nothing is configured for it yet.

**Sign-ins** are the authorization flows Harness has registered — the logins
that *obtain* a credential instead of reading one from configuration. They are
listed separately rather than folded into the provider rows on purpose: Harness
publishes no correlation between a flow's credential record and a provider
route, so this interface shows both and leaves the connection to you rather
than asserting one it cannot verify.

The dot in front of a row is deliberately quiet. Green means a named credential
is confirmed present, red means a named credential is confirmed missing, and
everything else is unmarked — a route authenticating through its provider's own
discovery, or a deployment with no credential store to ask, is not
misconfigured.

#### What `↵` offers

Only what the mounted seams will actually accept, so nothing on the list
answers with a refusal:

| | |
| --- | --- |
| Connect with an API key | Stores the key through Harness's credential store and records the reference in the provider's settings profile |
| Activate this route | Writes a minimal profile so the adapter registers the route; a catalog route inherits its endpoint, protocol, and models |
| Forget the stored API key | Clears the value; the reference stays, so the route keeps naming where its key belongs |
| Remove this route from your settings | Unsets the profile *your* settings document carries, leaving any composition default in place |
| Sign in | Runs the owning plugin's own flow through Harness's authorization seam |
| Forget this sign-in | Deletes the local credential record — see the warning below |

A typed key never reaches `settings.yaml`. It goes to the credential store, and
the settings document records only the *reference* — `OPENAI_API_KEY` for a
route called `openai` — which is the same convention the web Models page uses,
so a key stored here is the one the web interface reads.

Once a route is live, `/model` sees its models with no further step: Harness
re-registers the route on the settings commit, and the browser re-reads itself.

Closing the browser withdraws a sign-in it started, including one waiting on a
browser callback with no question on screen. Nothing from a withdrawn attempt
appears afterwards; the transcript says it was withdrawn and that is the end of
it.

> [!WARNING]
> **"Forget this sign-in" is local.** It deletes the stored credential record on
> this machine. Harness has no way for a provider to declare a server-side
> revoke, so the issuer is never told and the grant remains valid until it
> expires or you revoke it with the provider.

#### What it does not do yet

Declaring a route the adapter ships nothing about — a private gateway, a
self-hosted server — still needs `settings.yaml`, because such a route has to
name an endpoint, a protocol, and its models before it can serve anything. See
[Reaching DeepSeek through a gateway](#reaching-deepseek-through-a-gateway).
Editing a live route's model list, base URL, or timeouts is settings work too;
`/connect` v1 covers credentials and activation.

### Sessions

`/sessions` opens a bounded overlay listing the sessions Harness knows about,
newest first. It is the same browser `--resume` opens before the first agent
exists, so there is one place to learn and one set of keys.

| | |
| --- | --- |
| type | Filter the list by title, workspace, or id, as you type |
| `tab` | Search what sessions *said*, through Harness's own session index |
| `↑` `↓` | Move; the list wraps at both ends |
| `home` `end` | Jump to the newest or oldest row |
| `↵` | Reopen the selected session |
| `ctrl-w` `ctrl-u` | Delete the last query word, or the whole query |
| `esc` | Clear the query; press it again on an empty query to close |
| `ctrl-d` | Leave, as everywhere else |

Typing filters the rows you can see. `tab` is a different question: it hands the
same words to `ctx.sessionQuery`'s full-text surface, which searches the contents
of every session log and shows the excerpt it matched. Editing the query drops
back to filtering, because a content result answers the words you typed *before*
the edit. A deployment whose session-query backend implements no full-text search
says so and keeps filtering — that path is supported, not broken.

The selected row carries the facts you need about one candidate: its workspace,
how many events its log holds, when it was last active, its fork or delegation
parent, and its id. Short words on the right say what makes a row unusual —
`open` for the session this window is driving, `live` for one another agent
already holds, `delegated` for a subagent's own session, and `fork` for a
session seeded from another.

Reopening retires the agent driving the current session and resumes the one you
chose, in the same window and the same terminal. Everything already in your
scrollback stays there: the reopened transcript is appended under it, exactly as
`--resume` would draw it at launch.

It refuses, and says which reason applies, when reopening would mean guessing:

| | |
| --- | --- |
| the session is already open here | nothing to do |
| the session is live in this process | resume would collide with the live id |
| there is no persisted log | reopening loads through Harness session persistence |
| a turn is running | finish or interrupt it first (`ctrl-c`) |
| jobs or subagents are attached | retiring their owner is not a lifecycle Harness defines |

If reopening fails anyway — an unreadable log, an incompatible format version, no
persistence backend — the window prints the reason and opens the browser again so
you can pick something else. `esc` there starts a new session instead. It never
ends the process, and never quietly substitutes a session you did not ask for.

### Work

`/work` opens a temporary bounded overlay. It reads generic Harness `ctx.jobs`
and `ctx.subagents` capabilities when the profile mounted them; a profile with
neither still boots and the overlay says that Work is unavailable. It never
switches screens or rewrites the transcript, so closing it returns to the same
native terminal scrollback.

Jobs and subagents stay in separate sections because dsh-tui does not guess
that two capability records describe the same operation. Jobs are currently
inspect/status only; cancellation remains available to the model through
Harness `job_kill`. A continuable subagent may offer `k stop`; a one-shot
subagent does not. Stop failures, including authorization failures, are shown
briefly in the overlay rather than being discarded.

### Todos

`/todos` opens a temporary read-only view of the current Todo projection. The
list is owned, persisted, and cleared by Harness's `dsh-tool-todo` capability;
the terminal only presents its current snapshot. `✓` is completed, `●` is in
progress, and `○` is pending. Closing the overlay leaves native scrollback
unchanged. A profile without session projections or the Todo projection remains
usable and says which reading is unavailable.

### Tool output

A tool card shows the first rows of what a tool produced, with a marker saying how many it hid. A **command** is the exception: its card keeps the *last* rows and puts the marker above them, because what you ran `pnpm test` to find out is the failure and the summary at the bottom, not the banner at the top.

`ctrl-o` opens the hidden rows. While the newest finished tool card was truncated, it opens an inspector over that card — the same presentation, scrollable, at a much larger budget than the card itself had — and closes on `esc` leaving your scrollback exactly as it was. This works whether you are on `compact` or `full`. With no such card waiting, `ctrl-o` instead cycles how much every *future* card shows: `compact`, `full`, `hidden`. Cards already printed are never redrawn, which is the trade for keeping normal terminal selection and copying.

Only the newest truncated card is reachable, and only once — a newer truncated result takes the offer over. The status line lists `ctrl-o output` while a turn is running for that reason.

### What the session is about to do

Two things change what a turn *does* rather than what it says, and both are invisible in a transcript — the command that set one prints a line and scrolls away, and everything after looks like an ordinary session. So the status line carries them:

| | |
| --- | --- |
| `plan` | Plan mode is in force. The agent will propose rather than act |
| `goal 3/256` | A goal is running by itself: three rounds taken of a cap of 256 |
| `goal 3/256 idle` | A goal is set, but this session will not continue it. `/goal resume` arms it |
| `goal paused`, `goal blocked`, `goal complete` | A goal that is not running, and why |

`idle` is what every **reopened** session shows for an active goal. Whether a process may continue a goal is deliberately not saved with the goal, so resuming a conversation does not restart a run you left — the goal is still there, and picking it up again is a thing you ask for.

Neither is given up when the terminal narrows. They are dropped only after the model name, the totals, the bar and the context reading have gone, and a running goal is the very last thing to go — after the key hints. A mode is dropped whole rather than shortened: `goal 12/25` is not a smaller truth than `goal 12/256`, it is a different one.

### Reasoning levels

`/reasoning` lists the levels the provider you are on actually accepts, rather than a fixed set — for the DeepSeek adapter that is `off`, `high`, and `max`, and a deployment configured with thinking switched off offers only `off`. There is also a `default` choice, which is not a level: it clears your selection so the provider does whatever it does when nothing is set.

The change applies from the next step, so pressing it mid-turn does not split a request across two settings, and it is remembered — see below.

The status line names the level next to the model, but only while it differs from the one your setup already defaults to — otherwise it would spend columns every frame on a fact you did not choose.

### Choosing from a long list

A gateway route advertises whatever the gateway serves. OpenRouter and opencode
offer hundreds of models, so `/model` opens a list that no terminal could show
at once — and one you should not have to scroll through.

The picker windows itself to the terminal and grows a query box once there is
more than a screenful to choose from:

```
┌ Select a model ──────────────────────────────────────────────────────────┐
│ ⌕ sonnet                                                    6 of 412     │
│ current: deepseek-official/deepseek-v4-flash                             │
│                                                                          │
│ ❯ openrouter/anthropic/claude-sonnet-4                                   │
│   openrouter/anthropic/claude-sonnet-4-thinking                          │
│   opencode/claude-sonnet-4                                               │
└──────────────────────────────────────────────────────────────────────────┘
  ↑↓ move · type to filter · enter confirm · esc clear
```

Every row is spelled the way `/model` takes it — `provider/model` — so what you
filter on is what you could have typed after the command, and the provider's own
display name sits under the selection where it disambiguates two similar models
without being the text you have to match. `esc` clears the query, `esc` again
closes the picker, and `home`/`end` jump to either end.

A short list is unchanged: an approval or `/reasoning` has nothing to filter, so
it spends no row on a search box and typed characters stay meaningless there.

### What you pick here is what the web interface opens with

`/model` and `/reasoning` both write your choice to `~/.dsh/settings.yaml`, in the same `agent-default-model` section the web Models page reads and writes. So they are two views of one setting: switch model in the terminal and the web interface opens on it, switch it there and your next terminal session starts on it.

This is worth knowing before you use `/model` to try something for one question, because it is not a session-scoped experiment — the next session starts wherever you left it. The transcript says so when it happens:

```
· model set to deepseek-official / deepseek-v4-pro · also the default for new sessions
```

The two are independent, in that order: the running session switches first and is never rolled back, so if the settings file cannot be written you are told, and the turn you are about to run still uses the model you asked for.

The whole selection is stored together — route and reasoning level — because the section holds one selection. Saving a level without its model would leave a level applying to whichever model the next session happened to open on.

### Tokens and cost

The status line carries a running total for the session:

```
● ready · deepseek-v4-flash · ↑8.8k ↓1.6k $0.018 · ▏░░░░░░░ 14k/1.0M
```

`↑` is every prompt token sent, cached or not; `↓` is every token generated, thinking included. Both come from the provider's own accounting, so they are what you were billed for rather than an estimate, and reopening a session brings its totals back with it.

`/usage` chooses how much of that to show — `cost`, `tokens` for the counts without the money, or `off`.

What the `$` means depends on the route. On a pay-as-you-go route it estimates what you spent; on OpenCode Go — which you pay for by subscription — it is the dollar-denominated usage counted against the subscription allowance, not a separate bill.

#### Which rates it uses

The routes this interface is built against — DeepSeek's own and OpenCode's (Zen and Go) — are priced out of the box, at the published rates, and each message is charged at the rate that applied **when it ran** rather than at whatever is in force now. That matters because the standard price is roughly twice the discounted one:

| | | cache hit | cache miss | output |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | off-peak | $0.007 | $0.22 | $0.66 |
| | peak | $0.014 | $0.44 | $1.32 |
| `deepseek-v4-pro` | off-peak | $0.022 | $0.66 | $1.98 |
| | peak | $0.044 | $1.32 | $3.96 |

Dollars per million tokens. Peak is 01:00–04:00 and 06:00–10:00 UTC; every other hour is off-peak, which is most of the day.

Three routes are priced this way: `deepseek-official` plus `opencode` and `opencode-go` — OpenCode Zen and OpenCode Go respectively, the two OpenCode routes the installed catalog carries — the routes this interface is built to run against. The OpenCode figures mirror DeepSeek's own list, peak schedule included, which is the accounting OpenCode applies to these models. Treat them as a starting point you can correct; a route that bills differently is one config entry.

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

For [opencode](https://opencode.ai)'s Go endpoint, put your key in the environment as `OPENCODE_API_KEY` and add the route to `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    opencode:
      displayName: opencode
      apiKeyEnv: OPENCODE_API_KEY
      api: openai-completions
      # The chat-completions path is appended by the protocol, so the route
      # stops at /v1.
      baseURL: https://opencode.ai/zen/go/v1
      # The endpoint speaks DeepSeek's thinking dialect but its URL does not say
      # so, so the format has to be named or /reasoning has nothing to send.
      compat:
        thinkingFormat: deepseek
      models:
        # Keys are the levels offered, values their wire spelling; `off` is the
        # one that may be left empty, meaning "supported, send nothing".
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

Two details are worth knowing. `apiKeyEnv` is a *reference* resolved per request, so the key itself never enters the file. And this goes in `settings.yaml` rather than in `cordis.patch.yml` — the settings document is the layer the adapter watches, so routes appear and disappear as you save it, with no restart. Prices are the other way round: they are read from the `tui` row in `cordis.patch.yml`, because this frontend has no settings section of its own.

Both models are the same ids the direct route serves, which makes `/model deepseek-v4-pro` ambiguous once both routes are mounted — a bare id resolves to whichever route was discovered first. Say `/model opencode/deepseek-v4-pro` — or `opencode-go/deepseek-v4-pro`, if that is the id the gateway registered under — when you mean a particular one; the picker labels every row with its provider either way.

Costs are reported on the OpenCode routes out of the box, at DeepSeek's rates (see [above](#which-rates-it-uses)). If a route bills differently, one entry corrects it, and it replaces the shipped numbers rather than merging into them:

```yaml
- id: tui
  config:
    pricing:
      opencode/deepseek-v4-pro:
        input: 0.66
        cachedInput: 0.022
        output: 1.98
```

Any *other* gateway is unpriced until you say otherwise: only routes this interface names carry rates, because a model reached through a reseller is billed by the reseller and inheriting somebody else's price list silently is the one failure worth ruling out.

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
dsh --profile tui --resume          # browse, search, and choose one
dsh --profile tui --resume <id>     # reopen a session directly
```

A reopened session looks exactly like the one you watched happen — reasoning, diffs, tool output and all — because the saved log is redrawn through the same code that drew it live.

You do not have to decide at launch. `/sessions` opens the same browser from
inside a running window and reopens a session in place; see
[Commands → Sessions](#sessions). One session is driven at a time, and the
transcript of each stays in your terminal's own scrollback.

## If it refuses to start

This interface needs a real terminal for both input and output. If its input or output is redirected to a file or another program, it exits with an error instead of waiting forever with nothing on screen:

```
dsh-tui: needs a terminal on stdin and stdout; for a piped or scripted run use --profile headless
```

Some wrapper scripts also cause this, because they do not pass a terminal through to the program they start. Run the harness command directly in that case, or use `--profile headless` for scripts.

# Usage

## Starting a session

| | |
| --- | --- |
| `dshline` | Start in the current folder |
| `dshline -C ~/code/api` | Start in a different folder |
| `dshline "run the tests"` | Send a first message on startup |
| `dshline --resume` | Browse, search, and reopen a past session |
| `dshline --resume <id>` | Reopen a session you know the id of |
| `dshline --help` | All flags this interface adds |
| `dshline --setup` | Create the `dshline` profile, once, before the first run |

`dshline` is a small wrapper around the harness's own launcher: it finds `dsh`, adds `--profile dshline`, and pins the session to the folder you ran it from. Everything else is passed through, so `dshline <anything>` and `dsh --profile dshline <anything>` behave the same. Use whichever you prefer.

`-C` (or `--cwd`) sets the folder the *session* works in. It does not change where the command itself runs from.

Reopening a session with `--resume` keeps the folder that session was created in, because that folder is recorded in the session file. `-C` is therefore ignored when resuming, rather than quietly moving an old conversation to a new folder.

`dshline` already opens the folder you are standing in, so no alias is needed for that.

If your harness is a source checkout rather than a global install, name the checkout once:

```sh
export DSH_HARNESS=~/path/to/deepseek-harness
```

A checkout has no `dsh` executable to point at — its launcher is a script — so this names the folder and lets `dshline` read that script from it. See [Install → Troubleshooting](install.md#dsh_bin-points-at--which-does-not-exist).

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

Reopening a session restores the history the saved log recorded: every prompt and every resolved slash command whose input was recorded. The commands this interface handles itself (`/model`, `/reasoning`, `/usage`, `/timing`, `/new`, `/sessions`, `/work`, `/todos`, `/exit`, `/quit`) and mistyped commands are remembered while the session is open but are not written to the session log, so they are not restored after a resume.

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
| `/plugins` | Browse, search, and customize the running agent's Harness preset composition |
| `/profiles` | Browse Harness profiles and the bundles each one composes; install, update, or remove one |
| `/usage` | Choose what the status line reports: `cost`, `tokens`, or `off`. Opens a picker with no argument |
| `/timing` | `on` or `off` for the persistent live turn-timing panel; bare flips it |
| `/work` | Open a bounded live view of active Harness jobs and subagents |
| `/new` | Start a fresh session in the current workspace; the previous one remains reopenable when the active Harness profile provides session persistence |
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
> **`/goal <objective>` does more than record a goal.** It starts the harness's goal driver, which immediately begins working on that objective by itself, for up to 256 rounds, using tools in your folder. Use `/goal` with no text to just view the current goal, and `/goal pause` or `/goal clear` to stop one. Nothing warns you before it begins — but once it has, the status line says so, by name, for as long as it runs.
>
> **A goal can also start without you.** The harness gives the model a `create_goal` tool and tells it that it may infer a long-running objective from what you asked, without you saying the word "goal". The status line is how you find out; `/goal` shows it in full and `/goal pause` stops it. See [What the session is about to do](#what-the-session-is-about-to-do).

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

### Plugins

`/plugins` opens a bounded overlay on the running agent's Harness preset — the
named composition of tools, prompt sections, and delegation backends the
agent was actually joined to, not a fixed list this interface keeps:

```
┌ Plugins ───────────────────────────────────────────────────────────────────┐
│ Preset: Standard mode                              default: Standard mode │
│                                                                            │
│ ⌕ codex                                                            1 row  │
│                                                                            │
│ ❯ ○   tool-subagent-codex               @deepseek-ai/dsh-tool-subagent    │
└────────────────────────────────────────────────────────────────────────────┘
  ↑↓ navigate · / search · space toggle · p presets · d default · esc close
```

Type `/` to search a large composition by row id or package name; `space` on
the selected row turns it on or off. **A built-in preset is never edited in
place.** Harness ships those files read-only, so toggling a row on one offers
to copy it to a locally authored preset first — the same "copy, then edit
the copy" path the official web interface's own preset settings use — and
applies the toggle to the new copy in the same step. `p` opens the full
roster (whatever presets the deployment actually has, not a fixed four) to
switch to a different one or set the default for new sessions; `d` sets the
one currently shown as that default outright.

**A preset switch here follows the same rule a running session already
does.** A session's composition is a fact recorded once it has produced a
turn, not a setting this interface can rewrite after the fact: picking a
preset for a session that has already started is refused, and offered
instead as the default for the *next* session — never a silent no-op, and
never a bypass of that lock. The same applies to a row you toggle: the file
is written either way, but only a session still blank *and* running that
preset picks the change up live. Anything else is reported as a customization
waiting for the next session, so a change never appears to have taken effect
on a conversation it did not touch.

Reopening a session composes it from the preset its own log recorded, not
from whatever the default is today. Sessions from before dshline adopted
presets recorded none; those resume under the shipped `standard`, which is
the preset built to mean exactly the tool set they originally ran with. If
your deployment ships no usable `standard`, such a session still opens — on
your own default — and the transcript says its tools may differ from the ones
its history was produced with.

### Profiles

`/profiles` opens Harness's own profile roster — the layer *above* presets:

```
╭─ Profiles ─────────────────────────────────────────────────────────────────╮
│ Host: dshline                                                  3 profiles  │
│ /Users/you/.dsh/profiles                                                   │
│                                                                            │
│ ⌕ / to search                                                     6 rows   │
│                                                                            │
│ ❯ ● dshline                                                       current  │
│       Bundles                                                              │
│   ✓   @deepseek-ai/dsh-base                       from the installation    │
│   ✓   @dshline/dshline                                             0.8.0   │
│   ○ web                                                                    │
╰────────────────────────────────────────────────────────────────────────────╯
  ↑↓ navigate · a add · u update · U update all · n new · / search · esc close
```

A **profile** is what a launcher boots: `dsh --profile <name>` reads
`$DSH_HOME/profiles/<name>`, whose `package.json` lists the ordered *bundles*
whose patch layers compose the Host. `●` marks the profile this session is
running. Under each profile are its bundle layers, with the installed version
where pnpm's state already records one; `from the installation` means an in-box
bundle that comes with `dsh` itself rather than being one of this profile's
dependencies.

`a` installs a bundle, `u` updates the selected one, `U` updates every
dependency-managed bundle, `r` removes one (after a confirmation, since it takes
a capability away from every later session), and `n` creates a profile. Each of
those runs Harness's own `dsh plugin --profile <name> …`, which is a thin pnpm
forwarder that reconciles the bundle list afterwards — this interface adds no
installer, resolver, or lockfile behavior of its own. `U` names the bundles
explicitly rather than running a bare `pnpm update`, which would also update
plain libraries that are not bundle layers and are not shown here.

The launcher is found the same four ways `dshline` itself finds it — `DSH_BIN`,
a `DSH_HARNESS` source checkout, `dsh` on `PATH`, then the installed
`@deepseek-ai/dsh` package — so these operations work wherever the interface
does. Where none of them finds one, the exact command is named so you can run it
yourself. If the failure output matters, its last few lines are committed to the
transcript rather than lost with the overlay; a spec that could carry a token in
a URL is withheld from that record rather than preserved in it.

**While an operation runs, the frame says so.** A pnpm install takes minutes, so
a running operation is shown as a turning spinner beside `<profile>: <what>…`
for as long as it runs, not as a message that expires — and the row disappears
the moment it finishes, because a spinner over completed work says the opposite
of the truth. Once a change to the profile you are
running has landed, `↻ restart required to pick up: <profile>` stays on screen
until you close the browser — and closing it does not stop anything: work still
running, and any restart still owed, are written to the transcript on the way
out. Other keys keep working throughout; only a second operation *on the same
profile* is refused, and it says so rather than doing nothing.

**Bundle, layer, dependency.** Three words for three different things, and the
difference is what decides whether an install does anything:

| | |
| --- | --- |
| **dependency** | anything in the profile's `package.json` — installed, nothing more implied |
| **bundle** | a package whose own manifest declares `dsh.bundle`, pointing at a `cordis.patch.yml` it exports. A property of the *package*, decided by whoever published it |
| **layer** | an entry in the profile's `dsh.profile.bundles` list. The launcher applies each listed bundle's patch, in order, to build the Host composition |

So a bundle is a package that *has* a patch to contribute, and a layer is a
patch actually being *applied*. `dsh plugin` keeps the layer list in step with
what is installed: a dependency that declares `dsh.bundle` is appended to it,
and one that stops declaring it is dropped. A dependency that never declares one
is installed and composes nothing — forever, correctly.

That is why a version matters. The same package name can be a bundle at one
version and not at another, because the declaration was added at some point; an
older copy is a plain dependency, and updating it makes it a layer.

`/profiles` lists dependencies that are not layers under `Installed, composes
nothing`, with `not a bundle` beside each, so a package that changed nothing is
visible rather than absent. One marked `⚠ declares dsh.bundle` is the case worth
acting on: the installed copy *is* a bundle and the layer list has not caught up
yet, which any `dsh plugin` run reconciles — that reconciliation is skipped
whenever pnpm exits non-zero, which is how the state arises. `r` removes a
non-layer dependency the same way it removes a bundle.

**Adding a bundle is not a search.** The field takes an exact package name (or
any spec `pnpm add` accepts) and forwards it verbatim, so a partial or
misremembered name is a failed install rather than a list of candidates. When it
fails, the reason pnpm gave is the headline — `ERR_PNPM_FETCH_404` for a name
that does not exist, `ERR_PNPM_GIT_RESOLVE_FAILED` and git's own `fatal:` line
for a repository this machine cannot reach — with the last few lines of output
committed to the transcript. Those are pnpm's errors and pnpm's fixes: a git
dependency that needs SSH here, for instance, is a `git config
url."git@github.com:".insteadOf` on your machine, not something this interface
can decide.

One of them is worth knowing about because it blocks *every* operation on a
profile until you answer it, and `/profiles` therefore warns about it before you
press anything: such a profile is tagged `builds pending`, and selecting it
names the packages and the file to answer them in. `ERR_PNPM_IGNORED_BUILDS`
means a dependency wants to run a build script and pnpm will not run it
unattended; pnpm writes a placeholder for each into that profile's
`pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@google/genai': set this to true or false
  protobufjs: set this to true or false
```

Set each to `true` or `false` and the operation proceeds. `/profiles` names that
file when it sees the error but never edits it: allowing a build script runs
arbitrary install-time code from a dependency, which is a decision for you and
not for a terminal browser. Harness does not answer it either — it writes the
base `pnpm-workspace.yaml` when a profile is created and never touches it again.
Note that `dsh plugin` on its own can *hang* here rather than fail, because pnpm
tries to ask interactively; `/profiles` gives its child no terminal to ask on, so
it reports the error instead.

**Two things it deliberately will not do.** It will not remove or update an
in-box bundle, because `dsh plugin` would not either — those come from the
installation, and turning their rows off belongs in the profile's own
`cordis.patch.yml`. And it will not switch profiles. A Host composes its
plugins once, at boot, and nothing re-links a running Host's bundle layers, so
`enter` on another profile names the command that boots it instead of
pretending to swap it in.

**Removing a bundle cannot break a shipped profile.** Only a bundle this profile
*depends on* can be removed or updated — the layers that come with `dsh` itself
are refused, which is why `web` and `headless` have nothing removable in them at
all. Deleting a whole profile is not offered: `dsh plugin` forwards pnpm
arguments and nothing in Harness removes a profile, so `enter` names the
directory and leaves that to you.

**Restart boundaries are stated, not implied.** Installing, updating, or
removing a bundle changes what the *next* Host composes. On the profile you are
running, the result says `restart required`; on any other profile, it names the
command that will pick it up. Nothing here claims to have changed the session
you are in.

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

Jobs and subagents stay in separate sections because dshline does not guess
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
| `goal armed · ship the release` | A goal is set and will continue by itself. No round has been taken yet |
| `goal 3/256 · ship the release` | Three rounds taken, of a cap of 256 |
| `goal idle · ship the release` | A goal is set, but this session will not continue it. `/goal resume` arms it |
| `goal paused`, `goal blocked`, `goal complete` | A goal that is not running, and why |

The objective is there because **a goal is not always something you set.** The harness publishes `create_goal` as a tool the model itself may call, and its own description says the model may infer that a request is long-running without being asked to create anything. So a session can acquire the authority to keep going on its own, and the status line is where that becomes visible. `/goal` shows the whole objective; `/goal pause` stops it.

`256` is the deployment's cap on automatic continuation rounds, not a target — which is why the count appears only once a round has actually been taken. `goal 0/256` reads as a meter stuck at zero; `goal armed` says the same thing truthfully.

`idle` is what every **reopened** session shows for an active goal. Whether a process may continue a goal is deliberately not saved with the goal, so resuming a conversation does not restart a run you left — the goal is still there, and picking it up again is a thing you ask for.

Neither mode is given up when the terminal narrows. They are dropped only after the model name, the totals, the bar and the context reading have gone, and a running goal is the very last thing to go — after the key hints. A mode is dropped whole rather than shortened: `goal 12/25` is not a smaller truth than `goal 12/256`, it is a different one. The objective is the one exception, and only because it is prose: a shortened objective is still an objective, so it is surrendered on its own before anything else about the goal is.

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

### While a turn is running

```
⠙ working 14m 26s · run_shell_command +2 · x-preview-f-free · ↑2.3M ↓21k · ▌░░░░░░░ 68k/1.0M · goal armed · todo 5/11 · ctrl-c interrupt
```

Beside the elapsed time is the tool the turn is waiting on. A long turn with nothing named beside it reads the same whether a command is running or the session has stopped responding, so the name is the difference between waiting and worrying. It is the first thing given up when the terminal narrows.

`+2` means two more tools are running alongside it — the harness dispatches calls that are safe to run together in parallel, so several can be outstanding at once. The name is the most recently started of them.

The time is the **turn's**, not that tool's. Nothing here claims how long any one call has been running, because the harness does not publish that.

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
- id: dshline
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

Two details are worth knowing. `apiKeyEnv` is a *reference* resolved per request, so the key itself never enters the file. And this goes in `settings.yaml` rather than in `cordis.patch.yml` — the settings document is the layer the adapter watches, so routes appear and disappear as you save it, with no restart. Prices are the other way round: they are read from the `dshline` row in `cordis.patch.yml`, because this frontend has no settings section of its own.

Both models are the same ids the direct route serves, which makes `/model deepseek-v4-pro` ambiguous once both routes are mounted — a bare id resolves to whichever route was discovered first. Say `/model opencode/deepseek-v4-pro` — or `opencode-go/deepseek-v4-pro`, if that is the id the gateway registered under — when you mean a particular one; the picker labels every row with its provider either way.

Costs are reported on the OpenCode routes out of the box, at DeepSeek's rates (see [above](#which-rates-it-uses)). If a route bills differently, one entry corrects it, and it replaces the shipped numbers rather than merging into them:

```yaml
- id: dshline
  config:
    pricing:
      opencode/deepseek-v4-pro:
        input: 0.66
        cachedInput: 0.022
        output: 1.98
```

Any *other* gateway is unpriced until you say otherwise: only routes this interface names carry rates, because a model reached through a reseller is billed by the reseller and inheriting somebody else's price list silently is the one failure worth ruling out.

### Where a turn's time went

`/timing` opens a persistent live breakdown above the status line:

```
  timing · turn 14 · 42.8s · live
  reasoning  ━━━━━━━━━━━━━━ 18.2s
  bash       ━━━━━━━━━━━━━─ 16.4s
  edit       ━━────────────  3.1s
  output     ━━────────────  2.1s
```

It stays there while the agent works and while it is idle. The turn clock and
open tool calls advance in real time; reasoning and output grow as their streamed
events arrive. When the turn ends, the same panel holds its final measurement —
nothing is added to scrollback — until the next turn replaces it. A span that
appears while you are watching eases its bar in over the next few working
heartbeats; the duration beside it is the real measurement from the first frame.
Tool-heavy turns are
capped to a small fixed height and end with an elided row that counts what is
hidden and names its longest call (`… +3 more · max 6.2s` — the longest, not
the sum, because these spans overlap); on a narrow terminal the figure is given
up whole rather than cut into a broken duration, before the
crowding-the-composer rule takes rows away entirely.

On a terminal too short to hold everything, the panel degrades before the input
line does: its span rows go first, then its header, and only on a terminal of a
handful of rows does it disappear entirely — an input line is never pushed off
screen to keep a chart visible. The composer behaves by the same rule, shedding
the blank line above its frame before it takes rows the panel was promised.

The bars are scaled against the **longest** row, not against the turn. These are
spans, not shares: tool calls in a step run at the same time as each other, so
their lengths can add up to more than the turn took, and the difference is not
idle time. The wall clock in the heading is the turn; the bars only compare the
rows with each other.

It is off by default, and while it is off it contributes no live rows at all.
`/timing` on its own flips it — there are only two states, so a list of two would
be a ceremony — and `/timing on` or `/timing off` sets it outright. Enabling it
during a live turn shows the measurement already in progress. Reopening a saved
session starts with `no turn measured yet`: historical replay deliberately omits
the streamed chunks needed for an honest breakdown, so the panel does not invent
one from incomplete data.

It was called `/profile` before, which was a name collision waiting to happen: a Harness **profile** is the composition a launcher boots, and `/profiles` browses those. This command is a stopwatch and now says so.

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

When the active profile provides Harness session persistence, conversations can
survive quitting and be reopened:

```sh
dsh --profile dshline --resume          # browse, search, and choose one
dsh --profile dshline --resume <id>     # reopen a session directly
```

A reopened session looks exactly like the one you watched happen — reasoning,
diffs, tool output and all — because its persisted log is redrawn through the
same code that drew it live. Profiles without session persistence still support
fresh conversations, but cannot offer those conversations again after they end.

You do not have to decide at launch. `/sessions` opens the same browser from
inside a running window and reopens a session in place; see
[Commands → Sessions](#sessions). One session is driven at a time, and the
transcript of each stays in your terminal's own scrollback.

## If it refuses to start

This interface needs a real terminal for both input and output. If its input or output is redirected to a file or another program, it exits with an error instead of waiting forever with nothing on screen:

```
dshline: needs a terminal on stdin and stdout; for a piped or scripted run use --profile headless
```

Some wrapper scripts also cause this, because they do not pass a terminal through to the program they start. Run the harness command directly in that case, or use `--profile headless` for scripts.

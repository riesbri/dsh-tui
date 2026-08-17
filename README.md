# dsh-tui

[![ci](https://github.com/riesbri/dsh-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/riesbri/dsh-tui/actions/workflows/ci.yml)

A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built as an in-process plugin rather than a client.

```
╭──────────────────────────────────────────────────────────────────╮
│ dsh-tui 0.1.0                                                    │
│ ~/code/my-project                                                │
│ deepseek-official / deepseek-v4-flash                            │
╰──────────────────────────────────────────────────────────────────╯

───────────────────────────────────────────────────────────────────
› Read the LICENSE file and name the license. Use the read tool.

⏺ read file_path=~/code/my-project/LICENSE
  ⎿ <path>~/code/my-project/LICENSE</path>
    <type>file</type>
    1: MIT License
    … 21 more lines

● The LICENSE file is the MIT License.

╭─ my-project ─────────────────────────────────────────────────────╮
│ › ask anything                                                   │
╰──────────────────────────────────────────────────────────────────╯
  ● ready · deepseek-v4-flash · 14k/1.0M · /model · ctrl-d quit
```

Prompts, questions, and the model picker share one framed overlay:

```
╭─ Indentation: Do you prefer tabs or spaces? ─────────────────────╮
│ ❯ Tabs                                                           │
│   Indent with tab characters.                                    │
│   Spaces                                                         │
╰──────────────────────────────────────────────────────────────────╯
  ↑↓ move · enter confirm · esc cancel
```

While a turn runs, the status line carries a spinner, elapsed time, and context pressure read from `ctx.tokenMeter` — dim until 70% of the window, then yellow, then red:

```
  ⠙ working 4s · deepseek-v4-flash · 13k/1.0M · ctrl-c interrupt
```

## Requirements

- Node `^22.19 || >=24`
- A working DeepSeek Harness installation with a model configured. If `dsh web` starts and answers a prompt, you are ready.

## Install

### 1. Get a `dsh` command

This plugin is launched by the harness's own CLI, so you need a way to run it. Either works:

```sh
npm install -g @deepseek-ai/dsh     # a global `dsh`
```

Or, from a harness source checkout, use its workspace script — `pnpm dsh` behaves as `dsh` does:

```sh
cd ~/path/to/deepseek-harness
pnpm dsh --version
```

Everything below writes `dsh`. Substitute `pnpm dsh` (run from inside the harness checkout) if that is your setup.

### 2. Install the bundle into a profile and launch

```sh
dsh plugin --profile tui add @riesbri/dsh-tui
dsh --profile tui
```

Or from a checkout, to run unreleased changes:

```sh
git clone https://github.com/riesbri/dsh-tui && cd dsh-tui
pnpm install && pnpm build
dsh plugin --profile tui add ./packages/tui
```

A DSH **profile** is a named stack of plugin bundles under `$DSH_HOME/profiles/<name>` (default `~/.dsh`). `dsh plugin add` creates the `tui` profile on first use, installs this bundle into it, and appends it to the profile's bundle list — so the profile becomes `@deepseek-ai/dsh-base` plus this frontend.

A relative bundle path is resolved against the directory the command runs in. With `pnpm dsh` that directory is the harness checkout, not this one, so pass an absolute path instead:

```sh
pnpm dsh plugin --profile tui add ~/path/to/dsh-tui/packages/tui
pnpm dsh --profile tui
```

Confirm what was composed without launching:

```sh
dsh --profile tui --dump-config      # this bundle appears as a "# == @riesbri/dsh-tui" layer
```

To remove it, which strips both the dependency and the layer:

```sh
dsh plugin --profile tui remove @riesbri/dsh-tui
```

Installing straight from a git URL is not supported: `dsh plugin add github:riesbri/dsh-tui` would install the repository root, which is a workspace rather than the bundle. Use the npm name or a path to `packages/tui`.

## Usage

| | |
| --- | --- |
| `dsh --profile tui` | Start a session in the current directory |
| `dsh --profile tui -C ~/code/api` | Start in a different workspace |
| `dsh --profile tui "run the tests"` | Submit a first task on open |
| `dsh --profile tui --help` | Flags for this frontend |

Inside a session:

| | |
| --- | --- |
| `enter` | Send |
| `alt-enter` | Newline without sending |
| `/model` | Switch model — the picker lists every route the mounted adapters advertise |
| `/compact`, `/plan`, `/goal`, `/permission`, `/feedback` | Harness commands, dispatched through `ctx.commands` |
| `ctrl-c` | Interrupt the running turn; with nothing running, quit |
| `ctrl-d` | Quit |
| `ctrl-l` | Clear the display |
| `↑` `↓` `enter` `esc` | Move, confirm, and dismiss inside an overlay |

Editing: `←` `→`, `home`/`end`, `ctrl-a`/`ctrl-e`, `backspace`/`delete`, `ctrl-u`/`ctrl-k`/`ctrl-w`.

Pasting a multi-line block inserts it whole and sends it as one message. Bracketed paste is what makes that reliable — without it a pasted newline is indistinguishable from a pressed one. `shift-enter` is not bound because terminals send a bare carriage return for it, identical to `enter`; `alt-enter` is the detectable gesture.

Sessions are written to the harness's own session store, so a transcript survives exit and is readable by the harness's session tooling — but this frontend cannot yet reopen one. See the roadmap.

The frontend needs a real terminal on stdin and stdout. Piped or redirected, it exits non-zero with a message rather than idling with no interface; use `--profile headless` for scripted runs.

## Why this one

Four terminal frontends for the harness exist. Three run inside the agent's process as Cordis bundles, one attaches to a running server, and that decides what each can reach.

| | Runs as | Renderer | Install |
| --- | --- | --- | --- |
| `@dsh-tui/dsh-tui` | in-process bundle | `@earendil-works/pi-tui` | one command, from npm |
| `@xmoon76/dsh-pi-tui` | in-process bundle | vendored `pi-tui` fork | one command, from npm |
| `dsh-tui` (unscoped) | client over `ctx.remote` | Ink + React | one command, needs `dsh web` running |
| **`@riesbri/dsh-tui`** (this) | in-process bundle | own, no dependencies | one command, from npm |

Each description is that project's own. Be clear-eyed about where this one stands: **`@dsh-tui/dsh-tui` is the most featured of the four** — streaming markdown, tool cards across all three render intents with a three-way collapse toggle, `@file` and `@session` completion, `/resume`, a todo panel, and configurable themes with truecolor detection. For the fullest terminal experience today, install that one.

This repository is worth choosing for two structural properties rather than for feature count.

**It adds no third-party packages.** The renderer declares no dependencies and no peers. The bundle depends on the renderer and peer-depends on harness packages plus `commander`, which the harness already ships, so installing it into a profile pulls in nothing new. The other three carry a renderer's dependency tree. On a pre-release harness where a third of published plugins are reported incompatible, and over SSH, that is worth something.

**It never takes the alternate screen.** Finished output goes to the terminal's own scroll buffer and only a small region at the bottom is redrawn, so scrollback, mouse selection, and copy behave exactly as in any other command rather than being reimplemented inside the interface.

**It can also answer `ask_user_question`** — that seam accepts exactly one provider per context and the web host's API proxy claims it, so only a frontend inside the process can register it. This is shared with the other two in-process bundles; the client over `ctx.remote` carries questions across a wire instead, and the harness's own ACP server deliberately carries no questions, tools, or plans at all.

Honest disadvantages: this is the newest of the four and it has the fewest features. Read the roadmap and limitations before choosing it.

## Architecture

Two packages, split so the drawing half never learns about agents:

| Package | Owns |
| --- | --- |
| [`@riesbri/dsh-tui-renderer`](packages/renderer) | Display width, key decoding, the input buffer, box drawing, and the screen. Imports nothing from the harness, so it is testable with no terminal and no model. |
| [`@riesbri/dsh-tui`](packages/tui) | The bundle: the session loop, the transcript projection, the interaction seams, and the slot registry. |

**The screen appends and redraws one region.** A chat transcript only grows, so the renderer owns no full-screen buffer. Finished output is written into the terminal's scroll buffer and never touched again; only the bottom live region — a streaming reply, a prompt, the composer — is redrawn in place. Scroll position is therefore never modelled and never reflowed on resize. The invariant that makes it correct: the live region is the last thing on screen, so every write goes through `Screen`.

**Widths follow Unicode East Asian Width.** The harness is bilingual; its shipped agent presets are named in Chinese. A CJK ideograph measured as one column corrupts every row in the buffer, not only the row holding it, so the redraw arithmetic counts *rendered* rows and a wrapped or CJK line is climbed correctly.

**Measuring and cutting agree about escape sequences.** `displayWidth` ignores them, so `wrapToWidth` and `truncateToWidth` do too: they tokenize into zero-width escapes and visible characters, never cut inside a sequence, and reopen styling on a continuation row. A styled line that measured wider than it drew would wrap early, taking every framed row with it.

**Untrusted text is escaped before it reaches the terminal.** Everything a model, a tool, or a session log produces is untrusted for terminal purposes: an escape sequence in tool output could repaint the live region, and a carriage return could reposition the cursor. Such text passes through `escapeControls` and is shown in caret notation. Styling is a separate function, applied only to strings this frontend composes itself.

**Markdown is rendered, and escaped as it is parsed.** Replies come back as headings, emphasis, inline and fenced code, lists, quotes, rules, and links — a deliberately small subset, hand-rolled in `packages/renderer/src/markdown.ts`, because a parser dependency would cost the property above.

Emphasis follows CommonMark's flanking rules, with one deliberate deviation. A delimiter followed by whitespace cannot open and one preceded by whitespace cannot close, so `2 * 3 * 4` stays arithmetic; underscores may not touch a word, so `snake_case_name` and `file_name.ts` stay intact. The deviation is that `__init__` is left literal rather than read as emphasis: in a reply about code that is a dunder far more often, and corrupting a name the reader may need to type costs more than losing emphasis. Multi-word `__bold text__` and single `_italic_` both still work.

The ordering is the security rule: every span is escaped *before* styling is applied, never after. `escapeControls` neutralises the escape character itself, so running it over already-styled output would destroy the styling, and running it over only some spans would let a control sequence through everywhere else. A model can emit one in prose, in a heading, in a link target, or inside a fence, and each is covered.

**Pasted input is untrusted too.** People paste logs, so a paste is the most likely source of terminal controls in the whole interface. Pasted content is sanitized at the point of insertion rather than at each place it is later measured or drawn: line endings normalize to `\n`, tabs expand to spaces because a tab's rendered width depends on tab stops the arithmetic cannot see, and remaining controls become caret notation. One representation in the buffer means every width, cursor, and draw calculation reads the same text the terminal receives.

**The chrome is plugins too.** The banner, composer, status line, and every overlay are independent registrations into `ctx.tuiSlots` — the terminal's equivalent of the web client's `ctx.slots`. Slots are positional (`stream`, `composer`, `status`), so a view chooses where it sits by naming one, and whichever view owns text entry reports where the cursor belongs.

```ts
ctx.tuiSlots.register('status', { render: () => ['my widget'] })
ctx.tuiSlots.pushOverlay(myPrompt)   // takes the whole region and every key
```

## Roadmap

Ordered by what most changes daily use, not by what is easiest.

**Next**

- **Session resume** — `--resume` and a session picker. Needs `foldSurface` from `dsh-session` to rebuild a transcript, since replaying events in order is wrong where compaction has replaced ranges, plus process handoff so a resumed session re-enters its own workspace.
- **Tool cards from render intent** — consult `presentCall`/`presentResult` instead of showing a name, its arguments, and a truncated preview. Diffs and search results have shapes worth drawing.

**Then**

- **Composer input** — `@` file mentions with completion, a `/` menu built from `ctx.commands.list()`, and history on the vertical arrows.
- **Streaming without a tail limit** — commit finished lines as they complete and keep only the partial line live.
- **Themes** — colours already pass through a single `style()` call, so this is a palette seam rather than a rewrite.

**Maybe**

- **Reasoning display** — the session log carries `reasoning-delta` chunks that nothing renders yet.
- **Background jobs and subagents** — the harness has `job_*` tools and a subagent registry; a live panel for either needs layout this renderer does not do.

## Limitations

- **No session resume.** Every launch starts a new session.
- **No themes.** One palette.
- **Tool cards are generic.** `presentCall`/`presentResult` render intent is not consulted. Every variant of that intent is documented to degrade to raw content, so this is the sanctioned fallback rather than a correctness gap.
- **A streaming reply shows only its last 8 lines** while it streams. The live region is redrawn by climbing rows, so it has to stay shorter than the screen; the full text is committed once the assembled message lands.
- **No `@` mentions, autocomplete, or command menu.** A typed `/name` dispatches, but nothing lists what exists.
- **Ordinary tool calls never ask for approval in a default composition.** The approval prompt works, and `@deepseek-ai/dsh-base` does reach it — when the model asks to widen the sandbox, `bash` and `pwsh` escalate through `ctx.approval` directly. What is missing is a policy that makes ordinary calls ask at all: the sandbox denies out-of-workspace operations outright rather than escalating, and the only bundled plugin returning an `ask` decision is the Claude Code hooks bridge, which base does not mount. Mount `@deepseek-ai/dsh-hooks-claude-code`, or your own `tools/pre-execute` policy, for that. Deciding which calls require approval is a deployment choice, so this bundle does not make it for you.

## Development

```sh
pnpm install
pnpm build       # tsc for the renderer; the bundle is transpiled
pnpm test        # 149 tests, no terminal and no model required
pnpm typecheck   # needs a harness checkout — see below
```

Build and test need nothing but this repository. `pnpm typecheck` is the exception: it resolves the harness's real service types, and those cannot come from the registry, because a published harness package depends on one that is not published. Its `devDependencies` therefore point at a sibling checkout:

```
parent/
├── deepseek-harness/
└── dsh-tui/
```

Clone the harness beside this repo and build it once (`pnpm install && pnpm run build` there), and `pnpm typecheck` works. Without it, install and build are unaffected and only `typecheck` fails, reporting unresolved harness modules.

For any other layout, point the links at your checkout rather than editing the manifest by hand:

```sh
node tools/link-harness.mjs ~/src/deepseek-harness
node tools/link-harness.mjs --check     # are the links resolvable?
```

It writes a relative path when the checkout is reachable from this repo, so the manifest stays portable and carries no home directory.

This is also why the bundle is transpiled rather than compiled: `pnpm build` must work for anyone who wants to install the plugin, so it uses TypeScript's transpiler by way of [`tools/build-bundle.mjs`](tools/build-bundle.mjs), which erases types per file and resolves nothing. Typechecking is a separate, contributor-only step.

CI runs the build and the full suite on Node 22 and 24. The `typecheck against the harness` job clones and builds the harness to run `tsc -b`; because that takes minutes and can fail for reasons outside this repository, it runs on `workflow_dispatch` rather than gating every push.

Rendered layout is verified against a real terminal. `packages/renderer/tests/rendered.spec.ts` feeds the renderer's output to `@xterm/headless` and asserts the rows a person actually sees — borders landing in one column for ASCII and CJK, a live region leaving no tail behind when it shrinks, styling surviving a wrapped row, and an escape sequence in tool output being shown rather than obeyed. Stripping escape sequences out of the byte stream cannot reconstruct a frame, because the redraw uses cursor positioning, which is why an emulator is the reference.

These tests are hermetic — no pseudo-terminal, no harness, no model — so `pnpm test` runs them and CI covers layout without a separate job.

Reading emulator output takes care in two places. A wide character occupies two cells and `translateToString` skips the second, so rows are measured in columns rather than by string length. And text output carries neither cursor position nor cell attributes, so anything about the cursor is asserted through `emulator.cursor()` and anything about colour through `emulator.cell()` — a frame with a misplaced cursor or a colourless continuation row reads identically as text.

## License

[MIT](LICENSE)

Not affiliated with or endorsed by DeepSeek.

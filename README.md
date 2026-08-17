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

While a turn runs the status line shows a spinner, elapsed time, and live context pressure from `ctx.tokenMeter` — quiet until 70% of the window, then yellow, then red:

```
  ⠙ working 4s · deepseek-v4-flash · 13k/1.0M · ctrl-c interrupt
```

## Install

Requires Node `^22.19 || >=24` and a DeepSeek Harness installation.

```sh
git clone https://github.com/riesbri/dsh-tui && cd dsh-tui
pnpm install && pnpm build
dsh plugin --profile tui add ./packages/tui
dsh --profile tui
```

A `github:` spec cannot be used yet: it installs a repository root, and this one is a workspace whose root is not the bundle. Publishing to npm is what turns installation into one line.

Running the harness from a source checkout? Launch its bin directly — `node --import tsx/esm apps/cli/src/bin.ts --profile tui`. Under `pnpm dsh` the script wrapper does not give the child a terminal, and the frontend refuses to start without one.

## Why this one

Three terminal frontends for the harness exist. They differ in where they run, and that decides what they can do:

| | Runs as | Renderer | Needs a server |
| --- | --- | --- | --- |
| **dsh-tui** (this) | in-process Cordis plugin | its own, zero dependencies | no |
| `@xmoon76/dsh-pi-tui` | in-process Cordis plugin | vendored `pi-tui` fork | no |
| `dsh-tui` (MashedPotato817) | standalone client over `ctx.remote` | Ink + React | yes, `dsh web` |

"Native" is not the argument by itself. Being in-process buys four concrete things:

**It owns the interaction seams.** `ctx.userQuestions` accepts exactly **one** provider per context, and the web host's API proxy claims it. Only a frontend inside the process can register it — a client has to proxy questions over a wire, and the harness's own ACP server deliberately carries no questions, tools, or plans at all. This restores the seam the harness lost when it removed its last non-browser questions provider.

**Nothing to start and nothing to serialize.** `cd project && dsh --profile tui`. No HTTP server, no port, no SSE stream, no reconnect logic, and no wire format to keep in sync with the harness.

**It installs no third-party code.** The renderer's `dependencies` and `peerDependencies` are both empty. The bundle depends on the renderer and peer-depends on harness packages plus `commander`, which the harness already ships. Adding this to a profile pulls in zero new packages — worth something on a pre-release harness where a third of published plugins are reported incompatible, and worth more over SSH.

**Your terminal keeps working.** It never takes the alternate screen. Finished output goes into your terminal's own scroll buffer and only a bottom live region is redrawn, so native scrollback, mouse selection, and copy behave normally. Full-screen TUIs take the screen and lose all three.

What it is not: the most featured of the three. It is the newest. See the limitations below before choosing it.

## What it does

Type a prompt, watch the reply stream, see tool calls with their results, answer `ask_user_question` prompts, switch models with `/model`, interrupt with `ctrl-c`, quit with `ctrl-d`. Harness slash commands (`/compact`, `/plan`, `/goal`, `/permission`, `/feedback`) dispatch through `ctx.commands`.

Editing: arrows, `home`/`end`, `ctrl-a`/`ctrl-e`, `backspace`/`delete`, `ctrl-u`/`ctrl-k`/`ctrl-w`, `ctrl-l` to clear.

Flags: `-C, --cwd <path>` picks the workspace, and a positional argument submits a first task.

## How it is put together

Two packages, split so the drawing half never learns about agents:

| Package | Owns |
| --- | --- |
| [`@riesbri/dsh-tui-renderer`](packages/renderer) | Display width, key decoding, the input buffer, box drawing, and the screen. Imports nothing from the harness. |
| [`@riesbri/dsh-tui`](packages/tui) | The bundle: the session loop, the transcript projection, the interaction seams, and the slot registry. |

### The screen is append-plus-live-region

A chat transcript only grows, so the renderer owns no full-screen buffer. Finished output is written into the terminal's scroll buffer and never touched again; only the bottom live region — a streaming reply, a prompt, the composer — is redrawn in place. Scroll position never has to be modelled or reflowed on resize. The rule that makes it correct: the live region is always the last thing on screen, so every write goes through `Screen`.

### Widths follow Unicode East Asian Width

The harness is bilingual — its shipped agent presets are named in Chinese — so a CJK ideograph measured as one column corrupts every row in the buffer, not only the row holding it. The redraw arithmetic counts *rendered* rows, so a wrapped or CJK line is climbed correctly.

### Measuring and cutting have to agree

`displayWidth` ignores escape sequences, so `wrapToWidth` and `truncateToWidth` must too. While they did not, a gray border measured seven columns wider than it drew and every framed row wrapped early — the interface looked broken for exactly that reason. They now tokenize into zero-width escapes and visible characters, never cut inside a sequence, and reopen styling on a continuation row.

### Untrusted text is escaped before it reaches the terminal

Everything a model, a tool, or a session log produces is untrusted for terminal purposes: an escape sequence in tool output would repaint the live region out from under the renderer, and a carriage return would reposition the cursor. Such text goes through `escapeControls` and is shown in caret notation. Styling is a separate function applied only to strings this frontend writes itself.

### Its own parts are plugins too

The banner, composer, status line, and every overlay are independent registrations into `ctx.tuiSlots` — the terminal's equivalent of the web client's `ctx.slots`. Slots are positional (`stream`, `composer`, `status`), so a view chooses where it sits by naming one, and the view that owns text entry reports where the cursor belongs. Adding a widget or replacing a prompt is a registration, not an edit to the runner.

```ts
ctx.tuiSlots.register('status', { render: () => ['my widget'] })
ctx.tuiSlots.pushOverlay(myPrompt)   // takes the whole region and every key
```

## Roadmap

Ordered by what most changes daily use, not by what is easiest.

**Next**

- **Session resume** — `--resume` and a session picker. Needs `foldSurface` from `dsh-session` to rebuild the transcript, since replaying events in order is wrong (compaction replaces ranges), plus process handoff so a resumed session re-enters its own workspace.
- **Markdown to ANSI** — headings, emphasis, lists, and fenced code in replies. The harness already depends on `mdast-util-from-markdown`, so this is a rendering pass over an AST rather than a parser.
- **Real tool cards** — consult `presentCall`/`presentResult` render intent instead of showing name, arguments, and a truncated preview. Diffs and search results have their own shapes worth drawing.

**Then**

- **Composer input** — `@` file mentions with completion, a `/` command menu built from `ctx.commands.list()`, and history on the vertical arrows.
- **Multi-line input** — a deliberate newline key, so a pasted block is one message instead of one message per line.
- **Streaming without a tail limit** — commit finished lines to scrollback as they complete and keep only the partial line live, removing the 8-line cap.
- **Themes** — colours already funnel through one `style()` call, so this is a palette seam rather than a rewrite.

**Maybe**

- **Reasoning display** — the log carries `reasoning-delta` chunks that nothing shows yet.
- **Background jobs and subagents** — the harness has `job_*` tools and a subagent registry; a live panel for both would need layout this renderer does not do yet.
- **A screenshot test suite in-repo** — the pseudo-terminal plus `@xterm/headless` harness that verifies layout lives outside the repo today. Moving it in makes layout regressions a CI failure.

## Known limitations and deferred work

- **No session resume.** Each launch starts a new session. Resuming needs `foldSurface` from `dsh-session` to rebuild the transcript — replaying events in order is wrong, because compaction replaces ranges — plus process handoff so the resumed session re-enters its own workspace.
- **No markdown rendering.** Replies are plain text. The harness already depends on `mdast-util-from-markdown`, so parsing is available and only an ANSI pass is missing.
- **No themes.** One palette. Colours all funnel through `style()`, so a theme seam is a small change when it is wanted.
- **Tool cards are generic.** `presentCall`/`presentResult` render intent is not consulted; calls show name and arguments, results a truncated preview. Every render-intent variant is documented to degrade to raw content, so this is the sanctioned fallback rather than a correctness gap.
- **A streaming reply shows only its last 8 lines** while streaming. The live region is redrawn by climbing rows, so it must stay shorter than the screen; the full text commits to scrollback when the assembled message lands.
- **Multi-line paste submits each line separately.** The decoder reports an embedded newline as `enter`, and the composer submits on `enter`.
- **No `@` file mentions, autocomplete, or command menu.** A typed `/name` dispatches, but nothing lists what exists.
- **The approval answerer is unreachable in the shipped composition.** It claims `approval/request` for its own agent and delegates the rest, but nothing in `dsh-base` emits that event: the sandbox denies out-of-workspace operations outright, and the only plugin returning an `ask` decision is the Claude Code hooks bridge, which base does not mount. Mount `@deepseek-ai/dsh-hooks-claude-code` or your own `tools/pre-execute` policy to reach it.

## Development

```sh
pnpm install         # devDependencies link the harness from a SIBLING checkout
pnpm build           # tsc project references; .ts source imports emit as .js
pnpm test            # 75 unit tests, no terminal and no model required
```

The bundle typechecks against the real harness service types via `link:../../../deepseek-harness/...`, so it expects the harness cloned beside this repo. Adjust those paths in `packages/tui/package.json` for a different layout.

CI runs the full test suite and builds the renderer on Node 22 and 24. It does **not** typecheck the bundle, because that needs a built harness: every harness import in a tested module is type-only, so the tests run without one, but `tsc -b` does not. The `typecheck against the harness` job does the full job — it clones and builds the harness, so it is `workflow_dispatch` only rather than a slow gate on every push.

Layout is verified against a real terminal: a pseudo-terminal runs the assembled profile and `@xterm/headless` renders the byte stream, so a frame can be asserted as the rows a person actually sees. Stripping escape sequences from the stream cannot reconstruct a frame — the redraw uses cursor positioning — which is why the emulator is the reference.

## License

[MIT](LICENSE)

Not affiliated with or endorsed by DeepSeek.

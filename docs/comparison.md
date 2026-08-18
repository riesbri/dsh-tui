# Why this one

Four terminal frontends for the harness exist. Three run inside the agent's process as Cordis bundles, one attaches to a running server, and that decides what each can reach.

| | Runs as | Renderer | Install |
| --- | --- | --- | --- |
| `@dsh-tui/dsh-tui` | in-process bundle | `@earendil-works/pi-tui` | one command, from npm |
| `@xmoon76/dsh-pi-tui` | in-process bundle | vendored `pi-tui` fork | one command, from npm |
| `dsh-tui` (unscoped) | client over `ctx.remote` | Ink + React | one command, needs `dsh web` running |
| **`@riesbri/dsh-tui`** (this) | in-process bundle | own, no dependencies | one command, from npm |

Each description is that project's own. Be clear-eyed about where this one stands: **`@dsh-tui/dsh-tui` is the most featured of the four** — streaming markdown, tool cards across all three render intents with a three-way collapse toggle, `@file` and `@session` completion, `/resume`, a todo panel, and configurable themes with truecolor detection. For the fullest terminal experience today, install that one.

This repository is worth choosing for three structural properties rather than for feature count.

## It adds no third-party packages

The renderer declares no dependencies and no peers. The bundle depends on the renderer and peer-depends on harness packages plus `commander`, which the harness already ships, so installing it into a profile pulls in nothing new. The other three carry a renderer's dependency tree.

On a pre-release harness where a third of published plugins are reported incompatible, and over SSH, that is worth something.

## It never takes the alternate screen

Finished output goes to the terminal's own scroll buffer and only a small region at the bottom is redrawn, so scrollback, mouse selection, and copy behave exactly as in any other command rather than being reimplemented inside the interface.

## It can also answer `ask_user_question`

That seam accepts exactly one provider per context and the web host's API proxy claims it, so only a frontend inside the process can register it. This is shared with the other two in-process bundles; the client over `ctx.remote` carries questions across a wire instead, and the harness's own ACP server deliberately carries no questions, tools, or plans at all.

## Honest disadvantages

This is the newest of the four and it has the fewest features. Read [Roadmap and limitations](roadmap.md) before choosing it.

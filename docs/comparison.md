# Why choose this one

Four terminal interfaces for the harness exist. Three of them run inside the agent's own process as plugins; one connects to a running server. That difference decides what each of them can do.

| | Runs as | Drawing code | Install |
| --- | --- | --- | --- |
| `@dsh-tui/dsh-tui` | plugin inside the agent | `@earendil-works/pi-tui` | one command, from npm |
| `@xmoon76/dsh-pi-tui` | plugin inside the agent | its own copy of `pi-tui` | one command, from npm |
| `dsh-tui` (no scope) | connects to a running server | Ink + React | one command, needs `dsh web` running |
| **`@riesbri/dsh-tui`** (this one) | plugin inside the agent | its own, no dependencies | one command, from npm |

Each description above is that project's own.

**`@dsh-tui/dsh-tui` has the most features of the four.** It has streaming markdown, tool cards for every presentation type with a three-way toggle, file and session suggestions, session resuming, a to-do panel, and configurable themes with true-color detection. If you want the richest terminal experience today, install that one.

This project is worth choosing for three structural reasons rather than for its feature count.

## It adds no third-party packages

The drawing package declares no dependencies at all. The plugin depends on the drawing package, and expects the harness packages plus `commander` to already be present — which they are, because the harness ships them. So installing this into a profile pulls in nothing new. The other three interfaces each bring a drawing library and everything that library depends on.

On a pre-release harness where a third of published plugins are reported as incompatible, and on a machine you reach over SSH, that is worth something.

## It never takes over the screen

Finished output goes into your terminal's own scroll history, and only a small area at the bottom is redrawn. Scrolling, selecting text with the mouse, and copying behave exactly as they do for any other command, instead of being rebuilt inside the interface.

## It can answer the agent's questions

When an agent asks the user a question, the harness allows exactly one provider to answer it per context — and the web interface's API proxy claims that role. So only an interface running inside the agent's process can offer it.

This is shared with the other two in-process plugins. The interface that connects over a network carries questions across that connection instead, and the harness's own editor-protocol server deliberately carries no questions, tools, or plans at all.

## The disadvantages

This is the newest of the four and has the fewest features. It is version 0.2.0, written by one person. Please read [Roadmap and limitations](roadmap.md) before choosing it.

<div align="center">

# dsh-tui

**A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built as a plugin that runs inside the agent instead of connecting to it over a network.**

It prints into your terminal's normal scroll history instead of taking over the screen. It adds no third-party packages. One command installs it.

[![ci](https://img.shields.io/github/actions/workflow/status/riesbri/dsh-tui/ci.yml?branch=main&color=369eff&labelColor=black&logo=github&style=flat-square&label=ci)](https://github.com/riesbri/dsh-tui/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/riesbri/dsh-tui?color=c4f042&labelColor=black&style=flat-square&label=scorecard)](https://scorecard.dev/viewer/?uri=github.com/riesbri/dsh-tui)
[![dependencies](https://img.shields.io/badge/dependencies-0-8ae8ff?labelColor=black&style=flat-square)](docs/comparison.md#it-adds-no-third-party-packages)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-ffcb47?labelColor=black&style=flat-square&logo=node.js&logoColor=white)](docs/install.md#requirements)
[![license](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

<!-- Add these two once the package is published:
[![npm](https://img.shields.io/npm/v/@riesbri/dsh-tui?color=ff6b35&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@riesbri/dsh-tui)
[![downloads](https://img.shields.io/npm/dm/@riesbri/dsh-tui?color=ff80eb&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@riesbri/dsh-tui)
-->

</div>

> [!WARNING]
> **This is alpha software, version 0.2.0.** It works, it is tested, and it is used daily by its author — but it is young. Expect rough edges, expect features to be missing, and expect small breaking changes before 1.0. Two things to know before you point it at code you care about:
>
> 1. **Tool calls are not reviewed before they run.** In a standard setup, the agent can edit files and run shell commands inside your working folder without asking you first. That is how the harness is configured by default, not a choice this interface makes. [How to change that →](docs/usage.md#permissions-and-the-sandbox)
> 2. **Three other terminal interfaces for the harness exist, and one of them has more features than this one.** [An honest comparison →](docs/comparison.md)

## Contents

- [What it looks like](#what-it-looks-like)
- [Getting started](#getting-started)
- [Keys and commands](#keys-and-commands)
- [How it works](#how-it-works)
- [Why choose this one](#why-choose-this-one)
- [Documentation](#documentation)
- [Security](#security)
- [Contributing](#contributing)

## What it looks like

```
╭──────────────────────────────────────────────────────────────────╮
│ dsh-tui 0.2.0                                                    │
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
  ● ready · deepseek-v4-flash · ↑8.8k ↓1.6k $0.018 · ▏░░░░░░░ 14k/1.0M
```

The status line carries what the session has spent — every prompt token, everything generated, and the cost — beside how full the context window is. The tokens come from the provider's own accounting, and DeepSeek's two routes are priced out of the box, each message charged at the peak or off-peak rate that applied when it ran. A route nobody has priced shows its tokens and no money rather than guessing.

When plan mode is on, or a goal is taking rounds by itself, the status line says so — those are the two states that change what a turn *does* rather than what it says, and a transcript hides both.

Questions from the agent, approval requests, and the model picker all use the same framed box. While the agent is working, the status line shows a spinner and how long it has been running, and gives up whatever the width no longer fits — the bar first, then the model name, then the totals. The context reading goes after those, and the two modes above go last of all, because what a turn will do outranks what it costs:

```
╭─ Indentation: Do you prefer tabs or spaces? ─────────────────────╮
│ ❯ Tabs                                                           │
│   Indent with tab characters.                                    │
│   Spaces                                                         │
╰──────────────────────────────────────────────────────────────────╯
  ↑↓ move · enter confirm · esc cancel

  ⠙ working 4s · deepseek-v4-flash · ↑8.8k ↓1.6k $0.018 · 13k/1.0M
```

## Getting started

You need two things: Node.js `^22.19 || >=24`, and a working DeepSeek Harness installation with a model configured. If `dsh web` starts and answers a prompt, you are ready.

```sh
dsh plugin --profile tui add @riesbri/dsh-tui
dsh --profile tui
```

The first command creates a harness *profile* named `tui` and installs this interface into it. A profile is a named set of plugins; yours is now the harness's standard set plus this one. The second command starts a session in your current folder.

<details>
<summary><b>If you do not have a <code>dsh</code> command yet, or you want to install from source</b></summary>

Install the harness command globally:

```sh
npm install -g @deepseek-ai/dsh
```

If you work from a harness source checkout instead, `pnpm dsh` does the same job. One difference: a relative path is then resolved against the harness folder, so give an absolute path:

```sh
pnpm dsh plugin --profile tui add ~/path/to/dsh-tui/packages/tui
```

To run unreleased changes from a clone of this repository:

```sh
git clone https://github.com/riesbri/dsh-tui && cd dsh-tui
pnpm install && pnpm build
dsh plugin --profile tui add ./packages/tui
```

The full procedure, how to check it worked, and how to uninstall: [`docs/install.md`](docs/install.md).

</details>

**If you are an AI agent installing this,** the install page is written to be followed step by step:

```sh
curl -s https://raw.githubusercontent.com/riesbri/dsh-tui/main/docs/install.md
```

If you are changing this repository rather than using it, start at [`AGENTS.md`](AGENTS.md).

## Keys and commands

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

Type `/` to see the commands your agent actually has, and keep typing past one to see the values it takes — `/reasoning ` offers `off`, `high`, `max`. `/model`, `/reasoning`, `/usage`, `/profile` and `/exit` are handled by this interface; each of the first three takes its value directly or opens a picker when typed alone. The model and reasoning level you choose are stored where the web interface reads them, so the two stay in step. `/compact`, `/plan`, `/goal`, `/permission` and `/feedback` come from the harness, so which ones appear depends on your setup. Every command prints its result. A name that matches nothing is reported as unknown instead of being sent to the model as a question.

```sh
dshtui                    # open the folder you are standing in
dshtui -C ~/code/api      # open a different folder
dshtui "run the tests"    # send a first message on startup
dshtui --resume           # reopen one of your recent sessions
```

Text-editing keys, the `shift-enter` caveat, how to tell it what your models cost, a warning about `/goal`, and the permission presets are all in [`docs/usage.md`](docs/usage.md).

## How it works

There are two packages. [`@riesbri/dsh-tui-renderer`](packages/renderer) does the drawing: character widths, keyboard decoding, the input line, boxes, and the screen. It knows nothing about agents. [`@riesbri/dsh-tui`](packages/tui) is the plugin: the session loop, turning session events into transcript lines, and the registry that other views can add themselves to.

- **It never switches to a separate screen.** Finished output goes into your terminal's own scroll history and is never redrawn. Only a small area at the bottom is updated in place. Scrolling, selecting text, and copying work exactly as they do for any other command.
- **A reply is printed line by line as it arrives**, so drawing cost does not grow with the length of the answer, and a long reply scrolls normally instead of being cut down to fit.
- **Markdown is styled as it streams.** An unfinished line that fits the bounded live region is drawn through the same inline formatter as the committed transcript, so `**bold**` appears bold the moment its markers arrive instead of flipping when the line completes.
- **Tool output is drawn the way each tool asks to be drawn.** A shell command becomes a framed box with its exit code. A file edit becomes a red-and-green diff. A search groups its matches under each file. Tools that say nothing about presentation still display correctly.
- **Model reasoning is shown while it happens**, dimmed, so a model that thinks for a long time looks busy rather than stuck.
- **Text from a model, a tool, or a paste is made safe before it is drawn.** A terminal treats some characters as commands, so untrusted text is converted to a visible form first, and colors are added only afterwards.
- **Character widths follow the Unicode standard for East Asian text**, because one mismeasured character shifts every following row.
- **Keyboard input is decoded in both formats terminals use**, so a shortcut cannot work in one terminal and be dead in another.
- **The banner, input line, status line, and every box are separate plugins** registered into `ctx.tuiSlots`, so you can add your own.

Each of those had an obvious alternative that turned out to be wrong. The reasons are written down in [`docs/design.md`](docs/design.md).

## Why choose this one

| | Runs as | Drawing code | Install |
| --- | --- | --- | --- |
| `@dsh-tui/dsh-tui` | plugin inside the agent | `@earendil-works/pi-tui` | one command, from npm |
| `@xmoon76/dsh-pi-tui` | plugin inside the agent | its own copy of `pi-tui` | one command, from npm |
| `dsh-tui` (no scope) | connects to a running server | Ink + React | one command, needs `dsh web` running |
| **`@riesbri/dsh-tui`** (this one) | plugin inside the agent | its own, no dependencies | one command, from npm |

**`@dsh-tui/dsh-tui` has the most features of the four.** If you want the richest terminal experience today, install that one. Choose this one for three specific reasons instead:

1. **It adds no third-party packages** to your setup, so installing it cannot pull in anything unexpected.
2. **It never takes over the screen**, so your scroll history, text selection, and copying keep working.
3. **It can answer the agent's questions.** That connection point accepts only one provider at a time, and the web interface claims it — so only an interface running inside the agent can offer it.

The full comparison, including the disadvantages: [`docs/comparison.md`](docs/comparison.md).

## Documentation

| | |
| --- | --- |
| [Install](docs/install.md) | Requirements, profiles, checking it worked, uninstalling |
| [Usage](docs/usage.md) | Keys, commands, sessions, permissions and the sandbox |
| [Design](docs/design.md) | How it is built, and the reason behind each decision |
| [Comparison](docs/comparison.md) | The four interfaces, and where this one stands |
| [Roadmap and limitations](docs/roadmap.md) | What is planned, and what it does not do |
| [Contributing](CONTRIBUTING.md) | How to report a bug or send a change |
| [`AGENTS.md`](AGENTS.md) | Working on this repository: commands, rules, conventions |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability, and how releases are protected |

## Security

Handling untrusted text is the most important part of this project. Everything on screen came from a model, a tool, a file, or a paste — and a terminal treats certain byte sequences as commands rather than as text. Without care, a reply could move your cursor, repaint lines you already read, or on some terminals insert text into your input. So everything that reaches the screen is converted to a visible, harmless form first, and colors are applied only to text that is already safe.

The repository also protects itself: dependency and license checks on every pull request, a scan of the full history for leaked secrets, static analysis with CodeQL, a check on the workflow files themselves, and an OpenSSF Scorecard rating. Two install-time rules matter most for a package like this one. Nothing published in the last 24 hours is installed, and an install fails if a package's publishing evidence becomes *weaker* than in its previous version — a common sign of a stolen maintainer account.

Releases are built and published by GitHub Actions from a tag, never from a laptop, so every published file carries a signature linking it to the exact commit it was built from. You can run the same checks locally with `pnpm run security`. To report a vulnerability privately, see [`SECURITY.md`](SECURITY.md).

## Contributing

```sh
pnpm install
pnpm build && pnpm test      # the full suite; no terminal and no model needed
```

Nothing outside this repository is required. Bug reports are especially useful right now — this is alpha software and the author cannot test every terminal. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), and read [`AGENTS.md`](AGENTS.md) before changing code.

## License

[MIT](LICENSE). Not affiliated with, or endorsed by, DeepSeek.

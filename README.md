<div align="center">

# dsh-tui

**A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — an in-process plugin, not a client.**

Appends to your scrollback instead of taking the screen. Zero dependencies. One command to install.

[![ci](https://img.shields.io/github/actions/workflow/status/riesbri/dsh-tui/ci.yml?branch=main&color=369eff&labelColor=black&logo=github&style=flat-square&label=ci)](https://github.com/riesbri/dsh-tui/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/riesbri/dsh-tui?color=c4f042&labelColor=black&style=flat-square&label=scorecard)](https://scorecard.dev/viewer/?uri=github.com/riesbri/dsh-tui)
[![dependencies](https://img.shields.io/badge/dependencies-0-8ae8ff?labelColor=black&style=flat-square)](docs/comparison.md#it-adds-no-third-party-packages)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-ffcb47?labelColor=black&style=flat-square&logo=node.js&logoColor=white)](docs/install.md#requirements)
[![license](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

<!-- Add after the first publish, once the registry has the package:
[![npm](https://img.shields.io/npm/v/@riesbri/dsh-tui?color=ff6b35&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@riesbri/dsh-tui)
[![downloads](https://img.shields.io/npm/dm/@riesbri/dsh-tui?color=ff80eb&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@riesbri/dsh-tui)
-->

</div>

> [!NOTE]
> **Pre-1.0, and honest about it.** This is the newest of four terminal frontends for the harness and has the fewest features — [how it compares](docs/comparison.md). One thing to know before pointing it at a repository you care about: in a default composition **ordinary tool calls are not gated for approval**, because nothing in `@deepseek-ai/dsh-base` asks the prompt to appear. [What to mount if you want them gated →](docs/usage.md#approval-and-the-sandbox)

## Contents

- [What it looks like](#what-it-looks-like)
- [Quickstart](#quickstart)
- [Keys and commands](#keys-and-commands)
- [How it works](#how-it-works)
- [Why this one](#why-this-one)
- [Documentation](#documentation)
- [Security](#security)
- [Contributing](#contributing)

## What it looks like

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

Prompts, questions, and the model picker share one framed overlay. While a turn runs, the status line carries a spinner, elapsed time, and context pressure read from `ctx.tokenMeter` — dim until 70% of the window, then yellow, then red:

```
╭─ Indentation: Do you prefer tabs or spaces? ─────────────────────╮
│ ❯ Tabs                                                           │
│   Indent with tab characters.                                    │
│   Spaces                                                         │
╰──────────────────────────────────────────────────────────────────╯
  ↑↓ move · enter confirm · esc cancel

  ⠙ working 4s · deepseek-v4-flash · 13k/1.0M · ctrl-c interrupt
```

## Quickstart

You need Node `^22.19 || >=24` and a working harness install with a model configured. If `dsh web` starts and answers a prompt, you are ready.

```sh
dsh plugin --profile tui add @riesbri/dsh-tui
dsh --profile tui
```

That is it — `dsh plugin add` creates the `tui` profile, installs this bundle into it, and appends it to the profile's bundle list.

<details>
<summary><b>No <code>dsh</code> command yet, or installing from a checkout</b></summary>

```sh
npm install -g @deepseek-ai/dsh          # a global `dsh`
```

From a harness source checkout, `pnpm dsh` behaves the same — but a relative bundle path then resolves against *that* directory, so pass an absolute one:

```sh
pnpm dsh plugin --profile tui add ~/path/to/dsh-tui/packages/tui
```

To run unreleased changes from a clone of this repository:

```sh
git clone https://github.com/riesbri/dsh-tui && cd dsh-tui
pnpm install && pnpm build
dsh plugin --profile tui add ./packages/tui
```

Full procedure, verification, and uninstall: [`docs/install.md`](docs/install.md).

</details>

**For LLM agents.** The install page is written to be executed rather than read:

```sh
curl -s https://raw.githubusercontent.com/riesbri/dsh-tui/main/docs/install.md
```

Working *on* this repository instead? Start at [`AGENTS.md`](AGENTS.md).

## Keys and commands

| | |
| --- | --- |
| `enter` | Send |
| `shift-enter`, `alt-enter` | Newline without sending |
| `tab` | Accept the highlighted completion |
| `ctrl-c` | Interrupt the running turn; with nothing running, quit |
| `ctrl-d` | Quit, from anywhere — a picker, a question, and an approval all take it |
| `ctrl-l` | Clear the display |
| `ctrl-o` | Cycle tool output: compact, full, hidden |
| `↑` `↓` `enter` `esc` | Move, confirm, and dismiss inside an overlay or a completion list |

Type `/` to list the commands this agent really has: `/model` and `/exit` are answered here, and `/compact`, `/plan`, `/goal`, `/permission`, `/feedback` are dispatched through `ctx.commands`. Every command reports its result into the transcript, and a name that resolves to nothing is reported as unknown rather than sent to the model as a prompt.

```sh
dsh --profile tui -C ~/code/api      # open a different workspace
dsh --profile tui "run the tests"    # submit a first task on open
dsh --profile tui --resume           # pick from the twenty most recent sessions
```

Editing keys, the `shift-enter` caveat, the `/goal` warning, and the sandbox presets: [`docs/usage.md`](docs/usage.md).

## How it works

Two packages, split so the drawing half never learns about agents — [`@riesbri/dsh-tui-renderer`](packages/renderer) owns width, key decoding, the composer, and the screen; [`@riesbri/dsh-tui`](packages/tui) owns the session loop, the transcript, and the slot registry.

- **Appends, never takes the alternate screen.** Finished output goes into the terminal's own scroll buffer and is never rewritten; only a small region at the bottom is redrawn. Scrollback, selection, and copy behave as in any other command.
- **A reply is written as it finishes, not when it ends.** Redraw cost stays flat instead of quadratic in the answer's length, and a reply longer than the window scrolls normally rather than being clipped to a tail.
- **Tool output is drawn the way the tool asked** — `presentCall`/`presentResult`, so a shell command gets a framed card with its exit status, a mutation gets a red/green diff, a search groups matches per file. No card is ever invented for a tool by name.
- **Reasoning is shown while it happens**, dimmed and italic, so a thinking model looks like it is working rather than hung.
- **Untrusted text is escaped before styling, always in that order.** Everything a model, tool, log, or paste produces is untrusted for terminal purposes.
- **Widths follow Unicode East Asian Width**, because the harness is bilingual and one mismeasured ideograph corrupts every row in the buffer.
- **Keys are decoded in both encodings** — legacy control bytes and the kitty keyboard protocol's `CSI u` reports, derived from one table so the two cannot drift.
- **The chrome is plugins too.** Banner, composer, status line, and overlays are registrations into `ctx.tuiSlots`.

Every one of those is a decision with a wrong answer that looked reasonable: [`docs/design.md`](docs/design.md).

## Why this one

| | Runs as | Renderer | Install |
| --- | --- | --- | --- |
| `@dsh-tui/dsh-tui` | in-process bundle | `@earendil-works/pi-tui` | one command, from npm |
| `@xmoon76/dsh-pi-tui` | in-process bundle | vendored `pi-tui` fork | one command, from npm |
| `dsh-tui` (unscoped) | client over `ctx.remote` | Ink + React | one command, needs `dsh web` running |
| **`@riesbri/dsh-tui`** (this) | in-process bundle | own, no dependencies | one command, from npm |

`@dsh-tui/dsh-tui` is the most featured of the four; for the fullest terminal experience today, install that one. Choose this one for three structural properties instead: it **adds no third-party packages** to your profile, it **never takes the alternate screen**, and being in-process it **can answer `ask_user_question`** — a seam that accepts exactly one provider, which the web host's API proxy otherwise claims.

Full comparison, and the honest disadvantages: [`docs/comparison.md`](docs/comparison.md).

## Documentation

| | |
| --- | --- |
| [Install](docs/install.md) | Requirements, profiles, verification, uninstall |
| [Usage](docs/usage.md) | Keys, commands, sessions, approval and the sandbox |
| [Design](docs/design.md) | How it is built, and why each part is built that way |
| [Comparison](docs/comparison.md) | The four frontends, and where this one stands |
| [Roadmap and limitations](docs/roadmap.md) | What is next, and what it does not do |
| [`AGENTS.md`](AGENTS.md) | Working on this repository: commands, invariants, conventions |
| [`SECURITY.md`](SECURITY.md) | Reporting, supply-chain gates, verifying what you installed |

## Security

Untrusted text is the interesting part of this project. Everything drawn came from a model, a tool, a file, or a paste, and a terminal treats bytes as commands — so an escape sequence in a reply could reposition the cursor or rewrite lines the reader already saw. Everything reaching the screen passes through `escapeControls` first and is shown in caret notation; styling is applied only to text already made safe.

The repository defends itself with advisory and licence gates on every pull request, a full-history secret scan, CodeQL on the `security-extended` pack, a hardening lint over the workflows, and OpenSSF Scorecard. Dependencies get two install-time brakes that matter more than any of those for a package like this: nothing published in the last 24 hours is installed, and an install fails if a package's publishing trust evidence gets *weaker* than the version before it — the signature of a stolen maintainer account.

Releases are built and published by GitHub Actions from a tag, so each tarball carries a signed attestation binding it to the commit it was built from. Run the same gates locally with `pnpm run security`. Report a vulnerability privately: [`SECURITY.md`](SECURITY.md).

## Contributing

```sh
pnpm install
pnpm build && pnpm test      # 347 tests, no terminal and no model required
```

Nothing but this repository is needed — the harness's service types resolve from the registry. Read [`AGENTS.md`](AGENTS.md) first: it carries the invariants, the emulator-based layout tests, and the one build trap that makes a source change invisible.

## License

[MIT](LICENSE). Not affiliated with or endorsed by DeepSeek.

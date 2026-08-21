<p align="center">
  <img src=".github/assets/dsh-tui-hero.svg" alt="dsh-tui: a terminal-native frontend for DeepSeek Harness. Harness plugins flow through capability contracts into native terminal UI." />
</p>

# dsh-tui

**The terminal-native frontend for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin ecosystem.**

[![npm](https://img.shields.io/npm/v/@riesbri/dsh-tui?color=ff6b35&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@riesbri/dsh-tui)
[![CI](https://img.shields.io/github/actions/workflow/status/riesbri/dsh-tui/ci.yml?branch=main&color=369eff&labelColor=black&logo=github&style=flat-square&label=ci)](https://github.com/riesbri/dsh-tui/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/riesbri/dsh-tui?color=c4f042&labelColor=black&style=flat-square&label=scorecard)](https://scorecard.dev/viewer/?uri=github.com/riesbri/dsh-tui)
[![license](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

Harness plugins expose capabilities. dsh-tui presents supported capabilities natively in the terminal. It runs inside Harness and consumes the contracts Harness already owns instead of building separate runtimes for providers, jobs, subagents, Todo state, models, commands, or persistence.

The goal is not to port every Harness plugin. When a plugin participates in a standard capability surface that dsh-tui understands, the terminal frontend can present it generically rather than adding a provider-specific implementation.

<p align="center">
  <img src=".github/assets/dsh-tui-architecture.svg" alt="Capability flow from DeepSeek Harness plugins through standard capability surfaces and dsh-tui adapters to a native terminal UI with real scrollback." />
</p>

## Install

```sh
dsh plugin --profile tui add @riesbri/dsh-tui
dsh --profile tui
```

See [Install](docs/install.md) for requirements, verification, the `dshtui` launcher, and source installs.

> [!NOTE]
> dsh-tui is pre-1.0 and moving quickly. DeepSeek Harness is also in developer preview, so compatibility changes can happen.

> [!WARNING]
> Tool permissions and sandbox policy come from the active Harness profile. In a standard setup, ordinary tool calls can run in the working folder without review. Read [Permissions and the sandbox](docs/usage.md#permissions-and-the-sandbox) before using it on code you care about.

## Why dsh-tui?

### Built for the Harness plugin ecosystem

DeepSeek Harness is built around plugins and capability seams; dsh-tui follows that architecture:

`Harness plugin → standard capability → dsh-tui adapter → native terminal UI`

A supported generic seam such as `ctx.subagents` or `ctx.jobs` can be presented without a dedicated provider runtime. The provider-neutral model is for subagent providers such as Codex or Claude Code, and Harness spawn/fork flows, to surface through the same generic `ctx.subagents` / `ctx.jobs` contracts rather than through dsh-tui-specific runtimes. The goal is capability integration, not plugin-by-plugin ports.

### Your terminal stays your terminal

Finished output enters real terminal scrollback and is never rewritten. Normal terminal scrolling, selecting, and copying continue to work; only a bounded live region is redrawn. dsh-tui does not replace the transcript with an alternate screen.

### Small, provider-neutral presentation core

Harness owns capabilities, providers, persistence, agent state, and policy semantics. dsh-tui owns terminal rendering, navigation, overlays, and presentation. Its renderer remains Harness-independent and has no runtime dependencies of its own. See [Architecture](docs/architecture.md) and [Design](docs/design.md).

## Harness capabilities

| Harness surface | dsh-tui presentation |
| --- | --- |
| `ctx.tools` | Harness-driven tool cards and results |
| `ctx.jobs` | Generic background work in `/work` |
| `ctx.subagents` | Generic delegated work in `/work` |
| `ctx.sessionProjections` (`todos`) | `/todos` and compact status |
| `ctx.commands` | Harness command discovery and execution |
| `ctx.llm` | Model discovery and `/model` |
| `ctx.userQuestions` | Native question UI |
| Approval requests | Native interaction; Harness-owned policy |
| Harness goal and plan capabilities | Terminal state over Harness-owned behavior |
| `ctx.sessionQuery` | Resume today; richer Sessions UX planned |

A standard Harness seam maps to a generic adapter; a known projection or domain can have a native presentation adapter. A novel capability may need a new adapter. dsh-tui does not aim to give every plugin bespoke UI, and it does not yet offer a stable public TUI plugin SDK.

`/work` is one example of the generic path:

```text
╭─ Work ───────────────────────────────────────────╮
│ Subagents                                        │
│ ❯ ● reviewer  checking renderer             18s  │
│                                                  │
│ Jobs                                             │
│   ● test  pnpm test                          7s  │
╰──────────────────────────────────────────────────╯
```

## Commands

Type `/` in dsh-tui to discover what is currently available. Local commands include `/work`, `/todos`, `/model`, `/reasoning`, `/usage`, `/profile`, and `/exit`.

Harness commands such as `/plan`, `/goal`, `/permission`, `/compact`, and `/feedback` appear according to the active Harness profile. See [Usage](docs/usage.md) for keys, sessions, command details, and permission guidance.

## Contributing

Contributions are welcome, especially Harness capability adapters; Goal presentation; richer Sessions UX; attachments; macOS and Windows terminal testing; resize and terminal-geometry robustness; Unicode/CJK correctness; and small UX improvements that preserve native scrollback.

```sh
pnpm install
pnpm build
pnpm test
```

Start with [CONTRIBUTING.md](CONTRIBUTING.md), then read [AGENTS.md](AGENTS.md) and the [Roadmap](ROADMAP.md).

## Project status

Other DeepSeek Harness terminal interfaces exist, and some expose more features today. dsh-tui is deliberately optimizing for Harness-native capability integration, real terminal scrollback, and a small auditable presentation core. See [Comparison](docs/comparison.md) for the trade-offs.

## Documentation

- [Install](docs/install.md)
- [Usage](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Design](docs/design.md)
- [Roadmap](ROADMAP.md)
- [Comparison](docs/comparison.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

[MIT](LICENSE). Not affiliated with or endorsed by DeepSeek.

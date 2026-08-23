<p align="center">
  <img src=".github/assets/dsh-tui-hero.svg" alt="dsh-tui: a terminal-native frontend for DeepSeek Harness. Harness plugins flow through capability contracts into native terminal UI." />
</p>

# dsh-tui

**The terminal-native frontend for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin ecosystem.**

[![npm](https://img.shields.io/npm/v/@riesbri/dsh-tui?color=ff6b35&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@riesbri/dsh-tui)
[![CI](https://img.shields.io/github/actions/workflow/status/riesbri/dsh-tui/ci.yml?branch=main&color=369eff&labelColor=black&logo=github&style=flat-square&label=ci)](https://github.com/riesbri/dsh-tui/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/riesbri/dsh-tui?color=c4f042&labelColor=black&style=flat-square&label=scorecard)](https://scorecard.dev/viewer/?uri=github.com/riesbri/dsh-tui)
[![license](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

## Install

```sh
dsh plugin --profile tui add @riesbri/dsh-tui
dsh --profile tui
```

See [Install](docs/install.md) for requirements, verification, the `dshtui` launcher, and source installs.

> [!WARNING]
> Sandbox and tool permissions are controlled by the active Harness profile; ordinary tool calls may run without per-call review. See [Permissions and the sandbox](docs/usage.md#permissions-and-the-sandbox) before using dsh-tui on important code.

## Why dsh-tui?

Harness plugins publish capabilities; dsh-tui presents supported capabilities natively in the terminal. It runs in-process and consumes Harness contracts rather than creating separate provider runtimes, state stores, or policy.

`Harness plugin → standard capability → dsh-tui presentation adapter → native terminal UI`

Harness owns capabilities, state, runtime, persistence, and policy. dsh-tui owns terminal presentation.

<p align="center">
  <img src=".github/assets/dsh-tui-architecture.svg" alt="Capability flow from DeepSeek Harness plugins through standard capability surfaces and dsh-tui adapters to a native terminal UI with real scrollback." />
</p>

### Generic capability integration

dsh-tui integrates through standard Harness capabilities instead of provider-specific code. Work consumes `ctx.jobs` and `ctx.subagents`; Sessions uses `ctx.sessionQuery`; `/connect` uses Harness's model, settings, credentials, and authorization services. New providers can therefore flow through existing interfaces without requiring a dedicated dsh-tui implementation.

It ships no provider list and no login protocol: `/connect` offers whatever the mounted adapters declare configurable and runs whatever flows Harness has registered, so the same providers are reachable from the terminal and from the official web Models page, over one settings document and one credential store.

See [Architecture](docs/architecture.md) for the capability model and current adapter boundaries.

### Native terminal by design

Finished output is committed to real terminal scrollback and never rewritten. Normal scrolling, selection, and copying keep working while dsh-tui redraws only a bounded live region. The Harness-independent renderer stays small, dependency-light, and focused on terminal correctness: widths, Unicode, escaping, keys, and safe redraws.

See [Design](docs/design.md) for the terminal invariants and [Comparison](docs/comparison.md) for the trade-offs.

## Use dsh-tui

Type `/` to discover the commands and capabilities available in the active Harness profile.

- `/sessions` — browse and resume Harness sessions
- `/work` — inspect jobs and subagents
- `/connect` — configure providers through Harness
- `/todos` — inspect projected Todo state
- `/model` — switch registered models

[Usage](docs/usage.md) covers keys, sessions, commands, and permission guidance.

## Contributing

Contributions are welcome, especially generic capability adapters, terminal robustness, cross-platform verification, Unicode/CJK correctness, sessions, attachments, and focused UX improvements. Start with [CONTRIBUTING.md](CONTRIBUTING.md), then read [AGENTS.md](AGENTS.md) and the canonical [Roadmap](ROADMAP.md).

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

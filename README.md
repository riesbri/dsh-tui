<p align="center">
  <img src=".github/assets/dshline-hero.svg" alt="dshline: a terminal-native frontend for DeepSeek Harness. Harness plugins flow through capability contracts into native terminal UI." />
</p>

# dshline

**The terminal-native frontend for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin ecosystem.**

[![npm](https://img.shields.io/npm/v/%40dshline%2Fdshline?color=ff6b35&labelColor=black&style=flat-square)](https://www.npmjs.com/package/@dshline/dshline)
[![CI](https://img.shields.io/github/actions/workflow/status/riesbri/dshline/ci.yml?branch=main&color=369eff&labelColor=black&logo=github&style=flat-square&label=ci)](https://github.com/riesbri/dshline/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/riesbri/dshline?color=c4f042&labelColor=black&style=flat-square&label=scorecard)](https://scorecard.dev/viewer/?uri=github.com/riesbri/dshline)
[![license](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)

## Install

```sh
dsh plugin --profile dshline add @dshline/dshline
dsh --profile dshline
```

See [Install](docs/install.md) for requirements, verification, the `dshline` launcher, and source installs.

> [!WARNING]
> Sandbox and tool permissions are controlled by the active Harness profile; ordinary tool calls may run without per-call review. See [Permissions and the sandbox](docs/usage.md#permissions-and-the-sandbox) before using dshline on important code.

## Why dshline?

Harness plugins publish capabilities; dshline presents supported capabilities natively in the terminal. It runs in-process and consumes Harness contracts rather than creating separate provider runtimes, state stores, or policy.

`Harness plugin → standard capability → dshline presentation adapter → native terminal UI`

Harness owns capabilities, state, runtime, persistence, and policy. dshline owns terminal presentation.

<p align="center">
  <img src=".github/assets/dshline-architecture.svg" alt="Capability flow from DeepSeek Harness plugins through standard capability surfaces and dshline adapters to a native terminal UI with real scrollback." />
</p>

### Generic capability integration

dshline integrates through standard Harness capabilities instead of provider-specific code. Work consumes `ctx.jobs` and `ctx.subagents`; Sessions uses `ctx.sessionQuery`; `/connect` uses Harness's model, settings, credentials, and authorization services; `/plugins` reads and switches the running agent's composition through `ctx.agentPresets`; `/profiles` reads the profile roster through Harness's own home-path service and forwards every change to `dsh plugin`. New providers can therefore flow through existing interfaces without requiring a dedicated dshline implementation.

It ships no provider list and no login protocol: `/connect` offers whatever the mounted adapters declare configurable and runs whatever flows Harness has registered, so the same providers are reachable from the terminal and from the official web Models page, over one settings document and one credential store.

See [Architecture](docs/architecture.md) for the capability model and current adapter boundaries.

### Native terminal by design

Finished output is committed to real terminal scrollback and never rewritten. Normal scrolling, selection, and copying keep working while dshline redraws only a bounded live region. The Harness-independent renderer stays small, dependency-light, and focused on terminal correctness: widths, Unicode, escaping, keys, and safe redraws.

See [Design](docs/design.md) for the terminal invariants and [Comparison](docs/comparison.md) for the trade-offs.

## Use dshline

Type `/` to discover the commands and capabilities available in the active Harness profile.

- `/new` — start a fresh session (the current one stays saved)
- `/sessions` — browse and resume Harness sessions
- `/work` — inspect jobs and subagents
- `/connect` — configure providers through Harness
- `/plugins` — browse, search, and customize the running agent's Harness preset composition
- `/profiles` — browse Harness profiles and the bundles each one composes; install, update, or remove one
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

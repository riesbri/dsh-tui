# Installation

> **Agents:** this page is the whole procedure. Fetch it, run it, verify with the last section.
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dsh-tui/main/docs/install.md
> ```

## Requirements

- Node `^22.19 || >=24`
- A working [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation with a model configured. If `dsh web` starts and answers a prompt, you are ready.
- A real terminal on stdin and stdout. Piped or redirected, this frontend exits non-zero with a message rather than idling with no interface; use `--profile headless` for scripted runs.

## 1. Get a `dsh` command

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

## 2. Install the bundle into a profile

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

Installing straight from a git URL is not supported: `dsh plugin add github:riesbri/dsh-tui` would install the repository root, which is a workspace rather than the bundle. Use the npm name or a path to `packages/tui`.

## 3. Verify

```sh
dsh --profile tui --dump-config      # this bundle appears as a "# == @riesbri/dsh-tui" layer
dsh --profile tui --help             # the flags this frontend adds
dsh --profile tui                    # a banner, a composer, and a "ready" status line
```

Inside the session, type `/` — the menu lists this profile's real commands — and press `ctrl-d` to leave.

## Uninstall

Strips both the dependency and the layer:

```sh
dsh plugin --profile tui remove @riesbri/dsh-tui
```

The profile itself, its patch layer, and the harness's session store are left alone. To remove the profile as well, delete `$DSH_HOME/profiles/tui`.

## Installing from a checkout you are editing

`dsh plugin add <path>` links the bundle, and the link resolves through `exports` to the built `lib/` — not to `src/`. So after any source change:

```sh
pnpm build     # in the dsh-tui checkout
```

Relaunch after building, or you are testing the previous bytes. See [`AGENTS.md`](../AGENTS.md#the-build-gotcha).

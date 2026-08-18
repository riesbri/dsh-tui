# Installation

> **If you are an AI agent:** this page is the complete procedure. Follow it in order, then use the last section to confirm it worked.
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dsh-tui/main/docs/install.md
> ```

## Requirements

- **Node.js** `^22.19 || >=24`.
- **A working [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation** with a model configured. If `dsh web` starts and answers a prompt, you are ready.
- **A real terminal.** This interface needs a terminal for both input and output. If either is redirected, it exits with an error instead of waiting with nothing on screen. For scripts, use `--profile headless` instead.

## 1. Make sure you have a `dsh` command

This plugin is started by the harness's own command-line program, so you need a way to run it. Either option works.

Install the harness globally:

```sh
npm install -g @deepseek-ai/dsh
```

Or, if you work from a harness source checkout, use its workspace script — `pnpm dsh` behaves the same as `dsh`:

```sh
cd ~/path/to/deepseek-harness
pnpm dsh --version
```

The rest of this page writes `dsh`. If you use the second option, write `pnpm dsh` instead, and run it from inside the harness folder.

## 2. Install the plugin into a profile

```sh
dsh plugin --profile tui add @riesbri/dsh-tui
dsh --profile tui
```

A **profile** is a named set of plugins, stored in `$DSH_HOME/profiles/<name>` (by default `~/.dsh`). The first command creates the `tui` profile if it does not exist, installs this plugin into it, and adds it to the profile's plugin list. Your profile is now the harness's standard set plus this interface.

### Installing from a source checkout

To run changes that are not released yet:

```sh
git clone https://github.com/riesbri/dsh-tui && cd dsh-tui
pnpm install && pnpm build
dsh plugin --profile tui add ./packages/tui
```

A relative path is resolved against the folder the command runs in. With `pnpm dsh` that folder is the harness checkout, not this one, so give an absolute path:

```sh
pnpm dsh plugin --profile tui add ~/path/to/dsh-tui/packages/tui
pnpm dsh --profile tui
```

Installing directly from a Git URL is not supported. `dsh plugin add github:riesbri/dsh-tui` would install the repository root, which is a workspace containing two packages rather than the plugin itself. Use the npm package name, or a path to `packages/tui`.

## 3. Confirm it worked

```sh
dsh --profile tui --dump-config      # look for a "# == @riesbri/dsh-tui" section
dsh --profile tui --help             # the flags this interface adds
dsh --profile tui                    # a banner, an input line, and a "ready" status line
```

Inside the session, type `/` to list the commands your profile provides, then press `ctrl-d` to leave.

If a keyboard shortcut does nothing, run `node tools/keyprobe.mjs` from a checkout of this repository. It shows what your terminal sends and how this project reads it, which is what a bug report needs.

## Troubleshooting

### `Command "dsh" not found`

```
$ pnpm dsh --profile tui
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "dsh" not found
```

`pnpm dsh` is a script belonging to the **harness** repository, so it only exists when you run it from inside a harness checkout. Run it from anywhere else — including a clone of this repository — and pnpm reports that there is no such command. Three ways to fix it:

```sh
# 1. Install the harness command globally, then it works from any folder.
npm install -g @deepseek-ai/dsh
dsh --profile tui

# 2. Run it from the harness folder, and point the session elsewhere with -C.
cd ~/path/to/deepseek-harness
pnpm dsh --profile tui -C ~/code/my-project

# 3. Wrap option 2 in a shell function, so you can start it from any folder.
dsh-tui() { (cd ~/path/to/deepseek-harness && pnpm dsh --profile tui -C "${1:-$PWD}"); }
```

With the function in your shell profile, `dsh-tui` opens the folder you are standing in, and `dsh-tui ~/code/api` opens another one.

### It exits immediately with a message about needing a terminal

That is the frontend refusing to start without a real terminal, which happens when its input or output is redirected. Run the launcher directly rather than through a wrapper that does not pass a terminal through, or use `--profile headless` for scripted runs.

### A keyboard shortcut does nothing

Run `node tools/keyprobe.mjs` from a checkout of this repository and press the key. It prints the bytes your terminal sends and the key this project decodes them into; an empty result is a bug worth reporting.

## Uninstalling

This removes both the package and the profile's reference to it:

```sh
dsh plugin --profile tui remove @riesbri/dsh-tui
```

Your profile, its settings, and the harness's saved sessions are left alone. To remove the profile as well, delete `$DSH_HOME/profiles/tui`.

## If you installed from a checkout you are editing

The plugin is linked, and that link resolves to the compiled `lib/` folder — not to `src/`. So after every change to source:

```sh
pnpm build     # in the dsh-tui checkout
```

Then start the interface again. If you skip this step, you are testing the previous version. See [`AGENTS.md`](../AGENTS.md#one-trap-build-before-you-test-by-hand).

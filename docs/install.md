# Installation

> **If you are an AI agent:** this page is the complete procedure. Follow it in order, then use the last section to confirm it worked.
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dsh-tui/main/docs/install.md
> ```

## Requirements

- **Node.js** `^22.19 || >=24`.
- **A working [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation** with a model configured. If `dsh web` starts and answers a prompt, you are ready.
- **A real terminal.** This interface needs a terminal for both input and output. If either is redirected, it exits with an error instead of waiting with nothing on screen. For scripts, use `--profile headless` instead.

## The short version

```sh
npm install -g @deepseek-ai/dsh @riesbri/dsh-tui   # the harness, and this interface
dshtui --setup                                     # once, to create the profile
dshtui                                             # from any folder, on any machine
```

The rest of this page explains each step, and what to do when one of them does not apply to you.

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

## 3. Get a one-word command

Installing this package globally puts a `dshtui` command on your PATH:

```sh
npm install -g @riesbri/dsh-tui
dshtui --setup     # the same as: dsh plugin --profile tui add @riesbri/dsh-tui
dshtui             # the same as: dsh --profile tui --cwd "$PWD"
```

It is a small wrapper around the harness's launcher, and nothing more: it finds `dsh`, adds `--profile tui` unless you asked for another profile, pins the session to the folder you ran it from, and passes everything else through. So `dshtui --resume`, `dshtui "run the tests"` and `dshtui --help` all reach the real launcher.

Two things it needs to find:

- **The launcher.** It looks at `$DSH_BIN` first, then for `dsh` on your PATH, then for the `@deepseek-ai/dsh` package next to its own — which is why installing both globally in one command is enough. If your harness is a source checkout with no global command, set the variable once in your shell profile:

  ```sh
  export DSH_BIN=~/path/to/deepseek-harness/node_modules/.bin/dsh
  ```

- **The profile.** `dshtui --setup` creates it. Run `dshtui` before that and it says so rather than failing obscurely. To install from a checkout instead of the registry, give `--setup` the path: `dshtui --setup ./packages/tui`.

`dshtui` claims only that one command name. The unscoped `dsh-tui` package on npm is a different interface, so this package deliberately does not install a `dsh-tui` command that would shadow it.

## 4. Confirm it worked

```sh
dshtui --dump-config      # look for a "# == @riesbri/dsh-tui" section
dshtui --help             # the flags this interface adds
dshtui                    # a banner, an input line, and a "ready" status line
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
# 1. Install both globally and use the one-word command from anywhere.
npm install -g @deepseek-ai/dsh @riesbri/dsh-tui
dshtui --setup
dshtui

# 2. Keep your source checkout, and tell dshtui where its launcher is.
export DSH_BIN=~/path/to/deepseek-harness/node_modules/.bin/dsh
dshtui

# 3. Run it from the harness folder, pointing the session elsewhere with -C.
cd ~/path/to/deepseek-harness
pnpm dsh --profile tui -C ~/code/my-project
```

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

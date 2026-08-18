# Usage

## Launching

| | |
| --- | --- |
| `dsh --profile tui` | Start a session in the current directory |
| `dsh --profile tui -C ~/code/api` | Start in a different workspace |
| `dsh --profile tui "run the tests"` | Submit a first task on open |
| `dsh --profile tui --resume` | Pick from the twenty most recent sessions |
| `dsh --profile tui --resume <id>` | Reopen a known session |
| `dsh --profile tui --help` | Flags for this frontend |

`-C/--cwd` sets the workspace for the session, not the directory the launcher runs from. A resumed session keeps the workspace it was created in — the persisted header is the authority, so `-C` is ignored with `--resume` rather than silently re-rooting the conversation.

Opening the current directory every time is worth an alias:

```sh
alias dsh-tui='dsh --profile tui -C "$PWD"'
```

## Keys

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

Editing: `←` `→`, `home`/`end`, `ctrl-a`/`ctrl-e`, `backspace`/`delete`, `ctrl-u`/`ctrl-k`/`ctrl-w`.

Pasting a multi-line block inserts it whole and sends it as one message.

### shift-enter, and what asking for it costs

In its default mode a terminal sends a bare carriage return for `shift-enter`, identical to `enter`, so on launch this asks for the kitty keyboard protocol's lowest flag — `disambiguate escape codes` — under which a *modified* enter arrives as its own sequence. Terminals that implement it (kitty, Ghostty, WezTerm, foot, recent iTerm2 and Alacritty, Konsole) then distinguish the two.

On those terminals the same flag also stops `esc`, `alt`, and `ctrl` combinations arriving as their legacy bytes: `ctrl-c` becomes `CSI 99 ; 5 u`. Both encodings are decoded, so every gesture in the table above works either way — see [Design → Keys are decoded in both encodings](design.md#keys-are-decoded-in-both-encodings).

Anywhere the request is ignored, `shift-enter` still sends, which is why `alt-enter` is the gesture the status line names: it works everywhere. The mode is popped on exit, so the next program reads its input as it expects to.

## Commands

Type `/` to list what this agent really has. Two registries feed that menu.

**Answered by this frontend:**

| | |
| --- | --- |
| `/model` | Switch model — the picker lists every route the mounted adapters advertise |
| `/exit`, `/quit` | Leave, as `ctrl-d` does |

**Dispatched through `ctx.commands`**, so the list depends on what the profile mounts. With `@deepseek-ai/dsh-base`:

| | |
| --- | --- |
| `/compact` | Compact older conversation history |
| `/plan`, `/plan off` | Enter or leave plan mode |
| `/goal` | Set or view the goal for a long-running task |
| `/permission` | Switch the permission preset (sandbox mode + approval policy) |
| `/feedback` | Record feedback about this session |

Every command reports its result into the transcript — a `·` note, or `✗` on failure. A command that names nothing registered is reported as unknown rather than sent to the model:

```
✗ unknown command: /help · type / to see what there is
```

The rule for what counts is the registry's own parser, so the name has to end the line or be followed by a space. `/etc/hosts is missing` is prose and reaches the model unchanged; `/tmp is full` is claimed and reported as unknown, which is the trade.

> [!WARNING]
> **`/goal <objective>` is not a note to self.** It arms the harness's goal-round driver, which immediately begins an autonomous multi-round agent run against your workspace — up to 256 rounds. `/goal` with no argument is the read-only form. Use `/goal pause` or `/goal clear` to stop one.

## Approval and the sandbox

Read this before pointing a session at a repository you care about.

`@deepseek-ai/dsh-base` reaches the approval seam only when the model asks to widen the sandbox: `bash` and `pwsh` escalate through `ctx.approval` directly. What is missing is a policy that makes *ordinary* tool calls ask at all — the sandbox denies out-of-workspace operations outright rather than escalating, and the only bundled plugin returning an `ask` decision is the Claude Code hooks bridge, which base does not mount.

So in a default composition, an `approval/policy: ask` setting does not gate ordinary calls: the prompt is implemented and reachable, but nothing asks it to appear. A tool call inside the workspace runs. Mount `@deepseek-ai/dsh-hooks-claude-code`, or your own `tools/pre-execute` policy, if you want ordinary calls gated. Deciding which calls require approval is a deployment choice, so this bundle does not make it for you.

`/permission` reports and switches the preset:

```
· current preset workspace-write (available: read-only, workspace-write, danger-full-access)
```

`read-only` is the preset to use when you are only asking questions.

## Sessions

Sessions are written to the harness's own session store, so a transcript survives exit:

```sh
dsh --profile tui --resume          # pick from the twenty most recent
dsh --profile tui --resume <id>     # reopen a known session
```

A reopened session reads exactly like the one you watched happen — reasoning, diff cards, tool output and all — because the replay goes through the same projection as the live view.

## When it refuses to start

The frontend needs a real terminal on stdin and stdout. Piped or redirected, it exits non-zero with a message rather than idling with no interface:

```
dsh-tui: needs a terminal on stdin and stdout; for a piped or scripted run use --profile headless
```

A wrapper script that does not hand its child a terminal produces the same message — including some `pnpm` invocations. Run the launcher directly in that case.

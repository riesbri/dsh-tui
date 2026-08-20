# AGENTS.md

Instructions for an agent — or a person — working **on** this repository. If you want to *use* the interface, start at [`README.md`](README.md). If you want to send a change, read [`CONTRIBUTING.md`](CONTRIBUTING.md) as well.

Read [`docs/design.md`](docs/design.md) before changing anything about drawing, keyboard decoding, or text escaping. This file is the short version: the rules, the commands, and the mistakes that are easy to make.

## What this project is

A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It runs as a plugin inside the agent's own process, rather than as a client connecting over a network. There are two packages:

```
packages/renderer       @riesbri/dsh-tui-renderer   widths, keys, input line, boxes, screen — knows nothing about agents
packages/tui            @riesbri/dsh-tui            the plugin: session loop, transcript, harness integration, view registry
packages/tui/bin        dshtui                      a launcher wrapper, and deliberately nothing more
```

`bin/dshtui.mjs` exists so that using this does not require remembering two things (`dsh`, `--profile tui`). It finds the harness launcher, adds the profile and the working folder, and hands over the terminal with `stdio: 'inherit'`. It must never grow session logic: one implementation of the frontend is the point, and a wrapper that started doing its own work would be a second one.

That split is not just tidiness. **The renderer must never import from the harness, and must never gain a dependency or a peer dependency.** Having no dependencies is what lets this plugin add nothing to a user's setup, and it is why every rule below about widths, cutting, and escaping can be tested without a terminal and without a model.

## Commands

```sh
pnpm install
pnpm build       # tsc -b for both packages
pnpm test        # the full suite, no terminal and no model required
pnpm typecheck   # tsc -b, same project graph
pnpm security    # the dependency and workflow checks CI runs
```

Nothing outside this repository is needed. The harness's real service types come from the registry's `next` release tag, so a fresh clone type-checks with no second checkout.

## One trap: build before you test by hand

`packages/tui` imports the renderer **by package name**. That name resolves through `exports` to the compiled `lib/` folder, not to `src/`.

- **Tests are fine.** A vitest alias points the package name at `src`, so tests run the code you just wrote.
- **A harness profile that installed this plugin from a path is not.** It loads `lib/`. After any change to source, run `pnpm build` before starting the interface again, or you are testing the previous version.

This has already caused one silent failure: before the alias existed, a renderer change was invisible to the plugin's tests, so a test could pass against code that no longer existed.

## Rules that are easy to break

Breaking one of these usually produces a failure somewhere unrelated, which is why they are listed rather than left to be rediscovered.

1. **Make text safe before adding color, never after.** `escapeControls` neutralizes the escape character itself. Run it over already-colored text and it destroys the color; run it over only some parts and control sequences get through everywhere else. Text from a model, a tool, a log, or a paste is all untrusted.
2. **Apply color to one row at a time, after adding the gutter mark.** `style()` puts its reset code at the end of whatever it wraps. Color a multi-line string in one call and every row except the last is left with color still switched on, which then leaks into whatever is drawn next to it.
3. **Every write to the terminal goes through `Screen`.** The live area must stay the last thing on screen. That assumption is what makes this style of renderer correct.
4. **`displayWidth` and every cut must agree.** Measure in display columns — never in string length or UTF-16 code units. A Chinese, Japanese, or Korean character is two columns wide, a character outside the basic plane is one, and an escape sequence is zero.
5. **A shortcut reachable with `ctrl` needs both keyboard formats.** The renderer asks for the kitty keyboard protocol, and a terminal that supports it sends `ctrl-c` as `CSI 99 ; 5 u` instead of the byte `0x03`. `CTRL_KEYS` is derived from `CONTROL_KEYS`, so adding an entry to the legacy table is enough. Do not write a second table by hand.
6. **A key that quits must quit from everywhere.** `ctrl-d` is handled before any box gets the keystroke, and the session picker — which runs before the agent exists and reads the keyboard itself — handles it separately.
7. **A command that ran must say so, and must still say so after a resume.** Commands produce no model reply, so their own output is the only evidence they did anything. Project the harness's `command/run` and `command/done` events instead of printing when the line is submitted — printing directly loses every command result when the session is reopened. A failure always prints, and a success with no text is acknowledged by name.
8. **The renderer stays free of dependencies.** See above.
9. **The status line gives things up in a fixed order, and never cuts one in half.** Three nested preferences, outermost strongest: the modes (`plan`, `goal`) are surrendered last, then the hint reservation, then the body (bar, model, totals). The reservation is spent *inside* each mode level, not across all of them — flatten those loops and reserving room for `alt-enter newline` will silently hide a running goal. `goal 12/25` is not a smaller truth than `goal 12/256`; whole segments are dropped, never shortened. There are tests named for each of those.
10. **An optional plugin's types belong in `devDependencies`, never `peerDependencies`.** `dsh-agent-default-model`, `dsh-plan-mode` and `dsh-goal` are read through `ctx.get(...)` and type-only imports: the runner needs their Context and `SessionEventMap` merges to compile, but none of them has to be mounted for the frontend to run. A peer entry would print unmet-peer warnings for every profile that omits them.

## Testing

Layout is checked against a real terminal emulator, not by removing escape sequences from the output. The screen is updated by moving the cursor, so the finished picture cannot be reconstructed from the text alone.

`packages/renderer/tests/rendered.spec.ts` and `packages/tui/tests/streaming-frames.spec.ts` feed the output into `@xterm/headless`, then check the rows a person would actually see:

- Box borders line up in one column, for both Latin and East Asian text.
- The live area leaves nothing behind when it shrinks.
- Color survives a wrapped row.
- An escape sequence in tool output is displayed, not obeyed.
- A streamed reply reaches the scroll history exactly once, however the provider splits it.
- A tool card's two boxes line up with each other.

These tests are self-contained — no pseudo-terminal, no harness, no model — so `pnpm test` runs them and CI covers layout without a separate job. `tests/emulator.ts` is shared by both packages: `screen()` reads the visible area and `scrollback()` reads everything the terminal holds, which is where a transcript longer than the window ends up.

Two things to watch when reading emulator output:

- A wide character fills two cells, and `translateToString` skips the second one. Measure rows in **columns**, not in string length.
- Text output carries neither the cursor position nor the color of each cell. Check the cursor with `emulator.cursor()` and color with `emulator.cell()`. As plain text, a frame with a misplaced cursor reads exactly like a correct one.

**Assert what a person sees.** A column number can look plausible while pointing at the wrong character. The cell cannot.

**Break your fix on purpose to check the test.** For each behavior a change claims, apply a deliberate mistake and confirm a test fails by name. A test that also passes against the broken version is documentation, not a test.

## Checking behavior that tests cannot reach

Unit tests cannot cover the session loop: it needs a plugin context, an agent, and a terminal. So anything about keys, quitting, boxes, or command dispatch is checked by running the real, assembled profile inside a **pseudo-terminal** and reading what the screen did. The scripts for that are specific to one machine and are not part of this repository.

Two rules, both learned the hard way:

- **Point the session at a scratch folder, never at code you care about.** Use `-C /tmp/somewhere`. In a standard setup, tool calls are not reviewed before they run (see [`docs/usage.md`](docs/usage.md#permissions-and-the-sandbox)), so a test prompt can and will run shell commands in whatever folder you opened.
- **Never test with `/goal <objective>`.** That does not just record a goal: it starts an automatic, multi-round agent run.

When the screen shows nothing and you cannot tell why, read the session log. `$DSH_HOME/sessions/<workspace>/<id>/session.jsonl.zstd` records every `tool/call`, `command/run`, and `command/done`. That is how "the command did nothing" was told apart from "the command failed and nobody printed the reason".

## Working against unreleased harness changes

This is the one situation that needs a second checkout. Point the type dependencies at it instead of editing the manifest by hand:

```sh
node tools/link-harness.mjs ~/src/deepseek-harness
node tools/link-harness.mjs --check     # are the links valid, and is it built?
node tools/link-harness.mjs --restore   # back to the registry
```

It writes a relative path when the checkout is reachable from this repository, so the manifest stays portable and contains no personal folder names. `--check` looks for the type declaration files rather than just the folders, because an unbuilt harness has every manifest and no types.

## Style

Match the code around you; it is consistent on purpose.

- **Comments explain why, not what.** A comment earns its place by naming the alternative that looked reasonable but is wrong, or the failure that made the current shape necessary. No comment should restate the line below it.
- **TSDoc on every exported symbol**, with `@param` and `@returns`.
- **Named constants instead of unexplained numbers**, each with a comment saying what the value trades off.
- **No new dependencies** in either package, including development ones, without a reason that survives review.

## Commits and pull requests

Commit messages here are long and explanatory, and that convention is worth keeping.

- A conventional-commit subject: `fix(renderer): …`, `feat(tui): …`.
- A body that says what a user saw, why the obvious fix is wrong, and what you verified. Name the deliberate mistake you tested with, or the pseudo-terminal check you ran.
- Credit review findings when a reviewer found the problem.
- If an AI agent co-authored the change, end with its `Co-Authored-By` line.

Every check must pass before a merge: build, type-check, and the full test suite on Node 22 and 24, plus dependency advisories, a secret scan, CodeQL, the workflow check, and Scorecard.

## Releases

The version number lives in three places: both package manifests and the `VERSION` constant in `packages/tui/src/index.ts`, which the startup banner prints. The release check verifies all three. A release that updates the manifests but not the constant would publish a correctly tagged package that tells the user it is an older version.

Releases are built and published by GitHub Actions from a tag, never from a laptop, so each published file carries a signature linking it to the commit it was built from. See [`SECURITY.md`](SECURITY.md).

### Preparing a release

Every user-visible package change needs a committed changeset. Run `pnpm changeset`,
choose the change level, and write the short entry that belongs in the generated
changelog. The two published packages are fixed together, so one changeset versions
both. Do not edit package versions or `CHANGELOG.md` by hand: after a changeset
reaches `main`, the **version** workflow maintains one `Version Packages` pull
request that consumes it.

Merging that bot-authored PR creates the matching `v<version>` tag from its merge
commit. Its tag step needs the repository secret `RELEASE_TOKEN`: a fine-grained
personal access token limited to **Contents: write**. GitHub deliberately suppresses
workflows triggered by `GITHUB_TOKEN`, so the normal job token would create a tag
that never starts the tag-only publish workflow. The tag starts `publish.yml`; after
npm publishing and registry verification succeed, its separate write-scoped job
creates the generated-notes GitHub Release. Configure the token before merging the
first version PR, and retry the workflow rather than creating the tag by hand if
that step fails.

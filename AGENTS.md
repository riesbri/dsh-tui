# AGENTS.md

Instructions for an agent — or a person — working **on** this repository. If you want to *use* the interface, start at [`README.md`](README.md). If you want to send a change, read [`CONTRIBUTING.md`](CONTRIBUTING.md) as well.

Read [`docs/design.md`](docs/design.md) before changing anything about drawing, keyboard decoding, or text escaping. This file is the short version: the rules, the commands, and the mistakes that are easy to make.

## What this project is

A terminal interface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It runs as a plugin inside the agent's own process, rather than as a client connecting over a network. There are two packages:

```
packages/renderer      dshline-renderer   widths, keys, input line, boxes, screen — knows nothing about agents
packages/dshline       dshline            the plugin: session loop, transcript, harness integration, view registry
packages/dshline/bin   dshline            a launcher wrapper, and deliberately nothing more
```

`bin/dshline.mjs` exists so that using this does not require remembering two things (`dsh`, `--profile dshline`). It finds the harness launcher, adds the profile and the working folder, and hands over the terminal with `stdio: 'inherit'`. It must never grow session logic: one implementation of the frontend is the point, and a wrapper that started doing its own work would be a second one.

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

`packages/dshline` imports the renderer **by package name**. That name resolves through `exports` to the compiled `lib/` folder, not to `src/`.

- **Tests are fine.** A vitest alias points the package name at `src`, so tests run the code you just wrote.
- **A harness profile that installed this plugin from a path is not.** It loads `lib/`. After any change to source, run `pnpm build` before starting the interface again, or you are testing the previous version.

This has already caused one silent failure: before the alias existed, a renderer change was invisible to the plugin's tests, so a test could pass against code that no longer existed.

## Rules that are easy to break

Breaking one of these usually produces a failure somewhere unrelated, which is why they are listed rather than left to be rediscovered.

1. **Make text safe before adding color, never after.** `escapeControls` neutralizes the escape character itself. Run it over already-colored text and it destroys the color; run it over only some parts and control sequences get through everywhere else. Text from a model, a tool, a log, or a paste is all untrusted.
2. **Apply color to one row at a time, after adding the gutter mark.** `style()` puts its reset code at the end of whatever it wraps. Color a multi-line string in one call and every row except the last is left with color still switched on, which then leaks into whatever is drawn next to it.
3. **Every write to the terminal goes through `Screen`.** Finished rows are committed to real scrollback and never rewritten; the bounded live area must stay last. That is the terminal model, not an implementation detail.
4. **`displayWidth` and every cut must agree.** Measure in display columns — never in string length or UTF-16 code units. A Chinese, Japanese, or Korean character is two columns wide, a character outside the basic plane is one, and an escape sequence is zero.
5. **A shortcut reachable with `ctrl` needs both keyboard formats.** The renderer asks for the kitty keyboard protocol, and a terminal that supports it sends `ctrl-c` as `CSI 99 ; 5 u` instead of the byte `0x03`. `CTRL_KEYS` is derived from `CONTROL_KEYS`, so adding an entry to the legacy table is enough. Do not write a second table by hand.
6. **A key that quits must quit from everywhere.** The WINDOW owns the single `terminal.onKey` subscription and reads `ctrl-d` before delegating, so it also quits from the launch session browser (which runs before any agent exists) and from the gap between two attachments where no session owns input. Do not give a picker its own keyboard; that is how `ctrl-d` went missing the first time.
7. **A command that ran must say so, and must still say so after a resume.** Commands produce no model reply, so their own output is the only evidence they did anything. Project the harness's `command/run` and `command/done` events instead of printing when the line is submitted — printing directly loses every command result when the session is reopened. A failure always prints, and a success with no text is acknowledged by name.
8. **The renderer stays free of dependencies.** See above.
9. **The status line gives things up in a fixed order, and never cuts one in half.** Three nested preferences, outermost strongest: the modes (`plan`, `goal`) are surrendered last, then the hint reservation, then the body (bar, model, totals). The reservation is spent *inside* each mode level, not across all of them — flatten those loops and reserving room for `alt-enter newline` will silently hide a running goal. `goal 12/25` is not a smaller truth than `goal 12/256`; whole segments are dropped, never shortened. There are tests named for each of those.
10. **An optional plugin's types belong in `devDependencies`, never `peerDependencies`.** `dsh-agent-default-model`, `dsh-plan-mode`, `dsh-goal`, jobs, and subagents are read through `ctx.get(...)` and type-only imports: the runner needs their Context and `SessionEventMap` merges to compile, but none of them has to be mounted for the frontend to run. A peer entry would print unmet-peer warnings for every profile that omits them.
11. **Harness owns capability state; the TUI projects it.** Use the narrowest generic surface (`ctx.jobs`, `ctx.subagents`, `ctx.tools`, `ctx.commands`, `ctx.llm`, `ctx.sessionQuery`, `ctx.attachments`, `ctx.sessionProjections`) before a provider API. For projection-owned state, consume its snapshot and change feed; never parse rendered text, add a second state machine or persistence format, or create a provider-specific engine.
12. **Persistent extension rows need a global layout budget first.** Until that exists, capability UI belongs in bounded overlays. `TuiSlots` and overlay types are experimental pre-1.0 vocabulary, not a stable plugin SDK; future abstractions must still produce bounded rows for `Screen`.
13. **A window is not a session.** `window.ts` owns the terminal, key routing, the model route, and reader preferences; `attachment.ts` owns one Agent and everything projected from its log; `index.ts` is the plugin and the loop between them. Anything per-session — a slot registration, the `session/event` listener, the spinner timer, the Work and projection adapters — belongs to that attachment's `SessionScope`, not to `ctx.effect`, or reopening a session leaves the previous one still projecting into the terminal. The scope comes down BEFORE the agent handle, so no listener sees its own agent's teardown. Opening the agent belongs to the loop, not the attachment: a failed reopen is a decision about what the window does next, and by then there is no session left to answer for it.
14. **Observation and control are separate contracts.** A callable Harness mutation is not automatically a human-safe UI action. Expose it only when the owning seam defines lifecycle, authorization, scheduling, and model-awareness for human control. `ctx.jobs.kill()` marks a job reported for model delivery, so Work observes jobs but does not cancel them; continuable subagent interrupt explicitly carries human authority.

## Testing

Layout is checked against a real terminal emulator, not by removing escape sequences from the output. The screen is updated by moving the cursor, so the finished picture cannot be reconstructed from the text alone.

`packages/renderer/tests/rendered.spec.ts` and `packages/dshline/tests/streaming-frames.spec.ts` feed the output into `@xterm/headless`, then check the rows a person would actually see:

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

The **harness compatibility** workflow runs daily: the master check described
above, a full-suite probe of the currently **published** Harness line (pinned by
`pnpm run sync-harness`, peer ranges re-verified, packed plugin booted beside the
published launcher), and — when that line has moved — an automated sync pull
request whose title says whether peer compatibility now needs a decision. Run any
job from the repository's **Actions** tab with **Run workflow** when an upstream
change needs checking now. The master job builds declarations in a separate
checkout and links them only in the disposable runner; a red result means the
current upstream declarations are incompatible. It neither changes the supported
registry version nor publishes anything, and every job that executes harness or
dependency code deliberately holds no secrets and only read access.

## Style

Match the code around you; it is consistent on purpose.

- **Comments explain why, not what.** A comment earns its place by naming the alternative that looked reasonable but is wrong, or the failure that made the current shape necessary. No comment should restate the line below it.
- **TSDoc on every exported symbol**, with `@param` and `@returns`.
- **Named constants instead of unexplained numbers**, each with a comment saying what the value trades off.
- **No new dependencies** in either package, including development ones, without a reason that survives review.

## Commits and pull requests

Commit messages here are long and explanatory, and that convention is worth keeping.

- A conventional-commit subject: `fix(renderer): …`, `feat(dshline): …`.
- A body that says what a user saw, why the obvious fix is wrong, and what you verified. Name the deliberate mistake you tested with, or the pseudo-terminal check you ran.
- Credit review findings when a reviewer found the problem.
- If an AI agent co-authored the change, end with its `Co-Authored-By` line.

Every check must pass before a merge: build, type-check, and the full test suite on Node 22 and 24, plus dependency advisories, a secret scan, CodeQL, the workflow check, and Scorecard.

## Releases

The version number lives in three places: both package manifests and the `VERSION` constant in `packages/dshline/src/index.ts`, which the startup banner prints. The release check verifies all three. A release that updates the manifests but not the constant would publish a correctly tagged package that tells the user it is an older version.

Releases are built and published by GitHub Actions from a tag, never from a laptop, so each published file carries a signature linking it to the commit it was built from. See [`SECURITY.md`](SECURITY.md).

### Preparing a release

Every user-visible package change needs a committed changeset. Run `pnpm changeset`,
choose the change level, and write the short entry that belongs in the generated
changelog. The two published packages are fixed together, so one changeset versions
both. Do not edit package versions or `CHANGELOG.md` by hand: after a changeset
reaches `main`, the **version** workflow maintains one `Version Packages` pull
request that consumes it.

**Agent responsibility:** for every user-visible change in a published package,
add the changeset in the same pull request and propose its bump level and changelog
summary. Use `patch` for a fix and `minor` for new capability; ask when compatibility
or release impact is unclear. Documentation, CI, test-only, and internal-only changes
need no changeset. An agent must not merge the Version Packages PR or approve npm
publishing unless the user explicitly asks: those are the human release decisions.

Before the first changeset reaches `main`, enable **Settings → Actions → General →
Allow GitHub Actions to create and approve pull requests**. Keep the repository's
default token read-only. The version workflow instead needs the repository secret
`VERSION_TOKEN`: a fine-grained personal access token limited to **Contents: write**
and **Pull requests: write**. It updates only the generated version branch and PR.
Using a separate token matters because GitHub suppresses PR checks for a PR created
with `GITHUB_TOKEN`; this token lets the required checks run normally. Do not reuse
it for publishing or tagging.

Protect `v*` with a repository tag ruleset that restricts creation and deletion
of release tags to the release identity. The workflow can validate tags it creates,
but a stolen Contents-write credential could otherwise bypass that workflow and
push an arbitrary tag whose own tree supplies the publisher definition.

Configure npm trusted publishing separately for **both** published packages with
GitHub owner `riesbri`, repository `dshline`, workflow `publish.yml`, no environment,
and the `npm publish` action. No `NPM_TOKEN` is stored in GitHub: pnpm 11.22 uses
the job's OIDC permission to obtain short-lived package credentials. The manual
**publish** workflow dispatch exchanges both credentials without publishing, which
is the safe way to verify this configuration after changing it.

Merging that generated PR creates the matching `v<version>` tag from its merge
commit. Its tag step needs the distinct repository secret `RELEASE_TOKEN`: a
fine-grained personal access token limited to **Contents: write**. GitHub deliberately
suppresses workflow events triggered with `GITHUB_TOKEN`, so the normal job token
would create a tag that never starts the tag-only publisher. The workflow checks both
secrets before it produces the version PR, rather than discovering a missing token
after its merge. The tag starts `publish.yml`; after npm publishing and registry
verification succeed, its separate write-scoped job creates the generated-notes
GitHub Release. Configure both tokens before the first version run.

The tag handoff refuses to create a second tag while a publish run is queued or
running. Finish that release first; GitHub keeps only one pending run in a
concurrency group and would otherwise silently discard an intermediate version.
If a publish fails after only one package lands, correct the missing package's
trusted-publisher mapping and rerun that same tagged workflow. Its publish-only
release-age override lets pnpm see and skip the package already on npm; never create
a replacement tag for a half-release.

If the Version Packages PR was merged but its tag job was skipped or failed before
creating a tag, open **Actions → version → Run workflow**, select `main`, and enter
the Version Packages PR's merge commit in **recovery-commit**. Recovery verifies
that exact immutable commit is already reachable from `main`, reads its package
version, and does nothing when that `v<version>` tag already exists. It is the
recovery path instead of creating a tag by hand; a normal release never needs it.

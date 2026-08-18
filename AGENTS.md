# AGENTS.md

Instructions for an agent — or a person — working *on* this repository. For using the frontend, start at [`README.md`](README.md).

Read [`docs/design.md`](docs/design.md) before changing rendering, decoding, or escaping. This file is the short form: the rules, the commands, and the traps.

## What this is

A terminal frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), mounted as an in-process Cordis bundle rather than a client over a wire. Two packages:

```
packages/renderer   @riesbri/dsh-tui-renderer   width, keys, composer, boxes, screen — knows nothing about agents
packages/tui        @riesbri/dsh-tui            the bundle: session loop, transcript, seams, slot registry
```

The split is load-bearing. **The renderer must never import from the harness, and must never gain a dependency or a peer dependency.** Zero dependencies is the property that lets this bundle add nothing to a profile's tree, and it is why every width, cutting, and escaping rule is testable with no terminal and no model.

## Commands

```sh
pnpm install
pnpm build       # tsc -b for both packages
pnpm test        # 347 tests, no terminal and no model required
pnpm typecheck   # tsc -b, same graph
pnpm security    # the advisory and workflow gates CI runs
```

Nothing but this repository is needed. The harness's real service types resolve from the registry's `next` dist-tag, so a fresh clone typechecks with no sibling checkout.

## The build gotcha

`packages/tui` depends on the renderer **by package name**, which resolves through `exports` to the built `lib/` — not to `src/`.

- **Tests** are fine: a vitest alias points the name at `src`, so what runs is what is written.
- **A profile that installed this bundle from a path** resolves `lib/`. After any source change, `pnpm build` before relaunching, or you are testing the previous bytes.

This has already caused one silent failure: a renderer change was invisible to the bundle's tests until the alias existed, so a test could pass against code that no longer existed.

## Invariants

Break one of these and the failure shows up somewhere else entirely.

1. **Escape before styling, never after.** `escapeControls` neutralises the escape character itself, so running it over styled output destroys the styling, and running it over only some spans lets a control sequence through everywhere else. Everything from a model, a tool, a log, or a paste is untrusted.
2. **Styling is applied per row, and after marking.** `style()` puts its reset at the end of what it wraps, so colouring multi-line text leaves every row but the last carrying an unterminated colour into whatever is drawn beside it.
3. **Every write to the terminal goes through `Screen`.** The live region must stay the last thing on screen; that assumption is what makes an append-plus-live-region renderer correct.
4. **`displayWidth` and every cut agree.** Measure in display columns, never in string length or UTF-16 units. A CJK ideograph is two columns, an astral character is one, an escape sequence is zero.
5. **A key reachable by `ctrl` needs both encodings.** The renderer asks for the kitty keyboard protocol, under which `ctrl-c` arrives as `CSI 99 ; 5 u` and never as `0x03`. `CTRL_KEYS` is derived from `CONTROL_KEYS` so adding to the legacy table is enough — do not hand-write a second table.
6. **A gesture that can leave must leave from everywhere.** `ctrl-d` is read before overlays, and the resume picker — which runs before the agent exists and drives its own keyboard — handles it separately.
7. **A command that ran must say so.** Commands produce no model turn, so the result text is the only evidence. Failures always print.
8. **The renderer stays dependency-free.** See above.

## Testing

Layout is verified against a real terminal emulator, not by stripping escape sequences out of the byte stream — the redraw uses cursor positioning, so a frame cannot be reconstructed from text alone.

`packages/renderer/tests/rendered.spec.ts` and `packages/tui/tests/streaming-frames.spec.ts` feed output to `@xterm/headless` and assert the rows a person actually sees: borders landing in one column for ASCII and CJK, a live region leaving no tail behind when it shrinks, styling surviving a wrapped row, an escape sequence in tool output shown rather than obeyed, a streamed reply reaching scrollback exactly once however the provider chunks it, and a tool card's two frames landing in the same columns.

These tests are hermetic — no pseudo-terminal, no harness, no model — so `pnpm test` runs them and CI covers layout without a separate job. `tests/emulator.ts` is shared by both packages: `screen()` reads the viewport, `scrollback()` reads everything the terminal holds, which is where a transcript longer than the window lives.

Two traps when reading emulator output:

- A wide character occupies two cells and `translateToString` skips the second, so measure rows in **columns**, not string length.
- Text output carries neither cursor position nor cell attributes. Assert the cursor through `emulator.cursor()` and colour through `emulator.cell()` — a frame with a misplaced cursor or a colourless continuation row reads identically as text.

**Assert what a person sees.** A column number can look plausible while pointing at the wrong character; the cell cannot.

**Mutate to check the test.** The convention in this repository's history is to apply a deliberate mutation for each behaviour claimed and confirm a test fails by name. A test that passes against the broken version is documentation, not a test.

## Verifying interactive behaviour

Unit tests cannot cover the runner: it needs a Context, an agent, and a terminal. Anything about keys, quitting, overlays, or command dispatch is verified by driving the assembled profile in a **pseudo-terminal** and reading what the screen actually did. Recipes are machine-specific and live in `private/NOTES.md`.

Two rules learned the hard way:

- **Drive a scratch workspace, never a repository you care about.** `-C /tmp/somewhere` exists for this. In a default composition ordinary tool calls are not gated (see [`docs/usage.md`](docs/usage.md#approval-and-the-sandbox)), so a test prompt can and will run `git` against whatever workspace you opened.
- **Never test with `/goal <objective>`.** It arms the harness's goal-round driver and starts an autonomous multi-round run.

When a screen says nothing, read the session log: `$DSH_HOME/sessions/<workspace>/<id>/session.jsonl.zstd` records every `tool/call`, `command/run`, and `command/done`. That is how "the command silently did nothing" was distinguished from "the command failed and nobody printed it".

## Working against unreleased harness changes

The one case that wants a sibling checkout. Point the type dependencies at it instead of editing the manifest by hand:

```sh
node tools/link-harness.mjs ~/src/deepseek-harness
node tools/link-harness.mjs --check     # are the links resolvable, and is it built?
node tools/link-harness.mjs --restore   # back to the registry
```

It writes a relative path when the checkout is reachable from this repo, so the manifest stays portable and carries no home directory. `--check` verifies the declaration files rather than just the directories, because an unbuilt harness has every manifest and no types.

## Style

Match the surrounding code; it is consistent on purpose.

- **Comments explain why, not what.** A comment earns its place by naming the wrong answer that looked reasonable, or the failure that made the current shape necessary. There are no comments restating the line below them.
- **TSDoc on every exported symbol**, with `@param` and `@returns`.
- **Named constants for magic values**, each with a comment saying what the value trades off.
- **No new dependencies.** In either package, including dev dependencies, without a reason that survives review.

## Commits and pull requests

Commit messages here are long and explanatory, and the convention is worth keeping:

- Conventional-commit subject: `fix(renderer): …`, `feat(tui): …`.
- A body that states the failure in terms of what a user saw, why the obvious fix is wrong, and what was verified. Name the mutation or the pseudo-terminal check.
- Credit review findings: `Found in review by the Codex reviewer.`
- End with the trailer for whichever agent co-authored the change.

Every check is required before a merge: build, typecheck, and the full suite on Node 22 and 24, plus advisories, secret scan, CodeQL, workflow hardening, and Scorecard.

## Release

The version lives in three places — both package manifests and the `VERSION` constant in `packages/tui/src/index.ts`, which the banner reports. The release guard checks all three, because a release that bumped the manifests and missed the constant publishes a correctly tagged package that identifies itself as an older one.

Releases are built and published by GitHub Actions from a tag, never from a laptop, so each tarball carries a signed provenance attestation. See [`SECURITY.md`](SECURITY.md).

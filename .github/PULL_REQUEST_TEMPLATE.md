<!--
Read AGENTS.md before opening this — it lists the rules that are easy to break
by accident, and most review comments here are one of them.
-->

## What this changes, and why

<!-- The why matters more than the what; the diff already says the what. -->

## Checks

- [ ] `pnpm build && pnpm typecheck && pnpm test` pass
- [ ] `pnpm run verify-docs` passes — if this edits either side of a bilingual pair, the counterpart is updated and re-recorded in this PR
- [ ] A changeset is included, or nothing under `packages/` changed

## If this touches the terminal

- [ ] Text is made safe **before** color is applied, never after
- [ ] Every write goes through `Screen`; committed scrollback is not rewritten
- [ ] Widths are measured in display columns, and every cut agrees with `displayWidth`
- [ ] A new `ctrl` shortcut works in both the legacy and kitty keyboard formats
- [ ] Checked at a narrow width, and after a resize

Terminal and OS this was run in:

## If this presents a Harness capability

- [ ] It reads a standard `ctx.*` surface, not a provider API or rendered output
- [ ] It keeps no second database, state machine, or persistence format
- [ ] A profile without the capability still starts; the view is unavailable rather than fatal
- [ ] Any action it offers has the owning seam's lifecycle and authorization behind it

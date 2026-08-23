---
'@dshline/dshline': minor
'@dshline/renderer': minor
---

Rename the project, both packages, and the command to `dshline`.

`dsh-tui` named the implementation — a terminal UI — rather than the thing it is:
the terminal-native frontend for the DeepSeek Harness plugin ecosystem. The
architecture is unchanged. Harness still owns capabilities, state, runtime,
persistence, lifecycle, authorization and policy; this project still owns terminal
presentation and frontend UX, and native terminal scrollback remains the invariant
every presentation decision answers to.

What consumers must change, because there is no compatibility alias:

- `@riesbri/dsh-tui` is now `@dshline/dshline`, and `@riesbri/dsh-tui-renderer` is
  now `@dshline/renderer`. Both are new registry identities; the version lineage
  continues from 0.7.1 rather than restarting.
- The command is `dshline`, not `dshtui`.
- The Harness profile these install into is `dshline`:
  `dsh plugin --profile dshline add @dshline/dshline`, then `dsh --profile dshline`.
- The bundle's Cordis rows are `dshline` and `dshline-startup`, so a
  `cordis.patch.yml` or `settings.yaml` that configured the `tui` row — pricing,
  for instance — must name `dshline` instead.
- Sessions this frontend creates are now identified `dshline-<uuid>`.

`TuiSlots`, `TuiOverlay`, `TuiSlotName`, `TuiSlotView` and the `tui/render` event
keep their names. There, `Tui` is the technical term for a terminal user interface —
the generic slot vocabulary any frontend of this shape would need — not the old
product brand, and renaming it would have cost the vocabulary without removing any
branding.

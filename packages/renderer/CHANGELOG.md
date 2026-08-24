# dshline-renderer

## 0.9.0

## 0.8.0

### Minor Changes

- c5b3b7c: Rename the project, both packages, and the command to `dshline`.
  
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

> Released as `@riesbri/dsh-tui-renderer` through 0.7.1. The project was renamed to
> **dshline** after that release; entries below 0.8.0 record the old package
> identity as it was published, and are left as written.

## 0.7.1

### Patch Changes

- 30fb9dd: Bound the shared picker to the terminal, and let it be searched when it is long.
  
  `/model` over a gateway route offers whatever the provider advertises, which for
  OpenRouter or opencode is hundreds of models. The picker drew a row per choice,
  so it handed `Screen` a live region taller than the screen — and rows that have
  scrolled off cannot be reached or erased, which left duplicates in real
  scrollback and could clear output the picker never owned. The list is now a
  viewport over its rows, exactly as Work, Sessions, and Connect are.
  
  Past twelve choices it also grows a query box and filters as you type, with a
  counter that reports what the query left and what was offered separately. Below
  that nothing changes: a three-choice approval spends no row on a search box and
  typed characters stay meaningless there. A terminal too small to hold the frame
  now falls back to the selected choice and its keys rather than an unanswerable
  list, because an approval can arrive in any geometry.
  
  `/model`'s rows are now spelled `provider/model` — the argument the command
  accepts — with the provider's own display name under the selection when it adds
  something beyond the id. Filtering matches the label, so what you type is what
  you can see.

## 0.7.0

### Minor Changes

- e28e676: Add `/connect`, a Harness-native provider configuration browser.
  
  `/model` chooses among models that already exist; `/connect` is how a model comes
  to exist. It joins four Harness surfaces — the configurable-provider directory
  and registered routes from `ctx.llm`, the user-settings document through
  `ctx.settings`, credential presence through `ctx.credentials`, and the login
  flows on `ctx.authorization` — into one bounded overlay, and configures them
  through the seam that owns each.
  
  There is no provider list and no login protocol in this frontend. A route is
  offered because a mounted adapter declared it configurable, a profile's
  credential field is found by its schemastery `credential-ref` role rather than
  by a field name, and an authorization flow is rendered from the seam's neutral
  notice and prompt vocabulary, so a surface that renders one flow renders all of
  them. A sign-in page and device code are committed to native scrollback, where
  they can be selected and copied.
  
  Because both write the same settings namespace and the same credential
  reference, a change made here is visible on the official web Models page and the
  other way round, and `/model` sees a newly activated route's models with no
  further step.
  
  Closing the browser withdraws any sign-in it started, including one waiting on a
  browser callback with no prompt on screen, so nothing from a withdrawn attempt
  surfaces afterwards.
  
  The renderer gains `ctrl-r` in its key tables, which the browser uses to ask
  Harness again, and `tailToWidth`, the suffix twin of `truncateToWidth` that
  keeps an input field's newest characters in view.

## 0.6.0

## 0.5.1

## 0.5.0

### Minor Changes

- cd6e737: Refresh dsh-tui's plugin-native project positioning and terminal architecture visuals.

## 0.4.0

### Minor Changes

- 599129d: Add a bounded `/work` overlay and optional status summary for generic DeepSeek Harness jobs and subagents.
- 2fdf6cd: Present Harness-owned Todo projections through a bounded read-only `/todos` overlay and compact status summary.

## 0.3.2

### Patch Changes

- 35de732: Keep exact-width composer navigation, recalled drafts, and review overlays correct at terminal boundaries.

## 0.3.1

## 0.3.0

### Minor Changes

- 069d97c: Improve terminal interactions + CI

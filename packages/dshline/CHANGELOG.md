# dshline

> Released as `@riesbri/dsh-tui` through 0.7.1. The project was renamed to
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
- Updated dependencies [30fb9dd]
  - @riesbri/dsh-tui-renderer@0.7.1

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

### Patch Changes

- Updated dependencies [e28e676]
  - @riesbri/dsh-tui-renderer@0.7.0

## 0.6.0

### Minor Changes

- 786b993: Add a Harness-native Sessions browser. `/sessions` and `--resume` now open the
  same bounded overlay: it lists the `ctx.sessionQuery` corpus newest first with
  batched folded titles, filters as you type over titles, workspaces, and ids, and
  hands the same words to the engine's full-text surface on `tab` to search what
  sessions said — degrading to filtering when a deployment's backend implements no
  content search. The selected row shows its workspace, event count, last activity,
  lineage, and id, and short badges mark the open session, a live one, a delegated
  child, and a fork.
  
  Reopening now works from inside a running window. It retires the current agent
  through the owned `AgentHandle` disposer and resumes the chosen session with
  `ctx.agents.resume`, appending the replayed transcript into native scrollback
  without rewriting anything already committed. It refuses, naming the reason, when
  a turn is running, when jobs or subagents are still attached to the session being
  left, when the target is already live, or when it has no persisted log. A resume
  that fails anyway reports Harness's reason and reopens the browser rather than
  ending the process or substituting a session nobody asked for.

### Patch Changes

- 08a3e1b: Keep streamed reasoning from splitting an unfinished final-answer line.
- @riesbri/dsh-tui-renderer@0.6.0

## 0.5.1

### Patch Changes

- b39d8c6: Align the npm package description with dsh-tui's Harness-native terminal frontend positioning.
- @riesbri/dsh-tui-renderer@0.5.1

## 0.5.0

### Minor Changes

- cd6e737: Refresh dsh-tui's plugin-native project positioning and terminal architecture visuals.

### Patch Changes

- Updated dependencies [cd6e737]
  - @riesbri/dsh-tui-renderer@0.5.0

## 0.4.0

### Minor Changes

- 599129d: Add a bounded `/work` overlay and optional status summary for generic DeepSeek Harness jobs and subagents.
- 2fdf6cd: Present Harness-owned Todo projections through a bounded read-only `/todos` overlay and compact status summary.

### Patch Changes

- Updated dependencies [599129d]
- Updated dependencies [2fdf6cd]
  - @riesbri/dsh-tui-renderer@0.4.0

## 0.3.2

### Patch Changes

- 35de732: Keep exact-width composer navigation, recalled drafts, and review overlays correct at terminal boundaries.
- Updated dependencies [35de732]
  - @riesbri/dsh-tui-renderer@0.3.2

## 0.3.1

### Patch Changes

- a07df8e: Keep the startup banner version synchronized with generated package releases.
- @riesbri/dsh-tui-renderer@0.3.1

## 0.3.0

### Minor Changes

- 069d97c: Improve terminal interactions + CI

### Patch Changes

- Updated dependencies [069d97c]
  - @riesbri/dsh-tui-renderer@0.3.0

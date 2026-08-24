# dshline

## 0.9.0

### Minor Changes

- 717a2de: Add `/new` to start a fresh session in the current workspace, with the previous conversation available for reopening when Harness session persistence is enabled.
- e45ef55: Add `/plugins`: a terminal browser for the running agent's Harness preset composition — search, toggle a row, create a customizable copy of a built-in preset, switch a blank session's preset live, and set the default for new sessions.
  
  Adopting this required moving the agent plane behind Harness's own agent-presets architecture, the same step deepseek-harness's own Web bundle already took: `dsh-base`'s model-facing tool rows (`tool-bash`, `tool-fs`, `tool-subagent`, `tool-workflow`, and the rest of the per-agent rows a preset also lists) are now disabled in `cordis.patch.yml` and mounted through a preset instead, defaulting to `standard`. A fresh session composes from the roster's default; a resumed one composes from whatever preset its own session log recorded, never today's default — and a session from before this bundle adopted presets, which recorded none, resumes under `standard` specifically rather than whatever the default happens to be today, so old history is never silently rebuilt under a different composition than it actually ran with. A deployment that ships no usable `standard` resumes such a session under its own default and reports the substitution in the transcript, rather than refusing to open its own history.
  
  A profile that mounts no `agentPresets` seam at all leaves the new composition step a no-op — but that only recovers the old flat `dsh-base` tool set for a deployment that never applied this bundle's own agent-plane disable list to begin with. Removing the seam from an otherwise-stock dshline install leaves an agent with no tools at all; `/plugins` itself still degrades cleanly and reports the capability unavailable either way.
- fc28162: Add `/profiles`, a terminal browser over Harness's own profile layer — the roster under `$DSH_HOME/profiles`, which profile this Host booted, and each profile's ordered `dsh.profile.bundles` layers with the installed version wherever pnpm's state already records one. It reads through Harness's own `dshHomePath` service and the Loader's base URL, and forwards every mutation to `dsh plugin --profile <name> …`, so pnpm invocation and `dsh.profile.bundles` reconciliation stay Harness's. No installer, resolver, package registry, or lockfile behavior is added here.
  
  Restart boundaries are stated rather than implied: a bundle change alters what the *next* Host composes, so a change to the running profile reports `restart required` and a change to any other names the command that picks it up. Switching profiles is not offered at all — nothing re-links a composed Host's bundle layers, so `enter` on another profile names the command that boots it.
  
  Bundle operations reach the launcher the same four ways `dshline` itself does (`DSH_BIN`, a `DSH_HARNESS` source checkout, `PATH`, then the installed `@deepseek-ai/dsh`), are serialized per profile for the whole process rather than per overlay, are bounded to completion rather than merely signalled, keep only a rolling tail of pnpm output, withhold URL specs and credentials from the transcript, and confirm before a removal.
  
  While an operation runs, the frame shows it persistently rather than as an expiring notice, and a landed change to the running profile keeps a `restart required` line on screen; closing the browser writes still-running work and any owed restart to the transcript instead of leaving it to be inferred from silence. Keys stay live throughout — a previous gate stayed shut for the whole pnpm run and returned silently, so every button appeared dead for minutes. A failure leads with the reason pnpm gave (`ERR_PNPM_FETCH_404`, git's `fatal:` line) rather than only its exit code, and the add prompt says outright that it takes an exact package name rather than searching.
  
  A dependency that is installed but is not a bundle layer is now listed under `Installed, not a layer` with its version, and can be removed like any other, so a package that composed nothing is visible instead of absent; one whose installed copy does declare `dsh.bundle` is flagged, since the layer list is then stale. Where a failure is a pending decision rather than a mistake — `ERR_PNPM_IGNORED_BUILDS` blocks every operation on a profile until a human answers pnpm's `allowBuilds` placeholders — the profile is tagged `builds pending` before anything is attempted and the file to answer it in is named, never edited. A running operation turns a real spinner and vanishes when it finishes.
  
  `/plugins` now shows capability health where it can be proven from Harness state. A profile PROVIDES capabilities and a preset EXPOSES them, so an enabled row is not evidence that its backing capability exists; a row naming a provider that a mounted Host registry does not supply is marked `⚠` and reported as unavailable in this Host — which is what `ctx.subagents.list()` actually proves, rather than a claim about what is installed. The check is a data table of capability modules read against `ctx.subagents`, not a branch per provider: a module the table does not cover, a `!!js` provider that is never evaluated, and a profile mounting no such registry all produce no verdict rather than a guess.
  
  `enter` now toggles a plugin row exactly as `space` does, outside search mode, where `enter` still means "done typing".
  
  **Breaking for anyone who typed it:** `/profile` is now `/timing`. It only ever toggled the per-turn time breakdown, and a Harness *profile* is the composition a launcher boots — the word now belongs to `/profiles`.
- 75c2770: Replace post-turn timing dumps with a bounded live panel that tracks active turns and tools in real time.

### Patch Changes

- a2e07f2: Ease a newly arrived live bar in over a few working heartbeats instead of flashing straight to full width — the first span is always the longest, so pure measurement drew every arrival at maximum. The ease follows the working spinner's existing heartbeat rather than render counts, so bursts of streamed redraws cannot spend it; it adds no timer and never alters the measured duration beside the bar, and spans that predate the panel appearing draw at full width immediately.
- a2e07f2: Redraw the timing panel's bars as mid-height strokes (`━`) over a dim track (`─`) instead of full blocks whose remainder was left blank. Blank remainders hid where each row's scale ended, and stacked full-height blocks fused rows of near-equal length into one slab that obscured where one span's bar ended and the next began; the stroke keeps whitespace between rows however close their durations are.
- a2e07f2: Name the longest span hidden behind the timing panel's elision row (`… +3 more · max 6.0s`) instead of showing an unlabeled sum. Timing spans overlap, so their sum is work done rather than elapsed time and could exceed the very turn printed in the heading; the maximum answers the same relative question as the rows above it. The figure degrades whole on narrow terminals rather than being cut into a broken duration.
- @dshline/renderer@0.9.0

## 0.8.0

### Minor Changes

- 3447249: Say what the goal is, and what a long turn is doing.
  
  The goal segment read `goal 0/256` — a round cap the reader never chose, against a
  count that had not moved, for an objective it never named. It now leads with the
  objective (`goal armed · ship the release`) and reports the count only once a round
  has actually been taken. This matters because a goal is not always something the user
  set: the harness publishes `create_goal` as a model-callable tool and tells the model
  it may infer a long-running objective without being asked, so a session can acquire
  automatic continuation authority that was never typed. The status line is where that
  becomes visible, and it now says what it is.
  
  The objective is the one part of a mode that may be surrendered on its own as the
  terminal narrows — it is prose, so a shorter one is still true, where a shortened
  round count would be a different number. Everything else about the drop order is
  unchanged.
  
  The working segment also names the tool the turn is waiting on
  (`⠙ working 14m 26s · run_shell_command +2`). Elapsed time alone reads the same whether
  a command is running or the session has hung. The harness dispatches concurrency-safe
  calls in parallel, so the count says how many others are outstanding rather than
  naming one of them as though it were the only one. The elapsed time stays the turn's:
  nothing claims a duration for any single call, because the harness publishes none.
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
- 67ea319: Make every truncated tool result reachable, and keep the end of a command's output.
  
  `ctrl-o` armed an inspector only for a truncated **compact** card, so a `full` card
  that hit its own row cap printed `… 3 more lines` with nothing able to open it. The
  inspector now has its own, far larger row budget — its rows live in the windowed live
  region, where a card's are committed into scrollback permanently — so it has more to
  show than any card did, and every truncated card arms it and says so.
  
  Command output is now elided from the TOP rather than the bottom. What `pnpm test` was
  run to find out is the failure and the summary at the end; keeping the first six rows
  kept the banner and threw away the answer. File reads, searches, and diffs are
  unchanged: their first rows are what was asked for.
  
  The status line also lists `ctrl-o output` while a turn is running. A truncated card
  arms a one-shot opportunity that the next result takes away, so a turn is exactly when
  that keystroke needs advertising — and it was the one moment the hint was missing.
  
  Every presentation resolves its budget through one function, so a diff and a search
  are inspected at the inspector's budget too rather than keeping the card's cap. The
  inspector renders once per width instead of once per keystroke: the inspected result
  is a completed log entry, so scrolling a thousand-row body no longer re-runs the
  presenter on every arrow key.

### Patch Changes

- 99ff7a9: Count what the suggestion list is actually hiding, and bound it to the screen.
  
  The `… N more` row reported `candidates.length - shown.length`, which is the same
  number at every scroll position: fifteen commands showed `… 9 more` with the first
  highlighted and still `… 9 more` with the last. It now counts the rows below the
  window, so it reaches zero at the bottom, and the help line carries the position
  (`10/15`) so the rows scrolled off above are accounted for without a second marker.
  
  The list also ignored the height the slot contract passes it, so on a short terminal
  it pushed the composer out of the live region — where `Screen` can no longer erase it,
  and the next redraw left a duplicate frame in scrollback. `TuiSlots.compose()` now
  hands each slot view the rows the views above it have NOT spent, rather than the
  terminal's own height, so a ten-row prompt shrinks the list instead of overflowing the
  screen. Where nothing is left, the list renders nothing rather than chrome with every
  candidate hidden.
- 5d5f7ba: Accept the published Harness `0.1.1-rc` line in the peer ranges, and pin
  development dependencies to the exact currently published Harness versions.
  
  The peers said `^0.1.0-rc.7`, which under npm's prerelease rules rejects every
  `0.1.1-rc.x` package — npm ranges only match prereleases whose
  major.minor.patch tuple appears inside the range itself. The harness now
  publishes its moving line as `0.1.1-rc.x`, so installing this bundle next to a
  current harness produced unmet-peer warnings and ERESOLVE errors even though
  the bundle runs fine, which the compatibility workflow could not see because it
  only typechecked against unreleased master source.
  
  The ranges are now `^0.1.0-rc.7 || ^0.1.1-rc.2`: both lines the full suite has
  been run against, and nothing newer. Development dependencies are pinned to
  the exact authoritative published versions — the harness line under its `next`
  tag, cordis under `latest`, whose stable 4.0.1 is what the whole current line
  builds on — and a daily job re-pins them (`pnpm run sync-harness`), re-verifies
  the peer ranges (`pnpm run check-peers`), and boots the packed plugin beside
  the published launcher, so metadata can no longer drift from reality silently.
- Updated dependencies [c5b3b7c]
  - @dshline/renderer@0.8.0

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

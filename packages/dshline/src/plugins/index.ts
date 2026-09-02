/**
 * `/plugins`: the running agent's Harness preset composition, from a terminal.
 *
 * The same division of labour every other domain here keeps: Harness owns
 * the preset roster, a preset's composition, session composition and its
 * lifecycle, and the `agent-presets.default` setting. This module owns the
 * rows, the keyboard, and the two prompts a keystroke here can raise — a
 * copy-to-customize confirmation, and a new preset's id. There is no plugin
 * registry here, no YAML dialect invented, and no per-provider branch: a row
 * reaches this browser because `ctx.agentPresets` composed it, is toggled
 * through the one narrow adapter `actions.ts` offers for exactly that
 * reason, and a preset is switched or defaulted through the same
 * `agentPresets.select()`/`ctx.settings` seams Harness's own Web client uses.
 * @module dshline/plugins
 */

import type { Context } from '@deepseek-ai/cordis'
import { escapeControls, paint } from '@dshline/renderer'
import type { CompositionRow } from './composition.ts'
import { pluginsSeams } from './harness.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSettings } from './harness.ts'
import { PluginsCatalog, messageOf } from './catalog.ts'
import { hostCapabilities } from './health.ts'
import type { PluginsCatalogSpec } from './catalog.ts'
import type { PluginsAgent, PluginsSessionFacts } from './harness.ts'
import { sessionFacts } from './harness.ts'
import type { PresetRow } from './model.ts'
import {
  presetChoiceDetail,
  presetChoiceLabel,
  presetSwitchEligibility,
  selectablePresetRows,
  suggestPresetId,
  toggleEligibility,
  validPresetId,
} from './model.ts'
import type { PluginsActionOutcome } from './actions.ts'
import { copyPreset, setDefaultPreset, switchPreset, toggleRow } from './actions.ts'
import { createPluginsOverlay } from './overlay.ts'
import type { PluginsOverlay } from './overlay.ts'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'

export type {
  AgentPresetRow,
  AgentPresetsSeam,
  PluginsAgent,
  PluginsSeams,
  PluginsSessionFacts,
  PluginsSettings,
  PresetTrust,
} from './harness.ts'
export { pluginsSeams, sessionFacts } from './harness.ts'
export type { CompositionRow, CompositionTree, DisabledState, RowLocator } from './composition.ts'
export { parseComposition, toggleDisabled } from './composition.ts'
export type { PresetRow, ToggleEligibility, PresetSwitchEligibility } from './model.ts'
export {
  filterCompositionRows,
  filterPresetRows,
  presetRows,
  rowMark,
  toggleEligibility,
} from './model.ts'
export type { BrowsedComposition, PluginsCapabilities, PluginsCatalogSpec, PluginsState } from './catalog.ts'
export type { CapabilityRegistry, HostCapabilities, RowHealth, SubagentRegistrySeam } from './health.ts'
export { CAPABILITY_LINKS, healthFacts, hostCapabilities, rowHealth, unbackedWhileEnabled } from './health.ts'
export { PluginsCatalog } from './catalog.ts'
export type { PluginsActionOutcome } from './actions.ts'
export { copyPreset, setDefaultPreset, switchPreset, toggleRow } from './actions.ts'
export type { PluginsOverlay, PluginsOverlaySpec } from './overlay.ts'
export { createPluginsOverlay } from './overlay.ts'

/**
 * The active session's facts, read live at the moment of the call.
 *
 * Deliberately read per call rather than captured once: every eligibility
 * decision in this domain turns on whether the session is still blank, and an
 * action holds its own awaits — two prompts a human answers, a file write, a
 * Harness re-resolve — across which a turn can start. A snapshot taken before
 * those awaits would go on reporting a started session as blank.
 * @param spec - the context and agent the browser was opened over.
 * @returns the session's current projected facts.
 */
function factsOf(spec: PluginsSpec): PluginsSessionFacts {
  return sessionFacts(spec.ctx, spec.agent.session)
}

/**
 * The preset the active session can be positively confirmed to be running,
 * read live.
 *
 * The catalog reports the same join, but from whichever pass settled last —
 * and every caller here needs it AFTER its own awaits, not before them. What
 * the agent actually composed wins over what the projection states, since a
 * composed agent is the stronger evidence; `undefined` means dshline cannot
 * confirm which preset is current, which is never treated as a match.
 * @param agentPresets - the preset seam.
 * @param spec - the context and agent the browser was opened over.
 * @returns the preset id, or undefined when it cannot be confirmed.
 */
function runningPresetId(agentPresets: AgentPresetsSeam, spec: PluginsSpec): string | undefined {
  return agentPresets.composedPreset(spec.agent.ctx) ?? factsOf(spec).presetId
}

/** What opening the browser needs from the window it opens over. */
export interface PluginsSpec {
  /** Context carrying the harness seams and the slot registry. */
  readonly ctx: Context
  /** The attached agent, for its composition and its session's projected facts. */
  readonly agent: PluginsAgent
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** Current time; injected so notice expiry is assertable. */
  readonly now?: () => number
  /**
   * Called after this agent's scope was re-parented onto another composition.
   *
   * A recompose changes which layers a scope-aware Harness registry merges for
   * this agent, and it does so WITHOUT a registry mutation — so nothing the
   * registries emit announces it. The one consumer that needs telling today is
   * the skill catalog, and it is told the only thing this module knows:
   * the composition changed, so re-read the authoritative view. Nothing here
   * inspects a preset definition to guess which capability moved.
   */
  readonly recomposed?: () => void
}

/**
 * Show the Plugins browser and stay until the reader closes it.
 * @param spec - the context, the agent, and where transcript rows go.
 * @returns when the browser is closed.
 */
export async function openPlugins(spec: PluginsSpec): Promise<void> {
  const { ctx, agent, commit } = spec
  const seams = pluginsSeams(ctx)
  const catalogSpec: PluginsCatalogSpec = {
    seams,
    agentCtx: agent.ctx,
    session: () => factsOf(spec),
    // Read off the plugin's own context, not the agent's: the subagent
    // registry is a host-plane process singleton (dshline's own
    // `cordis.patch.yml` keeps it there deliberately), so what it supplies is
    // a fact about the running Host — exactly the "profiles provide, presets
    // expose" boundary these rows are checked against.
    host: () => hostCapabilities(ctx),
    invalidate: () => { ctx.tuiSlots.invalidate() },
  }
  const catalog = new PluginsCatalog(catalogSpec)
  catalog.refresh()
  let overlay!: PluginsOverlay
  // One action at a time, for the same reason Connect keeps a `busy` flag: an
  // action opens its own prompts and awaits a human, and a second keystroke
  // arriving underneath would start a second write against state the first
  // has not finished changing.
  let busy = false
  let closed = false
  try {
    await new Promise<void>(resolve => {
      let dismiss = (): void => {}
      const settle = (): void => {
        if (closed) return
        closed = true
        dismiss()
        resolve()
      }
      // Every failure an action can answer for is already turned into a
      // `PluginsActionOutcome` by `actions.ts`. This catch is for the ones that
      // are not answers at all — a prompt or an overlay throwing is the
      // concrete one — which would otherwise leave this floating
      // promise rejected, and an unhandled rejection ends the process on
      // Node's default setting, taking the whole session with it over a
      // keystroke in an overlay.
      //
      // Reporting is itself best-effort, and swallows rather than rethrows.
      // Drawing is the only channel this domain has: if `report` or `commit`
      // is the thing that failed, there is nowhere to say so, and letting that
      // failure out of the handler would reject the very promise this catch
      // exists to settle — reintroducing the crash by way of the recovery from
      // it. A dropped diagnostic loses one sentence; a rejection here loses
      // the session.
      const run = (task: () => Promise<void>): void => {
        if (busy) return
        busy = true
        void task()
          .catch((error: unknown) => {
            const message = `the action could not be completed: ${messageOf(error)}`
            try {
              if (!overlay.closed()) overlay.report(message, true)
              commit(outcomeLines({ kind: 'failed', message }))
            } catch {
              // See above: the terminal is the only place this could be said.
            }
          })
          .finally(() => { busy = false })
      }
      overlay = createPluginsOverlay({
        state: () => catalog.state(),
        refresh: () => { catalog.refresh() },
        toggle: row => { run(() => performToggle(spec, seams, catalog, overlay, row)) },
        pickPreset: () => { run(() => performPickPreset(spec, seams, catalog, overlay)) },
        makeDefault: () => { run(() => performMakeDefault(spec, seams, catalog, overlay)) },
        now: spec.now ?? ((): number => Date.now()),
        close: () => { settle() },
        invalidate: () => { ctx.tuiSlots.invalidate() },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
    })
  } finally {
    catalog.dispose()
  }
}

/**
 * One outcome as a transcript row, matching `connect/index.ts`'s
 * `outcomeLines` character for character: escaped as a whole, so
 * `escapeControls` neutralizing the escape character itself is not undone by
 * running it over already-coloured text.
 * @param outcome - what the write answered.
 * @returns the single line to commit.
 */
function outcomeLines(outcome: PluginsActionOutcome): string[] {
  const mark = outcome.kind === 'failed' ? '✗' : '·'
  return [paint(
    escapeControls(`${mark} plugins: ${outcome.message}`),
    outcome.kind === 'failed' ? 'error' : 'muted',
  )]
}

/**
 * Report and commit one outcome, then re-read Harness so the browser shows
 * what actually landed rather than what was merely attempted.
 *
 * The transcript row is committed even when the reader has already closed the
 * browser, and that is the one place this domain diverges from Connect — which
 * drops a late result outright. The difference is what the two actions mean: a
 * withdrawn sign-in is work that did not happen, while a landed preset write
 * changed a file on disk, and the committed row is the only durable evidence
 * of it this session leaves. What IS skipped is everything addressed to a
 * reader who is no longer looking — the transient notice, and a re-read whose
 * only purpose is repainting a frame that is gone.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh (or re-browse) after the write.
 * @param overlay - the overlay to report into.
 * @param outcome - what the write answered.
 * @param browseId - re-browse this preset instead of a plain refresh, when given.
 */
function land(
  spec: PluginsSpec,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
  outcome: PluginsActionOutcome,
  browseId?: string,
): void {
  spec.commit(outcomeLines(outcome))
  if (overlay.closed()) return
  overlay.report(outcome.message, outcome.kind === 'failed')
  if (browseId === undefined) catalog.refresh()
  else catalog.browse(browseId)
}

/**
 * Handle a `space` on one composition row.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, for the current reading and to refresh after.
 * @param overlay - the overlay to report into.
 * @param row - the selected row.
 */
async function performToggle(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
  row: CompositionRow,
): Promise<void> {
  const state = catalog.state()
  const agentPresets = seams.agentPresets
  if (state.kind !== 'ready' || state.browsing.kind !== 'rows' || agentPresets === undefined) return
  const presetId = state.browsing.presetId
  const presetRow = state.presets.find(preset => preset.id === presetId)
  if (presetRow === undefined) {
    overlay.report(`${presetId} is no longer on the roster`, true)
    return
  }
  const eligibility = toggleEligibility(row, presetRow, { canWriteUserPresets: state.capabilities.canWriteUserPresets })
  if (eligibility.kind === 'conditional') {
    const expression = row.disabled.kind === 'conditional' ? row.disabled.expression : ''
    overlay.report(`disabled by a condition (${expression}); edit the preset file directly`, true)
    return
  }
  if (eligibility.kind === 'unavailable') {
    overlay.report(eligibility.reason, true)
    return
  }
  if (eligibility.kind === 'toggle') {
    // Re-resolved fresh rather than trusting the roster row this pass
    // already read: Harness's discovery is live, and the preset's trust or
    // health may have changed in the moment between that read and this key.
    let fresh: AgentPresetRow
    try {
      fresh = await agentPresets.resolve(presetId)
    } catch (error) {
      overlay.report(`${presetId}: ${messageOf(error)}`, true)
      return
    }
    const outcome = await toggleRow(agentPresets, fresh, row.locator, eligibility.enable)
    if (outcome.kind === 'failed') {
      land(spec, catalog, overlay, outcome, presetId)
      return
    }
    land(spec, catalog, overlay, await liveEffectNote(agentPresets, spec, presetId, outcome), presetId)
    return
  }
  // requires-copy: confirm, then copy, then apply the SAME toggle to the
  // fresh copy — the happy path is one keystroke to reach a customizable,
  // already-toggled preset, not a second Space press after the copy lands.
  // `enable` is recomputed rather than carried on `ToggleEligibility` itself
  // ('requires-copy' names no direction — the copy is what makes toggling
  // possible at all, so the row's own current state is still the answer).
  const enable = row.disabled.kind === 'disabled'
  await performCopyThenToggle(spec, seams, catalog, overlay, presetRow, row, enable)
}

/**
 * After a successful file edit, force a blank current session onto the new
 * generation immediately, or explain why the current session is untouched.
 *
 * The preset id itself never changes here — the session's log already names
 * this preset, only WHICH generation it runs did — so `recompose` is called
 * but no new `agent-preset/selected` event is appended; that event exists to
 * record a CHOICE between presets, and none was made.
 *
 * Both facts it gates on are read HERE, from the live projections, rather
 * than taken from the reading the toggle was decided against: that reading
 * predates the file write and the Harness re-resolve, and a turn starting
 * across those awaits would make its `blank` false while the captured copy
 * still said true. This is the module's only `recompose`, and `recompose` is
 * the raw re-link with no check of its own — `switchPreset` goes through
 * `AgentPresets.select`, which re-reads `turnBoundary` inside its own
 * serialized switch. So the check has to be made at the same instant here.
 * @param agentPresets - the preset seam.
 * @param spec - the context and agent.
 * @param presetId - the preset id whose file just changed.
 * @param outcome - the successful toggle outcome to extend.
 * @returns the outcome, worded for what happens to the CURRENT session.
 */
async function liveEffectNote(
  agentPresets: AgentPresetsSeam,
  spec: PluginsSpec,
  presetId: string,
  outcome: PluginsActionOutcome,
): Promise<PluginsActionOutcome> {
  if (runningPresetId(agentPresets, spec) !== presetId) return outcome
  if (factsOf(spec).started) {
    return {
      kind: 'done',
      message: `${outcome.message} — saved for future sessions; the current session has already started and stays on its existing composition`,
    }
  }
  try {
    await agentPresets.recompose(spec.agent.ctx, presetId)
  } catch (error) {
    return { kind: 'failed', message: `${outcome.message}, but the current session could not pick it up: ${messageOf(error)}` }
  }
  spec.recomposed?.()
  return { kind: 'done', message: `${outcome.message} — current session updated live` }
}

/**
 * The system-preset path: confirm a copy, ask for its id, create it, and
 * apply the row's toggle to the new user preset in the same gesture.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, for the roster and to browse the copy after.
 * @param overlay - the overlay to report into.
 * @param preset - the system preset being copied.
 * @param row - the row the original toggle was requested on.
 * @param enable - what the original toggle would have set the row to.
 */
async function performCopyThenToggle(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
  preset: PresetRow,
  row: CompositionRow,
  enable: boolean,
): Promise<void> {
  const agentPresets = seams.agentPresets
  if (agentPresets === undefined) return
  const confirmed = await promptSelect(spec.ctx, {
    title: `${preset.name} is a built-in preset.`,
    view: 'Confirm',
    detail: 'Create a local copy to customize it?',
    choices: [
      { value: 'copy', label: 'Create copy' },
      { value: 'cancel', label: 'Cancel' },
    ],
  })
  if (confirmed !== 'copy') return
  const state = catalog.state()
  const existingIds = state.kind === 'ready' ? state.presets.map(candidate => candidate.id) : [preset.id]
  const suggested = suggestPresetId(preset.id, existingIds)
  const typed = await promptText(spec.ctx, {
    title: 'New preset id',
    view: 'New preset',
    message: `Copy ${preset.id} as:`,
    detail: `Enter accepts ${suggested}`,
    kind: 'text',
    placeholder: suggested,
  })
  if (typed === undefined) return
  const id = typed.trim() === '' ? suggested : typed.trim()
  if (!validPresetId(id)) {
    overlay.report(`"${id}" is not a usable preset id`, true)
    return
  }
  const copyOutcome = await copyPreset(agentPresets, preset.id, id)
  if (copyOutcome.kind === 'failed') {
    land(spec, catalog, overlay, copyOutcome)
    return
  }
  let fresh: AgentPresetRow
  try {
    fresh = await agentPresets.resolve(id)
  } catch {
    // The copy itself succeeded; a resolve failing immediately after would be
    // Harness's roster disagreeing with the write it just accepted. Report
    // the copy as done and let the browse-triggered refresh surface whatever
    // is actually wrong, rather than inventing a second error message for a
    // roster it cannot itself explain here.
    land(spec, catalog, overlay, copyOutcome, id)
    return
  }
  const toggleOutcome = await toggleRow(agentPresets, fresh, row.locator, enable)
  if (toggleOutcome.kind === 'failed') {
    land(spec, catalog, overlay, { kind: 'failed', message: `${copyOutcome.message}; ${toggleOutcome.message}` }, id)
    return
  }
  // Read from the live agent, not from the catalog: the session may have
  // moved on while a human was answering the two prompts, and the catalog
  // reports whichever pass settled last — which for this path is the one
  // taken before those prompts were even raised. Only when the preset just
  // COPIED is the one the current session actually runs, and that session is
  // still blank, does the new copy get switched to durably (through
  // `AgentPresets.select`, which records the choice) — every other case is a
  // customization for later, said plainly rather than silently doing nothing.
  // Harness re-checks the lock inside `select`, so a stale read here could
  // never actually cross it; what it would do is word the answer as a failed
  // switch instead of the guidance the reader needs.
  const sourceIsCurrentBlank = runningPresetId(agentPresets, spec) === preset.id
    && !factsOf(spec).started
  if (!sourceIsCurrentBlank) {
    land(spec, catalog, overlay, {
      kind: 'done',
      message: `${copyOutcome.message}; ${toggleOutcome.message} — saved as a future-session customization; `
        + `press d to make ${id} the default, or p to switch an eligible session to it`,
    }, id)
    return
  }
  const switchOutcome = await switchPreset(agentPresets, spec.agent, id)
  const combined: PluginsActionOutcome = switchOutcome.kind === 'failed'
    ? { kind: 'failed', message: `${copyOutcome.message}; ${toggleOutcome.message}; ${switchOutcome.message}` }
    : { kind: 'done', message: `${copyOutcome.message}; ${toggleOutcome.message}; switched the current session to ${id}` }
  land(spec, catalog, overlay, combined, id)
}

/**
 * Handle `p`: choose a preset, then either switch a blank session to it or
 * offer it as the default for the next one.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, for the roster and to refresh/browse after.
 * @param overlay - the overlay to report into.
 */
async function performPickPreset(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
): Promise<void> {
  const state = catalog.state()
  if (state.kind !== 'ready' || seams.agentPresets === undefined) {
    overlay.report('agent presets are not available in this Harness profile', true)
    return
  }
  const choices = selectablePresetRows(state.presets)
  if (choices.length === 0) {
    overlay.report('no presets are available to choose from', true)
    return
  }
  const pickedId = await promptSelect(spec.ctx, {
    title: 'Agent Preset',
    view: 'Agent preset',
    choices: choices.map(row => {
      const detail = presetChoiceDetail(row)
      return {
        value: row.id,
        label: presetChoiceLabel(row),
        ...detail === undefined ? {} : { description: detail },
      }
    }),
  })
  if (pickedId === undefined) return
  // Read after the picker, not before it: the eligibility this turns on is
  // whether the session is STILL blank, and a human was just answering a
  // prompt. It decides only what to OFFER — Harness re-reads the same
  // `turnBoundary` fact inside `select` and refuses there if it has to.
  const eligibility = presetSwitchEligibility(factsOf(spec))
  if (eligibility.kind === 'recompose') {
    const outcome = await switchPreset(seams.agentPresets, spec.agent, pickedId)
    // A successful switch re-parented this agent's scope, so every scope-aware
    // Harness view of it may now merge different layers.
    if (outcome.kind === 'done') spec.recomposed?.()
    land(spec, catalog, overlay, outcome, pickedId)
    return
  }
  await performOfferDefault(spec, seams, catalog, overlay, pickedId, eligibility.message)
}

/**
 * The locked-session fallback: offer to make the picked preset the default
 * for the NEXT session instead, exactly as the spec's authority boundary
 * requires — never bypassing the lock, never silently doing nothing.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, to refresh after.
 * @param overlay - the overlay to report into.
 * @param id - the preset that cannot be switched to right now.
 * @param lockedMessage - why the session is locked, for the confirmation's detail.
 */
async function performOfferDefault(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
  id: string,
  lockedMessage: string,
): Promise<void> {
  if (seams.settings === undefined) {
    overlay.report(`${lockedMessage}; this profile also mounts no settings provider to set a default`, true)
    return
  }
  const confirmed = await promptSelect(spec.ctx, {
    title: 'Session preset is fixed',
    view: 'Preset',
    detail: lockedMessage,
    choices: [
      { value: 'default', label: `Make ${id} the default for new sessions` },
      { value: 'cancel', label: 'Cancel' },
    ],
  })
  if (confirmed !== 'default') return
  const outcome = await setDefaultPreset(seams.settings, id)
  land(spec, catalog, overlay, outcome)
}

/**
 * Handle `d`: make the preset currently being browsed the default outright,
 * without a picker — the spec's own suggested shortcut for the common case
 * of "this is the one I just finished customizing."
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, for the current reading and to refresh after.
 * @param overlay - the overlay to report into.
 */
async function performMakeDefault(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
): Promise<void> {
  const state = catalog.state()
  if (state.kind !== 'ready') return
  const id = state.browsing.presetId
  const settings: PluginsSettings | undefined = seams.settings
  if (settings === undefined) {
    overlay.report('this profile mounts no settings provider', true)
    return
  }
  // The same invariant the `p` picker already keeps (`selectablePresetRows`
  // excludes a broken preset from what can be chosen at all): `d` must not
  // hand a known-broken or already-vanished preset to the NEXT session as
  // its default just because it happened to be the one on screen.
  const current = state.presets.find(candidate => candidate.id === id)
  if (current === undefined) {
    overlay.report(`${id} is no longer on the roster`, true)
    return
  }
  if (current.broken !== undefined) {
    overlay.report(`${id} cannot be made the default: ${current.broken}`, true)
    return
  }
  if (id === state.defaultId) {
    overlay.report(`${id} is already the default`, false)
    return
  }
  const outcome = await setDefaultPreset(settings, id)
  land(spec, catalog, overlay, outcome)
}

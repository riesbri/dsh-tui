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
 * `recompose`/`ctx.settings` seams Harness's own Web client uses.
 * @module dshline/plugins
 */

import type { Context } from '@deepseek-ai/cordis'
import { escapeControls, style } from '@dshline/renderer'
import type { CompositionRow } from './composition.ts'
import { pluginsSeams } from './harness.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSettings } from './harness.ts'
import { PluginsCatalog, messageOf } from './catalog.ts'
import type { PluginsCatalogSpec } from './catalog.ts'
import type { PluginsSessionFacts, PresetRow } from './model.ts'
import {
  presetChoiceDetail,
  presetChoiceLabel,
  presetSwitchEligibility,
  selectablePresetRows,
  suggestPresetId,
  toggleEligibility,
  validPresetId,
} from './model.ts'
import type { PluginsActionOutcome, PresetSelectionLog } from './actions.ts'
import { copyPreset, setDefaultPreset, switchPreset, toggleRow } from './actions.ts'
import { createPluginsOverlay } from './overlay.ts'
import type { PluginsOverlay } from './overlay.ts'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'

export type {
  AgentPresetRow,
  AgentPresetsSeam,
  PluginsSeams,
  PluginsSettings,
  PresetTrust,
} from './harness.ts'
export { pluginsSeams } from './harness.ts'
export type { CompositionRow, CompositionTree, DisabledState, RowLocator } from './composition.ts'
export { parseComposition, toggleDisabled } from './composition.ts'
export type { PluginsSessionFacts, PresetRow, ToggleEligibility, PresetSwitchEligibility } from './model.ts'
export {
  filterCompositionRows,
  filterPresetRows,
  presetRows,
  resolveSessionPreset,
  rowMark,
  sessionBlank,
  toggleEligibility,
} from './model.ts'
export type { BrowsedComposition, PluginsCapabilities, PluginsCatalogSpec, PluginsState } from './catalog.ts'
export { PluginsCatalog } from './catalog.ts'
export type { PluginsActionOutcome, PresetSelectionLog } from './actions.ts'
export { copyPreset, setDefaultPreset, switchPreset, toggleRow } from './actions.ts'
export type { PluginsOverlay, PluginsOverlaySpec } from './overlay.ts'
export { createPluginsOverlay } from './overlay.ts'

/**
 * The one Harness session surface `/plugins` reads.
 *
 * Deliberately NOT extended with `PresetSelectionLog`'s `append`, even
 * though the real session this is built from always has one: `dsh-session`'s
 * actual `Session.append<T extends SessionEventType>` is closed over its own
 * `SessionEventMap`, which knows `'agent-preset/selected'` only once
 * `@deepseek-ai/dsh-agent-presets/session`'s module augmentation has been
 * imported somewhere — a dependency this domain does not take (see
 * `harness.ts`'s header). Requiring `append` here would make every caller's
 * `agent.session` fail to structurally satisfy this interface for exactly
 * that reason. Instead, the one place `/plugins` actually calls `append` casts
 * to {@link PresetSelectionLog} locally, which is the honest place for that
 * trust to live: right where the write happens, not in the public contract
 * every attachment site must satisfy just to hand this module read access.
 */
export interface PluginsAgentSession {
  /** The session's creation header; only `agentPreset` is read. */
  readonly header: { readonly agentPreset?: string }
  /** The session's event log, oldest first; only `type` and `data` are read. */
  readonly events: readonly { readonly type: string; readonly data?: unknown }[]
}

/** The one Harness agent surface `/plugins` reads. */
export interface PluginsAgent {
  /** The agent's own scope context, for `composedPreset` and `recompose`. */
  readonly ctx: object
  /** The session this agent is attached to. */
  readonly session: PluginsAgentSession
}

/** What opening the browser needs from the window it opens over. */
export interface PluginsSpec {
  /** Context carrying the harness seams and the slot registry. */
  readonly ctx: Context
  /** The attached agent, for its composition and its session's facts/log. */
  readonly agent: PluginsAgent
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** Current time; injected so notice expiry is assertable. */
  readonly now?: () => number
}

/**
 * Show the Plugins browser and stay until the reader closes it.
 * @param spec - the context, the agent, and where transcript rows go.
 * @returns when the browser is closed.
 */
export async function openPlugins(spec: PluginsSpec): Promise<void> {
  const { ctx, agent, commit } = spec
  const seams = pluginsSeams(ctx)
  const sessionFacts = (): PluginsSessionFacts => ({
    headerPreset: agent.session.header.agentPreset,
    events: agent.session.events,
  })
  const catalogSpec: PluginsCatalogSpec = {
    seams,
    agentCtx: agent.ctx,
    session: sessionFacts,
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
      const run = (task: () => Promise<void>): void => {
        if (busy) return
        busy = true
        void task().finally(() => { busy = false })
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
  return [style(
    escapeControls(`${mark} plugins: ${outcome.message}`),
    outcome.kind === 'failed' ? 'red' : 'gray',
  )]
}

/**
 * Report and commit one outcome, then re-read Harness so the browser shows
 * what actually landed rather than what was merely attempted.
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
  overlay.report(outcome.message, outcome.kind === 'failed')
  spec.commit(outcomeLines(outcome))
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
    land(spec, catalog, overlay, outcome, presetId)
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
  const combined: PluginsActionOutcome = toggleOutcome.kind === 'failed'
    ? { kind: 'failed', message: `${copyOutcome.message}; ${toggleOutcome.message}` }
    : { kind: 'done', message: `${copyOutcome.message}; ${toggleOutcome.message}` }
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
  const sessionFacts: PluginsSessionFacts = {
    headerPreset: spec.agent.session.header.agentPreset,
    events: spec.agent.session.events,
  }
  const eligibility = presetSwitchEligibility(sessionFacts)
  if (eligibility.kind === 'recompose') {
    // The one place this domain calls `session.append` — see
    // `PluginsAgentSession`'s doc for why the cast lives here and not in the
    // public contract every attachment site has to satisfy.
    const log = spec.agent.session as unknown as PresetSelectionLog
    const outcome = await switchPreset(seams.agentPresets, spec.agent.ctx, sessionFacts, log, pickedId)
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
  if (id === state.defaultId) {
    overlay.report(`${id} is already the default`, false)
    return
  }
  const outcome = await setDefaultPreset(settings, id)
  land(spec, catalog, overlay, outcome)
}

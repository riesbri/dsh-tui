/**
 * The writes `/plugins` performs, each through the seam that owns it.
 *
 * Four operations, each mapping onto exactly one Harness authority:
 *
 * ```
 * toggleRow      narrow file edit on a USER preset's composition (no Harness
 *                seam exists narrower than a full read/parse/write — see
 *                composition.ts's header — so this is the smallest safe
 *                adapter, gated on preset.trust === 'user' as a second check
 *                behind the UI's own toggleEligibility)
 * copyPreset     ctx.agentPresets.copy() — the one authoring write Harness
 *                itself exposes
 * switchPreset   ctx.agentPresets.recompose() — gated on the session still
 *                being blank, and logged via the same 'agent-preset/selected'
 *                event Harness's own Web API appends after a successful swap
 * setDefaultPreset  ctx.settings.mutate('agent-presets', ...) — never a
 *                direct settings.yaml write
 * ```
 *
 * Nothing here decides whether an action should be OFFERED; `model.ts`'s
 * `toggleEligibility`/`presetSwitchEligibility` do, from the same facts.
 * These functions assume the offer was made and report what Harness (or, for
 * `toggleRow`, the file it owns) answered.
 * @module dshline/plugins/actions
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { RowLocator } from './composition.ts'
import { parseComposition, toggleDisabled } from './composition.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSettings } from './harness.ts'
import { messageOf } from './catalog.ts'
import type { PluginsSessionFacts } from './model.ts'
import { sessionBlank } from './model.ts'

/** How one write ended, in words the transcript can carry. */
export interface PluginsActionOutcome {
  /** Whether the write went through. */
  readonly kind: 'done' | 'failed'
  /** What happened, already worded for a reader. */
  readonly message: string
}

function done(message: string): PluginsActionOutcome {
  return { kind: 'done', message }
}

function failed(message: string): PluginsActionOutcome {
  return { kind: 'failed', message }
}

/** Thrown inside the file lock to carry `toggleDisabled`'s own refusal out as the outcome. */
class ToggleRefusedError extends Error {}

/**
 * Enable or disable one row of a USER preset's composition.
 *
 * Refuses outright — never even opens the file — for a system preset:
 * Harness's shipped compositions are an input, never a persistence target
 * (`Include.write()` is a no-op for a preset tree, per `vendor/include`), and
 * `toggleEligibility` should never have offered this in the first place, so
 * this check is a second gate behind that one, not the only one.
 *
 * The read, the narrow edit, and the write all happen inside one
 * `withFileLock` hold: a concurrent writer of the same file (another dshline
 * session, a hand edit racing this one) is serialized rather than raced, so
 * this can never resurrect a state a concurrent write just replaced. After
 * the write, the file is read back through `agentPresets.read()` and parsed
 * again — re-validated through Harness's own seam, not trusted blindly —
 * and a parse failure is reported as a failed outcome even though the bytes
 * are already on disk, since pretending the toggle "succeeded" while the
 * file is now broken would be a worse lie than a slow one.
 * @param agentPresets - the preset seam.
 * @param preset - the roster row the row belongs to.
 * @param locator - the row's locator, as `CompositionRow.locator` reports it.
 * @param enable - `true` to enable the row, `false` to disable it.
 * @returns what happened.
 */
export async function toggleRow(
  agentPresets: AgentPresetsSeam,
  preset: AgentPresetRow,
  locator: RowLocator,
  enable: boolean,
): Promise<PluginsActionOutcome> {
  if (preset.trust !== 'user') {
    return failed(`${preset.id} is a built-in preset and cannot be edited in place`)
  }
  let wrote: boolean
  try {
    wrote = await withFileLock(preset.path, async () => {
      const text = await readFile(preset.path, 'utf8')
      const result = toggleDisabled(text, locator, enable)
      if (!result.ok) throw new ToggleRefusedError(result.message)
      if (result.text === text) return false
      await writeFileAtomic(preset.path, result.text, { mode: 0o600 })
      return true
    })
  } catch (error) {
    if (error instanceof ToggleRefusedError) return failed(error.message)
    return failed(`${preset.id}: could not write the change (${messageOf(error)})`)
  }
  if (!wrote) return done(`${preset.id}: already ${enable ? 'enabled' : 'disabled'}`)
  try {
    const reread = await agentPresets.read(preset.id)
    const reparsed = parseComposition(reread)
    if (reparsed.kind === 'broken') {
      return failed(`${preset.id}: wrote the change, but the file no longer parses (${reparsed.reason})`)
    }
  } catch (error) {
    return failed(`${preset.id}: wrote the change, but could not re-read it (${messageOf(error)})`)
  }
  return done(`${preset.id}: ${enable ? 'enabled' : 'disabled'}`)
}

/**
 * Create a locally authored preset by copying an existing one whole.
 * @param agentPresets - the preset seam.
 * @param from - the preset the copy starts from.
 * @param id - the new preset's id.
 * @param name - display name for the copy; omitted falls back to `id`.
 * @returns what happened.
 */
export async function copyPreset(
  agentPresets: AgentPresetsSeam,
  from: string,
  id: string,
  name?: string,
): Promise<PluginsActionOutcome> {
  try {
    await agentPresets.copy(from, id, name)
  } catch (error) {
    return failed(`could not create ${id}: ${messageOf(error)}`)
  }
  return done(`created ${id} from ${from}`)
}

/** The one thing `switchPreset` needs from the active session besides its facts. */
export interface PresetSelectionLog {
  /**
   * Log which preset the session actually runs, mirroring the event
   * `packages/host/apiproxy`'s own `select` appends after a successful
   * `recompose` — never a rewrite of the session's creation header.
   * @param type - always `'agent-preset/selected'`.
   * @param data - the preset id now installed.
   */
  append(type: 'agent-preset/selected', data: { readonly agentPreset: string }): unknown
}

/**
 * Re-link the active agent to a different preset's standing composition.
 *
 * Gated on {@link sessionBlank} even though `AgentPresetsSeam.recompose`
 * itself performs no such check (its own doc says the caller owns it) —
 * this is the one enforcement point between a picker keystroke and a
 * composition swap Harness would carry out without complaint but the
 * session's own log would then contradict.
 * @param agentPresets - the preset seam.
 * @param agentCtx - the agent's scope context.
 * @param session - the session's facts, for the blank check.
 * @param log - where the successful switch is recorded.
 * @param id - the preset to switch to.
 * @returns what happened.
 */
export async function switchPreset(
  agentPresets: AgentPresetsSeam,
  agentCtx: object,
  session: PluginsSessionFacts,
  log: PresetSelectionLog,
  id: string,
): Promise<PluginsActionOutcome> {
  if (!sessionBlank(session)) {
    return failed('this session has already started; its agent preset is fixed')
  }
  let preset: AgentPresetRow
  try {
    preset = await agentPresets.recompose(agentCtx, id)
  } catch (error) {
    return failed(`could not switch to ${id}: ${messageOf(error)}`)
  }
  log.append('agent-preset/selected', { agentPreset: preset.id })
  return done(`switched to ${preset.name ?? preset.id}`)
}

/**
 * Set the preset a new session gets when none is named explicitly.
 * @param settings - the settings seam.
 * @param id - the preset id to make the default.
 * @returns what happened.
 */
export async function setDefaultPreset(settings: PluginsSettings, id: string): Promise<PluginsActionOutcome> {
  try {
    await settings.mutate('agent-presets', [{ op: 'set', path: ['default'], value: id }])
  } catch (error) {
    return failed(`could not set ${id} as the default: ${messageOf(error)}`)
  }
  return done(`${id} is now the default for new sessions`)
}

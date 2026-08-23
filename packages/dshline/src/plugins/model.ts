/**
 * What `/plugins` knows, as rows and decisions a terminal can draw.
 *
 * Two things are joined here that Harness keeps deliberately separate: a
 * preset's ROSTER identity (`AgentPresetRow` — id, trust, broken-ness) and one
 * preset's COMPOSITION (`CompositionRow`, from `./composition.ts` — the rows a
 * `.cordis.yml` actually lists). A session's relationship to a preset is a
 * third thing again, and it is read from the session's own log rather than
 * asked of `ctx.agentPresets`, because that is exactly what Harness's Web API
 * does (`resolveSessionPreset` in `@deepseek-ai/dsh-agent-presets/session`):
 * the header names the preset a session started with, a later
 * `agent-preset/selected` event overrides it, and the blank/started
 * distinction — the one authority boundary this whole feature exists to
 * respect — is `!events.some(e => e.type === 'turn/start')`, character for
 * character what `packages/host/apiproxy/src/api-proxy.ts`'s `sessionBlank`
 * checks before ever calling `recompose`.
 * @module dshline/plugins/model
 */

import type { AgentPresetRow, PresetTrust } from './harness.ts'
import type { CompositionRow } from './composition.ts'

/** The session facts this domain reads — its own shape, not `dsh-session`'s. */
export interface PluginsSessionFacts {
  /** The preset the session's header recorded at creation, if any. */
  readonly headerPreset: string | undefined
  /** The session's event log, oldest first; only `type` and `data` are read. */
  readonly events: readonly { readonly type: string; readonly data?: unknown }[]
}

/**
 * Whether a session has produced any turn yet.
 *
 * Identical to the Web API's own `sessionBlank`: a session that has run a
 * turn cannot be recomposed without leaving logged tool calls the new
 * composition might not be able to make, so this is the one fact every
 * preset-switch decision in this module is gated on.
 * @param session - the session's facts.
 * @returns whether the session is still eligible for `recompose`.
 */
export function sessionBlank(session: PluginsSessionFacts): boolean {
  return !session.events.some(event => event.type === 'turn/start')
}

/**
 * The preset a session actually runs, newest selection winning.
 *
 * Mirrors `resolveSessionPreset` from `@deepseek-ai/dsh-agent-presets/session`
 * exactly (reimplemented rather than imported — see `harness.ts`'s header for
 * why this domain does not depend on that package): the header supplies the
 * creation-time value, a later `agent-preset/selected` event is logged only
 * while the session was blank and overrides it, so the last one logged is the
 * answer.
 * @param session - the session's facts.
 * @returns the preset id, or undefined when nothing named one.
 */
export function resolveSessionPreset(session: PluginsSessionFacts): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type !== 'agent-preset/selected') continue
    const data = event.data as { agentPreset?: unknown } | undefined
    if (typeof data?.agentPreset === 'string') return data.agentPreset
  }
  return session.headerPreset
}

/** One roster preset, joined with what the current session and default say about it. */
export interface PresetRow {
  /** The preset id. */
  readonly id: string
  /** Whether it ships with the deployment or was authored locally. */
  readonly trust: PresetTrust
  /** Display name; falls back to `id`. */
  readonly name: string
  /** One-line description, when the preset declares one. */
  readonly description: string | undefined
  /** Why this preset cannot be mounted, when it cannot. */
  readonly broken: string | undefined
  /** Whether the active session is actually composed from this preset. */
  readonly isCurrent: boolean
  /** Whether this is the preset a new session would get. */
  readonly isDefault: boolean
}

/**
 * Join the roster with session and default facts, preserving roster order.
 *
 * Order is never re-ranked, the same rule `connect/model.ts` states for its
 * own rows: the roster's order is Harness's, not a preference this frontend
 * invents.
 * @param presets - the roster, as `AgentPresetsSeam.list()` returns it.
 * @param currentId - the id the active session is composed from, if resolved.
 * @param defaultId - the id a new session would get.
 * @returns one row per roster preset.
 */
export function presetRows(
  presets: readonly AgentPresetRow[],
  currentId: string | undefined,
  defaultId: string,
): readonly PresetRow[] {
  return presets.map(preset => ({
    id: preset.id,
    trust: preset.trust,
    name: preset.name ?? preset.id,
    description: preset.description,
    broken: preset.broken,
    isCurrent: preset.id === currentId,
    isDefault: preset.id === defaultId,
  }))
}

/**
 * Normalize text for matching: case-folded, with runs of space collapsed.
 * @param value - raw text.
 * @returns the comparable form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * Whether one composition row answers a typed query, matched against its id
 * and its package/module name — the two fields the spec calls out by example
 * (`subagent`, `codex`, `workflow`, `bash`), and nothing else: matching
 * against `configSummary` would surface rows by a fact a reader did not type
 * looking for.
 * @param row - the composition row.
 * @param query - raw query text.
 * @returns true when the row should stay visible.
 */
export function matchesCompositionRow(row: CompositionRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  return normalize(`${row.id} ${row.name}`).includes(needle)
}

/**
 * Apply a query to composition rows, preserving document order.
 * @param rows - the flattened composition rows.
 * @param query - raw query text.
 * @returns the matching rows, in their original order.
 */
export function filterCompositionRows(
  rows: readonly CompositionRow[],
  query: string,
): readonly CompositionRow[] {
  return normalize(query) === '' ? rows : rows.filter(row => matchesCompositionRow(row, query))
}

/**
 * Whether one preset row answers a typed query, matched against its id and
 * display name.
 * @param row - the preset row.
 * @param query - raw query text.
 * @returns true when the row should stay visible.
 */
export function matchesPresetRow(row: PresetRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  return normalize(`${row.id} ${row.name}`).includes(needle)
}

/**
 * Apply a query to preset rows, preserving roster order.
 * @param rows - the preset rows.
 * @param query - raw query text.
 * @returns the matching rows, in their original order.
 */
export function filterPresetRows(rows: readonly PresetRow[], query: string): readonly PresetRow[] {
  return normalize(query) === '' ? rows : rows.filter(row => matchesPresetRow(row, query))
}

/** The mark a composition row's own state earns — never `effective`, which needs no glyph of its own. */
export type RowMark = '●' | '○' | '◐'

/**
 * The glyph a composition row's OWN `disabled` field earns.
 *
 * Deliberately reads {@link CompositionRow.disabled}, not `.effective`: a
 * leaf disabled only because its parent group is off still shows its own
 * field honestly (`●`, enabled) so toggling it back does what the row says it
 * will, and `effective` is reported alongside as a fact, not folded into the
 * mark.
 * @param row - the composition row.
 * @returns the mark.
 */
export function rowMark(row: CompositionRow): RowMark {
  if (row.disabled.kind === 'conditional') return '◐'
  return row.disabled.kind === 'enabled' ? '●' : '○'
}

/**
 * The right-hand facts under a composition row: its effective state (only
 * when it disagrees with its own field), a config summary, and nothing this
 * module cannot see structurally.
 * @param row - the composition row.
 * @returns the facts, most useful first.
 */
export function compositionRowFacts(row: CompositionRow): string[] {
  const facts: string[] = []
  if (row.disabled.kind === 'conditional') facts.push(`condition: ${row.disabled.expression}`)
  if (!row.group && row.effective !== row.disabled.kind && row.effective !== 'enabled') {
    facts.push(row.effective === 'disabled' ? 'off via parent group' : 'conditional via parent group')
  }
  if (row.configSummary !== undefined) facts.push(row.configSummary)
  return facts
}

/** What pressing space on one composition row would do, before it is tried. */
export type ToggleEligibility =
  /** The row's own field is a plain boolean; space flips it. */
  | { readonly kind: 'toggle'; readonly enable: boolean }
  /** The preset is a system preset; space should offer a copy-to-customize flow instead. */
  | { readonly kind: 'requires-copy' }
  /** The row's `disabled` is a `!!js` condition; a plain toggle would discard it. */
  | { readonly kind: 'conditional' }
  /** No writable seam is mounted at all. */
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * What pressing space on one row would do, given the preset it belongs to.
 * @param row - the selected composition row.
 * @param preset - the preset this composition was read from.
 * @param capabilities - whether a write path exists at all right now.
 * @returns the eligibility, before any write is attempted.
 */
export function toggleEligibility(
  row: CompositionRow,
  preset: { readonly trust: PresetTrust },
  capabilities: { readonly canWriteUserPresets: boolean },
): ToggleEligibility {
  if (row.group) return { kind: 'unavailable', reason: 'a group row has no single on/off state to toggle' }
  if (!capabilities.canWriteUserPresets) {
    return { kind: 'unavailable', reason: 'this deployment has no writable preset root' }
  }
  if (preset.trust === 'system') return { kind: 'requires-copy' }
  if (row.disabled.kind === 'conditional') return { kind: 'conditional' }
  return { kind: 'toggle', enable: row.disabled.kind === 'disabled' }
}

/** What selecting a preset in the `p` picker would do to the active session. */
export type PresetSwitchEligibility =
  /** The session is blank; `recompose` may run and takes effect immediately. */
  | { readonly kind: 'recompose' }
  /** The session already has history; only the default for the NEXT session can change. */
  | { readonly kind: 'locked'; readonly message: string }

/**
 * Whether picking a preset may recompose the active session, or must be
 * redirected to "default for the next session" instead.
 *
 * The check, and the message, mirror `packages/host/apiproxy`'s own
 * `agent-preset-locked` response exactly: Harness does not enforce this
 * itself (`AgentPresetsSeam.recompose`'s doc says the caller owns it), so
 * this module is the one boundary standing between a picker keystroke and a
 * composition swap Harness would accept without complaint but the log would
 * make dishonest.
 * @param session - the active session's facts.
 * @returns which path applies.
 */
export function presetSwitchEligibility(session: PluginsSessionFacts): PresetSwitchEligibility {
  if (sessionBlank(session)) return { kind: 'recompose' }
  return {
    kind: 'locked',
    message: 'this session has already started; its agent preset is fixed — pick a default for the next session instead',
  }
}

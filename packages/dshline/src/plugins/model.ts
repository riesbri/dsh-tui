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
 * Reimplemented rather than imported from `@deepseek-ai/dsh-agent-presets/
 * session` (see `harness.ts`'s header for why this domain does not depend on
 * that package) after the SAME reasoning: the header supplies the
 * creation-time value, a later `agent-preset/selected` event is logged only
 * while the session was blank and overrides it, so the last one logged is the
 * answer. This is defensive compatibility, not an exact mirror: upstream
 * trusts `event.data.agentPreset` as the typed shape `SessionEventMap`
 * guarantees at the type-checker level; this reads a session's raw event log
 * without that guarantee behind it, so a selection event whose `data` does
 * not actually carry a string `agentPreset` is skipped rather than trusted,
 * falling through to an older selection or the header.
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
 * (when it has one — `id` is optional to Harness, and an id-less row is
 * still fully searchable by name) and its package/module name — the two
 * fields the spec calls out by example (`subagent`, `codex`, `workflow`,
 * `bash`), and nothing else: matching against `configSummary` would surface
 * rows by a fact a reader did not type looking for.
 * @param row - the composition row.
 * @param query - raw query text.
 * @returns true when the row should stay visible.
 */
export function matchesCompositionRow(row: CompositionRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  return normalize(`${row.id ?? ''} ${row.name}`).includes(needle)
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
 *
 * The conditional check runs BEFORE the system/user trust check on purpose:
 * a `!!js` row is not togglable no matter whose preset it is copied into, so
 * checking trust first would walk a reader through "create a local copy" for
 * a toggle that was always going to be refused. Copy is offered only for a
 * row that would actually become togglable once it belongs to a preset this
 * deployment can write to.
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
  if (row.disabled.kind === 'conditional') return { kind: 'conditional' }
  if (!capabilities.canWriteUserPresets) {
    return { kind: 'unavailable', reason: 'this deployment has no writable preset root' }
  }
  if (preset.trust === 'system') return { kind: 'requires-copy' }
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

/**
 * Presets worth offering in the `p` switch/default picker.
 *
 * A broken preset is still shown in the composition browser when it is the
 * one currently open (Harness's own roster still lists it, `broken` and
 * all), but a picker whose whole job is choosing what to compose from next
 * offers none it cannot mount — the same filter Harness's own Web settings
 * store applies (`presetOptions()`) before a pick-list is built.
 * @param rows - every roster preset row.
 * @returns the rows a picker may offer.
 */
export function selectablePresetRows(rows: readonly PresetRow[]): readonly PresetRow[] {
  return rows.filter(row => row.broken === undefined)
}

/**
 * One preset's picker label: name, id, and the tags that distinguish it —
 * current, default, and built-in vs custom — matching the facts the spec's
 * own mock calls out (`current · default`).
 * @param row - the preset row.
 * @returns the label line.
 */
export function presetChoiceLabel(row: PresetRow): string {
  const tags = [
    row.isCurrent ? 'current' : undefined,
    row.isDefault ? 'default' : undefined,
    row.trust === 'user' ? 'custom' : undefined,
  ].filter((tag): tag is string => tag !== undefined)
  const suffix = tags.length === 0 ? '' : ` · ${tags.join(' · ')}`
  return `${row.name}  ${row.id}${suffix}`
}

/**
 * One preset's picker detail line, shown only while it is selected.
 * @param row - the preset row.
 * @returns the description, or undefined when the preset declares none.
 */
export function presetChoiceDetail(row: PresetRow): string | undefined {
  return row.description
}

/** The id shape Harness's own authoring accepts (`PRESET_ID` in `dsh-agent-presets`). */
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/**
 * Whether a typed string is a usable preset id.
 * @param id - the candidate id.
 * @returns whether Harness's own authoring would accept it.
 */
export function validPresetId(id: string): boolean {
  return PRESET_ID_PATTERN.test(id)
}

/**
 * A free id for copying `from`, preferring the obvious `<from>-custom`.
 *
 * Suggested, never assigned outright: the happy path is accepting this with
 * one keystroke, but a reader who already has a `standard-custom` should not
 * be stopped from typing their own name instead.
 * @param from - the preset being copied.
 * @param existingIds - every id already on the roster.
 * @returns an id not already taken.
 */
export function suggestPresetId(from: string, existingIds: readonly string[]): string {
  const taken = new Set(existingIds)
  const base = `${from}-custom`
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`
    if (!taken.has(candidate)) return candidate
  }
}

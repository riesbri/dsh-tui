/**
 * Curated presentation for one known configuration domain: `llm-pi-ai`.
 *
 * Every other module in this directory is generic — it reads what
 * `LlmConfigurableProvider`, a settings descriptor, or a credential reference
 * publishes, and holds no adapter's field names. That stays true for WHICH
 * routes exist, whether one is active, and where its credential lives (the
 * `credential-ref` schema role in {@link "./schema.ts"}). It stops being true
 * for a curated route editor: "endpoint", "protocol", and "model catalog" are
 * not roles any generic seam publishes, so presenting them at all means
 * knowing a specific namespace's field names.
 *
 * `llm-pi-ai` is that one namespace today — the adapter whose settings profile
 * can describe a provider route wholesale, per
 * `@deepseek-ai/dsh-llm-pi-ai`'s `PiAiProviderProfile`. This module names its
 * four curated fields (`displayName`, `baseURL`, `api`, `models`) as plain
 * strings and reads/writes them through the same generic `ctx.settings` path
 * ops every other Connect action uses. It does not import the pi-ai package at
 * runtime, does not register providers, does not parse model output, and does
 * not perform network I/O — Harness still does every one of those. What lives
 * here is only the knowledge of which four fields, out of the many
 * `PiAiProviderProfile` now has, are worth a terminal form in this pass.
 *
 * The protocol CHOICES this module offers are not hard-coded even though the
 * field name is: `protocolChoices` reads the `api` field's own schema node and
 * takes the strings out of a `union` of `const`s, which is exactly how
 * `dsh-llm-pi-ai` builds that field (`z.union(supportedProtocols())`). A future
 * protocol needs no dshline change; a schema that stops shaping the field this
 * way degrades to no offered choices rather than a stale list.
 * @module dshline/connect/pi-ai
 */

import type { SettingsPathOp } from './harness.ts'
import type { ConnectAction, ConnectCapabilities, ConnectProviderRow } from './model.ts'
import { fieldNode, profileNode, unionConstStrings } from './schema.ts'

/** The one namespace this module knows how to present curated fields for. */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/** `PiAiProviderProfile` field names this pass curates; see the module note for why only these four. */
export const DISPLAY_NAME_FIELD = 'displayName'
export const BASE_URL_FIELD = 'baseURL'
export const API_FIELD = 'api'
export const MODELS_FIELD = 'models'

/** Whether a route row belongs to the one domain this module presents. */
export function isPiAiNamespace(settingsNs: string): boolean {
  return settingsNs === PI_AI_NAMESPACE
}

/** One `PiAiModelProfile` entry, exactly as this pass curates it — never the whole shape. */
export interface CuratedModelFields {
  readonly id: string
  readonly name: string | undefined
  readonly contextWindow: number | undefined
  readonly maxTokens: number | undefined
}

/**
 * The curated fields the row-editor form shows, out of whatever a raw model
 * entry actually carries.
 *
 * Every other property on the entry — `input`, `reasoningEfforts`, `compat`,
 * anything a future pi-ai release adds — is read past here rather than
 * discarded: {@link mergeModelEntry} is what carries them forward.
 * @param raw - one element of the profile's `models` array, whatever shape it is.
 * @returns the curated view, or undefined when the entry has no usable `id`.
 */
export function curatedModelFields(raw: unknown): CuratedModelFields | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id === '') return undefined
  return {
    id,
    name: typeof record.name === 'string' ? record.name : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    maxTokens: typeof record.maxTokens === 'number' ? record.maxTokens : undefined,
  }
}

/**
 * The profile's raw `models` array, exactly as stored — undefined when the
 * route inherits its owning catalog, `[]` when the profile explicitly serves
 * none. Reading straight off the resolved value keeps that distinction: the
 * `llm-pi-ai` schema materializes no default for this field, so an absent key
 * survives resolution as absent rather than being synthesized from the
 * installed catalog (that inheritance happens deeper, in the adapter, not in
 * settings resolution).
 * @param profile - the profile value at a route's `settingsPath`.
 * @returns the raw entries, or undefined when the field is unset.
 */
export function rawModels(profile: unknown): readonly unknown[] | undefined {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
  const value = (profile as Record<string, unknown>)[MODELS_FIELD]
  return Array.isArray(value) ? value : undefined
}

/**
 * Merge curated edits onto whatever a model entry already carried.
 *
 * The retained object is the source of unknown-field survival: spreading it
 * first and the curated fields second keeps `input`, `compat`, and anything
 * else this pass does not render, while still letting a curated edit win. A
 * curated field cleared back to undefined is deleted rather than written as
 * `null` or literal `undefined` — `settings.mutate` accepts only JSON-compatible
 * data, and a stored `null` would read back as configured-to-nothing rather
 * than as inherited.
 * @param retained - the entry's previous raw shape, when one existed.
 * @param curated - the fields the editor changed.
 * @returns the entry to write, JSON-compatible.
 */
export function mergeModelEntry(
  retained: Record<string, unknown> | undefined,
  curated: CuratedModelFields,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...retained, id: curated.id }
  setOrDelete(next, 'name', curated.name)
  setOrDelete(next, 'contextWindow', curated.contextWindow)
  setOrDelete(next, 'maxTokens', curated.maxTokens)
  return next
}

/**
 * Write a field, or remove it when the curated value is absent.
 * @param target - the object being built.
 * @param key - the field name.
 * @param value - the curated value, or undefined to omit it.
 */
function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

/**
 * Wire protocols the `api` field's own schema currently offers.
 * @param schema - the `llm-pi-ai` namespace's serialized schema.
 * @param routePath - path to the route's profile (an existing route's
 *   `settingsPath`, or a new route's `[...parentPath, id]` — a `dict` node
 *   answers the same shape for a key it has never seen).
 * @returns the offered protocol strings, in schema order; empty when the
 *   schema does not shape the field as a union of string consts.
 */
export function protocolChoices(schema: unknown, routePath: readonly string[]): string[] {
  const located = profileNode(schema, routePath)
  if (located === undefined) return []
  const node = fieldNode(located, API_FIELD)
  return unionConstStrings(node, located.envelope)
}

/** One field-level change to a route's curated, non-model profile. */
export interface CuratedFieldChange {
  readonly field: string
  /** The new value, or undefined to unset the field back to inherited/absent. */
  readonly value: string | undefined
}

/**
 * Path ops for a set of curated field changes against an EXISTING route.
 *
 * One op per changed field, each addressed under the route's own path — never
 * a wholesale replace, so a sibling field this pass does not render (`compat`,
 * `headers`, `thinkingBudgets`, …) is untouched by construction rather than by
 * care taken while building a bigger object.
 * @param routePath - the route's `settingsPath`.
 * @param changes - the fields that changed, already diffed against the read profile.
 * @returns the ops, in the order given.
 */
export function fieldOps(routePath: readonly string[], changes: readonly CuratedFieldChange[]): SettingsPathOp[] {
  return changes.map(change => change.value === undefined
    ? { op: 'unset', path: [...routePath, change.field] }
    : { op: 'set', path: [...routePath, change.field], value: change.value })
}

/**
 * One op replacing a route's whole `models` array.
 * @param routePath - the route's `settingsPath`.
 * @param entries - the entries to write, already merged by {@link mergeModelEntry}.
 * @returns the op.
 */
export function setModelsOp(routePath: readonly string[], entries: readonly Record<string, unknown>[]): SettingsPathOp {
  return { op: 'set', path: [...routePath, MODELS_FIELD], value: entries }
}

/**
 * The op that resets a route's model catalog back to its owning adapter's.
 *
 * `unset`, never `set` with `[]`: an empty array is an explicit "this route
 * serves nothing", while unsetting the field is "serve the installed catalog
 * unchanged" — the same distinction {@link rawModels} preserves on the way in.
 * @param routePath - the route's `settingsPath`.
 * @returns the op.
 */
export function unsetModelsOp(routePath: readonly string[]): SettingsPathOp {
  return { op: 'unset', path: [...routePath, MODELS_FIELD] }
}

/** Every curated field a brand-new route's profile may set. */
export interface NewRouteProfile {
  readonly displayName: string | undefined
  readonly baseURL: string
  readonly api: string
  readonly models: readonly CuratedModelFields[]
  /** The schema-discovered credential-reference field, when the schema names one. */
  readonly credentialField: string | undefined
  readonly credentialRef: string | undefined
}

/**
 * One `set` op declaring a brand-new route, whole.
 *
 * Unlike an edit, a new key has no prior value to preserve a sibling of, so
 * one op is the whole write — the same reason {@link activateRoute} in
 * `actions.ts` writes a single object for a route that does not exist yet.
 * @param routePath - `[...parentPath, id]` for the new route.
 * @param profile - the fields the create form collected.
 * @returns the op.
 */
export function createRouteOp(routePath: readonly string[], profile: NewRouteProfile): SettingsPathOp {
  const value: Record<string, unknown> = { [BASE_URL_FIELD]: profile.baseURL, [API_FIELD]: profile.api }
  if (profile.displayName !== undefined) value[DISPLAY_NAME_FIELD] = profile.displayName
  if (profile.credentialField !== undefined && profile.credentialRef !== undefined) {
    value[profile.credentialField] = profile.credentialRef
  }
  value[MODELS_FIELD] = profile.models.map(model => mergeModelEntry(undefined, model))
  return { op: 'set', path: routePath, value }
}

/**
 * The one action `rowActions` cannot offer: opening the curated editor.
 *
 * `model.ts` stays generic on purpose, so "edit endpoint and models" is not one
 * of its offers — no seam publishes which fields are worth curating for a route
 * in general. This is the one place that gap is closed, and only for the
 * domain this module presents: a row from any other namespace gets nothing
 * added, and falls back to whatever `rowActions` already offered.
 * @param row - the selected provider row.
 * @param capabilities - which optional seams this deployment mounts.
 * @returns zero or one action, to append to `rowActions`'s own offer.
 */
export function extraActions(row: ConnectProviderRow, capabilities: ConnectCapabilities): ConnectAction[] {
  if (!isPiAiNamespace(row.settingsNs)) return []
  if (!capabilities.settings || row.revision === undefined || row.settingsPath.length === 0) return []
  return [{
    id: 'edit-route',
    label: 'Edit endpoint and models',
    description: 'Opens the curated editor for this route’s base URL, protocol, and model catalog',
  }]
}

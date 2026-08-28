/**
 * A route's model list as a draft: pure edits, no Harness, no rendering.
 *
 * A pi-ai route's `models` array is either absent — inherit the owning
 * adapter's catalog — or a list of entries, each carrying at minimum an `id`
 * and possibly fields this pass does not curate. This module is what an editor
 * does to that list in memory before it is ever written: add a candidate a
 * discovery call reported, add one typed by hand, toggle one in or out, edit
 * its curated fields, and turn the survivors back into JSON-compatible rows
 * without losing what {@link curatedModelFields} does not read.
 *
 * Every function here is a pure transform over `ModelDraftEntry[]`. The
 * terminal loop that turns keystrokes into calls on these lives in
 * `route-editor.ts`; nothing here pushes an overlay or calls a seam.
 * @module dshline/connect/model-editor
 */

import type { LlmDiscoveredModelRead } from './harness.ts'
import { curatedModelFields, mergeModelEntry } from './pi-ai.ts'

/** One model row in a draft being edited. */
export interface ModelDraftEntry {
  readonly id: string
  readonly name: string | undefined
  readonly contextWindow: number | undefined
  readonly maxTokens: number | undefined
  /** The entry's previous raw shape, so an unrendered field survives a write. */
  readonly retained: Record<string, unknown> | undefined
  /** Whether this entry is part of the set that would be written. */
  readonly included: boolean
}

/**
 * Build a draft from a route's raw `models` array.
 * @param raw - the profile's stored entries, or undefined when it inherits.
 * @returns one entry per usable raw item, all included.
 */
export function entriesFromRaw(raw: readonly unknown[] | undefined): ModelDraftEntry[] {
  if (raw === undefined) return []
  const entries: ModelDraftEntry[] = []
  for (const item of raw) {
    const curated = curatedModelFields(item)
    if (curated === undefined) continue
    entries.push({ ...curated, retained: item as Record<string, unknown>, included: true })
  }
  return entries
}

/**
 * Fold discovery candidates into a draft, without touching an id already there.
 *
 * A candidate whose id the draft already knows is dropped rather than merged:
 * the draft's own fields — possibly hand-corrected — are the more trustworthy
 * source for that id, and an endpoint listing seldom reports more than an id
 * anyway. A new id is added unchecked, so adopting it is still a deliberate
 * toggle rather than something this call did on the reader's behalf.
 * @param entries - the draft before the fetch.
 * @param candidates - what the endpoint reported.
 * @returns the draft with unseen candidates appended, unincluded.
 */
export function addCandidates(
  entries: readonly ModelDraftEntry[],
  candidates: readonly LlmDiscoveredModelRead[],
): ModelDraftEntry[] {
  const known = new Set(entries.map(entry => entry.id))
  const added: ModelDraftEntry[] = []
  for (const candidate of candidates) {
    if (known.has(candidate.id)) continue
    known.add(candidate.id)
    added.push({
      id: candidate.id,
      name: candidate.name,
      contextWindow: candidate.contextWindow,
      maxTokens: candidate.maxTokens,
      retained: undefined,
      included: false,
    })
  }
  return [...entries, ...added]
}

/**
 * Flip one entry's inclusion.
 * @param entries - the draft.
 * @param id - the entry to toggle.
 * @returns the draft with that entry's `included` flipped.
 */
export function toggleIncluded(entries: readonly ModelDraftEntry[], id: string): ModelDraftEntry[] {
  return entries.map(entry => entry.id === id ? { ...entry, included: !entry.included } : entry)
}

/** Fields a hand-typed or hand-edited model row carries. */
export interface ModelFieldInput {
  readonly id: string
  readonly name: string | undefined
  readonly contextWindow: number | undefined
  readonly maxTokens: number | undefined
}

/** What adding or editing one entry produced. */
export type ModelEditResult =
  | { readonly ok: true; readonly entries: ModelDraftEntry[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Add a hand-typed model, refusing a duplicate id before it reaches settings.
 * @param entries - the draft.
 * @param fields - the typed fields.
 * @returns the draft with the new entry appended and included, or the refusal.
 */
export function addManual(entries: readonly ModelDraftEntry[], fields: ModelFieldInput): ModelEditResult {
  const id = fields.id.trim()
  if (id === '') return { ok: false, reason: 'a model id is required' }
  if (entries.some(entry => entry.id === id)) return { ok: false, reason: `"${id}" is already in the list` }
  return {
    ok: true,
    entries: [...entries, { ...fields, id, retained: undefined, included: true }],
  }
}

/**
 * Replace one entry's curated fields, keeping its id, inclusion, and retained shape.
 * @param entries - the draft.
 * @param id - the entry being edited.
 * @param fields - the new curated values.
 * @returns the draft with that entry updated.
 */
export function updateFields(
  entries: readonly ModelDraftEntry[],
  id: string,
  fields: Omit<ModelFieldInput, 'id'>,
): ModelDraftEntry[] {
  return entries.map(entry => entry.id === id ? { ...entry, ...fields } : entry)
}

/**
 * Drop one entry from the draft entirely.
 * @param entries - the draft.
 * @param id - the entry to remove.
 * @returns the draft without it.
 */
export function removeEntry(entries: readonly ModelDraftEntry[], id: string): ModelDraftEntry[] {
  return entries.filter(entry => entry.id !== id)
}

/**
 * Parse an optional capacity field: blank means absent, anything else must be
 * a positive whole number.
 * @param raw - the typed text, or undefined when the field was not answered.
 * @returns the parsed count, or the refusal reason.
 */
export function parseCapacity(raw: string | undefined): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return { ok: true, value: undefined }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) return { ok: false, reason: 'must be a positive whole number' }
  return { ok: true, value }
}

/**
 * The entries that would actually be written.
 * @param entries - the draft.
 * @returns the included entries, in draft order.
 */
export function includedEntries(entries: readonly ModelDraftEntry[]): readonly ModelDraftEntry[] {
  return entries.filter(entry => entry.included)
}

/**
 * The draft's included entries as JSON-compatible rows, unknown fields intact.
 * @param entries - the draft.
 * @returns one record per included entry, ready for a `set` op.
 */
export function toRawEntries(entries: readonly ModelDraftEntry[]): Record<string, unknown>[] {
  return includedEntries(entries).map(entry => mergeModelEntry(entry.retained, entry))
}

/**
 * Whether two drafts would write the same models, order aside.
 *
 * Compared as written rows rather than as entry objects, so an entry whose
 * `retained` carries the same values two different ways (or not at all,
 * because a manual entry has none) still compares equal when the read is what
 * matters. Order does not matter to what a route serves, so a fetch that
 * re-adds entries in a different order is not reported as a change.
 * @param left - one draft.
 * @param right - the other draft.
 * @returns true when their written rows carry the same fields, regardless of order.
 */
export function sameModelSet(left: readonly ModelDraftEntry[], right: readonly ModelDraftEntry[]): boolean {
  const a = toRawEntries(left)
  const b = toRawEntries(right)
  if (a.length !== b.length) return false
  const sortedA = [...a].sort((x, y) => String(x.id).localeCompare(String(y.id)))
  const sortedB = [...b].sort((x, y) => String(x.id).localeCompare(String(y.id)))
  return JSON.stringify(sortedA) === JSON.stringify(sortedB)
}

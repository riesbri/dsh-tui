/**
 * A route's request headers as a draft: pure edits, no Harness, no rendering.
 *
 * A pi-ai route's `headers` field is a plain `Record<string, string>` sent with
 * every request that route makes — how a gateway that authenticates with
 * something other than an API key, or a deployment that must tag its traffic,
 * is reached at all. This module is what an editor does to that map in memory
 * before it is ever written: add one, change a value, remove one, and turn the
 * survivors back into the JSON-compatible object `settings.mutate` takes.
 *
 * A draft is an ordered array rather than an object because the terminal
 * renders rows in a stable order and a reader who adds three headers should
 * see them where they put them. The order is a presentation fact only; the
 * written value is an object, and nothing downstream depends on its key order.
 *
 * Validity is decided by the same standard the owning adapter validates
 * against. `PiAiProviderProfile.headers` is documented as "validated against
 * Fetch when the profile resolves", so a candidate name or value is checked
 * here by handing it to the platform `Headers` constructor — the WHATWG
 * definition both sides already refer to, not a regular expression this
 * frontend invented and would have to keep in step. Harness stays the
 * authority: a check that passes here can still be refused by
 * `settings.mutate`, and that refusal is what the reader is shown. What this
 * check buys is that an obviously impossible header is named at the prompt
 * that typed it, rather than after a save that looked like it worked.
 *
 * HTTP field names are case-insensitive, so `X-Key` and `x-key` are one
 * header. They would survive as two distinct keys in a JSON object and then
 * collapse unpredictably at the wire, so a second spelling of a name the draft
 * already carries is refused rather than stored.
 *
 * Every function here is a pure transform over `HeaderDraftEntry[]`. The
 * terminal loop that turns keystrokes into calls on these lives in
 * `route-editor.ts`; nothing here pushes an overlay or calls a seam.
 * @module dshline/connect/header-editor
 */

/** One request header in a draft being edited. */
export interface HeaderDraftEntry {
  /** The field name, exactly as the reader spelled it. */
  readonly name: string
  /** The field value. */
  readonly value: string
}

/**
 * Build a draft from a route's stored `headers` object.
 *
 * A non-string value is skipped rather than coerced: the schema types this
 * field as a dict of strings, so anything else in a hand-edited
 * `settings.yaml` is something this editor did not write and must not claim
 * to represent. Skipping it also keeps it from being silently rewritten,
 * because an unchanged draft writes nothing at all.
 * @param raw - the profile's stored `headers` value, whatever shape it is.
 * @returns one entry per usable pair, in the object's own key order.
 */
export function entriesFromRawHeaders(raw: unknown): HeaderDraftEntry[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const entries: HeaderDraftEntry[] = []
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') entries.push({ name, value })
  }
  return entries
}

/**
 * Turn a draft back into the object a settings op writes.
 *
 * Built with `Object.fromEntries` rather than by assigning in a loop, because
 * `raw[name] = value` runs through a setter when `name` is `__proto__` and
 * quietly stores nothing. That is a legal HTTP field name — the token grammar
 * allows `_`, and the platform `Headers` this module defers to accepts it — so
 * a reader could add one, watch the draft show it, save, be told the route was
 * updated, and find the header absent. Nothing is exploitable there, since a
 * string value leaves the prototype untouched; but a write that silently drops
 * what the editor displayed is the one thing this surface must not do.
 * `fromEntries` defines an own property instead, which round-trips back through
 * {@link entriesFromRawHeaders} and through `JSON` intact.
 * @param entries - the draft as it stands.
 * @returns the JSON-compatible header map, in draft order.
 */
export function toRawHeaders(entries: readonly HeaderDraftEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map(entry => [entry.name, entry.value]))
}

/**
 * Whether two drafts would write the same headers.
 *
 * Order is deliberately not compared: it is a presentation fact this module
 * keeps for the reader's benefit, and treating a reordering as a change would
 * make the editor report an edit nobody made.
 * @param left - one draft.
 * @param right - the other.
 * @returns true when both carry the same names with the same values.
 */
export function sameHeaderSet(
  left: readonly HeaderDraftEntry[],
  right: readonly HeaderDraftEntry[],
): boolean {
  if (left.length !== right.length) return false
  const other = new Map(right.map(entry => [entry.name, entry.value]))
  return left.every(entry => other.get(entry.name) === entry.value)
}

/**
 * Why a typed header name cannot be used, when it cannot.
 * @param name - the name as typed, untrimmed.
 * @param taken - names already in the draft, for the case-insensitive check;
 *   pass the name being renamed's own spelling out of this set so re-typing it
 *   unchanged is not read as a collision.
 * @returns the reason, already worded for a reader, or undefined when usable.
 */
export function headerNameProblem(name: string, taken: readonly string[]): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return 'a header needs a name'
  const folded = trimmed.toLowerCase()
  if (taken.some(existing => existing.toLowerCase() === folded)) {
    return `this route already sets ${trimmed}`
  }
  if (!acceptedByFetch(trimmed, 'probe')) return 'that is not a usable HTTP header name'
  return undefined
}

/**
 * Why a typed header value cannot be used, when it cannot.
 * @param value - the value as typed.
 * @returns the reason, already worded for a reader, or undefined when usable.
 */
export function headerValueProblem(value: string): string | undefined {
  if (!acceptedByFetch('x-dshline-probe', value)) {
    return 'that value contains characters no HTTP header can carry'
  }
  return undefined
}

/**
 * Whether the platform's own `Headers` accepts one name/value pair.
 *
 * The whole check is the constructor's throw: WHATWG defines the grammar, the
 * runtime implements it, and the owning adapter validates the same way when
 * the profile resolves. Nothing here inspects the exception — the caller has
 * better words for a reader than a `TypeError`'s message.
 * @param name - the candidate field name.
 * @param value - the candidate field value.
 * @returns true when the pair is a legal HTTP header.
 */
function acceptedByFetch(name: string, value: string): boolean {
  try {
    new Headers({ [name]: value })
    return true
  } catch {
    return false
  }
}

/**
 * Add a header, or replace the value of one already in the draft.
 *
 * Replacement keeps the entry's position, so changing a value does not move
 * the row a reader is looking at. The stored name keeps its ORIGINAL spelling
 * on a replacement: the two spellings are the same header, and rewriting the
 * key would be an edit nobody asked for.
 * @param entries - the draft before the change.
 * @param name - the header's name, already checked by {@link headerNameProblem}.
 * @param value - the header's value, already checked by {@link headerValueProblem}.
 * @returns the draft with the header set.
 */
export function upsertHeader(
  entries: readonly HeaderDraftEntry[],
  name: string,
  value: string,
): HeaderDraftEntry[] {
  const folded = name.toLowerCase()
  const index = entries.findIndex(entry => entry.name.toLowerCase() === folded)
  if (index === -1) return [...entries, { name, value }]
  return entries.map((entry, at) => at === index ? { name: entry.name, value } : entry)
}

/**
 * Remove one header from the draft.
 * @param entries - the draft before the change.
 * @param name - the name to remove, matched case-insensitively.
 * @returns the draft without it.
 */
export function removeHeader(
  entries: readonly HeaderDraftEntry[],
  name: string,
): HeaderDraftEntry[] {
  const folded = name.toLowerCase()
  return entries.filter(entry => entry.name.toLowerCase() !== folded)
}

/**
 * Reading and narrowly editing one preset's `agent.cordis.yml` text.
 *
 * The dialect is Harness's entry-list YAML: a top-level list of
 * `{ id, name, config?, group?, disabled? }` rows (`EntryOptions`, from
 * `@deepseek-ai/cordis-plugin-loader`), where a `group: true` row's `config`
 * is itself a nested list of rows — `delegation > tool-subagent-codex` is one
 * row inside another row's `config`, not a flat entry. `disabled` is not only
 * boolean: the same dialect tags a scalar `!!js <expression>` (`tag:yaml.org,
 * 2002:js` in `vendor/include`'s `entryListSchema`), evaluated by the Loader
 * against its own running context at composition time. This module NEVER
 * evaluates that expression — doing so here would run untrusted host-specific
 * logic (`process.platform === 'win32'`, and worse is possible) inside a
 * terminal frontend that has no business deciding what it means. A row whose
 * `disabled` is a `!!js` node is modeled as `'conditional'` and its raw
 * expression text is carried through for display only.
 *
 * The mutation this module offers — {@link toggleDisabled} — is narrow on
 * purpose: it locates one row by its full id ancestry (not a bare id, which
 * the dialect does not guarantee unique across nested groups) using `yaml`'s
 * `Document` AST, refuses outright if that row's CURRENT `disabled` is a
 * `!!js` node (overwriting a conditional with a plain boolean would silently
 * discard host-specific behavior an operator wrote on purpose — proven by a
 * concrete repro: naively `setIn`-ing over a `!!js` scalar serializes as
 * `disabled: !!js undefined`, a corrupt expression the Loader would then
 * evaluate), and otherwise edits only that one field — `setIn` to disable,
 * `deleteIn` to enable, mirroring the shipped presets' own convention of
 * shipping some tool rows `disabled: true` with a comment telling the reader
 * to "remove `disabled` from the matching tool row" to turn them on. Every
 * other line, including comments, keeps its exact source formatting: `yaml`'s
 * `Document` is a CST-backed AST, not a parse-then-reserialize round trip.
 * @module dshline/plugins/composition
 */

import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, ScalarTag, YAMLMap, YAMLSeq } from 'yaml'

/** The Loader's own tag for a `!!js` conditional scalar. */
const CONDITIONAL_TAG = 'tag:yaml.org,2002:js'

/** Recognizes the conditional tag without ever evaluating what it carries. */
const conditionalTag: ScalarTag = {
  identify: (value: unknown): boolean =>
    typeof value === 'object' && value !== null && '__jsExpr' in (value as Record<string, unknown>),
  tag: CONDITIONAL_TAG,
  resolve: (source: string): { __jsExpr: string } => ({ __jsExpr: source }),
  stringify: (item): string => {
    const value = (item as { value?: unknown }).value
    return typeof value === 'object' && value !== null && '__jsExpr' in value
      ? String((value as { __jsExpr: unknown }).__jsExpr)
      : String(value)
  },
}

/** One row's own `disabled` field, modeled honestly instead of coerced to boolean. */
export type DisabledState =
  /** No `disabled` field, or an explicit falsy one. */
  | { readonly kind: 'enabled' }
  /** `disabled: true` (or another truthy plain value). */
  | { readonly kind: 'disabled' }
  /** `disabled: !!js <expression>` — the Loader decides this, not dshline. */
  | { readonly kind: 'conditional'; readonly expression: string }

/** Whether a row runs, once its own field and its ancestors' are combined. */
export type EffectiveState = 'enabled' | 'disabled' | 'conditional'

/** One row of a preset's composition, at whatever depth it was found. */
export interface CompositionRow {
  /** Ids from the root row down to and including this one. */
  readonly idPath: readonly string[]
  /** This row's own id. */
  readonly id: string
  /** Module specifier the row loads. */
  readonly name: string
  /** Nesting depth; `0` for a top-level row. */
  readonly depth: number
  /** Whether this row is a nested group (its `config` holds child rows). */
  readonly group: boolean
  /** This row's own `disabled` field, before any ancestor is considered. */
  readonly disabled: DisabledState
  /**
   * Whether the row actually runs, per the Loader's own inheritance rule: a
   * group's OWN row is always `'enabled'` here (a group container always
   * runs so its children can be evaluated — the Loader's `Entry._disabled`
   * returns `false` unconditionally for a group), but a group's `disabled`
   * field still governs every row nested under it, which is what makes a
   * leaf's `effective` here possibly `'disabled'` or `'conditional'` even
   * when its own {@link disabled} is `'enabled'`.
   */
  readonly effective: EffectiveState
  /**
   * A short, obvious summary of `config`, when it is worth showing: a plain
   * scalar, or a small object of plain scalars. Never computed for a group
   * row (its `config` is the child list) and omitted rather than guessed
   * whenever a value is not plainly summarizable.
   */
  readonly configSummary?: string
}

/** What one parse of a composition file produced. */
export type CompositionTree =
  /** Parsed and structurally valid: a top-level list of entry rows. */
  | { readonly kind: 'parsed'; readonly rows: readonly CompositionRow[] }
  /** The text could not be read as an entry list; the reason is Harness's own. */
  | { readonly kind: 'broken'; readonly reason: string }

/**
 * Parse one preset's composition text into a flat, pre-order row list.
 *
 * Never throws: a file this dialect cannot make sense of is reported as
 * {@link CompositionTree} `'broken'`, the same posture Harness's own
 * discovery takes toward an unparsable or malformed composition.
 * @param text - the composition file's raw text, as `read(id)` returns it.
 * @returns the flattened rows, or why none could be read.
 */
export function parseComposition(text: string): CompositionTree {
  try {
    const doc = parseDocument(text, { customTags: [conditionalTag] })
    if (doc.errors.length > 0) {
      return { kind: 'broken', reason: doc.errors[0]?.message ?? 'composition did not parse as YAML' }
    }
    const top = doc.contents
    if (!isSeq(top)) return { kind: 'broken', reason: 'composition is not a list of entries' }
    const rows: CompositionRow[] = []
    const problem = walk(top, [], 0, 'enabled', rows)
    if (problem !== undefined) return { kind: 'broken', reason: problem }
    return { kind: 'parsed', rows }
  } catch (error) {
    return { kind: 'broken', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Walk one entry list, flattening rows in pre-order and threading the
 * ancestor block state each row's `effective` state is combined with.
 * @param seq - the entry list at this level.
 * @param parentIdPath - id ancestry above this level.
 * @param depth - nesting depth of this level.
 * @param ancestorBlock - the combined state every ancestor group contributes.
 * @param out - accumulator every row is pushed onto, in document order.
 * @returns a problem description, or undefined once the whole level is read.
 */
function walk(
  seq: YAMLSeq,
  parentIdPath: readonly string[],
  depth: number,
  ancestorBlock: EffectiveState,
  out: CompositionRow[],
): string | undefined {
  for (const item of seq.items) {
    if (!isMap(item)) return 'an entry is not a mapping'
    const id = item.get('id')
    const name = item.get('name')
    if (typeof id !== 'string' || id === '') return 'an entry is missing a string id'
    if (typeof name !== 'string' || name === '') return `entry ${id} is missing a string name`
    const group = item.get('group') === true
    const disabled = readDisabled(item)
    const idPath = [...parentIdPath, id]
    const effective: EffectiveState = group ? 'enabled' : combine(ancestorBlock, disabled)
    const configSummary = group ? undefined : summarizeConfig(item.get('config'))
    out.push({
      idPath,
      id,
      name,
      depth,
      group,
      disabled,
      effective,
      ...(configSummary !== undefined ? { configSummary } : {}),
    })
    if (group) {
      const config: unknown = item.get('config')
      if (!isSeq(config)) return `group ${id} has no nested entry list`
      const problem = walk(config, idPath, depth + 1, combine(ancestorBlock, disabled), out)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}

/**
 * Read one row's own `disabled` field without resolving a `!!js` node's
 * meaning — only its tag and its raw expression text.
 * @param row - the row's mapping node.
 * @returns the row's own disabled state.
 */
function readDisabled(row: YAMLMap): DisabledState {
  const node = row.get('disabled', true)
  if (node === undefined) return { kind: 'enabled' }
  const value = isScalar(node) ? node.value : node
  if (isJsExpr(value)) return { kind: 'conditional', expression: value.__jsExpr }
  return { kind: Boolean(value) ? 'disabled' : 'enabled' }
}

/**
 * Combine an ancestor's accumulated state with one more field, most-blocking
 * value winning — a literal `disabled` anywhere outranks an unresolved
 * conditional, which outranks enabled.
 * @param ancestor - the state contributed by everything above this row.
 * @param own - this row's own disabled state.
 * @returns the combined state.
 */
function combine(ancestor: EffectiveState, own: DisabledState): EffectiveState {
  if (ancestor === 'disabled' || own.kind === 'disabled') return 'disabled'
  if (ancestor === 'conditional' || own.kind === 'conditional') return 'conditional'
  return 'enabled'
}

/**
 * A short, obvious summary of a leaf row's `config`, or undefined when
 * nothing plain enough is there to show.
 * @param config - the resolved `config` value, when the row has one.
 * @returns the summary text, or undefined.
 */
function summarizeConfig(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  // `get()` auto-unwraps a Scalar to its value but leaves a Map/Seq as its AST
  // node; `.toJSON()` is that node's own plain-JS projection (recursive, and
  // it runs our custom tag's `resolve` output through unchanged since that is
  // already plain data), never a re-parse of the source text.
  const config = typeof raw === 'object' && hasToJSON(raw) ? raw.toJSON() : raw
  if (isJsExpr(config)) return undefined
  if (isPlainScalar(config)) return String(config)
  if (isPlainObject(config)) {
    const entries = Object.entries(config)
    if (entries.length === 0 || entries.length > 3) return undefined
    if (entries.some(([, value]) => !isPlainScalar(value))) return undefined
    return entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')
  }
  return undefined
}

function hasToJSON(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function'
}

/** Whether a value is a `!!js` conditional, once resolved. */
function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return typeof value === 'object' && value !== null && '__jsExpr' in (value as Record<string, unknown>)
}

function isPlainScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsExpr(value)
}

/** Why {@link toggleDisabled} could not apply the requested change. */
export type ToggleFailureReason =
  /** The composition text does not parse as an entry list at all. */
  | 'broken'
  /** No row at that id ancestry exists in this text. */
  | 'not-found'
  /**
   * The row's current `disabled` is a `!!js` expression: toggling here would
   * silently discard host-specific behavior an operator wrote on purpose.
   */
  | 'conditional'

/** The result of attempting one narrow `disabled` edit. */
export type ToggleResult =
  /** The edit applied; `text` is the whole file with only that field changed. */
  | { readonly ok: true; readonly text: string }
  /** The edit was refused or the row could not be found. */
  | { readonly ok: false; readonly reason: ToggleFailureReason; readonly message: string }

/**
 * Enable or disable exactly one row, addressed by its full id ancestry.
 *
 * Re-parses `text` itself rather than trusting a path captured from an
 * earlier read, so a row moved or removed by an edit made elsewhere is
 * reported as `'not-found'` instead of silently mutating the wrong node.
 * @param text - the composition file's current text.
 * @param idPath - ids from the root row down to the target, as
 * {@link CompositionRow.idPath} reports it.
 * @param enable - `true` to enable the row, `false` to disable it.
 * @returns the new text, or why the edit was refused.
 */
export function toggleDisabled(text: string, idPath: readonly string[], enable: boolean): ToggleResult {
  if (idPath.length === 0) return { ok: false, reason: 'not-found', message: 'no row addressed' }
  let doc: Document
  try {
    doc = parseDocument(text, { customTags: [conditionalTag] })
  } catch (error) {
    return { ok: false, reason: 'broken', message: error instanceof Error ? error.message : String(error) }
  }
  if (doc.errors.length > 0) {
    return { ok: false, reason: 'broken', message: doc.errors[0]?.message ?? 'composition did not parse as YAML' }
  }
  const located = locate(doc.contents, idPath)
  if (located === undefined) {
    return { ok: false, reason: 'not-found', message: `no row at ${idPath.join(' > ')}` }
  }
  const { row, astPath } = located
  const current = readDisabled(row)
  if (current.kind === 'conditional') {
    return {
      ok: false,
      reason: 'conditional',
      message: `${idPath.join(' > ')} is disabled by a condition (${current.expression}), not a plain toggle`,
    }
  }
  if (enable) doc.deleteIn(astPath)
  else doc.setIn(astPath, true)
  // `lineWidth: 0` disables re-wrapping: the default 80-column fold would
  // otherwise reflow every long block scalar in the WHOLE file on every
  // toggle, not just the one field this function touches.
  return { ok: true, text: doc.toString({ lineWidth: 0 }) }
}

/**
 * Find one row's mapping node and the AST path to its `disabled` field.
 * @param top - the document's top-level entry list.
 * @param idPath - ids from the root down to the target row.
 * @returns the row's mapping node and the path to address, or undefined.
 */
function locate(
  top: unknown,
  idPath: readonly string[],
): { readonly row: YAMLMap; readonly astPath: (string | number)[] } | undefined {
  if (!isSeq(top)) return undefined
  let seq: YAMLSeq = top
  let astPath: (string | number)[] = []
  for (let level = 0; level < idPath.length; level += 1) {
    const wantedId = idPath[level]
    const index = seq.items.findIndex(item => isMap(item) && item.get('id') === wantedId)
    if (index === -1) return undefined
    const row = seq.items[index]
    if (!isMap(row)) return undefined
    astPath = [...astPath, index]
    if (level === idPath.length - 1) return { row, astPath: [...astPath, 'disabled'] }
    const config: unknown = row.get('config')
    if (!isSeq(config)) return undefined
    seq = config
    astPath = [...astPath, 'config']
  }
  return undefined
}

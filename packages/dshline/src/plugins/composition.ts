/**
 * Reading and narrowly editing one preset's `agent.cordis.yml` text.
 *
 * The dialect is Harness's entry-list YAML: a top-level list of plugin rows
 * (`EntryOptions`, from `@deepseek-ai/cordis-plugin-loader`), where a
 * `group: true` row's `config` is itself a nested list of rows —
 * `delegation > tool-subagent-codex` is one row inside another row's
 * `config`, not a flat entry. The ONLY thing Harness's own discovery
 * validator (`entryListProblem` in `packages/preset/agent-presets/src/
 * discovery.ts`) requires of a row is a non-empty `name`; `id` is not part of
 * the minimum-valid shape — the Loader assigns a random one at mount time
 * when a row omits it (`config/tree.ts`'s `Math.random().toString(16)...`).
 * This parser follows that same shallow acceptance rather than a stricter one
 * of its own: an id-less row is valid input here, exactly as it is to
 * Harness, and is displayed and addressed by its `name` and structural
 * position instead.
 *
 * `disabled` is not only boolean: the same dialect tags a scalar
 * `!!js <expression>` (`tag:yaml.org,2002:js` in `vendor/include`'s
 * `entryListSchema`), evaluated by the Loader against its own running
 * context at composition time. This module NEVER evaluates that expression —
 * doing so here would run untrusted host-specific logic
 * (`process.platform === 'win32'`, and worse is possible) inside a terminal
 * frontend that has no business deciding what it means. A row whose
 * `disabled` is a `!!js` node is modeled as `'conditional'` and its raw
 * expression text is carried through for display only.
 *
 * The mutation this module offers — {@link toggleDisabled} — is narrow on
 * purpose. Because `id` is optional and not guaranteed unique even where
 * present (Harness's own validator never checks uniqueness), a row is
 * addressed by a {@link RowLocator}: its structural position (a sequence
 * index at each nesting level) PLUS the name — and id, when the file had one
 * — expected at that position. Re-locating re-parses `text` fresh and
 * verifies every step's fingerprint still matches before touching anything,
 * so a file changed elsewhere between read and write is refused rather than
 * silently mutating whatever now happens to sit at that position. Once
 * located, and only when the row's CURRENT `disabled` is not a `!!js` node
 * (overwriting one would silently discard host-specific behavior an operator
 * wrote on purpose — proven by a concrete repro: naively `setIn`-ing over a
 * `!!js` scalar serializes as `disabled: !!js undefined`, a corrupt
 * expression the Loader would then evaluate), exactly one field is edited —
 * `setIn` to disable, `deleteIn` to enable, mirroring the shipped presets'
 * own convention of shipping some tool rows `disabled: true` with a comment
 * telling the reader to "remove `disabled` from the matching tool row" to
 * turn them on. A request that changes nothing (the row is already in the
 * requested state) returns the INPUT text verbatim rather than re-serializing
 * at all, which is the only byte-identical guarantee this module makes
 * outright; a genuine edit is scoped to that one field via `yaml`'s
 * `Document` AST, but a full byte-for-byte guarantee on every unrelated line
 * is a claim only the tests below back, not a property asserted in general —
 * see `plugins-composition.spec.ts`'s regression fixture for what is
 * actually verified against a real shipped preset.
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

/**
 * One step of a {@link RowLocator}: a row's position within its containing
 * list, and the fingerprint expected there. `name` is always checked (it is
 * the one field Harness itself requires); `id` is checked only when the row
 * had one, since its absence here does not mean a re-read file may not have
 * since grown one — only that this locator does not know to expect it.
 */
export interface RowLocatorStep {
  /** Index within the immediately containing entry list. */
  readonly index: number
  /** The name expected at that position. */
  readonly name: string
  /** The id expected at that position, when this row had one. */
  readonly id: string | undefined
}

/** How to safely re-find one row after re-parsing the file fresh. */
export interface RowLocator {
  /** Steps from the top-level list down to and including the target row. */
  readonly steps: readonly RowLocatorStep[]
}

/** One row of a preset's composition, at whatever depth it was found. */
export interface CompositionRow {
  /** How to safely re-find this exact row after a fresh re-parse. */
  readonly locator: RowLocator
  /**
   * Display breadcrumb from the root row down to and including this one —
   * each ancestor's `id`, falling back to its `name` when it has none.
   */
  readonly path: readonly string[]
  /** This row's own id, when the file gives it one. */
  readonly id: string | undefined
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
   * scalar, or a small object of plain scalars, whitespace-normalized and
   * capped to {@link MAX_SUMMARY_LENGTH} characters. Never computed for a
   * group row (its `config` is the child list) and omitted rather than
   * guessed whenever a value is not plainly summarizable — this keeps a
   * multi-kilobyte persona or system-prompt `config` from ever landing in a
   * row's detail line.
   */
  readonly configSummary?: string
  /**
   * This row's `config.provider`, when it declares one as a plain string.
   *
   * Read structurally and named after the FIELD, not after any meaning: this
   * module is a parser and does not know which registry a given row resolves a
   * provider from, or whether it resolves one at all. `health.ts` owns that
   * judgement, and only for module names it can prove the link for. Kept
   * separate from {@link configSummary}, which is display text and may be
   * absent (a large config is deliberately not summarized) while this is
   * present.
   */
  readonly configProvider?: string
  /**
   * The external server this row declares it connects to, read structurally
   * from `config.serverName` and `config.transport`.
   *
   * Named after the fields, like {@link configProvider}. It says what the file
   * declares and nothing more: not that the server exists, is reachable, or is
   * connected. Kept separate from {@link configSummary} because a config of
   * this shape is never summarised — it carries more than three keys and nested
   * values that are deliberately left out of a row's detail line.
   */
  readonly configServer?: { readonly name?: string; readonly transport?: string }
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
 * discovery takes toward an unparsable or malformed composition — and, by
 * design, no MORE strict than that posture: a row this parser cannot make
 * complete sense of but Harness's own validator accepts (an id-less row,
 * chiefly) is parsed, not rejected. This function is presentation and
 * mutation support for Harness-valid files; it does not independently decide
 * a preset's health — see `catalog.ts`, which treats the roster's own
 * `AgentPresetRow.broken` as authoritative over whatever this parser thinks.
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
    const problem = walk(top, [], [], 0, 'enabled', rows)
    if (problem !== undefined) return { kind: 'broken', reason: problem }
    return { kind: 'parsed', rows }
  } catch (error) {
    return { kind: 'broken', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Walk one entry list, flattening rows in pre-order and threading both the
 * display path and the locator steps down through nested groups.
 * @param seq - the entry list at this level.
 * @param parentPath - display breadcrumb above this level.
 * @param parentSteps - locator steps above this level.
 * @param depth - nesting depth of this level.
 * @param ancestorBlock - the combined state every ancestor group contributes.
 * @param out - accumulator every row is pushed onto, in document order.
 * @returns a problem description, or undefined once the whole level is read.
 */
function walk(
  seq: YAMLSeq,
  parentPath: readonly string[],
  parentSteps: readonly RowLocatorStep[],
  depth: number,
  ancestorBlock: EffectiveState,
  out: CompositionRow[],
): string | undefined {
  for (const [index, item] of seq.items.entries()) {
    // Matches `entryListProblem` exactly: a row is valid iff it is a mapping
    // naming a non-empty `name`. `id` is read when present but never required.
    if (!isMap(item)) return `row ${String(index + 1)} is not a plugin row (expected a map with a "name")`
    const name = item.get('name')
    if (typeof name !== 'string' || name === '') {
      return `row ${String(index + 1)} names no plugin (a "name" string is required)`
    }
    const idValue = item.get('id')
    const id = typeof idValue === 'string' && idValue !== '' ? idValue : undefined
    const group = item.get('group') === true
    const disabled = readDisabled(item)
    const step: RowLocatorStep = { index, name, id }
    const steps = [...parentSteps, step]
    const path = [...parentPath, id ?? name]
    const effective: EffectiveState = group ? 'enabled' : combine(ancestorBlock, disabled)
    const configSummary = group ? undefined : summarizeConfig(item.get('config'))
    const configProvider = group ? undefined : readConfigProvider(item.get('config', true))
    const configServer = group ? undefined : readConfigServer(item.get('config', true))
    out.push({
      locator: { steps },
      path,
      id,
      name,
      depth,
      group,
      disabled,
      effective,
      ...(configSummary !== undefined ? { configSummary } : {}),
      ...(configProvider !== undefined ? { configProvider } : {}),
      ...(configServer !== undefined ? { configServer } : {}),
    })
    if (group) {
      const config: unknown = item.get('config')
      if (!isSeq(config)) return `group ${path.join(' > ')} must hold a list of plugin rows`
      const problem = walk(config, path, steps, depth + 1, combine(ancestorBlock, disabled), out)
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
 * A row's `config.provider`, when it is a plain non-empty string.
 *
 * A `!!js` provider expression is deliberately NOT read: this module never
 * evaluates one, so there is no name to check a registry against and claiming
 * otherwise would be a guess. A non-string value is a malformed config the
 * Loader will complain about far more usefully than a browser could.
 * @param node - the row's `config` node, unresolved.
 * @returns the provider name, or undefined when the row names none plainly.
 */
function readConfigProvider(node: unknown): string | undefined {
  return readPlainString(node, 'provider')
}

/**
 * A row's `config.serverName` and `config.transport`, when plainly declared.
 *
 * Named after the FIELDS, exactly as {@link readConfigProvider} is, and read
 * for any row that declares them rather than for one module this parser would
 * have to recognise. A row that connects to an external server takes its
 * identity from which server that is: two rows loading the same module differ
 * only here, and {@link summarizeConfig} shows nothing for either, because such
 * a config carries more than three keys and nested values (a command, an
 * argument list, an environment) that are deliberately not summarised.
 *
 * This claims nothing about whether the server exists, is reachable, or
 * connected. It reports what the composition file says, which is the only thing
 * a parser can honestly report.
 * @param node - the row's `config` node, unresolved.
 * @returns the declared server name and transport, when either is present.
 */
function readConfigServer(node: unknown): { name?: string; transport?: string } | undefined {
  const name = readPlainString(node, 'serverName')
  const transport = readPlainString(node, 'transport')
  if (name === undefined && transport === undefined) return undefined
  return { ...name === undefined ? {} : { name }, ...transport === undefined ? {} : { transport } }
}

/**
 * One plainly-declared string field of a row's `config`.
 *
 * A `!!js` expression is deliberately NOT read: this module never evaluates
 * one, so there is no value to report and claiming otherwise would be a guess.
 * A non-string value is a malformed config the Loader will complain about far
 * more usefully than a browser could.
 * @param node - the row's `config` node, unresolved.
 * @param field - the field to read.
 * @returns the string, or undefined when the row declares none plainly.
 */
function readPlainString(node: unknown, field: string): string | undefined {
  if (!isMap(node)) return undefined
  const value = node.get(field)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A config summary never grows past this many characters, whitespace collapsed first. */
const MAX_SUMMARY_LENGTH = 100

/**
 * Collapse whitespace (including newlines) to single spaces and cap length,
 * so a multi-kilobyte prompt block can never reach a row's detail line.
 * @param text - the raw text.
 * @returns the compact, terminal-friendly text.
 */
function compact(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > MAX_SUMMARY_LENGTH
    ? `${normalized.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : normalized
}

/**
 * A short, obvious summary of a leaf row's `config`, or undefined when
 * nothing plain enough is there to show.
 * @param raw - the resolved `config` value, when the row has one.
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
  if (isPlainScalar(config)) return compact(String(config))
  if (isPlainObject(config)) {
    const entries = Object.entries(config)
    if (entries.length === 0 || entries.length > 3) return undefined
    if (entries.some(([, value]) => !isPlainScalar(value))) return undefined
    return compact(entries.map(([key, value]) => `${key}=${String(value)}`).join(', '))
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
  /** The locator's structure (an index, or a group where one is expected) no longer exists. */
  | 'not-found'
  /**
   * A row exists at the located position, but its name (or id, when the
   * locator recorded one) no longer matches: the file changed incompatibly
   * since this locator was built, and mutating that position anyway would
   * risk editing a different row than the one shown.
   */
  | 'changed'
  /**
   * The row's current `disabled` is a `!!js` expression: toggling here would
   * silently discard host-specific behavior an operator wrote on purpose.
   */
  | 'conditional'

/** The result of attempting one narrow `disabled` edit. */
export type ToggleResult =
  /** The edit applied (or nothing needed to change); `text` is the whole file. */
  | { readonly ok: true; readonly text: string }
  /** The edit was refused or the row could not be safely re-found. */
  | { readonly ok: false; readonly reason: ToggleFailureReason; readonly message: string }

/**
 * Enable or disable exactly one row, addressed by its {@link RowLocator}.
 *
 * Re-parses `text` itself rather than trusting a path captured from an
 * earlier read, and re-verifies every step's name (and id, when recorded)
 * before touching anything, so a row moved, renamed, or removed by an edit
 * made elsewhere is refused instead of silently mutating whatever now sits
 * at that position.
 * @param text - the composition file's current text.
 * @param locator - the row's locator, as {@link CompositionRow.locator} reports it.
 * @param enable - `true` to enable the row, `false` to disable it.
 * @returns the new text, or why the edit was refused.
 */
export function toggleDisabled(text: string, locator: RowLocator, enable: boolean): ToggleResult {
  if (locator.steps.length === 0) return { ok: false, reason: 'not-found', message: 'no row addressed' }
  let doc: Document
  try {
    doc = parseDocument(text, { customTags: [conditionalTag] })
  } catch (error) {
    return { ok: false, reason: 'broken', message: error instanceof Error ? error.message : String(error) }
  }
  if (doc.errors.length > 0) {
    return { ok: false, reason: 'broken', message: doc.errors[0]?.message ?? 'composition did not parse as YAML' }
  }
  const label = locator.steps.map(step => step.id ?? step.name).join(' > ')
  const located = locate(doc.contents, locator.steps)
  if (located === undefined) {
    return { ok: false, reason: 'not-found', message: `no row at the expected position for ${label}` }
  }
  if (located === 'changed') {
    return { ok: false, reason: 'changed', message: `the file changed since this was read: ${label} moved or was replaced` }
  }
  const { row, astPath } = located
  const current = readDisabled(row)
  if (current.kind === 'conditional') {
    return {
      ok: false,
      reason: 'conditional',
      message: `${label} is disabled by a condition (${current.expression}), not a plain toggle`,
    }
  }
  const alreadyRequested = (enable && current.kind === 'enabled') || (!enable && current.kind === 'disabled')
  if (alreadyRequested) return { ok: true, text }
  if (enable) doc.deleteIn(astPath)
  else doc.setIn(astPath, true)
  // `lineWidth: 0` disables re-wrapping: the default 80-column fold would
  // otherwise reflow every long block scalar in the WHOLE file on every
  // toggle, not just the one field this function touches.
  return { ok: true, text: doc.toString({ lineWidth: 0 }) }
}

/**
 * Find one row's mapping node and the AST path to its `disabled` field,
 * verifying every step's fingerprint on the way down.
 * @param top - the document's top-level entry list.
 * @param steps - the locator steps from the root to the target row.
 * @returns the row and the path to address; `'changed'` when a step's
 * position exists but its fingerprint no longer matches; undefined when the
 * position itself no longer exists at all.
 */
function locate(
  top: unknown,
  steps: readonly RowLocatorStep[],
): { readonly row: YAMLMap; readonly astPath: (string | number)[] } | 'changed' | undefined {
  if (!isSeq(top)) return undefined
  let seq: YAMLSeq = top
  let astPath: (string | number)[] = []
  for (let level = 0; level < steps.length; level += 1) {
    const step = steps[level]
    if (step === undefined) return undefined
    const item = seq.items[step.index]
    if (item === undefined) return undefined
    if (!isMap(item)) return 'changed'
    const name = item.get('name')
    if (name !== step.name) return 'changed'
    if (step.id !== undefined) {
      const idValue = item.get('id')
      const id = typeof idValue === 'string' && idValue !== '' ? idValue : undefined
      if (id !== step.id) return 'changed'
    }
    astPath = [...astPath, step.index]
    if (level === steps.length - 1) return { row: item, astPath: [...astPath, 'disabled'] }
    const config: unknown = item.get('config')
    if (!isSeq(config)) return 'changed'
    seq = config
    astPath = [...astPath, 'config']
  }
  return undefined
}

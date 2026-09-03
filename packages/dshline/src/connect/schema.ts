/**
 * Finding the credential field of a provider profile, from the schema alone.
 *
 * This is the part of Connect that keeps it provider-neutral. The naive way to
 * offer "set an API key" is to write `apiKeyEnv` into the profile, which is
 * what the field happens to be called in both adapters shipped today — and is
 * exactly the hard-coded provider knowledge this frontend must not hold.
 *
 * Harness already publishes the answer. A settings namespace registers a
 * schemastery schema, and a field that carries a credential REFERENCE is
 * declared `z.string().role('credential-ref')` — `llm-pi-ai`, `llm-deepseek`,
 * and `web-search-deepseek` all mark theirs that way. `ctx.settings.describe()`
 * hands back `schema.toJSON()`, so the role travels with the descriptor and an
 * adapter that calls its field something else is served without a code change.
 *
 * The serialized form is `{ uid, refs }`: every node lives in `refs` under its
 * own uid, and a nested node appears as that uid rather than inline, because
 * schemastery preserves shared and recursive references. So walking it means
 * resolving a number at each step, which is all {@link resolveNode} does.
 * @module dshline/connect/schema
 */

/** A serialized schemastery node, as far as this walk needs to understand one. */
export interface SchemaNode {
  /** Node kind: `object`, `dict`, `array`, `union`, `intersect`, `string`, `const`, … */
  type?: string
  /** UI and validation metadata, including the renderer role. */
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, unknown>
  /** `dict` and `array` element schema. */
  inner?: unknown
  /** `union` and `intersect` members. */
  list?: readonly unknown[]
  /** The one value a `const` node accepts. */
  value?: unknown
}

/** The serialized envelope `schema.toJSON()` produces. */
export interface SchemaEnvelope {
  /** Uid of the root node. */
  uid: number
  /** Every node reachable from the root, keyed by uid. */
  refs: Record<string, unknown>
}

/** The role a settings schema marks a credential-reference field with. */
export const CREDENTIAL_REF_ROLE = 'credential-ref'

/**
 * Whether a value is a plain object this walk may look inside.
 * @param value - the candidate.
 * @returns true when it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the envelope out of a descriptor's `schema`, when it is one.
 * @param schema - the serialized schema from `ctx.settings.describe()`.
 * @returns the envelope, or undefined when the value is not one.
 */
function envelopeOf(schema: unknown): SchemaEnvelope | undefined {
  if (!isRecord(schema)) return undefined
  const { uid, refs } = schema
  if (typeof uid !== 'number' || !isRecord(refs)) return undefined
  return { uid, refs }
}

/**
 * Resolve one node reference against the envelope's table.
 *
 * A reference is a uid, but an envelope produced by another build — or a node
 * a future serializer chooses to inline — may be the node itself, so both are
 * accepted rather than one being assumed.
 * @param reference - a uid, or an inline node.
 * @param envelope - the table every uid is looked up in.
 * @returns the node, or undefined when the reference resolves to nothing.
 */
function resolveNode(reference: unknown, envelope: SchemaEnvelope): SchemaNode | undefined {
  if (typeof reference === 'number') {
    const found = envelope.refs[String(reference)]
    return isRecord(found) ? found : undefined
  }
  return isRecord(reference) ? reference : undefined
}

/**
 * Follow one path segment into a node.
 *
 * A dict or array segment is a concrete key or index that the schema describes
 * with ONE element node, so the segment is consumed by moving to `inner`
 * without being matched against anything — which is what makes
 * `['providers', 'openrouter']` reach a route the schema never names.
 * @param node - the node to descend from.
 * @param segment - the path segment to follow.
 * @param envelope - the table every uid is looked up in.
 * @returns the child node, or undefined when the path leaves the schema.
 */
function descend(node: SchemaNode, segment: string, envelope: SchemaEnvelope): SchemaNode | undefined {
  switch (node.type) {
    case 'object':
      return resolveNode(node.dict?.[segment], envelope)
    case 'dict':
    case 'array':
      return resolveNode(node.inner, envelope)
    case 'union':
    case 'intersect': {
      // A profile described as a union or an intersection has no single child;
      // the first member that can follow the segment answers for all of them.
      for (const member of node.list ?? []) {
        const resolved = resolveNode(member, envelope)
        const next = resolved === undefined ? undefined : descend(resolved, segment, envelope)
        if (next !== undefined) return next
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** One profile's node, kept with the table its children resolve through. */
export interface LocatedProfile {
  /** The profile's own serialized node. */
  readonly node: SchemaNode
  /** The envelope every nested uid is looked up in. */
  readonly envelope: SchemaEnvelope
}

/**
 * The schema node one configurable provider's profile is described by.
 * @param schema - the namespace's serialized schema.
 * @param path - `LlmConfigurableProvider.settingsPath`; empty means the section root.
 * @returns the profile's node and its table, or undefined when the schema does
 *   not describe that path.
 */
export function profileNode(schema: unknown, path: readonly string[]): LocatedProfile | undefined {
  const envelope = envelopeOf(schema)
  if (envelope === undefined) return undefined
  let node = resolveNode(envelope.uid, envelope)
  for (const segment of path) {
    if (node === undefined) return undefined
    node = descend(node, segment, envelope)
  }
  return node === undefined ? undefined : { node, envelope }
}

/**
 * Property names in a profile that carry a credential reference.
 *
 * Plural because nothing stops a schema declaring two; the caller takes the
 * first and Connect says which one it used rather than guessing which of
 * several a person meant. An intersection is flattened, since that is how a
 * schema composes a shared field set with a specific one.
 * @param located - the profile {@link profileNode} found.
 * @returns the property names, in declaration order.
 */
export function credentialRefFields(located: LocatedProfile | undefined): string[] {
  if (located === undefined) return []
  return fieldsIn(located.node, located.envelope, new Set())
}

/**
 * Walk one node for credential-reference properties.
 * @param node - the node to inspect.
 * @param envelope - the table every uid is looked up in.
 * @param seen - uids already visited, so a recursive schema terminates.
 * @returns the property names, in declaration order.
 */
function fieldsIn(node: SchemaNode, envelope: SchemaEnvelope, seen: Set<unknown>): string[] {
  if (node.type === 'object') {
    const found: string[] = []
    for (const [property, reference] of Object.entries(node.dict ?? {})) {
      const child = resolveNode(reference, envelope)
      if (child?.meta?.role === CREDENTIAL_REF_ROLE) found.push(property)
    }
    return found
  }
  if (node.type === 'intersect' || node.type === 'union') {
    const found: string[] = []
    for (const member of node.list ?? []) {
      if (seen.has(member)) continue
      seen.add(member)
      const resolved = resolveNode(member, envelope)
      if (resolved !== undefined) found.push(...fieldsIn(resolved, envelope, seen))
    }
    return found
  }
  return []
}

/**
 * The schema node for one named field of a located profile.
 *
 * The one step {@link profileNode} does not take: a profile's node answers
 * what the WHOLE route looks like, and a caller reading one field — the
 * credential reference is the other case, but it is found by role rather than
 * by name — still needs to descend into it by the field's own name.
 * @param located - the profile {@link profileNode} found.
 * @param field - the property name to descend into.
 * @returns the field's node, or undefined when the schema does not describe it.
 */
export function fieldNode(located: LocatedProfile | undefined, field: string): SchemaNode | undefined {
  if (located === undefined) return undefined
  return descend(located.node, field, located.envelope)
}

/**
 * String choices a `union`-of-`const` node offers, when it is shaped that way.
 *
 * This is how a protocol picker learns its choices without importing anything
 * about the adapter that published them: `z.union(['a', 'b'])` serializes as a
 * `union` node whose `list` members are each a `const` node carrying one
 * string, and that shape is generic schemastery vocabulary, not knowledge of
 * any one namespace. A field the owning schema did not build this way (a plain
 * `z.string()`, say) answers with an empty list, which is this walk's honest
 * way of saying the schema offers no fixed choice — the caller falls back to
 * free text rather than inventing one.
 * @param node - the field's own node, typically found via {@link profileNode}
 *   plus one more {@link descend} step onto the field name.
 * @param envelope - the table every uid is looked up in.
 * @returns the offered strings, in schema order; empty when the node is not a
 *   union of string consts.
 */
export function unionConstStrings(node: SchemaNode | undefined, envelope: SchemaEnvelope): string[] {
  if (node?.type !== 'union') return []
  const found: string[] = []
  for (const member of node.list ?? []) {
    const resolved = resolveNode(member, envelope)
    if (resolved?.type !== 'const') return []
    const value = (resolved as { value?: unknown }).value
    if (typeof value !== 'string') return []
    found.push(value)
  }
  return found
}

/**
 * Whether a node is a `dict` whose elements are plain strings.
 *
 * The companion shape check to {@link unionConstStrings}, and generic
 * schemastery vocabulary for the same reason: `z.dict(z.string())` serializes
 * as a `dict` node whose `inner` is a `string` node, and a caller that means to
 * edit a field as a map of text needs to know the schema still describes it
 * that way. A field the owning schema shapes some other way answers false, so
 * the caller can offer no editor rather than write a value the namespace would
 * refuse.
 * @param node - the field's own node, typically from {@link fieldNode}.
 * @param envelope - the table every uid is looked up in.
 * @returns true when the node is a dict whose element schema is a string.
 */
export function isStringDict(node: SchemaNode | undefined, envelope: SchemaEnvelope): boolean {
  if (node?.type !== 'dict') return false
  return resolveNode(node.inner, envelope)?.type === 'string'
}

/**
 * Read one path out of a resolved settings value.
 *
 * Separate from the schema walk because they answer different questions: the
 * schema says which field COULD name a credential, and the value says which
 * one currently does.
 * @param value - a namespace's resolved value, or a layer of it.
 * @param path - the path to read.
 * @returns the value at that path, or undefined when the path is absent.
 */
export function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * The exact Harness surfaces Connect consumes, and nothing else.
 *
 * Provider configuration is not one seam. Harness splits it into four, each
 * answering a different question, and Connect reads all four rather than
 * inventing a fifth:
 *
 * ```
 * ctx.llm             which provider routes exist, and which can be configured
 * ctx.settings        the user-editable document that activates and shapes them
 * ctx.credentials     whether the secret a route names is present, and writable
 * ctx.authorization   the flows that OBTAIN a credential by asking a human
 * ```
 *
 * Only `ctx.llm` is imported as a type. The other three are written out
 * structurally, for two reasons that point the same way. The first is the one
 * {@link SessionQueryReads} gives: naming the four calls a view makes is more
 * legible than depending on a whole service, and the real service satisfies it
 * structurally, so narrowing costs nothing at the call site. The second is
 * concrete — `@deepseek-ai/dsh-settings`, `-credentials`, and `-authorization`
 * cannot currently be added to this workspace at all: resolving any of them
 * moves every `next`-tagged Harness dependency onto a line whose own peer graph
 * does not resolve. These become type imports the moment that floor moves, and
 * the shapes below are copied from the published contracts, not guessed.
 *
 * Every one of them is optional. A profile that mounts no settings provider, no
 * credential provider, or no authorization seam still starts; Connect reports
 * what that deployment cannot answer instead of failing to open.
 * @module @riesbri/dsh-tui/connect/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider, LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'

/** One `{ op, path }` edit against a namespace's stored user section. */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** One namespace as a configuration surface sees it. */
export interface SettingsDescriptorRead {
  /** The registered namespace. */
  readonly ns: string
  /** Serialized schemastery schema (`schema.toJSON()`). */
  readonly schema: unknown
  /** Current resolved value: schema defaults, then composition base, then user. */
  readonly value: unknown
  /** Monotonic revision of the RAW user section this descriptor was read at. */
  readonly revision: number
  /** The registrant's composition `base` layer, when one was declared. */
  readonly base?: unknown
  /** The raw user section, when the stored document has a well-formed one. */
  readonly user?: unknown
}

/**
 * The `ctx.settings` surface Connect consumes: one read and one write.
 *
 * `mutate` rather than `update` or `replace` because Connect holds an
 * INCOMPLETE view — the descriptor it reads is redacted — and rebuilding a
 * section from an incomplete view would delete every field the read never
 * returned. A path op names the one field it means.
 */
export interface ConnectSettings {
  /**
   * Describe every registered namespace.
   * @param options - `redactSecrets` strips `role('secret')` fields.
   * @returns one descriptor per namespace.
   */
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptorRead[]
  /**
   * Apply ordered path edits to one namespace's user section.
   * @param ns - the namespace to edit.
   * @param ops - the edits, applied in order.
   * @param expectedRevision - the revision the caller read; a stale one rejects.
   * @returns once the write is persisted and committed.
   */
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** Source and writability facts for one credential reference — never the value. */
export interface CredentialInfoRead {
  /** Whether resolving the reference would currently return a value. */
  readonly configured: boolean
  /** Source layer currently supplying it; absent while unconfigured. */
  readonly source?: string
  /** Whether writing this reference would currently succeed. */
  readonly writable: boolean
}

/** Presence and writability facts for one credential record — never the value. */
export interface CredentialRecordInfoRead {
  /** Whether a record is stored. Presence alone is the whole fact for a record. */
  readonly configured: boolean
  /** Discriminant of the stored record; absent while none is stored. */
  readonly kind?: string
  /** Whether replacing or deleting the record would currently succeed. */
  readonly writable: boolean
}

/** The `ctx.credentials` surface Connect consumes. */
export interface ConnectCredentials {
  /**
   * Describe one environment-shaped reference.
   * @param ref - the reference name.
   * @returns its configured, source, and writable facts.
   */
  describe(ref: string): Promise<CredentialInfoRead>
  /**
   * Store a value behind one reference.
   * @param ref - the reference name.
   * @param value - the secret.
   * @returns once the write is committed.
   */
  set(ref: string, value: string): Promise<void>
  /**
   * Forget the value behind one reference.
   * @param ref - the reference name.
   * @returns once the removal is committed.
   */
  unset(ref: string): Promise<void>
  /**
   * Describe one plugin-owned credential record.
   * @param key - the `<scope>/<id>` record address.
   * @returns its configured, kind, and writable facts.
   */
  describeRecord(key: string): Promise<CredentialRecordInfoRead>
  /**
   * Delete one plugin-owned credential record.
   * @param key - the `<scope>/<id>` record address.
   * @returns once the removal is committed.
   */
  deleteRecord(key: string): Promise<void>
}

/** One way a flow can obtain its credential. */
export interface AuthorizationMethodRead {
  /** Flow-owned identifier, echoed back when a caller picks this method. */
  readonly id: string
  /** User-facing label. */
  readonly label: string
}

/** A running flow's report to whoever is watching it. Never carries a secret. */
export interface AuthorizationNoticeRead {
  /** What is happening, or what the human must do next. */
  readonly message: string
  /** A page the human must open to continue. */
  readonly url?: string
  /** A short code the human must enter on that page. */
  readonly code?: string
}

/** One choice offered by a `select` prompt. */
export interface AuthorizationOptionRead {
  /** Value returned when this option is chosen. */
  readonly id: string
  /** User-facing label. */
  readonly label: string
  /** Optional extra context rendered by capable surfaces. */
  readonly description?: string
}

/**
 * A question a flow must have answered before it can continue.
 *
 * Deliberately smaller than any one provider's vocabulary: it describes what a
 * surface must render, so a surface that renders one flow renders all of them.
 */
export type AuthorizationPromptRead = {
  /** Withdraws this prompt alone, leaving the attempt running. */
  readonly signal?: AbortSignal
} & (
  | { readonly kind: 'text'; readonly message: string; readonly placeholder?: string }
  | { readonly kind: 'secret'; readonly message: string; readonly placeholder?: string }
  | { readonly kind: 'select'; readonly message: string; readonly options: readonly AuthorizationOptionRead[] }
)

/** A registered flow as a surface sees it. */
export interface AuthorizationEntryRead {
  /** The credential record this flow writes. */
  readonly key: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The methods this flow offers, most preferred first. */
  readonly methods: readonly AuthorizationMethodRead[]
  /** Whether an attempt for this key is running right now. */
  readonly inFlight: boolean
}

/** The surface half of one attempt: whoever started it renders its conversation. */
export interface AuthorizationInteractionWrite {
  /**
   * Render a notice from the running flow. Fire-and-forget.
   * @param notice - the message, and any page or code it refers to.
   */
  notify(notice: AuthorizationNoticeRead): void
  /**
   * Put a question to the human and wait.
   * @param prompt - what to ask, and how it should be presented.
   * @returns the typed text, or the chosen option's id.
   */
  prompt(prompt: AuthorizationPromptRead): Promise<string>
}

/** How one attempt ended, as its own caller sees it. */
export interface AuthorizationOutcomeRead {
  /** `authorized` once the record is committed; `cancelled` when withdrawn. */
  readonly status: 'authorized' | 'cancelled'
}

/** The `ctx.authorization` surface Connect consumes. */
export interface ConnectAuthorization {
  /**
   * Every registered flow.
   * @returns one entry per flow, in registration order.
   */
  list(): readonly AuthorizationEntryRead[]
  /**
   * Run one attempt to authorize a key.
   * @param request - the key, the chosen method, and the surface rendering it.
   * @returns how the attempt ended.
   */
  begin(request: {
    key: string
    method?: string
    interaction: AuthorizationInteractionWrite
    signal?: AbortSignal
  }): Promise<AuthorizationOutcomeRead>
  /**
   * Withdraw whatever attempt is running for a key.
   * @param key - the record whose attempt should stop.
   */
  cancel(key: string): void
}

/**
 * The `ctx.llm` surface Connect consumes.
 *
 * `listConfigurableProviders()` is the one that makes `/connect` possible at
 * all: it is the directory of routes an adapter can activate through
 * configuration, registered or dormant, so a bare-mounted adapter offers its
 * whole installed catalog before a single route exists.
 */
export interface ConnectLlm {
  /**
   * Provider routes with a registered adapter — what `/model` can already offer.
   * @returns detached provider metadata in registration order.
   */
  listProviders(): LlmProviderInfo[]
  /**
   * Every declared configurable provider, registered or dormant.
   * @returns detached directory entries in declaration order.
   */
  listConfigurableProviders(): LlmConfigurableProvider[]
  /**
   * Models one registered route advertises.
   * @param provider - the route key.
   * @returns its catalog.
   */
  listModels(provider: string): Promise<LlmModelInfo[]>
}

/** Every Harness seam Connect reads, with the optional ones marked absent. */
export interface ConnectSeams {
  /** The model registry and its configurable-provider directory. */
  readonly llm: ConnectLlm
  /** The user-settings document, or undefined without a mounted provider. */
  readonly settings: ConnectSettings | undefined
  /** The credential store, or undefined without a mounted provider. */
  readonly credentials: ConnectCredentials | undefined
  /** The authorization registry, or undefined in a composition without one. */
  readonly authorization: ConnectAuthorization | undefined
}

/**
 * Gather the seams from a context.
 *
 * `ctx.get` answers `undefined` for an unmounted service and is untyped, which
 * is what lets the three structural surfaces above be adopted here without a
 * cast: the assignment's declared type IS the narrowing.
 * @param ctx - context carrying the harness services.
 * @returns the seams, each present only when its provider is mounted.
 */
export function connectSeams(ctx: Context): ConnectSeams {
  const settings: ConnectSettings | undefined = ctx.get('settings')
  const credentials: ConnectCredentials | undefined = ctx.get('credentials')
  const authorization: ConnectAuthorization | undefined = ctx.get('authorization')
  return { llm: ctx.llm, settings, credentials, authorization }
}

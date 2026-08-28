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
 * All four are imported as types from their own packages. The data each call
 * carries — every descriptor, info, and prompt below — is an ALIAS to the
 * published contract rather than a copy of it, so there is nothing here that
 * can quietly drift from what Harness actually publishes.
 *
 * The four service surfaces themselves are still written out narrowly, for the
 * reason {@link SessionQueryReads} gives: naming the calls one screen makes is
 * more legible than depending on a whole service. Two things make that safe
 * rather than a second source of truth. The narrow views take plain strings
 * where the real services take branded ones, which is what keeps every import
 * in this file TYPE-ONLY and leaves Connect with no Harness code at runtime;
 * and each service package augments `Context`, so the assignments in
 * {@link connectSeams} check every view against the real service on every
 * build. A separate conformance assertion was tried and removed — it proved
 * exactly what those three lines already prove.
 *
 * An earlier version of this comment said these packages could not be added to
 * the workspace at all. That was a version-alignment problem, not an upstream
 * one: `dsh-settings` and `dsh-credentials` still publish `latest` at
 * `0.0.1-rc.1`, a generation whose peers want `dsh-invariants ^0.0.1-rc.1`, so
 * adding them by bare name pulled a floor that collides with this workspace.
 * Pinned to the generation everything else here already develops against, they
 * resolve with no peer warnings at all.
 *
 * Every one of them is optional. A profile that mounts no settings provider, no
 * credential provider, or no authorization seam still starts; Connect reports
 * what that deployment cannot answer instead of failing to open.
 * @module dshline/connect/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmModelInfo,
  LlmProviderInfo,
} from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { CredentialInfo, CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationEntry, AuthorizationInteraction, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt, AuthorizationPromptOption } from '@deepseek-ai/dsh-authorization'

/** One `{ op, path }` edit against a namespace's stored user section. */
export type { SettingsPathOp }

/** One namespace as a configuration surface sees it. */
export type SettingsDescriptorRead = SettingsDescriptor

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
export type CredentialInfoRead = CredentialInfo

/** Presence and writability facts for one credential record — never the value. */
export type CredentialRecordInfoRead = CredentialRecordInfo

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
export type AuthorizationMethodRead = AuthorizationMethod

/** A running flow's report to whoever is watching it. Never carries a secret. */
export type AuthorizationNoticeRead = AuthorizationNotice

/** One choice offered by a `select` prompt. */
export type AuthorizationOptionRead = AuthorizationPromptOption

/**
 * A question a flow must have answered before it can continue.
 *
 * Deliberately smaller than any one provider's vocabulary: it describes what a
 * surface must render, so a surface that renders one flow renders all of them.
 */
export type AuthorizationPromptRead = AuthorizationPrompt

/** A registered flow as a surface sees it. */
export type AuthorizationEntryRead = AuthorizationEntry

/** The surface half of one attempt: whoever started it renders its conversation. */
export type AuthorizationInteractionWrite = AuthorizationInteraction

/** How one attempt ended, as its own caller sees it. */
export type AuthorizationOutcomeRead = AuthorizationOutcome

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
  /**
   * Interrogate a DRAFT endpoint for the models it advertises — a route being
   * edited or one that does not exist yet, never a stored profile. Nothing
   * here reads or writes settings or credentials: the caller owns the draft,
   * and the reply is candidate metadata to offer for adoption, not a fact to
   * store. The one seam through which Connect is allowed to learn about an
   * endpoint at all; there is no `fetch()` in this package.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - the endpoint, protocol, and one-shot credential to try.
   * @returns the advertised models, in endpoint order.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]>
}

/** One model an endpoint reports about itself, before a human adopts it. */
export type LlmDiscoveredModelRead = LlmDiscoveredModel

/** What a discovery request may carry; never stored by the caller. */
export type LlmModelDiscoveryRequestRead = LlmModelDiscoveryRequest

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
 * `ctx.get` answers `undefined` for an unmounted service, and each service
 * package augments `Context` with its own type — so these three assignments are
 * a real check rather than a free narrowing, and no cast is needed in either
 * direction. A service that stopped satisfying its view would fail here as well
 * as at the conformance proofs below.
 * @param ctx - context carrying the harness services.
 * @returns the seams, each present only when its provider is mounted.
 */
export function connectSeams(ctx: Context): ConnectSeams {
  const settings: ConnectSettings | undefined = ctx.get('settings')
  const credentials: ConnectCredentials | undefined = ctx.get('credentials')
  const authorization: ConnectAuthorization | undefined = ctx.get('authorization')
  return { llm: ctx.llm, settings, credentials, authorization }
}

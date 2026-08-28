/**
 * Editing and declaring one `llm-pi-ai` route from a terminal.
 *
 * Two flows live here, both sequences of the same `promptSelect`/`promptText`
 * overlays every other Connect action already uses — there is no new overlay
 * type, because a menu that edits a few named fields does not need one.
 * {@link runRouteEditor} opens on a route the directory already lists;
 * {@link runCreateRoute} opens on an address {@link declarableTargets} found
 * where no route exists yet. Both build a draft in memory, let the reader
 * fetch or type model candidates through {@link editModels}, and commit
 * through a single revision-checked `settings.mutate` — never a wholesale
 * replace, so a sibling field this pass does not render survives untouched.
 *
 * Nothing here imports `@deepseek-ai/dsh-llm-pi-ai` or performs network I/O.
 * The one seam that touches an endpoint is `ctx.llm.discoverModels`, and its
 * result is candidates a reader chooses from, never a fact adopted automatically.
 * @module dshline/connect/route-editor
 */

import type { Context } from '@deepseek-ai/cordis'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'
import type { ConnectActionOutcome } from './actions.ts'
import { messageOf } from './catalog.ts'
import type { LlmDiscoveredModelRead, LlmModelDiscoveryRequestRead, ConnectSeams } from './harness.ts'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { ConnectNewRouteTarget, ConnectProviderRow } from './model.ts'
import { derivedCredentialRef, newRouteIdProblem } from './model.ts'
import {
  addCandidates,
  addManual,
  entriesFromRaw,
  includedEntries,
  parseCapacity,
  sameModelSet,
  toRawEntries,
  toggleIncluded,
  updateFields,
} from './model-editor.ts'
import type { ModelDraftEntry } from './model-editor.ts'
import {
  API_FIELD,
  BASE_URL_FIELD,
  createRouteOp,
  DISPLAY_NAME_FIELD,
  fieldOps,
  protocolChoices,
  rawModels,
  setModelsOp,
  unsetModelsOp,
} from './pi-ai.ts'
import { credentialRefFields, profileNode, valueAt } from './schema.ts'
import type { CuratedFieldChange } from './pi-ai.ts'

/** A refused action, worded the same way {@link runCreateRoute} and `actions.ts` do. */
function failed(message: string): ConnectActionOutcome {
  return { kind: 'failed', message }
}

/** A string field's current value, or undefined when the profile carries none. */
function stringField(profile: unknown, field: string): string | undefined {
  const value = valueAt(profile, [field])
  return typeof value === 'string' ? value : undefined
}

/** One route's editable state, kept apart from the profile it was read from. */
interface RouteDraft {
  readonly displayName: string | undefined
  readonly baseURL: string
  readonly api: string
  readonly models: ModelDraftEntry[]
  readonly modelsInherited: boolean
}

/**
 * Read a route's curated fields into a draft.
 * @param profile - the profile value at the route's settings path.
 * @returns the draft, ready to compare edits against.
 */
function readDraft(profile: unknown): RouteDraft {
  const raw = rawModels(profile)
  return {
    displayName: stringField(profile, DISPLAY_NAME_FIELD),
    baseURL: stringField(profile, BASE_URL_FIELD) ?? '',
    api: stringField(profile, API_FIELD) ?? '',
    models: entriesFromRaw(raw),
    modelsInherited: raw === undefined,
  }
}

/**
 * Edit one route the directory already lists.
 * @param ctx - context carrying the slot registry.
 * @param seams - the Harness seams.
 * @param row - the route being edited.
 * @returns what Harness answered, or undefined when the reader left without saving.
 */
export async function runRouteEditor(
  ctx: Context,
  seams: ConnectSeams,
  row: ConnectProviderRow,
): Promise<ConnectActionOutcome | undefined> {
  const { settings } = seams
  if (settings === undefined) return failed('this profile mounts no settings provider')
  const descriptor = settings.describe({ redactSecrets: true }).find(entry => entry.ns === row.settingsNs)
  if (descriptor === undefined) return failed(`${row.settingsNs} is no longer available`)
  const profile = valueAt(descriptor.value, row.settingsPath)
  const original = readDraft(profile)
  const protocolOptions = protocolChoices(descriptor.schema, row.settingsPath)
  const editableIdentity = row.declared === true
  let draft = original
  let notice: string | undefined
  for (;;) {
    const modelsLabel = draft.modelsInherited
      ? 'inherited from adapter'
      : `customized · ${String(includedEntries(draft.models).length)}`
    const choice = await promptSelect(ctx, {
      title: `Edit ${row.displayName}`,
      view: 'Edit route',
      detail: notice ?? `${row.settingsNs}${row.settingsPath.length > 0 ? ` · ${row.settingsPath.join('.')}` : ''}`,
      choices: [
        { value: 'base-url', label: 'Base URL', description: draft.baseURL === '' ? '(not set)' : draft.baseURL },
        ...editableIdentity && protocolOptions.length > 0
          ? [{ value: 'protocol', label: 'Protocol', description: draft.api === '' ? '(not set)' : draft.api }]
          : [],
        ...editableIdentity
          ? [{ value: 'display-name', label: 'Display name', description: draft.displayName ?? '(none)' }]
          : [],
        { value: 'models', label: 'Models', description: modelsLabel },
        ...draft.modelsInherited
          ? []
          : [{ value: 'reset-models', label: 'Reset models to adapter catalog' }],
        { value: 'save', label: 'Save changes' },
        { value: 'cancel', label: 'Discard changes' },
      ],
    })
    notice = undefined
    if (choice === undefined || choice === 'cancel') return undefined
    if (choice === 'base-url') {
      const typed = await promptText(ctx, {
        title: 'Base URL',
        view: 'Edit route',
        message: 'The OpenAI-compatible endpoint this route calls.',
        kind: 'text',
        initial: draft.baseURL,
      })
      if (typed !== undefined) draft = { ...draft, baseURL: typed.trim() }
      continue
    }
    if (choice === 'protocol') {
      const picked = await promptSelect(ctx, {
        title: 'Protocol',
        view: 'Edit route',
        choices: protocolOptions.map(option => ({ value: option, label: option })),
      })
      if (picked !== undefined) draft = { ...draft, api: picked }
      continue
    }
    if (choice === 'display-name') {
      const typed = await promptText(ctx, {
        title: 'Display name',
        view: 'Edit route',
        message: 'Shown in /connect and /model. Leave blank to show the route id instead.',
        kind: 'text',
        initial: draft.displayName ?? '',
      })
      if (typed !== undefined) draft = { ...draft, displayName: typed.trim() === '' ? undefined : typed.trim() }
      continue
    }
    if (choice === 'models') {
      draft = {
        ...draft,
        models: await editModels(ctx, seams, row.settingsNs, { provider: row.provider }, draft.baseURL, draft.api, draft.models),
        modelsInherited: false,
      }
      continue
    }
    if (choice === 'reset-models') {
      draft = { ...draft, models: [], modelsInherited: true }
      continue
    }
    if (choice === 'save') break
  }
  const changes: CuratedFieldChange[] = []
  if (draft.baseURL !== original.baseURL) {
    changes.push({ field: BASE_URL_FIELD, value: draft.baseURL === '' ? undefined : draft.baseURL })
  }
  if (editableIdentity) {
    if (draft.api !== original.api) changes.push({ field: API_FIELD, value: draft.api === '' ? undefined : draft.api })
    if (draft.displayName !== original.displayName) changes.push({ field: DISPLAY_NAME_FIELD, value: draft.displayName })
  }
  const ops = fieldOps(row.settingsPath, changes)
  if (draft.modelsInherited !== original.modelsInherited || !sameModelSet(draft.models, original.models)) {
    ops.push(draft.modelsInherited
      ? unsetModelsOp(row.settingsPath)
      : setModelsOp(row.settingsPath, toRawEntries(draft.models)))
  }
  if (ops.length === 0) return { kind: 'done', message: `${row.provider}: nothing changed` }
  try {
    await settings.mutate(row.settingsNs, ops, descriptor.revision)
  } catch (error) {
    return failed(`${row.settingsNs} refused the edit: ${messageOf(error)}`)
  }
  return { kind: 'done', message: `${row.provider}: route updated` }
}

/**
 * Ask for a provider id, refusing one Harness would refuse or one already taken.
 * @param ctx - context carrying the slot registry.
 * @param taken - route keys already in the directory, across every namespace.
 * @returns the id, or undefined when the reader backed out.
 */
async function promptRouteId(ctx: Context, taken: ReadonlySet<string>): Promise<string | undefined> {
  let detail: string | undefined
  for (;;) {
    const raw = await promptText(ctx, {
      title: 'Provider ID',
      view: 'Add custom provider',
      message: 'Lowercase letters, digits, and hyphens; becomes the route key.',
      ...detail === undefined ? {} : { detail },
      kind: 'text',
    })
    if (raw === undefined) return undefined
    const id = raw.trim()
    const problem = newRouteIdProblem(id, taken)
    if (problem !== undefined) {
      detail = problem
      continue
    }
    return id
  }
}

/**
 * Declare a brand-new route at an address {@link declarableTargets} found.
 * @param ctx - context carrying the slot registry.
 * @param seams - the Harness seams.
 * @param target - where the new route's profile would be written.
 * @returns what Harness answered, or undefined when the reader backed out.
 */
export async function runCreateRoute(
  ctx: Context,
  seams: ConnectSeams,
  target: ConnectNewRouteTarget,
): Promise<ConnectActionOutcome | undefined> {
  const { settings, llm, credentials } = seams
  if (settings === undefined) return failed('this profile mounts no settings provider')
  const taken = new Set(llm.listConfigurableProviders().map(entry => entry.provider))
  const id = await promptRouteId(ctx, taken)
  if (id === undefined) return undefined
  const routePath = [...target.parentPath, id]
  const descriptor = settings.describe({ redactSecrets: true }).find(entry => entry.ns === target.settingsNs)
  const protocolOptions = protocolChoices(descriptor?.schema, routePath)

  const displayNameTyped = await promptText(ctx, {
    title: 'Display name',
    view: 'Add custom provider',
    message: 'Optional; shown in /connect and /model. Leave blank to show the route id instead.',
    kind: 'text',
  })
  if (displayNameTyped === undefined) return undefined

  const baseURLTyped = await promptText(ctx, {
    title: 'Endpoint',
    view: 'Add custom provider',
    message: 'The OpenAI-compatible base URL this route calls.',
    kind: 'text',
  })
  if (baseURLTyped === undefined || baseURLTyped.trim() === '') return undefined
  const baseURL = baseURLTyped.trim()

  let api: string | undefined
  if (protocolOptions.length > 0) {
    api = await promptSelect(ctx, {
      title: 'Protocol',
      view: 'Add custom provider',
      choices: protocolOptions.map(option => ({ value: option, label: option })),
    })
    if (api === undefined) return undefined
  } else {
    api = ''
  }

  const apiKeyTyped = await promptText(ctx, {
    title: 'API key',
    view: 'Add custom provider',
    message: 'Optional. Leave blank if this endpoint needs none.',
    kind: 'secret',
  })
  if (apiKeyTyped === undefined) return undefined
  const keyProvided = apiKeyTyped !== ''
  if (keyProvided) {
    const checked = normalizeApiKey(apiKeyTyped)
    if (!checked.ok) {
      return failed(checked.reason === 'empty'
        ? 'no key was typed'
        : 'that key contains characters no HTTP header can carry')
    }
  }

  const models = await editModels(
    ctx,
    seams,
    target.settingsNs,
    keyProvided ? { apiKey: apiKeyTyped } : {},
    baseURL,
    api,
    [],
  )
  const included = includedEntries(models)
  if (included.length === 0) return failed('at least one model is required')

  const credentialField = credentialRefFields(profileNode(descriptor?.schema, routePath))[0]
  const credentialRef = keyProvided && credentialField !== undefined ? derivedCredentialRef(id) : undefined
  if (keyProvided && credentialField !== undefined && credentialRef === undefined) {
    return failed(`no credential reference can be derived from "${id}"`)
  }

  const op = createRouteOp(routePath, {
    displayName: displayNameTyped.trim() === '' ? undefined : displayNameTyped.trim(),
    baseURL,
    api: api ?? '',
    models: included,
    credentialField: keyProvided ? credentialField : undefined,
    credentialRef,
  })
  try {
    await settings.mutate(target.settingsNs, [op], target.revision)
  } catch (error) {
    return failed(`${target.settingsNs} refused the profile: ${messageOf(error)}`)
  }
  if (!keyProvided || credentialRef === undefined) return { kind: 'done', message: `${id}: route created` }
  if (credentials === undefined) {
    return { kind: 'done', message: `${id}: route created, but this profile mounts no credential provider to store the key` }
  }
  try {
    await credentials.set(credentialRef, apiKeyTyped)
  } catch (error) {
    return { kind: 'done', message: `${id}: route created; the key could not be stored behind ${credentialRef}: ${messageOf(error)}` }
  }
  return { kind: 'done', message: `${id}: route created, key stored behind ${credentialRef}` }
}

/**
 * The models sub-menu: toggle, add, or fetch, looping until the reader is done.
 * @param ctx - context carrying the slot registry.
 * @param seams - the Harness seams.
 * @param settingsNs - the namespace whose registered discovery serves this draft.
 * @param identity - `{ provider }` for an existing route, so the owning adapter
 *   can resolve its own stored credential; `{ apiKey }` for a route that does
 *   not exist yet, sent once and never stored by this frontend.
 * @param baseURL - the draft's current endpoint.
 * @param api - the draft's current protocol, when one is chosen.
 * @param entries - the draft's current model list.
 * @returns the model list after every toggle, add, and adopted fetch.
 */
async function editModels(
  ctx: Context,
  seams: ConnectSeams,
  settingsNs: string,
  identity: Pick<LlmModelDiscoveryRequestRead, 'provider' | 'apiKey'>,
  baseURL: string,
  api: string,
  entries: readonly ModelDraftEntry[],
): Promise<ModelDraftEntry[]> {
  let current = [...entries]
  let notice: string | undefined
  for (;;) {
    const choice = await promptSelect(ctx, {
      title: 'Models',
      view: 'Models',
      ...notice === undefined ? {} : { detail: notice },
      choices: [
        {
          value: '__fetch',
          label: 'Fetch available models',
          description: 'Advisory: asks the endpoint what it advertises, then lets you choose which to adopt',
        },
        { value: '__add', label: '+ Add model manually' },
        ...current.map(entry => ({
          value: entry.id,
          label: `${entry.included ? '✓' : '○'} ${entry.id}`,
          description: modelSummary(entry),
        })),
        { value: '__done', label: 'Done' },
      ],
    })
    notice = undefined
    if (choice === undefined || choice === '__done') return current
    if (choice === '__fetch') {
      try {
        const request: LlmDiscoveredModelRequest = { ...identity, baseURL, ...api === '' ? {} : { api } }
        const candidates = await seams.llm.discoverModels(settingsNs, request)
        current = addCandidates(current, candidates)
        notice = `found ${String(candidates.length)} model${candidates.length === 1 ? '' : 's'}; unchecked ones are new`
      } catch (error) {
        notice = `could not fetch models: ${messageOf(error)}`
      }
      continue
    }
    if (choice === '__add') {
      const added = await promptNewModel(ctx, current)
      if (added.ok) current = added.entries
      else if (added.reason !== undefined) notice = added.reason
      continue
    }
    const target = current.find(entry => entry.id === choice)
    if (target === undefined) continue
    const next = await promptSelect(ctx, {
      title: target.id,
      view: 'Models',
      choices: [
        { value: 'toggle', label: target.included ? 'Remove from list' : 'Include in list' },
        { value: 'edit', label: 'Edit fields' },
        { value: 'back', label: 'Back' },
      ],
    })
    if (next === 'toggle') current = toggleIncluded(current, target.id)
    else if (next === 'edit') current = await promptEditModel(ctx, current, target)
  }
}

/** What `ctx.llm.discoverModels` takes; named locally so `editModels` reads narrowly. */
type LlmDiscoveredModelRequest = LlmModelDiscoveryRequestRead

/**
 * The description under one model row in the menu.
 * @param entry - the draft entry.
 * @returns the facts worth showing, joined for one line.
 */
function modelSummary(entry: ModelDraftEntry): string {
  const facts: string[] = []
  if (entry.name !== undefined) facts.push(entry.name)
  if (entry.contextWindow !== undefined) facts.push(`${String(entry.contextWindow)} ctx`)
  if (entry.maxTokens !== undefined) facts.push(`${String(entry.maxTokens)} max out`)
  return facts.join(' · ')
}

/**
 * Ask for one capacity field, re-asking on an invalid answer.
 * @param ctx - context carrying the slot registry.
 * @param title - the field's name.
 * @param initial - the field's current value, prefilled.
 * @returns the parsed count, or undefined both when left blank and when cancelled.
 */
async function promptOptionalCapacity(ctx: Context, title: string, initial: number | undefined): Promise<number | undefined | 'cancel'> {
  let detail: string | undefined
  for (;;) {
    const raw = await promptText(ctx, {
      title,
      view: 'Models',
      message: `${title}. Leave blank to omit.`,
      ...detail === undefined ? {} : { detail },
      kind: 'text',
      initial: initial === undefined ? '' : String(initial),
    })
    if (raw === undefined) return 'cancel'
    const parsed = parseCapacity(raw)
    if (parsed.ok) return parsed.value
    detail = parsed.reason
  }
}

/**
 * Walk the add-model form and append the result.
 * @param ctx - context carrying the slot registry.
 * @param entries - the draft before this add.
 * @returns the updated draft, or the refusal reason when one applies.
 */
async function promptNewModel(
  ctx: Context,
  entries: readonly ModelDraftEntry[],
): Promise<{ ok: true; entries: ModelDraftEntry[] } | { ok: false; reason: string | undefined }> {
  const id = await promptText(ctx, { title: 'Model id', view: 'Add model', message: 'The id this route should offer.', kind: 'text' })
  if (id === undefined || id.trim() === '') return { ok: false, reason: undefined }
  const name = await promptText(ctx, { title: 'Display name', view: 'Add model', message: 'Optional; leave blank to omit.', kind: 'text' })
  if (name === undefined) return { ok: false, reason: undefined }
  const contextWindow = await promptOptionalCapacity(ctx, 'Context window', undefined)
  if (contextWindow === 'cancel') return { ok: false, reason: undefined }
  const maxTokens = await promptOptionalCapacity(ctx, 'Max output tokens', undefined)
  if (maxTokens === 'cancel') return { ok: false, reason: undefined }
  const result = addManual(entries, {
    id: id.trim(),
    name: name.trim() === '' ? undefined : name.trim(),
    contextWindow,
    maxTokens,
  })
  return result.ok ? { ok: true, entries: result.entries } : { ok: false, reason: result.reason }
}

/**
 * Walk the edit-fields form for one existing entry.
 * @param ctx - context carrying the slot registry.
 * @param entries - the draft before this edit.
 * @param target - the entry being edited.
 * @returns the updated draft; unchanged when the reader backs out partway.
 */
async function promptEditModel(
  ctx: Context,
  entries: readonly ModelDraftEntry[],
  target: ModelDraftEntry,
): Promise<ModelDraftEntry[]> {
  const name = await promptText(ctx, {
    title: 'Display name',
    view: 'Edit model',
    message: 'Optional; leave blank to omit.',
    kind: 'text',
    initial: target.name ?? '',
  })
  if (name === undefined) return [...entries]
  const contextWindow = await promptOptionalCapacity(ctx, 'Context window', target.contextWindow)
  if (contextWindow === 'cancel') return [...entries]
  const maxTokens = await promptOptionalCapacity(ctx, 'Max output tokens', target.maxTokens)
  if (maxTokens === 'cancel') return [...entries]
  return updateFields(entries, target.id, {
    name: name.trim() === '' ? undefined : name.trim(),
    contextWindow,
    maxTokens,
  })
}

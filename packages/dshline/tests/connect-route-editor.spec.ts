/**
 * Declaring and editing one `llm-pi-ai` route from a terminal.
 *
 * Every prompt and menu here is driven the same way a person would: pressing
 * keys into whatever overlay `ctx.tuiSlots.pushOverlay` most recently mounted.
 * That is deliberate — it is the only way to prove the invariants that matter
 * (discovery goes through `ctx.llm.discoverModels` and nothing else, settings
 * land before a credential, a typed key never reaches an outcome message)
 * without re-implementing the flows against their internals.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { runCreateRoute, runRouteEditor } from '../src/connect/route-editor.ts'
import type {
  ConnectCredentials,
  ConnectLlm,
  ConnectSeams,
  ConnectSettings,
  LlmModelDiscoveryRequestRead,
  SettingsDescriptorRead,
} from '../src/connect/harness.ts'
import type { ConnectNewRouteTarget, ConnectProviderRow } from '../src/connect/model.ts'

/**
 * Let every pending microtask run, so a settled prompt's continuation has
 * pushed its next overlay before the test presses into it.
 * @returns when the queue has drained.
 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/** A context whose slot registry hands each pushed overlay to the test. */
function slots(): {
  ctx: Context
  type: (text: string) => Promise<void>
  press: (...keys: Key[]) => Promise<void>
  text: (columns?: number, rows?: number) => string
} {
  const stack: TuiOverlay[] = []
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        stack.push(overlay)
        return (): void => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
      invalidate: (): void => {},
    },
  } as unknown as Context
  return {
    ctx,
    type: async text => { stack.at(-1)?.handleKey({ kind: 'text', text }); await settle() },
    press: async (...keys) => {
      for (const key of keys) stack.at(-1)?.handleKey(key)
      await settle()
    },
    text: (columns = 90, rows = 24) => stripAnsi((stack.at(-1)?.render(columns, rows) ?? []).join('\n')),
  }
}

const ENTER: Key = { kind: 'key', name: 'enter' }
const DOWN: Key = { kind: 'key', name: 'down' }
const UP: Key = { kind: 'key', name: 'up' }
const CTRL_U: Key = { kind: 'key', name: 'ctrl-u' }

/** The `llm-pi-ai` schema shape: a dict of profiles under `providers`. */
const PI_AI_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, apiKeyEnv: 6, baseURL: 7, displayName: 7, models: 7 } },
    4: { type: 'union', meta: {}, list: [5] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    6: { type: 'string', meta: { role: 'credential-ref' } },
    7: { type: 'string', meta: {} },
  },
}

/** A schema with no `credential-ref` field at all — a keyless-only route domain. */
const SCHEMA_WITHOUT_CREDENTIAL_REF = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 6, models: 6 } },
    4: { type: 'union', meta: {}, list: [5] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    6: { type: 'string', meta: {} },
  },
}

/** A schema with no derivable protocol choice: `api` is a plain string, not a union of consts. */
const SCHEMA_WITHOUT_PROTOCOL = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 4 } },
    4: { type: 'string', meta: {} },
  },
}

/** What one test wants the seams to answer, and what it recorded. */
interface Fixture {
  descriptor?: SettingsDescriptorRead
  directory?: readonly { provider: string }[]
  liveProviders?: readonly { id: string }[]
  setCredential?: (ref: string, value: string) => Promise<void>
  discoverModels?: (ns: string, request: LlmModelDiscoveryRequestRead) => Promise<{ id: string }[]>
}

/**
 * Build seams that answer exactly what a test asked for, recording every call
 * and its relative order.
 * @param fixture - the answers.
 * @returns the seams and the calls they recorded.
 */
function seamsFor(fixture: Fixture): {
  seams: ConnectSeams
  mutateCalls: { ns: string; ops: readonly unknown[]; revision: number | undefined }[]
  credentialCalls: { ref: string; value: string }[]
  discoverCalls: { ns: string; request: LlmModelDiscoveryRequestRead }[]
  order: string[]
} {
  const mutateCalls: { ns: string; ops: readonly unknown[]; revision: number | undefined }[] = []
  const credentialCalls: { ref: string; value: string }[] = []
  const discoverCalls: { ns: string; request: LlmModelDiscoveryRequestRead }[] = []
  const order: string[] = []
  const settings: ConnectSettings = {
    describe: () => fixture.descriptor === undefined ? [] : [fixture.descriptor],
    mutate: async (ns, ops, revision) => {
      order.push('settings')
      mutateCalls.push({ ns, ops, revision })
    },
  }
  const credentials: ConnectCredentials = {
    describe: async () => ({ configured: false, writable: true }),
    set: async (ref, value) => {
      order.push('credentials')
      credentialCalls.push({ ref, value })
      await (fixture.setCredential?.(ref, value) ?? Promise.resolve())
    },
    unset: async () => {},
    describeRecord: async () => ({ configured: false, writable: true }),
    deleteRecord: async () => {},
  }
  const llm: ConnectLlm = {
    listProviders: () => (fixture.liveProviders ?? []).map(entry => ({ id: entry.id, name: entry.id })),
    listConfigurableProviders: () => (fixture.directory ?? []).map(entry => ({
      provider: entry.provider,
      displayName: entry.provider,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', entry.provider],
    })),
    listModels: async () => [],
    discoverModels: async (ns, request) => {
      discoverCalls.push({ ns, request })
      return fixture.discoverModels?.(ns, request) ?? []
    },
  }
  return {
    seams: { llm, settings, credentials, authorization: undefined },
    mutateCalls,
    credentialCalls,
    discoverCalls,
    order,
  }
}

const TARGET: ConnectNewRouteTarget = { settingsNs: 'llm-pi-ai', parentPath: ['providers'], revision: 9 }

describe('declaring a brand-new route', () => {
  it('writes settings before a credential, and reports where the key landed', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama') // Provider ID
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1') // Endpoint
    await press(ENTER)
    await press(ENTER) // Protocol, the only choice, at the cursor
    await type('  sk-secret-value  ') // API key, with harmless surrounding whitespace
    await press(ENTER)
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('llama3') // model id
    await press(ENTER)
    await press(ENTER) // display name, blank
    await press(ENTER) // context window, blank
    await press(ENTER) // max tokens, blank
    await press(UP, ENTER) // 'Done' is now the last item
    // Review menu: display-name(0), base-url(1), protocol(2), api-key(3), models(4), create(5), cancel(6).
    await press(UP, UP, ENTER) // 'Create provider'
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: route created, key stored behind LOCAL_LLAMA_API_KEY' })
    expect(fixture.order).toEqual(['settings', 'credentials'])
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'local-llama'],
        value: {
          baseURL: 'http://127.0.0.1:11434/v1',
          api: 'openai-completions',
          apiKeyEnv: 'LOCAL_LLAMA_API_KEY',
          models: [{ id: 'llama3' }],
        },
      }],
      revision: 9,
    }])
    // Normalized — the surrounding whitespace never reaches the seam.
    expect(fixture.credentialCalls).toEqual([{ ref: 'LOCAL_LLAMA_API_KEY', value: 'sk-secret-value' }])
  })

  it('never lets the typed key reach the reported outcome, even when storing it fails', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      setCredential: async () => { throw new Error('vault unreachable') },
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER) // protocol
    await type('a-very-secret-key')
    await press(ENTER)
    await press(DOWN, ENTER) // add model manually
    await type('llama3')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // done
    await press(UP, UP, ENTER) // create
    const result = await outcome
    // The route was written — a visible, recoverable route naming an unset
    // reference beats storing a secret nothing points at.
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(result?.kind).toBe('done')
    expect(result?.message).not.toContain('a-very-secret-key')
    expect(result?.message).toContain('could not be stored')
  })

  it('refuses a duplicate id and lets the reader correct it', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      directory: [{ provider: 'openai' }],
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('openai')
    await press(ENTER)
    // Refused; the id prompt is still on screen, corrected and resubmitted.
    await type('openai-mirror')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER) // protocol
    await press(ENTER) // no key
    await press(DOWN, ENTER) // add model manually
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // done
    await press(UP, UP, ENTER) // create
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'openai-mirror'],
      value: { baseURL: 'http://example.test/v1', api: 'openai-completions', models: [{ id: 'm' }] },
    }])
  })

  it('refuses an id already owned by a live route the directory does not list', async () => {
    // A composition-declared route, say — it publishes no configurable-provider
    // entry, but its id is still a real registration at the LLM seam, and a
    // custom route must not be allowed to collide with it.
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      liveProviders: [{ id: 'deepseek-official' }],
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('deepseek-official')
    await press(ENTER)
    // Refused; corrected and resubmitted.
    await type('deepseek-mirror')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    await press(UP, UP, ENTER)
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops[0]).toMatchObject({ path: ['providers', 'deepseek-mirror'] })
  })

  it('keeps the reader inside the review when Create is chosen with nothing selected', async () => {
    // The wizard already has a proper draft/review screen at this point;
    // punishing the reader by closing the whole thing over a missing model
    // would be needlessly harsh. A notice explains it, and the draft survives
    // so the reader can open Models and correct it without starting over.
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER) // protocol
    await press(ENTER) // no key
    await press(UP, ENTER) // 'Done' immediately: fetch(0), add(1), done(2)
    await press(UP, UP, ENTER) // 'Create provider', with nothing selected
    // Refused in place: nothing written, and the wizard is still running.
    expect(fixture.mutateCalls).toEqual([])
    // Correct it: open Models and add one by hand.
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // 'Models', index 4 of 7
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // 'Done', now 4 items
    await press(UP, UP, ENTER) // 'Create provider' again, this time with a model
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(fixture.mutateCalls[0]?.ops[0]).toMatchObject({ value: { models: [{ id: 'm' }] } })
  })

  it('never asks for an API key, and never writes one, when the schema names no credential-reference field', async () => {
    // A route with nowhere to store a key is still legitimate — an
    // unauthenticated local server has to stay possible. The wizard has to
    // skip the question entirely rather than ask it and drop the answer.
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: SCHEMA_WITHOUT_CREDENTIAL_REF, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER) // protocol — the very next prompt is Models, not an API key
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // 'Done'
    // Review menu has no API-key row: display-name(0), base-url(1),
    // protocol(2), models(3), create(4), cancel(5).
    await press(UP, UP, ENTER) // 'Create provider'
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: route created' })
    expect(fixture.mutateCalls[0]?.ops[0]).toEqual({
      op: 'set',
      path: ['providers', 'local-llama'],
      value: { baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions', models: [{ id: 'm' }] },
    })
    expect(fixture.credentialCalls).toEqual([])
  })

  it('fetches candidates through ctx.llm.discoverModels, never a network call of its own', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      discoverModels: async () => [{ id: 'llama3' }, { id: 'llama3-instruct' }],
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER)
    await type('sk-one-shot')
    await press(ENTER)
    await press(ENTER) // 'Fetch available models', the first item
    // Both candidates now listed, unchecked. Selecting one opens a small
    // toggle/edit/back menu of its own; 'toggle' is the first choice.
    await press(DOWN, DOWN, ENTER)
    await press(ENTER)
    await press(UP, ENTER) // back at the models menu; 'Done' is now the last item
    await press(UP, UP, ENTER) // 'Create provider'
    const result = await outcome
    expect(fixture.discoverCalls).toEqual([{
      ns: 'llm-pi-ai',
      request: { apiKey: 'sk-one-shot', baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
    }])
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama'],
      value: expect.objectContaining({ models: [{ id: 'llama3' }] }),
    }])
  })

  it('fails closed, writing nothing, when no protocol choice can be derived', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: SCHEMA_WITHOUT_PROTOCOL, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    const result = await outcome
    expect(result?.kind).toBe('failed')
    expect(result?.message).toContain('llm-pi-ai')
    expect(fixture.mutateCalls).toEqual([])
  })

  it('writes with the revision read when the wizard opened, not an older one the row was shown from', async () => {
    const { ctx, type, press } = slots()
    // The create row's target carries whatever revision the catalog last read;
    // the descriptor here is deliberately fresher, simulating time spent
    // browsing /connect between that read and opening the wizard.
    const stale: ConnectNewRouteTarget = { ...TARGET, revision: 1 }
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 42 } })
    const outcome = runCreateRoute(ctx, fixture.seams, stale)
    await type('local-llama')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER) // no key
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    await press(UP, UP, ENTER)
    await outcome
    expect(fixture.mutateCalls[0]?.revision).toBe(42)
  })

  it('leaves the final review with zero writes when the reader cancels', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER) // no key
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    // Review menu: cancel is the last item.
    await press(UP, ENTER)
    const result = await outcome
    expect(result).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
    expect(fixture.credentialCalls).toEqual([])
  })

  it('shows the final review as a confirmation, never the key material', async () => {
    const { ctx, type, press, text } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await type('sk-should-never-be-shown')
    await press(ENTER)
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    // A choice's description is drawn only for the row currently selected;
    // move onto 'api-key' (index 3) to see its own.
    await press(DOWN, DOWN, DOWN)
    const shown = text()
    expect(shown).toContain('configured')
    expect(shown).not.toContain('sk-should-never-be-shown')
    await press(UP, UP, UP, UP, ENTER) // back to 'cancel', writing nothing
    await outcome
  })
})

/** One existing, hand-declared provider row, whose profile explicitly names one model. */
function declaredRow(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
  return {
    kind: 'provider',
    provider: 'local-llama',
    displayName: 'Local Llama',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'local-llama'],
    declared: true,
    state: 'active',
    models: 1,
    credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    userOwned: true,
    revision: 9,
    ...overrides,
  }
}

/** A descriptor for `declaredRow()`, at whatever profile shape a test wants. */
function descriptorFor(profile: Record<string, unknown>): SettingsDescriptorRead {
  return {
    ns: 'llm-pi-ai',
    schema: PI_AI_SCHEMA,
    value: { providers: { 'local-llama': profile } },
    revision: 9,
  }
}

describe('editing an existing route', () => {
  it('changes the base URL with a narrow op, leaving everything else untouched', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://old/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    // Menu: base-url(0), protocol(1), display-name(2), models(3), reset-models(4), save(5), cancel(6).
    await press(ENTER) // base-url
    await press(CTRL_U) // clear the prefilled value
    await type('http://new/v1')
    await press(ENTER)
    await press(UP, UP, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'local-llama', 'baseURL'], value: 'http://new/v1' }],
      revision: 9,
    }])
  })

  it('resets the model catalog by unsetting the field, never by writing an empty array', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // reset-models, index 4 while it is still offered
    // The menu no longer offers reset-models once inherited; save is now index 4.
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', 'local-llama', 'models'] }],
      revision: 9,
    }])
  })

  it('reports nothing changed, and writes nothing, when the reader saves without editing', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(UP, UP, ENTER) // save, index 5 of 7
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
    expect(fixture.mutateCalls).toEqual([])
  })

  it('discards a draft when the reader cancels, writing nothing', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(ENTER) // base-url
    await press(CTRL_U) // clear the prefilled value
    await type('http://changed/v1')
    await press(ENTER)
    await press(UP, ENTER) // cancel, the last item
    const result = await outcome
    expect(result).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })

  it('resolves a stored credential internally by provider, never sending an apiKey', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // 'models', index 3
    await press(ENTER) // 'Fetch available models', the first item
    await press(UP, ENTER) // back out: 'Done'
    await press(UP, ENTER) // 'cancel', discarding
    await outcome
    expect(fixture.discoverCalls).toEqual([{
      ns: 'llm-pi-ai',
      request: { provider: 'local-llama', baseURL: 'http://x/v1', api: 'openai-completions' },
    }])
  })

  it('only offers protocol and display-name edits for a declared route', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const catalogRow = declaredRow({ declared: false })
    const outcome = runRouteEditor(ctx, fixture.seams, catalogRow)
    // Menu is now: base-url(0), models(1), reset-models(2), save(3), cancel(4).
    await press(UP, ENTER) // cancel, the last item
    const result = await outcome
    expect(result).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })

  describe('opening the Models submenu without an actual change', () => {
    // The regression this whole group guards: a route with no `models`
    // override inherits the owning adapter's catalog. Entering the submenu
    // and leaving without adopting anything must not turn that absence into a
    // stored `models: []` — an explicitly empty catalog is a different, and
    // materially worse, Harness state than "unset".
    function inheritedFixture(discoverModels?: Fixture['discoverModels']) {
      return seamsFor({
        descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions' }), // no `models` key at all
        ...discoverModels === undefined ? {} : { discoverModels },
      })
    }

    it('leaves an inherited catalog inherited when the submenu is opened and immediately left', async () => {
      const { ctx, press } = slots()
      const fixture = inheritedFixture()
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      // Menu without reset-models (still inherited): base-url(0), protocol(1),
      // display-name(2), models(3), save(4), cancel(5).
      await press(DOWN, DOWN, DOWN, ENTER) // models
      await press(UP, ENTER) // 'Done' immediately: fetch(0), add(1), done(2) -> up lands on done
      await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
      const result = await outcome
      expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
      expect(fixture.mutateCalls).toEqual([])
    })

    it('leaves an inherited catalog inherited when a fetch finds candidates nobody adopts', async () => {
      const { ctx, press } = slots()
      const fixture = inheritedFixture(async () => [{ id: 'discovered' }])
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      await press(DOWN, DOWN, DOWN, ENTER) // models
      await press(ENTER) // fetch, the first item
      // One new, unchecked candidate now listed: fetch(0), add(1), discovered(2), done(3).
      await press(UP, ENTER) // 'Done' without adopting it
      await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
      const result = await outcome
      expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
      expect(fixture.mutateCalls).toEqual([])
    })

    it('turns an inherited catalog into an explicit one once a model is actually adopted', async () => {
      const { ctx, type, press } = slots()
      const fixture = inheritedFixture()
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      await press(DOWN, DOWN, DOWN, ENTER) // models
      await press(DOWN, ENTER) // '+ Add model manually', the second item
      await type('m1')
      await press(ENTER)
      await press(ENTER) // name blank
      await press(ENTER) // context blank
      await press(ENTER) // max blank
      // Now four items: fetch(0), add(1), m1(2), done(3).
      await press(UP, ENTER) // Done
      // A real change means reset-models now shows: base-url(0), protocol(1),
      // display-name(2), models(3), reset-models(4), save(5), cancel(6).
      await press(UP, UP, ENTER) // save
      const result = await outcome
      expect(result?.kind).toBe('done')
      expect(fixture.mutateCalls).toEqual([{
        ns: 'llm-pi-ai',
        ops: [{ op: 'set', path: ['providers', 'local-llama', 'models'], value: [{ id: 'm1' }] }],
        revision: 9,
      }])
    })
  })
})

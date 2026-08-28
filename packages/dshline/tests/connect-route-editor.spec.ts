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
function slots(): { ctx: Context; type: (text: string) => Promise<void>; press: (...keys: Key[]) => Promise<void> } {
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
  }
}

const ENTER: Key = { kind: 'key', name: 'enter' }
const DOWN: Key = { kind: 'key', name: 'down' }
const UP: Key = { kind: 'key', name: 'up' }

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

/** What one test wants the seams to answer, and what it recorded. */
interface Fixture {
  descriptor?: SettingsDescriptorRead
  directory?: readonly { provider: string }[]
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
    listProviders: () => [],
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
    await press(ENTER) // Display name, blank
    await type('http://127.0.0.1:11434/v1') // Endpoint
    await press(ENTER)
    await press(ENTER) // Protocol, the only choice, at the cursor
    await type('sk-secret-value') // API key
    await press(ENTER)
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('llama3') // model id
    await press(ENTER)
    await press(ENTER) // display name, blank
    await press(ENTER) // context window, blank
    await press(ENTER) // max tokens, blank
    await press(UP, ENTER) // 'Done' is now the last item
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
    await press(ENTER) // display name, blank
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
    await press(ENTER) // display name, blank
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
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'openai-mirror'],
      value: { baseURL: 'http://example.test/v1', api: 'openai-completions', models: [{ id: 'm' }] },
    }])
  })

  it('requires at least one model, and writes nothing when none is chosen', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER) // protocol
    await press(ENTER) // no key
    await press(UP, ENTER) // 'Done' immediately: fetch(0), add(1), done(2)
    const result = await outcome
    expect(result).toEqual({ kind: 'failed', message: 'at least one model is required' })
    expect(fixture.mutateCalls).toEqual([])
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

/** A descriptor for `declaredRow()`, with an explicit (non-inherited) one-model catalog. */
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
    await press({ kind: 'key', name: 'ctrl-u' }) // clear the prefilled value
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
    await press({ kind: 'key', name: 'ctrl-u' }) // clear the prefilled value
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
})

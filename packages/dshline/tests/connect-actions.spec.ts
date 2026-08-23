/** The four writes Connect performs, and the order it performs them in. */

import { describe, expect, it, vi } from 'vitest'
import {
  activateRoute,
  clearApiKey,
  deactivateRoute,
  forgetSignIn,
  setApiKey,
} from '../src/connect/actions.ts'
import type { ConnectSeams, SettingsPathOp } from '../src/connect/harness.ts'
import type { ConnectProviderRow, ConnectSignInRow } from '../src/connect/model.ts'

/** Everything one run of an action asked its seams to do, in order. */
interface Recorder {
  readonly seams: ConnectSeams
  readonly writes: string[]
  readonly mutations: { ns: string; ops: readonly SettingsPathOp[]; revision: number | undefined }[]
  readonly stored: Record<string, string>
}

/**
 * Seams that record every write.
 * @param failures - which calls should reject.
 * @returns the seams and what they recorded.
 */
function recorder(failures: { mutate?: Error; set?: Error; unset?: Error; deleteRecord?: Error } = {}): Recorder {
  const writes: string[] = []
  const mutations: Recorder['mutations'] = []
  const stored: Record<string, string> = {}
  const seams: ConnectSeams = {
    llm: {
      listProviders: () => [],
      listConfigurableProviders: () => [],
      listModels: async () => [],
    },
    settings: {
      describe: () => [],
      mutate: async (ns, ops, revision) => {
        writes.push('mutate')
        if (failures.mutate !== undefined) throw failures.mutate
        mutations.push({ ns, ops, revision })
      },
    },
    credentials: {
      describe: async () => ({ configured: false, writable: true }),
      set: async (ref, value) => {
        writes.push('set')
        if (failures.set !== undefined) throw failures.set
        stored[ref] = value
      },
      unset: async ref => {
        writes.push('unset')
        if (failures.unset !== undefined) throw failures.unset
        delete stored[ref]
      },
      describeRecord: async () => ({ configured: true, writable: true }),
      deleteRecord: async () => {
        writes.push('deleteRecord')
        if (failures.deleteRecord !== undefined) throw failures.deleteRecord
      },
    },
    authorization: undefined,
  }
  return { seams, writes, mutations, stored }
}

/**
 * One configurable provider route.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function provider(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
  return {
    kind: 'provider',
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    declared: false,
    state: 'dormant',
    models: undefined,
    credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    userOwned: false,
    revision: 5,
    ...overrides,
  }
}

/** One registered authorization flow. */
const SIGN_IN: ConnectSignInRow = {
  kind: 'sign-in',
  key: 'llm-pi-ai/openai',
  label: 'ChatGPT (Codex)',
  methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
  inFlight: false,
  record: { configured: true, kind: 'grant', writable: true },
}

describe('storing an API key', () => {
  it('records the reference in settings before storing the value', async () => {
    // The order is the recovery story: a stored secret whose reference nothing
    // records is a secret no adapter will ever read.
    const { seams, writes, mutations, stored } = recorder()
    const outcome = await setApiKey(seams, provider(), '  sk-live-123  ')
    expect(writes).toEqual(['mutate', 'set'])
    expect(mutations[0]).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: 'OPENAI_API_KEY' }],
      revision: 5,
    })
    // Trimmed, because a padded key has one unambiguous reading.
    expect(stored['OPENAI_API_KEY']).toBe('sk-live-123')
    expect(outcome).toEqual({ kind: 'done', message: 'openai: key stored behind OPENAI_API_KEY' })
  })

  it('writes no settings at all when the profile already names a reference', async () => {
    const { seams, writes, stored } = recorder()
    const row = provider({ credential: { field: 'apiKeyEnv', ref: 'MY_GATEWAY_KEY', info: { configured: false, writable: true } } })
    await setApiKey(seams, row, 'sk-1')
    expect(writes).toEqual(['set'])
    expect(stored['MY_GATEWAY_KEY']).toBe('sk-1')
  })

  it('refuses a key no HTTP header could carry, before any write', async () => {
    const { seams, writes } = recorder()
    const outcome = await setApiKey(seams, provider(), 'sk-with a space')
    expect(writes).toEqual([])
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('no HTTP header can carry')
  })

  it('refuses an empty field before any write', async () => {
    const { seams, writes } = recorder()
    expect((await setApiKey(seams, provider(), '   ')).message).toBe('no key was typed')
    expect(writes).toEqual([])
  })

  it('reports the settings refusal and never reaches the store', async () => {
    const { seams, writes } = recorder({ mutate: new Error('SETTINGS_CONFLICT') })
    const outcome = await setApiKey(seams, provider(), 'sk-1')
    expect(writes).toEqual(['mutate'])
    expect(outcome).toEqual({
      kind: 'failed',
      message: 'llm-pi-ai refused the reference: SETTINGS_CONFLICT',
    })
  })

  it('reports a stored-key failure that leaves the reference recorded', async () => {
    const { seams, writes } = recorder({ set: new Error('read-only source') })
    const outcome = await setApiKey(seams, provider(), 'sk-1')
    expect(writes).toEqual(['mutate', 'set'])
    expect(outcome.message).toContain('could not be stored behind OPENAI_API_KEY')
  })

  it('refuses a route whose id cannot name a reference', async () => {
    const { seams, writes } = recorder()
    const outcome = await setApiKey(seams, provider({ provider: '4o-gateway' }), 'sk-1')
    expect(writes).toEqual([])
    expect(outcome.message).toContain('no credential reference can be derived')
  })
})

describe('clearing an API key', () => {
  it('forgets the value and leaves the reference in place', async () => {
    // Removing the reference too would switch the route to provider-native
    // authentication, which is a different decision from clearing a key.
    const { seams, writes } = recorder()
    const row = provider({ credential: { field: 'apiKeyEnv', ref: 'OPENAI_API_KEY', info: { configured: true, writable: true } } })
    expect(await clearApiKey(seams, row)).toEqual({
      kind: 'done',
      message: 'openai: OPENAI_API_KEY cleared',
    })
    expect(writes).toEqual(['unset'])
  })

  it('reports a route that names no reference', async () => {
    const { seams } = recorder()
    expect((await clearApiKey(seams, provider())).kind).toBe('failed')
  })
})

describe('activating and removing a route', () => {
  it('writes an empty profile, which is the whole activation for a catalog route', async () => {
    const { seams, mutations } = recorder()
    expect((await activateRoute(seams, provider())).kind).toBe('done')
    expect(mutations[0]).toEqual({
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'openai'], value: {} }],
      revision: 5,
    })
  })

  it('unsets only the user layer, so a composition route reverts to its base', async () => {
    const { seams, mutations } = recorder()
    expect((await deactivateRoute(seams, provider({ userOwned: true }))).kind).toBe('done')
    expect(mutations[0]?.ops).toEqual([{ op: 'unset', path: ['providers', 'openai'] }])
  })

  it('refuses a namespace whose whole section is the profile', async () => {
    // Setting or unsetting an empty path replaces the entire user section, which
    // is a far bigger action than the row describes.
    const { seams, writes } = recorder()
    const row = provider({ settingsPath: [], settingsNs: 'llm-deepseek' })
    expect((await activateRoute(seams, row)).kind).toBe('failed')
    expect((await deactivateRoute(seams, row)).kind).toBe('failed')
    expect(writes).toEqual([])
  })

  it('carries the revision the row was read at, so a concurrent edit is refused', async () => {
    const { seams, mutations } = recorder()
    await activateRoute(seams, provider({ revision: 41 }))
    expect(mutations[0]?.revision).toBe(41)
  })

  it('reports a deployment with no settings provider instead of throwing', async () => {
    const { seams } = recorder()
    const withoutSettings: ConnectSeams = { ...seams, settings: undefined }
    expect((await activateRoute(withoutSettings, provider())).message)
      .toBe('this profile mounts no settings provider')
  })
})

describe('forgetting a sign-in', () => {
  it('deletes the local record and says the issuer was not told', async () => {
    const { seams, writes } = recorder()
    const outcome = await forgetSignIn(seams, SIGN_IN)
    expect(writes).toEqual(['deleteRecord'])
    expect(outcome.message).toContain('the issuer was not told')
  })

  it('reports what the seam refused with', async () => {
    const { seams } = recorder({ deleteRecord: new Error('locked') })
    expect(await forgetSignIn(seams, SIGN_IN)).toEqual({
      kind: 'failed',
      message: 'llm-pi-ai/openai could not be deleted: locked',
    })
  })
})

describe('a deployment with no credential provider', () => {
  it('refuses every credential action by name', async () => {
    const { seams } = recorder()
    const bare: ConnectSeams = { ...seams, credentials: undefined }
    const expected = 'this profile mounts no credential provider'
    expect((await setApiKey(bare, provider(), 'sk-1')).message).toBe(expected)
    expect((await clearApiKey(bare, provider())).message).toBe(expected)
    expect((await forgetSignIn(bare, SIGN_IN)).message).toBe(expected)
  })
})

describe('no action writes a secret into the settings document', () => {
  it('keeps every settings op free of the typed value', async () => {
    const { seams, mutations } = recorder()
    await setApiKey(seams, provider(), 'sk-super-secret')
    const serialized = JSON.stringify(mutations)
    expect(serialized).not.toContain('sk-super-secret')
    expect(serialized).toContain('OPENAI_API_KEY')
  })
})

describe('nothing here reaches for a clock or a provider name', () => {
  it('never consults the current time', () => {
    // A configuration write has no schedule; a test that finds one has found a
    // behaviour this module was not supposed to grow.
    const now = vi.spyOn(Date, 'now')
    void activateRoute(recorder().seams, provider())
    expect(now).not.toHaveBeenCalled()
    now.mockRestore()
  })
})

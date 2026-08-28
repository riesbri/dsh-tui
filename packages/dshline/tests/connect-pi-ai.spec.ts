/** Curated presentation for the one known configuration domain: `llm-pi-ai`. */

import { describe, expect, it } from 'vitest'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import {
  API_FIELD,
  BASE_URL_FIELD,
  createRouteOp,
  curatedModelFields,
  DISPLAY_NAME_FIELD,
  extraActions,
  fieldOps,
  isPiAiNamespace,
  mergeModelEntry,
  MODELS_FIELD,
  piAiDeclarationTarget,
  protocolChoices,
  rawModels,
  setModelsOp,
  unsetModelsOp,
} from '../src/connect/pi-ai.ts'
import type { ConnectCapabilities, ConnectProviderRow } from '../src/connect/model.ts'
import type { SettingsDescriptorRead } from '../src/connect/harness.ts'

/** A schema shaping `api` as a union of string consts, the way `dsh-llm-pi-ai` does. */
const PI_AI_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, apiKeyEnv: 8, baseURL: 9 } },
    4: { type: 'union', meta: {}, list: [5, 6, 7] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    6: { type: 'const', meta: {}, value: 'openai-responses' },
    7: { type: 'const', meta: {}, value: 'anthropic-messages' },
    8: { type: 'string', meta: { role: 'credential-ref' } },
    9: { type: 'string', meta: {} },
  },
}

describe('recognizing the one domain this module presents', () => {
  it('is llm-pi-ai and only llm-pi-ai', () => {
    expect(isPiAiNamespace('llm-pi-ai')).toBe(true)
    expect(isPiAiNamespace('llm-deepseek')).toBe(false)
  })
})

describe('reading curated model fields off a raw entry', () => {
  it('reads what it curates and ignores the rest', () => {
    expect(curatedModelFields({ id: 'gpt', name: 'GPT', contextWindow: 128000, compat: {} }))
      .toEqual({ id: 'gpt', name: 'GPT', contextWindow: 128000, maxTokens: undefined })
  })

  it('refuses an entry with no usable id', () => {
    expect(curatedModelFields({ name: 'no id' })).toBeUndefined()
    expect(curatedModelFields('not an object')).toBeUndefined()
    expect(curatedModelFields(null)).toBeUndefined()
  })
})

describe('the inherited-vs-explicit-empty distinction', () => {
  it('is absent when the profile has no models field at all', () => {
    expect(rawModels({ baseURL: 'https://x' })).toBeUndefined()
  })

  it('is an explicit empty array when the profile says so', () => {
    expect(rawModels({ models: [] })).toEqual([])
  })

  it('reads the stored entries verbatim otherwise', () => {
    expect(rawModels({ models: [{ id: 'a' }] })).toEqual([{ id: 'a' }])
  })
})

describe('merging curated edits without losing unknown fields', () => {
  it('spreads the retained shape first, so curated fields win but the rest survives', () => {
    const retained = { id: 'gpt', name: 'old', compat: { supportsDeveloperRole: false }, reasoningEfforts: ['low'] }
    const merged = mergeModelEntry(retained, { id: 'gpt', name: 'new', contextWindow: undefined, maxTokens: undefined })
    expect(merged).toEqual({ id: 'gpt', name: 'new', compat: { supportsDeveloperRole: false }, reasoningEfforts: ['low'] })
  })

  it('deletes a curated field cleared to undefined rather than writing null', () => {
    expect(mergeModelEntry({ id: 'gpt', name: 'old' }, { id: 'gpt', name: undefined, contextWindow: undefined, maxTokens: undefined }))
      .toEqual({ id: 'gpt' })
  })

  it('builds a fresh entry when there is nothing retained', () => {
    expect(mergeModelEntry(undefined, { id: 'gpt', name: 'GPT', contextWindow: 128000, maxTokens: undefined }))
      .toEqual({ id: 'gpt', name: 'GPT', contextWindow: 128000 })
  })
})

describe('protocol choices read from the schema', () => {
  it('offers the union of string consts the api field is built from', () => {
    expect(protocolChoices(PI_AI_SCHEMA, ['providers', 'openai']))
      .toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
  })

  it('answers the same shape for a route id the schema has never seen', () => {
    // A dict describes every key with one element node — this is what lets a
    // brand-new route id get the same protocol offer as an existing one.
    expect(protocolChoices(PI_AI_SCHEMA, ['providers', 'not-yet-declared']))
      .toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
  })

  it('offers nothing when the schema does not shape the field as a union of consts', () => {
    const plain = {
      uid: 1,
      refs: {
        1: { type: 'object', meta: {}, dict: { providers: 2 } },
        2: { type: 'dict', meta: {}, inner: 3 },
        3: { type: 'object', meta: {}, dict: { api: 4 } },
        4: { type: 'string', meta: {} },
      },
    }
    expect(protocolChoices(plain, ['providers', 'openai'])).toEqual([])
  })
})

describe('path ops for curated field changes', () => {
  it('writes one op per changed field, addressed under the route path', () => {
    const ops = fieldOps(['providers', 'openai'], [
      { field: BASE_URL_FIELD, value: 'https://example.test/v1' },
      { field: API_FIELD, value: undefined },
    ])
    expect(ops).toEqual([
      { op: 'set', path: ['providers', 'openai', BASE_URL_FIELD], value: 'https://example.test/v1' },
      { op: 'unset', path: ['providers', 'openai', API_FIELD] },
    ])
  })
})

describe('the models array ops', () => {
  it('sets the whole array for a customized catalog', () => {
    expect(setModelsOp(['providers', 'openai'], [{ id: 'gpt' }]))
      .toEqual({ op: 'set', path: ['providers', 'openai', MODELS_FIELD], value: [{ id: 'gpt' }] })
  })

  it('unsets, never sets an empty array, to restore inheritance', () => {
    expect(unsetModelsOp(['providers', 'openai']))
      .toEqual({ op: 'unset', path: ['providers', 'openai', MODELS_FIELD] })
  })
})

describe('declaring a brand-new route, whole', () => {
  it('writes the curated fields, the credential reference, and every model in one op', () => {
    const op = createRouteOp(['providers', 'local-llama'], {
      displayName: 'Local Llama',
      baseURL: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'llama3', name: undefined, contextWindow: undefined, maxTokens: undefined }],
      credentialField: 'apiKeyEnv',
      credentialRef: 'LOCAL_LLAMA_API_KEY',
    })
    expect(op).toEqual({
      op: 'set',
      path: ['providers', 'local-llama'],
      value: {
        baseURL: 'http://127.0.0.1:11434/v1',
        api: 'openai-completions',
        displayName: 'Local Llama',
        apiKeyEnv: 'LOCAL_LLAMA_API_KEY',
        models: [{ id: 'llama3' }],
      },
    })
  })

  it('omits the credential field entirely for a keyless route', () => {
    const op = createRouteOp(['providers', 'local-llama'], {
      displayName: undefined,
      baseURL: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'llama3', name: undefined, contextWindow: undefined, maxTokens: undefined }],
      credentialField: undefined,
      credentialRef: undefined,
    })
    expect(op.value).not.toHaveProperty('apiKeyEnv')
    expect(op.value).not.toHaveProperty(DISPLAY_NAME_FIELD)
  })
})

describe('the one action a generic row picker cannot offer', () => {
  const ALL: ConnectCapabilities = { settings: true, credentials: true, authorization: true }

  function row(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
    return {
      kind: 'provider',
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
      state: 'active',
      models: 3,
      credential: { field: 'apiKeyEnv', ref: 'OPENAI_API_KEY', info: { configured: true, source: 'file', writable: true } },
      userOwned: true,
      revision: 4,
      ...overrides,
    }
  }

  it('offers edit-route only for a writable pi-ai row', () => {
    expect(extraActions(row(), ALL).map(action => action.id)).toEqual(['edit-route'])
  })

  it('offers nothing for any other namespace', () => {
    expect(extraActions(row({ settingsNs: 'llm-deepseek' }), ALL)).toEqual([])
  })

  it('offers nothing without a settings provider, a revision, or an addressable path', () => {
    expect(extraActions(row(), { ...ALL, settings: false })).toEqual([])
    expect(extraActions(row({ revision: undefined }), ALL)).toEqual([])
    expect(extraActions(row({ settingsPath: [] }), ALL)).toEqual([])
  })
})

describe('whether this module can service declaring a brand-new pi-ai route', () => {
  /** A pi-ai catalog entry, whose profile lives at `providers.<id>`. */
  const OPENAI_ENTRY: LlmConfigurableProvider = {
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    declared: false,
  }

  const PI_AI_DESCRIPTOR: SettingsDescriptorRead = {
    ns: 'llm-pi-ai',
    schema: PI_AI_SCHEMA,
    value: { providers: { openai: {} } },
    revision: 5,
  }

  it('finds the dict one segment above an existing route, once every check passes', () => {
    const target = piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', PI_AI_DESCRIPTOR]]))
    expect(target).toEqual({ settingsNs: 'llm-pi-ai', parentPath: ['providers'], revision: 5 })
  })

  it('offers nothing when the directory has no llm-pi-ai entry at all', () => {
    // No entry means no known address to even guess at — there is no fallback
    // to a hardcoded 'providers' path.
    expect(piAiDeclarationTarget([], new Map())).toBeUndefined()
  })

  it('ignores an entry from a namespace this module does not present', () => {
    // A dict-shaped `providers` under some OTHER namespace is not evidence
    // that namespace can be hand-declared into: only llm-pi-ai's own entries
    // are ever consulted.
    const other: LlmConfigurableProvider = {
      provider: 'foo',
      displayName: 'Foo',
      settingsNs: 'llm-other',
      settingsPath: ['providers', 'foo'],
      declared: false,
    }
    const descriptor: SettingsDescriptorRead = { ...PI_AI_DESCRIPTOR, ns: 'llm-other' }
    expect(piAiDeclarationTarget([other], new Map([['llm-other', descriptor]]))).toBeUndefined()
  })

  it('offers nothing for a namespace whose whole section is the profile', () => {
    // `settingsPath: []` has no segment above it to be a dict.
    const wholeSection: LlmConfigurableProvider = { ...OPENAI_ENTRY, settingsPath: [] }
    expect(piAiDeclarationTarget([wholeSection], new Map([['llm-pi-ai', PI_AI_DESCRIPTOR]]))).toBeUndefined()
  })

  it('offers nothing when the schema does not shape the parent as a dict', () => {
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: { 1: { type: 'object', meta: {}, dict: { providers: 2 } }, 2: { type: 'object', meta: {}, dict: {} } },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]]))).toBeUndefined()
  })

  it('offers nothing when entries disagree about where the dict sits', () => {
    const other: LlmConfigurableProvider = { ...OPENAI_ENTRY, provider: 'other', settingsPath: ['legacy', 'other'] }
    expect(piAiDeclarationTarget([OPENAI_ENTRY, other], new Map([['llm-pi-ai', PI_AI_DESCRIPTOR]]))).toBeUndefined()
  })

  it('offers nothing when the curated baseURL field is no longer reachable', () => {
    // A dict shape alone is not enough: this module also has to be able to
    // find the fields it curates, or a wizard it starts would fail partway
    // through writing a profile it cannot fully describe.
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { api: 4 } },
          4: { type: 'union', meta: {}, list: [5] },
          5: { type: 'const', meta: {}, value: 'openai-completions' },
        },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]]))).toBeUndefined()
  })

  it('offers nothing when no protocol choice can be derived', () => {
    // The same schema-shape check `protocolChoices` makes: a namespace this
    // module cannot offer a protocol for is one it cannot safely declare a
    // route into either — capability drift disables the row rather than
    // falling back to a stale dshline protocol list.
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 5 } },
          4: { type: 'string', meta: {} },
          5: { type: 'string', meta: {} },
        },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]]))).toBeUndefined()
  })
})

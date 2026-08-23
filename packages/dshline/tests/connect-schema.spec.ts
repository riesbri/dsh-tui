/**
 * Finding a profile's credential field from a serialized settings schema.
 *
 * The envelopes below are hand-built in the exact shape `schema.toJSON()`
 * produces — `{ uid, refs }`, with every nested node replaced by its uid so
 * shared and recursive references survive serialization. Schemastery is not a
 * dependency of this package, so the fixture states the contract rather than
 * re-deriving it; the two adapters shipped today (`llm-pi-ai`, keyed under a
 * `providers` dict, and `llm-deepseek`, whose whole section is the profile) are
 * both represented.
 */

import { describe, expect, it } from 'vitest'
import { credentialRefFields, profileNode, valueAt } from '../src/connect/schema.ts'

/** A `z.string().role('credential-ref')` node. */
const REF_NODE = { type: 'string', meta: { role: 'credential-ref' } }

/** A plain `z.string()` node. */
const PLAIN_NODE = { type: 'string', meta: {} }

/**
 * The `llm-pi-ai` shape: a section holding a dict of profiles.
 * @returns the serialized envelope.
 */
function piAiSchema(): unknown {
  return {
    uid: 1,
    refs: {
      1: { type: 'object', meta: {}, dict: { providers: 2 } },
      2: { type: 'dict', meta: {}, inner: 3 },
      3: { type: 'object', meta: {}, dict: { apiKeyEnv: 4, baseURL: 5, displayName: 5 } },
      4: REF_NODE,
      5: PLAIN_NODE,
    },
  }
}

/**
 * The `llm-deepseek` shape: the section itself is the profile.
 * @returns the serialized envelope.
 */
function deepseekSchema(): unknown {
  return {
    uid: 10,
    refs: {
      10: { type: 'object', meta: {}, dict: { apiKeyEnv: 11, baseURL: 12 } },
      11: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      12: PLAIN_NODE,
    },
  }
}

describe('locating a provider profile in a serialized settings schema', () => {
  it('follows a dict segment through its one element node', () => {
    // `openrouter` is nowhere in the schema — a dict describes every key with a
    // single `inner`, and that is exactly what lets a route the adapter never
    // named be configured.
    const located = profileNode(piAiSchema(), ['providers', 'openrouter'])
    expect(credentialRefFields(located)).toEqual(['apiKeyEnv'])
  })

  it('treats an empty path as the section root', () => {
    expect(credentialRefFields(profileNode(deepseekSchema(), []))).toEqual(['apiKeyEnv'])
  })

  it('reports no field when the role is absent, rather than guessing a name', () => {
    // The whole point of reading the role: a schema with an `apiKeyEnv`-shaped
    // field that is NOT declared a credential reference must not be written to.
    const schema = {
      uid: 1,
      refs: { 1: { type: 'object', meta: {}, dict: { apiKeyEnv: 2 } }, 2: PLAIN_NODE },
    }
    expect(credentialRefFields(profileNode(schema, []))).toEqual([])
  })

  it('flattens an intersection, which is how a schema composes shared fields', () => {
    const schema = {
      uid: 1,
      refs: {
        1: { type: 'intersect', meta: {}, list: [2, 3] },
        2: { type: 'object', meta: {}, dict: { token: 4 } },
        3: { type: 'object', meta: {}, dict: { baseURL: 5 } },
        4: REF_NODE,
        5: PLAIN_NODE,
      },
    }
    expect(credentialRefFields(profileNode(schema, []))).toEqual(['token'])
  })

  it('answers nothing for a path the schema does not describe', () => {
    expect(profileNode(piAiSchema(), ['nowhere', 'openai'])).toBeUndefined()
    expect(credentialRefFields(profileNode(piAiSchema(), ['nowhere']))).toEqual([])
  })

  it('answers nothing when the descriptor carries no envelope at all', () => {
    // A namespace whose provider could not serialize a schema must degrade to
    // "no credential field", never to a thrown error inside a render pass.
    expect(profileNode(undefined, [])).toBeUndefined()
    expect(profileNode({ notAnEnvelope: true }, [])).toBeUndefined()
    expect(credentialRefFields(undefined)).toEqual([])
  })

  it('terminates on a schema that refers to itself', () => {
    const schema = { uid: 1, refs: { 1: { type: 'intersect', meta: {}, list: [1] } } }
    expect(credentialRefFields(profileNode(schema, []))).toEqual([])
  })
})

describe('reading a path out of a resolved settings value', () => {
  it('returns the value at the path', () => {
    const value = { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }
    expect(valueAt(value, ['providers', 'openai', 'apiKeyEnv'])).toBe('OPENAI_API_KEY')
  })

  it('returns the whole value for an empty path', () => {
    expect(valueAt({ apiKeyEnv: 'X' }, [])).toEqual({ apiKeyEnv: 'X' })
  })

  it('returns undefined through an absent or non-object segment', () => {
    expect(valueAt({ providers: {} }, ['providers', 'openai', 'apiKeyEnv'])).toBeUndefined()
    expect(valueAt({ providers: 'text' }, ['providers', 'openai'])).toBeUndefined()
    expect(valueAt(undefined, ['providers'])).toBeUndefined()
  })
})

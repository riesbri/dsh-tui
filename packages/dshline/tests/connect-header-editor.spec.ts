/**
 * A route's request headers as a draft: pure transforms, no Harness, no UI.
 *
 * The validity checks here are deliberately proven against the platform
 * `Headers` constructor rather than a pattern this suite restates — that is the
 * whole point of the module, so a test that hard-coded its own grammar would
 * be asserting something different from what ships.
 */

import { describe, expect, it } from 'vitest'
import {
  entriesFromRawHeaders,
  headerNameProblem,
  headerValueProblem,
  removeHeader,
  sameHeaderSet,
  toRawHeaders,
  upsertHeader,
} from '../src/connect/header-editor.ts'

describe('reading a stored header map into a draft', () => {
  it('keeps the object’s own key order and drops what is not a string', () => {
    const entries = entriesFromRawHeaders({ 'X-B': '2', 'X-A': '1', 'X-Bad': 7, 'X-Also-Bad': null })
    expect(entries).toEqual([{ name: 'X-B', value: '2' }, { name: 'X-A', value: '1' }])
  })

  it('answers an empty draft for anything that is not a plain object', () => {
    expect(entriesFromRawHeaders(undefined)).toEqual([])
    expect(entriesFromRawHeaders(null)).toEqual([])
    expect(entriesFromRawHeaders(['X-A'])).toEqual([])
    expect(entriesFromRawHeaders('X-A: 1')).toEqual([])
  })

  it('round-trips a draft back to the object a settings op writes', () => {
    expect(toRawHeaders([{ name: 'X-A', value: '1' }, { name: 'X-B', value: '' }]))
      .toEqual({ 'X-A': '1', 'X-B': '' })
  })

  it('writes a header named __proto__ instead of silently dropping it', () => {
    // The token grammar allows `_`, so the platform `Headers` this module defers
    // to accepts the name — the editor will therefore display it, and a write
    // that quietly stored nothing would report a route updated with a header it
    // never wrote. Assigning into an object literal does exactly that, which is
    // why the map is built with `Object.fromEntries`.
    expect(headerNameProblem('__proto__', [])).toBeUndefined()
    const raw = toRawHeaders([{ name: '__proto__', value: 'kept' }, { name: 'X-A', value: '1' }])
    expect(Object.getOwnPropertyNames(raw)).toEqual(['__proto__', 'X-A'])
    expect(JSON.parse(JSON.stringify(raw))['__proto__']).toBe('kept')
    // And it survives the trip back into a draft.
    expect(entriesFromRawHeaders(raw)).toEqual([
      { name: '__proto__', value: 'kept' },
      { name: 'X-A', value: '1' },
    ])
    // Nothing is polluted: a string value leaves every prototype alone.
    expect((({}) as Record<string, unknown>).kept).toBeUndefined()
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype)
  })
})

describe('deciding whether a draft would write anything different', () => {
  it('ignores order, because order is a presentation fact only', () => {
    const left = [{ name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }]
    const right = [{ name: 'X-B', value: '2' }, { name: 'X-A', value: '1' }]
    expect(sameHeaderSet(left, right)).toBe(true)
  })

  it('sees a changed value, an added name, and a removed one', () => {
    const base = [{ name: 'X-A', value: '1' }]
    expect(sameHeaderSet(base, [{ name: 'X-A', value: '2' }])).toBe(false)
    expect(sameHeaderSet(base, [...base, { name: 'X-B', value: '2' }])).toBe(false)
    expect(sameHeaderSet(base, [])).toBe(false)
  })

  it('does not treat a renamed header as unchanged just because the count matches', () => {
    expect(sameHeaderSet([{ name: 'X-A', value: '1' }], [{ name: 'X-B', value: '1' }])).toBe(false)
  })
})

describe('refusing a header a request could not carry', () => {
  it('names an empty name rather than storing one', () => {
    expect(headerNameProblem('   ', [])).toBe('a header needs a name')
  })

  it('refuses a second spelling of a name already in the draft, case-insensitively', () => {
    expect(headerNameProblem('x-tenant-id', ['X-Tenant-Id'])).toBe('this route already sets x-tenant-id')
    expect(headerNameProblem('X-Other', ['X-Tenant-Id'])).toBeUndefined()
  })

  it('refuses names and values the platform Headers constructor refuses', () => {
    // A space is not in the HTTP token grammar, so this is not a field name.
    expect(headerNameProblem('X Tenant', [])).toBe('that is not a usable HTTP header name')
    expect(headerNameProblem('X-Tenant-Id', [])).toBeUndefined()
    // A newline in a value is the header-injection shape every HTTP stack refuses.
    expect(headerValueProblem('one\r\ntwo')).toBe('that value contains characters no HTTP header can carry')
    // An empty value is a legal header, and must not be mistaken for a refusal.
    expect(headerValueProblem('')).toBeUndefined()
    expect(headerValueProblem('Bearer abc.def')).toBeUndefined()
  })

  it('agrees with the constructor it defers to, both ways', () => {
    for (const name of ['X-Ok', 'authorization', 'x_under_score']) {
      expect(headerNameProblem(name, [])).toBeUndefined()
      expect(() => new Headers({ [name]: 'v' })).not.toThrow()
    }
    for (const name of ['bad name', 'bad:name', '']) {
      expect(headerNameProblem(name, [])).not.toBeUndefined()
    }
  })
})

describe('changing a draft', () => {
  it('appends a header the draft does not have', () => {
    expect(upsertHeader([], 'X-A', '1')).toEqual([{ name: 'X-A', value: '1' }])
  })

  it('replaces a value in place, keeping the row’s position and its original spelling', () => {
    const draft = [{ name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }]
    // The reader typed a different case; the header is the same one, and the
    // stored key must not be rewritten under them.
    expect(upsertHeader(draft, 'x-a', '9')).toEqual([
      { name: 'X-A', value: '9' },
      { name: 'X-B', value: '2' },
    ])
  })

  it('removes a header case-insensitively, leaving the rest in order', () => {
    const draft = [{ name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }]
    expect(removeHeader(draft, 'x-a')).toEqual([{ name: 'X-B', value: '2' }])
    expect(removeHeader(draft, 'X-Missing')).toEqual(draft)
  })
})

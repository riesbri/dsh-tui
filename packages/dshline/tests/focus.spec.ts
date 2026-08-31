/** Tests for the identity-keyed row cursor shared by the Work stages. */

import { describe, expect, it } from 'vitest'
import { FocusRing } from '../src/focus.ts'

describe('the identity-keyed focus ring', () => {
  it('aims at the first row of a list it has never seen', () => {
    const ring = new FocusRing()
    ring.update(['a', 'b', 'c'], true)
    expect(ring.current).toBe('a')
    expect(ring.position).toBe(0)
  })

  it('wraps in both directions so a list has no dead end', () => {
    const ring = new FocusRing()
    ring.update(['a', 'b', 'c'], true)
    ring.move(-1)
    expect(ring.current).toBe('c')
    ring.move(1)
    expect(ring.current).toBe('a')
    ring.move(2)
    expect(ring.current).toBe('c')
  })

  it('follows the aimed identity when a row is inserted above it', () => {
    const ring = new FocusRing()
    ring.update(['a', 'b'], true)
    ring.move(1)
    expect(ring.current).toBe('b')
    ring.update(['inserted', 'a', 'b'], true)
    expect(ring.current).toBe('b')
    expect(ring.position).toBe(2)
  })

  it('adopts the neighbour on a render but keeps a dead aim for an action', () => {
    const ring = new FocusRing()
    ring.update(['a', 'b', 'c'], true)
    ring.move(1)
    // An ACTION reads the ring without retargeting: the aim stays on the row the
    // human aimed at, so the caller can refuse instead of hitting its successor.
    ring.update(['a', 'c'], false)
    expect(ring.current).toBe('b')
    // The next RENDER re-anchors deliberately, onto the predictable neighbour.
    ring.update(['a', 'c'], true)
    expect(ring.current).toBe('c')
  })

  it('clamps to the last row when the tail of the list disappears', () => {
    const ring = new FocusRing()
    ring.update(['a', 'b', 'c'], true)
    ring.last()
    expect(ring.current).toBe('c')
    ring.update(['a'], true)
    expect(ring.current).toBe('a')
    expect(ring.position).toBe(0)
  })

  it('has no aim and no position while nothing is focusable', () => {
    const ring = new FocusRing()
    ring.update([], true)
    expect(ring.current).toBeUndefined()
    expect(ring.position).toBe(-1)
    ring.move(1)
    ring.first()
    ring.last()
    expect(ring.current).toBeUndefined()
  })

  it('can be aimed at an identity that is not present yet', () => {
    const ring = new FocusRing()
    ring.update(['a'], true)
    ring.aimAt('later')
    expect(ring.current).toBe('later')
    expect(ring.position).toBe(-1)
    ring.update(['a', 'later'], true)
    expect(ring.position).toBe(1)
  })
})

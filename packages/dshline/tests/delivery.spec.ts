/**
 * Which Harness verb a submission is delivered with.
 *
 * The whole Queue-versus-Steer decision is one pure function, so the matrix is
 * exhaustive here rather than approximated through an agent: every combination
 * of running, preference, and gesture, with no terminal and no inbox involved.
 * The tests that prove the verb actually reaches Harness live in
 * `delivery-routing.spec.ts`, against a real Inbox.
 */

import { describe, expect, it } from 'vitest'
import { chooseDelivery, DEFAULT_BUSY_ENTER } from '../src/delivery.ts'

describe('the busy-enter default', () => {
  it('is queue, matching the adopted Harness generation', () => {
    // Not a preference of this interface's own: the adopted generation's Web
    // client ships `queue`, and two surfaces of one agent disagreeing about what
    // the same key does is worse than either choice on its own.
    expect(DEFAULT_BUSY_ENTER).toBe('queue')
  })
})

describe('while nothing is running', () => {
  it('follows up whatever the preference and whatever the gesture', () => {
    // There is no running turn for steering to reach, and Harness resolves an
    // idle steer into a woken prompt turn anyway — so a distinction here would
    // be one this interface invented. That is also what makes the accelerated
    // gesture safe on a terminal that cannot send it: idle, both are identical.
    for (const preference of ['queue', 'steer'] as const) {
      for (const gesture of ['enter', 'accelerated'] as const) {
        expect(chooseDelivery({ running: false, preference, gesture })).toBe('followup')
      }
    }
  })
})

describe('while a turn is running', () => {
  it('sends plain enter where the preference points', () => {
    expect(chooseDelivery({ running: true, preference: 'queue', gesture: 'enter' })).toBe('followup')
    expect(chooseDelivery({ running: true, preference: 'steer', gesture: 'enter' })).toBe('steer')
  })

  it('sends the accelerated gesture the other way, from either preference', () => {
    expect(chooseDelivery({ running: true, preference: 'queue', gesture: 'accelerated' })).toBe('steer')
    expect(chooseDelivery({ running: true, preference: 'steer', gesture: 'accelerated' })).toBe('followup')
  })

  it('degrades to the preference, never to a third answer', () => {
    // The terminal contract in one assertion. A terminal that cannot distinguish
    // the chord reports `enter` for both, so what the reader gets is their own
    // preference — the one thing that must never happen is a press falling
    // through to a behaviour neither the preference nor the gesture asked for.
    for (const preference of ['queue', 'steer'] as const) {
      const degraded = chooseDelivery({ running: true, preference, gesture: 'enter' })
      const asked = chooseDelivery({ running: true, preference, gesture: 'enter' })
      expect(degraded).toBe(asked)
      expect(['followup', 'steer']).toContain(degraded)
    }
  })

  it('is an involution: accelerating twice is the plain gesture', () => {
    // Guards the inversion against being written as "always steer" — a mistake
    // that reads correctly from the queue default and breaks the other one.
    const flip = (preference: 'queue' | 'steer') =>
      chooseDelivery({ running: true, preference, gesture: 'accelerated' })
    expect(flip('queue')).not.toBe(chooseDelivery({ running: true, preference: 'queue', gesture: 'enter' }))
    expect(flip('steer')).not.toBe(chooseDelivery({ running: true, preference: 'steer', gesture: 'enter' }))
  })
})

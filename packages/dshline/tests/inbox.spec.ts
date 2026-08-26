/**
 * The pending-message mirror behind the status line's queued count.
 *
 * Harness reports every mutation of an agent's pending-message lists as a
 * normalized array splice. A bare counter fed from those splices would drift
 * the first time a step boundary drained an injection while a steering prompt
 * stayed parked, so the mirror replays spans against entry sources instead.
 * These tests pin the cases where replaying beats counting.
 */

import { describe, expect, it } from 'vitest'
import { InboxMirror } from '../src/inbox.ts'

/** A prompt the reader typed — the only kind the queued count reports. */
const TYPED = { source: { kind: 'user' } }

/** An injected context entry nobody typed, which the count ignores. */
const INJECTED = { source: { kind: 'provider' } }

/** One splice onto a list's end, the shape steering produces. */
const appended = (target: string, entries: ReadonlyArray<typeof TYPED | typeof INJECTED>) =>
  ({ target, start: 0, inserted: entries })

describe('the inbox mirror', () => {
  it('counts prompts the reader typed across both lists', () => {
    const mirror = new InboxMirror()
    mirror.spliced(appended('next-step', [TYPED]))
    expect(mirror.steered()).toBe(1)
    mirror.spliced(appended('next-turn', [TYPED]))
    expect(mirror.steered()).toBe(2)
  })

  it('ignores injected context nobody typed', () => {
    const mirror = new InboxMirror()
    mirror.spliced(appended('next-step', [INJECTED, INJECTED]))
    expect(mirror.steered()).toBe(0)
  })

  it('follows a drain that takes an injection and leaves the prompt parked', () => {
    // The case a running total gets wrong: removals name a span, not their
    // content, so only replaying the span against known sources can tell a
    // consumed prompt from a survived one.
    const mirror = new InboxMirror()
    mirror.spliced(appended('next-step', [TYPED, INJECTED]))
    expect(mirror.steered()).toBe(1)
    mirror.spliced({ target: 'next-step', start: 1, removedCount: 1, inserted: [] })
    expect(mirror.steered()).toBe(1)
    mirror.spliced({ target: 'next-step', start: 0, removedCount: 1, inserted: [] })
    expect(mirror.steered()).toBe(0)
  })

  it('clamps a span that reaches past what the mirror has seen', () => {
    // A mirror that attached mid-turn meets removals for entries it never saw.
    const mirror = new InboxMirror()
    mirror.spliced({ target: 'next-step', start: 0, removedCount: 5, inserted: [] })
    expect(mirror.steered()).toBe(0)
    // The clamp must also leave the insertion point truthful, not shifted into
    // imaginary positions by the over-removal.
    mirror.spliced(appended('next-step', [TYPED]))
    expect(mirror.steered()).toBe(1)
  })

  it('cancellation drains through the same splices', () => {
    const mirror = new InboxMirror()
    mirror.spliced(appended('next-step', [TYPED]))
    mirror.spliced({ target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    expect(mirror.steered()).toBe(0)
  })
})

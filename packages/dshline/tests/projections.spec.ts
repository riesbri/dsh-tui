/** Tests for the shared session-scoped projection observer. */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { SessionProjectionObserver } from '../src/projections/observer.ts'

/** A small registry fake that exposes only the observer contract. */
function registry(snapshot: ProjectionSnapshot = { asOfSeq: -1, values: {} }): {
  registry: {
    snapshot: (session: Session) => ProjectionSnapshot
    onChanged: (listener: (session: Session) => void) => () => void
  }
  change: (session: Session) => void
} {
  let listener: ((session: Session) => void) | undefined
  return {
    registry: {
      snapshot: () => snapshot,
      onChanged: next => {
        listener = next
        return () => { listener = undefined }
      },
    },
    change: session => { listener?.(session) },
  }
}

/** Let a queued redraw run after the registry's synchronous drive turn. */
async function microtask(): Promise<void> {
  await Promise.resolve()
}

describe('SessionProjectionObserver', () => {
  it('is safe without optional projection infrastructure', () => {
    const session = { id: 'one' } as Session
    const observer = new SessionProjectionObserver({ registry: undefined, session, invalidate: () => {} })
    expect(observer.available).toBe(false)
    expect(observer.snapshot()).toBeUndefined()
    observer.dispose()
  })

  it('reads the registry snapshot for its exact session', () => {
    const session = { id: 'one' } as Session
    const fake = registry({ asOfSeq: 4, values: {} })
    const observer = new SessionProjectionObserver({ registry: fake.registry as never, session, invalidate: () => {} })
    expect(observer.snapshot()).toEqual({ asOfSeq: 4, values: {} })
    observer.dispose()
  })

  it('coalesces exact-session changes until after the synchronous drive turn', async () => {
    const session = { id: 'one' } as Session
    const fake = registry()
    let invalidated = 0
    const observer = new SessionProjectionObserver({
      registry: fake.registry as never,
      session,
      invalidate: () => { invalidated += 1 },
    })
    fake.change(session)
    fake.change(session)
    expect(invalidated).toBe(0)
    await microtask()
    expect(invalidated).toBe(1)
    observer.dispose()
  })

  it('ignores another session and a replacement object with the same id', async () => {
    const session = { id: 'same' } as Session
    const replacement = { id: 'same' } as Session
    const fake = registry()
    let invalidated = 0
    const observer = new SessionProjectionObserver({
      registry: fake.registry as never, session, invalidate: () => { invalidated += 1 },
    })
    fake.change(replacement)
    await microtask()
    expect(invalidated).toBe(0)
    observer.dispose()
  })

  it('unsubscribes and suppresses a queued redraw on disposal', async () => {
    const session = { id: 'one' } as Session
    const fake = registry()
    let invalidated = 0
    const observer = new SessionProjectionObserver({
      registry: fake.registry as never, session, invalidate: () => { invalidated += 1 },
    })
    fake.change(session)
    observer.dispose()
    await microtask()
    expect(invalidated).toBe(0)
    fake.change(session)
    await microtask()
    expect(invalidated).toBe(0)
  })
})

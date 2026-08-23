/** Tests for the teardown that lets one window attach a second session. */

import { describe, expect, it } from 'vitest'
import { SessionScope } from '../src/session-scope.ts'

describe('session-scoped teardown', () => {
  it('runs disposers newest first', () => {
    // Registrations are made outermost-first, so a view registered after the
    // projection feeding it must come down before that projection.
    const order: string[] = []
    const scope = new SessionScope()
    scope.own(() => order.push('projection'))
    scope.own(() => order.push('view'))
    scope.dispose()
    expect(order).toEqual(['view', 'projection'])
  })

  it('runs every disposer even when one throws, then reports the failure', () => {
    // Leaving a transcript projection subscribed is a worse outcome than a failed
    // unregistration, so the rest still run — but the bug is not swallowed.
    const ran: string[] = []
    const scope = new SessionScope()
    scope.own(() => ran.push('first'))
    scope.own(() => { throw new Error('unregister failed') })
    scope.own(() => ran.push('third'))
    expect(() => { scope.dispose() }).toThrow('unregister failed')
    expect(ran).toEqual(['third', 'first'])
  })

  it('is idempotent, so a second teardown does not re-run anything', () => {
    let calls = 0
    const scope = new SessionScope()
    scope.own(() => { calls += 1 })
    scope.dispose()
    scope.dispose()
    expect(calls).toBe(1)
    expect(scope.closed).toBe(true)
  })

  it('disposes at once anything handed over after teardown', () => {
    // An asynchronous registration can land after the reader has already asked to
    // reopen another session. Retaining it would leak it silently.
    let disposed = false
    const scope = new SessionScope()
    scope.dispose()
    scope.own(() => { disposed = true })
    expect(disposed).toBe(true)
  })
})

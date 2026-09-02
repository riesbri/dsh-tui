import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { planModeAfter } from '../src/modes.ts'

/**
 * One log event, with only the fields the fold reads.
 * @param type - the event type.
 * @param data - the event's payload.
 * @returns the event.
 */
function event(type: string, data: unknown = {}): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

describe('planModeAfter()', () => {
  it('takes the state the event carries, whichever way it goes', () => {
    expect(planModeAfter(false, event('plan/mode', { active: true }))).toBe(true)
    expect(planModeAfter(true, event('plan/mode', { active: false }))).toBe(false)
  })

  it('takes the value rather than flipping, so repeating one changes nothing', () => {
    // The distinguishing case. Every alternating sequence agrees with a toggle,
    // so only a repeated assertion tells the two apart — and repeats happen:
    // `/plan` typed twice, or a log seeded from one that was already in plan mode.
    expect(planModeAfter(true, event('plan/mode', { active: true }))).toBe(true)
    expect(planModeAfter(false, event('plan/mode', { active: false }))).toBe(false)
    const repeated = [
      event('plan/mode', { active: true }),
      event('plan/mode', { active: true }),
    ]
    expect(repeated.reduce(planModeAfter, false)).toBe(true)
  })

  it('lets the last one win', () => {
    // A whole-value replace, not a transition: the event says what is true from
    // that point on, so folding is an assignment.
    const events = [
      event('plan/mode', { active: true }),
      event('turn/end', { turn: 1, reason: 'complete' }),
      event('plan/mode', { active: false }),
    ]
    expect(events.reduce(planModeAfter, false)).toBe(false)
  })

  it('leaves the state alone for every other event', () => {
    expect(planModeAfter(true, event('turn/start', { turn: 1 }))).toBe(true)
    expect(planModeAfter(false, event('tool/call', {}))).toBe(false)
  })

  it('reads a log with no such event as inactive', () => {
    expect([event('turn/start'), event('turn/end')].reduce(planModeAfter, false)).toBe(false)
  })
})

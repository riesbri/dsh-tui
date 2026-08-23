import { describe, expect, it } from 'vitest'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { goalReading, planModeAfter } from '../src/modes.ts'

/**
 * One log event, with only the fields the fold reads.
 * @param type - the event type.
 * @param data - the event's payload.
 * @returns the event.
 */
function event(type: string, data: unknown = {}): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

/**
 * The goal service's view of one goal.
 * @param over - the fields that matter to this test.
 * @returns the view.
 */
function view(over: Partial<GoalView>): GoalView {
  return {
    objective: 'ship it',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 3,
    maxGoalRounds: 256,
    ...over,
  } as unknown as GoalView
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

describe('goalReading()', () => {
  it('reports nothing when there is no goal', () => {
    expect(goalReading(undefined)).toBeUndefined()
  })

  it('counts the rounds while the goal is running, and says what it is', () => {
    // "How far through" is the question about a run nobody watched start, and
    // "what is it" is the question about a goal nobody set — which happens, since
    // the harness's create_goal tool is model-callable.
    expect(goalReading(view({}))).toEqual({ label: 'goal 3/256 · ship it', short: 'goal 3/256', running: true })
  })

  it('says armed rather than nought of a cap no round has approached', () => {
    // `goal 0/256` reads as a progress meter stuck at zero. It is not progress at
    // all: 256 is the deployment's round cap, and nothing has been spent against
    // it. The count earns its place once there is a count to report.
    expect(goalReading(view({ roundsStarted: 0 })))
      .toEqual({ label: 'goal armed · ship it', short: 'goal armed', running: true })
  })

  it('marks a goal that is set but will not continue on its own', () => {
    // Every reopened session starts here: activation is process-local and never
    // persisted, so a resumed log holding an active goal is not a session about
    // to run one. The round count alone would say otherwise.
    expect(goalReading(view({ activation: 'disarmed' })))
      .toEqual({ label: 'goal idle · ship it', short: 'goal idle', running: false })
  })

  it('replaces the count with the phase once the goal is not active', () => {
    // The round number of a paused goal is history, not progress.
    for (const phase of ['paused', 'blocked', 'complete'] as const) {
      expect(goalReading(view({ phase })), phase)
        .toEqual({ label: `goal ${phase} · ship it`, short: `goal ${phase}`, running: false })
    }
  })

  it('bounds a long objective itself, so the status line never has to cut one', () => {
    const long = goalReading(view({ objective: 'migrate every call site off the deprecated adapter' }))
    expect(long?.label).toBe('goal 3/256 · migrate every call site off…')
    expect(long?.short).toBe('goal 3/256')
  })

  it('shows an escape sequence in an objective instead of obeying it', () => {
    // A model writes the objective and it reaches the terminal on every frame.
    expect(goalReading(view({ objective: 'ship\u001b[2Jit' }))?.label).toContain('^[[2J')
  })

  it('never calls a goal running unless it is both active and armed', () => {
    expect(goalReading(view({ phase: 'paused', activation: 'armed' }))?.running).toBe(false)
    expect(goalReading(view({ phase: 'active', activation: 'disarmed' }))?.running).toBe(false)
    expect(goalReading(view({ phase: 'active', activation: 'armed' }))?.running).toBe(true)
  })
})

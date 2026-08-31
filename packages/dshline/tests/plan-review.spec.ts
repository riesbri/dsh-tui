/**
 * The plan decision needs a bounded, readable presentation rather than a
 * generic picker detail — and reading a long plan in full is a deliberate
 * Ctrl+O document mode, not something the decision surface itself pages
 * through.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { createPlanReviewOverlay } from '../src/plan-review.ts'

/** Choices the plan-mode tool sends with a review request. */
const CHOICES = [
  {
    value: 'Approve',
    label: 'Approve',
    description: 'Leave plan mode; the plan is carried out from the next step.',
  },
  {
    value: 'Keep planning',
    label: 'Keep planning',
    description: 'Stay in plan mode; feedback goes back to the model.',
  },
] as const

/** Three choices make backwards motion distinguishable from forwards motion. */
const DIRECTION_CHOICES = [
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
] as const

/** A plan long enough to overflow any preview, with sentinels for either end. */
const LONG_PLAN = `# Release plan\n- PLAN-FIRST-SENTINEL\n${
  Array.from({ length: 30 }, (_, index) => `- step ${String(index + 2)}`).join('\n')
}\n- PLAN-LAST-SENTINEL`

/** Remove styling so assertions name exactly the text a person reads. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

describe('plan review', () => {
  it('shows a short plan entirely in the preview, with no ctrl-o advertised', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Release plan\n- one small step',
      question: 'Approve this plan and leave plan mode?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    const frame = plain(overlay.render(80, 24)).join('\n')
    expect(frame).toContain('Plan review')
    expect(frame).toContain('Release plan')
    expect(frame).toContain('one small step')
    expect(frame).not.toContain('ctrl-o')
    expect(frame).not.toContain('more line')
  })

  it('bounds a long plan to a preview and advertises ctrl-o with a remaining count', () => {
    const overlay = createPlanReviewOverlay({
      plan: LONG_PLAN,
      question: 'Approve this plan and leave plan mode?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    const frame = plain(overlay.render(80, 24)).join('\n')
    expect(frame).toContain('Plan review')
    expect(frame).toContain('PLAN-FIRST-SENTINEL')
    expect(frame).not.toContain('PLAN-LAST-SENTINEL')
    expect(frame).toMatch(/\d+ more lines?, ctrl-o to view whole plan/u)
    expect(frame).toContain('ctrl-o view plan')
    expect(frame.split('\n').every(row => displayWidth(row) <= 80)).toBe(true)
  })

  it('never renders more terminal rows than are available', () => {
    for (const rows of [0, 1, 2, 3, 4, 5, 6, 8, 15, 24]) {
      const overlay = createPlanReviewOverlay({
        plan: LONG_PLAN,
        question: 'Approve this plan?',
        choices: CHOICES,
        settle: () => {},
        invalidate: () => {},
      })
      expect(overlay.render(80, rows).length, `${String(rows)} rows`).toBeLessThanOrEqual(rows)
    }
  })

  it('uses an unboxed decision when the minimum frame would exceed the terminal width', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Release plan\n- hidden until resized',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    const narrow = plain(overlay.render(10, 15))
    expect(narrow.length).toBeLessThanOrEqual(15)
    expect(narrow.every(row => displayWidth(row) <= 10)).toBe(true)
    expect(narrow.join('\n')).toContain('Decision')
  })

  it('keeps a compact decision-only review inside a terminal too short for one plan row', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Release plan\n- hidden until resized',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    const compact = plain(overlay.render(80, 8))
    expect(compact).toHaveLength(5)
    // Too short to preview even this two-line plan, but tall enough that
    // Ctrl+O's own inspector frame fits — so the hint offers it rather than a
    // resize that is not actually necessary to read the plan.
    expect(compact.join('\n')).toContain('ctrl-o to read the plan')
    expect(compact.join('\n')).not.toContain('hidden until resized')
    expect(compact.at(-1)).toMatch(/^╰─ .*esc cancel .*─╯$/u)
  })

  it('makes option text safe before putting it in the frame', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Plan',
      question: 'Approve this plan?',
      choices: [{
        value: 'Approve',
        label: 'Approve[2J',
        description: 'Leave plan mode[2J and begin the work.',
      }],
      settle: () => {},
      invalidate: () => {},
    })
    const frame = overlay.render(80, 24).join('\n')
    expect(frame).not.toContain('[2J')
    expect(stripAnsi(frame)).toContain('Approve^[[2J')
    expect(stripAnsi(frame)).toContain('Leave plan mode^[[2J and begin the work.')
  })

  it.each([
    ['up', 'C'],
    ['down', 'B'],
    ['tab', 'B'],
  ] as const)('moves the decision with %s', (key, expected) => {
    let answer: string | undefined = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: '# Plan',
      question: 'Approve this plan?',
      choices: DIRECTION_CHOICES,
      settle: value => { answer = value },
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: key })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(answer).toBe(expected)
  })

  it('cancels from the review surface with Esc or Ctrl+C', () => {
    let answer: string | undefined = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: LONG_PLAN,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { answer = value },
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(answer).toBeUndefined()
  })

  it('settles only once, even if a stray key arrives after dismissal', () => {
    const settles: (string | undefined)[] = []
    const overlay = createPlanReviewOverlay({
      plan: '# Plan',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { settles.push(value) },
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(settles).toEqual(['Approve'])
  })
})

describe('full-plan inspection', () => {
  it('does nothing on Ctrl+O when the preview already shows the whole plan', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Release plan\n- one small step',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    const frame = plain(overlay.render(80, 24)).join('\n')
    expect(frame).toContain('Plan review')
  })

  it('enters full-plan inspection with ctrl-o and reaches late sections continuously', () => {
    let redraws = 0
    const overlay = createPlanReviewOverlay({
      plan: LONG_PLAN,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => { redraws += 1 },
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    expect(redraws).toBe(1)
    const opened = plain(overlay.render(80, 24)).join('\n')
    expect(opened).toContain('PLAN-FIRST-SENTINEL')
    expect(opened).not.toContain('Plan review')
    expect(opened).not.toContain('Decision')

    for (let index = 0; index < 40; index += 1) overlay.handleKey({ kind: 'key', name: 'down' })
    const scrolled = plain(overlay.render(80, 24)).join('\n')
    expect(scrolled).toContain('PLAN-LAST-SENTINEL')

    overlay.handleKey({ kind: 'key', name: 'home' })
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('PLAN-FIRST-SENTINEL')
    overlay.handleKey({ kind: 'key', name: 'end' })
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('PLAN-LAST-SENTINEL')
  })

  it('returns to the review with ctrl-o or esc, without answering or cancelling', () => {
    let settled: string | undefined | 'unanswered' = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: LONG_PLAN,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { settled = value },
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    overlay.handleKey({ kind: 'key', name: 'down' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(settled).toBe('unanswered')
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('Plan review')

    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    expect(settled).toBe('unanswered')
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('Plan review')
  })

  it('preserves the selected decision across an inspection round-trip', () => {
    let answer: string | undefined = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: LONG_PLAN,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { answer = value },
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'down' }) // select "Keep planning"
    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    overlay.handleKey({ kind: 'key', name: 'down' })
    overlay.handleKey({ kind: 'key', name: 'end' })
    overlay.handleKey({ kind: 'key', name: 'escape' }) // back to review, not cancelled
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(answer).toBe('Keep planning')
  })

  it('never renders more than the terminal height, in either mode', () => {
    const overlay = createPlanReviewOverlay({
      plan: LONG_PLAN,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    for (const rows of [1, 3, 6, 7, 10, 15, 24]) {
      expect(overlay.render(80, rows).length, `review ${String(rows)}`).toBeLessThanOrEqual(rows)
    }
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    for (const rows of [1, 3, 6, 7, 10, 15, 24]) {
      expect(overlay.render(80, rows).length, `inspect ${String(rows)}`).toBeLessThanOrEqual(rows)
    }
  })

  it('keeps inspection inside a narrow terminal, falling back below its floor', () => {
    const overlay = createPlanReviewOverlay({
      plan: LONG_PLAN,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'ctrl-o' })
    for (const columns of [10, 20, 30]) {
      const frame = plain(overlay.render(columns, 15))
      expect(frame.length).toBeLessThanOrEqual(15)
      expect(frame.every(row => displayWidth(row) <= columns)).toBe(true)
    }
  })
})

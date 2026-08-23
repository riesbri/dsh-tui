/** The plan decision needs a bounded, readable presentation rather than a generic picker detail. */

import { describe, expect, it } from 'vitest'
import { displayWidth, stripAnsi } from 'dshline-renderer'
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

/** Remove styling so assertions name exactly the text a person reads. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

describe('plan review', () => {
  it('renders a markdown plan in a bounded window that reaches every row by paging', () => {
    let redraws = 0
    const overlay = createPlanReviewOverlay({
      plan: `# Release plan\n\n${Array.from({ length: 18 }, (_, index) => `- unique step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan and leave plan mode?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => { redraws += 1 },
    })

    const first = plain(overlay.render(40, 24))
    // The specialized review identifies the document and parses its markdown;
    // the generic picker used to show it as dim, truncated option detail.
    expect(first.join('\n')).toContain('Plan review')
    expect(first.join('\n')).toContain('Release plan')
    expect(first.join('\n')).toContain('• unique step 1')
    expect(first.join('\n')).not.toContain('• unique step 18')
    expect(first.join('\n')).toContain('rows 1–10 of 20')
    expect(first.every(row => displayWidth(row) <= 40)).toBe(true)

    // Two pages with the one-row overlap reach the final page.
    overlay.handleKey({ kind: 'key', name: 'right' })
    overlay.handleKey({ kind: 'key', name: 'right' })
    const last = plain(overlay.render(40, 24))
    expect(redraws).toBe(2)
    expect(last.join('\n')).toContain('• unique step 18')
    expect(last.join('\n')).toContain('rows 11–20 of 20')
  })

  it('pages one viewport at a time, not one line, and clamps at both ends', () => {
    const overlay = createPlanReviewOverlay({
      plan: `# Plan\n${Array.from({ length: 40 }, (_, index) => `paged step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    // 41 total rows, 10 visible -> one page is a jump of 9, so only a handful of
    // presses can cross the whole document.
    const bottom = plain(overlay.render(80, 24))
    expect(bottom.join('\n')).toContain('rows 1–10 of 41')
    for (let index = 0; index < 4; index += 1) overlay.handleKey({ kind: 'key', name: 'right' })
    const paged = plain(overlay.render(80, 24))
    expect(paged.join('\n')).toContain('rows 32–41 of 41')
    // At the end, further paging does not scroll off.
    overlay.handleKey({ kind: 'key', name: 'right' })
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('rows 32–41 of 41')
    // Home returns to the first page, clamped so the top row is always reachable.
    overlay.handleKey({ kind: 'key', name: 'home' })
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('rows 1–10 of 41')
  })

  it('uses fewer plan rows in a short terminal and retains its scroll position on resize', () => {
    const overlay = createPlanReviewOverlay({
      plan: `# Release plan\n${Array.from({ length: 30 }, (_, index) => `- resize step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'right' })
    const short = plain(overlay.render(80, 15))
    expect(short).toHaveLength(15)
    expect(short.join('\n')).toContain('rows 10–13 of 31')
    expect(short.join('\n')).toContain('• resize step 10')

    const tall = plain(overlay.render(80, 24))
    expect(tall.join('\n')).toContain('rows 10–19 of 31')
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 8, 15, 24])('never renders more than %i terminal rows', rows => {
    const overlay = createPlanReviewOverlay({
      plan: '# Release plan\n- hidden until resized',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    expect(overlay.render(80, rows).length).toBeLessThanOrEqual(rows)
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
    expect(narrow.join('\n')).not.toContain('rows 1–')
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
    expect(compact).toHaveLength(6)
    expect(compact.join('\n')).toContain('resize terminal to read the plan')
    expect(compact.join('\n')).not.toContain('hidden until resized')
  })

  it('makes option text safe before putting it in the frame', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Plan',
      question: 'Approve this plan?',
      choices: [{
        value: 'Approve',
        label: 'Approve\u001b[2J',
        description: 'Leave plan mode\u001b[2J and begin the work.',
      }],
      settle: () => {},
      invalidate: () => {},
    })
    const frame = overlay.render(80, 24).join('\n')
    expect(frame).not.toContain('\u001b[2J')
    expect(stripAnsi(frame)).toContain('Approve^[[2J')
    expect(stripAnsi(frame)).toContain('Leave plan mode^[[2J and begin the work.')
  })

  it('pages the plan without changing which answer enter confirms', () => {
    let answer: string | undefined = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: `# Plan\n${Array.from({ length: 12 }, (_, index) => `step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { answer = value },
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'right' })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(answer).toBe('Approve')
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

  it('pages the plan with left/right instead of moving one line', () => {
    let redraws = 0
    const overlay = createPlanReviewOverlay({
      plan: `# Plan\n${Array.from({ length: 30 }, (_, index) => `step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan?',
      choices: DIRECTION_CHOICES,
      settle: () => {},
      invalidate: () => { redraws += 1 },
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'left' }) // page up is clamped at the start
    expect(redraws).toBe(0)
    overlay.handleKey({ kind: 'key', name: 'right' })
    overlay.handleKey({ kind: 'key', name: 'right' })
    // Two pages cross most of a 31-row document, never one line per press.
    expect(redraws).toBe(2)
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('rows 19–28 of 31')
  })

  it('honours Home and End for the plan and Esc for cancel', () => {
    let answer: string | undefined = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: `# Plan\n${Array.from({ length: 25 }, (_, index) => `step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { answer = value },
      invalidate: () => {},
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'end' })
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('rows 17–26 of 26')
    overlay.handleKey({ kind: 'key', name: 'home' })
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('rows 1–10 of 26')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(answer).toBeUndefined()
  })

  it('advertises the actual controls in the plan help line', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Plan\n- a step',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    const help = plain(overlay.render(80, 24)).at(-1) ?? ''
    // The help names the controls that are actually wired: decisions move with
    // up/down and the plan pages with left/right.
    expect(help).toContain('↑↓ decision')
    expect(help).toContain('←→ plan page')
    expect(help).toContain('enter confirm')
    expect(help).toContain('esc cancel')
  })

  it('keeps the compact help naming keys that behave as wired', () => {
    const overlay = createPlanReviewOverlay({
      plan: '# Plan\n- hidden',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => {},
    })
    const compact = plain(overlay.render(80, 8))
    expect(compact.join('\n')).toContain('↑↓ decision')
    expect(compact.join('\n')).not.toContain('←→ decision')
    expect(compact.join('\n')).not.toContain('←→ choose')
  })
})

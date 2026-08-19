/** The plan decision needs a bounded, readable presentation rather than a generic picker detail. */

import { describe, expect, it } from 'vitest'
import { displayWidth, stripAnsi } from '@riesbri/dsh-tui-renderer'
import { createPlanReviewOverlay } from '../src/plan-review.ts'

/** Choices the plan-mode tool sends with a review request. */
const CHOICES = [
  { value: 'Approve', label: 'Approve' },
  { value: 'Keep planning', label: 'Keep planning' },
] as const

/** Remove styling so assertions name exactly the text a person reads. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

describe('plan review', () => {
  it('renders a markdown plan in a bounded window that reaches every row', () => {
    let redraws = 0
    const overlay = createPlanReviewOverlay({
      plan: `# Release plan\n\n${Array.from({ length: 18 }, (_, index) => `- unique step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan and leave plan mode?',
      choices: CHOICES,
      settle: () => {},
      invalidate: () => { redraws += 1 },
    })

    const first = plain(overlay.render(40))
    // The specialized review identifies the document and parses its markdown;
    // the generic picker used to show it as dim, truncated option detail.
    expect(first.join('\n')).toContain('Plan review')
    expect(first.join('\n')).toContain('Release plan')
    expect(first.join('\n')).toContain('• unique step 1')
    expect(first.join('\n')).not.toContain('• unique step 18')
    expect(first.join('\n')).toContain('rows 1–10 of 20')
    expect(first.every(row => displayWidth(row) <= 40)).toBe(true)

    for (let index = 0; index < 20; index += 1) overlay.handleKey({ kind: 'key', name: 'down' })
    const last = plain(overlay.render(40))
    expect(redraws).toBe(10)
    expect(last.join('\n')).toContain('• unique step 18')
    expect(last.join('\n')).toContain('rows 11–20 of 20')
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
    const frame = overlay.render(80).join('\n')
    expect(frame).not.toContain('\u001b[2J')
    expect(stripAnsi(frame)).toContain('Approve^[[2J')
    expect(stripAnsi(frame)).toContain('Leave plan mode^[[2J and begin the work.')
  })

  it('scrolls the plan without changing which answer enter confirms', () => {
    let answer: string | undefined = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: `# Plan\n${Array.from({ length: 12 }, (_, index) => `step ${String(index + 1)}`).join('\n')}`,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { answer = value },
      invalidate: () => {},
    })
    overlay.render(80)
    overlay.handleKey({ kind: 'key', name: 'down' })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(answer).toBe('Approve')
  })

  it('changes the decision with tab instead of making the plan unreachable', () => {
    let answer: string | undefined = 'unanswered'
    const overlay = createPlanReviewOverlay({
      plan: '# Plan',
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: value => { answer = value },
      invalidate: () => {},
    })
    overlay.render(80)
    overlay.handleKey({ kind: 'key', name: 'tab' })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(answer).toBe('Keep planning')
  })
})

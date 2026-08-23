/** A long plan must remain a live overlay, never scrollback debris. */

import { describe, expect, it } from 'vitest'
import { Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { createPlanReviewOverlay } from '../src/plan-review.ts'

/** The width used by the real-terminal regression frames. */
const COLUMNS = 80

/** The choices and descriptions emitted by the plan-mode exit tool. */
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

/** The long plan needs sentinels whose names cannot overlap. */
const PLAN = [
  '# Huge plan',
  '- PLAN-FIRST-SENTINEL',
  ...Array.from({ length: 98 }, (_, index) => `- PLAN-STEP-${String(index + 2)}`),
  '- PLAN-LAST-SENTINEL',
].join('\n')

describe('plan review on a real terminal', () => {
  it.each([24, 15])('keeps a long plan inside a %i-row terminal', async rows => {
    const emulator = createEmulator(COLUMNS, rows)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT before plan A', 'TRANSCRIPT before plan B'])
    let overlay!: ReturnType<typeof createPlanReviewOverlay>
    const draw = (): void => { screen.setLive(overlay.render(COLUMNS, rows)) }
    overlay = createPlanReviewOverlay({
      plan: PLAN,
      question: 'Approve this plan and leave plan mode?',
      choices: CHOICES,
      settle: () => {},
      invalidate: draw,
    })

    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    for (let index = 0; index < 150; index += 1) overlay.handleKey({ kind: 'key', name: 'right' })

    const visible = await emulator.screen()
    const all = await emulator.scrollback()
    expect(visible.join('\n')).toContain('PLAN-LAST-SENTINEL')
    expect(all.filter(line => line.includes('PLAN-FIRST-SENTINEL'))).toHaveLength(0)
    expect(all.filter(line => line.includes('TRANSCRIPT before plan A'))).toHaveLength(1)
    expect(all.filter(line => line.includes('TRANSCRIPT before plan B'))).toHaveLength(1)
    expect(all.filter(line => line.includes('Plan review'))).toHaveLength(1)
    emulator.dispose()
  })

  it('keeps an ultra-compact review out of scrollback in a five-row terminal', async () => {
    const rows = 5
    const emulator = createEmulator(COLUMNS, rows)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT before compact A', 'TRANSCRIPT before compact B'])
    let overlay!: ReturnType<typeof createPlanReviewOverlay>
    const draw = (): void => { screen.setLive(overlay.render(COLUMNS, rows)) }
    overlay = createPlanReviewOverlay({
      plan: PLAN,
      question: 'Approve this plan?',
      choices: CHOICES,
      settle: () => {},
      invalidate: draw,
    })

    draw()
    for (let index = 0; index < 30; index += 1) overlay.handleKey({ kind: 'key', name: 'down' })
    const visible = await emulator.screen()
    const all = await emulator.scrollback()
    expect(visible.length).toBeLessThanOrEqual(rows)
    expect(all.filter(line => line.includes('TRANSCRIPT before compact A'))).toHaveLength(1)
    expect(all.filter(line => line.includes('TRANSCRIPT before compact B'))).toHaveLength(1)
    expect(all.filter(line => line.includes('Decision:'))).toHaveLength(1)
    emulator.dispose()
  })

  it('keeps multiline review chrome inside a fifteen-row terminal', async () => {
    const rows = 15
    const emulator = createEmulator(COLUMNS, rows)
    const screen = new Screen(emulator.target)
    let overlay!: ReturnType<typeof createPlanReviewOverlay>
    const draw = (): void => { screen.setLive(overlay.render(COLUMNS, rows)) }
    overlay = createPlanReviewOverlay({
      plan: PLAN,
      question: 'Approve this plan\nand leave plan mode?',
      choices: [{
        value: 'Approve',
        label: 'Approve\nplan',
        description: 'Leave plan mode;\nthe plan is carried out next.',
      }, {
        value: 'Keep planning',
        label: 'Keep\nplanning',
        description: 'Stay in plan mode;\nfeedback goes to the model.',
      }],
      settle: () => {},
      invalidate: draw,
    })

    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    for (let index = 0; index < 150; index += 1) overlay.handleKey({ kind: 'key', name: 'right' })
    expect((await emulator.screen()).join('\n')).toContain('PLAN-LAST-SENTINEL')
    emulator.dispose()
  })
})

/**
 * Capability probe: `ctx.userQuestions`.
 *
 * Exercises the exact seam `installQuestionProvider` consumes against the
 * real `@deepseek-ai/dsh-user-questions` service — not a dshline-shaped fake
 * — through a real `TuiSlots` overlay stack, so a real request reaches a real
 * terminal-provider boundary and a real structured answer comes back. This is
 * also the one probe whose two registration branches (Harness ≤0.1.1's
 * `registerProvider`, ≥0.1.2's `user-questions/request` waterfall) are both
 * exercised automatically: `installQuestionProvider` feature-detects at
 * runtime, so this same file proves whichever shape the linked/pinned
 * package actually publishes, without knowing which one that is.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import { installQuestionProvider } from '../../src/questions.ts'
import { TuiSlots } from '../../src/slots.ts'

/** Let a registration/dispatch settle across whatever the mounted Harness version's own async boundaries are. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

describe('capability: userQuestions', () => {
  it('carries a real Harness question request to a real terminal answer', async () => {
    const ctx = new Context()
    await ctx.plugin(TuiSlots)
    await ctx.plugin(UserQuestionService)
    const dispose = installQuestionProvider(ctx)
    try {
      const answer = ctx.userQuestions.ask({
        questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }],
      })
      await settled()
      expect(ctx.tuiSlots.activeOverlay).toBeDefined()
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'enter' })
      await expect(answer).resolves.toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
      expect(ctx.tuiSlots.activeOverlay).toBeUndefined()
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('the dedicated plan-review overlay still renders through the real seam', async () => {
    const ctx = new Context()
    await ctx.plugin(TuiSlots)
    await ctx.plugin(UserQuestionService)
    const dispose = installQuestionProvider(ctx)
    try {
      const answer = ctx.userQuestions.ask({
        questions: [{
          id: 'plan-review',
          header: 'Plan review',
          question: 'Approve this plan and leave plan mode?',
          detail: '# Clear outcome\n\n- read every line',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      })
      await settled()
      const shown = ctx.tuiSlots.activeOverlay?.render(80).join('\n') ?? ''
      expect(shown).toContain('Clear outcome')
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'enter' })
      await expect(answer).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('disposes cleanly: no answerer remains registered afterward', async () => {
    const ctx = new Context()
    await ctx.plugin(TuiSlots)
    await ctx.plugin(UserQuestionService)
    const dispose = installQuestionProvider(ctx)
    dispose()
    dispose() // idempotent, matching Harness's own HMR-safe disposal contract
    try {
      await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
        .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/**
 * Capability probe: `ctx.userQuestions`.
 *
 * Exercises the exact seam `installQuestionProvider` consumes against the
 * real `@deepseek-ai/dsh-user-questions` service — not a dshline-shaped fake
 * — through a real `TuiSlots` overlay stack, so a real request reaches a real
 * terminal-provider boundary and a real structured answer comes back.
 * `installQuestionProvider` feature-detects its registration shape at
 * runtime, so this one file automatically proves whichever the
 * linked/pinned package actually publishes (Minimum's `registerProvider`, or
 * Edge's `user-questions/request` waterfall) without knowing which one that
 * is. Presentation behavior (plan-review, cancellation, …) is covered by the
 * ordinary `tests/questions.spec.ts`; this file is only the capability
 * contract.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it } from 'vitest'
import { installQuestionProvider } from '../../src/questions.ts'
import { TuiSlots } from '../../src/slots.ts'

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
      // Dispatch is synchronous up to the overlay push on both registration
      // shapes (cordis's own registerProvider and waterfall dispatch never
      // insert a microtask before calling the first listener), so the
      // overlay is already mounted here — no wait needed.
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'enter' })
      await expect(answer).resolves.toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
      expect(ctx.tuiSlots.activeOverlay).toBeUndefined()
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

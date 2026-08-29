/** Plan-review questions take their dedicated overlay instead of a generic detail picker. */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { stripAnsi } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { installQuestionProvider } from '../src/questions.ts'

/**
 * A context just large enough to retain the questions provider and its overlay,
 * faking Harness ≤0.1.1's single-provider `registerProvider()` shape.
 * @returns the context plus readers for the provider and active overlay.
 */
function questionContext(): {
  ctx: Context
  ask(): ((request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>) | undefined
  overlay(): TuiOverlay | undefined
} {
  let provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> } | undefined
  let active: TuiOverlay | undefined
  const ctx = {
    userQuestions: {
      registerProvider(next: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }) {
        provider = next
        return () => {}
      },
    },
    tuiSlots: {
      invalidate: () => {},
      pushOverlay(next: TuiOverlay) {
        active = next
        return () => { active = undefined }
      },
    },
  } as unknown as Context
  return { ctx, ask: () => provider?.ask, overlay: () => active }
}

/** A listener registered through `ctx.on('user-questions/request', …)`. */
type WaterfallListener = (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>

/**
 * A context faking Harness ≥0.1.2's waterfall shape: `ctx.userQuestions` has no
 * `registerProvider` at all, so {@link installQuestionProvider} must fall
 * through to `ctx.on('user-questions/request', …)`.
 * @returns the context plus readers for the registered listener and active overlay.
 */
function waterfallQuestionContext(): {
  ctx: Context
  next: ReturnType<typeof vi.fn>
  request(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> | undefined
  overlay(): TuiOverlay | undefined
} {
  let listener: WaterfallListener | undefined
  let active: TuiOverlay | undefined
  const next = vi.fn(() => Promise.reject(new Error('no further answerer: dshline must claim, never delegate')))
  const ctx = {
    // Deliberately no registerProvider: this is exactly the shape that made
    // Harness 0.1.2 remove it.
    userQuestions: {},
    on(event: string, fn: WaterfallListener) {
      if (event !== 'user-questions/request') throw new Error(`unexpected event ${event}`)
      listener = fn
      return () => { listener = undefined }
    },
    tuiSlots: {
      invalidate: () => {},
      pushOverlay(overlay: TuiOverlay) {
        active = overlay
        return () => { active = undefined }
      },
    },
  } as unknown as Context
  return {
    ctx,
    next,
    request: req => listener?.(req, next),
    overlay: () => active,
  }
}

describe('plan-review questions', () => {
  it('uses the scrollable plan presentation and preserves the ordinary answer protocol', async () => {
    const { ctx, ask, overlay } = questionContext()
    installQuestionProvider(ctx)
    const request = ask()
    expect(request).toBeDefined()

    const answer = request?.({
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: '# Clear outcome\n\n- read every line',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    } as AskUserQuestionRequest)
    const shown = stripAnsi(overlay()?.render(80).join('\n') ?? '')
    expect(shown).toContain('Plan review')
    expect(shown).toContain('Clear outcome')
    expect(shown).toContain('• read every line')

    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  })

  it('reports a dismissed plan as a cancellation, not a request to keep planning', async () => {
    const { ctx, ask, overlay } = questionContext()
    installQuestionProvider(ctx)
    const answer = ask()?.({
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    } as AskUserQuestionRequest)
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await expect(answer).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('dismisses the review and rejects when its calling tool is aborted', async () => {
    const { ctx, ask, overlay } = questionContext()
    installQuestionProvider(ctx)
    const abort = new AbortController()
    const answer = ask()?.({
      signal: abort.signal,
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    } as AskUserQuestionRequest)
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(overlay()).toBeUndefined()
  })
})

describe('waterfall registration (Harness 0.1.2+)', () => {
  it('falls back to ctx.on when no legacy registerProvider is present', async () => {
    const { ctx, request } = waterfallQuestionContext()
    installQuestionProvider(ctx)
    const answer = request({
      questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }],
    } as AskUserQuestionRequest)
    expect(answer).toBeDefined()
  })

  it('always claims: next() is never called for a request dshline can present', async () => {
    const { ctx, next, request, overlay } = waterfallQuestionContext()
    installQuestionProvider(ctx)
    const answer = request({
      questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }],
    } as AskUserQuestionRequest)
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
    expect(next).not.toHaveBeenCalled()
  })

  it('still uses the dedicated plan-review overlay under waterfall registration', async () => {
    const { ctx, request, overlay } = waterfallQuestionContext()
    installQuestionProvider(ctx)
    const answer = request({
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: '# Clear outcome\n\n- read every line',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    } as AskUserQuestionRequest)
    const shown = stripAnsi(overlay()?.render(80).join('\n') ?? '')
    expect(shown).toContain('Plan review')
    expect(shown).toContain('Clear outcome')

    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  })

  it('disposes cleanly: a disposed answerer is no longer registered', () => {
    const { ctx, request } = waterfallQuestionContext()
    const dispose = installQuestionProvider(ctx)
    dispose()
    dispose() // idempotent, matching Harness's own HMR-safe disposal contract
    expect(request({ questions: [{ id: 'confirm', question: 'Proceed?' }] } as AskUserQuestionRequest)).toBeUndefined()
  })
})

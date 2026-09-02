/** Plan-review questions take their dedicated overlay instead of a generic detail picker. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { stripAnsi } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { installQuestionProvider } from '../src/questions.ts'

/** One answerer as Harness's `user-questions/request` waterfall would call it. */
type Answerer = (
  request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

/**
 * A context just large enough to retain the questions answerer and its overlay.
 *
 * The registration is the real one: `ctx.on('user-questions/request', …)`, the
 * scoped waterfall Harness publishes. `ask()` is what the service's own
 * `ctx.waterfall(...)` would invoke.
 * @returns the context plus readers for the answerer and active overlay.
 */
function questionContext(): {
  ctx: Context
  ask(): Answerer | undefined
  send(request: AskUserQuestionRequestEvent): Promise<AskUserQuestionAnswer> | undefined
  overlay(): TuiOverlay | undefined
  events(): string[]
} {
  let answerer: Answerer | undefined
  let active: TuiOverlay | undefined
  const events: string[] = []
  const ctx = {
    on(event: string, listener: Answerer) {
      events.push(event)
      answerer = listener
      return () => { answerer = undefined }
    },
    tuiSlots: {
      invalidate: () => {},
      pushOverlay(next: TuiOverlay) {
        active = next
        return () => { active = undefined }
      },
    },
  } as unknown as Context
  return {
    ctx,
    ask: () => answerer,
    // A `next` that fails loudly: this answerer is terminal, so reaching for
    // it is the regression, not a fallback.
    send: request => answerer?.(request, () => Promise.reject(new Error('delegated down the waterfall'))),
    overlay: () => active,
    events: () => events,
  }
}

describe('the user-questions registration', () => {
  it('registers on the scoped waterfall Harness publishes, and unregisters on dispose', () => {
    const { ctx, ask, events } = questionContext()
    const dispose = installQuestionProvider(ctx)
    expect(events()).toEqual(['user-questions/request'])
    expect(ask()).toBeDefined()
    dispose()
    expect(ask()).toBeUndefined()
  })

  it('claims every request that reaches it rather than delegating down the waterfall', async () => {
    const { ctx, ask, overlay } = questionContext()
    installQuestionProvider(ctx)
    let delegated = false
    // The waterfall hands every listener a `next`; a terminal answerer never
    // reaches for it, and an unclaimed request would bottom out in the
    // service's own `NO_PROVIDER` failure instead.
    const answer = ask()?.(
      { questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] },
      () => { delegated = true; return Promise.resolve({ answers: [] }) },
    )
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['A'] }] })
    expect(delegated).toBe(false)
  })
})

describe('plan-review questions', () => {
  it('uses the scrollable plan presentation and preserves the ordinary answer protocol', async () => {
    const { ctx, ask, send, overlay } = questionContext()
    installQuestionProvider(ctx)
    expect(ask()).toBeDefined()

    const answer = send({
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: '# Clear outcome\n\n- read every line',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    const shown = stripAnsi(overlay()?.render(80).join('\n') ?? '')
    expect(shown).toContain('Plan review')
    expect(shown).toContain('Clear outcome')
    expect(shown).toContain('• read every line')

    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  })

  it('reports a dismissed plan as a cancellation, not a request to keep planning', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx)
    const answer = send({
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await expect(answer).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('dismisses the review and rejects when its calling tool is aborted', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx)
    const abort = new AbortController()
    const answer = send({
      signal: abort.signal,
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(overlay()).toBeUndefined()
  })
})

/**
 * The `ask_user_question` answerer.
 *
 * The service validates the request before it arrives (aborted signals, empty
 * question lists, a `plan-review` intent naming a real option, caller
 * liveness), so this answerer only renders, collects, and honours the signal.
 *
 * dshline is one concrete terminal answerer on Harness's `user-questions/request`
 * seam: when a request reaches it and its active terminal surface can present
 * that request, it claims the request by returning the structured answer. It
 * never calls `next()` — not because no other answerer could exist, but
 * because the terminal it presents through is always available to answer
 * whatever reaches it.
 *
 * {@link registerQuestionAnswerer} bridges the installable line's registration
 * shape (`ctx.userQuestions.registerProvider()`) and current Edge's
 * (`ctx.on('user-questions/request', …)`) with one runtime check — the old
 * package literally cannot publish the new event type, so neither shape can
 * be described from one pinned dependency's declarations at once. Delete it,
 * along with its cast, once Minimum/Released no longer resolve to a line
 * whose `ctx.userQuestions` still has `registerProvider`.
 * @module dshline/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
// `AskUserQuestionRequest`/`AskUserQuestionAnswer` carry an `Agent`, so they live
// on the service entry point rather than the wire-safe `/types` module;
// importing from here also carries the `ctx.userQuestions` Context merge.
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { createPlanReviewOverlay } from './plan-review.ts'
import { promptSelect } from './select.ts'

/** Offered when a question carries no options of its own. */
const ACKNOWLEDGE = [{ value: 'ok', label: 'OK' }] as const

/**
 * Ask for a completed plan's approval, keeping cancellation distinct from a
 * declined choice. The plan-mode tool uses that distinction to tell the model a
 * person dismissed the review to speak, rather than asking it to revise.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the plan-review question and its markdown detail.
 * @param signal - abort signal for the calling tool.
 * @returns the selected option label.
 */
function askPlanReview(ctx: Context, item: AskUserQuestionItem, signal: AbortSignal | undefined): Promise<string> {
  const choices = (item.options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
  return new Promise<string>((resolve, reject) => {
    let dismiss = (): void => {}
    let settled = false
    const finish = (value: string | undefined, error: UserQuestionError | undefined): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      dismiss()
      if (error !== undefined) reject(error)
      else resolve(value ?? '')
    }
    const abort = (): void => {
      finish(undefined, new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
    const overlay = createPlanReviewOverlay({
      plan: item.detail ?? '',
      question: item.question,
      choices: choices.length > 0 ? choices : ACKNOWLEDGE,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: value => {
        finish(value, value === undefined
          ? new UserQuestionError('The user dismissed the plan review to speak instead.', 'ASK_CANCELLED')
          : undefined)
      },
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Ask one question, resolving once the user answers or cancels.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question to ask.
 * @param signal - abort signal for the calling tool.
 * @returns the answer for this question.
 */
async function askOne(
  ctx: Context,
  item: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswerItem> {
  if (item.intent?.kind === 'plan-review' && item.detail !== undefined) {
    return { id: item.id, selected: [await askPlanReview(ctx, item, signal)] }
  }
  const choices = (item.options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
  const selected = await promptSelect(ctx, {
    title: item.header === undefined ? item.question : `${item.header}: ${item.question}`,
    view: 'Question',
    ...item.detail === undefined ? {} : { detail: item.detail },
    choices: choices.length > 0 ? choices : ACKNOWLEDGE,
  })
  // Cancelling answers nothing rather than inventing a choice: the calling tool
  // sees an empty selection and decides what an unanswered question means.
  return { id: item.id, selected: selected === undefined ? [] : [selected] }
}

/**
 * Answer one request: every question in order, honouring the signal.
 * @param ctx - the plugin context owning the overlay.
 * @param request - the pending question batch.
 * @returns the structured answer.
 */
async function answerRequest(ctx: Context, request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  // Questions are asked one at a time and in order: the overlay stack shows
  // only its top, so rendering several at once would hide all but the last.
  for (const item of request.questions) {
    if (request.signal?.aborted === true) break
    answers.push(await askOne(ctx, item, request.signal))
  }
  return { answers }
}

/**
 * Register `answer` as a user-questions answerer, under whichever public
 * registration shape `ctx.userQuestions` actually publishes — see the module
 * comment for the two shapes and this bridge's deletion condition.
 * @param ctx - the plugin context, of whichever Harness version is mounted.
 * @param answer - the answerer to register.
 * @returns the disposer removing it.
 */
function registerQuestionAnswerer(
  ctx: Context,
  answer: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
): () => void {
  const legacy = ctx.userQuestions as unknown as { registerProvider?(provider: { ask: typeof answer }): () => void }
  if (typeof legacy.registerProvider === 'function') return legacy.registerProvider({ ask: answer })
  const waterfall = ctx as unknown as {
    on(event: 'user-questions/request', listener: (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>): () => void
  }
  return waterfall.on('user-questions/request', request => answer(request))
}

/**
 * Register this frontend as a user-questions answerer.
 * @param ctx - the plugin context owning the registration.
 * @returns the disposer unregistering the answerer.
 */
export function installQuestionProvider(ctx: Context): () => void {
  return registerQuestionAnswerer(ctx, request => answerRequest(ctx, request))
}

/**
 * The `ask_user_question` answerer.
 *
 * The service validates the request before it arrives (aborted signals, empty
 * question lists, a `plan-review` intent naming a real option, caller
 * liveness), so this answerer only renders, collects, and honours the signal.
 *
 * dshline is one concrete terminal answerer on Harness's scoped
 * `user-questions/request` waterfall: when a request reaches it and its active
 * terminal surface can present that request, it claims the request by
 * returning the structured answer. It never calls `next()` — not because no
 * other answerer could exist, but because the terminal it presents through is
 * always available to answer whatever reaches it. The waterfall's own contract
 * is exactly that: "return an answer to claim the request or call `next()` to
 * delegate", and an unclaimed request bottoms out in the service's
 * `NO_PROVIDER` failure.
 * @module dshline/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
// The error class is a value, so it comes from the service entry point;
// importing from there also carries the `ctx.userQuestions` Context merge and
// the `user-questions/request` waterfall declaration this module registers on.
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { createPlanReviewOverlay } from './plan-review.ts'
import { promptSelect } from './select.ts'

/** Offered when a question carries no options of its own. */
const ACKNOWLEDGE = [{ value: 'ok', label: 'OK' }] as const

/** Whether a borrowed request signal has already been withdrawn. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

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
    ...signal === undefined ? {} : { signal },
  })
  // Cancelling answers nothing rather than inventing a choice: the calling tool
  // sees an empty selection and decides what an unanswered question means.
  return { id: item.id, selected: selected === undefined ? [] : [selected] }
}

/**
 * Answer one request: every question in order, honouring the signal.
 * @param ctx - the plugin context owning the overlay.
 * @param request - the pending question batch.
 * @param bell - emits terminal BEL once this frontend accepts the batch.
 * @returns the structured answer.
 */
async function answerRequest(
  ctx: Context,
  request: AskUserQuestionRequestEvent,
  bell: () => void,
): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  // The service rejects either case before dispatch. Keeping this guard makes a
  // direct caller equally quiet, rather than announcing a request no UI will show.
  if (aborted(request.signal) || request.questions.length === 0) return { answers }
  // One request can contain several sequential overlays, but accepting this
  // batch is one attention event. The first overlay is pushed synchronously by
  // askOne before its promise yields.
  bell()
  // Questions are asked one at a time and in order: the overlay stack shows
  // only its top, so rendering several at once would hide all but the last.
  for (const item of request.questions) {
    if (aborted(request.signal)) break
    answers.push(await askOne(ctx, item, request.signal))
  }
  return { answers }
}

/**
 * Register this frontend as a user-questions answerer.
 *
 * Straight onto the scoped waterfall Harness publishes, with no `next()`: this
 * answerer's terminal is always able to present whatever reaches it, so every
 * request it sees is one it claims.
 * @param ctx - the plugin context owning the registration.
 * @param bell - emits terminal BEL when this answerer accepts a request.
 * @returns the disposer unregistering the answerer.
 */
export function installQuestionProvider(ctx: Context, bell: () => void): () => void {
  return ctx.on('user-questions/request', request => answerRequest(ctx, request, bell))
}

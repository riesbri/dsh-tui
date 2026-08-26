/**
 * The `ask_user_question` provider.
 *
 * This is the seam a terminal frontend uniquely restores. `ctx.userQuestions`
 * accepts exactly ONE provider per context and throws `DUPLICATE_PROVIDER` on a
 * second registration, and the web host's API proxy already claims that slot —
 * so a composition that stacked this bundle over the web bundle would fail to
 * mount. The two frontends are separate profiles by construction, not by
 * convention.
 *
 * The service validates the request before it arrives (aborted signals, empty
 * question lists, a `plan-review` intent naming a real option, caller liveness),
 * so this provider only renders, collects, and honours the signal.
 * @module dshline/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
// `AskUserQuestionRequest` carries an `Agent`, so it lives on the service entry
// point rather than the wire-safe `/types` module; importing it also carries the
// `ctx.userQuestions` Context merge.
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
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
 * Register this frontend as the single user-questions provider.
 * @param ctx - the plugin context owning the registration.
 * @returns the disposer unregistering the provider.
 */
export function installQuestionProvider(ctx: Context): () => void {
  return ctx.userQuestions.registerProvider({
    ask: async (request: AskUserQuestionRequest) => {
      const answers: AskUserQuestionAnswerItem[] = []
      // Questions are asked one at a time and in order: the overlay stack shows
      // only its top, so rendering several at once would hide all but the last.
      for (const item of request.questions) {
        if (request.signal?.aborted === true) break
        answers.push(await askOne(ctx, item, request.signal))
      }
      return { answers }
    },
  })
}

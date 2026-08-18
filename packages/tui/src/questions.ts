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
 * @module @riesbri/dsh-tui/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
// `AskUserQuestionRequest` carries an `Agent`, so it lives on the service entry
// point rather than the wire-safe `/types` module; importing it also carries the
// `ctx.userQuestions` Context merge.
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { promptSelect } from './select.ts'

/** Offered when a question carries no options of its own. */
const ACKNOWLEDGE = [{ value: 'ok', label: 'OK' }] as const

/**
 * Ask one question, resolving once the user answers or cancels.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question to ask.
 * @returns the answer for this question.
 */
async function askOne(ctx: Context, item: AskUserQuestionItem): Promise<AskUserQuestionAnswerItem> {
  const choices = (item.options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
  const selected = await promptSelect(ctx, {
    title: item.header === undefined ? item.question : `${item.header}: ${item.question}`,
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
        answers.push(await askOne(ctx, item))
      }
      return { answers }
    },
  })
}

/**
 * The `ask_user_question` answerer.
 *
 * This is the seam a terminal frontend uniquely restores. The service validates
 * the request before it arrives (aborted signals, empty question lists, a
 * `plan-review` intent naming a real option, caller liveness), so this answerer
 * only renders, collects, and honours the signal.
 *
 * ## Registration compatibility (Harness 0.1.1 vs 0.1.2+)
 *
 * Harness 0.1.1 gave `ctx.userQuestions` exactly ONE provider slot
 * (`registerProvider()`, throwing `DUPLICATE_PROVIDER` on a second caller).
 * Harness 0.1.2 replaced that with an Agent-scoped Cordis waterfall
 * (`ctx.on('user-questions/request', (request, next) => …)`) so several
 * answerers — including one relayed to a connected remote client — can compose;
 * returning an answer claims the request, calling `next()` delegates. dshline
 * is a self-contained terminal frontend with no other answerer to defer to
 * (the earlier one-provider-per-process constraint already kept it out of any
 * composition that also mounted the web host's own provider), so it always
 * claims — it never calls `next()`.
 *
 * {@link installQuestionProvider} detects which shape is mounted at runtime
 * (`registerProvider` present or not) rather than checking a package version,
 * because the two shapes cannot both be described by one pinned dependency's
 * types: Minimum (0.1.1) declares no `'user-questions/request'` event at all,
 * so calling `ctx.on` for it needs the narrow, local {@link WaterfallContext}
 * bridge below instead of the real (version-specific) Cordis `Events` merge.
 * Delete {@link WaterfallContext}, {@link asWaterfallContext}, and the
 * `registerProvider` branch together once the Minimum floor moves to 0.1.2 or
 * later, where the real types already describe the waterfall.
 * @module dshline/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
// `AskUserQuestionRequest`/`AskUserQuestionAnswer` carry an `Agent`, so they live
// on the service entry point rather than the wire-safe `/types` module;
// importing from here also carries the `ctx.userQuestions` Context merge. Both
// types are unchanged in shape across 0.1.1 and 0.1.2, so they need no bridge.
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { createPlanReviewOverlay } from './plan-review.ts'
import { promptSelect } from './select.ts'

/** Harness ≤0.1.1's single-provider registration shape. */
interface LegacyUserQuestionService {
  registerProvider(provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void
}

/**
 * Structural guard for the legacy shape, rather than a version-string check:
 * Harness 0.1.2 removed `registerProvider` entirely, so its presence alone
 * tells us which registration mode is mounted.
 * @param service - `ctx.userQuestions`, of whichever version is installed.
 * @returns the service narrowed to its legacy shape, or undefined.
 */
function asLegacyUserQuestionService(service: unknown): LegacyUserQuestionService | undefined {
  return typeof service === 'object' && service !== null && typeof (service as LegacyUserQuestionService).registerProvider === 'function'
    ? service as LegacyUserQuestionService
    : undefined
}

/**
 * The one Cordis waterfall event this file needs from Harness ≥0.1.2, declared
 * locally rather than imported: the real `Events` merge for it lives only in
 * 0.1.2's own package types, which are not what Minimum (0.1.1) resolves to at
 * compile time. This is a compatibility bridge for exactly one event, not a
 * copy of the upstream `Events` interface.
 */
interface WaterfallContext {
  on(
    event: 'user-questions/request',
    listener: (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>,
  ): () => void
}

/**
 * Narrow, explicit cast to the waterfall bridge above — never a broad `any`.
 * @param ctx - the plugin context, of whichever Harness version is installed.
 * @returns the same context, typed for exactly the one event this file registers.
 */
function asWaterfallContext(ctx: Context): WaterfallContext {
  return ctx as unknown as WaterfallContext
}

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
 * Register this frontend as a user-questions answerer, under whichever
 * registration mode the mounted Harness version publishes — see the module
 * comment for why this is feature-detected rather than version-checked.
 * @param ctx - the plugin context owning the registration.
 * @returns the disposer unregistering the answerer.
 */
export function installQuestionProvider(ctx: Context): () => void {
  const legacy = asLegacyUserQuestionService(ctx.userQuestions)
  if (legacy !== undefined) {
    return legacy.registerProvider({ ask: request => answerRequest(ctx, request) })
  }
  // Untagged (unscoped) registration: dsh-scope admits an untagged listener
  // for both an agent-scoped dispatch and an unscoped one, so this single
  // registration answers every request this process's one attached session
  // can raise without needing to track that session's own agent scope.
  return asWaterfallContext(ctx).on('user-questions/request', request => answerRequest(ctx, request))
}

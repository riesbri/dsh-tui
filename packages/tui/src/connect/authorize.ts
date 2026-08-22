/**
 * Running one Harness authorization flow in a terminal.
 *
 * This module implements nothing about any provider's login. Harness's
 * authorization seam owns the protocol and hands a surface exactly two things
 * to render — a notice, which is one-way and may carry a page and a code, and a
 * prompt, which is `text`, `secret`, or `select`. That vocabulary is
 * deliberately smaller than any one provider's, so a surface that renders one
 * flow renders all of them: OAuth, device code, and a key typed into a
 * provider library's own prompt arrive here as the same three shapes.
 *
 * Where each half goes is the terminal-specific decision:
 *
 * - A **notice** is committed to native scrollback. A sign-in URL and a device
 *   code are the two things a person most needs to select and copy, and this
 *   frontend's whole premise is that finished rows belong to the terminal's own
 *   buffer rather than to a redrawn region that will scroll them away.
 * - A **prompt** is a bounded overlay, because it takes the keyboard.
 *
 * Cancelling is done by aborting the attempt's signal rather than by rejecting
 * with the seam's decline error, which this package cannot import. The seam
 * treats a withdrawn attempt and a declined prompt as the same outcome —
 * `cancelled`, not a failure — so the observable result is identical.
 * @module @riesbri/dsh-tui/connect/authorize
 */

import type { Context } from '@deepseek-ai/cordis'
import { escapeControls, style } from '@riesbri/dsh-tui-renderer'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'
import type {
  AuthorizationNoticeRead,
  AuthorizationPromptRead,
  ConnectAuthorization,
} from './harness.ts'
import type { ConnectActionOutcome } from './actions.ts'
import { messageOf } from './catalog.ts'

/** What running one flow needs from its owner. */
export interface AuthorizeSpec {
  /** Context carrying the slot registry, for the prompt overlays. */
  readonly ctx: Context
  /** The authorization seam. */
  readonly authorization: ConnectAuthorization
  /** The credential record to authorize. */
  readonly key: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** Which of the flow's methods to run; omitted takes the flow's first. */
  readonly method?: string
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
}

/**
 * Rows one notice becomes in the transcript.
 *
 * The page and the code are given lines of their own, unindented past a short
 * gutter, because a reader is about to select them with the mouse: burying a
 * URL inside a sentence makes a double-click take the sentence with it.
 * @param notice - what the flow reported.
 * @param label - what is being authorized.
 * @returns the lines to commit.
 */
export function noticeLines(notice: AuthorizationNoticeRead, label: string): string[] {
  const lines = [style(`· ${label}: ${escapeControls(notice.message)}`, 'gray')]
  // Untrusted: a URL and a code come from a provider's own login response, so
  // both are escaped before any styling is applied, never after.
  if (notice.url !== undefined && notice.url !== '') {
    lines.push(`  ${style(escapeControls(notice.url), 'cyan')}`)
  }
  if (notice.code !== undefined && notice.code !== '') {
    lines.push(`  ${style(`code ${escapeControls(notice.code)}`, 'bold')}`)
  }
  return lines
}

/**
 * Run one authorization flow and report how it ended.
 *
 * The attempt owns an `AbortController` this function holds: dismissing a
 * prompt aborts it, which withdraws the whole attempt through the seam's own
 * lifecycle rather than leaving a flow prompting into a closed overlay.
 * @param spec - the seam, the key, and where notices go.
 * @returns what Harness answered, worded for the transcript.
 */
export async function runAuthorization(spec: AuthorizeSpec): Promise<ConnectActionOutcome> {
  const { ctx, authorization, key, label, commit } = spec
  const controller = new AbortController()
  let withdrawn = false
  /**
   * Put one prompt to the reader, withdrawing the attempt when they dismiss it.
   * @param prompt - what the flow asked.
   * @returns the answer.
   * @throws when the reader dismissed the question.
   */
  const ask = async (prompt: AuthorizationPromptRead): Promise<string> => {
    const answer = await render(ctx, prompt, label)
    if (answer !== undefined) return answer
    // A prompt carrying its own aborted signal was withdrawn BY THE FLOW — the
    // losing half of a race it is still running. Treating that as a dismissal
    // would cancel an attempt the human never gave up on.
    if (prompt.signal?.aborted === true) throw new Error('the authorization prompt was withdrawn')
    withdrawn = true
    controller.abort()
    // The seam races this rejection against its own signal and settles the
    // attempt as `cancelled`; the message is only ever seen in a debug log.
    throw new Error('the authorization prompt was dismissed')
  }
  try {
    const outcome = await authorization.begin({
      key,
      ...spec.method === undefined ? {} : { method: spec.method },
      signal: controller.signal,
      interaction: {
        notify: notice => { commit(noticeLines(notice, label)) },
        prompt: ask,
      },
    })
    if (outcome.status === 'authorized') {
      return { kind: 'done', message: `${label}: signed in` }
    }
    return { kind: 'failed', message: withdrawn ? `${label}: sign-in dismissed` : `${label}: sign-in cancelled` }
  } catch (error) {
    return { kind: 'failed', message: `${label}: sign-in failed — ${messageOf(error)}` }
  }
}

/**
 * Show one prompt in the shape it asks for.
 *
 * `secret` differs from `text` only in presentation, which is exactly what the
 * seam says it means, so both reach the same overlay with one field changed.
 * @param ctx - context carrying the slot registry.
 * @param prompt - what the flow asked.
 * @param label - what is being authorized, for the overlay title.
 * @returns the answer, or undefined when the reader dismissed it.
 */
async function render(
  ctx: Context,
  prompt: AuthorizationPromptRead,
  label: string,
): Promise<string | undefined> {
  const title = `Sign in · ${label}`
  const withdrawal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  if (prompt.kind === 'select') {
    return promptSelect(ctx, {
      title,
      ...withdrawal,
      detail: escapeControls(prompt.message),
      choices: prompt.options.map(option => ({
        value: option.id,
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    })
  }
  return promptText(ctx, {
    title,
    ...withdrawal,
    message: prompt.message,
    kind: prompt.kind,
    ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
  })
}

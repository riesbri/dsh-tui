/**
 * Live counts of user-sourced messages pending across Harness's inbox boundary lists.
 *
 * @module dshline/steering
 */

import type { Inbox } from '@deepseek-ai/dsh-agent'

/** The live inbox surface needed by the status line. */
type PendingInbox = Pick<Inbox, 'nextStep' | 'nextTurn'>

/**
 * User input pending on each of Harness's two boundary lists.
 *
 * Kept as two numbers rather than one total because the reader now chooses which
 * list their input goes to, and a single count could not say whether the choice
 * took effect. Plugin- and tool-sourced messages share `next-step` with the
 * reader's own steering and are excluded from both: they are context the agent
 * assembled, not a keystroke waiting to be answered for.
 */
export interface PendingUserInput {
  /** Follow-up turns waiting on `next-turn`, each one its own turn to come. */
  readonly queued: number
  /** Steering waiting on `next-step`, for the turn already running. */
  readonly steering: number
}

/**
 * Count user-sourced messages pending on each boundary list.
 *
 * Read from the agent's own live inbox at paint time, never accumulated from
 * what this frontend submitted. A counter maintained here would drift the moment
 * anything else moved the inbox — a claim at a step boundary, a cancellation, a
 * plugin's own insertion — and it would have to be rebuilt on resume from events
 * it does not own.
 * @param inbox - the agent-owned live inbox projection.
 * @returns pending user input on each list.
 */
export function pendingUserInput(inbox: PendingInbox): PendingUserInput {
  let queued = 0
  let steering = 0
  for (const message of inbox.nextTurn) {
    if (message.source?.kind === 'user') queued += 1
  }
  for (const message of inbox.nextStep) {
    if (message.source?.kind === 'user') steering += 1
  }
  return { queued, steering }
}

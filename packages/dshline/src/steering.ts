/**
 * Live queued-steering readings from Harness's authoritative inbox projection.
 *
 * @module dshline/steering
 */

import type { Inbox } from '@deepseek-ai/dsh-agent'

/** The live inbox surface needed by the status line. */
type PendingInbox = Pick<Inbox, 'nextStep' | 'nextTurn'>

/**
 * Count prompts submitted by the reader that Harness has not consumed yet.
 * @param inbox - the agent-owned live inbox projection.
 * @returns user-sourced messages pending across both boundary lists.
 */
export function steeredCount(inbox: PendingInbox): number {
  let count = 0
  for (const message of [...inbox.nextStep, ...inbox.nextTurn]) {
    if (message.source?.kind === 'user') count += 1
  }
  return count
}

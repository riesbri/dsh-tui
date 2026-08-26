/**
 * Live counts of user-sourced messages pending across Harness's inbox boundary lists.
 *
 * @module dshline/steering
 */

import type { Inbox } from '@deepseek-ai/dsh-agent'

/** The live inbox surface needed by the status line. */
type PendingInbox = Pick<Inbox, 'nextStep' | 'nextTurn'>

/**
 * Count user-sourced messages pending across the next-step and next-turn lists.
 * @param inbox - the agent-owned live inbox projection.
 * @returns user-sourced messages pending across both boundary lists.
 */
export function queuedUserCount(inbox: PendingInbox): number {
  let count = 0
  for (const message of [...inbox.nextStep, ...inbox.nextTurn]) {
    if (message.source?.kind === 'user') count += 1
  }
  return count
}

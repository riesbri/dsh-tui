/**
 * Which Harness inbox a submitted line is delivered to, and the reader's choice
 * between them.
 *
 * Harness has owned two destinations for user input all along, and this frontend
 * used to pick between them by accident: whichever one the agent's status made
 * available. `followup` places the message on the agent's `next-turn` list, where
 * it becomes a turn of its own at the next turn boundary. `steer` places it on
 * `next-step`, where the RUNNING turn takes it at its nearest step boundary and
 * keeps stepping. Idle, only one of the two means anything — an agent with no
 * turn in flight has no step to interject into, and Harness itself resolves an
 * idle `steer` into a woken prompt turn — so the choice exists only while a turn
 * is running.
 *
 * Kept apart from both the settings namespace that persists the choice and the
 * attachment that acts on it, because it is the one part of this feature that is
 * a pure decision: no terminal, no agent, no settings provider, three inputs and
 * one answer. Everything that can go wrong about Queue-versus-Steer routing can
 * therefore be tested by calling a function.
 * @module dshline/delivery
 */

import type { SubmitGesture } from '@dshline/renderer'

/** What plain `enter` means while a turn is running. */
export type BusyEnter = 'queue' | 'steer'

/**
 * The Agent verb a submission is delivered with.
 *
 * Named for the verb rather than for the list, because the verb is what this
 * frontend calls and the list is Harness's own vocabulary for where it lands.
 */
export type Delivery = 'followup' | 'steer'

/**
 * What this frontend defaults plain busy `enter` to.
 *
 * Queue, matching the adopted Harness generation's own Web product, whose
 * shipped default is `queue` in `submission-settings.ts`. Preferring Steer here
 * would mean two surfaces of one agent disagreeing about what the same key does,
 * and the terminal is not the surface that should win that disagreement.
 *
 * It is also the safer of the two to be wrong about. A follow-up that should
 * have been steering arrives one turn later; steering that should have been a
 * follow-up is merged into a turn that was already reasoning about something
 * else, and cannot be taken back.
 */
export const DEFAULT_BUSY_ENTER: BusyEnter = 'queue'

/** What decides one submission's delivery. */
export interface DeliveryDecision {
  /** Whether the agent has a turn in flight right now. */
  readonly running: boolean
  /** What plain `enter` means while one is. */
  readonly preference: BusyEnter
  /** Which physical gesture submitted the line. */
  readonly gesture: SubmitGesture
}

/**
 * Choose the Agent verb for one submitted line.
 *
 * Idle is deliberately not a preference: both gestures follow up, because there
 * is no running turn for steering to reach and manufacturing a distinction
 * Harness does not have would make `ctrl-enter` mean something invented here.
 * That also makes the accelerated gesture safe on a terminal that cannot send
 * it — an idle submission is identical either way, and a busy one falls back to
 * the reader's own preference rather than to a third behaviour.
 * @param decision - the agent's state, the reader's preference, and the gesture.
 * @returns the verb the attachment calls on the Agent.
 */
export function chooseDelivery({ running, preference, gesture }: DeliveryDecision): Delivery {
  if (!running) return 'followup'
  const chosen = gesture === 'accelerated'
    ? preference === 'queue' ? 'steer' : 'queue'
    : preference
  return chosen === 'queue' ? 'followup' : 'steer'
}

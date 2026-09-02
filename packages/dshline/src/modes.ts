/**
 * Session state that changes what a turn will do, rather than what it says.
 *
 * Plan mode is invisible in a transcript: the command that set it prints a line
 * and scrolls away, and everything after that looks like an ordinary session
 * while the agent behaves differently. That is exactly what a status line is
 * for.
 *
 * It is read the way its owner documents. `PlanModeController` says outright
 * that UIs observe committed flips through `session/event` and that there is no
 * live mirror — which also means a reopened session recovers it from the replay.
 * So plan mode is folded here, from the log, and nothing else is.
 *
 * A goal is not folded here. Harness publishes its durable state through the
 * generic `goal` session projection and only its process-local activation
 * through `ctx.goals`; joining those two authorities belongs to the projection
 * adapter in `dshline/goals/model`, beside Todo's.
 * @module dshline/modes
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Plan mode after one event.
 *
 * A whole-value replace, last one wins: the event carries the state from that
 * point on rather than a transition, so folding is an assignment and a log with
 * no such event is inactive.
 * @param active - plan mode before this event.
 * @param event - one committed session event.
 * @returns plan mode after it.
 */
export function planModeAfter(active: boolean, event: SessionEvent): boolean {
  return event.type === 'plan/mode' ? event.data.active : active
}

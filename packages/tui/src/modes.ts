/**
 * Session state that changes what a turn will do, rather than what it says.
 *
 * Plan mode and a running goal are both invisible in a transcript: the command
 * that set one prints a line and scrolls away, and everything after that looks
 * like an ordinary session while the agent behaves differently. That is exactly
 * what a status line is for.
 *
 * The two are read by different means, each the one its owner documents. Plan
 * mode is folded from the log — `PlanModeController` says outright that UIs
 * observe committed flips through `session/event` and that there is no live
 * mirror — which also means a reopened session recovers it from the replay. A
 * goal is asked of its service instead, because the log carries the durable
 * phase but not whether THIS process will continue it: activation is
 * process-local and never persisted, so a resumed session holding an active goal
 * is not a session that is about to run one.
 * @module @riesbri/dsh-tui/modes
 */

import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Rounds a goal has taken, and whether anything is about to take another. */
export interface GoalReading {
  /** The text for the status line. */
  label: string
  /** Whether this session will continue the goal by itself. */
  running: boolean
}

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

/**
 * How the status line reports a goal, or nothing when there is none.
 *
 * The count is shown while the goal is live, because "how far through" is the
 * question someone asks about a run they did not watch start. A phase that is
 * not `active` replaces it: the round number of a paused goal is history, not
 * progress.
 *
 * `idle` marks the case the round count alone would misrepresent — a goal that
 * is durably active while this process holds no authority to continue it, which
 * is what every reopened session starts as. It reads as a goal that is set and
 * going nowhere, which is what it is.
 * @param goal - the service's view of the current goal, when there is one.
 * @returns the reading, or undefined when nothing is worth reporting.
 */
export function goalReading(goal: GoalView | undefined): GoalReading | undefined {
  if (goal === undefined) return undefined
  const rounds = `${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)}`
  if (goal.phase !== 'active') return { label: `goal ${goal.phase}`, running: false }
  const running = goal.activation === 'armed'
  return { label: running ? `goal ${rounds}` : `goal ${rounds} idle`, running }
}

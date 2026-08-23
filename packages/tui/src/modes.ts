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
import { displayWidth, escapeControls, truncateToWidth } from '@riesbri/dsh-tui-renderer'

/**
 * Columns an objective may occupy in the status line.
 *
 * Cut here rather than in the status line, which drops whole segments and never
 * shortens one. An objective is prose a model wrote, so unlike a round count it
 * has no length worth respecting and no smaller true form to fall back to — a
 * shortened one is still an objective, where `goal 12/25` is a different fact
 * from `goal 12/256`. Wide enough for a recognizable phrase, narrow enough that
 * an eighty-column terminal still has room for the context reading.
 */
const OBJECTIVE_COLUMNS = 28

/** What a goal is, how far in it is, and whether anything will continue it. */
export interface GoalReading {
  /** The full text for the status line: the state, and what the goal is. */
  label: string
  /** The state alone, for a terminal that cannot hold the objective. */
  short: string
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
 * The OBJECTIVE leads the reading, because the first question about a goal is
 * what it is — and a goal is not always something the reader set. The harness's
 * `create_goal` tool is model-callable and documents that the model may infer the
 * intent without being asked, so a session can acquire automatic continuation
 * authority that was never typed. The round count is what says so; the objective
 * is what makes that legible.
 *
 * The count appears only once a round has been taken. Before then it is
 * `roundsStarted` against a deployment's cap — `0/256` — which reads as a meter
 * stuck at zero when it is really a safety limit that has not been approached.
 * `armed` says the same thing in the words that are true.
 *
 * A phase that is not `active` replaces the count: the round number of a paused
 * goal is history, not progress. `idle` marks the case the count alone would
 * misrepresent — a goal that is durably active while this process holds no
 * authority to continue it, which is what every reopened session starts as. It
 * reads as a goal that is set and going nowhere, which is what it is.
 * @param goal - the service's view of the current goal, when there is one.
 * @returns the reading, or undefined when nothing is worth reporting.
 */
export function goalReading(goal: GoalView | undefined): GoalReading | undefined {
  if (goal === undefined) return undefined
  const state = goal.phase !== 'active'
    ? goal.phase
    : goal.activation !== 'armed'
      ? 'idle'
      : goal.roundsStarted > 0 ? `${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)}` : 'armed'
  const short = `goal ${state}`
  // An objective is untrusted text: the model writes it, and it reaches the
  // terminal. Escaped before it is measured, so the cut and the width agree.
  const objective = elide(escapeControls(goal.objective), OBJECTIVE_COLUMNS)
  return {
    label: objective === '' ? short : `${short} \u00b7 ${objective}`,
    short,
    running: goal.phase === 'active' && goal.activation === 'armed',
  }
}

/**
 * Fit text to a column budget, marking a cut with an ellipsis.
 *
 * `truncateToWidth` alone cuts silently, and a silently cut objective reads as a
 * complete one — "migrate every call site off" is a plausible whole sentence and
 * a wrong summary of what the goal actually says.
 * @param text - the already-escaped text.
 * @param columns - the budget, ellipsis included.
 * @returns the text, or a cut form ending in an ellipsis.
 */
function elide(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text.trimEnd()
  return `${truncateToWidth(text, columns - 1).trimEnd()}\u2026`
}

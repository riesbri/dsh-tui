/**
 * Presentation-facing reading of the Harness goal domain's two authorities.
 *
 * The goal is owned in halves, and this adapter is where they are joined for
 * the terminal — nowhere else:
 *
 * ```text
 * Harness `goal` projection   durable, log-derived: identity, revision,
 *   (ctx.sessionProjections)  objective, phase, blocked reason, round count,
 *                             round cap, timestamps
 *
 * ctx.goals                   live, process-local: activation alone, the one
 *                             fact no replay can reconstruct
 * ```
 *
 * Activation is deliberately never persisted, so a resumed session can hold a
 * durably `active` goal while this process is `disarmed` and will continue
 * nothing. That is the distinction the whole reading exists to make, and it is
 * why the durable half comes from the projection: reading those fields off
 * `ctx.goals.get(agent)` would make the service the presentation authority for
 * state Harness already publishes generically.
 *
 * Activation is asked for lazily, at render time, and never cached. Upstream's
 * `disarm()` is process-local by design: it changes activation without a
 * `goal/change` event, without a revision, and without a `goal/changed`
 * notification, so a projection observer cannot own it and a remembered copy
 * would go stale silently.
 * @module dshline/goals/model
 */

import type { GoalActivation } from '@deepseek-ai/dsh-goal'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { displayWidth, escapeControls, truncateToWidth } from '@dshline/renderer'

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
 * Live process-local activation, asked for only when it can change the reading.
 *
 * A thunk rather than a value so this adapter decides whether the service is
 * consulted at all. `undefined` means the answer could not be obtained — no goal
 * service, no live agent, or a refusal — and is never read as `armed`.
 */
export type GoalActivationSource = () => GoalActivation | undefined

/**
 * How the status line reports a goal, or nothing when there is none.
 *
 * The objective leads the reading, because the first question about a goal is
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
 *
 * Only an `active` projected goal consults `activation`: a paused, blocked, or
 * complete goal reads the same either way, and a session with no projected goal
 * has nothing to ask about.
 * @param snapshot - the status frame's shared projection cut, or undefined without the registry.
 * @param activation - live process-local activation, called at most once.
 * @returns the reading, or undefined when nothing is worth reporting.
 */
export function goalReading(
  snapshot: ProjectionSnapshot | undefined,
  activation: GoalActivationSource,
): GoalReading | undefined {
  // `undefined` is the typed absence of an unregistered process-wide unit;
  // `null` is the goal domain's distinct no-current-goal value. Neither is a
  // goal, and a missing registry is not one either.
  const current = snapshot?.values.goal
  if (current === undefined || current === null) return undefined
  const { goal, roundsStarted } = current
  // An unobtainable activation is not `armed`. Inferring one from
  // `phase === 'active'` is exactly the claim this split exists to refuse.
  const running = goal.phase === 'active' && activation() === 'armed'
  const state = goal.phase !== 'active'
    ? goal.phase
    : !running
      ? 'idle'
      : roundsStarted > 0 ? `${String(roundsStarted)}/${String(goal.maxGoalRounds)}` : 'armed'
  const short = `goal ${state}`
  // An objective is untrusted text: the model writes it, and it reaches the
  // terminal. Escaped before it is measured, so the cut and the width agree.
  const objective = elide(escapeControls(goal.objective), OBJECTIVE_COLUMNS)
  return {
    label: objective === '' ? short : `${short} \u00b7 ${objective}`,
    short,
    running,
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

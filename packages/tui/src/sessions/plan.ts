/**
 * Whether reopening a session is a safe thing to do right now.
 *
 * Resuming from inside a running window is not the same act as resuming at
 * launch. At launch there is nothing to lose; from inside a session it retires a
 * live Agent, and `AgentHandle.dispose()` stops that agent's loop, removes its
 * session from the store, and unwinds its whole scoped world — including
 * anything a capability started under it.
 *
 * That is the "observation is not control" rule applied to a lifecycle call the
 * frontend genuinely owns. The handle disposer IS this frontend's capability: it
 * created the agent, so it may retire it. What Harness does NOT define is what
 * should happen to a job or a delegated subagent whose owner disappears
 * mid-flight, so the frontend refuses in exactly the states where it would be
 * guessing, and says which one it is refusing on.
 *
 * Pure and separate from the overlay because these are the rules worth pinning
 * with tests; drawing them is the easy half.
 * @module @riesbri/dsh-tui/sessions/plan
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEntry } from './model.ts'

/** Everything the decision depends on, gathered by the caller. */
export interface ResumeConditions {
  /** The session the reader chose. */
  readonly target: SessionEntry
  /** The session this window is driving, or undefined before an agent exists. */
  readonly currentSessionId: SessionId | undefined
  /** Whether the current agent is mid-turn. */
  readonly busy: boolean
  /** Jobs and subagents currently attached to the session being left. */
  readonly activeWork: number
}

/** The decision, and the sentence to show when it is no. */
export type ResumePlan =
  /** Retire the current agent, if any, and resume the target. */
  | { readonly kind: 'resume' }
  /** Do nothing; `message` says why, in words a reader can act on. */
  | { readonly kind: 'refused'; readonly message: string }

/**
 * Decide whether to reopen one session.
 *
 * Ordered most specific first, so the sentence names the reader's actual
 * situation rather than the first rule that happens to fail. "Already open" and
 * "live elsewhere" come before the capability checks because they are true
 * regardless of how the deployment is configured.
 * @param conditions - the gathered facts.
 * @returns the plan, carrying a refusal message when the answer is no.
 */
export function planResume(conditions: ResumeConditions): ResumePlan {
  const { target, currentSessionId, busy, activeWork } = conditions
  if (target.id === currentSessionId) {
    return { kind: 'refused', message: 'That session is already open in this window.' }
  }
  // A live id cannot be resumed at all: resume prepares the persisted log and
  // enters it into `ctx.sessions`, and the store refuses a duplicate id. Saying
  // so is better than letting the factory throw a store error at the reader.
  if (target.live) {
    return { kind: 'refused', message: 'That session is already live in this process.' }
  }
  // `persisted` answers the capability question without probing for the backend
  // service: resume loads through persistence, so a corpus with no backend
  // mounted reports every record unpersisted and this one sentence covers both
  // "no backend" and "this particular id is live-only".
  if (!target.persisted) {
    return { kind: 'refused', message: 'No persisted log to reopen — resuming needs Harness session persistence.' }
  }
  if (busy) {
    return { kind: 'refused', message: 'Finish or interrupt the current turn before reopening a session.' }
  }
  // The refused case Harness does not answer: a job or a delegated child is
  // owned by the agent about to be retired, and no generic seam says whether a
  // human-initiated owner teardown should stop it, orphan it, or wait for it.
  if (activeWork > 0) {
    const plural = activeWork === 1 ? 'is' : 'are'
    return {
      kind: 'refused',
      message: `${String(activeWork)} job${activeWork === 1 ? '' : 's'} or subagent${activeWork === 1 ? '' : 's'} ${plural} still attached to this session.`,
    }
  }
  return { kind: 'resume' }
}

/**
 * Resolving "which session" into an attached Agent, including when it fails.
 *
 * The failure is the reason this is its own module. Reopening happens AFTER the
 * previous agent has been retired, so a rejected `ctx.agents.resume` leaves the
 * window holding a terminal and no session. Two answers were plausible and one
 * is wrong: substituting a fresh empty session is *quiet*, but the reader asked
 * to reopen a conversation, and a new session in the launch directory is not a
 * smaller version of that — it is a different thing wearing its place. So the
 * reason is committed and the browser is opened again, which is the same
 * question the launch path asks and leaves the reader in control. Dismissing it
 * is how they choose a new session, deliberately.
 *
 * A failed launch-time `create` is deliberately NOT caught. There is nothing to
 * fall back to and nothing to ask; it belongs on the runner's boot-failure path.
 * An in-window `/new` is different: its target carries the attachment's current
 * workspace, so failure is reported and the same browser asks what to do next.
 *
 * Narrowed to two calls and two callbacks so the policy is testable without a
 * plugin tree or a terminal.
 * @module dshline/sessions/reopen
 */

import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { escapeControls, paint } from '@dshline/renderer'

/** Which session the next attachment drives. */
export type AttachTarget =
  /**
   * Open a fresh session. `afterDismissal` marks the one case worth a note: the
   * window asked which session to open and the reader chose none, where silence
   * would read as the request having been ignored. `cwd` is present on a live
   * attachment's `/new` transition and any fresh retry after it: it preserves
   * that attachment's workspace and distinguishes recoverable creation from boot.
   */
  | { readonly kind: 'new'; readonly afterDismissal?: boolean; readonly cwd?: string }
  /** Reopen this persisted session. */
  | { readonly kind: 'resume'; readonly id: SessionId }

/** The exact `ctx.agents` factory surface a window uses to attach. */
export interface AgentOpener {
  /** Create a new agent on a caller-supplied session id. */
  create(options: CreateAgentOptions): Promise<AgentHandle>
  /** Load a persisted session and resume an agent on it. */
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** The agent a window ended up attached to. */
export interface Attached {
  /**
   * The owned handle.
   *
   * Kept, not discarded: its disposer is the capability that makes reopening a
   * session possible at all, and this runner used to throw it away.
   */
  readonly handle: AgentHandle
  /** Whether a persisted session was reopened, so its transcript should replay. */
  readonly reopened: boolean
}

/** What resolving a target needs from the window. */
export interface AttachSpec {
  /** The `ctx.agents` factory surface. */
  readonly agents: AgentOpener
  /** Mint the id for a new session; called only when one is created. */
  readonly newSessionId: () => SessionId
  /** Startup workspace for a new target that does not carry one of its own. */
  readonly cwd: string
  /**
   * The preset a new session's header records at creation, when a preset
   * roster is mounted; called only when one is created. A resumed session
   * needs no equivalent — its header already carries whatever it was
   * created with, and `resolveSessionPreset` reads that (and any later
   * `agent-preset/selected` event) inside `setup(agentCtx)`, not here.
   */
  readonly newSessionPreset: () => string | undefined
  /** Route and setup shared by both paths, read at attach time. */
  readonly options: Omit<ResumeAgentOptions, 'resumeSessionId'>
  /** Say which attachment operation failed, in the transcript, before asking again. */
  readonly report: (kind: 'new' | 'resume', reason: string) => void
  /** Ask which session to open; dismissal answers `{ kind: 'new' }`. */
  readonly ask: () => Promise<AttachTarget>
}

/** The attached agent and the target it actually came from. */
export interface AttachOutcome {
  /** The target that succeeded, which may not be the one first requested. */
  readonly target: AttachTarget
  /** The agent now attached. */
  readonly attached: Attached
}

/**
 * The lines a failed reopen commits before the browser is asked again.
 *
 * Red, and named as the frontend's own report rather than a transcript event:
 * the reader asked for one session and is about to be asked to choose again, and
 * "no session appeared" with no reason is the failure mode this avoids.
 * @param reason - Harness's own message; untrusted, so it is escaped here.
 * @returns lines to write into scrollback.
 */
export function reopenFailureLines(reason: string): string[] {
  return [
    paint(`✗ could not reopen that session: ${escapeControls(reason)}`, 'error'),
    paint('· choose another, or press esc for a new session', 'muted'),
  ]
}

/**
 * The lines a failed in-window `/new` commits before the browser is asked again.
 * @param reason - Harness's own message; untrusted, so it is escaped here.
 * @returns lines to write into scrollback.
 */
export function newSessionFailureLines(reason: string): string[] {
  return [
    paint(`✗ could not start a new session: ${escapeControls(reason)}`, 'error'),
    paint('· choose a session, or press esc to try fresh again', 'muted'),
  ]
}

/**
 * Resolve a target into an attached agent, asking again while reopening fails.
 *
 * Loops on the reader's answer, not on its own: every failure is reported and
 * re-asked, and dismissing the browser ends it by creating a new session. A
 * deployment whose persistence is broken therefore reaches a usable window in
 * one keystroke instead of either spinning or dying.
 * @param spec - the factory surface and the window's report/ask callbacks.
 * @param first - the target to try before asking anything.
 * @returns the attached agent and the target it came from.
 */
export async function attachTarget(spec: AttachSpec, first: AttachTarget): Promise<AttachOutcome> {
  let target = first
  // Kept across reader choices after a failed `/new`: choosing a broken resume
  // and then trying fresh must not quietly fall back to the launch directory.
  const recoveryCwd = first.kind === 'new' ? first.cwd : undefined
  for (;;) {
    if (target.kind === 'new') {
      const preset = spec.newSessionPreset()
      const cwd = target.cwd ?? recoveryCwd ?? spec.cwd
      try {
        const handle = await spec.agents.create({
          sessionId: spec.newSessionId(),
          meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset } },
          ...spec.options,
        })
        const attachedTarget = target.cwd === undefined && recoveryCwd !== undefined
          ? { ...target, cwd: recoveryCwd }
          : target
        return { target: attachedTarget, attached: { handle, reopened: false } }
      } catch (error: unknown) {
        // No cwd means application boot or a normal browser dismissal. Those
        // failures still belong to the runner's boot-failure path; only `/new`
        // has already retired a healthy attachment and has somewhere to return.
        if (recoveryCwd === undefined) throw error
        spec.report('new', error instanceof Error ? error.message : String(error))
        const chosen = await spec.ask()
        target = chosen.kind === 'new' ? { ...chosen, cwd: recoveryCwd } : chosen
        continue
      }
    }
    try {
      const handle = await spec.agents.resume({ resumeSessionId: target.id, ...spec.options })
      return { target, attached: { handle, reopened: true } }
    } catch (error: unknown) {
      // Deliberately not narrowed to one error class. Reopening can fail because
      // persistence is unmounted, because the log fails replay validation, or
      // because a header is from an incompatible format version, and the reader's
      // next move is the same for all of them.
      spec.report('resume', error instanceof Error ? error.message : String(error))
      const chosen = await spec.ask()
      target = chosen.kind === 'new' && recoveryCwd !== undefined
        ? { ...chosen, cwd: recoveryCwd }
        : chosen
    }
  }
}

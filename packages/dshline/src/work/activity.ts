/**
 * Per-child semantic activity for Work rows.
 *
 * A live in-process subagent exposes a real child Agent, so its activity can be
 * folded with the exact vocabulary the main status line uses: the model phase
 * from its session events and the tool activity from its pending calls'
 * presentations. A remote run without a local Agent exposes neither, and the
 * observer simply never attaches — the row then shows no invented activity.
 * @module dshline/work/activity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { modelPhaseAfter, primaryActivity } from '../activity.ts'
import type { ActivityWord, ModelPhase } from '../activity.ts'
import { PendingToolCalls } from '../tool-pending.ts'

/** The live activity facts a Work row may truthfully present. */
export interface ChildActivityReading {
  /**
   * The semantic word; present only while the live child Agent is observed.
   * `waiting` is the honest reading for a resident child between turns.
   */
  readonly word?: ActivityWord
  /** The newest pending call's presentation title, when its tool declared one. */
  readonly title?: string
  /** Whether the live Agent is running, which drives the row's spinner. */
  readonly busy: boolean
  /** The live Agent's published status, for the detail stage. */
  readonly status?: AgentStatus
}

/**
 * Observe one child Agent's semantic activity until its run epoch ends.
 *
 * Subscribed on the runner's own agent context with exact identity filters —
 * the same listener surface the main status uses, where scope admission already
 * reaches descendant sessions and agents. Everything is event-driven: no timer
 * exists here, and disposal is synchronous, so a replaced Agent under the same
 * durable id can never mutate this epoch's state.
 */
export class ChildActivityObserver {
  private phase: ModelPhase = 'waiting'
  private readonly pending: PendingToolCalls
  private readonly disposers: (() => void)[] = []
  private disposed = false
  private status: AgentStatus | undefined

  /**
   * @param ctx - the context to subscribe on (the Work runner's agent context).
   * @param child - the exact live child Agent this epoch observes.
   * @param resolveTool - resolves a tool definition as the child sees it.
   * @param onChange - redraw request after any folded event.
   */
  constructor(
    ctx: Context,
    private readonly child: Agent,
    resolveTool: (name: string) => ToolDefinition | undefined,
    private readonly onChange: () => void,
  ) {
    this.pending = new PendingToolCalls(resolveTool)
    this.disposers.push(ctx.on('session/event', (session, event: SessionEvent) => {
      if (session !== child.session) return
      this.fold(event)
    }))
    this.disposers.push(ctx.on('agent/status', (payload: { agent: Agent; status: AgentStatus }) => {
      if (payload.agent !== child) return
      this.status = payload.status
      if (this.disposed) return
      onChange()
    }))
    this.disposers.push(ctx.on('agent/disposed', (payload: { agent: Agent }) => {
      if (payload.agent !== child) return
      this.disposed = true
      onChange()
    }))
  }

  /** Fold one child session event with the shared status vocabulary. */
  private fold(event: SessionEvent): void {
    if (this.disposed) return
    if (event.type === 'tool/call') {
      // A tool call starts executing the moment the model's request settles, so a
      // phase captured before the first pending invocation is stale: when that
      // call drains, `waiting` is the truth unless stream activity arrived while
      // it ran. Mirrors the main status fold exactly.
      if (this.pending.count() === 0) this.phase = 'waiting'
      this.pending.handleCall({
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
      })
    } else if (event.type === 'tool/result') {
      // The session event carries no call id; the pairing lives on the first
      // content block, exactly as the transcript projection reads it.
      const toolCallId = event.data.message.content[0]?.toolCallId
      if (toolCallId !== undefined) this.pending.handleResult(String(toolCallId))
    }
    this.phase = modelPhaseAfter(this.phase, event)
    this.onChange()
  }

  /**
   * Read the current semantic activity.
   * @returns the word, optional operation title, and animation truth for this child.
   */
  reading(): ChildActivityReading {
    if (this.disposed) return { busy: false }
    const pending = this.pending.semanticActivity()
    const word = primaryActivity(this.phase, pending)
    const title = this.pending.latestTitle()
    return {
      word,
      busy: this.status === 'running',
      ...this.status === undefined ? {} : { status: this.status },
      ...title === undefined ? {} : { title },
    }
  }

  /** Stop observing; late events are contained and never repaint this epoch. */
  dispose(): void {
    this.disposed = true
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}

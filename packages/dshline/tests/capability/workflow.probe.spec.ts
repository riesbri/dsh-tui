/**
 * Capability probe: `ctx.workflowEngine` and the durable workflow records.
 *
 * Exercises the exact contracts Work consumes, against the real packages:
 * the abstract `@deepseek-ai/dsh-workflow` `WorkflowEngine` and its
 * `emitWorkflowEvent` dispatch, the real `workflow/*` event declarations, a
 * real `@deepseek-ai/dsh-session` `Session` from the real `SessionStore`, and
 * the `tool-workflow/*` `SessionEventMap` merge that `@deepseek-ai/dsh-tool-workflow`
 * publishes. An upstream rename or payload change fails this file by capability
 * name instead of surfacing as an unrelated typecheck error.
 *
 * The engine here runs no script and starts no child: the point is the
 * observation seam, and specifically that a run only becomes visible through
 * the durable record the tool writes into the parent Session.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import WorkflowEngine, { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import { describe, expect, it } from 'vitest'
import { createHarnessWork } from '../../src/work/index.ts'

/** The validated meta a real run carries on every one of its events. */
const META = { name: 'capability-probe', description: 'Probe the workflow observation seam' }

/**
 * An engine that publishes the real lifecycle events and runs no script.
 *
 * Subclassing the real abstract Service is the point: `emitWorkflowEvent` is
 * the protected dispatch every provider uses, so the event names and payload
 * shapes below are the upstream ones, checked by the compiler.
 */
class ProbeWorkflowEngine extends WorkflowEngine {
  override start(request: WorkflowStartRequest): WorkflowRun {
    const id = WorkflowRunId('capability-probe-run')
    const info: WorkflowRunInfo = { id, meta: request.meta }
    this.emitWorkflowEvent('workflow/start', info)
    return {
      id,
      meta: request.meta,
      result: Promise.resolve({ value: null, stopReason: 'completed' as const, agentsStarted: 0 }),
      cancel: () => {},
      dispose: async () => {},
    }
  }

  /** Publish one phase narration exactly as a real run would. */
  narrate(id: string, title: string): void {
    this.emitWorkflowEvent('workflow/phase', { id: WorkflowRunId(id), meta: META }, title)
  }

  /** Re-publish the run's start edge, which a real engine emits inside `start()`. */
  announce(id: string): void {
    this.emitWorkflowEvent('workflow/start', { id: WorkflowRunId(id), meta: META })
  }

  /** Publish one member's start edge exactly as a real run would. */
  memberStart(id: string, childId: string): void {
    this.emitWorkflowEvent('workflow/agent-start', { id: WorkflowRunId(id), meta: META }, {
      seq: 1, label: 'probe member', phase: 'Review', childId: SessionId(childId),
    })
  }

  /** Publish one member's settlement exactly as a real run would. */
  memberEnd(id: string, childId: string): void {
    this.emitWorkflowEvent('workflow/agent-end', { id: WorkflowRunId(id), meta: META }, {
      seq: 1, label: 'probe member', phase: 'Review', childId: SessionId(childId), outcome: 'completed',
    })
  }

  /** Publish one member settlement exactly as a real run would. */
  settle(id: string, agentsStarted: number): void {
    this.emitWorkflowEvent(
      'workflow/end',
      { id: WorkflowRunId(id), meta: META },
      { stopReason: 'completed' as const, agentsStarted },
    )
  }
}

describe('capability: workflows', () => {
  it('projects a run only through this session\'s own durable records', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(ProbeWorkflowEngine)
      const engine = ctx.workflowEngine as ProbeWorkflowEngine
      const session = ctx.sessions.create(SessionId('capability-probe-parent'))
      const agent = { session, ctx } as unknown as Agent
      const work = createHarnessWork(ctx, agent, () => {})

      // A live run whose durable record this session never wrote: the event
      // payload names a run and no session, so this is exactly the leak the
      // ownership rule exists to prevent.
      engine.narrate('someone-elses-run', 'Review')
      expect(work.snapshot().workflows).toEqual([])

      // The tool's own durable record, appended to the parent Session.
      const runId = WorkflowRunId('capability-probe-run')
      session.append('tool-workflow/run-start', { runId, name: META.name })
      expect(work.snapshot().workflows).toEqual([
        expect.objectContaining({ source: 'workflow', id: 'capability-probe-run', label: META.name, state: 'running' }),
      ])

      // Now — and only now — live enrichment for that exact run is accepted.
      engine.narrate('capability-probe-run', 'Review')
      expect(work.snapshot().workflows[0]).toMatchObject({
        phase: 'Review', description: META.description,
      })

      session.append('tool-workflow/agent-start', {
        runId, seq: 1, label: 'probe member', phase: 'Review',
        childId: SessionId('capability-probe-child'),
      })
      session.append('tool-workflow/agent-end', { runId, seq: 1, outcome: 'completed' })
      expect(work.snapshot().workflows[0]?.members).toEqual([
        { seq: 1, label: 'probe member', phase: 'Review', childId: 'capability-probe-child', outcome: 'completed' },
      ])

      engine.settle('capability-probe-run', 1)
      expect(work.snapshot().workflows[0]).toMatchObject({ state: 'completed', agentsStarted: 1 })

      session.append('tool-workflow/run-end', { runId, stopReason: 'completed' })
      expect(work.snapshot().workflows).toEqual([])

      work.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('subscribes only to the live events that can carry something it may keep', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(ProbeWorkflowEngine)
      const engine = ctx.workflowEngine as ProbeWorkflowEngine
      const session = ctx.sessions.create(SessionId('capability-probe-parent-3'))
      const agent = { session, ctx } as unknown as Agent
      const work = createHarnessWork(ctx, agent, () => {})

      const runId = WorkflowRunId('capability-probe-run')
      session.append('tool-workflow/run-start', { runId, name: META.name })

      // `workflow/start` is emitted synchronously INSIDE the real engine's
      // `start()` — before the tool appends the record above — so the ownership
      // gate drops it every time and dshline does not subscribe to it. Firing it
      // for an already-owned run proves that, by leaving the description absent.
      engine.announce('capability-probe-run')
      expect(work.snapshot().workflows[0]?.description).toBeUndefined()

      // `workflow/agent-end` is emitted exactly once per STARTED call, so its
      // meta is always already delivered by the paired start; it is not
      // subscribed either.
      engine.memberEnd('capability-probe-run', 'capability-probe-child')
      expect(work.snapshot().workflows[0]?.description).toBeUndefined()

      // `workflow/agent-start` IS subscribed, so a script that only calls
      // `agent()` still recovers its description before the run settles.
      engine.memberStart('capability-probe-run', 'capability-probe-child')
      expect(work.snapshot().workflows[0]?.description).toBe(META.description)

      work.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts a real run through the seam without observing it as this session\'s', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(ProbeWorkflowEngine)
      const session: Session = ctx.sessions.create(SessionId('capability-probe-parent-2'))
      const agent = { session, ctx } as unknown as Agent
      const work = createHarnessWork(ctx, agent, () => {})
      // `start()` is the whole runtime surface a UI can reach: there is no
      // lookup by id and no cancel for a run this frontend did not start, which
      // is why Work observes workflows and offers no control over them.
      const run = ctx.workflowEngine.start({ script: 'return null', meta: META, parent: agent })
      await run.result
      await run.dispose()
      expect(work.snapshot().workflows).toEqual([])
      work.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/**
 * Live per-child semantic activity for Work rows.
 *
 * The observer must reuse the exact vocabulary the main status line uses —
 * `modelPhaseAfter`, `primaryActivity`, and the shared pending-tool fold — and
 * must stay strictly event-driven: attach by exact Agent identity, dispose with
 * the epoch, and never invent activity for a run with no local Agent.
 * @module dshline/tests/work-activity
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ToolCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { stripAnsi } from '@dshline/renderer'
import { HarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { WorkInterruptResult, WorkSnapshot, SubagentWorkItem } from '../src/work/model.ts'

/** Standard successful interrupt response for overlay-only tests. */
const INTERRUPT_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Interrupt requested.' }

/** A minimal typed session event builder. */
function ev(type: string, data: unknown = {}): SessionEvent {
  return { type, data, seq: 0, time: 0 } as unknown as SessionEvent
}

/** A tool call by id, resolved through the lookup by tool name. */
function call(id: string, name: string): SessionEvent {
  return ev('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' })
}

/** A tool result settling one exact call id. */
function result(id: string): SessionEvent {
  return ev('tool/result', {
    turn: 1, step: 1,
    message: { content: [{ type: 'tool', toolCallId: id, content: [] }] },
  })
}

/** A reasoning delta chunk. */
function reasoning(text = 'thinking…'): SessionEvent {
  return ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text } })
}

/** A text delta chunk. */
function text(): SessionEvent {
  return ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } })
}

/** A per-name resolved call presentation, proving classification rides the definition. */
function lookup(views: Record<string, ToolCallView>): (name: string, _agent: Agent) => ToolDefinition | undefined {
  return name => {
    const view = views[name]
    return view === undefined ? undefined : { presentCall: () => view } as unknown as ToolDefinition
  }
}

/** A synthetic in-process child Agent the registry resolves. */
function makeChild(id: string, status: 'idle' | 'running' = 'idle'): Agent {
  return { id, session: { id }, status } as unknown as Agent
}

/** A started subagent harness keyed to one real root context. */
function harness(
  rootCtx: Context,
  views: Record<string, ToolCallView>,
  registry: Map<string, Agent>,
): {
  work: HarnessWork
  start: (info: { runId: string; provider: string; id: string; local: boolean }) => void
  end: (info: { runId: string; provider: string; id: string; local: boolean; stopReason: 'completed' }) => void
  invalidations: () => number
} {
  let invalidations = 0
  let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
  let ended: ((info: { runId: string; provider: string; id: string; local: boolean; stopReason: 'completed' }) => void) | undefined
  const root = { session: { id: 'root' }, ctx: rootCtx } as unknown as Agent
  const work = new HarnessWork({
    agent: root,
    subagents: {
      listChildren: async () => [],
      interrupt: () => {},
    } as unknown as SubagentRuntime,
    agents: { get: id => registry.get(String(id)) },
    resolveTool: lookup(views),
    onSubagentStart: listener => { started = listener as typeof started; return () => {} },
    onSubagentEnd: listener => { ended = listener as typeof ended; return () => {} },
    invalidate: () => { invalidations += 1 },
  })
  return {
    work,
    start: info => started?.(info),
    end: info => ended?.(info),
    invalidations: () => invalidations,
  }
}

describe('per-child semantic activity for Work', () => {
  it('folds a live child\'s activity with the main status vocabulary', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'codex', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({ id: 'child', busy: false })

    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    rootCtx.emit('session/event', child.session, reasoning())
    expect(work.snapshot().subagents[0]?.activityWord).toBe('thinking')
    rootCtx.emit('session/event', child.session, text())
    expect(work.snapshot().subagents[0]?.activityWord).toBe('responding')
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading', activityTitle: 'overlay.ts',
    })
    rootCtx.emit('agent/status', { agent: child, status: 'running' })
    expect(work.snapshot().subagents[0]).toMatchObject({ busy: true, agentStatus: 'running' })
    rootCtx.emit('session/event', child.session, result('c1'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    work.dispose()
  })

  it('classifies terminal, diff, and undeclared tool presentations conservatively', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
      edit: { card: 'generic', title: 'edit model.ts', kind: 'edit' },
      custom: undefined as never,
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'bash'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'running', activityTitle: 'pnpm test',
    })
    rootCtx.emit('session/event', child.session, result('c1'))
    rootCtx.emit('session/event', child.session, call('c2', 'edit'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'editing', activityTitle: 'edit model.ts',
    })
    rootCtx.emit('session/event', child.session, result('c2'))
    // A tool with no declaration still folds: `working`, no invented title.
    rootCtx.emit('session/event', child.session, call('c3', 'custom'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('working')
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    work.dispose()
  })

  it('never invents activity for a remote run with no local Agent', () => {
    const rootCtx = new Context()
    const { work, start } = harness(rootCtx, {}, new Map())
    start({ runId: 'r1', provider: 'codex', id: 'remote', local: false })
    const row = work.snapshot().subagents[0]
    expect(row?.local).toBe(false)
    expect(row?.activityWord).toBeUndefined()
    expect(row?.busy).toBeUndefined()
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('● codex')
    expect(plain).not.toContain('· thinking')
    expect(plain).not.toContain('· reading')
    work.dispose()
  })

  it('attaches when the child Agent becomes live after lifecycle publication', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map<string, Agent>()
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    // The child is NOT in the registry at the start edge.
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]?.activityWord).toBeUndefined()
    // The child publishes; `agent/created` attaches the observer.
    registry.set('child', child)
    rootCtx.emit('agent/created', { agent: child })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading', activityTitle: 'overlay.ts',
    })
    work.dispose()
  })

  it('disposes observers with the epoch and lets late events repaint nothing', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start, end, invalidations } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    const afterStart = invalidations()
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(invalidations()).toBeGreaterThan(afterStart)
    end({ runId: 'r1', provider: 'spawn', id: 'child', local: true, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
    const afterEnd = invalidations()
    // A late event for the settled epoch must not repaint a live region.
    rootCtx.emit('session/event', child.session, call('c2', 'read'))
    expect(invalidations()).toBe(afterEnd)
    work.dispose()
  })

  it('drops activity when the observed Agent disappears before the epoch settles', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('reading')
    rootCtx.emit('agent/disposed', { agent: child })
    const row = work.snapshot().subagents[0]
    expect(row?.id).toBe('child') // lifecycle edge still open
    expect(row?.activityWord).toBeUndefined() // but no stale granular activity
    expect(row?.busy).toBe(false)
    work.dispose()
  })

  it('renders the overview row with the child\'s live activity', () => {
    const rootCtx = new Context()
    const child = makeChild('child', 'running')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
    }, registry)
    start({ runId: 'r1', provider: 'codex', id: 'child', local: true })
    rootCtx.emit('agent/status', { agent: child, status: 'running' })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'bash'))
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('· running pnpm test')
    work.dispose()
  })

  it('keeps independent activity states per child', () => {
    const rootCtx = new Context()
    const first = makeChild('first')
    const second = makeChild('second')
    const registry = new Map([
      ['first', first],
      ['second', second],
    ])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'first', local: true })
    start({ runId: 'r2', provider: 'spawn', id: 'second', local: true })
    rootCtx.emit('session/event', first.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', first.session, call('c1', 'read'))
    rootCtx.emit('session/event', second.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', second.session, call('c2', 'bash'))
    const rows = work.snapshot().subagents
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('first')).toMatchObject({ activityWord: 'reading', activityTitle: 'overlay.ts' })
    expect(byId.get('second')).toMatchObject({ activityWord: 'running', activityTitle: 'pnpm test' })
    work.dispose()
  })

  it('lets the detail stage expose the same live facts it shows in the row', () => {
    const rootCtx = new Context()
    const child = makeChild('child', 'running')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'codex', id: 'child', local: true })
    rootCtx.emit('agent/status', { agent: child, status: 'running' })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 14).map(stripAnsi).join('\n')
    expect(detail).toContain('lifecycle  active')
    expect(detail).toContain('activity  reading')
    expect(detail).toContain('operation  overlay.ts')
    expect(detail).toContain('agent status  running')
    work.dispose()
  })
})

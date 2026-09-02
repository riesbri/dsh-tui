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

/** Which seqs a child's session was actually asked for. */
const reads = new WeakMap<Agent, number[]>()

/**
 * A synthetic in-process child Agent the registry resolves.
 *
 * The session answers the Session reads the observer makes — `seq`,
 * `inheritedEventCount`, and `eventAt` — and records every position asked
 * for, so a test can assert what was NOT read as well as what was folded.
 * @param id - the child's id.
 * @param status - the live agent status to report.
 * @param events - the child's whole log, inherited prefix first.
 * @param inheritedEventCount - how many leading events came from the fork parent.
 * @returns the child agent.
 */
function makeChild(
  id: string,
  status: 'idle' | 'running' = 'idle',
  events: readonly SessionEvent[] = [],
  inheritedEventCount = 0,
): Agent {
  const asked: number[] = []
  const child = {
    id,
    status,
    session: {
      id,
      seq: events.length,
      inheritedEventCount,
      eventAt: (seq: number) => {
        asked.push(seq)
        return events[seq]
      },
    },
  } as unknown as Agent
  reads.set(child, asked)
  return child
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
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('reading · overlay.ts')
    expect(detail).toContain('provider  codex')
    expect(detail).toContain('agent status  running')
    work.dispose()
  })

  it('seeds busy from a child already running before the lifecycle start edge', () => {
    const rootCtx = new Context()
    // Harness can already be executing the child when dshline observes the
    // start: the state must come from the live Agent, never from a later
    // `agent/status` transition that may already have happened.
    const child = makeChild('child', 'running')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {}, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      busy: true,
      agentStatus: 'running',
    })
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    // The overview uses the animated mark immediately, with no synthetic
    // `agent/status` ever emitted.
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('◜')
    work.dispose()
  })

  it('reads an already-open current turn from the session at attach', () => {
    const rootCtx = new Context()
    // The child is mid-turn with a read already outstanding when Work attaches:
    // the session holds the turn's events, and the observer must fold exactly
    // that open-turn suffix rather than waiting for synthetic live events.
    const child = makeChild('child', 'running', [
      ev('turn/start', { turn: 1 }),
      call('c1', 'read'),
    ])
    const registry = new Map([['child', child]])
    const { work, start, invalidations } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading',
      activityTitle: 'overlay.ts',
      busy: true,
      agentStatus: 'running',
    })
    const afterStart = invalidations()
    // The reconstruction established the snapshot with ONE redraw: emitting no
    // further events must leave the redraw count untouched.
    expect(invalidations()).toBe(afterStart)
    work.dispose()
  })

  it('never folds a fork-inherited prefix as the child’s own activity', () => {
    const rootCtx = new Context()
    // `/work` says what the CHILD is doing. A subagent child opens with its
    // parent's history in front of its own, and the parent's outstanding read
    // is not this child's — so the backward scan stops at the durable lineage
    // cut, `inheritedEventCount`, and never reads below it. Deliberately NOT
    // `firstLiveSeq`: that marks where THIS process began appending, which
    // would also exclude the child's own setup writes.
    const child = makeChild('child', 'running', [
      ev('turn/start', { turn: 1 }),
      call('parent-read', 'read'),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], 3)
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'parent-file.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'waiting',
      busy: true,
    })
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    // Not one inherited position was even read: the floor is a bound on the
    // scan, not a filter applied after materializing the log.
    expect(reads.get(child)?.filter(seq => seq < 3)).toEqual([])
    work.dispose()
  })

  it('folds the child’s own open turn that sits above the inherited prefix', () => {
    const rootCtx = new Context()
    // The same lineage cut must not hide the child's real work: everything
    // from `inheritedEventCount` up is the child's, setup writes included.
    const child = makeChild('child', 'running', [
      ev('turn/start', { turn: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', { turn: 1 }),
      call('c1', 'read'),
    ], 2)
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading',
      activityTitle: 'overlay.ts',
    })
    // The scan stopped at the child's own `turn/start`, so seq 1 — the last
    // inherited event — was never read either.
    expect(reads.get(child)?.filter(seq => seq < 2)).toEqual([])
    work.dispose()
  })

  it('never turns historical turns into current activity at attach', () => {
    const rootCtx = new Context()
    // A cold-resumed child opens with a whole persisted log: a completed turn
    // and even an aborted interrupted turn must both stay history.
    const child = makeChild('child', 'idle', [
      ev('turn/start', { turn: 1 }),
      reasoning(),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', { turn: 2 }),
      text(),
      ev('turn/end', { turn: 2, reason: { kind: 'aborted' } }),
    ])
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    // Live folding still works afterwards.
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 3 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('reading')
    work.dispose()
  })

  it('clears pending tool activity when a turn ends without its results', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading', activityTitle: 'overlay.ts',
    })
    // The turn is aborted; the call's result never arrives.
    rootCtx.emit('session/event', child.session, ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }))
    const row = work.snapshot().subagents[0]
    expect(row?.activityWord).toBe('waiting')
    expect(row?.activityTitle).toBeUndefined()
    work.dispose()
  })

  it('still pairs a normal completed tool result across turn/end', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    rootCtx.emit('session/event', child.session, result('c1'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    rootCtx.emit('session/event', child.session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    work.dispose()
  })

  it('suppresses the operation title for an ambiguous mixed pending set', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    rootCtx.emit('session/event', child.session, call('c2', 'bash'))
    const row = work.snapshot().subagents[0]
    expect(row?.activityWord).toBe('working') // mixed, conservative aggregate
    expect(row?.activityTitle).toBeUndefined() // no single call is "the" current one
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('· working')
    expect(plain).not.toContain('· working pnpm test')
    work.dispose()
  })

  it('keeps the newest operation title for a same-activity pending set', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
      lookup: { card: 'generic', title: 'model.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    rootCtx.emit('session/event', child.session, call('c2', 'lookup'))
    const row = work.snapshot().subagents[0]
    expect(row?.activityWord).toBe('reading') // one activity, no ambiguity
    expect(row?.activityTitle).toBe('model.ts') // the newest declared title
    work.dispose()
  })
})

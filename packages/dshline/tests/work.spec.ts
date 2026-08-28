/** Tests for the optional generic Harness Work projection and live overlay. */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { displayWidth, Screen, SPINNER_INTERVAL_MS, stripAnsi, wrapToWidth } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { HarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { JobWorkItem, SubagentWorkItem, WorkInterruptResult, WorkSnapshot } from '../src/work/model.ts'
import { activeWorkCount, workItemKey, workSummary } from '../src/work/model.ts'

/** The root agent shape the capability contracts use for ownership. */
const agent = { session: { id: 'root' } } as unknown as Agent

/** A different exact Agent instance, proving job listeners stay owner-scoped. */
const otherAgent = { session: { id: 'other' } } as unknown as Agent

/** Standard successful interrupt response for overlay-only tests. */
const INTERRUPT_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Interrupt requested.' }

/** Make a job snapshot with only the facts Work is allowed to present. */
function job(status: JobSnapshot['status'] = 'running', label = 'pnpm test'): JobSnapshot {
  return {
    id: 'bash-1' as JobSnapshot['id'],
    kind: 'bash',
    label,
    status,
    startedAt: 0,
    ownerSession: 'root' as JobSnapshot['ownerSession'],
    reported: false,
  }
}

/** A Job Work row for overlay- and summary-focused tests. */
function jobItem(overrides: Partial<JobWorkItem> = {}): JobWorkItem {
  return {
    id: 'bash-1', source: 'job', kind: 'bash', label: 'pnpm test',
    state: 'running', startedAt: Date.now(), ownership: 'this-session', busy: true, interruptible: false, ...overrides,
  }
}

/** A subagent Work row for overlay- and summary-focused tests. */
function subagentItem(overrides: Partial<SubagentWorkItem> = {}): SubagentWorkItem {
  return {
    id: 'child', source: 'subagent', runId: 'r1', provider: 'codex', local: true, state: 'running',
    startedAt: Date.now(), interruptible: true, ...overrides,
  }
}

/** Three distinct subagent rows for selection-identity scenarios. */
function trio(): WorkSnapshot {
  return {
    available: true,
    subagents: [
      subagentItem({ id: 'a', runId: 'a', label: 'A' }),
      subagentItem({ id: 'b', runId: 'b', label: 'B', mode: 'continuable' }),
      subagentItem({ id: 'c', runId: 'c', label: 'C' }),
    ],
    jobs: [],
  }
}

/** Let an async discovery read publish its harmless enrichment. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** A no-work projection used by overlay-focused tests. */
const EMPTY: WorkSnapshot = { available: false, subagents: [], jobs: [] }

/** One direct child record served by the authoritative subagent discovery seam. */
const CONTINUABLE_CHILD = {
  kind: 'child' as const, id: 'child', mode: 'continuable' as const,
  label: '审查 renderer', activity: 'running' as const, hasChildren: false,
}

/** A settled durable child: discoverable, but never active Work by itself. */
const INACTIVE_CHILD = {
  kind: 'child' as const, id: 'durable', mode: 'continuable' as const,
  label: 'history', activity: 'inactive' as const, hasChildren: true,
}

describe('generic Harness Work capability projection', () => {
  it('boots without jobs or subagents', () => {
    const work = new HarnessWork({ agent, invalidate: () => {} })
    expect(work.snapshot()).toEqual(EMPTY)
    work.dispose()
  })

  it('boots with jobs only and never reads a job output cursor', () => {
    let readCalls = 0
    const jobs = {
      list: () => [job()],
      read: () => { readCalls += 1 },
      onJobsChanged: () => () => {},
      onJobDone: () => { throw new Error('presentation must not subscribe to completion delivery') }
    } as unknown as JobRegistry
    const work = new HarnessWork({ agent, jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    expect(running).toMatchObject({
      source: 'job', kind: 'bash', label: 'pnpm test', state: 'running', ownership: 'this-session', busy: true,
    })
    expect(readCalls).toBe(0)
    work.dispose()
  })

  it('marks an unowned job without inventing a session association', () => {
    const jobs = {
      list: () => [{ ...job(), ownerSession: undefined }],
      onJobsChanged: () => () => {},
      onJobDone: () => {},
    } as unknown as JobRegistry
    const work = new HarnessWork({ agent, jobs, invalidate: () => {} })
    expect(work.snapshot().jobs[0]?.ownership).toBe('unowned')
    work.dispose()
  })

  it('uses only the owner-scoped jobs change feed for presentation refreshes', () => {
    let changed: ((owner: Agent | undefined) => void) | undefined
    let invalidated = 0
    const jobs = {
      list: () => [job()],
      onJobsChanged: (listener: (owner: Agent | undefined) => void) => { changed = listener; return () => {} },
      onJobDone: () => { throw new Error('onJobDone is model-delivery semantics, not presentation') }
    } as unknown as JobRegistry
    new HarnessWork({ agent, jobs, invalidate: () => { invalidated += 1 } })
    changed?.(otherAgent)
    expect(invalidated).toBe(0)
    changed?.(agent)
    expect(invalidated).toBe(1)
  })

  it('uses direct-child discovery and generic lifecycle edges for subagents', async () => {
    let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
    let ended: ((info: { runId: string; provider: string; id: string; local: boolean; stopReason: 'completed' }) => void) | undefined
    let children = 0
    const subagents = {
      listChildren: async () => { children += 1; return [CONTINUABLE_CHILD] },
      listDescendants: () => { throw new Error('must not scan descendants') },
    } as unknown as SubagentRuntime
    const work = new HarnessWork({
      agent,
      subagents,
      onSubagentStart: listener => { started = listener as typeof started; return () => {} },
      onSubagentEnd: listener => { ended = listener as typeof ended; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: 'r1', provider: 'provider-中文', id: 'child', local: false })
    await settled()
    expect(children).toBeGreaterThanOrEqual(2)
    expect(work.snapshot().subagents).toMatchObject([{
      provider: 'provider-中文', label: '审查 renderer', mode: 'continuable',
      residency: 'resident', hasChildren: false, interruptible: true, local: false,
    }])
    ended?.({ runId: 'r1', provider: 'provider-中文', id: 'child', local: false, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
  })

  it('keeps sequential lifecycle epochs of one durable child distinct', async () => {
    let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
    let ended: ((info: { runId: string; provider: string; id: string; local: boolean; stopReason: 'completed' }) => void) | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listChildren: async () => [] } as unknown as SubagentRuntime,
      onSubagentStart: listener => { started = listener as typeof started; return () => {} },
      onSubagentEnd: listener => { ended = listener as typeof ended; return () => {} },
      invalidate: () => {},
    })
    // A cold-resumed continuable child opens a NEW epoch under the same durable
    // session id: the first epoch must fully settle before the second begins.
    started?.({ runId: 'epoch-1', provider: 'codex', id: 'child', local: true })
    expect(work.snapshot().subagents.map(row => row.runId)).toEqual(['epoch-1'])
    ended?.({ runId: 'epoch-1', provider: 'codex', id: 'child', local: true, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
    started?.({ runId: 'epoch-2', provider: 'codex', id: 'child', local: true })
    expect(work.snapshot().subagents.map(row => row.runId)).toEqual(['epoch-2'])
    expect(work.snapshot().subagents[0]?.id).toBe('child')
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-1' }))).toBe('subagent:epoch-1')
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-2' }))).toBe('subagent:epoch-2')
    work.dispose()
  })

  it('does not promote inactive durable children into active Work', async () => {
    const subagents = {
      listChildren: async () => [INACTIVE_CHILD],
      listDescendants: () => { throw new Error('must not scan descendants') },
    } as unknown as SubagentRuntime
    const work = new HarnessWork({ agent, subagents, invalidate: () => {} })
    await settled()
    expect(work.snapshot().subagents).toEqual([])
    work.dispose()
  })

  it('keeps lifecycle truth even when discovery reports the durable child as stored', async () => {
    let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listChildren: async () => [INACTIVE_CHILD] } as unknown as SubagentRuntime,
      onSubagentStart: listener => { started = listener as typeof started; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: 'r1', provider: 'codex', id: 'durable', local: true })
    await settled()
    // The open lifecycle edge is the active row; discovery only enriches it.
    expect(work.snapshot().subagents).toMatchObject([{
      id: 'durable', runId: 'r1', mode: 'continuable', residency: 'stored',
      hasChildren: true, interruptible: true,
    }])
    work.dispose()
  })

  it('keeps lifecycle truth when discovery fails', async () => {
    let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listChildren: async () => { throw new Error('projection unavailable') } } as unknown as SubagentRuntime,
      onSubagentStart: listener => { started = listener as typeof started; return () => {} },
      invalidate: () => {},
    })
    started?.({ runId: 'r1', provider: 'codex', id: 'child', local: false })
    await settled()
    expect(work.snapshot().subagents).toMatchObject([{ id: 'child', provider: 'codex' }])
    work.dispose()
  })

  it('marks a discovered one-shot subagent as non-interruptible', async () => {
    let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listChildren: async () => [{ ...CONTINUABLE_CHILD, mode: 'one-shot' as const }] } as unknown as SubagentRuntime,
      onSubagentStart: listener => { started = listener as typeof started; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: 'one', provider: 'generic', id: 'child', local: false })
    await settled()
    expect(work.snapshot().subagents[0]?.interruptible).toBe(false)
  })

  it('does not let a disposed pending discovery mutate the projection', async () => {
    let resolve!: (entries: readonly typeof CONTINUABLE_CHILD[]) => void
    const pending = new Promise<readonly typeof CONTINUABLE_CHILD[]>(done => { resolve = done })
    let invalidated = 0
    const work = new HarnessWork({
      agent,
      subagents: { listChildren: () => pending } as unknown as SubagentRuntime,
      invalidate: () => { invalidated += 1 },
    })
    work.dispose()
    resolve([CONTINUABLE_CHILD])
    await settled()
    expect(invalidated).toBe(0)
  })

  it('renders running jobs as non-interruptible and never calls jobs.kill', () => {
    let kills = 0
    const jobs = {
      list: () => [job()],
      kill: () => { kills += 1; return 'requested' },
      onJobsChanged: () => () => {},
    } as unknown as JobRegistry
    const work = new HarnessWork({ agent, jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    expect(running?.interruptible).toBe(false)
    expect(work.interrupt(running ?? jobItem())).toEqual({
      kind: 'unsupported', message: 'Jobs cannot be stopped from Work.',
    })
    expect(kills).toBe(0)
  })

  it('interrupts continuable children with exact user parent authority and leaves one-shots unstopped', () => {
    const calls: unknown[][] = []
    const subagents = {
      listChildren: async () => [],
      interrupt: (...args: unknown[]) => { calls.push(args) },
    } as unknown as SubagentRuntime
    const work = new HarnessWork({ agent, subagents, invalidate: () => {} })
    expect(work.interrupt(subagentItem({ id: 'child', interruptible: true }))).toEqual(INTERRUPT_REQUESTED)
    expect(calls).toEqual([['child', { kind: 'user', parentSessionId: 'root' }]])
    expect(work.interrupt(subagentItem({ id: 'one-shot', interruptible: false }))).toEqual({
      kind: 'unsupported', message: 'This subagent cannot be interrupted here.',
    })
    expect(calls).toHaveLength(1)
  })
})

describe('the Work status summary', () => {
  it('derives the summary solely from the snapshot arrays', () => {
    expect(workSummary(EMPTY)).toBeUndefined()
    expect(workSummary({ ...EMPTY, available: true })).toBeUndefined()
    const cases = [
      [0, 1, '1 job'],
      [0, 2, '2 jobs'],
      [1, 0, '1 subagent'],
      [2, 0, '2 subagents'],
      [1, 1, '1 subagent · 1 job'],
      [1, 2, '1 subagent · 2 jobs'],
      [2, 1, '2 subagents · 1 job'],
      [2, 2, '2 subagents · 2 jobs'],
    ] as const
    for (const [subagents, jobs, expected] of cases) {
      expect(workSummary({
        available: true,
        subagents: Array.from({ length: subagents }, (_, index) => subagentItem({ id: `subagent-${String(index)}`, runId: `subagent-${String(index)}` })),
        jobs: Array.from({ length: jobs }, (_, index) => jobItem({ id: `job-${String(index)}` })),
      })).toBe(expected)
    }
  })

  it('keys subagent rows by lifecycle run, not by the durable session id', () => {
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-1' }))).toBe('subagent:epoch-1')
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-2' }))).toBe('subagent:epoch-2')
    expect(workItemKey(jobItem({ id: 'bash-1' }))).toBe('job:bash-1')
  })
})

describe('the Work live-region overlay', () => {
  it('never exceeds its physical terminal height across narrow state and size matrices', () => {
    const states: readonly WorkSnapshot[] = [
      EMPTY,
      { ...EMPTY, available: true },
      { available: true, subagents: [subagentItem({
        provider: '提供者', label: 'a deliberately long label that must not leak a row', interruptible: false,
      })], jobs: [] },
    ]
    for (const snapshot of states) {
      for (const columns of [14, 18, 24, 30]) {
        for (const rows of [7, 8, 10, 12]) {
          const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
          const frame = overlay.render(columns, rows)
          expect(frame.flatMap(line => wrapToWidth(line, columns)).length, `${String(columns)}x${String(rows)}`)
            .toBeLessThanOrEqual(rows)
        }
      }
    }
  })

  it('never exceeds its physical terminal height with a detail stage open', () => {
    const snapshot: WorkSnapshot = {
      available: true,
      subagents: [subagentItem({ label: '审查 renderer', mode: 'continuable', residency: 'resident', hasChildren: true })],
      jobs: [jobItem({ detail: 'exit code: 3' })],
    }
    for (const columns of [24, 40, 80]) {
      for (const rows of [7, 9, 12, 24]) {
        const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
        overlay.handleKey({ kind: 'key', name: 'enter' })
        const frame = overlay.render(columns, rows)
        expect(frame.flatMap(line => wrapToWidth(line, columns)).length, `${String(columns)}x${String(rows)}`)
          .toBeLessThanOrEqual(rows)
      }
    }
  })

  it('renders generic provider names safely and accounts for wide labels', () => {
    const snapshot: WorkSnapshot = { available: true, subagents: [subagentItem({
      provider: '提供者', label: '审查\u001b[2J renderer', interruptible: false,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    const lines = overlay.render(60, 12)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('提供者')
    expect(plain).toContain('^[')
    expect(plain).not.toContain('\u001b[2J')
    expect(lines.every(line => displayWidth(line) <= 60)).toBe(true)
    // On a truly narrow terminal the whole label yields rather than showing a
    // fragment of the escaped text.
    expect(overlay.render(24, 12).map(stripAnsi).join('\n')).not.toContain('^[')
  })

  it('drops whole activity facts as the terminal narrows, never cutting one in half', () => {
    const snapshot: WorkSnapshot = { available: true, subagents: [subagentItem({
      label: 'review renderer', activityWord: 'reading', activityTitle: 'overlay.ts', interruptible: false,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    const wide = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(wide).toContain('· reading overlay.ts')
    const medium = overlay.render(50, 12).map(stripAnsi).join('\n')
    expect(medium).toContain('· reading')
    expect(medium).not.toContain('overlay.ts')
    const narrow = overlay.render(35, 12).map(stripAnsi).join('\n')
    expect(narrow).toContain('review renderer')
    expect(narrow).not.toContain('· reading')
    const tiny = overlay.render(24, 12).map(stripAnsi).join('\n')
    expect(tiny).toContain('● codex')
    expect(tiny).not.toContain('review renderer')
  })

  it('pluralizes snapshot counts in the compact headline', () => {
    let snapshot: WorkSnapshot = EMPTY
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const cases = [
      [0, 0, 'No active work · esc close'],
      [0, 1, '0 subagents · 1 job · esc close'],
      [0, 2, '0 subagents · 2 jobs · esc close'],
      [1, 0, '1 subagent · 0 jobs · esc close'],
      [2, 0, '2 subagents · 0 jobs · esc close'],
      [1, 1, '1 subagent · 1 job · esc close'],
      [1, 2, '1 subagent · 2 jobs · esc close'],
      [2, 1, '2 subagents · 1 job · esc close'],
      [2, 2, '2 subagents · 2 jobs · esc close'],
    ] as const
    for (const [subagents, jobs, expected] of cases) {
      snapshot = {
        available: true,
        subagents: Array.from({ length: subagents }, (_, index) => subagentItem({ id: `subagent-${String(index)}`, runId: `subagent-${String(index)}` })),
        jobs: Array.from({ length: jobs }, (_, index) => jobItem({ id: `job-${String(index)}` })),
      }
      expect(stripAnsi(overlay.render(80, 5)[0] ?? '')).toBe(expected)
    }
  })

  it('frames one listing row at the exact height boundary and falls back below it', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, jobs: [jobItem()] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const framed = overlay.render(80, 6).map(stripAnsi)
    expect(framed).toHaveLength(6)
    expect(framed[1]).toMatch(/^╭─ dshline/u)
    expect(framed.at(-1)).toMatch(/^╰─ .*─╯$/u)
    const compact = overlay.render(80, 5).map(stripAnsi)
    expect(compact[0]).toBe('0 subagents · 1 job · esc close')
    expect(compact.join('\n')).not.toContain('╭')
  })

  it('shows an interrupt hint only for the aimed interruptible item', () => {
    const oneShot = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem({ interruptible: false })] }),
      interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(oneShot.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k interrupt')
    let jobInterrupts = 0
    const jobRow = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, jobs: [jobItem()] }),
      interrupt: () => { jobInterrupts += 1; return INTERRUPT_REQUESTED }, close: () => {}, invalidate: () => {},
    })
    expect(jobRow.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k interrupt')
    jobRow.handleKey({ kind: 'text', text: 'k' })
    expect(jobInterrupts).toBe(0)
    const continuable = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(continuable.render(80, 12).map(stripAnsi).join('\n')).toContain('k interrupt')
    // The seam is an interrupt of one turn, never a generic "stop" claim.
    expect(continuable.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k stop')
  })

  it('opens a detail stage on Enter and returns with Esc and Esc close', () => {
    let closed = 0
    const snapshot: WorkSnapshot = { available: true, subagents: [subagentItem({ label: '审查 renderer', mode: 'continuable', hasChildren: true })], jobs: [] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('detail 1 of 1')
    expect(detail).toContain('subagent  codex · 审查 renderer')
    expect(detail).toContain('lifecycle  active')
    expect(detail).toContain('mode  continuable')
    expect(detail).toContain('local agent  yes')
    expect(detail).toContain('child sessions  yes')
    expect(detail).toContain('lineage  direct child of this session')
    expect(detail).toContain('interrupt  available')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    const list = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(list).not.toContain('detail 1 of 1')
    expect(list).toContain('Subagents')
    expect(closed).toBe(0)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(1)
  })

  it('shows the deep live facts in the subagent detail stage', () => {
    const snapshot: WorkSnapshot = { available: true, subagents: [subagentItem({
      id: 'child-1', label: 'review', mode: 'continuable', activityWord: 'reading',
      activityTitle: 'overlay.ts', busy: true, agentStatus: 'running', residency: 'resident', hasChildren: true,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 14).map(stripAnsi).join('\n')
    expect(detail).toContain('activity  reading')
    expect(detail).toContain('operation  overlay.ts')
    expect(detail).toContain('agent status  running')
    expect(detail).toContain('session  child-1')
  })

  it('shows job facts without consuming output or inventing controls', () => {
    const snapshot: WorkSnapshot = { available: true, jobs: [jobItem({ detail: 'exit code: 3' })], subagents: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(detail).toContain('job  bash · pnpm test')
    expect(detail).toContain('job id  bash-1')
    expect(detail).toContain('status  running')
    expect(detail).toContain('detail  exit code: 3')
    expect(detail).toContain('owner  this session')
    expect(detail).toContain('interrupt  not available')
    expect(detail).not.toContain('k interrupt')
  })

  it('never renders a missing Job label as the literal "undefined"', () => {
    const snapshot: WorkSnapshot = { available: true, jobs: [jobItem({ id: 'j1', label: '' })], subagents: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    const rows = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(rows).not.toContain('undefined')
    expect(rows).toContain('bash')
  })

  it('leaves arrows on the list alone while a detail stage is open', () => {
    const snapshot: WorkSnapshot = {
      available: true,
      subagents: [subagentItem({ id: 'a', runId: 'a' }), subagentItem({ id: 'b', runId: 'b' })],
      jobs: [],
    }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'down' })
    const detail = overlay.render(80, 12).map(stripAnsi).join('\n')
    // Still the first row's detail: arrows scroll, they do not move the cursor.
    expect(detail).toContain('detail 1 of 2')
  })

  it('escapes control sequences in detail values and keeps every row in the frame', () => {
    const snapshot: WorkSnapshot = { available: true, subagents: [subagentItem({
      provider: '提供者', label: '审查\u001b[2J renderer', mode: 'continuable',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const lines = overlay.render(60, 10)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('^[')
    expect(plain).not.toContain('\u001b[2J')
    expect(lines.every(line => displayWidth(line) <= 60)).toBe(true)
  })

  it('keeps the inspected row fixed when a sibling above it settles', () => {
    let snapshot: WorkSnapshot = trio()
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 12).map(stripAnsi).join('\n')).toContain('session  b')
    // A settles; the detail must remain B, never silently switch to C.
    snapshot = { available: true, subagents: snapshot.subagents.slice(1), jobs: [] }
    const after = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(after).toContain('session  b')
    expect(after).not.toContain('session  c')
  })

  it('interrupts B, never C, when A disappears before a repaint', () => {
    let snapshot: WorkSnapshot = trio()
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    overlay.handleKey({ kind: 'key', name: 'enter' })
    snapshot = { available: true, subagents: [snapshot.subagents[1]!, snapshot.subagents[2]!], jobs: [] }
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['b'])
    expect(interrupted).not.toContain('c')
  })

  it('refuses to interrupt anyone when the aimed row itself disappears', () => {
    let snapshot: WorkSnapshot = trio()
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    overlay.handleKey({ kind: 'key', name: 'enter' })
    // B settles while the user still aims at it: k before a repaint must act on
    // NOBODY, because the item that inherited B's screen position is not the aim.
    snapshot = { available: true, subagents: [snapshot.subagents[0]!, snapshot.subagents[2]!], jobs: [] }
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual([])
    // The next paint re-anchors the selection onto the neighbor deliberately;
    // a fresh k against the now-visible selection targets that neighbor.
    overlay.render(80, 12)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['c'])
  })

  it('interrupts the aimed row in the plain list, not its successor', () => {
    let snapshot: WorkSnapshot = trio()
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    snapshot = { available: true, subagents: snapshot.subagents.slice(1), jobs: [] }
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['b'])
  })

  it('never carries an interrupt across a cold-resumed epoch of the same child', () => {
    let items: SubagentWorkItem[] = [
      subagentItem({ id: 'child', runId: 'epoch-1', label: 'review', mode: 'continuable' }),
    ]
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => ({ available: true, subagents: items, jobs: [] }),
      interrupt: item => { interrupted.push(item.runId); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' }) // detail on epoch-1
    // The child cold-resumes: epoch-2 opens under the same durable session id.
    items = [subagentItem({ id: 'child', runId: 'epoch-2', label: 'review', mode: 'continuable' })]
    overlay.render(80, 12) // detail on epoch-1 exits; the list re-aims on epoch-2
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['epoch-2'])
  })

  it('shares one spinner phase across animated rows and leaves idle rows static', () => {
    vi.useFakeTimers()
    const snapshot: WorkSnapshot = {
      available: true,
      subagents: [
        subagentItem({ id: 'busy-a', runId: 'busy-a', provider: 'codex', label: 'one', busy: true }),
        subagentItem({ id: 'busy-b', runId: 'busy-b', provider: 'spawn', label: 'two', busy: true }),
        subagentItem({ id: 'idle', runId: 'idle', provider: 'codex', label: 'three' }),
      ],
      jobs: [jobItem({ id: 'j1' })],
    }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.mounted?.()
    const first = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(first).toContain('◜')
    expect(first.match(/◜/gu)?.length).toBeGreaterThanOrEqual(3)
    expect(first).toContain('● codex three')
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    const second = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(second).toContain('◠')
    expect(second).not.toContain('◜')
    expect(second).toContain('● codex three')
    overlay.dispose?.()
    vi.useRealTimers()
  })

  it('leaves a stopping Job static with its distinct busy styling', () => {
    vi.useFakeTimers()
    const snapshot: WorkSnapshot = {
      available: true,
      jobs: [
        jobItem({ id: 'running' }),
        jobItem({ id: 'stopping', state: 'stopping', busy: false }),
      ],
      subagents: [],
    }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.mounted?.()
    const first = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(first).toContain('◜') // the running Job spins
    expect(first).toContain('◐') // the stopping Job keeps its own static mark
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    const second = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(second).toContain('◠') // the running Job advanced with the shared phase
    expect(second).toContain('◐') // the stopping Job never animates
    overlay.dispose?.()
    vi.useRealTimers()
  })

  it('exits cleanly when the inspected row disappears instead of showing stale authority', () => {
    let snapshot: WorkSnapshot = { available: true, subagents: [subagentItem({ id: 'child' })], jobs: [] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 12).map(stripAnsi).join('\n')).toContain('session  child')
    snapshot = { available: true, subagents: [], jobs: [] }
    const after = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(after).not.toContain('session  child')
    expect(after).toContain('No active jobs or subagents.')
  })

  it('sends ctrl-c in the detail stage back to the list, matching the child-panel convention', () => {
    let closed = 0
    const snapshot: WorkSnapshot = { available: true, subagents: [subagentItem()], jobs: [] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'ctrl-c' })
    expect(overlay.render(80, 12).map(stripAnsi).join('\n')).toContain('Subagents')
    expect(closed).toBe(0)
  })

  it('shows a failed interrupt result temporarily instead of swallowing it', () => {
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interrupt: () => ({ kind: 'failed', message: 'Interrupt failed: not authorized' }),
      close: () => {}, invalidate: () => {},
    })
    overlay.render(80, 12)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(overlay.render(80, 12).map(stripAnsi).join('\n')).toContain('Interrupt failed: not authorized')
    // A failed action must not disappear merely because the full frame cannot
    // reserve both a notice row and a list row on the smallest usable terminal.
    expect(overlay.render(14, 5).map(stripAnsi).join('\n')).toContain('Interrupt fail')
  })

  it('ticks only while mounted, so elapsed and the spinner update while the parent is idle', () => {
    vi.useFakeTimers()
    let invalidated = 0
    const overlay = createWorkOverlay({ snapshot: () => ({ ...EMPTY, available: true, jobs: [jobItem()] }), interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => { invalidated += 1 } })
    overlay.mounted?.()
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    expect(invalidated).toBe(1)
    overlay.dispose?.()
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    expect(invalidated).toBe(1)
    vi.useRealTimers()
  })

  it("leaves ctrl-d for the runner's global quit handler", () => {
    let closed = 0
    const overlay = createWorkOverlay({ snapshot: () => EMPTY, interrupt: () => INTERRUPT_REQUESTED, close: () => { closed += 1 }, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'ctrl-d' })
    expect(closed).toBe(0)
  })

  it('closes cleanly without changing committed scrollback', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()
    let overlay!: ReturnType<typeof createWorkOverlay>
    const draw = (): void => { screen.setLive(overlay.render(60, 12)) }
    overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true }),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { screen.setLive(['composer', 'status']) },
      invalidate: draw,
    })
    draw()
    overlay.handleKey({ kind: 'key', name: 'escape' })
    const after = await emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row'))).toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.join('\n')).not.toContain('Work')
  })

  it('keeps the Codex provider out of every published TUI runtime surface', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const runtimeFiles = [
      ...publishedFiles(`${root}src`),
      ...publishedFiles(`${root}bin`),
      `${root}cordis.patch.yml`,
    ].map(path => readFileSync(path, 'utf8'))
    // The publishable manifest itself must stay provider-neutral: runtime,
    // optional, peer, bundle, and future published fields are all covered by
    // reading the complete document rather than maintaining an allowlist.
    const manifest = readFileSync(`${root}package.json`, 'utf8')
    expect([...runtimeFiles, manifest].join('\n')).not.toContain('@deepseek-ai/dsh-subagent-codex')
  })
})

describe('how much work is attached to a session', () => {
  it('counts both capabilities without merging them', () => {
    // The sum answers one question — is anything still running under this agent —
    // which a lifecycle decision such as retiring it needs, and which needs no
    // correlation between a job and a subagent to be true.
    expect(activeWorkCount(EMPTY)).toBe(0)
    expect(activeWorkCount({
      available: true,
      subagents: [subagentItem({ id: 'a', runId: 'a' })],
      jobs: [jobItem({ id: 'j1' }), jobItem({ id: 'j2' })],
    })).toBe(3)
  })
})

/** Find every source file shipped in one production runtime directory. */
function publishedFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? publishedFiles(path) : [path]
  })
}

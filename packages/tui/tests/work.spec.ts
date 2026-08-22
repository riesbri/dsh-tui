/** Tests for the optional generic Harness Work projection and live overlay. */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { displayWidth, Screen, stripAnsi, wrapToWidth } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { HarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { WorkItem, WorkSnapshot, WorkStopResult } from '../src/work/model.ts'
import { activeWorkCount } from '../src/work/model.ts'

/** The root agent shape the capability contracts use for ownership. */
const agent = { session: { id: 'root' } } as unknown as Agent

/** A different exact Agent instance, proving job listeners stay owner-scoped. */
const otherAgent = { session: { id: 'other' } } as unknown as Agent

/** Standard successful stop response for overlay-only tests. */
const STOP_REQUESTED: WorkStopResult = { kind: 'requested', message: 'Stop requested.' }

/** Make a job snapshot with only the facts Work is allowed to present. */
function job(status: JobSnapshot['status'] = 'running', label = 'pnpm test'): JobSnapshot {
  return {
    id: 'bash-1' as JobSnapshot['id'],
    kind: 'bash',
    label,
    status,
    startedAt: 0,
    reported: false,
  }
}

/** A Work item for overlay-focused tests. */
function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'work-1', source: 'job', provider: 'bash', label: 'pnpm test',
    state: 'running', startedAt: 0, stoppable: true, ...overrides,
  }
}

/** Let an async discovery read publish its harmless label enrichment. */
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
    expect(work.snapshot().jobs).toMatchObject([{ provider: 'bash', label: 'pnpm test', state: 'running' }])
    expect(readCalls).toBe(0)
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
      provider: 'provider-中文', label: '审查 renderer', stoppable: true,
    }])
    ended?.({ runId: 'r1', provider: 'provider-中文', id: 'child', local: false, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
  })

  it('marks a discovered one-shot subagent as non-stoppable', async () => {
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
    expect(work.snapshot().subagents[0]?.stoppable).toBe(false)
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

  it('renders running jobs as non-stoppable and never calls jobs.kill', () => {
    let kills = 0
    const jobs = {
      list: () => [job()],
      kill: () => { kills += 1; return 'requested' },
      onJobsChanged: () => () => {},
    } as unknown as JobRegistry
    const work = new HarnessWork({ agent, jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    expect(running?.stoppable).toBe(false)
    expect(work.stop(running ?? item())).toEqual({
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
    expect(work.stop(item({ source: 'subagent', id: 'child', stoppable: true }))).toEqual(STOP_REQUESTED)
    expect(calls).toEqual([['child', { kind: 'user', parentSessionId: 'root' }]])
    expect(work.stop(item({ source: 'subagent', id: 'one-shot', stoppable: false }))).toEqual({
      kind: 'unsupported', message: 'This subagent cannot be stopped here.',
    })
    expect(calls).toHaveLength(1)
  })
})

describe('the Work live-region overlay', () => {
  it('never exceeds its physical terminal height across narrow state and size matrices', () => {
    const states: readonly WorkSnapshot[] = [
      EMPTY,
      { ...EMPTY, available: true },
      { available: true, subagents: [item({
        source: 'subagent', provider: '提供者', label: 'a deliberately long label that must not leak a row', stoppable: false,
      })], jobs: [] },
    ]
    for (const snapshot of states) {
      for (const columns of [14, 18, 24, 30]) {
        for (const rows of [7, 8, 10, 12]) {
          const overlay = createWorkOverlay({ snapshot: () => snapshot, stop: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
          const frame = overlay.render(columns, rows)
          expect(frame.flatMap(line => wrapToWidth(line, columns)).length, `${String(columns)}x${String(rows)}`)
            .toBeLessThanOrEqual(rows)
        }
      }
    }
  })

  it('renders generic provider names safely and accounts for wide labels', () => {
    const snapshot: WorkSnapshot = { available: true, subagents: [item({
      source: 'subagent', provider: '提供者', label: '审查\u001b[2J renderer', stoppable: false,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, stop: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
    const lines = overlay.render(30, 12)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('提供者')
    expect(plain).toContain('^[')
    expect(lines.every(line => displayWidth(line) <= 30)).toBe(true)
  })

  it('shows a stop hint only for the selected stoppable item', () => {
    const oneShot = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [item({ source: 'subagent', stoppable: false })] }),
      stop: () => STOP_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(oneShot.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k stop')
    let jobStops = 0
    const jobRow = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, jobs: [item({ stoppable: false })] }),
      stop: () => { jobStops += 1; return STOP_REQUESTED }, close: () => {}, invalidate: () => {},
    })
    expect(jobRow.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k stop')
    jobRow.handleKey({ kind: 'text', text: 'k' })
    expect(jobStops).toBe(0)
    const continuable = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [item({ source: 'subagent' })] }),
      stop: () => STOP_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(continuable.render(80, 12).map(stripAnsi).join('\n')).toContain('k stop')
  })

  it('shows a failed stop result temporarily instead of swallowing it', () => {
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [item({ source: 'subagent' })] }),
      stop: () => ({ kind: 'failed', message: 'Stop failed: not authorized' }),
      close: () => {}, invalidate: () => {},
    })
    overlay.render(80, 12)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(overlay.render(80, 12).map(stripAnsi).join('\n')).toContain('Stop failed: not authorized')
    // A failed action must not disappear merely because the full frame cannot
    // reserve both a notice row and a list row on the smallest usable terminal.
    expect(overlay.render(14, 7).map(stripAnsi).join('\n')).toContain('Stop failed')
  })

  it('ticks only while mounted, so elapsed work updates while the parent is idle', () => {
    vi.useFakeTimers()
    let invalidated = 0
    const overlay = createWorkOverlay({ snapshot: () => ({ ...EMPTY, available: true, jobs: [item()] }), stop: () => STOP_REQUESTED, close: () => {}, invalidate: () => { invalidated += 1 } })
    overlay.mounted?.()
    vi.advanceTimersByTime(1_000)
    expect(invalidated).toBe(1)
    overlay.dispose?.()
    vi.advanceTimersByTime(1_000)
    expect(invalidated).toBe(1)
    vi.useRealTimers()
  })

  it("leaves ctrl-d for the runner's global quit handler", () => {
    let closed = 0
    const overlay = createWorkOverlay({ snapshot: () => EMPTY, stop: () => STOP_REQUESTED, close: () => { closed += 1 }, invalidate: () => {} })
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
      stop: () => STOP_REQUESTED,
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
      subagents: [item({ id: 'a', source: 'subagent' })],
      jobs: [item({ id: 'j1' }), item({ id: 'j2' })],
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

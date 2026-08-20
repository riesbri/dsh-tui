/** Tests for the optional generic Harness Work projection and live overlay. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { displayWidth, Screen, stripAnsi } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { HarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { WorkSnapshot } from '../src/work/model.ts'

/** The root agent shape the capability contracts use for ownership. */
const agent = { session: { id: 'root' } } as unknown as Agent

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

/** Let an async discovery read publish its harmless label enrichment. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** A no-work projection used by overlay-focused tests. */
const EMPTY: WorkSnapshot = { available: false, subagents: [], jobs: [] }

describe('generic Harness Work capability projection', () => {
  it('boots without jobs or subagents', () => {
    let invalidated = 0
    const work = new HarnessWork({ agent, invalidate: () => { invalidated += 1 } })
    expect(work.snapshot()).toEqual(EMPTY)
    expect(invalidated).toBe(0)
    work.dispose()
  })

  it('boots with jobs only and never reads a job output cursor', () => {
    let readCalls = 0
    let changed: (() => void) | undefined
    const jobs = {
      list: () => [job()],
      read: () => { readCalls += 1 },
      onJobsChanged: (listener: () => void) => { changed = listener; return () => {} },
      onJobDone: () => () => {},
    } as unknown as JobRegistry
    const work = new HarnessWork({ agent, jobs, invalidate: () => {} })
    expect(work.snapshot().jobs).toMatchObject([{ provider: 'bash', label: 'pnpm test', state: 'running' }])
    changed?.()
    expect(readCalls).toBe(0)
    work.dispose()
  })

  it('refreshes when jobs change and when a job completes', () => {
    let current = job()
    let changed: ((owner: Agent | undefined) => void) | undefined
    let done: ((snapshot: JobSnapshot, owner: Agent | undefined) => void) | undefined
    let invalidated = 0
    const jobs = {
      list: () => [current],
      onJobsChanged: (listener: (owner: Agent | undefined) => void) => { changed = listener; return () => {} },
      onJobDone: (listener: (snapshot: JobSnapshot, owner: Agent | undefined) => void) => { done = listener; return () => {} },
    } as unknown as JobRegistry
    const work = new HarnessWork({ agent, jobs, invalidate: () => { invalidated += 1 } })
    changed?.(agent)
    expect(invalidated).toBe(1)
    current = job('completed')
    done?.(current, agent)
    expect(invalidated).toBe(2)
    expect(work.snapshot().jobs).toEqual([])
  })

  it('boots with subagents only and refreshes on generic lifecycle edges', async () => {
    let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
    let ended: ((info: { runId: string; provider: string; id: string; local: boolean; stopReason: 'completed' }) => void) | undefined
    let invalidated = 0
    const subagents = {
      listDescendants: async () => [{
        kind: 'child', id: 'child', mode: 'continuable', label: '审查 renderer', activity: 'running', hasChildren: false,
        parentId: 'root', depth: 1,
      }],
    } as unknown as SubagentRuntime
    const work = new HarnessWork({
      agent,
      subagents,
      onSubagentStart: listener => { started = listener as typeof started; return () => {} },
      onSubagentEnd: listener => { ended = listener as typeof ended; return () => {} },
      invalidate: () => { invalidated += 1 },
    })
    await settled()
    started?.({ runId: 'r1', provider: 'provider-中文', id: 'child', local: false })
    await settled()
    expect(work.snapshot().subagents).toMatchObject([{
      provider: 'provider-中文', label: '审查 renderer', stoppable: true,
    }])
    ended?.({ runId: 'r1', provider: 'provider-中文', id: 'child', local: false, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
    expect(invalidated).toBeGreaterThanOrEqual(3)
  })
})

describe('the Work live-region overlay', () => {
  it('shows a useful empty state and is bounded on tiny terminals', () => {
    const overlay = createWorkOverlay({ snapshot: () => EMPTY, stop: () => {}, close: () => {}, invalidate: () => {} })
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).toContain('not installed')
    for (const [columns, rows] of [[80, 6], [12, 5], [12, 1]] as const) {
      const frame = overlay.render(columns, rows)
      expect(frame.length).toBeLessThanOrEqual(rows)
      expect(frame.map(stripAnsi).join('\n')).toContain('esc close')
    }
  })

  it('renders generic provider names safely and accounts for wide labels', () => {
    const snapshot: WorkSnapshot = {
      available: true,
      subagents: [{
        id: 'child', source: 'subagent', provider: '提供者', label: '审查\u001b[2J renderer', state: 'running', startedAt: 0, stoppable: true,
      }],
      jobs: [],
    }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, stop: () => {}, close: () => {}, invalidate: () => {} })
    const lines = overlay.render(30, 12)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('提供者')
    expect(plain).toContain('^[')
    expect(lines.every(line => displayWidth(line) <= 30)).toBe(true)
  })

  it('routes k to the generic stop callback for the selected item', () => {
    const selected = { id: 'bash-1', source: 'job' as const, provider: 'bash', label: 'test', state: 'running' as const, startedAt: 0, stoppable: true }
    let stopped: string | undefined
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, jobs: [selected] }),
      stop: item => { stopped = item.id },
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 12)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(stopped).toBe('bash-1')
  })

  it("leaves ctrl-d for the runner's global quit handler", () => {
    let closed = 0
    const overlay = createWorkOverlay({ snapshot: () => EMPTY, stop: () => {}, close: () => { closed += 1 }, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'ctrl-d' })
    expect(closed).toBe(0)
  })

  it('closes cleanly without changing committed scrollback', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()
    let closed = 0
    let overlay!: ReturnType<typeof createWorkOverlay>
    const draw = (): void => { screen.setLive(overlay.render(60, 12)) }
    overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true }),
      stop: () => {},
      close: () => { closed += 1; screen.setLive(['composer', 'status']) },
      invalidate: draw,
    })
    draw()
    overlay.handleKey({ kind: 'key', name: 'escape' })
    const after = await emulator.scrollback()
    expect(closed).toBe(1)
    expect(after.filter(row => row.includes('committed transcript row'))).toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.join('\n')).not.toContain('Work')
    expect((await emulator.screen()).map(row => row.trimEnd())).toContain('composer')
  })

  it('does not import a Codex provider implementation', () => {
    const source = readFileSync(new URL('../src/work/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('@deepseek-ai/dsh-subagent-codex')
  })
})

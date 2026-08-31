/**
 * Tests for Work's detail-row navigation.
 *
 * The property under test is that every stage is a real inspectable list: the
 * visible cursor moves with the arrows in a detail view exactly as it does on
 * the overview, a focused row does not have to be actionable, and the scroll
 * position follows the cursor instead of drifting independently of it.
 */

import { describe, expect, it } from 'vitest'
import { stripAnsi } from '@dshline/renderer'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type {
  JobWorkItem,
  SubagentWorkItem,
  WorkflowMemberItem,
  WorkflowWorkItem,
  WorkInterruptResult,
  WorkSnapshot,
} from '../src/work/model.ts'

/** Standard successful interrupt response. */
const INTERRUPT_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Interrupt requested.' }

/** A no-work projection tests extend. */
const EMPTY: WorkSnapshot = { available: true, workflows: [], subagents: [], jobs: [] }

/** A live subagent epoch. */
function subagentItem(overrides: Partial<SubagentWorkItem> = {}): SubagentWorkItem {
  return {
    id: 'child-1', source: 'subagent', runId: 'epoch-1', provider: 'spawn', local: true,
    state: 'running', startedAt: Date.now(), mode: 'continuable', interruptible: true,
    residency: 'resident', hasChildren: true, agentStatus: 'running', busy: true,
    activityWord: 'editing', activityTitle: 'overlay.ts', label: 'renderer review', ...overrides,
  }
}

/** A background job record. */
function jobItem(overrides: Partial<JobWorkItem> = {}): JobWorkItem {
  return {
    id: 'bash-1', source: 'job', kind: 'bash', label: 'pnpm test', state: 'running',
    startedAt: Date.now(), ownership: 'this-session', detail: 'exit code pending', interruptible: false, ...overrides,
  }
}

/** A workflow row. */
function workflowItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: 'run-1', source: 'workflow', label: 'repo-audit', startedAt: Date.now(),
    state: 'running', members: [], interruptible: false, ...overrides,
  }
}

/** A published workflow member. */
function memberItem(overrides: Partial<WorkflowMemberItem> = {}): WorkflowMemberItem {
  return { seq: 1, label: 'architecture', childId: 'child-1', ...overrides }
}

/** One overlay plus a reader for the row the cursor is on. */
function driver(snapshot: () => WorkSnapshot, options: {
  readonly interrupt?: (item: { id: string }) => WorkInterruptResult
} = {}): {
  readonly overlay: ReturnType<typeof createWorkOverlay>
  readonly rows: (columns?: number, rows?: number) => string[]
  readonly cursor: (columns?: number, rows?: number) => string
  readonly press: (name: 'up' | 'down' | 'enter' | 'escape' | 'home' | 'end') => void
} {
  const overlay = createWorkOverlay({
    snapshot,
    interrupt: item => options.interrupt?.(item) ?? INTERRUPT_REQUESTED,
    close: () => {},
    invalidate: () => {},
  })
  const rows = (columns = 80, terminalRows = 40): string[] => overlay.render(columns, terminalRows).map(stripAnsi)
  return {
    overlay,
    rows,
    cursor: (columns = 80, terminalRows = 40) => {
      const found = rows(columns, terminalRows).find(row => row.includes('❯')) ?? ''
      return found.replace(/^│ /u, '').replace(/\s*│$/u, '').replace(/^❯ /u, '').trim()
    },
    press: name => {
      overlay.render(80, 40)
      overlay.handleKey({ kind: 'key', name })
    },
  }
}

describe('Work detail-row navigation', () => {
  it('moves the visible cursor through a subagent detail with the arrows', () => {
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }))
    app.press('enter')
    const first = app.cursor()
    expect(first).toContain('editing · overlay.ts')
    app.press('down')
    expect(app.cursor()).toBe('provider  spawn')
    app.press('down')
    expect(app.cursor()).toMatch(/^elapsed /u)
    app.press('up')
    expect(app.cursor()).toBe('provider  spawn')
    // Exactly one row is ever highlighted.
    expect(app.rows().filter(row => row.includes('❯'))).toHaveLength(1)
  })

  it('moves the visible cursor through a job detail with the arrows', () => {
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }))
    app.press('enter')
    expect(app.cursor()).toBe('status  running')
    app.press('down')
    expect(app.cursor()).toBe('kind  bash')
    app.press('down')
    expect(app.cursor()).toBe('detail  exit code pending')
    app.press('end')
    expect(app.cursor()).toBe('job id  bash-1')
  })

  it('moves the visible cursor through a workflow detail with the arrows', () => {
    const app = driver(() => ({
      ...EMPTY,
      workflows: [workflowItem({ description: 'Audit Work architecture', members: [memberItem()] })],
    }))
    app.press('enter')
    expect(app.cursor()).toBe('description  Audit Work architecture')
    app.press('down')
    expect(app.cursor()).toBe('state  running')
    app.press('end')
    expect(app.cursor()).toBe('● architecture')
  })

  it('wraps the cursor at both ends of a detail stage', () => {
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }))
    app.press('enter')
    const top = app.cursor()
    app.press('up')
    expect(app.cursor()).toBe('job id  bash-1')
    app.press('down')
    expect(app.cursor()).toBe(top)
  })

  it('ignores Enter on a fact row instead of inventing an action', () => {
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }))
    app.press('enter')
    const before = app.rows().join('\n')
    app.press('enter')
    app.press('enter')
    expect(app.rows().join('\n')).toBe(before)
  })

  it('scrolls the detail viewport to keep the focused row visible', () => {
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }))
    app.press('enter')
    // A short terminal shows only the head of the view. Every step must keep the
    // cursor on screen instead of scrolling out from under it.
    const short = 11
    expect(app.rows(80, short).join('\n')).not.toContain('local agent')
    for (let step = 0; step < 12; step += 1) {
      app.overlay.render(80, short)
      app.overlay.handleKey({ kind: 'key', name: 'down' })
      expect(app.rows(80, short).filter(row => row.includes('❯')), `step ${String(step)}`).toHaveLength(1)
    }
    app.overlay.render(80, short)
    app.overlay.handleKey({ kind: 'key', name: 'end' })
    const rows = app.rows(80, short)
    expect(rows.filter(row => row.includes('❯'))).toHaveLength(1)
    expect(rows.join('\n')).toContain('local agent  yes')
  })

  it('keeps the detail cursor on its fact while the subject\'s live facts change', () => {
    let word: SubagentWorkItem['activityWord'] = 'editing'
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem({ activityWord: word })] }))
    app.press('enter')
    app.press('down')
    app.press('down')
    expect(app.cursor()).toMatch(/^elapsed /u)
    word = 'thinking'
    // The activity headline changed above the cursor; the cursor is an identity,
    // so it stays on `elapsed` instead of sliding with the row order.
    expect(app.cursor()).toMatch(/^elapsed /u)
  })

  it('gains the interrupt row on a continuable child and never announces its absence', () => {
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }))
    app.press('enter')
    expect(app.rows().join('\n')).toContain('interrupt  available')
    const oneShot = driver(() => ({ ...EMPTY, subagents: [subagentItem({ mode: 'one-shot', interruptible: false })] }))
    oneShot.press('enter')
    expect(oneShot.rows().join('\n')).not.toContain('interrupt')
  })

  it('keeps k aimed at the inspected subject while the cursor sits on a fact row', () => {
    const interrupted: string[] = []
    const app = driver(
      () => ({ ...EMPTY, subagents: [subagentItem()] }),
      { interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED } },
    )
    app.press('enter')
    app.press('down')
    app.press('down')
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['child-1'])
  })

  it('never navigates to a successor when the aimed member disappears first', () => {
    const live = subagentItem({ id: 'child-2', runId: 'epoch-2', label: 'renderer' })
    const survivor = subagentItem({ id: 'child-3', runId: 'epoch-3', label: 'security' })
    let members: WorkflowMemberItem[] = [
      memberItem({ seq: 1, label: 'renderer', childId: 'child-2', subagent: live }),
      memberItem({ seq: 2, label: 'security', childId: 'child-3', subagent: survivor }),
    ]
    let subagents: SubagentWorkItem[] = [live, survivor]
    const app = driver(() => ({ ...EMPTY, workflows: [workflowItem({ members })], subagents }))
    app.press('enter')
    app.press('end')
    app.press('up')
    expect(app.cursor()).toContain('renderer')
    // The aimed member settles before the keystroke is read.
    members = [
      memberItem({ seq: 1, label: 'renderer', childId: 'child-2', outcome: 'completed' }),
      memberItem({ seq: 2, label: 'security', childId: 'child-3', subagent: survivor }),
    ]
    subagents = [survivor]
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    const after = app.rows().join('\n')
    // Still the workflow: Enter must not have opened the member that inherited
    // the aimed row's screen position.
    expect(after).toContain('Workflow · repo-audit')
    expect(after).not.toContain('Subagent · security')
  })

  it('never opens a successor when the aimed overview row disappears first', () => {
    let workflows = [workflowItem({ id: 'run-1', label: 'first' }), workflowItem({ id: 'run-2', label: 'second' })]
    const app = driver(() => ({ ...EMPTY, workflows }))
    app.press('down')
    expect(app.cursor()).toContain('second')
    // The aimed run closes before the keystroke is read.
    workflows = [workflowItem({ id: 'run-1', label: 'first' })]
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    const after = app.rows().join('\n')
    expect(after).toContain('Workflows')
    expect(after).not.toContain('Workflow · first')
    // The next paint re-anchors deliberately; Enter then opens what is visible.
    app.press('enter')
    expect(app.rows().join('\n')).toContain('Workflow · first')
  })

  it('returns one hierarchy level per Esc and closes only from the overview', () => {
    let closed = 0
    const child = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const overlay = createWorkOverlay({
      snapshot: () => ({
        ...EMPTY,
        workflows: [workflowItem({ members: [memberItem({ subagent: child })] })],
        subagents: [child],
      }),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    const read = (): string => overlay.render(80, 40).map(stripAnsi).join('\n')
    read()
    overlay.handleKey({ kind: 'key', name: 'enter' })
    read()
    overlay.handleKey({ kind: 'key', name: 'end' })
    read()
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(read()).toContain('Subagent ·')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(read()).toContain('Workflow · repo-audit')
    expect(closed).toBe(0)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(read()).toContain('Workflows')
    expect(closed).toBe(0)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(1)
  })

  it('describes Enter in the footer only while the focused row can be opened', () => {
    const child = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const app = driver(() => ({
      ...EMPTY,
      workflows: [workflowItem({ members: [memberItem({ subagent: child })] })],
      subagents: [child],
    }))
    expect(app.rows().join('\n')).toContain('↵ inspect')
    app.press('enter')
    // Parked on a fact row, Enter does nothing and the footer says nothing about it.
    expect(app.rows().join('\n')).not.toContain('↵ inspect')
    app.press('end')
    expect(app.rows().join('\n')).toContain('↵ inspect')
  })
})

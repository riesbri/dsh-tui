/**
 * What the status line actually says as a terminal narrows.
 *
 * The composition rules are three nested preferences deep, and a string
 * assertion at one width proves nothing about the width either side of it. The
 * failure worth catching is a segment that survives in HALF — a cut round count
 * or a cut objective reads as a different fact, not as a smaller one — so this
 * resizes across the range a real window is dragged through and reads the cells.
 */

import { describe, expect, it } from 'vitest'
import { Screen } from 'dshline-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import type { StatusState } from '../src/views.ts'
import { createStatusView } from '../src/views.ts'

/** A session with every mode reporting at once, which is the crowded case. */
const CROWDED: StatusState = {
  busy: true,
  tick: 0,
  elapsedMs: 866_000,
  activity: { name: 'run_shell_command', others: 2 },
  model: 'x-preview-f-free',
  effort: undefined,
  usage: '↑2.3M ↓21k',
  tokens: 68_000,
  contextWindow: 1_000_000,
  detail: 'compact',
  work: undefined,
  todo: 'todo 5/11',
  plan: false,
  goal: { label: 'goal armed · ship the release', short: 'goal armed', running: true },
}

/**
 * Draw the status line on a real terminal and read the row back.
 * @param columns - the terminal width.
 * @returns the visible status row.
 */
async function row(columns: number): Promise<string> {
  const emulator = createEmulator(columns, 24)
  new Screen(emulator.target).setLive(createStatusView(() => CROWDED).render(columns))
  return (await emulator.screen()).map(line => line.trimEnd()).find(line => line !== '') ?? ''
}

describe('the status line on a real terminal', () => {
  it('never wraps onto a second row, at any width', async () => {
    for (const columns of [20, 30, 40, 50, 60, 72, 80, 100, 120, 160]) {
      const emulator = createEmulator(columns, 24)
      new Screen(emulator.target).setLive(createStatusView(() => CROWDED).render(columns))
      const drawn = (await emulator.screen()).map(line => line.trimEnd()).filter(line => line !== '')
      expect(drawn.length, `${String(columns)} columns: ${JSON.stringify(drawn)}`).toBe(1)
    }
  })

  it('never leaves half a mode on the line', async () => {
    for (const columns of [20, 26, 30, 34, 40, 46, 52, 58, 64, 72, 80, 100, 120]) {
      const line = await row(columns)
      // Either the whole objective or none of it; either `goal armed` or no goal.
      const halfObjective = line.includes('ship') && !line.includes('ship the release')
      const halfGoal = /goal(?! armed)\S*\s*$/u.test(line)
      const halfTodo = line.includes('todo') && !line.includes('todo 5/11')
      expect(halfObjective || halfGoal || halfTodo, `${String(columns)} columns: ${JSON.stringify(line)}`)
        .toBe(false)
    }
  })

  it('gives things up in the documented order as the window shrinks', async () => {
    // Widest: everything, objective included.
    expect(await row(120)).toContain('ship the release')
    // The objective goes before the goal does.
    const middle = await row(60)
    expect(middle).toContain('goal armed')
    expect(middle).not.toContain('ship the release')
    // The goal outlives the model name and the session totals both.
    const narrow = await row(44)
    expect(narrow).toContain('goal armed')
    expect(narrow).not.toContain('x-preview-f-free')
    expect(narrow).not.toContain('2.3M')
  })
})

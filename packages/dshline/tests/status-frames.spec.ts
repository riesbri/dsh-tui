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
import { Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import type { StatusState } from '../src/views.ts'
import { createStatusView } from '../src/views.ts'

/** A session with every mode reporting at once, which is the crowded case. */
const CROWDED: StatusState = {
  busy: true,
  tick: 0,
  elapsedMs: 866_000,
  activityWord: 'responding',
  activity: { title: 'run_shell_command', others: 2 },
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
    // The goal outlives the model name and the session totals both. The
    // semantic word and its ` · turn` label sit beside the reading, so the
    // widths that prove the order sit wider than they did for `working`.
    const narrow = await row(58)
    expect(narrow).toContain('goal armed')
    expect(narrow).not.toContain('x-preview-f-free')
    expect(narrow).not.toContain('2.3M')
  })

  it('separates the spinner from the activity word with two spaces at every width', async () => {
    for (const columns of [20, 30, 40, 50, 60, 80, 120]) {
      const line = await row(columns)
      // The busy core is `spinner + two ASCII spaces + word`. Within it the
      // separator must never degrade to one space or a wide space, and the
      // spinner must never sit against a truncated word.
      expect(line, `${String(columns)} columns`).toMatch(/◜ {2}responding/u)
      expect(line, `${String(columns)} columns`).not.toMatch(/◜ {1}responding/u)
    }
  })

  it('drops the turn elapsed as a whole fact before the word is ever cut', async () => {
    const roomy = await row(60)
    expect(roomy).toContain('· turn 14m 26s')
    // Narrower than the full status with the reading: the whole ` · turn`
    // segment yields, never a partial `· turn 14m 4`.
    const narrow = await row(20)
    expect(narrow).not.toContain('turn 14m')
    expect(narrow).toContain('responding')
    expect(narrow).not.toContain('…')
  })

  it('styles the spinner with the busy role and the word with the subdued role', async () => {
    const emulator = createEmulator(80, 24)
    new Screen(emulator.target).setLive(createStatusView(() => CROWDED).render(80))
    const rows = (await emulator.screen()).map(line => line.trimEnd())
    const at = rows.findIndex(line => line.includes('◜'))
    expect(at).toBeGreaterThanOrEqual(0)
    // Row text: `  ◜  responding …` — spinner at column 2, word at column 5.
    const spinner = await emulator.cell(2, at)
    const word = await emulator.cell(5, at)
    expect(spinner?.chars).toBe('◜')
    expect(await emulator.cell(3, at)).toEqual({ chars: ' ', bold: false })
    expect(await emulator.cell(4, at)).toEqual({ chars: ' ', bold: false })
    expect(word?.chars).toBe('r')
    // The busy accent is yellow (ANSI 33 -> fg 3); the word is dimmed subdued.
    expect(spinner?.fg).toBe(3)
    expect(word?.fg).not.toBe(3)
    expect(word?.bold).toBe(false)
  })
})

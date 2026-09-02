/**
 * `/enter`, the one terminal-native way to change what busy enter means.
 *
 * Exercised through its seams rather than through an overlay, which is what the
 * module was separated for: the grammar (a value changes it, a bare name asks),
 * the apply-before-store ordering, and the wording are all decidable without a
 * terminal.
 */

import { stripAnsi } from '@dshline/renderer'
import { describe, expect, it, vi } from 'vitest'
import type { BusyEnter } from '../src/delivery.ts'
import { BUSY_ENTER_CHOICES, runEnterCommand } from '../src/enter.ts'

/**
 * Drive the command with recording seams.
 * @param options - the starting value, what a picker would answer, and whether
 *   storing succeeds.
 * @returns the seams and the lines the command printed.
 */
function harness(options: { current?: BusyEnter; picks?: string | undefined; note?: string } = {}) {
  let current: BusyEnter = options.current ?? 'queue'
  const lines: string[] = []
  const applied: BusyEnter[] = []
  const remembered: BusyEnter[] = []
  const choose = vi.fn(async () => options.picks)
  const spec = {
    current: () => current,
    apply: (value: BusyEnter) => {
      applied.push(value)
      current = value
    },
    commit: (committed: readonly string[]) => { lines.push(...committed.map(stripAnsi)) },
    choose,
    remember: async (value: BusyEnter) => {
      remembered.push(value)
      return options.note
    },
  }
  return { spec, lines, applied, remembered, choose, value: () => current }
}

describe('naming a value', () => {
  it('adopts it and says what enter now does', async () => {
    const h = harness({ current: 'queue' })
    await runEnterCommand(h.spec, 'steer')
    expect(h.applied).toStrictEqual(['steer'])
    expect(h.value()).toBe('steer')
    expect(h.lines[0]).toContain('enter while running: steer')
    expect(h.lines[0]).toContain('next step')
  })

  it('never opens a picker when the reader already said which', async () => {
    // The grammar this interface already follows: a picker is a good way to read
    // two descriptions and a bad way to set something you know.
    const h = harness()
    await runEnterCommand(h.spec, 'steer')
    expect(h.choose).not.toHaveBeenCalled()
  })

  it('accepts the value whatever case and spacing it arrives in', async () => {
    const h = harness()
    await runEnterCommand(h.spec, '  STEER  ')
    expect(h.applied).toStrictEqual(['steer'])
  })

  it('reports an unknown value without changing anything', async () => {
    const h = harness({ current: 'queue' })
    await runEnterCommand(h.spec, 'yolo')
    expect(h.applied).toStrictEqual([])
    expect(h.remembered).toStrictEqual([])
    expect(h.value()).toBe('queue')
    expect(h.lines[0]).toContain('queue or steer')
  })

  it('escapes a rejected value rather than drawing it', async () => {
    // The value is the reader's own text, so it is untrusted like any other:
    // made safe before it is styled, never after.
    const h = harness()
    await runEnterCommand(h.spec, 'ember[2J')
    expect(h.lines[0]).not.toContain('[2J')
    expect(h.lines[0]).toContain('^[')
  })
})

describe('asking with a bare command', () => {
  it('opens the picker with the current value highlighted, and adopts the answer', async () => {
    const h = harness({ current: 'queue', picks: 'steer' })
    await runEnterCommand(h.spec, '')
    expect(h.choose).toHaveBeenCalledWith('queue')
    expect(h.applied).toStrictEqual(['steer'])
  })

  it('changes and reports nothing when the picker is dismissed', async () => {
    const h = harness({ current: 'steer', picks: undefined })
    await runEnterCommand(h.spec, '')
    expect(h.applied).toStrictEqual([])
    expect(h.remembered).toStrictEqual([])
    expect(h.lines).toStrictEqual([])
    expect(h.value()).toBe('steer')
  })
})

describe('storing the choice', () => {
  it('applies before it stores, and keeps the choice when the write fails', async () => {
    // The same ordering `/theme` and the model route follow: the next enter has
    // already been promised a meaning, so a document that could not be written
    // is a reason to say so rather than to put the behaviour back.
    const h = harness({ current: 'queue', note: 'not saved: this profile mounts no settings provider' })
    await runEnterCommand(h.spec, 'steer')
    expect(h.applied).toStrictEqual(['steer'])
    expect(h.value()).toBe('steer')
    expect(h.lines[0]).toContain('mounts no settings provider')
    expect(h.lines[0]).toContain('enter while running: steer')
  })

  it('adds nothing to the report when the write succeeded', async () => {
    const h = harness()
    await runEnterCommand(h.spec, 'steer')
    expect(h.lines[0]).not.toContain('not saved')
    expect(h.lines[0]).not.toContain('could not save')
  })

  it('works with no storage seam at all', async () => {
    const lines: string[] = []
    let current: BusyEnter = 'queue'
    await runEnterCommand({
      current: () => current,
      apply: value => { current = value },
      commit: committed => { lines.push(...committed.map(stripAnsi)) },
      choose: async () => undefined,
    }, 'steer')
    expect(current).toBe('steer')
    expect(lines[0]).toContain('enter while running: steer')
  })
})

describe('what the report teaches', () => {
  it('names the alternate gesture, and only as far as it is true', async () => {
    // The composer cannot advertise `ctrl-enter`: it is byte-identical to enter
    // on a terminal without an enhanced encoding, and there is nothing to ask.
    // This is where it is taught instead, and the qualifier is the whole reason
    // it is safe to say here at all.
    const queue = harness({ current: 'steer' })
    await runEnterCommand(queue.spec, 'queue')
    expect(queue.lines[0]).toContain('ctrl-enter steers instead')
    expect(queue.lines[0]).toContain('where your terminal sends it')

    const steer = harness({ current: 'queue' })
    await runEnterCommand(steer.spec, 'steer')
    expect(steer.lines[0]).toContain('ctrl-enter queues instead')
  })

  it('offers both values with a description each, for completion and the picker', () => {
    expect(BUSY_ENTER_CHOICES.map(choice => choice.value)).toStrictEqual(['queue', 'steer'])
    for (const choice of BUSY_ENTER_CHOICES) expect(choice.description.length).toBeGreaterThan(0)
  })
})

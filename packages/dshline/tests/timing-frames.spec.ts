/** Real-terminal frames for the persistent timing panel. */

import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Composer, displayWidth, Screen } from '@dshline/renderer'
import { describe, expect, it, vi } from 'vitest'
import { createEmulator } from '../../../tests/emulator.ts'
import { TuiSlots } from '../src/slots.ts'
import { createTimingView, TurnTimer } from '../src/timing.ts'
import { createComposerView, createStatusView } from '../src/views.ts'

/** Standard frame width, narrow enough that bars have to make real trade-offs. */
const COLUMNS = 40

/** Standard frame height, small enough to exercise the panel's row budget. */
const ROWS = 12

/** One log event, with only the fields the timer reads. */
function event(time: number, type: string, data: unknown): SessionEvent {
  return { time, type, data } as unknown as SessionEvent
}

/** A streamed delta of one kind, at one moment. */
function delta(time: number, type: 'reasoning-delta' | 'text-delta'): SessionEvent {
  return event(time, 'assistant/chunk', { turn: 1, step: 0, chunk: { type, text: 'x' } })
}

/** Start one tool call. */
function call(time: number, callId: string, name: string): SessionEvent {
  return event(time, 'tool/call', { turn: 1, step: 0, callId, name, arguments: '{}' })
}

/** Finish one tool call. */
function result(time: number, callId: string): SessionEvent {
  return event(time, 'tool/result', {
    turn: 1,
    step: 0,
    message: { content: [{ toolCallId: callId }] },
  })
}

/** The plain non-empty rows a person currently sees. */
async function visible(emulator: ReturnType<typeof createEmulator>): Promise<string[]> {
  return (await emulator.screen()).map(row => row.trimEnd()).filter(row => row !== '')
}

/**
 * Mount the real slot composition and Screen redraw path.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @param typed - optional multi-line composer content.
 * @returns state controls and a draw function.
 */
function terminal(columns = COLUMNS, rows = ROWS, typed = ''): {
  readonly emulator: ReturnType<typeof createEmulator>
  readonly screen: Screen
  readonly timer: TurnTimer
  readonly enabled: { value: boolean }
  readonly draw: () => void
} {
  const emulator = createEmulator(columns, rows)
  const screen = new Screen(emulator.target)
  const timer = new TurnTimer()
  const enabled = { value: true }
  const slots = new TuiSlots(new Context())
  const below = (): number => enabled.value ? 2 : 1
  const composer = new Composer()
  if (typed !== '') composer.handle({ kind: 'text', text: typed })
  slots.register('composer', createComposerView(composer, '/work', below))
  slots.register('timing', createTimingView(timer, () => enabled.value))
  slots.register('status', createStatusView(() => ({
    busy: false,
    tick: 0,
    elapsedMs: undefined,
    activity: undefined,
    model: undefined,
    effort: undefined,
    usage: undefined,
    tokens: undefined,
    contextWindow: undefined,
    detail: 'compact',
    work: undefined,
    todo: undefined,
    plan: false,
    goal: undefined,
  })))
  return {
    emulator,
    screen,
    timer,
    enabled,
    draw: () => { screen.setLive(slots.compose(columns, rows).lines) },
  }
}

describe('the timing live panel on a real terminal', () => {
  it('is present while on and leaves no row at all while off', async () => {
    const frame = terminal()
    frame.draw()
    expect((await visible(frame.emulator)).join('\n')).toContain('timing · no turn measured yet')

    frame.enabled.value = false
    frame.draw()
    const off = (await visible(frame.emulator)).join('\n')
    expect(off).not.toContain('timing')
    expect(off).toContain('ask anything')
    expect(off).toContain('ready')
  })

  it('grows open measurements between event batches and stops finished tools', async () => {
    let now = 5_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const frame = terminal()
    frame.timer.observe(event(1_000, 'turn/start', { turn: 1 }))
    frame.timer.observe(delta(2_000, 'reasoning-delta'))
    frame.timer.observe(delta(4_000, 'reasoning-delta'))
    frame.timer.observe(call(4_500, 'a', 'bash'))
    frame.draw()
    const first = (await visible(frame.emulator)).join('\n')
    expect(first).toContain('turn 1 · 4.0s · live')
    expect(first).toContain('0.5s')

    now = 8_000
    frame.timer.observe(result(7_000, 'a'))
    frame.draw()
    const second = (await visible(frame.emulator)).join('\n')
    expect(second).toContain('turn 1 · 7.0s · live')
    expect(second).toContain('2.5s')

    now = 20_000
    frame.draw()
    const third = (await visible(frame.emulator)).join('\n')
    expect(third).toContain('turn 1 · 19.0s · live')
    expect(third).toContain('2.5s')
    clock.mockRestore()
  })

  it('caps tool-heavy turns and keeps the whole live region on screen', async () => {
    const frame = terminal()
    frame.timer.observe(event(0, 'turn/start', { turn: 1 }))
    for (let index = 0; index < 12; index += 1) {
      const id = String(index)
      frame.timer.observe(call(index * 10, id, `tool-${id}`))
      frame.timer.observe(result(2_000 + index, id))
    }
    frame.timer.observe(event(3_000, 'turn/end', { turn: 1, reason: 'complete' }))
    frame.draw()
    const shown = await visible(frame.emulator)
    expect(shown.join('\n')).toContain('+8 more')
    expect(frame.screen.height).toBe(11)
    expect(frame.screen.height).toBeLessThanOrEqual(ROWS)
    expect((await frame.emulator.scrollback()).filter(row => row.includes('timing'))).toHaveLength(1)
  })

  it('keeps its header present when a tall composer spends the rest of the screen', async () => {
    const rows = 16
    const typed = Array.from({ length: 20 }, (_unused, index) => `line ${String(index)}`).join('\n')
    const frame = terminal(COLUMNS, rows, typed)
    frame.timer.observe(event(0, 'turn/start', { turn: 1 }))
    frame.draw()
    const shown = (await visible(frame.emulator)).join('\n')
    expect(frame.screen.height).toBeLessThanOrEqual(rows)
    expect(shown).toContain('line 19')
    expect(shown).toContain('timing · turn 1')
    expect(shown).toContain('ready')
  })

  it('fits every logical panel row without wrapping on a narrow terminal', async () => {
    const columns = 14
    const frame = terminal(columns, ROWS)
    frame.timer.observe(event(0, 'turn/start', { turn: 88 }))
    frame.timer.observe(call(0, 'a', '工具\u001b[2J-name'))
    frame.timer.observe(result(12_345, 'a'))
    frame.timer.observe(event(12_345, 'turn/end', { turn: 88, reason: 'complete' }))
    frame.draw()
    const shown = await visible(frame.emulator)
    expect(shown.every(row => displayWidth(row) <= columns)).toBe(true)
    expect(shown.join('\n')).toContain('timing')
    expect((await frame.emulator.scrollback()).filter(row => row.includes('╭─ work'))).toHaveLength(1)
  })

  it('shows a placeholder after resume instead of fabricating timing history', async () => {
    // A resumed attachment deliberately has a fresh live-only fold. Its replay
    // omits streamed chunks, so reconstructing a historical chart would be false.
    const resumed = terminal()
    resumed.screen.commit(['● reply restored from the session log'])
    resumed.draw()
    const shown = (await visible(resumed.emulator)).join('\n')
    expect(shown).toContain('reply restored from the session log')
    expect(shown).toContain('timing · no turn measured yet')
    expect(shown).not.toContain('turn 1')
  })

  it('does not commit a finished timing panel beneath the reply', async () => {
    const frame = terminal()
    frame.timer.observe(event(0, 'turn/start', { turn: 1 }))
    frame.timer.observe(delta(1_000, 'text-delta'))
    frame.timer.observe(delta(2_000, 'text-delta'))
    frame.timer.observe(event(3_000, 'turn/end', { turn: 1, reason: 'complete' }))
    frame.screen.commit(['● finished reply'])
    frame.draw()
    const history = await frame.emulator.scrollback()
    expect(history.filter(row => row.includes('finished reply'))).toHaveLength(1)
    expect(history.filter(row => row.includes('timing'))).toHaveLength(1)
  })
})

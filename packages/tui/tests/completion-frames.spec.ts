/**
 * A long suggestion list on a real terminal.
 *
 * Completion is not an overlay: it shares the live region with the composer and
 * the status line, and `Screen` erases that region by climbing rows. A list that
 * renders more rows than the terminal has therefore pushes the composer off the
 * top, where the next redraw can no longer reach it — and the transcript above
 * gains a duplicate copy of the chrome. Read as plain text every one of those
 * frames looks correct, so the assertions here are about what the terminal HOLDS.
 */

import { describe, expect, it } from 'vitest'
import { Composer, Screen } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { createCompletion } from '../src/completion.ts'
import { createComposerView, createStatusView } from '../src/views.ts'

/** The width used by the real-terminal regression frames. */
const COLUMNS = 80

/** More commands than a short terminal can show at once. */
const COMMANDS = Array.from({ length: 15 }, (_unused, index) => ({
  name: index === 14 ? 'command-last-sentinel' : `command-${String(index).padStart(2, '0')}`,
  description: 'what this one does',
}))

/**
 * Mount the whole live region — composer, completion, status — over an emulator.
 * @param rows - the emulator's height.
 * @returns the emulator, the completion, and a repaint of the live region.
 */
async function terminal(rows: number): Promise<{
  emulator: ReturnType<typeof createEmulator>
  completion: ReturnType<typeof createCompletion>
  draw: () => void
}> {
  const emulator = createEmulator(COLUMNS, rows)
  const screen = new Screen(emulator.target)
  screen.commit(['TRANSCRIPT above list A', 'TRANSCRIPT above list B'])
  const composer = new Composer()
  composer.handle({ kind: 'text', text: '/command' })
  const composerView = createComposerView(composer, '/work')
  const status = createStatusView(() => ({
    busy: false,
    tick: 0,
    elapsedMs: undefined,
    model: 'deepseek-v4-flash',
    effort: undefined,
    usage: undefined,
    tokens: undefined,
    contextWindow: undefined,
    detail: 'compact',
    work: undefined,
    todo: undefined,
    plan: false,
    goal: undefined,
  }))
  const completion = createCompletion(composer, {
    commands: () => COMMANDS,
    commandArguments: async () => [],
    paths: async () => [],
  }, () => {})
  await completion.refresh()
  const draw = (): void => {
    screen.setLive([
      ...composerView.render(COLUMNS, rows),
      ...completion.view.render(COLUMNS, rows),
      ...status.render(COLUMNS, rows),
    ])
  }
  return { emulator, completion, draw }
}

describe('the suggestion list on a real terminal', () => {
  it.each([24, 14, 10, 8])('keeps the composer on screen in a %i-row terminal', async rows => {
    const { emulator, completion, draw } = await terminal(rows)
    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    // The prompt the list is completing must never be the thing scrolled away:
    // it is where the keystrokes are going.
    expect((await emulator.screen()).join('\n')).toContain('/command')

    // Walk the whole list, twice over the wrap-around.
    for (let press = 0; press < 32; press += 1) {
      completion.handleKey({ kind: 'key', name: 'down' })
      draw()
    }
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT above list A'))).toHaveLength(1)
    expect(history.filter(line => line.includes('TRANSCRIPT above list B'))).toHaveLength(1)
    // The composer's frame appears once, wherever the live region currently sits.
    // A list taller than the screen scrolls that top border out of reach, and the
    // next redraw climbs too few rows and writes a SECOND copy below the first —
    // which is what a reader on a short terminal actually sees go wrong.
    expect(history.filter(line => line.includes('\u256d\u2500 work'))).toHaveLength(1)
  })

  it('empties its count as the highlight reaches the end', async () => {
    const { emulator, completion, draw } = await terminal(24)
    draw()
    expect((await emulator.screen()).join('\n')).toContain('9 more')
    for (let press = 0; press < 14; press += 1) completion.handleKey({ kind: 'key', name: 'down' })
    draw()
    const screen = (await emulator.screen()).join('\n')
    expect(screen).toContain('command-last-sentinel')
    expect(screen).toContain('15/15')
    expect(screen).not.toContain('more')
  })
})

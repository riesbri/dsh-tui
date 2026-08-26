/**
 * A four-hundred-model picker on a real terminal.
 *
 * Read as plain text a too-tall frame looks fine, which is exactly why this is
 * an emulator test: the failure is that `Screen` climbs rows to erase the live
 * region, and rows that have scrolled off cannot be reached. So the assertions
 * are about what the terminal HOLDS — the transcript above the picker, still
 * there, still written once — rather than about the lines the overlay returned.
 */

import { describe, expect, it } from 'vitest'
import { Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import type { SelectChoice } from '../src/select.ts'
import { createSelectOverlay } from '../src/select.ts'

/** The width used by the real-terminal regression frames. */
const COLUMNS = 80

/** More models than any terminal under test can show, as a gateway route offers. */
const CHOICES: SelectChoice[] = Array.from({ length: 400 }, (_unused, index) => ({
  value: String(index),
  label: index === 0
    ? 'openrouter/FIRST-SENTINEL'
    : index === 399 ? 'openrouter/LAST-SENTINEL' : `openrouter/model-${String(index)}`,
}))

/**
 * Mount the picker over a real terminal emulator.
 * @param rows - the emulator's height.
 * @returns the emulator, the overlay, the screen, and a repaint.
 */
function terminal(rows: number): {
  emulator: ReturnType<typeof createEmulator>
  overlay: ReturnType<typeof createSelectOverlay>
  screen: Screen
  draw: () => void
} {
  const emulator = createEmulator(COLUMNS, rows)
  const screen = new Screen(emulator.target)
  screen.commit(['TRANSCRIPT above picker A', 'TRANSCRIPT above picker B'])
  let overlay!: ReturnType<typeof createSelectOverlay>
  const draw = (): void => { screen.setLive(overlay.render(COLUMNS, rows)) }
  overlay = createSelectOverlay({
    title: 'Select a model',
    detail: 'current: deepseek-official/deepseek-v4-flash',
    choices: CHOICES,
    settle: () => {},
    invalidate: draw,
  })
  return { emulator, overlay, screen, draw }
}

describe('the shared picker on a real terminal', () => {
  it('keeps the semantic title in the body at the smallest framed height', () => {
    const overlay = createSelectOverlay({
      title: 'May the agent run this exact command?',
      view: 'Approval',
      choices: [{ value: 'yes', label: 'Allow' }],
      settle: () => {},
      invalidate: () => {},
    })
    const framed = overlay.render(COLUMNS, 6)
    expect(framed).toHaveLength(6)
    expect(framed[1]).toContain('Approval')
    expect(framed.join('\n')).toContain('May the agent run this exact command?')
    expect(overlay.render(COLUMNS, 5).join('\n')).not.toContain('╭')
  })

  it.each([24, 14])('keeps four hundred choices inside a %i-row terminal', async rows => {
    const { emulator, overlay, draw } = terminal(rows)
    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)

    // Walk past the end of a list far longer than the window, twice over.
    for (let press = 0; press < 450; press += 1) {
      overlay.handleKey({ kind: 'key', name: 'down' })
      draw()
    }
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    // The transcript committed before the picker opened is still exactly where
    // it was, and written once. An unbounded picker duplicated it here.
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT above picker A'))).toHaveLength(1)
    expect(history.filter(line => line.includes('TRANSCRIPT above picker B'))).toHaveLength(1)
  })

  it('leaves nothing behind when it is answered', async () => {
    const { emulator, screen, draw } = terminal(24)
    draw()
    expect((await emulator.screen()).join('\n')).toContain('Select a model')
    screen.setLive([])
    expect((await emulator.screen()).join('\n')).not.toContain('openrouter/model-')
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT above picker A'))).toHaveLength(1)
  })

  it('reaches the end of the list by typing rather than by scrolling', async () => {
    const { emulator, overlay, draw } = terminal(14)
    draw()
    for (const character of 'LAST-SENTINEL') {
      overlay.handleKey({ kind: 'text', text: character })
      draw()
    }
    const screen = (await emulator.screen()).join('\n')
    expect(screen).toContain('openrouter/LAST-SENTINEL')
    expect(screen).toContain('1 of 400')
    expect((await emulator.screen()).length).toBeLessThanOrEqual(14)
  })

  it('shows an escape sequence in a choice label instead of obeying it', async () => {
    // A label can carry a provider's own model name, which is untrusted text.
    const emulator = createEmulator(COLUMNS, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT above picker A'])
    const overlay = createSelectOverlay({
      title: 'Select a model',
      choices: [{ value: '0', label: 'openrouter/evil\u001b[2Jmodel' }],
      settle: () => {},
      invalidate: () => {},
    })
    screen.setLive(overlay.render(COLUMNS, 24))
    const history = (await emulator.scrollback()).join('\n')
    expect(history).toContain('^[[2J')
    expect(history).toContain('TRANSCRIPT above picker A')
  })
})

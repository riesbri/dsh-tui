/**
 * The expanded tool-result inspector: a scrollable live overlay that reports a
 * bounded window and disappears on Esc without touching native scrollback.
 */

import { describe, expect, it } from 'vitest'
import { Screen, stripAnsi } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { createToolOutputOverlay } from '../src/tool-output.ts'

/** Remove styling so assertions name exactly the text a person sees. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

describe('the tool-output inspector', () => {
  const rows = Array.from({ length: 20 }, (_, i) => `inspected row ${String(i)}`)

  it('renders a bounded window with a counter and help', () => {
    const overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: () => ({ rows, sourceRows: 20 }),
      close: () => {},
      invalidate: () => {},
    })
    const frame = plain(overlay.render(80, 24))
    expect(frame.join('\n')).toContain('Tool output')
    expect(frame.join('\n')).toContain('rows 1–18 of 20')
    expect(frame.join('\n')).toContain('inspected row 0')
    expect(frame.join('\n')).not.toContain('inspected row 19')
    expect(frame.every(row => row.length <= 80)).toBe(true)
    expect(frame.at(-1)).toContain('↑↓ scroll · home/end jump · esc close')
  })

  it('scrolls with up/down and jumps with home/end', () => {
    let invalidations = 0
    const overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: () => ({ rows, sourceRows: 20 }),
      close: () => {},
      invalidate: () => { invalidations += 1 },
    })
    // A 10-row terminal leaves 4 body rows, so the window scrolls over 16 rows.
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 1–4 of 20')
    for (let index = 0; index < 16; index += 1) overlay.handleKey({ kind: 'key', name: 'down' })
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 17–20 of 20')
    expect(invalidations).toBeGreaterThanOrEqual(16)

    overlay.handleKey({ kind: 'key', name: 'home' })
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 1–4 of 20')
    const bottom = plain(overlay.render(80, 10)).join('\n')
    overlay.handleKey({ kind: 'key', name: 'end' })
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 17–20 of 20')
    expect(bottom).toContain('rows 1–4 of 20')
  })

  it('says the source itself was cut with a + when the cap hid more', () => {
    const overlay = createToolOutputOverlay({
      title: 'Tool output',
      // 100 rows fit, but the source had 500 — the counter must not read complete.
      render: () => ({ rows, sourceRows: 500 }),
      close: () => {},
      invalidate: () => {},
    })
    const frame = plain(overlay.render(80, 24))
    expect(frame.join('\n')).toContain('rows 1–18 of 500+')
  })

  it('closes once on Esc, repainting through invalidate for the other keys', () => {
    let closes = 0
    const overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: () => ({ rows, sourceRows: 20 }),
      close: () => { closes += 1 },
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    overlay.handleKey({ kind: 'key', name: 'ctrl-c' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closes).toBe(1)
  })

  it('leaves committed scrollback untouched and disappears cleanly on close', async () => {
    const emulator = createEmulator(80, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT committed line A', 'TRANSCRIPT committed line B'])
    let overlay!: ReturnType<typeof createToolOutputOverlay>
    const draw = (): void => { screen.setLive(overlay.render(80, 24)) }
    overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: () => ({ rows, sourceRows: 20 }),
      close: () => { screen.setLive([]) },
      invalidate: draw,
    })
    draw()
    expect((await emulator.screen()).join('\n')).toContain('Tool output')
    overlay.handleKey({ kind: 'key', name: 'down' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    const all = await emulator.scrollback()
    // The committed transcript is intact, and the inspector never entered it.
    expect(all.filter(line => line.includes('TRANSCRIPT committed line A'))).toHaveLength(1)
    expect(all.filter(line => line.includes('TRANSCRIPT committed line B'))).toHaveLength(1)
    expect(all.filter(line => line.includes('Tool output'))).toHaveLength(0)
    emulator.dispose()
  })
})

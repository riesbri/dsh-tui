/**
 * The expanded tool-result inspector: a scrollable live overlay that reports a
 * bounded window, never exceeds the terminal, and dismisses without touching
 * native scrollback.
 */

import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Screen, stripAnsi } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { ToolCards } from '../src/cards.ts'
import type { ToolOutputSpec } from '../src/tool-output.ts'
import { createToolOutputOverlay } from '../src/tool-output.ts'

/** Remove styling so assertions name exactly the text a person sees. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

const rows = Array.from({ length: 20 }, (_, i) => `inspected row ${String(i)}`)

/** An overlay over synthetic rows with a fixed truncation flag. */
function makeOverlay(truncated = false, source: string[] = rows): {
  overlay: ReturnType<typeof createToolOutputOverlay>
  spec: ToolOutputSpec
  invalidate: () => number
} {
  let invalidated = 0
  const spec: ToolOutputSpec = {
    title: 'Tool output',
    render: () => ({ rows: source, truncated }),
    close: () => {},
    invalidate: () => { invalidated += 1 },
  }
  return { overlay: createToolOutputOverlay(spec), spec, invalidate: () => invalidated }
}

describe('the tool-output inspector', () => {
  it('renders a bounded window whose counter names the scrollable rows', () => {
    const { overlay } = makeOverlay()
    const frame = plain(overlay.render(80, 24))
    expect(frame.join('\n')).toContain('Tool output')
    // Terminal 24 rows, 7 fixed chrome rows -> 17 body rows; 20 rows are shown,
    // so the counter is in exactly the coordinate system the viewport scrolls.
    expect(frame.join('\n')).toContain('rows 1–17 of 20')
    expect(frame.join('\n')).toContain('inspected row 0')
    expect(frame.join('\n')).not.toContain('inspected row 19')
    expect(frame.every(row => row.length <= 80)).toBe(true)
    expect(frame.at(-1)).toContain('↑↓ scroll · home/end jump · esc close')
  })

  it('scrolls with up/down and jumps with home/end', () => {
    const { overlay, invalidate } = makeOverlay()
    // A 10-row terminal leaves 3 body rows, so the window slides over 17 rows.
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 1–3 of 20')
    for (let index = 0; index < 17; index += 1) overlay.handleKey({ kind: 'key', name: 'down' })
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 18–20 of 20')
    expect(invalidate()).toBeGreaterThanOrEqual(17)

    overlay.handleKey({ kind: 'key', name: 'home' })
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 1–3 of 20')
    overlay.handleKey({ kind: 'key', name: 'end' })
    expect(plain(overlay.render(80, 10)).join('\n')).toContain('rows 18–20 of 20')
  })

  it('adds a + to the denominator only when the hard cap hid source', () => {
    const { overlay } = makeOverlay(true)
    expect(plain(overlay.render(80, 24)).join('\n')).toContain('rows 1–17 of 20+')
    // End stays within the numerator: it never reads past "20+"'s 20 shown rows.
    overlay.handleKey({ kind: 'key', name: 'end' })
    expect(plain(overlay.render(80, 24)).join('\n')).toMatch(/rows 4–20 of 20\+/u)
  })

  it('never renders more rows than the terminal, at any height', () => {
    const { overlay } = makeOverlay()
    for (const terminalRows of [24, 10, 7, 6, 3, 1]) {
      const frame = overlay.render(80, terminalRows)
      expect(frame.length, `${String(terminalRows)} rows`).toBeLessThanOrEqual(terminalRows)
    }
  })

  it('keeps a very short terminal readable and closable', () => {
    const { overlay } = makeOverlay()
    for (const terminalRows of [3, 2, 1]) {
      const frame = plain(overlay.render(80, terminalRows))
      expect(frame.length, `${String(terminalRows)} rows`).toBeLessThanOrEqual(terminalRows)
      expect(frame.join('\n')).toContain('esc close')
    }
    // Esc still dismisses a terminal that only shows the fallback.
    let closed = 0
    const short = createToolOutputOverlay({ ...overlaySpec(rows), close: () => { closed += 1 } })
    short.render(80, 1)
    short.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(1)
  })

  it('closes once on Esc, repainting through invalidate for the other keys', () => {
    let closes = 0
    const spec: ToolOutputSpec = {
      title: 'Tool output',
      render: () => ({ rows, truncated: false }),
      close: () => { closes += 1 },
      invalidate: () => {},
    }
    const overlay = createToolOutputOverlay(spec)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    overlay.handleKey({ kind: 'key', name: 'ctrl-c' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closes).toBe(1)
  })

  it('counts the real semantic card rows as its scrollable space', () => {
    const terminal = renderTerminal(30)
    const item = terminal.item
    const expanded = terminal.cards.renderInspect(item, 90)
    const overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: columns => terminal.cards.renderInspect(item, columns),
      close: () => {},
      invalidate: () => {},
    })
    // The terminal frame (two borders + 30 output rows) is what the viewport
    // scrolls, and the counter shares that coordinate system exactly.
    const frame = plain(overlay.render(90, 24))
    expect(expanded.rows).toHaveLength(32)
    expect(frame.join('\n')).toContain(`rows 1–17 of ${String(expanded.rows.length)}`)
    // End lands on exactly the last presented row, never past the denominator.
    overlay.handleKey({ kind: 'key', name: 'end' })
    expect(plain(overlay.render(90, 24)).join('\n')).toContain(`rows 16–32 of ${String(expanded.rows.length)}`)
  })

  it('adds the + marker for a real capped terminal presentation', () => {
    const terminal = renderTerminal(5000)
    const item = terminal.item
    const overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: columns => terminal.cards.renderInspect(item, columns),
      close: () => {},
      invalidate: () => {},
    })
    const frame = plain(overlay.render(90, 24))
    // 200 capped rows, the elision marker, and the two box borders are the 203
    // scrollable rows; the + tells the reader more source material was cut.
    expect(frame.join('\n')).toContain('rows 1–17 of 203+')
  })

  it('keeps a full-height inspector nested at the outer width from overflowing', async () => {
    // A real terminal card whose output lines are long enough to fill the card
    // frame. When such a card is laid out at the whole terminal width and then
    // nested inside the overlay frame, each card row exceeds the frame's inner
    // width and wraps into two physical rows, so the live region overflows. The
    // card must instead be rendered at the frame's inner width.
    const terminal = longTerminal()
    const item = terminal.item
    const emulator = createEmulator(80, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT committed before inspector'])
    let overlay!: ReturnType<typeof createToolOutputOverlay>
    const draw = (): void => { screen.setLive(overlay.render(80, 24)) }
    overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: cols => terminal.cards.renderInspect(item, cols),
      close: () => { screen.setLive([]) },
      invalidate: draw,
    })
    draw()
    // One inspector viewport row is one physical row: the frame fills the 24-row
    // terminal and its help line is the last visible row, not pushed off-screen.
    const open = await emulator.screen()
    expect(open.length).toBeLessThanOrEqual(24)
    expect(open.at(-1)?.includes('↑↓ scroll')).toBe(true)

    // Scroll to the end and dismiss.
    for (let index = 0; index < 5; index += 1) overlay.handleKey({ kind: 'key', name: 'end' })
    overlay.handleKey({ kind: 'key', name: 'escape' })

    const all = await emulator.scrollback()
    // The committed transcript is intact, and no card or inspector row leaked
    // into native scrollback — an overflowing nested frame would leave the
    // scrolled-off rows behind here.
    expect(all.filter(line => line.includes('TRANSCRIPT committed before inspector'))).toHaveLength(1)
    expect(all.filter(line => line.includes('card line'))).toHaveLength(0)
    expect(all.filter(line => line.includes('Tool output'))).toHaveLength(0)
    emulator.dispose()
  })

  it('leaves committed scrollback untouched and disappears cleanly on close', async () => {
    const emulator = createEmulator(80, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT committed line A', 'TRANSCRIPT committed line B'])
    // Plenty of body rows so a full-height frame is genuinely filled.
    const many = Array.from({ length: 200 }, (_, i) => `inspected row ${String(i)}`)
    let overlay!: ReturnType<typeof createToolOutputOverlay>
    const draw = (): void => { screen.setLive(overlay.render(80, 24)) }
    overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: () => ({ rows: many, truncated: false }),
      close: () => { screen.setLive([]) },
      invalidate: draw,
    })
    draw()
    const visible = await emulator.screen()
    expect(visible.length).toBeLessThanOrEqual(24)
    expect(visible.join('\n')).toContain('Tool output')

    overlay.handleKey({ kind: 'key', name: 'down' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    const all = await emulator.scrollback()
    // The committed transcript is intact, and the inspector never entered it:
    // after dismissal nothing of the overlay remains, which is exactly what a
    // full-height live region that stayed inside the terminal looks like. An
    // overflowing frame would leave its scrolled-off bottom rows behind here.
    expect(all.filter(line => line.includes('TRANSCRIPT committed line A'))).toHaveLength(1)
    expect(all.filter(line => line.includes('TRANSCRIPT committed line B'))).toHaveLength(1)
    expect(all.filter(line => line.includes('Tool output'))).toHaveLength(0)
    expect(all.filter(line => line.includes('inspected row'))).toHaveLength(0)
    expect(all.filter(line => line.includes('\u2191\u2193 scroll'))).toHaveLength(0)
    emulator.dispose()
  })
})

/** A module-level spec builder, reused by the short-terminal test. */
function overlaySpec(source: string[]): ToolOutputSpec {
  return {
    title: 'Tool output',
    render: () => ({ rows: source, truncated: false }),
    close: () => {},
    invalidate: () => {},
  }
}

/** Draw one truncated terminal result and take its inspectable item. */
function renderTerminal(lines: number): { cards: ToolCards; item: ReturnType<ToolCards['takeInspectable']> } {
  const cards = new ToolCards(() => ({
    presentResult: () => ({ card: 'terminal', output: `${'line\n'.repeat(lines)}`, exitCode: 0 }),
  } as unknown as ToolDefinition), '/w')
  cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 90)
  cards.result({ callId: 'c1', content: [{ type: 'text', text: '' }], isError: false }, 90)
  return { cards, item: cards.takeInspectable() }
}

/** A terminal card whose long output lines fill the card frame. */
function longTerminal(): { cards: ToolCards; item: ReturnType<ToolCards['takeInspectable']> } {
  const cards = new ToolCards(() => ({
    presentResult: () => ({
      card: 'terminal',
      output: Array.from({ length: 200 }, (_, i) => `card line ${String(i)} ${'x'.repeat(60)}`).join('\n'),
      exitCode: 0,
    }),
  } as unknown as ToolDefinition), '/w')
  cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 80)
  cards.result({ callId: 'c1', content: [{ type: 'text', text: '' }], isError: false }, 80)
  return { cards, item: cards.takeInspectable() }
}

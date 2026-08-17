import { describe, expect, it } from 'vitest'
import { Composer, displayWidth, Screen, stripAnsi } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { createComposerView } from '../src/views.ts'

/** A terminal width whose inner content area is a round number of columns. */
const COLUMNS = 40

/** Content rows plus two borders: the ceiling the composer draws within. */
const COMPOSER_FRAME_ROWS = 12

/** Every glyph the frame is drawn from, none of which may sit under the cursor. */
const BORDER_GLYPHS = ['\u256d', '\u256e', '\u2570', '\u256f', '\u2502', '\u2500']

/**
 * A composer holding `text`, with the cursor left where typing it would leave it.
 * @param text - the content to type, newlines included.
 * @returns the composer.
 */
function typed(text: string): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text })
  return composer
}

/**
 * Where the terminal actually puts its cursor after drawing the composer.
 *
 * Asserted through an emulator rather than against the returned LiveCursor,
 * because the placement is only correct if it agrees with the rows that were
 * drawn — and those are two separate calculations that can disagree.
 * @param composer - the composer to draw.
 * @param columns - the terminal width.
 * @returns the cursor position and the visible rows.
 */
async function drawn(composer: Composer, columns = COLUMNS): Promise<{
  cursor: { column: number; row: number }
  rows: string[]
}> {
  const emulator = createEmulator(columns, 24)
  const screen = new Screen(emulator.target)
  const view = createComposerView(composer, '/w/repo')
  const lines = view.render(columns)
  screen.setLive(lines, view.cursor?.(columns))
  // Rows are NOT filtered: an index into this array is a terminal row, which is
  // what the cursor's row is measured in.
  return { cursor: await emulator.cursor(), rows: (await emulator.screen()).map(row => row.trimEnd()) }
}

/**
 * The character the terminal would overwrite if the next keystroke were typed.
 * @param composer - the composer being drawn.
 * @param at - where the terminal put its cursor.
 * @param columns - the terminal width to draw at.
 * @returns the cell's character, or a space for an empty cell.
 */
async function cellUnder(
  composer: Composer,
  at: { column: number; row: number },
  columns = COLUMNS,
): Promise<string> {
  const emulator = createEmulator(columns, 24)
  const screen = new Screen(emulator.target)
  const view = createComposerView(composer, '/w/repo')
  screen.setLive(view.render(columns), view.cursor?.(columns))
  const cell = await emulator.cell(at.column, at.row)
  return cell?.chars === '' ? ' ' : cell?.chars ?? ' '
}

describe('the composer view', () => {
  it('puts the cursor after the text that was typed', async () => {
    const { cursor, rows } = await drawn(typed('hello'))
    const row = rows.find(line => line.includes('hello')) ?? ''
    expect(row.indexOf('hello') + 'hello'.length).toBe(cursor.column)
  })

  it('places the cursor correctly on a line that spans several rows', async () => {
    const composer = typed('aaaa bbbb cccc dddd eeee ffff gggg hhhh')
    const { cursor, rows } = await drawn(composer)
    const lastRow = rows.filter(row => row.includes('hhhh')).at(-1) ?? ''
    expect(lastRow.indexOf('hhhh') + 'hhhh'.length).toBe(cursor.column)
  })

  it('agrees with the drawn rows when a word would move under word wrapping', async () => {
    // The case a prefix-based calculation gets wrong under word wrapping: appending
    // to a word pulls the WHOLE word onto the next row, moving a break that is
    // before the cursor, so a prefix laid out alone disagrees with the same prefix
    // inside the finished line. Chunking is prefix-consistent, which is why the
    // composer chunks.
    //
    // Only visible at a width where the line actually spans rows, which is why the
    // narrow columns are the point of this case.
    for (const columns of [16, 20, 24]) {
      for (const text of ['aaaa bbbbbbbbb', 'aa bbbbbbbbbb', 'a bbbbbbbbbbbb', 'aa bb cc dddddddddddd']) {
        for (const back of [0, 1, 3]) {
          const composer = typed(text)
          for (let index = 0; index < back; index += 1) composer.handle({ kind: 'key', name: 'left' })
          const { cursor } = await drawn(composer, columns)
          // The cell under the cursor is the character the next keystroke overwrites,
          // which is the one at the cursor's offset in the buffer.
          const cell = await cellUnder(composer, cursor, columns)
          const label = `${String(columns)} columns, ${JSON.stringify(text)}, back ${String(back)}`
          expect(cell, label).toBe(text[text.length - back] ?? ' ')
        }
      }
    }
  })

  it('places the cursor on the second row of a two-line buffer', async () => {
    const composer = typed('first\nsecond')
    const { cursor, rows } = await drawn(composer)
    const row = rows.findIndex(line => line.includes('second'))
    expect(cursor.row).toBe(row)
    expect((rows[row] ?? '').indexOf('second') + 'second'.length).toBe(cursor.column)
  })

  it('keeps the cursor inside the frame, never on its border', async () => {
    // A prefix that exactly fills its row leaves the cursor one column past the
    // last content cell, which is exactly where the right-hand border is drawn. The
    // inner width at 40 columns is 36 and the prompt takes 2, so 34 characters is
    // the exact fill and the sweep straddles it.
    //
    // Asserted on the CELL under the cursor rather than on its column, because the
    // screen does not clamp a column and a number can look plausible while landing
    // on the frame.
    for (const length of [32, 33, 34, 35, 36, 68, 69, 70, 71, 72]) {
      const composer = typed('x'.repeat(length))
      const emulator = createEmulator(COLUMNS, 24)
      const screen = new Screen(emulator.target)
      const view = createComposerView(composer, '/w/repo')
      screen.setLive(view.render(COLUMNS), view.cursor?.(COLUMNS))
      const at = await emulator.cursor()
      const rows = (await emulator.screen()).map(row => row.trimEnd())
      const frame = displayWidth(rows[1] ?? '')
      // Content occupies the columns between the border and its padding, so the
      // cursor belongs in [2, frame - 3]. Anything outside is on the padding or the
      // border, which is what a missing roll-over produces.
      expect(at.column, `${String(length)} characters`).toBeGreaterThanOrEqual(2)
      expect(at.column, `${String(length)} characters`).toBeLessThanOrEqual(frame - 3)
      // Not on ANY part of the frame: a cursor clamped onto the bottom border sits
      // on a horizontal rule rather than a vertical one, so checking one glyph is
      // not enough.
      const cell = await emulator.cell(at.column, at.row)
      expect(BORDER_GLYPHS, `${String(length)} characters on ${JSON.stringify(cell?.chars)}`)
        .not.toContain(cell?.chars ?? '')
    }
  })
})

describe('a composer taller than the terminal', () => {
  it('draws no more rows than it can redraw', async () => {
    // The live region is redrawn by climbing rows, so rows that scrolled off cannot
    // be reached or erased: an uncapped composer left duplicate rows in scrollback
    // and could clear unrelated output. Pasting twenty short lines is enough.
    const composer = typed(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'))
    const { rows } = await drawn(composer)
    expect(rows.filter(row => row !== '')).toHaveLength(COMPOSER_FRAME_ROWS)
  })

  it('scrolls to keep the cursor visible, and says how much is hidden', async () => {
    const composer = typed(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'))
    const { cursor, rows } = await drawn(composer)
    // The cursor is at the end, so the end is what is shown.
    expect(rows.join('\n')).toContain('line 39')
    expect(rows.join('\n')).not.toContain('line 0 ')
    expect(rows[1]).toContain('rows')
    expect(cursor.row).toBeGreaterThan(0)
    expect(cursor.row).toBeLessThan(rows.length)
  })

  it('reports the cursor relative to the visible window', async () => {
    const composer = typed(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'))
    const { cursor, rows } = await drawn(composer)
    const onCursorRow = stripAnsi(rows[cursor.row] ?? '')
    expect(onCursorRow).toContain('line 39')
  })

  it('shows the whole buffer while it still fits', async () => {
    const composer = typed('one\ntwo\nthree')
    const { rows } = await drawn(composer)
    expect(rows.join('\n')).toContain('one')
    expect(rows.join('\n')).toContain('three')
    expect(rows[1]).not.toContain('rows')
  })
})

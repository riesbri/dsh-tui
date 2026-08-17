import { describe, expect, it } from 'vitest'
import { box, Composer, displayWidth, escapeControls, renderMarkdown, Screen, style } from '../src/index.ts'
import { createEmulator } from './emulator.ts'

/**
 * These assert what a terminal shows, not what the renderer wrote. The unit tests
 * beside them cover the arithmetic; this file is the only place that can catch a
 * frame that computes correctly and still looks wrong.
 */
describe('rendered output', () => {
  it('draws a live region and nothing more', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['first', 'second'])
    expect(await emulator.screen()).toEqual(['first', 'second'])
    emulator.dispose()
  })

  it('replaces a taller region without leaving its tail behind', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['one', 'two', 'three'])
    screen.setLive(['only'])
    // A short redraw over a tall region must erase the rows it no longer uses;
    // leftover rows are the classic symptom of miscounted cursor movement.
    expect(await emulator.screen()).toEqual(['only'])
    emulator.dispose()
  })

  it('keeps committed output above the live region, in order', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['composer'])
    screen.commit(['first committed'])
    screen.commit(['second committed'])
    expect(await emulator.screen()).toEqual(['first committed', 'second committed', 'composer'])
    emulator.dispose()
  })

  it('redraws the region correctly after a commit', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['a', 'b'])
    screen.commit(['committed'])
    screen.setLive(['replaced'])
    expect(await emulator.screen()).toEqual(['committed', 'replaced'])
    emulator.dispose()
  })

  it('leaves committed scrollback in place when it closes', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(['a transcript line'])
    screen.setLive(['composer'])
    screen.close()
    expect(await emulator.screen()).toEqual(['a transcript line'])
    emulator.dispose()
  })

  it('draws a styled box with its borders in one column', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    screen.setLive(box(['hello'], { width: 24, border: text => style(text, 'gray') }))
    const rows = await emulator.screen()
    // Every rendered row ends at the same column, which is what a misjudged
    // escape-sequence width breaks first.
    expect(rows.map(row => displayWidth(row))).toEqual([24, 24, 24])
    expect(rows[1]).toBe('│ hello                │')
    emulator.dispose()
  })

  it('keeps a CJK box aligned', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    screen.setLive(box(['标准模式'], { width: 24 }))
    const rows = await emulator.screen()
    // Measured in COLUMNS, not string length: the emulator stores a wide
    // character as two cells and `translateToString` skips the second, so four
    // ideographs come back as four characters occupying eight columns.
    expect(rows.map(row => displayWidth(row))).toEqual([24, 24, 24])
    expect(rows[1]).toBe('│ 标准模式             │')
    emulator.dispose()
  })

  it('wraps a long line to real rows rather than overflowing', async () => {
    const emulator = createEmulator(12)
    const screen = new Screen(emulator.target)
    screen.setLive(['aaaa bbbb cccc dddd'])
    expect(await emulator.screen()).toEqual(['aaaa bbbb', 'cccc dddd'])
    emulator.dispose()
  })

  it('does not wrap a styled line early', async () => {
    const emulator = createEmulator(20)
    const screen = new Screen(emulator.target)
    // Twenty visible columns of styled text fit exactly one row; counting the
    // escape bytes as columns would split it.
    screen.setLive([style('12345678901234567890', 'red')])
    expect(await emulator.screen()).toEqual(['12345678901234567890'])
    emulator.dispose()
  })

  it('keeps styling on a wrapped continuation row', async () => {
    const emulator = createEmulator(6)
    const screen = new Screen(emulator.target)
    screen.setLive([style('aaaa bbbb', 'red')])
    expect(await emulator.screen()).toEqual(['aaaa', 'bbbb'])
    // Read from cell attributes, not text: translateToString carries no styling,
    // so a continuation row that lost its colour would look identical.
    expect(await emulator.cell(0, 0)).toEqual({ chars: 'a', fg: 1, bold: false })
    expect(await emulator.cell(0, 1)).toEqual({ chars: 'b', fg: 1, bold: false })
    emulator.dispose()
  })

  it('leaves an unstyled row with no colour of its own', async () => {
    const emulator = createEmulator(10)
    const screen = new Screen(emulator.target)
    screen.setLive(['plain'])
    // The companion to the assertion above: without this, a helper that reported
    // red for every cell would satisfy both.
    expect(await emulator.cell(0, 0)).toEqual({ chars: 'p', fg: undefined, bold: false })
    emulator.dispose()
  })

  it('places the terminal cursor over CJK by columns, not characters', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    const composer = new Composer()
    composer.set('标准模式')
    composer.handle({ kind: 'key', name: 'left' })
    // Three ideographs precede the cursor, so six columns, plus a two-column
    // prompt: the terminal cursor must land at column 8, not at 5 characters.
    expect(composer.cursorColumn).toBe(6)
    screen.setLive([`› ${composer.value}`], { row: 0, column: 2 + composer.cursorColumn })
    expect(await emulator.screen()).toEqual(['› 标准模式'])
    expect(await emulator.cursor()).toEqual({ column: 8, row: 0 })
    emulator.dispose()
  })

  it('places the cursor on the row the caller asked for', async () => {
    const emulator = createEmulator(20)
    const screen = new Screen(emulator.target)
    screen.setLive(['first', 'second', 'third'], { row: 1, column: 3 })
    expect(await emulator.cursor()).toEqual({ column: 3, row: 1 })
    emulator.dispose()
  })

  it('leaves the cursor clear of the region when none is requested', async () => {
    const emulator = createEmulator(20)
    const screen = new Screen(emulator.target)
    screen.setLive(['one', 'two'])
    // No placement means the cursor ends where drawing stopped, on the last row.
    expect(await emulator.cursor()).toEqual({ column: 3, row: 1 })
    emulator.dispose()
  })

  it('draws a pasted block as its own lines, aligned under the prompt', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'first\nsecond' })
    const lines = composer.lines.map((line, index) => `${index === 0 ? '\u203a ' : '  '}${line}`)
    screen.setLive(box(lines, { width: 24 }))
    expect(await emulator.screen()).toEqual([
      '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e',
      '\u2502 \u203a first              \u2502',
      '\u2502   second             \u2502',
      '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f',
    ])
    emulator.dispose()
  })

  it('shows an escape sequence from tool output instead of obeying it', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(['before'])
    // A REAL clear-screen sequence, run through the production sanitizer, so the
    // test fails if that sanitizing is ever removed. Writing the caret form
    // directly would assert nothing.
    const hostile = '\u001b[2J after'
    screen.setLive([escapeControls(hostile)])
    const rows = await emulator.screen()
    expect(rows[0]).toBe('before')
    expect(rows[1]).toBe('^[[2J after')
    emulator.dispose()
  })

  it('would lose earlier rows if that sanitizing were skipped', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(['before'])
    // The counter-case that gives the assertion above its meaning: the same bytes
    // unsanitized do reach the terminal and do clear it.
    screen.setLive(['\u001b[2J after'])
    expect(await emulator.screen()).not.toContain('before')
    emulator.dispose()
  })

  it('renders a multi-line markdown reply with styling that survives the terminal', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    const reply = ['# Setup', '', 'Run **build** then `test`.', '', '- first', '- second'].join('\n')
    screen.commit(renderMarkdown(reply))
    expect(await emulator.screen()).toEqual([
      'Setup',
      '',
      'Run build then test.',
      '',
      '• first',
      '• second',
    ])
    // Structure alone would pass with every attribute lost, so the heading's
    // weight and the bullet glyph's colour are read from the cells.
    expect(await emulator.cell(0, 0)).toEqual({ chars: 'S', fg: 6, bold: true })
    expect((await emulator.cell(4, 2))?.bold).toBe(true)
    expect((await emulator.cell(0, 4))?.fg).toBe(8)
    // And prose between them carries no styling of its own.
    expect(await emulator.cell(0, 2)).toEqual({ chars: 'R', fg: undefined, bold: false })
    emulator.dispose()
  })

  it('keeps an identifier in a reply intact through the terminal', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(renderMarkdown('Edit snake_case_name in file_name.ts'))
    // The end-to-end form of the flanking rule: what the user can read and copy.
    expect(await emulator.screen()).toEqual(['Edit snake_case_name in file_name.ts'])
    emulator.dispose()
  })

  it('renders a full frame of chrome the way a person reads it', async () => {
    const emulator = createEmulator(34)
    const screen = new Screen(emulator.target)
    screen.commit(['› a question', '', '● an answer'])
    screen.setLive([
      '',
      ...box(['› ask anything'], { width: 32 }),
      '  ● ready',
    ])
    expect(await emulator.screen()).toEqual([
      '› a question',
      '',
      '● an answer',
      '',
      '╭──────────────────────────────╮',
      '│ › ask anything               │',
      '╰──────────────────────────────╯',
      '  ● ready',
    ])
    emulator.dispose()
  })
})

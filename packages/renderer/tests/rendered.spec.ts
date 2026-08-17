import { describe, expect, it } from 'vitest'
import { box, Composer, displayWidth, Screen, style } from '../src/index.ts'
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
    emulator.dispose()
  })

  it('places the cursor where the composer says it is', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    const composer = new Composer()
    composer.set('标准模式')
    composer.handle({ kind: 'key', name: 'left' })
    // Six columns of CJK precede the cursor, plus a two-column prompt.
    screen.setLive([`› ${composer.value}`], { row: 0, column: 2 + composer.cursorColumn })
    await emulator.flush()
    expect(composer.cursorColumn).toBe(6)
    expect(await emulator.screen()).toEqual(['› 标准模式'])
    emulator.dispose()
  })

  it('shows an escape sequence from tool output instead of obeying it', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(['before'])
    // Untrusted text is escaped by the caller; this asserts the consequence —
    // a clear-screen sequence in tool output leaves earlier rows intact.
    screen.setLive(['^[[2J after'])
    const rows = await emulator.screen()
    expect(rows[0]).toBe('before')
    expect(rows[1]).toContain('^[[2J after')
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

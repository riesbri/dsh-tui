import { describe, expect, it } from 'vitest'
import { codePointWidth, displayWidth, escapeControls, hangingIndent, stripAnsi, style, truncateToWidth, wrapToWidth } from '../src/index.ts'


describe('displayWidth()', () => {
  it('counts CJK ideographs as two columns', () => {
    // The shipped `standard` agent preset is named 标准模式; four ideographs
    // occupy eight columns, and a one-column assumption would corrupt the line.
    expect(displayWidth('标准模式')).toBe(8)
    expect(displayWidth('abcd')).toBe(4)
  })

  it('counts fullwidth punctuation and kana as two columns', () => {
    expect(displayWidth('，')).toBe(2)
    expect(displayWidth('ひらがな')).toBe(8)
    expect(displayWidth('한글')).toBe(4)
  })

  it('ignores combining marks and variation selectors', () => {
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('\u200b')).toBe(0)
  })

  it('ignores styling', () => {
    expect(displayWidth(style('标准', 'bold'))).toBe(4)
    expect(displayWidth(style('abc', 'red', 'bold'))).toBe(3)
  })
})

describe('truncateToWidth()', () => {
  it('never emits half of a two-column character', () => {
    // A three-column budget fits one ideograph and must not split the second.
    expect(truncateToWidth('标准模式', 3)).toBe('标')
    expect(truncateToWidth('标准模式', 4)).toBe('标准')
  })

  it('returns nothing for a non-positive budget', () => {
    expect(truncateToWidth('abc', 0)).toBe('')
    expect(truncateToWidth('abc', -1)).toBe('')
  })
})

describe('wrapToWidth()', () => {
  it('breaks Latin text at spaces', () => {
    expect(wrapToWidth('the quick brown fox', 10)).toEqual(['the quick', 'brown fox'])
  })

  it('breaks a space-free CJK run flush at the column budget', () => {
    expect(wrapToWidth('标准模式标准模式', 8)).toEqual(['标准模式', '标准模式'])
  })

  it('preserves blank lines so paragraph spacing survives', () => {
    expect(wrapToWidth('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })

  it('keeps deliberate leading indentation on the first row', () => {
    // Transcript lines indent to hang under a gutter mark; stripping those spaces
    // as if they were a wrap artifact flattens the whole layout.
    expect(wrapToWidth('  indented', 20)).toEqual(['  indented'])
  })

  it('does not start a continuation row with a space', () => {
    expect(wrapToWidth('aaaa bbbb', 4)).toEqual(['aaaa', 'bbbb'])
  })

  it('never returns an empty list', () => {
    expect(wrapToWidth('', 10)).toEqual([''])
  })

  it('makes progress at a one-column budget', () => {
    expect(wrapToWidth('ab', 1)).toEqual(['a', 'b'])
    // A two-column character cannot fit one column; it must still not loop.
    expect(wrapToWidth('标', 1)).toEqual(['标'])
  })
})

describe('wrapping styled text', () => {
  it('measures a styled line by its visible columns, not its escape bytes', () => {
    // A gray border is 7 bytes of escape plus its glyphs; counting those bytes as
    // columns wrapped every framed row seven columns early.
    const border = style('-'.repeat(20), 'gray')
    expect(displayWidth(border)).toBe(20)
    expect(wrapToWidth(border, 20)).toHaveLength(1)
  })

  it('never cuts inside an escape sequence', () => {
    const styled = style('abcdef', 'red')
    for (const line of wrapToWidth(styled, 3)) {
      // A fragment of a sequence would leave a stray '[31' in the visible text.
      expect(stripAnsi(line)).not.toContain('[')
    }
  })

  it('reopens styling on a continuation row so color survives a break', () => {
    const rows = wrapToWidth(style('aaaa bbbb', 'red'), 4)
    expect(rows).toHaveLength(2)
    expect(rows.map(stripAnsi)).toEqual(['aaaa', 'bbbb'])
    for (const row of rows) expect(row).toContain('[31m')
  })

  it('truncates styled text by visible columns', () => {
    expect(stripAnsi(truncateToWidth(style('abcdef', 'bold'), 3))).toBe('abc')
  })
})

describe('escapeControls()', () => {
  it('neutralizes an escape sequence hidden in untrusted output', () => {
    // Tool output carrying a clear-screen sequence must be shown, not executed.
    expect(escapeControls('before\u001b[2Jafter')).toBe('before^[[2Jafter')
  })

  it('neutralizes a carriage return, which would reposition the cursor', () => {
    expect(escapeControls('a\rb')).toBe('a^Mb')
  })

  it('keeps tab and newline, which are layout', () => {
    expect(escapeControls('a\tb\nc')).toBe('a\tb\nc')
  })

  it('spells C1 controls that have no caret notation', () => {
    expect(escapeControls('\u009b')).toBe('\\u{9b}')
  })
})

describe('stripAnsi()', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(stripAnsi('\u001b]0;title\u0007body')).toBe('body')
  })
})

describe('codePointWidth()', () => {
  it('treats controls as invisible rather than shifting a line', () => {
    expect(codePointWidth(0x1b)).toBe(0)
    expect(codePointWidth(0x7f)).toBe(0)
  })
})

describe('hangingIndent()', () => {
  it('indents every wrapped row to match the gutter', () => {
    // A marked line has no leading whitespace to preserve, so wrapping it alone
    // drops continuation rows back to column zero, which is what a reply looked
    // like: one gutter, then ragged rows beneath it.
    expect(hangingIndent('\u25cf ', '  ', 'aaa bbb ccc ddd eee', 10))
      .toEqual(['\u25cf aaa bbb', '  ccc ddd', '  eee'])
  })

  it('measures the indent in display columns, not characters', () => {
    // The mark may be a wide glyph; budgeting by character count would let a row
    // overflow by exactly the columns the glyph adds.
    const rows = hangingIndent('\u4f60 ', '   ', 'aaaa bbbb', 8)
    expect(rows.every(row => displayWidth(row) <= 8)).toBe(true)
  })

  it('returns rows that need no further wrapping', () => {
    const rows = hangingIndent('\u23fa ', '  ', 'x'.repeat(50), 20)
    expect(rows.every(row => displayWidth(row) <= 20)).toBe(true)
  })

  it('keeps styling open across a wrapped row', () => {
    const rows = hangingIndent('\u25cf ', '  ', `\u001b[31m${'red '.repeat(10)}\u001b[0m`, 14)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[1]).toContain('\u001b[31m')
  })
})

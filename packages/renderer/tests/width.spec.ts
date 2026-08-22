import { describe, expect, it } from 'vitest'
import { chunkToWidth, codePointWidth, displayWidth, escapeControls, hangingIndent, stripAnsi, style, tailToWidth, truncateToWidth, wrapToWidth } from '../src/index.ts'


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

describe('tailToWidth()', () => {
  it('keeps the end, which is where the cursor of an input line is', () => {
    // The reason it exists: cutting the end of a field hides exactly the
    // characters the person is typing.
    expect(tailToWidth('abcdef', 3)).toBe('def')
    expect(tailToWidth('abc', 10)).toBe('abc')
  })

  it('never emits half of a two-column character', () => {
    expect(tailToWidth('标准模式', 3)).toBe('式')
    expect(tailToWidth('标准模式', 4)).toBe('模式')
  })

  it('returns nothing for a non-positive budget', () => {
    expect(tailToWidth('abc', 0)).toBe('')
    expect(tailToWidth('abc', -1)).toBe('')
  })

  it('agrees with displayWidth about what it produced', () => {
    for (const columns of [1, 2, 3, 5, 8]) {
      expect(displayWidth(tailToWidth('ab标准cd模式', columns))).toBeLessThanOrEqual(columns)
    }
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

  it('keeps a newline, which is layout the caller has already handled', () => {
    expect(escapeControls('a\nc')).toBe('a\nc')
  })

  it('expands a tab to the next tab stop, because a tab cannot be measured', () => {
    // displayWidth counts a tab as zero while the terminal advances it, so leaving
    // one in place makes a box pad its row to the wrong width and shift its border.
    expect(escapeControls('a\tb')).toBe(`a${' '.repeat(7)}b`)
    expect(displayWidth(escapeControls('a\tb'))).toBe(9)
  })

  it('counts tab stops from the start of each line', () => {
    // A newline returns the terminal to column zero, so the stops restart with it.
    expect(escapeControls('abcdefghij\tx\nab\tx')).toBe(`abcdefghij${'      '}x\nab${'      '}x`)
  })

  it('leaves no tab anywhere in escaped output, so every row can be measured', () => {
    for (const source of ['\t', 'a\t', '\ta', 'a\tb\tc', '\t\t\t', 'x\n\ty']) {
      expect(escapeControls(source), JSON.stringify(source)).not.toContain('\t')
    }
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

describe('truncateToWidth() and open styling', () => {
  const RED = '\u001b[31m'
  const RESET = '\u001b[0m'

  it('closes styling the cut discarded', () => {
    // The cut throws away everything after it, including the reset that closed the
    // colour, so without this the colour leaks into whatever is drawn next: for a
    // gutter or the composer that means every row after it changes colour.
    const truncated = truncateToWidth(`${RED}abcdef${RESET}`, 3)
    expect(stripAnsi(truncated)).toBe('abc')
    expect(truncated.endsWith(RESET)).toBe(true)
  })

  it('leaves an untruncated string byte for byte', () => {
    const styled = `${RED}abc${RESET}`
    expect(truncateToWidth(styled, 10)).toBe(styled)
    expect(truncateToWidth(styled, 3)).toBe(styled)
  })

  it('adds no closer when the cut text carried no styling', () => {
    expect(truncateToWidth('abcdef', 3)).toBe('abc')
  })

  it('adds no closer when the styling was already closed before the cut', () => {
    const truncated = truncateToWidth(`${RED}ab${RESET}cdef`, 3)
    expect(stripAnsi(truncated)).toBe('abc')
    expect(truncated.match(/\[0m/gu)).toHaveLength(1)
  })

  it('closes a wide glyph cut, where the discarded character is two columns', () => {
    const truncated = truncateToWidth(`${RED}你好${RESET}`, 3)
    expect(stripAnsi(truncated)).toBe('你')
    expect(truncated.endsWith(RESET)).toBe(true)
  })
})

describe('chunkToWidth()', () => {
  it('breaks where the row runs out, not at a word boundary', () => {
    expect(chunkToWidth('aaaa bbbbbbbbb', 11)).toEqual(['aaaa bbbbbb', 'bbb'])
  })

  it('is prefix-consistent, which word wrapping is not', () => {
    // The property the composer's cursor depends on: the rows for the text before a
    // position are the first rows for the whole text, because no later character can
    // move an earlier break.
    const text = 'aaaa bbbbbbbbb cccc dddddddd eeee'
    for (let cut = 0; cut <= text.length; cut += 1) {
      const prefix = chunkToWidth(text.slice(0, cut), 11)
      const whole = chunkToWidth(text, 11)
      expect(whole.slice(0, prefix.length - 1), `cut ${String(cut)}`)
        .toEqual(prefix.slice(0, prefix.length - 1))
    }
  })

  it('never splits a wide character across two rows', () => {
    expect(chunkToWidth('你好世界', 5)).toEqual(['你好', '世界'])
    for (const row of chunkToWidth('你'.repeat(20), 7)) expect(displayWidth(row)).toBeLessThanOrEqual(7)
  })

  it('keeps every row within the budget', () => {
    for (const columns of [1, 2, 3, 7, 40]) {
      for (const row of chunkToWidth('mixed 你好 text 世界 here', columns)) {
        expect(displayWidth(row), `${String(columns)} columns`).toBeLessThanOrEqual(Math.max(columns, 2))
      }
    }
  })

  it('reopens styling on a continuation row and closes it on the one it left', () => {
    const rows = chunkToWidth('\u001b[31maaaaaaaaaa\u001b[0m', 4)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0]).toContain('\u001b[31m')
    expect(rows[0]?.endsWith('\u001b[0m')).toBe(true)
    expect(rows[1]).toContain('\u001b[31m')
  })

  it('keeps newlines as row boundaries', () => {
    expect(chunkToWidth('ab\ncd', 10)).toEqual(['ab', 'cd'])
  })

  it('returns one empty row for empty text', () => {
    expect(chunkToWidth('', 10)).toEqual([''])
  })
})

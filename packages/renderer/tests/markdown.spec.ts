import { describe, expect, it } from 'vitest'
import { renderInline, renderMarkdown, stripAnsi } from '../src/index.ts'

/** Rendered lines with styling removed, so structure is readable in assertions. */
function plain(source: string): string[] {
  return renderMarkdown(source).map(stripAnsi)
}

describe('renderMarkdown()', () => {
  it('renders headings without their markers', () => {
    expect(plain('# Title\n## Section\n### Detail')).toEqual(['Title', 'Section', 'Detail'])
  })

  it('renders bullets with a glyph per nesting depth', () => {
    expect(plain('- one\n  - two\n    - three')).toEqual(['• one', '  ◦ two', '    ‣ three'])
  })

  it('keeps ordered list numbers', () => {
    expect(plain('1. first\n2) second')).toEqual(['1. first', '2. second'])
  })

  it('renders a block quote with a gutter', () => {
    expect(plain('> quoted')).toEqual(['▏ quoted'])
  })

  it('renders a thematic break', () => {
    expect(plain('---')).toEqual(['───'])
  })

  it('drops fence markers and keeps the code, indented', () => {
    expect(plain('```ts\nconst a = 1\n```')).toEqual(['ts', '  const a = 1'])
  })

  it('leaves markdown syntax inside a fence literal', () => {
    // A code block is the one place where **bold** is text, not emphasis.
    expect(plain('```\n**not bold** and `not code`\n```')).toEqual(['  **not bold** and `not code`'])
  })

  it('leaves an unrecognised line as its own text', () => {
    expect(plain('just a sentence.')).toEqual(['just a sentence.'])
  })

  it('preserves blank lines between paragraphs', () => {
    expect(plain('one\n\ntwo')).toEqual(['one', '', 'two'])
  })
})

describe('renderInline()', () => {
  it('strips emphasis markers', () => {
    expect(stripAnsi(renderInline('**bold** and *italic* and ~~struck~~'))).toBe('bold and italic and struck')
  })

  it('strips code span backticks', () => {
    expect(stripAnsi(renderInline('call `readFile` first'))).toBe('call readFile first')
  })

  it('treats emphasis inside a code span as literal', () => {
    // The code pattern is tried first precisely so this stays text.
    expect(stripAnsi(renderInline('`**not bold**`'))).toBe('**not bold**')
  })

  it('renders a link as its text plus target', () => {
    expect(stripAnsi(renderInline('see [docs](https://example.com)'))).toBe('see docs (https://example.com)')
  })

  it('emits an unmatched marker literally rather than swallowing the line', () => {
    // A lone asterisk is common in prose; consuming to end of line would lose it.
    expect(stripAnsi(renderInline('2 * 3 = 6'))).toBe('2 * 3 = 6')
    expect(stripAnsi(renderInline('a **dangling'))).toBe('a **dangling')
  })

  it('applies styling, not only marker removal', () => {
    // stripAnsi is used elsewhere to read structure, so at least one test has to
    // confirm there was styling there to strip.
    expect(renderInline('**bold**')).not.toBe('bold')
    expect(renderInline('**bold**')).toContain('\u001b[1m')
  })
})

describe('untrusted content', () => {
  it('neutralizes an escape sequence in prose', () => {
    // A model can emit a control sequence anywhere, not only inside code spans.
    expect(stripAnsi(renderInline('before \u001b[2J after'))).toBe('before ^[[2J after')
  })

  it('neutralizes an escape sequence inside a code span', () => {
    expect(stripAnsi(renderInline('`\u001b[2J`'))).toBe('^[[2J')
  })

  it('neutralizes an escape sequence inside a fenced block', () => {
    expect(plain('```\n\u001b[2Jwiped\n```')).toEqual(['  ^[[2Jwiped'])
  })

  it('neutralizes an escape sequence in a heading, a bullet, and a link', () => {
    expect(plain('# \u001b[2Jtitle')).toEqual(['^[[2Jtitle'])
    expect(plain('- \u001b[2Jitem')).toEqual(['• ^[[2Jitem'])
    expect(stripAnsi(renderInline('[t\u001b[2J](u\u001b[2J)'))).toBe('t^[[2J (u^[[2J)')
  })

  it('neutralizes a carriage return, which would reposition the cursor', () => {
    expect(stripAnsi(renderInline('a\rb'))).toBe('a^Mb')
  })

  it('leaves no raw escape byte anywhere in rendered output', () => {
    const hostile = '# h\u001b[2J\n- b\u001b[2J\n> q\u001b[2J\n`c\u001b[2J`\n```\nf\u001b[2J\n```\n**e\u001b[2J**'
    for (const line of renderMarkdown(hostile)) {
      // Styling introduces its own escapes, so the check is that no escape
      // survives from the SOURCE — every one is followed by a styling parameter.
      expect(stripAnsi(line)).not.toContain('\u001b')
    }
  })
})

import { describe, expect, it } from 'vitest'
import { createMarkdownRenderer, renderInline, renderMarkdown, stripAnsi } from '../src/index.ts'

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

describe('delimiter flanking', () => {
  const inline = (source: string): string => stripAnsi(renderInline(source))

  it('leaves snake_case identifiers intact', () => {
    // Underscores inside a word are part of the word. Without this the reply
    // reads "snakecasename" — and italic is invisible in several terminals, so
    // the user sees only the damage, in a name they may need to type.
    expect(inline('snake_case_name')).toBe('snake_case_name')
    expect(inline('MY_CONST_NAME')).toBe('MY_CONST_NAME')
    expect(inline('a_b_c')).toBe('a_b_c')
    expect(inline('some_var and other_var')).toBe('some_var and other_var')
  })

  it('leaves file names intact', () => {
    expect(inline('file_name.ts')).toBe('file_name.ts')
    expect(inline('see src/my_module/index_test.py')).toBe('see src/my_module/index_test.py')
  })

  it('leaves dunder names intact', () => {
    // A deliberate deviation: CommonMark reads __init__ as strong emphasis, but in
    // a reply about code it is a Python dunder far more often.
    expect(inline('__init__')).toBe('__init__')
    expect(inline('__all__ and __name__')).toBe('__all__ and __name__')
  })

  it('leaves arithmetic intact', () => {
    // A delimiter followed by whitespace cannot open emphasis.
    expect(inline('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(inline('5 ** 2')).toBe('5 ** 2')
    expect(inline('a * b * c')).toBe('a * b * c')
  })

  it('still renders genuine emphasis', () => {
    expect(inline('**bold**')).toBe('bold')
    expect(inline('*italic*')).toBe('italic')
    expect(inline('_italic_')).toBe('italic')
    expect(inline('~~struck~~')).toBe('struck')
    expect(inline('a **b c** d')).toBe('a b c d')
  })

  it('still renders multi-word double-underscore emphasis', () => {
    // The dunder rule keys on the absence of whitespace, so real emphasis works.
    expect(inline('__bold text__')).toBe('bold text')
  })

  it('allows intraword asterisk emphasis, which CommonMark permits', () => {
    expect(inline('x*y*z')).toBe('xyz')
  })

  it('reads the preceding character as a code point, not a UTF-16 unit', () => {
    // A supplementary-plane letter occupies two code units, so indexing by unit
    // returns a lone surrogate, WORD does not match it, and the position reads as
    // non-word — reintroducing exactly the corruption the flanking test prevents.
    expect(inline('\u{10400}_name_')).toBe('\u{10400}_name_')
    expect(inline('\u{1d400}_x_')).toBe('\u{1d400}_x_')
    // A supplementary-plane NON-letter is not a word character, so emphasis still
    // opens after it.
    expect(inline('\u{1f600}_x_')).toBe('\u{1f600}x')
  })

  it('never matches part of a longer delimiter run', () => {
    // A rejected `__` must not let the single `_` form eat one underscore of the
    // pair. That produced `_init_` — mangled differently rather than left alone —
    // so the assertion is that the text survives byte for byte.
    expect(inline('__init__')).toBe('__init__')
    expect(inline('***both***')).toBe('***both***')
    // And nothing was styled, which an equality check on stripped text cannot see.
    expect(renderInline('__init__')).toBe('__init__')
  })
})

describe('fenced blocks', () => {
  const fence = '```'
  const longer = '````'

  it('keeps a shorter fence inside a longer one as content', () => {
    // The shape a model produces when showing fenced examples inside a fenced
    // answer. Closing on the inner run inverted every block after it.
    expect(plain([longer + 'md', 'before', fence, 'inside', fence, 'after', longer, 'outside'].join('\n')))
      .toEqual(['md', '  before', '  ' + fence, '  inside', '  ' + fence, '  after', 'outside'])
  })

  it('does not let a closing fence carry an info string', () => {
    expect(plain([fence + 'js', 'code', fence + 'python', 'still code', fence].join('\n')))
      .toEqual(['js', '  code', '  ' + fence + 'python', '  still code'])
  })

  it('treats a deeply indented fence inside a block as content', () => {
    // CommonMark allows at most three spaces of indent for a fence.
    expect(plain([fence, '        ' + fence, 'still inside', fence].join('\n')))
      .toEqual(['          ' + fence, '  still inside'])
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

describe('pathological input', () => {
  /**
   * Time one line through the line renderer, which is where the patterns run.
   *
   * renderMarkdown splits on newlines first, so it can never hand a pattern a line
   * containing one — and a trailing newline is exactly the input that makes an
   * end-anchored marker pattern quadratic. The renderer is public, so the guard
   * belongs at the level a consumer can actually reach.
   * @param line - the line to render.
   * @returns elapsed milliseconds.
   */
  function elapsed(line: string): number {
    const renderer = createMarkdownRenderer()
    const started = performance.now()
    renderer.line(line)
    return performance.now() - started
  }

  // Generous on purpose: the point is the difference between linear and quadratic,
  // not a benchmark. Before the patterns were bounded, 40k spaces took seconds;
  // after, it is sub-millisecond, so anything under this bound proves the class of
  // behaviour without being sensitive to the machine.
  const BUDGET_MS = 500

  it('renders a long run of spaces in linear time', () => {
    // The shape that made it quadratic: an unbounded indent in front of a marker
    // is ambiguous with the whitespace that follows it, so on a line the pattern
    // ultimately rejects, the engine retries at every split. A model emits rows of
    // spaces routinely, so this was reachable from model output.
    expect(elapsed(' '.repeat(40_000))).toBeLessThan(BUDGET_MS)
  })

  it('renders a long run of spaces after a list marker in linear time', () => {
    expect(elapsed(`* ${' '.repeat(40_000)}`)).toBeLessThan(BUDGET_MS)
    expect(elapsed(`9) ${' '.repeat(40_000)}`)).toBeLessThan(BUDGET_MS)
    expect(elapsed(`- ${'\t'.repeat(20_000)}`)).toBeLessThan(BUDGET_MS)
  })

  it('renders a long run of rule characters in linear time', () => {
    expect(elapsed('- '.repeat(20_000))).toBeLessThan(BUDGET_MS)
    expect(elapsed(`${'_ '.repeat(20_000)}x`)).toBeLessThan(BUDGET_MS)
  })

  it('renders a line ending in a newline in linear time', () => {
    // The case an earlier fix here got backwards. `\s` matches a newline, so a
    // greedy `\s+` swallows a trailing one and the first attempt succeeds;
    // narrowing the separator to `[ \t]` meant every split got tried instead, and
    // a 16k line went from 0.1 ms to 2367 ms. Matching the marker as a prefix, with
    // no end anchor to fail against, is what removes the ambiguity for good.
    for (const line of [
      `9) ${'  '.repeat(8_000)}\n`,
      `* ${'  '.repeat(8_000)}\n`,
      `# ${'  '.repeat(8_000)}\n`,
      `> ${'  '.repeat(8_000)}\n`,
      `${' '.repeat(16_000)}\n`,
      `${'- '.repeat(8_000)}\n`,
    ]) {
      expect(elapsed(line), JSON.stringify(line.slice(0, 4))).toBeLessThan(BUDGET_MS)
    }
  })

  it('still reads a deeply indented list item as a list item', () => {
    // The indent bound has to be generous enough that real nesting still works.
    expect(plain(`${' '.repeat(20)}- deep`)).toEqual([`${' '.repeat(20)}\u2023 deep`])
  })

  it('treats an indent past the bound as prose, not a list', () => {
    const far = ' '.repeat(200)
    expect(plain(`${far}- not a bullet`)).toEqual([`${far}- not a bullet`])
  })

  it('requires a rule to repeat one character, per CommonMark', () => {
    // Stripping the separators and testing the remainder is what made this linear,
    // and it corrects the rule at the same time: `-*_` was never a thematic break.
    expect(plain('---')).toEqual(['\u2500\u2500\u2500'])
    expect(plain('* * *')).toEqual(['\u2500\u2500\u2500'])
    expect(plain('___')).toEqual(['\u2500\u2500\u2500'])
    expect(plain('-*_')).toEqual(['-*_'])
  })

  it('caps an ordered marker at nine digits, per CommonMark', () => {
    expect(plain('1234567890. not a list')).toEqual(['1234567890. not a list'])
    expect(plain('123456789. a list')).toEqual(['123456789. a list'])
  })
})

describe('partial lines (the live region)', () => {
  it('styles an inline span the moment its markers arrive', () => {
    const renderer = createMarkdownRenderer()
    const row = renderer.partial('the **bold** tail')
    expect(stripAnsi(row)).toBe('the bold tail')
    expect(row).toContain('\u001b[1m')
  })

  it('leaves an unfinished span literal until it closes', () => {
    // A model can stream `**bo` and stop there; showing the syntax is better
    // than guessing at emphasis that never arrives.
    const renderer = createMarkdownRenderer()
    expect(stripAnsi(renderer.partial('the **bo'))).toBe('the **bo')
  })

  it('renders a heading as soon as its marker arrives', () => {
    const renderer = createMarkdownRenderer()
    expect(stripAnsi(renderer.partial('# Hea'))).toBe('Hea')
    expect(renderer.partial('# Hea')).toContain('\u001b[1;36m')
  })

  it('does not advance block state', () => {
    // The partial tail of a fence opener must not OPEN the fence: the newline
    // decides that, and only the committed line may advance state. Otherwise a
    // streamed opener would leave the renderer inside a fence that never opened.
    const renderer = createMarkdownRenderer()
    expect(renderer.partial('```')).toBe('')
    // Still read as an opener (its info line is emitted), not as fence content —
    // which is what a fence left open by the partial would have produced.
    expect(renderer.line('```ts').map(stripAnsi)).toEqual(['ts'])
    // The committed opener did advance state: the next partial is inside a fence.
    expect(stripAnsi(renderer.partial('not code'))).toBe('  not code')
  })

  it('reads the current fence state, so a partial line inside a fence is code', () => {
    const renderer = createMarkdownRenderer()
    renderer.line('```')
    const row = renderer.partial('**raw**')
    expect(stripAnsi(row)).toBe('  **raw**')
    // Never parsed for emphasis: a code block is the one place **bold** is text.
    expect(row).not.toContain('\u001b[1m')
  })

  it('neutralizes an escape sequence in a partial line', () => {
    const renderer = createMarkdownRenderer()
    const row = renderer.partial('before \u001b[2J after')
    expect(stripAnsi(row)).toBe('before ^[[2J after')
    expect(stripAnsi(row)).not.toContain('\u001b')
  })
})

describe('indented code', () => {
  it('renders a four-space line as code, never parsed for emphasis', () => {
    const rows = renderMarkdown('    const a = 1')
    expect(rows.map(stripAnsi)).toEqual(['    const a = 1'])
    expect(rows[0]).toContain('\u001b[36m')
  })

  it('leaves markdown syntax inside indented code literal', () => {
    expect(plain('    **not bold** and `not code`')).toEqual(['    **not bold** and `not code`'])
  })

  it('neutralizes an escape sequence inside indented code', () => {
    expect(plain('    \u001b[2Jwiped')).toEqual(['    ^[[2Jwiped'])
  })

  it('still reads a list marker under four spaces as a list item', () => {
    // Indentation with a marker after it wins over indented code, which is the
    // same rule that keeps a deeply indented list a list.
    expect(plain('    - item')).toEqual(['    \u2023 item'])
  })

  it('keeps a line past the list indent bound verbatim', () => {
    // The pathological-input guarantee: an indent too deep for a list is prose
    // that survives byte for byte, so stripping four spaces here would rewrite
    // text the list rule already promised to leave alone.
    const far = ' '.repeat(200)
    expect(plain(`${far}- not a bullet`)).toEqual([`${far}- not a bullet`])
  })
})

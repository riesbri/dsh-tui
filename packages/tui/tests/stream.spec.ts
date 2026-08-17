import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { displayWidth, stripAnsi } from '@riesbri/dsh-tui-renderer'
import { StreamBuffer } from '../src/stream.ts'

/** Strip styling, so assertions read as what a person would see. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

/** A text content block, as the assembler produces one. */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * Feed a reply in fragments and collect everything that reached scrollback.
 * @param fragments - the deltas, in order.
 * @param settle - whether the assembled message lands afterwards.
 * @returns the committed lines, styling removed.
 */
function stream(fragments: readonly string[], settle = true): string[] {
  const buffer = new StreamBuffer()
  const out: string[] = []
  for (const fragment of fragments) out.push(...buffer.push('text', fragment))
  if (settle) out.push(...buffer.settle(text(fragments.join(''))))
  return plain(out)
}

describe('incremental commit', () => {
  it('commits a completed line as soon as its newline arrives', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'first'))).toEqual([])
    expect(plain(buffer.push('text', '\nsec'))).toEqual(['', '● first'])
    expect(plain(buffer.push('text', 'ond\n'))).toEqual(['  second'])
  })

  it('keeps only the unfinished line live, however long the reply runs', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\npartial')
    // Every complete line is in scrollback; the live region does not grow with
    // the reply, which is the whole point of committing as lines finish.
    expect(plain(buffer.live(80))).toEqual(['  partial'])
  })

  it('produces exactly what a single full render produces', () => {
    // The guarantee that makes incremental commit safe: chunking must not change
    // the transcript. A one-shot settle is the non-incremental path.
    const source = '# Title\n\nsome **bold** text\n\n- a\n- b\n\n```ts\nconst a = 1\n```\n\ndone'
    const whole = stream([source])
    for (const size of [1, 3, 7, 40]) {
      const fragments = source.match(new RegExp(`.{1,${String(size)}}`, 'gsu')) ?? []
      expect(stream(fragments), `fragment size ${String(size)}`).toEqual(whole)
    }
  })

  it('keeps a fenced block styled as code across separately committed lines', () => {
    // Each committed line is rendered on its own, so without block state carried
    // between them the fence reopens per line and code is styled as prose.
    const buffer = new StreamBuffer()
    const committed: string[] = []
    for (const fragment of ['```ts\n', '- not a bullet\n', '# not a heading\n', '```\n']) {
      committed.push(...buffer.push('text', fragment))
    }
    expect(plain(committed)).toEqual(['', '● ts', '    - not a bullet', '    # not a heading'])
  })

  it('renders blank lines the same whether the provider chunked the reply or not', () => {
    // The asymmetry this closes: a reply beginning with a newline used to open with
    // an empty marked row when streamed, because the blank was committed before
    // anything proved it was leading. The assembled path trims, so identical
    // content rendered differently depending on the provider.
    const source = '\n\nHello\n\n\nWorld\n\n'
    const whole = plain(new StreamBuffer().settle(text(source)))
    expect(whole).toEqual(['', '\u25cf Hello', '', '', '  World'])
    for (const size of [1, 2, 5, 40]) {
      expect(stream(source.match(new RegExp(`.{1,${String(size)}}`, 'gsu')) ?? []), `chunks of ${String(size)}`)
        .toEqual(whole)
    }
  })

  it('holds a blank row until a later line proves it internal', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'first\n')
    // The blank has arrived but cannot be placed yet: it is a paragraph break only
    // if more text follows, and padding otherwise.
    expect(plain(buffer.push('text', '\n'))).toEqual([])
    expect(buffer.heldBlanks('text')).toBe(1)
    expect(plain(buffer.push('text', 'second\n'))).toEqual(['', '  second'])
  })

  it('discards a trailing blank rather than padding the composer down', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'only\n\n\n')
    expect(buffer.heldBlanks('text')).toBe(2)
    expect(plain(buffer.settle(text('only\n\n\n')))).toEqual([])
  })

  it('keeps a blank line inside a fenced block, which is code rather than nothing', () => {
    // Judged on the rendered row: inside a fence a blank source line renders as
    // indented code and must not be held back as if it were a paragraph break.
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle(text('```\na\n\nb\n```'))))
      // Indented twice: the fence's own two columns inside the gutter's two.
      .toEqual(['', '\u25cf   a', '    ', '    b'])
  })

  it('commits the last unterminated line when the assembled message lands', () => {
    expect(stream(['done ', 'at last'])).toEqual(['', '● done at last'])
  })

  it('never prints the reply twice', () => {
    const committed = stream(['alpha\n', 'beta\n', 'gamma'])
    expect(committed).toEqual(['', '● alpha', '  beta', '  gamma'])
  })

  it('commits the whole reply when the provider streamed nothing', () => {
    // A non-streaming adapter emits no chunks at all, so the assembled message is
    // the only source and must still print in full.
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle(text('first\nsecond')))).toEqual(['', '● first', '  second'])
  })

  it('commits the assembled reply whole when it does not extend what streamed', () => {
    // The forms cannot be aligned, and the lines already on screen cannot be
    // taken back: a duplicated reply is visible, a dropped one is not.
    const buffer = new StreamBuffer()
    buffer.push('text', 'streamed\n')
    expect(plain(buffer.settle(text('something else')))).toEqual(['  something else'])
  })

  it('drops the trailing newline a reply usually ends with', () => {
    expect(stream(['answer\n'])).toEqual(['', '● answer'])
  })

  it('commits an interrupted reply instead of losing it with the live region', () => {
    // ctrl-c during a turn: the loop throws before appending a message, so this
    // is the only chance to keep what the user watched arrive.
    const buffer = new StreamBuffer()
    buffer.push('text', 'half a th')
    expect(plain(buffer.finish())).toEqual(['', '● half a th'])
    expect(plain(buffer.live(80))).toEqual([])
  })
})

describe('reasoning', () => {
  it('shows reasoning while it streams, so the UI is never just a spinner', () => {
    const buffer = new StreamBuffer()
    buffer.push('reasoning', 'weighing the options')
    expect(plain(buffer.live(80))).toEqual(['', '✻ weighing the options'])
  })

  it('styles reasoning apart from the reply', () => {
    const buffer = new StreamBuffer()
    const live = buffer.push('reasoning', 'thinking\n')
    // Dim and italic together, so reasoning recedes behind the answer.
    expect(live.join('')).toContain('\u001b[2;3m')
    expect(plain(buffer.settle(text('the answer'))).join('')).toContain('the answer')
  })

  it('closes reasoning when the first reply delta arrives', () => {
    // Nothing in the log marks the end of reasoning; the first text delta is it.
    const buffer = new StreamBuffer()
    buffer.push('reasoning', 'a thought with no newline')
    expect(plain(buffer.push('text', 'The answer'))).toEqual(['', '✻ a thought with no newline'])
    expect(plain(buffer.live(80))).toEqual(['', '● The answer'])
  })

  it('commits reasoning before the reply when the message lands', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'because' },
      { type: 'text', text: 'therefore' },
    ]))).toEqual(['', '✻ because', '', '● therefore'])
  })

  it('leaves reasoning unparsed, since a half-formed thought is not a document', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle([{ type: 'reasoning', text: '# not a heading' }])))
      .toEqual(['', '✻ # not a heading'])
  })
})

describe('live region', () => {
  it('bounds itself when one line wraps past the region', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'x'.repeat(4000))
    const live = buffer.live(20)
    // Taller than the terminal would leave the cursor unable to reach the
    // region's first row, corrupting every later redraw.
    expect(live.length).toBeLessThanOrEqual(5)
    expect(plain(live).join('\n')).toContain('…')
  })

  it('bounds itself for wide characters too, which fill two columns each', () => {
    // The character cut alone cannot bound the rows: it keeps a fixed number of
    // characters, and a full-width character occupies two columns, so the same
    // cut wraps to twice as many rows.
    const buffer = new StreamBuffer()
    buffer.push('text', '\u4f60'.repeat(4000))
    expect(buffer.live(20).length).toBeLessThanOrEqual(5)
  })

  it('never returns a row wider than the terminal', () => {
    // A row wider than the terminal is wrapped again by the screen, so four nominal
    // rows become however many the overflow demands — and past the screen height the
    // redraw can no longer climb to the region's first row.
    //
    // The wide-glyph case is the one that needs the cut: wrapToWidth must emit a
    // two-column character even when the budget is one column, because refusing
    // would make no progress and never terminate. So at three columns a CJK
    // character arrives wider than the row it was wrapped for.
    for (const columns of [3, 4, 5, 8, 12, 20, 41]) {
      for (const filler of ['x', '\u4f60', '\u{1f600}']) {
        const buffer = new StreamBuffer()
        buffer.push('text', filler.repeat(2000))
        for (const row of buffer.live(columns)) {
          expect(displayWidth(row), `${String(columns)} columns of ${JSON.stringify(filler)}`)
            .toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('reserves a column for the elision marker', () => {
    // The first shown row is already exactly as wide as the budget allows, so the
    // marker has to come out of its content rather than be added beside it.
    const buffer = new StreamBuffer()
    buffer.push('text', 'x'.repeat(4000))
    const rows = buffer.live(20)
    expect(plain(rows).some(row => row.includes('\u2026'))).toBe(true)
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(20)
  })

  it('draws nothing at all in a terminal too narrow for one content column', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'text')
    expect(buffer.live(2)).toEqual([])
  })

  it('shows the end of the unfinished line, which is what just arrived', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', `${'x'.repeat(4000)}NEWEST`)
    expect(plain(buffer.live(20)).join('')).toContain('NEWEST')
  })

  it('attaches its rows to the committed lines above once the mark is written', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'committed\nlive part')
    // No blank spacer: a blank here would detach the live rows from the lines
    // they continue.
    expect(plain(buffer.live(80))).toEqual(['  live part'])
  })

  it('shows nothing between a completed line and the next delta', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'complete\n')
    expect(plain(buffer.live(80))).toEqual([])
  })

  it('escapes a control sequence in the unfinished line', () => {
    // The live region is the one place a delta reaches the terminal before any
    // committed rendering has escaped it.
    const buffer = new StreamBuffer()
    buffer.push('text', 'before \u001b[2J after')
    expect(plain(buffer.live(80))).toEqual(['', '\u25cf before ^[[2J after'])
  })

  it('escapes a control sequence in streamed reasoning', () => {
    const buffer = new StreamBuffer()
    buffer.push('reasoning', 'hmm \u001b[2J')
    expect(plain(buffer.live(80))).toEqual(['', '\u273b hmm ^[[2J'])
  })

  it('starts clean after a reset, keeping no state from the previous turn', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', '```\ncode\n')
    buffer.reset()
    expect(plain(buffer.push('text', '# heading\n'))).toEqual(['', '● heading'])
  })
})

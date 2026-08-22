import { describe, expect, it } from 'vitest'
import { Composer, createKeyDecoder, decodeKeys } from '../src/index.ts'

describe('decodeKeys()', () => {
  it('splits one chunk into ordered keys', () => {
    expect(decodeKeys('hi')).toEqual([{ kind: 'text', text: 'hi' }])
    expect(decodeKeys('a\r')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'key', name: 'enter' },
    ])
  })

  it('decodes arrow keys from both CSI and SS3 forms', () => {
    expect(decodeKeys('\u001b[A')).toEqual([{ kind: 'key', name: 'up' }])
    expect(decodeKeys('\u001bOB')).toEqual([{ kind: 'key', name: 'down' }])
  })

  it('decodes parameterized sequences', () => {
    expect(decodeKeys('\u001b[3~')).toEqual([{ kind: 'key', name: 'delete' }])
  })

  it('drops an unrecognized sequence instead of typing it into the buffer', () => {
    // A sequence with no meaning here would otherwise appear as "[<35;40;12M".
    expect(decodeKeys('\u001b[<35;40;12M')).toEqual([])
    expect(decodeKeys('\u001b[999~')).toEqual([])
  })

  it('reads shift-enter as a newline, in either enhanced encoding', () => {
    // A terminal in its default mode sends a bare carriage return for shift-enter,
    // which is indistinguishable from enter. These are the two encodings that say
    // otherwise: the kitty keyboard protocol's `CSI code ; modifiers u`, and
    // xterm's `modifyOtherKeys` `CSI 27 ; modifiers ; code ~`. Which one arrives
    // depends on the terminal, so both are read.
    expect(decodeKeys('\u001b[13;2u')).toEqual([{ kind: 'key', name: 'newline' }])
    expect(decodeKeys('\u001b[27;2;13~')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('reads an unmodified enhanced enter as enter, not as a newline', () => {
    expect(decodeKeys('\u001b[13u')).toEqual([{ kind: 'key', name: 'enter' }])
    expect(decodeKeys('\u001b[13;1u')).toEqual([{ kind: 'key', name: 'enter' }])
  })

  it('reads alt-enter as a newline too, in either enhanced encoding', () => {
    // On a terminal that implements this protocol, alt-enter arrives as
    // `CSI 13 ; 3 u` rather than the legacy `ESC CR` — so recognising only shift
    // would make the documented fallback gesture SUBMIT, sending an unfinished
    // prompt on exactly the terminals where the new mode works.
    expect(decodeKeys('\u001b[13;3u')).toEqual([{ kind: 'key', name: 'newline' }])
    expect(decodeKeys('\u001b[27;3;13~')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('reads ctrl-enter as the plain key, which is what it was before', () => {
    // Ctrl-enter carries no separate meaning here, and reporting the key is better
    // than dropping the keystroke.
    expect(decodeKeys('\u001b[13;5u')).toEqual([{ kind: 'key', name: 'enter' }])
    expect(decodeKeys('\u001b[27;5;13~')).toEqual([{ kind: 'key', name: 'enter' }])
  })

  it('reads a newline when shift or alt is held with another modifier', () => {
    // Modifier 6 is ctrl+shift and 7 is ctrl+alt; the shift and alt bits decide.
    expect(decodeKeys('\u001b[13;6u')).toEqual([{ kind: 'key', name: 'newline' }])
    expect(decodeKeys('\u001b[13;7u')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('drops an enhanced report for a key it gives no meaning to', () => {
    // A letter reported through the protocol is not text: inserting it would type
    // the character twice on terminals that also send the legacy encoding.
    expect(decodeKeys('\u001b[97;2u')).toEqual([])
  })

  it('reads the ctrl gestures in the enhanced encoding, which is the only one it gets', () => {
    // Asking for this mode STOPS the legacy control bytes arriving: a terminal that
    // implements it sends `CSI 99 ; 5 u` and never `0x03` again. Reading only the
    // byte therefore did not degrade the ctrl gestures, it deleted them — quitting
    // and cancelling decoded to nothing at all on every terminal that obeyed.
    expect(decodeKeys('\u001b[99;5u')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
    expect(decodeKeys('\u001b[100;5u')).toEqual([{ kind: 'key', name: 'ctrl-d' }])
    expect(decodeKeys('\u001b[108;5u')).toEqual([{ kind: 'key', name: 'ctrl-l' }])
    expect(decodeKeys('\u001b[111;5u')).toEqual([{ kind: 'key', name: 'ctrl-o' }])
    expect(decodeKeys('\u001b[27;5;99~')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
  })

  it('reads every ctrl gesture the legacy table names, in both encodings', () => {
    // The two tables are one table: whatever a control byte means, the letter
    // 0x60 above it with the ctrl bit means the same thing. Asserted as a pair so a
    // gesture added to one encoding and not the other fails here rather than in a
    // bug report from whoever happens to use the wrong terminal.
    const gestures = {
      a: 'ctrl-a', c: 'ctrl-c', d: 'ctrl-d', e: 'ctrl-e',
      k: 'ctrl-k', l: 'ctrl-l', o: 'ctrl-o', r: 'ctrl-r', u: 'ctrl-u', w: 'ctrl-w',
    } as const
    for (const [letter, name] of Object.entries(gestures)) {
      const code = letter.codePointAt(0) ?? 0
      const legacy = String.fromCodePoint(code - 0x60)
      expect(decodeKeys(legacy)).toEqual([{ kind: 'key', name }])
      expect(decodeKeys(`\u001b[${String(code)};5u`)).toEqual([{ kind: 'key', name }])
    }
  })

  it('keeps a ctrl gesture when shift is held with it', () => {
    // Modifier 6 is ctrl+shift. `ctrl-shift-c` is the same gesture as `ctrl-c` — a
    // terminal reports the base key, and the capital is not a different intent.
    expect(decodeKeys('\u001b[99;6u')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
  })

  it('reads an enhanced backspace, which only ever arrives modified', () => {
    // The mode leaves UNMODIFIED backspace on its legacy 0x7f, so a report of code
    // 127 is ctrl- or alt-backspace; deleting a character beats doing nothing.
    expect(decodeKeys('\u001b[127u')).toEqual([{ kind: 'key', name: 'backspace' }])
    expect(decodeKeys('\u001b[127;5u')).toEqual([{ kind: 'key', name: 'backspace' }])
  })

  it('still reads enter, tab and escape when ctrl is held', () => {
    // Ctrl does not turn these into a ctrl gesture: the ctrl table is keyed by the
    // LETTER code points, and enter is code 13 whatever is held with it. `ctrl-i`
    // and `ctrl-m` are the letters, and they mean what their control bytes mean.
    expect(decodeKeys('\u001b[13;5u')).toEqual([{ kind: 'key', name: 'enter' }])
    expect(decodeKeys('\u001b[9;5u')).toEqual([{ kind: 'key', name: 'tab' }])
    expect(decodeKeys('\u001b[27;5u')).toEqual([{ kind: 'key', name: 'escape' }])
    expect(decodeKeys('\u001b[105;5u')).toEqual([{ kind: 'key', name: 'tab' }])
    expect(decodeKeys('\u001b[109;5u')).toEqual([{ kind: 'key', name: 'enter' }])
  })

  it('holds a lone trailing ESC until the terminal goes quiet', () => {
    // ESC is the first byte of every sequence here, the paste delimiters included,
    // so deciding it early is how a read boundary landing after that byte turns a
    // pasted paragraph back into one Enter per line.
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b')).toEqual([])
    expect(decoder.flush()).toEqual([{ kind: 'key', name: 'escape' }])
  })

  it('reassembles a paste delimiter split immediately after its ESC', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b')).toEqual([])
    expect(decoder.push('[200~first\nsecond\u001b[201~')).toEqual([
      { kind: 'paste', text: 'first\nsecond' },
    ])
  })

  it('resolves a held ESC as escape when the next chunk is not a sequence', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b')).toEqual([])
    expect(decoder.push('x')).toEqual([{ kind: 'key', name: 'escape' }, { kind: 'text', text: 'x' }])
  })

  it('flushes nothing when nothing is held', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('ab')).toEqual([{ kind: 'text', text: 'ab' }])
    expect(decoder.flush()).toEqual([])
  })

  it('never ends an active paste on an idle flush', () => {
    // A paste arriving in chunks with a gap is indistinguishable from one that
    // stopped, and cutting a real one short turns the rest of the document into
    // Enter keys that submit fragments — the failure bracketed paste prevents.
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[200~first line\n')).toEqual([])
    expect(decoder.flush()).toEqual([])
    expect(decoder.flush()).toEqual([])
    expect(decoder.push('second line\u001b[201~')).toEqual([
      { kind: 'paste', text: 'first line\nsecond line' },
    ])
  })

  it('holds an unfinished sequence across a flush rather than typing it', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[')).toEqual([])
    expect(decoder.flush()).toEqual([])
    expect(decoder.push('A')).toEqual([{ kind: 'key', name: 'up' }])
  })

  it('decodes a lone ESC through the stateless helper, which holds nothing back', () => {
    // decodeKeys is documented for callers holding the whole input, so a held tail
    // has to be decided before it returns.
    expect(decodeKeys('\u001b')).toEqual([{ kind: 'key', name: 'escape' }])
  })

  it('holds an incomplete sequence instead of guessing at it', () => {
    // Terminals emit a sequence in one burst, so a truncated one means the read
    // split it; reporting escape here would drop the real key.
    expect(decodeKeys('\u001b[')).toEqual([])
  })

  it('decodes a sequence split across two reads', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[')).toEqual([])
    expect(decoder.push('D')).toEqual([{ kind: 'key', name: 'left' }])
  })

  it('decodes alt-enter as a deliberate newline', () => {
    expect(decodeKeys('\u001b\r')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('decodes control bytes', () => {
    expect(decodeKeys('\u0003')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
    expect(decodeKeys('\u007f')).toEqual([{ kind: 'key', name: 'backspace' }])
  })

  it('keeps an astral character whole', () => {
    const keys = decodeKeys('🙂')
    expect(keys).toEqual([{ kind: 'text', text: '🙂' }])
  })

  it('handles a burst carrying text, a key, and more text', () => {
    expect(decodeKeys('ab\u001b[Dcd')).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'key', name: 'left' },
      { kind: 'text', text: 'cd' },
    ])
  })
})

describe('bracketed paste', () => {
  it('reports pasted content as one literal key, newlines included', () => {
    const pasted = 'first\nsecond\nthird'
    expect(decodeKeys(`\u001b[200~${pasted}\u001b[201~`)).toEqual([{ kind: 'paste', text: pasted }])
  })

  it('reassembles a paste split across reads', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[200~one\n')).toEqual([])
    expect(decoder.push('two\n')).toEqual([])
    expect(decoder.push('three\u001b[201~')).toEqual([{ kind: 'paste', text: 'one\ntwo\nthree' }])
  })

  it('does not split a paste on a partial terminator', () => {
    const decoder = createKeyDecoder()
    // The chunk ends mid-terminator, which must not be treated as content.
    expect(decoder.push('\u001b[200~body\u001b[20')).toEqual([])
    expect(decoder.push('1~')).toEqual([{ kind: 'paste', text: 'body' }])
  })

  it('keeps typing before and after a paste separate from it', () => {
    expect(decodeKeys('a\u001b[200~pasted\u001b[201~b')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'paste', text: 'pasted' },
      { kind: 'text', text: 'b' },
    ])
  })

  it('treats a control byte inside a paste as content, not a key', () => {
    // A pasted document may contain anything; only the terminator ends it.
    expect(decodeKeys('\u001b[200~a\u0003b\u001b[201~')).toEqual([
      { kind: 'paste', text: 'a\u0003b' },
    ])
  })
})

describe('Composer', () => {
  it('inserts text at the cursor and reports the change', () => {
    const composer = new Composer()
    expect(composer.handle({ kind: 'text', text: 'hello' })).toEqual({ kind: 'changed' })
    expect(composer.value).toBe('hello')
    expect(composer.cursorColumn).toBe(5)
  })

  it('submits and clears on enter', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'run tests' })
    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({ kind: 'submit', text: 'run tests' })
    expect(composer.isEmpty).toBe(true)
  })

  it('clears whitespace-only input without submitting an empty turn', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: '  \n  ' })

    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({ kind: 'changed' })
    expect(composer.isEmpty).toBe(true)
  })

  it('reports an empty enter as ignored, leaving the gesture to the caller', () => {
    const composer = new Composer()
    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({
      kind: 'ignored',
      key: { kind: 'key', name: 'enter' },
    })
  })

  it('moves and edits by code point, not code unit', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'a🙂b' })
    composer.handle({ kind: 'key', name: 'left' })
    // One left arrow must skip the whole emoji, not half of it.
    composer.handle({ kind: 'key', name: 'backspace' })
    expect(composer.value).toBe('ab')
  })

  it('measures the cursor in display columns for CJK', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '标准' })
    expect(composer.cursorColumn).toBe(4)
    composer.handle({ kind: 'key', name: 'left' })
    expect(composer.cursorColumn).toBe(2)
  })

  it('deletes the previous word on ctrl-w, including trailing spaces', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'run the tests  ' })
    composer.handle({ kind: 'key', name: 'ctrl-w' })
    expect(composer.value).toBe('run the ')
  })

  it('clears to the line start on ctrl-u and to the end on ctrl-k', () => {
    const composer = new Composer()
    composer.set('abcdef')
    composer.handle({ kind: 'key', name: 'home' })
    composer.handle({ kind: 'key', name: 'right' })
    composer.handle({ kind: 'key', name: 'ctrl-u' })
    expect(composer.value).toBe('bcdef')
    composer.handle({ kind: 'key', name: 'right' })
    composer.handle({ kind: 'key', name: 'ctrl-k' })
    expect(composer.value).toBe('b')
  })

  it('clamps cursor movement at both ends', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'ab' })
    composer.handle({ kind: 'key', name: 'right' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'left' })
    expect(composer.cursorColumn).toBe(0)
    expect(composer.handle({ kind: 'key', name: 'backspace' })).toEqual({ kind: 'changed' })
    expect(composer.value).toBe('ab')
  })

  it('inserts a paste literally and sends it as one message', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'line one\nline two\nline three' })
    expect(composer.lines).toHaveLength(3)
    // The whole block is one submit; a newline inside it never sent anything.
    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({
      kind: 'submit',
      text: 'line one\nline two\nline three',
    })
  })

  it('neutralizes an escape sequence pasted from a log', () => {
    const composer = new Composer()
    // A person pasting a coloured log would otherwise write those bytes straight
    // to the terminal, where they can repaint or clear the interface.
    composer.handle({ kind: 'paste', text: '\u001b[31mred\u001b[0m' })
    expect(composer.value).toBe('^[[31mred^[[0m')
  })

  it('normalizes CRLF and lone CR so a paste splits into logical lines', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'one\r\ntwo\rthree' })
    // A surviving carriage return would return the cursor to column zero, and a
    // buffer split on newlines alone would keep it inside the line.
    expect(composer.value).not.toContain('\r')
    expect(composer.lines).toEqual(['one', 'two', 'three'])
  })

  it('expands a pasted tab, whose rendered width the arithmetic cannot know', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'a\tb' })
    expect(composer.value).toBe('a    b')
    expect(composer.cursorColumn).toBe(6)
  })

  it('leaves typed text alone, since control bytes arrive as named keys', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'plain 标准' })
    expect(composer.value).toBe('plain 标准')
  })

  it('inserts a deliberate newline without sending', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'first' })
    expect(composer.handle({ kind: 'key', name: 'newline' })).toEqual({ kind: 'changed' })
    composer.handle({ kind: 'text', text: 'second' })
    expect(composer.lines).toEqual(['first', 'second'])
  })

  it('reports the cursor per logical line', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'ab\n标准' })
    expect(composer.cursorLine).toBe(1)
    expect(composer.cursorColumn).toBe(4)
    composer.handle({ kind: 'key', name: 'home' })
    expect(composer.cursorColumn).toBe(0)
  })

  it('passes application gestures through as ignored', () => {
    const composer = new Composer()
    for (const name of ['ctrl-c', 'ctrl-d', 'escape', 'tab', 'up'] as const) {
      expect(composer.handle({ kind: 'key', name })).toEqual({ kind: 'ignored', key: { kind: 'key', name } })
    }
  })
})

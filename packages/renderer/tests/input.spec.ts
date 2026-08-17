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
    // A modified key such as ctrl+enter would otherwise appear as "[27;5;13~".
    expect(decodeKeys('\u001b[27;5;13~')).toEqual([])
  })

  it('reports a lone trailing ESC as escape', () => {
    // Ambiguous by nature: waiting would make Escape indistinguishable from a
    // slow arrow key, and a spurious cancel is recoverable where a swallowed one
    // is not.
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

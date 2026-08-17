import { describe, expect, it } from 'vitest'
import { Composer, decodeKeys } from '../src/index.ts'

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

  it('reports a trailing lone ESC as escape', () => {
    expect(decodeKeys('\u001b')).toEqual([{ kind: 'key', name: 'escape' }])
    expect(decodeKeys('\u001b[')).toEqual([{ kind: 'key', name: 'escape' }])
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

  it('passes application gestures through as ignored', () => {
    const composer = new Composer()
    for (const name of ['ctrl-c', 'ctrl-d', 'escape', 'tab', 'up'] as const) {
      expect(composer.handle({ kind: 'key', name })).toEqual({ kind: 'ignored', key: { kind: 'key', name } })
    }
  })
})

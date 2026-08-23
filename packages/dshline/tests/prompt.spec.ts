/** The single-line text overlay: what it shows, and what it never shows. */

import { describe, expect, it } from 'vitest'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { createPromptOverlay } from '../src/prompt.ts'
import type { PromptKind } from '../src/prompt.ts'

/** Width of a comfortable terminal. */
const COLUMNS = 80

/** An overlay under test, plus what it settled with. */
interface Mounted {
  text(columns?: number): string
  press(...keys: Key[]): void
  readonly settled: () => { value: string | undefined } | undefined
}

/**
 * Mount a prompt.
 * @param kind - whether the field is masked.
 * @param extra - the optional presentation fields.
 * @returns the overlay and its settlement.
 */
function mount(kind: PromptKind, extra: { placeholder?: string; detail?: string } = {}): Mounted {
  let settled: { value: string | undefined } | undefined
  const overlay = createPromptOverlay({
    title: 'API key · openai',
    message: 'Paste the key OpenAI issued you.',
    kind,
    ...extra,
    settle: value => { settled = { value } },
    invalidate: () => {},
  })
  return {
    text: (columns = COLUMNS) => stripAnsi(overlay.render(columns).join('\n')),
    press: (...keys) => { for (const key of keys) overlay.handleKey(key) },
    settled: () => settled,
  }
}

describe('what a prompt shows', () => {
  it('shows the question, and the placeholder while the field is empty', () => {
    const view = mount('text', { placeholder: 'sk-…' })
    const shown = view.text()
    expect(shown).toContain('API key · openai')
    expect(shown).toContain('Paste the key OpenAI issued you.')
    expect(shown).toContain('sk-…')
  })

  it('masks a secret one glyph per character, so length is the only feedback', () => {
    // Length matters: a person typing into a field that shows nothing cannot
    // tell whether the keystrokes are arriving at all.
    const view = mount('secret')
    view.press({ kind: 'text', text: 'sk-abc' })
    const shown = view.text()
    expect(shown).toContain('••••••')
    expect(shown).not.toContain('sk-abc')
  })

  it('echoes a plain value, because a code is meant to be read back', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'WXYZ-1234' })
    expect(view.text()).toContain('WXYZ-1234')
  })

  it('never draws a row wider than the terminal', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'x'.repeat(400) })
    const overlay = createPromptOverlay({
      title: 'A title long enough to need cutting on a narrow frame',
      message: 'A message long enough to need cutting on a narrow frame as well',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    for (const line of [...overlay.render(40), ...view.text(40).split('\n')]) {
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(40)
    }
  })

  it('shows an escape sequence in the question instead of obeying it', () => {
    const overlay = createPromptOverlay({
      title: 'x',
      message: 'open \u001b[2Jthis',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    expect(stripAnsi(overlay.render(COLUMNS).join('\n'))).toContain('^[[2J')
  })
})

describe('editing', () => {
  it('deletes one character per press, code points included', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'a😀' }, { kind: 'key', name: 'backspace' })
    expect(view.text()).toContain('a')
    expect(view.text()).not.toContain('😀')
  })

  it('clears the line and the last word', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'one two' }, { kind: 'key', name: 'ctrl-w' })
    expect(view.text()).toContain('one')
    expect(view.text()).not.toContain('two')
    view.press({ kind: 'key', name: 'ctrl-u' })
    expect(view.text()).not.toContain('one')
  })

  it('drops only the line breaks a one-line field cannot hold', () => {
    // A copied terminal line arrives with a trailing newline; everything else is
    // taken verbatim. This overlay serves Harness's generic `text` and `secret`
    // prompts, where the spacing of a value may BE the value, so collapsing runs
    // of space or trimming the ends would be editing an answer it does not
    // understand. An API key is trimmed later, by `normalizeApiKey`.
    const view = mount('text')
    view.press({ kind: 'paste', text: '  sk  one\ntwo\n' })
    expect(view.text()).toContain('  sk  onetwo')
  })

  it('keeps the value exactly as typed, spaces included', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'two  spaces ' })
    view.press({ kind: 'key', name: 'enter' })
    expect(view.settled()).toEqual({ value: 'two  spaces ' })
  })
})

describe('a value longer than the field', () => {
  it('keeps the newest characters visible, not the oldest', () => {
    // The reason the field cuts at the front: a person watches what they are
    // typing, and hiding the tail hides exactly that.
    const view = mount('text')
    view.press({ kind: 'text', text: `${'a'.repeat(200)}TAIL` })
    const shown = view.text(40)
    expect(shown).toContain('TAIL')
    expect(shown).not.toContain('aaaaTAIL'.replace('TAIL', 'a'.repeat(200)))
  })

  it('keeps the cursor block at the end of a full field', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'z'.repeat(200) })
    expect(view.text(40)).toContain('z█')
  })

  it('shows the newest mask glyphs for a long secret', () => {
    const view = mount('secret')
    view.press({ kind: 'text', text: 'z'.repeat(200) })
    const row = view.text(40).split('\n').find(line => line.includes('•')) ?? ''
    expect(displayWidth(row)).toBeLessThanOrEqual(40)
    expect(row).toContain('•█')
  })
})

describe('settling', () => {
  it('answers with the typed value on enter', () => {
    const view = mount('secret')
    view.press({ kind: 'text', text: 'sk-1' }, { kind: 'key', name: 'enter' })
    expect(view.settled()).toEqual({ value: 'sk-1' })
  })

  it('answers with nothing on escape', () => {
    const view = mount('text')
    view.press({ kind: 'key', name: 'escape' })
    expect(view.settled()).toEqual({ value: undefined })
  })

  it('settles once, however many keys arrive before the unmount', () => {
    // The registry can deliver one more keystroke between the decision and the
    // unmount, and a second settlement would resolve a promise nobody holds.
    let calls = 0
    const overlay = createPromptOverlay({
      title: 'x',
      message: 'y',
      kind: 'text',
      settle: () => { calls += 1 },
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(calls).toBe(1)
  })
})

/**
 * The input line: a text buffer, a cursor, and the editing keys.
 *
 * Positions are measured in CODE POINTS, not UTF-16 units, so an astral
 * character (an emoji, a rare ideograph) is one cursor step rather than two
 * halves. Display columns are derived only when rendering.
 * @module @riesbri/dsh-tui-renderer/composer
 */

import type { Key } from './keys.ts'
import { displayWidth } from './width.ts'

/** What a keystroke did to the composer. */
export type ComposerAction =
  /** The buffer or cursor changed; the caller redraws. */
  | { kind: 'changed' }
  /** The user submitted `text`; the buffer is already cleared. */
  | { kind: 'submit'; text: string }
  /** The key is not the composer's; the caller decides (cancel, quit, …). */
  | { kind: 'ignored'; key: Key }

/** Non-word characters that bound a `ctrl-w` deletion. */
const WORD_BOUNDARY = /\s/u

/** An editable input line. */
export class Composer {
  /** Buffer contents as code points, so indices are cursor positions. */
  private chars: string[] = []
  /** Cursor position: the index the next insert lands at. */
  private at = 0

  /** Current buffer contents. */
  get value(): string {
    return this.chars.join('')
  }

  /** Whether the buffer holds nothing. */
  get isEmpty(): boolean {
    return this.chars.length === 0
  }

  /**
   * Zero-based logical line the cursor sits on. A buffer holds newlines once a
   * paste or a deliberate newline has been inserted.
   */
  get cursorLine(): number {
    let line = 0
    for (let index = 0; index < this.at; index += 1) {
      if (this.chars[index] === '\n') line += 1
    }
    return line
  }

  /** Display columns between the start of the cursor's own line and the cursor. */
  get cursorColumn(): number {
    let start = 0
    for (let index = 0; index < this.at; index += 1) {
      if (this.chars[index] === '\n') start = index + 1
    }
    return displayWidth(this.chars.slice(start, this.at).join(''))
  }

  /** The buffer's logical lines, split on newlines. */
  get lines(): string[] {
    return this.value.split('\n')
  }

  /** Discard the buffer and reset the cursor. */
  clear(): void {
    this.chars = []
    this.at = 0
  }

  /**
   * Replace the buffer, leaving the cursor at the end.
   * @param text - the new contents.
   */
  set(text: string): void {
    this.chars = [...text]
    this.at = this.chars.length
  }

  /**
   * Apply one keystroke.
   * @param key - the decoded keystroke.
   * @returns what the keystroke did.
   */
  handle(key: Key): ComposerAction {
    // Pasted content is literal, newlines included: a newline inside a paste is
    // part of the pasted document, not a request to send.
    if (key.kind === 'text' || key.kind === 'paste') {
      this.chars.splice(this.at, 0, ...key.text)
      this.at += [...key.text].length
      return { kind: 'changed' }
    }
    switch (key.name) {
      case 'enter': {
        const text = this.value
        // Submitting empty is the caller's business (it may mean "interrupt"),
        // so an empty buffer is reported as ignored rather than an empty submit.
        if (text === '') return { kind: 'ignored', key }
        this.clear()
        return { kind: 'submit', text }
      }
      case 'newline':
        this.chars.splice(this.at, 0, '\n')
        this.at += 1
        return { kind: 'changed' }
      case 'backspace':
        if (this.at === 0) return { kind: 'changed' }
        this.chars.splice(this.at - 1, 1)
        this.at -= 1
        return { kind: 'changed' }
      case 'delete':
        if (this.at >= this.chars.length) return { kind: 'changed' }
        this.chars.splice(this.at, 1)
        return { kind: 'changed' }
      case 'left':
        this.at = Math.max(0, this.at - 1)
        return { kind: 'changed' }
      case 'right':
        this.at = Math.min(this.chars.length, this.at + 1)
        return { kind: 'changed' }
      case 'home':
      case 'ctrl-a':
        this.at = 0
        return { kind: 'changed' }
      case 'end':
      case 'ctrl-e':
        this.at = this.chars.length
        return { kind: 'changed' }
      case 'ctrl-u':
        this.chars.splice(0, this.at)
        this.at = 0
        return { kind: 'changed' }
      case 'ctrl-k':
        this.chars.splice(this.at)
        return { kind: 'changed' }
      case 'ctrl-w': {
        let cut = this.at
        while (cut > 0 && WORD_BOUNDARY.test(this.chars[cut - 1] ?? '')) cut -= 1
        while (cut > 0 && !WORD_BOUNDARY.test(this.chars[cut - 1] ?? '')) cut -= 1
        this.chars.splice(cut, this.at - cut)
        this.at = cut
        return { kind: 'changed' }
      }
      default:
        // `ctrl-c`, `ctrl-d`, `ctrl-l`, `escape`, `tab`, and the vertical arrows
        // are application gestures (cancel, quit, history, completion), not edits.
        return { kind: 'ignored', key }
    }
  }
}

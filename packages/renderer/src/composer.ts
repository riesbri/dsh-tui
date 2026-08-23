/**
 * The input line: a text buffer, a cursor, and the editing keys.
 *
 * Positions are measured in CODE POINTS, not UTF-16 units, so an astral
 * character (an emoji, a rare ideograph) is one cursor step rather than two
 * halves. Display columns are derived only when rendering.
 * @module dshline-renderer/composer
 */

import type { Key } from './keys.ts'
import { layoutComposer } from './composer-layout.ts'
import { sanitizePasted } from './text.ts'
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
  /**
   * The display column vertical movement keeps aiming at while the user holds
   * `↑`/`↓`, or undefined when no vertical sequence is in progress.
   *
   * Captured from the row the first vertical move leaves, so moving down past a
   * short line and back up returns near the original column rather than the
   * short line's end. Cleared by any non-vertical edit.
   */
  private preferredColumn: number | undefined

  /** Current buffer contents. */
  get value(): string {
    return this.chars.join('')
  }

  /** The cursor's absolute position in the buffer, in code points. */
  get position(): number {
    return this.at
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

  /**
   * The cursor's own line, up to the cursor.
   *
   * Offered instead of an index because the two obvious indices are both wrong to
   * slice with: {@link cursorColumn} counts DISPLAY columns, so using it as a
   * string index overshoots by one position per wide character, and a UTF-16 index
   * splits an astral character in half. This is the text, already correct.
   */
  get lineBeforeCursor(): string {
    let start = 0
    for (let index = 0; index < this.at; index += 1) {
      if (this.chars[index] === '\n') start = index + 1
    }
    return this.chars.slice(start, this.at).join('')
  }

  /**
   * Replace the characters immediately before the cursor.
   *
   * What accepting a completion does: the typed token is behind the cursor and the
   * chosen text takes its place. Counted in code points, the unit the buffer is
   * stored in, so a wide or astral character counts once.
   *
   * Sanitized on the way in, exactly as a paste is, because the buffer's invariant
   * is that everything in it is safe to draw — the composer view hands its lines to
   * the screen without escaping them again. A completion is untrusted for the same
   * reason a paste is: a file name can contain anything a filesystem permits, so
   * without this, accepting a candidate could put an escape sequence into the
   * terminal that the list had shown safely escaped.
   * @param count - how many code points before the cursor to remove.
   * @param text - what to put in their place.
   */
  replaceBeforeCursor(count: number, text: string): void {
    this.resetVerticalMovement()
    const removed = Math.min(Math.max(count, 0), this.at)
    const inserted = [...sanitizePasted(text)]
    this.chars.splice(this.at - removed, removed, ...inserted)
    this.at += inserted.length - removed
  }

  /** Discard the buffer and reset the cursor. */
  clear(): void {
    this.resetVerticalMovement()
    this.chars = []
    this.at = 0
  }

  /**
   * Move the cursor one visual row up in the wrapped buffer.
   *
   * Movement is governed by the same layout the cursor is drawn from, so `↑`
   * lands on the visual row above at the column the user has been aiming at. If
   * the cursor is already on the topmost row there is nothing to move to, and
   * the caller routes the arrow to history instead.
   * @param width - display-column budget per visual row, as the view draws at.
   * @param gutter - the gutter for each logical line, matching the view's.
   * @returns whether the cursor moved.
   */
  moveUp(width: number, gutter: (line: number) => string): boolean {
    return this.moveVertically(-1, width, gutter)
  }

  /**
   * Move the cursor one visual row down in the wrapped buffer.
   *
   * The mirror of {@link moveUp}; a cursor already on the bottom row reports no
   * movement so the caller does not reach for newer history.
   * @param width - display-column budget per visual row.
   * @param gutter - the gutter for each logical line.
   * @returns whether the cursor moved.
   */
  moveDown(width: number, gutter: (line: number) => string): boolean {
    return this.moveVertically(1, width, gutter)
  }

  /** End any in-progress vertical column preference. */
  private resetVerticalMovement(): void {
    this.preferredColumn = undefined
  }

  /**
   * Step the cursor one visual row along `direction`, near the preferred column.
   *
   * The preferred column is captured from the row this sequence leaves on its
   * first step, so a short middle row never permanently destroys the horizontal
   * position the user was aiming at. Clamped to the buffer: aiming past a wrap
   * boundary or the end of a short row yields that row's own end.
   * @param direction - -1 moves up, +1 moves down.
   * @param width - display-column budget per visual row.
   * @param gutter - the gutter for each logical line.
   * @returns whether the cursor actually moved.
   */
  private moveVertically(direction: 1 | -1, width: number, gutter: (line: number) => string): boolean {
    const layout = layoutComposer(this, width, gutter)
    const targetRow = layout.cursorRow + direction
    if (targetRow < 0 || targetRow >= layout.rows.length) return false
    this.preferredColumn = this.preferredColumn ?? layout.cursorColumn
    const offset = layout.positionAt(targetRow, this.preferredColumn)
    if (offset === this.at) return false
    this.at = offset
    return true
  }

  /**
   * Replace the buffer, leaving the cursor at the end.
   * @param text - the new contents.
   */
  set(text: string): void {
    this.resetVerticalMovement()
    this.chars = [...text]
    this.at = this.chars.length
  }

  /**
   * Apply one keystroke.
   * @param key - the decoded keystroke.
   * @returns what the keystroke did.
   */
  handle(key: Key): ComposerAction {
    // Any edit ends an in-progress vertical sequence; only `moveUp`/`moveDown`
    // (which the input router calls directly) continue one.
    this.resetVerticalMovement()
    // Pasted newlines are content, not a request to send — but pasted CONTROLS
    // are neither. They are sanitized on the way in so the buffer holds one
    // representation: anything else would leave every later width, cursor, and
    // draw calculation reading different text than the terminal receives.
    if (key.kind === 'text' || key.kind === 'paste') {
      const text = key.kind === 'paste' ? sanitizePasted(key.text) : key.text
      this.chars.splice(this.at, 0, ...text)
      this.at += [...text].length
      return { kind: 'changed' }
    }
    switch (key.name) {
      case 'enter': {
        const text = this.value
        // Submitting empty is the caller's business (it may mean "interrupt"),
        // so an empty buffer is reported as ignored rather than an empty submit.
        if (text === '') return { kind: 'ignored', key }
        // Spaces and pasted blank lines are not a model message. Clear them as an
        // edit so the caller redraws instead of dispatching an empty turn.
        if (text.trim() === '') {
          this.clear()
          return { kind: 'changed' }
        }
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

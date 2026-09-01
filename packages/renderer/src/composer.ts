/**
 * The input line: a text buffer, a cursor, and the editing keys.
 *
 * Positions are measured in CODE POINTS, not UTF-16 units, so an astral
 * character (an emoji, a rare ideograph) is one cursor step rather than two
 * halves. Display columns are derived only when rendering.
 *
 * Undo/redo live here, on the unsent draft, and nowhere else: a submitted
 * prompt belongs to history, and {@link Composer.set} — the one path history
 * recall uses — starts a fresh baseline that `ctrl-z` can never cross. The
 * buffer stays safe to draw because every untrusted text that enters goes
 * through sanitization before it reaches the mutation primitive.
 * @module @dshline/renderer/composer
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

/**
 * How many prior edit states `ctrl-z` may walk back through.
 *
 * A fixed cap keeps the retained tail bounded whatever the prompt size:
 * beyond it the oldest steps simply stop being reachable. Fifty is a generous
 * session of edits. Fixed and tested rather than configurable, because no
 * setting is worth the surface for one.
 */
const MAX_UNDO_SNAPSHOTS = 50

/**
 * Total code points both undo stacks may retain across all their snapshots,
 * ONE snapshot excepted.
 *
 * The count cap alone is not enough: fifty snapshots of a huge pasted document
 * would keep megabytes of the terminal's own memory alive for a draft. A large
 * buffer therefore keeps only its MOST RECENT edits undoable once the budget is
 * spent, which is the part a reader actually wants back. The exception is the
 * newest snapshot, which survives even when it alone exceeds the budget — the
 * edit a reader just made is always undoable — and its presence is what keeps
 * the whole thing bounded: two such snapshots never coexist, because pushing
 * the second one drops the first. 100_000 code points is roughly the size of a
 * long document.
 */
const MAX_UNDO_CHARS = 100_000

/** One restorable point in a draft's editing history. */
interface ComposerSnapshot {
  /** The buffer contents as displayable text. */
  readonly text: string
  /** The cursor's code-point position, the position the edit began at. */
  readonly position: number
}

/**
 * What kind of edit is being recorded, so consecutive edits of the SAME kind
 * can join into one undo step while anything else stays a hard boundary.
 * `typing` covers ordinary keystrokes; `paste`, `newline`, `kill` (ctrl-w/u/k),
 * and `completion` always start a fresh step even when one of their own
 * immediately follows.
 */
type EditKind = 'typing' | 'paste' | 'newline' | 'backspace' | 'delete' | 'kill' | 'completion'

/**
 * Edit kinds whose consecutive occurrences join into ONE undo step.
 *
 * Only the three key-driven runs behave this way: held keystrokes repeat, so a
 * held backspace deleting a whole word should be one undo, exactly as the five
 * `text` chunks a decoder may split one typed word into are. Anything else is a
 * deliberate gesture that must stay individually undoable.
 */
const COALESCING_EDITS: ReadonlySet<EditKind> = new Set(['typing', 'backspace', 'delete'])

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
  /** States before each undoable edit, newest on top; `ctrl-z` walks these. */
  private undoStack: ComposerSnapshot[] = []
  /** States undone but not yet edited over, newest on top; `ctrl-y` walks these. */
  private redoStack: ComposerSnapshot[] = []
  /**
   * The kind of the last edit, deciding whether the next one joins it as one
   * undo step. Cleared by everything that is not an edit, so a move, a
   * baseline `set()`, an undo, or a submission always starts a fresh step.
   */
  private lastEdit: EditKind | undefined

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
    const removed = Math.min(Math.max(count, 0), this.at)
    this.replaceRange(this.at - removed, this.at, sanitizePasted(text), 'completion')
  }

  /**
   * Discard the buffer and reset the cursor.
   *
   * A baseline like {@link set}: the draft is being thrown away — a submitted
   * line, or a whitespace-only enter — so there is no state left to undo to,
   * and every stack starts empty. This is what makes a sent prompt unreachable
   * through `ctrl-z`.
   */
  clear(): void {
    this.lastEdit = undefined
    this.undoStack = []
    this.redoStack = []
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
    // Movement ends any typing run in progress — including a move that could
    // not go anywhere, because the press itself is still a deliberate gesture:
    // a character typed after an arrow is a fresh edit, never part of the run
    // that typed the text it is inserted among.
    this.lastEdit = undefined
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
    // A baseline, not an edit: history recall, draft restoration, and the
    // skills picker all route here, and none of them may be walked back with
    // `ctrl-z`. History owns history, so the stacks start empty and the next
    // undo step is the first edit made ON TOP of this text.
    this.lastEdit = undefined
    this.undoStack = []
    this.redoStack = []
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
      const paste = key.kind === 'paste'
      this.replaceRange(this.at, this.at, paste ? sanitizePasted(key.text) : key.text, paste ? 'paste' : 'typing')
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
        this.replaceRange(this.at, this.at, '\n', 'newline')
        return { kind: 'changed' }
      case 'backspace':
        if (this.at === 0) {
          // Nothing deleted, but the press is still a gesture: the next
          // character typed starts a fresh undo step, not a continuation.
          this.lastEdit = undefined
          return { kind: 'changed' }
        }
        this.replaceRange(this.at - 1, this.at, '', 'backspace')
        return { kind: 'changed' }
      case 'delete':
        if (this.at >= this.chars.length) {
          this.lastEdit = undefined
          return { kind: 'changed' }
        }
        this.replaceRange(this.at, this.at + 1, '', 'delete')
        return { kind: 'changed' }
      case 'ctrl-z':
        this.undo()
        return { kind: 'changed' }
      case 'ctrl-y':
        this.redo()
        return { kind: 'changed' }
      case 'left':
        this.at = Math.max(0, this.at - 1)
        this.lastEdit = undefined
        return { kind: 'changed' }
      case 'right':
        this.at = Math.min(this.chars.length, this.at + 1)
        this.lastEdit = undefined
        return { kind: 'changed' }
      case 'home':
      case 'ctrl-a':
        this.at = 0
        this.lastEdit = undefined
        return { kind: 'changed' }
      case 'end':
      case 'ctrl-e':
        this.at = this.chars.length
        this.lastEdit = undefined
        return { kind: 'changed' }
      case 'ctrl-u':
        this.replaceRange(0, this.at, '', 'kill')
        return { kind: 'changed' }
      case 'ctrl-k':
        this.replaceRange(this.at, this.chars.length, '', 'kill')
        return { kind: 'changed' }
      case 'ctrl-w': {
        let cut = this.at
        while (cut > 0 && WORD_BOUNDARY.test(this.chars[cut - 1] ?? '')) cut -= 1
        while (cut > 0 && !WORD_BOUNDARY.test(this.chars[cut - 1] ?? '')) cut -= 1
        this.replaceRange(cut, this.at, '', 'kill')
        return { kind: 'changed' }
      }
      default:
        // `ctrl-c`, `ctrl-d`, `ctrl-l`, `escape`, `tab`, and the vertical arrows
        // are application gestures (cancel, quit, history, completion), not
        // edits — but each is still a deliberate gesture, so a typing run ends
        // where one of them was pressed.
        this.lastEdit = undefined
        return { kind: 'ignored', key }
    }
  }

  /** The current state, exactly as an undo step should restore it. */
  private snapshot(): ComposerSnapshot {
    return { text: this.value, position: this.at }
  }

  /**
   * Put one recorded state back on the buffer.
   *
   * The restored cursor belongs to that snapshot, so `ctrl-z` returns the
   * cursor to where it was immediately before the undone edit began. Undoing
   * and redoing also end any typing run and any vertical sequence: they are
   * fresh states, not continuations.
   * @param snapshot - the state to restore.
   */
  private restore(snapshot: ComposerSnapshot): void {
    this.chars = [...snapshot.text]
    this.at = snapshot.position
    this.lastEdit = undefined
    this.resetVerticalMovement()
  }

  /**
   * Record one edit, joining it with the previous one when they are the same
   * coalescing kind.
   *
   * The snapshot pushed is the state BEFORE the edit — value and cursor — so
   * `ctrl-z` restores exactly the moment the edit began. A coalescing edit only
   * extends the run on top of the stack, keeping one undo step per run no
   * matter how many decoder chunks or held keystrokes the run took.
   * @param stack - which history the snapshot belongs to (undo or redo).
   * @param snapshot - the state to record, always the pre-edit state.
   */
  private pushSnapshot(stack: ComposerSnapshot[], snapshot: ComposerSnapshot): void {
    stack.push(snapshot)
    this.trimHistory()
  }

  /**
   * Keep the retained history inside both bounds, over the TWO stacks together.
   *
   * Undoing a long run of edits does not free the older snapshots — it moves
   * them from the undo stack into the redo stack, and the state being abandoned
   * is pushed alongside them — so a cap applied to one stack at a time lets the
   * pair hold nearly twice the budget once a reader has undone part of a large
   * draft. The oldest snapshot is the oldest entry of whichever stack holds it,
   * the undo stack when both do: what was just undone is the part a reader is
   * most likely to want back next, so it is the last thing surrendered.
   */
  private trimHistory(): void {
    while (this.undoStack.length + this.redoStack.length > MAX_UNDO_SNAPSHOTS) this.dropOldest()
    let chars = this.retainedChars(this.undoStack) + this.retainedChars(this.redoStack)
    while (chars > MAX_UNDO_CHARS && this.undoStack.length + this.redoStack.length > 1) {
      const dropped = this.dropOldest()
      if (dropped !== undefined) chars -= [...dropped.text].length
    }
  }

  /** The oldest snapshot of the two stacks, preferring the undo stack. */
  private dropOldest(): ComposerSnapshot | undefined {
    if (this.undoStack.length > 0) return this.undoStack.shift()
    return this.redoStack.shift()
  }

  /** Code points one stack's snapshots retain. */
  private retainedChars(stack: ComposerSnapshot[]): number {
    return stack.reduce((sum, entry) => sum + [...entry.text].length, 0)
  }

  /**
   * The one mutation primitive every undoable edit funnels through.
   *
   * All edits share the same bookkeeping — the undo snapshot, the redo
   * invalidation, the coalescing decision, the vertical-movement reset, and the
   * invariant that the buffer positions stay inside the buffer — so a new
   * editing source (completion today, others later) gets the same safety by
   * using this route, and none of the rules can drift.
   *
   * Text arrives here already sanitized or already safe: typed text cannot
   * carry control bytes (the decoder delivers them as named keys), and the two
   * untrusted entry points — paste and completion — sanitize before calling.
   * @param start - first buffer position to replace, in code points.
   * @param end - one past the last position to replace, in code points.
   * @param replacement - the safe text to put in their place.
   * @param kind - what edit this is, deciding coalescing and the undo step.
   */
  private replaceRange(start: number, end: number, replacement: string, kind: EditKind): void {
    // Clamp to the buffer, so the buffer-safety invariant holds whatever the
    // caller computed: 0 <= at <= code-point count, after every edit.
    const from = Math.max(0, Math.min(start, this.chars.length))
    const to = Math.max(from, Math.min(end, this.chars.length))
    const inserted = [...replacement]
    if (from === to && inserted.length === 0) {
      // Nothing changed — a `ctrl-k` pressed at the end of the line, say. No
      // state is recorded, but the gesture still ends a typing run, exactly as
      // an empty backspace does.
      this.lastEdit = undefined
      return
    }
    if (!COALESCING_EDITS.has(kind) || this.lastEdit !== kind) {
      // A fresh edit makes every undone state unreachable, exactly as a new
      // branch does in an editor: only a new `ctrl-y` after another `ctrl-z`
      // can revisit them. The undone states are discarded BEFORE the new step
      // is recorded, so the step a reader is creating cannot be trimmed away by
      // the history bounds those states still occupy. Joined edits skip this:
      // their run's pre-state is already on top of the stack, and nothing has
      // been undone since.
      this.redoStack = []
      this.pushSnapshot(this.undoStack, this.snapshot())
    }
    this.lastEdit = kind
    this.resetVerticalMovement()
    // Reassembled with array-literal spreads rather than `splice(from, n,
    // ...inserted)`: spreading into a CALL is limited by the engine's argument
    // count, so a single very large edit — a whole pasted document, a future
    // editor result — would throw where these two arrays compose fine.
    this.chars = [...this.chars.slice(0, from), ...inserted, ...this.chars.slice(to)]
    this.at = from + inserted.length
  }

  /** Step back to the state before the most recent undoable edit. */
  private undo(): void {
    // A press is a boundary even when there is nothing to undo: the next
    // character typed starts a fresh undo step, never a continuation.
    this.lastEdit = undefined
    const previous = this.undoStack.pop()
    if (previous === undefined) return
    this.pushSnapshot(this.redoStack, this.snapshot())
    this.restore(previous)
  }

  /** Step forward to the state most recently undone, if nothing has been edited since. */
  private redo(): void {
    // A press is a boundary even when there is nothing to redo.
    this.lastEdit = undefined
    const next = this.redoStack.pop()
    if (next === undefined) return
    this.pushSnapshot(this.undoStack, this.snapshot())
    this.restore(next)
  }
}

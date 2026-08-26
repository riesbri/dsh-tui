/**
 * Append-and-live-region screen.
 *
 * A chat transcript only ever grows, so this renderer does not own a
 * full-screen viewport: finished output is written straight into the terminal's
 * own scroll buffer and never touched again, and only a bottom LIVE REGION —
 * the streaming reply, a prompt, the composer — is redrawn in place. Native
 * scrollback, mouse selection, and copy therefore keep working, and the
 * renderer never has to model scroll position or reflow history on resize.
 *
 * The cost is the rule that makes it correct: the live region must be the last
 * thing on screen, so every write goes through this class.
 * @module @dshline/renderer/screen
 */

import { wrapToWidth } from './width.ts'

/** Cursor placement inside the live region, in rendered rows and columns. */
export interface LiveCursor {
  /** Zero-based row within the live region. */
  row: number
  /** Zero-based column within that row, in display columns. */
  column: number
}

/** The terminal facts and sink a screen needs; a test supplies fakes. */
export interface ScreenTarget {
  /** Write raw bytes, escape sequences included. */
  write(chunk: string): void
  /** Current terminal width in columns. */
  columns(): number
}

/** Control Sequence Introducer. */
const CSI = '\u001b['

/** One CSI sequence with a numeric parameter, or nothing when `count` is zero. */
function csi(count: number, final: string): string {
  return count > 0 ? `${CSI}${String(count)}${final}` : ''
}

const HIDE_CURSOR = `${CSI}?25l`
const SHOW_CURSOR = `${CSI}?25h`
const BEGIN_SYNC = `${CSI}?2026h`
const END_SYNC = `${CSI}?2026l`
const CLEAR_BELOW = `${CSI}0J`
const CLEAR_LINE = `${CSI}0K`

/**
 * Owns the boundary between committed scrollback and the redrawn live region.
 */
export class Screen {
  /** Rendered rows currently occupied by the live region. */
  private liveRows: readonly string[] = []
  /** Cursor placement requested for the current live region. */
  private cursor: LiveCursor | undefined
  /**
   * Whether the terminal is believed to hold exactly the last written frame.
   * False before the first draw, and after anything moved the pixels behind
   * this class's back — which is the one thing the identical-frame skip may
   * not survive.
   */
  private current = false

  constructor(private readonly target: ScreenTarget) {}

  /** Rows the live region currently occupies, for tests and resize math. */
  get height(): number {
    return this.liveRows.length
  }

  /**
   * Record that the screen may no longer match the last written frame.
   *
   * Two things change it from outside: a resize reflows whatever the terminal
   * pleases, and a display clear wipes every pixel directly. The next redraw
   * after this writes in full — erase included — and marks the frame current
   * again. The cached geometry is deliberately KEPT rather than discarded: the
   * erase has to climb the region as it was drawn, so "stale" means the pixels
   * are doubtful, never that the model is.
   */
  markStale(): void {
    this.current = false
  }

  /**
   * Erase the live region, leaving the cursor at its first row, first column.
   * Committed scrollback above is untouched.
   * @returns the escape sequence that performs the erase.
   */
  private eraseLive(): string {
    if (this.liveRows.length === 0) return '\r'
    // The cursor sits wherever the last placement left it, so descend to the
    // BOTTOM row first and climb from there; climbing from the current row
    // would overshoot whenever a cursor was placed mid-region.
    const bottom = this.liveRows.length - 1
    const fromBottom = bottom - (this.cursor?.row ?? bottom)
    return `${csi(fromBottom, 'B')}\r${csi(bottom, 'A')}${CLEAR_BELOW}`
  }

  /**
   * Draw `rows` and place the cursor, assuming the live region is already erased
   * and the cursor sits at the region's first column.
   * @param rows - pre-wrapped rows to draw.
   * @param cursor - requested placement, clamped into the drawn region.
   * @returns the escape sequence that draws and positions.
   */
  private drawLive(rows: readonly string[], cursor: LiveCursor | undefined): string {
    if (rows.length === 0) return ''
    let out = rows.map(row => `${CLEAR_LINE}${row}`).join('\r\n')
    if (cursor === undefined) return out
    const row = Math.min(Math.max(cursor.row, 0), rows.length - 1)
    out += csi(rows.length - 1 - row, 'A')
    out += '\r'
    out += csi(Math.max(cursor.column, 0), 'C')
    return out
  }

  /**
   * Whether `rows` and `cursor` describe exactly what is on screen right now.
   * @param rows - wrapped rows a redraw would draw.
   * @param cursor - cursor placement that redraw would use.
   * @returns true when writing them would change nothing visible.
   */
  private showsFrame(rows: readonly string[], cursor: LiveCursor | undefined): boolean {
    if (this.liveRows.length !== rows.length) return false
    for (let index = 0; index < rows.length; index += 1) {
      if (this.liveRows[index] !== rows[index]) return false
    }
    if (this.cursor === undefined || cursor === undefined) return this.cursor === cursor
    return this.cursor.row === cursor.row && this.cursor.column === cursor.column
  }

  /**
   * Replace the live region.
   *
   * A frame identical to the one already on screen writes nothing. Bursts of
   * session events ask the screen the same question several times per tick —
   * change feeds invalidating together, a redraw after a commit that moved
   * nothing — and the live region is the most-rewritten bytes in the process.
   * The comparison runs on the WRAPPED rows, not the logical lines: wrapping is
   * part of what a reader sees, so a resize that leaves the lines alone but
   * moves their rows still redraws, and one that changes nothing costs nothing.
   *
   * The skip trusts the cache only while it is clean — {@link markStale} and
   * the first draw both start from distrust — which keeps the startup sequence
   * intact: the first composition of an empty region is where the cursor gets
   * hidden, and several empty compositions happen before any real frame exists.
   * @param lines - logical lines; each is wrapped to the terminal width so one
   *   rendered row is one array entry and the redraw arithmetic stays exact.
   * @param cursor - where to leave the terminal cursor; omitted leaves it at the
   *   end of the region and hidden.
   */
  setLive(lines: readonly string[], cursor?: LiveCursor): void {
    const rows = this.wrap(lines)
    if (this.current && this.showsFrame(rows, cursor)) return
    const tail = cursor === undefined ? '' : SHOW_CURSOR
    this.target.write(`${BEGIN_SYNC}${HIDE_CURSOR}${this.eraseLive()}${this.drawLive(rows, cursor)}${tail}${END_SYNC}`)
    this.liveRows = rows
    this.cursor = cursor
    this.current = true
  }

  /**
   * Write `lines` permanently above the live region, then redraw the region
   * beneath them. Committed lines enter the terminal's scroll buffer and are
   * never rewritten, so they may exceed the screen height freely.
   * @param lines - logical lines to commit; wrapped to the terminal width.
   */
  commit(lines: readonly string[]): void {
    if (lines.length === 0) return
    const committed = this.wrap(lines).map(row => `${CLEAR_LINE}${row}`).join('\r\n')
    const live = this.liveRows
    const cursor = this.cursor
    const tail = cursor === undefined ? '' : SHOW_CURSOR
    const erase = this.eraseLive()
    // The region is gone once the erase is written, so the redraw that follows
    // must not consult `liveRows` — it is passed the saved rows instead.
    this.liveRows = []
    this.cursor = undefined
    this.target.write(`${BEGIN_SYNC}${HIDE_CURSOR}${erase}${committed}\r\n${this.drawLive(live, cursor)}${tail}${END_SYNC}`)
    this.liveRows = live
    this.cursor = cursor
  }

  /**
   * Erase the live region and restore the cursor, for teardown. Committed
   * scrollback is left in place so the session transcript survives exit.
   */
  close(): void {
    this.target.write(`${this.eraseLive()}${SHOW_CURSOR}`)
    this.liveRows = []
    this.cursor = undefined
    this.current = false
  }

  /**
   * Wrap logical lines to the terminal's current width.
   * @param lines - logical lines.
   * @returns one entry per rendered row.
   */
  private wrap(lines: readonly string[]): readonly string[] {
    const columns = Math.max(1, this.target.columns())
    return lines.flatMap(line => wrapToWidth(line, columns))
  }
}

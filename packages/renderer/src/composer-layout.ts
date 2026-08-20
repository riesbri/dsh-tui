/**
 * The visual layout of a composer's wrapped buffer.
 *
 * The cursor is drawn AND moved through the same rows, so the two must agree on
 * what a visual row is. Keeping the layout here — rather than letting the TUI
 * re-derive it — is what makes `↑`/`↓` land where the cursor was drawn: the one
 * code that decides placement is the one code that decides movement. Text wraps
 * by display width, not by word boundary, which is the same chunking the
 * composer's rendering uses and the property that lets a prefix be located.
 * @module @riesbri/dsh-tui-renderer/composer-layout
 */

import type { Composer } from './composer.ts'
import { codePointWidth, displayWidth } from './width.ts'

/** One visual row: its text, and where its text begins in the buffer. */
interface RowChunk {
  /** The rendered row, gutter included on the logical line's first row. */
  readonly row: string
  /** Buffer offset (code points) of this row's first text character. */
  readonly start: number
  /** Code points of the gutter at the start of this row (0 on wrapped rows). */
  readonly gutterChars: number
}

/**
 * Visual rows of one logical line, chunked at `width`.
 *
 * The gutter is prepended only to the first row and the wrapped continuation
 * rows continue flush, which is exactly how `chunkToWidth` renders them — a
 * deliberate re-use of the same break rule rather than a second wrapping
 * algorithm. `start` is what lets a caller map a row back to a buffer offset.
 * @param line - the logical line's text, without newlines.
 * @param gutter - the line's leading gutter (prompt for the first, indent after).
 * @param width - display-column budget per visual row.
 * @returns the rows, each with its buffer start and gutter count.
 */
function chunkLine(line: string, gutter: string, width: number): RowChunk[] {
  const budget = Math.max(1, width)
  const out: RowChunk[] = []
  let row = gutter
  let used = displayWidth(gutter)
  let start = 0
  let gutterChars = [...gutter].length
  let textPos = 0
  for (const char of line) {
    const charWidth = codePointWidth(char.codePointAt(0) ?? 0)
    if (used + charWidth > budget) {
      out.push({ row, start, gutterChars })
      row = ''
      used = 0
      start = textPos
      gutterChars = 0
    }
    row += char
    used += charWidth
    textPos += 1
  }
  out.push({ row, start, gutterChars })
  return out
}

/**
 * The laid-out composer: its rows, the cursor's row and column, and a way to
 * turn a row/column placement into a buffer offset.
 */
export interface ComposerLayout {
  /** Every visual row with its gutter, in draw order. */
  readonly rows: readonly string[]
  /** The visual row the cursor sits on. */
  readonly cursorRow: number
  /**
   * The cursor's display column within its row, including any gutter, which is
   * the value the renderer adds its own border offset to.
   */
  readonly cursorColumn: number
  /**
   * Absolute buffer offset (code points) for a placement on a visual `row` near
   * a display `column`. The row is clamped to the layout; moving to the end of a
   * row yields the start of the next row's text, and an out-of-range column
   * yields the row's own end.
   * @param row - the target visual row, clamped to a real row.
   * @param column - the display column to aim at, measured as {@link cursorColumn} is.
   * @returns the buffer offset to set the cursor to.
   */
  positionAt(row: number, column: number): number
}

/**
 * Lay out a composer's buffer into visual rows.
 *
 * The cursor's row is derived from a chunk of the text BEFORE it alone, which is
 * prefix-consistent: the rows of a prefix are the first rows of the finished
 * line, so the cursor lands where the same text drawn in place would put it.
 * @param composer - the buffer being edited.
 * @param width - display-column budget per visual row, including the gutter.
 * @param gutter - the gutter for a logical line, styled by which line it is.
 * @returns the layout, ready to draw or to move through.
 */
export function layoutComposer(
  composer: Composer,
  width: number,
  gutter: (line: number) => string,
): ComposerLayout {
  const chunks: RowChunk[] = []
  let cursorRow = 0
  let cursorColumn = 0
  // Buffer offset (in code points) of the start of the line currently being laid
  // out. Each line's chunks carry offsets relative to that line, so the absolute
  // offset is added here — without it, movement into a later line aimed at the
  // wrong part of the buffer.
  let lineStart = 0
  composer.lines.forEach((line, lineIndex) => {
    const lineGutter = gutter(lineIndex)
    const lineChunks = chunkLine(line, lineGutter, width)
    if (lineIndex === composer.cursorLine) {
      const prefix = chunkLine(composer.lineBeforeCursor, lineGutter, width)
      const last = prefix.at(-1)
      cursorRow = chunks.length + prefix.length - 1
      cursorColumn = last === undefined ? displayWidth(lineGutter) : displayWidth(last.row)
      // A prefix that exactly fills its row leaves the cursor one column past the
      // last cell, which would sit on the frame's border. It belongs at the start
      // of the next row, as it would in any editor.
      if (cursorColumn >= width) {
        cursorRow += 1
        cursorColumn = 0
      }
    }
    for (const chunk of lineChunks) {
      chunks.push({ ...chunk, start: lineStart + chunk.start })
    }
    lineStart += [...line].length
    if (lineIndex < composer.lines.length - 1) lineStart += 1 // the newline
  })
  // A cursor that rolled past the last row needs a row to sit on, or placement
  // arithmetic has nothing to clamp to. An editor shows the same empty row.
  if (cursorRow >= chunks.length) {
    chunks.push({ row: '', start: composer.position, gutterChars: 0 })
  }
  return {
    get rows() {
      return chunks.map(chunk => chunk.row)
    },
    cursorRow,
    cursorColumn,
    positionAt(row, column) {
      const targetRow = Math.max(0, Math.min(row, chunks.length - 1))
      const chunk = chunks[targetRow] ?? { row: '', start: composer.position, gutterChars: 0 }
      let used = 0
      let index = 0
      for (const char of chunk.row) {
        const charWidth = codePointWidth(char.codePointAt(0) ?? 0)
        if (used + charWidth > column) break
        used += charWidth
        index += 1
      }
      return chunk.start + Math.max(0, index - chunk.gutterChars)
    },
  }
}

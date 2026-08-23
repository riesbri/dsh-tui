/**
 * Box drawing and content fitting.
 *
 * Every edge here is measured in display columns rather than string length, so a
 * CJK or emoji line inside a frame does not push its right border out of
 * alignment — the failure that makes a hand-rolled terminal UI look broken.
 * @module @dshline/renderer/box
 */

import { displayWidth, truncateToWidth, wrapToWidth } from './width.ts'

/** Rounded single-line box characters. */
const GLYPH = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
} as const

/** Columns consumed by the left and right border plus one space of padding each. */
export const BOX_CHROME_COLUMNS = 4

/** How a box is drawn. */
export interface BoxOptions {
  /** Total width including borders. */
  width: number
  /** Label written into the top border, omitted for a plain frame. */
  title?: string
  /** Applied to the border characters; identity when omitted. */
  border?: (text: string) => string
}

/**
 * Pad or truncate one line to exactly `columns` display columns.
 * @param line - the content, which may carry styling.
 * @param columns - the exact target width.
 * @returns the fitted line.
 */
export function fitToWidth(line: string, columns: number): string {
  const width = displayWidth(line)
  if (width === columns) return line
  if (width < columns) return line + ' '.repeat(columns - width)
  // Truncation must not cut inside an escape sequence, so unstyled content is
  // the only thing a caller should hand to a fixed-width slot.
  const cut = truncateToWidth(line, columns)
  // A two-column character straddling the boundary is dropped whole, leaving the
  // result a column short — pad it back, or every box holding CJK draws its right
  // border one column left of the others.
  return cut + ' '.repeat(Math.max(0, columns - displayWidth(cut)))
}

/**
 * Frame `content` in a rounded box.
 *
 * Content longer than the inner width wraps rather than being clipped, because
 * the composer is the main consumer and losing typed text off the right edge is
 * worse than growing the box by a row.
 * @param content - logical content lines.
 * @param options - width, optional title, optional border styling.
 * @returns the box as rendered lines, borders included.
 */
export function box(content: readonly string[], options: BoxOptions): string[] {
  const width = Math.max(BOX_CHROME_COLUMNS + 1, options.width)
  const inner = width - BOX_CHROME_COLUMNS
  const paint = options.border ?? ((text: string) => text)
  const title = options.title === undefined || options.title === ''
    ? ''
    : ` ${truncateToWidth(options.title, Math.max(0, inner - 2))} `
  const topFill = Math.max(0, width - 2 - displayWidth(title))
  const lines = [paint(`${GLYPH.topLeft}${GLYPH.horizontal}${title}${GLYPH.horizontal.repeat(Math.max(0, topFill - 1))}${GLYPH.topRight}`)]
  const rows = content.length === 0 ? [''] : content.flatMap(line => wrapToWidth(line, inner))
  for (const row of rows) {
    lines.push(`${paint(GLYPH.vertical)} ${fitToWidth(row, inner)} ${paint(GLYPH.vertical)}`)
  }
  lines.push(paint(`${GLYPH.bottomLeft}${GLYPH.horizontal.repeat(width - 2)}${GLYPH.bottomRight}`))
  return lines
}

/**
 * Rows a box will occupy for `content`, without rendering it. The runner needs
 * this to place the cursor before the frame exists.
 * @param content - logical content lines.
 * @param width - total box width including borders.
 * @returns the row count, borders included.
 */
export function boxHeight(content: readonly string[], width: number): number {
  const inner = Math.max(1, width - BOX_CHROME_COLUMNS)
  const rows = content.length === 0 ? 1 : content.reduce((total, line) => total + wrapToWidth(line, inner).length, 0)
  return rows + 2
}

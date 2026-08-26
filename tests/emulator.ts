/**
 * A real terminal emulator as a test target.
 *
 * The renderer positions the cursor, erases regions, and redraws in place, so
 * what a person sees cannot be reconstructed by stripping escape sequences out of
 * the byte stream — the sequences ARE the layout. Feeding the bytes to an
 * emulator and reading its screen buffer is the only assertion that means
 * anything about rendered output.
 *
 * Hermetic on purpose: no pseudo-terminal, no harness, no model. It drives the
 * renderer's own {@link ScreenTarget} interface, so these tests run anywhere
 * `vitest` does.
 * @module @dshline/renderer/tests/emulator
 */

import headless from '@xterm/headless'
import type { ScreenTarget } from '../src/index.ts'

// The package ships CommonJS, so ESM interop puts its exports on `default`.
const { Terminal } = headless as unknown as { Terminal: new (options: object) => XtermLike }

/** One rendered cell's content and attributes. */
interface XtermCell {
  getChars(): string
  getFgColor(): number
  isFgPalette(): boolean
  isBold(): number
}

/** The slice of xterm's API these tests use. */
interface XtermLike {
  readonly rows: number
  readonly buffer: {
    active: {
      readonly cursorX: number
      readonly cursorY: number
      getLine(y: number): {
        translateToString(trim: boolean): string
        getCell(x: number): XtermCell | undefined
      } | undefined
    }
  }
  write(data: string, callback: () => void): void
  resize(columns: number, rows: number): void
  dispose(): void
}

/** Where the terminal left its cursor, in zero-based cells. */
export interface CursorAt {
  column: number
  row: number
}

/** What a cell holds, for asserting styling rather than only characters. */
export interface CellAt {
  /** The character, or an empty string for the second half of a wide one. */
  chars: string
  /** Palette index when the cell carries a palette colour, or undefined. */
  fg: number | undefined
  /** Whether the cell is bold. */
  bold: boolean
}

/** A terminal under test, plus the target the renderer writes through. */
export interface Emulator {
  /** Hand this to `new Screen(...)`. */
  readonly target: ScreenTarget
  /** Await every write the renderer has issued so far. */
  flush(): Promise<void>
  /** Visible rows, trailing blank lines removed. */
  screen(): Promise<string[]>
  /**
   * Every row the terminal holds, scrolled-off ones included.
   *
   * The renderer commits finished output into the terminal's own scroll buffer,
   * so a transcript longer than the screen is only readable here — {@link screen}
   * sees the viewport, which is the last few rows of it.
   */
  scrollback(): Promise<string[]>
  /**
   * Where the terminal put its cursor. Reading the buffer as text cannot show
   * this, so a frame with a misplaced cursor looks identical to a correct one.
   */
  cursor(): Promise<CursorAt>
  /**
   * One cell's content and attributes. Text output carries no styling, so this is
   * the only way to assert that a colour survived a wrap.
   * @param column - zero-based cell column.
   * @param row - zero-based cell row.
   * @returns the cell, or undefined when the row or column does not exist.
   */
  cell(column: number, row: number): Promise<CellAt | undefined>
  /**
   * Resize the terminal, reflowing held content the way a real terminal does.
   * The screen target's `columns()` answers with the new width afterwards.
   * @param columns - the new width in columns.
   * @param rows - the new height in rows.
   */
  resize(columns: number, rows: number): void
  /** Release the emulator. */
  dispose(): void
}

/**
 * Create an emulator of `columns` by `rows`.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @returns the emulator and its screen target.
 */
export function createEmulator(columns: number, rows = 24): Emulator {
  const term = new Terminal({ cols: columns, rows, allowProposedApi: true })
  // Tracked alongside the terminal so `target.columns()` answers with what the
  // renderer would read from a real terminal after a resize.
  let width = columns
  // xterm parses asynchronously, so every write is tracked and awaited before a
  // test reads the screen; reading early sees a partially parsed frame.
  const inflight: Promise<void>[] = []
  const flush = async (): Promise<void> => {
    while (inflight.length > 0) {
      const batch = inflight.splice(0, inflight.length)
      await Promise.all(batch)
    }
  }
  return {
    target: {
      write: chunk => {
        inflight.push(new Promise<void>(resolve => { term.write(chunk, resolve) }))
      },
      columns: () => width,
    },
    resize: (nextColumns, nextRows) => {
      width = nextColumns
      term.resize(nextColumns, nextRows)
    },
    flush,
    screen: async () => {
      await flush()
      const lines: string[] = []
      // `baseY` is the buffer row the viewport starts at. Reading from zero
      // instead returns the OLDEST rows once output has scrolled, which looks
      // like a correct frame for any test whose output happens to fit.
      const top = term.buffer.active.baseY
      for (let y = 0; y < term.rows; y += 1) {
        lines.push(term.buffer.active.getLine(top + y)?.translateToString(true) ?? '')
      }
      while (lines.length > 0 && lines.at(-1) === '') lines.pop()
      return lines
    },
    scrollback: async () => {
      await flush()
      const lines: string[] = []
      for (let y = 0; y < term.buffer.active.length; y += 1) {
        lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
      }
      while (lines.length > 0 && lines.at(-1) === '') lines.pop()
      return lines
    },
    cursor: async () => {
      await flush()
      return { column: term.buffer.active.cursorX, row: term.buffer.active.cursorY }
    },
    cell: async (column, row) => {
      await flush()
      const cell = term.buffer.active.getLine(row)?.getCell(column)
      if (cell === undefined) return undefined
      return {
        chars: cell.getChars(),
        // A default foreground reports as not-a-palette-colour, which is a
        // different fact from "some colour whose index happens to be zero".
        fg: cell.isFgPalette() ? cell.getFgColor() : undefined,
        bold: cell.isBold() !== 0,
      }
    },
    dispose: () => { term.dispose() },
  }
}

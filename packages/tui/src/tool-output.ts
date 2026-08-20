/**
 * The expanded tool-result inspector overlay.
 *
 * A compact card elides rows that are already committed into scrollback and so
 * cannot be recovered. This overlay renders the SAME semantic presentation the
 * card used, but at full detail, inside the live region — it is dismissed and
 * disappears, leaving the committed transcript untouched and native scrollback
 * intact.
 * @module @riesbri/dsh-tui/tool-output
 */

import type { Key } from '@riesbri/dsh-tui-renderer'
import { BOX_CHROME_COLUMNS, box, style, truncateToWidth } from '@riesbri/dsh-tui-renderer'
import { RowViewport } from './scroll.ts'
import type { TuiOverlay } from './slots.ts'
import { chromeWidth } from './views.ts'

/** Rows outside the inspected body in the overlay: blank, border, counter, help. */
const TOOL_OUTPUT_FIXED_ROWS = 6

/** Everything the inspector needs to render and dismiss itself. */
export interface ToolOutputSpec {
  /** The box title, describing what is being inspected. */
  readonly title: string
  /**
   * Produce the expanded rows at the current width, plus the unbounded source
   * row count the counter reports against.
   * @param columns - the terminal's current width.
   */
  render(columns: number): { rows: string[]; sourceRows: number }
  /** Called once when the user closes the overlay. */
  close(): void
  /** Asks the runner to redraw after scrolling or on resize. */
  invalidate(): void
}

/**
 * Build the tool-result inspector overlay.
 * @param spec - what to render and how to dismiss.
 * @returns the overlay to push onto the slot registry.
 */
export function createToolOutputOverlay(spec: ToolOutputSpec): TuiOverlay {
  const viewport = new RowViewport()
  let closed = false
  const close = (): void => {
    // Dismissal is once-only, as a stray keystroke can arrive during unmount.
    if (closed) return
    closed = true
    spec.close()
  }
  return {
    render(columns, terminalRows = 24) {
      const { rows, sourceRows } = spec.render(columns)
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      viewport.update(rows.length, Math.max(0, terminalRows - TOOL_OUTPUT_FIXED_ROWS))
      const counter = `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(sourceRows)}${sourceRows > rows.length ? '+' : ''}`
      return [
        '',
        ...box([
          style(counter, 'gray'),
          '',
          ...rows.slice(viewport.start, viewport.end),
          '',
        ], {
          width,
          title: style(truncateToWidth(spec.title, Math.max(4, inner - 2)), 'bold', 'yellow'),
          border: text => style(text, 'yellow'),
        }),
        `  ${style(truncateToWidth('↑↓ scroll · home/end jump · esc close', Math.max(1, columns - 2)), 'gray')}`,
      ]
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          if (viewport.move(-1)) spec.invalidate()
          return
        case 'down':
          if (viewport.move(1)) spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          if (viewport.first()) spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          if (viewport.last()) spec.invalidate()
          return
        case 'escape':
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
  }
}

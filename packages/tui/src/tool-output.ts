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

/**
 * Rows outside the inspected body when the full box is used: the leading blank,
 * the two box borders, the counter, the blank before and after the body, and
 * the help row. The body budget is `terminalRows - this`, so the frame fills
 * the terminal exactly and never overflows it.
 */
const TOOL_OUTPUT_FIXED_ROWS = 7

/** Everything the inspector needs to render and dismiss itself. */
export interface ToolOutputSpec {
  /** The box title, describing what is being inspected. */
  readonly title: string
  /**
   * Produce the expanded presentation at the current width, plus whether the
   * hard budget cut further source material.
   * @param columns - the terminal's current width.
   */
  render(columns: number): { rows: string[]; truncated: boolean }
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
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      // Render the inspected card at the OUTER box's inner width, not the whole
      // terminal width. `box()` wraps any content row wider than its inner width
      // into another physical row (it must not truncate the composer's text), so
      // a card laid out at the full terminal width—a terminal frame plus its
      // indent, or a read/search row—would become two rows inside the overlay and
      // overflow the height budget. Laid out at `inner`, every card row is at
      // most one physical row, keeping `render(...).length <= terminalRows` true
      // for real `ToolCards.renderInspect()` output.
      const { rows, truncated } = spec.render(inner)
      // A terminal too short for the frame still needs the escape hatch, and the
      // live region must never exceed the screen: clipped and closable beats a
      // box that overflows into scrollback.
      if (terminalRows < TOOL_OUTPUT_FIXED_ROWS) {
        if (terminalRows <= 0) return []
        const summary = `Tool output · ${spec.title} · esc close`
        const lines = [style(truncateToWidth(summary, Math.max(1, columns)), 'yellow', 'bold')]
        if (terminalRows >= 2) lines.push(style('esc close', 'gray'))
        return lines
      }
      // Body rows share the terminal with the fixed chrome exactly, so the whole
      // live region fills the screen without spilling past it.
      const visible = terminalRows - TOOL_OUTPUT_FIXED_ROWS
      viewport.update(rows.length, visible)
      // Counter and viewport are both in presentation-row space: `rows` are the
      // scrollable rows (framing and headers included), so a scrolled-to End can
      // never read past the denominator. `+` is added only when the hard cap hid
      // further source material.
      const counter = `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(rows.length)}${truncated ? '+' : ''}`
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

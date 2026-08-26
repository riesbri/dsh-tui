/** Bounded read-only terminal presentation of Harness Todo snapshots. */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import type { TuiOverlay } from '../slots.ts'
import type { TodoReading } from './model.ts'

/** Leading blank and two frame borders outside normal Todo content. */
const TODO_FIXED_ROWS = 3

/** Smallest width whose framed Todo list can remain one physical row per item. */
const TODO_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** Inputs the read-only Todo overlay needs from the runner. */
export interface TodoOverlaySpec {
  /** Current projection-derived Todo reading. */
  readonly reading: () => TodoReading
  /** Remove this temporary overlay. */
  readonly close: () => void
}

/**
 * Create a bounded read-only Todo overlay.
 * @param spec - current reading and close control.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createTodoOverlay(spec: TodoOverlaySpec): TuiOverlay {
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  return {
    render(columns, terminalRows = 24) {
      const reading = spec.reading()
      if (terminalRows <= TODO_FIXED_ROWS || columns < TODO_MIN_COLUMNS) {
        return compactFallback(reading, columns, terminalRows)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - TODO_FIXED_ROWS
      if (capacity <= 0) return compactFallback(reading, columns, terminalRows)
      const content = contentRows(reading, inner, capacity)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Todos', 'overlay-title'),
          body: content,
          footer: fitFooterHelp('esc close', footerBudget(columns)),
        }),
      ]
      // Frame labels and escape-safe text are still logical lines. Screen wraps
      // those lines, so verify the physical candidate rather than assuming it fits.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(reading, columns, terminalRows)
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      if (key.name === 'escape' || key.name === 'ctrl-c') close()
    },
  }
}

/** Turn a small projection state into as many bounded one-row list entries as fit. */
function contentRows(reading: TodoReading, width: number, capacity: number): string[] {
  switch (reading.kind) {
    case 'projections-unavailable':
      return [paint(truncateToWidth('Session projections are unavailable in this profile.', width), 'muted')]
    case 'unregistered':
      return [paint(truncateToWidth('Todo projection is unavailable.', width), 'muted')]
    case 'none':
      return [paint('No active todo list.', 'muted')]
    case 'empty':
      return [paint('Todo list is empty.', 'muted')]
    case 'list': {
      // One capacity slot is reserved for the truthful omission marker. Items
      // stay in Harness order; sorting by status would create TUI-owned meaning.
      const shown = reading.items.slice(0, Math.max(0, capacity - (reading.items.length > capacity ? 1 : 0)))
      const rows = shown.map(item => itemRow(item.content, item.status, width))
      const omitted = reading.items.length - shown.length
      if (omitted > 0 && rows.length < capacity) rows.push(paint(`… +${String(omitted)} more`, 'muted'))
      return rows.length > 0 ? rows : [paint(`… +${String(reading.items.length)} more`, 'muted')]
    }
  }
}

/** Render one untrusted Todo item into one safely truncated physical row. */
function itemRow(content: string, status: 'pending' | 'in_progress' | 'completed', width: number): string {
  const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○'
  const color = status === 'completed' ? 'success' : status === 'in_progress' ? 'busy' : 'subdued'
  // Escape before styling: model-authored content must not add rows, operate the
  // terminal, or consume a style reset belonging to the overlay.
  return paint(truncateToWidth(`${mark} ${safeTodoContent(content)}`, width), color)
}

/** Make one Todo label safe without allowing model text to add a list row. */
function safeTodoContent(content: string): string {
  // Newlines are normally meaningful in transcript text, but a Todo is one list
  // row. Escape all controls first, then make its preserved line separator visible.
  return escapeControls(content).replaceAll('\n', '^J')
}

/** Count the physical rows Screen will draw for a candidate live region. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/** A closable answer for a terminal too small to safely draw the frame. */
function compactFallback(reading: TodoReading, columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const summary = compactSummary(reading)
  // A compact fallback has one row, so it must choose a whole truthful phrase.
  // Cutting `esc close` into `esc cl` says neither what happened nor how to leave.
  const visible = [summary, 'esc close', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return visible === undefined ? [] : [paint(visible, 'overlay-headline')]
}

/** Describe the current projection reading without exposing any model-authored text. */
function compactSummary(reading: TodoReading): string {
  switch (reading.kind) {
    case 'projections-unavailable':
      return 'Todos unavailable · esc close'
    case 'unregistered':
      return 'Todo unavailable · esc close'
    case 'none':
      return 'No active todos · esc close'
    case 'empty':
      return 'Todo list empty · esc close'
    case 'list': {
      const completed = reading.items.filter(item => item.status === 'completed').length
      return `Todos ${String(completed)}/${String(reading.items.length)} · esc close`
    }
  }
}

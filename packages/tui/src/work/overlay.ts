/**
 * Bounded live-region overlay for optional Harness work.
 *
 * It never commits rows: finished transcript output remains in the terminal's
 * native scrollback while this temporary inspection view is open.
 * @module @riesbri/dsh-tui/work/overlay
 */

import type { Key } from '@riesbri/dsh-tui-renderer'
import {
  BOX_CHROME_COLUMNS,
  box,
  displayWidth,
  escapeControls,
  formatElapsed,
  style,
  truncateToWidth,
} from '@riesbri/dsh-tui-renderer'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { chromeWidth } from '../views.ts'
import type { WorkItem, WorkSnapshot } from './model.ts'

/** Rows not occupied by the work list in the full overlay. */
const WORK_FIXED_ROWS = 6

/** Minimum terminal width that can show the framed work list without wrapping. */
const WORK_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** Inputs the Work overlay needs from its owner. */
export interface WorkOverlaySpec {
  /** Current read-only capability projection. */
  readonly snapshot: () => WorkSnapshot
  /** Request cancellation of one item where Harness exposes it. */
  readonly stop: (item: WorkItem) => void
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after selection or scroll changes. */
  readonly invalidate: () => void
}

/**
 * Create the bounded Work overlay.
 * @param spec - current projection and overlay controls.
 * @returns a temporary live-region overlay.
 */
export function createWorkOverlay(spec: WorkOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  let selected = 0
  let items: readonly WorkItem[] = []
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const move = (amount: number): void => {
    if (items.length === 0) return
    selected = (selected + amount + items.length) % items.length
    spec.invalidate()
  }
  return {
    render(columns, terminalRows = 24) {
      const snapshot = spec.snapshot()
      items = [...snapshot.subagents, ...snapshot.jobs]
      selected = Math.min(selected, Math.max(0, items.length - 1))
      if (terminalRows <= WORK_FIXED_ROWS || columns < WORK_MIN_COLUMNS) {
        return compactFallback(snapshot, columns, terminalRows)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const rows = contentRows(snapshot, selected, inner)
      const visible = terminalRows - WORK_FIXED_ROWS
      viewport.update(rows.length, visible)
      const selectedRow = rowForSelection(snapshot, selected)
      if (selectedRow < viewport.start) viewport.move(selectedRow - viewport.start)
      if (selectedRow >= viewport.end) viewport.move(selectedRow - viewport.end + 1)
      const counter = rows.length === 0
        ? 'no active work'
        : `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(rows.length)}`
      return [
        '',
        ...box([
          style(truncateToWidth(counter, inner), 'gray'),
          '',
          ...rows.slice(viewport.start, viewport.end),
        ], {
          width,
          title: style('Work', 'bold', 'yellow'),
          border: text => style(text, 'yellow'),
        }),
        `  ${style(truncateToWidth('↑↓ select · k stop supported · esc close', Math.max(1, columns - 2)), 'gray')}`,
      ]
    },
    handleKey(key: Key) {
      // Printable letters remain text input in the renderer. The overlay owns
      // text entry, so recognize its one letter command here rather than adding
      // a presentation-specific key name to the renderer's generic decoder.
      if (key.kind === 'text' && key.text === 'k') {
        const item = items[selected]
        if (item !== undefined) spec.stop(item)
        return
      }
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
        case 'ctrl-a':
          selected = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          selected = Math.max(0, items.length - 1)
          viewport.last()
          spec.invalidate()
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

/** Render grouped rows, escaping capability labels before applying color. */
function contentRows(snapshot: WorkSnapshot, selected: number, width: number): string[] {
  if (!snapshot.available) return [style('Jobs and subagents are not installed in this profile.', 'gray')]
  if (snapshot.subagents.length === 0 && snapshot.jobs.length === 0) {
    return [style('No active jobs or subagents.', 'gray')]
  }
  const rows: string[] = []
  let index = 0
  if (snapshot.subagents.length > 0) {
    rows.push(style('Subagents', 'bold'))
    for (const item of snapshot.subagents) rows.push(itemRow(item, index++ === selected, width))
  }
  if (snapshot.jobs.length > 0) {
    if (rows.length > 0) rows.push('')
    rows.push(style('Jobs', 'bold'))
    for (const item of snapshot.jobs) rows.push(itemRow(item, index++ === selected, width))
  }
  return rows
}

/** Translate an item index to its grouped content-row index. */
function rowForSelection(snapshot: WorkSnapshot, selected: number): number {
  if (selected < snapshot.subagents.length) return selected + 1
  const jobIndex = selected - snapshot.subagents.length
  return snapshot.subagents.length === 0 ? jobIndex + 1 : snapshot.subagents.length + jobIndex + 3
}

/** Render one generic capability item into a single physical row. */
function itemRow(item: WorkItem, active: boolean, width: number): string {
  const state = item.state === 'stopping' ? '◐' : '●'
  const name = escapeControls(item.provider ?? item.source)
  const label = item.label === undefined || item.label === '' ? '' : ` ${escapeControls(item.label)}`
  const elapsed = Math.max(0, Date.now() - item.startedAt)
  const suffix = ` ${formatElapsed(elapsed)}`
  const plain = `${state} ${name}${label}${suffix}`
  const fitted = truncateToWidth(plain, Math.max(1, width - 2))
  return active ? style(`❯ ${fitted}`, 'cyan', 'bold') : `  ${style(fitted, item.state === 'stopping' ? 'yellow' : 'dim')}`
}

/** A closable answer for terminals that cannot safely hold a frame. */
function compactFallback(snapshot: WorkSnapshot, columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const summary = !snapshot.available
    ? 'Work unavailable · esc close'
    : snapshot.jobs.length === 0 && snapshot.subagents.length === 0
      ? 'No active work · esc close'
      : `${String(snapshot.subagents.length)} agents · ${String(snapshot.jobs.length)} jobs · esc close`
  // On a narrow fallback, keeping the way out matters more than naming work
  // that cannot be inspected in that geometry.
  const shown = columns < displayWidth(summary) ? 'esc close' : summary
  const lines = [style(truncateToWidth(shown, Math.max(1, columns)), 'yellow', 'bold')]
  if (rows >= 2) lines.push(style(truncateToWidth('esc close', Math.max(1, columns)), 'gray'))
  return lines
}

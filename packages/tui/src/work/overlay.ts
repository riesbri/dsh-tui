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
  wrapToWidth,
} from '@riesbri/dsh-tui-renderer'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { chromeWidth } from '../views.ts'
import type { WorkItem, WorkSnapshot, WorkStopResult } from './model.ts'

/** Rows outside a no-notice frame body: blank, borders, and key help. */
const WORK_FIXED_ROWS = 6

/** Minimum terminal width that can show the framed work list without wrapping. */
const WORK_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** Interval for elapsed durations while this temporary overlay is mounted. */
const WORK_TICK_MS = 1_000

/** How long a stop result remains visible before the normal list returns. */
const NOTICE_MS = 3_000

/** Inputs the Work overlay needs from its owner. */
export interface WorkOverlaySpec {
  /** Current read-only capability projection. */
  readonly snapshot: () => WorkSnapshot
  /** Request cancellation of one item where Harness exposes it. */
  readonly stop: (item: WorkItem) => WorkStopResult
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after selection, a result, or a timer tick. */
  readonly invalidate: () => void
}

/** A short result shown over the list without committing transcript output. */
interface Notice {
  readonly text: string
  readonly failed: boolean
  readonly expiresAt: number
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
  let ticker: NodeJS.Timeout | undefined
  let notice: Notice | undefined
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
  const stop = (): void => {
    const item = items[selected]
    if (item === undefined) return
    const result = spec.stop(item)
    notice = { text: result.message, failed: result.kind === 'failed', expiresAt: Date.now() + NOTICE_MS }
    spec.invalidate()
  }
  const currentNotice = (): Notice | undefined => {
    if (notice !== undefined && Date.now() >= notice.expiresAt) notice = undefined
    return notice
  }
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  return {
    mounted() {
      // The parent may be idle while an independent job runs. This timer exists
      // only for this mounted overlay, and unref keeps it from owning process life.
      ticker ??= setInterval(() => { spec.invalidate() }, WORK_TICK_MS).unref()
    },
    dispose: stopTicker,
    render(columns, terminalRows = 24) {
      const snapshot = spec.snapshot()
      items = [...snapshot.subagents, ...snapshot.jobs]
      selected = Math.min(selected, Math.max(0, items.length - 1))
      const activeNotice = currentNotice()
      if (terminalRows <= WORK_FIXED_ROWS || columns < WORK_MIN_COLUMNS) {
        return compactFallback(snapshot, columns, terminalRows, activeNotice)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const listing = contentRows(snapshot, selected, inner)
      const visible = terminalRows - WORK_FIXED_ROWS - (activeNotice === undefined ? 0 : 1)
      if (visible <= 0) return compactFallback(snapshot, columns, terminalRows, activeNotice)
      viewport.update(listing.length, visible)
      const selectedRow = rowForSelection(snapshot, selected)
      if (selectedRow < viewport.start) viewport.move(selectedRow - viewport.start)
      if (selectedRow >= viewport.end) viewport.move(selectedRow - viewport.end + 1)
      const counter = listing.length === 0
        ? 'no active work'
        : `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(listing.length)}`
      const frame = [
        '',
        ...box([
          style(truncateToWidth(counter, inner), 'gray'),
          ...activeNotice === undefined ? [] : [style(
            truncateToWidth(escapeControls(activeNotice.text), inner),
            activeNotice.failed ? 'red' : 'yellow',
          )],
          '',
          ...listing.slice(viewport.start, viewport.end),
        ], {
          width,
          title: style('Work', 'bold', 'yellow'),
          border: text => style(text, 'yellow'),
        }),
        `  ${style(truncateToWidth(help(items[selected]), Math.max(1, columns - 2)), 'gray')}`,
      ]
      // `box()` wraps its content, including short-state text a caller may not
      // have pre-truncated. Count the same physical rows Screen will draw; a
      // too-tall candidate falls back rather than leaking a row into scrollback.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(snapshot, columns, terminalRows, activeNotice)
    },
    handleKey(key: Key) {
      // Printable letters remain text input in the renderer. The overlay owns
      // text entry, so recognize its one letter command here rather than adding
      // a presentation-specific key name to the renderer's generic decoder.
      if (key.kind === 'text' && key.text === 'k') {
        if (items[selected]?.stoppable === true) stop()
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

/** The help text truthful for the selected item and the current Harness authority. */
function help(item: WorkItem | undefined): string {
  return item?.stoppable === true ? '↑↓ select · k stop · esc close' : '↑↓ select · esc close'
}

/** Render one generic capability item into a single physical row. */
function itemRow(item: WorkItem, active: boolean, width: number): string {
  const state = item.state === 'stopping' ? '◐' : '●'
  const name = escapeControls(item.provider ?? item.source)
  const label = item.label === undefined || item.label === '' ? '' : ` ${escapeControls(item.label)}`
  const elapsed = Math.max(0, Date.now() - item.startedAt)
  const plain = `${state} ${name}${label} ${formatElapsed(elapsed)}`
  const fitted = truncateToWidth(plain, Math.max(1, width - 2))
  return active ? style(`❯ ${fitted}`, 'cyan', 'bold') : `  ${style(fitted, item.state === 'stopping' ? 'yellow' : 'dim')}`
}

/** Count the physical terminal rows the Screen will use for candidate lines. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/** A closable answer for terminals that cannot safely hold a frame. */
function compactFallback(
  snapshot: WorkSnapshot,
  columns: number,
  rows: number,
  notice?: Notice,
): string[] {
  if (rows <= 0) return []
  // A failed human action must survive the same geometry fallback that protects
  // scrollback. It takes precedence over the ordinary compact summary; clipping
  // its detail is preferable to making authorization or cancellation invisible.
  if (notice?.failed === true) {
    return [style(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), 'red')]
  }
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

/**
 * Bounded live-region overlay for optional Harness work.
 *
 * It never commits rows: finished transcript output remains in the terminal's
 * native scrollback while this temporary inspection view is open. A second,
 * smaller stage — the selected-item detail — is an internal submode of the
 * same frame, so inspecting one row never creates a detached modal.
 * @module dshline/work/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  formatElapsed,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import type { WorkItem, WorkSnapshot, WorkInterruptResult } from './model.ts'
import { workItemKey } from './model.ts'

/** Rows outside the listing: leading blank, borders, counter, and spacer. */
const WORK_FIXED_ROWS = 5

/** Minimum terminal width that can show the framed work list without wrapping. */
const WORK_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** Interval for elapsed durations while this temporary overlay is mounted. */
const WORK_TICK_MS = 1_000

/** How long an interrupt result remains visible before the normal view returns. */
const NOTICE_MS = 3_000

/** Which stage of the temporary live region is on screen. */
type WorkStage = 'list' | 'detail'

/** Inputs the Work overlay needs from its owner. */
export interface WorkOverlaySpec {
  /** Current read-only capability projection. */
  readonly snapshot: () => WorkSnapshot
  /** Ask Harness to interrupt one row where it exposes that authority. */
  readonly interrupt: (item: WorkItem) => WorkInterruptResult
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after selection, a result, or a timer tick. */
  readonly invalidate: () => void
}

/** A short result shown over the view without committing transcript output. */
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
  let stage: WorkStage = 'list'
  let selected = 0
  let items: readonly WorkItem[] = []
  let detailKey: string | undefined
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
  const scrollDetail = (amount: number): void => {
    viewport.move(amount)
    spec.invalidate()
  }
  const openDetail = (): void => {
    const item = items[selected]
    if (item === undefined) return
    detailKey = workItemKey(item)
    stage = 'detail'
    viewport.first()
    spec.invalidate()
  }
  const closeDetail = (): void => {
    stage = 'list'
    detailKey = undefined
    // The list re-anchors its own selection in the next render.
    spec.invalidate()
  }
  const interrupt = (): void => {
    const item = items[selected]
    if (item === undefined) return
    const result = spec.interrupt(item)
    notice = { text: result.message, failed: result.kind === 'failed', expiresAt: Date.now() + NOTICE_MS }
    spec.invalidate()
  }
  const currentNotice = (): Notice | undefined => {
    if (notice !== undefined && Date.now() >= notice.expiresAt) notice = undefined
    return notice
  }
  // Key handling must work before the first frame has run, so it reads the
  // projection itself instead of trusting rows cached by the previous render.
  const readSnapshot = (): WorkSnapshot => {
    const snapshot = spec.snapshot()
    items = [...snapshot.subagents, ...snapshot.jobs]
    selected = Math.min(selected, Math.max(0, items.length - 1))
    return snapshot
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
      const snapshot = readSnapshot()
      // A row that settles while it is inspected must not keep painting stale
      // authority. The detail stage exits immediately and the list re-anchors.
      if (stage === 'detail' && !items.some(item => workItemKey(item) === detailKey)) {
        stage = 'list'
        detailKey = undefined
      }
      const activeNotice = currentNotice()
      if (terminalRows <= WORK_FIXED_ROWS || columns < WORK_MIN_COLUMNS) {
        return compactFallback(snapshot, columns, terminalRows, activeNotice)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const visible = terminalRows - WORK_FIXED_ROWS - (activeNotice === undefined ? 0 : 1)
      if (visible <= 0) return compactFallback(snapshot, columns, terminalRows, activeNotice)

      if (stage === 'detail') {
        const selectedItem = items[selected]
        const body = selectedItem === undefined
          ? [paint('No active work to inspect.', 'muted')]
          : detailRows(selectedItem, inner)
        viewport.update(body.length, visible)
        const frame = [
          '',
          ...rootFrame({
            columns,
            context: paint('Work', 'overlay-title'),
            body: [
              paint(truncateToWidth(`detail ${String(selected + 1)} of ${String(items.length)}`, inner), 'muted'),
              ...activeNotice === undefined
                ? []
                : [paint(truncateToWidth(escapeControls(activeNotice.text), inner), activeNotice.failed ? 'error' : 'busy')],
              '',
              ...body.slice(viewport.start, viewport.end),
            ],
            footer: fitFooterHelp(detailHelp(selectedItem), footerBudget(columns)),
          }),
        ]
        return physicalRows(frame, columns).length <= terminalRows
          ? frame
          : compactFallback(snapshot, columns, terminalRows, activeNotice)
      }

      const listing = contentRows(snapshot, selected, inner)
      viewport.update(listing.length, visible)
      const selectedRow = rowForSelection(snapshot, selected)
      if (selectedRow < viewport.start) viewport.move(selectedRow - viewport.start)
      if (selectedRow >= viewport.end) viewport.move(selectedRow - viewport.end + 1)
      const counter = listing.length === 0
        ? 'no active work'
        : `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(listing.length)}`
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Work', 'overlay-title'),
          body: [
            paint(truncateToWidth(counter, inner), 'muted'),
            ...activeNotice === undefined ? [] : [paint(
              truncateToWidth(escapeControls(activeNotice.text), inner),
              activeNotice.failed ? 'error' : 'busy',
            )],
            '',
            ...listing.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(listHelp(items[selected]), footerBudget(columns)),
        }),
      ]
      // The root frame wraps its content, including short-state text a caller may not
      // have pre-truncated. Count the same physical rows Screen will draw; a
      // too-tall candidate falls back rather than leaking a row into scrollback.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(snapshot, columns, terminalRows, activeNotice)
    },
    handleKey(key: Key) {
      if (closed) return
      readSnapshot()
      // Printable letters remain text input in the renderer. The overlay owns
      // text entry, so recognize its one letter command here rather than adding
      // a presentation-specific key name to the renderer's generic decoder.
      if (key.kind === 'text' && key.text === 'k') {
        if (items[selected]?.stoppable === true) interrupt()
        return
      }
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          if (stage === 'list') move(-1)
          else scrollDetail(-1)
          return
        case 'down':
          if (stage === 'list') move(1)
          else scrollDetail(1)
          return
        case 'enter':
          if (stage === 'list') openDetail()
          return
        case 'home':
        case 'ctrl-a':
          if (stage === 'list') {
            selected = 0
            viewport.first()
          } else {
            viewport.first()
          }
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          if (stage === 'list') {
            selected = Math.max(0, items.length - 1)
            viewport.last()
          } else {
            viewport.last()
          }
          spec.invalidate()
          return
        case 'escape':
        case 'ctrl-c':
          if (stage === 'detail') closeDetail()
          else close()
          return
        default:
          return
      }
    },
  }
}

/** Render grouped rows, escaping capability labels before applying color. */
function contentRows(snapshot: WorkSnapshot, selected: number, width: number): string[] {
  if (!snapshot.available) return [paint('Jobs and subagents are not installed in this profile.', 'muted')]
  if (snapshot.subagents.length === 0 && snapshot.jobs.length === 0) {
    return [paint('No active jobs or subagents.', 'muted')]
  }
  const rows: string[] = []
  let index = 0
  if (snapshot.subagents.length > 0) {
    rows.push(paint('Subagents', 'section-heading'))
    for (const item of snapshot.subagents) rows.push(itemRow(item, index++ === selected, width))
  }
  if (snapshot.jobs.length > 0) {
    if (rows.length > 0) rows.push('')
    rows.push(paint('Jobs', 'section-heading'))
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

/** The help text truthful for the selected list row and the current Harness authority. */
function listHelp(item: WorkItem | undefined): string {
  const action = item?.stoppable === true ? ' · k interrupt' : ''
  return `↑↓ select · ↵ view${action} · esc close`
}

/** The help text truthful for the inspected row. */
function detailHelp(item: WorkItem | undefined): string {
  const action = item?.stoppable === true ? ' · k interrupt' : ''
  return `↑↓ scroll${action} · esc back`
}

/** Render one generic capability item into a single physical row. */
function itemRow(item: WorkItem, active: boolean, width: number): string {
  const state = item.source === 'job' && item.state === 'stopping' ? '◐' : '●'
  const name = escapeControls(item.source === 'subagent' ? item.provider : item.kind)
  const label = item.label === undefined || item.label === '' ? '' : ` ${escapeControls(item.label)}`
  const elapsed = Math.max(0, Date.now() - item.startedAt)
  const plain = `${state} ${name}${label} ${formatElapsed(elapsed)}`
  const fitted = truncateToWidth(plain, Math.max(1, width - 2))
  return active ? paint(`❯ ${fitted}`, 'selection') : `  ${paint(fitted, 'subdued')}`
}

/**
 * Render the curated, source-specific facts of one Work row.
 *
 * Only facts Harness publishes appear; anything unknown is omitted rather than
 * guessed. Every Harness-provided value is escaped before styling.
 */
function detailRows(item: WorkItem, width: number): string[] {
  if (item.source === 'subagent') {
    const identity = item.label === undefined || item.label === ''
      ? item.provider
      : `${item.provider} · ${item.label}`
    const rows = [factRow('subagent', identity, width, 'selection')]
    if (item.mode !== undefined) rows.push(factRow('mode', item.mode, width))
    rows.push(factRow('session', item.id, width))
    if (item.residency !== undefined) {
      rows.push(factRow('residency', item.residency === 'resident' ? 'live session' : 'stored session', width))
    }
    if (item.hasChildren !== undefined) {
      rows.push(factRow('children', item.hasChildren ? 'yes' : 'no', width))
    }
    rows.push(factRow('run id', item.runId, width))
    rows.push(factRow('local agent', item.local ? 'yes' : 'no', width))
    rows.push(factRow('elapsed', formatElapsed(Math.max(0, Date.now() - item.startedAt)), width))
    // The lifecycle edge is scoped to this delegating session and discovery is
    // the direct-parent query, so the direct-child relationship is provable.
    rows.push(factRow('lineage', 'direct child of this session', width))
    return rows
  }
  const identity = item.label === '' ? item.kind : `${item.kind} · ${item.label}`
  const rows = [factRow('job', identity, width, 'selection')]
  rows.push(factRow('job id', item.id, width))
  rows.push(factRow('status', item.state, width))
  if (item.detail !== undefined) rows.push(factRow('detail', item.detail, width))
  rows.push(factRow('owner', item.ownership === 'this-session' ? 'this session' : 'unowned', width))
  rows.push(factRow('elapsed', formatElapsed(Math.max(0, Date.now() - item.startedAt)), width))
  return rows
}

/** One aligned, escaped, fitted fact row; the identity row may outrank the rest. */
function factRow(key: string, value: string, width: number, role: 'selection' | 'subdued' = 'subdued'): string {
  const text = `${key}  ${escapeControls(value)}`
  return paint(`${' '.repeat(2)}${truncateToWidth(text, Math.max(1, width - 2))}`, role)
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
    return [paint(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), 'error')]
  }
  const subagents = snapshot.subagents.length
  const jobs = snapshot.jobs.length
  const summary = !snapshot.available
    ? 'Work unavailable · esc close'
    : jobs === 0 && subagents === 0
      ? 'No active work · esc close'
      : `${String(subagents)} ${subagents === 1 ? 'subagent' : 'subagents'} · ${String(jobs)} ${jobs === 1 ? 'job' : 'jobs'} · esc close`
  // On a narrow fallback, keeping the way out matters more than naming work
  // that cannot be inspected in that geometry.
  const shown = columns < displayWidth(summary) ? 'esc close' : summary
  const lines = [paint(truncateToWidth(shown, Math.max(1, columns)), 'overlay-headline')]
  if (rows >= 2) lines.push(paint(truncateToWidth('esc close', Math.max(1, columns)), 'muted'))
  return lines
}
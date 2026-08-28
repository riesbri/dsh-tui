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
  SPINNER_INTERVAL_MS,
  spinnerFrame,
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

/** How long an interrupt result remains visible before the normal view returns. */
const NOTICE_MS = 3_000

/**
 * Which whole facts a Work row yields as the terminal narrows.
 *
 * Drops happen BEFORE the semantic fragment would need truncating: `reading
 * overla…` states less than the word alone, so the detail yields first, then
 * the word, then the elapsed reading, then the delegation label. The mark and
 * provider/kind never yield on any width a frame can draw.
 */
const ROW_DROP_ORDER: readonly ('title' | 'word' | 'elapsed' | 'label')[] = [
  'title', 'word', 'elapsed', 'label',
]

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

/** The whole facts one row can render, before width fitting. */
interface RowPieces {
  readonly mark: string
  readonly name: string
  readonly label?: string
  readonly word?: string
  readonly title?: string
  readonly elapsed?: string
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
  // SELECTION is identity, not array position: a keystroke's target is resolved
  // by key, so a sibling settling above can never move a human action onto the
  // item that inherited the old screen position.
  let selectedKey: string | undefined
  let detailKey: string | undefined
  let closed = false
  let ticker: NodeJS.Timeout | undefined
  let tick = 0
  let notice: Notice | undefined
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const move = (amount: number): void => {
    if (items.length === 0) return
    selected = (selected + amount + items.length) % items.length
    const item = items[selected]
    selectedKey = item === undefined ? undefined : workItemKey(item)
    spec.invalidate()
  }
  const scrollDetail = (amount: number): void => {
    viewport.move(amount)
    spec.invalidate()
  }
  const aimItem = (): WorkItem | undefined => {
    const key = stage === 'detail' ? detailKey : selectedKey
    if (key === undefined) return undefined
    return items.find(candidate => workItemKey(candidate) === key)
  }
  const openDetail = (): void => {
    const item = aimItem()
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
  const interrupt = (item: WorkItem): void => {
    const result = spec.interrupt(item)
    notice = { text: result.message, failed: result.kind === 'failed', expiresAt: Date.now() + NOTICE_MS }
    spec.invalidate()
  }
  const currentNotice = (): Notice | undefined => {
    if (notice !== undefined && Date.now() >= notice.expiresAt) notice = undefined
    return notice
  }
  /**
   * Re-align the display with the newest projection.
   *
   * When the aimed key still exists, its new index is found and preserved.
   * When it vanished, `retarget` governs what happens next: rendering adopts
   * the predictable neighbor as the new selection identity, while a human
   * ACTION keeps the dead aim so it can refuse rather than hit the item that
   * inherited the old screen position.
   */
  const reconcile = (snapshot: WorkSnapshot, retarget: boolean): void => {
    const next = [...snapshot.subagents, ...snapshot.jobs]
    items = next
    const at = selectedKey === undefined
      ? -1
      : next.findIndex(candidate => workItemKey(candidate) === selectedKey)
    if (at >= 0) {
      selected = at
    } else {
      selected = Math.min(selected, Math.max(0, next.length - 1))
      if (retarget || selectedKey === undefined) {
        const neighbor = next[selected]
        selectedKey = neighbor === undefined ? undefined : workItemKey(neighbor)
      }
    }
    if (next.length === 0) selectedKey = undefined
    // A row that settles while it is inspected must not keep painting stale
    // authority. The detail stage exits immediately and the list re-anchors.
    if (stage === 'detail' && detailKey !== undefined
      && !next.some(candidate => workItemKey(candidate) === detailKey)) {
      stage = 'list'
      detailKey = undefined
    }
  }
  // Key handling must work before the first frame has run, so it reads the
  // projection itself instead of trusting rows cached by the previous render.
  const readSnapshot = (retarget: boolean): WorkSnapshot => {
    const snapshot = spec.snapshot()
    reconcile(snapshot, retarget)
    return snapshot
  }
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  return {
    mounted() {
      // One heartbeat drives the elapsed readings AND the shared spinner phase,
      // so every animated row turns together instead of flickering independently.
      // The parent may be idle while independent work runs; the timer exists only
      // for this mounted overlay, and unref keeps it from owning process life.
      ticker ??= setInterval(() => {
        tick += 1
        spec.invalidate()
      }, SPINNER_INTERVAL_MS).unref()
    },
    dispose: stopTicker,
    render(columns, terminalRows = 24) {
      const snapshot = readSnapshot(true)
      const activeNotice = currentNotice()
      if (terminalRows <= WORK_FIXED_ROWS || columns < WORK_MIN_COLUMNS) {
        return compactFallback(snapshot, columns, terminalRows, activeNotice)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const visible = terminalRows - WORK_FIXED_ROWS - (activeNotice === undefined ? 0 : 1)
      if (visible <= 0) return compactFallback(snapshot, columns, terminalRows, activeNotice)

      if (stage === 'detail') {
        const detailItem = aimItem()
        const detailIndex = detailKey === undefined
          ? -1
          : items.findIndex(candidate => workItemKey(candidate) === detailKey)
        const body = detailItem === undefined
          ? [paint('No active work to inspect.', 'muted')]
          : detailRows(detailItem, inner)
        viewport.update(body.length, visible)
        const frame = [
          '',
          ...rootFrame({
            columns,
            context: paint('Work', 'overlay-title'),
            body: [
              paint(truncateToWidth(`detail ${String(Math.max(0, detailIndex) + 1)} of ${String(items.length)}`, inner), 'muted'),
              ...activeNotice === undefined
                ? []
                : [paint(truncateToWidth(escapeControls(activeNotice.text), inner), activeNotice.failed ? 'error' : 'busy')],
              '',
              ...body.slice(viewport.start, viewport.end),
            ],
            footer: fitFooterHelp(detailHelp(detailItem), footerBudget(columns)),
          }),
        ]
        return physicalRows(frame, columns).length <= terminalRows
          ? frame
          : compactFallback(snapshot, columns, terminalRows, activeNotice)
      }

      const listing = contentRows(snapshot, selected, inner, tick)
      viewport.update(listing.length, visible)
      const selectedRow = rowForSelection(snapshot, selected)
      if (selectedRow < viewport.start) viewport.move(selectedRow - viewport.start)
      if (selectedRow >= viewport.end) viewport.move(selectedRow - viewport.end + 1)
      const counter = listing.length === 0
        ? 'no active work'
        : `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(listing.length)}`
      const aimed = aimItem()
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
          footer: fitFooterHelp(listHelp(aimed), footerBudget(columns)),
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
      // Printable letters remain text input in the renderer. The overlay owns
      // text entry, so recognize its one letter command here rather than adding
      // a presentation-specific key name to the renderer's generic decoder.
      if (key.kind === 'text' && key.text === 'k') {
        // The ACTION reads the projection WITHOUT retargeting the selection:
        // if the aimed key vanished, nothing may be interrupted — the next
        // paint re-anchors the cursor instead of acting on the successor.
        readSnapshot(false)
        const item = aimItem()
        if (item?.interruptible === true) interrupt(item)
        else spec.invalidate()
        return
      }
      if (key.kind !== 'key') return
      readSnapshot(true)
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
            const first = items[selected]
            selectedKey = first === undefined ? undefined : workItemKey(first)
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
            const last = items[selected]
            selectedKey = last === undefined ? undefined : workItemKey(last)
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
function contentRows(snapshot: WorkSnapshot, selected: number, width: number, tick: number): string[] {
  if (!snapshot.available) return [paint('Jobs and subagents are not installed in this profile.', 'muted')]
  if (snapshot.subagents.length === 0 && snapshot.jobs.length === 0) {
    return [paint('No active jobs or subagents.', 'muted')]
  }
  const rows: string[] = []
  let index = 0
  if (snapshot.subagents.length > 0) {
    rows.push(paint('Subagents', 'section-heading'))
    for (const item of snapshot.subagents) rows.push(itemRow(item, index++ === selected, width, tick))
  }
  if (snapshot.jobs.length > 0) {
    if (rows.length > 0) rows.push('')
    rows.push(paint('Jobs', 'section-heading'))
    for (const item of snapshot.jobs) rows.push(itemRow(item, index++ === selected, width, tick))
  }
  return rows
}

/** Translate an item index to its grouped content-row index. */
function rowForSelection(snapshot: WorkSnapshot, selected: number): number {
  if (selected < snapshot.subagents.length) return selected + 1
  const jobIndex = selected - snapshot.subagents.length
  return snapshot.subagents.length === 0 ? jobIndex + 1 : snapshot.subagents.length + jobIndex + 3
}

/** The help text truthful for the aimed list row and the current Harness authority. */
function listHelp(item: WorkItem | undefined): string {
  const action = item?.interruptible === true ? ' · k interrupt' : ''
  return `↑↓ select · ↵ view${action} · esc close`
}

/** The help text truthful for the inspected row. */
function detailHelp(item: WorkItem | undefined): string {
  const action = item?.interruptible === true ? ' · k interrupt' : ''
  return `↑↓ scroll${action} · esc back`
}

/**
 * Render one capability item into a single physical row.
 *
 * The mark is the renderer's own arc spinner while the authoritative fact says
 * the work is actively running (`Agent.status === 'running'`, or a Job in
 * `running`); everything else stays static: a stopping Job keeps `◐`, and a
 * subagent whose live Agent is quiescent — or which never had one — keeps `●`.
 */
function itemRow(item: WorkItem, active: boolean, width: number, tick: number): string {
  const mark = item.source === 'job' && item.state === 'stopping'
    ? '◐'
    : item.busy === true
      ? spinnerFrame(tick)
      : '●'
  const name = escapeControls(item.source === 'subagent' ? item.provider : item.kind)
  const label = item.label === undefined || item.label === '' ? undefined : escapeControls(item.label)
  const word = item.source === 'subagent' && item.activityWord !== undefined
    ? escapeControls(item.activityWord)
    : undefined
  const title = item.source === 'subagent' && word !== undefined
    && item.activityTitle !== undefined && item.activityTitle !== ''
    ? escapeControls(item.activityTitle)
    : undefined
  const elapsed = formatElapsed(Math.max(0, Date.now() - item.startedAt))
  const fitted = fitWorkRow({
    mark, name, elapsed,
    ...label === undefined ? {} : { label },
    ...word === undefined ? {} : { word },
    ...title === undefined ? {} : { title },
  }, Math.max(1, width - 2))
  const role = active
    ? 'selection'
    : item.source === 'job' && item.state === 'stopping'
      ? 'busy'
      : 'subdued'
  return active ? paint(`❯ ${fitted}`, 'selection') : `  ${paint(fitted, role)}`
}

/** Join a row's surviving whole facts with its separators. */
function rowText(pieces: RowPieces): string {
  return `${pieces.mark} ${pieces.name}`
    + (pieces.label === undefined ? '' : ` ${pieces.label}`)
    + (pieces.word === undefined ? '' : ` · ${pieces.word}`)
    + (pieces.title === undefined ? '' : ` ${pieces.title}`)
    + (pieces.elapsed === undefined ? '' : ` ${pieces.elapsed}`)
}

/**
 * Fit a Work row by dropping whole facts, never by cutting one in half.
 * @param pieces - the row's facts before fitting.
 * @param width - available display columns.
 * @returns the fitted row text.
 */
function fitWorkRow(pieces: RowPieces, width: number): string {
  const current: Partial<Record<keyof RowPieces, string>> = { ...pieces }
  for (const key of ROW_DROP_ORDER) {
    if (displayWidth(rowText(current as RowPieces)) <= width) return rowText(current as RowPieces)
    delete current[key]
  }
  return truncateToWidth(rowText(current as RowPieces), width)
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
    rows.push(factRow('lifecycle', 'active', width))
    // Live activity enriches the deep view exactly as it enriches the row.
    if (item.activityWord !== undefined) rows.push(factRow('activity', item.activityWord, width))
    if (item.activityTitle !== undefined && item.activityTitle !== '') {
      rows.push(factRow('operation', item.activityTitle, width))
    }
    if (item.agentStatus !== undefined) rows.push(factRow('agent status', item.agentStatus, width))
    if (item.mode !== undefined) rows.push(factRow('mode', item.mode, width))
    rows.push(factRow('session', item.id, width))
    if (item.residency !== undefined) {
      rows.push(factRow('residency', item.residency === 'resident' ? 'live session' : 'stored session', width))
    }
    if (item.hasChildren !== undefined) {
      // Harness's `hasChildren` is a durable lineage fact, not a claim that
      // sub-workers are active right now.
      rows.push(factRow('child sessions', item.hasChildren ? 'yes' : 'no', width))
    }
    rows.push(factRow('run id', item.runId, width))
    rows.push(factRow('local agent', item.local ? 'yes' : 'no', width))
    rows.push(factRow('elapsed', formatElapsed(Math.max(0, Date.now() - item.startedAt)), width))
    // The lifecycle edge is scoped to this delegating session and discovery is
    // the direct-parent query, so the direct-child relationship is provable.
    rows.push(factRow('lineage', 'direct child of this session', width))
    rows.push(factRow('interrupt', item.interruptible ? 'available' : 'not available', width))
    return rows
  }
  const identity = item.label === '' ? item.kind : `${item.kind} · ${item.label}`
  const rows = [factRow('job', identity, width, 'selection')]
  rows.push(factRow('job id', item.id, width))
  rows.push(factRow('status', item.state, width))
  if (item.detail !== undefined) rows.push(factRow('detail', item.detail, width))
  rows.push(factRow('owner', item.ownership === 'this-session' ? 'this session' : 'unowned', width))
  rows.push(factRow('elapsed', formatElapsed(Math.max(0, Date.now() - item.startedAt)), width))
  rows.push(factRow('interrupt', 'not available', width))
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

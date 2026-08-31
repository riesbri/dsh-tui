/**
 * Bounded live-region inspector for what this session has consumed.
 *
 * `/usage` used to be a settings picker and nothing else, which put a
 * three-choice menu in front of the one question the command's name asks. It is
 * now an inspector: bare `/usage` reports the session's cumulative tokens and
 * cost, and offers the status-line preference as one key inside it. Naming the
 * preference outright — `/usage cost`, `/usage tokens`, `/usage off` — still
 * changes it immediately without opening anything.
 *
 * Every figure here is a fact from an authority: the four token buckets are
 * Harness's `tokenUsage` projection, and the money is dshline's own pricing
 * fold, which is the only part of this that dshline owns.
 * @module dshline/usage-overlay
 */

import type { Key, Role } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  formatTokens,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import type { TuiOverlay } from './slots.ts'
import type { UsageInspection, UsageMode } from './usage.ts'
import { usageCost } from './usage.ts'

/** Rows outside the body: the leading blank and the two frame borders. */
const USAGE_FIXED_ROWS = 3

/** Minimum width whose framed usage report keeps one physical row per fact. */
const USAGE_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** Widest label in the report, so every figure lines up in one column. */
const LABEL_COLUMN = 14

/** Columns reserved for a figure, so the right edge lines up too. */
const VALUE_COLUMN = 8

/** Inputs the usage inspector needs from its owner. */
export interface UsageOverlaySpec {
  /** The current reading, read fresh on every paint. */
  readonly inspection: () => UsageInspection
  /** What the status line currently reports. */
  readonly mode: () => UsageMode
  /** Open the existing status-display picker; the overlay closes first. */
  readonly chooseDisplay: () => void
  /** Remove this temporary overlay. */
  readonly close: () => void
}

/**
 * Create the bounded usage inspector.
 * @param spec - the reading, the preference, and overlay controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createUsageOverlay(spec: UsageOverlaySpec): TuiOverlay {
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  return {
    render(columns, terminalRows = 24) {
      const inspection = spec.inspection()
      const fallback = (): string[] => compactFallback(inspection, columns, terminalRows)
      if (terminalRows <= USAGE_FIXED_ROWS || columns < USAGE_MIN_COLUMNS) return fallback()
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const candidate = [
        '',
        ...rootFrame({
          columns,
          context: paint('Usage', 'overlay-title'),
          body: bodyRows(inspection, spec.mode(), inner),
          footer: fitFooterHelp('s status display · esc close', footerBudget(columns)),
        }),
      ]
      // The frame wraps what it is given. Count the rows Screen will draw, so a
      // too-tall report falls back instead of leaking one into scrollback.
      return physicalRows(candidate, columns).length <= terminalRows ? candidate : fallback()
    },
    handleKey(key: Key) {
      if (closed) return
      // Printable letters stay text input in the renderer's decoder; the overlay
      // owns text entry while it is mounted, so its one letter is handled here.
      if (key.kind === 'text' && key.text === 's') {
        // Closed FIRST: the picker is a separate overlay that owns the keyboard,
        // and two overlays claiming it at once is how a picker becomes
        // unreachable. The preference is then reported the way a typed
        // `/usage cost` reports it.
        close()
        spec.chooseDisplay()
        return
      }
      if (key.kind !== 'key') return
      if (key.name === 'escape' || key.name === 'ctrl-c') close()
    },
  }
}

/**
 * The report's rows.
 * @param inspection - the current reading.
 * @param mode - what the status line reports.
 * @param width - display columns available inside the frame.
 * @returns painted rows, one per physical line.
 */
function bodyRows(inspection: UsageInspection, mode: UsageMode, width: number): string[] {
  const rows: string[] = [paint('Session', 'section-heading')]
  const buckets = inspection.buckets
  if (buckets === undefined) {
    // Harness's split is unavailable, so the honest report is dshline's own
    // combined prompt total rather than an invented breakdown of it.
    rows.push(
      fact('input', formatTokens(inspection.reading.inputTokens), width),
      fact('output', formatTokens(inspection.reading.outputTokens), width),
      '',
      paint(truncateToWidth(
        inspection.projections
          ? 'The Harness token meter is not mounted, so the cache split is unavailable.'
          : 'Session projections are unavailable in this profile.',
        Math.max(1, width),
      ), 'muted'),
    )
  } else {
    rows.push(
      fact('input', formatTokens(buckets.input), width),
      fact('  uncached', formatTokens(buckets.uncachedInput), width),
      fact('  cache read', formatTokens(buckets.cacheRead), width),
      fact('  cache write', formatTokens(buckets.cacheWrite), width),
      '',
      fact('output', formatTokens(buckets.output), width),
    )
    if (inspection.cacheReadShare !== undefined) {
      rows.push(fact(
        'cache read share',
        `${String(Math.round(inspection.cacheReadShare * 100))}%`,
        width,
      ))
    }
  }
  rows.push('')
  const cost = inspection.reading.costUsd
  if (cost === undefined) {
    // The same rule the status line follows: nothing is claimed before there is
    // something true to claim. An unpriced route reports no money, not zero.
    rows.push(paint(truncateToWidth(
      'No rates are configured for the routes this session used.',
      Math.max(1, width),
    ), 'muted'))
  } else {
    rows.push(fact(
      inspection.reading.partial ? 'cost (partial)' : 'cost',
      `${inspection.reading.partial ? '~' : ''}${usageCost(cost)}`,
      width,
    ))
    if (inspection.reading.partial) {
      rows.push(paint(truncateToWidth(
        'Part of this session ran on a route with no rates, so the cost is a floor.',
        Math.max(1, width),
      ), 'muted'))
    }
  }
  rows.push('', fact('status line', mode, width))
  return rows
}

/**
 * One two-column fact row.
 *
 * Every value here is a number this frontend formatted or a fixed word from its
 * own vocabulary, so nothing on these rows is untrusted text.
 * @param label - the fact's name.
 * @param value - its already-formatted value.
 * @param width - display columns available inside the frame.
 * @returns the painted row.
 */
function fact(label: string, value: string, width: number): string {
  const text = `${label.padEnd(LABEL_COLUMN)}${value.padStart(VALUE_COLUMN)}`
  return paint(truncateToWidth(text, Math.max(1, width)), roleFor(label))
}

/** The top-level figures read a shade louder than the ones indented under them. */
function roleFor(label: string): Role {
  return label.startsWith('  ') ? 'muted' : 'subdued'
}

/**
 * Count the physical rows Screen will draw for a candidate live region.
 * @param lines - candidate logical lines.
 * @param columns - the terminal's width.
 * @returns the physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(candidate => wrapToWidth(candidate, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to hold the frame safely.
 * @param inspection - the current reading.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most one row.
 */
function compactFallback(inspection: UsageInspection, columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const input = inspection.buckets?.input ?? inspection.reading.inputTokens
  const output = inspection.buckets?.output ?? inspection.reading.outputTokens
  const cost = inspection.reading.costUsd
  const summary = `↑${formatTokens(input)} ↓${formatTokens(output)}${
    cost === undefined ? '' : ` ${usageCost(cost)}`
  } · esc close`
  // One row carries a whole truthful phrase or none of it: a cut figure is
  // worse than no figure, and the way out matters more than either.
  const visible = [summary, 'esc close', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return visible === undefined ? [] : [paint(visible, 'overlay-headline')]
}

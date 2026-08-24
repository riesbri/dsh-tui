/**
 * Where the current or most recently measured turn's time went.
 *
 * Finished durations come from timestamps carried by the live session events,
 * not from clock reads taken while drawing. An open turn has no closing event,
 * so its wall clock and any running tools advance against the current clock;
 * once they finish, their event timestamps replace that provisional reading.
 *
 * The one thing this deliberately does NOT claim is that the parts add up to the
 * whole. Tool calls in a step run concurrently and reasoning interleaves with
 * them across steps, so these are overlapping spans: their sum can exceed the
 * turn, and the difference is not idle time. That is why the bars are scaled
 * against the LARGEST span rather than against the turn's wall clock.
 * @module dshline/timing
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { displayWidth, escapeControls, formatElapsed, style, truncateToWidth } from '@dshline/renderer'
import type { TuiSlotView } from './slots.ts'
import { chromeWidth } from './views.ts'

/** One measured span within a turn. */
export interface TurnSpan {
  /** What was running: `reasoning`, `output`, or a tool's name. */
  readonly label: string
  /** Milliseconds the span covered. */
  readonly ms: number
  /** Whether at least one call represented by this row is still open. */
  readonly running: boolean
}

/** A live or finished turn, as the panel draws it. */
export interface TurnTiming {
  /** The turn's number, as the session log counts it. */
  readonly turn: number
  /** Wall clock from `turn/start` to the current or closing timestamp. */
  readonly totalMs: number
  /** Whether the closing `turn/end` has not arrived yet. */
  readonly running: boolean
  /** Spans worth drawing, longest first. */
  readonly spans: readonly TurnSpan[]
}

/** Widest a label column grows before names are cut; beyond this the bars starve. */
const LABEL_COLUMNS = 14

/** Columns between fields, so a label, bar, and duration never read as one word. */
const FIELD_GAP = 2

/** Left indent, matching the status line's. */
const INDENT = '  '

/** Fewest cells the bar area is worth drawing in at all. */
const MIN_BAR_CELLS = 4

/** The bar's glyph; the remainder is left blank rather than tracked. */
const BAR_FULL = '█'

/** Under a minute, tenths — a turn's steps are often seconds apart. */
const TENTHS_BELOW_MS = 60_000

/**
 * Maximum logical rows the persistent panel may claim.
 *
 * Six keeps four named spans plus an honest elision row visible without letting
 * a tool-heavy turn crowd the composer out of an ordinary 24-row terminal.
 */
const PANEL_ROWS = 6

/** The status line is the one fixed row below the timing slot. */
const STATUS_ROWS = 1

/**
 * A span's duration, at a precision that keeps distinct spans distinct.
 *
 * `formatElapsed` floors to whole seconds, which is right for a status line
 * counting a turn up but wrong here: most tool calls finish in single-digit
 * seconds, and rounding them all to `3s` collapses the differences the panel
 * exists to show.
 * @param milliseconds - the span.
 * @returns e.g. `18.2s`, `1m 04s`.
 */
function formatSpan(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  if (value >= TENTHS_BELOW_MS) return formatElapsed(value)
  return `${(value / 1000).toFixed(1)}s`
}

/** One streamed kind within one model step. */
interface StreamSpan {
  readonly kind: 'reasoning' | 'output'
  first: number
  last: number
}

/** One tool call awaiting its result. */
interface PendingTool {
  readonly name: string
  readonly at: number
}

/**
 * Collects timings for the live turn and retains the most recent finished one.
 *
 * Fed from the runner's LIVE event listener rather than from its shared
 * projection, and that is not an oversight. A resumed session's replay has no
 * `assistant/chunk` events at all — they are the streamed form of a message the
 * log also stores assembled, so replaying both would print every reply twice, and
 * the projection drops them. A timer fed from the replay would therefore chart
 * every historical turn as though the model had thought for no time at all.
 */
export class TurnTimer {
  /** When the open turn began, or undefined when no turn is being measured. */
  private startedAt: number | undefined
  private turn = 0
  /** First and last delta of one kind within one step, keyed `kind:step`. */
  private readonly streams = new Map<string, StreamSpan>()
  /** Calls awaiting their result, keyed by call id. */
  private readonly pending = new Map<string, PendingTool>()
  /** Finished milliseconds for each tool name in the open turn. */
  private readonly tools = new Map<string, number>()
  /** The last complete measurement, retained while the attachment is idle. */
  private finished: TurnTiming | undefined

  /** Forget only the open turn; a completed panel remains useful while idle. */
  private resetOpen(): void {
    this.startedAt = undefined
    this.streams.clear()
    this.pending.clear()
    this.tools.clear()
  }

  /**
   * Fold one live event into the current measurement.
   *
   * Observation is intentionally not gated by the display preference. Toggling
   * a presentation should not fabricate a partial turn beginning at the toggle,
   * and the event fold is cheap enough to keep the view immediately truthful.
   * @param event - one committed live session event.
   * @returns nothing; read the current result through {@link snapshot}.
   */
  observe(event: SessionEvent): void {
    if (event.type === 'turn/start') {
      this.resetOpen()
      this.startedAt = event.time
      this.turn = event.data.turn
      return
    }
    if (this.startedAt === undefined) return
    if (event.type === 'assistant/chunk') {
      const { chunk, step } = event.data
      const kind = chunk.type === 'reasoning-delta' ? 'reasoning' : chunk.type === 'text-delta' ? 'output' : undefined
      if (kind === undefined) return
      const key = `${kind}:${String(step)}`
      const span = this.streams.get(key)
      if (span === undefined) this.streams.set(key, { kind, first: event.time, last: event.time })
      else span.last = event.time
      return
    }
    if (event.type === 'tool/call') {
      this.pending.set(event.data.callId, { name: event.data.name, at: event.time })
      return
    }
    if (event.type === 'tool/result') {
      // Paired by call id, exactly as the tool cards pair them: several calls can
      // be open at once, so the newest result does not belong to the newest call.
      const block = event.data.message.content[0]
      const call = this.pending.get(block.toolCallId)
      if (call === undefined) return
      this.pending.delete(block.toolCallId)
      this.tools.set(call.name, (this.tools.get(call.name) ?? 0) + Math.max(0, event.time - call.at))
      return
    }
    if (event.type !== 'turn/end') return
    this.finished = this.reading(event.time, false)
    this.resetOpen()
  }

  /**
   * Current live measurement, or the most recent completed turn while idle.
   * @param now - current wall clock, used only for values whose closing event has
   *   not arrived; defaults to the clock at render time.
   * @returns the current or retained measurement, or undefined in a fresh attachment.
   */
  snapshot(now = Date.now()): TurnTiming | undefined {
    return this.startedAt === undefined ? this.finished : this.reading(now, true)
  }

  /** Build one immutable reading without mutating the fold. */
  private reading(at: number, running: boolean): TurnTiming {
    const startedAt = this.startedAt ?? at
    const spans = new Map<string, { ms: number; running: boolean }>()
    for (const span of this.streams.values()) {
      const current = spans.get(span.kind)
      const ms = Math.max(0, span.last - span.first)
      spans.set(span.kind, { ms: (current?.ms ?? 0) + ms, running: false })
    }
    for (const [name, ms] of this.tools) spans.set(name, {
      ms: (spans.get(name)?.ms ?? 0) + ms,
      running: spans.get(name)?.running ?? false,
    })
    for (const call of this.pending.values()) spans.set(call.name, {
      ms: (spans.get(call.name)?.ms ?? 0) + Math.max(0, at - call.at),
      running,
    })
    return {
      turn: this.turn,
      totalMs: Math.max(0, at - startedAt),
      running,
      spans: [...spans]
        .map(([label, span]) => ({ label, ...span }))
        // A live zero says the span has begun. Once finished, a row beside 0.0s
        // measures nothing a reader can act on and is dropped as before.
        .filter(span => running || span.ms > 0)
        .sort((left, right) => right.ms - left.ms),
    }
  }
}

/**
 * The bounded timing panel as live-region lines.
 * @param profile - current or retained timing, or undefined before a live turn.
 * @param columns - the terminal's current width.
 * @param rows - maximum rows this panel may spend.
 * @returns lines for the live region, including a placeholder when no turn exists.
 */
export function timingLines(profile: TurnTiming | undefined, columns: number, rows = PANEL_ROWS): string[] {
  const height = Math.max(0, Math.min(PANEL_ROWS, rows))
  if (height === 0) return []
  const width = Math.max(1, Math.min(columns, chromeWidth(columns)))
  const headings = profile === undefined
    ? ['timing · no turn measured yet', 'timing · no turn yet', 'timing']
    : [
      `timing · turn ${String(profile.turn)} · ${formatSpan(profile.totalMs)}${profile.running ? ' · live' : ''}`,
      `timing · turn ${String(profile.turn)} · ${formatSpan(profile.totalMs)}`,
      `timing · turn ${String(profile.turn)}`,
      'timing',
    ]
  // Whole facts are dropped before the final fallback is cut. A heading ending
  // in `· 4` reads as a broken duration, not as a narrower version of one.
  const heading = headings.find(candidate => displayWidth(INDENT + candidate) <= width) ?? 'timing'
  const lines = [style(truncateToWidth(`${INDENT}${heading}`, width), 'cyan', 'bold')]
  if (profile === undefined || profile.spans.length === 0 || height === 1) return lines

  const bodyRows = height - 1
  const needsElision = profile.spans.length > bodyRows
  const shownCount = needsElision ? Math.max(0, bodyRows - 1) : bodyRows
  const shown = profile.spans.slice(0, shownCount)
  if (shown.length > 0) lines.push(...spanLines(shown, width))
  if (needsElision) {
    const hidden = profile.spans.length - shown.length
    lines.push(style(truncateToWidth(`${INDENT}… +${String(hidden)} more`, width), 'dim'))
  }
  return lines
}

/** Render measured rows after every untrusted label has been made safe. */
function spanLines(spans: readonly TurnSpan[], width: number): string[] {
  const safe = spans.map(span => escapeControls(span.label))
  const durations = spans.map(span => formatSpan(span.ms))
  const durationWidth = Math.max(...durations.map(displayWidth))
  const indentWidth = displayWidth(INDENT)
  const gap = Math.max(1, Math.min(FIELD_GAP, width - indentWidth - durationWidth - 1))
  const labelWidth = Math.max(1, Math.min(
    LABEL_COLUMNS,
    Math.max(...safe.map(displayWidth)),
    width - indentWidth - gap - durationWidth,
  ))
  const barCells = width - indentWidth - labelWidth - durationWidth - gap * 2
  const longest = Math.max(...spans.map(span => span.ms), 1)

  return spans.map((span, index) => {
    const cut = truncateToWidth(safe[index] ?? '', labelWidth)
    // Padded by DISPLAY width, not by string length: a label with a wide
    // character measures two columns per unit, and `padEnd` counts units.
    const label = `${cut}${' '.repeat(labelWidth - displayWidth(cut))}`
    const durationText = durations[index] ?? ''
    const duration = `${' '.repeat(durationWidth - displayWidth(durationText))}${durationText}`
    if (barCells < MIN_BAR_CELLS) {
      return `${INDENT}${style(label, 'dim')}${' '.repeat(gap)}${style(duration, span.running ? 'cyan' : 'dim')}`
    }
    // Any measured span rounds up to one cell, for the reason the context bar
    // does: a blank row beside a real duration reads as a drawing fault.
    const cells = Math.max(1, Math.round((span.ms / longest) * barCells))
    const bar = `${BAR_FULL.repeat(cells)}${' '.repeat(barCells - cells)}`
    return `${INDENT}${style(label, 'dim')}${' '.repeat(gap)}${style(bar, 'cyan')}${' '.repeat(gap)}${style(duration, span.running ? 'cyan' : 'dim')}`
  })
}

/**
 * Create the persistent timing slot.
 * @param timer - live event fold owned by this attachment.
 * @param enabled - window preference deciding whether the view contributes rows.
 * @returns a view that leaves the fixed status row beneath it.
 */
export function createTimingView(timer: TurnTimer, enabled: () => boolean): TuiSlotView {
  return {
    render(columns, rows = 24) {
      if (!enabled()) return []
      return timingLines(timer.snapshot(), columns, Math.max(0, rows - STATUS_ROWS))
    },
  }
}

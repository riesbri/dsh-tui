/**
 * Where a turn's time went.
 *
 * Every duration comes from the timestamps the session log already carries, not
 * from clock reads taken while drawing, so the chart reports the run rather than
 * the renderer's view of it.
 *
 * The one thing this deliberately does NOT claim is that the parts add up to the
 * whole. Tool calls in a step run concurrently and reasoning interleaves with
 * them across steps, so these are overlapping spans: their sum can exceed the
 * turn, and the difference is not idle time. That is why the bars are scaled
 * against the LARGEST span rather than against the turn's wall clock — a bar
 * measured against the total would be a picture asserting a partition that does
 * not exist. The wall clock sits in the header, where it makes no such claim.
 * @module dshline/profile
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { displayWidth, escapeControls, formatElapsed, style, truncateToWidth } from '@dshline/renderer'
import { chromeWidth } from './views.ts'

/** One measured span within a turn. */
export interface TurnSpan {
  /** What was running: `reasoning`, `output`, or a tool's name. */
  label: string
  /** Milliseconds the span covered. */
  ms: number
}

/** One finished turn, as the chart draws it. */
export interface TurnProfile {
  /** The turn's number, as the session log counts them. */
  turn: number
  /** Wall clock from `turn/start` to `turn/end`. */
  totalMs: number
  /** Spans worth drawing, longest first. */
  spans: readonly TurnSpan[]
}

/** Widest a label column grows before names are cut; beyond this the bars starve. */
const LABEL_COLUMNS = 14

/** Columns between the three fields, so nothing reads as one word. */
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
 * A span's duration, at a precision that keeps distinct spans distinct.
 *
 * `formatElapsed` floors to whole seconds, which is right for a status line
 * counting a turn up but wrong here: most tool calls finish in single-digit
 * seconds, and rounding them all to `3s` collapses the differences the chart
 * exists to show.
 * @param milliseconds - the span.
 * @returns e.g. `18.2s`, `1m 04s`.
 */
function formatSpan(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  if (value >= TENTHS_BELOW_MS) return formatElapsed(value)
  return `${(value / 1000).toFixed(1)}s`
}

/**
 * Collects timings for the turn in progress.
 *
 * Fed from the runner's LIVE event listener rather than from its shared
 * projection, and that is not an oversight. A resumed session's replay has no
 * `assistant/chunk` events at all — they are the streamed form of a message the
 * log also stores assembled, so replaying both would print every reply twice, and
 * the projection drops them. A profiler fed from the replay would therefore chart
 * every historical turn as though the model had thought for no time at all.
 */
export class TurnProfiler {
  /** When the open turn began, or undefined when no turn is being measured. */
  private startedAt: number | undefined
  private turn = 0
  /** First and last delta of one kind within one step, keyed `kind:step`. */
  private readonly streams = new Map<string, { first: number; last: number }>()
  /** Calls awaiting their result, keyed by call id. */
  private readonly pending = new Map<string, { name: string; at: number }>()
  /** Milliseconds spent in each tool, keyed by the tool's name. */
  private readonly tools = new Map<string, number>()

  /** Forget the open turn, so a partial measurement is never charted. */
  private reset(): void {
    this.startedAt = undefined
    this.streams.clear()
    this.pending.clear()
    this.tools.clear()
  }

  /**
   * Fold one live event in, and report a finished turn.
   *
   * A turn already running when measurement began is skipped rather than charted
   * from the middle: its `turn/start` was never seen, so its total would be the
   * time since the toggle rather than the time the turn took.
   * @param event - one committed session event.
   * @returns the finished profile on `turn/end`, otherwise undefined.
   */
  observe(event: SessionEvent): TurnProfile | undefined {
    if (event.type === 'turn/start') {
      this.reset()
      this.startedAt = event.time
      this.turn = event.data.turn
      return undefined
    }
    if (this.startedAt === undefined) return undefined
    if (event.type === 'assistant/chunk') {
      const { chunk, step } = event.data
      const kind = chunk.type === 'reasoning-delta' ? 'reasoning' : chunk.type === 'text-delta' ? 'output' : undefined
      if (kind === undefined) return undefined
      const key = `${kind}:${String(step)}`
      const span = this.streams.get(key)
      if (span === undefined) this.streams.set(key, { first: event.time, last: event.time })
      else span.last = event.time
      return undefined
    }
    if (event.type === 'tool/call') {
      this.pending.set(event.data.callId, { name: event.data.name, at: event.time })
      return undefined
    }
    if (event.type === 'tool/result') {
      // Paired by call id, exactly as the tool cards pair them: several calls can
      // be open at once, so the newest result does not belong to the newest call.
      const block = event.data.message.content[0]
      const call = this.pending.get(block.toolCallId)
      if (call === undefined) return undefined
      this.pending.delete(block.toolCallId)
      this.tools.set(call.name, (this.tools.get(call.name) ?? 0) + Math.max(0, event.time - call.at))
      return undefined
    }
    if (event.type !== 'turn/end') return undefined

    const spans = new Map<string, number>()
    for (const [key, span] of this.streams) {
      const label = key.slice(0, key.indexOf(':'))
      spans.set(label, (spans.get(label) ?? 0) + (span.last - span.first))
    }
    for (const [name, ms] of this.tools) spans.set(name, ms)
    const profile: TurnProfile = {
      turn: this.turn,
      totalMs: Math.max(0, event.time - this.startedAt),
      spans: [...spans]
        .map(([label, ms]) => ({ label, ms }))
        // A span of zero measured something real that finished inside one
        // timestamp; drawing it would put a bar against a duration of `0.0s`.
        .filter(span => span.ms > 0)
        .sort((left, right) => right.ms - left.ms),
    }
    this.reset()
    return profile
  }
}

/**
 * The chart, as lines to commit below the reply.
 * @param profile - a finished turn.
 * @param columns - the terminal's current width.
 * @returns lines to write into scrollback, or none when there was nothing to measure.
 */
export function profileLines(profile: TurnProfile, columns: number): string[] {
  if (profile.spans.length === 0) return []
  const width = chromeWidth(columns)
  // Tool names come from the model, so they are made safe BEFORE any width is
  // measured from them and long before any color is applied.
  const safe = profile.spans.map(span => escapeControls(span.label))
  const durations = profile.spans.map(span => formatSpan(span.ms))
  const durationWidth = Math.max(...durations.map(displayWidth))
  // The label column is cut to what is left after the duration, not only to
  // LABEL_COLUMNS. A cap alone is a cap on a terminal wide enough to honour it,
  // and on a narrow one the rows would run past the chrome every other element
  // lines up with.
  const labelWidth = Math.max(1, Math.min(
    LABEL_COLUMNS,
    Math.max(...safe.map(displayWidth)),
    width - displayWidth(INDENT) - FIELD_GAP - durationWidth,
  ))
  const rows = profile.spans.map((span, index) => ({
    label: truncateToWidth(safe[index] ?? '', labelWidth),
    duration: durations[index] ?? '',
    ms: span.ms,
  }))
  const barCells = width - displayWidth(INDENT) - labelWidth - durationWidth - FIELD_GAP * 2
  const longest = Math.max(...rows.map(row => row.ms))

  // The wall clock is dropped WHOLE when it will not fit, rather than cut: the
  // same rule the status line's hints follow, because `turn 14 · 4` reads as a
  // rendering fault and not as a duration.
  const heading = `${INDENT}turn ${String(profile.turn)}`
  const total = ` · ${formatSpan(profile.totalMs)}`
  const lines = [displayWidth(heading + total) <= width
    ? `${INDENT}${style(`turn ${String(profile.turn)}`, 'bold')}${style(total, 'gray')}`
    : `${INDENT}${style(truncateToWidth(`turn ${String(profile.turn)}`, width - displayWidth(INDENT)), 'bold')}`]
  for (const row of rows) {
    // Padded by DISPLAY width, not by string length: a label with a wide
    // character measures two columns per unit, and `padEnd` counts units.
    const label = `${row.label}${' '.repeat(labelWidth - displayWidth(row.label))}`
    const duration = `${' '.repeat(durationWidth - displayWidth(row.duration))}${row.duration}`
    if (barCells < MIN_BAR_CELLS) {
      // Too narrow for a picture, so the numbers alone: a one-cell bar beside
      // every row would say every span was the same length.
      lines.push(`${INDENT}${style(label, 'dim')}${' '.repeat(FIELD_GAP)}${style(duration, 'dim')}`)
      continue
    }
    // Any measured span rounds up to one cell, for the reason the context bar
    // does: a blank row beside a real duration reads as a drawing fault.
    const cells = Math.max(1, Math.round((row.ms / longest) * barCells))
    const bar = `${BAR_FULL.repeat(cells)}${' '.repeat(barCells - cells)}`
    lines.push(
      `${INDENT}${style(label, 'dim')}${' '.repeat(FIELD_GAP)}${style(bar, 'cyan')}${' '.repeat(FIELD_GAP)}${style(duration, 'dim')}`,
    )
  }
  return lines
}

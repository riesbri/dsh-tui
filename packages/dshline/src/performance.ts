/**
 * How this session actually ran: how much of it happened, and where its wall
 * clock went.
 *
 * Every figure here comes from Harness's `sessionStats` projection and nothing
 * else. `@deepseek-ai/dsh-session-stats` folds step boundaries, stream chunks,
 * tool pairs, and assembled assistant messages over the COMPLETE durable log,
 * so a resumed session reports the whole of itself rather than the part this
 * process happened to watch. dshline neither counts a step nor reads a clock:
 * the two averages below are one division each over totals the projection
 * already published, which is the only arithmetic this module does.
 *
 * That the projection is optional is the point. A profile that does not mount
 * the unit gets no performance FIGURES — the section still says so, in one line
 * — rather than a second dshline fold of the same events, which would be a
 * competing authority that disagrees with the first one the day upstream
 * changes what counts as a step.
 *
 * Nothing in this module knows about a terminal, a Context, or an agent, so all
 * of it is testable directly.
 * @module dshline/performance
 */

import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
// Type-only, and through the client-safe subpath: it carries the session-stats
// unit's `SessionProjectionMap` key without the host plugin's Context merge.
// The package is an ordinary `dependency` of this frontend, not a peer, because
// dshline's own bundle patch names and mounts it as a Cordis row — shipping the
// frontend ships the plugin it composes. What stays optional is the CAPABILITY:
// a composition may drop that row, and then the key is simply absent.
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import { formatElapsed } from '@dshline/renderer'

/** Below a second, milliseconds: a first token is a sub-second measurement. */
const MILLISECONDS_PER_SECOND = 1000

/** Below a minute, one decimal second; `2s` and `2.4s` are different answers here. */
const SECONDS_PRECISION_TO = 60 * MILLISECONDS_PER_SECOND

/** Below this rate one decimal carries information; above it the digit is noise. */
const RATE_DECIMALS_BELOW = 100

/**
 * What `/usage`'s performance section can truthfully report.
 *
 * Absent fields mean the projection has no denominator for them yet, never
 * zero: a session whose steps have not been first-token timed has no average
 * latency, and reporting `0ms` would claim an instant reply.
 */
export interface SessionPerformance {
  /** Whether this profile mounted the generic projection infrastructure. */
  readonly projections: boolean
  /** Harness's whole-log figures, when the `sessionStats` unit is registered. */
  readonly stats: SessionStatsProjection | undefined
  /** `ttftMs / ttftSteps`, or undefined when no step recorded a first token. */
  readonly averageTtftMs: number | undefined
  /** `decodeTokens / (decodeMs / 1000)`, or undefined with no decode time. */
  readonly decodeTokensPerSecond: number | undefined
}

/**
 * Whether one of Harness's summed wall times is a measurement at all.
 *
 * Zero is not a measured zero in this projection, and reading it as one is the
 * mistake this predicate exists to prevent. `llmMs` accrues only when a step
 * assembles an `assistant/message`, and `toolMs` only when a `tool/call` is
 * matched by its `tool/result`; a step that streamed for ten seconds and was
 * then cancelled assembles no message, and a tool call whose result never
 * landed is dropped at `turn/end`. Both leave the total at zero while real work
 * elapsed, so `model time 0ms` would claim something Harness never said.
 *
 * The counts are different and stay unconditional: `turns` and `steps` come
 * from `step/end`, which the agent loop appends in a `finally`, so a zero there
 * really does mean nothing closed.
 * @param ms - one summed wall time from the projection.
 * @returns whether anything contributed to it.
 */
export function isMeasured(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0
}

/**
 * Read this session's performance from one authoritative projection cut.
 *
 * The same cut `/usage` reads its token buckets from, so the projection-backed
 * usage buckets and performance figures cannot describe two different moments.
 * The pricing fold remains separate.
 * @param snapshot - the authoritative projection cut, or undefined when the profile mounts no registry.
 * @returns the reading, with every derived field absent unless it has a denominator.
 */
export function sessionPerformance(snapshot: ProjectionSnapshot | undefined): SessionPerformance {
  const stats = snapshot?.values.sessionStats
  if (stats === undefined) {
    return {
      projections: snapshot !== undefined,
      stats: undefined,
      averageTtftMs: undefined,
      decodeTokensPerSecond: undefined,
    }
  }
  return {
    projections: true,
    stats,
    averageTtftMs: mean(stats.ttftMs, stats.ttftSteps),
    decodeTokensPerSecond: mean(stats.decodeTokens, stats.decodeMs / MILLISECONDS_PER_SECOND),
  }
}

/**
 * One total divided by its own count, or nothing.
 *
 * A zero — or absent, or malformed — denominator has no average, and the guard
 * is here rather than at each call site because the two failure shapes differ:
 * `0 / 0` is `NaN` and `1 / 0` is `Infinity`, and both would reach a status
 * report as a figure. The projection's own schema admits only non-negative
 * finite numbers, so this guards a future generation's shape, not today's.
 * @param total - the summed quantity.
 * @param count - what it was summed over.
 * @returns the mean, or undefined when there is nothing to divide by.
 */
function mean(total: number, count: number): number | undefined {
  if (!Number.isFinite(total) || !Number.isFinite(count) || count <= 0) return undefined
  const value = total / count
  return Number.isFinite(value) ? value : undefined
}

/**
 * A duration at the precision the magnitude deserves.
 *
 * `formatElapsed` alone is wrong for half of these: it floors to whole seconds,
 * which is right for a session's model time and reports a 640ms first token as
 * `0s`. So sub-second durations keep their milliseconds, the seconds range
 * keeps one decimal, and anything longer hands over to the renderer's own
 * `m ss` vocabulary rather than inventing a second one.
 * @param ms - milliseconds.
 * @returns e.g. `640ms`, `4.2s`, `4m 12s`.
 */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms)
  if (value < MILLISECONDS_PER_SECOND) return `${String(Math.round(value))}ms`
  if (value < SECONDS_PRECISION_TO) return `${(value / MILLISECONDS_PER_SECOND).toFixed(1)}s`
  return formatElapsed(value)
}

/**
 * A decode throughput, without its unit.
 *
 * Bare, because the caller's label carries the `tok/s` — a report whose figures
 * are right-aligned in one column cannot afford a value that is wider than the
 * column for one row only.
 *
 * Deliberately an average over the whole session rather than a live rate: the
 * projection publishes summed decode time and summed output tokens, and the
 * only honest figure over two totals is the one that divides them. Nothing
 * here interpolates between Harness's updates to make it move more smoothly.
 * @param rate - tokens per second, or undefined when there is no decode time.
 * @returns e.g. `42.3`, `1240`, or undefined when there is nothing to report.
 */
export function formatTokenRate(rate: number | undefined): string | undefined {
  if (rate === undefined || !Number.isFinite(rate)) return undefined
  const value = Math.max(0, rate)
  return value < RATE_DECIMALS_BELOW ? value.toFixed(1) : String(Math.round(value))
}

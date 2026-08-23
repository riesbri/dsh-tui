/**
 * Activity indication.
 *
 * A spinner is the only part of the live region that changes without an event to
 * drive it, so it is a pure function of a tick counter the caller owns. Owning
 * the counter outside means the redraw timer can be started and stopped with the
 * work it reports, rather than running whenever the process is alive.
 * @module @dshline/renderer/spinner
 */

/** Braille frames, which advance smoothly at roughly ten frames a second. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Milliseconds a frame is shown; the caller's timer should match. */
export const SPINNER_INTERVAL_MS = 100

/**
 * The frame for one tick.
 * @param tick - a monotonically increasing counter; negative values are clamped.
 * @returns one spinner glyph.
 */
export function spinnerFrame(tick: number): string {
  const index = Math.max(0, Math.trunc(tick)) % FRAMES.length
  return FRAMES[index] ?? FRAMES[0]
}

/**
 * A duration in the compact form a status line wants: seconds under a minute,
 * then minutes and seconds.
 * @param milliseconds - elapsed time; negative values read as zero.
 * @returns e.g. `4s`, `1m 04s`.
 */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (totalSeconds < 60) return `${String(totalSeconds)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * A token count in the compact form a status line wants.
 * @param tokens - a non-negative count.
 * @returns e.g. `840`, `12.3k`, `1.2M`.
 */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.trunc(tokens))
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const thousands = value / 1000
    return `${thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))}k`
  }
  return `${(value / 1_000_000).toFixed(1)}M`
}

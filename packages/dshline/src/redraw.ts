/**
 * Coalescing scheduler for live-region repaints.
 *
 * Redraw requests arrive in bursts: a streamed reply lands several deltas per
 * poll cycle, and every capability feed invalidates alongside them. Painting
 * each request where it is made recomposes and rewrites the whole live region
 * once per request, for all but the last of which nobody can ever see a frame —
 * they are overtaken within the same event-loop turn. Scheduling the paint at
 * the check phase collapses each turn's requests into the one frame that ends
 * it, while staying inside the turn: input still sees its echo before the next
 * poll begins.
 *
 * `setImmediate`, not `queueMicrotask`: microtasks drain after every task, so
 * deltas delivered by separate stdin reads would still paint apart; only the
 * check phase has seen a whole polling cycle. Not `setTimeout(0)`: immediates
 * run before the next iteration's timers, keeping the collapse off the latency
 * of anything scheduled behind it.
 *
 * Two tradeoffs come with the turn's delay, both bounded by it. A commit stays
 * synchronous — scrollback order is not negotiable — so until the paint runs,
 * the region below freshly committed rows still shows the previous frame; both
 * writes land in the same cycle, and the next paint composes past them. And a
 * view that throws while rendering now throws at the check phase rather than
 * at the request site, which gives up one caller's catch block for the crash
 * the throw always was.
 * @module dshline/redraw
 */

/**
 * Runs at most one paint per event-loop turn, however many sources ask.
 *
 * The paint reads whatever is current when it runs — composition is deferred,
 * not captured — so requests absorbed by an already-scheduled paint lose
 * nothing but their own redundant frame.
 */
export class RedrawScheduler {
  /** Whether a paint is already scheduled for this turn. */
  private scheduled = false
  /** Set at teardown; a pending or future request then does nothing. */
  private stopped = false
  /** The queued check-phase callback, while one is pending. */
  private handle: NodeJS.Immediate | undefined

  /**
   * @param paint - draw the live region from current state. Called at most once
   *   per event-loop turn; a throw surfaces on the uncaught-exception path,
   *   not at the site that requested the paint — see the module's tradeoffs.
   */
  constructor(private readonly paint: () => void) {}

  /**
   * Request one repaint of the live region.
   *
   * Safe to call any number of times per turn: every call after the first is
   * absorbed by the paint already scheduled, which will read newer state than
   * any of the callers saw.
   */
  request(): void {
    if (this.scheduled || this.stopped) return
    this.scheduled = true
    this.handle = setImmediate(() => {
      this.handle = undefined
      this.scheduled = false
      if (!this.stopped) this.paint()
    })
  }

  /**
   * Paint immediately, outside the turn's coalescing.
   *
   * For destructive screen resets. After ctrl-l wipes the display there is no
   * frame on screen at all: a commit landing before the turn's paint would run
   * its erase against rows the terminal no longer holds, and until that paint
   * the reader is looking at a blank transcript besides. This is the one path
   * that cannot wait for the check phase. A pending request is absorbed rather
   * than left queued — the invariant stays one paint per turn, and the reset's
   * frame is the fresher one anyway — and later requests schedule normally.
   */
  now(): void {
    if (this.handle !== undefined) {
      clearImmediate(this.handle)
      this.handle = undefined
    }
    this.scheduled = false
    if (!this.stopped) this.paint()
  }

  /**
   * Cancel the pending paint and refuse every later one.
   *
   * Teardown owns this call. A paint running after the screen closed would
   * write into a terminal nobody owns any more, and the flag — not merely the
   * cancellation — is what also stops requests made after teardown from
   * scheduling a new one.
   */
  stop(): void {
    if (this.handle !== undefined) {
      clearImmediate(this.handle)
      this.handle = undefined
    }
    this.stopped = true
    this.scheduled = false
  }
}

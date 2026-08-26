/**
 * The pending-message mirror behind the status line's queued count.
 *
 * Steering a busy agent parks the prompt in one of its durable pending-message
 * lists, and Harness consumes it silently at the next step boundary — which on
 * a tool-heavy turn can be minutes after the reader pressed enter. The event
 * stream records every mutation as a normalized array splice, so the count of
 * prompts the reader has submitted but the agent has not taken yet is a plain
 * fold over that feed: no second store, no polling of the agent, and nothing
 * this module invents. It mirrors only what `agent/inbox/spliced` already says.
 *
 * The mirror lives for one attachment. A reopened session starts empty even if
 * the inbox it reattaches to does not: the count is live chrome like the
 * spinner, not state recovered from the log, and the next splice corrects it.
 * @module dshline/inbox
 */

/**
 * One normalized mutation of an agent's pending-message lists — the payload of
 * Harness's `agent/inbox/spliced` session event, read structurally so this
 * module stays decoupled from the agent package's release cadence.
 */
export interface InboxSplice {
  /** Which pending list changed. */
  readonly target: string
  /** Index the mutation starts at, as an array splice would receive it. */
  readonly start: number
  /** How many entries the mutation removed, when it removed any. */
  readonly removedCount?: number
  /** The entries inserted at `start`, in order. */
  readonly inserted: ReadonlyArray<{
    readonly source?: { readonly kind?: string }
  }>
}

/**
 * Mirror the two pending lists well enough to count steered prompts.
 *
 * Whole entries are mirrored, not just a running total, because removals name a
 * span (`start` plus `removedCount`) rather than their content: a step boundary
 * that drains one synthetic injection while leaving a steering prompt parked
 * would otherwise make a bare counter drift downward past the truth. Replaying
 * the splices against a local array answers exactly which sources remain.
 */
export class InboxMirror {
  /** Mirrored entries per target list, in list order. */
  private readonly lists = new Map<string, Array<'user' | 'other'>>()

  /**
   * Apply one normalized mutation from the event feed.
   * @param splice - the event's payload, verbatim.
   */
  spliced(splice: InboxSplice): void {
    const list = this.lists.get(splice.target) ?? []
    // Clamp the span at the array's end: an event describing more removals than
    // this mirror holds (a mirror that attached mid-turn) must not shift the
    // insertion point into imaginary positions.
    const start = Math.min(splice.start, list.length)
    const removed = Math.min(splice.removedCount ?? 0, list.length - start)
    list.splice(start, removed, ...splice.inserted.map(entry => entry.source?.kind === 'user'
      ? 'user' as const
      : 'other' as const))
    this.lists.set(splice.target, list)
  }

  /**
   * How many prompts the reader typed are still parked across both lists.
   * @returns the count; zero once the agent has taken everything.
   */
  steered(): number {
    let total = 0
    for (const list of this.lists.values()) {
      for (const entry of list) {
        if (entry === 'user') total += 1
      }
    }
    return total
  }
}

/**
 * Submitted-line history for the composer.
 *
 * The composer stays a dumb editable buffer: it knows how to insert, delete, and
 * move, and it does not know which of its contents were ever sent. This class is
 * the memory around it — a list of submitted lines plus a navigation position —
 * and the runner asks it for a value before every up/down arrow the completion
 * list did not take.
 *
 * The rule that is easy to get wrong is the draft. Stepping back from a
 * half-typed line must not throw that line away, so the first step back captures
 * it and the step forward past the newest entry returns it. Only a new
 * submission, or an edit made while a history entry is showing, replaces it.
 * @module @riesbri/dsh-tui/history
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { textOf } from './transcript.ts'

/** One submitted line, plus the navigation position around it. */
export class InputHistory {
  /** Submissions in chronological order; a consecutive repeat collapses to one. */
  private readonly entries: string[] = []
  /** Index of the entry on screen, or `entries.length` while at the draft. */
  private cursor = 0
  /** The draft captured when navigation first stepped into history. */
  private draft: string | undefined

  /**
   * Whether the cursor is showing a stored entry rather than the draft.
   *
   * Exposed as the one read-only fact the input router needs to decide who owns
   * the vertical arrows: arrows stay with history while it is traversing an
   * entry, and fall to the composer's own vertical movement once it is back at
   * the draft — even when that draft is a multiline prompt an entry was recalled
   * over. Internal cursor indices are deliberately not exposed.
   */
  get navigating(): boolean {
    return this.cursor < this.entries.length
  }

  /**
   * Record a submitted line.
   *
   * Empty lines never enter, and a line identical to the one just recorded is
   * not stored again — `run tests` submitted three times is one entry rather
   * than three. Recording is also the point where navigation restarts: a
   * submission returns the composer to a fresh draft, so the next up arrow
   * walks from the newest entry rather than from wherever the last walk stopped.
   * @param text - the submitted text.
   */
  record(text: string): void {
    if (text === '') return
    if (this.entries[this.entries.length - 1] !== text) this.entries.push(text)
    // Reset even when the line was a duplicate: a submission ends navigation
    // whether or not it added an entry, so the next up arrow walks from the
    // newest line rather than from wherever the last walk had stopped.
    this.cursor = this.entries.length
    this.draft = undefined
  }

  /**
   * Step back to the next older entry.
   *
   * The first step back captures the current draft, which is what makes it
   * possible to return to it. Stepping back from the oldest entry returns
   * undefined and changes nothing, so the arrow falls through to the composer,
   * which ignores it.
   * @param currentDraft - the composer's text when navigation begins.
   * @returns the entry to show, or undefined when there is no older one.
   */
  previous(currentDraft: string): string | undefined {
    if (this.entries.length === 0) return undefined
    if (this.cursor === this.entries.length) this.draft = currentDraft
    if (this.cursor === 0) return undefined
    this.cursor -= 1
    return this.entries[this.cursor]
  }

  /**
   * Step forward to the next newer entry, or back to the saved draft.
   *
   * Past the newest entry the saved draft is returned rather than undefined,
   * because a draft is a thing to restore, not delete. At the draft already,
   * undefined tells the runner there is nowhere further forward to go.
   * @returns the entry or draft to show, or undefined when already at the draft.
   */
  next(): string | undefined {
    if (this.cursor === this.entries.length) return undefined
    this.cursor += 1
    if (this.cursor === this.entries.length) return this.draft
    return this.entries[this.cursor]
  }

  /**
   * Return to the draft and forget the one that was saved.
   *
   * Called when the composer is edited by anything other than history itself, so
   * the next up arrow captures the edited text as the new draft instead of
   * restoring the line that was showing before the edit.
   */
  reset(): void {
    this.cursor = this.entries.length
    this.draft = undefined
  }
}

/**
 * Reconstruct the submitted lines a durable session log carries.
 *
 * Two event kinds are human submissions: a `user/message` whose source is
 * `user`, and a `command/run` that recorded its input. A command that suppressed
 * its input is skipped rather than reconstructed as a bare `/name`, because that
 * would put a line into history the user never typed. The result is fed into
 * {@link InputHistory.record} in log order, so the duplicate rule and the
 * newest-first navigation behave for a reopened session exactly as they did
 * while it was being typed.
 * @param events - a session log, in order.
 * @returns the submitted lines, oldest first.
 */
export function historyLines(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const text = textOf(event.data.content).trim()
      if (text !== '') lines.push(text)
    } else if (event.type === 'command/run') {
      if (event.data.args === undefined) continue
      lines.push(`/${event.data.name}${event.data.args.trimEnd()}`)
    }
  }
  return lines
}

/**
 * The vertical-arrow decision shared by completion, history, and the composer.
 *
 * All three want the same pair of keys, and the runner's answer has to be a
 * single ordering rather than three handlers that might all move. It is: a
 * visible completion list keeps the arrows; otherwise a history that is ALREADY
 * being traversed keeps them; otherwise the composer tries vertical cursor
 * movement through its own wrapped rows; and only once that cannot go any
 * farther up does `↑` step into history. `↓` never invents newer history from a
 * fresh draft.
 *
 * Extracted from the session loop because the loop itself cannot be unit-tested
 * (it needs a terminal and an agent), while this decision is testable with the
 * real completion, history, and composer objects.
 * @module dshline/input
 */

import type { Composer, Key } from 'dshline-renderer'
import { sanitizePasted } from 'dshline-renderer'
import type { Completion } from './completion.ts'
import { InputHistory } from './history.ts'

/** Who consumed the key, after the overlay has declined it. */
export type InputRoute = 'completion' | 'history' | 'vertical' | 'composer'

/**
 * How to measure the composer, shared with the view that renders it.
 *
 * Both use the same width and gutter so the movement decision agrees with the
 * cursor the view draws.
 */
export interface ComposerGeometry {
  /** Display-column budget per visual row, including the gutter. */
  readonly width: number
  /** The gutter handed to the layout for each logical line. */
  gutter(line: number): string
}

/**
 * Offer one key to completion, to history, then to vertical movement, in order.
 *
 * History writes into the composer through {@link Composer.set}, which does not
 * sanitize, so a seeded entry from a session log is made safe here exactly as a
 * paste would be — the composer's buffer must stay safe to draw. A recalled line
 * does not recompute completion, so a recalled candidate does not steal the next
 * arrow press. When nothing claims the key, the caller hands it to the composer.
 *
 * The composer's own `↑`/`↓` move the cursor one visual row through the wrapped
 * buffer and are routed here rather than through `Composer.handle`, which knows
 * nothing about rows; they only fall through to history once vertical movement
 * has no more rows upward to offer.
 * @param key - the decoded keystroke.
 * @param composer - the buffer being edited; movement and history rewrite it.
 * @param completion - the live completion state, consulted first.
 * @param history - the input history, consulted for the vertical arrows.
 * @param geometry - the composer's width and gutter, for vertical movement.
 * @returns which handler consumed the key.
 */
export function routeInputKey(
  key: Key,
  composer: Composer,
  completion: Completion,
  history: InputHistory,
  geometry: ComposerGeometry,
): InputRoute {
  if (completion.active && completion.handleKey(key)) return 'completion'
  if (key.kind !== 'key' || (key.name !== 'up' && key.name !== 'down')) return 'composer'
  const isUp = key.name === 'up'
  // Already walking history: arrows keep walking it, even when the recalled entry
  // itself wraps onto several rows. Recovery past the newest entry is the draft,
  // and once back there the next arrow is the composer's again.
  if (history.navigating) {
    const value = isUp ? history.previous(composer.value) : history.next()
    if (value !== undefined) {
      completion.invalidate()
      composer.set(sanitizePasted(value))
      return 'history'
    }
    // `up` at the oldest entry has nothing older; the composer keeps ignoring it.
    return 'composer'
  }
  // At the draft: try moving within the buffer before reaching for history at all.
  const moved = isUp ? composer.moveUp(geometry.width, geometry.gutter) : composer.moveDown(geometry.width, geometry.gutter)
  if (moved) return 'vertical'
  // Up at the topmost row is the one place the draft hands over to history. Down
  // at the bottom has no newer entry to enter from a fresh draft.
  if (isUp) {
    const value = history.previous(composer.value)
    if (value !== undefined) {
      completion.invalidate()
      composer.set(sanitizePasted(value))
      return 'history'
    }
  }
  return 'composer'
}

/**
 * The vertical-arrow decision shared by completion and history.
 *
 * Both features want the same pair of keys, and the runner's answer has to be a
 * single ordering rather than two handlers that might both move. It is: a
 * visible completion list keeps the arrows; otherwise the arrows walk history.
 * The composer comes last, as it always has.
 *
 * Extracted from the session loop because the loop itself cannot be unit-tested
 * (it needs a terminal and an agent), while this decision is testable with the
 * real completion and history objects.
 * @module @riesbri/dsh-tui/input
 */

import type { Composer, Key } from '@riesbri/dsh-tui-renderer'
import { sanitizePasted } from '@riesbri/dsh-tui-renderer'
import type { Completion } from './completion.ts'
import { InputHistory } from './history.ts'

/** Who consumed the key, after the overlay has declined it. */
export type InputRoute = 'completion' | 'history' | 'composer'

/**
 * Offer one key to completion, then to history, in that order.
 *
 * History writes into the composer through {@link Composer.set}, which does not
 * sanitize, so a seeded entry from a session log is made safe here exactly as a
 * paste would be — the composer's buffer must stay safe to draw. When neither
 * completion nor history claims the key, the caller hands it to the composer.
 * @param key - the decoded keystroke.
 * @param composer - the buffer being edited; history navigation rewrites it.
 * @param completion - the live completion state, consulted first.
 * @param history - the input history, consulted for the vertical arrows.
 * @returns which handler consumed the key.
 */
export function routeInputKey(
  key: Key,
  composer: Composer,
  completion: Completion,
  history: InputHistory,
): InputRoute {
  if (completion.active && completion.handleKey(key)) return 'completion'
  if (key.kind === 'key' && key.name === 'up') {
    const value = history.previous(composer.value)
    if (value !== undefined) {
      // The composer is about to be replaced, so any lookup started against the
      // old text is abandoned — without recomputing, which would reopen a list
      // for the recalled line and steal the next arrow press.
      completion.invalidate()
      composer.set(sanitizePasted(value))
      return 'history'
    }
  }
  if (key.kind === 'key' && key.name === 'down') {
    const value = history.next()
    if (value !== undefined) {
      completion.invalidate()
      composer.set(sanitizePasted(value))
      return 'history'
    }
  }
  return 'composer'
}

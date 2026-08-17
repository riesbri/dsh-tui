/**
 * The chrome: a banner, a framed composer, and a status line.
 *
 * All of it is ordinary slot registrations with no privileged access to the
 * runner, so a deployment that wants different chrome disables these and
 * registers its own.
 * @module @riesbri/dsh-tui/views
 */

import { basename } from 'node:path'
import type { Composer, LiveCursor, StyleName } from '@riesbri/dsh-tui-renderer'
import {
  BOX_CHROME_COLUMNS,
  box,
  displayWidth,
  formatElapsed,
  formatTokens,
  spinnerFrame,
  style,
  truncateToWidth,
  wrapToWidth,
} from '@riesbri/dsh-tui-renderer'
import type { TuiSlotView } from './slots.ts'

/** What the status line reports; the runner owns the values. */
export interface StatusState {
  /** Whether the agent is working. */
  busy: boolean
  /** Spinner tick, advanced by the runner's timer while busy. */
  tick: number
  /** Milliseconds since the current turn started, or undefined when idle. */
  elapsedMs: number | undefined
  /** Model id alone; the provider route is in the banner. */
  model: string | undefined
  /** Current context pressure in tokens, when the meter is mounted. */
  tokens: number | undefined
  /** The model's context window, when the adapter reported one. */
  contextWindow: number | undefined
}

/** The composer's prompt, inside the frame. */
const PROMPT = '› '

/** Widest the chrome will draw, so a maximized terminal keeps readable lines. */
const MAX_COLUMNS = 100


/** Context fill at which the pressure reading warns. */
const PRESSURE_WARN = 0.7

/** Context fill at which it alarms. */
const PRESSURE_ALARM = 0.9

/**
 * Chrome width for a terminal of `columns`, leaving a column of breathing room.
 * Every framed element shares it so their edges line up.
 * @param columns - the terminal's width.
 * @returns the width every framed element uses.
 */
export function chromeWidth(columns: number): number {
  return Math.max(BOX_CHROME_COLUMNS + 8, Math.min(columns - 1, MAX_COLUMNS))
}

/**
 * The framed input line.
 *
 * The cursor is reported relative to this view because the frame means the
 * composer is no longer the region's last row, and the runner should not have to
 * know how tall a border is.
 * @param composer - the buffer being edited.
 * @param workspace - session workspace, whose basename titles the frame.
 * @returns the slot view.
 */
export function createComposerView(composer: Composer, workspace: string): TuiSlotView {
  const label = basename(workspace) === '' ? workspace : basename(workspace)
  const inner = (columns: number): number => chromeWidth(columns) - BOX_CHROME_COLUMNS
  const content = (columns: number): string[] => {
    const text = composer.isEmpty ? style('ask anything', 'gray') : composer.value
    return wrapToWidth(`${PROMPT}${text}`, inner(columns))
  }
  return {
    // A blank line above separates the frame from whatever the transcript just
    // committed, so a reply and the input box do not read as one block.
    render: columns => ['', ...box(content(columns), {
      width: chromeWidth(columns),
      title: style(label, 'cyan'),
      border: text => style(text, 'gray'),
    })],
    cursor: (columns): LiveCursor => {
      const before = displayWidth(PROMPT) + composer.cursorColumn
      // Row 0 is the separating blank and row 1 the top border, so content starts
      // at row 2; the buffer wraps inside the frame, so which wrapped line the
      // cursor falls on is its offset divided by the inner width.
      return {
        row: 2 + Math.floor(before / inner(columns)),
        column: 2 + (before % inner(columns)),
      }
    },
  }
}

/**
 * Colour for a context reading: quiet until the window is most of the way full,
 * then warning, then alarm — so the number is ignorable until it matters.
 * @param tokens - current pressure.
 * @param window - the model's context window, when known.
 * @returns the style to apply.
 */
function pressureStyle(tokens: number, window: number | undefined): StyleName {
  if (window === undefined || window <= 0) return 'dim'
  const fill = tokens / window
  if (fill >= PRESSURE_ALARM) return 'red'
  if (fill >= PRESSURE_WARN) return 'yellow'
  return 'dim'
}

/**
 * The status line under the composer.
 * @param state - a getter for the current values, read at render time.
 * @returns the slot view.
 */
export function createStatusView(state: () => StatusState): TuiSlotView {
  return {
    render(columns) {
      const current = state()
      const parts: string[] = []
      if (current.busy) {
        const elapsed = current.elapsedMs === undefined ? '' : ` ${formatElapsed(current.elapsedMs)}`
        parts.push(style(`${spinnerFrame(current.tick)} working${elapsed}`, 'yellow'))
      } else {
        parts.push(`${style('●', 'green')}${style(' ready', 'dim')}`)
      }
      if (current.model !== undefined) parts.push(style(current.model, 'dim'))
      if (current.tokens !== undefined) {
        const window = current.contextWindow === undefined ? '' : `/${formatTokens(current.contextWindow)}`
        parts.push(style(
          `${formatTokens(current.tokens)}${window}`,
          pressureStyle(current.tokens, current.contextWindow),
        ))
      }
      parts.push(style(current.busy ? 'ctrl-c interrupt' : '/model · ctrl-d quit', 'gray'))
      return [`  ${truncateToWidth(parts.join(style(' · ', 'gray')), Math.max(10, columns - 2))}`]
    },
  }
}

/**
 * The opening banner, committed once above the live region rather than
 * registered as a slot: it belongs to scrollback, not to the redrawn area.
 * @param workspace - the session workspace.
 * @param model - provider route and model id, when a selection exists.
 * @param version - this bundle's version.
 * @param columns - the terminal's current width.
 * @returns lines to commit.
 */
export function bannerLines(
  workspace: string,
  model: string | undefined,
  version: string,
  columns: number,
): string[] {
  const rows = [
    `${style('dsh-tui', 'bold', 'cyan')} ${style(version, 'gray')}`,
    style(workspace, 'dim'),
    style(model ?? 'no model configured', 'dim'),
  ]
  return [...box(rows, { width: chromeWidth(columns), border: text => style(text, 'gray') }), '']
}

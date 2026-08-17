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
  chunkToWidth,
  displayWidth,
  formatElapsed,
  formatTokens,
  spinnerFrame,
  style,
  truncateToWidth,
  wrapToWidth,
} from '@riesbri/dsh-tui-renderer'
import type { CardDetail } from './cards.ts'
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
  /** How much of a tool card is drawn, cycled with `ctrl-o`. */
  detail: CardDetail
}

/** The composer's prompt, inside the frame. */
const PROMPT = '› '

/** Gutter for a continuation line, aligning it under the prompt. */
const CONTINUATION = '  '

/** Widest the chrome will draw, so a maximized terminal keeps readable lines. */
const MAX_COLUMNS = 100

/**
 * Rows the composer's content may occupy before it scrolls.
 *
 * The live region is redrawn by climbing rows, so it has to stay shorter than the
 * screen: rows that have already scrolled off cannot be reached or erased, and the
 * next redraw then leaves duplicate composer rows in scrollback and can clear
 * unrelated output. An uncapped composer reaches that on an ordinary action —
 * pasting twenty short lines into a twenty-four-row terminal — so the content
 * scrolls around the cursor instead, which is what any editor does.
 */
const COMPOSER_ROWS = 10


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
  /** Columns of gutter before a logical line: the prompt, or an aligned indent. */
  const gutter = (line: number): string => (line === 0 ? PROMPT : CONTINUATION)

  /**
   * Every rendered row of the buffer, and which of them holds the cursor.
   *
   * Rows are CHUNKED at the width rather than wrapped at spaces, and that choice is
   * what makes the cursor placeable at all. Chunking is prefix-consistent — the rows
   * for the text before the cursor are the first rows for the whole line — so
   * locating the cursor is a matter of chunking that prefix. Word wrapping has no
   * such property: typing one more character can pull a whole word onto the next
   * row, moving a break that is BEFORE the cursor, so a prefix laid out on its own
   * disagrees with the same prefix inside the finished line and the cursor lands on
   * the wrong row.
   *
   * It is also how a terminal's own line editing behaves: a row breaks where the
   * screen runs out, and a character appears in the column it was typed in.
   * @param columns - the terminal's current width.
   * @returns the rows and the cursor's row and column within them.
   */
  const layout = (columns: number): { rows: string[]; row: number; column: number } => {
    const width = inner(columns)
    const rows: string[] = []
    let row = 0
    let column = 0
    composer.lines.forEach((line, index) => {
      const wrapped = chunkToWidth(`${gutter(index)}${line}`, width)
      if (index === composer.cursorLine) {
        // The rows of the text BEFORE the cursor are, by prefix consistency, the
        // first rows of this line — so their count is the cursor's row and the last
        // one's width is its column.
        const prefix = chunkToWidth(`${gutter(index)}${line.slice(0, composer.cursorColumn)}`, width)
        row = rows.length + prefix.length - 1
        column = displayWidth(prefix.at(-1) ?? '')
        // A prefix that exactly fills its row leaves the cursor one column past the
        // last cell, which would sit on the frame's border. It belongs at the start
        // of the next row, as it would in any editor.
        if (column >= width) {
          row += 1
          column = 0
        }
      }
      rows.push(...wrapped)
    })
    // A cursor that rolled past the last row needs a row to sit on, or the screen
    // clamps it onto the frame's bottom border. An editor shows the same empty row.
    if (row >= rows.length) rows.push('')
    return { rows, row, column }
  }

  /**
   * The rows to draw, scrolled so the cursor's row is visible.
   * @param all - every wrapped row of the buffer.
   * @param row - the cursor's row within them.
   * @returns the visible rows and how many were scrolled past above them.
   */
  const window = (all: readonly string[], row: number): { rows: readonly string[]; offset: number } => {
    if (all.length <= COMPOSER_ROWS) return { rows: all, offset: 0 }
    // Keep the cursor's row in view, preferring to show what follows it: a person
    // pasting or typing is working at the end.
    const offset = Math.min(all.length - COMPOSER_ROWS, Math.max(0, row - COMPOSER_ROWS + 1))
    return { rows: all.slice(offset, offset + COMPOSER_ROWS), offset }
  }

  return {
    // A blank line above separates the frame from whatever the transcript just
    // committed, so a reply and the input box do not read as one block.
    render: columns => {
      if (composer.isEmpty) {
        return ['', ...box(chunkToWidth(`${PROMPT}${style('ask anything', 'gray')}`, inner(columns)), {
          width: chromeWidth(columns),
          title: style(label, 'cyan'),
          border: text => style(text, 'gray'),
        })]
      }
      const { rows, row } = layout(columns)
      const shown = window(rows, row)
      const hidden = rows.length - shown.rows.length
      return ['', ...box([...shown.rows], {
        width: chromeWidth(columns),
        title: hidden > 0
          ? `${style(label, 'cyan')} ${style(`+${String(hidden)} rows`, 'gray')}`
          : style(label, 'cyan'),
        border: text => style(text, 'gray'),
      })]
    },
    cursor: (columns): LiveCursor => {
      if (composer.isEmpty) return { row: 2, column: 2 + displayWidth(PROMPT) }
      const { rows, row, column } = layout(columns)
      const shown = window(rows, row)
      // Row 0 is the separating blank and row 1 the top border, so content starts
      // at row 2, and the placement is relative to the visible window.
      return { row: 2 + row - shown.offset, column: 2 + column }
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
      // Only the non-default levels are reported: naming the default on every
      // frame spends a column on a fact the user did not ask about.
      if (current.detail !== 'compact') parts.push(style(`tools ${current.detail}`, 'yellow'))
      parts.push(style(current.busy ? 'ctrl-c interrupt' : 'alt-enter newline · ctrl-o tool output · /model · ctrl-d quit', 'gray'))
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

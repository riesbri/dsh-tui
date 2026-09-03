/**
 * Shared presentation chrome for dshline's visual root.
 * @module dshline/chrome
 */

import { BOX_CHROME_COLUMNS, displayWidth, frame, paint } from '@dshline/renderer'

/** Widest the chrome will draw, so a maximized terminal keeps readable lines. */
const MAX_COLUMNS = 100

/**
 * Narrowest terminal that still gets the normal framed chrome.
 *
 * Below this, {@link chromeWidth} would ask for a frame wider than the
 * terminal itself — safe for `frame()`, which leaves the width choice to its
 * caller, but not for a live-region view: `Screen` re-wraps an overlong
 * logical row into several physical ones, which invalidates the live-region
 * height budgeting done above it. Presentation that draws the root live
 * region (the composer, the status line) must fall back to something bounded
 * by the terminal itself below this floor, rather than asking for this width.
 * The one shared definition, so the floor is not a literal repeated at every
 * call site that needs to know it.
 */
export const CHROME_MIN_COLUMNS = BOX_CHROME_COLUMNS + 8

/** One rendering of the dshline visual root. */
export interface RootFrameOptions {
  /** The terminal's current width; the frame width is derived from it. */
  readonly columns: number
  /** Right-hand label: already escaped and styled by the caller. It may be truncated. */
  readonly context: string
  /** Body rows: already fitted to the frame's inner width and safe. */
  readonly body: readonly string[]
  /** One-row help for the bottom border, already fitted (see fitFooterHelp). */
  readonly footer?: string
}

/**
 * Chrome width for a terminal of `columns`, leaving a column of breathing room.
 * Every framed element shares it so their edges line up.
 * @param columns - the terminal's width.
 * @returns the width every framed element uses.
 */
export function chromeWidth(columns: number): number {
  return Math.max(CHROME_MIN_COLUMNS, Math.min(columns - 1, MAX_COLUMNS))
}

/**
 * Draw dshline's shared visual root around already-prepared content.
 * @param options - terminal width, right context, body rows, and optional footer help.
 * @returns the framed rows, including the integrated top and bottom borders.
 */
export function rootFrame(options: RootFrameOptions): string[] {
  return frame(options.body, {
    width: chromeWidth(options.columns),
    title: paint('dshline', 'banner'),
    rightTitle: options.context,
    // Help inside the bottom border stays muted, as the old external help rows
    // were; unstyled it would be the loudest text on the whole line.
    ...(options.footer === undefined ? {} : { footer: paint(options.footer, 'muted') }),
    border: text => paint(text, 'chrome'),
  })
}

/**
 * Display columns available to a root-frame footer label.
 * @param columns - the terminal's current width.
 * @returns the footer label budget granted by the renderer's frame geometry.
 */
export function footerBudget(columns: number): number {
  return Math.max(1, chromeWidth(columns) - 6)
}

/**
 * Fit navigation help without ever showing a misleading partial instruction.
 *
 * The budget is a DISPLAY-COLUMN width, not a terminal width: callers derive it
 * from {@link footerBudget}, so fitting here never re-derives a smaller frame
 * from an already-shrunk number.
 * @param text - help segments separated by ` · `, ordered least to most essential.
 * @param budget - columns available for the help, usually {@link footerBudget}.
 * @returns whole trailing segments, the `esc` fallback, or nothing.
 */
export function fitFooterHelp(text: string, budget: number): string {
  const width = Math.max(1, budget)
  const segments = text.split(' · ')
  while (segments.length > 1 && displayWidth(segments.join(' · ')) > width) segments.shift()

  const remainder = segments.join(' · ')
  if (displayWidth(remainder) <= width) return remainder

  const last = segments.at(-1) ?? ''
  if (displayWidth(last) <= width) return last
  if (displayWidth('esc') <= width) return 'esc'
  return ''
}

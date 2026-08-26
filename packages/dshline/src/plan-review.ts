/**
 * The plan-review overlay.
 *
 * A completed plan is the decision a person needs to make, not incidental
 * detail on an option picker. The live region cannot safely grow past the
 * terminal, so this overlay keeps a height-aware window over rendered plan rows
 * and offers a compact decision-only form when even its fixed chrome cannot fit.
 * @module dshline/plan-review
 */

import type { Key } from '@dshline/renderer'
import { BOX_CHROME_COLUMNS, displayWidth, escapeControls, paint, renderMarkdown, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import { RowViewport } from './scroll.ts'
import type { TuiOverlay } from './slots.ts'

/**
 * Largest document window shown in a tall terminal.
 *
 * More rows make a long plan easier to scan, but every one remains in the live
 * region that Screen must climb back over on redraw. Ten leaves room for the
 * decision chrome in a conventional twenty-four-row terminal.
 */
const MAX_PLAN_ROWS = 10

/**
 * Rows outside the plan document in the normal review layout.
 *
 * They are the leading blank, two frame borders, question, counter, and two plan
 * spacers. Choices and their selected description are counted
 * separately because they vary with the request.
 */
const PLAN_REVIEW_FIXED_ROWS = 7

/** Rows the readable compact box and its controls occupy. */
const COMPACT_REVIEW_ROWS = 5

/** One answer offered by the plan-mode review tool. */
export interface PlanReviewChoice {
  /** Value returned to the caller when this choice is confirmed. */
  readonly value: string
  /** Label a person sees for this choice. */
  readonly label: string
  /** Consequence of this choice, when the caller supplied one. */
  readonly description?: string
}

/** Everything the plan-review overlay needs to render and settle. */
export interface PlanReviewSpec {
  /** Markdown plan submitted by the model for approval. */
  readonly plan: string
  /** The decision the caller is asking the person to make. */
  readonly question: string
  /** Choices supplied by the caller; the first is selected initially. */
  readonly choices: readonly PlanReviewChoice[]
  /** Called once with the selected value, or undefined after cancellation. */
  settle(value: string | undefined): void
  /** Asks the runner to redraw after scrolling or changing the selected choice. */
  invalidate(): void
}

/**
 * Rows the normal layout may give to the plan document.
 * @param terminalRows - terminal height in physical rows.
 * @param choiceCount - decision rows beneath the plan.
 * @param hasDescription - whether the selected choice adds its consequence row.
 * @returns plan rows available without exceeding the terminal, capped for redraw safety.
 */
function normalPlanRows(terminalRows: number, choiceCount: number, hasDescription: boolean): number {
  const fixedRows = PLAN_REVIEW_FIXED_ROWS + choiceCount + (hasDescription ? 1 : 0)
  return Math.min(MAX_PLAN_ROWS, Math.max(0, terminalRows - fixedRows))
}

/**
 * Make caller-supplied supporting text one physical frame row.
 *
 * A newline is safe text but would make the fixed layout budget false: the frame
 * would expand it into another row after the viewport had already decided how
 * much room the plan owns. Replacing it is the only honest compact rendering of
 * a label or question; the plan itself keeps its intentional markdown rows.
 * @param text - untrusted caller-supplied text.
 * @param width - available display columns.
 * @returns escaped, one-row text no wider than the frame.
 */
function oneRow(text: string, width: number): string {
  return truncateToWidth(escapeControls(text).replaceAll('\n', ' '), width)
}

/**
 * The decision row, fitted to a width that keeps the closing glyph in view.
 * @param selected - the current choice.
 * @param width - the row's display-column budget.
 * @returns one bounded row.
 */
function decisionLine(selected: PlanReviewChoice | undefined, width: number): string {
  // Fourteen fixed columns: `Decision: `, `‹ `, and ` ›`. Budgeting the label
  // against that keeps the whole row inside `width` instead of letting a
  // truncation of the assembled line drop the closing glyph and read as one.
  const label = oneRow(selected?.label ?? 'Decision', Math.max(1, width - 14))
  return truncateToWidth(
    `${paint('Decision: ', 'muted')}${paint(`‹ ${label} ›`, 'selection')}`,
    Math.max(1, width),
  )
}

/** Count the physical terminal rows Screen will draw for candidate live-region lines. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * Render the completed plan as a bounded, scrollable review overlay.
 *
 * @param spec - plan content, decision choices, and callbacks.
 * @returns an overlay that scrolls with up/down and changes the choice with tab or arrows.
 */
export function createPlanReviewOverlay(spec: PlanReviewSpec): TuiOverlay {
  const viewport = new RowViewport()
  let choice = 0
  let settled = false

  /** Settle no more than once, as terminal input can arrive after dismissal. */
  const settle = (value: string | undefined): void => {
    if (settled) return
    settled = true
    spec.settle(value)
  }

  /** The plan's physical terminal rows, with markdown made safe before styling. */
  const planRows = (columns: number): string[] => {
    const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
    return renderMarkdown(spec.plan).flatMap(line => wrapToWidth(line, inner))
  }

  /** Page the document by one viewport and repaint only when it genuinely moved. */
  const page = (direction: 1 | -1): void => {
    if (viewport.page(direction)) spec.invalidate()
  }

  /** Jump to a document end and repaint only when it genuinely moved. */
  const jump = (last: boolean): void => {
    if ((last ? viewport.last() : viewport.first())) spec.invalidate()
  }

  /** Change the selected answer while preserving wrap-around. */
  const moveChoice = (amount: number): void => {
    if (spec.choices.length === 0) return
    choice = (choice + amount + spec.choices.length) % spec.choices.length
    spec.invalidate()
  }

  return {
    render(columns, terminalRows = 24) {
      const rendered = planRows(columns)
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const frameFits = width < columns
      const selected = spec.choices[choice]
      const hasDescription = selected?.description !== undefined && selected.description !== ''
      const visiblePlanRows = normalPlanRows(terminalRows, spec.choices.length, hasDescription)
      viewport.update(rendered.length, visiblePlanRows)

      if (visiblePlanRows === 0 || !frameFits) {
        if (terminalRows <= 0) return []
        // Whole-segment surrender, never a half instruction: `↑↓ decision · ente`
        // teaches nothing and costs the same columns as the atomic `esc` below.
        const helpText = fitFooterHelp('↑↓ decision · enter confirm · esc cancel', columns)
        const unboxed = (): string[] => {
          const decision = decisionLine(selected, columns)
          if (helpText === '') return [decision]
          return terminalRows === 1 ? [decision] : [decision, paint(helpText, 'muted')]
        }
        // A frame wider than the terminal would wrap its own borders. Keep the
        // same unboxed, usable decision fallback used for a very short screen.
        if (!frameFits || terminalRows < COMPACT_REVIEW_ROWS) return unboxed()
        const heading = rendered.find(line => displayWidth(line) > 0) ?? 'Plan'
        const compact = rootFrame({
          columns,
          context: paint('Plan review', 'overlay-title'),
          body: [
            truncateToWidth(heading, inner),
            paint(truncateToWidth('resize terminal to read the plan', inner), 'subdued'),
            decisionLine(selected, inner),
          ],
          footer: fitFooterHelp(
            '↑↓ decision · enter confirm · esc cancel',
            footerBudget(columns),
          ),
        })
        // The same backstop every other overlay carries: a compact frame that
        // wraps for any reason falls back to the unboxed decision rather than
        // growing past the terminal and leaking a row into scrollback.
        return physicalRows(compact, columns).length <= terminalRows
          ? compact
          : unboxed()
      }

      const description = hasDescription
        ? [paint(`  ${oneRow(selected?.description ?? '', inner - 2)}`, 'muted')]
        : []
      const content = [
        paint(oneRow(spec.question, inner), 'subdued'),
        paint(truncateToWidth(
          `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(rendered.length)}`,
          inner,
        ), 'muted'),
        '',
        ...rendered.slice(viewport.start, viewport.end),
        '',
        ...spec.choices.map((item, index) => {
          const label = oneRow(item.label, inner - 2)
          return index === choice ? paint(`❯ ${label}`, 'selection') : `  ${label}`
        }),
        ...description,
      ]
      return [
        '',
        ...rootFrame({
          columns,
          context: paint('Plan review', 'overlay-title'),
          body: content,
          footer: fitFooterHelp(
            '↑↓ decision · ←→ plan page · home/end plan · enter confirm · esc cancel',
            footerBudget(columns),
          ),
        }),
      ]
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          moveChoice(-1)
          return
        case 'down':
          moveChoice(1)
          return
        case 'left':
          page(-1)
          return
        case 'right':
          page(1)
          return
        case 'home':
        case 'ctrl-a':
          jump(false)
          return
        case 'end':
        case 'ctrl-e':
          jump(true)
          return
        case 'tab':
          moveChoice(1)
          return
        case 'enter':
          settle(spec.choices[choice]?.value)
          return
        case 'escape':
        case 'ctrl-c':
          settle(undefined)
          return
        default:
          return
      }
    },
  }
}

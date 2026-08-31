/**
 * The plan-review overlay.
 *
 * A completed plan is the decision a person needs to make, not incidental
 * detail on an option picker. The review itself stays a decision surface: a
 * bounded preview of the plan alongside the choices, never a place to page
 * through the whole document. Reading the whole plan is a second, deliberate
 * mode entered with Ctrl+O — the same document, laid out as one continuous
 * scrollable body, exactly the way Ctrl+O expands a tool result. Returning
 * from it changes nothing about the pending decision: the selected choice is
 * preserved, and only the review surface's own Esc/Ctrl+C dismiss the review
 * to speak.
 * @module dshline/plan-review
 */

import type { Key } from '@dshline/renderer'
import { BOX_CHROME_COLUMNS, displayWidth, escapeControls, paint, renderMarkdown, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import { RowViewport } from './scroll.ts'
import type { TuiOverlay } from './slots.ts'

/**
 * Largest plan preview shown in a tall terminal's review.
 *
 * The review is a decision surface, not a document reader: a preview this size
 * gives a reader enough to recognise the plan and judge whether to read the
 * rest through Ctrl+O, without turning the decision itself into a paged book.
 */
const MAX_PREVIEW_ROWS = 10

/**
 * Rows outside the plan preview in the normal review layout.
 *
 * They are the leading blank, two frame borders, question, status line, and
 * two plan spacers. Choices and their selected description are counted
 * separately because they vary with the request.
 */
const PLAN_REVIEW_FIXED_ROWS = 7

/** Rows the readable compact box and its controls occupy. */
const COMPACT_REVIEW_ROWS = 5

/**
 * Rows outside the inspected document in full-plan inspection.
 *
 * The leading blank, two frame borders, the counter, and the blank before and
 * after the body — the same shape the tool-output inspector uses, so the body
 * budget is `terminalRows - this` and the frame never overflows it.
 */
const INSPECT_FIXED_ROWS = 6

/**
 * Narrowest inner frame full-plan inspection will draw at without re-wrapping.
 * Matches the tool-output inspector's floor for the same reason: below it,
 * the unboxed escape hatch is the honest answer.
 */
const INSPECT_MIN_INNER_COLUMNS = BOX_CHROME_COLUMNS + 10

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
 * Rows the review layout may give to the plan preview.
 * @param terminalRows - terminal height in physical rows.
 * @param choiceCount - decision rows beneath the plan.
 * @param hasDescription - whether the selected choice adds its consequence row.
 * @returns preview rows available without exceeding the terminal, capped for redraw safety.
 */
function previewRows(terminalRows: number, choiceCount: number, hasDescription: boolean): number {
  const fixedRows = PLAN_REVIEW_FIXED_ROWS + choiceCount + (hasDescription ? 1 : 0)
  return Math.min(MAX_PREVIEW_ROWS, Math.max(0, terminalRows - fixedRows))
}

/**
 * Make caller-supplied supporting text one physical frame row.
 *
 * A newline is safe text but would make the fixed layout budget false: the frame
 * would expand it into another row after the layout had already decided how
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

/** The plan's first non-blank rendered row, standing in for a heading. */
function planHeading(rendered: readonly string[]): string {
  return rendered.find(line => displayWidth(line) > 0) ?? 'Plan'
}

/** Count the physical terminal rows Screen will draw for candidate live-region lines. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * Render the completed plan as a bounded review, with a Ctrl+O document reader.
 *
 * @param spec - plan content, decision choices, and callbacks.
 * @returns an overlay that changes the choice with up/down or tab, and opens
 *   full-plan inspection with Ctrl+O when the preview does not show it all.
 */
export function createPlanReviewOverlay(spec: PlanReviewSpec): TuiOverlay {
  const inspectViewport = new RowViewport()
  let mode: 'review' | 'inspect' = 'review'
  let choice = 0
  let settled = false
  // Set on every review render; Ctrl+O reads it because `handleKey` gets no
  // width or height of its own to recompute it from.
  let previewTruncated = false

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

  /** Change the selected answer while preserving wrap-around. */
  const moveChoice = (amount: number): void => {
    if (spec.choices.length === 0) return
    choice = (choice + amount + spec.choices.length) % spec.choices.length
    spec.invalidate()
  }

  /** The review surface: choices in view, with a bounded plan preview above them. */
  const renderReview = (columns: number, terminalRows: number): string[] => {
    const rendered = planRows(columns)
    const width = chromeWidth(columns)
    const inner = width - BOX_CHROME_COLUMNS
    const frameFits = width < columns
    const selected = spec.choices[choice]
    const hasDescription = selected?.description !== undefined && selected.description !== ''
    const visible = previewRows(terminalRows, spec.choices.length, hasDescription)
    previewTruncated = rendered.length > visible
    const helpBase = previewTruncated
      ? '↑↓ decision · ctrl-o view plan · enter confirm · esc cancel'
      : '↑↓ decision · enter confirm · esc cancel'

    if (visible === 0 || !frameFits) {
      if (terminalRows <= 0) return []
      // Whole-segment surrender, never a half instruction: `↑↓ decision · ente`
      // teaches nothing and costs the same columns as the atomic `esc` below.
      const helpText = fitFooterHelp(helpBase, columns)
      const unboxed = (): string[] => {
        const decision = decisionLine(selected, columns)
        if (helpText === '') return [decision]
        return terminalRows === 1 ? [decision] : [decision, paint(helpText, 'muted')]
      }
      // A frame wider than the terminal would wrap its own borders. Keep the
      // same unboxed, usable decision fallback used for a very short screen.
      if (!frameFits || terminalRows < COMPACT_REVIEW_ROWS) return unboxed()
      const hint = previewTruncated ? 'ctrl-o to read the plan' : 'resize terminal to read the plan'
      const compact = rootFrame({
        columns,
        context: paint('Plan review', 'overlay-title'),
        body: [
          truncateToWidth(planHeading(rendered), inner),
          paint(truncateToWidth(hint, inner), 'subdued'),
          decisionLine(selected, inner),
        ],
        footer: fitFooterHelp(helpBase, footerBudget(columns)),
      })
      // The same backstop every other overlay carries: a compact frame that
      // wraps for any reason falls back to the unboxed decision rather than
      // growing past the terminal and leaking a row into scrollback.
      return physicalRows(compact, columns).length <= terminalRows
        ? compact
        : unboxed()
    }

    const preview = rendered.slice(0, visible)
    const remaining = rendered.length - visible
    const status = previewTruncated
      ? `${planHeading(rendered)} · ${String(remaining)} more line${remaining === 1 ? '' : 's'}, ctrl-o to view whole plan`
      : planHeading(rendered)
    const description = hasDescription
      ? [paint(`  ${oneRow(selected?.description ?? '', inner - 2)}`, 'muted')]
      : []
    const content = [
      paint(oneRow(spec.question, inner), 'subdued'),
      paint(truncateToWidth(status, inner), 'muted'),
      '',
      ...preview,
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
        footer: fitFooterHelp(helpBase, footerBudget(columns)),
      }),
    ]
  }

  /** Full-plan inspection: the same plan, as one continuous scrollable document. */
  const renderInspect = (columns: number, terminalRows: number): string[] => {
    const width = chromeWidth(columns)
    const inner = width - BOX_CHROME_COLUMNS
    const frameFits = width < columns
    if (terminalRows <= INSPECT_FIXED_ROWS || inner < INSPECT_MIN_INNER_COLUMNS || !frameFits) {
      if (terminalRows <= 0) return []
      const summary = 'Plan · resize to inspect · ctrl-o/esc back'
      const lines = [paint(truncateToWidth(summary, Math.max(1, columns)), 'overlay-headline')]
      if (terminalRows >= 2) lines.push(paint(truncateToWidth('ctrl-o/esc back', Math.max(1, columns)), 'muted'))
      return lines
    }
    const rendered = planRows(columns)
    const visible = terminalRows - INSPECT_FIXED_ROWS
    inspectViewport.update(rendered.length, visible)
    const counter = `rows ${String(inspectViewport.start + 1)}–${String(inspectViewport.end)} of ${String(rendered.length)}`
    return [
      '',
      ...rootFrame({
        columns,
        context: paint('Plan', 'overlay-title'),
        body: [
          paint(truncateToWidth(counter, inner), 'muted'),
          '',
          ...rendered.slice(inspectViewport.start, inspectViewport.end),
          '',
        ],
        footer: fitFooterHelp('↑↓ scroll · home/end jump · ctrl-o/esc back', footerBudget(columns)),
      }),
    ]
  }

  return {
    render(columns, terminalRows = 24) {
      return mode === 'inspect' ? renderInspect(columns, terminalRows) : renderReview(columns, terminalRows)
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      if (mode === 'inspect') {
        switch (key.name) {
          case 'up':
            if (inspectViewport.move(-1)) spec.invalidate()
            return
          case 'down':
            if (inspectViewport.move(1)) spec.invalidate()
            return
          case 'home':
          case 'ctrl-a':
            if (inspectViewport.first()) spec.invalidate()
            return
          case 'end':
          case 'ctrl-e':
            if (inspectViewport.last()) spec.invalidate()
            return
          case 'ctrl-o':
          case 'escape':
          case 'ctrl-c':
            // Returning to the review answers nothing: the pending decision
            // (`choice`) was never touched by inspection.
            mode = 'review'
            spec.invalidate()
            return
          default:
            return
        }
      }
      switch (key.name) {
        case 'up':
          moveChoice(-1)
          return
        case 'down':
          moveChoice(1)
          return
        case 'tab':
          moveChoice(1)
          return
        case 'ctrl-o':
          // A no-op when the preview already shows the whole plan: there is
          // nothing further inspection would reveal.
          if (!previewTruncated) return
          mode = 'inspect'
          spec.invalidate()
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

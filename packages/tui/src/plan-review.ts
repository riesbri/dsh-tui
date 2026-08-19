/**
 * The plan-review overlay.
 *
 * A completed plan is the decision a person needs to make, not incidental
 * detail on an option picker. Keeping its whole body in the live region made a
 * long plan taller than the terminal, which the append-and-live screen cannot
 * redraw safely and which leaves only the bottom readable. This overlay keeps a
 * fixed window over rendered plan rows and makes that window explicitly
 * scrollable.
 * @module @riesbri/dsh-tui/plan-review
 */

import type { Key } from '@riesbri/dsh-tui-renderer'
import { BOX_CHROME_COLUMNS, box, escapeControls, renderMarkdown, style, truncateToWidth, wrapToWidth } from '@riesbri/dsh-tui-renderer'
import type { TuiOverlay } from './slots.ts'
import { chromeWidth } from './views.ts'

/**
 * Plan rows visible at once.
 *
 * Ten plan rows plus the frame, decision, and controls fit beneath ordinary
 * terminal chrome, while still showing enough context to judge a step without
 * paging for every line. A live overlay must stay this small: unlike committed
 * transcript rows, rows beyond the screen cannot be climbed back to and erased.
 */
const PLAN_ROWS = 10

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
 * Render the completed plan as a bounded, scrollable review overlay.
 *
 * @param spec - plan content, decision choices, and callbacks.
 * @returns an overlay that scrolls with up/down and changes the choice with tab.
 */
export function createPlanReviewOverlay(spec: PlanReviewSpec): TuiOverlay {
  let offset = 0
  let choice = 0
  let renderedRows = 0
  let settled = false

  /** Settle no more than once, as terminal input can arrive after dismissal. */
  const settle = (value: string | undefined): void => {
    if (settled) return
    settled = true
    spec.settle(value)
  }

  /** The plan's physical terminal rows, with markdown made safe before styling. */
  const rows = (columns: number): string[] => {
    const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
    return renderMarkdown(spec.plan).flatMap(line => wrapToWidth(line, inner))
  }

  /** Clamp the window after a resize or a scroll request. */
  const limit = (count: number): number => Math.max(0, count - PLAN_ROWS)

  /** Move the plan window one row and repaint only if it really moved. */
  const scroll = (amount: number): void => {
    const next = Math.min(Math.max(offset + amount, 0), limit(renderedRows))
    if (next === offset) return
    offset = next
    spec.invalidate()
  }

  return {
    render(columns) {
      const rendered = rows(columns)
      renderedRows = rendered.length
      offset = Math.min(offset, limit(renderedRows))
      const end = Math.min(offset + PLAN_ROWS, rendered.length)
      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const selected = spec.choices[choice]
      const description = selected?.description === undefined || selected.description === ''
        ? []
        : [style(`  ${truncateToWidth(escapeControls(selected.description), inner - 2)}`, 'gray')]
      const content = [
        style(truncateToWidth(escapeControls(spec.question), inner), 'dim'),
        style(`rows ${String(offset + 1)}–${String(end)} of ${String(rendered.length)}`, 'gray'),
        '',
        ...rendered.slice(offset, end),
        '',
        ...spec.choices.map((item, index) => {
          const label = truncateToWidth(escapeControls(item.label), inner - 2)
          return index === choice ? style(`❯ ${label}`, 'cyan', 'bold') : `  ${label}`
        }),
        ...description,
      ]
      return [
        '',
        ...box(content, {
          width: chromeWidth(columns),
          title: style('Plan review', 'bold', 'yellow'),
          border: text => style(text, 'yellow'),
        }),
        `  ${style(truncateToWidth('↑↓ plan · tab choose · enter confirm · esc cancel', Math.max(1, columns - 2)), 'gray')}`,
      ]
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          scroll(-1)
          return
        case 'down':
          scroll(1)
          return
        case 'home':
        case 'ctrl-a':
          scroll(-Number.POSITIVE_INFINITY)
          return
        case 'end':
        case 'ctrl-e':
          scroll(Number.POSITIVE_INFINITY)
          return
        case 'tab':
        case 'left':
        case 'right':
          if (spec.choices.length === 0) return
          choice = (choice + 1) % spec.choices.length
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

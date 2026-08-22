/**
 * A single-choice list overlay.
 *
 * Approvals, `ask_user_question`, and the model picker are the same interaction
 * — read a prompt, move through choices, confirm one — so they share one
 * implementation and differ only in what they do with the result. Anything that
 * needs a different presentation registers its own overlay instead; the slot
 * registry does not privilege this one.
 * @module @riesbri/dsh-tui/select
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@riesbri/dsh-tui-renderer'
import { BOX_CHROME_COLUMNS, box, escapeControls, style, truncateToWidth } from '@riesbri/dsh-tui-renderer'
import type { TuiOverlay } from './slots.ts'
import { chromeWidth } from './views.ts'

/** One selectable row. */
export interface SelectChoice {
  /** The value handed back on confirmation. */
  value: string
  /** User-facing label. */
  label: string
  /** Optional second line shown under the label when selected. */
  description?: string
}

/** How a select overlay is built and what it reports. */
export interface SelectSpec {
  /** Headline shown above the list. */
  title: string
  /** Optional supporting text between the title and the list. */
  detail?: string
  /** The rows; an empty list is a programming error and renders as such. */
  choices: readonly SelectChoice[]
  /**
   * Called once with the confirmed value, or with undefined when the user
   * cancelled. The overlay never calls this twice.
   */
  settle(value: string | undefined): void
  /** Asks the runner to redraw after a selection move. */
  invalidate(): void
}

/**
 * Build a select overlay.
 * @param spec - the prompt, choices, and settlement callback.
 * @returns the overlay to push onto the slot registry.
 */
export function createSelectOverlay(spec: SelectSpec): TuiOverlay {
  let cursor = 0
  let settled = false
  const settle = (value: string | undefined): void => {
    // The overlay is dismissed by whoever pushed it, and a stray keystroke can
    // arrive between the decision and the unmount, so settlement is once-only.
    if (settled) return
    settled = true
    spec.settle(value)
  }
  return {
    render(columns) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const content: string[] = []
      if (spec.detail !== undefined && spec.detail !== '') {
        for (const line of escapeControls(spec.detail).split('\n')) {
          content.push(style(truncateToWidth(line, inner), 'dim'))
        }
        content.push('')
      }
      spec.choices.forEach((choice, index) => {
        const selected = index === cursor
        const label = truncateToWidth(escapeControls(choice.label), inner - 2)
        content.push(selected ? style(`\u276f ${label}`, 'cyan', 'bold') : `  ${label}`)
        if (selected && choice.description !== undefined && choice.description !== '') {
          content.push(style(`  ${truncateToWidth(escapeControls(choice.description), inner - 2)}`, 'gray'))
        }
      })
      return [
        '',
        ...box(content, {
          width,
          title: style(truncateToWidth(escapeControls(spec.title), Math.max(4, inner - 2)), 'bold', 'yellow'),
          border: text => style(text, 'yellow'),
        }),
        `  ${style('\u2191\u2193 move \u00b7 enter confirm \u00b7 esc cancel', 'gray')}`,
      ]
    },
    handleKey(key: Key) {
      // A picker takes no text: typed characters and pasted content are both
      // meaningless here, and inserting them nowhere would look like a hang.
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          cursor = cursor === 0 ? spec.choices.length - 1 : cursor - 1
          spec.invalidate()
          return
        case 'down':
          cursor = cursor === spec.choices.length - 1 ? 0 : cursor + 1
          spec.invalidate()
          return
        case 'enter':
          settle(spec.choices[cursor]?.value)
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

/**
 * Show a list and wait for the answer.
 *
 * The push-await-dismiss dance is the same every time — build the overlay, hold
 * the disposer the registry hands back, and make sure settling runs it before
 * the promise resolves — and it was written out at every call site. Getting the
 * order wrong leaves a picker on screen after it has been answered, which is a
 * bug each copy has to avoid separately.
 *
 * Anything whose settlement is not a straight line from the promise keeps its
 * own: the approval prompt also settles from an abort listener, and the Sessions
 * browser settles from a resume decision its owner makes rather than from the
 * chosen row.
 * @param ctx - context carrying the slot registry.
 * @param spec - the prompt and its choices; settlement is this function's.
 * @returns the confirmed value, or undefined when the user cancelled.
 */
export async function promptSelect(
  ctx: Context,
  spec: Omit<SelectSpec, 'settle' | 'invalidate'>,
): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    const overlay = createSelectOverlay({
      ...spec,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: value => {
        dismiss()
        resolve(value)
      },
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
  })
}

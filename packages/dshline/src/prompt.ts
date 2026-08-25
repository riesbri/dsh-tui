/**
 * A single-line text overlay, for the questions a list cannot answer.
 *
 * {@link promptSelect} covers every interaction whose answer is one of a known
 * set. Configuration is where that stops being true: an API key, a pasted
 * device code, and an account name are all values only the person at the
 * keyboard holds, so something has to take typed text without giving the model
 * a turn.
 *
 * `secret` differs from `text` only in presentation, which is exactly the
 * distinction Harness's authorization vocabulary draws: the value is masked on
 * screen and never echoed into the transcript, but it is the same question.
 * @module dshline/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  box,
  displayWidth,
  escapeControls,
  paint,
  tailToWidth,
  truncateToWidth,
} from '@dshline/renderer'
import type { TuiOverlay } from './slots.ts'
import { chromeWidth } from './views.ts'

/** How a typed value is shown back while it is being typed. */
export type PromptKind = 'text' | 'secret'

/** How a prompt overlay is built and what it reports. */
export interface PromptSpec {
  /** Headline shown above the field. */
  title: string
  /** The question itself, wrapped above the field. */
  message: string
  /** Optional supporting text under the question. */
  detail?: string
  /** Whether the typed value is masked. */
  kind: PromptKind
  /** Greyed text shown while the field is empty. */
  placeholder?: string
  /**
   * Called once with the typed value, or with undefined when the user
   * cancelled. The overlay never calls this twice.
   */
  settle(value: string | undefined): void
  /** Asks the runner to redraw after an edit. */
  invalidate(): void
}

/** The glyph a masked field repeats, one per typed character. */
const MASK = '•'

/**
 * Build a text-entry overlay.
 * @param spec - the question, its presentation, and the settlement callback.
 * @returns the overlay to push onto the slot registry.
 */
export function createPromptOverlay(spec: PromptSpec): TuiOverlay {
  let value = ''
  let settled = false
  const settle = (answer: string | undefined): void => {
    // Once-only for the reason the select overlay's is: the registry can deliver
    // one more keystroke between the decision and the unmount.
    if (settled) return
    settled = true
    spec.settle(answer)
  }
  const edit = (next: string): void => {
    value = next
    spec.invalidate()
  }
  return {
    render(columns) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const content: string[] = []
      for (const line of escapeControls(spec.message).split('\n')) {
        content.push(truncateToWidth(line, inner))
      }
      if (spec.detail !== undefined && spec.detail !== '') {
        for (const line of escapeControls(spec.detail).split('\n')) {
          content.push(paint(truncateToWidth(line, inner), 'muted'))
        }
      }
      content.push('')
      content.push(fieldRow(value, spec, inner))
      return [
        '',
        ...box(content, {
          width,
          title: paint(truncateToWidth(escapeControls(spec.title), Math.max(4, inner - 2)), 'overlay-title'),
          border: text => paint(text, 'overlay-border'),
        }),
        `  ${paint('enter confirm · esc cancel', 'muted')}`,
      ]
    },
    handleKey(key: Key) {
      if (key.kind === 'text') {
        edit(value + key.text)
        return
      }
      if (key.kind === 'paste') {
        // A pasted value is taken VERBATIM apart from its line breaks, which a
        // one-line field cannot hold. Collapsing runs of space or trimming the
        // ends would be this overlay editing an answer it does not understand:
        // it serves Harness's generic `text` and `secret` prompts, where the
        // value could be a passphrase whose spacing is the secret. Normalizing
        // belongs to whoever knows what the value IS — for an API key that is
        // `normalizeApiKey` at the action boundary, which trims and rejects a
        // character no HTTP header can carry.
        edit(value + key.text.replace(/[\r\n]+/gu, ''))
        return
      }
      switch (key.name) {
        case 'enter':
          settle(value)
          return
        case 'backspace':
          // Code points, not UTF-16 units, so one press deletes one character.
          edit([...value].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          edit('')
          return
        case 'ctrl-w':
          edit(value.replace(/\s*\S*$/u, ''))
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
 * The field row: a prompt mark, the value or its mask, and a cursor block.
 *
 * A masked field shows one glyph per typed character rather than a fixed run,
 * because the length is the only feedback a person typing a secret has that the
 * keystrokes are arriving at all.
 * @param value - the text typed so far.
 * @param spec - the prompt's presentation.
 * @param inner - the frame's inner width in columns.
 * @returns one row.
 */
function fieldRow(value: string, spec: PromptSpec, inner: number): string {
  const mark = '❯ '
  const room = Math.max(1, inner - displayWidth(mark) - 1)
  if (value === '') {
    const hint = spec.placeholder === undefined
      ? ''
      : paint(truncateToWidth(escapeControls(spec.placeholder), room), 'muted')
    return `${paint(mark, 'prompt-mark')}█${hint}`
  }
  const shown = spec.kind === 'secret'
    ? MASK.repeat([...value].length)
    : escapeControls(value)
  // The TAIL is kept, not the head. A person watches the characters they are
  // typing, so a long value scrolls from the left and the cursor stays in view;
  // `truncateToWidth` here would hide exactly what was just typed. One column is
  // held back for the cursor block, and given up only once the value fills the
  // field — at which point the tail itself is what shows where typing continues.
  const fitted = tailToWidth(shown, Math.max(1, room - 1))
  return `${paint(mark, 'prompt-mark')}${fitted}█`
}

/**
 * Ask for one line of text and wait for the answer.
 *
 * The twin of {@link promptSelect}: same push-await-dismiss dance, same
 * once-only settlement, so a caller alternating between a list and a field
 * writes the same three lines for both.
 * @param ctx - context carrying the slot registry.
 * @param spec - the question and its presentation; settlement is this
 *   function's. An optional `signal` takes the question down without an answer,
 *   which is how a Harness authorization flow withdraws the losing half of a
 *   race between a typed code and a browser callback.
 * @returns the typed value, or undefined when the user cancelled or the
 *   question was withdrawn.
 */
export async function promptText(
  ctx: Context,
  spec: Omit<PromptSpec, 'settle' | 'invalidate'> & { signal?: AbortSignal },
): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      dismiss()
      resolve(value)
    }
    const overlay = createPromptOverlay({
      ...spec,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: finish,
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    if (spec.signal?.aborted === true) finish(undefined)
    else spec.signal?.addEventListener('abort', () => { finish(undefined) }, { once: true })
  })
}

/**
 * The terminal's reasoning visibility picker.
 *
 * This is deliberately separate from {@link ../reasoning.ts}: `/reasoning` edits
 * the model selection, while this command edits only the reader's projection.
 * @module dshline/thinking
 */

import type { Context } from '@deepseek-ai/cordis'
import { promptSelect } from './select.ts'
import type { SelectChoice } from './select.ts'

/** The compact vocabulary accepted after `/thinking`. */
export const THINKING_VALUES = [
  { value: 'on', note: 'Show model reasoning as it arrives' },
  { value: 'off', note: 'Hide reasoning; model behavior is unchanged' },
] as const

/** The two presentation choices shown by the bare command. */
const THINKING_CHOICES: readonly SelectChoice[] = [
  {
    value: 'shown',
    label: 'Shown',
    description: 'Show model reasoning as it arrives',
  },
  {
    value: 'hidden',
    label: 'Hidden',
    description: 'Hide reasoning; model behavior is unchanged',
  },
]

/**
 * Set reasoning visibility from a direct argument or picker.
 * @param ctx - context carrying the picker slot registry.
 * @param visible - current visibility value.
 * @param argument - text after `/thinking`; empty opens the picker.
 * @param apply - changes the owning window and current stream.
 * @returns the resulting visibility, or undefined when dismissed/rejected.
 */
export async function pickThinking(
  ctx: Context,
  visible: boolean,
  argument: string,
  apply: (next: boolean) => void,
): Promise<'shown' | 'hidden' | undefined> {
  const wanted = argument.trim().toLowerCase()
  let picked: string | undefined
  if (wanted === '') {
    picked = await promptSelect(ctx, {
      title: 'Thinking',
      view: 'Thinking',
      detail: 'Reasoning visibility',
      initialValue: visible ? 'shown' : 'hidden',
      choices: THINKING_CHOICES,
    })
  } else if (wanted === 'on') {
    picked = 'shown'
  } else if (wanted === 'off') {
    picked = 'hidden'
  } else {
    return undefined
  }
  if (picked !== 'shown' && picked !== 'hidden') return undefined
  const next = picked === 'shown'
  apply(next)
  return picked
}

/**
 * Whether a direct argument is accepted by `/thinking`.
 * @param argument - text after the command.
 * @returns true for an empty argument or one accepted direct value.
 */
export function validThinkingArgument(argument: string): boolean {
  const wanted = argument.trim().toLowerCase()
  return wanted === '' || wanted === 'on' || wanted === 'off'
}

/**
 * Build the acknowledgement for a visibility choice.
 * @param visibility - the chosen presentation state.
 * @returns a concise terminal acknowledgement.
 */
export function thinkingAcknowledgement(visibility: 'shown' | 'hidden'): string {
  return `· thinking: ${visibility}`
}

/**
 * Expose the picker choices for focused UI tests.
 * @returns the labels and descriptions used by the picker.
 */
export function thinkingChoices(): readonly SelectChoice[] {
  return THINKING_CHOICES
}

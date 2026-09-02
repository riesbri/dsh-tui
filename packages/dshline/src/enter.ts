/**
 * `/enter` — what plain `enter` does while a turn is running.
 *
 * Separated from the command's registration for the reason `/theme` is: the
 * decision, the wording, and the report are testable without a terminal, an
 * agent, or a settings provider, while the registration that supplies the picker
 * and the transcript is not.
 *
 * The command follows this interface's existing grammar — a value changes it, a
 * bare name asks — and it is also the one place that TEACHES the alternate
 * gesture. `ctrl-enter` cannot be advertised in the composer, because a terminal
 * that does not implement an enhanced keyboard encoding sends the same bytes for
 * it as for `enter` and there is nothing to ask, so a hint naming it would tell
 * most readers to press a key that quietly does the other thing. Saying it here
 * costs nobody a wrong keystroke: the reader is already looking at the setting.
 * @module dshline/enter
 */

import { escapeControls, paint } from '@dshline/renderer'
import type { BusyEnter } from './delivery.ts'

/** What each value means, for the picker and for `/enter`'s own completion. */
export const BUSY_ENTER_CHOICES: readonly { value: BusyEnter; label: string; description: string }[] = [
  {
    value: 'queue',
    label: 'queue',
    description: 'Keep it for a follow-up turn of its own, once this turn is done',
  },
  {
    value: 'steer',
    label: 'steer',
    description: 'Give it to the running turn, at its next step',
  },
]

/** The seams `/enter` needs, each supplied by the attachment. */
export interface EnterCommandSpec {
  /** What plain busy `enter` means right now. */
  readonly current: () => BusyEnter
  /**
   * Adopt a choice for this window, before anything is stored.
   *
   * Applied first and unconditionally, exactly as `/theme` applies a palette: a
   * profile with no settings provider must still be able to change this for the
   * process it is running in, and the next submission has to honour what the
   * reader just said whether or not a document could be written.
   */
  readonly apply: (value: BusyEnter) => void
  /** Print the report into the transcript. */
  readonly commit: (lines: readonly string[]) => void
  /** Ask which one, when the reader named none. Undefined means dismissed. */
  readonly choose: (current: BusyEnter) => Promise<string | undefined>
  /**
   * Store the choice, returning a phrase for the report when it could not be.
   *
   * Optional so the command can be exercised without a settings namespace at
   * all, and never awaited before {@link EnterCommandSpec.apply}.
   */
  readonly remember?: (value: BusyEnter) => Promise<string | undefined>
}

/**
 * Say what busy `enter` now does, and how to get the other one.
 * @param value - the value in force.
 * @param stored - a phrase about storage, appended when there is one.
 * @returns the report line.
 */
function enterReport(value: BusyEnter, stored: string | undefined): string {
  const meaning = value === 'queue'
    ? 'a follow-up turn of its own'
    : 'handed to the running turn at its next step'
  const note = stored === undefined ? '' : ` · ${stored}`
  // The alternate gesture is reported as conditional because it IS conditional,
  // and the condition is the reader's terminal rather than anything this can
  // resolve for them. Promising it outright is the one wording that could cost a
  // misdirected submission.
  const other = value === 'queue' ? 'steers' : 'queues'
  return paint(
    `· enter while running: ${value} · ${meaning} · ctrl-enter ${other} instead, where your terminal sends it`,
    'muted',
  ) + paint(note, 'muted')
}

/**
 * Run `/enter`.
 * @param spec - the seams the command acts through.
 * @param rawInput - exactly what followed the command name.
 * @returns when the report has been printed.
 */
export async function runEnterCommand(spec: EnterCommandSpec, rawInput: string): Promise<void> {
  const named = rawInput.trim().toLowerCase()
  const current = spec.current()
  const picked = named === '' ? await spec.choose(current) : named
  // Dismissed, so nothing changed and there is nothing to report.
  if (picked === undefined) return
  const chosen = BUSY_ENTER_CHOICES.find(choice => choice.value === picked)?.value
  if (chosen === undefined) {
    const offered = BUSY_ENTER_CHOICES.map(choice => choice.value).join(' or ')
    spec.commit([paint(
      `✗ /enter takes ${offered}, or nothing to choose: ${escapeControls(picked)}`,
      'error',
    )])
    return
  }
  // Applied before it is stored, and never rolled back on a failed write: by
  // then the next enter already means what the reader asked for, and putting it
  // back would make the report a lie about the more important of the two.
  spec.apply(chosen)
  const stored = await spec.remember?.(chosen)
  spec.commit([enterReport(chosen, stored)])
}

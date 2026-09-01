/** Presentation adapter for Harness-owned permission presets. */

import type { Context } from '@deepseek-ai/cordis'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission-presets/types'
import { promptSelect } from './select.ts'
import type { SelectChoice } from './select.ts'

/** Harness's derived current-only permission value, never a switch target. */
const CUSTOM_PRESET = 'custom'

/** The standard preset whose picker selection needs an explicit acknowledgement. */
const FULL_ACCESS_PRESET = 'danger-full-access'

/** The terminal-facing permission picker data. */
export interface PermissionPicker {
  /** Detail identifying the effective preset before a selection is made. */
  readonly detail: string
  /** The current preset to highlight, when it is a switchable preset. */
  readonly currentValue: string | undefined
  /** Deployment-defined preset rows, in Harness declaration order. */
  readonly choices: readonly SelectChoice[]
}

/**
 * Adapt Harness's authoritative permission select for the shared terminal picker.
 *
 * `custom` is an effective state, not a configured preset. Filtering it here
 * keeps the UI from proposing a command Harness deliberately rejects while the
 * detail still reports the actual current state.
 * @param select - the optional `permissions` projection value.
 * @returns picker data, or undefined when the capability is not composed.
 */
export function permissionPicker(select: PermissionSelect | undefined): PermissionPicker | undefined {
  if (select === undefined) return undefined
  const current = select.options.find(option => option.value === select.currentValue)
  const choices = select.options
    .filter(option => option.value !== CUSTOM_PRESET)
    .map(option => ({
      value: option.value,
      label: option.name,
      ...option.description === undefined ? {} : { description: option.description },
    }))
  return {
    detail: `current: ${current?.name ?? select.currentValue}`,
    currentValue: choices.some(choice => choice.value === select.currentValue) ? select.currentValue : undefined,
    choices,
  }
}

/**
 * Mirror Harness Web's Full Access risk-gating policy through dshline's
 * terminal-native confirmation picker. Typed command arguments retain their
 * normal Harness semantics and do not come through this presentation step.
 * @param ctx - context owning the shared bounded selector.
 * @param value - selected deployment-defined preset id.
 * @returns whether this picker-originated selection may dispatch to Harness.
 */
export async function confirmPermissionSelection(ctx: Context, value: string): Promise<boolean> {
  if (value !== FULL_ACCESS_PRESET) return true
  const confirmed = await promptSelect(ctx, {
    title: 'Enable Full access?',
    view: 'Confirm',
    detail: 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'enable', label: 'Enable Full access' },
    ],
  })
  return confirmed === 'enable'
}

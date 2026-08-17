/**
 * The model picker.
 *
 * Selection is a mutable ref the agent's scoped prompt assembly reads
 * (`installModelSelection`): assembly snapshots it when a step enters, so a
 * switch made mid-turn takes effect on the NEXT step rather than splitting a
 * request across two models. Writing `ref.current` is therefore the whole
 * mechanism — there is no separate apply step to get wrong.
 * @module @riesbri/dsh-tui/model
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createSelectOverlay } from './select.ts'
import type { SelectChoice } from './select.ts'

/** One offered model, kept beside its choice so nothing has to be parsed back. */
interface ModelOption {
  /** Provider ROUTE key, the value `GenerateOptions.provider` takes. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** What discovery found, and what it could not reach. */
interface Discovery {
  options: ModelOption[]
  choices: SelectChoice[]
  /** Route keys whose listing failed, for a message that says so. */
  failed: string[]
}

/**
 * Every model the mounted adapters currently advertise.
 *
 * `listProviders()` returns `{ id, name }` where **`id`** is the route key
 * `listModels` and `GenerateOptions.provider` take, and `name` is a label for
 * humans. A route whose listing fails is recorded rather than silently dropped:
 * an unreachable provider must not hide the ones that work, but it must also not
 * be reported as "nothing is configured".
 * @param ctx - context carrying the llm registry.
 * @returns the discovered options, their rendered choices, and any failures.
 */
async function discover(ctx: Context): Promise<Discovery> {
  const options: ModelOption[] = []
  const choices: SelectChoice[] = []
  const failed: string[] = []
  for (const provider of ctx.llm.listProviders()) {
    let models
    try {
      models = await ctx.llm.listModels(provider.id)
    } catch {
      failed.push(provider.id)
      continue
    }
    for (const model of models) {
      // The index is the choice value, so no id has to survive a round trip
      // through a delimiter that a provider or model name might contain.
      choices.push({ value: String(options.length), label: `${provider.name} / ${model.name}` })
      options.push({ provider: provider.id, model: model.id })
    }
  }
  return { options, choices, failed }
}

/**
 * Prompt for a model and apply the choice to `selection`.
 * @param ctx - context carrying the llm registry and the slot registry.
 * @param selection - the agent's mutable selection ref.
 * @returns a line to report in the transcript, or undefined when the user
 *   dismissed the picker without choosing.
 */
export async function pickModel(ctx: Context, selection: ModelSelectionRef): Promise<string | undefined> {
  const { options, choices, failed } = await discover(ctx)
  if (choices.length === 0) {
    return failed.length === 0
      ? 'no provider route advertises a model; configure one first'
      : `no models available: ${failed.join(', ')} could not be listed`
  }
  const current = selection.current
  const picked = await new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    const overlay = createSelectOverlay({
      title: 'Select a model',
      ...current === undefined ? {} : { detail: `current: ${current.provider} / ${current.model}` },
      choices,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: value => {
        dismiss()
        resolve(value)
      },
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
  })
  if (picked === undefined) return undefined
  const chosen = options[Number(picked)]
  if (chosen === undefined) return undefined
  // Preserve the reasoning effort: it belongs to the selection, and dropping it
  // on a model switch would silently reset a deliberate choice.
  selection.current = {
    provider: chosen.provider,
    model: chosen.model,
    ...current?.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort },
  }
  return `model set to ${chosen.provider} / ${chosen.model}`
}

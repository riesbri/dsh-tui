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
import { promptSelect } from './select.ts'
import type { SelectChoice } from './select.ts'
import { rememberSelection } from './selection.ts'

/** One offered model, kept beside its choice so nothing has to be parsed back. */
export interface ModelOption {
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
 * Every model on offer, for completing `/model`'s argument.
 * @param ctx - context carrying the llm registry.
 * @returns each route and model, in the order the picker lists them.
 */
export async function listModelOptions(ctx: Context): Promise<readonly ModelOption[]> {
  return (await discover(ctx)).options
}

/**
 * The option an argument names, if any.
 *
 * A bare model id is enough when only one route serves it, which is the case
 * worth optimizing for: `provider/model` is accepted too, and is the only way to
 * say which one when a gateway and a direct route both offer the same id.
 * @param argument - the text after the command name.
 * @param options - every model on offer.
 * @returns the matching option, or undefined when nothing matched.
 */
export function resolveModel(
  argument: string,
  options: readonly ModelOption[],
): ModelOption | undefined {
  const wanted = argument.trim().toLowerCase()
  if (wanted === '') return undefined
  return options.find(option => pricingKeyOf(option).toLowerCase() === wanted)
    ?? options.find(option => option.model.toLowerCase() === wanted)
}

/**
 * The `provider/model` spelling of one option.
 * @param option - the option.
 * @returns the qualified name.
 */
function pricingKeyOf(option: ModelOption): string {
  return `${option.provider}/${option.model}`
}

/**
 * Prompt for a model and apply the choice to `selection`.
 * @param ctx - context carrying the llm registry and the slot registry.
 * @param selection - the agent's mutable selection ref.
 * @param argument - the text after `/model`; empty opens the picker.
 * @returns a line to report in the transcript, or undefined when the user
 *   dismissed the picker without choosing.
 */
export async function pickModel(
  ctx: Context,
  selection: ModelSelectionRef,
  argument = '',
): Promise<string | undefined> {
  const { options, choices, failed } = await discover(ctx)
  if (choices.length === 0) {
    return failed.length === 0
      ? 'no provider route advertises a model; configure one first'
      : `no models available: ${failed.join(', ')} could not be listed`
  }
  const current = selection.current
  const named = argument.trim()
  if (named !== '') {
    const wanted = resolveModel(named, options)
    // Naming what IS on offer would mean listing every model every provider
    // advertises, which is what the picker is for; the count says how far it is.
    if (wanted === undefined) {
      return `no model named ${named}; type /model to choose from ${String(options.length)}`
    }
    return apply(ctx, selection, wanted, current)
  }
  const picked = await promptSelect(ctx, {
    title: 'Select a model',
    ...current === undefined ? {} : { detail: `current: ${current.provider} / ${current.model}` },
    choices,
  })
  if (picked === undefined) return undefined
  const chosen = options[Number(picked)]
  if (chosen === undefined) return undefined
  return apply(ctx, selection, chosen, current)
}

/**
 * Point the selection at one model, and remember it.
 * @param ctx - context carrying the default-model service.
 * @param selection - the agent's mutable selection ref.
 * @param chosen - the model to select.
 * @param current - the selection being replaced, for what it carries forward.
 * @returns a line to report in the transcript.
 */
async function apply(
  ctx: Context,
  selection: ModelSelectionRef,
  chosen: ModelOption,
  current: ModelSelectionRef['current'],
): Promise<string> {
  // Preserve the reasoning effort: it belongs to the selection, and dropping it
  // on a model switch would silently reset a deliberate choice.
  const next = {
    provider: chosen.provider,
    model: chosen.model,
    ...current?.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort },
  }
  // The ref is written FIRST and unconditionally. The turn about to run reads it,
  // and a storage failure is no reason for that turn to use the old model.
  selection.current = next
  const note = await rememberSelection(ctx, next)
  const said = `model set to ${chosen.provider} / ${chosen.model}`
  return note === undefined ? said : `${said} \u00b7 ${note}`
}

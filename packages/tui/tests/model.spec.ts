import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ModelOption } from '../src/model.ts'
import { listModelOptions, pickModel, resolveModel } from '../src/model.ts'

/** Two routes serving overlapping model ids, which is the case worth pinning. */
const CATALOG: Record<string, { id: string; name: string }[]> = {
  'deepseek-official': [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
  opencode: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
}

/** Every option the catalog above yields, in discovery order. */
const OPTIONS: readonly ModelOption[] = [
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  { provider: 'opencode', model: 'deepseek-v4-pro' },
]

/**
 * A context offering the llm registry and a slot registry that records pushes.
 * @returns the context, and whether an overlay was ever pushed.
 */
function llmContext(): { ctx: Context; pushed: () => boolean } {
  let opened = false
  const ctx = {
    llm: {
      listProviders: () => Object.keys(CATALOG).map(id => ({ id, name: id })),
      listModels: async (provider: string) => CATALOG[provider] ?? [],
    },
    tuiSlots: {
      pushOverlay: () => {
        opened = true
        return (): void => {}
      },
      invalidate: (): void => {},
    },
  } as unknown as Context
  return { ctx, pushed: () => opened }
}

/**
 * A selection ref on the flash route.
 * @param effort - the reasoning effort it starts on, if any.
 * @returns the ref.
 */
function selectionOn(effort?: string): ModelSelectionRef {
  return {
    current: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      ...effort === undefined ? {} : { reasoningEffort: effort },
    },
    assembled: undefined,
  } as unknown as ModelSelectionRef
}

describe('resolveModel()', () => {
  it('takes a bare model id when one route serves it', () => {
    expect(resolveModel('deepseek-v4-flash', OPTIONS)?.provider).toBe('deepseek-official')
  })

  it('matches whatever case it was typed in', () => {
    expect(resolveModel('  DeepSeek-V4-Flash ', OPTIONS)?.model).toBe('deepseek-v4-flash')
  })

  it('lets provider/model say which route, when two serve the same id', () => {
    // The bare id is ambiguous here and resolves to the first route discovered,
    // so the qualified spelling is the only way to reach the other one.
    expect(resolveModel('opencode/deepseek-v4-pro', OPTIONS)?.provider).toBe('opencode')
    expect(resolveModel('deepseek-v4-pro', OPTIONS)?.provider).toBe('deepseek-official')
  })

  it('matches nothing for a name no route offers', () => {
    expect(resolveModel('gpt-9', OPTIONS)).toBeUndefined()
    expect(resolveModel('', OPTIONS)).toBeUndefined()
  })
})

describe('listModelOptions()', () => {
  it('lists every route and model, for completing the argument', async () => {
    const { ctx } = llmContext()
    expect(await listModelOptions(ctx)).toEqual(OPTIONS)
  })
})

describe('pickModel() with an argument', () => {
  it('switches without opening the picker', async () => {
    const { ctx, pushed } = llmContext()
    const selection = selectionOn()
    const outcome = await pickModel(ctx, selection, ' deepseek-v4-pro ')
    expect(outcome).toContain('deepseek-v4-pro')
    expect(selection.current?.model).toBe('deepseek-v4-pro')
    expect(pushed()).toBe(false)
  })

  it('keeps the reasoning effort across the switch', async () => {
    // The effort belongs to the selection, and dropping it on a model switch
    // would silently reset a deliberate choice.
    const { ctx } = llmContext()
    const selection = selectionOn('max')
    await pickModel(ctx, selection, 'deepseek-v4-pro')
    expect(selection.current?.reasoningEffort).toBe('max')
  })

  it('says how many there are rather than listing every model', async () => {
    const { ctx, pushed } = llmContext()
    const selection = selectionOn()
    const outcome = await pickModel(ctx, selection, 'gpt-9')
    expect(outcome).toContain('no model named gpt-9')
    expect(outcome).toContain('3')
    expect(selection.current?.model).toBe('deepseek-v4-flash')
    expect(pushed()).toBe(false)
  })

  it('opens the picker when nothing was named', async () => {
    const { ctx, pushed } = llmContext()
    // Left unsettled on purpose: what matters is that the overlay went up, which
    // happens only after discovery has awaited every route's catalog.
    void pickModel(ctx, selectionOn(), '')
    await vi.waitFor(() => { expect(pushed()).toBe(true) })
  })
})

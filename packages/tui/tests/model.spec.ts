import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { stripAnsi } from '@riesbri/dsh-tui-renderer'
import type { TuiOverlay } from '../src/slots.ts'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
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
 * @returns the context, whether an overlay was pushed, and the one that was.
 */
function llmContext(): {
  ctx: Context
  pushed: () => boolean
  overlay: () => TuiOverlay | undefined
  saved: ModelSelection[]
} {
  let opened = false
  let mounted: TuiOverlay | undefined
  const saved: ModelSelection[] = []
  const services: Record<string, unknown> = {
    agentDefaultModel: { saveSelection: async (next: ModelSelection) => { saved.push(next) } },
    settings: {},
  }
  const ctx = {
    llm: {
      listProviders: () => Object.keys(CATALOG).map(id => ({ id, name: id })),
      listModels: async (provider: string) => CATALOG[provider] ?? [],
    },
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        opened = true
        mounted = overlay
        return (): void => { mounted = undefined }
      },
      invalidate: (): void => {},
    },
    get: (name: string) => services[name],
  } as unknown as Context
  return { ctx, pushed: () => opened, overlay: () => mounted, saved }
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

describe('what the picker offers', () => {
  it('labels every row with the argument /model accepts', async () => {
    // A gateway route advertises hundreds of models and the list is reached by
    // typing, so a row that showed a display name while the command took an id
    // would make the reader translate between the two.
    const { ctx, overlay } = llmContext()
    const running = pickModel(ctx, selectionOn())
    // Discovery awaits `listModels` per route, so the overlay is not mounted
    // until those have landed.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    const shown = stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')
    expect(shown).toContain('deepseek-official/deepseek-v4-flash')
    expect(shown).toContain('opencode/deepseek-v4-pro')
    expect(shown).toContain('current: deepseek-official/deepseek-v4-flash')
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    expect(await running).toBeUndefined()
  })

  it('puts a display name under the selection only when it adds something', async () => {
    // `DeepSeek-V4-Flash` is its own id with different capitals, so repeating it
    // under the row would spend a line saying nothing. `DeepSeek V4 Pro` is not,
    // so it earns one.
    const { ctx, overlay } = llmContext()
    const running = pickModel(ctx, selectionOn())
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    const first = stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')
    expect(first).toContain('deepseek-official/deepseek-v4-flash')
    expect(first).not.toContain('DeepSeek-V4-Flash')
    // Walk to the opencode row, whose name differs by more than its capitals.
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    expect(stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')).toContain('DeepSeek V4 Pro')
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await running
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

  it('stores the switch as the default every surface reads', async () => {
    // What makes a model chosen here the one the web interface opens with.
    const { ctx, saved } = llmContext()
    const outcome = await pickModel(ctx, selectionOn('max'), 'deepseek-v4-pro')
    expect(saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }])
    expect(outcome).toContain('also the default for new sessions')
  })

  it('stores nothing when the name matched nothing', async () => {
    const { ctx, saved } = llmContext()
    await pickModel(ctx, selectionOn(), 'gpt-9')
    expect(saved).toEqual([])
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

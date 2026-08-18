import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo, LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm'
import type { Key } from '@riesbri/dsh-tui-renderer'
import { effortLabel, pickReasoning, reasoningValues, resolveEffort } from '../src/reasoning.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** What a DeepSeek route advertises, in the adapter's own display order. */
const EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
] as unknown as readonly LlmReasoningEffortInfo[]

/** The same list with a default, as an adapter that configures one reports it. */
const REASONING = { efforts: EFFORTS, defaultEffort: 'high' } as unknown as LlmModelReasoningInfo

/**
 * A selection ref on a real route.
 * @param effort - the effort it starts on, if any.
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

/**
 * A context offering only the slot registry the picker touches.
 * @returns the context, and a reader for whatever overlay was pushed.
 */
function slotContext(): { ctx: Context; overlay: () => TuiOverlay | undefined } {
  let pushed: TuiOverlay | undefined
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        pushed = overlay
        return (): void => { pushed = undefined }
      },
      invalidate: (): void => {},
    },
  } as unknown as Context
  return { ctx, overlay: () => pushed }
}

/** One decoded keypress. */
const press = (name: string): Key => ({ kind: 'key', name } as unknown as Key)

describe('resolveEffort()', () => {
  it('matches an id the adapter published, whatever case it was typed in', () => {
    expect(resolveEffort('max', EFFORTS)?.id).toBe('max')
    expect(resolveEffort('MAX', EFFORTS)?.id).toBe('max')
    expect(resolveEffort('  High  ', EFFORTS)?.id).toBe('high')
  })

  it('rejects a word the adapter never advertised', () => {
    // Branding an unmatched word on trust would defer the failure to the
    // provider, one turn later, with an error the user cannot act on.
    expect(resolveEffort('low', EFFORTS)).toBeUndefined()
    expect(resolveEffort('', EFFORTS)).toBeUndefined()
  })
})

describe('reasoningValues()', () => {
  it('offers the adapter levels, with the clearing word last', () => {
    // Clearing is not one of the levels, so it does not sit among them: it
    // removes a selection rather than making one.
    expect(reasoningValues(REASONING).map(one => one.value)).toEqual(['off', 'high', 'max', 'default'])
  })

  it('offers nothing at all for a route with no levels', () => {
    // Not even the clearing word: there is no selection to clear, and a lone
    // `default` would advertise a setting the route does not have.
    expect(reasoningValues(undefined)).toEqual([])
  })
})

describe('effortLabel()', () => {
  it('stays quiet about the level the deployment already defaults to', () => {
    expect(effortLabel('high', REASONING)).toBeUndefined()
  })

  it('names a level the user chose over the default', () => {
    expect(effortLabel('max', REASONING)).toBe('max')
    expect(effortLabel('off', REASONING)).toBe('off')
  })

  it('says nothing when no level is set', () => {
    expect(effortLabel(undefined, REASONING)).toBeUndefined()
  })

  it('names any level when the adapter publishes no default to be the same as', () => {
    expect(effortLabel('high', { efforts: EFFORTS } as unknown as LlmModelReasoningInfo)).toBe('high')
  })
})

describe('pickReasoning()', () => {
  const { ctx } = slotContext()

  it('sets the level an argument names, without opening a picker', () => {
    const selection = selectionOn('high')
    return pickReasoning(ctx, selection, REASONING, 'max').then(outcome => {
      expect(outcome).toContain('max')
      expect(selection.current?.reasoningEffort).toBe('max')
    })
  })

  it('keeps the route the level applies to', () => {
    const selection = selectionOn()
    return pickReasoning(ctx, selection, REASONING, 'off').then(() => {
      expect(selection.current?.provider).toBe('deepseek-official')
      expect(selection.current?.model).toBe('deepseek-v4-flash')
    })
  })

  it('clears the level rather than setting one, on the default word', () => {
    // Clearing is not a level of its own: an absent effort restores the
    // provider's own behavior, which `off` — telling it not to think — is not.
    const selection = selectionOn('max')
    return pickReasoning(ctx, selection, REASONING, 'default').then(outcome => {
      expect(outcome).toContain('cleared')
      expect(selection.current?.reasoningEffort).toBeUndefined()
    })
  })

  it('names what IS accepted when a word matched nothing, and changes nothing', () => {
    // A bare rejection leaves the user guessing at a list only the adapter knows.
    const selection = selectionOn('high')
    return pickReasoning(ctx, selection, REASONING, 'turbo').then(outcome => {
      expect(outcome).toContain('off, high, max, default')
      expect(selection.current?.reasoningEffort).toBe('high')
    })
  })

  it('says so when the route advertises no levels at all', () => {
    const selection = selectionOn()
    return pickReasoning(ctx, selection, undefined, 'max').then(outcome => {
      expect(outcome).toContain('deepseek-v4-flash')
      expect(selection.current?.reasoningEffort).toBeUndefined()
    })
  })

  it('asks for a model first when none is selected', () => {
    const selection = { current: undefined, assembled: undefined } as ModelSelectionRef
    return pickReasoning(ctx, selection, REASONING, 'max').then(outcome => {
      expect(outcome).toContain('/model')
    })
  })
})

describe('the reasoning picker', () => {
  it('applies the highlighted level on enter', async () => {
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('high')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    overlay()?.handleKey(press('down'))
    overlay()?.handleKey(press('enter'))
    expect(await settled).toContain('high')
    expect(selection.current?.reasoningEffort).toBe('high')
  })

  it('offers clearing the level as the last choice', async () => {
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('max')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    overlay()?.handleKey(press('up'))
    overlay()?.handleKey(press('enter'))
    expect(await settled).toContain('cleared')
    expect(selection.current?.reasoningEffort).toBeUndefined()
  })

  it('leaves the level alone when the picker is dismissed', async () => {
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('max')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    overlay()?.handleKey(press('escape'))
    expect(await settled).toBeUndefined()
    expect(selection.current?.reasoningEffort).toBe('max')
  })
})

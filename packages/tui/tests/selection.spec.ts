import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { rememberSelection } from '../src/selection.ts'

/** The selection every test stores. */
const SELECTION = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max',
} as unknown as ModelSelection

/** How a fake deployment behaves when asked to store a selection. */
interface Deployment {
  /** Absent when no default-model service is mounted. */
  defaults?: 'ok' | 'throws'
  /** Whether a settings provider is mounted to receive the write. */
  settings?: boolean
}

/**
 * A context standing in for one deployment.
 * @param deployment - which services exist and how the write behaves.
 * @returns the context, and every selection it was asked to store.
 */
function context(deployment: Deployment): { ctx: Context; saved: ModelSelection[] } {
  const saved: ModelSelection[] = []
  const services: Record<string, unknown> = {}
  if (deployment.defaults !== undefined) {
    services.agentDefaultModel = {
      saveSelection: async (next: ModelSelection) => {
        saved.push(next)
        if (deployment.defaults === 'throws') throw new Error('settings.yaml is read-only')
      },
    }
  }
  if (deployment.settings === true) services.settings = {}
  return { ctx: { get: (name: string) => services[name] } as unknown as Context, saved }
}

describe('rememberSelection()', () => {
  it('stores the whole selection, effort included', async () => {
    // The settings section holds one selection. Writing half of it would leave
    // the model and the level disagreeing about which session they came from.
    const { ctx, saved } = context({ defaults: 'ok', settings: true })
    await rememberSelection(ctx, SELECTION)
    expect(saved).toEqual([SELECTION])
  })

  it('says so, once there is somewhere durable for it to land', async () => {
    const { ctx } = context({ defaults: 'ok', settings: true })
    expect(await rememberSelection(ctx, SELECTION)).toBe('also the default for new sessions')
  })

  it('claims nothing when no settings provider will receive the write', async () => {
    // The service keeps its composition entry and resolves anyway, so announcing
    // a saved default would announce something that dies with the process.
    const { ctx, saved } = context({ defaults: 'ok' })
    expect(await rememberSelection(ctx, SELECTION)).toBeUndefined()
    expect(saved).toHaveLength(1)
  })

  it('does nothing at all where no default-model service is mounted', async () => {
    const { ctx } = context({})
    expect(await rememberSelection(ctx, SELECTION)).toBeUndefined()
  })

  it('reports a failed write instead of throwing over it', async () => {
    // The switch has already happened in memory by the time this runs. A storage
    // failure is a reason to say so, not a reason to lose the switch.
    const { ctx } = context({ defaults: 'throws', settings: true })
    const note = await rememberSelection(ctx, SELECTION)
    expect(note).toContain('could not save it as the default')
    expect(note).toContain('read-only')
  })

  it('makes a failure message safe before it reaches the screen', async () => {
    // A write error can carry a path, and a path can carry anything.
    const saved: ModelSelection[] = []
    const ctx = {
      get: (name: string) => name === 'agentDefaultModel'
        ? {
          saveSelection: async (next: ModelSelection) => {
            saved.push(next)
            throw new Error('[2Jcannot write')
          },
        }
        : undefined,
    } as unknown as Context
    expect(await rememberSelection(ctx, SELECTION)).toContain('^[[2Jcannot write')
  })
})

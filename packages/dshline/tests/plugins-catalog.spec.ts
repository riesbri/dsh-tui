/** Joining the preset roster, the active session's actual preset, and one preset's composition. */

import { describe, expect, it, vi } from 'vitest'
import { PluginsCatalog } from '../src/plugins/catalog.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSeams } from '../src/plugins/harness.ts'
import type { PluginsSessionFacts } from '../src/plugins/model.ts'
import type { PluginsState } from '../src/plugins/catalog.ts'

const STANDARD_TEXT = `- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

/** What a test wants the seams to answer. */
interface Fixture {
  presets?: AgentPresetRow[]
  defaultId?: string
  composed?: string
  compositions?: Record<string, string | Error>
  authorable?: boolean
  withoutAgentPresets?: boolean
  withoutSettings?: boolean
}

/**
 * Build seams that answer exactly what a test asked for.
 * @param fixture - the answers.
 * @returns the seams.
 */
function seamsFor(fixture: Fixture): PluginsSeams {
  const agentPresets: AgentPresetsSeam = {
    get defaultId() { return fixture.defaultId ?? 'standard' },
    authorable: fixture.authorable ?? true,
    list: async () => fixture.presets ?? [
      { id: 'standard', trust: 'system', path: '/system/standard', name: 'Standard mode' },
    ],
    resolve: async (id?: string) => {
      const found = (fixture.presets ?? []).find(preset => preset.id === id)
      if (found === undefined) throw new Error(`unknown preset ${String(id)}`)
      return found
    },
    composedPreset: () => fixture.composed,
    recompose: async (_agentCtx, id) => ({ id, trust: 'user', path: `/user/${id}` }),
    read: async (id: string) => {
      const answer = fixture.compositions?.[id] ?? STANDARD_TEXT
      if (answer instanceof Error) throw answer
      return answer
    },
    copy: async () => {},
    remove: async () => {},
  }
  return {
    agentPresets: fixture.withoutAgentPresets === true ? undefined : agentPresets,
    settings: fixture.withoutSettings === true ? undefined : { mutate: async () => {} },
  }
}

/**
 * Read one complete pass.
 * @param fixture - what the seams answer.
 * @param session - the active session's facts.
 * @returns the reading.
 */
async function read(
  fixture: Fixture,
  session: PluginsSessionFacts = { headerPreset: undefined, events: [] },
): Promise<PluginsState> {
  const catalog = new PluginsCatalog({
    seams: seamsFor(fixture),
    agentCtx: {},
    session,
    invalidate: () => {},
  })
  catalog.refresh()
  await vi.waitFor(() => { expect(catalog.state().kind).not.toBe('loading') })
  return catalog.state()
}

describe('PluginsCatalog: capability absence', () => {
  it('reports unavailable, not a crash, when no agentPresets seam is mounted', async () => {
    const state = await read({ withoutAgentPresets: true })
    expect(state.kind).toBe('unavailable')
  })
})

describe('PluginsCatalog: a ready read', () => {
  it('joins the roster, default, and browsed composition', async () => {
    const state = await read({ defaultId: 'standard' })
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.defaultId).toBe('standard')
    expect(state.presets.map(row => row.id)).toEqual(['standard'])
    expect(state.browsing.kind).toBe('rows')
    if (state.browsing.kind !== 'rows') return
    expect(state.browsing.presetId).toBe('standard')
    expect(state.browsing.tree.rows.map(row => row.id)).toEqual(['tool-bash', 'tool-fs'])
  })

  it('reports capabilities from what is actually mounted', async () => {
    const state = await read({ withoutSettings: true, authorable: false })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.capabilities).toEqual({ agentPresets: true, settings: false, canWriteUserPresets: false })
  })

  it('reports blank true when the session has produced no turn', async () => {
    const state = await read({}, { headerPreset: undefined, events: [] })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.blank).toBe(true)
  })

  it('reports blank false once the session has a turn/start', async () => {
    const state = await read({}, { headerPreset: undefined, events: [{ type: 'turn/start' }] })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.blank).toBe(false)
  })

  it('prefers the agent-composed preset over the session log when both are present', async () => {
    const state = await read(
      { composed: 'from-composed', defaultId: 'standard' },
      { headerPreset: 'from-header', events: [] },
    )
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.sessionPresetId).toBe('from-composed')
  })

  it('falls back to the session log, then the default, when nothing is composed yet', async () => {
    const state = await read({ defaultId: 'standard' }, { headerPreset: undefined, events: [] })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.sessionPresetId).toBeUndefined()
    expect(state.browsing.kind).toBe('rows')
    if (state.browsing.kind !== 'rows') return
    expect(state.browsing.presetId).toBe('standard')
  })
})

describe('PluginsCatalog: system and user presets together', () => {
  it('lists both trusts without special-casing either', async () => {
    const state = await read({
      presets: [
        { id: 'standard', trust: 'system', path: '/system/standard', name: 'Standard mode' },
        { id: 'standard-custom', trust: 'user', path: '/user/standard-custom', name: 'Standard (custom)' },
      ],
    })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.presets.map(row => [row.id, row.trust])).toEqual([
      ['standard', 'system'],
      ['standard-custom', 'user'],
    ])
  })
})

describe('PluginsCatalog: broken composition never crashes the pass', () => {
  it('reports the browsed preset as broken when its file will not parse', async () => {
    const state = await read({ compositions: { standard: 'not: a\nlist\n' } })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.browsing).toEqual({ kind: 'broken', presetId: 'standard', reason: expect.any(String) })
  })

  it('reports the browsed preset as broken when reading it throws', async () => {
    const state = await read({ compositions: { standard: new Error('ENOENT') } })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.browsing).toEqual({ kind: 'broken', presetId: 'standard', reason: 'ENOENT' })
  })

  it('still lists the roster even when the browsed composition is broken', async () => {
    const state = await read({ compositions: { standard: new Error('ENOENT') } })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.presets).toHaveLength(1)
  })
})

describe('PluginsCatalog.browse: switching what is read without touching the session', () => {
  it('reads a different preset after browse(), leaving sessionPresetId untouched', async () => {
    const catalog = new PluginsCatalog({
      seams: seamsFor({
        presets: [
          { id: 'standard', trust: 'system', path: '/system/standard', name: 'Standard mode' },
          { id: 'standard-custom', trust: 'user', path: '/user/standard-custom' },
        ],
        compositions: { standard: STANDARD_TEXT, 'standard-custom': '- id: tool-fs\n  name: fs\n' },
        composed: 'standard',
      }),
      agentCtx: {},
      session: { headerPreset: undefined, events: [] },
      invalidate: () => {},
    })
    catalog.refresh()
    await vi.waitFor(() => { expect(catalog.state().kind).toBe('ready') })
    catalog.browse('standard-custom')
    await vi.waitFor(() => {
      const state = catalog.state()
      if (state.kind !== 'ready') throw new Error('not ready')
      expect(state.browsing.presetId).toBe('standard-custom')
    })
    const state = catalog.state()
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.sessionPresetId).toBe('standard')
  })
})

describe('PluginsCatalog: generation-stamped refresh', () => {
  it('drops a stale pass that settles after a newer one was already started', async () => {
    let resolveFirst: (() => void) | undefined
    const gate = new Promise<void>(resolve => { resolveFirst = resolve })
    let calls = 0
    const seams: PluginsSeams = {
      agentPresets: {
        get defaultId() { return 'standard' },
        authorable: true,
        list: async () => {
          calls += 1
          if (calls === 1) await gate
          return [{ id: 'standard', trust: 'system', path: '/s', name: 'Standard' }]
        },
        resolve: async id => ({ id: id ?? 'standard', trust: 'system', path: '/s' }),
        composedPreset: () => undefined,
        recompose: async (_ctx, id) => ({ id, trust: 'user', path: `/u/${id}` }),
        read: async () => STANDARD_TEXT,
        copy: async () => {},
        remove: async () => {},
      },
      settings: { mutate: async () => {} },
    }
    const invalidations: number[] = []
    const catalog = new PluginsCatalog({
      seams,
      agentCtx: {},
      session: { headerPreset: undefined, events: [] },
      invalidate: () => { invalidations.push(invalidations.length) },
    })
    catalog.refresh() // pass 1: blocked on `gate`
    catalog.refresh() // pass 2: resolves immediately, since calls > 1 skips the gate
    await vi.waitFor(() => { expect(catalog.state().kind).toBe('ready') })
    const settledAfterPass2 = invalidations.length
    resolveFirst?.()
    // Give the unblocked first pass a turn to (wrongly, if this fails) settle.
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(invalidations.length).toBe(settledAfterPass2)
  })

  it('drops results from passes that started before dispose()', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const seams: PluginsSeams = {
      agentPresets: {
        get defaultId() { return 'standard' },
        authorable: true,
        list: async () => { await gate; return [] },
        resolve: async id => ({ id: id ?? 'standard', trust: 'system', path: '/s' }),
        composedPreset: () => undefined,
        recompose: async (_ctx, id) => ({ id, trust: 'user', path: `/u/${id}` }),
        read: async () => STANDARD_TEXT,
        copy: async () => {},
        remove: async () => {},
      },
      settings: { mutate: async () => {} },
    }
    const catalog = new PluginsCatalog({
      seams,
      agentCtx: {},
      session: { headerPreset: undefined, events: [] },
      invalidate: () => {},
    })
    catalog.refresh()
    catalog.dispose()
    release?.()
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(catalog.state().kind).toBe('loading')
  })
})

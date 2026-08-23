/**
 * `mountAgentPreset`: composing an agent from its resolved Harness preset.
 *
 * A consumer-level test that `attachOptions`'s new setup step actually does
 * what dshline's own `cordis.patch.yml` now assumes: a fresh session gets
 * the roster's default, a resumed one gets whatever its own log recorded,
 * and a profile mounting no preset roster is left exactly as it was before
 * presets existed here.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mountAgentPreset } from '../src/window.ts'
import type { AgentPresetRow, AgentPresetsSeam } from '../src/plugins/harness.ts'

/** One fake roster preset. */
function preset(id: string, overrides: Partial<AgentPresetRow> = {}): AgentPresetRow {
  return { id, trust: 'system', path: `/presets/${id}/agent.cordis.yml`, ...overrides }
}

/**
 * A fake `agentPresets` seam recording every `mount` call.
 * @param defaultId - what `defaultId` reports.
 * @returns the seam, and the ids it was asked to mount, in order.
 */
function fakeAgentPresets(defaultId: string): { seam: AgentPresetsSeam; mounted: string[] } {
  const mounted: string[] = []
  const seam: AgentPresetsSeam = {
    get defaultId() { return defaultId },
    authorable: true,
    list: async () => [preset('standard'), preset('code'), preset('minimal'), preset('cordis')],
    resolve: async id => preset(id ?? defaultId),
    composedPreset: () => undefined,
    mount: async (_agentCtx, id) => {
      mounted.push(id ?? defaultId)
      return preset(id ?? defaultId)
    },
    recompose: async (_agentCtx, id) => preset(id),
    read: async () => '',
    copy: async () => {},
    remove: async () => {},
  }
  return { seam, mounted }
}

/**
 * A fake unpublished agent's own scope context.
 * @param agentPresets - the seam `ctx.get('agentPresets')` answers with.
 * @param session - the agent's own session facts, when one already exists
 * (a resumed session's already-reconstructed log; omitted for a fresh one
 * with nothing recorded yet).
 * @returns the fake context.
 */
function fakeAgentCtx(
  agentPresets: AgentPresetsSeam | undefined,
  session?: { header: { agentPreset?: string }; events: readonly { type: string; data?: unknown }[] },
): Context {
  return {
    get: (name: string) => (name === 'agentPresets' ? agentPresets : undefined),
    agent: session === undefined ? undefined : { session },
  } as unknown as Context
}

describe('mountAgentPreset', () => {
  it('mounts the roster default for a fresh session with nothing recorded yet', async () => {
    const { seam, mounted } = fakeAgentPresets('standard')
    await mountAgentPreset(fakeAgentCtx(seam, { header: {}, events: [] }))
    expect(mounted).toEqual(['standard'])
  })

  it('mounts the roster default when the agent has not composed anything at all', async () => {
    // No `agentCtx.agent` yet — the defensive path, not the one dshline's
    // own setup actually exercises (agentCtx.agent is always set by the
    // time setup runs), but mountAgentPreset must not throw if it changes.
    const { seam, mounted } = fakeAgentPresets('standard')
    await mountAgentPreset(fakeAgentCtx(seam, undefined))
    expect(mounted).toEqual(['standard'])
  })

  it('resumes under the preset the session\'s header recorded, not today\'s default', async () => {
    const { seam, mounted } = fakeAgentPresets('code')
    // Created under `standard` back when that was the default; `code` is the
    // default NOW, but this session must stay on what it was created with.
    await mountAgentPreset(fakeAgentCtx(seam, { header: { agentPreset: 'standard' }, events: [] }))
    expect(mounted).toEqual(['standard'])
  })

  it('resumes under a later logged selection, overriding the creation header', async () => {
    const { seam, mounted } = fakeAgentPresets('standard')
    await mountAgentPreset(fakeAgentCtx(seam, {
      header: { agentPreset: 'standard' },
      events: [{ type: 'agent-preset/selected', data: { agentPreset: 'standard-custom' } }],
    }))
    expect(mounted).toEqual(['standard-custom'])
  })

  it('is a no-op when no agentPresets seam is mounted', async () => {
    const calls: string[] = []
    const ctx = {
      get: (name: string) => { calls.push(name); return undefined },
      agent: undefined,
    } as unknown as Context
    await expect(mountAgentPreset(ctx)).resolves.toBeUndefined()
    expect(calls).toContain('agentPresets')
  })
})

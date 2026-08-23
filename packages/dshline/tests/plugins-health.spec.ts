/**
 * Whether an enabled preset row's Host capability actually exists.
 *
 * The distinction under test: a profile PROVIDES capabilities, a preset
 * EXPOSES them, and enabling a row proves only the second. These check that
 * the link is reported only where all three facts line up, and that a module
 * this frontend cannot prove anything about produces no verdict rather than a
 * guess.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CompositionRow } from '../src/plugins/composition.ts'
import { parseComposition } from '../src/plugins/composition.ts'
import type { HostCapabilities } from '../src/plugins/health.ts'
import {
  CAPABILITY_LINKS,
  healthFacts,
  hostCapabilities,
  rowHealth,
  unbackedWhileEnabled,
} from '../src/plugins/health.ts'

/** A Host mounting a subagent registry with exactly these providers. */
function host(providers: readonly string[] | undefined): HostCapabilities {
  return { subagentProviders: providers }
}

/** One leaf row, with sensible defaults. */
function row(overrides: Partial<CompositionRow> = {}): CompositionRow {
  return {
    locator: { steps: [{ index: 0, name: '@deepseek-ai/dsh-tool-subagent', id: 'delegate' }] },
    path: ['delegate'],
    id: 'delegate',
    name: '@deepseek-ai/dsh-tool-subagent',
    depth: 0,
    group: false,
    disabled: { kind: 'enabled' },
    effective: 'enabled',
    configProvider: 'made-up',
    ...overrides,
  }
}

describe('reading the Host capability registries', () => {
  it('reports the provider names a mounted subagent registry lists', () => {
    const ctx = { get: (name: string) => (name === 'subagents' ? { list: () => ['spawn', 'fork'] } : undefined) }
    expect(hostCapabilities(ctx as unknown as Context)).toEqual({ subagentProviders: ['spawn', 'fork'] })
  })

  it('reports nothing readable when no registry is mounted', () => {
    const ctx = { get: () => undefined }
    expect(hostCapabilities(ctx as unknown as Context)).toEqual({ subagentProviders: undefined })
  })

  it('treats a registry that throws as unreadable rather than as empty', () => {
    // An empty list would mark every delegation row in the preset as broken
    // off one failed read — the loudest possible wrong answer.
    const ctx = {
      get: () => ({ list: () => { throw new Error('registry is mid-teardown') } }),
    }
    expect(hostCapabilities(ctx as unknown as Context)).toEqual({ subagentProviders: undefined })
  })
})

describe('what can be proven about one row', () => {
  it('confirms a row whose provider the registry supplies', () => {
    expect(rowHealth(row({ configProvider: 'spawn' }), host(['spawn', 'fork'])))
      .toEqual({ kind: 'satisfied', provider: 'spawn' })
  })

  it('reports a provider the mounted registry does not supply', () => {
    expect(rowHealth(row({ configProvider: 'absent-provider' }), host(['spawn'])))
      .toEqual({ kind: 'missing', registry: 'subagents', provider: 'absent-provider' })
  })

  it('claims nothing when no registry is mounted to ask', () => {
    expect(rowHealth(row({ configProvider: 'spawn' }), host(undefined))).toEqual({ kind: 'unknown' })
  })

  it('claims nothing for a module the link table does not cover', () => {
    // A row may carry `config.provider` for its own unrelated reasons; the
    // parser reads the FIELD and this module only judges modules whose meaning
    // for that field is known.
    expect(rowHealth(row({ name: '@example/unrelated-plugin', configProvider: 'spawn' }), host([])))
      .toEqual({ kind: 'unknown' })
  })

  it('claims nothing for a row that names no provider', () => {
    expect(rowHealth(row({ configProvider: undefined }), host([]))).toEqual({ kind: 'unknown' })
  })

  it('claims nothing for a group row', () => {
    expect(rowHealth(row({ group: true, configProvider: 'spawn' }), host([]))).toEqual({ kind: 'unknown' })
  })

  it('judges by module name, not by row id, so two ids of one module agree', () => {
    const first = row({ id: 'delegate-a', configProvider: 'gone' })
    const second = row({ id: 'delegate-b', configProvider: 'gone' })
    expect(rowHealth(first, host([]))).toEqual(rowHealth(second, host([])))
  })

  it('covers more than one module, which is what makes it a table', () => {
    // Two entries, both resolving a provider from the same registry: one a
    // delegation tool, one a workflow backend. If this ever shrinks to a
    // single entry it has become a special case.
    expect(Object.keys(CAPABILITY_LINKS).length).toBeGreaterThan(1)
    expect(new Set(Object.values(CAPABILITY_LINKS))).toEqual(new Set(['subagents']))
  })

  it('names no provider anywhere in the link table', () => {
    // The table keys on capability MODULES. A provider name appearing here
    // would be the provider-specific branch this design exists to avoid.
    expect(Object.keys(CAPABILITY_LINKS).join(' ')).not.toMatch(/codex|claude|spawn|fork/u)
  })
})

describe('when a missing provider is worth marking', () => {
  it('marks a row this preset turns on that the Host cannot back', () => {
    const enabled = row({ configProvider: 'gone', disabled: { kind: 'enabled' }, effective: 'enabled' })
    const health = rowHealth(enabled, host([]))
    expect(unbackedWhileEnabled(enabled, health)).toBe(true)
    expect(healthFacts(enabled, health)).toEqual(['enabled in preset · provider "gone" unavailable'])
  })

  it('does not mark a disabled row whose provider is absent — that is consistent', () => {
    // Every optional delegation row in the shipped preset ships exactly like
    // this; marking them would put a warning on most of a stock composition.
    const off = row({ configProvider: 'gone', disabled: { kind: 'disabled' }, effective: 'disabled' })
    const health = rowHealth(off, host([]))
    expect(unbackedWhileEnabled(off, health)).toBe(false)
    expect(healthFacts(off, health)).toEqual(['provider "gone" not installed in this profile'])
  })

  it('does not mark a row switched off by its parent group', () => {
    const inherited = row({ configProvider: 'gone', disabled: { kind: 'enabled' }, effective: 'disabled' })
    expect(unbackedWhileEnabled(inherited, rowHealth(inherited, host([])))).toBe(false)
  })

  it('says nothing at all when the provider is present', () => {
    const ok = row({ configProvider: 'spawn' })
    expect(healthFacts(ok, rowHealth(ok, host(['spawn'])))).toEqual([])
  })
})

describe('the provider a row declares, read off a real composition', () => {
  it('reads config.provider as a plain string', () => {
    const tree = parseComposition(`- id: delegate
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configProvider).toBe('spawn')
  })

  it('never reads a !!js provider, since it is never evaluated', () => {
    // No name to check a registry against, so claiming one would be a guess.
    const tree = parseComposition(`- id: delegate
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: !!js process.env.PROVIDER
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configProvider).toBeUndefined()
    expect(rowHealth(tree.rows[0] as CompositionRow, host([]))).toEqual({ kind: 'unknown' })
  })

  it('reads no provider from a group row, whose config is the child list', () => {
    const tree = parseComposition(`- id: delegation
  name: cordis:group
  group: true
  config:
    - id: delegate
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configProvider).toBeUndefined()
    expect(tree.rows[1]?.configProvider).toBe('fork')
  })
})

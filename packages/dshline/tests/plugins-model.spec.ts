/** Session facts, roster joins, search, and the toggle/switch authority boundary. */

import { describe, expect, it } from 'vitest'
import type { CompositionRow } from '../src/plugins/composition.ts'
import type { AgentPresetRow } from '../src/plugins/harness.ts'
import {
  compositionRowFacts,
  filterCompositionRows,
  filterPresetRows,
  matchesCompositionRow,
  matchesPresetRow,
  presetRows,
  presetSwitchEligibility,
  rowMark,
  toggleEligibility,
} from '../src/plugins/model.ts'
import type { PluginsSessionFacts } from '../src/plugins/harness.ts'

/**
 * One composition row, with sensible defaults.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function row(overrides: Partial<CompositionRow> = {}): CompositionRow {
  return {
    locator: { steps: [{ index: 0, name: '@deepseek-ai/dsh-subagent-codex', id: 'tool-subagent-codex' }] },
    path: ['tool-subagent-codex'],
    id: 'tool-subagent-codex',
    name: '@deepseek-ai/dsh-subagent-codex',
    depth: 0,
    group: false,
    disabled: { kind: 'enabled' },
    effective: 'enabled',
    ...overrides,
  }
}

describe('presetRows', () => {
  const ROSTER: AgentPresetRow[] = [
    { id: 'standard', trust: 'system', path: '/system/standard', name: 'Standard mode', description: 'Full coding agent' },
    { id: 'code', trust: 'system', path: '/system/code', name: 'PTC mode' },
    { id: 'standard-custom', trust: 'user', path: '/user/standard-custom', name: 'Standard (custom)' },
    { id: 'broken-one', trust: 'user', path: '/user/broken-one', broken: 'composition is not a list of entries' },
  ]

  it('preserves roster order without re-ranking', () => {
    const rows = presetRows(ROSTER, 'code', 'standard')
    expect(rows.map(r => r.id)).toEqual(['standard', 'code', 'standard-custom', 'broken-one'])
  })

  it('marks exactly the session-resolved preset as current', () => {
    const rows = presetRows(ROSTER, 'standard-custom', 'standard')
    expect(rows.find(r => r.isCurrent)?.id).toBe('standard-custom')
    expect(rows.filter(r => r.isCurrent)).toHaveLength(1)
  })

  it('marks exactly the default id as default, independent of current', () => {
    const rows = presetRows(ROSTER, 'code', 'standard')
    expect(rows.find(r => r.isDefault)?.id).toBe('standard')
    expect(rows.find(r => r.id === 'code')?.isDefault).toBe(false)
  })

  it('falls back to id for name and carries broken through untouched', () => {
    const rows = presetRows(ROSTER, undefined, 'standard')
    const broken = rows.find(r => r.id === 'broken-one')
    expect(broken?.name).toBe('broken-one')
    expect(broken?.broken).toBe('composition is not a list of entries')
  })

  it('reports no current row when the session preset resolves to nothing in the roster', () => {
    const rows = presetRows(ROSTER, 'deleted-preset', 'standard')
    expect(rows.some(r => r.isCurrent)).toBe(false)
  })
})

describe('search: composition rows', () => {
  const ROWS = [
    row({ path: ['tool-bash'], id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }),
    row({ path: ['tool-fs'], id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }),
    row({
      path: ['delegation', 'tool-subagent-codex'],
      id: 'tool-subagent-codex',
      name: '@deepseek-ai/dsh-subagent-codex',
      depth: 1,
    }),
    row({
      path: ['tool-workflow'],
      id: 'tool-workflow',
      name: '@deepseek-ai/dsh-tool-workflow',
    }),
  ]

  it('matches by row id, case-insensitively', () => {
    expect(matchesCompositionRow(ROWS[2]!, 'CODEX')).toBe(true)
    expect(filterCompositionRows(ROWS, 'codex').map(r => r.id)).toEqual(['tool-subagent-codex'])
  })

  it('matches by package/module name', () => {
    expect(filterCompositionRows(ROWS, 'subagent').map(r => r.id)).toEqual(['tool-subagent-codex'])
  })

  it('matches "workflow" and "bash" as the spec examples require', () => {
    expect(filterCompositionRows(ROWS, 'workflow').map(r => r.id)).toEqual(['tool-workflow'])
    expect(filterCompositionRows(ROWS, 'bash').map(r => r.id)).toEqual(['tool-bash'])
  })

  it('returns every row, in order, for an empty query', () => {
    expect(filterCompositionRows(ROWS, '')).toEqual(ROWS)
  })

  it('returns nothing for a query matching no row', () => {
    expect(filterCompositionRows(ROWS, 'nonexistent')).toEqual([])
  })

  it('still matches an id-less row by name alone', () => {
    const idless = row({
      locator: { steps: [{ index: 5, name: '@deepseek-ai/dsh-tool-workflow', id: undefined }] },
      path: ['@deepseek-ai/dsh-tool-workflow'],
      id: undefined,
      name: '@deepseek-ai/dsh-tool-workflow',
    })
    expect(matchesCompositionRow(idless, 'workflow')).toBe(true)
    expect(filterCompositionRows([...ROWS, idless], 'workflow').map(r => r.name)).toContain(
      '@deepseek-ai/dsh-tool-workflow',
    )
  })
})

describe('search: preset rows', () => {
  const ROWS = presetRows(
    [
      { id: 'standard', trust: 'system', path: '/s', name: 'Standard mode' },
      { id: 'cordis', trust: 'system', path: '/c', name: 'Creator mode' },
    ],
    undefined,
    'standard',
  )

  it('matches by id or display name', () => {
    expect(filterPresetRows(ROWS, 'creator').map(r => r.id)).toEqual(['cordis'])
    expect(filterPresetRows(ROWS, 'cordis').map(r => r.id)).toEqual(['cordis'])
  })
})

describe('rowMark / compositionRowFacts', () => {
  it('marks an enabled row filled, a disabled row hollow, a conditional row half', () => {
    expect(rowMark(row({ disabled: { kind: 'enabled' } }))).toBe('●')
    expect(rowMark(row({ disabled: { kind: 'disabled' } }))).toBe('○')
    expect(rowMark(row({ disabled: { kind: 'conditional', expression: 'x' } }))).toBe('◐')
  })

  it('shows own state honestly even when a parent group disables it, and names the discrepancy', () => {
    const inherited = row({ disabled: { kind: 'enabled' }, effective: 'disabled' })
    expect(rowMark(inherited)).toBe('●')
    expect(compositionRowFacts(inherited)).toContain('off via parent group')
  })

  it('surfaces the raw condition expression as a fact', () => {
    const conditional = row({ disabled: { kind: 'conditional', expression: "process.platform === 'win32'" } })
    expect(compositionRowFacts(conditional)).toContain("condition: process.platform === 'win32'")
  })

  it('includes the config summary when present', () => {
    expect(compositionRowFacts(row({ configSummary: 'provider=codex' }))).toContain('provider=codex')
  })
})

describe('toggleEligibility: Harness ownership boundary', () => {
  const SYSTEM = { trust: 'system' as const }
  const USER = { trust: 'user' as const }
  const WRITABLE = { canWriteUserPresets: true }
  const NOT_WRITABLE = { canWriteUserPresets: false }

  it('offers a plain toggle for a leaf row on a user preset', () => {
    const result = toggleEligibility(row({ disabled: { kind: 'enabled' } }), USER, WRITABLE)
    expect(result).toEqual({ kind: 'toggle', enable: false })
  })

  it('computes enable correctly from the current disabled state', () => {
    const result = toggleEligibility(row({ disabled: { kind: 'disabled' } }), USER, WRITABLE)
    expect(result).toEqual({ kind: 'toggle', enable: true })
  })

  it('requires a copy-to-customize flow on a system preset, never toggling in place', () => {
    const result = toggleEligibility(row({ disabled: { kind: 'enabled' } }), SYSTEM, WRITABLE)
    expect(result).toEqual({ kind: 'requires-copy' })
  })

  it('refuses to toggle a conditional row even on a user preset', () => {
    const result = toggleEligibility(
      row({ disabled: { kind: 'conditional', expression: 'x' } }),
      USER,
      WRITABLE,
    )
    expect(result.kind).toBe('conditional')
  })

  it('regression: a conditional row on a SYSTEM preset refuses directly, never offering copy first', () => {
    const result = toggleEligibility(
      row({ disabled: { kind: 'conditional', expression: "process.platform === 'win32'" } }),
      SYSTEM,
      WRITABLE,
    )
    expect(result.kind).toBe('conditional')
  })

  it('reports unavailable when there is no writable preset root', () => {
    const result = toggleEligibility(row(), USER, NOT_WRITABLE)
    expect(result.kind).toBe('unavailable')
  })

  it('reports unavailable for a group row, which has no single on/off state', () => {
    const result = toggleEligibility(row({ group: true }), USER, WRITABLE)
    expect(result.kind).toBe('unavailable')
  })
})

describe('presetSwitchEligibility: what the picker may OFFER', () => {
  it('offers a switch while the turnBoundary projection reports no turn', () => {
    const session: PluginsSessionFacts = { presetId: 'standard', started: false }
    expect(presetSwitchEligibility(session)).toEqual({ kind: 'recompose' })
  })

  it('redirects a started session to the default for the next one instead', () => {
    const session: PluginsSessionFacts = { presetId: 'standard', started: true }
    const result = presetSwitchEligibility(session)
    expect(result.kind).toBe('locked')
    if (result.kind !== 'locked') return
    expect(result.message).toContain('default for the next session')
  })
})

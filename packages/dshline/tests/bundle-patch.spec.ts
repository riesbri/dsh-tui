/**
 * `cordis.patch.yml`: the agent plane moves behind agent presets exactly
 * once, never twice.
 *
 * This is dshline's own shipped composition, not a fixture — a regression
 * here means a fresh install gets it wrong. The check is structural, not a
 * live Cordis mount (nothing in this repo boots a real Loader tree in a
 * unit test): every row `dsh-base` mounts unconditionally that a Harness
 * preset also lists must be disabled here, `agent-presets` must be
 * inserted with a real default, and no id may be both disabled and
 * (re-)inserted by this same file — that would be dshline arguing with
 * itself about whether one row exists.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** One insert/disable/patch entry, as the Loader's patch-list dialect shapes it. */
interface PatchEntry {
  readonly id?: string
  readonly disabled?: boolean
  readonly insert?: readonly { readonly id: string; readonly name: string; readonly config?: unknown }[]
}

/**
 * Every row id `dsh-base` mounts unconditionally that a shipped Harness
 * preset (`standard`/`code`/`minimal`/`cordis`) also lists — copied
 * verbatim from `packages/bundle/web-app/cordis.patch.yml` in
 * deepseek-harness, the reference implementation of this exact move.
 */
const EXPECTED_DISABLED = [
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
]

/** Rows this file explicitly keeps host-plane (never disabled), and why. */
const DELIBERATELY_NOT_DISABLED = [
  // A process singleton with a cross-session query surface; a preset row
  // registers a continuable setup on it rather than a tool the agent calls.
  'tool-subagent-report',
]

function loadPatch(): readonly PatchEntry[] {
  const parsed: unknown = parse(readFileSync(PATCH_PATH, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml must be a top-level list')
  return parsed as readonly PatchEntry[]
}

function disabledIds(patch: readonly PatchEntry[]): string[] {
  return patch.filter(entry => entry.disabled === true && entry.id !== undefined).map(entry => entry.id as string)
}

function insertedIds(patch: readonly PatchEntry[]): string[] {
  return patch.flatMap(entry => entry.insert?.map(row => row.id) ?? [])
}

describe('cordis.patch.yml: the agent plane moves behind agent presets', () => {
  it('disables exactly the rows a shipped preset also composes, no more and no fewer', () => {
    const patch = loadPatch()
    expect(disabledIds(patch).sort()).toEqual([...EXPECTED_DISABLED].sort())
  })

  it('never disables the rows this file deliberately keeps host-plane', () => {
    const patch = loadPatch()
    const disabled = new Set(disabledIds(patch))
    for (const id of DELIBERATELY_NOT_DISABLED) expect(disabled.has(id)).toBe(false)
  })

  it('inserts the preset roster with a real default', () => {
    const patch = loadPatch()
    const agentPresets = patch
      .flatMap(entry => entry.insert ?? [])
      .find(row => row.id === 'agent-presets')
    expect(agentPresets?.name).toBe('@deepseek-ai/dsh-agent-presets')
    expect((agentPresets?.config as { default?: unknown } | undefined)?.default).toBe('standard')
  })

  it('never both disables and (re-)inserts the same row id', () => {
    // A row this file disables and ALSO inserts under the same id would be
    // this file contradicting itself about whether that row exists at all.
    const patch = loadPatch()
    const disabled = new Set(disabledIds(patch))
    const inserted = insertedIds(patch)
    const overlap = inserted.filter(id => disabled.has(id))
    expect(overlap).toEqual([])
  })

  it('no longer inserts its own tool-ask-user row (each preset owns that choice now)', () => {
    // Whether an agent gets ask_user is the PRESET's decision — standard
    // mounts it, minimal (a deliberately two-tool preset) does not — and a
    // copy here would force it back on regardless of what a preset says.
    const patch = loadPatch()
    expect(insertedIds(patch)).not.toContain('tool-ask-user')
  })

  it('still inserts the frontend\'s own two rows', () => {
    const patch = loadPatch()
    expect(insertedIds(patch)).toEqual(expect.arrayContaining(['dshline-startup', 'dshline']))
  })
})

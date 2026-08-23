/** The writes `/plugins` performs, each through the seam that owns it. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyPreset, setDefaultPreset, switchPreset, toggleRow } from '../src/plugins/actions.ts'
import type { PresetSelectionLog } from '../src/plugins/actions.ts'
import { parseComposition } from '../src/plugins/composition.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSettings } from '../src/plugins/harness.ts'
import type { PluginsSessionFacts } from '../src/plugins/model.ts'

const USER_TEXT = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
`

let dir: string | undefined

/**
 * A temp composition file with the given text.
 * @param text - the file's content.
 * @returns the file's absolute path.
 */
async function tempComposition(text: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'dshline-plugins-'))
  const path = join(dir, 'agent.cordis.yml')
  await writeFile(path, text, 'utf8')
  return path
}

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/**
 * A minimal seam whose `read` reads the real file at `path`.
 * @param path - the composition file's path.
 * @param overrides - fields to replace on the fake seam.
 * @returns the seam.
 */
function seamFor(path: string, overrides: Partial<AgentPresetsSeam> = {}): AgentPresetsSeam {
  return {
    defaultId: 'standard',
    authorable: true,
    list: async () => [],
    resolve: async id => ({ id: id ?? 'mine', trust: 'user', path }),
    composedPreset: () => undefined,
    recompose: async (_ctx, id) => ({ id, trust: 'user', path }),
    read: async () => readFile(path, 'utf8'),
    copy: async () => {},
    remove: async () => {},
    ...overrides,
  }
}

function locatorFor(id: string, text: string) {
  const tree = parseComposition(text)
  if (tree.kind !== 'parsed') throw new Error('fixture does not parse')
  const row = tree.rows.find(r => r.id === id)
  if (row === undefined) throw new Error(`row ${id} not found`)
  return row.locator
}

describe('toggleRow', () => {
  it('refuses a system preset outright, never opening the file', async () => {
    const path = await tempComposition(USER_TEXT)
    const seam = seamFor(path)
    const systemPreset: AgentPresetRow = { id: 'standard', trust: 'system', path }
    const outcome = await toggleRow(seam, systemPreset, locatorFor('tool-fs', USER_TEXT), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('built-in')
    expect(await readFile(path, 'utf8')).toBe(USER_TEXT)
  })

  it('disables an enabled row on a real user-preset file', async () => {
    const path = await tempComposition(USER_TEXT)
    const seam = seamFor(path)
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const outcome = await toggleRow(seam, userPreset, locatorFor('tool-fs', USER_TEXT), false)
    expect(outcome.kind).toBe('done')
    const written = await readFile(path, 'utf8')
    const tree = parseComposition(written)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
    // Unrelated rows untouched.
    expect(tree.rows.find(r => r.id === 'tool-bash')?.disabled).toEqual({ kind: 'disabled' })
  })

  it('enables a disabled row on a real user-preset file', async () => {
    const path = await tempComposition(USER_TEXT)
    const seam = seamFor(path)
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const outcome = await toggleRow(seam, userPreset, locatorFor('tool-bash', USER_TEXT), true)
    expect(outcome.kind).toBe('done')
    const written = await readFile(path, 'utf8')
    expect(written).not.toContain('disabled: true')
    const tree = parseComposition(written)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-bash')?.disabled).toEqual({ kind: 'enabled' })
  })

  it('refuses a conditional row and leaves the file untouched', async () => {
    const path = await tempComposition(USER_TEXT)
    const seam = seamFor(path)
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const outcome = await toggleRow(seam, userPreset, locatorFor('tool-pwsh', USER_TEXT), true)
    expect(outcome.kind).toBe('failed')
    expect(await readFile(path, 'utf8')).toBe(USER_TEXT)
  })

  it('is a no-op — and never writes — when the row already holds the requested state', async () => {
    const path = await tempComposition(USER_TEXT)
    const seam = seamFor(path)
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const before = await readFile(path, 'utf8')
    const outcome = await toggleRow(seam, userPreset, locatorFor('tool-fs', USER_TEXT), true)
    expect(outcome.kind).toBe('done')
    expect(outcome.message).toContain('already')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('reports failure when re-reading through the seam disagrees with what was written', async () => {
    const path = await tempComposition(USER_TEXT)
    // The real file is fine; the SEAM's read (what actions.ts re-validates
    // through) is rigged to disagree, exercising the "wrote it, but Harness's
    // own re-read says it is broken" branch without needing a real broken
    // write (toggleDisabled cannot itself produce broken text).
    const seam = seamFor(path, { read: async () => 'not: a\nlist\n' })
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const outcome = await toggleRow(seam, userPreset, locatorFor('tool-fs', USER_TEXT), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('no longer parses')
  })

  it('reports not-found rather than writing when the locator no longer matches', async () => {
    const path = await tempComposition(USER_TEXT)
    const seam = seamFor(path)
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const staleLocator = locatorFor('tool-fs', USER_TEXT)
    // Simulate an external edit that shifted every index by prepending a row.
    await writeFile(path, `- id: tool-workflow\n  name: '@deepseek-ai/dsh-tool-workflow'\n${USER_TEXT}`, 'utf8')
    const outcome = await toggleRow(seam, userPreset, staleLocator, false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('changed')
  })
})

describe('copyPreset', () => {
  it('reports done and calls through to the seam', async () => {
    const calls: { from: string; id: string; name: string | undefined }[] = []
    const seam = seamFor('/unused', { copy: async (from, id, name) => { calls.push({ from, id, name }) } })
    const outcome = await copyPreset(seam, 'standard', 'standard-custom')
    expect(outcome.kind).toBe('done')
    expect(calls).toEqual([{ from: 'standard', id: 'standard-custom', name: undefined }])
  })

  it('reports failure with the seam\'s own reason', async () => {
    const seam = seamFor('/unused', {
      copy: async () => { throw new Error('a preset already exists with id "standard-custom"') },
    })
    const outcome = await copyPreset(seam, 'standard', 'standard-custom')
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('already exists')
  })
})

describe('switchPreset', () => {
  function log(): { log: PresetSelectionLog; entries: { agentPreset: string }[] } {
    const entries: { agentPreset: string }[] = []
    return { log: { append: (_type, data) => { entries.push(data) } }, entries }
  }

  it('refuses without calling recompose when the session has already started', async () => {
    let recomposeCalled = false
    const seam = seamFor('/unused', { recompose: async (_ctx, id) => { recomposeCalled = true; return { id, trust: 'user', path: '/x' } } })
    const started: PluginsSessionFacts = { headerPreset: 'standard', events: [{ type: 'turn/start' }] }
    const { log: l, entries } = log()
    const outcome = await switchPreset(seam, {}, started, l, 'code')
    expect(outcome.kind).toBe('failed')
    expect(recomposeCalled).toBe(false)
    expect(entries).toEqual([])
  })

  it('recomposes and logs the selection for a blank session', async () => {
    const seam = seamFor('/unused', { recompose: async (_ctx, id) => ({ id, trust: 'system', path: '/x' }) })
    const blank: PluginsSessionFacts = { headerPreset: 'standard', events: [] }
    const { log: l, entries } = log()
    const outcome = await switchPreset(seam, {}, blank, l, 'code')
    expect(outcome.kind).toBe('done')
    expect(entries).toEqual([{ agentPreset: 'code' }])
  })

  it('logs the id recompose actually returns, not necessarily the one requested', async () => {
    const seam = seamFor('/unused', { recompose: async () => ({ id: 'code-resolved', trust: 'system', path: '/x' }) })
    const blank: PluginsSessionFacts = { headerPreset: undefined, events: [] }
    const { log: l, entries } = log()
    await switchPreset(seam, {}, blank, l, 'code')
    expect(entries).toEqual([{ agentPreset: 'code-resolved' }])
  })

  it('reports failure without logging when recompose itself throws', async () => {
    const seam = seamFor('/unused', { recompose: async () => { throw new Error('unknown preset') } })
    const blank: PluginsSessionFacts = { headerPreset: undefined, events: [] }
    const { log: l, entries } = log()
    const outcome = await switchPreset(seam, {}, blank, l, 'nonexistent')
    expect(outcome.kind).toBe('failed')
    expect(entries).toEqual([])
  })
})

describe('setDefaultPreset', () => {
  it('mutates the agent-presets namespace with the exact set/default op', async () => {
    const calls: { ns: string; ops: unknown }[] = []
    const settings: PluginsSettings = { mutate: async (ns, ops) => { calls.push({ ns, ops }) } }
    const outcome = await setDefaultPreset(settings, 'standard-custom')
    expect(outcome.kind).toBe('done')
    expect(calls).toEqual([{ ns: 'agent-presets', ops: [{ op: 'set', path: ['default'], value: 'standard-custom' }] }])
  })

  it('reports failure with the settings seam\'s own reason', async () => {
    const settings: PluginsSettings = { mutate: async () => { throw new Error('revision conflict') } }
    const outcome = await setDefaultPreset(settings, 'standard-custom')
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('revision conflict')
  })
})

/** The writes `/plugins` performs, each through the seam that owns it. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { copyPreset, setDefaultPreset, switchPreset, toggleRow } from '../src/plugins/actions.ts'
import { parseComposition } from '../src/plugins/composition.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsAgent, PluginsSettings } from '../src/plugins/harness.ts'

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
    select: async (_agent, id) => id,
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

  it('reports failure when Harness itself reports the preset broken after the write', async () => {
    const path = await tempComposition(USER_TEXT)
    // The write succeeds; `resolve()` — Harness's own health check, the same
    // one `list()` reports `broken` from — is rigged to disagree, exercising
    // "wrote it, but Harness now refuses the file" without dshline's own
    // parser getting a vote in what counts as broken.
    const seam = seamFor(path, {
      resolve: async id => ({ id: id ?? 'mine', trust: 'user', path, broken: 'a service row escaped its isolate realm' }),
    })
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const outcome = await toggleRow(seam, userPreset, locatorFor('tool-fs', USER_TEXT), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('Harness now reports it broken')
    expect(outcome.message).toContain('isolate realm')
  })

  it('reports failure when re-resolving through Harness throws after a successful write', async () => {
    const path = await tempComposition(USER_TEXT)
    const seam = seamFor(path, { resolve: async () => { throw new Error('roster is being re-scanned') } })
    const userPreset: AgentPresetRow = { id: 'mine', trust: 'user', path }
    const outcome = await toggleRow(seam, userPreset, locatorFor('tool-fs', USER_TEXT), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('could not re-resolve it through Harness')
    // The write itself already landed — re-resolve failing does not undo it.
    const written = await readFile(path, 'utf8')
    const tree = parseComposition(written)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
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
  /**
   * A live agent shape over a real detached root Session.
   * @returns the agent handed to `select`.
   */
  function agent(): PluginsAgent {
    const id = SessionId('switch-1')
    return { id, ctx: {}, session: Session.create(id) }
  }

  it('hands the switch to Harness and appends nothing of its own', async () => {
    const seen: { id: string; agentPreset: string }[] = []
    const seam = seamFor('/unused', {
      select: async (a, agentPreset) => {
        seen.push({ id: String(a.id), agentPreset })
        return agentPreset
      },
      // Present so a regression that reintroduced dshline's own orchestration
      // would be visible rather than silently equivalent.
      recompose: async () => { throw new Error('switchPreset must not recompose directly') },
    })
    const a = agent()
    const outcome = await switchPreset(seam, a, 'code')
    expect(outcome.kind).toBe('done')
    expect(seen).toEqual([{ id: 'switch-1', agentPreset: 'code' }])
    // Harness owns the record; dshline writes no `agent-preset/selected`.
    expect(a.session.snapshotEvents()).toEqual([])
  })

  it('reports the preset id Harness committed, not the one requested', async () => {
    const seam = seamFor('/unused', { select: async () => 'code-resolved' })
    const outcome = await switchPreset(seam, agent(), 'code')
    expect(outcome.kind).toBe('done')
    expect(outcome.message).toContain('code-resolved')
  })

  it("surfaces Harness's refusal of a started session as the failure it is", async () => {
    const seam = seamFor('/unused', {
      select: async () => { throw new Error('session "s" has already started; its agent preset is fixed') },
    })
    const outcome = await switchPreset(seam, agent(), 'code')
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('already started')
  })

  it('reports failure when the preset itself is unusable', async () => {
    const seam = seamFor('/unused', { select: async () => { throw new Error('unknown preset') } })
    const outcome = await switchPreset(seam, agent(), 'nonexistent')
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('unknown preset')
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

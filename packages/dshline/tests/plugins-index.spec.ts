/**
 * Orchestration: what a keystroke in `/plugins` actually does end to end.
 *
 * These drive `openPlugins` for real — a fake `ctx.tuiSlots` stack answers
 * whatever overlay is currently on top (the browser itself, then a
 * copy-confirmation or id prompt when one is raised) — against real temp
 * composition files, so a toggle's file write, Harness's own `recompose`/
 * `settings.mutate` calls, and the session's `agent-preset/selected` log are
 * all exercised together, not just the units that make each decision.
 *
 * Waits are condition-polled (`waitUntil`), never a fixed timeout: the
 * chains under test bottom out in real `node:fs/promises` calls (the actual
 * file lock `toggleRow` takes), whose completion arrives via the event
 * loop's I/O phase on a schedule this suite does not control.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { openPlugins } from '../src/plugins/index.ts'
import type { PluginsAgent } from '../src/plugins/index.ts'
import { parseComposition } from '../src/plugins/composition.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSettings, PresetTrust } from '../src/plugins/harness.ts'

/** A fixed clock; nothing here relies on notice expiry. */
const NOW = 1_800_000_000_000

/** A system preset: a plain row and a `delegation` group with a disabled child. */
const SYSTEM_TEXT = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
      disabled: true
`

/** A user preset with one enabled row. */
const USER_TEXT = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

let dirs: string[] = []

/**
 * A real temp composition file with the given text.
 * @param text - the file's content.
 * @returns the file's absolute path.
 */
async function tempFile(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshline-plugins-index-'))
  dirs.push(dir)
  const path = join(dir, 'agent.cordis.yml')
  await writeFile(path, text, 'utf8')
  return path
}

afterEach(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
  dirs = []
})

/** One preset in the fake roster, backed by a real file. */
interface FakePreset {
  readonly id: string
  readonly trust: PresetTrust
  readonly path: string
  readonly name?: string
  readonly broken?: string
}

/**
 * An `AgentPresetsSeam` over an in-memory roster of real temp files.
 * @param store - the roster; `copy()` adds entries, backed by real new files.
 * @param defaultId - the id `defaultId` reports.
 * @param composed - what `composedPreset` reports.
 * @param overrides - fields to replace on the fake seam.
 * @returns the seam, and what it recorded.
 */
function fakeAgentPresets(
  store: Map<string, FakePreset>,
  defaultId: string,
  composed: string | undefined,
  overrides: Partial<AgentPresetsSeam> = {},
): { seam: AgentPresetsSeam; recomposed: string[] } {
  const recomposed: string[] = []
  const seam: AgentPresetsSeam = {
    get defaultId() { return defaultId },
    authorable: true,
    list: async () => [...store.values()],
    resolve: async id => {
      const preset = store.get(id ?? defaultId)
      if (preset === undefined) throw new Error(`unknown preset ${String(id)}`)
      return { ...preset }
    },
    composedPreset: () => composed,
    recompose: async (_agentCtx, id) => {
      recomposed.push(id)
      const preset = store.get(id)
      if (preset === undefined) throw new Error(`unknown preset ${id}`)
      return { ...preset }
    },
    read: async id => {
      const preset = store.get(id)
      if (preset === undefined) throw new Error(`unknown preset ${id}`)
      return readFile(preset.path, 'utf8')
    },
    copy: async (from, id) => {
      const source = store.get(from)
      if (source === undefined) throw new Error(`unknown preset ${from}`)
      if (store.has(id)) throw new Error(`a preset already exists with id "${id}"`)
      const path = await tempFile(await readFile(source.path, 'utf8'))
      store.set(id, { id, trust: 'user', path })
    },
    ...overrides,
  }
  return { seam, recomposed }
}

/**
 * A settings seam that records every `set` op.
 * @returns the seam, and what it recorded.
 */
function fakeSettings(): { settings: PluginsSettings; sets: { path: readonly string[]; value: unknown }[] } {
  const sets: { path: readonly string[]; value: unknown }[] = []
  return {
    settings: {
      mutate: async (_ns, ops) => {
        for (const op of ops) if (op.op === 'set') sets.push({ path: op.path, value: op.value })
      },
    },
    sets,
  }
}

/**
 * A fake agent: a session with the given header/blank facts, recording every
 * `agent-preset/selected` it is asked to log.
 *
 * `startTurn` mutates the SAME array the session hands out, which is what a
 * real session does as it grows: every eligibility decision reads the log
 * live, so a test can start a turn part-way through an action and see whether
 * the decision that follows noticed.
 * @param headerPreset - what `session.header.agentPreset` reports.
 * @param blank - whether the session should report as blank to begin with.
 * @param onAppend - replaces the default recorder, for a log that refuses.
 * @returns the agent, what it logged, and a way to start a turn mid-flight.
 */
function fakeAgent(
  headerPreset: string | undefined,
  blank: boolean,
  onAppend?: (data: { agentPreset: string }) => void,
): { agent: PluginsAgent; appended: { agentPreset: string }[]; startTurn: () => void } {
  const appended: { agentPreset: string }[] = []
  const events: { type: string; data?: unknown }[] = blank ? [] : [{ type: 'turn/start' }]
  const session = {
    header: { agentPreset: headerPreset },
    events,
    append: (_type: 'agent-preset/selected', data: { agentPreset: string }): void => {
      if (onAppend !== undefined) {
        onAppend(data)
        return
      }
      appended.push(data)
    },
  }
  return {
    agent: { ctx: {}, session: session as unknown as PluginsAgent['session'] },
    appended,
    startTurn: () => { events.push({ type: 'turn/start' }) },
  }
}

/** A context whose slot registry hands each pushed overlay to the test, plus `ctx.get`. */
interface Harness {
  readonly ctx: Context
  readonly answer: (...keys: Key[]) => void
  readonly depth: () => number
  readonly renderTop: () => string | undefined
}

/**
 * A context offering `tuiSlots` and `get('agentPresets' | 'settings')`.
 * @param agentPresets - the preset seam, or undefined to simulate an absent one.
 * @param settings - the settings seam, or undefined.
 * @returns the context and its controls.
 */
function harness(agentPresets: AgentPresetsSeam | undefined, settings: PluginsSettings | undefined): Harness {
  const stack: TuiOverlay[] = []
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay): (() => void) => {
        stack.push(overlay)
        return (): void => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
      invalidate: (): void => {},
    },
    get: (name: string): unknown => (name === 'agentPresets' ? agentPresets : name === 'settings' ? settings : undefined),
  } as unknown as Context
  return {
    ctx,
    answer: (...keys) => { const top = stack.at(-1); for (const k of keys) top?.handleKey(k) },
    depth: () => stack.length,
    renderTop: () => stack.at(-1)?.render(90, 24).join('\n'),
  }
}

function key(name: Extract<Key, { kind: 'key' }>['name']): Key {
  return { kind: 'key', name }
}

function press(t: string): Key {
  return { kind: 'text', text: t }
}

/**
 * Poll a condition until it holds, rather than guessing a fixed delay.
 * @param predicate - checked every few milliseconds.
 * @param label - named in the timeout error, for a failure that is legible.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}

/**
 * Wait for the initial catalog read to land: the query row's placeholder
 * text only appears once a `'ready'` state has actually been rendered.
 * @param h - the harness whose top overlay is the Plugins browser.
 */
async function waitReady(h: Harness): Promise<void> {
  // "Preset:" only appears once `PluginsState` is actually `'ready'` — unlike
  // the query hint, which the loading frame shows too, this cannot pass
  // while the first catalog read is still in flight.
  await waitUntil(() => h.renderTop()?.includes('Preset:') === true, 'initial ready render')
}

describe('user preset toggle: current session', () => {
  it('a blank session on the toggled preset is recomposed live, with no new selection event', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { seam, recomposed } = fakeAgentPresets(store, 'mine', 'mine')
    const { settings } = fakeSettings()
    const { agent, appended } = fakeAgent('mine', true)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' ')) // toggle the only row, tool-fs
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    const written = await readFile(path, 'utf8')
    const tree = parseComposition(written)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
    expect(recomposed).toEqual(['mine'])
    expect(appended).toEqual([])
    expect(committed.join('\n')).toContain('current session updated live')
  })

  it('a started session on the toggled preset is never recomposed; the file still changes', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { seam, recomposed } = fakeAgentPresets(store, 'mine', 'mine')
    const { settings } = fakeSettings()
    const { agent, appended } = fakeAgent('mine', false)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    const written = await readFile(path, 'utf8')
    const tree = parseComposition(written)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
    expect(recomposed).toEqual([])
    expect(appended).toEqual([])
    expect(committed.join('\n')).toContain('saved for future sessions')
    expect(committed.join('\n')).toContain('already started')
  })

  it('reports honestly when the file write succeeds but the live recompose then fails', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { seam } = fakeAgentPresets(store, 'mine', 'mine', {
      recompose: async () => { throw new Error('standing mount is wedged') },
    })
    const { settings } = fakeSettings()
    const { agent, appended } = fakeAgent('mine', true)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    // The write already landed — a failed recompose does not undo it.
    const written = await readFile(path, 'utf8')
    const tree = parseComposition(written)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
    expect(appended).toEqual([])
    const transcript = committed.join('\n')
    expect(transcript).toContain('✗')
    expect(transcript).toContain('could not pick it up')
    expect(transcript).toContain('standing mount is wedged')
  })
})

describe('system preset copy → toggle', () => {
  it('copying and toggling the CURRENT blank session\'s preset switches it durably', async () => {
    const path = await tempFile(SYSTEM_TEXT)
    const store = new Map<string, FakePreset>([['standard', { id: 'standard', trust: 'system', path }]])
    const { seam, recomposed } = fakeAgentPresets(store, 'standard', 'standard')
    const { settings } = fakeSettings()
    const { agent, appended } = fakeAgent('standard', true)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    // Rows in document order: tool-fs, delegation, tool-subagent-codex.
    h.answer(key('down'), key('down'))
    h.answer(press(' ')) // requires-copy: pushes the confirm prompt
    await waitUntil(() => h.depth() === 2, 'copy-confirm prompt open')
    h.answer(key('enter')) // "Create copy" is offered first
    await waitUntil(() => h.depth() === 2, 'new-id prompt open')
    h.answer(key('enter')) // accept the suggested id (standard-custom) with an empty field
    await waitUntil(() => committed.length > 0, 'copy+toggle+switch outcome committed')
    h.answer(key('escape'))
    await done

    expect(store.has('standard-custom')).toBe(true)
    const written = await readFile(store.get('standard-custom')!.path, 'utf8')
    const tree = parseComposition(written)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-subagent-codex')?.disabled).toEqual({ kind: 'enabled' })
    // The shipped file itself was never touched.
    expect(await readFile(path, 'utf8')).toBe(SYSTEM_TEXT)
    expect(recomposed).toEqual(['standard-custom'])
    expect(appended).toEqual([{ agentPreset: 'standard-custom' }])
    expect(committed.join('\n')).toContain('switched the current session to standard-custom')
  })

  it('copying and toggling a preset the session cannot be confirmed to be running never switches or recomposes', async () => {
    const path = await tempFile(SYSTEM_TEXT)
    const store = new Map<string, FakePreset>([['standard', { id: 'standard', trust: 'system', path }]])
    // Nothing composed yet and no header preset: dshline cannot positively
    // confirm the session is running `standard`, even though it is browsing
    // it as the default — so a copy here must not touch the session.
    const { seam, recomposed } = fakeAgentPresets(store, 'standard', undefined)
    const { settings } = fakeSettings()
    const { agent, appended } = fakeAgent(undefined, true)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(key('down'), key('down'))
    h.answer(press(' '))
    await waitUntil(() => h.depth() === 2, 'copy-confirm prompt open')
    h.answer(key('enter'))
    await waitUntil(() => h.depth() === 2, 'new-id prompt open')
    h.answer(key('enter'))
    await waitUntil(() => committed.length > 0, 'copy+toggle outcome committed')
    h.answer(key('escape'))
    await done

    expect(store.has('standard-custom')).toBe(true)
    expect(recomposed).toEqual([])
    expect(appended).toEqual([])
    expect(committed.join('\n')).toContain('future-session customization')
  })
})

describe('d: making the browsed preset the default', () => {
  it('refuses a preset the roster reports broken, without mutating settings', async () => {
    const path = await tempFile(SYSTEM_TEXT)
    const store = new Map<string, FakePreset>([
      ['standard', { id: 'standard', trust: 'system', path, broken: 'a service row escaped its isolate realm' }],
    ])
    const { seam } = fakeAgentPresets(store, 'code', 'standard')
    const { settings, sets } = fakeSettings()
    const { agent } = fakeAgent('standard', true)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('d'))
    // A refusal that never attempted a write is an ephemeral notice, not a
    // committed transcript row — the same posture Connect's own refusals
    // take (`noActionsReason`): nothing was done, so nothing durable is said.
    await waitUntil(() => h.renderTop()?.includes('cannot be made the default') === true, 'make-default refusal notice')
    expect(h.renderTop()).toContain('isolate realm')
    h.answer(key('escape'))
    await done

    expect(sets).toEqual([])
    expect(committed).toEqual([])
  })

  it('refuses a preset that has disappeared from the roster entirely', async () => {
    const store = new Map<string, FakePreset>()
    // `composedPreset` names an id the roster no longer lists at all.
    const { seam } = fakeAgentPresets(store, 'standard', 'ghost', {
      read: async () => { throw new Error('ENOENT') },
    })
    const { settings, sets } = fakeSettings()
    const { agent } = fakeAgent('ghost', true)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('d'))
    await waitUntil(() => h.renderTop()?.includes('no longer on the roster') === true, 'make-default refusal notice')
    h.answer(key('escape'))
    await done

    expect(sets).toEqual([])
    expect(committed).toEqual([])
  })
})

describe('the started-session lock is re-checked at the moment it is acted on', () => {
  it('does not recompose a session that started a turn while the file was being written', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { agent, appended, startTurn } = fakeAgent('mine', true)
    // `resolve` is called by `performToggle` before the write and again by
    // `toggleRow` after it. Starting the turn on the first call puts the turn
    // exactly where a real one can land: after the reading the toggle was
    // decided against, before the live-effect decision. A decision made from
    // that stale reading recomposes a session that has already produced a
    // turn — the one boundary this whole feature exists to respect.
    let resolves = 0
    const { seam, recomposed } = fakeAgentPresets(store, 'mine', 'mine', {
      resolve: async id => {
        resolves += 1
        if (resolves === 1) startTurn()
        const preset = store.get(id ?? 'mine')
        if (preset === undefined) throw new Error(`unknown preset ${String(id)}`)
        return { ...preset }
      },
    })
    const { settings } = fakeSettings()
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    // The write still happened — the file is the durable customization, and
    // withholding it would lose work over a race the reader never saw.
    const tree = parseComposition(await readFile(path, 'utf8'))
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows.find(r => r.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
    expect(recomposed).toEqual([])
    expect(appended).toEqual([])
    expect(committed.join('\n')).toContain('saved for future sessions')
  })

  it('refuses the copy path switch when the turn starts while the prompts are open', async () => {
    const path = await tempFile(SYSTEM_TEXT)
    const store = new Map<string, FakePreset>([['standard', { id: 'standard', trust: 'system', path, name: 'Standard' }]])
    const { seam, recomposed } = fakeAgentPresets(store, 'standard', 'standard')
    const { settings } = fakeSettings()
    const { agent, appended, startTurn } = fakeAgent('standard', true)
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => h.depth() === 2, 'copy confirmation raised')
    // A turn begins while the human is still answering the copy prompt.
    startTurn()
    h.answer(key('enter'))
    await waitUntil(() => h.depth() === 2 && h.renderTop()?.includes('New preset id') === true, 'id prompt raised')
    h.answer(key('enter'))
    await waitUntil(() => committed.length > 0, 'copy outcome committed')
    h.answer(key('escape'))
    await done

    expect([...store.keys()]).toContain('standard-custom')
    expect(recomposed).toEqual([])
    expect(appended).toEqual([])
    expect(committed.join('\n')).toContain('future-session customization')
  })
})

describe('an action that throws instead of answering', () => {
  it('reports a refusing session log rather than leaving the rejection unhandled', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([
      ['mine', { id: 'mine', trust: 'user', path }],
      ['other', { id: 'other', trust: 'user', path: await tempFile(USER_TEXT) }],
    ])
    const { seam } = fakeAgentPresets(store, 'mine', 'mine')
    const { settings } = fakeSettings()
    // A real `Session.append` throws on a candidate it refuses. Nothing in
    // `actions.ts` turns that into an outcome, so without a catch around the
    // action it becomes an unhandled rejection — which ends the process on
    // Node's default setting, over one keystroke in an overlay.
    const { agent } = fakeAgent('mine', true, () => { throw new Error('log refused the event') })
    const h = harness(seam, settings)
    const committed: string[] = []
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => { rejections.push(error) }
    process.on('unhandledRejection', onRejection)
    try {
      const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
      await waitReady(h)
      h.answer(press('p'))
      await waitUntil(() => h.depth() === 2, 'preset picker raised')
      h.answer(key('down'), key('enter'))
      await waitUntil(() => committed.length > 0, 'failure committed')
      h.answer(key('escape'))
      await done
      // Let any stray rejection reach the process hook before asserting none did.
      await new Promise(resolve => { setTimeout(resolve, 20) })
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
    expect(committed.join('\n')).toContain('could not be completed')
    expect(committed.join('\n')).toContain('log refused the event')
  })
})

describe('a write that lands after the reader has closed the browser', () => {
  // Deliberately unlike Connect, which drops a late result outright: a
  // withdrawn sign-in is work that did not happen, while this write changed a
  // file on disk, and the committed row is the only durable evidence of it
  // this session leaves. `land` skips the transient notice and the re-read in
  // this case — neither is observable from here, since a disposed catalog
  // already ignores a refresh, but both are addressed to a reader who left.
  it('still commits the transcript row naming what landed', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([
      ['mine', { id: 'mine', trust: 'user', path }],
      ['other', { id: 'other', trust: 'user', path: await tempFile(USER_TEXT), name: 'Other' }],
    ])
    // The default is `other` while the session runs `mine`, so `d` on the
    // browsed preset is a real write rather than the "already the default"
    // early return.
    const { seam } = fakeAgentPresets(store, 'other', 'mine')
    const { agent } = fakeAgent('mine', false)
    // A settings write held open until the test releases it, so `esc` is
    // guaranteed to arrive first rather than racing the write.
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const sets: { path: readonly string[]; value: unknown }[] = []
    const settings: PluginsSettings = {
      mutate: async (_ns, ops) => {
        await held
        for (const op of ops) if (op.op === 'set') sets.push({ path: op.path, value: op.value })
      },
    }
    const h = harness(seam, settings)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('d'))
    // The started session makes `d` the plain make-default path, whose only
    // await is the held `mutate`.
    await waitUntil(() => h.depth() === 1, 'still only the browser on the stack')
    h.answer(key('escape'))
    await done
    expect(h.depth()).toBe(0)
    release()
    await waitUntil(() => committed.length > 0, 'late outcome committed')

    // The file-level change happened, so the transcript says so: it is the
    // only durable evidence this session leaves of it.
    expect(sets).toEqual([{ path: ['default'], value: 'mine' }])
    expect(committed.join('\n')).toContain('is now the default for new sessions')
  })
})

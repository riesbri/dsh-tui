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
import { Session, SessionId } from '@deepseek-ai/dsh-session'
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
  started: () => boolean = () => false,
): { seam: AgentPresetsSeam; recomposed: string[]; selected: string[] } {
  const recomposed: string[] = []
  const selected: string[] = []
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
    // Harness's owned operation, mirrored in the order the real one performs
    // it: re-check the started lock INSIDE the switch, recompose, and only
    // then record. dshline contributes none of those three steps.
    select: async (agent, id) => {
      if (started()) {
        throw new Error(`session "${String(agent.id)}" has already started; its agent preset is fixed`)
      }
      recomposed.push(id)
      const preset = store.get(id)
      if (preset === undefined) throw new Error(`unknown preset ${id}`)
      selected.push(preset.id)
      return preset.id
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
  return { seam, recomposed, selected }
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

/** What one fake agent's projections answer, and how a test moves them. */
interface FakeAgent {
  /** The agent `/plugins` is opened over; a real detached Session underneath. */
  readonly agent: PluginsAgent
  /** The `ctx.sessionProjections` seam answering for that exact session. */
  readonly projections: FakeProjections
  /** Whether the `turnBoundary` projection currently reports a turn. */
  readonly started: () => boolean
  /** Start a turn mid-action, the way a real one lands across an await. */
  readonly startTurn: () => void
}

/** The two projection reads `/plugins` makes, answered for one exact session. */
interface FakeProjections {
  stateOf(session: Session, key: 'agentPreset' | 'turnBoundary'): unknown
}

/**
 * A fake agent whose Harness projections answer for one real detached Session.
 *
 * The facts are read live, not captured, which is what lets a test start a
 * turn part-way through an action and see whether the decision that follows
 * noticed. Nothing here fakes `Session.append`: under alpha.4 dshline never
 * writes `agent-preset/selected` — `AgentPresets.select` does — so the fake
 * roster records the switch instead (see `fakeAgentPresets`).
 * @param presetId - what the `agentPreset` projection reports.
 * @param blank - whether the `turnBoundary` projection starts with no turn.
 * @returns the agent, its projections, and a way to start a turn mid-flight.
 */
function fakeAgent(presetId: string | undefined, blank: boolean): FakeAgent {
  const id = SessionId('plugins-index-spec')
  const session = Session.create(id)
  let started = !blank
  const projections: FakeProjections = {
    stateOf: (target, key) => {
      // Session ids are durable names, not identity: only THIS session's facts.
      if (target !== session) return undefined
      if (key === 'agentPreset') return presetId ?? null
      return {
        openTurnStartSeq: null,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: started ? 1 : 0,
      }
    },
  }
  return {
    agent: { id, ctx: {}, session },
    projections,
    started: () => started,
    startTurn: () => { started = true },
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
 * A context offering `tuiSlots` and the three seams `/plugins` reads off a
 * context: `agentPresets`, `settings`, and `sessionProjections`.
 * @param agentPresets - the preset seam, or undefined to simulate an absent one.
 * @param settings - the settings seam, or undefined.
 * @param projections - the projection registry answering the session's facts.
 * @returns the context and its controls.
 */
function harness(
  agentPresets: AgentPresetsSeam | undefined,
  settings: PluginsSettings | undefined,
  projections?: FakeProjections,
): Harness {
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
    get: (name: string): unknown => {
      if (name === 'agentPresets') return agentPresets
      if (name === 'settings') return settings
      if (name === 'sessionProjections') return projections
      return undefined
    },
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
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('current session updated live')
  })

  it('a started session on the toggled preset is never recomposed; the file still changes', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { agent, projections, started } = fakeAgent('mine', false)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('saved for future sessions')
    expect(committed.join('\n')).toContain('already started')
  })

  it('reports honestly when the file write succeeds but the live recompose then fails', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam, selected } = fakeAgentPresets(store, 'mine', 'mine', {
      recompose: async () => { throw new Error('standing mount is wedged') },
    }, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    expect(selected).toEqual([])
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
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', 'standard', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    // Both facts come from the one Harness operation: `select` recomposed and
    // recorded, and dshline appended nothing of its own.
    expect(recomposed).toEqual(['standard-custom'])
    expect(selected).toEqual(['standard-custom'])
    expect(agent.session.snapshotEvents()).toEqual([])
    expect(committed.join('\n')).toContain('switched the current session to standard-custom')
  })

  it('copying and toggling a preset the session cannot be confirmed to be running never switches or recomposes', async () => {
    const path = await tempFile(SYSTEM_TEXT)
    const store = new Map<string, FakePreset>([['standard', { id: 'standard', trust: 'system', path }]])
    // Nothing composed yet and no header preset: dshline cannot positively
    // confirm the session is running `standard`, even though it is browsing
    // it as the default — so a copy here must not touch the session.
    const { agent, projections, started } = fakeAgent(undefined, true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', undefined, {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('future-session customization')
  })
})

describe('p: switching the session onto another preset', () => {
  it('tells its caller the composition changed, so scope-aware views re-read', async () => {
    const standard = await tempFile(SYSTEM_TEXT)
    const minimal = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([
      ['standard', { id: 'standard', trust: 'system', path: standard }],
      ['minimal', { id: 'minimal', trust: 'system', path: minimal }],
    ])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', 'standard', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
    const committed: string[] = []
    // A re-parented scope changes which layers a scope-aware Harness registry
    // merges for this agent, and emits no registry mutation saying so — which
    // is exactly why this hook exists rather than a `skills/change` listener
    // being enough.
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press('p'))
    await waitUntil(() => h.depth() === 2, 'preset picker open')
    // The roster is offered in list order; `minimal` is the second row.
    h.answer(key('down'), key('enter'))
    await waitUntil(() => committed.length > 0, 'switch outcome committed')
    h.answer(key('escape'))
    await done

    expect(recomposed).toEqual(['minimal'])
    expect(selected).toEqual(['minimal'])
    expect(agent.session.snapshotEvents()).toEqual([])
    expect(composedAgain).toBe(1)
  })

  it('says nothing changed when the switch itself failed', async () => {
    const standard = await tempFile(SYSTEM_TEXT)
    const minimal = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([
      ['standard', { id: 'standard', trust: 'system', path: standard }],
      ['minimal', { id: 'minimal', trust: 'system', path: minimal }],
    ])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam } = fakeAgentPresets(store, 'standard', 'standard', {
      select: async () => { throw new Error('standing mount is wedged') },
    }, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
    const committed: string[] = []
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press('p'))
    await waitUntil(() => h.depth() === 2, 'preset picker open')
    h.answer(key('down'), key('enter'))
    await waitUntil(() => committed.length > 0, 'switch outcome committed')
    h.answer(key('escape'))
    await done

    // Nothing was re-parented, so nothing must be told it was.
    expect(composedAgain).toBe(0)
  })
})

describe('a live toggle that recomposes the current session', () => {
  it('tells its caller the composition changed', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam, recomposed } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
    const committed: string[] = []
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    expect(recomposed).toEqual(['mine'])
    expect(composedAgain).toBe(1)
  })

  it('says nothing when a started session was left on its existing composition', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([['mine', { id: 'mine', trust: 'user', path }]])
    const { agent, projections, started } = fakeAgent('mine', false)
    const { seam, recomposed } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
    const committed: string[] = []
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    expect(recomposed).toEqual([])
    expect(composedAgain).toBe(0)
  })
})

describe('d: making the browsed preset the default', () => {
  it('refuses a preset the roster reports broken, without mutating settings', async () => {
    const path = await tempFile(SYSTEM_TEXT)
    const store = new Map<string, FakePreset>([
      ['standard', { id: 'standard', trust: 'system', path, broken: 'a service row escaped its isolate realm' }],
    ])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam } = fakeAgentPresets(store, 'code', 'standard', {}, started)
    const { settings, sets } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    const { agent, projections, started } = fakeAgent('ghost', true)
    const { seam } = fakeAgentPresets(store, 'standard', 'ghost', {
      read: async () => { throw new Error('ENOENT') },
    }, started)
    const { settings, sets } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    const { agent, projections, started, startTurn } = fakeAgent('mine', true)
    // `resolve` is called by `performToggle` before the write and again by
    // `toggleRow` after it. Starting the turn on the first call puts the turn
    // exactly where a real one can land: after the reading the toggle was
    // decided against, before the live-effect decision. A decision made from
    // that stale reading recomposes a session that has already produced a
    // turn — the one boundary this whole feature exists to respect.
    let resolves = 0
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'mine', 'mine', {
      resolve: async id => {
        resolves += 1
        if (resolves === 1) startTurn()
        const preset = store.get(id ?? 'mine')
        if (preset === undefined) throw new Error(`unknown preset ${String(id)}`)
        return { ...preset }
      },
    }, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
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
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('saved for future sessions')
  })

  it('refuses the copy path switch when the turn starts while the prompts are open', async () => {
    const path = await tempFile(SYSTEM_TEXT)
    const store = new Map<string, FakePreset>([['standard', { id: 'standard', trust: 'system', path, name: 'Standard' }]])
    const { agent, projections, started, startTurn } = fakeAgent('standard', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', 'standard', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => h.depth() === 2, 'copy confirmation raised')
    // A turn begins while the human is still answering the copy prompt.
    startTurn()
    h.answer(key('enter'))
    await waitUntil(() => h.depth() === 2 && h.renderTop()?.includes('New preset') === true, 'id prompt raised')
    h.answer(key('enter'))
    await waitUntil(() => committed.length > 0, 'copy outcome committed')
    h.answer(key('escape'))
    await done

    expect([...store.keys()]).toContain('standard-custom')
    expect(recomposed).toEqual([])
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('future-session customization')
  })
})

describe('an action that throws instead of answering', () => {
  it('reports a throwing recomposed hook rather than leaving the rejection unhandled', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([
      ['mine', { id: 'mine', trust: 'user', path }],
      ['other', { id: 'other', trust: 'user', path: await tempFile(USER_TEXT) }],
    ])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
    const committed: string[] = []
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => { rejections.push(error) }
    process.on('unhandledRejection', onRejection)
    try {
      // `recomposed` is the caller's own hook, invoked after a committed
      // switch. Nothing turns its throw into an outcome, so without a catch
      // around the action it becomes an unhandled rejection — which ends the
      // process on Node's default setting, over one keystroke in an overlay.
      const done = openPlugins({
        ctx: h.ctx,
        agent,
        commit: lines => { committed.push(...lines) },
        now: () => NOW,
        recomposed: () => { throw new Error('the skill catalog refused to re-read') },
      })
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
    expect(committed.join('\n')).toContain('refused to re-read')
  })

  it('does not reject again when reporting the failure is itself what fails', async () => {
    const path = await tempFile(USER_TEXT)
    const store = new Map<string, FakePreset>([
      ['mine', { id: 'mine', trust: 'user', path }],
      ['other', { id: 'other', trust: 'user', path: await tempFile(USER_TEXT) }],
    ])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections)
    // Drawing is this domain's only channel. If the recovery path's own write
    // throws, letting it out would reject the promise the catch exists to
    // settle — reintroducing the crash by way of the recovery from it.
    let attempts = 0
    const commit = (): void => {
      attempts += 1
      throw new Error('the terminal is gone')
    }
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => { rejections.push(error) }
    process.on('unhandledRejection', onRejection)
    try {
      const done = openPlugins({
        ctx: h.ctx,
        agent,
        commit,
        now: () => NOW,
        recomposed: () => { throw new Error('the skill catalog refused to re-read') },
      })
      await waitReady(h)
      h.answer(press('p'))
      await waitUntil(() => h.depth() === 2, 'preset picker raised')
      h.answer(key('down'), key('enter'))
      await waitUntil(() => attempts > 0, 'the recovery write was attempted')
      h.answer(key('escape'))
      await done
      await new Promise(resolve => { setTimeout(resolve, 20) })
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
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
    const { agent, projections, started } = fakeAgent('mine', false)
    const { seam } = fakeAgentPresets(store, 'other', 'mine', {}, started)
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
    const h = harness(seam, settings, projections)
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

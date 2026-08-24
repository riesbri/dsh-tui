/**
 * Orchestration: what a keystroke in `/profiles` actually invokes.
 *
 * These drive `openProfiles` for real — a fake `ctx.tuiSlots` stack answers
 * whatever overlay is on top, so the removal confirmation is a real prompt —
 * against a stubbed `dsh plugin` runner. The subjects are the guarantees that
 * span a whole action rather than living in one module: the confirmation before
 * a destructive removal, the per-profile lock that outlives the overlay, and
 * the fact that "update all" never becomes a bare `pnpm update`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import type { BundleRow, ProfileRow, ProfilesReading } from '../src/profiles/harness.ts'
import type { ProfileActionOutcome, ProfileOperationSpec } from '../src/profiles/actions.ts'
import { openProfiles } from '../src/profiles/index.ts'

/** A fixed clock; nothing here relies on notice expiry. */
const NOW = 1_800_000_000_000

/** One bundle row, with sensible defaults. */
function bundle(packageName: string, overrides: Partial<BundleRow> = {}): BundleRow {
  return { packageName, version: '1.0.0', managed: true, declaresBundle: true, ...overrides }
}

/** One profile row, with sensible defaults. */
function profile(name: string, overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    name,
    dir: `/home/.dsh/profiles/${name}`,
    current: false,
    bundles: [],
    broken: undefined,
    ...overrides,
  }
}

/** A reading of the roster. */
function reading(profiles: readonly ProfileRow[], currentName?: string): ProfilesReading {
  return { root: '/home/.dsh/profiles', profiles, currentName }
}

/** A context whose slot registry hands each pushed overlay to the test. */
interface Harness {
  readonly ctx: Context
  readonly answer: (...keys: Key[]) => void
  readonly depth: () => number
  readonly renderTop: () => string | undefined
}

/**
 * A context offering `tuiSlots` and the `dshHomePath` service.
 * @returns the context and its controls.
 */
function harness(): Harness {
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
    get: (name: string): unknown => (name === 'dshHomePath'
      ? (...segments: string[]) => ['/home/.dsh', ...segments].join('/')
      : undefined),
    baseUrl: undefined,
  } as unknown as Context
  return {
    ctx,
    answer: (...keys) => { const top = stack.at(-1); for (const k of keys) top?.handleKey(k) },
    depth: () => stack.length,
    renderTop: () => stack.at(-1)?.render(90, 28).join('\n'),
  }
}

function key(name: Extract<Key, { kind: 'key' }>['name']): Key {
  return { kind: 'key', name }
}

function text(value: string): Key {
  return { kind: 'text', text: value }
}

/**
 * Poll a condition until it holds, rather than guessing a fixed delay.
 * @param predicate - checked every few milliseconds.
 * @param label - named in the timeout error.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}

/** Wait for the first roster read to land. */
async function waitReady(h: Harness): Promise<void> {
  await waitUntil(() => h.renderTop()?.includes('Host:') === true, 'initial ready render')
}

/** A `dsh plugin` runner that records every invocation and always succeeds. */
function recorder(): { run: (spec: ProfileOperationSpec) => Promise<ProfileActionOutcome>; calls: ProfileOperationSpec[] } {
  const calls: ProfileOperationSpec[] = []
  return {
    calls,
    run: async spec => {
      calls.push(spec)
      return { kind: 'done', message: `${spec.profile}: ${spec.resolved.running} — done`, output: [] }
    },
  }
}

describe('removing a bundle is confirmed first', () => {
  it('asks, and does nothing when the answer is cancel', async () => {
    const roster = reading([profile('dshline', { current: true, bundles: [bundle('@example/plugin')] })], 'dshline')
    const h = harness()
    const { run, calls } = recorder()
    const committed: string[] = []
    const done = openProfiles({
      ctx: h.ctx,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      run,
      read: async () => roster,
    })
    await waitReady(h)
    h.answer(key('down'))
    h.renderTop()
    h.answer(text('r'))
    await waitUntil(() => h.depth() === 2, 'removal confirmation raised')
    expect(h.renderTop()).toContain('@example/plugin')
    // Cancel is first, so a stray enter does not remove anything.
    h.answer(key('enter'))
    await waitUntil(() => h.depth() === 1, 'prompt dismissed')
    h.answer(key('escape'))
    await done
    expect(calls).toEqual([])
    expect(committed).toEqual([])
  })

  it('removes once the answer is the removal itself', async () => {
    const roster = reading([profile('dshline', { current: true, bundles: [bundle('@example/plugin')] })], 'dshline')
    const h = harness()
    const { run, calls } = recorder()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(key('down'))
    h.renderTop()
    h.answer(text('r'))
    await waitUntil(() => h.depth() === 2, 'removal confirmation raised')
    h.answer(key('down'), key('enter'))
    await waitUntil(() => calls.length > 0, 'removal forwarded')
    h.answer(key('escape'))
    await done
    expect(calls[0]?.resolved.args).toEqual(['remove', '@example/plugin'])
  })

  it('does not confirm an update, which takes nothing away', async () => {
    const roster = reading([profile('dshline', { current: true, bundles: [bundle('@example/plugin')] })], 'dshline')
    const h = harness()
    const { run, calls } = recorder()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(key('down'))
    h.renderTop()
    h.answer(text('u'))
    await waitUntil(() => calls.length > 0, 'update forwarded without a prompt')
    h.answer(key('escape'))
    await done
    expect(calls[0]?.resolved.args).toEqual(['update', '@example/plugin'])
  })
})

describe('"update all" never widens into every dependency', () => {
  it('names the dependency-managed bundles explicitly', async () => {
    // A bare `pnpm update` would also update plain libraries this browser does
    // not show, which is a wider mutation than the reader asked for.
    const roster = reading([profile('dshline', {
      current: true,
      bundles: [
        bundle('@deepseek-ai/dsh-base', { managed: false }),
        bundle('@example/one'),
        bundle('@example/two'),
      ],
    })], 'dshline')
    const h = harness()
    const { run, calls } = recorder()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => calls.length > 0, 'update-all forwarded')
    h.answer(key('escape'))
    await done
    expect(calls[0]?.resolved.args).toEqual(['update', '@example/one', '@example/two'])
    expect(calls[0]?.resolved.args).not.toEqual(['update'])
  })

  it('refuses rather than running a bare update when nothing is managed', async () => {
    const roster = reading([profile('web', {
      current: true,
      bundles: [bundle('@deepseek-ai/dsh-base', { managed: false })],
    })], 'web')
    const h = harness()
    const { run, calls } = recorder()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await vi.waitFor(() => { expect(h.renderTop()).toContain('no dependency-managed bundles') })
    h.answer(key('escape'))
    await done
    expect(calls).toEqual([])
  })
})

describe('one operation per profile, across overlay lifetimes', () => {
  it('refuses a second overlay operation while the first is still running', async () => {
    // The race the per-overlay `busy` flag allowed: start an install, close the
    // browser, reopen, start another, and two pnpm runs share one lockfile.
    const roster = reading([profile('dshline', { current: true, bundles: [bundle('@example/plugin')] })], 'dshline')
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    let started = 0
    const slowRun = async (spec: ProfileOperationSpec): Promise<ProfileActionOutcome> => {
      started += 1
      await held
      return { kind: 'done', message: `${spec.profile}: done`, output: [] }
    }

    const first = harness()
    const firstDone = openProfiles({
      ctx: first.ctx, commit: () => {}, now: () => NOW, run: slowRun, read: async () => roster,
    })
    await waitReady(first)
    first.answer(text('U'))
    await waitUntil(() => started === 1, 'first operation started')
    // The reader closes the browser while pnpm is still working.
    first.answer(key('escape'))
    await firstDone

    const second = harness()
    const secondDone = openProfiles({
      ctx: second.ctx, commit: () => {}, now: () => NOW, run: slowRun, read: async () => roster,
    })
    await waitReady(second)
    second.answer(text('U'))
    await vi.waitFor(() => { expect(second.renderTop()).toContain('already has an operation running') })
    expect(started).toBe(1)
    second.answer(key('escape'))
    await secondDone
    release()
    // Let the first operation settle so it does not leak into another test.
    await waitUntil(() => true, 'settled')
  })

  it('allows an operation on a different profile at the same time', async () => {
    const roster = reading([
      profile('alpha', { bundles: [bundle('@example/one')] }),
      profile('beta', { bundles: [bundle('@example/two')] }),
    ])
    const h = harness()
    const { run, calls } = recorder()
    // Completion is observed through the committed transcript row, not through
    // `calls`: the stub records on ENTRY, and the prompt gate is only released
    // when the whole action settles.
    const committed: string[] = []
    const done = openProfiles({
      ctx: h.ctx, commit: lines => { committed.push(...lines) }, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => committed.length >= 1, 'alpha update landed')
    // Down past alpha's bundle onto beta, then update it too.
    h.answer(key('down'), key('down'))
    h.renderTop()
    h.answer(text('U'))
    await waitUntil(() => calls.length === 2, 'beta updated')
    h.answer(key('escape'))
    await done
    expect(calls.map(call => call.profile)).toEqual(['alpha', 'beta'])
  })
})

describe('what a landed operation says about the running Host', () => {
  it('reports restart required for the profile this Host booted', async () => {
    const roster = reading([profile('dshline', { current: true, bundles: [bundle('@example/plugin')] })], 'dshline')
    const h = harness()
    const { run } = recorder()
    const committed: string[] = []
    const done = openProfiles({
      ctx: h.ctx, commit: lines => { committed.push(...lines) }, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => committed.length > 0, 'outcome committed')
    h.answer(key('escape'))
    await done
    expect(committed.join('\n')).toContain('restart required')
  })

  it('names the boot command for any other profile instead', async () => {
    const roster = reading([profile('web', { bundles: [bundle('@example/plugin')] })], undefined)
    const h = harness()
    const { run } = recorder()
    const committed: string[] = []
    const done = openProfiles({
      ctx: h.ctx, commit: lines => { committed.push(...lines) }, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => committed.length > 0, 'outcome committed')
    h.answer(key('escape'))
    await done
    const said = committed.join('\n')
    expect(said).toContain('dsh --profile web')
    expect(said).not.toContain('restart required')
  })
})

describe('the browser stays usable while an operation runs', () => {
  /** A roster with two profiles, each with one managed bundle. */
  const roster = reading([
    profile('alpha', { current: true, bundles: [bundle('@example/one')] }),
    profile('beta', { bundles: [bundle('@example/two')] }),
  ], 'alpha')

  it('accepts a key on another profile while the first install is still going', async () => {
    // The manual report this fixes: once an update was queued, `a`, `u`, `r`
    // and `n` all appeared dead. The gate stayed shut for the whole pnpm run
    // AND returned silently, so the browser looked broken for minutes.
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    const slowRun = async (spec: ProfileOperationSpec): Promise<ProfileActionOutcome> => {
      started.push(spec.profile)
      await held
      return { kind: 'done', message: `${spec.profile}: done`, output: [] }
    }
    const h = harness()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run: slowRun, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => started.length === 1, 'alpha install started')
    // Still mid-install. Move to the other profile and act on it.
    h.answer(key('down'), key('down'))
    h.renderTop()
    h.answer(text('U'))
    await waitUntil(() => started.length === 2, 'beta accepted while alpha runs')
    expect(started).toEqual(['alpha', 'beta'])
    release()
    h.answer(key('escape'))
    await done
  })

  it('says so out loud when the same profile is asked twice', async () => {
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    let started = 0
    const slowRun = async (): Promise<ProfileActionOutcome> => {
      started += 1
      await held
      return { kind: 'done', message: 'done', output: [] }
    }
    const h = harness()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run: slowRun, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => started === 1, 'first started')
    h.answer(text('U'))
    await vi.waitFor(() => { expect(h.renderTop()).toContain('already has an operation running') })
    expect(started).toBe(1)
    release()
    h.answer(key('escape'))
    await done
  })

  it('shows the running operation persistently while it runs', async () => {
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    let started = 0
    const slowRun = async (): Promise<ProfileActionOutcome> => {
      started += 1
      await held
      return { kind: 'done', message: 'done', output: [] }
    }
    const h = harness()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run: slowRun, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => started === 1, 'started')
    await vi.waitFor(() => { expect(h.renderTop()).toContain('⟳ alpha') })
    release()
    h.answer(key('escape'))
    await done
  })

  it('says a restart is owed after a change to the profile this Host booted', async () => {
    const h = harness()
    const { run } = recorder()
    const done = openProfiles({
      ctx: h.ctx, commit: () => {}, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await vi.waitFor(() => { expect(h.renderTop()).toContain('↻ restart required to pick up: alpha') })
    h.answer(key('escape'))
    await done
  })

  it('tells the transcript that work continues after the browser is closed', async () => {
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    let started = 0
    const slowRun = async (): Promise<ProfileActionOutcome> => {
      started += 1
      await held
      return { kind: 'done', message: 'done', output: [] }
    }
    const h = harness()
    const committed: string[] = []
    const done = openProfiles({
      ctx: h.ctx, commit: lines => { committed.push(...lines) }, now: () => NOW, run: slowRun, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await waitUntil(() => started === 1, 'started')
    h.answer(key('escape'))
    await done
    expect(committed.join('\n')).toContain('still running')
    expect(committed.join('\n')).toContain('continues in the background')
    release()
  })

  it('tells the transcript that a restart is still owed when the browser closes', async () => {
    const h = harness()
    const { run } = recorder()
    const committed: string[] = []
    const done = openProfiles({
      ctx: h.ctx, commit: lines => { committed.push(...lines) }, now: () => NOW, run, read: async () => roster,
    })
    await waitReady(h)
    h.answer(text('U'))
    await vi.waitFor(() => { expect(h.renderTop()).toContain('↻ restart required') })
    h.answer(key('escape'))
    await done
    expect(committed.join('\n')).toContain('waiting on a restart')
  })
})

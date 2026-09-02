/**
 * The `dshline` settings namespace, against the real settings service.
 *
 * Mounted rather than faked, for the reason the Todo tests are: the behaviour
 * that matters here — layering, schema rejection, the change feed, the
 * fallback when no provider is mounted — all belongs to Harness, and a fake
 * would only prove this file agrees with itself.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { BusyEnter } from '../src/delivery.ts'
import { installDshlineSettings } from '../src/settings.ts'
import type { DshlineSettings, PreferenceSetting } from '../src/settings.ts'

/** The namespace this frontend owns. */
const NS = 'dshline'

/** A settings provider holding its document in memory. */
class MemorySettings extends SettingsProvider {
  /** Raw document, namespace to raw section. */
  static seed: Record<string, unknown> = {}

  /** Sections this provider was asked to persist, in order. */
  static written: { ns: string; section: Record<string, unknown> }[] = []

  /** Writes are accepted unless a spec says otherwise. */
  static allowWrites = true

  readonly writable = true

  /**
   * @returns the seeded raw document.
   */
  protected async load(): Promise<Record<string, unknown>> {
    return structuredClone(MemorySettings.seed)
  }

  /**
   * @param ns - the namespace being written.
   * @param section - the merged user section.
   */
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    if (!MemorySettings.allowWrites) throw new Error('storage is read-only here')
    MemorySettings.written.push({ ns, section })
  }
}

/**
 * Mount a context, optionally with a settings provider, and install the section.
 * @param options - whether to mount a provider, and the document it starts from.
 * @returns the context and the installed section.
 */
async function mount(options: {
  provider?: boolean
  document?: Record<string, unknown>
  entry?: { theme?: string; busyEnter?: BusyEnter }
} = {}): Promise<{
  ctx: Context
  settings: DshlineSettings
  theme: PreferenceSetting<string>
  busyEnter: PreferenceSetting<BusyEnter>
}> {
  MemorySettings.seed = options.document ?? {}
  MemorySettings.written = []
  MemorySettings.allowWrites = true
  const ctx = new Context()
  if (options.provider !== false) await ctx.plugin(MemorySettings)
  const settings = installDshlineSettings(ctx, options.entry ?? {})
  // The registration rides `ctx.inject`, which settles asynchronously.
  await new Promise(resolve => setTimeout(resolve, 0))
  return { ctx, settings, theme: settings.theme, busyEnter: settings.busyEnter }
}

describe('the theme key', () => {
  it('resolves the schema default when nothing is composed or stored', async () => {
    const { theme } = await mount()
    expect(theme.current()).toBe('default')
  })

  it('takes the composition entry as the layer below the user', async () => {
    const { theme } = await mount({ entry: { theme: 'ember' } })
    expect(theme.current()).toBe('ember')
  })

  it('lets a stored user section override the composed default', async () => {
    // The whole point of the layering: a deployment composes `ember`, the
    // reader picks `tide`, and the reader wins.
    const { theme } = await mount({ entry: { theme: 'ember' }, document: { dshline: { theme: 'tide' } } })
    expect(theme.current()).toBe('tide')
  })
})

describe('without a settings provider', () => {
  it('still resolves the composed theme rather than failing', async () => {
    // A profile that mounts no settings provider must still run. The canonical
    // wiring leaves the source pointed at the composition entry.
    const { theme } = await mount({ provider: false, entry: { theme: 'paper' } })
    expect(theme.current()).toBe('paper')
  })

  it('falls back to the shipped default when nothing is composed either', async () => {
    const { theme } = await mount({ provider: false })
    expect(theme.current()).toBe('default')
  })

  it('reports that a choice cannot be stored, instead of throwing', async () => {
    const { theme } = await mount({ provider: false })
    expect(await theme.save('ember')).toContain('mounts no settings provider')
  })
})

describe('storing a choice', () => {
  it('writes the user layer and reports nothing to add', async () => {
    const { theme } = await mount()
    expect(await theme.save('tide')).toBeUndefined()
    expect(MemorySettings.written.map(w => w.ns)).toStrictEqual([NS])
    expect(MemorySettings.written[0]?.section).toStrictEqual({ theme: 'tide' })
    expect(theme.current()).toBe('tide')
  })

  it('leaves keys it does not know about alone', async () => {
    // A path op rather than a section replace, so an older build cannot delete
    // a key a newer one wrote.
    const { theme } = await mount({ document: { dshline: { theme: 'ember', future: 42 } } })
    await theme.save('paper')
    expect(MemorySettings.written[0]?.section).toStrictEqual({ theme: 'paper', future: 42 })
  })

  it('surfaces a storage failure as a phrase rather than a throw', async () => {
    const { theme } = await mount()
    MemorySettings.allowWrites = false
    const note = await theme.save('ember')
    expect(note).toContain('could not save it')
    expect(note).toContain('read-only')
  })

  it('refuses an id no shipped theme has, through the schema', async () => {
    // Validation is Harness's, not a parser here: `update` rejects before
    // anything is persisted.
    const { theme } = await mount()
    const note = await theme.save('dracula')
    expect(note).toContain('could not save it')
    expect(MemorySettings.written).toStrictEqual([])
    expect(theme.current()).toBe('default')
  })
})

describe('live changes', () => {
  it('notifies a watcher when the resolved value commits', async () => {
    const { theme } = await mount()
    const seen: string[] = []
    theme.watch(() => { seen.push(theme.current()) })
    await theme.save('tide')
    expect(seen).toContain('tide')
  })

  it('stops notifying after the watcher is disposed', async () => {
    const { theme } = await mount()
    let count = 0
    const stop = theme.watch(() => { count += 1 })
    await theme.save('tide')
    const afterFirst = count
    stop()
    await theme.save('ember')
    expect(count).toBe(afterFirst)
    expect(theme.current()).toBe('ember')
  })
})

describe('a provider mounting and unmounting later', () => {
  it('observes a provider mounted after installation, then reverts once it unmounts', async () => {
    // No `mount()` here: the point is the provider does NOT exist yet when
    // `installThemeSettings` runs, so its own `ctx.plugin` composition step
    // has to happen strictly after.
    MemorySettings.seed = { dshline: { theme: 'tide' } }
    MemorySettings.written = []
    MemorySettings.allowWrites = true
    const ctx = new Context()

    const { theme } = installDshlineSettings(ctx, { theme: 'ember' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(theme.current()).toBe('ember')

    const provider = await ctx.plugin(MemorySettings)
    await new Promise(resolve => setTimeout(resolve, 0))
    // The provider mounted with a stored user theme: dshline observes it,
    // through the same registration `ctx.inject` deferred until now.
    expect(theme.current()).toBe('tide')

    await provider.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    // The provider is gone: back to the composition entry, through
    // `installSection`'s own teardown effect, not anything this module did.
    expect(theme.current()).toBe('ember')
  })
})

describe('a stored section the schema rejects', () => {
  it('does not strand the frontend on an unusable value', async () => {
    // An externally edited document naming a theme this build does not ship.
    // The schema judges it at registration, which fails; the canonical wiring
    // then leaves the source on the composition entry, so the window keeps
    // running exactly as composed rather than on a palette it cannot draw.
    const { theme } = await mount({ document: { dshline: { theme: 'not-a-theme' } }, entry: { theme: 'ember' } })
    expect(theme.current()).toBe('ember')
  })
})

describe('the busyEnter key', () => {
  it('resolves the schema default when nothing is composed or stored', async () => {
    const { busyEnter } = await mount()
    expect(busyEnter.current()).toBe('queue')
  })

  it('takes the composition entry as the layer below the user', async () => {
    const { busyEnter } = await mount({ entry: { busyEnter: 'steer' } })
    expect(busyEnter.current()).toBe('steer')
  })

  it('lets a stored user section override the composed default', async () => {
    const { busyEnter } = await mount({
      entry: { busyEnter: 'steer' },
      document: { dshline: { busyEnter: 'queue' } },
    })
    expect(busyEnter.current()).toBe('queue')
  })

  it('adopts a stored choice, which is what surviving a reopen rests on', async () => {
    // The window seeds its live pref from this on creation, so a value stored by
    // a previous run is in force on the first submission of the next one.
    const { busyEnter } = await mount({ document: { dshline: { busyEnter: 'steer' } } })
    expect(busyEnter.current()).toBe('steer')
  })

  it('refuses a value neither word names, through the schema', async () => {
    const { busyEnter } = await mount()
    // Cast because the point is a document edited by hand, which the types
    // cannot police: Harness's schema is what rejects it.
    const note = await busyEnter.save('yolo' as BusyEnter)
    expect(note).toContain('could not save it')
    expect(MemorySettings.written).toStrictEqual([])
    expect(busyEnter.current()).toBe('queue')
  })

  it('still works, and says it cannot store, with no provider mounted', async () => {
    const { busyEnter } = await mount({ provider: false, entry: { busyEnter: 'steer' } })
    expect(busyEnter.current()).toBe('steer')
    expect(await busyEnter.save('queue')).toContain('mounts no settings provider')
  })

  it('does not strand the frontend on a stored value the schema rejects', async () => {
    const { busyEnter } = await mount({
      document: { dshline: { busyEnter: 'not-a-word' } },
      entry: { busyEnter: 'steer' },
    })
    expect(busyEnter.current()).toBe('steer')
  })
})

describe('one owner of the namespace', () => {
  it('registers exactly one section, so neither key validates the other away', async () => {
    // The reason there is one installer rather than two. A second
    // `installSection('dshline', …)` would not add a key — it would register a
    // competing section whose schema rejects the key it does not know.
    const { theme, busyEnter } = await mount({
      document: { dshline: { theme: 'tide', busyEnter: 'steer' } },
    })
    expect(theme.current()).toBe('tide')
    expect(busyEnter.current()).toBe('steer')
  })

  it('writes one key without deleting the other', async () => {
    // Each facet writes a path op, so the keys cannot clobber each other even
    // though they share one document and one section.
    const { theme, busyEnter } = await mount({
      document: { dshline: { theme: 'ember', busyEnter: 'steer' } },
    })
    await theme.save('paper')
    expect(MemorySettings.written.at(-1)?.section).toStrictEqual({ theme: 'paper', busyEnter: 'steer' })
    await busyEnter.save('queue')
    expect(MemorySettings.written.at(-1)?.section).toStrictEqual({ theme: 'paper', busyEnter: 'queue' })
    expect(theme.current()).toBe('paper')
    expect(busyEnter.current()).toBe('queue')
  })

  it('lets each facet reach only its own key', async () => {
    // Narrow by construction: the window is handed the theme facet and still
    // has no way to write the input preference through it.
    const { settings } = await mount()
    expect(Object.keys(settings).sort()).toStrictEqual(['busyEnter', 'theme'])
    expect(Object.keys(settings.theme).sort()).toStrictEqual(['current', 'save', 'watch'])
  })

  it('notifies a theme watcher when the other key commits, and the guard absorbs it', async () => {
    // One document, one feed: a listener fires for any key. Consumers guard on
    // the resolved value — the window reinstalls no palette and repaints nothing
    // when the value it watches did not move.
    const { theme, busyEnter } = await mount()
    const seen: string[] = []
    theme.watch(() => { seen.push(theme.current()) })
    await busyEnter.save('steer')
    expect(seen).toStrictEqual(['default'])
  })
})

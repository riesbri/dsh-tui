/**
 * The theme as a Harness settings section, against the real settings service.
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
import { installThemeSettings } from '../src/themes/settings.ts'
import type { ThemeSettings } from '../src/themes/settings.ts'

// The brand is compile-time only; see settings.ts's own THEME_NAMESPACE for why
// asserting it directly is safe for this fixed, already-valid literal.
/** The namespace this frontend owns. */
const NS = 'dshline' as unknown as SettingsNamespace

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
  entry?: { theme: string }
} = {}): Promise<{ ctx: Context; theme: ThemeSettings }> {
  MemorySettings.seed = options.document ?? {}
  MemorySettings.written = []
  MemorySettings.allowWrites = true
  const ctx = new Context()
  if (options.provider !== false) await ctx.plugin(MemorySettings)
  const theme = installThemeSettings(ctx, options.entry ?? {})
  // The registration rides `ctx.inject`, which settles asynchronously.
  await new Promise(resolve => setTimeout(resolve, 0))
  return { ctx, theme }
}

describe('the theme settings section', () => {
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

    const theme = installThemeSettings(ctx, { theme: 'ember' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(theme.current()).toBe('ember')

    const provider = await ctx.plugin(MemorySettings)
    await new Promise(resolve => setTimeout(resolve, 0))
    // The provider mounted with a stored user theme: dshline observes it,
    // through the same registration this bridge deferred until now.
    expect(theme.current()).toBe('tide')

    await provider.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    // The provider is gone: back to the composition entry, through
    // `installSection`'s own teardown effect, not anything this bridge did.
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

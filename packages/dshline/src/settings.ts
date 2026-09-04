/**
 * The one owner of this frontend's Harness settings namespace.
 *
 * Harness owns the document, the layering, the validation, and the change feed.
 * This module owns one namespace — `dshline` — and turns what Harness publishes
 * into what each consumer needs: what a preference is now, when it changed, and
 * a way to store the reader's choice.
 *
 * The canonical wiring for a consumer whose settings service is OPTIONAL, which
 * is exactly this one, is `SettingsProvider#installSection`: while a provider
 * exists it registers the namespace with the plugin's composition entry as the
 * `base` layer and points the source at the resolved scope, and when none is
 * mounted the source falls back to that entry, so a deployment with no settings
 * provider still runs on what it was composed with.
 *
 * Layering is therefore Harness's, not this frontend's: schema default, then the
 * `dshline` row's own config, then the user's `settings.yaml`. There is no second
 * document, no parser, and no state machine.
 *
 * **One installer, because `installSection` takes a whole namespace.** This
 * module began as the theme's own file and holding one key was the reason it
 * could live under `themes/`. A second `installSection('dshline', …)` call would
 * not add a key — it would register a competing section for the same namespace,
 * with two sources, two change fans, and two schemas each validating away the
 * other's key. So the namespace has exactly one installer, and consumers receive
 * narrow per-key facets rather than a settings object they could reach past.
 * That is the whole of the abstraction: no key registry, no dynamic schema, no
 * generic settings framework for two preferences.
 * @module dshline/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { escapeControls } from '@dshline/renderer'
import type { BusyEnter } from './delivery.ts'
import { DEFAULT_BUSY_ENTER } from './delivery.ts'
import { FALLBACK_THEME, THEMES } from './themes/builtin.ts'

/**
 * The namespace this frontend owns. Matches the row id its bundle inserts.
 *
 * A plain literal: the settings service validates a namespace at the type
 * level (lowercase, hyphenated), so `'dshline'` is accepted directly and the
 * brand never has to be asserted.
 */
const NAMESPACE = 'dshline'

/** The key holding the reader's palette. */
const THEME_KEY = 'theme'

/** The key holding what plain `enter` means while a turn is running. */
const BUSY_ENTER_KEY = 'busyEnter'

/** The key controlling whether this frontend emits terminal BEL for live interaction. */
const ATTENTION_BELL_KEY = 'attentionBell'

/** The two values busy `enter` may take, for the schema and for completion. */
const BUSY_ENTER_VALUES: readonly BusyEnter[] = ['queue', 'steer']

/**
 * The section's schema: closed unions, and nothing else.
 *
 * A union of the accepted values rather than a free string, so an unknown value
 * is rejected by the SCHEMA — Harness then keeps the namespace's last good value
 * and warns, which is a better answer than this frontend re-validating a string
 * it was handed. It also makes a configuration UI render the real choices.
 *
 * Deliberately not the plugin's whole {@link Config}. Prices and peak hours are
 * composition-time deployment facts nobody edits from inside a session, and
 * pulling them in would turn two preferences into a settings surface for
 * everything this row can be configured with.
 */
const DshlineSection = Schema.object({
  [THEME_KEY]: Schema.union(THEMES.map(theme => Schema.const(theme.id)))
    .default(FALLBACK_THEME.id)
    .description('Colour palette this frontend draws with.'),
  [BUSY_ENTER_KEY]: Schema.union(BUSY_ENTER_VALUES.map(value => Schema.const(value)))
    .default(DEFAULT_BUSY_ENTER)
    .description('What plain enter does while a turn is running: queue a follow-up turn, or steer the running one.'),
  [ATTENTION_BELL_KEY]: Schema.boolean()
    .default(true)
    .description('Whether this frontend emits terminal BEL when live human interaction is needed.'),
}).description('dshline')

/** The resolved shape of that section. */
export interface DshlineSection {
  /** The theme id currently in force. */
  readonly theme: string
  /** What plain `enter` means while a turn is running. */
  readonly busyEnter: BusyEnter
  /** Whether this frontend emits terminal BEL for live human interaction. */
  readonly attentionBell: boolean
}

/**
 * One preference, as its consumer sees it.
 *
 * Narrow on purpose: a facet can read and store its own key and cannot reach the
 * namespace, the provider, or another key. The window takes the theme facet and
 * still has no way to write the input preference through it.
 */
export interface PreferenceSetting<T> {
  /** The value in force right now, across every layer Harness resolves. */
  readonly current: () => T
  /**
   * Observe a committed change to THIS preference, from any source — including
   * `settings.yaml` edited by hand while the session runs.
   *
   * Scoped to the key, not to the document. The namespace is one section, so
   * Harness reports one change for a write to any of its keys, and republishing
   * that to every facet was a correctness bug rather than a nuisance: both
   * preferences deliberately keep a live choice whose write FAILED, so an
   * unrelated key's successful write would wake this facet, resolve the value
   * still on disk, and silently roll the reader's live choice back. Each facet
   * therefore remembers what it last published and stays quiet unless its own
   * resolved value actually moved.
   * @param listener - called after this preference's resolved value changes.
   * @returns the disposer removing this listener.
   */
  readonly watch: (listener: () => void) => () => void
  /**
   * Store a choice in the user layer.
   *
   * A path op rather than a whole-section write, so a key this frontend does not
   * know about — one a newer version added — is never deleted by an older one,
   * and neither facet can clobber the other's key.
   * @param value - the value to store.
   * @returns a phrase to append to the command's report, or nothing to add.
   */
  readonly save: (value: T) => Promise<string | undefined>
}

/** The facets this namespace publishes. */
export interface DshlineSettings {
  /** The palette this frontend draws with. */
  readonly theme: PreferenceSetting<string>
  /** What plain `enter` means while a turn is running. */
  readonly busyEnter: PreferenceSetting<BusyEnter>
  /** Whether this frontend emits terminal BEL for live human interaction. */
  readonly attentionBell: PreferenceSetting<boolean>
}

/**
 * Register the namespace and expose one facet per key.
 * @param ctx - the plugin context owning the registration.
 * @param entry - this row's composition config, used as the `base` layer.
 * @returns the readers and writers this frontend's consumers use.
 */
export function installDshlineSettings(ctx: Context, entry: Partial<DshlineSection>): DshlineSettings {
  // Until a settings service attaches, the composition entry IS the answer.
  let source: () => DshlineSection = () => ({
    theme: entry.theme ?? FALLBACK_THEME.id,
    busyEnter: entry.busyEnter ?? DEFAULT_BUSY_ENTER,
    attentionBell: entry.attentionBell ?? true,
  })
  /**
   * Republish to one key's watchers, but only when that key's value moved.
   *
   * Each facet contributes one of these and a namespace change runs all of them,
   * which is what turns Harness's one section-level notification into a
   * per-preference feed. Comparison is by value because every key here holds a
   * scalar; a key whose value were ever a structure would need its own
   * comparison rather than a deeper default one nobody had chosen.
   */
  const publishers: (() => void)[] = []
  /**
   * Build one key's facet over the shared source, feed, and writer.
   * @param read - projects the resolved section onto this key.
   * @param key - the path this facet writes.
   * @returns the facet its consumer receives.
   */
  const facet = <T>(read: (section: DshlineSection) => T, key: string): PreferenceSetting<T> => {
    const watchers = new Set<() => void>()
    // What this facet has already told its watchers. Seeded from the layer in
    // force at construction — the composition entry, since no provider has
    // attached yet — so a provider mounting later with a different stored value
    // is itself a change, and still reaches the window.
    let published = read(source())
    publishers.push(() => {
      const next = read(source())
      if (next === published) return
      published = next
      for (const watcher of watchers) watcher()
    })
    return {
      current: () => read(source()),
      watch: listener => {
        watchers.add(listener)
        return () => { watchers.delete(listener) }
      },
      save: async value => {
        const settings = ctx.get('settings')
        // Nothing to write to. Saying so beats a switch the reader believes was
        // stored when it will last exactly as long as the process.
        if (settings === undefined) return 'not saved: this profile mounts no settings provider'
        try {
          await settings.mutate(NAMESPACE, [{ op: 'set', path: [key], value }])
        } catch (error: unknown) {
          // Escaped before it is styled, like any other text this frontend did
          // not compose: a provider message can carry a filesystem path, and a
          // schema rejection quotes the value that failed.
          const reason = error instanceof Error ? error.message : String(error)
          return `could not save it: ${escapeControls(reason)}`
        }
        return undefined
      },
    }
  }
  const settings: DshlineSettings = {
    theme: facet(section => section.theme, THEME_KEY),
    busyEnter: facet(section => section.busyEnter, BUSY_ENTER_KEY),
    attentionBell: facet(section => section.attentionBell, ATTENTION_BELL_KEY),
  }
  // Registered AFTER the facets exist, so a provider that attaches and commits
  // straight away cannot run `onChange` against an empty publisher list.
  //
  // `ctx.inject` rather than a one-shot `ctx.get`, which is what gives this
  // registration every lifecycle guarantee the frontend would otherwise have to
  // reimplement: a provider mounting later still gets registered, a provider
  // disappearing runs `installSection`'s own teardown effect — which is what
  // restores the composition entry — unloading dshline's fiber tears the
  // injected fiber down with it, and a stored section the schema already
  // rejects fails that fiber's startup, which Cordis's plugin loader contains.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection<typeof NAMESPACE, DshlineSection>(
      ctx,
      NAMESPACE,
      DshlineSection,
      source(),
      {
        setSource: current => { source = current },
        onChange: () => {
          for (const publish of publishers) publish()
        },
      },
    )
  })
  return settings
}

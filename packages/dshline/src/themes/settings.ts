/**
 * The theme as a Harness settings section.
 *
 * Harness owns the document, the layering, the validation, and the change feed.
 * This module owns one namespace and one key, and turns what Harness publishes
 * into the two things the window needs: what the theme is now, and a way to
 * store the reader's choice.
 *
 * The canonical wiring for a consumer whose settings service is OPTIONAL,
 * which is exactly this one, is `SettingsProvider#installSection`: while a
 * provider exists it registers the namespace with the plugin's composition
 * entry as the `base` layer and points the source at the resolved scope, and
 * when none is mounted the source falls back to that entry, so a deployment
 * with no settings provider still runs on the theme it was composed with.
 *
 * Layering is therefore Harness's, not this frontend's: schema default, then
 * the `dshline` row's `config.theme`, then the user's `settings.yaml`. There is
 * no second document, no parser, and no state machine.
 * @module dshline/themes/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { escapeControls } from '@dshline/renderer'
import { FALLBACK_THEME, THEMES } from './builtin.ts'

/**
 * The namespace this frontend owns. Matches the row id its bundle inserts.
 *
 * A plain literal: the settings service validates a namespace at the type
 * level (lowercase, hyphenated), so `'dshline'` is accepted directly and the
 * brand never has to be asserted.
 */
const THEME_NAMESPACE = 'dshline'

/** The one key that namespace holds. */
const THEME_KEY = 'theme'

/**
 * The section's schema: the shipped theme ids, and nothing else.
 *
 * A union of the ids rather than a free string, so an unknown value is rejected
 * by the SCHEMA — Harness then keeps the namespace's last good value and warns,
 * which is a better answer than this frontend re-validating a string it was
 * handed. It also makes a configuration UI render the real choices.
 *
 * Deliberately not the plugin's whole {@link Config}. Prices and peak hours are
 * composition-time deployment facts nobody edits from inside a session, and
 * pulling them in would turn one preference into a settings surface for
 * everything this row can be configured with.
 */
const ThemeSection = Schema.object({
  [THEME_KEY]: Schema.union(THEMES.map(theme => Schema.const(theme.id)))
    .default(FALLBACK_THEME.id)
    .description('Colour palette this frontend draws with.'),
}).description('dshline')

/** The resolved shape of that section. */
export interface ThemeSection {
  /** The theme id currently in force. */
  readonly theme: string
}

/** What the window needs from the settings layer. */
export interface ThemeSettings {
  /** The theme id in force right now, across every layer Harness resolves. */
  readonly current: () => string
  /**
   * Observe a committed change from any source — including `settings.yaml`
   * edited by hand while the session runs.
   * @param listener - called after the resolved value changes.
   * @returns the disposer removing this listener.
   */
  readonly watch: (listener: () => void) => () => void
  /**
   * Store a choice in the user layer.
   *
   * A path op rather than a whole-section write, so a key this frontend does not
   * know about — one a newer version added — is never deleted by an older one.
   * @param theme - the id to store.
   * @returns a phrase to append to the command's report, or nothing to add.
   */
  readonly save: (theme: string) => Promise<string | undefined>
}

/**
 * Register the namespace and expose it to the window.
 * @param ctx - the plugin context owning the registration.
 * @param entry - this row's composition config, used as the `base` layer.
 * @returns the reader and writer the window uses.
 */
export function installThemeSettings(ctx: Context, entry: Partial<ThemeSection>): ThemeSettings {
  // Until a settings service attaches, the composition entry IS the answer.
  let source: () => ThemeSection = () => ({ theme: entry.theme ?? FALLBACK_THEME.id })
  const listeners = new Set<() => void>()
  // `ctx.inject` rather than a one-shot `ctx.get`, which is what gives this
  // registration every lifecycle guarantee the frontend would otherwise have to
  // reimplement: a provider mounting later still gets registered, a provider
  // disappearing runs `installSection`'s own teardown effect — which is what
  // restores the composition entry — unloading dshline's fiber tears the
  // injected fiber down with it, and a stored section the schema already
  // rejects fails that fiber's startup, which Cordis's plugin loader contains.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection<typeof THEME_NAMESPACE, ThemeSection>(
      ctx,
      THEME_NAMESPACE,
      ThemeSection,
      source(),
      {
        setSource: current => { source = current },
        onChange: () => {
          for (const listener of listeners) listener()
        },
      },
    )
  })
  return {
    current: () => source().theme,
    watch: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    save: async theme => {
      const settings = ctx.get('settings')
      // Nothing to write to. Saying so beats a switch the reader believes was
      // stored when it will last exactly as long as the process.
      if (settings === undefined) return 'not saved: this profile mounts no settings provider'
      try {
        await settings.mutate(THEME_NAMESPACE, [{ op: 'set', path: [THEME_KEY], value: theme }])
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

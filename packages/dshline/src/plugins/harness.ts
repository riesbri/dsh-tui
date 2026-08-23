/**
 * The exact Harness surfaces this frontend consumes for agent presets, and
 * nothing else — read by `/plugins` and by `window.ts`'s per-agent
 * composition alike, since both are the same one seam.
 *
 * Two seams answer everything either caller needs:
 *
 * ```
 * ctx.get('agentPresets')   the preset roster, one preset's composition text,
 *                           joining/recomposing an agent, and copy/remove
 * ctx.get('settings')       the `agent-presets.default` setting, written
 *                           through the same path/op contract every namespace
 *                           uses
 * ```
 *
 * Neither is imported from `@deepseek-ai/dsh-agent-presets` or
 * `@deepseek-ai/dsh-settings`. This mirrors `connect/harness.ts`'s own choice
 * for the same reason: a profile that mounts neither service still starts —
 * `/plugins` degrades instead of failing to open, and an agent this frontend
 * attaches simply keeps whatever the host layer already composed, exactly
 * as before presets existed here — and a structural shape costs nothing at
 * the few call sites that use it. Every field below is copied from the
 * published `@deepseek-ai/dsh-agent-presets` source, not guessed —
 * `AgentPresetRow`'s shape, `mount`/`recompose`'s real return type
 * (`AgentPresetRow`, not a bespoke "read" type), and `ensureStanding`'s
 * mtime+size stamp (the reason a blank session's `recompose` after a file
 * edit picks up the new generation, and a started session's does not) all
 * come from `packages/preset/agent-presets/src/index.ts` in deepseek-harness.
 * @module dshline/plugins/harness
 */

import type { Context } from '@deepseek-ai/cordis'

/** Whether a preset ships with the deployment or was authored locally. */
export type PresetTrust = 'system' | 'user'

/** One preset as the roster reports it — never composition rows. */
export interface AgentPresetRow {
  /** The preset's id; also its directory name. */
  readonly id: string
  /** Whether this preset ships with the deployment or was authored locally. */
  readonly trust: PresetTrust
  /** Absolute path to the preset's composition file (`agent.cordis.yml`), not its directory. */
  readonly path: string
  /** Display name; falls back to `id` when absent. */
  readonly name?: string
  /** One-line description. */
  readonly description?: string
  /** Declared ordering hint among presets. */
  readonly order?: number
  /**
   * Human-readable reason this preset cannot be mounted, when it cannot.
   * Present on the roster row rather than hiding the preset — a broken preset
   * still needs to be seen so it can be fixed or removed.
   */
  readonly broken?: string
}

/**
 * The `ctx.get('agentPresets')` surface this frontend consumes — read by
 * `/plugins` (browsing, toggling, switching), and by `window.ts`'s
 * `attachOptions` (composing every agent it attaches from its resolved
 * preset, the reason a composition exists for `/plugins` to browse at all).
 * One structural shape for both, rather than two drifting copies of the same
 * real service.
 *
 * `mount`/`recompose` return the `AgentPresetRow` now installed, matching
 * the real service exactly — not `Promise<void>`, and not a distinct "read"
 * type. Both methods' own docs say the caller owns the blank-session/
 * unpublished-agent checks; callers here perform those themselves (see
 * `model.ts` for `/plugins`, `window.ts` for agent composition).
 */
export interface AgentPresetsSeam {
  /** The preset id used when a session names none. */
  readonly defaultId: string
  /** Whether this deployment has a root locally authored presets can go to. */
  readonly authorable: boolean
  /** Every preset this roster's roots supply, broken ones included. */
  list(): Promise<readonly AgentPresetRow[]>
  /** Resolve one preset by id; throws when no root supplies it. */
  resolve(id?: string): Promise<AgentPresetRow>
  /** The preset id a joined agent is actually composed from, if any. */
  composedPreset(agentCtx: object): string | undefined
  /** Join an unpublished agent to a preset's standing composition; the only supported call site is `setup(agentCtx)`. */
  mount(agentCtx: object, id?: string): Promise<AgentPresetRow>
  /** Re-link one agent to a different preset's standing composition. */
  recompose(agentCtx: object, id: string): Promise<AgentPresetRow>
  /** One preset's composition text, exactly as stored. */
  read(id: string): Promise<string>
  /** Create a locally authored preset by copying an existing one whole. */
  copy(from: string, id: string, name?: string): Promise<void>
  // The real service also exposes `remove(id)`. It is deliberately absent
  // here: this is the set of surfaces this frontend CONSUMES, and declaring a
  // destructive one it never calls would make every test double implement a
  // deletion path nothing exercises, while reading as though `/plugins` can
  // delete a preset. Add it in the same change that first offers deletion.
}

/** One `{ op, path }` edit against a namespace's stored user section. */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/**
 * The `ctx.get('settings')` surface `/plugins` consumes: one write, to the
 * `agent-presets` namespace's `default` field. `/plugins` never reads through
 * this seam — `AgentPresetsSeam.defaultId` already reports the resolved
 * value, layering included.
 */
export interface PluginsSettings {
  /**
   * Apply ordered path edits to one namespace's user section.
   * @param ns - the namespace to edit (`'agent-presets'` for every call here).
   * @param ops - the edits, applied in order.
   * @param expectedRevision - the revision the caller read; a stale one rejects.
   */
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** Which of the two optional seams this deployment mounts. */
export interface PluginsSeams {
  /** The preset roster and composition seam, when this profile mounts one. */
  readonly agentPresets: AgentPresetsSeam | undefined
  /** The settings seam, needed only to write `agent-presets.default`. */
  readonly settings: PluginsSettings | undefined
}

/**
 * Read the two seams `/plugins` needs off a context, without asserting that
 * either is mounted.
 * @param ctx - context carrying (or not carrying) the seams.
 * @returns the seams found.
 */
export function pluginsSeams(ctx: Context): PluginsSeams {
  return {
    agentPresets: ctx.get('agentPresets') as AgentPresetsSeam | undefined,
    settings: ctx.get('settings') as PluginsSettings | undefined,
  }
}

/**
 * The exact Harness surfaces `/plugins` consumes, and nothing else.
 *
 * Two seams answer everything this domain needs:
 *
 * ```
 * ctx.get('agentPresets')   the preset roster, one preset's composition text,
 *                           the session-composition swap, and copy/remove
 * ctx.get('settings')       the `agent-presets.default` setting, written
 *                           through the same path/op contract every namespace
 *                           uses
 * ```
 *
 * Neither is imported from `@deepseek-ai/dsh-agent-presets` or
 * `@deepseek-ai/dsh-settings`. This mirrors `connect/harness.ts`'s own choice
 * for the same reason: a profile that mounts neither service still starts
 * `/plugins`, which degrades instead of failing to open, and a structural
 * shape costs nothing at the one or two call sites that use it. Every field
 * below is copied from the published `@deepseek-ai/dsh-agent-presets` source,
 * not guessed — `AgentPresetRow`'s shape, `recompose`'s real return type
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
 * The `ctx.get('agentPresets')` surface `/plugins` consumes.
 *
 * `recompose` returns the `AgentPresetRow` now installed, matching the real
 * service exactly — not a `Promise<void>`, and not a distinct "read" type.
 * Its doc there states the caller owns the blank-session check; `/plugins`
 * performs that check itself before ever calling it (see `model.ts`).
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
  /** Re-link one agent to a different preset's standing composition. */
  recompose(agentCtx: object, id: string): Promise<AgentPresetRow>
  /** One preset's composition text, exactly as stored. */
  read(id: string): Promise<string>
  /** Create a locally authored preset by copying an existing one whole. */
  copy(from: string, id: string, name?: string): Promise<void>
  /** Delete a locally authored preset. */
  remove(id: string): Promise<void>
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

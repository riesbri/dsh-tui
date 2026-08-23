/**
 * Reading Harness's preset roster and one preset's composition, on demand.
 *
 * One pass reads the whole browser: the roster (`list()`), the active
 * session's actual preset (from its own log, via `resolveSessionPreset`), the
 * default a new session would get (`defaultId`), and the composition text of
 * whichever preset is currently being BROWSED — which starts as the session's
 * own preset but can move without touching the session, so a system preset's
 * rows can be inspected and copied before anything is switched. Between
 * passes this class holds a rendered snapshot and nothing else, the same
 * discipline `connect/catalog.ts` keeps: no preset list, no composition
 * cache, and no session mirror to fall out of date. `list()` and `read()` are
 * unmemoized on the Harness side for exactly this reason — a roster is a live
 * directory, and holding a private copy of it is how a frontend disagrees
 * with a file someone just edited outside it.
 * @module dshline/plugins/catalog
 */

import type { CompositionTree } from './composition.ts'
import { parseComposition } from './composition.ts'
import type { AgentPresetsSeam, PluginsSeams } from './harness.ts'
import type { PluginsSessionFacts, PresetRow } from './model.ts'
import { presetRows, resolveSessionPreset } from './model.ts'

/** Which of the two optional seams this deployment mounts, joined with what the roster allows. */
export interface PluginsCapabilities {
  /** Whether `ctx.get('agentPresets')` is mounted at all. */
  readonly agentPresets: boolean
  /** Whether `ctx.get('settings')` is mounted, needed to write the default. */
  readonly settings: boolean
  /** Whether this deployment has a root locally authored presets can go to. */
  readonly canWriteUserPresets: boolean
}

/** One preset's composition, as the browser currently reads it. */
export type BrowsedComposition =
  /** Parsed successfully. */
  | { readonly kind: 'rows'; readonly presetId: string; readonly tree: Extract<CompositionTree, { kind: 'parsed' }> }
  /** The preset's file could not be read or parsed as an entry list. */
  | { readonly kind: 'broken'; readonly presetId: string; readonly reason: string }

/** What one gathering pass produced. */
export type PluginsState =
  /** The first read has not landed yet. */
  | { readonly kind: 'loading' }
  /** This profile mounts no `agentPresets` seam; there is nothing to browse. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** Harness could not answer. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A complete reading. */
  | {
    readonly kind: 'ready'
    readonly capabilities: PluginsCapabilities
    readonly presets: readonly PresetRow[]
    readonly defaultId: string
    readonly sessionPresetId: string | undefined
    readonly blank: boolean
    readonly browsing: BrowsedComposition
  }

/** What the catalog needs from its owner. */
export interface PluginsCatalogSpec {
  /** The Harness seams to read. */
  readonly seams: PluginsSeams
  /** The active agent's scope context, for `composedPreset`. */
  readonly agentCtx: object
  /** The active session's facts, for the blank check and preset resolution. */
  readonly session: PluginsSessionFacts
  /** Redraw after a pass lands. */
  readonly invalidate: () => void
}

/** Reads Harness's preset roster and one preset's composition, on demand. */
export class PluginsCatalog {
  private current: PluginsState = { kind: 'loading' }
  private generation = 0
  private disposed = false
  private browsingOverride: string | undefined

  /**
   * @param spec - the seams, agent, and session to read, and the redraw to call.
   */
  constructor(private readonly spec: PluginsCatalogSpec) {}

  /** The most recent complete reading, or what is standing in for one. */
  state(): PluginsState {
    return this.current
  }

  /**
   * Browse a different preset's composition without touching the session.
   *
   * This is how a system preset gets copied and then edited in the same
   * browser session: the copy changes what a NEW preset id resolves to, and
   * this is what points the browser at it, entirely independent of whether
   * the active session ever recomposes.
   * @param presetId - the preset to browse from the next pass on.
   */
  browse(presetId: string): void {
    this.browsingOverride = presetId
    this.refresh()
  }

  /**
   * Start a fresh pass over the roster and the browsed preset's composition.
   *
   * Never awaited by the caller, matching `connect/catalog.ts`: the browser
   * is already on screen, and a read that has not landed shows the previous
   * reading rather than a blank frame.
   */
  refresh(): void {
    if (this.disposed) return
    const generation = ++this.generation
    void this.gather()
      .then(next => { this.settle(generation, next) })
      .catch((error: unknown) => {
        this.settle(generation, { kind: 'failed', message: messageOf(error) })
      })
  }

  /** Abandon in-flight passes; their results would repaint a closed browser. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }

  /**
   * Adopt a pass's result when it is still the newest one.
   * @param generation - the pass's stamp.
   * @param next - what it read.
   */
  private settle(generation: number, next: PluginsState): void {
    if (this.disposed || generation !== this.generation) return
    this.current = next
    this.spec.invalidate()
  }

  /**
   * Read the roster and one preset's composition once, and join them.
   * @returns the complete reading.
   */
  private async gather(): Promise<PluginsState> {
    const { agentPresets, settings } = this.spec.seams
    if (agentPresets === undefined) {
      return { kind: 'unavailable', message: 'agent presets are not available in this Harness profile' }
    }
    const capabilities: PluginsCapabilities = {
      agentPresets: true,
      settings: settings !== undefined,
      canWriteUserPresets: agentPresets.authorable,
    }
    const [presets, defaultId, sessionPresetId] = await Promise.all([
      agentPresets.list(),
      Promise.resolve(agentPresets.defaultId),
      Promise.resolve(composedOrResolved(agentPresets, this.spec.agentCtx, this.spec.session)),
    ])
    const browsingId = this.browsingOverride ?? sessionPresetId ?? defaultId
    const browsing = await this.readComposition(agentPresets, browsingId)
    return {
      kind: 'ready',
      capabilities,
      presets: presetRows(presets, sessionPresetId, defaultId),
      defaultId,
      sessionPresetId,
      blank: !this.spec.session.events.some(event => event.type === 'turn/start'),
      browsing,
    }
  }

  /**
   * Read and parse one preset's composition, reporting a broken read rather
   * than throwing out of the pass.
   * @param agentPresets - the preset seam.
   * @param presetId - the preset to read.
   * @returns the browsed composition, parsed or broken.
   */
  private async readComposition(agentPresets: AgentPresetsSeam, presetId: string): Promise<BrowsedComposition> {
    let text: string
    try {
      text = await agentPresets.read(presetId)
    } catch (error) {
      return { kind: 'broken', presetId, reason: messageOf(error) }
    }
    const tree = parseComposition(text)
    if (tree.kind === 'broken') return { kind: 'broken', presetId, reason: tree.reason }
    return { kind: 'rows', presetId, tree }
  }
}

/**
 * The active session's actual preset: what the agent already composed, when
 * it has, otherwise what the session's own log resolves to.
 * @param agentPresets - the preset seam.
 * @param agentCtx - the agent's scope context.
 * @param session - the session's facts.
 * @returns the preset id, or undefined when neither source names one.
 */
function composedOrResolved(
  agentPresets: AgentPresetsSeam,
  agentCtx: object,
  session: PluginsSessionFacts,
): string | undefined {
  return agentPresets.composedPreset(agentCtx) ?? resolveSessionPreset(session)
}

/**
 * A message for a failure, without leaking an object's shape into the UI.
 * @param error - whatever was thrown.
 * @returns the sentence to show.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

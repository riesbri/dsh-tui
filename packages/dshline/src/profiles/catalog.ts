/**
 * Reading Harness's profile roster on demand.
 *
 * The same discipline `connect/catalog.ts` and `plugins/catalog.ts` keep:
 * generation-stamped passes, a rendered snapshot between them, and no private
 * copy of anything Harness owns. A profile roster is a live directory that
 * `dsh plugin` writes to — including the invocation this browser just ran —
 * so holding it is how a browser disagrees with the filesystem.
 * @module dshline/profiles/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProfilesReading } from './harness.ts'
import { readProfiles } from './harness.ts'

/** What one gathering pass produced. */
export type ProfilesState =
  /** The first read has not landed yet. */
  | { readonly kind: 'loading' }
  /** This deployment provides no `dshHomePath`, so no profiles root can be named. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** The read failed. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A complete reading. */
  | { readonly kind: 'ready'; readonly reading: ProfilesReading }

/** What the catalog needs from its owner. */
export interface ProfilesCatalogSpec {
  /** Context carrying `dshHomePath` and the Loader's base URL. */
  readonly ctx: Context
  /** Redraw after a pass lands. */
  readonly invalidate: () => void
  /** Read the roster; injected so tests drive the catalog without a home. */
  readonly read?: (ctx: Context) => Promise<ProfilesReading | undefined>
}

/** Reads the profile roster on demand. */
export class ProfilesCatalog {
  private current: ProfilesState = { kind: 'loading' }
  private generation = 0
  private disposed = false

  /**
   * @param spec - the context to read and the redraw to call.
   */
  constructor(private readonly spec: ProfilesCatalogSpec) {}

  /** The most recent complete reading, or what is standing in for one. */
  state(): ProfilesState {
    return this.current
  }

  /**
   * Start a fresh pass over the profiles root.
   *
   * Never awaited by the caller: the browser is already on screen, and a read
   * that has not landed shows the previous reading rather than a blank frame.
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
  private settle(generation: number, next: ProfilesState): void {
    if (this.disposed || generation !== this.generation) return
    this.current = next
    this.spec.invalidate()
  }

  /**
   * Read the roster once.
   * @returns the complete reading.
   */
  private async gather(): Promise<ProfilesState> {
    const reading = await (this.spec.read ?? readProfiles)(this.spec.ctx)
    if (reading === undefined) {
      return {
        kind: 'unavailable',
        message: 'this Harness profile provides no home-path service, so no profile roster can be read',
      }
    }
    return { kind: 'ready', reading }
  }
}

/**
 * A message for a failure, without leaking an object's shape into the UI.
 * @param error - whatever was thrown.
 * @returns the sentence to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

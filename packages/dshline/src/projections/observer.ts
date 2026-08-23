/**
 * Session-scoped observation of Harness projection snapshots.
 *
 * The registry remains the state authority: change notifications only coalesce
 * a later redraw, and every consumer reads its value from `snapshot(session)`.
 * @module dshline/projections/observer
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

/** Inputs the shared session-projection observer needs from the runner. */
export interface SessionProjectionObserverSpec {
  /** Optional Harness registry; custom profiles may omit the entire seam. */
  readonly registry: SessionProjectionRegistry | undefined
  /** Exact session instance whose views this observer serves. */
  readonly session: Session
  /** Request a live-region redraw after the registry's synchronous drive settles. */
  readonly invalidate: () => void
}

/**
 * Observe one exact session's optional Harness projection registry.
 *
 * The registry calls listeners once for every changing unit while it drives one
 * event. Deferring one invalidation to a microtask prevents a view render from
 * synchronously re-entering that drive and makes several unit changes one redraw.
 */
export class SessionProjectionObserver {
  private alive = true
  private pending = false
  private readonly unsubscribe: (() => void) | undefined

  /**
   * @param spec - optional registry, exact session identity, and redraw request.
   */
  constructor(private readonly spec: SessionProjectionObserverSpec) {
    const { registry, session } = spec
    this.unsubscribe = registry?.onChanged(changedSession => {
      // Session ids are durable names, not an authority boundary. A replacement
      // instance with the same id must never redraw this agent's presentation.
      if (changedSession !== session || this.pending) return
      this.pending = true
      queueMicrotask(() => {
        this.pending = false
        if (this.alive) spec.invalidate()
      })
    })
  }

  /** Whether this profile mounted the generic projection infrastructure. */
  get available(): boolean {
    return this.spec.registry !== undefined
  }

  /**
   * Read the registry's authoritative current cut for this exact session.
   * @returns the snapshot, or undefined when the optional registry is absent.
   */
  snapshot(): ProjectionSnapshot | undefined {
    return this.spec.registry?.snapshot(this.spec.session)
  }

  /** Stop observing and suppress an already-queued redraw. */
  dispose(): void {
    if (!this.alive) return
    this.alive = false
    this.unsubscribe?.()
  }
}

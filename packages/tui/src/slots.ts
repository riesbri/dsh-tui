/**
 * The TUI's own extension registry.
 *
 * The harness is a plugin system, and this frontend is one plugin inside it —
 * but its own parts are plugins too. The status line, the approval prompt, the
 * model picker, and the composer do not know about each other: each registers a
 * view into a named slot, and the runner composes the live region from whatever
 * is registered. Adding a footer widget or replacing the approval prompt is a
 * registration, not an edit to the runner.
 *
 * The web client does the same thing with `ctx.slots`; this is the terminal's
 * equivalent, deliberately smaller — the live region is a list of lines, so a
 * slot contributes lines rather than a component tree.
 * @module @riesbri/dsh-tui/slots
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Key, LiveCursor } from '@riesbri/dsh-tui-renderer'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiSlots: TuiSlots
  }
}

/**
 * Slots the runner composes into the live region, in this order top to bottom.
 * The names are positional on purpose: a view chooses where it sits by naming a
 * slot, so reordering the chrome never means editing the runner. This is
 * experimental pre-1.0 extension vocabulary, not a stable plugin API.
 */
export type TuiSlotName = 'stream' | 'composer' | 'completion' | 'status'

/** Composition order, which is the reading order on screen. */
const SLOT_ORDER: readonly TuiSlotName[] = ['stream', 'composer', 'completion', 'status']

/**
 * A registered contributor of live-region lines.
 *
 * Experimental pre-1.0 extension vocabulary; third-party persistent rows must
 * wait for a global live-region layout budget.
 */
export interface TuiSlotView {
  /**
   * Lines this view contributes right now.
   *
   * `rows` is what is LEFT of the terminal at this point in the composition, not
   * the terminal's own height: the views above this one have already been
   * rendered and their lines subtracted. A view that bounds itself against the
   * whole screen would be budgeting against space another view has already
   * spent — which is how a tall composer plus a suggestion list grew the live
   * region past the screen.
   * @param columns - the terminal's current width, for views that fit content.
   * @param rows - the rows still unspent below this point, when the view bounds
   *   itself. What remains below THIS view is still its own to account for.
   * @returns logical lines; the screen wraps them.
   */
  render(columns: number, rows?: number): readonly string[]
  /**
   * Where the terminal cursor belongs inside THIS view's own lines, for the one
   * view that owns text entry. Row 0 is the view's first line, so a view can be
   * moved or reordered without the runner recomputing anything.
   *
   * At most one registered view should answer; the first that does wins.
   * @param columns - the terminal's current width.
   * @returns the placement, or undefined when this view wants no cursor.
   */
  cursor?(columns: number): LiveCursor | undefined
}

/**
 * A view that takes over the whole live region and every keystroke while it is
 * mounted: an approval prompt, a question, a picker. Overlays stack, and only
 * the topmost one renders and receives keys, so a question raised while an
 * approval is pending does not interleave with it. Experimental pre-1.0:
 * overlays are the supported temporary extension seam, not a stable SDK.
 */
export interface TuiOverlay extends TuiSlotView {
  /**
   * Consume one keystroke. The overlay is responsible for dismissing itself by
   * disposing its own registration.
   * @param key - the decoded keystroke.
   */
  handleKey(key: Key): void
  /** Called after the overlay becomes mounted. */
  mounted?(): void
  /** Called once when the overlay is removed, for temporary resources. */
  dispose?(): void
}

/** One registration, kept with its priority so ordering survives re-render. */
interface Registration {
  readonly view: TuiSlotView
  readonly priority: number
}

/**
 * Live-region composition registry. Every mutation notifies the runner through
 * `tui/render`, so a view that changes its own content asks for a redraw by
 * calling {@link TuiSlots.invalidate} rather than reaching for the screen.
 * Experimental pre-1.0: registrations are not yet a public plugin SDK.
 */
export class TuiSlots extends Service {
  private readonly slots = new Map<TuiSlotName, Registration[]>()
  private readonly overlays: TuiOverlay[] = []

  constructor(ctx: Context) {
    super(ctx, 'tuiSlots')
    ctx.effect(() => () => {
      // A mounted overlay may own an unref'd timer or another temporary handle.
      // Disposing only the service without informing it would leak that resource
      // after the terminal is gone.
      for (const overlay of this.overlays.splice(0)) overlay.dispose?.()
    }, 'tuiSlots: overlay disposal')
  }

  /**
   * Contribute lines to a slot.
   * @param name - the slot to fill.
   * @param view - the contributor.
   * @param priority - higher renders later (further down) within the slot.
   * @returns the disposer removing this contribution.
   */
  register(name: TuiSlotName, view: TuiSlotView, priority = 0): () => void {
    const list = this.slots.get(name) ?? []
    list.push({ view, priority })
    list.sort((left, right) => left.priority - right.priority)
    this.slots.set(name, list)
    this.invalidate()
    return () => {
      const current = this.slots.get(name)
      if (current === undefined) return
      const index = current.findIndex(entry => entry.view === view)
      if (index >= 0) current.splice(index, 1)
      this.invalidate()
    }
  }

  /**
   * Mount an overlay on top of the stack, taking over rendering and input.
   * @param overlay - the overlay to mount.
   * @returns the disposer unmounting it; safe to call more than once.
   */
  pushOverlay(overlay: TuiOverlay): () => void {
    this.overlays.push(overlay)
    overlay.mounted?.()
    this.invalidate()
    return () => {
      const index = this.overlays.indexOf(overlay)
      if (index < 0) return
      this.overlays.splice(index, 1)
      overlay.dispose?.()
      this.invalidate()
    }
  }

  /** The overlay owning rendering and input, or undefined when none is mounted. */
  get activeOverlay(): TuiOverlay | undefined {
    return this.overlays.at(-1)
  }

  /**
   * Compose the live region.
   *
   * An overlay replaces the whole region and takes every key, so it contributes
   * no cursor: text entry belongs to the composer, which is not on screen while
   * an overlay is up.
   *
   * Each slot view is asked for its lines with the rows the views above it have
   * NOT already spent. The live region must never exceed the screen — rows that
   * have scrolled off cannot be climbed back to and erased — and no single view
   * can enforce that alone, because none of them knows how tall the others are.
   * Subtracting as it goes is what makes a self-bounding view's budget true.
   * @param columns - the terminal's current width.
   * @param rows - the terminal's current height; defaults for older callers.
   * @returns the lines to draw top to bottom, and where the cursor belongs.
   */
  compose(columns: number, rows = 24): { lines: string[]; cursor: LiveCursor | undefined } {
    const overlay = this.activeOverlay
    if (overlay !== undefined) return { lines: [...overlay.render(columns, rows)], cursor: undefined }
    const lines: string[] = []
    let cursor: LiveCursor | undefined
    for (const name of SLOT_ORDER) {
      for (const entry of this.slots.get(name) ?? []) {
        const own = entry.view.render(columns, Math.max(0, rows - lines.length))
        const placement = cursor === undefined ? entry.view.cursor?.(columns) : undefined
        // Translate the view-relative row into the composed region's row space.
        if (placement !== undefined) cursor = { row: lines.length + placement.row, column: placement.column }
        lines.push(...own)
      }
    }
    return { lines, cursor }
  }

  /** Ask the runner to redraw. */
  invalidate(): void {
    this.ctx.emit('tui/render')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The live region's content changed and should be redrawn. */
    'tui/render': () => void
  }
}

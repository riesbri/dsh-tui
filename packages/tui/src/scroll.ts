/**
 * A bounded window over physical rendered rows.
 *
 * Rendering owns what a row means; this class owns only which contiguous rows
 * are visible. Keeping those concerns apart lets modal documents, lists, and
 * future views share the same resize-safe position rules.
 * @module @riesbri/dsh-tui/scroll
 */

/** A scroll position over a sequence of rendered rows. */
export class RowViewport {
  private offset = 0
  private total = 0
  private visible = 1

  /**
   * Update the document and window sizes, retaining the current position where
   * it remains valid.
   * @param total - rendered rows in the complete document.
   * @param visible - rows the current layout can show, possibly zero.
   * @returns whether a smaller document or wider window moved the viewport.
   */
  update(total: number, visible: number): boolean {
    this.total = Math.max(0, total)
    this.visible = Math.max(0, visible)
    const next = Math.min(this.offset, this.maxOffset)
    if (next === this.offset) return false
    this.offset = next
    return true
  }

  /**
   * Move by physical rendered rows, clamped to the document's bounds.
   * @param amount - positive moves down; negative moves up.
   * @returns whether the position changed.
   */
  move(amount: number): boolean {
    const next = Math.min(Math.max(this.offset + amount, 0), this.maxOffset)
    if (next === this.offset) return false
    this.offset = next
    return true
  }

  /**
   * Jump to the document's first row.
   * @returns whether the position changed.
   */
  first(): boolean {
    if (this.offset === 0) return false
    this.offset = 0
    return true
  }

  /**
   * Jump to the last valid top row.
   * @returns whether the position changed.
   */
  last(): boolean {
    if (this.offset === this.maxOffset) return false
    this.offset = this.maxOffset
    return true
  }

  /** The first visible row, zero-based. */
  get start(): number {
    return this.offset
  }

  /** The exclusive end of the visible window. */
  get end(): number {
    return Math.min(this.offset + this.visible, this.total)
  }

  /** The greatest valid first visible row. */
  get maxOffset(): number {
    return Math.max(0, this.total - this.visible)
  }
}

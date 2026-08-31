/**
 * Identity-keyed focus over a list of rendered rows.
 *
 * The companion of {@link RowViewport}: that class owns which contiguous rows
 * are visible, this one owns which row the human is aimed at. Keeping focus on
 * an IDENTITY rather than an index is what lets a live list insert or remove
 * rows under the cursor without a keystroke landing on whatever inherited the
 * old screen position.
 * @module dshline/focus
 */

/** A wrapping cursor over the focusable rows of one view. */
export class FocusRing {
  private keys: readonly string[] = []
  private aim: string | undefined
  private at = -1

  /**
   * Re-align the ring with the rows the newest render produced.
   *
   * When the aimed key still exists its new position is adopted, so a row that
   * appeared above it never drags the cursor. When it vanished, `retarget`
   * decides what happens: rendering adopts the predictable neighbour as the new
   * aim, while a human ACTION keeps the dead aim so it can refuse rather than
   * hit that neighbour.
   * @param keys - focus identities of the current focusable rows, in row order.
   * @param retarget - whether a vanished aim may be replaced by its neighbour.
   */
  update(keys: readonly string[], retarget: boolean): void {
    this.keys = keys
    if (keys.length === 0) {
      this.at = -1
      if (retarget) this.aim = undefined
      return
    }
    const found = this.aim === undefined ? -1 : keys.indexOf(this.aim)
    if (found >= 0) {
      this.at = found
      return
    }
    this.at = Math.min(Math.max(this.at, 0), keys.length - 1)
    if (retarget || this.aim === undefined) this.aim = keys[this.at]
  }

  /**
   * Move the cursor by whole focusable rows, wrapping at either end.
   * @param amount - positive moves down; negative moves up.
   */
  move(amount: number): void {
    const total = this.keys.length
    if (total === 0) return
    this.at = (this.at + amount + total) % total
    this.aim = this.keys[this.at]
  }

  /** Aim at the first focusable row. */
  first(): void {
    if (this.keys.length === 0) return
    this.at = 0
    this.aim = this.keys[0]
  }

  /** Aim at the last focusable row. */
  last(): void {
    if (this.keys.length === 0) return
    this.at = this.keys.length - 1
    this.aim = this.keys[this.at]
  }

  /**
   * Aim at one exact identity, whether or not it is currently present.
   * @param key - the identity to aim at, or undefined to aim at nothing.
   */
  aimAt(key: string | undefined): void {
    this.aim = key
    this.at = key === undefined ? -1 : this.keys.indexOf(key)
  }

  /** The aimed identity, which may no longer be present after a removal. */
  get current(): string | undefined {
    return this.aim
  }

  /** Position among the focusable rows, or -1 when there are none. */
  get position(): number {
    return this.keys.length === 0 ? -1 : this.at
  }
}

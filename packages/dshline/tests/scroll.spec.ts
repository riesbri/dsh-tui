/** A viewport owns row position across document and terminal-size changes. */

import { describe, expect, it } from 'vitest'
import { RowViewport } from '../src/scroll.ts'

describe('RowViewport', () => {
  it('starts at the first row and cannot move above it', () => {
    const viewport = new RowViewport()
    viewport.update(10, 3)
    expect(viewport.start).toBe(0)
    expect(viewport.move(-1)).toBe(false)
  })

  it('moves through rows and clamps at the last full window', () => {
    const viewport = new RowViewport()
    viewport.update(10, 3)
    expect(viewport.move(4)).toBe(true)
    expect([viewport.start, viewport.end]).toEqual([4, 7])
    expect(viewport.move(100)).toBe(true)
    expect([viewport.start, viewport.end, viewport.maxOffset]).toEqual([7, 10, 7])
    expect(viewport.move(1)).toBe(false)
  })

  it('jumps to both ends', () => {
    const viewport = new RowViewport()
    viewport.update(10, 3)
    expect(viewport.last()).toBe(true)
    expect(viewport.start).toBe(7)
    expect(viewport.first()).toBe(true)
    expect(viewport.start).toBe(0)
  })

  it('keeps position when shrinking the window and clamps it when growing it', () => {
    const viewport = new RowViewport()
    viewport.update(20, 10)
    viewport.move(8)
    viewport.update(20, 4)
    expect(viewport.start).toBe(8)
    viewport.update(20, 15)
    expect(viewport.start).toBe(5)
  })

  it('clamps when the document shrinks', () => {
    const viewport = new RowViewport()
    viewport.update(20, 4)
    viewport.last()
    viewport.update(6, 4)
    expect([viewport.start, viewport.end]).toEqual([2, 6])
  })

  it('allows a zero-row window without invalid offsets', () => {
    const viewport = new RowViewport()
    viewport.update(4, 0)
    expect(viewport.last()).toBe(true)
    expect([viewport.start, viewport.end, viewport.maxOffset]).toEqual([4, 4, 4])
  })

  it('pages by one visible window with a one-row overlap', () => {
    const viewport = new RowViewport()
    viewport.update(28, 10)
    expect(viewport.page(1)).toBe(true)
    expect(viewport.start).toBe(9)
    expect(viewport.page(1)).toBe(true)
    expect(viewport.start).toBe(18)
    expect(viewport.page(-1)).toBe(true)
    expect(viewport.start).toBe(9)
  })

  it('clamps a page at the document ends', () => {
    const viewport = new RowViewport()
    viewport.update(28, 10)
    expect(viewport.page(-1)).toBe(false) // already at the top
    for (let index = 0; index < 20; index += 1) viewport.page(1)
    expect([viewport.start, viewport.end]).toEqual([18, 28]) // last page exactly
  })

  it('pages by one when only one row is visible', () => {
    const viewport = new RowViewport()
    viewport.update(20, 1)
    expect(viewport.page(1)).toBe(true)
    expect(viewport.start).toBe(1)
  })
})

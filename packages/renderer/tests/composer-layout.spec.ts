/**
 * The shared visual layout of a composer: the rows the cursor is drawn on and
 * the mapping from a row/column placement back to a buffer offset are the same
 * numbers, so movement and rendering cannot disagree.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth } from '../src/width.ts'
import { Composer } from '../src/composer.ts'
import { layoutComposer } from '../src/composer-layout.ts'

const GUTTER = (line: number): string => (line === 0 ? '› ' : '  ')

describe('layoutComposer()', () => {
  it('chunks one long line into visual rows and reports the cursor row', () => {
    const composer = new Composer()
    composer.set('abcdefghijklmnopqrstuvwxyzabc')
    const layout = layoutComposer(composer, 12, GUTTER)
    expect(layout.rows).toEqual(['› abcdefghij', 'klmnopqrstuv', 'wxyzabc'])
    expect(layout.cursorRow).toBe(2)
    expect(layout.cursorColumn).toBe(displayWidth('wxyzabc'))
  })

  it('is resize-sensitive: the same buffer lays into different rows by width', () => {
    const composer = new Composer()
    composer.set('abcdefghijklmnopqrstuvwxyzabc')
    expect(layoutComposer(composer, 80, GUTTER).rows).toHaveLength(1)
    expect(layoutComposer(composer, 12, GUTTER).rows.length).toBeGreaterThan(1)
  })

  it('maps a row and preferred column to a buffer offset', () => {
    const composer = new Composer()
    composer.set('first line\nsecond line\nthird line')
    const layout = layoutComposer(composer, 80, GUTTER)
    // Each logical line is one visual row here; aiming past the first row's end
    // lands at its end (offset 10), and the second row starts after the newline.
    expect(layout.positionAt(0, 14)).toBe(10)
    expect(layout.positionAt(1, 24)).toBe(22) // line 1 starts at 10 + newline + 11 chars
  })

  it('clamps an out-of-range column to the end of its own row, not beyond', () => {
    const composer = new Composer()
    composer.set('short\nthirteen-char')
    const layout = layoutComposer(composer, 80, GUTTER)
    // Aiming far past the short first row lands at its end (offset 5), and a
    // later row keeps its own start — column 3 on row 1 is its own +1.
    expect(layout.positionAt(0, 999)).toBe(5)
    expect(layout.positionAt(1, 5)).toBe(9)
  })

  it('maps to the next row after a wrap, so a long row aims within it', () => {
    const composer = new Composer()
    composer.set('abcdefghijklmnopqrstuvwxyzabc')
    const layout = layoutComposer(composer, 12, GUTTER)
    // Aiming at column 14 puts the cursor one row down, inside the second row.
    expect(layout.positionAt(1, 9)).toBe(19)
  })

  it('counts a wide CJK character as two columns when placing a position', () => {
    const composer = new Composer()
    composer.set('标准标准')
    const layout = layoutComposer(composer, 6, GUTTER)
    expect(layout.rows).toEqual(['› 标准', '标准'])
    // Content budget is two wide characters per row. Aiming four columns down the
    // top row lands after the first wide character — two columns in.
    expect(layout.positionAt(0, 4)).toBe(1)
  })

  it('never splits an astral character while moving through a wrapped buffer', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'a🙂🙂b🙂cdef🙂gh' })
    const width = 8
    // Walk up to the first row and back, and confirm the buffer is byte-identical
    // and the cursor never sits at a non-code-point boundary (which an offset is,
    // by construction — the value is preserved whole).
    expect(composer.moveUp(width, GUTTER)).toBe(true)
    expect(composer.value).toBe('a🙂🙂b🙂cdef🙂gh')
    expect(composer.moveDown(width, GUTTER)).toBe(true)
    expect(composer.position).toBe([...composer.value].length)
  })

  it('keeps movement and the layout agreeing on the cursor row', () => {
    // Whatever the width, moving up repeatedly must be able to reach the first row
    // and moving down from there must return to the last, with the buffer intact.
    // (Down aims at the preferred column, so the cursor need not reach the very
    // end of the final line — the row it sits on is what must agree.)
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: '标 a🙂 第一 行 … second' })
    for (const width of [10, 14, 22]) {
      while (composer.moveUp(width, GUTTER)) { /* climb to the top */ }
      expect(layoutComposer(composer, width, GUTTER).cursorRow, `${String(width)} wide`).toBe(0)
      while (composer.moveDown(width, GUTTER)) { /* descend to the bottom */ }
      const layout = layoutComposer(composer, width, GUTTER)
      expect(layout.cursorRow, `${String(width)} wide`).toBe(layout.rows.length - 1)
    }
    expect(composer.value).toBe('标 a🙂 第一 行 … second')
  })
})

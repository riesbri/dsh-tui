import { describe, expect, it } from 'vitest'
import type { ScreenTarget } from '../src/index.ts'
import { Screen } from '../src/index.ts'

/**
 * A screen target that records writes and models the one thing the redraw
 * arithmetic depends on: how many rows the cursor is asked to move.
 */
function fakeTarget(columns = 20): ScreenTarget & { readonly writes: string[]; all: () => string } {
  const writes: string[] = []
  return {
    writes,
    all: () => writes.join(''),
    write: chunk => { writes.push(chunk) },
    columns: () => columns,
  }
}

/** Cursor-up counts in order, so a redraw's row math is directly assertable. */
function cursorUps(text: string): number[] {
  return [...text.matchAll(/\u001b\[(\d+)A/gu)].map(match => Number(match[1]))
}

describe('Screen', () => {
  it('draws a first live region without moving the cursor up', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    expect(cursorUps(target.all())).toEqual([])
    expect(screen.height).toBe(2)
  })

  it('climbs exactly the rows it drew when replacing the region', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two', 'three'])
    target.writes.length = 0
    screen.setLive(['only'])
    // Three rows drawn means two climbs from the bottom row to the first.
    expect(cursorUps(target.all())).toEqual([2])
    expect(screen.height).toBe(1)
  })

  it('counts wrapped rows, not logical lines', () => {
    const target = fakeTarget(10)
    const screen = new Screen(target)
    // Twenty-four columns of text at width ten occupies three rows.
    screen.setLive(['aaaa bbbb cccc dddd eeee'])
    expect(screen.height).toBe(3)
    target.writes.length = 0
    screen.setLive(['short'])
    expect(cursorUps(target.all())).toEqual([2])
  })

  it('counts a CJK line by display columns', () => {
    const target = fakeTarget(8)
    const screen = new Screen(target)
    // Eight ideographs are sixteen columns: two rows at width eight.
    screen.setLive(['标准模式标准模式'])
    expect(screen.height).toBe(2)
  })

  it('descends from a placed cursor before climbing, so the erase starts at the top', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two', 'three'], { row: 0, column: 0 })
    target.writes.length = 0
    screen.setLive(['next'])
    const frame = target.all()
    // The cursor was left on row 0, so the erase must first descend two rows to
    // the bottom, then climb two back to the top.
    expect([...frame.matchAll(/\u001b\[(\d+)B/gu)].map(m => Number(m[1]))).toEqual([2])
    expect(cursorUps(frame)).toEqual([2])
  })

  it('keeps the live region below committed output', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['composer'])
    target.writes.length = 0
    screen.commit(['a committed line'])
    const frame = target.all()
    expect(frame.indexOf('a committed line')).toBeLessThan(frame.indexOf('composer'))
    // The region is still one row tall afterwards, so the next redraw climbs it.
    expect(screen.height).toBe(1)
  })

  it('redraws the region after committing so later erases stay aligned', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    screen.commit(['committed'])
    target.writes.length = 0
    screen.setLive(['replaced'])
    expect(cursorUps(target.all())).toEqual([1])
  })

  it('ignores an empty commit rather than emitting a stray newline', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['live'])
    target.writes.length = 0
    screen.commit([])
    expect(target.writes).toEqual([])
  })

  it('places the cursor by display columns, not code units', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['> 标准'], { row: 0, column: 6 })
    expect(target.all()).toContain('\u001b[6C')
  })

  it('restores the cursor on close and forgets the region', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    target.writes.length = 0
    screen.close()
    expect(target.all()).toContain('\u001b[?25h')
    expect(screen.height).toBe(0)
    target.writes.length = 0
    screen.setLive(['fresh'])
    expect(cursorUps(target.all())).toEqual([])
  })
})

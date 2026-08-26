/**
 * The coalescing repaint scheduler, and the window wiring around it.
 *
 * A burst of redraw requests used to recompose and rewrite the whole live region
 * once per request; only the last frame of a tick can ever be seen. These tests
 * pin the two properties that make collapsing safe: one paint per turn however
 * many sources ask, and teardown that stops a pending paint before it can write
 * into a closing terminal. The integration case runs the real `TuiSlots` →
 * `Screen` path the window mounts, because the collapse is only worth something
 * if it survives the actual composition.
 */

import { Context } from '@deepseek-ai/cordis'
import type { ScreenTarget } from '@dshline/renderer'
import { Screen } from '@dshline/renderer'
import { describe, expect, it } from 'vitest'
import { RedrawScheduler } from '../src/redraw.ts'
import { TuiSlots } from '../src/slots.ts'

/** One turn of the event loop — exactly where a scheduled paint runs. */
const nextTurn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

/** A target that records every chunk, so frame counts are directly assertable. */
function recordingTarget(): ScreenTarget & { readonly writes: string[] } {
  const writes: string[] = []
  return { writes, write: chunk => { writes.push(chunk) }, columns: () => 80 }
}

describe('RedrawScheduler', () => {
  it('collapses any number of requests in one turn into one paint', async () => {
    let painted = 0
    const scheduler = new RedrawScheduler(() => { painted += 1 })
    scheduler.request()
    scheduler.request()
    scheduler.request()
    // Nothing synchronous: a synchronous paint is exactly the per-request cost
    // being removed, and would make the assertion below vacuous.
    expect(painted).toBe(0)
    await nextTurn()
    expect(painted).toBe(1)
  })

  it('paints again when asked after the previous paint ran', async () => {
    let painted = 0
    const scheduler = new RedrawScheduler(() => { painted += 1 })
    scheduler.request()
    await nextTurn()
    scheduler.request()
    await nextTurn()
    expect(painted).toBe(2)
  })

  it('lets a paint queue the next turn instead of recursing', async () => {
    // A view invalidating from inside a render must step out one turn, not blow
    // the stack or spin the loop synchronously.
    let painted = 0
    const scheduler = new RedrawScheduler(() => {
      painted += 1
      if (painted < 3) scheduler.request()
    })
    scheduler.request()
    await nextTurn()
    await nextTurn()
    await nextTurn()
    expect(painted).toBe(3)
  })

  it('stop cancels the pending paint and refuses later ones', async () => {
    let painted = 0
    const scheduler = new RedrawScheduler(() => { painted += 1 })
    scheduler.request()
    scheduler.stop()
    await nextTurn()
    scheduler.request()
    await nextTurn()
    expect(painted).toBe(0)
  })
})

describe('repaint coalescing over the real composition', () => {
  it('turns an invalidation storm into one compose and one write', async () => {
    const fake = recordingTarget()
    const screen = new Screen(fake)
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    let composes = 0
    // The window's own three-step: schedule, compose, place on the screen.
    const redraws = new RedrawScheduler(() => {
      composes += 1
      const { lines, cursor } = slots.compose(80, 24)
      if (cursor === undefined) screen.setLive(lines)
      else screen.setLive(lines, cursor)
    })
    ctx.on('tui/render', () => { redraws.request() })
    slots.register('status', { render: () => ['ready'] })
    // Registration itself invalidated once; nine more feeds pile on in the
    // same turn, as capability adapters do around one session event.
    for (let index = 0; index < 9; index += 1) slots.invalidate()
    await nextTurn()
    expect(composes).toBe(1)
    expect(fake.writes).toHaveLength(1)

    // The layers stack: another invalidate with nothing changed pays one
    // composition, and the identical-frame skip reduces its output to none.
    slots.invalidate()
    await nextTurn()
    expect(composes).toBe(2)
    expect(fake.writes).toHaveLength(1)
  })
})

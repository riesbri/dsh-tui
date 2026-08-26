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
import { createEmulator } from '../../../tests/emulator.ts'
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

  it('now() paints synchronously and absorbs the pending request', async () => {
    let painted = 0
    const scheduler = new RedrawScheduler(() => { painted += 1 })
    scheduler.request()
    scheduler.now()
    // Synchronous is the point: between this line and any later commit there
    // is no gap for a wiped screen to persist through.
    expect(painted).toBe(1)
    await nextTurn()
    // The request made before now() was absorbed, not left queued behind it.
    expect(painted).toBe(1)
  })

  it('now() paints nothing once stopped', () => {
    let painted = 0
    const scheduler = new RedrawScheduler(() => { painted += 1 })
    scheduler.stop()
    scheduler.now()
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

describe('ctrl-l through the real composition', () => {
  it('leaves no gap for a commit to meet the wiped display', async () => {
    // The window's ctrl-l wiring — wipe, mark stale, one synchronous repaint —
    // over the real slot composition and Screen. The commit below stands for
    // any session event that lands in the same turn as the keypress; before
    // now() existed it ran against a wiped screen whose erase arithmetic was
    // still climbing rows only the model believed in.
    const emulator = createEmulator(40, 12)
    const screen = new Screen(emulator.target)
    const slots = new TuiSlots(new Context())
    slots.register('status', { render: () => ['ready'] })
    const redraws = new RedrawScheduler(() => {
      const { lines, cursor } = slots.compose(40, 12)
      if (cursor === undefined) screen.setLive(lines)
      else screen.setLive(lines, cursor)
    })
    redraws.now()
    await emulator.flush()
    expect(await emulator.screen()).toEqual(['ready'])

    emulator.target.write('\u001b[2J\u001b[H')
    screen.markStale()
    redraws.now()
    // Not blank at any observable instant: the repaint happened inside the
    // call, not at some later check phase.
    expect(await emulator.screen()).toEqual(['ready'])

    // A commit before any deferred flush could run.
    screen.commit(['committed after clear'])
    expect(await emulator.screen()).toEqual(['committed after clear', 'ready'])
    // The cursor belongs at the end of the live region, hidden but placed.
    const cursor = await emulator.cursor()
    expect(cursor.row).toBe(1)
    expect(cursor.column).toBe('ready'.length)

    // And nothing further stirs: there was no pending paint to absorb this
    // work twice.
    await nextTurn()
    expect(await emulator.screen()).toEqual(['committed after clear', 'ready'])
    emulator.dispose()
  })
})

describe('resize through the real composition', () => {
  it('repairs synchronously, so a same-turn commit meets re-anchored geometry', async () => {
    // The window's resize wiring over the real composition. Scrollback
    // pressure comes first: a live region at the bottom of a full viewport is
    // the shape the interface actually has when a resize arrives.
    const emulator = createEmulator(40, 12)
    let columns = 40
    let rows = 12
    const screen = new Screen(emulator.target)
    const slots = new TuiSlots(new Context())
    slots.register('status', { render: () => ['ready'] })
    let paints = 0
    const redraws = new RedrawScheduler(() => {
      paints += 1
      const { lines, cursor } = slots.compose(columns, rows)
      if (cursor === undefined) screen.setLive(lines)
      else screen.setLive(lines, cursor)
    })
    for (let index = 1; index <= 14; index += 1) {
      screen.commit([`transcript ${String(index).padStart(2, '0')}`])
    }
    redraws.now()
    await emulator.flush()

    columns = 40
    rows = 6
    emulator.resize(columns, rows)
    screen.markStale()
    redraws.now()
    // The repair already ran when the handler returned: nothing about a
    // reflowed screen may stay observable to what runs next in this turn,
    // and xterm has already moved content and cursor underneath us.
    expect(paints).toBe(2)

    // A commit lands before any deferred flush could have run.
    screen.commit(['committed line'])
    expect(await emulator.screen()).toEqual([
      'transcript 11',
      'transcript 12',
      'transcript 13',
      'transcript 14',
      'committed line',
      'ready',
    ])
    expect(await emulator.cursor()).toEqual({ column: 'ready'.length, row: 5 })

    // And nothing further stirs: the repair absorbed whatever was pending,
    // and the committed line entered scrollback exactly once.
    await nextTurn()
    expect(paints).toBe(2)
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('committed line'))).toHaveLength(1)
    emulator.dispose()
  })
})

/** A long session list must stay a live overlay, never scrollback debris. */

import { describe, expect, it } from 'vitest'
import { Screen } from '@dshline/renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createEmulator } from '../../../tests/emulator.ts'
import { NO_FILTERS } from '../src/sessions/filters.ts'
import type { ContentState, EventSearchState, SessionEntry } from '../src/sessions/model.ts'
import { createSessionsOverlay } from '../src/sessions/overlay.ts'
import { createEventsOverlay, createFilterOverlay } from '../src/sessions/panels.ts'

/** The width used by the real-terminal regression frames. */
const COLUMNS = 80

/** A fixed clock, so the frames do not depend on when the suite runs. */
const NOW = 1_800_000_000_000

/** More sessions than any terminal under test can show at once. */
const ENTRIES: SessionEntry[] = Array.from({ length: 120 }, (_unused, index) => ({
  id: `dshline-${String(index)}` as SessionId,
  title: index === 0 ? 'LIST-FIRST-SENTINEL' : index === 119 ? 'LIST-LAST-SENTINEL' : `Session ${String(index)}`,
  createdAt: NOW - index * 3_600_000,
  cwd: '/home/dev/projects/dshline',
  live: false,
  persisted: true,
  parent: undefined,
  origin: 'own',
}))

/**
 * Mount the browser over a real terminal emulator.
 * @param rows - the emulator's height.
 * @returns the emulator, the overlay, and a draw that repaints the live region.
 */
function terminal(rows: number, options: {
  readonly columns?: number
  readonly content?: ContentState
  readonly filtered?: boolean
} = {}): {
  emulator: ReturnType<typeof createEmulator>
  overlay: ReturnType<typeof createSessionsOverlay>
  draw: () => void
} {
  const columns = options.columns ?? COLUMNS
  const emulator = createEmulator(columns, rows)
  const screen = new Screen(emulator.target)
  screen.commit(['TRANSCRIPT before browser A', 'TRANSCRIPT before browser B'])
  let overlay!: ReturnType<typeof createSessionsOverlay>
  const draw = (): void => { screen.setLive(overlay.render(columns, rows)) }
  overlay = createSessionsOverlay({
    listing: () => ({ kind: 'ready', entries: ENTRIES, truncated: 0 }),
    content: () => options.content ?? { kind: 'idle' },
    filters: () => options.filtered ? { ...NO_FILTERS, age: '7d' } : NO_FILTERS,
    applyFilters: () => {},
    loadMoreContent: () => {},
    restartContentSearch: () => {},
    lineage: () => ({ kind: 'idle' }),
    requestLineage: () => {},
    events: () => ({ kind: 'idle' }),
    searchEvents: () => {},
    loadMoreEvents: () => {},
    detail: () => ({ events: 214, lastActivityAt: NOW - 600_000 }),
    requestDetail: () => {},
    search: () => {},
    currentSessionId: undefined,
    workspace: '/home/dev/projects/dshline',
    home: '/home/dev',
    now: () => NOW,
    resume: () => ({ kind: 'resume' }),
    push: () => {},
    close: () => {},
    invalidate: draw,
  })
  return { emulator, overlay, draw }
}

describe('the Sessions browser on a real terminal', () => {
  it('keeps filtered content results and their continuation inside an 80x24 frame', async () => {
    // Deliberate break: omitting the continuation row from the viewport budget
    // makes this frame wrap its bottom border into committed scrollback.
    const content: ContentState = {
      kind: 'ready',
      query: 'session',
      entries: ENTRIES.slice(0, 20),
      returned: 20,
      matched: 20,
      more: true,
      loadingMore: false,
      restart: false,
    }
    const { emulator, overlay, draw } = terminal(24, { content, filtered: true })
    overlay.handleKey({ kind: 'key', name: 'tab' })
    draw()
    overlay.handleKey({ kind: 'key', name: 'end' })
    draw()
    const visible = (await emulator.screen()).join('\n')
    const all = await emulator.scrollback()
    expect(visible).toContain('Sessions · contents · filtered')
    expect(visible).toContain('Load more…')
    expect(all.filter(line => line.includes('TRANSCRIPT before browser A'))).toHaveLength(1)
    emulator.dispose()
  })

  it.each([
    [40, 24],
    [80, 15],
  ])('uses compact content chrome at %ix%i without writing scrollback', async (columns, rows) => {
    // Deliberate break: forcing the rich content frame through either boundary
    // spends snippet/detail rows the compact policy reserves for safe closure.
    const content: ContentState = {
      kind: 'ready',
      query: 'session',
      entries: ENTRIES.slice(0, 20),
      returned: 20,
      matched: 20,
      more: true,
      loadingMore: false,
      restart: false,
    }
    const { emulator, overlay, draw } = terminal(rows, { columns, content, filtered: true })
    overlay.handleKey({ kind: 'key', name: 'tab' })
    draw()
    const visible = await emulator.screen()
    const all = await emulator.scrollback()
    expect(visible.join('\n')).toContain('esc close')
    expect(visible.join('\n')).not.toContain('LIST-FIRST-SENTINEL')
    expect(all.filter(line => line.includes('TRANSCRIPT before browser A'))).toHaveLength(1)
    emulator.dispose()
  })

  it.each([24, 15])('keeps a long listing inside a %i-row terminal', async rows => {
    const { emulator, overlay, draw } = terminal(rows)
    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)

    // Walk to the end of a listing far longer than the window.
    for (let press = 0; press < 200; press += 1) {
      overlay.handleKey({ kind: 'key', name: 'down' })
      draw()
    }

    const visible = await emulator.screen()
    const all = await emulator.scrollback()
    expect(visible.length).toBeLessThanOrEqual(rows)
    // Committed transcript rows survive the whole interaction, exactly once each:
    // an overlay may own the live region but must never rewrite scrollback.
    expect(all.filter(line => line.includes('TRANSCRIPT before browser A'))).toHaveLength(1)
    expect(all.filter(line => line.includes('TRANSCRIPT before browser B'))).toHaveLength(1)
    // And the browser itself is drawn once, in the live region, not accumulated.
    expect(all.filter(line => line.includes('Sessions'))).toHaveLength(1)
    expect(all.filter(line => line.includes('LIST-FIRST-SENTINEL'))).toHaveLength(0)
    emulator.dispose()
  })

  it('scrolls the last row into the window rather than past it', async () => {
    const { emulator, overlay, draw } = terminal(24)
    draw()
    overlay.handleKey({ kind: 'key', name: 'end' })
    draw()
    const visible = (await emulator.screen()).join('\n')
    expect(visible).toContain('LIST-LAST-SENTINEL')
    emulator.dispose()
  })

  it('keeps an ultra-compact browser out of scrollback in a four-row terminal', async () => {
    const rows = 4
    const { emulator, draw } = terminal(rows)
    draw()
    const visible = await emulator.screen()
    const all = await emulator.scrollback()
    expect(visible.length).toBeLessThanOrEqual(rows)
    expect(visible.join('\n')).toContain('esc close')
    expect(all.filter(line => line.includes('TRANSCRIPT before browser A'))).toHaveLength(1)
    emulator.dispose()
  })

  it('leaves nothing behind when it closes', async () => {
    // Closing hands the live region back to the runner's own chrome. Nothing the
    // browser drew may survive in the terminal, because none of it was committed.
    const emulator = createEmulator(COLUMNS, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT before browser A'])
    const overlay = createSessionsOverlay({
      listing: () => ({ kind: 'ready', entries: ENTRIES, truncated: 0 }),
      content: () => ({ kind: 'idle' }),
      filters: () => NO_FILTERS,
      applyFilters: () => {},
      loadMoreContent: () => {},
      restartContentSearch: () => {},
      lineage: () => ({ kind: 'idle' }),
      requestLineage: () => {},
      events: () => ({ kind: 'idle' }),
      searchEvents: () => {},
      loadMoreEvents: () => {},
      detail: () => undefined,
      requestDetail: () => {},
      search: () => {},
      currentSessionId: undefined,
      workspace: '/home/dev/projects/dshline',
      home: '/home/dev',
      now: () => NOW,
      resume: () => ({ kind: 'resume' }),
      push: () => {},
      close: () => {},
      invalidate: () => {},
    })
    screen.setLive(overlay.render(COLUMNS, 24))
    // What the runner draws once the overlay is unmounted.
    screen.setLive(['', '  composer'])
    const all = await emulator.scrollback()
    expect(all.filter(line => line.includes('LIST-FIRST-SENTINEL'))).toHaveLength(0)
    expect(all.filter(line => line.includes('Sessions'))).toHaveLength(0)
    expect(all.filter(line => line.includes('TRANSCRIPT before browser A'))).toHaveLength(1)
    expect(all.at(-1)).toContain('composer')
    emulator.dispose()
  })

  it.each([80, 40])('bounds the filter and CJK event child frames at %i columns', async columns => {
    // Deliberate break: measuring the CJK snippet in code units lets its second
    // cells wrap an extra physical row and push the bottom border down.
    const rows = 15
    const emulator = createEmulator(columns, rows)
    const screen = new Screen(emulator.target)
    screen.commit(['CHILD-TRANSCRIPT-SENTINEL'])
    const filter = createFilterOverlay({
      value: { workspace: 'current', origin: 'delegated', age: '30d' },
      workspace: '/home/dev/projects/dshline',
      apply: () => {},
      close: () => {},
      invalidate: () => {},
    })
    screen.setLive(filter.render(columns, rows))
    const filterFrame = await emulator.screen()
    expect(filterFrame.length).toBeLessThanOrEqual(rows)
    expect(filterFrame.join('\n')).toContain('Sessions · filters')

    const state: EventSearchState = {
      kind: 'ready',
      sessionId: 'dshline-one' as SessionId,
      query: '',
      hits: [{
        sessionId: 'dshline-one' as SessionId,
        seq: 42,
        type: 'assistant/审查',
        time: NOW - 60_000,
        snippet: '终端宽度审查'.repeat(30),
      }],
      more: true,
      loadingMore: false,
      restart: false,
    }
    const events = createEventsOverlay({
      target: 'dshline-one' as SessionId,
      events: () => state,
      searchEvents: () => {},
      loadMoreEvents: () => {},
      home: '/home/dev',
      now: () => NOW,
      currentSessionId: undefined,
      close: () => {},
      invalidate: () => {},
    })
    screen.setLive(events.render(columns, rows))
    const eventFrame = await emulator.screen()
    expect(eventFrame.length).toBeLessThanOrEqual(rows)
    expect(eventFrame.join('\n')).toContain('Sessions · events')
    expect(eventFrame.join('\n')).toContain('终端')
    const all = await emulator.scrollback()
    expect(all.filter(line => line.includes('CHILD-TRANSCRIPT-SENTINEL'))).toHaveLength(1)
    emulator.dispose()
  })
})

/** Tests for the Sessions browser's information hierarchy, keyboard, and states. */

import { describe, expect, it } from 'vitest'
import type { Key, KeyName } from '@riesbri/dsh-tui-renderer'
import { displayWidth, stripAnsi } from '@riesbri/dsh-tui-renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CatalogState, ContentState, SessionDetail, SessionEntry } from '../src/sessions/model.ts'
import type { ResumeRequest, SessionsOverlaySpec } from '../src/sessions/overlay.ts'
import { createSessionsOverlay } from '../src/sessions/overlay.ts'

/** Width and height of a comfortable terminal, for the normal frames. */
const COLUMNS = 90
const ROWS = 24

/** A fixed clock, so ages and notice expiry are exact. */
const NOW = 1_800_000_000_000

/**
 * One listable session.
 * @param overrides - fields to replace.
 * @returns the entry.
 */
function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'tui-one' as SessionId,
    title: 'Fix the wrap bug',
    createdAt: NOW - 7_200_000,
    cwd: '/home/dev/projects/dsh-tui',
    live: false,
    persisted: true,
    parent: undefined,
    origin: 'own',
    ...overrides,
  }
}

/** What a test overrides on the overlay's owner surfaces. */
interface Harness {
  listing?: CatalogState
  content?: ContentState
  details?: Record<string, SessionDetail>
  currentSessionId?: SessionId
  resume?: (target: SessionEntry) => ResumeRequest
  now?: () => number
}

/** An overlay under test, plus what it asked its owner for. */
interface Mounted {
  render(columns?: number, rows?: number): string[]
  press(...keys: Key[]): void
  readonly searched: string[]
  readonly detailed: SessionId[]
  readonly closed: () => boolean
  readonly resumed: SessionEntry[]
}

/**
 * Mount the browser over a fixed corpus.
 * @param harness - the corpus and authority this test wants.
 * @returns the overlay and its recorded requests.
 */
function mount(harness: Harness = {}): Mounted {
  const searched: string[] = []
  const detailed: SessionId[] = []
  const resumed: SessionEntry[] = []
  let closed = false
  const spec: SessionsOverlaySpec = {
    listing: () => harness.listing ?? { kind: 'ready', entries: [entry()], truncated: 0 },
    content: () => harness.content ?? { kind: 'idle' },
    detail: sessionId => harness.details?.[sessionId],
    requestDetail: sessionId => { detailed.push(sessionId) },
    search: text => { searched.push(text) },
    currentSessionId: harness.currentSessionId,
    home: '/home/dev',
    now: harness.now ?? ((): number => NOW),
    resume: target => {
      resumed.push(target)
      return harness.resume?.(target) ?? { kind: 'resume' }
    },
    close: () => { closed = true },
    invalidate: () => {},
  }
  const overlay = createSessionsOverlay(spec)
  return {
    render: (columns = COLUMNS, rows = ROWS) => [...overlay.render(columns, rows)],
    press: (...keys) => { for (const one of keys) overlay.handleKey(one) },
    searched,
    detailed,
    closed: () => closed,
    resumed,
  }
}

/**
 * Type one printable string into the overlay.
 * @param text - the characters, sent one at a time as the decoder would.
 * @returns the keystrokes.
 */
function typed(text: string): Key[] {
  return [...text].map(character => ({ kind: 'text', text: character }))
}

/**
 * One named keystroke.
 * @param name - the decoded key name.
 * @returns the keystroke.
 */
function key(name: KeyName): Key {
  return { kind: 'key', name }
}

/**
 * Everything the browser drew, as plain text.
 * @param view - the mounted overlay.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @returns the frame with styling removed.
 */
function screen(view: Mounted, columns = COLUMNS, rows = ROWS): string {
  return view.render(columns, rows).map(stripAnsi).join('\n')
}

/** An erase-display sequence a session log could contain, for the escaping test. */
const ERASE_DISPLAY = '\u001b[2Jafter'

describe('what the browser shows', () => {
  it('names the mode, the query, and how many sessions there are', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry(), entry({ id: 'two' as SessionId, title: 'Roadmap' })], truncated: 0 },
    })
    const drawn = screen(view)
    expect(drawn).toContain('Sessions')
    expect(drawn).toContain('2 sessions')
    expect(drawn).toContain('Fix the wrap bug')
    expect(drawn).toContain('Roadmap')
  })

  it('shows the age of every row, so the list is scannable', () => {
    expect(screen(mount())).toContain('2h ago')
  })

  it('puts the facts about ONE candidate under the selected row only', () => {
    // Repeating a workspace and an id down every row turns a scannable column of
    // titles into a wall of paths.
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId, cwd: '/home/dev/other' })],
        truncated: 0,
      },
      details: { 'tui-one': { events: 214, lastActivityAt: NOW - 600_000 } },
    })
    const drawn = screen(view)
    expect(drawn).toContain('~/projects/dsh-tui')
    expect(drawn).toContain('214 events')
    expect(drawn).toContain('last 10m ago')
    expect(drawn).toContain('tui-one')
    expect(drawn).not.toContain('~/other')
  })

  it('asks for the selected row detail exactly once, and again after a move', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry(), entry({ id: 'two' as SessionId })], truncated: 0 },
    })
    view.render()
    view.render()
    expect(view.detailed).toEqual(['tui-one'])
    view.press(key('down'))
    view.render()
    expect(view.detailed).toEqual(['tui-one', 'two'])
  })

  it('badges the session this window drives, a live one, a delegated one, and a fork', () => {
    const view = mount({
      currentSessionId: 'tui-one' as SessionId,
      listing: {
        kind: 'ready',
        entries: [
          entry({ live: true }),
          entry({ id: 'two' as SessionId, live: true }),
          entry({ id: 'three' as SessionId, origin: 'delegated', parent: 'tui-one' as SessionId }),
          entry({ id: 'four' as SessionId, parent: 'tui-one' as SessionId }),
        ],
        truncated: 0,
      },
    })
    const drawn = screen(view)
    expect(drawn).toContain('open')
    expect(drawn).toContain('live')
    expect(drawn).toContain('delegated')
    expect(drawn).toContain('fork')
  })

  it('counts the rows, the listing, and the corpus without conflating them', () => {
    // Three different numbers, and a counter that merged any two of them would
    // be lying about at least one.
    const listing: CatalogState = {
      kind: 'ready',
      entries: [entry(), entry({ id: 'two' as SessionId, title: 'Roadmap' })],
      truncated: 200,
    }
    const view = mount({ listing })
    expect(screen(view)).toContain('2 sessions · newest of 202')
    view.press(...typed('roadmap'))
    expect(screen(view)).toContain('1 of 2 · newest of 202')
  })

  it('says nothing about a bound that was not applied', () => {
    expect(screen(mount({ listing: { kind: 'ready', entries: [entry()], truncated: 0 } })))
      .not.toContain('newest of')
  })

  it('gives the badges up before the title on a narrow frame', () => {
    // The right column is metadata; the left is the only text saying which
    // session a row is. A title cut to fit `delegated · 6h ago` is a worse row.
    const wide = mount({
      listing: { kind: 'ready', entries: [entry({ origin: 'delegated', title: 'A reasonably long session title' })], truncated: 0 },
    })
    expect(screen(wide, 96, ROWS)).toContain('delegated')
    expect(screen(wide, 46, ROWS)).not.toContain('delegated')
    // The age never goes: it is what orders the list.
    expect(screen(wide, 46, ROWS)).toContain('2h ago')
  })

  it('drops whole help segments rather than cutting one in half', () => {
    const view = mount()
    const narrow = view.render(46, ROWS).map(stripAnsi).at(-1) ?? ''
    expect(narrow).not.toContain('conte\n')
    expect(narrow.trim().startsWith('tab search contents') || narrow.trim().startsWith('↵')).toBe(true)
    expect(narrow).toContain('esc close')
    // The way out is named last and surrendered last.
    const tiny = mount().render(30, ROWS).map(stripAnsi).at(-1) ?? ''
    expect(tiny).toContain('esc close')
  })

  it.each([
    [{ kind: 'unavailable' } as CatalogState, 'no session query service'],
    [{ kind: 'loading' } as CatalogState, 'Reading sessions'],
    [{ kind: 'failed', message: 'persistence unreadable' } as CatalogState, 'persistence unreadable'],
    [{ kind: 'ready', entries: [], truncated: 0 } as CatalogState, 'No sessions yet'],
  ])('has a sentence for state %# instead of an empty box', (listing, expected) => {
    const drawn = screen(mount({ listing }))
    expect(drawn).toContain(expected)
    // Nothing is selectable, so the help line must not advertise reopening.
    expect(drawn).not.toContain('reopen')
  })

  it('never lets a row escape the frame width', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry({ title: 'x'.repeat(400), cwd: `/home/dev/${'deep/'.repeat(60)}end` })],
        truncated: 0,
      },
      details: { 'tui-one': { events: 9, lastActivityAt: NOW } },
    })
    for (const row of view.render(60, ROWS)) {
      expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(60)
    }
  })

  it('never lets a wide-character title escape the frame width', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry({ title: '审查渲染器'.repeat(40) })], truncated: 0 },
    })
    for (const row of view.render(70, ROWS)) {
      expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(70)
    }
  })
})

describe('filtering, which is the default question', () => {
  it('narrows the list as characters arrive', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId, title: 'Roadmap review' })],
        truncated: 0,
      },
    })
    view.press(...typed('road'))
    const drawn = screen(view)
    expect(drawn).toContain('Roadmap review')
    expect(drawn).not.toContain('Fix the wrap bug')
    expect(drawn).toContain('1 of 2')
  })

  it('says so when a query matches nothing, rather than showing the whole list', () => {
    const view = mount()
    view.press(...typed('attachments'))
    expect(screen(view)).toContain('No session matches that')
  })

  it('deletes one character per backspace, including outside the basic plane', () => {
    const view = mount({ listing: { kind: 'ready', entries: [entry({ title: 'rocket launch' })], truncated: 0 } })
    view.press(...typed('\u{1f680}'), key('backspace'))
    // The query is empty again, so the row is back.
    expect(screen(view)).toContain('rocket launch')
  })

  it('clears the whole query with ctrl-u and one word with ctrl-w', () => {
    const view = mount({ listing: { kind: 'ready', entries: [entry({ title: 'alpha beta' })], truncated: 0 } })
    view.press(...typed('alpha zzz'))
    expect(screen(view)).toContain('No session matches')
    view.press(key('ctrl-w'))
    expect(screen(view)).toContain('alpha beta')
    view.press(...typed('zzz'))
    expect(screen(view)).toContain('No session matches')
    view.press(key('ctrl-u'))
    expect(screen(view)).toContain('alpha beta')
  })

  it('collapses a pasted paragraph into one query line', () => {
    const view = mount({ listing: { kind: 'ready', entries: [entry({ title: 'wrap bug' })], truncated: 0 } })
    view.press({ kind: 'paste', text: 'wrap\n  bug' })
    expect(screen(view)).toContain('wrap bug')
  })

  it('takes the query back on the first escape and closes on the second', () => {
    const view = mount()
    view.press(...typed('zzz'))
    expect(screen(view)).toContain('esc clear')
    view.press(key('escape'))
    expect(view.closed()).toBe(false)
    expect(screen(view)).toContain('esc close')
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })
})

describe('searching what sessions said', () => {
  it('hands the typed words to Harness on tab, and titles the frame for it', () => {
    const view = mount({ content: { kind: 'searching', query: 'cjk' } })
    view.press(...typed('cjk'), key('tab'))
    expect(view.searched).toEqual(['cjk'])
    const drawn = screen(view)
    expect(drawn).toContain('Sessions · contents')
    expect(drawn).toContain('Searching session contents')
  })

  it('shows the excerpt Harness selected, under the selected row', () => {
    const view = mount({
      content: {
        kind: 'ready',
        query: 'cjk',
        entries: [entry({ snippet: 'the parser wraps CJK at the wrong column' })],
      },
    })
    view.press(key('tab'))
    expect(screen(view)).toContain('the parser wraps CJK at the wrong column')
  })

  it('displays an escape sequence in an excerpt instead of obeying it', () => {
    // A snippet is provider-selected text out of a session log: as untrusted as
    // tool output, and able to erase the screen if it is drawn raw.
    const view = mount({
      content: { kind: 'ready', query: 'x', entries: [entry({ snippet: ERASE_DISPLAY })] },
    })
    view.press(key('tab'))
    const rows = view.render()
    expect(rows.join('\n')).not.toContain(ERASE_DISPLAY)
    expect(rows.map(stripAnsi).join('\n')).toContain('after')
  })

  it('keeps a newline in an excerpt from adding a row', () => {
    const view = mount({
      content: { kind: 'ready', query: 'x', entries: [entry({ snippet: 'first\nsecond' })] },
    })
    view.press(key('tab'))
    expect(screen(view)).toContain('first second')
  })

  it('reports an index that offers no content search as a capability, not a fault', () => {
    const view = mount({ content: { kind: 'unsupported' } })
    view.press(key('tab'))
    const drawn = screen(view)
    expect(drawn).toContain('no content search')
    expect(drawn).not.toContain('failed')
  })

  it('reports a failed search with the reason Harness gave', () => {
    const view = mount({ content: { kind: 'failed', message: 'index generation is stale' } })
    view.press(key('tab'))
    expect(screen(view)).toContain('index generation is stale')
  })

  it('drops back to filtering as soon as the query is edited', () => {
    // The results answered the PREVIOUS words. Keeping them on screen while the
    // query box says something else is the one thing a search box must not do.
    const view = mount({
      listing: { kind: 'ready', entries: [entry({ title: 'listing row' })], truncated: 0 },
      content: { kind: 'ready', query: 'cjk', entries: [entry({ id: 'hit' as SessionId, title: 'content row' })] },
    })
    view.press(...typed('cjk'), key('tab'))
    expect(screen(view)).toContain('content row')
    view.press(...typed('x'))
    const drawn = screen(view)
    expect(drawn).not.toContain('content row')
    expect(drawn).not.toContain('Sessions · contents')
  })

  it('returns to the listing on a second tab', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry({ title: 'listing row' })], truncated: 0 },
      content: { kind: 'ready', query: '', entries: [] },
    })
    view.press(key('tab'), key('tab'))
    expect(screen(view)).toContain('listing row')
  })
})

describe('choosing a session', () => {
  it('reopens the selected row and closes', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry(), entry({ id: 'two' as SessionId })], truncated: 0 },
    })
    view.render()
    view.press(key('down'), key('enter'))
    expect(view.resumed.map(target => target.id)).toEqual(['two'])
    expect(view.closed()).toBe(true)
  })

  it('keeps the browser open and says why when the owner refuses', () => {
    const view = mount({ resume: () => ({ kind: 'refused', message: 'Finish the current turn first.' }) })
    view.render()
    view.press(key('enter'))
    expect(view.closed()).toBe(false)
    expect(screen(view)).toContain('Finish the current turn first.')
  })

  it('lets a refusal expire so the list comes back', () => {
    let clock = NOW
    const view = mount({
      now: () => clock,
      resume: () => ({ kind: 'refused', message: 'Already open.' }),
    })
    view.render()
    view.press(key('enter'))
    expect(screen(view)).toContain('Already open.')
    clock += 5_000
    expect(screen(view)).not.toContain('Already open.')
  })

  it('does nothing when there is nothing to choose', () => {
    const view = mount({ listing: { kind: 'ready', entries: [], truncated: 0 } })
    view.render()
    view.press(key('enter'), key('up'), key('down'))
    expect(view.resumed).toEqual([])
    expect(view.closed()).toBe(false)
  })

  it('wraps at both ends of the list', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId }), entry({ id: 'three' as SessionId })],
        truncated: 0,
      },
    })
    view.render()
    view.press(key('up'))
    view.render()
    view.press(key('enter'))
    expect(view.resumed.map(target => target.id)).toEqual(['three'])
  })

  it('jumps to the ends with home and end', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId }), entry({ id: 'three' as SessionId })],
        truncated: 0,
      },
    })
    view.render()
    view.press(key('end'))
    view.render()
    view.press(key('enter'))
    expect(view.resumed.at(-1)?.id).toBe('three')
  })

  it('closes on ctrl-c without reopening anything', () => {
    const view = mount()
    view.press(key('ctrl-c'))
    expect(view.closed()).toBe(true)
    expect(view.resumed).toEqual([])
  })
})

describe('a terminal too small for the frame', () => {
  /** Enough rows to make the list scroll rather than fit. */
  const many: SessionEntry[] = Array.from({ length: 40 }, (_unused, index) =>
    entry({ id: `s-${String(index)}` as SessionId, title: `Session ${String(index)}` }))

  it('stays inside a short terminal and keeps the way out', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    for (const rows of [24, 15, 8, 5, 3, 1]) {
      const drawn = view.render(COLUMNS, rows)
      expect(drawn.length, `rows=${String(rows)}`).toBeLessThanOrEqual(rows)
      expect(drawn.map(stripAnsi).join('\n'), `rows=${String(rows)}`).toContain('esc')
    }
  })

  it('falls back on a narrow terminal rather than colliding title and age', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    const drawn = view.render(20, ROWS).map(stripAnsi)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toContain('esc close')
  })

  it('keeps a refusal visible even in the compact fallback', () => {
    // A declined action must not look ignored because the window is small.
    const view = mount({ resume: () => ({ kind: 'refused', message: 'Already live in this process.' }) })
    view.render()
    view.press(key('enter'))
    expect(screen(view, 20, 2)).toContain('Already live')
  })

  it('scrolls the selection into view instead of drawing past the window', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    view.render(COLUMNS, 12)
    view.press(key('end'))
    const drawn = view.render(COLUMNS, 12)
    expect(drawn.length).toBeLessThanOrEqual(12)
    expect(drawn.map(stripAnsi).join('\n')).toContain('Session 39')
    expect(drawn.map(stripAnsi).join('\n')).not.toContain('Session 0 ')
  })

  it('says when rows are hidden below the window', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    expect(screen(view, COLUMNS, 12)).toContain('more below')
  })
})

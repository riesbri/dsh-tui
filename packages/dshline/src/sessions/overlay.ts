/**
 * The Sessions browser: a bounded, keyboard-first list over the Harness corpus.
 *
 * It is an overlay and not a screen. Finished transcript rows stay in the
 * terminal's own scrollback while this is open, and closing it leaves them
 * untouched — the same rule the tool inspector, Work, and Todos follow, and the
 * reason none of them can become a full-screen browser.
 *
 * The interaction is search-first, because a corpus is not a menu. Typing
 * filters immediately over what a row SHOWS — title, workspace, id — and `tab`
 * hands the same words to Harness's full-text surface to search what sessions
 * SAID. Those are different questions with very different costs, so they are
 * different gestures rather than one box that silently changes meaning.
 * @module dshline/sessions/overlay
 */

import type { Key } from 'dshline-renderer'
import {
  BOX_CHROME_COLUMNS,
  box,
  displayWidth,
  escapeControls,
  style,
  truncateToWidth,
  wrapToWidth,
} from 'dshline-renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { chromeWidth } from '../views.ts'
import type { CatalogState, ContentState, SessionDetail, SessionEntry, SessionSearchMode } from './model.ts'
import { filterEntries, relativeAge, sessionLabel, shortWorkspace } from './model.ts'

/** Rows outside the scrolling list: blank, two borders, query, spacer, help. */
const SESSIONS_FIXED_ROWS = 6

/**
 * Narrowest terminal that can hold the framed list.
 *
 * Wider than the other overlays ask for, because a row here carries a title AND
 * a right-hand age column: below this the two collide and the age wins over the
 * only text that identifies the session, which is the wrong trade.
 */
const SESSIONS_MIN_COLUMNS = BOX_CHROME_COLUMNS + 24

/** How long a refusal stays on screen before the list returns. */
const NOTICE_MS = 4_000

/**
 * Columns a title needs before the badges are worth their space.
 *
 * A row's right-hand column is metadata; its left is the only text that says
 * which session this is. So when the two compete, the badges go — a title cut to
 * `Sessions milestone: brows` beside `delegated · 6h ago` is a worse row than
 * the full title beside `6h ago`. The age never goes: it is what orders the list.
 */
const MIN_TITLE_COLUMNS = 24

/** The answer a resume request gets back from the owner. */
export type ResumeRequest =
  /** Accepted; the overlay closes and the owner performs the switch. */
  | { readonly kind: 'resume' }
  /** Declined, with a sentence the reader can act on. */
  | { readonly kind: 'refused'; readonly message: string }

/** What the browser needs from its owner. */
export interface SessionsOverlaySpec {
  /** The corpus listing. */
  readonly listing: () => CatalogState
  /** The optional full-text pass. */
  readonly content: () => ContentState
  /** Bounded detail already read for one session. */
  readonly detail: (sessionId: SessionId) => SessionDetail | undefined
  /** Ask for the selected row's detail. */
  readonly requestDetail: (sessionId: SessionId) => void
  /** Hand a query to Harness's full-text surface. */
  readonly search: (query: string) => void
  /** The session this window is driving, when there is one. */
  readonly currentSessionId: SessionId | undefined
  /** The user's home directory, for shortening workspace paths. */
  readonly home: string | undefined
  /** Current time, injected so ages and notices are assertable. */
  readonly now: () => number
  /** Ask the owner to reopen one session. */
  readonly resume: (entry: SessionEntry) => ResumeRequest
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after a move, an edit, or a landed read. */
  readonly invalidate: () => void
}

/** A transient message shown over the list without committing a transcript row. */
interface Notice {
  readonly text: string
  readonly expiresAt: number
}

/**
 * What the current mode and query resolve to, before any geometry is known.
 *
 * `entries` empty and `message` set is the state every non-list answer shares —
 * loading, failure, an unmounted service, an empty corpus, no match. Keeping
 * them one shape is what lets the keyboard, the counter, and the compact
 * fallback each ask one question instead of five.
 */
interface Resolved {
  readonly entries: readonly SessionEntry[]
  /** The sentence to show when there is nothing to select. */
  readonly message: string | undefined
  /** Rows before the query narrowed them, when a query did. */
  readonly listed: number
  /** The whole corpus, when the listing bound dropped part of it. */
  readonly corpus: number | undefined
}

/** Rendered rows for a resolved listing, and which row holds the selection. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
}

/**
 * Create the Sessions browser overlay.
 * @param spec - the corpus reads, the resume authority, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createSessionsOverlay(spec: SessionsOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  let mode: SessionSearchMode = 'filter'
  let query = ''
  let selected = 0
  let visible: readonly SessionEntry[] = []
  let closed = false
  let notice: Notice | undefined
  let detailed: SessionId | undefined

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): Notice | undefined => {
    if (notice !== undefined && spec.now() >= notice.expiresAt) notice = undefined
    return notice
  }
  const move = (amount: number): void => {
    if (visible.length === 0) return
    selected = (selected + amount + visible.length) % visible.length
    spec.invalidate()
  }
  const edit = (next: string): void => {
    query = next
    // Editing invalidates a content result: it answered the PREVIOUS words, and
    // a list that kept showing them while the query box said something else
    // would be the one thing a search box must never do.
    mode = 'filter'
    selected = 0
    viewport.first()
    spec.invalidate()
  }
  const toggleMode = (): void => {
    mode = mode === 'content' ? 'filter' : 'content'
    selected = 0
    viewport.first()
    if (mode === 'content') spec.search(query)
    else spec.invalidate()
  }
  const resume = (): void => {
    const entry = visible[selected]
    if (entry === undefined) return
    const answer = spec.resume(entry)
    if (answer.kind === 'resume') {
      close()
      return
    }
    notice = { text: answer.message, expiresAt: spec.now() + NOTICE_MS }
    spec.invalidate()
  }

  return {
    render(columns, terminalRows = 24) {
      const resolved = resolve(spec, mode, query)
      visible = resolved.entries
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      // Detail follows the cursor: one selected row at a time, asked for once.
      const focused = visible[selected]
      if (focused !== undefined && focused.id !== detailed) {
        detailed = focused.id
        spec.requestDetail(focused.id)
      }
      const active = currentNotice()
      if (terminalRows <= SESSIONS_FIXED_ROWS || columns < SESSIONS_MIN_COLUMNS) {
        return compactFallback(resolved, columns, terminalRows, active)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - SESSIONS_FIXED_ROWS - (active === undefined ? 0 : 1)
      if (capacity <= 0) return compactFallback(resolved, columns, terminalRows, active)
      const rendered = render(resolved, spec, mode, selected, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const frame = [
        '',
        ...box([
          queryRow(query, counter(resolved, rendered, viewport), inner),
          ...active === undefined
            ? []
            : [style(truncateToWidth(escapeControls(active.text), inner), 'red')],
          '',
          ...rendered.rows.slice(viewport.start, viewport.end),
        ], {
          width,
          title: style(mode === 'content' ? 'Sessions · contents' : 'Sessions', 'bold', 'yellow'),
          border: text => style(text, 'yellow'),
        }),
        `  ${style(help(mode, query, visible.length > 0, Math.max(1, columns - 2)), 'gray')}`,
      ]
      // A backstop, not the primary bound: every content row above is already
      // truncated to `inner`, so nothing here should wrap. `box()` WOULD wrap a
      // row that forgot to be, and a frame one row too tall pushes a line into
      // committed scrollback — a corruption no overlay is allowed to cause, and
      // one a future row is cheaper to prevent than to debug.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(resolved, columns, terminalRows, active)
    },
    handleKey(key: Key) {
      if (key.kind === 'text') {
        edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
        // A query is one line. Pasted newlines would collapse in the matcher
        // anyway, so they collapse here, where the reader can see it happen.
        edit(query + key.text.replace(/\s+/gu, ' '))
        return
      }
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
        case 'ctrl-a':
          selected = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          selected = Math.max(0, visible.length - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'backspace':
          // Code points, not UTF-16 units: one press deletes one character, an
          // emoji or an ideograph outside the basic plane included.
          edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          edit('')
          return
        case 'ctrl-w':
          edit(query.replace(/\s*\S*$/u, ''))
          return
        case 'tab':
          toggleMode()
          return
        case 'enter':
          resume()
          return
        case 'escape':
          // Two stages, and the help line says which one is armed: a typed query
          // is what a reader most often wants to take back, and spending that
          // keystroke on the whole browser costs them the listing as well.
          if (query !== '') {
            edit('')
            return
          }
          close()
          return
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
  }
}

/**
 * Resolve which entries the current mode and query produce.
 * @param spec - the overlay's owner surfaces.
 * @param mode - which corpus is being shown.
 * @param query - the current query text.
 * @returns the entries, or the sentence that stands in for them.
 */
function resolve(spec: SessionsOverlaySpec, mode: SessionSearchMode, query: string): Resolved {
  if (mode === 'content') return resolveContent(spec.content())
  const listing = spec.listing()
  switch (listing.kind) {
    case 'unavailable':
      return said('This profile mounts no session query service.')
    case 'loading':
      return said('Reading sessions…')
    case 'failed':
      return said(`Harness could not list sessions: ${listing.message}`)
    case 'ready': {
      const entries = filterEntries(listing.entries, query)
      if (entries.length === 0) return said(query === '' ? 'No sessions yet.' : 'No session matches that.')
      return {
        entries,
        message: undefined,
        listed: listing.entries.length,
        ...listing.truncated > 0 ? { corpus: listing.entries.length + listing.truncated } : { corpus: undefined },
      }
    }
  }
}

/**
 * Resolve what the full-text pass currently has to show.
 * @param content - the content-search state.
 * @returns the entries, or the sentence that stands in for them.
 */
function resolveContent(content: ContentState): Resolved {
  switch (content.kind) {
    case 'idle':
      return said('Type what a session said, then press tab to search contents.')
    case 'searching':
      return said('Searching session contents…')
    case 'unsupported':
      // A supported deployment, not a fault: full-text search is the session
      // query engine's only abstract surface, and a backend may implement none.
      return said('This deployment’s session index offers no content search.')
    case 'failed':
      return said(`Content search failed: ${content.message}`)
    case 'ready':
      return content.entries.length === 0
        ? said('Nothing in any session log matches that.')
        : { entries: content.entries, message: undefined, listed: content.entries.length, corpus: undefined }
  }
}

/**
 * A resolution that says something instead of listing anything.
 * @param text - the sentence to show.
 * @returns a resolution with no selectable entries.
 */
function said(text: string): Resolved {
  return { entries: [], message: text, listed: 0, corpus: undefined }
}

/**
 * Draw a resolution's rows at a known width.
 * @param resolved - the resolved entries or message.
 * @param spec - the overlay's owner surfaces.
 * @param mode - which corpus is being shown.
 * @param selected - the selected entry index.
 * @param inner - the frame's inner width in columns.
 * @returns the rows and the selection's row index among them.
 */
function render(
  resolved: Resolved,
  spec: SessionsOverlaySpec,
  mode: SessionSearchMode,
  selected: number,
  inner: number,
): Rendered {
  if (resolved.entries.length === 0) {
    const text = escapeControls(resolved.message ?? '')
    return { rows: [style(truncateToWidth(text, inner), 'gray')], selectedRow: 0 }
  }
  const rows: string[] = []
  let selectedRow = 0
  resolved.entries.forEach((entry, index) => {
    const active = index === selected
    if (active) selectedRow = rows.length
    rows.push(entryRow(entry, active, spec, inner))
    if (active) rows.push(...detailRows(entry, spec, mode, inner))
  })
  return { rows, selectedRow }
}

/**
 * One session as a single physical row: mark, title, badges, age.
 * @param entry - the session.
 * @param active - whether it is selected.
 * @param spec - the overlay's owner surfaces.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function entryRow(entry: SessionEntry, active: boolean, spec: SessionsOverlaySpec, inner: number): string {
  const right = rightColumn(entry, spec, inner)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 8))
  const label = truncateToWidth(
    escapeControls(sessionLabel(entry)),
    Math.max(1, inner - 2 - rightWidth - 1),
  )
  const gap = Math.max(1, inner - 2 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  if (active) return style(`❯ ${plain}`, 'cyan', 'bold')
  // An untitled row is dimmed rather than dropped: it is still resumable, and
  // dimming says "nothing named this" without inventing a name for it.
  return `  ${entry.title === undefined ? style(plain, 'dim') : plain}`
}

/**
 * The row's right-hand column: badges and an age, or an age alone when the
 * badges would cost the title more room than they are worth.
 * @param entry - the session.
 * @param spec - the overlay's owner surfaces.
 * @param inner - the frame's inner width.
 * @returns the right-aligned text.
 */
function rightColumn(entry: SessionEntry, spec: SessionsOverlaySpec, inner: number): string {
  const age = relativeAge(entry.createdAt, spec.now())
  const marks = badges(entry, spec.currentSessionId)
  if (marks.length === 0) return age
  const full = [...marks, age].join(' · ')
  return inner - 3 - displayWidth(full) >= MIN_TITLE_COLUMNS ? full : age
}

/**
 * Short words for what makes one session different from its neighbours.
 * @param entry - the session.
 * @param currentSessionId - the session this window is driving.
 * @returns the badges, in decreasing order of how much they change the reading.
 */
function badges(entry: SessionEntry, currentSessionId: SessionId | undefined): string[] {
  const marks: string[] = []
  if (entry.id === currentSessionId) marks.push('open')
  else if (entry.live) marks.push('live')
  // Delegation is reported instead of the fork lineage it also implies: a
  // subagent child always has a parent, and saying both twice tells a reader
  // nothing the first word did not.
  if (entry.origin === 'delegated') marks.push('delegated')
  else if (entry.parent !== undefined) marks.push('fork')
  return marks
}

/**
 * The indented facts shown under the selected row only.
 *
 * Under the selection rather than on every row because they are what a reader
 * consults about ONE candidate; repeating them down the list would turn a
 * scannable column of titles into a wall of paths.
 * @param entry - the selected session.
 * @param spec - the overlay's owner surfaces.
 * @param mode - which corpus is being shown.
 * @param inner - the frame's inner width.
 * @returns one or two indented rows.
 */
function detailRows(
  entry: SessionEntry,
  spec: SessionsOverlaySpec,
  mode: SessionSearchMode,
  inner: number,
): string[] {
  const rows: string[] = []
  const detail = spec.detail(entry.id)
  const facts: string[] = []
  const workspace = shortWorkspace(entry.cwd, spec.home)
  if (workspace !== undefined) facts.push(workspace)
  if (detail !== undefined) {
    facts.push(`${String(detail.events)} event${detail.events === 1 ? '' : 's'}`)
    if (detail.lastActivityAt !== undefined) {
      facts.push(`last ${relativeAge(detail.lastActivityAt, spec.now())}`)
    }
  }
  if (entry.parent !== undefined) facts.push(`from ${entry.parent}`)
  // The id is last because it is the fact a narrow frame can afford to lose:
  // it identifies the row to a machine, and the title and path identify it to
  // the reader who is choosing.
  facts.push(entry.id)
  rows.push(style(`    ${truncateToWidth(escapeControls(facts.join(' · ')), Math.max(1, inner - 4))}`, 'gray'))
  // The snippet is provider-selected text out of a session log, so it is
  // untrusted for the same reason tool output is, and is escaped before styling.
  if (mode === 'content' && entry.snippet !== undefined && entry.snippet !== '') {
    const snippet = escapeControls(entry.snippet).replaceAll('\n', ' ')
    rows.push(style(`    “${truncateToWidth(snippet, Math.max(1, inner - 7))}”`, 'dim'))
  }
  return rows
}

/**
 * The query line: a prompt, the typed text, a cursor block, and the counter.
 * @param query - the typed query.
 * @param right - the counter text.
 * @param inner - the frame's inner width.
 * @returns one row.
 */
function queryRow(query: string, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  // The tail is kept, not the head: a reader watches the characters they are
  // typing, and a long query scrolled from the left would hide them.
  const shown = truncateToWidth(escapeControls(query), room)
  const typed = displayWidth(shown) >= room ? shown : `${shown}█`
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(typed) - rightWidth)
  return `${style(prompt, 'yellow')}${typed}${' '.repeat(gap)}${style(truncateToWidth(right, rightWidth), 'gray')}`
}

/**
 * What the counter says: how many sessions, and where the window is in them.
 * @param resolved - the resolved listing.
 * @param rendered - its rows.
 * @param viewport - the scroll position over those rows.
 * @returns the counter text, empty when there is nothing to count.
 */
function counter(resolved: Resolved, rendered: Rendered, viewport: RowViewport): string {
  const shown = resolved.entries.length
  if (shown === 0) return ''
  // Three different numbers, and conflating them is how a counter starts lying:
  // how many rows a query left, how many the listing held, and how large the
  // corpus behind that listing is. Each is named only when it differs.
  const matched = shown === resolved.listed
    ? `${String(shown)} session${shown === 1 ? '' : 's'}`
    : `${String(shown)} of ${String(resolved.listed)}`
  const bound = resolved.corpus === undefined ? '' : ` · newest of ${String(resolved.corpus)}`
  // Said only when rows are actually hidden below the window, so the phrase is
  // a fact about this frame rather than a permanent decoration.
  const more = viewport.end < rendered.rows.length ? ' · more below' : ''
  return `${matched}${bound}${more}`
}

/**
 * The help line, truthful for the current mode and query.
 *
 * Whole segments are dropped rather than the line being cut, for the reason the
 * status line gives up whole segments: `tab search conte` teaches a reader
 * nothing and costs the same columns as saying less. The way out is named last
 * and surrendered last.
 * @param mode - which corpus is being shown.
 * @param query - the typed query.
 * @param selectable - whether any row can be reopened.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function help(mode: SessionSearchMode, query: string, selectable: boolean, columns: number): string {
  const leave = query === '' ? 'esc close' : 'esc clear'
  const parts = [
    ...selectable ? ['↑↓ move'] : [],
    mode === 'content' ? 'tab filter' : 'tab search contents',
    ...selectable ? ['↵ reopen'] : [],
    leave,
  ]
  // Dropped from the front, which is least-useful-first by construction above.
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' · ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(leave, columns)
}

/**
 * Count the physical rows Screen will draw for candidate live-region lines.
 * @param lines - the candidate logical lines.
 * @param columns - the terminal's width.
 * @returns the wrapped physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to hold the frame.
 *
 * A refusal takes precedence over the count: it answers something the reader
 * just did, and clipping it would make a declined action look ignored.
 * @param resolved - the resolved listing.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @param notice - a pending refusal, when there is one.
 * @returns at most `rows` lines.
 */
function compactFallback(
  resolved: Resolved,
  columns: number,
  rows: number,
  notice: Notice | undefined,
): string[] {
  if (rows <= 0) return []
  if (notice !== undefined) {
    return [style(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), 'red')]
  }
  const summary = resolved.entries.length === 0
    ? 'Sessions · esc close'
    : `${String(resolved.entries.length)} sessions · ↵ reopen · esc close`
  // On a narrow fallback, keeping the way out matters more than naming rows
  // that cannot be inspected in this geometry.
  const shown = [summary, 'esc close', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return shown === undefined ? [] : [style(shown, 'yellow', 'bold')]
}

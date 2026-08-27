/**
 * The Sessions browser: a bounded, keyboard-first list over the Harness corpus.
 * @module dshline/sessions/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { equalFilters, NO_FILTERS, type SessionFiltersValue } from './filters.ts'
import { createLineageOverlay } from './lineage-overlay.ts'
import type {
  CatalogState,
  ContentState,
  EventSearchState,
  LineageState,
  SessionDetail,
  SessionEntry,
  SessionSearchMode,
} from './model.ts'
import { filterEntries, relativeAge, sessionLabel, shortWorkspace } from './model.ts'
import {
  CHILD_CLOSE_REQUESTED,
  createEventsOverlay,
  createFilterOverlay,
  type SessionsChildOverlay,
} from './panels.ts'

/** Rows outside the scrolling list: leading blank, two borders, query, spacer. */
const SESSIONS_FIXED_ROWS = 5

/** Rows outside the inline action menu: leading blank, two borders, spacer. */
const ACTIONS_FIXED_ROWS = 4

/** Narrowest terminal that can hold a useful title-and-age session row. */
const SESSIONS_MIN_COLUMNS = BOX_CHROME_COLUMNS + 24

/** Content rows yield at this width before their snippet and metadata collide. */
const CONTENT_COMPACT_COLUMNS = 40

/** Content rows yield at this height before selected detail consumes the viewport. */
const CONTENT_COMPACT_ROWS = 15

/** How long a transient browser notice stays on screen before the list returns. */
const NOTICE_MS = 4_000

/** Columns protected for a title before optional badges are surrendered. */
const MIN_TITLE_COLUMNS = 24

/** The answer a resume request gets back from the owner. */
export type ResumeRequest =
  /** Accepted; the overlay closes and the owner performs the switch. */
  | { readonly kind: 'resume' }
  /** Declined, with a sentence the reader can act on. */
  | { readonly kind: 'refused'; readonly message: string }

/** Result of collecting and submitting one rename draft. */
export type RenameDraftOutcome =
  /** Harness accepted the rename and returned its normalized title. */
  | { readonly kind: 'renamed'; readonly title: string }
  /** The reader dismissed the child prompt without submitting a title. */
  | { readonly kind: 'cancelled' }
  /** Harness or the caller rejected the attempted rename. */
  | { readonly kind: 'failed'; readonly message: string }

/** What the browser needs from its owner. */
export interface SessionsOverlaySpec {
  /** The corpus listing. */
  readonly listing: () => CatalogState
  /** The optional full-text pass. */
  readonly content: () => ContentState
  /** The active catalog filters. */
  readonly filters: () => SessionFiltersValue
  /** Replace the active catalog filters. */
  readonly applyFilters: (filters: SessionFiltersValue) => void
  /** Append the next content-search page. */
  readonly loadMoreContent: () => void
  /** Restart the current content search without its stale cursor. */
  readonly restartContentSearch: () => void
  /** Read lineage state for one session. */
  readonly lineage: (sessionId: SessionId) => LineageState
  /** Request lineage for one session. */
  readonly requestLineage: (sessionId: SessionId) => void
  /** Read the within-session event-search state. */
  readonly events: () => EventSearchState
  /** Search events inside one session. */
  readonly searchEvents: (sessionId: SessionId, query: string) => void
  /** Append the next within-session event page. */
  readonly loadMoreEvents: () => void
  /** Bounded detail already read for one session. */
  readonly detail: (sessionId: SessionId) => SessionDetail | undefined
  /** Ask for the selected row's detail. */
  readonly requestDetail: (sessionId: SessionId) => void
  /** Hand a query to Harness's corpus full-text surface. */
  readonly search: (query: string) => void
  /** The session this window is driving, when there is one. */
  readonly currentSessionId: SessionId | undefined
  /** Effective workspace used by the `current` filter. */
  readonly workspace: string | undefined
  /** The user's home directory, for shortening workspace paths. */
  readonly home: string | undefined
  /** Current time, injected so ages and notices are assertable. */
  readonly now: () => number
  /** Ask the owner to reopen one session. */
  readonly resume: (entry: SessionEntry) => ResumeRequest
  /** Collect and submit a title for the current live session, when supported. */
  readonly renameDraft?: (focusedTitle: string | undefined) => Promise<RenameDraftOutcome>
  /** Push a child overlay onto the slot stack; the parent stays mounted beneath. */
  readonly push: (overlay: TuiOverlay) => void
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after a move, an edit, or a landed read. */
  readonly invalidate: () => void
}

/** A transient message shown over the list without entering scrollback. */
interface Notice {
  readonly text: string
  readonly expiresAt: number
}

/** One continuation row after a landed, pageable content result. */
type Trailing = { readonly kind: 'more' | 'refresh' | 'loading' }

/** The resolved corpus before terminal geometry is known. */
interface Resolved {
  readonly entries: readonly SessionEntry[]
  readonly message: string | undefined
  readonly listed: number
  readonly corpus: number | undefined
  readonly content: Extract<ContentState, { kind: 'ready' }> | undefined
}

/** Rendered rows and the physical row holding the cursor. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
}

/** One action offered for the current list focus. */
type Action =
  | { readonly kind: 'filters' | 'lineage' | 'events'; readonly label: string }
  | { readonly kind: 'rename'; readonly label: 'Rename' }

/**
 * Create the Sessions browser overlay.
 * @param spec - corpus reads, child panels, resume authority, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createSessionsOverlay(spec: SessionsOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  let mode: SessionSearchMode = 'filter'
  let submode: 'list' | 'actions' = 'list'
  let query = ''
  let selected = 0
  let actionSelected = 0
  let visible: readonly SessionEntry[] = []
  let trailing: Trailing | undefined
  let loadingFrom: number | undefined
  let loadingRevision: number | undefined
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
  const focusedEntry = (): SessionEntry | undefined => visible[selected]
  const selectableLength = (): number => visible.length + (trailing?.kind === 'more' || trailing?.kind === 'refresh' ? 1 : 0)
  const move = (amount: number): void => {
    const length = selectableLength()
    if (length === 0) return
    selected = (selected + amount + length) % length
    spec.invalidate()
  }
  const edit = (next: string): void => {
    query = next
    // A content result answers the PREVIOUS words. Editing returns to the
    // immediate title/workspace filter so the query line never labels stale rows.
    mode = 'filter'
    selected = 0
    loadingFrom = undefined
    loadingRevision = undefined
    viewport.first()
    spec.invalidate()
  }
  const toggleMode = (): void => {
    mode = mode === 'content' ? 'filter' : 'content'
    selected = 0
    loadingFrom = undefined
    loadingRevision = undefined
    viewport.first()
    if (mode === 'content') spec.search(query)
    else spec.invalidate()
  }
  const resume = (): void => {
    const entry = focusedEntry()
    if (entry === undefined) return
    const answer = spec.resume(entry)
    if (answer.kind === 'resume') {
      close()
      return
    }
    notice = { text: answer.message, expiresAt: spec.now() + NOTICE_MS }
    spec.invalidate()
  }
  const activateList = (): void => {
    if (selected === visible.length && trailing !== undefined) {
      if (trailing.kind === 'more') {
        if (loadingFrom !== undefined) return
        loadingFrom = visible.length
        const state = spec.content()
        loadingRevision = state.kind === 'ready' ? state.revision : undefined
        spec.loadMoreContent()
        spec.invalidate()
      } else if (trailing.kind === 'refresh') {
        spec.restartContentSearch()
      }
      return
    }
    resume()
  }
  const actions = (): readonly Action[] => {
    const focused = focusedEntry()
    return [
      { kind: 'filters', label: 'Filters' },
      ...focused === undefined
      ? []
      : [
          { kind: 'lineage', label: 'Lineage' } as const,
          { kind: 'events', label: 'Find in this session' } as const,
        ],
      ...focused?.id === spec.currentSessionId && spec.renameDraft !== undefined
        ? [{ kind: 'rename', label: 'Rename' } as const]
        : [],
    ]
  }
  const focusInList = (sessionId: SessionId): boolean => {
    const index = visible.findIndex(entry => entry.id === sessionId)
    if (index < 0) return false
    selected = index
    submode = 'list'
    viewport.first()
    spec.invalidate()
    return true
  }
  const pushChild = (factory: (childClose: () => void) => TuiOverlay): void => {
    let closeRequested = false
    const child = factory(() => {
      closeRequested = true
      spec.invalidate()
    })
    const wrapped: SessionsChildOverlay = {
      [CHILD_CLOSE_REQUESTED]: () => closeRequested,
      render: (columns, rows) => child.render(columns, rows),
      handleKey: key => { child.handleKey(key) },
      ...(child.mounted === undefined ? {} : { mounted: () => { child.mounted?.() } }),
      ...(child.dispose === undefined ? {} : { dispose: () => { child.dispose?.() } }),
    }
    spec.push(wrapped)
  }
  const renameFailed = (error: unknown): void => {
    // The browser may have closed while the prompt was up; a dismissed overlay
    // must not repaint a live region that has moved on.
    if (closed) return
    const reason = error instanceof Error ? error.message : String(error)
    notice = { text: `Rename failed: ${reason}`, expiresAt: spec.now() + NOTICE_MS }
    spec.invalidate()
  }
  const renamed = (outcome: RenameDraftOutcome): void => {
    if (closed) return
    if (outcome.kind === 'renamed') {
      notice = { text: `Renamed to “${outcome.title}”`, expiresAt: spec.now() + NOTICE_MS }
    } else if (outcome.kind === 'failed') {
      notice = { text: `Rename failed: ${outcome.message}`, expiresAt: spec.now() + NOTICE_MS }
    }
    spec.invalidate()
  }
  const openAction = (): void => {
    const action = actions()[actionSelected]
    if (action === undefined) return
    if (action.kind === 'filters') {
      pushChild(childClose => createFilterOverlay({
        value: spec.filters(),
        workspace: spec.workspace,
        apply: filters => {
          spec.applyFilters(filters)
          // Applying filters leaves the menu for the changed list, matching
          // rename's return-to-list behavior.
          submode = 'list'
          if (mode !== 'content') return
          // A content filter change restarts the corpus from scratch: reset the
          // overlay's pagination bookkeeping (an armed load-more index belonged
          // to the resigned chain and would land on a different row in the
          // replacement results) and restart the SAME query cursorless under
          // the new clauses, so the reader does not fall back to metadata mode
          // and need a second tab to ask the question they were asking. An
          // empty query simply stays idle.
          selected = 0
          loadingFrom = undefined
          loadingRevision = undefined
          viewport.first()
          if (query.trim() !== '') spec.search(query)
        },
        close: childClose,
        invalidate: spec.invalidate,
      }))
      return
    }
    if (action.kind === 'rename') {
      submode = 'list'
      const renameDraft = spec.renameDraft
      if (renameDraft === undefined) return
      // The focused row is the source of the prefill: it carries the currently
      // displayed authoritative folded title, even when that session came from
      // a content-search page rather than the bounded base listing.
      void renameDraft(focusedEntry()?.title).then(renamed, renameFailed)
      return
    }
    const target = focusedEntry()
    if (target === undefined) return
    if (action.kind === 'lineage') {
      pushChild(childClose => createLineageOverlay({
        target: target.id,
        lineage: spec.lineage,
        requestLineage: spec.requestLineage,
        home: spec.home,
        now: spec.now,
        focus: focusInList,
        close: childClose,
        invalidate: spec.invalidate,
      }))
      return
    }
    pushChild(childClose => createEventsOverlay({
      target: target.id,
      events: spec.events,
      searchEvents: spec.searchEvents,
      loadMoreEvents: spec.loadMoreEvents,
      now: spec.now,
      close: childClose,
      invalidate: spec.invalidate,
    }))
  }

  return {
    render(columns, terminalRows = 24) {
      const resolved = resolve(spec, mode, query)
      visible = resolved.entries
      if (loadingFrom !== undefined) {
        // The catalog's revision is the authoritative landing signal: it changes
        // when a page settles even when that page appended no visible rows, so
        // a refused or empty page cannot leave the continuation row loading.
        const pageLanded = resolved.content === undefined
          || (loadingRevision !== undefined && resolved.content.revision !== loadingRevision)
        const appended = visible.length > loadingFrom
        if (appended || pageLanded || resolved.content?.restart === true) {
          // The old Load-more index is now the first newly appended entry, so
          // the cursor naturally lands on the start of the page. A page that
          // appended no retained entries simply clamps to the last real row.
          if (appended) selected = loadingFrom
          loadingFrom = undefined
          loadingRevision = undefined
        }
      }
      trailing = contentTrailing(resolved, loadingFrom !== undefined)
      const length = selectableLength()
      selected = Math.min(selected, Math.max(0, length - 1))

      if (submode === 'actions') {
        const available = actions()
        actionSelected = Math.min(actionSelected, Math.max(0, available.length - 1))
        return renderActions(available, actionSelected, columns, terminalRows)
      }

      // Detail follows only a real session cursor; continuation rows never cause
      // an id read and cannot accidentally reopen the preceding session.
      const focused = focusedEntry()
      if (focused !== undefined && focused.id !== detailed) {
        detailed = focused.id
        spec.requestDetail(focused.id)
      }
      const active = currentNotice()
      const compactContent = mode === 'content'
        && (columns <= CONTENT_COMPACT_COLUMNS || terminalRows <= CONTENT_COMPACT_ROWS)
      if (compactContent || terminalRows <= SESSIONS_FIXED_ROWS || columns < SESSIONS_MIN_COLUMNS) {
        return compactFallback(resolved, columns, terminalRows, active)
      }
      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const capacity = terminalRows - SESSIONS_FIXED_ROWS - (active === undefined ? 0 : 1)
      if (capacity <= 0) return compactFallback(resolved, columns, terminalRows, active)
      const rendered = renderResolved(resolved, spec, mode, selected, trailing, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const count = counter(resolved, rendered, viewport)
      const filtered = !equalFilters(spec.filters(), NO_FILTERS)
      const context = mode === 'content'
        ? `Sessions · contents${filtered ? ' · filtered' : ''}`
        : `Sessions${filtered ? ' · filtered' : ''}`
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(context, 'overlay-title'),
          body: [
            queryRow(query, mode === 'content' ? `contents · ${count}` : count, inner),
            ...active === undefined
              ? []
              : [noticeLine(active.text, inner)],
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            help(mode, query, focusedEntry() !== undefined, selected === visible.length ? trailing : undefined),
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(resolved, columns, terminalRows, active)
    },
    handleKey(key: Key) {
      if (submode === 'actions') {
        if (key.kind !== 'key') return
        const available = actions()
        switch (key.name) {
          case 'up':
            actionSelected = (actionSelected - 1 + available.length) % available.length
            spec.invalidate()
            return
          case 'down':
            actionSelected = (actionSelected + 1) % available.length
            spec.invalidate()
            return
          case 'enter':
            openAction()
            return
          case 'escape':
            submode = 'list'
            spec.invalidate()
            return
          case 'ctrl-c':
            close()
            return
          default:
            return
        }
      }
      if (key.kind === 'text') {
        edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
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
          selected = Math.max(0, selectableLength() - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'backspace':
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
        case 'right':
          submode = 'actions'
          actionSelected = 0
          spec.invalidate()
          return
        case 'enter':
          activateList()
          return
        case 'escape':
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

/** Resolve the current listing or content corpus. */
function resolve(spec: SessionsOverlaySpec, mode: SessionSearchMode, query: string): Resolved {
  if (mode === 'content') return resolveContent(spec.content())
  const listing = spec.listing()
  switch (listing.kind) {
    case 'unavailable': return said('This profile mounts no session query service.')
    case 'loading': return said('Reading sessions…')
    case 'failed': return said(`Harness could not list sessions: ${listing.message}`)
    case 'ready': {
      const entries = filterEntries(listing.entries, query)
      if (entries.length === 0) return said(query === '' ? 'No sessions yet.' : 'No session matches that.')
      return {
        entries,
        message: undefined,
        listed: listing.entries.length,
        ...listing.truncated > 0 ? { corpus: listing.entries.length + listing.truncated } : { corpus: undefined },
        content: undefined,
      }
    }
  }
}

/** Resolve the optional corpus content-search state. */
function resolveContent(content: ContentState): Resolved {
  switch (content.kind) {
    case 'idle': return said('Type what a session said, then press tab to search contents.')
    case 'searching': return said('Searching session contents…')
    case 'unsupported': return said('This deployment’s session index offers no content search.')
    case 'failed': return said(`Content search failed: ${content.message}`)
    case 'ready': {
      if (content.entries.length > 0) {
        return {
          entries: content.entries,
          message: undefined,
          listed: content.entries.length,
          corpus: undefined,
          content,
        }
      }
      // Zero visible rows is not automatically "nothing matched": the backend
      // may have returned hits that the presentation-only origin filter
      // retained none of, and the opaque cursor may still lead to later pages
      // with matching-origin rows. The ready state is preserved so the
      // continuation row can stay selectable; only a search that returned
      // nothing AND has nowhere to continue says the flat no-match sentence.
      const stranded = content.returned === 0 && !content.more && !content.restart
      return {
        entries: [],
        message: stranded
          ? 'Nothing in any session log matches that.'
          : content.more || content.restart
            ? 'No returned results match the active filters yet.'
            : 'No returned results match the active filters.',
        listed: 0,
        corpus: undefined,
        content,
      }
    }
  }
}

/** Build a non-selectable resolution carrying one sentence. */
function said(text: string): Resolved {
  return { entries: [], message: text, listed: 0, corpus: undefined, content: undefined }
}

/** Decide whether a landed content result has a continuation row. */
function contentTrailing(resolved: Resolved, locallyLoading: boolean): Trailing | undefined {
  const content = resolved.content
  if (content === undefined) return undefined
  if (content.restart) return { kind: 'refresh' }
  if (content.loadingMore || locallyLoading) return { kind: 'loading' }
  return content.more ? { kind: 'more' } : undefined
}

/** Draw entries, selected detail, and an optional continuation row. */
function renderResolved(
  resolved: Resolved,
  spec: SessionsOverlaySpec,
  mode: SessionSearchMode,
  selected: number,
  trailing: Trailing | undefined,
  inner: number,
): Rendered {
  if (resolved.entries.length === 0) {
    // A zero-visible-row result can still carry a selectable continuation: the
    // message row is not a session, so Enter on the trailing row must be the
    // only activation, and the message itself never resumes.
    const rows = [paint(truncateToWidth(escapeControls(resolved.message ?? ''), inner), 'muted')]
    let selectedRow = 0
    if (trailing !== undefined) {
      const active = trailing.kind !== 'loading'
      if (active) selectedRow = rows.length
      rows.push(trailingRow(trailing, active, inner))
    }
    return { rows, selectedRow }
  }
  const rows: string[] = []
  let selectedRow = 0
  resolved.entries.forEach((entry, index) => {
    const active = index === selected
    if (active) selectedRow = rows.length
    rows.push(entryRow(entry, active, spec, inner))
    if (active) rows.push(...detailRows(entry, spec, mode, inner))
  })
  if (trailing !== undefined) {
    const active = selected === resolved.entries.length && trailing.kind !== 'loading'
    if (active) selectedRow = rows.length
    rows.push(trailingRow(trailing, active, inner))
  }
  return { rows, selectedRow }
}

/** Draw one session row with title and right-aligned metadata. */
function entryRow(entry: SessionEntry, active: boolean, spec: SessionsOverlaySpec, inner: number): string {
  const right = rightColumn(entry, spec, inner)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 8))
  const label = truncateToWidth(escapeControls(sessionLabel(entry)), Math.max(1, inner - 3 - rightWidth))
  const gap = Math.max(1, inner - 2 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  if (active) return paint(`❯ ${plain}`, 'selection')
  return `  ${entry.title === undefined ? paint(plain, 'subdued') : plain}`
}

/** Choose badges plus age only while a useful title still fits. */
function rightColumn(entry: SessionEntry, spec: SessionsOverlaySpec, inner: number): string {
  const age = relativeAge(entry.createdAt, spec.now())
  const marks = badges(entry, spec.currentSessionId)
  if (marks.length === 0) return age
  const full = [...marks, age].join(' · ')
  return inner - 3 - displayWidth(full) >= MIN_TITLE_COLUMNS ? full : age
}

/** Short badges describing a session's relationship to this window. */
function badges(entry: SessionEntry, currentSessionId: SessionId | undefined): string[] {
  const marks: string[] = []
  if (entry.id === currentSessionId) marks.push('open')
  else if (entry.live) marks.push('live')
  if (entry.origin === 'delegated') marks.push('delegated')
  else if (entry.parent !== undefined) marks.push('fork')
  return marks
}

/** Draw the selected row's bounded detail and optional content snippet. */
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
    if (detail.lastActivityAt !== undefined) facts.push(`last ${relativeAge(detail.lastActivityAt, spec.now())}`)
  }
  if (entry.parent !== undefined) facts.push(`from ${entry.parent}`)
  facts.push(entry.id)
  rows.push(paint(`    ${truncateToWidth(escapeControls(facts.join(' · ')), Math.max(1, inner - 4))}`, 'muted'))
  if (mode === 'content' && entry.snippet !== undefined && entry.snippet !== '') {
    const snippet = escapeControls(entry.snippet).replaceAll('\n', ' ')
    rows.push(paint(`    “${truncateToWidth(snippet, Math.max(1, inner - 7))}”`, 'subdued'))
  }
  return rows
}

/** Draw a selectable or dimmed content continuation row. */
function trailingRow(trailing: Trailing, active: boolean, inner: number): string {
  const label = trailing.kind === 'more'
    ? 'Load more…'
    : trailing.kind === 'refresh' ? 'Refresh (results changed)' : 'Loading more…'
  const row = `${active ? '❯' : ' '} ${truncateToWidth(label, Math.max(1, inner - 2))}`
  return paint(row, active ? 'selection' : trailing.kind === 'loading' ? 'subdued' : 'muted')
}

/** Draw the query line with its cursor and honest right-hand count. */
function queryRow(query: string, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  const shown = truncateToWidth(escapeControls(query), room)
  const typed = displayWidth(shown) >= room ? shown : `${shown}█`
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(typed) - rightWidth)
  return `${paint(prompt, 'prompt-mark')}${typed}${' '.repeat(gap)}${paint(truncateToWidth(right, rightWidth), 'muted')}`
}

/** Draw the inline action menu inside the parent overlay. */
function renderActions(actions: readonly Action[], selected: number, columns: number, terminalRows: number): string[] {
  if (terminalRows <= ACTIONS_FIXED_ROWS || columns < SESSIONS_MIN_COLUMNS) {
    return compactActions(columns, terminalRows)
  }
  const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
  const rows = actions.map((action, index) => {
    const label = truncateToWidth(action.label, Math.max(1, inner - 2))
    return index === selected ? paint(`❯ ${label}`, 'selection') : `  ${label}`
  })
  const frame = [
    '',
    ...rootFrame({
      columns,
      context: paint('Sessions · actions', 'overlay-title'),
      body: ['', ...rows],
      footer: fitFooterHelp('↑↓ move · ↵ open · esc back', footerBudget(columns)),
    }),
  ]
  return physicalRows(frame, columns).length <= terminalRows ? frame : compactActions(columns, terminalRows)
}

/** Count sessions and continuation facts without inventing page numbers. */
function counter(resolved: Resolved, rendered: Rendered, viewport: RowViewport): string {
  const content = resolved.content
  let count: string
  if (content !== undefined) {
    count = content.matched < content.returned
      ? `${String(content.matched)} of ${String(content.returned)} matched`
      : `${String(content.returned)} result${content.returned === 1 ? '' : 's'}`
    count += content.more ? ' · more available' : ' · end'
    if (content.loadingMore) count += ' · loading more'
  } else {
    const shown = resolved.entries.length
    if (shown === 0) return ''
    count = shown === resolved.listed
      ? `${String(shown)} session${shown === 1 ? '' : 's'}`
      : `${String(shown)} of ${String(resolved.listed)}`
    if (resolved.corpus !== undefined) count += ` · newest of ${String(resolved.corpus)}`
  }
  if (viewport.end < rendered.rows.length) count += ' · more below'
  return count
}

/** Choose whole help segments for the current list state. */
function help(
  mode: SessionSearchMode,
  query: string,
  resumable: boolean,
  selectedTrailing: Trailing | undefined,
): string {
  const action = selectedTrailing?.kind === 'more'
    ? '↵ load more'
    : selectedTrailing?.kind === 'refresh' ? '↵ refresh' : resumable ? '↵ reopen' : undefined
  return [
    ...selectableHelp(resumable || action !== undefined),
    mode === 'content' ? 'tab filter' : 'tab search contents',
    ...action === undefined ? [] : [action],
    '→ actions',
    query === '' ? 'esc close' : 'esc clear',
  ].join(' · ')
}

/** Include movement help only while the cursor has somewhere to move. */
function selectableHelp(selectable: boolean): string[] {
  return selectable ? ['↑↓ move'] : []
}

/** Count physical terminal rows for a candidate frame. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * One Notice as a single physical row.
 *
 * A notice's text is untrusted, and it can contain newlines (a Harness error
 * message). A newline would let `Screen` expand one logical row into several,
 * overflowing a short terminal, so lines are flattened after escaping, before
 * styling and truncation.
 * @param text - the notice text.
 * @param inner - the frame's inner width, or the terminal width in fallback.
 * @returns one fitted error row.
 */
function noticeLine(text: string, inner: number): string {
  const flat = escapeControls(text).replaceAll('\n', ' ')
  return paint(truncateToWidth(flat, Math.max(1, inner)), 'error')
}

/** Give a tiny terminal one safe, closable Sessions summary. */
function compactFallback(
  resolved: Resolved,
  columns: number,
  rows: number,
  notice: Notice | undefined,
): string[] {
  if (rows <= 0) return []
  if (notice !== undefined) {
    return [noticeLine(notice.text, Math.max(1, columns))]
  }
  const summary = resolved.entries.length === 0
    ? 'Sessions · esc close'
    : `${String(resolved.entries.length)} sessions · ↵ reopen · esc close`
  const shown = [summary, 'esc close', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return shown === undefined ? [] : [paint(shown, 'overlay-headline')]
}

/** Give a tiny terminal one safe action-menu summary. */
function compactActions(columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const shown = ['Actions · esc back', 'esc back', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return shown === undefined ? [] : [paint(shown, 'overlay-headline')]
}

/**
 * The `ctrl-r` history-search surface.
 *
 * An overlay rather than a slot view, unlike completion: a search owns the
 * keyboard while it is up — every printable character is query text, and `↑`
 * and `↓` walk results rather than the composer's own rows — so the ownership
 * the registry already models is exactly right. It also means the composer
 * underneath is never written to while searching, which is what makes `esc`
 * restore the draft AND its cursor for free: there is nothing to restore,
 * because nothing was taken.
 *
 * Everything drawn here is submitted input, so it is untrusted terminal text:
 * escaped before it is measured, measured in display columns, and bounded to
 * the live region by a viewport, exactly as the shared picker is.
 * @module dshline/history-search-overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  tailToWidth,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import type { HistorySearch } from './history-search.ts'
import { RowViewport } from './scroll.ts'
import type { TuiOverlay } from './slots.ts'

/** Rows outside the query box and the scrolling result list: the blank and two borders. */
const SEARCH_FIXED_ROWS = 3

/** Rows the heading spends: the query row, and the blank separating it from the results. */
const SEARCH_HEADING_ROWS = 2

/** Narrowest terminal that can hold the framed search rather than the bare answer. */
const SEARCH_MIN_COLUMNS = BOX_CHROME_COLUMNS + 16

/** Columns each result row spends on its marker, leaving the rest for the entry. */
const ROW_MARK_COLUMNS = 2

/**
 * Logical lines of a multiline entry the SELECTED result shows.
 *
 * Enough to recognise a prompt whose first line is a greeting and whose subject
 * is on the second, and small enough that a screenful of results does not become
 * one result: the list is how a reader finds a line, not how they read it back.
 */
const SELECTED_PREVIEW_LINES = 3

/** Columns of context kept after a hit when a long line is windowed around it. */
const TRAIL_COLUMNS = 12

/** Marks the row the reader is aimed at, as every other list in this frontend does. */
const CURSOR = '❯'

/** Introduces a continuation line of the selected multiline result. */
const CONTINUATION = '↳'

/** Stands in for the part of a long line a window cut away. */
const ELLIPSIS = '…'

/** What the search overlay renders and how it reports its answer. */
export interface HistorySearchSpec {
  /** The live search model: query, matches, and selection. */
  readonly search: HistorySearch
  /**
   * Whether this session's history is still being seeded from its durable log.
   *
   * Read fresh on every render rather than captured, because the honest answer
   * changes underneath an open overlay: `ctrl-r` pressed during a resume must
   * say the history is still arriving instead of claiming there is none, and
   * must then resolve the query the reader typed meanwhile without a poll.
   * @returns whether more entries are still expected.
   */
  loading?(): boolean
  /**
   * Report the answer, exactly once.
   * @param index - the chosen historical position, or undefined on cancellation.
   */
  settle(index: number | undefined): void
  /** Asks the runner to redraw after a query edit or a selection move. */
  invalidate(): void
}

/** One result's preview line, split around the hit so it can be painted unnested. */
interface Excerpt {
  /** Text before the hit, already windowed to fit. */
  readonly before: string
  /** The matched text itself, empty when the query did not match this line. */
  readonly hit: string
  /** Text after the hit, already windowed to fit. */
  readonly after: string
}

/** Rendered result rows, and where the selection sits among them. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
  /**
   * Rows the selection occupies, which is more than one when it expanded a
   * multiline entry. Followed as a block by the viewport, for the reason
   * `select.ts` follows a selected choice and its description together: the
   * rows that appear and disappear as the cursor moves are exactly the ones
   * that must not be scrolled away while they are being read.
   */
  readonly selectedHeight: number
}

/**
 * Build the history-search overlay.
 * @param spec - the search model, the loading probe, and how to settle.
 * @returns the overlay to push onto the slot registry.
 */
export function createHistorySearchOverlay(spec: HistorySearchSpec): TuiOverlay {
  const viewport = new RowViewport()
  let settled = false
  const settle = (index: number | undefined): void => {
    // A keystroke can arrive between the decision and the unmount, so settling
    // is once-only — the same guard the shared picker keeps.
    if (settled) return
    settled = true
    spec.settle(index)
  }
  /**
   * Take on history the resume seeded, before rendering or acting on the list.
   *
   * Called from both halves on purpose: key delivery can reach `enter` before an
   * invalidation has produced a frame, and confirming against a stale match set
   * would recall an entry the reader was never shown.
   * @returns whether the corpus grew.
   */
  const sync = (): boolean => spec.search.sync()

  return {
    render(columns, terminalRows = 24) {
      sync()
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - SEARCH_FIXED_ROWS - SEARCH_HEADING_ROWS
      if (capacity <= 0 || columns < SEARCH_MIN_COLUMNS) {
        return compactFallback(spec.search, columns, terminalRows)
      }
      const rendered = renderResults(spec.search, spec.loading?.() === true, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      // Follow the whole selected block, but never past its own first row: on a
      // window too short to hold an expanded result, the row that IDENTIFIES it
      // wins over the rows that explain it, as the shared picker's label wins
      // over its description.
      const overshoot = rendered.selectedRow + rendered.selectedHeight - viewport.end
      if (overshoot > 0) viewport.move(Math.min(overshoot, rendered.selectedRow - viewport.start))
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(counter(spec.search), 'overlay-title'),
          body: [
            queryRow(spec.search.query, inner),
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(help(spec.search.matches.length > 0), footerBudget(columns)),
        }),
      ]
      // A backstop rather than the bound: every row above is already truncated to
      // `inner`, and the root frame would WRAP one that forgot to be — which is
      // how a live region grows past the screen and starts rewriting committed
      // scrollback. Checked rather than assumed, exactly as `select.ts` checks it.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(spec.search, columns, terminalRows)
    },
    handleKey(key: Key) {
      sync()
      const { search } = spec
      if (key.kind === 'text') {
        search.append(key.text)
        spec.invalidate()
        return
      }
      if (key.kind === 'paste') {
        // A query is one line. Pasted newlines would be meaningless in a literal
        // substring match against a single logical line anyway, so they collapse
        // here, where the reader can see it happen.
        search.append(key.text.replace(/\s+/gu, ' '))
        spec.invalidate()
        return
      }
      switch (key.name) {
        // `ctrl-r` again is the readline gesture for "the next older one", and
        // costs nothing: the corpus is already snapshotted and folded, so this
        // moves an index and reads no persistence.
        case 'ctrl-r':
        case 'down':
          if (search.older()) spec.invalidate()
          return
        case 'up':
          if (search.newer()) spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          if (search.first()) spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          if (search.last()) spec.invalidate()
          return
        case 'backspace':
          search.backspace()
          spec.invalidate()
          return
        case 'ctrl-u':
          search.clear()
          spec.invalidate()
          return
        case 'ctrl-w':
          search.deleteWord()
          spec.invalidate()
          return
        case 'enter': {
          // Recall, never send. A search result is a line to edit and then
          // decide about; submitting it on the same keystroke that found it
          // would make a typo in the query an executed command.
          const chosen = search.selected
          if (chosen === undefined) return
          settle(chosen)
          return
        }
        case 'escape':
          // One stage, not the shared picker's two. A picker's query is the
          // only way back to the rows it hid, so taking it back is worth a
          // keystroke; here the rows are the whole history and `ctrl-u` already
          // clears the query, so spending `esc` on it would leave a reader who
          // wants out pressing it twice.
          settle(undefined)
          return
        case 'ctrl-c':
          // Cancels the SEARCH, not the turn underneath it. While an overlay owns
          // input, `ctrl-c` is that overlay's business — a running model turn is
          // interrupted by the press that follows, once this is gone.
          settle(undefined)
          return
        default:
          // `tab` included: there is no second mode here to switch into, and
          // `ctrl-d` never reaches an overlay — the window reads it first.
          return
      }
    },
  }
}

/**
 * The right-hand label: where the selection sits among the matches.
 * @param search - the live search.
 * @returns the label for the frame's right title.
 */
function counter(search: HistorySearch): string {
  if (search.matches.length === 0) return 'History'
  return `History ${String(search.position)}/${String(search.matches.length)}`
}

/**
 * The query line: a prompt mark, the typed text, and a cursor block.
 *
 * The cursor is drawn as a block rather than placed with the terminal's own
 * cursor, because an overlay contributes no cursor placement at all — text
 * entry belongs to the composer, which is not on screen while this is up.
 * @param query - the typed query, unescaped.
 * @param inner - the frame's inner width.
 * @returns one row, fitted to `inner`.
 */
function queryRow(query: string, inner: number): string {
  const prompt = '⌕ '
  // The TAIL, so a long query scrolls from the left and what is being typed
  // stays in view; one column is held back for the block.
  const room = Math.max(1, inner - displayWidth(prompt) - 1)
  const typed = `${tailToWidth(escapeControls(query), room)}█`
  return `${paint(prompt, 'prompt-mark')}${typed}`
}

/**
 * Draw the matching entries at a known width.
 * @param search - the live search.
 * @param loading - whether more history is still being seeded.
 * @param inner - the frame's inner width.
 * @returns the rows and where the selection sits among them.
 */
function renderResults(search: HistorySearch, loading: boolean, inner: number): Rendered {
  if (search.matches.length === 0) {
    return { rows: [paint(truncateToWidth(emptyNote(search, loading), inner), 'muted')], selectedRow: 0, selectedHeight: 1 }
  }
  const rows: string[] = []
  let selectedRow = 0
  let selectedHeight = 1
  const budget = Math.max(1, inner - ROW_MARK_COLUMNS)
  search.matches.forEach((index, rank) => {
    // By RANK, not by text: two non-adjacent submissions of the same line are
    // two results, and the reader is aimed at exactly one of them.
    const selected = rank === search.position - 1
    const lines = escapeControls(search.entry(index) ?? '').split('\n')
    const anchor = anchorLine(lines, search.query)
    if (!selected) {
      rows.push(`  ${paintExcerpt(excerpt(lines[anchor] ?? '', search.query, budget), false)}`)
      return
    }
    selectedRow = rows.length
    rows.push(`${paint(`${CURSOR} `, 'selection-mark')}${paintExcerpt(excerpt(lines[anchor] ?? '', search.query, budget), true)}`)
    // Following logical lines only: a prompt is read downwards, and showing the
    // lines BEFORE the anchor would push the line that actually matched off the
    // preview the reader asked for by typing the query.
    const shown = lines.slice(anchor + 1, anchor + SELECTED_PREVIEW_LINES)
    for (const line of shown) {
      rows.push(`  ${paint(truncateToWidth(`${CONTINUATION} ${line}`, budget), 'subdued')}`)
    }
    const remaining = lines.length - (anchor + 1 + shown.length)
    if (remaining > 0) {
      rows.push(`  ${paint(truncateToWidth(`${CONTINUATION} ${ELLIPSIS} ${String(remaining)} more lines`, budget), 'muted')}`)
    }
    selectedHeight = rows.length - selectedRow
  })
  return { rows, selectedRow, selectedHeight }
}

/**
 * What an empty result list says, which is not always "nothing matched".
 *
 * A resumed session seeds its history from the log the replay is still reading,
 * so an overlay opened during that has an EMPTY corpus rather than a corpus
 * without the query in it. Reporting the first as the second is a lie the reader
 * would act on, by retyping a query that was going to work in a moment.
 * @param search - the live search.
 * @param loading - whether more history is still being seeded.
 * @returns the note to draw in place of results.
 */
function emptyNote(search: HistorySearch, loading: boolean): string {
  if (loading) return 'Loading this session’s history…'
  if (search.corpusSize === 0) return 'Nothing has been sent in this session yet.'
  return 'No input matches that.'
}

/**
 * The first logical line containing the query, or the first line when none does.
 *
 * Orienting the preview here is what keeps a long multiline prompt from looking
 * like it matched for no reason: the row a reader is shown is the row that
 * explains why the row is there at all.
 * @param lines - the entry's logical lines, already escaped.
 * @param query - the typed query.
 * @returns the index of the line to preview.
 */
function anchorLine(lines: readonly string[], query: string): number {
  if (query === '') return 0
  const needle = escapeControls(query).toLowerCase()
  const found = lines.findIndex(line => line.toLowerCase().includes(needle))
  return found < 0 ? 0 : found
}

/**
 * Window one preview line around its hit, so a match is always visible.
 *
 * A line wider than the row is cut, and cutting from the left alone hides
 * exactly the text the query named when the match is late in a long line. The
 * leading context is dropped instead, marked with an ellipsis so the reader can
 * see that the row starts mid-line.
 * @param line - one logical line of an entry, already escaped.
 * @param query - the typed query.
 * @param columns - display columns the row may spend.
 * @returns the row's three paintable segments.
 */
function excerpt(line: string, query: string, columns: number): Excerpt {
  const budget = Math.max(1, columns)
  const needle = escapeControls(query)
  const at = needle === '' ? -1 : line.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return { before: truncateToWidth(line, budget), hit: '', after: '' }
  const head = line.slice(0, at)
  const hit = line.slice(at, at + needle.length)
  const tail = line.slice(at + needle.length)
  if (displayWidth(line) <= budget) return { before: head, hit, after: tail }
  const hitRoom = Math.min(displayWidth(hit), budget)
  const headRoom = Math.max(0, budget - hitRoom - Math.min(displayWidth(tail), TRAIL_COLUMNS))
  const before = displayWidth(head) <= headRoom
    ? head
    // One column for the ellipsis, and the TAIL of the head, so the context
    // kept is the context immediately before the hit.
    : `${ELLIPSIS}${tailToWidth(head, Math.max(0, headRoom - 1))}`
  const kept = displayWidth(before) + hitRoom
  return {
    before,
    hit: truncateToWidth(hit, hitRoom),
    after: truncateToWidth(tail, Math.max(0, budget - kept)),
  }
}

/**
 * Paint one preview row's segments side by side, never nested.
 *
 * Three sibling `paint` calls rather than a highlight inside a styled row:
 * nesting would have the inner reset close the outer styling and leak colour
 * into whatever is drawn next.
 * @param parts - the row's segments.
 * @param selected - whether this row is the one the reader is aimed at.
 * @returns the painted row, without its leading marker.
 */
function paintExcerpt(parts: Excerpt, selected: boolean): string {
  const plain = (text: string): string => selected ? paint(text, 'selection') : text
  const marked = (text: string): string => selected ? paint(text, 'selection', 'strong') : paint(text, 'strong')
  return [
    parts.before === '' ? '' : plain(parts.before),
    parts.hit === '' ? '' : marked(parts.hit),
    parts.after === '' ? '' : plain(parts.after),
  ].join('')
}

/**
 * The help line, naming what the keys do in the order they are given up.
 *
 * The way out is named last and surrendered last, by the rule the rest of this
 * frontend's chrome follows: it is the only thing here a reader cannot guess.
 * @param selectable - whether any result can be recalled.
 * @returns the help text, before it is fitted.
 */
function help(selectable: boolean): string {
  const parts = [
    'type to search',
    ...selectable ? ['ctrl-r/↓ older', '↑ newer', '↵ recall'] : [],
    'esc cancel',
  ]
  return parts.join(' · ')
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
 * A usable search for a terminal too small to hold the frame.
 *
 * The SELECTED entry is kept rather than a count, for the reason the shared
 * picker keeps its selected choice: a reader who cannot see what `enter` would
 * recall cannot decide whether to press it.
 * @param search - the live search.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most `rows` lines.
 */
function compactFallback(search: HistorySearch, columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const width = Math.max(1, columns)
  const selected = search.selectedText
  const shown = selected === undefined
    ? `${ELLIPSIS} no match`
    // One line only: the fallback exists because there is no room, and a
    // multiline entry must not become several rows of a budget already spent.
    : escapeControls(selected).split('\n')[0] ?? ''
  const lines = [paint(truncateToWidth(`${CURSOR} ${shown}`, width), 'selection')]
  if (rows > 1) {
    const query = `⌕ ${escapeControls(search.query)}█`
    lines.push(paint(truncateToWidth(query, width), 'muted'))
  }
  if (rows > 2) {
    const hint = ['ctrl-r older · ↵ recall · esc', '↵ recall · esc', 'esc']
      .find(candidate => displayWidth(candidate) <= width)
    if (hint !== undefined) lines.push(paint(hint, 'muted'))
  }
  return lines.slice(0, rows)
}

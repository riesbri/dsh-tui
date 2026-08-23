/**
 * The `/plugins` browser: the running agent's Harness preset composition.
 *
 * A bounded overlay, like Connect, Sessions, Work, and Todos: the committed
 * transcript under it is never rewritten, and closing it leaves the terminal
 * exactly as it was. One list, not two sections like Connect — a
 * composition is already one flat, ordered thing once nested groups are
 * flattened by `composition.ts`, so splitting it into categories here would
 * be inventing a grouping Harness's own file does not draw.
 *
 * Everything a keystroke here can do is decided by `model.ts` and carried
 * out by `actions.ts`; this module only draws the state it is handed and
 * reports the intent — `toggle`, `pickPreset`, `makeDefault` — back to its
 * owner (`index.ts`), the same division `connect/overlay.ts` keeps between
 * drawing a row and deciding what pressing something on it means.
 * @module dshline/plugins/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  box,
  displayWidth,
  escapeControls,
  style,
  tailToWidth,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { chromeWidth } from '../views.ts'
import type { CompositionRow } from './composition.ts'
import type { PluginsState } from './catalog.ts'
import { compositionRowFacts, filterCompositionRows, rowMark } from './model.ts'

/** Rows outside the scrolling list: blank, two borders, header, query, spacer, help. */
const PLUGINS_FIXED_ROWS = 7

/** Narrowest terminal that can hold the framed list. */
const PLUGINS_MIN_COLUMNS = BOX_CHROME_COLUMNS + 28

/** Columns a name needs before the right-hand facts are worth their space. */
const MIN_NAME_COLUMNS = 18

/** How long a result stays on screen before the list returns. */
const NOTICE_MS = 5_000

/** What the browser needs from its owner. */
export interface PluginsOverlaySpec {
  /** The current reading of Harness's preset roster and composition. */
  readonly state: () => PluginsState
  /** Re-read every surface. */
  readonly refresh: () => void
  /** Enable or disable the selected row. */
  readonly toggle: (row: CompositionRow) => void
  /** Open the agent-preset picker. */
  readonly pickPreset: () => void
  /** Make the browsed preset the default for new sessions. */
  readonly makeDefault: () => void
  /** Current time, injected so notice expiry is assertable. */
  readonly now: () => number
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after a move, an edit, or a landed read. */
  readonly invalidate: () => void
}

/** A transient message shown over the list without committing a transcript row. */
interface Notice {
  readonly text: string
  readonly failed: boolean
  readonly expiresAt: number
}

/** The drawn rows, and where the selected row landed among them. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
}

/** The Plugins overlay, plus the one thing its owner pushes back into it. */
export interface PluginsOverlay extends TuiOverlay {
  /**
   * Show a result over the list.
   * @param text - the sentence to show.
   * @param failed - whether it reports a refusal.
   */
  report(text: string, failed: boolean): void
}

/**
 * Create the `/plugins` browser overlay.
 * @param spec - the reading, the action intents, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createPluginsOverlay(spec: PluginsOverlaySpec): PluginsOverlay {
  const viewport = new RowViewport()
  let query = ''
  let selected = 0
  let visible: readonly CompositionRow[] = []
  let closed = false
  let notice: Notice | undefined
  // Search is entered explicitly with `/`, unlike every other dshline picker's
  // always-on type-to-filter: `space`, `p`, and `d` are single-key actions
  // here, and a composition row's own id or package name routinely contains
  // all three ("tool-pwsh", "cordis", "delegation") — always-on filtering
  // would make typing a search term indistinguishable from firing a shortcut
  // mid-word. Outside search mode those three keys act; every other typed
  // character is inert. Once `/` is pressed, all text (space included) edits
  // the query until `enter` or `esc` leaves search mode again — the query
  // itself, and the filter it applies, are kept either way.
  let searching = false

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
    selected = 0
    viewport.first()
    spec.invalidate()
  }

  return {
    report(text, failed) {
      notice = { text, failed, expiresAt: spec.now() + NOTICE_MS }
      spec.invalidate()
    },
    render(columns, terminalRows = 24) {
      const state = spec.state()
      visible = state.kind === 'ready' && state.browsing.kind === 'rows'
        ? filterCompositionRows(state.browsing.tree.rows, query)
        : []
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      const active = currentNotice()
      if (terminalRows <= PLUGINS_FIXED_ROWS || columns < PLUGINS_MIN_COLUMNS) {
        return compactFallback(state, visible.length, columns, terminalRows, active)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - PLUGINS_FIXED_ROWS - (active === undefined ? 0 : 1)
      if (capacity <= 0) return compactFallback(state, visible.length, columns, terminalRows, active)
      const rendered = renderRows(state, visible, selected, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const frame = [
        '',
        ...box([
          ...headerRows(state, inner),
          queryRow(query, searching, counter(visible.length, rendered, viewport), inner),
          ...active === undefined
            ? []
            : [style(truncateToWidth(escapeControls(active.text), inner), active.failed ? 'red' : 'green')],
          '',
          ...rendered.rows.slice(viewport.start, viewport.end),
        ], {
          width,
          title: style('Plugins', 'bold', 'yellow'),
          border: text => style(text, 'yellow'),
        }),
        `  ${style(help(searching, query, visible.length > 0, Math.max(1, columns - 2)), 'gray')}`,
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(state, visible.length, columns, terminalRows, active)
    },
    handleKey(key: Key) {
      if (searching) {
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
          case 'backspace':
            edit([...query].slice(0, -1).join(''))
            return
          case 'ctrl-u':
            edit('')
            return
          case 'ctrl-w':
            edit(query.replace(/\s*\S*$/u, ''))
            return
          case 'enter':
          case 'escape':
            // The filter stays active either way; only the mode changes, so
            // `space`/`p`/`d` act again without losing what was typed.
            searching = false
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
        switch (key.text) {
          case '/':
            searching = true
            spec.invalidate()
            return
          case ' ': {
            const row = visible[selected]
            if (row !== undefined) spec.toggle(row)
            return
          }
          case 'p':
            spec.pickPreset()
            return
          case 'd':
            spec.makeDefault()
            return
          default:
            return
        }
      }
      // Pasted text outside search mode names no action; `/` is how a paste
      // meant as a search term gets treated as one.
      if (key.kind === 'paste') return
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
        case 'ctrl-r':
          spec.refresh()
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

/**
 * The two lines naming which preset is being browsed, its default, and — only
 * when it differs from what is browsed — the session's actual current preset.
 * @param state - the current reading.
 * @param inner - the frame's inner width.
 * @returns zero, one, or two header rows.
 */
function headerRows(state: PluginsState, inner: number): string[] {
  if (state.kind !== 'ready') return []
  const browsingId = state.browsing.presetId
  const browsingName = presetName(state, browsingId)
  const defaultName = presetName(state, state.defaultId)
  const left = `Preset: ${browsingName}`
  const right = `default: ${defaultName}`
  const gap = Math.max(1, inner - displayWidth(left) - displayWidth(right))
  const rows = [truncateToWidth(`${left}${' '.repeat(gap)}${right}`, inner)]
  if (state.sessionPresetId !== undefined && state.sessionPresetId !== browsingId) {
    const sessionName = presetName(state, state.sessionPresetId)
    rows.push(style(truncateToWidth(`current session: ${sessionName}`, inner), 'dim'))
  }
  rows.push('')
  return rows
}

/**
 * A preset's display name, falling back to its id when the roster no longer
 * lists it.
 * @param state - the current reading.
 * @param id - the preset id.
 * @returns the name to show.
 */
function presetName(state: Extract<PluginsState, { kind: 'ready' }>, id: string): string {
  return state.presets.find(preset => preset.id === id)?.name ?? id
}

/**
 * Draw a reading's rows at a known width.
 * @param state - the current reading.
 * @param rows - the filtered composition rows.
 * @param selected - the selected row's index among them.
 * @param inner - the frame's inner width in columns.
 * @returns the rows and the selection's row index among them.
 */
function renderRows(
  state: PluginsState,
  rows: readonly CompositionRow[],
  selected: number,
  inner: number,
): Rendered {
  if (state.kind === 'loading') return single('Reading agent presets…', inner)
  if (state.kind === 'unavailable') return single(state.message, inner)
  if (state.kind === 'failed') return single(`Harness could not be read: ${state.message}`, inner)
  if (state.browsing.kind === 'broken') {
    return single(`This preset's composition cannot be read: ${state.browsing.reason}`, inner)
  }
  if (rows.length === 0) {
    return single(
      state.browsing.tree.rows.length === 0 ? 'No plugin rows in this preset.' : 'No plugin matches that.',
      inner,
    )
  }
  const out: string[] = []
  let selectedRow = 0
  rows.forEach((row, index) => {
    const active = index === selected
    if (active) selectedRow = out.length
    out.push(entryRow(row, active, inner))
    if (active) {
      const facts = compositionRowFacts(row)
      if (facts.length > 0) {
        out.push(style(`    ${truncateToWidth(escapeControls(facts.join(' · ')), Math.max(1, inner - 4))}`, 'gray'))
      }
    }
  })
  return { rows: out, selectedRow }
}

/**
 * A reading with nothing to select, as one row.
 * @param text - the sentence to show.
 * @param inner - the frame's inner width.
 * @returns the single row.
 */
function single(text: string, inner: number): Rendered {
  return { rows: [style(truncateToWidth(escapeControls(text), inner), 'gray')], selectedRow: 0 }
}

/**
 * One row: an enabled/disabled mark, the row's id and package indented to
 * its nesting depth, and its right-hand facts.
 * @param row - the composition row.
 * @param active - whether it is selected.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function entryRow(row: CompositionRow, active: boolean, inner: number): string {
  const indent = '  '.repeat(row.depth)
  const mark = row.group ? ' ' : rowMark(row)
  const right = row.group ? '' : rightColumn(row, inner)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 10))
  const label = truncateToWidth(
    escapeControls(`${indent}${row.id ?? row.name}`),
    Math.max(1, inner - 4 - rightWidth - 1),
  )
  const gap = Math.max(1, inner - 4 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  const body = active ? style(plain, 'cyan', 'bold') : plain
  return `${active ? style('❯', 'cyan', 'bold') : ' '} ${mark} ${body}`
}

/**
 * The right-hand facts: the row's package/module name, unless the id-shown
 * label already IS the name (an id-less row), in which case nothing repeats.
 * @param row - the composition row.
 * @param inner - the frame's inner width.
 * @returns the right-aligned text.
 */
function rightColumn(row: CompositionRow, inner: number): string {
  if (row.id === undefined) return ''
  const candidate = escapeControls(row.name)
  return inner - 5 - displayWidth(candidate) >= MIN_NAME_COLUMNS ? candidate : ''
}

/**
 * The query line: a prompt, the typed text, a cursor block, and the counter.
 * @param query - the typed query.
 * @param right - the counter text.
 * @param inner - the frame's inner width.
 * @returns one row.
 */
function queryRow(query: string, searching: boolean, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  // The cursor block only appears while search mode is actually capturing
  // keystrokes — its absence is how a reader tells "space toggles" from
  // "space is about to be typed" apart at a glance.
  const hint = '/ to search'
  const plain = searching
    ? `${tailToWidth(escapeControls(query), Math.max(1, room - 1))}█`
    : query === '' ? hint : tailToWidth(escapeControls(query), Math.max(1, room))
  const typed = !searching && query === '' ? style(plain, 'gray') : plain
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(plain) - rightWidth)
  return `${style(prompt, 'yellow')}${typed}${' '.repeat(gap)}${style(truncateToWidth(right, rightWidth), 'gray')}`
}

/**
 * What the counter says: how many rows, and whether more are below.
 * @param shown - selectable rows after the query.
 * @param rendered - the drawn rows.
 * @param viewport - the scroll position over them.
 * @returns the counter text.
 */
function counter(shown: number, rendered: Rendered, viewport: RowViewport): string {
  const more = viewport.end < rendered.rows.length ? ' · more below' : ''
  return `${String(shown)} row${shown === 1 ? '' : 's'}${more}`
}

/**
 * The help line, truthful for the current query.
 * @param query - the typed query.
 * @param selectable - whether any row can be acted on.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function help(searching: boolean, query: string, selectable: boolean, columns: number): string {
  const parts = searching
    ? ['type to search', 'enter/esc done']
    : [
        ...selectable ? ['↑↓ navigate'] : [],
        '/ search',
        ...selectable ? ['space toggle'] : [],
        'p presets',
        'd default',
        query === '' ? 'esc close' : 'esc clear',
      ]
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' · ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(parts[parts.length - 1] ?? '', columns)
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
 * @param state - the current reading.
 * @param shown - selectable rows after the query.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @param notice - a pending result, when there is one.
 * @returns at most `rows` lines.
 */
function compactFallback(
  state: PluginsState,
  shown: number,
  columns: number,
  rows: number,
  notice: Notice | undefined,
): string[] {
  if (rows <= 0) return []
  if (notice !== undefined) {
    return [style(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), notice.failed ? 'red' : 'green')]
  }
  const summary = state.kind !== 'ready' || shown === 0
    ? 'Plugins · esc close'
    : `${String(shown)} rows · space toggle · esc close`
  const candidate = [summary, 'esc close', 'esc'].find(option => displayWidth(option) <= columns)
  return candidate === undefined ? [] : [style(candidate, 'yellow', 'bold')]
}

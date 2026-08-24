/**
 * The chrome: a banner, a framed composer, and a status line.
 *
 * All of it is ordinary slot registrations with no privileged access to the
 * runner, so a deployment that wants different chrome disables these and
 * registers its own.
 * @module dshline/views
 */

import { basename } from 'node:path'
import type { Composer, LiveCursor, StyleName } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  box,
  chunkToWidth,
  displayWidth,
  escapeControls,
  formatElapsed,
  formatTokens,
  layoutComposer,
  spinnerFrame,
  style,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import type { CardDetail } from './cards.ts'
import type { TuiSlotView } from './slots.ts'

/** What the status line reports; the runner owns the values. */
export interface StatusState {
  /** Whether the agent is working. */
  busy: boolean
  /** Spinner tick, advanced by the runner's timer while busy. */
  tick: number
  /** Milliseconds since the current turn started, or undefined when idle. */
  elapsedMs: number | undefined
  /**
   * The tool calls still awaiting results, when any are outstanding: the newest
   * one's name, and how many others are running beside it.
   */
  activity: { name: string; others: number } | undefined
  /** Model id alone; the provider route is in the banner. */
  model: string | undefined
  /** Reasoning level, only when it differs from the route's default. */
  effort: string | undefined
  /**
   * Cumulative session usage, already formatted, or undefined when the reader
   * has switched it off. Pre-formatted because pricing is not a layout concern:
   * this module decides where the segment goes and when to give it up, and knows
   * nothing about tokens costing money.
   */
  usage: string | undefined
  /** Current context pressure in tokens, when the meter is mounted. */
  tokens: number | undefined
  /** The model's context window, when the adapter reported one. */
  contextWindow: number | undefined
  /** How much of a tool card is drawn, cycled with `ctrl-o`. */
  detail: CardDetail
  /** Active generic Harness work, already formatted as whole count segments. */
  work: string | undefined
  /** Current Harness Todo completion count, as one indivisible segment. */
  todo: string | undefined
  /** Whether plan mode is in force, so the agent will propose rather than act. */
  plan: boolean
  /**
   * A goal to report, already worded. `running` decides how loudly, and `short`
   * is the same fact without the objective, for a terminal that cannot hold it.
   */
  goal: { label: string; short: string; running: boolean } | undefined
}

/** The composer's prompt, inside the frame. */
const PROMPT = '› '

/** Gutter for a continuation line, aligning it under the prompt. */
const CONTINUATION = '  '

/** Widest the chrome will draw, so a maximized terminal keeps readable lines. */
const MAX_COLUMNS = 100

/**
 * Rows the composer's content may occupy before it scrolls.
 *
 * The live region is redrawn by climbing rows, so it has to stay shorter than the
 * screen: rows that have already scrolled off cannot be reached or erased, and the
 * next redraw then leaves duplicate composer rows in scrollback and can clear
 * unrelated output. An uncapped composer reaches that on an ordinary action —
 * pasting twenty short lines into a twenty-four-row terminal — so the content
 * scrolls around the cursor instead, which is what any editor does.
 */
const COMPOSER_ROWS = 10

/** Blank separator and two borders outside the composer's content rows. */
const COMPOSER_FIXED_ROWS = 3

/** Cells in the context-pressure bar. */
const BAR_CELLS = 8

/** Glyphs the bar is drawn from. */
const BAR_FULL = '█'
const BAR_EMPTY = '░'

/**
 * Partial cells, one eighth to seven eighths.
 *
 * These are what make the bar usable at all on a million-token window. Whole cells
 * alone need 12.5% of the window before the first one appears — 125k tokens, which
 * almost no session reaches — so the bar a reader was promised was never drawn. At
 * an eighth of a cell each, the same eight columns carry 64 steps, and the first is
 * visible at 1.6%.
 */
const BAR_PARTIAL: readonly string[] = ['\u258f', '\u258e', '\u258d', '\u258c', '\u258b', '\u258a', '\u2589']

/** Steps per cell: the partial glyphs plus the full one. */
const BAR_STEPS = BAR_PARTIAL.length + 1

/** Context fill at which the pressure reading warns. */
const PRESSURE_WARN = 0.7

/** Context fill at which it alarms. */
const PRESSURE_ALARM = 0.9

/**
 * Chrome width for a terminal of `columns`, leaving a column of breathing room.
 * Every framed element shares it so their edges line up.
 * @param columns - the terminal's width.
 * @returns the width every framed element uses.
 */
export function chromeWidth(columns: number): number {
  return Math.max(BOX_CHROME_COLUMNS + 8, Math.min(columns - 1, MAX_COLUMNS))
}

/**
 * The framed input line.
 *
 * The cursor is reported relative to this view because the frame means the
 * composer is no longer the region's last row, and the runner should not have to
 * know how tall a border is.
 * @param composer - the buffer being edited.
 * @param workspace - session workspace, whose basename titles the frame.
 * @param rowsBelow - fixed live rows the composer must leave beneath itself.
 * @returns the slot view.
 */
export function createComposerView(
  composer: Composer,
  workspace: string,
  rowsBelow: () => number = () => 1,
): TuiSlotView {
  const label = basename(workspace) === '' ? workspace : basename(workspace)

  /**
   * Every rendered row of the buffer, and which of them holds the cursor.
   *
   * Rows are CHUNKED at the width rather than wrapped at spaces, and that choice is
   * what makes the cursor placeable at all. Chunking is prefix-consistent — the rows
   * for the text before the cursor are the first rows for the whole line — so
   * locating the cursor is a matter of chunking that prefix. Word wrapping has no
   * such property: typing one more character can pull a whole word onto the next
   * row, moving a break that is BEFORE the cursor, so a prefix laid out on its own
   * disagrees with the same prefix inside the finished line and the cursor lands on
   * the wrong row.
   *
   * It is also how a terminal's own line editing behaves: a row breaks where the
   * screen runs out, and a character appears in the column it was typed in.
   *
   * The layout comes from the shared primitive so that `↑`/`↓` movement, which the
   * input router also runs through `layoutComposer`, places the cursor on exactly
   * the rows this renders.
   * @param columns - the terminal's current width.
   * @returns the rows and the cursor's row and column within them.
   */
  const layout = (columns: number): { rows: readonly string[]; row: number; column: number } => {
    const found = layoutComposer(composer, composerInner(columns), composerGutter)
    return { rows: found.rows, row: found.cursorRow, column: found.cursorColumn }
  }

  /**
   * The rows to draw, scrolled so the cursor's row is visible.
   * @param all - every wrapped row of the buffer.
   * @param row - the cursor's row within them.
   * @param maximum - most content rows the current live-region budget permits.
   * @returns the visible rows and how many were scrolled past above them.
   */
  const window = (
    all: readonly string[],
    row: number,
    maximum = COMPOSER_ROWS,
  ): { rows: readonly string[]; offset: number } => {
    const visible = Math.max(1, Math.min(COMPOSER_ROWS, maximum))
    if (all.length <= visible) return { rows: all, offset: 0 }
    // Keep the cursor's row in view, preferring to show what follows it: a person
    // pasting or typing is working at the end.
    const offset = Math.min(all.length - visible, Math.max(0, row - visible + 1))
    return { rows: all.slice(offset, offset + visible), offset }
  }

  return {
    // A blank line above separates the frame from whatever the transcript just
    // committed, so a reply and the input box do not read as one block.
    render: (columns, terminalRows = 24) => {
      if (composer.isEmpty) {
        return ['', ...box(chunkToWidth(`${PROMPT}${style('ask anything', 'gray')}`, composerInner(columns)), {
          width: chromeWidth(columns),
          title: style(label, 'cyan'),
          border: text => style(text, 'gray'),
        })]
      }
      const { rows, row } = layout(columns)
      // The timer and status are persistent when enabled, so a tall paste gives
      // up composer history rather than pushing either below the physical screen.
      const contentRows = terminalRows - Math.max(0, rowsBelow()) - COMPOSER_FIXED_ROWS
      const shown = window(rows, row, contentRows)
      const hidden = rows.length - shown.rows.length
      return ['', ...box([...shown.rows], {
        width: chromeWidth(columns),
        title: hidden > 0
          ? `${style(label, 'cyan')} ${style(`+${String(hidden)} rows`, 'gray')}`
          : style(label, 'cyan'),
        border: text => style(text, 'gray'),
      })]
    },
    cursor: (columns): LiveCursor => {
      if (composer.isEmpty) return { row: 2, column: 2 + displayWidth(PROMPT) }
      const { rows, row, column } = layout(columns)
      const shown = window(rows, row)
      // Row 0 is the separating blank and row 1 the top border, so content starts
      // at row 2, and the placement is relative to the visible window.
      return { row: 2 + row - shown.offset, column: 2 + column }
    },
  }
}

/**
 * Display columns of the composer's content area, including its gutter.
 *
 * The inner cell budget of the framed box, shared by the view that draws the
 * cursor and the router that moves it, so both calculate the same visual rows.
 * @param columns - the terminal's current width.
 * @returns the content width the composer draws and moves within.
 */
export function composerInner(columns: number): number {
  return chromeWidth(columns) - BOX_CHROME_COLUMNS
}

/**
 * The gutter preceding each logical line of the composer.
 *
 * Line zero carries the prompt; continuation lines an indent of the same width,
 * so the wrapped text lines up under the prompt.
 * @param line - zero-based logical line index.
 * @returns the line's leading gutter.
 */
export function composerGutter(line: number): string {
  return line === 0 ? PROMPT : CONTINUATION
}

/**
 * Colour for a context reading: quiet until the window is most of the way full,
 * then warning, then alarm — so the number is ignorable until it matters.
 * @param tokens - current pressure.
 * @param window - the model's context window, when known.
 * @returns the style to apply.
 */
function pressureStyle(tokens: number, window: number | undefined): StyleName {
  if (window === undefined || window <= 0) return 'dim'
  const fill = tokens / window
  if (fill >= PRESSURE_ALARM) return 'red'
  if (fill >= PRESSURE_WARN) return 'yellow'
  return 'dim'
}

/**
 * A bar for context pressure, or nothing when there is nothing to report.
 *
 * Measured in eighths of a cell rather than whole cells, which is what makes it
 * appear at all. A DeepSeek window is a million tokens: in whole cells the first one
 * fills at 12.5%, so a bar drawn that way stayed invisible through every session
 * anyone really has — and a feature nobody ever sees is indistinguishable from one
 * that is broken. In eighths the same eight columns resolve to 64 steps.
 *
 * The scale stays strictly linear — a curve would fill sooner and would misreport
 * proportion — with one rule at each end, both of the same kind: never show a state
 * the reader has not reached. Any use at all rounds UP to the first visible mark,
 * because a bar reading empty while the window is in use is the failure this
 * function exists to avoid. The fill is otherwise rounded DOWN, so the bar is not
 * full until the window is.
 *
 * Nothing is drawn before the first token, when there is genuinely nothing to see.
 * @param tokens - current pressure.
 * @param window - the model's context window, when known.
 * @returns the styled bar, or undefined when it would carry no information.
 */
function pressureBar(tokens: number, window: number | undefined): string | undefined {
  if (window === undefined || window <= 0 || tokens <= 0) return undefined
  const steps = BAR_CELLS * BAR_STEPS
  const filled = Math.min(steps, Math.max(1, Math.floor((tokens / window) * steps)))
  const whole = Math.floor(filled / BAR_STEPS)
  const remainder = filled % BAR_STEPS
  const partial = remainder === 0 ? '' : BAR_PARTIAL[remainder - 1] ?? ''
  const empty = BAR_CELLS - whole - (partial === '' ? 0 : 1)
  return style(
    `${BAR_FULL.repeat(whole)}${partial}${BAR_EMPTY.repeat(Math.max(0, empty))}`,
    pressureStyle(tokens, window),
  )
}

/**
 * The status line under the composer.
 * @param state - a getter for the current values, read at render time.
 * @returns the slot view.
 */
export function createStatusView(state: () => StatusState): TuiSlotView {
  return {
    render(columns) {
      const current = state()
      const budget = Math.max(10, columns - 2)
      const separator = style(' · ', 'gray')

      // Facts first, in the order they matter. These are never dropped: a status
      // line that hid whether a turn was running would be worse than a short one.
      const facts: string[] = []
      if (current.busy) {
        const elapsed = current.elapsedMs === undefined ? '' : ` ${formatElapsed(current.elapsedMs)}`
        facts.push(style(`${spinnerFrame(current.tick)} working${elapsed}`, 'yellow'))
      } else {
        facts.push(`${style('●', 'green')}${style(' ready', 'dim')}`)
      }
      // Held apart from the other facts because these are the ones that can be
      // dropped. The effort rides WITH the model rather than beside it: it
      // qualifies that name, and a level left on screen after the model it
      // applied to was dropped would read as belonging to whatever came next.
      // What a turn is DOING, beside how long it has been doing it. A fourteen
      // minute `working` with nothing beside it reads the same whether a command
      // is running or the session has hung. First of the droppable facts, because
      // it is a convenience reading like `todo` and `work` — it says nothing the
      // transcript above will not eventually say.
      //
      // Its own segment rather than part of the timer, because the elapsed time is
      // the TURN's and not this call's: the harness publishes no per-call duration,
      // and `working 14m 26s run_shell_command` would claim one. `+2` counts the
      // other calls running in parallel — naming one of six would be a smaller
      // number of tools, not a shorter way of saying six.
      const activity = current.busy && current.activity !== undefined
        ? style(
          `${escapeControls(current.activity.name)}${current.activity.others > 0 ? ` +${String(current.activity.others)}` : ''}`,
          'dim',
        )
        : undefined
      const model = current.model === undefined
        ? undefined
        : style(current.effort === undefined ? current.model : `${current.model} (${current.effort})`, 'dim')
      const usage = current.usage === undefined ? undefined : style(current.usage, 'dim')
      let reading: string | undefined
      let readingWithBar: string | undefined
      if (current.tokens !== undefined) {
        const window = current.contextWindow === undefined ? '' : `/${formatTokens(current.contextWindow)}`
        reading = style(
          `${formatTokens(current.tokens)}${window}`,
          pressureStyle(current.tokens, current.contextWindow),
        )
        const bar = pressureBar(current.tokens, current.contextWindow)
        readingWithBar = bar === undefined ? reading : `${bar} ${reading}`
      }
      // Only the non-default levels are reported: naming the default on every frame
      // spends a column on a fact the user did not ask about.
      const detail = current.detail === 'compact' ? undefined : style(`tools ${current.detail}`, 'yellow')
      // Todo and Work are convenience readings, not new status rows. Their
      // whole segments yield to one another and then to state that changes a turn.
      const todo = current.todo === undefined ? undefined : style(current.todo, 'cyan')
      const work = current.work === undefined ? undefined : style(current.work, 'cyan')
      // Modes, by the same rule — present only when they are not the ordinary
      // state. Both change what a turn DOES rather than what it says, so neither
      // is given up for width: a session quietly refusing to edit files, or
      // quietly about to take another round on its own, is the case a status line
      // exists to prevent. A goal that will continue by itself is coloured like
      // the working spinner, because that is what it is.
      const plan = current.plan ? style('plan', 'cyan') : undefined
      const goalStyle = (text: string): string =>
        style(text, current.goal?.running === true ? 'yellow' : 'dim')
      const goal = current.goal === undefined ? undefined : goalStyle(current.goal.label)
      // The objective is the only part of a mode that MAY be given up separately,
      // because it is the only part that is prose rather than a fact with a
      // smaller false form. Dropping it leaves `goal 3/256`, which is true;
      // shortening `3/256` would not be.
      const goalShort = current.goal === undefined ? undefined : goalStyle(current.goal.short)

      // Hints are dropped WHOLE when the width runs out. Truncating the joined line
      // instead cut one in half — `ctrl-d qui` — which reads as a rendering fault
      // rather than as a hint. `/model` is absent because a slash command announces
      // itself the moment one is typed.
      // `ctrl-o` is listed while busy too. It was not, and a turn is exactly when
      // it is needed: truncated tool cards are arriving, each one arming a
      // one-shot inspect opportunity that the next result takes away, and the only
      // place this interface says the keystroke exists was off screen until the
      // turn ended. Interrupting still leads, being the more urgent of the two.
      const hints = current.busy
        ? ['ctrl-c interrupt', 'ctrl-o output']
        : ['alt-enter newline', 'ctrl-o output', 'ctrl-d quit']
      // Four lines, richest first, and the first that fits wins. Each step gives up
      // something the one above it keeps, in order of how little it costs:
      //
      // The BAR goes first. It is a picture of the numbers printed beside it, so it
      // is the only thing here whose loss costs no information at all.
      //
      // The MODEL NAME goes next, carrying the reasoning level with it. It is the
      // longest fact and the least urgent: it does not change during a session,
      // where the pressure reading does.
      //
      // The SESSION TOTAL goes last of the three, by the same argument. It accounts
      // for what has already been spent, while the reading governs whether the
      // session still works — so of the two, the reading is the one you cannot be
      // without.
      //
      // The reading itself is never given up, and neither is whether a turn is
      // running. Dropping whole parts rather than truncating the joined line is the
      // same rule the hints follow — a reading cut to `14k/1.0` reads as a rendering
      // fault, not as a number.
      const status = facts[0] ?? ''
      const doing = activity === undefined ? [] : [activity]
      const named = model === undefined ? [] : [model]
      const spent = usage === undefined ? [] : [usage]
      const bar = readingWithBar === undefined ? [] : [readingWithBar]
      const plain = reading === undefined ? [] : [reading]
      const planned = plan === undefined ? [] : [plan]
      const goalled = goal === undefined ? [] : [goal]
      const goalBare = goalShort === undefined ? [] : [goalShort]
      const tooled = detail === undefined ? [] : [detail]
      const todoed = todo === undefined ? [] : [todo]
      const worked = work === undefined ? [] : [work]
      // Modes are given up only after everything else has been, and in an order
      // of their own. `tools` goes first: it is a display preference, then Todo,
      // then Work: all are observations that change no turn. Plan mode goes after
      // that. A running GOAL is the last thing standing, because it is the only
      // state here that will act on its own while nobody is typing.
      //
      // They are held back this hard because a mode cut in half is the failure
      // this whole line is arranged to avoid: `goal 12/25` is not a smaller truth
      // than `goal 12/256`, it is a different one.
      const tails = [
        [...planned, ...goalled, ...worked, ...todoed, ...tooled],
        [...planned, ...goalled, ...worked, ...todoed],
        [...planned, ...goalled, ...worked],
        [...planned, ...goalled],
        [...planned, ...goalBare],
        [...goalBare],
        [],
      ]
      const bodies = [
        [status, ...doing, ...named, ...spent, ...bar],
        [status, ...named, ...spent, ...bar],
        [status, ...named, ...spent, ...plain],
        [status, ...spent, ...plain],
        [status, ...plain],
      ]

      // Room for one hint is held back from the rung choice, so a richer reading
      // can never be the reason the last hint disappears. The hints are the only
      // place this interface says how to leave it or how to start a new line, and
      // a status line at eighty columns — the width most terminals open at — had
      // exactly enough space for the reading, the model, the totals, and no help
      // at all. A segment is droppable; the way out is not.
      const reserve = hints[0] === undefined ? 0 : displayWidth(separator) + displayWidth(hints[0])
      /**
       * The richest line that fits, giving things up in the order they may be lost.
       *
       * Three nested preferences, outermost strongest. The MODES are surrendered
       * last, and the hint reservation is spent inside each level rather than
       * across all of them: reserving room for help at the cost of hiding a
       * running goal would be the reservation outranking the thing it was
       * introduced to sit beside.
       * @returns the joined line, or the barest one when nothing fits.
       */
      const compose = (): string => {
        for (const tail of tails) {
          for (const spare of [reserve, 0]) {
            for (const body of bodies) {
              const joined = [...body, ...tail].join(separator)
              if (displayWidth(joined) + spare <= budget) return joined
            }
          }
        }
        // Narrower than the barest reading. The truncation below is the only
        // thing left, and it is why this returns something rather than nothing.
        return (bodies[bodies.length - 1] ?? []).join(separator)
      }
      let line = compose()
      for (const hint of hints) {
        const extended = `${line}${separator}${style(hint, 'gray')}`
        if (displayWidth(extended) > budget) break
        line = extended
      }
      return [`  ${truncateToWidth(line, budget)}`]
    },
  }
}

/**
 * The opening banner, committed once above the live region rather than
 * registered as a slot: it belongs to scrollback, not to the redrawn area.
 * @param workspace - the session workspace.
 * @param model - provider route and model id, when a selection exists.
 * @param version - this bundle's version.
 * @param columns - the terminal's current width.
 * @returns lines to commit.
 */
export function bannerLines(
  workspace: string,
  model: string | undefined,
  version: string,
  columns: number,
): string[] {
  const rows = [
    `${style('dshline', 'bold', 'cyan')} ${style(version, 'gray')}`,
    style(workspace, 'dim'),
    style(model ?? 'no model configured', 'dim'),
  ]
  return [...box(rows, { width: chromeWidth(columns), border: text => style(text, 'gray') }), '']
}

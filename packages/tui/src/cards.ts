/**
 * Tool calls and results, drawn the way the tool asked to be drawn.
 *
 * A tool declares its render intent through `presentCall` and `presentResult`, and
 * those are pure functions of the call's arguments — the harness's contract, so a
 * frontend may call them freely. Reading them is the difference between "a name,
 * its arguments, and six truncated lines" and a diff in red and green, a framed
 * command with its exit status, or a search grouped by file.
 *
 * A tool that declares nothing still renders: every intent is documented to
 * degrade to raw content, so the fallback is the sanctioned path rather than a
 * gap. What a frontend must never do is invent a card for a tool by name.
 *
 * Every string here came from a model or a tool, so every string is escaped
 * before it is returned.
 * @module @riesbri/dsh-tui/cards
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  DiffCallView,
  DiffResultView,
  FileDiff,
  ReadResultView,
  SearchResultView,
  TerminalCallView,
  TerminalResultView,
  ToolCallView,
  ToolDefinition,
  ToolResultView,
  WebResultView,
} from '@deepseek-ai/dsh-tools'
import { diffRows } from './diff.ts'
import {
  box,
  BOX_CHROME_COLUMNS,
  escapeControls,
  hangingIndent,
  style,
  truncateToWidth,
} from '@riesbri/dsh-tui-renderer'

/**
 * How much of a card to draw.
 *
 * Cycled from the keyboard, because the right amount differs by task: reviewing a
 * change wants every diff line, and watching a long agent run wants the titles
 * alone. `hidden` still draws the call, never the body — a tool call that left no
 * trace at all would make the transcript lie about what ran.
 */
export type CardDetail = 'compact' | 'full' | 'hidden'

/** The cycle order for the toggle. */
export const CARD_DETAIL_CYCLE: readonly CardDetail[] = ['compact', 'full', 'hidden']

/** Body rows a `compact` card shows before it elides the rest. */
const COMPACT_ROWS = 6

/** Body rows a `full` or inspected card shows; a runaway command must not bury the terminal. */
const FULL_ROWS = 200

/**
 * How much of a card to draw, for the scrollback render or the inspector.
 *
 * `inspect` is the inspector's detail level: it renders the same semantic card
 * at the full budget, bounded by {@link FULL_ROWS} exactly as `full` is, so
 * inspecting never renders an unbounded stream either.
 */
type RenderDetail = CardDetail | 'inspect'

/**
 * The elision marker for a card, advertising the inspector only at compact
 * detail — the one level where a truncated card actually arms a Ctrl+O
 * opportunity. A `full` card that hits the same 200-row cap, or the inspector's
 * own inspect level, must not promise a keystroke that opens nothing.
 */
function elisionMarker(detail: RenderDetail, core: string): string {
  return detail === 'compact' ? `${core} · ctrl+o view` : core
}

/** Widest a framed card is drawn, so a maximized terminal keeps readable lines. */
const MAX_CARD_COLUMNS = 100

/** Gutter marks, matching the transcript's. */
const MARK = {
  call: '⏺',
  body: '⎿',
} as const

/** Indent of a card body, aligning it under its call mark. */
const BODY_INDENT = '  '

/** Icons by call category, so a glance separates reading from writing. */
const KIND_ICON: Record<string, string> = {
  read: '◇',
  edit: '◆',
  delete: '✕',
  move: '→',
  search: '⌕',
  execute: '❯',
  fetch: '↓',
}

/** A tool call remembered until its result arrives, so the presenter gets its args. */
interface PendingCall {
  readonly name: string
  /** Parsed arguments, or undefined when the model's JSON did not parse. */
  readonly args: unknown
  /**
   * The diff the call proposed, kept only as a fallback.
   *
   * A mutation tool returns its diff from BOTH presenters, because the harness's
   * card model has the completed view replace the pending one. This screen appends
   * instead of replacing, so drawing both printed every change twice. The applied
   * result-time diff is the one worth keeping — it is what actually landed — and
   * this is drawn only if the result declares no diff of its own.
   */
  readonly diffs?: readonly FileDiff[]
}

/** The parts of a `tool/result` event a card needs. */
export interface ResultInput {
  /** The call this result answers. */
  readonly callId: string
  /** The model-facing result content. */
  readonly content: readonly ContentBlock[]
  /** Whether the call failed. */
  readonly isError: boolean
  /** The tool-private presentation payload, threaded verbatim from the event. */
  readonly meta?: unknown
  /** The harness's failure identity, when the call failed inside the runtime. */
  readonly error?: { readonly code: string; readonly name: string }
}

/**
 * The semantic inputs of the most recent inspectable result.
 *
 * Retaining the call's arguments and the result lets the card renderer reproduce
 * the SAME presentation the compact card used, at expanded detail, rather than
 * falling back to raw content. Only the latest completed truncated result is
 * kept, which bounds memory: there is no history of every tool result.
 */
export interface InspectableToolResult {
  /** The tool that produced the result, for its presenter lookup. */
  readonly name: string
  /** The call's parsed arguments, as the presenter expects them. */
  readonly args: unknown
  /** The call-time diff, when the tool declared one, for the proposed path. */
  readonly diffs?: readonly FileDiff[]
  /** The result, verbatim, from the `tool/result` event. */
  readonly input: ResultInput
}

/** A rendered card's rows, and whether the budget cut any source material. */
interface Rendered {
  readonly rows: string[]
  /** Whether the detail budget omitted source material (the `of N+` marker). */
  readonly truncated: boolean
}

/**
 * Draws tool cards, remembering each call until its result arrives.
 *
 * The pairing is why this holds state: `presentResult` takes the call's arguments
 * as well as its result, and a `tool/result` event carries only the result.
 */
export class ToolCards {
  private readonly pending = new Map<string, PendingCall>()

  /** How much of a card to draw; the runner cycles this from the keyboard. */
  detail: CardDetail = 'compact'

  /** The latest completed result whose compact card elided rows, or undefined. */
  private latest: InspectableToolResult | undefined

  /**
   * @param lookup - resolves a tool definition as the calling agent sees it, so
   *   the card matches the definition that actually executed. A scoped tool can
   *   shadow a global one, and a restricted-away tool reads as absent.
   * @param workspace - the session workspace, which titles a terminal card whose
   *   view left `cwd` to the frontend.
   */
  constructor(
    private readonly lookup: (name: string) => ToolDefinition | undefined,
    private readonly workspace: string,
  ) {}

  /**
   * Draw a pending call.
   * @param call - the logged call: its id, name, and unparsed argument JSON.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  call(call: { callId: string; name: string; arguments: string }, columns: number): string[] {
    const args = parseArguments(call.arguments)
    const view = present(() => this.lookup(call.name)?.presentCall?.(args))
    this.pending.set(call.callId, {
      name: call.name,
      args,
      ...view?.card === 'diff' ? { diffs: view.diffs } : {},
    })
    const width = cardWidth(columns)
    // A tool declaring no view has no title either, so its arguments are the only
    // description of the call and are shown at every level but `hidden`.
    if (view === undefined) return this.rawCall(call.name, call.arguments, width, columns)
    switch (view.card) {
      case 'terminal':
        return this.terminalCall(view, width, columns)
      case 'diff':
        return this.diffCall(view, columns)
      case 'generic':
        return this.genericCall(view.title, rawInputText(view.rawInput), view.kind, columns, view.content)
      default:
        // `ToolCallView` is a closed union today, but a harness release may add a
        // card this frontend has never seen. Falling back to the tool's name and
        // arguments is strictly better than drawing nothing.
        return this.rawCall(call.name, call.arguments, width, columns)
    }
  }

  /**
   * A call from a tool that declared no view: its name and its arguments.
   * @param name - the tool name.
   * @param args - the logged arguments string.
   * @param width - the framed width, for the summary's budget.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private rawCall(name: string, args: string, width: number, columns: number): string[] {
    const rows = hangingIndent(`${style(MARK.call, 'blue')} `, BODY_INDENT, style(escapeControls(name), 'bold'), columns)
    const summary = summarize(args, width)
    if (summary !== '' && this.detail !== 'hidden') {
      rows.push(...hangingIndent(BODY_INDENT, BODY_INDENT, style(escapeControls(summary), 'dim'), columns))
    }
    return ['', ...rows]
  }

  /**
   * Draw a completed call.
   * @param result - the logged result, paired to its call by id.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  result(result: ResultInput, columns: number): string[] {
    const call = this.pending.get(result.callId)
    this.pending.delete(result.callId)
    if (result.error !== undefined) {
      // An error offers no inspect opportunity, and it supersedes any earlier one:
      // Ctrl+O must not stay captured by a card the user already moved past.
      this.latest = undefined
      return [`${BODY_INDENT}${style(MARK.body, 'gray')} ${style(escapeControls(result.error.code), 'red')}`]
    }
    const rendered = this.renderResult(result, call, columns, this.detail)
    // The pending inspect opportunity is exactly the most recent completed card,
    // set ONLY when its compact form hid rows — the cards that leave the omitted
    // rows otherwise unreachable in scrollback. Every other completed result (a
    // short card, an error, a full/hidden card) clears it, so Ctrl+O is never
    // left captured by an old truncated card after newer output arrived.
    this.latest = this.detail === 'compact' && call !== undefined && rendered.truncated
      ? {
          name: call.name,
          args: call.args,
          ...call.diffs === undefined ? {} : { diffs: call.diffs },
          input: result,
        }
      : undefined
    return rendered.rows
  }

  /**
   * Consume the pending inspect opportunity, clearing it.
   *
   * Inspection is one-shot: an unseen truncated result is offered once by Ctrl+O,
   * and taking it returns Ctrl+O to the compact/full/hidden detail cycle until a
   * NEW truncated result arrives to re-arm it. That is what keeps the global
   * toggle reachable after a truncated card has been examined.
   * @returns the pending inspectable result, or undefined when there is none.
   */
  takeInspectable(): InspectableToolResult | undefined {
    const item = this.latest
    this.latest = undefined
    return item
  }

  /**
   * Render an inspectable result's full semantic presentation for the inspector.
   *
   * Re-runs the same presenter the compact card used, so a diff stays a diff and a
   * search stays grouped by file, at the full bounded budget. `rows` are exactly
   * the scrollable presentation rows the overlay navigates, so its counter and
   * the viewport stay in one coordinate system; `truncated` says the 200-row cap
   * hid further source material, for the `of N+` marker.
   * @param item - the retained semantic inputs of the result to re-render.
   * @param columns - the terminal's current width.
   * @returns the presentation rows and whether the budget hid source material.
   */
  renderInspect(item: InspectableToolResult, columns: number): { rows: string[]; truncated: boolean } {
    const call: PendingCall = {
      name: item.name,
      args: item.args,
      ...item.diffs === undefined ? {} : { diffs: item.diffs },
    }
    const { rows, truncated } = this.renderResult(item.input, call, columns, 'inspect')
    return { rows, truncated }
  }

  /**
   * Render a completed call's body at one detail level.
   *
   * Resolving the presenter here keeps the scrollback draw and the inspector on
   * the same code path, so an inspected result is presented exactly as its card
   * was, only with the budget raised. The error branch is handled by the caller,
   * which has no presenter and nothing worth inspecting.
   * @param input - the result.
   * @param call - the paired call, when one was seen.
   * @param columns - the terminal's current width.
   * @param detail - the detail level (compact, full, hidden, or inspect).
   * @returns the rows and how many source rows they were cut from.
   */
  private renderResult(
    input: ResultInput,
    call: PendingCall | undefined,
    columns: number,
    detail: RenderDetail,
  ): Rendered {
    const view = call === undefined
      ? undefined
      : present(() => this.lookup(call.name)?.presentResult?.(call.args, {
        content: [...input.content],
        isError: input.isError,
        ...input.meta === undefined ? {} : { meta: input.meta as never },
      }))
    const width = cardWidth(columns)
    // A mutation tool that declared a call-time diff but no result-time one leaves
    // the proposal as the only description of what it changed — but ONLY when the
    // call succeeded. Drawing a proposal for a failed call shows a change that
    // never happened as though it had, and suppresses the error that says so.
    const proposed = input.isError ? undefined : call?.diffs
    if (view === undefined) {
      return proposed === undefined
        ? this.body(textOf(input.content), columns, input.isError, detail)
        : this.diffBody(proposed, width, columns, detail)
    }
    switch (view.card) {
      case 'terminal':
        return this.terminalResult(view, width, columns, detail)
      case 'diff':
        return this.diffBody(view.diffs, width, columns, detail)
      case 'search':
        return this.searchResult(view, columns, detail)
      case 'read':
        return this.readResult(view, columns, detail)
      case 'web':
        return this.webResult(view, columns, input, detail)
      case 'generic':
        if (proposed !== undefined) return this.diffBody(proposed, width, columns, detail)
        return this.body(view.content === undefined ? textOf(input.content) : textOf(view.content), columns, input.isError, detail)
      default:
        return this.body(textOf(input.content), columns, input.isError, detail)
    }
  }

  /** Forget every unanswered call, for a turn that ended without its results. */
  reset(): void {
    this.pending.clear()
  }

  /**
   * A titled call row, optionally with a detail line beneath it.
   * @param title - the call's own title, unescaped.
   * @param detail - the salient input, unescaped; empty for none. Shown only at
   *   `full`, because a view that declares one has already said what the call does
   *   in its title — `grep`'s title names the pattern its `rawInput` repeats.
   * @param kind - the call category, for its icon.
   * @param columns - the terminal's current width.
   * @param content - extra content blocks the view asked to show.
   * @returns rows to write into scrollback.
   */
  private genericCall(
    title: string,
    detail: string,
    kind: string | undefined,
    columns: number,
    content?: readonly ContentBlock[],
  ): string[] {
    const icon = kind === undefined ? MARK.call : KIND_ICON[kind] ?? MARK.call
    const head = style(escapeControls(title), 'bold')
    const rows = hangingIndent(`${style(icon, 'blue')} `, BODY_INDENT, head, columns)
    if (detail !== '' && this.detail === 'full') {
      rows.push(...hangingIndent(BODY_INDENT, BODY_INDENT, style(escapeControls(detail), 'dim'), columns))
    }
    if (content !== undefined && content.length > 0) rows.push(...this.body(textOf(content), columns, false, this.detail).rows)
    return ['', ...rows]
  }

  /**
   * A shell command as a framed card headed by its working directory.
   * @param view - the terminal call view.
   * @param width - the framed width.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private terminalCall(view: TerminalCallView, width: number, columns: number): string[] {
    const rows = ['']
    if (view.description !== undefined && view.description !== '') {
      rows.push(...hangingIndent(`${style(KIND_ICON.execute ?? MARK.call, 'blue')} `, BODY_INDENT, style(escapeControls(view.description), 'bold'), columns))
    }
    if (this.detail === 'hidden') {
      // The command itself is not a body: hiding it would leave a card that says
      // a shell ran without saying what it ran.
      rows.push(...hangingIndent(BODY_INDENT, BODY_INDENT, style(escapeControls(view.title), 'bold'), columns))
      return rows
    }
    rows.push(...box([style(escapeControls(view.title), 'bold')], {
      width,
      // A view that omits `cwd` runs in the session workspace; the harness leaves
      // naming it to the frontend, and an untitled frame loses where a command ran.
      title: escapeControls(view.cwd ?? this.workspace),
      border: text => style(text, 'gray'),
    }).map(row => `${BODY_INDENT}${row}`))
    return rows
  }

  /**
   * A completed command: its output framed, with an exit status.
   * @param view - the terminal result view.
   * @param width - the framed width.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private terminalResult(view: TerminalResultView, width: number, columns: number, detail: RenderDetail): Rendered {
    const status = view.signal !== undefined
      ? style(`killed by ${escapeControls(view.signal)}`, 'red')
      : view.exitCode === undefined || view.exitCode === 0
        ? undefined
        : style(`exit ${String(view.exitCode)}`, 'red')
    const output = view.output ?? ''
    if (detail === 'hidden') {
      return { rows: status === undefined ? [] : [`${BODY_INDENT}${status}`], truncated: false }
    }
    if (output.trim() === '') {
      return {
        rows: status === undefined ? [`${BODY_INDENT}${style('no output', 'gray')}`] : [`${BODY_INDENT}${status}`],
        truncated: false,
      }
    }
    // The final newline terminates the last line rather than starting an empty one.
    // Keeping it added a blank row inside the frame, and at the compact boundary it
    // also reported one line as hidden when nothing had been.
    const all = escapeControls(output.replace(/\n$/u, '')).split('\n')
    const { rows, elided } = this.limit(all, detail)
    const body = rows.map(row => truncateToWidth(style(row, 'dim'), width - BOX_CHROME_COLUMNS))
    if (elided > 0) body.push(style(elisionMarker(detail, `… ${String(elided)} more lines`), 'gray'))
    return {
      rows: box(body, {
        width,
        ...status === undefined ? {} : { title: status },
        border: text => style(text, 'gray'),
      }).map(row => `${BODY_INDENT}${row}`),
      truncated: elided > 0,
    }
  }

  /**
   * A diff call: its title alone, because the change is drawn once, at result time.
   * @param view - the diff call view.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private diffCall(view: DiffCallView, columns: number): string[] {
    return [
      '',
      ...hangingIndent(`${style(KIND_ICON.edit ?? MARK.call, 'blue')} `, BODY_INDENT, style(escapeControls(view.title), 'bold'), columns),
    ]
  }

  /**
   * The changed lines of one or more files, added in green and removed in red.
   * @param diffs - the files' changes.
   * @param width - the framed width.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private diffBody(diffs: readonly FileDiff[], width: number, columns: number, detail: RenderDetail): Rendered {
    if (detail === 'hidden') return { rows: [], truncated: false }
    const out: string[] = []
    // ONE budget across every file, not one per file. Per-file budgets let a bulk
    // mutation emit six rows plus a header for each of hundreds of files and bury
    // the transcript, which is the opposite of what the cap is for.
    const budget = detail === 'full' || detail === 'inspect' ? FULL_ROWS : COMPACT_ROWS
    let remaining = budget
    let omitted = 0
    let filesOmitted = 0
    for (const diff of diffs) {
      const changed = diffRows(diff.oldText, diff.newText).filter(row => row.kind !== 'context')
      if (remaining <= 0) {
        filesOmitted += 1
        omitted += changed.length
        continue
      }
      out.push(...hangingIndent(
        `${BODY_INDENT}${style(MARK.body, 'gray')} `,
        `${BODY_INDENT}  `,
        style(escapeControls(diff.path), 'cyan'),
        columns,
      ))
      const shown = changed.slice(0, remaining)
      omitted += changed.length - shown.length
      remaining -= shown.length
      // An identical before and after leaves nothing marked, which would read as an
      // empty change rather than an unchanged file.
      if (changed.length === 0) out.push(`${BODY_INDENT}  ${style('(no change)', 'gray')}`)
      for (const row of shown) {
        const marked = row.kind === 'add'
          ? style(`+ ${escapeControls(row.text)}`, 'green')
          : style(`- ${escapeControls(row.text)}`, 'red')
        out.push(`${BODY_INDENT}  ${truncateToWidth(marked, Math.max(10, width - 4))}`)
      }
    }
    if (omitted > 0) {
      const files = filesOmitted > 0 ? ` in ${String(filesOmitted)} more files` : ''
      out.push(`${BODY_INDENT}  ${style(elisionMarker(detail, `… ${String(omitted)} more changed lines${files}`), 'gray')}`)
    }
    return { rows: out, truncated: omitted > 0 }
  }

  /**
   * A search result: matches grouped by file, or a flat path list.
   * @param view - the search result view.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private searchResult(view: SearchResultView, columns: number, detail: RenderDetail): Rendered {
    const total = `${String(view.total)}${view.truncated ? '+' : ''}`
    const head = `${BODY_INDENT}${style(MARK.body, 'gray')} `
    if (view.shape === 'paths') {
      const summary = `${total} ${view.total === 1 ? 'path' : 'paths'}`
      if (detail === 'hidden') return { rows: [`${head}${style(summary, 'dim')}`], truncated: false }
      const { rows, elided } = this.limit(view.paths, detail)
      return {
        rows: [
          `${head}${style(summary, 'dim')}`,
          ...rows.map(path => `${BODY_INDENT}  ${truncateToWidth(style(escapeControls(path), 'cyan'), columns - 4)}`),
          ...elided > 0 ? [`${BODY_INDENT}  ${style(elisionMarker(detail, `… ${String(elided)} more`), 'gray')}`] : [],
        ],
        truncated: elided > 0,
      }
    }
    const summary = `${total} ${view.total === 1 ? 'match' : 'matches'} in ${String(view.files.length)} ${view.files.length === 1 ? 'file' : 'files'}`
    if (detail === 'hidden') return { rows: [`${head}${style(summary, 'dim')}`], truncated: false }
    const out = [`${head}${style(summary, 'dim')}`]
    // Files, then their lines: a flat list of matches loses which file each is in,
    // which is the first thing a reader needs from a search.
    const budget = detail === 'full' || detail === 'inspect' ? FULL_ROWS : COMPACT_ROWS
    let drawn = 0
    let omitted = 0
    for (const file of view.files) {
      if (drawn >= budget) {
        omitted += 1 + file.matches.length
        continue
      }
      out.push(`${BODY_INDENT}  ${truncateToWidth(style(escapeControls(file.path), 'cyan'), columns - 4)}`)
      drawn += 1
      for (const match of file.matches) {
        if (drawn >= budget) {
          omitted += 1
          continue
        }
        const number = style(`${String(match.lineNumber)}:`, 'gray')
        out.push(`${BODY_INDENT}    ${truncateToWidth(`${number} ${style(escapeControls(match.line.trim()), 'dim')}`, columns - 6)}`)
        drawn += 1
      }
    }
    // This budget is the card's own, separate from the tool's `truncated` flag, so
    // without saying so a card could hide matches while reporting a complete result
    // — and the explicitly chosen `full` view would look complete too.
    if (omitted > 0) out.push(`${BODY_INDENT}  ${style(elisionMarker(detail, `… ${String(omitted)} more rows`), 'gray')}`)
    return { rows: out, truncated: omitted > 0 }
  }

  /**
   * A file read: its lines, numbered as they are in the file.
   * @param view - the read result view.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private readResult(view: ReadResultView, columns: number, detail: RenderDetail): Rendered {
    const shown = view.lines.length
    const summary = `${escapeControls(view.path)} · ${String(shown)} of ${String(view.totalLines)} lines`
    const head = `${BODY_INDENT}${style(MARK.body, 'gray')} ${style(summary, 'dim')}`
    if (detail === 'hidden') return { rows: [head], truncated: false }
    const { rows, elided } = this.limit(view.lines.map(line => {
      const number = style(String(line.number).padStart(4), 'gray')
      return `${number} ${style(escapeControls(line.text), 'dim')}`
    }), detail)
    return {
      rows: [
        head,
        ...rows.map(row => `${BODY_INDENT}  ${truncateToWidth(row, columns - 4)}`),
        ...elided > 0 ? [`${BODY_INDENT}  ${style(elisionMarker(detail, `… ${String(elided)} more lines`), 'gray')}`] : [],
      ],
      truncated: elided > 0,
    }
  }

  /**
   * A web retrieval: its sources, or its fetched text.
   * @param view - the web result view.
   * @param columns - the terminal's current width.
   * @param result - the logged result, for the fallback text.
   * @returns rows to write into scrollback.
   */
  private webResult(view: WebResultView, columns: number, result: ResultInput, detail: RenderDetail): Rendered {
    if (view.kind !== 'search') return this.body(textOf(result.content), columns, result.isError, detail)
    // The `+` marks a capped list, exactly as the search card does: without it a
    // truncated set of sources reads as the complete set.
    const count = `${String(view.sources.length)}${view.truncated ? '+' : ''}`
    const summary = `${count} ${view.sources.length === 1 && !view.truncated ? 'source' : 'sources'}`
    const head = `${BODY_INDENT}${style(MARK.body, 'gray')} ${style(summary, 'dim')}`
    if (detail === 'hidden') return { rows: [head], truncated: false }
    const { rows, elided } = this.limit(view.sources.map(source => {
      const title = source.title === undefined ? source.url : source.title
      return `${style(escapeControls(title), 'cyan')} ${style(escapeControls(source.url), 'gray')}`
    }), detail)
    return {
      rows: [
        head,
        ...rows.map(row => `${BODY_INDENT}  ${truncateToWidth(row, columns - 4)}`),
        ...elided > 0 ? [`${BODY_INDENT}  ${style(elisionMarker(detail, `… ${String(elided)} more`), 'gray')}`] : [],
      ],
      truncated: elided > 0,
    }
  }

  /**
   * Raw result text, the fallback every intent degrades to.
   * @param text - the result text, unescaped.
   * @param columns - the terminal's current width.
   * @param isError - whether the call failed, which colours it.
   * @returns rows to write into scrollback.
   */
  private body(text: string, columns: number, isError: boolean, detail: RenderDetail): Rendered {
    const trimmed = text.trim()
    if (trimmed === '' || detail === 'hidden') return { rows: [], truncated: false }
    const all = escapeControls(trimmed).split('\n')
    const { rows, elided } = this.limit(all, detail)
    const paint = (row: string): string => style(row, isError ? 'red' : 'dim')
    const out = rows.map((row, index) => (index === 0
      ? `${BODY_INDENT}${style(MARK.body, 'gray')} ${truncateToWidth(paint(row), columns - 4)}`
      : `${BODY_INDENT}  ${truncateToWidth(paint(row), columns - 4)}`))
    if (elided > 0) out.push(`${BODY_INDENT}  ${style(elisionMarker(detail, `… ${String(elided)} more lines`), 'gray')}`)
    return { rows: out, truncated: elided > 0 }
  }

  /**
   * Cut a body to a detail level's row budget.
   * @param rows - every row the body could show.
   * @param detail - the detail level being drawn.
   * @returns the retained rows and how many were dropped.
   */
  private limit(rows: readonly string[], detail: RenderDetail): { rows: readonly string[]; elided: number } {
    const budget = detail === 'full' || detail === 'inspect' ? FULL_ROWS : COMPACT_ROWS
    if (rows.length <= budget) return { rows, elided: 0 }
    return { rows: rows.slice(0, budget), elided: rows.length - budget }
  }
}

/**
 * Run a presenter, treating a throw as "declared nothing".
 *
 * Presenters read the model's arguments, which may be any JSON at all. A frontend
 * that let one throw would take down the whole render on a malformed call, so a
 * failure degrades to the raw-content fallback the intent already documents.
 * @param present - the presenter call.
 * @returns the view, or undefined when there is none.
 */
function present<T>(present: () => T | undefined): T | undefined {
  try {
    return present()
  } catch {
    // A presenter that cannot describe these arguments is not an error the user
    // can act on; the raw content is still shown.
    return undefined
  }
}

/**
 * Parse a call's logged argument JSON.
 *
 * The harness logs the model's arguments verbatim, malformed included, precisely
 * so a bad call stays reconstructable. Unparseable JSON therefore yields no args
 * rather than an error.
 * @param raw - the logged arguments string.
 * @returns the parsed value, or undefined.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Malformed model JSON; the caller shows the raw string instead.
    return undefined
  }
}

/**
 * Render a view's salient input.
 * @param rawInput - the value the view chose to surface.
 * @returns the text to show, empty when there is none.
 */
function rawInputText(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return ''
  if (typeof rawInput === 'string') return rawInput
  return JSON.stringify(rawInput) ?? ''
}

/**
 * A one-line summary of raw arguments, for a tool that declares no call view.
 * @param raw - the logged arguments string.
 * @param columns - width budget.
 * @returns the summary.
 */
function summarize(raw: string, columns: number): string {
  const parsed = parseArguments(raw)
  if (typeof parsed !== 'object' || parsed === null) return truncateToWidth(raw, columns)
  return truncateToWidth(Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value) ?? ''}`)
    .join(' '), columns)
}

/**
 * Concatenate the text of every text block.
 * @param content - message content blocks.
 * @returns the joined text.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * The width a framed card is drawn at.
 * @param columns - the terminal's current width.
 * @returns the frame width, indented under the call mark.
 */
function cardWidth(columns: number): number {
  return Math.max(BOX_CHROME_COLUMNS + 8, Math.min(columns - BODY_INDENT.length, MAX_CARD_COLUMNS))
}

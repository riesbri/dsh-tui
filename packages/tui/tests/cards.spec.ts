import { describe, expect, it } from 'vitest'
import type { ToolCallView, ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'
import { displayWidth, Screen, stripAnsi } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import type { CardDetail, ResultInput } from '../src/cards.ts'
import { ToolCards } from '../src/cards.ts'

/** Wide enough that nothing under test wraps, so assertions read as content. */
const COLUMNS = 90

/** Body rows a compact card shows, mirroring COMPACT_ROWS in the source. */
const COMPACT_BUDGET = 6

/** Strip styling, so assertions read as what a person would see. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

/**
 * A tool that declares the given presenters and nothing else.
 * @param presenters - the call and result views to return.
 * @returns a lookup for ToolCards.
 */
function tool(presenters: {
  call?: (args: unknown) => ToolCallView | undefined
  result?: (args: unknown) => ToolResultView | undefined
}): (name: string) => ToolDefinition | undefined {
  return () => ({
    ...presenters.call === undefined ? {} : { presentCall: presenters.call },
    ...presenters.result === undefined ? {} : { presentResult: presenters.result },
  } as unknown as ToolDefinition)
}

/** A tool that declares no presenters, the fallback path. */
const bare = (): ToolDefinition | undefined => ({} as unknown as ToolDefinition)

/**
 * A tool/result payload.
 * @param text - the model-facing result text.
 * @param extra - overrides.
 * @returns the input ToolCards reads.
 */
function result(text: string, extra: Partial<ResultInput> = {}): ResultInput {
  return { callId: 'c1', content: [{ type: 'text', text }], isError: false, ...extra }
}

/**
 * Draw one call and its result at a detail level.
 * @param lookup - the tool lookup.
 * @param detail - the level to draw at.
 * @returns the rows, styling removed.
 */
function draw(
  lookup: (name: string) => ToolDefinition | undefined,
  { detail = 'compact' as CardDetail, args = '{}', text = '' } = {},
): string[] {
  const cards = new ToolCards(lookup, '/w')
  cards.detail = detail
  const rows = cards.call({ callId: 'c1', name: 'demo', arguments: args }, COLUMNS)
  return plain([...rows, ...cards.result(result(text), COLUMNS)])
}

describe('a tool that declares nothing', () => {
  it('summarizes its arguments as key=value pairs', () => {
    expect(draw(bare, { args: '{"file_path":"src/index.ts","offset":10}' }))
      .toEqual(['', '⏺ demo', '  file_path=src/index.ts offset=10'])
  })

  it('shows malformed model JSON as it actually arrived', () => {
    // The harness logs arguments verbatim so a bad call stays reconstructable;
    // treating unparseable JSON as an error would hide what the model sent.
    expect(draw(bare, { args: '{"file_path": ' })).toEqual(['', '⏺ demo', '  {"file_path": '])
  })

  it('renders its raw result, the fallback every intent degrades to', () => {
    expect(draw(bare, { text: 'one\ntwo' })).toEqual(['', '⏺ demo', '  ⎿ one', '    two'])
  })

  it('elides a long result and says how much it hid', () => {
    const rows = draw(bare, { text: Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n') })
    expect(rows.at(-1)).toBe('    … 14 more lines')
  })

  it('shows every line at full detail', () => {
    const rows = draw(bare, {
      detail: 'full',
      text: Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n'),
    })
    expect(rows.at(-1)).toBe('    line 19')
    expect(rows.join('\n')).not.toContain('more lines')
  })

  it('neutralizes an escape sequence in tool output', () => {
    // Tool output is untrusted: a sequence reaching the terminal unescaped would
    // be obeyed rather than shown.
    expect(draw(bare, { text: '[2Jwiped' })).toContain('  ⎿ ^[[2Jwiped')
  })

  it('reports a failed call by the code the runtime gave it', () => {
    const cards = new ToolCards(bare, '/w')
    expect(plain(cards.result(result('', { error: { code: 'ENOENT', name: 'Error' } }), COLUMNS)))
      .toEqual(['  ⎿ ENOENT'])
  })
})

describe('render intent', () => {
  it('draws a terminal call as a framed command headed by its working directory', () => {
    const rows = draw(tool({ call: () => ({ card: 'terminal', title: 'pnpm test', cwd: '/w/repo' }) }))
    expect(rows[1]).toContain('/w/repo')
    expect(rows.join('\n')).toContain('pnpm test')
    // Framed, not a bare line: the border is what separates a command from prose,
    // and indented so it lines up with the output frame that follows it.
    expect(rows[1]?.startsWith('  ╭')).toBe(true)
  })

  it('shows a failing command\'s exit status on its output frame', () => {
    const rows = draw(
      tool({ result: () => ({ card: 'terminal', output: 'boom', exitCode: 2 }) }),
    )
    expect(rows.join('\n')).toContain('exit 2')
    expect(rows.join('\n')).toContain('boom')
  })

  it('says a command produced no output rather than drawing an empty frame', () => {
    expect(draw(tool({ result: () => ({ card: 'terminal', output: '', exitCode: 0 }) })).at(-1))
      .toBe('  no output')
  })

  it('names the signal that killed a command', () => {
    expect(draw(tool({ result: () => ({ card: 'terminal', signal: 'SIGTERM' }) })).join('\n'))
      .toContain('killed by SIGTERM')
  })

  it('marks added lines with + and removed lines with -', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'diff',
        title: 'Edit config.ts',
        diffs: [{ path: 'config.ts', oldText: 'a\nold\nc', newText: 'a\nnew\nc' }],
      }),
    }))
    expect(rows).toContain('    - old')
    expect(rows).toContain('    + new')
    // The unchanged context is not repeated as a change.
    expect(rows.join('\n')).not.toContain('- a')
  })

  it('colours removals red and additions green', () => {
    // The marks alone are readable stripped; the colour is the thing a reader sees
    // first, and only an unstripped assertion can prove it is there.
    const cards = new ToolCards(tool({
      result: () => ({ card: 'diff', diffs: [{ path: 'f', oldText: 'old', newText: 'new' }] }),
    }), '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const joined = cards.result(result(''), COLUMNS).join('\n')
    expect(joined).toContain('[31m- old')
    expect(joined).toContain('[32m+ new')
  })

  it('treats a new file as all additions, since there is nothing to diff against', () => {
    const rows = draw(tool({
      result: () => ({ card: 'diff', title: 'Write new.ts', diffs: [{ path: 'new.ts', oldText: null, newText: 'a\nb' }] }),
    }))
    expect(rows).toContain('    + a')
    expect(rows).toContain('    + b')
  })

  it('says a diff changed nothing rather than drawing an empty change', () => {
    const rows = draw(tool({
      result: () => ({ card: 'diff', title: 'Edit f', diffs: [{ path: 'f', oldText: 'same', newText: 'same' }] }),
    }))
    expect(rows.join('\n')).toContain('(no change)')
  })

  it('draws a change once, though a mutation tool declares it from both presenters', () => {
    // The harness's card model has the completed view REPLACE the pending one, so
    // a mutation tool returns its diff twice on purpose. This screen appends, so
    // drawing both printed every change twice — once proposed, once applied.
    const diffs = [{ path: 'f.ts', oldText: 'old', newText: 'new' }]
    const rows = draw(tool({
      call: () => ({ card: 'diff', title: 'Edit f.ts', diffs }),
      result: () => ({ card: 'diff', diffs }),
    }))
    expect(rows.filter(row => row.endsWith('+ new'))).toHaveLength(1)
    expect(rows).toEqual(['', '◆ Edit f.ts', '  ⎿ f.ts', '    - old', '    + new'])
  })

  it('keeps the proposed change when the tool declares no result-time diff', () => {
    // Otherwise the only description of what a mutation changed is lost.
    const rows = draw(tool({
      call: () => ({ card: 'diff', title: 'Edit f.ts', diffs: [{ path: 'f.ts', oldText: 'old', newText: 'new' }] }),
    }), { text: 'wrote 1 file' })
    expect(rows).toEqual(['', '◆ Edit f.ts', '  ⎿ f.ts', '    - old', '    + new'])
  })

  it('groups search matches under their file, which a flat list loses', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'search',
        shape: 'matches',
        files: [{ path: 'a.ts', matches: [{ lineNumber: 12, line: '  const a = 1' }] }],
        truncated: false,
        total: 1,
      }),
    }))
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ 1 match in 1 file', '    a.ts', '      12: const a = 1'])
  })

  it('marks a capped search so a partial result never reads as complete', () => {
    const rows = draw(tool({
      result: () => ({ card: 'search', shape: 'paths', paths: ['a', 'b'], truncated: true, total: 40 }),
    }))
    expect(rows[2]).toBe('  ⎿ 40+ paths')
  })

  it('keeps a read\'s own line numbers, not a re-count from one', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'read',
        path: 'src/a.ts',
        offset: 40,
        lines: [{ number: 40, text: 'first' }, { number: 41, text: 'second' }],
        totalLines: 900,
      }),
    }))
    expect(rows[2]).toBe('  ⎿ src/a.ts · 2 of 900 lines')
    expect(rows[3]).toBe('      40 first')
    expect(rows[4]).toBe('      41 second')
  })

  it('lists a web search\'s sources with their urls', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        sources: [{ url: 'https://e.com/a', title: 'A page' }],
        truncated: false,
      }),
    }))
    expect(rows[2]).toBe('  ⎿ 1 source')
    expect(rows[3]).toBe('    A page https://e.com/a')
  })

  it('marks a capped web search, so a partial source list never reads as complete', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        sources: [{ url: 'https://e.com/a' }],
        truncated: true,
      }),
    }))
    expect(rows[2]).toBe('  ⎿ 1+ sources')
  })

  it('picks an icon from the call category', () => {
    expect(draw(tool({ call: () => ({ card: 'generic', title: 'Read a.ts', kind: 'read' }) }))[1])
      .toBe('◇ Read a.ts')
  })

  it('keeps a declared rawInput for full detail, since the title already says it', () => {
    // grep's view titles the call "Grep MIT in LICENSE" and sets rawInput to
    // "MIT", so showing both printed the pattern twice on every search.
    const view = { card: 'generic', title: 'Grep MIT in LICENSE', kind: 'search', rawInput: 'MIT' } as const
    expect(draw(tool({ call: () => view }))).toEqual(['', '⌕ Grep MIT in LICENSE'])
    expect(draw(tool({ call: () => view }), { detail: 'full' })).toEqual(['', '⌕ Grep MIT in LICENSE', '  MIT'])
  })

  it('titles a terminal frame with the workspace when the view leaves cwd open', () => {
    // The harness documents an omitted cwd as "the session workspace", and leaves
    // naming it to the frontend; an untitled frame loses where a command ran.
    expect(draw(tool({ call: () => ({ card: 'terminal', title: 'ls' }) })).join('\n')).toContain('/w')
  })

  it('falls back to the raw arguments for a card it has never seen', () => {
    // The unions are merge-extensible: a harness release may add a card, and
    // drawing nothing would lose the call entirely.
    const rows = draw(
      tool({ call: () => ({ card: 'future-card' } as unknown as ToolCallView) }),
      { args: '{"a":1}' },
    )
    expect(rows.slice(0, 3)).toEqual(['', '⏺ demo', '  a=1'])
  })

  it('falls back to raw content when a presenter throws', () => {
    // Presenters read the model's arguments, which may be any JSON at all. A throw
    // must not take down the render.
    const rows = draw(
      tool({ call: () => { throw new Error('bad args') }, result: () => { throw new Error('bad args') } }),
      { text: 'the result' },
    )
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ the result'])
  })
})

describe('the detail toggle', () => {
  it('still names a hidden call, so the transcript cannot lie about what ran', () => {
    expect(draw(bare, { detail: 'hidden', args: '{"a":1}', text: 'output' }))
      .toEqual(['', '⏺ demo'])
  })

  it('still shows a hidden command, since the command is not its output', () => {
    const rows = draw(
      tool({ call: () => ({ card: 'terminal', title: 'rm -rf build', description: 'Clean' }) }),
      { detail: 'hidden' },
    )
    expect(rows.join('\n')).toContain('rm -rf build')
  })

  it('still reports a non-zero exit when the body is hidden', () => {
    expect(draw(tool({ result: () => ({ card: 'terminal', output: 'noise', exitCode: 1 }) }), { detail: 'hidden' }))
      .toEqual(['', '⏺ demo', '  exit 1'])
  })

  it('hides a diff body but keeps its title', () => {
    const rows = draw(
      tool({
        call: () => ({ card: 'diff', title: 'Edit f', diffs: [{ path: 'f', oldText: 'a', newText: 'b' }] }),
        result: () => ({ card: 'diff', diffs: [{ path: 'f', oldText: 'a', newText: 'b' }] }),
      }),
      { detail: 'hidden' },
    )
    expect(rows).toEqual(['', '◆ Edit f'])
  })

  it('keeps a search summary when the matches are hidden', () => {
    const rows = draw(
      tool({
        result: () => ({
          card: 'search',
          shape: 'matches',
          files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] }],
          truncated: false,
          total: 1,
        }),
      }),
      { detail: 'hidden' },
    )
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ 1 match in 1 file'])
  })
})

describe('call and result pairing', () => {
  it('hands the presenter the arguments of its own call', () => {
    // presentResult takes the call's arguments as well as its result, and a
    // tool/result event carries only the result — the pairing is by call id.
    const seen: unknown[] = []
    const cards = new ToolCards(() => ({
      presentResult: (args: unknown) => {
        seen.push(args)
        return undefined
      },
    } as unknown as ToolDefinition), '/w')
    cards.call({ callId: 'first', name: 'demo', arguments: '{"n":1}' }, COLUMNS)
    cards.call({ callId: 'second', name: 'demo', arguments: '{"n":2}' }, COLUMNS)
    cards.result(result('', { callId: 'second' }), COLUMNS)
    cards.result(result('', { callId: 'first' }), COLUMNS)
    expect(seen).toEqual([{ n: 2 }, { n: 1 }])
  })

  it('renders a result whose call it never saw', () => {
    // A resumed or replayed log can begin partway through a turn.
    const cards = new ToolCards(bare, '/w')
    expect(plain(cards.result(result('orphan'), COLUMNS))).toEqual(['  ⎿ orphan'])
  })

  it('threads the tool-private meta payload through to the presenter', () => {
    // The read and web cards cannot be reconstructed from result text alone; the
    // tool projects them through meta and reads them back here.
    let seen: unknown
    const cards = new ToolCards(() => ({
      presentResult: (_args: unknown, given: { meta?: unknown }) => {
        seen = given.meta
        return undefined
      },
    } as unknown as ToolDefinition), '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    cards.result(result('', { meta: { totalLines: 12 } }), COLUMNS)
    expect(seen).toEqual({ totalLines: 12 })
  })
})

describe('on a real terminal', () => {
  /**
   * Draw rows through an emulator and read back what a person sees.
   * @param rows - the card rows.
   * @param columns - the terminal width.
   * @returns the visible rows, trailing blanks trimmed.
   */
  async function shown(rows: readonly string[], columns: number): Promise<string[]> {
    const emulator = createEmulator(columns, 24)
    new Screen(emulator.target).commit(rows)
    return (await emulator.screen()).map(row => row.trimEnd()).filter(row => row !== '')
  }

  it('lines a terminal card\'s two frames up in the same columns', async () => {
    // The frames are drawn by separate events, so nothing but arithmetic keeps
    // their borders in one column — and a border off by one is the single most
    // visible rendering defect there is.
    const cards = new ToolCards(tool({
      call: () => ({ card: 'terminal', title: 'ls -la', cwd: '/w' }),
      result: () => ({ card: 'terminal', output: 'a\nb', exitCode: 0 }),
    }), '/w')
    const rows = await shown([
      ...cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 60),
      ...cards.result(result(''), 60),
    ], 60)
    const borders = rows.filter(row => row.includes('╭') || row.includes('╰'))
    expect(borders).toHaveLength(4)
    expect(new Set(borders.map(row => row.indexOf('╭') + row.indexOf('╰') + 1)).size).toBe(1)
    expect(new Set(borders.map(row => row.length)).size).toBe(1)
  })

  it('keeps a card inside the terminal at a narrow width', async () => {
    const cards = new ToolCards(tool({
      result: () => ({ card: 'terminal', output: 'x'.repeat(200), exitCode: 0 }),
    }), '/w')
    const rows = await shown([
      ...cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 30),
      ...cards.result(result(''), 30),
    ], 30)
    // Nothing wrapped: a row wider than the terminal would break the frame open.
    expect(rows.every(row => row.length <= 30)).toBe(true)
  })
})

describe('review findings', () => {
  it('does not draw a proposed diff for a call that failed', () => {
    // Otherwise a mutation that errored shows its proposal as though it landed, and
    // the error body that says otherwise is suppressed.
    const cards = new ToolCards(tool({
      call: () => ({ card: 'diff', title: 'Edit f.ts', diffs: [{ path: 'f.ts', oldText: 'old', newText: 'new' }] }),
    }), '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const rows = plain(cards.result(result('permission denied', { isError: true }), COLUMNS))
    expect(rows.join('\n')).not.toContain('+ new')
    expect(rows.join('\n')).toContain('permission denied')
  })

  it('drops the delimiter that ends command output rather than drawing a blank row', () => {
    // A trailing newline terminates the last line; keeping it added an empty row
    // inside the frame, and at the compact boundary reported a hidden line when
    // nothing had been hidden.
    const six = 'a\nb\nc\nd\ne\nf\n'
    const rows = draw(tool({ result: () => ({ card: 'terminal', output: six, exitCode: 0 }) }))
    expect(rows.join('\n')).not.toContain('more lines')
    // No empty framed row: the body is exactly the six lines the command printed.
    expect(rows.filter(row => /^\s*\u2502\s*\u2502\s*$/u.test(row))).toHaveLength(0)
  })

  it('measures command output with tabs at their real width', () => {
    // escapeControls expands tabs, so a framed row of tabular output no longer pads
    // to the wrong width and shifts its right border.
    const rows = draw(tool({ result: () => ({ card: 'terminal', output: 'a\tb\tc', exitCode: 0 }) }), { detail: 'full' })
    const framed = rows.filter(row => row.includes('\u2502'))
    expect(framed.length).toBeGreaterThan(0)
    // Every framed row the same display width means the right border did not shift.
    expect(new Set(framed.map(row => displayWidth(row))).size).toBe(1)
    expect(rows.join('')).not.toContain('\t')
  })

  it('reports match rows its own budget dropped', () => {
    // The card's budget is separate from the tool's `truncated` flag, so without a
    // marker a card can hide matches while reporting a complete result.
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `file${String(i)}.ts`,
      matches: [{ lineNumber: 1, line: 'hit' }],
    }))
    const rows = draw(tool({
      result: () => ({ card: 'search', shape: 'matches', files, truncated: false, total: 12 }),
    }))
    expect(rows.at(-1)).toMatch(/more rows$/u)
  })

  it('spends one row budget across every file of a bulk mutation', () => {
    // A per-file budget let a bulk change emit a header plus six rows for each of
    // hundreds of files, which is the opposite of what the cap is for.
    const diffs = Array.from({ length: 40 }, (_, i) => ({
      path: `f${String(i)}.ts`,
      oldText: 'old',
      newText: 'new',
    }))
    const rows = draw(tool({ result: () => ({ card: 'diff', diffs }) }))
    expect(rows.filter(row => row.includes('+ new')).length).toBeLessThanOrEqual(COMPACT_BUDGET)
    expect(rows.at(-1)).toMatch(/more changed lines in \d+ more files$/u)
  })

  it('keeps unchanged lines between two edits out of the changed set', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'diff',
        diffs: [{ path: 'f.ts', oldText: 'a\nx\nkeep\ny\nz', newText: 'a\nX\nkeep\nY\nz' }],
      }),
    }))
    expect(rows.join('\n')).not.toContain('keep')
    expect(rows.filter(row => row.trim().startsWith('-'))).toHaveLength(2)
    expect(rows.filter(row => row.trim().startsWith('+'))).toHaveLength(2)
  })

  it('invents no added line when a mutation clears a file', () => {
    const rows = draw(tool({
      result: () => ({ card: 'diff', diffs: [{ path: 'f.ts', oldText: 'a\nb', newText: '' }] }),
    }))
    expect(rows.filter(row => row.trim().startsWith('+'))).toHaveLength(0)
    expect(rows.filter(row => row.trim().startsWith('-'))).toHaveLength(2)
  })
})

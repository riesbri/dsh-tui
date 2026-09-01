/** Harness Todo projection adapter and bounded terminal presentation tests. */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, TodoItem } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { displayWidth, Screen, stripAnsi, wrapToWidth } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { SessionProjectionObserver } from '../src/projections/observer.ts'
import { createTodoOverlay } from '../src/todos/overlay.ts'
import { todoReading, todoSummary } from '../src/todos/model.ts'

/** Mount the real Todo domain beside the real registry, without a TUI fold. */
async function mountTodoProjection(ctx: Context): Promise<void> {
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
}

/** Create a live session with the actual Harness Todo projection mounted. */
async function harness(): Promise<{ ctx: Context; session: Session; observer: SessionProjectionObserver }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await mountTodoProjection(ctx)
  const session = ctx.sessions.create()
  const observer = new SessionProjectionObserver({ registry: ctx.sessionProjections, session, invalidate: () => {} })
  return { ctx, session, observer }
}

/** Render a Todo overlay for a fixed reading. */
function overlay(reading: ReturnType<typeof todoReading>) {
  return createTodoOverlay({ reading: () => reading, close: () => {} })
}

describe('Harness Todo projection adapter', () => {
  it('distinguishes missing infrastructure, an unregistered key, null, and an empty current list', () => {
    const session = { id: 'todos' } as Session
    const absent = new SessionProjectionObserver({ registry: undefined, session, invalidate: () => {} })
    expect(todoReading(absent.snapshot())).toEqual({ kind: 'projections-unavailable' })

    const unregistered = new SessionProjectionObserver({
      registry: { snapshot: () => ({ asOfSeq: -1, values: {} }), onChanged: () => () => {} } as never,
      session,
      invalidate: () => {},
    })
    expect(todoReading(unregistered.snapshot())).toEqual({ kind: 'unregistered' })

    const none = new SessionProjectionObserver({
      registry: { snapshot: () => ({ asOfSeq: -1, values: { todos: null } }), onChanged: () => () => {} } as never,
      session,
      invalidate: () => {},
    })
    const empty = new SessionProjectionObserver({
      registry: { snapshot: () => ({ asOfSeq: -1, values: { todos: [] } }), onChanged: () => () => {} } as never,
      session,
      invalidate: () => {},
    })
    expect(todoReading(none.snapshot())).toEqual({ kind: 'none' })
    expect(todoReading(empty.snapshot())).toEqual({ kind: 'empty' })
  })

  it('uses the real Harness Todo projection, preserves order, and supports parallel active items', async () => {
    const { session, observer } = await harness()
    const todos: TodoItem[] = [
      { content: 'first', status: 'pending' },
      { content: 'second', status: 'in_progress' },
      { content: 'third', status: 'completed' },
      { content: 'fourth', status: 'in_progress' },
    ]
    session.append('todo/write', { todos })
    expect(todoReading(observer.snapshot())).toEqual({ kind: 'list', items: todos })
    expect(todoSummary(todoReading(observer.snapshot()))).toBe('todo 1/4')
    observer.dispose()
  })

  it('accepts Harness lifecycle clearing rather than retaining a TUI list', async () => {
    const { session, observer } = await harness()
    session.append('todo/write', { todos: [{ content: 'done', status: 'completed' }] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(todoReading(observer.snapshot()).kind).toBe('list')
    session.append('turn/start', { turn: 2 })
    expect(todoReading(observer.snapshot())).toEqual({ kind: 'none' })
    observer.dispose()
  })

  it('cold-folds a historical list after the real projection unit mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    // The registry does not exist yet, so no cell can have observed this write.
    session.append('todo/write', { todos: [{ content: 'historical', status: 'pending' }] })
    await mountTodoProjection(ctx)
    const observer = new SessionProjectionObserver({ registry: ctx.sessionProjections, session, invalidate: () => {} })
    expect(todoReading(observer.snapshot())).toEqual({
      kind: 'list', items: [{ content: 'historical', status: 'pending' }],
    })
    observer.dispose()
  })

  it('cold-folds a later turn start instead of resurrecting a historical list', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    // Both events predate the registry, so this first snapshot must use Harness's
    // lazy history fold rather than a cell driven by the live event listener.
    session.append('todo/write', { todos: [{ content: 'older', status: 'completed' }] })
    session.append('turn/start', { turn: 2 })
    await mountTodoProjection(ctx)
    const observer = new SessionProjectionObserver({ registry: ctx.sessionProjections, session, invalidate: () => {} })
    expect(todoReading(observer.snapshot())).toEqual({ kind: 'none' })
    observer.dispose()
  })
})

describe('the Todo live-region overlay', () => {
  it('uses each status mark, preserves order, and stays bounded for long lists', () => {
    const items: TodoItem[] = [
      { content: 'pending first', status: 'pending' },
      { content: 'active second', status: 'in_progress' },
      { content: 'done third', status: 'completed' },
      ...Array.from({ length: 20 }, (_, index): TodoItem => ({ content: `later ${String(index)}`, status: 'pending' })),
    ]
    const lines = overlay({ kind: 'list', items }).render(48, 10)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('○ pending first')
    expect(plain).toContain('● active second')
    expect(plain).toContain('✓ done third')
    expect(plain).toContain('… +')
    expect(plain.indexOf('pending first')).toBeLessThan(plain.indexOf('active second'))
    expect(lines.flatMap(line => wrapToWidth(line, 48))).toHaveLength(10)
  })

  it('fits every state into narrow and short terminals', () => {
    const readings = [
      { kind: 'projections-unavailable' } as const,
      { kind: 'unregistered' } as const,
      { kind: 'none' } as const,
      { kind: 'empty' } as const,
      { kind: 'list', items: [{ content: '非常に長い項目😀\u001b[2J\nnext\titem', status: 'in_progress' as const }] },
    ]
    for (const reading of readings) {
      for (const columns of [8, 14, 20, 30]) {
        for (const rows of [1, 2, 4, 8, 12]) {
          const lines = overlay(reading).render(columns, rows)
          expect(lines.flatMap(line => wrapToWidth(line, columns)).length, `${String(columns)}x${String(rows)}`)
            .toBeLessThanOrEqual(rows)
        }
      }
    }
  })

  it('uses one meaningful compact row without duplicate close help', () => {
    const states = [
      [{ kind: 'projections-unavailable' } as const, 'Todos unavailable'],
      [{ kind: 'unregistered' } as const, 'Todo unavailable'],
      [{ kind: 'none' } as const, 'No active todos'],
      [{ kind: 'empty' } as const, 'Todo list empty'],
      [{ kind: 'list', items: [
        { content: 'done', status: 'completed' as const },
        { content: 'next', status: 'pending' as const },
      ] }, 'Todos 1/2'],
    ] as const
    for (const [reading, expected] of states) {
      const lines = overlay(reading).render(80, 3).map(stripAnsi)
      expect(lines).toEqual([expect.stringContaining(expected)])
      expect(lines[0]?.match(/esc close/gu)).toHaveLength(1)
    }
  })

  it('keeps compact close help atomic on a tiny terminal', () => {
    expect(overlay({ kind: 'none' }).render(3, 1).map(stripAnsi)).toEqual(['esc'])
    expect(overlay({ kind: 'none' }).render(2, 1)).toEqual([])
  })

  it('frames one content row at exactly four rows and falls back below it', () => {
    // TODO_FIXED_ROWS is 3 (blank plus two borders), so the framed form needs
    // exactly one body row — 4 rows total — and 3 rows must use the compact
    // fallback instead.
    const lines = overlay({ kind: 'list', items: [{ content: 'done', status: 'completed' as const }] }).render(80, 4).map(stripAnsi)
    expect(lines).toHaveLength(4)
    expect(lines[1]).toMatch(/^╭─ dshline/u)
    expect(lines.join('\n')).toContain('✓ done')
    expect(lines.at(-1)).toMatch(/^╰─ esc close .*─╯$/u)
    const compact = overlay({ kind: 'none' }).render(80, 3).map(stripAnsi)
    expect(compact).not.toContain('╭')
  })

  it('neutralizes controls before styling and measures CJK and emoji by columns', () => {
    const lines = overlay({
      kind: 'list',
      items: [{ content: '审查😀\u001b[2J\nnext\titem', status: 'in_progress' }],
    }).render(30, 10)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('审查😀^[')
    expect(plain).toContain('^J')
    expect(plain).not.toContain('\t')
    expect(lines.every(line => displayWidth(line) <= 30)).toBe(true)
  })

  it('closes on Escape and leaves ctrl-d for the runner', () => {
    let closed = 0
    const instance = createTodoOverlay({ reading: () => ({ kind: 'none' }), close: () => { closed += 1 } })
    instance.handleKey({ kind: 'key', name: 'ctrl-d' })
    expect(closed).toBe(0)
    instance.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(1)
  })

  it('closes without rewriting committed native scrollback', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()
    let instance!: ReturnType<typeof createTodoOverlay>
    const draw = (): void => { screen.setLive(instance.render(60, 12)) }
    instance = createTodoOverlay({
      reading: () => ({ kind: 'list', items: [{ content: 'observe Harness', status: 'pending' }] }),
      close: () => { screen.setLive(['composer', 'status']) },
    })
    draw()
    instance.handleKey({ kind: 'key', name: 'escape' })
    const after = await emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row')))
      .toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.join('\n')).not.toContain('Todos')
  })

  it('does not depend on tool cards, tool calls, or a Todo mutation path', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const source = sourceFiles(`${root}src/todos`).map(path => readFileSync(path, 'utf8')).join('\n')
    expect(source).not.toMatch(/ToolCards|session\.append|ctx\.tools|todo_write/u)
  })
})

/** Find production adapter files without scanning tests that name forbidden paths. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

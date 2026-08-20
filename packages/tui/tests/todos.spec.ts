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
import { displayWidth, Screen, stripAnsi, wrapToWidth } from '@riesbri/dsh-tui-renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { SessionProjectionObserver } from '../src/projections/observer.ts'
import { createTodoOverlay } from '../src/todos/overlay.ts'
import { todoReading, todoSummary } from '../src/todos/model.ts'

/** Mount the actual Harness registry and Todo projection, without a TUI fold. */
async function harness(): Promise<{ ctx: Context; session: Session; observer: SessionProjectionObserver }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  const session = ctx.sessions.create()
  const observer = new SessionProjectionObserver({
    registry: ctx.sessionProjections,
    session,
    invalidate: () => {},
  })
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
    expect(todoReading(absent)).toEqual({ kind: 'projections-unavailable' })

    const unregistered = new SessionProjectionObserver({
      registry: { snapshot: () => ({ asOfSeq: -1, values: {} }), onChanged: () => () => {} } as never,
      session,
      invalidate: () => {},
    })
    expect(todoReading(unregistered)).toEqual({ kind: 'unregistered' })

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
    expect(todoReading(none)).toEqual({ kind: 'none' })
    expect(todoReading(empty)).toEqual({ kind: 'empty' })
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
    expect(todoReading(observer)).toEqual({ kind: 'list', items: todos })
    expect(todoSummary(todoReading(observer))).toBe('todo 1/4')
    observer.dispose()
  })

  it('accepts Harness lifecycle clearing rather than retaining a TUI list', async () => {
    const { session, observer } = await harness()
    session.append('todo/write', { todos: [{ content: 'done', status: 'completed' }] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(todoReading(observer).kind).toBe('list')
    session.append('turn/start', { turn: 2 })
    expect(todoReading(observer)).toEqual({ kind: 'none' })
    observer.dispose()
  })

  it('folds historical Todo events through the real registry on a first snapshot', async () => {
    const { ctx, session, observer } = await harness()
    session.append('todo/write', { todos: [{ content: 'historical', status: 'pending' }] })
    observer.dispose()
    const resumed = new SessionProjectionObserver({ registry: ctx.sessionProjections, session, invalidate: () => {} })
    expect(todoReading(resumed)).toEqual({
      kind: 'list', items: [{ content: 'historical', status: 'pending' }],
    })
    resumed.dispose()
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

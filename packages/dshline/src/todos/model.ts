/** Presentation-facing reading of the Harness-owned `todos` projection. */

import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { SessionProjectionObserver } from '../projections/observer.ts'

/** One current Todo reading the terminal can present. */
export type TodoReading =
  | { readonly kind: 'projections-unavailable' }
  | { readonly kind: 'unregistered' }
  | { readonly kind: 'none' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'list'; readonly items: readonly TodoItem[] }

/**
 * Read the current Todo value from the authoritative generic snapshot.
 *
 * Projection registrations are process-wide, so a key's presence says nothing
 * about whether this exact agent mounted the tool. The value is deliberately
 * presented only as the projection contract describes it.
 * @param observer - the session-scoped generic projection observer.
 * @returns the small terminal-facing Todo reading.
 */
export function todoReading(observer: SessionProjectionObserver): TodoReading {
  const snapshot = observer.snapshot()
  if (snapshot === undefined) return { kind: 'projections-unavailable' }
  // `undefined` is the typed absence of an unregistered process-wide unit;
  // `null` is the Todo domain's distinct no-current-list value.
  const todos = snapshot.values.todos
  if (todos === undefined) return { kind: 'unregistered' }
  if (todos === null) return { kind: 'none' }
  if (todos.length === 0) return { kind: 'empty' }
  return { kind: 'list', items: todos }
}

/**
 * Build the compact completed/total status segment from a current Todo list.
 * @param reading - the current projection reading.
 * @returns an indivisible status segment, or undefined without a non-empty list.
 */
export function todoSummary(reading: TodoReading): string | undefined {
  if (reading.kind !== 'list') return undefined
  const completed = reading.items.filter(item => item.status === 'completed').length
  return `todo ${String(completed)}/${String(reading.items.length)}`
}

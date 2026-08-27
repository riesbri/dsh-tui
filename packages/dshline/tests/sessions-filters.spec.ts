/** Tests for pure Sessions-filter vocabulary and Harness translation. */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ageWindowRange,
  applyOrigin,
  NO_FILTERS,
  sessionFilterClauses,
} from '../src/sessions/filters.ts'
import type { SessionEntry } from '../src/sessions/model.ts'

/** One day in the units Harness time ranges use. */
const DAY = 24 * 60 * 60 * 1_000
/** A stable instant with non-midnight local time in every ordinary time zone. */
const NOW = new Date(2026, 7, 27, 15, 14, 13, 120).getTime()

/**
 * One origin-classifiable entry.
 * @param id - session id.
 * @param origin - presentation origin.
 * @param parent - recorded parent, when this is a fork.
 * @returns the entry.
 */
function entry(
  id: string,
  origin: SessionEntry['origin'],
  parent?: SessionId,
): SessionEntry {
  return {
    id: id as SessionId,
    title: undefined,
    createdAt: NOW,
    cwd: '/work',
    live: false,
    persisted: true,
    parent,
    origin,
  }
}

describe('translating Sessions filters', () => {
  it('emits exact-workspace clauses only when current has an effective workspace', () => {
    expect(sessionFilterClauses({ ...NO_FILTERS, workspace: 'current' }, '/work', NOW))
      .toEqual([{ kind: 'cwd', values: ['/work'] }])
    expect(sessionFilterClauses({ ...NO_FILTERS, workspace: 'current' }, undefined, NOW)).toEqual([])
    expect(sessionFilterClauses(NO_FILTERS, '/work', NOW)).toEqual([])
  })

  it('anchors today at local midnight with an inclusive upper boundary', () => {
    const midnight = new Date(NOW)
    midnight.setHours(0, 0, 0, 0)
    expect(ageWindowRange('today', NOW)).toEqual({ from: midnight.getTime(), to: NOW })
  })

  it('uses inclusive rolling edges for seven and thirty days', () => {
    expect(ageWindowRange('7d', NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW })
    expect(ageWindowRange('30d', NOW)).toEqual({ from: NOW - 30 * DAY, to: NOW })
    expect(ageWindowRange('all', NOW)).toBeUndefined()
  })

  it('combines workspace and age as separate ANDed clauses', () => {
    expect(sessionFilterClauses({ workspace: 'current', origin: 'delegated', age: '7d' }, '/work', NOW))
      .toEqual([
        { kind: 'cwd', values: ['/work'] },
        { kind: 'created-at', from: NOW - 7 * DAY, to: NOW },
      ])
  })

  it('translates the empty value to no Harness clauses', () => {
    expect(sessionFilterClauses(NO_FILTERS, '/work', NOW)).toEqual([])
  })
})

describe('applying presentation origin', () => {
  const ordinary = entry('own', 'own')
  const fork = entry('fork', 'own', 'own' as SessionId)
  const delegated = entry('delegated', 'delegated', 'own' as SessionId)
  const entries = [ordinary, fork, delegated]

  it('keeps ordinary sessions and forks as own, in Harness order', () => {
    expect(applyOrigin(entries, 'own')).toEqual([ordinary, fork])
  })

  it('keeps only explicitly delegated sessions', () => {
    expect(applyOrigin(entries, 'delegated')).toEqual([delegated])
  })

  it('returns the unchanged listing when origin is all', () => {
    expect(applyOrigin(entries, 'all')).toBe(entries)
  })
})

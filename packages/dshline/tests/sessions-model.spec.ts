/** Tests for the vocabulary a session browser needs before it draws anything. */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEntry } from '../src/sessions/model.ts'
import {
  filterEntries,
  matchesQuery,
  relativeAge,
  sessionLabel,
  shortWorkspace,
  UNTITLED,
} from '../src/sessions/model.ts'

/** A fixed clock, so every age assertion is exact. */
const NOW = 1_800_000_000_000

/**
 * One listable session with only the facts a test cares about.
 * @param overrides - fields to replace.
 * @returns the entry.
 */
function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'dshline-1' as SessionId,
    title: 'Fix the wrap bug',
    createdAt: NOW,
    cwd: '/home/dev/projects/dshline',
    live: false,
    persisted: true,
    parent: undefined,
    origin: 'own',
    ...overrides,
  }
}

describe('how old a session reads', () => {
  it('steps through minutes, hours, days, and weeks', () => {
    expect(relativeAge(NOW, NOW)).toBe('just now')
    expect(relativeAge(NOW - 90_000, NOW)).toBe('2m ago')
    expect(relativeAge(NOW - 59 * 60_000, NOW)).toBe('59m ago')
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(relativeAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
    expect(relativeAge(NOW - 21 * 86_400_000, NOW)).toBe('3w ago')
  })

  it('reads a clock skewed into the future as just now', () => {
    // A persisted header carries the timestamp of whichever machine wrote it, so
    // a negative age is reachable. "in -2m" is worse than saying nothing precise.
    expect(relativeAge(NOW + 120_000, NOW)).toBe('just now')
  })
})

describe('what a row is called', () => {
  it('uses the folded title', () => {
    expect(sessionLabel(entry())).toBe('Fix the wrap bug')
  })

  it('names an untitled session without pretending it has a title', () => {
    // The placeholder is a RENDERING choice: the entry keeps `undefined`, so the
    // matcher below cannot report a hit on the word "untitled".
    expect(sessionLabel(entry({ title: undefined }))).toBe(UNTITLED)
    expect(sessionLabel(entry({ title: '   ' }))).toBe(UNTITLED)
  })
})

describe('shortening a workspace', () => {
  it('replaces the home prefix, which never distinguishes two rows', () => {
    expect(shortWorkspace('/home/dev/projects/dshline', '/home/dev')).toBe('~/projects/dshline')
  })

  it('shortens the home directory itself', () => {
    expect(shortWorkspace('/home/dev', '/home/dev')).toBe('~')
  })

  it('leaves a path that only shares a prefix segment alone', () => {
    // `/home/developer` starts with `/home/dev` as a STRING but is a different
    // directory; abbreviating it would name a folder the session never used.
    expect(shortWorkspace('/home/developer/work', '/home/dev')).toBe('/home/developer/work')
  })

  it('answers nothing for a header with no workspace', () => {
    expect(shortWorkspace(undefined, '/home/dev')).toBeUndefined()
  })

  it('leaves the path alone when the home directory is unknown', () => {
    expect(shortWorkspace('/srv/build', undefined)).toBe('/srv/build')
  })
})

describe('matching a typed query', () => {
  it('matches the title case-insensitively', () => {
    expect(matchesQuery(entry(), 'WRAP')).toBe(true)
  })

  it('matches the workspace, which is often what a reader remembers', () => {
    expect(matchesQuery(entry({ title: 'untitled work' }), 'dshline')).toBe(true)
  })

  it('matches the id, so a pasted id finds its session', () => {
    expect(matchesQuery(entry({ id: 'dshline-abc-123' as SessionId }), 'abc-123')).toBe(true)
  })

  it('collapses whitespace runs on both sides', () => {
    // A title folded out of a wrapped prompt can carry a newline where the reader
    // types one space.
    expect(matchesQuery(entry({ title: 'Fix   the\nwrap bug' }), 'fix the wrap')).toBe(true)
  })

  it('does not match the untitled placeholder', () => {
    expect(matchesQuery(entry({ title: undefined }), 'untitled')).toBe(false)
  })

  it('matches everything for an empty or blank query', () => {
    expect(matchesQuery(entry(), '')).toBe(true)
    expect(matchesQuery(entry(), '   ')).toBe(true)
  })
})

describe('filtering a listing', () => {
  const listing = [
    entry({ id: 'a' as SessionId, title: 'Roadmap review' }),
    entry({ id: 'b' as SessionId, title: 'Fix the wrap bug' }),
    entry({ id: 'c' as SessionId, title: 'Wrap CJK correctly' }),
  ]

  it('keeps Harness order rather than ranking by its own idea of relevance', () => {
    // Newest-first is the corpus's order. Re-sorting here would invent a ranking
    // the corpus never agreed to; asking for one is what the content tier is for.
    expect(filterEntries(listing, 'wrap').map(match => match.id)).toEqual(['b', 'c'])
  })

  it('returns the same listing for an empty query', () => {
    expect(filterEntries(listing, '')).toBe(listing)
  })

  it('returns nothing rather than everything when nothing matches', () => {
    expect(filterEntries(listing, 'attachments')).toEqual([])
  })
})

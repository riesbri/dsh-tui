/**
 * The `/skills` inspector: what it shows, what it refuses to promise, and the
 * one thing it writes.
 *
 * It is an inspector and a Composer launcher, never an executor — so the
 * assertions here are about rows, truthful slashes, and the literal text Enter
 * hands back. Nothing in this file loads a skill, because nothing in the
 * overlay can.
 */

import { describe, expect, it } from 'vitest'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { createSkillsOverlay } from '../src/skills/overlay.ts'
import type { SkillCatalogReading } from '../src/skills/catalog.ts'
import type { SkillView } from '../src/skills/model.ts'

/**
 * One skill view with the usual defaults.
 * @param over - the fields this case cares about.
 * @returns a complete view.
 */
function skill(over: Partial<SkillView> & { name: string }): SkillView {
  return {
    description: `${over.name} description`,
    userInvocable: true,
    modelInvocable: true,
    source: 'project-dsh',
    ...over,
  }
}

/** The catalog every case below inspects unless it says otherwise. */
const CATALOG: readonly SkillView[] = [
  skill({ name: 'api-review', description: 'Review API changes and compatibility' }),
  skill({ name: 'architecture', description: 'Architecture decision guidance', userInvocable: false }),
  skill({ name: 'debug-ci', description: 'Investigate failing CI', source: 'project-agents' }),
  skill({ name: 'quiet', description: 'Loadable by neither', userInvocable: false, modelInvocable: false }),
  skill({
    name: 'review-pr',
    description: 'Review a pull request',
    whenToUse: 'Before approving or merging a meaningful code change',
  }),
  skill({ name: 'sessions', description: 'A skill a command already claims', source: 'custom' }),
]

/** What one opened inspector reports back. */
interface Opened {
  readonly rows: (columns?: number, rows?: number) => string[]
  readonly press: (key: Key) => void
  readonly type: (text: string) => void
  readonly inserted: () => string | undefined
  readonly closed: () => boolean
}

/**
 * Open the inspector over one reading.
 * @param reading - the catalog state to inspect.
 * @param commandNames - names the command registries claim.
 * @returns handles for driving and reading it.
 */
function open(
  reading: SkillCatalogReading,
  commandNames: readonly string[] = ['sessions'],
): Opened {
  let inserted: string | undefined
  let closed = false
  const overlay = createSkillsOverlay({
    reading: () => reading,
    commandNames: () => commandNames,
    insert: name => { inserted = name },
    close: () => { closed = true },
    invalidate: () => {},
  })
  return {
    rows: (columns = 88, rows = 26) => overlay.render(columns, rows).map(stripAnsi),
    press: key => { overlay.handleKey(key) },
    type: text => { overlay.handleKey({ kind: 'text', text }) },
    inserted: () => inserted,
    closed: () => closed,
  }
}

/** A ready reading over the shared catalog. */
const ready: SkillCatalogReading = { kind: 'ready', skills: CATALOG, stale: false, refreshing: false }

/**
 * The heading row: after the leading blank and the frame's top border.
 * @param rows - rendered rows.
 * @returns the heading.
 */
function heading(rows: readonly string[]): string {
  return rows[2] ?? ''
}

/**
 * The body row a name appears on.
 * @param rows - rendered rows.
 * @param name - the skill name.
 * @returns the row, or undefined.
 */
function rowFor(rows: readonly string[], name: string): string | undefined {
  return rows.find(row => new RegExp(`(^|[\\s/])${name}(\\s|$)`, 'u').test(row))
}

describe('the catalog it shows', () => {
  it('lists every invocation combination, not only the launchable ones', () => {
    const rows = open(ready).rows()
    for (const name of ['api-review', 'architecture', 'debug-ci', 'quiet', 'review-pr', 'sessions']) {
      expect(rowFor(rows, name), name).toBeDefined()
    }
  })

  it('gives a slash only to the names the leading gesture reaches', () => {
    const rows = open(ready).rows()
    expect(rowFor(rows, 'review-pr')).toContain('/review-pr')
    // Model-only, so a slash would promise a gesture Harness never honours.
    expect(rowFor(rows, 'architecture')).not.toContain('/architecture')
    // Shadowed by the `/sessions` command, which wins the line client-side.
    expect(rowFor(rows, 'sessions')).not.toContain('/sessions')
  })

  it('counts what is available', () => {
    expect(heading(open(ready).rows())).toContain('Skills · 6 available')
  })
})

describe('the selected detail', () => {
  it('shows the description, who may invoke it, its source, and when to use it', () => {
    const view = open(ready)
    // api-review, architecture, debug-ci, quiet, review-pr
    for (let index = 0; index < 4; index += 1) view.press({ kind: 'key', name: 'down' })
    const rows = view.rows()
    expect(rows.some(row => row.includes('Review a pull request'))).toBe(true)
    expect(rows.some(row => row.includes('Available to') && row.includes('you + model'))).toBe(true)
    expect(rows.some(row => row.includes('Source') && row.includes('project'))).toBe(true)
    expect(rows.some(row => row.includes('When to use') && row.includes('Before approving'))).toBe(true)
  })

  it('omits whenToUse when the summary carries none', () => {
    const view = open(ready)
    expect(view.rows().some(row => row.includes('When to use'))).toBe(false)
  })

  it('says why a shadowed skill cannot be launched', () => {
    const view = open(ready)
    for (let index = 0; index < 5; index += 1) view.press({ kind: 'key', name: 'down' })
    expect(view.rows().some(row => row.includes('shadowed by a command'))).toBe(true)
  })

  it('says a model-only skill is the model’s to load', () => {
    const view = open(ready)
    view.press({ kind: 'key', name: 'down' })
    expect(view.rows().some(row => row.includes('the model loads this one'))).toBe(true)
  })

  it('never shows the provider, the rank, the locator, or a path', () => {
    const rows = open(ready).rows().join('\n')
    for (const leak of ['provider', 'rank', 'locator', 'resourceBase', 'SKILL.md']) {
      expect(rows.toLowerCase()).not.toContain(leak.toLowerCase())
    }
  })
})

describe('what Enter does', () => {
  it('hands back the literal name for an eligible skill and closes', () => {
    const view = open(ready)
    for (let index = 0; index < 4; index += 1) view.press({ kind: 'key', name: 'down' })
    view.press({ kind: 'key', name: 'enter' })
    expect(view.inserted()).toBe('review-pr')
    expect(view.closed()).toBe(true)
  })

  it('refuses a model-only skill, with a notice and no close', () => {
    const view = open(ready)
    view.press({ kind: 'key', name: 'down' })
    view.press({ kind: 'key', name: 'enter' })
    expect(view.inserted()).toBeUndefined()
    expect(view.closed()).toBe(false)
    expect(view.rows().some(row => row.includes('not invocable by a person'))).toBe(true)
  })

  it('refuses a command-shadowed skill and says which gesture wins', () => {
    const view = open(ready)
    for (let index = 0; index < 5; index += 1) view.press({ kind: 'key', name: 'down' })
    view.press({ kind: 'key', name: 'enter' })
    expect(view.inserted()).toBeUndefined()
    expect(view.rows().some(row => row.includes('runs the command of that name'))).toBe(true)
  })
})

describe('filtering and selection', () => {
  it('narrows the list as characters arrive', () => {
    const view = open(ready)
    view.type('rev')
    const rows = view.rows()
    expect(heading(rows)).toContain('Skills · 2 matches')
    expect(heading(rows)).toContain('filter: rev')
    expect(rowFor(rows, 'debug-ci')).toBeUndefined()
  })

  it('says so when a filter matches nothing', () => {
    const view = open(ready)
    view.type('zzz')
    expect(view.rows().some(row => row.includes('No skill matches zzz'))).toBe(true)
  })

  it('takes the filter back before it takes the view', () => {
    const view = open(ready)
    view.type('rev')
    view.press({ kind: 'key', name: 'escape' })
    expect(view.closed()).toBe(false)
    expect(heading(view.rows())).toContain('6 available')
    view.press({ kind: 'key', name: 'escape' })
    expect(view.closed()).toBe(true)
  })

  it('selects with the arrows, wrapping at both ends', () => {
    const view = open(ready)
    view.press({ kind: 'key', name: 'up' })
    // Wrapped to the last row, whose detail is the shadowed skill's.
    expect(view.rows().some(row => row.includes('shadowed by a command'))).toBe(true)
  })

  it('deletes one whole character per backspace', () => {
    const view = open(ready)
    view.type('re中')
    view.press({ kind: 'key', name: 'backspace' })
    expect(heading(view.rows())).toContain('filter: re')
  })
})

describe('the states that are not a list', () => {
  it('distinguishes an unavailable capability from an empty one', () => {
    expect(open({ kind: 'unavailable' }).rows().join('\n'))
      .toContain('Skills are unavailable in this composition.')
    expect(open({ kind: 'ready', skills: [], stale: false, refreshing: false }).rows().join('\n'))
      .toContain('No skills are available to this agent.')
  })

  it('says discovery is still running before the first authoritative answer', () => {
    expect(open({ kind: 'loading' }).rows().join('\n')).toContain('Discovering skills…')
  })

  it('keeps showing the catalog while a refresh is in flight', () => {
    const rows = open({ kind: 'ready', skills: CATALOG, stale: true, refreshing: true }).rows()
    expect(rowFor(rows, 'review-pr')).toBeDefined()
    expect(heading(rows)).toContain('refreshing…')
  })

  it('marks an observation that could not complete', () => {
    const rows = open({ kind: 'incomplete', skills: CATALOG }).rows()
    expect(rowFor(rows, 'review-pr')).toBeDefined()
    expect(heading(rows)).toContain('may be incomplete')
  })
})

describe('bounded, wide-character-safe rendering', () => {
  it('never draws more rows than the terminal has', () => {
    for (const rows of [3, 4, 6, 10, 18, 26]) {
      for (const columns of [16, 24, 40, 60, 88, 120]) {
        const drawn = open(ready).rows(columns, rows)
        expect(drawn.length, `${String(columns)}x${String(rows)}`).toBeLessThanOrEqual(rows)
        for (const line of drawn) {
          expect(displayWidth(line), `${String(columns)}x${String(rows)}: ${line}`)
            .toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('measures a CJK description in columns, not characters', () => {
    const wide = [skill({ name: 'review-pr', description: '审查拉取请求的正确性与回归' })]
    const drawn = open({ kind: 'ready', skills: wide, stale: false, refreshing: false }, []).rows(44, 20)
    for (const line of drawn) expect(displayWidth(line)).toBeLessThanOrEqual(44)
    expect(drawn.some(row => row.includes('审查'))).toBe(true)
  })

  it('still says how to leave on a terminal too small to frame', () => {
    expect(open(ready).rows(12, 2).join('')).toContain('esc')
  })
})

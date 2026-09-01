/**
 * Skills in the `/` menu, through the real completion engine.
 *
 * The engine itself learned nothing about skills: the merge is one pure
 * function the attachment hands to `commands()`, which is why these cases can
 * drive the real `createCompletion` with no harness at all.
 */

import { describe, expect, it } from 'vitest'
import { Composer, displayWidth, stripAnsi } from '@dshline/renderer'
import { createCompletion } from '../src/completion.ts'
import type { Completion, CompletionSources } from '../src/completion.ts'
import { slashCandidates } from '../src/skills/model.ts'
import type { SkillView } from '../src/skills/model.ts'

/** Commands both registries offer, in the order the attachment merges them. */
const COMMANDS = [
  { name: 'plugins', description: "Browse the running agent's preset composition" },
  { name: 'sessions', description: 'Browse past sessions' },
  { name: 'skills', description: 'Browse available skills' },
  { name: 'review', description: 'The registered review command' },
]

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

/** A live completion over a composer, plus the catalog it reads. */
interface Wired {
  readonly composer: Composer
  readonly completion: Completion
  /** Replace the catalog the menu reads, as a `skills/change` refetch would. */
  readonly setSkills: (next: readonly SkillView[]) => void
  /** Rendered rows, without styling. */
  readonly rows: () => string[]
}

/**
 * Wire the real engine to a composer over a mutable catalog.
 * @param initial - the catalog to start from.
 * @returns handles for driving it.
 */
function wire(initial: readonly SkillView[]): Wired {
  let catalog = initial
  const composer = new Composer()
  const sources: CompletionSources = {
    commands: () => slashCandidates(COMMANDS, catalog),
    commandArguments: async () => [],
    paths: async () => [],
  }
  const completion = createCompletion(composer, sources, () => {}, () => 1)
  return {
    composer,
    completion,
    setSkills: next => { catalog = next },
    rows: () => completion.view.render(88, 20).map(stripAnsi),
  }
}

/**
 * The names the drawn candidate rows offer.
 *
 * Matched on the row's own shape — two spaces, the selection mark's column,
 * then the slash — so the help line's `tab/enter` is not read as a candidate.
 * @param rows - rendered rows.
 * @returns one name per drawn candidate, in the order they appear.
 */
function offered(rows: readonly string[]): string[] {
  return rows
    .map(row => /^ {2}[\u203a ] \/(?<name>[a-z0-9-]+)/u.exec(row)?.groups?.name)
    .filter((name): name is string => name !== undefined)
}

/** The catalog most cases below complete against. */
const CATALOG: readonly SkillView[] = [
  skill({ name: 'review-pr', description: 'Review a pull request' }),
  skill({ name: 'security', description: 'Review code for security issues' }),
  skill({ name: 'architecture', description: 'Architecture guidance', userInvocable: false }),
  skill({ name: 'review', description: 'A skill the command already claims' }),
  skill({ name: 'release-check', description: 'Validate a release', modelInvocable: false }),
]

describe('the offer', () => {
  it('merges commands and skills into one sorted menu on a bare slash', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/')
    await wired.completion.refresh()
    // The engine shows six rows at a time and says how many it held back, so
    // the assertion is the order of the window plus the truthful marker — not
    // a claim that every candidate is drawn at once.
    expect(offered(wired.rows())).toEqual([
      'plugins', 'release-check', 'review', 'review-pr', 'security', 'sessions',
    ])
    expect(wired.rows().some(row => row.includes('… 1 more'))).toBe(true)
  })

  it('offers this frontend’s own /skills command beside the catalog', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/sk')
    await wired.completion.refresh()
    expect(offered(wired.rows())).toEqual(['skills'])
  })

  it('narrows on a typed prefix', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/rev')
    await wired.completion.refresh()
    const rows = wired.rows()
    expect(rows.some(row => row.includes('/review-pr'))).toBe(true)
    expect(rows.some(row => row.includes('/sessions'))).toBe(false)
  })

  it('offers no skill a person cannot invoke', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/arch')
    await wired.completion.refresh()
    expect(wired.completion.active).toBe(false)
  })

  it('shows a command and its same-named skill as ONE row, the command’s', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/review')
    await wired.completion.refresh()
    const rows = wired.rows().filter(row => /\/review(\s|$)/u.test(row))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('The registered review command')
    expect(rows[0]).not.toContain('skill ·')
  })

  it('labels a skill row as a skill, and a human-only one as such', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/re')
    await wired.completion.refresh()
    const rows = wired.rows()
    expect(rows.find(row => row.includes('/review-pr'))).toContain('skill · Review a pull request')
    expect(rows.find(row => row.includes('/release-check')))
      .toContain('skill · user only · Validate a release')
  })
})

describe('accepting a skill row', () => {
  it('inserts exactly `/name ` and submits nothing', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/review-p')
    await wired.completion.refresh()
    expect(wired.completion.handleKey({ kind: 'key', name: 'tab' })).toBe(true)
    expect(wired.composer.value).toBe('/review-pr ')
    expect(wired.composer.position).toBe('/review-pr '.length)
  })

  it('completes on enter without letting the line be sent', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/review-p')
    await wired.completion.refresh()
    // `true` is the engine CONSUMING the keystroke: the runner never sees an
    // enter to submit on. The exact-token case below is the one that submits.
    expect(wired.completion.handleKey({ kind: 'key', name: 'enter' })).toBe(true)
    expect(wired.composer.value).toBe('/review-pr ')
  })

  it('leaves an exact skill token to the composer, as it does an exact command', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/security')
    await wired.completion.refresh()
    // Nothing longer begins with it, so enter belongs to the submit path — which
    // is what sends the literal to Harness.
    expect(wired.completion.handleKey({ kind: 'key', name: 'enter' })).toBe(false)
  })
})

describe('a catalog that changes underneath the menu', () => {
  it('picks up a newly discovered skill on the recompute the change triggers', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/re')
    await wired.completion.refresh()
    expect(wired.rows().some(row => row.includes('/refactor-guide'))).toBe(false)
    wired.setSkills([...CATALOG, skill({ name: 'refactor-guide', description: 'Guide a refactor' })])
    // Exactly what the attachment does when the catalog reports a change while
    // a menu is standing: recompute through the engine's own generation guard.
    await wired.completion.refresh()
    expect(wired.rows().some(row => row.includes('/refactor-guide'))).toBe(true)
  })

  it('drops a skill that has gone away rather than offering a dead row', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/re')
    await wired.completion.refresh()
    wired.setSkills(CATALOG.filter(entry => entry.name !== 'review-pr'))
    await wired.completion.refresh()
    expect(wired.rows().some(row => row.includes('/review-pr'))).toBe(false)
  })

  it('cannot be revived by a lookup abandoned when the buffer was replaced', async () => {
    const wired = wire(CATALOG)
    wired.composer.set('/re')
    const pending = wired.completion.refresh()
    wired.completion.invalidate()
    await pending
    expect(wired.completion.active).toBe(false)
    expect(wired.rows()).toEqual([])
  })
})

describe('bounded rows', () => {
  it('fits a CJK description into the terminal’s columns', async () => {
    const wired = wire([skill({ name: 'review-pr', description: '审查拉取请求的正确性与回归，并检查缺失的测试' })])
    wired.composer.set('/rev')
    await wired.completion.refresh()
    for (const columns of [24, 40, 60, 88]) {
      for (const line of wired.completion.view.render(columns, 20).map(stripAnsi)) {
        expect(displayWidth(line), `${String(columns)}: ${line}`).toBeLessThanOrEqual(columns)
      }
    }
  })
})

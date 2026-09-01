/**
 * The presentation rules over one resolved Harness skill catalog.
 *
 * Everything asserted here is a dshline decision — which rows the slash menu
 * offers, which name carries a slash, how a source reads. Precedence,
 * duplicate providers, and discovery are Harness's and are exercised against
 * the real registry in `skills-catalog.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  filterSkillRows,
  invocationLabel,
  skillNote,
  skillRows,
  slashCandidates,
  sourceLabel,
} from '../src/skills/model.ts'
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

describe('source presentation', () => {
  it('collapses both project roots and both user roots to one word each', () => {
    expect(sourceLabel('project-dsh')).toBe('project')
    expect(sourceLabel('project-agents')).toBe('project')
    expect(sourceLabel('user-dsh')).toBe('user')
    expect(sourceLabel('user-agents')).toBe('user')
  })

  it('keeps the buckets that already read as themselves', () => {
    expect(sourceLabel('bundled')).toBe('bundled')
    expect(sourceLabel('runtime')).toBe('runtime')
    expect(sourceLabel('custom')).toBe('custom')
  })

  it('passes an unknown future source through rather than bucketing it', () => {
    // `SkillSource` is deliberately open, so a provider Harness gains tomorrow
    // must read as itself instead of being mislabelled `custom`.
    expect(sourceLabel('marketplace')).toBe('marketplace')
  })
})

describe('invocation presentation', () => {
  it('names all four combinations Harness keeps', () => {
    expect(invocationLabel(skill({ name: 'both' }))).toBe('you + model')
    expect(invocationLabel(skill({ name: 'u', modelInvocable: false }))).toBe('you only')
    expect(invocationLabel(skill({ name: 'm', userInvocable: false }))).toBe('model only')
    expect(invocationLabel(skill({ name: 'n', userInvocable: false, modelInvocable: false })))
      .toBe('neither')
  })
})

describe('the slash menu', () => {
  const commands = [
    { name: 'sessions', description: 'Browse past sessions' },
    { name: 'plugins', description: "Browse the running agent's preset composition" },
  ]

  it('offers user-invocable skills beside the commands, sorted by name', () => {
    const rows = slashCandidates(commands, [
      skill({ name: 'security', description: 'Review code for security issues' }),
      skill({ name: 'review-pr', description: 'Review a pull request' }),
    ])
    expect(rows.map(row => row.name)).toEqual(['plugins', 'review-pr', 'security', 'sessions'])
    expect(rows.find(row => row.name === 'review-pr')?.description)
      .toBe('skill · Review a pull request')
  })

  it('omits a skill no person can invoke', () => {
    const rows = slashCandidates(commands, [
      skill({ name: 'architecture', userInvocable: false }),
      skill({ name: 'neither', userInvocable: false, modelInvocable: false }),
    ])
    expect(rows.map(row => row.name)).toEqual(['plugins', 'sessions'])
  })

  it('marks a human-only skill, as the Harness Web menu does', () => {
    expect(skillNote(skill({ name: 'release-check', description: 'Validate a release', modelInvocable: false })))
      .toBe('skill · user only · Validate a release')
  })

  it('says only `skill` when the summary carries no description', () => {
    expect(skillNote(skill({ name: 'bare', description: '' }))).toBe('skill')
  })

  it('gives a command the name outright and lists it once', () => {
    const rows = slashCandidates(
      [{ name: 'review', description: 'The registered command' }],
      [skill({ name: 'review', description: 'The skill' })],
    )
    expect(rows).toEqual([{ name: 'review', description: 'The registered command' }])
  })
})

describe('the inspector rows', () => {
  it('gives a slash only to a name the leading gesture actually reaches', () => {
    const rows = skillRows([
      skill({ name: 'review-pr' }),
      skill({ name: 'architecture', userInvocable: false }),
      skill({ name: 'review' }),
    ], ['review'])
    expect(rows.map(row => ({ name: row.skill.name, launchable: row.launchable, shadowed: row.shadowed })))
      .toEqual([
        { name: 'review-pr', launchable: true, shadowed: false },
        { name: 'architecture', launchable: false, shadowed: false },
        // Inspectable, but the leading slash runs the command — so the row must
        // not pretend otherwise.
        { name: 'review', launchable: false, shadowed: true },
      ])
  })

  it('keeps model-only and neither-invocable skills in the catalog', () => {
    const rows = skillRows([
      skill({ name: 'model-only', userInvocable: false }),
      skill({ name: 'neither', userInvocable: false, modelInvocable: false }),
    ], [])
    expect(rows).toHaveLength(2)
  })
})

describe('filtering', () => {
  const rows = skillRows([
    skill({ name: 'review-pr', description: 'Review a pull request', whenToUse: 'Before merging' }),
    skill({ name: 'debug-ci', description: 'Investigate failing CI' }),
    skill({ name: 'security', description: 'Review code for security issues' }),
  ], [])

  it('matches the name', () => {
    expect(filterSkillRows(rows, 'review-p').map(row => row.skill.name)).toEqual(['review-pr'])
  })

  it('matches across both name and description in one pass', () => {
    // `rev` is in one name and in two descriptions; a reader typing it wants
    // every row it could plausibly mean, not only the name hits.
    expect(filterSkillRows(rows, 'rev').map(row => row.skill.name))
      .toEqual(['review-pr', 'security'])
  })

  it('matches the description a reader can see', () => {
    expect(filterSkillRows(rows, 'Review').map(row => row.skill.name))
      .toEqual(['review-pr', 'security'])
  })

  it('matches whenToUse, which the selected detail shows', () => {
    expect(filterSkillRows(rows, 'merging').map(row => row.skill.name)).toEqual(['review-pr'])
  })

  it('returns everything for an empty filter', () => {
    expect(filterSkillRows(rows, '   ')).toHaveLength(3)
  })
})

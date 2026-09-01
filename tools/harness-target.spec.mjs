/**
 * The adopted-target contract, and the semver edge cases a prerelease line
 * makes load-bearing.
 *
 * The range cases below outlived the four tools they were written for: they
 * are the audit findings that proved a caret range can silently stop
 * accepting the line it was written for, which is why this repository checks
 * ranges by hand instead of trusting that they read correctly.
 */

import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import {
  checkPeers,
  compareVersions,
  formatReport,
  isPublished,
  parseTarget,
  parseVersion,
  satisfiesRange,
  targetUpdates,
} from './harness-target.mjs'

describe('parseTarget()', () => {
  it('reads the two fields and ignores comments and blank lines', () => {
    expect(parseTarget([
      '# a comment',
      '',
      'revision b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
      'version 0.1.1-rc.2  # trailing note',
      '',
    ].join('\n'))).toEqual({ revision: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', version: '0.1.1-rc.2' })
  })

  it('refuses anything but a full commit sha, so the blocking lane cannot follow a moving pointer', () => {
    // A branch name or an abbreviated sha would make "the revision we adopted"
    // mean whatever that pointer resolves to on the day CI runs — the exact
    // property the non-blocking upstream lane owns and this one must not have.
    expect(() => parseTarget('revision master\nversion 0.1.1-rc.2\n')).toThrow(/40-character commit sha/)
    expect(() => parseTarget('revision b150a55\nversion 0.1.1-rc.2\n')).toThrow(/40-character commit sha/)
  })

  it('refuses a partial, duplicated, or unknown target rather than guessing', () => {
    expect(() => parseTarget('revision b150a551b8d465e31e418e1b2eaf5e79bbb7d28e\n')).toThrow(/missing version/)
    expect(() => parseTarget('version 0.1.1-rc.2\n')).toThrow(/missing revision/)
    expect(() => parseTarget('version 0.1.1-rc.2\nversion 0.1.2\n')).toThrow(/declared twice/)
    expect(() => parseTarget('channel alpha\n')).toThrow(/unknown field: channel/)
    expect(() => parseTarget('revision b150a551b8d465e31e418e1b2eaf5e79bbb7d28e\nversion not-a-version\n'))
      .toThrow(/unsupported version/)
  })
})

describe('HARNESS_TARGET (the committed file)', () => {
  it('parses, so a malformed edit fails here rather than halfway through a CI job', async () => {
    const target = parseTarget(await readFile(new URL('../HARNESS_TARGET', import.meta.url), 'utf8'))
    expect(target.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(() => parseVersion(target.version)).not.toThrow()
  })

  it('is the only place the adopted revision is written down', async () => {
    // One source of truth is the whole point: a second copy in a workflow or a
    // manifest is a copy that goes stale during the next migration.
    const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const { revision } = parseTarget(await readFile(new URL('../HARNESS_TARGET', import.meta.url), 'utf8'))
    expect(workflow).not.toContain(revision)
    expect(workflow).toContain('harness-target.mjs --revision')
  })
})

describe('compareVersions()', () => {
  it('orders release candidates below their own final release', () => {
    expect(compareVersions(parseVersion('0.1.0-rc.7'), parseVersion('0.1.0'))).toBeLessThan(0)
    expect(compareVersions(parseVersion('0.1.0'), parseVersion('0.1.0-rc.99'))).toBeGreaterThan(0)
  })

  it('orders candidate numbers numerically, not lexicographically', () => {
    // Lexicographic order would put "rc.10" before "rc.9".
    expect(compareVersions(parseVersion('0.1.1-rc.9'), parseVersion('0.1.1-rc.10'))).toBeLessThan(0)
  })

  it('compares alphanumeric identifiers and ranks numeric below them', () => {
    expect(compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0-beta'))).toBeLessThan(0)
    expect(compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0-alpha.1'))).toBeLessThan(0)
    // Numeric identifiers always precede alphanumeric ones.
    expect(compareVersions(parseVersion('1.0.0-1'), parseVersion('1.0.0-alpha'))).toBeLessThan(0)
  })

  it('gives a longer identifier list precedence only when its prefix is equal', () => {
    expect(compareVersions(parseVersion('1.0.0-rc.1'), parseVersion('1.0.0-rc.1.0'))).toBeLessThan(0)
    // Different identifiers decide before length does — beta outranks alpha.1
    // even though its list is shorter.
    expect(compareVersions(parseVersion('1.0.0-beta'), parseVersion('1.0.0-alpha.1'))).toBeGreaterThan(0)
  })
})

describe('satisfiesRange()', () => {
  it.each([
    ['0.1.0-rc.7', true],
    ['0.1.0-rc.8', true],
    ['0.1.0', true],
    ['0.1.1', true],
    ['0.1.1-rc.1', false],
    ['0.1.1-rc.2', false],
    ['0.2.0', false],
  ])('reproduces the audit finding that ^0.1.0-rc.7 %s -> %p', (version, expected) => {
    expect(satisfiesRange(version, '^0.1.0-rc.7')).toBe(expected)
  })

  it.each([
    ['0.1.1-rc.2', true],
    ['0.1.1-rc.3', true],
    ['0.1.1', true],
    ['0.1.2', true],
    // A later line's candidates need their own explicit arm.
    ['0.1.2-alpha.4', false],
    ['0.1.0-rc.8', false],
  ])('measures the adopted range ^0.1.1-rc.2: %s -> %p', (version, expected) => {
    expect(satisfiesRange(version, '^0.1.1-rc.2')).toBe(expected)
  })

  it('applies caret boundaries at the leftmost non-zero field', () => {
    // The upper bound is exclusive, so a whole new minor line starts outside.
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false)
    expect(satisfiesRange('0.2.3', '^0.2.3')).toBe(true)
    expect(satisfiesRange('0.2.2', '^0.2.3')).toBe(false)
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
    expect(satisfiesRange('1.9.9', '^1.2.3')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false)
  })

  it('refuses grammar beyond caret ranges instead of mis-measuring', () => {
    expect(() => satisfiesRange('1.2.3', '~1.2.3')).toThrow(/only caret ranges/)
    expect(() => satisfiesRange('1.2.3', '*')).toThrow(/only caret ranges/)
    expect(() => satisfiesRange('1.2.3', '>=1.0.0')).toThrow(/only caret ranges/)
  })
})

describe('targetUpdates()', () => {
  it('leaves an entry alone when it is already exactly on the target', () => {
    expect(targetUpdates({ '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, '0.1.1-rc.2')).toEqual([])
  })

  it('reports a change for an entry on any other line, in either direction', () => {
    expect(targetUpdates({ '@deepseek-ai/dsh-agent': '0.1.2-alpha.4' }, '0.1.1-rc.2'))
      .toEqual([{ name: '@deepseek-ai/dsh-agent', from: '0.1.2-alpha.4', to: '0.1.1-rc.2' }])
  })

  it('collapses a ranged direct dependency to an exact pin', () => {
    // @deepseek-ai/dsh-atomic-write is exactly this shape in packages/dshline's
    // real dependencies: a caret whose upper bound could otherwise let a
    // non-frozen install resolve it off the adopted generation while every
    // other package sits exactly on it.
    expect(targetUpdates({ '@deepseek-ai/dsh-atomic-write': '^0.1.1-rc.2' }, '0.1.1-rc.2'))
      .toEqual([{ name: '@deepseek-ai/dsh-atomic-write', from: '^0.1.1-rc.2', to: '0.1.1-rc.2' }])
  })

  it('never touches packages that share the scope but not the release cadence', () => {
    expect(targetUpdates({
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/schemastery': '^3.18.1',
      typescript: '^7.0.2',
    }, '0.1.1-rc.2')).toEqual([])
  })
})

describe('checkPeers()', () => {
  it('accepts a range that names exactly the adopted generation', () => {
    expect(checkPeers({ '@deepseek-ai/dsh-agent': '^0.1.1-rc.2' }, '0.1.1-rc.2'))
      .toEqual([{ name: '@deepseek-ai/dsh-agent', range: '^0.1.1-rc.2', accepted: true, single: true }])
  })

  it('flags a range that rejects the target', () => {
    expect(checkPeers({ '@deepseek-ai/dsh-agent': '^0.1.0-rc.7' }, '0.1.1-rc.2')[0])
      .toMatchObject({ accepted: false })
  })

  it('flags a second alternative even when the target is still accepted', () => {
    // The exact shape this repository shipped: a union range promising an
    // alpha generation the bundle no longer compiled against, left over from
    // maintaining several Harness lines at once.
    expect(checkPeers({ '@deepseek-ai/dsh-agent': '^0.1.1-rc.2 || ^0.1.2-alpha.2' }, '0.1.1-rc.2')[0])
      .toMatchObject({ accepted: true, single: false })
  })

  it('skips packages outside the dsh-* line, which follow ordinary semver', () => {
    expect(checkPeers({ '@deepseek-ai/cordis': '^4.0.1', commander: '^15.0.0' }, '0.1.1-rc.2')).toEqual([])
  })
})

describe('formatReport()', () => {
  const TARGET = { revision: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', version: '0.1.1-rc.2' }

  it('names the target and confirms both halves when the repository is coherent', () => {
    const report = formatReport(TARGET, [], [{ name: '@deepseek-ai/dsh-agent', range: '^0.1.1-rc.2', accepted: true, single: true }])
    expect(report).toContain('Harness target 0.1.1-rc.2 @ b150a551')
    expect(report).not.toContain('✗')
  })

  it('says which spec and which range disagree, and why', () => {
    const report = formatReport(
      TARGET,
      [{ manifest: 'package.json', field: 'devDependencies', name: '@deepseek-ai/dsh-llm', from: '0.1.2-alpha.4' }],
      [{ name: '@deepseek-ai/dsh-agent', range: '^0.1.1-rc.2 || ^0.1.2-alpha.2', accepted: true, single: false }],
    )
    expect(report).toContain('package.json (devDependencies): @deepseek-ai/dsh-llm 0.1.2-alpha.4')
    expect(report).toContain('promises more than one Harness generation')
    expect(report).toContain('never rewritten by a tool')
  })
})

describe('isPublished()', () => {
  it('asks whether the exact version exists, not which channel it sits on', async () => {
    // Upstream moves generations between `next`, `alpha`, and `rc` without
    // changing its architecture; a check keyed on a channel name would need
    // redesigning every time it moved.
    const packument = { 'dist-tags': { next: '0.1.1-rc.2', alpha: '0.1.2-alpha.4' }, versions: { '0.1.1-rc.2': {}, '0.1.2-alpha.4': {} } }
    const fetchPackument = vi.fn(() => Promise.resolve(packument))
    await expect(isPublished('@deepseek-ai/dsh', '0.1.2-alpha.4', fetchPackument)).resolves.toBe(true)
    await expect(isPublished('@deepseek-ai/dsh', '0.1.3-alpha.1', fetchPackument)).resolves.toBe(false)
  })

  it('reports a package with no versions at all as unpublished rather than throwing', async () => {
    await expect(isPublished('@deepseek-ai/dsh', '0.1.1-rc.2', () => Promise.resolve({}))).resolves.toBe(false)
  })
})

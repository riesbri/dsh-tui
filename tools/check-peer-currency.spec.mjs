import { describe, expect, it, vi } from 'vitest'
import {
  authoritativeTag,
  checkPeerCurrency,
  compareVersions,
  formatReport,
  parseVersion,
  satisfiesRange,
} from './check-peer-currency.mjs'

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
    // Equal prefix: the longer list outranks.
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
    ['4.0.1', true],
    ['4.0.2', true],
    ['4.0.1-rc.4', false],
    ['5.0.0', false],
  ])('keeps cordis ^4.0.1 honest about prereleases: %s -> %p', (version, expected) => {
    expect(satisfiesRange(version, '^4.0.1')).toBe(expected)
  })

  it.each([
    ['0.1.1-rc.2', true],
    ['0.1.1-rc.3', true],
    ['0.1.1', true],
    ['0.1.2', true],
    // A later line's candidates need their own explicit arm.
    ['0.1.2-rc.1', false],
    ['0.1.0-rc.8', false],
  ])('floors a newer line with ^0.1.1-rc.2: %s -> %p', (version, expected) => {
    expect(satisfiesRange(version, '^0.1.1-rc.2')).toBe(expected)
  })

  it.each([
    ['0.1.0-rc.8', true],
    ['0.1.1-rc.2', true],
    ['0.1.1', true],
    ['0.2.0-rc.1', false],
    ['0.2.0', false],
  ])('accepts both verified lines with the union range: %s -> %p', (version, expected) => {
    expect(satisfiesRange(version, '^0.1.0-rc.7 || ^0.1.1-rc.2')).toBe(expected)
  })

  it.each([
    ['0.1.1-rc.2', true],
    ['0.1.1', true],
    ['0.1.2-alpha.2', true],
    // A different alpha number on the same tuple still needs its own arm.
    ['0.1.2-alpha.1', false],
    ['0.1.2', true],
    ['0.2.0-alpha.1', false],
  ])('accepts the Minimum/Alpha union range: %s -> %p', (version, expected) => {
    expect(satisfiesRange(version, '^0.1.1-rc.2 || ^0.1.2-alpha.2')).toBe(expected)
  })

  it('applies caret boundaries at the leftmost non-zero field', () => {
    // The upper bound is exclusive, so a whole new minor line starts outside.
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false)
    expect(satisfiesRange('0.3.9', '^0.2.3')).toBe(false)
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

describe('checkPeerCurrency()', () => {
  const PACKUMENT = (tags) => ({ 'dist-tags': tags })

  it('checks each harness peer against its authoritative tag and skips ordinary packages', async () => {
    const fetchPackument = vi.fn(name => Promise.resolve(PACKUMENT(
      name === '@deepseek-ai/cordis'
        ? { latest: '4.0.1', next: '4.0.1-rc.4' }
        : { latest: '0.1.0-rc.6', next: '0.1.1-rc.2' },
    )))
    const verdicts = await checkPeerCurrency(
      {
        '@deepseek-ai/dsh-agent': '^0.1.0-rc.7 || ^0.1.1-rc.2',
        '@deepseek-ai/cordis': '^4.0.1',
        commander: '^15.0.0',
      },
      fetchPackument,
    )
    expect(verdicts.map(verdict => verdict.name)).toEqual(['@deepseek-ai/dsh-agent', '@deepseek-ai/cordis'])
    // The agent verdict reads next; cordis reads latest, where its stable
    // release is the newer one.
    expect(verdicts[0]).toMatchObject({ version: '0.1.1-rc.2', accepted: true })
    expect(verdicts[1]).toMatchObject({ version: '4.0.1', accepted: true })
    // commander is Dependabot's business, not the compatibility probe's.
    expect(fetchPackument).toHaveBeenCalledTimes(2)
  })

  it('flags the stale state this repository was found in', async () => {
    const verdicts = await checkPeerCurrency(
      { '@deepseek-ai/dsh-agent': '^0.1.0-rc.7' },
      () => Promise.resolve(PACKUMENT({ next: '0.1.1-rc.2' })),
    )
    expect(verdicts[0]).toMatchObject({ accepted: false, version: '0.1.1-rc.2', tag: 'next' })
  })

  it('fails loudly when the authoritative tag is missing', async () => {
    await expect(checkPeerCurrency(
      { '@deepseek-ai/dsh-agent': '^0.1.0-rc.7' },
      () => Promise.resolve(PACKUMENT({})),
    )).rejects.toThrow(/no next dist-tag/)
  })

  it('checks the alpha channel when asked, but keeps cordis on latest', async () => {
    const fetchPackument = vi.fn(name => Promise.resolve(PACKUMENT(
      name === '@deepseek-ai/cordis'
        ? { latest: '4.0.1', next: '4.0.1-rc.4' }
        : { next: '0.1.1-rc.2', alpha: '0.1.2-alpha.2' },
    )))
    const verdicts = await checkPeerCurrency(
      {
        '@deepseek-ai/dsh-agent': '^0.1.1-rc.2 || ^0.1.2-alpha.2',
        '@deepseek-ai/cordis': '^4.0.1',
      },
      fetchPackument,
      'alpha',
    )
    expect(verdicts[0]).toMatchObject({ tag: 'alpha', version: '0.1.2-alpha.2', accepted: true })
    expect(verdicts[1]).toMatchObject({ tag: 'latest', version: '4.0.1', accepted: true })
  })
})

describe('authoritativeTag()', () => {
  it('reads cordis from latest and everything else from next by default', () => {
    expect(authoritativeTag('@deepseek-ai/cordis')).toBe('latest')
    expect(authoritativeTag('@deepseek-ai/dsh-agent')).toBe('next')
  })

  it('reads the dsh-* line from the requested channel, but keeps cordis on latest regardless', () => {
    expect(authoritativeTag('@deepseek-ai/dsh-agent', 'alpha')).toBe('alpha')
    expect(authoritativeTag('@deepseek-ai/cordis', 'alpha')).toBe('latest')
  })
})

describe('formatReport()', () => {
  it('names the rejected combination so the fix is one read away', () => {
    const report = formatReport([
      { name: '@deepseek-ai/dsh-agent', range: '^0.1.0-rc.7', tag: 'next', version: '0.1.1-rc.2', accepted: false },
      { name: '@deepseek-ai/cordis', range: '^4.0.1', tag: 'latest', version: '4.0.1', accepted: true },
    ])
    expect(report).toContain('^0.1.0-rc.7')
    expect(report).toContain('next@0.1.1-rc.2')
    expect(report).toContain('REJECTED')
    expect(report).toContain('ok')
  })
})

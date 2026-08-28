import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverHarnessPackages,
  findWorkspaceRoot,
  harnessScopedNames,
  parseWorkspacePackagePatterns,
  readWorkspaceOverrides,
  requiredClosure,
  writeWorkspaceOverrides,
} from './harness-graph.mjs'

describe('parseWorkspacePackagePatterns()', () => {
  it('reads the packages list, trimming comments and quotes', () => {
    const yaml = [
      'packages:',
      '  - vendor/*',
      '  - packages/*/*',
      "  - 'native/landlock-run' # native launcher",
      '  - "apps/*"',
      '',
      'overrides:',
      "  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'",
    ].join('\n')
    expect(parseWorkspacePackagePatterns(yaml)).toEqual([
      'vendor/*',
      'packages/*/*',
      'native/landlock-run',
      'apps/*',
    ])
  })

  it('returns nothing when there is no packages list', () => {
    expect(parseWorkspacePackagePatterns('overrides:\n  a: b\n')).toEqual([])
  })
})

describe('requiredClosure()', () => {
  const packages = new Map([
    ['@deepseek-ai/dsh-agent', { dependencies: {}, peerDependencies: { '@deepseek-ai/dsh-system-prompt': 'workspace:^', '@deepseek-ai/cordis': 'workspace:^' } }],
    ['@deepseek-ai/dsh-system-prompt', { dependencies: { '@deepseek-ai/schemastery': 'workspace:^' }, peerDependencies: { '@deepseek-ai/dsh-scope': 'workspace:^' } }],
    ['@deepseek-ai/dsh-scope', { dependencies: {}, peerDependencies: {} }],
    ['@deepseek-ai/cordis', { dependencies: {}, peerDependencies: {} }],
    ['@deepseek-ai/schemastery', { dependencies: {}, peerDependencies: {} }],
    ['@deepseek-ai/dsh-unrelated', { dependencies: {}, peerDependencies: {} }],
  ])

  it('walks dependencies and peerDependencies transitively from the seeds', () => {
    const closure = requiredClosure(['@deepseek-ai/dsh-agent'], packages)
    expect([...closure].sort()).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/schemastery',
    ])
    expect(closure.has('@deepseek-ai/dsh-unrelated')).toBe(false)
  })

  it('ignores seeds the checkout does not contain, without throwing', () => {
    expect([...requiredClosure(['@deepseek-ai/dsh-atomic-write'], packages)]).toEqual([])
  })

  it('is a no-op when nothing is reachable beyond the seed itself', () => {
    expect([...requiredClosure(['@deepseek-ai/dsh-unrelated'], packages)]).toEqual(['@deepseek-ai/dsh-unrelated'])
  })
})

describe('harnessScopedNames()', () => {
  it('collects @deepseek-ai/* names from dependencies, peerDependencies, and devDependencies, deduplicated', () => {
    const names = harnessScopedNames([
      { dependencies: { '@deepseek-ai/dsh-atomic-write': '^0.1.0', commander: '^15.0.0' } },
      { peerDependencies: { '@deepseek-ai/dsh-agent': '^0.1.0' } },
      { devDependencies: { '@deepseek-ai/dsh-agent': 'link:../x', '@deepseek-ai/cordis': '4.0.1' } },
    ])
    expect(names.sort()).toEqual(['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-atomic-write'])
  })
})

describe('readWorkspaceOverrides() / writeWorkspaceOverrides()', () => {
  const base = [
    'packages:',
    '  - packages/*',
    '',
    '# a comment worth keeping',
    'minimumReleaseAge: 1440',
    '',
  ].join('\n')

  it('reads no entries when there is no overrides block', () => {
    expect(readWorkspaceOverrides(base)).toEqual(new Map())
  })

  it('inserts a new block right after the packages list, leaving everything else untouched', () => {
    const updated = writeWorkspaceOverrides(base, new Map([['@deepseek-ai/dsh-agent', 'link:../deepseek-harness/packages/core/agent']]))
    expect(updated).toBe([
      'packages:',
      '  - packages/*',
      '',
      'overrides:',
      "  '@deepseek-ai/dsh-agent': 'link:../deepseek-harness/packages/core/agent'",
      '',
      '# a comment worth keeping',
      'minimumReleaseAge: 1440',
      '',
    ].join('\n'))
    expect(readWorkspaceOverrides(updated)).toEqual(new Map([['@deepseek-ai/dsh-agent', 'link:../deepseek-harness/packages/core/agent']]))
  })

  it('round-trips: write then read then write an empty map removes the block cleanly', () => {
    const linked = writeWorkspaceOverrides(base, new Map([['@deepseek-ai/cordis', 'link:../deepseek-harness/vendor/cordis']]))
    const restored = writeWorkspaceOverrides(linked, new Map())
    expect(restored).toBe(base)
  })

  it('replaces an existing block in place without disturbing surrounding content', () => {
    const withBlock = [
      'packages:',
      '  - packages/*',
      '',
      'overrides:',
      "  '@deepseek-ai/cordis': 'link:../old-checkout/vendor/cordis'",
      '',
      'minimumReleaseAge: 1440',
      '',
    ].join('\n')
    const updated = writeWorkspaceOverrides(withBlock, new Map([['@deepseek-ai/dsh-agent', 'link:../new-checkout/packages/core/agent']]))
    expect(updated).toBe([
      'packages:',
      '  - packages/*',
      '',
      'overrides:',
      "  '@deepseek-ai/dsh-agent': 'link:../new-checkout/packages/core/agent'",
      '',
      'minimumReleaseAge: 1440',
      '',
    ].join('\n'))
  })

  it('sorts entries by name regardless of insertion order', () => {
    const updated = writeWorkspaceOverrides(base, new Map([
      ['@deepseek-ai/dsh-user-approval', 'link:b'],
      ['@deepseek-ai/dsh-agent', 'link:a'],
    ]))
    const lines = updated.split('\n')
    const agentIndex = lines.findIndex(line => line.includes('dsh-agent'))
    const userIndex = lines.findIndex(line => line.includes('dsh-user-approval'))
    expect(agentIndex).toBeLessThan(userIndex)
  })
})

describe('discoverHarnessPackages() / findWorkspaceRoot()', () => {
  let checkoutRoot

  afterEach(async () => {
    if (checkoutRoot !== undefined) await rm(checkoutRoot, { recursive: true, force: true })
  })

  /** Write one fixture package under a checkout. */
  async function writePackage(dir, manifest) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
  }

  it('discovers workspace packages by expanding the patterns in pnpm-workspace.yaml, ignoring non-@deepseek-ai names', async () => {
    checkoutRoot = await mkdtemp(join(tmpdir(), 'harness-checkout-'))
    await writeFile(join(checkoutRoot, 'pnpm-workspace.yaml'), 'packages:\n  - vendor/*\n  - packages/*/*\n')
    await writePackage(join(checkoutRoot, 'vendor', 'cordis'), {
      name: '@deepseek-ai/cordis',
      dependencies: {},
      peerDependencies: {},
    })
    await writePackage(join(checkoutRoot, 'vendor', 'unrelated-tool'), { name: 'unrelated-tool' })
    await writePackage(join(checkoutRoot, 'packages', 'core', 'agent'), {
      name: '@deepseek-ai/dsh-agent',
      peerDependencies: { '@deepseek-ai/dsh-system-prompt': 'workspace:^' },
    })
    // A workspace-listed directory with no package.json (a doc-only folder) must not throw.
    await mkdir(join(checkoutRoot, 'packages', 'core', 'no-manifest'), { recursive: true })

    const packages = await discoverHarnessPackages(checkoutRoot)
    expect([...packages.keys()].sort()).toEqual(['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent'])
    expect(packages.get('@deepseek-ai/dsh-agent').peerDependencies).toEqual({ '@deepseek-ai/dsh-system-prompt': 'workspace:^' })
  })

  it('finds the checkout root by walking up from any package directory inside it', async () => {
    checkoutRoot = await mkdtemp(join(tmpdir(), 'harness-checkout-'))
    await writeFile(join(checkoutRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*/*\n')
    const deep = join(checkoutRoot, 'packages', 'core', 'agent')
    await mkdir(deep, { recursive: true })
    await expect(findWorkspaceRoot(deep)).resolves.toBe(checkoutRoot)
  })

  it('returns undefined when no ancestor carries pnpm-workspace.yaml', async () => {
    const stray = await mkdtemp(join(tmpdir(), 'not-a-checkout-'))
    checkoutRoot = stray
    await expect(findWorkspaceRoot(join(stray, 'a', 'b'))).resolves.toBeUndefined()
  })
})

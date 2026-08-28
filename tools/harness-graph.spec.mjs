import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverHarnessPackages,
  evaluateLinkedClosure,
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

  it('tolerates blank and comment-only lines between entries, as the real Harness workspace has', () => {
    // Modeled on deepseek-harness's own pnpm-workspace.yaml shape: an
    // explanatory comment sits between two package entries, not just after
    // the whole list.
    const yaml = [
      'packages:',
      '  - vendor/*',
      '',
      '  # native/landlock-run is a standalone Rust binary, not an npm package,',
      '  # but still needs its own workspace entry for pnpm to build it.',
      '  - native/landlock-run',
      '  - packages/*/*',
      '',
      'overrides:',
      "  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'",
    ].join('\n')
    expect(parseWorkspacePackagePatterns(yaml)).toEqual([
      'vendor/*',
      'native/landlock-run',
      'packages/*/*',
    ])
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

describe('evaluateLinkedClosure()', () => {
  const packages = new Map([
    ['@deepseek-ai/dsh-agent', { dir: '/checkout/packages/core/agent', dependencies: {}, peerDependencies: { '@deepseek-ai/dsh-system-prompt': 'workspace:^' } }],
    ['@deepseek-ai/dsh-system-prompt', { dir: '/checkout/packages/core/system-prompt', dependencies: {}, peerDependencies: {} }],
  ])
  const seeds = ['@deepseek-ai/dsh-agent']
  const resolveTarget = spec => spec.slice('link:'.length)

  it('reports nothing wrong when every linked package points at this checkout\'s own directory for its name', () => {
    const linked = [
      ['@deepseek-ai/dsh-agent', 'link:/checkout/packages/core/agent'],
      ['@deepseek-ai/dsh-system-prompt', 'link:/checkout/packages/core/system-prompt'],
    ]
    expect(evaluateLinkedClosure(linked, packages, seeds, resolveTarget)).toEqual({
      mismatched: [],
      notLinked: [],
      stale: [],
    })
  })

  it('flags a linked package whose target is a different checkout\'s directory for that name', () => {
    // Same name, but the override points into some other checkout entirely —
    // exactly the state a half-finished re-link or a hand-edited override
    // block can leave behind.
    const linked = [
      ['@deepseek-ai/dsh-agent', 'link:/other-checkout/packages/core/agent'],
      ['@deepseek-ai/dsh-system-prompt', 'link:/checkout/packages/core/system-prompt'],
    ]
    const result = evaluateLinkedClosure(linked, packages, seeds, resolveTarget)
    expect(result.mismatched).toEqual(['@deepseek-ai/dsh-agent'])
  })

  it('flags a linked name the checkout does not declare at all as mismatched, not merely missing', () => {
    const linked = [['@deepseek-ai/dsh-unknown', 'link:/checkout/somewhere']]
    const result = evaluateLinkedClosure(linked, packages, seeds, resolveTarget)
    expect(result.mismatched).toEqual(['@deepseek-ai/dsh-unknown'])
  })

  it('reports a required-but-unlinked package as notLinked', () => {
    const linked = [['@deepseek-ai/dsh-agent', 'link:/checkout/packages/core/agent']]
    const result = evaluateLinkedClosure(linked, packages, seeds, resolveTarget)
    expect(result.notLinked).toEqual(['@deepseek-ai/dsh-system-prompt'])
  })

  it('reports a linked package the closure no longer requires as stale', () => {
    const linked = [
      ['@deepseek-ai/dsh-agent', 'link:/checkout/packages/core/agent'],
      ['@deepseek-ai/dsh-system-prompt', 'link:/checkout/packages/core/system-prompt'],
    ]
    const result = evaluateLinkedClosure(linked, packages, [], resolveTarget)
    expect(result.stale.sort()).toEqual(['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-system-prompt'])
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

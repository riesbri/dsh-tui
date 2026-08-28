import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeUpdates, desiredVersions, formatUpdates, manifestUpdates, syncManifest } from './sync-harness.mjs'

/** Registry stand-in whose dist-tags mirror the state found by the 2026-08 audit. */
const PACKUMENTS = {
  '@deepseek-ai/cordis': { 'dist-tags': { latest: '4.0.1', next: '4.0.1-rc.4' } },
  '@deepseek-ai/dsh-agent': { 'dist-tags': { latest: '0.1.0-rc.6', next: '0.1.1-rc.2' } },
  '@deepseek-ai/dsh-goal': { 'dist-tags': { latest: '0.0.1-rc.1', next: '0.1.1-rc.2' } },
}
const fetchPackument = name => Promise.resolve(PACKUMENTS[name])

describe('desiredVersions()', () => {
  it('resolves each package from its authoritative tag, not from newest overall', async () => {
    await expect(desiredVersions(['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent'], fetchPackument))
      .resolves.toEqual(new Map([
        // cordis's next is an older prerelease than its stable release; the
        // harness line reads next, where latest is the stale side.
        ['@deepseek-ai/cordis', '4.0.1'],
        ['@deepseek-ai/dsh-agent', '0.1.1-rc.2'],
      ]))
  })

  it('ignores ordinary dependencies and fails loudly on a missing tag', async () => {
    await expect(desiredVersions(['typescript'], fetchPackument)).resolves.toEqual(new Map())
    await expect(desiredVersions(['@deepseek-ai/dsh-llm'], fetchPackument)).rejects.toThrow(/no next dist-tag/)
  })
})

describe('manifestUpdates()', () => {
  const desired = new Map([['@deepseek-ai/dsh-agent', '0.1.1-rc.2']])

  it('flags floating tags, stale pins, and absent entries alike', () => {
    expect(manifestUpdates({ '@deepseek-ai/dsh-agent': 'next' }, desired)).toEqual([
      { name: '@deepseek-ai/dsh-agent', from: 'next', to: '0.1.1-rc.2' },
    ])
    expect(manifestUpdates({ '@deepseek-ai/dsh-agent': '0.1.0-rc.8' }, desired)).toEqual([
      { name: '@deepseek-ai/dsh-agent', from: '0.1.0-rc.8', to: '0.1.1-rc.2' },
    ])
    expect(manifestUpdates({}, desired)).toEqual([
      { name: '@deepseek-ai/dsh-agent', from: undefined, to: '0.1.1-rc.2' },
    ])
  })

  it('reports nothing when every entry is already the pinned truth', () => {
    expect(manifestUpdates({ '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, desired)).toEqual([])
  })
})

describe('syncManifest()', () => {
  it('pins Harness dependencies and devDependencies alike, without touching peers or ordinary dependencies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-harness-'))
    const manifestPath = join(dir, 'package.json')
    const before = {
      name: 'under-test',
      peerDependencies: {
        '@deepseek-ai/dsh-agent': '^0.1.0-rc.7 || ^0.1.1-rc.2',
        '@deepseek-ai/cordis': '^4.0.1',
      },
      dependencies: {
        // A direct Harness runtime dependency, ranged the way
        // @deepseek-ai/dsh-atomic-write actually is in packages/dshline —
        // this must be pinned exactly, the same as any devDependency, or a
        // disposable `pnpm install --no-frozen-lockfile` could resolve it to
        // whatever else the range's upper bound currently allows.
        '@deepseek-ai/dsh-goal': '^0.1.0-rc.7 || ^0.1.1-rc.2',
        yaml: '^2.9.0',
      },
      devDependencies: {
        typescript: '^5.9.3',
        vitest: '^3.2.4',
        '@deepseek-ai/cordis': 'next',
        '@deepseek-ai/dsh-agent': 'next',
      },
    }
    await writeFile(manifestPath, `${JSON.stringify(before, null, 2)}\n`)

    const updates = await syncManifest(manifestPath, fetchPackument)
    expect(updates).toHaveLength(3)

    const after = JSON.parse(await readFile(manifestPath, 'utf8'))
    // The invariant this whole tool exists to protect: a sync is a pin, never
    // a compatibility widening.
    expect(after.peerDependencies).toEqual(before.peerDependencies)
    expect(after.dependencies.yaml).toBe('^2.9.0')
    expect(after.dependencies['@deepseek-ai/dsh-goal']).toBe('0.1.1-rc.2')
    expect(after.devDependencies.typescript).toBe('^5.9.3')
    expect(after.devDependencies['@deepseek-ai/dsh-agent']).toBe('0.1.1-rc.2')
    expect(Object.keys(after.dependencies)).toEqual([...Object.keys(after.dependencies)].sort())
    expect(Object.keys(after.devDependencies)).toEqual([...Object.keys(after.devDependencies)].sort())
    expect(await readFile(manifestPath, 'utf8')).toMatch(/\n$/)
  })

  it('leaves a current file byte-for-byte alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-harness-'))
    const manifestPath = join(dir, 'package.json')
    const text = `${JSON.stringify({
      name: 'current',
      dependencies: { '@deepseek-ai/dsh-goal': '0.1.1-rc.2' },
      devDependencies: { '@deepseek-ai/cordis': '4.0.1' },
    }, null, 2)}\n`
    await writeFile(manifestPath, text)
    expect(await syncManifest(manifestPath, fetchPackument)).toEqual([])
    expect(await readFile(manifestPath, 'utf8')).toBe(text)
  })

  it('never proposes a name in one field just because the other field also wants a version for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-harness-'))
    const manifestPath = join(dir, 'package.json')
    // @deepseek-ai/dsh-goal lives only in dependencies here; devDependencies
    // must not gain a phantom entry for it just because desiredVersions()
    // can resolve that name.
    const before = {
      name: 'under-test',
      dependencies: { '@deepseek-ai/dsh-goal': '0.1.0-rc.7' },
      devDependencies: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' },
    }
    await writeFile(manifestPath, `${JSON.stringify(before, null, 2)}\n`)
    const updates = await syncManifest(manifestPath, fetchPackument)
    expect(updates).toEqual([{ field: 'dependencies', name: '@deepseek-ai/dsh-goal', from: '0.1.0-rc.7', to: '0.1.1-rc.2' }])
    const after = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(after.devDependencies).toEqual({ '@deepseek-ai/dsh-agent': '0.1.1-rc.2' })
  })
})

describe('computeUpdates()', () => {
  it('never writes: the file still reports drift afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-harness-'))
    const manifestPath = join(dir, 'package.json')
    await writeFile(manifestPath, `${JSON.stringify({ devDependencies: { '@deepseek-ai/cordis': 'latest' } }, null, 2)}\n`)
    const { updates } = await computeUpdates(manifestPath, fetchPackument)
    expect(updates).toHaveLength(1)
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).devDependencies['@deepseek-ai/cordis']).toBe('latest')
  })
})

describe('formatUpdates()', () => {
  it('shows both sides of every move so a reviewer reads the diff once', () => {
    const report = formatUpdates('/repo/package.json', [
      { name: '@deepseek-ai/dsh-agent', from: '0.1.0-rc.8', to: '0.1.1-rc.2', field: 'devDependencies' },
      { name: '@deepseek-ai/dsh-jobs', from: undefined, to: '0.1.1-rc.2', field: 'devDependencies' },
    ])
    expect(report).toContain('(absent) -> 0.1.1-rc.2')
    expect(report).toContain('0.1.0-rc.8 -> 0.1.1-rc.2')
  })

  it('marks a direct dependency distinctly from a devDependency', () => {
    const report = formatUpdates('/repo/package.json', [
      { name: '@deepseek-ai/dsh-goal', from: '0.1.0-rc.7', to: '0.1.1-rc.2', field: 'dependencies' },
    ])
    expect(report).toContain('[dependencies]')
  })
})

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
  it('pins devDependencies without touching peers or ordinary dependencies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-harness-'))
    const manifestPath = join(dir, 'package.json')
    const before = {
      name: 'under-test',
      peerDependencies: {
        '@deepseek-ai/dsh-agent': '^0.1.0-rc.7 || ^0.1.1-rc.2',
        '@deepseek-ai/cordis': '^4.0.1',
      },
      devDependencies: {
        typescript: '^5.9.3',
        vitest: '^3.2.4',
        '@deepseek-ai/dsh-goal': '0.1.0-rc.7',
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
    expect(after.devDependencies.typescript).toBe('^5.9.3')
    expect(after.devDependencies['@deepseek-ai/dsh-agent']).toBe('0.1.1-rc.2')
    expect(after.devDependencies['@deepseek-ai/dsh-goal']).toBe('0.1.1-rc.2')
    expect(Object.keys(after.devDependencies)).toEqual([...Object.keys(after.devDependencies)].sort())
    expect(await readFile(manifestPath, 'utf8')).toMatch(/\n$/)
  })

  it('leaves a current file byte-for-byte alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-harness-'))
    const manifestPath = join(dir, 'package.json')
    const text = `${JSON.stringify({
      name: 'current',
      devDependencies: { '@deepseek-ai/cordis': '4.0.1' },
    }, null, 2)}\n`
    await writeFile(manifestPath, text)
    expect(await syncManifest(manifestPath, fetchPackument)).toEqual([])
    expect(await readFile(manifestPath, 'utf8')).toBe(text)
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
      { name: '@deepseek-ai/dsh-agent', from: '0.1.0-rc.8', to: '0.1.1-rc.2' },
      { name: '@deepseek-ai/dsh-jobs', from: undefined, to: '0.1.1-rc.2' },
    ])
    expect(report).toContain('(absent) -> 0.1.1-rc.2')
    expect(report).toContain('0.1.0-rc.8 -> 0.1.1-rc.2')
  })
})

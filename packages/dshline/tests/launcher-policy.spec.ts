/**
 * Finding the harness launcher, and keeping one policy for it.
 *
 * `/profiles` mutations shell out to `dsh plugin`, so they have to reach the
 * launcher wherever this frontend itself starts — which a PATH lookup alone
 * does not: `DSH_BIN` and a `DSH_HARNESS` source checkout are both ordinary
 * working setups, and the first version of `/profiles` could not install
 * anything in either.
 *
 * `bin/dshline.mjs` keeps its own copy of the policy because it is the
 * package's executable and must run before anything is built. The last suite
 * here is the guard that keeps the two from drifting apart in silence.
 */

import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LAUNCHER_PACKAGE, resolveLauncher } from '../src/launcher.ts'

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
  dirs = []
})

/** A temp directory that is cleaned up after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshline-launcher-'))
  dirs.push(dir)
  return dir
}

/** An anchor that resolves no packages, so the package fallback finds nothing. */
const NO_PACKAGES = 'file:///nonexistent-anchor/package.json'

describe('DSH_BIN, when the user has pointed at a launcher', () => {
  it('uses it, and says where it came from', async () => {
    const dir = await tempDir()
    const bin = join(dir, 'dsh')
    await writeFile(bin, '#!/bin/sh\n', 'utf8')
    await chmod(bin, 0o755)
    const found = resolveLauncher({ DSH_BIN: bin }, NO_PACKAGES)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe(bin)
    expect(found.launcher.prefix).toEqual([])
    expect(found.launcher.describe).toContain('$DSH_BIN')
  })

  it('reports a wrong path as a misconfiguration, not as "no launcher"', () => {
    // The answers differ: a wrong DSH_BIN is a sentence about the value they
    // set, not an invitation to install anything.
    const found = resolveLauncher({ DSH_BIN: '/nonexistent/dsh' }, NO_PACKAGES)
    expect(found.kind).toBe('misconfigured')
    if (found.kind !== 'misconfigured') throw new Error('expected misconfigured')
    expect(found.message).toContain('$DSH_BIN')
    expect(found.message).toContain('/nonexistent/dsh')
  })

  it('outranks PATH, because the user already decided', async () => {
    const dir = await tempDir()
    const bin = join(dir, 'chosen')
    await writeFile(bin, '', 'utf8')
    const path = await tempDir()
    await writeFile(join(path, 'dsh'), '', 'utf8')
    const found = resolveLauncher({ DSH_BIN: bin, PATH: path }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe(bin)
  })
})

describe('DSH_HARNESS, when the launcher is a source checkout', () => {
  /** A checkout whose manifest defines the given `dsh` script. */
  async function checkout(script: string | undefined): Promise<string> {
    const dir = await tempDir()
    const manifest = script === undefined ? { name: 'harness' } : { name: 'harness', scripts: { dsh: script } }
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
    return dir
  }

  it('runs the checkout script, from the checkout', async () => {
    // A checkout has no `dsh` executable at all: the launcher is a script whose
    // loader resolves relative to the checkout, so it only runs with that cwd.
    const dir = await checkout('node --import tsx/esm apps/cli/src/bin.ts')
    const found = resolveLauncher({ DSH_HARNESS: dir }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe('node')
    expect(found.launcher.prefix).toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts'])
    expect(found.launcher.cwd).toBe(dir)
  })

  it('reports a directory that is not a checkout', async () => {
    const dir = await tempDir()
    const found = resolveLauncher({ DSH_HARNESS: dir }, NO_PACKAGES)
    expect(found.kind).toBe('misconfigured')
    if (found.kind !== 'misconfigured') throw new Error('expected misconfigured')
    expect(found.message).toContain('no package.json')
  })

  it('reports a checkout whose manifest defines no dsh script', async () => {
    const dir = await checkout(undefined)
    const found = resolveLauncher({ DSH_HARNESS: dir }, NO_PACKAGES)
    expect(found.kind).toBe('misconfigured')
    if (found.kind !== 'misconfigured') throw new Error('expected misconfigured')
    expect(found.message).toContain('has no "dsh" script')
  })

  it('outranks PATH', async () => {
    const dir = await checkout('node bin.ts')
    const path = await tempDir()
    await writeFile(join(path, 'dsh'), '', 'utf8')
    const found = resolveLauncher({ DSH_HARNESS: dir, PATH: path }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.cwd).toBe(dir)
  })
})

describe('PATH, the ordinary global install', () => {
  it('uses a bare dsh so Node resolves it the way a shell would', async () => {
    const path = await tempDir()
    await writeFile(join(path, 'dsh'), '', 'utf8')
    const found = resolveLauncher({ PATH: path }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe('dsh')
    expect(found.launcher.describe).toContain('PATH')
  })

  it('reports none when nothing on PATH and no package can be resolved', async () => {
    expect(resolveLauncher({ PATH: '/nonexistent-a:/nonexistent-b' }, NO_PACKAGES)).toEqual({ kind: 'none' })
    expect(resolveLauncher({ PATH: '' }, NO_PACKAGES)).toEqual({ kind: 'none' })
    expect(resolveLauncher({}, NO_PACKAGES)).toEqual({ kind: 'none' })
  })
})

describe('the launcher package, resolved side by side with this one', () => {
  it('runs its bin through this Node, so the file need not be executable', async () => {
    // What makes `npm i -g @deepseek-ai/dsh @dshline/dshline` enough.
    const root = await tempDir()
    const pkg = join(root, 'node_modules', LAUNCHER_PACKAGE)
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: LAUNCHER_PACKAGE, bin: { dsh: 'cli.js' } }), 'utf8')
    await writeFile(join(pkg, 'cli.js'), '', 'utf8')
    const found = resolveLauncher({ PATH: '' }, `file://${join(root, 'anchor.js')}`)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe(process.execPath)
    // Compared by suffix: `createRequire` resolves through realpath, and the
    // system temp directory is a symlink on macOS.
    expect(found.launcher.prefix).toHaveLength(1)
    expect(found.launcher.prefix[0]).toMatch(/cli\.js$/u)
  })

  it('reports none when the package declares a bin file that is not there', async () => {
    const root = await tempDir()
    const pkg = join(root, 'node_modules', LAUNCHER_PACKAGE)
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ bin: { dsh: 'missing.js' } }), 'utf8')
    expect(resolveLauncher({ PATH: '' }, `file://${join(root, 'anchor.js')}`)).toEqual({ kind: 'none' })
  })
})

describe('one launcher policy, two implementations', () => {
  // `bin/dshline.mjs` cannot import this module: it is the package's
  // executable and must run in a source checkout that has never been built.
  // The duplication is therefore deliberate — and guarded here, so it cannot
  // become a divergence nobody noticed.
  const wrapper = readFileSync(fileURLToPath(new URL('../bin/dshline.mjs', import.meta.url)), 'utf8')

  it('honours the same four mechanisms as the wrapper', () => {
    for (const mechanism of ['DSH_BIN', 'DSH_HARNESS', 'PATH', LAUNCHER_PACKAGE]) {
      expect(wrapper, `wrapper lost ${mechanism}`).toContain(mechanism)
    }
  })

  it('honours them in the same order', () => {
    // Order is policy, not detail: it is what makes an explicit DSH_BIN beat a
    // stale `dsh` on PATH. Measured inside the wrapper's own resolver, because
    // a top-of-file `const LAUNCHER_PACKAGE = …` would otherwise read as the
    // first mechanism.
    const start = wrapper.indexOf('function findLauncher()')
    expect(start).toBeGreaterThan(0)
    const body = wrapper.slice(start, wrapper.indexOf('\nfunction ', start + 1))
    const order = ['DSH_BIN', 'DSH_HARNESS', "onPath('dsh')", 'LAUNCHER_PACKAGE']
    const positions = order.map(token => body.indexOf(token))
    expect(positions.every(position => position >= 0), `missing: ${JSON.stringify(order.filter((_t, i) => positions[i] < 0))}`).toBe(true)
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })

  it('still runs the package fallback through this Node in the wrapper too', () => {
    expect(wrapper).toContain('process.execPath')
  })
})

/**
 * Reading Harness's own profile machinery.
 *
 * Against real temp directories laid out the way `$DSH_HOME/profiles` actually
 * is: profile directories holding a `package.json` with `dsh.profile.bundles`,
 * the launcher-maintained flat `node_modules` sibling that makes in-box
 * bundles resolvable from any profile, and a profile-local `node_modules` for
 * out-of-tree ones.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { currentProfileName, PROFILES_DIR, readProfiles } from '../src/profiles/harness.ts'

let homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.map(async home => rm(home, { recursive: true, force: true })))
  homes = []
})

/** A fresh Harness home with a profiles root. */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dshline-profiles-'))
  homes.push(home)
  await mkdir(join(home, PROFILES_DIR), { recursive: true })
  return home
}

/** Write one profile directory with the given manifest fields. */
async function writeProfile(
  home: string,
  name: string,
  manifest: Record<string, unknown> | string,
): Promise<string> {
  const dir = join(home, PROFILES_DIR, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, undefined, 2),
    'utf8',
  )
  return dir
}

/** Write one installed package manifest under a `node_modules` directory. */
async function writePackage(
  modulesDir: string,
  packageName: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const dir = join(modulesDir, packageName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
}

/**
 * A context providing `dshHomePath` and, optionally, the Loader base URL a
 * booted profile would carry.
 */
function ctxFor(home: string, bootedProfile?: string): Context {
  const baseUrl = bootedProfile === undefined
    ? undefined
    : `${pathToFileURL(join(home, PROFILES_DIR, bootedProfile)).href}/`
  return {
    get: (name: string) => (name === 'dshHomePath'
      ? (...segments: string[]) => join(home, ...segments)
      : undefined),
    baseUrl,
  } as unknown as Context
}

describe('which profile this Host booted', () => {
  it('reads it from the Loader base URL, which the launcher anchors at the profile directory', async () => {
    const home = await makeHome()
    const root = join(home, PROFILES_DIR)
    expect(currentProfileName(ctxFor(home, 'dshline'), root)).toBe('dshline')
  })

  it('names no profile when the base URL is outside the profiles root', async () => {
    // A bare `boot()` embedder or a test has a perfectly valid base URL that
    // names no profile; answering with its basename would invent one.
    const home = await makeHome()
    const ctx = { get: () => undefined, baseUrl: `${pathToFileURL(home).href}/` } as unknown as Context
    expect(currentProfileName(ctx, join(home, PROFILES_DIR))).toBeUndefined()
  })

  it('names no profile when there is no base URL at all', async () => {
    const home = await makeHome()
    expect(currentProfileName(ctxFor(home), join(home, PROFILES_DIR))).toBeUndefined()
  })

  it('refuses the launcher module fallback sibling, which Harness refuses as a profile name', async () => {
    const home = await makeHome()
    expect(currentProfileName(ctxFor(home, 'node_modules'), join(home, PROFILES_DIR))).toBeUndefined()
  })

  it('names no profile for a nested directory two levels under the root', async () => {
    const home = await makeHome()
    const root = join(home, PROFILES_DIR)
    const nested = `${pathToFileURL(join(root, 'dshline', 'deeper')).href}/`
    const ctx = { get: () => undefined, baseUrl: nested } as unknown as Context
    expect(currentProfileName(ctx, root)).toBeUndefined()
  })
})

describe('reading the profile roster', () => {
  it('lists profiles by name and marks the booted one', async () => {
    const home = await makeHome()
    await writeProfile(home, 'web', { dsh: { profile: { bundles: [] } } })
    await writeProfile(home, 'dshline', { dsh: { profile: { bundles: [] } } })
    await writeProfile(home, 'headless', { dsh: { profile: { bundles: [] } } })
    const reading = await readProfiles(ctxFor(home, 'dshline'))
    expect(reading?.profiles.map(profile => profile.name)).toEqual(['dshline', 'headless', 'web'])
    expect(reading?.currentName).toBe('dshline')
    expect(reading?.profiles.filter(profile => profile.current).map(profile => profile.name)).toEqual(['dshline'])
  })

  it('skips the launcher flat module fallback, which is not a profile', async () => {
    const home = await makeHome()
    await writeProfile(home, 'dshline', { dsh: { profile: { bundles: [] } } })
    await mkdir(join(home, PROFILES_DIR, 'node_modules', '@scope', 'thing'), { recursive: true })
    const reading = await readProfiles(ctxFor(home, 'dshline'))
    expect(reading?.profiles.map(profile => profile.name)).toEqual(['dshline'])
  })

  it('reports an empty roster rather than failing when nothing has been created yet', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshline-profiles-'))
    homes.push(home)
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles).toEqual([])
    expect(reading?.root).toBe(join(home, PROFILES_DIR))
  })

  it('reports nothing readable when the deployment provides no home-path service', async () => {
    const ctx = { get: () => undefined, baseUrl: undefined } as unknown as Context
    expect(await readProfiles(ctx)).toBeUndefined()
  })

  it('still shows a profile whose manifest cannot be read', async () => {
    // The directory occupies its name either way, so hiding it would leave a
    // profile that can neither be created nor seen.
    const home = await makeHome()
    await writeProfile(home, 'broken', 'this is not json')
    await mkdir(join(home, PROFILES_DIR, 'no-manifest'), { recursive: true })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles.map(profile => profile.name)).toEqual(['broken', 'no-manifest'])
    expect(reading?.profiles.every(profile => profile.broken !== undefined)).toBe(true)
    expect(reading?.profiles[0]?.bundles).toEqual([])
  })

  it('reads the bundle list in dsh.profile.bundles order, not sorted', async () => {
    const home = await makeHome()
    await writeProfile(home, 'dshline', {
      dsh: { profile: { bundles: ['@zzz/last', '@aaa/first'] } },
    })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.bundles.map(bundle => bundle.packageName)).toEqual(['@zzz/last', '@aaa/first'])
  })

  it('treats a profile declaring no dsh section as having no bundles', async () => {
    const home = await makeHome()
    await writeProfile(home, 'hand-written', { name: 'whatever' })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.broken).toBeUndefined()
    expect(reading?.profiles[0]?.bundles).toEqual([])
  })
})

describe('what is installed for each bundle', () => {
  it('reports the version and the dsh.bundle declaration from the profile node_modules', async () => {
    const home = await makeHome()
    const dir = await writeProfile(home, 'dshline', {
      dependencies: { '@example/plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['@example/plugin'] } },
    })
    await writePackage(join(dir, 'node_modules'), '@example/plugin', {
      name: '@example/plugin',
      version: '1.2.3',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.bundles[0]).toEqual({
      packageName: '@example/plugin',
      version: '1.2.3',
      managed: true,
      declaresBundle: true,
    })
  })

  it('prefers the installation copy over a profile-local one, as Harness resolution does', async () => {
    // `resolveBundleDir` documents installation-first as the contract that an
    // in-box bundle always comes from the same installation as the running dsh.
    const home = await makeHome()
    const dir = await writeProfile(home, 'dshline', {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    await writePackage(join(home, PROFILES_DIR, 'node_modules'), '@deepseek-ai/dsh-base', {
      version: '9.9.9',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    await writePackage(join(dir, 'node_modules'), '@deepseek-ai/dsh-base', {
      version: '0.0.1',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.bundles[0]?.version).toBe('9.9.9')
  })

  it('reports no version rather than guessing when neither directory holds the package', async () => {
    const home = await makeHome()
    await writeProfile(home, 'dshline', {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.bundles[0]).toEqual({
      packageName: '@deepseek-ai/dsh-base',
      version: undefined,
      managed: false,
      declaresBundle: undefined,
    })
  })

  it('distinguishes a template bundle from a dependency-managed one', async () => {
    // `dsh plugin` only removes a layer whose package was a dependency, so
    // this is the fact an offer to remove has to be keyed on.
    const home = await makeHome()
    const dir = await writeProfile(home, 'dshline', {
      dependencies: { '@example/extra': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@example/extra'] } },
    })
    await writePackage(join(dir, 'node_modules'), '@example/extra', { version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.bundles.map(bundle => bundle.managed)).toEqual([false, true])
  })

  it('reports an installed copy that declares no dsh.bundle, which Harness will drop from the layers', async () => {
    const home = await makeHome()
    const dir = await writeProfile(home, 'dshline', {
      dependencies: { '@example/plain': '^1.0.0' },
      dsh: { profile: { bundles: ['@example/plain'] } },
    })
    await writePackage(join(dir, 'node_modules'), '@example/plain', { version: '2.0.0' })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.bundles[0]?.declaresBundle).toBe(false)
  })

  it('ignores a non-string entry in the bundle list rather than drawing an empty row', async () => {
    const home = await makeHome()
    await writeProfile(home, 'dshline', {
      dsh: { profile: { bundles: ['@example/real', '', 7, null] } },
    })
    const reading = await readProfiles(ctxFor(home))
    expect(reading?.profiles[0]?.bundles.map(bundle => bundle.packageName)).toEqual(['@example/real'])
  })
})

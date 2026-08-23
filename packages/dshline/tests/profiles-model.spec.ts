/**
 * The decisions `/profiles` makes: which `dsh plugin` arguments an operation
 * is, what a landed operation means for the running Host, and which
 * operations Harness would actually perform on a given bundle.
 */

import { describe, expect, it } from 'vitest'
import type { BundleRow, ProfileRow } from '../src/profiles/harness.ts'
import {
  bootCommand,
  bundleFacts,
  bundleMark,
  filterProfileRows,
  plausiblePackageSpec,
  profileMark,
  profileTags,
  removeEligibility,
  resolveOperation,
  restartNote,
  updateEligibility,
  validProfileName,
} from '../src/profiles/model.ts'

/** One bundle row, with sensible defaults. */
function bundle(overrides: Partial<BundleRow> = {}): BundleRow {
  return {
    packageName: '@example/plugin',
    version: '1.0.0',
    managed: true,
    declaresBundle: true,
    ...overrides,
  }
}

/** One profile row, with sensible defaults. */
function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    name: 'dshline',
    dir: '/home/.dsh/profiles/dshline',
    current: false,
    bundles: [],
    broken: undefined,
    ...overrides,
  }
}

describe('operations resolve to pnpm subcommands, forwarded verbatim', () => {
  it('add, remove, and update target one package', () => {
    expect(resolveOperation('add', '@example/plugin').args).toEqual(['add', '@example/plugin'])
    expect(resolveOperation('remove', '@example/plugin').args).toEqual(['remove', '@example/plugin'])
    expect(resolveOperation('update', '@example/plugin').args).toEqual(['update', '@example/plugin'])
  })

  it('update-all names no package, which is how pnpm updates every dependency', () => {
    expect(resolveOperation('update-all').args).toEqual(['update'])
  })

  it('creating a profile is a bare install, since dsh plugin initializes on first use', () => {
    // There is no `init` subcommand to call: `dsh plugin` initializes an
    // uninitialized profile before forwarding, so a harmless command creates
    // it and no template lives in this frontend.
    expect(resolveOperation('init').args).toEqual(['install'])
  })

  it('marks every bundle-membership change as needing a restart, and creation as not', () => {
    for (const operation of ['add', 'remove', 'update', 'update-all'] as const) {
      expect(resolveOperation(operation, '@example/plugin').restartRequired, operation).toBe(true)
    }
    // A brand-new profile composes nothing for THIS Host either way.
    expect(resolveOperation('init').restartRequired).toBe(false)
  })
})

describe('what a landed operation means for the running Host', () => {
  it('says restart required when the change hit the profile this Host booted', () => {
    const note = restartNote(resolveOperation('add', '@example/plugin'), profile({ current: true }))
    expect(note).toContain('restart required')
    expect(note).toContain('composed its plugins at boot')
  })

  it('names the boot command instead when the change hit any other profile', () => {
    // Reporting "restart required" for a profile this process never booted
    // would be theatre: nothing about the running Host is now out of date.
    expect(restartNote(resolveOperation('add', '@example/plugin'), profile({ name: 'web' })))
      .toBe('takes effect the next time you run dsh --profile web')
  })

  it('says nothing for an operation that changed no composition', () => {
    expect(restartNote(resolveOperation('init'), profile({ current: true }))).toBeUndefined()
  })

  it('names the command that boots a profile, because that is what switching IS', () => {
    expect(bootCommand(profile({ name: 'headless' }))).toBe('dsh --profile headless')
  })
})

describe('which operations Harness would actually perform', () => {
  it('refuses to remove a template bundle, which dsh plugin would not remove either', () => {
    // pnpm would run, succeed at removing nothing, and leave the layer in
    // place: a button reporting success while changing nothing.
    const refusal = removeEligibility(bundle({ packageName: '@deepseek-ai/dsh-base', managed: false }))
    expect(refusal.kind).toBe('refused')
    if (refusal.kind !== 'refused') throw new Error('expected refused')
    expect(refusal.reason).toContain('template')
    expect(refusal.reason).toContain('cordis.patch.yml')
  })

  it('allows removing a dependency-managed bundle', () => {
    const allowed = removeEligibility(bundle())
    expect(allowed.kind).toBe('allowed')
    if (allowed.kind !== 'allowed') throw new Error('expected allowed')
    expect(allowed.resolved.args).toEqual(['remove', '@example/plugin'])
  })

  it('refuses to update an in-box bundle, which moves when the dsh installation does', () => {
    const refusal = updateEligibility(bundle({ managed: false }))
    expect(refusal.kind).toBe('refused')
    if (refusal.kind !== 'refused') throw new Error('expected refused')
    expect(refusal.reason).toContain('dsh installation')
  })

  it('allows updating a dependency-managed bundle', () => {
    expect(updateEligibility(bundle()).kind).toBe('allowed')
  })
})

describe('marks and facts', () => {
  it('fills the mark for the profile this Host booted', () => {
    expect(profileMark(profile({ current: true }))).toBe('●')
    expect(profileMark(profile())).toBe('○')
  })

  it('tags the current profile and an unreadable one', () => {
    expect(profileTags(profile({ current: true }))).toEqual(['current'])
    expect(profileTags(profile({ broken: 'package.json is missing' }))).toEqual(['unreadable'])
    expect(profileTags(profile())).toEqual([])
  })

  it('confirms a bundle whose installed copy declares dsh.bundle', () => {
    expect(bundleMark(bundle())).toBe('✓')
    expect(bundleFacts(bundle())).toEqual(['1.0.0'])
  })

  it('warns on an installed copy that declares no dsh.bundle', () => {
    const plain = bundle({ declaresBundle: false, version: '2.0.0' })
    expect(bundleMark(plain)).toBe('⚠')
    expect(bundleFacts(plain)).toEqual(['2.0.0', 'installed copy declares no dsh.bundle'])
  })

  it('stays neutral about a bundle with no manifest found, which is ordinary for an in-box one', () => {
    const inbox = bundle({ managed: false, version: undefined, declaresBundle: undefined })
    expect(bundleMark(inbox)).toBe('·')
    expect(bundleFacts(inbox)).toEqual(['from the installation'])
  })

  it('says a managed bundle with no manifest is simply not installed yet', () => {
    const pending = bundle({ managed: true, version: undefined, declaresBundle: undefined })
    expect(bundleFacts(pending)).toEqual(['not installed'])
  })
})

describe('what a reader may type', () => {
  it('accepts an ordinary profile name', () => {
    expect(validProfileName('dshline')).toBe(true)
    expect(validProfileName('my-profile')).toBe(true)
  })

  it('refuses a name that would escape the profiles root', () => {
    // The same containment rule `resolveProfileDir` enforces, for the reason
    // it gives: the name becomes a path segment.
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'node_modules', 'has space']) {
      expect(validProfileName(name), name).toBe(false)
    }
  })

  it('forwards any package spec pnpm could plausibly accept', () => {
    // Re-deciding pnpm's grammar here would be a second package resolver that
    // disagrees with the real one on its first edge case.
    for (const spec of ['@scope/name', 'name@1.2.3', 'git+https://host/x.git', './local-plugin', 'file:../x']) {
      expect(plausiblePackageSpec(spec), spec).toBe(true)
    }
  })

  it('refuses only what cannot be an argument at all', () => {
    expect(plausiblePackageSpec('')).toBe(false)
    expect(plausiblePackageSpec('   ')).toBe(false)
    expect(plausiblePackageSpec('--force')).toBe(false)
  })
})

describe('filtering', () => {
  it('matches a profile by name or by one of its bundles', () => {
    const rows = [
      profile({ name: 'web', bundles: [bundle({ packageName: '@deepseek-ai/dsh-web-app' })] }),
      profile({ name: 'dshline', bundles: [bundle({ packageName: '@dshline/dshline' })] }),
    ]
    expect(filterProfileRows(rows, 'web').map(row => row.name)).toEqual(['web'])
    expect(filterProfileRows(rows, 'web-app').map(row => row.name)).toEqual(['web'])
    expect(filterProfileRows(rows, '').map(row => row.name)).toEqual(['web', 'dshline'])
    expect(filterProfileRows(rows, 'nothing')).toEqual([])
  })
})

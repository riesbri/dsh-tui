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
  pendingBuildInstructions,
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
    plain: [],
    pendingBuilds: [],
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

  it('update-all names the visible bundles explicitly, never a bare pnpm update', () => {
    // A bare `update` would update every dependency of the profile, including
    // plain libraries that are not bundle layers and are not shown here.
    expect(resolveOperation('update-all', undefined, ['@a/one', '@a/two']).args)
      .toEqual(['update', '@a/one', '@a/two'])
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
    // Short on purpose: the frame carries a persistent row with the reason, so
    // the result line does not repeat the explanation at length.
    expect(restartNote(resolveOperation('add', '@example/plugin'), profile({ current: true })))
      .toBe('restart required')
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
    // Worded from what was observed: not dependency-managed. It does NOT claim
    // the package is a shipped template or came from the installation.
    expect(refusal.reason).toContain('not dependency-managed by this profile')
    expect(refusal.reason).toContain('cordis.patch.yml')
    expect(refusal.reason).not.toContain('template')
    expect(refusal.reason).not.toContain('installation')
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
    expect(refusal.reason).toContain('not dependency-managed by this profile')
    expect(refusal.reason).not.toContain('installation')
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
    // Not "from the installation": no manifest was found in either directory,
    // which is not evidence about where the package came from.
    expect(bundleFacts(inbox)).toEqual(['version unavailable'])
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
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'node_modules']) {
      expect(validProfileName(name), name).toBe(false)
    }
  })

  it('accepts a name with whitespace, because Harness does', () => {
    // An earlier version refused this to keep the printed boot command
    // unquoted, which narrowed what Harness accepts to solve a presentation
    // problem — and would have refused a name `dsh plugin` could create a
    // moment later. `bootCommand` quotes instead.
    expect(validProfileName('my profile')).toBe(true)
    expect(bootCommand(profile({ name: 'my profile' }))).toBe("dsh --profile 'my profile'")
  })

  it('quotes only what needs it, so an ordinary name stays readable', () => {
    expect(bootCommand(profile({ name: 'dshline' }))).toBe('dsh --profile dshline')
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

describe('a profile whose operations pnpm is holding', () => {
  it('is tagged, so the state is visible before a key is pressed', () => {
    expect(profileTags(profile({ pendingBuilds: ['@a/one'] }))).toContain('builds pending')
    expect(profileTags(profile())).not.toContain('builds pending')
  })

  it('keeps the instruction short enough to survive a normal frame width', () => {
    // The filename is the only actionable part; an absolute path lost it.
    for (const line of pendingBuildInstructions(profile({ pendingBuilds: ['@google/genai', 'protobufjs'] }))) {
      expect(line.length, line).toBeLessThan(90)
    }
  })

  it('names the packages, the file, and the two values — and stops there', () => {
    // The instruction, not the decision: allowing a build script runs arbitrary
    // install-time code from a dependency.
    const lines = pendingBuildInstructions(profile({ pendingBuilds: ['@a/one', 'b'] })).join(' ')
    expect(lines).toContain('@a/one, b')
    // Profile-relative: the frame's header already names the root, and the
    // absolute form truncated away the filename at a normal width.
    expect(lines).toContain('dshline/pnpm-workspace.yaml')
    expect(lines).toContain('true or false')
  })

  it('says nothing when nothing is pending', () => {
    expect(pendingBuildInstructions(profile())).toEqual([])
  })
})

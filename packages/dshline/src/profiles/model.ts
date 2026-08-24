/**
 * What `/profiles` knows, as rows and decisions a terminal can draw.
 *
 * The one judgement this module makes that the filesystem does not is about
 * RESTART. A profile's composition is applied once, at boot: the launcher
 * stacks its bundle patches, mounts the tree, and the Host that results is
 * what the process is. Installing a bundle writes a package and a manifest
 * line; it does not reach into a composed tree and add rows to it. So every
 * mutation here is a change to what the NEXT Host will compose, and saying so
 * is not a caveat — it is the operation's actual scope.
 *
 * There is one deliberate exception, and it belongs to the layer below: the
 * profile's own `cordis.patch.yml` IS hot-reloaded by the launcher
 * (`watchUserPatches`). Bundle membership is not, which is exactly why this
 * module distinguishes them rather than reporting one restart rule for
 * "profiles".
 *
 * Switching profiles is not offered at all. A profile is chosen by the
 * launcher before any of this exists, the composed tree is the process, and
 * `recompose`-style re-linking has no analogue here — there is no seam that
 * swaps a Host's bundle layers under a running agent, and inventing one would
 * be exactly the competing lifecycle this frontend does not build. Another
 * profile is presented, and the command that boots it is named.
 * @module dshline/profiles/model
 */

import type { BundleRow, ProfileRow } from './harness.ts'

/** The mark a profile row earns. */
export type ProfileMark = '●' | '○'

/**
 * The glyph for one profile: filled for the profile this Host booted.
 * @param row - the profile row.
 * @returns the mark.
 */
export function profileMark(row: ProfileRow): ProfileMark {
  return row.current ? '●' : '○'
}

/**
 * The tags after a profile's name: which one is running, and whether it can
 * be read at all.
 * @param row - the profile row.
 * @returns the tags, most important first.
 */
export function profileTags(row: ProfileRow): string[] {
  const tags: string[] = []
  if (row.current) tags.push('current')
  if (row.broken !== undefined) tags.push('unreadable')
  return tags
}

/** The mark a bundle row earns from its installed state. */
export type BundleMark = '✓' | '·' | '⚠'

/**
 * The glyph for one bundle layer.
 *
 * Three states, and the third is the one worth a mark: a package the profile
 * composes as a layer but whose installed copy declares no `dsh.bundle`
 * contributes no patches, and Harness's own reconciliation drops it from the
 * layer list on the next `dsh plugin` run. A bundle with no manifest found is
 * neither confirmed nor broken — an in-box template bundle is not a
 * dependency and a never-installed profile has no `node_modules` — so it gets
 * the neutral mark rather than a warning it has not earned.
 * @param row - the bundle row.
 * @returns the mark.
 */
export function bundleMark(row: BundleRow): BundleMark {
  if (row.declaresBundle === false) return '⚠'
  return row.declaresBundle === true ? '✓' : '·'
}

/**
 * The right-hand facts for one bundle: its version, and anything unusual.
 * @param row - the bundle row.
 * @returns the facts, most useful first.
 */
export function bundleFacts(row: BundleRow): string[] {
  const facts: string[] = []
  if (row.version !== undefined) facts.push(row.version)
  if (row.declaresBundle === false) facts.push('installed copy declares no dsh.bundle')
  // An unresolved bundle is exactly that: no manifest was found in either
  // directory a bundle can live in. For a managed one that means the
  // dependency is not installed, which IS observed. For an unmanaged one it is
  // NOT evidence the package came from the installation — that would be a
  // claim about a source nothing here looked at; all that is known is that no
  // version could be read.
  else if (row.declaresBundle === undefined) {
    facts.push(row.managed ? 'not installed' : 'version unavailable')
  }
  return facts
}

/** Which `dsh plugin` operation a keystroke asks for. */
export type ProfileOperation = 'add' | 'update' | 'update-all' | 'remove' | 'init'

/**
 * One operation, resolved into the `dsh plugin` arguments that perform it.
 *
 * These are pnpm's own subcommands, forwarded verbatim — `dsh plugin` is
 * documented as "a thin pnpm forwarder", and the reconciliation of
 * `dsh.profile.bundles` happens on ITS side afterwards. Nothing here invents
 * an install step, a version resolution rule, or a lockfile touch.
 */
export interface ResolvedOperation {
  /** The operation asked for. */
  readonly operation: ProfileOperation
  /** Arguments after `dsh plugin --profile <name>`. */
  readonly args: readonly string[]
  /** What to say while it runs. */
  readonly running: string
  /** Whether success means the running Host is now out of date. */
  readonly restartRequired: boolean
}

/**
 * Resolve one operation into its `dsh plugin` arguments.
 *
 * `init` is `install` deliberately: `dsh plugin` initializes a profile
 * directory on first use for ANY invocation, so the way to create a profile is
 * to run a harmless command against it. There is no separate `init`
 * subcommand to call, and writing the manifest here instead would be a second
 * profile creator with its own idea of the template.
 * @param operation - the operation asked for.
 * @param packageName - the bundle it targets, where one applies.
 * @returns the resolved operation.
 */
export function resolveOperation(
  operation: ProfileOperation,
  packageName?: string,
  bundles: readonly string[] = [],
): ResolvedOperation {
  switch (operation) {
    case 'add':
      return {
        operation,
        args: ['add', packageName ?? ''],
        running: `installing ${packageName ?? ''}`,
        restartRequired: true,
      }
    case 'remove':
      return {
        operation,
        args: ['remove', packageName ?? ''],
        running: `removing ${packageName ?? ''}`,
        restartRequired: true,
      }
    case 'update':
      return {
        operation,
        args: ['update', packageName ?? ''],
        running: `updating ${packageName ?? ''}`,
        restartRequired: true,
      }
    case 'update-all':
      // Named packages, never a bare `pnpm update`. `dsh plugin` forwards
      // verbatim, and bare `update` updates every dependency of the profile —
      // including plain libraries that are not bundle layers and are not shown
      // here. Calling that "updating every bundle" would be a false label on a
      // wider mutation than the reader asked for, so the visible
      // dependency-managed bundles are listed explicitly.
      return {
        operation,
        args: ['update', ...bundles],
        running: bundles.length === 1
          ? `updating ${bundles.join('')}`
          : `updating ${String(bundles.length)} bundles`,
        restartRequired: true,
      }
    case 'init':
      // `install` with no package: pnpm reconciles the existing manifest and
      // `dsh plugin` initializes the directory first if it is new. A brand-new
      // profile composes nothing for THIS Host either way, so nothing about
      // the running process changes.
      return { operation, args: ['install'], running: 'initializing', restartRequired: false }
  }
}

/** Why an operation cannot be offered on a given row. */
export type OperationRefusal =
  /** It can be performed. */
  | { readonly kind: 'allowed'; readonly resolved: ResolvedOperation }
  /** It cannot, and this is what to say. */
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Whether removing one bundle is an operation Harness would actually perform.
 *
 * `dsh plugin`'s reconciliation only removes a layer whose package was a
 * DEPENDENCY: "template bundles (dsh-base and friends) are not dependencies".
 * Offering `remove @deepseek-ai/dsh-base` would run pnpm, succeed at removing
 * nothing, and leave the layer exactly where it was — a button that reports
 * success and changes nothing is worse than one that explains itself.
 * @param row - the bundle row.
 * @returns whether removal applies, or why it does not.
 */
export function removeEligibility(row: BundleRow): OperationRefusal {
  if (!row.managed) {
    return {
      kind: 'refused',
      reason: `${row.packageName} is part of this profile's template, not one of its dependencies — `
        + 'disable its rows in the profile\'s cordis.patch.yml instead',
    }
  }
  return { kind: 'allowed', resolved: resolveOperation('remove', row.packageName) }
}

/**
 * Whether updating one bundle applies.
 *
 * Same dependency rule as removal: pnpm updates what the manifest depends on,
 * and an in-box bundle moves when the dsh installation does.
 * @param row - the bundle row.
 * @returns whether an update applies, or why it does not.
 */
export function updateEligibility(row: BundleRow): OperationRefusal {
  if (!row.managed) {
    return {
      kind: 'refused',
      reason: `${row.packageName} comes from the dsh installation, not this profile — update dsh itself to move it`,
    }
  }
  return { kind: 'allowed', resolved: resolveOperation('update', row.packageName) }
}

/**
 * Whether "update every bundle" has anything to update.
 *
 * Only dependency-managed bundles can be updated by pnpm at all — an in-box
 * one moves when the dsh installation does — so the set this offers is exactly
 * the visible managed layers. An empty set is refused rather than turned into a
 * bare `pnpm update`, which would quietly widen the operation to every
 * dependency the profile has.
 * @param profile - the profile whose bundles to update.
 * @returns the operation, or why there is nothing to do.
 */
export function updateAllEligibility(profile: ProfileRow): OperationRefusal {
  const managed = profile.bundles.filter(row => row.managed).map(row => row.packageName)
  if (managed.length === 0) {
    return {
      kind: 'refused',
      reason: `${profile.name} has no dependency-managed bundles to update; `
        + 'its layers come from the dsh installation, which updates with dsh itself',
    }
  }
  return { kind: 'allowed', resolved: resolveOperation('update-all', undefined, managed) }
}

/**
 * Whether an operation on this profile can be performed at all right now.
 *
 * A non-current profile is fully operable: `dsh plugin --profile <name>` is
 * addressed by name and never touches the running Host, which is exactly why
 * the restart note below talks about the NEXT boot rather than this one. What
 * is refused is naming no profile at all.
 * @param profile - the profile the operation targets, when one is selected.
 * @returns whether operations apply, or why they do not.
 */
export function profileOperable(profile: ProfileRow | undefined): { readonly ok: boolean; readonly reason: string } {
  if (profile === undefined) return { ok: false, reason: 'no profile is selected' }
  return { ok: true, reason: '' }
}

/**
 * How a landed operation affects the running Host.
 *
 * Named per profile, because the answer genuinely differs: a change to the
 * profile this Host booted means the process is now composing something older
 * than the file says, while a change to any other profile has no bearing on it
 * whatsoever. Reporting "restart required" for the second would be theatre.
 * @param resolved - the operation that landed.
 * @param profile - the profile it was performed on.
 * @returns the sentence to append, or undefined when nothing needs saying.
 */
export function restartNote(resolved: ResolvedOperation, profile: ProfileRow): string | undefined {
  if (!resolved.restartRequired) return undefined
  return profile.current
    ? 'restart required — this Host composed its plugins at boot and keeps that composition until it exits'
    : `takes effect the next time you run dsh --profile ${profile.name}`
}

/**
 * The command that boots one profile, for a reader who wants to switch.
 *
 * The honest answer to "make this profile current". A composed Host cannot
 * swap its bundle layers, so this is not a fallback for a switch that failed —
 * it is what switching profiles IS.
 * @param row - the profile to boot.
 * @returns the command line.
 */
export function bootCommand(row: ProfileRow): string {
  return `dsh --profile ${row.name}`
}

/**
 * Normalize text for matching: case-folded, with runs of space collapsed.
 * @param value - raw text.
 * @returns the comparable form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * Whether a typed name could be a new profile directory.
 *
 * The same containment rule `resolveProfileDir` enforces, for the same reason
 * it gives: the name becomes a path segment, so a separator or a dot-segment
 * would place the profile outside the root the deployment authorized.
 * `node_modules` is refused because the launcher's own flat module fallback
 * occupies that sibling name.
 * @param name - the candidate profile name.
 * @returns whether Harness would accept it.
 */
export function validProfileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..' || name === 'node_modules') return false
  if (name.includes('/') || name.includes('\\')) return false
  // Beyond Harness's own containment rule, and the only addition to it: a name
  // carrying whitespace is one this browser cannot honestly echo back. Every
  // diagnostic here names the command that boots the profile
  // (`dsh --profile <name>`), and a name needing quotes to work would be
  // printed without them and read as two arguments.
  return !NAME_WHITESPACE.test(name)
}

/** Whitespace anywhere in a profile name — see {@link validProfileName}. */
const NAME_WHITESPACE = /\s/u

/**
 * Whether a typed string could be a package spec `dsh plugin add` would accept.
 *
 * Deliberately permissive: pnpm accepts registry names, versioned names,
 * tarball URLs, git specs, and filesystem paths, and re-deciding that grammar
 * here would be a second package resolver that disagrees with the real one on
 * its first edge case. What is refused is only what cannot be an argument at
 * all — empty, or a leading dash that pnpm would read as a flag.
 * @param spec - the typed package spec.
 * @returns whether it is worth forwarding.
 */
export function plausiblePackageSpec(spec: string): boolean {
  const trimmed = spec.trim()
  return trimmed !== '' && !trimmed.startsWith('-')
}

/**
 * Apply a query to profile rows, preserving name order.
 * @param rows - the profile rows.
 * @param query - raw query text.
 * @returns the matching rows.
 */
export function filterProfileRows(rows: readonly ProfileRow[], query: string): readonly ProfileRow[] {
  const needle = normalize(query)
  if (needle === '') return rows
  return rows.filter(row => normalize(row.name).includes(needle)
    || row.bundles.some(bundle => normalize(bundle.packageName).includes(needle)))
}

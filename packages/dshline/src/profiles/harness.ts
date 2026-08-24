/**
 * Reading Harness's own profile machinery: which profiles exist, which one
 * this process booted, and what each one composes.
 *
 * A Harness PROFILE is the layer above a preset. `dsh --profile <name>` boots
 * `$DSH_HOME/profiles/<name>`, whose `package.json` carries the ordered
 * `dsh.profile.bundles` list; each bundle is an npm package declaring
 * `dsh.bundle.patch`, and the Host's composition is those patch layers applied
 * in order, then the profile's own `cordis.patch.yml`. Profiles PROVIDE
 * capabilities to the Host; presets (`/plugins`) EXPOSE them to an agent.
 *
 * Two Harness-owned facts are read here and nothing else is derived:
 *
 * ```
 * ctx.dshHomePath('profiles')   the profiles root — Harness's own home-path
 *                               service, provided by `boot()` before any entry
 *                               mounts, so this is the same directory the
 *                               launcher resolved
 * ctx.baseUrl                   the booted profile's own directory — `boot()`
 *                               anchors it at `dirname(rootConfigPath)`, and
 *                               the profile launcher passes
 *                               `<profileDir>/cordis.yml`, so this IS which
 *                               profile is running
 * ```
 *
 * Deliberately NOT importing `@deepseek-ai/dsh-app-boot`, even though it
 * exports `resolveProfileDir`/`readProfileManifest`/`PROFILES_DIR`. That
 * package's own peer list is nine entries (four `cordis-plugin-*`,
 * `dsh-launch-environment`, `dsh-invariants`, `dsh-home-paths`,
 * `dsh-system-prompt`, `cordis`), and declaring them here would print
 * unmet-peer warnings for every profile that composes a frontend without the
 * launcher's boot graph — for helpers that, on the read side, amount to a
 * `JSON.parse` of a documented manifest. What this module reuses instead is
 * the SERVICE (`ctx.dshHomePath`) and the FORMAT, with every borrowed constant
 * named against its upstream definition below. Nothing here re-implements
 * bundle module resolution: the two directories a bundle can be installed in
 * are read in the order `profile.ts`'s own header documents, and a bundle
 * found in neither simply reports no version rather than being resolved by
 * some other route.
 *
 * Read-only by construction. Every mutation goes through `actions.ts`, which
 * shells out to `dsh plugin` — Harness's own package lifecycle — rather than
 * writing a manifest from here.
 * @module dshline/profiles/harness
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Directory under the Harness home holding every profile.
 *
 * Mirrors `PROFILES_DIR` in `@deepseek-ai/dsh-app-boot`'s `profile.ts`. A
 * literal rather than an import for the reason in this module's header; if
 * Harness ever moves it, the `/profiles` browser reports an empty roster
 * rather than misbehaving, and the sibling-name check below fails closed.
 */
export const PROFILES_DIR = 'profiles'

/**
 * The launcher-maintained flat module fallback, a sibling of every profile.
 *
 * Mirrors the same name in `profile.ts`. It is never a profile — Harness's own
 * `resolveProfileDir` rejects the name outright — and it is where every in-box
 * bundle (the ones a profile template lists but never depends on) is
 * resolvable from.
 */
const MODULE_FALLBACK_DIR = 'node_modules'

/** The profile manifest filename, and a bundle's. */
const MANIFEST_FILENAME = 'package.json'

/** The user's own patch layer inside a profile directory. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/**
 * Harness's `dshHomePath` service: join segments onto the resolved Harness
 * home. Provided by `boot()` before any entry mounts.
 */
export type DshHomePath = (...segments: string[]) => string

/** The `dsh` manifest section a profile or a bundle declares. */
interface DshManifestSection {
  /** Present on a BUNDLE: the patch layer it exports. */
  readonly bundle?: { readonly patch?: string }
  /** Present on a PROFILE: the ordered bundle list it composes. */
  readonly profile?: { readonly bundles?: readonly string[] }
}

/** The slice of a `package.json` this module reads. */
interface ReadManifest {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly dsh?: DshManifestSection
}

/** One bundle layer of a profile, as its manifest and installed state report it. */
export interface BundleRow {
  /** The package name, exactly as `dsh.profile.bundles` lists it. */
  readonly packageName: string
  /**
   * The installed version, when a manifest for this package was found in one
   * of the two directories a bundle can live in. Absent is a fact, not a
   * failure: an in-box bundle listed by a profile template is not a
   * dependency, and a fresh profile that has never had `install` run has no
   * `node_modules` at all.
   */
  readonly version: string | undefined
  /**
   * Whether the profile's `dependencies` name this package.
   *
   * This is what `dsh plugin`'s own reconciliation keys removal on: a template
   * bundle is not a dependency and `remove` would not touch it. Presenting the
   * distinction is what keeps the browser from offering a removal Harness
   * would decline to perform.
   */
  readonly managed: boolean
  /**
   * Whether the resolved package still declares `dsh.bundle`, when a manifest
   * was found. Harness reconciles the layer list against exactly this fact.
   */
  readonly declaresBundle: boolean | undefined
}

/** One profile directory, as Harness's own machinery would load it. */
export interface ProfileRow {
  /** The profile name; its directory basename, and the `--profile` argument. */
  readonly name: string
  /** Absolute profile directory. */
  readonly dir: string
  /** Whether this is the profile the running Host booted. */
  readonly current: boolean
  /** The ordered bundle layers, or empty when the manifest declares none. */
  readonly bundles: readonly BundleRow[]
  /**
   * Why this profile could not be read, when it could not. A directory under
   * the profiles root with an unreadable or non-object manifest is still shown
   * — it occupies its name, so hiding it would leave a profile that cannot be
   * created and cannot be seen.
   */
  readonly broken: string | undefined
}

/** What one pass over the profiles root found. */
export interface ProfilesReading {
  /** Absolute profiles root (`$DSH_HOME/profiles`). */
  readonly root: string
  /** Every profile directory, ordered by name. */
  readonly profiles: readonly ProfileRow[]
  /**
   * The profile this Host booted, when it could be determined from
   * `ctx.baseUrl`. Undefined means dshline cannot say — never a guess, since
   * every mutation is addressed by profile name and acting on the wrong one
   * would edit a composition nobody asked about.
   */
  readonly currentName: string | undefined
}

/**
 * Read Harness's `dshHomePath` service off a context.
 * @param ctx - the plugin context.
 * @returns the service, or undefined when this deployment provides none.
 */
export function dshHomePathOf(ctx: Context): DshHomePath | undefined {
  return ctx.get('dshHomePath') as DshHomePath | undefined
}

/**
 * The profile this process booted, from the Loader's own base URL.
 *
 * `boot()` sets `ctx.baseUrl` to `dirname(absoluteConfigPath)`, and the
 * profile launcher's config path is `<profileDir>/cordis.yml`, so the base
 * URL's directory IS the running profile's directory. Verified against the
 * profiles root rather than trusted: a deployment booting a config from
 * somewhere else entirely (a bare `boot()` embedder, a test) has a perfectly
 * valid `baseUrl` that names no profile, and answering with its basename would
 * invent one.
 * @param ctx - the plugin context.
 * @param root - the absolute profiles root.
 * @returns the profile name, or undefined when this Host booted no profile.
 */
export function currentProfileName(ctx: Context, root: string): string | undefined {
  const base = ctx.baseUrl
  if (typeof base !== 'string' || !base.startsWith('file:')) return undefined
  let dir: string
  try {
    // `boot()` sets `baseUrl` to `pathToFileURL(dirname(configPath)).href + '/'`
    // — it is ALREADY the directory, not a file in it, so this must not take a
    // `dirname` of its own. `resolve` only drops the trailing separator that
    // the appended `/` leaves behind, which `basename`/`dirname` below need
    // gone to see the last segment as a segment.
    dir = resolve(fileURLToPath(base))
  } catch {
    // A malformed or non-file URL names no directory to compare.
    return undefined
  }
  const name = basename(dir)
  // A direct child of the profiles root, and not the launcher's own flat
  // module fallback sibling (which Harness refuses as a profile name).
  if (dirname(dir) !== root || name === MODULE_FALLBACK_DIR || name === '') return undefined
  return name
}

/**
 * Parse one `package.json`, returning undefined rather than throwing.
 * @param path - absolute manifest path.
 * @returns the manifest, or undefined when absent or not a JSON object.
 */
async function readManifest(path: string): Promise<ReadManifest | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // Absent or unreadable. Both mean "no manifest here" to every caller.
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as ReadManifest
  } catch {
    return undefined
  }
}

/**
 * One bundle's installed manifest, from the two directories a bundle can be
 * installed in, in Harness's own resolution order.
 *
 * Installation first, then the profile — the order `resolveBundleDir`
 * documents as "the contract that `@deepseek-ai/dsh-base` (and every other
 * in-box bundle) always comes from the same installation as the running dsh,
 * never from a profile-local copy". The installation's copy is reachable here
 * through the launcher-maintained flat fallback beside the profiles root,
 * which exists precisely so in-box packages resolve from any profile.
 * @param packageName - the bundle's package name.
 * @param root - the absolute profiles root.
 * @param profileDir - the profile directory.
 * @returns the manifest, or undefined when neither directory holds one.
 */
async function readBundleManifest(
  packageName: string,
  root: string,
  profileDir: string,
): Promise<ReadManifest | undefined> {
  for (const modules of [join(root, MODULE_FALLBACK_DIR), join(profileDir, MODULE_FALLBACK_DIR)]) {
    const found = await readManifest(join(modules, packageName, MANIFEST_FILENAME))
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Read one profile directory: its bundle list, and what is installed for each.
 * @param name - the profile name.
 * @param root - the absolute profiles root.
 * @param current - whether this is the booted profile.
 * @returns the profile row.
 */
async function readProfile(name: string, root: string, current: boolean): Promise<ProfileRow> {
  const dir = join(root, name)
  const manifest = await readManifest(join(dir, MANIFEST_FILENAME))
  if (manifest === undefined) {
    return {
      name,
      dir,
      current,
      bundles: [],
      broken: `${MANIFEST_FILENAME} is missing or is not a JSON object`,
    }
  }
  const declared = manifest.dsh?.profile?.bundles
  // Harness fails loud on a malformed bundle list: `loadProfile` maps over it
  // and `resolveBundleDir` throws on anything that is not a resolvable package
  // name. Silently skipping a bad entry here would present a profile as healthy
  // that the launcher will refuse to boot, so the shape is checked and reported
  // instead — and only the SHAPE, since which names resolve is Harness's call.
  if (declared !== undefined && !Array.isArray(declared)) {
    return { name, dir, current, bundles: [], broken: 'dsh.profile.bundles is not a list' }
  }
  const malformed = (declared ?? []).filter(entry => typeof entry !== 'string' || entry === '')
  if (malformed.length > 0) {
    return {
      name,
      dir,
      current,
      bundles: [],
      broken: `dsh.profile.bundles holds ${String(malformed.length)} entry that is not a package name`,
    }
  }
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  const bundles: BundleRow[] = []
  for (const packageName of declared ?? []) {
    const installed = await readBundleManifest(packageName, root, dir)
    bundles.push({
      packageName,
      version: typeof installed?.version === 'string' ? installed.version : undefined,
      managed: dependencies.has(packageName),
      declaresBundle: installed === undefined ? undefined : installed.dsh?.bundle?.patch !== undefined,
    })
  }
  return { name, dir, current, bundles, broken: undefined }
}

/**
 * Read every profile under the Harness home, and which one is running.
 *
 * Unmemoized, like every other reading in this frontend: a profile directory
 * is created by `dsh plugin` (possibly by the action this browser just ran)
 * and a held copy is how a browser disagrees with the filesystem.
 * @param ctx - the plugin context, for `dshHomePath` and `baseUrl`.
 * @returns the reading, or undefined when no `dshHomePath` service is provided.
 */
export async function readProfiles(ctx: Context): Promise<ProfilesReading | undefined> {
  const home = dshHomePathOf(ctx)
  if (home === undefined) return undefined
  const root = home(PROFILES_DIR)
  const booted = currentProfileName(ctx, root)
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    // ONLY an absent root is an empty roster: nothing has been created yet, and
    // `dsh plugin` creates it on the first init. A permission or I/O failure is
    // not the same fact — presenting it as "no profiles" would tell a reader
    // their profiles are gone when they are merely unreadable — so it is
    // reported as a failed read.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { root, profiles: [], currentName: undefined }
  }
  const names = entries
    .filter(entry => entry.isDirectory() && entry.name !== MODULE_FALLBACK_DIR)
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))
  // A booted profile is only reported once the roster confirms it: the base URL
  // is evidence about this process, and the roster is evidence about the disk.
  // Marking a row `current` for a directory the roster does not list — deleted
  // under the running Host, or unreadable — would put the mark on nothing.
  const verified = names.includes(booted ?? '') ? booted : undefined
  const profiles = await Promise.all(names.map(async name => readProfile(name, root, name === verified)))
  return { root, profiles, currentName: verified }
}

/**
 * Point every Harness dependency — direct or dev — at the version the
 * registry currently publishes — deterministically, and only there.
 *
 * Before this tool, freshness came from floating dist-tags (`next`, and
 * cordis on `latest`) whose lockfile resolutions went stale until someone
 * remembered to refresh them, while a handful of packages sat pinned to lines
 * several releases old. An audit found exactly that rot: a fresh clone
 * typechecked against a mixture of rc.7, rc.8, and a cordis prerelease older
 * than its own stable release. Pinning the exact authoritative version of every
 * package, here and at the workspace root, turns "current" into a fact a
 * machine can check and a pull request can carry instead of a property of
 * whoever installed last.
 *
 * The authority for "current" is one dist-tag per package, defined once in
 * tools/check-peer-currency.mjs (`next` for the harness line, `latest` for
 * cordis) — the same map that decides whether our peer ranges tell the truth.
 * This tool writes what that map reads; it deliberately knows nothing about
 * semver beyond copying strings.
 *
 * Peer dependencies are NEVER written. A new published line that the current
 * ranges already accept is a routine update; one they reject needs an explicit
 * compatibility decision, and silently widening a range would take that
 * decision away. tools/check-peer-currency.mjs is the boundary between the two,
 * and the workflow's sync job uses its exit code to name the pull request
 * accordingly.
 *
 * @module tools/sync-harness
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authoritativeTag, HARNESS_LINE_SCOPE } from './check-peer-currency.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_MANIFESTS = [join(repoRoot, 'packages', 'dshline', 'package.json'), join(repoRoot, 'package.json')]
const REGISTRY_HOST = 'https://registry.npmjs.org'
const HARNESS_SCOPE = '@deepseek-ai/'

/**
 * Manifest fields this tool pins. `peerDependencies` is deliberately absent:
 * it is the public compatibility contract, measured by
 * `tools/check-peer-currency.mjs` and never written here. A direct Harness
 * runtime dependency belongs in `dependencies`, not only `devDependencies` —
 * `@deepseek-ai/dsh-atomic-write` is one today — and a ranged entry left out
 * of this list would let a disposable `pnpm install --no-frozen-lockfile`
 * resolve it to whatever the range's upper bound currently allows, silently
 * mixing one package from a different line into an otherwise coherent,
 * pinned graph.
 *
 * The two fields do not share one scope, though. `devDependencies` pins the
 * whole `@deepseek-ai/*` dev graph, cordis included — that is the existing,
 * tested behavior this tool has always had, and this dev graph is exactly
 * what `pnpm typecheck`/`pnpm test` build against, so it needs every
 * substrate package current, not only the dsh-* line. `dependencies` is
 * narrower on purpose: it also carries foundational, independently-versioned
 * `@deepseek-ai/*` packages such as `schemastery` that are not part of "the
 * Harness line" this compatibility promise is about, so only names matching
 * {@link HARNESS_LINE_SCOPE} are pinned there.
 */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies']

/** Which names in a given field this tool is allowed to pin. */
const FIELD_SCOPE = {
  dependencies: name => HARNESS_LINE_SCOPE.test(name),
  devDependencies: name => name.startsWith(HARNESS_SCOPE),
}

/**
 * Read a packument from the public registry.
 * @param name - the package name.
 * @returns the decoded packument document.
 */
async function defaultFetchPackument(name) {
  const response = await fetch(`${REGISTRY_HOST}/${encodeURIComponent(name)}`)
  if (!response.ok) throw new Error(`registry returned ${String(response.status)} for ${name}`)
  return response.json()
}

/**
 * The version each named package should be pinned to.
 * @param names - package names to resolve; non-Harness names are ignored,
 *   because ordinary dependencies belong to Dependabot, not to this contract.
 * @param fetchPackument - injected registry access, for tests.
 * @returns a map from package name to the exact authoritative version.
 */
export async function desiredVersions(names, fetchPackument = defaultFetchPackument) {
  const desired = new Map()
  for (const name of names) {
    if (!name.startsWith(HARNESS_SCOPE)) continue
    const tag = authoritativeTag(name)
    const packument = await fetchPackument(name)
    // A missing document (rate limit, renamed package) must read as the tag
    // being unavailable, not as a TypeError about property access.
    const version = packument === null || packument === undefined ? undefined : packument['dist-tags']?.[tag]
    if (version === undefined) throw new Error(`${name} has no ${tag} dist-tag on the registry`)
    desired.set(name, version)
  }
  return desired
}

/**
 * One pending change to a manifest field's dependency map.
 * @typedef {object} ManifestUpdate
 * @property {string} field - which map moves: `dependencies` or `devDependencies`.
 * @property {string} name - the package whose specification moves.
 * @property {string|undefined} from - the current specification; undefined when
 *   the package is missing entirely and would be added.
 * @property {string} to - the exact authoritative version.
 */

/**
 * Compute what one dependency map must become. Only Harness-scope entries are
 * considered, so peer ranges and ordinary dependencies pass through untouched
 * by construction rather than by discipline.
 * @param dependencies - the manifest's current dependency map (`dependencies` or `devDependencies`).
 * @param desired - the target versions from {@linkcode desiredVersions}, resolved for this map's own keys.
 * @returns the sorted list of changes; empty when the map is current.
 */
export function manifestUpdates(dependencies, desired) {
  const updates = []
  for (const [name, version] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
    const current = dependencies[name]
    if (current === version) continue
    updates.push({ name, from: current, to: version })
  }
  return updates
}

/**
 * Compute the changes one manifest needs, across every field in
 * {@linkcode DEPENDENCY_FIELDS}, without writing anything. This is what both
 * `--check` and the write path are built on, so the two can never disagree
 * about whether a file is current.
 *
 * Each field resolves its desired versions from its OWN keys, not a union
 * across fields: a Harness package that lives only in `dependencies` must
 * never be proposed as a new `devDependencies` entry (or the reverse) just
 * because the other field happens to want a version for that name too.
 * @param manifestPath - the manifest to inspect.
 * @param fetchPackument - injected registry access, for tests.
 * @returns the manifest and its pending changes; empty updates mean already current.
 */
export async function computeUpdates(manifestPath, fetchPackument = defaultFetchPackument) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const updates = []
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field] ?? {}
    const names = Object.keys(dependencies).filter(FIELD_SCOPE[field])
    const desired = await desiredVersions(names, fetchPackument)
    for (const update of manifestUpdates(dependencies, desired)) updates.push({ ...update, field })
  }
  return { manifest, updates }
}

/**
 * Write reconciled dependency maps back to one manifest.
 * @param manifestPath - the manifest to write.
 * @param manifest - the parsed manifest with {@linkcode manifestUpdates} applied to each field present.
 * @returns resolves when the file is on disk.
 */
async function writeUpdates(manifestPath, manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] === undefined) continue
    manifest[field] = Object.fromEntries(Object.entries(manifest[field]).sort(([a], [b]) => a.localeCompare(b)))
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Rewrite one manifest so every Harness dependency — direct or dev — is
 * pinned to the authoritative published version. The file is written with
 * sorted keys and a trailing newline, matching how every other tool here
 * edits manifests, so an empty sync produces no diff and a full one produces
 * a reviewable one.
 * @param manifestPath - the manifest to reconcile.
 * @param fetchPackument - injected registry access, for tests.
 * @returns the changes applied; empty means the file was already current.
 */
export async function syncManifest(manifestPath, fetchPackument = defaultFetchPackument) {
  const { manifest, updates } = await computeUpdates(manifestPath, fetchPackument)
  if (updates.length === 0) return updates
  for (const update of updates) manifest[update.field][update.name] = update.to
  await writeUpdates(manifestPath, manifest)
  return updates
}

/**
 * Format the change list for humans and pull-request bodies alike.
 * @param manifestPath - the manifest the changes belong to.
 * @param updates - the changes from {@linkcode syncManifest}.
 * @returns the report block, ending in a newline.
 */
export function formatUpdates(manifestPath, updates) {
  const width = Math.max(...updates.map(update => update.name.length), 'package'.length)
  const lines = [`--- ${manifestPath}`]
  for (const update of updates) {
    const from = update.from === undefined ? '(absent)' : update.from
    const field = update.field === 'devDependencies' ? '' : ` [${update.field}]`
    lines.push(`${update.name.padEnd(width)}  ${from} -> ${update.to}${field}`)
  }
  return [...lines, ''].join('\n')
}

// Entry point: vitest imports this module for the pure functions, so the
// side-effecting CLI runs only when executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const checkOnly = process.argv.slice(2).includes('--check')
  const reports = []
  const pending = []
  let total = 0
  for (const manifestPath of HARNESS_MANIFESTS) {
    const { manifest, updates } = await computeUpdates(manifestPath)
    total += updates.length
    if (updates.length > 0) {
      reports.push(formatUpdates(manifestPath, updates))
      pending.push({ manifestPath, manifest, updates })
    }
  }
  if (total === 0) {
    process.stdout.write('every Harness dependency (direct or dev) is already at its authoritative published version\n')
    process.exit(0)
  }
  for (const report of reports) process.stdout.write(report)
  if (checkOnly) {
    process.stdout.write('manifests are behind the published line; run `node tools/sync-harness.mjs` to pin them\n')
    process.exit(1)
  }
  for (const { manifestPath, manifest, updates } of pending) {
    for (const update of updates) manifest[update.field][update.name] = update.to
    await writeUpdates(manifestPath, manifest)
  }
  process.stdout.write(`pinned ${String(total)} packages; run \`pnpm install\` to refresh the lockfile\n`)
}

/**
 * Check that every Harness peer range actually accepts what the registry
 * currently publishes.
 *
 * Peer ranges are this bundle's compatibility contract, and prerelease semver
 * quietly breaks them across release lines: `^0.1.0-rc.7` accepts `0.1.0-rc.8`
 * but rejects `0.1.1-rc.1`, because npm ranges only match prereleases whose
 * major.minor.patch tuple appears with a prerelease inside the range itself.
 * The harness publishes whole new lines under its `next` tag, so a range that
 * was true last week can reject today's authoritative line while everything
 * still works at runtime — exactly the state where package metadata lies.
 *
 * This tool asks, per peer: does the range accept the version the
 * authoritative dist-tag points at? A red result means either the range needs
 * an explicit compatibility decision (extend it, or hold the line) or the
 * published line genuinely broke us and the typecheck job will say where.
 *
 * The comparison is deliberately hand-rolled and narrow: only the caret forms
 * this repository writes are supported, and anything else fails loudly rather
 * than approximating. That keeps the renderer-package rule intact — no new
 * dependencies, including development ones — at the cost of refusing ranges
 * the day someone reaches past carets, which is the trade worth making here.
 *
 * Run by the released-line job in `.github/workflows/harness-compatibility.yml`
 * next to a full build, typecheck, and test against freshly resolved published
 * types; also runnable directly before publishing. Needs network access to the
 * public npm registry, so it lives in that weekly job and not in ordinary CI.
 * @module tools/check-peer-currency
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_MANIFEST = join(repoRoot, 'packages', 'dshline', 'package.json')
const REGISTRY_HOST = 'https://registry.npmjs.org'

/**
 * The dist-tag that tracks the line consumers actually run, per package.
 *
 * The harness packages publish their moving line under `next` and leave
 * `latest` on older numbering schemes. cordis is inverted: its `next` can be
 * an older prerelease than its stable release, which the entire current
 * harness line peers on. Keep this in step with the map in
 * tools/link-harness.mjs, which restores the same tags after source-linking.
 */
const AUTHORITATIVE_TAG_OVERRIDES = {
  '@deepseek-ai/cordis': 'latest',
}

/** The dist-tag that tracks the line consumers actually run, by default. */
const AUTHORITATIVE_TAG_DEFAULT = 'next'

/**
 * The dist-tag a package's published truth is read from.
 * @param name - the package name.
 * @returns the authoritative dist-tag for that package.
 */
export function authoritativeTag(name) {
  return AUTHORITATIVE_TAG_OVERRIDES[name] ?? AUTHORITATIVE_TAG_DEFAULT
}

/**
 * A parsed semantic version, split for comparison.
 * @typedef {object} ParsedVersion
 * @property {number} major - incompatible-API boundary.
 * @property {number} minor - capability boundary.
 * @property {number} patch - fix boundary.
 * @property {string[]} prerelease - dot-separated identifiers, empty when final.
 */

/**
 * Parse a semantic version. Build metadata is tolerated and ignored, because
 * the registry never serves two builds of one version and no comparison here
 * needs it.
 * @param version - the version string, e.g. `0.1.1-rc.2`.
 * @returns the parsed form.
 * @throws when the string is not `major.minor.patch[-prerelease]`.
 */
export function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (match === null) throw new Error(`unsupported version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare one prerelease identifier pair. Numeric identifiers compare as
 * numbers and always rank below alphanumeric ones; alphanumerics compare in
 * ASCII order, per the semantic-versioning specification.
 * @param a - left identifier.
 * @param b - right identifier.
 * @returns negative when a ranks first, positive when b does, zero when equal.
 */
function comparePrereleaseIdentifier(a, b) {
  const numericA = /^\d+$/.test(a)
  const numericB = /^\d+$/.test(b)
  if (numericA && numericB) return Math.sign(Number(a) - Number(b))
  if (numericA !== numericB) return numericA ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Order two parsed versions by semantic-versioning precedence.
 * @param a - left version.
 * @param b - right version.
 * @returns negative when a precedes b, positive when it follows, zero when equal.
 */
export function compareVersions(a, b) {
  const fields = [a.major - b.major, a.minor - b.minor, a.patch - b.patch]
  const tuple = fields.find(difference => difference !== 0)
  if (tuple !== undefined) return Math.sign(tuple)
  if (a.prerelease.length !== 0 || b.prerelease.length !== 0) {
    // A prerelease binds a version to its tuple's pre-final window, so it
    // always ranks below the same tuple without one.
    if (a.prerelease.length === 0) return 1
    if (b.prerelease.length === 0) return -1
    // Identifiers decide before list length does: rc.10 outranks rc.9 even
    // though a length-first comparison would never reach them.
    const shared = Math.min(a.prerelease.length, b.prerelease.length)
    for (let index = 0; index < shared; index += 1) {
      const difference = comparePrereleaseIdentifier(a.prerelease[index], b.prerelease[index])
      if (difference !== 0) return difference
    }
    // All shared identifiers equal: semver gives the longer list precedence.
    return Math.sign(a.prerelease.length - b.prerelease.length)
  }
  return 0
}

/**
 * One caret comparator, normalized to inclusive-lower/exclusive-upper bounds.
 * @typedef {object} Comparator
 * @property {ParsedVersion} lower - smallest accepted version, inclusive.
 * @property {ParsedVersion} upper - smallest rejected version, exclusive.
 */

/**
 * Parse a single caret comparator. The caret's upper bound is the next
 * boundary at the leftmost non-zero field, so `^4.0.1` ends at `5.0.0`,
 * `^0.1.1` at `0.2.0`, and `^0.0.3` at `0.0.4`.
 * @param source - the comparator text, e.g. `^0.1.1-rc.2`.
 * @returns the normalized bounds.
 * @throws on any syntax beyond carets, which would silently mis-measure.
 */
function parseComparator(source) {
  if (!source.startsWith('^')) {
    throw new Error(`unsupported comparator ${source}: this checker understands only caret ranges`)
  }
  const lower = parseVersion(source.slice(1))
  const upper = lower.major > 0
    ? { ...lower, major: lower.major + 1, minor: 0, patch: 0, prerelease: [] }
    : lower.minor > 0
      ? { ...lower, minor: lower.minor + 1, patch: 0, prerelease: [] }
      : { ...lower, patch: lower.patch + 1, prerelease: [] }
  return { lower, upper }
}

/**
 * Whether one comparator set accepts a version.
 *
 * npm's prerelease rule decides the answer for release candidates: a
 * prerelease version is only eligible when the set itself carries a
 * prerelease comparator on the SAME major.minor.patch tuple. That is why
 * `^0.1.0-rc.7` admits `0.1.0-rc.8` but refuses `0.1.1-rc.1`, and it is the
 * whole reason this tool exists.
 * @param version - the candidate version, unparsed.
 * @param comparators - the AND-ed comparators of one `||` alternative.
 * @returns whether every comparator accepts the candidate.
 */
function setAccepts(version, comparators) {
  const parsed = parseVersion(version)
  const withinBounds = comparators.every(({ lower, upper }) =>
    compareVersions(parsed, lower) >= 0 && compareVersions(parsed, upper) < 0,
  )
  if (!withinBounds) return false
  if (parsed.prerelease.length === 0) return true
  return comparators.some(({ lower }) =>
    lower.prerelease.length > 0 &&
    lower.major === parsed.major && lower.minor === parsed.minor && lower.patch === parsed.patch,
  )
}

/**
 * Whether a range accepts a version, following npm's semantics for the caret
 * grammar this repository uses.
 * @param version - the candidate version, e.g. a dist-tag target.
 * @param range - the range text, alternatives joined by `||`.
 * @returns whether any alternative accepts the candidate.
 */
export function satisfiesRange(version, range) {
  return range.split('||').some(alternative =>
    setAccepts(version, alternative.trim().split(/\s+/).map(parseComparator)),
  )
}

/**
 * One peer's verdict against the registry.
 * @typedef {object} PeerVerdict
 * @property {string} name - the peer package name.
 * @property {string} range - the declared peer range.
 * @property {string} tag - the authoritative dist-tag consulted.
 * @property {string} version - the version that tag points at.
 * @property {boolean} accepted - whether the range admits that version.
 */

/**
 * Check every Harness peer range against its authoritative dist-tag.
 * @param peers - the peerDependencies map to check; non-Harness entries are skipped,
 *   because they follow ordinary semver and Dependabot already watches them.
 * @param fetchPackument - injected registry access, mapping a package name to
 *   its packument (or a response-like object with `json()`), for tests.
 * @returns one verdict per checked peer.
 */
export async function checkPeerCurrency(peers, fetchPackument = defaultFetchPackument) {
  const verdicts = []
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const tag = authoritativeTag(name)
    const packument = await fetchPackument(name)
    const version = packument['dist-tags']?.[tag]
    if (version === undefined) throw new Error(`${name} has no ${tag} dist-tag on the registry`)
    verdicts.push({ name, range, tag, version, accepted: satisfiesRange(version, range) })
  }
  return verdicts
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
 * Format the verdict lines the way the weekly job prints them.
 * @param verdicts - the results of {@linkcode checkPeerCurrency}.
 * @returns the human-readable report, ending in a newline.
 */
export function formatReport(verdicts) {
  const nameWidth = Math.max(...verdicts.map(verdict => verdict.name.length))
  const rangeWidth = Math.max(...verdicts.map(verdict => verdict.range.length))
  const lines = verdicts.map(verdict =>
    `${verdict.name.padEnd(nameWidth)}  ${verdict.range.padEnd(rangeWidth)} ${verdict.tag}@${verdict.version}  ${verdict.accepted ? 'ok' : 'REJECTED'}`,
  )
  return [...lines, ''].join('\n')
}

// Entry point: vitest imports this module for the pure functions above, so the
// side-effecting CLI runs only when executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const manifest = JSON.parse(await readFile(BUNDLE_MANIFEST, 'utf8'))
  const peers = manifest.peerDependencies ?? {}
  const verdicts = await checkPeerCurrency(peers)
  process.stdout.write(formatReport(verdicts))
  const rejected = verdicts.filter(verdict => !verdict.accepted)
  if (rejected.length > 0) {
    process.stdout.write(`the peer range${rejected.length === 1 ? '' : 's'} of ${rejected.map(verdict => verdict.name).join(', ')}` +
      ` do${rejected.length === 1 ? 'es' : ''} not accept the currently published line\n`)
    process.stdout.write('extend the range or make the compatibility decision explicit — see docs/architecture.md, "Upstream compatibility"\n')
    process.exit(1)
  }
}

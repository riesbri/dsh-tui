/**
 * The adopted Harness generation, and everything that has to agree with it.
 *
 * `HARNESS_TARGET` at the repository root names one upstream commit and the
 * npm version cut from it. That pair is the whole compatibility promise:
 * dshline targets ONE Harness architecture at a time, and anything claiming
 * otherwise — a manifest still pinned to a previous line, a peer range still
 * admitting a generation dshline no longer builds against — is a lie this
 * module turns into a failing check rather than a surprise at release time.
 *
 * It replaces four tools that existed to maintain several Harness lines at
 * once: a fixed floor pin, a dist-tag sync, a peer-currency probe against
 * whatever the registry published last, and a GitHub-release comparison. All
 * four answered "what is out there"; none answered "what did we deliberately
 * adopt", and the difference is the entire policy. A dist-tag is a moving
 * pointer someone else controls, so nothing here reads one: the target is an
 * exact commit and an exact version, both reproducible.
 *
 * Scope is the `dsh-*` line only ({@link HARNESS_LINE_SCOPE}). cordis and
 * `@deepseek-ai/schemastery` version on their own numbering, are not cut from
 * the Harness revision this file records, and stay ordinary semver
 * dependencies Dependabot watches.
 *
 * Usage:
 *   node tools/harness-target.mjs              # is the repository coherent with the target?
 *   node tools/harness-target.mjs --revision   # print the adopted commit
 *   node tools/harness-target.mjs --version    # print the adopted npm version
 *   node tools/harness-target.mjs --pin        # rewrite both manifests to the target version
 *   node tools/harness-target.mjs --published  # has npm published the target version yet?
 * @module tools/harness-target
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_FILE = join(repoRoot, 'HARNESS_TARGET')
const BUNDLE_MANIFEST = join(repoRoot, 'packages', 'dshline', 'package.json')
const WORKSPACE_MANIFEST = join(repoRoot, 'package.json')
const MANIFESTS = [BUNDLE_MANIFEST, WORKSPACE_MANIFEST]
const REGISTRY_HOST = 'https://registry.npmjs.org'

/** The package a consumer installs, and therefore the one whose publication decides whether the target is reachable. */
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/**
 * Manifest fields the target pins. `peerDependencies` is the public
 * compatibility contract and is deliberately absent: it is CHECKED against
 * the target and never rewritten, so widening or narrowing what dshline
 * promises stays a decision a human writes down rather than a side effect of
 * running a tool.
 */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies']

/**
 * Matches the `dsh-*` line — the packages cut from the Harness revision this
 * module tracks. Narrower than a bare `@deepseek-ai/` prefix on purpose:
 * cordis and `@deepseek-ai/schemastery` share the scope but not the release
 * cadence, so pinning them to a Harness version would be wrong rather than
 * merely noisy.
 */
export const HARNESS_LINE_SCOPE = /^@deepseek-ai\/dsh-/

/**
 * The adopted Harness generation.
 * @typedef {object} HarnessTarget
 * @property {string} revision - the exact upstream commit, 40 lowercase hex characters.
 * @property {string} version - the npm version cut from that revision.
 */

/**
 * Parse `HARNESS_TARGET`. The format is two `key value` lines and comments —
 * small enough to read at a glance and to hand to `grep`, which is the point:
 * a migration edits this file, and a format needing a parser to understand
 * would invite a second copy of the truth somewhere more convenient.
 * @param text - the file's contents.
 * @returns the adopted target.
 * @throws when a field is missing, duplicated, unknown, or malformed — never a partial target.
 */
export function parseTarget(text) {
  /** @type {Record<string, string>} */
  const fields = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const [key, value, ...rest] = line.split(/\s+/)
    if (value === undefined || rest.length > 0) throw new Error(`HARNESS_TARGET: expected "key value", got: ${line}`)
    if (key !== 'revision' && key !== 'version') throw new Error(`HARNESS_TARGET: unknown field: ${key}`)
    if (key in fields) throw new Error(`HARNESS_TARGET: ${key} declared twice`)
    fields[key] = value
  }
  for (const key of ['revision', 'version']) {
    if (!(key in fields)) throw new Error(`HARNESS_TARGET: missing ${key}`)
  }
  // A branch name or short SHA would make the "blocking" lane follow whatever
  // that pointer means on the day it runs, which is precisely the property
  // the upstream lane owns and this one must not have.
  if (!/^[0-9a-f]{40}$/.test(fields.revision)) {
    throw new Error(`HARNESS_TARGET: revision must be a full 40-character commit sha, got: ${fields.revision}`)
  }
  parseVersion(fields.version)
  return { revision: fields.revision, version: fields.version }
}

/**
 * Read the adopted target from disk.
 * @returns the adopted target.
 */
export async function readTarget() {
  return parseTarget(await readFile(TARGET_FILE, 'utf8'))
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
 * whole reason a hand-rolled checker exists here at all.
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
 * @param version - the candidate version, e.g. the adopted target version.
 * @param range - the range text, alternatives joined by `||`.
 * @returns whether any alternative accepts the candidate.
 */
export function satisfiesRange(version, range) {
  return range.split('||').some(alternative =>
    setAccepts(version, alternative.trim().split(/\s+/).map(parseComparator)),
  )
}

/**
 * Compute the changes one dependency map needs to sit exactly on the target
 * version. A ranged entry is collapsed to an exact pin the same as any other:
 * `@deepseek-ai/dsh-atomic-write` is a direct runtime dependency whose caret
 * upper bound would otherwise let a non-frozen install resolve it away from
 * the adopted generation while everything around it stays put.
 * @param dependencies - the manifest's current dependency map.
 * @param version - the exact version every matching entry must carry.
 * @returns the sorted list of changes; empty when the map already matches.
 */
export function targetUpdates(dependencies, version) {
  const updates = []
  for (const [name, current] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
    if (!HARNESS_LINE_SCOPE.test(name) || current === version) continue
    updates.push({ name, from: current, to: version })
  }
  return updates
}

/**
 * One peer range's verdict against the adopted target.
 * @typedef {object} PeerVerdict
 * @property {string} name - the peer package name.
 * @property {string} range - the declared peer range.
 * @property {boolean} accepted - whether the range admits the target version.
 * @property {boolean} single - whether the range names exactly one generation.
 */

/**
 * Check every `dsh-*` peer range against the adopted target version, in both
 * directions a range can lie.
 *
 * A range that REJECTS the target understates what dshline supports. A range
 * carrying a second `||` alternative overstates it, and this repository
 * shipped exactly that: a `|| ^0.1.2-alpha.2` arm promising a generation the
 * bundle no longer compiles against, left behind from when several Harness
 * lines were maintained at once. One adopted generation means one alternative
 * — anything else is a compatibility promise nothing tests.
 * @param peers - the bundle's `peerDependencies` map; non-`dsh-*` entries follow ordinary semver and are skipped.
 * @param version - the adopted target version.
 * @returns one verdict per checked peer, in manifest order.
 */
export function checkPeers(peers, version) {
  return Object.entries(peers)
    .filter(([name]) => HARNESS_LINE_SCOPE.test(name))
    .map(([name, range]) => ({
      name,
      range,
      accepted: satisfiesRange(version, range),
      single: range.split('||').length === 1,
    }))
}

/**
 * Whether the registry carries an exact version of a package.
 *
 * Deliberately a `versions` lookup rather than a dist-tag read: which channel
 * upstream publishes a generation under (`next`, `alpha`, `rc`, …) is a
 * distribution detail that changes without dshline's architecture changing,
 * and a check keyed on the channel name would need redesigning every time it
 * moved. The exact version either exists or it does not.
 * @param name - the package name.
 * @param version - the exact version to look for.
 * @param fetchPackument - injected registry access, for tests.
 * @returns whether npm serves that version today.
 */
export async function isPublished(name, version, fetchPackument = defaultFetchPackument) {
  const packument = await fetchPackument(name)
  return Object.hasOwn(packument.versions ?? {}, version)
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
 * Render the coherence report: which pins and peer ranges disagree with the
 * adopted target, and which are already on it.
 * @param target - the adopted target.
 * @param pinProblems - `{ manifest, field, name, from }` entries whose spec is not the target version.
 * @param peerVerdicts - the result of {@linkcode checkPeers}.
 * @returns the report text, ending in a newline.
 */
export function formatReport(target, pinProblems, peerVerdicts) {
  const lines = [`Harness target ${target.version} @ ${target.revision.slice(0, 8)}`]
  lines.push(pinProblems.length === 0
    ? `✓ every dsh-* dependency in both manifests is pinned to ${target.version}`
    : `✗ ${String(pinProblems.length)} dsh-* dependenc${pinProblems.length === 1 ? 'y is' : 'ies are'} not on ${target.version}:`)
  for (const problem of pinProblems) {
    lines.push(`  ${problem.manifest} (${problem.field}): ${problem.name} ${problem.from}`)
  }
  const wrong = peerVerdicts.filter(verdict => !verdict.accepted || !verdict.single)
  lines.push(wrong.length === 0
    ? `✓ every dsh-* peer range names ${target.version}'s generation and nothing else`
    : `✗ ${String(wrong.length)} dsh-* peer ${wrong.length === 1 ? 'range disagrees' : 'ranges disagree'} with ${target.version}:`)
  for (const verdict of wrong) {
    const reason = !verdict.accepted ? 'rejects the target' : 'promises more than one Harness generation'
    lines.push(`  ${verdict.name} ${verdict.range} — ${reason}`)
  }
  if (pinProblems.length > 0 || wrong.length > 0) {
    lines.push('run `node tools/harness-target.mjs --pin && pnpm install`, or fix the peer ranges by hand —')
    lines.push('a peer range is a compatibility promise and is never rewritten by a tool.')
  }
  return [...lines, ''].join('\n')
}

/**
 * Collect every dependency spec that disagrees with the target version.
 * @param target - the adopted target.
 * @returns one entry per disagreeing spec, with the manifest it came from.
 */
async function collectPinProblems(target) {
  const problems = []
  for (const manifestPath of MANIFESTS) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const field of DEPENDENCY_FIELDS) {
      for (const update of targetUpdates(manifest[field] ?? {}, target.version)) {
        problems.push({ manifest: relativeManifest(manifestPath), field, name: update.name, from: update.from })
      }
    }
  }
  return problems
}

/**
 * A manifest path as it reads in a report, relative to the repository root.
 * @param manifestPath - the absolute path.
 * @returns the repository-relative path.
 */
function relativeManifest(manifestPath) {
  return manifestPath.slice(repoRoot.length + 1)
}

// Entry point: vitest imports the pure functions above, so the side-effecting
// CLI runs only when this file is executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [flag, ...rest] = process.argv.slice(2)
  if (rest.length > 0) {
    process.stderr.write('usage: node tools/harness-target.mjs [--revision | --version | --pin | --published]\n')
    process.exit(2)
  }
  const target = await readTarget()

  if (flag === '--revision') {
    process.stdout.write(`${target.revision}\n`)
  } else if (flag === '--version') {
    process.stdout.write(`${target.version}\n`)
  } else if (flag === '--published') {
    // A fact, not a verdict: npm lagging the adopted source revision is
    // expected and is reported as such. The caller decides what it means.
    const published = await isPublished(LAUNCHER_PACKAGE, target.version)
    process.stdout.write(`published=${published ? 'true' : 'false'}\n`)
  } else if (flag === '--pin') {
    let total = 0
    for (const manifestPath of MANIFESTS) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      let changed = false
      for (const field of DEPENDENCY_FIELDS) {
        const dependencies = manifest[field]
        if (dependencies === undefined) continue
        const updates = targetUpdates(dependencies, target.version)
        if (updates.length === 0) continue
        for (const update of updates) dependencies[update.name] = update.to
        manifest[field] = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
        for (const update of updates) {
          process.stdout.write(`${relativeManifest(manifestPath)} (${field}): ${update.name} ${update.from} -> ${update.to}\n`)
        }
        total += updates.length
        changed = true
      }
      if (changed) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    process.stdout.write(total === 0
      ? `already pinned to ${target.version}\n`
      : `pinned ${String(total)} package(s) to ${target.version}; run \`pnpm install\` to refresh the lockfile\n`)
  } else if (flag === undefined) {
    const pinProblems = await collectPinProblems(target)
    const bundle = JSON.parse(await readFile(BUNDLE_MANIFEST, 'utf8'))
    const peerVerdicts = checkPeers(bundle.peerDependencies ?? {}, target.version)
    process.stdout.write(formatReport(target, pinProblems, peerVerdicts))
    const peersWrong = peerVerdicts.some(verdict => !verdict.accepted || !verdict.single)
    process.exit(pinProblems.length > 0 || peersWrong ? 1 : 0)
  } else {
    process.stderr.write(`unknown flag: ${flag}\n`)
    process.stderr.write('usage: node tools/harness-target.mjs [--revision | --version | --pin | --published]\n')
    process.exit(2)
  }
}

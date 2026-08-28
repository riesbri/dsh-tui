/**
 * Find the newest official `dsh-v*` GitHub Release on
 * `deepseek-ai/deepseek-harness`, compare it with the version currently
 * installable from npm, and say whether it is the same source revision as
 * `master` — so `.github/workflows/ci.yml` never builds the identical
 * Harness tree twice for the Edge probe and this comparison.
 *
 * DeepSeek publishes a Release on GitHub before a line necessarily reaches
 * the registry — `dsh-v0.1.2-alpha.1` shipped as a Release while `next` still
 * pointed at `0.1.1-rc.2` — so the Released lane's registry-only view can
 * under-report how far upstream has actually moved. This module answers three
 * narrow questions: which Release is newest, is it ahead of what we can
 * install today, and does validating it require an independent build at all
 * or can it borrow Edge's verdict because the two are the same commit.
 *
 * A Release, not a bare tag: a repository can carry tags that were never
 * published as a Release (a CI dry run, an abandoned line), and those are not
 * "DeepSeek officially released this" the way a Release is. The GitHub
 * Releases API is queried, filtered to non-draft entries, keeping
 * prereleases — `dsh-v0.1.2-alpha.1` is one.
 *
 * The comparison discipline (`compareVersions`/`parseVersion`) is the same one
 * `tools/check-peer-currency.mjs` already uses for peer ranges, reused rather
 * than duplicated.
 * @module tools/latest-harness-release
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareVersions, parseVersion } from './check-peer-currency.mjs'

const REPO = 'deepseek-ai/deepseek-harness'
const TAG_PREFIX = 'dsh-v'
const GITHUB_API = 'https://api.github.com'
const MASTER_BRANCH = 'master'

/**
 * Extract the semantic version from a release tag name, when it is one.
 * @param tagName - a tag name, e.g. `dsh-v0.1.2-alpha.1`.
 * @returns the version, or undefined when the tag is not a `dsh-v*` release
 *   tag or its suffix does not parse as a version.
 */
export function parseHarnessTag(tagName) {
  if (!tagName.startsWith(TAG_PREFIX)) return undefined
  const version = tagName.slice(TAG_PREFIX.length)
  try {
    parseVersion(version)
    return version
  } catch {
    return undefined
  }
}

/**
 * The newest published `dsh-v*` Release among a list of GitHub Release objects.
 * @param releases - objects shaped like the GitHub Releases API response
 *   (`tag_name`, `draft`); prereleases are kept deliberately, since DeepSeek
 *   ships alpha/rc lines this way.
 * @returns the tag and its version, or undefined when none matched.
 */
export function latestHarnessRelease(releases) {
  let best
  for (const release of releases) {
    if (release.draft) continue
    const version = parseHarnessTag(release.tag_name)
    if (version === undefined) continue
    if (best === undefined || compareVersions(parseVersion(version), parseVersion(best.version)) > 0) {
      best = { tag: release.tag_name, version }
    }
  }
  return best
}

/**
 * Where the newest Release sits relative to what npm currently serves.
 * @param latestVersion - the newest Release's version, from {@linkcode latestHarnessRelease}.
 * @param installableVersion - the version currently resolved from the registry's authoritative dist-tag.
 * @returns `ahead`, `behind`, or `same`.
 */
export function compareToInstallable(latestVersion, installableVersion) {
  const comparison = compareVersions(parseVersion(latestVersion), parseVersion(installableVersion))
  return comparison > 0 ? 'ahead' : comparison < 0 ? 'behind' : 'same'
}

/**
 * Fetch every Release GitHub has for the harness repository.
 *
 * One page of 100 is a deliberate, stated limit: the repository carries a
 * handful of Releases today, so this comfortably sees all of them without
 * paginating. Revisit if the count ever approaches that.
 * @param fetchImpl - injected fetch, for tests.
 * @param token - a GitHub token to raise the anonymous rate limit; optional.
 * @returns the raw Release objects, unfiltered.
 */
export async function fetchReleases(fetchImpl = fetch, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN) {
  return fetchJson(`${GITHUB_API}/repos/${REPO}/releases?per_page=100`, fetchImpl, token, 'releases')
}

/**
 * Resolve a ref (a tag name or a branch name) to the exact commit SHA GitHub
 * currently has it pointing at — no checkout required, which is what lets
 * this comparison stay cheap enough to run on every trigger.
 * @param ref - a tag or branch name, e.g. `dsh-v0.1.2-alpha.1` or `master`.
 * @param fetchImpl - injected fetch, for tests.
 * @param token - a GitHub token to raise the anonymous rate limit; optional.
 * @returns the commit SHA that ref currently resolves to.
 */
export async function resolveCommitSha(ref, fetchImpl = fetch, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN) {
  const commit = await fetchJson(`${GITHUB_API}/repos/${REPO}/commits/${encodeURIComponent(ref)}`, fetchImpl, token, `commit ${ref}`)
  return commit.sha
}

/**
 * GET one GitHub API endpoint as JSON, with a bearer token when available.
 * @param url - the full request URL.
 * @param fetchImpl - injected fetch.
 * @param token - a GitHub token; omitted when absent.
 * @param label - what to call this request in an error.
 * @returns the parsed JSON body.
 */
async function fetchJson(url, fetchImpl, token, label) {
  const headers = { Accept: 'application/vnd.github+json' }
  if (token !== undefined && token !== '') headers.Authorization = `Bearer ${token}`
  const response = await fetchImpl(url, { headers })
  if (!response.ok) throw new Error(`GitHub API returned ${String(response.status)} for ${label}`)
  return response.json()
}

// Entry point: vitest imports the pure functions above, so the side-effecting
// CLI runs only when this file is executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}

/** Guarded CLI body, split out only so the module-level guard stays readable. */
async function main() {
  const [installableVersion] = process.argv.slice(2)
  if (installableVersion === undefined) {
    process.stderr.write('usage: node tools/latest-harness-release.mjs <installable-version>\n')
    process.exit(1)
  }
  const releases = await fetchReleases()
  const latest = latestHarnessRelease(releases)
  if (latest === undefined) {
    process.stderr.write(`no published ${TAG_PREFIX}* release found among ${String(releases.length)} releases\n`)
    process.exit(2)
  }
  const comparison = compareToInstallable(latest.version, installableVersion)
  const [releaseSha, masterSha] = await Promise.all([
    resolveCommitSha(latest.tag),
    resolveCommitSha(MASTER_BRANCH),
  ])
  process.stdout.write(
    `tag=${latest.tag}\n`
    + `version=${latest.version}\n`
    + `comparison=${comparison}\n`
    + `sha=${releaseSha}\n`
    + `sameAsMaster=${String(releaseSha === masterSha)}\n`,
  )
}

/**
 * Find the newest immutable `dsh-v*` release tag on
 * `deepseek-ai/deepseek-harness` and compare it with the version currently
 * installable from npm.
 *
 * DeepSeek tags a release on GitHub before it necessarily reaches the
 * registry — `dsh-v0.1.2-alpha.1` existed for a week while `next` still
 * pointed at `0.1.1-rc.2` — so the Released lane's registry-only view can
 * under-report how far upstream has actually moved. This module answers one
 * narrow question — is the newest tag ahead of, level with, or behind what we
 * can install today — so `.github/workflows/ci.yml` can report that fact on
 * every run and reserve the expensive part (checking the tag out and
 * building it) for when it is actually ahead.
 *
 * This is the same comparison discipline `tools/check-peer-currency.mjs`
 * already uses for peer ranges, reused rather than duplicated.
 * @module tools/latest-harness-release
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareVersions, parseVersion } from './check-peer-currency.mjs'

const REPO = 'deepseek-ai/deepseek-harness'
const TAG_PREFIX = 'dsh-v'
const GITHUB_API = 'https://api.github.com'

/**
 * Extract the semantic version from a release tag name, when it is one.
 * @param tagName - a tag from the repository, e.g. `dsh-v0.1.2-alpha.1`.
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
 * The newest `dsh-v*` release among a list of tag names.
 * @param tagNames - every tag name the repository returned.
 * @returns the tag and its version, or undefined when none matched.
 */
export function latestHarnessRelease(tagNames) {
  let best
  for (const tagName of tagNames) {
    const version = parseHarnessTag(tagName)
    if (version === undefined) continue
    if (best === undefined || compareVersions(parseVersion(version), parseVersion(best.version)) > 0) {
      best = { tag: tagName, version }
    }
  }
  return best
}

/**
 * Where the newest tagged release sits relative to what npm currently serves.
 * @param latestVersion - the newest tag's version, from {@linkcode latestHarnessRelease}.
 * @param installableVersion - the version currently resolved from the registry's authoritative dist-tag.
 * @returns `ahead`, `behind`, or `same`.
 */
export function compareToInstallable(latestVersion, installableVersion) {
  const comparison = compareVersions(parseVersion(latestVersion), parseVersion(installableVersion))
  return comparison > 0 ? 'ahead' : comparison < 0 ? 'behind' : 'same'
}

/**
 * Fetch every tag name GitHub returns for the harness repository.
 *
 * One page of 100 is a deliberate, stated limit: the repository carries a
 * handful of `dsh-v*` tags today, so this comfortably sees all of them
 * without paginating. Revisit if the tag count ever approaches that.
 * @param fetchImpl - injected fetch, for tests.
 * @param token - a GitHub token to raise the anonymous rate limit; optional.
 * @returns every tag name in the response, unfiltered.
 */
export async function fetchTagNames(fetchImpl = fetch, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN) {
  const headers = { Accept: 'application/vnd.github+json' }
  if (token !== undefined && token !== '') headers.Authorization = `Bearer ${token}`
  const response = await fetchImpl(`${GITHUB_API}/repos/${REPO}/tags?per_page=100`, { headers })
  if (!response.ok) throw new Error(`GitHub API returned ${String(response.status)} for ${REPO} tags`)
  const tags = await response.json()
  return tags.map(tag => tag.name)
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
  const tagNames = await fetchTagNames()
  const latest = latestHarnessRelease(tagNames)
  if (latest === undefined) {
    process.stderr.write(`no ${TAG_PREFIX}* tag found among ${String(tagNames.length)} tags\n`)
    process.exit(2)
  }
  const comparison = compareToInstallable(latest.version, installableVersion)
  process.stdout.write(`tag=${latest.tag}\nversion=${latest.version}\ncomparison=${comparison}\n`)
}

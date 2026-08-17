/**
 * Confirm the registry actually serves what the release tag claimed.
 *
 * A publish is not atomic across a workspace: the renderer goes out before the
 * bundle that depends on it, so a failure in between leaves one package published
 * and the other not — and a published version cannot be replaced. Checking
 * afterwards turns that into a red release rather than a discovery made later by
 * someone whose install half-resolves.
 *
 * It also catches the case the concurrency group cannot: GitHub keeps at most one
 * PENDING run per group, so pushing a third tag while a release is running
 * discards the middle one's run. That run never executes, so nothing inside it can
 * report — but the next release runs this check, and a version that was never
 * published is then visible as a gap between the tags and the registry.
 * @module tools/verify-published
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Workspace packages that get published, in dependency order. */
const PACKAGES = ['packages/renderer', 'packages/tui']

/**
 * Whether the registry serves an exact version of a package.
 * @param name - the package name.
 * @param version - the exact version.
 * @returns whether the registry answered with that version.
 */
function published(name, version) {
  try {
    const answer = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return answer.trim() === version
  } catch {
    // `npm view` exits non-zero for a version that does not exist, which is the
    // answer rather than a failure to get one.
    return false
  }
}

const missing = []
for (const directory of PACKAGES) {
  const { name, version } = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'))
  if (published(name, version)) {
    process.stdout.write(`verify-published: ${name}@${version} is on the registry\n`)
    continue
  }
  missing.push(`${name}@${version}`)
}

if (missing.length > 0) {
  process.stderr.write(
    `verify-published: the registry does not serve ${missing.join(', ')}.\n`
    + 'The release did not fully land. Publish the missing package before tagging another version:\n'
    + 'a half-published workspace leaves an install resolving one package and not the other.\n',
  )
  process.exit(1)
}

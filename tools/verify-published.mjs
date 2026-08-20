/**
 * Confirm the registry actually serves what the release tag claimed.
 *
 * A publish is not atomic across a workspace: the renderer goes out before the
 * bundle that depends on it, so a failure in between leaves one package published
 * and the other not — and a published version cannot be replaced. Checking
 * afterwards turns that into a red release rather than a discovery made later by
 * someone whose install half-resolves.
 *
 * This checks only the version in the current release tree. It cannot detect a
 * different tagged version whose pending workflow GitHub discarded before it ran;
 * version.yml prevents the automated handoff from creating that second tag while
 * a publisher is active instead.
 * @module tools/verify-published
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Workspace packages that get published, in dependency order. */
export const PACKAGE_DIRECTORIES = ['packages/renderer', 'packages/tui']

/**
 * npm's read API can trail a successful publish briefly. One minute distinguishes
 * ordinary propagation from a real half-release without making recovery opaque.
 */
const VERIFY_ATTEMPTS = 12

/** Five seconds avoids hammering npm while keeping a normal release prompt. */
const VERIFY_DELAY_MS = 5_000

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

/**
 * Pause between registry reads.
 * @param milliseconds - delay before the next attempt.
 * @returns a promise settled after the delay.
 */
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * Wait for every exact package version to become visible on npm.
 *
 * Versions already observed are not queried again. This both shortens retries and
 * makes the log say exactly when each half of the workspace became visible.
 * @param packages - package names and exact versions expected from this release.
 * @param options - injectable registry reader, delay and logger for tests.
 * @param options.isPublished - exact-version registry reader.
 * @param options.sleep - delay between attempts.
 * @param options.write - successful-observation logger.
 * @param options.attempts - maximum registry reads per package.
 * @returns exact `name@version` strings still missing after all attempts.
 */
export async function waitForPublished(packages, {
  isPublished = published,
  sleep = delay,
  write = text => process.stdout.write(text),
  attempts = VERIFY_ATTEMPTS,
} = {}) {
  let pending = [...packages]
  const limit = Math.max(1, attempts)
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const missing = []
    for (const item of pending) {
      if (isPublished(item.name, item.version)) {
        write(`verify-published: ${item.name}@${item.version} is on the registry\n`)
      } else {
        missing.push(item)
      }
    }
    pending = missing
    if (pending.length === 0) break
    if (attempt < limit) await sleep(VERIFY_DELAY_MS)
  }
  return pending.map(item => `${item.name}@${item.version}`)
}

/** Read the release tree's package identities once before polling npm. */
const packages = PACKAGE_DIRECTORIES.map(directory => {
  const { name, version } = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'))
  return { name, version }
})

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const missing = await waitForPublished(packages)
  if (missing.length > 0) {
    process.stderr.write(
      `verify-published: the registry does not serve ${missing.join(', ')}.\n`
      + 'The release did not fully land. Correct the missing package trusted-publisher mapping, then rerun\n'
      + 'this same tagged workflow; do not create another tag until both exact versions verify.\n',
    )
    process.exit(1)
  }
}

/**
 * Pin every `@deepseek-ai/dsh-*` devDependency, in both manifests, to one
 * exact FLOOR version — the Minimum Harness compatibility lane's fixed
 * target, which is deliberately NOT the dynamically resolved authoritative
 * published line `tools/sync-harness.mjs` tracks. That tool answers "what is
 * current"; this one answers "what is the oldest line we still promise",
 * which changes only when a human moves the promise, never with every
 * publish.
 *
 * Cordis versions on its own independent numbering (`4.0.1`, not the `dsh-*`
 * line's `0.1.1-rc.2`) and is left untouched — `tools/check-peer-currency.mjs`
 * already tracks that distinction for the same reason.
 *
 * Usage:
 *   node tools/pin-harness-floor.mjs 0.1.1-rc.2
 *
 * Intended to run only inside the disposable Minimum-lane CI runner, exactly
 * like `sync-harness.mjs`'s own rewrite in the released job: nothing this
 * writes is meant to be committed.
 * @module tools/pin-harness-floor
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFESTS = [join(repoRoot, 'packages', 'dshline', 'package.json'), join(repoRoot, 'package.json')]

/** Matches the `dsh-*` line this floor applies to; excludes cordis deliberately. */
const HARNESS_LINE_SCOPE = /^@deepseek-ai\/dsh-/

/**
 * Compute the devDependency changes one manifest needs to pin every `dsh-*`
 * entry to the floor version.
 * @param devDependencies - the manifest's current devDependencies map.
 * @param floorVersion - the exact version to pin every matching entry to.
 * @returns the sorted list of changes; empty when the manifest is already at the floor.
 */
export function floorUpdates(devDependencies, floorVersion) {
  const updates = []
  for (const [name, current] of Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))) {
    if (!HARNESS_LINE_SCOPE.test(name) || current === floorVersion) continue
    updates.push({ name, from: current, to: floorVersion })
  }
  return updates
}

// Entry point: vitest imports the pure function above, so the side-effecting
// CLI runs only when this file is executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [floorVersion] = process.argv.slice(2)
  if (floorVersion === undefined) {
    process.stderr.write('usage: node tools/pin-harness-floor.mjs <exact-version>\n')
    process.exit(1)
  }
  let total = 0
  for (const manifestPath of MANIFESTS) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const updates = floorUpdates(manifest.devDependencies ?? {}, floorVersion)
    if (updates.length === 0) continue
    for (const update of updates) manifest.devDependencies[update.name] = update.to
    manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).sort(([a], [b]) => a.localeCompare(b)))
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    for (const update of updates) process.stdout.write(`${manifestPath}: ${update.name} ${update.from ?? '(absent)'} -> ${update.to}\n`)
    total += updates.length
  }
  process.stdout.write(total === 0
    ? `every dsh-* devDependency is already pinned to the floor ${floorVersion}\n`
    : `pinned ${String(total)} package(s) to the floor ${floorVersion}; run \`pnpm install\` to refresh the lockfile\n`)
}

/**
 * Pin every `@deepseek-ai/dsh-*` dependency — direct or dev, in both
 * manifests — to one exact FLOOR version: the Minimum Harness compatibility
 * lane's fixed target, which is deliberately NOT the dynamically resolved
 * authoritative published line `tools/sync-harness.mjs` tracks. That tool
 * answers "what is current"; this one answers "what is the oldest line we
 * still promise", which changes only when a human moves the promise, never
 * with every publish.
 *
 * Both `dependencies` and `devDependencies` are pinned, not only the latter.
 * `@deepseek-ai/dsh-atomic-write` is a direct runtime dependency of the
 * bundle, ranged the same way a devDependency used to be; left unpinned, a
 * disposable `pnpm install --no-frozen-lockfile` could resolve it to whatever
 * else its range's upper bound currently allows on the registry, while every
 * other package in the graph sits at the exact floor — a mixed graph the
 * Minimum job would still report as a clean `Minimum · <floor>` pass.
 *
 * Cordis, and any other `@deepseek-ai/*` package outside the `dsh-*` line
 * (such as `schemastery`), version on their own independent numbering and are
 * left untouched — `tools/check-peer-currency.mjs` defines that same scope
 * for the same reason.
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

import { HARNESS_LINE_SCOPE } from './check-peer-currency.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFESTS = [join(repoRoot, 'packages', 'dshline', 'package.json'), join(repoRoot, 'package.json')]

/** Manifest fields this tool pins. `peerDependencies` is the public compatibility contract and is never touched. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies']

/**
 * Compute the changes one dependency map needs to pin every `dsh-*` entry to
 * the floor version.
 * @param dependencies - the manifest's current dependency map (`dependencies` or `devDependencies`).
 * @param floorVersion - the exact version to pin every matching entry to.
 * @returns the sorted list of changes; empty when the map is already at the floor.
 */
export function floorUpdates(dependencies, floorVersion) {
  const updates = []
  for (const [name, current] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
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
    let manifestChanged = false
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field]
      if (dependencies === undefined) continue
      const updates = floorUpdates(dependencies, floorVersion)
      if (updates.length === 0) continue
      for (const update of updates) dependencies[update.name] = update.to
      manifest[field] = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
      for (const update of updates) {
        process.stdout.write(`${manifestPath} (${field}): ${update.name} ${update.from ?? '(absent)'} -> ${update.to}\n`)
      }
      total += updates.length
      manifestChanged = true
    }
    if (manifestChanged) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  process.stdout.write(total === 0
    ? `every dsh-* dependency (direct or dev) is already pinned to the floor ${floorVersion}\n`
    : `pinned ${String(total)} package(s) to the floor ${floorVersion}; run \`pnpm install\` to refresh the lockfile\n`)
}

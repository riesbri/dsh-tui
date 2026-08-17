/**
 * Point the bundle's typecheck dependencies at a harness checkout.
 *
 * `pnpm typecheck` resolves the harness's real service types, and those cannot
 * come from the registry: a published harness package depends on
 * `@deepseek-ai/dsh-type-meta`, which is not published. The bundle therefore
 * links them from a checkout, and the default paths assume it sits beside this
 * repository. This rewrites them for any other layout.
 *
 * Usage:
 *   node tools/link-harness.mjs ../deepseek-harness
 *   node tools/link-harness.mjs ~/src/deepseek-harness
 *   node tools/link-harness.mjs --check
 */

import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(repoRoot, 'packages', 'tui', 'package.json')
const bundleDir = dirname(manifestPath)

/** Where each linked package lives inside a harness checkout. */
const HARNESS_PATHS = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-agent-default-model': 'packages/core/agent-default-model',
  '@deepseek-ai/dsh-cmdline': 'packages/boot/cmdline',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-tool-ask-user': 'packages/interaction/tool-ask-user',
  '@deepseek-ai/dsh-user-approval': 'packages/interaction/user-approval',
  '@deepseek-ai/dsh-user-questions': 'packages/interaction/user-questions',
}

const [argument] = process.argv.slice(2)
if (argument === undefined || argument === '--help') {
  process.stdout.write('usage: node tools/link-harness.mjs <path-to-deepseek-harness> | --check\n')
  process.exit(argument === undefined ? 1 : 0)
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

if (argument === '--check') {
  const unlinked = []
  const unresolved = []
  const roots = new Set()
  for (const [name, subpath] of Object.entries(HARNESS_PATHS)) {
    const spec = manifest.devDependencies?.[name]
    if (typeof spec !== 'string' || !spec.startsWith('link:')) {
      unlinked.push(name)
      continue
    }
    // A link: spec is relative to the package that declares it.
    const target = resolve(bundleDir, spec.slice('link:'.length))
    roots.add(target.slice(0, target.length - subpath.length - 1))
    try {
      await access(join(target, 'package.json'))
    } catch {
      unresolved.push(subpath)
    }
  }
  if (unlinked.length === 0 && unresolved.length === 0) {
    process.stdout.write('harness links resolve; `pnpm typecheck` will work\n')
    process.exit(0)
  }
  // Every entry normally shares one root, so report that once rather than
  // repeating the same directory ten times.
  for (const root of roots) process.stdout.write(`harness expected at ${root}\n`)
  if (unresolved.length > 0) {
    process.stdout.write(`  ${String(unresolved.length)} of ${String(Object.keys(HARNESS_PATHS).length)} packages missing there, starting with ${unresolved[0]}\n`)
  }
  for (const name of unlinked) process.stdout.write(`  ${name} is not linked at all\n`)
  process.stdout.write('\nfix with: node tools/link-harness.mjs <path-to-deepseek-harness>\n')
  process.exit(1)
}

const expanded = argument.startsWith('~/') ? join(homedir(), argument.slice(2)) : argument
const harnessRoot = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)

try {
  await access(join(harnessRoot, 'vendor', 'cordis', 'package.json'))
} catch {
  process.stderr.write(`not a harness checkout: ${harnessRoot}\n`)
  process.stderr.write('expected to find vendor/cordis/package.json there\n')
  process.exit(1)
}

// Relative where possible so the manifest stays portable and carries no home
// directory; absolute only when the checkout is on another volume or branch of
// the tree, where a relative path would be worse than useless.
const asRelative = relative(bundleDir, harnessRoot)
const base = asRelative !== '' && !asRelative.startsWith('..' + '/'.repeat(0) + '..') ? asRelative : harnessRoot
const prefix = base.startsWith('.') || isAbsolute(base) ? base : `./${base}`

for (const [name, subpath] of Object.entries(HARNESS_PATHS)) {
  manifest.devDependencies[name] = `link:${prefix}/${subpath}`
}
manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).sort(([a], [b]) => a.localeCompare(b)))
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

process.stdout.write(`linked ${String(Object.keys(HARNESS_PATHS).length)} packages from ${harnessRoot}\n`)
process.stdout.write('run `pnpm install` then `pnpm typecheck`\n')

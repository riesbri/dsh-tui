/**
 * Point the bundle's typecheck dependencies at a harness CHECKOUT instead of the
 * registry.
 *
 * Not needed for ordinary work: the manifests pin every harness devDependency
 * to the exact currently published version (tools/sync-harness.mjs keeps them
 * there), so a clone typechecks against real registry types with nothing else
 * installed. This is for developing against unreleased harness changes — a
 * local branch, or a fix not yet published — where the registry is behind.
 *
 * `--restore` puts the registry tags back; run tools/sync-harness.mjs
 * afterwards to re-pin the exact published versions.
 *
 * Usage:
 *   node tools/link-harness.mjs ../deepseek-harness
 *   node tools/link-harness.mjs ~/src/deepseek-harness
 *   node tools/link-harness.mjs --check
 *   node tools/link-harness.mjs --restore
 */

import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The authoritative dist-tag per package lives with the tool that checks peer
// ranges against it, so "current" can only have one definition.
import { authoritativeTag } from './check-peer-currency.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(repoRoot, 'packages', 'dshline', 'package.json')
const bundleDir = dirname(manifestPath)

/** Where each linked package lives inside a harness checkout. */
const HARNESS_PATHS = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-agent-default-model': 'packages/core/agent-default-model',
  '@deepseek-ai/dsh-cmdline': 'packages/boot/cmdline',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-jobs': 'packages/jobs/jobs',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-subagent': 'packages/subagent/subagent',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-session-projection': 'packages/session/session-projection',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-tool-ask-user': 'packages/interaction/tool-ask-user',
  '@deepseek-ai/dsh-tool-todo': 'packages/todo/tool-todo',
  '@deepseek-ai/dsh-user-approval': 'packages/interaction/user-approval',
  '@deepseek-ai/dsh-user-questions': 'packages/interaction/user-questions',
}

const [argument] = process.argv.slice(2)
if (argument === undefined || argument === '--help') {
  process.stdout.write('usage: node tools/link-harness.mjs <path-to-deepseek-harness> | --check | --restore\n')
  process.exit(argument === undefined ? 1 : 0)
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

if (argument === '--restore') {
  for (const name of Object.keys(HARNESS_PATHS)) manifest.devDependencies[name] = authoritativeTag(name)
  manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).sort(([a], [b]) => a.localeCompare(b)))
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`restored ${String(Object.keys(HARNESS_PATHS).length)} packages to their registry dist-tags\n`)
  // Committed manifests pin exact published versions (tools/sync-harness.mjs);
  // dist-tags here are the offline-friendly intermediate, so point the way back.
  process.stdout.write('run `node tools/sync-harness.mjs` to re-pin the exact published versions, then `pnpm install`\n')
  process.exit(0)
}

/**
 * The declaration file a linked package must have emitted.
 *
 * A present `package.json` proves only that the directory is there. Typechecking
 * reads declarations, and the harness emits those into `lib/types` during its own
 * build — so an unbuilt checkout has every manifest and no types, which is
 * exactly the state that made the old success message a lie.
 * @param target - the resolved package directory.
 * @returns the declaration path the package advertises, or undefined when it
 *   advertises none.
 */
async function declarationOf(target) {
  let manifestText
  try {
    manifestText = await readFile(join(target, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  const packaged = JSON.parse(manifestText)
  const declared = packaged.types ?? packaged.exports?.['.']?.types
  return typeof declared === 'string' ? join(target, declared) : undefined
}

if (argument === '--check') {
  const unlinked = []
  const missing = []
  const unbuilt = []
  const roots = new Set()
  for (const [name, subpath] of Object.entries(HARNESS_PATHS)) {
    const spec = manifest.devDependencies?.[name]
    if (typeof spec !== 'string' || !spec.startsWith('link:')) {
      unlinked.push(name)
      continue
    }
    void spec
    // A link: spec is relative to the package that declares it.
    const target = resolve(bundleDir, spec.slice('link:'.length))
    roots.add(target.slice(0, target.length - subpath.length - 1))
    const declaration = await declarationOf(target)
    if (declaration === undefined) {
      missing.push(subpath)
      continue
    }
    try {
      await access(declaration)
    } catch {
      unbuilt.push(subpath)
    }
  }
  if (unlinked.length === Object.keys(HARNESS_PATHS).length) {
    process.stdout.write('not linked to a checkout: types come from the pinned registry versions, which is the normal setup\n')
    process.exit(0)
  }
  if (unlinked.length === 0 && missing.length === 0 && unbuilt.length === 0) {
    process.stdout.write('harness links resolve and its declarations are built; `pnpm typecheck` will work\n')
    process.exit(0)
  }
  // Every entry normally shares one root, so report that once rather than
  // repeating the same directory ten times.
  for (const root of roots) process.stdout.write(`harness expected at ${root}\n`)
  const total = String(Object.keys(HARNESS_PATHS).length)
  if (missing.length > 0) {
    process.stdout.write(`  ${String(missing.length)} of ${total} packages are not there, starting with ${missing[0]}\n`)
    process.stdout.write('  fix with: node tools/link-harness.mjs <path-to-deepseek-harness>\n')
  }
  if (unbuilt.length > 0) {
    process.stdout.write(`  ${String(unbuilt.length)} of ${total} packages are present but unbuilt, starting with ${unbuilt[0]}\n`)
    process.stdout.write('  fix by building the harness: pnpm install && pnpm run build, in that checkout\n')
  }
  for (const name of unlinked) process.stdout.write(`  ${name} is not linked at all\n`)
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

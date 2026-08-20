/**
 * Synchronize the runner banner's embedded version with its package manifest.
 *
 * Changesets owns package.json and changelog updates, but the startup banner
 * embeds the same value in source. Keeping the replacement here rather than in
 * a workflow shell fragment gives the generated version PR one auditable owner
 * for the duplicated fact that the release gate checks.
 * @module tools/sync-version
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'packages', 'tui', 'package.json')
const sourcePath = join(root, 'packages', 'tui', 'src', 'index.ts')
const VERSION = /^const VERSION = '(?<version>[^']+)'$/mu

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (typeof manifest.version !== 'string' || manifest.version === '') {
  throw new Error(`${manifestPath} has no package version`)
}

const source = await readFile(sourcePath, 'utf8')
const match = VERSION.exec(source)
if (match?.groups?.version === undefined) {
  throw new Error(`no VERSION constant found in ${sourcePath}`)
}

if (match.groups.version !== manifest.version) {
  const updated = source.replace(VERSION, `const VERSION = '${manifest.version}'`)
  await writeFile(sourcePath, updated)
  process.stdout.write(`sync-version: banner ${match.groups.version} -> ${manifest.version}\n`)
} else {
  process.stdout.write(`sync-version: banner already matches ${manifest.version}\n`)
}

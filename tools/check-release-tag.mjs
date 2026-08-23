/**
 * Refuse a release whose tag disagrees with what would be published.
 *
 * A tag is a human gesture and the version in a manifest is a separate one, so
 * they drift: pushing `v0.1.1` from a tree still carrying `0.1.0` would publish
 * 0.1.0 under a tag that claims otherwise, and a published version cannot be
 * replaced. Provenance makes this worse rather than better — the attestation
 * would faithfully bind the wrong version to a real commit.
 *
 * Reads the tag from the environment rather than from an interpolated command, so
 * a tag name can never become shell.
 * @module tools/check-release-tag
 */

import { readFileSync } from 'node:fs'

/** Workspace packages that get published, in dependency order. */
const PACKAGES = ['packages/renderer', 'packages/dshline']

/**
 * A version the SOURCE embeds rather than reads from its manifest.
 *
 * The runner prints this in its opening banner, so a release that bumped both
 * manifests and missed it would publish a correctly tagged package that identifies
 * itself as an older one. Checked here because it is a second home for the same
 * fact, and this is the gate that makes the duplication safe.
 */
const EMBEDDED = {
  path: 'packages/dshline/src/index.ts',
  pattern: /^const VERSION = '(?<version>[^']+)'$/mu,
}

const tag = process.env.RELEASE_TAG ?? ''
const expected = tag.replace(/^v/u, '')
if (expected === '') {
  process.stderr.write('check-release-tag: RELEASE_TAG is empty; expected something like v0.1.0\n')
  process.exit(2)
}

const mismatched = []
for (const directory of PACKAGES) {
  const manifest = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'))
  if (manifest.version !== expected) mismatched.push(`${manifest.name} is ${manifest.version}`)
}

const embedded = EMBEDDED.pattern.exec(readFileSync(EMBEDDED.path, 'utf8'))
if (embedded?.groups?.version === undefined) {
  process.stderr.write(`check-release-tag: no VERSION constant found in ${EMBEDDED.path}\n`)
  process.exit(2)
}
if (embedded.groups.version !== expected) {
  mismatched.push(`the banner in ${EMBEDDED.path} says ${embedded.groups.version}`)
}

if (mismatched.length > 0) {
  process.stderr.write(
    `check-release-tag: tag ${tag} expects version ${expected}, but ${mismatched.join(', ')}.\n`
    + 'Bump the manifests and re-tag; a published version cannot be taken back.\n',
  )
  process.exit(1)
}

process.stdout.write(`check-release-tag: ${tag} matches ${expected} in ${String(PACKAGES.length)} packages\n`)

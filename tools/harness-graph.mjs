/**
 * Discover a Harness checkout's workspace package graph and compute the
 * closure of `@deepseek-ai/*` packages a set of seeds actually requires.
 *
 * link-harness.mjs source-links a checkout by pointing a handful of direct
 * Harness packages at it; this module is what makes that link coherent. A
 * linked package's own manifest still carries its literal `workspace:^`
 * dependency/peerDependency specifiers — raw source has not been through
 * Harness's publish step, which is what rewrites those into real registry
 * ranges. Left alone, pnpm chases every such edge to the registry looking for
 * a version the registry may not carry yet. The fix is to give pnpm a source
 * for every package reachable from the seeds, not just the ones dshline names
 * directly, computed from the checkout itself so a new internal Harness
 * dependency can't silently reintroduce the gap.
 * @module tools/harness-graph
 */

import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const HARNESS_SCOPE = '@deepseek-ai/'

/**
 * The workspace package glob patterns declared in a Harness checkout's
 * `pnpm-workspace.yaml`. Hand-rolled against the one shape that file uses in
 * practice — a top-level `packages:` list of plain or quoted strings, with
 * trailing `#` comments allowed — rather than pulling in a YAML parser for
 * one field.
 * @param yamlText - the file's contents.
 * @returns the listed patterns, in file order.
 */
export function parseWorkspacePackagePatterns(yamlText) {
  const patterns = []
  let inList = false
  for (const rawLine of yamlText.split('\n')) {
    if (!inList) {
      if (/^packages:\s*$/.test(rawLine)) inList = true
      continue
    }
    const item = /^ {2}-\s*(.+?)\s*$/.exec(rawLine)
    if (item === null) break
    let value = item[1]
    const comment = value.indexOf(' #')
    if (comment !== -1) value = value.slice(0, comment).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value !== '') patterns.push(value)
  }
  return patterns
}

/**
 * Expand one workspace glob pattern — segments that are either a literal
 * path component or a bare `*` — against a real directory tree.
 * @param root - the checkout root the pattern is relative to.
 * @param pattern - the pattern, e.g. `packages/*\/*`.
 * @returns the matching directories; a segment that does not exist on disk
 *   simply drops that branch rather than throwing.
 */
async function expandPattern(root, pattern) {
  let candidates = [root]
  for (const segment of pattern.split('/')) {
    const next = []
    for (const dir of candidates) {
      if (segment === '*') {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) if (entry.isDirectory()) next.push(join(dir, entry.name))
      } else {
        next.push(join(dir, segment))
      }
    }
    candidates = next
  }
  return candidates
}

/**
 * One discovered Harness workspace package.
 * @typedef {object} HarnessPackage
 * @property {string} dir - its directory, absolute.
 * @property {Record<string,string>} dependencies - its manifest's dependencies.
 * @property {Record<string,string>} peerDependencies - its manifest's peerDependencies.
 */

/**
 * Every `@deepseek-ai/*` package a Harness checkout's own workspace declares,
 * keyed by package name. Reads `pnpm-workspace.yaml` to find where to look,
 * exactly as pnpm itself would, so a workspace layout change there is a
 * change here too rather than a second place to keep in sync.
 * @param checkoutRoot - the Harness checkout's root directory.
 * @returns the discovered packages.
 */
export async function discoverHarnessPackages(checkoutRoot) {
  const workspaceYaml = await readFile(join(checkoutRoot, 'pnpm-workspace.yaml'), 'utf8')
  const patterns = parseWorkspacePackagePatterns(workspaceYaml)
  const packages = new Map()
  for (const pattern of patterns) {
    for (const dir of await expandPattern(checkoutRoot, pattern)) {
      let manifest
      try {
        manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith(HARNESS_SCOPE)) continue
      packages.set(manifest.name, {
        dir,
        dependencies: manifest.dependencies ?? {},
        peerDependencies: manifest.peerDependencies ?? {},
      })
    }
  }
  return packages
}

/**
 * The full set of Harness packages a group of seeds requires, transitively,
 * through their dependencies and peerDependencies. devDependencies are
 * deliberately excluded: those are what a package needs to build itself, not
 * what a consumer needs in order to resolve it.
 * @param seedNames - the directly required package names; names the
 *   workspace does not contain are ignored rather than treated as an error,
 *   since a seed may legitimately be a non-Harness or registry-only package.
 * @param packages - the discovered workspace, from {@linkcode discoverHarnessPackages}.
 * @returns the closure, including every seed that was actually found.
 */
export function requiredClosure(seedNames, packages) {
  const closure = new Set()
  const queue = seedNames.filter(name => packages.has(name))
  while (queue.length > 0) {
    const name = queue.pop()
    if (closure.has(name)) continue
    closure.add(name)
    const { dependencies, peerDependencies } = packages.get(name)
    for (const dep of [...Object.keys(dependencies), ...Object.keys(peerDependencies)]) {
      if (packages.has(dep) && !closure.has(dep)) queue.push(dep)
    }
  }
  return closure
}

/**
 * Every `@deepseek-ai/*` name appearing as a dependency, peerDependency, or
 * devDependency in any of the given manifests. This is deliberately name-only
 * scanning — it says nothing about whether the checkout actually contains
 * that package, which {@linkcode requiredClosure} decides.
 * @param manifests - parsed `package.json` documents to scan.
 * @returns the distinct names, in first-seen order.
 */
export function harnessScopedNames(manifests) {
  const names = new Set()
  for (const manifest of manifests) {
    for (const section of [manifest.dependencies, manifest.peerDependencies, manifest.devDependencies]) {
      for (const name of Object.keys(section ?? {})) {
        if (name.startsWith(HARNESS_SCOPE)) names.add(name)
      }
    }
  }
  return [...names]
}

/**
 * Where a workspace's `pnpm.overrides` live. pnpm 11 stopped reading
 * `overrides` from `package.json`'s `pnpm` field — see
 * https://pnpm.io/settings — and moved it into `pnpm-workspace.yaml`, the
 * same file Harness's own workspace uses for exactly this. This module edits
 * that top-level `overrides:` mapping as a self-contained block, leaving
 * every other line — comments included — untouched, since hand-rolling a
 * full YAML writer for one file this repository does not otherwise need
 * would cost more than it returns.
 */

const OVERRIDE_LINE = /^ {2}(['"])(.+?)\1:\s*(['"])(.+?)\3\s*$/

/**
 * The index just past a top-level `packages:` list, i.e. where a new
 * top-level block can be inserted immediately after it.
 * @param lines - the file, split on `\n`.
 * @returns that index, or -1 if the file has no `packages:` list.
 */
function findPackagesListEnd(lines) {
  const start = lines.findIndex(line => /^packages:\s*$/.test(line))
  if (start === -1) return -1
  let index = start + 1
  while (index < lines.length && /^ {2}- /.test(lines[index])) index += 1
  return index
}

/**
 * Read the current `pnpm.overrides` mapping from a workspace manifest.
 * @param yamlText - the `pnpm-workspace.yaml` contents.
 * @returns the entries, in file order; empty when there is no `overrides:` key.
 */
export function readWorkspaceOverrides(yamlText) {
  const lines = yamlText.split('\n')
  const overrides = new Map()
  const start = lines.findIndex(line => /^overrides:\s*$/.test(line))
  if (start === -1) return overrides
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = OVERRIDE_LINE.exec(lines[index])
    if (match === null) break
    overrides.set(match[2], match[4])
  }
  return overrides
}

/**
 * Replace the `overrides:` block with the given entries, preserving every
 * other line verbatim. An empty map removes the block entirely; a file with
 * no existing block gets a new one inserted right after the `packages:` list.
 * @param yamlText - the `pnpm-workspace.yaml` contents.
 * @param overrides - the complete desired mapping.
 * @returns the rewritten file contents.
 */
export function writeWorkspaceOverrides(yamlText, overrides) {
  const lines = yamlText.split('\n')
  let blockStart = -1
  let blockEnd = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^overrides:\s*$/.test(lines[index])) {
      blockStart = index > 0 && lines[index - 1] === '' ? index - 1 : index
      let cursor = index + 1
      while (cursor < lines.length && OVERRIDE_LINE.test(lines[cursor])) cursor += 1
      blockEnd = cursor
      break
    }
  }
  const entries = [...overrides].sort(([a], [b]) => a.localeCompare(b))
  const blockLines = entries.length === 0 ? [] : ['', 'overrides:', ...entries.map(([name, spec]) => `  '${name}': '${spec}'`)]
  if (blockStart !== -1) {
    lines.splice(blockStart, blockEnd - blockStart, ...blockLines)
  } else if (blockLines.length > 0) {
    const insertAt = findPackagesListEnd(lines)
    lines.splice(insertAt === -1 ? lines.length : insertAt, 0, ...blockLines)
  }
  return lines.join('\n')
}

/**
 * Walk upward from a directory to find the Harness checkout it belongs to,
 * identified by the workspace manifest at its root.
 * @param startDir - any directory inside a checkout.
 * @returns the checkout root, or undefined if none of its ancestors carry a
 *   `pnpm-workspace.yaml`.
 */
export async function findWorkspaceRoot(startDir) {
  let dir = startDir
  for (;;) {
    try {
      await access(join(dir, 'pnpm-workspace.yaml'))
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  }
}

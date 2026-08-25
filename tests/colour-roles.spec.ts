/**
 * The rule that keeps a palette able to do its job.
 *
 * Colour is chosen by ROLE at every call site. A single `style(text, 'red')`
 * added back would be invisible in review and would then be immune to every
 * theme — it names an appearance, so no palette can reach it. This spec is
 * cheaper than noticing that later, and it names the file that broke it.
 *
 * `style` itself stays exported: it is published API, it is the primitive
 * `paint` is built on, and the width and markdown specs use it as a fixture.
 * What it may not have is call sites.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Repository root, resolved from this file rather than the working directory. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The two source trees a palette has to be able to reach. */
const TREES = ['packages/renderer/src', 'packages/dshline/src']

/**
 * Where the primitive is allowed to appear: its own definition, and prose
 * about it. Paths are repository-relative and compared exactly.
 */
const ALLOWED = new Set([
  'packages/renderer/src/text.ts',
  'packages/renderer/src/theme.ts',
])

/**
 * Every TypeScript file under `dir`, recursively.
 * @param dir - absolute directory to walk.
 * @returns absolute paths, in directory order.
 */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (extname(entry.name) === '.ts') out.push(full)
  }
  return out
}

describe('colour is chosen by role', () => {
  it('has no style() call site outside the primitive itself', () => {
    // Matched on the call, not the identifier, so `pressureStyle(` and the word
    // "style" in a comment are not false positives. A line that is entirely a
    // comment is skipped, because `theme.ts` and others describe the primitive.
    const offenders: string[] = []
    for (const tree of TREES) {
      for (const file of sources(join(ROOT, tree))) {
        const path = relative(ROOT, file).replaceAll('\\', '/')
        if (ALLOWED.has(path)) continue
        readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
          if (/^\s*(\/\/|\*|\/\*)/u.test(line)) return
          if (!/(^|[^A-Za-z0-9_$])style\(/u.test(line)) return
          offenders.push(`${path}:${String(index + 1)}  ${line.trim()}`)
        })
      }
    }
    expect(offenders).toStrictEqual([])
  })

  it('leaves the primitive exported, because it is published API', async () => {
    const renderer = await import('../packages/renderer/src/index.ts')
    expect(typeof renderer.style).toBe('function')
    expect(typeof renderer.paint).toBe('function')
  })
})

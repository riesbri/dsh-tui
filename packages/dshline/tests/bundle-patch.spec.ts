/**
 * `cordis.patch.yml`: the agent plane moves behind agent presets exactly
 * once, never twice.
 *
 * This is dshline's own shipped composition, not a fixture — a regression
 * here means a fresh install gets it wrong. The check is structural, not a
 * live Cordis mount (nothing in this repo boots a real Loader tree in a
 * unit test): every row `dsh-base` mounts unconditionally that a Harness
 * preset also lists must be disabled here, `agent-presets` must be
 * inserted with a real default, and no id may be both disabled and
 * (re-)inserted by this same file — that would be dshline arguing with
 * itself about whether one row exists.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/**
 * Loader's own `!!js <expr>` tag, resolved here as the bare source string —
 * enough to evaluate it under a controlled `baseUrl`, without reimplementing
 * Loader's own `with (ctx) { eval(expr) }` scope for anything this file does
 * not need. Registering it also silences `yaml`'s "unresolved tag" warning,
 * which the tag being genuinely unresolved (not a parse bug) would otherwise
 * print on every parse of this file from now on.
 */
const JS_EXPR_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source }

/** One insert/disable/patch entry, as the Loader's patch-list dialect shapes it. */
interface PatchEntry {
  readonly id?: string
  readonly disabled?: boolean
  readonly insert?: readonly { readonly id: string; readonly name: string; readonly disabled?: unknown; readonly config?: unknown }[]
}

/**
 * Every row id `dsh-base` mounts unconditionally that a shipped Harness
 * preset (`standard`/`code`/`minimal`/`cordis`) also lists — copied
 * verbatim from `packages/bundle/web-app/cordis.patch.yml` in
 * deepseek-harness, the reference implementation of this exact move.
 */
const EXPECTED_DISABLED = [
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
]

/** Rows this file explicitly keeps host-plane (never disabled), and why. */
const DELIBERATELY_NOT_DISABLED = [
  // A process singleton with a cross-session query surface; a preset row
  // registers a continuable setup on it rather than a tool the agent calls.
  'tool-subagent-report',
]

function loadPatch(): readonly PatchEntry[] {
  const parsed: unknown = parse(readFileSync(PATCH_PATH, 'utf8'), { customTags: [JS_EXPR_TAG] })
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml must be a top-level list')
  return parsed as readonly PatchEntry[]
}

function disabledIds(patch: readonly PatchEntry[]): string[] {
  return patch.filter(entry => entry.disabled === true && entry.id !== undefined).map(entry => entry.id as string)
}

function insertedIds(patch: readonly PatchEntry[]): string[] {
  return patch.flatMap(entry => entry.insert?.map(row => row.id) ?? [])
}

describe('cordis.patch.yml: the agent plane moves behind agent presets', () => {
  it('disables exactly the rows a shipped preset also composes, no more and no fewer', () => {
    const patch = loadPatch()
    expect(disabledIds(patch).sort()).toEqual([...EXPECTED_DISABLED].sort())
  })

  it('never disables the rows this file deliberately keeps host-plane', () => {
    const patch = loadPatch()
    const disabled = new Set(disabledIds(patch))
    for (const id of DELIBERATELY_NOT_DISABLED) expect(disabled.has(id)).toBe(false)
  })

  it('inserts the preset roster with a real default', () => {
    const patch = loadPatch()
    const agentPresets = patch
      .flatMap(entry => entry.insert ?? [])
      .find(row => row.id === 'agent-presets')
    expect(agentPresets?.name).toBe('@deepseek-ai/dsh-agent-presets')
    expect((agentPresets?.config as { default?: unknown } | undefined)?.default).toBe('standard')
  })

  it('never both disables and (re-)inserts the same row id', () => {
    // A row this file disables and ALSO inserts under the same id would be
    // this file contradicting itself about whether that row exists at all.
    const patch = loadPatch()
    const disabled = new Set(disabledIds(patch))
    const inserted = insertedIds(patch)
    const overlap = inserted.filter(id => disabled.has(id))
    expect(overlap).toEqual([])
  })

  it('no longer inserts its own tool-ask-user row (each preset owns that choice now)', () => {
    // Whether an agent gets ask_user is the PRESET's decision — standard
    // mounts it, minimal (a deliberately two-tool preset) does not — and a
    // copy here would force it back on regardless of what a preset says.
    const patch = loadPatch()
    expect(insertedIds(patch)).not.toContain('tool-ask-user')
  })

  it('still inserts the frontend\'s own two rows', () => {
    const patch = loadPatch()
    expect(insertedIds(patch)).toEqual(expect.arrayContaining(['dshline-startup', 'dshline']))
  })
})

/**
 * The `standard` preset's `tool-subagent` row opts into
 * `modelSelectionSettings: true`, which — only on the line that publishes
 * it — needs `@deepseek-ai/dsh-tool-subagent/model-selection-settings`
 * mounted Host-plane; the line this frontend still floors on does not
 * publish that subpath at all, so the row that provides it here must gate
 * on Loader's own `disabled`, evaluated (and its import skipped entirely)
 * before Loader ever tries to resolve the name — never on a package version.
 */
describe('cordis.patch.yml: the model-selection-settings row gates on capability, not version', () => {
  const TMP_DIRS: string[] = []

  afterEach(async () => {
    while (TMP_DIRS.length > 0) {
      const dir = TMP_DIRS.pop()
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    }
  })

  function findRow(patch: readonly PatchEntry[]): { readonly id: string; readonly name: string; readonly disabled?: unknown } {
    const row = patch.flatMap(entry => entry.insert ?? []).find(candidate => candidate.id === 'subagent-model-selection-settings')
    if (row === undefined) throw new Error('subagent-model-selection-settings row not found')
    return row
  }

  it('inserts the row under the exact Host-plane subpath the standard preset needs', () => {
    const row = findRow(loadPatch())
    expect(row.name).toBe('@deepseek-ai/dsh-tool-subagent/model-selection-settings')
  })

  it('gates disabled on a capability probe, not a version literal', () => {
    const row = findRow(loadPatch())
    expect(typeof row.disabled).toBe('string')
    const expr = row.disabled as string
    // The whole point: nothing here may name the line this repository
    // tracks. A literal `0.1.2`/`alpha`/`rc.2` here would be exactly the
    // version-string branching this gate exists to avoid.
    expect(expr).not.toMatch(/0\.1\.[12]|alpha|rc\.\d/i)
    expect(expr).toContain('createRequire')
    expect(expr).toContain('@deepseek-ai/dsh-tool-subagent/model-selection-settings')
  })

  /**
   * Evaluate the row's real, unmodified `disabled` expression against a
   * constructed `baseUrl`, exactly the way Loader's own
   * `with (ctx) { eval(expr) }` supplies it — `process` reaches the
   * expression as a true Node global either way, and `baseUrl` is bound
   * here as an explicit parameter standing in for what `with` injects,
   * since a `with` statement is not legal in this file's own strict-mode
   * module scope.
   * @param baseUrl - the directory the probe should resolve the subpath from.
   * @returns the row's disabled expression, evaluated against `baseUrl`.
   */
  function evaluateDisabled(baseUrl: string): boolean {
    const row = findRow(loadPatch())
    const expr = row.disabled as string
    // eslint-disable-next-line no-new-func -- reproducing Loader's own evaluation, not arbitrary eval.
    return new Function('baseUrl', `return (${expr})`)(baseUrl) as boolean
  }

  /**
   * Build a throwaway `node_modules/@deepseek-ai/dsh-tool-subagent` whose
   * `exports` map either does or does not declare `./model-selection-settings`
   * — a real package.json Node's own resolver reads, not a mocked import.
   * @param withSubpath - whether the built package declares the subpath.
   * @returns a `file://` base directory a `createRequire` probe resolves from.
   */
  async function buildFixture(withSubpath: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dshline-capability-probe-'))
    TMP_DIRS.push(root)
    const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent')
    await mkdir(pkgDir, { recursive: true })
    const exportsMap: Record<string, string> = { '.': './index.js' }
    if (withSubpath) exportsMap['./model-selection-settings'] = './model-selection-settings.js'
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-tool-subagent',
      version: '0.0.0-fixture',
      exports: exportsMap,
    }))
    await writeFile(join(pkgDir, 'index.js'), 'export default {}\n')
    if (withSubpath) await writeFile(join(pkgDir, 'model-selection-settings.js'), 'export default {}\n')
    return pathToFileURL(join(root, 'dshline', '')).href
  }

  it('stays disabled when the installed graph has no model-selection-settings subpath — the line this frontend floors on today', async () => {
    const baseUrl = await buildFixture(false)
    expect(evaluateDisabled(baseUrl)).toBe(true)
  })

  it('enables once the installed graph actually resolves the subpath — the shape the alpha line publishes', async () => {
    const baseUrl = await buildFixture(true)
    expect(evaluateDisabled(baseUrl)).toBe(false)
  })
})

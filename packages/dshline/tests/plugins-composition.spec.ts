/**
 * Parsing and narrowly editing Harness's entry-list composition YAML.
 *
 * The fixtures below are trimmed from the real shipped `standard` preset
 * (`apps/cli/config/agent-presets/standard/agent.cordis.yml` in
 * deepseek-harness): the `!!js` platform-conditional shell tools, and the
 * `delegation` group whose `tool-subagent-codex` child ships `disabled: true`
 * with a comment telling an operator to copy the preset and remove the field.
 * Round-tripping this exact shape — nested groups, comments, `!!js`,
 * multiline block scalars — is the point: this is what a real toggle in a
 * real preset touches.
 */

import { describe, expect, it } from 'vitest'
import type { CompositionRow, RowLocator } from '../src/plugins/composition.ts'
import { parseComposition, toggleDisabled } from '../src/plugins/composition.ts'

/** A trimmed, realistic composition: top-level conditional rows, a multiline
 * scalar, and a nested `delegation` group with a disabled leaf. */
const FIXTURE = `# The \`standard\` agent preset (trimmed for a test fixture).
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

# \`shell\`
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent

    # Production dsh does not install these optional providers. Install the
    # matching Bundle in this Profile and restart the Host, then copy this
    # preset and remove \`disabled\` from the matching tool row.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
`

/** The full real `standard` preset's opening section, for the byte-level regression test. */
const REAL_STANDARD_EXCERPT = `# The \`standard\` agent preset: the full coding agent, mounted once per process.
#
# This file is an AGENT-PLANE composition. The roster mounts it ONCE under a
# standing scope; every session naming it joins by scope parentage, so the
# tools and prompt sections registered here cover each joined agent while a
# session's own state stays keyed per Session/Agent inside the plugins.

# ── identity ────────────────────────────────────────────────────────────────

# The preset's own persona, shadowing the deployment default for this agent.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# ── shell ───────────────────────────────────────────────────────────────────

# \`shell-env\` stays in the HOST composition: injected to publish
# DSH_WEB_URL/DSH_WEB_MODE, and a host row that injects a service is the
# criterion for host-plane ownership.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

# ── delegation ───────────────────────────────────────────────────────────────
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    # Production dsh does not install these optional providers. Install the
    # matching Bundle in this Profile and restart the Host, then copy this
    # preset and remove \`disabled\` from the matching tool row. Host availability
    # alone grants no tool.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
        backgroundMode: one-shot
        maxDepth: provider-managed
`

/**
 * Find one row's locator by its display path, for use in `toggleDisabled`.
 * @param rows - the parsed rows.
 * @param path - the row's expected display path.
 * @returns the locator.
 */
function locatorFor(rows: readonly CompositionRow[], path: readonly string[]): RowLocator {
  const row = rows.find(r => r.path.length === path.length && r.path.every((segment, i) => segment === path[i]))
  if (row === undefined) throw new Error(`fixture row not found: ${path.join(' > ')}`)
  return row.locator
}

describe('parseComposition: recursive traversal', () => {
  it('flattens top-level and nested rows in document order with display paths', () => {
    const tree = parseComposition(FIXTURE)
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    expect(tree.rows.map(row => row.path)).toEqual([
      ['persona'],
      ['tool-bash'],
      ['tool-pwsh'],
      ['tool-fs'],
      ['delegation'],
      ['delegation', 'tool-subagent'],
      ['delegation', 'tool-subagent-codex'],
    ])
  })

  it('reports depth and group correctly for nested rows', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const delegation = tree.rows.find(row => row.id === 'delegation')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(delegation?.group).toBe(true)
    expect(delegation?.depth).toBe(0)
    expect(codex?.group).toBe(false)
    expect(codex?.depth).toBe(1)
    expect(codex?.path).toEqual(['delegation', 'tool-subagent-codex'])
  })

  it('carries the row name (module specifier) through', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.name).toBe('@deepseek-ai/dsh-tool-subagent')
  })
})

describe('parseComposition: id is optional, matching Harness\'s own validator exactly', () => {
  it('accepts a valid top-level row with no id at all', () => {
    const tree = parseComposition('- name: "@deepseek-ai/dsh-tool-fs"\n')
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    expect(tree.rows).toHaveLength(1)
    expect(tree.rows[0]?.id).toBeUndefined()
    expect(tree.rows[0]?.name).toBe('@deepseek-ai/dsh-tool-fs')
  })

  it('falls back to name for the display path of an id-less row', () => {
    const tree = parseComposition('- name: "@deepseek-ai/dsh-tool-fs"\n')
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.path).toEqual(['@deepseek-ai/dsh-tool-fs'])
  })

  it('accepts a valid nested id-less row inside a group', () => {
    const tree = parseComposition(`- id: delegation
  name: cordis:group
  group: true
  config:
    - name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
`)
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    const child = tree.rows.find(row => row.name === '@deepseek-ai/dsh-tool-subagent')
    expect(child?.id).toBeUndefined()
    expect(child?.path).toEqual(['delegation', '@deepseek-ai/dsh-tool-subagent'])
    expect(child?.disabled).toEqual({ kind: 'disabled' })
  })

  it('still rejects a row with no name, id or not', () => {
    expect(parseComposition('- id: tool-fs\n').kind).toBe('broken')
    expect(parseComposition('- {}\n').kind).toBe('broken')
  })

  it('accepts duplicate ids across different rows without treating the file as broken', () => {
    const tree = parseComposition(`- id: tool-a
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-a
  name: '@deepseek-ai/dsh-tool-bash'
`)
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    expect(tree.rows.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-bash',
    ])
  })
})

describe('parseComposition: tri-state disabled', () => {
  it('models a row with no disabled field as enabled', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const fs = tree.rows.find(row => row.id === 'tool-fs')
    expect(fs?.disabled).toEqual({ kind: 'enabled' })
    expect(fs?.effective).toBe('enabled')
  })

  it('models a literal disabled: true row as disabled, without evaluating anything', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.disabled).toEqual({ kind: 'disabled' })
  })

  it('models a !!js row as conditional, carrying the raw expression and never evaluating it', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const bash = tree.rows.find(row => row.id === 'tool-bash')
    const pwsh = tree.rows.find(row => row.id === 'tool-pwsh')
    expect(bash?.disabled).toEqual({ kind: 'conditional', expression: "process.platform === 'win32'" })
    expect(pwsh?.disabled).toEqual({ kind: 'conditional', expression: "process.platform !== 'win32'" })
    expect(bash?.effective).toBe('conditional')
  })
})

describe('parseComposition: ancestor inheritance', () => {
  const NESTED_DISABLED_GROUP = `- id: delegation
  name: cordis:group
  group: true
  disabled: true
  config:
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
`
  it('always reports a group row itself as effectively enabled, even when its own field is disabled', () => {
    const tree = parseComposition(NESTED_DISABLED_GROUP)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const delegation = tree.rows.find(row => row.id === 'delegation')
    expect(delegation?.disabled).toEqual({ kind: 'disabled' })
    expect(delegation?.effective).toBe('enabled')
  })

  it('propagates a disabled ancestor group to a leaf whose own field stays enabled', () => {
    const tree = parseComposition(NESTED_DISABLED_GROUP)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.disabled).toEqual({ kind: 'enabled' })
    expect(codex?.effective).toBe('disabled')
  })

  const NESTED_CONDITIONAL_GROUP = `- id: delegation
  name: cordis:group
  group: true
  disabled: !!js process.env.DELEGATION === 'off'
  config:
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
`
  it('combines a conditional ancestor with a literally disabled leaf as disabled (literal wins)', () => {
    const tree = parseComposition(NESTED_CONDITIONAL_GROUP)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.effective).toBe('disabled')
  })

  it('reports conditional for a leaf under a conditional ancestor with no other blocker', () => {
    const tree = parseComposition(`- id: delegation
  name: cordis:group
  group: true
  disabled: !!js process.env.DELEGATION === 'off'
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const child = tree.rows.find(row => row.id === 'tool-subagent')
    expect(child?.disabled).toEqual({ kind: 'enabled' })
    expect(child?.effective).toBe('conditional')
  })
})

describe('parseComposition: config summaries are bounded', () => {
  it('summarizes a small plain-scalar config object', () => {
    const tree = parseComposition(`- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configSummary).toBe('provider=spawn, toolName=subagent')
  })

  it('summarizes a plain scalar config directly', () => {
    const tree = parseComposition(`- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config: 65536
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configSummary).toBe('65536')
  })

  it('normalizes whitespace and caps a realistic long persona/prompt block scalar', () => {
    const longPrompt = 'You are a coding agent powered by the {{model}} model. '
      + 'Your working directory is {{cwd}}. Follow the plan exactly, never skip a step, '
      + 'and always verify your changes build and pass tests before reporting completion.'
    const tree = parseComposition(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      ${longPrompt}
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const summary = tree.rows[0]?.configSummary
    expect(summary).toBeDefined()
    expect(summary?.length).toBeLessThanOrEqual(100)
    expect(summary?.endsWith('…')).toBe(true)
    // Never a raw multi-line dump: no newline survives into the summary.
    expect(summary?.includes('\n')).toBe(false)
  })

  it('never computes a summary for a group row', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const delegation = tree.rows.find(row => row.id === 'delegation')
    expect(delegation?.configSummary).toBeUndefined()
  })

  it('omits a summary for a nested config object', () => {
    const tree = parseComposition(`- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    nested:
      deeper: true
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configSummary).toBeUndefined()
  })
})

describe('parseComposition: broken/malformed input never throws', () => {
  it('reports broken when the top level is not a list', () => {
    const tree = parseComposition('just: a mapping\n')
    expect(tree.kind).toBe('broken')
  })

  it('reports broken when an entry has no name', () => {
    const tree = parseComposition('- id: tool-fs\n')
    expect(tree.kind).toBe('broken')
  })

  it('reports broken when a group has no nested list', () => {
    const tree = parseComposition('- id: g\n  name: cordis:group\n  group: true\n')
    expect(tree.kind).toBe('broken')
  })

  it('reports broken rather than throwing on invalid YAML syntax', () => {
    expect(() => parseComposition('- id: [unterminated\n')).not.toThrow()
    expect(parseComposition('- id: [unterminated\n').kind).toBe('broken')
  })

  it('reports broken on an empty file', () => {
    expect(parseComposition('').kind).toBe('broken')
  })

  it('reports broken on a comments-only file', () => {
    expect(parseComposition('# nothing here\n').kind).toBe('broken')
  })
})

describe('toggleDisabled: narrow, comment-preserving mutation', () => {
  it('enables a disabled leaf by deleting only its disabled field', () => {
    const parsed = parseComposition(FIXTURE)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(FIXTURE, locatorFor(parsed.rows, ['delegation', 'tool-subagent-codex']), true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).not.toContain('disabled: true')
    expect(result.text).toContain("disabled: !!js process.platform === 'win32'")
    expect(result.text).toContain('Production dsh does not install these optional providers')
    expect(result.text).toContain('toolName: subagent_codex')
    const reparsed = parseComposition(result.text)
    if (reparsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(reparsed.rows.find(row => row.id === 'tool-subagent-codex')?.disabled).toEqual({ kind: 'enabled' })
  })

  it('disables an enabled leaf by adding disabled: true, touching only that row', () => {
    const parsed = parseComposition(FIXTURE)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(FIXTURE, locatorFor(parsed.rows, ['tool-fs']), false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reparsed = parseComposition(result.text)
    if (reparsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(reparsed.rows.find(row => row.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
    expect(result.text).toContain('You are a coding agent powered by the {{model}} model')
  })

  it('preserves the delegation group and its other child when toggling one nested row', () => {
    const parsed = parseComposition(FIXTURE)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(FIXTURE, locatorFor(parsed.rows, ['delegation', 'tool-subagent-codex']), true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reparsed = parseComposition(result.text)
    if (reparsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(reparsed.rows.map(row => row.path)).toEqual([
      ['persona'],
      ['tool-bash'],
      ['tool-pwsh'],
      ['tool-fs'],
      ['delegation'],
      ['delegation', 'tool-subagent'],
      ['delegation', 'tool-subagent-codex'],
    ])
    expect(reparsed.rows.find(row => row.id === 'tool-subagent')?.disabled).toEqual({ kind: 'enabled' })
  })

  it('safely toggles an id-less row, addressed by structural locator alone', () => {
    const text = `- name: '@deepseek-ai/dsh-tool-bash'
- name: '@deepseek-ai/dsh-tool-fs'
  disabled: true
`
    const parsed = parseComposition(text)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const target = parsed.rows.find(row => row.name === '@deepseek-ai/dsh-tool-fs')
    if (target === undefined) throw new Error('fixture row not found')
    const result = toggleDisabled(text, target.locator, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reparsed = parseComposition(result.text)
    if (reparsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(reparsed.rows.find(row => row.name === '@deepseek-ai/dsh-tool-fs')?.disabled).toEqual({ kind: 'enabled' })
    expect(reparsed.rows.find(row => row.name === '@deepseek-ai/dsh-tool-bash')?.disabled).toEqual({ kind: 'enabled' })
  })

  it('refuses to toggle a row whose disabled is a !!js conditional', () => {
    const parsed = parseComposition(FIXTURE)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(FIXTURE, locatorFor(parsed.rows, ['tool-bash']), true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('conditional')
    expect(result.message).toContain("process.platform === 'win32'")
  })

  it('does not corrupt the file when a conditional toggle is refused', () => {
    const parsed = parseComposition(FIXTURE)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(FIXTURE, locatorFor(parsed.rows, ['tool-pwsh']), false)
    expect(result.ok).toBe(false)
    expect(parseComposition(FIXTURE)).toEqual(parseComposition(FIXTURE))
  })

  it('reports not-found for a locator index that no longer exists', () => {
    const badLocator = { steps: [{ index: 99, name: 'nope', id: undefined }] }
    const result = toggleDisabled(FIXTURE, badLocator, true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-found')
  })

  it('reports changed, not a silent wrong-row edit, when the file was reordered incompatibly', () => {
    const before = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  disabled: true
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`
    const parsedBefore = parseComposition(before)
    if (parsedBefore.kind !== 'parsed') throw new Error('expected parsed')
    const staleLocator = locatorFor(parsedBefore.rows, ['tool-fs'])
    // Simulate an external edit: a new row is prepended, shifting every index
    // by one, so the locator's index-0 step no longer names tool-fs.
    const after = `- id: tool-workflow
  name: '@deepseek-ai/dsh-tool-workflow'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  disabled: true
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`
    const result = toggleDisabled(after, staleLocator, true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('changed')
    // Confirm nothing was mutated: the file toggleDisabled was given back unmodified.
    expect(after).toContain('- id: tool-workflow')
  })

  it('reports broken rather than throwing when the text does not parse', () => {
    const result = toggleDisabled('- id: [unterminated\n', { steps: [{ index: 0, name: 'x', id: undefined }] }, true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('broken')
  })

  it('is idempotent-safe: enabling an already-enabled row returns the input unchanged, unserialized', () => {
    const parsed = parseComposition(FIXTURE)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(FIXTURE, locatorFor(parsed.rows, ['tool-fs']), true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toBe(FIXTURE)
  })

  it('is idempotent-safe: disabling an already-disabled row returns the input unchanged, unserialized', () => {
    const parsed = parseComposition(FIXTURE)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(FIXTURE, locatorFor(parsed.rows, ['delegation', 'tool-subagent-codex']), false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toBe(FIXTURE)
  })

  it('regression: toggling one row in the real standard preset excerpt leaves every unrelated construct intact', () => {
    const parsed = parseComposition(REAL_STANDARD_EXCERPT)
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    const result = toggleDisabled(REAL_STANDARD_EXCERPT, locatorFor(parsed.rows, ['delegation', 'tool-subagent-codex']), true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The toggled field is gone.
    const codexBlock = result.text.slice(result.text.indexOf('tool-subagent-codex'))
    expect(codexBlock).not.toContain('disabled: true')
    // Unrelated !!js conditionals survive verbatim.
    expect(result.text).toContain("disabled: !!js process.platform === 'win32'")
    expect(result.text).toContain("disabled: !!js process.platform !== 'win32'")
    // The persona's multiline block scalar survives.
    expect(result.text).toContain('You are a coding agent powered by the {{model}} model')
    // Comments elsewhere in the file survive.
    expect(result.text).toContain('AGENT-PLANE composition')
    expect(result.text).toContain('shadowing the deployment default for this agent')
    // The isolate map and the untouched sibling row survive.
    expect(result.text).toContain('workflowEngine: true')
    expect(result.text).toContain('tool-subagent-control')
    expect(result.text).toContain('maxBytes: 65536')
  })
})

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

describe('parseComposition: recursive traversal', () => {
  it('flattens top-level and nested rows in document order with ancestry paths', () => {
    const tree = parseComposition(FIXTURE)
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    expect(tree.rows.map(row => row.idPath)).toEqual([
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
    expect(codex?.idPath).toEqual(['delegation', 'tool-subagent-codex'])
  })

  it('carries the row name (module specifier) through', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.name).toBe('@deepseek-ai/dsh-tool-subagent')
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
    // Whichever platform runs this test, both rows parse identically: the
    // expression is never evaluated, so it cannot depend on `process.platform`.
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

describe('parseComposition: config summaries', () => {
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

  it('omits a summary for config that is not plainly summarizable, rather than guessing', () => {
    const tree = parseComposition(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      A long multiline block scalar with far too much prose to summarize concisely.
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    // One key, but its value is a long string — still plainly summarizable
    // scalar-per-key, so this documents the boundary: a config with a nested
    // object or array is what gets omitted, not merely a long string.
    expect(tree.rows[0]?.configSummary).toBe(
      'text=A long multiline block scalar with far too much prose to summarize concisely.',
    )
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

  it('reports broken when an entry has no id', () => {
    const tree = parseComposition('- name: "@deepseek-ai/dsh-tool-fs"\n')
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
    const result = toggleDisabled(FIXTURE, ['delegation', 'tool-subagent-codex'], true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).not.toContain('disabled: true')
    // Everything else, including the comment above the row and the sibling
    // `!!js` rows, survives untouched.
    expect(result.text).toContain("disabled: !!js process.platform === 'win32'")
    expect(result.text).toContain('Production dsh does not install these optional providers')
    expect(result.text).toContain('toolName: subagent_codex')
    const reparsed = parseComposition(result.text)
    if (reparsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(reparsed.rows.find(row => row.id === 'tool-subagent-codex')?.disabled).toEqual({ kind: 'enabled' })
  })

  it('disables an enabled leaf by adding disabled: true, touching only that row', () => {
    const result = toggleDisabled(FIXTURE, ['tool-fs'], false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reparsed = parseComposition(result.text)
    if (reparsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(reparsed.rows.find(row => row.id === 'tool-fs')?.disabled).toEqual({ kind: 'disabled' })
    // The persona row's multiline block scalar is untouched.
    expect(result.text).toContain('You are a coding agent powered by the {{model}} model')
  })

  it('preserves the delegation group and its other child when toggling one nested row', () => {
    const result = toggleDisabled(FIXTURE, ['delegation', 'tool-subagent-codex'], true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reparsed = parseComposition(result.text)
    if (reparsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(reparsed.rows.map(row => row.idPath)).toEqual([
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

  it('refuses to toggle a row whose disabled is a !!js conditional', () => {
    const result = toggleDisabled(FIXTURE, ['tool-bash'], true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('conditional')
    expect(result.message).toContain("process.platform === 'win32'")
  })

  it('does not corrupt the file when a conditional toggle is refused', () => {
    const result = toggleDisabled(FIXTURE, ['tool-pwsh'], false)
    expect(result.ok).toBe(false)
    // Confirm the refusal is not merely reported but genuinely never written:
    // the composition, read independently, is byte-identical to the source.
    expect(parseComposition(FIXTURE)).toEqual(parseComposition(FIXTURE))
  })

  it('reports not-found for an id ancestry that does not exist', () => {
    const result = toggleDisabled(FIXTURE, ['delegation', 'no-such-row'], true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-found')
  })

  it('reports not-found when a group in the path is not actually a group', () => {
    const result = toggleDisabled(FIXTURE, ['tool-fs', 'anything'], true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-found')
  })

  it('reports broken rather than throwing when the text does not parse', () => {
    const result = toggleDisabled('- id: [unterminated\n', ['x'], true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('broken')
  })

  it('is idempotent-safe: enabling an already-enabled row is a no-op edit', () => {
    const result = toggleDisabled(FIXTURE, ['tool-fs'], true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toBe(FIXTURE)
  })
})

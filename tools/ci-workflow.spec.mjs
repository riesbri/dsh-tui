/**
 * Guards the `harness-released` lane's release-age policy: it must apply
 * consistently to every pnpm invocation in that job — the main path and the
 * scheduled tagged-release sub-path alike — and to no other job.
 *
 * `pnpm install --config.minimum-release-age=0` only scopes to that one
 * process. `pnpm run <script>` / `pnpm exec` (used by `pnpm run
 * build`/`typecheck`/`test` and by tools/capability-report.mjs) each shell
 * out to their own internal dependency-status check — a fresh pnpm process a
 * one-shot CLI flag on an earlier step never reaches. `PNPM_CONFIG_MINIMUM_RELEASE_AGE`,
 * written to `$GITHUB_ENV` right after checkout, is inherited by every child
 * process started afterwards in the job, nested checks included — this test
 * verifies that variable is exported before every literal pnpm
 * install/run/exec in the job, that the CLI-flag fallback hasn't crept back
 * in, and that the bypass stays scoped to this one disposable lane.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const ENV_EXPORT = 'PNPM_CONFIG_MINIMUM_RELEASE_AGE=0'
const PNPM_INVOCATION = /\bpnpm\s+(install|run|exec)\b/g

/**
 * Extract one top-level job's YAML block by name, with `#`-comment lines
 * stripped so prose that merely mentions a flag or command does not read as
 * the workflow actually using it.
 * @param workflow - the full workflow file text.
 * @param jobName - the job key under `jobs:`.
 * @returns the block's code (no comments), from its `<jobName>:` line up to (not including) the next job at the same indentation.
 */
function extractJob(workflow, jobName) {
  const match = workflow.match(new RegExp(`\\n  ${jobName}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`))
  if (match === null) throw new Error(`job not found in workflow: ${jobName}`)
  return match[1].split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
}

describe('harness-released minimumReleaseAge consistency (.github/workflows/ci.yml)', () => {
  it('exports PNPM_CONFIG_MINIMUM_RELEASE_AGE before any other pnpm invocation in the job', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const released = extractJob(workflow, 'harness-released')

    const envIndex = released.indexOf(ENV_EXPORT)
    expect(envIndex, 'expected a step exporting PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 to $GITHUB_ENV').toBeGreaterThan(-1)
    expect(released, 'the value must reach $GITHUB_ENV, not just the step\'s own process').toMatch(/PNPM_CONFIG_MINIMUM_RELEASE_AGE=0"?\s*>>\s*"?\$GITHUB_ENV/)

    // Every literal `pnpm install` / `pnpm run` / `pnpm exec` in the job —
    // the main path and the scheduled tagged-release sub-path alike — rather
    // than a hand-picked list, so a step added later is covered automatically.
    const invocations = [...released.matchAll(PNPM_INVOCATION)]
    expect(invocations.length, 'expected to find pnpm install/run/exec invocations in the job').toBeGreaterThan(5)
    for (const match of invocations) {
      expect(envIndex, `PNPM_CONFIG_MINIMUM_RELEASE_AGE must be exported before: ${match[0]} (at index ${String(match.index)})`).toBeLessThan(match.index)
    }

    // A per-step CLI flag doesn't reach a script's own nested pnpm
    // invocation, so it must not creep back in as an alternative to the
    // env var.
    expect(released).not.toContain('--config.minimum-release-age=0')
  })

  it('stays scoped to the disposable Released lane — no other job bypasses the brake', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    for (const jobName of ['core', 'windows-launcher', 'harness-minimum', 'harness-edge', 'harness-sync']) {
      const job = extractJob(workflow, jobName)
      expect([...job.matchAll(PNPM_INVOCATION)].length, `${jobName} should still run pnpm, just without the bypass`).toBeGreaterThan(0)
      expect(job, `${jobName} must not set PNPM_CONFIG_MINIMUM_RELEASE_AGE`).not.toContain('PNPM_CONFIG_MINIMUM_RELEASE_AGE')
      expect(job, `${jobName} must not carry the per-step override flag either`).not.toContain('minimum-release-age=0')
    }
  })
})

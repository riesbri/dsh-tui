/**
 * Guards against the `harness-released` lane's `minimumReleaseAge` override
 * silently regressing to a per-step CLI flag.
 *
 * `pnpm install --config.minimum-release-age=0` only reaches the process it
 * is passed to. Every later `pnpm run <script>` / `pnpm exec` in the same job
 * (build, typecheck, test, tools/capability-report.mjs's `pnpm exec vitest`,
 * and the tagged-release sub-path) shells out to its own internal dependency
 * status check that re-reads `pnpm-workspace.yaml` from disk, not any flag an
 * earlier command was given — a same-day Harness package pinned by
 * tools/sync-harness.mjs then fails those later commands with
 * ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION even though the install that put it
 * in the lockfile explicitly opted in. The fix is a step that patches the
 * checked-out `pnpm-workspace.yaml` itself, before any other pnpm command in
 * the job runs — this test verifies that step exists, runs early enough, and
 * stays scoped to the one disposable lane meant to bypass the brake.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const RELEASE_AGE_PATCH = /sed -i 's\/\^minimumReleaseAge:[^']*'\s+pnpm-workspace\.yaml/

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
  it('patches pnpm-workspace.yaml before any other pnpm invocation in the job', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const released = extractJob(workflow, 'harness-released')

    const patchIndex = released.search(RELEASE_AGE_PATCH)
    expect(patchIndex, 'expected a step patching pnpm-workspace.yaml\'s minimumReleaseAge to 0').toBeGreaterThan(-1)

    for (const laterStep of ['run: node tools/sync-harness.mjs', 'id: install', 'run: pnpm run build', 'run: pnpm run typecheck', 'run: pnpm run test', 'run: node tools/capability-report.mjs released']) {
      const stepIndex = released.indexOf(laterStep)
      expect(stepIndex, `expected to find step: ${laterStep}`).toBeGreaterThan(-1)
      expect(patchIndex, `the minimumReleaseAge patch must run before: ${laterStep}`).toBeLessThan(stepIndex)
    }

    // The per-step CLI flag does not reach a script's own nested pnpm
    // invocation, so it must not be relied on again as an alternative to the
    // file patch.
    expect(released).not.toContain('--config.minimum-release-age=0')
  })

  it('stays scoped to the disposable Released lane — no other job bypasses the brake', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    for (const jobName of ['core', 'harness-minimum', 'harness-edge', 'harness-sync']) {
      const job = extractJob(workflow, jobName)
      expect(job.search(RELEASE_AGE_PATCH), `${jobName} must keep the full 24h release-age brake`).toBe(-1)
      expect(job, `${jobName} must not carry the per-step override flag either`).not.toContain('minimum-release-age=0')
    }
  })
})

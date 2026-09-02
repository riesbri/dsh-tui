/**
 * Guards the properties that make the Harness compatibility policy true
 * rather than merely written down.
 *
 * dshline targets ONE Harness architecture at a time: an exact upstream
 * commit that gates every merge, and a moving upstream branch that gates
 * nothing. Both halves are easy to break by accident — an `if:` widened while
 * debugging turns the informational lane into a merge gate, and a `ref:`
 * changed from a commit to a branch turns the blocking lane into something
 * DeepSeek can fail from a thousand miles away. Neither mistake shows up in
 * review as anything but a one-word diff, so it is checked here.
 */

import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

/** Jobs that must never be reachable from a pull request or a push to main. */
const INFORMATIONAL_JOBS = ['harness-upstream']

/** Jobs whose result is a merge gate. */
const BLOCKING_JOBS = ['core', 'windows-launcher', 'docs', 'harness-target', 'harness-published']

/**
 * Extract one top-level job's YAML block by name, with `#`-comment lines
 * stripped so prose that merely mentions a branch or a flag does not read as
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

/**
 * Read the CI workflow once per assertion, from the repository rather than a fixture.
 * @returns the workflow file text.
 */
async function readWorkflow() {
  return readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
}

describe('the moving upstream lane can never gate a merge (.github/workflows/ci.yml)', () => {
  it.each(INFORMATIONAL_JOBS)('%s runs only on schedule and workflow_dispatch', async (jobName) => {
    const job = extractJob(await readWorkflow(), jobName)
    const condition = job.match(/^\s{4}if:\s*(.+)$/m)
    expect(condition, `${jobName} must carry a job-level if:`).not.toBeNull()
    // Exact, not "mentions schedule": an `if:` that also admits pull_request
    // would make a branch DeepSeek controls a merge gate for unrelated work.
    expect(condition[1].trim()).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'")
  })

  it('is the only lane that checks out a moving ref', async () => {
    const workflow = await readWorkflow()
    for (const jobName of BLOCKING_JOBS) {
      expect(extractJob(workflow, jobName), `${jobName} must not follow a branch of the harness repository`)
        .not.toMatch(/ref:\s*master/)
    }
    expect(extractJob(workflow, 'harness-upstream')).toMatch(/ref:\s*master/)
  })
})

describe('the adopted target lane is deterministic', () => {
  it('takes its revision from HARNESS_TARGET and nothing else', async () => {
    const job = extractJob(await readWorkflow(), 'harness-target')
    expect(job).toContain('node tools/harness-target.mjs --revision')
    expect(job).toMatch(/ref:\s*\$\{\{\s*steps\.target\.outputs\.revision\s*\}\}/)
    // A dist-tag is a pointer someone else moves; resolving one here would
    // make "the revision we adopted" mean whatever upstream published last.
    expect(job).not.toMatch(/\bdist-tag\b|--channel|@(next|alpha|latest)\b/)
  })

  it('blocks on both its typecheck and its capability probes', async () => {
    const job = extractJob(await readWorkflow(), 'harness-target')
    // continue-on-error collects both signals; the verdict step is what must
    // still turn a failure into a red job.
    expect(job).toMatch(/if \[ "\$TYPECHECK_OUTCOME" != "success" \] \|\| \[ "\$CAPABILITY_OUTCOME" != "success" \]/)
    expect(job).toContain('exit 1')
  })
})

describe('the obsolete multi-line compatibility machinery is gone', () => {
  it('carries no Minimum floor, no dist-tag lanes, and no rolling sync automation', async () => {
    const workflow = await readWorkflow()
    for (const gone of [
      'HARNESS_MINIMUM_VERSION',
      'pin-harness-floor',
      'sync-harness',
      'check-peer-currency',
      'latest-harness-release',
      'harness-minimum',
      'harness-released',
      'harness-alpha',
      'harness-edge',
      'automation/harness-sync',
    ]) {
      expect(workflow, `${gone} should have been deleted, not renamed`).not.toContain(gone)
    }
  })

  it('holds no write permissions and no secrets, now that the sync job is gone', async () => {
    const workflow = await readWorkflow()
    // The only job that ever needed a write token was the rolling sync pull
    // request, which turned every upstream publish into an implied
    // compatibility promise. Nothing in this workflow writes any more.
    expect(workflow).not.toMatch(/contents:\s*write/)
    expect(workflow).not.toMatch(/pull-requests:\s*write/)
    expect(workflow).not.toContain('secrets.')
  })

  it('keeps the release-age brake on every job', async () => {
    const workflow = await readWorkflow()
    // The bypass existed so the Released lane could see a brand-new published
    // version the day it shipped. Nothing races a dist-tag any more, so the
    // repository-wide brake in pnpm-workspace.yaml now applies everywhere.
    expect(workflow).not.toContain('PNPM_CONFIG_MINIMUM_RELEASE_AGE')
    expect(workflow).not.toContain('minimum-release-age')
  })
})

describe('security posture', () => {
  it('checks out with persist-credentials: false everywhere', async () => {
    const workflow = await readWorkflow()
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)]
    expect(checkouts.length).toBeGreaterThan(0)
    expect([...workflow.matchAll(/persist-credentials: false/g)]).toHaveLength(checkouts.length)
  })

  it('installs dependencies without running their lifecycle scripts', async () => {
    const workflow = await readWorkflow()
    const installs = [...workflow.matchAll(/pnpm install(?! --lockfile-only)[^\n]*/g)]
    expect(installs.length).toBeGreaterThan(0)
    for (const install of installs) {
      expect(install[0], 'every install must run with --ignore-scripts').toContain('--ignore-scripts')
    }
  })
})

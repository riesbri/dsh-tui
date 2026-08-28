/**
 * Render Harness capability compatibility as a named report:
 *
 *   Harness compatibility · released
 *   ✓ sessionQuery
 *   ✓ jobs
 *   ✗ subagents
 *     capability probe: ...
 *   ✓ sessionProjections (rides on the todos acceptance test)
 *
 * rather than only a wall of TypeScript diagnostics or a bare "tests failed".
 * This module owns no vocabulary of its own: `tools/capability-probes.mjs`
 * names which real test file is each capability's evidence, and this module
 * only runs those files through vitest's own structured JSON reporter (a
 * stable, documented interface — not scraped stdout or parsed TypeScript
 * output) and folds each file's pass/fail into one line per capability.
 *
 * Exit code carries the verdict for CI: 0 when every named capability passed,
 * 1 when at least one failed, 2 when vitest itself could not be run or
 * produced no report — a broken checker, which must never read as either
 * verdict.
 * @module tools/capability-report
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAPABILITY_PROBE_FILES, CAPABILITY_PROBES } from './capability-probes.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * One capability's verdict.
 * @typedef {object} CapabilityVerdict
 * @property {string} name - the capability name.
 * @property {string} [note] - passed through from {@link CapabilityProbe}.
 * @property {'PASS'|'FAIL'|'MISSING'} status - `MISSING` means the probe's
 *   file produced no result at all (for example, it failed to collect), which
 *   must not silently read as a pass.
 * @property {string[]} failures - failure messages, when any assertion failed.
 */

/**
 * Fold a vitest JSON report into one verdict per named capability.
 * @param report - the parsed vitest JSON reporter output.
 * @param probes - the capability table; defaults to the real one, injectable for tests.
 * @returns one verdict per probe, in table order.
 */
export function summarizeCapabilities(report, probes = CAPABILITY_PROBES) {
  const byFile = new Map(report.testResults.map(result => [resolve(result.name), result]))
  return probes.map(probe => {
    const results = probe.files.map(file => byFile.get(resolve(repoRoot, file)))
    if (results.some(result => result === undefined)) {
      return { name: probe.name, note: probe.note, status: 'MISSING', failures: [] }
    }
    const failures = results.flatMap(result =>
      (result.assertionResults ?? [])
        .filter(assertion => assertion.status === 'failed')
        .flatMap(assertion => assertion.failureMessages),
    )
    const suitesFailed = results.some(result => result.status === 'failed' || (result.assertionResults ?? []).length === 0 && result.status !== 'passed')
    return {
      name: probe.name,
      note: probe.note,
      status: failures.length > 0 || suitesFailed ? 'FAIL' : 'PASS',
      failures,
    }
  })
}

/**
 * Format the capability verdicts the way a lane's job summary prints them.
 * @param lane - the compatibility lane this report belongs to (`minimum`, `released`, `master`).
 * @param verdicts - the result of {@linkcode summarizeCapabilities}.
 * @returns the report text, ending in a newline.
 */
export function formatCapabilityReport(lane, verdicts) {
  const lines = [`Harness compatibility · ${lane}`]
  for (const verdict of verdicts) {
    const mark = verdict.status === 'PASS' ? '✓' : verdict.status === 'FAIL' ? '✗' : '?'
    const suffix = verdict.note === undefined ? '' : ` (${verdict.note})`
    lines.push(`${mark} ${verdict.name}${suffix}`)
    if (verdict.status === 'MISSING') lines.push('  capability probe produced no result — the checker itself is broken')
    for (const failure of verdict.failures) {
      lines.push(`  ${failure.split('\n')[0]}`)
    }
  }
  return [...lines, ''].join('\n')
}

// Entry point: vitest imports the pure functions above, so the side-effecting
// CLI runs only when this file is executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const lane = process.argv.slice(2)[0] ?? 'unspecified'
  const outputDir = mkdtempSync(join(tmpdir(), 'dsh-capability-report-'))
  const outputFile = join(outputDir, 'report.json')
  try {
    const result = spawnSync('pnpm', [
      'exec', 'vitest', 'run', ...CAPABILITY_PROBE_FILES,
      '--reporter=json', `--outputFile=${outputFile}`,
    ], { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] })
    if (result.error !== undefined) {
      process.stderr.write(`capability-report: could not run vitest: ${result.error.message}\n`)
      process.exit(2)
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(outputFile, 'utf8'))
    } catch (error) {
      process.stderr.write(`capability-report: no readable vitest JSON report: ${String(error)}\n`)
      process.exit(2)
    }
    const verdicts = summarizeCapabilities(parsed)
    const report = formatCapabilityReport(lane, verdicts)
    process.stdout.write(report)
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${report}\`\`\`\n`)
    }
    const failed = verdicts.some(verdict => verdict.status !== 'PASS')
    process.exit(failed || result.status !== 0 ? 1 : 0)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

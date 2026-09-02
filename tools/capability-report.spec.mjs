import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatCapabilityReport, summarizeCapabilities } from './capability-report.mjs'

/** A minimal probe table so these tests do not depend on the real one moving. */
const PROBES = [
  { name: 'alpha', files: ['tools/fixtures/alpha.spec.ts'] },
  { name: 'beta', files: ['tools/fixtures/beta.spec.ts'], note: 'rides on the alpha fixture' },
  { name: 'gamma', files: ['tools/fixtures/gamma.spec.ts'] },
]

/** A vitest JSON report shaped like the real reporter's output, for one file. */
function suite(name, status, failureMessages = []) {
  return {
    name: resolve(`tools/fixtures/${name}.spec.ts`),
    status,
    assertionResults: [{ status, failureMessages }],
  }
}

describe('summarizeCapabilities', () => {
  it('passes a capability whose named file passed', () => {
    const report = { testResults: [suite('alpha', 'passed'), suite('beta', 'passed'), suite('gamma', 'passed')] }
    const verdicts = summarizeCapabilities(report, PROBES)
    expect(verdicts.map(v => v.status)).toEqual(['PASS', 'PASS', 'PASS'])
  })

  it('fails a capability whose named file failed, carrying the failure message', () => {
    const report = {
      testResults: [
        suite('alpha', 'passed'),
        suite('beta', 'passed'),
        suite('gamma', 'failed', ['gamma contract changed: listChildren no longer returns hasChildren']),
      ],
    }
    const verdicts = summarizeCapabilities(report, PROBES)
    expect(verdicts.find(v => v.name === 'gamma')).toMatchObject({
      status: 'FAIL',
      failures: ['gamma contract changed: listChildren no longer returns hasChildren'],
    })
  })

  it('reports MISSING rather than a silent pass when a probe file produced no result', () => {
    const report = { testResults: [suite('alpha', 'passed'), suite('beta', 'passed')] }
    const verdicts = summarizeCapabilities(report, PROBES)
    expect(verdicts.find(v => v.name === 'gamma')).toMatchObject({ status: 'MISSING' })
  })

  it('carries the note through to the verdict', () => {
    const report = { testResults: [suite('alpha', 'passed'), suite('beta', 'passed'), suite('gamma', 'passed')] }
    const verdicts = summarizeCapabilities(report, PROBES)
    expect(verdicts.find(v => v.name === 'beta')?.note).toBe('rides on the alpha fixture')
  })
})

describe('formatCapabilityReport', () => {
  it('marks a pass, a fail with its message, and a missing probe distinctly', () => {
    const text = formatCapabilityReport('target (0.1.2-alpha.5)', [
      { name: 'sessionQuery', status: 'PASS', failures: [] },
      { name: 'subagents', status: 'FAIL', failures: ['contract changed'] },
      { name: 'jobs', status: 'MISSING', failures: [] },
    ])
    expect(text).toContain('Harness compatibility · target (0.1.2-alpha.5)')
    expect(text).toContain('✓ sessionQuery')
    expect(text).toContain('✗ subagents')
    expect(text).toContain('  contract changed')
    expect(text).toContain('? jobs')
    expect(text).toContain('capability probe produced no result')
  })

  it('appends a note in parentheses beside the capability name', () => {
    const text = formatCapabilityReport('target (0.1.2-alpha.5)', [{ name: 'sessionProjections', status: 'PASS', failures: [], note: 'rides on the todos acceptance test' }])
    expect(text).toContain('✓ sessionProjections (rides on the todos acceptance test)')
  })
})

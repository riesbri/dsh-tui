import { describe, expect, it } from 'vitest'
import { compareToInstallable, fetchTagNames, latestHarnessRelease, parseHarnessTag } from './latest-harness-release.mjs'

describe('parseHarnessTag()', () => {
  it('extracts the version from a dsh-v* release tag', () => {
    expect(parseHarnessTag('dsh-v0.1.2-alpha.1')).toBe('0.1.2-alpha.1')
  })

  it('ignores a tag outside the dsh-v* namespace', () => {
    expect(parseHarnessTag('v0.1.2-alpha.1')).toBeUndefined()
    expect(parseHarnessTag('some-other-tag')).toBeUndefined()
  })

  it('ignores a dsh-v* tag whose suffix does not parse as a version', () => {
    expect(parseHarnessTag('dsh-v-not-a-version')).toBeUndefined()
  })
})

describe('latestHarnessRelease()', () => {
  it('picks the newest release by semantic version, not by list order', () => {
    expect(latestHarnessRelease([
      'dsh-v0.1.1-rc.2',
      'dsh-v0.1.2-alpha.1',
      'dsh-v0.1.0-rc.8',
    ])).toEqual({ tag: 'dsh-v0.1.2-alpha.1', version: '0.1.2-alpha.1' })
  })

  it('skips tags outside the dsh-v* namespace entirely', () => {
    expect(latestHarnessRelease(['some-other-tag', 'v9.9.9'])).toBeUndefined()
  })

  it('returns undefined for an empty tag list', () => {
    expect(latestHarnessRelease([])).toBeUndefined()
  })
})

describe('compareToInstallable()', () => {
  it('reports ahead when the tag is newer than what npm installs today', () => {
    expect(compareToInstallable('0.1.2-alpha.1', '0.1.1-rc.2')).toBe('ahead')
  })

  it('reports same when the tag matches the installable line exactly', () => {
    expect(compareToInstallable('0.1.1-rc.2', '0.1.1-rc.2')).toBe('same')
  })

  it('reports behind when npm has already moved past the newest tag', () => {
    expect(compareToInstallable('0.1.1-rc.2', '0.1.2-alpha.1')).toBe('behind')
  })
})

describe('fetchTagNames()', () => {
  it('extracts tag names from the GitHub API response', async () => {
    const fakeFetch = async (url, init) => {
      expect(url).toContain('/repos/deepseek-ai/deepseek-harness/tags')
      expect(init.headers.Authorization).toBeUndefined()
      return { ok: true, json: async () => [{ name: 'dsh-v0.1.2-alpha.1' }, { name: 'dsh-v0.1.1-rc.2' }] }
    }
    await expect(fetchTagNames(fakeFetch, undefined)).resolves.toEqual(['dsh-v0.1.2-alpha.1', 'dsh-v0.1.1-rc.2'])
  })

  it('sends a bearer token when one is provided, to raise the anonymous rate limit', async () => {
    const fakeFetch = async (_url, init) => {
      expect(init.headers.Authorization).toBe('Bearer secret')
      return { ok: true, json: async () => [] }
    }
    await fetchTagNames(fakeFetch, 'secret')
  })

  it('fails loudly on a non-OK response rather than returning an empty list silently', async () => {
    const fakeFetch = async () => ({ ok: false, status: 404 })
    await expect(fetchTagNames(fakeFetch, undefined)).rejects.toThrow(/404/)
  })
})

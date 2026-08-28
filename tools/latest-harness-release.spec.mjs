import { describe, expect, it } from 'vitest'
import { compareToInstallable, fetchReleases, latestHarnessRelease, parseHarnessTag, resolveCommitSha } from './latest-harness-release.mjs'

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
      { tag_name: 'dsh-v0.1.1-rc.2', draft: false },
      { tag_name: 'dsh-v0.1.2-alpha.1', draft: false },
      { tag_name: 'dsh-v0.1.0-rc.8', draft: false },
    ])).toEqual({ tag: 'dsh-v0.1.2-alpha.1', version: '0.1.2-alpha.1' })
  })

  it('keeps prereleases: DeepSeek ships alpha/rc lines as real Releases', () => {
    expect(latestHarnessRelease([{ tag_name: 'dsh-v0.1.2-alpha.1', draft: false, prerelease: true }]))
      .toEqual({ tag: 'dsh-v0.1.2-alpha.1', version: '0.1.2-alpha.1' })
  })

  it('excludes a draft release: it is not officially published yet', () => {
    expect(latestHarnessRelease([
      { tag_name: 'dsh-v0.1.2-alpha.1', draft: false },
      { tag_name: 'dsh-v0.9.9-rc.1', draft: true },
    ])).toEqual({ tag: 'dsh-v0.1.2-alpha.1', version: '0.1.2-alpha.1' })
  })

  it('skips releases outside the dsh-v* namespace entirely', () => {
    expect(latestHarnessRelease([{ tag_name: 'some-other-tag', draft: false }])).toBeUndefined()
  })

  it('returns undefined for an empty release list', () => {
    expect(latestHarnessRelease([])).toBeUndefined()
  })
})

describe('compareToInstallable()', () => {
  it('reports ahead when the release is newer than what npm installs today', () => {
    expect(compareToInstallable('0.1.2-alpha.1', '0.1.1-rc.2')).toBe('ahead')
  })

  it('reports same when the release matches the installable line exactly', () => {
    expect(compareToInstallable('0.1.1-rc.2', '0.1.1-rc.2')).toBe('same')
  })

  it('reports behind when npm has already moved past the newest release', () => {
    expect(compareToInstallable('0.1.1-rc.2', '0.1.2-alpha.1')).toBe('behind')
  })
})

describe('fetchReleases()', () => {
  it('returns the raw release objects unfiltered', async () => {
    const fakeFetch = async (url, init) => {
      expect(url).toContain('/repos/deepseek-ai/deepseek-harness/releases')
      expect(init.headers.Authorization).toBeUndefined()
      return { ok: true, json: async () => [{ tag_name: 'dsh-v0.1.2-alpha.1', draft: false }] }
    }
    await expect(fetchReleases(fakeFetch, undefined)).resolves.toEqual([{ tag_name: 'dsh-v0.1.2-alpha.1', draft: false }])
  })

  it('sends a bearer token when one is provided, to raise the anonymous rate limit', async () => {
    const fakeFetch = async (_url, init) => {
      expect(init.headers.Authorization).toBe('Bearer secret')
      return { ok: true, json: async () => [] }
    }
    await fetchReleases(fakeFetch, 'secret')
  })

  it('fails loudly on a non-OK response rather than returning an empty list silently', async () => {
    const fakeFetch = async () => ({ ok: false, status: 404 })
    await expect(fetchReleases(fakeFetch, undefined)).rejects.toThrow(/404/)
  })
})

describe('resolveCommitSha()', () => {
  it('resolves a ref to its commit sha', async () => {
    const fakeFetch = async url => {
      expect(url).toContain('/repos/deepseek-ai/deepseek-harness/commits/master')
      return { ok: true, json: async () => ({ sha: 'abc123' }) }
    }
    await expect(resolveCommitSha('master', fakeFetch, undefined)).resolves.toBe('abc123')
  })

  it('URL-encodes a ref that needs it', async () => {
    const fakeFetch = async url => {
      expect(url).toContain('/commits/dsh-v0.1.2-alpha.1')
      return { ok: true, json: async () => ({ sha: 'def456' }) }
    }
    await resolveCommitSha('dsh-v0.1.2-alpha.1', fakeFetch, undefined)
  })

  it('fails loudly on a non-OK response', async () => {
    const fakeFetch = async () => ({ ok: false, status: 422 })
    await expect(resolveCommitSha('master', fakeFetch, undefined)).rejects.toThrow(/422/)
  })
})

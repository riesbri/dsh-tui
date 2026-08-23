import { describe, expect, it, vi } from 'vitest'
import { PACKAGE_DIRECTORIES, waitForPublished } from './verify-published.mjs'

const PACKAGES = [
  { name: 'dshline-renderer', version: '0.3.2' },
  { name: 'dshline', version: '0.3.2' },
]

describe('waitForPublished()', () => {
  it('covers every published workspace package', () => {
    expect(PACKAGE_DIRECTORIES).toEqual(['packages/renderer', 'packages/dshline'])
  })

  it('waits for a package that appears after its publish request returns', async () => {
    const seen = new Map([
      [PACKAGES[0].name, 0],
      [PACKAGES[1].name, 0],
    ])
    const isPublished = vi.fn(name => {
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      return name === PACKAGES[0].name || count >= 2
    })
    const sleep = vi.fn(async () => {})
    const write = vi.fn()

    await expect(waitForPublished(PACKAGES, { isPublished, sleep, write, attempts: 3 }))
      .resolves.toEqual([])
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(isPublished.mock.calls.map(call => call[0])).toEqual([
      PACKAGES[0].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
    ])
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`${PACKAGES[1].name}@0.3.2`))
  })

  it('returns a persistent half-release after the retry budget', async () => {
    const sleep = vi.fn(async () => {})
    const missing = await waitForPublished(PACKAGES, {
      isPublished: item => item === PACKAGES[0].name,
      sleep,
      write: () => {},
      attempts: 3,
    })

    expect(missing).toEqual([`${PACKAGES[1].name}@0.3.2`])
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})

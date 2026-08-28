import { describe, expect, it } from 'vitest'
import { floorUpdates } from './pin-harness-floor.mjs'

describe('floorUpdates', () => {
  it('pins a dsh-* entry that is ahead of the floor', () => {
    const updates = floorUpdates({ '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, '0.1.1-rc.2')
    expect(updates).toEqual([])
  })

  it('reports a change for an entry that differs from the floor, in either direction', () => {
    const updates = floorUpdates({ '@deepseek-ai/dsh-agent': '0.1.0-rc.8' }, '0.1.1-rc.2')
    expect(updates).toEqual([{ name: '@deepseek-ai/dsh-agent', from: '0.1.0-rc.8', to: '0.1.1-rc.2' }])
  })

  it('never touches cordis, which versions independently of the dsh-* line', () => {
    const updates = floorUpdates({ '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, '0.1.1-rc.2')
    expect(updates).toEqual([])
  })

  it('ignores a non-Harness devDependency entirely', () => {
    const updates = floorUpdates({ typescript: '^7.0.2' }, '0.1.1-rc.2')
    expect(updates).toEqual([])
  })
})

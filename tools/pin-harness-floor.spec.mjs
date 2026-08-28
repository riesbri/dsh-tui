import { describe, expect, it } from 'vitest'
import { floorUpdates } from './pin-harness-floor.mjs'

describe('floorUpdates', () => {
  it('leaves a dsh-* entry alone when it is already exactly at the floor', () => {
    const updates = floorUpdates({ '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, '0.1.1-rc.2')
    expect(updates).toEqual([])
  })

  it('reports a change for an entry that differs from the floor, in either direction', () => {
    const updates = floorUpdates({ '@deepseek-ai/dsh-agent': '0.1.0-rc.8' }, '0.1.1-rc.2')
    expect(updates).toEqual([{ name: '@deepseek-ai/dsh-agent', from: '0.1.0-rc.8', to: '0.1.1-rc.2' }])
  })

  it('collapses a ranged direct dependency to an exact pin, the same as any devDependency', () => {
    // @deepseek-ai/dsh-atomic-write is exactly this shape in packages/dshline's
    // real dependencies: a caret range whose upper bound could otherwise let a
    // disposable, non-frozen install resolve it away from the floor while
    // every other package in the graph sits pinned exactly there.
    const updates = floorUpdates({ '@deepseek-ai/dsh-atomic-write': '^0.1.1-rc.2' }, '0.1.1-rc.2')
    expect(updates).toEqual([{ name: '@deepseek-ai/dsh-atomic-write', from: '^0.1.1-rc.2', to: '0.1.1-rc.2' }])
  })

  it('never touches cordis, which versions independently of the dsh-* line', () => {
    const updates = floorUpdates({ '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, '0.1.1-rc.2')
    expect(updates).toEqual([])
  })

  it('never touches an independently-versioned @deepseek-ai/* package outside the dsh-* line', () => {
    const updates = floorUpdates({ '@deepseek-ai/schemastery': '^3.18.1' }, '0.1.1-rc.2')
    expect(updates).toEqual([])
  })

  it('ignores a non-Harness dependency entirely', () => {
    const updates = floorUpdates({ typescript: '^7.0.2' }, '0.1.1-rc.2')
    expect(updates).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { LocalCommandRegistry } from '../src/local-commands.ts'

describe('LocalCommandRegistry', () => {
  it('lists only the completion-facing command summaries', () => {
    const registry = new LocalCommandRegistry([
      {
        name: 'profile',
        description: 'Chart each turn',
        execute: () => {},
      },
    ])

    expect(registry.list()).toEqual([{ name: 'profile', description: 'Chart each turn' }])
    expect(registry.get('profile')?.name).toBe('profile')
    expect(registry.get('missing')).toBeUndefined()
  })

  it('returns each command’s synchronous or asynchronous completion values', async () => {
    const registry = new LocalCommandRegistry([
      {
        name: 'profile',
        description: '',
        complete: () => [{ value: 'on', note: 'Chart each turn' }],
        execute: () => {},
      },
      {
        name: 'model',
        description: '',
        complete: async () => [{ value: 'deepseek-v4-pro', note: 'DeepSeek' }],
        execute: () => {},
      },
      { name: 'exit', description: '', execute: () => {} },
    ])

    await expect(registry.arguments('profile')).resolves.toEqual([{ value: 'on', note: 'Chart each turn' }])
    await expect(registry.arguments('model')).resolves.toEqual([{ value: 'deepseek-v4-pro', note: 'DeepSeek' }])
    await expect(registry.arguments('exit')).resolves.toEqual([])
    await expect(registry.arguments('missing')).resolves.toEqual([])
  })

  it('runs only a local command and preserves its raw input', async () => {
    const executed: string[] = []
    const registry = new LocalCommandRegistry([
      {
        name: 'usage',
        description: '',
        execute: async rawInput => { executed.push(rawInput) },
      },
    ])

    await expect(registry.execute('usage', '  tokens  ')).resolves.toBe(true)
    await expect(registry.execute('harness-command', '')).resolves.toBe(false)
    expect(executed).toEqual(['  tokens  '])
  })

  it('lets a local command failure reach the runner’s existing error reporter', async () => {
    const registry = new LocalCommandRegistry([
      {
        name: 'model',
        description: '',
        execute: () => { throw new Error('provider unavailable') },
      },
    ])

    await expect(registry.execute('model', '')).rejects.toThrow('provider unavailable')
  })
})

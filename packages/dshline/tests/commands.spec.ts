/** Compatibility coverage for the Harness command registry dispatch. */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeCommand } from '../src/commands.ts'

const agent = {} as Agent
const signal = AbortSignal.timeout(1_000)

describe('command registry compatibility dispatch', () => {
  it('calls the old peer-floor signature with the signal as its third argument and preserves this', async () => {
    class OldCommands {
      readonly marker = 'old'
      readonly calls: unknown[][] = []

      async execute(target: Agent, line: string, received: AbortSignal): Promise<string> {
        this.calls.push([target, line, received])
        return this.marker
      }
    }
    const commands = new OldCommands()
    await expect(executeCommand(commands, agent, '/plan', signal)).resolves.toBe('old')
    expect(commands.calls).toEqual([[agent, '/plan', signal]])
  })

  it('calls the attachment-aware signature with an explicit empty attachment list and preserves this', async () => {
    class CurrentCommands {
      readonly marker = 'current'
      readonly calls: unknown[][] = []

      async execute(target: Agent, line: string, images: readonly unknown[], received: AbortSignal): Promise<string> {
        this.calls.push([target, line, images, received])
        return this.marker
      }
    }
    const commands = new CurrentCommands()
    await expect(executeCommand(commands, agent, '/plan', signal)).resolves.toBe('current')
    expect(commands.calls).toEqual([[agent, '/plan', [], signal]])
  })
})

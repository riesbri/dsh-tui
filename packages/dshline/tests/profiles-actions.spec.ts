/**
 * Forwarding one `dsh plugin --profile <name> …` invocation.
 *
 * The forwarder never throws: a launcher that is not installed, a child that
 * fails, and a child that produces pages of pnpm output are all facts about
 * the machine, and each has to reach the reader as an outcome rather than as
 * an exception out of a keystroke.
 */

import { describe, expect, it } from 'vitest'
import { findLauncher, pluginCommand, runProfileOperation } from '../src/profiles/actions.ts'
import { resolveOperation } from '../src/profiles/model.ts'

/** A launcher that is present, without touching PATH. */
const FOUND = async (): Promise<string> => '/usr/local/bin/dsh'

describe('the command line a reader could run themselves', () => {
  it('names the profile and the forwarded arguments', () => {
    expect(pluginCommand('dshline', ['add', '@example/plugin']))
      .toBe('dsh plugin --profile dshline add @example/plugin')
  })

  it('leaves no trailing space when the operation names no package', () => {
    expect(pluginCommand('dshline', ['update'])).toBe('dsh plugin --profile dshline update')
  })
})

describe('finding the launcher', () => {
  it('reports none when PATH is empty', async () => {
    expect(await findLauncher({ PATH: '' })).toBeUndefined()
    expect(await findLauncher({})).toBeUndefined()
  })

  it('reports none when no directory on PATH holds an executable dsh', async () => {
    expect(await findLauncher({ PATH: '/nonexistent-a:/nonexistent-b' })).toBeUndefined()
  })
})

describe('running one operation', () => {
  it('forwards plugin, --profile, the name, then the operation arguments', async () => {
    const calls: { command: string; args: readonly string[] }[] = []
    await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', '@example/plugin'),
      launcher: FOUND,
      run: async (command, args) => {
        calls.push({ command, args })
        return { code: 0, output: '' }
      },
    })
    expect(calls).toEqual([{
      command: '/usr/local/bin/dsh',
      args: ['plugin', '--profile', 'dshline', 'add', '@example/plugin'],
    }])
  })

  it('reports success with what the operation was', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', '@example/plugin'),
      launcher: FOUND,
      run: async () => ({ code: 0, output: 'done\n' }),
    })
    expect(outcome.kind).toBe('done')
    expect(outcome.message).toContain('installing @example/plugin')
  })

  it('names the exact command when no launcher is on PATH, rather than failing silently', async () => {
    // A source checkout runs the launcher through a loader script and has no
    // `dsh` executable at all; the honest answer is the command to run.
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('update-all'),
      launcher: async () => undefined,
      run: async () => { throw new Error('must not spawn without a launcher') },
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('not on PATH')
    expect(outcome.message).toContain('dsh plugin --profile dshline update')
  })

  it('reports a non-zero exit with the child output tail', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', '@example/missing'),
      launcher: FOUND,
      run: async () => ({ code: 1, output: 'ERR_PNPM_FETCH_404\nnot found\n' }),
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('exited 1')
    expect(outcome.output).toEqual(['ERR_PNPM_FETCH_404', 'not found'])
  })

  it('bounds the kept output so a long pnpm log cannot flood the transcript', async () => {
    const output = Array.from({ length: 200 }, (_unused, index) => `line ${String(index)}`).join('\n')
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('update-all'),
      launcher: FOUND,
      run: async () => ({ code: 1, output }),
    })
    expect(outcome.output.length).toBeLessThanOrEqual(6)
    // The TAIL is kept: a pnpm failure states its reason last.
    expect(outcome.output.at(-1)).toBe('line 199')
  })

  it('drops blank lines from the kept output', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('update-all'),
      launcher: FOUND,
      run: async () => ({ code: 1, output: 'first\n\n\n   \nlast\n' }),
    })
    expect(outcome.output).toEqual(['first', 'last'])
  })
})

/**
 * What a person actually sees while a reply streams.
 *
 * Incremental commit interleaves scrollback writes with live-region redraws
 * hundreds of times per reply, and the arithmetic that keeps those two apart is
 * the part that breaks. Stripping escape sequences out of the byte stream cannot
 * prove anything about it — the sequences ARE the layout — so these tests drive a
 * real emulator and read its screen buffer.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Screen } from '@riesbri/dsh-tui-renderer'
import type { Emulator } from '../../../tests/emulator.ts'
import { createEmulator } from '../../../tests/emulator.ts'
import { StreamBuffer } from '../src/stream.ts'

/** Chrome below the live stream rows, standing in for the composer and status. */
const CHROME = ['> ', 'idle']

/** The default emulator width these tests use where they do not vary it. */
const COLUMNS = 40

/**
 * Stream a reply into an emulator exactly as the runner does.
 * @param reply - the full reply text.
 * @param options - terminal size, delta size, and whether the message lands.
 * @returns the emulator's non-empty screen rows, in order.
 */
async function play(
  reply: string,
  { columns = 40, rows = 24, delta = 5, settle = true } = {},
): Promise<string[]> {
  const emulator = createEmulator(columns, rows)
  const screen = new Screen(emulator.target)
  const buffer = new StreamBuffer()
  const commit = (lines: readonly string[]): void => { if (lines.length > 0) screen.commit(lines) }
  for (const fragment of reply.match(new RegExp(`.{1,${String(delta)}}`, 'gsu')) ?? []) {
    commit(buffer.push('text', fragment, columns))
    screen.setLive([...buffer.live(columns), ...CHROME])
  }
  if (settle) {
    const content: ContentBlock[] = [{ type: 'text', text: reply }]
    commit(buffer.settle(content, columns))
  }
  screen.setLive(CHROME)
  return visible(emulator)
}

/**
 * The rows a person can see, blank ones dropped.
 * @param emulator - the emulator to read.
 * @returns trimmed non-empty rows, in order.
 */
async function visible(emulator: Emulator): Promise<string[]> {
  return (await emulator.screen()).map(row => row.trimEnd()).filter(row => row !== '')
}

describe('a streaming reply on a real terminal', () => {
  it('lands in scrollback exactly once', async () => {
    // The failure this guards against is the reply appearing twice: once from the
    // deltas and again from the assembled message.
    expect(await play('alpha\nbeta\ngamma\n')).toEqual(['● alpha', '  beta', '  gamma', '>', 'idle'])
  })

  it('reads the same however the provider chunks it', async () => {
    const reply = '## Heading\n\nsome text here\n\n- one\n- two\n'
    const reference = await play(reply, { delta: 1 })
    for (const delta of [2, 7, 13, 200]) {
      expect(await play(reply, { delta }), `delta ${String(delta)}`).toEqual(reference)
    }
  })

  it('leaves the chrome at the bottom with the reply above it', async () => {
    // The live region must be the last thing on screen; a mistake in the redraw
    // arithmetic shows up here as chrome buried inside the reply.
    const shown = await play('one\ntwo\nthree\n')
    expect(shown.slice(-CHROME.length)).toEqual(['>', 'idle'])
  })

  it('keeps a reply taller than the terminal in the terminal\'s own scrollback', async () => {
    // The reason this renderer never takes the alternate screen: a reply longer
    // than the window scrolls, and every line of it stays where the user can
    // scroll back to it, select it, and copy it.
    const emulator = createEmulator(40, 10)
    const screen = new Screen(emulator.target)
    const buffer = new StreamBuffer()
    const reply = `${Array.from({ length: 60 }, (_, i) => `line ${String(i)}`).join('\n')}\n`
    for (const fragment of reply.match(/.{1,5}/gsu) ?? []) {
      const done = buffer.push('text', fragment, COLUMNS)
      if (done.length > 0) screen.commit(done)
      screen.setLive([...buffer.live(COLUMNS), ...CHROME])
    }
    screen.setLive(CHROME)
    const all = (await emulator.scrollback()).map(row => row.trimEnd()).filter(row => row !== '')
    expect(all[0]).toBe('\u25cf line 0')
    expect(all.slice(-3)).toEqual(['  line 59', '>', 'idle'])
    // Every line present once: nothing was redrawn in place or printed twice.
    expect(all.filter(row => row.endsWith('line 42'))).toHaveLength(1)
    // And the window itself shows the end of it, with the chrome still last.
    expect(await visible(emulator)).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `  line ${String(53 + i)}`), '>', 'idle',
    ])
  })

  it('shows no partial line after the reply is committed', async () => {
    // The live region held 'gamma' as an unfinished line; settling must move it
    // into scrollback rather than leave a copy behind.
    const shown = await play('alpha\nbeta\ngamma')
    expect(shown.filter(row => row.endsWith('gamma'))).toHaveLength(1)
  })

  it('shows the unfinished line while it is still arriving', async () => {
    const emulator = createEmulator(40, 24)
    const screen = new Screen(emulator.target)
    const buffer = new StreamBuffer()
    screen.commit(buffer.push('text', 'complete\npartial so far', COLUMNS))
    screen.setLive([...buffer.live(40), ...CHROME])
    expect(await visible(emulator))
      .toEqual(['● complete', '  partial so far', '>', 'idle'])
  })

  it('replaces streamed reasoning with the reply, keeping both', async () => {
    const emulator = createEmulator(40, 24)
    const screen = new Screen(emulator.target)
    const buffer = new StreamBuffer()
    const commit = (lines: readonly string[]): void => { if (lines.length > 0) screen.commit(lines) }
    commit(buffer.push('reasoning', 'let me check the file', COLUMNS))
    screen.setLive([...buffer.live(40), ...CHROME])
    commit(buffer.push('text', 'It is empty.', COLUMNS))
    commit(buffer.settle([{ type: 'reasoning', text: 'let me check the file' }, { type: 'text', text: 'It is empty.' }], COLUMNS))
    screen.setLive(CHROME)
    expect(await visible(emulator))
      .toEqual(['✻ let me check the file', '● It is empty.', '>', 'idle'])
  })
})

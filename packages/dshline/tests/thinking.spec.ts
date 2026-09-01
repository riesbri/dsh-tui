import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import { pickThinking, thinkingAcknowledgement, thinkingChoices, THINKING_VALUES, validThinkingArgument } from '../src/thinking.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** A minimal context that records the picker currently mounted. */
function pickerContext(): { ctx: Context; overlay: () => TuiOverlay | undefined } {
  let current: TuiOverlay | undefined
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        current = overlay
        return (): void => { current = undefined }
      },
      invalidate: (): void => {},
    },
  } as unknown as Context
  return { ctx, overlay: () => current }
}

/** A decoded keypress for the shared picker. */
function key(name: Extract<Key, { kind: 'key' }>['name']): Key {
  return { kind: 'key', name }
}

describe('/thinking', () => {
  it('offers tight direct values and clear picker copy', () => {
    expect(THINKING_VALUES.map(choice => choice.value)).toEqual(['on', 'off'])
    expect(thinkingChoices().map(choice => choice.label)).toEqual(['Shown', 'Hidden'])
    expect(thinkingChoices().map(choice => choice.description)).toEqual([
      'Show model reasoning as it arrives',
      'Hide reasoning; model behavior is unchanged',
    ])
  })

  it.each(['', 'on', 'ON', 'off', 'OFF'])('accepts %j', argument => {
    expect(validThinkingArgument(argument)).toBe(true)
  })

  it.each(['shown', 'hidden', 'toggle', 'on now'])('rejects %j', argument => {
    expect(validThinkingArgument(argument)).toBe(false)
  })

  it('sets direct arguments without opening the picker', async () => {
    const { ctx, overlay } = pickerContext()
    const changed: boolean[] = []
    await expect(pickThinking(ctx, true, 'off', next => { changed.push(next) })).resolves.toBe('hidden')
    expect(changed).toEqual([false])
    expect(overlay()).toBeUndefined()
    expect(thinkingAcknowledgement('hidden')).toBe('· thinking: hidden')
  })

  it('opens the bare command with the current choice highlighted', async () => {
    const { ctx, overlay } = pickerContext()
    const changed: boolean[] = []
    const pending = pickThinking(ctx, false, '', next => { changed.push(next) })
    expect(overlay()).toBeDefined()
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(pending).resolves.toBe('hidden')
    expect(changed).toEqual([false])
  })

  it('leaves state unchanged when the selector is dismissed', async () => {
    const { ctx, overlay } = pickerContext()
    const changed: boolean[] = []
    const pending = pickThinking(ctx, true, '', next => { changed.push(next) })
    overlay()?.handleKey(key('escape'))
    await expect(pending).resolves.toBeUndefined()
    expect(changed).toEqual([])
  })
})

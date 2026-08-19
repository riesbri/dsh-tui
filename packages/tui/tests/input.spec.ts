import { describe, expect, it } from 'vitest'
import { Composer } from '@riesbri/dsh-tui-renderer'
import { createCompletion } from '../src/completion.ts'
import { InputHistory } from '../src/history.ts'
import { routeInputKey } from '../src/input.ts'

/** Completion sources offering only the named commands. */
function completionFor(composer: Composer, commands: readonly string[]): ReturnType<typeof createCompletion> {
  return createCompletion(composer, {
    commands: () => commands.map(name => ({ name, description: '' })),
    commandArguments: async () => [],
    paths: async () => [],
  }, () => {})
}

describe('routeInputKey()', () => {
  it('lets a visible completion list keep the vertical arrows', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '/m' })
    const completion = completionFor(composer, ['model'])
    await completion.refresh()
    const history = new InputHistory()
    history.record('an older prompt')

    expect(completion.active).toBe(true)
    expect(routeInputKey({ kind: 'key', name: 'up' }, composer, completion, history)).toBe('completion')
    // Completion moved, not history: the buffer still holds the typed token.
    expect(composer.value).toBe('/m')
  })

  it('does not let a recalled line steal the next arrow press', async () => {
    const composer = new Composer()
    const completion = completionFor(composer, ['model'])
    const history = new InputHistory()
    history.record('explain this function')
    history.record('/model')

    expect(routeInputKey({ kind: 'key', name: 'up' }, composer, completion, history)).toBe('history')
    expect(composer.value).toBe('/model')
    // History traversal does not recompute completion, so the recalled `/model`
    // does not open a list that would swallow the next arrow.
    expect(completion.active).toBe(false)
    expect(routeInputKey({ kind: 'key', name: 'up' }, composer, completion, history)).toBe('history')
    expect(composer.value).toBe('explain this function')
  })

  it('restores the unfinished draft past the newest entry', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'half-typed draft' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('earlier')

    expect(routeInputKey({ kind: 'key', name: 'up' }, composer, completion, history)).toBe('history')
    expect(composer.value).toBe('earlier')
    expect(routeInputKey({ kind: 'key', name: 'down' }, composer, completion, history)).toBe('history')
    expect(composer.value).toBe('half-typed draft')
    // Already back at the draft: the composer would ignore a further down.
    expect(routeInputKey({ kind: 'key', name: 'down' }, composer, completion, history)).toBe('composer')
  })

  it('sanitizes a recalled seeded entry before it reaches the composer', () => {
    const composer = new Composer()
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('evil\u001b[2J')

    expect(routeInputKey({ kind: 'key', name: 'up' }, composer, completion, history)).toBe('history')
    expect(composer.value).toBe('evil^[[2J')
  })

  it('leaves every non-arrow key to the composer', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'plain' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('unused')

    expect(routeInputKey({ kind: 'text', text: 'x' }, composer, completion, history)).toBe('composer')
    expect(composer.value).toBe('plain')
  })

  it('falls through to the composer when history has nothing to show', () => {
    const composer = new Composer()
    const completion = completionFor(composer, [])
    const history = new InputHistory()

    expect(routeInputKey({ kind: 'key', name: 'up' }, composer, completion, history)).toBe('composer')
    expect(routeInputKey({ kind: 'key', name: 'down' }, composer, completion, history)).toBe('composer')
  })
})

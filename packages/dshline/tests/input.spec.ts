import { describe, expect, it } from 'vitest'
import { Composer } from '@dshline/renderer'
import { createCompletion } from '../src/completion.ts'
import { InputHistory } from '../src/history.ts'
import { HistorySearch } from '../src/history-search.ts'
import type { ComposerGeometry } from '../src/input.ts'
import { applyHistorySearch, routeInputKey } from '../src/input.ts'

/**
 * A wide geometry so single-line text never wraps, letting routing tests focus
 * on behaviour rather than on the layout arithmetic.
 */
const WIDE: ComposerGeometry = { width: 120, gutter: line => (line === 0 ? '› ' : '  ') }

/**
 * A narrow geometry whose content area wraps a single long line into several
 * visual rows, for the wrapping-focused tests.
 */
const NARROW: ComposerGeometry = { width: 12, gutter: line => (line === 0 ? '› ' : '  ') }

const UP = { kind: 'key', name: 'up' } as const
const DOWN = { kind: 'key', name: 'down' } as const

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
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('completion')
    // Completion moved, not history: the buffer still holds the typed token.
    expect(composer.value).toBe('/m')
  })

  it('offers the accelerated gesture to a visible completion list before the composer', async () => {
    // The route is what makes `ctrl-enter` an ENTER with a different delivery
    // rather than a second, blunter submit key: the list adjudicates it first,
    // exactly as it adjudicates enter, and only what the list declines becomes a
    // submission for the delivery choice to route.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '/mod' })
    const completion = completionFor(composer, ['model'])
    await completion.refresh()
    const history = new InputHistory()

    expect(completion.active).toBe(true)
    const accelerated = { kind: 'key', name: 'ctrl-enter' } as const
    expect(routeInputKey(accelerated, composer, completion, history, WIDE)).toBe('completion')
    expect(composer.value).toBe('/model ')
  })

  it('hands the accelerated gesture to the composer once nothing is completable', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'ordinary prose' })
    const completion = completionFor(composer, ['model'])
    await completion.refresh()
    const history = new InputHistory()

    expect(completion.active).toBe(false)
    expect(routeInputKey({ kind: 'key', name: 'ctrl-enter' }, composer, completion, history, WIDE)).toBe('composer')
    expect(composer.value).toBe('ordinary prose')
  })

  it('does not let a recalled line steal the next arrow press', async () => {
    const composer = new Composer()
    const completion = completionFor(composer, ['model'])
    const history = new InputHistory()
    history.record('explain this function')
    history.record('/model')

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('/model')
    // History traversal does not recompute completion, so the recalled `/model`
    // does not open a list that would swallow the next arrow.
    expect(completion.active).toBe(false)
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('explain this function')
  })

  it('abandons an in-flight completion lookup once history navigation starts', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '@pack' })
    let release = (): void => {}
    const completion = createCompletion(composer, {
      commands: () => [],
      commandArguments: async () => [],
      paths: () => new Promise(resolve => { release = () => { resolve([{ name: 'packages', directory: true }]) } }),
    }, () => {})
    const pending = completion.refresh()
    // The lookup cleared the list and is still awaiting the directory read.
    expect(completion.active).toBe(false)

    const history = new InputHistory()
    history.record('explain this function')
    history.record('/model')

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('/model')

    // The stale `@pack` read resolves now. It must not revive candidates for a
    // token the composer no longer holds, or the next arrow would move through
    // completion instead of continuing through history.
    release()
    await pending

    expect(completion.active).toBe(false)
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('explain this function')
  })

  it('restores the unfinished draft past the newest entry', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'half-typed draft' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('earlier')

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('earlier')
    expect(routeInputKey(DOWN, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('half-typed draft')
    // Already back at the draft: the composer ignores a further down.
    expect(routeInputKey(DOWN, composer, completion, history, WIDE)).toBe('composer')
  })

  it('sanitizes a recalled seeded entry before it reaches the composer', () => {
    const composer = new Composer()
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('evil\u001b[2J')

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('evil^[[2J')
  })

  it('leaves every non-arrow key to the composer', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'plain' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('unused')

    expect(routeInputKey({ kind: 'text', text: 'x' }, composer, completion, history, WIDE)).toBe('composer')
    expect(composer.value).toBe('plain')
  })

  it('falls through to the composer when history has nothing to show', () => {
    const composer = new Composer()
    const completion = completionFor(composer, [])
    const history = new InputHistory()

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('composer')
    expect(routeInputKey(DOWN, composer, completion, history, WIDE)).toBe('composer')
  })

  it('does not make a recalled history entry undoable', () => {
    // History owns history: the recall wrote a fresh baseline, so `ctrl-z`
    // reaches back only as far as the first edit made ON TOP of the recall.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'half-typed draft' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('an older prompt')

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('an older prompt')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('an older prompt')
    composer.handle({ kind: 'text', text: ' plus an edit' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('an older prompt')
  })

  it('does not make a ctrl-r recalled result undoable', () => {
    const composer = new Composer()
    const history = new InputHistory()
    history.record('old')
    history.record('newer')
    const search = new HistorySearch(history)
    expect(search.selected).toBe(1)
    applyHistorySearch(search.selected, composer, history)
    expect(composer.value).toBe('newer')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('newer')
  })
})

describe('vertical composer movement in the input router', () => {
  it('walks a multiline draft before it recalls history', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'first visual row\nsecond visual row\nthird visual row' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('previous command')

    expect(composer.cursorLine).toBe(2)
    // First up moves within the draft, leaving the text itself untouched.
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('vertical')
    expect(composer.value).toBe('first visual row\nsecond visual row\nthird visual row')
    // The cursor left the last line.
    expect(composer.cursorLine).toBe(1)

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('vertical')
    expect(composer.cursorLine).toBe(0)

    // Now at the topmost row, one more up recalls the previous command.
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('previous command')
  })

  it('does not let down at the last row invent newer history', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'first line\nsecond line\nthird line' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('a past command')

    expect(composer.cursorLine).toBe(2)
    expect(routeInputKey(DOWN, composer, completion, history, WIDE)).toBe('composer')
    expect(composer.value).toBe('first line\nsecond line\nthird line')
  })

  it('moves up through visually wrapped text, then falls into history at the top', () => {
    // One long line that chunks into three visual rows at this width.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'abcdefghijklmnopqrstuvwxyzabc' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('the previous command')

    const end = composer.position
    expect(routeInputKey(UP, composer, completion, history, NARROW)).toBe('vertical')
    // Wrapped rows are still the same buffer, so the text is untouched.
    expect(composer.value).toBe('abcdefghijklmnopqrstuvwxyzabc')
    expect(composer.position).toBeLessThan(end)

    expect(routeInputKey(UP, composer, completion, history, NARROW)).toBe('vertical')
    expect(routeInputKey(UP, composer, completion, history, NARROW)).toBe('history')
    expect(composer.value).toBe('the previous command')
  })

  it('keeps a wrapped recalled entry under history control, not composer movement', () => {
    const composer = new Composer()
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('older command')
    history.record('aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk')

    // From an empty draft the first up recalls the newest (wrapped) entry.
    expect(routeInputKey(UP, composer, completion, history, NARROW)).toBe('history')
    expect(composer.value).toBe('aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk')
    // It wraps onto multiple rows here, but while navigating history the next up
    // walks to the older entry rather than moving within the recalled text.
    expect(routeInputKey(UP, composer, completion, history, NARROW)).toBe('history')
    expect(composer.value).toBe('older command')
  })

  it('moves visually in a draft around a short middle line without losing the column', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'a-line-with-width\nshort\nanother-line-here' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('unused')

    // Cursor on the last line. Capture its column, then walk up over the short
    // line to the first.
    const before = composer.position
    const lastColumn = composer.cursorColumn
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('vertical')
    expect(composer.cursorLine).toBe(1)
    // Up again: the short line's end is below the preferred column, but the
    // preferred column is retained for the next step rather than clobbered.
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('vertical')
    expect(composer.cursorLine).toBe(0)
    expect(composer.cursorColumn).toBe(lastColumn)
    // No history entered; the buffer is intact.
    expect(composer.value).toBe('a-line-with-width\nshort\nanother-line-here')
    expect(before).toBeGreaterThan(composer.position)
  })

  it('resets the preferred column once a non-vertical key edits the buffer', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'long first line\nsecond\nthird long line' })
    const completion = completionFor(composer, [])
    const history = new InputHistory()
    history.record('unused')

    routeInputKey(UP, composer, completion, history, WIDE)
    expect(composer.cursorLine).toBe(1)
    // Typing ends the vertical sequence: the column preference is gone.
    composer.handle({ kind: 'text', text: 'x' })
    const afterEdit = composer.cursorColumn
    routeInputKey(UP, composer, completion, history, WIDE)
    // Up now aims at the new cursor column's row directly, and the preferred
    // column is recaptured from here, not from before the edit.
    expect(composer.cursorLine).toBe(0)
    expect(afterEdit).toBeGreaterThan(0)
  })
})

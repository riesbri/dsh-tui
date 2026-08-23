import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { historyLines, InputHistory } from '../src/history.ts'

/** Build the minimum event the history seeding reads, without the full envelope. */
function event(type: string, data: unknown): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

describe('InputHistory', () => {
  it('walks newest to oldest, then stops without wrapping', () => {
    const history = new InputHistory()
    history.record('fix the failing tests')
    history.record('explain this function')
    history.record('/refactoring ...')

    expect(history.previous('my unfinished draft')).toBe('/refactoring ...')
    expect(history.previous('my unfinished draft')).toBe('explain this function')
    expect(history.previous('my unfinished draft')).toBe('fix the failing tests')
    // There is nothing older than the first entry, and wrapping would loop back
    // to the newest line the moment the user wanted to leave the list.
    expect(history.previous('my unfinished draft')).toBe(undefined)
  })

  it('restores the unfinished draft past the newest entry', () => {
    const history = new InputHistory()
    history.record('fix the failing tests')
    history.record('explain this function')
    history.record('/refactoring ...')

    expect(history.previous('can you investigate the auth')).toBe('/refactoring ...')
    expect(history.previous('can you investigate the auth')).toBe('explain this function')
    expect(history.next()).toBe('/refactoring ...')
    expect(history.next()).toBe('can you investigate the auth')
    // Already back at the draft; a further step forward changes nothing.
    expect(history.next()).toBe(undefined)
  })

  it('restores an empty draft rather than deleting it', () => {
    const history = new InputHistory()
    history.record('first')

    expect(history.previous('')).toBe('first')
    expect(history.next()).toBe('')
  })

  it('does nothing while there are no entries', () => {
    const history = new InputHistory()

    expect(history.previous('draft')).toBe(undefined)
    expect(history.next()).toBe(undefined)
  })

  it('collapses consecutive duplicates to one entry', () => {
    const history = new InputHistory()
    history.record('run tests')
    history.record('run tests')
    history.record('run tests')

    expect(history.previous('draft')).toBe('run tests')
    expect(history.previous('draft')).toBe(undefined)
  })

  it('keeps a duplicate that is not adjacent', () => {
    const history = new InputHistory()
    history.record('run tests')
    history.record('run the build')
    history.record('run tests')

    expect(history.previous('draft')).toBe('run tests')
    expect(history.previous('draft')).toBe('run the build')
    expect(history.previous('draft')).toBe('run tests')
  })

  it('makes a line navigable as soon as it is recorded', () => {
    const history = new InputHistory()
    history.record('just submitted')

    expect(history.previous('draft')).toBe('just submitted')
  })

  it('re-submitting a recalled duplicate still returns to the draft', () => {
    const history = new InputHistory()
    history.record('a')
    history.record('b')
    expect(history.previous('my draft')).toBe('b')
    // Re-running the newest entry is a submission, so navigation restarts even
    // though the entry list did not grow.
    history.record('b')
    expect(history.previous('')).toBe('b')
    expect(history.next()).toBe('')
  })

  it('round-trips a multiline prompt unchanged', () => {
    const history = new InputHistory()
    history.record('first line\nsecond line')

    expect(history.previous('draft')).toBe('first line\nsecond line')
  })

  it('round-trips a multiline draft unchanged', () => {
    const history = new InputHistory()
    history.record('an earlier prompt')

    expect(history.previous('line one\nline two')).toBe('an earlier prompt')
    expect(history.next()).toBe('line one\nline two')
  })

  it('round-trips a CJK prompt unchanged', () => {
    const history = new InputHistory()
    history.record('请修复失败的测试')

    expect(history.previous('草稿')).toBe('请修复失败的测试')
    expect(history.next()).toBe('草稿')
  })

  it('keeps navigation after cursor-only changes and resets after edits', () => {
    const history = new InputHistory()
    history.record('first')
    history.record('second')

    expect(history.previous('saved draft')).toBe('second')
    expect(history.resetIfEdited('second', 'second')).toBe(false)
    expect(history.previous('second')).toBe('first')

    expect(history.resetIfEdited('first', 'first edited')).toBe(true)
    expect(history.next()).toBe(undefined)
    expect(history.previous('first edited')).toBe('second')
    expect(history.next()).toBe('first edited')
  })

  it('reset returns to the draft and forgets the saved one', () => {
    const history = new InputHistory()
    history.record('first')
    history.record('second')

    expect(history.previous('old draft')).toBe('second')
    history.reset()
    expect(history.next()).toBe(undefined)
    // The next step back captures the edited text, not the draft from before.
    expect(history.previous('new draft')).toBe('second')
    expect(history.next()).toBe('new draft')
  })
})

describe('historyLines()', () => {
  it('seeds direct human prompts in log order', () => {
    expect(historyLines([
      event('user/message', { content: [{ type: 'text', text: 'first prompt' }], source: { kind: 'user' } }),
      event('user/message', { content: [{ type: 'text', text: 'second prompt' }], source: { kind: 'user' } }),
    ])).toEqual(['first prompt', 'second prompt'])
  })

  it('skips synthetic injections the user never typed', () => {
    expect(historyLines([
      event('user/message', {
        content: [{ type: 'text', text: 'Additional instructions from docs/AGENTS.md' }],
        source: { kind: 'plugin', plugin: 'agent-instructions' },
      }),
      event('user/message', { content: [{ type: 'text', text: 'real prompt' }], source: { kind: 'user' } }),
    ])).toEqual(['real prompt'])
  })

  it('skips an empty human prompt', () => {
    expect(historyLines([
      event('user/message', { content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }),
    ])).toEqual([])
  })

  it('reconstructs a recorded slash command', () => {
    expect(historyLines([
      event('command/run', { commandId: 'c1', name: 'permission', args: ' read-only', source: { kind: 'user' } }),
    ])).toEqual(['/permission read-only'])
  })

  it('reconstructs a bare slash command with no arguments', () => {
    expect(historyLines([
      event('command/run', { commandId: 'c1', name: 'exit', args: '', source: { kind: 'user' } }),
    ])).toEqual(['/exit'])
  })

  it('skips a command that suppressed its input rather than faking a bare name', () => {
    expect(historyLines([
      event('command/run', { commandId: 'c1', name: 'goal', source: { kind: 'user' } }),
    ])).toEqual([])
  })

  it('skips a command issued by a merge-extended non-user source', () => {
    expect(historyLines([
      event('command/run', {
        commandId: 'c1',
        name: 'automated',
        args: ' value',
        source: { kind: 'plugin', plugin: 'automation' },
      }),
    ])).toEqual([])
  })

  it('interleaves prompts and commands in the order they were submitted', () => {
    expect(historyLines([
      event('user/message', { content: [{ type: 'text', text: 'a question' }], source: { kind: 'user' } }),
      event('command/run', { commandId: 'c1', name: 'model', args: ' deepseek-v4-pro', source: { kind: 'user' } }),
      event('user/message', { content: [{ type: 'text', text: 'another' }], source: { kind: 'user' } }),
    ])).toEqual(['a question', '/model deepseek-v4-pro', 'another'])
  })
})

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@riesbri/dsh-tui-renderer'
import { projectEvent } from '../src/transcript.ts'

/** Build the minimum event the projection reads, without the full envelope. */
function event(type: string, data: unknown): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

/** Project and strip styling, so assertions read as what a person would see. */
function project(type: string, data: unknown, columns = 80): string[] {
  return projectEvent(event(type, data), columns).map(stripAnsi)
}

describe('projectEvent()', () => {
  it('echoes a direct human prompt', () => {
    expect(project('user/message', {
      content: [{ type: 'text', text: 'run the tests' }],
      source: { kind: 'user' },
    })).toEqual(['', '─'.repeat(78), '› run the tests'])
  })

  it('drops a synthetic injection, which the user never typed', () => {
    // File-change notices, skill bodies, and nested AGENTS.md are model-visible
    // context; echoing them buries the conversation they are attached to.
    expect(project('user/message', {
      content: [{ type: 'text', text: 'Additional instructions from: docs/AGENTS.md' }],
      source: { kind: 'plugin', plugin: 'agent-instructions' },
    })).toEqual([])
  })

  it('projects no assistant output, which StreamBuffer owns on both paths', () => {
    // Splitting that ownership is what makes a reply print twice: the buffer has
    // already committed the streamed lines by the time this event arrives.
    expect(project('assistant/message', {
      message: { content: [{ type: 'text', text: 'first\nsecond' }] },
    })).toEqual([])
  })

  it('summarizes tool-call arguments as key=value pairs', () => {
    expect(project('tool/call', {
      name: 'read',
      arguments: '{"file_path":"src/index.ts","offset":10}',
    })).toEqual(['', '⏺ read file_path=src/index.ts offset=10'])
  })

  it('shows malformed model JSON as it actually arrived', () => {
    // The harness logs the argument string unparsed precisely so a bad call is
    // reconstructable; the projection must not pretend it parsed.
    expect(project('tool/call', { name: 'edit', arguments: '{"path":' }))
      .toEqual(['', '⏺ edit {"path":'])
  })

  it('reports a failed tool call by its code', () => {
    expect(project('tool/result', {
      message: { content: [] },
      error: { name: 'FsError', code: 'FS_NOT_FOUND' },
    })).toEqual(['  ⎿ FS_NOT_FOUND'])
  })

  it('reads the text inside the tool-result block, not the message content', () => {
    // A ToolResultMessage's content is one `tool-result` block whose OWN content
    // holds the model-facing blocks; reading a level too high renders it empty.
    expect(project('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'MIT' }] }] },
    })).toEqual(['  ⎿ MIT'])
  })

  it('elides a long tool result and says how much it hid', () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`).join('\n')
    const lines = project('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text }] }] },
    })
    expect(lines).toHaveLength(7)
    // The first result line carries the gutter; the rest align under it.
    expect(lines[0]).toBe('  ⎿ line 1')
    expect(lines[1]).toBe('    line 2')
    expect(lines[6]).toBe('    … 4 more lines')
  })

  it('neutralizes an escape sequence in tool output', () => {
    const lines = projectEvent(event('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '\u001b[2Jwiped' }] }] },
    }), 80)
    // The sequence must survive as visible text, not as a screen-clearing action.
    expect(lines.join('')).toContain('^[[2Jwiped')
  })

  it('reports a turn that ended in error', () => {
    expect(project('turn/end', {
      reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } },
    })).toEqual(['', '✗ RATE_LIMIT: slow down'])
  })

  it('reports an interrupted turn under the tag the harness actually emits', () => {
    // `TurnEndReasonMap` names this `aborted`. Testing for `canceled` meant a
    // ctrl-c that visibly stopped a reply left no mark explaining why.
    expect(project('turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } }))
      .toEqual(['', '· interrupted'])
  })

  it('says a reply was cut off by the output limit', () => {
    // Otherwise a truncated answer is indistinguishable from a finished one.
    expect(project('turn/end', { reason: { kind: 'max-tokens' } }))
      .toEqual(['', '· reply reached the output limit'])
  })

  it('says a turn was blocked before the model was called', () => {
    expect(project('turn/end', { reason: { kind: 'blocked' } }))
      .toEqual(['', '· blocked before the model was called'])
  })

  it('says nothing about a reason it has never seen, which a plugin may add', () => {
    expect(project('turn/end', { reason: { kind: 'some-plugin-reason' } })).toEqual([])
  })

  it('says nothing about a completed turn', () => {
    expect(project('turn/end', { reason: { kind: 'completed' } })).toEqual([])
  })

  it('ignores an event type it has never seen', () => {
    // SessionEventMap is merge-extensible: any plugin may add a type, and a
    // frontend that threw on one would break the moment a deployment mounted it.
    expect(project('some-plugin/custom', { anything: true })).toEqual([])
  })
})

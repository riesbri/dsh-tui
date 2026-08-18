import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@riesbri/dsh-tui-renderer'
import { commandLines, projectEvent } from '../src/transcript.ts'

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

  it('projects no tool output, which ToolCards owns so it can pair call to result', () => {
    // presentResult needs the call's arguments, which only a call-to-result
    // pairing has; a per-event projection cannot supply them.
    expect(project('tool/call', { callId: 'c1', name: 'read', arguments: '{}' })).toEqual([])
    expect(project('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }] },
    })).toEqual([])
  })

  it('projects no assistant output, which StreamBuffer owns on both paths', () => {
    // Splitting that ownership is what makes a reply print twice: the buffer has
    // already committed the streamed lines by the time this event arrives.
    expect(project('assistant/message', {
      message: { content: [{ type: 'text', text: 'first\nsecond' }] },
    })).toEqual([])
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

describe('commandLines()', () => {
  /** Project and strip styling, so assertions read as what a person would see. */
  const lines = (result: Parameters<typeof commandLines>[0], columns = 80): string[] =>
    commandLines(result, columns).map(stripAnsi)

  it('reports what a command said it did', () => {
    // A command runs without a model turn, so its own text is the ONLY thing that
    // says it happened: there is no reply to read and no card to look at.
    expect(lines({ kind: 'success', text: 'current preset workspace-write' }))
      .toEqual(['\u00b7 current preset workspace-write'])
  })

  it('reports a failure, which must never be silent', () => {
    // A command that fails quietly is indistinguishable from one that is broken —
    // which is exactly how a `/compact` refusal read before this existed.
    expect(lines({ kind: 'error', text: 'Compaction is unavailable' }))
      .toEqual(['\u2717 Compaction is unavailable'])
  })

  it('says nothing for a success with nothing to report', () => {
    expect(lines({ kind: 'success' })).toEqual([])
    expect(lines({ kind: 'success', text: '   ' })).toEqual([])
  })

  it('speaks even when a domain event owns the richer presentation', () => {
    // `sourceEventSeq` defers to an event this frontend does not project, so
    // honouring it would keep the command invisible — the bug, not the fix.
    expect(lines({ kind: 'success', text: 'Goal created', sourceEventSeq: 42 }))
      .toEqual(['\u00b7 Goal created'])
  })

  it('indents a multi-line answer under its mark', () => {
    // `/goal` prints usage and `/permission` prints a list, so this is the normal
    // case rather than an edge one.
    expect(lines({ kind: 'success', text: 'No goal is currently set.\nUsage: /goal [<objective>|clear]' }))
      .toEqual(['\u00b7 No goal is currently set.', '  Usage: /goal [<objective>|clear]'])
  })

  it('keeps every row of a wrapped answer readable on its own', () => {
    // A style applied to multi-line text puts its reset on the last line only, so
    // the rows between would carry an unterminated colour into the live region.
    const rows = commandLines({ kind: 'error', text: 'a'.repeat(40) }, 24)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.startsWith('\u001b[')).toBe(true)
      expect(row.endsWith('\u001b[0m')).toBe(true)
    }
  })

  it('shows a control sequence rather than obeying it', () => {
    // Command text is as untrusted as anything else reaching the terminal.
    expect(lines({ kind: 'error', text: 'boom \u001b[2J' })).toEqual(['\u2717 boom ^[[2J'])
  })
})

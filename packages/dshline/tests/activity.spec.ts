import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallKind, ToolCallView } from '@deepseek-ai/dsh-tools'
import {
  modelPhaseAfter,
  primaryActivity,
  toolActivity,
} from '../src/activity.ts'
import type { ModelPhase } from '../src/activity.ts'

/**
 * A minimal event for the pure reducer; only the discriminant under test matters.
 * @param type - event type to expose.
 * @param data - payload read by that event branch.
 * @returns a SessionEvent-shaped test input.
 */
function event(type: string, data: unknown = {}): SessionEvent {
  return { type, data, seq: 1, time: 1 } as unknown as SessionEvent
}

/**
 * One streamed assistant delta.
 * @param type - stream chunk type.
 * @param text - delta content.
 * @returns an assistant/chunk event.
 */
function delta(type: string, text: string): SessionEvent {
  return event('assistant/chunk', { turn: 1, step: 1, chunk: { type, index: 0, text } })
}

describe('modelPhaseAfter()', () => {
  it('starts fresh at waiting and resets on model lifecycle boundaries', () => {
    let phase: ModelPhase = 'waiting'
    for (const type of ['turn/start', 'step/start', 'step/end', 'assistant/message', 'turn/end']) {
      phase = modelPhaseAfter('responding', event(type))
      expect(phase, type).toBe('waiting')
    }
  })

  it('moves from reasoning to text and ends responding', () => {
    const thinking = modelPhaseAfter('waiting', delta('reasoning-delta', 'thought'))
    expect(thinking).toBe('thinking')
    expect(modelPhaseAfter(thinking, delta('text-delta', 'answer'))).toBe('responding')
  })

  it('ignores empty deltas but treats delivered whitespace as stream activity', () => {
    expect(modelPhaseAfter('responding', delta('reasoning-delta', ''))).toBe('responding')
    expect(modelPhaseAfter('thinking', delta('text-delta', ''))).toBe('thinking')
    expect(modelPhaseAfter('waiting', delta('reasoning-delta', ' '))).toBe('thinking')
    expect(modelPhaseAfter('waiting', delta('text-delta', '\n'))).toBe('responding')
  })

  it('treats a reasoning or text block start as the earliest phase signal', () => {
    // The block-opening chunk arrives before the first delta of its block, so it
    // is the earliest truthful "the model has begun thinking/responding" signal.
    expect(modelPhaseAfter('waiting', event('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }))).toBe('thinking')
    expect(modelPhaseAfter('waiting', event('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }))).toBe('responding')
    // A later block start overrides a prior phase: the model moved on.
    expect(modelPhaseAfter('thinking', event('assistant/chunk', { chunk: { type: 'block-start', index: 1, blockType: 'text' } }))).toBe('responding')
  })

  it('preserves phase for non-reasoning/text block starts and other non-delta chunks', () => {
    // Tool-call blocks are tool requests, not model output; image blocks and any
    // future block type carry no phase claim.
    for (const blockType of ['tool-call', 'image', 'future-block' as never]) {
      expect(
        modelPhaseAfter('responding', event('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType } })) as never,
        String(blockType),
      ).toBe('responding')
    }
    const chunks = ['unknown-chunk', 'tool-call-delta', 'block-end', 'usage', 'finish']
    expect(modelPhaseAfter('thinking', event('future/event'))).toBe('thinking')
    for (const type of chunks) {
      expect(modelPhaseAfter('responding', delta(type, 'ignored')), type).toBe('responding')
    }
  })

  it('preserves phase across tool and command lifecycle events', () => {
    for (const type of ['tool/call', 'tool/result', 'command/run']) {
      expect(modelPhaseAfter('thinking', event(type)), type).toBe('thinking')
    }
  })
})

describe('toolActivity()', () => {
  it.each<[ToolCallKind, ReturnType<typeof toolActivity>]>([
    ['read', 'reading'],
    ['search', 'searching'],
    ['fetch', 'fetching'],
    ['edit', 'editing'],
    ['delete', 'editing'],
    ['move', 'editing'],
    ['execute', 'running'],
    ['other', 'working'],
  ])('maps generic %s calls to %s', (kind, expected) => {
    expect(toolActivity({ card: 'generic', title: 'Any title', kind })).toBe(expected)
  })

  it('uses only presentation semantics, never a tool name', () => {
    expect(toolActivity({ card: 'generic', title: 'semantic_code_lookup', kind: 'search' })).toBe('searching')
  })

  it('maps terminal and diff cards before considering generic kinds', () => {
    expect(toolActivity({ card: 'terminal', title: 'npm test' })).toBe('running')
    expect(toolActivity({ card: 'diff', title: 'Edit f', diffs: [] })).toBe('editing')
  })

  it('falls back conservatively for absent and future presentation vocabulary', () => {
    expect(toolActivity(undefined)).toBe('working')
    expect(toolActivity({ card: 'generic', title: 'No kind' })).toBe('working')
    expect(toolActivity({ card: 'generic', title: 'Future', kind: 'teleport' as ToolCallKind })).toBe('working')
    expect(toolActivity({ card: 'future-card', title: 'Future' } as unknown as ToolCallView)).toBe('working')
  })
})

describe('primaryActivity()', () => {
  it('uses the model phase with no tool and lets a pending tool outrank it', () => {
    expect(primaryActivity('waiting', undefined)).toBe('waiting')
    expect(primaryActivity('thinking', 'reading')).toBe('reading')
  })
})

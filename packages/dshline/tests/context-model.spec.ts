/**
 * Tests for the context readings: what the cheap projections say, and what the
 * expensive per-node survey resolves them into.
 *
 * The real Harness meter is exercised in `capability/token-meter.probe.spec.ts`;
 * this file is the edge-case sheet — absent capabilities, absent figures, tie
 * ordering, a tool result whose call is NOT its neighbour, wide characters —
 * which needs constructed logs rather than a live agent.
 */

import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import {
  contextPressureTokens,
  contextPreview,
  contextReading,
  ContextSurveyor,
  resolveEntries,
} from '../src/context/model.ts'

/** One projection cut carrying whichever units a case needs. */
function cut(values: ProjectionSnapshot['values']): ProjectionSnapshot {
  return { asOfSeq: 0, values }
}

/** A session double: the two members the model actually reads. */
function sessionOf(events: readonly (SessionEvent | undefined)[], replaceGeneration = 0): Session {
  return {
    events,
    surface: { nodes: events.map((_, index) => index), replaceGeneration },
  } as unknown as Session
}

/** A measurement double, with node prices in surface order. */
function measurement(nodes: readonly { seq: number; tokens: number }[]): TokenMeasurement {
  return {
    logRevision: nodes.length,
    baseline: { kind: 'none', tokens: 0 },
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: nodes.reduce((sum, node) => sum + node.tokens, 0),
    nodes,
  } as unknown as TokenMeasurement
}

/** A user-role surface event. */
function userMessage(text: string, source: unknown = { kind: 'user' }): SessionEvent {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source },
  } as unknown as SessionEvent
}

/** A tool call, which is not itself a surface node. */
function toolCall(callId: string, name: string, args = '{}'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 0,
    time: 1,
    data: { turn: 1, step: 1, callId, name, arguments: args },
  } as unknown as SessionEvent
}

/** A tool result carrying its call id, optionally as a replacement. */
function toolResult(callId: string, text: string, replaced = false): SessionEvent {
  return {
    type: 'tool/result',
    seq: 0,
    time: 1,
    surfaceOp: replaced ? { op: 'replace', start: 0, end: 0 } : 'append',
    data: {
      turn: 3,
      step: 2,
      message: {
        id: 'r', role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
        source: { kind: 'tool', callId },
      },
    },
  } as unknown as SessionEvent
}

/** An assistant reply. */
function assistantMessage(text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: {
      turn: 7, step: 4,
      message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    },
  } as unknown as SessionEvent
}

describe('the cheap context reading', () => {
  it('reports no projections at all when the profile mounts no registry', () => {
    const reading = contextReading(undefined)
    expect(reading).toEqual({
      projections: false, metered: false, occupancy: undefined, composition: undefined,
    })
    expect(contextPressureTokens(reading)).toBeUndefined()
  })

  it('separates an absent registry from an unregistered token meter', () => {
    const reading = contextReading(cut({}))
    expect(reading.projections).toBe(true)
    expect(reading.metered).toBe(false)
    expect(contextPressureTokens(reading)).toBeUndefined()
  })

  it('reports no occupancy until a provider has reported a prompt size', () => {
    // Registered, with a capacity, and still no numerator: the case that must
    // never become a fabricated zero or a 0% bar.
    const reading = contextReading(cut({ contextPressure: { contextWindow: 1_000_000 } }))
    expect(reading.metered).toBe(true)
    expect(reading.occupancy).toBeUndefined()
  })

  it('calls the figure anchored only while it is still the provider’s bare sample', () => {
    const anchored = contextReading(cut({
      contextPressure: { pressureTokens: 1000, projectedTokens: 1000, contextWindow: 4000 },
    }))
    expect(anchored.occupancy).toEqual({
      tokens: 1000, sampledTokens: 1000, anchored: true, capacity: 4000,
    })

    // The surface moved since the sample, so the figure carries an estimated
    // delta and must not read as an exact provider count.
    const estimated = contextReading(cut({
      contextPressure: { pressureTokens: 1000, projectedTokens: 1420, contextWindow: 4000 },
    }))
    expect(estimated.occupancy?.anchored).toBe(false)
    expect(contextPressureTokens(estimated)).toBe(1420)
  })

  it('keeps an unknown capacity unknown', () => {
    const reading = contextReading(cut({
      contextPressure: { pressureTokens: 900, projectedTokens: 900 },
    }))
    expect(reading.occupancy?.capacity).toBeUndefined()
  })

  it('totals composition from its own three figures, never from the occupancy figure', () => {
    const reading = contextReading(cut({
      contextPressure: { pressureTokens: 5000, projectedTokens: 5000, contextWindow: 100_000 },
      contextBreakdown: { systemTokens: 12, toolsTokens: 48, messageTokens: 116 },
    }))
    // Deliberately not 5000: the composition is the meter's fixed estimator and
    // the occupancy is provider-anchored, and upstream states they disagree.
    expect(reading.composition).toEqual({ system: 12, tools: 48, messages: 116, total: 176 })
  })

  it('reports a fresh session’s all-zero composition as present and empty', () => {
    const reading = contextReading(cut({
      contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
    }))
    expect(reading.metered).toBe(true)
    expect(reading.composition?.total).toBe(0)
  })
})

describe('resolving the largest context entries', () => {
  it('orders by price, breaks ties by log order, and bounds the result', () => {
    const session = sessionOf([
      userMessage('one'), userMessage('two'), userMessage('three'), userMessage('four'),
    ])
    const entries = resolveEntries(
      session,
      measurement([{ seq: 0, tokens: 50 }, { seq: 1, tokens: 90 }, { seq: 2, tokens: 50 }, { seq: 3, tokens: 10 }]),
      3,
    )
    expect(entries.map(entry => entry.seq)).toEqual([1, 0, 2])
    // Equal sizes keep one stable order across paints rather than swapping
    // under the cursor.
    expect(entries[1]?.tokens).toBe(entries[2]?.tokens)
    // Position is where the node sits in the model's history, not its rank.
    expect(entries[0]?.position).toBe(2)
  })

  it('divides shares by the measured surface total, and survives a zero total', () => {
    const session = sessionOf([userMessage('a'), userMessage('b')])
    const entries = resolveEntries(session, measurement([{ seq: 0, tokens: 75 }, { seq: 1, tokens: 25 }]), 8)
    expect(entries[0]?.share).toBeCloseTo(0.75)
    expect(entries[1]?.share).toBeCloseTo(0.25)

    const empty = resolveEntries(session, measurement([{ seq: 0, tokens: 0 }]), 8)
    expect(empty[0]?.share).toBe(0)
  })

  it('pairs a tool result with its own call by id, never with its neighbour', () => {
    // A parallel batch: two calls dispatched together, results returning in the
    // other order. The event BEFORE each result is the wrong call, which is
    // exactly why the pairing is by id.
    const session = sessionOf([
      toolCall('call-a', 'run_shell_command'),
      toolCall('call-b', 'read_file'),
      toolResult('call-b', 'file contents'),
      toolResult('call-a', 'test output'),
    ])
    const entries = resolveEntries(
      session,
      measurement([{ seq: 2, tokens: 10 }, { seq: 3, tokens: 20 }]),
      8,
    )
    expect(entries[0]).toMatchObject({ seq: 3, kind: 'tool-result', tool: 'run_shell_command', turn: 3, step: 2 })
    expect(entries[1]).toMatchObject({ seq: 2, kind: 'tool-result', tool: 'read_file' })
  })

  it('leaves a tool name absent rather than guessing when no call carries the id', () => {
    const session = sessionOf([toolResult('call-missing', 'orphan')])
    const entries = resolveEntries(session, measurement([{ seq: 0, tokens: 5 }]), 8)
    expect(entries[0]?.kind).toBe('tool-result')
    expect(entries[0]?.tool).toBeUndefined()
  })

  it('names each kind of surface node off an authoritative fact', () => {
    const session = sessionOf([
      userMessage('typed by a human'),
      userMessage('nested AGENTS.md', { kind: 'plugin', plugin: 'agent-instructions', form: 'instructions' }),
      userMessage('the story so far', { kind: 'plugin', plugin: 'compact' }),
      assistantMessage('a reply'),
      toolResult('call-x', 'output', true),
      { type: 'plugin/whatever', seq: 5, time: 1, data: {} } as unknown as SessionEvent,
    ], 1)
    // Node 2 is the compaction summary: a user-role node that REPLACED a range.
    const events = [...session.events]
    events[2] = {
      ...(events[2] as unknown as Record<string, unknown>),
      surfaceOp: { op: 'replace', start: 0, end: 1 },
    } as unknown as SessionEvent
    const replaced = sessionOf(events, 1)
    const entries = resolveEntries(
      replaced,
      measurement([0, 1, 2, 3, 4, 5].map(seq => ({ seq, tokens: 10 - seq }))),
      8,
    )
    const bySeq = new Map(entries.map(entry => [entry.seq, entry]))
    expect(bySeq.get(0)?.kind).toBe('user')
    expect(bySeq.get(1)).toMatchObject({ kind: 'context', form: 'instructions' })
    expect(bySeq.get(2)).toMatchObject({ kind: 'summary', replaced: true })
    expect(bySeq.get(3)).toMatchObject({ kind: 'assistant', turn: 7, step: 4 })
    expect(bySeq.get(4)).toMatchObject({ kind: 'tool-result', replaced: true })
    // A merge-extensible event type this frontend has never seen is reported as
    // an entry rather than dropped or guessed at.
    expect(bySeq.get(5)?.kind).toBe('other')
  })

  it('keeps a priced node whose event is not in the loaded window', () => {
    const session = sessionOf([undefined, userMessage('present')])
    const entries = resolveEntries(session, measurement([{ seq: 0, tokens: 40 }, { seq: 1, tokens: 4 }]), 8)
    expect(entries[0]).toMatchObject({ seq: 0, kind: 'other', tokens: 40 })
  })
})

describe('one entry’s bounded preview', () => {
  it('reads the content the model carries, through the shared derivation', () => {
    const session = sessionOf([userMessage('what the model sees')])
    expect(contextPreview(session, 0)).toEqual({
      text: 'what the model sees', truncated: false, available: true,
    })
  })

  it('answers “why is this large” for a node whose weight is not prose', () => {
    const session = sessionOf([toolResult('call-a', 'PASS one\nPASS two')])
    expect(contextPreview(session, 0).text).toBe('PASS one\nPASS two')

    const call = sessionOf([{
      type: 'assistant/message',
      seq: 0, time: 1, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'a', role: 'assistant', source: { kind: 'model' },
          content: [
            { type: 'tool-call', name: 'write_file', arguments: '{"path":"a.ts"}' },
            { type: 'image', ref: 'x' },
          ],
        },
      },
    } as unknown as SessionEvent])
    const preview = contextPreview(call, 0).text
    expect(preview).toContain('write_file {"path":"a.ts"}')
    // A block type this frontend has no text for is NAMED, so a large image
    // node does not preview as a blank box.
    expect(preview).toContain('[image]')
  })

  it('bounds a huge entry and says it was cut', () => {
    const session = sessionOf([userMessage('x'.repeat(20_000))])
    const preview = contextPreview(session, 0)
    expect(preview.truncated).toBe(true)
    expect(preview.text.length).toBeLessThan(20_000)
  })

  it('preserves wide characters and returns control bytes unescaped for the caller', () => {
    // The model returns raw text on purpose: escaping belongs with painting, so
    // that colour is never applied before text is made safe.
    const session = sessionOf([userMessage('上下文[31m红')])
    expect(contextPreview(session, 0).text).toBe('上下文[31m红')
  })

  it('reports an entry with no derivable message as carrying no content', () => {
    const empty = sessionOf([{
      type: 'assistant/message',
      seq: 0, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [], source: { kind: 'model' } } },
    } as unknown as SessionEvent])
    expect(contextPreview(empty, 0).available).toBe(false)
    expect(contextPreview(sessionOf([]), 4).available).toBe(false)
  })
})

describe('the context surveyor', () => {
  it('reports honestly when no meter is mounted', () => {
    const surveyor = new ContextSurveyor({ meter: () => undefined, session: sessionOf([]), limit: 8 })
    expect(surveyor.read()).toEqual({ available: false, surfaceTokens: 0, nodes: 0, entries: [] })
  })

  it('reports honestly when the meter refuses, instead of taking the live region down', () => {
    const surveyor = new ContextSurveyor({
      meter: () => ({ measure: () => { throw new Error('malformed log') } }),
      session: sessionOf([userMessage('a')]),
      limit: 8,
    })
    expect(surveyor.read().available).toBe(false)
  })

  it('remeasures when the surface is replaced, not only when it grows', () => {
    // A compaction leaves the node COUNT lower and bumps Harness's own
    // replacement generation; keying on length alone would serve a stale survey.
    let generation = 0
    let measured = 0
    const events = [userMessage('a'), userMessage('b')]
    const session = {
      events,
      surface: { nodes: [0], get replaceGeneration() { return generation } },
    } as unknown as Session
    const surveyor = new ContextSurveyor({
      meter: () => ({
        measure: () => {
          measured += 1
          return measurement([{ seq: 0, tokens: 1 }])
        },
      }),
      session,
      limit: 8,
    })
    surveyor.read()
    surveyor.read()
    expect(measured).toBe(1)
    generation = 1
    surveyor.read()
    expect(measured).toBe(2)
  })

  it('drops its cache when asked, without a timer', () => {
    let measured = 0
    const surveyor = new ContextSurveyor({
      meter: () => ({ measure: () => { measured += 1; return measurement([]) } }),
      session: sessionOf([]),
      limit: 8,
    })
    surveyor.read()
    surveyor.invalidate()
    surveyor.read()
    expect(measured).toBe(2)
  })
})

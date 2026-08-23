import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { TurnProfile, TurnSpan } from '../src/profile.ts'
import { profileLines, TurnProfiler } from '../src/profile.ts'
import { chromeWidth } from '../src/views.ts'

/**
 * One log event, with only the fields the profiler reads.
 * @param time - the envelope's timestamp.
 * @param type - the event type.
 * @param data - the event's payload.
 * @returns the event.
 */
function event(time: number, type: string, data: unknown): SessionEvent {
  return { time, type, data } as unknown as SessionEvent
}

/** A streamed delta of one kind, at one moment. */
const delta = (time: number, step: number, type: string): SessionEvent =>
  event(time, 'assistant/chunk', { turn: 1, step, chunk: { type, text: 'x' } })

/** A tool call opening, and the result that closes it. */
const call = (time: number, callId: string, name: string): SessionEvent =>
  event(time, 'tool/call', { turn: 1, step: 0, callId, name, arguments: '{}' })
const result = (time: number, callId: string): SessionEvent =>
  event(time, 'tool/result', { turn: 1, step: 0, message: { content: [{ toolCallId: callId }] } })

/** The event that closes a turn. */
const ends = (time: number, turn = 1): SessionEvent =>
  event(time, 'turn/end', { turn, reason: 'complete' })

/**
 * Feed a whole turn through a fresh profiler.
 * @param events - the events, in order.
 * @returns the profile the closing `turn/end` produced, if any.
 */
function profile(events: readonly SessionEvent[]): TurnProfile | undefined {
  const profiler = new TurnProfiler()
  let finished: TurnProfile | undefined
  for (const one of events) finished = profiler.observe(one) ?? finished
  return finished
}

/** The spans of a profile as a plain label-to-milliseconds map. */
function spans(finished: TurnProfile | undefined): Record<string, number> {
  return Object.fromEntries((finished?.spans ?? []).map(span => [span.label, span.ms]))
}

describe('TurnProfiler', () => {
  it('measures the turn against timestamps the log already carries', () => {
    const finished = profile([
      event(1_000, 'turn/start', { turn: 14 }),
      delta(2_000, 0, 'text-delta'),
      delta(4_000, 0, 'text-delta'),
      ends(43_800, 14),
    ])
    expect(finished?.turn).toBe(14)
    expect(finished?.totalMs).toBe(42_800)
  })

  it('pairs a tool result with its own call, not with the newest one', () => {
    // Several calls can be open at once, so the newest result does not belong to
    // the newest call. Paired by order rather than by id, `slow` would be charged
    // the fast call's two seconds and `fast` the slow one's ten.
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'slow'),
      call(1_000, 'b', 'fast'),
      result(3_000, 'b'),
      result(10_000, 'a'),
      ends(11_000),
    ])
    expect(spans(finished)).toEqual({ slow: 10_000, fast: 2_000 })
  })

  it('counts two overlapping calls in full, rather than dividing the turn between them', () => {
    // These are spans, not shares. Both tools really did run for ten seconds, and
    // their sum exceeding the turn is the information, not an error.
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'bash'),
      call(0, 'b', 'grep'),
      result(10_000, 'a'),
      result(10_000, 'b'),
      ends(10_000),
    ])
    expect(spans(finished)).toEqual({ bash: 10_000, grep: 10_000 })
    expect(finished?.totalMs).toBe(10_000)
  })

  it('sums repeated calls to one tool under its name', () => {
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'bash'),
      result(2_000, 'a'),
      call(5_000, 'b', 'bash'),
      result(6_000, 'b'),
      ends(7_000),
    ])
    expect(spans(finished)).toEqual({ bash: 3_000 })
  })

  it('measures reasoning and answering separately, and adds up the steps', () => {
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      delta(1_000, 0, 'reasoning-delta'),
      delta(9_000, 0, 'reasoning-delta'),
      delta(9_500, 0, 'text-delta'),
      delta(11_500, 0, 'text-delta'),
      delta(12_000, 1, 'reasoning-delta'),
      delta(22_000, 1, 'reasoning-delta'),
      ends(23_000),
    ])
    expect(spans(finished)).toEqual({ reasoning: 18_000, output: 2_000 })
  })

  it('charts nothing for a turn it did not see begin', () => {
    // Enabling the profiler mid-turn would otherwise report the time since the
    // toggle as though it were the time the turn took.
    const finished = profile([delta(1_000, 0, 'reasoning-delta'), ends(9_000)])
    expect(finished).toBeUndefined()
  })

  it('starts each turn from nothing', () => {
    const profiler = new TurnProfiler()
    profiler.observe(event(0, 'turn/start', { turn: 1 }))
    profiler.observe(call(0, 'a', 'bash'))
    profiler.observe(result(5_000, 'a'))
    profiler.observe(ends(5_000))
    profiler.observe(event(6_000, 'turn/start', { turn: 2 }))
    profiler.observe(delta(6_000, 0, 'text-delta'))
    profiler.observe(delta(8_000, 0, 'text-delta'))
    expect(spans(profiler.observe(ends(9_000, 2)))).toEqual({ output: 2_000 })
  })

  it('drops a span that finished inside one timestamp', () => {
    // A bar beside `0.0s` measures nothing a reader can act on.
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'read'),
      result(0, 'a'),
      delta(0, 0, 'text-delta'),
      delta(3_000, 0, 'text-delta'),
      ends(3_000),
    ])
    expect(spans(finished)).toEqual({ output: 3_000 })
  })
})

describe('profileLines()', () => {
  /**
   * Render a profile and strip its styling.
   * @param spans - the spans to chart, longest first.
   * @param columns - the terminal width.
   * @returns the lines a person would see.
   */
  function chart(spans: readonly TurnSpan[], columns = 100): string[] {
    return profileLines({ turn: 14, totalMs: 42_800, spans }, columns).map(stripAnsi)
  }

  /** Cells in a row's bar. */
  const cells = (line: string): number => (/█+/u.exec(line) ?? [''])[0].length

  it('heads the chart with the turn and its wall clock', () => {
    expect(chart([{ label: 'bash', ms: 16_400 }])[0]).toContain('turn 14 · 42.8s')
  })

  it('scales the bars against the longest span, not against the turn', () => {
    // The spans overlap, so they do not partition the turn, and a bar measured
    // against the total would be a picture asserting a partition that is not
    // there. Against this turn's 42.8s these two would each be well under full
    // while together accounting for longer than the turn lasted.
    const lines = chart([{ label: 'bash', ms: 30_000 }, { label: 'edit', ms: 15_000 }])
    expect(cells(lines[1] ?? '')).toBeGreaterThan(0)
    expect(cells(lines[2] ?? '')).toBeCloseTo(cells(lines[1] ?? '') / 2, 0)
  })

  it('fills the longest bar further than any other', () => {
    const lines = chart([{ label: 'bash', ms: 30_000 }, { label: 'edit', ms: 1 }])
    expect(cells(lines[1] ?? '')).toBeGreaterThan(cells(lines[2] ?? ''))
  })

  it('rounds a short span up to a visible bar', () => {
    expect(chart([{ label: 'bash', ms: 100_000 }, { label: 'read', ms: 10 }])[2]).toContain('█')
  })

  it('reports tenths, which whole seconds would collapse', () => {
    const lines = chart([{ label: 'bash', ms: 3_900 }, { label: 'edit', ms: 3_100 }]).join('\n')
    expect(lines).toContain('3.9s')
    expect(lines).toContain('3.1s')
  })

  it('displays an escape sequence in a tool name rather than obeying it', () => {
    // Tool names come from the model, so they are untrusted like any other model
    // output, and are made safe before anything measures or colors them.
    expect(chart([{ label: '[31mevil', ms: 1_000 }]).join('\n')).toContain('^[[31mevil')
  })

  it('fits the chrome at any width', () => {
    for (const columns of [10, 14, 20, 24, 40, 60, 80, 100, 200]) {
      const lines = chart([
        { label: 'reasoning', ms: 18_200 },
        { label: 'a-very-long-tool-name', ms: 16_400 },
        { label: 'edit', ms: 3_100 },
      ], columns)
      for (const line of lines) {
        expect(displayWidth(line), `${String(columns)} columns: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(chromeWidth(columns))
      }
    }
  })

  it('gives up the bars rather than drawing a useless one when the width runs out', () => {
    // One cell beside every row would say every span was the same length, which
    // is the one thing the chart exists to deny.
    const lines = chart([{ label: 'reasoning', ms: 18_200 }, { label: 'edit', ms: 100 }], 24).join('\n')
    expect(lines).not.toContain('█')
    expect(lines).toContain('18.2s')
  })

  it('draws nothing when there was nothing to measure', () => {
    expect(profileLines({ turn: 1, totalMs: 900, spans: [] }, 100)).toEqual([])
  })
})

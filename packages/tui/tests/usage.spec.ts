import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { formatUsage, parsePricing, SessionUsage } from '../src/usage.ts'

/** The route every test prices against unless it says otherwise. */
const ROUTE = 'deepseek-official/deepseek-v4-flash'

/** A table with one priced route, at rates chosen to make the arithmetic legible. */
const RATES = parsePricing({
  [ROUTE]: { input: 1, cachedInput: 0.1, output: 2 },
})

/**
 * One adapter accounting record, with the optional buckets left off by default.
 * @param usage - the buckets this record reports.
 * @returns the record.
 */
function usage(usage: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, ...usage }
}

describe('parsePricing()', () => {
  it('keeps an entry that names both required rates', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2 } })
    expect(table.get('a/b')).toEqual({ input: 1, output: 2 })
  })

  it('carries the optional cache rates through', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2, cachedInput: 0.1, cachedWrite: 1.25 } })
    expect(table.get('a/b')).toEqual({ input: 1, output: 2, cachedInput: 0.1, cachedWrite: 1.25 })
  })

  it('drops an entry priced on only one side', () => {
    // Half a table entry prices half the traffic and silently understates the
    // rest, which is worse than reporting no price at all.
    expect(parsePricing({ 'a/b': { input: 1 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { output: 2 } }).size).toBe(0)
  })

  it('drops a rate that cannot be multiplied by a token count', () => {
    expect(parsePricing({ 'a/b': { input: -1, output: 2 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { input: Number.NaN, output: 2 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { input: '1', output: 2 } }).size).toBe(0)
  })

  it('ignores an optional rate it cannot use, keeping the entry', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2, cachedInput: -3 } })
    expect(table.get('a/b')).toEqual({ input: 1, output: 2 })
  })

  it('survives configuration that is not a table at all', () => {
    // A typo in a machine-local config file must not be why a terminal refuses
    // to start, so every one of these is a table with nothing in it.
    expect(parsePricing(undefined).size).toBe(0)
    expect(parsePricing(null).size).toBe(0)
    expect(parsePricing('deepseek').size).toBe(0)
    expect(parsePricing({ 'a/b': null }).size).toBe(0)
  })
})

describe('SessionUsage', () => {
  it('counts every prompt token as input, cached or not', () => {
    const session = new SessionUsage(RATES)
    session.observe(
      usage({ inputTokens: 1_000, cacheReadTokens: 7_000, cacheWriteTokens: 800, outputTokens: 1_600 }),
      'deepseek-official',
      'deepseek-v4-flash',
    )
    expect(session.reading.inputTokens).toBe(8_800)
    expect(session.reading.outputTokens).toBe(1_600)
  })

  it('does not count reasoning tokens a second time', () => {
    // The adapter reports reasoning INSIDE the output total. Adding it again
    // inflates output on exactly the models people turn reasoning on for.
    const session = new SessionUsage(RATES)
    session.observe(usage({ outputTokens: 1_600, reasoningTokens: 1_200 }), 'deepseek-official', 'deepseek-v4-flash')
    expect(session.reading.outputTokens).toBe(1_600)
  })

  it('prices a cache read at the cache rate, not the uncached one', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ cacheReadTokens: 1_000_000 }), 'deepseek-official', 'deepseek-v4-flash')
    expect(session.reading.costUsd).toBeCloseTo(0.1, 10)
  })

  it('prices a cache write at the input rate when the route names no write rate', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ cacheWriteTokens: 1_000_000 }), 'deepseek-official', 'deepseek-v4-flash')
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
  })

  it('adds the buckets up at their own rates', () => {
    const session = new SessionUsage(RATES)
    session.observe(
      usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
      'deepseek-official',
      'deepseek-v4-flash',
    )
    expect(session.reading.costUsd).toBeCloseTo(3.1, 10)
  })

  it('prices each message at the model that produced it', () => {
    // A `/model` switch mid-session must not reprice everything before it at
    // whichever route the session happens to end on.
    const table = parsePricing({
      'deepseek-official/cheap': { input: 1, output: 1 },
      'deepseek-official/dear': { input: 10, output: 10 },
    })
    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), 'deepseek-official', 'cheap')
    session.observe(usage({ inputTokens: 1_000_000 }), 'deepseek-official', 'dear')
    expect(session.reading.costUsd).toBeCloseTo(11, 10)
  })

  it('reports no cost at all for a route with no rates', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ inputTokens: 8_800, outputTokens: 1_600 }), 'other', 'mystery')
    expect(session.reading.costUsd).toBeUndefined()
    expect(session.reading.partial).toBe(false)
    expect(session.reading.inputTokens).toBe(8_800)
  })

  it('marks a total that is only a floor', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ inputTokens: 1_000_000 }), 'deepseek-official', 'deepseek-v4-flash')
    session.observe(usage({ inputTokens: 1_000_000 }), 'other', 'mystery')
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
    expect(session.reading.partial).toBe(true)
  })
})

describe('formatUsage()', () => {
  it('reports both directions compactly', () => {
    expect(formatUsage({ inputTokens: 8_800, outputTokens: 1_600, costUsd: 0.018, partial: false }))
      .toBe('↑8.8k ↓1.6k $0.018')
  })

  it('omits the money when nothing could be priced', () => {
    // The same rule the context bar follows: nothing is drawn before there is
    // something true to draw, and `$0.00` is not it.
    expect(formatUsage({ inputTokens: 8_800, outputTokens: 1_600, costUsd: undefined, partial: false }))
      .toBe('↑8.8k ↓1.6k')
  })

  it('marks a partial total so it does not read as the whole bill', () => {
    expect(formatUsage({ inputTokens: 8_800, outputTokens: 1_600, costUsd: 0.018, partial: true }))
      .toBe('↑8.8k ↓1.6k ~$0.018')
  })

  it('keeps enough digits to be non-zero early in a session', () => {
    // A meter reading `$0.00` for the first twenty minutes is one nobody looks at.
    const reading = (costUsd: number): string =>
      formatUsage({ inputTokens: 0, outputTokens: 0, costUsd, partial: false })
    expect(reading(0.0018)).toContain('$0.0018')
    expect(reading(0.018)).toContain('$0.018')
    expect(reading(1.238)).toContain('$1.24')
  })
})

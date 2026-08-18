import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { PeakWindow } from '../src/usage.ts'
import {
  formatUsage,
  isPeak,
  parsePeakWindows,
  parsePricing,
  pricingFrom,
  resolveUsageMode,
  SessionUsage,
  USAGE_MODES,
} from '../src/usage.ts'

/** The route the shipped rates are keyed to. */
const PROVIDER = 'deepseek-official'

/** A table with one priced route, at rates chosen to make the arithmetic legible. */
const RATES = parsePricing({
  [`${PROVIDER}/deepseek-v4-flash`]: { input: 1, cachedInput: 0.1, output: 2 },
})

/** A moment inside a peak window, and one outside every window. */
const PEAK = Date.UTC(2026, 7, 18, 2, 0)
const OFF_PEAK = Date.UTC(2026, 7, 18, 12, 0)

/**
 * One adapter accounting record, with the optional buckets left off by default.
 * @param buckets - the buckets this record reports.
 * @returns the record.
 */
function usage(buckets: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, ...buckets }
}

describe('parsePricing()', () => {
  it('keeps an entry that names both required rates', () => {
    expect(parsePricing({ 'a/b': { input: 1, output: 2 } }).get('a/b')).toEqual({ input: 1, output: 2 })
  })

  it('carries the optional cache rates through', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2, cachedInput: 0.1, cachedWrite: 1.25 } })
    expect(table.get('a/b')).toEqual({ input: 1, output: 2, cachedInput: 0.1, cachedWrite: 1.25 })
  })

  it('reads a peak override beside the everyday rates', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2, peak: { input: 2, output: 4 } } })
    expect(table.get('a/b')?.peak).toEqual({ input: 2, output: 4 })
  })

  it('drops a peak override that is not itself a complete price', () => {
    // Half a peak block would charge the standard rate on one bucket and the
    // discount on the next, which is not a price either column ever named.
    const table = parsePricing({ 'a/b': { input: 1, output: 2, peak: { input: 2 } } })
    expect(table.get('a/b')).toEqual({ input: 1, output: 2 })
  })

  it('drops an entry priced on only one side', () => {
    expect(parsePricing({ 'a/b': { input: 1 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { output: 2 } }).size).toBe(0)
  })

  it('drops a rate that cannot be multiplied by a token count', () => {
    expect(parsePricing({ 'a/b': { input: -1, output: 2 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { input: Number.NaN, output: 2 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { input: '1', output: 2 } }).size).toBe(0)
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

describe('the shipped rates', () => {
  it('prices the routes this interface is built against', () => {
    const table = pricingFrom(undefined)
    expect(table.get(`${PROVIDER}/deepseek-v4-flash`)).toBeDefined()
    expect(table.get(`${PROVIDER}/deepseek-v4-pro`)).toBeDefined()
  })

  it('prices them only on their own route, never by model id alone', () => {
    // The same model through a gateway is billed by the gateway, so a bare-model
    // default would put DeepSeek's price list against somebody else's invoice.
    const table = pricingFrom(undefined)
    expect(table.get('deepseek-v4-flash')).toBeUndefined()
    expect(table.get('deepseek-v4-pro')).toBeUndefined()
  })

  it('charges a v4-flash cache miss at the published pair', () => {
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(0.22, 10)

    const peak = new SessionUsage(pricingFrom(undefined))
    peak.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', PEAK)
    expect(peak.reading.costUsd).toBeCloseTo(0.44, 10)
  })

  it('charges v4-pro output at the published pair', () => {
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ outputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-pro', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1.98, 10)

    const peak = new SessionUsage(pricingFrom(undefined))
    peak.observe(usage({ outputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-pro', PEAK)
    expect(peak.reading.costUsd).toBeCloseTo(3.96, 10)
  })

  it('lets configuration replace a shipped entry outright', () => {
    // Replaced, not merged field by field: someone correcting an output price
    // would not expect the input price beside it to stay at whatever this
    // release was built with.
    const table = pricingFrom({ [`${PROVIDER}/deepseek-v4-flash`]: { input: 9, output: 9 } })
    expect(table.get(`${PROVIDER}/deepseek-v4-flash`)).toEqual({ input: 9, output: 9 })
  })
})

describe('peak windows', () => {
  it('charges the standard rate only inside a published window', () => {
    const windows = parsePeakWindows(undefined)
    expect(isPeak(Date.UTC(2026, 7, 18, 2, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 7, 30), windows)).toBe(true)
    // Between the two windows, and well outside both.
    expect(isPeak(Date.UTC(2026, 7, 18, 5, 0), windows)).toBe(false)
    expect(isPeak(Date.UTC(2026, 7, 18, 12, 0), windows)).toBe(false)
    expect(isPeak(Date.UTC(2026, 7, 18, 0, 30), windows)).toBe(false)
  })

  it('treats a window as half-open, so its end hour is already off-peak', () => {
    const windows = parsePeakWindows(undefined)
    expect(isPeak(Date.UTC(2026, 7, 18, 1, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 4, 0), windows)).toBe(false)
    expect(isPeak(Date.UTC(2026, 7, 18, 10, 0), windows)).toBe(false)
  })

  it('reads the clock in UTC, not in the machine’s zone', () => {
    // A provider publishes its schedule in one timezone. Reading it in the local
    // one would move every user's prices by their own offset.
    const windows: readonly PeakWindow[] = parsePeakWindows([{ from: '02:00', to: '03:00' }])
    expect(isPeak(Date.parse('2026-08-18T02:30:00Z'), windows)).toBe(true)
    expect(isPeak(Date.parse('2026-08-18T02:30:00+05:00'), windows)).toBe(false)
  })

  it('handles a window that wraps midnight', () => {
    const windows = parsePeakWindows([{ from: '22:00', to: '02:00' }])
    expect(isPeak(Date.UTC(2026, 7, 18, 23, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 1, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 12, 0), windows)).toBe(false)
  })

  it('falls back to the published schedule rather than to no peak at all', () => {
    // No peak is the cheaper answer, which is exactly why nobody would notice it
    // was wrong. A configuration that does not parse keeps the shipped windows.
    for (const raw of [undefined, 'evenings', [], [{ from: 'nine', to: '10:00' }], [{ from: '25:00', to: '02:00' }]]) {
      expect(isPeak(Date.UTC(2026, 7, 18, 2, 0), parsePeakWindows(raw)), JSON.stringify(raw)).toBe(true)
    }
  })

  it('keeps the readable windows from a partly broken list', () => {
    const windows = parsePeakWindows([{ from: '02:00', to: '03:00' }, { from: 'noon', to: '13:00' }])
    expect(windows).toEqual([{ from: 120, to: 180 }])
  })
})

describe('SessionUsage', () => {
  it('counts every prompt token as input, cached or not', () => {
    const session = new SessionUsage(RATES)
    session.observe(
      usage({ inputTokens: 1_000, cacheReadTokens: 7_000, cacheWriteTokens: 800, outputTokens: 1_600 }),
      PROVIDER,
      'deepseek-v4-flash',
      OFF_PEAK,
    )
    expect(session.reading.inputTokens).toBe(8_800)
    expect(session.reading.outputTokens).toBe(1_600)
  })

  it('does not count reasoning tokens a second time', () => {
    // The adapter reports reasoning INSIDE the output total. Adding it again
    // inflates output on exactly the models people turn reasoning on for.
    const session = new SessionUsage(RATES)
    session.observe(usage({ outputTokens: 1_600, reasoningTokens: 1_200 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.outputTokens).toBe(1_600)
  })

  it('prices a cache read at the cache rate, not the uncached one', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ cacheReadTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(0.1, 10)
  })

  it('prices a cache write as a miss, which is what it is', () => {
    // The tokens are being read for the first time and stored on the way past,
    // so the miss rate is the right one — not the cheaper rate whose name also
    // happens to contain the word cache.
    const session = new SessionUsage(RATES)
    session.observe(usage({ cacheWriteTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
  })

  it('adds the buckets up at their own rates', () => {
    const session = new SessionUsage(RATES)
    session.observe(
      usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
      PROVIDER,
      'deepseek-v4-flash',
      OFF_PEAK,
    )
    expect(session.reading.costUsd).toBeCloseTo(3.1, 10)
  })

  it('prices each message by the clock it actually ran on', () => {
    // Peak and off-peak differ by half, so pricing a whole session at the moment
    // someone reopened it would bill a night's work at the morning rate.
    const table = pricingFrom({ 'a/b': { input: 1, output: 1, peak: { input: 10, output: 10 } } })
    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), 'a', 'b', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'a', 'b', PEAK)
    expect(session.reading.costUsd).toBeCloseTo(11, 10)
  })

  it('prices each message at the model that produced it', () => {
    // A `/model` switch mid-session must not reprice everything before it at
    // whichever route the session happens to end on.
    const table = parsePricing({
      'deepseek-official/cheap': { input: 1, output: 1 },
      'deepseek-official/dear': { input: 10, output: 10 },
    })
    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'cheap', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'dear', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(11, 10)
  })

  it('lets a bare model key cover whatever route serves it', () => {
    // The way to price a model the same through a gateway as direct, and the
    // reason nothing shipped is keyed this way: it has to be asked for.
    const session = new SessionUsage(parsePricing({ 'deepseek-v4-flash': { input: 1, output: 1 } }))
    session.observe(usage({ inputTokens: 1_000_000 }), 'some-gateway', 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
  })

  it('prefers the exact route over the bare model', () => {
    const session = new SessionUsage(parsePricing({
      'deepseek-v4-flash': { input: 1, output: 1 },
      'some-gateway/deepseek-v4-flash': { input: 5, output: 5 },
    }))
    session.observe(usage({ inputTokens: 1_000_000 }), 'some-gateway', 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(5, 10)
  })

  it('reports no cost at all for a route with no rates', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ inputTokens: 8_800, outputTokens: 1_600 }), 'other', 'mystery', OFF_PEAK)
    expect(session.reading.costUsd).toBeUndefined()
    expect(session.reading.partial).toBe(false)
    expect(session.reading.inputTokens).toBe(8_800)
  })

  it('marks a total that is only a floor', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'other', 'mystery', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
    expect(session.reading.partial).toBe(true)
  })
})

describe('usage modes', () => {
  it('names each mode by the word its argument takes', () => {
    expect(USAGE_MODES.map(mode => mode.id)).toEqual(['cost', 'tokens', 'off'])
  })

  it('matches an argument whatever case it was typed in', () => {
    expect(resolveUsageMode('Tokens')).toBe('tokens')
    expect(resolveUsageMode('  off ')).toBe('off')
    expect(resolveUsageMode('everything')).toBeUndefined()
    expect(resolveUsageMode('')).toBeUndefined()
  })
})

describe('formatUsage()', () => {
  /** A reading with the totals given. */
  const reading = (costUsd: number | undefined, partial = false): Parameters<typeof formatUsage>[0] =>
    ({ inputTokens: 8_800, outputTokens: 1_600, costUsd, partial })

  it('reports both directions and the money', () => {
    expect(formatUsage(reading(0.018), 'cost')).toBe('↑8.8k ↓1.6k $0.018')
  })

  it('leaves the money out on request', () => {
    expect(formatUsage(reading(0.018), 'tokens')).toBe('↑8.8k ↓1.6k')
  })

  it('reports nothing at all when switched off', () => {
    expect(formatUsage(reading(0.018), 'off')).toBeUndefined()
  })

  it('omits the money when nothing could be priced', () => {
    // The same rule the context bar follows: nothing is drawn before there is
    // something true to draw, and `$0.00` is not it.
    expect(formatUsage(reading(undefined), 'cost')).toBe('↑8.8k ↓1.6k')
  })

  it('marks a partial total so it does not read as the whole bill', () => {
    expect(formatUsage(reading(0.018, true), 'cost')).toBe('↑8.8k ↓1.6k ~$0.018')
  })

  it('keeps enough digits to be non-zero early in a session', () => {
    // A meter reading `$0.00` for the first twenty minutes is one nobody looks at.
    expect(formatUsage(reading(0.0018), 'cost')).toContain('$0.0018')
    expect(formatUsage(reading(0.018), 'cost')).toContain('$0.018')
    expect(formatUsage(reading(1.238), 'cost')).toContain('$1.24')
  })
})

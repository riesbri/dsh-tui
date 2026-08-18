/**
 * What the session has spent: cumulative tokens, and the money they cost.
 *
 * The numbers come from the adapter's own accounting, folded out of
 * `assistant/message` events rather than counted here, so what the status line
 * reports is what the provider billed. Folding happens in the runner's shared
 * projection, which means a resumed session recovers its totals by replaying its
 * log — there is no second restore path that could disagree with the live one.
 *
 * Nothing in this module knows about a terminal, a Context, or an agent, so all
 * of it is testable directly.
 * @module @riesbri/dsh-tui/usage
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { formatTokens } from '@riesbri/dsh-tui-renderer'

/**
 * Prices for one provider route and model, in dollars per million tokens.
 *
 * Cached reads and writes are separate rates because providers charge them at
 * very different multiples of the uncached rate — DeepSeek bills a cache hit at
 * roughly a tenth of a miss — and a session that reuses a long prompt is mostly
 * cache hits. Pricing those at the uncached rate would overstate a working day's
 * cost by most of it.
 */
export interface ModelRates {
  /** Uncached input, matching `TokenUsage.inputTokens`. */
  input: number
  /** Cache reads; falls back to {@link ModelRates.input} when a route has one rate. */
  cachedInput?: number
  /** Cache writes; falls back to {@link ModelRates.input} for the same reason. */
  cachedWrite?: number
  /** Output, matching `TokenUsage.outputTokens`. */
  output: number
}

/** Rates by `provider/model`, as {@link pricingKey} builds the key. */
export type PricingTable = ReadonlyMap<string, ModelRates>

/** Tokens are priced per million, which is how every provider publishes rates. */
const TOKENS_PER_PRICED_UNIT = 1_000_000

/** Dollar amounts at or above this read naturally with two decimals. */
const CENTS_PRECISION_FROM = 1

/** Below a dollar, three decimals; below this, a session's first turns would read `$0.00`. */
const MILLS_PRECISION_FROM = 0.01

/**
 * The lookup key for one route.
 * @param provider - provider route key.
 * @param model - provider-owned model id.
 * @returns the key a {@link PricingTable} is indexed by.
 */
export function pricingKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Whether a configured rate is usable.
 *
 * A negative or non-finite rate is not a cheaper price, it is a broken one, and
 * arithmetic on it would put `NaN` or a credit in the status line.
 * @param value - the configured value.
 * @returns whether it can be multiplied by a token count.
 */
function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Read a pricing table out of plugin configuration.
 *
 * Deliberately total: an entry that does not describe a price is dropped rather
 * than thrown over. Prices are a convenience on a status line, and a typo in a
 * machine-local config file must not be the reason a terminal refuses to start.
 * @param raw - the `pricing` value from the plugin's config, of any shape.
 * @returns the entries that were complete and usable.
 */
export function parsePricing(raw: unknown): PricingTable {
  const table = new Map<string, ModelRates>()
  if (typeof raw !== 'object' || raw === null) return table
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const { input, cachedInput, cachedWrite, output } = value as Record<string, unknown>
    // Both required rates must be present: a table entry with only one of them
    // would price half the traffic and silently understate the other half.
    if (!isRate(input) || !isRate(output)) continue
    table.set(key, {
      input,
      output,
      ...isRate(cachedInput) ? { cachedInput } : {},
      ...isRate(cachedWrite) ? { cachedWrite } : {},
    })
  }
  return table
}

/** Cumulative session usage as the status line reports it. */
export interface UsageReading {
  /** Every prompt token sent: uncached, cache reads, and cache writes together. */
  inputTokens: number
  /** Every token generated, reasoning included. */
  outputTokens: number
  /** Dollars spent, or undefined when no observed message had a known rate. */
  costUsd: number | undefined
  /**
   * Whether some observed usage could not be priced, so {@link UsageReading.costUsd}
   * is a floor rather than the total.
   */
  partial: boolean
}

/**
 * Running totals for one session.
 *
 * Cost is accrued per message, at the rate of the model that produced *that*
 * message, so a `/model` switch mid-session prices each half correctly. Totalling
 * the tokens first and pricing them once at the end would bill the whole session
 * at whichever model happened to be selected last.
 */
export class SessionUsage {
  private inputTokens = 0
  private outputTokens = 0
  private costUsd = 0
  private priced = false
  private unpriced = false

  /**
   * @param pricing - rates by route, usually from plugin configuration.
   */
  constructor(private readonly pricing: PricingTable) {}

  /**
   * Fold one message's accounting into the totals.
   *
   * The buckets are disjoint: `inputTokens` counts uncached input ONLY, with cache
   * reads and writes reported beside it, and `reasoningTokens` is already inside
   * `outputTokens`. Adding reasoning again is the mistake this comment exists to
   * name — it would inflate output on exactly the models people run it for.
   * @param usage - the adapter's accounting for one assistant message.
   * @param provider - the route that produced it, when known.
   * @param model - the model that produced it, when known.
   */
  observe(usage: TokenUsage, provider: string | undefined, model: string | undefined): void {
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    this.inputTokens += usage.inputTokens + cacheRead + cacheWrite
    this.outputTokens += usage.outputTokens

    const rates = provider === undefined || model === undefined
      ? undefined
      : this.pricing.get(pricingKey(provider, model))
    if (rates === undefined) {
      // Remembered rather than ignored: a total that quietly omits some traffic
      // reads as the whole bill, and the reader has no way to tell.
      this.unpriced = true
      return
    }
    this.priced = true
    this.costUsd += (
      usage.inputTokens * rates.input
      + cacheRead * (rates.cachedInput ?? rates.input)
      + cacheWrite * (rates.cachedWrite ?? rates.input)
      + usage.outputTokens * rates.output
    ) / TOKENS_PER_PRICED_UNIT
  }

  /** The totals so far. */
  get reading(): UsageReading {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.priced ? this.costUsd : undefined,
      partial: this.priced && this.unpriced,
    }
  }
}

/**
 * A dollar amount with enough digits to be non-zero.
 *
 * Two decimals is the natural form for money, and it is also useless here: a
 * session's first several turns cost fractions of a cent, and a meter that reads
 * `$0.00` for the first twenty minutes is one the reader stops looking at. The
 * precision therefore follows the magnitude.
 * @param value - dollars.
 * @returns e.g. `$0.0018`, `$0.018`, `$1.24`.
 */
function formatCost(value: number): string {
  if (value >= CENTS_PRECISION_FROM) return `$${value.toFixed(2)}`
  if (value >= MILLS_PRECISION_FROM) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

/**
 * The status line's usage segment.
 *
 * The cost is omitted entirely when no rate is configured for the models that
 * ran, rather than shown as zero: the same rule the context bar follows, where
 * nothing is drawn before there is something true to draw. A `~` marks a total
 * that is a floor because part of the session had no rates.
 * @param reading - the current totals.
 * @returns e.g. `↑8.8k ↓1.6k $0.018`.
 */
export function formatUsage(reading: UsageReading): string {
  const tokens = `↑${formatTokens(reading.inputTokens)} ↓${formatTokens(reading.outputTokens)}`
  if (reading.costUsd === undefined) return tokens
  return `${tokens} ${reading.partial ? '~' : ''}${formatCost(reading.costUsd)}`
}

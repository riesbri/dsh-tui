/**
 * Tests for bare `/usage` as an inspector.
 *
 * The pricing table, the peak windows, and the per-message fold are covered in
 * `usage.spec.ts`. What is under test here is the hybrid the inspector reports:
 * Harness's `tokenUsage` projection for the four disjoint buckets, dshline's own
 * fold for the money, and the claim that those two do not contradict each other.
 * That last one is asserted against the REAL projection rather than a fake,
 * because a silent divergence is exactly the failure a fake could not show.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { pricingFrom, SessionUsage, usageInspection } from '../src/usage.ts'
import type { UsageInspection, UsageReading } from '../src/usage.ts'
import { createUsageOverlay } from '../src/usage-overlay.ts'

/** A reading dshline's own fold would produce. */
function reading(overrides: Partial<UsageReading> = {}): UsageReading {
  return { inputTokens: 2_310_000, outputTokens: 42_000, costUsd: 0.84, partial: false, ...overrides }
}

/** One projection cut carrying Harness's usage buckets. */
function cut(values: ProjectionSnapshot['values'] = {}): ProjectionSnapshot {
  return { asOfSeq: 0, values }
}

/** The rows one inspection renders as, at a given geometry. */
function rows(inspection: UsageInspection, columns = 80, terminalRows = 24): string[] {
  const overlay = createUsageOverlay({
    inspection: () => inspection,
    mode: () => 'cost',
    chooseDisplay: () => {},
    close: () => {},
  })
  return overlay.render(columns, terminalRows).map(stripAnsi)
}

describe('the usage inspection', () => {
  it('reports Harness’s four buckets, their sum, and an honestly named cache ratio', () => {
    const inspection = usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000,
        cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000,
        outputTokens: 42_000,
      },
    }), reading())
    expect(inspection.buckets).toEqual({
      uncachedInput: 317_000,
      cacheRead: 1_980_000,
      cacheWrite: 13_000,
      input: 2_310_000,
      output: 42_000,
    })
    // A ratio of two buckets, not a provider metric: 1.98M of 2.31M.
    expect(inspection.cacheReadShare).toBeCloseTo(0.857, 2)
  })

  it('falls back to dshline’s own totals rather than leaving a hole', () => {
    const noRegistry = usageInspection(undefined, reading())
    expect(noRegistry.projections).toBe(false)
    expect(noRegistry.buckets).toBeUndefined()
    expect(noRegistry.reading.inputTokens).toBe(2_310_000)

    // Registry present, meter absent: the same fallback, a different reason.
    const unmetered = usageInspection(cut(), reading())
    expect(unmetered.projections).toBe(true)
    expect(unmetered.buckets).toBeUndefined()
  })

  it('claims no cache ratio for a session that has sent nothing', () => {
    const inspection = usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      },
    }), reading({ inputTokens: 0, outputTokens: 0, costUsd: undefined }))
    expect(inspection.cacheReadShare).toBeUndefined()
  })

  it('agrees with the real Harness projection on the tokens it prices', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    const session: Session = ctx.sessions.create()
    const usage = new SessionUsage(pricingFrom(undefined), [])

    // Two priced steps on the same route, folded the way the attachment folds
    // them: from `assistant/message`, at the event's own time.
    const steps = [
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 30 },
      { inputTokens: 50, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 0 },
    ]
    for (const [index, reported] of steps.entries()) {
      const turn = index + 1
      session.append('step/start', { turn, step: 1 })
      const event = session.append('assistant/message', {
        turn, step: 1,
        message: {
          id: `a-${String(turn)}`, role: 'assistant',
          content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' },
        },
        usage: reported,
      } as never, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      usage.observe(reported as never, 'deepseek-official', 'deepseek-v4-pro', event.time)
    }

    const snapshot = ctx.sessionProjections.snapshot(session)
    const inspection = usageInspection(snapshot, usage.reading)
    // The one property that matters: the buckets Harness reports and the tokens
    // dshline priced are the same tokens, so the report cannot contradict itself.
    expect(inspection.buckets?.input).toBe(inspection.reading.inputTokens)
    expect(inspection.buckets?.output).toBe(inspection.reading.outputTokens)
    // And the money is dshline's, which no projection retains.
    expect(inspection.reading.costUsd).toBeGreaterThan(0)
  })
})

describe('the usage inspector’s presentation', () => {
  it('reports the buckets, the ratio, the money, and the status preference', () => {
    const body = rows(usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
    }), reading())).join('\n')
    expect(body).toContain('Session')
    expect(body).toMatch(/input\s+2\.3M/u)
    expect(body).toMatch(/uncached\s+317k/u)
    expect(body).toMatch(/cache read\s+2\.0M/u)
    expect(body).toMatch(/cache write\s+13k/u)
    expect(body).toMatch(/output\s+42k/u)
    // Named for what it is: no provider here publishes a hit rate.
    expect(body).toContain('cache read share')
    expect(body).not.toContain('hit rate')
    expect(body).toMatch(/cost\s+\$0\.84/u)
    expect(body).toMatch(/status line\s+cost/u)
    expect(body).toContain('s status display · esc close')
  })

  it('reports no money at all for an unpriced session, rather than zero', () => {
    const body = rows(usageInspection(cut(), reading({ costUsd: undefined }))).join('\n')
    expect(body).toContain('No rates are configured')
    expect(body).not.toContain('$0.00')
  })

  it('says a partly priced total is a floor, and marks it', () => {
    const body = rows(usageInspection(cut(), reading({ partial: true }))).join('\n')
    expect(body).toContain('cost (partial)')
    expect(body).toContain('~$0.84')
    expect(body).toContain('is a floor')
  })

  it('names the reason the cache split is missing', () => {
    expect(rows(usageInspection(cut(), reading())).join('\n')).toContain('token meter is not mounted')
    expect(rows(usageInspection(undefined, reading())).join('\n'))
      .toContain('Session projections are unavailable')
  })

  it('hands the status-display choice to the existing picker, and leaves first', () => {
    const order: string[] = []
    const overlay = createUsageOverlay({
      inspection: () => usageInspection(cut(), reading()),
      mode: () => 'tokens',
      chooseDisplay: () => { order.push('picker') },
      close: () => { order.push('closed') },
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'text', text: 's' })
    // Closed BEFORE the picker opens: two overlays claiming the keyboard is how
    // a picker becomes unreachable.
    expect(order).toEqual(['closed', 'picker'])
  })

  it('closes on esc, and falls back to one closable row on a tiny terminal', () => {
    let closed = false
    const overlay = createUsageOverlay({
      inspection: () => usageInspection(cut(), reading()),
      mode: () => 'cost',
      chooseDisplay: () => {},
      close: () => { closed = true },
    })
    const tiny = overlay.render(12, 24).map(stripAnsi)
    expect(tiny.length).toBe(1)
    expect(tiny[0]).toContain('esc close')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(true)
  })

  it('never draws a frame wider or taller than the terminal it was given', () => {
    const inspection = usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
    }), reading({ partial: true }))
    for (const [columns, terminalRows] of [[80, 24], [40, 10], [60, 6], [120, 40]] as const) {
      const drawn = rows(inspection, columns, terminalRows)
      const physical = drawn.reduce(
        (count, row) => count + Math.max(1, Math.ceil(displayWidth(row) / columns)),
        0,
      )
      expect(physical, `must fit ${String(terminalRows)} rows`).toBeLessThanOrEqual(terminalRows)
      for (const row of drawn) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    }
  })
})

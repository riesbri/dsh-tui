/**
 * Capability probe: Harness compaction, against the real seam.
 *
 * The compatibility evidence `tools/capability-probes.mjs` names for the
 * `compaction` seam. dshline neither implements compaction nor calls it: it
 * PROJECTS the durable `compaction/*` events and dispatches the registered
 * `/compact` command. So the probe mounts a real `CompactionEngine` subclass —
 * the real abstract class, over a real `SessionStore` — appends the events a
 * backend appends, and asserts dshline's presentation reads them.
 *
 * A real backend (`dsh-compaction-basic`) is deliberately not mounted: it needs
 * an LLM route and an idle agent to summarize with, and none of that is part of
 * the contract dshline consumes. What dshline depends on is the event shape and
 * the command registration, which is what is exercised here.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CompactionEngine, CompactionId } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { stripAnsi } from '@dshline/renderer'
import { compactionNote } from '../../src/context/compaction.ts'

/** A real subclass of the real abstract service, appending real events. */
class ProbeCompaction extends CompactionEngine {
  /**
   * Automatic policy is not exercised here.
   * @returns null: nothing to compact.
   */
  async compactIfNeeded(): Promise<CompactionResult | null> {
    return null
  }

  /**
   * Explicit compaction is not exercised here.
   * @returns null: nothing to compact.
   */
  async compactNow(): Promise<CompactionResult | null> {
    return null
  }

  /**
   * Range compaction is not exercised here: dshline deliberately exposes no
   * range-selection control (observation and control are separate contracts).
   * @throws always.
   */
  async compactRegion(): Promise<CompactionResult> {
    throw new Error('not exercised')
  }
}

/** Append the exact event trio a manual or automatic compaction commits. */
function compact(session: Session, options: { manual: boolean }): {
  readonly startSeq: SessionSeq
  readonly summarySeq: SessionSeq
  readonly endSeq: SessionSeq
} {
  const compactionId = CompactionId('probe-1')
  const owner = options.manual ? { sourceCommandId: 'cmd-1' as never } : {}
  const first = session.append('user/message', {
    id: 'm-1', role: 'user', content: [{ type: 'text', text: 'a'.repeat(200) }], source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  const second = session.append('user/message', {
    id: 'm-2', role: 'user', content: [{ type: 'text', text: 'b'.repeat(200) }], source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  const start = session.append('compaction/start', { compactionId, turn: null, ...owner })
  const summary = session.append('compaction/summary', {
    compactionId,
    ...owner,
    summary: [{ type: 'text', text: 'the story so far' }],
    shadowedRange: { start: first.seq, end: second.seq },
    shadowedSeqs: [first.seq, second.seq],
    shadowedTokenCount: 95_000,
    provider: 'probe',
    model: 'probe-model',
  })
  session.append('user/message', {
    id: 'm-3', role: 'user', content: [{ type: 'text', text: 'the story so far' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId },
  } as never, {
    surfaceOp: { op: 'replace', start: first.seq, end: second.seq },
    sourceEventSeqs: [first.seq, second.seq],
  })
  const end = session.append('compaction/end', { compactionId, turn: null, ...owner })
  return { startSeq: start.seq, summarySeq: summary.seq, endSeq: end.seq }
}

/** Mount the real store and a real engine subclass. */
async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ProbeCompaction)
  return { ctx, session: ctx.sessions.create() }
}

describe('capability: compaction', () => {
  it('publishes the abstract service under the generic name dshline never calls', async () => {
    const { ctx } = await harness()
    // Present, and deliberately unused: dshline dispatches `/compact` through
    // `ctx.commands` so the command owns validation, the idle lock, the
    // lifecycle, and persistence. The seam is asserted to exist only so the
    // probe fails loudly if the contract this decision rests on moves.
    expect(ctx.get('compaction')).toBeInstanceOf(CompactionEngine)
  })

  it('presents a manual compaction from its summary event, not from command prose', async () => {
    const { session } = await harness()
    const seqs = compact(session, { manual: true })
    const summary = session.eventAt(seqs.summarySeq)
    expect(summary).toBeDefined()

    const note = compactionNote(summary as never, 80)
    const text = note.lines.map(stripAnsi).join('\n')
    expect(text).toContain('compacted 2 entries')
    // `~`, always: `shadowedTokenCount` is the meter's heuristic price of the
    // shadowed content, never a provider count.
    expect(text).toContain('~95k replaced')
    expect(text).not.toContain('automatically')
    // The seq the row presents, which is what lets a `command/done` citing the
    // same `sourceEventSeq` stay silent instead of repeating it.
    expect(note.presentedSeq).toBe(seqs.summarySeq)
  })

  it('names an automatic compaction as one, and says nothing about start or end', async () => {
    const { session } = await harness()
    const seqs = compact(session, { manual: false })
    const automatic = compactionNote(session.eventAt(seqs.summarySeq) as never, 80)
    expect(automatic.lines.map(stripAnsi).join('\n')).toContain('context compacted automatically')

    // The bracketing events carry no user-visible consequence of their own.
    expect(compactionNote(session.eventAt(seqs.startSeq) as never, 80).lines).toEqual([])
    expect(compactionNote(session.eventAt(seqs.endSeq) as never, 80).lines).toEqual([])
  })

  it('reports a failed AUTOMATIC compaction, which no command result would', async () => {
    const { session } = await harness()
    const failed = session.append('compaction/end', {
      compactionId: CompactionId('probe-2'),
      turn: null,
      error: 'summary was not smaller',
    })
    expect(compactionNote(failed, 80).lines.map(stripAnsi).join('\n'))
      .toContain('automatic context compaction did not complete')

    // The same failure under a command stays with the command, which reports
    // the backend's own classified reason.
    const manual = session.append('compaction/end', {
      compactionId: CompactionId('probe-3'),
      sourceCommandId: 'cmd-9' as never,
      turn: null,
      error: 'summary was not smaller',
    })
    expect(compactionNote(manual, 80).lines).toEqual([])
  })

  it('says nothing for a tool-result prune, which changes no visible exchange', async () => {
    const { session } = await harness()
    const pruned = session.append('compaction/prune', {
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [0],
      shadowedTokenCount: 4_000,
    })
    expect(compactionNote(pruned, 80).lines).toEqual([])
  })
})

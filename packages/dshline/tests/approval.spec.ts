/** Approval bells follow the live answerer waterfall, never its durable audit rows. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval'
import type { TuiOverlay } from '../src/slots.ts'
import { installApprovalAnswerer } from '../src/approval.ts'

type Answerer = (
  request: ApprovalRequestEvent,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

/** A context retaining the approval answerer and its one live overlay. */
function approvalContext(): {
  ctx: Context
  request: (request: ApprovalRequestEvent, next?: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> | undefined
  overlay: () => TuiOverlay | undefined
} {
  let answerer: Answerer | undefined
  let active: TuiOverlay | undefined
  const ctx = {
    on(_event: string, listener: Answerer) {
      answerer = listener
      return () => { answerer = undefined }
    },
    tuiSlots: {
      invalidate: () => {},
      pushOverlay(next: TuiOverlay) {
        active = next
        return () => { active = undefined }
      },
    },
  } as unknown as Context
  return {
    ctx,
    request: (request, next = () => Promise.resolve('unavailable')) => answerer?.(request, next),
    overlay: () => active,
  }
}

/** A distinct identity is all ownership checks require. */
function agent(id: string): Agent {
  return { id } as Agent
}

describe('approval attention', () => {
  it('rings once after presenting an owned, live approval', async () => {
    const { ctx, request, overlay } = approvalContext()
    const owned = agent('owned')
    let bells = 0
    installApprovalAnswerer(ctx, () => owned, () => { bells += 1 })

    const answer = request({ agent: owned, toolName: 'bash' })
    expect(bells).toBe(1)
    expect(overlay()).toBeDefined()
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toBe('allowed-once')
  })

  it('delegates a foreign agent without ringing', async () => {
    const { ctx, request, overlay } = approvalContext()
    const owned = agent('owned')
    let bells = 0
    let delegated = false
    installApprovalAnswerer(ctx, () => owned, () => { bells += 1 })

    await expect(request(
      { agent: agent('child'), toolName: 'bash' },
      () => { delegated = true; return Promise.resolve('rejected') },
    )).resolves.toBe('rejected')
    expect(delegated).toBe(true)
    expect(bells).toBe(0)
    expect(overlay()).toBeUndefined()
  })

  it('does not ring or present an already-aborted owned request', async () => {
    const { ctx, request, overlay } = approvalContext()
    const owned = agent('owned')
    let bells = 0
    installApprovalAnswerer(ctx, () => owned, () => { bells += 1 })

    await expect(request({ agent: owned, toolName: 'bash', signal: AbortSignal.abort() })).resolves.toBe('cancelled')
    expect(bells).toBe(0)
    expect(overlay()).toBeUndefined()
  })

  it('keeps its bell when an already-presented approval is withdrawn', async () => {
    const { ctx, request, overlay } = approvalContext()
    const owned = agent('owned')
    const abort = new AbortController()
    let bells = 0
    installApprovalAnswerer(ctx, () => owned, () => { bells += 1 })

    const answer = request({ agent: owned, toolName: 'bash', signal: abort.signal })
    expect(bells).toBe(1)
    expect(overlay()).toBeDefined()
    abort.abort()
    await expect(answer).resolves.toBe('cancelled')
    expect(bells).toBe(1)
    expect(overlay()).toBeUndefined()
  })
})

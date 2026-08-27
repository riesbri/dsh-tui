/**
 * The status line reads Harness's live Inbox instead of replaying its splice
 * events. These tests use the real upstream projection so replay-on-attach,
 * claims, cancellations, and notifications keep their Harness semantics.
 */

import { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import { describe, expect, it, vi } from 'vitest'
import { queuedUserCount } from '../src/steering.ts'
import { createStatusView } from '../src/views.ts'

/** Wide enough that the queued segment never yields to layout pressure. */
const STATUS_COLUMNS = 120

/** Create one user-submitted prompt. */
const prompt = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** Create context injected by a plugin, which queued steering must ignore. */
const injection = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'steering-test' },
})

/**
 * Construct Harness's real projection over a detached, durable Session.
 * @returns the live inbox, its session, and observable notification callbacks.
 */
function harnessInbox() {
  const session = Session.create(SessionId('steering-test'))
  const notifications = {
    inserted: vi.fn(),
    discarded: vi.fn(),
    claimed: vi.fn(),
  }
  return { session, notifications, inbox: new Inbox(session, notifications) }
}

/**
 * Compose one status view repeatedly, as redraws do in the attached window.
 * @param inbox - authoritative projection read by every composition.
 * @returns a function that renders the current visible status row.
 */
function statusFrames(inbox: Inbox): () => string {
  const view = createStatusView(() => ({
    busy: false,
    tick: 0,
    elapsedMs: undefined,
    activityWord: 'waiting',
    activity: undefined,
    model: undefined,
    effort: undefined,
    usage: undefined,
    tokens: undefined,
    contextWindow: undefined,
    detail: 'compact',
    work: undefined,
    queued: queuedUserCount(inbox),
    todo: undefined,
    plan: false,
    replay: undefined,
    goal: undefined,
  }))
  return () => stripAnsi(view.render(STATUS_COLUMNS)[0] ?? '')
}

describe('queued steering from the live Inbox', () => {
  it('shows already-pending user prompts in the first attached status frame', () => {
    const { session, inbox } = harnessInbox()
    inbox.append('next-step', prompt('steer this turn'))
    inbox.append('next-turn', prompt('run after this turn'))
    inbox.append('next-step', injection('provider context'))

    // A new Inbox reconstructs the same projection an attached or re-attached
    // agent exposes before dshline composes its first frame.
    const attached = new Inbox(session, {
      inserted: vi.fn(),
      discarded: vi.fn(),
      claimed: vi.fn(),
    })

    expect(statusFrames(attached)()).toContain('2 queued')
  })

  it('tracks insert, claim, and canceled discard on every redraw from the live Inbox', () => {
    const { session, notifications, inbox } = harnessInbox()
    const frame = statusFrames(inbox)
    const synthetic = injection('assembled context')
    const queued = prompt('please adjust the answer')

    expect(frame()).not.toContain('queued')
    inbox.append('next-step', synthetic)
    expect(frame()).not.toContain('queued')
    inbox.append('next-step', queued)
    expect(frame()).toContain('1 queued')
    expect(notifications.inserted).toHaveBeenCalledWith(synthetic)
    expect(notifications.inserted).toHaveBeenCalledWith(queued)

    expect(inbox.claim('next-step', 4)).toEqual([synthetic, queued])
    expect(frame()).not.toContain('queued')
    expect(notifications.claimed).toHaveBeenCalledWith(synthetic, 4)
    expect(notifications.claimed).toHaveBeenCalledWith(queued, 4)

    const canceled = prompt('never mind')
    inbox.append('next-turn', canceled)
    expect(frame()).toContain('1 queued')
    expect(inbox.remove(canceled.id)).toBe(true)
    expect(frame()).not.toContain('queued')
    expect(notifications.discarded).toHaveBeenCalledWith(canceled)
    expect(session.events.at(-1)?.type).toBe('agent/inbox/spliced')
    expect(session.events.at(-1)?.data).toMatchObject({ outcome: 'canceled' })
  })

  it('keeps a parked prompt exact when a mixed claim drains only an injection', () => {
    const { inbox } = harnessInbox()
    const frame = statusFrames(inbox)
    const parked = prompt('take this next turn')
    const synthetic = injection('step-only context')

    inbox.append('next-turn', parked)
    inbox.append('next-step', synthetic)
    expect(frame()).toContain('1 queued')

    expect(inbox.claim('next-step', 8)).toEqual([synthetic])
    expect(frame()).toContain('1 queued')
    expect(inbox.claim('next-turn', 9)).toEqual([parked])
    expect(frame()).not.toContain('queued')
  })
})

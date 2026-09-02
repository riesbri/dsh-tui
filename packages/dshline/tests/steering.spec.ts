/**
 * The status line reads Harness's live Inbox instead of replaying its splice
 * events. These tests use the real upstream projection so replay-on-attach,
 * claims, cancellations, and notifications keep their Harness semantics.
 */

import { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import { describe, expect, it, vi } from 'vitest'
import { pendingUserInput } from '../src/steering.ts'
import { createStatusView } from '../src/views.ts'

/** Wide enough that the pending segment never yields to layout pressure. */
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
    pending: pendingUserInput(inbox),
    todo: undefined,
    plan: false,
    replay: undefined,
    goal: undefined,
  }))
  return () => stripAnsi(view.render(STATUS_COLUMNS)[0] ?? '')
}

describe('pending user input from the live Inbox', () => {
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

    // One prompt on each list, so neither word alone is true and the segment
    // says `pending` rather than picking a side or spending two segments.
    expect(statusFrames(attached)()).toContain('2 pending')
  })

  it('names which list the input is parked on, and says pending only for a mixture', () => {
    const { inbox } = harnessInbox()
    const frame = statusFrames(inbox)

    // next-step alone: the running turn will take it at its next step.
    inbox.append('next-step', prompt('while you are in there'))
    expect(frame()).toContain('1 steering')
    expect(frame()).not.toContain('queued')

    // Both lists: the count is the total, and the word is neither of theirs.
    inbox.append('next-turn', prompt('afterwards, run the tests'))
    expect(frame()).toContain('2 pending')
    expect(frame()).not.toContain('steering')

    // next-turn alone: a follow-up turn of its own, which is what `queued` means.
    expect(inbox.claim('next-step', 1)).toHaveLength(1)
    expect(frame()).toContain('1 queued')
    expect(frame()).not.toContain('pending')
  })

  it('ignores plugin context on either list, whichever word is in force', () => {
    const { inbox } = harnessInbox()
    const frame = statusFrames(inbox)

    // Context the agent assembled is not a keystroke waiting to be answered for,
    // so it never reaches this segment — on either list, and it cannot turn a
    // one-sided count into a mixture.
    inbox.append('next-step', injection('assembled context'))
    inbox.append('next-turn', injection('deferred context'))
    expect(frame()).not.toContain('pending')
    expect(frame()).not.toContain('queued')
    expect(frame()).not.toContain('steering')

    inbox.append('next-turn', prompt('the only real prompt'))
    expect(frame()).toContain('1 queued')
  })

  it('tracks insert, claim, and canceled discard on every redraw from the live Inbox', () => {
    const { session, notifications, inbox } = harnessInbox()
    const frame = statusFrames(inbox)
    const synthetic = injection('assembled context')
    const queued = prompt('please adjust the answer')

    expect(frame()).not.toContain('steering')
    inbox.append('next-step', synthetic)
    expect(frame()).not.toContain('steering')
    inbox.append('next-step', queued)
    expect(frame()).toContain('1 steering')
    expect(notifications.inserted).toHaveBeenCalledWith(synthetic)
    expect(notifications.inserted).toHaveBeenCalledWith(queued)

    expect(inbox.claim('next-step', 4)).toEqual([synthetic, queued])
    expect(frame()).not.toContain('steering')
    expect(notifications.claimed).toHaveBeenCalledWith(synthetic, 4)
    expect(notifications.claimed).toHaveBeenCalledWith(queued, 4)

    const canceled = prompt('never mind')
    inbox.append('next-turn', canceled)
    expect(frame()).toContain('1 queued')
    expect(inbox.remove(canceled.id)).toBe(true)
    expect(frame()).not.toContain('queued')
    expect(notifications.discarded).toHaveBeenCalledWith(canceled)
    // The newest event, read as a point read rather than by materializing the log.
    const newest = session.seq === 0 ? undefined : session.eventAt(SessionSeq(session.seq - 1))
    expect(newest?.type).toBe('agent/inbox/spliced')
    expect(newest?.data).toMatchObject({ outcome: 'canceled' })
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

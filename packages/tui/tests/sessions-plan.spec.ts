/** Tests for when reopening a session is allowed, and what happens when it fails. */

import { describe, expect, it } from 'vitest'
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@riesbri/dsh-tui-renderer'
import type { SessionEntry } from '../src/sessions/model.ts'
import { planResume } from '../src/sessions/plan.ts'
import type { AgentOpener, AttachTarget } from '../src/sessions/reopen.ts'
import { attachTarget, reopenFailureLines } from '../src/sessions/reopen.ts'

/**
 * A persisted, reopenable session with only the facts the policy reads.
 * @param overrides - fields to replace.
 * @returns the entry.
 */
function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'past' as SessionId,
    title: 'Earlier work',
    createdAt: 0,
    cwd: '/w',
    live: false,
    persisted: true,
    parent: undefined,
    origin: 'own',
    ...overrides,
  }
}

/** The conditions of a quiet, idle window driving one other session. */
const IDLE = { currentSessionId: 'current' as SessionId, busy: false, activeWork: 0 }

describe('whether a session may be reopened', () => {
  it('accepts a persisted session while the window is idle', () => {
    expect(planResume({ target: entry(), ...IDLE })).toEqual({ kind: 'resume' })
  })

  it('accepts from a launch, where there is no session to leave', () => {
    expect(planResume({ target: entry(), currentSessionId: undefined, busy: false, activeWork: 0 }))
      .toEqual({ kind: 'resume' })
  })

  it('refuses the session already open in this window', () => {
    const plan = planResume({ target: entry({ id: 'current' as SessionId, live: true }), ...IDLE })
    expect(plan).toMatchObject({ kind: 'refused' })
    expect(plan.kind === 'refused' && plan.message).toContain('already open')
  })

  it('refuses a live id before it can collide in the session store', () => {
    // Resume prepares the persisted log and enters it into `ctx.sessions`, which
    // refuses a duplicate id. Saying so beats letting the factory throw a store
    // error at a reader who only picked a row.
    const plan = planResume({ target: entry({ live: true }), ...IDLE })
    expect(plan.kind === 'refused' && plan.message).toContain('already live')
  })

  it('refuses a session with no persisted log, which also covers no backend', () => {
    const plan = planResume({ target: entry({ persisted: false }), ...IDLE })
    expect(plan.kind === 'refused' && plan.message).toContain('persistence')
  })

  it('refuses mid-turn rather than retiring an agent that is answering', () => {
    const plan = planResume({ target: entry(), ...IDLE, busy: true })
    expect(plan.kind === 'refused' && plan.message).toContain('current turn')
  })

  it('refuses while work is still attached, which Harness does not model', () => {
    // `AgentHandle.dispose()` unwinds the agent's whole scoped world. No generic
    // seam says whether a job or a delegated child whose owner disappears should
    // stop, be orphaned, or be waited for — so the frontend does not guess.
    const one = planResume({ target: entry(), ...IDLE, activeWork: 1 })
    expect(one.kind === 'refused' && one.message).toBe('1 job or subagent is still attached to this session.')
    const many = planResume({ target: entry(), ...IDLE, activeWork: 3 })
    expect(many.kind === 'refused' && many.message).toBe('3 jobs or subagents are still attached to this session.')
  })

  it('names the reader’s own situation before the capability rules', () => {
    // A busy window looking at its own session should hear "already open", not
    // "finish the turn": the first is true whatever the deployment mounts.
    const plan = planResume({
      target: entry({ id: 'current' as SessionId, live: true, persisted: false }),
      currentSessionId: 'current' as SessionId,
      busy: true,
      activeWork: 2,
    })
    expect(plan.kind === 'refused' && plan.message).toContain('already open')
  })
})

/**
 * A factory surface that records what it was asked for.
 * @param resume - what `resume` should do, called once per attempt.
 * @returns the opener and its call log.
 */
function opener(resume: (options: ResumeAgentOptions) => Promise<AgentHandle>): {
  agents: AgentOpener
  created: CreateAgentOptions[]
  resumed: ResumeAgentOptions[]
} {
  const created: CreateAgentOptions[] = []
  const resumed: ResumeAgentOptions[] = []
  return {
    created,
    resumed,
    agents: {
      create: async options => {
        created.push(options)
        return handle('created')
      },
      resume: async options => {
        resumed.push(options)
        return resume(options)
      },
    },
  }
}

/**
 * A resolved handle standing in for a live agent.
 * @param label - a marker the assertions can recognise.
 * @returns the handle.
 */
function handle(label: string): AgentHandle {
  return { agent: { label } as unknown as AgentHandle['agent'], dispose: async () => {} }
}

/**
 * The window callbacks {@link attachTarget} drives, with their transcript.
 * @param answers - what the browser answers, in order; exhausted answers dismiss.
 * @returns the spec fields and the recorded reports.
 */
function windowSide(answers: readonly AttachTarget[]): {
  report: (reason: string) => void
  ask: () => Promise<AttachTarget>
  reported: string[]
  asked: () => number
} {
  const reported: string[] = []
  let index = 0
  return {
    reported,
    asked: () => index,
    report: reason => { reported.push(reason) },
    ask: async () => answers[index++] ?? { kind: 'new', afterDismissal: true },
  }
}

describe('attaching the agent a window drives', () => {
  it('creates a fresh session when none was requested', async () => {
    const { agents, created, resumed } = opener(async () => { throw new Error('unused') })
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'tui-new' as SessionId,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'new' })
    expect(outcome.attached.reopened).toBe(false)
    expect(outcome.target).toEqual({ kind: 'new' })
    expect(resumed).toHaveLength(0)
    expect(created[0]).toMatchObject({ sessionId: 'tui-new', meta: { cwd: '/w' } })
    expect(side.reported).toEqual([])
  })

  it('reopens the requested session and reports that it replayed one', async () => {
    const { agents, created, resumed } = opener(async () => handle('resumed'))
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'tui-new' as SessionId,
      cwd: '/w',
      options: { agentOptions: { provider: 'p', model: 'm' } },
      ...side,
    }, { kind: 'resume', id: 'past' as SessionId })
    expect(outcome.attached.reopened).toBe(true)
    expect(created).toHaveLength(0)
    expect(resumed[0]).toMatchObject({ resumeSessionId: 'past', agentOptions: { provider: 'p', model: 'm' } })
  })

  it('reports the reason and asks again rather than substituting a session', async () => {
    // The previous agent is already retired by the time a reopen fails, so a
    // quiet fallback would put the reader in a brand-new session in the launch
    // directory — a different thing wearing the place of what they asked for.
    const { agents, resumed, created } = opener(async options =>
      options.resumeSessionId === 'broken'
        ? Promise.reject(new Error('replay validation failed'))
        : Promise.resolve(handle('resumed')))
    const side = windowSide([{ kind: 'resume', id: 'sound' as SessionId }])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'tui-new' as SessionId,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'broken' as SessionId })
    expect(side.reported).toEqual(['replay validation failed'])
    expect(side.asked()).toBe(1)
    expect(resumed.map(options => options.resumeSessionId)).toEqual(['broken', 'sound'])
    expect(created).toHaveLength(0)
    expect(outcome.target).toEqual({ kind: 'resume', id: 'sound' })
    expect(outcome.attached.reopened).toBe(true)
  })

  it('creates a new session when the reader dismisses the browser after a failure', async () => {
    // Dismissal is how the reader chooses a fresh session deliberately, and the
    // attachment marks it so the transcript says a request went unanswered.
    const { agents, created } = opener(async () => { throw new Error('session persistence is not configured') })
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'tui-new' as SessionId,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'past' as SessionId })
    expect(side.reported).toEqual(['session persistence is not configured'])
    expect(outcome.target).toEqual({ kind: 'new', afterDismissal: true })
    expect(created[0]).toMatchObject({ sessionId: 'tui-new' })
  })

  it('keeps asking while reopening keeps failing, and never loops on its own', async () => {
    // Bounded by the reader, not by a retry count: every attempt is reported and
    // re-asked, and dismissing ends it. A broken persistence backend therefore
    // reaches a usable window in one keystroke instead of spinning or dying.
    const { agents, created, resumed } = opener(async () => { throw new Error('unreadable') })
    const side = windowSide([
      { kind: 'resume', id: 'second' as SessionId },
      { kind: 'resume', id: 'third' as SessionId },
    ])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'tui-new' as SessionId,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'first' as SessionId })
    expect(resumed.map(options => options.resumeSessionId)).toEqual(['first', 'second', 'third'])
    expect(side.reported).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(outcome.target).toEqual({ kind: 'new', afterDismissal: true })
    expect(created).toHaveLength(1)
  })

  it('reports a thrown non-error too', async () => {
    const { agents } = opener(async () => { throw 'corrupt log' })
    const side = windowSide([])
    await attachTarget({
      agents,
      newSessionId: () => 'tui-new' as SessionId,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'past' as SessionId })
    expect(side.reported).toEqual(['corrupt log'])
  })

  it('lets a failed create reach the boot-failure path', async () => {
    // There is nothing to fall back to and nothing to ask, so this one is not
    // caught: the runner reports it on stderr and exits non-zero.
    const agents: AgentOpener = {
      create: async () => { throw new Error('no factory registered') },
      resume: async () => handle('resumed'),
    }
    const side = windowSide([])
    await expect(attachTarget({
      agents,
      newSessionId: () => 'tui-new' as SessionId,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'new' })).rejects.toThrow('no factory registered')
  })
})

describe('what a failed reopen says', () => {
  it('names the reason and the way out of the browser it is about to open', () => {
    const lines = reopenFailureLines('replay validation failed').map(stripAnsi)
    expect(lines[0]).toContain('could not reopen that session: replay validation failed')
    expect(lines[1]).toContain('esc for a new session')
  })

  it('escapes a reason it did not compose', () => {
    // Harness messages can carry a filesystem path, and a persisted log can put
    // anything in one.
    const lines = reopenFailureLines(`before${String.fromCharCode(27)}[2Jafter`)
    expect(lines.join('\n')).not.toContain(String.fromCharCode(27) + '[2J')
    expect(stripAnsi(lines[0] ?? '')).toContain('after')
  })
})

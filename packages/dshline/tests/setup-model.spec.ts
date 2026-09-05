/**
 * What the setup report claims, and — more often — what it refuses to claim.
 *
 * Most of these tests are about the third mark. A `✓` and a `⚠` are both
 * verdicts, and setup is only entitled to one where a Harness surface actually
 * answered; everything else has to read as "nobody established this" rather
 * than as either good news or a fault. A report that guessed would be worse
 * than no report, because the whole point of it is that a person can trust the
 * one line that says why they have no model.
 */

import { describe, expect, it } from 'vitest'
import { compareGenerations } from '../src/setup/harness.ts'
import type { SetupFacts } from '../src/setup/harness.ts'
import {
  awaitingActivation,
  hasActiveRoute,
  hasWarning,
  setupChecks,
  setupSteps,
} from '../src/setup/model.ts'
import type { ConnectProviderRow, ConnectSignInRow, ConnectState } from '../src/connect/model.ts'

/**
 * One provider row.
 * @param provider - the route key.
 * @param state - where it stands with the model registry.
 * @returns the row.
 */
function route(provider: string, state: ConnectProviderRow['state']): ConnectProviderRow {
  return {
    kind: 'provider',
    provider,
    displayName: provider,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', provider],
    declared: false,
    state,
    models: undefined,
    credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    userOwned: false,
    revision: 1,
  }
}

/**
 * One sign-in row.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function signIn(overrides: Partial<ConnectSignInRow> = {}): ConnectSignInRow {
  return {
    kind: 'sign-in',
    key: 'llm-pi-ai/openai',
    label: 'OpenAI',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
    record: { configured: true, writable: true },
    route: { provider: 'openai', state: 'dormant' },
    ...overrides,
  }
}

/**
 * A complete reading.
 * @param overrides - the parts a test cares about.
 * @returns the state.
 */
function reading(overrides: Partial<Extract<ConnectState, { kind: 'ready' }>> = {}): ConnectState {
  return {
    kind: 'ready',
    providers: [],
    signIns: [],
    capabilities: { settings: true, credentials: true, authorization: true },
    newRouteTargets: [],
    ...overrides,
  }
}

/**
 * Facts for a report.
 * @param overrides - the parts a test cares about.
 * @returns the facts.
 */
function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    node: '24.4.0',
    dshline: '0.17.0',
    harness: { kind: 'match', version: '0.1.2-rc.1' },
    profile: 'dshline',
    connect: reading(),
    ...overrides,
  }
}

/**
 * One row's rendered text, for the assertions below.
 * @param all - the checks.
 * @param name - the row to find.
 * @returns the mark, the detail, and the notes joined.
 */
function row(all: ReturnType<typeof setupChecks>, name: string): { mark: string; text: string } {
  const found = all.find(check => check.name === name)
  if (found === undefined) throw new Error(`no ${name} row`)
  return { mark: found.mark, text: [found.detail, ...found.notes].join(' | ') }
}

describe('comparing Harness generations', () => {
  it('matches only on exact equality, as the repository target check does', () => {
    expect(compareGenerations('0.1.2-rc.1', '0.1.2-rc.1')).toEqual({ kind: 'match', version: '0.1.2-rc.1' })
    expect(compareGenerations('0.1.2-rc.1', '0.1.3-alpha.1'))
      .toEqual({ kind: 'mismatch', adopted: '0.1.2-rc.1', installed: '0.1.3-alpha.1' })
  })

  it('claims nothing when either side could not be read, keeping the half it has', () => {
    expect(compareGenerations('0.1.2-rc.1', undefined))
      .toEqual({ kind: 'unknown', adopted: '0.1.2-rc.1', installed: undefined })
    expect(compareGenerations(undefined, '0.1.2-rc.1'))
      .toEqual({ kind: 'unknown', adopted: undefined, installed: '0.1.2-rc.1' })
    expect(compareGenerations(undefined, undefined))
      .toEqual({ kind: 'unknown', adopted: undefined, installed: undefined })
  })
})

describe('the setup report', () => {
  it('reports Node without a verdict, because this process is already running on it', () => {
    // A tick would be circular and a warning would need a semver range
    // evaluator. The version is what a bug report asks for, so it is stated.
    expect(row(setupChecks(facts()), 'Node')).toEqual({ mark: '·', text: '24.4.0' })
  })

  it('ticks a matching Harness generation and names it', () => {
    expect(row(setupChecks(facts()), 'Harness')).toEqual({ mark: '✓', text: '0.1.2-rc.1' })
  })

  it('warns on a mismatch with both versions and both alignment commands', () => {
    const harness = row(
      setupChecks(facts({ harness: { kind: 'mismatch', adopted: '0.1.2-rc.1', installed: '0.1.3-alpha.1' } })),
      'Harness',
    )
    expect(harness.mark).toBe('⚠')
    expect(harness.text).toContain('0.1.3-alpha.1 installed')
    expect(harness.text).toContain('dshline targets 0.1.2-rc.1')
    // Both directions are named. Choosing between them would mean deciding
    // which version is newer, which is the comparison this repository refuses.
    expect(harness.text).toContain('npm install -g @deepseek-ai/dsh@0.1.2-rc.1')
    expect(harness.text).toContain('dsh plugin --profile dshline update @dshline/dshline')
  })

  it('marks an unreadable generation unknown rather than good or bad', () => {
    const unknown = row(
      setupChecks(facts({ harness: { kind: 'unknown', adopted: '0.1.2-rc.1', installed: undefined } })),
      'Harness',
    )
    expect(unknown.mark).toBe('·')
    expect(unknown.text).toContain('could not be read')
    // Never a claim in either direction.
    expect(unknown.text).not.toContain('incompatible')
    // Both sides unreadable is still no verdict, not a warning about one.
    const blind = setupChecks(facts({
      harness: { kind: 'unknown', adopted: undefined, installed: undefined },
      connect: reading({ providers: [route('openai', 'active')] }),
    }))
    expect(row(blind, 'Harness')).toEqual({ mark: '·', text: 'version could not be read' })
    expect(hasWarning(blind)).toBe(false)
  })

  it('marks an undetermined profile unknown rather than missing', () => {
    expect(row(setupChecks(facts({ profile: undefined })), 'Profile'))
      .toEqual({ mark: '·', text: 'could not be determined' })
  })

  it('names the two ways of connecting in the words the next screen uses', () => {
    const connecting = row(setupChecks(facts({ connect: reading({ signIns: [signIn()] }) })), 'Connecting')
    expect(connecting.mark).toBe('✓')
    expect(connecting.text).toContain('API key')
    expect(connecting.text).toContain('account sign-in')
    // Not seam names: a beginner meets "sign in" and "API key", not services.
    expect(connecting.text).not.toContain('authorization')
    expect(connecting.text).not.toContain('credentials')
  })

  it('does not offer account sign-in when no authorization seam is mounted', () => {
    const connecting = row(
      setupChecks(facts({
        connect: reading({ capabilities: { settings: true, credentials: true, authorization: false } }),
      })),
      'Connecting',
    )
    expect(connecting.mark).toBe('✓')
    expect(connecting.text).toBe('API key')
  })

  it('warns, and says what has to happen instead, when nothing can configure a provider', () => {
    const connecting = row(
      setupChecks(facts({
        connect: reading({ capabilities: { settings: false, credentials: false, authorization: false } }),
      })),
      'Connecting',
    )
    expect(connecting.mark).toBe('⚠')
    expect(connecting.text).toContain('no authorization seam')
    expect(connecting.text).toContain('settings.yaml')
  })

  it('names the active routes when there are any', () => {
    const models = row(
      setupChecks(facts({ connect: reading({ providers: [route('openai', 'active'), route('anthropic', 'dormant')] }) })),
      'Models',
    )
    expect(models).toEqual({ mark: '✓', text: '1 route active · openai' })
  })

  it('names a sign-in whose route is not active as the reason there is no model', () => {
    const models = row(
      setupChecks(facts({
        connect: reading({ providers: [route('openai', 'dormant')], signIns: [signIn()] }),
      })),
      'Models',
    )
    expect(models.mark).toBe('⚠')
    expect(models.text).toContain('no provider route is active')
    expect(models.text).toContain('OpenAI is signed in, but its openai route is not active')
  })

  it('says a reading failed rather than reporting it as nothing configured', () => {
    const models = row(
      setupChecks(facts({ connect: { kind: 'failed', message: 'settings.yaml is unreadable' } })),
      'Models',
    )
    // `·`, not `⚠`: a read that did not happen is not evidence of a problem
    // with what it would have read.
    expect(models.mark).toBe('·')
    expect(models.text).toContain('settings.yaml is unreadable')
  })
})

describe('what setup offers next', () => {
  it('offers connecting, and no model step, while nothing is registered', () => {
    const steps = setupSteps(facts({ connect: reading({ providers: [route('openai', 'dormant')] }) }))
    expect(steps.map(step => step.id)).toEqual(['connect', 'skip'])
    expect(steps[0]?.label).toBe('Connect a provider')
    expect(steps[1]?.label).toBe('Not now')
  })

  it('offers the model picker only once a route is registered', () => {
    const steps = setupSteps(facts({ connect: reading({ providers: [route('openai', 'active')] }) }))
    expect(steps.map(step => step.id)).toEqual(['connect', 'model', 'skip'])
    expect(steps[2]?.label).toBe('Start the session')
  })

  it('offers no configuration step when no seam would accept one', () => {
    const steps = setupSteps(facts({
      connect: reading({ capabilities: { settings: false, credentials: false, authorization: false } }),
    }))
    // Never an offer that opens a browser with nothing it can do.
    expect(steps.map(step => step.id)).toEqual(['skip'])
  })

  it('always offers a way out', () => {
    for (const connect of [
      reading(),
      reading({ providers: [route('openai', 'active')] }),
      { kind: 'failed', message: 'nope' } as ConnectState,
      { kind: 'loading' } as ConnectState,
    ]) {
      expect(setupSteps(facts({ connect })).some(step => step.id === 'skip')).toBe(true)
    }
  })
})

describe('the trigger', () => {
  it('is a registered route and nothing else', () => {
    expect(hasActiveRoute(reading())).toBe(false)
    expect(hasActiveRoute(reading({ providers: [route('openai', 'dormant')] }))).toBe(false)
    // Configured but unregistered is still nothing `/model` can offer.
    expect(hasActiveRoute(reading({ providers: [route('openai', 'configured')] }))).toBe(false)
    expect(hasActiveRoute(reading({ providers: [route('openai', 'active')] }))).toBe(true)
    expect(hasActiveRoute({ kind: 'loading' })).toBe(false)
  })
})

describe('sign-ins waiting on a route', () => {
  it('names only those that are signed in against an inactive linked route', () => {
    const connect = reading({
      signIns: [
        signIn(),
        signIn({ key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: { provider: 'anthropic', state: 'active' } }),
        signIn({ key: 'llm-pi-ai/google', label: 'Google', record: { configured: false, writable: true } }),
        // No link established: nothing is claimed about it either way.
        signIn({ key: 'other/thing', label: 'Something', route: undefined }),
      ],
    })
    expect(awaitingActivation(connect)).toEqual([
      'OpenAI is signed in, but its openai route is not active',
    ])
  })
})

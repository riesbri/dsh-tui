/**
 * The setup report, and what it offers to do about itself.
 *
 * Everything here is pure: facts in, rows and offers out. Nothing reads a
 * seam, nothing writes one, and nothing decides on its own that a step should
 * run — {@link "./index.ts"} does the acting, this decides what is true and
 * what is worth offering.
 *
 * Two rules shape every line below.
 *
 * **A mark is a claim, so an unknown gets no mark.** `✓` means a surface
 * confirmed something, `⚠` means a surface confirmed it is missing, and `·`
 * means nobody established either — a Harness generation that could not be
 * read, a profile whose root is unreadable. The third case is common and is
 * not a fault, so it must not look like one; the same distinction
 * `providerReadiness` already draws for a credential dot.
 *
 * **A step is offered only when the seams would accept it.** `Choose a model`
 * appears only once a route is registered, because `/model` answers "no
 * provider route advertises a model" otherwise, and an offer that opens a
 * picker with nothing in it is worse than no offer.
 * @module dshline/setup/model
 */

import type { ConnectCapabilities, ConnectState } from '../connect/index.ts'
import type { HarnessGeneration, SetupFacts } from './harness.ts'

/**
 * How confidently one row can be stated.
 *
 * `⚠` is deliberately not an error mark. Every state it appears on here is a
 * reachable, fixable configuration — no route active, no authorization seam —
 * and setup exists precisely to be the place a reader meets those calmly.
 */
export type SetupMark = '✓' | '⚠' | '·'

/** One line of the report. */
export interface SetupCheck {
  /** The mark, or `·` where nothing was established. */
  readonly mark: SetupMark
  /** Left column: what was checked. */
  readonly name: string
  /** Right column: what was found. */
  readonly detail: string
  /** Indented follow-up lines, for a finding that needs an action spelled out. */
  readonly notes: readonly string[]
}

/** Something setup can hand the reader on to. */
export type SetupStepId =
  /** Open `/connect`, the browser that configures and authenticates providers. */
  | 'connect'
  /** Open `/model`, once at least one route advertises something. */
  | 'model'
  /** Leave setup and go to the composer. */
  | 'skip'

/** One offered next action, already worded for a picker. */
export interface SetupStep {
  readonly id: SetupStepId
  readonly label: string
  readonly description: string
}

/**
 * Whether this environment can produce a model turn at all.
 *
 * The trigger for the whole flow, and deliberately the cheapest true statement
 * of it: a registered route is what `/model` offers from, so zero registered
 * routes is exactly "nothing can be selected." It asks no adapter for a
 * catalog, so a fresh install pays no network for the answer, and a working
 * install is never interrupted.
 * @param connect - the reading, or any state standing in for one.
 * @returns whether at least one route is registered.
 */
export function hasActiveRoute(connect: ConnectState): boolean {
  return connect.kind === 'ready' && connect.providers.some(row => row.state === 'active')
}

/**
 * Sign-ins that succeeded against a route nothing has registered.
 *
 * The failure this whole change exists for, stated as data. A credential
 * record and a settings profile are separate writes, so a person can finish an
 * account login and still have no model — and before the link existed, the
 * only evidence on screen was two unrelated-looking rows.
 * @param connect - the reading.
 * @returns each such sign-in as `<label> · <route>`, in reading order.
 */
export function awaitingActivation(connect: ConnectState): string[] {
  if (connect.kind !== 'ready') return []
  return connect.signIns
    .filter(row => row.record?.configured === true && row.route !== undefined && row.route.state !== 'active')
    .map(row => `${row.label} is signed in, but its ${String(row.route?.provider)} route is not active`)
}

/**
 * The two commands that put a mismatched pair back on one generation.
 *
 * Both, never one. Deciding WHICH side should move means deciding which
 * version is newer, and comparing two pre-release specifiers is the version
 * engine this repository refuses to grow — so the reader is given the pair and
 * makes a decision they are better placed to make anyway.
 * @param generation - the mismatch.
 * @returns the note lines.
 */
function mismatchNotes(generation: { adopted: string; installed: string }): string[] {
  return [
    'dshline supports one Harness generation at a time. Bring them together with either:',
    `npm install -g @deepseek-ai/dsh@${generation.adopted}`,
    'dsh plugin --profile dshline update @dshline/dshline',
  ]
}

/**
 * How the Harness generation reads as one row.
 * @param generation - the comparison.
 * @returns the row.
 */
function harnessCheck(generation: HarnessGeneration): SetupCheck {
  if (generation.kind === 'match') {
    return { mark: '✓', name: 'Harness', detail: generation.version, notes: [] }
  }
  if (generation.kind === 'mismatch') {
    return {
      mark: '⚠',
      name: 'Harness',
      detail: `${generation.installed} installed · dshline targets ${generation.adopted}`,
      notes: mismatchNotes(generation),
    }
  }
  const known = generation.installed ?? generation.adopted
  return {
    mark: '·',
    name: 'Harness',
    // Never "incompatible", and never "fine". Both would be claims about a
    // comparison that was not made.
    detail: known === undefined
      ? 'version could not be read'
      : generation.installed === undefined
        ? `dshline targets ${known}; the installed version could not be read`
        : `${known} installed; the targeted version could not be read`,
    notes: [],
  }
}

/**
 * How the mounted seams read as one row.
 *
 * One row rather than three, because a reader is not being asked about seams —
 * they are being told whether the two ways of connecting a provider are open.
 * The names are the ones the reader will meet next in `/connect`'s own action
 * picker (`Sign in to …`, `Connect with an API key`), not the service names.
 * @param capabilities - which optional seams this deployment mounts.
 * @param signIns - how many authorization flows are registered.
 * @returns the row.
 */
function connectingCheck(capabilities: ConnectCapabilities, signIns: number): SetupCheck {
  const ways: string[] = []
  if (capabilities.credentials && capabilities.settings) ways.push('API key')
  if (capabilities.authorization && signIns > 0) ways.push('account sign-in')
  if (ways.length === 0) {
    return {
      mark: '⚠',
      name: 'Connecting',
      detail: 'this profile mounts nothing that can configure a provider',
      notes: [
        capabilities.authorization
          ? 'No plugin has registered an authorization flow, and no settings or credential provider is mounted.'
          : 'Its composition mounts no authorization seam, so no account sign-in is offered.',
        'A provider has to be configured in settings.yaml by hand until that changes.',
      ],
    }
  }
  return { mark: '✓', name: 'Connecting', detail: ways.join(' · '), notes: [] }
}

/**
 * How the model situation reads as one row.
 * @param connect - the reading.
 * @returns the row.
 */
function modelsCheck(connect: ConnectState): SetupCheck {
  if (connect.kind === 'failed') {
    return { mark: '·', name: 'Models', detail: `could not be read: ${connect.message}`, notes: [] }
  }
  if (connect.kind !== 'ready') {
    return { mark: '·', name: 'Models', detail: 'not read', notes: [] }
  }
  const active = connect.providers.filter(row => row.state === 'active')
  if (active.length > 0) {
    return {
      mark: '✓',
      name: 'Models',
      detail: `${String(active.length)} route${active.length === 1 ? '' : 's'} active`
        + ` · ${active.map(row => row.provider).join(', ')}`,
      notes: [],
    }
  }
  return {
    mark: '⚠',
    name: 'Models',
    detail: 'no provider route is active, so /model has nothing to offer',
    // The pending-activation sentences are the useful half of this row when
    // they apply: they name a fix the reader is one keystroke from.
    notes: awaitingActivation(connect),
  }
}

/**
 * The whole report, as rows.
 * @param facts - what one setup pass established.
 * @returns the rows, in reading order.
 */
export function setupChecks(facts: SetupFacts): SetupCheck[] {
  const connect = facts.connect
  const capabilities: ConnectCapabilities = connect.kind === 'ready'
    ? connect.capabilities
    // A reading that did not land says nothing about which seams are mounted,
    // and the `Connecting` row reports that rather than assuming absence.
    : { settings: false, credentials: false, authorization: false }
  const signIns = connect.kind === 'ready' ? connect.signIns.length : 0
  return [
    // No mark: this process is already running on it, so a tick would be
    // circular and a warning would need a semver range evaluator.
    { mark: '·', name: 'Node', detail: facts.node, notes: [] },
    { mark: '·', name: 'dshline', detail: facts.dshline, notes: [] },
    harnessCheck(facts.harness),
    facts.profile === undefined
      ? { mark: '·', name: 'Profile', detail: 'could not be determined', notes: [] }
      : { mark: '✓', name: 'Profile', detail: facts.profile, notes: [] },
    connectingCheck(capabilities, signIns),
    modelsCheck(connect),
  ]
}

/**
 * Whether the report has anything a reader has to act on.
 * @param checks - the rows.
 * @returns whether any row is marked `⚠`.
 */
export function hasWarning(checks: readonly SetupCheck[]): boolean {
  return checks.some(check => check.mark === '⚠')
}

/**
 * What setup offers to do next, given what it just read.
 *
 * Ordered by what the reader most likely needs, and filtered by what the
 * mounted seams would actually accept — so no offer here can open a surface
 * that has nothing in it.
 * @param facts - what one setup pass established.
 * @returns the offered steps, most useful first; never empty.
 */
export function setupSteps(facts: SetupFacts): SetupStep[] {
  const connect = facts.connect
  const steps: SetupStep[] = []
  const active = hasActiveRoute(connect)
  const canConfigure = connect.kind === 'ready'
    && (connect.capabilities.settings || connect.capabilities.credentials || connect.capabilities.authorization)
  if (canConfigure) {
    steps.push({
      id: 'connect',
      label: active ? 'Connect another provider' : 'Connect a provider',
      description: 'Opens /connect: sign in to an account, store an API key, or activate a route',
    })
  }
  if (active) {
    steps.push({
      id: 'model',
      label: 'Choose a model',
      description: 'Opens /model over the routes that are active now',
    })
  }
  steps.push({
    id: 'skip',
    // Worded from what is true rather than from a fixed script: with a model
    // ready this is the ordinary way out, and with nothing configured it is a
    // deferral the reader may well want.
    label: active ? 'Start the session' : 'Not now',
    description: active
      ? 'Go to the composer with what is configured'
      : 'Go to the composer; run /setup again whenever you want this back',
  })
  return steps
}

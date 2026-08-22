/**
 * `/connect`: configuring and authenticating Harness providers from a terminal.
 *
 * The division of labour is the same one the rest of this frontend follows, and
 * it is worth stating plainly because provider configuration is where a TUI is
 * most tempted to grow its own opinions. Harness owns the provider directory,
 * the settings document, the credential store, and every login flow. dsh-tui
 * owns the rows, the keyboard, and where a sign-in URL lands. There is no
 * provider registry here, no OAuth implementation, and no `if (provider ===
 * 'openai')`: a route reaches this browser because a mounted adapter declared
 * it configurable, and it is configured through the seam that owns it.
 *
 * That is also why a change made here shows up in the official web Models page
 * and the other way round. Both surfaces write the same settings namespace
 * through `ctx.settings` and the same reference through `ctx.credentials`;
 * neither has a store of its own to disagree from. The `<ROUTE>_API_KEY`
 * derivation is shared for exactly this reason — a key stored from the terminal
 * has to be the reference the web page reads.
 *
 * `/model` is the other half of the pair and stays what it was: choosing among
 * models that already exist. `/connect` is how a model comes to exist.
 * @module @riesbri/dsh-tui/connect
 */

import type { Context } from '@deepseek-ai/cordis'
import { style } from '@riesbri/dsh-tui-renderer'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'
import { activateRoute, clearApiKey, deactivateRoute, forgetSignIn, setApiKey } from './actions.ts'
import type { ConnectActionOutcome } from './actions.ts'
import { runAuthorization } from './authorize.ts'
import { ConnectCatalog, watchAdapters } from './catalog.ts'
import { connectSeams } from './harness.ts'
import type { ConnectSeams } from './harness.ts'
import type { ConnectAction, ConnectProviderRow, ConnectRow, ConnectSignInRow } from './model.ts'
import { noActionsReason, rowActions } from './model.ts'
import { createConnectOverlay } from './overlay.ts'
import type { ConnectOverlay } from './overlay.ts'

export type {
  ConnectCredentials,
  ConnectLlm,
  ConnectSeams,
  ConnectSettings,
  ConnectAuthorization,
} from './harness.ts'
export { connectSeams } from './harness.ts'
export { ConnectCatalog, watchAdapters } from './catalog.ts'
export type { ConnectCatalogSpec } from './catalog.ts'
export type { ConnectActionOutcome } from './actions.ts'
export { activateRoute, clearApiKey, deactivateRoute, forgetSignIn, setApiKey } from './actions.ts'
export { noticeLines, runAuthorization } from './authorize.ts'
export type {
  ConnectAction,
  ConnectActionId,
  ConnectCapabilities,
  ConnectProviderRow,
  ConnectReadiness,
  ConnectRow,
  ConnectRouteState,
  ConnectSignInRow,
  ConnectState,
} from './model.ts'
export {
  derivedCredentialRef,
  filterRows,
  matchesRow,
  noActionsReason,
  providerDetail,
  providerFacts,
  providerReadiness,
  rowActions,
  signInDetail,
  signInFacts,
} from './model.ts'
export { createConnectOverlay } from './overlay.ts'
export type { ConnectOverlay, ConnectOverlaySpec } from './overlay.ts'
export { credentialRefFields, profileNode, valueAt } from './schema.ts'

/** What opening the browser needs from the window it opens over. */
export interface ConnectSpec {
  /** Context carrying the harness seams and the slot registry. */
  readonly ctx: Context
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** Text the browser's query box opens with, from `/connect <name>`. */
  readonly query?: string
  /** Current time; injected so notice expiry is assertable. */
  readonly now?: () => number
}

/**
 * Every configurable route, for completing `/connect`'s argument.
 *
 * The directory, not the registry: a route worth naming here is most often one
 * that is NOT live yet, which is exactly what `listProviders()` would omit.
 * @param ctx - context carrying the model registry.
 * @returns each route key beside the name its adapter chose.
 */
export function listConnectTargets(ctx: Context): readonly { value: string; note: string }[] {
  return ctx.llm.listConfigurableProviders()
    .map(entry => ({ value: entry.provider, note: entry.displayName }))
}

/**
 * Show the Connect browser and stay until the reader closes it.
 *
 * Unlike the Sessions browser this resolves with nothing: every action it can
 * take has already been taken through the owning seam by the time it returns,
 * and none of them changes what the window is attached to.
 * @param spec - the context and where transcript rows go.
 * @returns when the browser is closed.
 */
export async function openConnect(spec: ConnectSpec): Promise<void> {
  const { ctx, commit } = spec
  const seams = connectSeams(ctx)
  const catalog = new ConnectCatalog({ seams, invalidate: () => { ctx.tuiSlots.invalidate() } })
  catalog.refresh()
  const unwatch = watchAdapters(ctx, catalog)
  let overlay!: ConnectOverlay
  // One action at a time. An action opens its own overlays and awaits a human,
  // so a second `enter` arriving underneath would run two writes against one
  // settings revision and the later one would be refused as a conflict.
  let busy = false
  try {
    await new Promise<void>(resolve => {
      let dismiss = (): void => {}
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        dismiss()
        resolve()
      }
      overlay = createConnectOverlay({
        state: () => catalog.state(),
        ...spec.query === undefined || spec.query === '' ? {} : { query: spec.query },
        refresh: () => { catalog.refresh() },
        act: row => {
          if (busy) return
          busy = true
          void perform(spec, seams, row)
            .then(outcome => {
              if (outcome !== undefined) {
                // Both: the notice answers the keystroke where the reader is
                // looking, and the committed row is the durable evidence a
                // configuration change happened in this session.
                overlay.report(outcome.message, outcome.kind === 'failed')
                commit([style(
                  `${outcome.kind === 'failed' ? '✗' : '·'} connect: ${outcome.message}`,
                  outcome.kind === 'failed' ? 'red' : 'gray',
                )])
              }
              catalog.refresh()
            })
            .finally(() => { busy = false })
        },
        now: spec.now ?? ((): number => Date.now()),
        close: settle,
        invalidate: () => { ctx.tuiSlots.invalidate() },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
    })
  } finally {
    unwatch()
    catalog.dispose()
  }
}

/**
 * Offer what Harness allows for one row, and do what the reader chose.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param row - the selected row.
 * @returns the outcome to report, or undefined when the reader chose nothing.
 */
async function perform(
  spec: ConnectSpec,
  seams: ConnectSeams,
  row: ConnectRow,
): Promise<ConnectActionOutcome | undefined> {
  const { ctx } = spec
  const capabilities = {
    settings: seams.settings !== undefined,
    credentials: seams.credentials !== undefined,
    authorization: seams.authorization !== undefined,
  }
  const actions = rowActions(row, capabilities)
  if (actions.length === 0) {
    return { kind: 'failed', message: noActionsReason(row, capabilities) }
  }
  const picked = await promptSelect(ctx, {
    title: row.kind === 'provider' ? `Configure ${row.provider}` : `Sign in · ${row.label}`,
    detail: subtitle(row),
    choices: actions.map(action => ({
      value: action.id,
      label: action.label,
      description: action.description,
    })),
  })
  if (picked === undefined) return undefined
  const action = actions.find(candidate => candidate.id === picked)
  if (action === undefined) return undefined
  return row.kind === 'provider'
    ? providerAction(spec, seams, row, action)
    : signInAction(spec, seams, row, action)
}

/**
 * Carry out one provider action.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param row - the provider row.
 * @param action - what the reader chose.
 * @returns the outcome, or undefined when a required answer was dismissed.
 */
async function providerAction(
  spec: ConnectSpec,
  seams: ConnectSeams,
  row: ConnectProviderRow,
  action: ConnectAction,
): Promise<ConnectActionOutcome | undefined> {
  switch (action.id) {
    case 'set-key': {
      const typed = await promptText(spec.ctx, {
        title: `API key · ${row.provider}`,
        message: `Paste the key ${row.displayName} issued you.`,
        detail: action.description,
        kind: 'secret',
      })
      // Dismissed rather than answered: nothing was written, so nothing is said.
      if (typed === undefined) return undefined
      return setApiKey(seams, row, typed)
    }
    case 'clear-key':
      return clearApiKey(seams, row)
    case 'activate':
      return activateRoute(seams, row)
    case 'deactivate':
      return deactivateRoute(seams, row)
    default:
      return undefined
  }
}

/**
 * Carry out one sign-in action.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param row - the sign-in row.
 * @param action - what the reader chose.
 * @returns the outcome, or undefined when a required answer was dismissed.
 */
async function signInAction(
  spec: ConnectSpec,
  seams: ConnectSeams,
  row: ConnectSignInRow,
  action: ConnectAction,
): Promise<ConnectActionOutcome | undefined> {
  if (action.id === 'sign-out') return forgetSignIn(seams, row)
  if (action.id !== 'sign-in') return undefined
  const { authorization } = seams
  if (authorization === undefined) {
    return { kind: 'failed', message: 'this profile mounts no authorization service' }
  }
  const method = await chooseMethod(spec.ctx, row)
  if (method === undefined && row.methods.length > 1) return undefined
  return runAuthorization({
    ctx: spec.ctx,
    authorization,
    key: row.key,
    label: row.label,
    ...method === undefined ? {} : { method },
    commit: spec.commit,
  })
}

/**
 * Ask which of a flow's methods to run, when there is a choice.
 *
 * A flow's methods are ordered most-preferred-first and the seam takes the
 * first when a caller names none, so one method costs no picker.
 * @param ctx - context carrying the slot registry.
 * @param row - the sign-in row.
 * @returns the method id, or undefined when there was no choice to make or the
 *   reader dismissed it.
 */
async function chooseMethod(ctx: Context, row: ConnectSignInRow): Promise<string | undefined> {
  if (row.methods.length <= 1) return undefined
  return promptSelect(ctx, {
    title: `Sign in · ${row.label}`,
    detail: 'Harness offers more than one way to obtain this credential.',
    choices: row.methods.map(method => ({ value: method.id, label: method.label })),
  })
}

/**
 * The line under an action picker's title, naming what is being changed.
 * @param row - the selected row.
 * @returns the subtitle.
 */
function subtitle(row: ConnectRow): string {
  return row.kind === 'provider'
    ? `${row.displayName} · ${row.state} · configured in ${row.settingsNs}`
    : `${row.key}${row.record?.configured === true ? ' · signed in' : ''}`
}

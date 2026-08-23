/**
 * The window: one terminal, and however many sessions are opened in it.
 *
 * This split did not have to exist while a launch drove exactly one session for
 * the life of the process — the plugin fiber and the session were the same
 * lifetime, so `ctx.effect` was the right owner for everything. `/sessions` can
 * retire one agent and attach another, which separates the two:
 *
 * ```
 * window       terminal, key routing, model route, reader preferences
 *    ↓ attaches
 * attachment   one Agent, its log projection, its adapters, its views
 * ```
 *
 * Key routing in particular belongs here. `ctrl-d` must quit from everywhere —
 * including the session browser that runs before any agent exists, and the gap
 * between two attachments where no session owns input — and only something
 * outliving the session can promise that. The previous launch picker had to
 * re-implement quitting, painting, and key reading precisely because there was
 * nothing above it to inherit them from.
 * @module dshline/window
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
// Carries the Context merges this module reads but does not otherwise import
// from: the launcher's settlement await and exit request, and the default model
// selection. Neither has to be mounted for the frontend to run.
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Key, Terminal } from '@dshline/renderer'
import { acquireTerminal, Screen } from '@dshline/renderer'
import type { CardDetail } from './cards.ts'
import { pluginsSeams } from './plugins/harness.ts'
import { resolveSessionPreset, sessionBlank } from './plugins/model.ts'
import type { PluginsSessionFacts } from './plugins/model.ts'
import { browseSessions } from './sessions/index.ts'
import type { AttachTarget } from './sessions/reopen.ts'
import type { TuiStartupOptions } from './startup.ts'
import type { PeakWindow, PricingTable, UsageMode } from './usage.ts'

/**
 * Mutable presentation preferences that outlive one session.
 *
 * The reader's settings are not facts about a session: reopening one should not
 * silently put the usage meter back to cost or re-expand tool cards they had
 * folded away. The model route is not here because it already has an owner —
 * {@link ModelSelectionRef} — which the agent reads per step.
 */
export interface WindowPrefs {
  /** What the status line reports. */
  usageMode: UsageMode
  /** Whether each turn is charted under its reply. */
  profiling: boolean
  /** How much of a tool card is drawn. */
  cardDetail: CardDetail
}

/**
 * Model metadata resolved once per selection, for the views that read it.
 *
 * Held on the window rather than per session because it describes the ROUTE, and
 * the route survives reopening a session. One resolve answers three questions:
 * the context bar's denominator, what `/reasoning` may offer, and whether the
 * status line should name the level at all.
 */
export interface ModelInfo {
  /** The model's context window, when the adapter reported one. */
  contextWindow: number | undefined
  /** The route's reasoning capability, when it has one. */
  reasoning: LlmModelReasoningInfo | undefined
}

/** What a deployment configured, gathered before the window exists. */
export interface WindowOptions {
  /** Rates for the usage meter, already validated. */
  readonly pricing: PricingTable
  /** When those rates charge the standard price. */
  readonly peakHours: readonly PeakWindow[]
  /** Version reported in each attachment's banner. */
  readonly version: string
}

/** One terminal, and the state every session opened in it shares. */
export interface Window {
  /** Context with the slot registry and the harness services. */
  readonly ctx: Context
  /** The terminal this window owns. */
  readonly terminal: Terminal
  /** The launcher's exit request, when it provided one. */
  readonly exit: ((code: number) => void) | undefined
  /** This invocation's parsed arguments. */
  readonly startup: TuiStartupOptions
  /** Rates for the usage meter, already validated. */
  readonly pricing: PricingTable
  /** When those rates charge the standard price. */
  readonly peakHours: readonly PeakWindow[]
  /** Version reported in each attachment's banner. */
  readonly version: string
  /** The route the next turn will use; the agent reads it per step. */
  readonly selection: ModelSelectionRef
  /** Metadata for that route, refreshed when it changes. */
  readonly modelInfo: ModelInfo
  /** Reader preferences that survive reopening a session. */
  readonly prefs: WindowPrefs
  /**
   * The launch task, consumed by the first attachment.
   *
   * Cleared once submitted: a session reopened from inside the window must not
   * replay the command line's opening prompt.
   */
  pendingTask: string | undefined
  /** Repaint the live region. */
  readonly draw: () => void
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** Re-resolve {@link ModelInfo} after the route changes. */
  readonly refreshModelInfo: () => void
  /** Route decoded keys to the attached session, or to nothing between two. */
  readonly setDispatch: (handler: ((key: Key) => void) | undefined) => void
}

/**
 * Take the terminal and wait for the Loader, before any agent exists.
 *
 * The Loader mounts siblings concurrently, so this waits for the whole tree
 * before an attachment creates an Agent — a row that had not activated yet would
 * otherwise be missing from the agent's registries.
 * @param ctx - context with the slot registry available.
 * @param options - deployment configuration for every attachment.
 * @returns the window, ready to attach a session.
 */
export async function createWindow(ctx: Context, options: WindowOptions): Promise<Window> {
  const exit = ctx.get('appExit')
  const startup = ctx.tuiStartup.options
  const terminal = acquireTerminal({ input: process.stdin, output: process.stdout })
  const screen = new Screen(terminal)
  ctx.effect(() => () => {
    screen.close()
    terminal.close()
  }, 'dshline: terminal ownership')

  const draw = (): void => {
    const { lines, cursor } = ctx.tuiSlots.compose(terminal.columns(), terminal.rows())
    if (cursor === undefined) screen.setLive(lines)
    else screen.setLive(lines, cursor)
  }

  const commit = (lines: readonly string[]): void => {
    if (lines.length === 0) return
    screen.commit(lines)
  }

  // One keyboard subscription for the whole window, delegating to whoever owns
  // input now. `ctrl-d` is read here, before any delegate: it means the same
  // thing everywhere, and the places it used to be re-implemented — the launch
  // picker's own key loop — are exactly the places it went missing.
  let dispatch: ((key: Key) => void) | undefined
  ctx.effect(() => terminal.onKey(key => {
    if (key.kind === 'key' && key.name === 'ctrl-d') {
      exit?.(0)
      return
    }
    dispatch?.(key)
  }), 'dshline: input')
  ctx.effect(() => ctx.on('tui/render', draw), 'dshline: redraw on slot change')
  ctx.effect(() => terminal.onResize(draw), 'dshline: redraw on resize')

  await ctx.get('loader')?.await()
  const selection: ModelSelectionRef = {
    current: ctx.get('agentDefaultModel')?.currentSelection(),
    assembled: undefined,
  }
  const modelInfo: ModelInfo = { contextWindow: undefined, reasoning: undefined }
  // Resolved once per selection: the context window and the reasoning levels are
  // both model metadata, and asking the adapter on every frame would put an await
  // in the render path.
  const refreshModelInfo = (): void => {
    const current = selection.current
    modelInfo.contextWindow = undefined
    modelInfo.reasoning = undefined
    if (current === undefined) return
    void ctx.llm.resolveModelInfo(current.provider, current.model)
      .then(info => {
        modelInfo.contextWindow = info.context?.contextWindow
        modelInfo.reasoning = info.reasoning
        ctx.tuiSlots.invalidate()
      })
      // An adapter that cannot describe the model leaves the window unknown; the
      // status line then shows pressure without a denominator.
      .catch(() => {})
  }
  refreshModelInfo()
  return {
    ctx,
    terminal,
    exit,
    startup,
    pricing: options.pricing,
    peakHours: options.peakHours,
    version: options.version,
    selection,
    modelInfo,
    prefs: { usageMode: 'cost', profiling: false, cardDetail: 'compact' },
    pendingTask: startup.task,
    draw,
    commit,
    refreshModelInfo,
    setDispatch: handler => { dispatch = handler },
  }
}

/**
 * Route and setup for the next agent this window attaches.
 *
 * Read at attach time rather than once, because `/model` writes the selection
 * and the session opened after it must use what is selected now.
 * @param w - the window attaching a session.
 * @returns the per-agent options shared by the create and resume paths.
 */
export function attachOptions(w: Window): Omit<ResumeAgentOptions, 'resumeSessionId'> {
  const current = w.selection.current
  return {
    ...current === undefined ? {} : { agentOptions: { provider: current.provider, model: current.model } },
    setup: async agentCtx => {
      installModelSelection(agentCtx, w.selection)
      await mountAgentPreset(agentCtx)
    },
  }
}

/**
 * The preset a session from before this frontend adopted presets resumes
 * under, when its log names none. `standard` specifically, not today's
 * roster default: a produced session's composition is a historical fact,
 * and the deployment's default may have moved to `minimal`, `code`, or a
 * local custom preset since that session last ran. `standard` is what every
 * one of those sessions actually ran under before presets existed here —
 * dshline mounted the full flat `dsh-base` tool set unconditionally, and
 * `standard` is the shipped preset built to mean exactly that set.
 */
const LEGACY_SESSION_PRESET = 'standard'

/**
 * Compose this agent from its resolved Harness preset, when a preset roster
 * is mounted.
 *
 * Three cases, in order:
 *
 * 1. The session's own log names one — `resolveSessionPreset` walks it,
 *    newest `agent-preset/selected` first, then the creation header — and
 *    that recorded choice always wins. This is every session created since
 *    presets existed here (a new one's header is stamped before `create`;
 *    see `sessions/reopen.ts`), and any session an explicit `/plugins`
 *    switch touched.
 * 2. Nothing is recorded AND the session has already produced a turn: a
 *    session from before this frontend adopted presets. Resuming it under
 *    TODAY's default would silently rebuild history that was actually
 *    produced under the old flat `dsh-base` composition, so it mounts
 *    {@link LEGACY_SESSION_PRESET} instead — a real preset id, not a
 *    fallback that pretends nothing changed. A non-stock deployment that
 *    genuinely ships no `standard` preset fails this resume outright
 *    (`mount` rejects an unknown id, which rolls the resume back per
 *    `setup`'s own contract) rather than guessing a different composition
 *    for a session it cannot honestly place.
 * 3. Nothing is recorded and the session is still blank: there is no
 *    history to protect, so the roster's current default applies, exactly
 *    like any other new session.
 *
 * `agentCtx.agent` is set before `setup` runs (dsh-agent-loop mints the
 * Agent, including a resumed session's already-reconstructed log, before
 * calling `setup(prepared.agent.ctx)`), so this reads the real session
 * facts rather than guessing from context.
 *
 * A profile that mounts no `agentPresets` seam at all leaves this a no-op.
 * That restores dshline's old flat behavior only for a composition that
 * never applied dshline's own agent-plane disable list in the first place
 * (a custom deployment mounting dshline's plugin code over its own already-
 * flat host plane) — the STOCK `cordis.patch.yml` disables those `dsh-base`
 * rows unconditionally, so simply removing the `agent-presets` row from an
 * otherwise-stock dshline composition leaves an agent with no tools at all,
 * not the old flat set back.
 * @param agentCtx - the unpublished agent's own scope context.
 */
export async function mountAgentPreset(agentCtx: Context): Promise<void> {
  const agentPresets = pluginsSeams(agentCtx).agentPresets
  if (agentPresets === undefined) return
  const session = agentCtx.agent?.session
  const facts: PluginsSessionFacts = session === undefined
    ? { headerPreset: undefined, events: [] }
    : { headerPreset: session.header.agentPreset, events: session.events }
  const recorded = resolveSessionPreset(facts)
  const id = recorded ?? (sessionBlank(facts) ? agentPresets.defaultId : LEGACY_SESSION_PRESET)
  await agentPresets.mount(agentCtx, id)
}

/**
 * Ask which session to open, while no agent is attached.
 *
 * Runs before the first attachment, and again whenever reopening one failed:
 * both are moments where the window holds a terminal and no session, and the
 * useful question is the same one. Nothing for the resume plan to refuse, since
 * there is no session to leave.
 *
 * It needs no keyboard of its own. The window's routing is already installed and
 * already redraws on `tui/render`, so pushing the overlay paints it and `ctrl-d`
 * still leaves.
 * @param w - the window whose input routing the browser borrows.
 * @returns the chosen session, or a fresh one when the reader dismissed it.
 */
export async function chooseTarget(w: Window): Promise<AttachTarget> {
  const { ctx } = w
  w.setDispatch(key => { ctx.tuiSlots.activeOverlay?.handleKey(key) })
  try {
    const chosen = await browseSessions({
      ctx,
      currentSessionId: undefined,
      busy: () => false,
      activeWork: () => 0,
    })
    return chosen === undefined ? { kind: 'new', afterDismissal: true } : { kind: 'resume', id: chosen }
  } finally {
    w.setDispatch(undefined)
  }
}

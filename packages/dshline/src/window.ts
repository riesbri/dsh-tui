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
import type { ColorDepth, Key, Palette, Terminal } from '@dshline/renderer'
import { acquireTerminal, escapeControls, paint, Screen, setPalette } from '@dshline/renderer'
import { DEFAULT_PALETTE } from './theme.ts'
import { FALLBACK_THEME, findTheme } from './themes/builtin.ts'
import type { ThemeSettings } from './themes/settings.ts'
import type { CardDetail } from './cards.ts'
import { pluginsSeams } from './plugins/harness.ts'
import type { AgentPresetsSeam } from './plugins/harness.ts'
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
  /** Whether the persistent live timing panel is shown. */
  timing: boolean
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
  /** The theme section this frontend registered; the authority for the choice. */
  readonly themeSettings: ThemeSettings
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
  /** The theme section, for reading the current choice and storing a new one. */
  readonly themeSettings: ThemeSettings
  /** What this terminal can actually show, resolved once when it opened. */
  readonly colorDepth: ColorDepth
  /**
   * The palette in force.
   *
   * This is PRESENTATION state — what the renderer is drawing with. The chosen
   * theme itself has one authority, {@link Window.themeSettings}, and the two
   * agree except in the one documented case: a switch whose write failed has
   * already changed the terminal, and is not put back. `/theme` reports that
   * rather than hiding it, and picking the same theme again retries the write.
   */
  readonly palette: () => Palette
  /**
   * Install a palette for this window.
   *
   * Replaces rather than stacks: the previous one is released first, so a
   * reader trying five themes leaves one live registration and not five.
   * @param next - the palette to make current.
   */
  readonly setPalette: (next: Palette) => void
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
 * How much colour this terminal can show.
 *
 * Node already decides this, and decides it better than a rule table here
 * would: `getColorDepth` honours `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, and
 * `TERM`, and also the CI variables and Windows build numbers that a
 * hand-written version forgets. Owning that policy meant maintaining it, and
 * being wrong about it quietly; deferring costs one mapping.
 *
 * Node reports BITS, where 1 means monochrome. The renderer's 0 says the same
 * thing more usefully — it is the depth at which `paint` returns its input
 * untouched — so only that value is translated.
 * @returns the depth to install a palette at.
 */
function terminalColorDepth(): ColorDepth {
  // A non-tty `process.stdout` is a plain stream with no such method. dshline
  // refuses to start without a terminal, so this is belt and braces rather than
  // a path anyone reaches.
  if (typeof process.stdout.getColorDepth !== 'function') return 0
  const bits = process.stdout.getColorDepth()
  return bits === 1 ? 0 : (bits as ColorDepth)
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
  // Installed here, and before the screen exists, because this is the one
  // place already coupled to the real `process` streams — the renderer reads
  // no ambient state of its own, so somebody who legitimately owns the
  // environment has to hand it the answer. The loop awaits `createWindow`
  // before it attaches anything, so no row is ever composed under the wrong
  // palette. It belongs to the WINDOW rather than a session: reopening one
  // must not put the reader’s colours back, exactly as it must not put the
  // usage meter back to cost.
  const colorDepth = terminalColorDepth()
  // Harness resolves the layers; this only maps the id onto a shipped palette.
  // An id the schema let through that names nothing shipped falls back rather
  // than failing a boot over a colour.
  const resolved = (): Palette => findTheme(options.themeSettings.current()) ?? FALLBACK_THEME
  let palette = resolved()
  let releasePalette = setPalette(palette, colorDepth)
  // Released and reinstalled rather than stacked, so a reader who tries five
  // themes leaves one live registration and not five. The disposer is safe to
  // call twice, which is what keeps the teardown below independent of this.
  const installPalette = (next: Palette): void => {
    releasePalette()
    palette = next
    releasePalette = setPalette(next, colorDepth)
  }
  ctx.effect(() => () => { releasePalette() }, 'dshline: palette')
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

  // A theme is a live preference: the settings document edited by hand while a
  // session runs repaints this window, without it having to be reopened. Only
  // the live region changes — rows already committed to the terminal keep the
  // colours they were printed with, as everything committed does.
  //
  // Guarded on the id because this fires for our OWN write too, and
  // reinstalling the palette already in force would churn the registration
  // for nothing.
  ctx.effect(() => options.themeSettings.watch(() => {
    const next = resolved()
    if (next.id === palette.id) return
    installPalette(next)
    draw()
  }), 'dshline: theme changes')

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
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact' },
    colorDepth,
    palette: () => palette,
    setPalette: installPalette,
    themeSettings: options.themeSettings,
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
      await mountAgentPreset(agentCtx, w.commit)
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
 *    produced under the old flat `dsh-base` composition, so it prefers
 *    {@link LEGACY_SESSION_PRESET} instead — a real preset id, not a
 *    fallback that pretends nothing changed. A non-stock deployment that
 *    ships no usable `standard` falls back to the roster's default and SAYS
 *    so (see {@link legacyPresetId}): refusing the resume outright would
 *    leave that deployment unable to open its own history at all, which
 *    protects a composition record by withholding the transcript it belongs
 *    to.
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
 * @param report - where to say that a legacy session could not be placed on
 * {@link LEGACY_SESSION_PRESET}; called only after the substitute preset has
 * actually mounted, so a failed resume never claims to have run under one.
 * Omitted stays silent, which is what the unit tests and a headless embedder
 * want.
 */
export async function mountAgentPreset(
  agentCtx: Context,
  report?: (lines: readonly string[]) => void,
): Promise<void> {
  const agentPresets = pluginsSeams(agentCtx).agentPresets
  if (agentPresets === undefined) return
  const session = agentCtx.agent?.session
  const facts: PluginsSessionFacts = session === undefined
    ? { headerPreset: undefined, events: [] }
    : { headerPreset: session.header.agentPreset, events: session.events }
  const recorded = resolveSessionPreset(facts)
  const chosen = recorded !== undefined || sessionBlank(facts)
    ? { id: recorded ?? agentPresets.defaultId, caveat: [] as readonly string[] }
    : await legacyPreset(agentPresets)
  // Mount BEFORE reporting: `mount` rejecting rolls the whole resume back per
  // `setup`'s own contract, and a caveat emitted first would describe a
  // composition this session never ran under.
  await agentPresets.mount(agentCtx, chosen.id)
  if (chosen.caveat.length > 0) report?.(chosen.caveat)
}

/**
 * The preset an unstamped, already-produced session resumes under, and the
 * caveat that choice owes the reader — decided here, but NOT yet announced.
 *
 * Checked rather than assumed, and reported rather than fatal. `standard` is
 * the honest answer only where it exists: a deployment that ships its own
 * roster may have no `standard` at all, and `resolve()` deliberately succeeds
 * for a BROKEN preset (the roster still needs a row to show and delete), so
 * presence alone is not usability — `mount` would reject a broken one just as
 * it rejects an unknown one. Either way, hard-failing here would make old
 * transcripts unopenable on that deployment, trading a composition record the
 * reader cannot see for a transcript they can. Falling back and naming the
 * substitution keeps both facts: the session opens, and nobody is told its
 * tool set is the one its history was produced under.
 *
 * The caveat is RETURNED rather than emitted because the fallback id can still
 * fail to mount — a default that is itself broken, or a roster that moved
 * between this read and the mount. Announcing "resumed under X" from here
 * would put that sentence in the transcript of a resume that then rolled back
 * and never ran under X at all, which is a worse lie than the silence it was
 * added to break. {@link mountAgentPreset} emits it only once `mount`
 * succeeds.
 * @param agentPresets - the preset roster seam.
 * @returns the preset id to mount, and the lines to report once it has.
 */
async function legacyPreset(
  agentPresets: AgentPresetsSeam,
): Promise<{ readonly id: string; readonly caveat: readonly string[] }> {
  try {
    const legacy = await agentPresets.resolve(LEGACY_SESSION_PRESET)
    if (legacy.broken === undefined) return { id: LEGACY_SESSION_PRESET, caveat: [] }
  } catch {
    // An unknown id and a broken composition are the same answer here: this
    // deployment cannot place the session on the preset its history matches.
  }
  const fallback = agentPresets.defaultId
  return {
    id: fallback,
    caveat: [
      paint(`· this session predates agent presets and no usable "${LEGACY_SESSION_PRESET}" preset is installed`, 'muted'),
      paint(`· resumed under ${escapeControls(fallback)}; its tools may differ from the ones its history was produced with`, 'muted'),
    ],
  }
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

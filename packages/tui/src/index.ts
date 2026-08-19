/**
 * The interactive terminal runner.
 *
 * A resident, multi-turn version of the one-shot direct driver: wait for the
 * Loader to settle, create one Agent, then drive it with `followup` while idle
 * and `steer` while running, projecting its session log into the terminal.
 *
 * The Loader mounts siblings concurrently, so the runner waits for the whole
 * tree before creating an Agent — a row that had not activated yet would
 * otherwise be missing from the agent's registries. Because this bundle composes
 * no preset roster, the model-facing tool rows sit in the host plane and the
 * agent reads them from the global layer.
 * @module @riesbri/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports carry the Context merges this runner reads but does not
// otherwise import from: the questions seam, the default model selection, and the
// launcher's settlement await and exit request. The command registry is imported
// for its parser as well as its merge, so this frontend decides what a command
// LINE is by the same rule the registry resolves one with.
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-agent-default-model'
// Both carry `SessionEventMap` merges this runner reads: `plan/mode` is folded
// below, and the goal package also carries the `ctx.goals` service type. Neither
// is a peer dependency, because neither has to be MOUNTED for this frontend to
// run — a profile without them simply never reports either state.
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-cmdline'
// `fs` is read optionally for path completion: a profile that mounts no filesystem
// offers none rather than failing, so this carries the type without a hard need.
import type {} from '@deepseek-ai/dsh-fs'
import type { Key } from '@riesbri/dsh-tui-renderer'
import { acquireTerminal, Composer, escapeControls, Screen, SPINNER_INTERVAL_MS, style } from '@riesbri/dsh-tui-renderer'
import { CARD_DETAIL_CYCLE, ToolCards } from './cards.ts'
import { installApprovalAnswerer } from './approval.ts'
import { createCompletion } from './completion.ts'
import { historyLines, InputHistory } from './history.ts'
import { routeInputKey } from './input.ts'
import { isTranscriptEvent, pickSession, readTranscript, resumeBanner } from './resume.ts'
import { listModelOptions, pickModel } from './model.ts'
import { installQuestionProvider } from './questions.ts'
import { LocalCommandRegistry } from './local-commands.ts'
import type { LocalCommandChoice } from './local-commands.ts'
import { TuiSlots } from './slots.ts'
import { StreamBuffer } from './stream.ts'
import { effortLabel, pickReasoning, reasoningValues } from './reasoning.ts'
import { profileLines, TurnProfiler } from './profile.ts'
import { goalReading, planModeAfter } from './modes.ts'
import { commandEcho, commandLines, projectEvent } from './transcript.ts'
import { promptSelect } from './select.ts'
import type { ModelRates, PeakWindow, PricingTable, UsageMode } from './usage.ts'
import { formatUsage, parsePeakWindows, pricingFrom, resolveUsageMode, SessionUsage, USAGE_MODES } from './usage.ts'
import { bannerLines, createComposerView, createStatusView } from './views.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tui'

/**
 * The runner needs the invocation, the agent registry, the interaction seams,
 * and the model registry. `tuiStartup` is published only on an interactive
 * launch, so a piped run leaves this row unmounted.
 */
export const inject = ['tuiStartup', 'agents', 'userQuestions', 'commands', 'llm', 'tools']

export type { TuiOverlay, TuiSlotName, TuiSlotView } from './slots.ts'
export { TuiSlots } from './slots.ts'

/** Reported in the banner; kept beside the code so a release bumps one place. */
const VERSION = '0.2.0'

/** What `/profile` accepts, for completing its argument. */
const PROFILE_VALUES: readonly LocalCommandChoice[] = [
  { value: 'on', note: 'Chart each turn under its reply' },
  { value: 'off', note: 'Stop charting turns' },
]

/**
 * Budget for a slash command, so a command that never settles cannot wedge the
 * composer. Commands are local operations; a model turn is not one of them.
 */
const COMMAND_TIMEOUT_MS = 120_000

/** Erase the display and home the cursor, for the `ctrl-l` gesture. */
const CLEAR_DISPLAY = '\u001b[2J\u001b[H'

/**
 * What a deployment can configure about this frontend.
 *
 * Prices are configuration rather than a shipped table because no rate is true
 * for long, and one baked into a release would keep reporting the number it was
 * built with. A route with no entry shows tokens and no money, which is the
 * honest reading — see {@link parsePricing}.
 */
export interface Config {
  /**
   * Dollars per million tokens, keyed `provider/model` — e.g.
   * `deepseek-official/deepseek-v4-flash` — or by model id alone to cover every
   * route serving it. An entry replaces the shipped rates for that key outright.
   */
  pricing?: Readonly<Record<string, ModelRates>>
  /**
   * UTC windows charged at the standard rate, as `HH:MM` pairs. Every other hour
   * is off-peak. Omitted, the provider's published schedule applies.
   */
  peakHoursUtc?: readonly { from: string; to: string }[]
}

/**
 * Mount the terminal frontend.
 * @param ctx - plugin context carrying the harness services and the invocation.
 * @param config - this row's configuration, when a bundle or patch supplied one.
 */
export function apply(ctx: Context, config?: Config): void {
  // Parsed once, at mount: a malformed price must be reported as a missing price
  // rather than re-examined on every frame the status line draws.
  const pricing = pricingFrom(config?.pricing)
  const peakHours = parsePeakWindows(config?.peakHoursUtc)
  ctx.plugin(TuiSlots)
  ctx.inject(['tuiSlots'], hostCtx => {
    // A rejected boot must be reported and exit non-zero. Discarding it would
    // leave the process alive holding a terminal it never painted, which is the
    // same silent-idle failure the non-TTY guard exists to prevent.
    run(hostCtx, pricing, peakHours).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // Carriage return included: raw mode may already be on, where a bare
      // newline leaves the next line indented to the cursor column.
      process.stderr.write(`dsh-tui: ${message}\r\n`)
      hostCtx.get('appExit')?.(1)
    })
  })
}

/**
 * Own the terminal for the life of this plugin and drive one session.
 * @param ctx - context with the slot registry available.
 * @param pricing - rates for the usage meter, already validated.
 * @param peakHours - when those rates charge the standard price.
 */
async function run(ctx: Context, pricing: PricingTable, peakHours: readonly PeakWindow[]): Promise<void> {
  const exit = ctx.get('appExit')
  const startup = ctx.tuiStartup.options
  const terminal = acquireTerminal({ input: process.stdin, output: process.stdout })
  const screen = new Screen(terminal)
  ctx.effect(() => () => {
    screen.close()
    terminal.close()
  }, 'dsh-tui: terminal ownership')

  const draw = (): void => {
    const { lines, cursor } = ctx.tuiSlots.compose(terminal.columns(), terminal.rows())
    if (cursor === undefined) screen.setLive(lines)
    else screen.setLive(lines, cursor)
  }

  const commit = (lines: readonly string[]): void => {
    if (lines.length === 0) return
    screen.commit(lines)
  }

  await ctx.get('loader')?.await()
  const selection: ModelSelectionRef = {
    current: ctx.get('agentDefaultModel')?.currentSelection(),
    assembled: undefined,
  }

  const agentOptions = selection.current === undefined
    ? {}
    : { agentOptions: { provider: selection.current.provider, model: selection.current.model } }
  const setup = (agentCtx: Context): void => { installModelSelection(agentCtx, selection) }

  // The picker runs BEFORE the agent exists, because which session to resume
  // decides which agent to make. It draws through the same slot registry the rest
  // of the frontend uses, so nothing here is a special case except the ordering.
  const resumeId = startup.resume === undefined
    ? undefined
    : startup.resume === true
      ? await pickSession(ctx, Date.now(), terminal, draw)
      : SessionId(startup.resume)
  // Either there was nothing to resume or the picker was dismissed. Opening a new
  // session anyway is the useful answer; saying so is what keeps it from looking
  // like the flag was ignored. Held until after the banner, so the transcript reads
  // in the order it happened rather than opening with a footnote.
  const resumeNote = startup.resume === true && resumeId === undefined
    ? [style('· no session resumed; starting a new one', 'gray')]
    : []

  const { agent } = resumeId === undefined
    ? await ctx.agents.create({
      sessionId: SessionId(`tui-${randomUUID()}`),
      meta: { cwd: startup.cwd },
      ...agentOptions,
      setup,
    })
    : await ctx.agents.resume({ resumeSessionId: resumeId, ...agentOptions, setup })

  // A resumed session keeps the workspace it was created in: the header is the
  // authority, and resuming into the directory that happens to be current would
  // silently re-root the conversation.
  const workspace = agent.session.header.cwd ?? startup.cwd

  const composer = new Composer()
  const history = new InputHistory()
  const composerView = createComposerView(composer, workspace)
  const stream = new StreamBuffer()
  // Scoped to the agent: a scoped tool shadows a global one, and a restricted-away
  // tool reads as absent, so the card must come from the definition that ran.
  const cards = new ToolCards(name => ctx.tools.get(name, agent), workspace)
  // A command's name arrives with `command/run` and its outcome with `command/done`,
  // so the two are paired by id exactly as a tool call is paired to its result —
  // `command/done` carries no name, and a bare `{ kind: 'success' }` has nothing
  // else to identify it by.
  const commandNames = new Map<string, string>()
  // How many command outcomes the projection has reported. `submit` reads it to
  // avoid reporting a failure the lifecycle already printed.
  let commandOutcomes = 0
  let tick = 0
  let turnStartedAt: number | undefined
  let contextWindow: number | undefined
  let reasoning: LlmModelReasoningInfo | undefined
  // Cumulative for the session, folded from the log rather than counted here, so
  // the meter reports what the provider billed.
  const usage = new SessionUsage(pricing, peakHours)
  let usageMode: UsageMode = 'cost'
  const profiler = new TurnProfiler()
  let profiling = false
  // The route the log says was in force, which is not necessarily the one
  // selected NOW: replay walks a history whose messages were produced by whatever
  // was selected then, and pricing them at today's model would bill a session's
  // whole past at whichever route it happens to end on.
  let requestRoute: { provider: string; model: string } | undefined
  // Folded rather than asked for, because the controller keeps no live mirror and
  // says so: UIs observe committed flips through `session/event`. Folding it in
  // the shared projection means a reopened session recovers it from the replay,
  // for the same reason the usage totals do.
  let planActive = false
  // Resolved once per selection: the window and the reasoning levels are both
  // model metadata, and asking the adapter on every frame would put an await in
  // the render path. One call answers three questions — the context bar's
  // denominator, what `/reasoning` may offer, and whether the status line should
  // name the level at all — so `/model` refreshing it refreshes all three.
  const refreshModelInfo = (): void => {
    const current = selection.current
    contextWindow = undefined
    reasoning = undefined
    if (current === undefined) return
    void ctx.llm.resolveModelInfo(current.provider, current.model)
      .then(info => {
        contextWindow = info.context?.contextWindow
        reasoning = info.reasoning
        ctx.tuiSlots.invalidate()
      })
      // An adapter that cannot describe the model leaves the window unknown; the
      // status line then shows pressure without a denominator.
      .catch(() => {})
  }
  refreshModelInfo()

  // Deliberately NOT registered with `ctx.commands`. That registry is shared by
  // every surface in the process, and a web client or automation server has no
  // terminal to leave, picker to open, or status line to switch. The registry
  // still supplies these commands to completion, because `/` should show what a
  // person can type rather than which service happens to answer it.
  const localCommands = new LocalCommandRegistry([
    {
      name: 'model',
      description: 'Choose the provider and model for the next turn',
      complete: async () => (await listModelOptions(ctx))
        .map(option => ({ value: option.model, note: option.provider })),
      execute: async rawInput => {
        const outcome = await pickModel(ctx, selection, rawInput)
        if (outcome !== undefined) {
          refreshModelInfo()
          commit([style(`· ${outcome}`, 'gray')])
        }
        draw()
      },
    },
    {
      name: 'profile',
      description: 'Show where the time went in each turn, under the reply',
      complete: () => PROFILE_VALUES,
      execute: rawInput => {
        const named = rawInput.trim().toLowerCase()
        if (named !== '' && named !== 'on' && named !== 'off') {
          commit([style('\u2717 /profile takes on or off, or nothing to flip it', 'red')])
          draw()
          return
        }
        // Binary, so a bare gesture flips it rather than opening a list of two.
        profiling = named === '' ? !profiling : named === 'on'
        commit([style(
          profiling ? '· turn profiler: on, from the next turn' : '· turn profiler: off',
          'gray',
        )])
        draw()
      },
    },
    {
      name: 'reasoning',
      description: 'Set how hard the model thinks, for the next turn',
      complete: () => reasoningValues(reasoning),
      execute: async rawInput => {
        // The levels are a short fixed set a person learns by heart, so
        // `/reasoning max` should not cost a picker.
        const outcome = await pickReasoning(ctx, selection, reasoning, rawInput)
        if (outcome !== undefined) commit([style(`· ${outcome}`, 'gray')])
        draw()
      },
    },
    {
      name: 'usage',
      description: 'Choose what the status line reports: cost, tokens, or nothing',
      complete: () => USAGE_MODES.map(mode => ({ value: mode.id, note: mode.description })),
      execute: async rawInput => {
        // Named or asked for, never both: an argument is the form that should not
        // cost an overlay, and the picker is where the descriptions live. The two
        // meet again at one resolve, so a typed word and a chosen row cannot drift.
        const named = rawInput.trim()
        const picked = named === ''
          ? await promptSelect(ctx, {
            title: 'What the status line reports',
            detail: `current: ${usageMode}`,
            choices: USAGE_MODES.map(mode => ({
              value: mode.id,
              label: mode.name,
              description: mode.description,
            })),
          })
          : named
        // Dismissed, so nothing changed and there is nothing to report.
        if (picked === undefined) {
          draw()
          return
        }
        const chosen = resolveUsageMode(picked)
        if (chosen === undefined) {
          const offered = USAGE_MODES.map(mode => mode.id).join(', ')
          commit([style(
            `\u2717 no usage setting named ${escapeControls(picked)}; try one of: ${offered}`,
            'red',
          )])
          draw()
          return
        }
        usageMode = chosen
        // Acknowledged by name, as `ctrl-o` is: switching a segment OFF removes the
        // only evidence the command did anything, so silence would read as failure.
        commit([style(`· usage: ${usageMode}`, 'gray')])
        draw()
      },
    },
    {
      name: 'exit',
      description: 'Leave the session, as ctrl-d does',
      execute: () => { exit?.(0) },
    },
    {
      name: 'quit',
      description: 'Leave the session, as ctrl-d does',
      execute: () => { exit?.(0) },
    },
  ])

  // Completion reads the harness through two narrow functions rather than taking a
  // context, so its rules are testable without one. `ctx.fs` is optional: a profile
  // that mounts no filesystem offers no path completion rather than failing.
  const completion = createCompletion(composer, {
    // The frontend's own gestures listed beside the registry's, so `/` shows what
    // can be typed rather than what happens to be registered.
    commands: () => [...localCommands.list(), ...ctx.commands.list(agent)]
      .sort((left, right) => left.name.localeCompare(right.name)),
    // Only this frontend's own commands offer values. A registered command
    // describes its argument as a free-text hint rather than as a list, so there
    // is nothing to enumerate, and inventing candidates for one would suggest a
    // vocabulary the handler never agreed to.
    commandArguments: name => localCommands.arguments(name),
    paths: async directory => {
      const fs = ctx.get('fs')
      if (fs === undefined) return []
      try {
        const target = await fs.resolve(directory === '' ? '.' : directory, { cwd: workspace })
        return (await fs.listDir(target)).map(entry => ({
          name: entry.name,
          directory: entry.type === 'directory',
        }))
      } catch {
        // A path that does not resolve, or a directory the policy refuses, simply
        // offers nothing: a completion list is not the place to report either.
        return []
      }
    },
  }, () => { ctx.tuiSlots.invalidate() })

  /**
   * The current goal, or nothing when there is none to report.
   * @returns the service's view, or undefined when it is absent or refuses.
   */
  const currentGoal = (): GoalView | undefined => {
    try {
      return ctx.get('goals')?.get(agent)
    } catch {
      // A goal that cannot be read is reported as no goal. The alternative is a
      // status line that stops drawing, which loses the spinner and the context
      // reading too.
      return undefined
    }
  }

  const status = createStatusView(() => ({
    busy: agent.status === 'running',
    tick,
    elapsedMs: turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt,
    model: selection.current?.model,
    effort: effortLabel(selection.current?.reasoningEffort, reasoning),
    usage: formatUsage(usage.reading, usageMode),
    tokens: ctx.get('tokenMeter')?.measure(agent.session).totalTokens,
    contextWindow,
    detail: cards.detail,
    plan: planActive,
    // Asked for at render time, as the token meter is, and for the same reason:
    // it is the authority, and it knows the one thing the log cannot say — whether
    // THIS process still holds authority to take another round. Guarded because
    // the service documents a throw, and a throw here would take the whole status
    // line down rather than one segment of it.
    goal: goalReading(currentGoal()),
  }))
  const streamView = { render: (columns: number): string[] => stream.live(columns) }

  ctx.effect(() => ctx.tuiSlots.register('stream', streamView), 'dsh-tui: streaming reply')
  ctx.effect(() => ctx.tuiSlots.register('status', status), 'dsh-tui: status line')
  ctx.effect(() => ctx.tuiSlots.register('composer', composerView), 'dsh-tui: composer')
  ctx.effect(() => ctx.tuiSlots.register('completion', completion.view), 'dsh-tui: completion list')
  ctx.effect(() => installApprovalAnswerer(ctx, () => agent), 'dsh-tui: approval answerer')
  ctx.effect(() => installQuestionProvider(ctx), 'dsh-tui: user-questions provider')

  /**
   * Report a failure in the transcript instead of discarding it. A rejected
   * submit is otherwise invisible: the composer clears, nothing happens, and
   * there is no message anywhere to explain why.
   * @param error - the thrown value.
   */
  const report = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    commit([style(`\u2717 ${escapeControls(message)}`, 'red')])
    draw()
  }

  ctx.effect(() => ctx.on('tui/render', draw), 'dsh-tui: redraw on slot change')
  ctx.effect(() => terminal.onResize(draw), 'dsh-tui: redraw on resize')

  /**
   * Everything one committed event contributes to the transcript.
   *
   * Shared by the live listener and the resume replay, which is the point: a
   * replayed session has to read exactly like the one that was watched happen, and
   * two projections would drift the first time either changed. The live path
   * commits each return immediately; the replay concatenates them and commits once.
   * @param event - the committed event.
   * @param columns - the terminal's current width.
   * @returns lines to write into scrollback.
   */
  const project = (event: SessionEvent, columns: number): string[] => {
    if (event.type === 'assistant/chunk') {
      const { chunk } = event.data
      // Reasoning is streamed as well as answered text. Dropping it left the
      // screen showing nothing but a spinner for as long as a reasoning model
      // thought, which reads as a hung process rather than a working one.
      if (chunk.type === 'text-delta') return stream.push('text', chunk.text, columns)
      if (chunk.type === 'reasoning-delta') return stream.push('reasoning', chunk.text, columns)
      return []
    }
    // Logged only when the route or its capacity changes, and always before the
    // requests it applies to — so following it here attributes each message's
    // usage to the model that actually produced it, on the live path and on the
    // replay alike.
    if (event.type === 'request/context') {
      requestRoute = { provider: event.data.provider, model: event.data.model }
    }
    planActive = planModeAfter(planActive, event)
    const lines: string[] = []
    if (event.type === 'assistant/message') {
      // Usage is folded HERE, in the projection both paths share, rather than in
      // the live listener: a resumed session replays its `assistant/message`
      // events through this function, so its totals come back on their own. A
      // separate restore path is exactly the second implementation that rule
      // about commands exists to avoid.
      //
      // A compaction REPLACEMENT copy is filtered out of the replay by design, so
      // a session compacted in an earlier run recovers the usage of what it can
      // still show. That is the same history the transcript displays; the two
      // agree, which matters more here than a total nothing on screen accounts for.
      const reported = event.data.usage
      if (reported !== undefined) {
        const route = requestRoute ?? selection.current
        // Priced by the event's OWN timestamp, not by the clock now. Peak and
        // off-peak rates differ by half, so a replayed session priced at the
        // moment it was reopened would bill a night's work at the morning rate.
        usage.observe(reported, route?.provider, route?.model, event.time)
      }
      // The buffer owns assistant output on both paths, so it decides what the
      // assembled message still has to contribute — the unfinished last line
      // after a streamed reply, or all of it from a provider that never streams.
      lines.push(...stream.settle(event.data.message.content, columns))
      stream.reset()
    }
    // An aborted turn never reaches an `assistant/message`: the loop throws on
    // the abort signal before appending one. Committing here is what keeps a
    // reply interrupted with ctrl-c in the transcript instead of vanishing from
    // the live region at the moment it was cancelled.
    if (event.type === 'turn/end') {
      lines.push(...stream.finish(columns))
      stream.reset()
      cards.reset()
    }
    // Projected here rather than written when the line is submitted, so a resumed
    // session shows its commands too: both lifecycle events are log-only, which
    // means they survive in the log and pass the replay filter, and this is the one
    // path the live listener and the replay share.
    if (event.type === 'command/run') {
      const { commandId, name: command, args } = event.data
      commandNames.set(commandId, command)
      return commandEcho(command, args, columns)
    }
    if (event.type === 'command/done') {
      const { commandId, kind, text } = event.data
      const command = commandNames.get(commandId)
      commandNames.delete(commandId)
      commandOutcomes += 1
      return commandLines({ kind, ...text === undefined ? {} : { text } }, command, columns)
    }
    if (event.type === 'tool/call') return cards.call(event.data, columns)
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      return cards.result({
        callId: block.toolCallId,
        content: block.content,
        isError: block.isError === true,
        ...event.data.meta === undefined ? {} : { meta: event.data.meta },
        ...event.data.error === undefined ? {} : { error: event.data.error },
      }, columns)
    }
    lines.push(...projectEvent(event, columns))
    return lines
  }

  ctx.effect(() => ctx.on('session/event', (session, event: SessionEvent) => {
    if (session !== agent.session) return
    const columns = terminal.columns()
    commit(project(event, columns))
    // Fed from the LIVE feed and not from `project`, which the replay also runs:
    // the replay carries no `assistant/chunk` events — they are the streamed form
    // of a message the log also stores assembled — so a profiler behind it would
    // chart every reopened turn as though the model had thought for no time.
    // Committed after the projection so the chart lands under the finished reply.
    if (profiling) {
      const profile = profiler.observe(event)
      if (profile !== undefined) commit(profileLines(profile, columns))
    }
    draw()
  }), 'dsh-tui: transcript projection')

  let ticker: NodeJS.Timeout | undefined
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  ctx.effect(() => stopTicker, 'dsh-tui: spinner timer')
  ctx.effect(() => ctx.on('agent/status', payload => {
    if (payload.agent !== agent) return
    if (payload.status === 'running') {
      turnStartedAt ??= Date.now()
      // Unref so a spinning timer never keeps the process alive on its own.
      ticker ??= setInterval(() => {
        tick += 1
        draw()
      }, SPINNER_INTERVAL_MS).unref()
    } else {
      stopTicker()
      turnStartedAt = undefined
    }
    draw()
  }), 'dsh-tui: status refresh')

  /**
   * Handle one submitted line: a local gesture, a registered command, or a
   * prompt for the model.
   * @param text - the submitted line.
   */
  const submit = async (text: string): Promise<void> => {
    const line = text.trim()
    // Recorded before dispatch, and before any early return, so a submitted line
    // is navigable even when it was an unknown command or a command that failed —
    // the user typed it, and the next up arrow should find it.
    if (line !== '') history.record(line)
    // Parsed once, up front: the local gestures and the unknown-command guard below
    // have to agree on what a command line is, and the registry's parser is the
    // authority on that. A second rule written here would drift from it.
    const parsed = parseCommand(line)
    if (parsed !== undefined && await localCommands.execute(parsed.name, parsed.rawInput)) return
    // A registered command runs without a model turn, and its `command/run` and
    // `command/done` events are what the transcript shows — projected above, so the
    // live session and a resumed one read identically. Nothing is committed here.
    //
    // `sourceEventSeq` marks a result whose own domain event carries a richer
    // presentation, and is deliberately NOT honoured as a reason to stay silent:
    // this frontend projects no domain events, so deferring to one would keep the
    // command invisible.
    const outcomesBefore = commandOutcomes
    let execution: Awaited<ReturnType<typeof ctx.commands.execute>>
    try {
      execution = await ctx.commands.execute(agent, line, AbortSignal.timeout(COMMAND_TIMEOUT_MS))
    } catch (error: unknown) {
      // A handler that THREW has already appended `command/done` with its failure,
      // and that event has just been projected — so reporting the same throw here
      // would print it twice. Only a throw that never reached the lifecycle (an
      // already-aborted signal, a failed `command/run` append) still needs saying.
      if (commandOutcomes === outcomesBefore) report(error)
      draw()
      return
    }
    if (execution !== undefined) {
      draw()
      return
    }
    // `undefined` covers two different lines, and only one of them belongs to the
    // model. A line that PARSES as a command but names nothing registered is a
    // typo, and sending it on spends a whole turn having the model answer `/help`
    // as though it were a question — which reads as the command being ignored.
    // Prose is untouched: the parser requires the name to end the line or be
    // followed by whitespace, so `/etc/hosts is missing` is a sentence, not a
    // command, and only a leading `/word` is claimed.
    if (parsed !== undefined) {
      commit([`${style(`\u2717 unknown command: /${parsed.name}`, 'red')}${style(' \u00b7 type / to see what there is', 'gray')}`])
      draw()
      return
    }
    const message = createUserMessage({ content: [{ type: 'text', text: line }], source: { kind: 'user' } })
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
  }

  const onKey = (key: Key): void => {
    // Read before the overlay, and before the composer, because it is the one
    // gesture that means the same thing everywhere: leave. The status line offers
    // it unconditionally, so an overlay that swallowed it — a picker, a question,
    // an approval — left the advertised way out inert with no other way to say no.
    // `ctrl-c` is deliberately NOT here: inside an overlay it means "cancel this
    // one", which is the overlay's own business.
    if (key.kind === 'key' && key.name === 'ctrl-d') {
      exit?.(0)
      return
    }
    const overlay = ctx.tuiSlots.activeOverlay
    if (overlay !== undefined) {
      overlay.handleKey(key)
      return
    }
    // Completion, then history, then the composer. The two share the vertical
    // arrows, and completion always wins while it is showing. History traversal
    // deliberately does NOT recompute completion, so a recalled line that would
    // be completable (`/model`) does not steal the next arrow press: the user
    // entered history navigation, and stays there until they edit or submit.
    const routed = routeInputKey(key, composer, completion, history)
    if (routed === 'completion') {
      draw()
      return
    }
    if (routed === 'history') {
      draw()
      return
    }
    const action = composer.handle(key)
    if (action.kind === 'submit') {
      // Whatever was being completed is gone with the line, and any lookup it
      // had in flight must not land afterwards.
      completion.invalidate()
      draw()
      submit(action.text).catch(report)
      return
    }
    if (action.kind === 'changed') {
      // Any direct edit abandons history navigation: the edited text is the new
      // draft, and the next up arrow must capture it rather than the line that
      // was showing before the edit.
      history.reset()
      // Recomputed after the edit, because what is completable is a function of the
      // text as it now stands. The redraw comes with the result, not before it.
      draw()
      completion.refresh().then(draw).catch(report)
      return
    }
    if (action.key.kind !== 'key') return
    switch (action.key.name) {
      case 'ctrl-c':
        // A press during a turn interrupts it; a press with nothing running
        // quits, which is what a terminal user already expects.
        if (agent.status === 'running') {
          agent.cancel({ kind: 'user' })
          return
        }
        exit?.(0)
        return
      case 'ctrl-l':
        terminal.write(CLEAR_DISPLAY)
        draw()
        return
      case 'ctrl-o': {
        // Finished cards are in the terminal's own scrollback and are never
        // rewritten, so this sets the level for cards drawn from here on rather
        // than reflowing what is already printed. That is the trade for keeping
        // native scrollback, selection, and copy working.
        const next = CARD_DETAIL_CYCLE[(CARD_DETAIL_CYCLE.indexOf(cards.detail) + 1) % CARD_DETAIL_CYCLE.length]
        cards.detail = next ?? 'compact'
        commit([style(`· tool output: ${cards.detail}`, 'gray')])
        draw()
        return
      }
      default:
        return
    }
  }
  ctx.effect(() => terminal.onKey(onKey), 'dsh-tui: input')

  const model = selection.current === undefined
    ? undefined
    : `${selection.current.provider} / ${selection.current.model}`
  commit(bannerLines(workspace, model, VERSION, terminal.columns()))
  commit(resumeNote)

  if (resumeId !== undefined) {
    // Replayed through the same projection the live listener uses, so a resumed
    // session reads exactly like the one that was watched happen. Committed in ONE
    // write: an event-by-event commit would redraw the live region thousands of
    // times to produce a screen nobody sees until the end of it.
    const events = await readTranscript(ctx, resumeId)
    const replayed = events.filter(isTranscriptEvent)
    // History is seeded from the same durable events the transcript replays, so
    // a reopened session navigates what was actually submitted — direct prompts
    // and recorded slash commands — rather than only what this process has seen.
    for (const line of historyLines(replayed)) history.record(line)
    const columns = terminal.columns()
    const lines = replayed.flatMap(event => project(event, columns))
    // The buffer is left holding nothing: a log can end mid-reply, and a partial
    // line still owed from history would otherwise be committed on top of the
    // FIRST line of the next turn.
    lines.push(...stream.finish(columns))
    stream.reset()
    cards.reset()
    commit([...lines, ...resumeBanner(replayed.length)])
  }
  draw()

  if (startup.task !== undefined) await submit(startup.task).catch(report)
}

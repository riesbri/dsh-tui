/**
 * One attached session: an Agent, and everything projected from its log.
 *
 * The other half of the {@link Window} split. Every registration here is owned
 * by a {@link SessionScope} rather than by the plugin fiber, because all of it —
 * the slot views, the log projection, the spinner, the capability adapters —
 * describes THIS session and has to come down when the reader opens another.
 *
 * The scope comes down BEFORE the agent handle: a transcript listener still
 * subscribed while its own agent is torn down would project that teardown into
 * the transcript the reader is leaving.
 * @module dshline/attachment
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports carry the Context merges this module reads but does not
// otherwise import from: the questions seam and the launcher's exit request. The
// command registry is imported for its parser as well as its merge, so this
// frontend decides what a command LINE is by the same rule the registry resolves
// one with.
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-cmdline'
// Both carry `SessionEventMap` merges this module reads: `plan/mode` is folded
// below, and the goal package also carries the `ctx.goals` service type. Neither
// is a peer dependency, because neither has to be MOUNTED for this frontend to
// run — a profile without them simply never reports either state.
import type {} from '@deepseek-ai/dsh-plan-mode'
// Optional projection infrastructure and Todo's `SessionProjectionMap` merge.
// dsh-base mounts both, but custom profiles may omit either without stopping TUI.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { GoalView } from '@deepseek-ai/dsh-goal'
// `fs` is read optionally for path completion: a profile that mounts no filesystem
// offers none rather than failing, so this carries the type without a hard need.
import type {} from '@deepseek-ai/dsh-fs'
import type { Key } from '@dshline/renderer'
import { Composer, escapeControls, paint, SPINNER_INTERVAL_MS } from '@dshline/renderer'
import { CARD_DETAIL_CYCLE, ToolCards } from './cards.ts'
import { installApprovalAnswerer } from './approval.ts'
import { createCompletion } from './completion.ts'
import { historyLines, InputHistory } from './history.ts'
import { routeInputKey } from './input.ts'
import { isTranscriptEvent, readTranscript, resumeBanner } from './resume.ts'
import { createToolOutputOverlay } from './tool-output.ts'
import { listModelOptions, pickModel } from './model.ts'
import { installQuestionProvider } from './questions.ts'
import { LocalCommandRegistry } from './local-commands.ts'
import { runThemes, themeValues } from './themes/index.ts'
import type { LocalCommandChoice } from './local-commands.ts'
import { SessionScope } from './session-scope.ts'
import { listConnectTargets, openConnect } from './connect/index.ts'
import { openPlugins } from './plugins/index.ts'
import { openProfiles } from './profiles/index.ts'
import { browseSessions } from './sessions/index.ts'
import { planNew } from './sessions/plan.ts'
import type { AttachOutcome, AttachTarget } from './sessions/reopen.ts'
import { StreamBuffer } from './stream.ts'
import { effortLabel, pickReasoning, reasoningValues } from './reasoning.ts'
import { createTimingView, TurnTimer } from './timing.ts'
import { goalReading, planModeAfter } from './modes.ts'
import { commandEcho, commandLines, projectEvent } from './transcript.ts'
import { promptSelect } from './select.ts'
import { formatUsage, resolveUsageMode, SessionUsage, USAGE_MODES } from './usage.ts'
import { bannerLines, composerGutter, composerInner, createComposerView, createStatusView } from './views.ts'
import { executeCommand } from './commands.ts'
import type { CommandExecutor } from './commands.ts'
import type { Window } from './window.ts'
import { createHarnessWork } from './work/index.ts'
import { createWorkOverlay } from './work/overlay.ts'
import { activeWorkCount, workSummary } from './work/model.ts'
import { SessionProjectionObserver } from './projections/observer.ts'
import { todoReading, todoSummary } from './todos/model.ts'
import { createTodoOverlay } from './todos/overlay.ts'
import { queuedUserCount } from './steering.ts'

/** What `/timing` accepts, for completing its argument. */
const TIMING_VALUES: readonly LocalCommandChoice[] = [
  { value: 'on', note: 'Show the live turn timing panel' },
  { value: 'off', note: 'Hide the live turn timing panel' },
]

/** Fixed status row every ordinary live-region composition ends with. */
const STATUS_LIVE_ROWS = 1

/** Minimum row that keeps an enabled timing panel persistently identifiable. */
const TIMING_LIVE_ROWS = 1

/**
 * Budget for a slash command, so a command that never settles cannot wedge the
 * composer. Commands are local operations; a model turn is not one of them.
 */
const COMMAND_TIMEOUT_MS = 120_000

/**
 * Drive one session until the reader chooses the next attachment target.
 *
 * Everything registered here is owned by a {@link SessionScope} rather than by
 * the plugin fiber, because all of it — the slot views, the log projection, the
 * spinner, the capability adapters — describes THIS session. The scope comes
 * down before the agent handle does: a transcript listener still subscribed
 * while its own agent is torn down would print that teardown into the transcript
 * the reader is leaving.
 * @param w - the window this session is attached to.
 * @param outcome - the agent the loop opened, and the target it came from.
 * @returns the target to attach next, once the reader has asked for it.
 */
export async function attachSession(w: Window, outcome: AttachOutcome): Promise<AttachTarget> {
  const { ctx, terminal, exit, startup, pricing, peakHours, selection, prefs, draw, commit, clear } = w
  const { target, attached } = outcome
  const scope = new SessionScope()
  // Created before anything can ask for it: a transition requested while the
  // transcript is still replaying must not resolve into a promise that does not
  // exist yet.
  let requestNext: (target: AttachTarget) => void = () => {}
  const switched = new Promise<AttachTarget>(resolve => { requestNext = resolve })
  const { agent, dispose: disposeAgent } = attached.handle

  // Held until after the banner, so the transcript reads in the order it
  // happened rather than opening with a footnote. The window asked which session
  // to open and got no answer; silence would read as the request having been
  // ignored. A reopen that FAILED was already reported before the reader was
  // asked again, so there is nothing to repeat here.
  const resumeNote = target.kind === 'new' && target.afterDismissal === true
    ? [paint('· no session reopened; starting a new one', 'muted')]
    : []

  // A resumed session keeps the workspace it was created in: the header is the
  // authority, and resuming into the directory that happens to be current would
  // silently re-root the conversation.
  const workspace = agent.session.header.cwd ?? startup.cwd

  const composer = new Composer()
  const history = new InputHistory()
  // Jobs and subagents are optional capability seams. This projection listens
  // through the parent-scoped subagent lifecycle and re-reads authoritative
  // service snapshots; it neither starts work nor owns its output cursor.
  const work = createHarnessWork(ctx, agent, () => { ctx.tuiSlots.invalidate() })
  scope.own(() => { work.dispose() })
  // One generic observer belongs to this exact Session. Domain adapters read its
  // authoritative snapshots; it only coalesces redraws after Harness has driven.
  const projections = new SessionProjectionObserver({
    registry: ctx.get('sessionProjections'),
    session: agent.session,
    invalidate: () => { ctx.tuiSlots.invalidate() },
  })
  scope.own(() => { projections.dispose() })
  // Completion and the composer budget against the fixed views below them. The
  // timing row is conditional, but while enabled it must survive a tall paste or
  // suggestion list instead of being pushed beyond the physical screen.
  const persistentRowsBelow = (): number =>
    STATUS_LIVE_ROWS + (prefs.timing ? TIMING_LIVE_ROWS : 0)
  const composerView = createComposerView(composer, workspace, persistentRowsBelow)
  const stream = new StreamBuffer()
  // Scoped to the agent: a scoped tool shadows a global one, and a restricted-away
  // tool reads as absent, so the card must come from the definition that ran.
  const cards = new ToolCards(name => ctx.tools.get(name, agent), workspace)
  // Seeded from the window: `ctrl-o` is a reader preference, and reopening a
  // session should not silently re-expand cards they had folded away.
  cards.detail = prefs.cardDetail
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
  // Cumulative for the session, folded from the log rather than counted here, so
  // the meter reports what the provider billed.
  const usage = new SessionUsage(pricing, peakHours)
  const timer = new TurnTimer()
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
          w.refreshModelInfo()
          commit([paint(`· ${outcome}`, 'muted')])
        }
        draw()
      },
    },
    {
      // Named `/timing`, not `/profile`: a Harness PROFILE is the composition
      // a launcher boots (`dsh --profile <name>`, browsed by `/profiles`), and
      // one word cannot mean both a per-turn stopwatch and that. This command
      // never had anything to do with profiles.
      name: 'timing',
      description: 'Show a live breakdown of the current or latest turn',
      complete: () => TIMING_VALUES,
      execute: rawInput => {
        const named = rawInput.trim().toLowerCase()
        if (named !== '' && named !== 'on' && named !== 'off') {
          commit([paint('\u2717 /timing takes on or off, or nothing to flip it', 'error')])
          draw()
          return
        }
        // Binary, so a bare gesture flips it rather than opening a list of two.
        prefs.timing = named === '' ? !prefs.timing : named === 'on'
        commit([paint(
          prefs.timing ? '· turn timer: on, in the live area' : '· turn timer: off',
          'muted',
        )])
        draw()
      },
    },
    {
      name: 'reasoning',
      description: 'Set how hard the model thinks, for the next turn',
      complete: () => reasoningValues(w.modelInfo.reasoning),
      execute: async rawInput => {
        // The levels are a short fixed set a person learns by heart, so
        // `/reasoning max` should not cost a picker.
        const outcome = await pickReasoning(ctx, selection, w.modelInfo.reasoning, rawInput)
        if (outcome !== undefined) commit([paint(`· ${outcome}`, 'muted')])
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
            detail: `current: ${prefs.usageMode}`,
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
          commit([paint(
            `\u2717 no usage setting named ${escapeControls(picked)}; try one of: ${offered}`,
            'error',
          )])
          draw()
          return
        }
        prefs.usageMode = chosen
        // Acknowledged by name, as `ctrl-o` is: switching a segment OFF removes the
        // only evidence the command did anything, so silence would read as failure.
        commit([paint(`· usage: ${prefs.usageMode}`, 'muted')])
        draw()
      },
    },
    {
      name: 'theme',
      description: 'Choose the colour palette this window draws with',
      complete: () => themeValues(),
      execute: async rawInput => {
        await runThemes({
          ctx,
          current: () => w.palette(),
          depth: w.colorDepth,
          // The window owns the palette, not the session: reopening one must
          // not put the reader’s colours back, for the same reason it must not
          // put the usage meter back to cost.
          apply: next => { w.setPalette(next) },
          commit,
          remember: id => w.themeSettings.save(id),
        }, rawInput)
        draw()
      },
    },
    {
      name: 'work',
      description: 'Inspect active Harness jobs and subagents',
      execute: () => {
        // Like the tool inspector, Work is temporary live-region chrome. It
        // disappears on close and never rewrites the transcript it covered.
        let dismiss = (): void => {}
        const overlay = createWorkOverlay({
          snapshot: () => work.snapshot(),
          stop: item => work.stop(item),
          close: () => dismiss(),
          invalidate: () => { ctx.tuiSlots.invalidate() },
        })
        dismiss = ctx.tuiSlots.pushOverlay(overlay)
      },
    },
    {
      name: 'todos',
      description: 'Inspect the current Harness todo list',
      execute: () => {
        // Opening a temporary terminal overlay is frontend-local, not a
        // Harness-wide command or any Todo-domain mutation.
        let dismiss = (): void => {}
        const overlay = createTodoOverlay({
          reading: () => todoReading(projections),
          close: () => dismiss(),
        })
        dismiss = ctx.tuiSlots.pushOverlay(overlay)
      },
    },
    {
      name: 'connect',
      description: 'Configure and authenticate Harness providers',
      complete: () => listConnectTargets(ctx),
      execute: async rawInput => {
        // Configuration is a window-level concern, not a session one, but it is
        // opened from here for the same reason every other picker is: the
        // attachment owns the keyboard while a session is up. Nothing it does
        // touches this session — a route it activates is read by the NEXT step's
        // model selection, which is what `/model` then offers.
        await openConnect({ ctx, commit, query: rawInput.trim() })
        draw()
      },
    },
    {
      name: 'plugins',
      description: "Browse and customize the running agent's Harness preset composition",
      execute: async () => {
        // Per-agent, unlike Connect: a toggled row, a copied preset, or a
        // recomposed session are all facts about THIS agent's composition,
        // not the window. `agent.ctx` and `agent.session` are exactly the
        // two Harness surfaces this browser reads and writes through.
        await openPlugins({ ctx, agent, commit })
        draw()
      },
    },
    {
      name: 'profiles',
      description: "Browse Harness profiles and the bundles each one composes",
      execute: async () => {
        // Window-level, unlike `/plugins`: a profile composes the HOST, so
        // nothing here is a fact about this agent. It takes `ctx` only, and
        // every change it makes lands on the next boot rather than on this
        // session.
        await openProfiles({ ctx, commit })
        draw()
      },
    },
    {
      name: 'sessions',
      description: 'Browse, search, and reopen past Harness sessions',
      execute: async () => {
        // The browser is temporary live-region chrome like Work and the tool
        // inspector; the committed transcript under it is never rewritten.
        // Reopening is the one thing it can do that outlives it, and the plan
        // that authorizes it reads the conditions at the moment enter is pressed.
        const chosen = await browseSessions({
          ctx,
          currentSessionId: agent.session.id,
          busy: () => agent.status === 'running',
          activeWork: () => activeWorkCount(work.snapshot()),
        })
        if (chosen !== undefined) requestNext({ kind: 'resume', id: chosen })
        draw()
      },
    },
    {
      name: 'new',
      description: 'Start a fresh session in the current workspace',
      execute: rawInput => {
        if (rawInput.trim() !== '') {
          commit([paint('\u2717 /new takes no argument', 'error')])
          draw()
          return
        }
        // `/new` retires a live agent exactly like `/sessions` does, so it must
        // pass the same capability checks rather than tearing one down while
        // Harness has not defined the fate of its active work.
        const plan = planNew({
          busy: agent.status === 'running',
          activeWork: activeWorkCount(work.snapshot()),
        })
        if (plan.kind === 'refused') {
          commit([paint(plan.message, 'error')])
          draw()
          return
        }
        commit([paint('· starting a new session…', 'muted')])
        requestNext({ kind: 'new', cwd: workspace })
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
  }, () => { ctx.tuiSlots.invalidate() }, persistentRowsBelow)

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
    activity: cards.inFlight(),
    model: selection.current?.model,
    effort: effortLabel(selection.current?.reasoningEffort, w.modelInfo.reasoning),
    usage: formatUsage(usage.reading, prefs.usageMode),
    tokens: ctx.get('tokenMeter')?.measure(agent.session).totalTokens,
    contextWindow: w.modelInfo.contextWindow,
    detail: cards.detail,
    work: workSummary(work.snapshot()),
    queued: queuedUserCount(agent.inbox),
    todo: todoSummary(todoReading(projections)),
    plan: planActive,
    // Asked for at render time, as the token meter is, and for the same reason:
    // it is the authority, and it knows the one thing the log cannot say — whether
    // THIS process still holds authority to take another round. Guarded because
    // the service documents a throw, and a throw here would take the whole status
    // line down rather than one segment of it.
    goal: goalReading(currentGoal()),
  }))
  const streamView = { render: (columns: number): string[] => stream.live(columns) }
  const timingView = createTimingView(timer, () => prefs.timing, () => tick)

  scope.own(ctx.tuiSlots.register('stream', streamView))
  scope.own(ctx.tuiSlots.register('status', status))
  scope.own(ctx.tuiSlots.register('composer', composerView))
  scope.own(ctx.tuiSlots.register('completion', completion.view))
  scope.own(ctx.tuiSlots.register('timing', timingView))
  scope.own(installApprovalAnswerer(ctx, () => agent))
  scope.own(installQuestionProvider(ctx))

  /**
   * Report a failure in the transcript instead of discarding it. A rejected
   * submit is otherwise invisible: the composer clears, nothing happens, and
   * there is no message anywhere to explain why.
   * @param error - the thrown value.
   */
  const report = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    commit([paint(`\u2717 ${escapeControls(message)}`, 'error')])
    draw()
  }

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

  // `Inbox.splice` in @deepseek-ai/dsh-agent/inbox and the
  // `agent/inbox/spliced` declaration in @deepseek-ai/dsh-agent/types both say
  // the durable event commits before the live projection mutates, so this
  // synchronous observer sees the pre-splice lists. It only requests a redraw:
  // RedrawScheduler paints in the check phase after the event-loop turn settles,
  // and the status getter then reads the current `agent.inbox` projection directly.
  scope.own(ctx.on('session/event', (session, event: SessionEvent) => {
    if (session !== agent.session) return
    const columns = terminal.columns()
    // Always fold the live feed. Gating observation on the preference made an
    // enable during a turn either blank or partial; the preference owns only
    // presentation, and a fresh attachment still starts without invented data.
    timer.observe(event)
    commit(project(event, columns))
    // Fed from the LIVE feed and not from `project`, which the replay also runs:
    // the replay carries no `assistant/chunk` events — they are the streamed form
    // of a message the log also stores assembled — so a timer behind it would
    // measure every reopened turn as though the model had thought for no time.
    draw()
  }))

  let ticker: NodeJS.Timeout | undefined
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  scope.own(stopTicker)
  scope.own(ctx.on('agent/status', payload => {
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
  }))

  /**
   * Handle one submitted line: a local gesture, a registered command, or a
   * prompt for the model.
   * @param text - the submitted line.
   */
  const submit = async (text: string): Promise<void> => {
    const line = text.trim()
    // The composer has already cleared a submitted buffer. Stop here rather than
    // turning spaces or pasted blank lines into an empty model message.
    if (line === '') return
    // Recorded before dispatch and its following early returns, so a submitted
    // line is navigable even when it was an unknown command or a command that
    // failed — the user typed it, and the next up arrow should find it.
    history.record(line)
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
      execution = await executeCommand(
        ctx.commands as unknown as CommandExecutor<typeof execution>,
        agent,
        line,
        AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      )
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
      commit([`${paint(`\u2717 unknown command: /${parsed.name}`, 'error')}${paint(' \u00b7 type / to see what there is', 'muted')}`])
      draw()
      return
    }
    const message = createUserMessage({ content: [{ type: 'text', text: line }], source: { kind: 'user' } })
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
  }

  const onKey = (key: Key): void => {
    // `ctrl-d` is handled by the window, before this delegate, because it means
    // the same thing everywhere: leave. `ctrl-c` is deliberately NOT: inside an
    // overlay it means "cancel this one", which is the overlay's own business.
    const overlay = ctx.tuiSlots.activeOverlay
    if (overlay !== undefined) {
      overlay.handleKey(key)
      return
    }
    // Completion, then history, then the composer. The three share the vertical
    // arrows, and this ordering is the whole vertical-routing policy. Completion
    // always wins while it is showing. History traversal deliberately does NOT
    // recompute completion, so a recalled line that would be completable
    // (`/model`) does not steal the next arrow press: the user entered history
    // navigation, and stays there until they edit or submit. At the draft, the
    // composer's own `↑`/`↓` move through the wrapped buffer first, so a long
    // prompt is navigated vertically before `↑` reaches for history.
    const geometry = {
      width: composerInner(terminal.columns()),
      gutter: composerGutter,
    }
    const routed = routeInputKey(key, composer, completion, history, geometry)
    if (routed === 'completion') {
      draw()
      return
    }
    if (routed === 'history') {
      draw()
      return
    }
    if (routed === 'vertical') {
      // The cursor moved through the buffer's rows; history drafts are left
      // untouched, and what is completable changed with the cursor, as it does
      // after any horizontal move.
      draw()
      completion.refresh().then(draw).catch(report)
      return
    }
    const valueBeforeAction = composer.value
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
      // Cursor motion and text edits share one composer action. Only an edit
      // abandons history navigation; otherwise Left followed by Up must continue
      // to the older entry, and the saved half-typed draft must remain recoverable.
      const edited = history.resetIfEdited(valueBeforeAction, composer.value)
      draw()
      // A recalled line deliberately owns the arrows until it is edited or
      // submitted. Cursor-only motion must not open completion over that line and
      // let the resulting list steal the next vertical arrow.
      if (history.navigating && !edited) return
      // Recomputed after the edit or cursor move, because what is completable is a
      // function of both the text and the cursor position.
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
        clear()
        return
      case 'ctrl-o': {
        // A compact card that elided output commits those rows into the terminal's
        // own scrollback, where `compact → full → hidden` cannot recover them (that
        // cycle only affects cards drawn from here on). So the very first duty of
        // ctrl-o is to open the inspector for an unseen truncated result — and
        // taking it consumes that one-shot opportunity, so a later ctrl-o returns
        // to the detail cycle rather than reopening the same card. A card the
        // reader has already scrolled past is reached from INSIDE the overlay,
        // where arrows navigate the retained history and ctrl-o remains an older
        // alias: while an overlay is mounted the window routes every key to it,
        // so this handler is not reached again until it closes.
        const inspectable = cards.takeInspectable()
        if (inspectable !== undefined) {
          // The inspector is a live-region overlay: it disappears on dismiss and
          // never rewrites the committed transcript, keeping native scrollback.
          // `current` is the only mutable part: the overlay moves it through the
          // retained history, and every read below follows it.
          let current = inspectable
          let dismiss = (): void => {}
          const overlay = createToolOutputOverlay({
            title: 'Tool output',
            render: columns => cards.renderInspect(current, columns),
            position: () => cards.inspectableRank(current),
            older: () => {
              const older = cards.inspectableOlderThan(current)
              if (older === undefined) return false
              current = older
              return true
            },
            newer: () => {
              const newer = cards.inspectableNewerThan(current)
              if (newer === undefined) return false
              current = newer
              return true
            },
            close: () => dismiss(),
            invalidate: () => { ctx.tuiSlots.invalidate() },
          })
          dismiss = ctx.tuiSlots.pushOverlay(overlay)
          return
        }
        // Finished cards are in the terminal's own scrollback and are never
        // rewritten, so this sets the level for cards drawn from here on rather
        // than reflowing what is already printed. That is the trade for keeping
        // native scrollback, selection, and copy working.
        const next = CARD_DETAIL_CYCLE[(CARD_DETAIL_CYCLE.indexOf(cards.detail) + 1) % CARD_DETAIL_CYCLE.length]
        cards.detail = next ?? 'compact'
        prefs.cardDetail = cards.detail
        commit([paint(`· tool output: ${cards.detail}`, 'muted')])
        draw()
        return
      }
      default:
        return
    }
  }
  w.setDispatch(onKey)
  scope.own(() => { w.setDispatch(undefined) })

  const model = selection.current === undefined
    ? undefined
    : `${selection.current.provider} / ${selection.current.model}`
  commit(bannerLines(workspace, model, w.version, terminal.columns()))
  commit(resumeNote)

  if (attached.reopened && target.kind === 'resume') {
    // Replayed through the same projection the live listener uses, so a resumed
    // session reads exactly like the one that was watched happen. Committed in ONE
    // write: an event-by-event commit would redraw the live region thousands of
    // times to produce a screen nobody sees until the end of it.
    const events = await readTranscript(ctx, target.id)
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

  // Consumed, not read: a session reopened from inside the window must not
  // replay the command line's opening prompt.
  const task = w.pendingTask
  w.pendingTask = undefined
  if (task !== undefined) await submit(task).catch(report)

  const next = await switched
  // Presentation first, then the agent. A log listener still subscribed while
  // its own agent is torn down would project that teardown into the transcript
  // the reader is leaving.
  //
  // Both halves are reported rather than thrown. A rejected teardown would
  // otherwise reach the runner's boot-failure path and end the window over a
  // session the reader has already left; the next attachment drives another
  // target, so it does not collide with whatever failed to come down.
  try {
    scope.dispose()
  } catch (error: unknown) {
    report(error)
  }
  const closing = ctx.tuiSlots.register('status', {
    render: (): string[] => [paint('· switching sessions…', 'muted')],
  })
  draw()
  try {
    await disposeAgent()
  } catch (error: unknown) {
    report(error)
  }
  closing()
  return next
}

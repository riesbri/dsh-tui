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
import type {} from '@deepseek-ai/dsh-cmdline'
// `fs` is read optionally for path completion: a profile that mounts no filesystem
// offers none rather than failing, so this carries the type without a hard need.
import type {} from '@deepseek-ai/dsh-fs'
import type { Key } from '@riesbri/dsh-tui-renderer'
import { acquireTerminal, Composer, escapeControls, Screen, SPINNER_INTERVAL_MS, style } from '@riesbri/dsh-tui-renderer'
import { CARD_DETAIL_CYCLE, ToolCards } from './cards.ts'
import { installApprovalAnswerer } from './approval.ts'
import { createCompletion } from './completion.ts'
import { isTranscriptEvent, pickSession, readTranscript, resumeBanner } from './resume.ts'
import { pickModel } from './model.ts'
import { installQuestionProvider } from './questions.ts'
import { TuiSlots } from './slots.ts'
import { StreamBuffer } from './stream.ts'
import { projectEvent } from './transcript.ts'
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
const VERSION = '0.1.0'

/**
 * Slash lines this frontend answers itself, rather than passing to the registry.
 *
 * Deliberately NOT registered with `ctx.commands`. That registry is shared by every
 * surface in the process, and these two are things only a terminal can do: a web
 * client or the automation server has no terminal to leave and no picker to open,
 * so offering them there would advertise commands that cannot work. They are listed
 * in the completion menu alongside the registered ones, because a person typing `/`
 * wants to see what they can type, not which registry it came from.
 */
const LOCAL_COMMANDS: readonly { readonly name: string; readonly description: string }[] = [
  { name: 'model', description: 'Choose the provider and model for the next turn' },
  { name: 'exit', description: 'Leave the session, as ctrl-d does' },
  { name: 'quit', description: 'Leave the session, as ctrl-d does' },
]

/**
 * The local gesture that opens the model picker rather than reaching the model.
 *
 * A NAME, not a whole line, as {@link EXIT_COMMANDS} are too. The line is what the
 * user typed: `/model` carrying an argument, or the trailing space that accepting
 * the completion leaves behind, is still the same gesture. Comparing whole lines
 * sent those to the registry, which does not have them either — so the frontend's
 * own commands came back as unknown.
 */
const MODEL_COMMAND = 'model'

/** Local gestures that leave, so a person who types one is not told it is unknown. */
const EXIT_COMMANDS = ['exit', 'quit'] as const

/**
 * Budget for a slash command, so a command that never settles cannot wedge the
 * composer. Commands are local operations; a model turn is not one of them.
 */
const COMMAND_TIMEOUT_MS = 120_000

/** Erase the display and home the cursor, for the `ctrl-l` gesture. */
const CLEAR_DISPLAY = '\u001b[2J\u001b[H'

/**
 * Mount the terminal frontend.
 * @param ctx - plugin context carrying the harness services and the invocation.
 */
export function apply(ctx: Context): void {
  ctx.plugin(TuiSlots)
  ctx.inject(['tuiSlots'], hostCtx => {
    // A rejected boot must be reported and exit non-zero. Discarding it would
    // leave the process alive holding a terminal it never painted, which is the
    // same silent-idle failure the non-TTY guard exists to prevent.
    run(hostCtx).catch((error: unknown) => {
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
 */
async function run(ctx: Context): Promise<void> {
  const exit = ctx.get('appExit')
  const startup = ctx.tuiStartup.options
  const terminal = acquireTerminal({ input: process.stdin, output: process.stdout })
  const screen = new Screen(terminal)
  ctx.effect(() => () => {
    screen.close()
    terminal.close()
  }, 'dsh-tui: terminal ownership')

  const draw = (): void => {
    const { lines, cursor } = ctx.tuiSlots.compose(terminal.columns())
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
  const composerView = createComposerView(composer, workspace)
  // Completion reads the harness through two narrow functions rather than taking a
  // context, so its rules are testable without one. `ctx.fs` is optional: a profile
  // that mounts no filesystem offers no path completion rather than failing.
  const completion = createCompletion(composer, {
    // The frontend's own gestures listed beside the registry's, so `/` shows what
    // can be typed rather than what happens to be registered.
    commands: () => [...LOCAL_COMMANDS, ...ctx.commands.list(agent)]
      .sort((left, right) => left.name.localeCompare(right.name)),
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
  const stream = new StreamBuffer()
  // Scoped to the agent: a scoped tool shadows a global one, and a restricted-away
  // tool reads as absent, so the card must come from the definition that ran.
  const cards = new ToolCards(name => ctx.tools.get(name, agent), workspace)
  let tick = 0
  let turnStartedAt: number | undefined
  let contextWindow: number | undefined
  // Resolved once per selection: the window is model metadata, and asking the
  // adapter on every frame would put an await in the render path.
  const refreshContextWindow = (): void => {
    const current = selection.current
    contextWindow = undefined
    if (current === undefined) return
    void ctx.llm.resolveModelInfo(current.provider, current.model)
      .then(info => {
        contextWindow = info.context?.contextWindow
        ctx.tuiSlots.invalidate()
      })
      // An adapter that cannot describe the model leaves the window unknown; the
      // status line then shows pressure without a denominator.
      .catch(() => {})
  }
  refreshContextWindow()

  const status = createStatusView(() => ({
    busy: agent.status === 'running',
    tick,
    elapsedMs: turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt,
    model: selection.current?.model,
    tokens: ctx.get('tokenMeter')?.measure(agent.session).totalTokens,
    contextWindow,
    detail: cards.detail,
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
    const lines: string[] = []
    if (event.type === 'assistant/message') {
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
    commit(project(event, terminal.columns()))
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
    // Parsed once, up front: the local gestures and the unknown-command guard below
    // have to agree on what a command line is, and the registry's parser is the
    // authority on that. A second rule written here would drift from it.
    const parsed = parseCommand(line)
    if (parsed !== undefined && (EXIT_COMMANDS as readonly string[]).includes(parsed.name)) {
      exit?.(0)
      return
    }
    if (parsed?.name === MODEL_COMMAND) {
      const outcome = await pickModel(ctx, selection)
      if (outcome !== undefined) {
        refreshContextWindow()
        commit([style(`· ${outcome}`, 'gray')])
      }
      draw()
      return
    }
    // A registered command runs without a model turn.
    const execution = await ctx.commands.execute(agent, line, AbortSignal.timeout(COMMAND_TIMEOUT_MS))
    if (execution !== undefined) return
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
    // Completion sees the key BEFORE the composer, but claims only its own
    // gestures — never `enter`, never a printable character — so the list narrows
    // as text arrives and a submission is never swallowed.
    if (completion.active && completion.handleKey(key)) {
      draw()
      return
    }
    const action = composer.handle(key)
    if (action.kind === 'submit') {
      // Whatever was being completed is gone with the line.
      completion.dismiss()
      draw()
      submit(action.text).catch(report)
      return
    }
    if (action.kind === 'changed') {
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
    const history = await readTranscript(ctx, resumeId)
    const replayed = history.filter(isTranscriptEvent)
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

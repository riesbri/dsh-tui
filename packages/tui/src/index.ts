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
// otherwise import from: the command registry, the questions seam, the default
// model selection, and the launcher's settlement await and exit request.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { Key } from '@riesbri/dsh-tui-renderer'
import { acquireTerminal, Composer, escapeControls, Screen, SPINNER_INTERVAL_MS, style } from '@riesbri/dsh-tui-renderer'
import { installApprovalAnswerer } from './approval.ts'
import { pickModel } from './model.ts'
import { installQuestionProvider } from './questions.ts'
import { TuiSlots } from './slots.ts'
import { projectEvent } from './transcript.ts'
import { bannerLines, createComposerView, createStatusView } from './views.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tui'

/**
 * The runner needs the invocation, the agent registry, the interaction seams,
 * and the model registry. `tuiStartup` is published only on an interactive
 * launch, so a piped run leaves this row unmounted.
 */
export const inject = ['tuiStartup', 'agents', 'userQuestions', 'commands', 'llm']

export type { TuiOverlay, TuiSlotName, TuiSlotView } from './slots.ts'
export { TuiSlots } from './slots.ts'

/** Reported in the banner; kept beside the code so a release bumps one place. */
const VERSION = '0.1.0'

/** Local gesture that opens the model picker rather than reaching the model. */
const MODEL_COMMAND = '/model'

/**
 * Trailing lines of a streaming reply kept in the live region.
 *
 * The live region is redrawn by climbing rows, so it must stay shorter than the
 * screen: a reply taller than the terminal would leave the cursor unable to
 * reach the region's first row and corrupt every later redraw. The full text is
 * committed to scrollback the moment its `assistant/message` lands, so nothing
 * is lost by showing only the tail while it streams.
 */
const STREAM_TAIL_LINES = 8

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

  await ctx.get('loader')?.await()
  const selection: ModelSelectionRef = {
    current: ctx.get('agentDefaultModel')?.currentSelection(),
    assembled: undefined,
  }

  const { agent } = await ctx.agents.create({
    sessionId: SessionId(`tui-${randomUUID()}`),
    meta: { cwd: startup.cwd },
    ...selection.current === undefined
      ? {}
      : { agentOptions: { provider: selection.current.provider, model: selection.current.model } },
    setup: agentCtx => { installModelSelection(agentCtx, selection) },
  })

  const composer = new Composer()
  const composerView = createComposerView(composer, startup.cwd)
  let streaming = ''
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
  }))
  const streamView = {
    render: (): string[] => {
      if (streaming === '') return []
      const lines = escapeControls(streaming).split('\n')
      const tail = lines.slice(-STREAM_TAIL_LINES)
      return ['', `${style('⏺', 'green')} ${tail.join('\n  ')}`]
    },
  }

  ctx.effect(() => ctx.tuiSlots.register('stream', streamView), 'dsh-tui: streaming reply')
  ctx.effect(() => ctx.tuiSlots.register('status', status), 'dsh-tui: status line')
  ctx.effect(() => ctx.tuiSlots.register('composer', composerView), 'dsh-tui: composer')
  ctx.effect(() => installApprovalAnswerer(ctx, () => agent), 'dsh-tui: approval answerer')
  ctx.effect(() => installQuestionProvider(ctx), 'dsh-tui: user-questions provider')

  const draw = (): void => {
    const { lines, cursor } = ctx.tuiSlots.compose(terminal.columns())
    if (cursor === undefined) screen.setLive(lines)
    else screen.setLive(lines, cursor)
  }

  const commit = (lines: readonly string[]): void => {
    if (lines.length === 0) return
    screen.commit(lines)
  }

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

  ctx.effect(() => ctx.on('session/event', (session, event: SessionEvent) => {
    if (session !== agent.session) return
    if (event.type === 'assistant/chunk') {
      const { chunk } = event.data
      if (chunk.type === 'text-delta') {
        streaming += chunk.text
        draw()
      }
      return
    }
    // The assembled message is the committed form; clearing first keeps the
    // streamed copy from being drawn beneath the text it duplicates.
    if (event.type === 'assistant/message') streaming = ''
    commit(projectEvent(event, terminal.columns()))
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
    if (line === MODEL_COMMAND) {
      const outcome = await pickModel(ctx, selection)
      if (outcome !== undefined) {
        refreshContextWindow()
        commit([style(`· ${outcome}`, 'gray')])
      }
      draw()
      return
    }
    // A registered command runs without a model turn; `undefined` means the line
    // was not a command at all and belongs to the model.
    const execution = await ctx.commands.execute(agent, line, AbortSignal.timeout(COMMAND_TIMEOUT_MS))
    if (execution !== undefined) return
    const message = createUserMessage({ content: [{ type: 'text', text: line }], source: { kind: 'user' } })
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
  }

  const onKey = (key: Key): void => {
    const overlay = ctx.tuiSlots.activeOverlay
    if (overlay !== undefined) {
      overlay.handleKey(key)
      return
    }
    const action = composer.handle(key)
    if (action.kind === 'submit') {
      draw()
      submit(action.text).catch(report)
      return
    }
    if (action.kind === 'changed') {
      draw()
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
      case 'ctrl-d':
        exit?.(0)
        return
      case 'ctrl-l':
        terminal.write(CLEAR_DISPLAY)
        draw()
        return
      default:
        return
    }
  }
  ctx.effect(() => terminal.onKey(onKey), 'dsh-tui: input')

  const model = selection.current === undefined
    ? undefined
    : `${selection.current.provider} / ${selection.current.model}`
  commit(bannerLines(startup.cwd, model, VERSION, terminal.columns()))
  draw()

  if (startup.task !== undefined) await submit(startup.task).catch(report)
}

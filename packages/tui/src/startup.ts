/**
 * The bundle's own command line, and the terminal precondition.
 *
 * A frontend that needs a terminal must refuse a piped launch, and must refuse
 * it EARLY. A compose-time throw inside a Loader tree is logged per entry rather
 * than rethrown, so a plugin that merely threw here would leave the process
 * settled and idle with no UI and a zero exit code — the launcher would look
 * like it had succeeded. The refusal therefore goes through `ctx.appExit`, which
 * the launcher provides before the tree mounts, giving a message on stderr and a
 * non-zero status.
 *
 * On refusal the startup service is never published, so the runner row's
 * injection never resolves and it does not mount at all.
 * @module @riesbri/dsh-tui/startup
 */

import { Command } from 'commander'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { isInteractive } from '@riesbri/dsh-tui-renderer'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStartup: TuiStartup
  }
}

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tui-startup'

/** The command line is launcher-owned and must be present before this mounts. */
export const inject = ['cmdlineArgs']

/** Invocation values the runner reads. */
export interface TuiStartupOptions {
  /** Workspace root for the session, defaulting to the invoking directory. */
  cwd: string
  /** A task to submit immediately, or undefined to open with an empty composer. */
  task: string | undefined
  /**
   * Which past session to reopen.
   *
   * Three states rather than two, because `--resume` with no value is a distinct
   * request from not passing it: `undefined` starts a new session, a string names
   * one, and `true` means "ask me which".
   */
  resume: string | true | undefined
}

/** Publishes this invocation's parsed arguments. */
export class TuiStartup extends Service {
  constructor(ctx: Context, readonly options: TuiStartupOptions) {
    super(ctx, 'tuiStartup')
  }
}

/**
 * Parse the bundle's flags and publish them, or refuse a non-interactive launch.
 * @param ctx - plugin context carrying `cmdlineArgs` and `appExit`.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('dsh-tui: the launcher must provide ctx.appExit before the tree mounts')
  }
  const program = new Command()
    .name('dsh --profile tui')
    .description('An interactive terminal session for DeepSeek Harness.')
    .option('-C, --cwd <path>', 'workspace root for the session', process.cwd())
    .option('-r, --resume [session]', 'reopen a past session, or pick one when given no id')
    .argument('[task...]', 'a first task to submit on open')
    .action((task: string[], options: { cwd: string; resume?: string | true }) => {
      // The terminal check belongs in the action, not before parsing: `--help`
      // and `--version` must answer from a pipe or a script, and commander runs
      // no action for either. Rejecting before publishing is also what
      // `parseCmdline` requires of an action.
      if (!isInteractive({ input: process.stdin, output: process.stdout })) {
        process.stderr.write('dsh-tui: needs a terminal on stdin and stdout; for a piped or scripted run use --profile headless\n')
        exit(1)
        return
      }
      ctx.plugin(TuiStartup, {
        cwd: options.cwd,
        task: task.length > 0 ? task.join(' ') : undefined,
        resume: options.resume,
      })
    })
  parseCmdline(ctx, program)
}

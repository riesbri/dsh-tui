/**
 * Running one `dsh plugin --profile <name> …` invocation from the terminal.
 *
 * This is the whole mutation surface of `/profiles`, and it is deliberately a
 * forwarder rather than an implementation. Harness owns profile package
 * lifecycle in one place — `apps/cli/src/plugin.ts` — which initializes the
 * profile directory if it is new, runs pnpm inside it, and then reconciles
 * `dsh.profile.bundles` against the INSTALLED state (so a package that gained
 * its `dsh.bundle` declaration in a newer version joins the layer stack on
 * update). Reproducing any part of that here would be a second installer whose
 * idea of the bundle list drifts from the real one the moment either changes.
 *
 * There is no Harness service for this: `runPlugin` lives in the CLI app, not
 * in a mounted plugin, and nothing publishes it into a context. So the
 * mechanism used is the one Harness itself owns — the `dsh` executable — per
 * the rule that a missing mutation seam is answered with Harness's own
 * external mechanism rather than a competing abstraction.
 *
 * Two things this module does that the CLI does not, both because a TUI owns
 * the terminal:
 *
 * ```
 * stdio is PIPED, never inherited   `dsh plugin` uses stdio:'inherit'; a child
 *                                   writing pnpm progress straight into a
 *                                   screen this process is painting would
 *                                   corrupt the live region and leave rows
 *                                   Screen never committed
 * output is bounded                 a pnpm failure is many lines; the last few
 *                                   carry the reason, and the full text is
 *                                   what the user re-runs the named command to
 *                                   see
 * ```
 * @module dshline/profiles/actions
 */

import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { access, constants } from 'node:fs/promises'
import type { ResolvedOperation } from './model.ts'

/** The launcher this forwards to. */
const LAUNCHER = 'dsh'

/** Windows resolves an npm-installed launcher through one of these shims. */
const WINDOWS_EXTENSIONS = ['.cmd', '.exe', '.bat', ''] as const

/**
 * How long one invocation may run before it is abandoned.
 *
 * A pnpm install reaches the network and builds native packages, so this is
 * generous where a slash command's own budget is not — but it is bounded,
 * because a child that never exits would hold the browser's single-action lock
 * for the rest of the session.
 */
const PLUGIN_TIMEOUT_MS = 600_000

/** Lines of child output kept for the transcript. */
const KEPT_OUTPUT_LINES = 6

/** How one invocation ended, in words the transcript can carry. */
export interface ProfileActionOutcome {
  /** Whether the invocation succeeded. */
  readonly kind: 'done' | 'failed'
  /** What happened, already worded for a reader. */
  readonly message: string
  /** The tail of the child's own output, when it produced any. */
  readonly output: readonly string[]
}

/**
 * Whether one path is an executable file.
 * @param path - the candidate path.
 * @returns true when it can be executed.
 */
async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find the `dsh` launcher on PATH.
 *
 * Looked up rather than probed by running it, and rather than resolved from
 * this package's own module graph: `dshline` is a plugin INSIDE a dsh process,
 * so the launcher that started this one is on PATH by construction in every
 * ordinary install. A checkout that runs the launcher through a loader script
 * has no `dsh` executable at all, and that is reported as what it is — the
 * command is named so it can be run directly — rather than guessed at.
 * @param env - the environment to read PATH from.
 * @returns the launcher path, or undefined when none is on PATH.
 */
export async function findLauncher(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const path = env.PATH ?? env.Path
  if (path === undefined || path === '') return undefined
  const extensions = process.platform === 'win32' ? WINDOWS_EXTENSIONS : ['']
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${LAUNCHER}${extension}`)
      if (await executable(candidate)) return candidate
    }
  }
  return undefined
}

/** What {@link runProfileOperation} needs to run one invocation. */
export interface ProfileOperationSpec {
  /** The profile name the operation is addressed to. */
  readonly profile: string
  /** The resolved operation, from `model.ts`. */
  readonly resolved: ResolvedOperation
  /**
   * Find the launcher; injected so a test drives the whole chain without a
   * `dsh` on PATH.
   */
  readonly launcher?: () => Promise<string | undefined>
  /**
   * Spawn one child; injected for the same reason. Resolves with the child's
   * exit code and combined output, and never rejects.
   */
  readonly run?: (command: string, args: readonly string[]) => Promise<{ code: number; output: string }>
}

/**
 * The command line a reader could run themselves, for a diagnostic.
 * @param profile - the profile name.
 * @param args - the arguments after `--profile <name>`.
 * @returns the command, as typed.
 */
export function pluginCommand(profile: string, args: readonly string[]): string {
  return `${LAUNCHER} plugin --profile ${profile} ${args.join(' ')}`.trimEnd()
}

/**
 * Spawn one child with piped stdio, returning its code and combined output.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the exit code and combined stdout/stderr; never rejects.
 */
function spawnCaptured(command: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    // `shell: false` even on Windows: the launcher path found above is the
    // resolved shim itself, so there is nothing left for a shell to look up,
    // and passing user-typed package specs through a shell would make them
    // shell syntax.
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer): void => { output += chunk.toString('utf8') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      output += `\n${LAUNCHER}: no answer after ${String(PLUGIN_TIMEOUT_MS / 1_000)}s; the child was stopped\n`
    }, PLUGIN_TIMEOUT_MS)
    timer.unref()
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ code: 127, output: `${output}\n${error.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

/**
 * The last few non-empty lines of child output.
 * @param output - the child's combined output.
 * @returns at most {@link KEPT_OUTPUT_LINES} lines.
 */
function tail(output: string): string[] {
  const lines = output.split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
  return lines.slice(-KEPT_OUTPUT_LINES)
}

/**
 * Run one `dsh plugin` invocation against one profile.
 *
 * Never throws: a launcher that is not installed, a child that fails, and a
 * child that never answers are all outcomes a reader is told about, because
 * each is a fact about their machine rather than a defect in this browser.
 * @param spec - the profile, the operation, and the injectable seams.
 * @returns what happened.
 */
export async function runProfileOperation(spec: ProfileOperationSpec): Promise<ProfileActionOutcome> {
  const { profile, resolved } = spec
  const command = pluginCommand(profile, resolved.args)
  const launcher = await (spec.launcher ?? findLauncher)()
  if (launcher === undefined) {
    return {
      kind: 'failed',
      message: `the dsh launcher is not on PATH — run this yourself: ${command}`,
      output: [],
    }
  }
  const args = ['plugin', '--profile', profile, ...resolved.args]
  const { code, output } = await (spec.run ?? spawnCaptured)(launcher, args)
  if (code !== 0) {
    return {
      kind: 'failed',
      message: `${command} exited ${String(code)}`,
      output: tail(output),
    }
  }
  return { kind: 'done', message: `${profile}: ${resolved.running} — done`, output: tail(output) }
}

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
 * mechanism used is the one Harness itself owns — the `dsh` executable,
 * resolved by `../launcher.ts` the same four ways `bin/dshline.mjs` resolves
 * it, so a `/profiles` mutation reaches the launcher in every environment this
 * frontend itself starts in.
 *
 * Four things this module does that the CLI does not, all because a TUI owns
 * the terminal and a person is waiting:
 *
 * ```
 * stdio is PIPED, never inherited   `dsh plugin` uses stdio:'inherit'; a child
 *                                   writing pnpm progress straight into a
 *                                   screen this process is painting would
 *                                   corrupt the live region
 * output is a ROLLING tail          pnpm can emit megabytes; only the last few
 *                                   lines are ever held, so a long install
 *                                   cannot grow this process's memory with
 *                                   text nobody will read
 * the timeout SETTLES               a bound that sends SIGTERM and then waits
 *                                   forever is not a bound: a child that
 *                                   ignores it would hold the profile lock for
 *                                   the rest of the session
 * specs are REDACTED for display    a package spec can carry a token in a URL;
 *                                   it is passed to the launcher verbatim and
 *                                   never written to the transcript as-is
 * ```
 * @module dshline/profiles/actions
 */

import { spawn } from 'node:child_process'
import { resolveLauncher } from '../launcher.ts'
import type { Launcher } from '../launcher.ts'
import type { ResolvedOperation } from './model.ts'

/**
 * How long one invocation may run before it is stopped.
 *
 * Generous, because a pnpm install reaches the network and may build native
 * packages — but bounded, and the bound is enforced to completion below.
 */
const PLUGIN_TIMEOUT_MS = 600_000

/**
 * How long a stopped child is given to exit before it is killed outright.
 *
 * pnpm spawns its own children, and a SIGTERM it declines to act on must not
 * become an indefinite wait. On Windows there is no graceful signal at all —
 * `kill()` terminates — so this grace period simply never elapses there.
 */
const KILL_GRACE_MS = 5_000

/** Lines of child output kept for the transcript. */
const KEPT_OUTPUT_LINES = 6

/** Bytes of child output held at once, before older text is dropped. */
const OUTPUT_TAIL_BYTES = 16_384

/** How one invocation ended, in words the transcript can carry. */
export interface ProfileActionOutcome {
  /** Whether the invocation succeeded. */
  readonly kind: 'done' | 'failed'
  /** What happened, already worded for a reader. */
  readonly message: string
  /** The tail of the child's own output, when it produced any. */
  readonly output: readonly string[]
}

/** What one child invocation answered. */
export interface ChildResult {
  /** The exit code, or a stand-in when the child never reported one. */
  readonly code: number
  /** The retained tail of its combined output. */
  readonly output: string
}

/** What {@link runProfileOperation} needs to run one invocation. */
export interface ProfileOperationSpec {
  /** The profile name the operation is addressed to. */
  readonly profile: string
  /** The resolved operation, from `model.ts`. */
  readonly resolved: ResolvedOperation
  /**
   * Resolve the launcher; injected so a test drives the whole chain without a
   * launcher installed.
   */
  readonly launcher?: () => ReturnType<typeof resolveLauncher>
  /**
   * Spawn one child; injected for the same reason. Resolves with the child's
   * exit code and retained output, and never rejects.
   */
  readonly run?: (launcher: Launcher, args: readonly string[]) => Promise<ChildResult>
}

/**
 * Whether a package spec could carry a secret.
 *
 * A registry name cannot; a URL can, and `pnpm add` accepts URLs. Userinfo in
 * a URL (`https://x-access-token:ghp_…@host/…`) and a query string (`?token=…`)
 * are the two shapes that actually appear.
 */
const SPEC_WITH_URL = /:\/\/|^git\+|^https?:|@[^/]*:/u

/**
 * One argument as it is safe to SHOW.
 *
 * Redaction is display-only: the launcher receives the argument verbatim, as
 * one argv element, because that is what the user asked to install. What is
 * not safe is writing it into the transcript, which outlives the overlay and
 * is exactly where a token pasted into a prompt would otherwise be preserved.
 * @param argument - the argument as typed.
 * @returns the argument, or a placeholder naming what was withheld.
 */
export function displayArgument(argument: string): string {
  return SPEC_WITH_URL.test(argument) ? '<url spec withheld>' : argument
}

/** Userinfo or a token-ish query parameter inside a URL the child echoed back. */
const OUTPUT_SECRET = /(?<scheme>[a-z+]+:\/\/)(?<userinfo>[^/\s@]*@)|(?<query>[?&](?:token|access_token|password|key)=)[^\s&]+/giu

/**
 * One line of child output, safe to commit.
 *
 * pnpm echoes the spec it was given, so a token that reached the launcher in a
 * URL reaches the transcript through the child's own output unless it is taken
 * out here. The transcript outlives the overlay and is the durable copy, which
 * is precisely why this is the place to do it.
 * @param line - one line as the child wrote it.
 * @returns the line with any embedded credential replaced.
 */
export function redactOutputLine(line: string): string {
  return line.replace(OUTPUT_SECRET, (_match, scheme?: string, _userinfo?: string, query?: string) =>
    scheme !== undefined ? `${scheme}<redacted>@` : `${query ?? ''}<redacted>`)
}

/**
 * The command line a reader could run themselves, quoted so it is true.
 *
 * A package spec may hold characters a shell would act on, so an argv list
 * pasted together with spaces is not the command that ran. Each argument that
 * needs it is single-quoted, which is what makes this safe to copy rather than
 * merely readable.
 * @param profile - the profile name.
 * @param args - the arguments after `--profile <name>`.
 * @returns the command, safe to show and to paste.
 */
export function pluginCommand(profile: string, args: readonly string[]): string {
  const parts = ['dsh', 'plugin', '--profile', profile, ...args.map(displayArgument)]
  return parts.map(shellQuote).join(' ')
}

/** Whether one argument is safe to paste into a shell unquoted. */
const SHELL_SAFE = /^[A-Za-z0-9@._/=+:-]+$/u

/**
 * Single-quote one argument unless it plainly needs no quoting.
 * @param argument - the argument to render.
 * @returns the shell-safe rendering.
 */
function shellQuote(argument: string): string {
  if (argument !== '' && SHELL_SAFE.test(argument)) return argument
  return `'${argument.replace(/'/gu, `'\\''`)}'`
}

/**
 * A bounded, rolling tail of a child's output.
 *
 * Appends and forgets: nothing older than {@link OUTPUT_TAIL_BYTES} is kept, so
 * a pnpm run that prints a progress line per package cannot grow this process's
 * memory in proportion to its output.
 */
class OutputTail {
  private held = ''

  /**
   * Add a chunk, dropping whatever no longer fits.
   * @param chunk - the text just read.
   */
  push(chunk: string): void {
    this.held = this.held.length + chunk.length <= OUTPUT_TAIL_BYTES
      ? this.held + chunk
      : (this.held + chunk).slice(-OUTPUT_TAIL_BYTES)
  }

  /** The retained text. */
  text(): string {
    return this.held
  }
}

/** Timings for one child, overridable so the bound itself can be tested. */
export interface ChildTimings {
  /** How long the child may run before it is stopped. */
  readonly timeoutMs?: number
  /** How long a stopped child is given to exit before it is killed outright. */
  readonly killGraceMs?: number
}

/**
 * Stop a child, and everything it started.
 *
 * pnpm spawns its own children, so signalling only the launcher would leave a
 * download or a build running with nothing waiting for it. On POSIX the child
 * is its own process-group leader (`detached`), so the negative pid signals the
 * whole group; Windows has no group signal and no graceful one either, where
 * `kill()` terminates the child directly.
 * @param child - the spawned launcher.
 * @param signal - the signal to send.
 */
function stopTree(child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The group is already gone, or this child never became a leader. Fall
      // through to signalling the process itself, which is still worth trying.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already exited between the timeout firing and this call.
  }
}

/**
 * Spawn one child with piped stdio, returning its code and retained output.
 *
 * Settles exactly once, and always. The timeout stops the child and then
 * ESCALATES: `SIGTERM` to the process group, then `SIGKILL` after a grace
 * period, then — because even a kill can leave this promise waiting on a pipe
 * that never closes — the result is resolved on its own. A bound that sends a
 * signal and then waits indefinitely is not a bound, and the profile lock is
 * waiting on this one.
 * @param launcher - how to run the launcher.
 * @param args - the arguments after the launcher's own prefix.
 * @param timings - overrides for the bound; defaults are the module constants.
 * @returns the exit code and retained output; never rejects.
 */
export function spawnCaptured(
  launcher: Launcher,
  args: readonly string[],
  timings: ChildTimings = {},
): Promise<ChildResult> {
  const timeoutMs = timings.timeoutMs ?? PLUGIN_TIMEOUT_MS
  const killGraceMs = timings.killGraceMs ?? KILL_GRACE_MS
  return new Promise(resolve => {
    const tail = new OutputTail()
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let giveUpTimer: NodeJS.Timeout | undefined
    const settle = (code: number, note?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer)
      if (note !== undefined) tail.push(`\n${note}\n`)
      resolve({ code, output: tail.text() })
    }
    // `shell: false`: the launcher is a resolved path (or a bare `dsh` Node
    // itself finds), so there is nothing for a shell to look up, and passing a
    // user-typed package spec through one would make it shell syntax.
    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group on POSIX, so `stopTree` can signal everything
      // pnpm started rather than only the launcher.
      detached: process.platform !== 'win32',
      ...launcher.cwd === undefined ? {} : { cwd: launcher.cwd },
    })
    const collect = (chunk: Buffer): void => { tail.push(chunk.toString('utf8')) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      tail.push(`\ndsh: no answer after ${String(Math.round(timeoutMs / 1_000))}s; stopping the child\n`)
      stopTree(child, 'SIGTERM')
      killTimer = setTimeout(() => { stopTree(child, 'SIGKILL') }, killGraceMs)
      killTimer.unref()
      giveUpTimer = setTimeout(
        () => { settle(124, 'dsh: the child did not exit after being killed') },
        killGraceMs * 2,
      )
      giveUpTimer.unref()
    }, timeoutMs)
    timer.unref()
    child.on('error', (error: Error) => { settle(127, error.message) })
    child.on('close', code => { settle(code ?? 1) })
  })
}

/**
 * The last few non-empty lines of retained output.
 * @param output - the child's retained output.
 * @returns at most {@link KEPT_OUTPUT_LINES} lines.
 */
function tailLines(output: string): string[] {
  const lines = output.split('\n')
    .map(line => redactOutputLine(line.trimEnd()))
    .filter(line => line.trim() !== '')
  return lines.slice(-KEPT_OUTPUT_LINES)
}

/**
 * Run one `dsh plugin` invocation against one profile.
 *
 * Never throws: a launcher that is not installed, one the user pointed
 * somewhere wrong, a child that fails, and a child that never answers are all
 * facts about the machine rather than defects in this browser, and each has to
 * reach the reader as an outcome.
 * @param spec - the profile, the operation, and the injectable seams.
 * @returns what happened.
 */
export async function runProfileOperation(spec: ProfileOperationSpec): Promise<ProfileActionOutcome> {
  const { profile, resolved } = spec
  const command = pluginCommand(profile, resolved.args)
  const resolution = (spec.launcher ?? resolveLauncher)()
  if (resolution.kind === 'misconfigured') {
    return { kind: 'failed', message: `${resolution.message} — run this yourself: ${command}`, output: [] }
  }
  if (resolution.kind === 'none') {
    return {
      kind: 'failed',
      message: `the dsh launcher could not be found — run this yourself: ${command}`,
      output: [],
    }
  }
  const args = ['plugin', '--profile', profile, ...resolved.args]
  const { code, output } = await (spec.run ?? spawnCaptured)(resolution.launcher, args)
  if (code !== 0) {
    return { kind: 'failed', message: `${command} exited ${String(code)}`, output: tailLines(output) }
  }
  return { kind: 'done', message: `${profile}: ${resolved.running} — done`, output: tailLines(output) }
}

/**
 * One in-flight operation per profile, for the whole process.
 *
 * Deliberately module state rather than something `openProfiles` owns. A
 * `busy` flag inside one browser is undone by closing it: start an install,
 * press esc, reopen, start another, and two pnpm runs race on the same profile
 * directory and its lockfile. The overlay is a view of a profile; the profile
 * is what can only take one write at a time, so the lock belongs to the
 * profile name and outlives every view of it.
 */
const inFlight = new Map<string, Promise<unknown>>()

/** Whether a profile already has an operation running. */
export function operationInFlight(profile: string): boolean {
  return inFlight.has(profile)
}

/**
 * Run `task` while holding the lock for `profile`, or refuse.
 * @param profile - the profile the operation writes to.
 * @param task - the work to run under the lock.
 * @returns what the task answered, or undefined when the profile was busy.
 */
export async function withProfileLock<T>(profile: string, task: () => Promise<T>): Promise<T | undefined> {
  if (inFlight.has(profile)) return undefined
  const running = task()
  inFlight.set(profile, running)
  try {
    return await running
  } finally {
    inFlight.delete(profile)
  }
}

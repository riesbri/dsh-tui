#!/usr/bin/env node
/**
 * `dshtui` — start a terminal session in the current folder.
 *
 * This frontend is a plugin, so it is started by the harness's own launcher with
 * `dsh --profile tui`. That is two decisions to remember (which launcher, which
 * profile) before anything happens, and on a server it is the difference between
 * using this and not bothering. This wrapper makes the whole thing one word.
 *
 * It finds the launcher, adds `--profile tui` unless another profile was asked for,
 * pins the session to the folder you ran it from, and hands over the terminal. Every
 * other argument is passed through untouched, so `dshtui --resume`, `dshtui "run the
 * tests"` and `dshtui --help` all reach the real launcher.
 *
 * Deliberately a launcher and nothing else: it starts no session logic of its own,
 * so there is only ever one implementation of the frontend to reason about.
 * @module @riesbri/dsh-tui/bin/dshtui
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/** The profile this wrapper starts, and installs into with `--setup`. */
const PROFILE = 'tui'

/** This package, as `dsh plugin add` names it. */
const PACKAGE = '@riesbri/dsh-tui'

/** The harness's launcher package, resolved when no `dsh` is on PATH. */
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/**
 * How to run the harness launcher: a command and any arguments that must precede
 * the ones this wrapper passes.
 * @typedef {{ command: string, prefix: string[], describe: string }} Launcher
 */

/**
 * Whether a command exists on PATH.
 *
 * Looked up rather than probed by running it. Running `dsh --version` to find out
 * whether `dsh` exists would put a whole Node startup in front of every launch, for
 * an answer the filesystem already has. The Windows extensions are tried because a
 * launcher installed by npm there is a `.cmd` shim rather than the name itself.
 * @param name - the command to look for.
 * @returns whether a matching file was found.
 */
function onPath(name) {
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const candidate of candidates) {
      if (existsSync(join(directory, candidate))) return true
    }
  }
  return false
}

/**
 * Find the harness launcher.
 *
 * Three ways, in the order that respects what the user has already decided:
 * `DSH_BIN` when they have pointed at one explicitly, then `dsh` on PATH for the
 * ordinary global install, then the launcher package resolved from this one — which
 * is what makes `npm i -g @deepseek-ai/dsh @riesbri/dsh-tui` enough, since a global
 * install puts the two side by side.
 * @returns the launcher, or undefined when none can be found.
 */
function findLauncher() {
  const configured = process.env.DSH_BIN
  if (configured !== undefined && configured !== '') {
    return { command: configured, prefix: [], describe: `$DSH_BIN (${configured})` }
  }
  if (onPath('dsh')) return { command: 'dsh', prefix: [], describe: 'dsh on your PATH' }
  try {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve(`${LAUNCHER_PACKAGE}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof entry !== 'string') return undefined
    const script = join(dirname(manifestPath), entry)
    if (!existsSync(script)) return undefined
    // Run through this Node rather than the script's own shebang, so it does not
    // matter whether the file is executable in the install that provided it.
    return { command: process.execPath, prefix: [script], describe: `${LAUNCHER_PACKAGE} (${script})` }
  } catch {
    return undefined
  }
}

/**
 * Where the harness keeps this profile.
 *
 * Resolved the same way the harness resolves it — `$DSH_HOME` when set, `~/.dsh`
 * otherwise, with a leading `~` expanded — because a wrapper that guessed
 * differently would announce a missing profile that is really there.
 * @returns the absolute profile directory.
 */
function profileDirectory() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  const home = configured === ''
    ? join(homedir(), '.dsh')
    : configured === '~'
      ? homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? join(homedir(), configured.slice(2))
        : configured
  return join(home, 'profiles', PROFILE)
}

/**
 * Whether an argument list already chooses a profile, in either accepted form.
 * @param args - the arguments this wrapper was given.
 * @returns whether `--profile` is present.
 */
function choosesProfile(args) {
  return args.some(argument => argument === '--profile' || argument.startsWith('--profile='))
}

/**
 * Whether an argument list already chooses a working folder.
 * @param args - the arguments this wrapper was given.
 * @returns whether a cwd flag is present.
 */
function choosesCwd(args) {
  return args.some(argument => argument === '-C' || argument === '--cwd' || argument.startsWith('--cwd='))
}

/**
 * Run the launcher and exit with its status.
 *
 * `stdio: 'inherit'` is the whole point: the frontend refuses to start without a
 * real terminal, so the child must be given this process's own. SIGINT is ignored
 * here for the same reason — `ctrl-c` is a keystroke the frontend decides the
 * meaning of, and a wrapper that died on it would tear down the session mid-turn.
 * @param launcher - how to run the launcher.
 * @param args - the arguments to pass.
 */
function handOver(launcher, args) {
  process.on('SIGINT', () => {})
  const child = spawn(launcher.command, [...launcher.prefix, ...args], { stdio: 'inherit' })
  child.on('error', (error) => {
    process.stderr.write(`dshtui: could not start ${launcher.describe}: ${error.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

const args = process.argv.slice(2)

if (args[0] === '--setup') {
  const launcher = findLauncher()
  if (launcher === undefined) {
    process.stderr.write(missingLauncherMessage())
    process.exit(127)
  }
  // A source may be given instead of the published package — `dshtui --setup
  // ./packages/tui` is how someone testing a checkout installs it, and it is the
  // same argument `dsh plugin add` takes, so it is passed through rather than
  // reinvented. Anything further goes to the launcher untouched.
  const source = args.length > 1 ? args.slice(1) : [PACKAGE]
  process.stdout.write(`dshtui: installing ${source[0] ?? PACKAGE} into the "${PROFILE}" profile\n`)
  handOver(launcher, ['plugin', '--profile', PROFILE, 'add', ...source])
} else {
  const launcher = findLauncher()
  if (launcher === undefined) {
    process.stderr.write(missingLauncherMessage())
    process.exit(127)
  }
  if (!existsSync(profileDirectory())) {
    process.stderr.write(`dshtui: the "${PROFILE}" profile does not exist yet. Create it once with:\n\n  dshtui --setup\n\n`)
    process.exit(1)
  }
  // Added BEFORE the caller's arguments, never after. A first task is a positional
  // argument — `dshtui "run the tests"` — and appending a flag behind positionals
  // leaves the parser deciding whether `--cwd` belongs to the option or to the task.
  const added = []
  if (!choosesProfile(args)) added.push('--profile', PROFILE)
  // The folder is pinned explicitly rather than left to the launcher's own default,
  // because the launcher may be reached through something that changed folder on the
  // way — a shell function that enters a harness checkout first, for instance.
  // `--resume` ignores it by design and keeps the folder its session was created in.
  if (!choosesCwd(args)) added.push('--cwd', process.cwd())
  handOver(launcher, [...added, ...args])
}

/**
 * What to print when no launcher can be found.
 * @returns the message, ending in a newline.
 */
function missingLauncherMessage() {
  return [
    'dshtui: cannot find the DeepSeek Harness launcher.',
    '',
    'This is a plugin for the harness, so the harness has to be installed too:',
    '',
    `  npm install -g ${LAUNCHER_PACKAGE}`,
    '  dshtui --setup',
    '',
    'If you run the harness from a source checkout, point this at its launcher:',
    '',
    '  export DSH_BIN=~/path/to/deepseek-harness/node_modules/.bin/dsh',
    '',
  ].join('\n')
}

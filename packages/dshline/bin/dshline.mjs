#!/usr/bin/env node
/**
 * `dshline` — start a terminal session in the current folder.
 *
 * This frontend is a plugin, so it is started by the harness's own launcher with
 * `dsh --profile dshline`. That is two decisions to remember (which launcher, which
 * profile) before anything happens, and on a server it is the difference between
 * using this and not bothering. This wrapper makes the whole thing one word.
 *
 * It finds the launcher, adds `--profile dshline` unless another profile was asked for,
 * pins the session to the folder you ran it from, and hands over the terminal. Every
 * other argument is passed through untouched, so `dshline --resume`, `dshline "run the
 * tests"` and `dshline --help` all reach the real launcher.
 *
 * Deliberately a launcher and nothing else: it starts no session logic of its own,
 * so there is only ever one implementation of the frontend to reason about.
 * @module dshline/bin/dshline
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/** The profile this wrapper starts, and installs into with `--setup`. */
const PROFILE = 'dshline'

/** This package, as `dsh plugin add` names it. */
const PACKAGE = '@dshline/dshline'

/** The harness's launcher package, resolved when no `dsh` is on PATH. */
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/**
 * The script a harness source checkout uses to launch itself.
 *
 * A checkout has no `dsh` executable at all — the launcher is a TypeScript entry run
 * through a loader, and the checkout's own `package.json` is where that command is
 * written down. Reading it from there rather than hardcoding the path means this
 * keeps working when the harness moves its own files.
 */
const HARNESS_SCRIPT = 'dsh'

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
 * is what makes `npm i -g @deepseek-ai/dsh @dshline/dshline` enough, since a global
 * install puts the two side by side.
 * @returns the launcher, or undefined when none can be found.
 */
function findLauncher() {
  const configured = (process.env.DSH_BIN ?? '').trim()
  if (configured !== '') {
    // Checked rather than handed to spawn, so a wrong path is a sentence instead of
    // an ENOENT naming a file the reader already believed was there.
    if (!existsSync(configured)) {
      return { error: `$DSH_BIN points at ${configured}, which does not exist.${sourceCheckoutHint(configured)}` }
    }
    return { command: configured, prefix: [], describe: `$DSH_BIN (${configured})` }
  }
  const checkout = (process.env.DSH_HARNESS ?? '').trim()
  if (checkout !== '') {
    const expanded = checkout.startsWith('~/') ? join(homedir(), checkout.slice(2)) : checkout
    const manifestPath = join(expanded, 'package.json')
    if (!existsSync(manifestPath)) {
      return { error: `$DSH_HARNESS points at ${expanded}, which is not a harness checkout (no package.json).` }
    }
    let command
    try {
      command = JSON.parse(readFileSync(manifestPath, 'utf8')).scripts?.[HARNESS_SCRIPT]
    } catch {
      command = undefined
    }
    if (typeof command !== 'string' || command.trim() === '') {
      return { error: `${manifestPath} has no "${HARNESS_SCRIPT}" script, so this does not look like a harness checkout.` }
    }
    // The script is a plain command line — `node --import tsx/esm apps/cli/src/bin.ts`
    // — with paths relative to the checkout, so it runs from there. Split on
    // whitespace because that is what the value is; nothing here quotes arguments.
    const [program, ...rest] = command.trim().split(/\s+/u)
    return {
      command: program ?? 'node',
      prefix: rest,
      cwd: expanded,
      describe: `$DSH_HARNESS (${expanded}: ${command})`,
    }
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
  const child = spawn(launcher.command, [...launcher.prefix, ...args], {
    stdio: 'inherit',
    // A source checkout's launcher is a relative path inside it, and its loader
    // resolves from there too, so that launcher only runs with the checkout as the
    // working directory. The session's own folder is passed as an argument instead.
    ...launcher.cwd === undefined ? {} : { cwd: launcher.cwd },
  })
  child.on('error', (error) => {
    process.stderr.write(`dshline: could not start ${launcher.describe}: ${error.message}\n`)
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

/**
 * Resolve the launcher or leave, having said why.
 * @returns the launcher, once it is known to be usable.
 */
function launcherOrExit() {
  const found = findLauncher()
  if (found === undefined) {
    process.stderr.write(missingLauncherMessage())
    process.exit(127)
  }
  if (found.error !== undefined) {
    process.stderr.write(`dshline: ${found.error}\n`)
    process.exit(127)
  }
  return found
}

if (args[0] === '--setup') {
  const launcher = launcherOrExit()
  // A source may be given instead of the published package — `dshline --setup
  // ./packages/dshline` is how someone testing a checkout installs it, and it is the
  // same argument `dsh plugin add` takes, so it is passed through rather than
  // reinvented. Anything further goes to the launcher untouched.
  const source = args.length > 1 ? args.slice(1) : [PACKAGE]
  process.stdout.write(`dshline: installing ${source[0] ?? PACKAGE} into the "${PROFILE}" profile\n`)
  handOver(launcher, ['plugin', '--profile', PROFILE, 'add', ...source])
} else {
  const launcher = launcherOrExit()
  if (!existsSync(profileDirectory())) {
    process.stderr.write(`dshline: the "${PROFILE}" profile does not exist yet. Create it once with:\n\n  dshline --setup\n\n`)
    process.exit(1)
  }
  // Added BEFORE the caller's arguments, never after. A first task is a positional
  // argument — `dshline "run the tests"` — and appending a flag behind positionals
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
 * The likely correction when `$DSH_BIN` names something that is not there.
 *
 * A source checkout has no `dsh` executable to point at — the launcher is a
 * TypeScript entry run through a loader — so this is the mistake a reader is most
 * likely to have made, and `$DSH_HARNESS` is the answer to it.
 * @param configured - the path that did not exist.
 * @returns a sentence beginning with a space, or an empty string.
 */
function sourceCheckoutHint(configured) {
  if (!/node_modules[\\/]\.bin[\\/]dsh$/u.test(configured)) return ''
  const checkout = configured.replace(/[\\/]node_modules[\\/]\.bin[\\/]dsh$/u, '')
  return ` A harness SOURCE CHECKOUT has no such executable — its launcher is a script.`
    + ` Point at the checkout itself instead:\n\n  export DSH_HARNESS=${checkout}\n`
}

/**
 * What to print when no launcher can be found.
 * @returns the message, ending in a newline.
 */
function missingLauncherMessage() {
  return [
    'dshline: cannot find the DeepSeek Harness launcher.',
    '',
    'This is a plugin for the harness, so the harness has to be installed too:',
    '',
    `  npm install -g ${LAUNCHER_PACKAGE}`,
    '  dshline --setup',
    '',
    'If you run the harness from a SOURCE CHECKOUT, name the checkout — not a',
    'binary, because a checkout does not build one:',
    '',
    '  export DSH_HARNESS=~/path/to/deepseek-harness',
    '',
    'Or name an executable directly, if you have one:',
    '',
    '  export DSH_BIN=/path/to/dsh',
    '',
  ].join('\n')
}

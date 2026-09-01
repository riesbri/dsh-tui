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
 * On a first run it asks once whether the harness may create and install that profile,
 * then continues into the launch that was asked for. That is the whole of its lifecycle
 * involvement: the mutation is `dsh plugin --profile dshline add @dshline/dshline`, run
 * through the launcher found below, because the harness owns profile initialization,
 * package installation, pnpm, the bundle list, and every reconciliation between them.
 * This wrapper decides only whether to offer that one command — and only when the
 * profile has never been initialized at all. A profile that exists and is broken is the
 * harness's to diagnose; a second package manager here would be a second answer to the
 * same question.
 *
 * Deliberately a launcher and nothing else: it starts no session logic of its own,
 * so there is only ever one implementation of the frontend to reason about.
 * @module dshline/bin/dshline
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

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

/** Exit status when the user declines or cancels the first-run question. */
const DECLINED = 1

/**
 * Exit status after `ctrl-c` at the question: the shell convention for a process
 * ended by SIGINT, which is what the keystroke meant even though nothing here died
 * of a signal to produce it.
 */
const CANCELLED = 130

/**
 * How to run the harness launcher: a command and any arguments that must precede
 * the ones this wrapper passes.
 * @typedef {{ command: string, prefix: string[], cwd?: string, describe: string }} Launcher
 */

/**
 * Where a command is on PATH.
 *
 * Looked up rather than probed by running it. Running `dsh --version` to find out
 * whether `dsh` exists would put a whole Node startup in front of every launch, for
 * an answer the filesystem already has. The Windows extensions are tried because a
 * launcher installed by npm there is a `.cmd` shim rather than the name itself — and
 * the path is returned, not just a yes, because that shim is the file that has to be
 * run: `spawn('dsh')` on Windows looks for a `dsh` with no extension and finds
 * nothing.
 * @param name - the command to look for.
 * @returns the path of the first match, or undefined when there is none.
 */
function onPath(name) {
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const candidate of candidates) {
      const path = join(directory, candidate)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

/**
 * Find the harness launcher.
 *
 * Four ways, in the order that respects what the user has already decided:
 * `DSH_BIN` when they have pointed at one explicitly, then `DSH_HARNESS` for a source
 * checkout, then `dsh` on PATH for the ordinary global install, then the launcher
 * package resolved from this one — which is what makes
 * `npm i -g @deepseek-ai/dsh @dshline/dshline` enough, since a global install puts the
 * two side by side.
 * @returns the launcher, an `error` to print, or undefined when none can be found.
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
  const found = onPath('dsh')
  if (found !== undefined) {
    // The bare name everywhere but Windows, so Node resolves it the way a shell
    // would; the shim's own path there, because a bare `dsh` names no file.
    return { command: process.platform === 'win32' ? found : HARNESS_SCRIPT, prefix: [], describe: 'dsh on your PATH' }
  }
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
 * Whether the harness has ever initialized this profile.
 *
 * The manifest, not the directory: `dsh plugin` decides the same way — it
 * initializes when `package.json` is absent and treats the profile as existing when
 * it is there — and an interrupted first install leaves the directory behind without
 * one. A wrapper that asked whether the folder existed would then refuse to offer
 * setup for a profile the harness itself considers uninitialized.
 *
 * Nothing beyond the manifest is examined on purpose. Absent dependencies, an empty
 * node_modules, a package that will not resolve, a malformed bundle list — those are
 * an existing profile that is broken, and the harness's loader is the authority that
 * says so. A wrapper that reinstalled on any of them would hide the diagnosis behind
 * a package operation nobody asked for.
 * @returns whether the profile manifest exists.
 */
function profileInitialized() {
  return existsSync(join(profileDirectory(), 'package.json'))
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
 * What this invocation should do about the profile before launching.
 *
 * A separate function from the acting on it because this is the whole of the
 * policy, and the policy is what has to be provable:
 *
 * - `--profile` in the arguments means the caller is speaking harness profile
 *   language directly, so nothing here inspects, creates, or repairs anything. That
 *   holds for `--profile dshline` too: the distinction is ownership, not which name
 *   was typed. The old wrapper checked its own profile no matter which one was asked
 *   for, which is how `dshline --profile other` could refuse to start.
 * - An initialized profile launches, whatever state it is in.
 * - Otherwise setup is offered, and only with a terminal on both ends: it may install
 *   packages from the network, so a scripted run must say so and stop rather than
 *   mutate anything.
 * @param decision - the arguments, and the two facts about this invocation.
 * @param decision.args - the arguments this wrapper was given.
 * @param decision.initialized - whether the profile manifest exists.
 * @param decision.interactive - whether stdin and stdout are both terminals.
 * @returns `'launch'`, `'confirm'`, or `'no-terminal'`.
 */
export function bootstrapPlan({ args, initialized, interactive }) {
  if (choosesProfile(args)) return 'launch'
  if (initialized) return 'launch'
  return interactive ? 'confirm' : 'no-terminal'
}

/**
 * Whether the confirmation can be asked at all.
 * @returns whether stdin and stdout are both terminals.
 */
function hasTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/**
 * Read the version this package declares.
 *
 * From the manifest beside `bin/`, not from anything compiled: `--version` is what a
 * bug report asks for, so it has to answer in a source checkout that was never
 * built, with no harness installed, no profile, and no terminal.
 * @returns the version string.
 */
function ownVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

/**
 * Ask the first-run question and read one answer.
 *
 * `readline` rather than a raw read of stdin: it puts the terminal in the mode where
 * `ctrl-c` arrives as a keystroke this process can answer for, which is what lets the
 * question be cancelled without a signal killing the wrapper mid-sentence. Both ways
 * out — `ctrl-c` and an end of input — resolve to undefined, because they mean the
 * same thing here: nobody said yes, so nothing is installed.
 * @param question - the prompt to write, including its trailing space.
 * @returns the answer, or undefined when the question was cancelled.
 */
function ask(question) {
  return new Promise(resolvePromise => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Every path answers before closing, never after. `close()` emits its event
    // synchronously, so closing first would let the end-of-input case below settle
    // this promise with undefined while an answer was already in hand.
    rl.on('SIGINT', () => {
      resolvePromise(undefined)
      rl.close()
    })
    // End of input — `ctrl-d`, or a stdin that went away — means the same as a no.
    // Also fires after an answered question, when this promise is already settled.
    rl.on('close', () => resolvePromise(undefined))
    rl.question(question, answer => {
      resolvePromise(answer)
      rl.close()
    })
  })
}

/**
 * Whether an answer to a default-yes question means yes.
 * @param answer - what the user typed, or undefined when they cancelled.
 * @returns whether to go ahead.
 */
export function saidYes(answer) {
  if (answer === undefined) return false
  const trimmed = answer.trim().toLowerCase()
  return trimmed === '' || trimmed === 'y' || trimmed === 'yes'
}

/**
 * Characters `cmd.exe` reads as syntax rather than as data.
 *
 * The set is `cross-spawn`'s, which is the list that has survived contact with real
 * Windows installs; the reasoning behind each entry is qntm's "Escaping in
 * cmd.exe" (https://qntm.org/cmd), which this implementation follows step for step
 * rather than approximately.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu

/**
 * Quote one argument for `cmd.exe`, which sits between this process and a `.cmd`
 * shim.
 *
 * Two parsers in a row, so two layers of escaping. The backslash-and-quote work is
 * what `CommandLineToArgvW` undoes to rebuild argv in the program that finally
 * runs; the `^` escapes are what stop `cmd` from acting on a character before that
 * happens. A shim is escaped TWICE because a shim is a batch file that re-invokes
 * its real target with `%*`, so the same command line is parsed by `cmd` a second
 * time — one layer would leave the second parse acting on the data.
 *
 * The `^` layers are `cross-spawn`'s, transcribed rather than depended on: the
 * wrapper must run before anything is installed or built, so it imports nothing.
 * Node's own `shell: true` is not an alternative either — it joins arguments with
 * spaces and quotes none of them, so a first task with a space in it would arrive
 * as several arguments.
 *
 * The backslash rule below is qntm's, and deliberately NOT cross-spawn's
 * expression of it: cross-spawn matches the run of backslashes before a quote with
 * a lazy group inside a lookahead, which for two or more backslashes matches only
 * the last one and leaves the rest undoubled. `a\\"b` then reaches the program as
 * `a\\b` — an even run of backslashes, so `CommandLineToArgvW` reads the quote as
 * a quote and drops it. Found by the Windows job, which is the only place that
 * difference is visible.
 * @param argument - one argument, verbatim from argv.
 * @param doubleEscape - whether a second `cmd` parse will see this line.
 * @returns the argument as `cmd.exe` must be given it.
 */
export function quoteForCmd(argument, doubleEscape = true) {
  // Double EVERY backslash that precedes a quote and escape the quote, then double a
  // trailing run so the closing quote below cannot be escaped by it.
  let value = argument.replace(/(\\*)"/gu, '$1$1\\"')
  value = value.replace(/(\\*)$/u, '$1$1')
  value = `"${value}"`
  value = value.replace(CMD_META, '^$1')
  if (doubleEscape) value = value.replace(CMD_META, '^$1')
  return value
}

/**
 * Whether a command is a Windows batch shim rather than an executable.
 * @param command - the command to run.
 * @returns whether `cmd.exe` has to interpret it.
 */
function isBatchShim(command) {
  return /\.(?:cmd|bat)$/iu.test(command)
}

/**
 * How to spawn one launcher invocation.
 *
 * Everywhere but Windows this is the command and the arguments, unchanged:
 * arguments are argv, never shell syntax, and no shell is involved. A Windows npm
 * install provides its launcher as a `.cmd` shim — a batch file, which `spawn` has
 * refused to run directly since the CVE-2024-27980 hardening — so that one case
 * goes through `cmd.exe`, quoted the way `cmd` requires and handed to Node
 * verbatim so it cannot be quoted twice.
 *
 * A carriage return or newline inside an argument is refused there instead. A
 * `cmd` command line has no representation for one: the character ends the command
 * rather than sitting inside an argument, and no amount of quoting changes that. A
 * wrapper that passed it anyway would be handing user text to `cmd` as syntax,
 * which is the one thing this function exists to prevent. The refusal is specific
 * to the shim path — a real executable, and every other platform, take the
 * argument as it is.
 * @param launcher - how to run the launcher.
 * @param args - the arguments to pass after its own prefix.
 * @param platform - the platform to plan for; defaults to this one.
 * @returns the command and its argv, or a `refuse` message instead.
 */
export function spawnPlan(launcher, args, platform = process.platform) {
  const argv = [...launcher.prefix, ...args]
  if (platform !== 'win32' || !isBatchShim(launcher.command)) {
    return { command: launcher.command, argv, verbatim: false }
  }
  const newline = argv.find(argument => /[\r\n]/u.test(argument))
  if (newline !== undefined) {
    return {
      refuse: `an argument contains a line break, which cannot be passed through ${launcher.command}.`
        + ' Run the harness launcher directly, or pass the text without line breaks.',
    }
  }
  const line = [
    launcher.command.replace(CMD_META, '^$1'),
    ...argv.map(argument => quoteForCmd(argument)),
  ].join(' ')
  // `/d` skips AutoRun commands, `/s` takes the whole quoted remainder as the
  // command line, and the outer quotes are what `/s` strips.
  return { command: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/**
 * Run the launcher with this process's own terminal and wait for it.
 *
 * `stdio: 'inherit'` is the whole point: the frontend refuses to start without a
 * real terminal, so the child must be given this process's own, and an install's
 * pnpm output is the only progress there is. SIGINT is ignored here for the same
 * reason — `ctrl-c` is a keystroke the frontend decides the meaning of, and a wrapper
 * that died on it would tear down the session mid-turn.
 * @param launcher - how to run the launcher.
 * @param args - the arguments to pass.
 * @returns how the child ended.
 */
function runLauncher(launcher, args) {
  return new Promise(resolvePromise => {
    const plan = spawnPlan(launcher, args)
    if (plan.refuse !== undefined) {
      process.stderr.write(`dshline: ${plan.refuse}\n`)
      process.exit(1)
    }
    // Installed for exactly as long as this child runs, and removed by name when it
    // ends: the ignore belongs to the hand-off, not to the process. Left behind, it
    // would also swallow a re-raised signal — which is how a wrapper that outlived a
    // killed child came to exit zero — and `removeAllListeners` is not the fix for a
    // listener this file added itself.
    process.on('SIGINT', ignoreSigint)
    const settle = (outcome) => {
      process.off('SIGINT', ignoreSigint)
      resolvePromise(outcome)
    }
    const child = spawn(plan.command, plan.argv, {
      stdio: 'inherit',
      ...plan.verbatim ? { windowsVerbatimArguments: true } : {},
      // A source checkout's launcher is a relative path inside it, and its loader
      // resolves from there too, so that launcher only runs with the checkout as the
      // working directory. The session's own folder is passed as an argument instead.
      ...launcher.cwd === undefined ? {} : { cwd: launcher.cwd },
    })
    child.on('error', (error) => {
      process.off('SIGINT', ignoreSigint)
      process.stderr.write(`dshline: could not start ${launcher.describe}: ${error.message}\n`)
      process.exit(127)
    })
    child.on('exit', (code, signal) => settle({ code, signal }))
  })
}

/**
 * Ignore SIGINT while a child owns the terminal.
 *
 * `ctrl-c` is a keystroke the frontend decides the meaning of, and a wrapper that
 * died on it would tear down the session mid-turn. Declared once, so it can be
 * taken off again by name.
 */
function ignoreSigint() {}

/**
 * Leave the way a child left.
 *
 * The signal is re-raised rather than turned into a status, so a caller sees the
 * same fact the child reported. Nothing has to be uninstalled first: the ignore is
 * owned by the run it was installed for and is already gone by here.
 * @param ended - the child's exit code and signal.
 */
function leaveAs(ended) {
  if (ended.signal !== null) {
    process.kill(process.pid, ended.signal)
    return
  }
  process.exit(ended.code ?? 0)
}

/**
 * Run the launcher and exit with its status.
 * @param launcher - how to run the launcher.
 * @param args - the arguments to pass.
 */
async function handOver(launcher, args) {
  leaveAs(await runLauncher(launcher, args))
}

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

/**
 * Create the profile through the harness, having been told to.
 *
 * Permission was given for this command, so this command runs — the profile is not
 * re-examined first. It is tempting to skip the install when a manifest has appeared
 * since the question went up, on the theory that another launcher must have finished
 * the same setup. That inference is wrong: `dsh plugin` WRITES that manifest before
 * it starts installing, so the file's presence proves a setup began, never that one
 * finished, and skipping on it would launch the frontend into a profile that is
 * still being installed. Deciding otherwise would mean reading dependencies,
 * node_modules, or bundle state — profile health, which is the harness's to judge.
 *
 * Two overlapping confirmed first runs therefore both run the mutation, which is the
 * harness's own concurrent-mutation question and not something a second lock here
 * would answer. Either way a failed setup fails this invocation and launches
 * nothing.
 * @param launcher - how to run the launcher.
 * @returns nothing, or does not return at all when setup failed.
 */
async function setUpProfile(launcher) {
  const ended = await runLauncher(launcher, ['plugin', '--profile', PROFILE, 'add', PACKAGE])
  if (ended.signal !== null || (ended.code ?? 0) !== 0) {
    // Nothing is launched after a failed setup: the harness has already said what
    // went wrong, and starting the frontend anyway would bury that under a second
    // failure from a profile that was never installed.
    process.stderr.write(`\ndshline: setup did not finish, so nothing was started. Try again with:\n\n  dshline --setup\n\n`)
    leaveAs(ended)
  }
}

/**
 * The one-time question, and what saying yes will run.
 * @returns the prompt, ending in the answer position.
 */
function firstRunQuestion() {
  return [
    `dshline: first run — the "${PROFILE}" harness profile is not set up yet.`,
    '',
    'This will run:',
    '',
    `  dsh plugin --profile ${PROFILE} add ${PACKAGE}`,
    '',
    'The harness creates the profile and installs this package into it, which uses',
    'the network through pnpm.',
    '',
    'Set it up now? [Y/n] ',
  ].join('\n')
}

/**
 * What to print when setup is needed and there is no terminal to ask on.
 * @returns the message, ending in a newline.
 */
function noTerminalMessage() {
  return [
    `dshline: the "${PROFILE}" harness profile is not set up.`,
    'Automatic first-run setup asks first, because it installs packages, and there is',
    'no terminal here to ask on.',
    '',
    'Run once:',
    '',
    '  dshline --setup',
    '',
  ].join('\n')
}

/**
 * Do what this invocation asked for.
 * @param args - the arguments after the executable.
 */
async function main(args) {
  // Before the launcher is looked for, and before anything touches a profile: the
  // answer is this package's own, and a bug report has to be able to get it from a
  // machine where the rest of the setup is what is broken.
  if (args[0] === '--version' || args[0] === '-V') {
    process.stdout.write(`${ownVersion()}\n`)
    return
  }
  if (args[0] === '--setup') {
    const launcher = launcherOrExit()
    // A source may be given instead of the published package — `dshline --setup
    // ./packages/dshline` is how someone testing a checkout installs it, and it is the
    // same argument `dsh plugin add` takes, so it is passed through rather than
    // reinvented. Anything further goes to the launcher untouched.
    //
    // Untouched includes a relative path, and under `$DSH_HARNESS` that means
    // something surprising: the launcher must run from the harness checkout, and
    // `dsh plugin` anchors a relative spec against the folder IT runs in, so
    // `./packages/dshline` names a folder inside the harness. Rewriting it here would
    // mean owning a copy of the harness's package-spec parser — which spec forms are
    // paths at all, and what `file:` versus a bare path means to pnpm — to make one
    // argument mean something different from what the same argument means to
    // `dsh plugin add`. An absolute path is the answer, and docs/install.md says so.
    const source = args.length > 1 ? args.slice(1) : [PACKAGE]
    process.stdout.write(`dshline: installing ${source[0] ?? PACKAGE} into the "${PROFILE}" profile\n`)
    // No question here, and no terminal requirement: the user asked for this exact
    // mutation by name, which is what makes `--setup` the scriptable path and the
    // answer to a first run that went wrong.
    await handOver(launcher, ['plugin', '--profile', PROFILE, 'add', ...source])
    return
  }
  const launcher = launcherOrExit()
  const plan = bootstrapPlan({ args, initialized: profileInitialized(), interactive: hasTerminal() })
  if (plan === 'no-terminal') {
    process.stderr.write(noTerminalMessage())
    process.exit(1)
  }
  if (plan === 'confirm') {
    const answer = await ask(firstRunQuestion())
    if (answer === undefined) {
      // The question was cancelled, and the cursor is sitting at the end of it.
      process.stdout.write('\n')
      process.exit(CANCELLED)
    }
    if (!saidYes(answer)) {
      process.stdout.write(`\nNothing was installed. When you want it:\n\n  dshline --setup\n\n`)
      process.exit(DECLINED)
    }
    await setUpProfile(launcher)
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
  await handOver(launcher, [...added, ...args])
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
    '  dshline',
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

/**
 * Whether this file was run as the command, rather than imported.
 *
 * Both sides are resolved through the filesystem before being compared, and
 * that is not defensive dressing: npm installs this executable as a SYMLINK on
 * the PATH, and Node reports `import.meta.url` for the file the link points at
 * while `argv[1]` is the link itself. A plain string comparison is therefore
 * false for every ordinary global install — the whole product — while looking
 * correct in a checkout, where the path has no link in it. That is exactly how
 * it was found: `dshline` did nothing at all and exited zero.
 * @returns whether to run.
 */
function invokedAsCommand() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(resolve(invoked)) === fileURLToPath(import.meta.url)
  } catch {
    // A name that resolves to nothing cannot be this file.
    return false
  }
}

// Run only as the executable, so the decisions above can be imported and
// checked without starting anything.
if (invokedAsCommand()) {
  await main(process.argv.slice(2))
}

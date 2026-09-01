/**
 * The wrapper's first run, checked by running it.
 *
 * Everything here is a real child process: the decision this file exists for —
 * whether to offer to create the profile, and what to launch afterwards — is
 * made from `process.stdin.isTTY`, an exit status, and the presence of one
 * file, none of which a unit test can fake without also faking the thing under
 * test. So the wrapper is spawned, given a stub launcher that records what it
 * was asked to do, and pointed at a `DSH_HOME` in a temporary directory. The
 * user's own harness, profile, and global installs are never touched.
 *
 * The stub launcher stands in for `dsh` and imitates exactly the part of it
 * this wrapper depends on: `plugin ... add` initializes the profile by writing
 * its `package.json`, the way `dsh plugin` does on first use. It is a stub
 * rather than the real launcher because what is under test is which command
 * the wrapper runs and when — the real thing installing real packages is
 * proved separately by `tools/consumer-smoke.mjs --bootstrap`.
 *
 * The questions need a terminal on both ends, so those cases run the wrapper
 * under `script(1)`'s pseudo-terminal and skip themselves where that is not
 * available (Windows, or a machine without it). Everything that does not need
 * a terminal is checked everywhere, including the decision function itself.
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapPlan, quoteForCmd, saidYes, spawnPlan } from '../bin/dshline.mjs'

/** The executable under test, run as a real command line. */
const WRAPPER = fileURLToPath(new URL('../bin/dshline.mjs', import.meta.url))

/** The version the manifest declares, which `--version` must answer with. */
const VERSION = JSON.parse(
  await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version as string

/** Long enough for a Node child on a loaded CI runner, short enough to fail fast. */
const CHILD_TIMEOUT_MS = 30_000

/** What one stub-launcher invocation recorded about itself. */
interface Invocation {
  /** The arguments the wrapper passed, after the launcher's own prefix. */
  argv: string[]
  /** The folder the launcher ran in. */
  cwd: string
  /** The `DSH_HOME` it inherited, which decides which profile it would touch. */
  home: string | undefined
}

/** One finished wrapper run. */
interface Run {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  /**
   * Both streams together. A pseudo-terminal has one, so a message a piped run
   * finds on stderr arrives on stdout there; what is asserted is that the user
   * saw it.
   */
  output: string
  /** Everything the stub launcher was asked to do, in order. */
  calls: Invocation[]
}

/** A scratch installation: a stub launcher, a `DSH_HOME`, and a folder to run in. */
interface Fixture {
  root: string
  /** The stub launcher, as `$DSH_BIN` would name it. */
  dsh: string
  /**
   * The same stub behind an npm-style `dsh.cmd` batch shim, and the folder that
   * holds it so it can also be found on PATH. What npm actually installs on
   * Windows, and the only thing that can prove the hand-off to one.
   */
  shim: string
  shimDir: string
  home: string
  /** Where the profile would live, whether or not it exists. */
  profileDir: string
  /** The file whose presence means "the harness has initialized this profile". */
  manifest: string
  log: string
}

let fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.map(async dir => rm(dir, { recursive: true, force: true })))
  fixtures = []
})

/**
 * A stub launcher, a fresh harness home, and nothing else.
 *
 * The stub is a real executable with a shebang, because that is what the
 * wrapper spawns for `$DSH_BIN` and for a `dsh` on PATH; running it through
 * `node` instead would prove less about the hand-off.
 * @returns the fixture's paths.
 */
async function fixture(): Promise<Fixture> {
  // Through realpath, because the wrapper passes `process.cwd()` — which Node
  // reports resolved — and the system temp directory is a symlink on macOS.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dshline-bootstrap-')))
  fixtures.push(root)
  const home = join(root, 'dsh-home')
  await mkdir(home, { recursive: true })
  const dsh = join(root, 'dsh')
  await writeFile(dsh, STUB_LAUNCHER, 'utf8')
  await chmod(dsh, 0o755)
  // The shim and the module it calls are written everywhere and used on Windows:
  // an npm shim is a batch file that re-invokes its target with `%*`, which is
  // the second `cmd` parse the quoting has to survive.
  const recorder = join(root, 'stub.cjs')
  await writeFile(recorder, STUB_LAUNCHER, 'utf8')
  const shimDir = join(root, 'shim-bin')
  await mkdir(shimDir, { recursive: true })
  const shim = join(shimDir, 'dsh.cmd')
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`, 'utf8')
  return {
    root,
    // On Windows the stub IS the shim: `$DSH_BIN` there names what npm installs,
    // a batch file, so every process case below exercises that hand-off rather
    // than a shape Windows cannot run.
    dsh: process.platform === 'win32' ? shim : dsh,
    shim,
    shimDir,
    home,
    profileDir: join(home, 'profiles', 'dshline'),
    manifest: join(home, 'profiles', 'dshline', 'package.json'),
    log: join(root, 'calls.jsonl'),
  }
}

/**
 * The stub launcher's source.
 *
 * It answers as the harness answers for the two things the wrapper asks of it:
 * `plugin ... add` initializes the profile and then installs, and anything else
 * is a launch.
 *
 * The ORDER is the part that matters and is copied exactly from `dsh plugin`:
 * the profile manifest is written FIRST, before the install runs at all. So a
 * slow stub spends its delay with the manifest already on disk, which is the
 * real state a second launcher can observe — the state that makes "a manifest
 * appeared, so someone must have finished" false. A failing stub leaves the
 * same half-made profile a failed `dsh plugin` leaves behind.
 *
 * A launch waits for a keystroke when asked to, so a test can send `ctrl-c`
 * while the child owns the terminal; it ignores SIGINT for the same reason the
 * real frontend does. The knobs are environment variables, so one file covers a
 * failing install, a killed install, a slow one, and a session that stays open.
 */
const STUB_LAUNCHER = `#!/usr/bin/env node
// CommonJS on purpose: this file has no extension, because that is what an
// installed \`dsh\` looks like, and a file with no extension is CommonJS on
// every Node this package supports.
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
appendFileSync(process.env.STUB_LOG, JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  home: process.env.DSH_HOME,
}) + '\\n')

if (args[0] === 'plugin') {
  // Initialization first, exactly as dsh plugin does it: the manifest exists
  // from here on, while the install below has not run yet.
  if (process.env.STUB_SETUP_SKIP_INIT !== '1') {
    const dir = join(process.env.DSH_HOME, 'profiles', args[2])
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + args[2] }) + '\\n')
  }
  const finish = () => {
    process.stdout.write('stub: plugin done\\n')
    const signal = process.env.STUB_SETUP_SIGNAL ?? ''
    if (signal !== '') {
      process.kill(process.pid, signal)
      return
    }
    process.exit(Number(process.env.STUB_SETUP_CODE ?? '0'))
  }
  const delay = Number(process.env.STUB_SETUP_DELAY_MS ?? '0')
  if (delay > 0) setTimeout(finish, delay)
  else finish()
} else if (process.env.STUB_LAUNCH_HOLDS === '1') {
  // A frontend that owns the terminal: ctrl-c is its keystroke to interpret, so
  // it ignores the signal and leaves on its own key.
  process.on('SIGINT', () => process.stdout.write('stub: saw ctrl-c\\n'))
  process.stdout.write('stub: launched\\n')
  process.stdin.resume()
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('q')) process.exit(0)
  })
} else {
  process.stdout.write('stub: launched\\n')
}
`

/**
 * The environment one wrapper run gets.
 *
 * Built from nothing rather than from this process's, so a `dsh` on the
 * developer's own PATH cannot answer instead of the stub and the user's real
 * `~/.dsh` is unreachable. `PATH` still carries the Node that runs the stub's
 * shebang.
 * @param fix - the fixture whose paths this run uses.
 * @param overrides - values to add or remove (undefined removes).
 * @returns the environment for `spawn`.
 */
function environment(fix: Fixture, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  // What Windows cannot be denied: `cmd.exe` is named by `%ComSpec%` and lives
  // under `%SystemRoot%`, and a shim resolves nothing without `%PATHEXT%`. An
  // environment built from literally nothing made the wrapper report `could not
  // start` — a fact about this fixture, not about a Windows install.
  const system = process.platform === 'win32'
    ? Object.fromEntries(
      ['ComSpec', 'SystemRoot', 'windir', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
        .map(name => [name, process.env[name]]),
    )
    : {}
  const systemPath = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
    // The folders `script(1)` and `bash` live in, for the terminal cases.
    : ['/bin', '/usr/bin']
  const base: Record<string, string | undefined> = {
    ...system,
    // Node's own folder first, for the stub's shebang. Deliberately not the
    // developer's PATH: a real `dsh` there could answer instead of the stub.
    PATH: [join(process.execPath, '..'), ...systemPath].join(delimiter),
    DSH_BIN: fix.dsh,
    DSH_HOME: fix.home,
    STUB_LOG: fix.log,
    ...overrides,
  }
  return Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/**
 * Read what the stub launcher recorded.
 * @param log - the file it recorded into.
 * @returns every invocation, in order; empty when the launcher never ran.
 */
async function calls(log: string): Promise<Invocation[]> {
  if (!existsSync(log)) return []
  const raw = await readFile(log, 'utf8')
  return raw.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Invocation)
}

/**
 * Run the wrapper with no terminal on either end.
 * @param fix - the fixture.
 * @param args - the wrapper's arguments.
 * @param options - `env` overrides and the folder to run from.
 * @returns the finished run.
 */
async function runWrapper(
  fix: Fixture,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Run> {
  const log = options.log ?? fix.log
  const child = spawn(process.execPath, [WRAPPER, ...args], {
    env: environment(fix, { STUB_LOG: log, ...options.env ?? {} }),
    cwd: options.cwd ?? fix.root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Closed at once: a piped stdin that stays open is still not a terminal, and
  // this is the shape a script or a CI job has.
  child.stdin.end()
  return finish(child, log)
}

/** How to run the wrapper once. */
interface RunOptions {
  env?: Record<string, string | undefined>
  cwd?: string
  /**
   * Where the stub launcher records its invocations. Its own file per run
   * wherever two runs overlap, so one process's calls are never read as
   * another's.
   */
  log?: string
}

/**
 * Collect a child's output and exit, then read the launcher log.
 * @param child - the spawned wrapper.
 * @param log - the file the stub launcher recorded into.
 * @returns the finished run.
 */
function finish(child: ReturnType<typeof spawn>, log: string): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`the wrapper did not exit within ${String(CHILD_TIMEOUT_MS)}ms\n${stdout}\n${stderr}`))
    }, CHILD_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      void calls(log).then(recorded => resolvePromise({
        code,
        signal,
        stdout,
        stderr,
        output: `${stdout}${stderr}`,
        calls: recorded,
      }))
    })
  })
}

/**
 * Wait for something a child has already been asked to do.
 * @param ready - the condition to poll.
 * @returns nothing, once the condition holds.
 */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('the child never got that far')
    await new Promise(settle => setTimeout(settle, 20))
  }
}

/** The marker the confirmation ends with, matched with whitespace removed. */
const QUESTION = 'Set it up now?'

/** One thing to type once something has appeared on the terminal. */
interface Reply {
  /** Text to wait for, compared with all whitespace removed. */
  after: string
  /** What to send when it appears. */
  send: string
  /** Something to do before sending, for the races below. */
  before?: () => Promise<void>
}

/** `ctrl-c`, as the terminal delivers it. */
const CTRL_C = String.fromCharCode(3)

/**
 * Run the wrapper with a real pseudo-terminal on both ends.
 *
 * `script(1)` is the only pty this repository can use — no dependency provides
 * one, and the check is worthless without a real terminal, since that is the
 * fact the wrapper reads. The two invocations differ because the two
 * implementations do: util-linux takes the command as one string after `-qec`,
 * BSD's takes it as arguments and refuses a stdin that is not a pipe, which is
 * what the process substitution supplies (Node's own piped stdin is a socket).
 * @param fix - the fixture.
 * @param args - the wrapper's arguments.
 * @param replies - what to type, and what to wait for first.
 * @param options - `env` overrides and the folder to run from.
 * @returns the finished run.
 */
async function runOnTerminal(
  fix: Fixture,
  args: readonly string[],
  replies: readonly Reply[],
  options: RunOptions = {},
): Promise<Run> {
  const log = options.log ?? fix.log
  const inner = [process.execPath, WRAPPER, ...args].map(part => `'${part.replace(/'/gu, `'\\''`)}'`).join(' ')
  const line = process.platform === 'linux'
    ? `exec script -qec ${JSON.stringify(inner)} /dev/null`
    : `exec script -q /dev/null ${inner} < <(cat)`
  const child = spawn('bash', ['-c', line], {
    env: { ...environment(fix, { STUB_LOG: log, ...options.env ?? {} }), TERM: 'xterm-256color' },
    cwd: options.cwd ?? fix.root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let seen = ''
  let next = 0
  child.stdout?.on('data', chunk => {
    seen += String(chunk)
    const flat = seen.replace(/\s+/gu, '')
    const reply = replies[next]
    if (reply === undefined) return
    if (!flat.includes(reply.after.replace(/\s+/gu, ''))) return
    next += 1
    void (reply.before?.() ?? Promise.resolve()).then(() => child.stdin?.write(reply.send))
  })
  return finish(child, log)
}

/** Whether a pseudo-terminal is available here, probed once. */
let terminalAvailable: Promise<boolean> | undefined

/**
 * Whether the pty cases can run.
 *
 * Probed by running something through the same command line they use, rather
 * than inferred from the platform: a container without util-linux `script`
 * would otherwise fail every one of them for a reason that is not a bug.
 * @returns whether a pseudo-terminal was obtained.
 */
async function hasTerminal(): Promise<boolean> {
  terminalAvailable ??= (async () => {
    const probe = "process.stdout.write(process.stdin.isTTY === true && process.stdout.isTTY === true ? 'tty' : 'no')"
    const inner = [process.execPath, '-e', probe].map(part => `'${part.replace(/'/gu, `'\\''`)}'`).join(' ')
    const line = process.platform === 'linux'
      ? `exec script -qec ${JSON.stringify(inner)} /dev/null`
      : `exec script -q /dev/null ${inner} < <(cat)`
    return new Promise<boolean>(resolvePromise => {
      const child = spawn('bash', ['-c', line], { stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.on('error', () => resolvePromise(false))
      child.on('exit', () => resolvePromise(out.includes('tty')))
    })
  })()
  return terminalAvailable
}

/**
 * Skip one pty case where no pty exists, rather than failing it.
 * @param name - the case name.
 * @param body - the case, given a fresh fixture.
 */
function terminalCase(name: string, body: (fix: Fixture) => Promise<void>): void {
  it(name, async context => {
    if (!await hasTerminal()) {
      context.skip()
      return
    }
    await body(await fixture())
  }, CHILD_TIMEOUT_MS + 10_000)
}

/** Where `cmd.exe` lives, for a PATH a Windows case builds itself. */
function systemFolder(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
}

/** The arguments the wrapper adds for an ordinary launch from `cwd`. */
function launchArgs(cwd: string, rest: readonly string[] = []): string[] {
  return ['--profile', 'dshline', '--cwd', cwd, ...rest]
}

/** Mark a profile as initialized the way the harness would. */
async function initializeProfile(fix: Fixture): Promise<void> {
  await mkdir(fix.profileDir, { recursive: true })
  await writeFile(fix.manifest, `${JSON.stringify({ name: 'dsh-profile-dshline', dependencies: { '@dshline/dshline': '^0.1.0' } })}\n`, 'utf8')
}

describe('the bootstrap decision', () => {
  it('launches an initialized profile, whatever else is true', () => {
    expect(bootstrapPlan({ args: [], initialized: true, interactive: true })).toBe('launch')
    expect(bootstrapPlan({ args: [], initialized: true, interactive: false })).toBe('launch')
  })

  it('offers setup for an uninitialized profile with a terminal', () => {
    expect(bootstrapPlan({ args: [], initialized: false, interactive: true })).toBe('confirm')
  })

  it('refuses to install anything without a terminal to ask on', () => {
    // Not a silent install: the mutation reaches the network through pnpm, and
    // a scripted launch never agreed to one.
    expect(bootstrapPlan({ args: [], initialized: false, interactive: false })).toBe('no-terminal')
  })

  it('stands aside entirely when the caller chose a profile', () => {
    // Ownership, not string equality: `--profile dshline` is someone using
    // harness profile semantics directly, so the wrapper's own lifecycle
    // behaviour is off — including for the profile it would have picked.
    for (const args of [['--profile', 'other'], ['--profile=other'], ['--profile', 'dshline'], ['--profile=dshline']]) {
      expect(bootstrapPlan({ args, initialized: false, interactive: true }), args.join(' ')).toBe('launch')
      expect(bootstrapPlan({ args, initialized: false, interactive: false }), args.join(' ')).toBe('launch')
    }
  })

  it('reads a profile choice wherever it appears, including after a task', () => {
    expect(bootstrapPlan({ args: ['run the tests', '--profile', 'other'], initialized: false, interactive: false })).toBe('launch')
  })
})

describe('the answer to a default-yes question', () => {
  it('takes enter, y, and yes', () => {
    for (const answer of ['', ' ', 'y', 'Y', ' y ', 'yes', 'YES']) expect(saidYes(answer), answer).toBe(true)
  })

  it('takes anything else as no, cancellation included', () => {
    for (const answer of ['n', 'N', 'no', 'nope', 'later', 'q']) expect(saidYes(answer), answer).toBe(false)
    expect(saidYes(undefined)).toBe(false)
  })
})

describe('spawning the launcher', () => {
  const launcher = { command: '/usr/local/bin/dsh', prefix: [], describe: 'test' }

  it('passes argv through unchanged where no shell is involved', () => {
    const plan = spawnPlan(launcher, ['--profile', 'dshline', 'run the tests'], 'linux')
    expect(plan).toEqual({
      command: '/usr/local/bin/dsh',
      argv: ['--profile', 'dshline', 'run the tests'],
      verbatim: false,
    })
  })

  it('keeps a source checkout\'s own prefix in front of the arguments', () => {
    const checkout = { command: 'node', prefix: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'], describe: 'test' }
    expect(spawnPlan(checkout, ['plugin'], 'linux').argv).toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'plugin'])
  })

  it('runs a Windows npm shim through cmd.exe, because a batch file is not an executable', () => {
    // What npm installs on Windows is `dsh.cmd`; spawn has refused to run one
    // directly since the CVE-2024-27980 hardening, so this one case needs the
    // interpreter that can — and Node must not requote what is already quoted.
    const plan = spawnPlan({ command: 'C:\\npm\\dsh.cmd', prefix: [], describe: 'test' }, ['--profile', 'dshline'], 'win32')
    expect(plan.command.toLowerCase()).toContain('cmd')
    expect(plan.argv.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(plan.verbatim).toBe(true)
    expect(plan.argv[3]).toContain('dsh.cmd')
  })

  it('leaves a real Windows executable alone', () => {
    const plan = spawnPlan({ command: 'C:\\node\\node.exe', prefix: ['cli.js'], describe: 'test' }, ['x'], 'win32')
    expect(plan).toEqual({ command: 'C:\\node\\node.exe', argv: ['cli.js', 'x'], verbatim: false })
  })

  it('keeps one argument one argument, however it is spelled', () => {
    // Arguments stay argv, never shell syntax: a first task is one word to the
    // launcher whether it contains spaces, quotes, or characters cmd would
    // otherwise read as its own. What that quoting actually delivers is proved
    // on Windows itself, by the job that records the argv a shim received.
    const plan = spawnPlan({ command: 'dsh.cmd', prefix: [], describe: 'test' }, ['run the "tests" & stop'], 'win32')
    const line = plan.argv[3] ?? ''
    expect(line).toContain(quoteForCmd('run the "tests" & stop'))
    // Escaped twice, because a shim is a batch file that re-invokes its target
    // with `%*` and the same line is parsed by cmd a second time.
    expect(quoteForCmd('a & b')).toBe('^^^"a^^^ ^^^&^^^ b^^^"')
    expect(quoteForCmd('a & b', false)).toBe('^"a^ ^&^ b^"')
    // One `cmd` parse only, for comparison with the double-escaped form above.
    expect(quoteForCmd('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"')
    // The whole command line is wrapped for `/s`, which strips exactly those
    // outer quotes and takes the rest verbatim.
    expect(line.startsWith('"')).toBe(true)
    expect(line.endsWith('"')).toBe(true)
  })

  it('doubles every backslash before a quote, not just the last one', () => {
    // The shape the Windows job caught: with an even run of backslashes reaching
    // the program, `CommandLineToArgvW` reads the quote as a quote and drops it,
    // so `a\\"b` arrived as `a\\b`. Pinned here as well so the regression is
    // visible on any platform, in one line rather than a whole Windows run.
    const doubled = quoteForCmd(`a${'\\'.repeat(2)}"b`, false)
    expect(doubled).toBe(`^"a${'\\'.repeat(5)}^"b^"`)
    // Odd runs stay odd, which is what makes the quote literal.
    expect(quoteForCmd('a\\"b', false)).toBe(`^"a${'\\'.repeat(3)}^"b^"`)
  })

  it('refuses a line break through a shim rather than letting cmd read it as syntax', () => {
    // A cmd command line has no representation for a newline inside an
    // argument: the character ends the command. Refusing is the one honest
    // answer; every other platform, and a real executable on Windows, take the
    // argument as it is.
    const shim = { command: 'C:\\npm\\dsh.cmd', prefix: [], describe: 'test' }
    expect(spawnPlan(shim, ['first\nsecond'], 'win32').refuse).toContain('line break')
    expect(spawnPlan(shim, ['first\rsecond'], 'win32').refuse).toContain('line break')
    expect(spawnPlan({ command: 'dsh.exe', prefix: [], describe: 'test' }, ['first\nsecond'], 'win32').refuse).toBeUndefined()
    expect(spawnPlan({ command: 'dsh', prefix: [], describe: 'test' }, ['first\nsecond'], 'linux')).toEqual({
      command: 'dsh',
      argv: ['first\nsecond'],
      verbatim: false,
    })
  })
})

describe('an initialized profile', () => {
  it('launches, adding the profile and the folder and nothing else', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
  })

  it('keeps a first task, a resume, and a folder exactly as given', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    for (const rest of [
      ['run the tests'],
      ['--resume'],
      ['--resume', 'abc123'],
      ['--resume', 'abc123', 'and then stop'],
    ]) {
      await rm(fix.log, { force: true })
      const run = await runWrapper(fix, rest, { cwd: fix.root })
      expect(run.code, rest.join(' ')).toBe(0)
      expect(run.calls[0]?.argv, rest.join(' ')).toEqual(launchArgs(fix.root, rest))
    }
  })

  it('leaves an explicit folder alone rather than adding its own', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    for (const rest of [['-C', '/tmp'], ['--cwd', '/tmp'], ['--cwd=/tmp']]) {
      await rm(fix.log, { force: true })
      const run = await runWrapper(fix, rest, { cwd: fix.root })
      expect(run.calls[0]?.argv, rest.join(' ')).toEqual(['--profile', 'dshline', ...rest])
    }
  })

  it('is never repaired, however broken it is', async () => {
    // The manifest exists, so the profile exists. No dependency on this
    // package, no node_modules, nothing installed — and still no hidden
    // `plugin add`: the harness's loader is what diagnoses that, and a
    // reinstall here would hide the diagnosis behind a package operation.
    const fix = await fixture()
    await mkdir(fix.profileDir, { recursive: true })
    await writeFile(fix.manifest, `${JSON.stringify({ name: 'dsh-profile-dshline', dependencies: {} })}\n`, 'utf8')
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.calls.map(call => call.argv[0])).toEqual(['--profile'])
    expect(run.calls.some(call => call.argv.includes('plugin'))).toBe(false)
  })
})

describe('an uninitialized profile, with nobody to ask', () => {
  it('says how to set it up and mutates nothing', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('dshline --setup')
    expect(run.calls).toEqual([])
    expect(existsSync(fix.profileDir)).toBe(false)
  })

  it('counts a directory with no manifest as uninitialized', async () => {
    // The state an interrupted first install leaves behind. `dsh plugin`
    // decides the same way, so a wrapper that asked whether the folder existed
    // would refuse setup for a profile the harness considers uninitialized.
    const fix = await fixture()
    await mkdir(fix.profileDir, { recursive: true })
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('is not set up')
  })

  it('still launches when the caller chose a profile explicitly', async () => {
    // The old wrapper checked its own profile whatever was asked for, so
    // `dshline --profile other` refused to start on a machine that had never
    // used the dshline profile.
    const fix = await fixture()
    for (const chosen of [['--profile', 'other'], ['--profile=other'], ['--profile', 'dshline'], ['--profile=dshline']]) {
      await rm(fix.log, { force: true })
      const run = await runWrapper(fix, chosen, { cwd: fix.root })
      expect(run.code, chosen.join(' ')).toBe(0)
      expect(run.calls, chosen.join(' ')).toHaveLength(1)
      expect(run.calls[0]?.argv, chosen.join(' ')).toEqual(['--cwd', fix.root, ...chosen])
      expect(existsSync(fix.profileDir), chosen.join(' ')).toBe(false)
    }
  })
})

describe('the explicit --setup', () => {
  it('installs and stops there, with no terminal needed', async () => {
    // The user named the mutation, which is what makes this the scriptable
    // path and the answer to a first run that went wrong.
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]?.argv).toEqual(['plugin', '--profile', 'dshline', 'add', '@dshline/dshline'])
    expect(existsSync(fix.manifest)).toBe(true)
  })

  it('passes a source through, so a checkout can be installed instead', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup', './packages/dshline'], { cwd: fix.root })
    expect(run.calls[0]?.argv).toEqual(['plugin', '--profile', 'dshline', 'add', './packages/dshline'])
  })

  it('leaves with the launcher\'s own status when the install fails', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { env: { STUB_SETUP_CODE: '7' } })
    expect(run.code).toBe(7)
  })

  // POSIX only: Node simulates every signal on Windows as an abrupt
  // termination, so there is no signalled child there to report.
  it.skipIf(process.platform === 'win32')('dies of the signal that killed the install, rather than reporting success', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { env: { STUB_SETUP_SIGNAL: 'SIGTERM' } })
    expect(run.signal).toBe('SIGTERM')
    expect(run.code).toBeNull()
  })
})

describe('however the command was reached', () => {
  // POSIX only: creating a symlink on Windows needs a privilege CI does not
  // grant, and what npm puts on the PATH there is the `.cmd` shim the Windows
  // block below covers.
  it.skipIf(process.platform === 'win32')('runs when it was reached through a symlink, which is how npm installs it', async () => {
    // The failure this exists for: `argv[1]` is the link on the PATH while
    // `import.meta.url` names the file it points at, so a wrapper that compared
    // the two as strings did nothing at all and exited zero — invisible in a
    // checkout, where no link is involved, and total in every global install.
    const fix = await fixture()
    await initializeProfile(fix)
    const link = join(fix.root, 'dshline-link')
    await symlink(WRAPPER, link)
    const child = spawn(process.execPath, [link], {
      env: environment(fix),
      cwd: fix.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end()
    const run = await finish(child, fix.log)
    expect(run.code).toBe(0)
    expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
  })
})

describe('--version', () => {
  it('answers with no harness, no profile, and no terminal', async () => {
    // What a bug report asks for, on a machine where the rest of the setup is
    // what is broken.
    const fix = await fixture()
    for (const flag of ['--version', '-V']) {
      const run = await runWrapper(fix, [flag], { env: { DSH_BIN: undefined, PATH: '' } })
      expect(run.code, flag).toBe(0)
      expect(run.stdout.trim(), flag).toBe(VERSION)
      expect(run.calls, flag).toEqual([])
    }
    expect(existsSync(fix.profileDir)).toBe(false)
  })
})

describe('finding the launcher', () => {
  it('prefers an explicit DSH_BIN to a dsh on PATH', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const other = join(fix.root, 'path-bin')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'dsh'), '#!/bin/sh\nexit 3\n', 'utf8')
    await chmod(join(other, 'dsh'), 0o755)
    const run = await runWrapper(fix, [], { env: { PATH: `${other}:${join(process.execPath, '..')}` } })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(1)
  })

  it('runs a DSH_HARNESS checkout\'s own script, from the checkout', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const checkout = join(fix.root, 'harness')
    await mkdir(checkout, { recursive: true })
    await writeFile(join(checkout, 'launch.cjs'), STUB_LAUNCHER, 'utf8')
    await writeFile(
      join(checkout, 'package.json'),
      `${JSON.stringify({ name: 'harness', scripts: { dsh: `${process.execPath} launch.cjs` } })}\n`,
      'utf8',
    )
    const run = await runWrapper(fix, [], { env: { DSH_BIN: undefined, DSH_HARNESS: checkout }, cwd: fix.root })
    expect(run.code).toBe(0)
    // The checkout is the child's folder, which is why the session's own folder
    // travels as an argument instead.
    expect(run.calls[0]?.cwd).toBe(checkout)
    expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
  })

  it('says what to install when there is no launcher at all', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const run = await runWrapper(fix, [], { env: { DSH_BIN: undefined, PATH: '' } })
    expect(run.code).toBe(127)
    expect(run.stderr).toContain('@deepseek-ai/dsh')
  })
})

describe('the first run, on a terminal', () => {
  terminalCase('asks once, sets up, and continues into the launch', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.output).toContain('first run')
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([
      ['plugin', '--profile', 'dshline', 'add', '@dshline/dshline'],
      launchArgs(fix.root),
    ])
  })

  terminalCase('takes enter as yes', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: '\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(2)
  })

  terminalCase('sets up a directory that exists but was never initialized', async fix => {
    await mkdir(fix.profileDir, { recursive: true })
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls[0]?.argv[0]).toBe('plugin')
  })

  terminalCase('carries the original invocation through the setup, unchanged', async fix => {
    const args = ['--resume', 'abc123', 'run the tests']
    const run = await runOnTerminal(fix, args, [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls[1]?.argv).toEqual(launchArgs(fix.root, args))
  })

  terminalCase('respects an explicit folder through the setup too', async fix => {
    const elsewhere = join(fix.root, 'project')
    await mkdir(elsewhere, { recursive: true })
    const run = await runOnTerminal(fix, ['-C', elsewhere], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.calls[1]?.argv).toEqual(['--profile', 'dshline', '-C', elsewhere])
  })

  terminalCase('installs and launches inside the DSH_HOME it was given', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.calls.map(call => call.home)).toEqual([fix.home, fix.home])
    expect(existsSync(fix.manifest)).toBe(true)
  })

  terminalCase('installs nothing when the answer is no, and starts nothing either', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'n\n' }], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.calls).toEqual([])
    expect(existsSync(fix.profileDir)).toBe(false)
    expect(run.stdout).toContain('dshline --setup')
  })

  terminalCase('cancels on ctrl-c without starting the install', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: CTRL_C }], { cwd: fix.root })
    // 130 is what a shell reports for a process ended by SIGINT, which is what
    // the keystroke meant.
    expect(run.code).toBe(130)
    expect(run.calls).toEqual([])
  })

  terminalCase('does not launch after a failed install', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
      cwd: fix.root,
      env: { STUB_SETUP_CODE: '9', STUB_SETUP_SKIP_INIT: '1' },
    })
    expect(run.code).toBe(9)
    expect(run.calls).toHaveLength(1)
    expect(run.output).toContain('setup did not finish')
  })

  terminalCase('does not launch after an install that was killed', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
      cwd: fix.root,
      env: { STUB_SETUP_SIGNAL: 'SIGTERM', STUB_SETUP_SKIP_INIT: '1' },
    })
    expect(run.calls).toHaveLength(1)
    expect(run.code).not.toBe(0)
  })
})

describe('two first launches at once', () => {
  terminalCase('runs the setup it was given permission to run, manifest or no manifest', async fix => {
    // A manifest that appeared while the question was on screen proves that a
    // setup STARTED — `dsh plugin` writes it before installing anything — never
    // that one finished. Skipping the install on it would launch the frontend
    // into a profile still being installed, and telling the difference means
    // reading dependencies, node_modules, or bundle state: profile health, which
    // is the harness's judgement and not this wrapper's.
    const run = await runOnTerminal(fix, [], [{
      after: QUESTION,
      before: () => initializeProfile(fix),
      send: 'y\n',
    }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([
      ['plugin', '--profile', 'dshline', 'add', '@dshline/dshline'],
      launchArgs(fix.root),
    ])
  })

  terminalCase('does not launch when the manifest exists but the install then fails', async fix => {
    // The real ordering, modelled: manifest written, install still running,
    // install fails later. A wrapper that read the manifest as "done" would
    // start the frontend against a half-installed profile — so this case must
    // fail if that short-circuit ever comes back.
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
      cwd: fix.root,
      env: { STUB_SETUP_DELAY_MS: '300', STUB_SETUP_CODE: '9' },
    })
    expect(existsSync(fix.manifest)).toBe(true)
    expect(run.code).toBe(9)
    expect(run.calls.map(call => call.argv[0])).toEqual(['plugin'])
  })

  terminalCase('lets both confirmed launches delegate, and neither launch on a failed setup', async fix => {
    // Two overlapping first runs are the harness's own concurrent-mutation
    // question; dshline's part is that each invocation runs the command it was
    // authorized to run and launches only after its own setup succeeded.
    const both = await Promise.all([
      runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
        cwd: fix.root,
        log: join(fix.root, 'first.jsonl'),
        env: { STUB_SETUP_DELAY_MS: '300' },
      }),
      runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
        cwd: fix.root,
        log: join(fix.root, 'second.jsonl'),
        env: { STUB_SETUP_DELAY_MS: '300' },
      }),
    ])
    expect(existsSync(fix.manifest)).toBe(true)
    for (const run of both) {
      const installed = run.calls.filter(call => call.argv[0] === 'plugin')
      const launched = run.calls.filter(call => call.argv[0] === '--profile')
      expect(installed).toHaveLength(1)
      expect(launched).toHaveLength(run.code === 0 ? 1 : 0)
    }
  })
})

describe('while the frontend owns the terminal', () => {
  // POSIX only, and not a gap in the Windows story: `ctrl-c` there is a console
  // event rather than a deliverable signal, and Node's `kill('SIGINT')` on
  // Windows terminates the target outright — there is no "ignored" to observe.
  it.skipIf(process.platform === 'win32')('ignores SIGINT and leaves with the child\'s own status', async () => {
    // The property that predates this change and has to survive it: once the
    // frontend has the terminal, `ctrl-c` is a keystroke it interprets, and a
    // wrapper that died on the signal would tear the session down mid-turn.
    // Signalled directly rather than through a terminal, because that isolates
    // the wrapper: a pty delivers the signal to every process in the foreground
    // group, including `script(1)`'s own shell, whose death would then be
    // reported as this run's exit status and prove nothing about dshline.
    const fix = await fixture()
    await initializeProfile(fix)
    const child = spawn(process.execPath, [WRAPPER], {
      env: environment(fix, { STUB_LAUNCH_HOLDS: '1' }),
      cwd: fix.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let seen = ''
    child.stdout?.on('data', chunk => { seen += String(chunk) })
    const finished = finish(child, fix.log)
    await waitFor(() => seen.includes('stub: launched'))
    child.kill('SIGINT')
    // Not a race with the signal: the wrapper is single-threaded, and had it
    // died the write below would reach a closed stdin and the run would end
    // with a signal instead of the child's status.
    child.stdin?.write('q\n')
    const run = await finished
    expect(run.signal).toBeNull()
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv[0])).toEqual(['--profile'])
  }, CHILD_TIMEOUT_MS + 10_000)

  terminalCase('passes ctrl-c through to the child on a real terminal', async fix => {
    // The keystroke half of the same property, on a pty. Only the output is
    // asserted: this run's exit status belongs to `script(1)`, which shares the
    // foreground group and dies of the signal itself.
    await initializeProfile(fix)
    const run = await runOnTerminal(fix, [], [
      { after: 'stub: launched', send: CTRL_C },
      { after: 'stub: saw ctrl-c', send: 'q\n' },
    ], { cwd: fix.root, env: { STUB_LAUNCH_HOLDS: '1' } })
    expect(run.output).toContain('stub: saw ctrl-c')
    expect(run.calls.map(call => call.argv[0])).toEqual(['--profile'])
  })
})

describe('a Windows npm install', () => {
  // Real where it matters and skipped everywhere else: an npm `.cmd` shim is a
  // batch file, so only Windows can run one, and only running one can prove what
  // arrives on the other side. `.github/workflows/ci.yml` runs exactly this
  // block on windows-latest; the `spawnPlan` cases above check the command line
  // it builds on every platform, which is not the same evidence.
  const windows = process.platform === 'win32' ? describe : describe.skip

  windows('through the shim', () => {
    it('reaches it for --setup', async () => {
      const fix = await fixture()
      const run = await runWrapper(fix, ['--setup'], { env: { DSH_BIN: fix.shim } })
      expect(run.code).toBe(0)
      expect(run.calls[0]?.argv).toEqual(['plugin', '--profile', 'dshline', 'add', '@dshline/dshline'])
      expect(existsSync(fix.manifest)).toBe(true)
    }, CHILD_TIMEOUT_MS + 10_000)

    it('reaches it for an ordinary launch found on PATH', async () => {
      // PATH discovery is half the fix: what npm puts on PATH is `dsh.cmd`, and
      // spawning the bare name `dsh` there finds no file at all.
      const fix = await fixture()
      await initializeProfile(fix)
      const run = await runWrapper(fix, [], {
        env: { DSH_BIN: undefined, PATH: [fix.shimDir, join(process.execPath, '..'), systemFolder()].join(delimiter) },
        cwd: fix.root,
      })
      expect(run.code).toBe(0)
      expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
    }, CHILD_TIMEOUT_MS + 10_000)

    it('reaches it for a first run, then launches', async () => {
      const fix = await fixture()
      const setup = await runWrapper(fix, ['--setup'], {
        env: { DSH_BIN: undefined, PATH: [fix.shimDir, join(process.execPath, '..'), systemFolder()].join(delimiter) },
      })
      expect(setup.code).toBe(0)
      await rm(fix.log, { force: true })
      const launch = await runWrapper(fix, [], {
        env: { DSH_BIN: undefined, PATH: [fix.shimDir, join(process.execPath, '..'), systemFolder()].join(delimiter) },
        cwd: fix.root,
      })
      expect(launch.calls[0]?.argv).toEqual(launchArgs(fix.root))
    }, CHILD_TIMEOUT_MS + 10_000)

    // One argument in, one argument out, byte for byte — recorded from the argv
    // the shim's target actually received, never from the command line this
    // process built. Each of these is a character `cmd` would otherwise act on.
    const tasks = [
      ['spaces', 'run the tests'],
      ['double quotes', 'say "hi" now'],
      ['an ampersand', 'a & b'],
      ['a pipe', 'a | b'],
      ['a caret', 'a ^ b'],
      ['percent signs', 'a %PATH% b'],
      ['an exclamation mark', 'a ! b'],
      ['parentheses', 'a (b) c'],
      ['a semicolon and a comma', 'a ; b , c'],
      ['a redirect pair', 'a > b < c'],
      ['a backtick and a star', 'a `b` *c*'],
      ['a trailing backslash', 'C:\\some\\path\\'],
      ['a trailing quote', 'unbalanced "'],
      ['doubled backslashes before a quote', 'a\\\\"b'],
      ['every one of them at once', 'x &|^%!()<>;,`* "q" \\'],
    ] as const

    for (const [name, task] of tasks) {
      it(`keeps a task with ${name} as one argument`, async () => {
        const fix = await fixture()
        await initializeProfile(fix)
        const run = await runWrapper(fix, [task], { env: { DSH_BIN: fix.shim }, cwd: fix.root })
        expect(run.code).toBe(0)
        expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root, [task]))
      }, CHILD_TIMEOUT_MS + 10_000)
    }

    it('refuses a line break instead of handing cmd a second command', async () => {
      // The one case with no faithful representation on a cmd command line: a
      // newline ends the command rather than sitting inside an argument.
      const fix = await fixture()
      await initializeProfile(fix)
      for (const task of ['first\nsecond', 'first\r\nsecond']) {
        await rm(fix.log, { force: true })
        const run = await runWrapper(fix, [task], { env: { DSH_BIN: fix.shim }, cwd: fix.root })
        expect(run.code, JSON.stringify(task)).toBe(1)
        expect(run.stderr, JSON.stringify(task)).toContain('line break')
        expect(run.calls, JSON.stringify(task)).toEqual([])
      }
    }, CHILD_TIMEOUT_MS + 10_000)
  })
})

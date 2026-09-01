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
  return {
    root,
    dsh,
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
 * `plugin ... add` initializes the profile — writing `package.json` first, the
 * same order `dsh plugin` uses, so a stub that then fails leaves the same
 * half-made state a real failed install does — and anything else is a launch.
 * The knobs are environment variables so one file covers a failing install, a
 * killed install, and a slow one.
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
  const delay = Number(process.env.STUB_SETUP_DELAY_MS ?? '0')
  const finish = () => {
    if (process.env.STUB_SETUP_SKIP_INIT !== '1') {
      const dir = join(process.env.DSH_HOME, 'profiles', args[2])
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + args[2] }) + '\\n')
    }
    process.stdout.write('stub: plugin done\\n')
    const signal = process.env.STUB_SETUP_SIGNAL ?? ''
    if (signal !== '') {
      process.kill(process.pid, signal)
      return
    }
    process.exit(Number(process.env.STUB_SETUP_CODE ?? '0'))
  }
  if (delay > 0) setTimeout(finish, delay)
  else finish()
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
  const base: Record<string, string | undefined> = {
    // Node's own folder for the stub's shebang, and the system folders for the
    // `script(1)` and `bash` the terminal cases run through. Deliberately not
    // the developer's PATH: a real `dsh` there could answer instead of the stub.
    PATH: [join(process.execPath, '..'), '/bin', '/usr/bin'].join(delimiter),
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
    // otherwise read as its own.
    const plan = spawnPlan({ command: 'dsh.cmd', prefix: [], describe: 'test' }, ['run the "tests" & stop'], 'win32')
    const line = plan.argv[3] ?? ''
    expect(line).toContain(quoteForCmd('run the "tests" & stop'))
    // Every character cmd could act on is escaped for it, and the whole
    // argument is one quoted token for the parser after it.
    expect(quoteForCmd('a & b')).toBe('^"a ^& b^"')
    expect(quoteForCmd('say "hi"')).toBe('^"say \\^"hi\\^"^"')
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

  it('dies of the signal that killed the install, rather than reporting success', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { env: { STUB_SETUP_SIGNAL: 'SIGTERM' } })
    expect(run.signal).toBe('SIGTERM')
    expect(run.code).toBeNull()
  })
})

describe('however the command was reached', () => {
  it('runs when it was reached through a symlink, which is how npm installs it', async () => {
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
  terminalCase('installs nothing when another launcher finished while the question waited', async fix => {
    // The window this closes: the question can be on screen for as long as the
    // user takes to read it, and a second terminal — or a script — can finish
    // the same setup in that time. Installing again would be a package
    // operation nobody has asked for since.
    const run = await runOnTerminal(fix, [], [{
      after: QUESTION,
      before: () => initializeProfile(fix),
      send: 'y\n',
    }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([launchArgs(fix.root)])
  })

  terminalCase('leaves an initialized profile behind when both say yes', async fix => {
    // What the harness does with two simultaneous `dsh plugin` mutations is the
    // harness's own business — see the finding recorded in docs/architecture.md
    // — so what is asserted here is dshline's part: neither launcher launches
    // without a setup that succeeded, and the profile ends up initialized.
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
      const launched = run.calls.filter(call => call.argv[0] === '--profile')
      const installed = run.calls.filter(call => call.argv[0] === 'plugin')
      expect(launched.length).toBeLessThanOrEqual(1)
      if (run.code === 0) expect(launched).toHaveLength(1)
      // Nothing launches without a setup this process either ran or found done.
      if (launched.length === 1) expect(installed.length).toBeLessThanOrEqual(1)
    }
  })
})

describe('a Windows npm install', () => {
  // Skipped everywhere else, and real where it matters: the shim is a batch
  // file, so only Windows can run one and only Windows can prove the wrapper's
  // hand-off to it. The argv this produces is checked on every platform by the
  // `spawnPlan` cases above.
  const windows = process.platform === 'win32' ? it : it.skip
  windows('sets up and launches through a dsh.cmd shim', async () => {
    const fix = await fixture()
    const shim = join(fix.root, 'dsh.cmd')
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${join(fix.root, 'dsh')}" %*\r\n`, 'utf8')
    const setup = await runWrapper(fix, ['--setup'], { env: { DSH_BIN: shim } })
    expect(setup.code).toBe(0)
    expect(setup.calls[0]?.argv).toEqual(['plugin', '--profile', 'dshline', 'add', '@dshline/dshline'])
    await rm(fix.log, { force: true })
    const launch = await runWrapper(fix, ['run the tests'], { env: { DSH_BIN: shim }, cwd: fix.root })
    expect(launch.code).toBe(0)
    expect(launch.calls[0]?.argv).toEqual(launchArgs(fix.root, ['run the tests']))
  }, CHILD_TIMEOUT_MS + 10_000)
})

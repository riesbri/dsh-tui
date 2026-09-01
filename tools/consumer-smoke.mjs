/**
 * Prove, end to end, what a consumer experiences today.
 *
 * The type-level jobs answer whether this bundle compiles against Harness; a
 * plugin also has to install into a real profile beside the real launcher and
 * draw on a real terminal. That path crosses three tools this repository does
 * not control — pnpm's installer, the harness's profile loader, the terminal
 * handshake — where only an actual run is evidence. The audit that produced
 * this workflow ran those steps by hand; this script is that run, committed.
 *
 * The sequence mirrors docs/install.md exactly: install the published
 * `@deepseek-ai/dsh` launcher, pack this bundle, add it to a fresh profile,
 * boot it under a pseudo-terminal, confirm the startup banner reached the
 * screen, and leave with ctrl-d. Everything runs inside a temporary directory;
 * nothing here reads or writes user state, and no model is configured, so the
 * launch session browser is as far as it gets — which is the point being
 * tested.
 *
 * `--bootstrap` proves the other advertised sequence, the one a new user
 * actually types: install both packages, run `dshline`, answer the first-run
 * question, end up in a session. The two modes answer two different questions
 * and are kept apart on purpose:
 *
 * - the default mode asks whether the plugin code IN THIS COMMIT installs and
 *   boots against this Harness line, so it installs the packed tarball (and
 *   substitutes a packed renderer when the registry cannot serve one yet);
 * - `--bootstrap` asks whether THIS COMMIT'S WRAPPER implements the user
 *   lifecycle, so it runs the packed executable against a genuinely empty
 *   `DSH_HOME` and lets the first run install `@dshline/dshline` by name from
 *   the registry — the package a real first run gets. Nothing here touches the
 *   profile before or after; the harness creates all of it.
 *
 * Requires a `script(1)` for the pseudo-terminal — util-linux's on Linux, BSD's
 * on macOS, which take their command differently — and skips itself where there
 * is none rather than failing; the daily job runs on Linux, where the check is
 * real. Set CONSUMER_SMOKE_STORE_DIR to point pnpm at a writable
 * content-addressable store on machines whose default store location is
 * restricted; unset in CI, where the default is fine.
 *
 * @module tools/consumer-smoke
 */

import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_DIR = join(repoRoot, 'packages', 'dshline')
const RENDERER_DIR = join(repoRoot, 'packages', 'renderer')
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'
const REGISTRY_HOST = 'https://registry.npmjs.org'
const PLUGIN_PACKAGE_NAME = '@dshline/dshline'
const RENDERER_PACKAGE_NAME = '@dshline/renderer'
const PROFILE_NAME = 'dshline'

/** How long the boot may take to show its banner before this is a failure. */
export const BOOT_TIMEOUT_MS = 60_000

/** How long a graceful ctrl-d exit may take before the process is killed. */
const QUIT_TIMEOUT_MS = 30_000

/**
 * How long the first-run install may take before the boot timeout gives up.
 * A profile install downloads the harness's whole plugin set through pnpm, so
 * this is the network's budget, not the interface's.
 */
const BOOTSTRAP_TIMEOUT_MS = 600_000

/** The end of the wrapper's first-run question, matched whitespace-free. */
const QUESTION_MARKER = 'set it up now?'


/**
 * Decide whether a captured terminal stream shows a healthy startup.
 *
 * The renderer updates the screen by moving the cursor, so the stream splits
 * words across writes and rows; matching happens on a whitespace-free,
 * escape-free flattening of everything received, which is why a frame with the
 * right characters in the wrong order cannot pass by accident.
 * @param raw - everything the pseudo-terminal produced so far.
 * @param version - the bundle version the banner is expected to print.
 * @returns which pieces of startup evidence are present.
 */
export function parseBootEvidence(raw, version) {
  const flat = flatten(raw)
  return {
    // A missing or empty version must disable banner matching rather than
    // match everything: String.prototype.includes('') is always true.
    sawBanner: Boolean(version) && flat.includes('dshline') && flat.includes(version.toLowerCase()),
    sawReady: flat.includes('ready'),
  }
}

/**
 * Flatten captured terminal output for matching.
 *
 * Escape sequences removed, case folded, whitespace dropped: the renderer moves
 * the cursor to draw, so a word arrives split across writes and rows, and a
 * frame with the right characters in the wrong order still cannot pass.
 * @param raw - everything the pseudo-terminal produced so far.
 * @returns the flattened form.
 */
function flatten(raw) {
  return raw
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]|\u001b\][^\u0007]*\u0007/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, '')
}

/**
 * Run a command, capturing failure as a thrown error that names what ran.
 * @param command - the executable.
 * @param args - its arguments.
 * @param options - spawn options; `cwd` and `env` matter here.
 * @param description - the phrase used when reporting a non-zero exit.
 * @returns stdout plus stderr of the finished command.
 */
async function run(command, args, options, description) {
  try {
    return await execFileAsync(command, args, { timeout: 600_000, ...options })
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].find(text => text !== undefined && text !== '') ?? ''
    throw new Error(`${description} failed (${command} ${args.join(' ')}):\n${String(detail).slice(-2000)}`)
  }
}

/**
 * Extra arguments every pnpm invocation needs on restricted machines.
 * @returns the flag list from CONSUMER_SMOKE_STORE_DIR, or empty.
 */
function storeArgs() {
  const configured = (process.env.CONSUMER_SMOKE_STORE_DIR ?? '').trim()
  return configured === '' ? [] : ['--store-dir', configured]
}

/**
 * The version a consumer on the given channel would install today.
 *
 * An ordinary consumer follows the `latest` tag
 * (`npm install -g @deepseek-ai/dsh`); the Alpha compatibility lane instead
 * follows `alpha`, so a boot happens under the same launcher line its other
 * checks are pinned against, not the stable line while everything else under
 * test is a prerelease. The bootstrap mode below asks the same question about
 * the published plugin, because that is the package a first run installs by
 * name.
 * @param packageName - the package to look up.
 * @param tag - the npm dist-tag, `latest` by default.
 * @returns the exact version string.
 */
async function publishedVersion(packageName, tag = 'latest') {
  const response = await fetch(`${REGISTRY_HOST}/${encodeURIComponent(packageName)}`)
  if (!response.ok) throw new Error(`registry returned ${String(response.status)} for ${packageName}`)
  const packument = await response.json()
  const version = packument['dist-tags']?.[tag]
  if (version === undefined) throw new Error(`${packageName} has no ${tag} dist-tag on the registry`)
  return version
}

/**
 * Pack one workspace package into a directory of its own.
 * Packing runs the prepare script (tsc -b), so lib/ exists even in a fresh
 * checkout — the same reason a consumer installing from npm gets working code.
 * Each tarball gets its own directory so the one produced here is identified by
 * where it landed rather than by guessing among several.
 * @param packageDir - the workspace package to pack.
 * @param destination - the directory receiving this tarball.
 * @param description - what to call this step when it fails.
 * @returns the absolute path of the packed tarball.
 */
async function packPackage(packageDir, destination, description) {
  await mkdir(destination, { recursive: true })
  await run('pnpm', ['pack', '--pack-destination', destination], { cwd: packageDir }, description)
  const files = await readdir(destination)
  const tarball = files.find(file => file.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack produced no tarball in ${destination}`)
  return join(destination, tarball)
}

/**
 * Install the launcher into a scratch prefix, exactly once per run.
 * @param consumerDir - the scratch project directory.
 * @param launcherVersion - the published version to install.
 */
async function installLauncher(consumerDir, launcherVersion) {
  await writeFile(join(consumerDir, 'package.json'), `${JSON.stringify({ name: 'consumer-smoke', private: true }, null, 2)}\n`)
  // Marking the scratch project its own workspace root is not a policy
  // bypass: it stops pnpm from walking UP into whatever repository contains
  // the temporary directory and applying rules that were never meant to
  // govern a throwaway install. On CI, where /tmp is outside any workspace,
  // the file changes nothing.
  const workspaceConfig = [
    '# Written by tools/consumer-smoke.mjs: this scratch project is its own',
    '# workspace root so enclosing repositories\' pnpm policies do not apply.',
    "packages:\n  - '.'",
  ]
  const configuredStore = (process.env.CONSUMER_SMOKE_STORE_DIR ?? '').trim()
  if (configuredStore !== '') workspaceConfig.push(`storeDir: ${configuredStore}`)
  await writeFile(join(consumerDir, 'pnpm-workspace.yaml'), `${workspaceConfig.join('\n')}\n`)
  await run('pnpm', ['add', ...storeArgs(), '--ignore-scripts', `${LAUNCHER_PACKAGE}@${launcherVersion}`],
    { cwd: consumerDir }, `installing ${LAUNCHER_PACKAGE}@${launcherVersion}`)
}

/**
 * Add the packed bundle to a fresh profile via the harness's own command.
 *
 * The first attempt is the real consumer path: pnpm resolves the bundle's own
 * dependency on the renderer from the registry, exactly as an install from npm
 * would. Two things can make that attempt fail for reasons a consumer would not
 * hit, and each is recovered by appending one line to the profile's own
 * pnpm-workspace.yaml and trying once more — never by inventing profile state
 * this script does not understand, because the harness wrote everything except
 * the appended line:
 *
 * - pnpm's default store is not writable on this machine, so the configured
 *   store has to be named in the profile too;
 * - the renderer version this commit depends on is not on the registry yet,
 *   which is the state of things between a rename or a version bump and the
 *   publish that follows it. The locally packed renderer stands in, so the boot
 *   is still proved against the code in this tree. Which renderer answered is
 *   reported, so a substitution is never silent.
 * @param dshBin - the launcher executable inside the scratch prefix.
 * @param home - DSH_HOME for this run.
 * @param tarball - the packed bundle to install.
 * @param rendererTarball - the packed renderer, used only if the registry
 *   cannot serve the version the bundle asks for.
 * @returns where the renderer came from, for the run's own report.
 */
async function installProfile(dshBin, home, tarball, rendererTarball) {
  const environment = {
    ...process.env,
    CI: 'true',
    DSH_HOME: home,
    PATH: `${dirname(dshBin)}:${process.env.PATH ?? ''}`,
  }
  const attempt = () => run(dshBin, ['plugin', '--profile', PROFILE_NAME, 'add', tarball], { cwd: dirname(tarball), env: environment }, 'adding the plugin to a fresh profile')
  try {
    await attempt()
    return 'registry'
  } catch (firstError) {
    const profileWorkspace = join(home, 'profiles', PROFILE_NAME, 'pnpm-workspace.yaml')
    let existing = ''
    try {
      existing = await readFile(profileWorkspace, 'utf8')
    } catch {
      throw firstError
    }
    let repaired = existing
    const configuredStore = (process.env.CONSUMER_SMOKE_STORE_DIR ?? '').trim()
    if (configuredStore !== '' && !existing.includes('storeDir')) {
      repaired += `storeDir: ${configuredStore}\n`
    }
    let renderer = 'registry'
    if (rendererTarball !== undefined && !existing.includes('overrides:')) {
      repaired += `overrides:\n  "${RENDERER_PACKAGE_NAME}": "file:${rendererTarball}"\n`
      renderer = 'packed'
    }
    // Nothing left to try: the failure is the answer, not a machine quirk.
    if (repaired === existing) throw firstError
    await writeFile(profileWorkspace, repaired)
    await attempt()
    if (renderer === 'packed') {
      process.stdout.write(
        `renderer: the registry does not serve ${RENDERER_PACKAGE_NAME} for this bundle yet;`
        + ' the locally packed renderer was used instead\n',
      )
    }
    return renderer
  }
}

/**
 * Watch a spawned process's own stdout in real time until it shows startup
 * evidence, then quit it with ctrl-d — the key the WINDOW owns everywhere,
 * per design — and wait for a clean exit.
 *
 * This reads the process's piped stdout, never a file. `script(1)` mirrors
 * the pty session to both its own stdout and the transcript file named on its
 * command line, but the two paths do not become readable at the same time:
 * writing to its own stdout is effectively unbuffered, while the file write
 * goes through ordinary buffered stdio, so a periodic re-read of that file
 * can observe "not ready yet" for as long as a buffer's worth of output takes
 * to fill or flush — long enough, in practice, to make this check give up
 * and quit before ever seeing evidence the terminal had already rendered.
 * Watching the pipe removes that lag: a `data` event fires as soon as Node's
 * own stream delivers the bytes.
 * A reply is answered the same way, and for the same reason: the first-run
 * question is on the terminal, not in a file, and it has to be answered when it
 * appears rather than after a fixed wait that could be too early on a fast
 * machine and too late on a slow one.
 * @param child - the spawned process; stdout, stderr, and stdin must be piped.
 * @param version - the bundle version expected in the banner.
 * @param bootTimeoutMs - how long to wait for both evidence flags before quitting anyway.
 * @param quitTimeoutMs - how long a graceful quit may take before the process is killed.
 * @param replies - things to type, in order: `{ after, send }`, where `after` is
 *   matched against the same whitespace-free flattening the evidence uses.
 * @param requireBanner - whether the banner must be seen before quitting. False
 *   where the version the banner will print is not known until after the run —
 *   a first run installs whatever the registry serves it, so the banner is
 *   checked afterwards against the version that actually landed.
 * @returns the exit outcome, the evidence observed when quit was requested, what
 *   was replied to, and everything captured.
 */
export function observeUntilReady(child, version, bootTimeoutMs, quitTimeoutMs, replies = [], requireBanner = true) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    let evidence = { sawBanner: false, sawReady: false }
    let quitRequested = false
    const replied = []

    const requestQuit = () => {
      if (quitRequested) return
      quitRequested = true
      clearTimeout(bootTimer)
      child.stdin.write('\u0004')
    }

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      const pending = replies[replied.length]
      if (pending !== undefined && flatten(stdout).includes(flatten(pending.after))) {
        replied.push(pending.after)
        child.stdin.write(pending.send)
      }
      evidence = parseBootEvidence(stdout, version)
      if (evidence.sawReady && (evidence.sawBanner || !requireBanner)) requestQuit()
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })

    // Give up waiting for evidence and quit anyway; the caller decides
    // pass/fail from the evidence actually observed, not from this timeout.
    const bootTimer = setTimeout(requestQuit, bootTimeoutMs)
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(
        `the process did not exit within ${String(bootTimeoutMs + quitTimeoutMs)}ms\nstderr:\n${stderr.slice(-1000)}`
        + `\ncaptured stdout:\n${stdout.slice(-2000)}`,
      ))
    }, bootTimeoutMs + quitTimeoutMs)

    child.on('error', error => {
      clearTimeout(bootTimer)
      clearTimeout(killTimer)
      rejectPromise(new Error(`could not run the child process: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      clearTimeout(bootTimer)
      clearTimeout(killTimer)
      if (signal !== null) {
        rejectPromise(new Error(`the interface was terminated by ${signal} instead of quitting cleanly\nstderr:\n${stderr.slice(-1000)}`))
        return
      }
      resolvePromise({ code: code ?? -1, evidence, replied, stdout })
    })
  })
}

/**
 * Quote one argument for the shell that starts `script(1)`.
 * @param argument - one argv entry.
 * @returns the argument as a single shell word.
 */
function shellWord(argument) {
  return `'${argument.replace(/'/gu, `'\\''`)}'`
}

/**
 * Spawn a command with a real pseudo-terminal on both ends.
 *
 * The two `script` implementations disagree about everything except that they
 * provide a terminal: util-linux takes the command as one string after `-qec`
 * and writes its transcript to the file named last, while BSD's takes the
 * command as arguments and refuses a stdin that is not a pipe — which is what
 * the process substitution supplies, since Node's own piped stdin is a socket.
 * Both are driven through `bash -c` rather than spawned directly so that one
 * command line covers the difference.
 * @param argv - the command and its arguments.
 * @param options - `cwd`, `env`, and where the transcript may be written.
 * @returns the spawned, fully piped child.
 */
function ptySpawn(argv, { cwd, env, transcript }) {
  const inner = argv.map(part => shellWord(part)).join(' ')
  const line = process.platform === 'linux'
    ? `exec script -qec ${shellWord(inner)} ${shellWord(transcript)}`
    : `exec script -q ${shellWord(transcript)} ${inner} < <(cat)`
  return spawn('bash', ['-c', line], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
}

/**
 * Boot the interface under a pseudo-terminal and quit it once ready.
 * @param dshBin - the launcher executable.
 * @param home - DSH_HOME for this run.
 * @param cwd - the folder the session opens into.
 * @param version - the bundle version expected in the banner.
 * @returns the evidence found before quitting.
 */
function bootAndQuit(dshBin, home, cwd, version) {
  // The transcript file is a postmortem artifact only, kept on disk beside a
  // failed run's preserved workspace for a human to inspect; this check
  // itself never reads it — see observeUntilReady's module comment for why.
  const child = ptySpawn([dshBin, '--profile', PROFILE_NAME, '-C', cwd], {
    cwd,
    env: { ...process.env, DSH_HOME: home, TERM: process.env.TERM ?? 'xterm-256color' },
    transcript: join(cwd, 'boot.out'),
  })
  return observeUntilReady(child, version, BOOT_TIMEOUT_MS, QUIT_TIMEOUT_MS).catch(error => {
    throw error.message.startsWith('could not run the child process')
      ? new Error(`${error.message}. This check needs script(1).`)
      : error
  })
}

/**
 * Unpack the packed bundle far enough to run its executable.
 *
 * The wrapper imports nothing from its own package — that is the point of it —
 * so it runs from an unpacked tarball with no install at all. Which is what
 * makes it testable here: what a consumer gets from
 * `npm install -g @dshline/dshline` is exactly this file.
 * @param tarball - the packed bundle.
 * @param destination - a directory to unpack into.
 * @returns the path of the packed `dshline` executable.
 */
async function extractWrapper(tarball, destination) {
  await mkdir(destination, { recursive: true })
  await run('tar', ['-xzf', tarball, '-C', destination], {}, 'unpacking the bundle')
  return join(destination, 'package', 'bin', 'dshline.mjs')
}

/**
 * Run the packed wrapper's first run under a pseudo-terminal: answer the
 * question, let the harness install, and land in a session.
 *
 * No version is expected up front, and that is a fact about the flow rather
 * than a looser check: a first run installs `@dshline/dshline` by name, and
 * which version the registry serves is pnpm's answer to give (a release-age
 * brake, for instance, deliberately holds back the newest). The caller reads
 * the version that actually landed and checks the banner against that.
 * @param wrapper - the packed `dshline` executable.
 * @param dshBin - the launcher executable, reached through PATH as a user's is.
 * @param home - DSH_HOME for this run.
 * @param cwd - the folder the session opens into.
 * @returns the exit outcome, the evidence, what was answered, and the capture.
 */
function firstRunAndQuit(wrapper, dshBin, home, cwd) {
  const child = ptySpawn([process.execPath, wrapper], {
    cwd,
    env: {
      ...process.env,
      DSH_HOME: home,
      // No DSH_BIN: the launcher is found the way an ordinary global install is
      // found, on PATH, so this exercises the resolution a consumer gets.
      DSH_BIN: '',
      PATH: `${dirname(dshBin)}:${process.env.PATH ?? ''}`,
      TERM: process.env.TERM ?? 'xterm-256color',
    },
    transcript: join(cwd, 'first-run.out'),
  })
  return observeUntilReady(child, undefined, BOOTSTRAP_TIMEOUT_MS, QUIT_TIMEOUT_MS, [
    { after: QUESTION_MARKER, send: 'y\n' },
  ], false)
}

// Entry point, guarded like the other tools so tests import cleanly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.platform === 'win32') {
    process.stdout.write('consumer smoke skipped: needs script(1) for a pseudo-terminal, which Windows has no equivalent of\n')
    process.exit(0)
  }
  const args = process.argv.slice(2)
  const channelIndex = args.indexOf('--channel')
  const launcherTag = channelIndex === -1 ? 'latest' : args[channelIndex + 1]
  const pinIndex = args.indexOf('--launcher-version')
  const pinnedLauncher = pinIndex === -1 ? undefined : args[pinIndex + 1]
  // The advertised first-run sequence, rather than a profile this script
  // installed itself: see the module comment.
  const bootstrap = args.includes('--bootstrap')
  if ((channelIndex !== -1 && launcherTag === undefined) || (pinIndex !== -1 && pinnedLauncher === undefined)) {
    process.stderr.write('usage: node tools/consumer-smoke.mjs [--bootstrap] [--channel <latest|alpha>] [--launcher-version <version>]\n')
    process.exit(1)
  }
  const bundleManifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-consumer-smoke-'))
  try {
    // A pinned version is what the Minimum lane needs: the floor it tests is a
    // Harness version, not a dist-tag, and installing `latest` there would
    // prove the boot against a launcher that lane does not claim to support.
    const launcherVersion = pinnedLauncher ?? await publishedVersion(LAUNCHER_PACKAGE, launcherTag)
    const consumerDir = join(workspace, 'consumer')
    await mkdir(consumerDir, { recursive: true })
    process.stdout.write(`launcher: ${LAUNCHER_PACKAGE}@${launcherVersion} (${pinnedLauncher === undefined ? launcherTag : 'pinned'})\n`)
    await installLauncher(consumerDir, launcherVersion)

    const tarball = await packPackage(BUNDLE_DIR, join(workspace, 'bundle'), 'packing the bundle')
    const tarballBytes = (await stat(tarball)).size
    process.stdout.write(`plugin: ${PLUGIN_PACKAGE_NAME}@${bundleManifest.version} (${tarballBytes.toString()} bytes)\n`)
    const dshBin = join(consumerDir, 'node_modules', '.bin', 'dsh')
    const scratch = join(workspace, 'session-folder')
    await mkdir(scratch, { recursive: true })

    if (bootstrap) {
      // What this mode proves, and nothing else: that THIS commit's wrapper
      // implements the lifecycle a new user meets. So the only thing taken from
      // the tarball is the executable, the harness home is genuinely empty, and
      // the package the first run installs is whatever the registry serves for
      // `@dshline/dshline` — because that is the name the wrapper passes, and
      // making that name resolve to a local tarball would mean editing the
      // profile's pnpm settings, i.e. testing a profile this script had already
      // touched. Whether the UNPUBLISHED plugin code in this commit installs and
      // boots is the other mode's question, and it answers it with the packed
      // tarball and a renderer fallback this mode needs none of.
      const wrapper = await extractWrapper(tarball, join(workspace, 'unpacked'))
      const home = join(workspace, '.dsh-first-run')
      const result = await firstRunAndQuit(wrapper, dshBin, home, scratch)
      if (!result.replied.includes(QUESTION_MARKER)) {
        throw new Error(
          'the first-run question never appeared, so nothing proved the advertised flow\n'
          + `captured terminal output:\n${result.stdout.slice(-2000)}`,
        )
      }
      if (!result.evidence.sawReady) {
        throw new Error(
          `first run never reached a session (exit code=${String(result.code)})\n`
          + `captured terminal output:\n${result.stdout.slice(-2000)}`,
        )
      }
      if (result.code !== 0) throw new Error(`ctrl-d exit was ${String(result.code)}, expected 0`)
      const profileDir = join(home, 'profiles', PROFILE_NAME)
      const bootstrapped = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      if (!(PLUGIN_PACKAGE_NAME in (bootstrapped.dependencies ?? {}))) {
        throw new Error(`the harness did not record ${PLUGIN_PACKAGE_NAME} in the profile it created: ${JSON.stringify(bootstrapped.dependencies ?? {})}`)
      }
      // The banner is checked against what the harness actually installed, read
      // from the profile it built. Anything else would be a guess: the registry's
      // newest and pnpm's choice are not always the same version.
      const installed = JSON.parse(
        await readFile(join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME, 'package.json'), 'utf8'),
      ).version
      if (!parseBootEvidence(result.stdout, installed).sawBanner) {
        throw new Error(
          `the banner did not name ${PLUGIN_PACKAGE_NAME}@${installed}, the version this first run installed\n`
          + `captured terminal output:\n${result.stdout.slice(-2000)}`,
        )
      }
      process.stdout.write(
        'first run passed: empty home, question answered, harness created and installed the profile,'
        + ` banner showed ${PLUGIN_PACKAGE_NAME}@${installed}, ctrl-d exited cleanly\n`,
      )
    } else {
      // Packed unconditionally so the fallback exists before it is known to be
      // needed; the registry is still preferred, and this is discarded unused
      // once these versions are published.
      const rendererTarball = await packPackage(RENDERER_DIR, join(workspace, 'renderer'), 'packing the renderer')
      const home = join(workspace, '.dsh')
      const renderer = await installProfile(dshBin, home, tarball, rendererTarball)
      const profileManifest = JSON.parse(await readFile(join(home, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'))
      if (!(PLUGIN_PACKAGE_NAME in (profileManifest.dependencies ?? {}))) {
        throw new Error(`profile manifest does not reference ${PLUGIN_PACKAGE_NAME}: ${JSON.stringify(profileManifest.dependencies ?? {})}`)
      }

      const { code, evidence, stdout } = await bootAndQuit(dshBin, home, scratch, bundleManifest.version)
      if (!evidence.sawBanner || !evidence.sawReady) {
        throw new Error(
          `startup incomplete (banner=${String(evidence.sawBanner)}, ready=${String(evidence.sawReady)}, exit code=${String(code)})\n`
          + `captured terminal output:\n${stdout.slice(-2000)}`,
        )
      }
      if (code !== 0) {
        throw new Error(`ctrl-d exit was ${String(code)}, expected 0`)
      }
      process.stdout.write(
        `smoke passed: profile loaded, banner showed ${PLUGIN_PACKAGE_NAME}@${bundleManifest.version},`
        + ` renderer from ${renderer}, ctrl-d exited cleanly\n`,
      )
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  } catch (error) {
    process.stderr.write(`consumer smoke: workspace kept for inspection at ${workspace}\n`)
    throw error
  }
}

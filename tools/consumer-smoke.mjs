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
 * Requires util-linux `script` for the pseudo-terminal, so this skips itself
 * on platforms without it rather than failing; the daily job runs on Linux,
 * where the check is real. Set CONSUMER_SMOKE_STORE_DIR to point pnpm at a
 * writable content-addressable store on machines whose default store location
 * is restricted; unset in CI, where the default is fine.
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
const BUNDLE_DIR = join(repoRoot, 'packages', 'tui')
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'
const REGISTRY_HOST = 'https://registry.npmjs.org'
const PLUGIN_PACKAGE_NAME = '@riesbri/dsh-tui'
const PROFILE_NAME = 'tui'

/** How long the boot may take to show its banner before this is a failure. */
export const BOOT_TIMEOUT_MS = 60_000

/** How long a graceful ctrl-d exit may take before the process is killed. */
const QUIT_TIMEOUT_MS = 30_000

/** Poll interval while waiting for terminal output to accumulate. */
const EVIDENCE_POLL_MS = 250

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
  const flat = raw
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]|\u001b\][^\u0007]*\u0007/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, '')
  return {
    // A missing or empty version must disable banner matching rather than
    // match everything: String.prototype.includes('') is always true.
    sawBanner: Boolean(version) && flat.includes('dsh-tui') && flat.includes(version.toLowerCase()),
    sawReady: flat.includes('ready'),
  }
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
 * The published launcher version a consumer would get today.
 * Consumers follow the `latest` tag (`npm install -g @deepseek-ai/dsh`), so
 * that tag — not the development line — is the truth this check installs.
 * @returns the exact version string.
 */
async function publishedLauncherVersion() {
  const response = await fetch(`${REGISTRY_HOST}/${encodeURIComponent(LAUNCHER_PACKAGE)}`)
  if (!response.ok) throw new Error(`registry returned ${String(response.status)} for ${LAUNCHER_PACKAGE}`)
  const packument = await response.json()
  const version = packument['dist-tags']?.latest
  if (version === undefined) throw new Error(`${LAUNCHER_PACKAGE} has no latest dist-tag on the registry`)
  return version
}

/**
 * Pack the bundle and copy the tarball into the sandbox directory.
 * Packing runs the prepare script (tsc -b), so lib/ exists even in a fresh
 * checkout — the same reason a consumer installing from npm gets working code.
 * @param workspace - the temporary directory receiving the tarball.
 * @returns the absolute path of the packed tarball.
 */
async function packBundle(workspace) {
  await run('pnpm', ['pack', '--pack-destination', workspace], { cwd: BUNDLE_DIR }, 'packing the bundle')
  const files = await readdir(workspace)
  const tarball = files.find(file => file.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack produced no tarball in ${workspace}`)
  return join(workspace, tarball)
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
 * On machines where pnpm's default store is not writable, the first attempt
 * initializes the profile and then fails; appending the configured store to the
 * profile's own pnpm-workspace.yaml and retrying once recovers without ever
 * inventing profile state this script does not understand — the harness wrote
 * everything except the one line being appended.
 * @param dshBin - the launcher executable inside the scratch prefix.
 * @param home - DSH_HOME for this run.
 * @param tarball - the packed bundle to install.
 */
async function installProfile(dshBin, home, tarball) {
  const environment = {
    ...process.env,
    CI: 'true',
    DSH_HOME: home,
    PATH: `${dirname(dshBin)}:${process.env.PATH ?? ''}`,
  }
  const attempt = () => run(dshBin, ['plugin', '--profile', PROFILE_NAME, 'add', tarball], { cwd: dirname(tarball), env: environment }, 'adding the plugin to a fresh profile')
  try {
    await attempt()
    return
  } catch (firstError) {
    const storeConfigured = (process.env.CONSUMER_SMOKE_STORE_DIR ?? '').trim() !== ''
    const profileWorkspace = join(home, 'profiles', PROFILE_NAME, 'pnpm-workspace.yaml')
    if (!storeConfigured) throw firstError
    let existing = ''
    try {
      existing = await readFile(profileWorkspace, 'utf8')
    } catch {
      throw firstError
    }
    if (!existing.includes('storeDir')) {
      await writeFile(profileWorkspace, `${existing}storeDir: ${process.env.CONSUMER_SMOKE_STORE_DIR}\n`)
    }
    await attempt()
  }
}

/**
 * Boot the interface under a pseudo-terminal until startup evidence appears,
 * then quit with ctrl-d — the key the WINDOW owns everywhere, per design.
 * @param dshBin - the launcher executable.
 * @param home - DSH_HOME for this run.
 * @param cwd - the folder the session opens into.
 * @param version - the bundle version expected in the banner.
 * @returns the evidence found before quitting.
 */
function bootAndQuit(dshBin, home, cwd, version) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outputPath = join(cwd, 'boot.out')
    const child = spawn('script', ['-qec', `${dshBin} --profile ${PROFILE_NAME} -C ${cwd}`, outputPath], {
      cwd,
      env: { ...process.env, DSH_HOME: home, TERM: process.env.TERM ?? 'xterm-256color' },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const started = Date.now()
    let evidence = { sawBanner: false, sawReady: false }
    const poll = setInterval(() => {
      readFile(outputPath, 'utf8')
        .then(content => {
          evidence = parseBootEvidence(content, version)
          if (evidence.sawBanner && evidence.sawReady) {
            clearInterval(poll)
            child.stdin.write('\u0004')
          }
        })
        .catch(() => {})
      if (Date.now() - started > BOOT_TIMEOUT_MS) {
        clearInterval(poll)
        child.stdin.write('\u0004')
      }
    }, EVIDENCE_POLL_MS)
    const guard = setTimeout(() => {
      clearInterval(poll)
      child.kill('SIGTERM')
      rejectPromise(new Error(`the interface did not reach a usable startup within ${String(BOOT_TIMEOUT_MS)}ms\nstderr:\n${stderr.slice(-1000)}`))
    }, BOOT_TIMEOUT_MS + QUIT_TIMEOUT_MS)
    child.on('error', error => {
      clearInterval(poll)
      clearTimeout(guard)
      rejectPromise(new Error(`could not run \`script\`: ${error.message}. This check needs util-linux script(1).`))
    })
    child.on('exit', (code, signal) => {
      clearInterval(poll)
      clearTimeout(guard)
      if (signal !== null) {
        rejectPromise(new Error(`the interface was terminated by ${signal} instead of quitting cleanly\nstderr:\n${stderr.slice(-1000)}`))
        return
      }
      resolvePromise({ code: code ?? -1, evidence })
    })
  })
}

// Entry point, guarded like the other tools so tests import cleanly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.platform !== 'linux') {
    process.stdout.write(`consumer smoke skipped: needs util-linux script(1), not available on ${process.platform}\n`)
    process.exit(0)
  }
  const bundleManifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-consumer-smoke-'))
  try {
    const launcherVersion = await publishedLauncherVersion()
    const consumerDir = join(workspace, 'consumer')
    await mkdir(consumerDir, { recursive: true })
    process.stdout.write(`launcher: ${LAUNCHER_PACKAGE}@${launcherVersion}\n`)
    await installLauncher(consumerDir, launcherVersion)

    const tarball = await packBundle(workspace)
    const tarballBytes = (await stat(tarball)).size
    process.stdout.write(`plugin: ${PLUGIN_PACKAGE_NAME}@${bundleManifest.version} (${tarballBytes.toString()} bytes)\n`)

    const home = join(workspace, '.dsh')
    const dshBin = join(consumerDir, 'node_modules', '.bin', 'dsh')
    await installProfile(dshBin, home, tarball)
    const profileManifest = JSON.parse(await readFile(join(home, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'))
    if (!(PLUGIN_PACKAGE_NAME in (profileManifest.dependencies ?? {}))) {
      throw new Error(`profile manifest does not reference ${PLUGIN_PACKAGE_NAME}: ${JSON.stringify(profileManifest.dependencies ?? {})}`)
    }

    const scratch = join(workspace, 'session-folder')
    await mkdir(scratch, { recursive: true })
    const { code, evidence } = await bootAndQuit(dshBin, home, scratch, bundleManifest.version)
    if (!evidence.sawBanner || !evidence.sawReady) {
      throw new Error(`startup incomplete (banner=${String(evidence.sawBanner)}, ready=${String(evidence.sawReady)})`)
    }
    if (code !== 0) {
      throw new Error(`ctrl-d exit was ${String(code)}, expected 0`)
    }
    process.stdout.write(`smoke passed: profile loaded, banner showed ${PLUGIN_PACKAGE_NAME}@${bundleManifest.version}, ctrl-d exited cleanly\n`)
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

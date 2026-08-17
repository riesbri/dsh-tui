/**
 * Audit the GitHub Actions workflows with zizmor.
 *
 * The workflows are privileged code, and the mistakes they invite are mechanical:
 * an action pinned to a movable tag, a token scoped wider than a job needs, a
 * `${{ }}` expansion inside a `run:` block where a branch name becomes shell.
 * zizmor is the linter for that class.
 *
 * This exists rather than a bare command in `package.json` for two reasons. The
 * version is pinned in ONE place, so CI and a contributor's machine audit with the
 * same rules — a lint that disagrees with CI is worse than none. And zizmor is a
 * Python-packaged Rust binary with two common launchers: GitHub's runners carry
 * `pipx`, while `uv` is what many people have locally. Either is fine; requiring a
 * specific one would make the check unrunnable for half of its audience.
 */

import { spawnSync } from 'node:child_process'

/** Pinned so the rules cannot change under a run. Bumped deliberately. */
const VERSION = '1.29.0'

/**
 * `pedantic` over the default persona: it reports code smells as well as
 * exploitable findings, which is the right setting for four short files that are
 * read far more often than they are changed.
 */
const ARGS = ['--persona=pedantic', '.github/workflows']

/** Launchers to try, in order, with the arguments each needs to pin the version. */
const LAUNCHERS = [
  { command: 'uvx', prefix: [`zizmor@${VERSION}`] },
  { command: 'pipx', prefix: ['run', `zizmor==${VERSION}`] },
]

/**
 * Whether a launcher is on PATH and runnable.
 * @param command - the executable name.
 * @returns whether it answered.
 */
function available(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

const launcher = LAUNCHERS.find(candidate => available(candidate.command))
if (launcher === undefined) {
  process.stderr.write(
    `zizmor needs uv or pipx to run.\n`
    + `  uv:   curl -LsSf https://astral.sh/uv/install.sh | sh\n`
    + `  pipx: python3 -m pip install --user pipx\n`,
  )
  process.exit(127)
}

const { status } = spawnSync(launcher.command, [...launcher.prefix, ...ARGS], { stdio: 'inherit' })
process.exit(status ?? 1)

/** Run the authenticated Codex acceptance fixture without shell-specific environment syntax. */

import { spawn } from 'node:child_process'

const child = spawn('pnpm', [
  'exec',
  'vitest',
  'run',
  'packages/tui/tests/codex-work.e2e.spec.ts',
], {
  env: { ...process.env, DSH_TUI_CODEX_E2E: '1' },
  stdio: 'inherit',
  // Windows resolves its pnpm command shim through cmd.exe. The argv is fixed
  // here, so this shell boundary never receives caller-controlled text.
  shell: process.platform === 'win32',
})

child.once('error', error => {
  process.stderr.write(`test:codex: ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`test:codex: pnpm exited from ${signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})

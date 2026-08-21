/** Opt-in real-product proof that generic Work observes a Codex delegation. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime, { type SubagentRun } from '@deepseek-ai/dsh-subagent'
import * as Codex from '@deepseek-ai/dsh-subagent-codex'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { stripAnsi } from '@riesbri/dsh-tui-renderer'
import { createHarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'

/** Environment gate that keeps credentials and a live Codex run out of normal CI. */
const REAL_CODEX_ENV = 'DSH_TUI_CODEX_E2E'

/** Leave an authenticated remote delegation enough time while still bounding cleanup on failure. */
const CODEX_RUN_TIMEOUT_MS = 90_000

/** The enclosing test leaves time after a run timeout for process-tree disposal. */
const CODEX_TEST_TIMEOUT_MS = 120_000

/** Run only when a developer explicitly requests a locally authenticated product check. */
const runRealCodex = process.env[REAL_CODEX_ENV] === '1'

/** Race an external operation against an actionable local timeout. */
async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Wait for every process owned through the real subprocess seam to exit. */
async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

describe.skipIf(!runRealCodex)('real Codex through generic Harness Work', () => {
  it('observes the generic lifecycle, renders the active row, then settles and releases its process tree', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-codex-work-'))
    const ctx = new Context()
    const controller = new AbortController()
    const handles: SubprocessHandle[] = []
    let run: SubagentRun | undefined
    let work: ReturnType<typeof createHarnessWork> | undefined
    try {
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Codex, { permissionMode: 'never' })
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
      ctx.subprocess.spawn = spec => {
        const handle = spawn(spec)
        handles.push(handle)
        return handle
      }

      // Work binds its listeners to this parent context. The real service keys
      // both lifecycle edges by this exact delegator, as a running TUI session does.
      const parent = {
        id: 'dsh-tui-codex-parent',
        ctx,
        session: { id: 'dsh-tui-codex-parent', header: { cwd: workspace } },
      } as unknown as Agent
      const starts: Array<{ readonly runId: string; readonly provider: string }> = []
      const ends: Array<{ readonly runId: string; readonly provider: string }> = []
      parent.ctx.on('subagent/start', info => { starts.push({ runId: String(info.runId), provider: info.provider }) })
      parent.ctx.on('subagent/end', info => { ends.push({ runId: String(info.runId), provider: info.provider }) })
      work = createHarnessWork(ctx, parent, () => {})

      const starting = ctx.subagents.start('codex', {
        label: 'dsh-tui Work acceptance',
        prompt: [{ type: 'text', text: 'Reply with exactly DSH_TUI_CODEX_WORK_OK. Do not run commands.' }],
        parent,
        signal: controller.signal,
      })
      // A timeout must not leave a late rejection unobserved after the test has
      // aborted the request and disposed the process-owning service.
      void starting.catch(() => {})
      run = await within(starting, CODEX_RUN_TIMEOUT_MS, 'Codex startup')

      expect(handles.length).toBeGreaterThan(0)
      expect(starts).toHaveLength(1)
      expect(starts[0]).toMatchObject({ provider: 'codex' })
      const active = work.snapshot().subagents
      expect(active).toEqual([expect.objectContaining({
        id: String(run.id), source: 'subagent', provider: 'codex', state: 'running', stoppable: false,
      })])
      const overlay = createWorkOverlay({
        snapshot: () => work!.snapshot(),
        stop: item => work!.stop(item),
        close: () => {},
        invalidate: () => {},
      })
      expect(stripAnsi(overlay.render(80, 12).join('\n'))).toContain('codex')

      const result = await within(run.result, CODEX_RUN_TIMEOUT_MS, 'Codex delegation')
      expect(result.stopReason).toBe('completed')
      expect(result.output).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('DSH_TUI_CODEX_WORK_OK') })])
      expect(ends).toEqual([expect.objectContaining({ runId: starts[0]!.runId, provider: 'codex' })])
      expect(work.snapshot().subagents).toEqual([])
    } finally {
      controller.abort(new Error('dsh-tui Codex acceptance cleanup'))
      if (run !== undefined) await run.dispose()
      work?.dispose()
      await expectQuiescent(handles)
      await ctx.fiber.dispose()
      await rm(workspace, { recursive: true, force: true, maxRetries: 3 })
    }
  }, CODEX_TEST_TIMEOUT_MS)
})

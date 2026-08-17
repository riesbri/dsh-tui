/**
 * A real terminal emulator as a test target.
 *
 * The renderer positions the cursor, erases regions, and redraws in place, so
 * what a person sees cannot be reconstructed by stripping escape sequences out of
 * the byte stream — the sequences ARE the layout. Feeding the bytes to an
 * emulator and reading its screen buffer is the only assertion that means
 * anything about rendered output.
 *
 * Hermetic on purpose: no pseudo-terminal, no harness, no model. It drives the
 * renderer's own {@link ScreenTarget} interface, so these tests run anywhere
 * `vitest` does.
 * @module @riesbri/dsh-tui-renderer/tests/emulator
 */

import headless from '@xterm/headless'
import type { ScreenTarget } from '../src/index.ts'

// The package ships CommonJS, so ESM interop puts its exports on `default`.
const { Terminal } = headless as unknown as { Terminal: new (options: object) => XtermLike }

/** The slice of xterm's API these tests use. */
interface XtermLike {
  readonly rows: number
  readonly buffer: { active: { getLine(y: number): { translateToString(trim: boolean): string; isWrapped: boolean } | undefined } }
  write(data: string, callback: () => void): void
  dispose(): void
}

/** A terminal under test, plus the target the renderer writes through. */
export interface Emulator {
  /** Hand this to `new Screen(...)`. */
  readonly target: ScreenTarget
  /** Await every write the renderer has issued so far. */
  flush(): Promise<void>
  /** Visible rows, trailing blank lines removed. */
  screen(): Promise<string[]>
  /** Release the emulator. */
  dispose(): void
}

/**
 * Create an emulator of `columns` by `rows`.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @returns the emulator and its screen target.
 */
export function createEmulator(columns: number, rows = 24): Emulator {
  const term = new Terminal({ cols: columns, rows, allowProposedApi: true })
  // xterm parses asynchronously, so every write is tracked and awaited before a
  // test reads the screen; reading early sees a partially parsed frame.
  const inflight: Promise<void>[] = []
  const flush = async (): Promise<void> => {
    while (inflight.length > 0) {
      const batch = inflight.splice(0, inflight.length)
      await Promise.all(batch)
    }
  }
  return {
    target: {
      write: chunk => {
        inflight.push(new Promise<void>(resolve => { term.write(chunk, resolve) }))
      },
      columns: () => columns,
    },
    flush,
    screen: async () => {
      await flush()
      const lines: string[] = []
      for (let y = 0; y < term.rows; y += 1) {
        lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
      }
      while (lines.length > 0 && lines.at(-1) === '') lines.pop()
      return lines
    },
    dispose: () => { term.dispose() },
  }
}

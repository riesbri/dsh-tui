/**
 * Raw-mode terminal ownership.
 *
 * Raw mode is process-global state: it must be restored on every exit path,
 * including a crash, or the user's shell is left without echo. Every acquisition
 * therefore returns one disposer that is safe to call twice, and the owner
 * registers no signal handlers of its own — `ctrl-c` arrives as a decoded key so
 * the application decides what cancelling means.
 * @module @riesbri/dsh-tui-renderer/terminal
 */

import type { Key } from './keys.ts'
import { decodeKeys } from './keys.ts'
import type { ScreenTarget } from './screen.ts'

/** The process streams a terminal owner drives. */
export interface TerminalStreams {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}

/** A live raw-mode terminal. */
export interface Terminal extends ScreenTarget {
  /** Observe decoded keystrokes; returns the removal disposer. */
  onKey(listener: (key: Key) => void): () => void
  /** Observe terminal resizes; returns the removal disposer. */
  onResize(listener: () => void): () => void
  /** Restore the terminal to the state it was acquired in. Idempotent. */
  close(): void
}

/** Default columns when the stream reports none, matching the classic width. */
const FALLBACK_COLUMNS = 80

/**
 * Whether both streams are terminals. A frontend must check this BEFORE
 * acquiring: raw mode on a pipe throws, and a UI with no terminal to draw on
 * would otherwise idle forever instead of failing.
 * @param streams - the process streams to test.
 * @returns whether interactive use is possible.
 */
export function isInteractive(streams: TerminalStreams): boolean {
  return streams.input.isTTY === true && streams.output.isTTY === true
}

/**
 * Acquire raw mode and start decoding input.
 * @param streams - the process streams to own.
 * @returns the live terminal; `close()` restores the previous mode.
 * @throws when either stream is not a terminal.
 */
export function acquireTerminal(streams: TerminalStreams): Terminal {
  if (!isInteractive(streams)) {
    throw new Error('dsh-tui-renderer: acquireTerminal requires a terminal on both stdin and stdout')
  }
  const { input, output } = streams
  const keyListeners = new Set<(key: Key) => void>()
  const resizeListeners = new Set<() => void>()
  const wasRaw = input.isRaw === true

  const onData = (chunk: string): void => {
    for (const key of decodeKeys(chunk)) {
      // Copy first: a listener may dispose itself while the batch is dispatching.
      for (const listener of [...keyListeners]) listener(key)
    }
  }
  const onResize = (): void => {
    for (const listener of [...resizeListeners]) listener()
  }

  input.setRawMode(true)
  input.setEncoding('utf8')
  input.resume()
  input.on('data', onData)
  output.on('resize', onResize)

  let closed = false
  return {
    write: chunk => { output.write(chunk) },
    columns: () => output.columns ?? FALLBACK_COLUMNS,
    onKey: listener => {
      keyListeners.add(listener)
      return () => { keyListeners.delete(listener) }
    },
    onResize: listener => {
      resizeListeners.add(listener)
      return () => { resizeListeners.delete(listener) }
    },
    close: () => {
      if (closed) return
      closed = true
      input.off('data', onData)
      output.off('resize', onResize)
      input.setRawMode(wasRaw)
      // Release the handle so the process can exit; the stream is shared with
      // whatever ran before, so it is paused rather than destroyed.
      input.pause()
      keyListeners.clear()
      resizeListeners.clear()
    },
  }
}

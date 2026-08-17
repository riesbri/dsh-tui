/**
 * Raw terminal input decoding.
 *
 * In raw mode the terminal delivers bytes, not events: a chunk may carry a
 * whole escape sequence, several keystrokes at once, or a pasted paragraph. The
 * decoder turns one chunk into an ordered list of keys, and never reports a
 * partial escape sequence as the printable characters that compose it.
 * @module @riesbri/dsh-tui-renderer/keys
 */

/** Named keys the renderer distinguishes from printable input. */
export type KeyName =
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'delete' | 'backspace' | 'enter' | 'tab' | 'escape'
  | 'ctrl-a' | 'ctrl-c' | 'ctrl-d' | 'ctrl-e' | 'ctrl-k' | 'ctrl-l'
  | 'ctrl-u' | 'ctrl-w'

/** One decoded keystroke: either a named key or literal text to insert. */
export type Key =
  | { kind: 'key'; name: KeyName }
  | { kind: 'text'; text: string }

/** Escape sequences shared by xterm-family terminals, by their tail. */
const CSI_KEYS: Readonly<Record<string, KeyName>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  '1~': 'home',
  '3~': 'delete',
  '4~': 'end',
  '7~': 'home',
  '8~': 'end',
}

/** Single control bytes, indexed by their code. */
const CONTROL_KEYS: Readonly<Record<number, KeyName>> = {
  0x01: 'ctrl-a',
  0x03: 'ctrl-c',
  0x04: 'ctrl-d',
  0x05: 'ctrl-e',
  0x08: 'backspace',
  0x09: 'tab',
  0x0a: 'enter',
  0x0b: 'ctrl-k',
  0x0c: 'ctrl-l',
  0x0d: 'enter',
  0x15: 'ctrl-u',
  0x17: 'ctrl-w',
  0x7f: 'backspace',
}

/** Terminating byte of a CSI sequence. */
function isCsiFinal(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x40 && code <= 0x7e
}

/**
 * Decode one raw input chunk into ordered keystrokes.
 *
 * A lone ESC at the very end of a chunk is reported as `escape`: waiting for a
 * possible continuation would make the key indistinguishable from a slow
 * arrow-key sequence, and every consumer treats `escape` as cancel, where a
 * spurious cancel is recoverable and a swallowed one is not.
 * @param chunk - bytes as received from the terminal, decoded as UTF-8.
 * @returns the keystrokes the chunk carries, in order.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = []
  let text = ''
  const flush = (): void => {
    if (text !== '') {
      keys.push({ kind: 'text', text })
      text = ''
    }
  }
  let index = 0
  while (index < chunk.length) {
    const char = chunk[index] ?? ''
    const code = char.codePointAt(0) ?? 0
    if (code === 0x1b) {
      flush()
      const next = chunk[index + 1]
      if (next === '[' || next === 'O') {
        let cursor = index + 2
        let params = ''
        while (cursor < chunk.length && !isCsiFinal(chunk[cursor] ?? '')) {
          params += chunk[cursor]
          cursor += 1
        }
        const final = chunk[cursor]
        if (final === undefined) {
          keys.push({ kind: 'key', name: 'escape' })
          break
        }
        const name = CSI_KEYS[`${params}${final}`] ?? CSI_KEYS[final]
        // An unrecognized sequence is dropped rather than inserted as text: the
        // alternative writes `[<27;5;13~` into the composer.
        if (name !== undefined) keys.push({ kind: 'key', name })
        index = cursor + 1
        continue
      }
      keys.push({ kind: 'key', name: 'escape' })
      index += 1
      continue
    }
    const control = CONTROL_KEYS[code]
    if (control !== undefined) {
      flush()
      keys.push({ kind: 'key', name: control })
      index += 1
      continue
    }
    if (code < 0x20) {
      index += 1
      continue
    }
    // Advance by code point, not code unit, so an astral character survives.
    const point = String.fromCodePoint(code)
    text += point
    index += point.length
  }
  flush()
  return keys
}

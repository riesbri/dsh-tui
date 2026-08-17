/**
 * Raw terminal input decoding.
 *
 * In raw mode the terminal delivers bytes, not events: a chunk may carry a whole
 * escape sequence, several keystrokes at once, a pasted paragraph, or half of any
 * of those. Decoding is therefore stateful — {@link createKeyDecoder} keeps the
 * undecidable tail of one chunk and resumes on the next, so a sequence split
 * across reads is not mistaken for the characters that compose it.
 * @module @riesbri/dsh-tui-renderer/keys
 */

/** Named keys the renderer distinguishes from printable input. */
export type KeyName =
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'delete' | 'backspace' | 'enter' | 'newline' | 'tab' | 'escape'
  | 'ctrl-a' | 'ctrl-c' | 'ctrl-d' | 'ctrl-e' | 'ctrl-k' | 'ctrl-l'
  | 'ctrl-o' | 'ctrl-u' | 'ctrl-w'

/**
 * One decoded keystroke.
 *
 * `paste` is separate from `text` because its content is literal: a newline
 * inside a paste is part of the pasted document, while a newline typed at the
 * keyboard is `enter` and means send.
 */
export type Key =
  | { kind: 'key'; name: KeyName }
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }

/** Bracketed-paste delimiters, which the terminal emits around pasted content. */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

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
  // Alt-enter, which terminals send as ESC then CR. Shift-enter is NOT here:
  // terminals send a bare CR for it, indistinguishable from enter itself.
  '\r': 'newline',
  '\n': 'newline',
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
  0x0f: 'ctrl-o',
  0x15: 'ctrl-u',
  0x17: 'ctrl-w',
  0x7f: 'backspace',
}

/** Terminating byte of a CSI sequence. */
function isCsiFinal(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x40 && code <= 0x7e
}

/** Whether `text` could still become `sequence` given more input. */
function isPrefixOf(text: string, sequence: string): boolean {
  return text.length < sequence.length && sequence.startsWith(text)
}

/** A decoder that survives sequences split across reads. */
export interface KeyDecoder {
  /**
   * Decode one raw chunk.
   * @param chunk - bytes as received from the terminal, decoded as UTF-8.
   * @returns the keystrokes now decidable, in order.
   */
  push(chunk: string): Key[]
  /**
   * Decide whatever is being held, because no more input is coming.
   *
   * The owner calls this after a short idle. A held tail is ambiguous only while
   * the terminal might still be mid-sequence; once it has gone quiet, a lone ESC
   * is the Escape key and a half-written sequence is not going to be finished.
   * @returns the keystrokes the held tail resolves to, in order.
   */
  flush(): Key[]
}

/**
 * Create a decoder.
 *
 * A lone ESC at the end of a chunk is HELD, not reported. It is the first byte of
 * every sequence this decoder recognises, the paste delimiters included, so
 * deciding it early is how a read boundary landing after that byte turns a pasted
 * paragraph back into one Enter per line — the exact failure bracketed paste exists
 * to prevent. What resolves it is {@link KeyDecoder.flush}, which the owner calls
 * after a short idle: by then the terminal has stopped writing, so the byte was the
 * Escape key. That costs the Escape key a few milliseconds and costs a split
 * delimiter nothing.
 * @returns the decoder.
 */
export function createKeyDecoder(): KeyDecoder {
  /** Undecidable tail of the previous chunk. */
  let rest = ''
  /** Content accumulated since a paste began, or undefined when not pasting. */
  let pasted: string | undefined

  return {
    flush() {
      if (rest === '') return []
      const held = rest
      rest = ''
      // Re-entering `push` would hold the same tail again, so the held bytes are
      // decided here: a lone ESC is the Escape key, and anything longer was a
      // sequence the terminal never finished, which is dropped rather than typed
      // into the composer as `[200`.
      if (held === '\u001b') return [{ kind: 'key', name: 'escape' }]
      if (pasted !== undefined) {
        const text = pasted + held
        pasted = undefined
        return text === '' ? [] : [{ kind: 'paste', text }]
      }
      return []
    },
    push(chunk) {
      const keys: Key[] = []
      let buffer = rest + chunk
      rest = ''
      let text = ''
      const flush = (): void => {
        if (text !== '') {
          keys.push({ kind: 'text', text })
          text = ''
        }
      }

      while (buffer !== '') {
        if (pasted !== undefined) {
          const end = buffer.indexOf(PASTE_END)
          if (end >= 0) {
            keys.push({ kind: 'paste', text: pasted + buffer.slice(0, end) })
            pasted = undefined
            buffer = buffer.slice(end + PASTE_END.length)
            continue
          }
          // Keep back only as much as could be a partial terminator, so a large
          // paste does not accumulate unboundedly waiting for its end.
          const keep = Math.min(buffer.length, PASTE_END.length - 1)
          pasted += buffer.slice(0, buffer.length - keep)
          rest = buffer.slice(buffer.length - keep)
          return keys
        }

        if (buffer.startsWith(PASTE_START)) {
          flush()
          pasted = ''
          buffer = buffer.slice(PASTE_START.length)
          continue
        }
        // A tail that could still become a paste delimiter waits for more input,
        // a lone ESC included: it is a prefix of both delimiters, and `flush`
        // resolves it once the terminal goes quiet.
        if (isPrefixOf(buffer, PASTE_START) || isPrefixOf(buffer, PASTE_END)) {
          flush()
          rest = buffer
          return keys
        }

        const char = buffer[0] ?? ''
        const code = char.codePointAt(0) ?? 0

        if (code === 0x1b) {
          flush()
          const next = buffer[1]
          if (next === undefined) {
            // Unreachable in practice: a lone ESC is held as a delimiter prefix
            // above. Kept so this branch cannot silently drop the key if that test
            // ever stops covering it.
            rest = buffer
            return keys
          }
          if (next === '[' || next === 'O') {
            let cursor = 2
            let params = ''
            while (cursor < buffer.length && !isCsiFinal(buffer[cursor] ?? '')) {
              params += buffer[cursor]
              cursor += 1
            }
            const final = buffer[cursor]
            if (final === undefined) {
              // Incomplete: hold it rather than dropping the key.
              rest = buffer
              return keys
            }
            const name = CSI_KEYS[`${params}${final}`] ?? CSI_KEYS[final]
            // An unrecognized sequence is dropped rather than inserted as text:
            // the alternative writes `[<27;5;13~` into the composer.
            if (name !== undefined) keys.push({ kind: 'key', name })
            buffer = buffer.slice(cursor + 1)
            continue
          }
          // ESC followed by an ordinary byte is an alt-modified key; only the
          // deliberate-newline pair is recognized.
          const alt = CSI_KEYS[next]
          if (alt !== undefined) keys.push({ kind: 'key', name: alt })
          else keys.push({ kind: 'key', name: 'escape' })
          buffer = buffer.slice(alt === undefined ? 1 : 2)
          continue
        }

        const control = CONTROL_KEYS[code]
        if (control !== undefined) {
          flush()
          keys.push({ kind: 'key', name: control })
          buffer = buffer.slice(1)
          continue
        }
        if (code < 0x20) {
          buffer = buffer.slice(1)
          continue
        }
        // Advance by code point, not code unit, so an astral character survives.
        const point = String.fromCodePoint(code)
        text += point
        buffer = buffer.slice(point.length)
      }
      flush()
      return keys
    },
  }
}

/**
 * Decode one complete chunk, keeping no state.
 *
 * For callers holding whole input at once. A live terminal should use
 * {@link createKeyDecoder}, which resumes across reads.
 * @param chunk - bytes as received from the terminal, decoded as UTF-8.
 * @returns the keystrokes the chunk carries, in order.
 */
export function decodeKeys(chunk: string): Key[] {
  return createKeyDecoder().push(chunk)
}

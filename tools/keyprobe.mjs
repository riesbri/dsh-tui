/**
 * Print what your terminal sends for each key, and how this project reads it.
 *
 * Terminals disagree about how they report keys. This project asks for an
 * extended keyboard mode on startup, and a terminal that supports it sends
 * different bytes than one that does not — which is why a shortcut can work in
 * one terminal and do nothing in another.
 *
 * Run this and press the key that misbehaves. Each line shows the raw bytes and
 * the key this project decodes them into. An empty `[]` means the key was not
 * recognised, which is a bug worth reporting. Press `q` to quit.
 *
 *   pnpm build && node tools/keyprobe.mjs
 *
 * Include the output in a bug report:
 *   https://github.com/riesbri/dsh-tui/issues
 */

import { decodeKeys } from '../packages/renderer/lib/keys.js'

const { stdin, stdout } = process

if (!stdin.isTTY) {
  stdout.write('keyprobe needs a real terminal on stdin\n')
  process.exit(1)
}

/** The two modes the frontend turns on, so this reports what it really receives. */
const MODES_ON = '\u001b[?2004h\u001b[>1u'

/** Turn them back off, so the shell that follows reads its input normally. */
const MODES_OFF = '\u001b[<u\u001b[?2004l'

/**
 * Render raw bytes readably: control characters as hex, escape as `ESC`.
 * @param bytes - one chunk as received from the terminal.
 * @returns a space-separated, printable form.
 */
function readable(bytes) {
  return [...bytes].map(character => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x1b) return 'ESC'
    if (code < 0x20 || code === 0x7f) return `0x${code.toString(16).padStart(2, '0')}`
    return character
  }).join(' ')
}

stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdout.write(MODES_ON)
stdout.write('Extended keyboard mode requested.\r\n')
stdout.write('Press any key — try ctrl-c, ctrl-d, shift-enter, esc, the arrows.\r\n')
stdout.write('Press q to quit.\r\n\r\n')

stdin.on('data', chunk => {
  const keys = decodeKeys(chunk)
  stdout.write(`bytes: ${readable(chunk).padEnd(30)} decoded: ${JSON.stringify(keys)}\r\n`)
  if (keys.some(key => key.kind === 'text' && key.text === 'q')) {
    stdout.write(MODES_OFF)
    stdin.setRawMode(false)
    process.exit(0)
  }
})

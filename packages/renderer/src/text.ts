/**
 * Making untrusted text safe to write, and styling the text we author.
 *
 * Everything the model, a tool, or a session log produces is untrusted for
 * terminal purposes: a raw escape sequence in tool output can move the cursor,
 * clear the screen, or repaint the live region out from under the renderer, and
 * an OSC sequence can retitle the window or drive a clipboard. Such text is
 * escaped to visible caret notation instead — the user sees what arrived.
 *
 * Only strings the frontend itself composes may carry styling, which is why
 * {@link style} exists separately from {@link escapeControls} and is never
 * applied to a value that came from outside.
 * @module @riesbri/dsh-tui-renderer/text
 */

/** SGR parameters for the styles the frontend uses. */
export const Style = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const

/** One selectable style name. */
export type StyleName = keyof typeof Style

/**
 * Wrap `text` in SGR codes, resetting afterwards.
 *
 * For frontend-authored strings only. Styling escaped untrusted text is safe but
 * pointless; styling UNescaped untrusted text is the bug this separation exists
 * to prevent.
 * @param text - frontend-authored text.
 * @param names - styles to apply together.
 * @returns the styled text, or `text` unchanged when no styles are named.
 */
export function style(text: string, ...names: readonly StyleName[]): string {
  if (names.length === 0) return text
  const codes = names.map(name => String(Style[name])).join(';')
  return `\u001b[${codes}m${text}\u001b[${String(Style.reset)}m`
}

/**
 * Columns a pasted tab becomes.
 *
 * Narrower than a terminal tab stop on purpose: a pasted tab is usually source
 * indentation, and four columns keeps a nested block readable inside a composer
 * that is already narrower than the screen. {@link escapeControls} would expand it
 * to a stop otherwise, which this pre-empts.
 */
const PASTE_TAB_WIDTH = 4

/**
 * Make pasted text safe to hold, measure, and draw.
 *
 * Pasted content is as untrusted as anything a model or tool produces, and more
 * likely to carry terminal controls: people paste logs. Three problems arrive
 * together, so they are fixed together and once, at the point of insertion,
 * rather than at each place the buffer is later measured or rendered.
 *
 * Line endings are normalized to `\n`, because a `\r` returns the cursor to
 * column zero and because a buffer split on `\n` alone would keep the `\r`
 * inside each line. Tabs become spaces, because a tab's rendered width depends on
 * tab stops that the width arithmetic cannot see. Everything else that is a
 * control character becomes caret notation, so an escape sequence copied out of a
 * log is shown rather than executed.
 * @param text - pasted content, verbatim from the terminal.
 * @returns text safe to store in a buffer and draw.
 */
export function sanitizePasted(text: string): string {
  return escapeControls(
    text
      .replace(/\r\n?/gu, '\n')
      .replace(/\t/gu, ' '.repeat(PASTE_TAB_WIDTH)),
  )
}

/** C0 controls, DEL, and C1 controls, none of which may reach the terminal. */
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

/** Columns between tab stops, the near-universal terminal default. */
export const TAB_STOP = 8

/**
 * Replace control characters with visible caret notation, and tabs with spaces.
 *
 * Newline survives: it is layout, and the caller has already decided how to wrap.
 * Everything else becomes `^X` (or `\u{…}` where no caret spelling exists), so an
 * escape sequence is shown rather than executed.
 *
 * Tabs are EXPANDED rather than kept. A tab is one character that the terminal
 * advances to the next tab stop, so leaving it in place makes every width helper
 * disagree with the screen: `displayWidth` counts it as zero, a box pads its row
 * to the wrong width and its right border shifts, and a truncation cuts in the
 * wrong place. Expanding here rather than at each call site is what keeps
 * "measuring and cutting agree with the terminal" true for tool output, which is
 * where tabs actually arrive.
 *
 * Expansion is relative to the start of the string, so text drawn under a gutter
 * has its stops shifted by the gutter's width. That is an approximation, and a
 * far smaller one than counting a tab as nothing.
 * @param text - untrusted text from a model, tool, or session log.
 * @returns text safe to hand to a screen, and safe to measure.
 */
export function escapeControls(text: string): string {
  const escaped = text.replace(CONTROL_PATTERN, char => {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`
    if (code === 0x7f) return '^?'
    return `\\u{${code.toString(16)}}`
  })
  return escaped.includes('\t') ? expandTabs(escaped) : escaped
}

/**
 * Replace each tab with spaces up to the next tab stop.
 *
 * Counted per line, because a newline returns the terminal to column zero.
 * @param text - text whose tabs should become spaces.
 * @returns the text with no tab characters left in it.
 */
function expandTabs(text: string): string {
  let out = ''
  let column = 0
  for (const char of text) {
    if (char === '\t') {
      const spaces = TAB_STOP - (column % TAB_STOP)
      out += ' '.repeat(spaces)
      column += spaces
      continue
    }
    if (char === '\n') {
      out += char
      column = 0
      continue
    }
    out += char
    column += 1
  }
  return out
}

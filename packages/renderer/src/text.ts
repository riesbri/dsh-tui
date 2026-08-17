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

/** C0 controls, DEL, and C1 controls, none of which may reach the terminal. */
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

/**
 * Replace control characters with visible caret notation.
 *
 * Tab and newline survive: they are layout, and the caller has already decided
 * how to wrap. Everything else becomes `^X` (or `\u{…}` where no caret spelling
 * exists), so escape sequences are shown rather than executed.
 * @param text - untrusted text from a model, tool, or session log.
 * @returns text safe to hand to a screen.
 */
export function escapeControls(text: string): string {
  return text.replace(CONTROL_PATTERN, char => {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`
    if (code === 0x7f) return '^?'
    return `\\u{${code.toString(16)}}`
  })
}

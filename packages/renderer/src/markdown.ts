/**
 * Markdown to styled terminal text.
 *
 * A deliberately small subset — headings, emphasis, inline and fenced code,
 * lists, block quotes, rules, and links — because that is what a model's reply
 * actually contains, and because a parser dependency would cost the property this
 * renderer is built around: it declares no dependencies at all.
 *
 * The security rule is the ordering. Every piece of source text is escaped BEFORE
 * any styling is added, never after: {@link escapeControls} neutralises the escape
 * character itself, so running it over already-styled output would destroy the
 * styling, and running it only over some spans would let a control sequence
 * through anywhere else. Untrusted content is therefore escaped as it is emitted,
 * and styling is applied to text this module has already made safe.
 * @module @riesbri/dsh-tui-renderer/markdown
 */

import { escapeControls, style } from './text.ts'
import type { StyleName } from './text.ts'

/** Bullet drawn for a list item, by nesting depth. */
const BULLETS = ['•', '◦', '‣'] as const

/** Columns of indent per nesting level. */
const INDENT = 2

/**
 * One emphasis form: its delimiter, the styling it applies, and whether the
 * delimiter is allowed to sit inside a word.
 */
interface Emphasis {
  readonly delimiter: string
  readonly styles: readonly StyleName[]
  /**
   * Whether the delimiter may open or close with a word character on the outside.
   *
   * False for `_` and `__`, following CommonMark: an underscore inside a word is
   * part of the word. Without this rule `snake_case_name` renders as
   * `snakecasename`, which silently corrupts identifiers, file paths, and
   * environment variable names in a reply — and italic is invisible in several
   * terminals, so the user sees only the damage.
   */
  readonly intraword: boolean
  /**
   * Whether content that reads as a single identifier vetoes this form.
   *
   * True only for `__`, and a deliberate deviation from CommonMark, which reads
   * `__init__` as strong emphasis. In a reply about code that string is a Python
   * dunder far more often, and the cost of guessing wrong is asymmetric:
   * rendering it as `init` corrupts a name the reader may need to type, while
   * leaving `__bold__` unstyled loses only emphasis. Multi-word `__bold text__`
   * is unaffected, and single `_italic_` keeps CommonMark behaviour.
   */
  readonly vetoIdentifier?: true
}

/** Emphasis forms, longest delimiter first so `**` wins over `*`. */
const EMPHASIS: readonly Emphasis[] = [
  { delimiter: '**', styles: ['bold'], intraword: true },
  { delimiter: '__', styles: ['bold'], intraword: false, vetoIdentifier: true },
  { delimiter: '~~', styles: ['dim'], intraword: true },
  { delimiter: '*', styles: ['italic'], intraword: true },
  { delimiter: '_', styles: ['italic'], intraword: false },
]

/** Inline code, whose content is literal — emphasis markers inside it are text. */
const CODE_SPAN = /^(`+)([^`]+)\1/u

/** A word character, for the intraword test. */
const WORD = /[\p{L}\p{N}]/u

/** Content that reads as one identifier rather than a phrase. */
const IDENTIFIER = /^[\p{L}\p{N}_]+$/u

/** A link, rendered as its text followed by the target. */
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)/u

/**
 * Render one line of inline markdown.
 *
 * Consumes the line left to right, so an unmatched marker is emitted as the
 * literal character it is rather than swallowing the rest of the line — a reply
 * containing a lone asterisk is common and must not lose its tail.
 * @param source - one line of untrusted markdown source.
 * @returns styled, escaped text.
 */
export function renderInline(source: string): string {
  let rest = source
  let out = ''
  let plain = ''
  const flush = (): void => {
    if (plain !== '') {
      out += escapeControls(plain)
      plain = ''
    }
  }
  /** The character just before the current position, for the flanking test. */
  const previous = (): string => (rest.length < source.length ? source[source.length - rest.length - 1] ?? '' : '')

  while (rest !== '') {
    const link = LINK.exec(rest)
    if (link !== null && link[1] !== undefined && link[2] !== undefined) {
      flush()
      out += style(escapeControls(link[1]), 'cyan') + style(` (${escapeControls(link[2])})`, 'gray')
      rest = rest.slice(link[0].length)
      continue
    }

    const code = CODE_SPAN.exec(rest)
    if (code !== null && code[2] !== undefined) {
      flush()
      out += style(escapeControls(code[2]), 'cyan')
      rest = rest.slice(code[0].length)
      continue
    }

    const emphasis = matchEmphasis(rest, previous())
    if (emphasis !== undefined) {
      flush()
      out += style(escapeControls(emphasis.content), ...emphasis.styles)
      rest = rest.slice(emphasis.length)
      continue
    }

    plain += rest[0] ?? ''
    rest = rest.slice(1)
  }
  flush()
  return out
}

/** A matched emphasis run: what it contains, how it renders, how far it spans. */
interface EmphasisMatch {
  readonly content: string
  readonly styles: readonly StyleName[]
  readonly length: number
}

/**
 * Match an emphasis run at the start of `rest`, or nothing.
 *
 * Delimiters must FLANK their content, which is what separates emphasis from
 * arithmetic and identifiers. An opening run may not be followed by whitespace
 * and a closing run may not be preceded by it, so `2 * 3 * 4` stays arithmetic;
 * `_` additionally may not touch a word character on the outside, so
 * `snake_case_name` stays an identifier.
 * @param rest - the remaining line, positioned at a candidate delimiter.
 * @param before - the character immediately before this position, or empty at the
 *   line start.
 * @returns the match, or undefined when no form applies here.
 */
function matchEmphasis(rest: string, before: string): EmphasisMatch | undefined {
  for (const { delimiter, styles, intraword, vetoIdentifier } of EMPHASIS) {
    if (!rest.startsWith(delimiter)) continue
    // Never match part of a longer delimiter run. Without this, a rejected `__`
    // lets the single `_` form consume one underscore of the pair and render
    // `__init__` as `_init_` — mangled differently rather than left alone.
    const marker = delimiter[0] ?? ''
    if (before === marker) continue
    if (rest[delimiter.length] === marker) continue
    if (!intraword && before !== '' && WORD.test(before)) continue
    const body = rest.slice(delimiter.length)
    // An opener followed by whitespace is not an opener.
    if (body === '' || /^\s/u.test(body)) continue
    let search = 0
    while (search >= 0) {
      const close = body.indexOf(delimiter, search)
      if (close <= 0) break
      const content = body.slice(0, close)
      const after = body[close + delimiter.length] ?? ''
      // A closer preceded by whitespace is not a closer, and for `_` it may not
      // touch a word either. Those are structural, so the scan moves on looking
      // for the next candidate.
      if (/\s$/u.test(content) || (!intraword && after !== '' && WORD.test(after))) {
        search = close + 1
        continue
      }
      // The identifier veto is different: this IS the closer CommonMark would
      // pick, so the form is abandoned rather than searched past — continuing
      // would find a distant closer and turn `__all__ and __name__` into
      // `all__ and __name`.
      if (vetoIdentifier === true && IDENTIFIER.test(content)) break
      return { content, styles, length: delimiter.length * 2 + content.length }
    }
  }
  return undefined
}

/** Heading styles by level; deeper headings are quieter. */
const HEADING_STYLES: readonly (readonly StyleName[])[] = [
  ['bold', 'cyan'],
  ['bold'],
  ['bold', 'dim'],
]

/**
 * Render markdown to styled lines.
 *
 * Structure is recognised line by line, which is what a terminal transcript
 * needs: there is no document to reflow, only a reply to read. Anything
 * unrecognised falls through as inline-rendered text, so malformed input degrades
 * to what it already looks like today rather than disappearing.
 * @param source - untrusted markdown, typically a model reply.
 * @returns styled lines, each already escaped.
 */
export function renderMarkdown(source: string): string[] {
  const out: string[] = []
  /** The opening fence run, kept whole so only an equal-or-longer run closes it. */
  let fence: string | undefined
  for (const line of source.split('\n')) {
    // At most three spaces of indent, per CommonMark: a deeper indent inside a
    // block is content, not a fence.
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? ''
      const info = (fenceMatch[2] ?? '').trim()
      if (fence === undefined) {
        fence = marker
        if (info !== '') out.push(style(escapeControls(info), 'gray'))
        continue
      }
      // A closer must use the same character, be at least as long, and carry no
      // info string. Keeping only the character meant any run closed any block,
      // so a three-backtick line inside a four-backtick block ended it early and
      // inverted every block after it — which is exactly the shape a model
      // produces when it shows fenced examples inside a fenced answer.
      if (marker[0] === fence[0] && marker.length >= fence.length && info === '') {
        fence = undefined
        continue
      }
    }
    if (fence !== undefined) {
      // Inside a fence everything is literal: escaped, indented, never parsed for
      // emphasis. This is where a model is most likely to emit an escape sequence.
      out.push(`  ${style(escapeControls(line), 'cyan')}`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      const level = (heading[1] ?? '#').length
      const styles = HEADING_STYLES[Math.min(level, HEADING_STYLES.length) - 1] ?? HEADING_STYLES[0]
      out.push(style(escapeControls(heading[2] ?? ''), ...styles ?? []))
      continue
    }

    if (/^\s*(?:[-*_]\s*){3,}$/u.test(line)) {
      out.push(style('───', 'gray'))
      continue
    }

    const quote = /^\s*>\s?(.*)$/u.exec(line)
    if (quote !== null) {
      out.push(`${style('▏', 'gray')} ${style(renderInline(quote[1] ?? ''), 'dim')}`)
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line)
    if (bullet !== null) {
      const depth = Math.floor((bullet[1] ?? '').length / INDENT)
      const glyph = BULLETS[Math.min(depth, BULLETS.length - 1)] ?? BULLETS[0]
      out.push(`${' '.repeat(depth * INDENT)}${style(glyph, 'gray')} ${renderInline(bullet[2] ?? '')}`)
      continue
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/u.exec(line)
    if (ordered !== null) {
      const depth = Math.floor((ordered[1] ?? '').length / INDENT)
      out.push(`${' '.repeat(depth * INDENT)}${style(`${ordered[2] ?? ''}.`, 'gray')} ${renderInline(ordered[3] ?? '')}`)
      continue
    }

    out.push(renderInline(line))
  }
  return out
}

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
 * @module @dshline/renderer/markdown
 */

import { escapeControls } from './text.ts'
import { paint } from './theme.ts'
import type { Role } from './theme.ts'

/** Bullet drawn for a list item, by nesting depth. */
const BULLETS = ['•', '◦', '‣'] as const

/** Columns of indent per nesting level. */
const INDENT = 2

/**
 * Widest leading indent a block marker is recognised behind. Past this a line is
 * prose, which is also true of real markdown: nesting this deep does not occur.
 */
const MAX_INDENT = 64

/** Digits an ordered-list number is recognised in, per CommonMark. */
const MAX_ORDINAL_DIGITS = 9

/** Render one line of fenced-code content: indented, escaped, never parsed. */
function renderFenceLine(line: string): string {
  return `  ${paint(escapeControls(line), 'code')}`
}

/**
 * One emphasis form: its delimiter, the styling it applies, and whether the
 * delimiter is allowed to sit inside a word.
 */
interface Emphasis {
  readonly delimiter: string
  readonly styles: readonly Role[]
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
  { delimiter: '**', styles: ['strong'], intraword: true },
  { delimiter: '__', styles: ['strong'], intraword: false, vetoIdentifier: true },
  { delimiter: '~~', styles: ['strike'], intraword: true },
  { delimiter: '*', styles: ['emphasis'], intraword: true },
  { delimiter: '_', styles: ['emphasis'], intraword: false },
]

/** Inline code, whose content is literal — emphasis markers inside it are text. */
const CODE_SPAN = /^(`+)([^`]+)\1/u

/** A word character, for the intraword test. */
const WORD = /[\p{L}\p{N}]/u

/** Content that reads as one identifier rather than a phrase. */
const IDENTIFIER = /^[\p{L}\p{N}_]+$/u

/**
 * Block markers, matched as a PREFIX and never anchored at the end.
 *
 * This form is the whole defence against a quadratic match, and the reasoning is
 * worth stating because the obvious alternatives are both wrong. A pattern shaped
 * `^(\s*)MARKER\s+(.*)$` has two unbounded runs that can both consume a space, so
 * whenever the tail fails the engine redistributes the separator across every
 * split — O(n²) in the line's length, which is `js/polynomial-redos`. Replacing
 * `\s` with `[ \t]` makes it strictly WORSE rather than better: `\s` matches a
 * newline, so a greedy `\s+` swallows a trailing one and the first attempt
 * succeeds, while `[ \t]+` cannot, and every split then gets tried. Measured, that
 * swap took a 16k-character line from 0.1 ms to 2367 ms.
 *
 * Matching only the marker removes the ambiguity instead of moving it: there is no
 * `$` to fail against and no trailing group to compete with the separator, so the
 * greedy run is taken once and never revisited. The caller takes the content with
 * `slice`, which is linear by construction.
 */
const RULE_SEPARATORS = /[ \t]/gu
const RULE_BODY = /^(?:-{3,}|\*{3,}|_{3,})$/u
const QUOTE = new RegExp(`^[ \\t]{0,${String(MAX_INDENT)}}>[ \\t]?`, 'u')
const HEADING = /^(#{1,6})[ \t]+/u
const BULLET = new RegExp(`^([ \\t]{0,${String(MAX_INDENT)}})[-*+][ \\t]+`, 'u')
const ORDERED = new RegExp(
  `^([ \\t]{0,${String(MAX_INDENT)}})(\\d{1,${String(MAX_ORDINAL_DIGITS)}})[.)][ \\t]+`,
  'u',
)

/**
 * Whether a line is a thematic break.
 *
 * Stripping the separators first and then testing the remainder is linear, where a
 * single pattern with a repeated group around an optional run backtracks. It also
 * corrects the rule: CommonMark requires the three-or-more characters to be the
 * SAME one, so `-*_` was never a break.
 * @param line - one line of source.
 * @returns whether it renders as a rule.
 */
function isRule(line: string): boolean {
  return RULE_BODY.test(line.replace(RULE_SEPARATORS, ''))
}

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
  /**
   * The character just before the current position, for the flanking test.
   *
   * A whole code point, not a UTF-16 code unit. Indexing by unit returns a lone
   * surrogate for a supplementary-plane letter, `WORD` does not match it, and the
   * flanking test then reads the position as non-word — so `𐐀_name_` rendered as
   * `𐐀name`, which is the identifier corruption the test exists to prevent.
   */
  const previous = (): string => {
    if (rest.length >= source.length) return ''
    const end = source.length - rest.length
    const code = source.codePointAt(end - 2)
    // A high surrogate at end - 2 means the character spans both units.
    if (code !== undefined && code > 0xffff) return String.fromCodePoint(code)
    return source[end - 1] ?? ''
  }

  while (rest !== '') {
    const link = LINK.exec(rest)
    if (link !== null && link[1] !== undefined && link[2] !== undefined) {
      flush()
      out += paint(escapeControls(link[1]), 'link') + paint(` (${escapeControls(link[2])})`, 'link-target')
      rest = rest.slice(link[0].length)
      continue
    }

    const code = CODE_SPAN.exec(rest)
    if (code !== null && code[2] !== undefined) {
      flush()
      out += paint(escapeControls(code[2]), 'code')
      rest = rest.slice(code[0].length)
      continue
    }

    const emphasis = matchEmphasis(rest, previous())
    if (emphasis !== undefined) {
      flush()
      out += paint(escapeControls(emphasis.content), ...emphasis.styles)
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
  readonly styles: readonly Role[]
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

/** Heading roles by level; deeper headings are quieter. */
const HEADING_STYLES: readonly (readonly Role[])[] = [
  ['heading-1'],
  ['heading-2'],
  ['heading-3'],
]

/**
 * A renderer that keeps block state between separately rendered lines.
 *
 * Fenced blocks are the only structure here that spans lines, and a caller that
 * receives markdown a line at a time — a streaming reply, committed as each line
 * completes — needs that state to survive between calls. Rendering each line with
 * a fresh {@link renderMarkdown} would reopen the fence on every line and style a
 * code block as prose.
 */
export interface MarkdownRenderer {
  /**
   * Render one source line, advancing block state.
   * @param source - one line of untrusted markdown, with no newline.
   * @returns styled, escaped lines: none for a fence marker, two for a fence
   *   opener carrying an info string, one otherwise.
   */
  line(source: string): string[]
  /**
   * Render the unfinished tail of a line as it streams.
   *
   * The live region holds the last line of a reply before its newline arrives,
   * and that line is still in flight: it may yet become a heading, a fence, or
   * plain prose. This renders it the way {@link line} will once it completes,
   * against the CURRENT block state — a partial line inside a fence reads as
   * code — without advancing that state. The fence a partial line opens or
   * closes is decided by its own newline, not by the text seen so far, which is
   * why this exists beside {@link line} rather than as a second call to it.
   *
   * A bounded live region can receive only a suffix of the source line. That
   * suffix has neither line-start nor inline-delimiter context, so it is kept
   * literal rather than treating an ordinary `#`, fence, or underscore at the
   * cut as markdown syntax.
   * @param source - the partial line, with no newline.
   * @param startsLine - whether `source` begins at the real source-line start.
   * @returns the styled, escaped row, or empty when the partial renders nothing.
   */
  partial(source: string, startsLine?: boolean): string
}

/**
 * Create a renderer that holds fence state across calls.
 * @returns the renderer; each instance is one independent document.
 */
export function createMarkdownRenderer(): MarkdownRenderer {
  /** The opening fence run, kept whole so only an equal-or-longer run closes it. */
  let fence: string | undefined
  return {
    line: source => renderLine(source, () => fence, next => { fence = next }),
    // A no-op setter: the partial line is the live region's view of a line whose
    // newline has not arrived, so nothing about block state may change yet.
    partial: (source, startsLine = true) => {
      if (!startsLine) {
        // A clipped suffix cannot tell whether its first character follows a word
        // or whether it started after earlier markdown syntax. Parsing it would
        // turn literal source into formatting; known fence state is the one fact
        // that survives the cut, so code remains recognisable without letting a
        // suffix close it.
        return fence === undefined
          ? escapeControls(source)
          : renderFenceLine(source)
      }
      return renderLine(source, () => fence, () => {}).join('')
    },
  }
}

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
  const renderer = createMarkdownRenderer()
  return source.split('\n').flatMap(line => renderer.line(line))
}

/**
 * Render one line against externally held fence state.
 * @param line - one line of untrusted markdown.
 * @param getFence - reads the currently open fence run, if any.
 * @param setFence - records the fence run this line opens or closes.
 * @returns the styled lines this source line produced.
 */
function renderLine(
  line: string,
  getFence: () => string | undefined,
  setFence: (fence: string | undefined) => void,
): string[] {
  const out: string[] = []
  const fence = getFence()
  // At most three spaces of indent, per CommonMark: a deeper indent inside a
  // block is content, not a fence.
  const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
  if (fenceMatch !== null) {
    const marker = fenceMatch[1] ?? ''
    const info = (fenceMatch[2] ?? '').trim()
    if (fence === undefined) {
      setFence(marker)
      if (info !== '') out.push(paint(escapeControls(info), 'muted'))
      return out
    }
    // A closer must use the same character, be at least as long, and carry no
    // info string. Keeping only the character meant any run closed any block,
    // so a three-backtick line inside a four-backtick block ended it early and
    // inverted every block after it — which is exactly the shape a model
    // produces when it shows fenced examples inside a fenced answer.
    if (marker[0] === fence[0] && marker.length >= fence.length && info === '') {
      setFence(undefined)
      return out
    }
  }
  if (fence !== undefined) {
    // Inside a fence everything is literal: escaped, indented, never parsed for
    // emphasis. This is where a model is most likely to emit an escape sequence.
    out.push(renderFenceLine(line))
    return out
  }

  const heading = HEADING.exec(line)
  if (heading !== null) {
    const level = (heading[1] ?? '#').length
    const styles = HEADING_STYLES[Math.min(level, HEADING_STYLES.length) - 1] ?? HEADING_STYLES[0]
    out.push(paint(escapeControls(line.slice(heading[0].length)), ...styles ?? []))
    return out
  }

  if (isRule(line)) {
    out.push(paint('───', 'rule'))
    return out
  }

  const quote = QUOTE.exec(line)
  if (quote !== null) {
    out.push(`${paint('▏', 'quote-bar')} ${paint(renderInline(line.slice(quote[0].length)), 'quote')}`)
    return out
  }

  const bullet = BULLET.exec(line)
  if (bullet !== null) {
    const depth = Math.floor((bullet[1] ?? '').length / INDENT)
    const glyph = BULLETS[Math.min(depth, BULLETS.length - 1)] ?? BULLETS[0]
    out.push(`${' '.repeat(depth * INDENT)}${paint(glyph, 'bullet')} ${renderInline(line.slice(bullet[0].length))}`)
    return out
  }

  const ordered = ORDERED.exec(line)
  if (ordered !== null) {
    const depth = Math.floor((ordered[1] ?? '').length / INDENT)
    const content = renderInline(line.slice(ordered[0].length))
    out.push(`${' '.repeat(depth * INDENT)}${paint(`${ordered[2] ?? ''}.`, 'bullet')} ${content}`)
    return out
  }

  out.push(renderInline(line))
  return out
}

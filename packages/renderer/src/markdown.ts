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

/** Inline patterns, tried in order. Earlier entries win over later ones. */
const INLINE: readonly { pattern: RegExp; styles: readonly StyleName[]; group: number }[] = [
  // Code first: its content is literal, so emphasis markers inside it are text.
  { pattern: /^`([^`]+)`/u, styles: ['cyan'], group: 1 },
  { pattern: /^\*\*([^*]+)\*\*/u, styles: ['bold'], group: 1 },
  { pattern: /^__([^_]+)__/u, styles: ['bold'], group: 1 },
  { pattern: /^\*([^*]+)\*/u, styles: ['italic'], group: 1 },
  { pattern: /^_([^_]+)_/u, styles: ['italic'], group: 1 },
  { pattern: /^~~([^~]+)~~/u, styles: ['dim'], group: 1 },
]

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
  while (rest !== '') {
    const link = LINK.exec(rest)
    if (link !== null && link[1] !== undefined && link[2] !== undefined) {
      flush()
      out += style(escapeControls(link[1]), 'cyan') + style(` (${escapeControls(link[2])})`, 'gray')
      rest = rest.slice(link[0].length)
      continue
    }
    let matched = false
    for (const { pattern, styles, group } of INLINE) {
      const found = pattern.exec(rest)
      const content = found?.[group]
      if (found === undefined || found === null || content === undefined) continue
      flush()
      // Escaped first, then styled: the escape is what makes the content safe,
      // and applying it afterwards would strip the styling as well.
      out += style(escapeControls(content), ...styles)
      rest = rest.slice(found[0].length)
      matched = true
      break
    }
    if (matched) continue
    plain += rest[0] ?? ''
    rest = rest.slice(1)
  }
  flush()
  return out
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
  let fence: string | undefined
  for (const line of source.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? ''
      if (fence === undefined) {
        fence = marker[0]
        const language = (fenceMatch[2] ?? '').trim()
        if (language !== '') out.push(style(escapeControls(language), 'gray'))
        continue
      }
      if (marker.startsWith(fence)) {
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

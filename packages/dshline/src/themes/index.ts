/**
 * `/themes`: choose the palette, and show what it did.
 *
 * Two things about this frontend make a theme picker unusual, and both are
 * terminal-model consequences rather than gaps to fill in later.
 *
 * The first is that finished rows are committed to the user's real scrollback
 * and are never rewritten. Switching palette repaints the bounded live region;
 * everything above it keeps the colours it was printed with, permanently. That
 * is the invariant the whole renderer is built on, so the command says so rather
 * than letting a reader conclude the switch half-failed.
 *
 * The second follows from the first. A picker cannot preview a palette by
 * repainting the transcript, and the shared list overlay draws every row in the
 * same colour, so neither of the usual ways to show a theme's effect is
 * available. Applying one therefore COMMITS a sample block — the rows a session
 * is actually made of, drawn under the new palette, landing directly beneath the
 * differently coloured history. The comparison becomes the point instead of the
 * confusion, and it costs no overlay of its own.
 * @module dshline/themes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ColorDepth, Palette } from '@dshline/renderer'
import { box, escapeControls, paint } from '@dshline/renderer'
import { promptSelect } from '../select.ts'
import { THEMES, findTheme } from './builtin.ts'

/** Width the sample block is drawn at when the terminal is wider than it needs. */
const SAMPLE_COLUMNS = 64

/** Narrowest terminal that still gets a framed sample rather than bare rows. */
const SAMPLE_MIN_COLUMNS = 24

/**
 * How the depths are named where one has to be reported.
 *
 * Reported at all because "no silent degradation" applies to palettes too: a
 * reader who picks a 24-bit theme on a sixteen-colour terminal should be told
 * they are seeing its declared fallback, not left to wonder why it looks like
 * the one they just left.
 */
const DEPTH_NAMES: Readonly<Record<ColorDepth, string>> = {
  0: 'no colour',
  4: '16 colours',
  8: '256 colours',
  24: '24-bit colour',
}

/**
 * The values `/themes` accepts, for completing its argument.
 * @returns each shipped theme's id, with its description beside it.
 */
export function themeValues(): readonly { value: string; note?: string }[] {
  return THEMES.map(theme => ({ value: theme.id, note: theme.description }))
}

/**
 * A short, framed sample of the rows a session is made of.
 *
 * Composed from the same roles the real views use rather than from screenshots
 * of them, so a role that a palette moved shows up here by construction. It is
 * deliberately small: this is committed to scrollback on every switch, and a
 * reader trying three palettes should not lose a screen of history to it.
 * @param palette - the palette being applied, named in the frame's title.
 * @param columns - the terminal's current width.
 * @returns lines to commit.
 */
export function sampleLines(palette: Palette, columns: number): readonly string[] {
  const width = Math.min(SAMPLE_COLUMNS, Math.max(SAMPLE_MIN_COLUMNS, columns - 2))
  const rows = [
    `${paint('›', 'user')} ${paint('rename the width helper', 'user')}`,
    `${paint('●', 'assistant')} Renaming it now. ${paint('displayWidth', 'code')} stays.`,
    `${paint('✻', 'reasoning-mark')} ${paint('two call sites, both in the renderer', 'reasoning')}`,
    '',
    `${paint('⏺', 'tool-icon')} ${paint('edit', 'tool-name')} ${paint('src/width.ts', 'path')}`,
    `  ${paint('+ export function displayWidth(text: string) {', 'diff-add')}`,
    `  ${paint('- export function width(text: string) {', 'diff-remove')}`,
    `  ${paint('… 3 more changed lines', 'muted')}`,
    '',
    `${paint('✗', 'error')} ${paint('exit 1', 'error')}`,
    `${paint('·', 'muted')} ${paint('command reported no output', 'muted')}`,
    '',
    [
      `${paint('●', 'ready')}${paint(' ready', 'subdued')}`,
      paint('deepseek-v4-pro', 'subdued'),
      paint('plan', 'mode'),
      paint('goal 3/256', 'mode-alert'),
      paint('$0.04', 'subdued'),
    ].join(paint(' · ', 'chrome')),
  ]
  return box(rows, {
    width,
    title: paint(escapeControls(palette.name), 'overlay-title'),
    border: text => paint(text, 'overlay-border'),
  })
}

/**
 * What applying a palette should report into the transcript.
 *
 * The scrollback caveat is stated only where it is TRUE. On the first switch of
 * a session there may be nothing above worth mentioning, but the command cannot
 * know that — it does not own the transcript — so it says it whenever the
 * palette actually changed, and stays quiet when a reader re-picks the palette
 * they already had.
 * @param palette - the palette now in force.
 * @param depth - what the terminal can actually show.
 * @param changed - whether this switch changed anything.
 * @returns the report line.
 */
export function themeReport(palette: Palette, depth: ColorDepth, changed: boolean): string {
  const degraded = palette.depth > depth
    ? ` · authored for ${DEPTH_NAMES[palette.depth]}, showing its ${DEPTH_NAMES[depth]} fallback`
    : ''
  if (!changed) return paint(`· theme: ${palette.id} — already in use${degraded}`, 'muted')
  return paint(
    `· theme: ${palette.id}${degraded} · rows above keep the colours they were printed with`,
    'muted',
  )
}

/** What the caller has to supply for `/themes` to do its work. */
export interface ThemeCommand {
  /** Plugin context, for the picker overlay. */
  readonly ctx: Context
  /** The palette currently in force. */
  readonly current: () => Palette
  /** What the terminal can show, resolved once when the window opened. */
  readonly depth: ColorDepth
  /** Install a palette for this window. */
  readonly apply: (palette: Palette) => void
  /** The terminal's current width, for the sample block. */
  readonly columns: () => number
  /** Write finished rows into scrollback. */
  readonly commit: (lines: readonly string[]) => void
}

/**
 * Run `/themes`, named or asked for.
 *
 * Named and asked-for meet at one resolve, so a typed word and a chosen row
 * cannot drift — the same rule `/usage` and `/reasoning` follow. A name that
 * matches nothing reports what was on offer instead of opening a picker the
 * reader did not ask for.
 * @param spec - the window seams this command needs.
 * @param rawInput - exactly what followed the command name.
 * @returns once the switch and its report are complete.
 */
export async function runThemes(spec: ThemeCommand, rawInput: string): Promise<void> {
  const named = rawInput.trim()
  const current = spec.current()
  const picked = named === ''
    ? await promptSelect(spec.ctx, {
      title: 'Theme',
      detail: `current: ${current.id}`,
      choices: THEMES.map(theme => ({
        value: theme.id,
        label: theme.name,
        description: theme.depth > spec.depth
          ? `${theme.description} — this terminal shows its ${DEPTH_NAMES[spec.depth]} fallback`
          : theme.description,
      })),
    })
    : named
  // Dismissed, so nothing changed and there is nothing to report.
  if (picked === undefined) return
  const chosen = findTheme(picked)
  if (chosen === undefined) {
    const offered = THEMES.map(theme => theme.id).join(', ')
    spec.commit([paint(
      `✗ no theme named ${escapeControls(picked)}; try one of: ${offered}`,
      'error',
    )])
    return
  }
  const changed = chosen.id !== current.id
  // Applied before anything is drawn with it, so the report and the sample are
  // both rendered under the palette they are describing.
  if (changed) spec.apply(chosen)
  const lines = [themeReport(chosen, spec.depth, changed)]
  if (changed) lines.push(...sampleLines(chosen, spec.columns()), '')
  spec.commit(lines)
}

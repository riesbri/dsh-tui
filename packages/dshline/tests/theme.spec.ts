/**
 * The roles this frontend adds, and the palette it ships.
 *
 * The renderer locks its own roles in its own suite. What is proved here is the
 * half that is this package's: that its additions emit exactly what the
 * `style()` calls they replaced emitted, and that the assembled palette is
 * total over both halves.
 */
import { describe, expect, it } from 'vitest'
import type { Role, StyleName } from '@dshline/renderer'
import { MARKDOWN_ROLES, paint, style } from '@dshline/renderer'
import { DEFAULT_PALETTE } from '../src/theme.ts'

/**
 * Each role this package declares, beside the exact `style()` arguments it
 * replaced.
 *
 * Transcribed from the call sites in argument ORDER, never re-derived: a table
 * written colour-first would emit `CSI 36;1 m` where the code emits
 * `CSI 1;36 m` — the same appearance, different bytes, and other specs in this
 * package match those bytes literally.
 */
const REPLACES = {
  user: ['cyan', 'bold'],
  assistant: ['green'],
  reasoning: ['dim', 'italic'],
  'reasoning-mark': ['gray'],
  'section-heading': ['bold'],
  'tool-icon': ['blue'],
  'tool-name': ['bold'],
  path: ['cyan'],
  'diff-add': ['green'],
  'diff-remove': ['red'],
  banner: ['bold', 'cyan'],
  busy: ['yellow'],
  ready: ['green'],
  mode: ['cyan'],
  'mode-alert': ['yellow'],
  'pressure-nominal': ['dim'],
  'pressure-warn': ['yellow'],
  'pressure-alarm': ['red'],
  error: ['red'],
  warning: ['yellow'],
  success: ['green'],
  chrome: ['gray'],
  'composer-title': ['cyan'],
  'overlay-title': ['bold', 'yellow'],
  'overlay-headline': ['yellow', 'bold'],
  'panel-title': ['cyan', 'bold'],
  selection: ['cyan', 'bold'],
  'selection-mark': ['cyan'],
  'timing-active': ['cyan'],
  'prompt-mark': ['yellow'],
  subdued: ['dim'],
} as const satisfies Readonly<Record<string, readonly StyleName[]>>

describe('the roles this frontend adds', () => {
  it('emits exactly what the style() call each replaced emitted', () => {
    // The golden lock. A failure here means the shipped palette has stopped
    // being a refactor, so every colour assertion in this package is suspect.
    // The palette itself is installed by `tests/setup.ts`, as `createWindow`
    // installs it in production.
    for (const [role, names] of Object.entries(REPLACES) as [Role, StyleName[]][]) {
      expect(paint('x', role), role).toBe(style('x', ...names))
    }
  })

  it('adds every role the shipped palette carries beyond the renderer own', () => {
    // Guards the table above against drifting out of the augmentation: a role
    // added to `PaletteRoles` without a line here would otherwise go unproven.
    const mine = Object.keys(DEFAULT_PALETTE.roles)
      .filter(role => !(role in MARKDOWN_ROLES))
      .sort()
    expect(Object.keys(REPLACES).sort()).toStrictEqual(mine)
  })
})

describe('the shipped palette', () => {
  it('carries the renderer own roles as well as this package own', () => {
    // Totality is a compile-time property of `Palette`; this proves the spread
    // actually happened rather than the type being satisfied some other way.
    for (const role of Object.keys(MARKDOWN_ROLES)) {
      expect(DEFAULT_PALETTE.roles, role).toHaveProperty(role)
    }
  })

  it('is authored at the sixteen-colour floor, with no deeper forms', () => {
    // What a terminal reporting nothing about itself receives, and what keeps
    // the default byte-identical to what this project emitted before palettes.
    expect(DEFAULT_PALETTE.depth).toBe(4)
    for (const [role, color] of Object.entries(DEFAULT_PALETTE.roles)) {
      expect(color.truecolor, role).toBeUndefined()
      expect(color.ansi256, role).toBeUndefined()
    }
  })
})

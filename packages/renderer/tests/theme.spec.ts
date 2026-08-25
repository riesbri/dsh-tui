/**
 * What the role layer guarantees: the shipped palette is a refactor, not a
 * redesign, and folding one to a shallower terminal never breaks a wrap.
 *
 * The golden lock below is the whole reason ~250 call sites can be migrated
 * mechanically. It fails loudly the moment someone "improves" a colour while
 * moving a call site, which is exactly when nobody would be looking for it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Palette, Role, StyleName } from '../src/index.ts'
import { chunkToWidth, DEFAULT_PALETTE, paint, resolveColorDepth, setPalette, style } from '../src/index.ts'

/**
 * Every role, beside the exact `style()` arguments it replaces.
 *
 * Transcribed from the call sites in argument ORDER, never re-derived: a table
 * written colour-first would emit `CSI 36;1 m` where the code emits `CSI 1;36 m`
 * — the same appearance, different bytes, and two other specs match those bytes
 * literally.
 */
const REPLACES: Readonly<Record<Role, readonly StyleName[]>> = {
  user: ['cyan', 'bold'],
  assistant: ['green'],
  reasoning: ['dim', 'italic'],
  'reasoning-mark': ['gray'],
  'heading-1': ['bold', 'cyan'],
  'heading-2': ['bold'],
  'heading-3': ['bold', 'dim'],
  strong: ['bold'],
  emphasis: ['italic'],
  strike: ['dim'],
  code: ['cyan'],
  link: ['cyan'],
  'link-target': ['gray'],
  quote: ['dim'],
  'quote-bar': ['gray'],
  bullet: ['gray'],
  rule: ['gray'],
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
  'overlay-border': ['yellow'],
  'overlay-title': ['bold', 'yellow'],
  'overlay-headline': ['yellow', 'bold'],
  'panel-title': ['cyan', 'bold'],
  selection: ['cyan', 'bold'],
  'selection-mark': ['cyan'],
  'timing-active': ['cyan'],
  'prompt-mark': ['yellow'],
  muted: ['gray'],
  subdued: ['dim'],
}

/** The closer `width.ts` recognizes, and the only one that may be emitted. */
const RESET = /\u001b\[0m$/u

/** A palette authored deeper than sixteen colours, for the folding tests. */
const DEEP: Palette = {
  id: 'deep',
  name: 'Deep',
  description: 'Fixture: one role authored at every depth',
  depth: 24,
  roles: {
    ...DEFAULT_PALETTE.roles,
    error: { truecolor: [38, 2, 255, 85, 85], ansi256: [38, 5, 203], ansi: [31] },
    // Deliberately shallow: proves a role falls back to its own floor rather
    // than to some other role's deeper form.
    warning: { ansi: [33] },
  },
}

// Every spec here installs palettes; leaving one behind would silently retheme
// whatever ran next in this file. Nothing outside this file ever calls
// `setPalette`, which is what keeps the frames specs on the module default.
let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

describe('paint()', () => {
  it('emits exactly what the style() call it replaces emitted', () => {
    // The golden lock. A failure here means the default palette has stopped
    // being a refactor, so every colour assertion in both packages is suspect.
    for (const [role, names] of Object.entries(REPLACES) as [Role, StyleName[]][]) {
      expect(paint('x', role), role).toBe(style('x', ...names))
    }
  })

  it('covers every role the palette declares, and no more', () => {
    // Guards the table above against drifting out of the union: a role added to
    // `Role` without a line in REPLACES would otherwise go unproven.
    expect(Object.keys(REPLACES).sort()).toStrictEqual(Object.keys(DEFAULT_PALETTE.roles).sort())
  })

  it('closes with the reset width.ts recognizes, never a foreground reset', () => {
    // `CSI 39 m` renders the same and would be treated as an OPENER by every
    // wrap, replayed onto each continuation row and never clearing.
    for (const role of Object.keys(DEFAULT_PALETTE.roles) as Role[]) {
      expect(paint('x', role), role).toMatch(RESET)
    }
  })

  it('applies several roles in the order they were given', () => {
    restore = setPalette(DEFAULT_PALETTE, 4)
    expect(paint('x', 'strong', 'code')).toBe('\u001b[1;36mx\u001b[0m')
    expect(paint('x', 'code', 'strong')).toBe('\u001b[36;1mx\u001b[0m')
  })

  it('leaves text alone when no role is named', () => {
    expect(paint('x')).toBe('x')
  })
})

describe('palette folding', () => {
  it('uses the deepest form the terminal reaches', () => {
    restore = setPalette(DEEP, 24)
    expect(paint('x', 'error')).toBe('\u001b[38;2;255;85;85mx\u001b[0m')
  })

  it('steps down to the 256-colour form on a 256-colour terminal', () => {
    restore = setPalette(DEEP, 8)
    expect(paint('x', 'error')).toBe('\u001b[38;5;203mx\u001b[0m')
  })

  it('falls back to the declared sixteen-colour floor, not an approximation', () => {
    restore = setPalette(DEEP, 4)
    expect(paint('x', 'error')).toBe('\u001b[31mx\u001b[0m')
  })

  it('gives a shallowly authored role its own floor at every depth', () => {
    restore = setPalette(DEEP, 24)
    expect(paint('x', 'warning')).toBe('\u001b[33mx\u001b[0m')
  })

  it('emits nothing at all at depth 0, attributes included', () => {
    // A NO_COLOR consumer is piping. Writing `CSI 1 m` into that pipe because
    // bold is "not a colour" defeats the whole point of the request.
    restore = setPalette(DEEP, 0)
    expect(paint('x', 'strong')).toBe('x')
    expect(paint('x', 'error')).toBe('x')
  })
})

describe('multi-parameter colour and the width arithmetic', () => {
  it('survives a wrap with the full sequence replayed on each row', () => {
    // The one thing widening past sixteen colours could plausibly break:
    // `chunkToWidth` replays whatever escape is open onto every continuation
    // row, and a truecolor opener is several parameters long.
    restore = setPalette(DEEP, 24)
    const rows = chunkToWidth(paint('a'.repeat(12), 'error'), 4)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row).toContain('\u001b[38;2;255;85;85m')
      expect(row).toMatch(RESET)
    }
  })
})

describe('setPalette()', () => {
  it('restores the palette that was active before', () => {
    const before = paint('x', 'error')
    const undo = setPalette(DEEP, 24)
    expect(paint('x', 'error')).not.toBe(before)
    undo()
    expect(paint('x', 'error')).toBe(before)
  })

  it('ignores a second call rather than clobbering a later palette', () => {
    // The hazard the guard exists for, and the reason `acquireTerminal`'s
    // disposer carries the same one: a spent disposer that still restored would
    // undo whoever installed after it. `/themes` replaces the window's palette
    // on every switch, so a stale disposer outliving its own palette is the
    // normal case here, not a contrived one.
    const spent = setPalette(DEEP, 24)
    spent()
    const current = setPalette(DEEP, 8)
    spent()
    expect(paint('x', 'error')).toBe('\u001b[38;5;203mx\u001b[0m')
    current()
    expect(paint('x', 'error')).toBe(style('x', 'red'))
  })
})

describe('resolveColorDepth()', () => {
  it('refuses colour to a terminal that says it is dumb', () => {
    expect(resolveColorDepth({ term: 'dumb', isTty: true, colorterm: 'truecolor' })).toBe(0)
  })

  it('lets FORCE_COLOR overrule both NO_COLOR and a pipe', () => {
    expect(resolveColorDepth({ forceColor: '1', noColor: '1', isTty: false })).toBe(4)
    expect(resolveColorDepth({ forceColor: '2', isTty: false })).toBe(8)
    expect(resolveColorDepth({ forceColor: '3', isTty: false })).toBe(24)
    expect(resolveColorDepth({ forceColor: '', isTty: false })).toBe(4)
  })

  it('treats FORCE_COLOR=0 as a refusal', () => {
    expect(resolveColorDepth({ forceColor: '0', isTty: true, colorterm: 'truecolor' })).toBe(0)
    expect(resolveColorDepth({ forceColor: 'false', isTty: true })).toBe(0)
  })

  it('honours NO_COLOR whatever its value says', () => {
    // no-color.org: presence disables colour "regardless of its value", so the
    // reading a plausible implementation gets wrong is `NO_COLOR=0`.
    expect(resolveColorDepth({ noColor: '1', isTty: true })).toBe(0)
    expect(resolveColorDepth({ noColor: '0', isTty: true })).toBe(0)
    expect(resolveColorDepth({ noColor: '', isTty: true })).toBe(4)
  })

  it('gives a pipe no colour', () => {
    expect(resolveColorDepth({ isTty: false })).toBe(0)
  })

  it('reads the depth a terminal advertises', () => {
    expect(resolveColorDepth({ colorterm: 'truecolor', isTty: true })).toBe(24)
    expect(resolveColorDepth({ colorterm: '24bit', isTty: true })).toBe(24)
    expect(resolveColorDepth({ term: 'xterm-256color', isTty: true })).toBe(8)
    expect(resolveColorDepth({ term: 'xterm', isTty: true })).toBe(4)
    expect(resolveColorDepth({ isTty: true })).toBe(4)
  })
})

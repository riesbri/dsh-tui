/**
 * The palette mechanism, and the roles this package draws itself.
 *
 * Deliberately says nothing about replies, tool cards, or context pressure:
 * those roles belong to whichever frontend declares them, and this package must
 * keep working — and keep being testable — knowing nothing about any of them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Palette, Role, StyleName } from '../src/index.ts'
import { chunkToWidth, MARKDOWN_ROLES, paint, setPalette, style } from '../src/index.ts'

/** Every role this package declares, beside the `style()` call it replaced. */
const REPLACES: Readonly<Record<Role, readonly StyleName[]>> = {
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
  muted: ['gray'],
}

/** The closer `width.ts` recognizes, and the only one that may be emitted. */
const RESET = /\u001b\[0m$/u

/** A palette carrying only this package's roles, authored deeper than sixteen. */
const DEEP = {
  id: 'deep',
  name: 'Deep',
  description: 'Fixture: one role authored at every depth',
  depth: 24,
  roles: {
    ...MARKDOWN_ROLES,
    code: { truecolor: [38, 2, 255, 85, 85], ansi256: [38, 5, 203], ansi: [31] },
    // Deliberately shallow: proves a role falls back to its own floor rather
    // than to some other role's deeper form.
    rule: { ansi: [33] },
  },
} as Palette

// Every spec here installs palettes; leaving one behind would silently retheme
// whatever ran next in this file.
let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

describe('paint()', () => {
  it('emits exactly what the style() call it replaces emitted', () => {
    // The golden lock for this package's own roles. A frontend's roles are
    // locked the same way, in its own suite.
    for (const [role, names] of Object.entries(REPLACES) as [Role, StyleName[]][]) {
      expect(paint('x', role), role).toBe(style('x', ...names))
    }
  })

  it('covers every role this package declares, and no more', () => {
    expect(Object.keys(REPLACES).sort()).toStrictEqual(Object.keys(MARKDOWN_ROLES).sort())
  })

  it('closes with the reset width.ts recognizes, never a foreground reset', () => {
    // `CSI 39 m` renders the same and would be treated as an OPENER by every
    // wrap, replayed onto each continuation row and never clearing.
    for (const role of Object.keys(MARKDOWN_ROLES) as Role[]) {
      expect(paint('x', role), role).toMatch(RESET)
    }
  })

  it('applies several roles in the order they were given', () => {
    expect(paint('x', 'strong', 'code')).toBe('\u001b[1;36mx\u001b[0m')
    expect(paint('x', 'code', 'strong')).toBe('\u001b[36;1mx\u001b[0m')
  })

  it('leaves text alone when no role is named', () => {
    expect(paint('x')).toBe('x')
  })

  it('draws a role the active palette does not carry, unstyled', () => {
    // A consumer's roles are absent until it installs its palette. A frame
    // missing its colour is a better failure than a crashed one, and this is
    // what lets the renderer draw at all before any frontend wires it up.
    expect(paint('x', 'not-a-role' as Role)).toBe('x')
  })
})

describe('palette folding', () => {
  it('uses the deepest form the terminal reaches', () => {
    restore = setPalette(DEEP, 24)
    expect(paint('x', 'code')).toBe('\u001b[38;2;255;85;85mx\u001b[0m')
  })

  it('steps down to the 256-colour form on a 256-colour terminal', () => {
    restore = setPalette(DEEP, 8)
    expect(paint('x', 'code')).toBe('\u001b[38;5;203mx\u001b[0m')
  })

  it('falls back to the declared sixteen-colour floor, not an approximation', () => {
    restore = setPalette(DEEP, 4)
    expect(paint('x', 'code')).toBe('\u001b[31mx\u001b[0m')
  })

  it('gives a shallowly authored role its own floor at every depth', () => {
    restore = setPalette(DEEP, 24)
    expect(paint('x', 'rule')).toBe('\u001b[33mx\u001b[0m')
  })

  it('emits nothing at all at depth 0, attributes included', () => {
    // A NO_COLOR consumer is piping. Writing `CSI 1 m` into that pipe because
    // bold is "not a colour" defeats the whole point of the request.
    restore = setPalette(DEEP, 0)
    expect(paint('x', 'strong')).toBe('x')
    expect(paint('x', 'code')).toBe('x')
  })
})

describe('multi-parameter colour and the width arithmetic', () => {
  it('survives a wrap with the full sequence replayed on each row', () => {
    // The one thing widening past sixteen colours could plausibly break:
    // `chunkToWidth` replays whatever escape is open onto every continuation
    // row, and a truecolor opener is several parameters long.
    restore = setPalette(DEEP, 24)
    const rows = chunkToWidth(paint('a'.repeat(12), 'code'), 4)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row).toContain('\u001b[38;2;255;85;85m')
      expect(row).toMatch(RESET)
    }
  })
})

describe('setPalette()', () => {
  it('restores the palette that was active before', () => {
    const before = paint('x', 'code')
    const undo = setPalette(DEEP, 24)
    expect(paint('x', 'code')).not.toBe(before)
    undo()
    expect(paint('x', 'code')).toBe(before)
  })

  it('ignores a second call rather than clobbering a later palette', () => {
    // The hazard the guard exists for, and the reason `acquireTerminal`'s
    // disposer carries the same one: a spent disposer that still restored would
    // undo whoever installed after it. A theme switch replaces the window's
    // palette, so a stale disposer outliving its own palette is the normal
    // case, not a contrived one.
    const spent = setPalette(DEEP, 24)
    spent()
    const current = setPalette(DEEP, 8)
    spent()
    expect(paint('x', 'code')).toBe('\u001b[38;5;203mx\u001b[0m')
    current()
    expect(paint('x', 'code')).toBe(style('x', 'cyan'))
  })
})

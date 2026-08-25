/**
 * The shipped palettes, and what a terminal that cannot show one gets instead.
 *
 * The property that matters most here is totality: a role added to the union
 * without a line in the swatch mapping would leave every theme but `default`
 * with a hole, and a hole renders as unstyled text rather than as an error.
 */
import { describe, expect, it } from 'vitest'
import type { Palette, Role } from '@dshline/renderer'
import { paint, setPalette, style } from '@dshline/renderer'
import { DEFAULT_PALETTE } from '../src/theme.ts'
import { FALLBACK_THEME, THEMES, findTheme } from '../src/themes/builtin.ts'

/** Every role the renderer declares, taken from the palette that must be total. */
const ROLES = Object.keys(DEFAULT_PALETTE.roles) as Role[]

/** Install a palette for one assertion and take it back down again. */
function under<T>(palette: Palette, depth: 0 | 4 | 8 | 24, run: () => T): T {
  const restore = setPalette(palette, depth)
  try {
    return run()
  } finally {
    restore()
  }
}

describe('the shipped palettes', () => {
  it('gives every role a value in every theme', () => {
    for (const theme of THEMES) {
      expect(Object.keys(theme.roles).sort(), theme.id).toStrictEqual([...ROLES].sort())
    }
  })

  it('declares a sixteen-colour form for every role, so no terminal is guessed at', () => {
    // The contract that keeps "no silent degradation" true for palettes: what a
    // basic terminal shows is authored, not approximated.
    for (const theme of THEMES) {
      for (const role of ROLES) {
        expect(theme.roles[role].ansi.length, `${theme.id}/${role}`).toBeGreaterThan(0)
      }
    }
  })

  it('leaves the default palette byte-identical to the primitive it replaced', () => {
    // Restated here rather than left to the renderer's own spec, because this is
    // the list `/theme` offers and `default` is the row a reader returns to.
    under(DEFAULT_PALETTE, 4, () => {
      expect(paint('x', 'error')).toBe(style('x', 'red'))
      expect(paint('x', 'user')).toBe(style('x', 'cyan', 'bold'))
      expect(paint('x', 'heading-1')).toBe(style('x', 'bold', 'cyan'))
    })
  })

  it('offers default first and the shallow palettes before the deep ones', () => {
    expect(THEMES[0]?.id).toBe('default')
    const depths = THEMES.map(theme => theme.depth)
    expect([...depths]).toStrictEqual([...depths].sort((a, b) => a - b))
  })

  it('has a unique id and a description for every theme', () => {
    const ids = THEMES.map(theme => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const theme of THEMES) {
      expect(theme.name.length, theme.id).toBeGreaterThan(0)
      expect(theme.description.length, theme.id).toBeGreaterThan(0)
    }
  })
})

describe('findTheme()', () => {
  it('matches an id case-insensitively and ignores surrounding space', () => {
    expect(findTheme('ember')?.id).toBe('ember')
    expect(findTheme('  EMBER ')?.id).toBe('ember')
  })

  it('answers nothing for a name no theme has', () => {
    expect(findTheme('dracula')).toBeUndefined()
    expect(findTheme('')).toBeUndefined()
  })

  it('names default as the fallback', () => {
    expect(FALLBACK_THEME.id).toBe('default')
  })
})

describe('degrading a palette to the terminal', () => {
  it('shows a 24-bit theme in 24-bit where the terminal reaches it', () => {
    const ember = findTheme('ember')
    expect(ember).toBeDefined()
    under(ember as Palette, 24, () => {
      expect(paint('x', 'error')).toContain('38;2;')
    })
  })

  it('steps a 24-bit theme down to its 256-colour form', () => {
    under(findTheme('tide') as Palette, 8, () => {
      expect(paint('x', 'error')).toContain('38;5;')
      expect(paint('x', 'error')).not.toContain('38;2;')
    })
  })

  it('steps it down again to the sixteen-colour form its author declared', () => {
    under(findTheme('paper') as Palette, 4, () => {
      // Paper's `tool` role is the only shipped use of magenta, which was a dead
      // entry in the style table before palettes existed.
      expect(paint('x', 'tool-icon')).toBe(style('x', 'magenta'))
    })
  })

  it('emits nothing at all at depth 0, whatever the theme', () => {
    for (const theme of THEMES) {
      under(theme, 0, () => {
        expect(paint('x', 'error'), theme.id).toBe('x')
        expect(paint('x', 'user'), theme.id).toBe('x')
      })
    }
  })
})

describe('the light-terminal palette', () => {
  it('moves the absolute grey without moving the dim attribute', () => {
    // The concrete reason `muted` and `subdued` are two roles. On a white
    // background bright black is nearly invisible while dim is merely quiet, so
    // a light palette has to move one and leave the other. A single role could
    // not have done both, and this is the assertion that would fail if someone
    // merged them.
    const paper = findTheme('paper') as Palette
    expect(paper.roles.muted.truecolor).toBeDefined()
    expect(paper.roles.subdued.ansi).toStrictEqual([2])
    expect(paper.roles.muted.ansi).not.toStrictEqual(paper.roles.subdued.ansi)
  })
})

describe('the high-contrast palette', () => {
  it('spends nothing on dim or bright black', () => {
    // Both are the first thing to disappear on a washed-out display, and they
    // are what the default palette leans on hardest.
    const contrast = findTheme('high-contrast') as Palette
    for (const role of ROLES) {
      const { ansi } = contrast.roles[role]
      expect(ansi, role).not.toContain(2)
      expect(ansi, role).not.toContain(90)
    }
  })
})

---
"@dshline/renderer": minor
"@dshline/dshline": minor
---

Colour is now chosen by semantic role rather than by name, and `NO_COLOR` is honoured.

Every call site said `style(text, 'red')`, which names an appearance instead of a meaning — written identically for a failed tool and for a removed line of a diff, so no second palette could ever move one without moving the other. `paint(text, 'error')` and a `Palette` of roles replace it throughout. The shipped palette emits exactly the bytes it always did, so there is no visual change.

`NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, and `TERM=dumb` are now respected; none of them was read before. A palette may be authored in 256-colour or 24-bit form, and declares its own sixteen-colour fallback per role rather than being approximated.

New in `@dshline/renderer`: `paint`, `setPalette`, `activePalette`, `resolveColorDepth`, `DEFAULT_PALETTE`, `sgr`, and the `Role`, `Palette`, `RoleColor`, `Sgr`, `ColorDepth`, and `ColorEnvironment` types. `style`, `Style`, and `StyleName` remain exported and unchanged.

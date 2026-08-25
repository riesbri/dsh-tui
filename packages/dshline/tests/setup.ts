/**
 * Install this frontend's palette before any of its specs run.
 *
 * The renderer starts on its own roles alone — markdown and generic emphasis —
 * because it must not know what a reply or a tool card is. Everything else is
 * declared here in `dshline`, so a spec that renders a card or a status line
 * needs this package's palette in force, exactly as `createWindow` puts it in
 * force in production.
 *
 * Doing it once here rather than per file keeps the specs about what they
 * assert. It is also why the renderer's own specs are a separate vitest
 * project: they must keep passing with nothing installed.
 */
import { setPalette } from '@dshline/renderer'
import { DEFAULT_PALETTE } from '../src/theme.ts'

// Depth 4, never the developer's own terminal. A truecolor default would show
// green tests on one laptop and different bytes in CI.
setPalette(DEFAULT_PALETTE, 4)

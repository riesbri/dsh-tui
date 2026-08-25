import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Test configuration.
 *
 * Split into projects so the renderer's specs run with NOTHING installed. That
 * is not tidiness: the renderer declares only the roles it paints itself, and
 * its independence — no terminal, no model, no consumer — is the property that
 * lets every rule about widths, cutting, and escaping be tested at all. A
 * shared setup file that installed the frontend's palette would quietly hide a
 * renderer that had started depending on it.
 *
 * `packages/dshline` therefore owns its own setup, and the repo-wide specs —
 * the cross-package checks in `tests/` and the tooling specs in `tools/` — get a
 * third project of their own.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/renderer',
      'packages/dshline',
      {
        resolve: {
          alias: {
            '@dshline/renderer': fileURLToPath(new URL('./packages/renderer/src/index.ts', import.meta.url)),
          },
        },
        test: {
          name: 'repo',
          root: fileURLToPath(new URL('.', import.meta.url)),
          include: ['tests/**/*.spec.ts', 'tools/**/*.spec.mjs'],
        },
      },
    ],
  },
})

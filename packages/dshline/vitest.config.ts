import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * This package's specs.
 *
 * The alias is the point of the root config and is repeated here because a
 * project resolves on its own: `packages/dshline` depends on the renderer by
 * package name, which resolves through `exports` to its BUILT `lib/`, so
 * without it every test runs against whatever the last `tsc -b` left behind.
 *
 * `setupFiles` installs this frontend's palette. The renderer ships only the
 * roles it draws itself, so a spec rendering a card or a status line needs the
 * palette `createWindow` installs in production.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dshline/renderer': fileURLToPath(new URL('../renderer/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
})

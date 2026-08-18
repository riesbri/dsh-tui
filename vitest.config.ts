import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Test configuration.
 *
 * The alias is the point of this file. `packages/tui` depends on the renderer by
 * package name, which resolves through `exports` to its BUILT `lib/` — so without
 * this, every test of the bundle runs against whatever the last `tsc -b` left
 * behind. A renderer change would be invisible until someone rebuilt, and a test
 * could pass against code that no longer exists.
 *
 * Pointing the name at `src` keeps every test on the source plane, so what runs is
 * what is written. The published package still resolves through `exports`; nothing
 * here changes what consumers get.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@riesbri/dsh-tui-renderer': fileURLToPath(new URL('./packages/renderer/src/index.ts', import.meta.url)),
    },
  },
})

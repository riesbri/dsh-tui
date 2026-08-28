/**
 * Connect on a real terminal: a long directory stays a live overlay, and a
 * sign-in's page and code land in scrollback where they can be copied.
 */

import { describe, expect, it } from 'vitest'
import { Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { noticeLines } from '../src/connect/authorize.ts'
import type { ConnectProviderRow, ConnectSignInRow, ConnectState } from '../src/connect/model.ts'
import { createConnectOverlay } from '../src/connect/overlay.ts'

/** The width used by the real-terminal regression frames. */
const COLUMNS = 80

/** A fixed clock, so the frames do not depend on when the suite runs. */
const NOW = 1_800_000_000_000

/** More configurable routes than any terminal under test can show at once. */
const PROVIDERS: ConnectProviderRow[] = Array.from({ length: 60 }, (_unused, index) => ({
  kind: 'provider',
  provider: index === 0 ? 'first-sentinel' : index === 59 ? 'last-sentinel' : `route-${String(index)}`,
  displayName: `Route ${String(index)}`,
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', `route-${String(index)}`],
  declared: false,
  state: index % 3 === 0 ? 'active' : 'dormant',
  models: index % 3 === 0 ? 4 : undefined,
  credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
  userOwned: false,
  revision: 1,
}))

/** One sign-in, so the second section is present in every frame. */
const SIGN_INS: ConnectSignInRow[] = [{
  kind: 'sign-in',
  key: 'llm-pi-ai/openai',
  label: 'SIGN-IN-SENTINEL',
  methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
  inFlight: false,
  record: { configured: false, writable: true },
}]

/** The reading every frame is drawn from. */
const STATE: ConnectState = {
  kind: 'ready',
  providers: PROVIDERS,
  signIns: SIGN_INS,
  capabilities: { settings: true, credentials: true, authorization: true },
  newRouteTargets: [],
}

/**
 * Mount the browser over a real terminal emulator.
 * @param rows - the emulator's height.
 * @returns the emulator, the overlay, the screen, and a repaint.
 */
function terminal(rows: number): {
  emulator: ReturnType<typeof createEmulator>
  overlay: ReturnType<typeof createConnectOverlay>
  screen: Screen
  draw: () => void
} {
  const emulator = createEmulator(COLUMNS, rows)
  const screen = new Screen(emulator.target)
  screen.commit(['TRANSCRIPT before connect A', 'TRANSCRIPT before connect B'])
  let overlay!: ReturnType<typeof createConnectOverlay>
  const draw = (): void => { screen.setLive(overlay.render(COLUMNS, rows)) }
  overlay = createConnectOverlay({
    state: () => STATE,
    refresh: () => {},
    act: () => {},
    now: () => NOW,
    close: () => {},
    invalidate: draw,
  })
  return { emulator, overlay, screen, draw }
}

describe('the Connect browser on a real terminal', () => {
  it.each([24, 14])('keeps a long directory inside a %i-row terminal', async rows => {
    const { emulator, overlay, draw } = terminal(rows)
    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)

    // Walk past the end of a list far longer than the window, twice over.
    for (let press = 0; press < 130; press += 1) {
      overlay.handleKey({ kind: 'key', name: 'down' })
      draw()
    }
    const screen = await emulator.screen()
    expect(screen.length).toBeLessThanOrEqual(rows)
    // The transcript committed before the browser opened is still exactly where
    // it was: an overlay may repaint the live region and nothing above it.
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT before connect A'))).toHaveLength(1)
  })

  it('leaves no rows behind when it closes', async () => {
    const { emulator, screen, draw } = terminal(24)
    draw()
    expect((await emulator.screen()).join('\n')).toContain('Connect')
    screen.setLive([])
    // Nothing the overlay drew survives, and the transcript it covered is still
    // in the terminal's own buffer, written once.
    expect((await emulator.screen()).join('\n')).not.toContain('Route 0')
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT before connect A'))).toHaveLength(1)
  })

  it('puts a sign-in page and code in scrollback, on lines of their own', async () => {
    // The whole reason a notice is committed rather than drawn in the overlay:
    // a person is about to select the URL and the code with a mouse, and the
    // live region scrolls them away while committed rows do not.
    const { emulator, screen, draw } = terminal(24)
    draw()
    screen.commit(noticeLines({
      message: 'Enter this code on the verification page to finish signing in.',
      url: 'https://auth.example/device',
      code: 'WXYZ-1234',
    }, 'ChatGPT (Codex)'))
    draw()
    const history = await emulator.scrollback()
    expect(history.some(line => line.trim() === 'https://auth.example/device')).toBe(true)
    expect(history.some(line => line.trim() === 'code WXYZ-1234')).toBe(true)
  })

  it('shows an escape sequence in a notice instead of obeying it', async () => {
    // A notice's message, page, and code come from a provider's login response.
    const { emulator, screen, draw } = terminal(24)
    draw()
    screen.commit(noticeLines({ message: 'open \u001b[2Jthis', url: 'https://x\u0007y' }, 'Flow'))
    draw()
    const history = (await emulator.scrollback()).join('\n')
    expect(history).toContain('^[[2J')
    expect(history).toContain('^G')
    // The frames before the notice survive, which they would not have if the
    // erase-display sequence had reached the terminal.
    expect(history).toContain('TRANSCRIPT before connect A')
  })
})

import { describe, expect, it } from 'vitest'
import { parseBootEvidence } from './consumer-smoke.mjs'

const VERSION = '0.7.1'

describe('parseBootEvidence()', () => {
  it('recognizes the banner and readiness in a cursor-addressed stream', () => {
    // Reconstructed from the audit's real capture: the renderer writes column
    // by column, so words arrive shattered across lines.
    const frame = [
      '\u001b[>1u',
      '●', 'r', 'e', 'a', 'd', 'y', '·',
      '╭', '─', 'c', 'o', 'n', 's', 'u', 'm', '─', '╮',
      'dshline', ' ', VERSION,
    ].join('\n')
    expect(parseBootEvidence(frame, VERSION)).toEqual({ sawBanner: true, sawReady: true })
  })

  it('strips escape sequences so redraw noise cannot fake or hide evidence', () => {
    const frame = '\u001b[2J\u001b[Hdshline 0.7.1\u001b[3;1fready'
    expect(parseBootEvidence(frame, VERSION)).toEqual({ sawBanner: true, sawReady: true })
  })

  it('stays incomplete while startup has not finished', () => {
    expect(parseBootEvidence('loading…\n', VERSION)).toEqual({ sawBanner: false, sawReady: false })
    expect(parseBootEvidence('ready\n', VERSION)).toEqual({ sawBanner: false, sawReady: true })
    expect(parseBootEvidence(`dshline ${VERSION}\n`, '')).toEqual({ sawBanner: false, sawReady: false })
  })

  it('refuses the wrong version: an old banner is not this bundle booting', () => {
    const frame = 'dshline 0.6.4 ready'
    expect(parseBootEvidence(frame, VERSION)).toEqual({ sawBanner: false, sawReady: true })
  })

  it('matches case-insensitively across shattered writes', () => {
    expect(parseBootEvidence('d s h l i n e   0 . 7 . 1', VERSION)).toEqual({ sawBanner: true, sawReady: false })
    expect(parseBootEvidence('DSHLINE READY', VERSION).sawReady).toBe(true)
  })
})

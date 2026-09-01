import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { observeUntilReady, parseBootEvidence } from './consumer-smoke.mjs'

const VERSION = '0.7.1'

/**
 * A fake booting process, standing in for `script(1)` running the real
 * launcher: it writes its own stdout directly (no file involved at all), so
 * these tests exercise exactly what `observeUntilReady` is documented to
 * rely on and cannot pass by accident from a file this fixture never writes.
 * @param script - inline Node source for the fake process to run.
 * @returns the spawned, fully piped child.
 */
function fakeBootingProcess(script) {
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Every fixture below exits on ctrl-d, the same key production quits with. */
const QUITS_ON_CTRL_D = `
  process.stdin.resume()
  process.stdin.on('data', (chunk) => { if (chunk.includes(4)) process.exit(0) })
`

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

describe('observeUntilReady()', () => {
  it('observes evidence from the process\'s own stdout, with no file involved', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ready')
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000)
    expect(result).toMatchObject({ code: 0, evidence: { sawBanner: true, sawReady: true } })
  })

  it('reacts to evidence as soon as it streams, rather than only at the boot timeout', async () => {
    // The exact bug this guards against: `tools/consumer-smoke.mjs` used to
    // read a file that could still be empty long after the terminal it
    // mirrors had already rendered "ready" — script(1)'s own stdout is not
    // buffered the way its mirrored file write is. This fixture writes late
    // on purpose and asserts the observer reacts near that delay, not near
    // the (much larger) boot timeout, which is what a periodic re-read of a
    // slow-to-flush file would look like instead.
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ')
      setTimeout(() => process.stdout.write('ready'), 50)
      ${QUITS_ON_CTRL_D}
    `)
    const started = Date.now()
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000)
    expect(result.evidence).toEqual({ sawBanner: true, sawReady: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('reports incomplete evidence rather than inventing it when the boot timeout elapses', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION}') // never writes "ready"
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 200, 2_000)
    expect(result).toMatchObject({ code: 0, evidence: { sawBanner: true, sawReady: false } })
  })

  it('answers a question when it appears, and reports what it answered', async () => {
    // The first-run confirmation is on the terminal, not in a file, and it has
    // to be answered when it shows rather than after a fixed wait — the same
    // reason the evidence is read from the pipe.
    const child = fakeBootingProcess(`
      process.stdout.write('set it up now? [Y/n] ')
      process.stdin.on('data', (chunk) => {
        if (String(chunk).includes('y')) process.stdout.write('dshline ${VERSION} ready')
      })
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000, [{ after: 'set it up now?', send: 'y\n' }])
    expect(result.replied).toEqual(['set it up now?'])
    expect(result).toMatchObject({ code: 0, evidence: { sawBanner: true, sawReady: true } })
  })

  it('reports an unanswered question rather than pretending it answered one', async () => {
    // What a wrapper that stopped asking would look like: the flow under test
    // never happened, and the run must say so instead of passing on a banner
    // that came from somewhere else.
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ready')
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000, [{ after: 'set it up now?', send: 'y\n' }])
    expect(result.replied).toEqual([])
  })

  it('matches a question split across writes, like everything else on a terminal', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('set it\\n')
      setTimeout(() => process.stdout.write('up now?\\n'), 20)
      process.stdin.on('data', () => process.stdout.write('dshline ${VERSION} ready'))
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000, [{ after: 'set it up now?', send: 'y\n' }])
    expect(result.replied).toEqual(['set it up now?'])
    expect(result.evidence).toEqual({ sawBanner: true, sawReady: true })
  })

  it('rejects when the process is killed instead of quitting cleanly', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ready')
      // Deliberately ignores ctrl-d and stays alive, so only the kill
      // timeout's SIGTERM can end this.
      setInterval(() => {}, 1_000)
    `)
    await expect(observeUntilReady(child, VERSION, 100, 100)).rejects.toThrow(/did not exit within/)
  })
})

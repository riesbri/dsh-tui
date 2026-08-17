import { describe, expect, it } from 'vitest'
import { box, boxHeight, displayWidth, fitToWidth, formatElapsed, formatTokens, spinnerFrame, stripAnsi, style } from '../src/index.ts'

describe('box()', () => {
  it('draws every row at exactly the requested width', () => {
    const lines = box(['hello'], { width: 20 })
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(displayWidth(line)).toBe(20)
  })

  it('keeps the right border aligned for CJK content', () => {
    // Measuring by string length instead of display columns is what pushes a
    // border out of true and makes a hand-rolled frame look broken.
    const lines = box(['标准模式'], { width: 20 })
    for (const line of lines) expect(displayWidth(line)).toBe(20)
    expect(lines[1]).toBe('│ 标准模式         │')
  })

  it('writes a title into the top border without changing the width', () => {
    const lines = box(['x'], { width: 24, title: 'dsh' })
    expect(stripAnsi(lines[0] ?? '')).toContain(' dsh ')
    expect(displayWidth(lines[0] ?? '')).toBe(24)
  })

  it('keeps the width exact when the title carries styling', () => {
    // Overlays style their titles; measuring the escape bytes as columns would
    // shorten the top border relative to every other framed element.
    const lines = box(['x'], { width: 40, title: style('Select a model', 'bold', 'yellow') })
    for (const line of lines) expect(displayWidth(line)).toBe(40)
  })

  it('wraps content that exceeds the inner width rather than clipping it', () => {
    const lines = box(['aaaa bbbb cccc'], { width: 12 })
    // Width 12 leaves 8 inner columns, so the text takes three rows.
    expect(lines).toHaveLength(5)
    expect(lines.map(line => displayWidth(line))).toEqual([12, 12, 12, 12, 12])
  })

  it('draws an empty content row rather than collapsing', () => {
    expect(box([], { width: 10 })).toHaveLength(3)
  })

  it('applies border styling only to the border', () => {
    const lines = box(['plain'], { width: 16, border: text => `<${text}>` })
    expect(lines[0]?.startsWith('<')).toBe(true)
    expect(lines[1]).toBe('<│> plain        <│>')
  })
})

describe('boxHeight()', () => {
  it('predicts the rendered height without rendering', () => {
    for (const content of [[], ['one'], ['aaaa bbbb cccc'], ['标准模式标准模式']]) {
      expect(boxHeight(content, 12)).toBe(box(content, { width: 12 }).length)
    }
  })
})

describe('fitToWidth()', () => {
  it('pads short content and truncates long content by display columns', () => {
    expect(fitToWidth('ab', 5)).toBe('ab   ')
    expect(fitToWidth('abcdef', 3)).toBe('abc')
    // Two ideographs fill four of five columns and the third cannot be halved,
    // so the shortfall is padded rather than left to shift a border.
    expect(fitToWidth('标准模式', 5)).toBe('标准 ')
    expect(displayWidth(fitToWidth('标准模式', 5))).toBe(5)
  })
})

describe('spinnerFrame()', () => {
  it('cycles and tolerates a negative tick', () => {
    expect(spinnerFrame(0)).toBe(spinnerFrame(10))
    expect(spinnerFrame(-5)).toBe(spinnerFrame(0))
    expect(displayWidth(spinnerFrame(3))).toBe(1)
  })
})

describe('formatElapsed()', () => {
  it('reads as seconds under a minute and minutes above', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(4200)).toBe('4s')
    expect(formatElapsed(64_000)).toBe('1m 04s')
    expect(formatElapsed(-1)).toBe('0s')
  })
})

describe('formatTokens()', () => {
  it('compacts thousands and millions', () => {
    expect(formatTokens(840)).toBe('840')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })
})

import { describe, expect, it } from 'vitest'
import { diffRows } from '../src/diff.ts'

/** Compact rendering of rows, so a diff reads as a diff in an assertion. */
function marked(oldText: string | null, newText: string): string[] {
  return diffRows(oldText, newText).map(row => `${{ context: ' ', add: '+', remove: '-' }[row.kind]}${row.text}`)
}

describe('diffRows()', () => {
  it('keeps unchanged lines between two separate edits as context', () => {
    // The reason this is not a shared prefix and suffix: reducing to affixes marks
    // everything BETWEEN two changes as removed and re-added, so an untouched
    // middle reads as changed and eats the card's row budget.
    expect(marked('a\nx\nkeep\ny\nz', 'a\nX\nkeep\nY\nz')).toEqual([
      ' a', '-x', '+X', ' keep', '-y', '+Y', ' z',
    ])
  })

  it('treats a create as all additions', () => {
    expect(marked(null, 'a\nb')).toEqual(['+a', '+b'])
  })

  it('treats clearing a file as all removals, inventing no added blank line', () => {
    // `''.split('\n')` is `['']`, so without normalising the empty image a cleared
    // file reported every real removal plus a spurious green blank.
    expect(marked('a\nb', '')).toEqual(['-a', '-b'])
  })

  it('treats a final newline as terminating the last line, not starting another', () => {
    // Every well-formed text file ends in a newline, so without this every `write`
    // drew a trailing blank addition.
    expect(marked(null, 'a\nb\n')).toEqual(['+a', '+b'])
    expect(marked('a\nb\n', 'a\nB\n')).toEqual([' a', '-b', '+B'])
  })

  it('treats a file of one empty line as empty', () => {
    expect(marked(null, '\n')).toEqual([])
  })

  it('reports nothing changed when both images match', () => {
    expect(diffRows('same\nlines', 'same\nlines').every(row => row.kind === 'context')).toBe(true)
  })

  it('shows a removal before the addition that replaces it', () => {
    expect(marked('old', 'new')).toEqual(['-old', '+new'])
  })

  it('handles an insertion with no removal', () => {
    expect(marked('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c'])
  })

  it('handles a deletion with no addition', () => {
    expect(marked('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c'])
  })

  it('mentions every line of both images exactly once', () => {
    const before = 'a\nb\nc\nd\ne'
    const after = 'a\nB\nc\nD\ne\nf'
    const rows = diffRows(before, after)
    const removed = rows.filter(row => row.kind !== 'add').map(row => row.text)
    const added = rows.filter(row => row.kind !== 'remove').map(row => row.text)
    expect(removed).toEqual(before.split('\n'))
    expect(added).toEqual(after.split('\n'))
  })

  it('falls back to affixes for images too large to compare exactly', () => {
    // The guard keeps a whole-file rewrite from allocating a matrix. The fallback is
    // exactly right for one contiguous change, which is the shape it will see.
    const before = `head\n${Array.from({ length: 2100 }, (_, i) => `line ${String(i)}`).join('\n')}\ntail`
    const after = `head\n${Array.from({ length: 2100 }, (_, i) => `other ${String(i)}`).join('\n')}\ntail`
    const rows = diffRows(before, after)
    expect(rows[0]).toEqual({ kind: 'context', text: 'head' })
    expect(rows.at(-1)).toEqual({ kind: 'context', text: 'tail' })
    expect(rows.filter(row => row.kind === 'remove')).toHaveLength(2100)
    expect(rows.filter(row => row.kind === 'add')).toHaveLength(2100)
  })
})

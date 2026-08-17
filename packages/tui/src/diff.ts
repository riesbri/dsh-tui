/**
 * Line diffs for a mutation card.
 *
 * A tool hands over a before and an after image of the text it changed, and the
 * card has to say which lines moved. Reducing that to a common prefix and suffix
 * is only correct when the change is contiguous: for a file with two separate
 * edits it marks everything BETWEEN them as removed and re-added, which is both
 * wrong and expensive — the untouched middle eats the card's row budget.
 *
 * A longest-common-subsequence diff keeps those interior lines as context. It
 * costs O(n×m) cells, so a size guard falls back to the prefix-and-suffix
 * approximation rather than allocating a matrix for a whole-file rewrite; the
 * fallback is exactly right for a single contiguous change, which is the shape a
 * fallback is most likely to see.
 * @module @deepseek-ai/dsh-tui/diff
 */

/** What happened to one line between the two images. */
export type DiffRowKind = 'context' | 'add' | 'remove'

/** One line of a rendered diff. */
export interface DiffRow {
  readonly kind: DiffRowKind
  readonly text: string
}

/**
 * Cells the matrix may occupy before the exact diff is abandoned.
 *
 * Four million is a few tens of megabytes of small integers and a fraction of a
 * second, which is well beyond any hunk a mutation tool produces and still far
 * short of a size that would stall the render.
 */
const MAX_CELLS = 4_000_000

/**
 * Split one image into lines.
 *
 * Two normalisations, both of them the difference between a line and a delimiter.
 * The empty string is zero lines rather than one empty line, so clearing a file
 * reports its removals and not a spurious added blank — `''.split('\n')` is
 * `['']`. And a final newline TERMINATES the last line rather than starting
 * another, so a normal text file does not report a trailing blank addition: every
 * `write` of well-formed content was drawing one.
 * @param text - one image of the text, or null for a file that did not exist.
 * @returns its lines.
 */
function toLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? [] : body.split('\n')
}

/**
 * Diff two images of a file into rows.
 * @param oldText - the before image, or null for a create or an overwrite where
 *   no before image was available.
 * @param newText - the after image.
 * @returns rows in file order; every line of both images appears exactly once.
 */
export function diffRows(oldText: string | null, newText: string): DiffRow[] {
  const before = toLines(oldText)
  const after = toLines(newText)
  if (before.length === 0) return after.map(text => ({ kind: 'add', text }))
  if (after.length === 0) return before.map(text => ({ kind: 'remove', text }))
  if (before.length * after.length > MAX_CELLS) return affixRows(before, after)
  return lcsRows(before, after)
}

/**
 * Diff by longest common subsequence, so unchanged interior lines stay context.
 * @param before - lines of the before image.
 * @param after - lines of the after image.
 * @returns rows in file order.
 */
function lcsRows(before: readonly string[], after: readonly string[]): DiffRow[] {
  // lengths[i][j] is the LCS length of before[i..] and after[j..]. Filling from
  // the end lets the walk below emit rows in file order without reversing.
  const width = after.length + 1
  const lengths = new Int32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = before[i] === after[j]
        ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0)
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'context', text: before[i] ?? '' })
      i += 1
      j += 1
      continue
    }
    // Prefer showing the removal first, so a changed line reads as `- old` then
    // `+ new` the way every diff a reader has seen does.
    if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      rows.push({ kind: 'remove', text: before[i] ?? '' })
      i += 1
      continue
    }
    rows.push({ kind: 'add', text: after[j] ?? '' })
    j += 1
  }
  for (; i < before.length; i += 1) rows.push({ kind: 'remove', text: before[i] ?? '' })
  for (; j < after.length; j += 1) rows.push({ kind: 'add', text: after[j] ?? '' })
  return rows
}

/**
 * Diff by shared prefix and suffix, for images too large to compare exactly.
 *
 * Correct for one contiguous change and an over-report for anything else, which
 * is the trade a fallback makes.
 * @param before - lines of the before image.
 * @param after - lines of the after image.
 * @returns rows in file order.
 */
function affixRows(before: readonly string[], after: readonly string[]): DiffRow[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1
  return [
    ...before.slice(0, head).map((text): DiffRow => ({ kind: 'context', text })),
    ...before.slice(head, before.length - tail).map((text): DiffRow => ({ kind: 'remove', text })),
    ...after.slice(head, after.length - tail).map((text): DiffRow => ({ kind: 'add', text })),
    ...before.slice(before.length - tail).map((text): DiffRow => ({ kind: 'context', text })),
  ]
}

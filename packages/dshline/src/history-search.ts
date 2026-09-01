/**
 * The `ctrl-r` search over this session's submitted input.
 *
 * A third owner beside the two that already exist, deliberately small: the
 * composer owns editable text and a cursor, `InputHistory` owns the
 * submitted lines and the up/down traversal, and this owns a query, the
 * positions it matched, and which of them is selected. Nothing here is durable
 * and nothing here is a second copy of the history — a match is a POSITION in
 * the history that produced it, so accepting one can hand the traversal back to
 * its true owner at the exact entry the reader picked.
 *
 * That indirection is the point rather than an optimisation. Two non-adjacent
 * submissions of the same text are different history entries; identifying a
 * result by its text would make `↑` after a recall continue from the wrong one.
 * @module dshline/history-search
 */

/**
 * The read-only corpus a search reads: this attachment's submitted input.
 *
 * Structural rather than the class itself, so the model is testable without an
 * `InputHistory` and so nothing here can reach the navigation cursor or
 * the saved draft. Entries are only ever appended, which is what makes
 * {@link SearchableHistory.size} usable as a revision token.
 */
export interface SearchableHistory {
  /** How many entries exist right now. */
  readonly size: number
  /**
   * One entry by its stable historical position.
   * @param index - the position, zero-based and oldest-first.
   * @returns the entry, or undefined when the position does not exist.
   */
  entry(index: number): string | undefined
}

/**
 * An incremental search over submitted input, newest match first.
 *
 * Matching is case-insensitive literal substring and nothing else: no fuzzy
 * subsequence, no token ranking, no prefix boost, no smart case, no recency
 * coefficient beyond the chronological order the history already has. A reader
 * who knows readline should be able to predict every result on the first try,
 * and every one of those refinements is a way for the list to disagree with
 * what they typed.
 */
export class HistorySearch {
  /** The corpus, snapshotted by position so a hit keeps its identity. */
  private entries: string[] = []
  /**
   * The same entries case-folded once per entry rather than once per keystroke.
   *
   * The whole per-keystroke cost is then one `includes` per entry, which is what
   * keeps a resumed session with thousands of turns instant: `ctrl-r` searches
   * submitted HUMAN input, so even a long session has few hundred of these.
   */
  private folded: string[] = []
  private text = ''
  /** Matching positions, newest first; the order the rows are drawn in. */
  private hits: number[] = []
  /** Which of {@link hits} is selected, as an index into it. */
  private at = 0

  /**
   * Snapshot the corpus and select its newest entry.
   * @param history - the submitted-input history to search.
   */
  constructor(private readonly history: SearchableHistory) {
    this.absorb()
    this.rescan()
  }

  /** The query as typed, unfolded and unescaped. */
  get query(): string {
    return this.text
  }

  /** Matching historical positions, newest first. */
  get matches(): readonly number[] {
    return this.hits
  }

  /** The selected historical position, or undefined when nothing matched. */
  get selected(): number | undefined {
    return this.hits[this.at]
  }

  /** The selected entry's text, or undefined when nothing matched. */
  get selectedText(): string | undefined {
    const index = this.selected
    return index === undefined ? undefined : this.entries[index]
  }

  /** The selection's one-based place among the matches; 0 when none matched. */
  get position(): number {
    return this.hits.length === 0 ? 0 : this.at + 1
  }

  /** How many entries were searched, which is 0 before a resume has seeded any. */
  get corpusSize(): number {
    return this.entries.length
  }

  /**
   * One entry of the snapshot, for a caller rendering a result row.
   * @param index - a historical position, normally one of {@link matches}.
   * @returns the entry, or undefined when the position is not in the snapshot.
   */
  entry(index: number): string | undefined {
    return this.entries[index]
  }

  /**
   * Take on entries the history gained since the last look.
   *
   * The one thing that makes `ctrl-r` pressed DURING a resume behave: the replay
   * seeds history from the durable log it was already reading, and the overlay
   * is redrawn when that lands, so re-reading the corpus here resolves the
   * query the reader has meanwhile typed. No timer, no polling, no second read
   * of the session — this is driven by the redraw the replay already causes.
   *
   * The selected POSITION survives where it still matches, so entries arriving
   * underneath a reader do not move the row they were aiming at.
   * @returns whether the corpus grew, and so whether the caller should redraw.
   */
  sync(): boolean {
    if (this.history.size === this.entries.length) return false
    const aimed = this.selected
    this.absorb()
    this.rescan()
    if (aimed === undefined) return true
    const found = this.hits.indexOf(aimed)
    if (found >= 0) this.at = found
    return true
  }

  /**
   * Extend the query, which narrows the current matches.
   *
   * Narrowing rather than rescanning is safe precisely because a longer needle
   * can only match where the shorter one did, and it is what keeps a fast typist
   * from paying for the whole corpus on every character.
   * @param text - characters to append; a paste should be collapsed first.
   */
  append(text: string): void {
    if (text === '') return
    this.text += text
    this.apply(this.hits)
  }

  /**
   * Delete the last code point of the query.
   *
   * Code points, not UTF-16 units, so one press deletes one character —
   * an emoji or a rare ideograph included, rather than half of one.
   */
  backspace(): void {
    if (this.text === '') return
    this.text = [...this.text].slice(0, -1).join('')
    this.rescan()
  }

  /** Clear the query, which puts the whole history back on screen. */
  clear(): void {
    if (this.text === '') return
    this.text = ''
    this.rescan()
  }

  /**
   * Delete the query's last word.
   *
   * Trailing whitespace first and then the word, which is the composer's own
   * `ctrl-w` rule rather than the shared picker's: the query row is a field the
   * reader edits with the keys they edit a prompt with, and a `ctrl-w` that
   * spent one press on the space they had just typed would read as a no-op.
   */
  deleteWord(): void {
    const next = this.text.replace(/\s+$/u, '').replace(/\S+$/u, '')
    if (next === this.text) return
    this.text = next
    this.rescan()
  }

  /**
   * Select the next OLDER match, which is what a second `ctrl-r` asks for.
   *
   * Nothing happens at the oldest match rather than wrapping to the newest,
   * matching what `InputHistory.previous` already does: reaching the end
   * of a list must not silently move the reader back to its start.
   * @returns whether the selection moved.
   */
  older(): boolean {
    if (this.at + 1 >= this.hits.length) return false
    this.at += 1
    return true
  }

  /**
   * Select the next NEWER match.
   * @returns whether the selection moved.
   */
  newer(): boolean {
    if (this.at === 0) return false
    this.at -= 1
    return true
  }

  /**
   * Select the newest match.
   * @returns whether the selection moved.
   */
  first(): boolean {
    if (this.at === 0) return false
    this.at = 0
    return true
  }

  /**
   * Select the oldest match.
   * @returns whether the selection moved.
   */
  last(): boolean {
    const end = this.hits.length - 1
    if (end < 0 || this.at === end) return false
    this.at = end
    return true
  }

  /** Copy positions the corpus has gained, folding each exactly once. */
  private absorb(): void {
    for (let index = this.entries.length; index < this.history.size; index += 1) {
      const entry = this.history.entry(index)
      if (entry === undefined) break
      this.entries.push(entry)
      // `toLowerCase`, not `toLocaleLowerCase`: a search whose results depend on
      // the machine's locale is one a reader cannot predict, and the Turkish
      // dotless-i rule alone would make `I` stop matching `investigate`.
      this.folded.push(entry.toLowerCase())
    }
  }

  /** Rescan every entry, for a query that did not merely grow. */
  private rescan(): void {
    const all: number[] = []
    for (let index = this.entries.length - 1; index >= 0; index -= 1) all.push(index)
    this.apply(all)
  }

  /**
   * Keep the candidates whose entry contains the query, newest first.
   * @param candidates - positions to test, already in newest-first order.
   */
  private apply(candidates: readonly number[]): void {
    const needle = this.text.toLowerCase()
    this.hits = needle === ''
      ? [...candidates]
      : candidates.filter(index => (this.folded[index] ?? '').includes(needle))
    // Every query edit re-aims at the newest match. Holding the old position
    // would leave the reader looking at an arbitrary row of a list they just
    // replaced, and there is no honest way to carry a selection across a
    // narrowing that may have removed it.
    this.at = 0
  }
}

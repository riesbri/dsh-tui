/**
 * Inline completion for `/commands` and `@file` paths.
 *
 * Deliberately NOT an overlay. An overlay owns the keyboard, and completion has to
 * coexist with typing: the list narrows as characters arrive, and every key that
 * is not a completion gesture belongs to the composer. So this is a slot view plus
 * a key filter the runner consults first, and it disappears the moment the text
 * under the cursor stops looking like a completable token.
 *
 * What is completable is decided from the text BEHIND the cursor only. Completing
 * against text ahead of it would rewrite characters the user did not ask about, and
 * a token is not finished until the cursor leaves it.
 * @module @riesbri/dsh-tui/completion
 */

import type { Composer, Key } from '@riesbri/dsh-tui-renderer'
import { escapeControls, style, truncateToWidth } from '@riesbri/dsh-tui-renderer'
import type { TuiSlotView } from './slots.ts'
import { chromeWidth } from './views.ts'

/** Rows of the list shown at once. */
const VISIBLE_ROWS = 6

/** Marker on the highlighted row. */
const CURSOR = '›'

/**
 * A candidate.
 *
 * `replace` is what the token becomes, complete with its sigil, so accepting is a
 * substitution rather than an assembly the caller has to get right.
 */
export interface Candidate {
  /** The full replacement for the typed token. */
  readonly replace: string
  /** What the row shows. */
  readonly label: string
  /** Optional trailing note, dimmed. */
  readonly note?: string
}

/** Where candidates come from, so the engine holds no opinion about the harness. */
export interface CompletionSources {
  /**
   * Commands available right now, for a line that begins with a slash.
   * @returns the command names, without their leading slash, and their summaries.
   */
  commands(): readonly { readonly name: string; readonly description: string }[]
  /**
   * Directory children for a path completion.
   * @param directory - the directory to list, relative to the workspace, or empty
   *   for the workspace root.
   * @returns each child's name and whether it is itself a directory.
   * @throws nothing a caller must handle; an unreadable directory yields no entries.
   */
  paths(directory: string): Promise<readonly { readonly name: string; readonly directory: boolean }[]>
}

/** The token under the cursor, and which kind of completion it wants. */
interface Token {
  readonly kind: 'command' | 'path'
  /** The typed text including its sigil. */
  readonly text: string
}

/**
 * The completable token behind the cursor, or nothing.
 *
 * A slash completes only as the FIRST thing on its line: `/help` is a command and
 * `see /etc/hosts` is a path, and the difference is the position. An `@` completes
 * anywhere, because a file mention belongs mid-sentence.
 * @param before - the cursor's own line, up to the cursor.
 * @returns the token, or undefined when nothing behind the cursor is completable.
 */
function tokenAt(before: string): Token | undefined {
  if (/^\/[^\s/]*$/u.test(before)) return { kind: 'command', text: before }
  const mention = /(?:^|\s)(@[^\s]*)$/u.exec(before)
  if (mention?.[1] !== undefined) return { kind: 'path', text: mention[1] }
  return undefined
}

/**
 * Split a path token into the directory to list and the prefix to match.
 * @param token - the token including its `@`.
 * @returns the directory, and the last segment being typed.
 */
function splitPath(token: string): { directory: string; prefix: string } {
  const path = token.slice(1)
  const cut = path.lastIndexOf('/')
  if (cut < 0) return { directory: '', prefix: path }
  return { directory: path.slice(0, cut), prefix: path.slice(cut + 1) }
}

/** Live completion state for one composer. */
export interface Completion {
  /** The slot view; contributes nothing while no candidates are offered. */
  readonly view: TuiSlotView
  /**
   * Recompute from the composer's current text. Async because a path completion
   * reads a directory.
   * @returns nothing; call the runner's redraw afterwards.
   */
  refresh(): Promise<void>
  /** Whether candidates are being offered, and so whether keys are intercepted. */
  readonly active: boolean
  /**
   * Offer one keystroke to the completion.
   * @param key - the decoded keystroke.
   * @returns whether the completion consumed it.
   */
  handleKey(key: Key): boolean
  /** Stop offering candidates until the next refresh finds some. */
  dismiss(): void
}

/**
 * Wire completion to a composer.
 * @param composer - the buffer being edited; accepting a candidate rewrites it.
 * @param sources - where candidates come from.
 * @param invalidate - asks the runner to redraw.
 * @returns the live completion state.
 */
export function createCompletion(
  composer: Composer,
  sources: CompletionSources,
  invalidate: () => void,
): Completion {
  let candidates: readonly Candidate[] = []
  let token: Token | undefined
  let cursor = 0
  /** Set when the user dismisses, and cleared as soon as the token changes. */
  let dismissedFor: string | undefined
  /**
   * Guards against a slow directory read landing after the text moved on.
   * Without it, typing quickly shows candidates for a prefix already replaced.
   */
  let generation = 0

  const clear = (): void => {
    candidates = []
    token = undefined
    cursor = 0
  }

  const accept = (candidate: Candidate): void => {
    if (token === undefined) return
    composer.replaceBeforeCursor([...token.text].length, candidate.replace)
    clear()
    // A directory is a waypoint rather than an answer, so the list reopens on it
    // and the next segment can be completed without retyping the separator.
    void refresh().then(invalidate)
  }

  const refresh = async (): Promise<void> => {
    const found = tokenAt(composer.lineBeforeCursor)
    if (found === undefined) {
      dismissedFor = undefined
      clear()
      return
    }
    if (dismissedFor === found.text) return
    dismissedFor = undefined
    const mine = generation + 1
    generation = mine
    const next = found.kind === 'command'
      ? commandCandidates(found.text, sources)
      : await pathCandidates(found.text, sources)
    // A newer refresh started while this one was reading a directory.
    if (generation !== mine) return
    token = next.length === 0 ? undefined : found
    candidates = next
    cursor = 0
  }

  return {
    view: {
      render(columns) {
        if (candidates.length === 0) return []
        const width = chromeWidth(columns)
        const start = Math.min(
          Math.max(0, cursor - VISIBLE_ROWS + 1),
          Math.max(0, candidates.length - VISIBLE_ROWS),
        )
        const shown = candidates.slice(start, start + VISIBLE_ROWS)
        const rows = shown.map((candidate, index) => {
          const selected = start + index === cursor
          const mark = selected ? style(CURSOR, 'cyan') : ' '
          const label = selected
            ? style(escapeControls(candidate.label), 'cyan', 'bold')
            : escapeControls(candidate.label)
          const note = candidate.note === undefined
            ? ''
            : ` ${style(escapeControls(candidate.note), 'gray')}`
          return `  ${mark} ${truncateToWidth(`${label}${note}`, Math.max(8, width - 4))}`
        })
        const hidden = candidates.length - shown.length
        if (hidden > 0) rows.push(`    ${style(`… ${String(hidden)} more`, 'gray')}`)
        rows.push(`    ${style('tab complete · esc dismiss', 'gray')}`)
        return rows
      },
    },
    get active() {
      return candidates.length > 0
    },
    refresh,
    handleKey(key) {
      if (candidates.length === 0 || key.kind !== 'key') return false
      switch (key.name) {
        case 'up':
          cursor = (cursor - 1 + candidates.length) % candidates.length
          return true
        case 'down':
          cursor = (cursor + 1) % candidates.length
          return true
        case 'tab': {
          const candidate = candidates[cursor]
          if (candidate !== undefined) accept(candidate)
          return true
        }
        case 'escape':
          // Remembered against the token, so dismissing hides the list for THIS
          // word rather than until the next unrelated keystroke reopens it.
          dismissedFor = token?.text
          clear()
          return true
        default:
          // Every other key is the composer's. `enter` in particular: a completion
          // list must never swallow a submission.
          return false
      }
    },
    dismiss() {
      dismissedFor = token?.text
      clear()
    },
  }
}

/**
 * Commands whose name starts with what was typed.
 * @param token - the typed token, including its leading slash.
 * @param sources - where commands come from.
 * @returns the matching candidates, in the registry's order.
 */
function commandCandidates(token: string, sources: CompletionSources): Candidate[] {
  const prefix = token.slice(1).toLowerCase()
  return sources.commands()
    .filter(command => command.name.toLowerCase().startsWith(prefix))
    .map(command => ({
      replace: `/${command.name} `,
      label: `/${command.name}`,
      ...command.description === '' ? {} : { note: command.description },
    }))
}

/**
 * Directory children matching the segment being typed.
 *
 * Directories sort first and keep their separator, so the next segment continues
 * from where the cursor already is. A leading dot is offered only when one was
 * typed: a completion list is not the place to volunteer `.git`.
 * @param token - the typed token, including its leading `@`.
 * @param sources - where paths come from.
 * @returns the matching candidates.
 */
async function pathCandidates(token: string, sources: CompletionSources): Promise<Candidate[]> {
  const { directory, prefix } = splitPath(token)
  const entries = await sources.paths(directory)
  const lower = prefix.toLowerCase()
  const matched = entries.filter(entry => {
    if (!entry.name.toLowerCase().startsWith(lower)) return false
    return !entry.name.startsWith('.') || prefix.startsWith('.')
  })
  const ordered = [...matched].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return ordered.map(entry => {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`
    return {
      replace: entry.directory ? `@${path}/` : `@${path} `,
      label: entry.directory ? `${path}/` : path,
    }
  })
}

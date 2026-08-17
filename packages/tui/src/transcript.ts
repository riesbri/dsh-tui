/**
 * Session events to terminal lines.
 *
 * The session log is the source of truth for everything the model saw, so the
 * transcript is a projection of it rather than a record the frontend keeps in
 * parallel. Each committed event becomes lines that are written once into
 * scrollback and never revisited; the streaming reply is the only mutable part
 * and lives in the live region until its `assistant/message` commits it.
 *
 * Every string reaching here came from a model, a tool, or a log, so every
 * string is escaped before it is returned.
 * @module @riesbri/dsh-tui/transcript
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { escapeControls, hangingIndent, style } from '@riesbri/dsh-tui-renderer'

/** Gutter marks, chosen so a glance separates who produced a line. */
const MARK = {
  user: '›',
  error: '✗',
  note: '·',
} as const

/**
 * Concatenate the text of every text block, dropping non-text blocks.
 * @param content - message content blocks.
 * @returns the joined text, empty when the message carries none.
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Prefix the first row with `mark` and indent every later row to match, so a
 * multi-line message reads as one block however wide the terminal is.
 * @param mark - the gutter mark, without its trailing space.
 * @param text - already-escaped text, may contain newlines.
 * @param columns - the terminal's current width.
 * @returns the marked rows.
 */
function marked(mark: string, text: string, columns: number): string[] {
  return text.split('\n').flatMap((line, index) => hangingIndent(index === 0 ? `${mark} ` : '  ', '  ', line, columns))
}

/**
 * Project one committed session event to lines, or nothing when the event has no
 * terminal representation.
 *
 * Unrecognized event types return nothing rather than throwing: `SessionEventMap`
 * is merge-extensible, so any plugin may add a type this frontend has never seen,
 * and a frontend that failed on one would break the moment a deployment mounted
 * an unfamiliar plugin.
 * @param event - the committed event.
 * @param columns - the terminal's current width.
 * @returns lines to commit to scrollback.
 */
export function projectEvent(event: SessionEvent, columns: number): string[] {
  switch (event.type) {
    case 'user/message': {
      // Only direct human prompts are echoed: synthetic injections (file-change
      // notices, skill bodies, nested AGENTS.md) are model-visible context the
      // user did not type, and echoing them buries the conversation.
      const data = event.data as { content: readonly ContentBlock[]; source?: { kind?: string } }
      if (data.source?.kind !== 'user') return []
      const text = textOf(data.content).trim()
      if (text === '') return []
      // A rule above each prompt separates exchanges in a long scrollback.
      const rule = style('─'.repeat(Math.max(4, Math.min(columns - 2, 100))), 'gray')
      return ['', rule, ...marked(style(MARK.user, 'cyan', 'bold'), escapeControls(text), columns)]
    }
    case 'turn/end': {
      const data = event.data as { reason: { kind: string; error?: { code: string; message: string } } }
      switch (data.reason.kind) {
        case 'error': {
          if (data.reason.error === undefined) return []
          const { code, message } = data.reason.error
          return ['', style(`${MARK.error} ${escapeControls(code)}: ${escapeControls(message)}`, 'red')]
        }
        // `aborted`, not `canceled`: the tag comes from `TurnEndReasonMap`, and a
        // frontend testing for a name the harness never emits reports nothing at
        // all, so a ctrl-c that visibly stopped a reply left no mark saying why.
        case 'aborted':
          return ['', style(`${MARK.note} interrupted`, 'yellow')]
        // The reply hit the output ceiling and stops mid-sentence. Saying so is the
        // difference between a truncated answer and one that looks finished.
        case 'max-tokens':
          return ['', style(`${MARK.note} reply reached the output limit`, 'yellow')]
        case 'blocked':
          return ['', style(`${MARK.note} blocked before the model was called`, 'yellow')]
        default:
          // `completed` needs no note, and the map is merge-extensible: a reason a
          // plugin adds that this frontend has never seen is not an error.
          return []
      }
    }
    default:
      return []
  }
}

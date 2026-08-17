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
import { escapeControls, renderMarkdown, style, truncateToWidth } from '@riesbri/dsh-tui-renderer'

/** Columns of a tool result shown before it is elided. */
const RESULT_PREVIEW_LINES = 6

/** Gutter marks, chosen so a glance separates who produced a line. */
const MARK = {
  user: '›',
  assistant: '●',
  tool: '⏺',
  result: '⎿',
  error: '✗',
  note: '·',
} as const

/**
 * The text a tool result carries.
 *
 * A `ToolResultMessage`'s content is a single `tool-result` block whose OWN
 * `content` holds the model-facing blocks, so reading the message's content for
 * text blocks finds none and renders every result as empty.
 * @param content - the tool-result message's content.
 * @returns the joined text of the inner blocks.
 */
function toolResultText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    .map(block => textOf(block.content))
    .join('')
}

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
 * Prefix the first line with `mark` and indent continuations to match, so a
 * multi-line message reads as one block.
 * @param mark - the gutter mark.
 * @param text - already-escaped text, may contain newlines.
 * @returns the marked lines.
 */
function marked(mark: string, text: string): string[] {
  const lines = text.split('\n')
  return lines.map((line, index) => (index === 0 ? `${mark} ${line}` : `  ${line}`))
}

/**
 * A one-line summary of a tool call's arguments.
 *
 * The raw `arguments` string is the model's unparsed JSON, which may be
 * malformed — the harness logs it verbatim precisely so a bad call is
 * reconstructable. Unparseable JSON is therefore summarized as-is rather than
 * treated as an error.
 * @param raw - the logged arguments string.
 * @param columns - width budget for the summary.
 * @returns the summary, empty when there is nothing worth showing.
 */
function summarizeArguments(raw: string, columns: number): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Malformed model JSON: show the head of what actually arrived.
    return truncateToWidth(escapeControls(raw), columns)
  }
  if (typeof parsed !== 'object' || parsed === null) return truncateToWidth(escapeControls(raw), columns)
  const parts = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
    return `${key}=${rendered}`
  })
  return truncateToWidth(escapeControls(parts.join(' ')), columns)
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
      return ['', rule, ...marked(style(MARK.user, 'cyan', 'bold'), escapeControls(text))]
    }
    case 'assistant/message': {
      const data = event.data as { message: { content: readonly ContentBlock[] } }
      const text = textOf(data.message.content).trim()
      if (text === '') return []
      // renderMarkdown escapes every span it emits, so the reply is NOT passed
      // through escapeControls again — that would neutralise the styling it just
      // produced along with the control characters it already removed.
      const rendered = renderMarkdown(text)
      const [first = '', ...rest] = rendered
      return ['', `${style(MARK.assistant, 'green')} ${first}`, ...rest.map(line => `  ${line}`)]
    }
    case 'tool/call': {
      const data = event.data as { name: string; arguments: string }
      const summary = summarizeArguments(data.arguments, Math.max(10, columns - data.name.length - 6))
      const head = style(escapeControls(data.name), 'bold')
      return ['', `${style(MARK.tool, 'blue')} ${head}${summary === '' ? '' : ` ${style(summary, 'dim')}`}`]
    }
    case 'tool/result': {
      const data = event.data as {
        message: { content: readonly ContentBlock[] }
        error?: { code: string; name: string }
      }
      if (data.error !== undefined) {
        return [`  ${style(MARK.result, 'gray')} ${style(escapeControls(data.error.code), 'red')}`]
      }
      const text = toolResultText(data.message.content).trim()
      if (text === '') return []
      const lines = escapeControls(text).split('\n')
      const budget = Math.max(10, columns - 6)
      // The first result line carries the gutter and the rest align under it, so
      // a multi-line result reads as one block hanging off its call.
      const shown = lines.slice(0, RESULT_PREVIEW_LINES).map((line, index) => (index === 0
        ? `  ${style(MARK.result, 'gray')} ${style(truncateToWidth(line, budget), 'dim')}`
        : `    ${style(truncateToWidth(line, budget), 'dim')}`))
      if (lines.length > RESULT_PREVIEW_LINES) {
        shown.push(`    ${style(`… ${String(lines.length - RESULT_PREVIEW_LINES)} more lines`, 'gray')}`)
      }
      return shown
    }
    case 'turn/end': {
      const data = event.data as { reason: { kind: string; error?: { code: string; message: string } } }
      if (data.reason.kind === 'error' && data.reason.error !== undefined) {
        const { code, message } = data.reason.error
        return ['', style(`${MARK.error} ${escapeControls(code)}: ${escapeControls(message)}`, 'red')]
      }
      if (data.reason.kind === 'canceled') return ['', style(`${MARK.note} canceled`, 'yellow')]
      return []
    }
    default:
      return []
  }
}

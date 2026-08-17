/**
 * The assistant's own output: reasoning, then reply, as it arrives.
 *
 * This module owns every line the assistant produces, both the streamed form and
 * the committed one, because they are the same text and only one of them may
 * reach the screen. A reply arrives as deltas, is written into scrollback one
 * completed line at a time, and only its unfinished trailing line stays in the
 * live region. `assistant/message` then contributes what streaming could not
 * have shown — the last partial line, or the whole reply from a provider that
 * does not stream at all.
 *
 * Committing as lines complete is what keeps the cost flat. Holding the whole
 * reply live meant re-escaping, re-splitting, and retransmitting all of it on
 * every delta, so an 11 KB answer cost 2.6 MB of terminal writes and grew
 * quadratically; a completed line is written once and never revisited, and the
 * live region stays one unfinished line regardless of how long the answer runs.
 *
 * Every string here came from a model, so every string is escaped before it is
 * returned. Reasoning and reply are separate channels because they are separate
 * content: the model's own working notes are styled apart from its answer, and
 * emitting the first reply delta is what marks the reasoning finished.
 * @module @riesbri/dsh-tui/stream
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MarkdownRenderer } from '@riesbri/dsh-tui-renderer'
import { createMarkdownRenderer, escapeControls, style, wrapToWidth } from '@riesbri/dsh-tui-renderer'

/**
 * The two kinds of assistant output, in the order a model emits them.
 *
 * `reasoning` arrives first when the model produces any, and the first `text`
 * delta is the signal that it stopped — the log carries no separate marker.
 */
export type StreamChannel = 'reasoning' | 'text'

/**
 * Rows of the unfinished line kept in the live region.
 *
 * The live region is redrawn by climbing rows, so it must stay shorter than the
 * screen: a region taller than the terminal leaves the cursor unable to reach its
 * first row, which corrupts every later redraw. One logical line can still wrap
 * past this, so it is shown from its end — the interesting part while text is
 * being appended is the part that just arrived.
 */
const LIVE_ROWS = 4

/** Narrowest live-region body worth wrapping to, for a very narrow terminal. */
const MIN_LIVE_COLUMNS = 8

/** Marks the elision when the unfinished line is longer than the live region. */
const ELLIPSIS = '…'

/** Gutter marks: one for the model's working notes, one for its answer. */
const MARK = {
  reasoning: '✻',
  text: '●',
} as const

/** Gutter for a continuation row, aligning it under the mark. */
const CONTINUATION = '  '

/** What one channel has produced so far. */
interface ChannelState {
  /**
   * Everything pushed on this channel, kept to compare against the assembled
   * message: the remainder beyond it is what has not been shown yet.
   */
  pushed: string
  /** The unfinished trailing line, which has not been committed. */
  pending: string
  /** Whether this channel's gutter mark has already been written. */
  opened: boolean
  /** Block state, so a fenced block spanning committed lines stays a code block. */
  markdown: MarkdownRenderer
}

/** A fresh, empty channel. */
function emptyChannel(): ChannelState {
  return { pushed: '', pending: '', opened: false, markdown: createMarkdownRenderer() }
}

/**
 * The text of every block of one type, concatenated.
 * @param content - message content blocks.
 * @param type - the block type to keep.
 * @returns the joined text, empty when the message carries no such block.
 */
function textOfType(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' | 'reasoning' }> => block.type === type)
    .map(block => block.text)
    .join('')
}

/**
 * Accumulates one assistant turn's output and hands back lines to commit.
 *
 * One instance spans one turn: {@link reset} returns it to its initial state, and
 * a turn that ends without an assembled message — an abort — still commits what
 * the user already watched arrive, via {@link finish}.
 */
export class StreamBuffer {
  private readonly channels: Record<StreamChannel, ChannelState> = {
    reasoning: emptyChannel(),
    text: emptyChannel(),
  }

  /** The channel currently receiving deltas, or none before the first one. */
  private current: StreamChannel | undefined

  /**
   * Take one delta and return whatever it completed.
   *
   * Only whole lines are committed. A delta that adds no newline changes the live
   * region alone, which is the common case and costs one short redraw.
   * @param channel - which kind of output this delta belongs to.
   * @param delta - the text fragment, exactly as the model sent it.
   * @returns lines to write into scrollback, in order.
   */
  push(channel: StreamChannel, delta: string): string[] {
    const out: string[] = []
    // A delta on a new channel means the previous one is finished: the model
    // stopped reasoning the moment it began answering.
    if (this.current !== undefined && this.current !== channel) out.push(...this.flush(this.current))
    this.current = channel
    const state = this.channels[channel]
    state.pushed += delta
    state.pending += delta
    const cut = state.pending.lastIndexOf('\n')
    if (cut < 0) return out
    const complete = state.pending.slice(0, cut)
    state.pending = state.pending.slice(cut + 1)
    out.push(...this.emit(channel, complete.split('\n')))
    return out
  }

  /**
   * Commit whatever the assembled message adds beyond what streamed.
   *
   * The message is the authority, and what streamed is a prefix of it by
   * construction — the assembler concatenates the same deltas this buffer
   * received. So only the remainder is new, which for a streamed reply is its
   * last unterminated line and for a provider that does not stream is the whole
   * thing. If the two forms are not in that relationship the assembled form is
   * committed whole: the lines already on screen cannot be taken back, and a
   * duplicated reply is something a reader can see past, while a dropped one is
   * invisible.
   * @param content - the assembled assistant message's content blocks.
   * @returns lines to write into scrollback, reasoning before reply.
   */
  settle(content: readonly ContentBlock[]): string[] {
    return [
      ...this.settleChannel('reasoning', textOfType(content, 'reasoning')),
      ...this.settleChannel('text', textOfType(content, 'text')),
    ]
  }

  /**
   * Commit every unfinished line, for a turn that produced no assembled message.
   *
   * An aborted turn is the case that matters: the loop throws on the abort signal
   * before appending a message, so without this the reply the user watched arrive
   * would be dropped at the exact moment they interrupted it.
   * @returns lines to write into scrollback.
   */
  finish(): string[] {
    return [...this.flush('reasoning'), ...this.flush('text')]
  }

  /** Return to the initial state, discarding channel and block state. */
  reset(): void {
    this.channels.reasoning = emptyChannel()
    this.channels.text = emptyChannel()
    this.current = undefined
  }

  /**
   * The live-region rows for the unfinished line, or none when there is none.
   *
   * While a turn is running this is the only moving part of the screen, so it is
   * deliberately small: everything already complete is in scrollback, above and
   * behind it.
   * @param columns - the terminal's current width.
   * @returns rows for the live region.
   */
  live(columns: number): string[] {
    const channel = this.current
    if (channel === undefined) return []
    const state = this.channels[channel]
    if (state.pending === '') return []
    const budget = Math.max(MIN_LIVE_COLUMNS, columns - CONTINUATION.length)
    // Cut the source before wrapping. A reply that never emits a newline would
    // otherwise make each redraw cost the whole reply again, which is the
    // quadratic term this class exists to remove; two columns per character is
    // the widest any character gets, so this keeps every row that can be shown.
    const visible = state.pending.slice(-budget * LIVE_ROWS)
    const escaped = escapeControls(visible)
    const rows = wrapToWidth(channel === 'reasoning' ? style(escaped, 'dim', 'italic') : escaped, budget)
    const shown = rows.slice(-LIVE_ROWS)
    const elided = shown.length < rows.length || visible.length < state.pending.length
    const [first = '', ...rest] = shown
    const head = state.opened ? CONTINUATION : `${style(MARK[channel], channel === 'reasoning' ? 'gray' : 'green')} `
    return [
      // The blank spacer belongs to the mark: once the mark is committed, the
      // live rows continue lines directly above them and must stay attached.
      ...state.opened ? [] : [''],
      `${head}${elided ? style(ELLIPSIS, 'gray') : ''}${first}`,
      ...rest.map(row => `${CONTINUATION}${row}`),
    ]
  }

  /**
   * Commit one channel's remainder against the assembled text.
   * @param channel - the channel to settle.
   * @param full - the assembled text for that channel, possibly empty.
   * @returns lines to write into scrollback.
   */
  private settleChannel(channel: StreamChannel, full: string): string[] {
    const state = this.channels[channel]
    if (full === '' && state.pending === '') return []
    if (!full.startsWith(state.pushed)) {
      // The forms diverged, so nothing about the streamed copy can be trusted to
      // align: render the assembled text from the start, with its own block state.
      state.markdown = createMarkdownRenderer()
      state.pending = ''
      state.pushed = full
      return this.emit(channel, full.trim().split('\n'))
    }
    const remainder = state.pending + full.slice(state.pushed.length)
    state.pushed = full
    state.pending = ''
    // A reply commonly ends in a newline, and trailing blank lines would push the
    // composer down for nothing. Leading whitespace is only trimmed when nothing
    // streamed, because otherwise it was already committed as it arrived.
    const body = state.opened ? remainder.replace(/\s+$/u, '') : remainder.trim()
    if (body === '') return []
    return this.emit(channel, body.split('\n'))
  }

  /**
   * Commit a channel's unfinished line, if it has one.
   * @param channel - the channel to flush.
   * @returns lines to write into scrollback.
   */
  private flush(channel: StreamChannel): string[] {
    const state = this.channels[channel]
    if (state.pending === '') return []
    const pending = state.pending
    state.pending = ''
    return this.emit(channel, [pending])
  }

  /**
   * Style and gutter complete source lines.
   * @param channel - the channel they belong to.
   * @param sources - complete source lines, without newlines.
   * @returns lines to write into scrollback.
   */
  private emit(channel: StreamChannel, sources: readonly string[]): string[] {
    const state = this.channels[channel]
    const rendered = sources.flatMap(source => (channel === 'reasoning'
      // Reasoning is the model's working notes, not its answer: it is shown as
      // written, quietly, and never parsed as markdown — a half-formed thought is
      // not a document, and styling it like one competes with the reply.
      ? [style(escapeControls(source), 'dim', 'italic')]
      : state.markdown.line(source)))
    if (rendered.length === 0) return []
    const out: string[] = []
    for (const line of rendered) {
      if (state.opened) {
        out.push(`${CONTINUATION}${line}`)
        continue
      }
      state.opened = true
      out.push('', `${style(MARK[channel], channel === 'reasoning' ? 'gray' : 'green')} ${line}`)
    }
    return out
  }
}

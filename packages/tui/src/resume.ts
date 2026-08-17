/**
 * Reopening a past session.
 *
 * Two halves that are easy to conflate. Resuming the AGENT is one harness call —
 * `ctx.agents.resume` needs only the session id, and takes the workspace from the
 * persisted header. Rebuilding the TRANSCRIPT is this module's real work, and the
 * rule that matters is which events it replays.
 *
 * NOT the model-visible surface. `foldSurface` deliberately shadows ranges that a
 * compaction replaced, so folding it would erase conversation the user already
 * read — the reply is gone from the model's history but it was still said. The
 * durable source for a human transcript is append-origin events, which is what
 * `isAppendSurfaceEvent` narrows to.
 *
 * That narrowing covers only the three surface types, so tool CALLS would be
 * dropped with it — and a result card needs its call's arguments to render. The
 * rule is therefore stated the other way round: a surface-eligible event replays
 * only when it was an append, and everything else replays as it is.
 * @module @riesbri/dsh-tui/resume
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Terminal } from '@riesbri/dsh-tui-renderer'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { style } from '@riesbri/dsh-tui-renderer'
import { createSelectOverlay } from './select.ts'
import type { SelectChoice } from './select.ts'

/** Sessions offered in the picker, newest first. */
const PICKER_LIMIT = 20

/** Characters of a title shown in the picker before it is cut. */
const TITLE_COLUMNS = 60

/**
 * Whether an event belongs in a human transcript.
 *
 * A replacement copy is model-only: it exists so a compacted history still reads
 * correctly to the model, and replaying it would show the user a summary in place
 * of the exchange it summarised. Everything that is not surface-eligible — a tool
 * call, a turn ending — has no replacement semantics and simply replays.
 * @param event - one raw log event.
 * @returns whether to project it.
 */
export function isTranscriptEvent(event: SessionEvent): boolean {
  // Chunks are excluded separately from the surface question: they are the
  // streamed form of a reply whose assembled form is also in the log, so replaying
  // both would print it twice.
  if (event.type === 'assistant/chunk') return false
  if (!isSurfaceEvent(event)) return true
  return isAppendSurfaceEvent(event)
}

/** One past session as the picker shows it. */
export interface Past {
  readonly id: SessionId
  readonly title: string
  readonly createdAt: number
  readonly cwd: string | undefined
}

/**
 * How long ago, in the coarsest unit that is still informative.
 * @param at - a timestamp in milliseconds.
 * @param now - the current time in milliseconds.
 * @returns a short relative description.
 */
function since(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  return `${String(Math.round(hours / 24))}d ago`
}

/**
 * The most recent sessions, with their titles.
 * @param ctx - context carrying the session query engine.
 * @returns the sessions, newest first, or an empty list when none are readable.
 */
export async function listPastSessions(ctx: Context): Promise<Past[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  const records = (await query.listSessions()).slice(0, PICKER_LIMIT)
  return Promise.all(records.map(async (record): Promise<Past> => {
    let title: string | undefined
    try {
      title = (await query.readTitle(record.header.id))?.title
    } catch {
      // A session whose title cannot be read is still resumable, so it shows as
      // untitled rather than being dropped from the list.
      title = undefined
    }
    return {
      id: record.header.id,
      title: title === undefined || title === '' ? 'untitled' : title,
      createdAt: record.header.createdAt,
      cwd: record.header.cwd,
    }
  }))
}

/**
 * Prompt for a past session.
 *
 * Drives its own keyboard and its own redraw, which the other pickers do not need
 * to. They run inside a session, where the runner is already dispatching keys and
 * redrawing; this one runs BEFORE the agent exists, because which session to
 * resume is what decides which agent to make. Without its own loop the overlay
 * would be registered, never painted, and never dismissable.
 * @param ctx - context carrying the session query engine and the slot registry.
 * @param now - the current time, for the relative ages.
 * @param terminal - the terminal to read keys from for the picker's lifetime.
 * @param draw - repaints the live region.
 * @returns the chosen session id, or undefined when there was nothing to choose
 *   from or the user dismissed the picker.
 */
export async function pickSession(
  ctx: Context,
  now: number,
  terminal: Terminal,
  draw: () => void,
): Promise<SessionId | undefined> {
  const sessions = await listPastSessions(ctx)
  if (sessions.length === 0) return undefined
  const choices: SelectChoice[] = sessions.map((past, index) => ({
    value: String(index),
    label: `${past.title.slice(0, TITLE_COLUMNS)}`,
    description: `${since(past.createdAt, now)}${past.cwd === undefined ? '' : ` · ${past.cwd}`}`,
  }))
  const picked = await new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    let release = (): void => {}
    const overlay = createSelectOverlay({
      title: 'Resume a session',
      choices,
      // Painted directly rather than through `tui/render`: the runner has not
      // subscribed to that event yet, and will not until an agent exists.
      invalidate: draw,
      settle: value => {
        release()
        dismiss()
        resolve(value)
      },
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    release = terminal.onKey(key => { ctx.tuiSlots.activeOverlay?.handleKey(key) })
    draw()
  })
  if (picked === undefined) return undefined
  return sessions[Number(picked)]?.id
}

/**
 * Read a past session's log.
 * @param ctx - context carrying the session query engine.
 * @param sessionId - the session to read.
 * @returns its raw events, or an empty list when the log cannot be read.
 */
export async function readTranscript(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  const snapshot = await query.readSession(sessionId)
  return snapshot.events
}

/**
 * The banner shown above a replayed transcript.
 * @param count - how many events were replayed.
 * @returns lines to commit before the transcript.
 */
export function resumeBanner(count: number): string[] {
  return count === 0
    ? ['', style('· resumed an empty session', 'gray')]
    : ['', style(`· resumed — ${String(count)} earlier events`, 'gray')]
}

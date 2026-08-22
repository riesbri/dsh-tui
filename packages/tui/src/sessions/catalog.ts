/**
 * Reading the session corpus through `ctx.sessionQuery`, and nothing else.
 *
 * There is no index, cache file, or scan of the sessions directory here, and
 * there must never be: Harness already owns a live-preferred corpus that merges
 * `ctx.sessions` with whatever persistence is mounted, and a second one in the
 * frontend would disagree with it the first time either changed.
 *
 * Two tiers, deliberately different services. The listing is `listSessions()`
 * plus one batched `readTitleSnapshots()`, which is cheap and always available.
 * Searching CONTENT is `searchSessions()`, which is the engine's only abstract
 * surface — a deployment whose backend implements no full-text search reports
 * `SESSION_QUERY_SEARCH_DISABLED`, and that is a capability to degrade to, not
 * an error to show. The frontend does not fall back to reading every log itself.
 * @module @riesbri/dsh-tui/sessions/catalog
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventRecord,
  SessionQueryErrorCode,
  SessionRecord,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { CatalogState, ContentState, SessionDetail, SessionEntry } from './model.ts'

/**
 * The exact `ctx.sessionQuery` surface this catalog consumes.
 *
 * Written out rather than taking the whole engine so the dependency is legible:
 * four reads, no writes, no traces the view does not draw. `SessionQueryEngine`
 * satisfies it structurally, so the narrowing costs nothing at the call site.
 */
export interface SessionQueryReads {
  /** The complete logical corpus, newest first. */
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
  /** Folded titles for many sessions from one corpus observation. */
  readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]>
  /** Lightweight per-event records for one session. */
  listEvents(sessionId: SessionId): Promise<SessionEventRecord[]>
  /** Full-text search across the corpus; the engine's abstract surface. */
  searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>>
}

/** What the catalog needs from its owner. */
export interface SessionCatalogSpec {
  /** The mounted session-query engine, or undefined in a profile without one. */
  readonly query: SessionQueryReads | undefined
  /** Redraw after a listing, a search, or a detail read lands. */
  readonly invalidate: () => void
  /** Rows to keep from one listing; omitted, {@link CATALOG_LIMIT} applies. */
  readonly limit?: number
}

/**
 * Sessions kept from one listing.
 *
 * The listing itself is lightweight — headers, not logs — so this bound is about
 * the reader, not the read: a browser that offers two thousand rows is a browser
 * nobody scrolls, and the search tiers are the way past the newest few hundred.
 * The count that was dropped is reported rather than hidden, because a list that
 * silently ends looks like a corpus that does.
 */
export const CATALOG_LIMIT = 200

/**
 * Content-search results requested per page.
 *
 * One page only. Paging a ranked result set needs a cursor whose generation the
 * backend owns, and a browser that quietly showed page one as though it were the
 * whole answer would be the "no silent degradation" mistake; the counter says
 * how many came back.
 */
export const CONTENT_SEARCH_LIMIT = 50

/**
 * The taxonomy member that means this deployment simply has no full-text search.
 *
 * Typed against the published union so an upstream rename fails the type-check
 * here instead of quietly turning a supported degradation into a red error row.
 */
const SEARCH_DISABLED: SessionQueryErrorCode = 'SESSION_QUERY_SEARCH_DISABLED'

/**
 * Read one error's machine-routable code without importing the error class.
 * @param error - a thrown value from the query engine.
 * @returns its `code`, when it carries a string one.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * A thrown value as a line the frontend may draw.
 * @param error - the thrown value.
 * @returns its message; untrusted, so callers still escape it.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Turn one corpus record and its folded title into a listable entry.
 * @param record - the logical-corpus record.
 * @param title - the folded title, when the log had one.
 * @param snippet - a content-search excerpt, when this came from a search.
 * @returns the entry.
 */
function toEntry(record: SessionRecord, title: string | undefined, snippet?: string): SessionEntry {
  return {
    id: record.header.id,
    title,
    createdAt: record.header.createdAt,
    cwd: record.header.cwd,
    live: record.live,
    persisted: record.persisted,
    parent: record.header.parentSession,
    origin: record.header.origin === 'subagent' ? 'delegated' : 'own',
    ...snippet === undefined ? {} : { snippet },
  }
}

/**
 * Fold a batch title observation into a lookup.
 *
 * A rejected member is dropped rather than propagated: the batch isolates
 * per-session failures on purpose, and a session whose title could not be read
 * is still listable and still resumable — showing it untitled is the honest
 * reading, where dropping the row would hide a session that exists.
 * @param results - the batch's ordered settlements.
 * @returns titles by session id, for the ones that resolved with a title.
 */
function titlesFrom(results: readonly SessionTitleObservationResult[]): Map<SessionId, string> {
  const titles = new Map<SessionId, string>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const title = result.value.title?.title
    if (title !== undefined && title !== '') titles.set(result.sessionId, title)
  }
  return titles
}

/**
 * The corpus reader behind the Sessions browser.
 *
 * Owns three independent asynchronous reads — the listing, one content search,
 * and the selected row's detail — and a generation counter for each, so a result
 * that lands after its request was superseded is discarded instead of repainting
 * the view with an answer to a question the reader has already moved past.
 */
export class SessionCatalog {
  private base: CatalogState
  private contentState: ContentState = { kind: 'idle' }
  private readonly details = new Map<SessionId, SessionDetail>()
  private readonly detailsInFlight = new Set<SessionId>()
  private listingGeneration = 0
  private searchGeneration = 0
  private searchAbort: AbortController | undefined
  private disposed = false

  constructor(private readonly spec: SessionCatalogSpec) {
    this.base = spec.query === undefined ? { kind: 'unavailable' } : { kind: 'loading' }
  }

  /** The listing, before any query is applied. */
  listing(): CatalogState {
    return this.base
  }

  /** The optional content search's current state. */
  content(): ContentState {
    return this.contentState
  }

  /**
   * The bounded detail already read for one session.
   * @param sessionId - the session.
   * @returns its detail, or undefined until {@link requestDetail} has landed.
   */
  detail(sessionId: SessionId): SessionDetail | undefined {
    return this.details.get(sessionId)
  }

  /**
   * Load, or reload, the listing.
   *
   * Titles are read with ONE batched observation rather than a call per row: the
   * batch resolves every id from a single corpus listing, so a hundred rows cost
   * one persistence listing instead of a hundred, and each row keeps its own
   * header for whatever authorization a deployment later binds to it.
   */
  refresh(): void {
    const query = this.spec.query
    if (query === undefined) return
    const generation = (this.listingGeneration += 1)
    this.base = { kind: 'loading' }
    this.spec.invalidate()
    void (async (): Promise<void> => {
      try {
        const records = await query.listSessions()
        const limit = this.spec.limit ?? CATALOG_LIMIT
        const kept = records.slice(0, limit)
        const titles = titlesFrom(await query.readTitleSnapshots(kept.map(record => record.header.id)))
        if (this.stale(generation, this.listingGeneration)) return
        this.base = {
          kind: 'ready',
          entries: kept.map(record => toEntry(record, titles.get(record.header.id))),
          truncated: records.length - kept.length,
        }
      } catch (error: unknown) {
        if (this.stale(generation, this.listingGeneration)) return
        this.base = { kind: 'failed', message: reason(error) }
      }
      this.spec.invalidate()
    })()
  }

  /**
   * Search session CONTENTS through the engine's full-text surface.
   *
   * The previous search is aborted rather than left to land, which is what the
   * engine's optional cancellation is for: a superseded query can be expensive,
   * and a backend that honours the signal should be allowed to stop.
   * @param text - the query, interpreted by the backend as data.
   */
  search(text: string): void {
    const query = this.spec.query
    if (query === undefined) return
    const trimmed = text.trim()
    if (trimmed === '') {
      this.contentState = { kind: 'idle' }
      this.spec.invalidate()
      return
    }
    const generation = (this.searchGeneration += 1)
    this.searchAbort?.abort()
    const abort = new AbortController()
    this.searchAbort = abort
    this.contentState = { kind: 'searching', query: trimmed }
    this.spec.invalidate()
    void (async (): Promise<void> => {
      try {
        const page = await query.searchSessions(
          { query: trimmed, limit: CONTENT_SEARCH_LIMIT },
          { signal: abort.signal },
        )
        const titles = titlesFrom(await query.readTitleSnapshots(
          page.items.map(hit => hit.header.id),
          abort.signal,
        ))
        if (this.stale(generation, this.searchGeneration)) return
        this.contentState = {
          kind: 'ready',
          query: trimmed,
          entries: page.items.map(hit => toEntry(hit, titles.get(hit.header.id), hit.bestMatch.snippet)),
        }
      } catch (error: unknown) {
        if (this.stale(generation, this.searchGeneration)) return
        // A backend without a full-text index is a supported deployment, not a
        // failure: the browser keeps working and says content search is off.
        this.contentState = errorCode(error) === SEARCH_DISABLED
          ? { kind: 'unsupported' }
          : { kind: 'failed', message: reason(error) }
      }
      this.spec.invalidate()
    })()
  }

  /**
   * Ask for one session's bounded detail, at most once per session.
   *
   * Requested by the view when a row becomes selected, so the cost follows the
   * cursor. Cached forever within one open browser: the corpus does not rewrite
   * a past session's log while a picker is on screen, and re-reading a log on
   * every arrow press would make holding the down key load megabytes.
   * @param sessionId - the selected session.
   */
  requestDetail(sessionId: SessionId): void {
    const query = this.spec.query
    if (query === undefined) return
    if (this.details.has(sessionId) || this.detailsInFlight.has(sessionId)) return
    this.detailsInFlight.add(sessionId)
    void (async (): Promise<void> => {
      try {
        const events = await query.listEvents(sessionId)
        if (this.disposed) return
        this.details.set(sessionId, {
          events: events.length,
          lastActivityAt: events.at(-1)?.time,
        })
        this.spec.invalidate()
      } catch {
        // A log that cannot be listed leaves the row without its counts. The
        // row still names a resumable session, so this is a missing fact rather
        // than a failure worth a message of its own.
      } finally {
        this.detailsInFlight.delete(sessionId)
      }
    })()
  }

  /** Abandon in-flight reads; results that land afterwards are discarded. */
  dispose(): void {
    this.disposed = true
    this.listingGeneration += 1
    this.searchGeneration += 1
    this.searchAbort?.abort()
    this.searchAbort = undefined
  }

  /**
   * Whether a completed read has been superseded or the catalog is gone.
   * @param generation - the generation the read was issued under.
   * @param current - the counter it must still match.
   * @returns whether to discard the result.
   */
  private stale(generation: number, current: number): boolean {
    return this.disposed || generation !== current
  }
}

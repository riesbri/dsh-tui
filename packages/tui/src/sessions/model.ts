/**
 * What a session IS, for a reader who has to recognise one in a list.
 *
 * The hard part of a session browser is not drawing rows; it is deciding which
 * facts identify a session to a person. An id does not, a timestamp barely does,
 * and a title only does when something wrote one. So an entry carries the whole
 * set Harness can answer for — title, age, workspace, lineage, availability —
 * and the view decides how much of it fits.
 *
 * Everything here is pure. The catalog owns the reads and the overlay owns the
 * keyboard; this module owns the vocabulary and the string rules, which is the
 * part worth testing without a terminal or a harness.
 * @module @riesbri/dsh-tui/sessions/model
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * How Harness can produce a session, as far as presentation is concerned.
 *
 * `delegated` is `SessionHeader.origin === 'subagent'`, which the header
 * documents as presentation metadata rather than proof of anything the child can
 * still do. It is worth showing because a deployment that delegates a lot fills
 * its corpus with children nobody typed into, and a reader scanning for their
 * own work needs to tell those apart at a glance.
 */
export type SessionOrigin = 'own' | 'delegated'

/** One session as the browser lists it. */
export interface SessionEntry {
  /** Harness session id, the only stable identity a row has. */
  readonly id: SessionId
  /**
   * The folded `session/title`, or undefined when the log carries none.
   *
   * Undefined rather than a placeholder string: "untitled" is a rendering
   * decision, and a matcher that searched the placeholder would report a hit on
   * sessions whose text never contained the word.
   */
  readonly title: string | undefined
  /** When the session was created, from its immutable header. */
  readonly createdAt: number
  /** Workspace the session was created in, when the header records one. */
  readonly cwd: string | undefined
  /** Whether `ctx.sessions` currently holds the id. */
  readonly live: boolean
  /** Whether the mounted persistence backend currently materializes the id. */
  readonly persisted: boolean
  /** The session this one was forked or delegated from, when the header says. */
  readonly parent: SessionId | undefined
  /** Coarse header classification, for telling delegated children apart. */
  readonly origin: SessionOrigin
  /**
   * A plain-text excerpt from the strongest matching event, present only on a
   * content-search result. It is provider-selected text from the log, so it is
   * untrusted and must be escaped before it is drawn.
   */
  readonly snippet?: string
}

/**
 * The bounded extra reading taken for one selected row.
 *
 * Deliberately not part of {@link SessionEntry}: both facts come from loading
 * and surface-folding a whole session log, and doing that for every row of a
 * corpus would make opening the browser cost as much as opening every session
 * in it. One selected row at a time is affordable and is all a reader looks at.
 */
export interface SessionDetail {
  /** Raw log events in the session. */
  readonly events: number
  /** Timestamp of its last event, or undefined for an empty log. */
  readonly lastActivityAt: number | undefined
}

/** Which corpus the visible rows came from. */
export type SessionSearchMode = 'filter' | 'content'

/** The listing the browser draws before any search is applied. */
export type CatalogState =
  /** No `ctx.sessionQuery` is mounted, so there is no corpus to browse. */
  | { readonly kind: 'unavailable' }
  /** The first listing is in flight. */
  | { readonly kind: 'loading' }
  /** Harness refused the listing; the message is its own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A listing arrived. `truncated` counts rows the limit dropped. */
  | { readonly kind: 'ready'; readonly entries: readonly SessionEntry[]; readonly truncated: number }

/** The state of the optional full-text pass over session contents. */
export type ContentState =
  /** Nothing has been asked for yet. */
  | { readonly kind: 'idle' }
  /** A search for `query` is in flight. */
  | { readonly kind: 'searching'; readonly query: string }
  /** Results for `query`, possibly none. */
  | { readonly kind: 'ready'; readonly query: string; readonly entries: readonly SessionEntry[] }
  /** This deployment's session-query backend does not offer full-text search. */
  | { readonly kind: 'unsupported' }
  /** The search failed; the message is Harness's own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }

/** Minutes in the units the relative age steps through. */
const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = MINUTES_PER_HOUR * 24

/**
 * A relative age in the coarsest unit that is still informative.
 *
 * Coarse on purpose: a list is scanned, not read, and `3d` separates rows where
 * `3d 4h 12m` only makes them the same width. Weeks are the last unit, because
 * past that the number stops meaning anything a reader acts on.
 * @param at - a timestamp in milliseconds.
 * @param now - the current time in milliseconds.
 * @returns a short relative description.
 */
export function relativeAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < MINUTES_PER_HOUR) return `${String(minutes)}m ago`
  if (minutes < MINUTES_PER_DAY) return `${String(Math.round(minutes / MINUTES_PER_HOUR))}h ago`
  const days = Math.round(minutes / MINUTES_PER_DAY)
  if (days < 7) return `${String(days)}d ago`
  return `${String(Math.round(days / 7))}w ago`
}

/** What a row is called when its log never carried a title. */
export const UNTITLED = 'untitled'

/**
 * The name a row shows.
 * @param entry - the session.
 * @returns its title, or the untitled placeholder.
 */
export function sessionLabel(entry: SessionEntry): string {
  const title = entry.title
  return title === undefined || title.trim() === '' ? UNTITLED : title
}

/**
 * A workspace path shortened at the home directory.
 *
 * Not cosmetic: the home prefix is the same on every row, so it is the one part
 * of a path that never distinguishes two sessions, while the part that does —
 * the project folder — is the part a narrow terminal cuts off first.
 * @param cwd - the absolute workspace path, or undefined.
 * @param home - the user's home directory, when it is known.
 * @returns the path to display, or undefined when there is none.
 */
export function shortWorkspace(cwd: string | undefined, home: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  if (home === undefined || home === '') return cwd
  if (cwd === home) return '~'
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

/**
 * Normalise text for matching.
 *
 * Case is folded and whitespace runs collapse, so a query typed with one space
 * finds a title that was wrapped or indented in the log. Deliberately the same
 * shape as the session-query text clause, which is also literal, case-
 * insensitive, and whitespace-flexible — the two search tiers should not
 * disagree about what counts as a match.
 * @param text - the raw text.
 * @returns its normalised form.
 */
function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/**
 * Whether a query matches one entry's identifying text.
 *
 * Matched against the title, the workspace, and the id — the three facts a row
 * shows. Content is deliberately NOT searched here: that is the other tier, and
 * it needs Harness's index rather than a scan this frontend invented.
 * @param entry - the candidate.
 * @param query - raw query text; an empty query matches everything.
 * @returns whether the entry should be listed.
 */
export function matchesQuery(entry: SessionEntry, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  const haystack = normalize([entry.title ?? '', entry.cwd ?? '', entry.id].join(' '))
  return haystack.includes(needle)
}

/**
 * Apply a query to a listing, preserving Harness's newest-first order.
 *
 * Order is not re-ranked. Harness returns the corpus newest-first, and a
 * frontend that re-sorted by its own idea of relevance would be inventing a
 * ranking the corpus never agreed to — which is exactly what the content tier
 * asks the backend for instead.
 * @param entries - the listing.
 * @param query - raw query text.
 * @returns the matching entries, in their original order.
 */
export function filterEntries(
  entries: readonly SessionEntry[],
  query: string,
): readonly SessionEntry[] {
  return normalize(query) === '' ? entries : entries.filter(entry => matchesQuery(entry, query))
}

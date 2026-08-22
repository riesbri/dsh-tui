/** Tests for reading the Harness session corpus, and for degrading when it cannot. */

import { describe, expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventRecord,
  SessionRecord,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { SessionQueryReads } from '../src/sessions/catalog.ts'
import { SessionCatalog } from '../src/sessions/catalog.ts'

/** Let the catalog's own awaits settle before reading its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

/**
 * One corpus record with the header fields presentation reads.
 * @param id - the session id.
 * @param overrides - header and availability fields to replace.
 * @returns the record.
 */
function record(id: string, overrides: Partial<SessionRecord & SessionHeader> = {}): SessionRecord {
  const { live = false, persisted = true, ...header } = overrides as Record<string, unknown>
  return {
    header: { version: 1, id: id as SessionId, createdAt: 1_000, cwd: '/w', ...header } as SessionHeader,
    live: live as boolean,
    persisted: persisted as boolean,
  }
}

/**
 * A fulfilled batch title observation.
 * @param id - the session id.
 * @param title - the folded title.
 * @returns the settlement.
 */
function titled(id: string, title: string): SessionTitleObservationResult {
  return {
    sessionId: id as SessionId,
    status: 'fulfilled',
    value: {
      session: { version: 1, id: id as SessionId, createdAt: 1_000 } as SessionHeader,
      title: { title, messageSeqs: [0], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: 1_000 },
    },
  }
}

/** Parts of the query surface a test overrides. */
type Reads = Partial<SessionQueryReads>

/**
 * A session-query engine narrowed to the four reads the catalog uses.
 * @param reads - the behaviours this test needs.
 * @returns the fake engine.
 */
function engine(reads: Reads): SessionQueryReads {
  return {
    listSessions: reads.listSessions ?? (async () => []),
    readTitleSnapshots: reads.readTitleSnapshots ?? (async () => []),
    listEvents: reads.listEvents ?? (async () => []),
    searchSessions: reads.searchSessions ?? (async () => ({ items: [] })),
  }
}

describe('listing the corpus', () => {
  it('reports no corpus at all when the service is absent, without a failure', () => {
    // A profile that mounts no session query has an unavailable view, not a
    // broken one: the capability rule is degrade, never boot-fail.
    const catalog = new SessionCatalog({ query: undefined, invalidate: () => {} })
    expect(catalog.listing()).toEqual({ kind: 'unavailable' })
    catalog.refresh()
    expect(catalog.listing()).toEqual({ kind: 'unavailable' })
  })

  it('folds headers and one batched title observation into rows', async () => {
    let titleCalls = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => [
          record('a', { cwd: '/w/one', parentSession: 'root' as SessionId }),
          record('b', { live: true, origin: 'subagent' }),
        ],
        readTitleSnapshots: async ids => {
          titleCalls += 1
          expect(ids).toEqual(['a', 'b'])
          return [titled('a', 'First')]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    expect(listing.kind === 'ready' && listing.entries).toMatchObject([
      { id: 'a', title: 'First', cwd: '/w/one', parent: 'root', origin: 'own', persisted: true },
      { id: 'b', title: undefined, live: true, origin: 'delegated' },
    ])
    // One batched observation, not one call per row: the batch resolves every id
    // from a single corpus listing.
    expect(titleCalls).toBe(1)
  })

  it('keeps a session whose title could not be read', async () => {
    // The batch isolates per-session failures on purpose, and an unreadable title
    // does not make a session unresumable — dropping the row would hide it.
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => [record('a')],
        readTitleSnapshots: async () => [{ sessionId: 'a' as SessionId, status: 'rejected', reason: new Error('nope') }],
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toMatchObject({ kind: 'ready', entries: [{ id: 'a', title: undefined }] })
  })

  it('bounds the listing and says how much it dropped', async () => {
    const catalog = new SessionCatalog({
      query: engine({ listSessions: async () => [record('a'), record('b'), record('c')] }),
      invalidate: () => {},
      limit: 2,
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toMatchObject({ kind: 'ready', truncated: 1 })
  })

  it('reports a refused listing instead of showing an empty corpus', async () => {
    // An empty list and an unreadable one look identical on screen, and one of
    // them means the reader's history is gone.
    const catalog = new SessionCatalog({
      query: engine({ listSessions: async () => { throw new Error('persistence unreadable') } }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({ kind: 'failed', message: 'persistence unreadable' })
  })

  it('discards a listing that landed after a newer one was asked for', async () => {
    let call = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => {
          call += 1
          return call === 1 ? [record('stale')] : [record('fresh')]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toMatchObject({ kind: 'ready', entries: [{ id: 'fresh' }] })
  })

  it('discards everything in flight once the browser is gone', async () => {
    // A result that lands after the overlay was dismissed would repaint a live
    // region that has moved on, so neither the state nor the redraw may follow.
    let repaints = 0
    const catalog = new SessionCatalog({
      query: engine({ listSessions: async () => [record('a')] }),
      invalidate: () => { repaints += 1 },
    })
    catalog.refresh()
    expect(repaints).toBe(1)
    catalog.dispose()
    await settled()
    expect(repaints).toBe(1)
    expect(catalog.listing()).toEqual({ kind: 'loading' })
  })
})

describe('searching what sessions said', () => {
  /** One hit whose strongest match carries an excerpt. */
  const hit: SessionSearchHit = {
    ...record('a'),
    bestMatch: {
      sessionId: 'a' as SessionId,
      seq: 4,
      type: 'user/message',
      time: 2_000,
      surface: 'current',
      snippet: '…the parser wraps CJK…',
    },
  }

  it('asks Harness, and carries its excerpt back', async () => {
    let asked: SessionSearchRequest | undefined
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async (request: SessionSearchRequest): Promise<SessionSearchPage<SessionSearchHit>> => {
          asked = request
          return { items: [hit] }
        },
        readTitleSnapshots: async () => [titled('a', 'Wrap work')],
      }),
      invalidate: () => {},
    })
    catalog.search('  cjk  ')
    expect(catalog.content()).toEqual({ kind: 'searching', query: 'cjk' })
    await settled()
    expect(asked?.query).toBe('cjk')
    expect(catalog.content()).toMatchObject({
      kind: 'ready',
      query: 'cjk',
      entries: [{ id: 'a', title: 'Wrap work', snippet: '…the parser wraps CJK…' }],
    })
  })

  it('degrades to unsupported when the backend indexes nothing', async () => {
    // The engine's two full-text methods are its only abstract surface, so a
    // deployment may implement neither. That is a capability to report, not an
    // error to paint red.
    const disabled = Object.assign(new Error('no index'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    const catalog = new SessionCatalog({
      query: engine({ searchSessions: async () => { throw disabled } }),
      invalidate: () => {},
    })
    catalog.search('anything')
    await settled()
    expect(catalog.content()).toEqual({ kind: 'unsupported' })
  })

  it('reports any other search failure with Harness’s own reason', async () => {
    const broken = Object.assign(new Error('index generation is stale'), { code: 'SESSION_QUERY_STALE_CURSOR' })
    const catalog = new SessionCatalog({
      query: engine({ searchSessions: async () => { throw broken } }),
      invalidate: () => {},
    })
    catalog.search('anything')
    await settled()
    expect(catalog.content()).toEqual({ kind: 'failed', message: 'index generation is stale' })
  })

  it('cancels a superseded search through the engine’s own signal', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async (_request, exec?: SessionSearchExecContext) => {
          signals.push(exec?.signal)
          return { items: [] }
        },
      }),
      invalidate: () => {},
    })
    catalog.search('one')
    catalog.search('two')
    await settled()
    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    expect(catalog.content()).toMatchObject({ kind: 'ready', query: 'two' })
  })

  it('treats a cleared query as no search rather than a search for nothing', async () => {
    const catalog = new SessionCatalog({
      query: engine({ searchSessions: async () => { throw new Error('must not be asked') } }),
      invalidate: () => {},
    })
    catalog.search('   ')
    await settled()
    expect(catalog.content()).toEqual({ kind: 'idle' })
  })
})

describe('the detail one selected row costs', () => {
  /**
   * A raw-log record listing.
   * @param count - how many events.
   * @returns the records.
   */
  function events(count: number): SessionEventRecord[] {
    return Array.from({ length: count }, (_unused, index) => ({
      sessionId: 'a' as SessionId,
      seq: index,
      type: 'turn/start',
      time: 5_000 + index,
      surface: 'log-only',
    }))
  }

  it('reads one log per selection and reuses it afterwards', async () => {
    // Holding the down arrow would otherwise load a megabyte per keypress: each
    // read loads and surface-folds a whole session log.
    let reads = 0
    const catalog = new SessionCatalog({
      query: engine({
        listEvents: async () => {
          reads += 1
          return events(3)
        },
      }),
      invalidate: () => {},
    })
    catalog.requestDetail('a' as SessionId)
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(catalog.detail('a' as SessionId)).toEqual({ events: 3, lastActivityAt: 5_002 })
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(reads).toBe(1)
  })

  it('leaves the row without counts when its log cannot be listed', async () => {
    const catalog = new SessionCatalog({
      query: engine({ listEvents: async () => { throw new Error('unreadable') } }),
      invalidate: () => { throw new Error('a missing fact is not a repaint') },
    })
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(catalog.detail('a' as SessionId)).toBeUndefined()
  })

  it('reports an empty log as empty rather than as unknown', async () => {
    const catalog = new SessionCatalog({ query: engine({}), invalidate: () => {} })
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(catalog.detail('a' as SessionId)).toEqual({ events: 0, lastActivityAt: undefined })
  })
})

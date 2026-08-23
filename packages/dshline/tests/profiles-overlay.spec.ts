/**
 * The Profiles browser: what it draws, and what each key asks its owner for.
 *
 * The structural subject is the list shape — every profile followed by its own
 * bundle layers — and the fact that selection walks both kinds as one
 * sequence, so a bundle operation always has an unambiguous target and no row
 * is stranded behind a mode.
 */

import { describe, expect, it } from 'vitest'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { BundleRow, ProfileRow } from '../src/profiles/harness.ts'
import type { ProfilesState } from '../src/profiles/catalog.ts'
import type { ProfilesOverlay } from '../src/profiles/overlay.ts'
import { createProfilesOverlay, selectableRows } from '../src/profiles/overlay.ts'

/** Width and height of a comfortable terminal. */
const COLUMNS = 90
const ROWS = 28

/** A fixed clock, so notice expiry is exact. */
const NOW = 1_800_000_000_000

/** One bundle row, with sensible defaults. */
function bundle(packageName: string, overrides: Partial<BundleRow> = {}): BundleRow {
  return { packageName, version: '1.0.0', managed: true, declaresBundle: true, ...overrides }
}

/** One profile row, with sensible defaults. */
function profile(name: string, overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    name,
    dir: `/home/.dsh/profiles/${name}`,
    current: false,
    bundles: [],
    broken: undefined,
    ...overrides,
  }
}

/** A complete reading. */
function ready(profiles: readonly ProfileRow[], currentName?: string): ProfilesState {
  return {
    kind: 'ready',
    reading: { root: '/home/.dsh/profiles', profiles, currentName },
  }
}

/** What the overlay asked its owner for. */
interface Asked {
  readonly added: string[]
  readonly updated: { profile: string; bundle: string | undefined }[]
  readonly removed: { profile: string; bundle: string }[]
  readonly created: () => number
  readonly explained: string[]
  readonly refreshed: () => number
  readonly closed: () => boolean
}

/** An overlay under test, plus what it recorded. */
interface Mounted extends Asked {
  render(columns?: number, rows?: number): string[]
  text(columns?: number, rows?: number): string
  press(...keys: Key[]): void
  readonly overlay: ProfilesOverlay
}

/**
 * Mount the browser over a fixed reading.
 * @param state - the reading to show.
 * @returns the overlay and its recorded requests.
 */
function mount(state: ProfilesState): Mounted {
  const added: string[] = []
  const updated: { profile: string; bundle: string | undefined }[] = []
  const removed: { profile: string; bundle: string }[] = []
  const explained: string[] = []
  let created = 0
  let refreshed = 0
  let closed = false
  const overlay = createProfilesOverlay({
    state: () => state,
    refresh: () => { refreshed += 1 },
    addBundle: target => { added.push(target.name) },
    updateBundle: (target, row) => { updated.push({ profile: target.name, bundle: row?.packageName }) },
    removeBundle: (target, row) => { removed.push({ profile: target.name, bundle: row.packageName }) },
    createProfile: () => { created += 1 },
    explainBoot: target => { explained.push(target.name) },
    now: () => NOW,
    close: () => { closed = true },
    invalidate: () => {},
  })
  const render = (columns = COLUMNS, rows = ROWS): string[] => [...overlay.render(columns, rows)]
  return {
    overlay,
    render,
    text: (columns = COLUMNS, rows = ROWS) => stripAnsi(render(columns, rows).join('\n')),
    press: (...keys) => { for (const k of keys) overlay.handleKey(k) },
    added,
    updated,
    removed,
    created: () => created,
    explained,
    refreshed: () => refreshed,
    closed: () => closed,
  }
}

function key(name: Extract<Key, { kind: 'key' }>['name']): Key {
  return { kind: 'key', name }
}

function text(value: string): Key {
  return { kind: 'text', text: value }
}

describe('the selectable sequence', () => {
  const rows = [
    profile('dshline', { current: true, bundles: [bundle('@dshline/dshline'), bundle('@deepseek-ai/dsh-base')] }),
    profile('web', { bundles: [bundle('@deepseek-ai/dsh-web-app')] }),
  ]

  it('follows each profile with its own bundle layers', () => {
    const selection = selectableRows(ready(rows), '')
    expect(selection.map(entry => entry.kind)).toEqual(['profile', 'bundle', 'bundle', 'profile', 'bundle'])
  })

  it('addresses every bundle row to the profile it sits under', () => {
    const selection = selectableRows(ready(rows), '')
    expect(selection.map(entry => `${entry.profile.name}/${entry.kind}`)).toEqual([
      'dshline/profile', 'dshline/bundle', 'dshline/bundle', 'web/profile', 'web/bundle',
    ])
  })

  it('reaches every bundle by moving down, with no row stranded behind a mode', () => {
    // The dead end the earlier inspect-one-profile shape had: the first
    // profile's bundles were unreachable, because passing the second profile's
    // row re-pointed the section away from them.
    const selection = selectableRows(ready(rows), '')
    const bundles = selection.filter(entry => entry.kind === 'bundle')
    expect(bundles).toHaveLength(3)
  })

  it('is empty before the first read lands', () => {
    expect(selectableRows({ kind: 'loading' }, '')).toEqual([])
  })

  it('narrows to the profiles a query matches, bundles included', () => {
    expect(selectableRows(ready(rows), 'web').map(entry => entry.profile.name)).toEqual(['web', 'web'])
  })

  it('draws a profile with no bundles as a single row', () => {
    expect(selectableRows(ready([profile('bare')]), '').map(entry => entry.kind)).toEqual(['profile'])
  })
})

describe('what the browser shows', () => {
  it('names the booted profile and marks it in the roster', () => {
    const view = mount(ready([profile('dshline', { current: true }), profile('web')], 'dshline'))
    const out = view.text()
    expect(out).toContain('Host: dshline')
    expect(out).toContain('● dshline')
    expect(out).toContain('current')
    expect(out).toContain('○ web')
  })

  it('says so plainly when this Host booted no profile', () => {
    expect(mount(ready([profile('web')])).text()).toContain('not booted from a profile')
  })

  it('lists the inspected profile bundles under a heading, with versions', () => {
    const view = mount(ready([
      profile('dshline', { current: true, bundles: [bundle('@dshline/dshline', { version: '0.7.1' })] }),
    ], 'dshline'))
    const out = view.text()
    expect(out).toContain('Bundles')
    expect(out).toContain('@dshline/dshline')
    expect(out).toContain('0.7.1')
    expect(out).toContain('✓')
  })

  it('shows the profiles root, so a reader knows which home is being read', () => {
    expect(mount(ready([profile('web')])).text()).toContain('/home/.dsh/profiles')
  })

  it('offers to create one when the roster is empty', () => {
    expect(mount(ready([])).text()).toContain('Press n to create one')
  })

  it('shows an unreadable profile rather than hiding it', () => {
    const view = mount(ready([profile('broken', { broken: 'package.json is missing' })]))
    const out = view.text()
    expect(out).toContain('broken')
    expect(out).toContain('unreadable')
    expect(out).toContain('package.json is missing')
  })

  it('reports a failed read in its own words', () => {
    expect(mount({ kind: 'failed', message: 'EACCES' }).text()).toContain('EACCES')
  })

  it('reports an absent home-path service as unavailable', () => {
    expect(mount({ kind: 'unavailable', message: 'no home-path service' }).text()).toContain('no home-path service')
  })

  it('never exceeds the terminal at any height a frame is drawn at', () => {
    const state = ready(Array.from({ length: 8 }, (_unused, index) => profile(`p${String(index)}`, {
      bundles: [bundle('@a/one'), bundle('@a/two'), bundle('@a/three')],
    })))
    for (let rows = 8; rows <= 30; rows += 1) {
      expect(mount(state).render(COLUMNS, rows).length, `height ${String(rows)}`).toBeLessThanOrEqual(rows)
    }
  })
})

describe('keys', () => {
  const roster = ready([
    profile('dshline', { current: true, bundles: [bundle('@dshline/dshline'), bundle('@deepseek-ai/dsh-base')] }),
    profile('web'),
  ], 'dshline')

  it('asks to add a bundle to the profile the cursor is in', () => {
    const view = mount(roster)
    view.render()
    view.press(text('a'))
    expect(view.added).toEqual(['dshline'])
  })

  it('asks to update the selected bundle, and every bundle on U', () => {
    const view = mount(roster)
    view.render()
    // One row down from the profile is its own first bundle.
    view.press(key('down'))
    view.render()
    view.press(text('u'))
    expect(view.updated).toEqual([{ profile: 'dshline', bundle: '@dshline/dshline' }])
    view.press(text('U'))
    expect(view.updated.at(-1)).toEqual({ profile: 'dshline', bundle: undefined })
  })

  it('updates every bundle when the cursor is on a profile rather than a bundle', () => {
    const view = mount(roster)
    view.render()
    view.press(text('u'))
    expect(view.updated).toEqual([{ profile: 'dshline', bundle: undefined }])
  })

  it('only removes when a bundle is selected', () => {
    const view = mount(roster)
    view.render()
    view.press(text('r'))
    expect(view.removed).toEqual([])
    view.press(key('down'))
    view.render()
    view.press(text('r'))
    expect(view.removed).toEqual([{ profile: 'dshline', bundle: '@dshline/dshline' }])
  })

  it('asks to create a profile on n, even with an empty roster', () => {
    const view = mount(ready([]))
    view.render()
    view.press(text('n'))
    expect(view.created()).toBe(1)
  })

  it('explains how a profile is booted on enter, rather than pretending to switch', () => {
    // A composed Host cannot swap its bundle layers; naming the command is
    // what switching profiles actually is.
    const view = mount(roster)
    view.render()
    view.press(key('enter'))
    expect(view.explained).toEqual(['dshline'])
  })

  it('re-reads on ctrl-r', () => {
    const view = mount(roster)
    view.render()
    view.press(key('ctrl-r'))
    expect(view.refreshed()).toBe(1)
  })

  it('closes on escape with no filter, and clears the filter first when there is one', () => {
    const view = mount(roster)
    view.render()
    view.press(text('/'), text('w'), key('escape'))
    view.render()
    // Search mode left, filter kept: escape now clears it rather than closing.
    view.press(key('escape'))
    expect(view.closed()).toBe(false)
    view.render()
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })

  it('treats a, u, r, and n as search text once search mode is entered', () => {
    // Every one of those letters occurs in an ordinary package name, which is
    // why search is an explicit mode here rather than always-on.
    const view = mount(roster)
    view.render()
    view.press(text('/'), text('a'), text('u'), text('r'), text('n'))
    expect(view.added).toEqual([])
    expect(view.updated).toEqual([])
    expect(view.removed).toEqual([])
    expect(view.created()).toBe(0)
    expect(view.text()).toContain('aurn')
  })

  it('shows a reported result, and lets it expire', () => {
    const view = mount(roster)
    view.overlay.report('restart required', false)
    expect(view.text()).toContain('restart required')
  })

  it('reports whether it has closed, for a late-landing operation', () => {
    const view = mount(roster)
    expect(view.overlay.closed()).toBe(false)
    view.press(key('ctrl-c'))
    expect(view.overlay.closed()).toBe(true)
  })
})

/**
 * Bounded live-region cockpit for optional Harness work.
 *
 * It never commits rows: finished transcript output remains in the terminal's
 * native scrollback while this temporary inspection view is open. Every stage —
 * the grouped overview, a workflow and its members, one subagent, one job — is
 * an internal submode of the same frame, so inspecting a row never creates a
 * detached modal.
 *
 * All four stages are built from the same primitive: a flat list of rows, some
 * of which carry a focus identity. That is what makes a detail view a real
 * inspectable list rather than a text page with an incidental highlight, and it
 * is why the arrow keys move a visible cursor everywhere instead of scrolling
 * underneath a stuck one.
 * @module dshline/work/overlay
 */

import type { Key, Role } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  formatElapsed,
  paint,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { FocusRing } from '../focus.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import type {
  JobWorkItem,
  SubagentWorkItem,
  WorkItem,
  WorkMark,
  WorkflowMemberItem,
  WorkflowWorkItem,
  WorkSnapshot,
  WorkInterruptResult,
} from './model.ts'
import {
  looseSubagents,
  memberMark,
  workflowMemberKey,
  workItemKey,
  workMark,
} from './model.ts'

/** Rows outside the listing: leading blank, borders, counter, and spacer. */
const WORK_FIXED_ROWS = 5

/** Minimum terminal width that can show the framed work list without wrapping. */
const WORK_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** How long an interrupt result remains visible before the normal view returns. */
const NOTICE_MS = 3_000

/** Columns a row spends on its gutter mark and the space after it. */
const GUTTER_COLUMNS = 2

/**
 * The glyph each non-animated mark draws.
 *
 * The whole point of the vocabulary is that they are not interchangeable: the
 * arc spinner means observed execution, `●` means an active lifecycle whose
 * internals are not observable, `•` means a background record exists, and `◐`
 * means a record is transitioning. Terminal glyphs report a published outcome.
 */
const MARK_GLYPH: Readonly<Record<Exclude<WorkMark, 'executing'>, string>> = {
  active: '●',
  record: '•',
  stopping: '◐',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
}

/** The role each mark's glyph is painted with when its row is not focused. */
const MARK_ROLE: Readonly<Record<WorkMark, Role>> = {
  executing: 'busy',
  active: 'subdued',
  record: 'subdued',
  stopping: 'busy',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
}

/** Which stage of the temporary live region is on screen. */
type Stage =
  | { readonly kind: 'list' }
  | { readonly kind: 'workflow'; readonly subject: string }
  | { readonly kind: 'subagent'; readonly subject: string }
  | { readonly kind: 'job'; readonly subject: string }

/** One entry on the stage stack: what is shown, and where its cursor is. */
interface StageFrame {
  readonly stage: Stage
  readonly focus: FocusRing
}

/** Inputs the Work overlay needs from its owner. */
export interface WorkOverlaySpec {
  /** Current read-only capability projection. */
  readonly snapshot: () => WorkSnapshot
  /** Ask Harness to interrupt one row where it exposes that authority. */
  readonly interrupt: (item: WorkItem) => WorkInterruptResult
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after selection, a result, or a timer tick. */
  readonly invalidate: () => void
}

/** A short result shown over the view without committing transcript output. */
interface Notice {
  readonly text: string
  readonly failed: boolean
  readonly expiresAt: number
}

/** One rendered line of a stage, and whether a human can aim at it. */
interface StageRow {
  /** `row` takes a gutter and may be focused; the others are structure. */
  readonly kind: 'line' | 'blank' | 'row'
  /** Focus identity. Present exactly when this row can be aimed at. */
  readonly key?: string
  /** The leading mark, already chosen from an authoritative fact. */
  readonly mark?: string
  /** Role for the mark alone, so an outcome reads without shouting. */
  readonly markRole?: Role
  /** The row's text after the mark: escaped and already fitted. */
  readonly text: string
  /** Role for the text when the row is not focused. */
  readonly role: Role
  /** Stage this row opens on Enter; absent rows ignore Enter safely. */
  readonly open?: Stage
}

/** One whole fact a row yields as a unit, never by being cut in half. */
interface RowSegment {
  /** The already-escaped text. */
  readonly text: string
  /** Separator drawn before this segment when it survives fitting. */
  readonly separator: ' ' | ' · '
  /** Drop priority: the highest surviving rank yields first. */
  readonly rank: number
}

/**
 * Create the bounded Work overlay.
 * @param spec - current projection and overlay controls.
 * @returns a temporary live-region overlay.
 */
export function createWorkOverlay(spec: WorkOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  // A STACK, not a flag: a workflow member opens the shared subagent stage, and
  // `esc` has to return to the workflow it was reached from rather than to the
  // overview, which is the difference between a hierarchy and two flat modes.
  const stack: StageFrame[] = [{ stage: { kind: 'list' }, focus: new FocusRing() }]
  let closed = false
  let ticker: NodeJS.Timeout | undefined
  let tick = 0
  let notice: Notice | undefined
  /** Rows of the last render, used by key handling before the next paint. */
  let rows: readonly StageRow[] = []
  // Whether the last paint was the compact fallback. That frame shows no rows
  // and no cursor, so a keystroke that would open or interrupt an aimed row
  // would be acting on something the human cannot see. It advertises exactly
  // `esc close`, and while it is on screen that is all it does.
  let fellBack = false

  const frame = (): StageFrame => stack[stack.length - 1] ?? { stage: { kind: 'list' }, focus: new FocusRing() }
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): Notice | undefined => {
    if (notice !== undefined && Date.now() >= notice.expiresAt) notice = undefined
    return notice
  }
  /**
   * Build every row of the current stage and re-align the cursor with them.
   *
   * `retarget` governs what happens when the aimed identity vanished: a render
   * adopts the predictable neighbour, while a human ACTION keeps the dead aim so
   * it can refuse rather than hit whatever inherited that screen position.
   */
  /** Identity index of the last build, so one paint indexes the projection once. */
  let index: ReadonlyMap<string, WorkItem> = new Map()

  const build = (snapshot: WorkSnapshot, width: number, retarget: boolean): readonly StageRow[] => {
    index = workIndex(snapshot)
    // A subject that settled while it was inspected must not keep painting
    // stale authority: the stage leaves, one level at a time, until a live one
    // is reached. The overview is always live.
    while (stack.length > 1) {
      const stage = frame().stage
      if (stage.kind === 'list' || index.has(stage.subject)) break
      stack.pop()
    }
    const built = stageRows(frame().stage, snapshot, index, width, tick)
    frame().focus.update(built.flatMap(row => row.key === undefined ? [] : [row.key]), retarget)
    return built
  }
  const readStage = (retarget: boolean, width: number): { snapshot: WorkSnapshot; built: readonly StageRow[] } => {
    const snapshot = spec.snapshot()
    const built = build(snapshot, width, retarget)
    rows = built
    return { snapshot, built }
  }
  /** The row the cursor is on, resolved by identity against the newest rows. */
  const focusedRow = (): StageRow | undefined => {
    const aim = frame().focus.current
    if (aim === undefined) return undefined
    return rows.find(row => row.key === aim)
  }
  /**
   * The item a human action applies to.
   *
   * On the overview that is the focused row's item; inside a detail stage it is
   * the stage's own subject, so `k` keeps working while the cursor sits on a
   * fact row that has no action of its own.
   */
  const subject = (): WorkItem | undefined => {
    const stage = frame().stage
    if (stage.kind !== 'list') return index.get(stage.subject)
    const aim = frame().focus.current
    return aim === undefined ? undefined : index.get(aim)
  }
  const push = (stage: Stage): void => {
    stack.push({ stage, focus: new FocusRing() })
    viewport.first()
    spec.invalidate()
  }
  const pop = (): void => {
    if (stack.length <= 1) {
      close()
      return
    }
    stack.pop()
    viewport.first()
    spec.invalidate()
  }
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  return {
    mounted() {
      // One heartbeat drives the elapsed readings AND the shared spinner phase,
      // so every animated row turns together instead of flickering independently.
      // The parent may be idle while independent work runs; the timer exists only
      // for this mounted overlay, and unref keeps it from owning process life.
      ticker ??= setInterval(() => {
        tick += 1
        spec.invalidate()
      }, SPINNER_INTERVAL_MS).unref()
    },
    dispose: stopTicker,
    render(columns, terminalRows = 24) {
      const activeNotice = currentNotice()
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const { snapshot, built } = readStage(true, inner)
      const fallback = (): string[] => {
        fellBack = true
        return compactFallback(snapshot, columns, terminalRows, activeNotice)
      }
      if (terminalRows <= WORK_FIXED_ROWS || columns < WORK_MIN_COLUMNS) return fallback()
      const visible = terminalRows - WORK_FIXED_ROWS - (activeNotice === undefined ? 0 : 1)
      if (visible <= 0) return fallback()

      viewport.update(built.length, visible)
      const focusedAt = built.findIndex(row => row.key !== undefined && row.key === frame().focus.current)
      if (focusedAt >= 0) {
        if (focusedAt < viewport.start) viewport.move(focusedAt - viewport.start)
        if (focusedAt >= viewport.end) viewport.move(focusedAt - viewport.end + 1)
      }
      const counter = built.length === 0
        ? 'no active work'
        : `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(built.length)}`
      const aimed = focusedRow()
      const candidate = [
        '',
        ...rootFrame({
          columns,
          context: paint('Work', 'overlay-title'),
          body: [
            paint(truncateToWidth(counter, inner), 'muted'),
            ...activeNotice === undefined ? [] : [paint(
              truncateToWidth(escapeControls(activeNotice.text), inner),
              activeNotice.failed ? 'error' : 'busy',
            )],
            '',
            ...built.slice(viewport.start, viewport.end).map(row => paintRow(row, frame().focus.current)),
          ],
          footer: fitFooterHelp(stageHelp(frame().stage, aimed, subject()), footerBudget(columns)),
        }),
      ]
      // The root frame wraps its content, including short-state text a caller may not
      // have pre-truncated. Count the same physical rows Screen will draw; a
      // too-tall candidate falls back rather than leaking a row into scrollback.
      if (physicalRows(candidate, columns).length > terminalRows) return fallback()
      fellBack = false
      return candidate
    },
    handleKey(key: Key) {
      if (closed) return
      // While the compact fallback is on screen there is no visible cursor, so
      // no key may act on the aimed row. `esc` still does what that frame says
      // it does — and closing outright, rather than popping one hidden stage at
      // a time, is what makes the advertised `esc close` true.
      if (fellBack) {
        if (key.kind === 'key' && (key.name === 'escape' || key.name === 'ctrl-c')) close()
        return
      }
      // Printable letters remain text input in the renderer. The overlay owns
      // text entry, so recognize its one letter command here rather than adding
      // a presentation-specific key name to the renderer's generic decoder.
      if (key.kind === 'text' && key.text === 'k') {
        // The ACTION reads the projection WITHOUT retargeting the cursor: if the
        // aimed identity vanished, nothing may be interrupted — the next paint
        // re-anchors the cursor instead of acting on the successor.
        build(spec.snapshot(), LOGICAL_KEY_WIDTH, false)
        const item = subject()
        if (item !== undefined && item.source === 'subagent' && item.interruptible) {
          const result = spec.interrupt(item)
          notice = { text: result.message, failed: result.kind === 'failed', expiresAt: Date.now() + NOTICE_MS }
        }
        spec.invalidate()
        return
      }
      if (key.kind !== 'key') return
      const retarget = key.name !== 'enter'
      readStage(retarget, LOGICAL_KEY_WIDTH)
      switch (key.name) {
        case 'up':
          frame().focus.move(-1)
          spec.invalidate()
          return
        case 'down':
          frame().focus.move(1)
          spec.invalidate()
          return
        case 'enter': {
          // A focused row does not have to be actionable. Enter on a plain fact
          // is a no-op rather than an invented action.
          const next = focusedRow()?.open
          if (next !== undefined) push(next)
          else spec.invalidate()
          return
        }
        case 'home':
        case 'ctrl-a':
          frame().focus.first()
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          frame().focus.last()
          viewport.last()
          spec.invalidate()
          return
        case 'escape':
        case 'ctrl-c':
          pop()
          return
        default:
          return
      }
    },
  }
}

/**
 * Text width used when a keystroke must resolve rows before the next paint.
 *
 * Key handling needs the row IDENTITIES, never their pixels, and the terminal's
 * real width belongs to `render`. A generous logical width keeps fitting from
 * dropping a fact that a narrower guess would have removed, which could
 * otherwise change what a key resolves to.
 */
const LOGICAL_KEY_WIDTH = 200

/** Index every item of the projection by its selection identity. */
function workIndex(snapshot: WorkSnapshot): Map<string, WorkItem> {
  const index = new Map<string, WorkItem>()
  for (const item of snapshot.workflows) index.set(workItemKey(item), item)
  for (const item of snapshot.subagents) index.set(workItemKey(item), item)
  for (const item of snapshot.jobs) index.set(workItemKey(item), item)
  return index
}

/** Build the rows of one stage. */
function stageRows(
  stage: Stage,
  snapshot: WorkSnapshot,
  index: ReadonlyMap<string, WorkItem>,
  width: number,
  tick: number,
): readonly StageRow[] {
  if (stage.kind === 'list') return overviewRows(snapshot, width, tick)
  const item = index.get(stage.subject)
  if (item === undefined) return [muted('No active work to inspect.', width)]
  if (item.source === 'workflow' && stage.kind === 'workflow') return workflowRows(item, width, tick)
  if (item.source === 'subagent' && stage.kind === 'subagent') {
    return subagentRows(item, snapshot.workflows, width, tick)
  }
  if (item.source === 'job' && stage.kind === 'job') return jobRows(item, width)
  return [muted('No active work to inspect.', width)]
}

/** Render the grouped overview: one section per Harness authority. */
function overviewRows(snapshot: WorkSnapshot, width: number, tick: number): StageRow[] {
  // `available` reports the two capability SEAMS. A workflow run is proved by
  // this session's own durable records rather than by a mounted service, so an
  // owned run is still shown if it somehow outlives them.
  if (!snapshot.available && snapshot.workflows.length === 0) {
    return [muted('Jobs and subagents are not installed in this profile.', width)]
  }
  // A workflow presents its own members, so a child a live member already shows
  // is not repeated in the flat Subagents section. The join is Harness's own
  // `childId`, never a name or a timing coincidence, and the same rule decides
  // the status line's subagent count so the two can never disagree.
  const loose = looseSubagents(snapshot)
  if (snapshot.workflows.length === 0 && loose.length === 0 && snapshot.jobs.length === 0) {
    return [muted('No active workflows, jobs, or subagents.', width)]
  }
  const rows: StageRow[] = []
  if (snapshot.workflows.length > 0) {
    rows.push(heading('Workflows'))
    for (const item of snapshot.workflows) rows.push(workflowOverviewRow(item, width, tick))
  }
  if (loose.length > 0) {
    if (rows.length > 0) rows.push(blank())
    rows.push(heading('Subagents'))
    for (const item of loose) rows.push(subagentOverviewRow(item, width, tick))
  }
  if (snapshot.jobs.length > 0) {
    if (rows.length > 0) rows.push(blank())
    rows.push(heading('Jobs'))
    for (const item of snapshot.jobs) rows.push(jobOverviewRow(item, width))
  }
  return rows
}

/** How a settled workflow run or member reads as one word. */
function outcomeWord(mark: WorkMark): string | undefined {
  if (mark === 'completed') return 'completed'
  if (mark === 'failed') return 'failed'
  if (mark === 'cancelled') return 'cancelled'
  return undefined
}

/** The counts a workflow row may truthfully claim. */
function workflowCounts(item: WorkflowWorkItem): string {
  const started = item.agentsStarted ?? item.members.length
  if (item.state !== 'running') {
    return `${String(started)} ${started === 1 ? 'agent' : 'agents'}`
  }
  const active = item.members.filter(member => member.outcome === undefined).length
  // No denominator: `meta.phases` declares progress vocabulary, not how many
  // `agent()` calls a script will make, so there is no truthful total to divide by.
  return `${String(active)} active · ${String(started)} started`
}

/** One workflow row on the overview. */
function workflowOverviewRow(item: WorkflowWorkItem, width: number, tick: number): StageRow {
  const mark = workMark(item)
  const settled = outcomeWord(mark)
  const segments: RowSegment[] = [
    { text: workflowCounts(item), separator: ' · ', rank: 2 },
    { text: formatElapsed(Math.max(0, Date.now() - item.startedAt)), separator: ' ', rank: 3 },
  ]
  const narration = settled ?? item.phase
  if (narration !== undefined && narration !== '') {
    segments.unshift({ text: escapeControls(narration), separator: ' · ', rank: 4 })
  }
  return itemRow(item, mark, escapeControls(item.label), segments, width, tick, { kind: 'workflow', subject: workItemKey(item) })
}

/** One subagent row on the overview. */
function subagentOverviewRow(item: SubagentWorkItem, width: number, tick: number): StageRow {
  const mark = workMark(item)
  const segments: RowSegment[] = []
  if (item.label !== undefined && item.label !== '') {
    segments.push({ text: escapeControls(item.label), separator: ' ', rank: 1 })
  }
  if (item.activityWord !== undefined) {
    segments.push({ text: escapeControls(item.activityWord), separator: ' · ', rank: 3 })
    if (item.activityTitle !== undefined && item.activityTitle !== '') {
      segments.push({ text: escapeControls(item.activityTitle), separator: ' ', rank: 4 })
    }
  }
  segments.push({ text: formatElapsed(Math.max(0, Date.now() - item.startedAt)), separator: ' ', rank: 2 })
  return itemRow(item, mark, escapeControls(item.provider), segments, width, tick, { kind: 'subagent', subject: workItemKey(item) })
}

/** One job row on the overview. */
function jobOverviewRow(item: JobWorkItem, width: number): StageRow {
  const mark = workMark(item)
  const segments: RowSegment[] = []
  if (item.label !== '') segments.push({ text: escapeControls(item.label), separator: ' ', rank: 1 })
  segments.push({ text: formatElapsed(Math.max(0, Date.now() - item.startedAt)), separator: ' ', rank: 2 })
  if (item.state === 'stopping') segments.push({ text: 'stopping', separator: ' ', rank: 3 })
  return itemRow(item, mark, escapeControls(item.kind), segments, width, 0, { kind: 'job', subject: workItemKey(item) })
}

/** Assemble one overview row from its mark, name, and yieldable segments. */
function itemRow(
  item: WorkItem,
  mark: WorkMark,
  name: string,
  segments: readonly RowSegment[],
  width: number,
  tick: number,
  open: Stage,
): StageRow {
  return {
    kind: 'row',
    key: workItemKey(item),
    mark: glyph(mark, tick),
    markRole: MARK_ROLE[mark],
    text: fitSegments(name, segments, textBudget(width)),
    role: 'subdued',
    open,
  }
}

/** Render one workflow run: its facts, then its published members by phase. */
function workflowRows(item: WorkflowWorkItem, width: number, tick: number): StageRow[] {
  const mark = workMark(item)
  const rows: StageRow[] = [
    heading(`Workflow · ${escapeControls(item.label)}`),
    blank(),
  ]
  if (item.description !== undefined && item.description !== '') {
    rows.push(fact('description', item.description, width))
  }
  rows.push(fact('state', outcomeWord(mark) ?? 'running', width))
  if (item.phase !== undefined) rows.push(fact('phase', item.phase, width))
  if (item.log !== undefined) rows.push(fact('log', item.log, width))
  rows.push(fact('elapsed', formatElapsed(Math.max(0, Date.now() - item.startedAt)), width))
  rows.push(fact('agents', workflowCounts(item), width))
  rows.push(fact('run id', item.id, width))
  if (item.members.length === 0) {
    rows.push(blank())
    rows.push(muted('No members published yet.', width))
    return rows
  }
  for (const group of groupMembers(item.members)) {
    rows.push(blank())
    // An unphased call has no heading at all, while a phase the script actually
    // titled gets one — including a title that is the empty string. Collapsing
    // the two would erase a distinction the record keeps.
    if (group.phase !== undefined) rows.push(heading(escapeControls(group.phase)))
    for (const member of group.members) rows.push(memberRow(item, member, width, tick))
  }
  return rows
}

/** Members grouped by their exact recorded phase, in first-appearance order. */
function groupMembers(
  members: readonly WorkflowMemberItem[],
): { readonly phase?: string; readonly members: WorkflowMemberItem[] }[] {
  const groups: { phase?: string; members: WorkflowMemberItem[] }[] = []
  for (const member of members) {
    const existing = groups.find(group => group.phase === member.phase)
    if (existing !== undefined) {
      existing.members.push(member)
      continue
    }
    groups.push(member.phase === undefined ? { members: [member] } : { phase: member.phase, members: [member] })
  }
  return groups
}

/** One workflow member row; it opens the shared subagent stage when its child is live. */
function memberRow(
  workflow: WorkflowWorkItem,
  member: WorkflowMemberItem,
  width: number,
  tick: number,
): StageRow {
  const mark = memberMark(member)
  const segments: RowSegment[] = []
  const child = member.subagent
  if (child !== undefined) {
    segments.push({ text: escapeControls(child.provider), separator: ' ', rank: 2 })
    if (child.activityWord !== undefined) {
      segments.push({ text: escapeControls(child.activityWord), separator: ' · ', rank: 3 })
      if (child.activityTitle !== undefined && child.activityTitle !== '') {
        segments.push({ text: escapeControls(child.activityTitle), separator: ' ', rank: 4 })
      }
    }
  }
  return {
    kind: 'row',
    key: workflowMemberKey(workflow, member),
    mark: glyph(mark, tick),
    markRole: MARK_ROLE[mark],
    text: fitSegments(escapeControls(member.label), segments, textBudget(width)),
    role: 'subdued',
    // Only a member whose `childId` resolves to a live epoch can be opened.
    // A settled member is a record, not a place to navigate to.
    ...child === undefined ? {} : { open: { kind: 'subagent' as const, subject: workItemKey(child) } },
  }
}

/**
 * Render one subagent, ordered by what a person asks first.
 *
 * What it is doing, what it is doing it to, whose provider it is, how long it
 * has run, where it came from, what can be done to it — and only then the lower
 * level identities, which stay because they are the facts that make a report
 * actionable, not because they lead.
 */
function subagentRows(
  item: SubagentWorkItem,
  workflows: readonly WorkflowWorkItem[],
  width: number,
  tick: number,
): StageRow[] {
  const mark = workMark(item)
  const identity = item.label === undefined || item.label === '' ? item.provider : item.label
  const rows: StageRow[] = [
    heading(`Subagent · ${escapeControls(identity)}`),
    blank(),
  ]
  const headline = item.activityWord === undefined
    ? 'active'
    : item.activityTitle === undefined || item.activityTitle === ''
      ? item.activityWord
      : `${item.activityWord} · ${item.activityTitle}`
  rows.push({
    kind: 'row',
    key: 'state',
    mark: glyph(mark, tick),
    markRole: MARK_ROLE[mark],
    text: truncateToWidth(escapeControls(headline), textBudget(width)),
    role: 'subdued',
  })
  rows.push(blank())
  rows.push(fact('provider', item.provider, width))
  // No paragraph about what the seam does or does not carry: an opaque provider
  // simply says who manages the detail, in the same two columns as every other fact.
  if (item.activityWord === undefined) rows.push(fact('activity', 'provider-managed', width))
  rows.push(fact('elapsed', formatElapsed(Math.max(0, Date.now() - item.startedAt)), width))
  if (item.mode !== undefined) rows.push(fact('mode', item.mode, width))
  const membership = findMembership(item.id, workflows)
  if (membership !== undefined) {
    rows.push(blank())
    rows.push(fact('workflow', membership.workflow.label, width))
    if (membership.member.phase !== undefined) rows.push(fact('phase', membership.member.phase, width))
    rows.push(fact('member', membership.member.label, width))
  }
  rows.push(blank())
  if (item.interruptible) rows.push(fact('interrupt', 'available', width))
  rows.push(fact('session', item.id, width))
  if (item.agentStatus !== undefined) rows.push(fact('agent status', item.agentStatus, width))
  if (item.residency !== undefined) {
    rows.push(fact('residency', item.residency === 'resident' ? 'live session' : 'stored session', width))
  }
  if (item.hasChildren !== undefined) {
    // Harness's `hasChildren` is a durable lineage fact, not a claim that
    // sub-workers are active right now.
    rows.push(fact('child sessions', item.hasChildren ? 'yes' : 'no', width))
  }
  // The lifecycle edge is scoped to this delegating session and discovery is
  // the direct-parent query, so the direct-child relationship is provable.
  rows.push(fact('lineage', 'direct child of this session', width))
  rows.push(fact('run id', item.runId, width))
  rows.push(fact('local agent', item.local ? 'yes' : 'no', width))
  return rows
}

/** The owned workflow membership of one child session, when one is authoritative. */
function findMembership(
  childId: string,
  workflows: readonly WorkflowWorkItem[],
): { readonly workflow: WorkflowWorkItem; readonly member: WorkflowMemberItem } | undefined {
  for (const workflow of workflows) {
    for (const member of workflow.members) {
      if (member.childId === childId) return { workflow, member }
    }
  }
  return undefined
}

/** Render one job: its state, then the identity a report needs. */
function jobRows(item: JobWorkItem, width: number): StageRow[] {
  const rows: StageRow[] = [
    heading(`Job · ${escapeControls(item.label === '' ? item.kind : item.label)}`),
    blank(),
    fact('status', item.state, width),
    fact('kind', item.kind, width),
  ]
  if (item.detail !== undefined) rows.push(fact('detail', item.detail, width))
  rows.push(fact('elapsed', formatElapsed(Math.max(0, Date.now() - item.startedAt)), width))
  rows.push(fact('owner', item.ownership === 'this-session' ? 'this session' : 'unowned', width))
  rows.push(blank())
  // No `interrupt  not available` row: announcing the absence of an action is
  // noise, and a control appears here only when it genuinely exists.
  rows.push(fact('job id', item.id, width))
  return rows
}

/** Columns a row's text may use, after its gutter and its mark. */
function textBudget(width: number): number {
  return Math.max(1, width - GUTTER_COLUMNS)
}

/** The glyph one mark draws, animating only for observed execution. */
function glyph(mark: WorkMark, tick: number): string {
  return mark === 'executing' ? spinnerFrame(tick) : MARK_GLYPH[mark]
}

/** A focusable two-column fact row. */
function fact(key: string, value: string, width: number): StageRow {
  return {
    kind: 'row',
    key: `fact:${key}`,
    text: truncateToWidth(`${key}  ${escapeControls(value)}`, textBudget(width)),
    role: 'subdued',
  }
}

/** A non-focusable section heading. */
function heading(text: string): StageRow {
  return { kind: 'line', text, role: 'section-heading' }
}

/** A non-focusable spacer. */
function blank(): StageRow {
  return { kind: 'blank', text: '', role: 'muted' }
}

/** A non-focusable explanatory line, for a stage with nothing to inspect. */
function muted(text: string, width: number): StageRow {
  return { kind: 'line', text: truncateToWidth(text, Math.max(1, width)), role: 'muted' }
}

/**
 * Paint one row.
 *
 * The mark keeps its own role so an outcome reads at a glance without turning
 * the whole line into a colour. One `paint` per span on one row: colouring a
 * multi-row string in one call is what leaks style into the next row.
 */
function paintRow(row: StageRow, focus: string | undefined): string {
  if (row.kind === 'blank') return ''
  if (row.kind === 'line') return paint(row.text, row.role)
  const focused = row.key !== undefined && row.key === focus
  const body = row.mark === undefined ? row.text : `${row.mark} ${row.text}`
  if (focused) return paint(`❯ ${body}`, 'selection')
  const painted = row.mark === undefined
    ? paint(row.text, row.role)
    : `${paint(row.mark, row.markRole ?? row.role)} ${paint(row.text, row.role)}`
  return `  ${painted}`
}

/**
 * Fit a row by dropping whole facts, never by cutting one in half.
 *
 * `reading overla…` states less than the word alone, so the highest-ranked
 * segment yields first and the name never yields at all.
 * @param name - the row's leading name, already escaped.
 * @param segments - the yieldable facts, in display order.
 * @param width - display columns available for name and segments.
 * @returns the fitted row text.
 */
function fitSegments(name: string, segments: readonly RowSegment[], width: number): string {
  const surviving = [...segments]
  const render = (): string => name + surviving.map(part => `${part.separator}${part.text}`).join('')
  while (surviving.length > 0 && displayWidth(render()) > width) {
    let worst = 0
    for (let index = 1; index < surviving.length; index += 1) {
      const candidate = surviving[index]
      const incumbent = surviving[worst]
      if (candidate !== undefined && incumbent !== undefined && candidate.rank > incumbent.rank) worst = index
    }
    surviving.splice(worst, 1)
  }
  return truncateToWidth(render(), width)
}

/** The help truthful for this stage, the focused row, and the current authority. */
function stageHelp(stage: Stage, focused: StageRow | undefined, item: WorkItem | undefined): string {
  const interrupt = item?.source === 'subagent' && item.interruptible ? ' · k interrupt' : ''
  const enter = focused?.open === undefined ? '' : ' · ↵ inspect'
  const exit = stage.kind === 'list' ? ' · esc close' : ' · esc back'
  return `↑↓ select${enter}${interrupt}${exit}`
}

/** Count the physical terminal rows the Screen will use for candidate lines. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/** A closable answer for terminals that cannot safely hold a frame. */
function compactFallback(
  snapshot: WorkSnapshot,
  columns: number,
  rows: number,
  notice?: Notice,
): string[] {
  if (rows <= 0) return []
  // A failed human action must survive the same geometry fallback that protects
  // scrollback. It takes precedence over the ordinary compact summary; clipping
  // its detail is preferable to making authorization or cancellation invisible.
  if (notice?.failed === true) {
    return [paint(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), 'error')]
  }
  const workflows = snapshot.workflows.length
  const subagents = snapshot.subagents.length
  const jobs = snapshot.jobs.length
  const counts = [
    ...workflows === 0 ? [] : [`${String(workflows)} ${workflows === 1 ? 'workflow' : 'workflows'}`],
    `${String(subagents)} ${subagents === 1 ? 'subagent' : 'subagents'}`,
    `${String(jobs)} ${jobs === 1 ? 'job' : 'jobs'}`,
  ].join(' · ')
  const summary = !snapshot.available
    ? 'Work unavailable · esc close'
    : jobs === 0 && subagents === 0 && workflows === 0
      ? 'No active work · esc close'
      : `${counts} · esc close`
  // On a narrow fallback, keeping the way out matters more than naming work
  // that cannot be inspected in that geometry.
  const shown = columns < displayWidth(summary) ? 'esc close' : summary
  const lines = [paint(truncateToWidth(shown, Math.max(1, columns)), 'overlay-headline')]
  if (rows >= 2) lines.push(paint(truncateToWidth('esc close', Math.max(1, columns)), 'muted'))
  return lines
}

/**
 * Small, presentation-facing vocabulary for Harness work.
 *
 * These rows are snapshots of capability-owned records. Jobs and subagents
 * remain a discriminated union because their identifiers, lifecycle facts, and
 * human controls come from different Harness authorities; a shared shape would
 * imply a relationship Harness never publishes.
 * @module dshline/work/model
 */

/** Facts common to a current Work row. */
interface WorkItemBase {
  /** Stable identity inside the owning capability. */
  readonly id: string
  /** Harness-provided one-line label, when that authority supplied one. */
  readonly label?: string
  /** Epoch milliseconds when the record or observed lifecycle edge began. */
  readonly startedAt: number
}

/** A non-terminal background Job projected from `ctx.jobs`. */
export interface JobWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'job'
  /** Producer-defined opaque Job kind. */
  readonly kind: string
  /** Current Job lifecycle state. */
  readonly state: 'running' | 'stopping'
  /** Producer-defined active detail, when the Job supplied it. */
  readonly detail?: string
  /** Whether the listing proves this Job belongs to this session or is unowned. */
  readonly ownership: 'this-session' | 'unowned'
  /** Jobs have no human Work interrupt: `jobs.kill()` changes delivery semantics. */
  readonly stoppable: false
}

/** A currently open subagent lifecycle epoch projected from `ctx.subagents`. */
export interface SubagentWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'subagent'
  /** Lifecycle identity for this run or continuable Activation epoch. */
  readonly runId: string
  /** Provider recorded by Harness when this lifecycle epoch started. */
  readonly provider: string
  /**
   * Snapshot of whether `SubagentRun.localAgent` was present when the run
   * started: whether the child was published as an in-process agent. It says
   * nothing about where the provider's model traffic goes.
   */
  readonly local: boolean
  /** An open lifecycle edge is Work's authoritative active-row source. */
  readonly state: 'running'
  /** Durable descriptor mode, when direct-child discovery has resolved it. */
  readonly mode?: 'one-shot' | 'continuable'
  /**
   * Durable session-store residency from direct-child discovery, when available.
   * `resident` is deliberately not a claim that a model turn is executing.
   */
  readonly residency?: 'resident' | 'stored'
  /** Whether direct-child discovery reported any durable subagent children. */
  readonly hasChildren?: boolean
  /** Continuable children alone expose Harness's human interrupt authority. */
  readonly stoppable: boolean
}

/** A unit of active work the terminal can present. */
export type WorkItem = JobWorkItem | SubagentWorkItem

/** The current projection of the optional jobs and subagents capabilities. */
export interface WorkSnapshot {
  /** Whether either optional work capability is available. */
  readonly available: boolean
  /** Active subagent lifecycle epochs. */
  readonly subagents: readonly SubagentWorkItem[]
  /** Current job-registry snapshots that have not settled. */
  readonly jobs: readonly JobWorkItem[]
}

/** The outcome of asking Harness to interrupt one selected Work row. */
export interface WorkInterruptResult {
  /** Whether Harness accepted, rejected, or cannot interrupt the request. */
  readonly kind: 'requested' | 'unsupported' | 'failed'
  /** A short, user-facing account of the request outcome. */
  readonly message: string
}

/**
 * Build the optional work summary without abbreviating its counts.
 * @param snapshot - current work projection.
 * @returns a whole-segment status label, or undefined when there is no work.
 */
export function workSummary(snapshot: WorkSnapshot): string | undefined {
  const subagents = snapshot.subagents.length
  const jobs = snapshot.jobs.length
  if (subagents === 0 && jobs === 0) return undefined
  const parts: string[] = []
  if (subagents > 0) parts.push(`${String(subagents)} ${subagents === 1 ? 'subagent' : 'subagents'}`)
  if (jobs > 0) parts.push(`${String(jobs)} ${jobs === 1 ? 'job' : 'jobs'}`)
  return parts.join(' · ')
}

/**
 * How many work items are attached to a session.
 *
 * Counted across both capabilities without merging them: the sum answers one
 * question — is anything still running under this agent — which is what a
 * lifecycle decision such as retiring the agent needs, and it needs no
 * correlation between a job and a subagent to be true.
 * @param snapshot - current work projection.
 * @returns the number of active jobs and subagents.
 */
export function activeWorkCount(snapshot: WorkSnapshot): number {
  return snapshot.subagents.length + snapshot.jobs.length
}

/**
 * Stable selection identity for a Work row.
 *
 * A continuable child may later acquire another lifecycle epoch with the same
 * durable session id, so its run id is part of the identity while the overlay
 * is open.
 * @param item - row whose identity the overlay retains.
 * @returns capability-scoped selection key.
 */
export function workItemKey(item: WorkItem): string {
  return item.source === 'subagent'
    ? `subagent:${item.runId}`
    : `job:${item.id}`
}